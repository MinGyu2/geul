# rhwp 코어 검토 (T002)

## 외부 소스와 WASM 빌드

`external/` 아래의 모든 의존성은 Git에 고정된 제3자 소스다. 빌드와 검증은
소스, 매니페스트·잠금 파일, submodule 및 Git 메타데이터를 바꾸지 않는다. RHWP WASM
빌드에는 RHWP submodule, Rust 백엔드 빌드에는 WordCraft가 필요하다. 다른 submodule은
초기화하지 않은 채 둘 수 있다.

Linux NixOS의 기본 보호 경로는 unprivileged bubblewrap(`bwrap`)이다. GitHub Actions의
`ubuntu-24.04` runner에서는 UID map 설정이 `Permission denied`로 실패해 Cargo가 시작되지
않았던 실행이 있었다. CI는 `sudo-bwrap` 모드를 사용한다. privileged 실행은 mount·PID·network
namespace 설정에만 쓰며, Cargo를 시작하기 전에 `setpriv`가 runner UID/GID로 돌아가고 보조 그룹을 지우며
모든 capability 및 privilege 상승을 제거한다. 환경 변수도 권한을 내린 다음 복원한다.
user namespace를 요청하지 않으며 대체되는 비보호 실행 경로도 없다. Ubuntu의 user namespace
제한 또는 AppArmor 정책이 원인이라는 설명은 가능한 해석이며, 해당 실행의 감사 로그로
확인된 것은 아니다. 보호된 명령은 지원되지 않는 namespace 또는 mount 상태에서 실패한다.
캐시 준비 `cargo fetch`만 network를 쓰고 일반 빌드·검사는 network namespace를 격리한다.
이 CI 변경을 포함한 원격 workflow는 공개 후 실행하기 전까지 검증되지 않은 상태다.

`scripts/external-integrity.py`는 고정 gitlink와 submodule 상태를 확인하고 실제 Git directory와
common directory를 읽기 전용으로 둔다. parent/worktree/submodule metadata, Git object store와
기록된 alternate object store를 보호한다. writable 출력 경로를 만들기 전에 mountinfo를
대조하고, hardlink·symlink·디렉터리 inode 별칭을 metadata traversal로 검사한다. alias audit는
Cargo cache 부모에서 나중에 생성될 파일로 향하는 보호 소스의 symlink도 거부한다.
파일 내용을 읽지 않으며 정상 경로에서 전체 external tree를 반복해서 해시하지 않는다.
sandbox는 자식 프로세스의 쓰기를 막고, 빠른 snapshot은 선택한 identity와 주요 파일을 확인한다.
이는 sandbox 밖에서 발생한 모든 임의 파일 변경을 감지한다는 뜻은 아니다. 전체 파일 및 Git
metadata 내용 감사가 필요할 때는 다음처럼 명시한다. 보고서는 `target/` 아래에 둔다. 변경이
감지되면 자동 복구하지 않고 실패한다.

```sh
python3 scripts/external-integrity.py --deep \
  --writable target/check \
  --report target/check/deep-integrity.json \
  -- true
```

기본 실행은 `scripts/build-rhwp-wasm.sh`이며 `--dev`는 Debug 프로필을 선택한다. 기본
Release 빌드는 Rust `--release`와 맞는 wasm-bindgen CLI를 사용하지만 Binaryen optimizer는
실행하지 않는다. `--wasm-opt`를 지정하면 설치된 `wasm-opt 117 -O`를 실행하고 WASM 인터페이스
호환성을 확인한다. 이 옵션은 Release에서만 허용된다. Rust 1.99.0, `wasm32-unknown-unknown`,
RHWP lockfile과 동일한 wasm-bindgen(현재 0.2.127)이 PATH에 있어야 한다. 도구 설치나 Cargo
network 조회는 빌드 중 수행하지 않고, Cargo는 `--locked --offline`으로 실행한다. 요청된
optimizer가 없거나 버전이 다르면 실패한다.

같은 RHWP 소스와 Rust Release 캐시에서 실행한 WebKit 비교는 `wasm-opt -O`가 asset-management
문서의 focused endpoint 평균 시간을 5.64 ms 늘렸고, paired bootstrap의 탐색적 95% 구간은 3.43–8.01 ms였다.
단계 진단에서는 차이가 주로 문서 생성 단계에 있었고 동기 캔버스 replay 증가는 확인되지 않았다.
화학 문서에서는 같은 설정이 평균 1.26 ms 빨랐다. 이 측정은 해당 런타임과 두 문서에 한정되며
일반 성능 보장이나 공식 D4 통과를 뜻하지 않는다. 따라서 기본 빌드는 optimizer를 생략한다.
Binaryen 117 `-O`는 크기 최적화가 필요할 때 `--wasm-opt`로 명시적으로 선택한다.

빌더는 각 생성 세대를 `public/rhwp/generations/<generation>/`에 완전히 설치하고, JS, WASM,
`BUILD.json`의 identity와 해시를 검증한다. `RELEASE.json`과 `DEBUG.json`은 별개로 원자적으로
갱신되며 Debug 빌드가 Release 선택을 바꾸지 않는다. 레거시 `BUILD.json`은 최근 빌드의 호환
포인터이고 제품 프로필 선택에는 사용하지 않는다. `npm run build`와 Tauri Release 빌드는
Release pointer를 요구한다. `npm run tauri -- build --debug` 및 개발 서버는 `DEBUG.json`이
있으면 Debug generation을 선택하고, 없을 때만 Release generation을 fallback으로 쓴다.
개발 서버는 시작 시 선택한 generation을 고정하므로 새 WASM을 선택하려면 서버를 재시작한다.
generation의 JS/WASM/identity는 Vite의 public JS 변환 전에 원본 바이트로 제공한다.
Vite는 선택된 generation 하나만 정적 출력에 복사한다. frontend-only CI는 RHWP submodule 없이
`npm run build:frontend`로 실행하며, 이 모드는 Tauri 제품 빌드에서 거부된다. Release의 Rust
build.rs는 frontend hook을 건너뛴 경우에도 실제 `dist/rhwp`의 identity와 해시를 확인하고,
Release identity가 없거나 손상됐거나 Debug이거나 선택하지 않은 세대·파일이 남으면 패키징을 거부한다.

기존 reader가 오래된 세대를 계속 사용할 수 있도록 builder는 generation을 자동 삭제하지 않으며
최대 6개를 유지한다. 한도를 넘는 신규 publication은 실패한다. 오래된 artifact는 모든 소비자가
종료된 것을 확인한 뒤 운영자가 명시적으로 정리한다. 중단된 staging도 자동 삭제하지 않는다.
공개 BUILD 파일은 최소 identity만 포함한다. 로컬 경로·명령·환경·상세 snapshot은 ignored
`target/rhwp-wasm/`에 기록되며 생성물은 Git에서 제외된다.

공개 identity schema 1은 기존 identity 형식(optimization 필드 없음)을 읽기 위한
호환 형식이다. 현재 빌드는 schema 2를 사용하며, RHWP commit, profile, 버전만 있는 도구
identity, 소스 fingerprint, generation digest, `rhwp.js`/`rhwp_bg.wasm` SHA256 및 최적화
설정을 포함한다. generation digest는 generation 필드를 제외한 canonical identity에서
계산한다. 공개 스키마는 allowlist로 검사한다.

WordCraft만 필요한 Rust 명령은 저장소 루트에서 `npm run rust -- check --lib --bins` 또는
`python3 scripts/cargo-geul.py check --lib --bins`를 사용한다. 이 래퍼는
`external/wordcraft`를 필수로 검사하고 초기화된 RHWP가 없으면 RHWP 다운로드를 요구하지
않는다. 일반 빌드는 명시적으로 승인된 `target/` 계열 출력만 쓰기 가능하게 둔다.

Tauri `build`는 CLI의 Cargo/Vite 자식 전체를 보호한다. `dev`는 전용 Cargo runner가
컴파일을 보호한 뒤 개발 앱을 일반 사용자 권한으로 실행한다. 앱이 사용자 문서를 저장하는
동작까지 빌드용 읽기 전용 root 안에 가두지 않는다.

## PNG 최적화의 현재 경계

제품 호출 경로는 RHWP의 `src/renderer/web_canvas.rs`에서
`image::load_from_memory`를 호출하고, `image 0.25.10`의 내장 PNG decoder가
`png 0.18.1`의 내부 Paeth 복원 코드를 사용한다. `image 0.25.10`은
`register_format_detection_hook`과 `register_decoding_hook`으로 Rust 호출자가
포맷 판별과 decoder를 등록할 수 있게 한다. `load_from_memory`도 이 포맷 판별 hook을
확인한다. 이 API들은 decoder 선택 지점이며 Paeth predictor를 바꾸는 callback은 아니다.
또한 png 0.18.1의 filter 모듈과 Paeth 함수는 private (`pub(super)`)이고 공개 predictor
callback도 없다. PNG `StreamingDecoder` 공개 API가 있지만, 이 역시 내부 Paeth 함수의
교체 지점은 아니다.

현재 제품은 external RHWP가 자체 cdylib으로 만든 WASM이다. geul에는 그 WASM 인스턴스
안에서 Rust hook을 등록하는 export 또는 초기화 경계가 없다. 별도로 로드되는 JavaScript나
다른 WASM crate는 인스턴스 내부의 Rust hook registry를 변경할 수 없다. 따라서 현재
고정 제품 빌드에는 실험된 Paeth 구현을 연결하는 지점이 없다.

향후 가능한 geul 소유 통합 경계로, RHWP rlib과 `image`를 함께 링크하는 WASM host/bootstrap을
구성해 공개 image format/decoding hook으로 PNG decoder adapter를 등록하는 방안이 있다.
이는 새 빌드·export 계약을 설계해야 하는 변경이며, 아직 제품 경로가 아니다. 기존 렌더
의미와 PNG fallback을 유지하는지, 픽셀이 정확히 같은지, 메모리·취소 동작과 성능이 안전한지
별도로 검증해야 한다. 다른 경로로는 필요한 구현이 포함된 upstream 승인 릴리스 및 RHWP
고정 revision 갱신, 또는 명시적으로 승인된 공개 fork와 그 재현 가능한 설정을 검토할 수 있다.
외부 소스를 바꾸거나 소스 사본을 만드는 방식은 사용하지 않는다.

2026-10-30 실험 보고서의 픽셀 및 성능 결과는 당시 후보에서만 측정되었으며 현재 제품
통합이나 성능 향상의 증거가 아니다. 제품 WASM은 고정된 미수정 RHWP 소스를 사용한다.

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

## T009 확인(2026-10-19, 고정 커밋 `1a76570`)

- `exportHwp(x)WithReport().contentLoss()`는 `{schemaVersion:1, outputFormat, count, losses[]}`이며 직렬화가 스스로 안 손실(코드 3종)만
  적는다. 업스트림 예제 HWP·HWPX 각 60개의 편집 없는 왕복에서 보고는 모두 0건이었지만, HWPX 57개는 본문 XML의 실제 요소가 바뀌거나
  사라졌고 HWP 6개는 레코드·스트림이 달랐다. 그래서 앱은 보고서를 보존의 근거로 쓰지 않는다([save-preservation.md](../architecture/save-preservation.md)).
- 잘린 HWPX 본문 XML을 rhwp는 오류 없이 거의 빈 문서로 연다.
