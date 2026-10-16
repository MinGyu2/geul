# 공개 저장소 보안 정책

관련 요구사항: FR-013, FR-014, SC-007, SC-008 ([spec](../planning/spec.md)). 사고 대응 절차는
[security-incident.md](security-incident.md)에 있습니다.

## 1. 원칙

- 이 저장소는 공개 저장소입니다(2026-10-16 확인: `MinGyu2/geul`, public). 한 번 푸시된 내용은 삭제해도
  복제·캐시·포크에 남을 수 있습니다.
- 검사는 여러 단계에서 겹쳐 수행합니다. 각 단계는 다른 단계를 대신하지 않습니다.
- 검사 규칙을 끄거나 `--no-verify`로 훅을 건너뛰어 실패를 해결하지 않습니다.
- 검사하지 못한 내용(읽기 실패, 크기 한도 초과, 해석할 수 없는 바이너리)은 통과로 보지 않습니다.
- 문서에는 프로젝트 상대 경로(`docs/planning/plan.md`, `external/rhwp/`, `src-tauri/src/`)를 씁니다.
  사용자 홈 경로 예시가 필요하면 `/home/<USER>/`, `C:\Users\<USER>\`처럼 자리표시자를 씁니다.
- `.gitignore`는 파일 내용을 검사하지 않으며, 이미 추적 중인 파일이나 Git 이력의 비밀을 지우지 않습니다.

## 2. 검사 단계

| 단계 | 시점 | 도구 | 대상 | 우회 가능성 |
|------|------|------|------|-------------|
| 1 | 커밋 전 (`pre-commit` 훅) | `check-sensitive-info.py --staged`, Gitleaks `git --pre-commit --staged` | 스테이징된 내용(인덱스) | 훅 미설치, `--no-verify`로 우회 가능 |
| 2 | 푸시 전 (`pre-push` 훅) | `check-sensitive-info.py --all`, `--history`, Gitleaks `git`(전체 이력) | 추적 파일 + 모든 ref의 전체 이력 | 훅 미설치, `--no-verify`로 우회 가능 |
| 3 | push / pull request (CI) | `.github/workflows/security-scan.yml` → `scripts/security-scan-ci.sh` | 검사기 테스트, 추적 파일 전체, 전체 이력(자체 검사기 + Gitleaks) | 필수 상태 검사로 지정하지 않으면 병합을 막지 못함. 이미 푸시된 내용은 되돌리지 못함 |
| 4 | 최초 공개 전·정기 점검 (수동) | 아래 4절 체크리스트 | 전체 파일과 모든 ref의 이력 | — |

### 푸시 전 검사 범위

pre-push 단계는 푸시하는 커밋 범위만이 아니라 **모든 ref의 전체 이력**을 검사합니다.

- pre-commit 프레임워크는 여러 ref를 한 번에 푸시할 때 첫 번째 ref의 범위만 계산합니다. 범위 기반 검사는
  함께 푸시되는 다른 ref의 이력을 놓칠 수 있습니다.
- 나중 커밋에서 비밀을 지워도 그 이전 커밋은 함께 전송됩니다. 현재 파일만 검사하면 이를 놓칩니다.
- 그 대가로 푸시하지 않는 로컬 브랜치나 stash에 남은 비밀도 푸시를 막습니다. 해당 커밋을 정리한 뒤 푸시합니다.
- 회귀 검증: `tests/security/test-pre-push-hook.sh`(아래 3절).

### 검사기가 찾는 항목 (`scripts/check-sensitive-info.py`)

- 비밀값: 개인 키 블록, AWS/GitHub/GitLab/Slack/Google/npm/Stripe 토큰, `sk-` 형식 AI 서비스 키,
  JWT, URL 안의 인증정보, `password = ...` 같은 비밀값 할당
- 사용자 홈 절대 경로: `/home/<이름>/`, `/var/home/<이름>/`, `/Users/<이름>/`, `/mnt/<드라이브>/Users/<이름>/`,
  `C:\Users\<이름>\` (자리표시자, `Public`·`Default`·`Shared`, CI 러너 `runner`는 허용)
- 내부 주소: `*.internal`, `*.corp`, `*.intranet`, `*.lan`, `*.local` URL, 사설 IP(10/8, 172.16/12, 192.168/16)
- 개인정보 검토 대상: 주민등록번호 형식, 휴대전화 번호, 이메일 주소
  (허용: `example.com`/`.org`/`.net`과 그 하위 도메인, `users.noreply.github.com`, 로컬 부분이 정확히
  `noreply`·`no-reply`·`git`인 주소. 도메인은 정확히 일치하거나 `.`으로 끊긴 하위 도메인만 허용합니다)
- 민감한 파일 이름: `.env`, `.env.*`(`.example` 제외), `*.pem`, `*.key`, `*.p12`, `*.pfx`, SSH 개인 키 등
- 문서 메타데이터: ZIP 기반 문서 안의 작성자·마지막 수정자·회사(`dc:creator`, `cp:lastModifiedBy`,
  `Company`, HWPX `opf:meta name="creator"` 등)

비밀값 할당 규칙의 자리표시자 처리:

- 값 전체가 명시적 자리표시자일 때만 통과합니다: `${NAME}`, `$NAME`, `%NAME%`, `${{ ... }}`, `{{ ... }}`,
  `$(...)`, `<YOUR_KEY>`, `********`, `changeme`, `placeholder`, `your_...` 등.
  `${NAME:-기본값}`처럼 리터럴을 담는 문법은 통과시키지 않습니다.
- 따옴표 안의 값은 위 형식이 아니면 항상 비밀 후보입니다(글자만으로 되었거나 짧아도 마찬가지).
- 따옴표 없는 값은 파일 종류에 따라 다릅니다. 코드 파일(`.py`, `.ts`, `.rs` 등)의 변수·속성·타입 참조
  (`config.api_key`, `os.environ[...]`, `DB_PASSWORD`, `PasswordType`)와 문서 파일(`.md` 등)의 점 표기·호출
  식은 참조로 봅니다. 데이터 파일(YAML, TOML, INI, JSON, `.env`, 셸 스크립트 등)의 따옴표 없는 값은 리터럴입니다.
- 검출 하한: 따옴표 안 6자, 따옴표 없는 값 8자. 공백이 든 따옴표 값(문장, 번역 문자열)은 이 규칙의
  대상이 아닙니다. 따라서 공백이 든 암호 문구는 이 규칙으로 찾지 못합니다(알려진 한계).

### 내용 검사 방식과 한계

- 텍스트는 크기와 관계없이 1 MiB 단위로 스트리밍해 끝까지 검사합니다(긴 줄은 4 KiB씩 겹치는 구간으로
  나누어 검사). 256 MiB를 넘는 텍스트는 `uninspected-content`로 보고하고 실패합니다.
- 지원하는 텍스트 인코딩은 UTF-8, UTF-8 BOM, BOM이 있는 UTF-16입니다. UTF-16 BOM이 있는 파일은 UTF-16과
  UTF-8로 모두 검사합니다.
- 바이너리 판정은 첫 8 KiB만 보지 않고 내용 전체를 64 KiB 구간으로 나눠 봅니다. UTF-8 텍스트에 NUL이 있거나,
  한 구간에서 잘못된 인코딩·제어 문자(탭·줄바꿈·CR·VT·FF·ESC 제외)가 10%를 넘거나(최소 8개), 파일 전체에서
  1%를 넘으면 `uninspected-binary`로 실패합니다. 텍스트 앞부분 뒤에 붙은 바이너리도 이렇게 찾습니다.
- 그보다 적은 잘못된 바이트는 대체 문자로 바꿔 계속 검사하고 경고로 개수를 알립니다(조용히 버리지 않음).
  CP949/EUC-KR 같은 레거시 인코딩 텍스트는 대부분 바이너리로 판정되므로 UTF-8로 바꿔 커밋합니다.
- ZIP 기반 문서(DOCX, HWPX 등)는 디스크에 풀지 않고 메모리/임시 버퍼에서 텍스트 항목을 검사합니다.
  한도: 압축 파일 64 MiB, 항목 4096개, 항목당 64 MiB, 합계 256 MiB. 실제로 읽은 크기가 선언된 크기를
  넘으면(압축 폭탄 등) 중단합니다. 절대 경로·`..`·역슬래시가 든 항목 이름은 `archive-unsafe-path`로 보고합니다.
- 다음은 내용을 검사하지 못하므로 `uninspected-binary`로 보고하고 실패합니다. 직접 검토한 파일만 예외
  목록에 사유와 함께 등록합니다.
  - 바이너리 HWP(OLE 복합 문서), 이미지, 글꼴 등 그 밖의 바이너리
  - ZIP 안의 이미지·OLE 개체 같은 바이너리 항목, 암호화 항목, 한도를 넘는 항목, 손상된 ZIP
- 검사기는 압축된 문서 본문이 여러 XML 요소로 나뉜 경우 비밀을 놓칠 수 있습니다. 문서 픽스처는
  [tests/fixtures/README.md](../../tests/fixtures/README.md)의 수동 검토 절차도 함께 따릅니다.
- 읽기 실패, Git 오류, 예외 목록 오류는 종료 코드 2로 끝나며 통과로 표시하지 않습니다.
- `--all`에서 추적 중인(인덱스에 있는) 파일이 작업 트리에 없으면 검사를 끝내지 못한 것으로 보고 종료 코드 2를
  반환합니다. 삭제가 의도였다면 `git rm`으로 스테이징합니다(스테이징한 삭제는 추적 목록에서 빠지므로 통과).
  심볼릭 링크는 Git이 저장하는 대로 링크 대상 문자열을 검사하며, 대상이 없어도(깨진 링크) 검사할 수 있습니다.
- 파일 경로와 ZIP 항목 이름도 같은 규칙으로 검사합니다(`…(이름)` 규칙으로 보고). 이름 안의 예외 주석은 인정하지 않습니다.

출력은 `파일:줄: [규칙] 설명: 마스킹된 값 (len=N)` 형식이며 원문을 출력하지 않습니다. 20자 이상은 앞 4자와
뒤 2자, 12~19자는 앞 2자만 보이고, 12자 미만은 글자를 보여 주지 않습니다.
모든 출력(발견 항목, 경고, 오류)은 한 출구 함수를 거칩니다. 경로·ZIP 항목 이름·Git 오류 메시지에 든 비밀·홈 경로·
이메일은 `<…>`로 가려지고, 줄바꿈·CR·ESC·방향 제어 문자 등은 `\uXXXX`로 이스케이프되어 가짜 로그 줄을
만들 수 없습니다. 한 줄은 400자에서 자릅니다. 종료 코드는 0(통과), 1(발견),
2(실행 오류·검사 불완전)입니다. Gitleaks는 `--redact`로 실행합니다.
Git submodule(`external/*`) 내용은 상위 저장소 검사 대상이 아니며, 업스트림 검토
([docs/upstream/](../upstream/))에서 별도로 다룹니다.

## 3. 개발 환경 설정

```sh
# pre-commit 설치 (택1)
uv tool install pre-commit
pipx install pre-commit

pre-commit install            # pre-commit, pre-push 훅이 함께 설치된다
pre-commit run --all-files    # 설치 직후 1회 실행. Gitleaks 훅은 처음에 Go 도구 체인을 내려받아 빌드한다
pre-commit run --hook-stage pre-push --all-files   # 푸시 전 검사를 미리 실행
```

설정 파일만으로는 훅이 동작하지 않습니다. `.git/hooks/pre-commit`과 `.git/hooks/pre-push`가 생성되었는지
확인하세요. Gitleaks를 직접 실행하려면 릴리스 바이너리의 SHA-256을 확인한 뒤 사용합니다
(CI와 같은 버전: 8.30.1).

보안 검사 회귀 테스트:

```sh
python3 -m unittest discover -s tests/security -v       # 검사기 단위 테스트
GITLEAKS=<gitleaks 경로> tests/security/simulate-leak-response.sh   # 훅 우회 → CI 차단 → 이력 정리
PRE_COMMIT=<pre-commit 경로> GITLEAKS=<gitleaks 경로> tests/security/test-pre-push-hook.sh  # 실제 pre-push 훅
```

`test-pre-push-hook.sh`는 `git push`를 실행하지 않습니다. 임시 저장소에 훅을 설치한 뒤 Git이 푸시할 때와
같은 인자와 표준 입력으로 `.git/hooks/pre-push`를 직접 호출합니다.

## 4. 최초 공개 전·정기 점검 체크리스트

공개(첫 푸시 또는 저장소 공개 전환) 전과 보안 규칙을 바꾼 뒤에는 다음을 모두 수행하고 결과를 남깁니다.

1. 작업 트리가 깨끗한지 확인: `git status --short --untracked-files=all`
2. 검사기 테스트: `python3 -m unittest discover -s tests/security -v`
3. 추적 파일 전체: `python3 scripts/check-sensitive-info.py --all`
4. 전체 이력(모든 브랜치·태그): `python3 scripts/check-sensitive-info.py --history`
5. Gitleaks 전체 이력: `gitleaks git --redact --verbose .`
6. CI와 같은 묶음 실행: `scripts/security-scan-ci.sh .`
7. 커밋 작성자·커미터 메타데이터 확인: `git log --all --format='%an <%ae> / %cn <%ce>' | sort -u`
   - 커밋 메타데이터(이름·이메일·시각·시간대)는 내용 검사 대상이 아니며 푸시하면 공개됩니다.
   - 공개를 원하지 않으면 커밋 전에 GitHub `noreply` 주소(`<ID>+<사용자>@users.noreply.github.com`)를
     저장소 로컬 설정으로 지정하고, GitHub의 "Block command line pushes that expose my email"을 검토합니다.
   - 이미 푸시된 커밋의 메타데이터를 바꾸려면 이력 재작성이 필요하므로 관리자가 결정합니다.
8. 공개 대상이 아닌 브랜치·태그가 함께 푸시되지 않도록 푸시할 ref를 명시합니다.
9. 하나라도 발견되면 공개를 중단하고 [security-incident.md](security-incident.md)를 따릅니다.

## 5. 원격 저장소 설정 (저장소 관리자)

이 항목은 원격 설정이므로 로컬 작업에서 변경하거나 검증할 수 없습니다. 적용 여부는 tasks.md T019의
원격 공개 게이트 항목으로 확인합니다.

### 현재 상태 (2026-10-16, GitHub 공개 API 읽기 전용 조회)

| 항목 | 상태 |
|------|------|
| 저장소 공개 여부 | public |
| 기본 브랜치 | `master` (`GET /repos/MinGyu2/geul` → `default_branch`) |
| 원격 `master` | `455c985` |
| 브랜치 보호 | 없음 (`GET /repos/MinGyu2/geul/branches/master` → `protected: false`) |
| 저장소 ruleset | 없음 (`GET .../rulesets`, `GET .../rules/branches/master` → `[]`) |
| `security-scan` 실행 | 커밋 `455c985` push 이벤트 1회, 성공 (check run 이름 `민감정보 검사`) |

기본 브랜치 이름은 바뀔 수 있으므로 설정 전에 다시 확인합니다:
`git ls-remote --symref origin HEAD` 또는 `gh repo view --json defaultBranchRef`.

### 관리자 작업 체크리스트

1. 기본 브랜치(현재 `master`)에 ruleset 또는 브랜치 보호 규칙을 만듭니다.
   - 병합 전 pull request 필수
   - 필수 상태 검사: `민감정보 검사` (GitHub Actions, 워크플로 `security-scan`의 job 이름)
   - 병합 전 브랜치 최신화 요구(Require branches to be up to date)
   - 강제 푸시 금지, 브랜치 삭제 금지
   - 관리자 우회 허용 안 함(bypass 목록 비움)
2. Settings → Code security에서 Secret scanning과 Push protection을 켭니다(공개 저장소에서 사용 가능).
3. Settings → Actions → General에서 Workflow permissions를 "Read repository contents"로 둡니다.
4. 적용 후 확인(읽기 전용):
   - `GET /repos/MinGyu2/geul/rules/branches/master`에 `pull_request`, `required_status_checks`
     (`민감정보 검사`), `non_fast_forward`, `deletion` 규칙이 보이는지
   - 테스트 브랜치에서 가짜 비밀을 담은 PR을 열어 `민감정보 검사`가 실패하고 병합 버튼이 막히는지
     (가짜 비밀은 `tests/security/simulate-leak-response.sh`처럼 실행 시 무작위로 만든 값을 사용하고,
     확인 후 브랜치를 삭제합니다)
5. 결과를 tasks.md T019 검증 기록에 남깁니다.

## 6. 오탐 예외 절차

예외는 검토를 거친 경우에만 추가하며, 규칙 자체를 끄지 않습니다.

1. 정말 오탐인지 확인합니다. 테스트용 가짜 비밀은 파일에 원문으로 쓰지 말고 실행 시점에 조립합니다
   (`tests/security/test_check_sensitive_info.py` 참고).
2. 가장 좁은 범위로 예외를 둡니다.
   - 같은 줄 주석: `sensitive-info: allow <rule-id> -- <사유>` — 규칙 ID와 4자 이상의 사유가 모두 있어야
     하며, 사유 없는 주석은 무시되고 경고가 출력됩니다.
   - 주석을 쓸 수 없는 파일(JSON, 바이너리 등): 저장소 루트 `.sensitive-info-allowlist`에
     `<rule-id> <경로 glob> [sha256=<64자리 16진수>] -- <사유>` 한 줄씩 추가합니다.
     - 내용을 검사하지 못하는 규칙(`uninspected-binary`, `uninspected-content`, `document-metadata`,
       `archive-unsafe-path`)의 예외는 **와일드카드 없는 정확한 경로와 검토한 내용의 sha256**이 있어야 합니다.
       내용이 한 바이트라도 바뀌거나 다른 경로로 옮기면 예외가 맞지 않아 다시 실패합니다.
       sha256은 검사 대상과 같은 내용으로 계산합니다: `--staged`는 인덱스, `--all`은 작업 트리, `--history`는
       각 이력 버전. 이력의 예전 버전도 승인하려면 그 버전의 sha256 줄을 따로 둡니다.
     - 해시 계산: `git show :<경로> | sha256sum`(스테이징한 내용) 또는 `git show HEAD:<경로> | sha256sum`.
     - 규칙 ID는 검사기가 아는 ID여야 합니다(`uninspected-binary`, `document-metadata` 포함).
     - glob은 저장소 상대 경로이며 첫 경로 요소에 와일드카드를 쓸 수 없습니다(`*`, `**/*`, `*.md` 거부,
       `src-tauri/icons/*.png` 허용). 절대 경로와 `..`도 거부합니다.
     - 형식 오류·사유 누락·알 수 없는 규칙·넓은 glob은 종료 코드 2로 검사를 실패시킵니다.
   - Gitleaks: `.gitleaks.toml`의 `[[allowlists]]`에 `description`과 좁은 `paths`/`regexes`를 함께 적습니다.
3. 예외 목록은 검사 대상과 같은 스냅샷에서 읽습니다.
   - `--staged`: 스테이징된 `.sensitive-info-allowlist`만 사용합니다. 작업 트리에서만 바꾼 예외는 반영되지 않습니다.
   - `--all`, 경로 지정: Git이 추적하는 경우에만 작업 트리 버전을 사용합니다.
   - `--history`, CI: `HEAD`에 커밋된 버전을 사용합니다. 예외를 지우는 커밋을 하면 과거 커밋의 해당 내용도
     다시 보고됩니다.
4. 예외 추가는 별도 커밋으로 하고 PR 설명에 근거를 남깁니다. 리뷰어는 예외 범위가 넓지 않은지 확인합니다.
