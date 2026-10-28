# T010 계속 작업: 검증기 교정 시도

- 기준 소스: Geul `0a8b3efe637a771187dcf2ce8441828029b467a0`, RHWP 고정 revision `1a76570e833917d15817415a53c09ad61ab3203f`. 기존 format-memo patch 위에 적용하는 별도 `oracle-accounting.patch`는 **검증 중**이며 완성된 증거가 아니다.
- VERIFIED: `lease_verdict.py`의 `channelDifferences=False`가 수정 전 성공으로 판정되는 것을 추가 테스트로 재현했다. 수정 후 `python3 -I tests/integration/rhwp/ownership-poc/test_lease_verdict.py`는 7/7 PASS (종료 코드 0). `False`, `True`, `0.0`, 문자열, 누락, null, 객체를 관련 픽셀 필드에 넣는 부정 사례와 기존 native attempt 7 원시 자료의 재평가를 포함한다.
- VERIFIED: 기존 차등 오라클 소스는 비대칭 open 결과를 건너뛰며, 양쪽 SVG 오류를 성공으로 세지 않고도 오류 자체를 보고하지 않는다. 양쪽 편집 거절도 문서의 성공 판정을 막지 않는다.
- UNVERIFIED: 기존 12,637 SVG 성공 비교 자체는 보고된 값이나, 원시 요약만으로 양쪽 SVG 오류로 빠진 페이지가 없었는지 확인할 수 없다. 따라서 기존 1,146개 열린 문서를 모두 전체 페이지 등가 검증 완료라고 해석할 수 없다. 거대 표 문서는 기존 5,400초 timeout으로 여전히 UNVERIFIED다.
- 후보 WASM SHA-256 재확인: `97a575093aab7fde6400e3ce2a1c3ec243de28645f49ce27a55286ca8dff37e2`. 새 엔진 후보나 제품 배포를 만들지 않았다.
- VERIFIED(제한적): 첫 수정본은 release 빌드 성공(10분 56초) 후 `field-01-memo.hwp` 정상 경로에서 편집 3회와 SVG 3쪽 비교를 통과했다(`oracle-small.txt`). 이후 분류 회귀를 추가했으므로 이 실행은 최신 patch 검증이 아니다.
- VERIFIED(제한적): 최신 수정본의 `pair_status`와 `svg_status`, 그 테스트를 그대로 추출하여 `rustc --test --edition 2021`로 실행해 양방향 비대칭과 양쪽 오류 등 분류 테스트 1개가 통과했다. RHWP 전체에 연결된 최신 patch의 빌드 및 회귀는 별도로 필요하다.
- VERIFIED: 최신 patch에 대해 Cargo 1.99 `--locked --offline` debug 빌드 및 `geul_oracle_failure_classification` 통과. 동일 빌드의 정상 경로도 3회 적용·3회 pagination 비교·3쪽 SVG 비교 통과(`oracle-classification.txt`, `oracle-small-latest.txt`). 이는 전체 코퍼스 결과가 아니다.
- 거대 표 진단 시도 1: 계측 debug 빌드, `GEUL_ORACLE_OPS=1`, `timeout 120`. 694,272바이트 읽기 0 ms, `HwpDocument::from_bytes` 첫 인스턴스 열기 시작 후 120초에서 EXIT=124. 편집·SVG 미도달, 불일치 관찰 없음. `huge-debug-1edit-120s.txt`. debug 빌드라 release 성능을 대표하지 않으며 열기 내부 단계도 아직 구분하지 못했다. 전체 등가 UNVERIFIED.
- 거대 표 진단 시도 2: 동일 debug 120초 제한에서 열기 내부 계측. 파일 읽기 1 ms, 파싱 5,375 ms, 스타일 완료 5,377 ms, validation 완료 5,388 ms, reflow 완료 7,822 ms, font/recompose 완료 7,850 ms. 이후 첫 `DocumentCore::paginate()`가 종료 전에 반환하지 않아 EXIT=124 (`huge-debug-open-1edit-120s.txt`). 편집·SVG는 미도달. release에서의 지속 시간과 paginate 내부 원인은 UNVERIFIED이며, mismatch 증거가 아니다.
- 거대 표 진단 시도 3: 계측 release 후보, 1편집 120초 제한 EXIT=124. 읽기 2 ms, 파싱 678 ms, validation 완료 682 ms, reflow 완료 1,647 ms, recompose 완료 1,655 ms, 그 뒤 첫 `DocumentCore::paginate()`에서 시간 제한 도달(`huge-release-open-1edit-120s.txt`). 선택·편집·SVG 미도달. 정확한 내부 병목과 원래 30편집 결과는 UNVERIFIED. 변경된 것은 진단용 native 소스이며 WASM 후보는 기존과 같다.
- Stage 3 조사(VERIFIED): 공식 시험 어댑터 `ownership-poc/session.mjs`는 `damage` 모드에서 기존 Canvas와 제한된 레이어 요약을 비교하고 조건이 맞으면 재사용한다. `RhwpEditorSession.paintedSummary`는 `getPageLayerTreeWithProfile(page, "screen", true, true)`로 이미지·글꼴 payload를 생략하고, `summarizeLayerTree`는 root 아래 구조와 op만 저장한다. 엔진 JSON에는 별도 resources가 있다. 그러므로 이 요약만으로 모든 리소스 및 렌더 환경에 걸친 동등성을 입증할 수 없다. 이 관찰은 실제 오렌더 재현이 아니라 검증 공백이다. 샘플 해시는 정확 RGBA 증거가 아니다. 새 무효화 구현·인과 개입·정확 RGBA 검증은 NOT RUN.
- Stage 3 후속(VERIFIED): 엔진 `paint/json.rs::write_bbox`는 f64 좌표를 소수 셋째 자리로 직렬화한다. 격리 native Rust 테스트 `geul_layer_json_is_not_lossless_render_identity`에서 서로 다른 `10.0001`과 `10.0002`가 같은 bbox JSON을 생성하는 것을 확인했다(1/1 PASS, `layer-json-identity-test.txt`, 재현 patch `layer-json-identity-test.patch`). 이 결과는 직렬화가 무손실 render identity가 아니라는 증거이며, 해당 좌표쌍의 RGBA 차이나 실제 문서의 stale frame을 증명하지는 않는다.
- VERIFIED: `sourceImageKey`는 문서 `bin_data_epoch`, 이미지 id, 변환 variant를 사용하며 `fontBlobKey`는 내용 digest를 사용한다. 시험 job은 직렬화된 JSON 대신 내부 `PageLayerTree`를 준비·재생한다. 일반 본문 편집 경로에는 `invalidate_page_tree_cache_from(0)` 또는 전체 무효화가 있어 기존 cache의 유지만으로 일반 편집 후 페이지별 불변을 추론할 수 없다. 새 API의 필요성은 아직 설계 검토 중이며 제품이나 후보 WASM은 변경하지 않았다.
- Stage 3 추가 최소 반례(2026-10-28): 격리 RHWP Rust 테스트에서 bbox x `10.00001`, `10.00049`가 같은 3자리 JSON으로 직렬화됨을 확인(1/1 PASS; `layer-json-identity-test-v2.patch`와 `layer-json-identity-test-v2.txt`). Chrome 155.0.8059.39의 독립 Canvas 최소 예제에서 동일한 좌표 두 개를 scale 12로 그려 전체 320×200 RGBA를 비교한 결과 서로 다른 픽셀 240개, 채널 240개, maxDelta 2 (`geometry-raster-chrome.html`, `geometry-raster-chrome-output.txt`). 이 최소 예제는 같은 페이지 JSON이 모든 Canvas 출력의 동등성을 보장하지 못하는 이유를 구체화하지만, 실제 RHWP 문서의 오류나 native WebKitGTK 재현은 아니다.
- 기존 adapter의 fake-engine 수명주기 회귀 `node --experimental-strip-types --test tests/integration/rhwp/ownership-poc/test-session.mjs`: 48/48 PASS (`session-baseline-reinspection.txt`). 이 결과는 실제 이미지·폰트 identity나 정확 RGBA 검증을 대신하지 않는다.
- 추가 확인: 같은 좌표쌍을 갖는 서로 다른 rectangle `PaintOp`를 포함한 전체 `PageLayerTree`도 실제 adapter 옵션(`omit_image_bytes=true`, `omit_font_bytes=true`)으로 생성한 JSON이 동일했다. 격리 Rust 회귀 1/1 PASS (`layer-json-identity-test-v3.patch`, `layer-json-identity-test-v3.txt`). `pollRenderJob`은 이 JSON을 재생하지 않고 내부 트리를 사용하며, `web_canvas.rs`의 rectangle 경로는 bbox를 그대로 받는다. 두 증거는 JSON이 완전한 렌더 입력의 동등성을 보장하지 않는다는 결론을 뒷받침한다. 해당 트리의 실제 엔진 렌더 비교는 NOT RUN.

## 시험 어댑터 fail-closed 교정 (2026-10-28)

- 기준 Geul HEAD `0a8b3efe637a771187dcf2ce8441828029b467a0`, 기존 WASM `97a575093aab7fde6400e3ce2a1c3ec243de28645f49ce27a55286ca8dff37e2`, 변경된 `ownership-poc/session.mjs` SHA-256 `5847ef2477fa43daf423bfcd44a757968b0aaea62ad1f9641c88f30ac6777e66`. 제품 WASM과 gitlink는 변경하지 않았다.
- VERIFIED: `damage` 모드가 이전 revision의 손실된 JSON 요약과 현재 요약이 같을 때 full job을 생략하는 경로를 발견했다. 새 fake-engine 회귀 `damage-lossy-summary-cannot-prove-new-revision`은 수정 전 기대 2 jobs, 실제 1 job으로 실패했다. 이후 요약 기반 reuse에 같은 model version 조건을 추가해 새 revision에서는 전체 렌더로 폴백했다. 이는 성능 최적화가 아닌 보수적 임시 안전 경계다. 기존 조건이 없었다면 양자화가 초래할 수 있는 실제 문서 오렌더는 재현하지 못했다.
- VERIFIED: `node --experimental-strip-types --test tests/integration/rhwp/ownership-poc/test-session.mjs` 49/49 PASS (`session-fail-closed-attempt1.txt`). 기존 새 revision 재사용 기대 2개는 전체 렌더 기대값으로 변경했고 검사는 제거하지 않았다. `python3 -I -m unittest discover -s tests/integration/rhwp/ownership-poc -p 'test_d4*.py'` 100/100 PASS (`d4-analysis-regression-attempt1.txt`).
- VERIFIED(제한적): Chrome/WebKit engine gate 기존 후보와 실제 WebKitGTK 2.54.1, damage flag 활성화, X11/Xvfb, chemical 24쪽·zoom 50 단일 문서, `performance-visual-native.py --sample '연구노트(화학).hwp'` 실행 EXIT 0: 12/12 assertions, 독립 Full 기준 6/6 전체 RGBA references (차이 0, maxDelta 0), session/driver/display 종료 true (`failclosed-native-chemical-attempt1.json`, SHA-256 `f8c2397aa0753bdcb50f931eb932d2cf23dfdb13ea7aa072777136ac27867125`). adapter counters fullJobs 395, unchangedFrames 0, errors 0, staleDropped 2. 이 시험은 일부 frame만 다루며 모든 화면 밖 페이지 검증, 공식 D1, 인과 성능 또는 D4 통과가 아니다.
- 남은 작업: 완전한 페이지별 render identity와 environment/resource/Canvas lifetime 계약, 효율적 불변 페이지 생략, stale job 회귀 및 전 범위 정확 RGBA와 native 성능 인과 실험. `damage` mode의 추가 full job은 이 임시 교정의 명시적 성능 비용이다. Stage 3 미완료, 공식 D4 FAIL과 D2 INCONCLUSIVE, T010 NO-GO 유지.

## 공식 D4: fail-closed 시험 어댑터 후보 attempt 1 (2026-10-28)

`history-perf.py --engine candidate`, `GEUL_T010_DAMAGE_POC=1`, 실제 X11 입력, 기존 3RAF endpoint·warmup·표본·문턱·네 fixture. 후보 WASM은 위와 같고 frontend `session.mjs` SHA-256 `5847ef2477fa43daf423bfcd44a757968b0aaea62ad1f9641c88f30ac6777e66`이다. 이전 candidate-full과 다른 mode이므로 측정값 차이만으로 특정 원인의 인과관계를 주장하지 않는다. 원시 `failclosed-official-d4-attempt1.json` SHA-256 `cccb32f796f9e1b8a0647566cdae3deb6b29f1ae46221354b0d6232eb260059d`, producer EXIT=1, `measurementComplete=true`, `exitReason=OFFICIAL_GATE_FAILURE`.

| 문서 | group-start p50/p95/max, n=30 | Undo p50/p95/max, n=25 | gate |
|---|---|---|---|
| basic HWP | 38/49/50 ms | 49/53/75 ms | 둘 다 PASS |
| basic HWPX | 42/50/50 ms | 46/52/68 ms | 둘 다 PASS |
| 화학 HWP | 68/178/181 ms | 53/64/71 ms | group FAIL, Undo PASS |
| 자산 규칙 HWPX | 87/99/99 ms | 134/142/149 ms | group FAIL, Undo PASS |

필수 측정 timeout 0, 전체 공식 판정 **FAIL**. `analyze-d4.py handler`가 anchor에서 독립 제공한 WASM/JS 해시와 4개 fixture, 표본 정합성을 확인해 ANALYZED/EXIT=0 (`failclosed-official-d4-attempt1-analysis.json`); 이는 별도의 D4 PASS가 아니다. host software GL·WebKitGTK 2.54.1, CPU affinity 0–7. 요약 생성과 모든 full job을 수행하는 이 후보에서 큰 문서 두 개의 임계 경로 원인별 기여는 아직 UNVERIFIED다.

## 불필요한 새 revision 요약 제거 및 공식 D4 attempt 2

- VERIFIED: revision 간 요약 기반 reuse가 금지된 상태에서 기존 `paintedSummary`를 새 revision에도 호출했다. 새 `new-revision-avoids-useless-summary-work` 테스트는 수정 전 호출 수 2 대 기대 1로 FAIL했다. 현재 어댑터는 이전 frame이 없거나 같은 version인 경우에만 요약을 구하고, 새 revision은 요약 계산 없이 반드시 Full job을 수행한다. 초기 요약 예산 및 preparation-failure 테스트는 계속 실행하며, 요약 예산 검사는 실제 요약 수가 양수인지도 확인한다.
- 중간 테스트 attempt1은 기존 preparation-failure 테스트가 실패하고 잔여 timer로 수동 중단되었다(완료 PASS 아님). 이후 초기 요약 경로와 기존 실패 주입을 보존한 최종 `session-avoid-summary-attempt4.txt`는 **50/50 PASS**다. 변경된 `session.mjs` SHA-256 `9675da98395a3ed7e48493ee64d94b8539ca49bac49a7845d4d0c98e0053865e`.
- 최신 소스의 실제 WebKitGTK chemical 단일 문서 진단 `failclosed-native-chemical-attempt2.json`: EXIT 0, 12/12 assertions, 독립 Full 정확 RGBA 6/6, 3개 cleanup true, fullJobs 460, errors 0. 전체 페이지·전체 D1·성능 증거는 아니다.
- 동일 공식 producer, 동일 candidate-damage, 기존 후보 WASM·표본·문턱을 사용한 attempt2는 `measurementComplete=true`, EXIT 1, `OFFICIAL_GATE_FAILURE`. 아래 시간은 ms, 모든 group n=30·Undo n=25·timeout 0이다.

| 문서 | group-start p50/p95/max | Undo p50/p95/max | gate |
|---|---|---|---|
| basic HWP | 36/45/47 | 46/56/76 | 둘 다 PASS |
| basic HWPX | 37/45/50 | 46/53/72 | 둘 다 PASS |
| 화학 HWP | 61/114/159 | 52/60/61 | group FAIL, Undo PASS |
| 자산 규칙 HWPX | 68/81/84 | 131/144/155 | group FAIL, Undo PASS |

원시 `failclosed-official-d4-attempt2.json` SHA-256 `3a6d93aef58be5c88de5f1901872ba435dd386c9d91d1e2fcd167bcefb8ab5e2`; 독립 anchor/fixture 및 표본 분석 `failclosed-official-d4-attempt2-analysis.json`은 ANALYZED이며 공식 PASS가 아니다. attempt1 대비 p95는 화학 178→114, 자산 99→81이나 순차 단일 시도 차이에는 환경 변동이 포함될 수 있어 전체 감소분의 인과 귀속은 UNVERIFIED. 두 문서가 기준 50 ms를 넘으므로 D4 FAIL 유지.

## 현재 실행 의존 파일의 D1 재검증

- 2026-10-28, 기존 `t010-d1-trust-anchor-v2/run-native.py`, 승인 anchor v2·manifest v4, WASM `97a575093aab7fde6400e3ce2a1c3ec243de28645f49ce27a55286ca8dff37e2`, 실행 `session.mjs` SHA-256 `9675da98395a3ed7e48493ee64d94b8539ca49bac49a7845d4d0c98e0053865e`, `GEUL_T010_DAMAGE_POC=0`. 새 raw `d1-current-attempt1/` 보존.
- VERIFIED: wrapper PASS·harness EXIT 0, 39/39 assertions, 24/24 정확 RGBA, session/driver/display 정리 true, 의존성 실행 전후 일치, native 수명 관찰자 오류 및 생존자 없음. raw 결과 SHA-256 `38f4489912c487473a5c4d68392059948e7de105a587506f4a88fc7242ae48f5`. 이 결과는 실행한 candidate-full 상태에 한정되며, candidate-damage의 전체 D1이나 D4 PASS를 의미하지 않는다.

## D3/D5 현재 후보 및 품질 검사

- D3 candidate WASM `undo_save.py --candidate` 실제 `service::save` 19/19 예상 일치, 실패 0 (`d3-undo-save-attempt1.json`). 별도 기존 경로의 `tests/poc/t010-phase0/save_service.py --strict-desired` 23행 current·desired 불일치 0 (`d3-save-strict-attempt1.json`); 이 별도 실행에 candidate 지정은 없었다.
- 현재 candidate-damage, WASM `97a575…`, session SHA `9675da…`의 실제 WebKitGTK `candidate-safety.py`: 14/14 assertions, D5 실제 discard 예외 4/4 PASS(HWP/HWPX, 이미지 없음/있음), 원본 보존 및 resource 정리 검사 PASS (`d3-d5-native-safety-attempt1.json`).
- TypeScript typecheck, ESLint PASS; Vitest 42 files/819 tests PASS(jsdom Canvas 미구현 메시지 동반). Rust 1.99 fmt 및 `cargo clippy --locked --offline --all-targets -- -D warnings` PASS; `cargo test --locked --offline` 207 unit + 1 integration PASS, 18 ignored.
- 보안 `security-scan-ci.sh` EXIT 1: 검사기 테스트 86 PASS, 추적 파일 2099 및 전체 이력 3041 파일 버전/경로 검사 PASS, Gitleaks 실행 파일 부재로 NOT RUN. 미추적 증거 44개 지정 검사에서는 workspace 절대 경로 4개와 Rust 함수의 선택적 암호 매개변수 타입 선언에 대한 오탐 1개가 보고되었다(`untracked-sensitive-scan-attempt1.txt`); 원시 증거를 유지했으며 공개/commit 전 별도 정리와 재검사가 필요하다.

## D2 실제 IBus 동기 모드 추가 시도

이전 시도의 `IBUS_ENABLE_SYNC_MODE`는 unset이었다. 이번에는 GTK IBus 모듈이 인식하는 `IBUS_ENABLE_SYNC_MODE=1`을 설정하고, 기존 `ime-native.py`의 실제 X11 키·IBus-Hangul·WebKitGTK 경로와 36회 지연/포인터/입력기 정지 행렬을 실행했다. 합성 DOM composition 이벤트는 사용하지 않았다. candidate-damage, WASM `97a575…`, session `9675da…`.

`d2-native-sync-attempt1.json` SHA-256 `8a0352eec82e52ec8e226e1635722855f41ef91f133f5e6b7446eac8f834d098`: producer EXIT 1, classification **INCONCLUSIVE**; 실제 한글 composition preflight 및 behavior D2 gates 25 PASS, 36/36 안전, 필수 빈 composition end → Ctrl+Z → 늦은 final insert 관측 0/36. 두 형식 각각 ordering gate INCONCLUSIVE. 이 결과는 해당 순서가 불가능하다는 증명이 아니며 D2 PASS가 아니다.
- 最新 `candidate-damage` の実 WebKitGTK 四文書 `performance-visual-native.py`（公式 D1 wrapper とは別実行）: EXIT 0、39/39 assertions、独立 Full 参照 24/24 正確 RGBA 差 0、session/driver/display 終了 true、fullJobs 950、unchangedFrames 0、errors 0 (`failclosed-native-four-attempt1.json`, SHA-256 `a142fd0adcaa62397ff0ad56c3ccbdae9721f1c51ea63e560f2b0bc36a74a0de`)。選んだ frame の検証であり全 offscreen ページの比較ではない。
- 現在 WASM integration: 基本 flag 42 PASS/8 SKIP。history・format flag を同時有効にした誤った一括 attempt は history 側の format-disabled 期待に反し 1 FAIL/4 PASS (`rhwp-wasm-enabled-attempt1.txt`)。各文書化された条件で分けた history 1/1 と format 4/4 は PASS。試験専用 flag であり製品機能の承認ではない。

## D4 attempt 2 추가 시간 관찰

`summarize-d4-timing.py`는 원시 groupStart 30개에서 둥근 시각과 중첩 가능 호출의 기술 통계만 계산한다 (`failclosed-official-d4-attempt2-timing.json`). 화학: key→input p50/p95/max 4/42/42 ms, input→handler 종료 24/71/129 ms, handler 종료→frame 25/39/40 ms, `pollRenderJob` 19/32/122 ms, fullJobs 총 562. 자산: 각각 3/10/11, 40/43/51, 22/30/30, `pollRenderJob` 14/15/15 ms, `insertText` 8/9/9 ms, fullJobs 총 492. 프로브 구간은 서로 겹치고 ms 반올림이라 합산하거나 전체 비용으로 단정할 수 없다. 이 값들은 렌더 작업 및 화학 입력 전 지연을 추가 계측할 근거이지 특정 구간의 단독 인과 증명은 아니다.

## 화학 문서 페이지 구성 조사

- `page-op-inventory-attempt1.html` 첫 Chrome 실행은 Vite 동적 import 해석 오류로 `RUNNING`만 남았으므로 INCONCLUSIVE (`page-op-inventory-chrome-attempt1.txt`). `/* @vite-ignore */`를 적용한 `page-op-inventory.html` 두 번째 실행은 기존 후보 WASM으로 24쪽 분석 완료(`page-op-inventory-chrome-attempt2.txt`).
- VERIFIED: 21쪽은 `pageBackground`와 `image`만, 3쪽은 `pageBackground`, `textRun`, `line`을 포함한다. 이미지 전용 쪽은 page index 0–15와 19–23이다. 직렬화 크기 최대 2,799,046 문자. Chrome `--virtual-time-budget` 때문에 보고된 `ms=0`은 소요 시간 증거가 아니다. 기존 candidate에서 쪽 identity의 완전성이나 이미지 의존성은 아직 입증되지 않았다.
- INFERRED: image/background만 처리하고 나머지는 fail-closed하는 제한적 lossless engine identity가 화학 문서의 다수 쪽을 다룰 가능성이 있다. 실제 job 감소·정확 RGBA·성능 이득 및 신규 candidate의 검증은 아직 NOT RUN.
- `page-op-inventory-chrome-attempt3.txt`는 이미지 전용 쪽의 그룹을 추가로 집계했다: generic/header/body/column/textLine/footer가 나타난다. 후보 native `preparation::canvas_projection`은 Canvas가 child/layer/clip만 소비하는 근거로 group kind를 Generic으로 투영한다. 이 기존 엔진 계약은 신원 API의 출발점이지만, 이미지 payload·변환·page geometry·layer·clip·브라우저 환경 및 자원 수명을 전부 포함한다는 증명은 아직 없다.
- 변경된 추적 소스·문서 7개 지정 민감정보 재검사 PASS (`changed-source-sensitive-scan-attempt1.txt`). 새 미추적 raw evidence에 대한 앞선 경로/오탐과 Gitleaks 부재는 여전히 미해결이다.

### 격리 이미지 쪽 신원 프로토타입 (후속)

기존 후보와 별도의 RHWP 소스에 이미지와 단색 배경으로 제한한 신원 계산 초안을 만들었다. 좌표·변환·클립·이미지 바이트가 다르면 신원이 달라지고, 미지원 연산이나 이미지 바이트 부재는 거절하는 집중 Rust 테스트 4/4가 통과했다 (`image-page-identity-prototype.patch`, `image-page-identity-tests-attempt1.txt`). 이는 해시 기반 실험이며 전체 렌더 신원의 증명이나 제품 변경이 아니다. Web Canvas는 이미지 바이트에서 준비할 payload를 얻고 replay plane과 클립을 적용한다. 비동기 리소스 준비, 브라우저 환경, Canvas 소유권과 job 세대는 초안 밖에 있고 실제 전체 영향 쪽의 정확 RGBA 및 인과 성능 검증도 미실행이다. 따라서 revision 간 재사용을 허용하지 않으며 기존 D4 FAIL과 T010 NO-GO는 유지한다.

### 완료 Canvas의 엔진 job 토큰 확인

엔진은 job이 Canvas를 대상으로 삼을 때 `__rhwpExperimentalRenderJob` 값을 새 job ID로 바꾼다. 시험 어댑터가 완료 프레임을 반환할 때 이 토큰을 확인하지 않아, 다른 job이 같은 크기의 Canvas를 인수한 뒤에도 같은 요청을 완료로 보고하는 상황을 fake 엔진으로 재현했다 (`canvas-token-baseline-attempt1.txt`, 해당 회귀 FAIL). 시험 어댑터는 즉시 완료 반환과 동일 revision 요약 재사용 모두에서 완료 job ID와 현재 토큰의 일치를 요구한다. 일반 Full과 damage 요약 경로의 부정 회귀를 포함해 최신 fake 회귀 52/52 PASS (`canvas-token-fixed-attempt3.txt`). 중간 attempt1의 테스트는 새 job이 즉시 완료할 수 있다는 점을 반영하지 못해 실패했으며 보존했다.

변경된 시험 어댑터와 기존 WASM의 WebKitGTK 화학 문서 진단은 12/12 단언, 선택한 6/6 프레임 독립 Full 정확 RGBA, 정리 3/3 PASS (`canvas-token-native-chemical-attempt1.json`). 이 진단은 실제 외부 job의 Canvas 인수를 재현하지 않는다. 토큰은 별도 WASM 인스턴스의 동일 숫자 ID, 임의 외부 Canvas draw나 같은 크기로 되돌린 resize를 감지하지 못하므로 독점 소유 계약이 여전히 필요하다. 변경 이후 공식 D1과 D4는 아직 재검증되지 않았고, 안전한 revision 간 재사용도 구현되지 않았다.

### 격리 WASM 신원과 전체 쪽 RGBA 탐색

실험용 읽기 전용 WASM API를 별도 소스에서 빌드했다. release 빌드는 전후 소스 SHA-256이 같고 산출물 해시가 확인되었다 (`image-page-identity-wasm-prototype.patch`, `image-page-identity-build-attempt2.json`). 기존 승인 후보와 제품 WASM은 바꾸지 않았다. Chrome 실제 시간 단일 탐색에서 화학 문서 24쪽 중 편집 전 21쪽이 지원되었고, 한 글자 삽입을 문단 길이와 caret offset으로 확인한 후 20쪽이 지원되었다. 이 20쪽은 같은 인덱스의 편집 전 digest와 일치했고, 반복 조회도 일치했다 (`image-page-identity-inventory-attempt2.json`). 호출 시간은 트리 생성 비용을 포함하는 탐색값으로 공식 성능 판정에 사용하지 않는다.

같은 격리 후보의 별도 Full job으로 지원된 편집 전 페이지 21쪽을 캡처한 뒤, 편집 후 동일 digest인 20쪽을 다시 Full 렌더하여 각 페이지의 전체 RGBA를 비교했다. Chrome, scale 0.5에서 **20/20 채널 차이 0** (`image-page-identity-rgba-attempt1.json`). 이는 하나의 문서와 편집에 대한 결과이며 해당 digest가 모든 렌더 입력을 포괄한다는 증명, 최적화된 재사용 자체의 검증 또는 WebKit native 관문은 아니다. job이 실제로 그린 트리와 신원을 결합하고 Canvas·리소스·환경 수명을 확인하는 작업, native 전 영향 페이지 비교 및 인과 성능 시험은 남았다.

토큰 확인을 추가한 최신 시험 어댑터(`session.mjs` SHA-256 `6b6e6a6df44f05ba901d2f96b7a0c953190be986e98eacb4eefba41c035159bb`)와 기존 WASM에 대해 기존 공식 D1 anchor v2 wrapper를 재실행했다. `candidate-full` 네 문서 39/39 단언, 독립 정확 RGBA 24/24, 의존성 안정 및 정리 3/3 PASS (`d1-token-attempt1/`). 이는 실험 신원 API나 revision 간 재사용의 승인이 아니다.

공개용 증거 로그는 사용자 홈 경로를 자리표시자로 마스킹했고, 진단 patch는 같은 변경을 유지하면서 검사기 오탐을 일으킨 원본 문맥만 줄였다. 해당 원본은 로컬 Git 내부에 별도로 보존했다.
저장 검증 JSON의 파일별 소스 해시는 기존 후보 매니페스트 1046개와 전부 일치한다. Gitleaks가 그중 일부를 키로 오인하여 공개본은 해당 값의 줄바꿈만 바꿨으며 JSON 데이터는 원본과 동일하다. 원본은 로컬 Git 내부에 보존했다.
