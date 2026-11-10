// バックグラウンド（Service Worker）。
// 翻訳リクエストを設定中のエンジン（ブラウザ内 / Ollama / llama-server などの OpenAI 互換サーバー）に
// 振り分け、同時実行数を制限する。コンテキストメニューとショートカットもここで扱う。

import { buildPrompt, maxTokensFor, parseGlossary, resolveTarget, splitText } from "./lib/pfml.js";
import { getSettings } from "./lib/settings.js";

// ---- 準備 ----

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "translate-selection", title: "PLaMo で「%s」を翻訳", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "translate-page", title: "PLaMo でこのページを翻訳 / 元に戻す", contexts: ["page"] });
  });
  await setupOriginRule();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(setupOriginRule);

/**
 * Ollama は既定で chrome-extension:// からのリクエストを 403 で拒否する。拡張から localhost /
 * 127.0.0.1 へのリクエストに限り Origin ヘッダーを外して通す（OLLAMA_ORIGINS の設定を不要にする）。
 */
async function setupOriginRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
        condition: {
          requestDomains: ["localhost", "127.0.0.1"],
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ["xmlhttprequest", "other"],
        },
      },
    ],
  });
}

// ---- ブラウザ内エンジン（オフスクリーンドキュメント） ----

let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: "engine.html",
      reasons: ["WORKERS"],
      justification: "wllama（WebAssembly / WebGPU）で翻訳モデルを動かすため",
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function engine(msg) {
  await ensureOffscreen();
  // 作成直後はモジュールの読み込みが終わるまで応答しないので、ping が返るまで待つ。
  for (let i = 0; i < 50; i++) {
    const pong = await chrome.runtime.sendMessage({ to: "engine", type: "ping" }).catch(() => null);
    if (pong?.ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return chrome.runtime.sendMessage({ to: "engine", ...msg });
}

// ---- 推論 ----

/** 同時実行数の制限。 */
const queue = [];
let running = 0;

async function withSlot(limit, signal, fn) {
  if (running >= limit) {
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      queue.push(entry);
      signal?.addEventListener("abort", () => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        reject(new DOMException("cancelled", "AbortError"));
      });
    });
  }
  running++;
  try {
    if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
    return await fn();
  } finally {
    running--;
    queue.shift()?.resolve();
  }
}

function joinUrl(base, path) {
  return base.replace(/\/+$/, "") + path;
}

/** PFML3 プロンプトを推論し、訳文を返す。 */
async function complete(prompt, maxTokens, settings, signal) {
  return withSlot(Math.max(1, Number(settings.concurrency) || 4), signal, async () => {
    switch (settings.engine) {
      case "ollama":
        return completeOllama(prompt, maxTokens, settings, signal);
      case "openai":
        return completeOpenAI(prompt, maxTokens, settings, signal);
      default:
        return completeBrowser(prompt, maxTokens, settings, signal);
    }
  });
}

async function completeBrowser(prompt, maxTokens, settings, signal) {
  const id = crypto.randomUUID();
  const onAbort = () => engine({ type: "abort", ids: [id] }).catch(() => {});
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await engine({ type: "complete", id, prompt, maxTokens, model: settings.browserModel, device: settings.device });
    if (!res?.ok) {
      if (res?.aborted) throw new DOMException("cancelled", "AbortError");
      throw new Error(res?.error ?? "ブラウザ内エンジンが応答しません");
    }
    return res.text;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function postJson(url, body, signal) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error(`${url} に接続できません。サーバーが起動しているか確認してください。`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const detail = data?.error?.message ?? data?.error ?? text.slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return data;
}

async function completeOllama(prompt, maxTokens, settings, signal) {
  // /v1/completions ではチャットテンプレートが適用されるため、raw モードの /api/generate を使う。
  const data = await postJson(
    joinUrl(settings.ollamaUrl, "/api/generate"),
    {
      model: settings.ollamaModel,
      prompt,
      raw: true,
      stream: false,
      keep_alive: "30m",
      options: { temperature: 0, num_predict: maxTokens, num_ctx: 8192, stop: ["<|plamo:tag|>", "<|plamo:bos|>"] },
    },
    signal,
  ).catch((e) => {
    if (/not found/i.test(e.message)) {
      throw new Error(`Ollama にモデルがありません。ターミナルで「ollama pull ${settings.ollamaModel}」を実行してください。`);
    }
    throw e;
  });
  return data.response ?? "";
}

async function completeOpenAI(prompt, maxTokens, settings, signal) {
  const data = await postJson(
    joinUrl(settings.openaiUrl, "/v1/completions"),
    {
      model: settings.openaiModel,
      prompt,
      temperature: 0,
      max_tokens: maxTokens,
      stop: ["<|plamo:tag|>", "<|plamo:bos|>"],
      // vLLM で BOS を付けるため（llama.cpp は自動で付ける）。
      add_special_tokens: true,
    },
    signal,
  );
  return data.choices?.[0]?.text ?? "";
}

// ---- 翻訳 ----

/** 同じ原文を何度も翻訳しないためのキャッシュ（ページの再翻訳など）。 */
const cache = new Map();
const CACHE_MAX = 3000;

function cacheKey(settings, text, target) {
  const engineId =
    settings.engine === "ollama" ? `o:${settings.ollamaModel}` : settings.engine === "openai" ? `s:${settings.openaiModel}` : `b:${settings.browserModel}`;
  return [engineId, target, settings.form, settings.glossary, settings.context, text].join("\u0001");
}

/**
 * テキストを翻訳する。長いテキストは段落ごとに分け、直前の対訳を履歴として渡して訳語をそろえる。
 * @returns {Promise<{text: string, target: string}>}
 */
async function translate({ text, target, signal }) {
  const settings = await getSettings();
  const to = resolveTarget(target ?? settings.targetLang, text);
  const key = cacheKey(settings, text, to);
  if (cache.has(key)) return { text: cache.get(key), target: to };

  const common = {
    target: to,
    form: to === "ja" ? settings.form || undefined : undefined,
    context: settings.context,
    glossary: parseGlossary(settings.glossary),
  };
  const chunks = splitText(text, settings.engine === "browser" ? 400 : 1200);
  const history = [];
  let out = "";
  // 原文の先頭・末尾の空白はそのまま残す。
  const lead = text.match(/^\s*/)[0];
  for (const chunk of chunks) {
    const body = chunk.text.trim();
    if (!body) {
      out += chunk.text + chunk.sep;
      continue;
    }
    const prompt = buildPrompt({ ...common, text: body, history: history.slice(-3) });
    const translated = (await complete(prompt, maxTokensFor(body), settings, signal)).replaceAll("<\u200b|", "<|").trim();
    history.push({ source: body, translation: translated });
    out += translated + chunk.sep;
  }
  out = lead + out.trimEnd();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return { text: out, target: to };
}

/** タブごとの実行中リクエスト（ページ翻訳の中止用）。 */
const tabJobs = new Map();

function trackJob(tabId) {
  const controller = new AbortController();
  if (tabId == null) return { controller, done: () => {} };
  if (!tabJobs.has(tabId)) tabJobs.set(tabId, new Set());
  tabJobs.get(tabId).add(controller);
  return { controller, done: () => tabJobs.get(tabId)?.delete(controller) };
}

function cancelTab(tabId) {
  for (const c of tabJobs.get(tabId) ?? []) c.abort();
  tabJobs.delete(tabId);
}

chrome.tabs.onRemoved.addListener(cancelTab);

// ---- 接続テスト ----

async function testConnection() {
  const settings = await getSettings();
  const started = performance.now();
  const prompt = buildPrompt({ text: "The meeting has been rescheduled to next Monday.", target: "ja" });
  const text = await complete(prompt, 64, settings, AbortSignal.timeout(180_000));
  return { text: text.trim(), ms: Math.round(performance.now() - started) };
}

// ---- メッセージ ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.to === "engine" || msg.to === "all") return false;
  const reply = (p) =>
    p.then(
      (v) => sendResponse({ ok: true, ...v }),
      (e) => sendResponse({ ok: false, aborted: e?.name === "AbortError", error: String(e?.message ?? e) }),
    );
  switch (msg.type) {
    case "translate": {
      const { controller, done } = trackJob(sender.tab?.id);
      reply(translate({ text: msg.text, target: msg.target, signal: controller.signal }).finally(done));
      return true;
    }
    case "cancel-tab":
      cancelTab(sender.tab?.id ?? msg.tabId);
      sendResponse({ ok: true });
      return false;
    case "engine":
      reply(engine(msg.payload).then((r) => r ?? {}));
      return true;
    case "test":
      reply(testConnection());
      return true;
    case "toggle-page":
      reply(togglePage(msg.tabId).then(() => ({})));
      return true;
    case "clear-cache":
      cache.clear();
      sendResponse({ ok: true });
      return false;
  }
  return false;
});

// ---- ページへの注入 ----

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function togglePage(tabId) {
  await inject(tabId);
  const settings = await getSettings();
  await chrome.tabs.sendMessage(tabId, { type: "page-toggle", target: settings.targetLang, mode: settings.pageMode });
}

async function showSelection(tabId, text) {
  await inject(tabId);
  const settings = await getSettings();
  await chrome.tabs.sendMessage(tabId, { type: "selection", text, target: settings.targetLang });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === "translate-selection") await showSelection(tab.id, info.selectionText ?? null);
    if (info.menuItemId === "translate-page") await togglePage(tab.id);
  } catch (e) {
    console.warn("このページでは実行できません:", e);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab ??= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) return;
  try {
    if (command === "translate-page") await togglePage(tab.id);
    if (command === "translate-selection") await showSelection(tab.id, null);
  } catch (e) {
    console.warn("このページでは実行できません:", e);
  }
});
