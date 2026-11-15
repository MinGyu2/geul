# 통합 글꼴 시스템 (Stage 5-A 글꼴 패키지) — 2026-11-16

상태: **PARTIALLY COMPLETED**. 공유 카탈로그·fontconfig 제공자·사용자 글꼴 등록/영속/제거·WordCraft(DOCX) 통합·PDF와 지원 범위의 RHWP HWP/HWPX font editing 및 narrow save proof는 구현·NixOS 검증 완료. RHWP natural font metrics, user-font wrapping, complex-script shaping은 미구현/미검증이다. Windows/macOS DEFERRED. Stage 5-A 전체는 INCOMPLETE, 출시 판단은 NO-GO다.

## 1. 구조

```
            ┌──────────── WebView (React) ─────────────┐
 리본 FontPicker ── format.font 명령(레지스트리·capability) ── DocxEditorSession → DocxOp::Font
       │                                                └── RhwpEditorSession: 지원 범위 format.font 변경·저장 검증
 useFontController ── font_catalog / refresh / register / remove (IPC, 경로 없음)
 WebFontBridge ── font_user_face(가족, 스타일) → FontFace → document.fonts (RHWP Canvas)
            └──────────────────────────────────────────┘
                                │ Tauri IPC
 src-tauri/src/fonts ── FontService ── SystemFontProvider(trait, 이식 가능한 타입)
                                │            └── fontconfig::Provider (libloading으로 실행 시 적재)
                                ▼
 WordCraft FontDb::global() (프로세스 하나) ── SystemFontSource = EngineSource(FontService)
     ├─ 번들 OFL 글꼴, 사용자 글꼴(앱 전용 fonts 폴더, load_user_fonts/install_font/remove_user_font)
     └─ 레이아웃·래스터·krilla PDF가 같은 DB를 쓴다
```

- **단일 데이터베이스**: UI 목록, DOCX 레이아웃·화면·PDF가 모두 WordCraft의 `FontDb::global()` 하나를 쓴다. geul은 별도 글꼴 DB를
  만들지 않는다. 시스템 글꼴은 fontconfig가 나열한 파일을 WordCraft가 이름 표(name/OS2/fvar)만 읽어 카탈로그하고, 실제 글꼴
  데이터는 그 가족이 처음 쓰일 때 읽는다(지연 적재, 시작 시 전체 적재 없음).
- **WordCraft 엔진 확장**(로컬 커밋 `6931bcc`, 브랜치 `geul/stage5a-font-source`, 부모 `dc25d8a`): `SystemFontSource` trait과
  `FontDb::set_system_font_source`. 소스가 있으면 고정 폴더 순회 대신 소스의 파일 목록을 카탈로그한다. 소스는 설정된 별칭·일반
  가족(`resolve_family`, `FontDb::face`와 `word::resolve`에서 Word 대체 규칙 다음에만 사용)과 문자별 선호 대체 가족
  (`fallback_families`, 기존 대체 목록보다 먼저 시도하되 실제 cmap 포함 여부를 다시 확인)을 제공한다. 다시 훑기는 별칭·실패·대체
  캐시를 비우고 `FontDb::generation`을 올린다. 소스가 없으면 동작은 이전과 같다. fonts crate 시험 51개, clippy, wasm check 통과.
- **재현성 (2026-11-16):** 공개 포크에서 `6931bcc` direct SHA fetch는 `not our ref`; 공개 HTTPS 부모
  `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5`는 fetch된다. [`patches/wordcraft/system-font-source.patch`](../../patches/wordcraft/system-font-source.patch)
  와 원본 commit metadata를 [`scripts/prepare-wordcraft.py`](../../scripts/prepare-wordcraft.py)가 확인해 같은 tree·commit SHA를 재구성한다.
  새 `--no-local` geul clone에서 parent-only retrieval, exact `6931bcc`/parent, clean submodule/no alternates, protected
  `cargo check -p wordcraft-fonts --locked --offline`를 검증했다. Cargo wrapper·CI도 같은 bootstrap을 쓴다. 잘못되거나 dirty한 기존 checkout은
  보존하고 거부하며 integrity gate를 유지한다. 공개 발행·push는 하지 않았다. 옛 “원격 재현 불가” 상태는 당시 기록이다.

## 2. fontconfig 제공자와 플랫폼 경계

- `src-tauri/src/fonts/fontconfig.rs`가 geul에서 유일하게 `unsafe`를 쓰는 모듈이다. fontconfig C API를 `libloading =0.7.4`(이미
  Tauri Linux 트리에 잠긴 판, 새 crate 없음)로 **실행 시** 적재한다. 라이브러리는 플랫폼 파일 이름(`libfontconfig.so.1`,
  `libfontconfig-1.dll`, `libfontconfig.1.dylib` 등)으로만 찾고 경로는 플랫폼 로더가 정한다. 모든 fontconfig 객체는 한 함수 안에서
  만들고 버리며 한 mutex로 직렬화한다. 읽는 문자열·개수는 상한이 있다(얼굴 10만, 값 64, 문자열 4 KiB).
- `FC_SCALABLE`은 동적 `FcPatternGetBool`(C ABI `FcBool`)로 읽는다. true만 허용하며 false·missing·type mismatch·비정규 bool은
  제외한다. `FcFontSet`은 소유된 fontconfig 배열을 borrowed bounded iterator로 순회한다. `nfont/sfont` 음수·불일치 및 null array를
  거부하고 `MAX_FACES`/`MAX_SORTED` 전에 범위를 자른다. 이는 geul의 traversal/result allocation만 제한하며 fontconfig 내부 font-set
  메모리 사용량의 상한을 주장하지 않는다.
- 탐색: `FcInitLoadConfigAndFonts`(시스템·사용자 `fonts.conf`, `FONTCONFIG_FILE`, 캐시를 그대로 따름) → `FcFontList`로 파일·색인·
  가족(언어 태그 포함)·스타일·굵기·기울기, 비트맵 글꼴 제외. `/nix/store`, `/usr/share/fonts`, `C:\Windows\Fonts` 등 어떤 경로도
  하드코딩하지 않는다.
- 별칭: `FcConfigSubstitute`+`FcDefaultSubstitute`+`FcFontMatch`. 일반 가족(`sans-serif`, `serif`, `monospace` 등)은 항상 받는다.
  그 밖의 이름은 존재하지 않는 탐침 이름이 받는 기본 글꼴과 다를 때만(=설정 규칙이 실제로 이름을 묶을 때만) 해석으로 인정한다.
  없는 문서 글꼴을 "해석됨"으로 취급하지 않기 위해서다.
- 대체: `FcFontSort`(sans-serif + 문자 charset) 결과에서 `FcCharSetHasChar`로 그 문자를 실제로 가진 글꼴만 최대 4가족. geul이
  문자별로 캐시하고(8192개 상한), WordCraft가 cmap으로 다시 확인한다.
- fontconfig가 없으면 제공자는 `available=false`, 카탈로그 `provider: "none"`이며 시스템 글꼴 없이 번들·사용자 글꼴만 쓴다. 그
  자리에 폴더를 훑지 않는다. 화면은 시작 시 한 번 알린다. 공개 카탈로그 계약(`FontCatalog`)은 플랫폼 타입을 쓰지 않으며, 이후
  DirectWrite/Core Text 제공자도 `SystemFontProvider`를 구현하면 된다.
- **검증 경계**: 위 설계는 이식 가능하지만 Windows·macOS에서 fontconfig 적재·탐색은 **실행하지 않았다(DEFERRED)**. 또 Linux 외
  플랫폼은 geul의 native 파일 선택기가 아직 없어 글꼴 추가 명령이 `PlatformUnsupported`를 돌려준다(기존 문서 열기와 같은 경계).

## 3. 카탈로그

- 가족 항목 신원은 `(출처, 가족)` — id `"system:nanumgothic"`, `"user:…"`, `"bundled:…"`. 같은 이름이 두 출처에 있으면 두 항목이다.
  fontconfig가 스타일·지역화 이름·레거시 "가족+스타일" 이름마다 따로 나열하는 것을 대표 가족 하나로 접는다(시험:
  `catalog_folds_styles_aliases_and_localized_names_into_families`).
- 항목: 가족, 지역화 이름(언어 태그), 스타일(CSS 굵기·기울임), 출처, `available`(파일 존재), `renderable`(FontDb가 그 가족의 얼굴로
  해석). 상태: 제공자, fontconfig 판, 시스템 얼굴 수, `generation`, 사용자 글꼴 저장 가능 여부, 시작 시 읽지 못한 저장 파일 이름.
- 새로 고침(`font_refresh`)은 fontconfig 설정을 다시 적재하고 FontDb를 다시 훑으며, 열린 DOCX는 새 배치로 다시 그린다.

## 4. 사용자 글꼴

- 형식: TTF, OTF, WOFF, WOFF2(TTC/OTC 유지). WordCraft `decode_font_file`/`install_font`를 그대로 쓴다: 입력 50 MiB, 풀린 크기
  128 MiB, 파일당 얼굴 256, 사용자 글꼴 1000개, 모든 얼굴이 파싱·문자 매핑돼야 함, WOFF/WOFF2 디코더 패닉은 손상 파일로 처리.
  이미 있는 (가족, 스타일)은 건너뛰고 모두 있으면 `AlreadyAvailable`. 실패는 카탈로그를 바꾸지 않는다.
- 등록은 Linux GTK native 선택기(`services::files::native_file_dialog`, 형식 `font`)에서 고른 파일 하나만 읽는다(O_NONBLOCK, 일반
  파일, 크기 상한). IPC는 경로를 받지 않으며 오류는 코드만 보낸다(경로·폴더·라이브러리 문구 없음).
- 영속: 앱 전용 `app_local_data_dir()/fonts`에 한 번만 저장(WOFF/WOFF2는 풀린 OTF/TTF로), 시작 시 `load_user_fonts`로 다시 적재.
  관리자 권한·전역 설치 없음. 저장 실패 시 이번 실행에서는 쓸 수 있고 `storageFailed`로 "다시 시작하면 없어짐"을 알린다.
  제거는 사용자 글꼴만(번들·시스템은 `NotUserFont`), 저장 파일을 지우고 대체 캐시를 비운다.
- RHWP 화면용 전달: `font_user_face(가족, 스타일)`은 **등록된 사용자 얼굴만** FontDb에 적재된 바이트로 돌려준다(첫 4바이트 얼굴
  색인). 시스템 글꼴은 WebView가 자기 플랫폼 글꼴 설정으로 이미 본다(WebKitGTK = fontconfig). WebView는 `FontFace(가족, 바이트)`로만
  추가하므로 CSP·파일 경로·URL을 바꾸거나 노출하지 않는다. 컬렉션의 두 번째 이후 얼굴은 WebView에 넣지 않는다.

## 5. 엔진 통합

### WordCraft (DOCX) — 구현

- `DocxOp::Font { name }` → WordCraft `format.font {"name"}`. 요청 이름을 그대로 저장한다(이 기계에 없어도 바꾸지 않음). CJK 글꼴이면
  WordCraft가 `w:eastAsia`도 같은 글꼴로 둔다. 접힌 커서는 엔진의 대상(커서 단어 또는 다음 입력)을 따른다. 이름 검증은 UI와
  백엔드가 같다(1–128바이트, 제어 문자·`" , ; \ { }`·U+FFFC 금지).
- 보기: 선택의 저장된 글꼴(`format.font`/`fontEastAsia`, 섞이면 null)과 `fontGeneration`. FontDb 세대가 바뀌면 모델이 다시 배치하고
  래스터를 버린다(revision 불변). 프런트엔드는 등록·제거·새로 고침 뒤 보기를 다시 받아 모든 쪽을 다시 그린다.
- 레이아웃·줄바꿈·쪽 나눔·화면·PDF가 같은 FontDb 얼굴과 메트릭을 쓴다. 혼합 한글/영문은 문서의 East Asian 글꼴 또는 fontconfig가
  고른 덮는 글꼴로 대체된다.

### RHWP (HWP/HWPX) — 부분

- 현재 구현은 `format.font`를 일반 RHWP 명령으로 연결한다. 선택 상태는 모든 formatting run을 살펴 uniform family만 표시하고, 혼합/읽을 수 없는 상태는 한 가족으로 추측하지 않는다. 본문과 지원되는 top-level table-cell selection은 한 번의 history action이며, 선택 밖 character properties, selection/caret ownership, Undo/Redo, IME boundary, revision/generation 및 save-state 검사를 기존 session transaction이 관리한다. 중첩 cell ownership은 기존 guard를 따르지만, 이 글꼴 변경의 nested-cell native acceptance는 NOT RUN이다. Collapsed-caret font mutation은 지원하지 않으며 표시 상태는 엔진의 right-affinity 규칙(명시적 end run 포함)을 따른다.
- ID 해석은 picker/catalog 순서나 CSS fallback에서 만들지 않고 문서가 소유한 각 언어 table의 정확한 ID를 별도로 읽는다. 슬롯은 0 HANGUL, 1 LATIN, 2 HANJA, 3 JAPANESE, 4 OTHER, 5 SYMBOL, 6 USER이며 각 ID는 자기 table에서만 유효하다. 선택한 가족 의도는 일곱 슬롯에 각각 해석한다. 이미 있는 유효 정의는 재사용하고 빠진 정의는 지원되는 plain variant로 원자적으로 append한다. placeholder는 만들지 않는다. 중복/잘못된 이름, 잘못된 참조와 미지원 table variant는 fail-closed다. 이 문서 이름은 glyph fallback과 별개이며 글꼴 파일은 문서에 embed되지 않는다.
- HWP에서는 기존 FACE_NAME 순서/바이트와 기존 ID_MAPPINGS identity를 유지하고, plain FACE_NAME attr 0만 추가 대상으로 허용한다. 새로운 CHAR_SHAPE font ID는 각 언어 표의 유효 정의로 해석되어야 하며, 모든 새 정의가 실제 body-referenced derived shape에서 사용되는지 증명한다. 새 HWP FACE_NAME은 plain `attr=0` name record만 append한다. compatibility-default/substitute variant는 만들지 않으며, 그런 미지원 기존 variant는 추측해 재생성하지 않고 글꼴 mutation을 거부한다.
- HWPX에서는 ordered seven-language fontface/ordinal/count 및 각 char-shape fontRef 관계를 확인한다. 신규 face는 non-embedded TTF `alt_type=1` 형태만 허용한다. 기존 canonical subtree/wrapper/namespace/attribute는 그대로이며, 유효한 derived shape의 fontRef 변경만 증명 범위다. 알 수 없는 원본 XML 속성을 보존할 수 없는 입력은 거부한다.
- publication은 immutable font+shape prefix identity를 정확히 reopen한 revision에 묶는다. Undo/Redo snapshot은 protected prefix에 remap되고 compaction은 unpublished/unreferenced entries만 제거한다. 실패한 publication은 lease를 해제하고 ID 의미를 바꾸지 않는다. HWP eligibility clone은 8 MiB로 제한되고 새 proof work는 4,000,000 단위 상한을 둔다.
- T009는 HWP와 HWPX의 별도 proof path를 사용한다. HWP proof는 기존 face/order, 정확한 7개 font counts와 char-shape count, 그 밖의 ID_MAPPINGS bytes, 원본/derived shape의 허용 필드와 trailing unknown bytes, 실제 body reference를 확인한다. HWPX proof는 원본 canonical XML 구조, 7개 언어/ordinal/count, 새 face 사용, derived fontRef의 좁은 변경 및 나머지 원본 subtree를 비교한다. 원본 preflight, unknown record/content 검증, 원본 identity 및 atomic publication 경계는 그대로 유지된다. 전체 proof 조건은 [저장 보존](save-preservation.md)과 아래 검증 기록을 따른다.
- 렌더링 한계: actual native acceptance에서 HWP/HWPX의 선택 글리프 픽셀, caret/selection 관계, PDF raster 변화는 확인했다. 그러나 RHWP는 여전히 portable HFT/heuristic metrics와 Canvas glyph-fit을 쓴다. derived rebuild는 exact font-source binding을 지우므로 natural font advances, 새 사용자 글꼴에 따른 줄바꿈/layout metrics, complex-script shaping은 active layer-tree layout에 연결되거나 검증되지 않았다. `FontFace.load()`만으로 완료라 하지 않는다. 따라서 font package는 PARTIALLY COMPLETED다.

## 6. 검증

### 6.1 이전 inventory-only 검증 기록 (2026-11-16, NixOS; superseded by 6.3)

| 범위 | 명령/산출물 | 결과 |
|---|---|---|
| WordCraft fresh dependency | `GEUL_SANDBOX=userns-root-bwrap python3 -m unittest scripts.tests.test_wordcraft_reproduction.WordcraftReproduction.test_fresh_public_base_exact_clean_source_and_compile` | PASS 1/1. 새 `--no-local` clone에서 공개 부모 fetch, exact commit/tree·parent·clean/no alternates 및 protected `cargo check -p wordcraft-fonts --locked --offline`. `target/font-completion/wordcraft-reproduction-final.log`. |
| fontconfig Boolean | `LD_LIBRARY_PATH=/nix/store/p3y4rk4gjnhs80339qq7jixjbhplqc16-fontconfig-2.18.3-lib/lib GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib fonts::fontconfig::tests::scalable_boolean_property -- --exact --nocapture` | PASS 1/1, output confirms `exercised real fontconfig Boolean API`. `target/font-completion/fontconfig-boolean-fixed.log`. |
| fontconfig traversal | `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib fonts::fontconfig::tests::font_set_traversal_bound -- --exact --nocapture` | PASS 1/1 (earlier focused run reused; unchanged test not rerun). |
| RHWP inventory unit | `npx vitest run src/components/Editor/rhwp/rhwpFonts.test.ts -t 'document font inventory'` | PASS 2/2; invalid slots/references and missing APIs fail closed. |
| RHWP Release WASM | generation `2745ff0089af491711bed4ab1caf5ee60051950fe810fd2cfee2b1e5549fda8c`, source tree `a5265cb664d8e3a2cb57076afff19317ba3a711024e7b6e3ddd07b91f0461a0c`; `npx vitest run --config scripts/tests/font-table.vitest.config.ts -t 'document font inventory'` | build/publication PASS, `externalUnchanged: true`; WASM tests PASS 4/4 for HWP/HWPX read-only inventory, unchanged export/reopen, malformed reference rejection. |
| TypeScript | `npm run typecheck` | PASS (valid prior result reused; relevant interface/source unchanged since run). |

**역사 기록 — 당시 inventory-only 상태 (2026-11-16 초기 검증, superseded by §6.3):** 이 결과는 문서 글꼴 표 읽기만 증명했다. 당시에는 신규 font ID 저장, 사용자 글꼴 정의 추가, Canvas glyph/metric/PDF 변경을 구현·검증하지 않았고 새 native font-change acceptance도 실행하지 않았다. WordCraft fonts 51, 기존 font Rust 15, native run10은 역사 결과로 재사용했고 재실행하지 않았다.
Windows/macOS와 다른 배포판은 DEFERRED다. 아래 실패 이력은 해당 inventory-only 검증 당시 기록이다: fresh harness의 상대 경로·manifest 오류는 수정됨; RHWP 초기 build는 CLI PATH와
generation retention으로 publication이 거부됐으나 기존 올바른 CLI와 unselected artifact 보존 뒤 build PASS; 처음 Boolean test는 sandbox 실행 시 fontconfig
library 경로를 찾지 못해 SKIP했고, 첫 실 API 실행의 integer fixture 오류를 고친 뒤 위 PASS다. WASM 테스트는 처음 기본 Vitest include에서 `No test files found`였으며,
focused `scripts/tests/font-table.vitest.config.ts`를 추가해 별도 4개 검증을 통과했다.

### 6.2 이전 검증 기록 (2026-11-15, NixOS 26.05, Linux 7.2.14, fontconfig 2.18.3, WebKitGTK 2.54.1)

### 당시 CURRENT PASS (2026-11-15 실행 기록)

| 명령 | 결과 |
|---|---|
| `cargo test -p wordcraft-fonts`(external/wordcraft) | 51 통과 (새 소스 시험 3개 포함), `cargo clippy -p wordcraft-fonts --all-targets -D warnings` PASS, wasm32 check PASS(기존 경고 1개) |
| `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib font -- --include-ignored` | 15 통과(글꼴 11: fontconfig 탐색·별칭·새로 고침·한글 대체·카탈로그 접기·TTF/WOFF/OTF(CFF)/WOFF2 등록·손상/초과 거부·중복·재시작 재적재·제거·저장 실패; DOCX 4: 검증·배치·저장/재열기·PDF·없는 글꼴 보존·등록 후 재배치) |
| `… cargo-geul.py clippy --lib --bins -- -D warnings` | PASS |
| 일반 cargo `test --lib adapters::wordcraft` | 93 통과, 2 ignored (보호 래퍼 안에서는 PDF 게시 시험 2개가 sandbox 임시 디렉터리를 공유 디렉터리로 판정해 `SaveUnsupported{SharedDirectory}`로 거부 — 환경 조건, 해당 코드는 미변경) |
| `npx vitest run` (fonts.test, webFonts.test, FontPicker.test, wordcraft/fonts.test, docx.test, commands, ribbon, Ribbon, language, DocxEditorSession, stabilization 2종, RhwpEditorSession, RhwpSurface, App) | 새 시험 18개(fonts 3·webFonts 3·FontPicker 7·DOCX 세션 4·docx 응답 1) 포함 PASS. 단 `src/commands/sessions.test.tsx` 1건과 `src/commands/hangulTools.test.tsx` 1건은 **HEAD `737a9a3`의 깨끗한 작업 트리에서도 같은 이유로 실패하는 기존 실패**(이번 변경과 무관, 수정하지 않음) |
| `npm run typecheck`, `npm run lint`, `npm run build` | PASS |
| native: `native-ibus-session.py -- native-font-acceptance.py`(run10) | **PASS** (아래) |
| 독립 검사 `node scripts/tests/font-acceptance-inspect.mjs <run10>` | **PASS** |

native run10(앱 debug 프로필, 일반 제품 프런트엔드 `testFlags: {}`, SHA-256 `117cb3373e90c54385b9427f8b90d28fb79b714b3c4cba7b0bfb05848c49c35b`,
Xvfb + IBus, GTK 선택기, xdotool, 결과 `src-tauri/target/font-native/run10/`(ignored)):

1. 실제 fontconfig 설정에서 시스템 얼굴 137개, 가족 31개, `sans-serif`→Noto Sans CJK KR, `serif`→Noto Serif CJK KR,
   `monospace`→Noto Sans Mono CJK KR, 모든 시스템 가족이 엔진에서 해석됨, NanumMyeongjo(지역화 이름 "나눔명조") 선택.
2. 리본 "글꼴 추가…" → GTK 선택기로 TTF(OFL JetBrains Mono를 `GeulMono Test1`로 이름 바꿈)와 WOFF2(RHWP 자산의 OFL Source Han
   Serif K Old Hangul subset) 등록, 둘 다 `persisted`·`renderable`.
3. DOCX(WordCraft 생성 `basic-ko.docx`) 첫 줄 "한글 문단입니다. Korean paragraph."에 NanumMyeongjo 적용: 선택 폭 200.36→188.99 pt,
   Undo/Redo, 저장(보존 검사 통과), PDF 내보내기. 다른 사본에 `GeulMono Test1` 적용: 200.36→221.28 pt, 저장, PDF.
4. HWP(`hongbo.hwp`)·HWPX(`edu-2022.hwpx`): 선택기에 "휴먼명조"/"Haansoft Dotum" 표시, 글꼴 선택 시 "글꼴: 이 문서 형식에서는
   지원하지 않습니다", revision·dirty·원본 불변, 쪽 그림 PDF 내보내기(4쪽/18쪽).
5. 앱 재시작(같은 비공개 XDG_DATA_HOME): 두 사용자 글꼴 재적재(저장 파일 `GeulMonoTest1.ttf`, `SourceHanSerifK-OldHangul-subset.otf`),
   저장한 DOCX 재열기 후 선택 글꼴 `GeulMono Test1` 유지, WOFF2 글꼴 제거 → 카탈로그·저장 파일에서 사라짐.

독립 검사(geul/WordCraft/krilla 코드 미사용, 자체 ZIP·PDF 파서): 저장 DOCX `word/document.xml`에 `w:ascii="NanumMyeongjo"`(+`w:eastAsia`)와
`w:ascii="GeulMono Test1"`; PDF에 `OUCARL+NanumMyeongjo`, `BHSXKP+GeulMonoTest1-Regular` 내장(FontFile 4개), 라틴 글자가 선택 글꼴로
그려지고, 한글은 ToUnicode로 매핑(나눔명조 / Noto Sans CJK), 매핑 없는 글리프 0, `.notdef`(CID 0) 0, "한글 문단입니다"·
"Korean paragraph" 추출, 쪽 수 = 편집기 쪽 수; HWP/HWPX PDF는 쪽마다 그림 1개.

하네스 실행 이력: run1–run9는 하네스 결함(선택기 제목 정규식, GTK 위치 비동기 활성화, 이전 알림 오인, 최소 DOCX 픽스처의 정당한
저장 거부, DOCX에 Ctrl+A 미연결, 탭 상태, PDF 이름 중복, 기록 복사)으로 FAIL했고, run8에서 RHWP 대표 글꼴 표시 규칙(한글/라틴이
다르면 "여러 글꼴"로 보이던 것)을 한글 슬롯 표시로 바꾼 제품 수정이 한 번 있었다. 모든 실행 디렉터리를 보존했다.

### REUSED PASS (재실행 안 함)

PDF 게시 안전(Package A/B), 문서 저장 T009, IME, Stage 2–4, T010–T014, 187/64 행렬, D4 — 이번 변경은 그 코드 경로(저장 증명,
PDF 게시, IME, RHWP 패치)를 바꾸지 않았다. DOCX PDF 경로는 같은 함수이며 글꼴 원천만 바뀌어, 위 독립 PDF 검사로 새로 확인했다.

### NOT RUN / UNVERIFIED / 관찰

- Windows/macOS 빌드·설치·실행, 다른 Linux 배포판, fontconfig 패키징: **DEFERRED** (PASS 아님).
- 한글 대체 얼굴이 PDF에 `NotoSansCJKjp-Thin`(가변 CJK 컬렉션 TTC의 명명 인스턴스 PostScript 이름)으로 들어감 — 글자 매핑은
  정상이나 화면/인쇄의 시각적 굵기는 확인하지 않았다(UNVERIFIED, WordCraft 가변 글꼴 인스턴스 선택 동작).
- 스타일 선택: 선택기는 가족의 스타일 수를 보이지만 스타일 이름 적용은 하지 않는다(WordCraft `format.font`는 가족만, 굵게/기울임은
  기존 명령). RHWP Canvas가 사용자 글꼴로 실제 그렸는지의 픽셀 비교, 사용자 글꼴의 RHWP 메트릭 반영은 미검증.
- 글꼴 선택기 키보드: 단위 시험(화살표·Enter·Escape·모달)만, native 키보드 탐색 전체는 미실행(선택 입력은 native xdotool로 실행).


### 6.3 RHWP 글꼴 변경 focused 및 native 검증 (2026-11-16, NixOS)

상태: **CURRENT PASS** — 지원되는 HWP/HWPX 단순 본문 시나리오에 한정. 전체 font package는 natural metrics/shaping integration 미구현으로 **PARTIALLY COMPLETED**; 전체 Stage 5-A INCOMPLETE, Release NO-GO다.

| 범위 | 실행/증거 | 결과 |
|---|---|---|
| T009 proof | `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib font_preservation_tests -- --nocapture` | 4 PASS. `target/font-completion/font-proofs-final.log` |
| Release WASM/session | `npx vitest run --config scripts/tests/font-table.vitest.config.ts scripts/tests/font-editing.wasm.test.ts`와 후속 exact filters `-t 'font (session|stale)'`, `-t 'font (cell|pending)'` | 최신 단일 실행 14 PASS(`target/font-completion/font-language-wasm.log`): core 4, session/stale 4, cell/pending 4, 선택·caret per-language(Latin vs Hangul) HWP/HWPX 2. generation `cfb26d65aaf99c16386dbd24497f8a79dcf4caa63e17bd9da53ba839700b619c`. 이전 generation `3622d808…`의 4+4+4 결과는 역사적 기록이다. |
| resolver/UI | `npx vitest run src/components/Editor/rhwp/rhwpFonts.test.ts src/components/FontPicker/FontPicker.test.tsx` | 15 PASS(최종 소스로 재실행, `target/font-completion/font-resolver-resume5.log`); typecheck PASS(`font-typecheck-resume5.log`); production `npx vite build`, protected app build PASS(`native-language-frontend.log`, `native-language-app.log`). |
| positive native | `python3 scripts/tests/native-ibus-session.py --out "$PWD/target/font-completion/native-run4-session" -- python3 scripts/tests/native-rhwp-font-editing.py --app "$PWD/src-tauri/target/debug/geul" --driver "$PWD/src-tauri/target/debug/tauri-driver" --xdotool @XDOTOOL@ --ibus @IBUS@ --fixtures "$PWD/target/font-completion/native-fixtures" --out "$PWD/target/font-completion/native-run4"` | HWP/HWPX에서 기존 NanumMyeongjo와 등록 GeulMono Test1 적용, visible Canvas glyph changes, Undo/Redo, save/close/reopen 및 7-slot family identity 확인. independent inspector PASS: CFB/XML original-prefix/ID mapping, page size, PDF before/after pixel changes and ink bounds; caret/selection relation 확인. app SHA-256 `29bd1c6c…`, Release generation `cfb26d65…`; fixture·JS/CSS·WASM hashes는 `native-run4/result.json`에 기록. independent result `native-run4/independent.json`(PASS, 2 formats). |
| negative native | `python3 scripts/tests/native-ibus-session.py --out "$PWD/target/font-completion/native-negative3-session" -- python3 scripts/tests/native-rhwp-font-negative.py --app "$PWD/src-tauri/target/debug/geul" --driver "$PWD/src-tauri/target/debug/tauri-driver" --xdotool @XDOTOOL@ --ibus @IBUS@ --fixtures "$PWD/target/font-completion/native-negative-fixtures" --out "$PWD/target/font-completion/native-negative3"` | HWP opaque FACE_NAME variant와 HWPX unknown namespaced header attribute 각각 save refusal; HWP Undo recovery/HWPX revision unchanged, 원본 bytes 보존 PASS. |
| non-run scope | — | Nested-cell font native scenario, Windows/macOS, Debug WASM runtime, other Office applications NOT RUN/DEFERRED. Release private-path cleanup remains separate. |

재생성 명령은 `node scripts/tests/rhwp-font-editing.mjs --generate "$PWD/target/font-completion/native-fixtures"`와 `python3 scripts/tests/prepare-rhwp-font-negatives.py "$PWD/target/font-completion/native-fixtures" "$PWD/target/font-completion/native-negative-fixtures"`다. 독립 검사는 `python3 scripts/tests/inspect-rhwp-font-editing.py "$PWD/target/font-completion/native-run4" "$PWD/target/font-completion/native-fixtures"`로 실행한다. 결과는 `target/font-completion/native-run4/independent.json`, positive/negative result JSON 및 launcher logs에 있다. 초기 WASM session/stale mock은 `loadGeneration=0`을 돌려줘 실제 stale ownership을 증명하지 못했다. 최종 mock은 load/ready/commit generation 1로 맞춘 뒤 backend projection을 1→2로 바꾸며 거부를 확인해 ownership regression 4개가 PASS했다. 별도로 native-run1/run2는 PDF export 후 File 탭에서 picker가 unmount된 상태를 읽어 previous family가 null이 된 하네스 오류였고, negative-run1은 close/discard helper 오류였다. 이 실패들은 수정된 harness의 run3/negative2 PASS와 구분해 보존한다. 이후 최종 검토에서 Latin 선택이 Hangul 대표 ID만으로 균일하게 보고되는 UI 반례를 찾아 엔진 fontRuns/caret 속성에 languageIndex를 추가했고, 그 결과 generation `cfb26d65…`, run4/negative3/independent4로 전체 focused native 흐름을 다시 실행해 PASS했다(run3/negative2는 이전 generation의 역사적 PASS). 저장 산출물 해시는 run3과 byte-identical이다. 인접 단위 시험 `npx vitest run src/commands src/components/Editor/rhwp src/components/FontPicker`는 899 PASS/4 FAIL이며 4건(`hangulTools`, `sessions` 서식 미지원 기대, `hwpReopenModel` 2건)은 커밋 `a42d7c0` 깨끗한 worktree에서도 동일하게 실패하는 기존 실패다(`font-neighbors-resume5.log`). 전체 Rust/Vitest/WordCraft/RHWP suites, 기존 native corpus, D4는 재실행하지 않았다.

#### Native Release 신원과 결과 해시

| 항목 | SHA-256 / identity |
|---|---|
| 시작 HEAD | `a42d7c0c4cfda033fc0e05b68f5d10e9d24623c1` |
| WordCraft gitlink | `6931bcc12af12ff874a9ebb4c63cebe17b3f8b82` |
| RHWP gitlink | `1a76570e833917d15817415a53c09ad61ab3203f` |
| Tauri app | `29bd1c6ca0627d812c12d167834acc2bf5c451ecc6cd322d1b8c914289b75e74` |
| Frontend production | `testFlags={}`; JS `ac460ad8b3b9f0f6a6c44478d21bea72ed2771db94aafed6f5a381f26234eb3b`; CSS `89d241b51df8e53d748a641a07ba4c904dfe9c0763af382c511edcb38f2557d3`; index `33f0920807019123983e4cea0c9cf1ffae235ce934a8e4a0086a1e1ef3d8adee` |
| RHWP Release | generation `cfb26d65aaf99c16386dbd24497f8a79dcf4caa63e17bd9da53ba839700b619c`; source tree `392b9194bce0bb471ec1c625ac2fa5af218b7e470e7332c5a78ad65a17ccb3f0`; `rhwp.js` `338cd08e488173bf899e33ce3d0c77000c0d7bac9a82907792dd616bea524ea3`; WASM `da5a0fdf7031c1a25e3f4727fcd8f6daab79685486d10e796d913a636bc10417` |
| Positive inputs | HWP `fd995682e56e91d43c42056591bee08d418944f7f717799e4159f5a59c84523d`; HWPX `46da5760c1c57e00408f45b238eb38f0a8cd83746514292d643cc205bb470022` |
| Positive saved HWP | existing NanumMyeongjo `0d5934a8550645f5bf72be5bc6d148ecca22c58ef7f690c98d5336813172fb74`; user GeulMono Test1 `cf879cbd72d86d22c6c3cfc535d7f43166f9d4c2e079b24d4ed93aaa3730e5de` |
| Positive saved HWPX | existing NanumMyeongjo `0b49a612465a1ccd5f70d70e91e5f319f3fbd322412617343a13072009fbd275`; user GeulMono Test1 `b05eb1f5c9d2570ce5721aa79b2e133339607c88ca9cec68adc6e89b5518e4e8` |
| Registered user font | `GeulMonoTest1.ttf` `2da55f36ea76c22b3484ec14d25205dbd4eaa04bdc58bc29402e2993c780c4a0` |
| Negative source fixtures | HWP `20a5eff6790be112496ef5a80eaeff9595f0def86d70d4c841e988ee99ebc04e`; HWPX `f8a5ffd2b0820c5c782effd305b373c3e79cd46d522caa96dbdddfbaede45ec3` |
| PDF raster baseline / changed | `0eeaf5374e5db17aea0aa5b0b283c296bff9f2c2167b47e3357c6e7d13af920c` → `0067851b55b6743e78e09858ac67614e780b046c8c858661d7c2ece2d1608e53` (1588×2245; 11,367 changed channels) |

Saved-output hashes are the products from native-run4 (`result.json`; identical to run3); the independent inspector confirmed the expected family, seven language slots, preserved original definitions and changed PDF raster. Negative inputs were preserved after refusal. These identity records describe the supported Release run; they do not establish natural metrics/shaping or broader interoperability.


## 7. 알려진 제한

1. HWP/HWPX는 지원 범위에서 글꼴 변경을 지원한다. 미지원 FACE_NAME/XML variant는 6.3절의 보존 증명에 따라 거부한다.
2. Linux 외 플랫폼: 글꼴 추가 대화상자 없음, fontconfig 동작 미검증.
3. portable HFT/heuristic metrics와 Canvas glyph-fit을 유지한다. Natural advances, user-font wrapping/layout metrics, complex-script shaping은 미구현/미검증이다.
4. 사용자 글꼴은 WebView에 컬렉션 첫 얼굴만 전달하고 파일은 문서에 embed하지 않는다.
5. 사용자·시스템 글꼴은 배포물에 넣지 않는다. 번들은 WordCraft OFL 4계열뿐(기존 고지 범위).
