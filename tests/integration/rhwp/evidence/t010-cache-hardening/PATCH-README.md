# rhwp 렌더러 이미지 캐시 교정 패치 (T010 캐시 보강, 2026-10-23)

**geul에 통합하지 않았다.** 고정 rhwp(`external/rhwp`, 1a76570e, v0.8.7)와 그 submodule 판은 바꾸지 않았다. 두 파일은 별도
upstream checkout에서 만든 검토용 diff다.

| 파일 | 기준 | 내용 |
|---|---|---|
| `upstream-rhwp-bounded-image-cache-v2.patch` | 고정 rhwp 1a76570e | 교정한 전체 패치(원 패치 + 교정). 이것만 적용하면 된다 |
| `upstream-rhwp-cache-hardening-incremental.patch` | 원 패치(`../t010-followup/upstream-rhwp-bounded-image-cache.patch`) 적용 뒤 | 이번 교정분만 |

원 패치와 그 증거(`../t010-followup/`)는 그대로 두었다.

## 고친 결함 (브라우저에서 재현 → 교정 확인)

| | 원 패치 | 교정 |
|---|---|---|
| A. 그리기 직전 해제 | 그리기가 `get`으로 받은 `HtmlImageElement`(같은 DOM 객체의 clone)를, 그 직후 `resize`가 한도 초과로 내보내며 `src=""`로 놓았다. 그 그리기와 예산 압박 때 다음 그리기가 빈 그림 | 비용 갱신을 그리기 경로에서 빼 load 이벤트로 옮겼다. 캐시는 handle을 돌려준 뒤 그리기가 끝날 때까지 바뀌지 않는다. 로드가 끝난 항목은 자신의 비용 갱신으로 내보내지 않는다(다른 항목만) |
| B. 자른 그림 비용 | `draw_image_cropped`는 비용을 갱신하지 않아 인코딩 길이로 남았다 | 두 그리기 경로가 같은 `browser_image()`를 쓴다. 비용은 load 이벤트에서 한 번 data URL 길이 + 자연 크기 RGBA 추정 |
| C. 비동기 로드·한도 초과 | 한도를 넘는 그림은 보관하지 않거나 로드 뒤 내보냈다. 로드 중 다시 그리면 새 요소를 만들며 앞 로드를 취소했다(`insert`가 이전 값을 `release`). trim도 로드를 취소했다. 끝났다는 알림이 없다 | 로드 중(`pending`) 항목은 예산·trim으로 내보내지 않고, 다시 그려도 새로 만들지 않는다. 로드 뒤 한도를 넘으면 **일시**(transient) 항목: 그릴 수 있게 두되 다음 자리 요구·trim에서 가장 먼저 내보낸다. 실패는 음성 항목(되풀이 로드 없음). `setRendererImageLoadListener(fn)`: 로드가 끝나면 그리기 밖(이벤트 task)에서 호스트를 부른다. 렌더러는 스스로 그리지 않는다(닫힌·바뀐 문서에 늦게 그리지 않음) |
| 기타 | `wasm_api.rs`에서 새 함수가 `extractThumbnail` 문서 주석 가운데 끼어 주석이 엉뚱한 함수에 붙었다 | 제자리로 옮김 |

자른 그림이 로드 전 같은 data URL로 바로 그릴 수 있게 되면, 고정 엔진은 `draw_image`로 넘겨 **자르지 않은 그림 전체**를
대상 상자에 그릴 수 있었다. 교정판은 자른 경로에서 자른 대로 그린다(측정한 고정 엔진 결과와 픽셀이 다른 경우는 없었다).

## 정책 (Stage B)

- 디코드 Canvas 캐시(`DECODED_CANVAS_CACHE`, 동기 Rust 디코드): LRU 내보내기 + **입장 제한**(TinyLFU 축약). 자리를 만들려면
  내보내야 할 때, 새 항목의 최근 요청 수가 내보낼 각 항목보다 많을 때만 들인다(같으면 있는 것을 지키고 새 것은 그리고 놓음).
  요청 수는 15에서 포화, (보관 항목 수×4, 최소 64) 요청마다 반으로 줄인다. 셈표는 항목 한도의 4배로 묶는다.
- 브라우저 이미지 캐시(`IMAGE_CACHE`): 입장 제한 없음(들이지 않으면 비동기 로드가 끝나도 그릴 것이 없다).
- 기본 예산은 원 패치와 같다(디코드 256 MiB, 브라우저 이미지 64 MiB, 각 256개). 성능 결과를 위해 올리지 않았다.
- `bytes`는 캐시가 붙잡은 양의 **추정**이다: 디코드 Canvas는 너비×높이×4, 브라우저 이미지는 data URL 길이(+로드 뒤 자연 크기
  RGBA). 브라우저 내부 디코드 사본·GPU 사본·프로세스 RSS의 상한이 아니다.

## 검증 (자세한 수치: `browser-lifecycle.json`, `cache-budget.json`, README.md)

- Rust 단위 12/12 (`cargo test --lib surface_cache`, cargo 1.99.0 — rhwp가 고정한 1.93.1은 이 환경에 없음).
- rustfmt `--check` 4파일 통과. clippy(wasm32 lib, native lib+tests): 바꾼 4파일 경고 0. 그 밖의 파일 경고 38개는 1.99 새 lint로
  이 패치와 무관(고정 툴체인 release gate 통과는 **확인하지 못함**).
- `wasm-pack build --release` 성공.
- 실제 WASM 렌더러 브라우저 검사(Chrome 155 headless, WebKitGTK 2.54.1): 생성 fixture 12 시나리오 50 그리기, 교정판 = 고정 엔진
  픽셀 50/50(두 브라우저), 원 패치는 Chrome 4·WebKitGTK 3 그리기가 빈 그림.
