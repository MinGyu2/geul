# 핵심 문서 삽입 기능 — 2026-11-10

> **HWP 제품 명령 연결(2026-11-10, Phase 3):** 아래 A–K와 Phase 2 절의 "HWP 비활성"은 당시 기록이다. 현재 HWP의 세 명령은 T009 제한 부분집합 안에서만 활성화된다. 현재 경계와 검증은 [HWP 제품 명령 연결](#hwp-제품-명령-연결--phase-3-2026-11-10)을 따른다.

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


## HWP 제품 명령 연결 — Phase 3 (2026-11-10)

T009 저장 보존 계약(Phase 2·hardening)은 바꾸지 않았다. 기존 명령 ID(`insert.table`, `insert.image`, `paragraph.bullets`)와 리본·표 입력창·native chooser·mutation queue를 그대로 쓴다. 새 UI는 없다. 변경은 `RhwpEditorSession`의 형식 자격과 HWP 전용 정규화·삽입 직후 검증뿐이다. HWPX·DOCX 경로는 바뀌지 않았다.

### 자격(엔진 API ≠ 저장 수용)

HWP 구조 명령은 다음을 모두 만족할 때만 snapshot에 나타나고 `execute`/`executeImage`가 같은 판정으로 다시 확인한다.

- 기존 공통 조건: 편집 가능, IME 트랜잭션 없음, 불확실 모델 아님, 대기·확정 중 편집 없음(표·그림), 저장 중 아님, 보호 문서 아님, 비동기 그림 완료 시 세션·epoch·revision·caret 소유 재확인.
- 상세 재열기 근거 API 전부 존재: `getSectionCount`, `getParaPropertiesAt`, `getBulletList`, `getTableProperties`, `getCellInfo`, `getCellProperties`, `getPictureProperties`, `getControls`. 없으면 구조 변경을 검증할 수 없으므로 `engineUnsupported`.
- 불러온 원본의 HWP 재열기 모델 baseline이 **complete**일 것(2026-11-10 Phase 3 hardening). baseline이 있어도 `complete=false`(중첩·미지 컨트롤, 검증 불가 표, 해석되지 않는 글머리표 정의 등)이면 `engineUnsupported`. 일반 텍스트 편집·열기·읽기는 이 판정과 무관하다.
- caret/선택이 section 0(검증된 `BodyText/Section0` 삽입 증명 범위). 다른 구역은 비활성.
- **원본 사전검사 SAFE**(Phase 3 hardening): 위 정적 조건을 만족하는 HWP를 불러오면 세션이 원본 사전검사(기존 `preflight`, 같은 T009 판정)를 한 번 시작한다. 결과는 epoch·load generation·원본 정체성(게시 횟수)에 묶인다. 확인 전/확인 중은 `originalChecking`, unsafe·unknown·platform·전송 실패는 `originalUnverified`로 세 명령 모두 비활성이다. 이 검사는 보이는 저장 상태와 `saveCheck`를 바꾸지 않으며, 다른 문서·이전 generation·이전 원본의 늦은 응답은 무시한다. 자동 재시도는 없다: 저장 검사(수동)·다시 불러오기·게시가 재확인 경로다. 수동 저장 검사의 결과도 자격을 갱신하며, 나중 검사가 실패하면 이전 SAFE를 쓰지 않는다. 게시 성공 또는 게시 결과를 알 수 없는 저장 전송 거부 뒤에는 원본 정체성이 바뀌므로 다시 확인한다. 첫 저장은 같은 원본·같은 검사 일련번호의 SAFE 판정을 재사용해 사전검사를 두 번 하지 않는다.
- **빈 글머리표 Enter(2026-11-10 후속):** 기존 빈 글머리표 문단에서 Enter는 원본 사전검사 상태(CHECKING·SAFE·BLOCKED·UNKNOWN·전송 오류)와 관계없이 목록 종료(그 문단의 글머리표 해제, 문단 수·텍스트·정의 불변, caret 유지, revision +1)다. 이전에는 CHECKING·BLOCKED·UNKNOWN·다시 불러온 직후에 일반 분할(빈 글머리표 문단 하나 추가)이 되어 같은 키 입력의 의미가 비동기 검사 시점에 따라 달랐다(실제 Release WASM으로 재현, `scripts/tests/hwp-bullet-enter.wasm.test.ts`). 종료는 기존 heading을 지울 뿐 정의·개체를 만들지 않으므로 정적 조건(상세 API·complete baseline·section 0)만 요구한다. 새 글머리표 적용(`paragraph.bullets`)·표·그림은 계속 SAFE를 요구한다. 저장은 여전히 원본 사전검사와 편집 출력 T009 판정을 거치므로 unsafe 원본은 게시되지 않는다. 정적 조건을 만족하지 않는 HWP는 이전과 같이 일반 분할이며, 비어 있지 않은 글머리표의 Enter 이어쓰기·일반 문단 Enter·HWPX는 바뀌지 않았다. 엔진이 종료를 거부하면 revision 없이 편집을 멈춘다(fail closed).
- SAFE는 원본이 사전검사를 통과했다는 뜻일 뿐이다. 편집한 출력은 저장 때 T009가 다시 판정한다(예: OPAQUE-001처럼 원본은 SAFE이나 삽입 뒤 거부되는 문서).
- 기능별: 표·그림은 접힌 caret의 본문 문단(표 셀·선택 불가), 글머리표는 본문 문단 범위(셀 불가, 256문단 이하). 표 크기는 기존 입력 검증(1–32행, 1–16열, 256셀 이하).

### 표

`createTable` 뒤 HWP는 `setTableProperties({textWrap:"TopAndBottom", horzRelTo:"Column", outerLeft/Right/Top/Bottom:283})`로 정규화한다. 실제 Release WASM에서 `createTable`은 live CommonObjAttr(감싸기 비트, 가로 기준 Para, 바깥 여백 0)와 직렬화하는 CTRL_HEADER(attr `0x082a2210` = 가로 기준 Column, 여백 283)가 다르다. textWrap만 정규화하면 상세 재열기 비교가 `horzRelTo`·`outer*` 차이로 실패한다(회귀 시험으로 고정). 위 값은 T009 표 증명이 요구하는 attr를 그대로 유지하면서 live 모델을 자기 출력과 같게 만든다. 삽입 직후 `insertedBasicTable`이 행·열·셀 수, span 1, 셀당 한 문단, 직사각 배치, 정규화 속성, 컨트롤 TextWrap 비트를 확인한다. 실패하면 mutation이 실패해 편집을 멈춘다(raw TBL-001은 저장 대상이 되지 않음). caret은 첫 셀로 가고 기존 셀 입력·셀 이동을 쓴다.

### 그림

기존 native chooser·bounded import(PNG/JPEG 서명·완전 디코드, 16 MiB, 각 변 8192, 16M 픽셀)를 그대로 쓴다. `insertPicture` 뒤 `setPictureProperties({treatAsChar:true})`, 그리고 `insertedInlinePicture`가 treatAsChar·양수 크기·컨트롤 props 일치를 확인한다. 링크/OLE/floating 생성 경로는 없다.

### 글머리표

`ensureDefaultBullet("•")` + `applyParaFormat({headType:"Bullet", numberingId, paraLevel:0})`. 단일·여러 문단 적용, 해제, 재적용, 정의 재사용, Enter 이어쓰기와 빈 항목 Enter 종료(HWPX와 같은 경로)를 지원한다. 본문 텍스트에 글리프를 넣지 않는다. 번호·다단계·사용자 정의 글머리표는 없다.

### 검증(이 변경 상태에서 실행)

| 검사 | 결과 |
|---|---|
| `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/hwp-core-commands.wasm.test.ts` (generate) | 20 PASS: 자격·실행 시 재확인·API 누락·IME/pending/선택/셀·T009 범위 밖 크기·raw 표/비인라인 그림 거부·chooser 취소/소유 상실/모델 변경/잘못된 입력·거부된 사전검사; 제품 명령 7건의 실제 저장 payload + OPAQUE-001 거부 |
| `GEUL_HWP_CONTRACT_DIR=src-tauri/target/hwp-product-commands/engine … cargo-geul.py test --lib hwp_contract_real_engine_publication -- --ignored` | PASS: 제품 payload 7건 production `save_with_options` 게시(PrvImage 재생성, durable, dirty false, 게시 bytes = 검증 bytes), OPAQUE-001 표 삽입 `recordsChanged` 거부·원본 보존 |
| 같은 driver `repeat` + `GEUL_HWP_REPEAT=1` 게시 | PASS: 게시된 혼합 문서를 새 엔진 세션으로 열어 모델 일치 확인 후 본문 입력+JPEG 추가, 두 번째 게시 |
| 같은 driver `verify` | PASS: 게시 8건 fresh Release WASM 재열기, 상세 모델 complete·일치, 임베디드 이미지 bytes SHA-256 = 선택 입력(PNG `8ccfdfc4…`, JPEG `f0a7fe2f…`) |
| `services::save` Rust suite | 207 PASS / 22 ignored(합성 HWP 계약 거부 98건 포함) |
| HWPX `core-features.wasm` 6 PASS, HWPX 실제 게시 1 PASS, hardening 상품 모델 24 PASS, preview capture 2 PASS, publication identity 15 PASS, advanced(T012) 8 PASS, `npm test` 81 files / 1427 PASS, `npm run lint`·`npm run typecheck` PASS | |

제품 시험의 백엔드 응답은 controlled다. 실제 게시는 제품이 보낸 정확한 bytes·손실 보고·reopen 근거로 Rust production 서비스가 수행했다. 미리보기 raster는 jsdom에 canvas가 없어 같은 출력의 rsvg 렌더를 사용했다(제품이 reopened export 문서로 캡처를 요청함은 확인).

### 남은 경계

- 기존 표(재열기 뒤 포함)의 셀 텍스트 변경, 새 표 셀 안 Enter(셀당 여러 문단), 병합·중첩 표, section 0 밖 삽입은 T009 범위 밖이다. 저장 시 거부되며 원본은 보존된다.
- 그림 입력과 게시 리소스의 바이트 동일성은 시험에서만 확인했다. production validator는 신뢰된 입력 영수증을 받지 않는다.
- 한컴 원본처럼 비어 있지 않은 미리보기를 가진 문서는 PrvImage 재생성 조건을 따른다. 다구역·실제 한컴 작성 문서의 폭넓은 호환은 검증하지 않았다.
- Linux native GUI/IBus 수용: NOT RUN(Xvfb·ibus-daemon 없음). 외부 한컴 수용: NOT RUN.
- RHWP Undo/Redo 제한과 T012/T014 동작은 바꾸지 않았다.


## HWP 비GUI 저장·재열기 통합 수용 — Phase 4 (2026-11-10)

Phase 3 hardening(complete baseline + 원본 사전검사 SAFE 자격)을 적용한 제품 경로를 실제 저장 게시와 독립 재열기까지 연결해 검증했다. 위 "검증(이 변경 상태에서 실행)" 표는 Phase 3 당시 결과이며 아래가 이번 실행이다. T009 규칙·엔진·WASM은 바꾸지 않았다.

### 통합 방식(하네스 매개, Tauri IPC 아님)

1. `scripts/tests/hwp-core-commands.wasm.test.ts`가 승인 Release WASM으로 `RhwpEditorSession`을 열고, 로드 때 시작된 원본 사전검사에 production `save_check` 실제 판정으로 응답한 뒤 기존 명령(`execute`/`executeImage`)으로 편집한다. 제품이 `save()`에서 보낸 정확한 bytes·손실 보고·reopen 근거를 사례별 폴더(`src-tauri/target/hwp-phase4/engine`)에 기록한다. 백엔드 응답은 controlled이며 게시 증거가 아니다.
2. `scripts/tests/hwp-canvas/run.py`가 headless Firefox에서 production `loadRhwpModule` + `capturePreviewRaster`를 각 사례의 정확한 출력 bytes에 실행한다(실제 Canvas, `GEUL_RHWP_PROFILE=release`로 승인 generation 강제·검사).
3. `hwp_contract_real_engine_publication`(`GEUL_HWP_CANVAS=1`)이 그 bytes와 Canvas raster로 production `service::save_with_options`를 호출한다: 사전검사, 원시 판정(PreviewStale만), PrvImage 재생성, 최종 판정 safe, 원자 게시, durable·dirty false, 게시 bytes = 검증 bytes. 부정 사례는 게시 거부·원본 보존을 확인한다.
4. `repeat` 단계가 실제 게시 파일을 새 제품 세션으로 열어(자격 재확인) 두 번째 편집을 하고 같은 경로로 다시 게시한다. `verify` 단계가 모든 게시 파일을 새 엔진 인스턴스로 열어 비교한다.

### 양성 결과

| 사례 | 원본 | 편집(제품 명령) | 게시 | 독립 재열기 |
|---|---|---|---|---|
| P-table | 엔진 생성 HWP | 2×3 표, 두 셀 입력, revision 3 | PASS | 모델·셀·속성 일치 |
| P-table-max | 엔진 생성 HWP | 32×8(256셀), 마지막 셀 입력 | PASS(재열기 모델 17 ms, 제품 저장 경로 70 ms) | 일치 |
| P-image-png / -jpg | 엔진 생성 HWP | native chooser payload, 인라인 | PASS | 일치, 임베디드 bytes SHA-256 = 입력 |
| P-bullets | 엔진 생성 HWP | 한 문단→두 문단→해제→재적용, 정의 1개 재사용 | PASS | 일치 |
| P-bullets-enter | 엔진 생성 HWP | Enter 이어쓰기, 빈 항목 Enter 종료 | PASS | 일치 |
| P-bullets-off | 기존 글머리표 HWP | 두 문단 해제(정의 보존) | PASS | 일치 |
| P-combined | 엔진 생성 HWP | 두 문단 글머리표 + PNG + 2×2 표 + 셀 입력 | PASS | 일치 |
| P-sample | `test-image.hwp`(기존 임베디드 그림·비어 있지 않은 미리보기) | 글머리표 + PNG + 표 + 셀 입력 | PASS | 일치, 기존 그림 bytes 보존 |
| P-combined-2 | P-combined의 실제 게시 파일 | 본문 입력 + JPEG | PASS | 일치, 1차 표·셀·그림·글머리표 정의 보존 |

모든 양성 사례의 원시 출력 판정은 PreviewStale만이었고 Canvas raster로 재생성한 뒤 최종 판정 safe로 게시됐다.

### 부정 결과

- 게시 거부(production 서비스, 원본 bytes 보존, dirty 유지): OPAQUE-001 원본 표 삽입(`recordsChanged`), 엔진 직접 raw TBL-001 출력(`recordsChanged`·`reopenMismatch`), 사전검사 SAFE인 한컴 원본 `h-pen-01.hwp`의 표 삽입(`recordsChanged`, 아래 한계).
- 실제 제품 출력(P-combined)에 적용한 손상(`hwp_phase4_product_output_corruptions`): 새 BinData stream 누락(`referenceInvalid`), 그림 BinData 참조 dangling(`referenceInvalid`), floating 그림(`recordsChanged`), TBL-001 표 상태(`recordsChanged`), 잘못된 셀 span(`outputMalformed`), dangling 글머리표 참조(`referenceInvalid`), 기존 글머리표 정의 변경(`recordsChanged`), 미리보기 없음(`previewStale`) — 모두 게시 거부·원본 보존.
- 제품 세션: unsafe 원본은 일반 텍스트 저장도 save 요청 없이 `UnsafeSave`; 저장 대기 중 편집은 게시 뒤 `changedSince`로 미저장 유지; chooser 소유 상실·모델 변경·잘못된 입력, raw 표·비인라인 그림, getter 누락 거부(기존 시험).
- 파일 충돌·게시 실패·복구는 기존 `services::save` Rust 시험(재실행)에 의존한다.

### 한계(측정)

(역사적 측정 v1 — 아래 v2로 대체됨) `scripts/tests/hwp-sample-insertion-matrix.wasm.test.ts`(opt-in, 당시 `GEUL_HWP_SAMPLE_MATRIX=<json>`)로 RHWP 샘플 중 단일 구역·120 KB 이하 178개를 측정했다. complete baseline이면서 원본 사전검사 SAFE인 108개 중 한 번의 삽입이 T009를 통과한 문서는 글머리표·그림·표 각 6개, 일반 텍스트 20개다. 나머지는 엔진 재직렬화가 DocInfo/BodyText 기록을 바꿔(`recordsChanged`·`partAdded`·`outputMalformed`) 저장이 거부된다. 원본 사전검사는 무편집 출력만 비교하므로 이를 편집 전에 신뢰성 있게 예측할 수 없고, 제품은 이 경우 명령을 허용한 뒤 저장에서 거부한다(원본 보존). 따라서 현재 검증된 실사용 범위는 엔진(geul/RHWP)이 생성·저장한 HWP와 측정된 일부 문서다. 한컴 작성 문서 일반의 HWP 삽입 지원은 엔진 직렬화 개선 없이는 확장되지 않는다.

그 밖에: native GUI/IBus(Phase 5) NOT RUN, 외부 한컴 수용 NOT RUN, 입력 이미지 신뢰 영수증 없음(바이트 대조는 시험 소유 입력에 한함), section 0 밖·기존 표 셀 편집·병합/중첩 표·floating/링크/OLE·다단계 목록은 범위 밖이다.


## HWP 샘플 호환성 측정 v2 (2026-11-10)

Phase 4의 측정 v1(108 / 각 6 / 텍스트 20)은 연산 성공을 "예외 없음"으로, 재열기 일치를 호출자가 `reopen=true`로 단정했고 실제 게시를 하지 않았다. v2는 같은 표본 범위(`external/rhwp/samples/*.hwp`, 단일 구역, 120,000 bytes 이하, 승인 Release WASM)에서 단계별 증거를 따로 기록한다(`scripts/tests/hwpCompatibilityMatrix.ts`, `scripts/tests/hwp-sample-insertion-matrix.wasm.test.ts`; opt-in).

- **변이 증명:** 연산마다 새 인스턴스. API 결과는 `ok === true`와 필요한 인덱스가 있어야 유효(아니면 FAIL, 예외는 ERROR). 텍스트는 표식 문자열이 문단 0 앞에 정확히 붙고 문단 수 불변, 표는 새 `tbl` 1개 + `HWP_TABLE_NORMALIZATION` + `insertedBasicTable`, 그림은 새 그림 1개 + `insertedInlinePicture` + 임베디드 bytes = 입력, 글머리표는 글머리표가 아닌 첫 문단에 적용하고 정의가 U+2022로 해석되어야 한다(이미 글머리표면 다른 문단, 없으면 UNSUPPORTED). `applyParaFormat`은 정의가 없는 ID에도 `ok:true`를 돌려주므로 결과 값만으로 세지 않는다.
- **독립 재열기:** 정확한 출력 bytes를 새 인스턴스로 열어 형식·쪽 수·텍스트·raw controls·상세 HWP 모델(complete 필수, 원본 구조 baseline)을 비교한다. T009 원시 검사의 `reopen` 인자는 이 결과다.
- **분류:** 증명된 변이 + 재열기 PASS일 때만 `RAW_T009_CANDIDATE`(발견 없음) / `RAW_T009_CANDIDATE_PREVIEW`(PreviewStale만). 그 밖의 발견은 `T009_REJECTED`. 후보는 실제 Canvas(`scripts/tests/hwp-canvas/run.py`)·production 게시(`hwp_contract_real_engine_publication`, `GEUL_HWP_CANVAS=1`)·게시 파일의 새 인스턴스 재열기를 모두 통과해야 `VERIFIED_PUBLISHED_REOPEN`이다. 카테고리별 대표 거부 출력은 production 게시 거부·원본 보존으로 확인한다.

파일: 발견 288, 크기 제외 106, 가져오기 오류 1, 구역 제외 4, 측정 177, complete baseline 121, 원본 사전검사 SAFE 148, 둘 다 108.

| 연산 | 시도 | 변이 PASS | 재열기 PASS | 원시 후보(발견 없음 / preview만) | T009 거부 | 실제 게시 durable | 게시 파일 재열기 PASS | 엔진 오류 / 게시 미실행 |
|---|---|---|---|---|---|---|---|---|
| text | 108 | 108 | 107 | 1 / 17 | 89 | 18 | 18 | 0 / 0 |
| table | 108 | 108 | 103 | 0 / 6 | 97 | 6 | 6 | 0 / 0 |
| picture | 108 | 108 | 108 | 0 / 6 | 102 | 6 | 6 | 0 / 0 |
| bullets | 108 | 108 | 108 | 0 / 6 | 102 | 6 | 6 | 0 / 0 |

거부 발견 인스턴스(출력 하나에 여러 개 가능): `recordsChanged` 382, `partAdded` 101, `outputMalformed` 46, `reopenMismatch` 6(독립 재열기 쪽 수 불일치 6), `previewStale` 627. `referenceInvalid`·엔진 연산 실패·변이 누락·UNSUPPORTED 입력은 이번 표본에서 0건이다.

v1과의 차이: 표·그림·글머리표 후보 6개(같은 6개 문서)는 그대로이며 이제 모두 실제 게시와 재열기로 확인됐다. 텍스트는 20 → 18: `issue2808_report_physical_ladder.hwp`는 독립 재열기에서 쪽 수가 달라 후보가 아니다(v1의 단정된 `reopen=true`가 가렸다). `re-align-justify-hancom.hwp`는 삽입 문자열에 의존한다 — v1의 "가"는 PreviewStale만, v2의 표식(Latin 포함)은 `recordsChanged@DocInfo`. 표 5건·텍스트 1건의 독립 재열기 실패는 v1에서 기록되지 않았다.

이 수치는 이 표본·이 엔진의 측정이다. 표본이 모두 한컴 작성 문서인 것도 아니므로 한컴 문서 일반의 호환 비율로 해석하지 않는다. 실제 게시·재열기까지 확인된 문서는 issue5800-hancom-symbol.hwp, para-unit-01.hwp, test-image.hwp, test-image2.hwp, 종이기준.hwp, 쪽기준.hwp(구조 삽입)과 텍스트 후보 18개다. 증거: `target/hwp-compatibility-matrix-v2/`(ignored).


## HWP 일반 문서 호환 복구 — 고정 108 코퍼스 (2026-11-11)

측정 v2(텍스트 18, 표·그림·글머리표 각 6)의 거부 원인을 원본·출력 레코드 단위로 추적해(`scripts/tests/hwp_record_diff.py`) 엔진 직렬화 결함과 T009의 과잉 제한을 각각 고쳤다. 분모는 v2의 complete baseline + 원본 사전검사 SAFE 108개 문서를 이름·SHA-256으로 고정했다(`target/hwp-compat-recovery/corpus-108.json`, 제외 180개와 사유 포함).

### 엔진(`patches/rhwp/hwp-source-preservation.patch`, Release generation `907eabb2…`, `rhwp_bg.wasm` `c8957cbc…`)

| 원인(관측) | 수정 |
|---|---|
| 편집 명령이 DocInfo DOCUMENT_PROPERTIES의 캐럿을 갱신 → DocInfo raw 재사용 봉인 깨짐 → 전체 재직렬화(텍스트 실패 87건의 원인) | 선택 기능 `setPreserveSourceCaret(true)`: 편집의 암묵적 캐럿 갱신 생략(명시적 `setCaretPosition`·기본 #4180 동작 불변). geul `rhwpModule.openDocument`가 켠다 |
| 재직렬화 시 ID_MAPPINGS를 항상 72바이트로 기록(원본 64바이트 → T009 거부; 표·그림·글머리표 정의 추가 경로 전부) | 원본 ID_MAPPINGS 바이트를 보존해 원래 길이·뒤 필드를 유지하고 개수만 갱신 |
| 파생 글머리표 PARA_SHAPE를 원본 54바이트 대신 58바이트로 기록 | `source_level_tail_absent`: 원본에 tail이 없던 모양과 그 파생은 54바이트 |
| 새 표가 색·채우기가 다른 기존 실선 BorderFill도 재사용 | 기본 실선 BorderFill과 모델이 같은 항목만 재사용 |
| 빈 텍스트 문단 첫머리 입력이 구역/단 정의(secd/cold)보다 앞에 들어감 | 앞선 구역/단 정의 뒤, 첫 개체 앞에 삽입 |
| 편집 문단 뒤 첫 원래 문단의 vpos를 스타일 여백으로 다시 유도해 줄 밖 공간(비인라인 표 높이)이 사라짐 | 편집 전 저장 end가 있으면 저장 간격을 보존(표 생성은 호스트의 편집 전 end를 전달) |
| 편집 세션 표식(`session_edited`)이 일부 저장 캐시 보정을 꺼, 같은 데이터라도 세션 쪽 수와 새로 연 쪽 수가 다름(독립 재열기 쪽 수 불일치 6건) | `rebuildLayout()`: 새로 연 문서와 같은 조판 규칙으로 파생 레이아웃 재구성. 제품 `exportAndCompare`(HWP)와 측정이 내보내기 전에 호출 — 모델 데이터는 바꾸지 않고, live 쪽은 다시 파싱하지 않은 live 모델 그대로다 |

### T009(규칙 완화가 아니라 증명 범위 확장, 양성·음성 시험 추가)

- 보존된 원본 표·그림은 새 삽입 부분집합 스키마가 아니라 구조 건전성(표 격자 정확 1회 덮기, 그림 shape component)과 바이트 동일 부분트리 일치로 증명한다. 잘못된 원본 격자(기존 음성 시험)는 계속 거부된다.
- 불투명 본문 레코드(66–85 밖, 비어 있지 않은 range tag)는 소유 부분트리(제어 또는 문단)가 양쪽에서 같을 때만 허용한다. 소유 문단의 LINE_SEG는 아래 연속 사다리 증명으로 입증된 `vertical_pos` 변경만 허용한다([보존 계약](save-preservation.md#불투명-소유-문단-line_seg-이동-증명-2026-11-11)). 편집 문단 안의 range tag·불투명 payload 변경은 거부한다.
- 문단 모델: range tag 개수, 인라인 제어(4–9, 19, 20, payload 포함 토큰), 단일 단위 문자 24/30/31, 제어 마스크 = 존재하는 제어 문자의 OR.
- 디버그 빌드 전용 `GEUL_T009_TRACE`로 거부 단계 위치를 출력한다(판정 불변).

### 결과(측정 v3, 같은 하네스·같은 분모)

파일: 발견 288, 크기 제외 106, 가져오기 오류 1, 구역 제외 4, 측정 177, complete+SAFE 108.

| 연산 | 변이 PASS | 독립 재열기 | 원시 후보 | durable 게시 | 게시 파일 재열기 |
|---|---|---|---|---|---|
| text | 108/108 | 108/108 | 108/108 | 108/108 | 108/108 |
| table | 108/108 | 108/108 | 108/108 | 108/108 | 108/108 |
| picture | 108/108 | 108/108 | 108/108 | 108/108 | 108/108 |
| bullets | 108/108 | 108/108 | 108/108 | 108/108 | 108/108 |

엄격 수용 단계(`GEUL_HWP_MATRIX_PHASE=accept`, 고정 코퍼스, 미달 시 실패): **432/432 VERIFIED_PUBLISHED_REOPEN**. 미리보기: 430건은 Canvas raster로 PrvImage 재생성, 2건(텍스트)은 T009가 stale로 보지 않은 문서 무관 빈 PrvImage를 기존 정책대로 유지(PrvText는 재생성, 최종 판정 SAFE).

제품 경로(`hwp-core-commands`)도 같은 엔진에서 양성 11건 게시·재열기(Phase 4 "N7"였던 `h-pen-01.hwp` 표 삽입 포함), OPAQUE-001·raw TBL-001·제품 출력 손상 7종·미리보기 없음 거부를 유지했다.

이 결과는 이 고정 코퍼스와 이 엔진의 수용 기준이다. 제외된 180개(크기·다구역·가져오기 오류·incomplete baseline·사전검사 unsafe/unknown)와 그 밖의 HWP 문서 일반, 외부 한컴 호환, Linux native GUI/IBus는 검증하지 않았다.

### 고정 코퍼스 승인 경계 강화 (2026-11-11)

승인 입력은 Git 추적 `scripts/tests/fixtures/hwp-approved-corpus-108.json`이다. 기존
`target/hwp-compat-recovery/corpus-108.json`과 v2·v3·v6의 complete-baseline/preflight-SAFE
집합을 대조해 108개 이름·SHA-256이 모두 같고 실제 샘플 바이트도 일치함을 확인했다.
이는 로컬 과거 증거의 교차 확인이며 외부 서명 인증은 아니다. 승인 manifest의 전체 바이트
SHA-256은 `scripts/tests/hwpApprovedCorpus.ts`의 별도 lock에 고정한다. 문서 목록은 이름의
Unicode code point 순으로 정렬하며 mapping digest(name TAB hash LF, UTF-8)는
`f1522b4432af630f9133e3c18490353ee0eb24fa41971433e0056d9dac6e55d4`이다.

공통 검증기는 정확히 108개, 고유 이름·해시, NFC 단일 파일명(경로·별칭 금지), 해시 문법,
승인 mapping의 완전 일치, 실제 regular file의 SHA-256을 검사한다. acceptance는 각 문서의
측정 행 정확히 하나와 연산 4종, 결과·게시 ID의 고유성, source/hash/operation 연결,
실제 original/edited/published 바이트, durable/SAFE 게시와 독립 재열기 결과를 요구한다.
게시 바이트 해시도 432개에서 중복되면 거부한다. 발견 288개 전체 측정 행은 유지한다.
빈 목록·복제·대체·누락·경로 공격·승인 파일 변경은 합성 fixture로 회귀 검사한다.

깨끗한 checkout에서 별도로 공급한 원래 corpus의 신원만 검사하려면 Node >=22.18에서:

```sh
node scripts/tests/hwpApprovedCorpus.ts external/rhwp/samples
```

Rust/WASM/Canvas 없이 동작하고 누락·변조는 `FAIL/MISSING_INPUT`, exit 1이다.
원본 corpus 자체와 `public/rhwp/`, `target/`, `src-tauri/target/`의 측정·게시·보고서는
Git에 넣지 않는다. 일반 measure/verify/accept는 승인 manifest를 쓰지 않는다. 승인 변경은
별도 유지보수 변경으로 원래 승인 근거·전체 mapping diff·코드 lock을 함께 검토해야 한다.
측정 성공으로 자동 재선정하지 않는다.

실제 432건 재현에는 승인 Release generation
`907eabb217721131eee04d01f13e0a0d54332542462c36ee95fb6ada9744a20f`, 원본 corpus,
현재 Rust `save_check`와 publication test binary, picture fixture, Canvas raster/proof가 필요하다.
기존 measure → Canvas → production publication → verify → accept 순서를 사용한다.
`GEUL_HWP_MATRIX_CORPUS`를 주면 그 목록도 승인 mapping과 대조하며, 생략하면 추적 승인을 쓴다.
432/432는 현재 checker로 다시 게시한 결과에 대해 verify의 실제 새 인스턴스 재열기와
strict accept가 모두 성공해야 유효하다. 과거 acceptance.json만으로 현재 코드 성공을 주장하지 않는다.

이번 강화 후 현재 Rust 바이너리로 원래 432개 후보를 다시 production 게시하고, 승인 WASM으로
게시 파일을 새로 열어 strict accept **432/432**(연산별 108/108)를 확인했다. 과거 Canvas
증거는 변경 없는 generation/edited hash로 인증해 재사용했고, 과거 PASS 판정을 재사용하지 않았다.
실행 기록은 ignored `target/hwp-integrity-hardening/verification-summary.json`과 `matrix/`에 둔다.
