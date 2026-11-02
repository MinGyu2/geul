# 외부 HWPX textDir 보존 후보 (2026-11-02)

상태: **INCOMPLETE — 제품에 적용하지 않은 후보. Stage 2 완료 커밋 없음. 새로 안전 저장 가능한 외부 문서 0개.**

이 문서·패치·재현 스크립트는 후속 검토를 위한 실험 후보 보존 대상으로 커밋한다. 후보 보존 커밋은 Stage 2 완료나 제품 적용 승인을 뜻하지 않는다. 바이너리·추출 소스·원시 결과는 기존 `/target/` 제외 규칙에 따라 Git에 넣지 않는다.

선택 샘플은 고정 rhwp `1a76570`의 `samples/종이기준.hwpx`다. 기존 geul preflight는 `Contents/header.xml`, `Contents/section0.xml` 변경으로 unsafe였다. `hh:paraPr@textDir="LTR"` 20개가 파서 `parser/hwpx/header.rs::parse_para_shape`에서 수집되지 않고, IR에도 명시 여부가 없으며 serializer `write_para_pr`에서도 출력되지 않았다. 텍스트 편집 이전에 이미 사라진다. 문단 ID는 별개다. 파서는 `hp:p@id`를 `Paragraph.raw_header_extra[6..10]`에 보관하지만 serializer가 `ctx.next_para_id()`를 써 재번호화한다. 이 후보는 ID나 참조를 변경하지 않는다.

`patches/rhwp/hwpx-textdir-ltr.patch`는 파서→`ParaShape.hwpx_explicit_ltr`→serializer로 명시적 LTR을 보존한다. 스타일 복사와 동일성 비교에 포함하고 HWP 입력의 기본값은 false다. absent를 LTR로 만들어 내지 않는다. 이 좁은 후보에서 RTL·빈 값·모르는 값은 오류로 거부한다. RTL 지원이나 일반 XML 보존을 주장하지 않는다. 문자열 XML 치환이나 comparator 예외는 추가하지 않았다.

`python3 scripts/build-rhwp-textdir-candidate.py`는 고정 커밋의 빌드 입력만 추출하고 패치를 적용한다. 원본 서브모듈과 gitlink는 그대로다. 기존 `target/rhwp-wasm` 캐시, locked/offline Cargo, geul 읽기 전용 소스 빌드 경계를 사용한다. 산출물은 `target/four-stage/stage2-textdir/web`에만 두며 제품 public assets를 게시하지 않는다. 기존 wasm-bindgen 0.2.127을 PATH에 제공해야 한다. 이 실행의 실제 Rust는 설치된 1.99.1이다. 이전 1.99.0 Nix 경로가 없어 같은 target에서 의존성이 재빌드됐으며 새 도구나 의존성을 설치하지 않았다.

`python3 scripts/tests/hwpx-textdir-roundtrip.py --out <새 출력 디렉터리>` 검증 결과:

| 검사 | 결과 |
|---|---|
| 원래 고정 엔진 | LTR 20개 중 0개 보존, preflight unsafe |
| 후보 무편집·텍스트 삽입·반복 export와 raw WASM 재열기 | LTR 20개 보존, 본문/컨트롤/쪽 동등 PASS |
| 기존 엔진 출력 대비 다른 ZIP 부분 바이트 및 나머지 header XML | 동일 PASS |
| absent 방향 속성 | 편집 뒤에도 absent PASS |
| RTL / UNKNOWN / 빈 값 | 파싱 거절 PASS |
| geul preflight | 여전히 unsafe, header.xml·section0.xml 변경 |
| 실제 앱 경로의 safe 편집·저장·재열기 | NOT RUN — 독립적인 preflight 손실이 남음 |

원본과 후보 사이의 **모든** XML 보존을 검증했다고 해석하면 안 된다. 원본의 heading switch/기본 속성 구조 손실과 문단 ID 문제가 남는다. 패키지 전체 안전 저장을 통과하지 못했으므로 기본 앱 빌드로 승격하지 않았다. 상위 엔진 로컬 커밋이나 미공개 gitlink는 없다. 후보 WASM SHA-256은 `09c623edcfd468521d07fdd285d2ea318606b0263d80be794eb18b5b5908024a`; 패치 SHA-256은 `e3828d1fb85024e8a8c07449b78dbec936d5150dd501958ebe5ae8a62835928b`다. 원시 결과는 `target/four-stage/stage2-textdir/regression/result.json`에 있다.

다음 완료 조건은 문단 ID의 소유·참조·새 문단 생성 규칙 및 header switch 정보를 보존해 이 샘플의 preflight를 safe로 만들고, 그때 재현 가능한 패치를 앱 빌드에 통합하여 실제 세션 편집·원본 형식 저장·재열기까지 통과하는 것이다. 기존 외부 7개가 호환된다고 주장하지 않는다. package comparator와 fail-closed 정책은 바꾸지 않았다.
