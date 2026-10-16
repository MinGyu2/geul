#!/usr/bin/env bash
# 훅 우회 → CI 차단 → 이력 정리 시나리오를 임시 저장소에서 재현한다.
#
# 사용: GITLEAKS=<gitleaks 경로> tests/security/simulate-leak-response.sh
#
# 실제 저장소와 원격에는 아무것도 쓰지 않는다. 임시 저장소에는 훅을 설치하지 않으므로
# `git commit --no-verify`로 로컬 훅을 우회한 것과 같은 상태가 된다.
# 가짜 토큰은 실행할 때마다 무작위로 만들며 출력에는 마스킹된 값만 나와야 한다.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Sim GIT_AUTHOR_EMAIL=sim@example.com
export GIT_COMMITTER_NAME=Sim GIT_COMMITTER_EMAIL=sim@example.com
export PYTHONDONTWRITEBYTECODE=1

repo="$work/repo"
mkdir -p "$repo"
cp -R "$root/scripts" "$root/tests" "$root/.gitignore" "$root/.gitleaks.toml" "$repo/"
cd "$repo"
git init -q -b main
git add . && git commit -qm "기준 커밋"

step() { printf '\n== %s\n' "$1"; }
expect() { # expect <기대 종료 코드> <명령...>
  local want="$1"; shift
  set +e; "$@"; local got=$?; set -e
  if [[ "$got" != "$want" ]]; then
    echo "!! 기대 종료 코드 $want, 실제 $got: $*"; exit 1
  fi
  echo "-- 종료 코드 $got (기대값과 일치)"
}

token="$(python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("ghp_"+"".join(secrets.choice(a) for _ in range(36)))')"
home_path="/""home/sim-user-$RANDOM/work"  # 리터럴로 쓰면 이 파일 자체가 검출된다

step "1. 훅 없이 가짜 비밀을 포함한 커밋 생성 (훅 우회와 동일)"
git switch -qc feature/leak
printf 'token = "%s"\nlog = "%s/out.log"\n' "$token" "$home_path" > config.toml
git add config.toml && git commit -qm "실수로 비밀 포함"
leak_commit="$(git rev-parse --short=12 HEAD)"
echo "누출 커밋: $leak_commit"

step "2. CI와 같은 검사(PR 시뮬레이션) → 실패해야 함"
out="$work/ci.log"
expect 1 bash -c '"$1" . >"$2" 2>&1' _ "$root/scripts/security-scan-ci.sh" "$out"
grep -E '^\[(통과|실패)\]|\[(github-token|home-path-unix|secret-assignment)\]|RuleID|leaks found' "$out" || true
if grep -qF "$token" "$out"; then echo "!! 비밀 원문이 로그에 노출됨"; exit 1; fi
echo "-- 로그에 비밀 원문 없음 (마스킹 확인)"

step "3. 파일에서만 삭제 → 현재 트리는 통과하지만 이력 검사는 계속 실패해야 함"
git rm -q config.toml && git commit -qm "비밀 삭제"
expect 0 python3 scripts/check-sensitive-info.py --all
expect 1 python3 scripts/check-sensitive-info.py --history

step "4. 아직 공유되지 않은 브랜치에서 이력 재작성 → 이력 검사 통과"
git reset -q --hard main
git reflog expire --expire=now --all && git gc -q --prune=now
expect 0 python3 scripts/check-sensitive-info.py --history
expect 0 "${GITLEAKS:-gitleaks}" git --redact --no-banner .

echo
echo "시뮬레이션 완료: 우회된 커밋은 CI 단계에서 차단되고, 파일 삭제만으로는 이력 검사를 통과하지 못함을 확인했다."
echo "실제 누출이었다면 이력 정리보다 먼저 키를 폐기·재발급해야 한다 (docs/development/security-incident.md)."
