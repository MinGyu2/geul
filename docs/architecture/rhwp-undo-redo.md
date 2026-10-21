# rhwp 실행 취소·다시 실행 계약 (T010 Phase 1 설계, 2026-10-21)

T010 SC-003의 rhwp 몫(실행 취소·다시 실행)을 어떻게 통합할지 정하는 **설계 문서**다. 이 문서는 아무것도 구현하지 않는다:
레지스트리의 `edit.undo`·`edit.redo`는 rhwp에서 계속 `unsupported`이고, T010 완료 상태와 T011 선행 조건은 그대로다
([tasks.md](../planning/tasks.md)). 근거는 Phase 0 PoC(`tests/poc/t010-phase0/`, [README](../../tests/poc/t010-phase0/README.md))와
고정 rhwp `1a76570`(v0.8.7) 소스다. 문장마다 근거의 강도를 붙인다: **VERIFIED**(실행한 시험·읽은 코드), **INFERRED**(근거에서
추론), **UNVERIFIED**(아직 근거 없음).

## 1. 고른 구조와 근거

**고른 구조: 엔진 스냅숏 기반 기록, 세션이 ID와 트랜잭션 경계만 조정한다.**

- 문서 내용과 스냅숏 내용은 rhwp WASM 문서(`HwpDocument`)가 가진다. 세션(`RhwpEditorSession`)은 스냅숏 **ID**, 그 시점의 커서·선택,
  논리 트랜잭션 경계만 든다. 앱에 두 번째 문서 모델은 생기지 않는다.
- 실행 취소 = "이 트랜잭션 전" 스냅숏으로 복원. 다시 실행 = 실행 취소 직전에 찍은 "이 트랜잭션 뒤" 스냅숏으로 복원.

근거:

| 사실 | 강도 | 근거 |
|------|------|------|
| 복원은 넣기·나누기·합치기·지우기·셀·서식 뒤에도 본문·런·셀·컨트롤·쪽 수를 처음과 같게 되돌린다(HWP·HWPX) | VERIFIED | Phase 0 A1–7, `evidence/phase0-summary.json` |
| 복원 뒤 내보내기 바이트가 편집 전 내보내기와 같고 T009 판정이 safe, 실제 `service::save`도 게시한다 | VERIFIED | Phase 0 A6, Stage A `hwp/hwpx-italic-restored`(`evidence/save-service.json`) |
| 5개 시점 스냅숏을 섞은 순서로 복원해도 각 시점과 같다 | VERIFIED | Phase 0 A |
| 없는·버린 ID 복원은 오류이고 문서가 그대로다 | VERIFIED | Phase 0 A(`스냅샷 N 없음`) |
| 상한은 `MAX_SNAPSHOTS = 100`, `snapshotCapacity()`가 그 값. 넘치면 **가장 오래된 것을 알림 없이** 지운다 | VERIFIED | `document_core/commands/document.rs` `save_snapshot_native`, Phase 0 B4 |
| 복원은 문서를 통째로 바꾸고 `rebuild_derived_state`(실패를 돌려주지 않음)를 부른다. 그 안의 패닉은 WASM trap이 된다 | VERIFIED(코드)·UNVERIFIED(trap 뒤 모듈 상태) | `restore_snapshot_native` |
| `saveSnapshot`은 찍기 전에 `flush_cell_format_vpos`(미뤄 둔 셀 줄 위치 갱신)를 한다 | VERIFIED(코드) | `save_snapshot_native` |
| 엔진은 기록(실행 취소 스택)을 갖지 않는다. 기록은 rhwp studio 화면 코드가 만든다 | VERIFIED | [command-registry.md](command-registry.md) B(rhwp) |

## 2. 버린 대안과 이유

| 대안 | 판정 | 이유 |
|------|------|------|
| 앱이 역연산(넣기↔지우기, 서식 되돌리기)을 기록 | 버림 | 엔진 연산의 역이 엔진 계약에 없다(표 나누기·문단 합치기·서식의 모양 재사용·`attr` 갱신 등은 엔진만 안다, Phase 0 D). 앱이 편집 의미를 다시 구현하는 두 번째 모델이 된다. 회귀 위험이 가장 크다. |
| 내보낸 바이트를 기록으로 쓰기 | 버림 | 큰 HWP 내보내기 ≈1.5초·다시 열기 ≈1.1초(VERIFIED, Phase 0 G). 직렬화 손실 보고가 끼고, 다시 연 문서는 같은 모델이 아니다(엔진 파생 상태·그림 신원 세대). |
| 혼합(타자는 역연산, 나머지는 스냅숏) | 지금은 버림, 재설계 후보 | 타자 경로의 성능 문제가 측정으로 드러나기 전에는 복잡도만 늘린다(§10 재설계 조건). |
| 엔진이 기록을 갖도록 rhwp를 고침 | 이 작업 밖 | submodule을 고치지 않는다. 엔진이 기록 API를 내면 이 설계를 다시 본다(§12). |
| **스냅숏 기반, 세션이 ID만 조정** | **고름(조건부)** | 위 1장. 조건: §5 할당 순서, §10 깊이 제한, §11 시험. |

## 3. 트랜잭션 상태 모델

세 단계를 구별한다(같은 말을 섞지 않는다):

- **임시 조합 변경**: 조합 갱신(`updateComposition`)이 모델을 바꾸지만 세지 않는 변경. 기록 단계가 아니다.
- **끝난 논리 편집**: 세션이 `recordMutation()`으로 변경 1개를 센 순간. 기록 단계 하나가 이때 확정된다.
- **확정된 백엔드 revision**: `commit` 응답이 받은 revision. 기록과 무관하게 단조 증가한다.
- **저장된 상태**: `finish_save`가 `clean_revision`을 정한 판(내구성 확인 시).

세션의 기록 상태(설계, 구현하지 않음):

```text
HistoryEntry  = { before: SnapshotId, after: SnapshotId | null, caretBefore, anchorBefore, caretAfter, anchorAfter }
RhwpHistory   = { undo: HistoryEntry[], redo: HistoryEntry[], open: OpenTxn | null, live: Set<SnapshotId>,
                  capacity: number, depthLimit: number, state: "ok" | "limit" | "broken" }
OpenTxn       = { before: SnapshotId, caretBefore, anchorBefore, kind: "typing" | "composition" | "other" }
```

규칙:

1. 트랜잭션은 **모델을 바꾸는 첫 엔진 호출 직전에** 연다: `before = saveSnapshot()`(§5 할당 순서를 거친다). 이동·선택·클릭은 열지 않는다.
2. 트랜잭션은 그 편집이 `recordMutation()`으로 세질 때 닫혀 `undo`에 들어간다. 이때 `redo`를 모두 버린다(§5 정리).
3. 세지 않고 끝난 트랜잭션(모델이 결국 그대로)은 `before`를 버리고 기록에 넣지 않는다.
4. 엔진 예외로 끝난 트랜잭션(`mutate`의 catch → `uncertain`)은 기록에 넣지 않는다. 편집이 멈추므로 기록도 쓸 수 없다(§9).

## 4. 스냅숏 소유와 자원 수명주기

| 대상 | 소유자 |
|------|--------|
| 문서 내용·스냅숏 내용 | rhwp `HwpDocument`(엔진). 문서를 `free()`하면 그 스냅숏도 함께 사라진다(엔진 객체의 필드, VERIFIED 코드). |
| 실행 취소·다시 실행 스택, 스냅숏 ID, 살아 있는 ID 집합 | 그 문서를 연 `RhwpEditorSession`의 `RhwpHistory` 하나(문서 하나, 불러오기 세대 하나에 묶임). |
| 커서·선택 체크포인트 | 같은 `HistoryEntry`(세션 좌표 `DocPosition`). |
| 트랜잭션 경계 | 세션(`mutate`·조합 메서드가 연다·닫는다). |
| revision·dirty | 백엔드 `SessionRegistry`만(§7). 기록은 revision을 세지 않는다. |
| 정리 | 다시 불러오기·닫기·문서 교체(`load`·`dispose`)가 기록을 버린다: 살아 있는 ID를 `discardSnapshot`한 뒤(또는 곧 `free()`될 문서면 버리기만) 스택을 비운다. |

**이 세션이 그 문서의 유일한 스냅숏 호출자여야 한다**(다른 코드가 `saveSnapshot`을 부르면 살아 있는 ID 수가 어긋난다). Phase 2는 이것을
`RhwpDocument` 타입 경계에서 한 곳으로 모아 지킨다.

[command-registry.md](command-registry.md)와의 정합: 지금 문서는 "기록은 엔진이 가진다, 앱은 기록을 따로 두지 않는다"(WordCraft)와
"rhwp는 엔진 기록이 없어 `unsupported`"를 적는다. 바꿀 최소한은 rhwp 행 하나다: "rhwp의 기록 **내용**(스냅숏)은 엔진이 갖고, 세션은 그
ID·경계·커서만 조정한다(문서 모델은 하나)". `DocumentCommandSnapshot.history`의 뜻(엔진 기록에서 알 수 있는 단계)은 rhwp에서 "세션이
가진 살아 있는 스냅숏 단계"가 된다. 이 문서 갱신은 Phase 2에서 구현과 함께 한다(지금은 바꾸지 않음).

## 5. 실행 취소·다시 실행 전이와 할당 순서

### 할당 순서(참조 중인 스냅숏을 엔진이 지우지 않게)

엔진은 넘칠 때 알림 없이 가장 오래된 것을 지운다(VERIFIED B4·B8). 지운 뒤 알아낼 방법에 기대지 않는다. 그래서 **찍기 전에** 자리를 만든다:

```text
reserve(n):                       # n = 이번에 새로 찍을 스냅숏 수(1, 실행 취소는 after까지 1)
  cap = doc.snapshotCapacity()    # 매 문서 열 때 읽는다(고정 판이 바뀌면 값도 바뀐다)
  limit = min(cap - HEADROOM, depthLimit)          # HEADROOM = 2
  while live.size + n > limit:
    if undo 비었고 redo 비었음: state = "limit"; return false   # 남는 자리가 없음 → 기록 없이 편집(§9)
    가장 오래된 undo 항목(없으면 가장 먼 redo 항목)을 꺼내 before·after를 discardSnapshot, live에서 뺀다
  return true
```

- 근거: 여유 2(studio와 같은 예산 98)로 ≈300단계 흉내에서 최대 살아 있는 ID 99, 참조 중인 스냅숏이 모두 복원됨(VERIFIED B).
  여유 0이면 최대 101 → 엔진이 지움(VERIFIED B, REFUTED 줄). 100개가 살아 있을 때 실행 취소의 after 저장이 가장 오래된 참조를 지움(VERIFIED B8).
- 100은 기록 깊이가 아니다: 실행 취소 스택·다시 실행 스택·열린 트랜잭션·실행 취소 중 after가 같은 상한을 나눈다. 큰 문서에서는 §10
  `depthLimit`이 먼저 걸린다.
- 버린 ID·닿을 수 없게 된 ID(다시 실행을 버린 새 편집, 깊이 초과로 밀려난 항목)는 그 자리에서 `discardSnapshot`한다(살아 있는 수가 실제와 같게).

### 전이

| 사건 | 동작 |
|------|------|
| 바꾸는 편집 시작(열린 트랜잭션 없음) | `reserve(1)` → `before = saveSnapshot()`, 커서·선택 기록 |
| 이어 치기(같은 문단, 바로 뒤 자리에 넣기만) | 열린 타자 트랜잭션을 이어 쓴다(새 스냅숏 없음). 이동·지우기·나누기·명령·조합 시작·포커스 이동·저장 시작이 끊는다 |
| 편집이 세짐 | 항목을 `undo`에 넣고 `redo`의 ID를 모두 버림 |
| 실행 취소 | 거절 조건(§6) 확인 → `reserve(1)` → `after = saveSnapshot()` → `restoreSnapshot(before)` → 항목을 `redo`로. 변경 1개로 센다(§7) |
| 다시 실행 | 거절 조건 확인 → `reserve(1)` → `before' = saveSnapshot()` → `restoreSnapshot(after)` → `after`를 버리고 항목(`before'` 갱신)을 `undo`로. 변경 1개 |
| 다시 불러오기·닫기·문서 교체 | 열린 트랜잭션 포함 모두 버림(§4) |

다시 실행에서 `before'`를 새로 찍는 이유: 복원한 상태가 원래 `before`와 같다는 증거는 바이트 비교뿐이고(Phase 0 A6) 그것을 매번 하지
않는다. 원래 `before`를 그대로 다시 쓰는 최적화는 Phase 2 시험으로 같음이 확인되면만 허용한다(INFERRED 가능, UNVERIFIED).

### 편집별 기대(C2)

| 편집 | 기록 |
|------|------|
| 1. 글자 하나 | 단계 1 |
| 2. 이어 치기 | 끊길 때까지 단계 1(WordCraft 타자 묶기와 같은 사용자 의미) |
| 3. Backspace·Delete | 연속 지우기는 같은 방향이면 단계 1, 넣기로 바뀌면 끊김. 문맥 처음의 Backspace·끝의 Delete는 `mutate`를 부르지 않으므로(VERIFIED 코드) 트랜잭션도 열리지 않고 단계 없음 |
| 4. 선택 바꾸기(선택 위에 치기) | 지우기+넣기가 단계 1(before = 지우기 전) |
| 5. 문단 나누기·합치기 | 각각 단계 1(타자를 끊는다) |
| 6. 표 셀 편집 | 셀 안 넣기·지우기도 같은 규칙. 셀 사이 이동은 끊는다 |
| 7. 한국어 조합 완료 | `beginComposition` 직전(선택 지우기 전)에 열고, 조합이 세질 때(끝·provisional 해결) 단계 1. 갱신 동안은 세지 않음(VERIFIED C2) |
| 8. 선택 없이 조합 취소 | 세지 않음(VERIFIED C3: 확정 0개) → before 버림, 단계 없음 |
| 9. 선택 지운 뒤 조합 취소 | 지우기 1개가 세짐(VERIFIED C4) → 단계 1, before = 지우기 전이므로 실행 취소가 지운 글자를 되살린다(지우기를 말없이 잃지 않음) |
| 10. provisional 뒤 늦은 최종 글자 | `resolveProvisional`/`settleProvisional`이 셀 때 닫는다(VERIFIED C6: 확정 1개). 기다리는 동안은 열린 채 |
| 11. 실행 취소 뒤 새 편집 | 새 단계 1, 다시 실행 버림 |
| 12. 다시 불러오기·닫기·교체 | 기록 모두 버림(VERIFIED C8: 새 문서·세대, 늦은 옛 응답 버림) |

## 6. IME 트랜잭션 처리

- 실행 취소·다시 실행은 `imeUnsettled`(조합 중, provisional, 최종 글자 기다림) 동안 **거절**한다. 지금 가용성 함수가 이미
  `composing`으로 막는다(`capability.ts`, VERIFIED 코드). 세션의 `execute`도 같은 함수로 다시 확인한다.
- 조합 트랜잭션은 끝날 때까지 열린 채 둔다. 복원은 조합 중에 일어나지 않으므로 `ReplaceInserted`·provisional 고치기가 가리키는 자리
  (`composition.anchor`)가 복원으로 무효가 되지 않는다.
- 복원 뒤 세션은 `composition = null`, `provisional = null`임을 확인하고(거절 조건 덕분에 항상 참이어야 함, 아니면 내부 오류로 실패 처리)
  커서를 항목의 체크포인트로 둔다. 체크포인트가 복원한 문서에서 범위를 벗어나면 문서 처음으로 접는다(엔진 질의로 확인).
- 늦은 최종 글자가 실행 취소 **뒤**에 오는 경우는 생기지 않는다: 최종 글자를 기다리는 동안은 `composing`이라 실행 취소가 거절된다.
  닫기·다시 불러오기가 IME 세대를 무효화하는 기존 규칙은 그대로다.
- 검증은 두 층으로 한다(§11): 실제 WASM 세션 시험(Vitest, 세션 메서드 호출 — 입력기가 아님)과 실제 앱의 네이티브 ibus-hangul
  WebDriver 시험. **흉내 시험은 네이티브 IME와 같지 않다**: 이벤트 순서(입력기가 먼저 확정한 뒤 Ctrl·Z keydown 등)는 네이티브에서만 본다.

## 7. 백엔드 revision·dirty 통합

지금 동작(VERIFIED 코드): `SessionRegistry.commit(base, count)`는 revision을 `base + count`로 올린다(단조). `dirty = revision !=
clean_revision || unconfirmed`. 세션은 `pending`(보낼 변경 수)을 `flushCommits`로 보낸다.

계약:

- 실행 취소·다시 실행 하나는 **변경 1개**다: 성공한 복원 뒤 `recordMutation()` → `pending += 1` → 기존 확정 경로. 두 번째 revision 계수기를
  두지 않는다.
- 실행 취소로 저장한 내용과 같아져도 dirty를 지우지 않는다: revision이 올라가 `revision != clean_revision`이다. 기록 위치가 저장 시점과
  같다는 이유로 dirty를 지우지 않는다. 세션 `modified`도 같은 이유로 남긴다(조합 취소 뒤 `modified`가 남는 지금의 보수적 정책과 같음,
  VERIFIED C3).
- 내용 기반 깨끗함 판정(저장한 판과 바이트 비교)은 별도 미래 기능이며 이 계약에 넣지 않는다.
- 저장 중 실행 취소: 저장은 시작할 때 모델을 내보낸다(`exportAndCompare`). 그 뒤의 실행 취소는 다른 편집과 같다 — `changedSince`가 참이
  되어 저장 뒤에도 수정됨으로 남는다(지금 규칙 그대로).
- 저장 뒤 실행 취소·다시 실행: 허용. revision +1, dirty. 저장한 파일은 바뀌지 않는다.
- 확정 실패: `handleBackendRejection`의 기존 처리(세션 만료면 정리, 그 밖은 편집 중지·불확실)를 따른다. 기록은 그 시점에 쓸 수 없게
  된다(편집이 멈추므로). 실패한 revision을 기록으로 되돌리려 하지 않는다.
- 늦은 응답·세대 변경: 기록은 지역 동작이라 백엔드 응답을 기다리지 않는다. 다시 불러오기는 기록을 버리고(§4) 옛 세대의 확정 응답은
  지금처럼 `owns(epoch)`로 버린다.
- 대기 중인 확정이 있어도 실행 취소를 허용한다: rhwp 모델은 지역에서 동기적으로 바뀌고 백엔드는 개수만 받는다. 그래서 rhwp의
  `queuedHistory`는 계속 `null`이고 `history`는 세션 스택에서 바로 정확히 안다(`unknown` 없음).

## 8. 저장 수명주기와의 관계

- T009 저장 규칙은 바꾸지 않는다. 기록은 저장 판정을 우회하지 않는다: 실행 취소한 모델도 같은 `exportAndCompare` → `service::save`를 거친다.
- 복원은 `lastRoundTrip`(이전 모델의 내보내기 검사)을 지운다(`mutate`와 같은 규칙). 사전 검사(`saveCheck`)는 **원본 파일**에 대한 것이라 복원으로
  지우지 않는다.
- 저장 차단(`saveBlocker`)은 그대로: 조합 중·대기 확정·불확실 모델이면 저장하지 않는다. 복원 실패로 불확실해진 모델은 저장할 수 없다.
- 서식 단계를 되돌린 출력은 지금도 저장된다(Stage A `*-italic-restored`: 원본과 같은 바이트로 게시, VERIFIED). 되돌리지 않은 HWPX 새 서식은
  지금 막힌다(header 변경). 서식 지원(Phase 3)은 이 기록 계약과 따로 판정한다.

## 9. 오류와 복구

| 실패 | 상태 전이 |
|------|-----------|
| 편집 전 `saveSnapshot` 예외 | 편집은 계속한다(타자를 기록 때문에 막지 않음). 기록을 모두 버리고 `state = "broken"`(이 문서에서 다시 쓰지 않음, 이유 `limit`). 엔진 예외가 문서 상태까지 의심하게 하면(UNVERIFIED) 보수적으로 `uncertain` 처리로 바꾼다 — Phase 2 시험으로 정함 |
| `reserve`가 자리를 못 만듦 | 이번 편집은 기록 없이, `state = "limit"`(남은 항목은 쓸 수 있음) |
| 복원할 ID가 없음 | 문서는 그대로(VERIFIED A). 그 항목과 그보다 오래된 항목을 버리고 이유를 알린다. revision 그대로 |
| `restoreSnapshot` 예외(그 밖) | 문서 상태를 알 수 없다고 본다: `uncertain = true`, `modelVersion += 1`, `failEditing()`(기존 fail-closed). 기록을 버린다 |
| 파생 상태 재구성 실패(trap) | 엔진이 결과를 돌려주지 않는다(패닉 → WASM trap). 모듈 전체를 쓸 수 없다고 보고 문서 실패로 처리. 엔진이 주지 않는 되돌림 보장을 만들지 않는다 |
| 복원 뒤 그리기 실패 | `mutate`와 같다: 변경은 모델에 있으므로 센 채로 `markFailed(render)` |
| 비동기 중 닫힘 | 기록 동작은 동기다. 닫힘(`dispose`) 뒤 들어온 명령은 `execute`가 `notReady`로 거절 |
| 늦은 불러오기 세대 응답 | 기존 `owns(epoch)`·세대 확인 그대로. 새 문서의 기록은 빈 상태에서 시작 |

성공한 복원 뒤 반드시: `modelVersion += 1`, `pages = readPages(doc)`, 그림 무효화(쪽 다시 읽기 → 캔버스 다시 그림), 커서·선택을 체크포인트로,
`preferredX = -1`, 기록 가용성 갱신(`emit`), `lastRoundTrip = null`. 그림 신원 세대는 엔진이 올린다(`bump_bin_data_epoch`, VERIFIED 코드).

## 10. 큰 문서 성능 정책

측정값(Phase 0 G, node + 고정 WASM, **UI 지연이 아님**):

| 문서 | 열기 | saveSnapshot p50/p95 | restoreSnapshot p50/p95 | 스냅숏당 메모리 |
|------|------|----------------------|-------------------------|-----------------|
| 생성 픽스처(13KB) | 2ms | 0.01/0.01ms | 0.34/0.37ms | 측정 안 됨(성장 0) |
| 실제 HWP 10.7MB(비공개, 재현 불가) | 1185ms | 24.6/30.4ms | 689/839ms | ≈8.3MB(WASM 메모리 상한선 증가로 어림) |
| 실제 HWPX 13.6MB(비공개, 재현 불가) | 966ms | 3.0/3.6ms | 622/660ms | 측정 안 됨(이미 늘어난 메모리 안, 0으로 보임) |

메모리 값은 `WebAssembly.Memory`의 늘어난 크기(줄지 않는 상한선)라 실제 살아 있는 바이트가 아니다. 엔진 API에 스냅숏 크기 질의가 없다
→ **바이트 예산을 정확히 지킬 수 없다**(VERIFIED API 목록). 복원은 스냅숏을 한 번 더 복제하므로(`snapshot_store[idx].clone()`) 복원 중
최고 메모리는 문서 ≈2개 분이 더 든다(VERIFIED 코드, 크기 UNVERIFIED).

정책(보수적 대체):

- `depthLimit = clamp(floor(BUDGET / estimate), 4, capacity - HEADROOM)`. `BUDGET` 기본 256MB(가정, Phase 2 측정으로 정함).
  `estimate = max(원본 파일 바이트 × 1, 첫 스냅숏 전후 WASM 메모리 증가)` — 측정이 0이면 파일 크기를 쓴다. 10.7MB HWP 예: 256/10.7 ≈ 23 스냅숏.
- 깊이가 4보다 작아야 하는 문서(파일 64MB 초과 등)는 기록을 `limit`으로 둔다(쓸 수 없음 이유를 보임).
- 타자 묶기로 스냅숏 수를 줄인다(트랜잭션마다 한 번, 글자마다가 아님). 큰 HWP에서 트랜잭션 시작마다 ≈25ms가 든다.

비교(성능이 구조를 바꾸는 경우만):

| 후보 | 정확성 | IME | 서식·표 | 메모리 | 응답성 | 복잡도·회귀 |
|------|--------|-----|---------|--------|--------|-------------|
| 전체 스냅숏(깊이 고정 100) | 높음 | 경계만 맞으면 안전 | 엔진이 처리 | 큰 문서에서 GB 단위(INFERRED) | 실행 취소 ≈0.7초 | 낮음 / 메모리 위험 |
| **전체 스냅숏 + 크기 기반 깊이**(고름) | 높음 | 같음 | 같음 | 예산 안(어림) | 같음 | 낮음 |
| 역연산 | 엔진 의미 재구현 필요 | 조합 고치기와 충돌 위험 | 서식·표 역이 없음 | 작음 | 빠름 | 높음 |
| 혼합 | 경로마다 다름 | 경로 경계가 늘어남 | 스냅숏 쪽 | 중간 | 타자만 빠름 | 높음 |

벤치마크 계획(Phase 2, 실제 WebView 포함): 작은 문서, 큰 HWP, 큰 HWPX 각각 — 실행 취소·다시 실행 20회 반복의 p50/p95(엔진 호출과
그리기까지 화면 기준), 1분 연속 타자 중 키 하나당 지연 p95, 트랜잭션 시작 비용, 최고 WASM 메모리와 프로세스 RSS, 깊이 한도까지 채운 뒤
메모리. 큰 문서는 저장소에 넣지 않으므로 파일 크기·해시·쪽 수만 기록한다.

재설계 조건: WebView에서 실행 취소 p95 > 1.5초, 타자 키 지연 p95 > 50ms가 트랜잭션 시작 때문일 때, 예산 안 깊이가 4 미만인 문서가
대상 문서군에 흔할 때, 고정 rhwp가 상한·넘침 동작을 바꿀 때, 엔진이 기록·역연산 API를 낼 때.

## 11. 미래 시험 표

| 층 | 시험 | 진짜 엔진? |
|----|------|------------|
| 실제 WASM 세션(Vitest) | §5 편집별 기대 12가지 각각: 실행 취소·다시 실행 뒤 문서 글·런·셀·쪽 수가 그 시점과 같음, revision +1, `modified` 남음 | 진짜 WASM, 백엔드는 시험 응답 |
| 실제 WASM 세션 | 할당: 깊이 한도·여유 2에서 300단계 무작위 실행 취소·다시 실행·새 편집 → 살아 있는 ID ≤ capacity−2, 참조 중인 ID가 모두 복원됨, 버린 ID는 0 | 진짜 WASM |
| 실제 WASM 세션 | 실패 주입: saveSnapshot·restoreSnapshot 예외(감싼 문서), 없는 ID, 복원 뒤 그리기 실패 | 진짜 WASM + 주입 |
| 실제 WASM 세션 | IME: 조합 중·provisional·최종 글자 기다림 동안 실행 취소 거절, 선택 지운 뒤 취소의 실행 취소가 지운 글자를 되살림 | 진짜 WASM, 세션 메서드(입력기 아님) |
| 백엔드(Rust) | 실행 취소 확정의 revision·dirty: 저장 → 실행 취소 → dirty, 저장 중 실행 취소 → `changedSince` | 진짜 SessionRegistry |
| T009 | 실행 취소한 출력의 `service::save`(Stage A `*-restored`처럼), 서식 단계 되돌림 | 진짜 서비스 |
| 네이티브 앱(WebDriver + ibus-hangul) | 조합 중 Ctrl+Z(입력기 확정 뒤 keydown 순서), 확정 뒤 Ctrl+Z·Ctrl+Y, 다시 불러오기·닫기 뒤 기록 비움 | 진짜 앱·입력기 |
| 성능 | §10 벤치마크 | 진짜 WebView |

## 12. 열린 질문과 구현 관문

열린 질문:

1. `saveSnapshot`의 `flush_cell_format_vpos`가 편집 없는 내보내기 바이트를 바꾸는가(표 셀 서식 뒤). Phase 2 시험: 찍기 전후 내보내기 비교.
2. `restoreSnapshot` 패닉(trap) 뒤 같은 모듈의 다른 문서를 쓸 수 있는가. 지금은 쓸 수 없다고 본다.
3. 스냅숏 크기의 실제 값(살아 있는 바이트). API가 없어 어림만 한다.
4. 커서 체크포인트가 복원 뒤 언제나 올바른 자리인가(표 구조가 바뀐 단계).
5. 다시 실행에서 원래 `before`를 재사용해도 되는가(§5).

Phase 2 구현을 시작하기 전 관문: 이 문서의 검토 승인, 위 1·4의 짧은 PoC, `RhwpDocument` 타입에 스냅숏 4개 함수 추가 범위 확정.
명령 활성화(Phase 4) 관문: §11 표 전부 통과, 네이티브 ibus-hangul 시험 통과, §10 벤치마크가 재설계 조건에 걸리지 않음.

## 13. 명령 레지스트리 통합(나중의 최소 변경, 지금 바꾸지 않음)

| 위치 | 변경 |
|------|------|
| `rhwpModule.ts` `RhwpDocument` | `saveSnapshot(): number`, `restoreSnapshot(id): string`, `discardSnapshot(id): void`, `snapshotCapacity(): number` |
| `RhwpEditorSession.snapshot()` | `history: state === "broken" ? null : { undo: undo.length > 0, redo: redo.length > 0 }`, `queuedHistory: null` 유지 |
| `RhwpEditorSession.execute()` | `edit.undo`·`edit.redo`를 받아 같은 가용성 함수로 다시 확인한 뒤 실행 |
| `DocumentCommandSnapshot` | 기록이 한도로 쓸 수 없음을 알릴 값 하나(예: `historyLimited: boolean`) — `limit` 이유를 보이기 위해. 아니면 `history: null` + 기존 `engineUnsupported`가 사실과 다르게 보임 |
| `capability.ts` | `history: null`이고 `historyLimited`면 `limit`, 아니면 `engineUnsupported` |
| `registry.ts` | Phase 4에서만 rhwp `edit.undo`·`edit.redo`를 `SUPPORTED`로 |

가용성 이유 대응: 쓸 수 있음(`available`), 되돌릴 것 없음(`nothingToUndo`), 다시 할 것 없음(`nothingToRedo`), IME 트랜잭션
진행 중(`composing`), 대기·불확실(rhwp는 대기 확정에 막히지 않음; 불확실 모델은 `editable=false` → `notReady`), 준비 안 됨(`notReady`),
확인된 한도(`limit`), 모달(`dialogOpen`).

## Phase 2–4 순서

자세한 관문과 시험은 [tests/poc/t010-phase0/README.md](../../tests/poc/t010-phase0/README.md)의 "다음 단계"에 적는다. 요약:
Phase 2(이 계약으로 rhwp 실행 취소 구현) → Phase 3A(T009 글자 모양 참조 무결성 — 지금 HWPX의 없는 `charPrIDRef`가 실제 저장 서비스를
통과해 게시된다, VERIFIED Stage B) → Phase 3B(HWPX 서식과 좁은 header 보존 규칙) → Phase 3C(HWP 서식은 미리보기·모양 재사용과 따로 평가)
→ Phase 4(검증한 rhwp 명령만 켜고 T010 수용 기준 마무리). HWPX가 되어도 HWP 서식이 준비된 것으로 보지 않는다.
