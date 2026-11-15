# 통합 글꼴 시스템 (Stage 5-A 글꼴 패키지) — 2026-11-15

상태: **PARTIALLY COMPLETED**. 공유 카탈로그·fontconfig 제공자·사용자 글꼴 등록/영속/제거·글꼴 선택 UI·WordCraft(DOCX) 통합·PDF는
구현 및 NixOS 검증 완료. RHWP(HWP/HWPX)는 글꼴 표시·사용자 글꼴의 WebView 전달·Canvas 다시 그리기까지 구현했고, **HWP/HWPX 글꼴
변경은 저장 보존 증명이 없어 명시적으로 거부**한다(아래 5절). Windows/macOS 실행 검증은 DEFERRED.

## 1. 구조

```
            ┌──────────── WebView (React) ─────────────┐
 리본 FontPicker ── format.font 명령(레지스트리·capability) ── DocxEditorSession → DocxOp::Font
       │                                                └── RhwpEditorSession: 표시만, 변경 unsupported
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
- **gitlink**: geul `external/wordcraft`를 `dc25d8a` → `6931bcc`로 올렸다(커밋 `fa2228d`). 이 SHA는 원격에 없다(로컬 전용,
  push 금지 정책 유지). RHWP는 변경·패치 추가 없음(`1a76570e`, Release generation `1b09639e…` 그대로).

## 2. fontconfig 제공자와 플랫폼 경계

- `src-tauri/src/fonts/fontconfig.rs`가 geul에서 유일하게 `unsafe`를 쓰는 모듈이다. fontconfig C API를 `libloading =0.7.4`(이미
  Tauri Linux 트리에 잠긴 판, 새 crate 없음)로 **실행 시** 적재한다. 라이브러리는 플랫폼 파일 이름(`libfontconfig.so.1`,
  `libfontconfig-1.dll`, `libfontconfig.1.dylib` 등)으로만 찾고 경로는 플랫폼 로더가 정한다. 모든 fontconfig 객체는 한 함수 안에서
  만들고 버리며 한 mutex로 직렬화한다. 읽는 문자열·개수는 상한이 있다(얼굴 10만, 값 64, 문자열 4 KiB).
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

- 구현: 선택 시작 글자의 저장 글꼴 표시(`getCharPropertiesAt`의 한글 슬롯, 한글 워드프로세서의 대표 글꼴), 등록 사용자 글꼴의
  WebView 전달, 글꼴 변경 시 모든 쪽 Canvas 다시 그리기(`fontsChanged`).
- **미구현 — 글꼴 변경**: 레지스트리 `format.font`는 RHWP `unsupported`이며 실행하면 "이 문서 형식에서는 지원하지 않습니다"로 거부하고
  문서를 바꾸지 않는다. 이유: HWP 저장 증명 `derived_char_shape`(`services/save/hwp.rs`)는 덧붙인 글자 모양의 글꼴 ID 바이트
  `[0..14)`가 원본과 같아야 하고, 새 `FACE_NAME` 레코드도 허용하지 않는다. HWPX 헤더 덧붙임 규칙(`services/save/special.rs`)도
  `hh:fontRef` 변경·`hh:fontface` 추가 규칙이 없다. 편집을 허용하면 저장이 거부되거나 서식을 잃으므로 실행 전에 거부한다.
  필요한 후속: (1) 문서 글꼴 표 읽기 API, (2) 기존 글꼴 ID로의 변경만 받는 HWP/HWPX 증명 확장과 회귀, (3) 새 글꼴 이름 추가의
  DocInfo/header 보존 규칙. 이들은 T009 저장 안전 계약 변경이라 별도 작업으로 남긴다.
- 레이아웃 메트릭: RHWP는 내장 메트릭 DB를 쓰며, DB에 없는 글꼴의 라틴 글자는 추정 폭이다(이미 있는 Canvas 보조 메트릭 경로는
  geul이 쓰는 `getPageLayerTreeWithProfile`와 함께 켤 수 없음). 따라서 RHWP에서 WebView 글꼴이 바뀌어도 배치는 바뀌지 않을 수
  있다(그리기만 바뀜). RHWP PDF는 화면과 같은 Canvas 쪽 그림이다.

## 6. 검증 (2026-11-15, NixOS 26.05, Linux 7.2.14, fontconfig 2.18.3, WebKitGTK 2.54.1)

### CURRENT PASS (새로 실행)

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

## 7. 알려진 제한

1. HWP/HWPX 글꼴 변경 불가(5절).
2. Linux 외 플랫폼: 글꼴 추가 대화상자 없음, fontconfig 동작 미검증.
3. 사용자 글꼴은 WebView에 컬렉션 첫 얼굴만 전달.
4. 가변 글꼴은 명명 인스턴스 단위로만 다룬다(WordCraft 기존 동작).
5. 사용자·시스템 글꼴은 배포물에 넣지 않는다. 번들은 WordCraft OFL 4계열뿐(기존 고지 범위).
