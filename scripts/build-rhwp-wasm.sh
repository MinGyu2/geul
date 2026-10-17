#!/usr/bin/env bash
# rhwp WASM 모듈을 빌드해 앱이 불러오는 위치(public/rhwp/, Git 무시)에 둔다(T007).
#
# - 업스트림 submodule(external/rhwp)은 수정하지 않는다. cargo 빌드 산출물은 target/rhwp-wasm/(Git 무시),
#   wasm-pack 출력은 public/rhwp/로 보내 submodule 안에 아무것도 만들지 않는다.
# - --locked: submodule의 Cargo.lock을 바꾸지 않는다(의존성 판 고정).
# - 필요: wasm32-unknown-unknown 타깃이 있는 Rust, wasm-pack(wasm-bindgen CLI는 Cargo.lock의 판을 wasm-pack이 받음).
# 사용법: scripts/build-rhwp-wasm.sh [--dev]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
engine="$root/external/rhwp"
out="$root/public/rhwp"
profile="--release"
[[ "${1:-}" == "--dev" ]] && profile="--dev"

if [[ ! -f "$engine/Cargo.toml" ]]; then
  echo "external/rhwp submodule이 없습니다: git submodule update --init external/rhwp" >&2
  exit 1
fi

before="$(git -C "$engine" status --porcelain)"
CARGO_TARGET_DIR="$root/target/rhwp-wasm" wasm-pack build "$engine" \
  --target web "$profile" --no-pack --out-dir "$out" --out-name rhwp -- --locked
after="$(git -C "$engine" status --porcelain)"
if [[ "$before" != "$after" ]]; then
  echo "빌드가 external/rhwp 작업 트리를 바꿨습니다:" >&2
  echo "$after" >&2
  exit 1
fi
rm -f "$out/.gitignore"
# 타입 선언은 앱에 싣지 않는다(API 확인용으로 target/에 남김).
mkdir -p "$root/target/rhwp-wasm/types"
mv -f "$out"/*.d.ts "$root/target/rhwp-wasm/types/"
# 빌드 판을 기록한다(앱이 로드한 엔진의 출처 확인용).
printf '{"engine":"rhwp","commit":"%s"}\n' "$(git -C "$engine" rev-parse HEAD)" > "$out/BUILD.json"
ls -l "$out"
