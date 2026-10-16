# Tasks: HWP/HWPX + DOCX 통합 편집기

Input: [spec.md](./spec.md), [plan.md](./plan.md).

## Execution Context
Implementation model: Not specified
Reasoning effort: Not specified
Profile: balanced
Selection basis: uncalibrated default
Repository context: 2026-10-16 실제 저장소 검사 완료(초기 상태: `docs/planning/`만 존재). 공개 저장소 `MinGyu2/geul`, 기본 브랜치 `master`. Phase 1 경로는 실제 파일, Phase 2 이후 경로는 제안(구현된 작업은 검증 기록 참고).

## Phase 1: Setup
- [x] T017 실제 저장소 초기화·두 submodule 등록·고정 버전·기준본 확인 — `README.md`
- [x] T018 변경 파일/민감 홈 경로/테스트 토큰 차단 규칙 작성 및 fixture 검사 — `scripts/check-sensitive-info.py`
- [ ] T019 PR CI와 최초 공개 전체 스캔/기록 점검 정책 추가 — `.github/workflows/security-scan.yml` (부분 완료: 로컬 게이트 완료, 원격 공개 게이트 대기 — 아래 검증 기록 참고)
- [x] T020 Git 훅 우회/이력 노출/유출 시 키 폐기와 복구 절차 문서화 — `docs/development/security-incident.md`
- [x] T001 WordCraft 공개 API/렌더 계층/NOTICE/고정 커밋 검토 — `docs/upstream/wordcraft.md`
- [x] T002 rhwp HWP/HWPX 저장/렌더/입력 API와 라이선스 검토 — `docs/upstream/rhwp.md`
- [x] T003 엔진별 편집 표면/IME/렌더 경계와 PoC 중단 조건 명시 — `docs/architecture/editor-surface-decision.md`

## Phase 2: User Story 1 - 기본 UI와 다국어 (Priority: P1)
Independent Test: 해당 User Story의 acceptance scenario와 실패 조건을 실제 실행으로 확인한다.
- [x] T004 [US1] Tauri/React 6영역 화면과 패널 인터랙션 구축 — `src/App.tsx`
- [ ] T005 [US1] 번역 JSON·fallback·설정 복원 추가 — `src/language/`

## Phase 3: User Story 2 - 문서 기본 편집 (Priority: P1)
Independent Test: 해당 User Story의 acceptance scenario와 실패 조건을 실제 실행으로 확인한다.
- [ ] T006 [US2] 문서 형식 라우팅·세션/어댑터 계약과 포맷 판별 구현 — `src/adapters/`
- [ ] T007 [US2] rhwp HWP/HWPX 중앙 편집 PoC 구현 — `src/components/Editor/`
- [ ] T008 [US2] WordCraft DOCX 중앙 편집 PoC 구현 — `src-tauri/src/adapters/`
- [ ] T009 [US2] 포맷별 저장·재열기, 안전 저장 범위와 보존 검사 — `src-tauri/src/services/`

## Phase 4: User Story 3 - 공통 명령 및 리본 (Priority: P1)
Independent Test: 해당 User Story의 acceptance scenario와 실패 조건을 실제 실행으로 확인한다.
- [ ] T010 [US3] 공통 명령 레지스트리/비활성화·Undo 연결 — `src/commands/`
- [ ] T011 [US3] 공통 리본과 상황별 도구 연결 — `src/ribbon/`

## Phase 5: User Story 4 - 고급 기능 (Priority: P2)
Independent Test: 해당 User Story의 acceptance scenario와 실패 조건을 실제 실행으로 확인한다.
- [ ] T012 [US4] 검증된 한글 전용 명령 연결 — `src/ribbon/HangulTools/`
- [ ] T013 [US4] 검증된 DOCX 고급 명령 연결 — `src/ribbon/References/`

## Phase 6: User Story 5 - 데이터 보존 및 출시 (Priority: P1)
Independent Test: 해당 User Story의 acceptance scenario와 실패 조건을 실제 실행으로 확인한다.
- [ ] T014 [US5] 충돌 감지·안전한 임시 파일·복구 구현 — `src-tauri/src/services/`
- [ ] T015 [US5] 형식·서식별 왕복 검사와 회귀 매트릭스 — `tests/roundtrip/`
- [ ] T016 [US5] 세 OS 빌드·실행·PDF/라이선스 고지/공개 보안 검증 — `src-tauri/tauri.conf.json`

## Task Contracts

| Task | Depends on | Requirements | Files | Verify | Done |
|------|------------|--------------|-------|--------|------|
| T017 | None | FR-003, FR-012, SC-006 | README.md, external/README.md, docs/planning/ | git submodule status, git ls-tree로 gitlink 확인 | git submodule status, git ls-tree로 gitlink 확인 성공 및 근거 기록 |
| T018 | T017 | FR-013, SC-007 | scripts/check-sensitive-info.py, .gitleaks.toml, .pre-commit-config.yaml | 검사용 가짜 경로와 토큰에서 실패, 정상 상대 경로 통과 | 검사용 가짜 경로와 토큰에서 실패, 정상 상대 경로 통과 성공 및 근거 기록 |
| T019 | T018 | FR-013, FR-014, SC-008 | .github/workflows/security-scan.yml, docs/development/security-policy.md, .pre-commit-config.yaml, tests/security/ | 시뮬레이션 PR 검사 실패·브랜치 보호 설정 확인 — 로컬 게이트(L): pre-push 전체 이력 검사·CI 스크립트·시뮬레이션 PR 실패를 로컬에서 확인; 원격 공개 게이트(R): GitHub Actions 실행, 기본 브랜치 보호/ruleset과 필수 상태 검사 확인 | 시뮬레이션 PR 검사 실패·브랜치 보호 설정 확인 성공 및 근거 기록 (L과 R 모두 충족해야 완료) |
| T020 | T018, T019(L) | FR-014, SC-008 | docs/development/security-incident.md, scripts/check-sensitive-info.py | 테스트 저장소에서 실패 사례 시뮬레이션하고 기록 | 테스트 저장소에서 실패 사례 시뮬레이션하고 기록 성공 및 근거 기록 |
| T001 | T017 | FR-003 | docs/upstream/wordcraft.md, docs/licenses/wordcraft.md | 모듈·라이선스·기여자 고지 및 API 후보 표 | 모듈·라이선스·기여자 고지 및 API 후보 표 성공 및 근거 기록 |
| T002 | T017 | FR-003 | docs/upstream/rhwp.md, docs/licenses/rhwp.md | HWP·HWPX 읽기 및 쓰기 지원 수준 구분 | HWP·HWPX 읽기 및 쓰기 지원 수준 구분 성공 및 근거 기록 |
| T003 | T001, T002 | FR-005 | docs/architecture/editor-surface-decision.md, tests/fixtures/README.md | 별도 PoC 실행 경로와 테스트 데이터 확정 | 별도 PoC 실행 경로와 테스트 데이터 확정 성공 및 근거 기록 |
| T004 | T003, T019(L) | FR-001, SC-001 | src/App.tsx, src/components/ | 앱 실행 및 6영역/패널 UI 검사 | 앱 실행 및 6영역/패널 UI 검사 성공 및 근거 기록 |
| T005 | T004 | FR-002, SC-001 | src/language/, src/settings/ | 누락 번역과 언어 변경·복원 테스트 | 누락 번역과 언어 변경·복원 테스트 성공 및 근거 기록 |
| T006 | T003, T004 | FR-004 | src/adapters/, src-tauri/src/document/ | 잘못된 확장자/헤더 및 세션 분리 테스트 | 잘못된 확장자/헤더 및 세션 분리 테스트 성공 및 근거 기록 |
| T007 | T006 | FR-005, SC-002 | src/components/Editor/, tests/integration/rhwp/ | IME/커서/선택 및 렌더링 실측 기록 | IME/커서/선택 및 렌더링 실측 기록 성공 및 근거 기록 |
| T008 | T006 | FR-005, SC-002 | src-tauri/src/adapters/, tests/integration/wordcraft/ | IME/커서/선택 및 egui/WebView 연동 결과 기록 | IME/커서/선택 및 egui/WebView 연동 결과 기록 성공 및 근거 기록 |
| T009 | T007, T008 | FR-006, FR-015, SC-002 | src-tauri/src/services/, tests/roundtrip/ | 실제 문서 왕복 및 안전한 저장 거절 테스트 | 실제 문서 왕복 및 안전한 저장 거절 테스트 성공 및 근거 기록 |
| T010 | T009, T005 | FR-007, SC-003 | src/commands/, tests/ui/ | 두 엔진 명령 및 미지원 명령 테스트 | 두 엔진 명령 및 미지원 명령 테스트 성공 및 근거 기록 |
| T011 | T010 | FR-008, FR-015, SC-003 | src/ribbon/, src/components/Ribbon/ | 문서 형식·선택별 가용성 확인 | 문서 형식·선택별 가용성 확인 성공 및 근거 기록 |
| T012 | T011 | FR-009 | src/ribbon/HangulTools/, tests/integration/hangul/ | 장평/자간/표 등의 실제 API 지원 결과 기록 | 장평/자간/표 등의 실제 API 지원 결과 기록 성공 및 근거 기록 |
| T013 | T011 | FR-009 | src/ribbon/References/, tests/integration/docx-advanced/ | 참조·검토 등의 실제 지원 결과 기록 | 참조·검토 등의 실제 지원 결과 기록 성공 및 근거 기록 |
| T014 | T009 | FR-006, FR-010, SC-004 | src-tauri/src/services/, tests/integration/save-failure/ | 쓰기 실패와 외부 수정에도 원본 불변 확인 | 쓰기 실패와 외부 수정에도 원본 불변 확인 성공 및 근거 기록 |
| T015 | T012, T013, T014 | FR-011, SC-002, SC-004 | tests/roundtrip/, docs/quality-matrix.md | 텍스트/표/그림/수식/폰트 테스트 기록 | 텍스트/표/그림/수식/폰트 테스트 기록 성공 및 근거 기록 |
| T016 | T015, T019, T020 | FR-011, SC-005 | src-tauri/tauri.conf.json, docs/release-checklist.md | 각 환경 실제 실행 결과와 출고 체크리스트 | 각 환경 실제 실행 결과와 출고 체크리스트 성공 및 근거 기록 |

## Verification Log

검증은 2026-10-16(KST), Linux, git 2.55.0, Python 3.14.7, gitleaks 8.30.1, pre-commit 4.7.0 환경에서
저장소 루트 기준으로 실행했다. 분석 작업(T001~T003)은 고정 커밋의 정적 검토이며 엔진 빌드·호출(L3)과
문서 검증(L4)은 수행하지 않았다.

| Task | 상태 | 산출물 | 실행한 검증과 결과 |
|------|------|--------|--------------------|
| T017 | 완료 | `.gitmodules`, `external/wordcraft`, `external/rhwp`, `external/README.md`, `README.md`, `.gitignore` | `git submodule status` → `1a76570e…3203f external/rhwp (v0.8.7)`, `fc419188…d6f external/wordcraft (v0.7.0)`; `git ls-files -s external` → 두 항목 모드 `160000`; `git check-ignore`로 무시/비무시 경로 확인(`docs/planning/`, `.gitmodules`, submodule 경로, lockfile, `.env.example` 비무시); 계획 기준본은 `docs/planning/` 3개 파일만 존재, 엔진 소스 복사본 없음 |
| T018 | 완료 | `scripts/check-sensitive-info.py`, `tests/security/test_check_sensitive_info.py`, `.gitleaks.toml`, `.pre-commit-config.yaml` | `python3 -m unittest discover -s tests/security -v` → 12개 통과(가짜 토큰·홈 경로 20개 규칙 검출, 마스킹, 상대·시스템 경로 통과, 인덱스 기준 검사, 예외 사유 필수); `pre-commit install` 후 `.git/hooks/pre-commit`·`pre-push` 생성, `pre-commit run --all-files` 통과; 가짜 비밀을 스테이징한 상태에서 `.git/hooks/pre-commit` 실행 → 종료 코드 1로 차단 |
| T019 | 부분 완료 | `.github/workflows/security-scan.yml`, `scripts/security-scan-ci.sh`, `docs/development/security-policy.md` | 로컬: 워크플로 YAML 파싱 확인, `scripts/security-scan-ci.sh .` 통과, PR 시뮬레이션(`tests/security/simulate-leak-response.sh`)에서 검사 실패 확인. **남은 항목**: GitHub Actions 실제 실행 결과, 브랜치 보호·필수 상태 검사 설정 확인 — 원격 푸시가 필요하며 이번 작업에서는 허용되지 않음 (2차 재검토에서 로컬 게이트 L·원격 공개 게이트 R로 나누어 아래에 갱신) |
| T020 | 완료 | `docs/development/security-incident.md`, `tests/security/simulate-leak-response.sh` | 임시 저장소 시뮬레이션 종료 코드 0: 훅 없는 커밋 → CI 검사 3종 실패(로그에 원문 없음) → 파일 삭제 후 `--all` 통과·`--history` 실패 → 이력 정리 후 `--history`·Gitleaks 통과 |
| T001 | 완료 | `docs/upstream/wordcraft.md`, `docs/licenses/wordcraft.md` | 고정 커밋 `fc41918`의 `Cargo.toml`, `NOTICE`, `ATTRIBUTION.md`, `LICENSE-*`, 크레이트 소스 검토. 모듈·라이선스·기여자 고지·API 후보 표 작성(L1/L2) |
| T002 | 완료 | `docs/upstream/rhwp.md`, `docs/licenses/rhwp.md` | 고정 커밋 `1a76570`의 `README.md`, `LICENSE`, `THIRD_PARTY_LICENSES.md`, `src/parser`, `src/serializer`, `src/wasm_api.rs` 검토. HWP/HWPX/HWP3/HML 읽기·쓰기 수준 구분(L1/L2) |
| T003 | 완료 | `docs/architecture/editor-surface-decision.md`, `tests/fixtures/README.md` | 엔진별 1·2순위 편집 표면, PoC 실행 경로(P0~P2), 측정 항목, 중단 조건, 픽스처 정책 확정. PoC 자체는 T007/T008에서 실행 |

### 2차 보안 재검토 (2026-10-16)

리뷰에서 지적된 T018 결함을 이전 검사기(커밋 `455c985`)로 먼저 재현한 뒤 고쳤다(커밋 `ce8f038`). 위 표의 1차 기록은
그대로 두고 아래에 추가 근거를 남긴다.

| Task | 상태 | 확인된 결함·변경 | 실행한 검증과 결과 |
|------|------|------------------|--------------------|
| T018 | 완료(재검증) | ① 글자만으로 된 15자 이하 값·`example`/`env.`/`<` 부분 문자열·서로 다른 글자 3개 이하 값을 자리표시자로 보고 통과(따옴표 안의 영문 단어 암호 등) ② 2 MiB 초과 파일 내용 검사를 건너뛰고 종료 코드 0 ③ `--staged`가 작업 트리의 예외 목록을 읽음(스테이징 안 된 예외가 스테이징된 비밀을 통과시킴), 넓은 glob·알 수 없는 규칙 허용 ④ 이메일 허용 도메인 접미사 일치(`evilexample.com`, 모든 `@anthropic.com`), 로컬 부분 `…noreply` 허용 ⑤ `/var/home`, `/mnt/c/Users` 미검출 ⑥ 이력 검사가 병합 커밋 내용·바이너리·바이너리 파일 이름을 보지 않음 ⑦ 스테이징 검사가 형식 변경(심볼릭 링크→파일, `T`)을 제외 ⑧ 바이너리·ZIP 문서를 검사 없이 통과. 모두 수정, 검사하지 못한 내용은 `uninspected-*`(종료 코드 1) 또는 종료 코드 2로 실패 | `python3 -m unittest discover -s tests/security -v` → 43개 통과(약 33초). 같은 테스트를 이전 검사기에 적용 → 54개 하위 사례 실패·2개 오류(결함 재현). 현재 저장소 `--all`(22개 파일)·`--history`(고유 파일 버전 25개) 통과. `gitleaks dir`(scripts/, tests/) 누출 없음. 커밋 `ce8f038`은 pre-commit 훅(스테이징 검사·회귀 테스트·Gitleaks) 통과 |
| T019 | 부분 완료 — 로컬 게이트(L) 완료 | pre-push 훅이 추적 파일만 검사해 삭제된 비밀이 남은 이력을 통과시키던 문제 → `--history`와 Gitleaks 전체 이력 검사 추가(전체 이력 방식: pre-commit은 여러 ref 푸시 시 첫 ref 범위만 계산함을 소스로 확인). CI `concurrency`(`cancel-in-progress: true`)가 강제 푸시 시 앞선 실행을 취소할 수 있어 제거. 문서의 기본 브랜치 `main` → 실제 `master`, 필수 상태 검사 이름을 실제 check run 이름 `민감정보 검사`로 정정 | `tests/security/test-pre-push-hook.sh`(실제 훅 설치 후 `.git/hooks/pre-push` 직접 호출, `git push` 없음) → 10개 시나리오 통과: 깨끗한 이력 통과, 비밀 커밋 차단, 삭제 후에도 차단, 이력 정리 후 통과, 홈 경로 이력 차단, 다른 로컬 브랜치 비밀 차단, 두 번째 ref 비밀 차단, `python3` 없음 차단, gitleaks 없음 CI 실패, 로그에 원문 없음. `simulate-leak-response.sh` 종료 코드 0. `scripts/security-scan-ci.sh .` 통과. `actionlint` 1.7.12 오류 없음. `pre-commit validate-config` 통과 |
| T019 | 원격 공개 게이트(R) 대기 | 저장소 관리자 작업. 체크리스트: [security-policy.md 5절](../development/security-policy.md#5-원격-저장소-설정-저장소-관리자) | GitHub 공개 API 읽기 전용 조회(2026-10-16): public, 기본 브랜치 `master`, 원격 `master` = `455c985`, `security-scan` push 실행 1회 성공(커밋 `455c985`, check run `민감정보 검사`). 브랜치 보호 없음(`protected: false`), ruleset 없음. 이 성공 기록은 `455c985`에 대한 것이며 이후 로컬 커밋은 푸시하지 않아 CI 결과가 없다 |

### T004 앱 셸 (2026-10-16)

| Task | 상태 | 산출물 | 실행한 검증과 결과 |
|------|------|--------|--------------------|
| T004 | 완료 | `package.json`·`package-lock.json`, `vite.config.ts`, `tsconfig.json`, `eslint.config.js`, `index.html`, `src/`(App, components 6영역 + Splitter·CommandButton, `ribbon/definitions.ts`, `commands/commands.ts`, `language/{ko.json,index.ts}`, hooks, styles, assets), `src-tauri/`(Cargo.toml·Cargo.lock, `src/{main,lib}.rs`, `tauri.conf.json`, `capabilities/default.json`, icons), `tests/e2e/tauri_smoke.py`, `.sensitive-info-allowlist`(아이콘 3건) | 선행 조건 T003 완료, T019(L) 통과 후 착수. `npm run typecheck`·`npm run lint` 오류 0; `npm test` → Vitest 31개 통과(6영역 렌더, 탐색·속성 창 숨기기/복원과 초점 이동, 키보드·포인터 크기 조절과 최소·최대, 좁은 창 최대 너비, 리본 접기·Ctrl+F1·탭 roving·도구 모음 화살표, 문서 명령 `aria-disabled`와 클릭 시 DOM 불변·이유 표시, 테마 전환, 확대/축소 한계, 번역 키 존재); `npm run build` 성공; `cargo fmt --check`, `cargo check`, `cargo clippy --locked --all-targets -- -D warnings` 통과; `npm run tauri build -- --debug --no-bundle` 성공; `tests/e2e/tauri_smoke.py`(tauri-driver 2.1.0 + WebKitWebDriver, Linux Wayland, WebKitGTK 2.54) → 실제 앱에서 21개 항목 통과·1개 건너뜀(앱 시작, 6영역 표시·배치 순서, 시작 창 960×900에서 가로 넘침 없음·편집 영역 360px 이상, 패널 숨기기·복원·초점, 리본 접기·Ctrl+F1, 키보드·포인터 크기 조절, 미지원 명령 비실행, 어두운 테마, Tab 도달). 건너뜀: WebDriver 창 크기 변경(960×600)을 타일링 창 관리자가 반영하지 않아 최소 높이 600px 배치는 실제 앱에서 확인하지 못함(좁은 창 계산은 Vitest로 확인). 번들 빌드와 개발 서버(Vite) 모드 모두 실행. `npm audit` 취약점 0. **범위 밖·미검증**: 문서 열기·편집·저장(엔진 미통합, 명령은 비활성 표시), ko/en 전환과 설정 복원(T005), Windows/macOS 실행(T016), CI의 프런트엔드·Rust 빌드 검사(아직 없음) |

### 3차 검토 (2026-10-16, 코드 리뷰 지적 사항)

지적 사항마다 먼저 이전 구현(커밋 `bc9e593`)으로 재현한 뒤 고쳤다. 위 기록은 그대로 둔다.

| Task | 상태 | 확인된 결함·변경 | 실행한 검증과 결과 |
|------|------|------------------|--------------------|
| T018 | 완료(재검증) | 재현됨: ① `uninspected-binary src-tauri/icons/*.png` 와일드카드 때문에 검토하지 않은 새 PNG가 통과 ② ZIP 항목 이름에 든 가짜 토큰이 위치·설명에 원문 그대로 출력, 항목 이름 자체는 검사하지 않음 ③ 첫 8 KiB에 NUL이 없는 무작위 바이너리를 텍스트로 보고 통과 ④ `--all`에서 추적 파일이 작업 트리에 없으면 경고만 내고 종료 코드 0. 수정(커밋 `5f89630`): 내용 검사 불가 규칙의 예외는 정확한 경로 + 검토한 내용의 `sha256`만 허용(인덱스·작업 트리·이력 버전별 해시로 비교), 아이콘 6개는 PNG 청크(IHDR/IDAT/IEND만 존재)를 재검토해 해시로 재등록; 모든 출력을 한 출구(`safe()`)에서 비밀·홈 경로·이메일 마스킹과 제어·방향 제어 문자 이스케이프; 경로와 ZIP 항목 이름도 규칙으로 검사; 64 KiB 구간 단위 바이너리 판정(NUL, 잘못된 인코딩·제어 문자 비율); 작업 트리에 없는 추적 파일은 종료 코드 2. 최종 점검에서 NUL 없는 9바이트 PNG 머리말 파일이 텍스트로 통과하는 것을 추가로 찾아, 알려진 형식 시작 바이트(PNG·JPEG·GIF·PDF·HWP 3.0·OLE·압축·글꼴·실행 파일) 판별을 더함(커밋 `67f4100`) | `python3 -m unittest discover -s tests/security -v` → 68개 통과(새 25개: 바이너리 예외 9, 출력 정리 4, 바이너리 판정 6, 누락 파일 6). 같은 테스트를 이전 검사기에 적용 → 하위 사례 포함 25개 실패·3개 오류. `--staged`·`--all`·`--history` 통과(이력 검사는 새 예외 목록 커밋 뒤 통과 — HEAD 기준이므로). Gitleaks `dir`(scripts/, tests/) 누출 없음. `test-pre-push-hook.sh` 10개, `simulate-leak-response.sh` 종료 코드 0 |
| T004 | 완료(결함 수정) | 재현됨: 탐색 420px·속성 460px 저장 상태로 960px 창에서 `aria-valuenow=380`, `aria-valuemax=180`(최대값을 다른 패널의 저장 너비로 계산), 이때 키보드 → 키를 누르면 패널이 180px로 줄어듦. 수정(커밋 `88853a2`): 그리는 너비와 min/max를 한 순수 함수 `computePanelLayout()`에서 계산, 저장된 너비는 유지해 창이 넓어지면 복원 | `npm test` → Vitest 40개 통과(조합 전수 검사: 창 960~2000px × 패널 너비 × 표시 조합에서 min ≤ 현재값 ≤ max·편집 영역 ≥ 360px; 렌더링: 창 크기 변경·키보드·포인터·패널 숨기기/복원·초점). 새 렌더링 테스트를 이전 구현에 적용 → 5개 실패. 실제 앱 `tests/e2e/tauri_smoke.py`: 데스크톱(타일링 창 관리자)에서는 최소 창 검사 건너뜀, 헤드리스 weston 15.0.1(1600×1000 출력)에서 **25개 통과·건너뜀 0** — 960×600 창에서 가로·세로 넘침 없음, 두 패널을 End로 최대화해도 aria 범위·실제 너비 일치, 편집 영역 360px 이상 |
| T004 (CI) | 로컬 검증 완료, 원격 미실행 | `.github/workflows/quality.yml` 추가(커밋 `d4bd963`): 프런트엔드(`npm ci`, `typecheck`, `lint`, `test`, `build`), Rust(`src-tauri`에서 `cargo fmt --check`, `cargo check --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings`, Rust 1.99.0 고정, `libwebkit2gtk-4.1-dev`), submodule 미사용, `contents: read`, 공식 액션 SHA 고정 | `actionlint` 1.7.12 오류 없음(shellcheck 미설치로 셸 단계 정적 검사는 안 됨). 로컬 클론(submodule 미초기화)에서 두 작업의 명령을 그대로 실행해 모두 통과(`dist/` 없이 Rust 검사 가능 확인). **GitHub Actions에서는 실행되지 않음**(푸시 금지) |
| T019 | (L) 완료 유지, (R) 대기 | 원격 상태 재조회(읽기 전용): public, 기본 브랜치 `master`, 원격 `master`=`bc9e593`, 브랜치 보호·ruleset 없음, `security-scan`이 `455c985`·`bc9e593`에서 성공(check run `민감정보 검사`), `quality`는 원격에 없음. Secret scanning·Actions 토큰 권한은 관리자 인증이 필요해 확인 불가. 관리자 체크리스트 10항목 갱신: [security-policy.md 5절](../development/security-policy.md#5-원격-저장소-설정-저장소-관리자) | 로컬 게이트: `pre-commit run --hook-stage pre-push --all-files`, `scripts/security-scan-ci.sh .` 통과(최종 검증 기록 참고). 원격 설정은 변경하지 않음 |

보안 검사 재실행 명령: `python3 scripts/check-sensitive-info.py --staged|--all|--history`,
`scripts/security-scan-ci.sh .`(gitleaks 필요), `tests/security/simulate-leak-response.sh`,
`tests/security/test-pre-push-hook.sh`(pre-commit 필요).

## Dependencies & Execution Order
T017(프로젝트+submodule) → T018(로컬 사전 검사) → T019(L, 로컬 게이트: pre-push·CI 스크립트·시뮬레이션) → T020(사고 대응). T019(R, 원격 공개 게이트: Actions 실행·브랜치 보호·필수 상태 검사)는 저장소 관리자 작업이며 T016(출시) 전에 반드시 완료한다. 앱 개발(T004 이후)은 T019(L)이 통과하면 진행할 수 있고 T019(R)을 기다리지 않는다. 표의 `T019(L)`은 T019 계약 중 로컬 게이트 부분만을 뜻하며 별도 작업 ID가 아니다. T001/T002는 T017 이후에 병렬 조사 가능하며 T003에서 기술 게이트를 결정한다. T007/T008을 통과하기 전에는 T010 이후의 고급 UI 구현을 확대하지 않는다. 보안 검사 훅은 초기 커밋 전에 활성화하고 외부 소스를 복제한 후에는 라이선스/공급망 위험을 별도 검토한다.

## Execution Policy
- 완료 체크박스는 검증 증거 없이 선택하지 않는다. 기존 T001~T017 ID는 유지하고 새 보안 작업만 T018~T020에 추가한다.
- 전체 저장소 최초 공개 전 검사와 변경 파일 사전 훅 검사, CI 검사는 서로 대체하지 않는다. 강제 푸시/훅 우회/최초 공개 누출에 대비한다.
- 프로젝트 상대 경로만 문서에 사용한다. 테스트용 홈 경로는 실제 사용자명 대신 `<USER>`를 사용하고 스캐너 예외는 근거를 문서화한다.
- API 키가 노출되면 Git 이력에서 삭제하는 것만으로 종료하지 말고 키 폐기·재발급·영향 점검을 먼저 수행한다.
- git submodule 포인터를 업스트림 이동 브랜치가 아닌 검토한 커밋에 고정한다.
- 동일 장애에 진전 없는 수정을 두 차례 반복하면 중지하고 근거와 차단 원인을 보고한다.

## Handoff
- `docs/planning/`의 세 기준 문서와 실제 대상 저장소의 AGENTS.md, constitution, CI 정책을 먼저 확인한다. 기존 구현과 충돌하면 diff/backups를 만들고 승인된 변경만 병합한다.
- 작업 흐름: `spec.md` → `plan.md` → `tasks.md` → 구현 → 테스트 → `tasks.md` 검증 기록 → 로컬 Git 커밋. 세 문서는 직접 수정하며 Spec Kit·Specify 등 별도 계획 도구와 `.specify/`, `specs/` 디렉터리는 쓰지 않는다.
- 분석과 구현 테스트는 별개이며 빌드·실행·무손실 검증을 하지 않았다면 완료라고 보고하지 않는다.

