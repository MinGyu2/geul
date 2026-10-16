# 공개 저장소 보안 정책

관련 요구사항: FR-013, FR-014, SC-007, SC-008 ([spec](../planning/spec.md)). 사고 대응 절차는
[security-incident.md](security-incident.md)에 있습니다.

## 1. 원칙

- 이 저장소는 공개를 전제로 합니다. 한 번 푸시된 내용은 삭제해도 복제·캐시·포크에 남을 수 있습니다.
- 검사는 여러 단계에서 겹쳐 수행합니다. 각 단계는 다른 단계를 대신하지 않습니다.
- 검사 규칙을 끄거나 `--no-verify`로 훅을 건너뛰어 실패를 해결하지 않습니다.
- 문서에는 프로젝트 상대 경로(`docs/planning/plan.md`, `external/rhwp/`, `src-tauri/src/`)를 씁니다.
  사용자 홈 경로 예시가 필요하면 `/home/<USER>/`, `C:\Users\<USER>\`처럼 자리표시자를 씁니다.
- `.gitignore`는 파일 내용을 검사하지 않으며, 이미 추적 중인 파일이나 Git 이력의 비밀을 지우지 않습니다.

## 2. 검사 단계

| 단계 | 시점 | 도구 | 대상 | 우회 가능성 |
|------|------|------|------|-------------|
| 1 | 커밋 전 (`pre-commit` 훅) | `scripts/check-sensitive-info.py --staged`, Gitleaks `git --pre-commit --staged` | 스테이징된 내용 | 훅 미설치, `--no-verify`로 우회 가능 |
| 2 | 푸시 전 (`pre-push` 훅) | `scripts/check-sensitive-info.py --all` | 추적 중인 전체 파일 | 훅 미설치, `--no-verify`로 우회 가능 |
| 3 | push / pull request (CI) | `.github/workflows/security-scan.yml` → `scripts/security-scan-ci.sh` | 검사기 테스트, 추적 파일 전체, 전체 이력(자체 검사기 + Gitleaks) | 필수 상태 검사로 지정하지 않으면 병합을 막지 못함. 이미 푸시된 내용은 되돌리지 못함 |
| 4 | 최초 공개 전 (수동) | 아래 4절 체크리스트 | 전체 파일과 모든 ref의 이력 | — |

검사기(`scripts/check-sensitive-info.py`)가 찾는 항목:

- 비밀값: 개인 키 블록, AWS/GitHub/GitLab/Slack/Google/npm/Stripe 토큰, `sk-` 형식 AI 서비스 키,
  JWT, URL 안의 인증정보, `password = ...` 같은 비밀값 할당
- 사용자 홈 절대 경로: `/home/<이름>/`, `/Users/<이름>/`, `C:\Users\<이름>\`
  (자리표시자, `Public`·`Default`·`Shared`, CI 러너 `runner`는 허용)
- 내부 주소: `*.internal`, `*.corp`, `*.intranet`, `*.lan`, `*.local` URL, 사설 IP(10/8, 172.16/12, 192.168/16)
- 개인정보 검토 대상: 주민등록번호 형식, 휴대전화 번호, 이메일 주소(`example.com`, `noreply` 계열 제외)
- 민감한 파일 이름: `.env`, `.env.*`(`.example` 제외), `*.pem`, `*.key`, `*.p12`, `*.pfx`, SSH 개인 키 등

출력은 `파일:줄: [규칙] 설명: 앞4자***뒤2자 (len=N)` 형식이며 원문을 출력하지 않습니다.
종료 코드는 0(통과), 1(발견), 2(실행 오류)입니다. Gitleaks는 `--redact`로 실행합니다.
Git submodule(`external/*`) 내용은 상위 저장소 검사 대상이 아니며, 업스트림 검토
([docs/upstream/](../upstream/))에서 별도로 다룹니다.

## 3. 개발 환경 설정

```sh
# pre-commit 설치 (택1)
uv tool install pre-commit
pipx install pre-commit

pre-commit install            # pre-commit, pre-push 훅이 함께 설치된다
pre-commit run --all-files    # 설치 직후 1회 실행. Gitleaks 훅은 처음에 Go 도구 체인을 내려받아 빌드한다
```

설정 파일만으로는 훅이 동작하지 않습니다. `.git/hooks/pre-commit`과 `.git/hooks/pre-push`가 생성되었는지
확인하세요. Gitleaks를 직접 실행하려면 릴리스 바이너리의 SHA-256을 확인한 뒤 사용합니다
(CI와 같은 버전: 8.30.1).

## 4. 최초 공개 전 체크리스트

공개(첫 푸시 또는 저장소 공개 전환) 전에 다음을 모두 수행하고 결과를 남깁니다.

1. 작업 트리가 깨끗한지 확인: `git status --short --untracked-files=all`
2. 검사기 테스트: `python3 -m unittest discover -s tests/security -v`
3. 추적 파일 전체: `python3 scripts/check-sensitive-info.py --all`
4. 전체 이력(모든 브랜치·태그): `python3 scripts/check-sensitive-info.py --history`
5. Gitleaks 전체 이력: `gitleaks git --redact --verbose .`
6. CI와 같은 묶음 실행: `scripts/security-scan-ci.sh .`
7. 커밋 작성자 이메일 확인: `git log --all --format='%an <%ae>' | sort -u`
   (공개를 원하지 않으면 GitHub `noreply` 주소 사용을 검토)
8. 공개 대상이 아닌 브랜치·태그가 함께 푸시되지 않도록 푸시할 ref를 명시합니다.
9. 하나라도 발견되면 공개를 중단하고 [security-incident.md](security-incident.md)를 따릅니다.

## 5. 원격 저장소 설정 (공개 후 1회, 저장소 관리자)

이 항목은 원격 설정이므로 로컬 작업에서 검증할 수 없습니다. 적용 여부는 tasks.md T019의 남은 항목으로 확인합니다.

- 기본 브랜치(`main`) 보호 규칙 또는 ruleset:
  - 병합 전 PR 필수, 강제 푸시 금지, 브랜치 삭제 금지
  - 필수 상태 검사: `security-scan / 민감정보 검사` (워크플로가 한 번 실행된 뒤 선택 가능)
  - 관리자에게도 규칙 적용
- GitHub Secret scanning 및 push protection 활성화(공개 저장소에서 사용 가능)
- Actions 기본 `GITHUB_TOKEN` 권한을 읽기 전용으로 설정

## 6. 오탐 예외 절차

예외는 검토를 거친 경우에만 추가하며, 규칙 자체를 끄지 않습니다.

1. 정말 오탐인지 확인합니다. 테스트용 가짜 비밀은 파일에 원문으로 쓰지 말고 실행 시점에 조립합니다
   (`tests/security/test_check_sensitive_info.py` 참고).
2. 가장 좁은 범위로 예외를 둡니다.
   - 같은 줄 주석: `sensitive-info: allow <rule-id> -- <사유>` — 규칙 ID와 사유가 모두 있어야 하며,
     사유 없는 주석은 무시되고 경고가 출력됩니다.
   - JSON처럼 주석을 쓸 수 없는 파일: 저장소 루트 `.sensitive-info-allowlist`에
     `<rule-id> <경로 glob> -- <사유>` 한 줄씩 추가합니다.
   - Gitleaks: `.gitleaks.toml`의 `[[allowlists]]`에 `description`과 좁은 `paths`/`regexes`를 함께 적습니다.
3. 예외 추가는 별도 커밋으로 하고 PR 설명에 근거를 남깁니다. 리뷰어는 예외 범위가 넓지 않은지 확인합니다.
