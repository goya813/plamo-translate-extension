# Third-party notices

## plamo-translate-desktop

<https://github.com/tanakh/plamo-translate-desktop>（Apache-2.0 または MIT のデュアルライセンス。ここでは MIT を選択）

次のものを流用・参考にしています。

- `vendor/wllama/` の wllama ビルド（同リポジトリの `extension/vendor/wllama/` をそのまま使用）
- `engine.js` の、WebGPU で高性能 GPU を優先させるコード（`GPU_PREFERENCE`）
- `content.js` のページ翻訳の方式（インライン要素を番号付きタグで送り、訳文から元の要素を複製して組み立て直す）
- `lib/pfml.js` の、原文中の `<|` を無害化する方法

```
MIT License

Copyright (c) 2026 Hideyuki Tanaka

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## wllama

<https://github.com/ngxson/wllama>（MIT）。ライセンス本文は [vendor/wllama/LICENSE-wllama.txt](vendor/wllama/LICENSE-wllama.txt)。

## llama.cpp

<https://github.com/ggml-org/llama.cpp>（MIT）。ライセンス本文は [vendor/wllama/LICENSE-llama.cpp.txt](vendor/wllama/LICENSE-llama.cpp.txt)。

## PLaMo 3 Translate

モデルの重みはこのリポジトリに含まれません。利用者が Hugging Face から取得し、
[PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja) に従って利用します。Built with PLaMo.
