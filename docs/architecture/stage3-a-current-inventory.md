# Stage 3-A 현행 기능 인벤토리

기준은 geul `61a9f58f0259175f3c310a3e8340bd5f8a21994d`, RHWP `1a76570e` + [순서 적용 패치](../../scripts/rhwp-patches.py), WordCraft `b2c97436`, RHWP Release `304cf9cf1b4bebb057bb7c52183ab34b8d3e14d3c1ed9e3cf9bd8259e38c0cb1`이다. 초기 감사 이후 구현된 범위의 수락 기록은 [품질 매트릭스](../quality-matrix.md)에 있다. 표의 시작점은 기준 HEAD이며, 수락 후 표와 별도 증거를 함께 갱신한다.

각 행의 형식은 동일 형식 편집 또는 명시된 소스 → 대상이다. 명령과 UI 열의 ‘없음’은 해당 동작을 뜻한다. A는 필수 구현 누락, B는 기존 모델/변경 기반에 남은 안전 활성화 경계, C는 구현된 범위의 실제 플랫폼 수락 누락이다. A/B의 C 의무는 구현 또는 활성화 후 적용한다.

## P4 기하와 그룹

| ID | 형식·소유자 | 파서·모델 / 변경 API | geul 명령·UI | 저장 경계 및 필요한 수락 | 기존 단위·WASM / Native | A/B/C·상태·커밋 |
|---|---|---|---|---|---|---|
| P4.1 | HWPX 본문 다각형 | 정수 점·폐합 / `moveShapePathPoint` | `pathPoint`, 핸들·좌표 | 좌표·폐합·원래 속성 보존, 재열기 | PASS / X11 PASS | IMPLEMENTED_VERIFIED, `2accc59`, `5234029` |
| P4.2 | HWP5 SAFE 본문 열린 cubic/직선 | 구간 종류와 좌표 / `moveShapePathPoint` | `pathPoint`, 핸들·좌표 | T009 원본 leaf·패딩·오프셋, 재열기 | PASS / X11 PASS | IMPLEMENTED_VERIFIED, `2accc59`, `5234029` |
| P4.3/P4.6 | HWPX 평면, 직속 사각형·타원 | 재귀 모델 / 지정 자식 채우기·기하 API | `groupChildFill/Move/Resize`, 자식 편집·핸들 | 안정 ID, 원본 행렬, 타원 축, 형제·부모 보존 | PASS / X11 PASS, 경계 후속은 기록 참조 | IMPLEMENTED_VERIFIED, `0b8a2e4`–`61a9f58` |
| P4.4 | HWPX 단순 폐합 다각형 | 정수 점 / `editPolygonVertex` | `pathVertex`, 추가·삭제 | 정확한 점 순서·교차/퇴화 거부·재열기 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `bc74823` |
| P4.5 | HWP5 SAFE 열린 cubic의 마지막 직선 | 원본 구간 / `editCurveTerminalLine` | `pathSegment`, 추가·삭제 | 개수·패딩 및 살아남은 구간 검증 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `9fb57e2` |
| P4-HX-CURVE | HWPX 본문 곡선 | XML segment 입력이 점 체인으로 평탄화 / 해당 원본 구조 편집 없음 | 없음 | 구간 타입·제어점·닫힘의 무손실 XML 왕복 후 명령 추가 | 없음 / 없음 | A UNIMPLEMENTED |
| P4-DX-CURVE | DOCX DrawingML 자유형 | `read/freeform.rs`의 quadratic/cubic 샘플링, `FreePath` 점 모델 / 원본 구간 변경 없음 | 외곽 크기만 | 원본 좌표·구간·path별 속성을 담는 모델과 writer 교정 | 없음 / 없음 | A UNIMPLEMENTED |
| P4-H5-SEG-LINE | HWP5 SAFE 본문 열린 cubic 안의 정확한 직선 분할·병합 | 구간과 원본 CFB leaf / `editCurveInteriorLine` | `pathSegment/splitLine·joinLines`, 점 편집 상태 | 같은 방향 직선과 정수 점, cubic·패딩 불변, T009·CFB 독립 검사 | PASS / X11 PASS | A 구현, IMPLEMENTED_VERIFIED `fb720240`. [수락 기록](stage3-a-p4-curve-interior-acceptance.json) |
| P4-H5-SEG | HWP5 본문 cubic 구간 자체 추가·삭제, 비공선 직선 접점 삭제 | 원본 구간 모델 / 기존 점 및 지원 직선 구조 편집 | 지원 점·직선 명령 | 기존 곡선 경계·연결성 및 새 타입의 CFB leaf 보존 증명 | 기존 P4.2/P4.5/P4-H5-SEG-LINE 범위 | A PARTIALLY_IMPLEMENTED |
| P4-H5-POLY | SAFE HWP5 Section0 본문 단순 폐합 다각형 | 정수 점 / `moveShapePathPoint`, `editPolygonVertex` | 핸들·좌표 입력, 공선 변 분할·병합 | 태그 82와 영 패딩, 항등 행렬·영 오프셋, 나머지 레코드 보존. 비공선 모서리 삭제와 혼합 구조 편집 게시 제외 | Release WASM·T009·독립 CFB 검사 및 RHWP 재열기 PASS. Linux X11 수락 대기 | C IMPLEMENTED_UNVERIFIED. [검증 기록](stage3-a-p4-hwp5-polygon-acceptance.json) |
| P4-DX-PATH | DOCX 직선·폐합 사용자 경로 | f32 정규화 선 경로 / 외곽 스케일 | 점·꼭짓점 없음 | 좌표 정밀도와 path 속성의 원본 왕복 및 독립 DrawingML 검사 | 변환 수락만 | A PARTIALLY_IMPLEMENTED |
| P4-H5-GROUP | HWP5 그룹 자식 | 재귀 SC_CONTAINER 모델 / HWPX 전용 자식 API | HWP5 자식 기하 없음 | 자식 leaf 보존과 주소·이동/크기 증명 | 기존 그룹 외곽만 | A PARTIALLY_IMPLEMENTED |
| P4-DX-GROUP | DOCX 그룹 자식 | `GroupChild`, 그룹 내부 경로 / WordCraft canvas 기반 | geul 자식 주소·편집 없음 | child transform·미디어·sibling 순서, 중첩 평탄화 해결 | 기존 그룹 외곽만 | A PARTIALLY_IMPLEMENTED |
| P4-HX-NEST | HWPX 중첩 자식 | 재귀 모델 / 평면 API | 평면 자식만 | 명시적 parent/child 경로 및 원본 행렬 검증 필요 | 평면 수락만 | A PARTIALLY_IMPLEMENTED |
| P4-GROUP-XFM | HWPX 평면 회전·배율·반전·전단 | 모델과 자식 API 있음 / `raw_rendering` 거부 | 자식 UI 비활성 | 개별 행렬과 합성, 정수 역변환, 타원 및 축 의미 검증 | 기존 음성 PASS / 해당 활성화 없음 | B BLOCKED_BY_SAFETY |
| P4-PATH-XFM | HWPX 다각형·HWP5 열린 cubic의 비항등 행렬/오프셋 | 점 변경 API / `stage3a-path-transform-safety.patch` | 해당 선택 비활성 | 정확한 좌표 변환과 저장 행렬 불변 증명, HWP5 기존 오프셋 바이트 보존 | 음성 WASM/T009 PASS / 기존 X11 재사용 | B BLOCKED_BY_SAFETY |

## P5 이야기와 글상자

| ID | 형식·소유자 | 파서·모델 / 변경 API | geul 명령·UI | 저장 경계 및 필요한 수락 | 기존 단위·WASM / Native | A/B/C·상태·커밋 |
|---|---|---|---|---|---|---|
| P5-STORY-ALT | DOCX linked header/footer/footnote/endnote | `StoryRef::Part` / `object.altText` | 속성·그림 선택 | 일치하는 두 설명만 변경, 별도 OPC part·관계 불변 | Rust/T009 PASS / X11 4개 PASS | IMPLEMENTED_VERIFIED `1a9ab10` |
| P5-DX-HDR-SIZE | DOCX 머리말 최상위 내장 인라인 그림 | 별도 `StoryRef::Part` / `arrange.bounds` | 속성 크기, `object.edit/bounds` | 초기 이야기 XML의 바이트 보존, 별도 OPC 관계 및 미디어, 두 extent 동기화 | Rust/T009 PASS / X11·Wayland PASS | B 활성화, IMPLEMENTED_VERIFIED `7a0811ac`. [크기 조정 수락](stage3-a-p5-story-size-acceptance.json) |
| P5-DX-FTR-SIZE | DOCX 꼬리말 최상위 내장 인라인 그림 | 별도 `StoryRef::Part` / `arrange.bounds` | 속성 크기, `object.edit/bounds` | 초기 이야기 XML의 바이트 보존, 별도 OPC 관계 및 미디어, 두 extent 동기화 | Rust/T009 PASS / X11·Wayland PASS | B 활성화, IMPLEMENTED_VERIFIED `7a0811ac`. [크기 조정 수락](stage3-a-p5-story-size-acceptance.json) |
| P5-DX-FN-SIZE | DOCX 각주 최상위 내장 인라인 그림 | 별도 `StoryRef::Part` / `arrange.bounds` | 속성 크기, `object.edit/bounds` | 초기 이야기 XML의 바이트 보존, 별도 OPC 관계 및 미디어, 두 extent 동기화 | Rust/T009 PASS / X11·Wayland PASS | B 활성화, IMPLEMENTED_VERIFIED `7a0811ac`. [크기 조정 수락](stage3-a-p5-story-size-acceptance.json) |
| P5-DX-EN-SIZE | DOCX 미주 최상위 내장 인라인 그림 | 별도 `StoryRef::Part` / `arrange.bounds` | 속성 크기, `object.edit/bounds` | 초기 이야기 XML의 바이트 보존, 별도 OPC 관계 및 미디어, 두 extent 동기화 | Rust/T009 PASS / X11·Wayland PASS | B 활성화, IMPLEMENTED_VERIFIED `7a0811ac`. [크기 조정 수락](stage3-a-p5-story-size-acceptance.json) |
| P5-DX-SIZE-NONCANON | DOCX 별도 이야기의 일치하지 않는 치수 또는 비정규 원본 | 크기 API 및 원본 비교 존재 / 초기 왕복·치수·해당 리소스 증명 실패 | 대체 설명의 별도 범위만 | 원본 용어와 두 치수 해석, 비정규 관계 및 변환 보존 | 음성 T009 PASS | B BLOCKED_BY_SAFETY |
| P5-DX-HF-MOVE | DOCX 머리말·꼬리말 인라인 그림 이동 | 별도 Part / WordCraft `move_object`의 header/footer 경로 | geul 이야기 이동 거부 | 부유 전환, anchor·관계·ID 및 등장 페이지의 영향 증명 | 없음 | B BLOCKED_BY_SAFETY |
| P5-DX-NOTE-MOVE | DOCX 각주·미주 인라인 그림 이동 | 별도 Part / WordCraft `movable_story`에서 노트 제외 | 없음 | 실제 노트 안 run/문단 주소 및 제어·번호·ID 보존 | 없음 | A UNIMPLEMENTED |
| P5-DX-DELETE | DOCX 각 이야기 인라인 그림 삭제 | 별도 Part / `text.delete`, media 수집 | 설명만 | 리소스 참조 집계, 관계·그림 ID 재번호 및 노트 경계 증명 | 설명 수락만 | B BLOCKED_BY_SAFETY |
| P5-R-HDR | HWP5/HWPX 머리말 그림 | story 소유 모델, RHWP 머리말 그림 속성 API | 본문 적중만 | 활성 이야기·페이지·소유 컨트롤과 파일별 저장 증명 | 개체 수락 없음 | B BLOCKED_BY_SAFETY |
| P5-R-FTR | HWP5/HWPX 꼬리말 그림 | story 소유 모델, RHWP 꼬리말 그림 속성 API | 본문 적중만 | 머리말과 별개 활성 소유자, 레코드/패키지 보존 | 개체 수락 없음 | B BLOCKED_BY_SAFETY |
| P5-R-HF-OBJECTS | HWP5/HWPX 머리말·꼬리말의 그림 외 개체 | 이야기·개체 모델 / 개체별 소유 변경 경로 부재 | 없음 | 활성 story와 제어 경로, 레코드·패키지 검증 | 없음 | A UNIMPLEMENTED |
| P5-R-FN | HWP5/HWPX 각주 개체 | 노트 모델 / 직접 편집 소유 API 없음 | 없음 | 참조와 번호 및 노트 컨트롤·문단 경로 명시 | 없음 | A UNIMPLEMENTED |
| P5-R-EN | HWP5/HWPX 미주 개체 | 노트 모델, 가상 인덱스 경로 / 안정 소유 API 없음 | 없음 | 본문과 겹치는 인덱스 대신 실제 노트 owner/children | 없음 | A UNIMPLEMENTED |
| P5-TB-SPLIT | HWPX 본문 글상자 | 문단·서식 run / RHWP split | Enter | 혼합 run·paragraph shape, 64문단 상한, 저장·독립 재열기 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `1a9ab10` |
| P5.5 | HWPX 글상자 인접 두 문단 | 같은 문단 모양·스타일 검사 / 범위 삭제 | Backspace/Delete 및 선택 삭제 | 양 끝 run·외곽·형제 유지 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `f61e208` |
| P5-H5-TB | HWP5 글상자 분할·병합 | 문단 모델, 본문 편집 API / 글상자 경로 HWPX 한정 | 단일 평문 문단 편집까지 | LIST_HEADER·제어 레벨·shape ID와 T009 증명 | 구조 변경 수락 없음 | B BLOCKED_BY_SAFETY |
| P5-TB-RANGE | HWPX 글상자 세 문단 이상, 동일 문단 모양·스타일 | 모든 인접 쌍 검증 / `deleteRangeInCell` | Delete/Backspace | 중간 문단 소유 검증, 남은 run/언어·외곽 보존, T009 | PASS / X11 PASS | B 활성화, IMPLEMENTED_VERIFIED `2b25b915`. [수락 기록](stage3-a-p5-textbox-range-acceptance.json) |
| P5-TB-MIX | HWPX 글상자 서로 다른 문단 서식 | 범위 삭제 API / 인접 proof의 서식 일치 요구 | 거부 | 문단 서식 승계 규칙과 저장·재열기 증명이 필요 | 음성 PASS / 해당 없음 | B BLOCKED_BY_SAFETY |
| P5-TB-REPLACE | HWP5/HWPX 글상자 클립보드·IME 범위 교체 | 기존 텍스트 조합/붙여넣기, 인접 삭제 | 교차 문단 교체 제한 | 선택 세대, 삭제와 삽입 단일 이력, stale preedit 거부 | 일반 글상자 IME와 P5.5만 | B BLOCKED_BY_SAFETY |
| P5-TB-CONTROL | HWP5/HWPX 및 DOCX 글상자 중첩 개체 | RHWP 모델 내 중첩; WordCraft 일부 글상자+그림을 그림으로 읽음 | 중첩 소유 편집 없음 | 실제 경로 바인딩과 HWP/HWPX 레코드, DOCX 타입 손실 해결 | 없음 | A UNIMPLEMENTED |

## P6 구조, 변환, 캡션과 SmartArt

| ID | 소스 → 대상·개체 | 파서·모델 / 변경 API | geul 명령·UI | 저장 경계 및 필요한 수락 | 기존 단위·WASM / Native | A/B/C·상태·커밋 |
|---|---|---|---|---|---|---|
| P6.1 | HWPX → HWPX 폐합 다각형 | 정수 portable 경로 / 대상에서 복제 | 구조 복사·붙여넣기 | 대상 ID, 원본+형제 불변, 정확한 경로·서식 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `ab99043` |
| P6.2-type | DOCX 사각형 ↔ 타원 | preset / `shape.change` | 속성 변환 | 지원 프리셋만, 외곽·서식·리소스 보존 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `ab99043` |
| P6.2-format | HWPX 무윤곽 다각형 → DOCX 자유형 | portable points / `pasteHwpxPolygon` | 구조 붙여넣기 | 127 EMU/HWPUNIT, 편집 가능 DrawingML, 원본 불변 | PASS / X11 PASS | IMPLEMENTED_VERIFIED `ab99043` |
| P6.3/P6.7 | HWPX 본문 그림 캡션 위·아래 및 간격 | caption model / `setPictureProperties` | `captionSide/Spacing` 속성 | 단일 atno·번호·run·BinData와 XML, 0–32767 gap | PASS / X11 PASS | IMPLEMENTED_VERIFIED `ab99043`, `7f98d7a` |
| P6.4 | DOCX 정규 SmartArt | WordCraft data/layout/style/colors/drawing / 항목·단계·레이아웃 | 속성 UI | T009 재생성 부품·관계 proof | PASS / X11 PASS | IMPLEMENTED_VERIFIED `ab99043`, 기존 P6 수락 |
| P6-H5-CLIP | HWP5 → HWP5 구조 클립보드 | 개체+DocInfo/BinData 모델 / `copyControl/pasteControl` 동일 세션 | session/generation/token 일치에서만 | 대상 character/para style과 BinData의 실제 재매핑이 부재 | 동일 문서 PASS / 같은 세션만 | A PARTIALLY_IMPLEMENTED |
| P6-HX-GROUP | HWPX → HWPX 평면 그룹 | 그룹 모델 / 동일 세션 복제 | portable 그룹 생성 없음 | 자식 순서·변환·새 ID·공유 리소스 검증 | 동일 문서만 | A PARTIALLY_IMPLEMENTED |
| P6-HX-CURVE | HWPX → HWPX 곡선 | 모델 경계에 segment 손실 / 동일 세션 복제 | portable 곡선 없음 | P4-HX-CURVE와 정확한 타입·서식·대상 ID 매핑 | 지원 범위 없음 | A UNIMPLEMENTED |
| P6-HX-TYPE | HWPX/HWP5 개체 유형 변경 | 개별 도형 모델 / 타입 변경 API 없음 | 없음 | 대상 타입별 HWP/HWPX 구조와 부적합 속성 거부 | 없음 | A UNIMPLEMENTED |
| P6-DX-TYPE | 추가 DOCX 도형 변환 | 기본 preset / `shape.change` 일부 | 사각형·타원만 | per-type stroke·fill·transform·outline 매핑 | 기존 프리셋만 | B BLOCKED_BY_SAFETY |
| P6-DX-HX | DOCX → HWPX 개체 | WordCraft 포맷 개체, RHWP 대상 생성 API / 가교 매핑 없음 | 교차 형식 붙여넣기 거부 | DrawingML 프리셋·구간, EMU와 HWPUNIT, 서식·캡션 및 관계 자원 매핑 | 없음 | A UNIMPLEMENTED |
| P6-DX-H5 | DOCX → HWP5 개체 | 각 엔진 모델 / HWP5 매핑 부재 | 없음 | DrawingML 속성, HWP5 DocInfo·BinData 및 writer/T009 | 없음 | A UNIMPLEMENTED |
| P6-H5-DX | HWP5 → DOCX 개체 | 각 엔진 모델 / HWP5 payload 및 DrawingML 매핑 부재 | 없음 | HWPUNIT→EMU, 소스 CFB 음영·선·미디어와 편집 가능한 대상 | 없음 | A UNIMPLEMENTED |
| P6-H5-HX | HWP5 → HWPX 개체 | HWP5 모델과 HWPX serializer / 형식 간 개체 전송 없음 | 없음 | HWP5 원본 제어·DocInfo와 대상 패키지 매핑 | 없음 | A UNIMPLEMENTED |
| P6-HX-H5 | HWPX → HWP5 개체 | HWPX portable 일부, HWP5 대상 전송 없음 | 없음 | 대상 DocInfo/BinData·소유자 및 안전 삽입 증명 | 없음 | A UNIMPLEMENTED |
| P6-HX-DX-MORE | HWPX → DOCX, 기존 다각형 외 개체·속성 | 기존 자유형 변환의 정확한 단일 매핑 | 기존 다각형 범위만 | 새 유형별 선·채우기·경로·캡션·관계를 개별 검증 | 기존 다각형만 PASS | A PARTIALLY_IMPLEMENTED |
| P6-HX-CAP-SIDE | HWPX 본문 그림 캡션 좌우 | 네 방향 및 serializer / 그림 속성 API | 지원 열 기준 부유 그림에 좌우 옵션 | 소유 증명, 좌우 렌더와 독립 XML/번호·서식·이미지 검사 | PASS / X11 PASS | B 활성화, 지원 부유 그림 IMPLEMENTED_VERIFIED `bac51567`. [수락 기록](stage3-a-p6-caption-lateral-acceptance.json) |
| P6-HX-CAP-ALIGN | HWPX 본문 캡션의 좌우 배치 시 세로 정렬 | `caption.vert_align` 및 serializer / 그림 속성 API | `captionVerticalAlign` 및 속성 UI | 캡션 세로 좌표, `subList@vertAlign`, 번호·서식·리소스 검증 | PASS / X11 PASS | A 구현, 지원 부유 그림 IMPLEMENTED_VERIFIED `bac51567`. [수락 기록](stage3-a-p6-caption-lateral-acceptance.json) |
| P6-HX-CAP-INLINE | HWPX 인라인 그림의 좌우 배치 및 그 상태의 세로 정렬 | XML과 변경 API 있음 / 인라인 렌더러는 아래에 페인트 | 기능 거부 | 인라인 너비·좌표와 소유 캡션 배치의 엔진 경계 교정 | 음성 WASM PASS / 조작 미지원 | B BLOCKED_BY_SAFETY |
| P6-H5-CAP | HWP5 그림 캡션 배치 | 캡션 값 및 변경 API / T009 캡션 리스트 보존 | 위치 속성 없음 | LIST_HEADER의 허용 필드를 분리해 나머지 바이트 보존 | 일반 캡션만 | B BLOCKED_BY_SAFETY |
| P6-OTHER-CAP | DOCX, RHWP 그룹 등 고급 캡션 | RHWP 캡션 모델, DOCX 소유 캡션에 대응하는 구조 미확정 | 해당 소유 작업 없음 | 대상마다 캡션·번호·개체 관계와 T009 | 해당 없음 | A UNIMPLEMENTED |
| P6-SMARTART-MODEL | DOCX 비정규 레이아웃/노드별 스타일 | 정규 SmartArtSpec 범위 / 기존 items/layout | 정규만 | 추가 구조의 data/layout/style/colors/drawing 원본 구조 | 정규만 | A PARTIALLY_IMPLEMENTED |
| P6-SMARTART-SHARED | DOCX 공유·외부 SmartArt 부분 | 기존 모델 변경 엔진과 재생성 / 소유 증명 거부 | 거부 | 소유권 없는 공유/외부 파트의 직접 변경 | 기존 거부 유지 | B BLOCKED_BY_SAFETY, 공유 대상 직접 덮어쓰기는 UNSUPPORTED_BY_DESIGN |
| P6-R-SMARTART | HWP5/HWPX SmartArt 호환 편집 | 네이티브 동형 구조 모델 없음 | 없음 | 실제 대상 editable 구조의 명세와 리소스 계약 필요 | 없음 | A UNIMPLEMENTED |

## C 플랫폼 증거

기존 X11의 PASS는 각 기록의 fixture와 실행 신원 범위로 재사용한다. Wayland는 실제 Wayland 입력 경로와 GDK Wayland 실행 신원, Windows/macOS는 해당 네이티브 OS에서 각각 지원 문서의 대표 UI, 실제 파일 대화상자, Undo/Redo 및 앱 저장/독립 패키지 검사/재열기가 필요하다. 기존 검증 기록과 소스 확인에는 [P4–P6 명령](command-registry.md#stage-3-a-p4-개체-경로와-그룹-자식) 및 [T009 증명](save-preservation.md#stage-3-a-p4-경로-및-그룹-자식)을 사용한다.

| 플랫폼 | 결과와 전제 | 남은 실행 및 증거 |
|---|---|---|
| Linux Wayland | P6 왼쪽·세로 가운데 배치 및 P5 DOCX 네 이야기 크기 조정 PASS. 앱을 `GDK_BACKEND=wayland`로 강제하고 `DISPLAY`를 비운 격리 Weston 15 세션에서 조작했다. [Wayland 캡션 수락](stage3-a-wayland-caption-acceptance.json), [Wayland DOCX 이야기 수락](stage3-a-wayland-story-size-acceptance.json) | P4 경로, P5 글상자, P6 오른쪽 등 기타 조합은 NOT RUN. 지원 환경에서 Release를 만들고 같은 Wayland 입력과 저장·재열기 증거를 남긴다. |
| Windows | NOT RUN — environment unavailable. 지원 Windows 호스트·GUI 세션 부재. | 지원 Windows 호스트의 [릴리스 절차](../release-checklist.md)에 따라 네이티브 의존성과 Release WASM을 준비하고 `npm run tauri -- build --no-bundle`로 Tauri Release를 만들고 생성된 앱을 실행한다. DOCX/HWP/HWPX 열기 대화상자, 편집, Undo/Redo, 저장·재열기와 native path·패키징을 기록한다. |
| macOS | NOT RUN — environment unavailable. 지원 macOS 호스트·GUI 세션 부재. | 지원 macOS 호스트의 [릴리스 절차](../release-checklist.md)에 따라 네이티브 의존성과 Release WASM을 준비하고 `npm run tauri -- build --no-bundle`로 Tauri Release를 만들고 생성된 앱을 실행한다. 실제 개체 선택, 대표 편집, 파일 대화상자, Undo/Redo와 저장·재열기, 번들 리소스와 입력을 기록한다. |

현재 Stage 3-A와 Stage 3 전체는 **PARTIALLY COMPLETED**다. 기존 Stage 3-B 및 Stage 3-C 수락은 각 범위의 기록을 따른다.
