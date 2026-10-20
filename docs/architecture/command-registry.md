# 명령 레지스트리·가용성·실행 취소 (T010)

FR-007(명령 레지스트리)과 SC-003(서식·실행 취소·미지원 명령을 실제 엔진에서 확인)의 T010 몫. 상황별 리본은 T011, 형식별 고급
명령은 T012·T013이 맡는다. 이 문서는 T010에서 정한 경계와 근거, 남은 한계를 적는다.

## 구조

| 파일 | 역할 |
|------|------|
| `src/commands/registry.ts` | 명령 정의 하나뿐인 표: 변하지 않는 ID, 번역 라벨 키, 단축키, 범위(전역·문서), 엔진별 지원(`supported`·`unsupported`). 리본에 있지만 연결하지 않은 명령은 `planned`. 단축키 정규화·충돌 검사, ID 중복·종류 중복·라벨 불일치 검사(`buildRegistry`·`COMMAND_PROBLEMS`, 안정화). |
| `src/commands/target.ts` | 명령 대상 계약 `DocumentCommandTarget`(`snapshot()`, `execute(id)`)과 상태 `DocumentCommandSnapshot`. |
| `src/commands/capability.ts` | 가용성 결정 `documentCommandState(id, snapshot)`(순수 함수). 화면과 세션이 같은 함수를 쓴다. |
| `src/commands/commands.ts` | 실행 경계: 화면 배치 명령은 여기서, 문서 명령은 활성 편집 세션으로. 쓸 수 없으면 아무것도 바꾸지 않고 이유를 알린다. |
| `src/commands/shortcuts.ts` | 창 keydown → 레지스트리 명령(IME·입력 칸 보호). |
| `RhwpEditorSession`·`DocxEditorSession` | 명령 대상 구현. 명령은 각 세션의 기존 편집 경로(T007·T008)와 저장 절차(T009)로만 실행된다. |
| `src-tauri/src/adapters/wordcraft/engine.rs` | 허용 연산에 `undo`·`redo`·`format{format}`, 보기에 `history{undo,redo}`·`format{bold,italic,underline,strikethrough}`·`formatAccess`(안정화). |

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
0. (안정화) 확인 창(모달)이 열려 있으면 모든 명령(문서·배치) → `dialogOpen`.
4. 편집 명령: 편집 가능(`notReady` — 불러오는 중·닫는 중·그림 예산 초과·그림 실패), IME 트랜잭션이 끝남(`composing` — 조합 중이거나,
   안정화부터는 앱이 먼저 확정한 조합이 입력기의 최종 글자를 기다리는 동안도 포함).
5. 실행 취소: 엔진 기록에 단계가 있음 → 아니면 `nothingToUndo`. 다시 실행: 다시 실행 단계가 있음 → 아니면 `nothingToRedo`. 대기 중인
   연산이 있으면 엔진 기록 대신 그 연산을 적용한 예상(`queuedHistory`, 안정화 — 처음 T010은 "대기 중이면 실행 취소 가능"이었음)으로
   정한다. 마무리 안정화부터 예상은 방향마다 `available`·`none`·`unknown`이고, 남은 단계를 응답 전에 모르면(`unknown`) `pendingEdits`로
   응답까지 기다린다. 엔진이 기록을 알려 주지 않으면(`history: null`) `engineUnsupported`.
6. 서식: 엔진이 서식 상태를 알려 주면 쓸 수 있고 눌림 = 그 상태. 아니면 `engineUnsupported`. 문서 보호가 언제나 거부하면
   (`formatAccess: "protected"`, 안정화) `protected`.

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
- 조합 중에 리본 단추를 눌러도 `composing`으로 거절한다. 처음 T010은 앱이 먼저 확정하고 입력기의 끝을 기다리는 조합(provisional)을
  확정된 것으로 보고 그 뒤에 명령을 넣었으나, 그 명령이 provisional을 지워 입력기의 최종 글자로 고치지 못하는 결함이 있어 안정화에서
  바꿨다(아래 "T010 안정화" P1-A). 저장은 T009 절차가 provisional을 `SaveNotReady{composing}`으로 막는다.

## 확인 방법과 한계

- 실제 엔진: Rust 시험(`src-tauri/src/adapters/wordcraft/tests.rs`의 T010 시험, `services/save/tests.rs`
  `t010_굵게와_실행_취소로_바꾼_docx는_…`)이 고정 WordCraft로 실행 취소·다시 실행·서식·저장 보존을 확인한다. 실제 앱에서는
  `tests/integration/wordcraft/wordcraft_poc.py --commands-only`가 실제 키 입력(WebDriver)으로 Ctrl+B·Ctrl+Z·Ctrl+Y·Ctrl+S를 보내고
  리본 단추 상태·revision·저장한 파일을 본다.
- 흉내: Vitest의 `FakeDocx`(`src/components/Editor/wordcraft/testing.ts`)는 기록·서식을 흉내 낼 뿐이다. 그 시험은 명령이 어느 세션의
  어떤 경로로 가는지, 거절할 때 아무것도 바꾸지 않는지를 확인하며 엔진 동작의 증거가 아니다.
- rhwp 실행 취소·서식은 하지 않는다(위). 처음 T010에서는 실제 IME(ibus-hangul) 상태에서 단축키를 누르는 실제 입력 시험을 하지
  않았다(안정화에서 `--ime-commands`로 더함, 아래).
- 이미 있던 단위 연산(`backspace` 등)은 내부 태그 enum의 단위 변형이라 남는 필드를 거부하지 않는다(새 `undo`·`redo`는 빈 구조체 변형으로
  거부). 동작에는 영향이 없어 이번에 바꾸지 않았다.

## T010 안정화 (2026-10-20, `3cbac44` 위)

리뷰에서 나온 다섯 가설을 재현 → 수정 → 확인했다. 흉내(FakeDocx·jsdom) 재현과 실제 엔진·실제 앱 확인을 나눠 적는다.

| 항목 | 판정 | 재현 근거(수정 전) | 수정 |
|------|------|-------------------|------|
| P1-A 앱이 먼저 확정한 조합과 명령 | CONFIRMED DEFECT — FIXED(흉내 순서) | Vitest: 조합 '하' → 초점 잃음(앱이 provisional로 확정) → 리본 굵게 → 입력기 꼬리 최종 '한'. 수정 전에는 굵게가 실행되고 `push`가 provisional을 지워 `ReplaceInserted`가 가지 않음: 문서 '하'(최종 글자 잃음). 실행 취소도 같은 때 실행됨. | 스냅숏 `composing` = 조합 중 또는 provisional(WordCraft·rhwp). 그동안 실행 취소·다시 실행·서식은 `composing`으로 거절(아무것도 바꾸지 않음). 입력기 꼬리가 오거나 새 입력이 시작되면(keydown 등, imeInput 규칙) 풀린다. 지연·강제 확정은 쓰지 않는다. |
| P1-B 확인 창 뒤의 단축키 | CONFIRMED DEFECT — FIXED | Vitest(App, 열린 DOCX, 버리기 확인 창의 취소 단추에 초점): Ctrl+Z는 `undo`, Ctrl+B는 `format`, Ctrl+S는 사전 검사와 **저장까지**, Ctrl+F1은 리본 접기가 실행됨. 단추는 `isDocumentShortcutTarget`이 문서 대상으로 봄. | Editor가 확인 창 표시를 layout effect로 알리고(`onModalChange`), 명령 문맥 `modal`이면 모든 명령이 `dialogOpen`. 단축키는 기본 동작만 막고 실행·알림 없음(창 안 입력 칸이 생기면 그 칸의 Ctrl+Z는 칸이 처리). Ctrl+F1도 막는다: 모달 뒤 화면은 다룰 수 없는 상태이고 배치가 바뀌면 창이 닫힌 뒤 돌려줄 초점 자리가 사라질 수 있다. 포인터는 화면 전체를 덮는 배경이 막고, 닿더라도 `executeCommand`가 거절한다. |
| P2-A 대기 작업과 실행 취소 가용성 | CONFIRMED DEFECT — FIXED | Vitest: 기록이 빈 문서에서 이동·선택·표지만 보내는 중이면 실행 취소가 쓸 수 있음으로 보임(`history.undo || pending`). | `queuedHistory`: 보내는 중(`sending`)·보낼 연산을 엔진 기록에 차례로 적용한 예상. 바꾸는 연산(넣기·지우기·서식 등)은 실행 취소 단계 +·다시 실행 기록 버림(WordCraft는 성공한 바꾸는 명령마다 기록 지점을 남김), 실행 취소는 다시 실행 단계, 다시 실행은 실행 취소 단계를 만든다. 이동·클릭·선택·표지는 바꾸지 않는다. 앱의 기록이 아니라 엔진 기록의 예상이며, 엔진이 거부한 넣기처럼 엔진만 아는 결과는 응답 뒤 보기로 맞춰진다. |
| P2-B 보호된 DOCX의 서식 | CONTRACT DEFICIENCY — FIXED | 고정 WordCraft `Session::run`은 보호(`protect::check_before`, 비공개)가 막으면 서식을 거부하는데, T010 화면은 서식을 쓸 수 있다고 보였고 엔진 거부는 `rejectedOps`만 늘어 알림이 없었다. | 백엔드가 공개 `cmd::protect::state`에서 `formatAccess`(`allowed`·`protected`·`regions`)를 정해 보기에 담는다(IPC 보기 필드 하나, 새 명령 없음). `protected`면 화면이 `protected`로 막고, `regions`(편집 가능 영역만)는 선택이 영역 안인지 엔진만 판정하므로 보내고, 엔진이 명령 연산을 거부하면 `inputNotice: "commandRejected"`로 알린다(문서·revision·dirty·기록 그대로, 내용·경로 없음). 대응은 Rust 시험이 모드마다 실제 엔진 결과와 맞춘다. |
| P3 명령 ID 중복 | CONTRACT DEFICIENCY — FIXED | 리본 원본의 중복은 기존 시험(`ribbon/definitions.test.ts`)이 이미 막았지만, `buildRegistry`는 같은 ID를 조용히 덮어썼고 배치·문서 명령 표 사이의 중복이나 리본과 다른 라벨은 검사하지 않았다. | `buildRegistry(tabs, layout, document)`가 처음 선언을 남기고 중복·종류 중복·라벨 불일치를 `problems`로 낸다. `COMMAND_PROBLEMS`가 비어 있어야 한다(시험, 일부러 넣은 중복으로도 확인). |

보호 상태와 서식 가용성(고정 WordCraft, Rust 시험 `t010_보호_상태의_서식_가용성은_엔진_판정과_같다`, 파일로 내보내 다시 연 문서):

| 보호 | `formatAccess` | 영역 안 선택 | 영역 밖 선택 | 커서만(다음 입력 서식) |
|------|----------------|--------------|--------------|------------------------|
| 없음 | allowed | 실행 | 실행 | 실행 |
| 읽기 전용·메모만·양식(영역 없음) | protected | 거부 | 거부 | 거부 |
| 읽기 전용·메모만 + 편집 가능 영역 | regions | 실행 | 거부 | 실행(영역 밖이 그대로) |
| 변경 내용 추적 | allowed | 실행 | 실행 | 실행 |
| 서식을 스타일로 제한(모드와 함께) | protected | 거부 | 거부 | 거부 |

엔진 사실(Rust 시험으로 고정): 커서만 둔 서식은 문서를 바꾸지 않지만 엔진 기록 지점을 남기고, 그 실행 취소는 문서·revision을 그대로
두고 다음 입력 서식만 되돌린다. 문서 처음의 Backspace처럼 문서를 바꾸지 않은 바꾸는 명령 뒤의 실행 취소도 revision으로 세지 않는다.

### 실제 ibus-hangul 관찰(이 환경, X11 + ibus-hangul 1.5.5, WebKitGTK 2.54)

- 조합 중 리본 단추를 누르면 GTK가 mousedown 전에 조합을 끝까지 확정했다(빈 끝 → `insertFromComposition` → 끝 → mousedown·blur,
  기록한 8회 모두). 그래서 이 환경에서는 provisional이 생기지 않고, 굵게는 확정한 글자 뒤 커서에 실행된다. 조합 중 Ctrl+Z·Ctrl+B도
  입력기가 먼저 확정한 뒤 Ctrl·Z keydown이 온다(조합 중 키 아님) → 확정한 음절을 엔진이 되돌린다(revision +2).
- `wordcraft_poc.py --ime-commands`(리본 굵게, 빠른 실행 실행 취소, Ctrl+Z, 페이지 클릭 직후 리본 굵게): 네 번 중 세 번 4/4 통과, 한 번은
  WebDriver 연결 끊김(시험 환경). 이 시나리오를 처음 맞추던 실행 하나에서 **리본 굵게 뒤 조합 음절이 사라진 결과(revision 0)가 한 번
  나왔고**, 그 뒤 이벤트를 기록한 8회와 시나리오 세 번에서는 다시 나오지 않았다. 그 실행에는 이벤트 기록이 없어 원인을 확정하지
  못했다. 가설: 입력기가 확정을 두 반쪽으로 보내는 사이에 초점이 단추로 옮겨 뒤 반쪽이 편집 입력에 닿지 않음 — 그렇다면 명령 계층이
  아니라 T008 IME 표면의 한계이고 T010이 바꾼 경로가 아니다(UNVERIFIED, 남은 위험).
- provisional이 실제로 생기는 순서(blur 뒤 꼬리)는 이 환경의 리본 클릭에서는 관찰하지 못했다. P1-A 수정은 T008에서 실측한 페이지
  클릭·초점 잃음 순서를 흉내 낸 Vitest로 확인했다.

### Xvfb 실패 비교(기준 `17c890e` 별도 worktree, 같은 Xvfb 1600×1200×24·DPR 1.04)

- rhwp hit test(HWP 본문 30%/70% 클릭 24회 중 15회 1–2글자 어긋남): 기준과 지금의 (기대, 결과) 15쌍이 같다 → **PRE-EXISTING,
  ENVIRONMENT-DEPENDENT**(소수 DPR 포인터, headless weston에서는 통과).
- 스모크 시작 크기 가로 넘침(`scrollW` 1230 > `w` 1229): 기준과 지금이 같다 → **PRE-EXISTING, ENVIRONMENT-DEPENDENT**(weston 62/62).

## T010 마무리 안정화 (2026-10-20, `86f5e84` 위)

### B. 대기 중인 실행 취소·다시 실행 예상 — CONFIRMED DEFECT — FIXED

- 재현(수정 전, Vitest·FakeDocx): 실행 취소 단계가 하나인 문서에서 응답을 붙잡고 실행 취소 3번·다시 실행 3번을 누르면 6번 모두
  받아 대기열에 넣었다(넘치는 연산 5개). `queuedHistory`가 참·거짓만 들고 실행 취소·다시 실행이 단계를 쓰지 않았기 때문이다.
- 엔진 근거(고정 WordCraft `Session`): 바꾸는 명령은 성공하면 문서가 그대로여도 기록 지점을 남기고 다시 실행 기록을 버린다(Rust 시험으로
  고정: 문서 처음의 Backspace, 커서만 둔 서식). 이어 친 글자는 한 단계로 묶인다. 실패한 명령은 기록을 되돌린다. `undo_depth()`는
  공개지만 다시 실행 단계 수는 공개되지 않고, 타자 묶기 때문에 대기 연산이 만들 단계 수를 앱이 정할 수 없다.
- 결정(접근 B, IPC 바꾸지 않음): `DocxEditorSession.queuedHistory`가 방향마다 "알고 있는 최소 단계 수"와 "더 있을 수 있는지"만 센다.
  엔진 보기에 단계가 있으면 최소 1(더 있을 수 있음). 바꾸는 연산은 실행 취소 최소 1·다시 실행 없음. 실행 취소는 아는 단계를 하나
  쓰고 다시 실행을 하나 더한다(다시 실행은 반대). 이동·클릭·선택·표지는 바꾸지 않는다. 결과 `available`이면 받고, `unknown`이면
  `pendingEdits`로 응답까지 기다리고, `none`이면 `nothingToUndo`/`nothingToRedo`. 그래서 대기 중인 편집 뒤의 실행 취소, 대기 중인
  실행 취소 뒤의 다시 실행은 그대로 받고, 남은 단계를 모르는 두 번째 실행 취소는 받지 않는다. 엔진만 아는 결과(거부할 넣기 뒤의
  실행 취소)는 받아도 엔진이 아무것도 바꾸지 않는다.
- 흉내(FakeDocx)도 엔진 기록 규칙을 따르게 했다(성공한 바꾸는 연산마다 기록 지점, 타자 묶기, 다음 입력 서식 포함). 그 결과 기존
  시험 하나(이어 친 두 글자 뒤 실행 취소)의 기대가 엔진처럼 "둘 다 되돌림"으로 바뀌었다.
- 시험: `src/commands/history.test.tsx` 17가지(중간의 가용성·받음과 응답 뒤 모델·기록·revision), Rust `t010_…` 시험.

### A. 리본 굵게 뒤 조합 음절 사라짐 — 원인 미확정(UNVERIFIED), 관련 경계 둘은 고침

- 추적: 검사 훅 빌드에서만 켜지는 `imeTrace.ts`(`window.__geulTrace`, 최근 4000개)가 DOM 이벤트(종류·inputType·isComposing·229·글자
  수), ImeInput 상태(조합·끊긴 트랜잭션·완료 기록), 편집 연산(종류·보냄·응답·revision·거부 수), 명령 판정을 글자 없이 남긴다.
  `wordcraft_poc.py --ime-commands`가 창 쪽 누름·초점·키를 같은 순번으로 더하고, 사례마다 보고서에 쓴다(뒤에서 WebDriver가 끊겨도
  앞 사례가 남음). `--rounds`·`--cpu-load`(진단용 CPU 경합)를 더했다.
- 실제 ibus-hangul 1.5.5(IBus 1.5.33, WebKitGTK 2.54.1, X11 Xvfb) 결과:
  - 수정 전 빌드: 사례 8개 1회 모두 통과. CPU 경합(바쁜 프로세스 4개)에서 사례 5개 통과 뒤 WebDriver 끊김(시험 환경, 앞 사례 추적은 남음).
    리본 굵게만 되풀이한 탐침 40회(경합 4개) 모두 조합 중이었고 음절은 한 번씩 들어감.
  - 수정 뒤 빌드: 사례 8개 × 2회 16/16, 탐침 40회(경합 4개) 40/40, 사라짐 없음.
  - 처음 관찰된 사라짐(이전 안정화의 실행 하나, 추적 없음)은 다시 나오지 않았다. 원인은 확정하지 못했다.
- 추적으로 재구성한 정상 순서(리본 굵게): `compositionend("")`(앱은 조합 취소로 끝냄) → 약 60 ms → `keydown 229` →
  `insertFromComposition` → `compositionend("하")`(넣기) → mousedown·blur·단추 focusin → click → 명령. 빈 끝과 최종 글자 사이에는 음절이
  입력기에만 있다. 사라진 결과(revision 0, 굵게 눌림, 조합·provisional 없음)와 맞는 가설은 둘이다: H1 그 사이에 초점이 단추로 옮겨 뒤
  반쪽이 단추로 감, H2 입력기가 확정 대신 버림. 추적은 둘을 가른다(H1이면 누름 뒤 `win:keydown`이 `command:*` 대상, ime 참으로 남음).
- 고친 것:
  - 경계 A(CONFIRMED DEFECT — FIXED, 재생 시험): Ctrl·Meta·Alt 키가 앱이 먼저 확정한 조합을 입력기 꼬리 전에 닫아, 늦은 최종 글자가 한 번
    더 들어갔다(재생: Ctrl+B → "하한", Ctrl+Z → "하하"). 수식 키 단축키는 이제 입력 경계가 아니다(textInput). 그동안 명령은 composing.
  - 경계 C(완화, H1 노출 제거): 편집 입력에 초점이 있으면 `CommandButton`이 mousedown 기본 동작을 막아 초점을 지킨다. 실제 추적에서
    리본·빠른 실행 누름의 `blur`가 1 → 0. 명령은 그대로 실행된다.
  - 경계 B: provisional 동안 명령 거절(이전 안정화)은 경계 A 수정으로 단축키에서도 우회되지 않는다.
  - 경계 D: 추적의 `docx:push`·`send`·`response`(거부 수·revision)로 음절이 어디서 사라졌는지 가를 수 있다(받지 못함/버림/거부/무효).
- 남은 위험: H2(입력기가 버림)는 앱이 막을 수 없다(마지막 미리보기 글자를 넣는 것은 지어낸 입력이라 하지 않음). 문서 탭·탭 닫기 단추는
  명령 단추가 아니어서 여전히 초점을 가져간다(실제 시험에서는 한 번씩 남음). 실제 입력에서 provisional 뒤 Ctrl 키가 꼬리보다 먼저
  오는 순서는 만들지 못해 재생 시험으로만 확인했다.
