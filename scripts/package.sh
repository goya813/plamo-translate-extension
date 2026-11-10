#!/usr/bin/env bash
# 拡張を「パッケージ化されていない拡張機能を読み込む」で使える zip にまとめる。
# 使い方: scripts/package.sh [出力ディレクトリ]（既定: dist）
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-dist}"
NAME="plamo-local-translator"
VERSION="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 拡張の実行に必要なファイルだけを入れる。
FILES=(
  manifest.json
  background.js content.js engine.html engine.js
  popup.html popup.js options.html options.js ui.css
  lib icons vendor
  LICENSE THIRD-PARTY-NOTICES.md README.md
)
mkdir -p "$STAGE/$NAME"
for f in "${FILES[@]}"; do
  cp -R "$f" "$STAGE/$NAME/"
done
find "$STAGE" -name .DS_Store -delete

mkdir -p "$OUT"
ZIP="$(cd "$OUT" && pwd)/$NAME-$VERSION.zip"
rm -f "$ZIP"
(cd "$STAGE" && zip -qrX "$ZIP" "$NAME")
(cd "$OUT" && shasum -a 256 "$(basename "$ZIP")" > "$(basename "$ZIP").sha256")
echo "$ZIP"
