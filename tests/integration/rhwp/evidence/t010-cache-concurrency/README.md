# T010 renderer-cache 동시성 실행 보고서

## 1. 전체 실행 상태

**PARTIALLY COMPLETED. 제품 활성화 NO-GO.** 실제 재로드 알림 순환을 좁게 교정하고, 실행 가능한 브라우저·Rust 계약 검사를 보존했다. pending 한도와 transient 수명은 **FAIL**이며 완전한 bounded-cache 교정 패치를 만들었다고 주장하지 않는다. 사용자의 Stage A 중지 규칙에 따라 geul 연결을 진행하지 않았다.

| 구분 | 결과 | 근거 분류 |
|---|---|---|
| CACHE PATCH CORRECTNESS | FAIL | VERIFIED: 한도·수명 계약 실패, 알림 순환 부분 수정은 통과 |
| BROWSER REPRODUCIBILITY | PASS | VERIFIED: 새 source export부터 WASM 빌드·두 브라우저·독립 Python 격리 실행 |
| PINNED TOOLCHAIN COMPATIBILITY | PASS, 부분 수정 후보 범위 | VERIFIED: Rust 1.93.1 빌드·기존 library·Clippy·브라우저 실행 |
| TEST-ONLY INTEGRATION READINESS | NOT EXECUTED | A의 한도 관문 실패로 후속 통합 중지 |
| D2 NATIVE IME | INCONCLUSIVE | 새 native 시도 0, 결정적 replay 56개 통과 |
| D4 EDITING PERFORMANCE | FAIL | 기존 공식 p95 기준 위반 유지, 새 비교 측정 없음 |
| D4 MEMORY LIFECYCLE | FAIL / 제품 RSS INCONCLUSIVE | 후보의 추정 보유 한도 위반, 제품 native RSS 새 측정 없음 |

## 2. 초기 및 최종 Git 상태

VERIFIED: 시작은 `master`, HEAD `316af4235d9077c31bc6fdba7396b7c125ba6fd8`, staged·tracked·untracked 변경 없음이었다. 기존 ignored `.agent-tmp.md`를 읽고 같은 T010의 후속 체크포인트로 유지했다. 기존 작업자는 실행을 마친 상태였고 subagent를 사용하지 않았다.

최종 상태는 `git-state.json`에 기록한다. 운영 소스 변경은 없고, architecture 문서와 새 검사·증거만 남긴다. 커밋·push·운영 submodule 포인터 변경은 하지 않았다. 미완료 범위가 있어 체크포인트를 삭제하지 않는다.

## 3. 격리 패치의 식별과 기준

VERIFIED: rhwp 기준은 `1a76570e833917d15817415a53c09ad61ab3203f`(v0.8.7), WordCraft는 `fc41918814f62645b6746ed68e71e8c2c2e85d6f`(v0.7.0)이다. upstream 변경은 별도 checkout에만 적용했다.

- `upstream-rhwp-no-redundant-notify.patch`: pinned 기준 전체 패치. SHA-256 `b4b22f8557804723b164b7fef0943d473afe44dd020a755f4d5cb7f9fe184d6b`.
- `notify-incremental.patch`: 역사적 v2에 추가하는 작은 교정. **전체 패치와 중복 적용하지 않는다.**
- `engine-identity.json`: 소스 4파일·WASM·glue·TypeScript 해시, compiler·wasm-pack·빌드 조건.

두 패치 모두 **미통합 부분 수정**이다. 원 `t010-cache-hardening/`·`t010-followup/` 패치와 역사 증거는 바꾸지 않았다. 기존 A/B/C(활성 draw 해제·cropped 비용·반복 취소) 수정은 유지했다.

## 4. pending 한도 초과 재현

VERIFIED: Rust 1.93.1의 결정적 검사에서 100바이트·2항목에 90바이트 요청 3개가 **3항목·270바이트**를 보유했다. 200개 요청은 200항목·18,000바이트였다. 1 MiB encoded 추정 하나, 로딩 중 예산 축소도 한도를 넘는다. `make_room()`이 pending을 내보낼 수 없는데 `insert_pending()`은 결과와 관계없이 삽입하기 때문이다.

실제 Chrome·WebKit WASM에서도 1,024바이트·2항목에 100문서를 한 task에서 요청하면 **pending 100개·52,124바이트**였다. 512바이트·1항목으로 축소하거나 `trim(0)`을 호출해도 로드 중 보유를 줄이지 못했다. 이는 서버 응답이 영원히 오지 않는 브라우저 실험이 아니다. never-complete의 보유 위험은 Rust 검사와 소스에서 별도로 확인했다.

## 5. pending 자원 제한 교정 상태

**FAIL / 미구현.** 한도만 추가한 뒤 거절된 이미지를 조용히 버리거나 pending을 취소하는 패치는 채택하지 않았다. 현재 동기 draw API에는 deferred 요청·재시도 소유권·완성 여부를 전달하는 계약이 없다. 단순 취소는 이전 blank/restart 결함을 다시 만들 수 있다(INFERRED).

필요한 후속 계약은 admission **전** encoded 비용·in-flight 개수를 검사하고, 유한한 작업 메타데이터와 문서 세대에 재시도를 귀속시키는 것이다. 큰 data URL·HTML handle을 무제한 큐에 보관해서는 안 된다. 이 부분이 구현되기 전에는 후보를 제품에서 불러오면 안 된다.

## 6. transient 이미지 수명 교정 상태

**FAIL / 미구현.** 완료한 큰 항목 자신을 보호하는 `loaded()`가 작은 resident를 밀어낸다. 2 MiB 예산의 SVG 2개 실험에서 마지막 transient는 **5,856,930바이트**로 남았으며 문서 free 직후와 추가 idle 뒤에도 같았다. 소스에 draw 소비·기한 만료·독립적 반납 계약이 없어 다음 삽입/trim이 없으면 계속 남는다.

작은 resident 보존, 두 oversized 항목의 동시 가용성, tiny-budget 음성 항목 검사도 실패했다. 활성 draw 보호와 비동기 전환을 위한 임시 가용성, 장기 residency를 같은 플래그로 취급하는 정책은 교정 완료되지 않았다. trim으로 0까지 줄일 수 있다는 결과는 독립된 수명 제한의 증거가 아니다.

## 7. 다중 이미지 재로드 순환 교정

VERIFIED: 같은 쪽에 겹치지 않는 1,200²·1,210² SVG를 120px 상자로 놓고, host의 실제 load 알림을 RAF로 합쳐 다시 그렸다. 두 그림의 색상 면적이 실제로 보이는 settled pinned 결과를 별도로 검증했다.

| 두 브라우저에서 동일한 관측 | v2 | 부분 수정 |
|---|---:|---:|
| load 시도 | 64 | 4 |
| 완료 알림 | 64 | 2 |
| 초기 draw 포함 repaint | 32, 제한 도달 | 2 |
| cache eviction | 63 | 3 |
| 최종 픽셀 불일치 | 0 | 0 |
| 실제 decoder error | 0 | 0 |
| 추정 보유량 한도 | FAIL | FAIL |

새 요소가 `src` 설정 직후 이미 drawable이면 그 호출에서 쓸 수 있다. 이 **새 요소**만 비용을 loaded로 갱신하고 늦은 load 이벤트를 해제한다. 그 이벤트가 `repaint → 새 요소 → load → repaint`를 반복하는 것을 막는다. 이전 요청이 기다린 기존 pending 요소의 이벤트는 유지한다. 실제 비동기 완료 알림을 전부 비활성화하지 않았다.

`src=""` 뒤 발생한 error 이벤트는 별도 release-error로 센다. 이를 decoder 실패로 잘못 집계하지 않았다. 이 교정의 보장은 이번에 실행한 브라우저·시나리오 범위이며, 미완성 한도 정책 전체의 liveness 증명은 아니다.

## 8. 최종 소유권·메모리 불변식

| 불변식 | 판정과 증거 |
|---|---|
| I1 활성 draw의 resource 미해제 | VERIFIED, 기존 12단위·브라우저 nonblank 픽셀 유지. 새 비용 갱신은 현재 handle을 반환하기 전에 자신을 보호하며 수행 |
| I2 pending 명시적 상한 | FAIL, 3/270 및 100/52,124 재현 |
| I3 transient 제한 수명/안전한 예외 상한 | FAIL, 초대형 값의 idle 보존·resident eviction |
| I4 계상 일관성 | load/failure/replacement/trim의 기존 검사는 통과. 예산 준수는 별개로 실패하며, tiny negative 항목도 예산 초과 |
| I5 eviction/redecode 픽셀 보존 | VERIFIED, 기존 nonblank 프레임·settled 결과·HWP/HWPX 재열기 비교 통과 |
| I6 한 문서 close와 다른 문서 공유 | VERIFIED, primitive 공유 시나리오 픽셀 유지. geul 여러 세션 연결은 UNVERIFIED |
| I7 disposed 문서의 늦은 callback | 엔진 handler는 문서를 보유하지 않고 identity로 pending을 찾는다. 앱 generation/disposal 연결은 UNVERIFIED |
| I8 eventual visibility | 이번 정상 settle·알림 실험은 통과. bounded admission까지 결합한 일반 보장은 UNVERIFIED |

INFERRED: synchronous `renderPageToCanvas`는 먼저 Canvas 크기를 설정해 비운다. 준비 이미지의 작업 집합이 보유 한도를 넘을 때, 임시 소유권을 없애면서 매번 전체를 다시 그리는 방식은 브라우저의 warm decode에 의존할 수 있다. bounded rendering 자체가 불가능하다는 결론은 아니다.

다음 최소 인터페이스 제안은 세대와 취소 소유권을 가진 렌더 작업, 유한 decode/ready lease, `pending/resource-limit/complete` 결과다. 임시 Canvas에 원래 paint 순서를 보존해 완성한 뒤 게시하거나, 명시적으로 resource-limit를 보고해야 한다. 현재 void image draw에는 안전한 bounded 실패 결과가 없으므로 그것을 제공한다고 가장하지 않는다. 이 충돌 때문에 사용자의 A 중지 규칙을 적용했다.

`bytes`는 data URL 길이와 자연 크기 RGBA의 **추정**이다. 프로세스 RSS·브라우저 decoder·GPU 메모리 ceiling이 아니다.

## 9. 브라우저 러너 재현성

VERIFIED: `../../cache-concurrency/`에 생성기·기존 12시나리오·새 stress·runner·문서·원 해시를 보존했다. Python 표준 라이브러리와 실제 브라우저만 사용한다. 추가 대형 프레임워크·커밋된 바이너리 fixture·developer scratch 경로가 없다.

러너는 실제 전체 RGBA를 lossless RLE로 대조한다. 정상 draw 반환, nonempty Canvas, parse 성공을 픽셀 검사의 대체로 쓰지 않는다. 타임아웃·결과 없는 종료·일부 필드만 있는 거짓 PASS 주입 **3/3**이 실패로 처리된다.

새 소스 export에서 실제 WASM 빌드를 다시 실행했고, 기존 빌드와 WASM·glue·TypeScript가 바이트 단위로 동일했다. 같은 compiler의 기존 Cargo 캐시는 명시적으로 재사용했다. 새 패키지로 두 브라우저를 실행했으며, 별도 임시 테스트 트리와 `python3 -I`에서도 같은 engine/test 해시로 결과를 재현했다. 알려진 memory FAIL 때문에 suite가 종료 코드 1을 내는 것은 정상적인 결함 검출이며 PASS로 바꾸지 않았다. `reproducibility.json`은 새 소스 export·빌드와 독립 실행 범위를 구분해 기록한다. 실제 명령은 [검사 README](../../cache-concurrency/README.md)에 있다.

## 10. Chrome·WebKitGTK 픽셀 결과

VERIFIED: **Chrome 155.0.8059.39**, **WebKitGTK MiniBrowser 2.54.1**, 실제 Rust 1.93.1 WASM을 실행했다. 각 엔진·브라우저에서 기존 12시나리오·50 draw를 보존했다. 두 브라우저 모두 40/50 프레임이 정확히 같고, 나머지 10개는 후보가 이미 warm해진 이미지를 초기 프레임에서 더 일찍 보여 준 경우다.

원래 blank 결함을 잡았던 r2 등을 포함한 **모든 pinned nonblank 프레임**, 실패 디코드와 각 최종 프레임의 픽셀 검사가 통과했다. 마지막 색상 완전성도 별도 확인했다. SVG 2개 동시 draw와 실제 HWP·HWPX 생성 바이트 재열기도 각 형식에서 픽셀 불일치 **0**이다. 이를 geul native 통합 통과로 세지 않는다.

`v2-{chrome,webkit}.json`, `notify-{chrome,webkit}.json`, `fresh-{chrome,webkit}.json`, `repro-chrome.json`에 dimensions·encoded size·scale·hash·mismatch·계상·알림·이미지별 시도·close/idle/trim 결과가 있다. 전체 suite 결과는 pending/transient 때문에 **FAIL**이다.

## 11. Rust 1.93.1 호환성

VERIFIED: 시작 시 PATH의 Rust는 1.99.0이었고 별도 캐시에 1.97.1이 있었다. 이번에 임시 Rustup home에 1.93.1과 wasm32·rustfmt·Clippy를 설치했으며 기본 제품 툴체인은 바꾸지 않았다. `rustc 1.93.1 (01f6ddf75 2026-02-11)`, Cargo 1.93.1, wasm-pack 0.15.0, wasm-bindgen 0.2.127과 wasm32 타깃을 실제로 사용했다. 1.99 결과를 대체 증거로 사용하지 않았다.

- 기존 cache unit: `cargo test --locked --lib surface_cache`, **12 PASS**.
- 전체 관련 library: `cargo test --locked --lib`, **4,064 PASS / 13 ignored**. ignored는 통과가 아니다.
- 준비 후 `cargo fmt --check`: PASS.
- `cargo clippy --locked --all-targets -- -D warnings`: PASS.
- WASM release `cargo clippy --locked --target wasm32-unknown-unknown --lib --release -- -D warnings`: PASS.
- v2 release+wasm-opt 18m51s, 부분 수정 Rust release(`--no-opt`) 8m04s: PASS. 후자는 Rust release 최적화를 유지하고 별도 wasm-opt만 생략했다.
- 실제 생성 TypeScript의 `setRendererImageLoadListener(listener?: Function | null): void`와 다른 전역 API 3개 확인, 브라우저에서 실행.

초기 fmt는 generated harness 누락으로 실패했다. upstream의 `node scripts/rust-test-suite-manifest.mjs --prepare`로 28개를 생성한 뒤 재실행했다. Nix의 bundled lld wrapper 오류는 native의 명령 범위 bfd 옵션과 WASM host build의 임시 cc wrapper로 해결했다. 시스템·compiler 파일은 수정하지 않았다. 초기 실패도 `rust-compatibility.json`에 보존했다. 이는 **부분 후보의 컴파일러 호환성** 통과이며 안전성 계약 7개 실패를 지우지 않는다.

## 12. test-only geul 통합 구조

**NOT EXECUTED.** A의 상한/수명 계약이 실패하므로 patched WASM을 RhwpEditorSession/RhwpSurface에 연결하지 않았다. 새 테스트는 primitive renderer harness이며 geul 통합 PoC가 아니다.

VERIFIED: 기존 session 생성자의 loader 주입과 `loadRhwpModule(importer)`는 있지만, RhwpModule은 `openDocument`만 노출한다. 후속 PoC는 테스트 adapter에서 생성 모듈의 전역 listener·budget API를 보유하고 session에 필요한 소유권만 연결하는 것이 작다(INFERRED). 운영 module URL과 public 산출물은 그대로 두어야 한다.

## 13. async listener와 repaint 결과

primitive host의 실제 load→RAF 합치기는 위 2알림·2draw·최종 픽셀 0으로 검증했다. **geul에서 visible page 우선순위, reload generation 무효화, 최신 Canvas 게시, 여러 session의 listener 정리 소유권은 UNVERIFIED**다.

후속 adapter는 모듈별 listener 하나와 살아 있는 구독자 집합을 소유해야 한다. close가 다른 문서의 listener를 해제하면 안 된다. RAF 실행 시 현재 generation을 다시 확인하고, 오래된 준비 Canvas가 새 모델을 덮지 않도록 해야 한다. 이 정책을 현재 제품이 구현했다고 보고하지 않는다.

## 14. 예산·문서 close 측정

VERIFIED: 2 MiB stress 예산에서 candidate는 close·idle 뒤 5,856,930바이트/1 transient를 유지했고, settle 뒤 global trim은 0으로 줄였다. pending burst는 close 뒤 완료해도 마지막 초대형 항목을 남겼으며 마지막 trim에서 0이 되었다. 다른 문서의 공유 이미지는 기존 primitive 사례에서 계속 렌더되었다.

**256/384/512 MiB의 geul 단일/다중 문서·스크롤·zoom·warm/cold 비교는 NOT EXECUTED.** 이 값을 기본값으로 채택하지 않았다. global cache에 문서별 소유권이 없는데 매 close마다 trim하는 수정도 하지 않았다. native RSS·GPU 수명 측정은 UNVERIFIED다.

## 15. D4 응답성

공식 계약 **native keydown → revision 관찰 RAF → 추가 2 RAF**, group-start p95 ≤50ms, Undo p95 ≤1,500ms를 유지한다. 기존 작은 HWP/HWPX·24쪽 HWP·60쪽 HWPX p95 **77/77/87/121ms는 FAIL**이다. 이번 수정의 native 편집 p50/p95·계속 타이핑·Undo/Redo·phase별 새 비교는 NOT EXECUTED다.

INFERRED: 기존 귀속 결과의 text mutation·layer JSON·draw 비용을 image notification 수정이 해결하지 않는다. 다음 upstream 성능 작업은 (1) 세대/모델 버전별 damage page/region 보고, (2) summary와 draw가 같은 prepared layer tree를 소비하는 API, (3) 불필요한 재-layout 제거 순으로 분리한다. 같은 4문서·공식 RAF 계약·표 셀/여러 구역 픽셀·snapshot/T009 회귀를 각 변경의 인수 조건으로 둔다. 넓은 renderer 재작성이나 측정 시작점 변경을 하지 않았다.

## 16. D2 native IME

VERIFIED: target ordering `compositionend("") → Ctrl+Z → insertFromComposition(finalText)`를 포함한 결정적 replay **56 PASS**, 실패·skip 0이다. `ime-replay.json`에 native와 분리했다. 제품 IME 코드는 바꾸지 않았다.

**INCONCLUSIVE:** 새 native 시도는 0이다. 기존 누적 298회·target 0회 관찰을 유지한다. 설치된 WebKitGTK는 2.54.1이고 fcitx5·Windows TSF·macOS의 다른 native 환경은 이번에 실행하지 못했다. 같은 ibus 실험을 반복해 숫자를 늘리지 않았다. replay를 native 목표 순서 관찰로 세지 않는다.

## 17. D1–D5 관문

| 관문 | 기존 제품 증거/이번 pinned 회귀 | 이 후보의 geul 통합 |
|---|---|---|
| D1 렌더링·셀·여러 구역 | 기존 native PASS, 이번 WASM 회귀 PASS | INCONCLUSIVE: native 통합 미실행 |
| D2 native 한국어 IME | INCONCLUSIVE, target 0/298 | INCONCLUSIVE |
| D3 보수적 저장 보존 | PASS, undo_save·strict service 재검사 | INCONCLUSIVE: 후보와 서비스 연결 미실행 |
| D4 응답성·메모리 | FAIL: 공식 지연 기준 위반, native RSS 일부 미확정 | FAIL: pending/transient 한도, 편집 측정 미실행 |
| D5 history/snapshot 실패 안전 | 기존 PASS, application 회귀 유지 | INCONCLUSIVE: 후보 session 통합 미실행 |

기존 native PASS를 이번에 재실행했다고 주장하지 않는다. isolated 픽셀·컴파일 통과가 제품 activation 관문을 대체하지 않는다.

## 18. 운영 command registry

VERIFIED: 일반 빌드 rhwp `edit.undo`, `edit.redo`는 `unsupported`다. 기존 두 compile-time 시험 플래그 조건은 바꾸지 않았다. rhwp의 `format.bold/italic/underline/strikethrough`도 계속 unsupported다. WordCraft의 분기와 정책, T009·HWP preview 보존 정책을 변경하지 않았다. T010 완료 표시·T011 의존성 변경도 없다.

## 19. 변경 파일과 정확한 검사 결과

- `../../cache-concurrency/`: `fixtures.mjs`, `historical.mjs`, `browser.mjs`, `index.html`, `run.py`, `prepare.py`, `unit.py`, `cache_contract.rs`, `test_runner.py`, 원 해시 JSON 및 실행 문서.
- 이 디렉터리: 전체/증분 부분 패치, compiler/API/engine identity, 브라우저·독립 재현·계약·IME·저장·Git 증거.
- `docs/architecture/rhwp-undo-redo.md`: 후속 실패 관문과 소유권·통합 제한; 과거 384–512 MiB 권고를 승인된 기본값으로 오해하지 않도록 정정.

`application-regressions.json`에 명령을 보존했다. typecheck·lint PASS, Vitest **779**, 실제 WASM **27 PASS+2 skipped**, geul Rust **175 PASS+6 ignored**(앱의 1.99 툴체인), Python e2e 하네스 단위 **66**, security **86**, undo_save **13사례·불일치0**, strict save **23사례·CURRENT0/DESIRED0**이다. 실제 Tauri native rendering/interaction의 새 실행은 없다.

새 Rust safety 계약은 **9개 중 2 PASS·7 FAIL**이며 기존 cache 12개 통과와 구별한다. `cache-contract-{v2,notify}.json`의 종료 코드 1을 성공으로 세지 않았다. 민감정보·최종 보호 계약 검사는 `git-state.json`·`verification.json`에 별도 기록한다.

## 20. 남은 결함과 다음 작업

1. **A2/A3:** 렌더 작업 소유의 bounded in-flight·ready lease·유한 deferred 메타데이터·세대 취소·명시적 resource-limit 계약을 upstream 격리판에 구현한다. never-complete·예산 축소·idle transient·여러 cold SVG·작은 resident 보존을 통과시켜야 한다. 현재 후보는 계속 미통합이다.
2. **D:** A 통과 뒤 기존 loader 주입을 쓰는 시험 adapter와 모듈별 listener hub를 구현하고 visible page·reload/dispose·여러 session·T009를 실제 geul/WebView로 검증한다. 그 다음 256/384/512 MiB를 비교한다. pin·운영 WASM·명령을 바꾸는 작업이 아니다.
3. **D4 편집:** damage/prepared-frame/layout 재사용을 좁은 upstream 작업으로 분리하고 같은 4문서의 공식 p95 ≤50ms·Undo ≤1,500ms를 실제 native에서 달성한다.
4. **D2:** 실제로 다른 native 입력 환경에서 목표 순서를 관찰·검증한다. 관찰 전에는 INCONCLUSIVE를 유지한다.
5. **D1/D3/D5·메모리:** 최종 후보 통합 뒤 native 셀·여러 구역·실패 주입·저장·다중 문서 close/RSS를 다시 실행한다. 현재 실행으로 이 미검증을 면제하지 않는다.

**RHWP UNDO/REDO PRODUCTION ACTIVATION: NO-GO**
