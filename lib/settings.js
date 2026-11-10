// 設定（chrome.storage.local）。

export const DEFAULTS = {
  /** browser: 拡張内で推論（wllama） / ollama: Ollama / openai: llama-server・vLLM など */
  engine: "browser",
  browserModel: "0.8b",
  /** auto / gpu (WebGPU) / cpu */
  device: "auto",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "hf.co/pfnet/plamo-3-translate-0.8b-GGUF:Q4_K_M",
  openaiUrl: "http://localhost:8000",
  openaiModel: "plamo-3-translate",
  /** 既定の翻訳先。auto は日⇄英の自動切り替え。 */
  targetLang: "auto",
  /** 日本語訳の文体：""（指定なし）/ polite / plain */
  form: "",
  /** ページ翻訳の表示：replace（置き換え）/ below（原文の下に訳文） */
  pageMode: "replace",
  /** 「原語 => 訳語」を 1 行ずつ */
  glossary: "",
  /** 参考文脈 */
  context: "",
  /** テキストを選択したときに「訳」ボタンを表示する */
  selectionButton: true,
  /** 同時に送る翻訳リクエスト数 */
  concurrency: 4,
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export function saveSettings(patch) {
  return chrome.storage.local.set(patch);
}
