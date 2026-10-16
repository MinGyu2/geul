# 테스트 픽스처 정책

공개 저장소이므로 출처와 라이선스가 분명한 파일만 커밋합니다.

## 허용되는 픽스처

1. 이 프로젝트 기여자가 직접 작성한 문서 (기여자가 CC0-1.0으로 제공한다고 명시)
2. 엔진 API나 스크립트로 생성한 문서 (생성 방법을 함께 기록)

다음은 커밋하지 않습니다.

- 실제 업무·개인 문서, 출처가 불분명한 인터넷 문서
- `external/rhwp/samples/`, `external/rhwp/pdf/`, `external/rhwp/mydocs/` 등 업스트림 자료의 복사본
  (파일별 출처·라이선스가 명시되어 있지 않음). 로컬 탐색용으로는 submodule 경로를 그대로 참조할 수 있지만
  자동 테스트의 필수 입력으로 쓰지 않습니다.
- 개인 문서로 재현해야 하는 경우 `tests/fixtures/private/` 또는 `tests/fixtures/local/`(Git 무시 대상)에 둡니다.

## 계획된 최소 세트 (T007/T008에서 생성)

| 경로 | 내용 | 생성 방법(예정) |
|------|------|-----------------|
| `hwp/basic-ko.hwp` | 한·영 문단, 굵게, 2×2 표 | rhwp API로 생성 후 내보내기 |
| `hwpx/basic-ko.hwpx` | 같은 내용 | rhwp API로 생성 후 내보내기 |
| `docx/basic-ko.docx` | 같은 내용 | WordCraft 엔진 명령으로 생성 후 저장 |
| `invalid/hwp-bytes.docx` | HWP 바이트에 `.docx` 확장자 | 위 파일 복사·이름 변경 |
| `invalid/truncated.hwpx`, `invalid/truncated.docx` | 중간에서 잘린 ZIP | 위 파일 잘라내기 |
| `encrypted/` | 암호화 문서 (테스트 전용 비밀번호를 README에 공개) | 엔진의 암호화 내보내기 |

## 픽스처 추가 규칙

- 각 파일 옆 `PROVENANCE.md`(또는 이 README의 표)에 작성자·생성 방법·도구 버전·라이선스를 적습니다.
- 문서 속성(작성자, 회사, 마지막 수정자, 파일 경로)에 개인정보가 남지 않았는지 확인합니다.
- 커밋 전 `python3 scripts/check-sensitive-info.py --staged`를 통과해야 합니다. 바이너리 문서 내부는
  이 검사기가 보지 못하므로 문서 속성과 본문을 직접 확인합니다.
