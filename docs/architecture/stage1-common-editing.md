# Stage 1 공통 문서 편집 — 2026-11-16

기준 HEAD `3fbd793`, 엔진 pin 불변(RHWP `1a76570e`, WordCraft `6931bcc`, 패치·WASM generation 변경 없음: Release generation `5dc43856…`).
Stage 1 전체 범위 중 아래 표의 **지원** 항목만 제품 일반 빌드에서 활성화했다. 나머지는 레지스트리에서 `unsupported`이며 실행되지 않는다.
이 문서는 Stage 1 구현·활성화·focused 검증 기록이며 T014/T015/T016 수용, native GUI 수용, 외부 Office/한컴 호환을 뜻하지 않는다.

## 1. 형식별 지원 범위

| 기능군 | DOCX (WordCraft) | HWPX (RHWP) | HWP (RHWP) |
|---|---|---|---|
| 문단 정렬(왼쪽·가운데·오른쪽·양쪽) | 지원: 선택 문단, 표 셀 포함 | 지원: 본문 문단(셀 제외) | 지원: 본문 문단(셀 제외), 구조 원본 증명 필요 |
| 글자 크기·글자 색·형광펜·위/아래 첨자 | 지원: 선택 또는 커서(엔진의 다음 입력 서식) | 지원: 선택 글자(본문·셀), 커서만은 불가 | 지원: HWPX와 같음 + HWP 원본 증명 |
| 줄 간격·왼/오른 여백·첫 줄/내어쓰기·문단 위/아래 간격 | 지원(한 `para.set` = 한 실행 취소 단계) | 지원: 본문 문단 | 지원: 본문 문단 |
| 번호·다단계·사용자 글머리·수준 올림/내림·번호 새로 시작/이어 매기기·Enter 계속/종료 | 지원: 본문·표 셀 문단 | **미지원**(기존 글머리표만) | **미지원**(기존 글머리표만) |
| 찾기·다음/이전·개수/현재 위치·대소문자·온전한 낱말·바꾸기·모두 바꾸기 | 지원: 본문 이야기(표 셀 포함) | 지원: 본문 문단·1단계 표 셀 | 지원: HWPX와 같음 |
| 여백·가로/세로·용지 크기 | 지원: 선택 구역 | 지원: 커서 구역 | 지원: 커서 구역 |
| 다단 | 지원: 선택 구역(같은 너비 단) | **미지원** | **미지원** |
| 글꼴 embedding | **미구현** | **미구현** | **미구현** |

## 2. 구현 요약

### 공통 명령 계층

- 레지스트리(`src/commands/registry.ts`): 기존 리본 ID `paragraph.align*`, `layout.margins|orientation|size|columns`를 문서 명령으로 연결하고
  `format.fontSize|fontColor|highlight|superscript|subscript`, `paragraph.settings|numbering|multilevel|listStyle|increaseIndent|decreaseIndent|restartNumbering|continueNumbering`,
  `edit.find`(Mod+F)·`edit.replace`(Mod+H)를 더했다. 정렬 단축키 Mod+L/E/R/J. 엔진별 선언은 위 표와 같다(`RHWP_STAGE1_*`).
- 값과 검증: `src/commands/stage1.ts`(화면·세션 공통 `validStage1Args`, 검색 글자 검사). 값 입력 명령은 세션이 지금 선택으로 문맥을 낼 때만 가용하다(capability 기존 규칙).
- 화면: 리본 값 선택기(`ValuePicker`: 글자 크기·색·형광펜·목록 모양·방향·용지·단), 문단/여백 대화상자(`Stage1Dialog`, mm/pt 입력), 비모달 찾기 막대(`FindBar`).
  표시 값은 엔진 상태이며 여러 값이 섞이면 비운다(지어내지 않음).

### DOCX

- `src-tauri/src/adapters/wordcraft/stage1.rs`: 고정 `DocxOp` → 고정 WordCraft 명령(`para.align`·`format.size|color|highlight|superscript|subscript`·`para.set`·`para.numbering|multilevel|bullets`·`para.indent|outdent`·`para.restartNumbering`·`layout.margins|orientation|size|columns`·`edit.advancedFind|replace|replaceAll`).
  임의 명령 ID는 열지 않는다. 길이는 twip(1/20 pt)으로 맞춰 편집 모델과 저장본 재열기 모델이 같다(맞추지 않으면 A5 등에서 `ReopenMismatch`).
- 찾기는 WordCraft 모델 검색(문자 그대로: 와일드카드·특수 코드·정규식 끔). 바꾸기는 선택이 **지금도** 같은 질의의 일치일 때만 하고(낡은 결과 거부), 모두 바꾸기는 엔진 명령 하나(실행 취소 한 단계). 섞인 서식 범위의 바꾼 글자는 일치 첫 글자의 서식을 받는다(WordCraft 규칙).
- 저장(T009): `word/document.xml` 변경은 기존 재열기 비교. `word/numbering.xml`은 원본 정의가 모두 그대로이고, 새 `abstractNum`은 엔진 기본 목록 종류(`levels_for`)의 직렬화와 정확히 같고 어떤 `num`이 쓰며, 새 `num`은 있는 `abstractNum`을 가리키는 기본/재시작(start override) 직렬화와 같을 때만 받는다(`package.rs` `numbering_appended`).

### HWP/HWPX (RHWP)

- 글자 값: 기존 선택 서식 경로(`applyCharFormat*`, 문단마다 한 호출, 한 history 단계, compaction·게시 prefix)를 재사용. 상태는 선택 전체가 한 글자 모양일 때만 값으로, 아니면 섞임.
  HWP에는 "자동" 글자 색이 없어 검정으로, 형광펜 끄기는 흰 음영(엔진 API가 RGB만 받음)으로 저장한다(남은 제한).
- 문단: `applyParaFormat`(글머리표와 같은 자격·범위: 본문, 구조 원본 증명, IME·대기 없음). 단위는 엔진 배치가 읽는 값(여백·들여쓰기·고정/최소 줄 간격 2배 HWPUNIT, 문단 간격 1배, 배수는 %).
- 쪽: `setPageDef`(커서 구역; 머리말/꼬리말 거리 등 그 밖 속성 불변; 본문이 0.5 inch 미만이 되는 여백 거부).
- 찾기/바꾸기: 엔진 모델 검색 `searchAllText` 결과 중 본문과 표로 확인된 1단계 셀만(수식·글상자·중첩 셀 제외). 각 결과를 모델에서 다시 읽어 질의와 같고 지울 수 있는 일반 글자인지 확인한다. 위치는 code point라 surrogate pair를 나누지 않는다. 바꾸기는 기존 글자 편집 경로(같은 T009 규칙), 모두 바꾸기는 한 mutation·한 history 단계.
- 저장 증명 확장:
  - HWP `derived_char_shape`: 기본 크기(1–4096 pt)·글자 색·음영 색·위/아래 첨자(동시 불가) 추가 허용. 밑줄/그림자 색·글꼴·상대 크기 등은 그대로 원본 소유.
  - HWPX `charPr` 덧붙임: `height`·`textColor`·`shadeColor`(직렬화기 형식)와 `supscript`/`subscript` 하나.
  - HWP `ParaShape` 덧붙임(`insertions.rs` `para_signature`): 정렬·줄 간격 종류/값·여백·들여쓰기·문단 간격(범위 검사) 추가 허용. RHWP에 문단 모양 정리(compaction)가 없어 반복 편집 뒤 쓰이지 않는 파생 정의가 남을 수 있어 덧붙인 문단 모양의 참조 요구를 뺐다(HWPX 규칙과 같음; 테두리·글머리·그림은 참조 요구 유지).
  - HWPX `paraPr` 덧붙임: `align/@horizontal`, `lineSpacing` type/value, `hc:intent|left|right|prev|next` 값(직렬화기 형식).
  - 이 확장 때문에 금지 속성으로 `height`/정렬을 쓰던 기존 음성 시험 3건은 여전히 금지인 `useKerning`/keep-with-next로 바꿨다(시험을 약하게 하지 않음).

## 3. 검증

| 분류 | 명령(작업 디렉터리: 저장소 루트) | 결과 |
|---|---|---|
| CURRENT PASS | `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib stage1_docx` | 8/8 (정렬·글자·문단·목록·번호 증명 음성·쪽·찾기/바꾸기·잘못된 값; 제품 IPC `docx::edit` → 실행 취소/다시 실행 → T009 사전 검사·게시 → 독립 재열기) |
| CURRENT PASS | `… cargo-geul.py test --lib -- general_flags_preserve special:: hwpx_header stage1_` | 16/16 (HWP·HWPX 글자 모양 증명 양성/음성 포함) |
| CURRENT PASS | `… cargo-geul.py test --lib -- hwp_contract_mutations_cannot` | 1/1 |
| CURRENT PASS | `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage1-format.wasm.test.ts` (실제 Release WASM, RHWP 세션 경로) | 8/8 generate (HWP·HWPX × 글자/찾기·바꾸기/문단/쪽) |
| CURRENT PASS | `GEUL_FORMAT_DIR=$PWD/src-tauri/target/stage1-format GEUL_FORMAT_EXPECTED_CASES=10 … cargo-geul.py test --lib general_formatting_real_publication -- --ignored` | 10 case 실제 게시(durable, 손상 출력 거부 시 원본 유지, HWP 미리보기 재생성) |
| CURRENT PASS | `GEUL_FORMAT_PHASE=verify GEUL_FORMAT_EXPECTED_CASES=10 npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage1-format.wasm.test.ts` | 게시 바이트 재열기 모델 = 편집 모델 |
| CURRENT PASS | `npx vitest run src/components/Editor/stage1.test.tsx` | 9/9 (보기 파싱, DOCX 세션 가용성·연산, 값 검증, 대화상자, 리본 선택기, 찾기 막대) |
| CURRENT PASS | 전체 `npx vitest run` | 1557 PASS / 3 FAIL — 3건 모두 변경 전 기준(`git stash`)에서도 실패(`hangulTools` 수식 1, `hwpReopenModel` 2) |
| CURRENT PASS | Rust 영향 회귀 필터(`numbering bullet core_ package:: adapters::wordcraft docx_`, `hwp hwpx bullet insertion core_`) | 실패는 기준에서도 실패하는 4건뿐(PDF 시험 3: `SaveUnsupported{SharedDirectory}` 환경, `hwp_편집한_저장은…` 1) |
| CURRENT PASS | `npx tsc --noEmit`, 변경 파일 `npx eslint` | PASS |
| NOT RUN | Tauri native GUI(실제 창·리본 조작·IBus) | 이 작업에서 실행하지 않음. RHWP는 실제 WASM 세션, DOCX는 제품 IPC 함수로 검증 |
| NOT RUN | Word/한컴 외부 호환 | T015/T016 범위 |

증거 산출물(무시 경로, 커밋하지 않음): `src-tauri/target/stage1-format/`(case별 original/edited/published·proof·publication.json).
기존 general-formatting 회귀는 별도 출력 `src-tauri/target/stage1-regression-gf/`에서 실행했다(역사 증거 디렉터리 덮어쓰지 않음; `typing retains…` 1건은 기준에서도 실패).

## 4. 남은 일과 차단 요인

- RHWP 번호/다단계 목록: 엔진에 `createNumbering`·`applyParaFormat{headType:"Number"}`가 있으나 HWP `NUMBERING` 레코드·HWPX `hh:numbering` 덧붙임 저장 증명과 번호 이어짐/재시작 의미 검증이 없다. 증명 없이 활성화하지 않았다.
- RHWP 문단 서식의 표 셀 문맥(`applyParaFormatInCell`)과 다단(`setColumnDef`): 미연결(증명·검증 미수행).
- RHWP 커서만 있는 글자 서식(다음 입력 서식): 기존 제한 유지. 엔진에 커서 서식 상태가 없어 지금 증명할 방법이 없다.
- 글꼴 embedding(세 형식 모두 미구현): WordCraft는 기존 내장 글꼴을 왕복 보존만 하고 새로 만들지 않는다. DOCX는 OS/2 `fsType` 허가 검사, `.odttf` 난독화·`w:fontKey`, `fontTable.xml`·관계·내용 형식·`w:embedTrueTypeFonts` 변경과 그 T009 규칙이 모두 새로 필요하다. RHWP는 `BinDataType::Embedding` 모델만 있고 생성 API가 없으며 HWP/HWPX 내장 글꼴의 호환 근거가 없다. 로컬 설치·선택·대체와 문서 embedding은 다른 기능이며, 이 빌드는 어떤 문서에도 글꼴을 embed한다고 주장하지 않는다.
- native GUI 수용, 외부 Office/한컴 호환: 미실행.

---

## 5. 2·3차 갱신 — P1 안정화와 글꼴 embedding (2026-11-17)

기준: 2차 `a63addc`·`5bd84cf`(2026-11-16, 이 문서에 기록되지 않았던 RHWP 목록·셀 문단·다단·커서 서식), 3차 시작 HEAD `5bd84cf`, 3차 커밋
`dc6bd68`·`9ed2e79`·`8cd1c06`(P1)·`79e208c`·`4f451ad`·`93de8af`(F). 엔진 pin 불변(RHWP `1a76570e`, WordCraft `6931bcc`). 관리 패치
`patches/rhwp/stage1-p1-fonts.patch` 추가(22개), Release generation `a3e4cf731dd9abb9ecc777392bb0fd8876f73a6f33916ef79ecdc993b841ac87`
(외부 소스 불변 `externalUnchanged: true`). 보존 한도 때문에 선택되지 않은 세대 `2745ff…`·`3622d8…`는 지우지 않고 `target/rhwp-retired-generations/`로 옮겼다.
위 1–4절은 1차 당시 기록이며 아래 표가 현재 상태다.

### 5.1 현재 형식별 지원

| 기능군 | DOCX | HWPX | HWP |
|---|---|---|---|
| 번호·다단계·사용자 글머리·수준·새로 시작/이어 매기기·Enter | 지원 | 지원(본문·표 셀; 새로 시작은 geul 템플릿과 정확히 같은 정의만) | HWPX와 같음 + HWP 원본 증명 |
| 셀 문단 서식(중첩 셀 경로 포함) | 지원 | 지원 | 지원 |
| 다단 | 지원 | 지원(이미 ColumnDef가 있는 구역) | 지원(같음) |
| 커서만 있는 글자 서식(다음 입력) | 지원(엔진) | 지원(세션 상태, 아래 P1-A) | 지원 |
| 글자+목록 변경을 한 번에 저장 | 지원 | **지원(P1-C)** | **지원(P1-C 부수 수정)** |
| 글꼴 embedding | **지원(P1/F)** | **지원** | **형식 제한(미지원)** |

### 5.2 P1 수정

- **P1-A 다음 입력 서식.** 원인: `pendingChars`가 입력한 자리 키를 64개까지 `Set`에 쌓았다. 실측 재현(변경 전 코드, 같은 시험): 80자 연속 입력은
  엔진의 앞 글자 모양 상속 때문에 겉보기에는 이어졌지만, 커서를 앞 자리로 옮겼다 돌아오면 남아 있던 옛 키에서 서식이 다시 적용됐다
  (`expected 3000 to be 1000`). 수정: 상태를 삽입점 하나(`at`)와 열린 IME의 시작점(`origin`)만으로 바꿨다. 입력·붙여넣기·IME 갱신/확정은 `at`을
  삽입 끝으로 옮기고, 문단 나누기(Enter·여러 줄 붙여넣기)는 새 문단 시작으로 옮긴다. 커서 이동·선택·관계없는 변경·실패한 변경·Undo/Redo·
  다시 열기·문서 전환은 상태를 지운다. 문서에 임시 글자를 만들지 않는다.
- **P1-B 번호.** 원인: 세션의 `numberingStyles` 캐시(문서 모델과 동기화 안 됨)와 multilevel 여부만 비교한 재사용. 엔진 `getNumberingList`가 수준별
  번호 형식 코드를 내지 않아 십진·영문·로마 숫자를 구별할 수 없었다. 수정: 패치가 `numberFormats`를 보고하고, 세션은 캐시 없이 지금 모델의
  정의를 (수준 형식 문자열, 형식 코드, 시작 번호)가 템플릿과 정확히 같을 때만 그 스타일로 본다(epoch·generation·modelVersion마다 다시 읽음).
  재사용·이어 매기기는 정확히 같은 스타일끼리만, 이어 매기기는 다른 스타일 목록을 건너뛰고 스타일을 모르면 거부한다. Undo로 사라진 정의 ID를
  다시 쓰지 않는다. 새로 시작은 다시 연 문서에서도 템플릿과 같은 정의면 가능하다(그 밖의 기존 정의는 기존 제한 유지·거부).
- **P1-C HWPX 결합 저장.** 원인: header 비교가 글자/글꼴 덧붙임 규칙(`header_equal_or_appended`)과 문단·목록 덧붙임 규칙(`hwpx_bullets_appended`)
  중 하나만 받았다(각각 나머지 전부 같아야 함). 수정 `hwpx_combined_appended`: 출력 header에 원본의 `hh:fontfaces`·`hh:charProperties`만 끼운 중간
  header로 두 기존 증명을 각각 적용한다(원본→중간: 문단·목록 덧붙임만, 중간→출력: 글자·글꼴 덧붙임만). header 비교를 끄거나 header 전체를
  면제하지 않는다. 같은 원인이 HWP에도 있었다(글자 모양 증명이 덧붙인 NUMBERING 레코드를 빼지 않음) — 함께 고쳤다.
- **P1-D 중첩 셀·HWP 번호 증명.** 중첩 셀 문단의 정확한 경로·정렬·여백·들여쓰기·줄/문단 간격·목록 상태를 경로 API로 읽어 편집 모델 = 재열기 내보내기 =
  **서비스 게시 바이트 재열기**를 비교하고, 바깥 셀·이웃 셀이 그대로임을 확인한다. HWP 번호 덧붙임 계약을 "의미 구조 증명"(허용 형식 코드·자리표시
  문자열·시작 1·수준 시작 1, 바이트 템플릿 일치 아님)으로 명시했고, 덧붙인 번호 문단 모양은 1..=정의 수를 가리켜야 한다. 이 규칙의 음성 시험
  (번호 ID 0)은 변경 전에도 `ReferenceInvalid`로 거부됐다 — 실제 구멍은 없었고 규칙을 명시적으로 만든 것이다.

### 5.3 글꼴 embedding (F)

| | DOCX | HWPX | HWP |
|---|---|---|---|
| 형식 근거 | ECMA-376 Part 1 17.8.3 `w:embedRegular|Bold|Italic|BoldItalic`(`r:id`·`w:fontKey`), 17.8.1 난독화(.odttf) | OWPML(KS X 6101) `hh:font@isEmbedded`·`@binaryItemIDRef` → `content.hpf` BinData 항목 | 「한글문서파일형식 5.0 rev1.3」 표 17–20: FACE_NAME에 바이너리 참조·embed 속성이 없고 BIN_DATA EMBEDDING은 그림/OLE용. **형식에 표현이 없음** |
| 엔진 | WordCraft는 보존만 → geul 어댑터가 모델(`passthrough` 글꼴 표 트리, 정규 manifest)에 추가, 쓰기/재열기 동등성 확인 후 교체 | RHWP는 파싱·렌더·직렬화 지원, 생성 API 없음 → 패치 `embedFont`/`getEmbeddedFonts` | 엔진 API가 HWP 원본을 거부 |
| 자원 | `word/fonts/fontN.odttf`(obfuscatedFont), 글꼴 표 관계(font), 필요하면 새 `fontTable.xml` + 문서 관계 | `BinData/imageN.ttf`(manifest `isEmbeded="1"`), 그 이름의 7개 언어 `hh:font` 모두 참조 | — |
| 중복·보존 | 내용 키(GUID)로 같은 글꼴 재embed는 무변경, 같은 슬롯의 다른 글꼴은 거부(기존 보존) | 이미 embed된 face·같은 바이트는 재사용 | — |
| T009 | `docx_fonts`: 글꼴 표=원본+덧붙인 embed만, 관계·내용 형식·문서 관계 정확히, 프로그램을 복원해 권한·윤곽·가족 이름 확인 | `hwpx_fonts`: manifest=원본+글꼴 항목만, 참조 없는 바이너리 거부, 프로그램 권한·가족, 참조를 비-embed로 되돌린 header가 기존 header 규칙 통과 | — |

- **권한(OS/2 fsType)**: 설치 가능(0)·편집 가능(0x8)만 embed. 제한(0x2), 미리 보기·인쇄(0x4: 편집기 문서에 넣으면 읽기 전용을 강제할 수 없음),
  비트맵 전용(0x200), 사용 비트 둘 이상·예약 비트(잘못된 권한)는 거부. 하위 집합 금지(0x100)는 전체 글꼴을 넣으므로 지킨다. fsType은 기계가 읽는
  권한일 뿐 실제 라이선스를 대신하지 않으므로 대화상자가 `name` 13(라이선스 설명)을 보여 주고 사용자가 고른다. 권한 메타데이터는 바꾸지 않는다.
  같은 검사를 백엔드(바이트 제공 전)·RHWP 엔진(저장 전)·T009(게시 전)에서 각각 한다.
- **원본 형식**: 출력은 단일 face TrueType 윤곽 sfnt. TTF는 그대로, WOFF/WOFF2 사용자 글꼴은 등록 때 WordCraft 디코더가 풀어 저장한 sfnt를 쓴다
  (사용자 파일 불변). CFF/CFF2(OTTO), 모음(TTC/OTC), 가변 글꼴은 이유와 함께 거부. 새 의존성 없음(난독화 키는 `sha2`).
- **제품**: 리본 홈/글꼴 "글꼴 포함" → 대화상자(카탈로그의 가족·스타일, 권한·라이선스·형식별 판정) → `executeEmbedFont`. 성공 알림은 모델 변경이 확인된
  뒤에만(DOCX: 편집 응답의 엔진 보기, HWPX: 엔진 결과 + 다시 읽기). 모든 글꼴을 자동 embed하지 않는다. 일반 빌드 활성(시험 플래그 없음).
- **남은 제한**: HWP 형식 제한. DOCX는 4개 스타일 슬롯만, `w:embedTrueTypeFonts` 설정은 바꾸지 않음(읽기에는 불필요), 하위 집합 없음. HWPX는 문서가
  쓰는 face만, BinData ID가 연속인 문서만(아니면 거부). embed 해제·교체 없음(게시된 embed를 Undo로 지운 뒤의 저장은 T009가 거부). 같은 저장에서
  그림 삽입과 결합하면 거부(조합 미증명). Word/한컴 실제 재열기 NOT RUN.

### 5.4 검증 (3차)

| 분류 | 명령(저장소 루트) | 결과 |
|---|---|---|
| CURRENT PASS | `GEUL_FORMAT_OUT=$PWD/src-tauri/target/stage1-p1f2 npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage1-format.wasm.test.ts` | 27/27(26 case; P1-A×2, P1-B×4, P1-C×2, 중첩 셀×2, F HWPX×2 포함), generation `a3e4cf73` |
| CURRENT PASS | `GEUL_FORMAT_DIR=$PWD/src-tauri/target/stage1-p1f2 GEUL_FORMAT_EXPECTED_CASES=26 GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib -- stage1_ combined_hwpx_proof general_formatting_real_publication --include-ignored` | 16/16: 26 case 실제 게시(durable), HWPX/HWP 결합·HWPX embed 게시, 결합 음성 10, HWP 목록/번호 음성(새 4건 포함), DOCX embed 2 |
| CURRENT PASS | `GEUL_FORMAT_PHASE=verify GEUL_FORMAT_EXPECTED_CASES=26 …stage1-format.wasm.test.ts` | 게시 바이트 재열기 = 편집 모델(중첩 셀 정확 비교·embed 글꼴 포함) |
| CURRENT PASS | `… cargo-geul.py test --lib -- stage1_hwpx_font_embedding --include-ignored`, `-- stage1_docx_font fonts::embedding` | HWPX 음성 9, DOCX 양성(Undo/Redo·게시·독립 재열기·두 번째 저장의 기존 embed 바이트 동일)·음성 11, 권한/난독화 단위 4 |
| CURRENT PASS | 전체 `npx vitest run` | 1561 PASS / 3 FAIL(기준과 같은 `hangulTools` 1, `hwpReopenModel` 2), `stage1.test.tsx` 포함, `EmbedFontDialog.test.tsx` 4 |
| CURRENT PASS | `npx tsc --noEmit`, 변경 파일 eslint, `cargo-geul.py clippy --lib --bins -- -D warnings` | 새 경고 없음. clippy는 기준에도 있는 3건(`hwp.rs` 2, `special.rs` 1)만 |
| 재현(변경 전 FAIL) | P1-A 시험을 변경 전 세션으로 | 옛 키 재적용 FAIL; 결합 header는 단일 규칙 둘 다 거부(시험 안에 단언) |
| FAIL(기준부터) | `calc_cell_stale_previews…`, `calc_cell_two_durable_saves…` | `5bd84cf`에서도 같은 `OutputMalformed BodyText/Section0` — 이번 변경과 무관, 원인 미조사 |
| 수정(시험 기대값) | `special_header_full_findings_match_frozen_oracle`, `special_header_hash_collision…` | `5bd84cf`부터 FAIL. 2차가 허용한 덧붙인 `height`를 음성 근거로 쓰던 낡은 기대값 — 2차가 다른 3건에 했던 것처럼 여전히 금지인 `useKerning`으로 바꿔 거부 의도 유지 |
| REUSED PASS | 1차 DOCX Stage 1 8건, 2차 HWP/HWPX 음성 증명 | 같은 코드 경로가 이번 실행에 포함되었거나 변경 없음 |

증거(무시 경로): `src-tauri/target/stage1-p1f/`(v1 generation, 25 case), `src-tauri/target/stage1-p1f2/`(최종, 26 case).

### 5.5 Native GUI 수용 (3차, 2026-11-17)

`python3 scripts/tests/native-ibus-session.py --hangul-initial-mode hangul --out "$PWD/target/stage1-p1f-native/run4-session" -- python3 scripts/tests/native-stage1-p1f.py --app "$PWD/src-tauri/target/release/geul" --driver "$PWD/src-tauri/target/debug/tauri-driver" --xdotool @XDOTOOL@ --ibus @IBUS@ --fixtures "$PWD/target/stage1-p1f-native/fixtures" --docx "$PWD/src-tauri/target/font-native/fixtures/basic-ko.docx" --out "$PWD/target/stage1-p1f-native/run4"` — **PASS**
(일반 제품 빌드 `tauri-geul.py build --no-bundle`, 앱 SHA-256 `68512e9d8f0a17b7…`, Release generation `a3e4cf73`, HEAD `93de8af`; Xvfb·IBus·ibus-hangul·xdotool·tauri-driver).
- HWPX: 커서 위 첨자(리본) → xdotool 70자 → ibus-hangul `한글` → Enter → 번호(리본) → Ctrl+Z/Ctrl+Y → `item` → "글꼴 포함" 대화상자(NanumGothic, fsType 0x0008 편집 가능 표시) → Ctrl+S
  → 독립 oracle(새 엔진 재열기): 첫 문단의 새 72자 모두 위 첨자·기존 글자 불변, 둘째 문단 번호 목록, NanumGothic 7개 언어 embed(4,691,820 B); 닫고 다시 열어도 같음.
- HWP: "글꼴 포함" 비활성("이 문서 형식에서 지원하지 않음"), 원본 바이트 불변. DOCX: Inter 포함 → 저장 → 독립 ZIP 검사: `word/fontTable.xml` `embedRegular`, `word/fonts/font1.odttf`
  (obfuscatedFont), 키로 복원한 프로그램 = `Inter-Regular.ttf` 바이트 동일.
- 실행 이력: run1–run3 FAIL. run1/run2는 저장이 `SaveFailure`(export)였다 — 원인은 **기존 엔진 제한**: 한 문단 안에서 이전 글꼴 변경으로 run이 나뉜 HWPX
  (`hwpx-empty-text-boundaries.patch`의 빈 글자 provenance)에서는 그 문단에 글자 서식을 더하면(선택 서식도 같음, 다음 입력 서식·embedding과 무관) 내보내기가
  `character formatting changed run occurrence boundaries`로 거부된다. Release-WASM에서 재현·분리했고(같은 문서·선택 서식만으로 실패, run 없는 문서는 같은 순서 PASS),
  fixture를 그 조건이 없는 문단 배치로 바꿨다(`scripts/tests/stage1-p1f-native-fixture.mjs`). run3은 ibus-hangul 초기 Latin 모드(하네스 설정)로 FAIL.
- 실행하지 않은 native 범위: 붙여넣기·HWP 목록 저장·Word/한컴 재열기(NOT RUN; 붙여넣기는 Release-WASM으로 검증).

### 5.6 남은 일

- HWP 글꼴 embedding: 형식 제한(5.3). ~~기존 run 분할 HWPX 문단의 글자 서식 저장 거부(위): 엔진 provenance 규칙 개선이 필요(이번 범위 밖, 기존 제한).~~ → Stage 2 / Phase 0(아래 6절)에서 해결.
- `calc_cell_*` 2건 기준부터 FAIL(원인 미조사). RHWP 모두 바꾸기 500개 상한, 기존(템플릿이 아닌) 번호 정의의 새로 시작, ColumnDef 없는 구역의 다단 생성은 그대로다.
- Word·한컴 오피스 실제 재열기(DOCX embed 글꼴, HWPX embed 글꼴) NOT RUN.

## 6. Stage 2 / Phase 0 — HWPX 분할 run 글자 서식 및 안전 저장 안정화 (2026-11-17)

### 6.1 문제 재현 및 근본 원인

1차 native 수용(run1/run2)에서 분리한 `target/stage1-p1f-native/run1/docs/stage1.hwpx`(문단 0이 `<hp:secPr/><hp:colPr/>` + 0폭 `<hp:t/>` handoff run과 `NanumGothic` text run을 함께 보유)로 Release WASM `a3e4cf73…`에서 재현한 결과, 본문 `"Font"`(`doc.applyCharFormat(0, 0, 5, 10, '{"superscript":true}')`, IME·embed 없이 선택 서식만 적용) 뒤 `exportHwpxWithReport()`가 `"지원하지 않는 입력: HWPX empty-text provenance: character formatting changed run occurrence boundaries"`(`FORMAT_BOUNDARY`)로 실패함을 확인했다.

근본 원인은 두 곳이다.
1. **`HwpxTextTopology::format_edit`의 보수적 불변식(`src/model/hwpx_topology.rs`)**: `secPr`/`colPr` handoff 등 0폭 `<hp:t/>`가 있는 문단은 `HwpxTextTopology`를 포착하는데, 기존 `format_edit()`은 편집 후 `char_shapes.len() != old.len()`이거나 어떤 `start_pos`가 달라지면 무조건 `FORMAT_BOUNDARY`로 무효화했다. 정상적인 부분 서식 분할·인접 run 걸친 서식 병합·반복 서식 경계 변화까지 모두 거부됐다.
2. **문단 IR 글자 모양 0폭 occurrence 보존 누락(`src/model/paragraph.rs`)**:
   - `map_char_shape_range_ids`가 `last.start_pos == insert_start`일 때 직전 0폭 `CharShapeRef`의 `char_shape_id`를 덮어써 handoff 0폭 run의 모양 ID를 망가뜨릴 수 있었고,
   - 실행 취소/다시 실행의 `restore_char_shape_run_ids`가 `take_while(|r| r.start_pos < from)`로 `from` 위치의 0폭 run을 버려 `secPr` 0폭 occurrence가 사라졌다.

### 6.2 provenance 재조정 계약 (지원 vs 안전 거부)

관리 패치 `patches/rhwp/stage2-p0-hwpx-split-run.patch`(#23, `scripts/rhwp-patches.py`)는 위상 봉인(`seal_with`)이나 `format_edit()` 검사를 우회하지 않고, 편집 전후 char-shape occurrence와 원본 `SourceRun` 원자(`Text`, `EmptyText`, `Control`, `FieldEnd`) 사이의 결정적 source-aware 재조정(`reconcile_format_edit`)을 수행한다.

- **IR 0폭 occurrence 보존**: `HwpxTextTopology`가 존재하는 문단(`preserve_zero_width = true`)에서는 `try_map_char_shape_range_preserving` / `restore_char_shape_run_ids_preserving`이 `insert_start`/`from`의 0폭 entry를 덮어쓰거나 버리지 않는다.
- **지원(증명 가능한 변환)**:
  - 일반 글자 `SourceRun` 내부 부분 범위 분할(한 run → 여러 출력 run, 다중 분할, 중첩 표/표 셀 문단 포함)
  - 인접한 다중 `Text` run/경계에 걸친 선택 서식 및 반복 적용 + Undo/Redo(`restore()`)
  - `Text` 뒤·사이에 있는 0폭 `EmptyText` / bare `EmptyRun` occurrence의 원래 구조 위치·속성(`xml:space` 등)·run 속성 보존
  - 동일 문자 구간에 독립 배치된 컨트롤(`Text` 앞의 `secPr`/`colPr`/0폭 `EmptyText`, `Text` 앞뒤의 `FieldEnd` 등) 소유권·순서 불변
  - `autoNum` 등 1글자 점유 컨트롤 run이 온전히 하나의 출력 char-shape run 안에 포함되는 경우(`control_is_auto_num`)
  - 지원되는 글자 서식 + 목록/번호 결합 편집 및 T009 저장(`general_formatting_real_publication` + `hwpx_combined_appended`)
- **안전 거부(Fail-closed 유지)**:
  - `charStyleIDRef` 텍스트에 대한 직접 서식 (`FORMAT_STYLED`: `"character formatting of hp:t charStyleIDRef text is unsupported"`)
  - non-formatting 변경 혼합 또는 text/control 범위 불일치 (`FORMAT_SCOPE`: `"character formatting edit changed more than run character shapes"`, 누락/추가 char-shape 범위·텍스트와 겹치지 않는 비-autoNum 컨트롤 중간 분할·문자 수 불일치)
  - 선행 `STALE` 위상(직접 `char_shapes` 변조·구조 변경 후 서식 시도)
  - `restore()` 시 0폭 handoff 소실 또는 순서 역전 등 증명 불가 변화 (`FORMAT_BOUNDARY`)
  - 존재하지 않는 `charPrIDRef` (`HwpxHeader` 참조 검증)

### 6.3 산출물 및 검증 (2026-11-17)

- 패치·WASM: `patches/rhwp/stage2-p0-hwpx-split-run.patch` 추가(이전 22개 패치 불변), Release WASM generation `80024e5cbc5a859f7627cadb16838f3a80a5693be2bf44d791faa2a4ea13791b`(`externalUnchanged: true`; 구세대 `cfb26d65…`은 `target/rhwp-retired-generations/`로 보존 이동).
- 직렬화기·원래 실패 fixture 직접 확인: `target/stage1-p1f-native/run1/docs/stage1.hwpx` + `applyCharFormat(0, 0, 5, 10, '{"superscript":true}')`가 `80024e5c…`에서 7,407 B로 내보내기 성공(loss 0), 재열기 text/superscript 일치.

| 구분 | 실행 명령(요약) | 결과 |
|---|---|---|
| RHWP 단위(patched worktree) | `cargo test -p rhwp --lib` (`empty_text_` + `serializer::hwpx::` + `char_shape_compact` / `model::paragraph::` / `document_core::commands::formatting`) | 512 PASS / 60 PASS / 13 PASS (0 fail, `cargo check` 경고 0) |
| WASM 서식 + split-run 회귀 | `GEUL_FORMAT_OUT=src-tauri/target/stage2-p0-format npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage1-format.wasm.test.ts` | 28 passed, 1 skipped(verify 단계), 27 case 생성 (`hwpx-stage2p0-split-runs` 포함) |
| T009 실제 저장 게시 | `GEUL_FORMAT_DIR=src-tauri/target/stage2-p0-format GEUL_FORMAT_EXPECTED_CASES=27 GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib general_formatting_real_publication -- --ignored` | 1 passed, 0 failed (27 case 실제 게시) |
| 게시 바이트 독립 재열기 | `GEUL_FORMAT_PHASE=verify GEUL_FORMAT_OUT=src-tauri/target/stage2-p0-format GEUL_FORMAT_EXPECTED_CASES=27 npx vitest run … stage1-format.wasm.test.ts` | 1 passed, 28 skipped (27 case 재열기 모델 일치) |
| HWPX empty-text 코퍼스·편집·음성 | `python3 scripts/tests/hwpx-empty-text-roundtrip.py` (WASMDIST `80024e5c…`, `split-format` 양성 전환, `unsupported-format-styled` 음성 유지) + `save_check` | 19 positive + 12 editing PASS |
| Rust 저장·header 보존 회귀 | `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib -- special:: hwpx_header stage1_` | 17 passed, 0 failed, 5 ignored |
| 프런트엔드·UI 단위 | `npx tsc --noEmit && npx eslint scripts/tests/stage1-format.wasm.test.ts && npx vitest run src/components/Editor/stage1.test.tsx` | PASS (`stage1.test.tsx` 9/9) |
| 일반 제품 Release 빌드 | `GEUL_SANDBOX=userns-root-bwrap python3 scripts/tauri-geul.py build --no-bundle` | PASS (`geul` SHA-256 `fb3674d3…`, privacy/runtimePath PASS) |
| Linux native GUI 수용 | `scripts/tests/native-ibus-session.py` + `scripts/tests/native-stage2-p0.py` → `target/stage2-p0-native/run2/result.json` | PASS (`visualChangeConfirmed: true`, `save.state: "saved"`, `reopenUiSuperscriptPressed: "true"`, 독립 oracle에서 본문 `secPr`-handoff·다중 run·표 셀 서식 및 무관 run/이웃 셀 보존) |

미검증/제외 범위: 한컴오피스/Word 외부 프로그램 재열기(NOT RUN), Windows/macOS(DEFERRED).

## 7. Stage 2 / Phase 1 — DOCX 표 구조 편집 (2026-11-17)

### 7.1 엔진·어댑터·UI 통합

- **WordCraft 엔진(`23c0dc52d5cf7d197d06c0b539547b9cce364b49`, 패치 `patches/wordcraft/docx-table-structure.{patch,commit}`)**:
  - `table.mergeCells`, `table.mergeRight`, `table.mergeBelow`, `table.splitCell` 명령을 WordCraft 엔진 표 명령에 등록하고 `crates/doc/src/table.rs`에 `quantize_twips`, `sync_cell_widths`, `is_grid_consistent`, `cell_extent`, `logical_rect_valid`, `rect_has_controls`, `delete_row_safe`(`vMerge` 승격·내용 보존), `merge_rect`(행 우선 내용 보존·부분 병합/컨트롤 거부·중첩 표 뒤 ECMA-376 빈 문단 보장), `split_merged_cell`을 구현했다.
  - `insert_row`의 `vMerge` 상속 불변식, `Table::new`/`insert_col`/`delete_col`/`split_cell`의 twip 너비 양자화(OOXML 왕복 일치), `fix_caret`의 숨김 `VMerge::Continue` 회피 및 `column`/`widened` 정리를 수정했고, `DocxModel::view()`가 `table_mouse::cell_rects`로 다중 셀 선택 사각형을 노출하도록 연결했다.
  - 재현 검증: `scripts/prepare-wordcraft.py`가 공개 `BASE`(`dc25d8a…`) → `6931bcc…`(`system-font-source`) → `23c0dc5…`(`docx-table-structure`) 순서로 결정적 재구성을 수행한다(`scripts/tests/test_wordcraft_reproduction.py`).
- **geul 어댑터·UI**:
  - `src-tauri/src/adapters/wordcraft/{table.rs, engine.rs}`: `DocxOp::TableStructure`와 `DocxTableView`를 추가하고, 낡은 `SelectionIdentity` 거부·어댑터/UI 일관 거절(`tableShape`/`tableContent`/`limit`)·`atomic()` + `is_grid_consistent()` + `retain_used_media`(이미지 포함 행·열 삭제 시 고아 `doc.media`로 인한 `roundtrip_equivalent` 실패 방지, Undo는 사전 스냅샷 복원) + `same_as()` 검증을 적용했다.
  - `src/commands/registry.ts`, `src/ribbon/{definitions.ts, visibility.ts}`, `src/components/Ribbon/Ribbon.tsx`, `src/adapters/docx.ts`, `src/components/Editor/wordcraft/DocxEditorSession.ts`: 10개 `table.*` 명령을 `wordcraft: SUPPORTED`로 활성화하고 DOCX `ribbon.tab.layout`에서 `TABLE_STRUCTURE_GROUP`을 노출했다(RHWP 미수정).

### 7.2 검증 결과 및 미검증 범위

| 구분 | 실행 명령(요약) | 결과 |
|---|---|---|
| WordCraft 표 단위 | `cargo test --manifest-path external/wordcraft/Cargo.toml --offline --locked -p wordcraft-doc -- table` / `-p wordcraft-engine -- table` | `wordcraft-doc` 10 PASS (0 fail, 144 filtered) / `wordcraft-engine` 51 PASS + `toc_roundtrip` 1 PASS (0 fail) |
| geul Rust 어댑터·저장 회귀 | `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib -- adapters::wordcraft::tests::stage2_p1_ adapters::wordcraft::tests::core_table adapters::wordcraft::tests::protected_ services::save::tests::docx` | 36 passed, 0 failed, 1 pre-existing ignored (`stage2_p1_*` 2건 포함, T009 실제 게시·독립 재열기·중첩 표·SDT·이미지 행/열 삭제·Undo/Redo) |
| geul `clippy`·프런트엔드 검증 | `cargo-geul.py clippy --lib`, `npx eslint ...`, `npx tsc --noEmit`, `npx vitest run ...` (7파일) | `wordcraft` 어댑터 clippy 경고 0(기존 `save/{hwp.rs,special.rs}` 경고 3건은 `-D warnings` 외 pre-existing), ESLint·`tsc` PASS, Vitest 7파일 136 passed (0 failed) |
| 일반 제품 Release 빌드 | `GEUL_SANDBOX=userns-root-bwrap python3 scripts/tauri-geul.py build --no-bundle` | PASS (`src-tauri/target/release/geul` SHA-256 `665ead58…`, `privacyStatus: PASS`, `runtimePathStatus: PASS`) |
| Linux native GUI 수용 | `scripts/tests/native-ibus-session.py --hangul-initial-mode hangul --hangul-disable-latin ... scripts/tests/native-docx-table-stage2-p1.py` → `target/stage2-p1-native/run/result.json` | PASS (`status: "PASS"`, 10개 버튼 표 밖 disabled·표 안 enabled, 행/열 삽입·삭제·Undo/Redo·`mergeRight`/`mergeBelow`/`mergeCells`/`splitCell`, `ibus-hangul` 한글 입력, `Ctrl+S` 저장 `state: "saved"`, 닫기/앱 재열기 `rows: 3, cols: 2`, Python XML 독립 검사 PASS) |

미검증/제외 범위: Microsoft Word 등 외부 오피스 프로그램 재열기(NOT RUN), Windows/macOS·Wayland(DEFERRED), `sudo-bwrap` 및 전체 `test_wordcraft_reproduction.py` 네트워크 clone(`REMOTE` fetch 환경 분리), RHWP 표 명령/실행 범위 변경 없음.
