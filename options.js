import { fillLangSelect } from "./lib/langs.js";
import { MODELS } from "./lib/models.js";
import { DEFAULTS, getSettings, saveSettings } from "./lib/settings.js";

const $ = (id) => document.getElementById(id);
const settings = await getSettings();

const engineCall = (payload) => chrome.runtime.sendMessage({ type: "engine", payload });
const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;

// ---- 入力欄と設定の結び付け ----

fillLangSelect($("targetLang"), { auto: true });
for (const [key, m] of Object.entries(MODELS)) $("browserModel").add(new Option(m.label, key));

for (const key of Object.keys(DEFAULTS)) {
  const el = $(key);
  if (!el) continue;
  if (el.type === "checkbox") el.checked = settings[key];
  else el.value = settings[key];
  el.addEventListener("change", async () => {
    if (el.type === "checkbox") {
      settings[key] = el.checked;
      await saveSettings({ [key]: el.checked });
      return;
    }
    let value = el.value;
    if (el.type === "number") value = Math.min(16, Math.max(1, Number(value) || DEFAULTS[key]));
    if (el.type === "url") value = value.trim().replace(/\/+$/, "") || DEFAULTS[key];
    if (el.type === "url" || el.type === "text") value = String(value).trim() || DEFAULTS[key];
    el.value = value;
    settings[key] = value;
    if (el.type === "url") await ensureHostPermission(value);
    await saveSettings({ [key]: value });
    chrome.runtime.sendMessage({ type: "clear-cache" });
    if (key === "ollamaModel") updateOllamaHint();
    if (key === "browserModel") refreshEngine();
  });
}

/** localhost 以外のサーバーを指定したら、そのホストへのアクセス許可を求める。 */
async function ensureHostPermission(url) {
  try {
    const u = new URL(url);
    if (["localhost", "127.0.0.1"].includes(u.hostname)) return;
    await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch {}
}

for (const radio of document.querySelectorAll("input[name=engine]")) {
  radio.checked = radio.value === settings.engine;
  radio.addEventListener("change", async () => {
    settings.engine = radio.value;
    await saveSettings({ engine: radio.value });
    chrome.runtime.sendMessage({ type: "clear-cache" });
    showPanel();
  });
}

function showPanel() {
  for (const panel of document.querySelectorAll(".panel")) panel.hidden = panel.dataset.engine !== settings.engine;
  $("test-result").textContent = "";
  if (settings.engine === "browser") refreshEngine();
}

function updateOllamaHint() {
  $("ollama-pull").textContent = `ollama pull ${settings.ollamaModel}`;
}

$("shortcuts").onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
};

// ---- ブラウザ内エンジンのモデル管理 ----

let status = null;
const progress = {};

async function refreshEngine() {
  status = await engineCall({ type: "status" });
  renderModels();
}

function renderModels() {
  const box = $("models");
  box.textContent = "";
  box.style.cssText = "display: grid; gap: 8px";
  if (!status?.ok) {
    box.textContent = status?.error ?? "エンジンの状態を取得できません";
    return;
  }
  for (const [key, m] of Object.entries(MODELS)) {
    const s = status.models[key];
    const p = progress[key];
    const row = document.createElement("div");
    row.className = "model";
    const title = document.createElement("div");
    title.innerHTML = `<b></b>`;
    title.querySelector("b").textContent = m.label;
    const meta = document.createElement("div");
    meta.className = "meta";
    const actions = document.createElement("div");
    actions.className = "actions";

    const downloading = s.downloading || p?.state === "running";
    if (s.downloaded) {
      meta.textContent = `ダウンロード済み（${gb(s.size)}）`;
      const del = button("削除", async () => {
        if (!confirm(`${m.label} を削除しますか？`)) return;
        await engineCall({ type: "delete", model: key });
        refreshEngine();
      });
      del.classList.add("danger");
      actions.append(del);
    } else if (downloading) {
      const received = p?.received ?? s.partial;
      const total = p?.total ?? s.bytes;
      meta.textContent = `ダウンロード中… ${gb(received)} / ${gb(total)}（${Math.floor((received / total) * 100)}%）`;
      actions.append(button("中止", () => engineCall({ type: "cancel-download", model: key })));
    } else {
      meta.textContent = s.partial
        ? `一部ダウンロード済み（${gb(s.partial)} / ${gb(s.bytes)}）`
        : `未ダウンロード（${gb(s.bytes)}）${key === "0.8b" ? " ・まずはこちらがおすすめ" : " ・高精度、メモリを多く使います"}`;
      if (p?.state === "error") meta.textContent += ` ・エラー：${p.message}`;
      const dl = button(s.partial ? "続きをダウンロード" : "ダウンロード", async () => {
        progress[key] = { state: "running", received: s.partial, total: s.bytes };
        renderModels();
        await engineCall({ type: "download", model: key });
      });
      dl.classList.add("primary");
      actions.append(dl);
    }
    row.append(title, actions, meta);
    if (downloading) {
      const bar = document.createElement("progress");
      bar.max = p?.total ?? s.bytes;
      bar.value = p?.received ?? s.partial;
      row.append(bar);
    }
    box.append(row);
  }

  const st = status.state ?? {};
  const info = [];
  info.push(status.webgpu ? "WebGPU：利用可能" : "WebGPU：利用不可（CPU で実行します）");
  if (st.state === "ready") info.push(`読み込み済み：${MODELS[st.model]?.label} ・${st.device}`);
  if (st.state === "loading") info.push(`読み込み中：${MODELS[st.model]?.label}`);
  if (st.state === "error") info.push(`エラー：${st.message}`);
  if (!status.isolated) info.push("警告：crossOriginIsolated ではないためマルチスレッドが無効です");
  $("engine-info").textContent = info.join(" ・");
}

function button(label, onclick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = onclick;
  return b;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "engine-event") return;
  if (msg.event === "download") {
    progress[msg.model] = msg;
    if (msg.state === "running" && status?.ok) renderModels();
    else refreshEngine();
  }
  if (msg.event === "state" && status?.ok) {
    status.state = msg.state;
    renderModels();
  }
});

// ---- 接続テスト ----

$("test").onclick = async () => {
  $("test").disabled = true;
  $("test-result").className = "muted";
  $("test-result").textContent =
    settings.engine === "browser" ? "テスト中…（初回はモデルの読み込みに時間がかかります）" : "テスト中…";
  const res = await chrome.runtime.sendMessage({ type: "test" });
  $("test-result").className = res?.ok ? "" : "error";
  $("test-result").textContent = res?.ok
    ? `成功（${(res.ms / 1000).toFixed(1)} 秒）：The meeting has been rescheduled to next Monday. → ${res.text}`
    : `失敗：${res?.error}`;
  $("test").disabled = false;
  if (settings.engine === "browser") refreshEngine();
};

updateOllamaHint();
showPanel();
