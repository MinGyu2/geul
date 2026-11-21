# Stage 3-A 요청 39개 항목 원장

업데이트: 2026-11-22 (Asia/Seoul)
기준 저장소 시작 HEAD: `5ef8ba99152ea787ab1a793ea16dd8c2a78c97ff`
현재 기록 기준 HEAD: `2e88f16cc722d3ddb75ed9f08b9f548e905abfc0` (P4-HX-CURVE 부분 구현 기록은 다음 로컬 커밋에서 갱신)
범위: P0 회귀 1 + P4 9 + P5 13 + P6 16 = **39개** (A 24, B 14, 회귀 1). 이 원장은 사용자 지정 ID를 모두 유지한다. 기존 [현행 인벤토리](stage3-a-current-inventory.md)와 [품질 매트릭스](../quality-matrix.md)는 관련 역사·구현 정보를 계속 보존한다.

`IMPLEMENTED_VERIFIED`는 명시된 기능과 해당 저장/Undo/Redo/재열기 조건을 실제로 확인한 경우에만 사용한다. `IN_PROGRESS`는 증거가 일부 있어도 요구사항의 일부가 빠져 있음을 뜻한다. `OPEN`은 이 요구사항 자체에 대한 완료 증명이 아직 없다는 뜻이며, 현재 코드에 관련 기능이 전혀 없다고 단정하지 않는다. Native 수락과 개발 구현은 별도로 기록한다.

| ID | 범주 | 추적할 기능·안전 범위 | 구현 상태 | 기능·보존 증거 | Native | 커밋 집합 | 남은 경계 / 다음 확인 |
|---|---|---|---|---|---|---|---|
| S1-FONT-TYPING | 회귀 | DOCX/HWP/HWPX collapsed-caret 다음 입력 크기, IME, 선택 교체, 이동, Undo/Redo, T009 | IMPLEMENTED_VERIFIED | DOCX 기존 X11/IBus PASS. RHWP 선택 교체에서 첫 선택 문자 전체 모양 상속; 빈 취소의 페이지 레이아웃 rollback과 선행 입력 Undo 경계. Release WASM 5/5, RHWP 세션 22/22, typecheck PASS. [Stage 1 상세](stage1-common-editing.md#11-p0--s1-font-typing-collapsed-caret-서식-유지-2026-11-21--22), [RHWP Native·저장 증거](stage1-font-typing-rhwp-acceptance.json) | Linux X11/Xvfb + 실제 IBus Hangul DOCX run7, HWP run18, HWPX run18 PASS. Wayland/Windows/macOS NOT RUN | `938d6638739b3d13d79fc436d0f16880e707e7e2` (기본 구현), `123ce40d8dbe6151bfcd722597bd6b1e43a9be4e` (초기 수락·인벤토리), `0379a837a2933bb16556cc5e08a501c6cf16893f` (RHWP 수정·수락), `2e88f16cc722d3ddb75ed9f08b9f548e905abfc0` (39-ID ledger hash 기록) | Microsoft Word/한컴 재열기 NOT RUN |
| P4-HX-CURVE | A | HWPX 원본 Bezier segment 종류·control point·순서·좌표·폐합·경로 metadata 보존 편집 | PARTIAL / BLOCKED_BY_FORMAT_CONTRACT | 알려진 연결 `LINE`/`CURVE` endpoint 편집, 원본 속성/순서/폐합 왕복; Undo/Redo, Release WASM, T009 저장 및 재열기 PASS. [수락 기록](stage3-a-p4-hwpx-curve-acceptance.json) | Linux X11 endpoint 편집·정밀 좌표·Undo/Redo·게시·독립 검사·앱 재열기 PASS; 전체 Bezier 미수락 | 부분 구현 커밋 해시 기록 예정 | 공식 HWPML 3.0 rev1.2 SEGMENT 표는 타입·시작점·끝점만 규정하고 명시 제어점 계약을 제공하지 않음. 정확한 제어점 XML contract/실제 호환 샘플이 필요하며 그 전에는 제어점·구간 구조 편집을 계속 fail-closed로 둠 |
| P4-DX-CURVE | A | DOCX quadratic/cubic 명령과 control point 편집; DrawingML·viewport·OPC 보존 | OPEN | 이 요구사항에 대한 회귀·구조 증거 미수집 | NOT RUN | — | segment identity, path attrs, relationships, Undo/Redo 및 independent reopen 확인 |
| P4-DX-PATH | A | DOCX freeform vertex 삽입·삭제·좌표 편집, open/closed path | OPEN | 이 요구사항에 대한 회귀·구조 증거 미수집 | NOT RUN | — | path command order와 envelope·viewport를 저장/reopen에서 확인 |
| P4-H5-SEG | A | HWP5 cubic 구간 추가/삭제와 지원 비공선 내부 구간 편집 | OPEN | 관련 HWP5 endpoint/line 기능의 역사 기록은 있으나 이 ID의 cubic 내부 지원·보존 요구를 대조하지 않음 | NOT RUN | — | 원본 segment identity·padding·인접 레코드의 CFB/T009 검증 |
| P4-H5-GROUP | A | HWP5 group 소유 자식 이동·크기·서식 편집 | OPEN | 이 요구사항에 대한 소유권·재귀 구조 증거 미수집 | NOT RUN | — | child order, sibling/resource, recursive serialization 및 reopen 확인 |
| P4-DX-GROUP | A | DOCX 그룹 자식 선택·편집, hierarchy/local transform 유지 | OPEN | 이 요구사항에 대한 증거 미수집 | NOT RUN | — | nested group flatten 없이 DrawingML·OPC ownership 검증 |
| P4-HX-NEST | A | HWPX nested group child 주소·좌표·transform·저장 | OPEN | 기존 flat group 기능 기록은 있으나 nested child addressing 요구는 미수락 | NOT RUN | — | parent/child 주소와 local/global 좌표, nested serialization 검증 |
| P4-GROUP-XFM | B | HWPX 중심 group composite transform: 유한성·역행렬·정밀도·기하 보존 | OPEN | 현재 이 safety gate 해소 증거 없음 | NOT RUN | — | 지원 변환 범위, inverse mapping, 양자화 후 무관 object 불변을 입증 |
| P4-PATH-XFM | B | HWPX/HWP5/DOCX path rotation·flip·offset 상태의 안전 편집 | OPEN | 현재 이 safety gate 해소 증거 없음 | NOT RUN | — | 표시 핸들→원 좌표→저장 좌표 대응 및 round-trip 검증 |
| P5-DX-NOTE-MOVE | A | DOCX footnote/endnote 실제 note ID·story part의 문단 내 picture 이동 | OPEN | 이 요구사항에 대한 story-addressed movement 증거 미수집 | NOT RUN | — | 실제 note ID, part, owner paragraph, anchor/inline 및 reopen 확인 |
| P5-R-HF-OBJECTS | A | HWP/HWPX header/footer 지원 non-picture object 편집 | OPEN | 기존 header/footer 관련 코드/이력은 이 범위에 대조되지 않음 | NOT RUN | — | story-specific address, command routing, serializer owner 입증 |
| P5-R-FN | A | HWP/HWPX footnote object 실제 소유·주소·편집 | OPEN | 이 요구사항에 대한 증거 미수집 | NOT RUN | — | note ID·번호·control reference·내부 문단 보존 |
| P5-R-EN | A | HWP/HWPX endnote object 실제 소유·주소·편집 | OPEN | 이 요구사항에 대한 증거 미수집 | NOT RUN | — | body/note type alias 없이 identity·번호·내부 문단 보존 |
| P5-TB-CONTROL | A | DOCX/HWP/HWPX text box 내부 nested picture/shape 선택·편집 | OPEN | 일부 글상자 텍스트/그룹 이력은 이 nested-object requirement를 증명하지 않음 | NOT RUN | — | 실제 text box story owner와 embedded resource owner 확인 |
| P5-DX-HF-MOVE | B | DOCX header/footer picture 이동 활성화 안전성 | OPEN | 이 story-specific 이동 경로에 대한 preservation proof 없음 | NOT RUN | — | inline/anchor semantics, part reference, IDs, page association 확인 |
| P5-DX-DELETE | B | DOCX header/footer/footnote/endnote owned picture 삭제 안전성 | OPEN | 다른 이야기나 최상위 그림 삭제 증거는 대체물이 아님 | NOT RUN | — | relationship/shared-media 사용 참조, Undo/Redo, OPC reopen 확인 |
| P5-R-HDR | B | HWP/HWPX 실제 section/page header owner 식별 및 mutation 활성화 | OPEN | 이 safety gate 해소 증거 없음 | NOT RUN | — | 실제 section/header 선택, 다른 header/body 보호, writer 확인 |
| P5-R-FTR | B | HWP/HWPX 실제 footer owner 식별 및 mutation 활성화 | OPEN | 이 safety gate 해소 증거 없음 | NOT RUN | — | 다른 footer/header/body로의 alias 차단 및 serializer 확인 |
| P5-H5-TB | B | HWP5 text box 문단 분할/병합 | OPEN | 이 구조 변경의 T009 증거 미수집 | NOT RUN | — | LIST_HEADER count, nested paragraphs, control level, char/para refs 보존 |
| P5-TB-MIX | B | HWPX 서로 다른 서식 문단에 걸친 선택 편집 | OPEN | 동일 문단 스타일·평문 범위 증거는 mixed-style 교차 선택을 입증하지 않음 | NOT RUN | — | paragraph-style inheritance·run fidelity·Undo/Redo·reopen 정의 |
| P5-TB-REPLACE | B | HWP5/HWPX text box cross-paragraph IME replacement·HWP5 paste | OPEN | HWPX 동일 모양 평문 paste 기존 증거는 이 혼합 요구의 일부만 다룸 | NOT RUN | — | IME ownership·취소·delayed commit·atomic replacement·HWP5 record preservation |
| P5-DX-SIZE-NONCANON | B | DOCX story picture의 noncanonical extent 안전 resize | OPEN | canonical story image resize 근거만으로 noncanonical envelope 안전성을 주장할 수 없음 | NOT RUN | — | extents·original envelope·관계·무관 part byte 고정 또는 안전 거부 확인 |
| P6-H5-CLIP | A | HWP5→HWP5 구조 개체 inter-document copy/paste | OPEN | 이 문서 간 remap/rollback 증거 미수집 | NOT RUN | — | destination IDs, DocInfo, char/para shapes, BinData, source immutability |
| P6-HX-GROUP | A | HWPX→HWPX group tree 구조 복사 | OPEN | 이 경로의 portable copy 증거 미수집 | NOT RUN | — | hierarchy, transforms, child identity/resource 재연결 |
| P6-HX-CURVE | A | HWPX→HWPX editable Bezier curve 복사 | OPEN | 선행 P4-HX-CURVE의 control-point 모델이 미완료 | NOT RUN | — | 원본 segment type/control point 보존; P4 모델 의존 |
| P6-HX-TYPE | A | HWP/HWPX shape type 변경 API·형식별 직렬화 | OPEN | 이 API/저장 계약에 대한 증거 미수집 | NOT RUN | — | geometry·formatting·controls·transform preservation |
| P6-DX-HX | A | DOCX→HWPX 지원 preset/format editable 변환 | OPEN | object-level conversion/resource remap 증거 미수집 | NOT RUN | — | source→portable model→target, 지원 경계·reopen 확인 |
| P6-DX-H5 | A | DOCX→HWP5 지원 shape conversion | OPEN | CFB records/resources 변환 증거 미수집 | NOT RUN | — | DocInfo/BinData 구조와 안전한 remap 및 reopen 확인 |
| P6-H5-DX | A | HWP5→DOCX 지원 shape conversion | OPEN | DrawingML editable conversion 증거 미수집 | NOT RUN | — | preset/geometry/style/relationship 보존 확인 |
| P6-H5-HX | A | HWP5→HWPX 지원 shape·style·resource conversion | OPEN | HWPX structure conversion 증거 미수집 | NOT RUN | — | 유효 HWPX structure/IDs/resources 및 reopen 확인 |
| P6-HX-H5 | A | HWPX→HWP5 지원 object conversion | OPEN | HWP5 DocInfo/BinData/record mapping 증거 미수집 | NOT RUN | — | target editable structure, unsupported refusal, reopen 확인 |
| P6-HX-DX-MORE | A | HWPX→DOCX polygon 외 editable shape/style conversion | OPEN | 기존 polygon subset을 넘는 mapping 증거 미수집 | NOT RUN | — | geometric/style semantics 및 명시 support boundary 검증 |
| P6-OTHER-CAP | A | DOCX/RHWP group-owned caption 소유·편집 | OPEN | 일반 개체 caption 이력은 group caption ownership을 증명하지 않음 | NOT RUN | — | association·text·placement·serialization·Undo/Redo 확인 |
| P6-SMARTART-MODEL | A | DOCX SmartArt node-specific style/additional data model | OPEN | 기존 item/step/layout 편집 범위와 추가 model fields를 대조하지 않음 | NOT RUN | — | 원본 data/diagram parts·serialization·reopen 증거 수집 |
| P6-DX-TYPE | B | DOCX floating/effects/custom-adjustment 등 추가 type transform 안전 활성화 | OPEN | canonical inline roundRect→rect 검증은 남은 unsafe transform을 해소하지 않음 | NOT RUN | — | collateral XML 불변, unsupported rejection, relationships/Undo/Redo 확인 |
| P6-HX-CAP-INLINE | B | HWPX inline picture left/right caption layout의 durable serialization | OPEN | floating picture caption 근거는 inline layout을 입증하지 않음 | NOT RUN | — | stored semantics와 rendered position 일치, save/reopen 확인 |
| P6-H5-CAP | B | HWP5 caption direction/alignment 변경의 record-preserving 활성화 | OPEN | 이 record-structure safety proof 없음 | NOT RUN | — | 주변 bytes/records와 object association 보존 확인 |
| P6-SMARTART-SHARED | B | 공유 SmartArt OPC parts 독립 복사·relationship 재연결 | OPEN | shared-part mutation safety 증거 미수집 | NOT RUN | — | 다른 참조 개체 불변, 복사본 owner/relationship 및 reopen 확인 |

## 상태 요약

- 완료한 ID: 1/39 (`S1-FONT-TYPING`; 구현·RHWP 보완 각각 로컬 commit 기록).
- 완료 주장하지 않는 ID: 1/39 (`P4-HX-CURVE`; endpoint subset은 구현·Native 수락했으나 요청된 Bezier control-point/segment 구조 편집의 format contract가 미해결).
- 아직 `OPEN`으로 분류된 ID: 37/39. 부분 구현 1개(`P4-HX-CURVE`)를 포함해 전체 미완료 요구사항은 38/39이며, 미검토 상태는 코드 기능 부재를 뜻하지 않는다.
- Git 원칙: 각 완료 항목은 자체 ID가 있는 별도 로컬 commit으로 기록. Push 금지. Submodule gitlink 및 ordered RHWP patch series는 이 항목에서 실제 변경할 때 별도 commit set으로 남긴다.
