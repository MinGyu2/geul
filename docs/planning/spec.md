# Feature Specification: HWP/HWPX + DOCX 통합 오픈소스 워드프로세서

Created: 2026-10-13
Status: Revised draft — 기술 PoC, 대상 저장소 검사 및 실제 테스트는 미완료
Input: 기존에 합의한 WordCraft + rhwp 코어, Tauri/React 신규 UI, 6개 영역, 언어별 JSON, `external/` 및 `docs/planning/`, 공개 저장소 민감정보 사전 차단.

## User Scenarios & Testing

### User Story 1 - 기본 UI와 다국어 (Priority: P1)
사용자로서 독립 UI 시작과 언어·패널 변경을 수행할 수 있어야 한다.
Independent Test: 실행 중 언어 전환과 재실행 시 값 복원
Acceptance Scenarios:
1. Given 지원되는 입력과 정상 환경, When 독립 UI 시작과 언어·패널 변경 작업을 요청하면, Then 실행 중 언어 전환과 재실행 시 값 복원 결과가 확인된다.
2. Given 실패/미지원/충돌 조건, When 같은 동작을 요청하면, Then 작업은 데이터 유실 또는 정보 노출 없이 거절되고 사용자가 이유를 확인할 수 있다.

### User Story 2 - HWP/HWPX/DOCX 기본 편집 (Priority: P1)
사용자로서 세 가지 형식에서 문서 열기/입력/저장/재열기을 수행할 수 있어야 한다.
Independent Test: 형식별 왕복 검사 또는 명시적인 읽기 전용 차단
Acceptance Scenarios:
1. Given 지원되는 입력과 정상 환경, When 세 가지 형식에서 문서 열기/입력/저장/재열기 작업을 요청하면, Then 형식별 왕복 검사 또는 명시적인 읽기 전용 차단 결과가 확인된다.
2. Given 실패/미지원/충돌 조건, When 같은 동작을 요청하면, Then 작업은 데이터 유실 또는 정보 노출 없이 거절되고 사용자가 이유를 확인할 수 있다.

### User Story 3 - 공통 명령과 리본 (Priority: P1)
사용자로서 문서 형식에 맞게 서식 명령을 실행을 수행할 수 있어야 한다.
Independent Test: 명령 상태·선택 영역 반영 및 미지원 실행 차단
Acceptance Scenarios:
1. Given 지원되는 입력과 정상 환경, When 문서 형식에 맞게 서식 명령을 실행 작업을 요청하면, Then 명령 상태·선택 영역 반영 및 미지원 실행 차단 결과가 확인된다.
2. Given 실패/미지원/충돌 조건, When 같은 동작을 요청하면, Then 작업은 데이터 유실 또는 정보 노출 없이 거절되고 사용자가 이유를 확인할 수 있다.

### User Story 4 - 형식별 고급 기능 (Priority: P2)
사용자로서 한글 전용 또는 DOCX 고급 기능을 수행할 수 있어야 한다.
Independent Test: 실제 API 지원 명령만 활성화
Acceptance Scenarios:
1. Given 지원되는 입력과 정상 환경, When 한글 전용 또는 DOCX 고급 기능 작업을 요청하면, Then 실제 API 지원 명령만 활성화 결과가 확인된다.
2. Given 실패/미지원/충돌 조건, When 같은 동작을 요청하면, Then 작업은 데이터 유실 또는 정보 노출 없이 거절되고 사용자가 이유를 확인할 수 있다.

### User Story 5 - 데이터 보존 및 출시 (Priority: P1)
사용자로서 저장 실패 및 배포 점검을 수행할 수 있어야 한다.
Independent Test: 원본 보존·회귀 검사 및 OS별 증거
Acceptance Scenarios:
1. Given 지원되는 입력과 정상 환경, When 저장 실패 및 배포 점검 작업을 요청하면, Then 원본 보존·회귀 검사 및 OS별 증거 결과가 확인된다.
2. Given 실패/미지원/충돌 조건, When 같은 동작을 요청하면, Then 작업은 데이터 유실 또는 정보 노출 없이 거절되고 사용자가 이유를 확인할 수 있다.

### User Story 6 - 공개 저장소 보안 (Priority: P1)
사용자로서 공개하기 전 변경 내용 검사을 수행할 수 있어야 한다.
Independent Test: 로컬 테스트 누출 차단 및 PR 검사 정책 확인
Acceptance Scenarios:
1. Given 지원되는 입력과 정상 환경, When 공개하기 전 변경 내용 검사 작업을 요청하면, Then 로컬 테스트 누출 차단 및 PR 검사 정책 확인 결과가 확인된다.
2. Given 실패/미지원/충돌 조건, When 같은 동작을 요청하면, Then 작업은 데이터 유실 또는 정보 노출 없이 거절되고 사용자가 이유를 확인할 수 있다.

### Edge Cases
- 외부 프로그램의 동시 파일 수정, 디스크 공간 부족, 쓰기 권한 거부, 중간 크래시, 확장자와 실제 포맷 불일치.
- 지원되지 않는 그림/수식/차트/SmartArt 및 암호화 문서; 무조건 저장 가능하다고 표시하지 않는다.
- 한글 IME 조합 중 커서 이동, 복합 표 안에서 선택, 고배율, 미설치 폰트, 여러 문서 세션 전환.
- 비밀키와 유사한 공개 문서 예제, 시스템 공용 절대 경로, 표준 문서 URL에서 발생할 수 있는 오탐은 검토형 예외로 관리한다.

## Requirements

### Functional Requirements
- FR-001: Tauri 2와 React/TypeScript로 제작하는 독립 데스크톱 앱에서 상단 바, 리본, 왼쪽 탐색, 중앙 편집기, 오른쪽 속성, 상태 표시줄의 6개 영역을 제공하고 패널 접기·크기 조절을 지원한다.
- FR-002: UI 번역 파일을 `src/language/ko.json`, `src/language/en.json`으로 분리하며 고정 키, 영어 fallback, 즉시 전환, 선택 언어 복원과 번역 키 누락 검사를 제공한다.
- FR-003: WordCraft는 `external/wordcraft/`, rhwp는 `external/rhwp/`에 독립 Git submodule로 등록하고 검토한 커밋을 부모 저장소 gitlink로 고정한다. 버전·라이선스·NOTICE 의무를 기록한다.
- FR-004: HWP/HWPX는 rhwp, DOCX는 WordCraft로 분기하고 문서별 모델·렌더링·편집 히스토리의 엔진 소유권을 독립적으로 유지한다. HOP는 코어가 아닌 참고 사례다.
- FR-005: 두 편집 표면에서 페이지 렌더링, 한국어 IME 조합, 마우스 선택, 커서 hit-test, 키보드 조작, 표 안 이동 가능성을 각기 PoC로 검증한다. 검증 실패 시 고급 기능 구현을 중단한다.
- FR-006: 지원 가능한 문서는 열기·편집·원본 형식 저장·재열기를 제공하고, 손실 우려·지원하지 않는 개체·쓰기 불가 문서는 읽기 전용으로 전환하거나 저장을 차단하며 원본을 보호한다.
- FR-007: Command Registry는 변하지 않는 명령 ID, 국제화 라벨 키, 단축키, 엔진별 capability, 선택 영역 및 상태를 통합한다. 미지원 명령은 실행되지 않는다.
- FR-008: WordCraft 스타일의 공통 리본(파일·홈·삽입·그리기·디자인·레이아웃·참조·편지·검토·보기·도움말)과 상황별 메뉴를 설계하되 실제 엔진 기능에 따라 표시/비활성화를 결정한다.
- FR-009: HWP/HWPX 전용 한글 도구(장평·자간·조판·표 계산 등)와 DOCX 고급 기능은 실제 API·문서 왕복 검증이 된 항목부터 제공한다.
- FR-010: 저장 시 문서 revision과 디스크 버전 충돌을 검사하고, 가능하면 동일 파일시스템에 임시 사본을 작성·검증·원자적 교체한다. 실패하면 원본을 보존하고 복구 사본을 별도 관리한다.
- FR-011: HWP/HWPX/DOCX 대표 샘플 및 손상·암호화·표·그림·수식·폰트·IME 회귀 테스트와 지원 플랫폼(Windows/macOS/Linux)의 실제 빌드·실행·PDF 출력 검증을 수행한다.
- FR-012: 프로젝트 전체 계획 문서는 `docs/planning/spec.md`, `docs/planning/plan.md`, `docs/planning/tasks.md`만을 기준본으로 관리한다. `src/`, `src-tauri/`, `external/`, `docs/`, `tests/`, `scripts/`를 독립적으로 배치한다.
- FR-013: 공개 저장소 커밋 전 변경 파일의 비밀키·인증정보·개인 홈 절대 경로·내부 주소·개인정보 노출을 검사하며 최초 공개 전 전체 파일과 Git 이력을 검사한다. 발견되면 기본적으로 커밋/병합을 차단하고 수동 검토 후 예외를 허용한다.
- FR-014: 공개 저장소의 로컬 훅을 우회하거나 GitHub Actions 실행 전 푸시하는 경로를 고려한다. 최초 공개 및 커밋/푸시/PR 단계의 다중 검사를 실시하고 누출된 비밀은 이력 정리만이 아니라 폐기·재발급한다.
- FR-015: 초기 버전은 HWP↔DOCX 및 HWPX↔DOCX 파일 형식 상호 변환과 공동 편집을 제공하지 않는다. PDF 내보내기는 형식 변환과 분리된 출력 기능이다.

## Success Criteria

### Measurable Outcomes
- SC-001: 6개 영역이 표시되고 패널 설정과 ko/en 변경이 재시작 이후 복원되는 UI 검사가 통과한다.
- SC-002: HWP/HWPX/DOCX별 최소 1개의 대표 문서에 대해 열기→IME 입력→저장→재열기 및 문서 구조 비교 결과가 기록된다. 손실이 있으면 차단/읽기 전용 처리 근거가 남는다.
- SC-003: 공통 서식 명령(예: 굵게)과 실행 취소, 미지원 명령 처리가 각각 실제 대상 엔진에서 검증된다.
- SC-004: 쓰기 중 강제 실패와 외부 수정 충돌 시 원본 바이트가 유지되고 오류 및 복구 사본 상태가 확인된다.
- SC-005: Windows/macOS/Linux 실제 환경에서 앱 시작, 샘플 파일 열기·저장, PDF 내보내기 및 라이선스 고지 점검이 완료된다.
- SC-006: 계획 문서가 `docs/planning/`에만 기준본으로 존재하고 두 submodule의 gitlink 및 고정 SHA가 확인되며 코어 중복 복사가 없다.
- SC-007: 의도적으로 만든 테스트용 비밀·개인 홈 경로가 사전 검사에 걸리고 허용되는 상대 경로와 공개 시스템 경로는 통과하며, 비밀 본문은 로그에 노출되지 않는다.
- SC-008: 최초 공개 체크리스트, 우회 위험, 누출 대응 및 PR 필수 검사 정책이 문서화되고 테스트용 누출 샘플에 대한 검사 결과가 보존된다.

## Assumptions
- WordCraft와 rhwp의 README는 현재 작업 방향의 참고 근거이나 앱 내 공개 API·입력·렌더링·저장 충실도는 통합 후 별도 검증 대상이다.
- WordCraft README상 라이선스는 MIT OR Apache-2.0, rhwp README/Cargo.toml상 라이선스는 MIT로 표시된다. 실제 선택 커밋과 추가 자산/의존성의 조건을 확인한다.
- Git submodule은 소스 관리 방식일 뿐 앱에서 로딩/링크가 자동 제공되지는 않는다.
- 프로젝트 실명·상태 관리 라이브러리·실제 구성은 아직 결정하지 않았다.

## Out of Scope
- 초기 버전에서 HWP↔DOCX 및 HWPX↔DOCX 변환, 실시간 공동 편집, 클라우드 동기화.
- 두 코어의 문서 모델 통합 또는 외부 원본 UI의 그대로 재배포.

