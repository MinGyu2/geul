# T010 캐시 동시성 회귀 검사

제품과 분리된 검사다. `external/*`, submodule 포인터, `public/rhwp`를 쓰지 않는다. `run.py`는 명시한 두 web 패키지를 임시 서버에 **복사해** 실제 Chrome 또는 WebKitGTK에서 실행한다. fixture는 `fixtures.mjs`가 브라우저에서 생성하므로 바이너리·개인 문서·별도 scratch 파일이 필요 없다.

현재 후보는 **미통합 부분 수정**이다. 새 이미지가 첫 요청에서 이미 drawable일 때 불필요한 load 알림을 보내는 순환만 교정한다. pending 상한과 transient 수명은 해결되지 않았다. 따라서 전체 안전성 검사의 종료 코드 **1과 FAIL은 알려진 결함의 검출 결과**다. 이 결과를 성공으로 뒤집는 옵션은 없다. `../evidence/t010-cache-concurrency/`의 보고서를 함께 읽는다.

## 준비 및 실행

필요: Python 3.12 이상(표준 라이브러리만), Git, Rust 1.93.1의 cargo/rustfmt/clippy와 wasm32 타깃, wasm-pack 0.15.0, Chrome 또는 Chromium. WebKit 검사에는 Linux WebKitGTK의 `WebKitWebDriver`와 MiniBrowser, 그래픽 세션 또는 Xvfb가 필요하다. wasm-bindgen은 고정 Cargo.lock 버전을 wasm-pack이 사용한다. 생성물은 Git에 추가하지 않는다.

```sh
git submodule update --init external/rhwp
rustup toolchain install 1.93.1 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown
CACHE_WORK="$(mktemp -d)"
RUST_193_BIN="$(dirname "$(rustup which --toolchain 1.93.1 rustc)")"

# 제품 public/rhwp를 덮어쓰지 않고 두 엔진을 만든다.
python3 tests/integration/rhwp/cache-concurrency/prepare.py \
  --work "$CACHE_WORK/pinned" --baseline-only --toolchain-bin "$RUST_193_BIN" --no-opt
python3 tests/integration/rhwp/cache-concurrency/prepare.py \
  --work "$CACHE_WORK/candidate" --toolchain-bin "$RUST_193_BIN" --no-opt \
  --patch tests/integration/rhwp/evidence/t010-cache-concurrency/upstream-rhwp-no-redundant-notify.patch

python3 tests/integration/rhwp/cache-concurrency/run.py \
  --pinned "$CACHE_WORK/pinned/test-package" --candidate "$CACHE_WORK/candidate/test-package" \
  --browser chrome --output "$CACHE_WORK/chrome.json"
python3 tests/integration/rhwp/cache-concurrency/run.py \
  --pinned "$CACHE_WORK/pinned/test-package" --candidate "$CACHE_WORK/candidate/test-package" \
  --browser webkit --output "$CACHE_WORK/webkit.json"

python3 tests/integration/rhwp/cache-concurrency/unit.py \
  --rustc "$RUST_193_BIN/rustc" \
  --patch tests/integration/rhwp/evidence/t010-cache-concurrency/upstream-rhwp-no-redundant-notify.patch \
  --output "$CACHE_WORK/contracts.json"
python3 -m unittest discover -s tests/integration/rhwp/cache-concurrency -p test_runner.py -v
```

`--chrome`, `--webkit-driver`, `--xvfb`로 실행 파일을 지정할 수 있다. `--xvfb`가 있으면 `-displayfd`로 새 X 서버를 만들고 종료한다. WebKit 데이터·설정·캐시는 임시 디렉터리로 격리한다. `--timeout` 기본값은 120초다. 테스트는 인터넷 콘텐츠를 열지 않고 loopback 서버와 생성 fixture만 사용한다. Chrome의 테스트 프로세스는 `--no-sandbox`로 실행한다.

`prepare.py`는 검증된 기준 `1a76570e833917d15817415a53c09ad61ab3203f`의 빌드·테스트 입력을 `git archive`로 내보내고 패치를 적용한다. 큰 PDF·문서 보관 자료와 Git 이력은 복제하지 않는다. 기본 `--patch`는 역사적 v2이며, 위 명령은 부분 수정 후보를 명시한다. `--prepare-only`는 빌드하지 않으며 ENGINE.json에도 NOT EXECUTED로 남긴다. `--no-opt`는 Rust release 최적화를 유지하고 별도 wasm-opt 단계만 생략한다. 전체 최적화 검증은 이 옵션 없이 실행한다. WASM·glue·TypeScript 해시와 compiler·패치·소스 해시는 `ENGINE.json`에 기록한다. `--target-dir`로 명시한 기존 Cargo 캐시를 재사용할 수도 있다. 그 캐시에 다른 Cargo 작업이 없음을 먼저 확인하고 외부 submodule·제품 public 디렉터리를 지정하지 않는다. source export에는 vendor path 의존성과 엔진의 saved blank template도 포함된다.

## 판정과 보존 범위

- `historical.mjs`: 기존 12개 시나리오·50 draw를 보존한다. 작은/큰 PNG, 작은/decoded oversize SVG, cropped GIF, encoded oversize SVG, 음성 디코드, draw 사이 trim, 로딩 중 trim, 로딩 전 문서 닫기, 문서 간 공유, 예산 압박 교대 그리기다.
- pinned와 candidate의 전체 RGBA를 lossless RLE로 비교하여 **픽셀 불일치 수**를 계산한다. 해시는 진단·역사 비교용이며 픽셀 비교를 대체하지 않는다. 원래 빈 그림을 검출한 r2 등 **모든 pinned nonblank 프레임**의 동일성을 검사한다. 처음 비동기 프레임이 후보에서 더 일찍 완성되는 것은 허용한다. 각 시나리오 마지막 프레임은 독립적인 색상 완전성도 검사한다. 원 증거의 해시는 `historical-expected.json`에 보존했다.
- `browser.mjs`: 겹치지 않는 SVG 2개를 한 쪽에 놓고 2 MiB 예산에서 실제 완료 알림을 RAF로 합쳐 다시 그린다. 두 그림의 예상 색상 면적을 별도로 확인한 settled pinned 결과와 전체 픽셀을 대조한다. 재그리기 32회 제한·반복 load는 **FAIL**이며, 최종 픽셀이 우연히 완전해도 통과하지 않는다.
- HWP/HWPX: pinned API가 만든 생성 그림 문서를 직렬화하고, **동일한 바이트**를 pinned·candidate WASM에서 다시 열어 settled 전체 픽셀·쪽 수·색상 면적을 비교한다. geul SessionRegistry나 저장 서비스를 거치는 검사는 아니다.
- pending burst: 서로 다른 100개 문서를 같은 모듈로 요청한 직후, 예산 축소, 로딩 중 trim, 전부 닫기, 늦은 완료와 마지막 trim의 상태를 기록한다. 이 검사는 실제 이미지가 영원히 로드되지 않는 상황을 만들지는 않는다. never-complete의 무제한 보유는 Rust 계약 검사로 분리했다.
- 이미지별 load/error 시도는 data URL 해시와 크기만 보존한다. `src=""` 해제 뒤의 error 이벤트는 실제 디코더 오류와 구별한다. Canvas·이미지 handle·data URL·픽셀 원문은 결과 JSON에 넣지 않는다.
- pending/transient/estimated bytes/evictions와 닫기·idle·trim 뒤 상태를 보존한다. 이는 캐시 보유량 **추정**이며 RSS·브라우저 decoder·GPU 상한이 아니다.
- `cache_contract.rs`: 100바이트·2항목/3×90, 200 pending, 큰 encoded 요청, 예산 축소, pending trim, transient와 작은 resident, tiny-budget 음성 항목, late callback, 초대형 이미지 2개의 동시 가용성. 기존 캐시의 12개 테스트와 별도로 실행하며 실패를 감추지 않는다.
- `test_runner.py`: 타임아웃, 결과 없는 정상 종료, 일부 필드만 있는 거짓 PASS를 실제 CLI 프로세스로 주입해 모두 실패하는지 확인한다.

이는 primitive renderer 회귀 검사다. **RhwpEditorSession/RhwpSurface 통합, native Tauri 상호작용, D2 native IME, D4 편집 지연 및 RSS 관문을 대체하지 않는다.** 두 브라우저 중 하나를 실행하지 않았다면 그 관문은 UNVERIFIED로 남긴다. 알려진 메모리 결함 때문에 현재 패치를 운영에 통합해서는 안 된다.

## 고정 컴파일러의 Rust 검사

전체 upstream 소스가 있는 **별도** 검증 checkout에서 아래 명령을 순서대로 실행한다. browser용 선택 export와 전체 native fixture 검증은 구별한다. 이번 실행에서는 Rust 1.93.1로 기존 cache 단위 12개, 전체 library 4,064개(13 ignored 별도), native all-target Clippy와 WASM Clippy를 확인했다. 새 동시성 계약 7개 실패를 이 통과 수로 덮지 않는다.

```sh
node scripts/rust-test-suite-manifest.mjs --prepare
cargo fmt --check
cargo test --locked --lib surface_cache
cargo test --locked --lib
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --target wasm32-unknown-unknown --lib --release -- -D warnings
```

위 prepare는 검증 checkout의 ignored Rust harness를 생성한다. 생략하면 fmt·all-target 검사에서 파일 누락이 발생한다. 생성물은 패치에 포함하지 않는다. Nix의 이번 Rustup 설치는 기본 lld wrapper가 존재하지 않는 `nix-support/ld-wrapper.sh`를 참조했다. native 검사는 명령 범위의 `RUSTFLAGS='-C link-arg=-fuse-ld=bfd'`, WASM Clippy의 host build script는 임시 `cc` wrapper(`exec <원래 cc> "$@" -fuse-ld=bfd`)로 해결했다. compiler·시스템 설정·프로젝트 설정을 고치지 않았다. 이 호스트 우회와 초기 실패도 `rust-compatibility.json`에 남겼다.

## Render-job 소유권 후보 (별도 T010 후속)

새 증거·전체 패치는 `../evidence/t010-render-ownership/`에 둔다. 기존 v2/notify 증거와 `cache_contract.rs`, `historical.mjs`는 보존한다. 새 패치는 **pinned 기준에 단독 적용**한다. 기존 패치 위에 겹쳐 적용하지 않는다. 전체 상태·호환성 제한은 해당 디렉터리의 `REPORT.ko.txt`와 `resource-contract.json`을 확인한다. 이 후보는 제품 엔진을 교체하지 않는다.

```sh
python3 tests/integration/rhwp/cache-concurrency/prepare.py \
  --work "$CACHE_WORK/ownership" --toolchain-bin "$RUST_193_BIN" --no-opt \
  --patch tests/integration/rhwp/evidence/t010-render-ownership/upstream-rhwp-render-ownership.patch
python3 tests/integration/rhwp/cache-concurrency/unit.py \
  --rustc "$RUST_193_BIN/rustc" \
  --patch tests/integration/rhwp/evidence/t010-render-ownership/upstream-rhwp-render-ownership.patch \
  --contract tests/integration/rhwp/cache-concurrency/ownership_contract.rs \
  --output "$CACHE_WORK/ownership-contracts.json"
python3 tests/integration/rhwp/cache-concurrency/run.py \
  --pinned "$CACHE_WORK/pinned/test-package" --candidate "$CACHE_WORK/ownership/test-package" \
  --browser chrome --output "$CACHE_WORK/ownership-chrome.json"
python3 tests/integration/rhwp/cache-concurrency/run.py \
  --pinned "$CACHE_WORK/pinned/test-package" --candidate "$CACHE_WORK/ownership/test-package" \
  --browser webkit --output "$CACHE_WORK/ownership-webkit.json"
```

`unit.py --source <isolated/src/renderer/surface_cache.rs>`는 수정 중인 소스를 직접 검사할 때만 쓴다. 이때 `patchSha256`는 null이며 실제 source/contract SHA를 기록한다. 최종 증거에는 완성 패치에서 추출한 검사를 쓴다. Nix linker 우회가 필요한 환경은 앞 절의 task-local bfd wrapper를 사용한다.

`ownership_contract.rs`는 거부된 pending handle의 소유권이 호출자에게 남는 것, trim/budget 변경의 명시적 취소, oversized completion의 ready lease 이관을 검사한다. 기존의 “pending은 무조건 남는다” 및 “oversized 둘이 캐시에 동시에 남아야 한다”는 주장을 유지하지 않는다. 대신 브라우저에서 두 이미지가 모두 들어간 완성 프레임과 취소·한도 오류 시 원래 Canvas 보존을 검증한다. 원래 실패 검사와 재현 결과는 별도로 남는다.

`job-historical.mjs`는 기존 12개 시나리오·50개 관측을 job 완료 후 비교한다. 원래 nonblank 프레임은 같은 draw의 pinned RGBA와 비교하고, cold 비동기 관측은 같은 이미지 형식의 settled 기준과 비교한다. `negativeDecode`의 임의 바이트는 pinned paint 경로에서도 브라우저 decode 요청을 만들지 않는다. 이 관측은 원래 blank 픽셀 계약을 보존하며, 실제 디코드 ERROR와 재시도는 유효한 SVG의 DOM src를 오류 입력으로 주입하는 별도 검사다.

`ownership.mjs`는 공유 디코드·8 active job/2 in-flight 상한·네 이미지의 전진·초대형 ready lease·100 same-task 요청·취소·문서 변경·오래된 취소 토큰·15초 deadline·draw 오류·동기 API의 terminal ERROR 보존·두 쪽 순서·표 셀·crop·scale·재그리기·resident 보호를 검사한다. 보유량은 renderer estimate이며 RSS가 아니다. 정상 resident와 active/temporary lease는 별도 측정한다.

신규 API의 유무로 runner가 job 검사를 선택한다. `run.py`는 상위 PASS와 하위 FAIL의 모순, 빠진 계측, 잘못된 완료 값, timeout, 중복 완료 및 불완전 결과를 실패 처리한다. 신규 job API가 있는 경우 ownership 검사도 필수다. 아직 통합되지 않은 엔진 후보 검증을 geul native 상호작용·IME·편집 성능의 통과로 보지 않는다.

## Resource scheduler 후속 (A/B 포화·취소)

`t010-resource-scheduler/upstream-rhwp-resource-scheduler.patch`는 pinned 기준의 **새 전체 패치**다.
`t010-render-ownership`의 역사적 패치는 그대로 보존한다. 두 전체 패치를 겹쳐 적용하지 않는다.
`incremental-from-ownership.patch`는 역사적 ownership 패치가 이미 적용된 소스에만 쓴다.

```sh
python3 tests/integration/rhwp/cache-concurrency/prepare.py \
  --work "$CACHE_WORK/scheduler" --toolchain-bin "$RUST_193_BIN" --no-opt \
  --patch tests/integration/rhwp/evidence/t010-resource-scheduler/upstream-rhwp-resource-scheduler.patch
python3 tests/integration/rhwp/cache-concurrency/unit.py --rustc "$RUST_193_BIN/rustc" \
  --patch tests/integration/rhwp/evidence/t010-resource-scheduler/upstream-rhwp-resource-scheduler.patch \
  --contract tests/integration/rhwp/cache-concurrency/scheduler_contract.rs \
  --output "$CACHE_WORK/scheduler-contracts.json"
python3 tests/integration/rhwp/cache-concurrency/run.py --pinned public/rhwp \
  --candidate "$CACHE_WORK/scheduler/test-package" --browser chrome --timeout 240 \
  --output "$CACHE_WORK/scheduler-chrome.json"
python3 tests/integration/rhwp/cache-concurrency/run.py --pinned public/rhwp \
  --candidate "$CACHE_WORK/scheduler/test-package" --browser webkit --timeout 240 \
  --webkit-driver "$WEBKIT_DRIVER" --xvfb "$XVFB" \
  --output "$CACHE_WORK/scheduler-webkit.json"
```

`ownership_contract.rs`도 같은 완성 패치로 실행한다. 신규 contract의 raw 15는 내부 11+신규 4,
기존 ownership raw 24는 내부 11+외부 13이다. 중복 내부 검사를 합산하지 않는다.
`prepare.py`는 sourceStableDuringBuild를 실제 빌드 전후 비교 후에만 true로 기록한다. prepare-only는
이를 false로 유지하며 실제 WASM 실행 증거가 아니다. rendererJobAPI/schedulerAPI는 소스 기능 계측을 표시한다.

`scheduler.mjs`는 기존 ownership 52개에 추가하는 48개 검사다. 256개 작은 SVG resident/257번째 요청,
byte 지배 포화, 256개 활성 lease, 불가능한 working set, cell 위치의 그림, 재디코드를 검사한다.
취소 검사는 서버가 실제 SVG HTTP 응답을 보류하고 취소/해제하므로 브라우저 비동기 decode 경로를 지난다.
첫 poll 이후에는 정상 listener 알림에서만 poll한다. timeout은 진행 poll을 하지 않는다. `elapsedMs`는
정해진 관찰 시점까지의 진행 상한이며 정확한 지연 표본이나 D4 입력 성능이 아니다. 202번 취소 호출에도
알림 수가 유한하고, shared owner 취소로 실제 resource가 남으면 새 가용량 알림을 내지 않아야 한다.

러너는 신규 gate 누락, 하위 FAIL, 예산/선언 한도 위반, 불완전 게시 계측, 픽셀 불일치와 알림 폭증을
거부한다. 검증에서 거부한 원 결과도 JSON에 남긴다. 초기 실패·보완·최종 결과와 remaining gates는
`../evidence/t010-resource-scheduler/REPORT.ko.txt`를 참조한다.
