# Stage 3-A 현행 기능 인벤토리

기준은 geul `61a9f58f0259175f3c310a3e8340bd5f8a21994d`, RHWP `1a76570e` + [순서 적용 패치](../../scripts/rhwp-patches.py), WordCraft `b2c97436`, RHWP Release `304cf9cf1b4bebb057bb7c52183ab34b8d3e14d3c1ed9e3cf9bd8259e38c0cb1`이다. 초기 감사 이후 구현된 범위의 수락 기록은 [품질 매트릭스](../quality-matrix.md)에 있다. 표의 시작점은 기준 HEAD이며, 수락 후 표와 별도 증거를 함께 갱신한다.

각 행의 형식은 동일 형식 편집 또는 명시된 소스 → 대상이다. 명령과 UI 열의 ‘없음’은 해당 동작을 뜻한다. A는 필수 구현 누락, B는 기존 모델/변경 기반에 남은 안전 활성화 경계, C는 구현된 범위의 실제 플랫폼 수락 누락이다. A/B의 C 의무는 구현 또는 활성화 후 적용한다.

이번 작업의 시작 HEAD는 `c1a46d47304d0cfe9eb410e999b41a25781bf879`다. 새 Linux Native 수락은 소스 `778573e874db221e68765c86b9608d4889990e86`와 RHWP Release `b97b5a0278e3e097aeeb1bc5688639ff97e2a7d23571795e4aaca86105ccf83c`에서 실행했다. X11 4건과 Wayland 5건의 앱·출력 SHA-256, Undo/Redo, 게시 및 재열기 근거는 별도 기록에 있다. [Native 수락 기록](stage3-a-native-p4-p5-p6-acceptance.json)

> **현 실행 추적:** 사용자가 지정한 historical audit baseline은 `5ef8ba99152ea787ab1a793ea16dd8c2a78c97ff`이며 실제 시작 HEAD로 확인했다. 아래의 기존 Stage 3-A 기준과 완료 기록은 역사적 근거로 보존한다. 이번 범위는 P0 회귀 1개와 아래 P4/P5/P6의 정확한 38개 ID(24 A, 14 B), 합계 39개다. 각 구현/안전 상태는 기존 상세 행에서 갱신하며 해결 항목은 별도 커밋과 수락 증거를 기록한다.

## P0 Stage 1 회귀

| ID | 범주 | 구현·보존 상태 | 변경 영역 | 증거 | Native | 로컬 커밋 | 남은 경계 |
|---|---|---|---|---|---|---|---|
| S1-FONT-TYPING | 회귀 | IMPLEMENTED_VERIFIED — collapsed caret의 같은 위치 focus-return이 pending 서식을 유지하고 deliberate navigation은 기존 정책을 따른다. selection replacement, Undo/Redo, T009 및 실제 reopen도 확인 | WordCraft pointer routing, DOCX IME overlay, RHWP format-specific Release WASM regression, Native acceptance harness | [Stage 1 §11](stage1-common-editing.md#11-p0--s1-font-typing-collapsed-caret-서식-유지-2026-11-21); `stage1_docx_` 13/13; Stage1 format WASM 28 passed/1 skipped; DOCX UI 13/13; typecheck PASS; [Native 보고서](stage1-font-typing-acceptance.json) | Linux X11/Xvfb + trusted IBus Hangul DOCX run7 PASS; HWP/HWPX per-format native GUI, Windows/macOS NOT RUN | `938d6638739b3d13d79fc436d0f16880e707e7e2` | 외부 Microsoft Word/한컴오피스 재열기 NOT RUN |

## P4 기하와 그룹

| ID | 형식·소유자 | 파서·모델 / 변경 API | geul 명령·UI | 저장 경계 및 필요한 수락 | 기존 단위·WASM / Native | A/B/C·상태·커밋 |
|---|---|---|---|---|---|---|
| P4.1 | HWPX 본문 다각형 | 정수 점·폐합 / `moveShapePathPoint` | `pathPoint`, 핸들·좌표 | 좌표·폐합·원래 속성 보존, 재열기 | PASS / X11 PASS | IMPLEMENTED_VERIFIED, `2accc59`, `5234029` |
| P4.2 | HWP5 SAFE 본문 열린 cubic/직선 | 구간 종류와 좌표 / `moveShapePathPoint` | `pathPoint`, 핸들·좌표 | T009 원본 leaf·패딩·오프셋, 재열기 | PASS / X11 PASS | IMPLEMENTED_VERIFIED, `2accc59`, `5234029` |
| P4.3/P4.6 | HWPX 평면, 직속 사각형·타원 | 재귀 모델 / 지정 자식 채우기·기하 API | `groupChildFill/Move/Resize`, 자식 편집·핸들 | 안정 ID, 원본 행렬, 타원 축, 형제·부모 보존 | PASS / X11 PASS, 경계 후속은 기록 참조 | IMPLEMENTED_VERIFIED, `0b8a2e4`–`61a9f58` |
| P4.4 | HWPX 단순 폐합 다각형 | 정수 점 / `editPolygonVertex` | `pathVertex`, 추가·삭제 | 정확한 점 순서·교차/퇴화 거부·재열기 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `bc74823` |
| P4.5 | HWP5 SAFE 열린 cubic의 마지막 직선 | 원본 구간 / `editCurveTerminalLine` | `pathSegment`, 추가·삭제 | 개수·패딩 및 살아남은 구간 검증 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `9fb57e2` |
| P4-H5-SEG-LINE | HWP5 SAFE 본문 열린 cubic 안의 정확한 직선 분할·병합 | 구간과 원본 CFB leaf / `editCurveInteriorLine` | `pathSegment/splitLine·joinLines`, 점 편집 상태 | 같은 방향 직선과 정수 점, cubic·패딩 불변, T009·CFB 독립 검사 | PASS / X11·Wayland PASS | A 구현, IMPLEMENTED_VERIFIED `fb720240`. [수락 기록](stage3-a-p4-curve-interior-acceptance.json) |
| P4-H5-POLY | SAFE HWP5 Section0 본문 단순 폐합 다각형 | 정수 점 / `moveShapePathPoint`, `editPolygonVertex` | 핸들·좌표 입력, 공선 변 분할·병합 | 태그 82와 영 패딩, 항등 행렬·영 오프셋, 나머지 레코드 보존. 비공선 모서리 삭제와 혼합 구조 편집 게시 제외 | Release WASM·T009·독립 CFB·재열기 PASS / X11 점·변 PASS, Wayland 점 PASS | IMPLEMENTED_VERIFIED `5816bdc573b8bfbcac958a70425b888fae4628b4`. [검증 기록](stage3-a-p4-hwp5-polygon-acceptance.json) |

## P5 이야기와 글상자

| ID | 형식·소유자 | 파서·모델 / 변경 API | geul 명령·UI | 저장 경계 및 필요한 수락 | 기존 단위·WASM / Native | A/B/C·상태·커밋 |
|---|---|---|---|---|---|---|
| P5-STORY-ALT | DOCX linked header/footer/footnote/endnote | `StoryRef::Part` / `object.altText` | 속성·그림 선택 | 일치하는 두 설명만 변경, 별도 OPC part·관계 불변 | Rust/T009 PASS / X11 4개 PASS | IMPLEMENTED_VERIFIED `1a9ab10` |
| P5-DX-HDR-SIZE | DOCX 머리말 최상위 내장 인라인 그림 | 별도 `StoryRef::Part` / `arrange.bounds` | 속성 크기, `object.edit/bounds` | 초기 이야기 XML의 바이트 보존, 별도 OPC 관계 및 미디어, 두 extent 동기화 | Rust/T009 PASS / X11·Wayland PASS | B 활성화, IMPLEMENTED_VERIFIED `7a0811ac`. [크기 조정 수락](stage3-a-p5-story-size-acceptance.json) |
| P5-DX-FTR-SIZE | DOCX 꼬리말 최상위 내장 인라인 그림 | 별도 `StoryRef::Part` / `arrange.bounds` | 속성 크기, `object.edit/bounds` | 초기 이야기 XML의 바이트 보존, 별도 OPC 관계 및 미디어, 두 extent 동기화 | Rust/T009 PASS / X11·Wayland PASS | B 활성화, IMPLEMENTED_VERIFIED `7a0811ac`. [크기 조정 수락](stage3-a-p5-story-size-acceptance.json) |
| P5-DX-FN-SIZE | DOCX 각주 최상위 내장 인라인 그림 | 별도 `StoryRef::Part` / `arrange.bounds` | 속성 크기, `object.edit/bounds` | 초기 이야기 XML의 바이트 보존, 별도 OPC 관계 및 미디어, 두 extent 동기화 | Rust/T009 PASS / X11·Wayland PASS | B 활성화, IMPLEMENTED_VERIFIED `7a0811ac`. [크기 조정 수락](stage3-a-p5-story-size-acceptance.json) |
| P5-DX-EN-SIZE | DOCX 미주 최상위 내장 인라인 그림 | 별도 `StoryRef::Part` / `arrange.bounds` | 속성 크기, `object.edit/bounds` | 초기 이야기 XML의 바이트 보존, 별도 OPC 관계 및 미디어, 두 extent 동기화 | Rust/T009 PASS / X11·Wayland PASS | B 활성화, IMPLEMENTED_VERIFIED `7a0811ac`. [크기 조정 수락](stage3-a-p5-story-size-acceptance.json) |
| P5-TB-SPLIT | HWPX 본문 글상자 | 문단·서식 run / RHWP split | Enter | 혼합 run·paragraph shape, 64문단 상한, 저장·독립 재열기 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `1a9ab10` |
| P5.5 | HWPX 글상자 인접 두 문단 | 같은 문단 모양·스타일 검사 / 범위 삭제 | Backspace/Delete 및 선택 삭제 | 양 끝 run·외곽·형제 유지 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `f61e208` |
| P5-TB-RANGE | HWPX 글상자 세 문단 이상, 동일 문단 모양·스타일 | 모든 인접 쌍 검증 / `deleteRangeInCell` | Delete/Backspace | 중간 문단 소유 검증, 남은 run/언어·외곽 보존, T009 | PASS / X11·Wayland PASS | B 활성화, IMPLEMENTED_VERIFIED `2b25b915`. [수락 기록](stage3-a-p5-textbox-range-acceptance.json) |
| P5-TB-REPLACE (클립보드) | HWPX 본문 글상자의 동일 문단 모양·스타일 선택 | 기존 범위 삭제·문단 분할 / 단일 스냅숏 복구 | 평문 붙여넣기 | 선택 세대, 남은 문자·문단 서식·소유권 보존, 삽입 실패 시 복구 | Release WASM·T009·독립 XML·재열기 PASS / X11 PASS | IMPLEMENTED_VERIFIED `59e27f60593439cfaac1eae1b9455c889663e93e`. [검증 기록](stage3-a-p5-textbox-paste-acceptance.json) |

## P6 구조, 변환, 캡션과 SmartArt

| ID | 소스 → 대상·개체 | 파서·모델 / 변경 API | geul 명령·UI | 저장 경계 및 필요한 수락 | 기존 단위·WASM / Native | A/B/C·상태·커밋 |
|---|---|---|---|---|---|---|
| P6.1 | HWPX → HWPX 폐합 다각형 | 정수 portable 경로 / 대상에서 복제 | 구조 복사·붙여넣기 | 대상 ID, 원본+형제 불변, 정확한 경로·서식 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `ab99043` |
| P6.2-type | DOCX 사각형 ↔ 타원 | preset / `shape.change` | 속성 변환 | 지원 프리셋만, 외곽·서식·리소스 보존 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `ab99043` |
| P6.2-format | HWPX 무윤곽 다각형 → DOCX 자유형 | portable points / `pasteHwpxPolygon` | 구조 붙여넣기 | 127 EMU/HWPUNIT, 편집 가능 DrawingML, 원본 불변 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `ab99043` |
| P6.3/P6.7 | HWPX 본문 그림 캡션 위·아래 및 간격 | caption model / `setPictureProperties` | `captionSide/Spacing` 속성 | 단일 atno·번호·run·BinData와 XML, 0–32767 gap | PASS / X11 PASS | IMPLEMENTED_VERIFIED `ab99043`, `7f98d7a` |
| P6.4 | DOCX 정규 SmartArt | WordCraft data/layout/style/colors/drawing / 항목·단계·레이아웃 | 속성 UI | T009 재생성 부품·관계 proof | PASS / X11 PASS | IMPLEMENTED_VERIFIED `ab99043`, 기존 P6 수락 |
| P6-DX-TYPE (`roundRect` → `rect`) | DOCX 본문 표준 인라인 기본 둥근 사각형 | 기존 `shape.change`와 원본 XML 왕복 게이트 | 속성 창의 사각형으로 변경 | 조정 없는 정확한 프리셋, 원래 외곽·서식·관계 및 패키지 보존 | Rust·T009·OPC·재열기 PASS / X11·Wayland PASS | IMPLEMENTED_VERIFIED `778573e874db221e68765c86b9608d4889990e86`. [검증 기록](stage3-a-p6-round-rect-acceptance.json) |
| P6-HX-CAP-SIDE | HWPX 본문 그림 캡션 좌우 | 네 방향 및 serializer / 그림 속성 API | 지원 열 기준 부유 그림에 좌우 옵션 | 소유 증명, 좌우 렌더와 독립 XML/번호·서식·이미지 검사 | PASS / X11 PASS | B 활성화, 지원 부유 그림 IMPLEMENTED_VERIFIED `bac51567`. [수락 기록](stage3-a-p6-caption-lateral-acceptance.json) |
| P6-HX-CAP-ALIGN | HWPX 본문 캡션의 좌우 배치 시 세로 정렬 | `caption.vert_align` 및 serializer / 그림 속성 API | `captionVerticalAlign` 및 속성 UI | 캡션 세로 좌표, `subList@vertAlign`, 번호·서식·리소스 검증 | PASS / X11 PASS | A 구현, 지원 부유 그림 IMPLEMENTED_VERIFIED `bac51567`. [수락 기록](stage3-a-p6-caption-lateral-acceptance.json) |

## 남은 구현과 안전 증명

### P4 남은 기능

| 기능 ID | 형식 | 현재 모델 | 누락 API 또는 동작 | 현재 안전 차단 | 필요한 UI | 필요한 직렬화 | 필요한 T009·저장 증명 | 필요한 Native 수락 | 의존성 | 상태 | 커밋 SHA |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P4-HX-CURVE | HWPX | 곡선의 점 체인, 원본 seg 타입 유실 | 유형별 원본 경로와 제어점·구간 API | 경로 표현과 연결·폐합의 무손실 왕복 없음 | 점 핸들·정밀 좌표·구간 추가/삭제 | `seg` 종류·점 순서·폐합·변환 | 구간 XML과 그룹 밖 리소스 비교 | X11 경로 편집·재열기 | RHWP의 parser·모델·writer | A UNIMPLEMENTED | — |
| P4-DX-CURVE | DOCX | WordCraft `FreePath`의 샘플링 점 | quadratic/cubic 명령·제어점 편집 | 원본 DrawingML 명령 및 경로별 속성 유실 | 제어점 핸들·좌표 | 정확한 `quadBezTo`·`cubicBezTo` | OPC 안의 명령 순서·좌표·속성·관계 대조 | X11 두 곡선 종류 편집·재열기 | WordCraft 파서·모델·writer | A UNIMPLEMENTED | — |
| P4-DX-PATH | DOCX | f32 직선 자유형과 외곽 크기 | 꼭짓점·구간 편집 | 원본 좌표와 경로 속성의 정확한 대응 미증명 | 꼭짓점·구간 도구 | path별 뷰포트, 좌표와 명령 | 좌표·경로 ID·OPC 대조 | X11 직선·폐합 경로 편집 | P4-DX-CURVE와 원본 DrawingML 모델 | A PARTIALLY_IMPLEMENTED | — |
| P4-H5-SEG | HWP5 | 순서 있는 cubic/직선, 기존 점·직선 편집 | cubic 삽입·삭제 및 비공선 내부 편집 | 기존 cubic과 명령·패딩에 대한 구조 변경 증명 없음 | 구간 선택·편집 | 태그 83 명령·좌표·패딩 유지 | 기존 구간과 새 인코딩의 독립 CFB 검증 | X11 구간 변경·Undo/Redo·재열기 | RHWP 곡선 API와 HWP5 T009 | A PARTIALLY_IMPLEMENTED | — |
| P4-H5-GROUP | HWP5 | 재귀 SC_CONTAINER와 자식 잎 | 소유 자식 위치·크기·서식 API | 자식 잎을 변경하면서 원본 레코드와 소유를 지키는 증명 없음 | 자식 선택·조작 | 자식 leaf, 부모와 형제 보존 | CFB 부모·자식 순서와 컴포넌트·리소스 | X11 자식 변경·재열기 | RHWP 자식 주소, HWP5 T009 | A PARTIALLY_IMPLEMENTED | — |
| P4-DX-GROUP | DOCX | WordCraft `GroupChild` | 자식 선택·변경 경로 | 중첩을 평탄화하면서 실제 자식 소유·구조 유실 | 자식 선택·조작 | 그룹 트리, 로컬 변환, 관계 | 원래 자식과 형제·OPC 리소스 비교 | X11 직속 및 지원 중첩 조작 | WordCraft 그룹 판독·기록 | A PARTIALLY_IMPLEMENTED | — |
| P4-HX-NEST | HWPX | 재귀 컨테이너, 평면 편집 API | 안정 중첩 자식 경로 | 단계별 로컬 좌표와 ID·행렬 합성 미증명 | 중첩 자식 선택·조작 | 위치·크기·자식 순서·로컬 행렬 | 각 단계 XML과 형제 불변 검사 | X11 중첩 선택·편집·재열기 | RHWP 그룹 트리와 P4.6 | A PARTIALLY_IMPLEMENTED | — |
| P4-GROUP-XFM | HWPX 중심, HWP5/DOCX | 자식·원본 행렬 | 지원 변환에서 자식 좌표 수정 | 유한·가역 합성 및 정수 역변환, 타원 축 대응 미증명 | 변환 그룹 핸들·좌표 | 원본과 합성 행렬·축 유지 | 원본 행렬·복합 변환과 재열기 검증 | X11 렌더와 조작 일치 | P4.6·형식별 그룹 주소 | B BLOCKED_BY_SAFETY | — |
| P4-PATH-XFM | HWPX/HWP5, DOCX | 저장 행렬과 원본 경로, 일부 위치 정보 | 지원 비항등 경로 좌표 수정 | 비영 오프셋·반전·회전에서 프레임 적중과 원본 정수 대응 미증명 | 변환 경로 핸들·좌표 | 원본 행렬·오프셋·점 순서 | 독립 XML/CFB 및 렌더 역변환 검사 | X11 행렬이 있는 경로 조작 | P4.6·형식별 경로 모델 | B BLOCKED_BY_SAFETY | — |

### P5 남은 기능

| 기능 ID | 형식 | 현재 모델 | 누락 API 또는 동작 | 현재 안전 차단 | 필요한 UI | 필요한 직렬화 | 필요한 T009·저장 증명 | 필요한 Native 수락 | 의존성 | 상태 | 커밋 SHA |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P5-DX-HF-MOVE | DOCX 머리말·꼬리말 | `StoryRef::Part`, header/footer 이동 경로 | 안전한 같은 이야기 내 이동 | run 이동과 부유 전환·페이지 앵커 의미 및 ID 보존 미증명 | 이야기 선택·이동 | 별도 part와 run·배치·관계 | 기존 그림·미디어·반복 페이지 참조 대조 | X11 활성 머리말·꼬리말 이동 | WordCraft story·OPC | B BLOCKED_BY_SAFETY | — |
| P5-DX-NOTE-MOVE | DOCX 각주·미주 | 별도 노트 part, 기존 이동에서 제외 | 같은 노트 내부 run/문단 이동 | 노트 ID와 실제 문단 주소 바인딩 없음 | 노트 그림 이동 | 노트 `w:id`·참조·배치·관계 | 각주·미주·본문 별칭 거부와 OPC 검사 | X11 두 노트 종류 이동 | WordCraft note ownership | A UNIMPLEMENTED | — |
| P5-DX-DELETE | DOCX 네 별도 이야기 | 별도 part, 일반 삭제 및 media 수집 | 소유 그림 삭제·Undo/Redo | 연속 그림 ID, 관계·공유 미디어 참조 집계 증명 없음 | 그림 선택·삭제 | 선택된 run만 제거, 소유 관계 유지 | 원본과 출력 OPC 및 남은 media 참조 대조 | X11 네 이야기 삭제·재열기 | WordCraft story·OPC | B BLOCKED_BY_SAFETY | — |
| P5-R-HDR | HWP5/HWPX 머리말 | RHWP 머리말 모델·그림 속성 API | 활성 머리말 개체의 주소·변경 | 페이지 또는 섹션의 활성 소유자와 원본 writer 보존 미증명 | 머리말 개체 적중·속성 | HWP5 자식 레코드, HWPX 소속 XML 각각 | 첫 페이지·짝/홀·본문 주소와 CFB/XML 검사 | X11 활성 머리말 편집 | RHWP layout·형식별 writer | B BLOCKED_BY_SAFETY | — |
| P5-R-FTR | HWP5/HWPX 꼬리말 | RHWP 꼬리말 모델·그림 속성 API | 활성 꼬리말 개체의 주소·변경 | 머리말·본문과 다른 실제 소유자 연결 미증명 | 꼬리말 적중·속성 | HWP5 자식 레코드, HWPX 소속 XML 각각 | 꼬리말 owner 및 별칭 거부, CFB/XML | X11 활성 꼬리말 편집 | RHWP layout·형식별 writer | B BLOCKED_BY_SAFETY | — |
| P5-R-HF-OBJECTS | HWP5/HWPX 머리말·꼬리말 | 이야기와 본문 도형 모델 | 그림 외 소유 개체 변경 API | 본문과 분리된 실제 컨트롤 경로 없음 | 이야기 안 도형 적중·속성 | 문단·개체와 섹션의 형식별 저장 | 대상 컨트롤만 바뀌는 CFB/XML 검사 | X11 머리말·꼬리말 도형 편집 | P5-R-HDR/FTR·형식별 writer | A UNIMPLEMENTED | — |
| P5-R-FN | HWP5/HWPX 각주 | 본문 각주 제어와 내부 노트 | 참조에서 개체까지 실제 주소 | 각주 식별자·문단·제어를 묶는 변경 경로 없음 | 각주 개체 적중·속성 | 노트 타입·번호·내부 문단 | 번호·참조·본문 별칭 및 독립 CFB/XML | X11 두 각주의 같은 로컬 번호 | RHWP note model·writer | A UNIMPLEMENTED | — |
| P5-R-EN | HWP5/HWPX 미주 | 노트 모델과 가상 문단 번호 | 명시적인 미주 제어 소유 API | 가상 미주 인덱스의 본문 별칭 | 미주 개체 적중·속성 | 미주 컨트롤·노트 번호·문단 | 미주·각주·본문 오인 주소 거부·CFB/XML | X11 미주 편집·재열기 | RHWP note model·writer | A UNIMPLEMENTED | — |
| P5-H5-TB | HWP5 | 글상자 문단 모델, 기존 평문 편집 | 문단 분할·병합 | LIST_HEADER 문단 수, 제어 레벨과 ID를 유지하는 T009 증명 없음 | Enter·Delete 문단 경계 | HWP5 문단·리스트 헤더·서식 참조 | 분할/병합 CFB와 모든 주변 레코드 비교 | X11 글상자 경계·재열기 | RHWP HWP5 writer·T009 | B BLOCKED_BY_SAFETY | — |
| P5-TB-MIX | HWPX | 범위 삭제·붙여넣기 API | 서로 다른 서식 문단 선택 | 문단 모양·스타일이 다를 때 상속 규칙 및 증명 없음 | 혼합 문단 선택·편집 | 지원 단락 서식과 문자 run | 원본 para/style ID·새 상속의 독립 XML 검사 | X11 혼합 문단 교체 | RHWP 문단 모델·P5-TB-REPLACE | B BLOCKED_BY_SAFETY | — |
| P5-TB-REPLACE (나머지) | HWP5/HWPX | 단일 문단 IME 및 HWPX 평문 교체 | 교차 문단 IME·HWP5 교체 | 취소·지연 preedit의 소유 검증, HWP5 원본 문단 레코드 보존 미증명 | IME 및 HWP5 붙여넣기 | 동일 트랜잭션과 HWP5 문단 참조 | stale 거부와 독립 CFB/XML | X11 실제 IME 취소·확정과 세션 이동 | P5-H5-TB·IME 트랜잭션 | B BLOCKED_BY_SAFETY | — |
| P5-TB-CONTROL | HWP5/HWPX/DOCX | RHWP 중첩 개체, WordCraft의 일부 그림 오분류 | 실제 소속 개체 경로·편집 | 중첩 구문 소유 및 이야기 타입 유실 | 글상자 안 개체 적중·속성 | 글상자·그림·자원 참조 | CFB/OPC 통제 및 소유 ID 대조 | X11 중첩 개체 편집 | 각 엔진의 중첩 reader/writer | A UNIMPLEMENTED | — |
| P5-DX-SIZE-NONCANON | DOCX 별도 이야기 | 이미지 모델의 단일 크기, 원본 XML 비교 | 안전부위만 개별 허용 | 두 치수 불일치와 공유 writer의 초기 봉투 변경 | 정규 개체만 가용 표시 | 원본 XML의 미변경 객체·관계·치수 | 원본/조정된 두 extent, 다른 part 바이트 비교 | X11 비정규 그림과 안전 그림 공존 | WordCraft story writer·T009 | B BLOCKED_BY_SAFETY | — |

### P6 남은 기능

| 기능 ID | 형식 | 현재 모델 | 누락 API 또는 동작 | 현재 안전 차단 | 필요한 UI | 필요한 직렬화 | 필요한 T009·저장 증명 | 필요한 Native 수락 | 의존성 | 상태 | 커밋 SHA |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P6-H5-CLIP | HWP5 → HWP5 | 동일 문서 `copyControl`·`pasteControl` | 대상 문서 구조 붙여넣기와 롤백 | DocInfo·BinData·ID 실제 재매핑 부재 | 구조 복사·잘라내기·붙여넣기 | 대상 ID·글자/문단 모양과 BinData 매핑 | 원본 불변과 대상 CFB 리소스 및 거부 롤백 | X11 두 HWP 문서 간 전송 | RHWP HWP5 writer·T009 | A PARTIALLY_IMPLEMENTED | — |
| P6-HX-GROUP | HWPX → HWPX | 그룹 모델과 동일 문서 복제 | 휴대용 그룹 트리 전송 | 자식 순서·행렬·고유 ID와 자원 재소유 증명 없음 | 구조 클립보드 | 로컬 변환·순서·대상 ID·리소스 | 양쪽 XML과 관계, 재편집 검증 | X11 두 문서의 그룹 전송 | P4-HX-NEST·RHWP portable | A PARTIALLY_IMPLEMENTED | — |
| P6-HX-CURVE | HWPX → HWPX | 손실 있는 세그먼트 판독·동일 문서 복제 | 편집 가능한 곡선 전송 | 정확한 명령·제어점 타입 유실 | 구조 클립보드 | 원본 세그먼트·폐합·서식·대상 ID | 양쪽 XML과 곡선 재편집 검증 | X11 곡선 교차 문서 전송 | P4-HX-CURVE | A UNIMPLEMENTED | — |
| P6-HX-TYPE | HWPX/HWP5 | 개별 도형 타입 | 자원과 속성을 보존하는 타입 변경 API | 타입별 저장 구조 및 이동 가능한 속성 계약 없음 | 도형 변환 속성 | 목표 도형 태그/레코드·좌표 | 변환마다 원본/대상 및 리소스 독립 검사 | X11 실제 속성 변환 | RHWP 타입별 writer | A UNIMPLEMENTED | — |
| P6-DX-TYPE (나머지) | DOCX | 기본 `shape.change`, 제한된 프리셋 | 추가 조합의 정확한 정책 | 사용자 조정·부유·효과·연결 구조와 각 대상 타입 서식 보존 미증명 | 가용 변환 선택 | DrawingML 형태·효과·관계 | 대상별 최소 속성 변화 및 OPC 재열기 | X11 지원 프리셋 쌍 | WordCraft 원본 모델·OPC | B BLOCKED_BY_SAFETY | — |
| P6-DX-HX | DOCX → HWPX | 각 엔진의 개별 형식 도형 | 소스 프리셋→대상 모양 전송 | 좌표·서식·관계의 실제 대응 없음 | 구조 붙여넣기 | EMU→HWPUNIT·HWPX 대상 ID | 독립 HWPX와 원본 OPC 불변 | X11 두 형식 전송·대상 편집 | WordCraft DrawingML·RHWP 생성 | A UNIMPLEMENTED | — |
| P6-DX-H5 | DOCX → HWP5 | 각 엔진의 도형 모델 | 지원 HWP5 대상 경로 | DocInfo/BinData·원본 명령의 매핑 없음 | 구조 붙여넣기 | 대상 CFB·DocInfo 및 객체 ID | 원본 OPC 불변, 대상 CFB와 T009 | X11 DOCX→HWP5 전송·편집 | WordCraft·RHWP HWP5 writer/T009 | A UNIMPLEMENTED | — |
| P6-H5-DX | HWP5 → DOCX | 각 엔진의 도형 모델 | 구조 내보내기·대상 삽입 | CFB 원본 기하·선·채우기·미디어의 대응 없음 | 구조 붙여넣기 | HWPUNIT→EMU·OPC 새 소유자와 관계 | 원본 CFB와 대상 DrawingML·OPC 검사 | X11 HWP5→DOCX 전송·편집 | RHWP CFB·WordCraft writer | A UNIMPLEMENTED | — |
| P6-H5-HX | HWP5 → HWPX | HWP5 제어, HWPX writer | 구조 전송 | DocInfo 원본·자원 참조와 대상 매핑 부재 | 구조 붙여넣기 | HWP5 제어에서 HWPX 구조로 매핑 | 원본 CFB 및 독립 대상 XML 보존 | X11 HWP5→HWPX 전송·편집 | RHWP 파서·대상 생성/직렬화 | A UNIMPLEMENTED | — |
| P6-HX-H5 | HWPX → HWP5 | HWPX 휴대용 일부, HWP5 구조 저장 | HWP5 대상 전송 | 대상 DocInfo·BinData와 삽입 증명 부재 | 구조 붙여넣기 | HWP5 대상 CFB와 로컬 ID | 원본 XML 불변, 대상 CFB와 T009 | X11 HWPX→HWP5 전송·편집 | P6-H5-CLIP 자원 매핑·T009 | A UNIMPLEMENTED | — |
| P6-HX-DX-MORE | HWPX → DOCX | 무윤곽 단색 다각형 한 조합 | 더 많은 타입·속성 전송 | 선·경로·캡션·리소스의 타입별 대응 부재 | 구조 붙여넣기 | 각 타입의 편집 가능한 DrawingML | 양쪽 파일과 목표 소유·속성 검사 | X11 추가 조합 전송·편집 | RHWP portable·WordCraft 생성 | A PARTIALLY_IMPLEMENTED | — |
| P6-HX-CAP-INLINE | HWPX | 캡션 방향 저장, 인라인 렌더는 아래 배치 | 인라인 좌우 캡션 | 줄 너비·좌표와 캡션 위치가 모델 속성에 맞지 않음 | 인라인 좌우·세로 정렬 속성 | caption side/align과 원본 콘텐츠 | 측면 배치·번호·서식·리소스 XML 검사 | X11 실제 좌우 렌더와 재열기 | RHWP 인라인 조판 | B BLOCKED_BY_SAFETY | — |
| P6-H5-CAP | HWP5 | 기존 캡션 값과 변경 API | 저장 가능한 위치·정렬 편집 | LIST_HEADER 방향 필드와 보호 필드를 분리한 T009 증명 없음 | 캡션 배치 속성 | LIST_HEADER 및 atno·번호·비변경 바이트 | 실제 렌더와 CFB 레코드 미변경 범위 검사 | X11 캡션 배치와 재열기 | RHWP 조판·HWP5 T009 | B BLOCKED_BY_SAFETY | — |
| P6-OTHER-CAP | DOCX 및 RHWP 그룹 | 일부 캡션 값, DOCX 소유 계약 미확정 | 포맷별 캡션 소유 편집 | 개체와 캡션·번호 사이의 변경 의미 및 주소 미정 | 개체별 캡션 속성 | 대상 캡션 및 참조 | 번호·자원·레이아웃의 독립 검사 | X11 그룹 또는 DOCX 캡션 | 각 엔진의 소유 모델 | A UNIMPLEMENTED | — |
| P6-SMARTART-MODEL | DOCX | 정규 SmartArtSpec, items/layout | 노드별 스타일과 추가 데이터 모델 | 비정규 data/layout/style/colors/drawing 무손실 직렬화 미증명 | 노드·레이아웃 속성 | 다이어그램 모델과 OPC 관계 | 데이터·스타일·드로잉 원본 및 재열기 | X11 추가 노드/레이아웃 편집 | WordCraft SmartArt reader/writer | A PARTIALLY_IMPLEMENTED | — |
| P6-SMARTART-SHARED | DOCX | 정규 재생성 및 소유 검사 | 지원하는 공유 part의 소유 사본 생성 | 관계 재바인딩과 공유 원본 무변경 증명 부재 | 지원 SmartArt 편집 | 사본에 새 part·관계·ID | 원본 공유 파트 해시, 사본 참조와 재열기 | X11 두 개체가 공유한 부분 편집 | WordCraft OPC copy-on-write | B BLOCKED_BY_SAFETY | — |

### 설계상의 미지원

- **P6-R-SMARTART** — HWP5/HWPX의 확인된 RHWP 개체 모델에 DOCX SmartArt의 데이터·레이아웃·관계에 대응하는 네이티브 편집 구조가 없다. 개별 편집 도형으로 변환하려면 형식별 독립 계약이 필요하다. **UNSUPPORTED_BY_DESIGN**.
- **P6-SMARTART-SHARED** — 공유 또는 외부 소유 OPC 파트를 그대로 덮어쓰는 동작은 **UNSUPPORTED_BY_DESIGN**이다. 위 표의 B 항목은 대상 개체가 소유하는 사본 생성에 관한 것이다.


## C 플랫폼 증거

기존 X11의 PASS는 각 기록의 fixture와 실행 신원 범위로 재사용한다. Wayland는 실제 Wayland 입력 경로와 GDK Wayland 실행 신원, Windows/macOS는 해당 네이티브 OS에서 각각 지원 문서의 대표 UI, 실제 파일 대화상자, Undo/Redo 및 앱 저장/독립 패키지 검사/재열기가 필요하다. 기존 검증 기록과 소스 확인에는 [P4–P6 명령](command-registry.md#stage-3-a-p4-개체-경로와-그룹-자식) 및 [T009 증명](save-preservation.md#stage-3-a-p4-경로-및-그룹-자식)을 사용한다.

| 플랫폼 | 결과와 전제 | 남은 실행 및 증거 |
|---|---|---|
| Linux X11 | 이 작업의 HWP5 다각형 점 이동·변 분할/병합, HWPX 글상자 클립보드, DOCX 프리셋 변환 등 4건 PASS. 격리 Xvfb와 GDK X11에서 실제 조작, 게시, 독립 파일 검사, 재열기. [Native 수락 기록](stage3-a-native-p4-p5-p6-acceptance.json) | 앞의 A/B 기능마다 지원 구현 후 실제 조작 수락이 필요하다. |
| Linux Wayland | HWP5 내부 직선·다각형 점, HWPX 다문단 삭제·오른쪽/아래 캡션, DOCX 프리셋 변환 등 5건 PASS. 앱 `GDK_BACKEND=wayland`, 앱에 `DISPLAY` 없음, Weston 프로토콜과 신뢰된 입력 확인. [이번 수락](stage3-a-native-p4-p5-p6-acceptance.json) [기존 왼쪽 캡션](stage3-a-wayland-caption-acceptance.json) [기존 네 DOCX 이야기](stage3-a-wayland-story-size-acceptance.json) | C NOT RUN — HWP5 다각형 변 분할·병합, HWPX 글상자 클립보드와 수락하지 않은 다른 캡션 조합. |
| Windows | NOT RUN — environment unavailable. 지원 Windows 호스트·GUI 세션 부재. | 지원 Windows 호스트의 [릴리스 절차](../release-checklist.md)에 따라 네이티브 의존성과 Release WASM을 준비하고 `npm run tauri -- build --no-bundle`로 Tauri Release를 만들고 생성된 앱을 실행한다. DOCX/HWP/HWPX 열기 대화상자, 편집, Undo/Redo, 저장·재열기와 native path·패키징을 기록한다. |
| macOS | NOT RUN — environment unavailable. 지원 macOS 호스트·GUI 세션 부재. | 지원 macOS 호스트의 [릴리스 절차](../release-checklist.md)에 따라 네이티브 의존성과 Release WASM을 준비하고 `npm run tauri -- build --no-bundle`로 Tauri Release를 만들고 생성된 앱을 실행한다. 실제 개체 선택, 대표 편집, 파일 대화상자, Undo/Redo와 저장·재열기, 번들 리소스와 입력을 기록한다. |

현재 Stage 3-A와 Stage 3 전체는 **PARTIALLY COMPLETED**다. 기존 Stage 3-B 및 Stage 3-C 수락은 각 범위의 기록을 따른다.
