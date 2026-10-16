#!/usr/bin/env bash
# 실제로 설치되는 pre-push 훅(.pre-commit-config.yaml)을 임시 저장소에서 검증한다.
#
# 사용: PRE_COMMIT=<pre-commit 경로> GITLEAKS=<gitleaks 경로> tests/security/test-pre-push-hook.sh
#   PRE_COMMIT  기본값: PATH의 pre-commit. 없으면 실패한다(필수 도구).
#   GITLEAKS    CI 스크립트 검사용. 기본값: PATH의 gitleaks.
#   KEEP_LOGS   지정하면 훅 로그를 그 경로로 복사한다(디버깅용).
#
# `git push`는 실행하지 않는다. Git이 푸시할 때 하는 것과 같은 방식으로 `.git/hooks/pre-push <원격 이름> <URL>`
# 을 직접 호출하고 표준 입력으로 `<로컬 ref> <로컬 SHA> <원격 ref> <원격 SHA>` 줄을 넘긴다. 원격 저장소는
# 만들지 않으며 URL은 쓰이지 않는 예약 도메인이다. 가짜 비밀은 실행할 때마다 무작위로 만든다.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pre_commit="${PRE_COMMIT:-pre-commit}"
if ! command -v "$pre_commit" >/dev/null 2>&1; then
  echo "!! pre-commit을 찾을 수 없습니다: $pre_commit (필수 도구 없음 → 실패)" >&2
  exit 1
fi
pre_commit="$(command -v "$pre_commit")"

work="$(mktemp -d)"
trap '[[ -n "${KEEP_LOGS:-}" && -d "${logs:-}" ]] && cp -R "$logs" "$KEEP_LOGS"; rm -rf -- "$work"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Sim GIT_AUTHOR_EMAIL=sim@example.com
export GIT_COMMITTER_NAME=Sim GIT_COMMITTER_EMAIL=sim@example.com
export PYTHONDONTWRITEBYTECODE=1

repo="$work/repo"
mkdir -p "$repo"
cp -R "$root/scripts" "$root/tests" "$root/.gitignore" "$root/.gitleaks.toml" "$root/.pre-commit-config.yaml" "$repo/"
cd "$repo"
git init -q -b master
git add . && git commit -qm "기준 커밋"
# pre-push 훅만 설치한다. 커밋 단계 훅이 없으므로 다른 PC나 웹 편집기에서 만든 커밋처럼
# 로컬 커밋 검사를 거치지 않은 이력이 생긴다(훅 우회와 같은 상태).
"$pre_commit" install --hook-type pre-push >/dev/null
test -x .git/hooks/pre-push || { echo "!! pre-push 훅이 설치되지 않음"; exit 1; }
test ! -e .git/hooks/pre-commit || { echo "!! 커밋 단계 훅이 설치되어 시나리오가 성립하지 않음"; exit 1; }

zero=0000000000000000000000000000000000000000
token="$(python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("ghp_"+"".join(secrets.choice(a) for _ in range(36)))')"
home_user="sim-user-$RANDOM"
home_path="/""home/$home_user/work"  # 리터럴로 쓰면 이 파일 자체가 검출된다
logs="$work/logs"
mkdir -p "$logs"
passed=0

# push_hook <로그 이름> [브랜치...] — 지정한 브랜치들을 새 원격 브랜치로 푸시하는 상황을 흉내 낸다.
push_hook() {
  local name="$1"; shift
  local refs=("$@")
  ((${#refs[@]})) || refs=(master)
  for ref in "${refs[@]}"; do
    printf 'refs/heads/%s %s refs/heads/%s %s\n' "$ref" "$(git rev-parse "$ref")" "$ref" "$zero"
  done | .git/hooks/pre-push origin https://example.invalid/geul.git >"$logs/$name.log" 2>&1
}

expect() { # expect <기대: pass|fail> <설명> <명령...>
  local want="$1" what="$2"; shift 2
  set +e; "$@"; local got=$?; set -e
  if [[ "$want" == pass && "$got" -ne 0 ]] || [[ "$want" == fail && "$got" -eq 0 ]]; then
    echo "!! [$what] 기대 $want, 실제 종료 코드 $got"
    cat "$logs"/*.log 2>/dev/null | tail -40
    exit 1
  fi
  echo "-- [$what] 종료 코드 $got (기대: $want)"
  passed=$((passed + 1))
}

echo "== 1. 깨끗한 저장소 → 통과"
expect pass "깨끗한 이력" push_hook clean

echo "== 2. 가짜 토큰을 커밋 → 차단"
printf 'token = "%s"\n' "$token" > config.toml
git add config.toml && git commit -qm "실수로 비밀 포함"
expect fail "비밀 커밋" push_hook leak
grep -E '\[(github-token|secret-assignment)\]' "$logs/leak.log" | head -3
grep -q 'RuleID:' "$logs/leak.log" || { echo "!! Gitleaks 이력 검사 결과가 로그에 없음"; exit 1; }

echo "== 3. 다음 커밋에서 삭제해도 푸시할 이력에는 남아 있음 → 차단"
git rm -q config.toml && git commit -qm "비밀 삭제"
expect fail "삭제 후 이력" push_hook deleted

echo "== 4. 이력에서 비밀 커밋 제거(공유 전 재작성) → 통과"
git reset -q --hard HEAD~2
git reflog expire --expire=now --all && git gc -q --prune=now
expect pass "이력 정리 후" push_hook rewritten

echo "== 5. 사용자 홈 경로가 든 이력 → 차단"
printf 'log = "%s/out.log"\n' "$home_path" > paths.toml
git add paths.toml && git commit -qm "경로 포함"
git rm -q paths.toml && git commit -qm "경로 삭제"
expect fail "홈 경로 이력" push_hook homepath
grep -q '\[home-path-unix\]' "$logs/homepath.log" || { echo "!! 홈 경로 검출 결과 없음"; exit 1; }
git reset -q --hard HEAD~2 && git reflog expire --expire=now --all && git gc -q --prune=now

echo "== 6. 푸시하지 않는 로컬 브랜치의 비밀도 차단(전체 이력 정책)"
git switch -qc experiment
printf 'token = "%s"\n' "$token" > exp.toml
git add exp.toml && git commit -qm "실험"
git switch -q master
expect fail "다른 로컬 브랜치" push_hook otherbranch master
git branch -qD experiment && git reflog expire --expire=now --all && git gc -q --prune=now

echo "== 7. 여러 ref를 함께 푸시할 때 두 번째 ref의 비밀 → 차단"
git switch -qc second
printf 'token = "%s"\n' "$token" > second.toml
git add second.toml && git commit -qm "두 번째 ref"
git switch -q master
git switch -qc first && git commit -q --allow-empty -m "첫 번째 ref" && git switch -q master
expect fail "여러 ref" push_hook multiref first second
git branch -qD first second && git reflog expire --expire=now --all && git gc -q --prune=now

echo "== 8. 필수 검사 도구(python3)를 실행할 수 없음 → 차단"
bin="$work/bin"
mkdir -p "$bin"
ln -s "$(command -v git)" "$bin/git"
ln -s "$(command -v bash)" "$bin/bash"
ln -s "$(command -v dirname)" "$bin/dirname"
expect fail "python3 없음" env PATH="$bin" bash -c "$(declare -f push_hook); zero=$zero logs=$logs push_hook notool"
grep -qi 'python3' "$logs/notool.log" || { echo "!! 도구 누락 원인이 로그에 없음"; exit 1; }

echo "== 9. CI 공용 스크립트: gitleaks 없음 → 실패"
expect fail "gitleaks 없음" env GITLEAKS="$work/no-such-gitleaks" bash -c '"$1" . >"$2" 2>&1' _ \
  "$root/scripts/security-scan-ci.sh" "$logs/ci-nogitleaks.log"
grep -q 'gitleaks 실행 파일을 찾을 수 없습니다' "$logs/ci-nogitleaks.log"

echo "== 10. 깨끗한 이력은 계속 통과"
expect pass "최종 깨끗한 이력" push_hook final

if grep -rqF "$token" "$logs"; then echo "!! 비밀 원문이 로그에 노출됨"; exit 1; fi
if grep -rqF "$home_user" "$logs"; then echo "!! 홈 경로 사용자 이름이 로그에 노출됨"; exit 1; fi
echo "-- 로그에 비밀 원문·사용자 이름 없음"
echo
echo "pre-push 훅 검증 완료: $passed개 시나리오 통과"
