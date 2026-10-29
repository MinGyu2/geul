#!/usr/bin/env bash
# rhwp WASM 모듈을 빌드해 앱이 불러오는 위치(public/rhwp/, Git 무시)에 둔다(T007).
#
# - external/과 Cargo 의존성 소스는 읽기 전용 마운트로 보호한다.
# - --locked --offline: 고정 lockfile과 설치된 의존성만 사용한다.
# - 필요: bubblewrap, Rust(권장 1.99.0), wasm32-unknown-unknown,
#   Cargo.lock과 같은 버전의 wasm-bindgen CLI. 자동 설치/소스 수정 없음.
# 사용법: scripts/build-rhwp-wasm.sh [--dev]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$root/scripts/build-rhwp-wasm.py" "$@"
