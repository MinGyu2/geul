# Implementation Plan: HWP/HWPX + DOCX 통합 편집기

Date: 2026-10-13
Spec: [spec.md](./spec.md)
Status: Revised draft — 2026-10-16 실제 저장소 검사, submodule 고정, 보안 게이트 로컬 구현·2차 재검토 완료(원격 브랜치 보호는 미설정), Tauri/React 6영역 UI 기반(T004) 구현. 엔진 통합·문서 열기/저장은 미착수

## Summary
WordCraft는 DOCX, rhwp는 HWP/HWPX 전용 엔진으로 독립 관리한다. Tauri 2 + React/TypeScript 6개 영역 UI에 문서별 어댑터, 공통 명령/상태 계층을 결합한다. 고급 리본보다 렌더·IME·선택·쓰기 무손실 검증과 공개 저장소 보안 게이트를 우선한다.

## Technical Context
- UI: React, TypeScript; desktop: Tauri 2/Rust; language: `src/language/ko.json`, `src/language/en.json`.
- Two core repos: https://github.com/storytold/wordcraft, https://github.com/edwardkim/rhwp. HOP는 설계 참고만.
- 공개 README 확인(2026-10-13): WordCraft는 `wordcraft-doc`, `wordcraft-docx`, `wordcraft-layout`, `wordcraft-render`, `wordcraft-engine`, `wordcraft-ui-egui`로 분리된 것으로 설명하며 Rust egui UI와 웹 WASM 앱을 제공한다. rhwp는 Rust/WASM, HWP/HWPX 렌더·편집·쓰기 경로를 설명한다. **구체적 API를 앱에서 호출해 본 것은 아니다.**
- 라이선스 표기: WordCraft MIT OR Apache-2.0, rhwp MIT. 선택 커밋의 라이선스/서드파티 NOTICE/에셋을 다시 확인한다.
- 고정 커밋(2026-10-16 검토): WordCraft `fc41918814f62645b6746ed68e71e8c2c2e85d6f`(`v0.7.0`), rhwp `1a76570e833917d15817415a53c09ad61ab3203f`(`v0.8.7`). 두 커밋의 라이선스 표기는 위와 일치함을 확인했다([docs/licenses/](../licenses/)). 상세 검토: [docs/upstream/](../upstream/), 편집 표면 결정: [editor-surface-decision.md](../architecture/editor-surface-decision.md).
- 확인된 개발 환경(2026-10-16): Node 24, npm 11, Rust 1.99(rhwp는 `rust-toolchain.toml`로 1.93.1 고정 — 호환성 미검증), Python 3.14, Linux WebKitGTK 2.54(webkit2gtk-4.1). 앱 의존성: tauri `=2.12.1`, tauri-build `=2.7.1`, @tauri-apps/cli 2.12.1, React 19.3.0, Vite 8.3.2, TypeScript 6.0.3(typescript-eslint가 6.1 미만만 지원), Vitest 5.0.3. 직접 의존성은 정확한 버전으로 고정하고 게시 후 14일 이상 지난 버전만 골랐다(전이 의존성은 lockfile로 고정하되 이 기준은 적용하지 못함). 앱 빌드·실행 명령은 README `개발 환경` 절.

## Constitution Check
2026-10-16 검사: 저장소에 `AGENTS.md`나 constitution 문서가 없다. 계획 체계는 `docs/planning/`의 세 문서만 사용하며 Spec Kit 등 별도 계획 프레임워크는 사용하지 않는다.

작업 흐름: `spec.md` → `plan.md` → `tasks.md` → 구현 → 테스트 → `tasks.md` 검증 기록 → 로컬 Git 커밋. 세 문서는 직접 수정하고, 기존 FR/SC/작업 ID는 유지한다.

## Architecture
```
Tauri desktop host (OS file dialogs / permissions / safe file writes)
  React UI: TitleBar | Ribbon | NavigationPanel | EditorSurface | PropertiesPanel | StatusBar
  LanguageManager: locale JSON; UI language independent of document text
    (T005: App이 언어 상태를 소유하고 LanguageProvider가 `t()`를 내려 줌. 상태에는 번역 문자열 대신 Message(키+변수) 저장.
     en.json이 기준 사전이며 빠지거나 빈 번역은 영어로, 영어에도 없으면 키를 표시하고 개발 빌드에서 경고)
  SettingsStore: WebView localStorage `geul.settings` (version 1: language, 패널 표시·선호 너비, 리본, 테마, 배율).
    처음 그리기 전에 읽어 항목별 검사(잘못된 항목만 기본값), 바뀔 때만 저장(시작 시 쓰지 않음),
    저장 실패 시 이번 실행만 적용하고 상태 표시줄에 1회 알림(다시 저장되면 그 알림만 지움). 창 크기로 줄어든 실제 너비는 저장하지 않음.
    복원 결과를 absent/restored/recovered/malformed/unsupported/unreadable로 구분해 첫 실행·정상 복원 외에는
    시작 시 알림. 더 새로운 버전(정수 version > 1)과 읽지 못한 저장소는 덮어쓰지 않음(이번 실행만 적용, 이전 버전으로 바꾸기·지우기 없음).
    저장소에 있다고 확인한 원문(시작 시 읽은 값, 이후 쓰기에 성공한 값)을 기준으로 두고, 쓰기 전에 다시 읽어 다르면 충돌로 보고
    이번 실행 동안 쓰지 않음(병합·덮어쓰기 없음). 보정·기본값으로 돌아온 것만으로는 저장된 것으로 보지 않음. 진단 문구에 저장값 없음.
    한계: localStorage에 compare-and-swap이 없어 다시 읽기와 쓰기 사이의 변경은 막지 못하고, WebKitGTK에서는 동시에 실행한 다른
    geul 프로세스의 변경이 보이지 않아 감지하지 못함(마지막에 쓴 값이 남음). 단일 인스턴스 강제나 Rust 쪽 잠금 저장소는 후속 결정
  CommandRegistry: stable command ids, per-engine capability, shortcut, selected-state
  DocumentController: session id, active format, revision, dirty flag, file fingerprint
    +-- RhwpAdapter --> rhwp Core (HWP/HWPX, independent model + render surface)
    +-- WordCraftAdapter --> WordCraft Core (DOCX, independent model + render surface)
```
- 에디터 화면은 두 엔진의 렌더/커서/입력 특성을 보존한 형식별 표면이다. React UI가 네이티브 Rust 엔진 내부 데이터 모델에 직접 접근하지 않는다.
- WordCraft egui를 React로 재사용 가능하다고 가정하지 않는다. 이음매(이미지/scene/page raster+hit-test 또는 별도 편집 표면)를 PoC로 비교한다.
- Tauri 명령 권한/파일 접근 허용 범위는 최소화한다. 경로 입력은 상위 앱에서 검증한다.
- 문서별 session ID+revision이 명령 응답과 렌더 이벤트에 포함되어 이전 세션 비동기 응답을 버린다.

## Data Flow
1. 파일을 선택→확장자와 파일 헤더 확인→DocumentController에서 엔진 결정→인코딩 오류를 명시적으로 처리한다.
2. 열기 성공→세션과 문서 capability 조회→엔진별 EditorSurface 생성→리본 상태 표시.
3. 리본/단축키 실행→capability 점검→선택 세션의 엔진 명령 실행→새 revision·selection 상태만 UI에 반영.
4. 저장→저장 가능 여부/손실 위험 preflight→별도 임시 경로 작성→형식·문서 구조 검증→원본 디스크 fingerprint 재확인→안전한 교체→revision이 같을 때만 dirty 해제.
5. 실패→원본 보존, 임시 사본/복구 파일의 처리, UI 오류 코드 기록. 검증할 수 없는 포맷은 쓰기 차단 또는 제한된 저장(별도 사본 및 명시적 확인) 정책 결정.

## Interfaces
Conceptual contract only; this is **not** an existing WordCraft/rhwp public API:
```ts
type Format = 'hwp' | 'hwpx' | 'docx';
type Capability = 'supported' | 'unavailable' | 'unsafe-save';
interface EditorAdapter {
  open(path: string): Promise<{sessionId: string; format: Format; revision: number}>;
  capabilities(sessionId: string): Promise<Record<string, Capability>>;
  execute(sessionId: string, commandId: string, args?: unknown): Promise<{revision: number}>;
  selection(sessionId: string): Promise<unknown>;
  save(sessionId: string, outputPath: string): Promise<{revision: number}>;
  close(sessionId: string): Promise<void>;
}
```
- Error keys: `UnsupportedFormat`, `UnsupportedCommand`, `UnsafeSave`, `ParseFailure`, `SaveFailure`, `FileConflict`, `StaleSession`.
- Tauri IPC에 보낼 것은 안정적인 커맨드/세션 ID와 경계 검사된 데이터이며 임의의 파일시스템 경로·셸 명령을 UI에서 그대로 신뢰하지 않는다.

## Algorithms and Pseudocode
```
open(path):
  kind = detect_format_using_extension_and_header(path)
  adapter = adapter_for(kind)
  session = adapter.open(path)
  register_session(session); render_surface_for(kind)
execute(command, session):
  if capability(command, session) != supported: fail safely
  response = adapter.execute(session.id, command)
  if response.revision >= session.revision and active_session_matches(): update_ui()
save(session):
  if unsafe_or_unsupported: block_with_reason()
  write_to_temp(); validate_readback_and_required_structure()
  if original_changed_on_disk(): fail_as_conflict()
  safely_replace_if_supported(); preserve_original_on_failure()
```
- 파일 검증·원자적 대체는 OS/볼륨 및 사용 중인 파일에 따라 보장 방식이 다르므로 해당 플랫폼별로 구현하고 실제 중단 테스트를 한다.

## Error Handling
- 손상/암호화/지원 외 개체는 읽기 전용 또는 안전한 오류 응답; 문서 손실 경고 없이 조용히 저장하지 않는다.
- 읽기 가능한 HWPX라 해도 원본 보존 및 저장 안전성 검증을 통과한 경우에만 쓰기 활성화한다.
- 동시 파일 변경과 중간 저장 실패에서는 사용자가 충돌·복구 상태를 확인할 수 있어야 한다.
- 보안 검사에서 토큰이 발견되면 실제 값을 로그에 그대로 출력하지 않고 파일·줄·유형·마스킹된 내용만 보고한다.

## Project Structure
Actual project-root layout (2026-10-16, T004 이후). `(예정)`은 아직 만들지 않은 경로다.
```
geul/
├── docs/
│   ├── planning/{spec.md,plan.md,tasks.md}  # single canonical planning set
│   ├── architecture/ upstream/ licenses/
│   └── development/{security-policy.md,security-incident.md}
├── external/
│   ├── wordcraft/                      # pinned Git submodule, DOCX
│   └── rhwp/                           # pinned Git submodule, HWP/HWPX
├── src/                                # React + TypeScript UI
│   ├── App.tsx                         # 6영역 조립, 단축키(Ctrl+F1), 패널 초점 처리
│   ├── components/{TitleBar,Ribbon,NavigationPanel,Editor,PropertiesPanel,StatusBar,Splitter,CommandButton}/
│   ├── ribbon/definitions.ts           # 공통 리본 탭·그룹·명령 정의(엔진 비의존)
│   ├── commands/commands.ts            # UI 명령 실행 경계, 문서 명령은 모두 unavailable
│   ├── language/{en.json,ko.json,index.ts,LanguageContext.tsx}  # en 기준·fallback, 반응형 t()(T005)
│   ├── settings/{settings.ts,usePersistedSettings.ts}          # 버전 1 UI 설정 검사·저장·복원(T005)
│   ├── hooks/                          # 배치 상태(reducer), 창 너비, roving focus
│   ├── styles/app.css  assets/icons.tsx  test/setup.ts
│   ├── adapters/ dialogs/              # (예정) T006 이후
├── src-tauri/                          # Rust host: 명령(IPC) 없음, capability core:default, CSP
│   ├── src/{main.rs,lib.rs}            # commands/ document/ adapters/ services/ 는 T006 이후 (예정)
│   ├── capabilities/default.json  icons/  tauri.conf.json  Cargo.toml  Cargo.lock
├── tests/{security,fixtures,e2e}/      # ui/ integration/ roundtrip/ 는 (예정)
├── scripts/{check-sensitive-info.py,security-scan-ci.sh}
├── .github/workflows/{security-scan.yml,quality.yml}
├── .gitleaks.toml  .pre-commit-config.yaml  .sensitive-info-allowlist  .gitignore
└── package.json  package-lock.json  vite.config.ts  tsconfig.json  eslint.config.js  index.html
```
- `.gitmodules`는 `git submodule add`로 생성했고, `external/wordcraft`와 `external/rhwp`는 검토한 커밋에 고정된 gitlink다(엔진 소스는 상위 저장소에 복사하지 않음). 보안 검사 구성: `scripts/check-sensitive-info.py`, `scripts/security-scan-ci.sh`, `tests/security/`, `.gitleaks.toml`, `.pre-commit-config.yaml`, `.github/workflows/security-scan.yml`.
- `docs/planning/`은 명시적으로 사용자가 합의한 유일한 기준 경로다. Spec Kit 전용 디렉터리(`.specify/`, `specs/`)는 만들지 않는다.
- `external/` 아래에서는 코어를 직접 변경하지 않고 가능한 한 새 `src/` / `src-tauri/` 어댑터에서 대응한다.

## Public Repository Security Policy
- 최초 공개 전: 소스·문서·설정 및 이미 존재하는 Git 이력 전체에서 secret/path/private info 검사; 노출된 토큰 폐기/재발급.
- 로컬 pre-commit: staged 콘텐츠 검사(가능한 즉시 실패), 비밀 값 마스킹, 최소 allowlist. 로컬 훅은 우회 가능함을 경고.
- 로컬 pre-push: 추적 파일과 모든 ref의 전체 이력(자체 검사기 + Gitleaks). 나중 커밋에서 지운 비밀과 함께 푸시되는 다른 ref의 이력도 검사한다.
- 예외 목록은 검사 대상과 같은 스냅샷(인덱스/추적 작업 트리/HEAD)에서 읽고, 사유 없는 예외·넓은 glob은 오류로 처리한다. 검사하지 못한 내용(바이너리, 한도 초과, 읽기 실패)은 통과로 보지 않는다.
- CI: Push/PR 검사, branch ruleset/필수 상태 검사, 권한 최소화. CI는 최초 푸시 이전의 유출을 차단하지 못함. 기본 브랜치는 `master`(2026-10-16 확인)이며 필수 상태 검사 이름은 `민감정보 검사`.
- 게이트 구분: 로컬 게이트(T019 L — 훅·CI 스크립트·시뮬레이션)는 앱 개발 전에, 원격 공개 게이트(T019 R — Actions 실행·브랜치 보호·필수 상태 검사)는 출시(T016) 전에 충족한다.
- `C:\Users\<USER>\...`, `/Users/<USER>/...`, `/home/<USER>/...` 유형 사용자 홈 절대 경로 검출; 공용 시스템 경로와 repo 상대 경로는 허용. 예제 표기 `<USER>` 자체는 문서용 placeholder이므로 규칙에서 검토 후 허용 가능.
- `.gitignore`는 이미 stage/commit된 파일이나 파일 내부 비밀을 검사하지 않는다. 전체 이력 검사와 새 커밋 검사는 별도다.
- Gitleaks 및 홈 절대 경로용 프로젝트 검사기를 조합하고, CI/로컬 테스트에서 가짜 비밀을 검출하는 회귀 시나리오를 준비한다.
- 외부 submodule 저장소의 과거 Git 이력은 상위 repo 검사와 별개의 공급망/라이선스 검토 대상으로 삼는다.

## Testing and Verification Strategy
- PoC 게이트: 세 형식 각각 렌더→IME 입력→선택→저장→재열기, 엔진 UI 통합 장애 기록. 대규모 UI 확장보다 선행.
- 기능 회귀: 상대 경로, 번역 누락, capability, Undo, 파일 충돌, 저장 실패, 필수 개체 보존과 원본 해시 비교.
- 보안 회귀: stage 검사, CI 실패 판정, 첫 공개 이력 검사, 오탐 허용 사유, 토큰 로그 마스킹.
- 실제 배포/OS 테스트: Windows/macOS/Linux 앱 실행·파일 열기/저장·PDF 출력; 서드파티 고지와 라이선스 재확인.
- 앱 셸(T004): 타입 검사, ESLint, Vitest 31개, Vite 빌드, cargo fmt/check/clippy, Tauri 디버그 빌드, 실제 앱 WebDriver 스모크 테스트(21개 통과, 최소 높이 검사 1개는 창 관리자가 크기 변경을 반영하지 않아 건너뜀; Linux WebKitGTK, 번들 빌드와 개발 서버 모드)를 실행했다. Windows/macOS 실행과 엔진 빌드(L3), 문서 왕복 테스트(L4)는 **NOT RUN**. CI: `security-scan`(원격에서 `455c985`·`bc9e593` 실행 성공)과 `quality`(프런트엔드·Rust 검사, 2026-10-16 추가 — 로컬에서 같은 명령을 실행해 통과, GitHub에서는 **NOT RUN**). 엔진 빌드 검사는 T007/T008에서 추가한다.
- 레이아웃 계산은 `computePanelLayout()` 하나가 그리는 너비와 크기 조절 범위를 함께 만든다. 실제 앱 최소 창(960×600) 검사는 타일링 창 관리자에서 창 크기 변경이 무시되므로 헤드리스 weston에서 실행한다.
- 보안 회귀(로컬)는 실행됨: 검사기 단위 테스트 86개(2026-10-16 4차 검토 기준), pre-commit 훅 차단, pre-push 훅 시뮬레이션 10개 시나리오, 누출 대응 시뮬레이션(결과는 tasks.md Verification Log). GitHub Actions는 커밋 `455c985`에서 1회 성공했고, 이후 로컬 커밋은 푸시하지 않아 **NOT RUN**.

## Risks and Tradeoffs
- WordCraft의 egui 입력/렌더와 React WebView 연결이 핵심 기술 위험; 도입 전 PoC 실패 조건이 필요하다.
- rhwp는 README상 HWPX 저장을 설명하나 임의 사용자 문서의 완전 무손실 보존이 자동 보장되는 것은 아니다.
- 첫 GitHub 푸시 이후 CI 실패만으로는 공개된 비밀을 되돌릴 수 없다.
- 저장/렌더 및 라이선스 조건은 업스트림 특정 커밋을 검토하고 전용 샘플로 검증해야 한다.

## Requirement Coverage

| Requirement | Design | Tasks | Verification |
|-------------|--------|-------|--------------|
| FR-001 | Architecture / Testing and Verification Strategy | T004 | Tauri 2와 React/TypeScript로 제작하는 독립 데스크톱 앱에서 상단 바, 리본, 왼쪽 탐색, 중앙 편집기, 오른쪽 속성, 상태 표시줄의 6개 영역을 제공하고 패널 접기·크기 조절을  |
| FR-002 | Architecture / Testing and Verification Strategy | T005 | UI 번역 파일을 `src/language/ko.json`, `src/language/en.json`으로 분리하며 고정 키, 영어 fallback, 즉시 전환, 선택 언어 복원과 번역 키 누락 검사 |
| FR-003 | Architecture / Testing and Verification Strategy | T017, T001, T002 | WordCraft는 `external/wordcraft/`, rhwp는 `external/rhwp/`에 독립 Git submodule로 등록하고 검토한 커밋을 부모 저장소 gitlink로 고정한다. |
| FR-004 | Architecture / Testing and Verification Strategy | T006 | HWP/HWPX는 rhwp, DOCX는 WordCraft로 분기하고 문서별 모델·렌더링·편집 히스토리의 엔진 소유권을 독립적으로 유지한다. HOP는 코어가 아닌 참고 사례다. |
| FR-005 | Architecture / Testing and Verification Strategy | T003, T007, T008 | 두 편집 표면에서 페이지 렌더링, 한국어 IME 조합, 마우스 선택, 커서 hit-test, 키보드 조작, 표 안 이동 가능성을 각기 PoC로 검증한다. 검증 실패 시 고급 기능 구현을 중단한다. |
| FR-006 | Architecture / Testing and Verification Strategy | T009, T014 | 지원 가능한 문서는 열기·편집·원본 형식 저장·재열기를 제공하고, 손실 우려·지원하지 않는 개체·쓰기 불가 문서는 읽기 전용으로 전환하거나 저장을 차단하며 원본을 보호한다. |
| FR-007 | Architecture / Testing and Verification Strategy | T010 | Command Registry는 변하지 않는 명령 ID, 국제화 라벨 키, 단축키, 엔진별 capability, 선택 영역 및 상태를 통합한다. 미지원 명령은 실행되지 않는다. |
| FR-008 | Architecture / Testing and Verification Strategy | T011 | WordCraft 스타일의 공통 리본(파일·홈·삽입·그리기·디자인·레이아웃·참조·편지·검토·보기·도움말)과 상황별 메뉴를 설계하되 실제 엔진 기능에 따라 표시/비활성화를 결정한다. |
| FR-009 | Architecture / Testing and Verification Strategy | T012, T013 | HWP/HWPX 전용 한글 도구(장평·자간·조판·표 계산 등)와 DOCX 고급 기능은 실제 API·문서 왕복 검증이 된 항목부터 제공한다. |
| FR-010 | Architecture / Testing and Verification Strategy | T014 | 저장 시 문서 revision과 디스크 버전 충돌을 검사하고, 가능하면 동일 파일시스템에 임시 사본을 작성·검증·원자적 교체한다. 실패하면 원본을 보존하고 복구 사본을 별도 관리한다. |
| FR-011 | Architecture / Testing and Verification Strategy | T015, T016 | HWP/HWPX/DOCX 대표 샘플 및 손상·암호화·표·그림·수식·폰트·IME 회귀 테스트와 지원 플랫폼(Windows/macOS/Linux)의 실제 빌드·실행·PDF 출력 검증을 수행한다. |
| FR-012 | Architecture / Testing and Verification Strategy | T017 | 프로젝트 전체 계획 문서는 `docs/planning/spec.md`, `docs/planning/plan.md`, `docs/planning/tasks.md`만을 기준본으로 관리한다. `src/` |
| FR-013 | Public Repository Security Policy | T018, T019 | 공개 저장소 커밋 전 변경 파일의 비밀키·인증정보·개인 홈 절대 경로·내부 주소·개인정보 노출을 검사하며 최초 공개 전 전체 파일과 Git 이력을 검사한다. 발견되면 기본적으로 커밋/병합을 차단하고 |
| FR-014 | Public Repository Security Policy | T019, T020 | 공개 저장소의 로컬 훅을 우회하거나 GitHub Actions 실행 전 푸시하는 경로를 고려한다. 최초 공개 및 커밋/푸시/PR 단계의 다중 검사를 실시하고 누출된 비밀은 이력 정리만이 아니라 폐기 |
| FR-015 | Architecture / Testing and Verification Strategy | T009, T011 | 초기 버전은 HWP↔DOCX 및 HWPX↔DOCX 파일 형식 상호 변환과 공동 편집을 제공하지 않는다. PDF 내보내기는 형식 변환과 분리된 출력 기능이다. |
| SC-001 | Architecture / Testing and Verification Strategy | T004, T005 | 6개 영역이 표시되고 패널 설정과 ko/en 변경이 재시작 이후 복원되는 UI 검사가 통과한다. |
| SC-002 | Architecture / Testing and Verification Strategy | T007, T008, T009, T015 | HWP/HWPX/DOCX별 최소 1개의 대표 문서에 대해 열기→IME 입력→저장→재열기 및 문서 구조 비교 결과가 기록된다. 손실이 있으면 차단/읽기 전용 처리 근거가 남는다. |
| SC-003 | Architecture / Testing and Verification Strategy | T010, T011 | 공통 서식 명령(예: 굵게)과 실행 취소, 미지원 명령 처리가 각각 실제 대상 엔진에서 검증된다. |
| SC-004 | Architecture / Testing and Verification Strategy | T014 | 쓰기 중 강제 실패와 외부 수정 충돌 시 원본 바이트가 유지되고 오류 및 복구 사본 상태가 확인된다. |
| SC-005 | Architecture / Testing and Verification Strategy | T016 | Windows/macOS/Linux 실제 환경에서 앱 시작, 샘플 파일 열기·저장, PDF 내보내기 및 라이선스 고지 점검이 완료된다. |
| SC-006 | Architecture / Testing and Verification Strategy | T017 | 계획 문서가 `docs/planning/`에만 기준본으로 존재하고 두 submodule의 gitlink 및 고정 SHA가 확인되며 코어 중복 복사가 없다. |
| SC-007 | Public Repository Security Policy | T018 | 의도적으로 만든 테스트용 비밀·개인 홈 경로가 사전 검사에 걸리고 허용되는 상대 경로와 공개 시스템 경로는 통과하며, 비밀 본문은 로그에 노출되지 않는다. |
| SC-008 | Public Repository Security Policy | T019, T020 | 최초 공개 체크리스트, 우회 위험, 누출 대응 및 PR 필수 검사 정책이 문서화되고 테스트용 누출 샘플에 대한 검사 결과가 보존된다. |

