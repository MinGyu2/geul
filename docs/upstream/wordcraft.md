# WordCraft 코어 검토 (T001)

- 업스트림: https://github.com/storytold/wordcraft
- 위치: `external/wordcraft/` (Git submodule)
- 고정 커밋: `fc41918814f62645b6746ed68e71e8c2c2e85d6f` (태그 `v0.7.0`, 2026-10-14 릴리스)
- 검토일: 2026-10-16. 검토 방법: 고정 커밋의 소스·매니페스트·문서 정적 검토
- 라이선스·고지: [docs/licenses/wordcraft.md](../licenses/wordcraft.md)

## 검증 수준

| 수준 | 의미 | 이 문서의 상태 |
|------|------|----------------|
| L1 | 업스트림이 설명하는 기능 | README·크레이트 설명 기준으로 정리 |
| L2 | 고정 커밋에서 공개 API 존재 확인 | 소스에서 시그니처 확인 (아래 표) |
| L3 | 이 프로젝트에서 컴파일·호출 성공 | **미실시** (앱 크레이트 없음, T008에서 수행) |
| L4 | 실제 문서로 동작 검증 | **미실시** (T008, T009, T015에서 수행) |

## 구조 (L1/L2)

Cargo 워크스페이스, `edition = "2024"`, `rust-version = "1.90"`, 모든 크레이트 `unsafe_code = "forbid"`.

| 크레이트 | 역할 (매니페스트 설명 요약) | 통합 관련성 |
|----------|-----------------------------|-------------|
| `wordcraft-doc` | 문서 모델(스토리·문단·런·표·구역·스타일·번호·필드·주석·변경 내용 추적), 편집 기본 연산 | DOCX 세션의 모델 소유자 |
| `wordcraft-docx` | DOCX(OOXML) 읽기·쓰기, 암호화 문서, Flat OPC/Word 2003 XML | 열기·저장 |
| `wordcraft-docbin` | `.doc`(Word 97-2003) 읽기 | 초기 범위 밖 |
| `wordcraft-engine` | 세션, 선택, Undo, 명령 레지스트리, 파일 I/O 분기 | 어댑터의 주 진입점 |
| `wordcraft-layout` | 셰이핑, 줄바꿈, 페이지 나누기, 머리글/바닥글, **hit test** | 커서·선택 좌표 |
| `wordcraft-render` | 레이아웃 display list → 래스터(vello_cpu), PNG/JPEG | 페이지 이미지 |
| `wordcraft-pdf` | PDF 내보내기(krilla) | 후속(T016) |
| `wordcraft-fonts`, `wordcraft-geom`, `wordcraft-proof`, `wordcraft-metafile`, `wordcraft-formats` | 글꼴, 단위, 맞춤법, WMF/EMF, 기타 형식 | 간접 의존 |
| `wordcraft-ui-egui` | egui 리본 UI. "nothing below depends on it" | 사용하지 않음(앱 UI는 React) |
| `wordcraft-mcp`, `wordcraft-zotero`, `wordcraft-control-key` | MCP 서버, Zotero 연동, 제어 포트 | 초기 범위 밖 |
| `apps/wordcraft`, `apps/wordcraft-cli`, `apps/wordcraft-web` | 데스크톱 앱, CLI, eframe 웹(WebGPU/WebGL2) | 참고용 |

## API 후보 (L2: 소스에서 존재 확인, 호출은 미검증)

| 목적 | 후보 API (경로) | 비고 |
|------|-----------------|------|
| 열기 | `wordcraft_engine::io::open_bytes(name, bytes) -> Result<Document, String>`, `open_bytes_with(name, bytes, password)`, `open_path(path)` (`crates/engine/src/io.rs`) | 확장자로 형식 분기. 오류는 문자열 |
| DOCX 직접 | `wordcraft_docx::read(bytes)`, `read_with_password`, `write(doc)`, `is_encrypted` (`crates/docx/src/lib.rs`) | 리더는 크기·깊이 제한이 있다고 문서화됨 |
| 저장 | `io::save_bytes(name, doc)`, `save_bytes_opts`, `save_path_with` | 안전 저장(임시 파일·원자적 교체)은 앱(T014)이 담당 |
| 세션 | `Session::new(doc)`, `rev()`, `document_id()`, `edit_snapshot()` (`crates/engine/src/session.rs`) | `rev()`를 어댑터 revision으로 사용 가능 |
| 명령 | `Session::run(id, &serde_json::Value) -> Result<Value, CmdError>`; `CommandSpec { id, label, location, shortcut, params, mutates, enabled, run }`; 레지스트리 `get`, `all`, `describe`, `by_shortcut` (`crates/engine/src/lib.rs`) | 안정 명령 ID(`format.bold` 등)와 비활성 사유 제공 → FR-007 capability 매핑 후보 |
| Undo | `Session::undo`, `redo`, `can_undo`, `can_redo`, `undo_label` | |
| 레이아웃 | `Session::layout() -> Arc<DocLayout>`; `DocLayout::hit(page, x, y, story) -> Option<Pos>`, `caret(&Pos) -> Option<Caret>`, `page_of(&Pos)` (`crates/layout/src/hit.rs`) | 커서·선택을 React 쪽 오버레이로 그릴 때 필요 |
| 렌더 | `wordcraft_render::render_page(doc, page, scale, opts) -> Rendered`, `render_region`, `Rendered::to_png()` (`crates/render/src/lib.rs`) | CPU 래스터 → 이미지로 WebView 전달 후보 |
| 선택 | `Selection { .. }::caret(pos)`, `is_collapsed`, `ordered` | |

### 한국어 IME

- IME 처리는 `wordcraft-ui-egui`(`crates/ui-egui/src/keys.rs`의 `egui::Event::Ime` Preedit/Commit)에만
  있습니다. 엔진은 조합 상태를 모릅니다.
- React 표면을 쓰면 WebView의 `compositionstart/update/end`를 받아 조합 중 텍스트는 오버레이로 표시하고,
  확정 문자열만 엔진 명령으로 보내는 구조가 필요합니다. 이 방식이 동작하는지는 T008에서 확인합니다.

## 통합 위험

- WordCraft에는 JS용 공개 API가 없습니다. `apps/wordcraft-web`은 egui 앱 전체를 캔버스로 띄우는 형태라
  React UI와 섞어 쓰기 어렵습니다. 네이티브 Rust(Tauri 백엔드)에서 엔진을 링크하는 경로가 우선 후보입니다.
- 렌더 결과가 래스터 이미지이므로 고배율·스크롤 시 성능과 선명도 검증이 필요합니다.
- 버전 0.x이며 릴리스 간격이 짧습니다(v0.5.0 → v0.7.0, 2026-10-11 ~ 10-14). 공개 API 안정성 보장이
  없으므로 어댑터 경계에서 업스트림 타입 노출을 최소화합니다.
- `wordcraft-ui-egui`, 앱 아이콘, ArtCraft 브랜드 파일은 재사용하지 않습니다(라이선스 문서 참고).

## 다음 확인 (T003, T008)

1. `src-tauri`에서 `wordcraft-engine`을 path 의존성으로 빌드 (L3)
2. 직접 만든 DOCX 열기 → `render_page` → PNG, `hit`/`caret` 좌표 확인 (L4)
3. `Session::run("format.bold", ..)`, Undo, 저장 후 재열기 비교 (L4)
