#!/usr/bin/env bash
# CI와 로컬 시뮬레이션이 함께 쓰는 공개 저장소 보안 검사.
#
# 사용: scripts/security-scan-ci.sh [저장소 경로]
#   GITLEAKS  사용할 gitleaks 실행 파일 (기본값: PATH의 gitleaks). 없으면 실패한다.
#
# 하나라도 실패하면 나머지 검사를 계속 수행한 뒤 0이 아닌 값으로 끝난다.
set -uo pipefail

repo="${1:-.}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scanner="$script_dir/check-sensitive-info.py"
tests_dir="$script_dir/../tests/security"
gitleaks="${GITLEAKS:-gitleaks}"
failed=()

run() {
  local name="$1"
  shift
  echo "::group::$name"
  if "$@"; then
    echo "[통과] $name"
  else
    echo "[실패] $name"
    failed+=("$name")
  fi
  echo "::endgroup::"
}

run "검사기 회귀 테스트" python3 -m unittest discover -s "$tests_dir"
run "추적 파일 민감정보 검사" bash -c 'cd "$1" && python3 "$2" --all' _ "$repo" "$scanner"
run "Git 이력 민감정보 검사" bash -c 'cd "$1" && python3 "$2" --history' _ "$repo" "$scanner"

if command -v "$gitleaks" >/dev/null 2>&1; then
  "$gitleaks" version
  run "Gitleaks 전체 이력 검사" "$gitleaks" git --redact --no-banner --verbose "$repo"
else
  echo "[실패] gitleaks 실행 파일을 찾을 수 없습니다: $gitleaks"
  failed+=("Gitleaks 설치")
fi

if ((${#failed[@]})); then
  printf '보안 검사 실패: %s\n' "${failed[@]}"
  exit 1
fi
echo "모든 보안 검사 통과"
