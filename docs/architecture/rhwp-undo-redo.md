# rhwp 실행 취소·다시 실행 계약 (T010 Phase 1 설계 2026-10-21 · 고침 2026-10-22 · Phase 2 구현 2026-10-22)

T010 SC-003의 rhwp 몫(실행 취소·다시 실행)의 계약이다. Phase 2(2026-10-22)에 이 계약대로 세션 기록을 구현했다(맨 아래 "Phase 2 구현").
레지스트리의 `edit.undo`·`edit.redo`는 rhwp에서 아직 `unsupported`이고(활성화 관문 미통과), T010 완료 상태와 T011 선행 조건은 그대로다
([tasks.md](../planning/tasks.md)). 근거는 Phase 0 PoC(`tests/poc/t010-phase0/`, [README](../../tests/poc/t010-phase0/README.md))와
고정 rhwp `1a76570`(v0.8.7) 소스다. 근거의 강도: **VERIFIED**(실행한 시험·읽은 코드), **INFERRED**(근거에서 추론), **UNVERIFIED**.

2026-10-22 고침(검토 지적 다섯 가지): ① 할당이 대기 중인 실행 취소의 대상을 지울 수 있었다(§5, 반례 재현) ② `recordMutation()`마다 단계를
닫는 규칙과 타자 묶기가 모순이었다(§3·§6) ③ 깊이 식의 clamp가 "4 미만이면 끔"을 막았다(§10) ④ `saveSnapshot` 예외를 무해하다고
보았다(§9) ⑤ 다시 실행이 할당하는 구조였다(이제 할당하지 않음, §5). 고친 알고리즘은 시험 전용 모델 `tests/poc/t010-phase0/history_model.mjs`로
실제 WASM에서 실행했다(§11).

## 1. 고른 구조와 근거

**엔진 스냅숏 기반 상태 시간선, 세션은 ID·커서·그룹 경계만 조정한다.** 문서 내용과 스냅숏 내용은 rhwp `HwpDocument`가 가진다. 세션에는
두 번째 문서 모델이 생기지 않는다.

| 사실 | 강도 | 근거 |
|------|------|------|
| 복원은 넣기·나누기·합치기·지우기·셀·서식 뒤에도 본문·런·셀·컨트롤·쪽 수를 그 시점과 같게 한다(HWP·HWPX) | VERIFIED | Phase 0 A1–7 |
| 복원 뒤 내보내기 바이트가 같고 실제 `service::save`가 게시한다 | VERIFIED | Phase 0 A6, Stage A `*-restored` |
| 상한 `MAX_SNAPSHOTS = 100`(`snapshotCapacity()`), 넘치면 **가장 오래된 것을 알림 없이** 지운다 | VERIFIED | `document_core/commands/document.rs` `save_snapshot_native`, Phase 0 B4·B8 |
| `restoreSnapshot`은 저장소에서 찾은 스냅숏을 **복제**해 문서를 바꾼다: 쓴 스냅숏은 저장소에 남는다 | VERIFIED(코드)·VERIFIED(실행: 같은 ID를 200번 번갈아 복원) | `restore_snapshot_native` `snapshot_store[idx].clone()`, §11 |
| 없는 ID 복원은 문서를 바꾸기 전에 `스냅샷 N 없음` 오류(`position` 검색이 먼저) | VERIFIED | 같은 함수, Phase 0 A, §11 실패 주입 |
| `saveSnapshot`은 반환값이 `u32`뿐(Result 없음)이고, 복제 전에 `flush_cell_format_vpos`(미뤄 둔 셀 줄 위치 반영)로 **모델을 바꿀 수 있다** | VERIFIED(코드) | `save_snapshot_native` |
| 복원은 `rebuild_derived_state`(실패를 돌려주지 않음)를 부른다. 그 안의 패닉은 WASM trap | VERIFIED(코드)·UNVERIFIED(trap 뒤 모듈 상태) | `restore_snapshot_native` |

## 2. 버린 대안과 이유

| 대안 | 판정 | 이유 |
|------|------|------|
| 앱이 역연산을 기록 | 버림 | 엔진 연산의 역(표 나누기·문단 합치기·서식의 모양 재사용·`attr`)이 엔진 계약에 없다(Phase 0 D). 편집 의미를 다시 구현하는 두 번째 모델이 된다. |
| 내보낸 바이트를 기록으로 | 버림 | 큰 HWP 내보내기 ≈1.5초·다시 열기 ≈1.1초(Phase 0 G, 과거 측정). 다시 연 문서는 같은 모델이 아니다. |
| 혼합(타자는 역연산) | 지금은 버림, 재설계 후보 | §10 재설계 조건이 측정되기 전에는 복잡도만 늘린다. |
| 항목 {before, after} 스택(이전 판) | 고침 | 실행 취소마다 after를 찍고 다시 실행마다 before를 다시 찍어야 했고, 할당 규칙이 대상 항목을 지웠다(§5 반례). |
| **상태 시간선 + 끝에서만 지움**(고름) | 조건부 | §5. 실행 취소는 지금 상태를 처음 한 번만 찍고, 다시 실행은 할당하지 않는다. |

## 3. 세 가지 경계를 나눈다

| 경계 | 소유 | 언제 |
|------|------|------|
| **A. 백엔드 확정**(revision) | 지금 그대로: `mutate`·조합 정리가 `recordMutation()`을 부르면 `pending += 1` → `flushCommits` → `SessionRegistry.commit` | 세진 변경마다. 기록 때문에 늦추거나 합치지 않는다 |
| **B. 논리 기록 그룹**(실행 취소 한 단계) | 세션의 `RhwpHistory`(Phase 2) | 그룹 하나에 확정 여러 개가 들어갈 수 있다(이어 치기·이어진 조합) |
| **C. IME 조합 트랜잭션** | 지금 그대로: `composition`·`provisional` | 조합 시작부터 정리(`settleComposition`·`settleProvisional`)까지. 그 동안 실행 취소·다시 실행은 거절 |

이전 판 §3 규칙 2("세질 때 닫혀 undo에 들어간다")는 A와 B를 같게 만들어 이어 친 세 글자가 세 단계가 됐다(재현: `typing_groups.poc.test.ts`
"이전 설계 반례", 확정 3·단계 3). 고친 규칙: **세질 때는 열린 트랜잭션을 그룹으로 확정하되, 같은 그룹을 이어 쓸 수 있으면 새 단계를 만들지
않는다.** 그래서 확정 N개 → 단계 1개가 된다(VERIFIED, 이어 친 세 글자: 확정 3·단계 1·스냅숏 1).

그 그룹의 실행 취소는 엔진 복원 한 번이고, 세션은 그것을 **변경 1개**로 센다(`recordMutation()` → revision +1). 확정 N개를 되돌리는 데
revision을 N 줄이지 않는다(§7). — 실행 취소 쪽 revision +1은 제품 통합 전이라 INFERRED(지금 세션의 `mutate` 규칙과 같은 경로를 쓴다는 설계).

## 4. 상태 모델과 소유

```text
RhwpHistory (세션 하나 = 문서 하나 = 불러오기 세대 하나)
  states: (SnapshotId | null)[]   # 상태 시간선. null = 아직 찍지 않은 지금 상태
  cursor: number                  # 지금 문서가 states[cursor]
  pending: { captured, extending, kind, start } | null   # 열린 트랜잭션(바꾸는 엔진 호출이 시작됨, 아직 세지 않음)
  group:   { kind, end } | null   # 이어 쓸 수 있는 마지막 그룹
  limit:   number                 # 살아 있는 스냅숏 상한(§10)
  state:   "ok" | "broken"
  checkpoints: SnapshotId → { caret, anchor }   # 커서·선택(세션 좌표)
```

불변식(모델이 매 단계 확인, §11):

- **I1** `states[cursor]` 밖의 칸은 모두 ID를 가진다 → 닿을 수 있는 기록은 이어져 있다. 지울 때는 **양 끝에서만** 지운다.
- **I2** `live ≤ limit − (states[cursor] === null ? 1 : 0)` → 지금 상태를 찍을 자리가 언제나 하나 남는다(실행 취소가 할당 때문에 실패하지 않음).
- **I3** `limit ≤ snapshotCapacity() − HEADROOM(2)` → 엔진의 말없는 넘침 지우기가 일어나지 않는다. 이 세션이 그 문서의 **유일한** 스냅숏 호출자여야 한다.
- 논리 단계 수 = `cursor`(실행 취소 가능) + `states.length − 1 − cursor`(다시 실행 가능). 스냅숏 수는 `live`. 둘은 다르다: 끝에 있을 때
  단계 d개에 스냅숏 d개, 실행 취소한 뒤에는 단계 d개에 스냅숏 d+1개.

| 대상 | 소유자 |
|------|--------|
| 문서·스냅숏 내용 | 엔진(`HwpDocument`, `free()`하면 스냅숏도 사라짐) |
| 시간선·ID·커서 체크포인트·그룹 경계 | 세션의 `RhwpHistory` |
| revision·dirty | 백엔드 `SessionRegistry`만(§7) |
| 정리 | `load`(다시 불러오기·교체)·`dispose`(닫기): 참조 ID를 모두 버리고 시간선을 비운다 |

[command-registry.md](command-registry.md)와의 정합(바꿀 최소한, Phase 2에서): rhwp 행을 "기록 **내용**(스냅숏)은 엔진이 갖고 세션은 ID·경계·커서만
조정한다(문서 모델은 하나)"로. `DocumentCommandSnapshot.history`는 rhwp에서 세션 시간선에서 바로 정확히 안다(`queuedHistory: null` 유지).

## 5. 할당과 전이(사전·사후 조건)

`reserve(n, protect, order)` — 엔진 호출 **전에** 자리를 만든다.

- 사전: `protect`는 지울 수 없는 **스냅숏 ID** 집합(칸 번호가 아니다: 과거를 지우면 번호가 당겨진다 — 이 고침의 초안이 칸 번호로 보호하다
  대상을 놓친 결함을 시험 작성 중에 찾았다). `order`는 지울 방향(`past` = 가장 오래된 과거부터, `future` = 가장 먼 미래부터).
- 먼저 지울 수 있는 수(끝에서부터 보호된 ID를 만나기 전까지)를 센다. `live + n − limit`보다 적으면 **아무것도 지우지 않고** 거부한다.
- 사후: `live + n ≤ limit`, I1 유지, 보호 ID는 그대로, 지운 ID는 모두 `discardSnapshot` 했다.

| 전이 | 사전 | 동작 | 사후 |
|------|------|------|------|
| 편집 시작 `mutationStarting(kind, start)` | `pending === null`, `state ok` | 이어 쓸 수 있으면(§6) 아무것도 찍지 않는다. 아니고 `states[cursor] === null`이면 `reserve(1, ∅, [past])` → `states[cursor] = saveSnapshot()`(`captured`). 다시 실행 기록이 있으면 지금 상태는 이미 찍혀 있다(실행 취소가 찍음) | `pending` 열림. 다시 실행 기록은 아직 버리지 않는다(취소될 수 있음) |
| 세짐 `committed(end)` | `pending` | 새 그룹이면: 미래 ID를 모두 버림(`clearRedo`), `states.push(null)`, `cursor++`, `live > limit − 1`이면 가장 오래된 과거를 버림(깊이 초과). 이어 쓰기면 시간선 그대로 | `group = {kind, end}`, I1–I3 |
| 취소 `canceled()` | `pending` | 이 트랜잭션이 찍은 것만 버리고 `states[cursor] = null` | 시간선이 시작 전과 같다 |
| `clearRedo` | — | `states[cursor+1..]`의 ID를 버린다 | 미래 없음 |
| 실행 취소 `undo()` | `cursor > 0`, `pending === null`, IME 끝남(§6), `state ok` | 그룹 끊음. `states[cursor] === null`이면 `reserve(1, {states[cursor−1]}, [future, past])` → 지금 상태를 찍음. `restoreSnapshot(states[cursor−1])`, `cursor−−` | 다시 실행 1단계 생김. 대상은 지워지지 않았다 |
| 다시 실행 `redo()` | `cursor < states.length − 1`, 위와 같은 조건 | `restoreSnapshot(states[cursor+1])`, `cursor++`. **할당하지 않는다**(복원은 스냅숏을 남긴다, VERIFIED) | — |
| 닫기·다시 불러오기 `dispose()` | — | 참조 ID를 모두 버림(엔진이 trap 뒤면 버리지 않고 문서 `free()`에 맡김) | `states = [null]` |

방향 선택: I1·I2 아래에서 `states[cursor] === null`이면 미래가 없다(미래는 실행 취소가 지금 상태를 찍은 뒤에만 생긴다). 그래서 정상 상태의
실행 취소는 할당이 필요해도 **지울 필요가 없다**(I2). 지워야 하는 경우는 고정 엔진 판이 바뀌어 `snapshotCapacity()`가 줄었을 때 같은 경계뿐이며,
그때는 가장 먼 미래 → 가장 오래된 과거(대상 제외) 순으로 지우고, 그것도 없으면 **문서를 바꾸지 않고 거부**한다(`limit` 이유).

이전 판의 반례(VERIFIED, 실제 WASM): 이전 판 규칙("가장 오래된 undo 항목(없으면 가장 먼 redo 항목)을 지움")으로 상한 3에서 편집 2 → 실행 취소 2를
하면, 두 번째 실행 취소의 `reserve`가 되돌릴 항목 자신을 지운다. 같은 순서를 고친 알고리즘(스냅숏 3 = 깊이 2)은 처음 상태로 돌아간다.

최소 경계: 실행 취소 한 번에 스냅숏 2개(대상·지금)가 들므로 `limit ≥ 2`. 정책 최소 깊이는 4(§10), 즉 `limit ≥ 5`. 깊이 4·5에서 편집 10그룹 →
한도까지 실행 취소(정확히 4·5단계) → 모두 다시 실행이 각 시점의 글과 같다(VERIFIED §11).

## 6. 타자 그룹과 IME

트랜잭션 시작은 **바꾸는 첫 엔진 호출 직전**이다(세션의 `mutate`·`replaceComposition`·`resolveProvisional` 안, `this.text!.*` 호출 앞). 그래서
선택 지우기를 먼저 하는 조합 시작(`beginComposition`)도 지우기 전 상태가 before가 된다.

이어 쓰기 조건: 마지막 그룹이 있고(끊기지 않음), 종류가 같고 `typing`·`deleteBack`·`deleteForward` 중 하나이며, 이번 시작 커서가 그 그룹의
끝 커서와 같다. 끊는 것: 이동·클릭·선택 바꿈·포커스 이동·명령(서식·실행 취소·다시 실행)·문단 나누기/합치기·종류가 다른 편집·다시 불러오기.
선택이 있는 상태의 넣기·조합 시작은 시작 커서가 그룹 끝과 다르므로 새 그룹이다.

| 경우 | 기대(VERIFIED는 실제 WASM 세션 + 시험용 기록 감싸개, `typing_groups.poc.test.ts`) |
|------|------|
| 글자 하나 | 확정 1·단계 1, 실행 취소 → 처음 글 (VERIFIED) |
| 이어 친 글자 | 확정 3·단계 1·스냅숏 1 (VERIFIED) |
| 사이에 이동 | 단계 2 (VERIFIED) |
| 선택 바꾸기 + 이어 치기 | 확정 2·단계 1, 실행 취소 → 선택 지우기 전 글 (VERIFIED) |
| 문단 나누기 | 끊음: a·나누기·b = 단계 3·확정 3 (VERIFIED) |
| Backspace 연속 | 넣기와 다른 그룹, 이어진 지우기는 한 단계(abc + ⌫⌫ = 확정 5·단계 2) (VERIFIED) |
| 조합 완료 | 갱신(ㄱ→가→간)은 단계를 만들지 않음, 끝에서 확정 1·단계 1, 조합 중 실행 취소 거부 (VERIFIED) |
| 이어진 조합 둘 + 바로 친 글자 | 한 그룹(확정 3·단계 1) (VERIFIED) |
| 선택 없이 조합 취소 | 확정 0·단계 0, 찍은 스냅숏 버림 (VERIFIED) |
| 선택 지운 뒤 조합 취소 | 지우기 확정 1·단계 1, 실행 취소가 지운 글자를 되살림 (VERIFIED) |
| provisional 뒤 다른 최종 글자 | 기다리는 동안 확정 0·실행 취소 거부, `resolveProvisional`에서 확정 1·단계 1 (VERIFIED) |
| 실행 취소 뒤 새 타자 | 다시 실행 버림 (VERIFIED) |
| 문맥 처음 Backspace·끝 Delete | `mutate`를 부르지 않으므로 트랜잭션도 없다 (VERIFIED 코드) |

IME 보호(지금 동작 유지): 실행 취소·다시 실행은 `imeUnsettled`(조합·provisional·최종 글자 기다림) 동안 `composing`으로 거절한다(`capability.ts`,
세션 `execute`도 같은 함수). 조합 중에는 복원이 없으므로 `composition.anchor`·provisional 고치기 좌표·`ReplaceInserted`가 무효가 되지 않는다.
복원 뒤 `composition`·`provisional`이 null인지 확인하고 아니면 내부 오류로 실패 처리한다. 확정 순서(`flushCommits`)는 바꾸지 않는다.

시험의 한계: 위 VERIFIED는 세션을 바꾸지 않고 시험이 그룹을 닫는 모의 통합이다(실행 취소는 세션 밖 엔진 복원이라 세션의 커서·쪽·revision은
복원을 모른다). **제품 통합과 네이티브 ibus-hangul 동작은 시험하지 않았다**(Phase 2 관문).

## 7. revision·dirty

- 백엔드 `SessionRegistry`가 유일한 권한이다(`revision` 단조, `dirty = revision != clean_revision || unconfirmed`). 두 번째 계수기를 두지 않는다.
- 성공한 실행 취소·다시 실행은 **새 변경 1개**: `recordMutation()` → revision +1. revision을 줄이지 않는다.
- 저장한 내용과 같아 보여도 dirty를 지우지 않는다(내용 기반 깨끗함은 별도 미래 기능). 세션 `modified`도 남긴다.
- 대기 확정·늦은 응답·세대: 기록은 지역·동기라 응답을 기다리지 않는다. 옛 세대 응답은 지금처럼 `owns(epoch)`로 버린다. 다시 불러오기는 기록을 버린다.
- 확정 실패(`handleBackendRejection`): 세션이 편집을 멈추거나 정리한다 → 기록도 `dispose`(모델과 백엔드가 어긋났으므로 이후 실행 취소 없음).
  확정 실패를 기록으로 되돌리지 않는다.
- 내구성 미확인 저장(`durable: false`)·저장 중 편집(`changedSince`): 지금 규칙 그대로. 저장 뒤 실행 취소도 revision +1, dirty.

## 8. 저장 수명주기

T009 규칙은 그대로이고 기록은 판정을 우회하지 않는다: 실행 취소한 모델도 `exportAndCompare` → `service::save`를 거친다. 복원은 `lastRoundTrip`을
지운다(`mutate`와 같음). 사전 검사(`saveCheck`, 원본 파일에 대한 것)는 지우지 않는다. 저장 차단(`saveBlocker`: 조합·대기 확정·불확실)은 그대로.

## 9. 실패와 복구

| 실패 | 엔진이 문서를 바꿨나 | 상태 전이 |
|------|----------------------|-----------|
| `reserve` 거부(우리 셈, 엔진 호출 전) | 아니다(VERIFIED 구성: 엔진을 부르지 않음, §11 할당 수 그대로) | 실행 취소: 거부(`limit`), 문서·기록 그대로. 편집: 정상 상태에선 생기지 않는다(I2 + 과거를 지울 수 있음). `limit < 2`면 기록을 처음부터 끔 |
| 할 수 없는 기록 동작(되돌릴 것 없음·트랜잭션 중) | 아니다 | 거부(`nothingToUndo`·`nothingToRedo`·`composing`) |
| `saveSnapshot` 예외 | **알 수 없다**: Result가 없어 예외는 trap이고, 그 전에 `flush_cell_format_vpos`가 모델을 바꿨을 수 있다 | `uncertain = true`, `modelVersion += 1`, `lastRoundTrip = null`, `failEditing()`(지금 `mutate` catch와 같음), 기록 `broken`(엔진을 더 부르지 않음, 문서 `free()`에 맡김). 편집 계속 허용하지 않음 |
| 복원할 ID 없음(`스냅샷 N 없음`) | 아니다(찾기가 바꾸기 전, VERIFIED) | 우리 셈이 엔진과 어긋났다는 내부 오류 → 기록 `broken`·`dispose`. 문서는 그대로이므로 편집은 계속할 수 있다 |
| 그 밖의 복원 예외·파생 상태 재구성 trap | 알 수 없다 | `uncertain`·`failEditing`·기록 `broken`. 되돌림 보장을 만들지 않는다 |
| 복원 성공 뒤 그리기 실패 | 모델은 복원됐다 | `mutate`와 같이 변경 1개로 센 뒤 `markFailed(render)` |
| 비동기 중 닫힘·늦은 세대 응답 | — | 기록 동작은 동기. 닫힌 뒤 명령은 `notReady`. 새 문서의 기록은 빈 상태에서 시작 |

성공한 복원 뒤: `modelVersion += 1`, `pages = readPages(doc)`(캔버스 다시 그림), 커서·선택을 체크포인트로(범위 밖이면 문서 처음), `preferredX = −1`,
`lastRoundTrip = null`, 가용성 갱신(`emit`). 그림 신원 세대는 엔진이 올린다(`bump_bin_data_epoch`).

## 10. 메모리 예산과 성능

과거 측정(Phase 0 G, node + 고정 WASM, **WebView 끝단 지연이 아님**, 이번에 다시 재지 않음):

| 문서 | 열기 | saveSnapshot p50/p95 | restoreSnapshot p50/p95 | 스냅숏당 메모리 |
|------|------|----------------------|-------------------------|-----------------|
| 생성 픽스처(13KB) | 2ms | 0.01/0.01ms | 0.34/0.37ms | 측정 안 됨 |
| 실제 HWP 10.7MB(비공개, 재현 불가) | 1185ms | 24.6/30.4ms | 689/839ms | ≈8.3MB(WASM 메모리 상한선 증가로 어림) |
| 실제 HWPX 13.6MB(비공개, 재현 불가) | 966ms | 3.0/3.6ms | 622/660ms | 측정 안 됨(0으로 보임) |

엔진 API에 스냅숏 크기 질의가 없고 WASM 메모리는 줄지 않는 상한선이라, **바이트 예산을 지킬 수단이 없다**. 아래 `BUDGET`(기본 256MB)은 목표이지
보장이 아니다. 파일 크기는 살아 있는 메모리의 대용(proxy)일 뿐이다.

고친 순서(이전 판 `clamp(floor(B/e), 4, cap − H)`는 아주 큰 문서도 4로 올려 "4 미만이면 끔"이 걸리지 않았다 — §11 재현):

```text
estimate  = max(원본 파일 바이트, 첫 스냅숏 전후 WASM 메모리 증가)     # 대용
raw       = floor(BUDGET / estimate) − 2        # 살아 있는 문서 1 + 복원 중 임시 복제 1(restore가 스냅숏을 복제)
minSnaps  = MIN_DEPTH(4) + 1
if raw < minSnaps:        기록 끔(이유 limit)   # 자르기 전에 먼저 확인
snapshots = min(raw, snapshotCapacity() − HEADROOM(2), MAX_DEPTH(50) + 1)
if snapshots < minSnaps:  기록 끔
limit = snapshots; depth = snapshots − 1
```

관계: 최고 살아 있는 스냅숏 수 = `limit` ≤ `capacity − 2`(I3). 논리 단계 ≤ `depth` = `limit − 1`. 최고 메모리 어림 = (`limit` + 2) × estimate(복원 중
임시 복제 포함). 경계(VERIFIED 산술): raw 5 → 켬·깊이 4, raw 4 → 끔, 용량 6 → 6 − 2 = 4 < 5라 끔.

성능 정책: 스냅숏은 그룹 시작마다 한 번(글자마다가 아님). 큰 HWP에서 그룹 시작마다 ≈25ms(과거 측정), 실행 취소·다시 실행 ≈0.7초(엔진만).
재설계 조건: WebView에서 실행 취소 p95 > 1.5초, 그룹 시작 때문에 키 지연 p95 > 50ms, 대상 문서군에서 깊이 4가 들지 않는 문서가 흔함, 고정 rhwp의
상한·넘침 동작 변경, 엔진이 기록·역연산 API를 냄. Phase 2 벤치마크: 작은 문서·큰 HWP·큰 HWPX에서 실행 취소·다시 실행 반복, 1분 연속 타자의 키 지연,
최고 WASM 메모리·프로세스 RSS, 실제 WebView 응답성.

## 11. 시험 표

이번에 실행한 것(`tests/poc/t010-phase0/`, 결과는 README·`evidence/history-boundary.json`):

| 종류 | 시험 | 결과 |
|------|------|------|
| 실제 WASM 스냅숏 | 깊이 4·5 한도, 정확한 상한(깊이 97·스냅숏 98, 누적 할당 121), 실행 취소 뒤 새 편집, 200회 번갈아, 상한이 줄 때 보호·다시 실행 무할당, 후보 없는 거부, 이전 판 반례, 실패 주입 3(찍기 예외·없는 ID·복원 예외), 취소한 트랜잭션 | `history_boundary.mjs` 실제 WASM 13개 통과 |
| 상태 기계(흉내 엔진: 고정 rhwp의 상한·넘침·"없음" 흉내) | 무작위 2만 단계 × 깊이 4·5·97, 매 단계 불변식·엔진 저장소 ≤ 98, 끝에 참조 ID 모두 복원·버린 ID 모두 "없음" / 트랜잭션 중 거부 | 4개 통과(엔진 증거 아님) |
| 산술 | 이전·고친 깊이 식 | 1개 통과 |
| 실제 WASM 세션 + 시험용 기록 감싸개 | §6 표 12가지 + 이전 판 반례 | `typing_groups.poc.test.ts` 13개 통과 |
| 제품 통합(세션의 `RhwpHistory`) | — | **실행하지 않음**(구현 없음) |
| 네이티브 ibus-hangul | — | **실행하지 않음**(구현 없음) |

Phase 2가 더할 것: 세션 통합 시험(복원 뒤 커서·쪽·revision +1·`modified`), 그리기 실패 뒤 상태, 저장 → 실행 취소 → dirty, 네이티브 조합 중 Ctrl+Z,
§10 벤치마크, `saveSnapshot`의 `flush_cell_format_vpos`가 표 셀 서식 뒤 내보내기 바이트를 바꾸는지.

## 12. 열린 질문과 관문

열린 질문(①·④는 2026-10-22 선행 PoC로 답함 — 아래 "Phase 2 구현"): ① `flush_cell_format_vpos` 영향(위) ② trap 뒤 같은 모듈의 다른 문서를 쓸 수 있는가(지금은 쓸 수 없다고 본다) ③ 스냅숏의 실제 바이트 ④
표 구조가 바뀐 단계에서 커서 체크포인트의 유효성 ⑤ 복원한 상태를 다시 실행 대상 그대로 재사용하는 것의 바이트 동등성 — 글은 같음(VERIFIED 200회),
내보내기 바이트 동등성은 Phase 0 A6로 INFERRED.

Phase 2 시작 관문: 이 문서 검토 승인, ①·④의 짧은 PoC, `RhwpDocument` 타입에 스냅숏 네 함수 추가 범위 확정. 명령 활성화(Phase 4) 관문: §11의
"실행하지 않음" 줄 전부 통과, 네이티브 ibus-hangul 시험 통과, 벤치마크가 재설계 조건에 걸리지 않음.

## 13. 명령 레지스트리 통합(Phase 2에서 구현 — 레지스트리 지원 표만 남음)

| 위치 | 변경 |
|------|------|
| `rhwpModule.ts` `RhwpDocument` | `saveSnapshot(): number`, `restoreSnapshot(id): string`, `discardSnapshot(id): void`, `snapshotCapacity(): number` |
| `RhwpEditorSession` | `mutate`·조합·provisional 해결의 엔진 호출 앞에 트랜잭션 시작, `recordMutation`에서 그룹 확정, 이동·명령에서 그룹 끊기, `undo`·`redo`(복원 → `recordMutation`) |
| `RhwpEditorSession.snapshot()` | `history: state === "broken" \|\| !enabled ? null : { undo: cursor > 0, redo: cursor < last }`, `queuedHistory: null` |
| `RhwpEditorSession.execute()` | `edit.undo`·`edit.redo`를 같은 가용성 함수로 다시 확인한 뒤 실행 |
| `DocumentCommandSnapshot` | 기록이 한도로 꺼졌음을 알릴 값 하나(예: `historyLimited`) |
| `capability.ts` | `history: null` + `historyLimited` → `limit`, 아니면 `engineUnsupported` |
| `registry.ts` | Phase 4에서만 rhwp `edit.undo`·`edit.redo`를 `SUPPORTED` |

가용성 이유: 쓸 수 있음 / `nothingToUndo` / `nothingToRedo` / `composing`(IME 트랜잭션) / `notReady`(불러오지 않음·불확실 모델로 편집 멈춤) /
`limit`(기록 꺼짐·할당 거부) / `dialogOpen`. rhwp는 대기 확정에 막히지 않는다(§7).

## Phase 2–4 순서

자세한 관문은 [tests/poc/t010-phase0/README.md](../../tests/poc/t010-phase0/README.md) "다음 단계". Phase 3A(T009 모양 참조 무결성)는
2026-10-22에 고쳤다([save-preservation.md](save-preservation.md) "모양 참조 무결성"). 남은 순서: Phase 2(이 계약으로 rhwp 실행 취소 구현) →
Phase 3B(HWPX 서식과 좁은 header 규칙) → Phase 3C(HWP 서식은 미리보기·모양 재사용과 따로) → Phase 4(검증한 명령만 켜고 T010 수용 기준 마무리).

## Phase 2 구현(2026-10-22)

### 선행 PoC(관문 B)

- **B1 스냅숏 부작용**(`tests/poc/t010-phase0/snapshot_side_effects.mjs`, 실제 WASM, 18/18): 표 셀을 두 문단으로 나누고 첫 문단에 큰 글자 크기를 걸어
  셀 문단 위치(커서 사각형 y)가 실제로 바뀌는 상태를 만든 뒤, 배치 아님(세션과 같은 경로)·배치 모드 모두에서 `saveSnapshot` 전후의 본문·셀 구조·
  서식·커서 사각형·내보내기 바이트·다시 연 문서·T009 판정이 같고, 스냅숏 없는 같은 편집과도 같았다. 두 번 내보내기도 같은 바이트. 결론(VERIFIED):
  고정 rhwp에서 `flush_cell_format_vpos`는 비배치 편집 경로에서 이미 `rebuild_section`이 하므로 스냅숏 찍기는 관찰 가능한 상태를 바꾸지 않는다
  (배치 모드에서도 최종 결과 같음). 세션은 배치 모드를 쓰지 않는다. 계약 변경 없음(§9의 "찍기 예외 = 불확실"은 유지 — trap 가능성 때문).
- **B2 커서 체크포인트**(`tests/poc/t010-phase0/checkpoint.poc.test.ts`, 실제 WASM·제품 `RhwpText`, HWP·HWPX 22개): 체크포인트를 위치만이 아니라
  위치 + 앞뒤 8글자 지문 + 그 문맥의 문단 수 + 셀 수로 둔다. 넣기·지우기·나누기·합치기·선택 바꾸기·여러 문단 선택·셀 안·셀 끝 경계에서 복원 뒤
  정확(exact)하고 후속 넣기가 그 자리에 들어간다. 다른 상태에서 찍은 체크포인트(새 문단·새 셀 문단·숫자로는 범위 안이지만 다른 자리)는 구조·
  지문으로 가려 문서 처음·선택 없음으로 대체하며 내용을 바꾸지 않는다. 계약 변경: §4의 커서 체크포인트 = `rhwpHistory.ts` `Checkpoint`.

### 구현

- `src/components/Editor/rhwp/rhwpHistory.ts`: `RhwpHistory`(§4·§5의 시간선·I1–I3·ID 보호 예약·끝에서만 지움·다시 실행 무할당·
  취소한 트랜잭션의 스냅숏 버림), `historyBudget`(§10 순서: HEADROOM 2, MIN_DEPTH 4, MAX_DEPTH 50, BUDGET 256MB — 추정이지 보장이 아님),
  `captureCheckpoint`·`placeCheckpoint`(B2), 쉼 정책 `HISTORY_IDLE_MS = 1500`(같은 종류·이어진 자리여도 1.5초 넘게 쉬면 새 단계 — 긴 입력이
  한 번에 사라지지 않게). `limit`은 엔진 상한을 매번 읽는다(고정 판이 바뀌면 다음 할당이 먼저 지우거나 거절).
- `RhwpEditorSession`: 불러올 때 원본 바이트 수로 예산을 정해 기록을 켜고(아니면 `historyLimited`), `mutate`가 바꾸는 첫 엔진 호출 직전에
  트랜잭션을 열고(종류: 넣기 `typing`, 앞 지우기 `deleteBack`, 뒤 지우기 `deleteForward`, 나머지 `other`; 선택이 있으면 이어 쓰지 않음),
  `recordMutation`이 확정과 별도로 그룹을 닫고, 셈 없이 끝난 조합·provisional은 `cancel`, `moveTo`(이동·클릭·셀 이동)가 그룹을 끊는다.
  `undo()`·`redo()`는 `imeUnsettled`(조합·provisional·최종 글자 기다림)와 편집 불가에서 거절하고, 성공하면 `modified`, `lastRoundTrip = null`,
  `modelVersion += 1`, 체크포인트 배치, `preferredX = -1`, `recordMutation`(revision +1), 쪽 정보 다시 읽기(실패하면 센 채로 `markFailed(render)`).
  실패: 찍기·복원 trap = 불확실·`failEditing`, "스냅샷 N 없음" = 문서 그대로·기록만 끔, 엔진 호출 전 거절 = 아무것도 바꾸지 않음. 편집을 멈추면
  (`markFailed`·`StaleLoad`) 기록을 비우고, 다시 불러오기·닫기는 문서와 함께 놓는다.
- 명령: `snapshot().history`(세션 기록), `historyLimited` → 가용성 `limit`. `execute`는 모든 명령을 같은 가용성 함수로 다시 확인한 뒤 실행 —
  레지스트리가 rhwp `edit.undo`·`edit.redo`를 `unsupported`로 두는 동안은 `engineUnsupported`로 거절된다.

### 검증(2026-10-22, 이 환경)

| 시험 | 결과 | 엔진 |
|------|------|------|
| `src/components/Editor/rhwp/rhwpHistory.test.ts`(기본 `npm test`) | 25개 통과 — 알고리즘 경계 11(깊이 4·5, 상한 97, ID 보호, 거절, 쉼, 실패 3종, 무작위 2만 단계 × 3, 예산), 세션 통합 14(실행 취소·다시 실행 revision·modified, 묶기, 새 편집, 조합 시작만 한 상태의 거절, 조합 취소, provisional, 다시 불러오기·닫기, 찍기·복원 실패, 없는 ID, 복원 뒤 그리기 실패, 확정 거절, limit, 레지스트리 거절) | 흉내·가짜 문서 |
| `tests/integration/rhwp/undo.wasm.test.ts` | 8개 통과(HWP·HWPX × 4: 넣기·나누기·합치기·선택 바꾸기·셀 편집의 단계별 실행 취소·다시 실행과 커서, 왕복 검사·되돌린 내보내기 바이트 = 편집 전, 조합, 깊이 50 상한) | 실제 WASM 세션 |
| `tests/integration/rhwp/undo_save.py` | 5/5 — 되돌린 출력 safe·게시, 다시 실행한 HWPX safe·게시, HWP `previewStale` 거부, 다시 실행 + 없는 참조 `referenceInvalid` 거부·원본 SHA-256 그대로 | 실제 WASM + 실제 `service::save` |
| `tests/integration/rhwp/history-perf.wasm.test.ts`(`GEUL_PERF=1`) | 12MB HWP(24쪽): 그룹 시작 p95 19.9ms, 실행 취소 p95 23.9ms, 다시 실행 p95 34.9ms. 7MB HWPX(1쪽): 모두 11ms 이하. node + jsdom, 그리기 없음 — **WebView 지연이 아님** | 실제 WASM 세션 |
| 네이티브 앱(검사 훅 빌드, Xvfb + ibus-hangul) `rhwp_poc.py --ime` | IME 게이트 PASS 7/7 — 기록을 붙인 세션에서 기존 조합 계약 회귀 없음. 실행 취소 자체는 레지스트리가 막아 실행하지 않음 | 실제 앱·입력기 |

활성화 관문(미통과, 그래서 `unsupported` 유지): 네이티브 ibus-hangul에서의 실행 취소 시나리오(조합 중 Ctrl+Z, 확정 직후 Ctrl+Z, Ctrl+Y, 선택 조합
취소, provisional, 빠른 연속 입력, 다시 불러오기·닫기) — 지원 표가 바뀌기 전에는 앱 단축키가 실행 취소를 부르지 않고, 시험용 우회 활성화는 넣지 않았다.
WebView 응답성·실제 그리기까지의 지연과 여러 쪽의 큰 HWPX(공개 예제의 큰 여러 구역 문서는 지금 세션이 열지 못함 — 별도 결함, 아래) 측정.

발견한 별도 결함(이 작업 밖, 고치지 않음): 고정 rhwp의 `getPageInfo(page).pageIndex`가 구역마다 0부터 다시 시작하는 여러 구역 문서를 세션의
`readPages`(`pageIndex === page` 요구)가 `EngineFailure(render)`로 거부한다(공개 예제 12.8MB HWP 202쪽: 136쪽부터, 20MB HWPX 140쪽: 59쪽부터 — 실측).
