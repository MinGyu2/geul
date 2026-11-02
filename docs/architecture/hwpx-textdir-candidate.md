# 외부 HWPX textDir 보존 후보 (2026-11-02)

초기 textDir 단독 후보 상태(당시 기록): **INCOMPLETE — 제품에 적용하지 않은 후보. 새로 안전 저장 가능한 외부 문서 0개.** 아래의 초기 조사 결과와 해시는 그 당시 후보의 기록이다. 현재의 결론은 문서 끝의 「Stage 2 후속 구현·수용」을 따른다.

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

## Stage 2 후속 구현·수용 (2026-11-02)

검증한 범위는 고정 소스 `external/rhwp/samples/종이기준.hwpx`(SHA-256 `2903b6f7a261005fa9a191cc7caa66d8307438b9cb93410f79fc61fd1fa0d9d8`)와 관련 회귀 샘플이다. 다른 외부 HWPX의 일반 호환성은 뜻하지 않는다.

패치의 현재 내용은 명시적 `textDir=LTR` 20개, 외부 `hp:p@id` 3121190098, `Contents/header.xml`의 세 개 heading switch를 파서→IR→직렬화기에서 보존한다. 원래 문단 ID는 기존 raw-header identity에 결부하고 새 문단에는 보존한 ID 집합과 충돌하지 않는 ID를 준다. 분할·병합·복사·다중 구역·표/머리말/꼬리말/각주 중첩·반복 내보내기와 HWP5 독립 경로를 실제 WASM으로 검사했다. 원본에 없거나 중복·범위 초과인 ID는 문서를 읽을 수 있지만 내보내기를 거부한다. RTL·미지 방향·빈 방향도 읽을 수 있으나 해당 값을 안전하게 직렬화할 수 없어 정확한 원인으로 내보내기를 거부한다. 임의 XML 확장 요소를 보존한다는 뜻은 아니다.

고정 원본 엔진의 편집 전 preflight는 `unsafe`(header.xml·section0.xml `partChanged`)였고, 수정 엔진에서는 같은 원본으로 `safe`(findings 0)다. 이 결과에는 comparator 수정이나 무시 규칙이 없다. 결과는 `target/stage2-implementation/preservation1/result.json`, ID 생애주기와 음성 결과는 `target/stage2-implementation/identity2/result.json`에 있다. 기존 후보 테스트는 실제 삽입 성공·변경 전후·삽입 횟수·반복 편집·재열기·무관한 문단/컨트롤을 각각 확인하며, 음성 테스트는 XML 형태와 변이값·실제 export 단계의 거부 원인을 구분한다. 생성 문서가 필요한 테스트는 기존 `tests/fixtures/rhwp/generate.mjs`를 호출한다.

제품 빌드는 고정 submodule commit `1a76570e833917d15817415a53c09ad61ab3203f`에 추적 패치 `patches/rhwp/hwpx-textdir-ltr.patch`를 적용한다. `scripts/rhwp-patches.py`가 빌드 소스를 검증하고 `scripts/build-rhwp-wasm.py`가 보호된 offline 빌드 후 schema 3 신원으로 산출물을 게시한다. 현재 Release WASM SHA-256은 `bb3bc05865a3f1c24630b9850653e4e38be748b4c5000bd2dd9489b3bbe09324`, generation은 `e09de18d79c53f43ebaeab6070063b0b3280f537be5d3dd774780d29c1fdc4cd`다. 서브모듈 gitlink는 변경하지 않았다.

실제 앱 첫 검증에서는 편집 전 preflight가 safe였으나 편집 뒤 `Preview/PrvImage.png`의 `previewStale`로 저장이 거부됐다. 원본 샘플은 빈 문단 하나, `PrvText.txt`는 정확히 CRLF 하나다. 이미지 4502바이트는 CRC·zlib 체크섬이 맞고, 724×1024 RGB8 모든 행이 filter 0과 흰색 픽셀로만 구성된다. `preview.rs`는 이 **검토한 전체 바이트열** SHA-256 `ca5d23cd1aad2853672cdb0d116137a0bdc2ff62148da9886c264305d0025f3d`에 한해서만 기존 엔진 상수와 같은 문서 독립 빈 그림으로 인정한다. 임의 단색 PNG, 내용 있는 미리보기, 한 바이트 바뀐 것은 여전히 차단한다. 원본의 빈 미리보기와 패키지 항목은 게시 파일에서도 바이트 그대로다.

최종 네이티브 실행(`target/stage2-implementation/native-run3/result.json`, 동일 앱 바이너리 SHA-256 `48ab8383e5c0664bf07dd999be56cea16ea95270294dc2162446a442c95cd48a`)은 Xvfb/X11·WebKitGTK·IBus Hangul 실제 키 입력이다. 원본 preflight safe → 한글 조합·확정으로 첫 문단 `한글` → 실제 Tauri 저장 state=saved/synced=true/revision=2/dirty=false → 탭 닫기·게시 파일 재열기 본문 `한글`을 확인했다. 게시 SHA-256 `b26ae2808144a9aecb919061a494e3625f8f3991a37c28c6184a19a3d1f6fe92`, ZIP CRC·part set·문단 ID·header 및 편집하지 않은 XML·바이너리·빈 미리보기 바이트·본문 외 구조와 실제 WASM 모델/컨트롤/쪽이 검증을 통과했다. 중복 ID 음성 문서는 앱에서 EngineFailure로 저장 거절·원본 해시 불변이며 같은 제품 WASM 직접 검사에서 열린 뒤 `ambiguous duplicate HWPX paragraph id`로 export 거절됨을 확인했다. 네이티브 프로세스 정리 후 생존자는 0이다.

이 샘플에는 표나 그림 개체가 없다. 해당 개체가 있는 임의 외부 문서의 안전 저장은 검증하지 않았다. upstream strict Clippy와 formatter는 수정하지 않은 암호화 코드 경고 및 기존 서식 차이로 실패했고, 이를 통과로 기록하지 않는다. geul 저장 회귀 102건은 통과, 13건은 기존 ignored다. T007/T008/T010 상태와 T009 체크박스는 바꾸지 않는다.

## 반복 문단 ID 규칙 교정 (2026-11-02 후속)

위 Stage 2 패치는 원본에서 같은 `hp:p@id`가 둘 이상이면 내보내기를 거부했다. 한컴 문서는 대부분의 문단에 `id="0"`을 반복하므로, 이 규칙 때문에 고정 `external/rhwp`의 HWPX 734개 중 430개가 보존 검사 전에 엔진 오류로 끝났다(상류 rhwp 왕복 시험 두 개도 같은 원인으로 실패). 두 번째 추적 패치 `patches/rhwp/hwpx-duplicate-paragraph-ids.patch`가 원본의 ID별 개수를 기록하고, 반복 값은 서로 다른 식별 셀에 원본 개수 이하로만 쓰게 한다. 새 문단·복사의 ID 발급, 누락·무효 ID 거부는 그대로다. 같은 패치는 Stage 2 패치가 새 필드를 넣으며 갱신하지 않은 rhwp 단위 시험 구조체 초기화도 고친다(시험 코드만).

그래서 실제 앱 하네스 `scripts/tests/native-external-hwpx-save.py`와 `scripts/tests/hwpx-identity-roundtrip.py`의 음성 사례를 바꿨다. "첫 문단 ID를 복사한 문단을 덧붙인 문서"는 한컴이 실제로 만드는 형태이므로 이제 ID가 정확히 보존되는지 확인하고, 거부 경계는 ID 누락(앱 EngineFailure, 엔진 원인 `HWPX paragraph id missing or invalid`, 입력 불변)으로 검사한다. 원본 개수를 넘는 반복이나 같은 셀 공유는 공개 편집 API로 만들 수 없어 패치의 Rust 단위 시험(`serializer::hwpx::context::tests`)이 직접 검사한다. 하네스는 이제 문서 종류와 무관하게 모든 문단 ID 순서, 편집 문단의 접두 텍스트, 알려진 빈 미리보기(엔진 68바이트 상수 또는 감사한 4502바이트)만 허용하며, 외부 수정 `FileConflict`와 선택적 `--preview-negative` 사례를 추가했다. `종이기준.hwpx`는 새 엔진과 이 하네스로 다시 PASS했다. 결과와 남은 범위는 [저장 보존 문서의 해당 절](save-preservation.md#반복된-hwpx-문단-id-보존-2026-11-02-후속)과 [기계 판독 근거](hwpx-duplicate-id-acceptance-2026-11-02.json)에 있다.

## 붙여넣기 ID·검증기·spine 후속 (2026-11-02)

붙여넣은 문단이 HWP5 개체 ID 할당기로 HWPX ID를 받아 지운 ID를 다시 쓰던 문제(병합 되돌리기 뒤 내보내기 거부까지 재현)는 `patches/rhwp/hwpx-clipboard-paragraph-ids.patch`로, `content.hpf` spine `linear`의 생략·`no`가 `yes`로 바뀌던 문제는 `patches/rhwp/hwpx-spine-linear.patch`로 고쳤다. 실제 앱 하네스의 XML 비교는 공백·tail·주석을 버리던 거짓 음성을 고쳐 `scripts/tests/hwpx_xml_oracle.py`를 쓴다. 이 문서의 `종이기준.hwpx` 수용은 새 엔진·새 검증기로 다시 PASS했다. 상세는 [저장 보존 문서](save-preservation.md#hwpx-문단-id-할당독립-xml-검증spine-linear-안정화-2026-11-02-후속).


## P2/P3/P4 최종 후속 (2026-11-02)

독립 XML 오라클의 루트 밖 comment/PI 및 formatting run 소유권 거짓 음성 두 경계와 Expat의 리터럴 CR/CRLF 정규화 경계를 닫았다. 원본 OPF spine 판독은 XML 문자 참조를 의미값으로 정규화하고 namespace·구조 scope 및 malformed XML/속성을 검증하며, 해석할 수 없는 기존 원본은 fail-closed다. P4는 기존 manifest ID/href 순서와 증명 가능한 JPEG `image/jpg` 표기를 동일 embedded item에 한해 보존하고, 실제 JPEG signature를 확인한다. 최종 제품 generation `4fc10a9db30f457efe64c4784b56da5717d98c72fe72ffbf3bcd573d26b62731`, WASM SHA-256 `8ff713c2c6ff97d299cb614822405c6539358fbea7576978ab05a04b56ebd13b`다. 동일 734개 코퍼스에서 safe 98 유지, 새 safe 0, manifest 순서 차이 176 제거, JPEG 선언 223개/67문서 보존을 확인했다. 전체 수용·거부 경계와 한계는 [최종 P2/P3/C/P4 기록](save-preservation.md#최종-native-재검증과-manifest-순서-보존-2026-11-02-p2p3cp4) 및 [기계 판독 근거의 `oracleSpineManifestFollowup`](hwpx-duplicate-id-acceptance-2026-11-02.json)에 있다.
