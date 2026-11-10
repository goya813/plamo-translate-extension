# wllama

[wllama](https://github.com/ngxson/wllama)（MIT）は llama.cpp（MIT）を WebAssembly にコンパイルしたもので、WebGPU にも対応しています。
この拡張のブラウザ内エンジン（engine.js）はこれで PLaMo 3 Translate を動かします。

npm で配布されている wllama（3.8.1 時点）は PLaMo 3 のトークナイザーに対応する前の llama.cpp を同梱しているため、
[tanakh/plamo-translate-desktop](https://github.com/tanakh/plamo-translate-desktop)（Apache-2.0 / MIT）の
`extension/vendor/wllama/` にある、ソースからビルドされたファイルをそのまま使っています。

- wllama 3.12.0, commit c10c21114984e37fe6ba4edbba446c28c5b7a954
- llama.cpp commit d38bea34227bbf9069d62fdc239c98ab6e05435a
- パッチ：cache-ram.patch（plamo-translate-desktop の `patches/wllama`）

`wllama.js` は wllama の `esm/index.js`、`wllama.wasm` は `esm/wasm/wllama.wasm` です。
ライセンスは同じフォルダの LICENSE-wllama.txt と LICENSE-llama.cpp.txt を参照してください。
