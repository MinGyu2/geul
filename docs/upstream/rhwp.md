# rhwp 코어 검토 (T002)

- 업스트림: https://github.com/edwardkim/rhwp
- 위치: `external/rhwp/` (Git submodule)
- 고정 커밋: `1a76570e833917d15817415a53c09ad61ab3203f` (태그 `v0.8.7`, 2026-10-06 릴리스)
- 검토일: 2026-10-16. 검토 방법: 고정 커밋의 소스·매니페스트·README 정적 검토
- 라이선스·고지: [docs/licenses/rhwp.md](../licenses/rhwp.md)

## 검증 수준

| 수준 | 의미 | 이 문서의 상태 |
|------|------|----------------|
| L1 | 업스트림이 설명하는 기능 | README 기준으로 정리 |
| L2 | 고정 커밋에서 공개 API 존재 확인 | 소스에서 시그니처 확인 (아래 표) |
| L3 | 이 프로젝트에서 컴파일·호출 성공 | **WASM 완료(T007)**: `scripts/build-rhwp-wasm.sh`(Rust 1.99, wasm-bindgen 0.2.127, `--locked`)로 빌드, 앱 WebView와 Node에서 호출. 네이티브 path 의존성 빌드는 R-A라 하지 않음 |
| L4 | 실제 문서로 동작 검증 | **일부(T007)**: 생성한 HWP/HWPX 픽스처로 열기·렌더·hit test·편집·내보내기·다시 열기. 임의 실제 문서의 보존은 T009/T015 |

## 구조

- 단일 크레이트 `rhwp`(라이브러리 `rlib` + `cdylib`, edition 2021) + 보조 크레이트
  `crates/rhwp-contracts`, `crates/rhwp-ooxml-chart`, `crates/rhwp-password-crypto`.
- `rust-toolchain.toml`이 Rust `1.93.1`과 `wasm32-unknown-unknown` 타깃을 고정합니다. rustup 없이
  다른 버전(이 환경은 1.99.0)으로 빌드할 때의 호환성은 L3 단계에서 확인해야 합니다.
- 프런트엔드: `rhwp-studio`(Vite + TypeScript 웹 에디터), npm 패키지 `@rhwp/editor`, `@rhwp/hwpctrl`.
- `rhwp-desk`: Tauri 2 기반 Windows 데스크톱 워크벤치. 루트 워크스페이스에서 분리되어 있고, 엔진을
  링크하지 않고 `rhwp` CLI 실행 파일을 찾아 호출합니다(`rhwp-desk/src/engine.rs`). 데스크톱 구조 참고 자료일
  뿐 코어로 쓰지 않습니다.
- 체크아웃 용량이 큽니다(얕은 복제 약 8.7 GB: `pdf/` 1.3 GB, `mydocs/` 2.7 GB, `samples/` 690 MB 등).

## 형식별 지원 수준 (L1 README 기준 / L2 소스 확인)

| 형식 | 읽기 | 쓰기 | 근거 |
|------|------|------|------|
| HWP 5.0 (OLE2/CFB) | 지원 (L1, L2: `parser::parse_hwp`, `HwpParser`) | 지원 — "HWP 편집 저장" (L1), `DocumentCore::export_hwp_native`, `serialize_document_with_report` (L2) | README Features, `src/serializer/mod.rs` |
| HWPX (OWPML/ZIP) | 지원 (L1, L2: `HwpxParser`, `src/parser/hwpx/`) | "의미 보존 저장" (L1), `DocumentCore::export_hwpx_native[_with_report]` (L2) | README, `src/serializer/hwpx/` |
| HWP 3.x | 파서 존재 (L2: `Hwp3Parser`, `src/parser/hwp3/`) | 직렬화 형식 목록에 없음(`SerializedFormat`은 `Hwp`, `Hwpx`만) → 원본 형식 저장 불가로 간주 | `src/serializer/content_loss.rs` |
| HML (HWPML 2.9/2.91) | 확인된 구조만 제한 지원 (L1) | 보존 불가 요소가 없을 때만 preflight 후 저장, 미지원 요소는 손실 저장 차단 (L1) | README |
| 암호화 문서 | `parse_document_with_password`, `export_hwpx_native_with_password` (L2) | | |

"의미 보존 저장"은 임의 사용자 문서의 바이트 단위 무손실을 뜻하지 않습니다. 실제 보존 범위는 T009/T015의
왕복 검사로 판단합니다.

## API 후보 (L2: 소스에서 존재 확인, 호출은 미검증)

### 네이티브 Rust (Tauri 백엔드에서 링크하는 경로)

| 목적 | 후보 API | 비고 |
|------|----------|------|
| 형식 판별 | `rhwp::parser::detect_format(&[u8]) -> FileFormat` | T006에서는 쓰지 않음: OLE 서명(앞 4바이트)만 보고 `Hwp`로 분류해 다른 OLE 문서와 구별하지 못함(L2, `src/parser/mod.rs`). 앱은 `src-tauri/src/document/`에서 FileHeader·필수 스트림까지 확인하며, HWPX 필수 항목(`Contents/content.hpf`, `Contents/header.xml`)과 암호 표식(`encryption-data`)은 rhwp와 같은 기준을 쓴다 |
| 열기 | `DocumentCore::from_bytes(&[u8]) -> Result<DocumentCore, HwpError>`, `from_bytes_with_password` | |
| 페이지 | `DocumentCore::page_count()` | |
| 저장 | `export_hwp_native`, `export_hwpx_native`, `export_hwpx_native_with_report` 등 (`src/document_core/commands/document.rs`) | `*_with_report`는 손실 보고서(`ContentLossCode`: `BinaryContentEmptied`, `ControlOmitted`, `MetadataReduced`)를 함께 반환 → FR-006 `unsafe-save` 판정 근거 후보 |
| 렌더 | `PageRenderTree`/`PageLayerTree` (`DocumentCore::build_page_layer_tree`), SVG 내보내기 | 네이티브 경로의 대화형 렌더 성능은 미확인 |

### WASM/JS (`src/wasm_api.rs`, `#[wasm_bindgen]` 내보내기 467개)

| 목적 | JS 이름 |
|------|---------|
| 문서 객체 | `HwpDocument` (constructor), `createEmpty` |
| 렌더 | `renderPageSvg`, `renderPageHtml`, `renderPageToCanvas`, `pageCount` |
| 커서·hit test | `hitTest`, `getCursorRect`, `getCursorRectInCell`, `hitTestInHeaderFooter`, `hitTestFootnote` |
| 편집 | `insertText`, `deleteText`, `insertTextInCell`, `applyCharFormatAtCursor` |
| 저장 | `exportHwp`, `exportHwpWithReport`, `exportHwpx`, `exportHwpxWithReport`, `exportHwpxWithPassword` |

- 한국어 IME: `rhwp-studio/src/engine/input-handler*.ts`가 DOM `composition*` 이벤트를 처리합니다.
  웹 편집 표면에서 IME를 다룬 선행 구현이 있다는 뜻이며, Tauri WebView(WebKitGTK/WebView2/WKWebView)에서
  같은 동작을 하는지는 T007에서 확인합니다.
- Undo/Redo는 `rhwp-studio/src/engine/history.ts`(프런트엔드 쪽)에 있습니다. 엔진 API로 제공되는
  범위는 T007에서 확인합니다.

## 통합 위험

- 편집 기능과 IME·커서 처리가 WASM + 웹 프런트엔드 조합으로 가장 많이 다듬어져 있습니다. 네이티브 Rust
  경로만 쓰면 이 부분을 다시 만들어야 할 수 있습니다.
- 저장소에 AI 에이전트·MCP·서명(`agent`, `pq_sign`, `capsule_sign` 등) 모듈이 함께 있어 의존성 표면이
  넓습니다. 필요한 기능만 쓰도록 feature/링크 범위를 L3에서 확인합니다.
- `samples/`, `pdf/`, `mydocs/`의 문서는 출처·라이선스가 파일별로 명시되어 있지 않습니다. 이 저장소의
  테스트 픽스처로 복사하지 않습니다([tests/fixtures/README.md](../../tests/fixtures/README.md)).
- 버전 0.x, 릴리스 간 API 변경 가능성이 있습니다.

## 다음 확인 (T003, T007)

1. `rhwp`를 path 의존성으로 빌드(네이티브) 및 `wasm-pack` 빌드 (L3)
2. 직접 만든 HWP/HWPX 열기 → 렌더 → `hitTest`/`getCursorRect` → `insertText` → `export*WithReport` →
   재열기 비교 (L4)
