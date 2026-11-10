// ブラウザ内推論で使えるモデル（WebAssembly の 4GB メモリに収まるもの）。
export const MODELS = {
  "0.8b": {
    label: "PLaMo 3 Translate 0.8B (Q4_K_M)",
    repo: "pfnet/plamo-3-translate-0.8b-GGUF",
    file: "plamo-3-translate-0.8b-Q4_K_M.gguf",
    bytes: 573126848,
  },
  "2b": {
    label: "PLaMo 3 Translate 2B (Q4_K_M)",
    repo: "pfnet/plamo-3-translate-2b-GGUF",
    file: "plamo-3-translate-2b-Q4_K_M.gguf",
    bytes: 1807203040,
  },
};
