# geul — 새 문서 생성 및 HWP/HWPX/DOCX 저장 기능

정리 기준: 2026-11-04
검토 소스: `MinGyu2/geul` master `4bc1ac986026ccadb2d673a66ad69e6296e3a39e`.
기술 구성: Tauri 2 + React + TypeScript + Rust. 엔진: WordCraft(DOCX), RHWP(HWP/HWPX).
문서 성격: 제공된 정리의 코드 대조·정정 및 신규 생성 구현 계약. 기존 절은 **설계/정적 검토 당시 기록**이다. 현재 T021 실행 결과는 아래 「T021 실행 수용」을 따른다. T021·T022·T023은 아래 실행 수용 범위에서 완료했다. 다른 플랫폼·외부 상호운용은 별도 NOT RUN이다.
기준본: [spec.md](../planning/spec.md), [plan.md](../planning/plan.md), [tasks.md](../planning/tasks.md). 이 문서는 상세 보조 계약이다.

근거 표기: **코드 확인**은 해당 pin의 소스, **기록 확인**은 저장된 과거 실행 결과, **설계**는 앞으로 구현·검증할 계약, **미확인**은 이번에 실행/조사하지 않은 범위다. 기존 자료를 최신 runtime 결과로 바꿔 쓰지 않는다.

## 1. 핵심 결론

독립 모델 구조에 맞게 새 문서에서 DOCX/HWP/HWPX를 먼저 선택한다. 이후 선택 형식의 모델·세션·저장 경로를 유지한다. 사용자 문서 간 변환이나 두 모델 통합은 필요하지 않다.

제공된 정리의 큰 방향은 맞지만 다음을 보완한다.

- `createEmpty()` 존재만으로 제품용 HWP 빈 문서 생성이 적합하다고 판단하면 안 된다. 고정 소스에는 별도의 템플릿 기반 `createBlankDocument()`가 있으며 반환/호출 방식도 다르다.
- RHWP는 WebView WASM 엔진이다. Rust `files.rs`에 형식 분기만 추가하면 엔진 생성이 가능한 것으로 서술하지 않는다.
- 새 파일의 유효성 검사와 기존 원본의 무손실 보존 검사는 다르다. 같은 엔진의 export/reopen만으로 외부 호환성까지 입증하지 않는다.
- 게시·내구성·세션 등록·편집기 ready·첫 화면·포커스는 별개다. 등록 성공 시점에 이미 입력 가능하다고 가정하지 않는다.
- 현재 계획은 T007–T010을 △로 관리하고 T011 착수를 허용하도록 변경한다. 제공된 정리의 ‘공식 상태/의존성을 변경하지 않는다’는 설명은 이번 사용자 승인 전 상태이며 그대로 복사하지 않는다.

최초 구현은 **형식 선택 → 저장 위치 선택 → 안전 생성 → 세션/표면 준비 → 입력**이다. **형식 선택 → 제목 없음 → 첫 저장에서 위치 선택**은 선택적 후속 UX로 분리한다. 경로 선택 시점을 바꿔도 모델 변환 기능을 추가하지 않는다.

## 2. 최초 정적 검토 당시 구현 상태

| 기능 | DOCX | HWP | HWPX |
|---|---|---|---|
| 기존 문서 열기·기본 편집 | 구현 | 구현 | 구현 |
| 지원 문서 원본 형식 저장 | 구현 | 구현 | 구현 |
| 대표 편집·저장·재열기 | 과거 검증 기록 있음 | 과거 검증 기록 있음 | 과거 검증 기록 있음 |
| 제품 새 빈 문서 생성 | 연결됨 | 연결되지 않음 | 연결되지 않음 |
| 신규 생성 후 전체 native 편집·저장 수용 | 생성 코드·일부 시험 존재, 전체 수용과 별개 | 미실행 | 미실행 |
| 모든 문서 무손실 저장 | 보장하지 않음 | 보장하지 않음 | 보장하지 않음 |

**코드 확인:** `document_new`/`create_docx`, `FilePort.createDocx`, `DocumentWorkspace.newDocx`가 DOCX 전용이다. DOCX 생성 코드가 이미 있다는 사실을 인정하고 새 API/검증으로 확장하되 중복 구현하지 않는다. 미지원 원본은 현재 보존 정책에 따라 거절한다. 신규 생성 지원을 표시할 형식은 적어도 기본 입력·편집·저장까지 성공해야 한다.

## 3. 실행 직후 입력할 수 없는 이유

**코드 확인:** `Editor.tsx`의 활성 문서 없음 분기는 빈 페이지 모양의 자리표시자다. 실제 엔진 모델/편집 세션이 없는 상태이며 자동으로 빈 문서를 만드는 경로가 아니다. 따라서 그 표시만 클릭해 입력할 수 없는 것은 이 분기의 설계와 일치한다.

실제 문서를 생성/연 뒤에도 입력되지 않는다면 별도 ready·포커스·IME·렌더/엔진 오류를 확인해야 한다. 이 설명으로 모든 입력 불가를 해결했다고 주장하지 않는다.

**설계:** 무문서 화면에서 새 문서/열기 행동을 분명히 보여 준다. 모델 생성, 세션 등록, 엔진 준비, 실제 첫 표시를 구분하고, 같은 작업의 활성 문서가 준비된 경우에만 포커스를 이동한다. arbitrary timeout으로 준비를 추정하지 않는다.

## 4. 최초 정적 검토 당시 DOCX 신규 생성 구조

**코드 확인:** `src-tauri/src/services/files.rs`:

`document_new(path)` → `destination(path, Format::Docx)` → `create_docx` → `blank_docx` → `stage_new` → `publish_new` → `identify` → `register_created`.

`blank_docx()`는 WordCraft `blank_document`를 직렬화하고 별도 DocxModel로 연 뒤 다시 export한다. 최초 생성 바이트와 재export에 `service::preflight`를 적용하고 `model.same_as`를 확인한다. 게시 대상은 검증을 통과한 최초 바이트다. 임의의 ZIP 파일이나 빈 확장자 파일을 만들어 쓰는 구현이 아니다.

`create_docx()`는 게시 결과의 durable 값을 세션 등록에 넘긴다. 게시 후 등록이 실패하면 `FilePublishedUnregistered`를 반환한다. 같은 파일을 다시 생성하려 하면 충돌하며 기존 파일은 남는 회귀 시험 코드도 있다. 이번에 그 시험을 새로 실행한 것은 아니다.

**코드 확인:** FilePort는 생성 응답의 DOCX/WordCraft·identified·초기 revision/sequence/generation·표시 이름을 검증한다. Workspace는 file-operation과 open ticket을 사용해 먼저 저장 대화상자를 열고 생성 결과를 `acceptAndLoad`로 연결한다. 후속 `load()`는 비동기다. 일반화할 때 이 응답 검증을 없애지 말고 요청 형식과 엔진의 대응을 확장한다.

## 5. RHWP 신규 생성 API의 정확한 의미

### 5.1 createEmpty와 createBlankDocument는 다르다

**코드 확인:** RHWP pin `1a76570e833917d15817415a53c09ad61ab3203f`의 `src/wasm_api.rs`는 다음과 같이 구분한다.

| API | 호출/반환 | 소스에 명시된 역할 |
|---|---|---|
| `HwpDocument.createEmpty()` | 정적 팩터리 → HwpDocument | 시험/미리보기용. A4 구역 하나·빈 문단 하나. 첫 문단에 구역/단 정의 컨트롤을 싣지 않는 최소 구조 |
| `doc.createBlankDocument()` | 인스턴스 메서드 → 상태 JSON 문자열 또는 오류 | 내장 `saved/blank2010.hwp` 템플릿으로 현재 객체의 모델을 초기화. DocInfo raw stream을 보유하는 경로 |
| `doc.exportHwpWithReport()` | DocumentExport | HWP 바이트와 같은 내보내기의 손실 보고 |
| `doc.exportHwpxWithReport()` | DocumentExport | HWPX 바이트와 같은 내보내기의 손실 보고 |

따라서 `createBlankDocument()`를 새 객체 반환 팩터리처럼 사용하면 안 된다. 현재 사용자 문서에 호출해서도 안 된다. **fresh 임시 객체를 만든 뒤 템플릿 초기화를 적용하는 방식은 우선 검증할 후보**다. API 존재·주석은 geul의 현재 patched WASM에서 생성/편집/저장이 성공했다는 실행 근거가 아니다.

`src/document_core/commands/document.rs`의 `create_blank_document_native`가 번들 템플릿을 읽는 경로도 정적 확인 대상이다. 템플릿 자산의 출처·재배포 조건·작성자/회사/기타 메타데이터를 확인한다. 엔진 본체 라이선스만으로 모든 샘플/템플릿 자산을 승인하지 않는다.

### 5.2 제품 어댑터 연결 공백

**코드 확인:** geul `RhwpModule`은 `openDocument(bytes)`와 선택적 `memoryBytes()`를 노출한다. generated module의 정적 생성 API와 문서의 템플릿 초기화 메서드는 제품 facade에 없다.

**설계:** 이미 해시 검증한 generation의 실제 module/class에 연결한다. 별도로 raw rhwp.js를 import해서 앱과 다른 class를 잡는 과거 probe 실수를 반복하지 않는다. 임시 문서·재열기 문서·DocumentExport는 성공·실패·취소에서 정리한다. takeBytes는 같은 결과에서 한 번 소비하고, 보고서와 다른 export의 바이트를 섞지 않는다.

### 5.3 요청 형식과 모델 원본 형식

내장 템플릿이 HWP라는 사실만으로 HWPX 신규 생성을 불가능하다고 단정하지 않는다. 다만 HWP 모델에서 HWPX를 export한 다음 템플릿의 source format을 그대로 저장하면 잘못된 경로로 갈 수 있다. **최종 요청 형식의 바이트를 다시 열고 그 모델·형식을 세션 기준으로 사용**하는 경로를 검증한다.

새 내부 템플릿을 요청 형식으로 직렬화하는 것과 사용자가 연 기존 문서를 다른 형식으로 변환하는 제품 기능은 다르다. 후자는 범위에 추가하지 않는다. HWPX export 성공만으로 HWPX 신규 생성 전체 수용을 통과시키지도 않는다.

## 6. 기존 HWP/HWPX 안전 저장 근거

**기록 확인:** [2026-11-02 저장 수용](./save-roundtrip-acceptance-2026-11-02.json)의 stage4에는 HWP/HWPX/DOCX 대표 지원 문서의 실제 편집·저장·재열기와 형식별 구조 비교가 기록돼 있다. 충돌, 미지원 요소, 손상 출력, 잘못된 참조를 거절하고 해당 사례에서 원본이 그대로였다는 근거도 있다. 이것은 선택한 문서·조작·실행 신원에 한정한다.

**코드 확인:** 안전 저장 경로는 원본 신원/충돌, 형식·손실·구조/참조, 출력 재열기 관련 검증, stage/readback, 게시 직전 확인, 실제 게시/내구성, 세션 저장 revision 반영을 다룬다. 프런트엔드 엔진 검사와 Rust 보존/게시 검사가 역할을 나눈다. 모든 재열기 검증이 Rust RHWP 엔진에서 일어난다고 서술하지 않는다.

게시 전 실패와 게시 후 디렉터리 동기화 실패는 다르다. 후자에서 파일이 이미 바뀌었을 수 있다. `rename 성공 = 내구성 확인 = 세션 등록 성공`으로 합치지 않는다. 기존 [저장 보존 계약](./save-preservation.md)을 약화하지 않는다.

## 7. 신규 생성의 안전성 계약

### 검증 단계

새 문서에는 원래 사용자 파일이 없다. 생성 바이트가 재export와 같다는 것만으로 올바른 문서임을 증명할 수 없으므로 다음 검사를 조합한다.

1. 요청 형식·확장자·실제 서명·필수 컨테이너/문서 구조 일치.
2. 구역/문단/기본 글꼴·스타일·참조의 유효성, 빈 문서의 기대 텍스트/컨트롤, 손실 보고 형식과 내용.
3. 독립된 엔진 인스턴스의 재열기와 의미적 비교. 동시에 형식별 독립 구조 검사와 손상/누락/잘못된 참조 음성 대조군을 사용.
4. 최종 게시할 바이트에 대한 검사. 승인된 HWP preview 재생성 등이 있다면 정규화 전 출력과 최종 출력의 허용 차이만 인정.
5. stage의 쓰기·되읽기·파일 동기화·create-only 게시·디렉터리 동기화 결과·등록 상태를 확인.
6. 새 문서의 native 한글 입력·기본 편집 후 기존 저장 경로로 저장, 추가 편집·재저장, 닫기·재열기.

‘원본 없음’을 이유로 검사기를 전역 관대 모드로 바꾸거나 safe=true를 강제로 넣지 않는다. 기존 preflight의 재사용 가능한 부분과 생성 전용 검증을 분리한다. 동일 엔진의 공통 결함을 놓칠 수 있으므로 외부 한글/Word에서 열리는지는 별도 상호운용 결과로 기록한다. 이번 문서가 외부 상호운용 시험 성공을 주장하지 않는다.

### 엔진/백엔드 신뢰 경계

**설계:** WordCraft 신규 생성은 기존 Rust 경로를 재사용한다. RHWP는 우선 검증된 WASM에서 후보를 만들고 Rust의 좁은 생성 검증/게시 경계로 전달하는 방식을 평가한다. 파일 쓰기 권한을 가진 Rust는 요청 형식·출력·길이/구조·참조·목적지와 작업 신원을 직접 검사해야 한다. 프런트엔드가 보낸 ‘빈 문서’/‘무손실’ 표시는 단독 권한 근거가 아니다.

현재 백엔드가 생성의 의미적 속성까지 입증할 수 없는 부분은 T021에서 명시한다. 필요한 경우 검증된 결정적 템플릿/출력 신원 또는 별도 제한된 검증 경로를 설계한다. 해당 경계가 불충분하면 제품 생성을 켜지 않는다. RHWP를 Rust에 새로 링크하거나 엔진 전체를 포크하는 것은 자동 승인하지 않는다.

### 게시·등록·경합

대상이 이미 존재하면 파일/링크를 덮어쓰지 않는다. UI의 사전 존재 확인만 믿지 않고 create-only 게시의 충돌 검사를 사용한다. 게시 이후 대상이 교체되는 경우도 검증하여, 등록하는 파일이 검사한 출력과 같은 파일인지 확인해야 한다. 이것은 신규 수용 항목이며 현재 코드의 해당 경쟁 결함을 재현했다고 주장하는 것은 아니다.

중복 요청, 형식/경로 선택 취소, 탭 전환, 창 닫기, 늦은 완료를 operation ticket과 세션/세대 소유권으로 관리한다. 게시 전 취소와 게시 후 취소는 결과가 다르다. 게시 후 실패라고 사용자 파일을 자동 삭제하지 않는다. 임시 파일 잔류·정리 실패도 실제 상태대로 보고한다.

## 8. 신규 문서 UI와 포커스

| 표시 | 엔진 | 최초 단계 저장 |
|---|---|---|
| Word 문서 (.docx) | WordCraft | 생성 전에 새 경로 선택 |
| 한글 문서 (.hwp) | RHWP | 형식별 생성 검증 후 지원 |
| 한글 XML 문서 (.hwpx) | RHWP | 형식별 생성 검증 후 지원 |

형식 선택은 키보드 탐색·취소·ko/en 라벨을 제공한다. 생성·파일 대화상자 중 명령 충돌을 기존 modal/file-operation 경계로 막는다. 기존 문서의 조합을 새 문서로 옮기거나 조용히 버리지 않는다. 새 요청을 시작할 때 기존 입력 처리 정책을 그대로 따르고 두 엔진에서 회귀한다.

편집기 ready와 첫 표시 후 자동 포커스를 연결한다. 다만 사용자가 다른 탭/모달로 이동한 경우 늦게 끝난 생성이 포커스를 뺏으면 안 된다. 새 탭이 선택되었지만 엔진 로드가 실패한 경우 파일 생성 성공과 편집기 실패를 따로 알린다. 시작 화면을 가짜 contenteditable로 바꾸어 세션 없이 입력을 받지 않는다.

## 9. 필요한 수정 영역

| 영역 | 재사용/확장 내용 |
|---|---|
| `src/App.tsx`·명령 레지스트리 | 기존 file.new/Ctrl+N 재사용, 형식 선택과 모달/가용성 연결 |
| `src/components/Editor/Editor.tsx` | 무문서 안내·활성 표면·실제 ready/paint 이후 초점 |
| `documentWorkspace.ts` | newDocx 확장, file-operation/ticket·취소·늦은 결과·기존 입력 보호 |
| `filePort.ts`·공유 IPC 타입 | 요청 형식과 응답의 엔진/형식/초기 상태 검증; 오류의 실제 의미 유지 |
| `rhwp/rhwpModule.ts` | 현재 generation의 생성 팩터리·템플릿 초기화·export 자원 계약 |
| `src-tauri/src/services/files.rs` | 형식별 생성 요청·검증·create-only 게시·등록 경계 |
| `src-tauri/src/services/save/` | 기존 검사/게시 재사용, 신규 생성 유효성·정규화 후 재검증 |
| `src-tauri/src/document/` | 세션 식별·형식·파일 신원·등록 결과; 선택적 pathless는 별도 |
| `src/language/` | 선택/취소/미지원/게시 후 실패/로드 실패 문구 |
| 로컬 `tests/integration/new-document/` | 실제 생성·편집·재저장·오류/경합 시험 (계획 경로) |

후보 경로이지 모든 파일 수정이 필수라는 뜻은 아니다. 임의 엔진 명령이나 범용 경로 쓰기 IPC를 노출하지 않는다. 권한/capability 등록을 변경할 필요가 생기면 실제 기존 IPC 진입점과 대조해 최소화한다.

## 10. 개발 단계와 완료 판정

### 단계 A — T021: API·출력·검증 경계

현재 선택된 Release의 pin/패치/source tree/JS/WASM hash를 고정한다. createEmpty와 템플릿 초기화의 출력, HWP/HWPX export, 빈 문서 구조, 손실 보고, 재열기, 기본 입력 후 저장 가능성을 확인한다. 템플릿 출처·메타데이터와 Rust 검증 경계를 함께 정한다. 형식별 결과를 따로 보고한다.

### 단계 B — T022: 형식 선택과 안전 생성 통합

검증된 경로만 제품 facade·IPC·Workspace·UI에 연결한다. DOCX 기존 생성과 응답 검증은 유지한다. 최초 단계는 형식 → 위치 선택이며 자동 포커스·취소·중복/늦은 요청 처리를 함께 구현한다. UI는 T011 전체 완료를 기다릴 필요 없이 기존 file.new 경계를 재사용할 수 있다.

### 단계 C — T023: 실제 편집·저장 수용

세 형식 각각 새 문서 → 실제 IME → 줄 나누기/합치기·선택/삭제 등 지원 기본 편집 → 저장 → 추가 편집·재저장 → 닫기·재열기를 확인한다. 생성한 빈 문서가 기본 입력 후 저장을 거부하면 해당 신규 생성 수용은 실패다. 안전하게 거절했다고 양성 시험을 통과로 바꾸지 않는다.

기존 대상, 잘못된 확장자, 권한, 공간 부족, 내보내기/보고서/참조 실패, 게시 전후 동기화 실패, 세션 용량/등록 실패, 로드 실패, 취소·연타·탭/창 경합을 시험한다. 실패 주입은 실제 전원 차단 시험과 구분한다. 미지원 고급 명령을 시험 때문에 활성화하지 않는다.

### 단계 D — 통합 UI 마감

T022/T023에 형식 선택·오류 안내·초점·단축키 회귀를 포함한다. 생성 백엔드만 완료하고 UI는 검증 밖으로 남기지 않는다. 지원하지 않는 형식은 비활성 사유를 표시하되 세 형식 전체 기능 완료로 보고하지 않는다.

### 단계 E — T024: 선택적 미저장 문서

별도 승인 뒤 제목 없음 세션을 도입한다. pathless source identity, 첫 저장/취소/충돌, 저장 중 추가 편집, 저장 뒤 경로/형식 고정, dirty·닫기·복구를 명시한다. 임의 숨김 파일을 만들어 이미 저장된 문서인 것처럼 처리하지 않는다. RHWP 일반 미저장 자동 복구가 기존에 구현됐다고 가정하지 않는다. T024는 기본 생성·출시의 선행이 아니다.

## 11. 기존 Task와의 관계

T007–T010은 △로 관리하고 T011 제한된 개발을 허용한다. 이는 기술 PASS가 아니라 사용자 승인에 따른 진행 정책이다. D2와 D4 조사는 보류하며 RHWP 제품 history/서식 차단은 유지한다. T011 변경이 실제 입력·저장에 회귀를 만들면 그 결함을 먼저 해결한다.

T021–T023은 현재 검증된 표면·저장을 재사용한다. T009 전체 환경 수용이나 T010 50ms 목표, 모든 외부 HWPX의 호환성을 무조건 선행으로 추가하지 않는다. 사용한 경계의 신원 대조·회귀는 생략하지 않는다. T015는 새 생성 기능의 수용도 포함하고 T016은 확장 환경·배포 검증을 맡는다.

기존 Task ID와 완료 근거를 보존하고 새 작업 ID만 추가한다. 제공된 원문의 ‘상태/의존성 불변’은 이번 승인 전 일반 원칙이었으며, 승인된 변경은 spec/plan/tasks에 명시한다. 세모 표시는 전체 완료 체크가 아니다.

## 12. 유지할 원칙

독립 엔진·원본 형식·안전 저장·create-only·세션/세대/revision·IME 소유권을 유지한다. 엔진 원본/submodule/패치를 근거 없이 바꾸지 않는다. API 존재와 실행 성공, 게시와 내구성, 기본 편집과 고급 명령, 기존 문서 왕복과 신규 생성, 합성 시험과 native 수용을 구분한다.

문서·메타데이터·비공개 경로·개인 원문을 공개 로그/fixture에 올리지 않는다. 실제 출고 자산의 권리/고지는 따로 확인한다. 한 source/환경의 PASS를 모든 버전/플랫폼/파일로 확대하지 않는다. 실제 위험을 미지원 안내나 보류라는 이름으로 숨기지 않는다.

## 13. 최종 판단

현재 DOCX 신규 생성은 실제 제품 경로에 연결돼 있고 HWP/HWPX는 연결돼 있지 않다. 기존 세 형식의 대표 안전 저장 근거는 있으나 신규 생성 성공을 대신하지 않는다.

우선 검증할 RHWP 경로는 단순 createEmpty 호출 완료가 아니라 **올바른 빈 구조/템플릿 → 요청 형식 export → 독립 검증/재열기 → 안전 게시/등록 → 실제 입력/재저장**이다. 이 문서는 그 구현 계약을 정리한 것이며 실행 성공이나 외부 한글/Word 호환성을 새로 확인한 보고서가 아니다.

## 14. 주요 근거와 검토 한계

geul 경로는 상단 고정 커밋에서 읽은 코드·기록이다.

- [DOCX 생성/게시](../../src-tauri/src/services/files.rs): document_new, blank_docx, create_docx, FilePublishedUnregistered.
- [FilePort](../../src/components/Editor/filePort.ts): 생성 응답 검증과 DOCX 전용 IPC.
- [Workspace](../../src/components/Editor/documentWorkspace.ts): newDocx, acceptAndLoad, loadOpened, file-operation/open ticket.
- [Editor](../../src/components/Editor/Editor.tsx): 무문서 자리표시자와 엔진 표면 분기.
- [RHWP facade](../../src/components/Editor/rhwp/rhwpModule.ts): generation·hash 검증 및 생성 API 미연결.
- [저장 서비스](../../src-tauri/src/services/save/service.rs), [저장 계약](./save-preservation.md), [저장 왕복 기록](./save-roundtrip-acceptance-2026-11-02.json).
- [고정 RHWP WASM API](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/src/wasm_api.rs): createEmpty/createBlankDocument 구분과 DocumentExport.
- [고정 RHWP 문서 명령](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/src/document_core/commands/document.rs): 템플릿 기반 초기화.

이번에는 현재 사용자 로컬 WASM, 새 HWP/HWPX 생성·native IME/저장, 외부 프로그램 상호운용, 실제 전원 차단을 실행하지 않았다. 해당 항목은 미실행이며 문서 검사 PASS와 합산하지 않는다. 절대 무오류를 보증하지 않고, 확인된 코드 사실·과거 근거·설계·미확인을 구분해 다음 구현자가 검증할 수 있게 한다.


## T021 실행 수용 — 2026-11-04

**COMPLETED.** 기준 HEAD `b0eed029` 위 구현. [실행 신원·형식별 결과](new-document-t021-2026-11-04.json). 제품 생성 활성화는 T022이며 native 생성 UX/IME는 T023이다. 기존 절의 API 후보/NOT RUN은 당시 정적 조사 기록이다.

### 후보 비교와 선택

현재 Release `853a0689…` 및 Debug `0c2faef3…`의 검증된 facade로 실행했다. JS/WASM SHA-256과 순서 있는 11개 패치는 연결된 JSON에 기록했다. 별도 raw module로 문서 팩터리를 대체하지 않았다.

- A `createEmpty()`만 사용: HWP export/reopen 자체는 되지만 FileHeader version 0 및 기본 정의 부재로 독립 검사 부적합. HWPX는 첫 삽입·문단 분리 후 `charPrIDRef: [0]` 미등록 참조로 export 실패. 제품 경로로 거절.
- B fresh `createEmpty()` → 인스턴스 `createBlankDocument()`: 반환은 새 객체가 아닌 JSON 문자열. HWP/HWPX 모두 기본 편집·export/reopen 성공. 다만 HWP에 작성자·마지막 저장자 및 과거 시각이 남는다. 활성 사용자 문서에는 호출하지 않았다.
- 선택 C: fresh 모델에 공개 API로 Noto Sans CJK KR(7개 언어 글꼴 이름, 폰트 바이트 미포함), 10pt 글자 모양, 160% 문단/기본 TabDef, Normal 스타일을 명시적으로 초기화한다. 내부 HWPX seed를 재열어 올바른 header/구역·단 정의를 확정하고 요청 형식으로 export/reopen한다. 내부 생성 seed는 사용자 문서 변환 기능이 아니다. 최종 HWP는 source `hwp`, 최종 HWPX는 source `hwpx`로 다시 열린다.

### 템플릿과 메타데이터

번들 템플릿은 pin의 `saved/blank2010.hwp`(Git blob `e8b886f370f6801188696aede9115fea31433774`)이며 `create_blank_document_native`가 include한다. 본체 MIT 고지 의무는 [rhwp 라이선스](../licenses/rhwp.md)를 유지한다. 얕은 체크아웃에는 템플릿의 최초 제작·취득 경위나 자산별 별도 허가가 없어 이를 별도로 승인된 사용자 템플릿으로 재배포하지 않는다. 새 경로는 템플릿 초기화를 호출하거나 템플릿 파일을 추가 배포하지 않는다.

HWPX 파서도 내장 기본 HWP extra streams를 보충한다는 사실을 실제 출력에서 확인했다. 따라서 C의 HWP export에도 summary/script/options가 생긴다. Rust `prepare_rhwp_blank`는 감사한 **정확한 출력 신원**을 먼저 확인하고 fresh CFB에 FileHeader·DocInfo·BodyText/Section0·PrvText·PrvImage·RhwpHwpxOrigin만 복사한다. 제거된 메타데이터가 slack/free sector에도 남지 않는다. 최종 HWP는 이 바이트를 재열어 사용한다. HWPX 최종 패키지는 generic creator `rhwp` 및 비어 있는 날짜만 포함한다. 글꼴은 이름만 참조한다. 엔진 WASM에 이미 들어 있는 upstream 자산의 배포 고지 검토는 기존 T016 범위다.

### 검증과 신뢰 경계

`createRhwpBlank`는 임시 모델·독립 reopen·export result를 finally에서 free한다. source format, 서명, 1쪽/1구역/빈 문단, secd/cold, 올바른 손실 0건 보고, 추가 roundtrip 구조를 검사한다. 정상 및 손실 보고 실패 주입에서 살아 있는 모델/export 객체가 0임을 관측했다. 바이트/보고 상한은 64KiB/1KiB다.

Rust의 생성 권한은 프런트엔드 safe/blank/reopen 플래그가 아니다. 크기와 SHA-256으로 **감사한 결정적 빈 출력 두 종류만** 받고 loss schema/요청 형식/실제 판별/참조 검사도 적용한다. HWP는 위 생성 전용 정규화를 거친다. 엔진이 다른 출력으로 바뀌면 새 감사 없이 생성하지 않는다. 동일 바이트 자기 비교는 방어적 검사일 뿐 blankness의 근거가 아니다. 기존 사용자 파일의 원본 대 출력 보존 검사는 변경하지 않았다.

독립 Python CFB/FAT/miniFAT/record 검사와 ZIP CRC/Expat XML 검사로 header/필수 항목/구역·문단/기본 글꼴·모양·스타일·TabDef/참조/manifest/spine/빈 본문/부가 스트림을 검사했다. 잘린 CFB, 잘못된 HWP version, 누락 header, 미등록 charPr 참조, 비어 있지 않은 본문, 잘못된 글꼴을 거절했다. Rust는 임의/과대 출력, 변조 바이트, 편집된 문서, 불일치·가짜 손실 보고를 거절한다.

### 재현과 관측 결과

1. `node scripts/tests/new-document-runtime.mjs target/new-document/runtime RELEASE.json`
2. `npm run rust -- test --lib --no-run` (보호 빌드). 출력된 test binary의 `services::creation::tests::prepare_current_wasm_blanks --ignored --exact` 실행. `GEUL_NEW_DOCUMENT_DIR`는 생성 출력 디렉터리.
3. 위 Node 명령에 `--prepared`를 추가해 최종 정규화 바이트의 삽입/분리/병합/삭제/추가 삽입 및 2회 export/reopen 실행.
4. `python3 scripts/tests/new-document-structure.py target/new-document/runtime`.
5. 같은 test binary의 `services::creation::tests::current_wasm_creation_and_two_real_safe_saves --ignored --exact` 실행. TMPDIR는 신뢰 가능한 task-owned 디렉터리. 실제 stage_new/publish_new/register/load/commit/preflight/save를 거친다.
6. Node 명령의 `--published`로 Rust가 실제 저장한 두 출력의 요청 형식과 기대 본문 재검사. Debug도 별도 디렉터리 및 `DEBUG.json`으로 같은 단계 실행.

두 generation 각각 HWP/HWPX의 첫 입력·문단 편집·첫 안전 저장·재저장·최종 파일 재열기 **PASS**. 원본 보존을 우회한 저장은 없다. 최초 진단의 보호 래퍼 내 시험은 강제된 `/tmp` 때문에 SharedDirectory로 거절됐다. 검사를 완화하지 않고 보호 빌드한 시험 binary를 private TMPDIR에서 실행했다. 중간 probe의 `mergeParagraph(0,0)` 및 record_content 누락도 시험 사용 오류로 바로잡았으며 제품 결함으로 세지 않는다.

이 결과는 Node에서 실제 제품 WASM과 Rust 게시/저장 경계를 결합한 T021 수용이다. native Tauri UI·실제 IME·초점/동시성 및 외부 한컴/Word 상호운용 PASS를 뜻하지 않는다. T007–T010의 기존 미검증/실패와 T024 보류는 그대로다.


## T022 제품 통합 수용 — 2026-11-04

**COMPLETED.** 선행 커밋 `6c0356e`의 T021 경계만 재사용한다. 이 절이 현재 제품 상태이며, 위 기존 DOCX 전용 구현 설명은 최초 검토 기준의 이력이다. T023 당시 미실행이었던 native 생성/IME는 아래 후속 수용 기록을 따른다.

- 기존 `file.new`/Ctrl+N → ko/en 형식 선택 dialog(라디오/방향키/Tab 가두기/Escape/취소) → 선택 형식의 native destination → 생성/등록 → engine load 순서다. 세 형식 모두 T021 검증 경로를 사용한다. DOCX는 Rust WordCraft blank 생성·직렬화/검증을 그대로 사용하며 RHWP를 호출하지 않는다. `newDocx`는 이미 DOCX를 선택한 호출자를 위한 같은 pipeline의 호환 wrapper다. 경로 없는 T024는 활성화하지 않았다.
- `FilePort.createDocument(format,path,blank?)` → 기존 `document_new`에 bounded raw frame `GNC1` + u32 LE metadata length + strict JSON `{path,format,contentLoss}` + RHWP bytes를 보낸다. metadata 8KiB/blank 64KiB, admission/operation 자원을 payload 복사 전에 확보한다. DOCX는 payload와 손실 보고를 받지 않는다. RHWP는 T021 digest·구조/형식/손실 검사와 HWP 메타데이터 정규화를 거친다. 임의 바이트를 파일로 쓰는 명령이 아니다.
- `destination` → `stage_new`의 쓰기/되읽기/fsync → `publish_new`의 create-only 원자적 게시/디렉터리 fsync → `identify` → `register_created`를 재사용한다. 등록 전에 **게시한 inode·지문·형식·전체 바이트**와 다시 판별한 파일을 비교한다. 같은 경로에 같은 바이트의 다른 inode가 들어와도 등록하지 않는다. 기존 파일/심볼릭 링크와의 충돌은 덮어쓰지 않는다.
- 내구성 미확인 등록은 dirty로 남기고 전용 안내를 표시한다. 게시 후 등록 실패는 FilePublishedUnregistered, 등록 후 engine load 실패는 FileCreatedEditorFailed로 구분해 파일이 존재함을 알린다. 후속 실패 때문에 게시 파일을 삭제하지 않는다.
- FilePort는 요청 형식/담당 엔진/확장자/identified/revision·sequence·loadGeneration 0을 검사한다. 생성은 file-operation 및 open ticket으로 직렬화하며 선택/경로 취소 시 등록하지 않는다. 늦은 완료는 사용자의 탭 선택을 바꾸지 않는다. 창 닫기는 진행 중 파일 작업만 기다리고, 선택 중 닫기는 게시 전에 취소하며, 게시 뒤 닫기는 늦은 세션을 닫고 실제 게시 결과를 유지한다.
- 새 생성에만 focus lease를 부여한다. ready와 first usable paint를 구분하고 첫 paint 후 editable일 때 한 번 focus한다. 대기 중 pointer/key 입력 또는 modal focus가 생기면 의도를 취소한다. inactive 탭은 표면을 갖지 않으며 기존 open ticket 소유권을 유지한다. 일반 문서 열기/탭 전환의 기존 포커스 동작은 유지한다. New는 IME composition 중 시작하지 않는다. 공유 IME 거래 상태 기계·T011 명령을 바꾸지 않았다.

### 실제 검사

- `npm run typecheck`, `npm run lint`, `npm run rust -- fmt --check`, `npm run rust -- clippy --lib --bins -- -D warnings`: PASS.
- 최종 `npm test`: **55개 파일/1,012개 PASS**. format dialog, FilePort 응답, 생성/취소/중복/탭·닫기/engine failure, 두 표면의 first paint와 focus lease 및 기존 IME·리본·모달 회귀 포함.
- protected `npm run rust -- test --lib --no-run`으로 만든 binary를 private TMPDIR + T021 현재 WASM fixture로 실행한 `services::files::tests --include-ignored`: **6/6 PASS**. 세 형식 실제 create-only/등록/중복 요청, 파일/심볼릭 링크 보존, 게시 후 inode 교체, 프레임·경로 검사, 등록 capacity 실패 뒤 파일 존속을 확인했다.
- `VITE_GEUL_TEST_HOOKS=1 npm run tauri -- build --debug --no-bundle`: PASS. WASM 재빌드·gitlink 변경 없음. native 실행 수용은 T023에서 별도 수행한다.
- 중간 전체 회귀의 7개 실패는 첫 paint 조건이 일반 open까지 적용된 것과 idle close에도 await가 들어간 회귀였다. 일반 open의 기존 동작을 복원하고 진행 중 파일 작업이 있을 때만 닫기를 기다리도록 수정했다. 영향받은 80개 및 새 creation first-paint 4개 PASS 뒤 위 최종 전체 suite를 통과했다. 시험을 약화하거나 과거 실패를 PASS로 바꾸지 않았다.

최초 생성물의 외부 한컴/Word 호환성은 여전히 NOT RUN이다. 엔진 상수 미리보기의 기존 제한([저장 계약](save-preservation.md), 68-byte PNG의 checksum 문제 포함)을 외부 호환성 PASS로 확대하지 않는다. 독립 구조 판정은 문서 구조·참조·본문과 명시된 고정 미리보기 신원 범위다. T007–T010의 전체 수용/실패 상태는 변경하지 않았다.


## T023 결함 수정과 검증 경계 — 2026-11-04

T022 커밋 `3cd35663b98caa736b81c1792b6c2f5d68f16aeb` 위에서 발견한 다음 세 경계를 수정했다. 각 실패 기록은 task-owned 로컬 evidence에 남기며 이전 결과를 다시 수행한 것으로 바꾸지 않는다.

1. **게시 전 취소:** 취소된 resource operation도 신규 생성이 게시되는 회귀를 먼저 재현했다. `create_validated`에 active 검사·BeforePublication 자원 예약·publication permit을 적용했다. 취소/자원 거절 시 목적지와 세션이 없고 task-owned staging과 예약은 해제된다. 기존 파일은 건드리지 않는다.
2. **모달 중첩:** 수정 중인 기존 문서에서 New 형식 선택 중 native 창 닫기를 요청하면 두 `aria-modal`이 겹쳤다. 창 닫기 확인이 소유하는 동안 New dialog DOM을 suspend하고, 취소하면 선택한 형식과 초점을 복원한다. 늦은 engine ready가 확인창 초점을 빼앗지 않는다.
3. **내구성 미확정 안내:** 최초 등록의 dirty/revision·generation 0은 게시 내구성 미확정이다. RHWP의 reload 보호가 이를 `UnpreservedChanges`로 거절하는 것을 `FileCreatedEditorFailed`로 오인했다. 세 형식 모두 identified/dirty 등록을 보존하고 자동 load를 보류하며 별도 안내를 표시한다. 사용자가 상태를 확인해 명시적으로 다시 열도록 한다. 보호 상태를 자동으로 지우거나 저장 성공으로 표시하지 않는다.

Rust의 controlled failure는 staging 생성/생성 직후/StorageFull 쓰기/readback/file fsync/publication/directory fsync, resource 거절과 취소를 구분한다. 게시 전에는 파일·세션·잔여 staging이 없고, 디렉터리 fsync 실패 뒤에는 게시 파일과 dirty 세션이 남는다. 이는 실제 정전·디스크 고갈 시험이 아니다. native uncertainty 탐침은 실제 게시 후 반환 응답의 dirty만 바꿔 UI 처리 경계를 검사하며 실제 fsync 오류 주입과 구분한다.

공개 저장소에는 재현 가능한 작은 하네스 `scripts/tests/native-new-document*.py`와 요약 JSON만 둔다. 앱·WASM·문서·스크린샷·원시 로그는 ignored `target/new-document/`에 두고 기존 별도 geul-tests의 driver/POC/process ownership helper를 재사용한다. 사용자 문서·전역 설정·submodule·WASM generation은 변경하지 않는다.


## T023 최종 native 수용 — 2026-11-04

**COMPLETED.** [실행 신원·항목별 결과·명령·로컬 evidence digest](new-document-native-acceptance-2026-11-04.json). 소스는 T022 HEAD `3cd35663b98caa736b81c1792b6c2f5d68f16aeb` + T023 product diff SHA-256 `1683eed9bc79673cdbb58fb6bd071617463a480ef43bd7a96ddad12914e904d9`다. 앱 SHA-256은 `eb9915cc05966f6271eb30027b71bff7cca798e2aadf4a4b33976a9884162e12`다. 아직 생성하지 않은 최종 커밋에서 실행했다고 주장하지 않는다.

환경은 NixOS 26.05 userspace/Linux x86_64, Xvfb X11 1280×1024·96dpi, WebKitGTK 2.54.1, IBus 1.5.33/ibus-hangul 1.5.5다. 격리 D-Bus·test HOME의 Nanum 글꼴·GTK schemas를 사용했고 실제 XTest 입력이 GTK/IBus를 거쳐 WebView compositionstart/end로 전달됐다. 합성 DOM 조합 이벤트는 사용하지 않았다. Debug generation `0c2faef3a2966c4d717d50b83f51f839f5b4a14a7c26935723edc38bd36a90c4`와 JS/WASM hash, RHWP pin·11개 패치, WordCraft pin은 JSON에 기록했다. 같은 identity인 최종 native21/23/24/25/26만 수용 행렬에 포함했다.

| 실제 제품 경로 | DOCX | HWP | HWPX |
|---|---|---|---|
| native Ctrl+N·형식 선택·GTK 위치 선택·create-only·등록 | PASS | PASS | PASS |
| 담당 엔진·요청 형식·빈 1쪽·first paint·입력 focus | PASS | PASS | PASS |
| 실제 한글 IME·영문·삽입/삭제·문단 분리/병합·커서/선택 편집 | PASS | PASS | PASS |
| 첫 안전 저장·추가 편집·두 번째 안전 저장 | PASS | PASS | PASS |
| 닫기·native Open·새 세션 재열기·원래 형식/본문 | PASS | PASS | PASS |
| 독립 ZIP/XML 또는 CFB/현재 preview 검사 | PASS | PASS | PASS |

최종 본문은 세 형식 모두 **`한글 Changed Second`**이며 한글이 저장 파일과 재열기 모델에 남았다. 생성 직후 및 저장 후 스크린샷 6개를 확인했다. HWP/HWPX 저장은 loss report·원본 보존·구조/참조·reopen 검사를 그대로 통과했고 안전 거절을 양성 저장 성공으로 세지 않았다.

실패·동시성 **24개 PASS**: 기존 파일/심볼릭 링크, 잘못된 확장자·실제 형식·구조·참조·손실 보고(불일치·잘못된 형식·가짜 safe), 실제 디렉터리 권한 거절, 64세션 용량/게시 뒤 등록 실패, 형식 취소·중복 Ctrl+N·위치 취소, 지연 생성 중 탭 전환·지연 ready 중 확인창 초점, 실제 IME와 Ctrl+N 소유권, 게시/등록 뒤 engine parse 실패, 실제 WASM export 예외와 임시 객체 해제, 세 형식의 보고된 내구성 미확정, 선택/수정 중 선택/게시 대기 중 native 창 닫기다. IME 조합은 GTK가 Ctrl+N 전달 전에 commit하는 경우도 관측해 이벤트 순서와 원래 문서에 한 번만 입력됨·다른 문서 불변을 확인했다.

최종 native 실행은 모두 PASS이고 scope cleanup 성공·잔여 프로세스 0이다. 실패한 과거 실행을 부분 추출해 행렬에 합치지 않았다. native22는 21개 검증 후 정리 단계의 WebDriver 클릭 연결이 끊겼으며 앱·WebProcess 생존과 진단 조회를 기록했다. 정리만 실제 X11 포인터 입력으로 바꾼 native23 전체 PASS로 대체했다. modal 결함 native14 및 미확정 응답/게시 취소의 고치기 전 실패 기록도 보존한다.

회귀: 최종 `npm test` **55파일/1,016 PASS**, ESLint PASS, test-hooks native debug build의 `tsc --noEmit`과 빌드 PASS. Rust 기본 suite **255 PASS/22 ignored**, 현재 WASM 생성 probe를 명시적으로 포함한 files 집중 **9 PASS**, fmt/clippy(lib·bins, warnings denied) PASS. 기본 ignored 22개 전체를 실행했다고 주장하지 않는다. 기존 저장/복구·충돌/내구·세션·IME·리본/모달/T011·형식별 표면 회귀를 포함한다.

native Release 앱·Wayland/fcitx5/GPU desktop·Windows/macOS·CPU 포화·실제 정전·외부 한컴/Word 상호운용은 **NOT RUN**이다. 고정 RHWP optional blank preview PNG checksum의 기존 한계는 유지한다. 이번 결과를 모든 문서·외부 프로그램의 호환성으로 확대하지 않는다. T007–T010의 전체 수용 상태와 T024 보류는 바꾸지 않았다. submodule pin·패치·생성 WASM 변경 및 push는 없다.

## T023 이후 안정화 — 2026-11-04

위 T022/T023 절은 당시 실행 기록이며 바꾸지 않는다. 아래가 그 뒤의 현재 동작이다.

### 창 닫기 중 완료된 생성의 결과 의미

T022 요약의 "게시 뒤 닫기는 늦은 세션을 닫고"는 더 이상 현재 동작이 아니다. 이전 구현은 창이 닫히는 중 `createDocument`가 성공하면 백엔드 세션을 닫고(그 결과는 무시) `FilePublishedUnregistered`를 돌려줬다. 성공 응답은 게시와 등록이 모두 끝났다는 뜻이므로 등록 실패로 보고하는 것은 사실과 다르다.

이제 성공 응답은 창 닫기 중에도 `acceptOpen`으로 일반 탭과 같은 소유권에 들어간다. 닫는 중에는 engine load와 focus lease만 하지 않는다. 별도의 세션 정리 단계가 없으므로 정리 실패를 성공으로 숨길 경로도 없다. 백엔드 세션은 다른 열린 탭과 같이 창 파괴(프로세스 종료)와 함께 끝난다. Rust가 실제로 등록에 실패한 경우만 `FilePublishedUnregistered`를 유지하며, 게시 파일은 어느 경우에도 삭제하지 않는다.

### 창 닫기 결정과 진행 중 파일 작업

재현: native `CloseRequested` 때 `Editor`는 `hasUnpreservedChanges`로 결정한 뒤 `closeWindow()`에서 진행 중 파일 작업만 기다리고 바로 `window_close_confirmed`(destroy)를 불렀다. 게시가 이미 시작된 New가 그 사이 `durable=false`(dirty 세션)로 끝나면, 그 게시를 모르는 이전 결정으로 창이 파괴됐다. 프런트엔드 시뮬레이션(`windowCloseCreation.test.tsx`)에서 수정 전 4/5/7/8번 사례가 실패했다. native에서도 T023 승인 앱(SHA-256 `eb9915cc…`)으로 응답만 dirty로 바꾼 진단 실행에서 세션 없이 destroy가 호출됨을 관측했다.

선형화 지점: 게시 전(형식 선택·위치 선택·export 뒤)의 `windowClosing` 확인은 게시 없이 취소한다. `createDocument`가 시작되면 취소할 수 없고, 결과는 `acceptOpen`에서 세션 목록에 들어간다. 창 닫기의 마지막 결정 지점은 `waitForFiles()` 뒤다.

현재 동작: 창 닫기 요청은 그때 확인을 받은 미보존 세션 집합(`covered`)을 기억한다. `waitForFiles()` 뒤 그 집합에 없는 미보존 세션이 생겼으면 destroy하지 않고 `windowClosing`을 풀고 같은 창 닫기 확인을 다시 연다(초점은 취소 단추, `aria-modal` 하나). 세션 없이 파일만 남긴 게시 결과(`FilePublishedUnregistered`/`FilePublishedUnconfirmed`, 복구 restore 포함)가 생겨도 destroy하지 않고 닫기를 되돌린다. 안내는 기존 알림으로 보이고, 다음 닫기 요청은 평소대로 처리한다. 반복 요청은 기존 `closingWindow`/확인창 단일성으로 한 번만 처리하며, 시간 제한은 추가하지 않았다. 게시 파일은 삭제하지 않고, 내구성 미확인 세션은 자동 load하지 않는다.

증거 구분: 프런트엔드 시험과 native `unconfirmed-publication` 모드는 실제 게시 뒤 **응답만 dirty로 바꾼 시뮬레이션**이다(Rust 세션은 실제로 durable). 실제 디렉터리 fsync 실패 주입은 Rust `services::files` 시험(`Fault::DirSync`)뿐이다. native 결과는 Debug test-hooks 빌드·Xvfb/X11·IBus 환경이며 Release·Wayland·실제 정전은 NOT RUN이다.

### RHWP 생성 가용성 보고

생성 권한은 그대로 Rust `validate_rhwp_blank()`의 형식·크기·**감사된 SHA-256**·손실 보고·실제 형식·보존 검사다. 기준을 완화하지 않았다. 바뀐 점은 보고 방식이다.

- 감사된 크기/digest와 다른 출력(예: 미래 RHWP generation)은 `InvalidRequest` 대신 `CreationUnverified { format }`로 거절한다. 거절은 `prepare_rhwp_blank()` 단계이므로 staging·게시 전이다. 손실 보고·형식 불일치 등 요청 모양 오류는 그대로 `InvalidRequest`다.
- 프런트엔드는 엔진 초기화 실패(`EngineFailure` stage `init`), 생성 API 부재(`CreationUnavailable`), WASM export 실패(`EngineFailure` stage `export`), 미검증 출력(`CreationUnverified`), 게시 실패(기존 저장/게시 오류)를 구분해 ko/en 문구로 알린다.
- 생성 API 부재와 Rust의 미검증 판정은 로드된 runtime에서 결정적이므로 workspace가 실행 동안 기억한다. 형식 선택 dialog는 그 형식을 비활성화하고 이유를 설명하며(방향키도 건너뜀), 같은 형식은 위치 선택 없이 같은 오류로 끝난다. 엔진 초기화 실패는 일시적일 수 있어 기억하지 않는다. 프런트엔드 기억은 형식을 **막을** 뿐이며 허용 근거가 되지 않는다. 모든 생성은 계속 Rust가 다시 검증한다.
- 사전 탐지(위치 선택 전 Rust 검증)는 추가하지 않았다. 처음 미검증 출력을 만나면 위치 선택 뒤 쓰기 전에 거절되고, 그 뒤로는 제공하지 않는다.

검증: Rust `changed_engine_output_is_reported_unverified_and_never_authorized`. T021 Release runtime fixture(generation `853a0689…`)로 ignored 생성·2회 안전 저장 시험 PASS(1바이트 변경은 `CreationUnverified`). native safety에 실제 Rust 검증기로 바뀐 바이트를 보내는 `unverified` 단계를 추가했다. 쓰기 없음·HWP 비활성화·HWPX/DOCX 유지를 확인했다. Debug test-hooks 앱(RHWP Debug generation `0c2faef3…`)의 세 형식 양성 native 왕복 PASS.

### 안정화 검증 요약 — 2026-11-04

로컬 evidence는 ignored `target/stabilization/`에 있다. 최종 앱은 Debug test-hooks 빌드 SHA-256 `2c7b49c5faad1439c03613e6be983b1fa2d747297ccc8a769cb67ba2f153aa35`이고, RHWP Debug generation `0c2faef3a2966c4d717d50b83f51f839f5b4a14a7c26935723edc38bd36a90c4`다. RHWP/WordCraft pin·패치·WASM은 바꾸지 않았다.

- frontend `npm test` 56파일/1,032 PASS, `tsc --noEmit`·ESLint PASS.
- Rust 기본 suite 256 PASS/22 ignored(보호 빌드한 test binary를 private TMPDIR에서 실행). `services::creation` ignored 포함 4 PASS. fmt check·clippy(lib·bins, `-D warnings`) PASS.
- native X11/IBus: 양성 3형식, safety 22개(신규 `unverified` 포함), 창 닫기 4모드(`unconfirmed-publication` 신규·`publication`·`dirty-selection`·`selection`) PASS. 모두 정리 성공·잔여 프로세스 0이다.
- NOT RUN: native Release 앱, Wayland/fcitx5, GPU desktop, Windows/macOS, 실제 정전, 외부 한컴/Word 상호운용, native 실제 디렉터리 fsync 실패.

## 2차 안정화 — 2026-11-04

### 복구 복원 게시 뒤 열기 실패와 창 닫기

`restoreRecovery()`에서 Rust `restore()`는 durable 게시 뒤 경로를 반환하고, 프런트엔드가 별도 IPC로 `backend.open()`을 호출한다. 이전에는 이 열기가 실패하면 원래 오류(예: `ResourceLimit session-count`)만 반환했다. 그래서 파일 생성 사실이 빠졌고, `notePublication()`도 호출되지 않아 대기 중인 창 닫기 결정이 그대로 창을 파괴했다. 수정 전 프런트엔드 시험에서 실패를 확인했다. 이제 이 경우를 `RestoredUnopened { cause }`(ko/en 문구에 원인 포함)로 보고하고, 기존 게시 안내 카운트로 창 닫기를 되돌린다. 게시 전 거절(`FileConflict` 등)과 정상 복원·열기는 닫기를 막지 않는다. native `restore-unopened` 모드는 실제 DOCX 체크포인트·실제 restore 게시·실제 64세션 용량 열기 실패를 쓴다. 위치 선택 결과만 하네스가 넣었다. 창 유지, 파일·후보 유지, 다음 확인된 닫기 1회 종료가 PASS다.

### 생성 증거 출력 소유권

사고: ignored Rust 시험 `prepare_current_wasm_blanks`는 `std::fs::write`로 `prepared.*`를 썼다. 그래서 기존 `target/new-document/runtime/prepared.hwp`(이전 SHA-256 `bc2c8c10…`, `structure.json`에 기록)를 `39156ddb…`로 덮어썼다. 원본 바이트는 복원할 수 없으며 해시로 재구성하지 않는다. Node probe(기본 출력이 기존 evidence 디렉터리)·`published-N`·`structure.json`도 무조건 덮어썼다. `--prepared` 단계는 같은 디렉터리의 1단계 `unedited/first-save/second-save`를 일부러 덮어썼다.

현재 규칙(`scripts/tests/evidenceOutput.mjs`):
- 실행 디렉터리는 명시해야 한다(기본 경로 없음). 1단계는 새 디렉터리나 빈 디렉터리만 받는다. `--prepared`/`--published`·Rust ignored 시험·`structure.py`는 같은 실행에 **새 파일만** 더한다.
- 모든 출력은 배타 생성(Node `wx`, Rust `create_new`, Python `x`)이다. 이미 있으면 실패하고 기존 파일은 그대로다. 변환한 `.mjs`와 결정적 raw `blank.*`만 같은 바이트일 때 재사용한다.
- 1단계의 raw blank 편집 출력은 `raw-unedited/raw-first-save/raw-second-save`로, `--prepared` 출력은 Rust 안전 저장 시험이 읽는 `unedited/first-save/second-save`로 분리했다. 1단계 후보 비교(`empty/template-edited`)는 `--prepared`에서 다시 하지 않는다.
- `structure.py`의 음성 대조군 임시 파일은 실행 디렉터리 밖의 시스템 임시 디렉터리에 둔다. 덮어쓰기 옵션은 두지 않았다. 다시 만들려면 새 실행 디렉터리를 쓴다.

재현(실행마다 새 `<run>`): `node scripts/tests/new-document-runtime.mjs <run> RELEASE.json` → test binary `services::creation::tests::prepare_current_wasm_blanks --ignored --exact`(`GEUL_NEW_DOCUMENT_DIR=<run>`) → `... <run> RELEASE.json --prepared` → `python3 scripts/tests/new-document-structure.py <run>` → `current_wasm_creation_and_two_real_safe_saves` → `... --published`.

관측: Release 2회·Debug 1회를 각각 새 디렉터리에서 실행해 6단계 모두 PASS했다. 같은 디렉터리에서 각 단계를 다시 실행하면 6단계 모두 기존 파일 때문에 실패했고 디렉터리의 47개 파일 해시는 그대로였다. 기존 `target/new-document/runtime`은 1단계가 비어 있지 않은 디렉터리로 거절했다. `target/new-document`의 기존 583개 파일 해시도 그대로였다. 회귀: Rust `evidence_writer_never_replaces_existing_output`, `node --test scripts/tests/evidenceOutput.test.mjs`(2개).

### HWP 준비 출력의 비결정성

같은 감사 raw blank(`d1a43b6c…`, Release·Debug 동일)에서 만든 `prepared.hwp` 4개(새 실행 3개 + 기존 1개)를 비교했다. 차이는 CFB 디렉터리의 `BodyText` storage 항목 생성/수정 FILETIME(offset 100–115)뿐이었다. 두 필드를 0으로 정규화하면 모든 쌍이 바이트 동일하다. 기록된 시각은 각 실행 시각(UTC)이다. 원인은 cfb 0.14 `create_storage`의 `Timestamp::now()`이며, 스트림 순서·할당·내용은 같다. 구조 보고(해시 제외)도 기존 `structure.json`과 같다.

영향: 생성 권한은 결정적인 raw blank digest에 묶여 있고, 준비 출력은 생성 전용 `check_saved`와 구조 검사로 검증한다. 준비 출력의 바이트 동일성은 계약이 아니다. 따라서 해시 차이는 손상이 아니며, 내용 보존과 안전 저장 2회 결과도 같다. CFB 직렬화는 바꾸지 않았다. 생성 문서에는 생성 시각 하나가 남는다(개인 메타데이터 제거 범위 밖의 일반 시각 정보). 분석 스크립트와 결과는 ignored `target/stabilization/s2-p2/`에 있다.

### 창 닫기 확인 문구의 구분

Rust 세션의 `dirty`는 `revision != clean_revision || unconfirmed`다. 생성 등록이 `durable=false`이면 revision 0·loadGeneration 0에서 dirty가 된다. 이런 세션은 엔진에 한 번도 불러오지 않았으므로 메모리 편집이 있을 수 없다. 창 닫기 확인은 요청 때 덮는 미보존 세션을 다음처럼 나눈다(`windowCloseKind`).
- `edits`: 기존 문구("편집을 버리고 종료").
- `durability`: 생성 직후 내구성 미확인만 있음. "디스크 기록을 확인하지 못한 새 문서" — 파일은 만들어졌고 지우지 않지만, 종료한다고 기록이 확인되지는 않는다. 버튼은 "확인하지 않고 종료".
- `mixed`: 둘 다. 편집 문구에 미확인 파일 안내를 더한다.

세션 없이 파일만 남은 게시(`FilePublishedUnregistered`·`RestoredUnopened` 등)는 확인 창이 아니라 해당 오류 안내와 닫기 되돌림으로 알린다. 취소·확인·Tab/Escape·초점 복원·단일 확인 창·낡은 결정 재확인은 그대로다. 한계: 저장 뒤 `durable=false`로 남은 세션(revision > 0)은 프런트엔드 정보만으로 편집과 확실히 구분할 수 없어 보수적으로 `edits`로 표시한다. 내구성을 확인했다고 말하는 문구는 없다. 검증: `windowCloseWording.test.tsx`(ko/en 상태별 문구·동작, clean 무확인). native close 하네스는 `unconfirmed-publication`의 `durability`, `dirty-selection`의 `edits`를 확인한다.
