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
