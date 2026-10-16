# 편집 표면 통합 방식과 PoC 게이트 (T003)

- 상태: 결정(PoC 전 후보 선정). PoC 결과에 따라 갱신합니다.
- 날짜: 2026-10-16
- 관련: FR-004, FR-005, SC-002, [plan.md](../planning/plan.md),
  [WordCraft 검토](../upstream/wordcraft.md), [rhwp 검토](../upstream/rhwp.md)
- 근거 수준: 업스트림 소스 정적 검토(L1/L2)만 수행했습니다. 아래 후보는 아직 빌드·실행하지 않았습니다.

## 배경

중앙 편집 영역은 React UI 안에 있어야 하고(6영역 레이아웃), 두 엔진은 모델·렌더·Undo를 각자 소유해야
합니다(FR-004). 두 엔진은 프런트엔드 연결 방식이 다릅니다.

| | rhwp | WordCraft |
|---|------|-----------|
| JS API | 있음 (`wasm_api.rs`, 467개 내보내기) | 없음 (egui 앱 전체를 WASM으로 띄우는 `wordcraft-web`만 있음) |
| 네이티브 API | `DocumentCore` (열기·내보내기·페이지 트리) | `Session`, `DocLayout::hit/caret`, `render_page` |
| IME 선행 구현 | `rhwp-studio` (DOM composition 이벤트) | `wordcraft-ui-egui` (egui IME 이벤트) |
| 렌더 출력 | Canvas2D/CanvasKit/SVG/HTML | CPU 래스터(PNG 등) |

## 결정

엔진마다 다른 편집 표면을 쓰되, React `Editor` 컴포넌트가 공통 계약(plan.md의 `EditorAdapter`)으로 감쌉니다.

### rhwp (HWP/HWPX)

- **1순위 R-A: WebView 안의 rhwp WASM.** `external/rhwp`를 wasm-pack으로 빌드한 모듈을 프런트엔드에서
  로드하고 `renderPageToCanvas`/`renderPageSvg`, `hitTest`, `getCursorRect`, `insertText`를 직접 호출합니다.
  파일 읽기·쓰기는 Tauri 백엔드가 맡고 바이트만 주고받습니다. 저장은 `export*WithReport` 결과를 백엔드의
  안전 저장(T014)으로 넘깁니다.
  - 이유: 편집·IME·커서 처리가 가장 많이 다듬어진 경로이며, 키 입력마다 IPC 왕복이 없습니다.
  - 위험: WebKitGTK의 WASM 성능, WebView가 죽으면 저장 안 된 편집 손실, 문서 모델이 백엔드에서 보이지 않음.
- 2순위 R-B: Tauri 백엔드의 네이티브 `DocumentCore` + 페이지 SVG/레이어 트리를 IPC로 전달.

### WordCraft (DOCX)

- **1순위 W-A: Tauri 백엔드의 네이티브 엔진.** `src-tauri`가 `wordcraft-engine`을 path 의존성으로 링크하고
  `Session`을 보유합니다. 페이지는 `render_page` → PNG 바이트로 보내고, 커서·선택·IME 조합 문자열은
  React 오버레이가 `hit`/`caret` 좌표로 그립니다. 확정된 문자열만 `Session::run`으로 보냅니다.
  - 이유: JS API가 없고, 엔진이 UI(egui)와 분리되어 있어 네이티브 링크가 가장 단순합니다.
  - 위험: 키 입력마다 IPC 왕복과 페이지 재래스터 비용, 고배율 선명도.
- 2순위 W-B: 앱 저장소 안에 얇은 wasm-bindgen 래퍼 크레이트를 만들어 엔진+렌더를 WASM으로 빌드하고 WebView에서
  호출(`wordcraft-web`이 엔진의 wasm32 빌드 가능성을 보여 줌). 업스트림 소스는 수정하지 않습니다.

### 채택하지 않는 방식

- `wordcraft-web`(eframe 캔버스)을 그대로 끼워 넣기: 자체 리본 UI 전체를 함께 띄우며 WebGPU/WebGL2 지원이
  WebView마다 다릅니다.
- 별도 egui 네이티브 창: 6영역 단일 창 구조를 깨고 IME를 두 곳에서 처리하게 됩니다.
- 두 엔진 문서 모델을 하나로 합치기(FR-004 위반).

## PoC 실행 경로

PoC 코드는 실제 앱 위치에 둡니다(별도 PoC 저장소 없음). 업스트림 소스는 수정하지 않고, 빌드 산출물이
submodule 안에 생기지 않도록 `CARGO_TARGET_DIR`과 wasm-pack `--out-dir`을 submodule 밖으로 지정합니다.

| 단계 | 작업 | 위치 | 통과 기준 |
|------|------|------|-----------|
| P0 (L3) | 두 엔진 빌드 확인: `src-tauri`에서 `wordcraft-engine`, `rhwp` path 의존성 `cargo check`; `wasm-pack build external/rhwp --target web` | `src-tauri/`, 빌드 출력은 `/target/`(무시 대상) | 경고 외 오류 없음, 업스트림 수정 없음 |
| P1 (T007) | rhwp R-A: 픽스처 열기 → 렌더 → 클릭 hit test → 한글 입력 → 저장 → 재열기 | `src/components/Editor/`, `tests/integration/rhwp/` | 아래 측정 항목 |
| P2 (T008) | WordCraft W-A: 같은 시나리오 | `src-tauri/src/adapters/`, `tests/integration/wordcraft/` | 아래 측정 항목 |

측정 항목(형식별로 기록, Linux WebKitGTK 우선, Windows/macOS는 T016):

1. 렌더: 10쪽 이하 픽스처의 첫 페이지 표시 시간, 100%/200% 배율 선명도
2. 한국어 IME: 두벌식으로 "한글 입력 테스트" 입력 시 조합 중 표시, 확정 1회 삽입(중복·누락 없음),
   조합 중 클릭/화살표 이동 시 동작
3. 마우스: 본문·표 셀에서 클릭한 글자 경계에 커서, 드래그 선택 범위
4. 키보드: 화살표, Home/End, Shift 선택, Backspace/Delete, Enter, 표에서 Tab 이동
5. 응답성: 키 입력부터 화면 반영까지 지연(p95)
6. 저장·재열기: 입력한 텍스트 유지, 손실 보고서(rhwp `*WithReport`) 내용, 원본 대비 구조 비교

## PoC 중단 조건 (FR-005 게이트)

다음 중 하나라도 해당하면 T010 이후 고급 UI 작업을 확대하지 않고, 결과를 이 문서에 기록한 뒤 계획을
다시 정합니다.

- 1순위와 2순위 후보 모두에서 IME 확정 문자가 중복·누락되거나, hit test가 클릭한 글자에서 1글자 넘게
  어긋나는 경우
- 최적화 후에도 키 입력 지연 p95가 150 ms를 넘는 경우
- 기본 열기·편집·저장에 업스트림 소스 수정이 필요한 경우(업스트림 기여 또는 포크 여부를 따로 결정)
- 픽스처 저장 결과에 손실 보고가 있거나 재열기 비교가 다를 때 원인을 설명할 수 없는 경우
  → 해당 형식은 읽기 전용 또는 저장 차단으로 처리(FR-006)
- 같은 장애에 진전 없는 수정을 두 번 반복한 경우(tasks.md 실행 정책)

## 테스트 데이터

[tests/fixtures/README.md](../../tests/fixtures/README.md)의 정책을 따릅니다. PoC 최소 픽스처는
형식별 기본 문서(한·영 문단, 굵게, 2×2 표)와 오류 사례(확장자-헤더 불일치, 잘린 파일, 암호화 문서)입니다.
