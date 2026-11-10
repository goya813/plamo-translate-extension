// PLaMo 3 Translate のプロンプト形式（PFML3）の組み立てと、長文の分割。
// 形式はモデル同梱の chat_template.jinja に合わせている。BOS トークンは推論側
// （llama.cpp / Ollama / wllama）が自動で付けるため、ここでは付けない。

const TAG = "<|plamo:tag|>";
const MSG = "<|plamo:msg|>";
const KEY = "<|plamo:key|>";
const VAL = "<|plamo:val|>";
const INDEX = "<|plamo:index|>";
const ITEM = "<|plamo:item|>";

/** 生成を止めるトークン。訳文の後にモデルはこのどちらかを出力する。 */
export const STOP = [TAG, "<|plamo:bos|>"];

const KANA = /[぀-ゟ゠-ヿ]/;

/**
 * 推論サーバーはプロンプト中の特殊トークンを文字列のまま解釈するため、原文に `<|` があると
 * 特殊トークンと誤認される。`<` の直後にゼロ幅スペースを入れて無害化する。
 */
export function escape(text) {
  return String(text).replaceAll("<|", "<​|");
}

/** 原文の言語の大まかな判定。 */
export function looksJapanese(text) {
  return KANA.test(text);
}

/** `auto` は日⇄英：かなを含めば英語へ、それ以外は日本語へ（モデルの既定動作と同じ）。 */
export function resolveTarget(target, text) {
  if (target && target !== "auto") return target;
  return looksJapanese(text) ? "en" : "ja";
}

/** 「原語 => 訳語」「原語 = 訳語」の行を用語集に変換する。 */
export function parseGlossary(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(.+?)\s*=>?\s*(.+)$/.exec(line.trim());
    if (m && m[1].trim() && m[2].trim()) out.push({ source: m[1].trim(), target: m[2].trim() });
  }
  return out;
}

/**
 * 翻訳プロンプト。
 * @param {object} o
 * @param {string} o.text 原文
 * @param {string} o.target 翻訳先の言語コード（auto 不可）
 * @param {string} [o.source] 原文の言語コード
 * @param {string} [o.form] polite / plain（日本語への翻訳のみ）
 * @param {string} [o.context] 参考文脈
 * @param {{source:string,target:string}[]} [o.glossary] 用語集
 * @param {{source:string,translation:string}[]} [o.history] 対訳履歴
 */
export function buildPrompt({ text, target, source, form, context, glossary = [], history = [] }) {
  const input = (t) => TAG + "input" + (source ? KEY + "lang" + VAL + source : "") + MSG + escape(t);
  const output = TAG + "output" + KEY + "lang" + VAL + target;
  let p = TAG + "dataset" + MSG + "translation";
  if (context && context.trim()) p += TAG + "context" + MSG + escape(context);
  for (const pair of history) p += input(pair.source) + output + MSG + escape(pair.translation);
  if (glossary.length) {
    p += TAG + "glossary";
    for (const g of glossary) p += INDEX + escape(g.source) + ITEM + escape(g.target);
  }
  p += input(text) + output;
  if (form && target === "ja") p += KEY + "form" + VAL + form;
  return p + MSG;
}

/** トークン数の概算：CJK は 1 文字 ≒ 1 トークン、ラテン文字は 4 文字 ≒ 1 トークン。 */
export function estimateTokens(text) {
  let narrow = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) < 0x2e80) narrow++;
    else wide++;
  }
  return Math.ceil(narrow / 4 + wide);
}

/** 訳文の生成上限。暴走したときだけ打ち切れるよう余裕を持たせる。 */
export function maxTokensFor(text, cap = 2048) {
  return Math.min(cap, estimateTokens(text) * 3 + 64);
}

/**
 * 長文を段落単位のチャンクに分ける（各チャンクは概ね maxTokens 以下）。
 * 戻り値は [{ text, sep }]：訳文は各チャンクの訳の後に sep を続けて連結する。
 */
export function splitText(text, maxTokens = 400) {
  const parts = [];
  const re = /\n\s*\n/g;
  let start = 0;
  for (const m of text.matchAll(re)) {
    pushPiece(text.slice(start, m.index), m[0], maxTokens, parts);
    start = m.index + m[0].length;
  }
  pushPiece(text.slice(start), "", maxTokens, parts);

  const chunks = [];
  for (const p of parts) {
    const last = chunks.at(-1);
    if (last && estimateTokens(last.text + last.sep + p.text) <= maxTokens) {
      last.text += last.sep + p.text;
      last.sep = p.sep;
    } else {
      chunks.push({ ...p });
    }
  }
  return chunks;
}

function pushPiece(text, sep, maxTokens, out) {
  if (!text.trim()) {
    if (out.length) out.at(-1).sep += text + sep;
    return;
  }
  if (estimateTokens(text) <= maxTokens) {
    out.push({ text, sep });
    return;
  }
  // 改行 → 文末 → 空白の順で区切る。
  for (const boundary of [/\n/g, /(?<=[.!?。！？])\s*/g, /\s+/g]) {
    const pieces = [];
    let s = 0;
    for (const m of text.matchAll(boundary)) {
      if (m.index === 0 || m.index + m[0].length >= text.length) continue;
      pieces.push([text.slice(s, m.index), m[0]]);
      s = m.index + m[0].length;
    }
    if (pieces.length) {
      pieces.push([text.slice(s), sep]);
      for (const [t, sp] of pieces) pushPiece(t, sp, maxTokens, out);
      return;
    }
  }
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += maxTokens) {
    out.push({ text: chars.slice(i, i + maxTokens).join(""), sep: i + maxTokens >= chars.length ? sep : "" });
  }
}
