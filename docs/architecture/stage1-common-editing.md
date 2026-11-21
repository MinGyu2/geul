# Stage 1 공통 문서 편집 — 2026-11-16

기준 HEAD `3fbd793`, 엔진 pin 불변(RHWP `1a76570e`, WordCraft `6931bcc`, 패치·WASM generation 변경 없음: Release generation `5dc43856…`).
Stage 1 전체 범위 중 아래 표의 **지원** 항목만 제품 일반 빌드에서 활성화했다. 나머지는 레지스트리에서 `unsupported`이며 실행되지 않는다.
이 문서는 Stage 1 구현·활성화·focused 검증 기록이며 T014/T015/T016 수용, native GUI 수용, 외부 Office/한컴 호환을 뜻하지 않는다.

> **현행 상태 안내:** 1절 표와 4절 제한은 2026-11-16 당시 기록이다. RHWP 다음 입력 서식은 2026-11-17의 5.1절에서 지원으로 바뀌었고, collapsed caret에서 포커스 복귀 후 서식이 사라지던 회귀는 2026-11-21의 11절에서 수정·검증했다. 최신 상태는 해당 갱신 절을 따른다.

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

### 7.3 최종 안정화 — 1×1 셀 분할 UI, `vMerge` 내용 보존, 표 이미지 삭제 T009 저장, 소스 빌드 재현성 (2026-11-17)

- **WordCraft 엔진(`dd14a0ae29d90a05a54918db641d97f952260882`, 패치 체인 `system-font-source` → `docx-table-structure` → `docx-table-stabilization`)**:
  - Group A(`1×1` 비병합 셀 분할): `Table::unmerged_split_limits`·`Table::split_cell_grid(r, c, rows, columns)`와 `split_merged_cmd` 확장을 추가해, 병합 셀 무인자 복원(`{}`)은 그대로 두고 비병합 `1×1` 셀은 `rows × columns >= 2`, `1..=16`, 최소 열 너비 `6.0pt`(120 twips) 및 `MAX_ROWS`/`MAX_COLS`/SDT 컨트롤 제약을 만족할 때 twip-정밀 열 분할 + 인접 행 `span`·인접 열 `vMerge` 승격으로 일관 격자 분할한다.
  - Group B(비어 있지 않은 `vMerge::Continue` 보존): `para_is_truly_empty`, `cell_has_data`, `obj_relocatable`, `combine_cell_blocks`, `can_delete_row_safe`, `can_merge_rect`를 추가하고 unsafe `delete_row` fallback을 제거했다. `Restart` 또는 `Continue` 행 삭제·병합 시 비어 있지 않은 `Continue` 셀 내용을 문서 순서대로 보존하고(`Restart` 뒤, 또는 선행 비빈 `Continue` 뒤), 마커·`Opaque`·구역 분할·수정 기록·콘트롤·손상 `vMerge` 연쇄처럼 안전 재배치가 불가능한 경우는 무변이 fail-closed 거부한다.
- **T009 저장·어댑터·UI·문서 재현성**:
  - Group A UI: `src/adapters/docx.ts`, `src-tauri/src/adapters/wordcraft/{table.rs, engine.rs}`, `src/commands/{target.ts, parameters.ts, capability.ts, commands.ts}`, `src/components/Editor/CommandInputDialog.tsx`, `DocxEditorSession.ts`, `src/language/{ko,en}.json`을 연결해 비병합 `1×1` 셀에서 `table.splitCell`이 `selectionKey` 소유 다이얼로그(기본 `1×2` 또는 좁은 열 `2×1`)를 열고, 병합 셀은 다이얼로그 없이 즉시 복원한다.
  - Group C(`src-tauri/src/services/save/package.rs`): `authorized_table_media_changes` → `TableMediaChanges { removed_media, content_types_changed }`로 `<w:tbl>` 안 `<a:blip r:embed="..."/>` 제거에 기인한 `word/media/*`·관계 정리 및 실제 제거 시 미사용 `[Content_Types].xml` 엔트리만 좁게 허용한다. `removed.is_empty()`인 순수 `IMAGE_REL` ID 재번호에서는 `[Content_Types].xml` 면제를 비활성화하고 비-이미지 관계 ID까지 보존하며, 본문/헤더/고아 미디어·비미디어·무관 `[Content_Types].xml`·비이미지 관계 변조는 모두 거부한다(패키지 XML/관계 범위 증명이며 독립적인 UI 명령 실행 이력 provenance는 범위 밖).
  - Group D(`README.md`, `external/README.md`, `scripts/prepare-wordcraft.py`, `scripts/tests/test_wordcraft_reproduction.py`): 3단계 패치 체인과 공개 HTTPS 베이스 재구성 절차를 문서화·검증했다.

| 구분 | 실행 명령(요약) | 결과 |
|---|---|---|
| WordCraft 표 단위 | `cargo test --manifest-path external/wordcraft/Cargo.toml --offline --locked -p wordcraft-doc -- table` / `-p wordcraft-engine -- table` | `wordcraft-doc` 11 PASS / `wordcraft-engine` 51 PASS + `toc_roundtrip` 1 PASS (`dd14a0ae…`) |
| geul Rust 어댑터·T009 저장 | `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib -- adapters::wordcraft::tests::stage2_p1_ adapters::wordcraft::tests::core_table adapters::wordcraft::tests::protected_ services::save::tests::docx` | 41 passed, 0 failed, 1 pre-existing ignored(신규 `docx_table_media_renumbering_rejects_unrelated_content_types` T1/T2/T3 및 기존 `stage2_p1_*`·`docx_table_media_deletion_proof_*` 포함) |
| clippy·프런트엔드·재현성 | `cargo-geul.py clippy --lib`, `npx tsc --noEmit`, `npx eslint ...`, `npx vitest run ...` (4파일), `python3 scripts/tests/test_wordcraft_reproduction.py` | 수정 파일 clippy 경고 0(기존 `save/{hwp.rs,special.rs}` 3건 외), `tsc`/ESLint PASS, Vitest 4파일 65 passed, clean public clone 재구성 + `wordcraft-fonts` check PASS |
| 일반 제품 Release 빌드 | `GEUL_SANDBOX=userns-root-bwrap python3 scripts/tauri-geul.py build --no-bundle` | PASS (`src-tauri/target/release/geul` SHA-256 `525b2efb…`, `privacyStatus: PASS`, `runtimePathStatus: PASS`, 이번 `package.rs`·테스트 수정 전 빌드·REUSED; T3 및 실저장 경로는 Rust `stage2_p1_table_image_deletion_safe_save_and_reopen`로 CURRENT PASS 재확인) |
| Linux native GUI 수용 | `scripts/tests/native-ibus-session.py ... scripts/tests/native-docx-table-stage2-p1.py` → `target/stage2-p1-final-native/run/result.json` | REUSED PASS (`status: "PASS"`, `1×1` 셀 분할 UI `1×3`/`2×1`·오류 경고·Undo, 10명령·IME, 비빈 `vMerge` 행 삭제+Ctrl+S+재열기, 표 이미지 행 삭제+본문 이미지 보존+Ctrl+S+재열기; `package.rs` 좁은 보완은 UI 계약 불변) |

## 8. Stage 2 / Phase 2 — HWP/HWPX 고급 표 편집 (2026-11-17)

### 8.1 Task 1 — 병합하지 않은 일반 셀 나누기 (HWP/HWPX)

**구현.** `table.splitCell`(명령 ID 불변)이 HWP/HWPX에서 병합하지 않은 `1×1` 셀도 `행 × 열` 격자로 나눈다. 병합된 셀은 기존처럼 대화상자 없이 구성 셀로 복원한다(두 형태는 서로의 인수를 거부: 병합 셀에 차원 인수, 일반 셀에 무인수 실행은 `accepted:false`).

- **엔진**(`patches/rhwp/stage2-p2-cell-split.patch`, 시리즈 24번째): 고정 RHWP에 이미 있는 `Table::split_cell_into`(격자에 `n-1`행·`m-1`열 추가, 대상 행/열을 가로지르는 다른 셀의 span 확장, 뒤 셀 이동, 원래 셀 = 왼쪽 위 하위 셀, 새 셀 = 템플릿 빈 문단)를 재사용한다. 명시 경로 표 편집기 `editTableByPath`에 `splitCellInto [row,col,rows,cols]` 연산만 추가했고, `geul_split_ordinary_cell`이 변경 전에 대상이 비병합 `1×1`인지, 2칸 이상인지, 512행·64열·4096셀 한도, 하위 셀 최소 폭 600 HWPUNIT(6 pt)를 검사한다(거부 시 표 불변). 본문 표는 1단계 경로, 중첩 표는 소유 경로로 같은 연산을 쓴다. 별도 앱 표 엔진은 없다.
- **계획·증명**(`tableStructure.ts`): `planTableOp(..., split)`가 엔진 계약대로 결과 표(좌표·span·셀별 문단 digest)를 미리 계산하고, 호출 뒤 `applyTablePlan`이 셀 하나하나를 비교한다. 원래 셀의 문단·컨트롤은 왼쪽 위 셀에만 남고(중복·분배 없음) 다른 하위 셀은 빈 문단이다. 계산식 필드는 같은 필드 ID로 새 좌표에 남고 참조를 다시 쓴 뒤 엔진 평가로 값 불변을 확인한다. `ordinarySplitLimits`는 표 한도·셀 예산·최소 폭·대화상자 두 자리 수로 행/열 최대값과 `maxCells`를 정한다.
- **UI**(`RhwpEditorSession`): 일반 셀에서 명령이 가능하면 `parameters["table.splitCell"].tableSplit = {maxRows, maxColumns, maxCells}`를 내고, DOCX와 같은 `CommandInputDialog`(selectionKey 소유, 낡은 요청 거부)를 연다. `maxCells`는 선택 필드라 DOCX 문맥은 바뀌지 않는다. 실행은 세션 문맥으로 인수를 다시 검증하고 한 mutation·한 Undo 단계이며, 캐럿은 결과 격자의 원래 셀로 간다.
- **HWP T009**(`src-tauri/src/services/save/hwp/insertions.rs`): 필드·캡션·자식 컨트롤이 있는 표는 셀 대응으로 증명한다. 기존 후보(동일·행/열 삽입·삭제·병합·병합 해제·복합)에는 일반 분할이 없어 저장이 `recordsChanged`로 거부됐다(실측). `ordinary_splits`가 **격자 정제(refinement)** 대응을 더한다: 원본 행/열 경계를 출력 경계로 보내는 단조 사상이 있어 모든 원본 셀 영역이 출력 셀로 정확히 타일링되고, 영역 왼쪽 위 출력 셀이 원본(내용 유지), 나머지는 새 셀이다. 여러 번의 분할을 한 번에 저장해도 설명된다. 후보는 교차 수가 적은 경계를 우선하고 동률은 256개 안에서 열거하며, 모든 후보를 완전 검증하므로 순위는 완전성에만 영향을 준다(한도 초과/미검증 = 거부). 자식 소유는 기존 `Mapping::consistent`·`match_children`이 판정한다. 평범한 표는 기존 `restructured_table` 불변식 증명으로 통과한다.

**지원 범위.** HWP/HWPX 본문·중첩 표의 비병합 셀, `1×2`…, `2×1`…, `2×2` 등 직사각형 분할(행 ≤ min(99, 513−행 수), 열 ≤ min(99, 65−열 수, 셀 폭/600), 행×열 ≤ 4097−셀 수). 텍스트·여러 문단·글자 서식·계산식/누름틀 필드·캡션이 있는 표, 병합 셀 옆 분할, 분할 뒤 병합 복원.

**남은 제한(안전 거부).** 병합 셀의 `N×M` 재분할은 지원하지 않는다(복원만). 분할이 계산식 범위를 넓어진 병합 영역을 지나게 만드는 경우(예: `SUM(A1:A2)`가 `A1:A3`로 바뀌며 가려진 셀을 읽음) Task 1 시점에는 엔진 계산식 검증이 사후 거부하고 세션이 snapshot으로 되돌린 뒤 편집을 중지했다. **Task 2(8.2)에서 엔진 호출 전 `tableFormula` 거부로 교정**했다(편집 계속). 텍스트 상자 등 자체 목록을 가진 개체가 든 표는 기존대로 거부한다.

**검증 (2026-11-17, Release `5f3c8067…`).**

| 검사 | 명령 | 결과 |
|---|---|---|
| RHWP 엔진 | 준비 소스 사본에서 `cargo test --locked --offline --lib geul_ordinary_split_tests` | CURRENT PASS 2/2 (가로·세로·직사각형, 거부 시 불변·병합 셀 거부) |
| HWP T009 대응 | `python3 scripts/cargo-geul.py test --lib ordinary_split_correspondence_tests` | CURRENT PASS 2/2 (단일·반복 분할 대응, 비정제 거부) |
| HWP 저장 회귀 | `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib -- ordinary_split_correspondence_tests services::save::hwp hwp_restructured hwp_safety_composite hwp_boundary` | CURRENT PASS 47; `--lib hwp_` 전체 41 PASS/2 FAIL — 2건(`rhwp_publication_is_linearized…` SharedDirectory, `hwp_편집한_저장은…` finding 개수)은 변경 전 HEAD 소스에서도 같은 FAIL(기존 결함) |
| Release WASM 제품 | `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage2-tables.wasm.test.ts` | CURRENT PASS 58/58 (새 9: HWP/HWPX `1×2`·`2×1`·`2×2`·Undo/Redo·저장·재열기, 여러 문단+굵게+병합 옆+병합 복원+잘못된/낡은 인수, 중첩 표 분할, HWP 계산식·누름틀·캡션 표, 계산식 모호 범위 원자 거부, 한도/엔진 거부) |
| 프런트엔드 | `npx vitest run` 6파일 / `rhwpAssets.test.ts` / `tsc --noEmit` / ESLint | CURRENT PASS 97 / 12 / PASS / PASS |
| 검사기 | `python3 scripts/cargo-geul.py build --example save_check`; `clippy --lib -- -D warnings` | build PASS; clippy FAIL 3건은 변경하지 않은 `hwp.rs`·`special.rs`(기존), `fmt --check`의 기존 차이도 변경 파일 외 기존 |

저장 증거는 제품 세션이 보낸 실제 export·손실 보고·live/reopen 비교를 실제 `save_check`(T009)로 판정하고 엔진으로 독립 재열기한 것이다(HWP findings는 서비스가 재생성하는 `previewStale`만). 실제 저장 서비스 durable publication은 native 수용(8.3)에서 확인한다. 시험 harness 보정: HWPX 세션은 배경 원본 probe(글꼴 소유)로 저장 시 `original` 요청이 둘이라 `save()`가 HWPX에서 둘 다 답한다(기존 HWPX 저장 시험 4개가 이 때문에 멈추던 것을 같이 고침 — 기준 소스에서도 같은 멈춤 확인).

**산출물.** RHWP 핀 `1a76570e…`, WordCraft 핀 `dd14a0ae…` 불변. 새 Release generation `5f3c8067f64facc7a7833b4eebe6341e8b8a2b7b342cd0b46cf148f882c4442f`(WASM `9f825543…`, JS `9a7109c1…`, 패치 24, source tree `054cc60c…`, `externalUnchanged: true`), 새로 준비한 소스의 `table_ops.rs`는 검토 사본과 바이트 동일. 보관 한도 6을 지키려고 선택되지 않은 `4723c0ce…`와 이전 준비 소스를 해시 확인 후 `target/rhwp-retired-generations/stage2-p2/`로 옮겼다(삭제 없음). 생성물은 커밋하지 않는다.

### 8.2 Task 2 — 복합 내용 표 구조 편집 감사와 교정

**감사 방법.** 기존 시험이 이미 증명한 경우(HWPX 풍부한 표 행 넣기/지우기·참조 재작성, HWP 필드·캡션 표의 행 넣기·범위 병합·나누기, 중첩 표 진화, 셀 inline 그림 생성 등)를 제외하지 않고, 대표 내용 5종 × 표 구조 명령 11개(행 위/아래·열 왼/오른 넣기, 행/열 지우기, 오른쪽/아래/범위 합치기, 일반 셀 `2×2` 분할, 합친 셀 복원) + 셀 안 입력·셀 안 문단 나누기·합친 뒤 입력 3개를 HWP/HWPX 각각 **새 제품 세션에서 실행 → 실제 T009 검사기 저장 판정 → 독립 재열기**로 확인했다(`stage2-tables.wasm.test.ts` "complex content matrix", 형식별 70칸, 결과 `target/stage2-focused/probe-<format>.tsv`). 내용 5종: 셀 inline 그림(HWP JPEG/HWPX PNG), 원본 중첩 표, 부분 굵게(분할 run), HWP 계산식 `=SUM(A1:A2)`+누름틀+캡션 / HWPX floating 그림+캡션, 앞선 구조 변경(행 넣기) 뒤 같은 저장.

**지원 매트릭스 (교정 후, 140칸).**

| 내용 | HWP | HWPX |
|---|---|---|
| 셀 inline 그림 | SUPPORTED: 11/11 구조 명령 + 입력·문단 나누기 저장·재열기 | SUPPORTED 11/11 |
| 중첩 표(부모 표 구조 편집, 병합 흡수, 분할) | SUPPORTED: 11/11 (**교정 B**: 병합 뒤 복원 저장 거부 → 허용), 셀 안 문단 나누기(**교정 B**) | SUPPORTED 11/11 |
| 부분 글자 서식(분할 run) | SUPPORTED 11/11 | SUPPORTED 11/11 (Stage 2 P0 재조정 유지) |
| 계산식+누름틀+캡션 | SUPPORTED WITH CONDITIONS: 8/11 저장·재열기(**교정 C**: 필드 셀 열 지우기 저장 거부 → 허용; 문단 나누기 **교정 B**). 행 2 지우기·A1 아래 합치기·A1–B2 범위 합치기는 피연산자 A2를 지우거나 흡수하므로 엔진 호출 전 `tableFormula` 거부(편집 계속) | (HWPX 필드 표는 기존 시험) floating 그림+캡션 11/11 |
| 앞선 구조 변경 뒤 추가 변경을 한 번에 저장 | SUPPORTED 11/11 | SUPPORTED 11/11 |

**재현된 결함과 근본 원인 (P1-B 둘, P2 하나).**

- **교정 A (P2, 모든 구조 명령)**: 계산식 참조를 다시 쓰면 넓어진 병합 영역 안의 가려진 좌표를 읽게 되는 계획(예: 분할 뒤 `A1:A3`)을 계획 단계는 받아들였다. 엔진 `validate_formula_references`가 변경 뒤 거부하자 세션은 snapshot으로 되돌린 뒤 편집을 중지했다. `planTableOp`이 엔진과 같은 규칙(셀·범위 내부·방향 참조의 모든 좌표가 결과 셀의 앵커)을 계획 격자에 적용해 **엔진 호출 전** `tableFormula`로 거부한다. 엔진 호출 0회, 편집 계속, 이후 유효한 분할은 그대로 가능하다(시험으로 확인).
- **교정 B (P1-B, HWP)**: 자식 컨트롤(중첩 표·필드)이 있는 원본 HWP 표에서 **셀 안 문단 나누기(Enter)**나 **병합 뒤 복원**처럼 격자는 같고 셀의 문단 수만 바뀐 편집을 모델은 받아들였지만 저장이 `recordsChanged`로 거부됐다. 원인은 `evolved_table`의 `structural || formatting_only` 관문이다. 평범한 표 증명(`restructure_candidate`)은 셀 문단 수를 기하로 보는데, 이 경로는 그렇지 않았다. 같은 격자에서 셀 문단 수가 바뀌면 구조 변경으로 본다. 원본 자식은 여전히 같은 셀의 **같은 문단 번호**에 순서대로 있어야 하므로(`Mapping::consistent`), 자식 앞에서 Enter를 쳐 자식의 문단 번호가 바뀌면 계속 거부된다. 글은 독립 live/reopen 비교 몫이다.
- **교정 C (P1-B, HWP)**: 누름틀 필드(불투명 `CTRL_DATA`)가 있는 셀을 지우는 **증명된** 행/열 삭제 저장이 `hwp.rs` `opaque_owners_preserved`에서 거부됐다. 이 검사가 불투명 owner 수 동일을 요구했기 때문이다(`evolved_table`·`field_preservation`은 이미 삭제를 증명). `evolved_table`이 증명된 대응으로 **삭제한 셀과 함께 사라진 자식 객체의 정확한 digest**를 `Proof.removed`(multiset)로 넘긴다. 불투명 owner 검사는 그 digest와 subtree가 정확히 같고 출력에 남아 있지 않은 owner만 원본 목록에서 빼고, 나머지에는 기존 동일/위치 이동 규칙을 그대로 적용한다. 전역 "구조 증명 있음" 표시로 넓히지 않았다. 음성 회귀: 행 3을 지우면서(계산식 필드 삭제는 정당) 살아남은 B1의 누름틀까지 사라지면 `unsafe`. 같은 행 삭제만 한 출력은 `previewStale`만(대조군).

**여전히 거부하는 구조(UNSAFE/AMBIGUOUS, fail-closed).** 삭제된 셀 안 **중첩 표 내부**의 누름틀처럼 불투명 owner가 삭제된 자식 객체보다 깊은 경우(digest 불일치, 시험하지 않은 경계로 거부 예상), 자식 앞 문단 나누기로 자식의 문단 번호가 바뀌는 편집, 계산식이 지워지거나 흡수되거나 가려진 좌표를 읽게 되는 구조 명령, 텍스트 상자 등 자체 목록을 가진 셀 개체, 표 밖 캡션 이동, 병합 셀의 `N×M` 재분할. HWP와 HWPX는 별도 증명이다. HWPX는 위 매트릭스에서 교정이 필요하지 않았고 HWP 교정은 HWPX 경로를 바꾸지 않는다.

**검증 (Release `5f3c8067…`, 최종 검사기).**

| 검사 | 결과 |
|---|---|
| `stage2-tables.wasm.test.ts` 전체 | CURRENT PASS 61/61 (매트릭스 2, 필드 열/행 삭제 양성·음성, 계산식 모호 분할 사전 거부 포함) |
| Rust 집중(`ordinary_split_correspondence_tests`, `services::save::hwp`, `hwp_restructured`, `hwp_safety_composite`, `hwp_boundary`) | CURRENT PASS 47 |
| `--lib services::save` | 269 PASS / 3 FAIL — 3건(`calc_cell_*` 2, `hwp_편집한_저장은…`)은 `docs/release-checklist.md`에 기록된 기존 실패 |
| `table-formula-session`·`table-phase2`·`general-formatting` WASM | 20·6·1 FAIL, 같은 Release WASM과 시작 커밋 `d7dc75c` 소스·검사기로 만든 기준선에서 20·6·5 FAIL. 현재 실패 집합은 기준선 실패 집합과 같거나 그 부분집합(새 회귀 없음, 옛 계약을 담은 기존 실패) |
| 프런트엔드 | `tsc` PASS, ESLint PASS, 단위 132 PASS / 2 FAIL(`hwpReopenModel.test.ts` 필드 증거 2건 — 시작 커밋 소스에서도 같은 FAIL) |
| 검사기 Clippy/fmt | 변경 파일 진단 없음(기존 3건·기존 fmt 차이 유지) |

### 8.3 Native GUI 수용 (2026-11-17)

`python3 scripts/tests/native-ibus-session.py --hangul-initial-mode hangul --out "$PWD/target/stage2-p2-native/run1-session" -- python3 scripts/tests/native-stage2-p2.py --app "$PWD/src-tauri/target/release/geul" --driver "$PWD/src-tauri/target/debug/tauri-driver" --out "$PWD/target/stage2-p2-native/run1" --xdotool @XDOTOOL@ --ibus @IBUS@` → **PASS (run1, 첫 실행)**. 일반 제품 빌드(`npm run build`, `rhwp-artifacts.py --verify-product dist/rhwp --profile release`, `GEUL_SANDBOX=userns-root-bwrap python3 scripts/tauri-geul.py build --no-bundle`), 앱 SHA-256 `de0033d511074c04bd17…`, Release `5f3c8067…`, Task 2 변경을 포함한 작업 트리(HEAD `757b3e9`). Xvfb·D-Bus·IBus(ibus-hangul) 세션, launcher 정리 `complete: true`, 잔존 프로세스 없음.

- HWP·HWPX 각각: 키보드로 표 셀 A1 이동 → 한글 도구 리본 `셀 나누기` → 공용 대화상자(초기 `1×2`, 행 `0`은 오류로 남음, Escape 취소) → `1×2` 분할. 앱 안 Tab 도달 셀: 분할 전 3 → 분할 4 → Ctrl+Z 3 → Ctrl+Y 4. 새 하위 셀에 입력 → Ctrl+S 실제 T009 저장·게시 `saved` → 닫기 → 독립 oracle: `2×3`, `[outer0][NEW][outer1] / [outer2 (colSpan 2)][outer3]`. 앱 재열기에서 마지막 셀 4.
- HWP 계산식+누름틀+캡션 표: A3에서 `X` Enter `Y`(교정 B 경로) → 저장 `saved` → 독립 oracle: A3 `X|Y`, 필드 2개 ID·명령·이름 동일(`=SUM(A1:A2)??%g,;;3`), 캡션 동일, 다른 셀 동일.
- 입력은 xkb 영문으로 했다. 한글 IME 조합 자체는 이번 시나리오에서 재검증하지 않았다(기존 native IME 기록 유지).

## 9. Stage 2 / Phase 3 — 형식 공통 표·셀 서식 (2026-11-18)

DOCX(WordCraft)·HWP(RHWP)·HWPX(RHWP) 세 문서 형식에서 표 셀 배경색·테두리(`P3-1`), 가로·세로 맞춤(`P3-2`), 열 너비·행 높이(`P3-3`), 제품 GUI 수용·T009 저장·독립 재열기(`P3-4`)를 공용 명령·UI·어댑터 경로로 구현했다.

### 9.1 명령·UI·형식별 지원 계약

- **공용 명령 및 리본** (`src/commands/registry.ts`, `src/ribbon/definitions.ts`, `src/ribbon/visibility.ts`, `src/language/{ko,en}.json`):
  - `table.shading`, `table.borders`, `table.alignment`, `table.columnWidth`, `table.rowHeight` 5개 명령을 `wordcraft: SUPPORTED` · `rhwp: SUPPORTED`로 추가해 `TABLE_FORMATTING_GROUP`으로 노출했다(HWP/HWPX `hangulTools`, DOCX `ribbon.tab.layout`; 기존 표 구조 10개 명령 유지).
- **공용 대화상자 및 파라미터 문맥** (`src/components/Editor/TableFormattingDialog.tsx`, `src/commands/parameters.ts`, `validateCommandArgs`):
  - 각 세션 `parameterState()`가 산출한 선택 범위·혼합 상태·현재값과 형식별 허용 집합만 대화상자에 노출하며 `selectionKey` 소유 검사를 적용한다.
  - `table.shading`: `#RRGGBB` 지정과 배경 지우기(`color: null`).
  - `table.borders`: `all`/`outside`/`inside`/`top`/`bottom`/`left`/`right`/`none`, 형식별 선 종류·두께(`widthUnit`: DOCX pt / RHWP mm)·색상. 선택 직사각형이 불완전하거나 비어 있으면 거부하고, 단일 셀 선택 등 내부 경계가 없을 때 `hasInsideBorders=false`로 `inside`를 비활성화한다.
  - `table.alignment`: 가로(`left`/`center`/`right`/`justify`), 세로(`top`/`middle`/`bottom`), 혼합 표시(`horizontalMixed`/`verticalMixed`).
  - `table.columnWidth`: 명시 `pt`(`minPt..=maxPt`) 및 `distribute` 균등 분배.
  - `table.rowHeight`: 명시 `pt`, 형식별 높이 규칙(DOCX `supportedRules: ["atLeast", "exact"]`, `supportsAuto: true`; RHWP `supportedRules: ["atLeast"]`, `supportsAuto: false`), `distribute` 균등 분배.

### 9.2 엔진·세션·T009 저장 경계

- **DOCX / WordCraft** (`patches/wordcraft/docx-table-formatting.patch`, `docx-table-alignment.patch`, `docx-table-dimensions.patch`, 커밋 핀 `cae8c33058e620c02704a2414600b9cb7ecf0867`, `src-tauri/src/adapters/wordcraft/{table.rs, engine.rs}`, `src/adapters/docx.ts`, `src/components/Editor/wordcraft/DocxEditorSession.ts`):
  - 선택 범위 `table.shading`·`table.borders`·`table.cellAlignment`·`table.setColumnWidth`·`table.setRowHeight`(`wordcraft_doc::table::quantize_twips`로 분배 값 twips 반올림 일관성 유지)를 추가했다.
  - `DocxEditorSession`의 `MUTATING_OPS`와 `COMMAND_OPS`에 `tableShading`·`tableBorders`·`tableAlignment`·`tableColumnWidth`·`tableRowHeight`를 모두 포함해 Undo/Redo·상태 동기화·입력 직렬화를 보장하고, `src-tauri`는 임의 WordCraft 명령 문자열을 열지 않는 명시 `DocxOp`과 `atomic()` 스냅샷 롤백·`export()`/`same_as()` 검증을 사용한다.
  - 출력은 `word/document.xml` 안에만 반영되므로 기존 `compare_saved_docx` 경계를 넓히지 않는다.
- **HWP / HWPX / RHWP** (`patches/rhwp/stage2-p3-1-cell-shading-borders.patch`, `stage2-p3-2-cell-alignment.patch`, `stage2-p3-3-table-dimensions.patch`, Release WASM `455452971ed81b0135cd94845c9c5b040363b8b03622fead68b1b661a5d418eb`, `src/components/Editor/rhwp/RhwpEditorSession.ts`):
  - `getTableCellFormattingByPath`와 `formatTableCellsByPath`로 일반·병합·중첩 표 셀의 배경색/테두리/맞춤/열 너비·행 높이를 읽고 수정하며, `compactAppendedBorderFills`로 중복 `BorderFill`을 정리한다(셀 문단 줄 분리는 `p.line_segs`를 비우지 않고 유지해 HWP5 `HWPTAG_PARA_LINE_SEG` 계약을 보존).
  - HWPX `package.rs` `hwpx_table_border_appended()` / `verify_appended_border_fills()`: `hwpx_table_border_appended()`가 `<hh:borderFills>` 끝 추가 외 무관 `Contents/header.xml` 불변을 판정하고(전역 면제 없음), `verify_appended_border_fills()`가 추가된 `borderFill` 정의(기본/기존 일치 속성 및 단색 `winBrush` 또는 기존 채움 일치)를 좁게 검증·허용한다. 기본 표 테두리와 정확히 일치하는 추가 정의는 `<hp:tbl>` 또는 `<hp:tc>` 참조를, 그 외 검증된 셀 서식용 추가 정의는 `<hp:tc>` 참조만 허용하며, 참조 ID가 유효하고 모든 추가 정의가 실제 사용되어야 한다(미사용 정의·잘못된 참조·무관 헤더 변경은 거부; 동등 `borderFill` 재사용은 RHWP가 처리).
  - HWP `insertions.rs`: `valid_appended_border_fill`이 `basic_border_fill`과 동일한 기본 대각선 `[1, 0, 0, 0, 0, 0]`(및 `[0; 6]`)·유효 선/두께·`fill_type 0/1`을 허용하고(빈 문서 `orig_borders=0` 포함), 수평 맞춤은 기존 Stage 1 `ParaShape` 증명을 재사용하며 수직 맞춤은 `cell_header_matches_ignoring_border_fill` 및 신규 표 `validate_table_at`에서 셀 `list_attr` 비트 `21..=22`(바이트 4 마스크 `0x60`, 값 `0..=2`)만 좁게 허용한다.

### 9.3 최종 검증 및 Native GUI 수용 (`P3-4`)

| 검사 | 명령(요약) | 결과 |
|---|---|---|
| TypeScript / ESLint / 프런트엔드 | `npm run typecheck && npm run lint && npx vitest run TableFormattingDialog DocxEditorSession ribbon language commands` | `tsc` PASS, ESLint 오류 0(기존 경고 1 `FontPicker.tsx`), Vitest 6파일 68/68 PASS |
| WordCraft 무결성 및 엔진 | `python3 scripts/prepare-wordcraft.py` · `cargo test -p wordcraft-engine --offline -- cmd::table::tests` | `cae8c33058e620c02704a2414600b9cb7ecf0867` exact match, 4/4 PASS |
| `src-tauri` T009·어댑터 계약 | `cargo test --lib -- stage2_p3_ hwp_restructured_original_table_is_proven_or_refused hwpx_appended_cell_border_fill adapters::wordcraft::tests::stage2_p1_` | 11/11 PASS |
| RHWP Release WASM 표 회귀 | `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage2-tables.wasm.test.ts` | 73/73 PASS (P1·P2·P3 및 복합 내용·계산식/누름틀/캡션·중첩·T009·재열기) |
| 일반 제품 Release 빌드 | `npm run tauri -- build --no-bundle` | PASS (`src-tauri/target/release/geul` SHA-256 `71db683e…`, `privacyStatus: PASS`, `runtimePathStatus: PASS`) |
| Linux Native GUI 수용 | `scripts/tests/native-ibus-session.py -- scripts/tests/stage2-p3-native-acceptance.py --out target/p3-native-out` | PASS (`docx`, `hwpx`, `hwp` 모두 `#FEF08A`·이중선 `#DC2626`·가운데/아래 맞춤·`125pt`/`36pt`·Undo/Redo·`Ctrl+S` `saved`/`findings:""`/`synced:true`·재열기 복원·디스크 ZIP/XML/CFB 검사) |

주의 사항(기준선 기존 결함·제외 범위): 기존 커밋 `de7079b`에서부터 남아 있는 무관한 단위 테스트 실패(`src/commands/hangulTools.test.tsx:426`, `src-tauri/src/services/save/tests.rs` `calc_cell_*` 등 3건)는 건드리지 않았으며, 외부 Microsoft Word/한컴오피스 프로그램 직접 열기와 Windows/macOS·Wayland 수용은 NOT RUN이다.

## 10. Stage 2 / Phase 4 — 고급 표 기능 (2026-11-18)

DOCX(WordCraft)·HWP(RHWP)·HWPX(RHWP)에서 다중 셀 구조 클립보드(`P4-1`), 셀 여백·표 위치(`P4-2`), 반복 머리행·페이지 나눔(`P4-3`), 프로덕션 Linux native GUI 통합 수용과 문서 정합성 정리(`P4-4`)를 구현·검증했다.

### 10.1 다중 셀 구조 클립보드 (`P4-1`)

- **스키마·직렬화·Fallback** (`src/commands/tableClipboard.ts`, `src/commands/clipboard.ts`):
  - 구조 MIME `application/x-geul-table-cells+json`(`TABLE_CLIPBOARD_MIME`)과 상한(`512`행, `64`열, `4096`셀, `2 MiB`, 셀당 문단 `256`, 문단당 run `1024`)을 두고 외부 클립보드 입력을 신뢰하지 않고 직사각형 격자·좌표·병합·서식·텍스트 유효성을 엄격히 검증(`parseTableClipboardPayload`)한다.
  - 런타임이 구조 MIME 읽기를 제공하지 못하는 경로에서도 평문 탭/줄바꿈 직렬화(`buildTableClipboardPlainText`) 및 앱 내 구조 payload 기억(`rememberStructuredClipboard`/`recallStructuredClipboard`)으로 동일 앱 내 구조 복사/잘라내기/붙여넣기를 유지하며, 크로스 앱 구조 MIME 상호운용은 주장하지 않는다.
- **세션·엔진 실행 및 안전 경계**:
  - `DocxEditorSession`(`DocxOp::{CutTableCells, PasteTableCells}`, `patches/wordcraft/docx-table-clipboard.{patch,commit}`)과 `RhwpEditorSession`(`extractTableCellsByPath`/`clearTableCellsByPath`/`applyTableCellsByPath`, `patches/rhwp/stage2-p4-1-table-clipboard.patch`)이 복사 시 무변이·잘라내기 시 클립보드 쓰기 선성공 후 원자적 삭제·붙여넣기 시 대상 표/크기/병합 호환/임베드 개체·필드 보호/세션·리비전 소유 검증·단일 Undo/Redo 단계를 보장한다.

### 10.2 셀 여백·표 위치 (`P4-2`) 및 반복 머리행·페이지 나눔 (`P4-3`)

- **`table.cellMargins`·`table.positioning`**: 표 기본 안 여백(`scope: "table"`)과 선택 셀 개별 여백(`scope: "cell"` 및 `reset`), 가로 정렬(`left`/`center`/`right`), `left` 기준 들여쓰기(`indentPt`)를 공통 지원하고, HWP/HWPX에서는 `treatAsChar`와 `outerMargins`를 추가 제공한다(DOCX는 `treatAsCharSupported: false`, `outerMargins: null`). RHWP `stage2-p4-2-margins-positioning.patch`는 `set_table_properties_native`에서 `table.outer_margin_*`와 `table.common.margin`을 함께 갱신하고 `table.common.attr`를 비트 단위로만 반영해 HWPX `TextWrap` 유실 결함을 함께 해결했다.
- **`table.repeatHeader`·`table.rowBreak`**: `table.repeatHeader`는 첫 행부터 끊김 없는 선행 머리행(`canEnableHeader`)만 허용하고 중간/비연속 행 또는 부분 수직 병합 경계를 거절한다. `table.rowBreak`는 DOCX `["cell", "row"]`(`w:cantSplit`)와 RHWP `["cell", "row", "none"]`(`TablePageBreak`)만 노출한다. WordCraft 핀 `f42cd16c06d59c1e951c2475ec824f593887650b`와 RHWP `stage2-p4-3-headers-pagination.patch`로 다쪽 렌더링(`render_page_html_native`) 머리행 반복과 T009/재열기를 검증했다.
- **HWP5 신규 셀 플래그 직렬화 수정 (`P4-4`)**: 실제 프로덕션 HWP GUI 수용에서 신규 생성 셀(`raw_list_extra.is_empty()`)에 `HAS_MARGIN`/`HEADER` 등 하위 플래그만 먼저 켜질 때 `serialize_cell`이 한컴 47바이트 `LIST_HEADER` 기본 계약 비트 `0x0400`을 빠뜨려 T009(`OutputMalformed:BodyText/Section0`)로 거부되는 결함을 발견해 `patches/rhwp/stage2-p4-4-cell-flags.patch`로 보정하고 Release WASM(`015a899de475…`)으로 재빌드·통과시켰다.

### 10.3 최종 검증 및 Native GUI 수용 (`P4-4`)

| 검사 | 명령(요약) | 결과 |
|---|---|---|
| TypeScript / ESLint / 프런트엔드 | `npx tsc --noEmit && npm run lint && npx vitest run TableFormattingDialog DocxEditorSession clipboardSessions clipboard clipboardAccess commands visibility` | `tsc` PASS, ESLint 오류 0(기존 경고 1 `FontPicker.tsx`), Vitest 7파일 113/113 PASS |
| WordCraft 무결성 및 엔진 | `python3 scripts/prepare-wordcraft.py` · `cargo test -p wordcraft-engine --locked --offline -- cmd::table::tests` | `f42cd16c06d59c1e951c2475ec824f593887650b` exact match, 7/7 PASS |
| `src-tauri` P4 계약·T009 | `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline -- stage2_p4_` | 6/6 PASS (DOCX/HWP P4-1/P4-2/P4-3 계약 및 T009) |
| RHWP Release WASM 표 회귀 | `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage2-tables.wasm.test.ts` | 78/78 PASS (Release WASM `015a899de475…`, `externalUnchanged: true`) |
| 일반 제품 Release 빌드 | `npm run tauri -- build --no-bundle` | PASS (`src-tauri/target/release/geul` SHA-256 `28e6575a…`, `privacyStatus: PASS`, `runtimePathStatus: PASS`) |
| Linux Native GUI 수용 | `scripts/tests/native-ibus-session.py -- scripts/tests/stage2-p4-native-acceptance.py` | PASS (`docx`, `hwpx`, `hwp` 모두 다중 셀 Copy/Paste/Undo/Redo/Cut/Undo·굵게 보존, `table.cellMargins`·`table.positioning`·`table.repeatHeader`·`table.rowBreak`, `Ctrl+S` `saved`/`findings:""`/`synced:true`, `Ctrl+O` 재열기 복원, ZIP XML & HWP Release WASM 디스크 오라클 확인) |

### 10.4 P4 안정화·정합성 보수 (2026-11-18)

- **RHWP 구조 붙여넣기 서식 (P1)**: `apply_table_cells_by_path_native`가 run마다 스키마 속성을 모두 확정한다. 스키마가 생략한 `bold`/`italic`/`underline`/`strikethrough`는 `false`, 생략한 `color`는 기본 글자색(검정), 생략·`null` `highlight`는 "강조 없음"이다(WordCraft의 새 `CharProps` 기준과 같음). 그래서 대상 문단의 글자 모양(굵게·기울임·밑줄·취소선·색·강조)이 붙여 넣은 글자로 새지 않는다. 스키마에 없는 속성과 생략한 `fontSizePt`/`fontFamily`만 대상 모양을 따른다. `fontFamily`는 7개 언어 슬롯마다 기존 글꼴이 정확히 하나일 때만 적용하고, 그렇지 않으면 원자적으로 거부한다. 추출은 한 글꼴이 7개 슬롯을 모두 덮을 때만 `fontFamily`를 내보낸다(언어별 혼합 글꼴은 생략 → 대상 글꼴 유지). 문서에 없는 글꼴은 `RhwpEditorSession`이 `format.font`와 같은 소유 증명(`fontCreationOwned`: 활성 세션·세대·리비전, `canFormatFonts`, 원본 SAFE, 글꼴 소유 API)이 있을 때만 같은 기록 단계 안에서 `resolveDocumentFontFamily`로 먼저 등록하고, 증명이 없으면 붙여넣기를 거부한다.
- **RHWP 붙여넣기 실패 원자성 (P2)**: 새 글자 모양을 `doc_info.char_shapes`에 바로 덧붙이던 `modified_char_shape_ids` 호출을 단계 목록(`stage_char_shape`)으로 바꿨다. 문단·테두리 모양과 함께 모두 검증·구성한 뒤 표 교체(유일한 실패 가능 단계)를 먼저 하고, 그다음 정의를 게시한다. 바뀌지 않는 모양은 기존 ID를 재사용한다. 엔진 API 단독으로(UI 기록 되돌리기 없이) 둘째 셀의 잘못된 크기·색·강조·정렬·테두리·세로 정렬·글꼴·개체 문자와 병합 불일치에서 DocInfo·글꼴·셀·HWP/HWPX 직렬화가 그대로임을 검증했다.
- **DOCX 대기 기록 예상 (P3)**: `MUTATING_OPS`에 `tableRepeatHeader`·`tableRowBreak`를 추가해 `queuedHistory()`가 대기 중 변경의 다시 실행 단계를 버린 것으로 예상한다(`mutates()`는 이미 변경으로 분류).
- **클립보드 비동기 소유 (P4-A)**: `pasteStructured()`는 `insertStructured`가 `notTable`을 돌려준 뒤 평문 대체 넣기 전에 소유·세션·세대·리비전·클립보드 키(`current()`)와, 앱 내 기억 payload이면 그 동일성(`structuredClipboardVersion`)을 동기적으로 다시 확인한다. 추가 클립보드 읽기는 없다(WebKitGTK 권한 경로 불변).
- **반복 머리행 끄기 계약 (P4-B)**: DOCX·HWP·HWPX 모두 선택한 행만 끈다. 선택 아래에 머리행이 남으면 거부한다(조용히 지우거나 비연속으로 남기지 않음). RHWP는 이전에 선택 행부터 끝까지 지웠고, RHWP 세션은 이 엔진 거부를 복구 가능한 무변경으로 처리한다.
- **관리 패치**: RHWP 변경은 `patches/rhwp/stage2-p4-5-stabilization.patch` 하나에 담았다(산출물 신원 계약 `rhwp-artifacts.py`·`rhwpArtifactIdentity.ts`의 패치 32개 상한). Release WASM `b5f0b768075d62f908fc36639e42c635d91e75f83feab2a506098014c02318aa`(`externalUnchanged: true`). WordCraft는 바꾸지 않았다(`f42cd16c…`).
- **해결된 기존 결함 (후속 보수, 2026-11-18)**: 새 HWP 표 셀 Enter 저장 거부는 후속 보수에서 해결했다: 직렬화기 출력(셀 `LIST_HEADER` 문단 수 2, 문단별 `PARA_HEADER`/텍스트/글자 모양/줄 레코드, 마지막 문단에만 목록 끝 비트)은 정상이었고, 원인은 T009 새 표 증명(`validate_table_at`)이 손대지 않은 42바이트 새 표의 셀마다 문단 수를 1로 고정한 과잉 제약이었다. `recordsChanged:DocInfo`는 그 증명 실패로 표 삽입의 덧붙인 정의(테두리 등)가 일반 비교로 떨어진 결과다(Enter는 DocInfo를 바꾸지 않음). 격자 기하 제약은 그대로 두고 문단 수 고정만 없앴다: 셀 문단마다 일반 `paragraph()` 증명을 통과해야 하고 머리 문단 수는 실제 레코드 수와 같아야 한다. 계약 시험 `stage2_new_table_multi_paragraph_cell_proven_or_refused`(문단 수 불일치·문단 모양 참조 오류·격자 변조·무관한 DocInfo 변경 거부), WASM 세션 시험(가운데/처음/끝/빈 문단/연속 Enter·한글·캐럿·Undo/Redo·T009 저장·독립 재열기), Native `hwp-new-table-enter-native.py`(Release `e9df51c8…`, 수정 전 `82eae910…`에서는 같은 거부 재현) PASS.

| 검사 | 명령(요약) | 결과 |
|---|---|---|
| TypeScript / ESLint / 프런트엔드 | `npx tsc --noEmit && npm run lint && npx vitest run clipboard clipboardSessions DocxEditorSession commands TableFormattingDialog clipboardAccess visibility` | PASS, ESLint 오류 0(기존 경고 1), 7파일 123/123 |
| RHWP Release WASM 표 회귀 | `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage2-tables.wasm.test.ts` | 87/87 PASS(신규 9: 엔진 서식·글꼴·원자성 3, 세션 Undo/Redo·T009 2, 글꼴 소유 2, 머리행 끄기 2) |
| `src-tauri` P4 계약·T009 | `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline -- stage2_p4_` | 7/7 PASS(신규 DOCX 머리행 끄기 1) |
| 일반 제품 Release 빌드 | `npm run tauri -- build --no-bundle` | PASS(`geul` SHA-256 `82eae910b7d1feda…`, privacy/runtimePath PASS) |
| Linux Native GUI 기존 수용 | `native-ibus-session.py -- stage2-p4-native-acceptance.py` | PASS(DOCX/HWPX/HWP) |
| Linux Native GUI 다쪽 수용 | `native-ibus-session.py -- stage2-p4-native-multipage.py` | PASS(DOCX/HWPX/HWP: 2쪽, 머리행 전 대조군 7행, 머리행 뒤 2쪽 적중 0/1행·본문 7행, 저장·닫기·재열기 뒤 동일, 대화상자 유지, 디스크/HWP WASM 2쪽 렌더 트리 확인) |

RHWP `cargo test --lib`는 기준(`862b56a`)에서도 관련 없는 시험 모듈 35개 오류로 컴파일되지 않아 엔진 시험은 Release WASM API 수준으로 수행했다.

주의 사항(제외 범위): 외부 Microsoft Word/한컴오피스 직접 재열기, 크로스 앱 구조 MIME 상호운용 및 Windows/macOS·Wayland 수용은 NOT RUN이다.


## 11. P0 — S1-FONT-TYPING collapsed-caret 서식 유지 (2026-11-21)

### 재현과 수정

- DOCX 회귀를 WordCraft 실제 엔진 IPC 경로에서 재현했다. 기존 10pt 문장을 선택한 뒤 collapsed caret에 24pt를 지정하고 같은 caret 위치로 돌아오는 포인터 입력이 `caret.set`을 호출해 pending next-input formatting을 지웠다. 선택 교체와 실제 다른 위치로 이동은 구분해 확인했다.
- `src-tauri/src/adapters/wordcraft/engine.rs`는 collapsed selection의 비확장 포인터 적중이 현재 실제 caret과 같을 때만 caret 재설정을 생략한다. 다른 위치로 이동하는 기존 navigation 정책과 안전 검사는 유지한다.
- `DocxSurface.tsx`의 composition overlay 크기는 WordCraft view의 effective `chars.size`를 우선 사용하고 값이 없는 경우에만 기존 caret-height 추정을 사용한다.
- RHWP는 공유 구현으로 바꾸지 않았다. HWP/HWPX Release WASM에서 `pointAt` 이후 pending 글자 크기·색·강조·아래첨자, 취소된 composition, Hangul/Latin 입력을 형식별 문서로 검증했다.

### 수락 및 보존 증거

| 확인 | 결과 |
|---|---|
| DOCX Rust 회귀·T009 | `GEUL_SANDBOX=userns-root-bwrap npm run rust -- test --lib stage1_docx_` — 13/13 PASS. 포커스 복귀, 반복 입력·문단/선택·의도적 이동, 글꼴·색·강조·위/아래 첨자, Undo/Redo, T009 저장, WordCraft 독립 재열기를 확인했다. |
| DOCX 화면 모델·렌더 | `npx vitest run src/components/Editor/wordcraft/DocxSurface.test.tsx` — 13/13 PASS; IME overlay 24pt. 엔진 렌더 페이지도 10pt/24pt caret geometry와 PNG 차이를 확인했다. |
| HWP/HWPX Release WASM·저장 | `scripts/tests/stage1-format.wasm.test.ts` — 두 실제 형식 PASS. pending 서식, 취소, 반복 입력, T009 게시와 독립 WASM 재열기를 확인했다. |
| Linux X11 Native DOCX·IBus | `scripts/tests/native-ibus-session.py --hangul-initial-mode hangul -- ... native-stage1-font-typing.py` — PASS. XTEST를 통한 trusted IBus Hangul composition, 포커스 복귀, `한글 ABC`, Undo/Redo, T009 `saved`/synced, 새 WordCraft session 재열기를 확인했다. [추적 가능한 실행 보고서](stage1-font-typing-acceptance.json). |
| 저장된 DrawingML | Native 출력의 `word/document.xml`에서 기존 문자열은 `w:sz=20`(10pt), 입력 문자열은 별도 run의 `w:sz=48`(24pt). ZIP 무결성 PASS; 재열기 모델 끝 caret도 24pt. |
| TypeScript / UI | `npm run typecheck` 및 대상 Vitest PASS. |

이 수락은 DOCX Linux X11 실제 IME 입력을 포함한다. HWP/HWPX의 이 회귀에 대한 Native GUI 직접 입력, Windows/macOS, Microsoft Word/한컴오피스 상호운용은 **NOT RUN**이다. HWP/HWPX는 Release WASM 실제 문서·저장 경로로 확인했으며 포맷별로 다른 엔진 경계를 유지한다. 이 항목의 로컬 커밋은 실행 ledger가 반영되면 기록한다.


