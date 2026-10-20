# 명령 레지스트리·가용성·실행 취소 (T010)

FR-007(명령 레지스트리)과 SC-003(서식·실행 취소·미지원 명령을 실제 엔진에서 확인)의 T010 몫. 상황별 리본은 T011, 형식별 고급
명령은 T012·T013이 맡는다. 이 문서는 T010에서 정한 경계와 근거, 남은 한계를 적는다.

## 구조

| 파일 | 역할 |
|------|------|
| `src/commands/registry.ts` | 명령 정의 하나뿐인 표: 변하지 않는 ID, 번역 라벨 키, 단축키, 범위(전역·문서), 엔진별 지원(`supported`·`unsupported`). 리본에 있지만 연결하지 않은 명령은 `planned`. 단축키 정규화·충돌 검사. |
| `src/commands/target.ts` | 명령 대상 계약 `DocumentCommandTarget`(`snapshot()`, `execute(id)`)과 상태 `DocumentCommandSnapshot`. |
| `src/commands/capability.ts` | 가용성 결정 `documentCommandState(id, snapshot)`(순수 함수). 화면과 세션이 같은 함수를 쓴다. |
| `src/commands/commands.ts` | 실행 경계: 화면 배치 명령은 여기서, 문서 명령은 활성 편집 세션으로. 쓸 수 없으면 아무것도 바꾸지 않고 이유를 알린다. |
| `src/commands/shortcuts.ts` | 창 keydown → 레지스트리 명령(IME·입력 칸 보호). |
| `RhwpEditorSession`·`DocxEditorSession` | 명령 대상 구현. 명령은 각 세션의 기존 편집 경로(T007·T008)와 저장 절차(T009)로만 실행된다. |
| `src-tauri/src/adapters/wordcraft/engine.rs` | 허용 연산에 `undo`·`redo`·`format{format}`, 보기에 `history{undo,redo}`·`format{bold,italic,underline,strikethrough}`. |

T006의 자리표시자 `src/adapters/engines.ts`(`EngineAdapter`, 모든 명령 `engine-not-integrated`, `EngineUnavailable`)는 실행 경로에서
쓰이지 않았고 편집 세션과 다른 두 번째 엔진 경계였으므로 지웠다. 명령 대상은 편집 세션 자신이다.

## 설계 검토 결과

| 항목 | 판정 | 근거·결정 |
|------|------|-----------|
| A 어댑터 소유 | VERIFIED CORRECT(정리) | 엔진 모델은 세션마다 하나: rhwp는 WebView WASM(`RhwpEditorSession`), WordCraft는 백엔드 `DocxModel`(`DocxEditorSession`이 편집 표면). 레지스트리는 엔진 함수를 직접 부르지 않고 세션에 명령 ID만 준다. 자리표시자 `EngineAdapter`는 지움. |
| B 실행 취소(WordCraft) | VERIFIED CORRECT | 기록은 고정 WordCraft `Session`(`history`·`redo`, 타자 묶기)이 가진다. `edit.undo`·`edit.redo`는 `.pure()`(mutates=false)로 선언돼 있어 `DocxModel::run`의 변경 판정이 "안 바뀜"을 낸다 → `undo_redo_step`이 실행 전후 문서를 비교해 revision을 정한다. 되돌린 뒤 표지(`Mark`)·마지막 넣기 기억을 버려 늦은 `InsertAt`·`ReplaceInserted`가 되돌린 자리에 쓰지 않는다. 문서 보호를 푸는 단계(`step_lifts_protection`)는 쓸 수 없다고 보인다. 앱은 기록을 따로 두지 않는다(두 번째 기록 없음). |
| B 실행 취소(rhwp) | NON-BLOCKING LIMITATION | 고정 rhwp(`1a76570`)에는 엔진이 가진 실행 취소 기록이 없다. `saveSnapshot`·`restoreSnapshot`·`discardSnapshot`(최대 100) 기본 함수만 있고 기록은 rhwp studio 화면 코드가 만든다. 앱에서 기록을 만들면 엔진 밖 두 번째 기록이 되고, 조합·대기 확정(T007)·revision과 맞추는 계약이 없다 → `edit.undo`·`edit.redo`는 rhwp에서 `unsupported`. SC-003의 rhwp 실행 취소는 남은 일이다. |
| 서식(WordCraft) | VERIFIED CORRECT | `format.bold`·`italic`·`underline`·`strikethrough`(엔진 명령): 선택이 있으면 그 범위를 켜고 끄며 문서를 바꾸고, 커서만 있으면 다음 입력의 서식만 바꾼다(문서·revision 그대로). 눌림은 `wordcraft_engine::cmd::format::state`(선택 전체가 그 서식일 때 참). 굵게·실행 취소 뒤 저장이 T009 보존 검사를 통과하고 다시 열면 같다(Rust 시험). |
| 서식(rhwp) | NON-BLOCKING LIMITATION | rhwp 글자 서식은 HWP DocInfo 글자 모양·HWPX `header.xml`을 바꾼다. T009 보존 검사는 편집과 무관한 레코드·부분이 바뀌면 저장을 막도록 정했으므로(엄격 비교) 서식을 바꾼 문서는 저장할 수 없을 것으로 본다. 실제 rhwp로 확인하지 않았으므로 지원한다고 하지 않는다(`unsupported`). |
| C 가용성 | VERIFIED CORRECT | 엔진 지원 표 + 세션 상태(불러옴·편집 가능·조합·대기·저장 중·엔진 기록·엔진 서식). 아래 표. |
| D 비동기 | VERIFIED CORRECT | 명령은 그 세션 객체의 대기열에 들어가 같은 요청 순서·기준 revision·불러오기 시도 번호로 백엔드에 간다(T008). 백엔드가 시도·revision을 다시 확인하고, 다시 불러오면 새 `Session`(기록 새로 시작). 탭을 바꾸면 명령 대상이 바뀐다(대상은 그릴 때마다 활성 세션에서 고름). |
| E 작업 경계 | CONTRACT GAP(기록) | T010 선행 T005·T009는 동작하지만 tasks.md 체크는 T007·T008·T009가 플랫폼 범위 때문에 미체크다. 리본 배치·상황별 탭(T011), 장평·자간·참조 등(T012·T013)은 손대지 않았다. 리본의 나머지 명령은 `planned`(실행하지 않음, `notImplemented`). |

## 가용성 규칙

`documentCommandState(id, snapshot)` 순서:

1. 활성 문서 없음 → `noDocument`.
2. 그 엔진이 지원하지 않음 → `engineUnsupported`(세션에 보내지 않음).
3. `file.save`: 불러왔고 닫는 중이 아님(아니면 `notReady`), 저장 중이 아님(`saving`) → 세션의 `save()`. 조합·대기 편집·보존 판정은
   그 저장 절차(T009)가 검사하고 결과를 저장 결과 자리에 보인다(검사를 약하게 하지 않음).
4. 편집 명령: 편집 가능(`notReady` — 불러오는 중·닫는 중·그림 예산 초과·그림 실패), 조합 중이 아님(`composing`).
5. 실행 취소: 엔진 기록에 단계가 있거나 앞선 편집이 아직 대기 중(그 뒤에 넣음, 엔진이 순서대로 실행) → 아니면 `nothingToUndo`.
   다시 실행: 엔진 기록에 단계가 있음 → 아니면 `nothingToRedo`. 엔진이 기록을 알려 주지 않으면(`history: null`) `engineUnsupported`.
6. 서식: 엔진이 서식 상태를 알려 주면 쓸 수 있고 눌림 = 그 상태. 아니면 `engineUnsupported`.

세션의 `execute`는 실행 직전에 같은 함수로 다시 확인하고 맞지 않으면 아무것도 바꾸지 않는다(`accepted: false`). 엔진도 다시
확인한다: 낡은 보기로 보낸 실행 취소라도 기록이 없으면 문서·revision이 그대로다.

이유는 `command.unavailable.<reason>`(상태 표시줄 알림, 명령 이름 포함)과 `command.reason.<reason>`(단추 설명)으로 번역한다.
오류 코드가 아니라 가용성이므로 문서 내용·경로는 들어가지 않는다.

## 엔진별 명령

| 명령 | 단축키 | WordCraft(DOCX) | rhwp(HWP·HWPX) |
|------|--------|-----------------|----------------|
| `edit.undo` | Ctrl+Z | 지원(엔진 기록) | 미지원(엔진 기록 없음) |
| `edit.redo` | Ctrl+Y, Ctrl+Shift+Z | 지원(엔진 기록) | 미지원 |
| `format.bold` | Ctrl+B | 지원 | 미지원(보존 검사, 미확인) |
| `format.italic` | Ctrl+I | 지원 | 미지원 |
| `format.underline` | Ctrl+U | 지원 | 미지원 |
| `format.strikethrough` | — | 지원 | 미지원 |
| `file.save` | Ctrl+S | 지원(T009 절차) | 지원(T009 절차) |
| `view.ribbon` | Ctrl+F1(전역) | 화면 명령 | 화면 명령 |
| 그 밖의 리본 명령 | — | `planned`(T011–T013) | `planned` |

macOS는 Ctrl 대신 Cmd(이 빌드는 Linux만 확인). 단축키는 물리 키(`KeyboardEvent.code`)로 맞춰 한글 입력 상태에서도 같다.

## 단축키와 IME

- 조합 중 키(`isComposing`, keyCode 229)는 보지 않는다. 편집 표면은 Ctrl·Alt·Meta 조합을 레지스트리에 맡긴다(`textInput.ts`).
- 문서 범위 단축키는 편집 표면의 숨긴 입력(`.rhwp-input`)이나 입력 칸 밖에서만 받는다. 경로 입력 칸의 Ctrl+Z·Ctrl+B는 그 칸 몫이다.
- 레지스트리에 있는 단축키는 쓸 수 없어도 브라우저 기본 동작(숨긴 textarea의 되돌리기, 저장 대화상자)을 막고 이유만 알린다.
  Ctrl+C·Ctrl+V·Ctrl+X·Ctrl+A는 레지스트리에 없어 건드리지 않는다(붙여넣기는 T008 경로).
- 조합 중에 리본 단추를 눌러도 `composing`으로 거절한다. 앱이 먼저 확정하고 입력기의 끝을 기다리는 조합(provisional)은 다른 편집과
  같이 확정된 것으로 보고 그 뒤에 명령을 넣는다(T008 계약). 저장은 T009 절차가 provisional을 `SaveNotReady{composing}`으로 막는다.

## 확인 방법과 한계

- 실제 엔진: Rust 시험(`src-tauri/src/adapters/wordcraft/tests.rs`의 T010 시험, `services/save/tests.rs`
  `t010_굵게와_실행_취소로_바꾼_docx는_…`)이 고정 WordCraft로 실행 취소·다시 실행·서식·저장 보존을 확인한다. 실제 앱에서는
  `tests/integration/wordcraft/wordcraft_poc.py --commands-only`가 실제 키 입력(WebDriver)으로 Ctrl+B·Ctrl+Z·Ctrl+Y·Ctrl+S를 보내고
  리본 단추 상태·revision·저장한 파일을 본다.
- 흉내: Vitest의 `FakeDocx`(`src/components/Editor/wordcraft/testing.ts`)는 기록·서식을 흉내 낼 뿐이다. 그 시험은 명령이 어느 세션의
  어떤 경로로 가는지, 거절할 때 아무것도 바꾸지 않는지를 확인하며 엔진 동작의 증거가 아니다.
- rhwp 실행 취소·서식은 하지 않는다(위). 실제 IME(ibus-hangul) 상태에서 단축키를 누르는 실제 입력 시험은 하지 않았다(조합 중 키를
  보지 않는 규칙은 Vitest로만 확인).
- 이미 있던 단위 연산(`backspace` 등)은 내부 태그 enum의 단위 변형이라 남는 필드를 거부하지 않는다(새 `undo`·`redo`는 빈 구조체 변형으로
  거부). 동작에는 영향이 없어 이번에 바꾸지 않았다.
