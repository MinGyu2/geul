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

## Phase 2 안정화(2026-10-22, 2차)

### 여러 구역 문서의 쪽 번호(관문 A)

고정 rhwp `get_page_info_native`·`find_page`(VERIFIED 코드·실측): 쪽 번호 **인자**와 그리기(`renderPageToCanvas`)·hit test·커서·선택 사각형의
`pageIndex`는 문서 전체 **물리 순번**이다. `getPageInfo(page)`가 돌려주는 `pageIndex`만 그 쪽이 속한 구역(`sectionIndex`) 안의 순번(구역마다 0부터)이고,
`pageNumber`는 보이는 쪽 번호(번호 다시 시작이 반영된 값)다. 세션 `readPages`는 `pageIndex === page`를 요구해 여러 구역 문서를
`EngineFailure(render)`로 거부했다 — 공개 예제 중 여러 구역 문서 86개(HWP 50, HWPX 36)가 열리지 않았다. 고침: 구역 번호는 0 이상이고 줄지
않으며, 한 구역의 쪽은 붙어 있고, 구역 안 순번은 구역 첫 쪽에서 0부터 1씩 는다(아니면 그대로 거부). 쪽 크기·쪽 수·그리기 예산 검사는 그대로.

함께 고친 쪽 소비자(실측으로 찾음): 표 셀 안 개체를 가리키는 hit test 결과(`cellPath: [[컨트롤, 셀, 셀 문단]]`, `innerControlIdx`)를 본문 위치로
읽어 커서가 구역 첫 문단(다른 쪽)으로 튀던 것 → 그 모양은 다루지 않음(`parsePosition` null). 표가 아닌 컨트롤을 셀처럼 돌려주는 hit test
(`exam_kor.hwp`)의 셀 위치에 커서를 두면 넣기가 엔진 예외로 편집을 멈추던 것 → `pointAt`이 그 컨트롤이 실제 표일 때만 옮김.

시험: `tests/integration/rhwp/multisection.wasm.test.ts`(실제 WASM, 7개 — 여러 구역 HWP 2·HWPX 2의 열기, 구역 경계 앞뒤 쪽 클릭 = 커서 쪽,
선택 사각형 쪽, 뒤 구역 편집·실행 취소·다시 실행 뒤 쪽 정보, 위아래 이동; 표가 아닌 컨트롤 클릭 거부; 진짜 예산 초과 2개는 `RenderLimit`).
고치기 전 계약으로 되돌리면 7개 중 6개 실패(확인). 가짜 문서 시험에 구역 계약의 잘못된 모양 7가지와 받아들이는 여러 구역 모양 1가지를 더했다.
그리기 예산(`MAX_RENDER_PIXELS`, 최소 배율에서 모든 쪽 비트맵 합)을 넘는 문서(202쪽 HWP, 215쪽 HWPX)는 쪽 번호와 무관하게 `RenderLimit`이다.

### 초점 경계(관문 B1–B3)

`ImeInput.blur()`·`detach()`(초점 잃음·탭 전환으로 표면 사라짐)가 세션의 `endHistoryGroup()`(선택 메서드 — WordCraft는 엔진이 묶으므로 없음)을
부른다. `RhwpHistory.boundary()`는 열린 트랜잭션(조합·provisional·늦은 최종 글자)이 없으면 바로 그룹을 끊고, 있으면 **그 트랜잭션이 닫힐 때**
끊는다(`breakAfterCommit` — 지금 그룹만 비우면 조합이 나중에 닫히며 그룹을 다시 만든다). 초점 사건은 문서·revision·조합·대기 확정을 바꾸지 않고
단계를 만들지 않는다. 시험 `src/components/Editor/rhwp/historyFocus.test.ts` 10개(쉼은 performance.now를 시험이 정함), 경계 호출이나 지연 끊기를
지우면 각각 5개·2개 실패(확인).

### 체크포인트(관문 B4–B5)

`tests/poc/t010-phase0/checkpoint.poc.test.ts`는 이제 제품 `captureCheckpoint`·`placeCheckpoint`를 직접 부른다(시험 안의 같은 알고리즘 제거, HWP·HWPX
28개). 한계(문서화, 시험으로 고정): 문단 수가 같고 앞뒤 8글자가 같으면 **다른 상태의** 같은 좌표를 정확으로 본다 — 의미상 다른 문단인지 엔진 API로는
알 수 없다. 체크포인트는 그 스냅숏 상태와 짝으로만 쓰므로(같은 상태로 복원) 이 경우는 기록의 셈이 어긋난 때뿐이고, 지문은 그때를 잡는 보조 장치다.

### 활성화 관문(2026-10-22, 실제 앱 · 시험 활성화 빌드)

시험 활성화: `VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1` 빌드에서만 `registry.ts` `RHWP_HISTORY`가 `supported`(빌드 때 상수 — 일반·검사 훅만
켠 빌드의 산출물에 그 분기의 표지 문자열이 0개임을 확인). 단축키·리본은 같은 명령 경로(`executeCommand` → 세션 `execute` 재확인)다. 시험
`tests/integration/rhwp/undo_native.py`, 정리된 결과 `tests/poc/t010-phase0/evidence/undo-native.json`.

| 관문 | 판정 | 근거 |
|------|------|------|
| C1 시험 전용 경로 | PASS | 일반 빌드·검사 훅 빌드에 표지 0, 시험 활성화 빌드에 1. 검사 훅만 켠 앱에서 rhwp 실행 취소가 미지원으로 보이고 단축키가 아무것도 바꾸지 않음(`rhwp_poc.py --commands-only` 6/6) |
| D1 WebView 그리기 | INCONCLUSIVE | HWP·HWPX: Ctrl+Z 세 번·Ctrl+Y·Ctrl+Shift+Z·쪽이 늘어난 편집 45단계 되돌림이 쪽 Canvas 내용과 같음(쪽 전체로 다시 그린 기준과 비교해 가장자리 1픽셀 줄 밖의 차 0), 실행 취소 뒤 새 타자가 다시 실행을 버림, 닫고 다시 열면 기록 없음. 여러 구역 HWP(aift, 74쪽)·HWPX(자산 관리 규정, 60쪽): 뒤 구역 첫 쪽 클릭 = 커서 쪽, 넣기 → Ctrl+Z → Ctrl+Y의 그 쪽 내용 같음. **표 셀 안 시나리오는 클릭이 셀에 닿지 않아(커서 `0:1:0`) 실행하지 못함** — 원인 미확인 |
| D2 네이티브 ibus-hangul | **FAIL** | 15개 중 13 PASS(조합 중 Ctrl+Z가 조합을 깨지 않음, 확정한 조합 한 단계 되돌림·Ctrl+Y 정확, 이어진 음절 한 그룹, 조합 중 클릭·늦은 최종 글자, 조합 중 초점 잃음, 빠른 연속 입력, 닫고 다시 열기). **FAIL 2(HWP·HWPX): 선택을 조합으로 바꾸다 Backspace로 취소한 뒤 바로 Ctrl+Z가 거절됨** — 실측 추적: WebKitGTK가 `deleteCompositionText` 뒤 빈 `compositionend`를 보내 앱이 최종 글자 기다림(`awaiting`)에 들어가고 명령이 `composing`으로 거절된다. 이 사건 열은 WebKitGTK의 확정 나누기(빈 끝 뒤 `insertFromComposition`)와 최종 글자가 오기 전까지 같아 구별할 수 없고, 기다림은 T010 IME 경계 계약(빈 끝과 최종 글자 사이 명령 차단)이다. 지운 선택 글자는 열린 조합 트랜잭션에 남아 잃지 않지만(다음 입력 뒤 되돌릴 수 있음, INFERRED), 그 자리 클릭 뒤에도 Ctrl+Z가 되살리지 못했다(관찰) |
| D3 저장 보존 | PASS | `undo_save.py` 13/13: 생성 픽스처·여러 구역 공개 예제의 되돌림·다시 실행·실행 취소 뒤 새 편집을 실제 `service::save`에. 게시는 사전 검사·출력 검사가 모두 safe일 때만, 아니면 거부·원본 SHA-256 그대로(여러 구역 HWPX는 엔진 왕복 자체가 사전 검사 unsafe), 참조 무결성 거부 유지 |
| D4 WebView 성능·메모리 | **FAIL** | 12MB HWP(24쪽, 배율 50%), 페이지 안 keydown·input → 모델 변경 뒤 두 번째 frame: 그룹 시작 타자 p50 61ms·**p95 211ms**(기준 50ms 초과, n=12), 이어 친 타자 p95 73ms, 실행 취소 p50 137·p95 240ms(n=10), 다시 실행 p95 273ms, 실행 취소·다시 실행 중 frame 간격 p95 109ms(최대 119). WebKitWebProcess RSS 200MB → 열기 654MB → 실행 취소·다시 실행 20회 뒤 1.05GB → **닫은 뒤 1.06GB(돌아오지 않음)**. 큰 여러 쪽 HWPX(140쪽)는 배율 50%에서도 표시 비트맵 예산을 넘어 측정하지 못함. 첫 측정(배율 100%)은 그룹 시작 p95 386·이어 친 타자 p95 465ms로 큰 문서의 다시 그리기 비용이 지배적이었다 |

결론: D2·D4 FAIL, D1 INCONCLUSIVE → **제품 rhwp `edit.undo`·`edit.redo`는 `unsupported` 유지**. 다음에 필요한 것: (1) 빈 조합 끝 뒤 기다림과 실행 취소의
계약(예: 기다림 중 Ctrl+Z를 기다림이 끝난 뒤로 미루기 — 즉시 거절 대신 — 를 IME 경계 계약을 깨지 않게 설계·네이티브 검증), (2) 큰 문서의 그룹 시작
스냅숏 지연(타자 경로 밖으로 옮기거나 그룹 시작 판정을 바꾸는 설계)과 WebKitWebProcess 메모리 유지(WASM 선형 메모리는 줄지 않음 — INFERRED)의
측정·대책, (3) 표 셀 클릭 시나리오의 원인 확인.

## T010 후속 안정화 (2026-10-22, activation은 계속 NO-GO)

이 절은 위 Phase 2의 실패를 출발점으로 한 후속 작업이다. 과거 증거는 그대로 보존하고,
새 증거는 `tests/integration/rhwp/evidence/t010-stabilization/`에 분리한다. T010 완료 및 T011 의존성을 바꾸지 않는다.

### IME 취소 경계

**VERIFIED:** 실제 WebKitGTK 2.54.1 + ibus-hangul에서 HWP/HWPX 모두 기존 실패를 재현했다(13 PASS / 2 FAIL).
조합 Backspace의 keydown은 `Unidentified/229`라 그것만으로는 확정의 앞 반쪽과 취소를 구별하지 못했다.
추가 관측에서는 `deleteCompositionText → compositionend("") → keyup(Backspace, keyCode=8, isComposing=false)`가 확인됐다.

rhwp만 이 마지막 경계를 받는다. 같은 IME 소유 세션/세대이고, 삭제 입력 뒤 빈 끝을 받았으며, 다른 입력·포인터·초점 변화가
없고, 활성 조합/provisional/실패 상태가 아닐 때만 awaiting을 해제한다. 그 뒤 옛 조합의 최종 입력과 끝은 새 입력 경계까지 소비한다.
새 preedit와 소유 세대 무효화 규칙은 기존 계약을 유지한다. WordCraft는 이 경계에 참여하지 않는다.

Undo 요청 자체는 기다림을 해제하지 않는다. 확정 앞 반쪽에는 계속 `composing`으로 거절하며, 명령 의도를 예약하지 않는다.
따라서 중복 실행·다른 탭/새 세대/다음 편집에서 뒤늦게 실행되는 Undo는 없다. 타이머나 강제 확정도 없다.
취소를 입증하는 keyup이 없는 플랫폼/순서는 기존의 최종 입력 또는 새 입력 경계를 기다리며, 시간만으로 안전하다고 판단하지 않는다.

**VERIFIED:** native 후속 21/21에는 HWP/HWPX의 선택 없는 취소, 선택 대체 취소, 한 native 호출의 1ms Backspace→Ctrl+Z,
정확한 선택/본문 복원, revision 증가, Ctrl+Y/Ctrl+Shift+Z, 빠른 음절, 클릭과 blur 뒤 확정이 포함된다.
가짜 엔진/합성 DOM 회귀와 실제 WASM 재생은 별도 증거이며 native 통과로 합산하지 않는다.
초기 후속 시험의 17/19는 중간 DOM 상태를 너무 일찍 읽거나 실제 선택 문단 1 대신 문단 0을 조회한 시험기 오류였다.
실패 기록을 보존하고, 기다림을 추가하는 대신 실제 선택 문단의 WASM 동등성을 compositionend에서 기록하도록 수정했다.

### 표 포인터

**VERIFIED:** 원본 fixture를 엔진에 직접 질의하면 기존 `(410,182)`는 유효한 셀 위치였다.
하지만 Xvfb의 fractional DPR 약 1.042에서 WebKitWebDriver가 요청한 viewport `(682,487)`를 실제 DOM `(654,467)`로 보냈다.
앱의 Canvas-local → engine 변환은 받은 이벤트 좌표에 맞게 동작했으며, 그 좌표는 앞 문단을 가리켰다.

시험기는 클릭 없는 두 포인터 이동으로 실제 전달 배율을 확인하고, 살아 있는 문서의 셀 caret/bounds와 Canvas DOM 사각형으로 목표를 정한다.
화면 밖 쪽을 가운데 맞춰 셀이 toolbar 아래로 들어가는 경우도 제거했다. 엔진 hitTest, parsePosition, 비표/중첩 구조 거부는 바꾸지 않았다.
셀 진입을 먼저 확인하고 나서 삽입/셀 문단 분리, Undo 두 번, Redo 두 번의 정확한 글자/커서와 Canvas를 비교한다.
HWP의 보존 정책 때문에 변경본을 저장 가능한 것으로 가정하지 않는다. 버리고 다시 열어 원본 셀과 파일 SHA가 유지되는지 확인한다.

### 응답성

**VERIFIED:** Undo/Redo는 DOM input 시각이 없어 화면 밖 쪽까지 즉시 그리던 경로였다.
새 회귀가 이를 재현했고, 기존 타자 입력의 offscreen 지연 정책을 모든 모델 변경에 적용했다.
이미 그린 화면 밖 쪽만 지연하며, 커서 쪽·보이는 쪽·새 bitmap은 즉시, 스크롤/resize로 나타난 쪽도 즉시 그린다.
모델 version 검사와 작업 취소를 유지한다. 스냅숏을 늦게 찍거나 상태/검증을 생략하지 않는다.

같은 Xvfb/소프트웨어 renderer/배율50%, native xdotool, warm-up3그룹, 시작/이어쓰기 각각30표본의 관측이다.
측정은 keydown timestamp부터 로컬 revision을 관측한 frame 뒤 두 RAF까지로 유지하고, 기존 input timestamp 구간도 따로 기록했다.
실제 하드웨어 presentation timestamp가 아닌 상한 측정이다. 과거 211ms(다른 입력 전달·표본 수)와 직접 개선율을 계산하지 않는다.

| 문서 | 그룹 시작 p95 전→후(ms) | Undo p95 전→후(ms) | Redo p95 전→후(ms) |
|---|---:|---:|---:|
| 작은 HWP | 76→79 | 88→88 | 132→132 |
| 작은 HWPX | 72→73 | 90→85 | 129→127 |
| 12MB/24쪽 HWP | 116→84 | 278→144 | 237→114 |
| 60쪽/표24개 HWPX | 535→291 | 298→197 | 310→248 |

Undo는25표본, Redo는20표본이다. 한 번의 비교 관측을 모든 부하에 대한 보장이나 통계적 유의성으로 확대하지 않는다.
**FAIL:** 그룹 시작 절대 기준50ms는 여전히 미달한다. Undo1500ms는 이 표본에서 통과한다.
기록을 쓰지 못하도록 capacity 거절을 주입한 대조에서도 큰 문서의 시작 p95는115/245ms였다.
이것은 합성 비활성 대조이며 엔진의 실제 상한100이 줄었다는 증거가 아니다.

추가 계측은 위 비교와 별도다. **VERIFIED:** 전체 성공 `readPages()`와 revision 요청의 동기 스케줄링 p95는 각각1ms였다.
24/60쪽 문서의 compound mutation p95는3/27ms, JS에서 관측한 backend 확정 왕복 p95는52/97ms였다.
왕복에는 JS delivery 대기가 포함되며 Rust CPU 시간으로 해석하지 않는다. snapshot API 구간도 약1ms로,
복제만을 병목으로 단정할 근거가 없다. 레이어 트리 생성/직렬화·요약·렌더·WebView frame 대기가 남는다.

측정기의 중복 리스너로 표본이60/90으로 불어난 실행은 무효로 보존했다. 정리 함수와 정확한30표본 검사를 추가했다.
추가 IPC monkeypatch에서 호출이 관측되지 않은 0은 비용0의 증거로 사용하지 않고, 세션 안의 직접 계측으로 대체했다.
이전 before frame-gap 필드에는 Undo 뒤 새 입력도 포함돼 있었으므로 그 이름을 실제 구간으로 바로잡았다.
같은 범위로 비교한 큰 HWP frame-gap p95는110→47ms, HWPX는142→131ms다. 순수 Undo/Redo 구간은 after에서 별도로 잰다.

### 메모리

**VERIFIED:** 같은 WebProcess PID에서 두 큰 문서 각각 open-only/기록 없는 편집 대조/UndoRedo를5회씩, 총30사이클 측정했다.
닫은 뒤2초, 각 모드 마지막에는10초까지 확인했다. 문서 핸들·문서에 속한 snapshot API 참조·화면 Canvas는 정리됐다.
문서를 놓을 때는 snapshot별 discard 대신 엔진 문서 `free()`가 저장소를 함께 놓는다. WASM 선형 메모리는 편집 뒤114.9MiB에서 유지됐다.

기록 없는 HWP 편집 대조도 닫은 뒤 RSS가982→1076→1171→1276→1364MiB로 증가했다.
뒤 사이클/문서에서는 자연 감소도 발생했고, 같은 PID의 마지막 HWPX 닫기10초 뒤는 약834MiB였다.
스냅숏 누수나 단순 RSS 합산 오류로 단정할 수 없다. 다른 앱의 PID는 합산하지 않았다.

추가9사이클에서는 문서를 닫고도 WASM externref가 detached decoding Canvas21개, 100,819,044px를 참조했다.
픽셀당4바이트로 환산하면 약385MiB이며 실제 WebKit 할당량을 직접 잰 값은 아니다.
고정 엔진 `web_canvas.rs`의 전역 `DECODED_CANVAS_CACHE`/`IMAGE_CACHE`가 문서와 별도 수명이다.
예열 뒤 참조 수는 일정했지만 RSS 증가는 계속 관측됐다. 따라서 캐시만으로 추가 RSS 증가를 모두 설명한 것은 아니다.
캐시는 개수 기준으로 정리하지만 바이트 예산·문서 닫기 시 release API는 확인되지 않았다.

**INCONCLUSIVE:** 반복 조건에서 모든 RSS가 재사용 가능한 high-water로 안정됐다는 판정, 전역 renderer/heap 잔류의 전체 원인.
문서 참조 정리 하위 검사의 PASS를 메모리 activation PASS로 승격하지 않는다. 강제 GC나 앱 전체 reload를 해결책으로 넣지 않았다.
이 캐시를 직접 수정하거나 비공개 WASM 참조를 강제로 지우지 않았다. 공개 lifecycle/byte-budget API는 pinned engine의 별도 의존 작업이다.

### 폐기 예외 안전성

**VERIFIED:** 기존 `discard()`는 예외를 삼켜 broken만 표시했고 호출자가 snapshot 할당/편집을 계속했다.
reserve, redo 무효화, 취소 cleanup, release, commit 뒤 eviction의 실패 주입이 수정 전 실패했다.
이제 `HistoryFailure("discard-failed", true)`로 전이를 중단하며, 세션은 history를 먼저 분리하고 uncertain으로 편집/저장을 막는다.
새로 바꾼 모델의 round-trip 근거와 render version도 무효화한다. commit 뒤 실패는 이미 일어난 변경과 pending을 지우지 않는다.
`release()`는 finally에서 ID/체크포인트를 비워 재폐기를 막고, 남은 엔진 저장소는 문서 free에 맡긴다.
엔진 호출 전 capacity 거절 및 찾기 전 missing-ID 오류와, 효과를 보장할 수 없는 폐기 예외는 구분한다.

실제 WASM에서도 실제 discard를 수행한 다음 예외를 주입해 세션의 편집/저장 차단을 확인한다.
제품 registry와 실행 직전 검증은 그대로이며, production Undo/Redo 및 rhwp 글자 서식 네 가지는 활성화하지 않았다.

### 전체 시나리오에서 추가로 발견한 체크포인트 재사용 결함

**VERIFIED:** 표 진입을 고친 뒤 전체 native 실행은31/33으로, 셀 Undo의 커서 두 사례가 실제로 실패했다.
앞선 본문 편집을 Undo하면 현재 내용의 스냅숏 ID가 이미 존재한다. 그 뒤 셀로 이동해 새 편집을 시작할 때
`begin()`은 내용 스냅숏을 재사용하면서 예전 본문 caret 체크포인트까지 그대로 사용했다.
따라서 Canvas와 문서 내용은 맞지만, 새 셀 편집을 Undo한 커서가 본문으로 돌아왔다.

새 비연장 트랜잭션은 같은 내용의 snapshot을 그대로 쓰면서 **현재 편집 시작 caret/selection 체크포인트**를 새로 잡는다.
내용을 복제하거나 스냅숏을 추가하지 않는다. 취소한 트랜잭션은 이전 체크포인트로 돌려 기존 Redo 의미를 유지한다.
가짜 문서2개와 실제 WASM HWP/HWPX2개 회귀가 수정 전 실패했고, 수정 후 통과했다.
선택 없는 IME 취소가 기존 Redo 체크포인트를 바꾸지 않는 회귀도 추가했다.
Native 셀 시험은 이제 본문 편집→Undo를 먼저 수행해 이 재사용 경로를 반드시 거친다.
최종 native 재실행 결과는 아래 최종 검증 표로 판단한다.

### 최종 검증과 활성화 관문 (2026-10-22)

같은 소스 상태에서 다시 실행한 결과다. 증거는 `tests/integration/rhwp/evidence/t010-stabilization/`의 `render-after`·`cells-after`·
`ime-after`·`native-gap-unobserved`·`undo-save`·`save-preservation`·`perf-after`·`lifecycle*`·`product-build`·`verification-*`이다.

| 관문 | 판정 | 근거 |
|---|---|---|
| D1 WebView 그리기·커서(표 셀 포함) | **PASS** | native 31/31, 셀 진입 6/6. 체크포인트 재사용 결함 수정 전 31/33은 보존 |
| D2 native ibus-hangul | **INCONCLUSIVE** | 취소 경계 포함 25/25 PASS. 다만 빈 `compositionend`와 늦은 최종 글자 사이에 Ctrl+Z가 실제로 끼어든 순서는 10회 시도에서 관측하지 못했다. 결정적 가짜/WASM 시험은 별도 PASS이며 native 통과로 합산하지 않는다 |
| D3 저장 보존 | **PASS** | 실제 `service::save` Undo 13/13, T009 strict 23/23 |
| D4 성능·메모리 | **FAIL** | 그룹 시작 p95가 모든 표본에서 50ms 초과(큰 문서 84·291ms). 메모리는 문서 소유 해제 PASS, 전역 캐시·RSS 증가는 INCONCLUSIVE |
| D5 폐기 예외 안전성 | **PASS** | 실제 discard 뒤 예외 주입 2/2: uncertain, 편집·Undo·저장 차단, 원본 SHA 보존 |

일반 빌드(시험 플래그 둘 다 없음) 확인:
- 번들에 시험 활성화 표지와 native probe가 없다.
- 실제 앱에서 HWP·HWPX의 `edit.undo`·`edit.redo`는 비활성이고 "이 문서 형식에서 지원하지 않음"으로 표시된다.
- Ctrl+Z와 도구 막대 단추 모두 문서를 바꾸지 않는다.
- 시험 훅(trace, paragraph text, probe)은 노출되지 않는다.
- 기존 native e2e smoke는 62/62 PASS다. 단, 이 결과는 Xvfb `-dpi 96`에서 얻었다. 기본 DPI의 Xvfb(배율 약 1.042)에서는 시작 화면 가로 넘침 검사가 1px(`scrollWidth` 1229 > 1228) 차이로 실패한다. 이번 변경은 CSS를 바꾸지 않았으므로 환경 배율 문제로 본다(INFERRED, 이전 커밋에서 같은 조건 재실행은 하지 않음).

**결정: production 활성화 NO-GO.** D4 FAIL과 D2 INCONCLUSIVE가 남는다. 제품 registry의 rhwp `edit.undo`·`edit.redo`는 `unsupported`를 유지한다.
다음 작업:
1. 그룹 시작 지연을 레이어 트리 생성·요약·렌더·frame 대기 단계별로 귀속하고 줄인다.
2. 고정 엔진 전역 Canvas 캐시에 바이트 예산과 문서 닫기 release API를 추가한다. 이는 upstream 의존 작업이다.
3. 빈 끝과 늦은 최종 글자 사이에 Ctrl+Z가 끼어드는 native 순서를 재현할 방법을 확보한다.

## T010 후속: 응답성·native IME 경계·렌더러 캐시 (2026-10-22)

증거: `tests/integration/rhwp/evidence/t010-followup/`([README](../../tests/integration/rhwp/evidence/t010-followup/README.md)).
측정 계약(keydown → 로컬 revision 관측 RAF → RAF 둘)과 기준(그룹 시작 p95 ≤ 50 ms, Undo p95 ≤ 1500 ms)은 바꾸지 않았다.
환경은 앞 절과 같다(Xvfb·소프트웨어 렌더링·배율 50 %, native xdotool 키, 문서마다 앱 세션 하나).

### 지연 귀속

시험 훅 빌드에서만 켜지는 구간 기록(`rhwp:paint-summary`·`rhwp:paint-draw`·`rhwp:surface-first-draw`)과 표본별 시각(입력 이벤트, 처리 끝,
revision 관측, 첫 RAF, 끝)을 더했다. 계약 값(keyToFrame)은 그대로 두고 귀속은 따로 적는다.

- **VERIFIED(60쪽 HWPX):** 처음 그리기를 입력이 끊어 아직 그림이 없는 화면 밖 쪽이 "그림 없는 쪽은 바로 그린다" 규칙으로 키 직후
  한 task에 하나씩 전체 그리기(`renderPageToCanvas` 50~160 ms)됐다. 다음 키의 입력 이벤트가 그 뒤로 밀려 p95 158 ms 늦게 들어왔다
  (커서는 0쪽, 그린 쪽은 47~59쪽).
- **VERIFIED(60쪽 HWPX):** 남은 중앙값은 엔진 몫이 크다: 글자 넣기(`insertText`, 다시 조판) p50 27 ms, 커서 쪽 첫 그리기 24 ms
  (레이어 트리 생성·직렬화 약 8 ms + JS 요약 약 4 ms + 띠 그리기 13 ms), 이어지는 frame 약 40 ms.
- **VERIFIED:** 기록 끔 대조(capacity 거절 주입)의 지연이 정상 기록과 같다(60쪽 100/120 vs 105/128 ms). 스냅숏은 병목이 아니다.
- **VERIFIED(작은 문서):** 꼬리(p95 약 75 ms)는 앱 JS가 끝난 뒤(약 12 ms) WebKit main thread가 약 30 ms 멈춘 frame 두 개다.
  단일 변경 실험에서 Canvas 픽셀·엔진 띠 그리기·레이어 트리 요약·textarea/커서 이동·속성·단추 상태·IPC 하나는 그런 정지를 만들지 않았고,
  합성 입력으로 앱 경로 전체(모델·React·그리기·확정 IPC)를 돌리면 생겼다. 원인 함수는 **UNVERIFIED**: native 표본 추출기가 필요한데
  이 환경은 `ptrace_scope=1`이고 `perf`가 없다.
- **VERIFIED:** 초점 있는 textarea·input 값을 **스크립트로** 바꾸면 길이와 관계없이 약 32 ms 멈춘다(contenteditable·선택만 바꾸기·
  초점 없는 textarea는 0). native 타자는 그렇지 않았다(중앙 표본에 정지 없음). 그래서 조합 아닌 글자를 beforeinput에서 받는 입력 경로
  변경을 시도했으나 A/B에서 이득이 없어 **되돌렸다**(T007/T008 입력 계약 그대로).
- **VERIFIED:** 아무 일도 하지 않는 같은 3-RAF 사슬(타이머 task에서 시작)의 바닥은 작은 문서에서 p50 40, p95 약 50 ms다.
  측정 계약 자체가 기준과 거의 같은 frame 대기를 포함한다. 기준을 바꾸지는 않았다.

### 고친 것

화면 밖 쪽 다시 그리기 정책 하나(`RhwpSurface.tsx`): 편집 뒤에는 보이는 쪽만 바로 그리고, 화면 밖 쪽은 그림이 없어도 입력이 멈춘 뒤
(`REST_DELAY_MS`) 그린다. 모든 쪽을 새로 정할 때(처음·배율·DPR·쪽 수·쪽 크기)는 그대로 모두 바로 그린다. 스크롤·크기 변경으로 보이게
된 쪽은 바로 그리고, 모델 version 검사·작업 취소는 그대로다. 회귀 시험(`repaintScheduling.test.tsx` "처음 그리기를 입력이 끊으면")은
고치기 전 정책에서 실패(2·3·4쪽을 바로 그림)하고 고친 뒤 통과한다.

| 문서 | 그룹 시작 p50/p95 처음→최종(ms) | 이어 쓰기 p95 | Undo p95 | 입력 이벤트 지연 p95 |
|---|---:|---:|---:|---:|
| 작은 HWP | 28/78 → 25/75 | 41 → 32 | 114 → 89 | 2 → 5 |
| 작은 HWPX | 26/83 → 26/74 | 38 → 41 | 148 → 122 | 2 → 2 |
| 24쪽 HWP | 57/124 → 55/68 | 63 → 162 | 127 → 128 | 93 → 2 |
| 60쪽 HWPX | 107/446 → 105/128 | 155 → 124 | 199 → 196 | 158 → 30 |

각 30표본(Undo 25), timeout 0. 한 번의 관측이며 실행 사이 변동이 크다(같은 소스의 60쪽 p95가 233~457 ms로 관측됨). 24쪽 이어 쓰기 p95는
나빠 보이지만 HEAD 동작 빌드의 A/B 실행에서도 123 ms였고 기록 끔 대조도 159 ms라 이 변경에 귀속하지 않는다(**INFERRED**).
**FAIL:** 그룹 시작 50 ms를 모든 문서에서 넘는다. Undo 1500 ms는 통과한다.

### native IME 순서(Stage B)

실제 키·클릭만 쓰는 행렬(`undo_native.py --ime-gap-matrix`): 조합 지연 5가지, Ctrl 먼저 누르기 3가지, 클릭 2가지, 이 화면의
`ibus-engine-hangul` 프로세스를 15~120 ms 멈추기 3가지, Ctrl 뒤 멈추기 3가지, 클릭+멈추기 2가지 × 2회 × HWP/HWPX = 72회.
**VERIFIED:** 72회 모두 순서가 같다: 빈 `compositionend` → 기다림 → `insertFromComposition` → 끝 → Ctrl keydown → Z keydown →
Undo 수락(revision +2). 모두 안전(글자 중복·손실 없음, 앞 거래 보존, 뒤 Redo 복원). 목표 순서(빈 끝과 늦은 최종 글자 사이의 Ctrl+Z)는
0/72(앞선 10회 포함 0/82). **INFERRED:** 이 판에서는 확정을 일으킨 수식 키의 DOM keydown이 입력기 확정 뒤에야 전달된다. 다른 플랫폼·
입력기·판에서 그 순서가 생기는지는 **UNVERIFIED**이며 불가능하다고 보지 않는다. 코드 변경 없음(결함 재현 없음).

### 렌더러 캐시(Stage C)

고정 `web_canvas.rs`: `IMAGE_CACHE`(`HtmlImageElement`)와 `DECODED_CANVAS_CACHE`(디코드한 detached Canvas, 디코드 실패는 `None`
음성 항목)는 WASM 스레드 전역이다. 키는 그림 바이트의 FNV-1a 64 해시 하나(길이·충돌 확인 없음)라 여러 문서가 같은 항목을 함께 쓴다.
정리는 항목이 200개를 넘을 때 모두 지우는 것뿐이고 바이트 예산·문서 해제 API가 없다. 문서 닫기에서 지우면 다른 열린 문서의 항목도
지우게 되므로 문서별 해제 대신 **전역 바이트 예산**을 택했다.

별도 upstream 패치(`evidence/t010-followup/upstream-rhwp-bounded-image-cache.patch`, submodule 밖 clone, **통합하지 않음**):
`surface_cache.rs`의 LRU(바이트 계상: Canvas `너비×높이×4`, 음성 항목 고정 64 B·개수 한도), 내보낼 때 Canvas 크기 0으로 즉시 해제,
예산 1/4을 넘는 그림은 보관하지 않고 그린 뒤 해제, 같은 키 교체 시 이전 값 해제, 키에 길이와 표본 해시 추가, 공개 API
`rendererCacheStats()`·`trimRendererCaches(maxBytes)`·`setRendererCacheBudget(...)`. 기본 예산 Canvas 256 MiB·이미지 64 MiB·각 256개.

**VERIFIED(headless Chrome, 같은 WASM API, 픽셀 추정):** 이미지가 많은 공개 예제 5개를 3회씩 열고 모두 그리고 닫았을 때 고정 엔진은
detached Canvas 96개·477.6 Mpx(RGBA 약 1.8 GiB)를 계속 붙잡았다. 패치는 12~13개·약 66 Mpx(≈ 예산)에 머물렀고, 두 문서를 함께 연 뒤
하나를 닫고 `trimRendererCaches(0)`를 불러도 남은 문서의 모든 쪽 픽셀이 같았다(보존 0). 8 MiB 예산(모든 그림이 한도 초과)에서도 픽셀이
같았다. 단점: 문서 하나의 작업 집합(약 380 MB)이 예산보다 크면 전체 쪽 그리기에서 LRU가 적중하지 못해(적중 0) 다시 그리기가 0.13 s →
2.7 s가 된다. 통합 전에 예산 정책(예: 렌더 예산과 연동)이나 스캔 내성 정책이 필요하다. 패치의 독립 단위 시험 7/7.

**VERIFIED(출하 앱, 고정 엔진):** 30사이클 수명주기에서 문서 핸들·스냅숏·쪽 Canvas는 모두 정리됐지만 전역 캐시의 detached Canvas
21~23개(약 101~103 Mpx)가 닫은 뒤에도 남았다. WASM 메모리 high-water 141.9 MiB, RSS는 편집 사이클마다 늘다 자연히 줄었다(누수로 단정하지
않음). **INCONCLUSIVE:** 출하 앱의 메모리 관문 — 패치는 통합되지 않았고 submodule 판 변경은 이 작업의 권한 밖이다.

### 측정기 결함 수정

`rhwp_poc.click_cell`: 앞 편집의 늦은 화면 변화(SETTLE_MS 500 ms 뒤 판 글자)가 쪽을 약 6.5 px 옮겨, 미리 잰 자리의 클릭이 아래 행 셀에
들어갔다(HEAD 동작 빌드에서도 3회 중 2회). 쪽 Canvas 사각형이 0.7 s 그대로일 때 재고 바로 누르게 고친 뒤 두 빌드 모두 4/4회 6/6.
기대값은 바꾸지 않았다.

### 활성화 관문(최종 시험 빌드)

| 관문 | 판정 | 근거 |
|---|---|---|
| D1 그리기·표 셀·여러 구역 | **PASS** | native 33/33(D1 31 + D5 2), 셀 6/6, 새 다시 그리기 회귀 시험 |
| D2 native ibus-hangul | **INCONCLUSIVE** | 25/25, T007 7/7, T008 7/7, 순서 행렬 72/72 안전. 목표 순서는 native에서 한 번도 관측되지 않음 |
| D3 저장 보존 | **PASS** | 실제 `service::save` Undo/Redo 13/13(위험 출력 게시 0, 원본 SHA 유지), T009 strict 23건 불일치 0 |
| D4 성능·메모리 | **FAIL** | 그룹 시작 p95 75/74/68/128 ms > 50. 메모리: 출하 엔진의 전역 캐시 보존, 패치 미통합 |
| D5 실패 안전성 | **PASS** | 폐기 예외 주입 native 2/2(render 실행 안), 기존 단위 시험 |

일반 빌드(시험 플래그 없음): 번들 표지 0, HWP·HWPX `edit.undo`·`edit.redo` 비활성("이 문서 형식에서 지원하지 않음"), Ctrl+Z·도구 막대
모두 문서를 바꾸지 않음, 시험 훅 노출 없음, e2e 62/62(건너뜀 0, Xvfb `-dpi 96`).

**결정: production 활성화 NO-GO** (D2 INCONCLUSIVE, D4 FAIL). 다음:
1. 60쪽 HWPX의 엔진 몫(`insertText` 다시 조판 27 ms, 레이어 트리 8 ms + 띠 그리기 13 ms)은 고정 rhwp 안이다: 바뀐 영역(damage)을
   알려 주는 엔진 API가 있으면 앱의 레이어 트리 요약이 필요 없다. 시험: 같은 `undo_native.py --perf --native-keys` 표본.
2. 작은 문서 frame 꼬리의 원인 함수: native 표본 추출기(perf/sysprof, ptrace 허용 환경)로 같은 실행을 잰다.
3. 캐시 패치의 예산 정책을 정하고 upstream에 제안한 뒤, 판 갱신 승인 후 통합해 `lifecycle` 시나리오로 출하 앱의 보존 Canvas가 예산
   이하인지 확인한다.
4. D2: 다른 플랫폼·입력기에서 같은 행렬을 돌린다. 이 판에서 순서가 생기지 않는다는 것만으로 PASS로 올리지 않는다.

## T010 캐시 보강: 렌더러 이미지 캐시 교정·예산 정책·지연 귀속·native IME 환경 (2026-10-23)

활성화하지 않았다(레지스트리 그대로). 고정 rhwp·submodule 판·WordCraft는 바꾸지 않았고, 렌더러 캐시는 별도 upstream checkout의
**검토용 패치**로만 고쳤다(geul 미통합). 증거: `tests/integration/rhwp/evidence/t010-cache-hardening/`(README.md, PATCH-README.md).

### 렌더러 캐시 패치의 결함과 교정

앞선 후속의 캐시 패치(`t010-followup/upstream-rhwp-bounded-image-cache.patch`)를 실제 WASM 렌더러로 브라우저에서 돌려(생성
fixture 12 시나리오, Chrome 155·WebKitGTK 2.54.1) 세 결함을 재현했다.

- A: 로드 뒤 크기가 한 항목 한도를 넘는 그림(SVG 2400×2400)을 그리기 직전 `resize`가 내보내며 같은 `HtmlImageElement`(clone은 같은
  DOM 객체)의 `src`를 비워, 그 그리기가 빈 그림이었다. 예산 압박에서 번갈아 그린 두 쪽도 빈 그림.
- B: 자른 그림 경로는 비용을 갱신하지 않아 인코딩 길이(30 KB)로 남았다(실제 디코드 160 KB).
- C: 한도를 넘는 비동기 그림은 보관하지 않거나 바로 내보냈고, 로드 중 다시 그리면 새 요소가 앞 로드를 취소했다. 끝났다는 알림이
  없다. (두 브라우저 모두 같은 data URL을 다시 만들면 바로 그릴 수 있어 "영영 안 보임"은 아니었고, 고정 엔진도 첫 그리기는 빈 그림.)

교정(`upstream-rhwp-bounded-image-cache-v2.patch`): 비용 갱신을 그리기에서 load 이벤트로 옮기고(캐시는 handle을 돌려준 뒤 그리기가
끝날 때까지 바뀌지 않음), 로드 중 항목은 예산·trim으로 내보내지 않으며 다시 만들지 않고, 로드 뒤 한도를 넘는 그림은 다음 자리
요구·trim에서 가장 먼저 나가는 일시 항목, 실패는 음성 항목, 두 그리기 경로는 같은 함수. `setRendererImageLoadListener`가 로드가 끝나면
그리기 밖에서 호스트를 부른다(렌더러는 스스로 그리지 않음 — 닫힌·바뀐 문서에 늦게 그리지 않게). 교정판은 두 브라우저 모두 고정
엔진과 픽셀이 50/50 같고, 원 패치는 Chrome 4·WebKitGTK 3 그리기가 달랐다(빈 그림). Rust 단위 12/12.

### 예산 정책

공개 이미지 많은 표본(23–24쪽, 디코드 약 380 MB)은 문서 하나가 기본 예산 256 MiB보다 크다. geul은 바뀌지 않은 쪽·띠를 다시
그리지 않으므로(paintDiff) 문서 전체 다시 그리기는 열기·배율·DPR·쪽 수 변화 때만 온다. 그 접근 기록으로 정책을 오프라인 비교해
디코드 Canvas 캐시에 입장 제한(TinyLFU 축약: 내보낼 항목보다 자주 요청된 것만 들임, 요청 수 aging)을 골랐다. 브라우저 이미지
캐시에는 쓰지 않는다(들이지 않으면 비동기 로드 뒤 그릴 것이 없음). Chrome 실측(3회, 데워진 전체 다시 그리기 중앙값):

| 예산 | 고정(무제한) | 원 패치(LRU) | 교정 |
|---|---|---|---|
| 128 MiB | 54 ms | 2536 ms | 1446 ms |
| 256 MiB | | 2354 ms | 773 ms |
| 384 MiB | | 2352 ms | 154 ms |
| 512 MiB | | 56 ms | 56 ms |

예산보다 큰 작업 집합에서 교정판도 고정 엔진보다 느리다(256 MiB에서 약 14배). 두 문서를 함께 열면 합친 작업 집합(약 760 MB)이
512 MiB도 넘어 두 번째 문서 다시 그리기가 1.1 s(고정 52 ms). 기본 예산은 올리지 않았다. 384–512 MiB는 당시 측정 후보이며
승인된 기본값이 아니다. 아래 동시성 후속 검사에서 pending·transient 한도 위반이 확인되었으므로 예산 선택보다 소유권 교정이 먼저다.
문서별 소유권이 없는 전역 `trimRendererCaches`를 모든 문서 닫기에 일괄 연결해서는 안 된다.

### WebView 지연 귀속(제품 변경 없음)

시험 훅 빌드에 `rhwp:layer-json` 구간을 더해 쪽 그리기 요약을 엔진 JSON과 JS 요약으로 나눴다. 60쪽 HWPX 묶음 시작: 엔진 텍스트
변경 26 ms + 엔진 layer JSON 7 ms + JS 요약 4–5 ms + 엔진 띠 그리기 12 ms, p95 121 ms(FAIL). 작은 문서는 아무 일도 하지 않는 RAF
사슬의 p95(50–71 ms)에 묶여 있다(77 ms, FAIL). geul JS 몫을 모두 없애도 기준에 닿지 않으므로 제품 코드는 바꾸지 않았다. 필요한
upstream 일: 편집 뒤 바뀐 쪽·영역을 알려 주는 damage API, layer tree를 한 번 만들어 요약·그리기에 함께 쓰기, 텍스트 변경의 부분
재배치.

### native IME 순서(D2)

입력기 환경을 바꿨다: `IBUS_ENABLE_SYNC_MODE=1`·`2`, ibus-hangul `use-event-forwarding=true`, 기본값(각 36회, 합 144회)과 최종 관문의 기본 행렬 72회, 합 216회.
모두 안전, 목표 순서(빈 끝 → Ctrl+Z → 늦은 확정) 0회(누적 0/298). 새 관찰기: 빈 compositionend에서 MessageChannel task를 걸면, 늦은 확정은 그
task보다 늘 먼저 왔다(128/128). 그 사이에 오는 keydown은 Ctrl 자신의 입력기 처리 keydown(`Unidentified`)뿐이었다 — 이 WebKitGTK·ibus
경로에서는 Z keydown이 그 사이에 들어올 수 없다는 근거(INFERRED, 다른 플랫폼 미확인). sync mode에서는 빈 끝 없이 확정이 두 번 오는
새 순서(sync mode마다 포인터 변형 8회 — hwp·hwpx 각 4)가 보였고 글자·revision은 맞았다. 결정적 시뮬레이션(`cancellationBoundary.test.ts`, `imeBoundary.test.tsx`)이
목표 순서의 처리를 계속 확인한다. 결함이 드러나지 않아 IME 제품 코드는 바꾸지 않았다. D2는 INCONCLUSIVE로 남는다.

## T010 동시성 후속 검사 (2026-10-23, 부분 완료·미통합)

[재현 명령](../../tests/integration/rhwp/cache-concurrency/README.md)과
[실행 보고서·새 증거](../../tests/integration/rhwp/evidence/t010-cache-concurrency/README.md)를 추가했다. 기존
`t010-cache-hardening/` 패치와 증거는 보존했다. 이번 후보도 제품에 통합하지 않았으며 T010·T011 의존성과 명령 레지스트리는 그대로다.

**VERIFIED:** 역사적 v2의 pending 예외는 실제 한도가 아니다. 100바이트·2항목에 90바이트 3개를 넣으면 3항목·270바이트,
실제 WASM에서 1,024바이트·2항목에 100개 요청을 보내면 100항목·52,124바이트가 남는다. `trim(0)`·예산 축소도 이를 막지 못한다.
SVG 2개를 2 MiB 예산으로 그리고 load 알림을 RAF로 합치면 Chrome 155와 WebKitGTK 2.54.1 모두 64 load·64 알림·32 draw 제한에 도달했다.
최종 픽셀은 맞아도 캐시가 안정된 것은 아니다. 문서를 닫고 idle 뒤에도 transient 추정 5,856,930바이트가 남았다.

**VERIFIED:** 새 부분 패치 `upstream-rhwp-no-redundant-notify.patch`는 새 이미지가 같은 호출에서 이미 drawable일 때
load 비용을 갱신하고 그 새 요소의 지연 이벤트를 해제한다. 이미 그릴 수 있는 새 요소의 알림이 다시 캐시 miss와 repaint를
일으키는 순환만 막는다. 이전 요청이 대기한 기존 pending 요소의 알림은 유지한다(다른 문서도 기다릴 수 있음).
두 브라우저에서 2 알림·2 draw·4 load 시도와 최종 픽셀 불일치 0을 확인했다.

**FAIL:** 이 부분 수정은 pending 상한·transient의 독립된 수명 제한을 제공하지 않는다. 정상 resident를 밀어내는 정책과
전역 캐시의 문서별 소유권도 해결하지 않았다. 256/384/512 MiB 중 하나를 제품 기본값으로 승인하거나, 문서를 닫을 때마다
전역 trim을 호출할 근거가 없다. 위 역사적 예산 권고는 새 동시성 증거를 통과한 기본값이 아니다.

**INFERRED:** 현재 동기 `renderPageToCanvas`는 먼저 Canvas를 비우며, 이미지 완료 알림은 문서·쪽·세대를 식별하지 않는다.
예산 밖의 이미지를 단순 거절·취소하거나 준비 직후 해제하면 누락·재시작이 생길 수 있다. 무조건 보존하면 지금 확인한 한도
위반이 남는다. 캐시 함수만 바꾸어 두 조건을 모두 보장했다고 주장하지 않는다. 다음 upstream 작업은 유한한 decode 큐와
문서 세대가 있는 렌더 작업을 연결하고, 원래 paint 순서를 보존하며 임시 Canvas에서 완성한 결과만 게시하는 소유권 계약이다.
최소한 pending/resource-limit/complete와 재시도·취소 소유권을 명시해야 한다. 임의의 초대형 페이지를 지원할 수 없으면
불완전한 Canvas 성공 대신 명시적 resource-limit 결과를 돌려주는 계약이 필요하다.

**NOT EXECUTED:** A의 메모리 관문이 실패하므로 geul의 `RhwpEditorSession`·`RhwpSurface`에 listener나 예산을 연결하지 않았다.
기존 `loadRhwpModule(importer)`는 생성 모듈의 전역 API를 노출하지 않으므로, 후속 시험 adapter는 모듈별 listener 하나를
소유하고 살아 있는 session의 현재 세대·보이는 쪽에만 알림을 분배해야 한다. 한 문서 close로 다른 문서의 listener를 지우면 안 된다.
브라우저 primitive 검사는 이 통합의 증거가 아니다.

D2 native 목표 순서는 새 플랫폼에서 관찰하지 못했다. 결정적 replay와 실제 WASM·저장 회귀를 다시 실행했지만 native 증거를
추가한 것으로 세지 않는다. D4 공식 지연 계약(실제 keydown → revision 관찰 RAF → 추가 2 RAF)과 50 ms 기준은 유지한다.
기존 p95 77/77/87/121 ms는 FAIL이며 캐시 알림 교정으로 편집 지연이 해결되었다고 추론하지 않는다.
**RHWP UNDO/REDO PRODUCTION ACTIVATION: NO-GO.**

## T010 격리 resource scheduler 후속 계약 (2026-10-23)

이 절은 `t010-resource-scheduler` 후보의 시험 계약이다. 이전 v2의 “trim은 pending을 취소하지 않는다”는 설명은
그 역사적 패치에만 해당한다. 현 job 후보의 `trimRendererCaches`·예산 변경은 활성 job을 먼저 무효화한 뒤 캐시를
줄인다. 제품 엔진·submodule·명령 정책은 바꾸지 않으며 T010/T011 활성화 상태도 유지한다.

- **Resident와 활성 lease:** cache-only Rc(`strong_count == 1`)만 admission 회수 대상으로 삼는다. LRU 순서로
  필요한 항목만 내보낸 뒤 unique resource 수와 추정 byte 예약을 다시 계산한다. 다른 job의 lease는 해제하지 않는다.
  정상 cache budget/trim도 cache 소유 참조만 놓으며 활성 참조를 강제로 비우지 않는다.
- **한도:** pending decode 2·unique resource 256·job 8·module 추정 browser 소유 256 MiB를 유지한다. URL 예측과
  변환 후 실제 URL 길이를 모두 검사한다. 회수 가능한 resident가 없고 다른 작업이 용량을 놓을 수 있으면 PENDING,
  현재 요청 자체가 한도에 들어갈 수 없으면 RESOURCE_LIMIT다. RSS·decoder·GPU의 하드 상한과는 구별한다.
- **알림:** 마지막 resource 참조 해제와 decode 완료/오류는 지연·합쳐진 알림을 예약한다. mutable RefCell borrow 중
  host callback을 부르지 않는다. 전달 시 현재 pending·count·byte 및 cache-only 회수 가능량을 다시 확인한다.
  이미 다른 요청이 소비한 용량이나 공유 resource의 한 소유자만 취소한 경우를 새 가용량으로 알리지 않는다.
  global invalidate와 기한 만료의 terminal 전환도 host가 관찰할 수 있다. 재귀 poll이나 주기적 진행 재시도는 추가하지 않는다.
- **진행:** host는 정상 알림마다 살아 있는 대기 job을 poll한다. 여러 대기 job의 유한 경쟁·취소 후 진행을 검사한다.
  엄격한 FIFO/동일 CPU 지분이나 무한 신규 요청 아래의 무기한 완료를 약속하지 않는다. 기한 만료는 ERROR이며 정상 취소
  진행을 15초 기한에 의존시키지 않는다. 취소·만료 job을 다시 시작하지 않는다.
- **시험 adapter의 요청 식별:** Canvas 객체·page·유효 scale·문서 generation·modelVersion 전체가 같으면 active/queued
  작업을 재사용한다. 동일 요청은 decode·job·기한을 재시작하지 않는다. 변경된 요청은 교체하며 failed/painted 식별도
  같은 필드를 사용한다. 현 adapter는 full-page mode만 사용하므로 별도 mode 필드는 없다.

실행 범위·정확한 결과·누락은 [새 한국어 보고서](../../tests/integration/rhwp/evidence/t010-resource-scheduler/REPORT.ko.txt)에 기록한다.
D2 native IME 증거 공백, D3/D5 전체 후보 통합 미검증 및 공식 D4 지연 FAIL은 이 소유권/스케줄링 교정과 별도 관문이다.
**RHWP UNDO/REDO PRODUCTION ACTIVATION: NO-GO.**

### Last-active-lease → cache-only 전환 후속 검증

`t010-lease-progress` 격리 후보는 마지막 job lease가 사라져도 resident Rc가 남아 resource destructor가
호출되지 않는 전환을 처리한다. `Job::finish`가 lease 해제 전후 cache-only 회수 가능량을 비교하고,
변화가 있을 때 기존 지연·병합 알림을 예약한다. 공유 소유자만 줄어 가용량이 그대로이면 예약하지 않는다.
대기 job에는 실제 막힌 admission 예약량을 기록하며, 알림 전달 시 count·pending·byte 예산과 회수 가능한
resident를 다시 대조한다. decode 완료만 기다리는 작업이나 필요한 byte 예약보다 작은 해제는 capacity
진행 알림의 근거가 아니다. mutable borrow 안에서 host callback을 호출하거나 주기적 poll을 추가하지 않는다.

최종 후보의 실제 Chrome/WebKitGTK 각 ownership52+scheduler58, native 전체53 및 별도 focused11은
통과했다. 자세한 후보 식별·실패 재현·D3/D5 검증 범위·D4 측정은
[후속 보고서](../../tests/integration/rhwp/evidence/t010-lease-progress/REPORT.ko.txt)를 따른다.
D2 native IME 증거 공백과 D4 지연 실패는 남으며 T010/T011 및 제품 활성화 상태는 바꾸지 않는다.
