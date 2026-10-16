# Tasks: HWP/HWPX + DOCX 통합 편집기

Input: [spec.md](./spec.md), [plan.md](./plan.md).

## Execution Context
Implementation model: Not specified
Reasoning effort: Not specified
Profile: balanced
Selection basis: uncalibrated default
Repository context: target repository not inspected; paths are proposals.

## Phase 1: Setup
- [ ] T017 실제 저장소 초기화·두 submodule 등록·고정 버전·기준본 확인 — `README.md`
- [ ] T018 변경 파일/민감 홈 경로/테스트 토큰 차단 규칙 작성 및 fixture 검사 — `scripts/check-sensitive-info.py`
- [ ] T019 PR CI와 최초 공개 전체 스캔/기록 점검 정책 추가 — `.github/workflows/security-scan.yml`
- [ ] T020 Git 훅 우회/이력 노출/유출 시 키 폐기와 복구 절차 문서화 — `docs/development/security-incident.md`
- [ ] T001 WordCraft 공개 API/렌더 계층/NOTICE/고정 커밋 검토 — `docs/upstream/wordcraft.md`
- [ ] T002 rhwp HWP/HWPX 저장/렌더/입력 API와 라이선스 검토 — `docs/upstream/rhwp.md`
- [ ] T003 엔진별 편집 표면/IME/렌더 경계와 PoC 중단 조건 명시 — `docs/architecture/editor-surface-decision.md`

## Phase 2: User Story 1 - 기본 UI와 다국어 (Priority: P1)
Independent Test: 해당 User Story의 acceptance scenario와 실패 조건을 실제 실행으로 확인한다.
- [ ] T004 [US1] Tauri/React 6영역 화면과 패널 인터랙션 구축 — `src/App.tsx`
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
| T019 | T018 | FR-013, FR-014, SC-008 | .github/workflows/security-scan.yml, docs/development/security-policy.md | 시뮬레이션 PR 검사 실패·브랜치 보호 설정 확인 | 시뮬레이션 PR 검사 실패·브랜치 보호 설정 확인 성공 및 근거 기록 |
| T020 | T019 | FR-014, SC-008 | docs/development/security-incident.md, scripts/check-sensitive-info.py | 테스트 저장소에서 실패 사례 시뮬레이션하고 기록 | 테스트 저장소에서 실패 사례 시뮬레이션하고 기록 성공 및 근거 기록 |
| T001 | T017 | FR-003 | docs/upstream/wordcraft.md, docs/licenses/wordcraft.md | 모듈·라이선스·기여자 고지 및 API 후보 표 | 모듈·라이선스·기여자 고지 및 API 후보 표 성공 및 근거 기록 |
| T002 | T017 | FR-003 | docs/upstream/rhwp.md, docs/licenses/rhwp.md | HWP·HWPX 읽기 및 쓰기 지원 수준 구분 | HWP·HWPX 읽기 및 쓰기 지원 수준 구분 성공 및 근거 기록 |
| T003 | T001, T002 | FR-005 | docs/architecture/editor-surface-decision.md, tests/fixtures/README.md | 별도 PoC 실행 경로와 테스트 데이터 확정 | 별도 PoC 실행 경로와 테스트 데이터 확정 성공 및 근거 기록 |
| T004 | T003, T019 | FR-001, SC-001 | src/App.tsx, src/components/ | 앱 실행 및 6영역/패널 UI 검사 | 앱 실행 및 6영역/패널 UI 검사 성공 및 근거 기록 |
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
| T016 | T015, T020 | FR-011, SC-005 | src-tauri/tauri.conf.json, docs/release-checklist.md | 각 환경 실제 실행 결과와 출고 체크리스트 | 각 환경 실제 실행 결과와 출고 체크리스트 성공 및 근거 기록 |

## Dependencies & Execution Order
T017(프로젝트+submodule) → T018(로컬 사전 검사) → T019(PR CI/공개 전 정책) → T020(사고 대응). T001/T002는 T017 이후에 병렬 조사 가능하며 T003에서 기술 게이트를 결정한다. T007/T008을 통과하기 전에는 T010 이후의 고급 UI 구현을 확대하지 않는다. 보안 검사 훅은 초기 커밋 전에 활성화하고 외부 소스를 복제한 후에는 라이선스/공급망 위험을 별도 검토한다.

## Execution Policy
- 완료 체크박스는 검증 증거 없이 선택하지 않는다. 기존 T001~T017 ID는 유지하고 새 보안 작업만 T018~T020에 추가한다.
- 전체 저장소 최초 공개 전 검사와 변경 파일 사전 훅 검사, CI 검사는 서로 대체하지 않는다. 강제 푸시/훅 우회/최초 공개 누출에 대비한다.
- 프로젝트 상대 경로만 문서에 사용한다. 테스트용 홈 경로는 실제 사용자명 대신 `<USER>`를 사용하고 스캐너 예외는 근거를 문서화한다.
- API 키가 노출되면 Git 이력에서 삭제하는 것만으로 종료하지 말고 키 폐기·재발급·영향 점검을 먼저 수행한다.
- git submodule 포인터를 업스트림 이동 브랜치가 아닌 검토한 커밋에 고정한다.
- 동일 장애에 진전 없는 수정을 두 차례 반복하면 중지하고 근거와 차단 원인을 보고한다.

## Handoff
- `docs/planning/`의 세 기준 문서와 실제 대상 저장소의 AGENTS.md, constitution, CI 정책을 먼저 확인한다. 기존 구현과 충돌하면 diff/backups를 만들고 승인된 변경만 병합한다.
- Spec Kit을 별도로 쓰는 경우 로컬 feature 경로와 버전을 검사하고 이 세 기준 문서를 덮어쓰기 없이 채택/대조한다. 실제 명령/훅이 존재하는지 확인한다.
- 분석과 구현 테스트는 별개이며 빌드·실행·무손실 검증을 하지 않았다면 완료라고 보고하지 않는다.

