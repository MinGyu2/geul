# Tasks: HWP/HWPX + DOCX 통합 편집기

> **최신 상태 (2026-11-06):** Stage 5–7은 **PARTIALLY COMPLETED**. B1 저장 중 서식 race와 B2 publication 이전 Undo snapshot 복구는 수정·검증됐으며 각각 로컬 커밋이 있다. WordCraft gitlink clean checkout은 현 원격 ref에서 fetch되지 않아 BLOCKED이고, D2의 native E→U→F는 이번 격리 조사에서도 0회 관측되어 INCONCLUSIVE다. Microsoft Word/Hancom GUI 접근이 없어 외부 수용은 NOT RUN; 내부 DOCX/HWP/HWPX 검증은 외부 호환성 PASS가 아니다. 최신 판정·evidence·수동 외부 절차는 [2026-11-06 후속 수용 기록](../architecture/stage567-acceptance-2026-11-05.md#2026-11-06-후속-wordcraft-재현성-게시-undo-native-d2-외부-office)에 따른다. T012/T013 미완료, 제품 RHWP Undo/Redo·장평/자간·영속 수식 비활성 상태, D4 기존 gate는 유지한다.

Input: [spec.md](./spec.md), [plan.md](./plan.md).
Updated: 2026-11-04; source baseline `4bc1ac986026ccadb2d673a66ad69e6296e3a39e` (`MinGyu2/geul`, master).

> **2026-11-05 Stage 5–7 재검증:** Stage 5/6/7은 부분 완료이며 T012/T013 체크는 미완료로 유지한다. 실제 Release WASM과 controlled 수식 연결, 수식 HWP/HWPX 2회 저장(6게시·2안전 거부), 현 native 실행 범위는 [통합 수용 보고서](../architecture/stage567-acceptance-2026-11-05.md)에 기록했다. D2는 25 PASS/2 INCONCLUSIVE이며 필수 E→U→F는 미관측, D4는 기존 문턱 그대로 6 PASS/2 FAIL이다. 제품 RHWP history·장평/자간·영속 수식은 NO-GO이고 Word/Hancom은 NOT RUN이다. 아래 T012/T013의 긴 상태 행과 native NOT RUN 문구는 그 행에 적힌 당시의 이력이며, 현재 범위는 이 최신 기록이 대체한다. DOCX 추적 표식 교정 뒤 실제 native10개/단계별 저장10개·재개방은 통과했으나 Word 외부 수용을 완료로 세지 않는다.

## Execution Context
Implementation model: GPT-6.1 Sol (사용자 요청; 실행 모델 메타데이터는 별도 확인되지 않음)
Reasoning effort: High (사용자 요청)
Profile: balanced
Selection basis: 기존 제품 구조·검증 자산을 유지하고 사용자가 승인한 조건부 진행 및 신규 생성 계획만 반영한다.
Repository context: 기존 독립 엔진·저장·복구를 재사용해 T021·T022를 구현/수용/순차 커밋했다. T023은 실제 Tauri/X11/IBus 및 실패 주입 결과로 판정한다. 원래 문서 작업 시점의 NOT RUN 기록은 아래 이력에 보존한다.

이전 장기 실행 기록은 [tasks.snapshot-8d3f21a.md](./tasks.snapshot-8d3f21a.md)에 보존돼 있다. 이번 수정 직전 원문은 위 기준 커밋의 Git 이력에 남는다. 원래 ID·9개 완료 체크·기술적 실패 기록을 보존한다. 새 작업은 T021–T024이며 T024는 선택적 보류다.

## Status and Approved Progression — 2026-11-04

- `[x]`: 해당 task의 기존 완료 근거 유지. 이번에 다시 시험했다는 뜻이 아니다.
- `[ ] ... △ 조건부 완료`: 주요 구현·제한된 수용을 인정하되 전체 수용은 미완료. 명시한 후속 개발은 허용하지만 제품 활성화·출시 승인은 아니다.
- `[ ]`와 별도 상태: 미착수/진행 중/보류. 착수 승인과 실제 착수는 구분한다.

GitHub 체크박스에 비표준 `[△]`를 쓰지 않고 task 설명에 `△`를 넣는다. 따라서 완료 개수만 세어 개발 진척을 판단하지 않는다.

| Task | 인정하는 범위 | △로 남기는 이유 | 잔여 책임과 재개 조건 |
|---|---|---|---|
| T007 | Linux X11/Xvfb·IBus의 HWP/HWPX 기본 입력·커서·표·선택·렌더 및 기록된 IME 지연 | 최신 앱/WASM 변경 영향과 추가 환경은 전체 수용 미완료 | 현 지원 경로의 회귀는 T007, GPU/Wayland/fcitx5/다른 OS·추가 부하/초점 조합은 T016. 실제 변경 경계만 집중 검증 |
| T008 | WordCraft W-A의 DOCX 기본 편집·IME·raster/hit-test·IPC 근거 | 현재 공통 IME/Workspace 변경 영향 및 추가 환경 전체 미완료 | 현 경로 회귀는 T008, 확장 환경은 T016. RHWP 패치만 바뀌면 DOCX 전체 재실행을 자동 요구하지 않음 |
| T009 | HWP/HWPX/DOCX 대표 지원 문서 저장·재열기와 안전 거절 | 최신 산출물의 적용 범위 정리·선행 전체 수용 잔여. 모든 외부 문서 저장 보장은 아님 | 대표 지원 범위는 T009, 추가 코퍼스 품질은 T015, 플랫폼은 T016. 새 문서 생성 수용은 T021–T023 |
| T010 | 공통 명령 기반·DOCX 연결, D1 마지막 공식 PASS, 2026-11-04 D3/D5 PASS 기록 | D2 INCONCLUSIVE, D4 지연 FAIL·자원 INCONCLUSIVE, RHWP 제품 Undo/Redo·서식 활성화/전체 SC-003 미완료 | D2/D4 조사는 보류. 새 근거·별도 승인 시 재개. 제품 차단과 현재 수용 기준은 유지 |

### T011 착수 조건 변경

기존 `T011 Depends on T010`의 ID 연결은 유지하지만, **착수에 필요한 조건을 T010 전체 완료에서 검증된 공통 명령 기반으로 좁힌다.** 이는 2026-11-04 사용자 승인에 따른 명시적 계획 변경이다. T007–T009의 미체크를 우회해 전체 PASS를 선언하는 것이 아니다.

허용: 공통 리본·문서 형식/실제 선택에 따른 표시·기존 지원 명령 연결·비활성 사유·리본/단축키 일치. 금지: RHWP 시험 플래그 제품 활성화, 미검증 변형 명령 연결, 저장 검사 완화, D2/D4 실패를 PASS로 변경. 구현 전 현재 registry/capability/세션 경계를 확인하고 변경 영향 회귀를 실행한다.

이 결정은 architecture 문서의 과거 T011 착수 불허 관리 문구만 대체한다. [T010 수용 행렬](../architecture/rhwp-undo-redo.md#t010-current-status)의 기술 판정과 제품 NO-GO는 유지한다. T011의 상태는 **착수 승인·구현 미착수**다(이 결정 시점). T011 전체 완료는 원래 Done 기준으로 별도 판단한다. 이후 구현·검증 상태는 Phase 4 목록과 Verification Log를 따른다.

T021–T023도 검증된 T006·T007/T008·T009 연결을 재사용해 개발할 수 있다. 해당 행의 의존성은 실제 사용하는 기본 표면·저장 계약에 적용하며 추가 환경 전체나 T010 D2/D4 완료를 요구하지 않는다. 발견된 입력 손실·원본 훼손·출력 손상은 해당 기능을 막고 먼저 고친다.

## Phase 1: Setup
- [x] T017 실제 저장소·두 submodule·고정 버전·기준본 확인 — `README.md`
- [x] T018 민감정보 차단 규칙과 회귀 검증 — `scripts/check-sensitive-info.py`
- [ ] T019 로컬·원격 공개 보안 게이트 — `.github/workflows/security-scan.yml` (L 완료 이력, R 전체 미완료)
- [x] T020 훅 우회 위험·이력 노출·유출 대응 문서화 — `docs/development/security-incident.md`
- [x] T001 WordCraft API·렌더·라이선스·고정 커밋 검토 — `docs/upstream/wordcraft.md`
- [x] T002 RHWP 저장·렌더·입력 API·라이선스 검토 — `docs/upstream/rhwp.md`
- [x] T003 표면/IME/렌더 경계·PoC 중단 조건 정의 — `docs/architecture/editor-surface-decision.md`

## Phase 2: User Story 1 - 기본 UI와 다국어 (Priority: P1)
Independent Test: 6영역·패널·언어·설정 복원.
- [x] T004 [US1] Tauri/React 6영역 화면·패널 구축 — `src/App.tsx`
- [x] T005 [US1] 번역 JSON·fallback·설정 복원 — `src/language/`

## Phase 3: User Story 2 - 문서 기본 편집 (Priority: P1)
Independent Test: 두 표면의 PoC와 대표 문서 IME→저장→재열기 및 안전 거절.
- [x] T006 [US2] 포맷 판별·독립 세션·어댑터 계약 — `src/adapters/`, `src-tauri/src/document/`
- [ ] T007 [US2] △ 조건부 완료 — RHWP HWP/HWPX 표면 — `src/components/Editor/rhwp/` (범위·잔여 사유는 상단 표)
- [ ] T008 [US2] △ 조건부 완료 — WordCraft W-A 표면 — `src-tauri/src/adapters/`, `src/components/Editor/wordcraft/`
- [ ] T009 [US2] △ 조건부 완료 — 형식별 안전 저장·재열기 — `src-tauri/src/services/`

## Phase 4: User Story 3 - 공통 명령 및 리본 (Priority: P1)
Independent Test: 형식·선택·상태별 명령과 미지원 차단. 시험 전용 명령 활성화 금지.
- [ ] T010 [US3] △ 조건부 완료 — 공통 명령·Undo/Redo·서식 — `src/commands/` (D2/D4 조사 보류, RHWP 제품 활성화 NO-GO)
- [x] T011 [US3] 공통 리본·상황별 도구 연결 — `src/ribbon/`, `src/components/Ribbon/` (2026-11-04 완료, 선택 문맥 상황 탭은 빠진 능력으로 숨김 — 아래 Verification Log)

## Phase 5: User Story 4 - 고급 기능 (Priority: P2)
Independent Test: 실제 API·기록·문서 왕복을 검증한 명령만 활성화.
- [ ] T012 [US4] 한글 전용 검증 명령 연결 — `src/ribbon/HangulTools/` (2026-11-05 부분: 표 계산 읽기 전용은 제품 HWP·HWPX, 장평·자간은 시험 활성화 빌드 HWPX만, 결과 쓰기·HWP 장평/자간 미지원, 2026-11-05 재검토: 제품 장평·자간은 T010 rhwp 실행 취소 NO-GO(Stage 5: RHWP 덧붙인 글자 모양 정리 series 패치·HWP DocInfo 덧붙임 규칙 구현, 시험 활성화 빌드에서 HWP·HWPX 연속 변경 실제 WASM 저장 15/15 — 제품은 D2/D4 관문 전까지 unsupported), 연속 변경은 rhwp 글자 모양 표 덧붙임 전용, 결과 쓰기는 계산식 필드 생성 엔진 기능 부재로 BLOCKED(Stage 6: 한컴 실물 모양의 계산식 필드 생성 RHWP 후보 패치·네이티브 HWP/HWPX 왕복 시험까지, 미연결), native NOT RUN — [command-registry.md "T012 한글 도구"](../architecture/command-registry.md))
- [ ] T013 [US4] DOCX 고급 검증 명령 연결 — `src/ribbon/References/` (2026-11-05 부분: 새 메모·각주·미주 제품 DOCX 연결·실제 저장 두 회차 검증(각주·미주는 WordCraft 구분선 읽기 수정 `b39a8fb` — 공개 포크의 개발 브랜치에서 fetch 가능, geul master gitlink와 일치), 목차는 엔진 표현(표지 필드 ↔ 읽은 범위 필드)으로, 기존 변경 내용 추적 문서는 편집 차단·읽기/선택 허용, 안내를 제공하며 새 추적·수락/거절 명령은 미지원; IME native 미검증으로 planned 유지, 하이퍼링크 일부 메모는 Stage 4에서 나뉜 같은 관계만 받는 좁은 규칙으로 저장 지원, native NOT RUN; Stage 1 trackedReadOnly 필수 IPC·구분선 변이 거부 확인 `9b28d7c`; Stage 2 목차 넣기·갱신 제품 연결(WordCraft `af80638` 로컬 미발행), Word 호환 NOT RUN; Stage 3 변경 내용 추적·수락·거절 연결과 추적 문서 편집 허용(WordCraft `b74830b` 로컬 미발행, 수정 기록 색인 일대일), native IME·Word NOT RUN; Stage 7 native·Word 수용 NOT RUN(X11/IBus·Word 없음) — [command-registry.md "T013"](../architecture/command-registry.md))

## Phase 6: User Story 5 - 저장 실패·복구 수용 (Priority: P1)
Independent Test: 기존 저장·충돌·복구의 남은 실패 경계.
- [ ] T014 [US5] 저장 실패·충돌·복구 전체 수용 — `src-tauri/src/services/` (기존 구현 재사용, T010 직접 의존 아님)

## Phase 7: User Story 7 - 형식별 새 문서 (Priority: P1)
Independent Test: 세 형식의 실제 생성·입력·저장·재저장·재열기, 취소·실패·경합.
- [x] T021 [US7] RHWP 빈 문서 API·템플릿·형식별 출력 및 검증 경계 검증 — `src/components/Editor/rhwp/createBlank.ts`, `src-tauri/src/services/creation.rs`, `scripts/tests/new-document-*`, `docs/architecture/new-document-creation.md`
- [x] T022 [US7] 형식 선택·안전 생성·세션 등록·포커스 통합 — `src/App.tsx`, `src/components/Editor/`, `src-tauri/src/services/files.rs`, `src/language/`
- [x] T023 [US7] 신규 세 형식의 native 왕복·실패 안전성 수용 — `scripts/tests/native-new-document*.py`, `docs/architecture/new-document-creation.md`
- [ ] T024 [US7] 선택적 제목 없음·첫 저장·복구 UX — `src/components/Editor/`, `src-tauri/src/document/`, `src-tauri/src/services/` (DEFERRED, 별도 승인 전 구현 금지)

## Phase 8: User Story 5 - 품질 행렬 및 출시 (Priority: P1)
Independent Test: 지원 기능 행렬과 각 OS의 실제 배포 실행.
- [ ] T015 [US5] 기존·신규 문서 왕복 및 회귀 행렬 — `tests/roundtrip/`, `docs/quality-matrix.md`
- [ ] T016 [US5] 세 OS·확장 입력/그래픽 환경·PDF·고지·보안 출시 수용 — `src-tauri/tauri.conf.json`, `docs/release-checklist.md`

## Task Contracts

Depends on은 ID 연결이다. 위 승인된 착수 조건과 전체 Done을 구분한다. `T019(L)`은 기존 로컬 게이트이며 T019 전체를 의미하지 않는다. 새로운 T015→T023 연결은 신규 생성 수용을 품질 행렬에 포함하기 위한 명시적 추가다. T024는 기본 출시 선행이 아니다. 미착수 Files는 계획 경로이며 tests는 로컬 논리 경로다.

| Task | Depends on | Requirements | Files | Verify | Done |
|---|---|---|---|---|---|
| T017 | None | FR-003, FR-012, SC-006 | README.md, external/README.md, docs/planning/ | gitlink·기준본·submodule 확인 | 기존 확인 성공 및 근거 기록 |
| T018 | T017 | FR-013, SC-007 | scripts/check-sensitive-info.py, .gitleaks.toml, .pre-commit-config.yaml | 합성 검출값 거부·정상 경로 허용 | 검사 성공 및 근거 기록 |
| T019 | T018 | FR-013, FR-014, SC-008 | .github/workflows/security-scan.yml, docs/development/security-policy.md, .pre-commit-config.yaml, tests/security/ | L: 로컬 훅·전체 이력·CI 스크립트·시뮬레이션 실패; R: Actions·브랜치 보호·필수 검사 | L과 R 모두 충족 및 근거 기록 |
| T020 | T018, T019(L) | FR-014, SC-008 | docs/development/security-incident.md, scripts/check-sensitive-info.py | 격리 시험 저장소의 실패 시뮬레이션 | 기존 시뮬레이션 성공 및 근거 기록 |
| T001 | T017 | FR-003 | docs/upstream/wordcraft.md, docs/licenses/wordcraft.md | API·렌더·라이선스·고지 검토 | 정적 검토 성공 및 근거 기록 |
| T002 | T017 | FR-003 | docs/upstream/rhwp.md, docs/licenses/rhwp.md | HWP/HWPX 읽기·쓰기 지원 구분 | 정적 검토 성공 및 근거 기록 |
| T003 | T001, T002 | FR-005 | docs/architecture/editor-surface-decision.md, tests/fixtures/README.md | 표면·PoC 실행 경로·데이터 확정 | 원래 계약 정의와 근거 기록 |
| T004 | T003, T019(L) | FR-001, SC-001 | src/App.tsx, src/components/ | 앱·6영역·패널 | UI 검사 성공 및 근거 기록 |
| T005 | T004 | FR-002, SC-001 | src/language/, src/settings/ | 누락 번역·언어·복원 | 검사 성공 및 근거 기록 |
| T006 | T003, T004 | FR-004 | src/adapters/, src-tauri/src/document/ | 잘못된 확장자/헤더·세션 분리 | 검사 성공 및 근거 기록 |
| T007 | T006 | FR-005, SC-002 | src/components/Editor/, tests/integration/rhwp/ | 원래 IME·커서·선택·렌더 실측 | 표면 수용 근거와 현재 적용 범위 충족; 추가 환경은 T016 추적 |
| T008 | T006 | FR-005, SC-002 | src-tauri/src/adapters/, src/components/Editor/wordcraft/, tests/integration/wordcraft/, tests/fixtures/wordcraft/ | IME·커서·선택·W-A raster/hit-test·IPC | 표면 수용 근거와 현재 적용 범위 충족; 추가 환경은 T016 추적 |
| T009 | T007, T008 | FR-006, FR-015, SC-002 | src-tauri/src/services/, tests/roundtrip/ | 대표 실제 문서 왕복·안전 거절 | 원래 왕복·거절 수용 성공 및 근거 기록 |
| T010 | T009, T005 | FR-007, SC-003 | src/commands/, tests/ui/ | 두 엔진 명령·미지원 차단 및 기존 RHWP 관문 | 전체 명령 수용과 활성화 조건 충족; △는 전체 완료가 아님 |
| T011 | T010 | FR-008, FR-015, SC-003 | src/ribbon/, src/components/Ribbon/ | 형식·선택·모달·IME·탭 전환·단축키/버튼 일치 | 실제 지원 명령과 표시/실행 차단이 계약대로 동작하고 근거 기록 |
| T012 | T011 | FR-009 | src/ribbon/HangulTools/, tests/integration/hangul/ | 장평·자간·표 등 실제 API·왕복 | 검증된 한글 전용 기능의 결과 기록 |
| T013 | T011 | FR-009 | src/ribbon/References/, tests/integration/docx-advanced/ | 참조·검토 실제 지원·왕복 | 검증된 DOCX 고급 기능의 결과 기록 |
| T014 | T009 | FR-006, FR-010, SC-004 | src-tauri/src/services/, tests/integration/save-failure/ | 강제 실패·외부 변경·게시/내구/복구 | 원래 실패 안전성 조건과 실제 파일 결과 일치 |
| T021 | T002, T006 | FR-017, SC-009 | src/components/Editor/rhwp/createBlank.ts, src-tauri/src/services/creation.rs, scripts/tests/new-document-*, docs/architecture/new-document-creation.md | 현재 Release의 createEmpty/createBlankDocument·형식별 export/reopen·독립 구조·손실·템플릿 신원 | HWP/HWPX 각각 유효 생성 경로와 검증 경계를 실측 확정; 실패를 지원 성공으로 올리지 않음 |
| T022 | T021, T005, T009 | FR-015, FR-016, FR-017, FR-018, SC-009, SC-010 | src/App.tsx, src/components/Editor/, src-tauri/src/services/files.rs, src-tauri/src/services/save/, src-tauri/src/document/, src/language/, src/components/Editor/newDocument.test.ts | 선택/취소·형식/응답 검증·create-only·세션·초점·오류·DOCX 회귀 | 세 형식 생성 연결과 집중 시험 성공, 기존 파일/입력 보호; 전체 native 수용은 T023 |
| T023 | T022, T007, T008 | FR-016, FR-017, FR-018, SC-009, SC-010 | scripts/tests/native-new-document*.py, docs/architecture/new-document-creation.md | 실제 Tauri에서 세 형식 생성→IME→편집→저장→재저장→재열기 및 실패/경합 | 형식별 현재 실행 신원의 양성·음성 수용 완료; 생성된 빈 문서의 기본 편집 저장 실패를 안전 거절 PASS로 대체하지 않음 |
| T024 | T023, T014 | FR-019, SC-011 | src/components/Editor/, src-tauri/src/document/, src-tauri/src/services/, tests/integration/new-document/ | 별도 승인 후 pathless 세션·첫 저장/취소/충돌·닫기·복구 | 승인된 미저장 UX의 원래 데이터·소유권 계약 충족; 미도입이면 DEFERRED 유지 |
| T015 | T012, T013, T014, T023 | FR-011, SC-002, SC-004, SC-009, SC-010 | tests/roundtrip/, docs/quality-matrix.md | 기존/신규 문서·서식·표·그림·수식·글꼴·실패 행렬 | 기능별 실행 신원·판정·미검증 범위가 연결된 품질 수용 |
| T016 | T015, T019, T020 | FR-011, SC-005 | src-tauri/tauri.conf.json, docs/release-checklist.md | 세 OS 실제 패키지·추가 IME/그래픽/부하·PDF·고지·보안 | 지원 선언 범위의 출시 수용과 근거 기록 |

## Current Evidence and Remaining Work

### 기본 표면과 저장

[native-editor 수용](../architecture/native-editor-acceptance-2026-11-02.json)은 기록된 Linux 구성의 RHWP 일반/표, DOCX 일반, 두 엔진 IME 7/7과 IME 지연을 포함한다. [저장 왕복](../architecture/save-roundtrip-acceptance-2026-11-02.json)의 stage4는 SC-002 대표 지원 문서 범위 COMPLETED다. 실패한 전체 실행에서 이미 완료된 하위 검사와 다른 실행의 PASS는 원래 범위를 유지하며 하나의 새 전체 PASS로 합치지 않는다.

기존 근거의 WASM `3f99a74b…`와 후속 Release `77d01d6c…`를 혼동하지 않는다. 최신 패치/공통 IME 변경은 영향 검토 또는 관련 집중 재검증 대상이다. Linux GPU/Wayland 등은 같은 OS여도 별도 환경이며 미검증을 통과로 바꾸지 않는다.

T014의 안전 게시·충돌·DOCX 체크포인트·복구는 이미 상당 부분 구현돼 있다. 신규 생성 때문에 전부 다시 만들지 않는다. RHWP 미저장 자동 복구가 이미 있다고 확대하지 않는다.

### T010 세부 판정

2026-11-04 [D3/D5/D2 재검증](../architecture/rhwp-undo-redo.md#t010-d3-d5-d2-20261104): Release `853a0689…`/WASM `77d01d6c…`의 D3 19/19 및 strict 23행, D5 실패 경계·native 폐기/재불러오기 PASS 기록을 인정한다. 이 문서 작업에서 새로 실행한 결과는 아니다.

D2는 E(empty compositionend)→U(native Undo)→F(late final insert) 미관측이다. 일반 IME 성공이나 합성 시험으로 native 관문을 대체하지 않는다. D4는 마지막 공식 group-start 44/45/52/95ms, Undo 50/50/78/160ms 기록의 지연 FAIL·자원 INCONCLUSIVE다. 새 기준·최신 WASM 측정으로 바꿔 적지 않는다. 새 근거 없는 반복 탐색은 보류하지만 실제 사용자 결함은 무시하지 않는다.

### 신규 생성과 기타 작업

현재 제품 신규 생성은 DOCX/HWP/HWPX를 지원한다. T021 생성 경계·T022 제품 통합·T023 X11/IBus native 수용을 완료했다. RHWP createEmpty만으로 생성하지 않으며 공개 API 초기화/독립 reopen과 생성 전용 Rust 검증을 사용한다. [신규 생성 계약](../architecture/new-document-creation.md)의 현재 실행 결과와 과거 정적 검토를 구분한다. T024는 별도 승인 전 DEFERRED다.

T019(L) 완료 이력과 R 전체 미완료를 유지한다. 과거 CI 성공과 원격 강제 정책은 다르며 이번에 설정을 바꾸지 않는다. T012/T013·T015/T016도 별도 전체 수용이 남는다. [HWPX 위상 보완 기록](../architecture/hwpx-duplicate-id-acceptance-2026-11-02.json)은 그대로 두고, 빈 hp:t를 다시 미착수 후보로 지정하지 않는다. 코퍼스 safe 수를 모든 실제 문서 편집 저장 지원율로 사용하지 않는다.

## Execution Policy

1. T011 및 T021–T023의 기록된 완료 범위를 유지한다. 후속 작업은 공통 파일·전역 입력 상태의 소유권과 실제 의존성을 확인한다. task 번호와 실제 선행 수용을 혼동하지 않는다.
2. 요구·상태·판정·제품 노출을 분리한다. △로의 변경은 원래 FAIL을 삭제하거나 모든 후속 기능을 자동 승인하지 않는다.
3. 변경된 경계만 필요한 단위·엔진·native 검증으로 확인한다. 전체 코퍼스 확장·새 환경 반복·D4 최적화를 무조건적인 선행으로 붙이지 않는다.
4. FULL_PAGE_ONLY·원래 성능 측정 계약·원본 보존·세션 소유권·민감정보 정책을 유지한다. 테스트 자료 부재/0건/SKIP을 PASS로 세지 않는다.
5. 최초 생성은 경로 선선택이다. 제목 없음·복구 확대는 T024의 별도 승인 범위다. submodule·패치·도구chain 변경이 필요하면 근거와 영향부터 제시한다.

## Verification Log

2026-11-04 문서/소스/기존 기록 대조. 새 생성 runtime·T011 구현·native D1–D5 실행은 NOT RUN이다(이 문서 작업 시점, 아래 T011 기록이 뒤따름). 계획 구조 검사는 요구 ID·작업 ID·의존성·커버리지·상대 링크를 대상으로 하며 제품 무결함 증명이 아니다. 범용 검사기가 `T019(L)`을 이해하지 못하면 표기를 삭제하지 않고 그 제한과 별도 로컬 게이트 대조 결과를 기록한다. 커밋/푸시 방식과 실제 실행한 보안 검사 범위는 최종 작업 보고에서 구분한다.

2026-11-04 T011 구현(`6524650` 위, 상세 [command-registry.md "T011 리본"](../architecture/command-registry.md#t011-리본-형식별-탭상황별-도구명령-연결-2026-11-04-6524650-위)):
형식별 탭(문서 없음=공통, HWP·HWPX=+한글 도구, DOCX=+참조·편지)·사라진 탭 대신 고르기·초점 복구·리본 탭/접기 단추의 편집 입력 초점 유지를
구현했다. 새로 실행 가능하게 바꾼 명령은 없고 RHWP 실행 취소·서식은 제품 빌드에서 계속 `engineUnsupported`다. 선택 문맥 상황 탭은 개체 선택
신호·검증된 표/그림 명령이 없어 만들지 않았다(빠진 능력 기록). 실행 결과: Vitest 51파일 955개 PASS(합성·가짜 엔진), `tsc --noEmit`·ESLint PASS,
실제 Tauri debug 제품 빌드(Wayland 세션, WebKitGTK 2.54, 실제 rhwp WASM·WordCraft) `tests/e2e/tauri_smoke.py --skip-restart` 34 PASS·2 SKIP,
`tests/e2e/t011_ribbon_native.py` 14/14 PASS(IME 없음). **native 한국어 IME(IBus) 중 리본 탭·접기 조작 회귀 검증은 이 환경에 IBus·Xvfb가 없어
NOT RUN**이므로 T011은 미체크로 둔다. 재개: 기록된 X11/Xvfb + ibus-hangul 환경에서 조합 중 리본 탭·접기 단추 누름의 음절 보존·중복 없음·문서
소유를 확인(T010 `--ime-commands` 시험기와 같은 판정).

2026-11-04 T011 native IME 검증(`e285e60` 검사 훅 debug 빌드, Xvfb X11 + ibus 1.5.33 + ibus-hangul 1.5.5, WebKitGTK 2.54, xdotool 실제 키·포인터):
`rhwp_poc.py --ime` 필수 7/7, `wordcraft_poc.py --ime` 필수 7/7, `--ime-commands` 18/18, 신규 `tests/e2e/t011_ribbon_ime_native.py` 12/12(DPR 1.0과 기록
환경과 같은 1.041 각 1회) PASS. 조합 중 리본 탭·형식 전용 탭·접기 단추 누름에서 음절은 원래 문서에 한 번, 초점 유지, 다른 문서 불변. 입력기 설정 보정
(ibus-hangul 초기 모드 hangul)·창 초점 이동 선택 항목 NOT RUN·리본 빈 곳 누름의 초점 이탈(기존 동작)은
[command-registry.md](../architecture/command-registry.md#실제-ime-검증-2026-11-04-e285e60-검사-훅-debug-빌드)에 기록. 이로써 T011 Done 기준(형식·선택·모달·IME·탭 전환·
단축키/버튼 일치의 근거)을 충족해 체크한다. 선택 문맥 상황 탭은 계획 계약대로 만들지 않았다. T007–T010의 △ 상태와 D2/D4 판정은 바꾸지 않는다.

2026-11-04 T011 안정화(`ef14f4b` 위): 리본 빈 곳 누름의 편집 초점 이탈(A)과 접기 단추·접힌 탭 고르기의 모달 경계 우회(B)를 재현(고치기 전 시험
6 FAIL)하고 고쳤다. Vitest 52파일 969개, 타입·린트 PASS. 실제 IME(Xvfb + ibus-hangul) 리본 탐침 DPR 1.0 22/22·DPR 1.041 IME 21/21+모달 1/1,
`--ime-commands` 18/18, native 리본 14/14 PASS. 실제 키보드 Ctrl+F1은 Xvfb 키맵 한계로 WebDriver 키로 대신했고, 확인 창 배경 누름의 초점 이탈은
기존 한계로 남긴다. 상세: [command-registry.md](../architecture/command-registry.md#t011-안정화-리본-빈-곳-초점모달-중-리본-배치-2026-11-04-ef14f4b-위).
T011 체크와 T007–T010 상태는 바꾸지 않는다.

2026-11-04 확인 창 배경·본문 누름의 초점 이탈(위 안정화의 남은 한계)을 고쳤다(`2ee337c` 위, 고치기 전 시험 2 FAIL). Vitest 52파일 972개, 타입·린트 PASS,
실제 Xvfb + ibus-hangul에서 배경·본문 실제 포인터 뒤 실제 Escape로 닫힘(DPR 1.041·1.0), `--ime-commands` 18/18 PASS. 상세:
[command-registry.md](../architecture/command-registry.md#후속-확인-창-배경본문-누름의-초점-이탈--confirmed-defect-fixed-2026-11-04-2ee337c-위).

2026-11-04 문서 탭·탭 닫기 단추 누름의 초점 이동(T010 마무리 안정화부터 남은 노출)을 고쳤다(`f9df6b8` 위, 고치기 전 시험 2 FAIL). Vitest 52파일 977개,
타입·린트 PASS, 실제 Xvfb + ibus-hangul에서 조합 중 문서 탭 실제 포인터 4/4(DPR 1.041)·탐침 전체 26/26(DPR 1.0), rhwp·WordCraft `--ime` 각 7/7,
`--ime-commands` 18/18 PASS. 상세: [command-registry.md](../architecture/command-registry.md#후속-문서-탭탭-닫기-단추-누름의-초점-이동--fixed-2026-11-04-f9df6b8-위).

2026-11-04 T011 마무리(`789d99a` 위): 모달 중 리본 키보드 이동(탭 줄·도구 모음 roving이 모달 경계를 우회)을 재현(고치기 전 시험 3 FAIL)하고 고쳤다.
Vitest 52파일 982개, 타입·린트 PASS. 전에 NOT RUN이던 실제 X11 창 초점 IME를 실행했다: 외부 zenity X 창으로 실제 초점 이동(Xvfb + ibus-hangul),
HWP·HWPX·DOCX 매트릭스 9/9(DPR 1.041·1.0 각각), rhwp·WordCraft 게이트의 창 초점 항목 PASS(필수 7/7 각각), T011 탐침 26/26, `--ime-commands` 18/18.
창 관리자·Wayland·다른 입력기의 창 초점은 T016 범위로 남긴다. 상세:
[command-registry.md](../architecture/command-registry.md#후속-모달-중-리본-키보드-이동--confirmed-defect-fixed--실제-x11-창-초점-ime-검증-2026-11-04-789d99a-위).

## Handoff

세 기준본과 신규 생성 상세 계약을 함께 읽는다. 현재 로컬 지침·작업 트리·엔진/패치/WASM·테스트 루트·훅을 먼저 확인한다. 기존 코드를 재사용하고 T011 또는 신규 생성의 한 일관된 작업 단위를 구현·검증한다. 원래 체크·ID·과거 근거를 보존하고 제품 활성화는 별도 판단한다. 문서 검토 완료를 실제 기능 완료로 보고하지 않는다.


### T021 실행 수용 — 2026-11-04

T021 COMPLETED: 현재 Release/Debug 각각 HWP/HWPX 생성, 독립 구조/참조·음성 대조군, 기본 편집 및 실제 Rust 안전 저장 2회·최종 파일 reopen PASS. 공개 API로 기본 정의를 초기화하고 생성 전용 CFB 재구성으로 주입된 개인 메타데이터를 제거한다. 출력 신원을 Rust에서 제한하며 기존 저장 보존 정책을 바꾸지 않는다. [상세와 재현](../architecture/new-document-creation.md#t021-실행-수용--2026-11-04), [실행 신원](../architecture/new-document-t021-2026-11-04.json). T022/T023 미완료, native/외부 한컴·Word NOT RUN, T024 DEFERRED 유지.


### T022 제품 통합 수용 — 2026-11-04

T022 COMPLETED: T021 `6c0356e` 이후 형식 선택·bounded IPC·생성 전용 검증·create-only/동일 게시 파일 등록·engine load/first paint/focus lease 연결. ko/en 선택/취소·중복·늦은 탭/창 완료·게시/내구성/등록/편집기 실패 구분. DOCX WordCraft 경로 유지. 최종 frontend 55파일/1,012개, Rust 생성 집중 6개, typecheck/lint/fmt/clippy 및 debug native build PASS. [상세](../architecture/new-document-creation.md#t022-제품-통합-수용--2026-11-04). T023 native 생성/IME 행렬은 NOT RUN이며 다음 게이트다. T024 및 T007–T010 상태 유지.


### T023 native 수용 — 2026-11-04

2026-11-04 T023 **COMPLETED** (T022 `3cd35663b98caa736b81c1792b6c2f5d68f16aeb` 위): 최종 같은 Debug 앱/WASM에서 DOCX/HWP/HWPX native New·GTK 목적지·첫 paint/focus·실제 IBus 한글/영문·삽입/삭제·문단/선택 편집·2회 안전 저장·닫기/native Open·재열기 PASS. 저장/재열기 본문 `한글 Changed Second`, 실패/경합 24개 PASS. 게시 전 취소·dirty 문서와 New 중 창 닫기 모달 중첩·미확정 등록의 잘못된 load 실패 안내를 고치기 전 재현 후 수정했다. frontend55파일/1,016개, Rust255개(기본22 ignored 별도 표기) 및 현재 WASM 생성 집중9개, 타입·린트·fmt·clippy·native build PASS. 최종 native21/23/24/25/26 scope cleanup 성공/잔여0. 실패한 이전 실행과 다른 runtime 결과는 최종 행렬에서 제외했다. [상세 수용](../architecture/new-document-creation.md#t023-최종-native-수용--2026-11-04), [신원·명령·evidence](../architecture/new-document-native-acceptance-2026-11-04.json). 실제 정전·다른 OS/입력기·외부 한컴/Word 호환은 NOT RUN. T007–T010 △/D2·D4 판정과 T024 DEFERRED는 유지. push 없음.

### T021–T023 안정화 — 2026-11-04

T023 이후 후속 수정이며 T021–T023 완료 기록과 T007–T010·T024 상태는 바꾸지 않는다. (1) 창 닫기 중 성공한 생성을 `FilePublishedUnregistered`로 잘못 보고하던 결함을 고쳤다. (2) 진행 중 New가 내구성 미확인으로 끝날 때 낡은 창 닫기 결정으로 창이 파괴되던 경합을 재현하고, 다시 확인을 받도록 고쳤다. (3) RHWP 미검증 출력과 생성 API 부재를 구분해 보고하고, 형식 선택에서 제공하지 않는다. Rust digest 경계는 유지한다. [상세·검증](../architecture/new-document-creation.md#t023-이후-안정화--2026-11-04).

### T021–T023 2차 안정화 — 2026-11-04

후속 수정이며 T021–T023 완료 기록과 T007–T010·T024 상태는 바꾸지 않는다. (1) 복구 복원이 게시된 뒤 열기에 실패하면 `RestoredUnopened`로 알리고 창 닫기를 되돌린다. (2) 생성 증거 출력은 실행마다 새 디렉터리에 배타 생성한다(과거 `prepared.hwp` 덮어쓰기 사고 기록 포함). HWP 준비 출력 차이는 CFB `BodyText` 시각 필드뿐임을 확인했다. (3) 창 닫기 확인에서 생성 직후 내구성 미확인과 메모리 편집을 구분한다. (4) 공유 `HwpDocument.createEmpty`가 없으면 HWP·HWPX를 함께 막는다. 형식별 digest 거절은 독립이다. [상세·검증](../architecture/new-document-creation.md#2차-안정화--2026-11-04).

### T021–T023 3차 안정화 — 2026-11-04

복구 복원의 두 소유권 경계를 고쳤다. T021–T023·T007–T010·T024 상태는 바꾸지 않는다. (1) 위치 선택 중 창 닫기가 확정되면 게시 전에 복원을 취소한다. 선택기 응답만 주입한 native 재현은 수정 전 실패·수정 후 PASS다. 실제 GTK modal 선택기에서는 Xvfb/X11에서 닫기 요청이 전달되지 않아 도달할 수 없었다. (2) 복원 뒤 `AlreadyOpen`은 외부 교체로만 생기는 이전 문서이므로 채택하지 않고 `RestoredUnopened`로 알린다. [상세](../architecture/new-document-creation.md#3차-안정화--2026-11-04).
