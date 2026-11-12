> **2026-11-10 HWP 핵심 삽입:** `insert.table`·`insert.image`·`paragraph.bullets`가 HWP에서도 T009 제한 부분집합 안에서 활성화된다(상세 재열기 API·complete baseline·section 0·현재 원본 사전검사 SAFE 조건; 이유 `originalChecking`/`originalUnverified` 추가). Phase 4 비GUI 저장·재열기 수용과 측정된 지원 범위는 [Phase 4](core-insertions.md#hwp-비gui-저장재열기-통합-수용--phase-4-2026-11-10).. 경계와 검증은 [핵심 문서 삽입 — HWP Phase 3](core-insertions.md#hwp-제품-명령-연결--phase-3-2026-11-10)을 따른다.
> **2026-11-10 클립보드:** DOCX/HWP/HWPX의 plain-text Copy/Cut/Paste를 연결했다. 현재 계약과 제한은 [Plain-text clipboard](#plain-text-clipboard-2026-11-10)를 따른다. 기존 T010 전체 수용 판정은 바꾸지 않는다.

# 명령 레지스트리·가용성·실행 취소 (T010)

> **2026-11-12 T010 acceptance policy:** [필수 기능·안전·자원·native usability와 독립 성능 목표](../planning/spec.md#t010-acceptance-policy-20261112)를 구분한다. 이 문서 정책 변경으로 capability/source는 바뀌지 않았다: 일반 RHWP history는 일반 빌드에서 비활성이고, 제품의 `historyScope: advanced`는 기존 조건부 T012 범위만 뜻한다. 테스트 플래그 경계도 유지된다. 성능 목표 미달은 자동 기능 FAIL이나 명령 활성화 승인이 아니다. 현재 D2 E→U→F 및 D4 자원/실사용성 증거는 미완료이며 일반 RHWP Undo/Redo NO-GO다.


## 2026-11-06 T012 조건부 제품 capability

2026-11-08 후속: 기존 수식 필드의 결과 서식은 `%g`와 한컴 고정소수 `%.Nf`(N 0–9, 캐시 값 소수 자릿수 정확)만 인정한다(genuine `calc-cell.hwp`). 천 단위 구분 기호 캐시·중첩 표·그 밖의 서식은 계속 거부. [기록](stage567-acceptance-2026-11-05.md#preview-tables-toc-20261108).

2026-11-08 갱신: `hangul.insertTableFormula`는 완전하고 검증된 top-level 표 격자에서, 값/기존 수식의 셀 소유권이 첫 문단으로 확인되는 경우 지원한다. 새 수식 삽입도 이 구조 검증을 거친다. 기존 수식은 지원되는 단일 필드여야 하며 꼬리 일반 문단은 보존한다. 병합 span으로 좌표를 매핑하고 덮임 좌표는 셀 별칭이 아니라 값 없는 좌표로 취급한다. 중첩·불완전/모순 메타데이터·모호한 필드/다중 수식 소유권은 snapshot 전에 거부한다. 256/16/4096 제한은 그대로다. 상세 [검증 기록](stage567-acceptance-2026-11-05.md#interoperability-repair-20261108).


[명시적 승인](../planning/spec.md#conditional-advanced-20261106)에 따라 D2/D4 완료를 절대 선행 조건으로 삼던 과거 제품 고급 기능 작업 불허를 이 부분집합에서 대체한다. 기술 판정은 D2 INCONCLUSIVE, D4 FAIL/자원 INCONCLUSIVE이며 T010 전체 미완료다. 아래 지원 부분집합은 일반 Release 빌드(모든 시험 훅 0)의 실제 리본/입력창/세션/엔진/저장 서비스 경로로 검증해 제품 명령을 켰다([수용 기록](stage567-acceptance-2026-11-05.md#2026-11-06-advanced-d--conditional-production-implementation)). 이는 조건부 지원이며 전체 T010/T012 수용이 아니다.

| 명령 | 제품 capability와 제한 |
|---|---|
| `hangul.charWidth`, `hangul.charSpacing` | HWP/HWPX, 본문 또는 같은 표 셀 안의 단일 문단 선택, 실제 getter/setter·compaction·publication ownership API, 고급 전용 history, 정수 50–200 / -50–50, 7언어 값 유지 |
| `hangul.insertTableFormula` | 유효한 단일 표 셀 커서에서 typed 식 입력/기존 식 교체/명시적 재계산. 소유 셀의 지원되는 기존 식만 입력창에 채우며 같은 식을 확인하면 캐시 값을 재계산. parser/engine 독립 검증(256/16/4096), 필드 소유권/구조 제한 유지. 결과를 넣을 셀을 직접·범위로 읽는 식(`=SUM(A1:B1)`을 B1에)은 재계산마다 값이 커지므로 입력창과 세션이 거부한다. 간접 순환도 `getCursorModel`·전체 `getControls`·필드 범위·읽기 전용 소유권 검증을 교차 확인한 표 의존성 그래프로 거부한다. 표는 비병합 직사각형·셀당 단일 문단이고, 기존 필드는 문단 전체의 지원 `%g` 수식 하나 또는 컨트롤 없는 일반 값이어야 한다. 불명확한 구조/메타데이터·4096을 넘는 노드+간선은 변경 전에 안전 거부한다. `??%g,;;` 형식이 아닌 기존 식(예: 한컴 `%.2f`)은 입력창에 채우지 않는다. 비어 있지 않은 셀의 글은 수식으로 바뀐다 |
| `edit.undo`, `edit.redo` (RHWP) | 제품 선언은 `historyScope: advanced` 요구. 실제 고급 기록만 사용하며 일반 입력 시작 시 폐기. IME/최종 입력/commit 대기 거부. 일반 RHWP 입력 history 활성화가 아님 |
| RHWP 일반 글자 서식 | 기존 시험 구성 전용, 제품 미지원 |

원본 128 KiB 이하·현재 8쪽 이하, 최대 4고급 단계만 허용한다. 문서 한도는 `limit`, 선택 없음/여러 문단은 `selectionRequired`, 표 밖은 `notInTable`, commit 대기는 `pendingEdits`, IME는 `composing`으로 거부한다. 시험 훅 활성화는 제품 기능의 전제가 아니다. 실질 getter/setter/ownership나 history가 없으면 capability를 내지 않는다. 저장은 변함없이 T009의 사전검사·실제 출력 검사·원자 게시·내구성 결과를 따른다. 한컴 원본처럼 비어 있지 않은 PrvText/PrvImage가 있는 HWP를 이 명령으로 고치면 안전한 미리보기 재생성 근거가 없어 T009가 저장을 거부한다. 명령은 메모리 모델만 바꾸고 원본은 그대로이며 dirty가 유지된다. 아래 이전 비활성/NO-GO 기록은 당시 결과다.


이전 2026-11-06 신뢰성 조사 기록: `formulaReadsOwnCell`은 문법 검사와 같은 토큰화를 써서 Safari 13 미지원 lookbehind를 제거했다(실제 Safari 13 실행 NOT RUN). `LOG10(...)`처럼 셀 모양인 함수는 뒤의 호출 괄호로 구분한다. 함수 목록·인수 개수·길이/깊이/비용/표 경계 및 읽기 전용 계산 계약은 유지한다. `A1=B1+1`, `B1=A1+1`은 실제 Release WASM에서 명시적 재계산마다 캐시 값이 바뀌므로 **간접 순환 안전성은 미완료**다. `existingFormula`의 null은 익숙하지 않은 필드와 부재를 구분하지 않아 의존성 없음으로 해석할 수 없다. App의 기존 sessionId/loadGeneration/revision 가드는 같은 세션 reload, 전환, 닫기 및 이후 reload에서 직접 검증했다(제품 변경 없음). [상세 수용 기록](stage567-acceptance-2026-11-05.md#reliability-small-20261106).


2026-11-06 간접 순환 교정: 이전 조사에서 미완료로 남긴 의존성 분석을 구현했다. `formulaDependencies`는 검증된 공통 토큰에서 직접/역방향 범위/상대/방향 참조를 해석한다(모든 IF 분기는 보수적으로 포함). `tableFormulaSafety`는 목적 셀의 기존 간선을 새 간선으로 교체하고, 목적지에서 도달 가능한 순환을 반복형 DFS로 검사한다. 필드 목록 부재만으로 일반 셀로 판단하지 않으며 전체 컨트롤 목록과 셀 리스트를 대조한다. 병합/중첩/다중 문단·익숙하지 않은 필드 인코딩·불일치/누락 메타데이터는 변경 전에 거부한다. 엔진/14패치/Release 세대 변경 없음. [수용 기록](stage567-acceptance-2026-11-05.md#cycle-pointer-repair-20261106).


FR-007(명령 레지스트리)과 SC-003(서식·실행 취소·미지원 명령을 실제 엔진에서 확인)의 T010 몫. 상황별 리본은 T011, 형식별 고급
명령은 T012·T013이 맡는다. 이 문서는 T010에서 정한 경계와 근거, 남은 한계를 적는다.

> **2026-11-05 Stage 5–7 재검증:** 명령 경계상 RHWP 실행 취소·장평/자간·영속 수식은 제품에서 계속 비활성이다. 수식은 기존 읽기 전용 계산과 분리한 typed command로 controlled 설정에서만 연결했으며, 13개 패치의 실제 Release WASM에서 검증했다. D2 25 PASS/2 INCONCLUSIVE(E→U→F 미관측), D4 원래 문턱 6 PASS/2 FAIL이라 제품 history·metrics·formula는 NO-GO다. T012/T013 완료 여부·현재 native 범위와 외부 Word/Hancom NOT RUN은 [통합 수용 보고서](stage567-acceptance-2026-11-05.md)를 참조한다. DOCX 추적 표식 교정 뒤 실제 native10개와 단계별 저장검사10개·재개방이 통과했다.

현재 T010은 INCOMPLETE — ON HOLD, 제품 RHWP Undo/Redo는 NO-GO다. T011은 2026-11-04 착수 조건 변경 뒤 구현·검증해 완료했다(아래 "T011 리본", 선택 문맥 상황 탭은 빠진 능력으로 숨김). [수용 행렬·재개 조건](rhwp-undo-redo.md#t010-current-status)이 현재 상태의 기준이며 아래 날짜별 검증은 당시 신원에 한정한다.

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
| B 실행 취소(rhwp) | IMPLEMENTED — NOT ENABLED (2026-10-22) | 고정 rhwp(`1a76570`)에는 엔진이 가진 실행 취소 기록이 없다(`saveSnapshot`·`restoreSnapshot`·`discardSnapshot`·`snapshotCapacity` 기본 함수만). T010 Phase 2: 기록 **내용**(스냅숏)은 엔진이 갖고, 세션(`RhwpEditorSession`)의 `RhwpHistory`(`src/components/Editor/rhwp/rhwpHistory.ts`)가 스냅숏 ID·상태 시간선·커서 체크포인트·타자 그룹만 조정한다(문서 모델은 하나, [rhwp-undo-redo.md](rhwp-undo-redo.md)). 세션은 `snapshot().history`로 단계를 알리고 `execute`가 같은 가용성 함수로 다시 확인한 뒤 `undo()`/`redo()`를 부른다. 그러나 레지스트리의 rhwp `edit.undo`·`edit.redo`는 제품 빌드에서 `unsupported`다(가용성은 `engineUnsupported`로 거절). 2026-10-22 2차 활성화 관문: 실제 앱의 네이티브 ibus-hangul에서 "선택을 조합으로 바꾸다 취소한 뒤 바로 Ctrl+Z"가 WebKitGTK의 빈 조합 끝 뒤 최종 글자 기다림(T010 IME 경계 계약) 때문에 `composing`으로 거절되고(FAIL), 큰 문서의 WebView 타자 지연이 기준을 넘어(FAIL) 활성화하지 않았다([rhwp-undo-redo.md](rhwp-undo-redo.md) "Phase 2 안정화"). 같은 날 후속 관문(응답성 개선·native 순서 행렬·캐시 패치 검토) 뒤에도 D2 INCONCLUSIVE·D4 FAIL로 `unsupported`를 유지한다([rhwp-undo-redo.md](rhwp-undo-redo.md) "T010 후속"). 2026-10-23 캐시 보강(upstream 캐시 패치 교정, 미통합) 뒤에도 같다([rhwp-undo-redo.md](rhwp-undo-redo.md) "T010 캐시 보강"). 시험 활성화 빌드: `VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1`일 때만 `registry.ts`의 `RHWP_HISTORY`가 `supported`(빌드 때 상수 — 일반·검사 훅만 켠 빌드의 산출물에는 그 분기와 표지 문자열 `geul-test-build`가 없음을 확인), 같은 단축키·명령 경로(`executeCommand` → 세션 `execute` 재확인)로 실제 앱 시험(`tests/integration/rhwp/undo_native.py`)이 쓴다. 2026-10-26: 세션 기록도 같은 선언을 따른다 — 제품 빌드(rhwp 실행 취소 `unsupported`)의 세션은 `RhwpHistory`를 만들지 않아 그룹 시작마다 스냅숏을 찍거나 붙들지 않는다(그 전에는 쓸 수 없는 실행 취소를 위해 찍었다 — CONFIRMED DEFECT, FIXED, [rhwp-undo-redo.md](rhwp-undo-redo.md) "T010 설계 검토"). |
| 서식(WordCraft) | VERIFIED CORRECT | `format.bold`·`italic`·`underline`·`strikethrough`(엔진 명령): 선택이 있으면 그 범위를 켜고 끄며 문서를 바꾸고, 커서만 있으면 다음 입력의 서식만 바꾼다(문서·revision 그대로). 눌림은 `wordcraft_engine::cmd::format::state`(선택 전체가 그 서식일 때 참). 굵게·실행 취소 뒤 저장이 T009 보존 검사를 통과하고 다시 열면 같다(Rust 시험). |
| 서식(rhwp) | NOT ENABLED — SC-003 GAP | 실제 rhwp 출력으로 확인(2026-10-21 Phase 0, 2026-10-26 재실행): HWP는 새 글자 모양이 DocInfo를 바꾸고 본문 변경이 낡은 미리보기(`previewStale`)가 되어 실제 `service::save`가 거부한다(규칙 그대로 — 미리보기 무관함을 증명할 수 없음). HWPX는 엔진이 새 `charPr` 하나를 덧붙이고 `itemCnt`만 올리며(실측), T010 Phase 3B 좁은 header 규칙([save-preservation.md](save-preservation.md) "글자 서식 덧붙임")으로 생성 픽스처의 기울임·셀 밑줄이 실제 `service::save`에서 게시되고 다시 열어 서식이 같다. 그래도 명령은 `unsupported`다: 세션 서식 명령(선택·셀·다문단 범위, 기록·revision·그리기), 다시 열기 근거의 서식 비교, 형식별(HWPX만) 지원 선언, 실제 앱 검증이 없다. |
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
   응답까지 기다린다. 엔진이 기록을 알려 주지 않으면(`history: null`) `engineUnsupported`, 기록을 쓸 수 있는 엔진이 이 문서에서
   한도로 껐으면(`historyLimited`, rhwp 큰 문서) `limit`.
6. 서식: 엔진이 서식 상태를 알려 주면 쓸 수 있고 눌림 = 그 상태. 아니면 `engineUnsupported`. 문서 보호가 언제나 거부하면
   (`formatAccess: "protected"`, 안정화) `protected`.

세션의 `execute`는 실행 직전에 같은 함수로 다시 확인하고 맞지 않으면 아무것도 바꾸지 않는다(`accepted: false`). 엔진도 다시
확인한다: 낡은 보기로 보낸 실행 취소라도 기록이 없으면 문서·revision이 그대로다.

이유는 `command.unavailable.<reason>`(상태 표시줄 알림, 명령 이름 포함)과 `command.reason.<reason>`(단추 설명)으로 번역한다.
오류 코드가 아니라 가용성이므로 문서 내용·경로는 들어가지 않는다.

## 엔진별 명령

| 명령 | 단축키 | WordCraft(DOCX) | rhwp(HWP·HWPX) |
|------|--------|-----------------|----------------|
| `edit.undo` | Ctrl+Z | 지원(엔진 기록) | 미지원(세션 기록 구현, 활성화 관문 미통과) |
| `edit.redo` | Ctrl+Y, Ctrl+Shift+Z | 지원(엔진 기록) | 미지원(세션 기록 구현, 활성화 관문 미통과) |
| `format.bold` | Ctrl+B | 지원 | 미지원(HWP: 보존 검사가 막음 · HWPX: 저장 규칙만 준비, 명령 미구현) |
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

## T010 IME 트랜잭션 경계 (2026-10-20, `2baa18e` 위)

| 항목 | 판정 | 근거 |
|------|------|------|
| 빈 끝과 최종 글자 사이의 명령 | CONFIRMED DEFECT — FIXED(재생 시험) | 수정 전 재생: Ctrl+Z가 앞선 편집을 먼저 되돌림, Ctrl+B·리본 굵게의 `format`이 넣기보다 먼저 감, 문서 전환·다시 불러오기 뒤 늦은 최종 글자가 다른 문서·새 모델에 들어감. 수정: 최종 글자 기다림([editor-surface-decision.md](editor-surface-decision.md#빈-끝과-최종-글자-사이-최종-글자-기다림-t010-ime-경계-2026-10-20-2baa18e-위)), 그동안 `composing`. `src/commands/imeGap.test.tsx` 9개(수정 전 처음 8개 중 6개 실패, 클릭 뒤 다시 불러오기 1개는 수정 중에 더함). |
| 진단 추적 묶음 | CONTRACT DEFICIENCY — FIXED | 시험기가 `window.__geulTrace.records`에 직접 넣어 최대 개수를 넘을 수 있었다. 이제 앱의 하나뿐인 추가 함수(`appendRecord`, 시험기는 `window.__geulTraceRecord`)로만 넣고(같은 최대·순번·버린 수), 보고서는 사례마다 `traceComplete`·`traceMissing`으로 구간이 빠졌는지 보인다. WebDriver 연결 끊김은 `infrastructureFailure`·종료 코드 2(판단 불가)로 따로 적는다. |
| 처음의 음절 사라짐 | UNVERIFIED | 재현 안 됨(이번 실제 2회 30/30 포함). 기다림은 H1(초점 이동) 외에 "최종 글자 전 명령 실행"이라는 다른 원인도 막지만, 그 관찰(revision 0)과 맞는지는 추적이 없어 모른다. H2(입력기가 버림)는 앱이 막을 수 없다. |

가용성 규칙 4의 `composing`은 이제 조합 중, 앱이 먼저 확정한 조합(provisional), 빈 끝 뒤 최종 글자 기다림을 모두 뜻한다.

## 저장 가용성과 끝나지 않은 IME 입력 (2026-10-20, `7680d92` 위)

- `file.save`는 불러왔고 저장 중이 아니어도 `composing`(조합 중·provisional·최종 글자 기다림)이면 `composing`으로 쓸 수 없다. 저장
  절차도 같은 상태를 `SaveNotReady{composing}`으로 막으므로, 처음 T010처럼 명령을 받아 놓고 저장 절차가 실패로 보이는 대신 가용성에서
  같은 이유로 거절한다(Ctrl+S는 기본 동작만 막고 이유를 알림). 대기 편집(`pending`)·불확실 모델은 그대로 저장 절차가 판정한다(잠깐인
  상태라 가용성에 넣지 않음). 시험 `sessions.test.tsx`의 저장 사례 기대를 이 정책으로 바꿨다(저장하지 않는다는 판정은 같음).
- 판정: 보존·수명주기 누락은 CONFIRMED DEFECT — FIXED(`src/commands/awaitingPreservation.test.tsx` 13개, 수정 전 처음 12개 중 8개 실패).
  자세한 것: [editor-surface-decision.md](editor-surface-decision.md#끝나지-않은-ime-트랜잭션과-보존수명주기-t010-2026-10-20-7680d92-위),
  [save-preservation.md](save-preservation.md#저장과-끝나지-않은-ime-입력t010-ime-경계-후속-7680d92-위).

## T010 후속 IME 수명주기 (2026-10-21, `94110f9` 위)

버리기 확인 뒤 닫기·창 닫기 또는 다시 불러오기는 해당 IME 거래의 세대를 무효화한다. 닫기가 실패해 편집이 돌아와도 버린 조합은 명령의 `composing` 장벽을 계속 붙들지 않으며, 시작 이벤트 없는 새 조합은 첫 preedit에서 정상적으로 `composing`이 된다. 아직 유효한 다른 문서의 거래는 계속 보호하고, 최종 확정은 원래 문서에만 넣는다. 명령 레지스트리·WordCraft 기록·가용성·모달 차단 정책은 바꾸지 않았다. 증거와 네이티브 이벤트 한계는 [editor-surface-decision.md](editor-surface-decision.md#t010-후속-ime-소유-세대와-닫기-실패-복구-2026-10-21-94110f9-위).

## T010 최종 안정화: 포인터 상호작용 및 선택 대체 시 명령 가용성 (2026-10-21, `37b39ae` 위)

폐기된 상태에서 발생한 `pointerDown` 이후 `compositionstart` 없는 첫 새 조합 수락, 그리고 선택 영역을 대체하는 조합의 취소/폐기 시에도 명령 가용성(`composing`, `dialogOpen`, `pendingEdits` 등) 및 모달 정책은 완전히 일관되게 유지된다. 새 preedit가 시작되는 즉시 세션은 정상적인 `composing` 상태로 진입하여 문서 명령을 안전하게 차단하고, 취소/폐기 시에는 임시 텍스트 정리와 함께 차단이 해제된다. WordCraft 실행 취소/다시 실행 기록 및 서식 가용성 정책은 일절 변경되지 않았다. 상세 검증: [editor-surface-decision.md](editor-surface-decision.md#t010-최종-안정화-폐기-뒤-포인터-입력과-ime-무결성선택-대체-계약rust-및-네이티브-검증-2026-10-21-37b39ae-위).

## T010 최종 검증: 클릭 뒤 굵게 판정과 명령 가용성 (2026-10-21, `f27b80a` 위)

명령 레지스트리·가용성·모달 정책·WordCraft 기록은 바꾸지 않았다. 바뀐 것은 실제 앱 시험기의 판정 하나다. `--ime-commands`의 "조합 중 페이지 클릭 뒤 바로 리본 굵게"는 `37b39ae`에서 "굵게를 받았으면 revision +2"를 요구했지만, 클릭이 커서를 접어 두면 굵게는 다음 입력 서식만 정하고 문서를 바꾸지 않는다(엔진 `changed = 0`, 위 "서식" 규칙과 Rust 시험 `t010_선택이_없으면_서식은_다음_입력에만_적용되고_문서는_바뀌지_않는다`). 이 실행에서 두 빌드(`37b39ae`·`f27b80a`) 모두 음절은 원래 자리에 한 번, 굵게는 확정 뒤 받아짐, revision +1로 같게 실패했다 → PRE-EXISTING 시험기 계약 결함. 이제 서식 연산 자신의 revision 변화(추적의 보낸 기준·응답)로 전체 revision을 맞추고, 접힌 커서면 같은 자리의 문서 서식과 굵게 뒤 단추 눌림이 반대인지(켜고 끄기)까지 본다. 거절(`composing`)은 서식 연산이 가지 않았을 때만 인정한다. 결과 18/18. 자세한 것: [editor-surface-decision.md](editor-surface-decision.md#t010-최종-검증-p1-판별-회귀표-셀-좌표webdriver-끊김-분류-2026-10-21-f27b80a-위).

## T011 리본: 형식별 탭·상황별 도구·명령 연결 (2026-11-04, `6524650` 위)

2026-11-04 계획 결정(tasks.md "T011 착수 조건 변경")에 따라 검증된 공통 명령 기반 위에서 구현했다. T010의 D2 INCONCLUSIVE·D4 지연 FAIL·
자원 INCONCLUSIVE, 제품 RHWP Undo/Redo·서식 NO-GO는 그대로다(레지스트리의 `RHWP_HISTORY`·`RHWP_FORMAT`·시험 빌드 상수는 바꾸지 않음).

### 구조

| 파일 | 역할 |
|------|------|
| `src/ribbon/visibility.ts` | `ribbonFormatFor(format)`: `hwp`·`hwpx` → `"hwp"`(한글 도구), `docx` → `"docx"`(참조·편지), 문서 없음·계약 밖 값 → `null`(공통 탭만). `visibleRibbonTabs(format)`(정의 순서 유지), `resolveActiveRibbonTab(id, visible)`(사라지면 홈, 없으면 첫 탭). 순수 함수. |
| `src/components/Ribbon/Ribbon.tsx` | `format` prop으로 보이는 탭만 그린다. 고른 탭이 사라지면 홈으로 바꾸고(형식이 돌아와도 되살리지 않음) 사라진 탭·도구 모음에 있던 초점은 고른 탭으로 옮긴다. 리본 밖 초점은 건드리지 않는다. `aria-controls`는 고른 탭만 갖는다(패널이 하나). 접기 단추 안내의 단축키는 레지스트리에서 읽는다(macOS Cmd). |
| `src/App.tsx` | `format`은 활성 세션의 `SessionInfo.format`(백엔드 SessionRegistry의 투영, `useActiveDocument`)이다. 엔진 ID·파일 이름·확장자에서 추측하지 않는다. |
| `src/components/CommandButton/editorFocus.ts` | 경계 C(편집 입력 초점 유지)를 함수 하나로 뽑아 `CommandButton`과 리본 탭·접기 단추가 같이 쓴다. `CommandButton`의 동작은 같다. |

표시는 실행 가능을 뜻하지 않는다: 보이는 탭의 모든 명령은 그대로 `commandState`(레지스트리·capability)와 실행 직전 재확인
(`executeCommand` → 세션 `execute`)을 거친다. 리본은 엔진 모델·저장 함수를 직접 부르지 않으며 두 번째 가용성 판단·기록·키보드
처리기를 두지 않는다.

| 활성 문서 | 공통 탭(파일·홈·삽입·그리기·디자인·레이아웃·검토·보기·도움말) | 한글 도구 | 참조·편지 |
|---|---|---|---|
| 없음 | 보임 | 숨김 | 숨김 |
| HWP / HWPX | 보임 | 보임(같은 탭 정의) | 숨김 |
| DOCX | 보임 | 숨김 | 보임 |

형식은 세션이 `identified`·`loading`·`failed`여도 백엔드가 정한 값이므로 탭은 보인다. 그 상태의 명령은 `notReady` 등으로 막힌다.

### 상황별 도구(선택 문맥)

선택 문맥으로 여는 상황 탭(표 도구·그림 도구)은 **만들지 않았다**. 관측 가능한 신호와 빠진 능력:

| 신호 | WordCraft(DOCX) | rhwp(HWP·HWPX) | 판단 |
|---|---|---|---|
| 글자 선택 유무 | 보기 `collapsed`·`selectionText` | `hasSelection`(같은 문맥) | 있음. 서식 명령의 눌림·가용성에 이미 쓰임(T010). |
| 커서가 표 셀 안 | 보기 `inTable` | `caret.cell`(중첩 표 제외) | 커서 위치 신호만 있음. 대기 편집 중에는 마지막 백엔드 보기라 늦을 수 있다. |
| 표·그림·도형 **개체 선택** | 없음(보기에 개체 선택 필드 없음) | 없음(위치 hit-test는 글자 위치만, 셀 안 개체·글상자·중첩 표 결과는 `null`로 버림 — `rhwpText.ts` `parsePosition`) | **빠진 능력.** |
| 표·그림 편집 명령 | 없음(`planned`) | 없음(`planned`) | 검증된 명령이 하나도 없음(T012·T013). |

표 탭을 `inTable`만으로 열면 쓸 수 있는 명령이 없는 탭이 커서 이동마다 나타났다 사라지고, 대기 편집 중에는 오래된 보기로 정하게
된다. 그래서 T011은 형식 문맥만 쓰고, 상황 탭은 다음이 갖춰질 때 붙인다: (1) 엔진 보기의 개체 선택(종류·ID·세대) 신호, (2) 대기
편집 중 문맥의 유효성 규칙, (3) 그 탭에 둘 검증된 명령(T012 표 계산 등). 한글 도구의 `hangul.tableFormula`는 지금처럼 `planned`다.

### 명령 연결과 차단

연결 대상은 T010 레지스트리 그대로다(새로 실행 가능하게 바꾼 명령 없음).

- 실행: 파일(`file.new`·`file.open`·`file.saveAs`, `file.save`는 두 엔진 T009 절차), 보기(창·리본·테마·확대/축소), 도움말,
  WordCraft 실행 취소·다시 실행·글자 서식 4종.
- 막힘: rhwp 실행 취소·다시 실행·서식(`engineUnsupported`, 제품 빌드), 그 밖의 리본 명령(`planned` → `notImplemented`, PDF·인쇄·
  표/그림 삽입·문단 정렬·쪽 설정·한글 도구·참조·편지·검토 포함). 형식 전용 탭의 명령은 모두 `planned`이고 단축키가 없다(시험이 지킴).
- 이유: 단추의 `aria-disabled`·제목(`command.reason.*`), 누르면 상태 표시줄(`command.unavailable.*`). 새 번역 키는 없다.
- 리본과 단축키는 같은 ID·`executeCommand`·`commandState`를 쓴다. 단축키가 있는 명령은 모두 공통 탭에 있으므로 숨은 탭의 명령을
  단축키로만 부르는 경우가 없다.

### IME·초점

- `CommandButton`의 경계 C는 그대로 두고 같은 함수를 리본 탭·접기 단추에도 붙였다. 전에는 편집 입력에 초점이 있을 때 리본 **탭**을
  누르면 초점이 탭으로 옮겨 갔다(명령 단추가 아니어서 경계 C 밖, 위 "남은 위험"의 문서 탭과 같은 노출). 이제 편집 입력 초점이 남고
  탭만 바뀐다. 편집 입력 밖에 초점이 있으면 아무것도 막지 않는다(키보드 Tab·화살표·Enter는 그대로).
- 문서 탭·탭 닫기 단추(Editor)는 리본 밖이라 바꾸지 않았다(기존 한계 유지).
- 문서를 바꾸면 그 편집 표면이 스스로 입력에 초점을 준다(기존 표면 동작). 리본의 초점 복구는 사라진 탭에 초점이 있었고 받을 곳이
  없을 때(예: 마지막 문서 닫기)만 작동한다.

### 확인 방법과 결과 (2026-11-04)

| 확인 | 결과 | 범위 |
|---|---|---|
| `npm run typecheck`, `npm run lint` | PASS | 전체 |
| `npx vitest run` | PASS 51파일 955개(변경 전 49파일 934개) | jsdom·가짜 엔진(FakeDocument·FakeDocx). 엔진 동작 증거 아님 |
| `src/ribbon/visibility.test.ts` | PASS 9개 | 형식 → 탭, 대신 고르기, 형식 전용 탭 명령 `planned`·단축키 없음 |
| `src/components/Ribbon/Ribbon.test.tsx` | PASS 12개 | 앱 전체(HWP·HWPX·DOCX 함께 열기): 탭 표시·전환·닫기·ARIA·화살표, 명령 대상·빠른 전환·차단 이유, 모달, 영어, 합성 IME 조합 중 리본 누름 |
| 변이 확인 | 4/4 검출 | 초점 복구 제거·탭 초점 빼앗김·대신 고르기 미유지·HWPX 오분류를 각각 넣으면 위 시험이 실패 |
| `tests/e2e/tauri_smoke.py --skip-restart` | PASS 34, SKIP 2 | 실제 Tauri debug 제품 빌드, Wayland 세션, WebKitGTK 2.54. SKIP: 최소 창 크기(창 관리자), 재시작(옵션) |
| `tests/e2e/t011_ribbon_native.py` | PASS 14/14 | 같은 빌드, 실제 rhwp WASM(HWP·HWPX)·WordCraft(DOCX) 문서. 형식별 탭, 실제 포인터 클릭 뒤 초점 유지, 대신 고르기·ARIA, HWPX 실행 취소·서식 차단과 revision 불변, 리본 굵게 = Ctrl+B(DOCX만), DOCX 닫기, Ctrl+F1 |
| 제품 번들 시험 표지 | 없음 | `dist/assets/*.js`에 `geul-test-build` 없음(RHWP 기록·서식 시험 상수 빠짐) |
| native 한국어 IME 중 리본 탭·접기 | 처음 NOT RUN → 아래 "실제 IME 검증"에서 PASS | 처음 실행 환경에 IBus·Xvfb 없음 |

로컬 시험(`tests/`)은 공개 저장소 밖(geul-tests)이다. `tauri-driver` 릴리스 바이너리의 ELF 해석기가 사라져(Nix GC) 현재 glibc 로더로 감싸
실행했다(도구 실행 방식만 다름). 표본 `target/hwpx-compat-20261102/native-sc002-run1/native.docx`는 앱이 구조 손상으로 거절해 쓰지 않았고
WordCraft 픽스처 생성기의 `basic-ko.docx`를 썼다(이 거절은 T011과 무관하며 조사하지 않음).

기존 한계 유지: 문서 탭·탭 닫기 단추의 초점 이동, D2/D4, RHWP 제품 기록·서식 NO-GO, 선택 문맥 상황 탭 없음.

### 실제 IME 검증 (2026-11-04, `e285e60` 검사 훅 debug 빌드)

환경: Xvfb X11 1600×1200×24(창 1280×800), 세션 D-Bus, ibus 1.5.33 + ibus-hangul 1.5.5 두벌식(GTK ibus 입력 모듈), WebKitGTK 2.54,
xdotool 실제 키·실제 포인터. 로컬 Nix store의 기존 패키지를 격리 실행했다(설치·저장소 변경 없음). 두 가지 환경 보정이 필요했다:
ibus-hangul `initial-input-mode` 기본값이 `latin`이라 GSettings keyfile 백엔드로 `hangul`을 줬고(안 주면 로마자 그대로 들어가 게이트 7/7 FAIL —
입력기 설정 문제, 앱 결함 아님), 개발 셸의 `LD_LIBRARY_PATH`를 ibus·Xvfb에서 뺐다. DPR은 기록된 환경과 같은 1.041(기본)과 `-dpi 96`의 1.0 둘 다 썼다.

| 확인 | 결과 | 비고 |
|---|---|---|
| `tests/integration/rhwp/rhwp_poc.py --ime`(DPR 1.0) | 필수 7/7 PASS, 조합 중 문서 탭 전환 PASS | 창 초점 이동 항목은 `--focus-window` 없어 NOT RUN(선택 항목). DPR 1.041에서는 시험기의 덧셈 좌표 보정이 문서 탭을 빗나가 중단(시험기 한계) |
| `tests/integration/wordcraft/wordcraft_poc.py --ime`(DPR 1.0) | 필수 7/7 PASS + 선택·탭 전환 항목 PASS | 창 초점 이동 NOT RUN(선택 항목) |
| `wordcraft_poc.py --ime-commands`(DPR 1.0) | 18/18 PASS | 리본 굵게·빠른 실행 실행 취소(`CommandButton` → `editorFocus.ts` 경로)·단축키·문서 탭·닫기 |
| `tests/e2e/t011_ribbon_ime_native.py`(DPR 1.0, 1.041 각 1회) | 12/12 PASS ×2 | HWP·HWPX·DOCX × {공통 탭 삽입, 형식 전용 탭(한글 도구/참조), 접기 단추, 보기 탭 뒤 이어 입력} |

T011 탐침 판정: 'ㅎㅏ' 조합 중 실제 포인터로 리본 탭·접기 단추를 누른 뒤 End. 모든 사례에서 누름이 조합을 확정했고(누른 직후 composing=false)
음절은 원래 문서에 한 번(revision +1, 이어 입력 사례는 '하아' +2), 편집 입력 초점 유지, 탭 선택·접힘이 실제로 일어남, 다른 열린 문서 두 개의
revision·dirty 그대로였다. 중복·유실·다른 문서 삽입 없음.

관찰(기존 동작, T011 회귀 아님): 좌표가 빗나간 첫 DPR 1.041 실행에서 조합 중 리본의 **단추가 아닌 빈 곳**(그룹 배경·패널)을 누르면 음절은
한 번 확정됐지만 편집 입력 초점이 빠져 이어 친 키가 들어가지 않았다(경계 C는 단추·탭·접기 단추에만 있음). 같은 실행에서 조합 중 실수로
눌린 '다시 실행' 단추는 음절 한 번(revision +1)으로 처리됐다.

### T011 안정화: 리본 빈 곳 초점·모달 중 리본 배치 (2026-11-04, `ef14f4b` 위)

T011 수용 기록(위)은 당시 결과로 그대로 둔다. 아래 두 문제는 그 뒤 검토에서 확인해 고쳤다.

**A. 리본 빈 곳 누름이 편집 입력 초점을 빼앗음 — CONFIRMED DEFECT, FIXED.** 원인: 경계 C의 mousedown 기본 동작 막기가 명령 단추·탭·접기
단추에만 붙어 있어, 그룹 배경·그룹 라벨·도구 모음·패널·탭 줄 배경 같은 단추가 아닌 면을 누르면 mousedown 기본 동작(초점 이동)이 그대로
일어나 초점이 body로 빠졌다. 조합은 blur로 한 번 확정되지만 이어 친 키가 어디에도 가지 않았다(위 실제 IME 검증의 "관찰"). 고침:
`Ribbon`의 `<section>`에 `keepEditorFocusOnPointerDown`을 위임하고(탭·접기 단추의 개별 처리는 같은 함수라 뺐다, `CommandButton`은 제목
표시줄에서도 쓰여 그대로), 그 함수가 누른 곳이 글자 입력 요소(`input`·`textarea`·`select`·contenteditable)이거나 스크롤되는 요소 자신의
스크롤바이면 막지 않게 했다(탭 줄·패널은 `overflow-x: auto`, WebKit은 막힌 mousedown에서 스크롤바 끌기를 하지 않을 수 있음). 편집 입력에
초점이 없으면 전과 같이 아무것도 막지 않는다. 전파는 멈추지 않고 타이머·다시 초점 주기는 없다.

**B. 접기 단추·접힌 리본의 탭 고르기가 공통 모달 경계를 우회 — CONFIRMED DEFECT, FIXED.** 원인: 접기 단추가 `dispatch({type:"toggleRibbon"})`,
접힌 리본의 탭 고르기가 `setRibbonCollapsed`를 직접 불러, 확인 창이 열린 동안(`context.modal`) 단축키 Ctrl+F1은 막히지만 단추·탭의 클릭
처리기를 직접 부르면(합성 클릭 등) 창 뒤의 리본이 접히거나 펼쳐지고 선택이 바뀌었다. 실제 포인터는 창 배경(`discard-dialog__backdrop`)이
받아 닿지 않으므로 배경의 hit test에만 기대던 상태였다. 고침: 접기 단추는 Ctrl+F1과 같은 `view.ribbon` 명령을 `executeCommand`로 실행하고,
탭 고르기(접혀 있으면 펼치기)는 `commandState("view.ribbon")`가 쓸 수 있을 때만 한다. 쓸 수 없으면(dialogOpen) 아무것도 바꾸지 않고 알리지
않는다(모달 중 단축키와 같은 계약). 펼치기는 토글이 아닌 `setRibbonCollapsed(false)`로 둔다(그리기와 누름 사이에 상태가 바뀌어도 접지 않음 —
가용성은 같은 명령의 것). 형식 변경으로 사라진 탭의 대신 고르기는 내부 맞춤이라 모달과 무관하게 한다. 리본 탭 줄의 화살표 이동은 막지
않았다(창이 Tab을 창 안에 가두므로 모달 중 초점이 탭 줄에 있을 수 없음). 리본의 문서 명령 단추는 전과 같이 `executeCommand`가
dialogOpen으로 거절하고 이유를 알린다(기존 `CommandButton` 계약).

| 확인 | 결과 | 범위 |
|---|---|---|
| 고치기 전 `Ribbon.test.tsx`(새 사례 포함) | 6 FAIL / 15 PASS | A: 패널 mousedown 안 막힘·조합 중 패널 클릭 뒤 초점 body, B: 모달 중 합성 클릭으로 리본이 접히고 탭이 펼치며 선택이 '삽입'으로 바뀜, 구성 요소 dispatch 2회 |
| 고친 뒤 `npx vitest run src/components/Ribbon src/ribbon src/commands/commands.test.ts` | 56/56 PASS | `Ribbon.test.tsx` 21개(새 9개, 기존 A12는 모달 중 탭 고르기 금지에 맞춰 탭을 창 없이 고른 뒤 같은 단언으로 확인) |
| `src/components/CommandButton/editorFocus.test.tsx` | 5/5 PASS | 빈 곳·단추 막음, 초점 없음·다른 입력 칸, 글자 입력 요소, 스크롤바, 전파 |
| 변이 | 4/4 검출 | 위임 제거, 접기 직접 dispatch, 탭 고르기 무검사, 늘 preventDefault |
| `npx vitest run` | 52파일 969개 PASS | jsdom·가짜 엔진, 합성 IME |
| `npm run typecheck`, `npm run lint` | PASS | |
| `tests/e2e/t011_ribbon_ime_native.py`(검사 훅 debug, Xvfb + ibus 1.5.33 + ibus-hangul 1.5.5, WebKitGTK 2.54) | DPR 1.0: 22/22 PASS. DPR 1.041: IME 21/21 PASS(모달 사례는 아래 시험기 보정 전 중단) + `--modal-only` 1/1 PASS | 새 빈 곳 사례 9개: 세 형식 × {그룹 라벨, 그룹 배경, 패널}, `elementFromPoint`로 그 면 자신인 지점을 고르고 mousedown 대상까지 확인한 실제 포인터 → 조합 '하' 한 번 확정, 초점 유지, 이어 친 '아'도 같은 문서(+2), 다른 문서 불변. 모달 사례: DOCX 버리기 확인 창 중 Ctrl+F1·합성 접기/탭 클릭은 배치·선택·알림·revision 그대로, 초점은 창의 취소에 남음, 실제 포인터는 창 배경이 받음. 창을 닫으면 Ctrl+F1·접기 단추·탭 정상 |
| `wordcraft_poc.py --ime-commands`(DPR 1.0) | 18/18 PASS | `CommandButton` 경로 회귀 |
| `tests/e2e/t011_ribbon_native.py`(Xvfb, 입력기 없음) | 14/14 PASS | |

시험기·환경 기록: (1) 이 Xvfb 키맵에서 xdotool `ctrl+F1`은 F1이 아니라 `Alt` keydown으로 온다(진단 실측). 그래서 모달 사례의 Ctrl+F1은
WebDriver 키 동작으로 보냈고, 실제 키보드 Ctrl+F1의 모달 차단은 이 환경에서 근거가 없다(경로는 기존 `handleShortcut`, jsdom 시험 PASS).
(2) 첫 DPR 1.041 실행의 모달 구간은 시험기가 실제 포인터로 배경을 누른 뒤 Escape로 닫으려다 중단했다(아래 한계) — 닫기를 창의 취소 단추로
바꾼 `--modal-only`가 통과했다.

남은 한계(기존, 이번 변경과 무관): 확인 창의 **배경을 실제 포인터로 누르면 초점이 창 밖(body)으로 빠진다**(실측). 그 뒤 Escape·Tab이 창에
닿지 않는다(창의 키 처리기가 창 요소에 있음). 리본·문서 명령은 그동안에도 모달로 막힌다. 확인 창(Editor `DiscardDialog`)의 초점 관리는
이번 범위 밖이라 바꾸지 않았다. 문서 탭·탭 닫기 단추의 초점 이동도 그대로다.

#### 후속: 확인 창 배경·본문 누름의 초점 이탈 — CONFIRMED DEFECT, FIXED (2026-11-04, `2ee337c` 위)

위 "남은 한계"를 고쳤다. 원인: Editor `DiscardDialog`의 배경(`discard-dialog__backdrop`)과 창 안의 단추가 아닌 곳(제목·본문·단추 줄)은 초점을
받을 수 없는 요소라, 누르면 mousedown 기본 동작이 초점을 body로 옮겼다. 창의 Escape·Tab 처리기는 창 요소에 있어 그 뒤 키가 닿지 않았고, 편집
표면의 "모달 창 안에 초점이 있으면 초점을 가져가지 않음" 검사(`RhwpSurface`·`DocxSurface`)도 그 상태를 모달로 보지 못했다. 고침: 배경 요소의
mousedown에서 누른 곳이 창의 단추가 아니면 기본 동작을 막고(창 안의 초점 그대로), 초점이 이미 창 밖이면 그 누름에서 취소 단추로 돌려놓는다
(동기 처리, 타이머 없음). 창 단추 누름은 막지 않는다. 배경 누름은 전과 같이 창을 닫지 않는다. 창 글자를 끌어 선택하는 것은 이제 시작되지 않는다.

| 확인 | 결과 | 범위 |
|---|---|---|
| 고치기 전 `src/commands/stabilization.test.tsx`(새 3개 포함) | 2 FAIL / 16 PASS | 배경 mousedown 안 막힘, 창 밖 초점 복구 없음(단추 사례는 원래 PASS) |
| 고친 뒤 같은 파일 | 18/18 PASS | 배경·창·제목·본문·단추 줄 누름 뒤 초점 유지·창 유지, Tab 가두기, 창 안 다른 단추 초점 유지, Escape로 닫고 연 요소로 복원, 확인 단추 동작, 창 밖 초점 복구 |
| 변이 | 2/2 검출 | 창 밖 복구 제거, 단추까지 막기 |
| `npx vitest run` | 52파일 972개 PASS | |
| `npm run typecheck`, `npm run lint` | PASS | |
| `tests/e2e/t011_ribbon_ime_native.py --modal-only`(Xvfb + ibus-hangul, 검사 훅 debug) | DPR 1.041·1.0 각 1/1 PASS | 실제 포인터로 배경(리본 접기 단추 자리 — mousedown 대상 `discard-dialog__backdrop`)·창 본문을 누른 뒤 초점은 취소, **실제 키 Escape로 닫힘**, 그동안 리본 배치·선택·알림·revision 그대로 |
| `wordcraft_poc.py --ime-commands`(DPR 1.0) | 18/18 PASS | 조합 중 닫기 단추·기다림 중 탭 닫기의 버리기 확인 사례 포함 |

#### 후속: 문서 탭·탭 닫기 단추 누름의 초점 이동 — FIXED (2026-11-04, `f9df6b8` 위)

T010 마무리 안정화("남은 위험")부터 남아 있던 노출을 닫았다. 원인: 경계 C가 명령 단추·리본에만 있어, 편집 입력에 초점이 있을 때 문서 탭·탭 닫기
단추를 누르면 mousedown 기본 동작이 초점을 그 단추로 옮겼다. 입력기는 누름에서 조합 확정을 두 반쪽으로 나눠 보내므로 뒤 반쪽이 편집할 수 없는
단추로 갈 수 있었다(가설 H1과 같은 경로, 실제 시험에서는 음절이 남아 있었음). 고침: Editor 문서 탭 줄(`.document-tabs`)에
`keepEditorFocusOnPointerDown`을 위임했다(문서 탭·닫기 단추·빈 곳, 편집 입력에 초점이 있을 때만). 탭을 고르면 새 문서 표면이 스스로 입력에
초점을 주는 기존 동작은 그대로이고, 고친 문서를 닫으면 확인 창이 창을 연 요소로 편집 입력을 기억해 취소 때 돌려준다(전에는 닫기 단추로 돌아갔다).
다른 입력 칸(경로)에 초점이 있으면 전과 같이 막지 않고, 키보드로 탭에 초점을 두고 Enter로 고르는 것도 그대로다. 경로 입력·열기 단추가 있는 문서
막대의 나머지는 바꾸지 않았다.

| 확인 | 결과 | 범위 |
|---|---|---|
| 고치기 전 `Ribbon.test.tsx`의 새 D1–D5 | 2 FAIL(D1 탭·닫기·빈 곳 mousedown 안 막힘·탭 클릭 뒤 초점 탭 단추, D5 확인 창 취소 뒤 초점 닫기 단추) / 3 PASS | D2 조합 중 탭 전환(합성)은 jsdom에서 원래 통과 — 뒤 반쪽 위험은 실제 입력기에서만 드러남 |
| 고친 뒤 `npx vitest run` | 52파일 977개 PASS | 확인 창 시험의 복원 기대를 "창을 열 때 초점 요소(편집 입력)"로 맞춤 |
| `npm run typecheck`, `npm run lint` | PASS | |
| `tests/e2e/t011_ribbon_ime_native.py --doc-tabs-only`(DPR 1.041) | 4/4 PASS | 실제 포인터로 조합 중 다른 문서 탭(HWPX→HWP, HWP→DOCX, DOCX→HWPX): '하'는 원래 문서에 한 번, 이어 친 '아'는 새 문서, 세 번째 문서 불변, 누르는 동안 `focusin`은 새 편집 입력뿐(탭 단추 없음). 고친 HWPX 닫기 단추 → 확인 창 초점, 실제 Escape 뒤 편집 입력 |
| 같은 탐침 전체(DPR 1.0) | 26/26 PASS | 리본 IME 21 + 문서 탭 4 + 모달 1 |
| `rhwp_poc.py --ime`, `wordcraft_poc.py --ime`(DPR 1.0) | 각각 필수 7/7 PASS, 조합 중 탭 전환 PASS | 창 초점 이동 항목 NOT RUN(`--focus-window` 없음, 선택 항목) |
| `wordcraft_poc.py --ime-commands`(DPR 1.0) | 18/18 PASS | 조합 중 다른 문서 탭·닫기 단추 사례 포함 |

#### 후속: 모달 중 리본 키보드 이동 — CONFIRMED DEFECT, FIXED / 실제 X11 창 초점 IME 검증 (2026-11-04, `789d99a` 위)

**모달 중 리본 키보드 이동.** 원인: 리본 탭 줄·도구 모음의 `onKeyDown`이 `useRovingFocus`를 바로 불렀다. 그 훅은 화살표·Home·End에서 기본 동작을
막고 `tabIndex`·DOM 초점을 먼저 바꾼 뒤 `onMove`(탭 선택)를 부르므로, 클릭 경로의 `commandState("view.ribbon")` 검사가 키보드에는 없었다.
확인 창이 초점을 가두므로 실제 앱에서 닿기는 어렵지만, 초점이 프로그램으로 탭 줄에 옮겨진 상태에서는 모달 중 화살표 한 번으로 선택이
바뀌었다(고치기 전 시험: 선택 Home → Insert, 도구 모음 초점 이동, 앱에서 '홈' → '삽입'). 고침: `Ribbon`의 탭 줄·도구 모음 키 처리기가
`useRovingFocus`를 부르기 전에 같은 가용성을 본다(쓸 수 없으면 키를 건드리지 않음 — 기본 동작·전파 그대로, 알림 없음). 훅(`useRovingFocus`)과
다른 사용처(없음)는 바꾸지 않았다. 형식 변경으로 사라진 탭의 대신 고르기는 그대로 모달과 무관하다.

| 확인 | 결과 | 범위 |
|---|---|---|
| 고치기 전 `Ribbon.test.tsx`의 새 5개 | 3 FAIL / 2 PASS | A01–A05(구성 요소), 도구 모음, 앱 A07/A08/A10 실패. A06(닫힌 뒤 이동)·A09(대신 고르기)는 원래 PASS |
| 고친 뒤 `Ribbon.test.tsx`·`stabilization.test.tsx`·`src/ribbon` | 62/62 PASS | |
| `npx vitest run` | 52파일 982개 PASS | |
| `npm run typecheck`, `npm run lint` | PASS | |
| `tests/e2e/t011_ribbon_ime_native.py`(DPR 1.0, 전체) | 26/26 PASS | 이 수정이 들어간 빌드로 리본·문서 탭·모달 회귀 |
| `wordcraft_poc.py --ime-commands`(DPR 1.0) | 18/18 PASS | |

**실제 X11 창 초점 IME 검증(전에는 NOT RUN).** 빌드: `789d99a` + 위 수정의 작업 트리, `VITE_GEUL_TEST_HOOKS=1 npm run tauri -- build --debug
--no-bundle`(2026-11-04 13:22, 실행 파일 sha256 `423ebbb4…`), rhwp `1a76570`·WordCraft `fc41918` submodule, debug RHWP WASM 세대 `0c2faef3…`
(`rhwp_bg.wasm` sha256 `9a9db493…`), WebKitGTK 2.54.1. 환경: Xvfb 21.1.23 `:91` 1600×1200(창 관리자 없음), 세션 D-Bus, ibus 1.5.33 +
ibus-hangul 1.5.5(GTK ibus 입력 모듈, `initial-input-mode='hangul'`), xdotool. 외부 창: 로컬 store의 zenity 4.2.2를 같은 DISPLAY에
`--entry --title=x11-focus-peer`로 띄워 geul 창(1280×800, 0,0) 밖 1300,900으로 옮긴 별도 최상위 X 창(geul과 다른 X 창 ID; 제목은 시험기들의
geul 창 검색 `^geul`에 걸리지 않게 정함). 초점 이동은 `xdotool windowfocus --sync`(XSetInputFocus)이며, 매 단계 `xdotool getwindowfocus`가
외부 창/geul 창인지, 앱의 `document.hasFocus()`와 `window` blur/focus 사건이 맞는지 함께 확인했다. 키는 xdotool 실제 X 키(조합은 ibus-hangul).

| 확인 | 결과 | 관찰 |
|---|---|---|
| `t011_ribbon_ime_native.py --window-focus`(DPR 1.041, 1.0 각각) | 9/9 PASS ×2 | HWP·HWPX·DOCX(세 문서 함께 열림) × {idle 1회, 조합 중 2회}. 매번 X 초점이 외부 창으로 갔다가(앱 `window:blur`, `hasFocus` false) geul로 돌아옴(`window:focus`, 편집 입력이 스스로 다시 초점). idle: 돌아와 친 '하아'가 그 문서에 +2. 조합 중: 다른 창으로 가는 순간 조합 '하'가 한 번 확정(+1)되고 돌아와 친 '아'까지 '하아' +2, 세션 ID·load generation 그대로, 활성 문서 그대로, 다른 두 문서 revision·dirty 불변 |
| `rhwp_poc.py --ime --focus-window '^x11-focus-peer$'`(DPR 1.0) | 필수 7/7 + "조합 중 창 초점 이동 뒤 돌아옴" PASS | HWPX: 다른 창에 있는 동안 '하', 돌아와 공백 뒤 '하 ', revision +2 |
| `wordcraft_poc.py --ime --focus-window '^x11-focus-peer$'`(DPR 1.0) | 필수 7/7 + 같은 항목 PASS | DOCX: '하 ', revision +2 |

실제 초점 이탈 때의 사건 순서(세 형식 같음, 매 실행 같음): `deleteCompositionText` → `insertFromComposition`(조합 중, WebView가 스스로 확정) →
`compositionend("하")` → `insertFromComposition` → `compositionend("하")`(입력기의 같은 확정 반복) → `window:blur`. 앱은 앞의 확정을 한 번 넣고
뒤의 반복을 소비했다(위 "WebView가 스스로 확정한 조합" 규칙 — 그동안 재생 시험·문서 탭 경로로만 보던 것을 실제 창 초점 이탈에서 확인). 다른 창에
있는 동안 편집 입력은 문서의 `activeElement`로 남았고, 돌아오면 새 조합이 정상 순서(빈 끝 뒤 최종 글자)로 진행됐다. RHWP와 WordCraft의 차이는
관찰되지 않았다.

시험기 기록: 첫 `--window-focus` 실행은 9/9 PASS였지만 사례마다 사건 기록 스크립트를 다시 넣어 리스너가 쌓여 같은 사건이 여러 번 찍혔다(시험기
결함, 판정 무관). 한 번만 설치하게 고친 뒤 두 DPR 모두 다시 실행한 결과가 위 표다. 남은 범위: 창 관리자가 있는 환경(_NET_ACTIVE_WINDOW·
포커스 정책)·Wayland·다른 입력기에서의 창 초점 이동은 T016 확장 환경이며 이번에 실행하지 않았다.

## T012 한글 도구: 장평·자간·표 계산 (2026-11-05, `92f8688` 위, 부분 완료)

### 연결한 것

| 명령 | 엔진 연산 | 제품 노출 | 근거 |
|---|---|---|---|
| `hangul.charWidth` | rhwp `applyCharFormat`/`applyCharFormatInCell` `{"ratios":[v×7]}` | **시험 활성화 빌드만**(`RHWP_FORMAT`, HWPX) | 실제 WASM·실제 `service::save` 통과. 제품 rhwp 실행 취소 NO-GO라 글자 서식과 같은 관문 |
| `hangul.charSpacing` | 같은 함수 `{"spacings":[v×7]}` | 시험 활성화 빌드만(HWPX) | 같음 |
| `hangul.tableFormula` | rhwp `evaluateTableFormula(..., writeResult=false)` | 제품 HWP·HWPX | 문서를 바꾸지 않는 계산(실제 WASM: 계산 전후 내보내기 바이트 같음, revision 0) |

- 값 입력: 리본 단추 → `executeCommand`가 세션 스냅숏의 `parameters` 문맥으로 입력 창 요청(`CommandContext.requestInput`) → 창(`CommandInputDialog`,
  모달)에서 확인한 값만 `executeCommand(id, label, context, args)`로 다시 보낸다. 전역 대기 인자는 없다. 요청은 세션·불러오기 번호·revision을 담고,
  확인할 때 활성 문서·불러오기·revision이 다르면 실행하지 않는다(`commandInput.stale`). 활성 문서가 바뀌면 창을 버린다.
- 값 검증(`src/commands/parameters.ts`)은 창과 세션 실행 직전 두 곳에서 같은 함수다. 장평 50–200·자간 −50–50 정수(고정 rhwp `CharShape` 계약,
  범위 밖은 자르지 않고 거부 — rhwp `json_u8_array`는 형식이 틀린 원소를 버리고 변경 전체를 말없이 무시한다). 7개 언어에 같은 값을 쓴다.
- 장평·자간 문맥: 글자 서식 관문 + **한 문단 안**의 같은 문맥 선택(본문 또는 한 셀). 선택 없음·여러 문단은 `selectionRequired`(검증하지 않은 범위라 막음).
  한 변경 = 한 실행 취소 단계(`mutate`, 앞뒤 `history.boundary()`). 실행 취소는 실제 WASM에서 원래 장평으로 되돌림을 확인했다.
- 표 계산 문맥: 편집 가능·IME 안정·불확실 아님 + 커서가 셀 안이고 엔진이 셀 논리 좌표(`getCellInfo`)·표 크기(`getTableDimensions`)를 줄 때. 셀 밖은
  `notInTable`. 고정 rhwp `table_calc`에는 길이·괄호 깊이·범위 크기 한도가 없어(`A1:ZZZ999999`는 좌표 목록을 다 만든다) 길이 256·괄호 깊이 16·
  허용 글자·알려진 함수 이름·**모든 참조가 지금 표 안**을 먼저 검사한다. 결과는 상태 표시줄 알림(`CommandDispatch.message`)이고 "표는 바꾸지 않음"을
  밝힌다. 계산 오류(0으로 나누기 등)는 실패 알림, WASM trap은 모듈 상태를 알 수 없어 편집을 멈춘다(`failEditing`).

### 연결하지 않은 것(명시적 미지원)

- 제품 빌드 장평·자간: rhwp 실행 취소 기록이 제품 NO-GO(T010)라 글자 서식과 같이 `unsupported`. 시험 플래그를 제품에 켜지 않는다.
- HWP 장평·자간: 글자 모양이 DocInfo를 바꿔 T009가 거부한다(실제 저장 음성 대조: `recordsChanged{DocInfo}`, 원본 그대로). 세션도 문맥을 내지 않는다.
- 표 계산 결과 쓰기(`writeResult=true`): 고정 rhwp는 셀에 계산 **값 글자**만 넣고 계산식 필드를 남기지 않아 계산식 의미를 보존한다고 볼 수 없다.
- 여러 문단·문맥을 넘는 장평·자간, 같은 범위 연속 변경의 저장(아래 한계).

### 한계

같은 범위에 장평 뒤 자간(또는 서식 뒤 장평)을 이어 바꾸면 중간 글자 모양 정의가 본문에서 쓰이지 않는 덧붙임으로 남아 T010 덧붙임 규칙(덧붙인 정의는
모두 본문이 가리켜야 함)이 저장을 막는다. 모델·다시 열기 값은 맞고 저장은 원본을 그대로 둔 채 거부된다(실제 저장 사례 `chained-same-range`).
규칙은 넓히지 않았다.

### 확인 방법과 결과 (2026-11-05)

- 단위: `npx vitest run` 63 파일 1109+ 통과(새 `src/commands/hangulTools.test.tsx` 9 — 값 검증·레지스트리·제품 관문·문맥·조합·모달·trap·창, `Ribbon.test.tsx`
  앱 수준 리본→창→결과·낡은 요청·문서 전환). `npx tsc --noEmit`, `npx eslint .` 통과.
- 실제 WASM(비공개 tests): `GEUL_RHWP_TEST_GENERATION=release` 제품 Release `853a0689…`로 `hangul-tools.wasm.test.ts`(시험 활성화 플래그) 통과 — 모델·다시 연
  문서의 7개 언어 값, 나머지 글자 모양 그대로, 실행 취소, 표 계산 결과·오류·표 밖 거부·내보내기 바이트 같음. 플래그 없이 실행하면 제품 관문 확인만.
- 실제 저장: `tests/integration/rhwp/hangul_tools_save.py`(→ Rust `t010_phase0_save_service` ignored 시험, 실제 `service::save`) 9/9 기대 일치 — HWPX 6사례 safe·게시
  (두 번째 편집·저장 회차 포함), 연속 변경 1사례 안전 거부, 실행 취소 1사례, HWP 음성 대조 거부(원본 SHA 그대로).
- native X11/IBus 앱 수용: **NOT RUN**(이 환경에 X11 표시·IBus·입력 주입 도구 없음). 한컴 오피스 호환: **NOT RUN**.

## T013 DOCX 참조·검토: 새 메모만 연결 (2026-11-05, `7daeaeb` 위, 부분 완료)

### 연결한 것

| 명령 | 엔진 연산 | 제품 노출 | 근거 |
|---|---|---|---|
| `review.comment` | 고정 `DocxOp::Comment { text }` → WordCraft `review.newComment` | 제품 DOCX | Rust 엔진·저장 시험, 실제 저장 절차 두 회차, 앱 수준 리본 시험 |

- IPC: `DocxOp`에 변형 하나(`{"op":"comment","text":…}`, `deny_unknown_fields`)만 더했다. 임의 WordCraft 명령 ID·JSON·작성자 필드는 받지 않는다.
  `validate`가 글자(비어 있지 않음·공백만 아님·1000자 이하·제어 문자/U+FFFC 없음)를 실행 전에 검사하고, 세션·불러오기 번호·base revision 검사는 기존
  `docx_edit` 경계 그대로다.
- 실행 조건(엔진·어댑터): 선택이 비어 있지 않고 기준점·커서가 모두 본문 이야기(`StoryRef::Body`)여야 한다(커서만이면 엔진은 커서의 단어를 고르지만 앱은
  쓰지 않음). 한 WordCraft 명령이라 실패하면 엔진이 되돌리고, 문서 보호는 엔진이 판정한다(읽기 전용 거부, 메모만 허용 보호는 받음 — 시험). 메모 표지(개체
  글자)가 위치를 바꾸므로 어댑터 기억(IME 늦은 확정 자리 표시·고칠 수 있는 바로 앞 넣기)을 버린다. 실행 취소·다시 실행은 WordCraft 기록 한 단계다.
- 작성자: geul에 사용자 이름 설정이 없어 엔진 기본값 "WordCraft User"(다른 제품 이름) 대신 `geul`을 쓴다(`COMMENT_AUTHOR`, 입력 창에 밝힘). 날짜는
  WordCraft가 UTC로 적는다. 사용자 이름 설정은 후속 과제다.
- 화면: 세션 스냅숏 `parameters["review.comment"]`는 엔진 보기(마지막 응답)의 선택이 비어 있지 않고 두 자리 키가 `body:`일 때만 있다. 보낼 편집이
  있으면 `pendingEdits`, 선택 없음은 `selectionRequired`, 조합 중은 `composing`, 모달은 `dialogOpen`. 입력 창·낡은 요청 거절은 T012와 같은 경로다.

### 연결하지 않은 것(planned 유지, 근거)

실측(고정 WordCraft `fc41918…`, 생성 픽스처 `basic_ko`, 엔진 명령을 그대로 실행한 뒤 내보내기 → T009 `check_saved`):

| 명령 | 관측 | 판단 |
|---|---|---|
| `references.footnote`·`references.endnote` | 엔진 자신의 내보내기 → 다시 읽기가 모델과 다름(`ReopenMismatch`: 메모리 모델에는 각주 구분선이 없고 내보내기가 기본 구분선을 써 다시 읽으면 생김) + 각주 부분 추가·목록·관계·settings 변경 | 엔진 왕복이 모델을 보존하지 않아 저장을 증명할 수 없다. 앱에서 모델을 고치는 것은 엔진 의미를 다시 만드는 일이라 하지 않았다 |
| `references.toc` | `ReopenMismatch`(필드 `Field{result}`가 다시 읽으면 `FieldStart`/`FieldEnd`로 바뀜) | 같음. 갱신(`references.updateToc`)도 연결하지 않음 |
| `review.trackChanges` | 저장은 `settings.xml`의 `<w:trackRevisions/>`만 다름. 그러나 추적 중에는 지운 글자가 문단 글자에 남아(삭제 표시) 어댑터의 IME 교정(`ReplaceInserted`)·늦은 확정(`InsertAt`) 위치 계산 전제(T008)가 깨진다 | IME 경계를 지킬 수 없어 연결하지 않음. 수락·거절도 연결하지 않음 |

잔여 위험(기존): 이미 `trackRevisions`가 켜진 DOCX를 열면 WordCraft가 편집을 추적한다(이번 작업 전부터 그렇다). 이 경로의 IME 교정 정확성은 검증하지 않았다.

### 확인 방법과 결과 (2026-11-05)

- Rust(`CARGO_TARGET_DIR=src-tauri/target cargo test --locked --manifest-path src-tauri/Cargo.toml`): 269 통과 / 22 무시(opt-in 증거 시험). 새 시험: 메모 연산 계약·IPC
  모양 거부, 본문 선택만·실행 취소/다시 실행, 어댑터 기억 버림, 보호(읽기 전용 거부·메모만 허용), 내보내기 → `check_saved` safe·다시 열기 같음·두 번째 회차
  (글자 편집, 둘째 메모 덧붙임) safe·메모 삭제 출력 거부, 실제 저장 절차(`preflight`→`save`→게시) 두 회차와 다시 연 메모, 저장 규칙 음성 변이(아래 save-preservation).
- `scripts/cargo-geul.py test`(보호 sandbox)는 이 환경에서 bwrap tmpfs 소유자 문제로 게시 시험 약 25개가 `SaveUnsupported{SharedDirectory}`로 실패한다(변경과 무관한
  files·recovery·publish 시험 포함, sandbox 밖 같은 시험은 통과). clippy `--all-targets -D warnings`·fmt는 보호 경로로 통과.
- 프런트엔드: `npx vitest run` 64 파일 1116 통과(새 `src/commands/reviewTools.test.tsx`, `Ribbon.test.tsx` 앱 수준 메모 흐름), tsc·eslint 통과.
- native X11/IBus 앱 수용·Word 호환: **NOT RUN**.

### T012/T013 후속 안전 검증 (2026-11-05)

- DOCX 메모는 대기열 수락과 엔진 성공을 구분한다. 엔진 거부는 `commandRejected` 알림 대상이며, 거부 자체는 revision·dirty·undo를 만들지 않는다.
- 읽기 전용 표 계산은 WASM 호출 전 합산 셀 접근 예산 4096을 적용한다. 고정 RHWP 파서 대신 토큰의 보수적 상한을 센다: 셀 토큰마다 1, 방향마다 전체 행/열 길이, 콜론마다 표 전체 면적을 더한다. 반복·중첩·역방향·와일드카드도 중복 제거 없이 센다. 길이 256·깊이 16 제한도 유지한다. 좌표/값 벡터의 wasm32 임시 메모리를 대략 128 KiB 이내로 제한하기 위한 예산이며 실행 시간 보장은 아니다. 따라서 큰 표의 작은 범위도 거부될 수 있다. 차원은 양의 안전한 정수이며 u32 센티널 미만이어야 한다. 결과 쓰기는 계속 금지한다.
- 첫 DOCX 메모 저장은 본문(`word/document.xml`) 안의 Transitional `http://schemas.openxmlformats.org/officeDocument/2006/relationships` 및 Strict `http://purl.oclc.org/ooxml/officeDocument/relationships` URI로 해석된 속성만 본문 관계(`word/_rels/document.xml.rels`)에 대조한다. 접두어 별칭은 허용하지만 관계 속성의 URI와 지역 이름을 보존한다. 따라서 Strict↔Transitional 변환은 자동 동등 처리하지 않고 거부한다. `r`이라는 접두어만 같은 외부 namespace나 unqualified `id`는 관계 속성이 아니다. ID는 비어 있지 않고 유일해야 하며, ID를 뺀 관계 속성(`Type`, `Target`, `TargetMode` 등)이 같고 참조 ID 변경이 일관될 때만 재번호화를 허용한다. 본문은 기존 엄격한 XML 커서로 스트리밍해 전체 canonical 사건·참조 목록을 만들지 않는다. 본문 관계 목록은 입력마다 한 번 파싱해 목록 비교와 ID 조회에 재사용한다. 헤더·푸터 XML 및 각자의 관계 파일은 일반 부분 비교가 보호한다. 관계 예외 XML의 정규화 payload는 `.rels` 부분당 4 MiB를 넘으면 자원 실패로 거부한다. 이는 heap/RSS 한도가 아니다. 수정 전 Strict 회귀는 resolver 호출 0회와 package/check_saved의 잘못된 허용을 확인했다. 수정 뒤 합성 재연결 게시는 forced `reopen_equal=true`에서도 거부된다(엔진 성공 근거가 아님). 실제 pinned WordCraft Strict source는 hyperlink를 읽고 Transitional로 내보내며 모델 재열기는 같지만, 기존 preflight/save는 이 namespace 변환을 거부해 원본을 보존한다. 풍부한 머리말·그림 문서는 2026-11-05 이전에 내부 Part ID 재할당 때문에 `ReopenMismatch`로 거부되었으나, 의미 왕복 동등성 통합(WordCraft `90b1877`, [save-preservation.md](save-preservation.md) "DOCX 의미 왕복 동등성 통합") 뒤에는 B0–B10 생성 fixture에서 메모 첫·둘째 저장이 실제 게시 파일 기준으로 통과한다(외부 Office·native NOT RUN). 하이퍼링크 일부에 단 메모는 여전히 관계 비교기가 거부한다.
- 검증 범위: frontend 세션/가짜 엔진과 실제 WordCraft 내보내기·재열기·저장 시험은 서로 다른 증거다. 기존 T012 `second-round`는 앞 WASM export 파일을 다시 여는 시험이며 실제 게시 파일 재편집 증거로 보지 않는다. native X11/IBus, 기존 trackRevisions의 IME 위치 안전성, 선택만 바뀌는 비동기 응답과 모달 사이 경계, 악성 관계를 실제 WordCraft가 생성·재열기하는 경로는 입증하지 않았다(합성 출력 주입에 대한 저장 서비스의 게시 거부는 검증했다). T012/T013 전체 완료를 뜻하지 않는다.

관계 비교 비용 관측(개발 프로필, 수동 1회, 테스트 `comment_relationship_cost_measurement`): 합성 패키지 11개 XML 중 9개에 본문 크기의 XML, 128/1,024개 추가 관계를 둔 경우다. 본문 8,891 bytes/100 참조에서 기존 전체 canonical 방식 67.147 ms, 새 스트림 비교 10.316 ms였다. 870,191 bytes/10,000 참조에서는 3,200.001 ms와 507.472 ms였다. 참고용 retained-payload proxy는 기존 본문 canonical 45,017/5,633,037 bytes, 새 방식은 양쪽 한 시작 요소 속성의 proxy 194 bytes였다. 이 proxy는 ID 인덱스·파서·디코더·allocator·RSS를 포함하지 않아 총 메모리 감소량을 나타내지 않는다. 외부 Office 호환 근거도 아니다.

Strict 회귀 시험: `strict_reference_rebinding_*`, `strict_reference_valid_renumbering_and_namespace_refusal`, `strict_reference_real_wordcraft_export_probe`; XML streaming·namespace 시험은 `document::xml::relationship_reference_tests`. Strict→Transitional 저장 지원과 외부 Office 호환은 검증·허용하지 않았다. T013은 미완료다.

## T013 각주·미주 연결과 T012/T013 재검토 (2026-11-05, `af879d1` 위)

### 연결한 것

| 명령 | 엔진 연산 | 제품 노출 | 근거 |
|---|---|---|---|
| `references.footnote` | 고정 `DocxOp::Footnote { text }` → WordCraft `references.footnote` | 제품 DOCX | 엔진 왕복·어댑터·실제 저장 두 회차·적대적 저장 시험, 앱 수준 리본 시험 |
| `references.endnote` | 고정 `DocxOp::Endnote { text }` → WordCraft `references.endnote` | 제품 DOCX | 같음 |

- 원인과 수정: 각주·미주를 넣은 모델은 내보내기 → 다시 읽기에서 `ReferencePresence("note separator")`로 달랐다. 모델 계약은 `NoteSeparators`의 `None` =
  기본 구분선이고 writer는 그때 고정 기본 XML을 쓰는데, reader가 그 XML을 다시 `Some(blocks)`로 읽었다. WordCraft reader가 writer의 **정확한** 기본 형식
  (문단 하나, 속성은 `w:spacing after=0 line=240 lineRule=auto`뿐, 실행 하나에 구분선 표지뿐, 다른 요소·속성·글 없음)만 `None`으로 읽게 고쳤다
  (`b39a8fb`, 로컬 전용). 문서 자신의 구분선·거의 기본인 변형(속성·간격·글·서식)은 그대로 `Some`이고 비교된다(시험).
- 실행 조건: 선택 없는 커서가 본문 최상위 문단(자리 키 `body:<문단>:<위치>`)일 때만(`caretRequired`). 엔진은 선택을 지우고 넣으며 커서를 새 각주 안으로
  옮기지만, 어댑터는 선택이 있으면 거부하고(글자를 지우지 않음) 실행 뒤 커서를 본문의 표지 바로 뒤로 돌린다(검증한 편집 문맥은 본문뿐). 한 WordCraft
  명령 = 한 실행 취소 단계이고, 되돌리면 각주 부분도 사라진다(고아 부분 없음, 시험). 글 계약은 메모와 같다(한 줄, 1000자, 제어 문자·U+FFFC 없음).
  입력 창·낡은 요청 거절·조합·대기·모달·엔진 거부 알림은 메모와 같은 경로다. rhwp에는 연결하지 않았다.
- 저장: [save-preservation.md](save-preservation.md) "T013 각주·미주 저장 규칙".

### 연결하지 않은 것(근거 갱신)

| 명령 | 2026-11-05 실측(WordCraft `b39a8fb`) | 판단 · 책임 계층 · 다음 방법 |
|---|---|---|
| `references.toc`, `references.updateToc` | 엔진이 넣는 목차는 제목 문단의 표지 필드 `Field{TOC, result:""}` + 생성한 항목 문단이고, reader는 모든 목차를 범위 필드(`FieldStart … FieldEnd`)로 읽는다(Word가 만든 목차 내용을 그대로 지키기 위한 표현). 왕복이 `Field("paragraph")`로 다르다 | BLOCKED(WordCraft 엔진). reader에서 범위를 표지로 바꾸면 가져온 목차 내용을 잃는다. 엔진의 `insert_toc`·`update_toc`·`regenerate_toc`가 범위 표현을 만들고 유지하도록 바꿔야 하고, 갱신의 쪽 번호(PAGEREF)는 배치 결과에 기대므로 따로 검증해야 한다 |
| `review.trackChanges`(수락·거절 포함) | 추적 넣기만 한 출력은 의미 동등. 지운 글이 남는 편집(지우고 치기, 선택 바꾸기, 자기 추적 넣기 고침) 뒤에는 `Field("revisions")`: 수정 기록 색인이 메모리에서는 만든 순서, 다시 읽으면 문서 순서로 매겨지고(부분 ID 순열과 같은 문제), 자기 추적 넣기를 지우면 쓰이지 않는 기록이 남는다 | BLOCKED(WordCraft 의미 비교). 다음: `roundtrip`에 수정 기록 색인의 일대일 대응(`CharProps.ins/del/fmt_change`, `ParaProps.fmt_change/num_change`, 표·행·셀·구역 `fmt_change`)과 쓰이지 않는 기록의 계약을 더한 뒤, settings `trackRevisions` 저장 규칙, 수락·거절, native IME 검증 |
| 하이퍼링크 일부에 단 메모 | 엔진 모델은 같고(링크가 메모 경계에서 둘로 나뉨), 관계 비교기가 본문 r:* 참조 수 1→2를 거부 | 안전 거부 유지(성공으로 세지 않음). 다음: 늘어난 참조가 모두 같은 관계 속성으로 묶이고 엔진 모델이 같을 때만 허용하는 좁은 규칙과 그 적대적 시험 |

### 이미 추적이 켜진 DOCX

`trackRevisions`가 켜진 DOCX를 열면 WordCraft가 편집을 추적한다. 앱의 실제 연산 열(넣기, 늦은 확정, 넣기 고침, 지우고 치기, 선택 바꾸기)을 어댑터에서
실행해 보니 편집은 추적되고(지운 글은 문단에 남아 취소선, 이어 친 글은 그 앞), 어댑터 위치는 보기의 원 글자 좌표와 같아 어긋나지 않았다. 지운 글이 남는
출력은 위 한계로 `same_as`가 false라 저장이 `ReopenMismatch`로 거부되고 원본이 그대로다(조용한 손상 없음, 패키지 보존은 통과 — 시험이 정확한 차이를
고정). 사용자는 편집했는데 저장할 수 없는 상태를 만날 수 있다(알림은 기존 저장 거부 알림). 편집 차단 정책은 넣지 않았다.

### T012 재검토(실측·원인)

- 제품 HWPX 장평·자간: rhwp 실행 취소 기록의 제품 NO-GO(T010 D2/D4)가 그대로라 `RHWP_FORMAT` 관문을 넘지 않는다(정책 BLOCKED). 단일 명령 기록 시험 통과를
  전체 rhwp 실행 취소 승인으로 보지 않는다.
- 같은 범위 연속 변경: rhwp `find_or_create_char_shape`는 같은 글자 모양을 다시 쓰지만 글자 모양 표가 덧붙임 전용이라, 중간 모양이 본문에서 쓰이지 않는
  덧붙임으로 남아 T010 HWPX 덧붙임 규칙이 저장을 막는다(BLOCKED, rhwp). 다음: 내보내기 때 이번 세션에 덧붙였고 어디서도 쓰이지 않는 모양을 빼고 본문
  참조를 다시 매기는 rhwp 압축 + 기존 규칙 그대로 검증. 저장 규칙을 넓히지 않았다.
- HWP 장평·자간: DocInfo 글자 모양 레코드 변경을 T009가 `recordsChanged{DocInfo}`로 거부(BLOCKED, 보존 규칙). HWPX와 같은 "덧붙인 모양만, 모두 본문이
  참조" 규칙을 HWP 레코드 단위로 새로 만들고 미리보기(PrvText/PrvImage)를 안전하게 다뤄야 한다.
- 표 계산 결과 쓰기: rhwp 모델에는 계산식 필드(`FieldType::Formula`)가 있으나 `evaluate_table_formula(write_result=true)`는 셀 문단 글자를 값으로 덮어쓸
  뿐이다. 계산식 보존 쓰기는 계산식 필드를 만들거나 고치는 rhwp 기능이 필요하다(BLOCKED, rhwp). 읽기 전용 계산은 그대로다.

### 확인 방법과 결과 (2026-11-05)

- WordCraft(`b39a8fb`): `cargo test -p wordcraft-doc -p wordcraft-docx -p wordcraft-engine` 840 통과 + 기존 실패 1(`file_access` 소스 검사, `fc41918`과 같은
  입력), 새 `docx/tests/note_separators.rs` 4, 엔진 각주·미주 두 회차 왕복. fmt·clippy `-D warnings` 통과.
- geul Rust(직접 `cargo test --locked --offline --lib`): 304 통과 / 24 무시. 새 시험: 어댑터 각주 5, 추적 문서 1, 저장 수용 각주 두 회차(basic·rich B10 ×
  각주·미주, 앞에 넣어 번호 다시 매김 + 메모 함께), 각주 저장 규칙 적대적 변이. fmt·clippy `--all-targets -D warnings` 통과.
- 프런트엔드: `npx vitest run` 64 파일 1125 통과, `npx tsc --noEmit`, `npx eslint .` 통과.
- native X11/IBus 앱 수용·Word/한컴 호환: **NOT RUN**(이 환경에 X11·IBus·입력 주입 도구 없음, Wayland 표시만 있음).



### T012/T013 후속 검토 — 2026-11-05 현재 상태

위의 실측·로컬 전용·편집 차단 없음은 이전 검토 시점의 기록이다. 현재 WordCraft gitlink와 공개 포크 `MinGyu2/wordcraft`의 `geul/semantic-roundtrip-equivalence` 브랜치는 모두 `b39a8fb49c6fefbdd960792f2a4effd0d7660e3c`다. 빈 저장소의 익명 HTTPS 직접 SHA fetch 및 새 geul master clone의 WordCraft 단독 초기화가 성공했다. 이번 작업에서 push는 하지 않았다. 안정 태그 `geul-roundtrip-42e8a67`는 이전 `42e8a67`에 남는다.

이미 추적 중인 DOCX는 이제 엔진 보기 `trackedReadOnly`를 기준으로 읽기·선택·탐색만 허용한다. 단순 추적 삽입은 저장 가능하지만 이어지는 IME 재치환은 `Field("revisions")`로 실패해, 연속 입력까지 보장하는 편집 부분집합은 입증되지 않았다. 프런트엔드는 변경 연산 대기열과 IME 시작을 차단하고 한·영 지속 안내를 표시한다. 백엔드는 모든 문서 변경 연산을 실행 전에 다시 거부한다. 거부는 dirty·revision·undo를 만들지 않는다. 추적 토글은 계속 planned다. 편집하려면 호환 편집기에서 추적을 끈 사본을 열도록 안내한다.

기존의 이미 추적된 문서 편집 동작을 제한하는 제품 정책 변경이다. native X11/IBus는 DISPLAY와 ibus 부재로 NOT RUN이며 합성 IME 시험으로 대체했다고 주장하지 않는다. T012/T013 전체 상태는 미완료다.

### Stage 1 안정화: trackedReadOnly IPC 계약·구분선 래퍼/설정 검증 (2026-11-05, `4c19443` 위)

- IPC 계약: Rust `DocxView::tracked_read_only`는 언제나 직렬화된다. 프런트엔드 `DocxView.trackedReadOnly`를 **필수** `boolean`으로 바꾸고 필수 키 목록
  (`VIEW_KEYS`)에 넣었다. 빠짐·`undefined`·`null`·문자열·숫자·객체·배열은 보기 전체를 거부하고(`docx_load`·`docx_view`·`docx_edit` 응답은 `Protocol`
  실패), 정확한 키 검사도 그대로다(`tracked_read_only` 같은 다른 이름·추가 키 거부). 잘못된 응답이 추적 문서를 편집 가능하게 보이게 하지 못한다.
  Rust 계약 시험은 값이 `false` 불리언임까지 확인한다. 세션 시험: 추적 보기에서 실행 취소·서식·메모·각주·미주 명령 가용성 거부, revision·세션 유지,
  응답마다 백엔드 정책을 따름(해제 → 편집 가능, 다시 켜짐 → 변경 거부).
- 구분선(WordCraft `b39a8fb` 그대로, 엔진 변경 없음): 기본 구분선 판정은 구분선 문단 subtree만 보지만, writer는 래퍼에 `w:type`·`w:id` 말고 아무것도
  쓰지 않고 구분선을 언제나 -1/0(/1)로 번호 매기며, 저장 검사는 기존 구분선(래퍼 포함)을 정확히, settings를 정규화 비교한다. 실제 reader/writer·
  preflight·`docx::save` 시험(`separator_wrapper_and_settings_variants_are_classified`, 각주·미주 각 12사례): 래퍼 외부/WML 속성, 구분선 번호 바꿈
  (settings 참조 함께), `w:id` 없음, 같은 종류 중복(settings가 둘째 사용자 구분선을 가리킴), 사용자 구분선 앞/단독, 알 수 없는 `w:type`, 순서 바꿈,
  settings 참조 없음은 모두 preflight 불안전 + 저장 `UnsafeSave{PartChanged}` 거부, 원본 SHA·dirty·임시 파일 없음·티켓 해제. 접두어 별칭만 안전·게시.
  사용자 구분선은 모델에서 `Some`으로 구분된다(기본으로 정규화되지 않음).
- 알려진 한계(안전 거부): reader는 같은 종류의 첫 구분선을 쓰고 settings 참조를 따르지 않는다. 그 경우 모델 표시는 기본 구분선이지만 저장은 거부되어
  파일에서 잃는 것은 없다. 구분선 ID 재번호(LibreOffice식 0/1) 문서와 사용자 구분선 문서에 각주를 더한 저장은 거부된다(합법 재번호 허용 규칙은 settings
  재작성 전체를 검증해야 하므로 넣지 않음). Word의 중복 구분선 처리는 관찰하지 못해 reader 의미를 바꾸지 않았다.
- 확인: `cargo test --locked --offline --lib` 309 통과/24 무시, clippy `--all-targets -D warnings`, `npx vitest run` 64 파일 1130 통과, typecheck·lint 통과.
  native X11/IBus·Word: NOT RUN.

## T013 목차 넣기·갱신 (Stage 2, 2026-11-05, `9b28d7c` 위)

| 명령 | 엔진 연산 | 제품 노출 | 근거 |
|---|---|---|---|
| `references.toc` | 고정 `DocxOp::Toc {}` → WordCraft `references.toc {}` | 제품 DOCX | 엔진 왕복 시험, 어댑터 시험, 실제 저장 두 회차, 세션·리본 시험 |
| `references.updateToc` | 고정 `DocxOp::UpdateToc {}` → WordCraft `references.updateToc` | 제품 DOCX(본문에 목차가 있을 때) | 같음 |

- 원인 재현: 이전 기록의 `ReopenMismatch`(`Field("paragraph")`)는 **항목이 없는 목차**(제목 문단이 없는 문서)에서 생겼다. writer가 빈 `TOC` 필드를
  `TOCHeading` 문단 끝에서 열고 바로 닫고, reader는 그 빈 범위를 엔진 표현으로 되돌리지 않았다. 항목이 있는 목차는 이미 reader의
  `toc_field_to_heading`이 엔진 표현으로 읽어 동등했다(실측). 책임 계층은 WordCraft reader다.
- 엔진 수정(`af80638`, 로컬 전용·미발행): writer의 정확한 빈 목차 모양(제목 스타일 `TOCHeading`, 그 문단의 목차 필드 하나, 빈 범위가 문단의 마지막
  내용, 다음 블록이 목차 항목이 아님)만 빈 필드로 읽는다. 결과가 있거나 뒤에 글이 있거나 정적 항목 문단이 뒤따르거나 다른 스타일·두 번째 목차는
  명시 범위를 그대로 둔다(시험). 수정 전 엔진에서 빈 목차 시험이 실패함을 확인했다.
- 갱신 의미: 엔진 `regenerate_toc`가 필드 스위치(`\o` 수준, `\h` 링크·`_Toc` 책갈피, `\n`, `\p`)대로 항목을 다시 만들고, 쪽 번호는 엔진 배치를 두 번
  돌려 정한다(엔진 배치 기준이며 Word 배치와 같다는 근거는 없음 — Word NOT RUN). 제목 추가·삭제·순서 바꿈·중첩 수준·빈 목록을 엔진 시험이 확인한다.
  가져온 잠기지 않은 범위 목차는 갱신 때 엔진 표현으로 바뀐다(엔진 계약, 기존 결과는 새 항목으로 대체). 잠긴 범위 목차는 `hasToc`가 거짓이라 갱신을
  막는다. 이미 목차가 있는 문서의 넣기는 엔진이 그 목차를 갱신한다(두 번째 목차를 만들지 않음).
- 연결: 넣기는 선택 없는 본문 최상위 문단 커서(`caretRequired`, 백엔드도 재검사 — 엔진은 선택을 지우므로 앱이 거부), 갱신은 엔진 보기 `hasToc`
  (필수 IPC 불리언, 없으면 `tocRequired`). 값 입력 창 없는 문맥 명령(`ActionCommandId`, 스냅숏 `actions`/`actionReasons`)으로 가용성을 정한다.
  조합 중·대기 편집·모달·추적 문서는 기존 경로대로 막는다. 한 WordCraft 명령 = 한 실행 취소 단계, 어댑터 기억(IME 자리 표시·바로 앞 넣기)을 버린다.
- 저장: 출력은 `word/document.xml`·`docProps/app.xml`만 바뀌어 기존 T009 규칙을 그대로 통과한다(규칙 변경 없음). 문서에 TOC 스타일 정의가 없어
  writer가 `styles.xml`을 바꾸는 경우는 기존 부분 비교가 거부한다(검증한 픽스처는 WordCraft 생성 문서).
- 확인: WordCraft `cargo test -p wordcraft-doc -p wordcraft-docx -p wordcraft-engine --no-fail-fast` 869 통과 + 기존 실패 1(`file_access`), 새
  `toc_ranges` 1·`toc_roundtrip` 7. geul `cargo test --locked --offline --lib` 314 통과/24 무시(새 어댑터 4, 실제 게시 두 회차
  `toc_first_and_second_published_saves`), clippy `--all-targets -D warnings`, `npx vitest run` 64 파일 1132 통과, typecheck·lint.
  native X11/IBus·Word: NOT RUN(Word에서 목차 표시·갱신 호환은 미검증).

## T013 변경 내용 추적·수락·거절 (Stage 3, 2026-11-05, `e342447` 위)

| 명령 | 엔진 연산 | 제품 노출 |
|---|---|---|
| `review.trackChanges` | `DocxOp::TrackChanges { value }` → WordCraft `review.trackChanges {"value"}`(값 명시, 늦은 요청이 토글을 뒤집지 않음) | 제품 DOCX, 눌림 = 보기 `tracking` |
| `review.acceptChange`·`review.rejectChange` | `AcceptChange {}`·`RejectChange {}` → `review.accept`·`review.reject`(선택 또는 커서 자리의 변경) | 보기 `hasRevisions`일 때 |
| `review.acceptAll`·`review.rejectAll` | `AcceptAll {}`·`RejectAll {}` → `review.acceptAll`·`review.rejectAll` | 보기 `hasRevisions`일 때 |

- 원인(재현): 추적 중 지운 글이 남는 편집(지우기, 선택 바꾸기, IME 교정 `ReplaceInserted`, 수락·거절) 뒤 `Field("revisions")`. 모델은 수정 기록을 만든 순서,
  reader는 문서 순서로 번호 매기고, 자기 추적 넣기를 지우면 쓰이지 않는 기록이 남는다. 책임 계층은 WordCraft 의미 비교다.
- 엔진 수정(`b74830b`, 로컬 전용): 모든 수정 기록 색인 자리(글자 `ins`/`del`/`rPrChange`, 문단 표지, `pPrChange`, 번호 변경, 표·행·셀·구역 변경)를 부분 ID처럼
  일대일로 짝짓고, 짝의 기록은 값(종류·작성자·날짜·이동 이름)이 같아야 한다. 갈라짐·합침(`RevisionMapping`), 쓰이지 않는 다시 읽은 기록(`ExtraRevision`),
  없는 기록(`DanglingRevision`, 동등 아님)은 거부한다. 쓰이지 않는 원본 기록은 내용이 없고 쓰이지 않아 차이가 아니다. 변경 전 값(`old`)은 그대로 값 비교다.
  수정 전 비교로 엔진 시험 2개가 `Field("revisions")`로 실패함을 확인했다.
- 정책 변경: 이미 추적 중인 문서의 읽기 전용(`trackedReadOnly`, Stage 1까지)을 풀었다(`TRACKED_READ_ONLY = false`, 한 상수로 IPC·IME·명령 경계를 다시 막을 수
  있음). 근거: 앱의 실제 연산 열 14종(넣기, IME 교정, 늦은 확정 `InsertAt`, 원 글자 Backspace/Delete, 자기 넣기 지우기, 선택 바꾸기 + IME 교정, 붙여넣기,
  새 문단, 굵게(추적 서식), 메모, 각주, 목차, 실행 취소·다시 실행)이 추적 문서에서 모두 `same_as` + T009 안전이고, 저장한 출력을 다시 열어 둘째 추적 편집도
  같다. 위치 계약: 지운 원 글자는 문단 글자에 남고(취소선), 자기 추적 넣기를 고치면 그 글자는 사라지며(추적 기록 아님), IME 교정·늦은 확정·커서는 앱이 기억한
  원 글자 좌표에 맞는다(시험이 글자·커서 키를 고정). 변경 내용 추적만 허용하는 문서 보호에서는 글자 서식도 엔진이 추적으로 받는다(`FormatAccess::Allowed`).
- 저장: settings의 차이가 뿌리 바로 아래의 맨 `<w:trackRevisions/>` 하나의 있고 없음뿐일 때만 받는다(save-preservation "T013 Stage 3").
- 확인: WordCraft doc/docx/engine 875 통과 + 기존 실패 1. geul `cargo test --lib` 317 통과/24 무시(새: 추적 문서 연산 열·켜기/끄기·수락/거절 어댑터 시험,
  실제 게시 두 회차 `tracking_toggle_tracked_edits_and_review_publish_twice`·`tracked_document_ipc_edits_are_tracked_and_saved`, settings 음성 변이 5),
  clippy·fmt, `npx vitest run` 64 파일 1134 통과, typecheck·lint. **native X11/IBus 추적 입력·Word의 수락/거절 호환: NOT RUN**(Stage 7).
- 이전 기록(Stage 1의 추적 문서 편집 차단, `raw_tracked_ime_replacement_reproduces_revision_mismatch`)은 당시 엔진 `b39a8fb` 기준 사실이며, 그 시험은
  `raw_tracked_ime_replacement_round_trips`로 바뀌었다.

## T013 하이퍼링크 일부에 단 메모 (Stage 4, 2026-11-05, `d6c2719` 위)

- 재현: 하이퍼링크 일부에 메모를 달면 WordCraft는 모델에서는 링크를 글자 속성(`CharProps::link`)으로 그대로 두고, 내보낼 때 메모 경계 앞뒤로
  `w:hyperlink` 요소를 나누어 **같은 관계**(`rId1`)를 두세 번 가리킨다. 관계 목록은 그대로(하이퍼링크 관계 1개)이고 모델 왕복은 같다. 저장 거부 원인은
  geul 관계 참조 비교기(`relationship_references_equal`)가 본문 r:* 참조 수 1→2를 거부한 것이다. 책임 계층은 geul 저장 규칙이며 엔진 변경은 없다.
- 수정(좁은 계약, `xml::relationship_references_equal_with(.., split_hyperlinks=true, ..)`, 메모·각주 덧붙임 규칙의 본문 참조 대조에서만): 출력의 참조 자리가
  WordprocessingML `w:hyperlink`이고 그 r:* 속성(이름공간·이름·Id)이 **바로 앞** 출력 참조 자리(역시 하이퍼링크)와 정확히 같을 때만 나뉜 이어짐으로 건너뛴다.
  합침(출력이 더 적음), 다른 관계 Id, 하이퍼링크가 아닌 요소, 다른 참조를 사이에 둔 반복, 앞이 없는 반복, Strict/Transitional 이름공간 바뀜은 거부한다(단위
  시험). 관계 목록 다중집합·관계 속성(Type·Target·TargetMode) 대조와 엔진 다시 읽기(`same_as`)는 그대로다.
- 실제 저장(엔진 성공 증거, 두 회차): 전체 링크, 가운데, 링크 시작, 링크 끝, 링크→평문 경계, 평문→링크 경계 × (첫 저장 → 게시 파일 다시 열기 → 링크 안 둘째
  메모 → 둘째 저장). 다시 연 링크 대상·글(`Link text`)과 메모 경계 글이 정확하다. 한 저장의 메모 둘 + 실행 취소·다시 실행도 통과.
- 거부 확인(합성 출력 주입, 원본·dirty·복구 후보·티켓): 둘째 조각을 새 외부 대상으로(관계 추가), 없는 관계, Strict 이름공간 속성, 관계 대상 바꿈, 관계 형식
  바꿈은 패키지 규칙이 거부(`PartAdded comments`·`PartChanged rels` 등). 링크 내용 복제·링크 조각 삭제는 패키지 규칙은 받지만 `same_as` false로
  `ReopenMismatch` 거부(모델이 다름).
- Strict 원본은 WordCraft가 Transitional로 내보내 기존 규칙대로 거부한다(변경 없음). 확인: geul `cargo test --lib` 320 통과/24 무시, clippy·fmt.
  Word에서 나뉜 하이퍼링크·메모 표시: NOT RUN.

## T012 Stage 5 재평가: 제품 장평·자간 — BLOCKED (2026-11-05, `1341be2` 위)

판정: **BLOCKED**. 제품 `hangul.charWidth`·`hangul.charSpacing`은 `RHWP_FORMAT` 시험 활성화 빌드 관문 그대로 `unsupported`다. 엔진·저장 규칙·관문을 바꾸지
않았다(이 단계의 코드 변경 없음).

| 필수 조건 | 상태 | 근거·정확한 차단 |
|---|---|---|
| T010 D2(native IME, 빈 compositionend → Undo → 늦은 최종 글자) | INCONCLUSIVE 그대로 | native X11/IBus 필요. 이 환경은 Wayland 표시만 있고 DISPLAY·ibus 없음 → 실행 불가(NOT RUN). [rhwp-undo-redo.md](rhwp-undo-redo.md) D2 재개 조건 미충족 |
| T010 D4(WebView group p95≤50ms·Undo p95≤1500ms·자원) | 마지막 공식 FAIL 그대로 | 실제 WebKit 창 측정 필요(NOT RUN). 새 지연 제거 기전 없음 — 문턱·표본을 바꾸지 않음 |
| 같은 범위 연속 변경(쓰이지 않는 중간 글자 모양) | BLOCKED(rhwp) | `find_or_create_char_shape`가 덧붙임 전용. RHWP에는 글자 모양 참조 목록이 없어(문단·셀·글상자·머리말/꼬리말·각주·스타일·번호·컨트롤 `char_shape_ids` 등 흩어짐) 증명된 압축·재번호는 전체 참조 목록 구현과 RHWP Visual Sweep 관문(한컴 PDF 필요)이 선행돼야 한다. T010 덧붙임 규칙은 넓히지 않음 |
| HWP DocInfo 글자 모양 덧붙임 저장 | BLOCKED(T009 규칙) | `recordsChanged{DocInfo}` 거부 유지. HWP 레코드 단위 "덧붙인 글자 모양만 + 모두 본문 참조 + 미리보기" 규칙은 위 압축 없이는 같은 연속 변경 문제를 그대로 가짐 |

다음 재개 조건: D2/D4가 native 환경에서 원래 문턱으로 통과하거나 승인된 새 기전이 생길 것, 그리고 RHWP 글자 모양 참조 목록·압축(후보 패치) + 한컴 Hancom
호환 검증. 시험 활성화 빌드의 HWPX 장평·자간(이전 기록)은 그대로 유효하다.

## T012 Stage 6: 표 계산식 필드 — 부분 진행(엔진 후보만, 미연결) (2026-11-05, `eb9a54b` 위)

> 이 절은 후보 시점 기록이다. 현재 `hangul.insertTableFormula`는 별도 typed parameter command이며 test-hooks/history/formula 세 flag와 실제 history/API/셀 문맥을 모두 요구한다. active series 13번째 패치·새 Release WASM·실제 저장 검증까지 완료했고 제품은 D2/D4/보존 관문 때문에 unsupported다. 기존 `hangul.tableFormula`의 읽기 전용 계약은 유지한다. 아래 malformed parser/HWPX 속성/빈 표 한계 중 입증된 엔진 결함은 [후속 통합 기록](stage567-acceptance-2026-11-05.md#stage-6-영속-수식)에서 교정했다.

판정: **PARTIALLY COMPLETED**(엔진 후보와 네이티브 시험까지). 제품 `hangul.tableFormula`는 읽기 전용 계산 그대로이고 결과·계산식 쓰기는 연결하지 않았다.

- 한컴 실물 근거(창작 아님): 고정 RHWP의 `fields --json`과 `dump-records`로 한컴 저장 HWP 표본(`samples/calc-cell.hwp` 등 7개 문서)의 계산식 필드를
  확인했다. 컨트롤 `%fmu`(`FIELD_FORMULA`), CTRL_HEADER 속성 0·추가 속성 0x08, 명령 `={식}??{서식},;;{결과}`(예 `=SUM(A2,C1,D2)??%g,;;13`,
  `=AVG(ABOVE)??%.2f,;;2.00`), 필드 범위 안 글자 = 결과. 734개 HWPX 표본(5MB 미만)에는 한컴이 쓴 `type="FORMULA"`가 없어 HWPX 기준 형식은 없다.
- 후보 패치 `patches/rhwp/candidates/table-formula-field.patch`(빌드 series 밖): `insert_table_formula_field_native(구역, 문단, 표, 행, 열, 식)` — 기존
  `evaluate_table_formula`(쓰지 않음)로 계산하고 위 한컴 모양의 계산식 필드를 결과 셀에 만든다. 셀은 문단 하나이고 컨트롤이 없거나(글은 결과로 바뀜)
  문단 전체를 덮는 계산식 필드 하나여야 한다(바꾸기·같은 식 다시 부르기 = 수동 다시 계산). 다른 필드·컨트롤이 있는 칸, 표 밖 칸, `=` 없음, 명령
  구분자(`?`·`;`)·제어 문자, 계산 오류(0으로 나누기)는 아무것도 바꾸지 않고 거부한다(내보낸 바이트 같음). 변경은 문단 사본에서 한다. 결과 서식은 `%g`만
  (C printf 규칙: 유효 숫자 6, 뒤 0 제거, 지수 표기 경계). ClickHere 삽입의 빈 필드 넣기를 공통 함수로 나누었다(기존 동작 그대로).
- 네이티브 시험(후보 패치 안 `wasm_api::tests::geul_*`, 고정 RHWP + series 위, `cargo test -p rhwp --lib`): 5/5 PASS — `%g` 서식, 새 문서 HWP 저장 →
  다시 열기 → 원본 셀 고침 + 다시 계산 → 둘째 HWP 저장(식·결과·속성 0·추가 0x08), 한컴 `calc-cell.hwp`의 한컴 계산식 바꾸기 + HWP/HWPX 두 회차 저장(다른 한컴
  계산식 그대로), 거부 시 문서 그대로, 한컴 표본 모양 일치. 관련 회귀 `click_here` 6·`field` 144·`formula` 11·`table_calc` 29 PASS, rustfmt 깨끗, 바꾼 파일의
  clippy 발견 없음(RHWP 전체 clippy는 새 도구 모음의 기존 lint로 실패 — 변경과 무관).
- 발견한 기존 한계(후보와 무관): `create_empty()` 문서의 표는 HWPX로 내보낼 수 없다(미등록 ID). RHWP HWPX 경로는 한컴 원래 계산식 필드의 추가 속성 0x08도
  0으로 읽는다(시험이 손대지 않은 한컴 필드의 HWPX 왕복을 기준으로 고정). RHWP 계산기는 `=SUM(A1:` 같은 깨진 식도 받으므로 연결할 때 geul의
  `formulaProblem` 검사(길이 256·깊이 16·셀 접근 4096·표 안 참조)를 먼저 해야 한다.
- 연결하지 않은 이유(정확한 차단): (1) series에 넣으면 봉인된 RHWP 입력 신원이 바뀌어 새 WASM 세대 빌드와 실제 WASM 시험(비공개 시험 모음)·T009 HWP/HWPX 저장
  규칙 검토가 함께 필요하다 — 이번에 하지 않았다. (2) 셀 쓰기는 문서 변경이므로 실행 취소가 필요한데 제품 RHWP 실행 취소는 T010 NO-GO(Stage 5와 같은 차단).
  (3) HWPX 계산식 필드의 한컴 호환은 기준 표본이 없어 미검증, 한컴 오피스 열기·다시 계산: NOT RUN. (4) RHWP 렌더링 변경 관문(한컴 PDF Visual Sweep)도 NOT RUN.

## T012/T013 Stage 7: native·외부 호환 수용 — NOT RUN (2026-11-05, `57dde8e` 위)

> 다음 환경 부재/NOT RUN은 `57dde8e` 당시 기록이다. 현 X11/IBus/Tauri 환경은 재사용해 실행했으며 [최신 실제 native 범위와 미완료 외부 수용](stage567-acceptance-2026-11-05.md#stage-7-실제-native와-제품-관문)을 구분한다.

- 환경: `DISPLAY` 없음(X11 없음), `WAYLAND_DISPLAY`는 사용자의 실제 데스크톱 세션뿐이고 headless 합성기(weston) 없음, IBus·입력 주입 도구 없음,
  Microsoft Word·한컴 오피스 없음(Linux). 실제 Tauri 창 시험을 사용자 세션에 띄우지 않았다. 따라서 Tauri native 흐름(목차·추적·수락/거절·하이퍼링크 메모·
  장평/자간·계산식), X11/IBus 한글 조합(추적 중 입력 포함), Word 열기·목차 갱신·수락/거절·저장 뒤 geul 다시 열기, 한컴 HWP/HWPX 열기·계산식 확인은 모두
  **NOT RUN**. 합성 IME·엔진 왕복 시험을 native·외부 호환 증거로 바꾸지 않는다. 수용 커밋을 만들지 않았다.
- 최종 회귀(이 시점 HEAD): 직접 `cargo test --locked --offline --lib` 320 PASS/24 무시, fmt·clippy `--all-targets -D warnings` PASS, `npx vitest run` 64 파일
  1134 PASS, typecheck·lint PASS, `npm run build:frontend` PASS. WordCraft(`b74830b`) doc/docx/engine 875 PASS + 기존 실패 1(`file_access`). 보호 sandbox
  `scripts/cargo-geul.py test --lib`: 242 PASS/78 FAIL — 73개는 `SaveUnsupported{SharedDirectory}`(bwrap tmpfs 소유자, 기존 환경 한계), 5개는 sandbox 안에서만
  실패하는 디렉터리 권한·임시 파일·예약 시험(`files`·`recovery`·`save` a4/e/reservation, 이번 변경 밖 코드)이며 직접 실행은 모두 통과한다. 같은 보호 실행의
  `4c19443` 기준 대조는 이번에 하지 않았다(직접 PASS를 보호 PASS로 표기하지 않음).
- 판정: T012 미완료(Stage 5 BLOCKED, Stage 6 엔진 후보만), T013 미완료(Stage 2–4 구현·저장 검증 완료, native IME·Word 호환 NOT RUN). 두 항목 모두 체크하지 않는다.

## T012 Stage 5 구현: 글자 모양 정리·HWP DocInfo 규칙 (2026-11-05, `fd3ecd7` 위)

앞 절("Stage 5 재평가 — BLOCKED")의 엔진·저장 차단 두 가지를 구현했다. 제품 활성화 관문(T010 D2/D4)은 그대로다.

- RHWP(series 12번째 패치 `char-shape-compaction.patch`, Release WASM `39a3755c…`): `compactAppendedCharShapes(baseline)`이 불러온 뒤 덧붙인
  글자 모양(ID ≥ 기준 수) 중 참조 없는 것만 지우고 남는 덧붙인 모양을 앞으로 당긴다. 원본 정의·스타일·번호·글머리표·원본 바이트 보존 레코드의
  번호는 그대로다. 한 방문기가 모든 참조 자리(어느 깊이든 문단 글자 모양 — 셀·글상자·캡션·머리말/꼬리말·각주/미주·숨은 설명·필드 메모·
  바탕쪽 — HWPX 원문 위상, 누름틀 안내문 잔재, 글자 겹침, 번호 표지, 내부 클립보드 두 개, DocInfo 스타일·번호 머리·글머리표)를 모으고 옮긴다.
  덧붙인 모양을 DocInfo가 가리키거나 표 밖 번호가 있으면(한컴의 `0xFFFFFFFF` "참조 없음"은 제외) 아무것도 바꾸지 않는다. RHWP의 ID 기반
  실행 취소와 섞이지 않게 opt-in이다.
- geul 세션: `RhwpText`가 불러온 직후 `charShapeCount()`를 기준으로 기록하고 모든 글자 서식 적용(`format`, 장평·자간·굵게 등) 뒤 같은 기록
  단계 안에서 정리를 부른다. 응답이 계약과 다르면 엔진 오류로 던진다(편집 중단). 정리를 모르는 이전 세대는 부르지 않는다(저장 검사가 판정).
  장평·자간 문맥은 엔진이 정리를 지원할 때 HWP에도 낸다(시험 활성화 빌드 `RHWP_FORMAT`만 — 제품은 그대로 `unsupported`).
- HWP 저장 규칙(`save/hwp.rs` `docinfo_char_shapes_appended`): 한컴 저장 `KTX.hwp`(DocInfo 1195 레코드)의 실측 차이(`ID_MAPPINGS` +
  마지막 원본 `CHAR_SHAPE` 뒤에 끼운 `CHAR_SHAPE`, 나머지 바이트 동일)만 받는다: 원본 글자 모양 레코드가 이어져 있고, 같은 수준의 새 레코드
  k개가 그 바로 뒤, `ID_MAPPINGS`는 글자 모양 수(36바이트 위치)만 정확히 k 증가, 새 레코드마다 같은 길이의 원본 하나와 장평·자간 14바이트
  밖이 같고 장평 7개 같은 값 50–200·자간 7개 같은 값 −50–50, 새 모양 모두 본문 `PARA_CHAR_SHAPE`가 가리킴. 굵게 등 다른 속성 변경, 쓰이지
  않는 덧붙임, 수 불일치, 다른 레코드 변경은 계속 `recordsChanged{DocInfo}`(단위 시험 14 변이).
- 실제 WASM(새 세대) + 실제 `service::save`(`hangul_tools_save.py`, 비공개 시험): **15/15 기대 일치** — HWPX 본문·셀 장평/자간, 같은 범위 연속
  변경(이전 안전 거부 → 이제 게시), 장평→굵게→자간, 두 번째 회차, 실행 취소, 장평→자간→실행 취소→다시 실행→새 장평(HWPX·HWP), HWP 본문·셀
  연속·두 번째 회차 게시와 다시 연 값, 음성 대조(정리 없이 엔진 직접 두 번 → 쓰이지 않는 덧붙임) 거부·원본 그대로. `format_save.py` 7/7(음성 대조를
  굵게+기울임 새 모양으로 갱신 — 이전 굵게만 사례는 픽스처의 기존 굵은 모양을 다시 써서 DocInfo가 같았고 빈 미리보기 픽스처 뒤로 전제를 잃음,
  비공개 시험기 경로 결함 `resolve()`→`absolute()` 수정), `undo_save.py` 불일치 0. 실제 WASM vitest: 제품 구성 43 통과, 기록·서식 구성에서
  각 구성의 시험 통과(다른 구성 전제를 단언하는 `history-config`·`history-enabled`의 전제 시험만 해당 구성 밖에서 실패 — 설계).
- RHWP 네이티브: `char_shape_compact` 4 + 관련 회귀(format 72·snapshot 6·topology 3·char_format 5) 통과.
- 남은 제품 관문: T010 D2(native IME)·D4(WebView 지연) — Stage 7에서 다시 다룬다. 통과 전 제품 장평·자간은 `unsupported`.

## Plain-text clipboard (2026-11-10)

`edit.copy`/`edit.cut`/`edit.paste` use Mod+C/X/V and the same registry/session
boundary for keyboard and ribbon. Non-editor inputs and contenteditable retain
native shortcuts, including inside dialogs. Registered shortcuts cancel browser
clipboard defaults; they never wait for a subsequent ClipboardEvent. The original
hidden textarea beforeinput/input path remains for native input (including paste
from a context menu); a canceled Mod+V cannot also enter that path.

Initial trusted-button `navigator.clipboard.writeText/readText` roundtrip with
Korean/emoji passed, and canceled Ctrl+C emitted no copy event. A later native
control test invalidated browser-only reading: text copied by native Ctrl+C pasted
correctly in a textarea, but trusted async reads and ribbon Paste were denied.
Same-origin async clipboard writes had masked this limitation in the first probe.

The final Linux adapter uses a single bounded `clipboard_read_text` Tauri IPC for
reading and the verified browser writeText path for writing. Both keyboard and
ribbon use this same adapter/transaction, with no ClipboardEvent insertion fallback.
The native reader uses the existing GTK dependency (no new crate/plugin), posts
request_text to the UI thread, and waits off-thread with a five-second timeout.
It exposes no paths, arbitrary formats, filesystem or engine commands. The sole
new system-clipboard permission is `allow-clipboard-read-text` on the main window;
`allow-docx-selection-text` separately permits the fixed document reader. Responses
are limited to 4 MiB UTF-8 and 1,048,576 Unicode scalars, never truncated. Native
Unavailable/TooLarge errors fail without attempting a second clipboard read.
Other hosts return Unsupported and retain their browser API (not native-accepted).
Write failure never deletes. Read/write permission queries are unsupported on the
measured WebKitGTK; actual errors, rather than permission queries, decide execution.

Copy requires loaded/readable, settled IME, no pending selection/edit operations,
no save in progress, and a complete supported nonempty selection. Read-only Copy
is permitted. Cut/Paste additionally require writable/editable state. DOCX currently
refuses mutation for protected/region-restricted selections conservatively; the
engine still enforces its own protection. Paste also validates the entire plain
text before selection replacement. There is no success toast for merely accepting
an asynchronous operation; a queue/engine rejection follows the existing input
notice/error path.

Every action captures generation/revision, selection identity and monotonic session
operation/IME version. The live App guard also invalidates on tab switches (even a
switch away and back), modal/file workflow changes and window blur. Checks repeat
after extraction and clipboard I/O. A per-session in-flight guard refuses overlapping
clipboard actions. Cut writes first, then revalidates and submits existing selection
deletion through the session queue. DOCX DeleteSelection optionally carries the
original anchor/focus keys, checked under the backend model lock immediately before
deletion; ordinary IME DeleteSelection remains unchanged. RHWP uses its existing
mutation/commit path and original history policy. General RHWP Undo/Redo stays gated.

DOCX `docx_selection_text` is a fixed session/generation/revision/selection endpoint,
with no path or arbitrary command. It validates paragraph ranges in one container
(body or a single top-level cell), UTF-8 boundaries, objects and size before using
WordCraft's read-only `copy_range().clipboard_text()` serializer. It never runs the
engine's internal Copy/Cut/Paste or changes clipboard history. The view exposes only
a support boolean; its 500-character preview is never a clipboard source.

RHWP uses complete scalar-indexed text ranges from one section/body or one cell,
including backward and multi-paragraph selections. Control inventory is required:
paragraphs containing fields/objects/tables are conservatively refused, apart from
section/column metadata. Missing APIs, nested/cross-context ranges and inconsistent
lengths fail closed. Metadata is bounded at 2 MiB. Both formats limit one clipboard
action to 1,048,576 Unicode scalars, never truncate; DOCX additionally caps source
selection scanning at 4 MiB UTF-8 including separators. Plain text rejects control
characters other than CR/LF/tab, object placeholders and isolated surrogates.

DOCX insertion retains textOps chunking, normalized breaks, tabs and chain rejection.
RHWP normalizes CRLF/CR/LF/U+2029, inserts each line and calls the existing body/cell
paragraph split operation between lines within one mutation/revision. A literal LF
passed to insertText is not used as a paragraph boundary. T009 serialization,
preservation, publication and recovery checks are unchanged. Rich text, HTML/RTF,
whole tables, objects and images remain outside this contract.

Regression sources: `src/commands/clipboard.test.ts`,
`src/components/Editor/clipboardSessions.test.ts`, WordCraft Rust adapter tests,
`scripts/tests/clipboard.wasm.test.ts` and `scripts/tests/native-clipboard.py`.
Native results must be reported separately from mocked API/session tests.

Identified Mod+C/X/V chords marked composing/keyCode229 are canceled without
execution, so they cannot fall through to browser clipboard defaults. Native
paste/beforeinput/input also refuse unsettled IME (including provisional/final
commit waiting), protected and unloaded targets. Native paste is synchronous input,
so previously queued ordinary typing can retain its original order; async command
paste requires a settled queue before reading. Blocking paste never settles an IME
transaction on behalf of the input method. Regression cases retain the final text
and revision assertions after an actual compositionend, plus rejection assertions
before that end. A missing browser read/write API disables its commands; access
failure remains an execution error.

Linux acceptance: the final native harness passed 70 checks across DOCX/HWP/HWPX,
including a separate X11 process owning the clipboard, trusted chords/ribbon, >500 Unicode scalars, paragraph/tab
roundtrip, empty clipboard, ribbon focus, injected write denial preserving the
actual engine model, actual delayed native reads during document switching, protected DOCX Copy, T009 Cut and
Paste saves, and independent final saved-byte reopens. Intermediate Cut saved
bytes also independently reopened empty in all three formats. Evidence is under
ignored `target/clipboard/`; fault injection is not an OS permission-denial test.
Real Korean IME interaction with clipboard during active preedit was first BLOCKED
(SetGlobalEngine timeout: the launcher disabled the IBus config component and
ibus-engine-hangul exits without it). It now passes natively for DOCX/HWP/HWPX with
genuine ibus-hangul preedit via `scripts/tests/native-ibus-session.py` and
`scripts/tests/native-clipboard-preedit.py`; see `clipboard-preedit-acceptance.md`
for observed orderings, classification and limits. Actual OS settings denial
and Windows/macOS acceptance are NOT RUN. An independent X11
clipboard-owner probe additionally passed keyboard and ribbon Paste for all three
formats (20 checks). Native external/dialog textarea shortcuts and modal blocking
were exercised separately, including a delayed GTK read canceled by a real App
modal. These are distinct from unit tests and injected OS-denial claims.

The native lifecycle follow-up also passed an actual X11 focus switch away and
back during a delayed clipboard read (trusted window blur recorded, no insertion).
A previous proxy disconnect and Xvfb PointerRoot focus-query error were harness/
environment failures, retained separately from accepted results. Final relevant
native evidence: `target/clipboard/native-external-full` (70 checks),
`native-x11-final` (20), `native-lifecycle-pass` (16); blocked preedit attempt: `native-ime`;
native preedit acceptance: `target/clipboard-preedit/run4` (174 checks).
No T010 D2/D4 or unrelated existing acceptance is promoted by clipboard results.

Clipboard hardening (2026-11-10). P1 native preedit acceptance is recorded in
`clipboard-preedit-acceptance.md`; P2/P3 are separate:

- **Paste capability off Linux (P2-A).** `clipboardAccessAvailable("edit.paste")` used to be true in
  any Tauri host. The GTK read bridge exists only for `target_os = "linux"`; every other target
  answers `Unsupported`. Paste is now available when the Linux bridge applies or the browser
  `readText` exists. "Linux bridge" means Tauri plus a desktop-Linux user agent: Tauri on Linux is
  always WebKitGTK, and Android is excluded. A runtime `Unsupported` answer is remembered. Hosts
  without the bridge call `navigator.clipboard.readText()` directly inside the gesture, with no IPC
  await in front of the permission-gated read. Availability only checks that an API exists;
  permission denial stays an execution failure. Tests: `src/commands/clipboardAccess.test.ts`.
  Windows/macOS native acceptance: NOT RUN.
- **Large selections (P2-B).** RHWP `snapshot()` ran the full selected-text extraction twice per
  call, and every ribbon command button calls it on each render. On the Release WASM, 40 snapshots
  took 377 ms (200×500 characters) and 1069 ms (200k-character paragraph). Availability is now
  proved once per clipboard key (epoch, generation, committed revision, model version,
  clipboard/IME epochs, anchor, caret) and text object. Only the boolean is cached. Copy/Cut still
  extract and validate afresh when executed. After the fix: 13 ms and 28.5 ms, i.e. one extraction
  per real change (`scripts/tests/clipboard-selection-cost.wasm.test.ts`, with invalidation and
  fresh-execution assertions). DOCX was measured and left unchanged. Its availability proof runs
  once per backend view, not per render, and costs 1.8–2.4 ms against a 496–687 ms view generation
  (Release, `#[ignore]` test `clipboard_availability_cost_relative_to_view`).
- **Native vs command Paste (P3-A).** The difference is intentional. Native Paste
  (paste/beforeinput/input) is synchronous input on the same path as ordinary typing, so it keeps
  queue order with pending typing and is accepted during an outstanding commit or save, exactly
  like typing. T009 binds a save to its revision. Command Paste reads asynchronously and revalidates
  ownership/revision afterwards, so it requires a settled, non-saving state. Both refuse unsettled
  IME, protected/read-only targets and modals; tab/session changes cancel command Paste through
  ownership. Tests: `src/components/Editor/nativePastePolicy.test.tsx` (both engines: pending, save
  in progress with parity to typing, protected, IME). No product change.
- **GTK read size (P3-B).** GTK3 has no streaming or size-limited selection transfer. GDK receives
  the whole payload (including X11 INCR) and converts it before the callback, so the 4 MiB /
  1,048,576-scalar limit bounds what the app keeps and uses, not GTK's transient allocation.
  Measured natively (`scripts/tests/native-clipboard-limits.py`, app `343b1456`, 12/12 PASS): exact
  scalar and byte boundaries accepted, one over refused `TooLarge`, and a refused 12 MiB payload
  raised peak RSS by about 18 MiB, released afterwards. A 7 s owner times out at 5.0 s as
  `Unavailable` without blocking the UI, a vanished owner gives `Unavailable`, and no owner reads
  as empty. Rust exact-boundary unit test added; limits unchanged. Residual risk: a hostile local
  clipboard owner can make GTK allocate payload-sized memory transiently.

## 핵심 삽입 명령 — 2026-11-10

`insert.table`, `insert.image`, `paragraph.bullets`는 capability→활성 세션→기존 변경 queue로 연결했다. 실제 엔진 기능과 DOCX/HWPX 저장 계약, 선택 제한, 비활성 HWP 경계 및 최신 검증 결과는 [핵심 삽입 기능](core-insertions.md)을 따른다. T010 전체 상태나 RHWP 일반 Undo/Redo 판정은 변경하지 않는다. Linux native GUI 수용은 NOT RUN이다.
