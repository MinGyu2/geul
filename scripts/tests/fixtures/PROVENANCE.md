# Stage 3-A P4 DOCX 그룹 fixture 출처

`stage3a-p4-dx-group.docx`는 geul의 T009 회귀 테스트
`stage3_docx_group_child_geometry_t009_preserves_nested_resources`가 생성한 합성 문서다.
`tests/fixtures/wordcraft/basic.rs`의 `basic::basic_ko()` 테스트 모델에 중첩 그룹, 도형, 그림,
최상위 형제 도형을 추가하고 고정 WordCraft 엔진의 `io::save_bytes`로 저장한다. 같은 테스트가
재생성된 DOCX의 모든 패키지 항목을 이 파일과 바이트 단위로 비교한다.

문서에는 테스트 코드가 만든 한국어·영어 본문과 DrawingML 도형만 있으며, 외부 문서나 외부 이미지를
복사하지 않았다. 그림은 `image` crate 0.25.10(Cargo.lock 고정)으로 생성한 단색 3×2 RGB 픽셀
`(40, 90, 170)`이다. 임베디드 `word/media/image1.png` SHA-256은
`0c52bcd0a7b96a1d5e542650862e255db9d90cbcb89aeacbd245dba8d9d02c6a`이며 PNG 청크는
`IHDR`, `IDAT`, `IEND`뿐이다. 청크 메타데이터나 텍스트는 없고, 압축을 푼 픽셀은 여섯 개 모두 같은
RGB 값이다.

`docProps/core.xml`은 비어 있고 `docProps/app.xml`에는 응용 프로그램 이름과 문서 통계만 있다.
작성자, 마지막 수정자, 회사, 로컬 경로는 들어 있지 않다. DOCX 전체의 SHA-256은
`c212ed4ad805610abfe583d47cce0ff870f1331b98f3bc891e99e9950a81fa5b`다. 내용은 저장소 테스트 코드만으로
만든 합성 산출물이며 저장소 MIT 라이선스를 따른다.
