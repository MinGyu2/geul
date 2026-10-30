# WordCraft 코어 검토 (T001)

- 업스트림: https://github.com/storytold/wordcraft
- 위치: `external/wordcraft/` (Git submodule)
- 고정 커밋: `fc41918814f62645b6746ed68e71e8c2c2e85d6f` (태그 `v0.7.0`, 2026-10-14 릴리스)
- 검토일: 2026-10-16. 검토 방법: 고정 커밋의 소스·매니페스트·문서 정적 검토
- 라이선스·고지: [docs/licenses/wordcraft.md](../licenses/wordcraft.md)

## 보호된 백엔드 빌드

WordCraft는 `src-tauri`의 path dependency이므로 Rust 백엔드 작업에는 이 고정 submodule이
초기화되어 있어야 한다. 빌드·검사에서는 Cargo를 직접 실행하지 않고 저장소 루트에서
`npm run rust -- fetch`로 현재 host target에 필요한 잠금 파일 기준 캐시를 준비한 뒤
`npm run rust -- check --lib --bins`, `npm run rust -- test`,
`npm run rust -- fmt --check` 또는
`npm run rust -- clippy --lib --bins -- -D warnings`를 사용한다.
`scripts/cargo-geul.py`는 WordCraft revision과 작업 트리 상태를 검사하고 Linux bubblewrap으로
초기화된 모든 `external/` 소스와 실제 parent/common/submodule Git metadata, object store 및
alternate object store를 읽기 전용으로 둔다. writable artifact/cache 경로는 생성 전에 mount
구조와 device/inode 별칭을 확인해 hardlink·symlink·bind mount 경로를 검사한다. WordCraft 전용
CI 체크아웃은 WordCraft만 받아도 되며, RHWP 대형 submodule을 초기화할 필요가 없다.

NixOS의 기본 경로는 unprivileged `bwrap`이다. GitHub Actions `ubuntu-24.04`에서 관측된
`bwrap: setting up uid map: Permission denied`는 Cargo 실행 전에 발생했다. CI는 `sudo-bwrap`로
namespace와 mount만 설정한다. 이후 `setpriv`가 Cargo를 시작하기 전에 원래 runner UID/GID로
돌아가고 보조 그룹과 모든 capability를 지우며 privilege 상승을 차단한다. user namespace 매핑을 쓰지
않고, 보호 기능을 사용할 수 없으면 보호되지 않은 빌드로 fallback하지 않는다. Ubuntu의
user namespace 제한 또는 AppArmor가 원인이라는 설명은 해당 실행의 감사 로그로 확인되지
않은 추론이다. 수정된 workflow의 GitHub-hosted 실행 결과는 공개 후 확인해야 하므로 아직
검증되지 않았다. 보호 래퍼는 Cargo fetch에만 network를 허용하고 일반 빌드·검사는 network를
격리한다.

일반 보호 검사는 외부 파일 내용을 전체 반복 해시하지 않는다. 전체 내용 감사가 필요하면
`--deep`과 writable 출력 경로, 보고서 경로, 검증할 명령을 지정해 별도로 실행한다
([예시](rhwp.md#외부-소스와-wasm-빌드)).

## 검증 수준

| 수준 | 의미 | 이 문서의 상태 |
|------|------|----------------|
| L1 | 업스트림이 설명하는 기능 | README·크레이트 설명 기준으로 정리 |
| L2 | 고정 커밋에서 공개 API 존재 확인 | 소스에서 시그니처 확인 (아래 표) |
| L3 | 이 프로젝트에서 컴파일·호출 성공 | **완료(T008)**: `src-tauri`가 `wordcraft-engine`을 path 의존성으로 링크(업스트림 수정 없음) |
| L4 | 실제 문서로 동작 검증 | **부분(T008)**: 엔진 명령으로 만든 픽스처로 열기·배치·그리기·hit test·편집·메모리 왕복. 실제 사용자 문서·디스크 저장은 T009/T015 |

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

## T008에서 확인한 것 (2026-10-19, 고정 커밋 `fc41918`)

- `io::open_bytes`/`save_bytes`, `Session::new`·`run`·`layout`·`rev`, `DocLayout::hit`·`caret_on`·`selection_rects`,
  `render::render_page` + `Rendered::to_png`를 실제로 호출했다. 좌표는 pt(쪽 왼쪽 위), Letter 612×792pt, 100% 화면 = 1pt × 96/72 CSS px.
  `Pos`는 `{story, path, off}`이며 `off`는 UTF-8 바이트다. `Session`은 `Send`라 Tauri 차단 작업 스레드에서 쓸 수 있다.
- `caret.set`은 `{page, x, y}`로 hit test까지 한다. `text.insert`는 자동 고침·자동 서식을 적용하므로 IME 확정 글자는
  `raw: true`로 넣는다. `text.tab`은 표 안에서 다음 셀로 가며 셀 내용을 선택하고, 마지막 셀에서는 행을 더한다(Word와 같음).
- **`rev()`는 문서를 바꾸지 않은 “바꾸는 명령”에도 는다**(셀 사이 Tab, 문서 처음의 Backspace, 끝의 Delete). 앱 revision은
  명령 앞뒤 문서 모델(`Document: PartialEq`)을 비교해 실제 변경만 센다.
- **`Session::run`을 그대로 열면 파일 쓰기 권한이 된다**: `file.saveAs`(cmd/file.rs:55)·편지 병합(cmd/mailings.rs:658)·
  `cmd/tools.rs:431` 등이 인자로 받은 경로에 쓴다. 앱은 허용한 연산 목록(`DocxOp`)만 명령 ID로 바꾼다.
- 열기는 관대하다: 본문 XML이 중간에서 끊긴 DOCX를 오류 없이 끊긴 곳까지 읽어 연다(뒤 내용은 조용히 빠짐). 열기 성공을
  무손실 근거로 쓰면 안 된다(T009 저장 판단). 시험: `adapters::wordcraft::tests::본문_xml이_끊긴_docx도_wordcraft는_끊긴_곳까지_읽어_연다`.
- 글꼴: `FontDb::global()`은 정해진 폴더(Linux `/usr/share/fonts`, `/usr/local/share/fonts`, `~/.fonts`, `~/.local/share/fonts`)만
  찾고 fontconfig를 쓰지 않는다. NixOS처럼 그 폴더가 없으면 한글이 빈 상자로 그려진다(편집 모델은 정상).
- 성능(이 환경, 1쪽 픽스처): 릴리스 빌드에서 배치 1 ms 미만, 100% 쪽 래스터 약 3 ms + PNG 약 4 ms, 200% 약 13 ms. 최적화 없는
  디버그 빌드는 키 입력 하나에 수백 ms라 `src-tauri`의 개발 프로필이 의존성을 최적화한다.

## 다음 확인 (T003, T008 계획 당시)

1. `src-tauri`에서 `wordcraft-engine`을 path 의존성으로 빌드 (L3)
2. 직접 만든 DOCX 열기 → `render_page` → PNG, `hit`/`caret` 좌표 확인 (L4)
3. `Session::run("format.bold", ..)`, Undo, 저장 후 재열기 비교 (L4)

## T009 확인(2026-10-19, 고정 커밋 `fc41918`)

- `io::save_bytes`(DOCX)는 모델에서 패키지를 새로 만든다. 판독기는 모르는 표시를 건너뛰고(`crates/docx/src/lib.rs`), 다시 내보내는
  XML은 모르는 이름공간의 요소·속성을 버린다(`crates/docx/src/xml.rs`). WordCraft가 쓴 문서는 편집 없는 왕복에서 부분마다 같았고,
  Word식 패키지(`customXml`·`w14`·`w:rsid`)는 그 부분·속성을 잃었다. `docProps/app.xml`에는 `Words`·`Paragraphs` 통계를 쓴다.
  앱의 저장 판정은 [save-preservation.md](../architecture/save-preservation.md).
