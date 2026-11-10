// ページに注入するスクリプト（background.js が必要なときに executeScript で注入する）。
// - 選択範囲の翻訳カード
// - ページ全体の翻訳
//
// ページ翻訳では、ブロック内の連続したテキストとインライン要素（リンク・強調・コードなど）を
// ひとまとまり（ラン）として扱う。ランは `詳しくは <a i="1">ガイド</a> を参照` のように、属性の
// 代わりに番号だけを付けた簡易 HTML にして送る。訳文は inert に解析し、テキストノードと元の要素の
// 複製から組み立て直すので、リンク先などはそのまま残り、モデルの出力が属性やスクリプトを
// 追加することはない（この方式は tanakh/plamo-translate-desktop の拡張を参考にした）。

(() => {
  // 拡張を再読み込みすると、開いたままのページには無効になった前のスクリプトが残る。
  // 前のスクリプトが生きていれば何もせず、無効なら入れ直す。
  const alive = () => !!chrome.runtime?.id;
  if (window.__plamoTranslate?.()) return;
  window.__plamoTranslate = alive;

  const KANA = /[぀-ゟ゠-ヿ]/;
  const LETTER = /\p{L}/u;
  const EN_WORDS = new Set(
    "the of and to a in is that for it as with was on be by are this you from or at have not an but can which will your all has their more".split(" "),
  );

  // 翻訳も中身の走査もしない要素。
  const SKIP = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "BUTTON",
    "SVG", "MATH", "CANVAS", "IFRAME", "OBJECT", "VIDEO", "AUDIO", "PRE", "HEAD",
  ]);
  // ランに含められるインライン要素。
  const INLINE = new Set([
    "A", "ABBR", "B", "BDI", "BDO", "BIG", "BR", "CITE", "CODE", "DATA", "DEL", "DFN", "EM", "FONT",
    "I", "IMG", "INS", "KBD", "LABEL", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRIKE", "STRONG",
    "SUB", "SUP", "TIME", "TT", "U", "VAR", "WBR",
  ]);
  // 中身を翻訳せず、そのまま残すインライン要素。
  const OPAQUE = new Set(["BR", "CODE", "IMG", "KBD", "SAMP", "VAR", "WBR"]);
  const VOID = new Set(["BR", "IMG", "WBR"]);
  // 訳文に現れても中身ごと捨てる要素。
  const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "OBJECT", "SVG", "MATH"]);

  const send = (msg) => chrome.runtime.sendMessage(msg);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "page-toggle") page.toggle(msg.target, msg.mode);
    if (msg?.type === "selection") showSelection(msg.text, msg.target);
  });

  // ---- 共通 ----

  function ensureStyle() {
    if (document.getElementById("plamo-translate-style")) return;
    const style = document.createElement("style");
    style.id = "plamo-translate-style";
    style.setAttribute("data-plamo", "");
    style.textContent = `
      [data-plamo-below] { display: block; margin: .25em 0 .1em; padding-left: .6em;
        border-left: 3px solid #8aa4ff; opacity: .88; }
      [data-plamo-pending] { background-image: linear-gradient(90deg, transparent, rgba(138,164,255,.18), transparent);
        background-size: 200% 100%; animation: plamo-shimmer 1.2s linear infinite; }
      @keyframes plamo-shimmer { from { background-position: 100% 0 } to { background-position: -100% 0 } }
    `;
    (document.head ?? document.documentElement).append(style);
  }

  /** 翻訳先の言語で既に書かれていそうなテキスト。 */
  function alreadyIn(target, text) {
    if (target === "ja") return KANA.test(text);
    if (target === "en") {
      if (/[^\x00-\x7f -⁯ ]/.test(text)) return false;
      const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
      if (words.length < 3) return true;
      return words.filter((w) => EN_WORDS.has(w)).length / words.length >= 0.12;
    }
    return false;
  }

  function pageTarget(target) {
    if (target && target !== "auto") return target;
    const lang = (document.documentElement.lang || "").toLowerCase();
    if (lang.startsWith("ja")) return "en";
    if (lang && !lang.startsWith("ja")) return "ja";
    const sample = (document.body?.innerText ?? "").slice(0, 3000);
    const kana = (sample.match(/[぀-ヿ]/g) ?? []).length;
    return kana > sample.length * 0.05 ? "en" : "ja";
  }

  // ---- 選択範囲の翻訳カード ----

  const CARD_LANGS = [
    ["auto", "自動（日⇄英）"], ["ja", "日本語"], ["en", "英語"], ["zh-hans", "中国語（簡体字）"],
    ["zh-hant", "中国語（繁体字）"], ["ko", "韓国語"], ["fr", "フランス語"], ["de", "ドイツ語"],
    ["es", "スペイン語"], ["it", "イタリア語"], ["ru", "ロシア語"], ["vi", "ベトナム語"],
    ["th", "タイ語"], ["id", "インドネシア語"],
  ];

  let card = null;

  function closeCard() {
    card?.host.remove();
    card = null;
  }

  function showSelection(text, target) {
    const sel = window.getSelection();
    // 選択範囲から取れれば改行を保てる（コンテキストメニューのテキストは改行が消える）。
    const selected = sel && sel.rangeCount ? sel.toString() : "";
    text = selected.trim() ? selected : text;
    let rect = null;
    if (sel && sel.rangeCount && selected.trim()) rect = sel.getRangeAt(0).getBoundingClientRect();
    closeCard();
    if (!text || !text.trim()) {
      toast("翻訳するテキストを選択してください");
      return;
    }

    const host = document.createElement("plamo-translate-card");
    host.setAttribute("data-plamo", "");
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { color-scheme: light dark; }
        .card { box-sizing: border-box; width: min(440px, calc(100vw - 24px)); max-height: min(60vh, 480px);
          display: flex; flex-direction: column; font: 14px/1.6 system-ui, -apple-system, "Hiragino Sans", sans-serif;
          background: Canvas; color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
          border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22); overflow: hidden; }
        header { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px;
          border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); font-size: 12px; }
        header b { font-weight: 600; margin-right: auto; }
        select { font: inherit; padding: 2px 4px; border-radius: 6px; }
        button { font: inherit; cursor: pointer; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
          background: transparent; color: inherit; border-radius: 6px; padding: 2px 10px; }
        button:hover { background: color-mix(in srgb, CanvasText 8%, transparent); }
        .x { border: none; font-size: 16px; padding: 0 6px; }
        .body { padding: 10px 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
        .muted { opacity: .6; }
        .err { color: #d33; }
        footer { display: flex; justify-content: flex-end; gap: 6px; padding: 6px 8px;
          border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent); }
      </style>
      <div class="card" role="dialog" aria-label="PLaMo Local Translator">
        <header><b>PLaMo Local Translator</b><select aria-label="翻訳先"></select><button class="x" title="閉じる (Esc)">×</button></header>
        <div class="body muted">翻訳中…</div>
        <footer><button class="copy">コピー</button></footer>
      </div>`;
    const select = root.querySelector("select");
    for (const [code, name] of CARD_LANGS) select.add(new Option(name, code));
    if (![...select.options].some((o) => o.value === target)) select.add(new Option(target, target));
    select.value = target || "auto";
    const body = root.querySelector(".body");
    root.querySelector(".x").onclick = closeCard;
    root.querySelector(".copy").onclick = async (e) => {
      await navigator.clipboard.writeText(body.textContent).catch(() => {});
      e.target.textContent = "コピーしました";
      setTimeout(() => (e.target.textContent = "コピー"), 1200);
    };
    document.documentElement.append(host);

    // 選択範囲の下（入らなければ上）に置く。
    const box = root.querySelector(".card");
    const place = () => {
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const r = rect ?? { left: innerWidth / 2 - w / 2, bottom: 80, top: 80 };
      let top = r.bottom + 8;
      if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 8);
      const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      host.style.top = `${top}px`;
      host.style.left = `${left}px`;
    };
    place();

    let seq = 0;
    const run = async () => {
      const mine = ++seq;
      body.className = "body muted";
      body.textContent = "翻訳中…";
      place();
      const res = await send({ type: "translate", text, target: select.value }).catch((e) => ({ ok: false, error: String(e) }));
      if (mine !== seq || card?.host !== host) return;
      if (res?.ok) {
        body.className = "body";
        body.textContent = res.text;
      } else {
        body.className = "body err";
        body.textContent = res?.error ?? "翻訳に失敗しました";
      }
      place();
    };
    select.onchange = run;
    card = { host };
    run();
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && card) closeCard();
    },
    true,
  );
  document.addEventListener(
    "mousedown",
    (e) => {
      if (card && !e.composedPath().includes(card.host)) closeCard();
    },
    true,
  );

  function toast(text) {
    const el = document.createElement("plamo-translate-toast");
    el.setAttribute("data-plamo", "");
    el.textContent = text;
    el.style.cssText =
      "all: initial; position: fixed; z-index: 2147483647; left: 50%; top: 24px; transform: translateX(-50%);" +
      "background: #222; color: #fff; padding: 8px 14px; border-radius: 8px; font: 13px system-ui, sans-serif;" +
      "box-shadow: 0 4px 16px rgba(0,0,0,.25);";
    document.documentElement.append(el);
    setTimeout(() => el.remove(), 2500);
  }

  // ---- テキストを選択したときの「訳」ボタン ----

  let selectionButtonEnabled = true;
  chrome.storage.local.get("selectionButton").then((v) => (selectionButtonEnabled = v.selectionButton !== false));
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.selectionButton) selectionButtonEnabled = changes.selectionButton.newValue !== false;
    if (!selectionButtonEnabled) hideButton();
  });

  let button = null;

  function hideButton() {
    button?.remove();
    button = null;
  }

  /** 選択範囲の末尾のすぐ右下にボタンを出す。 */
  function showButton(text, rect) {
    hideButton();
    const host = document.createElement("plamo-translate-button");
    host.setAttribute("data-plamo", "");
    const size = 28;
    const top = Math.min(innerHeight - size - 4, rect.bottom + 6);
    const left = Math.min(innerWidth - size - 4, Math.max(4, rect.right + 4));
    host.style.cssText = `all: initial; position: fixed; z-index: 2147483647; top: ${top}px; left: ${left}px;`;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        button { all: unset; box-sizing: border-box; width: ${size}px; height: ${size}px; border-radius: 8px;
          display: grid; place-items: center; cursor: pointer; background: #4b63d8; color: #fff;
          font: 600 14px/1 system-ui, -apple-system, "Hiragino Sans", sans-serif;
          box-shadow: 0 3px 10px rgba(0,0,0,.25); animation: pop .12s ease-out; }
        button:hover { background: #3a50c0; }
        @keyframes pop { from { transform: scale(.6); opacity: 0 } }
      </style>
      <button title="PLaMo で翻訳" aria-label="PLaMo で翻訳">訳</button>`;
    const btn = root.querySelector("button");
    // 押した瞬間に選択が解除されないよう mousedown の既定動作を止める。
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideButton();
      const { targetLang } = await chrome.storage.local.get("targetLang");
      showSelection(text, targetLang ?? "auto");
    });
    document.documentElement.append(host);
    button = host;
  }

  const fromUs = (e) => e.composedPath().some((n) => n instanceof Element && n.hasAttribute?.("data-plamo"));

  document.addEventListener(
    "mouseup",
    (e) => {
      if (!alive() || !selectionButtonEnabled || e.button !== 0 || fromUs(e)) return;
      // クリックで選択が解除されるのを待ってから確認する。
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel && sel.rangeCount ? sel.toString() : "";
        if (!text.trim() || text.length > 10000) {
          hideButton();
          return;
        }
        const range = sel.getRangeAt(0);
        const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
        const rect = rects.at(-1) ?? range.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) return;
        showButton(text, rect);
      }, 10);
    },
    true,
  );
  document.addEventListener("mousedown", (e) => button && !fromUs(e) && hideButton(), true);
  document.addEventListener("keydown", () => hideButton(), true);
  window.addEventListener("scroll", () => hideButton(), { capture: true, passive: true });
  document.addEventListener("selectionchange", () => {
    if (button && !window.getSelection()?.toString().trim()) hideButton();
  });

  // ---- ページ翻訳 ----

  const page = (() => {
    let active = false;
    let target = "ja";
    let mode = "replace";
    /** 送ったランのノード（二重に送らないため）。 */
    let handled = new WeakSet();
    /** ブロック要素 → まだ送っていないラン */
    let waiting = new Map();
    /** 送信待ちのラン（画面に入った順）。 */
    let queue = [];
    let inFlight = 0;
    const MAX_IN_FLIGHT = 8;
    /** 元に戻すための記録：{ wrapper, nodes } */
    let applied = [];
    let total = 0;
    let done = 0;
    let failed = 0;
    let lastError = "";
    let io = null;
    let mo = null;
    let rescanTimer = null;
    let ui = null;
    let generation = 0;

    const ours = (node) => node.nodeType === Node.ELEMENT_NODE && node.hasAttribute("data-plamo");
    const noTranslate = (el) => el.getAttribute("translate") === "no" || el.classList.contains("notranslate");
    const skipped = (el) => SKIP.has(el.tagName) || ours(el) || el.isContentEditable || noTranslate(el);
    const opaque = (el) => OPAQUE.has(el.tagName) || noTranslate(el);

    function inline(el) {
      if (!INLINE.has(el.tagName)) return false;
      if (opaque(el)) return true;
      if (skipped(el)) return false;
      for (const child of el.children) if (!inline(child)) return false;
      return true;
    }

    /** root 以下のラン（連続したテキスト・インライン要素）を文書順に集める。 */
    function collect(root, out = []) {
      let run = [];
      const flush = () => {
        if (run.length && !run.some((n) => handled.has(n)) && translatable(run)) out.push(run);
        run = [];
      };
      for (const node of root.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          run.push(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (inline(node)) {
            run.push(node);
          } else {
            flush();
            if (!skipped(node)) collect(node, out);
          }
        }
      }
      flush();
      return out;
    }

    const runText = (run) => run.map((n) => n.textContent).join("").replace(/\s+/g, " ").trim();

    function translatable(run) {
      const text = runText(run);
      return text.length >= 2 && LETTER.test(text) && !alreadyIn(target, text);
    }

    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    /** ランを番号付きの簡易 HTML にする。要素がなければプレーンテキスト。 */
    function serialize(run) {
      const elements = [];
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return esc(node.data.replace(/\s+/g, " "));
        if (node.nodeType !== Node.ELEMENT_NODE) return "";
        const tag = node.tagName.toLowerCase();
        const i = elements.push(node) - 1;
        if (VOID.has(node.tagName)) return `<${tag} i="${i}">`;
        if (opaque(node)) return `<${tag} i="${i}">${esc(node.textContent.replace(/\s+/g, " "))}</${tag}>`;
        return `<${tag} i="${i}">${[...node.childNodes].map(walk).join("")}</${tag}>`;
      };
      const html = run.map(walk).join("");
      const lead = /^\s/.test(run[0].textContent) ? " " : "";
      const trail = /\s$/.test(run.at(-1).textContent) ? " " : "";
      return { html: html.trim(), elements, plain: elements.length === 0, lead, trail };
    }

    /** 訳文から DOM を組み立てる。元の要素は番号で引き当てて複製する。 */
    function rebuild(translation, s) {
      const frag = document.createDocumentFragment();
      if (s.plain) {
        // プレーンテキストとして送ったので、訳文に < があってもタグとして扱わない。
        frag.append(s.lead + translation + s.trail);
        return frag;
      }
      // <template> の中身は inert（スクリプトは動かず、画像も読み込まれない）。
      const tpl = document.createElement("template");
      tpl.innerHTML = translation;
      const build = (node, out) => {
        if (node.nodeType === Node.TEXT_NODE) {
          out.append(node.data);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE || DROP.has(node.tagName)) return;
        const i = node.getAttribute("i");
        const orig = i != null && /^\d+$/.test(i) ? s.elements[Number(i)] : null;
        if (orig && opaque(orig)) {
          out.append(orig.cloneNode(true));
        } else if (orig) {
          const el = orig.cloneNode(false);
          for (const child of node.childNodes) build(child, el);
          out.append(el);
        } else {
          for (const child of node.childNodes) build(child, out);
        }
      };
      if (s.lead) frag.append(s.lead);
      for (const child of tpl.content.childNodes) build(child, frag);
      if (s.trail) frag.append(s.trail);
      return frag;
    }

    function apply(run, frag) {
      if (!run[0].isConnected) return;
      const wrapper = document.createElement("span");
      wrapper.setAttribute("data-plamo", "");
      wrapper.setAttribute("lang", target);
      wrapper.append(frag);
      if (mode === "below") {
        wrapper.setAttribute("data-plamo-below", "");
        run.at(-1).after(wrapper);
        applied.push({ wrapper, nodes: null });
      } else {
        run[0].before(wrapper);
        for (const n of run) n.remove();
        applied.push({ wrapper, nodes: run });
      }
    }

    function blockOf(run) {
      return run[0].parentElement;
    }

    function scan(root) {
      const runs = collect(root);
      for (const run of runs) {
        for (const n of run) handled.add(n);
        const block = blockOf(run);
        if (!block) continue;
        if (!waiting.has(block)) {
          waiting.set(block, []);
          io.observe(block);
        }
        waiting.get(block).push(run);
        total++;
      }
      render();
    }

    function onIntersect(entries) {
      // 画面に近いものから順に送る。
      for (const entry of entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)) {
        const runs = waiting.get(entry.target);
        io.unobserve(entry.target);
        waiting.delete(entry.target);
        if (runs) queue.push(...runs);
      }
      pump();
    }

    function pump() {
      while (active && inFlight < MAX_IN_FLIGHT && queue.length) {
        const run = queue.shift();
        if (!run[0].isConnected) {
          total--;
          continue;
        }
        translateRun(run);
      }
      render();
    }

    async function translateRun(run) {
      const gen = generation;
      inFlight++;
      const block = blockOf(run);
      block?.setAttribute("data-plamo-pending", "");
      try {
        const s = serialize(run);
        const res = await send({ type: "translate", text: s.html, target });
        if (gen !== generation) return;
        if (res?.ok) {
          apply(run, rebuild(res.text, s));
          done++;
        } else if (!res?.aborted) {
          failed++;
          lastError = res?.error ?? "翻訳に失敗しました";
          // モデル未取得・接続不可など、続けても失敗するものは止める。
          if (/ダウンロード|接続できません|モデルがありません|HTTP 4/.test(lastError)) stop(false);
        }
      } catch (e) {
        if (gen === generation) {
          failed++;
          lastError = String(e?.message ?? e);
        }
      } finally {
        if (gen === generation) {
          block?.removeAttribute("data-plamo-pending");
          inFlight--;
          pump();
        }
      }
    }

    function start(t, m) {
      active = true;
      generation++;
      target = pageTarget(t);
      mode = m === "below" ? "below" : "replace";
      handled = new WeakSet();
      waiting = new Map();
      queue = [];
      inFlight = 0;
      applied = [];
      total = done = failed = 0;
      lastError = "";
      ensureStyle();
      io = new IntersectionObserver(onIntersect, { rootMargin: "800px 0px" });
      mo = new MutationObserver((mutations) => {
        if (!mutations.some((mu) => [...mu.addedNodes].some((n) => !(n.nodeType === Node.ELEMENT_NODE && ours(n))))) return;
        clearTimeout(rescanTimer);
        rescanTimer = setTimeout(() => active && scan(document.body), 600);
      });
      mo.observe(document.body, { childList: true, subtree: true, characterData: false });
      scan(document.body);
    }

    /** 翻訳を止める。restore なら元のページに戻す。 */
    function stop(restore) {
      active = false;
      generation++;
      io?.disconnect();
      mo?.disconnect();
      clearTimeout(rescanTimer);
      send({ type: "cancel-tab" }).catch(() => {});
      for (const el of document.querySelectorAll("[data-plamo-pending]")) el.removeAttribute("data-plamo-pending");
      if (restore) {
        mo?.disconnect();
        for (const { wrapper, nodes } of applied.reverse()) {
          if (nodes) wrapper.replaceWith(...nodes);
          else wrapper.remove();
        }
        applied = [];
        ui?.remove();
        ui = null;
      } else {
        render();
      }
    }

    function toggle(t, m) {
      if (active || applied.length) stop(true);
      else start(t, m);
    }

    // 右下の進捗表示。
    function render() {
      if (!ui) {
        ui = document.createElement("plamo-translate-status");
        ui.setAttribute("data-plamo", "");
        ui.style.cssText = "all: initial; position: fixed; z-index: 2147483646; right: 16px; bottom: 16px;";
        const root = ui.attachShadow({ mode: "open" });
        root.innerHTML = `
          <style>
            .box { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; border-radius: 999px;
              font: 12px/1.4 system-ui, -apple-system, "Hiragino Sans", sans-serif; color: #fff; background: rgba(28,32,48,.92);
              box-shadow: 0 6px 20px rgba(0,0,0,.25); max-width: min(420px, calc(100vw - 32px)); }
            .msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            button { font: inherit; color: inherit; background: rgba(255,255,255,.14); border: none; border-radius: 999px;
              padding: 3px 10px; cursor: pointer; white-space: nowrap; }
            button:hover { background: rgba(255,255,255,.26); }
            .err { color: #ffb4b4; }
          </style>
          <div class="box"><span class="msg"></span><button class="revert">元に戻す</button></div>`;
        root.querySelector(".revert").onclick = () => stop(true);
        document.documentElement.append(ui);
      }
      const msg = ui.shadowRoot.querySelector(".msg");
      const busy = active && (inFlight > 0 || queue.length > 0);
      let text = `PLaMo Local Translator（→ ${target}）${done} / ${total}`;
      if (busy) text += " 翻訳中…";
      else if (active) text += " ・スクロールすると続きを翻訳";
      if (!active && lastError) text = `停止：${lastError}`;
      else if (failed) text += ` ・失敗 ${failed}`;
      msg.textContent = text;
      msg.className = "msg" + (!active && lastError ? " err" : "");
      msg.title = lastError;
    }

    return { toggle };
  })();
})();
