// ブラウザ内推論エンジン（オフスクリーンドキュメント）。
// wllama（llama.cpp の WebAssembly 版、WebGPU 対応）で PLaMo 3 Translate の GGUF を動かす。
// モデルファイルは拡張の OPFS に保存する。
//
// wllama のビルドは tanakh/plamo-translate-desktop が PLaMo 3 対応のために
// ソースからビルドしたものを使っている（vendor/wllama/README.md 参照）。

import { Wllama } from "./vendor/wllama/wllama.js";
import { STOP } from "./lib/pfml.js";
import { MODELS } from "./lib/models.js";

const modelUrl = (m) => `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;

// 1 スロットあたりのコンテキスト長と並列スロット数。llama.cpp は複数リクエストの
// トークンをまとめてデコードできるので、ページ翻訳の段落を並行して処理できる。
const N_CTX = 4096;
const SLOTS = 4;
// 使われないまま経過したらモデルをメモリから解放する。
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

// llama.cpp の WebGPU バックエンドは powerPreference を指定せずにアダプタを要求するため、
// 統合 GPU が選ばれることがある。wllama のワーカーは Blob URL で作られるので、その先頭に
// 高性能 GPU を要求するコードを差し込む（plamo-translate-desktop と同じ手法）。
const GPU_PREFERENCE = `if (typeof GPU !== "undefined") {
  const request = GPU.prototype.requestAdapter;
  GPU.prototype.requestAdapter = function (options = {}) {
    return request.call(this, { ...options, powerPreference: options.powerPreference ?? "high-performance" });
  };
}
`;
const createObjectURL = URL.createObjectURL;
URL.createObjectURL = (obj) =>
  createObjectURL(obj instanceof Blob && /javascript/.test(obj.type) ? new Blob([GPU_PREFERENCE, obj], { type: obj.type }) : obj);

/** 読み込み中のモデル：{ key, device, wllama, gpu, calls } */
let loaded = null;
let loadChain = Promise.resolve();
let state = { state: "idle" };
let idleTimer = null;
const jobs = new Map(); // id -> AbortController
const downloads = new Map(); // key -> { controller, received, total }

const broadcast = (msg) => chrome.runtime.sendMessage({ to: "all", type: "engine-event", ...msg }).catch(() => {});

function setState(next) {
  state = next;
  broadcast({ event: "state", state });
}

// ---- 保存領域（OPFS） ----

async function modelsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("models", { create: true });
}

async function fileOf(key) {
  try {
    return await (await (await modelsDir()).getFileHandle(MODELS[key].file)).getFile();
  } catch {
    return null;
  }
}

async function partSize(key) {
  try {
    return (await (await (await modelsDir()).getFileHandle(MODELS[key].file + ".part")).getFile()).size;
  } catch {
    return 0;
  }
}

async function modelStatus() {
  const out = {};
  for (const [key, m] of Object.entries(MODELS)) {
    const file = await fileOf(key);
    const dl = downloads.get(key);
    out[key] = {
      label: m.label,
      bytes: m.bytes,
      downloaded: !!file,
      size: file?.size ?? 0,
      partial: dl ? dl.received : await partSize(key),
      downloading: !!dl,
    };
  }
  return out;
}

/** モデルを OPFS にダウンロードする。中断したら次回は続きから取得する。 */
async function download(key) {
  if (downloads.has(key)) return;
  const m = MODELS[key];
  const controller = new AbortController();
  const dl = { controller, received: 0, total: m.bytes };
  downloads.set(key, dl);
  const report = (extra) => broadcast({ event: "download", model: key, received: dl.received, total: dl.total, ...extra });
  let writable = null;
  try {
    const dir = await modelsDir();
    const part = await dir.getFileHandle(m.file + ".part", { create: true });
    let existing = (await part.getFile()).size;
    const res = await fetch(modelUrl(m), {
      headers: existing ? { Range: `bytes=${existing}-` } : {},
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const range = res.headers.get("content-range") ?? "";
    const resume = res.status === 206 && range.startsWith(`bytes ${existing}-`);
    if (res.status === 206 && !resume) {
      await res.body?.cancel();
      await dir.removeEntry(m.file + ".part");
      throw new Error("サーバーが想定外の範囲を返しました。もう一度お試しください。");
    }
    if (!resume) existing = 0;
    const total = resume ? Number(range.split("/")[1]) : Number(res.headers.get("content-length"));
    if (total > 0) dl.total = total;
    writable = await part.createWritable({ keepExistingData: resume });
    if (resume) await writable.seek(existing);
    dl.received = existing;
    report({ state: "running" });
    const reader = res.body.getReader();
    let reported = dl.received;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      dl.received += value.length;
      if (dl.received - reported > 4 << 20) {
        reported = dl.received;
        report({ state: "running" });
      }
    }
    await writable.close();
    writable = null;
    if (dl.received !== dl.total) throw new Error(`サイズが一致しません（${dl.received} / ${dl.total} バイト）`);
    await dir.removeEntry(m.file).catch(() => {});
    await part.move(dir, m.file);
    report({ state: "done" });
  } catch (e) {
    // 書き込んだ分は次回の再開用に残す（close しないと OPFS に反映されない）。
    await writable?.close().catch(() => {});
    report({ state: controller.signal.aborted ? "cancelled" : "error", message: String(e?.message ?? e) });
  } finally {
    downloads.delete(key);
  }
}

async function deleteModel(key) {
  await enqueue(async () => {
    if (loaded?.key === key) await unload();
  });
  const dir = await modelsDir();
  await dir.removeEntry(MODELS[key].file).catch(() => {});
  await dir.removeEntry(MODELS[key].file + ".part").catch(() => {});
}

// ---- 読み込み ----

function enqueue(step) {
  const next = loadChain.then(step);
  loadChain = next.catch(() => {});
  return next;
}

/** WebGPU が使えるか（環境によっては requestAdapter が解決しないため、時間を区切る）。 */
let webgpu = null;
function hasWebGPU() {
  webgpu ??= (async () => {
    try {
      if (!navigator.gpu) return false;
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
      return !!(await Promise.race([navigator.gpu.requestAdapter({ powerPreference: "high-performance" }), timeout]));
    } catch {
      return false;
    }
  })();
  return webgpu;
}

async function load(key, device) {
  if (loaded && loaded.key === key && loaded.requested === device) return;
  await unload();
  const file = await fileOf(key);
  if (!file) {
    setState({ state: "no_model", model: key });
    throw Object.assign(new Error("モデルがダウンロードされていません。設定画面からダウンロードしてください。"), { code: "no_model" });
  }
  let useGpu = device === "gpu" || (device === "auto" && (await hasWebGPU()));
  setState({ state: "loading", model: key, device: useGpu ? "WebGPU" : "CPU" });
  const lines = [];
  let collecting = true;
  const keep = (...a) => collecting && lines.push(a.join(" "));
  const tryLoad = async (gpu) => {
    const wllama = new Wllama(
      { default: "./vendor/wllama/wllama.wasm" },
      { logger: { debug: keep, log: keep, info: keep, warn: keep, error: (...a) => (keep(...a), console.error(...a)) } },
    );
    try {
      await wllama.loadModel([file], {
        n_ctx: N_CTX * SLOTS,
        n_parallel: SLOTS,
        kv_unified: false,
        // プロンプトキャッシュは WebAssembly の 4GB メモリを圧迫するので使わない。
        cache_ram_mib: 0,
        n_gpu_layers: gpu ? 999 : 0,
      });
      return wllama;
    } catch (e) {
      await wllama.exit().catch(() => {});
      throw e;
    }
  };
  let wllama;
  try {
    wllama = await tryLoad(useGpu);
  } catch (e) {
    if (!useGpu) throw e;
    console.warn("WebGPU での読み込みに失敗したため CPU で再試行します:", e);
    useGpu = false;
    wllama = await tryLoad(false);
  }
  collecting = false;
  // WebGPU が実際に使われたかは llama.cpp のログで判断する。
  const offloaded = lines.map((l) => /offloaded (\d+)\/\d+ layers to GPU/.exec(l)).find(Boolean);
  const gpuUsed = useGpu && !!offloaded && offloaded[1] !== "0";
  loaded = { key, requested: device, wllama, gpu: gpuUsed, calls: 0 };
  setState({ state: "ready", model: key, device: gpuUsed ? "WebGPU" : `CPU（${wllama.getNumThreads()} スレッド）` });
}

async function unload() {
  const cur = loaded;
  if (!cur) return;
  loaded = null;
  for (const c of jobs.values()) c.abort();
  const deadline = Date.now() + 5000;
  while (cur.calls > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await cur.wllama.exit().catch(() => {});
  setState({ state: "idle" });
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => enqueue(unload), IDLE_UNLOAD_MS);
}

const isCrash = (e) => /has crashed|\(ABORT\)|RuntimeError|unreachable|bad_alloc/.test(String(e?.message ?? e));

async function complete({ id, prompt, maxTokens, model, device }) {
  const controller = new AbortController();
  jobs.set(id, controller);
  try {
    await enqueue(() => load(model, device));
    touch();
    const inst = loaded;
    if (!inst) throw new Error("モデルが読み込まれていません");
    inst.calls++;
    try {
      const result = await inst.wllama.createCompletion({
        prompt,
        max_tokens: maxTokens,
        temperature: 0,
        stop: STOP,
        abortSignal: controller.signal,
      });
      const choice = result.choices?.[0];
      return { text: choice?.text ?? "", cut: choice?.finish_reason === "length" };
    } catch (e) {
      if (isCrash(e)) {
        console.error("wllama がクラッシュしました:", e);
        enqueue(async () => {
          if (loaded === inst) await unload();
          setState({ state: "error", message: String(e?.message ?? e) });
        });
      }
      throw e;
    } finally {
      inst.calls--;
    }
  } finally {
    jobs.delete(id);
  }
}

// ---- メッセージ ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.to !== "engine") return false;
  const reply = (p) =>
    p.then(
      (v) => sendResponse({ ok: true, ...v }),
      (e) =>
        sendResponse({
          ok: false,
          aborted: e?.name === "AbortError" || /abort/i.test(String(e?.name ?? "")),
          code: e?.code,
          error: String(e?.message ?? e),
        }),
    );
  switch (msg.type) {
    case "ping":
      sendResponse({ ok: true });
      return false;
    case "status":
      reply(
        (async () => ({
          models: await modelStatus(),
          state,
          webgpu: await hasWebGPU(),
          isolated: self.crossOriginIsolated,
        }))(),
      );
      return true;
    case "download":
      download(msg.model);
      sendResponse({ ok: true });
      return false;
    case "cancel-download":
      downloads.get(msg.model)?.controller.abort();
      sendResponse({ ok: true });
      return false;
    case "delete":
      reply(deleteModel(msg.model).then(() => ({})));
      return true;
    case "unload":
      reply(enqueue(unload).then(() => ({})));
      return true;
    case "complete":
      reply(complete(msg));
      return true;
    case "abort":
      for (const id of msg.ids ?? []) jobs.get(id)?.abort();
      sendResponse({ ok: true });
      return false;
  }
  return false;
});
