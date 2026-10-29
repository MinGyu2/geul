#!/usr/bin/env bash
# Optional local regression suite for the mandatory secret scanner.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tests_root="${GEUL_TESTS_ROOT:-$repo/tests}"
if [[ ! -d "$tests_root/security" ]]; then
  echo "[건너뜀] 보안 검사기 회귀 테스트를 찾을 수 없습니다: $tests_root/security (필수 민감정보 검사는 별도 실행)"
  exit 0
fi
exec python3 -m unittest discover -s "$tests_root/security"
