# T010 q11 안전 페이지 재사용 검증

## 범위

이 보고서는 `page-identity-preparation-decoupling` 실험 후보의 빌드, Chrome/WebKitGTK 렌더 비교, Canvas 소유권 회귀, 네이티브 scheduler 및 Vite 진입 게이트를 기록한다. 후보는 실험용이며 production 승인 상태는 `NOT_APPROVED`다. 이 검증만으로 공식 D4 성능 합격이나 production Undo/Redo 승인을 주장하지 않는다.

## 소스와 아티팩트

- 고정된 RHWP 기준 revision: `1a76570e833917d15817415a53c09ad61ab3203f`
- 후보 소스 트리 SHA-256: `33bbc3058e8cc40e80ed18b9c8f3d9bf1119e08766bb09494647ec82014b9334`
- isolated patch: `page-identity-preparation-decoupling.patch`
- patch SHA-256: `0925d32522836dded4edd6087e728ed311340611802f8aa6c6b747ea90ab881b`
- Rust/Cargo: `1.99.0`; `wasm-pack 0.15.0`; `wasm32-unknown-unknown`; release, `--no-opt`, `--locked --offline`; 기존 공용 Cargo target 사용
- WASM SHA-256: `b3b3d1b7791f77bac62055ca145d8b26fa99232d31bf271cc1b69c9f17e2e7f8`
- JS SHA-256: `6b1f299aafb673e8b7372e20b45d0b540a57d30a45ce6e605dbf71440caa0dff`
- `ENGINE.json` SHA-256: `501addad181e21f383e9a02b34c48a339d42f06fa41411d746d4fcc24fb26889`
- 독립 identity API Rust 회귀: 6/6 PASS. 결과 요약은 `identity-module-tests-summary.json`에 보존했다. 원본 로컬 결과의 SHA-256도 요약에 기록했다.

q11은 page-identity 모드를 켤 때 모듈 전역 incremental preparation을 더 이상 활성화하지 않는다. 완료된 Full job은 자신이 실제 렌더한 tree의 identity를 성공적으로 Canvas에 게시한 뒤에만 보관하며, 다음 revision의 preflight는 동일한 지원 렌더 identity를 계산한다. 이 분리는 q10/q1에서 관찰된 scheduler 회귀의 원인이었던 전역 준비 모드 결합을 제거하기 위한 것이다.

## 브라우저 렌더 비교

fixture SHA-256은 `6717eca43c6fdd9b0530530cf17d33b6687da0c462a433d37eb652afb5394f91`이며 24페이지다. 각 단계에서 재사용된 실제 Canvas와 별도로 실행한 Full 렌더의 RGBA를 모든 페이지에서 비교했다.

| 단계 | Full 작업 | 생략된 작업 | Chrome 정확 RGBA | WebKitGTK 정확 RGBA |
|---|---:|---:|---:|---:|
| 최초 렌더 | 24 | 0 | 24/24 | 24/24 |
| 편집 revision | 4 | 20 | 24/24 | 24/24 |
| Undo revision | 4 | 20 | 24/24 | 24/24 |
| Redo revision | 4 | 20 | 24/24 | 24/24 |
| 같은 세션 문서 재로드 | 24 | 0 | 24/24 | 24/24 |

**요약: 두 브라우저 모두 다섯 단계 모두에서 페이지별 정확 RGBA가 일치했다.** 이는 해당 fixture와 지원된 연산 범위의 검증이며 임의의 페이지 콘텐츠까지 증명하지 않는다.

Identity 계산은 Chrome 63회, 총 101.9ms, 최대 6.3ms였다. WebKitGTK는 63회, 총 158ms, 최대 10ms였다. 편집/Undo/Redo preflight는 Chrome `33.4/34.2/32.0ms`, WebKitGTK `50/53/51ms`였다. 따라서 D4에서 생략 작업 수만으로 성능 합격을 추정할 수 없고, identity 계산을 포함한 공식 입력 경로를 측정해야 한다.

Chrome에서는 Canvas 교체, scale, DPR 변경 시 Full 렌더를 확인했고 변경 DPR 페이지의 정확 RGBA도 일치했다. WebKitGTK에서는 Canvas 교체와 scale 변경의 Full 경로를 확인했다. 이 엔진에서 `window.devicePixelRatio` 덮어쓰기가 지원되지 않아 WebKitGTK DPR 변경 회귀는 실행하지 않았다. 캐시 eviction은 소유 중인 Canvas frame을 보존했고, 비동기 이미지 readiness 시험은 이미지 응답을 풀어주기 전 PENDING, 이후 완료 및 정확 RGBA 일치를 확인했다.

Chrome과 WebKitGTK 각각에서 adapter 오류와 identity 실패는 0이었다. 구독자, active jobs, leases, lease bytes, accounting 오류는 모두 0으로 종료했다. WebKitGTK native 실행의 Xvfb 종료 코드는 0이고 Tauri/WebKit 프로세스 잔여가 없었다. Chrome 원본 JSON과 WebKitGTK 정규화 증거는 `chrome.json`, `../page-identity-preparation-decoupling-engine-gates/webkit-normalized-source.json`이다. WebKitGTK 전체 원본은 로컬 `webkit.json`에 그대로 보존했으며 SHA-256은 정규화 증거에 기록했다. 공개 커밋에는 저장소 보안 정책에 따라 홈 경로를 포함한 65개 원본을 넣지 않고, 경로 및 SHA 목록을 `../LOCAL-RAW-EVIDENCE-INDEX.ko.json`에 기록했다. 원본 파일은 수정하지 않았다.

## Native scheduler와 설정 안전 게이트

실제 Tauri/WebKitGTK 앱에서 q11 WASM을 로드했다. `native.py --scheduler --scheduler-only`는 전체 출력 11/11 PASS, scheduler matrix 73/73 PASS였다. scheduler 대상 WASM SHA-256은 `b3b3d1b7791f77bac62055ca145d8b26fa99232d31bf271cc1b69c9f17e2e7f8`로 후보와 일치했다. 마지막 문서 종료 뒤 session/subscriber/job/lease/lease bytes/accounting 오류는 모두 0이었다. 상세 원본은 `../page-identity-preparation-decoupling-engine-gates/native-scheduler-only.json`이다.

`ownership-poc/vite.config.mjs`의 page identity 시험 모드는 위 native gate의 결과 hash와 후보 identity, 73개 개별 PASS, 11개 focused PASS 및 종료 후 cleanup을 강제한다. 최초 설정 hot reload에서는 `lastObserved.status`가 문자열 `PASS`일 것이라는 잘못된 검사 때문에 거절됐다. 실제 raw 필드는 빈 배열이고 판정은 별도 scheduler 결과에 있었다. 그 조건만 바로잡은 뒤 `node --check`와 Vite v8.3.2 설정 로딩이 PASS했다. 보정 내역은 `../page-identity-preparation-decoupling-engine-gates/vite-config-gate-correction.json`에 기록했다.

## 아직 실행하지 않은 필수 합격

q11 후보에 대한 authoritative `history-perf.py --engine candidate` 공식 D4는 이 작업 구간에서 실행하지 않았다. 따라서 group-start p95 `<=50ms`, Undo p95 `<=1500ms` 합격은 미확정이다. 사용자가 제공한 직전 공식 실패 baseline은 group-start p95 Basic HWP `45ms`, Basic HWPX `45ms`, Chemical HWP `114ms`, Asset-rules HWPX `81ms`다. 별도 q10 attempt2 raw 결과에는 `47/46/140/62ms`가 기록되어 있다. 이들은 q11 공식 결과가 아니다.

q11 WASM은 승인된 D1 artifact SHA-256 `97a575093aab7fde6400e3ce2a1c3ec243de28645f49ce27a55286ca8dff37e2`와 다르므로 D1의 39/39 assertion 및 24/24 reference RGBA 승인 결과를 승계하지 않는다. D1 재검증/필요 승인, 실 IBus native 순서 D2, D3, D5, repository-wide Rust/TypeScript/ESLint/Vitest/native WebKitGTK 및 security checks도 이 보고서 범위에서 완료되지 않았다. Production RHWP Undo/Redo는 계속 `NO-GO`; T011은 시작하지 않았다.
