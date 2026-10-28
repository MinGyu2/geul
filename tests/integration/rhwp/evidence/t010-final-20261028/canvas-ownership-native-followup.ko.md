# T010 Canvas 소유권 및 WebKit 후속 검증

- 날짜: 2026-10-28 (Asia/Seoul)
- HEAD: 5b3de6e4244de2d14f14f5787fec698987300be6
- 승인 엔진 WASM SHA-256: 97a575093aab7fde6400e3ce2a1c3ec243de28645f49ce27a55286ca8dff37e2
- 실행 대상: 실제 Tauri/WebKitGTK, anchor-v2 engine-safety gate 통과한 후보, Vite origin http://localhost:1420

## 확인된 결함과 수정

첫 native 실행은 테스트 5개가 통과한 뒤 renderer pendingCount===2 조건을 만족하지 못해 실패했다. 실패 시 브라우저 계측은 pending0, active0, queued0, repeat image key0, 연결된 Canvas 1588×2245, 완료2, staleDropped1을 보였다. 보류 이미지 요청이 전혀 시작되지 않았다.

원인은 0×0 Canvas의 첫 정상 COMPLETE에서 확인됐다. 엔진은 완료 중 backing 크기를 설정하고 adapter는 현재 완료 요청에 새 크기/epoch를 채택했지만, 세션의 per-Canvas repaint 요청 맵에는 최초 0×0 요청이 남아 있었다. 이후 trim(); repaint()가 낡은 backing identity를 가진 요청을 stale로 버려 재렌더와 보류 이미지 로드를 시작하지 않았다.

회귀 테스트 initial-mount-cleanup-preserves-pending에 완료 후 repaint를 추가했다. 수정 전 전체 suite는 58개 중 57 PASS, 1 FAIL로 이를 재현했다. 검증된 COMPLETE 뒤에만 완료된 request를 per-Canvas 요청 맵에 기록하도록 수정했다. 이 업데이트로 이후 repaint/cancel 복구는 엔진이 실제 게시한 backing 크기/epoch를 따른다.

## 검증 결과

명령:

    node --experimental-strip-types --test tests/integration/rhwp/ownership-poc/test-session.mjs

결과: exit 0, 58 tests, 58 pass, 0 fail. 로그 SHA-256 9b1d3c1fba138620610a42467ff65569fb4f2dde1d1cf355164345d8dc6cc8ac.

실제 WebKit 실행:

    dbus-run-session -- python3 tests/integration/rhwp/ownership-poc/native.py --scheduler --scheduler-only --evidence-dir tests/integration/rhwp/evidence/t010-d1-trust-anchor-v2/engine-gates --app "$PWD/src-tauri/target/debug/geul" --driver "$PWD/src-tauri/target/debug/tauri-driver" --webkit-driver /nix/store/p7h9r90h1vmk4wq1964nhd8vfp0kf27b-webkitgtk-2.54.1+abi=4.1/bin/WebKitWebDriver --xvfb /nix/store/7yz3bnmll7fy11n0xci85mbhnf6p5669-xvfb-21.1.23/bin/Xvfb --output tests/integration/rhwp/evidence/t010-final-20261028/canvas-native-webkit-scheduler-only-fixed.json --driver-log tests/integration/rhwp/evidence/t010-final-20261028/canvas-native-webkit-scheduler-only-fixed-driver.log

결과: exit 0, 11/11 checks PASS. 포함 항목: 후보 origin과 WASM gate, 초기 세션 open/close, native resource scheduler 73/73, 256 resident 이미지 cache seed, cache 포화 후 native exact pixel, 동일 요청 재사용, duplicate-request exact pixels, PENDING 문서 전환과 늦은 이미지 callback 안전성, 공유 세션 close 및 lease 정리. Result JSON SHA-256 ae5618fc2dd7ec263ca36660cafcebcf536508815b276bfe4fdd945fde06b96a; runner log SHA-256 75eaccfd3935a2654dae1960554afbfe0492fa08331a4d057d9bb077f8d65282.

tauri-driver 2.0.4를 로컬 crate source와 lock으로 Cargo/Rust 1.99.0, cargo build --locked --offline로 shared src-tauri/target에 빌드했다. exit 0. binary SHA-256 6170841d9719df46949a21f0401d6a0b2764d7216e02964d0dbee30c17021d83.

WebKitDriver, tauri-driver, Xvfb, Geul 앱 프로세스는 runner 종료 뒤 남지 않았다. Vite dev server는 후속 검증을 위해 계속 동작 중이다.

## 범위 제한

이는 adapter의 C1 Canvas 완료 소유권과 실제 native WebKit scheduler 경로에 대한 검증이다. cross-revision page reuse, Chrome regression, 공식 D4, T010 전체 D1-D5 승인을 통과했다는 뜻은 아니다. 실험적 page identity WASM은 승인되지 않았으며 production artifact를 변경하지 않았다.
