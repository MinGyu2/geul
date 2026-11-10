# 핵심 문서 삽입 기능 — 2026-11-10

## A. 결과

**부분 완료.** 세 명령의 제품 경로와 HWPX/DOCX 저장 기능을 연결했다. DOCX·HWPX 표, 그림, 글머리표는 기능별 경계에서 저장·재열기 검증을 마쳤다. HWP에서는 세 기능 모두 T009 저장 보존 계약을 통과하지 못하므로 계속 비활성이다. Linux GUI/IBus 수용은 수행하지 않았다.

| 기능 | DOCX | HWP | HWPX |
|---|---|---|---|
| `insert.table` | 구현·저장/재열기 검증 | 비활성: HWP DocInfo/본문 참조를 보존하는 새 표 생성 규칙 미입증 | 구현·실제 저장 서비스 게시·Release WASM 재열기 검증 |
| `insert.image` | 구현·저장/재열기 검증(본문 삽입 가능 조건에 한함) | 비활성: BinData/컨트롤 참조 보존 규칙 미입증 | 구현·실제 저장 서비스 게시·Release WASM 재열기 검증 |
| `paragraph.bullets` | 구현·저장/재열기 검증 | 비활성: HWP DocInfo 번호 정의의 새 참조 규칙 미입증 | 구현·실제 저장 서비스 게시·Release WASM 재열기 검증 |

## B. Git 및 엔진 경계

시작·검증 종료 기준 checkout은 `master`, HEAD `d94166a0e2c9895b40d3b6b82bf00b6c16851510`이다. RHWP submodule은 `1a76570e833917d15817415a53c09ad61ab3203f`, WordCraft는 `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5`다. submodule·업스트림 엔진·패치·WASM은 수정하지 않았다. 이 기록의 검증 기준은 로컬 커밋 전 checkout이다. 최종 로컬 커밋과 종료 HEAD는 작업 최종 보고 및 Git 로그를 따른다. push는 금지했고 수행하지 않았다.

고정 엔진에는 필요한 기반 기능이 있다. WordCraft는 실제 표/셀 편집, `insert.picture`, WordprocessingML 글머리표 기능을 제공한다. RHWP는 표·그림 컨트롤과 문단 머리말 속성을 읽고 쓰는 API를 제공한다. 막힌 HWP 지원은 API 부재 판정이 아니다. 현재 T009 비교기는 HWP DocInfo 변경과 새 리소스 참조를 안전하다고 증명하지 못해 거부한다. HWPX는 애플리케이션의 저장 비교기에 표 테두리·기본 글머리표 정의 추가와 그림 리소스/참조 추가를 제한적으로 허용하는 규칙을 더했다.

초기 능력 분류와 이번 통합 범위는 다음과 같다. “API 존재”를 제품 지원 근거로 단독 사용하지 않았다.

| 기능 | WordCraft / DOCX | RHWP / HWP | RHWP / HWPX |
|---|---|---|---|
| 표 | Existing primitive ready → adapter integration 구현 | Requires preservation-rule changes: DocInfo 테두리 정의 추가·기존 레코드 보존 증명 미완료 | Requires adapter integration + preservation-rule changes → 구현·검증 |
| 그림 | Existing primitive ready → 고정 그림 연산·native import 구현 | Requires preservation-rule changes: BIN_DATA/DocInfo 추가·컨트롤 참조 증명 미완료 | Requires adapter integration + preservation-rule changes → 구현·검증 |
| 글머리표 | Existing primitive ready → `para.bullets`·번호 정의 추가 계약 구현 | Requires preservation-rule changes: Bullet/ParaShape 정의 추가·참조 증명 미완료 | Requires adapter integration + preservation-rule changes → 구현·검증 |

WordCraft `insert.table`/`insert.picture`/`para.bullets`, RHWP `createTable`/`setTableProperties`/`insertPicture`/`setPictureProperties`/`ensureDefaultBullet`/`applyParaFormat`/`getParaPropertiesAt`를 실제 소스와 출력으로 확인했다. HWP를 위한 새 원본 DocInfo prefix 소유권·덧붙임 및 BinData 참조 계약은 이번에 구현하지 않았다. 임의 DocInfo 변경을 허용하지 않는다.

## C. 표 삽입

Insert 탭의 표 명령은 접근 가능한 행/열 입력을 연다. 기본은 2×2, 허용 범위는 1–32행, 1–16열, 총 256셀 이하이다. 입력은 registry capability 및 활성 편집 세션을 거쳐 기존 mutation queue로 간다. 선택된 텍스트를 조용히 지우지 않으며 표 생성은 접힌 커서의 본문 문단에서만 허용한다. 표 안에 표를 넣는 기능은 제공하지 않는다.

DOCX는 WordCraft의 실제 표 연산으로 본문 표와 셀 문단을 만든다. 셀 안에서 텍스트 입력과 셀 이동을 지원한다. HWP는 비활성이다. HWPX는 RHWP 표 컨트롤을 만들고, 표 생성 직후 기본 `TopAndBottom` 텍스트 감싸기의 attr/common 표현을 기존 `setTableProperties` API로 일치시킨 뒤 실제 저장 서비스 경계를 통과시킨다. 빈 셀 구조와 내용 있는 셀을 포함한 실제 출력의 모델 재열기를 검증했다.

## D. 그림 삽입

그림 명령은 Linux native chooser에서만 경로를 선택한다. 프런트엔드는 임의 경로를 전달하지 않고 좁은 Tauri import 명령이 선택 파일을 읽는다. PNG/JPEG 실제 서명과 완전한 디코드가 필요하다. 입력은 16 MiB 이하, 가로·세로 각각 8192 이하, 총 16M 픽셀 이하, 디코더 할당 예산은 64 MiB다. 취소/검증 오류는 편집 연산을 만들지 않는다. 비동기 완료 뒤 세션, load generation, revision, caret, 편집 가능 상태, IME 및 pending 작업을 다시 확인한다.

첫 레이아웃은 인라인이고 종횡비를 유지한다. DOCX는 WordCraft의 실제 그림/미디어/relationship 연산을 쓴다. 그러나 본문 밖 story에 인라인 개체가 있으면 새 그림 명령은 비활성이다. 고정 WordCraft 저장 writer가 그 뒤 drawing ID를 다시 매겨 T009가 관련 없는 story 변경으로 거부하는 사례를 확인했기 때문이다. HWP는 비활성이다. HWPX는 실제 이미지 리소스와 그림 컨트롤을 저장하며 `TreatAsChar` 인라인 속성을 보존한다. PNG/JPEG 둘 다 임베딩·재열기됐다. 게시 HWPX의 ZIP `BinData` 항목을 따로 추출해 입력 파일과 바이트 단위로 대조했고 둘 다 일치했다. RHWP 렌더 이미지 API는 JPEG를 렌더링 가능한 PNG 바이트로 정규화해 반환할 수 있어 원본 임베딩 검증은 ZIP 리소스를 기준으로 했다.

## E. 글머리표

`paragraph.bullets`는 실제 단일 단계 unordered-list 의미를 쓴다. 문자 `•`를 본문에 삽입하지 않는다. DOCX는 numbering definition과 문단 참조를 사용하고, 본문 비표/표 밖 선택 문단의 적용/해제를 지원한다. HWP는 비활성이다. HWPX는 기본 글머리 정의를 만들거나 재사용하고 문단 속성을 연결한다. 이어쓰기와 빈 항목에서 Enter로 목록을 끝내는 동작, 해제 뒤 일반 문단, 한글/유니코드 텍스트를 검증했다. HWPX 빈 항목 종료는 commit 응답이 오기 전에도 RHWP 모델 상태를 기준으로 판단한다.

## F. UI·안전 경계

명령 ID는 `insert.table`, `insert.image`, `paragraph.bullets`로 유지한다. UI는 registry → capability → 활성 session → 기존 queue → engine adapter 순서로 실행한다. 제한된 파일 import 외에는 IPC에 임의 엔진 명령이나 경로를 노출하지 않는다. 읽기 전용/보호, IME composition, pending edits, 문서 전환, stale revision, 저장·닫기 상태를 검사한다. DOCX history는 고정 WordCraft 기록을 따른다. 일반 RHWP Undo/Redo는 활성화하지 않았다. T009 안전 저장 및 기존 recovery 경계는 유지했다.

## G. 변경 파일

| 정확한 경로 | 목적 |
|---|---|
| `docs/architecture/command-registry.md` | 새 명령 경계와 상세 보고 링크. |
| `docs/architecture/core-insertions.md` | 구현 범위·아홉 조합 행렬·검증·남은 작업 보고. |
| `docs/architecture/save-preservation.md` | 좁은 추가 계약과 실제 게시 검증 링크. |
| `docs/planning/plan.md` | 실행 결과와 남은 HWP/native 작업 추가. |
| `docs/planning/spec.md` | 기존 수용 상태를 유지하고 부분 완료 범위 추가. |
| `docs/planning/tasks.md` | 기존 체크를 유지하고 부분 완료 기록 추가. |
| `scripts/tests/core-features.wasm.test.ts` | 승인 WASM의 실제 편집·재열기·손상 거부·다음 저장 세대 증거 생성. |
| `src-tauri/Cargo.lock` | 이미 고정된 image crate를 geul 직접 의존성으로 연결. |
| `src-tauri/Cargo.toml` | 동일 image 버전의 PNG/JPEG 디코더 재사용. |
| `src-tauri/build.rs` | 그림 import 고정 명령 권한 생성. |
| `src-tauri/capabilities/default.json` | picture_import 하나만 추가 허용. |
| `src-tauri/src/adapters/wordcraft/engine.rs` | 고정 표/그림/글머리표 연산, 문맥·입력 검증과 상태 반환. |
| `src-tauri/src/adapters/wordcraft/tests.rs` | 빈 표·보호/선택·기록·IPC 계약 회귀 검증. |
| `src-tauri/src/lib.rs` | 좁은 네이티브 그림 import 명령 등록. |
| `src-tauri/src/picture.rs` | 선택 파일 bounded 읽기, 서명·디코드·차원 검증. |
| `src-tauri/src/services/files.rs` | 기존 Linux chooser에 PNG/JPEG 필터 추가. |
| `src-tauri/src/services/save/package.rs` | 기존 정의·미디어를 보존하는 DOCX/HWPX 제한적 추가 증명. |
| `src-tauri/src/services/save/tests.rs` | 실제 DOCX 게시·재열기, 손상 거부, HWPX 실제 게시 통합 시험. |
| `src/App.tsx` | 그림 chooser의 탭 소유권 및 표 입력창의 커서 소유권 재확인. |
| `src/adapters/docx.test.ts` | 새 상태 필드·잘못된 응답 거부 시험. |
| `src/adapters/docx.ts` | 고정 연산 DTO와 선택적 상태 필드의 엄격한 파싱. |
| `src/commands/capability.ts` | 저장·보호 상태에서 새 명령 차단. |
| `src/commands/commands.ts` | 기존 dispatcher에서 표 입력/비동기 그림 실행 연결. |
| `src/commands/coreFeaturesDialog.test.tsx` | 한국어/영어 표 입력·검증·키보드 시험. |
| `src/commands/parameters.ts` | 정수 행·열·총 셀 수 검증. |
| `src/commands/registry.ts` | 정확한 세 command ID 등록. |
| `src/commands/target.ts` | 표 인자와 그림 import/session 계약. |
| `src/components/Editor/CommandInputDialog.tsx` | 키보드 접근 가능한 기본 2×2 행/열 입력. |
| `src/components/Editor/coreFeatures.test.ts` | 취소·중복 chooser·탭/커서/IME/닫기 전환 안전 시험. |
| `src/components/Editor/rhwp/RhwpEditorSession.ts` | HWPX 세 기능, 선택·Enter·revision·기존 mutation 경로 연결. |
| `src/components/Editor/rhwp/rhwpModule.ts` | 실제 고정 RHWP API의 선택적 타입 선언. |
| `src/components/Editor/wordcraft/DocxEditorSession.ts` | 기존 DOCX queue, async 그림 재검증과 명령 상태. |
| `src/components/Editor/wordcraft/testing.ts` | 새 DTO 상태 및 지원하지 않는 가짜 문서 연산의 명시적 거부. |
| `src/language/en.json` | 영어 입력창·그림 오류 문구. |
| `src/language/ko.json` | 한국어 입력창·그림 오류 문구. |

Rust `image` crate는 Cargo.lock에 이미 있던 버전을 재사용한다. 엔진 submodule·패치·생성 WASM 변경과 생성 fixture 커밋은 없다.

## H. 기능별 검증 행렬

| 기능/형식 | 구현·편집 | 저장/재열기 | native Linux UI |
|---|---|---|---|
| 표 / DOCX | 실제 WordCraft 표·셀 입력 | T009 계약 및 WordCraft 테스트 경계 | NOT RUN |
| 표 / HWP | 비활성 | 미지원; 보존 검사 유지 | NOT RUN |
| 표 / HWPX | 표/셀 입력·이동 | 실제 저장 서비스 게시 및 Release WASM 재열기 PASS | NOT RUN |
| 그림 / DOCX | PNG/JPEG 실제 삽입, 제한된 story/caret | 미디어/relationship 보존 및 WordCraft 저장 시험 | NOT RUN |
| 그림 / HWP | 비활성 | 미지원; 보존 검사 유지 | NOT RUN |
| 그림 / HWPX | PNG/JPEG 임베딩·인라인 렌더 모델 | 실제 저장 서비스 게시, Release WASM 재열기, ZIP BinData exact-byte 비교 PASS | NOT RUN |
| 글머리표 / DOCX | 문단 목록 켜기/끄기·선택 | numbering 의미의 WordCraft 저장/재열기 시험 | NOT RUN |
| 글머리표 / HWP | 비활성 | 미지원; 보존 검사 유지 | NOT RUN |
| 글머리표 / HWPX | 선택 문단·Enter 계속/종료 | 실제 저장 서비스 게시 및 Release WASM 재열기 PASS | NOT RUN |

HWPX의 최종 저장물 7개(`table`, `image-png`, `image-jpg`, `bullets`, `bullets-off`, `mixed`, `second-cycle`)를 T009 production service로 게시했다. 승인 Release WASM에서 각 파일을 별도로 다시 열어 proof의 SHA-256, format, pages, text, controls와 비교했다. 7개 모두 PASS다. 이는 GUI 수용이나 실제 Hancom 상호운용 시험이 아니다.

그림 저장 파일은 별도 ZIP 검사로 선택 원본과 임베디드 bytes를 비교했다: PNG `BinData/image1.png`, 147 bytes, SHA-256 `8ccfdfc4c3b272c1505f68a8f14c4ba2402e427dbaf8b40b404b0f74cfe61a54`; JPEG `BinData/image1.jpeg`, 630 bytes, SHA-256 `f0a7fe2fe90e08b35e88acd651ecc81f6de8186544d1acedbb017d9c28a9d8c1`. 둘 다 2/2 exact match다.

## I. 검증 기록

아래 PASS 명령의 종료 코드는 모두 0이다. GUI NOT RUN에는 성공 종료 코드나 PASS 수를 부여하지 않는다. 초기 frontend IPC 계약 7 FAIL·Rust JSON 계약 1 FAIL·Clippy 복합 타입 경고는 수정하고 영향받은 검사를 재실행했다.

기준 cwd는 이 저장소 루트다. 전체 로그와 정확한 명령/종료 코드, JSON 요약은 로컬 `target/core-features/verification/`에 있다.

| 명령 | 결과 |
|---|---|
| `npm test` | PASS, 80 files / 1367 tests |
| `npm run lint` | PASS |
| `npm run typecheck` | main이 같은 변경 상태에서 PASS 보고; 이 검증 배치에서 재실행하지 않음 |
| `GEUL_SANDBOX=userns-root-bwrap npm run rust -- test services::save -- --nocapture` | 앞선 동일 상태에서 PASS, 194 passed / 15 ignored; 불변 save 서비스 테스트 재사용; 다문단 글머리표 게시/해제 시험은 아래 별도 실행 |
| `GEUL_SANDBOX=userns-root-bwrap npm run rust -- test adapters::wordcraft -- --nocapture` | 앞선 동일 상태에서 85 passed / 2 ignored; 초기 1 FAIL은 새 필드가 빠진 JSON 계약 기대값이었다. 수정 후 단독 재실행해 PASS. 집계는 86 passed / 2 ignored |
| `GEUL_SANDBOX=userns-root-bwrap npm run rust -- test core_docx_selected_paragraph_bullets_publish_and_remove -- --nocapture` | 추가 1 PASS: 두 선택 문단 적용/게시/재열기와 해제/재게시/재열기 |
| `GEUL_SANDBOX=userns-root-bwrap npm run rust -- test picture::tests -- --nocapture` | 앞선 동일 상태에서 PASS, 1 passed |
| `npm run rust -- fmt --check` | 최종 파일 상태 PASS |
| `GEUL_SANDBOX=userns-root-bwrap npm run rust -- clippy --all-targets -- -D warnings` | PASS |
| `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/core-features.wasm.test.ts` | PASS, 6 tests |
| `GEUL_CORE_WASM_OUT=... GEUL_SANDBOX=userns-root-bwrap npm run rust -- test core_hwpx_real_publication_from_verified_wasm_outputs -- --ignored --nocapture` | PASS, 1 ignored-marked integration test explicitly 실행, 7 files posted |
| `node target/core-features/verification/verify-publications.mjs` | PASS, 7 Release WASM independent reopen comparisons |
| `python3` ZIP `BinData` SHA-256/bytes comparison for published `image-png.hwpx` and `image-jpg.hwpx` | PASS, 2/2 selected image byte comparisons |
| `GEUL_SANDBOX=userns-root-bwrap VITE_GEUL_TEST_HOOKS=1 npm run tauri -- build --debug --no-bundle` | PASS, 실제 Debug 앱 생성. 제품 앱 GUI 실행은 아님 |

Linux native launcher 수용은 NOT RUN/BLOCKED다. 필요한 설치 상태 `ibus-dconf`, Xvfb, 유효 display가 없어 앱 리본·chooser·IBus 입력을 조작하지 않았다. 설치 변경은 하지 않았다. 빌드에는 500 kB chunk 크기 경고가 있었지만 빌드 성공을 막지 않았다.

## J. 남은 작업

1. HWP에서 DocInfo 정의/참조와 BinData/그림 컨트롤 추가를 T009가 좁게 검증할 수 있는 기록 수준 계약을 설계하고 실제 HWP 저장/재열기 검증을 추가해야 한다. 그 전까지 HWP 세 명령은 비활성이다.
2. Linux X11/WebKitGTK + IBus 환경에서 chooser, 문서 전환 중 취소, IME, 실제 화면 렌더, 저장/재열기를 수용해야 한다. GUI/native 수용은 아직 실행되지 않았다.
3. DOCX 그림은 본문 밖 story에 인라인 개체가 없는 문서에서만 활성화된다. Word와 Hancom 실제 앱 상호운용도 NOT RUN이다.
4. floating/wrapping 그림, 중첩 표, 다단계/사용자 지정 목록, 고급 표 디자이너는 구현하지 않았다.

## K. 권고

DOCX/HWPX 표·글머리표와 지원되는 본문 조건의 그림 삽입은 엔진·안전 저장 수준에서 검증된 제품 경로다. 일반 Linux 사용의 최종 수용은 GUI·IBus 검증 뒤에 판단한다. **세 명령 모두 HWP에서 비활성 유지**하고 DOCX 그림의 제한 문맥에서도 비활성 안내를 유지한다. GUI 수용이 완료되기 전 native Linux 사용을 완전히 수용했다고 표시하지 않는다. 다음 기능으로 넘어가기 전에 HWP 보존 경계와 native GUI 수용을 완료하는 것을 권한다.

앞선 A–K 절은 Phase 1의 제품 삽입/기능 게이트 상태다. 아래는 현재 T009 저장 보존 경계이며 HWP 제품 명령은 계속 비활성이다.

## HWP T009 보존 경계 — Phase 2

지원 범위는 기본 표, 인라인 PNG/JPEG, 단일 단계 U+2022 글머리표다. 이 경계는 저장 검증이지 HWP 기능 활성화, native GUI 또는 한컴 외부 수용이 아니다.

새 표는 직사각형 최대 32×16 및 256셀, 병합 없음(span 1), 셀당 한 문단이다. 새 표의 비어 있지 않은 셀은 지원하고 기존 표 subtree는 그대로 보존한다. 기존 표 셀 텍스트 변경은 현재 범위 밖이다. 기본 BorderFill을 재사용할 수 있다. 열 너비·행 높이 배열과 개수가 맞아야 하고 열 너비 합계가 표 폭과 같아야 한다. TextWrap 정규화는 필수다.

새 그림은 인라인 PNG/JPEG와 전체 bounded decode만 허용한다(입력 16 MiB, 각 변 8192, 16 megapixel, decoder 출력 64 MiB). 신규 BinData 저장 ID는 조밀해야 하고 기존 리소스는 유지한다. 링크/OLE/희소 ID의 새 생성, 미지 컨트롤과 새 ID 기반 picture 속성은 거부한다. 기존 링크/희소 리소스의 저장 의미는 아래 hardening 절에서 별도로 다룬다. 위치 기반 API에서 instance ID 0을 다루는 좁은 범위는 외부 응용의 ID 선택 안정성 증거가 아니다. 구조적 그림 검사는 운영 검증기에 있지만 입력/삽입 bytes의 해시 동일성은 실험 전용이며 production validator는 신뢰된 입력 영수증을 받지 않는다.

글머리표는 24바이트 BULLET의 U+2022, level 0, 원본 모양에서 좁게 파생한 54/58바이트 PARA_SHAPE로 제한한다. apply/remove/reuse를 확인한다. DocInfo의 원래 정의, 순서, ID, payload, level, 문맥과 opaque 레코드 위치는 보존한다. ID_MAPPINGS는 원래 길이를 유지하며 64바이트나 72바이트 동일 길이만 허용하고 64→72를 거부한다. 허용 추가 정의는 실제 count 증가와 일치해야 하며 T012 metric-shape proof와 조합한다.

BodyText 기록은 구조 위치 문맥과 LIST_HEADER 셀 참조를 함께 확인한다. 기존 문자·서식·컨트롤 앵커를 보존하고, 기존 첫 문단 secD/cold control이 정확히 유지된 경우에만 control flag 3→0 변화를 허용한다. 반대 방향, page-break 표식, 미지·미지원 BodyText 주석 변화와 opaque 레코드 재배치는 거부한다. 일반 문자 편집에는 기존 의미 재열기 보호를 유지한다. 구조 변경 시 알려진 빈 원본을 포함해 새 PrvImage를 요구한다.

미리보기 raster는 headless Firefox `capturePreviewRaster`에서 7개 사례를 확인한다. 이는 native app GUI 또는 Hancom 시험이 아니다. 저장/복구/원자 게시 경로는 기존 서비스 경로다. DOCX/HWPX 범위는 바뀌지 않고 세 HWP 명령은 계속 비활성이다.

### Phase 2 당시 구현 검증 기록 (역사적 수치)

최종 geometry/context helper를 포함한 당시 전체 `services::save` 결과는 199 PASS, 18 ignored이며 geometry focused 시험은 2 PASS, 2 ignored다. 당시 core의 실제 publication은 16 positive와 3 negative였고, E4 반복 저장을 더해 17 positive 산출물을 확인했다. 6개 지정 Canvas 사례도 통과했다. `save-final-reviewed.log`의 61개 synthetic mutation rejection, 삽입 그림 11개의 output hash 대조, Headless Firefox raster 캡처 7개 사례를 확인했다. 재열기 도구가 17개 positive를 다시 열었다. Phase 1의 432 검사는 이 수치에 포함하지 않는다. 증거는 제한된 Phase 3 서비스 통합을 시작하기에 충분하다. 전체 활성화 전에는 production eligibility, normalized setters, 실제 raster refresh와 재열기를 제품 저장 경로에 연결해야 한다. 외부 Hancom 실행은 별도 승인 조건이 아니다. HWP 기능 명령은 계속 비활성이다. 상세 실행은 `target/hwp-record-investigation/phase2/verification-close.json`을 참조한다.


## HWP 경계 hardening 추가 — 2026-11-10

기존 BinData와 신규 삽입 리소스는 별도 증명된다. 기존 정의/참조 의미와 스트림 정체성 및 bytes(또는 기존 T009가 허용한 압축 동등성)를 보존한다. 링크 리소스와 sparse 기존 storage ID/kind 2는 검사에서 생략하지 않지만 신규 embedded PNG/JPEG 스키마도 강제하지 않는다. 충돌 정의·누락/변경 스트림·dangling reference는 거부한다. 새 그림은 dense ordinal, kind 1/attr 0x0101, 시그니처·decode·size·실제 스트림·reachability 규칙을 계속 만족해야 한다.

실 RHWP 일반 텍스트 편집에서 embedded PNG/JPEG, 링크 그림, 희소 ID의 resource preservation 분류를 확인했다. PNG/link/sparse 결과는 safe였고 JPEG는 resource는 `VALID_PRESERVATION`이나 별도 `PreviewStale(PrvText)`로 unsafe였다. 링크/희소 원본의 Phase 2 `RecordsChanged` 과잉 거부는 보완됐다. 다만 새 그림을 함께 넣을 때 엔진이 기존 정의를 재작성하거나 storage를 추가한 혼합 링크/희소 케이스는 T009가 거부한다. storage-stored `.dat` 출력은 baseline unsafe/`PartAdded`, 기본 압축 storage fixture는 baseline unknown/`PartAdded`+`OriginalMalformed`로 각각 `BASELINE_UNSUPPORTED`; 이를 일반 OLE 호환으로 확대 해석하지 않는다.

문단 proof는 원래 순서의 UTF-16/control 단위를 선형 정렬해 경계 시작의 shape/style/start flags와 CR/end token을 검사한다. 빈 문단은 보존하고, CR terminator의 실제 char-shape run ancestry도 검사한다. 따라서 빈 문단의 기존 char-shape가 바뀌는 mutation은 거부하되, 증명된 T012 metric append는 허용한다. 기존 경계의 이동·병합 및 동일 문자 재배치는 금지한다. 지원된 split은 기존 단위가 접두/접미 문맥에서 순서를 유지해야 하며 시작 flag는 prefix에, 끝 표식은 suffix에 귀속된다. 검증된 텍스트 삽입·삭제·split은 허용된다. 모델에 없는 legacy layout은 새로운 malformed 판정을 만들지 않고 기존 framing/opaque/reference/reopen 정책을 따른다.

HWP production reopen 비교는 구조가 바뀐 경우 문단·목록 의미·표 셀 기하/내용/형식·그림 종류/inline/크기를 비교하며, optional API가 없고 구조 inventory가 바뀌었으면 필요한 근거 없이 통과하지 않는다. 자세한 예산, 비교 범위 및 trusted picture input-hash 한계는 [저장 보존 경계](save-preservation.md#hwp-t009-경계-hardening--2026-11-10)에 기록했다. 제품 명령은 계속 비활성이다.

이번 실행 증거는 서비스 저장 207 PASS/22 ignored, 실제 게시/재열기 24건, 실엔진 거부 6건, 합성 거부 98건이다. Phase 2의 199/18·61·17·7 Canvas 결과는 당시 기록이지 이번 재실행 결과가 아니다. 상세 내역은 [hardening 보고서](../../target/hwp-boundary-hardening/REPORT.ko.txt) 및 [독립 감사](../../target/hwp-boundary-hardening/independent-audit.json)를 참조한다.
