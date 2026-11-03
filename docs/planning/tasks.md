# Tasks: HWP/HWPX + DOCX 통합 편집기

Input: [spec.md](./spec.md), [plan.md](./plan.md).
Updated: 2026-11-03; 검토 기준 `8d3f21a2b4aed80c070a6ad874db479365e96caf`.

## Execution Context
Implementation model: Not specified
Reasoning effort: Not specified
Profile: balanced
Selection basis: 기존 구현 계획 유지. 특정 실행 모델이나 실행 성공을 뜻하지 않는다.
Repository context: `MinGyu2/geul`, `master`. 기본 UI·RHWP/WordCraft 편집 표면·제한된 저장·파일 작업·복구·문서 상태 UI는 구현되어 있다. 미체크는 코드 부재와 동의어가 아니다. 사용자 로컬 작업 트리나 미공개 원시 로그를 이번 문서 편집에서 재검증한 것은 아니다.

수정 전 전체 작업 설명·계약·검증 기록은 [tasks.snapshot-8d3f21a.md](./tasks.snapshot-8d3f21a.md)에 원래 Git blob `70f7ce8d7741195bde61711d9ba1f0e6cbf545db` 그대로 보관한다. 별도 활성 tasks가 아니며, 날짜별 결과를 삭제하거나 새 실행 결과로 바꾸지 않는다. 아래 현황은 이력과 현재 계약을 구분하기 위한 정정이다.

## Phase 1: Setup
- [x] T017 실제 저장소·두 submodule·고정 버전·기준본 확인 — `README.md`
- [x] T018 민감정보 차단 규칙과 회귀 검증 — `scripts/check-sensitive-info.py`
- [ ] T019 로컬·원격 공개 보안 게이트 — `.github/workflows/security-scan.yml` (L 완료 이력, R 전체 미완료)
- [x] T020 훅 우회 위험·이력 노출·유출 대응 문서화 — `docs/development/security-incident.md`
- [x] T001 WordCraft API·렌더·라이선스·고정 커밋 검토 — `docs/upstream/wordcraft.md`
- [x] T002 rhwp 저장·렌더·입력 API·라이선스 검토 — `docs/upstream/rhwp.md`
- [x] T003 표면/IME/렌더 경계·PoC 중단 조건 정의 — `docs/architecture/editor-surface-decision.md`

## Phase 2: User Story 1 - 기본 UI와 다국어 (Priority: P1)
Independent Test: 6영역·패널 상호작용·언어 전환·설정 복원을 실제로 검증한다.
- [x] T004 [US1] Tauri/React 6영역 화면·패널 구축 — `src/App.tsx`
- [x] T005 [US1] 번역 JSON·fallback·설정 복원 — `src/language/`

## Phase 3: User Story 2 - 문서 기본 편집 (Priority: P1)
Independent Test: 각 표면의 원래 PoC와 지원 문서의 IME→저장→재열기, 미지원 문서의 안전 거절을 구분해 검증한다.
- [x] T006 [US2] 포맷 판별·독립 세션·어댑터 계약 — `src/adapters/`, `src-tauri/src/document/` (T006 당시 엔진 미연결은 과거 범위; 현재 T007/T008 구현에는 연결 존재)
- [ ] T007 [US2] RHWP HWP/HWPX 편집 표면 수용 — `src/components/Editor/rhwp/` (부분 통과·미완료)
- [ ] T008 [US2] WordCraft W-A native raster/hit-test + Tauri IPC 편집 표면 수용 — `src-tauri/src/adapters/`, `src/components/Editor/wordcraft/` (부분 통과·미완료; egui 임베딩 아님)
- [ ] T009 [US2] 포맷별 안전 저장·재열기 수용 — `src-tauri/src/services/` (구현·대표 왕복 근거 존재; 선행 조건·전체 범위 미완료)

## Phase 4: User Story 3 - 공통 명령 및 리본 (Priority: P1)
Independent Test: 두 엔진 명령·선택 상태·미지원 차단과 SC-003을 실제로 확인한다.
- [ ] T010 [US3] 공통 명령 레지스트리·Undo/Redo·서식 — `src/commands/` (**INCOMPLETE — ON HOLD**; 제품 RHWP Undo/Redo **NO-GO**)
- [ ] T011 [US3] 공통 리본·상황별 도구 연결 — `src/ribbon/`, `src/components/Ribbon/` (**NOT STARTED**; T010 선행 조건 유지)

## Phase 5: User Story 4 - 고급 기능 (Priority: P2)
Independent Test: 실제 엔진 API와 문서 왕복을 검증한 기능만 활성화한다.
- [ ] T012 [US4] 한글 전용 검증 명령 연결 — `src/ribbon/HangulTools/`
- [ ] T013 [US4] DOCX 고급 검증 명령 연결 — `src/ribbon/References/`

## Phase 6: User Story 5 - 데이터 보존 및 출시 (Priority: P1)
Independent Test: 강제 실패·충돌에서 원본 보존, 회귀 매트릭스, 지원 OS 실실행·PDF·고지를 확인한다.
- [ ] T014 [US5] 저장 실패·충돌·복구의 전체 수용 — `src-tauri/src/services/` (상당 부분 구현·검증됨; 신규 구현부터 시작하지 않음)
- [ ] T015 [US5] 형식·서식별 왕복·회귀 매트릭스 — `tests/roundtrip/`, `docs/quality-matrix.md` (전역 완료 아님)
- [ ] T016 [US5] 세 OS 빌드·실행·PDF·라이선스·보안 출시 검증 — `src-tauri/tauri.conf.json`, `docs/release-checklist.md`

## Task Contracts

원래 선행 조건은 그대로다. `T019(L)`은 이미 정의된 로컬 게이트만 의미하며 T019 전체 완료를 뜻하지 않는다. T020/T004에서 이 표기를 제거하거나 T019 전체로 바꾸지 않는다. T008의 잘못된 egui 표현만 실제 W-A 통합 방식으로 정정했다. Files의 tests 경로는 로컬 테스트 루트의 논리 경로이며 모두 공개 Git 추적 파일이라는 뜻이 아니다. 미착수 경로는 기존 구현 목표다.

| Task | Depends on | Requirements | Files | Verify | Done |
|---|---|---|---|---|---|
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
| T008 | T006 | FR-005, SC-002 | src-tauri/src/adapters/, src/components/Editor/wordcraft/, tests/integration/wordcraft/, tests/fixtures/wordcraft/ | IME/커서/선택 및 W-A native raster/hit-test·Tauri IPC 결과 기록 | IME/커서/선택 및 W-A native raster/hit-test·Tauri IPC 결과 검증 성공 및 근거 기록 |
| T009 | T007, T008 | FR-006, FR-015, SC-002 | src-tauri/src/services/, tests/roundtrip/ | 실제 문서 왕복 및 안전한 저장 거절 테스트 | 실제 문서 왕복 및 안전한 저장 거절 테스트 성공 및 근거 기록 |
| T010 | T009, T005 | FR-007, SC-003 | src/commands/, tests/ui/ | 두 엔진 명령 및 미지원 명령 테스트 | 두 엔진 명령 및 미지원 명령 테스트 성공 및 근거 기록 |
| T011 | T010 | FR-008, FR-015, SC-003 | src/ribbon/, src/components/Ribbon/ | 문서 형식·선택별 가용성 확인 | 문서 형식·선택별 가용성 확인 성공 및 근거 기록 |
| T012 | T011 | FR-009 | src/ribbon/HangulTools/, tests/integration/hangul/ | 장평/자간/표 등의 실제 API 지원 결과 기록 | 장평/자간/표 등의 실제 API 지원 결과 기록 성공 및 근거 기록 |
| T013 | T011 | FR-009 | src/ribbon/References/, tests/integration/docx-advanced/ | 참조·검토 등의 실제 지원 결과 기록 | 참조·검토 등의 실제 지원 결과 기록 성공 및 근거 기록 |
| T014 | T009 | FR-006, FR-010, SC-004 | src-tauri/src/services/, tests/integration/save-failure/ | 쓰기 실패와 외부 수정에도 원본 불변 확인 | 쓰기 실패와 외부 수정에도 원본 불변 확인 성공 및 근거 기록 |
| T015 | T012, T013, T014 | FR-011, SC-002, SC-004 | tests/roundtrip/, docs/quality-matrix.md | 텍스트/표/그림/수식/폰트 테스트 기록 | 텍스트/표/그림/수식/폰트 테스트 기록 성공 및 근거 기록 |
| T016 | T015, T019, T020 | FR-011, SC-005 | src-tauri/tauri.conf.json, docs/release-checklist.md | 각 환경 실제 실행 결과와 출고 체크리스트 | 각 환경 실제 실행 결과와 출고 체크리스트 성공 및 근거 기록 |

## Current Evidence and Remaining Work

### T001–T006·T017·T018·T020: 완료 기록 보존

체크박스는 기존 완료 기록을 유지한 것이다. 이번에 엔진 빌드·UI·보안 전체 회귀를 새로 실행했다는 뜻이 아니다. T003은 PoC 계약 정의 완료이지 T007/T008 실실행 완료가 아니다. 이후 엔진 패치·UI·설정 코드 변경의 영향 검증을 각 변경 신원과 함께 관리한다.

### T007/T008: 우선 마감할 기본 표면 수용

[편집 표면 계약](../architecture/editor-surface-decision.md), [native 수용 JSON](../architecture/native-editor-acceptance-2026-11-02.json), [저장 왕복 JSON](../architecture/save-roundtrip-acceptance-2026-11-02.json)을 함께 본다. Linux X11/IBus의 실제 IME·본문/표·DPR 검사와 대표 SC-002 왕복 근거가 존재한다. 최신 HWPX 엔진 패치 후 그 근거가 동일 산출물에 해당하는지는 별도 대조해야 한다.

먼저 요구별로 요구사항, 구현 경로, 필수 환경, 실행 신원, 결과, 잔여 사유를 한 줄씩 연결한다. ‘실제 실행 실패’, ‘시험 환경/producer 실패’, ‘현재 신원 근거 없음’, ‘선택적 확장’을 섞지 않는다. CPU 포화·GPU·Wayland·fcitx5·다른 OS를 검증한 것으로 올리지 않는다. 원래 Linux 우선 계약과 후속 미검증 환경 목록의 책임 범위가 겹치는 부분은 결정이 필요하며, 이번 문서 편집으로 의무를 삭제하거나 체크하지 않는다.

T007을 끝내야 T008을 시작할 수 있는 것은 아니다. 둘 다 T006에 의존한다. 반대로 후속 기능의 제한된 선행 구현이 존재해도 T009/T010의 전체 완료를 선언할 수는 없다. 모든 외부 HWPX 호환성 문제 해결을 T007 완료의 새로운 요구사항으로 추가하지 않는다.

### T009/T014: 구현된 저장·복구를 재작성하지 않는다

[저장 보존 계약](../architecture/save-preservation.md)이 기준이다. HWP preview, HWPX XML/ID/구조 보존, DOCX 원형 보존과 안전 거절이 있다. Linux 파일 대화상자, 새 DOCX, 다른 이름으로 저장, DOCX 복구 체크포인트와 새 사본 복구도 존재한다. 다른 형식의 새 문서나 모든 플랫폼 대화상자·자동 복구를 지원한다고 확대 해석하지 않는다.

다음은 최신 신원의 대표 양성 왕복과 원본 충돌·미지원·게시 실패·fsync·세션 등록 실패·복구 기록 소유권의 음성 수용을 정리하는 것이다. 복구 기록이 남음, rename 성공, 저장 상태 표시를 서로 대신하는 증거로 쓰지 않는다. T014는 T009 이후 별도로 마감 가능하고 T010에 직접 의존하지 않는다. T009/T014 체크는 전체 계약 충족 후만 변경한다.

### T010/T011: 구현·성능 조사와 제품 승인을 분리한다

판정의 단일 기준은 [현재 T010 수용 행렬](../architecture/rhwp-undo-redo.md#t010-current-status)이다. 공통 레지스트리와 WordCraft 서식/Undo 일부는 구현되어 있지만 RHWP 제품 Undo/Redo는 비활성이다. T011 전체는 미착수이며 기존 기본 리본 UI·일부 파일 명령 존재와 혼동하지 않는다.

현재 제품 정책은 `renderPageToCanvas` 기반 FULL_PAGE_ONLY다. 과거 소프트웨어 partial-band PASS를 GPU나 현재 전체 정책의 수용으로 바꾸지 않는다. D1 과거 PASS, D2 INCONCLUSIVE, D3/전체 D5 신원 공백, D4 실패·자원 미결론은 원문의 신원과 한계를 유지한다. 새 [시간 단축 조사](../architecture/t010-performance-followup-2026-11-03.md)는 구체적인 개선 후보·안전성 조건·반증 시험을 기술한 DESIGN ONLY 문서이며 구현·50ms 달성·재개 승인 근거가 아니다.

### T012/T013/T015/T016: 범위와 선행 조건 유지

T012/T013은 T011 이후 실제 지원 API·선택 상태·왕복 안전성에 맞춰 작은 명령 단위로 연결한다. 미지원 명령에 이름만 추가해 완료 처리하지 않는다. T015는 개별 테스트가 없는 상태가 아니라 전역 형식/서식 수용 매트릭스의 완료가 남은 작업이다. T016은 세 OS·PDF·고지·보안의 실제 출고 검증이며 Linux 성공이나 빌드 성공만으로 다른 OS 실행을 대신하지 않는다. 관련 경로의 파일 생성이 필요한지는 착수 때 실제 트리와 다시 대조한다.

### T019: CI 실행 성공과 강제 정책은 다르다

기존 L 완료 기록을 유지한다. 원격 읽기 기준 master의 보호는 꺼져 있었으며 필수 상태 검사 강제의 완료 근거는 없다. 과거 특정 커밋의 quality/security-scan 성공은 해당 커밋 결과일 뿐 T019(R) 전체 완료가 아니다. 이번 문서 작업은 브랜치 보호나 검사 설정을 변경하지 않는다. 사용자 로컬 개발과 원격 공개 게이트의 책임을 구분하되 기존 조건을 몰래 삭제하지 않는다.

### HWPX 최신 기록 정정

이전 tasks의 마지막 ‘빈 hp:t 다음 후보’ 안내는 현재 상태가 아니다. `8d3f21a`의 위상 검증 경계 마감과 [HWPX 수용 JSON](../architecture/hwpx-duplicate-id-acceptance-2026-11-02.json)의 후속 기록을 따른다. 734개 혼합 코퍼스의 157 safe·412 unsafe·156 export-failed·9 unknown은 무편집 왕복/사전 검사 분류이며, 모든 문서의 실제 native 편집·저장·재열기 성공률이 아니다. 통과 출력 578개 동일성도 native 전체 수용을 증명하지 않는다. 기록의 세부 패치·generation과 각 실행의 범위는 JSON을 유지한다.

## Execution Policy

1. 기본 개발 우선순위는 T007/T008의 요구·실행 신원 정합화와 남은 기본 수용이다. T009, T014는 원래 의존성대로 마감한다. T010 반복 실험이나 외부 HWPX 전수 호환성 확장이 이를 대체하지 않는다.
2. 선행 조건이 미충족인 후속 작업은 제한된 조사/부분 구현과 전체 승인 여부를 분리해 기록한다. 공식 의존성을 변경하려면 별도 명시 결정과 계획 동기화가 필요하다.
3. 같은 테스트라도 앱·frontend·WASM·patch·fixture·runtime이 다르면 새 결과와 과거 결과를 구분한다. fixture 일부 재실행을 단일 전체 회귀 PASS로 합치지 않는다.
4. 공식 기준·3RAF·원본 보호·FULL_PAGE_ONLY·원시 실패 기록을 유지한다. 보안 훅이나 민감정보 검사를 생략해 성공으로 기록하지 않는다.

## Verification Log

이번 교정은 문서/정적 근거 대조다. 제품 native/빌드/D1–D5 실행은 NOT RUN이다. 기존 수치와 PASS는 보관본·architecture JSON의 해당 실행 결과다. 현재 상태·역사 기록·설계 가설을 분리하고 20개 작업 ID, 9개 완료 체크, 원래 의존성 및 FR/SC 연결을 점검한다. 범용 계획 검사기가 프로젝트의 `T019(L)` 표기를 지원하지 않으면 이를 없애지 말고 프로젝트 전용 의존성 검사와 범용 검사 한계를 함께 보고한다.

## Handoff

변경 기준 geul SHA와 RHWP gitlink만 기록하지 말고 패치 계열/source tree·WASM generation/hash·앱/표면·시험 신원도 묶는다. 다음 구현자는 기존 체크박스를 근거 없이 바꾸거나 보관본을 새 기준본으로 삼지 않는다. T010 재개/제품 활성화/T011 착수는 이 문서 정리로 승인되지 않는다.
