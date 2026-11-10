# PLaMo Local Translator（Chrome 拡張）

> **非公式**：この拡張は有志による非公式のツールです。Preferred Networks（PFN）および同社の翻訳サービス「PLaMo翻訳」とは関係がなく、
> PFN による公認・保証を受けたものではありません。「PLaMo」は PFN の製品名です。

Preferred Networks の翻訳特化 LLM [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b) で、
Web ページや選択したテキストをローカルで翻訳する Chrome 拡張です。

## 機能

- **ページ翻訳**：リンク・強調・インラインコードを保ったまま段落を置き換えます（「原文の下に訳文」表示も選べます）。
  画面に近い段落から順に翻訳し、スクロールや動的に追加された内容にも追随します。右下の「元に戻す」で原文に戻せます。
- **選択範囲の翻訳**：マウスでテキストを選択すると横に「訳」ボタンが出て、押すと選択範囲の近くに訳文を表示します。
  右クリックメニュー「PLaMo で翻訳」や Alt+Shift+Y でも使えます（ボタンは設定画面でオフにできます）。
- **ポップアップ**：テキストを貼り付けて翻訳します（⌘/Ctrl + Enter）。長文は段落に分け、直前の対訳を履歴として渡して訳語をそろえます。
- 対応言語は 53 言語。既定は日本語 ⇄ 英語の自動切り替えです。日本語の文体（敬体・常体）、用語集、参考文脈を指定できます。

## 推論エンジン

| エンジン | 準備 | 使えるモデル |
| --- | --- | --- |
| **ブラウザ内**（既定） | 設定画面でモデルをダウンロードするだけ | 0.8B / 2B（Q4_K_M） |
| **Ollama** | `ollama pull hf.co/pfnet/plamo-3-translate-0.8b-GGUF:Q4_K_M` | 0.8B〜31B の GGUF |
| **llama-server / vLLM** | `llama-server -hf pfnet/plamo-3-translate-0.8b-GGUF:Q4_K_M -c 16384 --port 8000 --alias plamo-3-translate` | 任意 |

- ブラウザ内エンジンは [wllama](https://github.com/ngxson/wllama)（llama.cpp の WebAssembly 版）をオフスクリーンドキュメントで動かします。
  WebGPU が使えれば GPU、使えなければ CPU（マルチスレッド）で実行します。モデルは拡張の保存領域（OPFS）に置かれ、
  10 分使わないとメモリから解放されます。
- Ollama は既定で `chrome-extension://` からのリクエストを拒否しますが、この拡張は localhost 宛てのリクエストに限り
  declarativeNetRequest で Origin ヘッダーを外すため、`OLLAMA_ORIGINS` の設定は不要です。
- どのエンジンでも、モデルカードが推奨する PFML3 形式のプロンプトを直接組み立てて送ります（`lib/pfml.js`）。

## インストール

1. [Releases](https://github.com/goya813/plamo-translate-extension/releases) から `plamo-local-translator-<version>.zip` をダウンロードして展開します
   （リポジトリを clone した場合は、そのフォルダをそのまま使えます）。
2. `chrome://extensions` を開き、右上の「デベロッパー モード」をオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」で、展開した `plamo-local-translator` フォルダを選びます。
4. 開いた設定画面でエンジンを選びます。ブラウザ内なら「ダウンロード」（0.8B は約 0.57 GB）を押し、「接続テスト」で確認します。

## リリース

`manifest.json` の `version` を上げてコミットし、同じ番号のタグを push すると、GitHub Actions（`.github/workflows/release.yml`）が
zip と SHA-256 を作って Release に添付します。タグと `version` が一致しないと失敗します。

```sh
git tag v0.2.0 && git push origin v0.2.0
```

手元で zip を作るときは `scripts/package.sh` を実行します（`dist/` に出力）。

## ファイル構成

```
manifest.json
background.js      Service Worker：エンジンの振り分け、同時実行数の制御、メニュー・ショートカット
engine.html/js     ブラウザ内エンジン（オフスクリーンドキュメント、wllama）
content.js         ページに注入：ページ翻訳と選択範囲の翻訳カード
popup.html/js      ポップアップ
options.html/js    設定画面
lib/pfml.js        PFML3 プロンプトの組み立て、長文の分割
lib/models.js      ブラウザ内で使うモデルの一覧
lib/settings.js    設定の既定値
lib/langs.js       対応言語
vendor/wllama/     wllama のビルド（PLaMo 3 対応版）
```

## ライセンスとクレジット

- この拡張のソースコードは [MIT License](LICENSE) です（`vendor/` を除く）。同梱・流用したサードパーティのライセンスは
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) を参照してください。

- PLaMo 3 Translate のモデルは [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja) で提供されています。
  個人・非商用は無償で利用できます。商用利用は、売上 10 億円以下なら登録フォームでの登録、それを超える場合は別途契約が必要です。
  Built with PLaMo.
- `vendor/wllama/` は wllama（MIT）と llama.cpp（MIT）です。PLaMo 3 対応のビルドは
  [tanakh/plamo-translate-desktop](https://github.com/tanakh/plamo-translate-desktop)（Apache-2.0 / MIT）のものを使っています。
- ページ翻訳でインライン要素を番号付きタグにして送り、訳文から元の要素を複製して組み立て直す方式、および WebGPU で
  高性能 GPU を優先させる手法は、同リポジトリのブラウザ拡張を参考にしました。
