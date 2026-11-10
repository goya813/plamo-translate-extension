import { fillLangSelect } from "./lib/langs.js";
import { MODELS } from "./lib/models.js";
import { getSettings, saveSettings } from "./lib/settings.js";

const $ = (id) => document.getElementById(id);
const settings = await getSettings();

fillLangSelect($("target"), { auto: true, value: settings.targetLang });
$("target").onchange = () => saveSettings({ targetLang: $("target").value });
$("options").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

// 入力途中のテキストはポップアップを閉じても残す。
const draft = await chrome.storage.session.get("draft").catch(() => ({}));
$("input").value = draft.draft ?? "";
$("input").oninput = () => chrome.storage.session.set({ draft: $("input").value }).catch(() => {});
$("input").focus();

async function translate() {
  const text = $("input").value;
  if (!text.trim()) return;
  $("translate").disabled = true;
  $("output").className = "muted";
  $("output").textContent = "翻訳中…";
  const started = performance.now();
  const res = await chrome.runtime.sendMessage({ type: "translate", text, target: $("target").value });
  $("translate").disabled = false;
  if (res?.ok) {
    $("output").className = "";
    $("output").textContent = res.text;
    setStatus("ok", `${statusLabel()} ・${((performance.now() - started) / 1000).toFixed(1)} 秒`);
  } else {
    $("output").className = "error";
    $("output").textContent = res?.error ?? "翻訳に失敗しました";
  }
}

$("translate").onclick = translate;
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) translate();
});
$("copy").onclick = async () => {
  await navigator.clipboard.writeText($("output").textContent);
  $("copy").textContent = "コピーしました";
  setTimeout(() => ($("copy").textContent = "コピー"), 1200);
};

$("page").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({ type: "toggle-page", tabId: tab.id });
  if (res?.ok) window.close();
  else setStatus("err", "このページでは翻訳できません（chrome:// やストアのページなど）");
};

function statusLabel() {
  if (settings.engine === "ollama") return `Ollama（${settings.ollamaModel}）`;
  if (settings.engine === "openai") return `サーバー（${settings.openaiUrl}）`;
  return `ブラウザ内（${MODELS[settings.browserModel]?.label ?? settings.browserModel}）`;
}

function setStatus(kind, text) {
  $("status").querySelector(".dot").className = `dot ${kind}`;
  $("status-text").textContent = text;
}

if (settings.engine === "browser") {
  const res = await chrome.runtime.sendMessage({ type: "engine", payload: { type: "status" } });
  const model = res?.models?.[settings.browserModel];
  if (!model?.downloaded) {
    setStatus("warn", "モデル未ダウンロード：設定画面からダウンロードしてください");
  } else if (res.state?.state === "ready") {
    setStatus("ok", `${statusLabel()} ・${res.state.device}`);
  } else {
    setStatus("ok", `${statusLabel()} ・初回の翻訳時に読み込みます`);
  }
} else {
  setStatus("ok", statusLabel());
}
