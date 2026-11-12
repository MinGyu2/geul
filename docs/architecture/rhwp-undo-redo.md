# rhwp 실행 취소·다시 실행 계약 (T010 Phase 1 설계 2026-10-21 · 고침 2026-10-22 · Phase 2 구현 2026-10-22)

> **2026-11-12 T010 기능 수용 PASS · 일반 RHWP Undo/Redo 제품 GO (명시한 지원 범위).** 일반 제품 빌드(시험 flag·훅 없음)에서 HWP/HWPX 일반 타자·IME Undo/Redo를 켰다(`src/commands/registry.ts`). 지원 범위는 Linux X11(Xvfb)·Tauri 2·WebKitGTK 2.54.1·IBus 1.5.33+ibus-hangul 1.5.5와 기록한 HWP/HWPX 문서다. native 실사용성 16시나리오 705검사, 제품 빌드 native 68검사(저장 파일을 앱 밖 Release 런타임으로 재확인), D1 33/33, D2 지원 환경(원래 안전 25/25·순서 2 INCONCLUSIVE 그대로·추가 34/34·T011 리본 IME 26/26), D3 19/19·strict 23행 0, D4 자원 43/43, D5 4/4가 최종 소스·Release `0559a2ba…`/WASM `94a00e68…`로 PASS다. D4 지연은 독립 **TARGET NOT MET**(재측정 안 함, 경로 불변), E→U→F는 NOT OBSERVED / UNVERIFIED, Windows/macOS/Wayland/다른 입력기는 NOT RUN. T012 고급 명령 제한은 유지한다. [증거·신원](t010-production-activation-2026-11-12.json).

> **2026-11-12 검증기 보강 추가 기록.** 한글 순서·삽입 위치·커서/거래, 내장 제품/Release 신원과 실행별 필수 teardown을 강제하고 음성 대조 및 실제 native 재실행으로 확인했다. 제품 HWP/HWPX 68검사·16저장 oracle PASS, 사용성은 전체 실행의 14 PASS와 교정 후 한글 2 PASS로 16시나리오·716검사 범위를 충족했다. 원래 전체 실행의 하네스 오류 2건과 FAIL은 보존한다. 회귀 24개·실제 Vite fixture 빌드 3개 PASS, 실제 증거 손상 33건 거부 및 재시도 범위는 [별도 증거](t010-validator-hardening-2026-11-12.json)에 기록했다. 원래 활성화 기록·수용 정책·D4 지연/E→U→F 판정은 변경하지 않는다.

> **2026-11-12 D2 Option B:** 현재 D2 규범은 [지원 환경별 native 안전성 계약](../planning/spec.md#t010-d2-supported-runtime-v1)이다. 아래 종전 E→U→F 의무/INCONCLUSIVE는 역사적 판정으로 보존한다. 지원 환경 D2는 실제 native 필수 검사를 통과해 PASS다. 정확한 실행 신원은 [증거 JSON](t010-d2-supported-2026-11-12.json)에 기록한다. E→U→F는 독립 NOT OBSERVED / UNVERIFIED이며 그 순서가 불가능하거나 native 검증됐다고 주장하지 않는다.

<a id="advanced-only-history-20261106"></a>

## 2026-11-06 조건부 고급 명령 기록

T010 전체는 INCOMPLETE, D2 INCONCLUSIVE, D4 FAIL/자원 INCONCLUSIVE다. [사용자 결정](../planning/spec.md#conditional-advanced-20261106)은 D2/D4 선행 완료만 △ 조건부 보류하고 독립 검증한 T012 부분집합의 제품 활성화 작업을 허용한다. 과거 일반 RHWP Undo/Redo NO-GO는 유지하며 아래 날짜별 결과를 소급 변경하지 않는다.

제품은 일반 타이핑/삭제/IME를 기록하지 않는다. 원본 128 KiB 이하·현재 8쪽 이하에서 장평/자간/영속 수식 한 명령을 하나의 coherent history transaction으로 만들고 최대 4단계를 보관한다. 다른 편집 전에 고급 snapshot을 폐기하므로 뒤에 입력한 진짜 한글을 과거 고급 snapshot으로 덮어쓰지 않는다. 빈 기록은 새 snapshot을 찍지 않는다. `forget()`은 초기 선형 메모리 기준과 증가 회계를 재설정하지 않는다. 측정/할당 거부는 명령을 거부한다. 고급 호출이 실제 변경 뒤 예외를 내면 before snapshot 복구·문자 모양 prefix 재조정을 시도한 뒤 uncertain/failed로 격리한다. 복구 성공도 모듈이 건강하다는 보증이 아니며 저장을 막는다. allocation/discard/restore trap은 같은 격리·저장 차단을 따른다. 일반 history 시험 플래그와 원래 D2/D4 하네스는 그대로다.

제품 Undo/Redo는 snapshot `historyScope: advanced`와 실제 고급 기록이 있을 때만 가용하다. 조합·provisional·최종 확정 대기와 backend commit 대기는 거부하고, reload/dispose는 세대/소유권을 무효화한다. 원본보다 이전 Undo snapshot의 문자 모양은 기존 publication prefix/lease 복구 계약으로 보존한다. 일반 RHWP 굵게/기울임 등은 계속 시험 구성 전용이다.

이 부분집합의 Undo/Redo·IME 경계는 일반 Release 빌드와 실제 X11/IBus에서 HWP/HWPX로 검증했다([수용 기록](stage567-acceptance-2026-11-05.md#2026-11-06-advanced-d--conditional-production-implementation)): 고급 명령 Undo/Redo, 조합 중 명령 거부, 한글 입력 뒤 Undo 거부. 이것은 D2의 E→U→F를 관측한 것이 아니므로 D2는 INCONCLUSIVE다. 소문서 명령 응답(입력창 Return→판 갱신 12–29 ms)은 별도 측정 끝점이며 공식 D4 큰 문서 endpoint/50 ms 문턱·자원 수용을 대체하지 않는다.


T010 SC-003의 rhwp 몫(실행 취소·다시 실행)의 계약이다. Phase 2(2026-10-22)에 이 계약대로 세션 기록을 구현했다(맨 아래 "Phase 2 구현").
레지스트리의 `edit.undo`·`edit.redo`는 rhwp에서 아직 `unsupported`이고(활성화 관문 미통과), T010 완료 상태와 T011 선행 조건은 그대로다
([tasks.md](../planning/tasks.md)). 근거는 Phase 0 PoC(`tests/poc/t010-phase0/`, [README](../../tests/poc/t010-phase0/README.md))와
고정 rhwp `1a76570`(v0.8.7) 소스다. 근거의 강도: **VERIFIED**(실행한 시험·읽은 코드), **INFERRED**(근거에서 추론), **UNVERIFIED**.

> **2026-11-05 Stage 5–7 재검증:** D2의 원래 수용 규칙에서 25 PASS/2 INCONCLUSIVE, 필수 empty compositionend→native Undo→late final insertion(E→U→F)은 미관측이다. D4는 제품 WebView에서 기존 표본·문턱(group p95≤50ms, Undo p95≤1500ms)을 적용해 6 PASS/2 FAIL; 큰 문서 두 건의 group 입력이 실패했다. 그러므로 RHWP Undo/Redo 및 metrics·formula 제품 변경은 계속 NO-GO이며, 실제 WASM/controlled command 결과를 제품 수용으로 보지 않는다. 현재 실행과 T012/T013의 상태는 [통합 수용 보고서](stage567-acceptance-2026-11-05.md)에 기록했다. 아래 날짜별 행렬의 수치는 당시 신원에 한정하며 이번 측정 수치는 링크한 최신 기록을 따른다.

2026-10-22 고침(검토 지적 다섯 가지): ① 할당이 대기 중인 실행 취소의 대상을 지울 수 있었다(§5, 반례 재현) ② `recordMutation()`마다 단계를
닫는 규칙과 타자 묶기가 모순이었다(§3·§6) ③ 깊이 식의 clamp가 "4 미만이면 끔"을 막았다(§10) ④ `saveSnapshot` 예외를 무해하다고
보았다(§9) ⑤ 다시 실행이 할당하는 구조였다(이제 할당하지 않음, §5). 고친 알고리즘은 시험 전용 모델 `tests/poc/t010-phase0/history_model.mjs`로
실제 WASM에서 실행했다(§11).

<a id="t010-current-status"></a>

<a id="t010-current-policy-20261112"></a>

## 현재 T010 판정 — 기능 수용과 성능 목표 분리 (2026-11-12)

[기능 완료 정책](../planning/spec.md#t010-acceptance-policy-20261112)은 기능·안전·자원·native 실사용성의 필수 증거를 성능 목표와 분리한다. D4 지연 미달은 독립 `TARGET NOT MET`이며 원 benchmark FAIL·수치·assertion은 바꾸지 않았다. 성능 목표가 미달이어도 모든 필수 조건이 검증되면 기능 완료는 가능하다. 확인된 안전/정확성 실패는 차단하고, 필수 증거가 빠지면 INCONCLUSIVE/NOT RUN으로 남긴다.

| 현재 차원 | 판정 | 범위·영향 |
|---|---|---|
| D1 렌더·커서 | **PASS — 현재 신원 (2026-11-12 Phase 1)** | native 원본 `undo_native.py --render --native-keys` 33/33 관문; 교정 2건 뒤 Release `97abf6bd…`([Phase 1](#t010-phase1-20261112)) |
| D2 지원 환경 IME 안전성 | **PASS — X11/IBus 명시 범위** | 모든 필수 native 안전성 증거 필요. [새 증거](t010-d2-supported-2026-11-12.json). 종전 Phase 2 INCONCLUSIVE와 중복 교정 이력은 [보존](#t010-phase2-20261112) |
| D2 E→U→F 호환성 | NOT OBSERVED / UNVERIFIED | 역사적 관측 0. 원래 predicate/assertion 보존. 관측되는 지원 환경에서는 native 안전성 통과 필수 |
| D3 저장 보존 | **PASS — 현재 신원 (2026-11-12 Phase 1)** | `undo_save.py --release` 19/19, strict 저장 23행 CURRENT0/DESIRED0, Rust 저장·복구·세션 304/0. 4행은 이력과 무관한 T009 정책 거부로 판정(기준 출력과 근거·바이트 동일) |
| D5 실패·복구 | **PASS — 현재 신원 (2026-11-12 Phase 1)** | 실제 WASM 경계 18/18, 통합 시험 3구성, PoC 50/50, native discard 예외·새 세대 reload 4/4 |
| D4 자원·메모리 안전 | **PASS — 현재 신원 (2026-11-12 Phase 3)** | 엔진 전역 그림 캐시의 문서별 소유·해제 교정 뒤 native 수명주기 43/43(소유 참조·화면 Canvas·엔진 보유 Canvas 0, WASM warm-up 뒤 증가 0). RSS는 규범 기준이 없어 진단으로만 기록([Phase 3](#t010-phase3-20261112)) |
| Native 실사용성 | **PASS — 2026-11-12 제품 활성화** | 일반 history 제품 구성 native 16시나리오 705검사(영문·한글 IME·한/영 전환·선택·문단/쪽 경계·빠른 입력·렌더 대기 중 편집·문서 전환·닫기·저장/재열기·복잡 문서) + 제품 빌드 68검사([증거](t010-production-activation-2026-11-12.json)). 이전 판정: INCONCLUSIVE(증거 부족) |
| D4 성능 | TARGET NOT MET — 기존 공식 FAIL | 목표·원 표본/fixture/workload/warmup/3RAF/평가법 고정; 기능 수용과 독립 보고 |
| T010 전체 기능 / 제품 일반 RHWP Undo/Redo | **PASS / GO (2026-11-12, 지원 범위)** | D1 33/33·D2 지원 환경(25/25·34/34·T011 26/26)·D3 19/19·strict 0·D4 자원 43/43·D5 4/4를 최종 소스로 재실행. Windows/macOS/Wayland/다른 IM NOT RUN, E→U→F UNVERIFIED. T012 제한 유지. 이전: INCOMPLETE / NO-GO |

이 표는 2026-11-12 현재 정책 적용 요약이며 과거 D1–D5 표와 날짜별 증거를 수정하지 않는다. 아래 2026-11-01/02 절의 “단일 요약” 및 일괄 성능 관문 표현은 당시 판정으로 보존하며, 앞으로의 완료·활성화 집계는 위 새 정책이 우선한다. D4 producer/evaluator의 PASS/FAIL·종료 코드는 기능 완료 판정이 아니므로 그대로 유지한다. 성능 정책 개정만으로 제품 활성화가 승인되지 않으며, 활성화할 기능의 별도 정확성·안전·자원·usability 근거가 필요하다.

<a id="t010-production-activation-20261112"></a>

### 일반 RHWP Undo/Redo 제품 활성화 (2026-11-12)

**구현.** `src/commands/registry.ts`의 RHWP `edit.undo`·`edit.redo`를 시험 flag 없이 `supported`(범위 표시 없음)로 선언했다. 세션은 일반 타자·IME 기록을 만들고, 가용성은 그대로 세션 상태(편집 가능·IME 트랜잭션 없음·단계 유무·limit·세대)와 실행 직전 재확인으로 정한다. T012 고급 명령은 같은 기록에 들어가되 원본 128 KiB·현재 8쪽·commit 대기 거부를 일반 모드에서도 유지한다(`RhwpEditorSession.advancedSourceLimited`). 일반 RHWP 서식은 시험 전용 그대로다.

**발견·교정한 기존 결함.** `f78acf7`이 초점 유지형 리본 누름을 `ImeInput.pointerDown()`에 연결해, 보이는 조합을 앱이 확정하고 WordCraft에 `mark` 연산을 보냈다(HEAD에서 T011 단위 시험 6건 실패). `ImeInput.commandPointerDown()`은 조합·커서·소유권을 두고, 조합으로 막 확정한 글자가 있을 때만 reset 반복 방어를 건다. 단위 1441/1441, native T011 리본 IME 26/26, D2 busy-button/busy-click PASS.

**Native 실사용성(일반 history 제품 구성, `VITE_GEUL_TEST_HOOKS=1`만).** `scripts/tests/native-t010-usability.py`: HWP/HWPX 각 8시나리오(영문 연속·Undo/Redo·리본 단추·가지 무효화, 한글 IME·한/영 전환·확정 직후/조합 중 Ctrl+Z, 선택 교체·caret, 빠른 Return 40회로 쪽 경계·렌더 대기 중 편집·기록 깊이·빠른 Undo/Redo 10회, 문서 전환(일반·조합 중), 버리고 닫기·재열기, Undo/Redo 뒤 저장·재열기, 복잡 문서 `aift.hwp`(74쪽, 기존 화면 메모리 한도로 50%)·`연구노트(화학).hwp`·`3249937_asset_management_rules.hwpx`(50%)) 16/16, 705검사 PASS. 큰 문서에 ~140키/초로 110키를 넣으면 native 큐가 키당 약 65–95 ms로 소화해 7.1–10.5초 뒤 수렴한다(손실·중복 0, 적용 지연 ≤2, D4 TARGET NOT MET과 일치). ~16키/초에서 HWP는 대기열이 없고 큰 HWPX는 마지막 키 1.8초 뒤 수렴했다. 기록 깊이 한도에서는 가장 오래된 단계만 버려지고 Redo는 끝 상태로 정확히 돌아온다.

**제품 빌드.** `npm run build`(시험 flag 없음) → Release 자산 검증 → `cargo build --features tauri/custom-protocol` 앱 `8c93a0d6…`(`tauri://localhost`, 시험 훅·trace 없음). `scripts/tests/native-t010-production.py`가 HWP/HWPX 각 34검사·저장 8회: Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z/리본 단추, 한글 IME, 가지 무효화, 재열기 뒤 빈 기록, 두 문서 기록 격리. 내용은 앱이 저장한 파일을 앱 밖 Release 런타임(`scripts/tests/rhwp-paragraphs.mjs`)으로 다시 읽어 확인했다.

**하네스 교정(제품 변경 아님).** Redo는 각 상태의 caret checkpoint를 복원한다(기대값 수정), 상태 훅의 200자 절단, End=시각 줄 끝, 쪽 요소 대기, D1 러너 pinned probe, IBus 소켓 경로 길이, 비IME 게이트의 입력기 없는 구성(Phase 1과 같음). 원시 기록은 비공개 `geul-tests/reports/t010-production-activation-20261112/`에 있다.

<a id="t010-d2-supported-20261112"></a>

### Phase 2 — 지원 환경 native 안전성 PASS (2026-11-12, Option B)

사용자 승인으로 [전향적 D2 정책](../planning/spec.md#t010-d2-supported-runtime-v1)을 적용했다. 종전 순서 관문은
[기존 Phase 2 INCONCLUSIVE](#t010-phase2-20261112) 그대로 보존한다. 이번 판정은 **지원 환경 D2 PASS**,
**E→U→F NOT OBSERVED / UNVERIFIED**, 다른 환경 NOT RUN/UNVERIFIED다. T010 INCOMPLETE·일반 history NO-GO와
D4 성능 TARGET NOT MET(원 목표50ms/1500ms)은 별도이며 바뀌지 않았다.

Linux 7.2.14-arch1-1 x86_64, X11/Xvfb 21.1.23, Tauri 2 debug native host+Vite, WebKitGTK 2.54.1/GTK 3.24.52,
IBus 1.5.33/ibus-hangul 1.5.5 두벌식·preedit 및 실제 한/영 전환에서 검사했다. 일반 history는 시험 flag 두 개를 켠 구성이다.
RHWP gitlink `1a76570…`·16패치·Release `0559a2ba…`·WASM `94a00e68…`, native host `4c88dee8…`와 수정된
프런트엔드 소스 SHA를 [작은 증거 JSON](t010-d2-supported-2026-11-12.json)에 연결한다. 문서 범위는 생성된 basic-ko HWP/HWPX의
첫 문단과 소유권 대조용 새 DOCX다. 다른 문서·제품 일반 빌드·물리 데스크톱·Wayland·다른 OS/IM에는 확대하지 않는다.

실제 native 원래 하네스는 안전 관문25 PASS, 순서 관문2 INCONCLUSIVE(종료1)를 냈다. 원래14개 trial은 E→F→U였고 안전했다.
새 하네스의 필수34개(각 형식17개)도 모두 PASS다. 본문·모델·revision·커서/Undo 단위·초점·탭·close/reload·세대·양방향
RHWP/WordCraft 소유권·취소 뒤 새 입력을 검사했다. reload는 지원되는 실패→폐기 확인→새 세대 복구 UI를 실제 native로 실행했다.
추가 trace의 trusted 입력·drop0·모델 세션 귀속도 검사했다. 분류 회귀16개(사용자 지정8경우 포함), TypeScript, 공유 IME/초점79개 PASS다.

새 결함은 **바쁜 UI에서 리본 Undo 단추 mousedown 뒤 IBus의 시작 없는 같은 글자 reset 확정이 두 번 들어간 것**이다.
기존 페이지 클릭의 resetRepeat 교정은 유효했지만, 초점을 유지하는 외부 단추/탭 누름이 그 경계에 연결되지 않았다.
`textInput.ts`는 붙은 textarea의 컨트롤러를 WeakMap으로 연결·해제하고 `CommandButton/editorFocus.ts`는 같은
`ImeInput.pointerDown()` 경계를 전달한다. 조합 ownership/awaiting-final/취소/세대 가드는 유지한다. 두 실제 Undo 요청은 두 단계,
두 Redo는 접두 거래와 확정 거래를 차례로 복원해야 하며 중복 revision은 허용하지 않는다.
수정 전 native `supplement9`와 공유 합성2건에서 재현했고, 수정 후 native busy key/click/button과 공유 회귀가 통과했다.
HWP/HWPX busy-click에서 각각 trusted `compositionend('가')` 3회(첫 확정·reset 반복·의도적 새 입력)를 관측했지만 본문·revision은
정확했다. 새 같은 음절·다른 글자·일반 키·새 compositionStart·문서 전환/새 세대 입력도 보존했다.

최종 별도 집계 `d2_acceptance.py`는 원래25개 관문/14trial 및 명시된34개 native 행·필수 assertion·실행 신원을 요구한다.
누락·중복 신원·불완전 trace·합성 전용 증거는 PASS가 될 수 없고 모든 확인된 안전성 실패는 FAIL이다. 원래 predicate는 변경하지 않았다.
추가 행에는 이후 의도적인 새 조합도 있으므로 원 predicate는 동일 조합의 빈 끝→첫 final 구간에 적용한다(다른 조합의 E/F를 짝짓지 않음).
그 구간에서 새 E→U→F가 관측되면 원래 native assertion이 없을 때 INCONCLUSIVE로 차단한다.

비공개 원시 증거는 `../geul-tests/reports/t010-d2-supported-20261112/`에 있다. 초기 환경/하네스 오류와 FAIL도 남겼다.
세션별 모델 observer 교정 전에는 마지막 hitTest 모델을 다른 탭과 비교한 오류가 있었고, 첫 전체 실행의 cross-editor 실패는
고정 클릭 좌표가 상태 표시줄에 도달한 준비 오류였다. 최종 하네스는 살아 있는 실제 모델을 세션에 연결하고 보이는 페이지 적중과
textarea 초점을 native 입력 전에 확인한다. 이전 실패를 PASS로 덮어쓰거나 합산하지 않았다. 최종 baseline2+supplement-final3만 집계한다.

<a id="t010-phase1-20261112"></a>

### Phase 1 — D1·D3·D5 현재 신원 재확인과 교정 (2026-11-12)

**판정: D1 PASS, D3 PASS, D5 PASS(모두 아래 현재 신원).** T010 전체는 D2·D4 자원·native 실사용성 때문에 계속 INCOMPLETE이고,
일반 RHWP history 제품 활성화는 NO-GO다. T012 고급 전용 범위는 바꾸지 않았다. D2/D4 판정과 성능 수치는 이 절에서 다루지 않는다.

**과거 근거의 재사용 판단.** D1 PASS(`d1ec335`, Release `ca284e06…`)와 D3/D5 PASS(`9cd7484`, Release `853a0689…`, 패치 11개)는
그 신원에서만 유효했다. 시작 HEAD `070b4f3`까지 157개 커밋이 있었다. 그 사이 패치 5개(글자 모양 정리·게시, 표 수식 2개,
HWP 원본 보존)와 RHWP 세션·기록·저장 코드가 바뀌어 재사용할 수 없었다. 그래서 원래 시험을 현재 신원에서 다시 실행했다.
과거 PASS는 지우지 않는다.

**재실행으로 드러난 결함과 교정(제품 변경).**

| # | 재현 | 원인 | 교정 | 검증 |
|---|---|---|---|---|
| A | D3 `undo_save.py`: 공개 다중 구역 `aift.hwp`에서 Undo를 하면 편집기가 uncertain으로 멈춘다. 편집 없이 연 문서에서도 `reconcileCharShapePrefix`가 `incompatible published character shapes`를 낸다 | 한컴 저장본은 글자 겹치기(`CharOverlap`)의 "모양 없음"을 `0xFFFFFFFF`로 쓴다(aift 9개, issue6031 HWPX 27개, native 진단으로 확인). 글자 모양 방문기가 이것을 참조로 보고, 게시 재조정이 dangling으로 거부한다. 기록 복원·롤백(`7825e94`, 2026-11-06 이후)이 모두 이 재조정을 거친다 | `char-shape-compaction.patch` 방문기가 번호 머리 표지처럼 `CharOverlap`의 `0xFFFFFFFF`를 건너뛴다. 문단 글자 범위의 같은 값은 계속 dangling으로 거부한다(기존 시험 유지). 정리(compaction)는 이런 문서에서도 더는 dangling으로 건너뛰지 않으며, 그 값은 바꾸지 않는다 | native rhwp 시험 13개 PASS(새 2개는 교정 전 FAIL 확인) |
| B | native D1 `hwp: Ctrl+Y·Ctrl+Shift+Z·Ctrl+Y` → 편집 뒤 그림과 9,191 px 차이. HWPX는 PASS | `9b659b0` 이후 HWP 내보내기 검사(저장·T014 복구 checkpoint·보존 검사)는 `rebuildLayout()`으로 새 문서 기준 레이아웃을 만든다. 그 레이아웃이 화면에 남아, 입력 없이 checkpoint만으로 쪽 배치가 바뀌었다. 스냅숏 복원은 편집 세션 규칙으로 다시 조판하므로 Redo 화면이 직전 화면과 달랐다(WASM에서 재현: rebuild 뒤 Undo/Redo 결과 = rebuild 전) | `hwp-source-preservation.patch`에 `restoreSessionLayout()`(봉인 그대로 파생 상태 재구성)을 추가했다. `RhwpEditorSession.exportAndCompare`는 비교가 끝나면 편집 세션 레이아웃과 쪽 목록을 되돌린다. 되돌리기 trap은 레이아웃을 알 수 없으므로 uncertain·편집 중지·근거 불통과로 끝난다 | 단위 2개(순서, trap fail-closed); 실제 WASM `export-layout.wasm.test.ts` 3개(전제: rebuild만 하면 레이아웃이 달라짐 / 내보내기 검사 뒤 화면 레이아웃 그대로, Undo·Redo 동등 HWP·HWPX); native D1 33/33 |

**시험 기대 갱신(근거를 남김, 원본 사본: 비공개 `phase1/../originals/`).**
- `undo_save.py`의 고정 기대와 다른 행은 이력과 무관한 T009 정책 거부일 때만 인정한다. 조건은 넷이다. 게시하지 않았고, 원본 SHA·디렉터리·dirty를 보존했다.
  같은 내용의 기준 출력(undone=편집 전 내보내기, 그 밖=history 없는 같은 키 재생)이 같은 서비스에서 같은 근거로 거부됐다. undone은 기준과 바이트까지 같아야 한다.
  해당 행은 4개다. `aift.hwp` 3상태는 `outputMalformed{DocInfo}`로 거부됐다. 원인은 `3363fde` 좁은 삽입 증명의 `basic_bullet`이 한컴 글머리표 레코드를 표준 길이로 인정하지 않는 것이다.
  편집 전 내보내기도 같은 근거로 거부된다. `cell-hwp` redone은 `recordsChanged`+`previewStale{PrvImage}`이며 history 없는 재생과 바이트가 같다. 모두 fail-closed이며 원본을 보존했다.
- strict 저장 `hwp-bold-body`는 거부에서 게시로 바꿨다. 덧붙인 `CHAR_SHAPE`가 원본 #7과 바이트까지 같고, T012 Stage 5 규칙(`805ffc5`)이 받는 경우다. italic은 계속 거부된다.
- `history-config`·`hangul-tools`의 제품 기본 전제를 승인된 T012 범위(`340f54d`)에 맞췄다. 제품 레지스트리 RHWP Undo는 `historyScope:"advanced"`이고, 일반 입력의 `saveSnapshot`은 0회다.
  일반 history Undo는 거절된다. 장평·자간 시험은 문서화된 시험 활성화 flag에서만 실행한다(통과).

**현재 신원과 실행 결과(모두 최종 신원).** geul 소스 = `070b4f3` + 이 Phase 1 변경, RHWP `1a76570e…` + 16개 패치
(sourceTree `0fbbd1c1…`), Release generation `97abf6bd9997e28a12694c05fa53018303b64ecac4df643cfae0c2572dee2a32`
(WASM `18eeb2e8…`, JS `284a5bab…`), native debug 앱 `4c88dee8…`, WebKitGTK 2.54.1, Xvfb 21.1.23, wasm-bindgen 0.2.127, Rust 1.99.1.

| 범위 | 명령(비공개 근거 경로 `geul-tests/reports/t010-phase123-20261112/phase1/`) | 결과 |
|---|---|---|
| D3 Undo 저장 | `undo_save.py --release` | 19/19 일치(게시 11·거부 8, 위 4행 이력 무관 거부) |
| D3 strict 저장 | `save_service.py --release --strict-desired` | 23행 CURRENT 0 / DESIRED 0 |
| D3 Rust | `cargo test --lib -- services::save services::recovery document::`(0700 TMPDIR) | 304 PASS / 0 FAIL / 28 ignored |
| D5 실제 WASM | `history_boundary.mjs` / PoC vitest | 18/18 / 50/50 |
| D1·D5 통합 | rhwp 통합 vitest 기본·history 활성·서식 활성 구성 | 46 PASS(9 skip) / 34 PASS(1 skip) / 12 PASS(3 skip) |
| 공통 | `vitest run src/`, `tsc --noEmit`, `eslint .` | 1429/1429, 0, 0 |
| D1 native | 원본 `undo_native.py --render --native-keys`(공유 probe 모듈 동일성 수리만, 창 1280×1024) | 31 항목 / 33 관문 PASS |
| D5 native | `undo_native.py --failure-safety --native-keys` | 4/4 PASS(HWP·HWPX discard 뒤 예외, 새 세대 reload) |

실패 기록은 지우지 않았다: 교정 전 D3 FAIL `d3-undo-save-release.before-fix-907eabb2.FAIL.log`, 고정 기대 4건 불일치 `…fixedtable-4mismatch.*`,
native D1 FAIL `native/d1-native-62e15b0b-FAIL/`, 중간 Release `62e15b0b…` 결과 `superseded-62e15b0b/`.
신원·해시 상세는 [t010-phase1-acceptance-2026-11-12.json](t010-phase1-acceptance-2026-11-12.json)에 있다.

<a id="t010-phase2-20261112"></a>

### Phase 2 — native D2 E→U→F 재조사 (2026-11-12): INCONCLUSIVE 유지, 중복 입력 결함 교정

**판정: D2 INCONCLUSIVE.** 원래 predicate·assertion(`scenario_ime_gap`, `scenario_ime_gap_matrix`의 E<U<F 판정과 safe 조건)은
바꾸지 않았다. 과거 관측(E→F→U·취소 경로)을 PASS로 다시 세지 않는다. Phase 2 완료 커밋은 없다.

**새로 시험한 기전(모두 실제 X11/XTest·IBus 1.5.33·ibus-hangul 1.5.5·WebKitGTK 2.54.1, 합성 DOM 이벤트·isTrusted 위조 없음).**
1. **Undo 명령 단추의 native 누름(`button`).** `CommandButton`은 편집기 초점을 유지하고, 클릭이 아니라 누름에서 입력기가 확정한다(`editorFocus.ts` H1).
   그래서 단추의 Undo 요청이 확정 두 반쪽 사이에 끼는지 보았다. 결과는 HWP/HWPX 각 2회 모두 E→F→U였다. 확정은 mousedown에서 끝났고 요청은 click에서 왔다.
2. **입력기(ibus-engine-hangul)를 SIGSTOP한 채 단추 누름(`buttonStall` 20·80 ms).** 기존 `pointerStall`의 Ctrl+Z는 입력기를 거쳐 늦게 온다.
   단추 클릭은 입력기를 거치지 않는 포인터 이벤트라는 차이를 이용했다. 결과는 HWP/HWPX 각 10회(5 cycle)+2회 모두 E→F→U였다. 엔진이 멈춰 있어도 E와 F가 클릭보다 먼저 왔다.
   해석(INFERRED, 소스 대조): GTK IBus 문맥은 PREEDIT_COMMIT 모드의 남은 preedit를 reset 때 엔진 없이 직접 확정한다. 그래서 포인터 경로의 E·F는 같은 UI 반복 안에서 끝난다.
3. **UI 프로세스 main loop 정지(바쁜 앱, `appStallKeyButton` 0·30·120 ms).** 앱 프로세스를 SIGSTOP한 동안 Ctrl+Z와 단추 누름을 X에 쌓은 뒤 재개했다.
   E<U<F는 0회였다. 대신 **같은 음절이 두 번 확정되어 `가가`가 들어가는 결함**을 관측했다(Undo 없이 End+클릭으로도 3/3 재현).
   순서는 키의 엔진 flush 확정(빈 끝 → `insertFromComposition` 가 → 끝) → mousedown → GTK IBus reset의 남은 preedit 재확정(229 keydown → 조합 시작 없는 `insertFromComposition` 가 → 끝)이다.

키 경로는 ibus-hangul이 수식 키를 넘기기 전에 flush·commit하므로 commit(F)이 forward key(U)보다 앞선다(2026-11-01/06 근거와 같음).
포인터 경로는 위 2의 로컬 확정 때문에 E·F가 클릭 처리보다 앞선다. 이번 환경에서 E→U→F를 만들 근거가 있는 기전은 모두 시험했다.
다른 runtime·입력기(XIM은 2026-11-04 기각, fcitx·Wayland는 미설치/미지원)나 E→U→F의 일반적 불가능성은 입증하지 않았다(UNVERIFIED).

**교정(공유 IME, RHWP·WordCraft 공통 `imeInput.ts`).** 조합으로 끝난 확정 직후 클릭은 `resetRepeat` 기록을 남긴다. 그 뒤 229 keydown만 지나
조합 시작 없이 오는 **같은 글자**의 `insertFromComposition`과 그 끝은 소비한다. 다른 글자, 클릭 없는 같은 글자, 사이에 낀 일반 키는 새 입력으로 받는다.
preedit 플랫폼의 새 입력은 조합 시작·조합 입력과 함께 오므로 같은 음절을 다시 친 경우는 남는다. 기존 WebView 확정·XIM 재확정 규칙과 같은 꼴이다.

| 검증 | 결과 |
|---|---|
| 재생 단위 시험(실측 순서) | RHWP 2·WordCraft 1, 교정 전 FAIL → 교정 후 PASS; `vitest src/` 1432/1432, tsc·eslint PASS |
| native 중복 탐침(교정 뒤, End+클릭 바쁜 UI) | 3/3 `가` 한 번·revision +1 (교정 전 `가가`·revision +2) |
| native 공유 IME 회귀(Phase 6 `native_ime.py`) | RHWP 7/7, WordCraft 7/7(창 초점 이동은 과거와 같이 NOT RUN) |
| native RHWP IME·Undo(`--ime`, 시험 활성화 history) | 25/25 |
| 원래 D2 관문(교정 뒤 `--ime-gap` 7모드, 행렬 20모드) | HWP·HWPX safe, E<U<F 0 → INCONCLUSIVE |
| 교정 전 행렬(`--ime-gap-matrix` 5 cycle) | 형식별 100회 safe, E<U<F 0 |

`appStallKeyButton`은 Ctrl+Z와 단추로 Undo를 두 번 요청하므로 행렬의 단일 Undo safe 조건과 맞지 않는다. 그래서 행렬 모드에서 뺐고, 그 결과(교정 전 UNSAFE 6행: 중복 확정)는 보존했다.
환경 신원: Release `97abf6bd…`, debug 앱 `4c88dee8…`, IBus 1.5.33·ibus-hangul 1.5.5. 원시 trace·실패·인프라 오류(엔진 미설정, socket 경로 길이)는
비공개 `geul-tests/reports/t010-phase123-20261112/phase2/native/`에 있다(`d2-gap-2`, `d2-matrix-1`, `d2-matrix-2`, `dup-probe-1`, `dupfix1`, `ime7`, `ime25`, `gapfin`, `mtxfin`).

<a id="t010-phase3-20261112"></a>

### Phase 3 — D4 자원·메모리 안전 (2026-11-12): PASS, 엔진 그림 캐시 소유 교정

**판정: D4 자원 PASS(아래 범위·신원).** D4 지연(group-start p95 ≤ 50 ms, Undo ≤ 1,500 ms)은 독립 성능 항목이다. 이번에 재측정하거나 바꾸지 않았고, 기존 공식 FAIL / TARGET NOT MET을 유지한다.
history 256 MiB 회계·깊이·HEADROOM, Canvas 16 Mi px/쪽·32 Mi px/surface, FULL_PAGE_ONLY, fail-closed·취소·소유 계약은 그대로다. 새 RSS 문턱은 만들지 않았다.

**재현한 결함(교정 전, 원래 `undo_native.py --lifecycle`, 문서당 3모드 × 6 cycle).** 문서 핸들·snapshot 참조·화면 Canvas는 매번 0이었다.
그러나 rhwp `web_canvas.rs`의 WASM 스레드 전역 `DECODED_CANVAS_CACHE`·`IMAGE_CACHE`는 개수 200 상한만 있고 바이트 예산·해제 경로가 없다.
그래서 모든 문서를 닫은 뒤에도 엔진이 detached Canvas 21~23개(100.8~102.9 Mpx, RGBA 약 400 MB)를 붙들었다(externref 표 스캔). 32 Mi px surface 예산의 약 3배다.
WASM 선형 메모리는 142.4 MiB에서 멈췄다. RSS는 열기·닫기만 해도 605→1002 MB로 올라갔다(비공개 `phase3/lc0`).

**교정(`hwp-source-preservation.patch`에 합침, 패치 16개 유지).** 신원 검증기가 패치 수를 16으로 제한하고, `9b659b0`도 그 수를 유지하려고 합쳤다. 그래서 같은 방식을 따랐다.
- 각 `HwpDocument`가 하나의 `RendererCacheOwner`를 갖는다(복제 불가). 그 문서가 만드는 모든 `WebCanvasRenderer`(전체·부분·작업 경로 5곳)가 그린 캐시 키에 소유자를 기록한다.
- 문서를 해제(`free`/Drop)하면 그 소유를 풀고, 살아 있는 다른 문서가 그리지 않은 항목을 두 캐시에서 지운다. 디코드 Canvas는 크기 0으로 backing store를 즉시 돌려준다.
- 기존 개수 상한(200)으로 비울 때도 Canvas를 즉시 돌려준다. 관측용 `rendererCacheStats()`를 추가했다.
- 열린 문서가 실제로 그리는 그림 집합(working set)은 남긴다. 다시 디코드하는 성능 비용을 만들지 않으며, 여러 문서가 공유하는 항목은 마지막 소유 문서가 닫힐 때까지 남는다.

| 검증(Release `0559a2ba…`, debug 앱 `4c88dee8…`, WebKitGTK 2.54.1) | 결과 |
|---|---|
| 원래 수명주기 `--lifecycle --cycles 6`(화학 HWP·자산 HWPX × 열기/닫기·기록 끔 대조·편집 Undo/Redo) | 43/43 PASS. 매 닫힘 뒤 문서 핸들·snapshot·화면 Canvas 0 |
| 엔진 보유 Canvas·그림 캐시(모든 문서를 닫은 뒤) | 교정 전 21~23개 / 101~103 Mpx → 교정 뒤 0 / 0 / 소유 키 0 |
| 두 문서 공유(자산 단독 → 닫기 → 화학+자산 → 화학 닫기 → 자산 닫기) | 소유 키 2 → 0 → 9 → 2(자산 단독과 같음) → 0, 엔진 Canvas 2 → 0 → 9 → 2 → 0 |
| WASM 선형 메모리 | high-water 142.4 → 97.2 MiB. 각 모드 2번째 cycle 뒤 닫힘 값이 바이트까지 같음(재사용, 증가 0) |
| RSS(WebKitWebProcess, 진단) | 화학 열기/닫기 닫힘 RSS가 매 cycle 377~400 MB로 돌아옴(교정 전 605→1002 상승). 편집 모드는 톱니 모양으로 오르다 크게 내려감(예 1585→959, 1182→697 MB). 단조 증가 없음. 규범 기준이 없어 PASS/FAIL로 쓰지 않음 |
| 수명주기 자리표 관문 | 전에는 항상 INCONCLUSIVE였다. 이제 구조 근거(매 닫힘 엔진 Canvas·캐시 0, warm-up 뒤 WASM 증가 0)로 판정한다. 교정 전 lc0 자료에서는 엔진 Canvas 21~23이므로 이 조건이 FAIL이다 |

snapshot 회계·깊이·실패 경계(실제 WASM `history_boundary` 18/18, 단위 시험), render 작업·취소·lease·해제(src 1432/1432), 실패·reload 정리(D5 native 4/4)는
같은 최종 신원에서 다시 통과했다. 2D Canvas context loss를 처리하는 코드와 시험은 없다(기존 계약 밖이며 미관측). 이번에 PASS로 세지 않는다.
비공개 근거: `geul-tests/reports/t010-phase123-20261112/phase3/`(`lc0` 교정 전, `lc1`·`lc2` 교정 뒤, 원본 시험 사본 `originals/`).
최종 신원 회귀(같은 Release `0559a2ba…`): native D1 33/33, native D5 4/4, `undo_save` 19/19, strict 저장 23행 불일치 0,
통합 vitest 46/34/12 PASS, `history_boundary` 18/18, PoC 50/50(비공개 `final/`). 신원·결과는 [t010-phase3-acceptance-2026-11-12.json](t010-phase3-acceptance-2026-11-12.json)에 있다.

## 현재 수용 상태와 기술 보류 (2026-11-01 · 2026-11-02 재평가)

**T010: INCOMPLETE — ON HOLD / 제품 RHWP Undo/Redo: NO-GO / T011: NOT STARTED.**
`INCOMPLETE`가 실제 수용 상태다. `ON HOLD`는 현재 근거로 정당화된 추가 조사·구현을 중단했다는 **추가 관리 표지**이며,
완료·수용 면제·영구 포기·명령 활성화 승인이 아니다. [계획표](../planning/tasks.md)의 미완료 체크와 선행 조건을 유지한다.
이 절이 현재 상태의 단일 요약이다. 아래 날짜별 기록의 PASS/FAIL/NOT RUN·"현재"·"최신"은 **각 당시 실행 신원**에 한정하며 지우거나 소급 변경하지 않는다.
원래 요건은 본문 §7–12와 원본 시험(`undo_native.py`, `undo_save.py`, 실제 WASM 실패 시험)을 그대로 따른다.

<a id="t010-d3-d5-d2-20261104"></a>

### D3·D5·D2 재검증 — 2026-11-04

**D3 PASS, D5 PASS, D2 INCONCLUSIVE 유지. D1 마지막 공식 PASS 유지, D4 FAIL(지연)·자원 INCONCLUSIVE 그대로(이번에 실행·변경하지 않음).
T010 INCOMPLETE / 제품 RHWP Undo/Redo NO-GO / T011 NOT STARTED 유지.** 아래 "현재 D1–D5 수용 행렬"의 D3·D5·D2 행은 `d1ec335` 기준 기록으로 남기고,
이 세 관문의 현재 판정은 이 절이 대체한다.

실행 신원: geul HEAD `9cd7484` 소스(제품 소스 변경 없음), RHWP `1a76570` + 패치 11개(파일 해시가 RELEASE.json과 일치),
Release generation `853a0689…`, WASM `77d01d6c…`, JS `70cde06a…`, native 앱 `e72f2676…`(같은 소스로 빌드), WebKitGTK 2.54.1, IBus 1.5.33·ibus-hangul 1.5.5.
모든 acceptance 실행은 시험 전용 선택자 `GEUL_RHWP_TEST_GENERATION=release`로 제품 Release generation을 신원·해시 검증 뒤 읽었다.

| 관문 | 이전 | 이번 판정 | 근거(모두 위 신원) | 남은 조건 |
|---|---|---|---|---|
| D3 저장 보존 | UNVERIFIED(현재 Release) | **PASS** | `undo_save.py --release` 19/19 불일치 0(게시 13·거부 6, 거부 시 원본 SHA·디렉터리 그대로·dirty 유지, 참조 무결성 음성 거부); `save_service.py --release --strict-desired` 23행 CURRENT 0/DESIRED 0; Rust 저장·복구·세션 189/0; src 905/905 | 실제 앱의 Undo→저장 IPC는 이 계약의 범위가 아니다(원래 D3와 같은 하네스 형태) |
| D5 실패·복구 | UNVERIFIED(전체) | **PASS** | §9 각 행과 폐기 예외를 단위·실제 WASM 시험에 대응(실제 WASM 폐기 뒤 예외 8/8, allocate/restore/close-cleanup 경계 10/10, `history_boundary.mjs` 18/18, PoC 50/50); native 실제 discard 뒤 예외 2/2 + 새 세대 reload 2/2 | RSS·전역 renderer 잔류 수용 기준은 D4 자원 행에 남는다 |
| D2 native IME | INCONCLUSIVE | **INCONCLUSIVE** | 새 XIM 가설 진단 1회(10시도): 필수 E<U<F 0회, 관측 순서 E→`insertText`→U | 아래 D2 항목 |

- **D3 기대표 갱신의 근거:** 처음 실행에서 Undo 행렬 7건·strict 5건이 불일치했다. 원인은 하네스 기대표가 2026-11-02 T009 정책
  ([HWP 글 미리보기 재생성](save-preservation.md#hwp-글-미리보기-재생성-2026-11-02-stage-1))보다 오래된 것이었다: 이제 HWP `PrvText`만 낡았으면 저장 서비스가
  본문에서 다시 만들어 게시하고 `PrvImage`는 blank2010 자산만 인정한다. 기대표만 바꾸지 않고, 새로 게시되는 HWP마다 독립 검사(스트림 집합 동일·`/PrvText`만 다름·
  `PrvImage` 자산 해시·`PrvText` 줄이 재열기 본문에 있음·게시 파일 재열기 네 값 동일)를 추가했다. 여러 구역 HWPX의 `content.hpf` 차이는 XML 선언 공백뿐이라
  C14N 비교로 기대를 유도한다(여전히 다른 근거로 거부). unsafe 출력 게시 0건.
- **시험 인프라 교정(제품 변경 아님):** 시험 기본 WASM(`public/rhwp/rhwp_bg.wasm` legacy 사본, 패치 10개)이 제품 Release와 달랐다. vitest 5가 심볼릭 링크된 비공개 시험을
  0건 실행으로 실패시켰다. 낡은 로더 시험 3개가 fetcher 없이 실패했다. `cargo-geul.py` bwrap 안의 복구 시험은 공유 임시 디렉터리 거부(환경)로 실패하고 0700 TMPDIR의
  일반 실행은 통과했다. native probe가 제품과 다른 모듈 인스턴스를 패치하면 discard 예외가 주입되지 않았다(E1과 같은 모듈 동일성 수리 뒤 `sameModule=true`).
- **D2:** 원래 predicate·assertion·환경 게이트(`GTK_IM_MODULE=ibus`)를 바꾸지 않았고 같은 ibus 행렬을 반복하지 않았다. 설치된 IBus는 GTK 모듈·ibus-x11 모두
  `post_process_key_event`로 commit→forward 순서를 보존한다. 새 가설은 GTK XIM 모듈에서 Xlib가 commit과 forward key를 큐 앞에 되돌려(`XPutBackEvent`) 순서가
  뒤집힌다는 것이었다. 진단 전용(게이트만 xim 허용) 1회 실행에서 E<U<F는 0/10이었고 commit은 forward보다 먼저 일반 `insertText`로 왔다. 가설을 기각하고 종료한다.
  같은 진단에서 **XIM 조합 중 클릭 시 같은 음절이 두 번 들어가는 결함**(`…가`→`…가가`)을 관측했다: WebKit이 조합을 확정한 뒤 XIM reset commit이 같은 글자를
  `insertText`로 다시 보내고, 공유 IME 계약은 조합 계열이 아닌 같은 글자를 새 입력으로 받는다. 검증 플랫폼(ibus GTK 모듈) 밖이고 Undo와 무관하며 공유 IME 계약 변경이
  필요해 이번에 고치지 않았다(WordCraft UNVERIFIED). 별도 작업으로 다룬다.
  → 같은 날 후속 작업에서 고쳤다([XIM 중복 수정](editor-surface-decision.md#gtk-xim-조합-중-클릭-중복-수정-2026-11-04)). D2 판정은 바뀌지 않는다.
- 근거: 비공개 `geul-tests/reports/t010-d3-d5-d2-20261103/REPORT.ko.md`(E9).

### 현재 D1–D5 수용 행렬

기준 제품: HEAD `d1ec33515839f733f707f99b31ff2dde82ddb2af`, RHWP `1a76570e833917d15817415a53c09ad61ab3203f`,
WordCraft `fc41918814f62645b6746ed68e71e8c2c2e85d6f`; Release generation
`ca284e06df589b15bb7bc99163472203644621efffa024be6ad315908bdeb855`, WASM SHA-256
`3f99a74bbddf1716dcb6cf3e2a3940f510f3ca03fcee465f7f0c2fcd829d9cf0`.
공식 수용, 시험 실행 완료, 조사 완료, 제품 활성화는 서로 다른 판정이다.

| 관문 | 원래 요구 | 현재 수용 판정 | 실행 근거 | 남은 조건·증거 공백 | 차단 영향 | 다시 다룰 전제 |
|---|---|---|---|---|---|---|
| D1 그리기·커서 | 실제 WebView의 Undo/Redo·셀·여러 구역·화면/커서 복원 | **PASS (31/31)** | E1의 현재 제품 native 결과 | 기록된 제품·실행 범위 밖까지 확장하지 않음 | D1 자체는 통과; T010 전체 완료 아님 | 관련 제품/산출물/시험 조건이 바뀔 때만 영향 범위 재검증 |
| D2 native IME | 빈 compositionend(E) → 원본 predicate가 인정하는 native Undo 요청(U) → nonempty insertFromComposition(F), 원래 문서·기록 assertion | **INCONCLUSIVE** | E4–E6: 일반25 PASS/0 FAIL, 앞선 gap20 safe와 진단10 safe, required E<U<F는0 | 관측은 E<F<U; WebKit 내부 enqueue/send/receive/ACK는 UNVERIFIED | native gap 수용 미충족, 활성화 차단 | 아래 D2 재개 조건과 원본 native predicate/assertion 충족 |
| D3 저장 보존 | Undo/Redo·Undo 뒤 새 편집의 실제 모델 출력을 service::save로 검사; 안전한 출력만 게시, 거부 시 원본 SHA 보존·참조 무결성 | **UNVERIFIED (현재 Release 전체 범위); 보관 PASS 유지** | E8의13/13 및19/19 PASS·strict 저장23행 불일치0 | 검토한 상세19행은 HEAD1614e15/WASM a91fa6a4…; 현재3f99a74b…에 연결된 전체 실행 근거 미확보 | 과거 결과만으로 현 통합 저장 수용을 승인하지 않음 | 기존 근거의 정확한 source/WASM/fixture 바인딩 회복 또는 별도 승인된 원본 D3 검증 |
| D4 성능·메모리 | 원래3RAF group-start p95≤50ms, Undo p95≤1500ms 및 본문 §10 자원 관측 | **FAIL (지연); 자원은 INCONCLUSIVE** | E1:440표본/timeout0/6 PASS·2 FAIL. group p95 Basic HWP44/HWPX45/Chemical52/Asset95ms; Undo50/50/78/160ms | Chemical/Asset 지연 초과; 메모리·잔류 원인/수용 증거는 별도 미충족 | 성능·자원 활성화 관문 미통과 | 아래 D4 및 자원 조건. Redo 공식 gate 추가·endpoint/표본/문턱 변경 없음 |
| D5 실패·복구 | 본문 §9의 실패별 상태·기록·revision·차단·정리와 원본 실제 폐기 예외/새 세대 reload 안전성 | **UNVERIFIED (전체); 현재 native 하위2/2 PASS** | E1의 HWP/HWPX 실제 discard 뒤 예외·복구 검사; E8의 과거 native/실제 WASM 실패 시험 PASS | 현재 Release에 연결된 전체 실패 경계·복구 시험의 종합 증거 미확보; 시험 코드 존재는 실행 증거 아님 | 하위 통과만으로 전체 실패 안전성/활성화 승인 불가 | §9와 기존 실패 시험의 범위·실행 신원 대조 및 빠진 증거 확보; 새 assertion을 공식 gate로 꾸미지 않음 |

D3/D5의 UNVERIFIED는 새 결함이나 실행 불가 판정이 아니라 **현재 제품 신원에 대한 증거 공백**이다. 보관 PASS를 취소하거나,
latest 보고서에서 다루지 않았다는 이유만으로 NOT RUN/FAIL로 분류하지 않는다. D3는 unsafe 출력의 올바른 거부도 성공이며 전부 저장하라는 요건이 아니다.

### 완료된 조사와 보류 결정

- **전체 페이지 안전성:** GPU의 partial-band/clip strict pixel 비동등성 때문에 제품은 **FULL_PAGE_ONLY**다. 바뀐 쪽은 `renderPageToCanvas`로 그린다. 속도만을 이유로 partial repaint를 재개하지 않는다.
- **증분 pagination·출력 무효화:** 격리 insertText 21.66→2.75ms에도 native Asset p95 92→72ms로 FAIL이었다. 현 production과 다른 WASM/정책의 결과이며 제품 승인 최적화가 아니다. 전체 의존성·정확한 동등성·resource lifetime·mutator generation 증명이 남는다(E2–E4).
- **G0 검토:** 문서 검토는 완료했지만 G0-A~F는 OPEN, G0-G는 resource 계약 정의 수준에서만 CLOSED다. G1 record-only shadow의 구현·실행은 **NO-GO**다. 증분 조판 계약 문서의 존재도 구현 승인이 아니다.
- **D2 transport:** IBus CommitText, 같은 GTK thread의 commit-before-unconsumed-key-replay, 원래 X key identity, WebKit IM filter와 DOM 순서를 확인했다. 최종 queue 관측 가능성 조사는 COMPLETED이나 **RUNTIME_TRACE_BLOCKED**다. 내부 runtime FIFO나 전 구성의 E<U<F 불가능성을 입증한 것은 아니다(E5–E6).
- **D4 critical path·구조 검토:** Asset handler30개가58–69ms다. insertText26ms, layer JSON8ms, full draw13ms p50은 nested/겹치는 경계이므로 더하지 않는다. 파생 frame 단계화·single-owner Worker·full-recompute 통합 세 안 모두 정확성과 충분한 end-to-end 이득을 함께 뒷받침하지 못해 구현 **NO-GO**, 보수 경로 유지다(E2/E7).

같은 IME timing matrix·WebKit/debugger 가능성 조사, 반복 micro-optimization, G0 공백을 우회하는 재사용/이름 변경, 새 근거 없는 구조 검토는 재배정하지 않는다.
조사 완료는 위 수용 행렬의 미충족 조건을 닫지 않는다. D4≤50ms가 불가능하거나 보류가 영구적이라고 단정하지 않는다.

<a id="t010-reopen"></a>

### 근거에 따른 재개 조건

- **D2:** 유효한 원래 의미의 독립 native E<U<F 증거, 구체적인 순서 가설을 가진 별도 승인된 지원 runtime/input 환경, 또는 전달 공백을 해소하고 실행 가능한 새 실험을 뒷받침하는 검증된 관측 능력 중 적어도 하나가 필요하다. 단순 delay 추가나 같은 key matrix 반복은 해당하지 않는다. 2026-11-04 GTK XIM 경로 가설은 진단 1회(0/10)로 기각했다. PASS는 실제 native predicate 인식과 모든 원래 assertion 통과 뒤에만 가능하다.
- **D4:** 새 latency 제거/critical-path 단축 기전, 실질적인 end-to-end 이득의 소스 근거, bounded correctness·ownership·memory 계약, 독립 full oracle/strict RGBA, 신원 일치 native 비교가 함께 있어야 후보를 다시 심사한다. local API microbenchmark만으로 재개하지 않는다. FULL_PAGE_ONLY와 원래4문서·warmup·표본·3RAF·group≤50/Undo≤1500을 보존하고, 승인된 통합 제품의 원본 producer/evaluator만 공식 PASS를 정한다.
- **G0/G1:** 관련 출력 의존성·typed exact equality·generation/mutator·공유 자원 수명·실패·UNKNOWN/fallback 의무를 실제 근거로 닫아야 한다. 새 proof outline이나 G0 문서 완료는 폐쇄가 아니다. 별도 승인 없이 G1을 구현·실행하지 않는다.
- **D3/D5:** 수용 행렬의 원본 계약과 현재 제품/산출물/fixture·소스 신원에 묶인 빠진 실행 근거를 확보해야 한다. 과거 로그의 실제 바인딩을 복원할 수 있으면 재실행으로 대체할 필요가 없다. 문서 보류 해제를 이유로 새 검증 범위를 발명하거나 하위 결과를 전체 PASS로 올리지 않는다.
  2026-11-04: 현재 Release·소스 신원으로 원래 D3/D5 범위의 실행 근거를 확보해 두 관문 모두 PASS다([재검증](#t010-d3-d5-d2-20261104)). T010 완료나 제품 활성화를 뜻하지 않는다.
- **자원·메모리:** snapshot I1–I3/깊이·한도·실패 시 fail-closed, release/dispose 후 owner/job/lease/listener·Canvas 수명, 반복 편집/Undo/Redo/close의 WASM high-water·RSS·재사용을 구분해 입증해야 한다. E1/E2의 Chemical engine 내부 detached Canvas21개/100,819,044pixels는 관측값이며 누수 확정도 해제 성공도 아니다. 충분히 settle한 in-app 상태·반복/대조 측정·소유권/재사용 근거가 필요하다. process 종료만으로 닫지 않는다. history256MiB 회계/증가 감시는 RSS 상한이 아니며, RSS의 규범 수용 기준은 미정이다. 측정·허용 기준은 별도 합의 없이 만들지 않고, 기존 Canvas16Mi pixels/쪽·32Mi pixels/surface 등 명시적 예산을 약화하지 않는다.

### T011·제품 활성화와 독립 작업

Task Contracts의 **T011 Depends on T010**과 T010의 T009/T005 선행 조건을 유지한다. T007–T009 미체크 범위와 SC-003의
RHWP 서식·실제 명령 수용 공백도 그대로다. T011은 NOT STARTED이며 READY나 리본 통합 착수 허가가 아니다.
제품 RHWP `edit.undo`/`edit.redo`는 `unsupported`/NO-GO를 유지하고 시험 활성화 빌드의 결과를 제품 지원으로 전환하지 않는다.

보류는 전체 프로젝트 중단이 아니다. T010의 미충족 보장을 요구하지 않는 문서·번역·보안/개발도구 유지보수 등 **이미 승인된 독립 작업**은
각 Task Contract·선행 조건·기존 승인 범위 안에서 계속할 수 있다. T011 리본·상황별 도구의 별도 선행 작업 허가는 기존 계획에서 확인되지 않았다.
독립 가능성은 새 구현 과제의 승인이나 T010 의존성 제거를 뜻하지 않는다.

### 근거 위치와 판독 범위

다음은 저장소와 나란한 비공개 `geul-tests`의 근거다. 접근할 수 없어도 위 표의 판정·차단 조건은 유효하다.
raw trace/fixture를 공개 문서에 복사하지 않는다. VERIFIED는 해당 기록/소스로 확인, INFERRED는 해석, UNVERIFIED는 증거 공백,
REJECTED는 근거와 모순을 뜻한다. 실행 신원이 다른 과거 후보를 현 제품 matched A/B로 읽지 않는다.

- E1: [canonical D1/D4](../../../geul-tests/reports/t010-canonical-d1-d4-20261101/REPORT.ko.md) — D1 31/31, D5 native 하위2/2, D4 공식440표본.
- E2: [Asset critical path](../../../geul-tests/reports/t010-asset-critical-path-20261101/REPORT.ko.md) — 표본별 귀속·과거 후보·자원 관측.
- E3: [pagination/cache 설계](../../../geul-tests/reports/t010-pagination-cache-design-review-20261101/REPORT.ko.md) — 보수 설계 유지·구현 NO-GO.
- E4: [D2/G0 후속](../../../geul-tests/reports/t010-d2-g0-followup-20261101/REPORT.ko.md) — required gap 미관측과 G0/G1 의무 구분.
- E5: [IBus/GTK 전달](../../../geul-tests/reports/t010-d2-native-forwarding-20261101/REPORT.ko.md) — 진단10 safe, 공식 native gap PASS 아님.
- E6: [WebKit queue 최종 한정 조사](../../../geul-tests/reports/t010-d2-webkit-queue-20261101/REPORT.ko.md) — 관측 차단·runtime 내부 순서 UNVERIFIED·조사 종료.
- E7: [D4 구조적 타당성](../../../geul-tests/reports/t010-d4-structural-feasibility-20261101/REPORT.ko.md) — 세 구조안 구현 NO-GO·최적화선 중단.
- E8: [보관 D3/D5 실행 기록](../../tests/integration/rhwp/evidence/t010-design-review-admission/REPORT.ko.txt), [D3 19행](../../tests/integration/rhwp/evidence/t010-design-review-admission/undo-save.json), [이전 안정화](../../tests/integration/rhwp/evidence/t010-stabilization/undo-save.json) — 당시 PASS를 유지하되 현 Release 바인딩과 구분.
- E9: [D3·D5·D2 재검증](../../../geul-tests/reports/t010-d3-d5-d2-20261103/REPORT.ko.md) — Release `853a0689…`/WASM `77d01d6c…`의 D3 19/19·strict 23행, D5 행렬 대응·native 2+2, D2 XIM 진단 0/10과 XIM 클릭 중복 관측.


<a id="phase7-reevaluation-20261102"></a>

### Phase 7 재평가 — 2026-11-02

**재평가 COMPLETED, 재개 NO-GO. T010 INCOMPLETE — ON HOLD / 제품 RHWP Undo/Redo NO-GO / T011 NOT STARTED 유지.**
검토 제품 HEAD `45cf3f40b56aa64d05fcb575b9f08acb92231583`(시작 `a033309`, 안전 교정 `e013142`)다.
RHWP/WordCraft gitlink와 위 Release generation/WASM은 동일하다. 위 행렬은 마지막 공식 실행 `d1ec335`에 묶인
수용 근거이며, 새 제품 HEAD의 전체 관문을 재실행했다고 읽지 않는다.

- **소스 대조:** `d1ec335..45cf3f4`의 RHWP 세션 변경은 Save As 대상 전달, 이벤트 버전, 최대 500자 읽기 전용 선택
  미리보기다. 엔진 mutator·pagination·전체 페이지 렌더·기록 수용/예산/실패·생산 명령 게이트는 변경하지 않았다.
  Phase 1–5의 TypeScript import/파일/xattr/복구 작업과 Phase 6의 패널 구독은 D4 critical path를 단축한 엔진 변경이 아니다.
- **새 검증:** 실제 현재 Tauri backend+Vite+동일 Release WASM에서 패널 native 25검사와 일반 한국어 IME
  RHWP(HWP/HWPX) 7/7·WordCraft 7/7이 통과했다. 복구 행의 등장/소멸로 문서가 움직이던 클릭 회귀를 고쳤다
  ([Phase 6 범위와 실패/교정 기록](./editor-surface-decision.md#phase-6-활성-문서-패널-통합-검증-2026-11-02)).
  이 실행은 제품 RHWP history OFF이며 D1 Undo/Redo 픽셀 복원이나 D2의 지연 확정 순서 시험이 아니다.
  IBus 환경 복구는 기존 전달 경로를 다시 사용한 것이며 새로운 E<U<F 관측 능력을 입증하지 않았다.
- **원본 검사 신원:** E1에 기록된 official_native.py/undo_native.py/native_probe.py/rhwp_poc.py/fixture generator
  5개 SHA-256이 현재 파일과 모두 같다. 공식 fixture·assertion·3RAF·50ms/1500ms를 변경하지 않았다.

| 관문 | 이번에 유지하는 판정 | 새 근거의 범위와 남은 조건 |
|---|---|---|
| D1 | 마지막 공식 PASS 31/31 유지; 새 HEAD 전체 canonical 미실행 | 새 패널/일반 IME native 검사는 전체 Undo/Redo 복원 수용이 아님 |
| D2 | INCONCLUSIVE | 일반 IME PASS는 새 근거지만 필수 native empty-end→Undo→late-final(E<U<F) 증거 없음; 기존 E<F<U/관측 차단 유지 |
| D3 | 현재 제품 전체 바인딩 UNVERIFIED, 보관 PASS 유지 | 파일/복구 서비스 105 PASS가 현 Release의 전체 Undo/Redo 저장 행렬을 대신하지 않음 |
| D4 | 마지막 공식 FAIL; 자원/RSS INCONCLUSIVE | E1 group p95 44/45/52/95ms, Undo 50/50/78/160ms(기본 HWP/HWPX·Chemical·Asset). 원래 group≤50/Undo≤1500·440표본·timeout0 유지. 이번 공식 재측정 없음 |
| D5 | 전체 UNVERIFIED, 보관 native 하위2/2 PASS 유지 | 새 파일 실패 주입은 전체 WASM allocation/restore/release/dispose 경계의 현재 종합 증거가 아님 |

새 근거는 Phase 6의 안전한 통합을 지지하지만 위 재개 조건을 닫지 않는다. D4의 새 지연 제거 기전이나 현재 제품의
end-to-end 개선 증거가 없어 고비용 D4 반복을 하지 않았다. 일반 입력/조사/문서 완료를 T010 완료로 올리지 않는다.
RSS의 규범 기준은 미정이며 새 상한을 만들지 않는다. 기존 history/Canvas 예산과 FULL_PAGE_ONLY를 유지한다.

가장 작은 다음 전제는 기존 재개 조건 그대로다: 독립 native E<U<F 관측 또는 검증된 새 관측 경로;
정확성·ownership·자원 계약과 실제 end-to-end 이득을 함께 갖춘 D4 기전; 현 제품 신원에 연결된 D3/D5 증거;
합의된 RSS 기준과 반복/대조 측정이다. G0/G1 구현이나 엔진/WASM 교체는 이번 범위에 포함하지 않는다.
`tasks.md` 체크박스/의존성은 바꾸지 않는다. 원자료·신원 대조는 비공개
`geul-tests/reports/phase6-phase7-20261102/phase7-official-identities.json` 및 `source-build-identities-final.json`이다.


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

> 2026-10-26 정정: 위 `estimate`의 "첫 스냅숏 전후 WASM 메모리 증가"는 구현되지 않았다. 구현(`startHistory`)은 원본 파일 바이트만 쓰며,
> 이 대용은 보수적이지 않다(실측: 스냅숏당 선형 메모리 증가가 파일 크기의 p50 2.4배·최대 62배). 정정과 증가 감시는 아래 "T010 설계 검토".

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
  같은 필드를 사용한다. 그 당시 adapter는 full-page mode만 사용했다. 아래 최종 안정화 adapter는 mode도 식별한다.

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

## T010 최종 안정화의 격리 계약

`t010-final-stabilization`은 실제 paint 입력 요약을 기존 `changedBand`로 비교하며 caret 위치로
손상을 추측하지 않는다. 페이지·배율·문서 세대·modelVersion·렌더 모드와 backing extent가 유효하고
paint 입력이 동일한 쪽만 재사용한다. 변경된 쪽은 항상 원자적 Full 재생을 수행한다.
새 `beginRenderPatchJob`도 유효한 사각형을 검사한 뒤 Full로 실행한다. 실제 Tauri/WebKitGTK에서
정수 배율의 복잡한 HWP를 지역 재생하면 내부23픽셀이 Full과 달랐고, 소수 배율에서도 차이가 있었다.
따라서 새 지역 clip 실험은 제거했다. 기존 호환 Patch/Filtered/Legacy 경로는 유지한다.
여러 쪽 HWP의 긴 편집 후 Undo에서는 길이0 원본 문단 caret 조회가 실패한다. 네 문서 Full 대조와
원본 pinned/candidate 독립 조회도 실패하므로 summary 원인 가설은 폐기했다. D1의 별도 실패로 남긴다.
표 셀·snapshot 복원·명시적 repaint는 Full이며, 첫 프레임은 React 정리 이후 게시하도록 대기시킨다.
확인된 이전 프레임의 변경만 같은 effect 안에서 첫 poll을 허용한다. staging/backup 한도, 현재 세대
검사 및 COMPLETE 전 비게시는 동일하다. 요약은 세션마다 최대64개·각262144·합계2097152 UTF-16 code unit으로 제한한다.
합계는 이전8개×개별 상한과 같고 새 항목은 MRU로 옮긴다.
초과 시 화면 밖 요약부터 LRU로 버려, 백그라운드 쪽 완료가 편집 중인 표시 프레임의 근거를 밀어내지 않게 한다. failed 요청에는
요약을 보유하지 않는다. 이는 renderer의 이미지 예산이나 프로세스 RSS 상한을 늘리는 승인이 아니다.

만료 검사는 pending job이 있을 때만250ms 단발 타이머를 이어 간다. 종료/취소 뒤에는 mutable borrow가
끝난 지연 작업에서 타이머를 정리한다. 공유 job이 남으면 검사하며, 유휴 후 새 job은 재시작한다. 무한
interval·job별 callback 누적은 없고, 마지막 활성 lease→cache-only 회수 가능량 및 실제 대기 byte 예약에
근거한 용량 알림 계약을 유지한다. CPU·전력 감소를 측정 없이 주장하지 않는다.

성능 명령은 네 문서의 측정 완료와 공식 관문 통과를 구분한다. 실패한 지연 관문은 종료 코드1과
`OFFICIAL_GATE_FAILURE`이며, driver/cleanup 오류·결과 누락은 별도 실패다. 기준은 native keydown→revision
관찰 RAF→추가2RAF, group-start p95≤50ms·Undo p95≤1500ms 그대로다. 같은 후보의 Full/damage 비교와
pinned 비교를 나누며 비동기 commit-ack나 서로 다른 p95를 합산하지 않는다.

실행 범위·후보 SHA·실패 재현·D1 표시 RGBA·D3 고정 분류·D2 native 및 D4 최종 관문은
[이번 보고서](../../tests/integration/rhwp/evidence/t010-final-stabilization/REPORT.ko.txt)를 따른다.
제품 엔진/명령은 교체하지 않으며 T010 미완료와 T011 선행 조건은 유지한다.
## T010 빈 floating-picture 문단 caret 복구 후속 (2026-10-24)

`t010-caret-geometry` 후보는 위 최종 안정화에서 남은 D1 원본 빈 문단 실패를 수정한다.
원본 화학 연구노트의 빈24문단 중21개 Picture host는 textless-float 경로가 문단 레이아웃을 생략하면서
caret 조회에 필요한 TextLine도 버렸다. 기존에 정상인3개 object 경로는 보존한다. 실제 문단 시작 위치와
저장된 단일 line segment의 높이·baseline·column 시작으로 paint 자식이 없는 TextLine metadata만 남긴다.
그림 bbox나 caret 추정값을 쓰지 않으며 flow 진행과 paint 입력은 그대로다. 유효한 양의 높이와 column 경계를
검사한다. synthetic·multiline·범위 밖 line의 일반 지원까지 확장했다고 주장하지 않는다.

실제 후보 WASM에서21개 caret 복구·3개 기존 좌표 보존·24개 paint-owning tree 동일성을 확인했다.
새 native5계약은 수정 전1통과/4실패에서5통과가 됐다. 전체 Rust4068통과/13 ignored, Chrome/WebKit 각각
ownership52+scheduler73, 실제 native 전체53·focused11·safety14·visual66·pending22가 통과했다.
엄격한 네 문서 native39검사에서도 원본 `0:23:0` Undo caret이 보이고24개 Full RGBA 참조가 모두 일치한다.
표시 정확성 검사를 공식 지연 측정으로 세지 않는다. 실제 서비스 저장19고정 사례와 real-WASM37도 통과했다.

[후속 보고서](../../tests/integration/rhwp/evidence/t010-caret-geometry/REPORT.ko.txt)에 새 완전 패치·WASM 식별과
실행 증거를 남긴다. 이전 실패 보고서는 보존한다. D2 목표 native IME 순서, D4 지연 및 장시간 RSS는
미완료이며 제품 활성화와 T011 선행 조건은 유지한다.

T010 D4 decoded-cache admission [후속 실험](../../tests/integration/rhwp/evidence/t010-decoded-admission/REPORT.ko.txt)은
동일 키 연속 요청2회로 admission 빈도 판정만 우회하며 기존 byte/count/per-entry 한도를 유지한다.
새 후보 Rust4071·browser125각각·native6종·24개 정확한 RGBA 비교는 통과했다.
그러나 단일 추가 계측 실행에서 group p95 342→279ms는50ms를 충족하지 않고 중앙값/최대값과 Undo가 악화됐다.
재현 가능한 성능 개선으로 승격하지 않으며48adaa 기준과 제품 비활성 상태를 유지한다. 전체 T010은 미완료다.

## T010 native 검증 관문 보강·D4 병목 후속 (2026-10-24)

`performance-visual-native.py`는 `--sample`이 아무 문서도 고르지 않아도 PASS가 될 수 있었다(문서0·참조0으로 exit0).
이제 기본 네 문서 또는 알려진 fixture 하나만 받고, 선택한 문서 집합·문서당 정확한 Full RGBA 참조6개(전체24)·
모든 필수 caret/history assertion·세션/driver/display 정리가 모두 맞을 때만 PASS다. 모르는 sample은 native 실행 전에 거부한다.
가짜 native 도구로 main()을 돌리는 음성 시험15개와 판정 규칙 변이10개로 고정했다. 실제 native 엄격 네 문서39/39·참조24와
단일 화학 문서12/12·참조6이 같은48adaa 후보에서 다시 통과했다.

유지 후보48adaa의 첫 공식 D4 실행은 측정 완료·timeout0이지만 group-start p95 88/89/266/138ms로 네 문서 모두 FAIL,
Undo p95 152/150/133/247ms는 PASS다. 기존 trace 재분석에서 group-start 중앙값 자체가50ms를 넘고(71~102ms),
이미지 upload 없는 표본도 p50 67~73ms, revision 뒤 첫 RAF 대기가 p50 35ms다. decode 초과분을 모두 없애도 p95가
213~327ms로 계산되므로 renderer decode/admission 최적화는 구현하지 않았다. e300 실험은 승격하지 않는다.
tauri-driver로 세션만 만든 뒤 같은 native WebKitWebDriver 세션에 직접 보내는 경로로 2문서×3모드×20회=120회를 한 앱/WebProcess에서
연속 완료했다(전송 오류0, cycle 정리120/120, 366 memory point 상한 PASS). 닫은 뒤 RSS는679~1841MiB 사이를 오가며 기존 기준에
plateau 한도가 없어 RSS 판정은 INCONCLUSIVE다. 이전 110/11/20회 창과 합산하지 않는다.
D2 목표 IME 순서는 기존 실제36회 모두 늦은 final이 Ctrl+Z보다 먼저 와 INCONCLUSIVE로 유지한다.
[후속 보고서](../../tests/integration/rhwp/evidence/t010-native-gate-followup/REPORT.ko.txt). T010 전체는 미완료이며 제품 활성화와 T011은 계속 NO-GO다.

## T010 native 검증 완전성·메모리 수명주기 관문 강화 (2026-10-24)

`performance-visual-native.py`에 남아 있던 빈 증거 PASS 경로를 막았다. 필수 assertion은 실제 실행 순서대로 각각 정확히
한 번 있어야 하고(중복·예상 밖·순서 바뀜 FAIL), Full RGBA 참조는 harness가 정한 sample/frame/이름과 0 이상 정수
`pixels`/`maxDelta`가 모두 0이어야 한다(`maxDelta` 누락·bool·실수 FAIL). 공식 네 문서는 harness 안의 독립 목록으로 정하며
공유 `undo_native.LARGE`가 줄어도 범위가 함께 줄지 않는다. 이 harness의 history 계약은 이름 붙은 필수 assertion이고
`undo_native` gate를 만들지 않으므로 `historyGates`/`historyChecks`는 비어 있어야 하며 빈 목록을 history gate 통과로 보고하지 않는다.
수정 뒤 실제 native 엄격 네 문서39/39·참조24와 단일 화학 문서12/12·참조6이 같은48adaa에서 다시 통과했다.

연속 수명주기 판정은 순수 함수 `lifecycle_evidence.classify`로 옮겼다. WebProcess는 정확히 하나·PID와 `/proc` start time이
처음부터 끝까지 같아야 하고, 120 cycle·366 memory point가 sequence·문서·세션에 묶여 순서대로 있어야 하며, 선언 예산 필드는
누락·변경될 수 없다. 새 실제 120회 연속 실행은 PASS(전송 오류0, identity 검증, 정리·상한 PASS)다. 이전 연속 실행의
"단일 WebProcess" 판정은 PID만 근거였으므로 INFERRED로 정정한다. 새 실행 중 판정 모듈을 편집해(같은 의미의 규칙 병합)
`executedDependenciesStable=false`가 기록됐으며, 실행 시점 모듈과 최종 모듈 모두 PASS다.

엔진 externref table의 detached Canvas는 decoded cache의 상주 항목이다. 두 연속 실행의 모든 정착 상태(before/closed/closed10s)에서
개수와 RGBA 바이트가 cache 항목과 정확히 같고 externref slot은1156으로 일정하다. 별도 trim 실험에서 14항목·248.85MiB plateau가
idle 10초로는 줄지 않고(GC 대상 아님) 명시적 trim에서 즉시0이 되며 RSS가717→374MiB로 줄고, 다시 열면 같은 크기로 채워진다.
즉 예산(256MiB) 안의 정상 cache 소유이며 누수가 아니다. 엔진 수정이나 예산 변경은 하지 않았다. RSS는 297~2024MiB의 유한 peak를
보이지만 승인된 기준이 없어 INCONCLUSIVE다.

D4 공식 결과는 첫 유효 공식 실행(group-start p95 88/89/266/138ms FAIL)을 유지한다. 공식 측정은 revision을 RAF poll에서 보고
RAF 두 번을 더 기다리므로, 일이 없어도 3-RAF 바닥의 중앙값이 40~46ms다(p95는 문서마다 달라 60쪽 HWPX는 173ms — 아래 절에서 정정).
진단 관찰자로 보면 software GL(공식 환경)에서는 revision 다음 RAF에서 이후 작업 실행까지가 p50 35~60ms였다
(이 간격을 주 스레드 그리기 비용으로 본 원래 해석은 아래 절에서 철회).
WebProcess가 실제 Intel xe GPU(renderD128, render engine cycle 증가 확인)를 쓰는 설정에서는 그 구간이 p50 2~7ms로 줄어
기본 문서 group-start p50이40~41ms가 되지만, p95는 77/57/187/104ms로 여전히50ms를 넘는다(Xvfb 표시, 실제 화면 아님, 비공식 진단).
남는 큰 몫은 큰 문서의 key→revision commit(p50 29~60ms, p95 최대164ms)이다. 문턱·측정 경계는 바꾸지 않았다.
D2는 새 근거가 없어 INCONCLUSIVE를 유지한다.
[완전성 보고서](../../tests/integration/rhwp/evidence/t010-native-completeness/REPORT.ko.txt). T010 전체는 미완료이며 제품 활성화와 T011은 계속 NO-GO다.

## T010 진단 판정 무결성·D4 계측 정합성 보완 (2026-10-24)

`cache-trim-native.py` 판정은 저장된 `ownershipFailures`를 믿지 않고 원래 counter에서 `lifecycle_evidence.check_point`로 다시 계산한다.
정확한 phase 순서, 모든 point의 WebProcess(PID·start time)·RSS·counter 구조, 정착 상태 정리·Canvas 소유, 실행 전후 WASM,
정리 3단계를 요구하고, cache가 trim 전에 실제로 채워져 있었고 idle이 유지했으며 trim이 decoded/image cache와 엔진 surface를
비웠고 다시 열면 채워졌는지 확인한다. 수정 전 판정은 빈 프로세스 관찰·없는/None ownership 결과·잘못된 RSS 등 15경우를 PASS로,
2경우는 예외로 처리했다. 이번 workload에서는 image cache가 한 번도 채워지지 않아 image cache 해제는 "trim 뒤 비어 있음"까지만 확인된다.

`lifecycle_evidence.classify`는 durable sample 366개와 `measurements.lifecycle` 행의 관찰을 순서대로 전체 내용 비교한다(한쪽만 바뀐
RSS·counter·process identity·문서/세션, 누락·중복·재정렬 FAIL). cycle 정리 gate는 driver가 gate가 만들어지는 순간 문서·세션·직전 memory
sample을 붙이고(시험 전용, `undo_native` 무변경), 판정은 gate의 mode/cycle 이름·위치·연결과 기록된 closed 관찰로 다시 계산한 결과를
대조한다. 연결 정보가 없는 이전 실행은 결함 없이도 PASS가 아니라 INCONCLUSIVE다. 이 gate는 정리 증거이며 D4 성능 통과가 아니다.

D4 정정: 무작업 3-RAF 바닥의 중앙값은 대체로 40~46ms지만 p95는 일정하지 않다. 공식 실행의 60쪽 HWPX는 p95 173ms(최대 243ms)였고
진단 실행에서도 큰 두 문서의 p95가 67~205ms였다(기본 문서는 48~50ms). 앞선 "p95 48~49ms" 요약은 틀렸다. 이 변동은 편집 작업이 없어도 생기며, 공식 group-start
이상값의 원인을 그것만으로 입증하지는 않는다. 또 RAF 뒤 MessageChannel 작업까지의 간격은 Canvas 그리기·GPU·compositor 시간이 아니며,
software GL에서는 rafA에 올린 작업이 rafB 뒤에야 실행된 표본이 많다(문서당 4~14/30). 그래서 앞선 "frame 대기 0 → 주 스레드 그리기
비용" 결론은 철회한다. 지지되는 것은 software GL(rafA→rafB p50 34~39ms)과 WebProcess가 실제 GPU를 쓴 설정(6~11ms)의 차이로 볼 때
graphics 경로가 지연에 크게 작용한다는 추론까지다. D4 진단 판정은 네 fixture 순서·해시, 문서별 엔진 identity, 문서당 30개의 유한한
timestamp와 인과 순서, revision 중복 없음을 요구하며 `DIAGNOSTIC_COMPLETE`는 공식 D4 PASS가 아니다. 관찰자와 MEASURE 표본은
공통 trial 식별자가 없어 순서로만 짝지으며 이를 한계로 남긴다. 공식 D4는 FAIL 그대로다.
[진단 무결성 보고서](../../tests/integration/rhwp/evidence/t010-diagnostic-integrity/REPORT.ko.txt). T010 전체는 미완료이며 제품 활성화와 T011은 계속 NO-GO다.

## T010 진단 입력 검증·캐시 수명주기 회귀 보완 (2026-10-24)

`lifecycle_evidence.check_point`는 이제 열린 상태를 포함한 모든 관찰에서 `engineSurfaces` 다섯 counter(0 이상 정수)를 요구한다.
열린 상태는 owner/job/lease/staging Canvas를 가질 수 있으므로 정리·소유 대조는 정착 상태에만 적용한다. cache-trim 요약을 계산할 수
없는 phase는 FAIL이다. 문서별 cache/RSS 요약 gate도 cycle gate처럼 gate 식별자가 `D4`여야 한다(INCONCLUSIVE 결과만으로 D4로 보지 않음).
D4 진단 판정은 기대 WASM이 소문자 SHA-256인지 먼저 확인하고, sample·engineIdentity·measureTimeline·observer·revision·groupStart의
형식을 조회·hash·비교 전에 검사해 잘못된 JSON에도 예외 없이 FAIL을 낸다. 수정 전에는 이 경우들 중 24건이 PASS, 4건이 예외였다.

브라우저 이미지 cache trim을 실제로 확인했다(`image-cache-trim-native.py`). SVG 그림 두 개가 든 생성 문서를 열면 image cache에
2항목·11.6MB가 생기고 표시 frame이 exact이며, 닫고 10초 두어도 유지되고(전역 cache 소유), 명시적 trim에서 image/decoded cache와 엔진
image surface가 모두 0이 되며, 다시 열면 같은 크기로 채워지고 frame이 다시 exact다. 늦은 이미지 콜백이 교체된 문서에 게시되지
않는 것은 `history-pending-native.py`(22/22)로 다시 확인했다. 앞 절의 "image cache 해제는 trim 뒤 비어 있음까지만 확인" 한계는 해소됐다.
[입력 검증 보고서](../../tests/integration/rhwp/evidence/t010-diagnostic-input-validation/REPORT.ko.txt). D4 공식 FAIL, D2·RSS INCONCLUSIVE, T010 미완료, 제품 활성화와 T011은 계속 NO-GO다.

## T010 이미지·RSS·D4 진단 검증 보완 및 D4 원인 분석 (2026-10-24)

`engineSurfaces.imagePixels`도 모든 관찰에서 0 이상 정수여야 하며, 이미지 cache 실험은 생성 문서의 두 SVG(1200·1210px 정사각형)에서 독립적으로
정한 2,904,100px와 상주 phase의 값이 같고 trim 뒤 0인지 확인한다. `aggregateRssBytes`는 정수여야 한다(405213184.0 == 405213184라서 비교만으로는
실수를 받아들였다). D4 진단의 timestamp는 float로 바꿀 수 없을 만큼 큰 정수(10**400)를 예외 없이 거부한다.

D4 원인(공식 48adaa 실행의 기존 trace 재분석): 60쪽 HWPX의 동기 handler p50 59ms, `insertText` 26ms, render job 14ms는
엔진 API의 벽시계 관측이다. 이전 "나머지 app/JS 14ms"는 중첩 호출을 더해 뺀 비배타적 산술 잔여여서 철회한다(아래 후속 교정).
24쪽 화학 HWP의 비공식 진단에서 느린 group-start 10개 모두 동기 `pollRenderJob`과 겹치지만, 121~158ms 호출은 그중 7개다.
나머지는 61·62·27ms이고, 13·15번 표본은 기록 호출로 덮이지 않는 34·31ms가 남는다. native 전달 자체를 배제하거나 모두 render가
완전히 설명한다고 주장할 수 없다. 캐시 축출만으로 설명한다는 가설도 아래 호출별 근거로 제한한다. 승인 후보48adaa·공식 D4 FAIL은 유지한다.
[검증·원인 분석 보고서](../../tests/integration/rhwp/evidence/t010-validation-d4-investigation/REPORT.ko.txt). T010 미완료, 제품 활성화와 T011은 NO-GO다.


## T010 D4 critical path 귀속·호출별 계측 (2026-10-24)

과거 원본은 보존하고 시험용 `ownership-poc/d4_evidence.py`·`analyze-d4.py`로 후속 분석한다. `call_start < input && call_end > key`
교집합과 clipped interval union을 써 pre-key 호출·중첩·부분 겹침을 센다. 원본65개 `insertText` 호출과 canonical edit65개를 순서로 제안하되,
각 상대 호출시각으로 복원한 절대 key와 input timestamp를 서로 독립적으로 유일 대조한다(30 group-start·30 extend·5 afterUndo;
warmup6개는 별도). 공유 trial ID는 없어 순서를 전혀 쓰지 않는 독립 pairing은 아니다. timeStamp와 JS observation은 구분한다.
화학 느린10개 중8개는 render 교집합이 지연의95% 이상, 13번은139/173ms(80.3%),15번은19/50ms(38%)다. 두 표본에서 마지막 호출 뒤
keydown 관찰까지29·30ms가 남으며 다른 기록 동기 호출로 설명되지 않는다. busy gap은 관찰자 task가 못 돈 기간이며 CPU 작업명이 아니다.

호출별 cache/native 진단 최종 실행은 DIAGNOSTIC_COMPLETE, 실행 의존 파일 안정·traceDropped0·probeCallDropped0이다(비공식).
50ms 이상 poll46개 중26개에서 decoded miss,21개에서 입장 거부,5개에서 축출이 증가했다.20개는 decoded hit/miss 변화가 없다.
따라서 모든 긴 poll을 cache miss 또는 축출로 단정하지 않는다. Right33개 모두 모델 버전·세대가 유지되고, dispatch 안에서 관찰된 effect23개는
`all=false,lastVersion=modelVersion`이라 재요청 경로에서 빠졌다. 긴 요청의 실제 page14·15·16 등은 직전 편집보다 낡은 paintedVersion을
갱신하는 요청이었다. 소스상 편집은 modelVersion을 올리고 화면 밖 쪽은200ms 뒤 한 task에 한 쪽씩 그린다. Right가 직접 문서를 바꿔
불필요한 full render를 시작한다는 가설은 이 workload에서 지지되지 않는다. 이전 편집의 지연 background 작업과 입력 도착이 겹친다.
각 페이지의 paint가 실제 동일한지는 모델 버전만으로 보증할 수 없어 render skipping은 적용하지 않는다.

job poll은 tree 작성→scratch Full replay(동기 Rust decode 포함)→세대/취소 재검사→backup/atomic publication을 한 번에 수행한다.
PENDING은 이미지/용량 대기이며 계산량의 time slice가 아니다. 같은 긴 동기 poll 바깥에 timer만 붙여도 decode를 나누지 못한다.
안전한 다음 구현 경계는 자원 준비와 replay를 분리한 job 상태 전이이며, 준비된 자원의 수명·예산·취소 후 정리·capacity 알림·최종 세대 검사를
함께 설계해야 한다. 개별 decode 자체가 긴 경우 자원 사이 yield만으로 입력 지연 상한은 보장되지 않는다. 예산 증액·캐시 정책 변경·생산 활성화는 하지 않는다.

별도 고정 소스+진단 패치로 만든 WASM을 Chrome에서 승인48adaa와 같은 문서·위치·편집으로 비교했다(앱에 주입하지 않음).
1쪽 HWPX는 `insertText` p50 1.1ms, 60쪽은27.7ms이며 그중 pagination26.8ms, 문단 reflow0.6ms, compose0.1ms다.
각 측정의 중첩 spans는 더하지 않는다. 문단 reflow/compose는 표적 문단만 부르고, pagination은 dirty 구역을 다시 배치한다. 이를 매 키마다
전체 문서 모든 문단의 shaping이라고 부르는 것은 틀리다. 60쪽 문서는3구역(593/4/34문단)이므로 페이지 수와 문단 복잡도를 두 fixture만으로
독립 인과 분리할 수 없다. 부분 pagination 최적화는 affected-range·page break/table/caret/history 보존 근거가 더 필요하다.
진단 WASM은 승인 후보가 아니며 엔진 성능 개선·공식 D4 PASS를 주장하지 않는다.

공식 trace120개 group-start의 `engineTimeline` 경계를 handler에 자른 union으로 중첩을 교정했다. 과거 화학10개의 -6ms까지의 값은
비배타적 산술 잔여이며 보존한다. union 밖 구간은 반올림된 선택 probe의 미계측 시간 추정치다. 실제 exclusive app/JS CPU 시간은 UNVERIFIED다.
진단 완전성은 key/input·call·trace·busy 로그와 canonical timestamp/순서·65개 edit 연결·fixture/candidate·trace loss를 확인한다.
누락 로그·중복/재정렬·짝 불일치·trace 손실은 FAIL이다. 첫 추가 실행의 timestamp 역전 FAIL, driver 전송 실패, 실행 중 분석 파일이 바뀐
시도와 Chrome 가상시계의0ms 무효 관찰도 증거에 남긴다. 이 실패들을 최종 정상 실행이나 성능 개선으로 덮지 않는다.

[후속 보고서](../../tests/integration/rhwp/evidence/t010-d4-critical-path/REPORT.ko.txt).
D1 실제 native39/39·RGBA24/24·정리3/3 PASS, D2 INCONCLUSIVE, D3·D5 보관 근거 PASS, D4 공식88/89/266/138ms FAIL,
RSS 기준 미승인 INCONCLUSIVE다. T010 전체 미완료, 생산 RHWP Undo/Redo 및 T011은 NO-GO를 유지한다.


추가 분해(같은 후속 증거의 deep-*): dirty section typeset이60쪽 `insertText`의 p50 24.0ms를 차지하고 selective measurement는0.2ms다.
화학 page14/15/19의 긴 poll은 tree보다 decoded image 준비 경로(161~170ms)가 지배하지만 codec 자체는5~9ms였다.
RGBA 변환·ImageData·Canvas 생성/업로드·입장 시도를 포함한 나머지를 codec으로 귀속하지 않는다. page20/23은 codec도80~101ms다.
cache 활동 없는 page16은 tree 약39~42ms/replay 약16ms로 나뉜다. 따라서 decode나 cache 한 가지로 모든 긴 poll을 설명하지 않는다.
이 별도 Chrome 진단의21개 baseline/진단 Full frame은 exact RGBA이며 최종 trim 뒤 job/lease/cache가0이다. native D4 성능 비교는 아니다.
다음 구현 경계는 이미지 준비/재생/게시 상태 전이와 tree 작성의 긴 동기 단위, layout은 dirty section typeset의 영향 범위 증명이다.

## T010 D4 진단 무결성 및 정확한 grayscale 변환 실험 (2026-10-24)

분석 CLI는 진단 JSON이 주장하는 해시를 기대값으로 다시 쓰지 않는다. `--expected-wasm`과 `--candidate`의 실제 WASM/JS·ENGINE manifest를
대조하고 `--fixture`의 실제 바이트에서 source SHA를 계산한다. 현재 schema는 `probeCallDropped`와 `traceDropped`가 모두 정확한 정수0이어야
완전하다. 누락된 과거 probe loss는 `--legacy`에서만 INCONCLUSIVE이며, 실패/불완전 분석은 각각 exit1/2다. malformed 구조는 계산 전에
검사한다. 이전 interval union·30표본 pairing 검증을 보존했고 Python153개가 통과했다. 공식 MEASURE에는 변경이 없다.

새 비공식 Chrome 경계 계측에서 page14/15/19의 codec은5~8ms, codec 종료부터 ImageData 호출까지는133~139ms, putImageData는약7ms였다.
가운데 구간은 RGBA 변환·소량의 binding 작업을 포함하는 벽시계 구간이지 독립 Rust CPU 시간은 아니다. 이 세 이미지는8bit grayscale PNG이며,
image0.25.10의 `Luma8 -> RGBA`가 픽셀마다 RGB32F 색 변환을 반복한다. 반면 RGB PNG page20/23의 codec은이번에도약96/73ms였다.
앞선80/101ms 관찰과 함께 이미지 codec을 문서 전체에서5~9ms라고 일반화해서는 안 된다. page16은 이미지 없이 tree/replay가 길고,
page21은 decoded hit 경로였다. Right가 직접 full render를 새로 만든다는 가설은 이전 호출별 관찰과 여전히 맞지 않는다.

격리 패치는4096픽셀 이상 Luma8에 한해 동일한 CICP를 가진256값 ramp를 원래 `to_rgba8()`로 변환하고 결과를 픽셀별로 복사한다.
직접 gamma를 근사하지 않으며 다른 표현·작은 이미지·색공간 설정 실패는 원래 경로로 간다. 전역 table이나 추가 이미지 cache를 유지하지 않는다.
job 상태·lease·취소·세대·게시·캐시 예산·history·pagination 정책은 바꾸지 않는다. 변경 후보는 `ae34c12b…`이며 승인48adaa를 덮어쓰지 않았다.
세 번의 고정 비교에서 page14/15/19 첫 poll 중앙값은186.8/178.8/183.4ms에서25.2/22.8/26.4ms로 줄었고,
63쌍 Full RGBA와 대응 cache counter/예산은 같았다. 정확한 수치는 후속 보고서와 원본 JSON이 기준이다. 다른 페이지의 개선이나 공식 D4 PASS를
뜻하지 않는다. 다른 프로젝트의 작업이 있는 공유 host이므로 시스템 전체 무부하를 보장한 실험도 아니다.

60쪽 문서는 문단4/100/500에서 편집해도 API p50 25.6~27.5ms, section typeset24.6~26.0ms였다. `run_section`은 새 TypesetState에서
dirty 구역 전체를 순회한다. 기존 convergence는 전체 typeset 뒤에 검사하며 보통 삽입에서는 para_offset0 경로다. paragraph index·쪽수만으로는
deferred table/picture·footnote 예약·wrap band·column/page geometry·header/footer/numbering carry가 같은지 증명하지 못한다.
따라서 layout 최적화는 적용하지 않았다. 다음 단위는 완료 페이지 경계에서 source/style/font/geometry 세대와 전체 flow continuation 상태의
읽기 전용 fingerprint를 만들고 Full oracle과 이후 배치·caret을 대조하는 것이다. 문단4 앞 prefix만 재사용해서는 큰 개선도 기대하기 어렵다.

[성능 보완 보고서](../../tests/integration/rhwp/evidence/t010-d4-performance-remediation/REPORT.ko.txt)에 실제 회귀·네이티브·공식 비교 결과와
승인 여부를 기록한다. 비공식 이미지 poll 개선, 공식 D4 측정, threshold 통과는 별개다. T010 전체 미완료, D2·RSS INCONCLUSIVE,
생산 RHWP Undo/Redo와 T011 NO-GO를 유지한다.

실험 후보의 새 Rust 검사는4070 PASS/13 ignored이며 Chrome·WebKit 소유권/스케줄러, 네이티브 D1(39 assertion·24 exact RGBA·정리3/3),
pending-image22개와 D3/D5 검사도 통과했다. 같은 설정의 공식 비교에서 승인48adaa group-start p95는87/87/292/135ms,
변경 후보는88/84/165/133ms였다. Undo p95는150/147/158/276ms에서171/149/152/255ms였으며 모두1500ms 이하다.
첫 후보 시도는 세 문서 뒤 네 번째 WebDriver session 생성 전송 실패로 불완전했고(화학189ms), 별도 한 차례 재시도의 첫 완전 결과를
보존했다. 실패 원인은 UNVERIFIED이며 제품 회귀로 단정하지 않는다. 유효 비교에서도 화학 max는326→359ms라 모든 tail이 줄었다고
말할 수 없다. 화학 p95 감소와 반복된 grayscale poll 개선은 관찰됐지만, 공유 host의 한 공식 비교로 범용 안정 개선을 확정하지 않는다.
네 문서 모두50ms를 넘으므로 공식 D4는 FAIL이다. 실험 patch는 보존하되 승인48adaa를 교체하지 않는다.

## T010 렌더 준비 경계의 소유권 계약·진단 무결성 (2026-10-25)

이번 변경은 분석기 교정과 **읽기 전용 경계 검사**다. 새로운 런타임 Preparing/ResourcesReady 상태는
추가하지 않았다. [보고서](../../tests/integration/rhwp/evidence/t010-render-preparation-boundary/REPORT.ko.txt)와
[소유권·후속 구현 계약](../../tests/integration/rhwp/evidence/t010-render-preparation-boundary/OWNERSHIP.ko.txt)을 따른다.
승인 WASM48adaa와 실험 Luma8 ae34·원래 패치는 그대로다. 이후 준비 실험의 기준은 ae34로 정했지만
이번에는 새 WASM을 만들거나 후보를 승격하지 않았다.

**VERIFIED, 실제 경계:** `Owner::begin_replay`는 job ID·target token·기한·replay 메타데이터만 보유한다.
`HwpDocument::poll_render_job`의 한 동기 호출이 layer tree 취득 → scratch 생성 → replay 안의
`decoded_canvas`/브라우저 이미지 요청 → waiting/기한/target 검증 → 완성 프레임 게시를 수행한다.
PENDING이면 tree·scratch는 반환 전에 사라지고 브라우저 ImageLease만 job에 남는다. 브라우저 완료는
알림만 예약하며 프레임을 게시하지 않는다. tree 뒤·codec 중간·replay 뒤 게시 전에는 호스트가
취소를 끼워 넣을 반환 경계가 없다. 이 내부 위치를 별도 취소 가능 상태로 표시하지 않는다.

**VERIFIED, immutable 값의 가능성과 비용:** `paint/layer_tree.rs::PageLayerTree`와 ResourceArena는
소유된 Vec/String 및 font Arc 데이터를 담으며 모델에 대한 빌린 참조를 보관하지 않는다. 현재
`build_canvas_page_layer_tree_with_profile`은 문서 캐시의 값을 clone해서 돌려준다. 이를 job에 보관할
타입 기반 가능성과, 그 clone의 image/text/metadata 비용을 여러 poll 동안 보유할 예산 승인은 다르다.
현재 job은 tree/revision 필드가 없으며 편집 시 Owner 무효화에 의존한다. 향후 tree는 같은 문서
owner·job ID·모델/출력/font 세대에 고정하고 변경/닫기/기한 만료 시 버려야 한다. 별도 모델 snapshot은 불필요하다.

**VERIFIED, 준비 경계를 막는 수명 제약:** decoded 캐시는 `BoundedCache<HtmlCanvasElement>`이고
Release는 width/height를0으로 만든다. `get()`의 DOM clone은 cache 퇴거를 막지 않는다. 새 Chrome
검사에서 두 후보 모두 다른 job의 정상 입장/퇴거 뒤 보관했던 handle이0×0이 됐다. 첫 newcomer는
frequency admission으로 거절될 수 있어 bounded 반복으로 실제 교체를 기다린다. 입장하지 못한
임시 Canvas도 draw 직후 해제돼 poll 밖에서 사용할 수 없었다. `Job.resources`의 기존 Rc<ImageResource>는
HtmlImageElement만 지원하며 decoded Canvas·트리·codec/RGBA/ImageData 임시 할당은 그 소유 byte에 포함하지 않는다.
따라서 cache hit와 raw DOM handle을 준비 완료의 근거로 삼는 cursor 구현은 적용하지 않았다.

**후속 구현 조건, 아직 미구현:** 기존 Rc lease/unique-resource ledger를 decoded backing까지 일관되게
확장하고, cache-only 퇴거는 참조만 놓으며 마지막 소유자가 backing을 해제해야 한다. 준비 전 예약·실제
크기 조정·입장 거절·최종 lease 해제 알림을 기존 pending/count/byte 예산과 통합해야 한다. cache+job
공유분은 한 번만 세고 비상주 job 소유분도 놓치지 않아야 한다. 현재 decoded256MiB/browser64MiB 캐시,
각256항목, browser pool256MiB·pending2·job8·한 이미지96MiB·URL32MiB, scratch64MiB/backup64MiB 한도를
늘리지 않는다. 이는 RSS 하드 상한이 아니다. 트리와 변환 임시 peak의 추가 회계가 증명되기 전에는
기존 MAX_OWNED_BYTES 수치를 전체 준비 메모리 보증으로 쓰지 않는다.

이 lease·예약 계약의 브라우저 회귀를 먼저 작성하고, 실제 변환된 payload identity를 쓰는 bounded
resource cursor를 추가한 다음에만 Preparing → ResourcesReady 반환 경계를 만들 수 있다.
일반 이미지뿐 아니라 crop/fill/watermark/RawSvg/방정식 등 실제 replay의 자원 요청을 빠뜨리지 않아야 한다.
준비 완료 뒤 replay와 최종 세대 검사는 같은 scratch 원자 게시 계약을 유지한다. 자원 사이 반환으로도
단일 동기 RGB codec100ms급 호출은 중단되지 않으며 tree-heavy page16도 별도 문제다.

분석기는 이제 WASM뿐 아니라 독립적으로 신뢰한 `--expected-js`도 요구한다. handler에는 독립 생성
`--fixtures`가 필요하며 canonical 네 문서/순서/바이트/row SHA·측정·timeline을 검사한다. 빈 perf,
누락/중복/미지 fixture, manifest와 함께 바뀐 JS, 실수30.0/불리언False 완료 값은 FAIL이다.
공식 MEASURE와 기존 증거는 변경하지 않는다. ANALYZED는 공식 D4 PASS가 아니다.

handler 분석기는 추가로 `measurementComplete is True`(수집 완전성)를 요구하고, 20개 문서/종류 묶음의
보고 통계를 원 timeline keyToFrame에서 producer `pct`와 같은 nearest-rank·한 자리 반올림으로 재계산해
정확히 대조한다(통계 정합성). 둘 다 공식 성능 수용과 별개다. 완전한 공식 FAIL 기록 두 개(48adaa·ae34)는
40개 묶음 모두 일치하고 ANALYZED다. 근거: `tests/integration/rhwp/evidence/t010-d4-handler-statistics-integrity/`.

T010 전체 INCOMPLETE, 공식 D4 FAIL, D2 native 한국어 IME·RSS INCONCLUSIVE를 유지한다.
생산 RHWP Undo/Redo NO-GO이며 T011은 시작하지 않는다.

D4 분석 무결성 후속 보강(2026-10-25)은 모든 연산의 호출 n/순차 반올림 ms/firstAt,
직렬화 원점·정밀도·RAF 구간·동기 입력 호출과 trace 관찰을 대조한다. JSON 중복 키,
비유한 숫자·계산 결과·잘못된 Unicode와 32MiB/64단계 한도 초과 입력은 FAIL이다.
출력은 allow_nan=False와 배타적 생성으로 보호한다. 공식 baseline/Luma8 FAIL 측정은
여전히 ANALYZED이며 성능 관문 통과를 의미하지 않는다.
개별 raw duration의 반올림 손실 때문에 합계는 생산자 순차 반올림의 가능한 범위로
검증한다. 절대 이벤트 ID 없는 표본의 구별 불가능한 복제나 범위 안의 합계 변조는
현재 기록만으로 판별할 수 없다. 생산자를 바꾸거나 독립 provenance를 발명하지 않았다.
새 검증 근거: `tests/integration/rhwp/evidence/t010-d4-handler-integrity-hardening/`.

D4 trace anchor 인과성 보강(2026-10-25): 이전 분석기는 같은 이름 anchor 전체의 최솟값을 호출
하한으로 써서, 더 이른 가짜 `dom:input` 하나를 끼우면 실제 입력보다 약 10초 앞선 insertText를
받아들이고 handler 구간 해석(recordedUnion 7→5ms)을 바꿀 수 있었다. 이제 MEASURE가 측정 dispatch의
anchor 발행 전에 trace 순번을 잡는다는 생산자 계약에 따라 같은 이름의 **첫 기록**만 anchor로 쓴다.
anchor는 ms가 없어야 하고 편집은 handlerEnd, undo/redo는 observed 이전에 발행되어야 하며, 편집은
기존 입력 시각 허용(at.input-2)을 하한으로 쓴다. 이 경계 이전에 확실히 발행된 같은 이름 기록이
더 있으면 모호한 연관으로 FAIL이다. 경계 이후 기록(대기하지 않는 다음 입력)은 허용한다. 발행 시
0.1ms 반올림(imeTrace)과 직렬화 반올림을 함께 구간으로 둔다. 두 공식 FAIL 기록의 40개 묶음과
240개 handler 행은 바뀌지 않았다. undo/redo는 같은 clock의 하한(handler 시작)이 직렬화되지 않아
삽입이 아닌 anchor·호출의 일관된 동시 이동은 판별할 수 없다.
새 검증 근거: `tests/integration/rhwp/evidence/t010-d4-anchor-causality-hardening/`.

Decoded resource lease·회계 기반(2026-10-25, 격리 실험 후보 a9222205, 제품 미적용): 이전 decoded 캐시는
원시 `HtmlCanvasElement`를 보관했다. 그래서 다른 job의 정상 퇴거가 대기 job이 쓴 backing을 0×0으로
만들었다(이번 실행에서 Chrome/WebKit 재현). 후보는 기존 browser 이미지의 `Rc` lease + `Weak` pool
구조를 decoded backing으로 확장한다. 캐시와 job은 같은 `SharedBacking`에 대해 각자 `Rc`를 갖고, 퇴거는
캐시 참조만 놓는다. 마지막 소유자가 놓을 때만 정확히 한 번 dispose한다. 고유 decoded bytes는 참조 수와
무관하게 할당마다 한 번 센다. 비상주(job 보유·임시) 합계는 기존 단일 decode 한도 96 MiB 이하로
예약(checked) 및 회수로 강제한다. 따라서 고유 합계는 decoded 캐시 예산 + 96 MiB를 넘지 않으며,
이는 이전 엔진의 상한과 같다. 기존 한도는 늘리지 않았다. 캐시 입장 정책, 알림, Full 게시는 같다.
캐시 통계는 baseline과 일치하고, Full RGBA와 native strict D1은 정확히 일치한다. Preparing →
ResourcesReady, tree 보존, cursor는 구현하지 않았다. decode 임시 사본(최대 약 3×RGBA)과 tree의 text·geometry는
추정이나 하한만 기록하며 강제하지 않는다. RSS는 계속 INCONCLUSIVE다.
새 검증 근거: `tests/integration/rhwp/evidence/t010-decoded-resource-lease-accounting/`.

Decoded lease 회계 보강(2026-10-25, 격리 실험 후보 94603ed3, 제품 미적용): 이전 후보의 `Reservation::commit`은
예약을 넘는 실제 크기를 검사 없이 계상했고(예약 4·한도 4에 8 bytes 계상), overflow 때는 이미 dispose한
backing을 성공 lease로 돌려줬다(함수 수준 재현; 현재 decoder에서는 헤더 크기 = 실제 크기라 런타임 도달은
확인되지 않음). 이제 commit은 `Result`이고 예약을 넘거나 넘치면 backing을 한 번 dispose하고 거절한다.
web_canvas는 Canvas 생성 전에 `authorizes`로 같은 규칙을 검사한다. 헤더 크기를 모르는 decode가 성공하면
Canvas 전에 같은 예약 함수(활성 job은 96 MiB 강제)를 거친다. image 0.25.10에서는 그 성공 경로가 도달하지
않음을 시험으로 보였다. job 하나의 decoded lease 키는 256개(decoded 캐시 entry 한도와 같음)까지만 보유하고,
넘으면 그리기용 참조만 쓰고 다음 poll에서 다시 찾는다(1×1 이미지 300개에서 이전 후보는 300개 보유, 후보는
256개, 픽셀 동일). Weak registry는 종료 정리 뒤 0이다. 브라우저 증거 validator는 이름 계약(시험·checkpoint
순서, 중복·오귀속·형식·회계식·최종 정리)을 검사한다. 이전 validator는 변조 23개 중 15개를 PASS로
받아들였다. 한도는 늘리지 않았고, 공식 판정과 RSS INCONCLUSIVE는 그대로다.
새 검증 근거: `tests/integration/rhwp/evidence/t010-decoded-lease-accounting-hardening/`.

Decoded lease 계약 마무리(2026-10-25, 격리 실험 후보 ca5c0b84, 제품 미적용): 메모리 예약(`actual ≤ reserved`)과
이미지 무결성(헤더 width·height = 디코드 width·height)을 분리했다. 이전 후보는 헤더 크기를 bytes로만 바꿔 예약해서,
더 작거나 모양만 다른(같은 bytes) 디코드 결과를 승인할 수 있었다(통제된 seam으로 재현; 현재 image 0.25.10에서는
관찰되지 않음). 이제 Canvas 할당 전에 정확한 크기 일치를 요구하고, 불일치는 음성 캐시 entry 없이 ERROR로 끝난다.
헤더 크기가 없으면 기존 사후 예약과 96 MiB 강제를 따른다. 브라우저 증거의 schema·contract는 정확한 int만 받는다
(True·1.0·2.0 거절, 계약 2는 필드 필수, 계약 1 이력의 생략은 명시적 계약 1 검증에서만 허용). 한도와 소유권 구조,
공식 판정은 그대로다. 새 검증 근거: `tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/`.

Decoded lease 준비 마감(2026-10-25, 격리 실험 후보 ca5c0b84 그대로, 제품 미적용): 브라우저 증거 계약 3을 도입했다.
계약 3은 모든 ledger checkpoint에 `dimensionMismatches`를 요구하고, 중복 ledger 복사본이 JSON 타입까지 같아야 한다.
계약 1·2 이력 증거는 바꾸지 않았고 각자의 계약에서만 PASS다. `cache_contract.rs`의 두 역사적 실패는 FAIL로 남는다.
둘 다 render-ownership 이후 엔진이 호출하지 않는 `BoundedCache` pending API를 검사하며, 기대가 위 job 소유 계약
(trim은 활성 job을 취소, oversize 완료는 job이 ready lease로 보유)과 충돌한다. 지원 API 경로의 같은 상황은
브라우저 `two-oversize-complete`·`notification-progress-trim`이 통과한다. native D1 cleanup 실패는 앱이 WebDriver 체인보다
오래 살아남은 orphan 모양과 같지만(통제 실험으로 재현), 실제 하네스 순서에서는 재현되지 않아 원인을 확정하지 못했다.
gitleaks 설정의 모든 `[[allowlists]]`에 `targetRules`를 붙였다. 붙이기 전에는 `dir` 검사가 해당 경로 파일을 통째로
건너뛰었다(`git` 검사는 영향 없음). 공식 판정은 그대로다.
새 검증 근거: `tests/integration/rhwp/evidence/t010-decoded-lease-readiness-closure/`.

잔여 안정화(2026-10-25).
- native D1 증거 wrapper가 fail-closed가 되었다. 이전 wrapper는 하네스 종료 코드를 그대로 돌려줬다. 그래서 하네스가 0으로
  끝나면 결과 JSON이 없거나 FAIL이어도, cleanup이 false여도 0으로 끝났다(controlled fake로 재현: 무효 10가지 중 8가지).
  지금은 `native_d1_result.validate()`가 39 단언, exact RGBA 24, cleanup, teardown, 신원, 의존 파일, 관찰기를 모두 다시
  확인해야 0이다.
- cache 계약을 둘로 나눴다.
  · 현재 지원 계약은 `cache_current_contract.rs`로, 21개 시험이 PASS다.
  · 역사적 v2 기대는 `cache_contract.rs`로, 바꾸지 않았고 18 PASS / 2 FAIL이다. 두 결과는 따로 보고한다.
- `tauri_smoke.tauri_driver()`가 정리 과정을 읽기 전용으로 기록한다(`TEARDOWN`). 기록 내용은 DELETE 결과, tauri-driver
  종료 코드, 드라이버 종료 직전·직후와 30초 뒤에 남은 소유 프로세스(이름·상태·부모 PID), SIGTERM 대상과 그 뒤에도 남은
  프로세스다. 앞선 오류가 있어도 남은 프로세스 진단을 그 오류에 덧붙인다. 정리 순서, 30초 기준, 실패 판정은 같다.
  과거 D1 정리 실패의 원인은 여전히 UNVERIFIED다.
- 2636a65가 Gitleaks 예외를 다른 작업과 한 commit에 넣은 것을 정책 편차로 기록했다(PENDING_APPROVAL). 이력은 다시 쓰지 않았다.
- 공식 판정은 그대로다. 근거: `tests/integration/rhwp/evidence/t010-readiness-residual-stabilization/`.

native D1 증거 보안 강화(2026-10-26).
- 이전 판정은 진짜 증거를 하나씩 바꾼 합성 입력 32가지 중 29가지를 받아들였다(재현). 받아들인 것은 다음이다.
  · 강제 kill된 드라이버, 지원하지 않는 종료 코드.
  · 새 teardown 필드가 빠지거나 타입이 틀린 것.
  · 필수 의존 파일이 빠진 것, 의존 파일 digest 형식이 틀린 것.
  · 신뢰 기준과 다른 후보 JS, 인자와 결과가 함께 틀린 WASM에 맞춘 것.
- `exit_code()`는 verdict가 PASS라고 하면 하네스 종료 코드 2도 0으로 바꿨다.
- 지금은 다음을 모두 요구한다.
  · 드라이버 종료 계약(강제 kill 없음, 종료 코드 0 또는 -SIGTERM).
  · teardown 전체 schema.
  · 버전이 있는 필수 의존 파일 manifest(v2, 22개, 프런트엔드 `src/` 집계 포함).
  · 커밋된 후보 신원 기준(바이트 고정).
  · 하네스 종료 코드 0과 형식이 맞는 PASS의 동시 충족.
- 강화한 판정으로 실제 native D1을 3/3 다시 실행해 PASS였다. 공식 판정은 그대로다.
- 근거: `tests/integration/rhwp/evidence/t010-native-evidence-security-hardening/`.

## T010 설계 검토: 기록 수용·메모리 회계·HWPX 서식 header 규칙 (2026-10-26)

기준 `1614e15`(submodule rhwp `1a76570`·WordCraft `fc41918` 그대로, 제품 WASM `a91fa6a4…`, 공식 판정과 후보는 바꾸지 않음).
증거·명령·종료 코드: `tests/integration/rhwp/evidence/t010-design-review-admission/`([보고서](../../tests/integration/rhwp/evidence/t010-design-review-admission/REPORT.ko.txt)).

**고친 결함(CONFIRMED DEFECT — FIXED).** 제품 빌드의 세션이 기록을 만들었다: `startHistory()`가 레지스트리 지원과 무관하게
`RhwpHistory`를 켜서, rhwp `edit.undo`·`edit.redo`가 `unsupported`인 제품에서도 그룹 시작마다 `saveSnapshot`(큰 문서에서 ≈25 ms)을
부르고 최대 51개를 붙들었다(수정 전 재현: 제품 구성 세션에서 편집 그룹 4개 → 스냅숏 4개). 쓸 수 없는 기능을 위한 지연·메모리이고,
찍기 trap은 편집을 멈추는(불확실) 실패 경로다. 지금은 레지스트리가 rhwp 실행 취소·다시 실행을 지원으로 선언한 빌드(지금은 시험 활성화
빌드)에서만 켠다. 시험은 세션 선택 `{ history: true }`로 명시한다(`testing.ts` `readySession` 기본, WASM 통합 시험). native 하네스는
`VITE_GEUL_TEST_RHWP_HISTORY=1`로 빌드하므로 D1–D5의 구성은 같다(INFERRED: 이번에 native를 다시 실행하지 못함, 아래).

**메모리 예산(문서/구현 불일치 정정).** §10은 `max(원본 크기, 첫 스냅숏 전후 WASM 증가)`라 했지만 구현은 원본 크기만 썼다. 고정 WASM으로
공개 예제 1204개 중 1201개를 새 프로세스마다 열고 스냅숏 24개를 붙들어 선형 메모리 상한선 증가를 쟀다(node, 그리기 없음):
스냅숏당 증가/파일 크기 p50 2.4·p90 8.0·p99 19.3·최대 62.3(증가가 보인 1189개). 원본 크기 대용으로 깊이 50이 되는 2.3 MB HWP는 스냅숏당
≈31 MiB라 살아 있는 51개면 ≈1.5 GiB다(어림, 13개 문서에서 정정된 어림이면 깊이가 달라짐). "첫 스냅숏 증가"는 빈 공간 때문에 대부분 0이라
측정으로 쓸 수 없고, 문서를 열 때의 증가는 표본 모두에서 스냅숏당 증가 이상이었지만 그림 많은 문서에서 수십 배 과대(12 MB 화학 HWP:
열기 38.6 MB, 스냅숏당 ≈0.8 MiB)라 D1·D4 문서의 기록을 끌 것이므로 쓰지 않았다. 그래서 어림은 원본 크기 그대로 두고(보수적이지 않다고
문서화) **관찰값 감시**를 더했다: 모듈이 선형 메모리 크기를 알려 주면(`RhwpModule.memoryBytes`, 앱 로더가 wasm-bindgen `memory`에서 읽음)
기록을 켠 뒤 상한선이 `HISTORY_BUDGET_BYTES`(256 MiB)보다 더 자랐을 때 새 그룹을 찍지 않고 `limit`으로 거절 → 세션이 기록을 끄고 편집은
계속한다. 실행 취소의 지금 상태 찍기는 I2의 자리 안이라 막지 않는다. 구별: 스냅숏 수·깊이 상한(I2·I3, 엔진 상한 100) / 회계 예산(256 MiB,
선형 메모리 증가로 감시 — 기록 밖 증가도 세므로 보수적) / 어림(원본 크기) / 프로세스 RSS(이 규칙과 무관, 승인 기준 없음 — INCONCLUSIVE).
256 MiB는 RSS 상한이 아니며 바이트 정확한 기록 크기도 아니다. D1 문서의 실측 스냅숏당 증가(화학 ≈0.8 MiB, 60쪽 HWPX ≈1.3 MiB)로는 51개도
감시 한도에 크게 못 미친다(INFERRED).

**검토했지만 결함이 아닌 것.** I1–I3·ID 보호 예약·끝에서만 지움·다시 실행 무할당·취소한 트랜잭션의 스냅숏 버림·쉼 1.5초·포커스/문서 전환
경계는 코드와 기존 시험(알고리즘 11·세션 14·초점 10·무작위 2만 단계×3)이 맞다. "용량이 줄었을 때 예약 뒤 취소하면 기존 기록을 잃는가":
잃는다 — 다만 그 지우기는 줄어든 상한에서 I2를 되살리는 것이고(줄기 전 상태는 이미 I2 위반), 고정 판의 `snapshotCapacity()`는 상수
100이라 도달하지 않는다(UNVERIFIED 이론 위험, 결함 아님). 시간선 알고리즘은 바꾸지 않았다.

**HWPX 서식(Phase 3B).** 실측(생성 픽스처): 기울임·밑줄·취소선 → 새 `charPr` 하나 + `itemCnt` +1, 나머지 header 바이트 같음; 굵게 → 있는
모양 재사용. T009에 좁은 header 규칙을 더했다([save-preservation.md](save-preservation.md) "글자 서식 덧붙임"). 실제 엔진 출력 → 실제
`service::save`: 본문 기울임·셀 밑줄 게시, 다시 열어 서식 같음, HWP는 계속 거부(`recordsChanged{DocInfo}`+`previewStale`), 음성 대조 그대로.
서식 명령은 구현하지 않았다(SC-003 공백, 아래).

**관문(이번 세션에서 바뀐 것 없음).** D1 native: 이번 프런트엔드로 **NOT RUN** — v3 wrapper의 신뢰 기준 후보 `ca5c0b84…` 패키지가 디스크에
없다(남은 것: Rust 1.99 `57280d57…`·`8fb44739…`·기준 `eaa88f65…`). 기준을 옮기지 않았다. 마지막 PASS 39/39·RGBA 24는 이전 소스의 기록이다.
D2 INCONCLUSIVE(새 native 근거 없음, 가드 유지). D3 PASS(`undo_save.py` 이번 실행 불일치 0, `save_service.py --strict-desired` 23행 불일치 0).
D4 FAIL(첫 유효 공식 기록 유지, 이번에 재측정하지 않음 — 렌더 경로를 바꾸지 않았다). D5 보관 PASS(실제 WASM 폐기 예외 시험 이번에 통과,
native 재실행 없음). RSS INCONCLUSIVE. **결정: 제품 rhwp 실행 취소·다시 실행 NO-GO**, T010 미완료, T011 시작하지 않음.

## T010 교정: 메모리 감시 fail-closed·구성 분리·D1 재구성 (2026-10-26)

기준 `a342a90`(submodule·제품 WASM·후보·신뢰 기준 그대로). 증거: `tests/integration/rhwp/evidence/t010-corrective-validation/`
([보고서](../../tests/integration/rhwp/evidence/t010-corrective-validation/REPORT.ko.txt)).

**메모리 감시(CONFIRMED DEFECT — FIXED).** 이전 판은 두 경로로 감시를 건너뛰었다(수정 전 재현 32/34 실패): 모듈에 측정이 없거나 시작
측정이 실패하면 감시 없는 기록을 만들었고(`{undo:false,redo:false}`), 시작 뒤 측정이 실패하면 세션이 0으로 바꿔 넘겨 증가가 음수가 되어
예산 검사를 통과했다. 지금 계약(`RhwpHistory.readMemory`): 측정 함수는 필수이고 읽은 값은 0 이상의 안전한 정수이며 같은 기록 안에서
줄지 않아야 한다. 없음·예외·NaN·Infinity·음수·소수·다른 타입·안전 정수 밖·감소는 측정 불가 → `HistoryRefused("unavailable")`로,
예산 초과(`limit`)와 구별한다. 스냅숏을 새로 찍는 두 경로(새 그룹의 before, 실행 취소의 지금 상태)는 지우거나 찍기 **전에** 읽는다;
할당하지 않는 전이는 읽지 않는다. 세션은 측정이 없거나 시작 측정이 어긋나면 기록을 만들지 않고(`unavailable`), 도중의 측정 불가는
기록을 끄고 참조 스냅숏을 엔진에서 버린다(엔진은 믿을 수 있으므로) — 문서·revision·IME는 그대로이고 그 편집은 한다. 진짜 찍기 trap은
지금처럼 불확실·편집 멈춤. 실행 취소의 지금 상태 찍기는 예산 초과로는 막지 않는다(I2 자리 안, 이전 판과 같음). 기록을 켜는 시험
fixture와 native PoC 어댑터(`ownership-poc/session.mjs`)는 실제 wasm-bindgen `memory`(PoC)나 결정적 값(가짜)을 준다.

**구성 분리(VERIFIED).** 번들: 일반·검사 훅만 켠 빌드는 rhwp 지원 상수가 `unsupported`, 시험 활성화 빌드만 표지와 함께 `supported`
(`bundle-configs.jsonl`). 실제 WASM + 앱 로더(`loadRhwpModule`, 실제 exports의 `memory`): 일반·훅 구성에서 실제 편집에 `saveSnapshot`
0회·명령 거절, 시험 활성화 구성에서 4인자 생성 세션이 기록을 켜고 `execute("edit.undo"/"edit.redo")`가 실제 문서를 되돌리며 새 그룹
전에 실제 측정을 읽음, 한 모듈의 두 문서에서 한 문서를 닫아도 다른 문서의 기록이 그대로(`history-config.wasm.test.ts`,
`history-enabled.wasm.test.ts`).

**D1(NOT RUN).** 신뢰 기준(`1699dfbe…` 파일, 후보 WASM `ca5c0b84…`)은 격리 rustc 1.93.1로 빌드되었다. 그 도구와 정확한 후보 바이트가
이 호스트에 없고(큰 WASM 8개 해시 대조 불일치, 로컬 도구 1.99.0·1.97.1), 도구 설치는 이번 범위 밖이다. 다른 컴파일러로는 신뢰 바이트를
만들 수 없으므로 재빌드하지 않았고 신뢰 기준을 바꾸지 않았다. 관문: D1 NOT RUN(이번 소스), D2 INCONCLUSIVE, D3 PASS(이번 실행),
D4 FAIL, D5 보관 PASS, RSS INCONCLUSIVE → **제품 rhwp 실행 취소·다시 실행 NO-GO**, T010 미완료, T011 시작하지 않음.


### 2026-10-26 T010 native gate 복구 및 현재 D4 검증 (미완료)

T009 부분 개선 `1ae3cde`와 별도 작업이다. full555f patch의10파일 replay/8 source SHA는 PASS지만
exact ca5c 후보와 Rust1.93.1은 없어 D1 NOT RUN이다. 추가 후보 경로 없음은 사용자 확인 사항이다.
초기 driver 부재 후 cached2.0.4를 Rust1.99 offline으로 복구하고 current app을 빌드했다.
IBus/Hangul은 여전히 없어 D2 INCONCLUSIVE이며 awaiting-final guard는 유지한다.
현재 native D4 OFF/ON 각각 첫 완주에서4문서 group p95는91/87/241/130 및94/90/226/130ms로 모두 FAIL,
Undo p95는 모두1500ms 이하다. 동일 e88d 실험 신원·공식3RAF·50/1500ms 문턱을 유지했다.
preparation은 일부 handler를 줄였지만 gate를 해결하지 못해 생산 승격/추측 renderer 패치를 하지 않았다.
no-new-input witness는 queued work를 포함할 수 있어 물리 frame floor로 단정하거나 지연에서 빼지 않는다.
현재 trace/신원/cleanup과 첫 구성 오류도 보존했다. D4는 trusted native D1 승인을 대신하지 않는다.
별도 Chrome/WebKit49단언/42 exactRGBA PASS, native 두 run 관찰된 프로세스 잔존 없음.
D3 현재 저장 PASS, D5 archived PASS, RSS INCONCLUSIVE. backend T009 HWM은 T010 RSS와 별개다.
증거: `tests/integration/rhwp/evidence/t010-native-gate-remediation/`.
Undo/Redo NO-GO·formatting unsupported·T010 미체크·T011 NOT STARTED. 설치/다운로드/push/anchor·gitlink 변경 없음.

## T010 native lease 소유권·프로세스 범위·D4 쪽 그림자 교정 (2026-10-28, 미완료)

기준 `95ad88c`. gitlink·제품 WASM·신뢰 기준·문턱·공식 producer 그대로. 증거:
`tests/integration/rhwp/evidence/t010-native-lease-ownership/`, `tests/integration/rhwp/evidence/t010-d4-frame-floor/`.

**Lease(진단 PASS, 2회 재현).** 실제 앱·WebKitGTK·후보 0cb73f70에서 양의 lease를 처음 관측했다. 비동기 이미지 lease는 Rust가 decode하지
못하는 그림(실제 SVG 픽스처)만, decoded lease는 preparation이 켜진 job만 여러 poll에 걸쳐 유지한다(소스 확인). 획득·두 문서 공유
backing·한쪽 취소·멱등 취소·로드 완료까지 유지·완료 해제·재사용·캐시 비입장·resident 축출 중 lease 유지(decoded, 빈도 입장 정책상 B를
2회 요청해야 축출)·마지막 해제 시 dispose·대기 중 문서 해제·늦은 콜백·앱 문서 revision 교체(옛 job CANCELED, Canvas 변화 0)·앱 문서
닫기를 엔진 counter와 정확 RGBA로 확인했다. 이미지 경로의 resident 축출-중-lease는 NOT EXERCISED, 물리 메모리 해제는 UNVERIFIED.

**프로세스(VERIFIED).** 하네스를 child subreaper로 만들고(pidfd·start ticks 신원) 개인 dbus-daemon을 자식으로 둔다. 실제 실행에서
WebKitWebDriver·geul·WebKit 보조 프로세스가 부모보다 오래 살아 입양되었다 — 이전 관찰 방식에서는 빠져나갈 수 있던 경로다. 생존자 0.

**D4(공식 FAIL 유지, 2개 문서 PASS).** 같은 앱·입력·3RAF 끝점의 대조군으로, `.rhwp-page`의 blur 그림자가 있으면 Canvas 갱신 뒤 프레임이
약 60 ms가 되는 것을 개입 실험으로 확인했다(그림자를 다른 요소·합성 레이어로 옮겨도 같음, blur 없는 그림자·outline은 무작업 수준).
`.rhwp-page`를 blur 없는 `--page-edge`로 바꿨다(문서 Canvas 픽셀 무관). 공식 producer 첫 완주 유효 시도: group-start p95 기본 HWP 91→47,
HWPX 89→48 PASS, 화학 212→95, 자산 125→81 FAIL, Undo 모두 PASS. 남은 두 문서는 handler 안 엔진 작업(자산 p50 49 ms)이 주 단서다.
앞선 시도 3개는 WebDriver 끊김·1420 TIME_WAIT 인프라 오류(측정 없음)로 보존했다.

**관문.** D1 NOT RUN(신뢰 후보 ca5c0b84·Rust 1.93.1 없음), D2 INCONCLUSIVE(ibus·ibus-hangul 실행 파일 없음 — 설치 필요), D3 보관 PASS
(이번 변경은 저장·명령 경로를 바꾸지 않아 다시 실행하지 않음), D4 FAIL, D5 보관 PASS, RSS INCONCLUSIVE(규범 한도 없음).
**결정: 제품 rhwp 실행 취소·다시 실행 NO-GO, rhwp 서식 미지원(세션 서식 명령 미구현), T010 미완료(선행 T007–T009도 미체크), T011 시작하지 않음.**

## T010 증분 쪽 나눔·서식 명령·D1 기준 v2·D2 실제 IME (2026-10-28, 미완료)

사용자 승인: (1) 본문 증분 쪽 나눔, (2) 화학 문서 꼬리 귀속, (3) HWPX 서식 명령, D2용 ibus·ibus-hangul 설치(nix store만), D1 신뢰 기준 교체.
gitlink·제품 WASM·문턱은 그대로. 증거: `t010-d4-pagination-attribution`, `t010-d4-format-memo`, `t010-d4-chemical-jobs`,
`t010-rhwp-format-commands`, `t010-d2-native-ime`, `t010-d1-trust-anchor-v2`.

**증분 쪽 나눔(격리 rhwp patch).** 본문 편집은 dirty 구역 전체를 다시 조판했고 그 대부분이 문단 format이었다(자산 문서 텍스트 루프
12.8 ms). 깨끗한 문단의 format 결과를 패스 사이에 재사용한다 — dirty 비트, 번호 표지·조합 번호, 어울림 증거·사다리·프로파일, 스타일
세대 번호(스타일을 바꾸는 모든 곳에서 전역 유일 값), 폭·플래그가 모두 같을 때만. native release에서 자산 문서 insertText 15.1→6.4 ms,
앱 안 18→8 ms. 메모 켬/끔 차등 오라클: 공개 예제 1149개·편집 34380회·SVG 12637쪽 불일치 0(거대 표 예제 1개 실행 중).
후보 WASM `97a57509…`, Chrome·WebKit 계약 gate PASS.

**D4(공식 FAIL 유지).** 같은 producer 첫 완주: 기본 HWP/HWPX group p95 48/47 PASS, 화학 104·자산 77 FAIL, Undo 모두 PASS.
남은 원인(관측): 화학 문서는 키마다 이미 그린 쪽 7–15개를 다시 그리고(250개 중 픽셀 변화 3개) 그 일이 다음 키 입력을 막는다(INFERRED),
자산 문서는 렌더 13 ms·편집 뒤 프레임 간격 p95 82 ms. 다음은 바뀐 쪽만 다시 그리는 무효화(엔진의 쪽별 변경 정보)다.

**서식(시험 활성화 빌드만).** rhwp 굵게·기울임·밑줄·취소선: HWPX·같은 문맥 선택·기록 켜짐·IME 안정일 때만, 한 변경 = 한 실행 취소
단계. 실제 WASM 4, 실제 service::save 7사례(HWP 음성 대조 거부·원본 유지), 실제 앱 X11 키·리본 12/12 PASS. HWP는 저장 보존 규칙상 미지원.

**D1 PASS(기준 v2).** 승인된 교체: manifest v4 = v3에서 기준·gate·wrapper 경로만 바꿈(이전 기준 보존). 새 후보로 39/39 단언,
24/24 정확 RGBA(차이 0), 정리 3/3, 남은 프로세스 0.

**D2 INCONCLUSIVE.** 실제 IBus 1.5.33·ibus-hangul 1.5.5로 동작 관문 25개 PASS, 순서 행렬 36회 모두 안전하지만 계약이 요구하는
"빈 조합 끝 → Ctrl+Z → 늦은 최종 글자" 창은 관측되지 않았다.

**결정.** 공식 D4 FAIL·D2 INCONCLUSIVE·선행 T007–T009 미체크 → T010 미완료, 제품 rhwp 실행 취소·다시 실행 NO-GO, rhwp 서식은 시험
활성화 빌드의 HWPX만, T011 시작하지 않음. D1 PASS(v2 기준), D3 서식 저장 PASS, D5는 보관 PASS(이번 변경은 취소 경로를 바꾸지 않아
다시 돌리지 않음).


## T010 오라클 해석 정정 (2026-10-28 후속 검토)

위 1149개 결과에서 12,637은 성공한 SVG 비교의 보고 건수다. 당시 오라클은 양쪽 SVG 렌더가 모두 오류일 때 이를
기록하지 않았고 비대칭 문서 열기도 건너뛰었으므로, 그 집계만으로 모든 대상 페이지의 성공적 비교나 모든 미열림의 대칭성을
입증할 수 없다. 수정본과 재검증은 진행 중이며 거대 표 문서는 여전히 UNVERIFIED다. 기존 결과와 판정은 보존한다.
상세: `tests/integration/rhwp/evidence/t010-continuation-20261028/REPORT.ko.md`.

**후속 렌더 신원 조사.** 격리 엔진 테스트에서 서로 다른 rectangle 좌표가 같은 전체 레이어 트리 JSON으로 직렬화됐다
(좌표를 소수 셋째 자리로 반올림). 별도 Chrome Canvas 최소 예제의 전체 RGBA에서는 그 좌표쌍으로 240픽셀 차이가 났다.
이는 기존 JSON 요약이 완전한 렌더 신원임을 보장하지 못한다는 근거이며, 실제 문서의 렌더 결함 재현이나 최적화 검증은 아니다.
안전한 쪽별 무효화와 D4 재측정은 미완료다. 상세는 위 후속 증거 디렉터리의 `REPORT.ko.md` 참고.
시험 전용 `damage` 어댑터는 새 model version에서 이 손실된 요약만으로 이전 Canvas를 재사용하지 않고 Full job으로 돌아가도록
교정했다. 이 조치는 추가 렌더를 발생시키는 보수적 안전 경계이며 성능 해결은 아니다. 실제 WebKitGTK 화학 문서 단일 진단의
독립 Full 참조 6/6은 정확 RGBA 차이가 없었지만, 모든 페이지나 전체 D1 관문을 검증한 것은 아니다.
이후 같은 WASM과 fail-closed 시험 어댑터(`candidate-damage`)의 공식 D4 네 문서 측정은 완주했으나 group-start p95가
49/50/178/99 ms여서 FAIL이다. Undo는 모두 기준 안이다. 이전 candidate-full 측정과 서로 다른 mode이므로 차이를 단일 원인으로
귀속하지 않는다. 현재 자세한 표와 원시 결과는 후속 증거 디렉터리에 있다.
시험 어댑터에서 새 revision에 재사용할 수 없는 요약 계산도 피한 뒤 같은 공식 producer를 다시 실행했다. 네 문서 group-start
p95는 45/45/114/81 ms여서 D4는 계속 FAIL이며, Undo는 모두 PASS다. 실행 간 차이만으로 성능 개선의 인과관계를 확정하지 않는다.
현재 수정된 시험 어댑터 소스와 기존 WASM에 대해 승인 anchor v2·manifest v4 D1을 다시 실행해 39/39, 정확 RGBA 24/24,
의존성 안정성과 native 정리를 확인했다(`candidate-full`, 후속 증거 `d1-current-attempt1`). 이는 D4 FAIL을 바꾸지 않는다.
후속 실제 IBus 동기 모드(`IBUS_ENABLE_SYNC_MODE=1`) 시도에서도 동작 25 관문과 36회 안전성은 통과했으나 필수 늦은 확정 순서는
0/36 관측됐다. D2는 INCONCLUSIVE를 유지하며, 해당 순서가 불가능하다고 결론내리지 않는다.

후속 시험 어댑터는 완료 Canvas의 엔진 job 토큰이 바뀐 경우에도 재사용하지 않도록 교정했다. fake 회귀 52/52와 화학 문서
native 선택 프레임 정확 RGBA 6/6이 통과했다. 토큰은 별도 WASM 인스턴스의 동일 숫자 ID와 임의 외부 그리기를 감지하지 못하며 변경 후 공식 D1/D4 재검증은 미실행이다.
이 변경의 공식 D1 anchor v2 재검증은 candidate-full 39/39 단언과 24/24 정확 RGBA로 PASS했다. 공식 D4 재검증은 남아 있다.

## T010 첫 그리기 재시도·D4 엔진 경계 조사 (2026-10-30, 미완료)

**첫 그리기 재시도(수정).** `RhwpSurface`는 커서 쪽 그리기가 false면 그 쪽을 `stalePages`에 넣었지만, 예약은 그 쪽을 뺀
`rest`만 보았고 판 기록(`rendered`)은 이미 지금 모델로 바뀌어 있어 다음 편집 전까지 다시 시도하지 않았다(스크롤·resize도 마찬가지).
이제 세션이 아직 그릴 수 있으면(`ready`, 표시 한도 없음) 실패한 커서 쪽을 다른 대기 쪽보다 먼저 같은 판으로 한 번 다시 시도하고,
그 뒤에는 다른 쪽과 같이 새 viewport 요청 때만 다시 시도한다. 엔진 예외(`markFailed`)·표시 한도면 다시 시도하지 않는다. 판 기록은
"이 판의 예약을 맡았다"는 뜻이고 쪽별 완료는 `stalePages`가 맡는다. 고정 엔진에서 false는 사실상 엔진 예외(종료)나 이미 걸러진
그리기 불가 상태에서만 나오므로, 회복 가능한 실패는 `renderPage` 계약 수준(가짜)으로 재현했다. 회귀: `repaintScheduling.test.tsx`
"caret-page (first) draw failure" 6개, `RhwpSurface.test.tsx` StrictMode 재실행 1개(수정 전 4개 실패). 실제 앱 D1 `--render`는 수정 전후
같음(22 PASS, 셀 경계 조회 2 FAIL은 수정 전에도 같음). D4와 무관하다.

**insertText 동기 경계(고정 rhwp 1a76570 소스, VERIFIED).** 본문: `text_editing.rs` `insert_text_at_caret_native`(1434–1582) →
`Paragraph::insert_text_at_caret` → `reflow_paragraph`(1706, 그 문단 줄 나눔) → `recalculate_section_vpos` → `recompose_paragraph`
(`rendering.rs` 4279: 모든 쪽 트리·레이어 JSON·셀 레이아웃 캐시 비움 `invalidate_page_tree_cache` 7307, 구역·문단 dirty) →
`paginate_if_needed`(4886) → `paginate_pass`(4919): 문서 전체 번호 표지 다시 정함, dirty 구역마다 dirty 문단만 다시 재고
(`measure_section_selective`) **구역 전체를 다시 조판**한다. 단 소속이 바뀌면 최대 2회 더 반복. `find_convergence`(5301)는 전체
조판을 끝낸 뒤 진단 출력만 하고(문단 수가 바뀐 경우만), `copy_converged_pages`는 호출되지 않는다 — 증분 재사용은 없다.
셀: `replace_text_in_cell_native_impl`(1842)은 `insertTextInCell`이면 같은 `paginate_if_needed`, `…DeferredPagination`이면 표 셀 전용
지연 descriptor(임시 쪽)를 남긴다. `pageCount`(mod.rs 368)·`getPageInfo`(2892)는 저장된 쪽 나눔만 읽어 조판을 일으키지 않는다.
`getCursorRect`는 `find_text_scan_pages_for_paragraph`(쪽 나눔)와 `build_page_tree_cached`(캐시가 비었으므로 커서 쪽 트리를 새로 만듦)에,
hit test·선택·그리기도 쪽 나눔과 쪽 트리에 의존한다. 그래서 쪽 수·쪽 크기·커서는 편집 직후 완전한 쪽 나눔이 필요하다.

**비용(VERIFIED, 조건 명시).** 제품 Release WASM 3f99a74b, Node 24.21, 자산 문서(60쪽, 구역 0이 50쪽) 0:4:0 30표본: insertText p50
24.4 ms = 문서 수정 0.42 + 쪽 나눔(`endBatch`) 24.2; 커서 첫 질의(쪽 트리 생성) 2.3, 레이어 JSON 6.8(직렬화 370 KB), readPages 0.7.
화학(24쪽·24문단)은 insertText 0.5 ms. 실제 앱(WebKitGTK 2.54.1, debug 앱 + Vite dev, 공식 D4 timeline) 자산 group-start handler
p50 약 62 ms 순서: saveSnapshot 1 → insertText 27 → readPages 1–2 → React·커서 약 5 → 레이어 JSON 7 → 요약 parse/walk 4 →
띠 다시 그리기 12(엔진, drawImage 4–5 포함); handler 뒤 3-RAF까지 p50 약 19·최대 27. 63798ea 공식 D4 두 번: group-start p95
기본 52/45, 47/45, 화학 50/52, 자산 89/97 → FAIL. 요약을 끄고 쪽 전체를 다시 그린 실험은 자산 handler p50 −8 ms였지만 p95는
그대로, 화학 그리기 5→16 ms라 채택하지 않았다. 2026-10-28 format 메모 patch(앱 안 18→8 ms)는 다른 후보 WASM이며 그때도 자산 77 FAIL.

**판단(INFERRED).** handler 안 단계는 순서대로 실행되므로 더할 수 있다. 자산 p95 ≤50 ms에는 handler가 약 25–28 ms여야 하는데
쪽 나눔만 24–27 ms다. geul만으로는 풀 수 없다. 쪽 나눔을 없애도(≈36 ms) 레이어 JSON 비교·엔진 그리기가 남아 부족하다.
Worker는 같은 동기 작업에 Canvas/픽셀 전송을 더할 뿐 끝점(편집이 보이는 프레임)을 앞당기지 않으며 IME 순서·revision·스냅숏·lease
소유권 비용이 크다 — 지금 근거로는 정당화되지 않는다. readPages 증분화는 이득 1–2 ms 이하.
**다음 실험(하나):** 격리 rhwp export에서 본문 증분 쪽 나눔 — 편집 문단이 속한 쪽의 시작 상태에서 다시 조판하고, 쪽 시작 상태
(문단·줄·단·각주/미주 이월·머리말/꼬리말 carry·번호·표 이어짐)가 이전 결과(문단 offset 반영)와 같아지는 첫 쪽에서 멈춰 이후를 잇는다.
전체 쪽 나눔으로 돌아갈 조건: 단 소속 변경, 경계에 걸친 표 이어짐·떠 있는 개체 어울림, 각주·미주, 번호 표지 변화, 구역/쪽 정의·
머리말/꼬리말 컨트롤, 숨은 빈 줄·vpos reset. 관문: "증분 = 전체" 등가 오라클(공개 예제·무작위 편집, 쪽 트리 비교), Node
`endBatch` 분해 측정, 그 뒤 정확 RGBA·공식 D4. 그 다음 후보는 엔진의 쪽별 변경 정보(레이어 JSON 비교 대체)다.
**결정:** D4 FAIL, T010 미완료, 제품 rhwp 실행 취소·다시 실행 NO-GO. 측정 스크립트·원시 결과는 비공개 geul-tests
`reports/d4-latency-20261030/`(`engine_boundary.mjs`, `focused_stages.*`, `d1_render_runner.py`).

## T010 지연 표본 소유·엔진 실패 중단·격리 증분 쪽 나눔 실험 (2026-10-30, 미완료)

**표면(66c5bdc).** 응답 시간 표본은 그 입력이 만든 판의 커서 쪽을 **실제로 그린 뒤** 두 번째 frame에 한 번만 남는다(`LatencySample`
ref: 입력 시각·판·그림 여부, ref가 가리키는 표본만 기록). 커서 쪽 그리기가 실패하면 표본은 기다리고, 같은 판의 한 번의 다시 시도가
그리면 그때 기록, 다시 시도도 실패하면 버린다. 새 판·엔진 실패·unmount·세션 교체는 기다리던 표본을 버린다(옛 RAF는 ref가 바뀌어
기록하지 못함). 엔진 실패(`status`가 ready가 아님)는 남은 쪽 작업과 dirty 집합을 거두어 scroll·resize가 큐를 다시 세우지 않는다.
대기 task도 그리기 전에 세션 상태를 확인한다. 표시 한도는 따로 둔다(배율이 돌아오면 새 render가 다시 정함). 내부 2-RAF 정의와
공식 D4 3-RAF는 바꾸지 않았다. 새 시험 8개 중 7개는 수정 전 코드에서 의도한 이유로 실패(표본 기록, 실패 뒤 timer 남음/그리기
호출)하고 성공 경로 1개는 전후 통과. Vitest 44파일 847 PASS, typecheck·lint PASS. 엔진 실제 경로의 복구 가능한 `false`는 여전히
가짜 실패로만 재현한다(native 미검증).

**쪽 나눔 계약.** [rhwp-incremental-pagination.md](rhwp-incremental-pagination.md)(a4b6e1a): checkpoint·경계 상태 전체 동등·
소급 수정 유효성·입력 동등·이웃 노출 서명·fallback 이유 코드·A/B 오라클. 기존 `find_convergence`(offset 0이면 `Some(0)`)와
`copy_converged_pages`는 쓰지 않는다.

**격리 실험(제품 미적용).** 고정 1a76570의 `git archive`를 비공개 geul-tests `reports/t010-incremental-pagination-20261030/rhwp-src`
(자체 git, 기준 8f2b163)에 두고 TypesetEngine 경로에만 구현했다: `renderer/typeset/incremental.rs`(판정·checkpoint 기록·수렴·캐시
교체·계측), `typeset/state/incremental.rs`(상태 스냅숏·비교·소급 수정 기록), `run_section` 문단 루프 hook, `paginate_pass` 호출부,
`StateView` 등 상태 타입 `Clone + PartialEq`, WASM API `setIncrementalPagination`·`getIncrementalPaginationReport`. 패치는
`incremental-pagination-v2.patch`(측정본 faee2e9)와 rustfmt만 한 v2.1(7bb73f6). gitlink·제품 WASM·Cargo.lock 그대로.
- v1(입력을 `Debug` 문자열 해시로 비교)은 정확했지만 WASM에서 오히려 느렸다(자산 insertText 36 vs 24.6 ms; 프로필상 SipHash·
  문자열 escape가 60% 이상). v2는 이전 입력의 복제본을 보관해 `PartialEq`로 비교한다(바뀐 문단만 다시 복제, 공유 글꼴 문맥은 같은
  할당일 때만 같음).
- **정확성(VERIFIED).** 오라클(A=증분, B=증분 끈 기존 경로, 편집마다 전체 쪽 나눔 구조 비교 + SVG): 무작위 40파일·1600편집,
  표적(D4 네 문서 × 구역별 처음·가운데·끝 문단, 줄·쪽 경계를 넘는 성장과 되돌림) 18실행·2448편집, D4 순서 네 문서 각 66편집 —
  모두 불일치 0. fallback 이유가 모두 나타났다(`input-changed`, `neighbour-signature-changed`, `paragraph-count-changed`,
  `not-single-paragraph-edit`, `section-prepass-changed`, `no-paragraph-change`). 정확 RGBA(Chrome 156 Canvas, 기준 WASM 대 v2,
  같은 D4 순서): 389쪽·3억 4,686만 화소 모두 같음; 일부러 다른 글자를 넣은 음성 대조는 FAIL로 검출. 고정 소스 lib 시험
  3870 PASS(증분 기본 켬). native D1 `--render`: 기준·v2 모두 23 PASS / 2 FAIL(같은 기존 셀 경계 실패), 그 뒤 `--native-keys`
  요구에서 멈춤 — D1 전체 통과는 아니다. D2(실제 IME)는 실행하지 않았다.
- **성능(VERIFIED, Node 24.21, Release WASM, 같은 빌드 방식, 공식 D4와 같은 커서 순서, 기준/후보 프로세스 교대 4×3).** insertText
  (수정+동기 쪽 나눔) p50/p95: 자산(0:4:42부터) 21.66/23.65 → **2.75/3.14 ms**(720편집 중 708 수렴), 기본 HWP 0.58/0.92 →
  0.65/0.83, 기본 HWPX 0.54/0.71 → 0.60/0.77, 화학 0.47/1.67 → 0.78/2.36(화학·기본은 문단 끝 덧붙이기라 이웃 서명이 바뀌어
  수렴하지 않고 비용만 조금 늘어남).
- **공식 native D4(VERIFIED, 3-RAF·표본·기준 그대로, 개인 Vite 설정이 비공개 generation을 제공, 실행 기록에 실제 WASM 해시).**
  기준/후보/후보/기준 순 네 번 모두 측정 완료·cleanup 성공·OFFICIAL_GATE_FAILURE. group-start p50/p95: 자산 85/92, 60/72,
  59/72, 82/92 → **여전히 FAIL**. 기본 HWP 44/43/43/44, HWPX 40/40/39/40 p95 PASS. 화학 p95 131/53/52/135 — 후보는 화학에서
  증분을 쓰지 않는데 기준 쪽 꼬리가 크다. 원인은 귀속하지 못했다(INCONCLUSIVE, 개선으로 세지 않음). Undo p95는 모두 1500 ms 미만.
- 남은 위험: 이웃 노출 서명은 표적 감사의 근사이며 364곳의 이웃 문단 읽기를 모두 증명하지 않았다(계약 4절). 자산 group-start의
  남은 약 60 ms는 쪽 나눔 밖(레이어 JSON·요약·띠 그리기·커서 트리·frame 대기)이다.

**결정.** 실험은 범위 안의 정확성·측정 기준을 충족했고 엔진 쪽 나눔 비용을 크게 줄였지만 D4는 FAIL이다. 패치는 병합하지 않고
비공개 결과로 둔다. T010 미완료, 제품 rhwp 실행 취소·다시 실행 NO-GO. 원시 결과·스크립트: 비공개 geul-tests
`reports/t010-incremental-pagination-20261030/`(`summary.json`, `oracle/`, `bench/`, `rgba/`, `native/`).


## T010 GPU-safe 제품 repaint 정책 (2026-11-01, T010 미완료)

제품 `RhwpEditorSession.renderPage`는 모든 백엔드에서 **FULL_PAGE_ONLY**다. 바뀐 쪽은 기존
`renderPageToCanvas`로 전체를 그린다. backend 감지나 진단 옵션으로 부분 띠를 켜는 제품 경로는 없다.
같은 Canvas의 성공한 출력과 전체 레이어 JSON·쪽 번호·쪽 크기·배율·bitmap 크기가 모두 같을 때만 생략한다.
비교 불가·알 수 없는 트리·출력 옵션 변경·쪽 밖 bbox 변경도 전체 렌더로 간다. 성공 뒤에만 출력 입력을 기록하며,
엔진이 bitmap 할당 뒤 실패한 첫 paint도 해제 대상으로 추적한다. `releaseRendering`은 bitmap과 비교 기록을 함께 버린다.
기존 표시 예산, revision 취소, 첫 paint의 제한된 재시도, terminal failure 중단, StrictMode 재실행 계약은 유지한다.

격리 후보 companion v4와는 구현이 다르다. 후보는 엔진 v4와 **쪽 전체 patch**를 짝지었지만 pinned 엔진
`1a76570`의 patch API는 쪽 전체를 요청해도 `set_partial_clip`을 사용하므로 소수 배율의 가장자리 오류가 남는다.
이번 제품 경로는 partial clip을 사용하지 않는 기존 전체 렌더 API만 호출한다. 따라서 **이번 정책에 엔진 v4는 필요 없다**.
후에 bitmap 재할당을 피하는 전체 patch를 도입하려면 별도 승인을 받아 엔진 v4·동반 코드·새 WASM 신원을 묶어
검증해야 한다. 과거의 후보 4백엔드 × 6배율 PASS를 현재 제품의 통과로 세지 않는다.

전체 렌더는 변경마다 bitmap 크기를 다시 정하므로 추가 비용이 가능하다. 과거 띠 최적화의 지연 이점을 보장하지 않는다.
공식 D4의 50 ms group-start·1500 ms Undo/Redo·3RAF 끝점은 그대로이며 D4 FAIL을 유지한다.
T010 INCOMPLETE, RHWP Undo/Redo NO-GO, T011 NOT STARTED. 현재 실행의 상세 신원·회귀·픽셀 범위와 제한은
비공개 `geul-tests/reports/t010-full-page-product-20261101/`에 기록한다.

### 2026-11-06 게시 정의와 과거 snapshot (B2)

게시 이전 snapshot의 글자 모양 표가 짧거나 추가 ID가 충돌하더라도, 최초 정의의 전체 메타데이터가 같고 모든 참조 이동을 증명할 수 있으면 복원된 live 모델을 실제 게시 prefix에 조정한다. history snapshot과 논리적인 Undo 상태는 그대로다. 새 `char-shape-publication.patch`의 불변 prefix는 문서 clone이 아니며 세션/저장 수명에 따라 해제된다. 고정 참조 이동·원본 metadata 불일치·잘못된 참조·snapshot 밖 버퍼의 추가 ID는 보수적으로 거부한다. 상세 저장 계약·실제 HWP/HWPX A–H 및 서비스 근거는 [저장 보존 B2](save-preservation.md#2026-11-06-게시-이전-undo-snapshot의-안전한-저장-b2)를 따른다. 제품 history·서식·영속 수식 관문과 T010 전체 판정은 바꾸지 않는다.

### 2026-11-06 D2 원시 순서 조사 (수용 INCONCLUSIVE 유지)

`scripts/tests/native-d2-order.py`는 기존 T023/Stage7 private Xvfb/X11·D-Bus·IBus Hangul·실제 Tauri/WebKitGTK·XTest 환경을 재사용하는 좁은 진단기다. 공개 생성 fixture에만 쓰며 실제 composition payload, beforeinput/input, keydown/up, Undo 요청/판정, 엔진 snapshot/restore·삽입/삭제, session/load generation/revision/history, 최종 전체 모델을 순서대로 보존한다. 이벤트의 `isTrusted`와 trace dropped=0을 검사한다. 사용자 Wayland·전역 설정은 건드리지 않고 조합 이벤트를 합성하지 않는다. 일반 textarea 대조는 편집기의 IME 처리기를 사용하지 않는다.

새 근거는 단순한 재시도 수 증가가 아니라 GTK IBus의 문서화된 전달 모드0/1을 비교한 것이다. 각각 HWP/HWPX의 활성 preedit에서 Ctrl+Z, End→Ctrl+Z, 두 Backspace 취소→Ctrl+Z를 관찰했다. 총12개 편집기 시도와6개 일반 textarea 대조다. mode0 예: HWP/HWPX 모두 empty end seq74 → final insert87 → Undo request117(End 경로126); 취소는 empty end96 → Undo116, final 없음. mode1은 확정 경로의 순서가 같고 취소 empty end99 → Undo116이었다. 원시 payload는 ㄱ→가, 빈 끝, insertFromComposition의 가를 기록한다. 실제 final 뒤 Undo가 실행됐고, 복구 Redo 뒤 본문은 `하한글 문단입니다. Korean paragraph.가`, history2/0·revision6이다. 취소 Undo는 원문을 복원하고 이후 새 입력 가를 버리지 않았으며, 최종 `가한글 문단입니다. Korean paragraph.`, history1/0·revision5였다. 각 trial의 session은1–6, load generation1로 유지됐다. E/U/F 판정은 복구/새 입력 전에 자른 구간에만 기존 predicate를 그대로 적용한다.

[IBus Hangul1.5.5의 control-mask 처리와 flush](https://github.com/libhangul/ibus-hangul/blob/1.5.5/src/engine.c#L1359)는 수식 키를 넘기기 전에 preedit를 지우고 commit한다. [GTK IBus1.5.33](https://github.com/ibus/ibus/blob/1.5.33/client/gtk2/ibusimcontext.c#L913)의 `IBUS_ENABLE_SYNC_MODE`와 [WebKitGTK2.54.1 InputMethodFilter](https://github.com/WebKit/WebKit/blob/webkitgtk-2.54.1/Source/WebKit/UIProcess/API/glib/InputMethodFilter.cpp#L279)는 preedit/commit/key 전달이 분리되는 경로를 보여 준다. **소스에서의 추론**과 plain textarea/편집기의 같은 원시 순서가 일치한다: 이번 경로는 editor가 U를 숨긴 것이 아니라 F 뒤 U를 받았다. 취소 경로는 F 자체가 없었다. focus·입력·Undo 관측기가 작동했고 실제 상태 전이를 함께 보존했으므로 단순 계측 누락이나 초점 실패로 이번 결과를 설명할 근거는 없다. 그러나 다른 native 스케줄이나 runtime에서 E→U→F가 불가능하다는 증명은 아니다. 과거 MessageChannel task 관측도 모든 입력 task의 실행 순서나 불가능성을 입증하지 않는다.

환경/실행 신원·원시 결과: `target/remaining-work/c-native-{async,sync}/environment/environment-result.json`, `run/diagnosis/result.json`. 두 scope cleanup survivors=[]이며 actual Release는8087a841…이다. 최초 native 기록의 harness SHA는 fa8ca43…이며, 그 뒤 추가한 초기 revision·history/세션/문서 소유권 assertion은 이벤트 생성·계측을 바꾸지 않고 보존된12개 원시 trace에 재생해 PASS했다(`c-trace-validation.json`). 이 assertion 재생을 추가 native 실행으로 세지 않는다. `py_compile` PASS. **필수 E→U→F 관측은0, D2 INCONCLUSIVE**다. 제품 IME/history 구현과 기존 수용 predicate는 수정하지 않았다. 이 결과로 제품 history·장평/자간·영속 수식을 활성화하지 않는다.

### 2026-11-06 prefix initialization follow-up

Initial shape-prefix capture used to happen after the backend had accepted `loading → ready`; an injected count/capture exception therefore escaped load after that transition, and a malformed prefix object was accepted. Construction now happens while backend state is still loading. Failures use `EngineFailure(init)` and the existing loading-to-failed path; stale/rejected ready responses release the pending prefix and document once. Six focused injected lifecycle tests pass. Real-engine exceptions were not observed or claimed. P2-1 remains unresolved: Release WASM showed a same-count/different-definition HWP serialization case, so the numeric count cannot establish prefix identity. An exact reopened check broke 23 existing HWP B1/B2 cases and was removed. No Undo publication fix is claimed from this investigation.

### 2026-11-06 P2-1 publication prefix identity

정규화된 HWP 재개방 정의 전체를 기존 raw/presence 보존 prefix와 그대로 비교하면 실제 장평 저장 같은 안전한 경로도 거부할 수 있었다. 새 엔진 캡처 API는 export로 다시 연 문서와 같은 형식·개수인지 먼저 확인하고, 각 동일 ID의 format writer projection을 비교한 후 live 정의 prefix를 캡처한다. HWP는 selected source raw bytes와 effective HWP record bytes를 둘 다 확인한다. HWPX는 `char_pr_xml` 결과를 비교한다. 출력 ID 재배치나 다른 의미 속성은 허용하지 않는다. Undo snapshot은 계속 불변이며 성공한 게시에서 획득한 live prefix를 사용해 복원 모델만 기존 strict exact reconciliation으로 조정한다. 실제 Release WASM identity 15 PASS 및 B1/B2 51 PASS다. 세부 분석/한정된 생성 fixture와 남은 real-service Phase 5는 [`save-preservation`](save-preservation.md#2026-11-06-p2-1-serializer-identity-correction-verified-wasm-real-service-follow-up-pending)을 본다.

### 2026-11-06 initialization cleanup failure reporting

`RhwpEditorSession`은 prefix 초기화 실패 뒤 document destructor도 실패할 수 있음을 별도 failed status flag로 나타낸다. 문서가 세션에 편입되거나 저장·편집될 수는 없다. ready 전이 거절·stale 응답에서 prefix와 document release를 각각 시도해도 최초의 backend/세션 결과를 유지한다. 이 hardening은 주입 시험 결과이며 실제 wasm destructor trap을 관측했다는 뜻은 아니다. [cleanup 결과](save-preservation.md#2026-11-06-p2-2-cleanup-failure-boundary-follow-up)를 참조한다.

### 2026-11-06 P2 Phase 5 publication/history acceptance

실제 Release WASM으로 18개 HWP/HWPX save-service chain의 출력 18개를 전부 다시 열어 내용·컨트롤·쪽·byte 일치를 확인했다. 추가 14개 정규화 시나리오에서 성공한 첫 게시 뒤 Undo snapshot을 복원하고 published prefix를 조정해 실제 파일을 두 번째 저장했다. HWP 굵게 3개 사례는 T009가 거부해 원본을 보존했다. in-session save race/history는 frontend suite의 actual WASM 51 PASS가 별도 증거다. service harness는 각 호출마다 registry를 새로 만들었으므로 단일 session revision chain 증거로 확대하지 않는다. 자세한 case identity와 한계는 [`save-preservation`](save-preservation.md#2026-11-06-p2-phase-5-final-service-acceptance)에 기록했다.

추가 P5 실파일 점검에서 18개 저장 chain 최종 파일 모두 네 셀의 char-shape run/ID를 대조했고 canonical prefix 검사 18/18 PASS를 얻었다 (`target/p2-continuation/p5-reopen-refs.json`). 최초 harness 인자 모양 오류를 고친 뒤 실행한 결과이며 fixture path는 [`save-preservation`](save-preservation.md#2026-11-06-p2-phase-5-final-service-acceptance)의 private generated fixtures다. Rust save 테스트의 UID/`SharedDirectory` 전제 때문에 overall P2를 complete 처리하지 않는다.

### 2026-11-06 D2 native capture/phase follow-up — INCONCLUSIVE

기존 private X11/IBus Hangul/WebKitGTK 입력 재현은 안전성 assertion 실패 시 `end_session()` 정리 뒤 trace를 읽어 원시 입력 증거를 잃을 수 있었다. runner가 예외를 다시 던지기 전에 연결된 native session에서 trace/status를 보존하고, trial을 assertion 전에 기록하도록 고쳤다. 완료된 두 HWP trial에서는 Undo/Redo 직후 저장된 phase가 local revision보다 한 단계 이전 상태를 가리킨 것이 원인이었다. Hybrid IBus의 마지막 keyUp/Redo keyDown 전달 순서를 고려해 **초기 E/U/F 관측 구간 뒤에만** 실제 native Shift를 보내 새 history phase를 읽고, 문서 본문/revision은 그대로인지 확인한다. 최초 E/U/F 입력과 acceptance predicate는 바꾸지 않았다. 원시 runner 결과는 `target/save-cleanup-20261106/d2-hybrid-fresh/run/diagnosis/result.json`, 계측 검증은 `native-capture-verification.log`다.

두 완료 HWP trial의 확정 경로는 E74→F87→U121이며, 취소 경로는 E96→U111(`reason=composing`)이고 F는 관측되지 않았다. 세 번째 trial은 기존 취소 안전성 assertion에서 중단됐다. 실패 trace는 보존됐다. E→U→F는 관측되지 않았고, 새 입력은 HWPX/plain textarea 결과를 얻지 못했다. 따라서 native run은 execution FAIL, D2는 **INCONCLUSIVE**다. 공식 [IBus 1.5.33 GTK2 입력 컨텍스트 구현](https://raw.githubusercontent.com/ibus/ibus/1.5.33/client/gtk2/ibusimcontext.c)의 `IBUS_ENABLE_SYNC_MODE` 경로에 있는 hybrid GSource 처리를 새로운 timing 가설로 삼았지만 acceptance 조건을 충족하지 못했다. D2 조건을 바꾸거나 해당 순서가 불가능하다고 추론하지 않는다. 개인 데스크톱 세션은 사용하지 않았다.

### 2026-11-06 D2 세 번째 취소 trial 진단 — INCONCLUSIVE 유지

첫 실패 assertion은 `scripts/tests/native-d2-order.py:87`의 `first['paragraphText'] == row['base'] and delta == 1`이다. 수정 전 harness로 mode 2에서 같은 지점에 다시 멈춰 결정적임을 확인했다(`target/reliability-20261106/c/repro-mode2/`).

원인은 잘못된 harness 기대값이다. 지연 0의 `BackSpace BackSpace ctrl+z`를 hybrid IBus로 보내면 keyup 순서가 고정되지 않는다. 빈 끝 E96 다음에 `z` keyup(103)과 `Ctrl+Z` keydown(109)이 Backspace keyup(117, 120)보다 먼저 왔다. `z` keyup이 취소 증거를 지워 기다림이 유지되고, Undo 요청 U111은 `reason=composing`으로 거부된다. 적용되지 않았으므로 본문은 접두 글자를 유지하고 revision 변화는 0이며 F도 없다. 제품은 설계대로 안전하게 거부했고, harness만 Ctrl+Z 전달을 Undo 수락과 같게 보았다. 제품 IME 구현은 바꾸지 않았다.

`de65a43e0ff583e6fdccd96708900a0eb6c731ae`는 수락과 거부 각각에 정확한 조건을 둔다. 수락이면 접두 글자가 지워지고 revision +1, 기록 0이며, 거부면 reason이 `composing`이고 본문·revision·기록이 그대로다. 두 경우 모두 F가 없어야 한다. 거부 뒤 새 입력 전의 Ctrl+Z도 거부되는지, 뒤따른 실제 타자가 음절 하나만 넣는지, Undo/Redo 대상이 정확한지, 최종 모델 전체 텍스트의 첫 문단이 같은지도 본다. 안정된 취소 뒤 Undo를 보는 `cancel-settled-undo` 모드를 더했다. hybrid 전달로 마지막 phase가 낡았으면 E/U/F 스냅숏 뒤에 native Shift로 새 phase를 읽는다. E/U/F 관측과 D2 predicate는 그대로다.

| IBus 모드 | 실행 | HWP·HWPX 8 trial 결과 | 완료 / 취소 / 안정된 취소 순서 | textarea 4건 |
|---|---|---|---|---|
| 기본(비동기) | PASS | 전부 safe | E74→F87→U117·U126 / E96→U116 수락 / E96→U119 수락 | 예상값 |
| `IBUS_ENABLE_SYNC_MODE=1` | PASS | 전부 safe | E74→F87→U117·U126 / E99→U116 수락 / E99→U119 수락 | 예상값 |
| `IBUS_ENABLE_SYNC_MODE=2` | PASS | 전부 safe | E74→F87→U121 / E96→U111 **거부** / E96→U123 수락 | 예상값 |

IBus 1.5.33, ibus-hangul 1.5.5, Release `53b6ad7a…`, 실제 Tauri/WebKitGTK, XTest 입력이며 합성 조합 이벤트는 없다. 세 실행 모두 cleanup survivors 0이고 증거는 `target/reliability-20261106/c/{async,sync,mode2}/`다. 중간 실행 `mode2-assertion-parse-bug`, `mode2-stale-phase`는 harness 자체의 오류로 멈춘 기록이며 보존한다.

**E→U→F 관측은 여전히 0회이고 D2는 INCONCLUSIVE다.** 안전성 trial 통과는 필수 순서 관측을 대신하지 않으며, 이 결과로 그 순서가 불가능하다고 결론 내리지 않는다. 다시 불러오기 경계는 이 native 실행에서 따로 시험하지 않았다(trial 사이 탭 닫기·폐기와 모델 ID 검사만 수행). 제품 RHWP Undo/Redo는 계속 비활성이고 D4 FAIL은 바뀌지 않았다.


## 2026-11-08 표 수식 기록 경계

실제 Release WASM 세션에서 병합 표 및 지원되는 다중 문단 셀의 수식 변경·Undo/Redo·두 차례 HWP/HWPX 저장/재열기를 검증했다. 논리 좌표는 RHWP 물리 셀·span 메타데이터로 구성하며 덮임 좌표를 앵커 값에 합치지 않는다. 수식은 첫 문단 소유이고 뒤쪽 일반 문단은 보존한다. 알 수 없는 구조는 기록 생성 전에 거부한다. T010 일반 입력 history는 계속 INCOMPLETE다. [지원 범위와 증거](stage567-acceptance-2026-11-05.md#interoperability-repair-20261108).

## RHWP 일반 글자 서식 history 경계 — 2026-11-12

지원 선택 서식은 기존 `RhwpHistory`에 한 논리 변경으로 기록하고 selection/caret 및 character-shape publication prefix를 함께 복구한다. IME composition, pending/uncertain transaction, stale session/generation은 차단한다. 구현 범위와 focused 근거는 [RHWP 일반 글자 서식](rhwp-general-formatting.md)을 따른다. 과거 T010 Undo/Redo 통합 acceptance와 native D2/D4 증거의 상태는 이 addendum으로 변경하지 않는다.
