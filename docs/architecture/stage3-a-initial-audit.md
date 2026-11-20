# Stage 3-A 초기 구현 감사

기준은 `b411b850c6bb09082341f12439b7d623704a5faf`이다. 상위 저장소(master), 인덱스와 두 서브모듈 모두 변경이 없었다. RHWP `1a76570e833917d15817415a53c09ad61ab3203f`는 `scripts/rhwp-patches.py`의 패치 적용본을 빌드한다. WordCraft는 `b2c974369dd02d322a5498db484bcf96906dad15`다. 활성 RHWP Release 세대는 `165fc4092820c28ffa7299ec93f091bcf4d2e9d784c65c011db807492898a892`, WASM SHA-256은 `9520e24b34c33d5f49fdd267f08fd858fea098fd2b8a58395e65b5768b26aef4`다.

| 항목 | 형식·기준 상태 | 엔진과 UI 현황 | 필요한 모델·저장 작업 | 필요한 수용 증거 |
|---|---|---|---|---|
| P4.1 다각형 | HWP5/HWPX, DOCX · UNIMPLEMENTED | RHWP는 정수 꼭짓점과 반복 종점 폐합을 읽는다. 기존 UI는 외곽 편집만 제공한다. WordCraft는 DrawingML 경로를 f32 좌표로 정규화한다. | 본문 소유 경로와 유효 기하 확인, 선택 점만 수정. HWP5 T009는 현재 leaf 동일성을 요구한다. DOCX는 원본 경로 해석 및 정밀도 증명이 필요하다. | 실제 꼭짓점 드래그와 정밀 입력, 폐합·점 순서·서식·리소스, Undo/Redo, 게시 및 독립 좌표 비교 |
| P4.2 Bézier | HWP5, HWPX, DOCX · UNIMPLEMENTED | RHWP HWP5 렌더러는 직선과 3점 cubic을 구분한다. HWPX 리더는 세그먼트 타입을 버리고 점 체인을 만든다. WordCraft는 quadratic/cubic을 직선으로 샘플링한다. 제어점 UI가 없다. | 원본 명령을 모델링하고 기존 구간의 점만 편집. HWP5 leaf의 개수·구간 바이트·패딩 증명. HWPX/DOCX는 손실 없는 명령 모델 필요. | 제어점과 공유 끝점, 구간 종류 및 순서, 부적합 구간 거부, Undo/Redo 및 독립 경로 비교 |
| P4.3 그룹 자식 | HWP5/HWPX, DOCX · UNIMPLEMENTED | RHWP는 재귀 자식 모델을 갖고 그룹 외곽을 선택한다. WordCraft는 중첩 그룹을 읽을 때 평탄화한다. 두 앱 어댑터 모두 자식 변경 주소가 없다. | 부모·자식 경로, 잠금, 로컬 변환 증명. HWP5는 전체 자식 레코드 동일성 요구. DOCX 중첩 보존에는 파서·라이터 작업이 필요하다. | 개별 자식 UI 편집, 상위 변환·형제·미디어 불변, Undo/Redo, 게시 및 재열기 |
| P5.1 머리말 | HWP5/HWPX, DOCX · IMPLEMENTED BUT BLOCKED | RHWP는 전용 그림 속성 조회/변경 API를 제공한다. 앱의 본문 적중 경로는 머리말을 배제한다. WordCraft는 별도 Part에 담으며 개체 변경을 거부한다. | 페이지별 활성 머리말과 보관된 소유 컨트롤 연결. WordCraft 별도 OPC part, RHWP HWP5 자식 레코드의 보존 증명. | 소유 머리말에서 실제 편집, 본문·꼬리말과 충돌 주소 거부, 페이지 유형과 저장/재열기 |
| P5.1 꼬리말 | HWP5/HWPX, DOCX · IMPLEMENTED BUT BLOCKED | 머리말과 같은 API를 사용하며 소유 story와 페이지 배치가 다르다. | 꼬리말 주소와 활성 페이지 규칙, 해당 파트·레코드만 변경되는 저장 증명. | 실제 꼬리말 편집, 머리말·본문 불변, Undo/Redo 및 게시본 독립 재열기 |
| P5.1 각주 | HWP5/HWPX, DOCX · IMPLEMENTED BUT BLOCKED | RHWP는 본문 각주 컨트롤과 노트 문단을 모델링한다. 그림 전용 노트 API는 없다. WordCraft는 별도 Part로 읽고 UI 변경을 제한한다. | 소유 각주 컨트롤/내부 문단 경로, 노트 참조와 번호 보존. | 두 각주 및 본문에 같은 로컬 인덱스가 있는 사례, 정확한 소유권·번호·Undo/Redo 및 재열기 |
| P5.1 미주 | HWP5/HWPX, DOCX · IMPLEMENTED BUT BLOCKED | RHWP 도형 API의 미주 문단은 가상 인덱스를 사용한다. 앱에서 본문 주소로 사용하는 것을 차단한다. WordCraft는 별도 Part로 읽는다. | 명시적 미주 컨트롤과 내부 문단 경로, 참조·번호·별도 파트 변경 증명. | 미주 소유자 불일치, 본문 별칭 거부, 실제 편집 및 저장·재열기 |
| P5.2 복합 글상자 | HWP5/HWPX, DOCX · PARTIALLY IMPLEMENTED | RHWP는 평문 다문단 편집과 제한된 서식/클립보드를 지원한다. WordCraft는 본문 소속 글상자 내부 일부 개체를 편집하고 그림을 오분류할 수 있다. | 혼합 run과 문단 구조에 대한 편집 보존, 내부 컨트롤 경계, 커서·IME 소유 검증. | 혼합 run·문단과 내부 컨트롤, 좌표·여백·정렬 보존, Undo/Redo 및 재열기 |
| P6.1 구조 클립보드 | HWP5/HWPX, DOCX · PARTIALLY IMPLEMENTED | HWP5 동일 문서, HWPX 제한 휴대용, DOCX v2 미디어/ID 매핑이 있다. HWPX 교차 문서 그룹·다각형·곡선과 미지원 양식은 거부한다. | 새 유형별 재구성/재발급, 원본 불변과 자원 소유 증명. | 양쪽 문서, 실제 MIME, 거부 무변이, Undo/Redo·게시·재열기 |
| P6.2 개체 유형 변환 | HWP5/HWPX, DOCX · UNIMPLEMENTED | 지원 기본 도형 삽입과 외곽 편집은 변환이 아니다. | 정확한 소스–대상 기하/서식 매핑과 새 형식 식별자·리소스 처리. | 대상이 편집 가능하며 눈에 보이는 속성과 저장 구조가 보존되는 실제 변환 |
| P6.2 교차 형식 변환 | HWP5/HWPX, DOCX · UNIMPLEMENTED | 형식별 봉투와 엔진 모델이 각각 다르고 구조 MIME의 교차 형식은 거부한다. | 형식 쌍별 무손실 부분집합, 자원 소유 증명 및 대상 게이트. | 형식별 저장·독립 재열기와 대상 편집, 불일치 거부 |
| P6.3 고급 캡션 | HWP5/HWPX · PARTIALLY IMPLEMENTED. DOCX · UNIMPLEMENTED | RHWP 본문 소유 캡션, 다문단, 단일 atno 및 일부 혼합 서식은 기존 지원이다. HWPX 휴대용 payload에 방향·세로 정렬이 있다. | 새로운 속성별 앱 편집과 캡션 소유·번호 검증. HWP5 캡션 LIST_HEADER 변경 증명. DOCX의 대응 소유 모델 확인 필요. | 캡션 방향/정렬과 복합 문단, 번호·그림·형제 보존, Undo/Redo 및 게시 |
| P6.4 SmartArt | DOCX · ALREADY SUPPORTED(정규 섹션의 항목·단계·레이아웃). HWP/HWPX · UNIMPLEMENTED | WordCraft `SmartArtSpec`와 `smartArt.items/layout`을 사용한다. 기존 P6 Linux에서 실제 편집과 재열기를 수용했다. 기타 외부 구조는 보존 검사가 제한한다. | 정규 data/layout/style/colors/drawing 관계를 확인. 외부 도형 모델 또는 스타일 확장에는 독립 part 보존 증명 필요. | 기존 범위 실제 경계, 비정규/공유 파트 거부, 변경한 경우 실제 패키지 비교 |

과거 수용은 [Stage 3-B](stage3-b-safety-acceptance-2026-11-20.md), [Stage 3-C](stage3-category-c-native-acceptance-2026-11-20.md), [기존 DOCX 그래픽](stage3-p6-native-acceptance-2026-11-19.json)에 기록돼 있다.
