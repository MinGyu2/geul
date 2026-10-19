# Implementation Plan: HWP/HWPX + DOCX 통합 편집기

Date: 2026-10-13
Spec: [spec.md](./spec.md)
Status: Revised draft — 2026-10-16 실제 저장소 검사, submodule 고정, 보안 게이트 로컬 구현·2차 재검토 완료(원격 브랜치 보호는 미설정), Tauri/React 6영역 UI 기반(T004) 구현. 2026-10-17 T006: 문서 형식 판별·세션 기록·어댑터 계약 구현(엔진 연결 없음), 같은 날 리뷰 지적 5건 안정화(판별 규칙·동시 판별 자리)와 3건 2차 안정화(ZIP 무결성·mimetype 분류 순서), 3차 안정화(로컬 헤더 압축 방식 일치, 19바이트 mimetype 정책 명시). T007: rhwp R-A 편집 PoC 부분 통과(IME 조합 표시 미검증, 저장 없음), 2026-10-18 5·6차 안정화(실제 IME 게이트 FAIL 유지), IME 원인 규명(필수 7개 PASS)·7차·8차(입력 버퍼·DPR 2·여러 문서 지연)·9차(렌더 배율·바꾸기 입력·화면 변화, 체크 안 함). 2026-10-19 T008: WordCraft W-A(백엔드 네이티브 엔진) 편집 PoC 구현, 이 환경(X11·weston)에서 렌더·hit test·키보드·지연·실제 IME 필수 7개 통과(T007과 같은 플랫폼 범위 때문에 체크 안 함). 열기 대화상자는 미착수. 2026-10-19 T009: 원본 형식 저장·보존 사전 검사 구현(Linux에서 검증, 보존 근거가 없으면 차단, 체크 안 함)

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
    원문이 같고 그 값이 고칠 것 없는 버전 1로서 현재 설정을 그대로 담으면(공백·항목 순서·모르는 항목 차이는 무시) 다시 쓰지 않고
    저장된 것으로 봄(원문·모르는 항목과 비교 기준은 그대로). 원문 비교를 이 의미 비교로 대신하지 않음.
    한계: localStorage에 compare-and-swap이 없어 다시 읽기와 쓰기 사이의 변경은 막지 못하고, WebKitGTK에서는 동시에 실행한 다른
    geul 프로세스의 변경이 보이지 않아 감지하지 못함(마지막에 쓴 값이 남음). 단일 인스턴스 강제나 Rust 쪽 잠금 저장소는 후속 결정
  CommandRegistry: stable command ids, per-engine capability, shortcut, selected-state
  DocumentController: session id, active format, revision, dirty flag, file fingerprint
    (T006 소유 구분: Rust `src-tauri/src/document/`의 SessionRegistry가 형식 판별·엔진 배정·세션 ID·수명주기의
     권한 있는 기록. React `src/adapters/sessions.ts`는 그 투영(목록·활성 선택)만 가지며 세션을 만들지 않는다.
     dirty flag·file fingerprint는 편집·저장이 생기는 T009/T014에서 추가)
    +-- RhwpAdapter --> rhwp Core (HWP/HWPX, independent model + render surface)
    +-- WordCraftAdapter --> WordCraft Core (DOCX, independent model + render surface)
```
- 에디터 화면은 두 엔진의 렌더/커서/입력 특성을 보존한 형식별 표면이다. React UI가 네이티브 Rust 엔진 내부 데이터 모델에 직접 접근하지 않는다.
- WordCraft egui를 React로 재사용 가능하다고 가정하지 않는다. 이음매(이미지/scene/page raster+hit-test 또는 별도 편집 표면)를 PoC로 비교한다.
  (T008: egui는 쓰지 않고 page raster + hit test(W-A)로 연결했다 — 아래 "T008에서 구현한 계약".)
- Tauri 명령 권한/파일 접근 허용 범위는 최소화한다. 경로 입력은 상위 앱에서 검증한다.
- 문서별 session ID+revision이 명령 응답과 렌더 이벤트에 포함되어 이전 세션 비동기 응답을 버린다.

## Data Flow
1. 파일을 선택→확장자와 파일 헤더 확인→DocumentController에서 엔진 결정→인코딩 오류를 명시적으로 처리한다.
   (T006 정책: 확장자가 hwp·hwpx·docx가 아니면 내용을 읽지 않고 거부. 내용이 다른 지원 형식이면 `ExtensionMismatch`로
   거부하고 내용대로 다시 해석해 열지 않는다. 확인 후 여는 흐름은 없다. 형식 판별은 엔진이 문서를 열 수 있다는 증거가 아니다)
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

### T006에서 구현한 계약 (2026-10-17)
위 개념 계약과 달리 세션을 만드는 일(`open`·`close`)은 엔진 어댑터가 아니라 백엔드 SessionRegistry가 맡는다. 어댑터마다
세션을 만들면 세션 기록이 둘이 되기 때문이다. 이 이름과 인자는 이 앱의 계약이며 rhwp·WordCraft API가 아니다.
- IPC(`src-tauri/src/document/commands.rs`, `build.rs` 앱 매니페스트 + `capabilities/default.json`에서 이 네 명령만 허용):
  `document_open(path) -> SessionInfo`, `document_close(sessionId) -> {sessionId, alreadyClosed}`,
  `document_session(sessionId) -> SessionInfo`, `document_sessions() -> SessionInfo[]`.
  `SessionInfo = {sessionId, format: hwp|hwpx|docx, engine: rhwp|wordcraft, revision, state: "identified", displayName}`(경로 없음).
- 형식 판별(`detect.rs`, `ole.rs`, `package.rs`, `zip.rs`, `xml.rs`): HWP = OLE + `FileHeader`("HWP Document File", 주 버전 5,
  암호·DRM 플래그 없음) + `DocInfo` + `BodyText`/`ViewText` + 모든 스트림의 끝 섹터가 파일 안에 있음. HWPX = ZIP +
  `Contents/content.hpf`(풀어서 크기·CRC 확인, 루트가 OPF `package`) + `Contents/header.xml`(크기·CRC만 확인, XML 내용은 엔진 몫)
  (있으면 `mimetype` = `application/hwp+zip`; `META-INF/manifest.xml`이 있으면 루트가 ODF manifest여야 하고 그 이름공간의
  `encryption-data` 요소가 있으면 암호화, 읽을 수 없는 manifest는 `ParseFailure`). DOCX = ZIP + OPC 구조를 따르는
  `[Content_Types].xml`·`_rels/.rels`(이름공간·루트·루트 바로 아래 위치·`Id`·Default/Override 중복 없음·DTD 없음) + officeDocument
  대상 부분이 있고 내용 형식이 WordprocessingML 문서 본문(docm·dotx·XLSX 등은 거부). HWPX·DOCX 모두 ZIP 항목 하나라도 암호화
  플래그가 있으면 `Encrypted`. 판별이 읽거나 확인하는 항목(HWPX mimetype·manifest·content.hpf·header.xml, DOCX 내용 형식·패키지
  관계·본문 부분)은 로컬 헤더와 중앙 디렉터리의 암호화 비트나 압축 방식이 어느 방향으로든 다르면 손상이고 이 판정이 `Encrypted`·
  지원하지 않는 압축 방식보다 먼저다.
  풀어 읽는 deflate 항목은 선언한 압축 크기 범위가 정확히 하나의 스트림이어야 한다(뒤에 남은 바이트는 손상). 두 표식이 함께
  있으면 `Ambiguous`. `mimetype`은 HWPX 선언(19바이트)일 수 있을 때만 읽으므로 OPC 패키지의 관계없는 `mimetype`은 DOCX 판별에
  영향이 없다. 정확히 19바이트인 `mimetype`을 읽을 수 없으면 HWPX 선언이 아니라고 단정할 수 없으므로 형식을 정하지 않고 거부한다
  (보수적 정책).
  rhwp `detect_format`은 모든 OLE를 HWP로 보므로 쓰지 않는다. 판별은 선택한 컨테이너 불변식까지만 확인하며 본문·header.xml의
  XML 내용, 엔진 불러오기(T007/T008), 저장 왕복 무결성(T009)을 보장하지 않는다.
- 자원 한계: 문서 512 MiB, ZIP 항목 20,000개·중앙 디렉터리 8 MiB·이름 4,096바이트, 판별용 XML 항목 1 MiB(선언 크기와
  실제 압축 해제 모두), 크기·CRC만 확인하는 HWPX header.xml 64 MiB(내용을 모으지 않음), OLE 스트림 20,000개, 세션 64개, 동시
  판별 8개(자리는 차단 작업이 끝날 때 돌려주므로 명령 future가 취소돼도 실행 중인 판별이 자리를 쥔다). 문서 본문은 판별에 풀지 않는다.
- 오류(`error.rs`, `src/adapters/contract.ts`): 위 키 중 `UnsupportedFormat`·`ParseFailure`·`StaleSession`을 쓰고,
  결정적인 거부를 위해 `InvalidPath`·`Unreadable`·`ExtensionMismatch`·`Encrypted`·`ResourceLimit`·`AlreadyOpen`·
  `UnknownSession`·`Internal`을 더했다. 프런트엔드는 `EngineUnavailable`(엔진 연결 전)·`Protocol`(계약 밖 응답)을 만든다.
  `UnsupportedCommand`(T010), `UnsafeSave`·`SaveFailure`·`FileConflict`(T009/T014)는 해당 작업에서 추가한다. 오류에는 code와
  고정된 세부 값만 있고 경로·문서 내용·운영체제 오류 문구는 없다.
- 세션: ID는 1부터 늘고 다시 쓰지 않는다(발급한 적 있는 ID = `StaleSession`, 없는 ID = `UnknownSession`). 같은 파일(정규화
  경로 또는 장치·inode)은 `AlreadyOpen`. 판별은 잠금 밖, 중복 확인·등록은 한 잠금 안. 되풀이한 닫기는 `alreadyClosed: true`.
  상태는 `identified` 하나(엔진에 불러오지 않음). 판별이 끝나면 파일 핸들을 닫는다.
- revision: 엔진 문서 모델의 판. 0에서 시작해 문서를 바꾸는 연산이 성공할 때만 늘고, 다시 그리기·선택으로는 늘지 않는다.
  바꾸는 요청은 기대 revision을 담고 다르면 실행하지 않는다(`ExecuteRequest`). T006에는 바꾸는 연산이 없다.
- 프런트엔드 투영(`sessions.ts`): 응답은 자기 sessionId 항목에만 반영(활성 문서와 무관), 목록에 없는 세션·낮은 revision·
  형식이나 엔진이 바뀐 응답은 버림, 열기 완료는 가장 최근 열기이고 그동안 사용자가 다른 문서를 고르지 않았을 때만 활성화.
- 엔진 어댑터(`engines.ts`): `capability`(지금은 모든 명령 `engine-not-integrated`), `load`·`execute`·`save`(T007/T008에서 구현,
  지금은 아무것도 바꾸지 않고 `EngineUnavailable`). 렌더링·커서·선택·IME는 편집 표면마다 달라 PoC 결과로 정한다.
- 경로 입력: 열기 대화상자가 없어 IPC로 경로를 받고 백엔드가 검사한다(절대 경로만, NUL·4,096바이트 초과 거부, 심볼릭 링크를
  따라간 실제 파일의 이름·내용으로 판단, 일반 파일만, unix에서 O_NONBLOCK). 백엔드가 대화상자를 띄우는 흐름(T009)이 생기면
  경로 입력을 다시 검토한다. UTF-8이 아닌 경로는 IPC 문자열로 보낼 수 없어 열 수 없다.
- 미결정(T007): rhwp 1순위 표면(R-A)은 문서 모델이 WebView의 WASM에 있으므로, 그 엔진의 revision을 백엔드 기록에 어떻게
  알릴지(저장 요청에 담기 등)를 T007에서 정한다. 판별한 뒤 엔진이 파일을 다시 읽을 때 그 사이 바뀌었는지도 그때 확인한다.
- Tauri IPC에 보낼 것은 안정적인 커맨드/세션 ID와 경계 검사된 데이터이며 임의의 파일시스템 경로·셸 명령을 UI에서 그대로 신뢰하지 않는다.

### T007에서 구현한 계약 (2026-10-17, rhwp R-A PoC)
- 결과·측정·IME 한계는 [editor-surface-decision.md "T007 결과"](../architecture/editor-surface-decision.md#t007-결과-rhwp-r-a-poc-2026-10-17).
- 세션 수명주기: `identified → loading → ready | failed`, `ready → failed`, `failed → loading`(다시 불러오기). `SessionInfo`에
  `dirty`(ready 뒤 확정한 변경 있음)와 `sequence`(기록 변경 횟수, 늦은 응답을 버리는 기준)를 더함.
- IPC 3개 추가(이 세 명령과 T006 네 명령만 허용): `document_load(sessionId) -> 원시 바이트`(경로 인자 없음, 판별한 파일과 같은지
  장치·inode·크기·수정 시각과 다시 판별로 확인, 다르면 `FileChanged`), `document_set_state(sessionId, from, to)`,
  `document_commit(sessionId, baseRevision, count)`(ready이고 기준이 같을 때만 revision += count, 아니면 `RevisionMismatch`/
  `InvalidState`). 새 오류: `InvalidState`, `RevisionMismatch`, `FileChanged`, `InvalidRequest`, 프런트엔드 `EngineFailure`.
- revision 권한은 백엔드 하나. WASM 모델을 바꾸는 것은 세션마다 하나인 편집 세션이며, 성공한 변경만 순서대로 묶어 확정한다.
  확정이 거부되면 편집을 멈추고 failed(조용한 분기 없음). IME 조합은 끝날 때 1번 센다.
- 쓰기 명령 없음. 저장은 T009/T014. 편집 결과 확인은 메모리 내보내기·다시 열기 비교만.
- `EngineAdapter`에서 `load`를 뺐다(불러오기·본문 입력은 편집 표면과 세션 수명주기 몫, 화면 명령·저장은 이 경계).
- T007 안정화(같은 날, [editor-surface-decision.md "T007 안정화"](../architecture/editor-surface-decision.md#t007-안정화-리뷰-지적-재현과-수정-2026-10-17)):
  불러오기 시도마다 백엔드가 번호를 준다(`SessionInfo.loadGeneration`, 0 = 불러온 적 없음, `document_load`마다 +1).
  `document_load` 응답은 `시도 번호(u64 little-endian 8바이트) + 문서 바이트`이고, `document_set_state(sessionId,
  loadGeneration, from, to)`·`document_commit(sessionId, loadGeneration, baseRevision, count)`는 그 번호가 지금 시도와
  같을 때만 받는다(아니면 `StaleLoad{sessionId, loadGeneration}` — 옛 시도의 늦은 완료·실패·취소 가드가 새 시도를 바꾸지
  못함). 편집기는 엔진이 문서를 읽고 페이지 정보까지 얻은 뒤에야 ready를 요청한다. 프런트엔드 오류 `UnpreservedChanges`:
  저장이 없으므로 편집한 모델(확정했거나 확정 대기·조합 중)은 사용자가 버리기를 확인해야 닫거나 다시 불러온다.
- T007 3차 안정화(같은 날, [editor-surface-decision.md "T007 3차 안정화"](../architecture/editor-surface-decision.md#t007-3차-안정화-2차-리뷰-지적-재현과-수정-2026-10-17)):
  엔진 편집 함수가 예외를 던지면 모델이 일부만 바뀌었을 수 있으므로 그 변경은 revision으로 세지 않고 모델을 '알 수 없게 바뀜'으로
  표시해 편집을 멈춘다(버리기 확인 대상). ready 조건에 페이지 정보 검사를 더했다(쪽 수 1 이상 정수, 쪽마다 `pageIndex` 일치,
  width·height 유한 양수 ≤ 16384 px — 아니면 `EngineFailure(render)`). 내보내기 검사 `passed`는 다시 연 문서의 실제 형식
  (`getSourceFormat`)과 컨테이너 서명이 요청 형식일 때만 참이다. 클릭·초점 잃음·표면 사라짐으로 끊긴 IME 조합은 WebView에 하나인
  입력 문맥 상태(`ImeContext`)로 표면 사이에서 공유하며, 그 조합의 늦은 이벤트는 원래 문서·자리에 최대 한 번 확정된다.

- T007 4차 안정화([상세 재현·계약·검증](../architecture/editor-surface-decision.md#t007-4차-안정화-비동기-소유권ime-완료자원-보호-2026-10-17)):
  reload 시작·dispose마다 로컬 epoch를 무효화해 비동기 commit·상태·refresh와 dispatcher 소유권을 분리한다.
  Rust의 `loadGeneration`·committed revision 권한은 그대로다. IME의 정상 완료 기록도 `ImeContext`에 두고 새 입력 경계까지
  유지해 중복 끝·탭 사이 늦은 완료를 소비한다(실제 native preedit 미전달·transaction ID 부재의 한계는 별도).
  Rust `CloseRequested`를 동기 취소한 뒤 모든 탭의 미보존 변경을 그룹 확인한다. `window_close_confirmed`는 현재 창만
  destroy하며 파일 시스템·셸·저장 권한은 추가하지 않는다. canvas는 per-canvas 16M pixels(RGBA 64 MiB), 활성 표면 합계
  32M pixels(128 MiB) 안에서만 할당하며 zoom·DPR을 반영한다. 나머지 쪽은 frame clock에 의존하지 않는 다음 task에 그리고,
  모델 교체·새 렌더·표면 해제 때 이전 작업/bitmap을 무효화한다. T007 실제 IME의 필수 7개 기준은 바꾸지 않는다.
- T007 5차 안정화([상세 재현·계약·검증](../architecture/editor-surface-decision.md#t007-5차-안정화-ime-확정-실패실패-전이-순서복구-가능한-표시-한도-2026-10-18)):
  조합 기록은 엔진 호출이 성공한 뒤에만 바꾸고, 엔진 예외로 끝난 조합은 revision으로 세지 않는다(uncertain 보호 유지).
  편집 중지 때 보낸 `ready·loading → failed` 전이는 시도마다 하나로 기록하며, reload는 그 결과를 확인한 뒤에만 옛 모델을
  놓고 `document_load`를 보낸다(확인 실패면 모델 유지·오류 표시, 고정 지연·맹목 재시도 없음). bitmap 픽셀 예산(64 MiB/128 MiB
  RGBA)은 그리는 배율에 적용하며, 배율·DPR 초과는 엔진 실패가 아닌 복구 가능한 표시 한도(편집만 멈춤, 배율을 낮추면
  같은 모델로 이어 감)다. 가장 작은 배율(50%)로도 넘는 문서만 새 프런트엔드 오류 `RenderLimit`으로 ready 전에 거부한다.
  Rust 계약·권한은 바꾸지 않았다. T007 실제 IME 필수 7개 기준과 FAIL 판정(4/7)은 그대로다.
- T007 6차 안정화([상세](../architecture/editor-surface-decision.md#t007-6차-안정화-불러오기-실패-전이ime-취소-수정-표시확인-창-초점-2026-10-18)):
  불러오는 중 엔진 실패의 `loading → failed` 전이도 같은 `FailureTransition`으로 기록해, 확인되지 않으면 다음 reload가 먼저
  확인한다(전송 예외는 Protocol로). 취소한 조합은 rhwp 편집이 구역 원본 raw stream을 버려 내보내기가 달라지므로(실제 샘플
  155/200) 보수적으로 미보존을 유지한다. 확인 창 첫 초점은 같은 commit에서 옮기고 편집 표면 autofocus는 모달에 양보한다.
  5차의 native 창 닫기 "회귀"는 시험기 경합으로 정정했다. Rust·권한 변경 없음. 실제 IME 4/7 FAIL 그대로.
- T007 한국어 IME 원인 규명([상세](../architecture/editor-surface-decision.md#t007-한국어-ime-원인-규명과-해결-2026-10-18)):
  preedit이 페이지에 오지 않은 원인은 wry 0.57.0의 `set_enable_preedit(false)`였다(WebKitGTK 단독 탐침으로 재현). Linux에서
  페이지 로드마다 WebKitGTK 기본값으로 되돌린다(`src-tauri/src/ime.rs`, Tauri `with_webview`, 권한·CSP 변경 없음). R-A는 그대로이며
  편집 표면은 표준 DOM 조합 이벤트만 쓴다(native 브리지·R-B 불필요). 실측 WebKitGTK 확정 순서(빈 끝 + 확정 절반, 클릭·초점 잃음
  꼬리, WebView 확정 뒤 입력기 이중 확정)에 맞춰 `ImeInput`을 보정했다. Rust revision 권한·세대 계약은 바꾸지 않았다. 실제 IME 필수
  7개 PASS(X11 + ibus-hangul). 조합 키마다 다시 그려 실제 IME 입력 지연이 늘었다(이 환경 p95 100–190 ms) — T007 미체크, 후속 결정 필요.
- T007 7차([상세](../architecture/editor-surface-decision.md#t007-7차-ime-성능조합-트랜잭션-무결성-2026-10-18)): 앱이 먼저 끝낸
  보이는 조합은 입력기의 끝(또는 새 입력·편집 중지 경계)에서 변경 하나로 센다(조합 하나 = revision 하나, Rust 계약 그대로).
  그리기 정책: 조합 밑줄 고정, 진단 글자는 입력이 멈춘 뒤, 숨긴 textarea 값은 키마다 비우지 않음(글자는 이벤트 data), 같은 크기의 쪽은
  고정 rhwp 패치 API로 쪽 전체를 그 자리에서 다시 그림, 다른 쪽은 입력이 멈춘 뒤. 한 문서 실제 IME p95 약 70 ms. DPR 2·다른 문서 편집
  상태는 150 ms 초과 — 부분 다시 그리기에는 엔진의 본문 dirty 영역이 필요(별도 결정). T007 미체크.
- T007 8차([상세](../architecture/editor-surface-decision.md#t007-8차-숨긴-입력-버퍼-정확성남은-한국어-ime-성능-2026-10-18)): 숨긴
  textarea는 IME 입력 버퍼일 뿐 문서의 근거가 아니다. `data` 없는 입력은 `beforeinput` 때의 값·선택과 비교한 새 글자만 넣고, 모르면
  넣지 않으며, 지우기·되돌리기 계열 input은 넣지 않는다. 그리기: 고정 rhwp의 레이어 트리를 비교해 바뀐 띠만 다시 그리고(엔진 dirty
  영역 대신 실제로 그린 입력의 차이), 그동안 Canvas fillRect를 띠 안으로 제한해 WebKit이 Canvas 전체를 다시 합성하지 않게 한다. 다른
  쪽은 한 task에 한 쪽, 보이는 쪽 먼저, 스크롤로 보이면 바로. 이 환경에서 DPR 2·여러 문서 p95 150 ms 안(픽셀 RGB 같음). Rust 계약 그대로.
  T007 미체크(외부 부하 비교·실제 데스크톱·다른 입력기 미검증).
- T007 9차([상세](../architecture/editor-surface-decision.md#t007-9차-렌더-배율-정확성바꾸기-입력-안전성화면-변화-다시-그리기-2026-10-18)): 그 자리
  다시 그리기(띠·fillRect 제한·쪽 전체 패치)는 고정 rhwp가 요청 배율을 그대로 쓸 때만 하고, 배율을 줄이는 쪽(한 변 16,384 px 초과)은
  처음과 같은 전체 그리기. textarea 범위를 바꾸는 입력(`insertReplacementText`·`insertTranspose`)은 문서 범위를 정할 수 없어 받지 않는다.
  기다리던 쪽은 scroll과 편집 영역 크기 변화(`ResizeObserver`) 때 바로 그린다. 같은 부하 비교: CPU 포화 때는 한 문서도 150 ms를 넘어
  여러 문서 특유의 느려짐이 아니다(코드 변경 없음). T007 미체크.

### T008에서 구현한 계약 (2026-10-19, WordCraft W-A PoC)
- 결과·측정·한계: [editor-surface-decision.md "T008 결과"](../architecture/editor-surface-decision.md#t008-결과-wordcraft-w-a-poc-2026-10-19).
- WordCraft 문서 모델은 Rust 백엔드(`src-tauri/src/adapters/wordcraft/`)가 세션 ID + 불러오기 시도 번호로 가진다. `wordcraft-engine`을
  고정 submodule의 path 의존성으로 링크한다(업스트림 수정 없음). 세션 기록(`SessionRegistry`)이 여전히 하나뿐인 권한이다.
- IPC 5개 추가(T006·T007 명령과 함께 이것만 허용): `docx_load(sessionId, reloadGeneration?)`(identified·failed → loading →
  ready|failed, `reloadGeneration`이면 그 시도의 ready 모델을 백엔드가 버리고 다시 읽음), `docx_view(sessionId, loadGeneration)`,
  `docx_edit(sessionId, loadGeneration, baseRevision, ops)`(허용한 연산 `DocxOp`만, 모델 잠금 안에서 기준 확인 → 실행 → 실제로 바뀐
  연산 수만큼 확정, 거부한 연산은 `rejected` 위치), `docx_render(sessionId, loadGeneration, revision, page, scale, base?)`(원시 응답:
  머리 24바이트 + PNG, `base`를 주면 그 판과 다른 줄의 띠만), `docx_roundtrip(sessionId, loadGeneration, revision)`(메모리 안
  내보내기·다시 읽기 비교, 디스크 쓰기 없음).
- T007 명령 `document_load`·`document_set_state`·`document_commit`은 WordCraft 세션에 `InvalidRequest`(revision 권한이 둘이 되지
  않게). `document_close`는 엔진 모델도 놓는다. 새 백엔드 오류 `EngineFailure{engine, stage: parse|render|edit|export}`(엔진 메시지 없음).
- 프런트엔드: `src/adapters/docx.ts`(응답 검사), `src/components/Editor/wordcraft/`(편집 세션·표면). IME 조합은 엔진이 모르므로
  커서 자리에 겹쳐 그리고 확정만 보낸다. T007 `ImeInput`은 `ImeSession` 계약으로 일반화해 두 엔진이 같이 쓰고, 숨긴 textarea
  이벤트 해석은 `src/components/Editor/textInput.ts`로 옮겼다(동작 같음). WebView가 다시 시작되면 rhwp 세션만 failed로 돌린다.
- 저장 없음(T009). 열기 성공은 무손실 근거가 아니다(끊긴 본문 XML도 열림 — T009 입력). 개발 프로필은 의존성을 최적화한다.
- T008 안정화([상세](../architecture/editor-surface-decision.md#t008-안정화-붙여넣기그림-실패조합-선택래스터-예산복합-연산닫기-보호-2026-10-19)):
  허용 연산에 `PasteText{text, chain}`(`\n` 문단·`\t` 탭 글자, 4096자 조각, 앞 조각 거부 시 건너뜀)·`DeleteSelection`을 더했다(그 밖의
  IPC·권한·revision 계약 그대로). `InsertAt`·`ReplaceInserted`는 WordCraft 편집 스냅숏으로 원자적이다. 그림 실패는 숨기지 않고(3번 재시도 뒤
  표시·편집 멈춤), 화면 밖 래스터는 128 MiB 예산, 닫기는 백엔드 dirty도 확인한다. T007/T008 체크 정책은 그대로다.

### T009에서 구현한 계약 (2026-10-19, 원본 형식 저장·보존 검사)
- 결과·근거·한계: [save-preservation.md](../architecture/save-preservation.md). 원본 형식으로만 쓰고 경로를 받지 않는다(세션에 기록한
  원본 파일 하나). 변환·다른 이름 저장·자동 저장 없음(FR-015).
- **T009/T014 경계(모호함 정리)**: T009는 안전하다는 근거가 있을 때만 같은 디렉터리 임시 파일 → 검증 → 원자적 교체로 저장하고,
  그 밖은 거부해 원본을 그대로 둔다. 원본을 직접 덮어쓰지 않는다. 교체 방식을 검증하지 않은 플랫폼(지금은 Linux 밖)은 저장하지
  않는다. 남은 임시 파일 복구·정전 내구성 시험·Windows/macOS 교체·확장 속성 보존·복구 사본 관리는 T014다. Data Flow 5의 "제한된
  저장(별도 사본)"은 T009에서 하지 않는다(검증할 수 없는 문서는 저장 차단).
- 보존 판정 `safe | unsafe | unknown`(모르면 unsafe와 같이 차단)과 근거 코드 13개. 사전 검사는 원본과 편집 없는 엔진 왕복을 비교한다
  (HWP 레코드, HWPX·DOCX 정규화 XML·바이트). 엔진 손실 보고(rhwp)는 엄격히 검사하지만 빈 보고서·열기 성공·글자 같음은 근거가 아니다.
- 저장 검사: 손실 보고, 출력 형식 판별, 패키지 무결성(DOCX 내용 형식·관계 대상, HWPX `mimetype`·manifest), 편집이 바꾸는 부분
  (HWP 본문·DocInfo 캐럿, HWPX section, DOCX 본문·app.xml 통계) 밖이 원본과 같음, 다시 열기 비교(rhwp는 프런트엔드, DOCX는 백엔드 모델).
- `SessionRegistry`가 저장도 맡는다: 불러온 바이트 해시 기록, 사전 검사 결과를 원본 해시와 함께 기억, `begin_save`(ready·같은 시도·같은
  판·저장 중 아님), 교체는 기록 잠금 안에서 세션·시도·지문을 다시 확인한 뒤, 성공하면 깨끗한 판 = 저장한 판(그 사이 편집은 dirty).
- IPC 5개 추가: `document_original`·`document_preflight`·`document_save`(rhwp, 원시 프레임 `GSV1`), `docx_preflight`·`docx_save`.
  새 백엔드 오류 `UnsafeSave`·`SaveUnsupported`·`SaveFailure`·`FileConflict`·`SaveInProgress`, 프런트엔드 `SaveNotReady`.
- T009는 선행 T007·T008이 플랫폼 기준으로 미체크이고 교체를 Linux에서만 검증했으므로 체크하지 않는다.

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
    # T006 정정: 응답은 response.sessionId 세션에만 반영한다. active_session_matches()로 거르면 비활성 문서의
    # 응답을 잃으므로 쓰지 않는다. 활성 여부는 화면 표시만 정한다(src/adapters/sessions.ts)
save(session):   # T009 구현: src-tauri/src/services/save/service.rs
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
│   ├── adapters/{contract,backend,engines,sessions}.ts  # 세션 IPC 계약·검사, 클라이언트, 엔진 경계, 세션 투영(T006)
│   ├── dialogs/                        # (예정)
├── src-tauri/                          # Rust host: 문서 세션 명령 4개(T006)만 허용, capability core:default + allow-document-*, CSP
│   ├── src/{main.rs,lib.rs}
│   ├── src/document/                   # 형식 판별·세션 기록·IPC(T006). adapters/ services/ 는 T007 이후 (예정)
│   ├── tests/document_fd_cleanup.rs    # 판별 후 파일 핸들 정리(Linux)
│   ├── build.rs                        # 앱 명령 매니페스트(permissions/autogenerated/는 빌드 산출물, Git 무시)
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
- 문서 형식·세션(T006): Rust 단위 테스트(합성 OLE·ZIP 컨테이너, 손상·잘림·자원 한계·결정적 변형 입력), 파일 핸들 정리 통합
  테스트, Vitest(계약 검사·클라이언트·어댑터·세션 투영의 순서 뒤바뀜과 활성 전환), 실제 앱 IPC 스모크. 합성 컨테이너는 판별
  규칙 시험용이며 실제 문서 지원의 증거가 아니다(실제 문서는 T007/T008/T015). CI `quality`에 `cargo test --locked` 추가.
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

