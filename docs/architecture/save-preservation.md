# T009 원본 형식 저장과 보존 검사 (2026-10-19)

상태: **이 환경(Linux)에서 구현·검증. T009 체크 안 함** — 선행 T007·T008이 플랫폼 기준으로 미체크이고, 원본 교체는 Linux에서만
검증했다(아래 "판정"). 기준 `ee402c3`(master, 작업 트리 깨끗, submodule rhwp `1a76570` v0.8.7·wordcraft `fc41918` v0.7.0, 바꾸지 않음).

구현 안정화(A~I)는 `93e6acf` 위에서, 3차 안정화(A~F: 내구성 미확인 뒤 다시 불러오기 보호, 게시 무결성, 미리보기 PNG 엄격 검증,
본문 구역 이름, 임시 파일 정리 소유, FileHeader 전체)는 `708a5e8` 위에서, 4차 안정화(A: 원본까지의 모든 상위 디렉터리 신뢰·확인한
디렉터리 핸들 기준 게시, B: 같은 바이트의 압축 BinData도 끝까지 풀기·정할 수 없는 BIN_DATA 선언 unknown, C: 남는 미리보기는 내용과
무관함이 증명된 엔진 상수만)는 `0a00938` 위에서 했다. 그 결과 **편집한 HWP 저장은 고정 rhwp에서 사실상 막힌다**(미리보기 낡음), 다른
사용자가 쓸 수 있는 원본·디렉터리·상위 디렉터리도 저장하지 않는다(아래 "게시 무결성").

> **2026-11-05 Stage 5–7 재검증:** T009의 fail-closed 비교와 원본 보호를 유지했다. HWP ID_MAPPINGS 짧은 입력 panic을 재현·수정했고, 실제 서비스에서 malformed DocInfo/참조 거부 및 원본·dirty/revision·ticket cleanup을 확인했다. 실제 WASM metric 연속 편집·저장 4회차 게시, 수식 실제 저장·재개방은 6게시·2안전 거부다. 제품 RHWP mutation은 D2 25 PASS/2 INCONCLUSIVE(E→U→F 미관측), D4 6 PASS/2 FAIL로 NO-GO이며, DOCX 추적 책갈피 표식 불일치는 수정 뒤 native10개·단계별 저장10개·재개방을 통과했다. 자세한 실행 identity와 외부 Word/Hancom NOT RUN은 [통합 수용 보고서](stage567-acceptance-2026-11-05.md)에 있다.

## 목표와 범위

- FR-006: 지원 가능한 문서는 원본 형식으로 저장·재열기, 손실 우려·지원하지 않는 개체·쓰기 불가 문서는 저장을 막고 원본을 보호한다.
- 형식 변환(HWP↔DOCX)·다른 이름으로 저장·자동 저장·백업은 하지 않는다(FR-015, T009 밖).
- **T009/T014 경계**: T009는 "안전하게 저장할 수 있다는 근거가 있을 때만, 원본을 직접 덮어쓰지 않고(같은 디렉터리 임시 파일 →
  검증 → 원자적 교체) 저장하고, 그 밖은 거부해 원본을 그대로 둔다"까지다. 남은 임시 파일 복구, 정전·중단 뒤 내구성 시험,
  Windows·macOS 교체 방식, 확장 속성·ACL을 옮겨 보존하기(지금은 원본에 있으면 저장을 막는다), 저장 실패 뒤 복구 사본 관리는
  T014(충돌 감지·안전한 임시 파일·복구)다.

## 조사 결과(근거)

| 대상 | 확인한 것 | 결론 |
|------|-----------|------|
| rhwp `exportHwp(x)WithReport` (`src/wasm_api.rs`, `src/serializer/content_loss.rs`) | 손실 보고 DTO `{schemaVersion:1, outputFormat, count, losses[{code, subject, path, reason, resourceId?}]}`. 직렬화가 **스스로 안 손실만** 적는다(코드 3종: `binaryContentEmptied`·`controlOmitted`·`metadataReduced`). | 빈 보고서는 보존 증거가 아니다. 엄격히 검사하되(모양이 다르면 unknown, 손실이 있으면 unsafe) 보존은 따로 판단한다. |
| rhwp 편집 없는 왕복(업스트림 `samples/`, 로컬 탐색만 — 자동 시험 입력 아님) | HWP 60개: 바이트는 모두 다르지만(CFB 섹터·압축) 레코드 수준 비교로 54개 같음, `PrvText` 재생성 2, `ViewText` 빠짐 1, 보호·배포용 2, 깨짐 1. **손실 보고는 60개 모두 0건.** HWPX 60개: rhwp가 만든 3개만 같고 57개는 `Contents/section0.xml`(실제 요소 `presentation`·`gradation`·`color`·`label` 등이 빠지거나 바뀜)·`header.xml`·`content.hpf`가 바뀌거나 부분이 생기고 사라짐. 역시 손실 보고 0건. | HWP는 레코드 수준 비교로 문서마다 판단할 수 있다. HWPX는 rhwp가 직접 만들지 않은 문서는 거의 모두 막힌다(정직한 결과). |
| rhwp 잘린 HWPX | `section0.xml`을 2/3에서 자른 HWPX를 rhwp가 **오류 없이 거의 빈 문서**(본문 2글자)로 연다. | 열기 성공은 근거가 아니다. 원본 XML을 끝까지 읽을 수 없으면 unknown. |
| WordCraft `io::open_bytes`/`save_bytes` (`crates/docx/src/lib.rs`, `xml.rs`) | 판독기는 "모르는 표시를 건너뛰고", 다시 내보내는 XML은 모르는 이름공간의 요소·속성을 버린다. 끊긴 본문 XML도 끊긴 곳까지 읽어 연다(T008 J). WordCraft가 쓴 문서는 왕복해도 부분마다 같다. Word식 패키지(`customXml`·`w14`·`w:rsid`)는 그 부분·속성이 사라지고 부분 6개가 생긴다. | DOCX도 문서마다 편집 없는 왕복으로 판단한다. |
| 편집이 바꾸는 부분(실측) | HWP: `BodyText/Section*`과 `DocInfo`의 문서 속성 레코드(tag 16) 캐럿 12바이트만. HWPX: `Contents/section<N>.xml`만. DOCX: `word/document.xml`과 `docProps/app.xml`의 통계(`Words`·`Paragraphs`). | 저장 검사에서 이 부분만 바뀔 수 있게 하고, 본문 내용은 엔진 다시 열기로 확인한다. |
| rhwp 문서 속성 레코드 (`parser/doc_info.rs` `parse_document_properties`, `serializer/doc_info.rs`) | 26바이트: 구역 수·시작 번호 6개(u16 ×7) 뒤 캐럿 목록·문단·글자 위치(u32 ×3). | 정확히 26바이트일 때만 뒤 12바이트를 면제한다(A). |
| rhwp 미리보기 (`serializer/cfb_writer.rs` `supplement_preview`, `serializer/hwpx/mod.rs`) | HWP `PrvText`: 원본에 글자가 있으면 **그대로** 두고, 비었으면 본문 문단으로 새로 만든다. `PrvImage`·HWPX `Preview/*`는 원본 그대로. WASM API에 미리보기를 지우거나 다시 만드는 함수가 없다. 픽스처 HWP(rhwp가 만든 문서)의 `PrvText`도 본문 글자다. | 편집 전 글자를 남기는 저장은 막는다(F). 검증한 재생성 수단이 없다. |
| rhwp BinData 저장 형태 (`serializer/cfb_writer.rs` `find_bin_data_info_with_compress`, `parser/mod.rs` `bin_data_stream_is_compressed`) | 압축 여부는 DocInfo BIN_DATA 속성(0 문서 플래그·1 압축·2 비압축)으로 정한다. 한컴 원본의 deflate 스트림 뒤에는 푼 내용의 CRC-32·길이 8바이트 꼬리가 있다(표본 175개 모두, 실측). rhwp는 꼬리 없이 다시 압축한다. | 형태가 양쪽에서 정해질 때만 풀어서 비교한다(D). |

## 저장 절차

```
[프런트엔드]                                  [백엔드 SessionRegistry + services::save]
저장 단추 → 확정을 기다리는 편집·조합·불확실한
          모델이 있으면 시작 안 함(SaveNotReady)
사전 검사(원본에 대해 한 번)
  rhwp: document_original → 새 WASM 문서로 열어
        편집 없이 같은 형식으로 내보내기(+손실 보고)
        → document_preflight ─────────────────→ 원본 다시 읽기(같은 inode·지문·해시)
  DOCX: docx_preflight ──────────────────────→ 새 WordCraft 모델로 편집 없이 왕복
                                              → 원본과 부분마다 비교 → safe/unsafe/unknown 기억
safe·플랫폼 지원일 때만:
  rhwp: 확정한 판을 내보내기(+손실 보고) → 다시 열어
        형식·쪽 수·본문·컨트롤 비교 → document_save ─→ begin_save(ready·같은 시도·같은 판·저장 중 아님)
  DOCX: docx_save ──────────────────────────→ 모델 잠금 안에서 그 판을 내보내고 다시 읽어 모델과 같은지
                                              원본 다시 읽기(해시) → 사전 검사가 이 원본에 safe인지
                                              출력 검사: 손실 보고·형식 판별·패키지 무결성·편집 부분 밖이 원본과 같음
                                              뿌리부터 원본 디렉터리까지 한 이름씩(핸들 기준·링크 따라가지 않음) 열며
                                              모든 상위가 다른 사용자가 다음 항목을 바꿀 수 없는지 확인(아니면 거부)
                                              원본(그 디렉터리 핸들 기준): 하드 링크·읽기 전용·그룹/그 밖 쓰기·접근 ACL이면 거부,
                                              확장 속성·플래그·권한 읽기. 디렉터리: 다른 사용자가 이름을 바꿀 수 있으면 거부
                                              확인한 디렉터리 핸들 안에 임시 파일(O_EXCL, 0600, 핸들 하나) 쓰기·fsync·원본 권한
                                              임시 파일의 메타데이터가 원본과 같은지(다르면 거부)·같은 핸들로 되읽기
                                              → 검증한 상태(inode·크기·시각·권한) 기록
                                              원본 해시 다시 확인
                                              기록 잠금 안: 세션·시도·ready·지문(ctime·권한·소유·링크 수 포함) 다시 확인
                                              → 임시 파일이 검증한 상태 그대로이고 그 이름이 그 inode이며 원본 경로의 부모가
                                                지금도 확인한 디렉터리인지(아니면 게시 안 함)
                                              → 디렉터리 핸들 안의 renameat → 원본 경로가 그 inode인지·이 inode의 fstat으로
                                                새 지문 → 그 디렉터리 핸들 fsync
                                              깨끗한 판 = 저장한 판(그 사이 편집은 dirty로 남음), 새 inode·지문·해시
                                              (fsync 실패·이름이 그 inode가 아님: 새 파일 기록만 바꾸고 dirty 유지)
```

교체 전 단계가 실패하면 원본은 그대로이고 이 저장의 임시 파일을 확인한 디렉터리 핸들 안에서 지운다(이름이 아직 그 inode일 때만 —
다른 것으로 바뀐 이름은 남의 것이라 두고 간다; 경로가 그 사이 다른 디렉터리를 가리켜도 다른 디렉터리의 파일을 지우지 않는다).
임시 파일을 만든 직후부터 지우기를 맡는 값이 있다(그 사이 실패할 단계가 없다).

## 판정 규칙

- `safe`: 근거가 하나도 없음. `unknown`(판단 불가): 원본을 끝까지 읽지 못함(`originalMalformed`)·손실 보고 모양 오류
  (`lossReportInvalid`)·한도 초과·보호/배포용 HWP(`unsupported`)·이 원본의 사전 검사 없음(`preflightMissing`). 그 밖의 근거는 `unsafe`.
  **unknown도 저장하지 않는다.**
- HWP: 스트림 이름 집합, `FileHeader`(정확히 256바이트 전체 — 더 긴 원본은 unknown, 더 긴 출력은 unsafe; 판 5, 속성은 압축·스크립트만
  받고 XML 서식·문서 이력·전자 서명·공개키 암호·인증서·배포 준비·모르는 비트는 unknown, 3차 F), 레코드 스트림(압축을 풀어 태그·수준·내용)이 같음. 레코드 스트림은 바이트가 같아도
  양쪽을 끝까지 읽는다(원본이 깨졌으면 unknown, 출력이 깨졌으면 unsafe — 같은 바이트의 깨진 레코드는 근거가 아니다, E). deflate 뒤에
  남는 바이트는 없거나 한컴 8바이트 꼬리(CRC-32·길이가 푼 내용과 맞음)여야 한다. BinData는 DocInfo BIN_DATA 선언(이름은 CFB처럼 대소문자
  무시)으로 양쪽 저장 형태가 같게 정해질 때 압축이면 **바이트가 같아도 원본을 끝 블록까지** 풀어 확인하고(같은 바이트의 깨진·잘린·꼬리가
  틀린 스트림은 근거가 아니다 — 원본 unknown, 4차 B) 출력도 풀려 같은 내용이어야 하며, 비압축이면 바이트가 같아야 한다. 풀어낸 크기
  상한(512 MiB)을 넘으면 어느 쪽이든 `limitExceeded`(unknown). 형태를 정할 수 없는 선언(예약 압축 값 3, 같은 이름에 형태가 다른 중복
  선언)은 그 스트림이 `unsupported`, 해석할 수 없는 BIN_DATA 레코드(아이디·확장자가 레코드 끝을 넘음, UTF-16 오류, 확장자 없는 내장)는
  `originalMalformed{DocInfo}`, 예약 형식(3–15)·ASCII가 아닌 확장자는 `unsupported{DocInfo}`, ASCII가 아닌 BinData 스트림 이름은
  `unsupported`(모두 unknown, 4차 B). 그 밖의 스트림(선언이 없는 BinData — 엔진이 그대로 옮긴다 —, 미리보기, 스크립트, 요약 정보)은
  **바이트가 같아야** 한다(한쪽만 풀리는 쌍을 같다고 보지 않음, D). 편집 저장은 본문이 레코드로 끝까지 읽히는지만
  보고(내용은 다시 열기), `DocInfo`는 정확히 26바이트인 tag 16의 캐럿 12바이트만 다를 수 있다(길이가 다르면 면제 없음, A). 본문
  면제는 고정 rhwp가 읽고 쓰는 구역 이름 `BodyText/Section<N>`(N은 0이거나 0으로 시작하지 않는 10진수)만 받는다. 그 밖의 `BodyText`
  아래 스트림(`Section01`·`SectionX`·하위 저장소 등)도 레코드로 끝까지 읽지만 바뀌면 `recordsChanged`다(3차 D). HWPX 본문도
  `Contents/section<N>.xml` 같은 규칙.
- 미리보기(F, 4차 C): 본문을 바꾼 저장에서 원본 그대로 남는 미리보기는 그 **바이트 전체가 문서 내용과 무관함**을 증명해야 한다. 증명은
  내용과 무관함이 알려진 바이트와 정확히 같은 것뿐이다: 글 미리보기(HWP `PrvText` UTF-16, HWPX `Preview/PrvText.txt` UTF-8)는 빈 값이거나
  줄바꿈 하나 `\r\n`(고정 rhwp `static_assets.rs` `PRV_TEXT`, HWP는 그 UTF-16 — blank2010 자산과 같은 바이트), 그림 미리보기(`PrvImage`,
  `Preview/PrvImage.png`)는 고정 rhwp가 HWPX에 넣는 빈 미리보기(`PRV_IMAGE_PNG`, 68바이트 1×1 투명, IDAT CRC·Adler-32가 틀림 — 실측;
  시험이 고정 소스의 배열과 대조)와 바이트가 같을 때만. 3차의 "엄격한 구조 + 한 색 PNG", "공백·탭·CR·LF뿐인 글"은 더는 증명으로 쓰지
  않는다: 그 검사를 통과하는 미리보기에 투명 픽셀의 RGB, `pHYs` 값, 줄 필터 선택, deflate 빈 저장 블록의 채움 비트(길이 제한 없음),
  공백·탭 무늬로 임의의 8바이트를 담고 다시 꺼낼 수 있었다(합성 픽스처, 시험 `c4_`). 이 판정은 숨긴 정보를 찾는 검사기가 아니라, 무관함을
  증명할 수 없으면 받지 않는 규칙이다. 그 밖의 `Preview/*`와 DOCX 썸네일(`docProps/thumbnail.*`, 패키지 관계의 thumbnail 대상)도 증명할 수
  없어 막는다. 근거 `previewStale`(unsafe; 화면 문구는 "편집 전 내용을 담고 있지 않음을 확인할 수 없음"). 미리보기가 바뀐 출력은 바뀐
  스트림·부분으로 unsafe다(재생성 내용을 검증하지 않음).
- 모양 참조 무결성(2026-10-22, T010 Phase 0 Stage B 결함 수정): 편집 저장의 출력 본문은 정의된 모양만 가리켜야 한다. 고정 rhwp는 없는
  모양을 기본 모양으로, 숫자가 아닌 HWPX 참조를 0으로 말없이 바꿔 다시 열기 비교(쪽·글·컨트롤)로는 드러나지 않으므로 판정이 따로 본다.
  - HWPX(`package::validate_hwpx_references`): 출력 `Contents/section<N>.xml`의 **모든 요소**(글 run·구역 정의 run·표 셀 문단·양식
    `formCharPr` 등)의 `charPrIDRef`·`paraPrIDRef`가 10진 숫자(부호·공백·빈 값 없음, u32)이고 출력 `Contents/header.xml`의 `charPr`·`paraPr`
    `id`(이름공간마다 따로, 65535 이하 — 넘는 정의는 엔진이 버림)에 있어야 한다. 정의는 **고정 rhwp가 실제로 등록하는 것만** 센다(2026-10-22
    2차 고침): 엔진 header 파서는 `charPr`·`paraPr`를 `Event::Start`(내용이 있는 요소, `<a></a>` 포함)에서만 등록하고 자기 닫힘(`<a/>`)은 건너뛴다
    (실측: 자기 닫힘 `charPr` 13을 가리키면 엔진은 id 13을 보고하며 기본 모양으로 그리고 내보내기는 "미등록 ID 참조"로 실패, 자기 닫힘 `paraPr`은
    내보내기도 통과해 정의 없는 참조를 씀). 그래서 판정은 `xml::element_starts`(자기 닫힘·부모를 구별하는 요소 목록)로 `hh` 이름공간이고 부모가
    `hh:charProperties`·`hh:paraProperties`인 내용 있는 요소만 정의로 보고, 자기 닫힘 정의를 가리키면 `referenceInvalid`, 쓰지 않는 자기 닫힘
    요소만으로는 막지 않는다. 엔진이 등록하지만 정의로 확인할 수 없는 내용 있는 `charPr`/`paraPr`(다른 이름공간·목록 밖 — 엔진은 같은 배열에 넣어
    정의를 덮을 수 있다)는 `unsupported`. 실제 저장 경로에서는 자기 닫힘 정의가 있는 원본이 엔진의 편집 없는 출력에서 그 정의를 잃어 사전 검사가
    이미 `partChanged{header}`로 막는다(실측, `tests/poc/t010-phase0/selfclosing.py`) — 이 판정은 그와 별개로 엔진과 같은 해석을 한다. 아니면 `referenceInvalid{section}`(unsafe). header가 없거나
    정의 id를 정할 수 없으면(id 없음·숫자 아님·중복 — 엔진이 등장 순서·0으로 넣거나 덮어씀) `unsupported{Contents/header.xml}`(unknown).
    읽을 수 없는 header는 기존 `outputMalformed`. id가 이어질 필요는 없다(빈 번호 뒤의 정의도 올바르다).
  - HWP(`hwp::compare_saved` → `references`): 모든 구역 스트림(중첩 문단도 같은 스트림)의 `PARA_HEADER` 문단 모양 ID(오프셋 8, u16)와
    `PARA_CHAR_SHAPE` 글자 모양 ID(쌍의 둘째 u32)가 출력 DocInfo의 `PARA_SHAPE`·`CHAR_SHAPE` 레코드 수보다 작아야 한다(HWP 5 모양 ID는
    DocInfo 등장 번호). 모양 ID 자리가 없는 문단 머리, 비었거나 8의 배수가 아닌 `PARA_CHAR_SHAPE`도 `referenceInvalid{BodyText/Section<N>}`.
    미리보기 규칙과 따로 나온다(`previewStale`에 기대지 않음, 미리보기 규칙은 그대로).
  - 사전 검사(편집 없는 왕복)에는 더하지 않았다(그 출력은 원본과 같아야 한다). 업스트림 예제 1076개의 편집 없는 rhwp 출력에서 이 검사로 새로
    막힌 문서는 없다(실측, `referenceInvalid` 0건). 범위 밖: 다른 참조 이름공간(`borderFillIDRef`·`styleIDRef`·`tabPrIDRef` 등), header 안의
    참조(header는 원본과 같아야 하므로 원본의 것), 모양 정의 내용 자체의 올바름.
- DOCX 메모 부분(2026-11-05, T013 — DOCX 편집 저장만): 본문(`word/document.xml`)·통계 외에 다음 두 경우만 더 받는다. ① **새로 더함**
  (`package::comment_parts_added`): 원본에 메모 부분(`word/comments.xml`·`word/commentsExtended.xml`, 대소문자 무시)이 하나도 없고 출력에 새로 생긴 부분이 그
  메모 부분뿐이며, `[Content_Types].xml`의 자식(순서 무관) = 원본 + 새 부분마다 정해진 내용 형식의 `Override` 하나, `word/_rels/document.xml.rels`의 관계(`Id`
  제외, 순서 무관) = 원본 + 새 부분마다 정해진 `Type`·`Target`의 내부 관계 하나, 두 목록의 뿌리는 같음. 본문에서 다음 두 URI로 해석되는
  속성만 `word/_rels/document.xml.rels`에 대조한다: Transitional `http://schemas.openxmlformats.org/officeDocument/2006/relationships`와 Strict
  `http://purl.oclc.org/ooxml/officeDocument/relationships`. 속성 식별에는 해석된 URI와 지역 이름을 모두 쓴다(`id`·`embed`·`link` 등).
  접두어 표기는 무관하나, `r` 접두어의 임의 URI나 이름공간 없는 `id`는 관계 참조가 아니다. ID가 바뀌어도 참조의 URI·지역 이름이 같고,
  `Type`·`Target`·`TargetMode` 등 ID 외 모든 관계 속성이 같으면 받는다. Strict↔Transitional 변환은 거부한다. pinned WordCraft가 두 namespace를
  읽고 다시 쓸 수 있다는 사실만으로 임의 패키지 변환의 의미 동등성을 증명할 수 없기 때문이다. 이 두 관계 목록은
  각각 한 번 읽어 ID별 의미 속성 비교와 목록 비교에 재사용한다. 헤더·푸터 XML과 각자의 관계 파일은 예외가 아니며 일반 부분 비교가 지킨다.
  ② **끝에 덧붙임**(`package::comment_parts_appended`):
  새 부분이 없고, 바뀐 메모 부분마다 정규화한 사건 열이 원본 사건(뿌리 끝 전까지) + 완결된 메모 요소(`w:comment` / `w15:commentEx`) 하나 이상 + 뿌리 끝.
  원본 메모의 내용·순서는 그대로여야 하고 목록·관계는 바뀌면 안 된다. 메모 글·작성자·날짜·완료 표시는 엔진 모델의 일부라 다시 읽기 비교가 확인한다. 그
  밖(메모를 지우거나 고친 출력, 다른 새 부분, 기존 관계 대상 변경 등)은 지금처럼 `partAdded`/`partChanged`/`partMissing`. Strict 관계 회귀
  `strict_reference_rebinding_*`은 수정 전 XML 비교가 resolver를 호출하지 않고, 패키지 비교와 `check_saved(..., reopen_equal=true)`도 잘못 허용함을
  재현했다. 수정 후 본문 관계 재연결과 Strict→foreign/unqualified 치환은 거부되고, Strict의 유효한 동일 namespace 참조 및 일관된 ID 변경은 통과한다.
  합성 Strict/comment 출력은 기존 T013 comment-part Transitional 계약을 따르며 완전한 ISO Strict 출력 적합성 주장은 아니다. 신규 관계 예외는
  본문 관계 부분에만 적용한다. 비교기는 본문 관계만 두 번 파싱하지 않고 한 번 파싱한 목록을 재사용하며, 본문 XML은 엄격한 정규화 커서로
  `r:*` 참조만 흘려보낸다(전체 canonical 사건·참조 목록을 만들지 않음). `.rels` 한 부분의 정규화 보유 payload는 4 MiB로 제한하고 초과 시
  자원 실패로 저장을 거부한다. 이는 프로세스 heap/RSS 한도가 아니다. 실제 benchmark proxy는 [명령 문서의 후속 기록](command-registry.md#t012t013-후속-안전-검증-2026-11-05)을 참조한다. 음성 변이: Rust 시험
  `docx_메모_더함_밖의_목록_관계_변경은_계속_막는다`(10가지), `docx_기존_메모_끝에_덧붙인_메모만_받는다`(6가지). 실제 저장 절차 두 회차:
  `docx_comment_published_reopen_rounds`는 처음 게시한 같은 파일을 다시 불러와 둘째 메모를 저장한다. 풍부한 실제 WordCraft 출력(머리말·꼬리말·그림)은
  관계 부분 비교를 통과했으나 pinned 엔진의 모델 재열기가 불일치해 실제 게시가 `ReopenMismatch`로 거부된다(원본 SHA 유지). 이 엔진 한계는 관계
  비교의 성공과 별개다. 합성 관계 공격은 실제 저장 서비스 경계에 출력을 주입하고 `reopen_equal=true`를 강제한 검사로 거부·원본 SHA·dirty·임시 파일을
  확인했다. Strict 주입 시험에서도 수정 전 실제 서비스가 게시하고 원본 SHA를 바꿨으나 수정 후 게시 전에 거부한다. 두 시험 모두 강제 재열기를 쓴
  합성 증거 경계이며 WordCraft가 공격 출력물을 만들거나 받아들인다는 증거가 아니다. 별도 실제 WordCraft Strict source 시험은 hyperlink를 읽고
  Transitional XML로 내보내며 그 모델 재열기는 일치했지만, 실제 preflight와 저장은 namespace/부분 변경 때문에 거부하고 원본을 보존했다.
- 장평·자간 덧붙임(2026-11-05, T012 — HWPX 편집 저장만, 위 "글자 서식 덧붙임" 규칙의 확장): 덧붙인 `hh:charPr`가 원본 정의 하나와 비교할 때
  내용 없는 `hh:ratio`·`hh:spacing`의 **값(속성)만** 다를 수 있다. 요소의 자리·개수는 그대로 비교한다(빠지거나 둘이거나 자리가 바뀌면 다름). 덧붙인 정의의 값은
  고정 rhwp 직렬화기 모양(`write_lang_attrs`)이어야 한다: 이름공간 없는 7개 언어 속성(`hangul latin hanja japanese other symbol user`) 정확히 하나씩, 앞 0·`+`·
  `-0` 없는 10진 정수, 장평 50–200·자간 −50–50(`package::serializer_metric_child`). 원본 정의의 값은 소급해 거르지 않는다. 그 밖의 규칙(id·itemCnt·쓰임·
  나머지 내용 같음)은 그대로다. 근거: 실제 엔진 출력 → 실제 `service::save`(T012 `hangul_tools_save.py`) — 본문·굵은 글자·표 셀의 장평·자간, 두 번째 회차
  게시, 같은 범위 연속 변경은 쓰이지 않는 중간 정의 때문에 계속 거부, HWP는 `recordsChanged{DocInfo}`로 거부. 음성 변이 16가지(Rust 시험
  `hwpx_header의_장평_자간_덧붙임_밖_변경은_계속_partchanged다`).
- 글자 서식 덧붙임(2026-10-26, T010 Phase 3B — HWPX 편집 저장만): `Contents/header.xml`은 원본과 같거나, 차이가 **글자 서식이 덧붙인
  글자 모양 정의뿐**일 때만 받는다(`package::hwpx_char_shapes_appended`). 모두 성립해야 한다: 두 header가 끝까지 읽히고 `hh:charProperties`가
  정확히 하나, 그 앞뒤 사건이 같음 · 목록 시작은 `itemCnt`만 다르고 원본 `itemCnt` = 원본 정의 수 n이며 원본 id가 정확히 0..n · 출력 목록 =
  원본 목록 내용 그대로 + 끝에 `hh:charPr` k개(k ≥ 1, 사이 글·주석 없음), 덧붙인 id = n..n+k(65535 이하), 출력 `itemCnt` = n + k · 덧붙인 정의
  각각이 `id`와 서식 자식(내용 없는 `hh:bold`·`hh:italic`, 속성이 `type`·`shape`·`color`뿐인 `hh:underline`, `shape`·`color`뿐인
  `hh:strikeout`, 값은 16자 이하 영숫자·`#`·`_`, 같은 자식 하나씩)을 빼면 원본 정의 하나와 같음 · 덧붙인 정의 각각을 출력 본문의
  `charPrIDRef`가 가리킴. 하나라도 어긋나면 지금처럼 `partChanged{header}`(unsafe)이고, 덧붙인 정의가 엔진이 등록하지 않는 자기 닫힘이면
  위 참조 무결성이 `referenceInvalid`로 막는다. 근거(VERIFIED 실측, 생성 픽스처·고정 rhwp `a91fa6a4…`): 기울임·밑줄·취소선은 엔진이 원래
  모양을 복제해 새 `charPr` 하나를 끝에 붙이고 `itemCnt`만 올린다(나머지 header 바이트 같음), 굵게는 있는 모양을 다시 쓴다. 실제
  `service::save`로 본문 기울임·표 셀 밑줄 출력이 게시되고(원본 교체, 세션 깨끗), 다시 열면 그 범위만 서식이 같다. 섞인 다른 header 변경은
  거부·원본 SHA-256 그대로(Rust 시험 `실제_저장_서비스는_서식_덧붙임_hwpx를…`, 음성 변이 20가지 `hwpx_header의_서식_덧붙임_밖_변경은…`).
  2026-10-26 교정(B·C, 증거 `tests/integration/rhwp/evidence/t010-corrective-validation/`): (B) "쓰임"은 이름공간 없는
  `charPrIDRef`가 `hp`(2011 paragraph) 이름공간의 `run`(부모 `hp:p` — 본문·표 셀·중첩 문단, 내용 없는 run 포함) 또는
  `formCharPr`(부모가 `hp` 요소)에 있을 때만 센다. 고정 rhwp 구역 파서가 글자 모양으로 읽는 자리가 이 둘뿐이고(그 파서는 지역 이름만
  본다 — 판정이 더 좁다), 이전 판은 본문의 아무 요소의 `charPrIDRef`나 셌다(수정 전 재현: `<hp:fake charPrIDRef="3"/>`로 쓰이지
  않는 덧붙임이 받아짐). 다른 요소·다른 이름공간·구역 뿌리·이름공간 붙은 속성·주석·글 안의 문자열·숫자가 아닌 값은 세지 않는다.
  (C1) 덧붙인 정의의 서식 자식은 고정 rhwp 직렬화기(`serializer/hwpx/char_shapes.rs` `write_char_pr`, 표
  `char_shape_tables/{underline,line_shape}.rs`)가 쓰는 모양만: 굵게·기울임은 속성 없음, 밑줄은 `type` ∈ {NONE, BOTTOM, TOP}·
  `shape` ∈ 선 모양 13종·`color` 셋 모두, 취소선은 `shape` ∈ {NONE} ∪ 선 모양 13종·`color` 둘 모두, 색은 `none`·`#RRGGBB`·
  `#AARRGGBB`(대문자 — `color_hex`). 이전 판의 "16자 이하 영숫자" 문자 거르개는 엔진이 기본값으로 바꿔 읽는 값(예: `type="CENTER"`)을
  받았다. 원본 정의는 소급해 거부하지 않는다(내용 없는 서식 자식이면 값과 관계없이 빼고 비교). (C2) 원본 정의를 한 번씩 정규화한
  해시 집합으로 찾는다(같음은 집합이 전체 값으로 판정 — 해시 일치만으로 같다고 보지 않음). 이전 판은 덧붙임마다 원본 전체를 훑었다:
  release 측정 원본 30000·덧붙임 10000에서 13.7초 → 1.1초, 60000·5535(header 16 MB, zip 370 KB)에서 19.3초 → 2.0초, 판정 같음.
  id 상한 경계(마지막 덧붙임 65535 받음, 65536 막음)를 시험했다. 새 크기 상한은 두지 않았다(기존 부분 256 MiB·id 65535가 범위를 정함).
  2026-10-26 강화(증거 `tests/integration/rhwp/evidence/t010-post-corrective-hardening/`): 위 (B)의 "부모가 `hp` 요소인
  `formCharPr`"와 "부모가 `hp:p`인 run"은 엔진이 읽지 않는 자리도 셌다(수정 전 재현: 음성 14경우 중 9경우를 받음 — `hp:p` 바로 아래
  `formCharPr`, `hp:ctrl` 안 양식, 내용 있는 `formCharPr`, 건너뛰는 컨테이너 안 문단의 run 등; 실제 `service::save`가 그 출력을
  게시). 고정 rhwp 구역 파서의 실제 경로로 좁혔다: run은 **읽히는 문단**(구역 뿌리 `hs:sec` 바로 아래 `hp:p`, 또는 `hp:subList` ←
  `hp:tc` ← `hp:tr` ← `hp:tbl` ← `hp:run` ← 읽히는 문단 — 표 셀·중첩 표)의 자식일 때, `formCharPr`는 자기 닫힘(Start는
  `parse_form_object`가 `skip_element`)이고 부모가 내용 있는 `hp:btn`·`checkBtn`·`radioBtn`·`comboBox`·`edit`(문단 루프가 Start에서만
  `parse_form_object`를 부름)이며 그 양식이 읽히는 문단의 `hp:run` 바로 아래일 때(직렬화기 위치; `hp:ctrl` 안은 `parse_ctrl`이
  건너뜀)만 센다. 조상 경로는 `xml::ElementStart.parent_index`로 따라 올라간다. 글상자·머리말·각주 문단의 run은 세지 않는다
  (fail-closed — 엔진이 읽는지 이 판정이 증명하지 않음; 그런 자리의 덧붙임 저장은 거부). 이전 증거의 양성 사례
  `hp:run/hp:ctrl/hp:checkBtn/hp:formCharPr`는 엔진이 읽지 않는 자리였으므로 음성으로 옮겼다(이전 증거는 그대로 둠).
  자원: header를 한 번만 정규화해 같음 비교와 덧붙임 규칙이 함께 쓰고 본문 바이트를 복사하지 않는다 — release 전체
  `check_saved` 원본 60000·덧붙임 5535(header 16.0 MB, zip 370 KB) 3031 → 2339 ms, 판정 같음. 최대 RSS는 그대로 약 516 MiB:
  두 header의 정규화 사건 열을 함께 드는 기존 T009 부분 비교(`compare_part`와 같은 표현)가 지배하며 이 규칙만의 비용이 아니다
  (펼친 header의 약 32배, INFERRED: 부분 상한 256 MiB 근처의 XML 부분은 수 GiB가 될 수 있는 기존 위험). 새 크기 상한은 두지 않았다.
  한계: 쓰이지 않는 덧붙임(예: 기울임을 켰다 끈 뒤 남은 모양)은 받지 않는다(저장 거부, 원본 보존). HWP DocInfo에는 같은 규칙을 두지
  않았다(본문을 바꾼 HWP는 미리보기 규칙이 따로 막는다, Phase 3C). 이 규칙은 저장 판정만이며 rhwp 서식 명령은 여전히 `unsupported`다
  ([command-registry.md](command-registry.md)).
- 손실 보고(G): rhwp 형식(HWP·HWPX)은 보고가 반드시 있어야 한다(없으면 `lossReportInvalid`, unknown). DOCX는 보고를 받지 않는다(들어오면
  `lossReportInvalid`).
- HWPX·DOCX: 항목 이름 집합, XML 부분은 정규화한 사건 열(이름공간 URI·지역 이름·정렬한 속성·문자 데이터 그대로; 접두사·속성 순서·
  XML 선언·이름공간 선언은 무시, DTD 거부), 그 밖은 압축을 푼 바이트. 저장 출력은 DOCX는 내용 형식이 모든 부분을 덮고 관계
  대상이 있으며, HWPX는 압축하지 않은 `mimetype`이 첫 항목이고 `content.hpf` manifest 항목이 있어야 한다.
- 다시 열기(rhwp, 프런트엔드): 다시 연 형식과 컨테이너 서명이 원본 형식, 쪽 수·본문(`getTextFileText`)·컨트롤(`getControls`)이 편집
  모델과 같음. DOCX(백엔드): 다시 읽은 문서 모델이 편집 모델과 같음.
- 원본 교체: Linux만. 하드 링크가 여럿인 파일, 소유자·그룹이 바뀌는 파일은 거부(`SaveUnsupported`). 심볼릭 링크로 연 파일은 대상
  파일을 바꾸고 링크는 남는다. 권한 비트는 원본 그대로.
- 읽기 전용 원본(B): 소유자 쓰기 비트가 없거나 커널이 쓰기를 거부하면(`faccessat(W_OK, AT_EACCESS)`: 변경 불가 플래그·읽기 전용
  마운트 등) 디렉터리에 쓸 수 있어도 바꾸지 않는다(`SaveUnsupported{read-only}`). 쓰기 열기 탐침은 하지 않는다(쓰지 않아도 닫을 때
  `IN_CLOSE_WRITE`가 나가 다른 도구가 바뀐 파일로 볼 수 있다). 읽기 전용 디렉터리는 임시 파일 만들기에서 `SaveFailure{write,
  permission-denied}`.
- 메타데이터(C): 확장 속성 이름·값(POSIX ACL `system.posix_acl_*`, SELinux `security.*`, `user.*`), inode 플래그(`FS_IOC_GETFLAGS`), 권한
  비트를 원본과 다 쓴 임시 파일에서 읽어 같을 때만 교체한다. 다르거나 읽을 수 없으면 `SaveUnsupported{metadata}`(옮기지 않는다). 파일
  시스템이 그 종류를 지원하지 않으면(`ENOTSUP`·`ENOTTY`) 양쪽 다 없는 것으로 본다. 파일 지문은 크기·수정 시각에 상태 변경 시각(ctime)·
  권한·소유자·그룹·링크 수를 더했다: 불러온 뒤나 저장 중의 chmod·chown·링크 추가·확장 속성 변경은 `FileConflict`다. 교체 뒤 지문은
  이 저장이 쓴 inode를 연 핸들의 fstat으로 구한다(`rename`이 ctime을 바꾼다).
- 내구성(I): 교체 전 실패 = 게시 안 됨(원본 그대로, `SaveFailure`). 교체 뒤 디렉터리 `fsync` 실패 = 게시됨·내구성 미확인(`durable:
  false`): 되돌리지 않고(옛 파일은 이미 없다) 세션의 파일 기록은 새 파일로 바꾸되 깨끗한 판은 올리지 않아 dirty로 남는다. 화면은
  "저장하지 않은 편집으로 남겨 둠"이라 하고 "원본이 바뀌지 않았다"고 하지 않는다. 다시 저장하면 새 파일을 원본으로 다시 검사·교체·
  `fsync`한다. 둘 다 성공 = 게시됨·내구성 확인. 교체 뒤 원본 이름이 이 저장의 inode가 아니면(믿는 쪽의 경합) 무엇이 게시됐는지 알 수
  없으므로 역시 내구성 미확인으로 둔다(다음 저장·사전 검사는 이름의 파일이 기록과 달라 `FileConflict`).
- 내구성 미확인 뒤의 보호(3차 A): 다시 불러오기·탭 닫기·창 닫기 모두 SessionRegistry의 dirty를 본다. rhwp 편집 세션의
  `hasUnpreservedChanges`도 이제 백엔드 dirty를 포함한다(DOCX·작업 공간과 같은 기준, 프런트엔드가 따로 판을 만들지 않음): 편집하지 않은
  문서를 저장해 내구성 미확인이 돼도 다시 불러오기는 버리기 확인을 요구하고 모델을 놓지 않는다. 사용자가 버리기를 확인하면 디스크에서 다시
  읽어(그때 백엔드가 깨끗하다고 정함) 진행한다. 내구성을 확인한 다시 저장 뒤에는 확인 없이 다시 불러올 수 있다. 세션 투영은 sequence가
  더 작은 늦은 기록을 버리므로 옛 `dirty: false`가 보호를 풀지 못한다.
- 저장 검사 순서(H, 프런트엔드): 사전 검사 요청마다 소유 번호를 올린다. 결과는 그 번호가 그대로일 때만 기억·표시한다(겹친 검사 중
  늦게 끝난 옛 요청, 저장 성공·다시 불러오기·닫기 전에 시작한 검사는 버림). 수동 검사는 진행(`checking`)과 실패(`failed`)를 보이고,
  저장 중에는 하지 않는다(`SaveInProgress`). 저장 안의 검사는 그 결과를 바로 쓴다.

## 오류 계약(경로·문서 본문·운영체제 문구 없음)

| 코드 | 뜻 |
|------|----|
| `UnsafeSave{preservation}` | 보존 근거 없음(unsafe/unknown + 근거 코드·부분 이름). 원본 그대로 |
| `SaveUnsupported{platform\|hard-link\|ownership\|read-only\|metadata\|shared-file\|shared-directory}` | 이 환경·파일은 안전하게 바꿀 수 없음(읽기 전용 원본, 교체로 잃을 확장 속성·ACL·플래그, 다른 사용자가 쓸 수 있는 원본, 다른 사용자가 항목을 바꿀 수 있는 디렉터리 포함) |
| `SaveFailure{stage: export\|validate\|write\|publish, io?: permission-denied\|storage-full\|read-only\|other}` | 단계 실패. 원본 그대로(`publish`·`io` 없음: 검증한 임시 파일이 게시 직전에 그대로가 아니어서 게시하지 않음) |
| `FileConflict` | 불러온 뒤 디스크의 파일이 바뀜(외부 수정). 덮어쓰지 않음 |
| `SaveInProgress{sessionId}` | 같은 세션 저장 중 |
| `RevisionMismatch`·`StaleLoad`·`StaleSession`·`InvalidState` | 옛 판·다시 불러온 시도·닫힌 세션·준비되지 않은 상태 |
| `SaveNotReady{pending\|composing\|uncertain\|state}`(프런트엔드) | 확정 전 편집·조합·불확실한 모델. `composing`은 끝나지 않은 IME 트랜잭션 전체(조합 중·앱이 먼저 확정한 조합·빈 끝 뒤 최종 글자 기다림, T010 — 아래 "저장과 끝나지 않은 IME 입력") |

## 형식별 저장 가능 여부(이 구현의 정책)

| 형식 | 저장되는 경우 | 막히는 경우(예) |
|------|---------------|-----------------|
| HWP 5 | 편집 없는 rhwp 왕복이 레코드 수준에서 원본과 같고(업스트림 예제 60개 중 54개 해당) **미리보기에 글자·그림이 없는** 문서. 고정 rhwp에서는 사실상 없다: 원본 `PrvText`에 글자가 있으면 rhwp가 그대로 둬 `previewStale`, 비었으면 rhwp가 다시 만들어 `PrvText` 바뀜(둘 다 unsafe). 대표 픽스처도 막힌다 | 낡은 미리보기(unsafe), `PrvText` 재생성·`ViewText` 빠짐(unsafe), 암호·DRM(열기 단계에서 거부), 배포용·보호(unknown), 깨진 레코드(unknown) |
| HWPX | 편집 없는 rhwp 왕복이 부분마다 원본과 같고 `Preview/*`가 비었음을 증명할 수 있는 문서(사실상 rhwp가 만든 문서, 예제 60개 중 3개) | 한컴이 만든 대부분의 문서(실제 요소 손실, unsafe), 글자가 있는 미리보기(unsafe), 잘린 XML(unknown), 모르는 요소·속성·부분(unsafe) |
| DOCX | 편집 없는 WordCraft 왕복이 부분마다 같고 썸네일이 없는 문서(WordCraft가 만든 문서) | Word가 만든 대부분의 문서(모르는 표시·부분 손실, unsafe), 썸네일(unsafe), 끊긴 XML(unknown) |
| HWP 3·HML·암호화 OOXML·docm/dotx | 열기(형식 판별)에서 이미 거부(T006) | — |

모든 형식: Linux 밖의 플랫폼, 하드 링크·다른 소유자·읽기 전용 파일, 그룹·그 밖이 쓸 수 있는 파일, 접근 ACL이 있는 파일, 확장 속성·
inode 플래그가 새 파일과 다른 파일, 다른 사용자가 항목을 바꿀 수 있는 디렉터리의 파일은 저장하지 않는다.

## 게시 무결성(3차 안정화 B·E, 4차 안정화 A)

**위협 모델**: 이 사용자(같은 uid의 다른 프로세스 포함)와 root는 믿는다. 같은 uid는 원본을 언제든 직접 쓸 수 있고 이 프로세스를
조작할 수도 있어 막을 수 없다. 그 밖의 사용자(같은 그룹의 다른 사용자 포함)는 믿지 않는다. 지원하는 경우에서 그들이 검증한 임시
파일의 내용이나 이름, 그리고 **원본까지의 경로가 가리키는 디렉터리**를 게시 전에 바꿀 수 없어야 하고, 그럴 수 있는 환경은 저장하지
않는다(4차 A에서 상위 디렉터리로 넓힘, 위협 모델 자체는 그대로).

| 조건 | 결과 | 이유 |
|------|------|------|
| 원본 권한 0600·0644·0640 등(그룹·그 밖 쓰기 없음) | 저장, 권한 그대로 | 임시 파일도 같은 권한: 이 사용자만 쓸 수 있다 |
| 원본에 그룹·그 밖 쓰기(0664·0646·0666) | `shared-file` | 임시 파일이 같은 권한이 되면 검증 뒤 게시 전에 그들이 바꿀 수 있다 |
| 원본에 접근 ACL | `metadata` | 권한 비트 밖의 쓰기를 줄 수 있고, 새 파일이 같은 ACL을 받는지 보장할 수 없다 |
| 디렉터리 소유자가 원본 소유자·root가 아님 | `shared-directory` | 디렉터리 소유자는 sticky여도 항목을 지우고 바꿀 수 있다 |
| 디렉터리에 그룹·그 밖 쓰기, sticky 없음(0775·0757·0777) | `shared-directory` | 그들이 임시 파일 이름을 다른 파일·심볼릭 링크로 바꿀 수 있다 |
| sticky 디렉터리(1777, 이 사용자·root 소유) | 저장 | 그 밖의 사용자는 남의 항목을 지우거나 이름을 바꿀 수 없다. 미리 만든 이름은 O_EXCL이 피하고, 이름은 운영체제 난수라 미리 차지할 수 없다(후속 강화 B) |
| 디렉터리 접근 ACL에 소유자 밖 항목의 쓰기 비트(마스크가 막아도) | `shared-directory` | 권한 비트 밖의 사용자가 쓸 수 있다(마스크까지 따지지 않는 보수적 판단) |
| 디렉터리 접근 ACL이 읽기·찾기만 줌(예: `u:www-data:r-x`) | 저장(4차 A 전에는 `shared-directory`) | 쓰기가 없으면 항목을 바꿀 수 없다. ACL은 `system.posix_acl_access`를 해석해 판단하고, 모르는 판·종류·길이면 막는다 |
| 디렉터리 기본 ACL만 | 새 파일이 상속한 ACL이 원본과 달라 `metadata` | 메타데이터 비교 |
| 사용자 개인 그룹(umask 002, 0664·0775) | 막힘(`shared-file`·`shared-directory`) | 그룹 구성원이 이 사용자뿐인지 NSS로 확인할 수 없다. `chmod g-w`로 풀 수 있다 |

### 상위 디렉터리(4차 안정화 A)

3차까지는 원본의 바로 위 디렉터리만 보았다. 그 위의 디렉터리 항목을 바꿀 수 있는 사용자는 바로 위 디렉터리를 읽을 수 없어도 그
**이름을 통째로** 다른 디렉터리와 맞바꿀 수 있다(같은 부모 안의 디렉터리 이름 바꾸기는 그 디렉터리 자체의 쓰기 권한을 묻지 않는다).
수정 전(`0a00938`) 실측:

- 결정적 시험(시험 훅으로 그 사용자의 `rename`을 흉내, `root/shared` 0777 · `docs` 0700 · 같은 부모의 `other` 0755): 임시 파일을 만들기 전에
  맞바꾸고, 다 쓴 뒤 되돌리고, 교체 직전에 다시 맞바꾸자 저장이 `Ok(durable: true, dirty: false)`로 끝났는데 사용자의 원본은 그대로였고
  `other/a.docx`(남의 파일)가 덮였다. 다음 사전 검사·저장도 그 다른 디렉터리의 파일로 `durable: true` 성공했다(원본은 끝까지 그대로).
  임시 파일만 다른 디렉터리에 만들어진 경우 새 문서 내용이 원본 권한 0644로 0755 디렉터리에 놓였다(저장은 `FileConflict`).
- 실제 다른 uid(사용자 이름공간: 이 사용자 = 안쪽 root, 피해자 uid 1001·공격자 uid 1002, tmpfs 뿌리로 chroot): 공격자가 `renameat2
  (RENAME_EXCHANGE)`로 `docs`·`other`를 계속 맞바꾸는 동안 300회 저장 × 3번. 3번 중 2번 `a.docx`가 `other`에 게시됐고(`ok durable=true` 4·1회
  포함), 공격자가 `docs`(0700)를 읽을 수 없는데도 새 문서 내용이 든 파일을 18·10·38개 읽었으며, 두 디렉터리에 임시 파일이 수십 개 남았다.

**규칙**: 원본 디렉터리까지 뿌리 `/`부터 한 이름씩, 앞 단계 디렉터리 핸들 기준으로(`openat`, `O_PATH|O_DIRECTORY|O_NOFOLLOW`) 열며 지나는
모든 디렉터리가 다음을 만족해야 한다. 아니면 `shared-directory`(임시 파일을 만들기 전, 원본·다른 파일 그대로).

- 소유자가 이 사용자(실효 uid)나 root.
- 그룹·그 밖 쓰기 비트와 소유자 밖 항목의 ACL 쓰기가 없거나, sticky이고 **경로가 지나는 다음 항목**의 소유자가 이 사용자·root.
- 접근 ACL을 읽을 수 없거나 해석할 수 없으면 막는다(`O_PATH` 핸들은 `/proc/self/fd/N`으로 읽는다: `/proc`이 없으면 막힘).

원본 바로 위 디렉터리는 3차의 규칙(소유자는 원본 소유자·root, 항목은 원본과 임시 파일)을 같은 판단 함수로 확인한다. 이름이 심볼릭
링크이거나 디렉터리가 아니거나 사라졌으면(불러온 정규화 경로가 바뀜) `FileConflict`. 상위를 읽을 권한은 필요 없다(찾기 권한만, 0311도 저장).

| 상위 디렉터리(원본에서 두 단계 위 등) | 결과 |
|------|------|
| 이 사용자 소유 0700·0755·0711·0311, root 소유 0755(`/`, `/home`) | 저장 |
| root 소유 1777(`/tmp`) 아래 이 사용자 소유 디렉터리, 이 사용자 소유 1777 | 저장(sticky: 남은 이 사용자 항목의 이름을 바꿀 수 없다) |
| 그룹·그 밖 쓰기 sticky 없음(0775·0770·0757·0777), 다른 사용자 소유, sticky인데 다음 항목이 다른 사용자 소유 | `shared-directory` |
| ACL `u:<다른 사용자>:r-x`·`g:<그룹>:--x` | 저장 |
| ACL `u:<다른 사용자>:rwx`(마스크 `r-x`여도) | `shared-directory` |
| 경로에 심볼릭 링크가 생김 | `FileConflict` |

**왜 이것으로 충분한가(위협 모델 안)**: 디렉터리 항목을 지우거나 이름을 바꾸려면 그 부모에 쓰기 권한이 있어야 하고(sticky면 항목 소유자도),
권한 비트·ACL은 소유자·root만 바꿀 수 있다. 뿌리부터 모든 단계가 위 조건을 만족하면 믿지 않는 사용자는 확인한 뒤에도 이 경로가 가리키는
디렉터리·원본 이름을 바꿀 수 없다(뿌리부터 귀납). 마운트를 바꾸는 것은 root뿐이다(다른 사용자의 마운트 이름공간은 이 프로세스의 경로에
영향이 없다).

**확인한 디렉터리 핸들(선택: 상위 확인 + 핸들 기준 연산)**: 걷기가 끝난 디렉터리 핸들을 저장 끝까지 쥐고 원본 열기·쓰기 권한 확인
(`faccessat`)·임시 파일 만들기(O_EXCL)·이름 확인(`fstatat`)·지우기(`unlinkat`)·교체(`renameat`)·`fsync`를 모두 그 핸들 기준으로 한다.
핸들은 디렉터리 객체를 지킬 뿐 그것이 아직 사용자가 보는 경로에 있음을 보이지 않으므로, 교체 직전에 원본 경로의 부모가 그 핸들의
디렉터리인지(장치·inode) 다시 보고(아니면 게시 안 함·임시 파일은 그 핸들 안에서 지움), 교체 뒤에는 원본 경로가 이 저장의 inode인지
본다(아니면 내구성 미확인). 그래서 경로가 (믿는 쪽에 의해) 그 사이 다른 디렉터리를 가리켜도 다른 디렉터리에 쓰거나 게시하거나 그곳의
파일을 지우지 않는다(결정적 시험: 만들기 전 이동·맞바꿈, 다 쓴 뒤 이동, 교체 직전 맞바꿈·교체 — 모두 게시 안 함·임시 파일 없음·원본과
남의 파일 그대로·세션 dirty 그대로). 상위 확인만으로도 위협 모델 안의 불변식은 지켜지지만, 핸들 기준 연산은 믿는 쪽의 경합에서도
"확인한 디렉터리에서만 일한다"를 보장하고 3차의 경로 기준 정리가 남기던 임시 파일을 없앤다.

임시 파일: 운영체제 난수를 넣은 이름(아래 "임시 파일 이름")으로 O_CREAT|O_EXCL(있는 이름·심볼릭 링크를 따라가지 않음)·0600으로 만들고 읽기·쓰기 핸들 하나로 쓰기·fsync·원본 권한·메타데이터
비교·되읽기를 한다(이름으로 다시 열지 않음). 검증을 마친 상태(inode·크기·수정·상태 변경 시각·권한)를 기록하고, 기록 잠금 안에서 원본
확인 뒤 교체 직전에 (1) 핸들의 상태가 그 기록과 같고 (2) 확인한 디렉터리 안의 임시 파일 이름이 아직 그 inode의 일반 파일이며 (3) 원본
경로의 부모가 그 디렉터리인지 본다. 아니면 게시하지 않는다(`SaveFailure{publish}`, 원본 그대로). 교체 뒤 원본 경로가 그 inode인지 다시
보고, 아니면 내구성 미확인이다.

수정 전 실측(`708a5e8`, 시험 훅으로 검증 뒤 바꿈): 남의 일반 파일·심볼릭 링크로 바꾼 임시 이름이 원본 이름으로 게시되고 `durable: true`로
성공했다. 검증 뒤 같은 inode에 덧붙인 내용도 게시됐다. `try_clone` 실패 시 임시 파일이 남았다.

**남는 경합(TOCTOU)**: 위의 확인은 stat 기반이라 경합을 없애지 못한다. 교체 직전 확인((1)~(3), 기록 잠금 안의 원본 지문)과 `renameat`
사이, 버릴 때 이름 확인과 `unlinkat` 사이, 상위 걷기와 그 뒤의 경로 기준 확인(원본 다시 읽기·지문·교체 직전 경로 확인) 사이의 창은 줄일 뿐
없앨 수 없다(POSIX에는 "이 inode일 때만 이름 바꾸기"가 없다). 지원하는 환경에서 그 창에 경로·이름을 바꿀 수 있는 것은 믿는 쪽(이 사용자·
root)뿐이고, 그래도 쓰기·게시·지우기는 확인한 디렉터리 안에서만 일어나며 게시 뒤 경로가 다르면 내구성 미확인으로 알린다. 원본 다시
읽기·사전 검사는 경로로 연다(경로가 바뀌면 `FileConflict`·`Unreadable`).

**가정(검증하지 않음)**: 권한 비트와 POSIX ACL이 실제 접근 판단과 같다(NFS·CIFS·FUSE처럼 서버나 사용자 공간이 따로 판단하는 파일 시스템,
NFSv4 ACL·richacl은 보지 않는다). root가 아닌 다른 사용자가 이 프로세스의 마운트 이름공간을 바꿀 수 없다. 공격자 프로세스와 같은 uid는 믿는
쪽이다.

### 임시 파일 이름(후속 강화 B, `ffab27e` 위)

수정 전 이름은 `.geul-save-{프로세스 번호}-{0부터 늘어나는 순번}.tmp`이었고 후보는 64개였다. 지원하는 sticky 디렉터리(1777)에서는 다른
사용자가 남의 항목을 지우거나 바꿀 수 없지만 **자기 항목은 만들 수 있고**, 프로세스 번호는 `/proc`으로 보인다(사용자 이름공간 실측: uid
1002가 root 소유 1777에 uid 1001 프로세스 번호로 이름을 만듦, 서로 지우기·이름 바꾸기 거부). 그래서 다음 후보 이름을 미리 만들어 두면
저장이 `SaveFailure{write, other}`로 막혔다(결정적 시험: 다음 1,024개를 미리 만들자 저장 실패, 원본·미리 만든 파일 그대로). 원본 손상이나
O_EXCL 우회는 아니고 저장 가용성 문제다(P2).

- 이름: `.geul-save-{프로세스}-{순번}-{무작위 32 hex}.tmp`. 무작위 부분은 이름마다 `getrandom(2)`(플래그 없음: 엔트로피 풀이 준비될 때까지
  기다림, 짧게 읽히면 이어 읽음, EINTR는 다시) 128비트다. 접두사·접미사는 그대로라 남은 임시 파일을 알아보는 규칙(T014)과 맞는다. 프로세스·
  순번은 진단·구분용일 뿐 막는 근거가 아니다.
- 충돌: O_EXCL이 있는 이름(남의 파일·심볼릭 링크·중단된 저장)을 열거나 덮지 않고, 다음 후보는 새 무작위 값이다(순번 이름으로 돌아가지
  않음). 남의 후보 파일은 지우지 않는다(정리는 이 저장이 만든 inode만). 64번 모두 겹치면 `SaveFailure{write, other}`(원본·dirty 그대로).
  우연히 겹칠 확률은 무시할 만하다(128비트: 이름 2^32개에서도 약 2^-65) — 64번이 모두 겹친다는 것은 난수가 고장 났거나 공격이 난수를
  안다는 뜻이다.
- 난수 실패: 이름을 만들지 않고 `SaveFailure{write, other}`(기존 오류 계약). 짐작할 수 있는 이름으로 대신하지 않는다. 원본·dirty 그대로,
  난수·문서 내용은 기록하지 않는다.
- 시험용 이름 원천(`NAME_SOURCE`)은 `#[cfg(test)]`에만 있어 제품 빌드의 난수를 바꿀 수 없다. 시험은 후보의 순번을 받아 그 이름을 미리
  만들어 정확한 충돌(파일·링크)·소진·난수 실패를 만든다.
- 한계: 무작위 이름은 미리 차지하는 것만 막는다. sticky 디렉터리의 다른 사용자는 여전히 디렉터리를 채우거나(항목 수·공간·할당량) 원본
  디렉터리 쓰기 자체를 어렵게 할 수 있다(가용성, 이 작업 밖). 같은 uid·root는 믿는 쪽이다. 이름이 예측 불가능하다는 것은 안전성의 근거가
  아니며, 디렉터리 신뢰·inode 소유·게시 직전 확인이 그대로 근거다.

### 다중 사용자 탐침 판정(후속 강화 A)

`a4_다중_사용자_탐침`(무시 시험, 환경 변수로만 실행)은 4차의 결과를 `eprintln!`로 내기만 해서, 실제로 임시 파일이 두 디렉터리에 남고
공격 쪽이 새 내용을 읽은 실행(`0a00938` 대상)도 `test result: ok`였다. 환경 변수가 없으면 아무것도 하지 않고 통과했고, 이전 실행의 완료
표지나 공격 쪽이 시작하지 않은 경우도 구분하지 않았다. 이제 판정을 강제한다(PASS가 아니면 시험이 실패하고 `A4PROBE verdict=` 줄을 낸다).

| 판정 | 조건 |
|------|------|
| PASS | 준비·측정이 끝났고 공격이 실제로 있었으며(공유 상위: 피해자가 경로가 다른 디렉터리를 가리키는 것을 직접 봄·공격 쪽 시도 > 0, 믿는 배치: 시도 > 0·맞바꿈 0) 아래 불변식을 모두 지킴 |
| FAIL | 다른 디렉터리에 항목이 생김(게시·임시 파일), 원본 디렉터리에 a.docx 밖의 항목, 남의 파일 바뀜, 공격 쪽이 문서 내용 파일을 읽었다고 보고, 거부된 저장 뒤 dirty 풀림, 저장이 없는데 원본(내용·inode) 바뀜, 저장했는데 원본 경로가 마지막 저장 내용이 아니거나 공격을 멈춘 뒤 사전 검사가 기록과 맞지 않음, 공유 상위 아래에서 저장됨, 믿는 배치에서 저장이 durable·깨끗하지 않음 |
| INCONCLUSIVE | 공격 쪽 완료 표지가 없거나 이번 실행의 무작위 표지(nonce)가 아님, 시도 0, 공유 상위인데 맞바꿈을 보지 못함·상위 확인까지 간 저장이 없음, 믿는 배치인데 맞바꿈이 일어남, 공격을 멈춘 뒤 배치가 돌아오지 않음, 저장 시도 없음, 선언한 배치(`GEUL_A4_LAYOUT`)가 공유 디렉터리의 실제 권한과 다름 |
| NOT-RUN | 환경 변수(`GEUL_A4_SHARED·READY·STOP·DONE·LAYOUT·ROUNDS`)가 없음, 이전 실행의 표지 파일이 남아 있음, 시험 디렉터리를 준비하지 못함 |

FAIL이 INCONCLUSIVE보다 앞선다(표지가 없어도 다른 디렉터리 게시는 실패). 측정은 피해자 쪽 값이다: 저장 결과와 거부 직후 레지스트리 dirty,
회차마다 경로 `shared/docs`의 inode 표본, 끝난 뒤 inode로 찾은 원래 `docs`·`other`의 항목·원본 내용·inode, 남의 파일(inode·내용), 공격을
멈춘 뒤 같은 세션의 사전 검사. 공격 쪽 보고는 이번 실행 표지가 맞을 때만 쓰고, 통과의 근거로는 시도 수만, 노출 수는 실패의 근거로만 쓴다.
진단 줄에는 경로·문서 내용 없이 개수·오류 종류만 있다.

**측정 무결성(시험 기반 안정화 B)**: 재지 못한 값은 깨끗한 관찰이 아니다. 수정 전에는 디렉터리 목록을 열지 못하면 빈 목록으로, 항목을
읽다 난 오류는 버렸고, 경로 표본을 재지 못하면 "맞바꿈을 봄"으로 셌다. 그래서 다른 디렉터리를 읽을 수 없게(0311) 하면 그 안에 숨긴 게시가
있어도 PASS였고, 원본 디렉터리를 읽을 수 없거나 다른 디렉터리가 사라지거나 바뀌면 측정 실패가 FAIL로 읽혔다(결정적 시험으로 확인).
이제 각 측정은 "값" 또는 "재지 못함"이다.
- 두 디렉터리는 공격을 멈춘 뒤 두 경로의 inode로 찾는다(원래·맞바뀐 배치가 아니면 재지 못함). 목록은 그 디렉터리가 처음과 끝에 같은
  inode일 때 끝까지 읽은 경우에만 값이다(열기·항목 오류·도중 교체는 재지 못함, 빈 디렉터리는 빈 목록이라는 값).
- 원본 파일·남의 파일은 그 디렉터리가 지금도 그 inode일 때만 잰다. `NotFound`만 "없음"으로 확인된 것이고, 그 밖의 오류는 재지 못함.
- 공격을 멈춘 뒤 사전 검사는 `FileConflict`만 "기록과 다름"이고 그 밖의 오류는 재지 못함(저장이 없으면 필수가 아니다).
- 경로 표본은 성공한 표본만 맞바꿈의 근거이고, 재지 못한 표본이 하나라도 있으면 판단 불가다.
- 판정: 측정한 값으로 확인된 위반은 다른 측정이 없어도 FAIL, 확인된 위반이 없는데 필수 측정이 없으면 INCONCLUSIVE("측정 실패: <종류>"),
  모두 쟀고 위반이 없을 때만 PASS.

**표지 난수(시험 기반 안정화 C)**: 이번 실행 표지는 `getrandom(2)`를 끝까지 채울 때까지 부른다(짧게 읽히면 이어 읽고, EINTR는 다시,
0바이트·요청보다 많은 바이트·그 밖의 오류는 실패). 실패하면 일부만 채운 값이나 짐작할 수 있는 값을 쓰지 않고, 시험 디렉터리·표지를 만들기
전에 NOT-RUN으로 끝난다. 원래 코드는 한 번 호출이 16바이트가 아니면 `assert`로 멈췄다(판정 줄 없음). 리눅스는 초기화된 엔트로피에서
256바이트 이하 요청을 짧게 돌려주지 않으므로 실제로 재현한 결함은 아니고, 계약을 바로잡은 것이다. 제품의 임시 파일 이름 난수(`fill_random`)와
시험용 이름 원천은 따로이며 바뀌지 않았다.

**플랫폼(시험 기반 안정화 A)**: `libc`는 `cfg(unix)` 의존성이고 고정 `libc` 0.2.190의 Apple 대상에는 `getrandom`이 없다. 그래서 탐침의
운영체제 난수(`os_getrandom`)·실행(`ProbeRun`·`run_probe`·`report_probe`·`measure_dir`)·시험용 이름 원천 도우미(`with_names`, `std::os::unix`
심볼릭 링크)와 그것을 쓰는 시험은 `cfg(target_os = "linux")`이다. 판정 함수·표지 해석·난수 채우기 순서(`fill_nonce`) 시험은 모든 플랫폼에서
돈다. Windows·macOS 시험 빌드는 이 환경에 그 대상의 표준 라이브러리가 없어 실제로 컴파일하지 못했고(NOT RUN), 바뀐 시험 파일에서 Linux
전용 기호를 쓰는 cfg 없는 항목이 없음을 정적으로 확인했다.

후속 cfg 정리(`43f5972` 위, `tests.rs`): Linux 전용 시험에서만 쓰는 도우미 13개(`walk_dirs`·`precreate_predictable`·`Squat`·
`random_temp_name`·`dirty_now`, 그리고 같은 이유의 `save_hooked`·`open_docx_in`·`exchange`·`HookSlot`·`Hooks`·`RaceCase`·`save_with_hooks`·
`assert_published`)에도 같은 cfg를 붙여, Linux 밖의 시험 빌드에서 쓰이지 않는 코드(dead_code 경고)가 남지 않게 했다(오류가 나는 기호는 없었음).
cfg 없는 시험에서 닿지 않는 cfg 없는 항목·cfg 있는 항목을 부르는 cfg 없는 항목·Linux 밖에서 쓰이지 않는 최상위 `use`가 0개임을 정적으로
확인했다(호출 그래프 점검). Linux 시험 목록은 그대로(159개 = 155 + 무시 4)다. Windows·macOS는 여전히 NOT RUN이고, 설치된 wasm32 대상은 의존성
`tao`가 그 플랫폼을 지원하지 않아 검사에 쓸 수 없었다. 이 시점(`8aa2686`)에는 제품 코드(`publish.rs`)의 Linux 밖 dead_code 가능성(`temp_name`·`COUNTER` 등)을
아직 확인하지 않았고, 다음 정리에서 다뤘다.

게시 모듈 cfg 정리(`8aa2686` 위, `publish.rs`, 커밋 `c7d1a98`): 원본 교체가 Linux에서만 동작하므로, Linux 함수에서만 쓰이는 가져오기
(`OpenOptions`·`Read`·`Write`·`AtomicU64`·`Ordering`·`describe_published`·`IoProblem`·`SaveStage`, `std::io`는 시험이나 Linux)·임시 파일 이름
상수와 도우미(`COUNTER`·`MAX_NAME_ATTEMPTS`·`NAME_RANDOM_BYTES`·`temp_name`)·오류 도우미(`io_problem`·`failure`·`metadata_unsupported`·
`unsupported`·`not_published`)·검증 상태(`Snapshot`·`snapshot`·`Staged::verified`)·`same_inode`·`Staged::at_path`에 `cfg(target_os = "linux")`,
그것을 쓰는 시험 원천(`NameSource`·`NAME_SOURCE`·`name_for`·`next_name_number`)에 `cfg(all(test, target_os = "linux"))`를 붙였다. 호출하는 곳이
어느 대상에도 없는 `cfg(not(unix))` 대역(`same_inode`·`snapshot`·`at_path`)은 지웠다. Linux 밖의 `stage`·`publish`(`SaveUnsupported{platform}`),
`Staged`(Linux 밖에서는 만들어지지 않음)·`Drop`(Linux 밖 `same_inode_at` 대역이 false라 지우지 않음)·시험 훅(`Fault`·`Hook`·`before_check`·
`BEFORE_*`, 교차 플랫폼 `service.rs`가 씀)은 그대로다. 근거: `publish.rs`를 복사해 `target_os = "linux"`·`unix` cfg를 기능으로 바꾼 작은 크레이트를
세 배치(Linux·unix지만 Linux 아님·unix 아님)에서 라이브러리·시험 모두 `clippy -D warnings`로 검사 — 수정 전 Linux 밖 두 배치에서 라이브러리 17개·
시험 13개(쓰이지 않는 가져오기·코드), 수정 뒤 세 배치 모두 0개. 이것은 cfg 그래프 모의이며 실제 Windows·macOS 컴파일(표준 라이브러리·의존성)은
여전히 NOT RUN이다. Linux 동작·시험(155 + 무시 4)은 그대로다. Windows·macOS 원본 교체는 계속 막혀 있다(`SaveUnsupported{platform}`): 실제 빌드·실행 검증은 T016, 플랫폼별 교체 구현과 그
내구성·복구는 T014 몫이다.

실행 절차(로컬, subuid·`newuidmap`이 있을 때): `unshare --user --map-users=0:<내 uid>:1 --map-users=1:<subuid 시작>:65536 (gid도 같게)
--mount --pid --fork`로 들어가 tmpfs 뿌리를 만들고 `/nix`·`/dev`를 묶고 `/proc`을 올려 chroot한 뒤, 공유 디렉터리(`/work/shared`, 권한은
배치에 맞게 0777·0755·1777)에서 공격 쪽(uid 1002)이 `renameat2(RENAME_EXCHANGE)`로 `docs`·`other`를 계속 맞바꾸고 피해자(uid 1001)가
`<시험 바이너리> --ignored --exact services::save::tests::a4_다중_사용자_탐침`을 실행한다. 실행 절차의 종료 코드는 `verdict=`로 PASS 0,
FAIL 1, INCONCLUSIVE·NOT-RUN 2다. 모든 파일은 이름공간 안의 tmpfs에만 만든다.

기본 시험 묶음(다른 uid 없이): 판정 함수에 위반 9가지·배치별 위반·판단 불가 8가지를 넣어 확인하고, 같은 프로세스 안의 시험용 공격(회차마다
맞바꿈, 멈춤 표지에 응답)으로 실제 저장 경로를 돌려 PASS를, 판정 직전 디스크에 다른 디렉터리 게시·남은 임시 파일·남의 파일 변경·원본 교체를
넣거나 노출을 보고하게 해 FAIL을, 다른 실행 표지·맞바꿈 없음·배치 불일치로 INCONCLUSIVE를, 남은 표지로 NOT-RUN을 확인한다(`a5_`).

## 저장과 끝나지 않은 IME 입력(T010 IME 경계 후속, `7680d92` 위)

- 빈 끝(`compositionend("")`) 뒤 입력기의 최종 글자를 기다리는 동안(`awaitingCommit`)은 저장을 시작하지 않는다(`SaveNotReady{composing}`).
  전에는 이 상태가 저장 시작 조건·저장하지 않은 편집 판정에 없어, 기다리는 글자가 없는 판을 저장하고 "저장함"으로 보였다(재생 시험).
- 사전 검사·내보내기를 기다리는 동안 이 상태가 생기면 백엔드 저장 직전의 재확인이 막는다(사전 검사만 있고 저장 호출 없음).
- 백엔드 저장이 이미 간 뒤 생기면 저장은 그 판(그 글자 없음)으로 끝나고 결과는 "그 뒤 편집 있음"(`changedSince`)으로 보이며, 문서는
  저장하지 않은 입력으로 남는다(rhwp는 이때 `modified`를 지우지 않는다 — 전에는 지워 닫기 보호가 사라졌다).
- 기다림이 최종 글자로 끝나면 보통처럼 저장되고, 진짜 취소로 끝나면(다음 키) 글자·revision을 만들지 않고 저장된다. 판정·교체·게시
  규칙(T009)은 그대로다. 프런트엔드 상태만 바뀌었고 IPC·백엔드 저장 경로는 그대로다.

## T010 후속: 명시적 폐기 뒤 IME 복구 (2026-10-21, `94110f9` 위)

닫기·창 닫기 실패 뒤에도 사용자가 버린 활성 조합·최종 글자 기다림은 다시 살아나지 않는다. rhwp의 조합 미리보기는 WASM 모델의 임시 범위를 지워 정리하며, 이미 확정한 다른 편집은 유지한다. 새 조합은 시작 이벤트 없이 첫 preedit로 들어갈 수 있고, 새 입력의 실제 변경만 revision에 반영한다. `imeUnsettled`의 저장 차단, 저장 중 새 입력의 `changedSince`, T009 사전 검사·충돌·게시 규칙은 그대로다. rhwp의 미리보기 취소 뒤 `modified`는 기존의 보수적 정책을 따른다.

## T010 최종 안정화: 선택 대체 수명주기 및 저장 불변식 보존 (2026-10-21, `37b39ae` 위)

선택 텍스트를 대체하는 조합의 폐기·취소 및 실패한 닫기 복구 시에도 문서의 revision, dirty 상태, 저장 안전성 계약이 완벽히 유지된다. rhwp에서 선택 영역 삭제는 1회의 mutation으로 정상 반영되며, 취소 시 임시 조합 텍스트만 정리되어 모델과 revision이 일치한다. 활성/대기/provisional IME 상태에 따른 `imeUnsettled`의 `SaveNotReady{composing}` 저장 차단, T009 사전 검사(`roundtrip 18/18` 통과) 및 안전한 원자적 파일 교체 규칙은 일절 변경 없이 온전히 보존된다.

## 검증

T009 구현(`93e6acf`)·안정화(`708a5e8`)·3차 안정화(`0a00938`) 때의 결과는 그 커밋의 이 문서에 있다.

### 시험 기반 안정화(A 플랫폼 cfg·B 측정 무결성·C 표지 난수) 검증 — 기준 `20fb077`(작업 트리 깨끗, 시작 실측 cargo test 149 passed / 4 ignored + 통합 1)

| 검사 | 결과 |
|------|------|
| `cargo fmt --check`·`cargo clippy --locked --all-targets -- -D warnings` | 통과 |
| `cargo test --locked` | lib 155 passed, 4 ignored + 통합 1 — 새 시험 6개(B 측정하지 못한 디렉터리·확인된 위반 7가지, B 목록 측정 빈 디렉터리·읽기 불가·중간 오류·교체·없어짐, B 목록 중간 오류 E2E, B 판정의 측정 실패 8가지·확인된 위반 5가지, C 표지 난수 짧은 읽기·EINTR·0바이트·오류, C 실제 난수·난수 실패 NOT-RUN) |
| 수정 전 실패 확인(B) | `20fb077`의 탐침에서 다른 디렉터리를 읽을 수 없게 하면 PASS(숨긴 게시가 있어도), 원본 디렉터리 읽기 불가·다른 디렉터리 없어짐·교체는 FAIL로 오분류(시험 `a6_`의 5가지 실패) |
| 다중 uid 탐침(실행 절차 종료 코드 포함) | 이 커밋: swappable 0777 300회 PASS(종료 0, 피해자가 본 맞바꿈 232, 표본 실패 0, 공격 쪽 시도 98,941·노출 0, 두 디렉터리 항목 각 1), locked 0755·1777 100회 PASS(종료 0, 100/100 durable·깨끗, 공격 쪽 시도 84,864·50,528 모두 거부), 0755를 swappable로 선언 INCONCLUSIVE(종료 2), 잘못된 배치 값 NOT-RUN(종료 2). `0a00938` 게시 코드 + 이 탐침: swappable 300회 FAIL(종료 1: 다른 디렉터리 항목 15, 원본 디렉터리 남은 파일, 공격 쪽 노출 29, 공유 상위 아래 저장 11) |
| Windows·macOS 시험 빌드 | NOT RUN — 이 환경에 x86_64-unknown-linux-gnu·wasm32 표준 라이브러리만 있음. 정적 cfg 점검: 바뀐 시험 파일에 Linux 전용 기호(`libc::`, `std::os::unix`, 탐침 실행 도우미)를 쓰는 cfg 없는 항목 0개 |
| Vitest·`npm run typecheck`·`lint`·`build` | 571(29파일)·통과(프런트엔드 변경 없음) |
| `check-sensitive-info.py`(바뀐 파일) | 통과 |
| roundtrip·`tauri_smoke.py`·`rhwp_poc.py`·`wordcraft_poc.py`·실제 IME | 다시 실행하지 않음 — 이번 변경은 시험 코드(`tests.rs`)와 문서뿐이고 제품 코드·앱 실행 경로가 바뀌지 않았다. 직전 결과(아래 후속 강화 표)를 그대로 둔다 |

### 후속 강화(A 탐침 판정·B 임시 파일 이름) 검증 — 기준 `ffab27e`(작업 트리 깨끗, 시작 실측 cargo test 144 passed / 4 ignored + 통합 1)

| 검사 | 결과 |
|------|------|
| `cargo fmt --check`·`cargo clippy --locked --all-targets -- -D warnings` | 통과 |
| `cargo test --locked` | lib 149 passed, 4 ignored(다중 사용자 탐침 포함) + 통합 1 — 새 시험 5개(B 짐작 이름 선점, B 이름·충돌·소진·난수 실패·실패 뒤 정리·sticky, B 동시 저장, A 판정 함수, A 실제 저장 경로·음성 대조) + 고친 시험 2개(남은 임시 파일·만든 직후 실패: 정확한 충돌을 시험용 이름 원천으로 만듦) |
| 수정 전 실패 확인 | B: 다음 1,024개 짐작 이름을 미리 만들자 `ffab27e`의 저장이 `SaveFailure{write, other}`로 막힘(sticky 1777). A: 4차 탐침은 `0a00938` 대상 실행에서 임시 파일이 두 디렉터리에 남고 공격 쪽이 문서 내용을 읽었는데도 `test result: ok`, 환경 변수가 없으면 통과 |
| 다중 uid 탐침(사용자 이름공간, 새 판정) | 이 커밋: 공유 상위 0777(swappable) 300회 × 3 PASS(피해자가 맞바꿈 275·290·285번 봄, 공격 쪽 시도 약 10만·노출 0·남은 파일 0), 0755·1777(locked) 100회 PASS(100/100 durable·깨끗, 공격 쪽 시도 약 9만 모두 거부). `0a00938`(4차 수정 전 게시 코드) + 새 탐침: swappable 300회 × 2 **FAIL**(다른 디렉터리 항목 13, 원본 디렉터리 남은 파일 14·10, 공격 쪽 노출 15, 기록 불일치, 공유 상위 아래 저장 5·2), locked 1777 PASS. 환경 변수 없음 → NOT-RUN(시험 실패), 0755를 swappable로 선언 → INCONCLUSIVE(종료 코드 2) |
| sticky 의미(사용자 이름공간 실측) | root 소유 1777에서 uid 1002가 uid 1001의 프로세스 번호를 보고 그 번호로 이름을 만듦, 서로의 항목을 지우거나 이름을 바꾸지 못함 |
| Vitest·`npm run typecheck`·`lint`·`build` | 571(29파일)·통과 — 프런트엔드 변경 없음 |
| `python3 tests/roundtrip/roundtrip.py` | 18/18 |
| `tauri_smoke.py`(weston) | 62/62 |
| `rhwp_poc.py`(새 weston 세션) | 73/73 |
| `wordcraft_poc.py`(Xvfb + D-Bus 세션 · 새 weston 세션) | 60/60 · 59/59 |
| 실제 한국어 IME(Xvfb + ibus 1.5.33 + ibus-hangul 1.5.5, xdotool) | DOCX 필수 7/7 PASS 3회, rhwp 필수 7/7 PASS 2회 — 창 초점 항목 NOT RUN(다른 창 없음) |
| `check-sensitive-info.py`(바뀐 파일) | 통과 |

네이티브 실행 메모: 첫 묶음에서 rhwp HWPX 키 지연 표본이 12개뿐이어서(필요 70, p95 38 ms) 멈췄고, 오래 쓴 weston 세션의 `wordcraft_poc.py`가
시작 시간 초과, WebDriver 연결 끊김(`Remote end closed connection without response`)이 Xvfb·rhwp IME 1회에서 났다(저장과 무관한 앞 단계, 이전
기준선에서도 본 현상). 또 내 실행 절차 실수 두 가지: 입력기 없는 Xvfb 시험을 ibus-hangul(한글 모드) 세션에서 돌려 표 셀 입력이 조합으로
들어감, D-Bus 세션 없이 돌려 앱 프로세스가 끝나지 않음 — 둘 다 실행 환경을 고쳐(입력기 없음 + `dbus-run-session`) 다시 실행해 통과했고 위의
수치는 그 결과다. 실패 로그는 로컬 기록.

### 4차 안정화 검증 — 기준 `0a00938`

아래는 4차 안정화 뒤 같은 작업 트리에서 실행한 결과다(시작 기준선 실측: `0a00938`, 작업 트리 깨끗, cargo test 139 passed / 3 ignored + 통합 1).

| 검사 | 결과 |
|------|------|
| `cargo fmt --check`·`cargo clippy --locked --all-targets -- -D warnings`(src-tauri) | 통과 |
| `cargo test --locked`(src-tauri) | lib 144 passed, 4 ignored(기존 3 + 다중 사용자 탐침 1) + 통합 1 — 4차 새 시험 5개(A 공유 상위 맞바꾸기, A 상위 권한·ACL 표, A 믿는 경로의 저장 중 이동·맞바꿈·링크, B 압축 BinData 31가지 + 상한 3 + 끝나지 않은 레코드 스트림 2, C 미리보기 운반체 5가지) + 고친 시험(C 엔진 상수를 고정 rhwp 소스와 대조) + 기존 시험 정책 갱신(예약·중복 BinData 선언 unknown, 미리보기 PNG·글 규칙) |
| 수정 전 실패 확인(`0a00938` + 시험 훅만) | A 시험 3개 모두 실패(공유 상위 아래 `Ok(durable: true, dirty: false)`·남의 파일 덮음, 0775 상위 저장됨, 믿는 경로 이동에서 경로 기준 동작). B 그때의 29가지 중 18가지가 safe(같은 바이트의 깨진·잘린·끝 블록 없는·빈·꼬리 틀린 스트림, 예약·중복·대소문자 다른 이름·ASCII 아닌 이름·해석할 수 없는 선언). C 운반체 5가지를 모두 "내용 없음"으로 받음 |
| 다중 uid 실측(사용자 이름공간, 공격자가 `docs`·`other` 계속 맞바꿈) | 0777 공유 상위: 수정 전 300회 × 3 — 다른 디렉터리 게시 2번, 공격자가 새 내용 파일 18·10·38개 읽음, 임시 파일 수십 개 남음. 수정 뒤 300회 × 3(+100회 × 2) — 성공 0·노출 0·남은 파일 0(`shared-directory` 또는 경로가 맞바뀐 때 `Unreadable`), 원본 그대로. 0755 root 소유·1777 root 소유 sticky: 수정 전·뒤 모두 100/100 `durable: true`, 공격자 이름 바꾸기 전부 거부(EACCES·EPERM) |
| `python3 tests/roundtrip/roundtrip.py` | 18/18 — HWP 편집 저장 기대 근거를 `previewStale{PrvText, PrvImage}`로 바꿈(판정은 그대로 unsafe), HWPX 편집 저장 safe 그대로 |
| 표본 탐침(업스트림 예제, 로컬: HWP 59·HWPX 59 편집 없는 rhwp 왕복) | 수정 전·뒤 판정과 근거가 같음(HWP safe 54·unsafe 3·unknown 2, HWPX safe 2·unsafe 57) |
| Vitest | 571(29파일) — 프런트엔드 코드 변경 없음(번역 문구 2개만) |
| `npm run typecheck`·`lint`·`build` | 통과 |
| `tauri_smoke.py`(헤드리스 weston) | 62/62 |
| `rhwp_poc.py`(헤드리스 weston) | 73/73 |
| `wordcraft_poc.py`(Xvfb X11 · 헤드리스 weston) | 60/60 · 59/59(새 weston 세션) |
| 실제 한국어 IME(Xvfb + ibus 1.5.33 + ibus-hangul 1.5.5, xdotool) | DOCX 필수 7/7 PASS 3회, rhwp 필수 7/7 PASS 2회 — 창 초점 항목은 다른 창을 주지 않아 NOT RUN |
| 키 반영 p95(개발 빌드) | weston HWP 41 ms·HWPX 33 ms, Xvfb DOCX 52 ms — 모두 150 ms 이하 |
| `check-sensitive-info.py`(바뀐 파일) | 통과 |

네이티브 실행 메모: 같은 기계에서 다른 작업(다른 에이전트의 빌드·브라우저)으로 부하가 5~13일 때 `wordcraft_poc.py`가 WebDriver 연결 끊김
(`Remote end closed connection without response`)·시작 시간 초과·115쪽 다시 그리기 대기 초과로 멈췄다. 같은 조건에서 수정 전 빌드(`0a00938`,
검사 훅)도 3번 중 2번 같은 방식으로 멈췄고, 오래 쓴 weston 세션에서는 두 빌드 모두 시작부터 `no such window`였다. 부하가 3 아래일 때
Xvfb 60/60, 새 weston 세션 59/59로 통과했다(저장과 무관한 앞 단계의 환경 문제로 판단, 실패 로그는 로컬 기록). 첫 IME 실행은 ibus-hangul 초기
모드 설정을 빠뜨려 ASCII가 들어갔으므로 IME 검증으로 쓰지 않았다(이전 기록의 설정 — 초기 hangul 모드·`use-event-forwarding=false` — 으로
다시 실행).

## 남은 위험

- 보존 비교는 컨테이너·XML·레코드 수준의 동일성이다. 한컴 오피스·Word가 같게 보인다는 증거가 아니며, 실제 프로그램 왕복 시험은
  T015·T016이다.
- 편집한 저장에서 본문 부분의 내용은 엔진 다시 열기 비교(본문 글자·컨트롤 목록·쪽 수, DOCX는 모델 동일)로만 본다. 본문 부분의
  비교 대상이 엔진 자신이므로, 엔진이 읽지도 쓰지도 않는 본문 속 표시는 사전 검사(편집 없는 왕복)가 잡는다는 가정에 기댄다.
- HWP 편집 저장은 고정 rhwp에서 사실상 막힌다(F). 풀려면 rhwp가 편집 모델의 미리보기를 다시 만들거나 지우는 수단이 필요하다
  (업스트림 변경, 이 작업 밖). 재생성한 미리보기를 받아들이려면 그 내용이 편집한 본문에서만 왔는지 독립적으로 확인하는 규칙이 필요하다.
  4차 C 뒤로는 한 색 PNG·공백 글 미리보기도 받지 않으므로, 한컴이 만든 HWPX·HWP에 빈 쪽 미리보기가 있어도 본문을 바꾼 저장은 막힌다
  (지금 저장되는 HWPX는 rhwp가 만든 문서뿐이라 그 문서들의 엔진 상수 미리보기는 계속 받는다 — `roundtrip.py`의 HWPX 편집 저장 safe 그대로).
  rhwp가 만든 HWP의 `PrvImage`(blank2010 자산 5,126바이트)도 상수 목록에 넣지 않았다: 넣어도 `PrvText` 때문에 판정이 바뀌지 않는다.
- 남는 경합(TOCTOU): 교체 직전 확인(기록 잠금 안의 stat: inode·크기·수정 시각·ctime·권한·소유·링크 수, 임시 파일의 검증 상태·이름,
  원본 경로의 부모가 확인한 디렉터리인지)과 `renameat` 사이에 믿는 쪽(이 사용자·root)이 원본이나 임시 이름을 바꾸면 그 변경은 덮이거나
  게시된다(뒤의 것은 교체 뒤 확인으로 내구성 미확인이 된다; 게시는 확인한 디렉터리 안에서만 일어난다, 4차 A). POSIX에는 "이 inode일 때만 이름 바꾸기"가 없어 창을 줄일 뿐 없앨 수 없다. 다른 사용자가 바꿀 수 있는 환경은 막는다. 일반 프로세스는
  ctime을 정할 수 없어(`utimensat`으로 수정 시각을 되돌려도 ctime은 바뀐다) 같은 크기·수정 시각으로 위장한 변경도 잡는다. 원본 해시는 임시 파일을
  쓴 뒤 다시 확인한다. 메타데이터 비교는 임시 파일을 다 쓴 시점이고, 그 뒤 원본의 변경은 ctime으로 잡는다.
- 상위 디렉터리 신뢰(4차 A)는 권한 비트·POSIX ACL이 실제 접근 판단과 같다는 가정에 기댄다. 네트워크·FUSE 파일 시스템의 서버 쪽 권한,
  NFSv4 ACL은 보지 않는다. 그룹 쓰기 상위(사용자 개인 그룹 포함)·다른 사용자 소유 상위·`/proc`이 없는 환경은 저장이 막힌다(정직한 결과).
  다중 사용자 실측은 사용자 이름공간(이 사용자 = 안쪽 root, subuid 두 개)에서 한 것이고 실제 여러 계정 데스크톱에서 한 것이 아니다.
  다중 사용자 탐침은 무시 시험이라 기본 시험 묶음·CI에서 돌지 않는다(판정 논리는 기본 묶음의 `a5_`가 지킨다).
- 임시 파일 이름의 무작위화(후속 강화 B)는 이름 선점만 막는다. sticky 디렉터리의 다른 사용자가 디렉터리·파일 시스템을 채우는 것(항목 수·
  공간·할당량)은 막지 않는다(가용성). 운영체제 난수를 얻지 못하면 저장하지 않는다.
- 내구성은 디렉터리 `fsync` 성공까지다(정전 시험은 T014). 중단 뒤 남은 `.geul-save-*.tmp`의 정리는 T014.
- `user.*` 확장 속성은 확인한 임시 파일 핸들에 복사한다. 복사 실패나 전체 메타데이터 불일치는 저장을 막는다. ACL·보안 속성·inode 플래그는 옮기지 않고, 원본에 있어 새 파일과 다르면 저장을 막는다. SELinux 등에서 새 파일이 다른 레이블을 받는
  환경은 저장이 막힌다(정직한 결과). Windows·macOS는 저장하지 않는다(T014·T016).

### CI 독립 미리보기 근거와 XML 자원 후속

고정 RHWP 빈 미리보기의 독립 골든은 `tests/fixtures/rhwp/blank-preview/`에 있다.
일반 Rust 검사는 이 main-repository 파일을 포함하며 RHWP checkout을 읽지 않는다.
출처·고정 revision·SHA-256 및 선택적 upstream 대조 방법은 해당 README를 따른다.
정확한 68바이트 예외와 다른 PNG의 CRC/zlib 검사는 유지한다.

XML 정규화의 메모리 증폭은 기존 T009 위험이다. 현 할당 경계와 별도 예산/streaming 비교 제안은
[t009-xml-resource-followup.md](t009-xml-resource-followup.md)에 기록한다. 현재 표현/수용 상한은 그대로다.
명시 실행 RSS 도구는 reset 성공 여부와 측정 방법을 출력하며 reset 실패 시 단계 peak를 `null`로 둔다.
그때 읽힌 HWM은 `processPeakRssKiB`일 뿐 단계 측정이 아니다. `/proc` 읽기/값 검증 실패도 `null`과 오류로
기록한다. 성공한 reset도 프로세스 전체의 해당 구간 HWM이므로 다른 스레드/allocator 영향을 포함한다.
이전 오류 무시 측정과 조건 확인 없이 직접 동등하다고 비교하지 않는다.

양성 formCharPr 엔진 회귀는 `python3 tests/integration/rhwp/formcharpr_save.py`로 별도 실행한다.
기존 고정 WASM과 생성한 문서에 합성한 본문/셀 양식을 사용하며, 저장된 정확한 바이트를 다시 읽는다.
본문 상세 API의 `properties.CharShapeID`, 본문/셀의 해석된 모델 재직렬화와 해당 기울임 정의,
주변 글/서식, dirty 해제와 임시 파일 정리를 검증한다. 셀의 indexed 상세 API나 실제 픽셀 모양 검증으로
주장하지 않는다. 이 검사는 일반 Rust CI에 RHWP 의존성을 추가하지 않는다.

선택적 formCharPr 회귀의 엔진 identity 검사는 `production-identity.mjs`가 맡는다.
독립 기대 해시는 기존 커밋 `db5c9a4`의
`tests/integration/rhwp/evidence/t010-native-evidence-final-integrity/protected-runtime-inputs.json`
기록을 그대로 재사용한다. `7486df3`의 별도 기록과 현재 실제 파일 바이트도 대조했다.
이 기록은 생산 산출물 동일성 시험 기준이며 서명·native D1 후보 승인·TRUST_ANCHOR를 대체하지 않는다.

`BUILD.json`의 전체 바이트 해시와 engine/revision, `rhwp.js`와 WASM의 실제 SHA-256이 모두 맞아야 한다.
Python 실행기는 문서 생성기를 부르기 전에 검사하고, Node helper는 검사 후에만 dynamic import와
WASM 초기화를 수행한다. 검증한 WASM 버퍼를 그대로 초기화에 사용한다. 불일치/누락은 문서 생성·저장·
성공 증거 쓰기 전에 실패하며 bypass나 대체 엔진은 없다. 로컬 파일이 검사와 dynamic import 사이에서
동시에 바뀌지 않는 실행 환경을 전제로 하며 원자적 파일시스템 인증/서명을 주장하지 않는다.
일반 Rust 골든 검사는 이 선택적 엔진 검사나 RHWP checkout을 요구하지 않는다.

```sh
node tests/integration/rhwp/production-identity.mjs
node --test tests/integration/rhwp/production-identity.test.mjs
python3 tests/integration/rhwp/formcharpr_save.py
```

음성 시험은 격리 파일에서 실제 preflight/load/helper/Python 실행기 경계를 호출한다. 일부 시험은
WASM 검사까지 도달하도록 격리된 test-only JS sentinel의 해시만 허용하고, import/init/document/success
표지가 생기지 않는지 확인한다. 이것을 생산용 대체 아티팩트 승인으로 해석하지 않는다.


### T009 XML 메모리 부분 개선

UTF-8 borrowing, UTF-16 직접 해독, 작업별 immutable 문자열 공유, 사건열을 보관하지 않는 전체 검증과
header 정의 visitor를 적용했다. canonical 값/정확한 charPr·formCharPr 판정은 유지한다.
직접 계상되는 retained payload와 별도 검토용 finite admission API의 범위 및 미승인 호환성 정책은
[t009-xml-memory-accounting.md](t009-xml-memory-accounting.md)에 명시한다.
현재 제품에 유한 예산을 활성화하지 않았고 전체 OOM 안전성/전체 RSS cap은 아직 보장하지 않는다.


### 2026-11-02 사용자 확장 속성 보존 (T009 부분 개선)

기준 HEAD `0a3ba9a` 위의 작업 트리에서 Linux 게시 경로를 개선했다. 원본의 `user.*` 확장 속성만
확인된 임시 파일 fd에 복사하고 fsync한 뒤, 기존 `Attached` 전체 동일성 검사를 그대로 수행한다.
빈 값·바이너리 값도 그대로 복사한다. 원본에는 쓰지 않는다. ACL·보안 속성·inode 플래그의 거부,
저장 중 원본 변경/권한/링크 검사, 내용 보존 판정과 재열기 조건은 유지한다.

기존 WordCraft 기본 한글/표 DOCX 생성기를 사용한 실제 엔진 회귀에서 확장 속성을 가진 문서의
두 차례 편집→저장→재열기, 전체 메타데이터·모델 동일성, revision·dirty·durable, 임시 파일 정리를 확인했다.
복사 호출만 제외한 전 대조에서는 `SaveUnsupported { reason: Metadata }`로 실패했고,
복원한 동일 시험은 통과했다. 잘못된 대상 fd로 복사가 실패할 때 원본/대상 내용·메타데이터 보존도 확인했다.

검증: 저장 서비스 93 passed / 0 failed / 11 ignored, 새 왕복 전 FAIL·후 PASS,
보호 wrapper의 fmt 검사 통과. Rust는 설치된 1.99.1을 사용했으며 1.99.0은 검증하지 않았다.
기본 rootless 빌드 샌드박스의 `/` 소유자가 UID 65534여서 저장 시험은 `shared-directory`로 거부된다.
따라서 컴파일은 기존 보호 wrapper로 하고, 생성한 시험 실행 파일을 UID 1000 호스트 환경에서 실행했다.
제품의 경로 신뢰 검사를 완화하지 않았다. 로그는 로컬 `target/rhwp-wasm/seven-priorities-*.log`에 있다.
11개 무시 시험은 기존의 명시 실행 자원·대규모 입력·다중 사용자/코퍼스 탐침이며 이번 통과 수에 포함하지 않는다.

이번 개선은 파일 메타데이터 때문에 거부되던 DOCX 사례의 지원 확대다. HWP/HWPX 실제 코퍼스의 저장 성공률
확대를 증명하지 않으며 T009 전체 완료나 한컴/Word 호환성 인증을 뜻하지 않는다. 남은 형식별 경계:

| 형식 | 현재 차단과 다음 필요한 근거 |
|---|---|
| HWP | `PrvText`/`PrvImage`의 편집 전 내용 잔존은 계속 `previewStale`. 레코드·보호/미지원 구조 검사 유지. 고정 RHWP `serializer/cfb_writer.rs::supplement_preview`가 편집 모델만으로 미리보기를 재생성하고, geul이 그 출처와 내용을 독립 검증할 수 있는 좁은 upstream API가 필요하다. |
| HWPX | XML 요소/속성 차이·누락/추가 패키지 부분·구역 변화와 알 수 없는 구조는 기존 비교/무결성 규칙을 따른다. `serializer/hwpx/mod.rs`의 원본 Preview 재사용은 해결되지 않았다. 편집된 모델 기반 Preview 생성과 검증 경계가 필요하다. |
| DOCX | WordCraft가 버리는 알 수 없는 요소/속성·custom XML/부분·관계/내용 형식·썸네일은 기존 사전/저장 검사가 계속 차단한다. 원본 부분을 재삽입하기 전, 편집 모델과 무관함 및 관계/식별자 일관성을 증명해야 한다. 이번 변경은 패키지 부분을 재삽입하지 않는다. |

세 형식의 대표 실제 파일 코퍼스, 현재 네이티브 UI/IME와 통합한 저장·재열기 검증은 별도 남은 조건이다.


실제 소형 upstream 표본 후속(2026-11-02, 기준 `cedc7d6`): 검증한 Release generation
`ca284e06…`(WASM `3f99a74…`)으로 HWP5 2개·HWPX 2개를 검사했다. HWP는 둘 다 무편집 사전 검사와
편집 후 형식/쪽/글/컨트롤 재열기 비교가 통과했으나, `DocInfo`의 `recordsChanged`와
`PrvText`/`PrvImage`의 `previewStale`로 편집 저장을 거부했다. HWPX는 둘 다 무편집 출력의
부분 추가/변경과 편집 재열기의 `controlsEqual=false`가 확인되어 저장을 거부했다.
모든 입력 SHA-256은 실행 전후 동일했다. 이 4개는 전체 성공률의 추정치가 아니다.
별도 `geul-tests/reports/seven-phases-20261102/phase2/`에 입력/엔진 신원과 원자료를 보관한다.
실제 DOCX 표본은 이번 검색에서 찾지 못했으므로 생성 픽스처 시험을 실제 코퍼스 수락으로 대체하지 않는다.
`public/rhwp`는 Debug/Release generation 보관소이므로 패키지 전용 `--verify-product`의
단일-generation 조건을 적용하지 않는다. 선택된 Release는 `readRhwpGeneration`과 기존 생산 identity helper로 검증했다.


### 기본 파일 작업 UI (2026-11-02)

Linux Tauri 창을 부모로 하는 GTK FileChooserNative를 연결했다. 이미 Tauri에 포함된 고정 GTK0.18.2를
직접 참조하며 새로운 패키지나 생산 엔진 산출물을 설치/변경하지 않았다. 열기 취소는 세션/선택을 바꾸지 않는다.
새 문서는 실제 WordCraft 빈 모델을 DOCX로 직렬화·재열기 검사한 뒤 사용자가 선택한 새 경로에 게시하고
세션을 등록한다. 이미 디스크에 만든 빈 문서이므로 정상 내구성 확인 시 revision0/clean으로 시작한다.
내구성 미확인은 dirty로 남긴다. HWP/HWPX 새 문서 생성은 제공하지 않는다.

Save As는 원본 형식·사전 검사·손실/패키지/재열기·원본 변경·세션 판 검사를 유지한다. 임시 소유 anchor를
이용해 기존 stage 검증을 재사용하고, `renameat2(RENAME_NOREPLACE)`로 새 목적지에만 게시한다.
기존 파일/심볼릭 링크는 확인 대화상자 선택과 관계없이 덮어쓰지 않는다. 원본 메타데이터도 기존 동일성 조건을
지켜야 한다. 성공하면 같은 세션의 파일 식별자·이름을 바꾸고 이후 일반 저장은 그 새 파일에 적용한다.
실패/취소는 원본·목적지·dirty 편집을 보존한다. 새 Open/New/Save As는 리본·단축키·편집 도구에서 같은 흐름을 쓴다.

검증: 저장 서비스95PASS/11ignored, 관련 프런트엔드73PASS 및 세션15PASS, 최종 busy 수명 수정 후
workspace8PASS; 타입 검사/ESLint/프런트엔드 빌드 통과. 현재 소스의 native debug 호스트에서 실제
Xvfb/GTK 선택기·WebDriver/xdotool로 취소, 새 DOCX, 편집, Save As, 같은 세션 유지, 후속 일반 저장,
목적지 충돌/dirty 보존, 닫기·native 재열기/본문 보존, 원본 불변9개 항목을 확인했다.
원자료는 별도 `geul-tests/reports/seven-phases-20261102/phase4/attempt2/`에 있다.
첫 자동화 실행은 GTK basename 선택 상태 때문에 `.docx.docx`를 입력해 기대 파일명 검사가 실패했다.
입력 전 전체 선택으로 시험기를 수정한 재실행은 통과했다. 생산 코드나 수락 문턱을 바꾸지 않았다.
Windows/macOS 네이티브 대화상자와 저장은 미지원/미검증이며, 실제 IME 수락과 세 형식의 일반 호환성 확대를 뜻하지 않는다.


### 강제 종료 복구의 제한된 지원 (2026-11-02)

원본 자동 덮어쓰기와 복구 기록을 분리했다. Tauri 앱 로컬 데이터의 `recovery/`는 소유자 전용0700,
기록은0600이다. 원본/의도한 목적지 경로, 원본 내용 SHA-256, 세션 시도·revision·형식·생성 시각,
본문 SHA-256을 헤더에 넣고 헤더 자체도 SHA-256으로 검사한다. 이름만으로 임시 파일을 신뢰하지 않는다.
루트의 신뢰 가능한 상위 경로와 파일 소유/권한/일반 파일/단일 링크/크기·형식을 확인하고 심볼릭 링크를 따라가지 않는다.

`.pending`을 배타 생성→헤더/본문 쓰기→파일 fsync→검증→원자 rename→디렉터리 fsync로 게시한다.
진행 중 쓰기는 디렉터리 flock으로 목록/복원과 분리한다. 원본/저장 목적지/기존 파일은 복원 대상으로 쓰지 않으며,
사용자가 고른 **새 경로**에만 NOREPLACE 게시한다. 원본이 없어지거나 외부 수정됐어도 원본에는 쓰지 않는다.
유효·30일 초과·손상 후보를 구분하며, 손상 후보는 복원 불가다. 오래된/불완전 기록은 자동 삭제하지 않는다.
복원 성공으로 후보를 소비하지 않아 재시도가 가능하고, 명시적 확인 후 폐기한다.
복원은 Rust `recovery_restore`가 새 경로를 게시한 뒤 프런트엔드가 별도 `document_open`으로 연다(2026-11-04 안정화).
게시 뒤 열기가 실패하면 파일만 남고 세션은 없으므로 원래 열기 오류를 `cause`로 담은 `RestoredUnopened`로 알린다.
이 결과는 게시 안내로 세어 대기 중인 창 닫기 결정을 무효화한다. 게시 파일과 후보는 지우지 않는다.

한 기록 본문32MiB·전체256MiB·128항목 상한과 인스턴스 간 quota 잠금을 적용했다. 가득 차거나 기록이
손상/읽기 불가이면 새 체크포인트는 실패로 표시하고 기존 후보와 dirty 모델은 보존한다. 안전한 명시 저장의
기존 보존 조건은 그대로이며, 복구 실패가 unsafe 출력을 허용하지 않는다. 확실하게 게시한 저장은 해당 세션의
저장 판 이하 복구 기록을 정리한다. 탭의 명시적 폐기는 성공한 닫기 뒤에만 이 실행의 기록을 폐기하고,
늦은 체크포인트가 닫힌 세션의 기록을 다시 만들지 못하게 한다. 과거 실행의 복구 후보는 목록에서 별도로 폐기한다.
창의 모델 폐기와 과거 비공개 복구 기록의 폐기를 혼동하지 않는다.

미저장 편집의 자동 복구는 현재 DOCX만 지원한다. 확정·ready·dirty이고 pending/IME/저장 중이 아닌 판을
2초 안정화 후 동일한 사전/출력/재열기 검사로 기록한다. 탭 간 export는 직렬화하며, 순서가 왔을 때 상태를 다시 확인한다.
체크포인트는 `finish_save`를 호출하지 않고 dirty/원본/revision을 바꾸지 않는다. UI는 대기/진행/보호한 판/실패를
구분한다. 저장 중 추가 편집도 가드 해제 후 다시 예약한다. RHWP 미저장 WASM 모델 복구는 미지원이며,
모든 형식의 중단된 저장은 정상 저장 검사가 통과해 별도 복구 기록까지 게시한 경우에만 복구할 수 있다.

검증: 현재 보호 빌드의 서비스101PASS/12ignored(별도 child helper 포함), strict clippy(lib/bins) 통과.
실제 자식 프로세스를 저장 AFTER_STAGE에서 SIGKILL하고 새 Store 인스턴스로 편집 DOCX 후보를 탐지·복원했다.
손상 헤더/본문·꼬리 바이트·심볼릭 링크·경로 이탈·stale 원본·기존 목적지·반복 복원·저장 공간 상한을 시험했다.
프런트엔드 집중42PASS와 최종 workspace13PASS, 타입/린트/빌드 통과(각 검사 당시 소스에 대한 결과).
실제 앱에서도 미저장 DOCX의 체크포인트를 UI로 확인한 뒤 앱 PID에 SIGKILL을 보내고, 같은 데이터 디렉터리로
재시작하여 후보 탐지·손상 후보 차단·네이티브 새 파일 복원·본문/원본 보존·명시적 폐기12항목을 확인했다.
원자료는 별도 `geul-tests/reports/seven-phases-20261102/phase5/`와 로컬 `seven-phase5-services-final.log`에 있다.

남음: 첫 기록 전/마지막 기록 뒤 입력은 복구되지 않을 수 있고 미확정 IME는 포함하지 않는다. 엔진 보존 검사가
통과하지 않는 문서는 기록할 수 없다. 검증된 별도 기록 없는 `.geul-save-*.tmp`는 복원 후보로 쓰지 않으며
원본 옆 잔여 임시 파일의 일반 정리는 여전히 미구현이다. 전원 차단/파일시스템 고장·Windows/macOS와
RHWP 미저장 편집은 검증하지 않았다. 이 제한된 복구 구현으로 T014 전체 완료를 표시하지 않는다.


## 파일·복구 실패 경계 독립 교정 (2026-11-02)

기준 `a033309`의 우려를 코드와 실제 파일 경계 회귀로 확인했다. 원본 교체/보존 판정·NOREPLACE는 약화하지 않았다.

| 우려 | 판정·교정 | 실패 경계 근거 |
|---|---|---|
| A pending 재시도 | CONFIRMED. 같은 ID의 create_new 충돌. partial/기존 유효 사본을 보존하고 새 ID로 재시도; 소유한 모든 ID를 기억해 명시적 세션 정리 가능 | partial pending 생성 뒤 재시도·기존 사본 보존·전체 forget; 기존 동작 FAIL → 수정 PASS |
| B 복원 내구성 | CONFIRMED. 게시 후 durable=false를 보통 SaveFailure로 반환 | 실제 rename 뒤 DirSync 주입: FilePublishedUnconfirmed, 대상/원본/후보 보존, 같은 대상 재시도는 충돌; 기존 동작 FAIL → 수정 PASS |
| C 신규 DOCX 등록 | CONFIRMED. 게시 뒤 세션 수 제한에 걸리면 단순 ResourceLimit | 실제 max_sessions=0 등록: FilePublishedUnregistered, 파일 존재·실제 WordCraft 재열기·중복 덮어쓰기 차단; 기존 동작 FAIL → 수정 PASS |
| D 삭제 오류 | 직접 recovery_discard는 DISPROVED(원래 오류 반환). forget_session은 CONFIRMED(오류 무시 후 성공 응답) | unlink 불가 디렉터리 항목: 세션 정리도 오류 반환, tombstone은 유지해 늦은 체크포인트 차단; 기존 동작 FAIL → 수정 PASS |
| E Linux 역슬래시 | CONFIRMED. frontend basename 검사가 유효한 역슬래시 이름 때문에 전체 목록을 거부 | IPC 후보 목록 회귀 기존 동작 FAIL → 수정 PASS; 슬래시/NUL은 계속 거부 |

두 FilePublished 오류는 이미 대상 파일이 있다는 고정 안내이며 일반적인 미게시 오류와 다르다.
경로/문서 내용은 오류에 추가하지 않는다. 등록 실패 시 파일을 자동 삭제하지 않고 사용자가 확인해 직접 열도록 안내한다.
복원 내구성 미확인은 후보도 유지하며 fsync 성공을 주장하지 않는다. 세션 close 성공과 복구 정리 성공은 별개다.
프런트엔드는 close 후 best-effort 정리 실패로 이미 닫힌 문서를 되살리거나 close를 되풀이하지 않으며,
남은 후보는 복구 센터에서 명시적으로 확인/삭제할 수 있다.

Rust 회귀 4개는 수정 전 동작으로 각각 실패(exit101)하고 교정 후 services 105 PASS(12 ignored)다.
실제 SIGKILL/restart·저장/원본 보존을 포함한 기존 services 범위를 재사용했다. frontend 역슬래시 음성/양성 경계도 확인했다.
비공개 전후 로그: `geul-tests/reports/phase6-phase7-20261102/`. 새 API/실패 주입은 보호 엔진·WASM을 바꾸지 않는다.

### 다른 이름으로 저장 뒤 복구 ID 재사용 교정 (2026-11-02)

CONFIRMED: 복구 ID는 `(세션, 불러오기 시도)`로만 추적됐다. 다른 이름으로 저장이 게시됐지만 디렉터리 fsync를
확인하지 못하면(durable=false) 시도 번호는 그대로이고 세션의 원본 경로만 새 파일로 바뀌며, 이전 원본 경로의 후보는
보존된다. 다음 체크포인트가 그 ID를 다시 쓰면 `put`의 기존 헤더 원본 경로 검사가 거부해 새 원본의 체크포인트가
항상 `SaveFailure`였다(실제 DOCX·저장 서비스·DirSync 주입 회귀가 교정 전 FAIL).

교정: 소유 ID마다 헤더에 기록한 원본 경로를 함께 기억하고 원본 경로가 바뀌면 새 불투명 ID를 쓴다(아래 교정 뒤로는
모든 체크포인트가 새 ID다). 원본 경로는 기존 기록을 대체·정리할 수 있는지 가르는 조건이라 그 계약만 따랐다.
`put`의 헤더 검사·create-only 복원·NOREPLACE·저장 공간 상한은 그대로이고, 이전 원본의 후보와 새 원본의 후보는 각각
복원할 수 있다. `saved`와 명시적 세션 정리는 같은 시도의 모든 소유 ID를 다루며, 정리 실패는 오류로 보고되고
tombstone은 유지된다.

### 체크포인트 교체 중 디렉터리 fsync 실패 교정 (2026-11-02)

CONFIRMED: 같은 원본의 다음 체크포인트가 같은 ID로 `.pending`→`.recovery` rename을 해 이전 기록을 덮었고, 그 뒤
디렉터리 fsync가 실패하면 "체크포인트 실패, 이전 후보 보존"으로 보고하지만 이전 판 기록은 이미 새 판으로 바뀌어
있었다(복구 전용 시험 주입 `RecoveryFault::PublishDirSync`로 rename 직후 실패: 이전 ID의 revision 1→2, 교정 전 FAIL).

교정: 모든 체크포인트는 새 불투명 ID로 쓰고 `.pending` 쓰기·fsync·검증 뒤 `renameat2(RENAME_NOREPLACE)`로만 게시한다
(기존 기록은 유효·손상·외부 것 모두 덮지 않음). 디렉터리 fsync가 성공한 뒤에만 같은 원본·같은 시도·revision이 새 것
이하인 이전 기록을 지운다(`retire`, 읽을 수 없는 기록과 `.pending`은 남김). fsync가 실패하면 오류를 돌려주고 이전
known-good 후보와 내구성을 확인하지 못한 새 후보가 모두 남는다. 디렉터리 항목의 내구성은 파일에 기록할 수 없으므로
새 후보가 "확인되지 않음"이라는 것은 실패한 체크포인트 결과로만 알린다. 어느 쪽이 남든 헤더·본문 해시 검증을 통과한
것만 유효 후보다. 다음 성공한 체크포인트나 확실한 저장(`saved`)·명시적 정리가 두 기록을 모두 다룬다. 남긴 것 없이
실패한 ID만 소유 목록에서 빼고, 정리된 ID도 빼서 긴 세션에서 목록이 커지지 않는다. 상한(128항목·256MiB)은 쓰기 전에
검사하므로 가득 차면 아무것도 바꾸지 않고 실패한다(교체 중 일시적으로 기록 하나가 더 있음).
남은 한계: 실제 전원 차단·커널 파일시스템 오류 뒤의 상태는 시험하지 않았다(시험 주입은 반환 경로와 실제 파일 상태만 확인).

정리(retire)의 디렉터리 fsync 실패(2026-11-02 후속): 이전에는 결과를 버리고 지운 ID를 소유 목록에서 빼서 정리가
내구적으로 끝난 것처럼 다뤘다(`RecoveryFault::RetireDirSync` 회귀, 교정 전 FAIL). 이제 새 체크포인트 게시는 성공으로
남기고(이미 fsync 확인됨), 지운 이전 기록 ID를 "확인되지 않은 정리"로 기억해 계속 소유한다. 다음 게시의 디렉터리 fsync,
`saved`의 최선 노력 확인, `forget_session`의 확인 fsync가 성공해야 해제되며, `forget_session`은 확인하지 못하면 오류를
돌려준다(tombstone 유지). 읽을 수 없는·외부 기록과 `.pending`은 정리하지 않는다. 같은 디렉터리의 fsync는 앞선 항목 변경도
함께 내구화한다는 Linux 의미에 기대며, 새 프로세스는 현재 파일 상태만 보므로 이미 사라진 이름이 내구적으로 지워졌는지 알 수
없다. 실제 중단 뒤 이전 기록이 다시 보이면 일반 후보처럼 검증·표시되고 명시적으로 폐기할 수 있다(되살아난다고 약속하지 않음).

## HWP 글 미리보기 재생성 (2026-11-02, Stage 1)

고정 rhwp `1a76570`의 `serializer/cfb_writer.rs::supplement_preview`는 비어 있지 않은 원본 `PrvText`와 `PrvImage`를
그대로 쓴다. 한·영 문단·굵게·2×2 표 문서를 WASM으로 만들고 첫 문단을 삭제·교체하면, 손실 보고 0건·본문 재열기 동등에도
이전 구현은 `PreviewStale`로 거부했다. 이 절 앞의 "편집한 HWP 저장이 막힘"은 그 이전 구현의 기록이다.

현재 geul은 엔진 출력의 유일한 차단 근거가 `PrvText`의 낡음/변경일 때, 검증된 출력 레코드에서 앞 1000 **유니코드 문자**의
미리보기를 UTF-16LE로 재생성한다. 구역은 숫자 순서, 본문 문단만 사용하고 표·글상자의 중첩 문단은 제외한다. 지원하는 제어코드는
구역/단 정의·표/그림 자리·탭·줄 끝·문단 끝·소프트 하이픈·묶음/고정폭 빈칸이다. 모르는 제어코드·잘린 슬롯·잘못된 UTF-16이면
재생성하지 않고 원래 거부를 유지한다. 문서가 비면 비어 있는 미리보기가 본문으로부터 계산된다. 임의 미리보기를 빈 상수로 바꾸지 않는다.

`PrvImage`는 변경하지 않는다. 기존 상수 외에 고정 엔진의 `parser/hwpx/blank2010_assets/prvimage.bin` 전체 바이트와 같은 경우만
문서와 무관한 것으로 인정한다(5126바이트, SHA-256 `2103d51fb863769afce086d2aa45eda343808e1c478527a9d40b3dfbebe513c6`).
이 자산은 문서 입력 없이 사용하는 흰색 724×1024 RGBA PNG이며 PNG CRC와 압축 해제를 확인했다. 다른 그림은 한 색이어도 계속 차단한다.

미리보기 교체에는 새 CFB를 사용해 이전 미리보기의 할당 해제 영역·슬랙을 복사하지 않는다. 출력의 다른 스트림·저장소·CLSID·상태 비트·시간은
그대로 옮긴다. 최종 비교는 변경된 `PrvText`가 출력 본문에서 계산한 값과 정확히 같은지 확인한다. 원본 사전 검사, 암호/DRM/헤더 제한,
레코드·참조·손실·재열기 검사, 원본 충돌 감지, 임시 파일 검증·원자 교체·디렉터리 fsync는 그대로 필수다. 서브모듈/gitlink/WASM은 변경하지 않았다.

회귀 검증: `hwp_save_regenerates_text_preview_without_retaining_old_stream_bytes`,
`hwp_preview_refresh_rejects_unknown_controls_and_preserves_other_streams`,
`hwp_preview_refresh_supports_repeat_saves_and_unchanged_current_prefix`.
실제 엔진 검증은 `scripts/tests/hwp-preview-roundtrip.mjs <output-directory> <compiled-lib-test-executable>`로 재현한다.
보호 빌드 `python3 scripts/cargo-geul.py test --lib --no-run`이 출력한 실행파일 경로를 사용한다. 기존 외부 테스트 디렉터리의
`tests/fixtures/rhwp/generate.mjs`가 필요하다. 원래 문장 삭제→한글·이모지 교체→WASM export/reopen→geul 실제 저장 서비스→게시 파일
WASM 재열기에서 본문·쪽·컨트롤·굵게·표 텍스트를 비교하고, 삭제한 미리보기의 UTF-16 바이트 부재와 거절 시 원본 보존을 검사한다.
네이티브 IME→앱 저장의 SC-002 전체 수용은 별도 Stage 4이며 이 엔진/서비스 검증만으로 인정하지 않는다.


## 세 형식 통합 저장 수용 (2026-11-02, Stage 4)

**SC-002: 아래 세 대표 지원 문서 범위 PASS. T009 전체는 선행 T007/T008 수용·플랫폼 근거가 남아 미체크.**
`574b3af`의 실제 Tauri debug 앱과 고정 Release rhwp WASM을 Xvfb/X11 + IBus 한글 입력 환경에서 검증했다.
원본 문서는 실행 시 생성한 한·영 문단·굵게·2×2 표다. 이 샘플에는 그림이 없으므로 그림 개체 보존 범위는 새로 입증하지 않았다.

| 형식 | 실제 흐름 | 게시 파일의 비교 | 결과 |
|---|---|---|---|
| HWP | 화면 preedit→정확한 한글 확정→safe 사전 검사→저장→동일 세션에서 다시 입력/저장→닫기→앱 재열기 | WASM으로 원본과 본문 문단·컨트롤·쪽·표 4셀·굵게 비교. 두 번째 저장 revision18·dirty=false·synced=true. CFB 9개 스트림, PrvText156바이트가 재열기 본문에서 독립 계산한 값과 같음; PrvImage5126바이트는 고정 blank2010 자산과 완전히 같음 | PASS |
| HWPX | 화면 preedit→정확한 한글 확정→safe 사전 검사→저장→닫기→앱 재열기 | WASM으로 원본과 본문 문단·컨트롤·쪽·표 4셀·굵게 비교, revision9·dirty=false·synced=true. 최종 저장 서비스의 패키지·XML·참조·미리보기 검사도 필수 | PASS |
| DOCX | 화면 겹침 preedit(본문 모델 그대로)→한글 확정→safe 사전 검사→저장→닫기→앱 재열기 | 메모리 왕복의 모델/텍스트/쪽 일치, 실제 재열기 글자 일치, 원본과 표 XML·편집하지 않은 문단 XML·패키지 항목 집합 일치. revision9·dirty=false·synced=true | PASS |

`scripts/tests/native-save-roundtrip.py`가 실제 UI의 사전 검사·저장 결과와 백엔드 세션 revision/dirty를 확인한다. 앱의
저장 검증은 그대로 실행되며 테스트가 safe 판정을 주입하지 않는다. 잘못된 참조/불완전 출력의 **음성 시험 두 개만** 실제 IPC에
결함 출력을 직접 보낸다(엔진이 그 바이트를 출력했다고 주장하지 않는다).

거절 9개를 검증했다: HWP/HWPX/DOCX 각 외부 수정 충돌(`FileConflict`), HWPX 낡은 글 미리보기(`PreviewStale`), 알 수 없는
header 속성 소실(`PartChanged`), 없는 글자 모양 참조(`ReferenceInvalid`), 잘린 직렬화 출력(`OutputMalformed`),
DOCX customXml 소실(`PartMissing`), 잘린 본문 XML(`OriginalMalformed`, unknown). 모두 거절 뒤 파일 해시가 그대로다.
UI 저장 경로의 7개는 실패 이유·미보존 상태를 확인했다. 직접 IPC 시험 2개는 백엔드 거절·원본 해시·dirty 유지와
UI가 saved로 바뀌지 않음을 확인했다(UI는 idle). 이를 UI 오류 표시 시험으로 바꿔 보고하지 않는다.

저장 회귀 100개(12 ignored)의 임시 파일 검증·원본 충돌·원자 교체·내구성 오류·참조·보호 형식·손실 보고 검사를 재사용했다.
기존 recovery 저장소 회귀 19개 PASS/1 ignored helper도 실행했다. 별도 전원 차단·T014 전체 수용·다른 OS의 원자 교체는 시험하지 않았다.
Stage 1의 삭제/교체 사례에서 예전 미리보기 UTF-16 바이트가 새 CFB 전체에 없는 것도 확인했다. 물리 매체의 포렌식 삭제는 범위 밖이다.

검증 증거는 [공개 요약 JSON](save-roundtrip-acceptance-2026-11-02.json)에 있다. 최종 HWP는 `stage4-run6`, HWPX/DOCX는
`stage4-run5 --formats hwpx docx`의 결과를 결합했다. 하나의 전체 실행이 통과했다고 주장하지 않는다. 앱 SHA-256 및 WASM은
두 실행에서 같다. 이전 실패도 `target/four-stage/`에 보존했다: IBus 설정 오류, 불필요한 invoke 관찰 실패, 테스트 변형이 XML
접두사를 바꿔 발생한 미선언 접두사 출력 등이다. 마지막 변형은 SAX로 원래 이름공간을 유지해 원래 의도한 속성 소실 차단을 확인했다.
IBus 전역 선택 명령은 `setxkbmap` 부재로 exit1이었지만 각 입력의 실제 화면 preedit·정확한 확정·revision은 필수 단언으로 통과했다.

재현에는 기존 외부 `tests/`와 생성 픽스처, X11/IBus 한글 입력 환경, 실행 중인 Vite 검사 호스트, 최신 debug 앱과 tauri-driver가 필요하다.
새 도구·OS·데스크톱은 설치하지 않았다. 기본 `--formats`는 세 형식 모두이며 영향 범위 재검증만 선택할 수 있다.
`native_hwp_published_preview_matches_reopened_body`는 게시 HWP와 독립 WASM 기대 미리보기를 실제 CFB 스트림으로 대조하는 선택적 통합 시험이다.

### 외부 HWPX 보존 확대의 미완료 범위

이번 Stage 2는 **INCOMPLETE, 생산용 수정/완료 커밋 없음**이다. 고정 엔진의 외부 샘플 7개를 같은 WASM으로 검사했고 모두
보존 사전 검사에서 unsafe였다. `saved/blank_hwpx.hwpx`, `03-blank_hwpx.hwpx`, `hwpx-01-saved.hwpx`,
`samples/종이기준.hwpx`, `셀보호.hwpx`, `누름틀-2024.hwpx`, `issue5590_per_row_column_widths.hwpx`를 선택했다.
과거 3/60 결과를 현재 전체 호환률로 인용하지 않는다.

| 분류 | 이번 관찰 | 발생 경계·현재 처리 |
|---|---|---|
| 무해할 수 있는 정규화 | 선언·접두사·속성 순서 | 기존 XML canonical 비교가 이미 구분한다. 이번에 comparator를 완화하지 않음 |
| 속성 변경/소실 | 문단 ID 재번호, `textDir=LTR` 소실, 구역 tabStop 기본 속성 추가 | parser/IR 및 header/section writer; 의미·참조를 증명한 보존 수정은 미구현 |
| 요소/모양 | 글자 모양 기본 자식 추가와 header/body 구조 차이 | IR 기반 재생성. 손실 보고 0건으로 원본 보존을 인정하지 않음 |
| metadata/관계 | content.hpf의 `linear=yes` 추가, 다중 구역 RDF 재구성, 일부 최소 샘플의 패키지 항목 추가 | package 조립. 원본 부분을 무조건 덮어 씌우지 않음 |
| 알 수 없는 XML | 속성 소실 차단 확인; 접두사 변경 시 원본 raw fragment가 미선언 접두사로 출력될 수 있음 | 범용 원본 XML 보존 경로 없음; 잘못된 출력은 계속 차단 |
| 미리보기/자원 | Preview aux는 그대로 복사; 확인할 수 없는 미리보기/참조는 차단 | 새 임의 HWPX 지원을 선언하지 않음. 외부 그림/BinData 보존 확대 미검증 |

다음 구현은 원본 XML 정보의 IR 보존과 문단/모양 ID·구역 관계의 편집 후 무결성을 좁은 외부 사례에서 증명해야 한다.
로컬 미공개 서브모듈 커밋을 gitlink로 만들지 않았으며, 검사 결과를 개선하려고 unknown/unsafe를 safe로 바꾸지 않았다.


### HWP 미리보기 안정화 (2026-11-02 후속)

저장은 원본 파일 신원·해시 → 공통 사전 검사 판정 → 손실 보고·raw export 재열기 근거 → 필요한 경우 PrvText 재생성 → **실제 최종 바이트** 검사 → 임시 파일 검증·충돌 재확인·원자 게시 순서다. 보존 근거가 없는 요청에서는 CFB 재구성을 시작하지 않는다. `validate_snapshot`과 같은 근거 검사 함수를 사용하며 unsafe/unknown은 계속 거부한다.

프런트엔드 `exportAndCompare`의 재열기 근거는 raw 엔진 출력에 대한 것이다. 최종 CFB는 별도로 다시 열어 버전, 전체 엔트리 경로/종류/개수, CLSID, 상태 비트, 생성·수정 시각과 모든 스트림 길이·바이트를 검사한다. 유일한 허용 차이는 본문에서 생성한 PrvText다. 본문/DocInfo/표/참조가 raw export와 바이트 동일하다는 불변식으로 재열기 근거를 연결한다. 섹터 배치와 빈 공간은 새 컨테이너를 만들면서 바뀐다. 이전 미리보기의 free/slack 바이트를 복사하지 않는다. 이후 최종 보존 검사도 반드시 통과해야 한다.

미리보기 텍스트는 문단별 UTF-16 Vec와 전체 String을 만들지 않고 스트림의 코드 단위를 읽으며 최대 1000 Unicode scalar만 누적한다. 문자 수는 상수 시간 카운터로 관리한다. 보조 평면 문자는 한 문자로 계산한다. 접두부가 찬 뒤에도 전체 레코드·컨트롤·UTF-16 surrogate를 검사한다. 시간은 전체 본문 크기에 선형이며 텍스트 누적 메모리는 1000문자로 제한된다. 압축 해제와 전체 레코드/참조 검사 및 반복 파싱은 유지하며, 전체 저장이 상수 메모리가 되었다고 주장하지 않는다.

추가 회귀는 부적격 요청의 재구성 호출 0회, 압축된 큰 문단의 접두부 뒤 미지원 컨트롤 거절, 빈 문단·여러 구역 순서와 CFB 메타데이터/빈 저장소 보존을 확인한다. 실제 WASM 통합은 한글·emoji 교체, 표·굵게, 최종 게시 파일 재열기와 삭제 미리보기 바이트 부재를 검증한다.

검증 결과: 저장 서비스 101 PASS / 13 선택적 ignored, protected fmt·clippy(`--lib --tests -- -D warnings`) PASS. 수정된 WASM probe를 새 디렉터리 `target/four-stage/stage1-fresh-evidence`에서 실행해 PASS. 새 probe는 이번 raw export의 재열기 비교를 `reopen.json`에 직접 기록한다. 큰 문단 회귀는 한글+emoji 200,000문자(UTF-16 300,000단위) 및 미지원 suffix를 사용한다. 초기 큰 문서 시험 실패는 합성 레코드 도우미의 extended length 누락으로 확인·수정했으며 제품의 검사 기준은 바꾸지 않았다.

### 외부 HWPX 좁은 지원 사례의 후속 수용 (2026-11-02)

위 「외부 HWPX 보존 확대의 미완료 범위」는 이전 조사 당시의 상태다. 후속 구현은 `종이기준.hwpx` 한 사례의 명시적 LTR·문단 ID·세 heading switch를 고정 rhwp 패치로 보존한다. 편집 전 preflight는 `unsafe`(header/section 변경)에서 `safe`(findings 0)로 바뀌었고, comparator는 수정하지 않았다. 제품 Release WASM은 패치/소스 fingerprint를 포함한 schema 3 신원으로 빌드됐다.

실제 앱에서는 편집 뒤 원본의 빈 `PrvImage.png` 때문에 처음에 `previewStale`가 발생했다. 이 샘플의 빈 본문·CRLF 글 미리보기·724×1024 흰색 PNG를 CRC/압축/전체 바이트로 감사한 후, `preview.rs`에서 그 **정확한 4502바이트**만 문서 독립의 빈 미리보기로 인정한다. 그 밖의 단색 PNG와 임의 미리보기는 계속 거절한다. ZIP 원본 이미지는 재생성하거나 바꾸지 않는다. 실제 IBus 편집→save IPC→게시→닫기·재열기와 XML/문단 ID/관계/다른 부분의 동등성이 통과했고, 중복 ID 음성은 앱에서 저장을 막아 원본 해시를 보존했다. 재현 근거와 남은 범위는 [후속 구현 기록](hwpx-textdir-candidate.md#stage-2-후속-구현수용-2026-11-02)에 있다. 이 사례는 다른 외부 HWPX, 내용 있는 미리보기, 미지원 XML 구조를 자동으로 허용하지 않는다.

### 복구 정리 fsync와 세션 소유권 후속 안정화 (2026-11-02)

retirement fsync 실패 뒤 새 durable 체크포인트의 성공을 유지하는 기존 교정은 그대로다. 후속 재현에서는 `discard`의 성공한 디렉터리 fsync를 소유권 정리에 반영하지 않아 `forget_session`이 불필요한 확인 실패를 보고했고, 다른 세션의 게시 성공은 미확정 집합만 비워 이전 세션의 absent ID를 남겼다. `saved`는 잠금 획득 Result를 검사하지 않았다.

현재 디렉터리 fsync 성공 뒤 공통 reconciliation은 미확정 ID 중 `.pending`과 `.recovery`가 **모두 NotFound로 확인된** ID만 모든 세션/세대의 소유 이력에서 제거한다. 기존 파일·부분 파일·조회 오류가 있는 ID는 유지한다. 새 게시의 fsync는 이전 unlink를 확인하지만, 그 뒤 수행하는 retirement unlink는 별도의 확인이 필요하다. 게시 실패에서는 reconciliation과 이전 후보 retirement를 실행하지 않는다. 전체 디렉터리를 반복 스캔하지 않고 추적한 미확정 ID만 조회한다.

`discard`, `saved`, `forget_session`은 메모리 Mutex → 배타적 DirectoryLock 순서로 실행하며 잠금을 다시 중첩 획득하지 않는다. `saved`의 잠금 실패는 정리와 확인을 시작하지 않고 best effort로 반환한다. 디스크의 유효 체크포인트를 그대로 두며 문서 저장을 실패시키지 않는다. `forget_session`은 먼저 tombstone을 기록하고, 삭제 자체의 실패와 unlink 뒤 fsync 실패를 구별한다. 뒤이은 성공한 discard fsync가 앞선 unlink를 확인하면 별도의 중복 확인은 하지 않는다. 실제 삭제 실패·디렉터리 접근 실패·아직 남은 소유권은 계속 실패로 반환한다. 이후 정리 재시도는 가능하고 늦은 체크포인트는 계속 거부한다.

테스트 seam은 publication/retirement/discard/saved/forget의 디렉터리 fsync를 구분하고, 주입된 실패에서는 실제 fsync를 호출하기 **전에** 반환한다. 시도별 성공/실패를 테스트에서 기록한다. 디렉터리 잠금 실패 주입은 fsync 실패와 독립적이다. 회귀는 성공한 discard 확인의 재사용, 모든 관련 sync 실패와 재시도, A의 retirement 뒤 B 게시, 다른 세대/Save As 소유 이력·유효/손상/부분 파일 보존, 일부 unlink 실패, saved 잠금 실패/재시도와 동시 snapshot/forget을 확인한다. 원본 문서·create-only 복원 계약은 유지한다. 이 검증은 반환 경로와 현재 파일 상태를 확인하며 실제 전원 차단의 물리적 효과를 재현하지 않는다.

검증: 보호 빌드로 컴파일 후 기존 절차에 따라 호스트에서 Rust 실행파일을 실행했다. recovery 26 PASS/1 ignored(하위 프로세스 crash helper), save 102 PASS/13 ignored, protected fmt 및 strict Clippy(`--lib --bins --tests -- -D warnings`) PASS. UI/IME·IPC 명령 형식은 변경하지 않아 네이티브 UI 재검사는 실행하지 않았다.

### 반복된 HWPX 문단 ID 보존 (2026-11-02 후속)

**선택한 결함 한 가지: 엔진이 원본의 반복된 `hp:p@id`를 거부해 내보내기 자체가 실패함.** 앞의 `종이기준.hwpx` 패치는 가져온 문단 ID가 하나라도 겹치면 `ambiguous duplicate HWPX paragraph id`로 직렬화를 거부했다. 그러나 한컴 편집기는 대부분의 문단에 `id="0"`을 반복해 쓴다(`saved/hwpx-01-saved.hwpx` 121개 중 119개, `samples/셀보호.hwpx` 27개 중 26개). 제품 WASM(`e09de18d…`, `bb3bc058…`)으로 고정 `external/rhwp`의 HWPX 734개를 편집 없이 내보내고 같은 `service::preflight`(`save_check`)로 검사하면 safe 78·unsafe 207·unknown 9·**내보내기 실패 440**(그중 430이 이 원인)이었다. 앱에서는 보존 판단 이전에 EngineFailure로 끝난다. 아래 선택 문서는 패치 없는 고정 엔진(`ca284e06…`)에서도 header(`textDir="LTR"` 소실)·section0(ID 재번호) 변경으로 unsafe였고(실측), 앞 패치 뒤에는 내보내기 실패였다. 두 패치가 함께 있어야 보존된다. 안전 판정 완화가 아니라 엔진 쪽 정보 손실(식별자 규칙)을 고친다.

추적 패치 `patches/rhwp/hwpx-duplicate-paragraph-ids.patch`(SHA-256 `79fd8f41c4cabe82b6b0b66265f5a1b3feef08a4c0b07af30cf7f788e11a9787`)를 기존 계열 뒤에 둔다(`scripts/rhwp-patches.py` `SERIES`). 파서가 원본의 ID별 개수를 `Document.hwpx_imported_paragraph_ids`에 기록하고, 직렬화기는 같은 값을 여러 문단에 쓸 때 **각 문단이 서로 다른 식별 셀을 가지며 그 수가 원본의 개수 이하**일 때만 허용한다. 새 문단(분할 등)은 지금처럼 가져온 최대값보다 큰 새 ID, 복사는 기존 clone 재배정으로 현재 쓰이지 않는 ID를 받는다. 따라서 편집이 반복 ID를 새로 만들거나 늘릴 수 없다. 없거나 숫자가 아니거나 범위를 넘는 ID는 계속 내보내기를 거부한다. 같은 패치는 앞 패치가 깨뜨린 rhwp 단위 시험의 구조체 초기화(`cfb_writer/tests.rs`, `doc_info/tests.rs`)만 시험용으로 고친다. geul 판정기·저장 서비스·Rust/TypeScript 소스는 바꾸지 않았다.

| 검증 | 결과 |
|---|---|
| 같은 734개 코퍼스(편집 없음) | safe 78→**98**, unsafe 207→584, unknown 9→9, 내보내기 실패 440→43(textDir `AUTO` 38, 형식 미지원 3, ID 누락 1, 암호 1). 이전에 내보내지던 294개는 출력이 **바이트 동일**, 판정 변화 0. 새 safe 20개는 모두 `samples/issue7418/` |
| rhwp lib 시험 A/B(같은 고정 fixture) | 수정 전 계열 3747 통과/123 실패 → 수정 3754/121. 새 실패 0, 기존 상류 왕복 시험 2개(`task1391_aift_memo_roundtrips`, `issue_1345_picture_effects_shadow_roundtrip`)가 같은 원인으로 실패하던 것이 통과, 새 경계 시험 5개 통과. 남은 121개는 양쪽 모두 실패(추출한 빌드 입력에 없는 상류 샘플 읽기 NotFound) |
| 실제 WASM 생애주기 `scripts/tests/hwpx-duplicate-id-roundtrip.py` | `hwpx-01-saved`의 119×`0`·2×`3121190098`이 무편집·반복 내보내기에서 정확히 같음, 한글·이모지 삽입, 분할 새 ID, `id="0"` 문단 복사가 `0`을 늘리지 않음, 병합 복원. 누락·`bad`·`-1`·범위 초과·빈 ID는 거부 |
| 기존 회귀 | `hwpx-identity-roundtrip.py`(원본 반복 ID는 이제 정확히 보존으로 판정 변경, 누락·무효·범위 초과 거부 유지), `hwpx-textdir-roundtrip.py` PASS |
| 제품 빌드 | 보호 오프라인 빌드 generation `03d2b440f7b28d138b83ce62581cd0d8d8314d0cafacc0cfdafefb6c175f654b`, WASM `d3602624cb9abcf387d081155ae201ba1fdfe38691402ce13f0a56c50a8f931d`(검증한 후보와 바이트 동일). 중간 generation `d374343c…`는 패치의 시험 코드 rustfmt 전 신원으로 `rhwp.js`·`rhwp_bg.wasm`이 최종과 바이트 동일하다(아래 Stage 4·편집 표면 회귀는 그 신원에서 실행). 이전 `e09de18d…`는 되돌림용으로 남김. 보존 한도 때문에 선택되지 않은 세대 두 개(`4b50a52e…` — 같은 바이트가 `ca284e06…`에 있음, `ba61b961…` — 선택된 Debug `0c2faef3…`와 같은 바이트)를 지우지 않고 `target/rhwp-preserved-generations/`로 옮김 |

**새로 지원하는 외부 문서(좁은 사례): `external/rhwp/samples/issue7418/list_marker_head_synthetic.hwpx`** (SHA-256 `d96b5f57…`, 문단 44개 중 43개가 `id="0"`, 글머리표 43개). 이전에는 내보내기 거부, 지금은 편집 전 preflight safe(근거 0)다. `scripts/tests/native-external-hwpx-save.py`로 실제 앱(`e99363b` debug, SHA-256 `26733632…`)·Xvfb/X11·IBus 한글에서 preedit `하`→확정 `한글`→실제 저장(state saved, synced, revision 2, 백엔드 dirty=false)→탭 닫기·재열기를 통과했다. 게시 파일은 독립 검사에서 ZIP·부분 집합·header와 편집하지 않은 XML·문단 ID 44개(반복 42) 순서·빈 미리보기 바이트가 원본과 같고, WASM 모델의 컨트롤·쪽·문단도 같다. 음성: 불러온 뒤 외부 수정은 `FileConflict`(수정된 바이트 그대로), 문단 ID 누락 입력은 EngineFailure(엔진 원인 `HWPX paragraph id missing or invalid`, 입력 그대로), 같은 문서를 **한컴 2024가 다시 저장한** `…-hancom-2024.hwpx`는 편집 전 safe이지만 편집 뒤 저장이 `previewStale`(PrvImage·PrvText)로 거부되고 원본 그대로다. 위 양성·음성과 `종이기준.hwpx` 실제 앱 회귀는 최종 generation `03d2b440…`에서, Stage 4 세 형식 저장(양성 3·거절 9)은 같은 바이트의 `d374343c…`에서 PASS. 기계 판독 근거: [hwpx-duplicate-id-acceptance-2026-11-02.json](hwpx-duplicate-id-acceptance-2026-11-02.json), 원시 결과는 무시되는 `target/hwpx-compat-20261102/`.

한계: 새 safe 20개 중 10개(`*_synthetic.hwpx`)만 빈 미리보기라 편집 저장까지 가능하고, 실제 한컴 저장본 10개(`*-hancom-2024.hwpx`)는 무편집 왕복이 보존될 뿐 편집 저장은 미리보기 때문에 계속 막힌다(HWPX 미리보기 재생성은 미구현). 내보내기가 가능해진 377개는 다른 보존 손실로 여전히 unsafe다. 확인한 주요 원인: `content.hpf` `linear="yes"` 추가, `charPr` 기본 자식(`underline`·`strikeout`·`outline`·`shadow`) 추가, `secPr` `tabStopVal`/`tabStopUnit` 추가, 다중 구역 `container.rdf`·`secCnt` 재구성(`hwpx-01-saved`), 표 셀의 빈 run에 `hp:t` 추가와 끝 빈 `hp:t` 소실(`셀보호`, `누름틀-2024`의 `fieldBegin@zorder`도), `borderFill` 기본 속성·`fieldBegin@dirty` 추가와 `paraPr` 재번호(`간이기안문_서식`), 원본에 없는 Preview/settings/rdf 부분 추가(`issue5590`), 지원하지 않는 `textDir="AUTO"`. 이 결과는 한 문서와 한 식별자 규칙에 대한 근거이며 한컴 HWPX 일반 호환을 뜻하지 않는다. 코퍼스에는 fuzz·생성·합성 문서가 섞여 있다.

### HWPX 문단 ID 할당·독립 XML 검증·spine `linear` 안정화 (2026-11-02 후속)

위 절의 결과(복사 문단 ID `2` 등)는 그 시점의 기록이며 고치지 않는다. 이 절은 그 뒤 확인한 결함과 교정이다. geul 판정기·저장 서비스·Rust/TypeScript 소스와 안전 기준은 바꾸지 않았다.

**P1 — 붙여넣기 문단 ID의 재사용.** 분할 문단은 문서의 단조 예약 `hwpx_paragraph_next`(지운 문단의 ID를 다시 내주지 않음)로 HWPX ID를 받지만, 클립보드 붙여넣기(`reidentify_clipboard`)는 HWP5 개체 인스턴스 할당기(현재 문서에서 쓰이지 않는 가장 작은 양수)로 받은 값을 HWPX ID에도 그대로 썼다. 기존 제품 엔진(`03d2b440…`)에서 실제 WASM으로 재현했다: 붙여넣기 → ID `2`, 그 문단 삭제 → 다시 붙여넣기 → **`2` 재사용**, 삭제의 병합 되돌리기(공개 API `mergeParagraph`의 `removedParaMeta`를 `splitParagraph`에 전달) 뒤에는 **내보내기가 `ambiguous duplicate HWPX paragraph id`로 거부**됐다. 표를 복사하면 셀 문단도 개체 ID 공간의 `4`/`5`/`8`을 받았다. geul UI는 `mergeParagraph`만 쓰고 붙여넣기·병합 되돌리기는 연결하지 않았으므로 엔진 공개 API에서 도달하는 결함이다. 추적 패치 `patches/rhwp/hwpx-clipboard-paragraph-ids.patch`(SHA-256 `30ac44ee1283f55605e49d09e446f5bbb5104b948ce2e7b74b87a9652e8a5c8e`)는 HWP5 `PARA_HEADER` 인스턴스 ID 할당을 그대로 두고, 복사한 모든 문단(표 셀·캡션 등 중첩 소유자 포함)에 아직 배정하지 않은 새 HWPX 식별 셀을 준다. 내보내기 때 분할 문단과 같은 단조 예약을 받는다. 결과: 분할 `3121190099` 뒤 복사 `3121190100`, 붙여넣기·삭제·재붙여넣기는 `…099` 다음 `…100`(재사용 없음)이고 병합 되돌리기 뒤에도 내보내기·반복 내보내기가 같다. 중첩 표 복사 ID는 모두 가져온 최대값보다 크고 서로 다르다. 마지막 u32 ID(`4294967295`)를 한 번 예약한 뒤의 다음 예약은 내보내기를 거부한다(이전에는 작은 개체 ID로 통과). 분리된 문서 스냅숏은 같은 예약을 공유한다(Rust 시험). rhwp lib 시험: 이전 계열과 같은 121개 기존 실패(추출 빌드 입력에 없는 상류 샘플), 새 실패 0. 편집 없는 코퍼스 출력은 이전 릴리스와 691/691 바이트 동일하다.

**P2 — 독립 XML 검증기의 거짓 음성.** `scripts/tests/native-external-hwpx-save.py`는 `e.text.strip()`만 비교하고 `tail`을 버렸으며, ElementTree는 주석·처리 명령을 버렸다. 앞뒤·공백뿐인 글, 자식 요소 뒤의 글(tail) 추가·삭제·공백, 중첩 요소 주변 글 변경, 주석·처리 명령 삭제·변경 11가지 변형을 같다고 판정했다(실제 `list_marker_head_synthetic.hwpx` 문단의 끝 공백 추가도). 새 `scripts/tests/hwpx_xml_oracle.py`는 위 「판정 규칙」의 운영 비교기 계약을 코드 공유 없이 따른다: 루트 안 문자 데이터(공백·tail 포함, 조각 나눔 무관), 주석·처리 명령 내용, 이름공간 URI·지역 이름·속성은 의미 있음; 접두사·속성 순서·이름공간/XML 선언·루트 밖 공백·CDATA/참조 표기는 의미 없음; DTD는 거부. 편집 정규화는 편집한 첫 문단의 `hp:t` 글과 그 자식 tail만 옮기고(그 밖 구조가 같아야 함) 그 문단의 `linesegarray`만 뺀다. 변형 시험 `scripts/tests/test_hwpx_xml_oracle.py`가 옛 비교의 거짓 음성 11가지와 새 비교의 검출, 표기만 다른 7가지의 동등, DTD 거부를 확인한다. 이전 실행에서 게시된 두 외부 문서 파일은 새 검사도 통과해 숨은 손실은 없었고, 관련 없는 문단·편집 문단에 공백을 넣은 변형은 거부됐다.

**P3 — `content.hpf` spine `linear` 보존(좁은 메타데이터 교정).** 직렬화기가 모든 spine `itemref`에 `linear="yes"`를 썼다. 코퍼스 734개의 `itemref` 중 317개는 속성이 없고(옛 한컴), 50개는 `linear="no"`(비선형 항목)였는데 모두 `"yes"`로 바뀌었다 — 생략은 OPF 기본값과 같은 뜻이지만 원본 표기가 바뀌고, `"no"`→`"yes"`는 의미가 바뀐다. 추적 패치 `patches/rhwp/hwpx-spine-linear.patch`(SHA-256 `080070cdfdaffe9b80b61ddeb6ddec8e49080b168649f92932caaf58f08298eb`)는 원본에 같은 `idref`의 `itemref`가 있으면 그 `linear`의 유무·값(`yes`/`no`)을 그대로 쓰고, 다른 값이나 같은 `idref`의 상충 값은 내보내기를 거부하며, 원본에 없는 항목(새 구역)만 기존 기본값 `yes`를 쓴다. 원본 `content.hpf`를 읽을 수 없으면 이전 동작을 유지한다(geul은 그런 원본을 malformed로 막는다). 코퍼스(P1→P3): 결과 분포 그대로(safe 98·unsafe 584·unknown 9·내보내기 실패 43), `partChanged:Contents/content.hpf` 근거가 85개 문서에서 사라지고 새 근거 0, 출력이 바뀐 238개는 모두 `content.hpf`만 달라졌다. **이 교정만으로 새로 safe가 된 문서는 없다** — `content.hpf`가 유일한 근거인 문서가 없었다. 예: `saved/blank_hwpx.hwpx`는 header·section0, `samples/hwpx/21761835_jeonjik_exemption_table.hwpx`는 section0만 남는다. 회귀 `scripts/tests/hwpx-spine-linear-roundtrip.py`는 생략/`yes`/`no`/혼합/스크립트 항목 spine의 정확한 보존, 반복 내보내기, 편집 뒤 보존과 알 수 없는 값·상충 값의 거부를 확인하며 교정 전 엔진에서는 실패한다.

제품 Release는 네 패치 계열의 generation `50780a46ad73bdf0464041f9d8e8d9e40eb4bb4945bf49c9bafcd7b01afb9f19`(WASM `02279b326bd35ef7b8a2c0d7da9f53acbd2cc880e41e5c649261baeb21faf0eb`, 검증한 후보와 바이트 동일)이다. P1/P2까지의 `50b5ff67…`(WASM `17c80ac6…`)와 이전 `03d2b440…`은 되돌림용으로 남겼다. 보존 한도 때문에 선택되지 않은 세대 `8b9bd98e…`(같은 바이트가 다른 보존 위치에 있음)와 `d374343c…`(`03d2b440…`과 바이트 동일)를 지우지 않고 `target/rhwp-preserved-generations/`로 옮겼다. 최종 generation과 `e99363b` debug 앱(SHA-256 `26733632…`)으로 Xvfb/X11·IBus 한글 실제 입력을 다시 실행했다: `list_marker_head_synthetic.hwpx`와 `종이기준.hwpx`는 새 검증기로 preflight safe→한글 입력→저장(revision 2·synced)→닫기·재열기와 모든 부분·문단 ID 비교가 PASS이고, 외부 수정 `FileConflict`·ID 누락 거부·한컴 2024 저장본의 `previewStale` 거부에서 원본 바이트가 그대로다. Stage 4 세 형식(양성 3·거절 9), rhwp·WordCraft 실제 IME 필수 7/7씩, rhwp 일반 편집 DPR1 32/32·표 4/4도 PASS. IME 지연·DPR2·DOCX 일반 편집은 이 최종 바이트로 다시 실행하지 않았다(편집 표면·WordCraft 변경 없음, 이전 결과를 이 바이트로 옮기지 않음). 기계 판독 근거는 [hwpx-duplicate-id-acceptance-2026-11-02.json](hwpx-duplicate-id-acceptance-2026-11-02.json)의 `stabilizationFollowup`, 원시 결과는 무시되는 `target/hwpx-identity-20261102/`다.


### P2 보존 오라클 추가 교정 (2026-11-02)

앞 절 P2의 완료 판정에는 두 경계가 빠져 있었다. 루트만 반환한 ElementTree는 루트 전후의 주석·PI를 버렸고, 편집 문단의 모든 `hp:t` 글을 저장본에서 복사하면 `AB`/`CD`가 `한글ABC`/`D`로 바뀌어도 같아졌다. 두 거짓 음성을 기존 구현에서 재현했다. 새 오라클은 Expat 문서 콜백으로 루트 전후를 포함한 순서 있는 문서를 만들고, 주석 내용과 PI target·내용·구분 공백까지 비교한다. XML 선언과 루트 밖 공백은 무시하고, DTD·잘못된 XML·다중 루트·미선언 접두사는 거부한다. 이름공간·CDATA·문자 참조 동등성은 유지한다. Rust 운영 비교기의 실제 사건 처리와 기존 `legacy_equivalence_corpus` 시험도 확인했다.

허용하는 편집은 첫 최상위 문단의 첫 직접 `run/t` 글 슬롯 앞에 `한글`을 한 번 붙이는 것뿐이다. 앞의 secPr·ctrl 전용 run은 건너뛰며 중첩 문단은 삽입점이 될 수 없다. 저장본의 글·tail을 기대값으로 복사하지 않는다. 기존 글자와 공백·tail·속성·서식 참조·다른 문단은 원래 소유 노드에서 그대로 비교한다. 재계산 예외는 편집 문단의 직접 `linesegarray` 내용뿐이고, 해당 요소 tail과 중첩 문단의 layout은 보존 비교한다. 증명할 직접 글 슬롯이 없으면 검증을 거부한다.

집중 Python 회귀는 외부 주석/PI·표기 동등·잘못된 XML과 run 간 이동·빈 글·유니코드·공백·tail·서식 변경·중첩 구조·layout 범위를 검사한다. 이전 게시 파일 두 개도 새 좁은 비교를 통과했다(새 native 실행 근거로 재사용하지 않음). 운영 판정기·loss report·저장 서비스·안전 기준 변경은 없다. 후속 P3와 새 제품 WASM의 native gate는 별도로 검증한다.


### P3 원본 spine 판독 강화 (2026-11-02)

기존 `linear` 보존 뒤에 `hwpx-spine-validation.patch`를 적용한다. 실제 고정 의존성 quick-xml 0.42.0의 `normalized_value(XmlVersion::Implicit1_0)`로 속성 문자 참조와 XML 공백을 정규화한 후 `yes`/`no`를 검사한다. 기존 WASM이 `y&#101;s`를 내보내기에서 거부하는 것을 재현했고, 수정본은 십진·16진 `yes`/`no` 네 변형을 의미 동등·preflight safe·재내보내기 안정으로 확인했다.

namespace-aware NsReader로 OPF package 루트 바로 아래의 단일 spine, 그 직접 itemref만 수집한다. prefix 별칭은 허용하고 다른 namespace의 metadata itemref는 값을 바꾸지 못한다. spine 내부 외부 요소, 다른 부모의 OPF itemref, 미선언 prefix, 빈/무효 idref, 동일·상충 반복 idref, 보존할 수 없는 itemref/spine 속성은 거부한다. 속성 순회를 flatten하지 않으며 전체 XML 끝까지 검사한다. 중복 속성(확장 이름 포함), 잘못된 문자·참조·이름·선언·인코딩, DTD, 잘린 XML, 다중 루트와 package/spine/manifest 구조 오류는 원본 판독 실패다. 원본 바이트가 있는데 파싱에 실패하면 생성 문서 기본값으로 돌아가지 않는다. 원본이 없는 HWP5 등 생성 경로의 기본값은 유지한다. metadata의 일반 직렬화는 재설계하지 않았다.

집중 Rust content 시험 8개 PASS, 실제 제품 WASM spine 회귀(기존 6문서, 정규화·scope 6건, 음성 23건) PASS. 음성 원본 해시 모두 보존. 제품 generation `afad27ebaceeea05e9f2a6d6b7077b0f59c1192d3c729b576cbebcd4c626bbd1`, WASM `dda83ed625fb99a8f85e2ebea45263ae49cac3b2a8fd68bf1acfb236daaa6088`. 원시 근거는 무시 경로 `target/hwpx-stabilization-20261102/`다. 기존 원본을 수정한 네 문자 참조 시험은 생성한 양성 변형이며, 원래 코퍼스에서 새 safe 문서를 찾았다는 뜻은 아니다. 새 native gate는 다음 절에 별도로 기록한다.


P2 최종 검토 추가: Expat의 일반 text/comment 콜백은 리터럴 CR·CRLF를 LF로 바꿔 Rust의 원문 사건 의미와 달랐다. 실제 주석·본문의 CRLF→LF 변형을 같다고 판정하는 것을 재현했다. 이제 DefaultHandler의 원문 사건을 사용하고, 검증된 XML의 다섯 predefined entity와 숫자 참조만 해석한다(CDATA 안은 그대로 둔다). PI 구분 공백·주석·본문의 리터럴 줄끝을 보존하며 XML 선언·루트 밖 공백은 계속 무시한다. Python 회귀 16개와 Rust의 직접 사건/streaming 비교 회귀를 통해 이 경계도 고정했다. 운영 비교기의 동작 변경은 없으며 Rust에는 시험만 추가했다. 최종 네이티브 실행은 이 교정 뒤 새로 수행한다.


### 최종 native 재검증과 manifest 순서 보존 (2026-11-02, P2/P3/C/P4)

P2 두 거짓 음성과 추가 CR/CRLF 경계를 교정한 최종 오라클로 다시 실행했다. P3의 기존 원본 판독 실패는 이제 생성 문서 fallback이 아니며, 원본 없는 HWP5 생성 경로만 기본값을 유지한다. 먼저 P2/P3 제품 `afad27eb…`에서 두 필수 native 문서·실제 거절을 통과한 뒤 P4를 시작했다. P4 최종 제품에서도 아래 수용을 새로 통과했다. 과거 실행 verdict를 새 실행으로 옮기지 않았다.

**손실 소유 지점과 계약.** HWPX 파서는 manifest 항목을 원래 순서로 읽고 `Document.hwpx_aux_entries`에 원본 `content.hpf`도 보관한다. 직렬화기는 header→소속 구역별 master/section→settings→script→BinData 순으로 묶어 출력하면서 원래 배치를 잃었다. `hwpx-manifest-order.patch`는 원본 순서의 ID를 **실제 생성된 항목**에 연결한다. 기존 항목의 ID/href·리소스 종류·embedded 의미가 일치해야 하고 기존 상대 순서를 보존한다. 새 일반 리소스와 새 구역은 생성 순서대로 뒤에 붙이며 새 master는 소속 구역 앞에 둔다. 원본 바이트를 무조건 재생하지 않는다. 중복 ID/href, 참조한 항목 누락, 미지원 항목·속성, 기존 리소스의 재명명·다른 종류 변환은 거부한다. 원본/결과를 실제 엔진 파서로 읽어 기존 master 소속과 결과 IR 소속을 대조한다. 최종 ZIP에서 모든 embedded href 대상의 실재도 확인한다(Scripts 포함, 외부 링크는 제외). 생성 문서는 기존 순서 기본값을 유지한다.

선언 메타데이터의 좁은 보존도 포함한다: 원본 `image/jpg`와 생성기 `image/jpeg`는 **동일 ID/href의 embedded .jpg/.jpeg**일 때만 원래 표기를 쓴다. 최종 ZIP의 실제 데이터가 `FF D8 FF`로 시작해야 한다. 다른 MIME 변경은 허용하지 않는다. 이것은 JPEG 파일 전체 유효성 검사나 임의 메타데이터 재작성의 허용이 아니다. 초기 후보는 이 표기까지 일괄 거부해 기존 spine 시험의 JPEG 문서를 거부했다. 해당 후보/결과를 남기고, 원본 선언과 실제 리소스 증거를 확인하는 보존으로 고쳤다. 기존 spine 회귀를 삭제하거나 실패를 허용하는 예외를 추가하지 않았다.

원래 순서 재현 예(전체 ID/href 매핑은 근거 JSON 및 문서별 코퍼스 기록):

| 실제 fixture | 이전 export | 최종 export = 원본 기존 순서 |
|---|---|---|
| `issue2816/imgbrush_total_page_fill.hwpx` | header, section0, settings, headersc, sourcesc, image1, image2 | image1, header, image2, section0, headersc, sourcesc, settings |
| `hwpx/exam_social.hwpx` | header, masterpage0, section0, masterpage1, masterpage2, section1, settings, image1…image6 | header, masterpage0, image1…image4, section0, masterpage1, masterpage2, image5, image6, section1, settings |

두 번째 사례의 masterpage0은 구역0, masterpage1/2는 구역1 소속을 유지한다. BinData가 section 뒤에 있는 기존 순서와 여러 이미지, 여러 구역, script 교차 배치도 검사했다. 새 BinData·새 구역·새 master의 배치, 삭제/변경/충돌, dangling script와 JPEG 시그니처 음성은 Rust/실제 WASM으로 검사한다. 원래 IR/serializer가 ID/href를 바꾸는 리소스는 이 교정의 지원 범위가 아니다.

동일 734 fixture·동일 checker SHA `f4d256e7…`로 `afad27eb…`와 최종 제품을 비교했다. 편집 없는 코퍼스 판정이며 편집 저장 자격을 뜻하지 않는다.

| 결과 | 수정 전 | 최종 |
|---|---:|---:|
| export 성공 | 691 | 585 |
| safe | 98 | 98 |
| unsafe | 584 | 478 |
| unknown | 9 | 9 |
| export 실패 | 43 | 149 |

**새 safe 0, 기존 safe 회귀 0.** 순서 차이 176건과 `partChanged:Contents/content.hpf` 근거 176건이 사라졌다. 출력 177개는 `content.hpf`만 바뀌었고(순서와 증명된 JPEG 표기 복원), 다른 408개 출력은 바이트 동일하다. 67개 문서의 JPEG 선언 223개를 보존했다. 계속 export되는 문서에 새 findings/예상 밖 다른 부분 변경은 0이다. 문서별 findings 변화 282건은 근거 제거 176건과 다음 명시적 거부 106건을 구분해야 한다. 원래 unsafe였던 106개는 기존 항목 누락/미지원 72, ID/href·다른 MIME 변경 15, JPEG 시그니처 불일치 12, 미지원 속성 7로 이제 export 단계에서 거부한다. export 성공 수가 줄어든 사실을 호환성 증가로 계산하지 않는다. `.hwpx` 이름을 가진 비-ZIP 원본 9개는 전후 unknown/originalMalformed이며 생성 출력도 전후 동일하다(원본 manifest 순서 검사는 적용 불가). 원본 SHA·전후 분류·매핑·findings는 각 문서별로 보존했다.

**최종 native 수용.** NixOS/Linux Xvfb/X11·GTK/WebKitGTK 2.54.1·IBus Hangul·소프트웨어 렌더링·DPR1에서 `종이기준.hwpx`와 `issue7418/list_marker_head_synthetic.hwpx`를 각각 실제 앱으로 열고 preflight safe→실제 한글 IME→revision 0→2/dirty→Tauri IPC 저장(saved, synced)→닫기→게시 파일 재열기(revision 0, clean)를 확인했다. 최종 독립 오라클은 원래 text run 소유권·공백·tail·서식·문단 ID·다른 부분을 비교했고, 엔진 모델의 쪽·컨트롤·문단도 같았다. 종이기준 문단1개, list-marker 문단44개/반복 ID42개를 보존했다. 실제 저장 거절: 외부 수정은 **수정 직후/저장 직전 해시**와 거절 뒤 해시가 같고 FileConflict, ID 누락 문서의 실제 IME 편집 뒤 저장은 EngineFailure, 한컴2024 twin 편집 저장은 PreviewStale/UnsafeSave다. 모두 dirty/unpreserved=true·원본 불변·거짓 성공 없음. Stage4 세 형식 actual IME 저장/재열기 3/3, 실제 거절 9/9도 새로 PASS; 모든 launcher cleanup 성공/잔류0.

실행 시 Geul HEAD는 `b4a90c5835df62f60ebd9787c6c840f47d9cf1d8` 및 명시된 미커밋 입력 SHA였고, executable SHA는 `2673363242817c4d7610f2c396d65dc04ba5279ce02012d3d3e8f5571c3fda7d`다(운영 Rust/프런트 변경 없음; `xml.rs`는 cfg(test)만 추가). 제품 generation **`4fc10a9db30f457efe64c4784b56da5717d98c72fe72ffbf3bcd573d26b62731`**, WASM **`8ff713c2c6ff97d299cb614822405c6539358fbea7576978ab05a04b56ebd13b`**, patched-source tree `33c6d7b1f17c2469ce91ede33a3ae46aebc4955d88b4ab1951bdb5ac62ef2262`. 앱이 실제 로드한 불변 generation URL·BUILD/RELEASE 신원·WASM 해시를 대조했다. 앱 loader도 받은 JS/WASM의 SHA를 검증한다. 마지막 native 정상 세대 `afad27eb…`와 rollback `50780a46…`, Debug를 남겼다. 보존 한도에서 선택되지 않은 세대 3개는 삭제하지 않고 기존 보존 위치로 옮겨 모든 파일 해시를 확인했다.

검증 결과: Python 오라클 16 PASS, 운영 Rust 계약 직접 시험1 PASS(비교기 동작 불변), 최종 RHWP content/manifest 집중15 PASS, 최종 전체 lib **3768 PASS / 121 FAIL / 13 ignored**. 실패121개는 같은 fixture 구성의 이전 기준과 시험명·실제 오류를 대조해 모두 기존 누락 fixture임을 확인했다. 새 실패0이며 전체 PASS라고 보고하지 않는다. 최종 실제 WASM spine: 원래6문서, 참조/scope6건, 음성23건, HWP5 생성 경로 PASS. manifest: 대표9문서·모델/재내보내기5건·음성12건 PASS. 최종 세대의 ID/clipboard/duplicate/textDir 생애주기도 명시한 불변 generation 경로로 실행해 PASS했다(단독 WASM 시험과 위 native 수용을 구분한다). Wayland/fcitx5/다른 OS/실제 GPU/DPR2와 전체 T007/T008 지연·표면 묶음은 최종 세대에서 NOT RUN이다. T007/T008 INCOMPLETE, T009 미체크, T010 INCOMPLETE·RHWP Undo/Redo NO-GO, T011 NOT STARTED, T014/T015 체크박스 유지.

[기계 판독 근거](hwpx-duplicate-id-acceptance-2026-11-02.json)의 `oracleSpineManifestFollowup`에 테스트 입력·patch·runtime·원본/거절 해시 및 raw evidence SHA를 기록했다. 문서별 원시 전후 분류는 무시 경로 `target/hwpx-stabilization-20261102/p4-final-corpus/result.json`에 있다. 처음의 SC002/텍스트 방향 인자 오류, 비-ZIP 비교기 오류와 수정 전 후보는 삭제하거나 PASS로 바꾸지 않았다.

재현 명령(이미 존재하는 Nix 도구·잠금/offline 의존성·fixture 사용; 새 out 디렉터리 필요):

```sh
python3 -m unittest scripts/tests/test_hwpx_xml_oracle.py scripts/tests/test_hwpx_intentional_edit.py -v
python3 scripts/cargo-geul.py test --lib document::xml::resource_tests::document_events_and_literal_newlines_are_preserved -- --exact
SOURCE_DATE_EPOCH=315532800 CARGO_BUILD_JOBS=4 python3 scripts/build-rhwp-wasm.py
python3 scripts/tests/hwpx-spine-linear-roundtrip.py --out target/hwpx-stabilization-20261102/reproduce-spine
python3 scripts/tests/hwpx-manifest-order-roundtrip.py --before-package public/rhwp/generations/afad27ebaceeea05e9f2a6d6b7077b0f59c1192d3c729b576cbebcd4c626bbd1 --out target/hwpx-stabilization-20261102/reproduce-corpus
```

Geul의 `safe` 입증 의무, unsafe/unknown 저장 차단, loss report·preflight·최종 바이트 검사·재열기·원자적 게시·충돌·복구 정책은 바꾸지 않았다. 남는 원인은 header/section 기본값·빈 run/t·field 속성·다중 구역 보조 구조·textDir AUTO·미지원 리소스 ID/href 및 content-bearing preview stale 등이다. 이 결과로 한컴 HWPX 일반 호환이나 새 편집 저장 자격을 주장하지 않는다. 다음 좁은 작업은 `saved/blank_hwpx.hwpx`의 charPr 기본 자식 원본 presence 보존을 독립적으로 검증하는 것이다.

### 독립 검증기: 줄 배치 예외 축소와 ZIP 중복 이름 (2026-11-02 Stage 1)

`scripts/tests/native-external-hwpx-save.py`의 편집 문단 줄 배치 예외는 그 문단의 직접 자식 `hp:linesegarray`를 개수·위치·내용과 관계없이 양쪽에서 지웠다. 그래서 컨테이너 추가·중복(빈 것 포함), 실행 사이로 이동, 안의 다른 요소·글, 컨테이너 속성 추가, 원본에 없던 캐시 생성 7가지 구조 변형을 받아들였다(재현 `target/hwpx-twostage-20261102/repro_layout.py`; 중첩 문단 배치와 컨테이너 tail 변경은 이미 거부). rhwp 직렬화기(`render_paragraph_parts`)는 문단마다 캐시가 유효할 때만 속성·문자 데이터 없는 `hp:linesegarray` 하나를 실행 뒤 마지막 자식으로, 그 안에 속성만 있는 `hp:lineseg` 하나 이상을 쓰고, 아니면 생략한다(새로 만들지 않음). 새 `normalize_edited_line_layout`은 그 모양만 받아들이고(`lineseg` 속성은 직렬화기가 쓰는 9개 정수, `textpos` 비감소), 1→1 재계산(줄 수 변화 포함)과 1→0 생략만 허용하며 0→1 생성은 거부한다. 컨테이너 tail은 그대로여야 하고 원본 모양을 확인할 수 없으면 명시적으로 실패한다. 다른 문단과 중첩 문단의 배치는 계속 전부 비교한다.

같은 검사기의 패키지 비교는 결과에만 `testzip()`을 적용하고 이름 집합을 비교했다. 중복 이름의 두 항목은 CRC가 유효해 `testzip()`을 통과하고 집합은 개수를 숨기며 `ZipFile.read(name)`은 그중 하나를 말없이 고른다. 새 `archive_parts`는 원본과 결과 모두 무결성을 확인하고 이름이 유일할 때만 부분을 읽는다(운영 Rust 패키지 검사기는 이미 중복을 막는다). 시험 `scripts/tests/test_hwpx_intentional_edit.py`(옛 예외의 거짓 음성 근거 포함)와 `scripts/tests/test_hwpx_package_preserved.py`가 양성·음성 사례를 검사한다. 운영 판정기·저장 정책은 바꾸지 않았다. 현재 Release `4fc10a9d…`(WASM `8ff713c2…`)와 debug 앱 `26733632…`로 `list_marker_head_synthetic.hwpx`·`종이기준.hwpx` 실제 IBus 편집→저장→재열기와 외부 수정·ID 누락·미리보기 낡음 거절이 새 검사기로 다시 PASS했다.

### HWPX `charPr` 기본 자식의 원본 유무 보존 (2026-11-03 Stage 2)

**결함.** 옛 한컴 HWPX는 값이 기본인 `hh:underline`·`hh:strikeout`·`hh:outline`·`hh:shadow`를 `hh:charPr`에서 생략한다. rhwp 파서(`parser/hwpx/header.rs` `parse_char_shape`)는 실효 값만 IR(`CharShape`)에 담아 생략과 기본값 명시를 구별하지 못했고, 직렬화기(`serializer/hwpx/char_shapes.rs` `write_char_pr`)는 네 자식을 항상 썼다. Release `4fc10a9d…`로 `saved/blank_hwpx.hwpx`를 편집 없이 내보내면 7개 `charPr` 모두에 `underline type="NONE" shape="SOLID" color="#000000"`, `strikeout shape="NONE"…`, `outline type="NONE"`, `shadow type="NONE"…`가 생겨 preflight가 `partChanged:Contents/header.xml`이었다. `bold`·`italic`·`emboss`·`engrave`·`supscript`·`subscript`는 이미 유무 기반이라 해당하지 않는다.

**계약과 교정.** 추적 패치 `patches/rhwp/hwpx-charpr-child-presence.patch`(SHA-256 `cbe9574c01e72481d617c352a13da09ba5728a502713a0338ad80c6ab0347573`, 계열 7번째). `CharShape.hwpx_omitted_children`은 HWPX 원본이 **생략한** 네 자식만 비트로 기록한다(실효 값은 그대로 유일한 정본). 직렬화기는 비트가 있고 **값이 생략 시 파싱되는 값(`CharShape::default()`)과 같을 때만** 그 자식을 생략한다. 그래서 밑줄 등 실제 편집 값은 비트와 관계없이 항상 쓰이고(낡은 유무 정보가 편집을 숨기지 않음), 명시적으로 있던 자식은 기본값이어도 남는다. HWP5·HWP3·HML·새 모양은 0이라 이전처럼 네 자식을 모두 쓴다. 이 비트는 서식 동일성이 아니므로 `CharShape` 비교에서 뺐다 — 서식 명령의 `find_or_create_char_shape`가 같은 서식의 기존 `charPr`를 재사용한다. 같은 패치가 HWP5 `DocInfo` 파서와 시험 초기화에 새 필드(0)를 넣는다. geul 판정기·저장 정책은 바꾸지 않았다.

**검증.** rhwp lib 시험 A/B(같은 고정 fixture, 새 복사본에서 다시 컴파일한 기준): 기준 3768 통과/121 실패, 교정 3771/121 — 새 실패 0, 새 시험 3개 통과(첫 기준 실행은 하드링크 트리의 오래된 mtime 때문에 교정 시험 바이너리를 재사용해 무효 처리하고 다시 실행). 실제 WASM 회귀 `scripts/tests/hwpx-charpr-presence-roundtrip.py`: 생략·명시·혼합·비기본 값 보존, 편집 없는/글 삽입 뒤 header 동일과 반복 내보내기 안정, 밑줄·굵게 서식은 원본 `charPr` 그대로 두고 덧붙인 `charPr`에 그 자식만 쓰며 참조가 모두 유효, 명시 자식 문서(`list_marker_head_synthetic.hwpx`)는 safe 유지, HWP5→HWPX header는 기준 엔진과 바이트 동일(3개 HWP), 알 수 없는 자식·상충 중복 자식·잘못된 열거값은 preflight unsafe, 없는 `charPr` 참조·깨진 header는 내보내기 거부. 교정 전 엔진에서는 실패한다. 중복 ID·spine·식별자·textDir 회귀도 PASS. `hwpx-manifest-order-roundtrip.py`는 `50b5ff67…` 대비 `content.hpf`만 바뀌어야 한다고 단언하므로 header를 바꾸는 이 교정에는 맞지 않아, 대신 같은 734개 코퍼스의 부분 단위 A/B를 했다.

**코퍼스(편집 없음, `4fc10a9d…` 대비).** 결과 분포 그대로(safe 98·unsafe 478·unknown 9·내보내기 실패 149), `partChanged:Contents/header.xml`이 26개 문서에서 사라지고(`saved/blank_hwpx.hwpx`, `saved/03-blank_hwpx.hwpx` 포함) 새 근거 0. 출력이 바뀐 102개는 모두 `Contents/header.xml`만 달라졌고(manifest·구역·BinData 바이트 동일), 그 102개 header 차이는 원본에 없던 자식 제거만으로 정확히 설명된다(설명되지 않는 차이 0). **새로 safe가 된 문서는 없다** — 26개 모두 `section0.xml` 차이(예: `secPr` `tabStopVal`/`tabStopUnit` 추가)가 남는다. 남은 header 차이의 가장 큰 원인은 `strikeout` 속성 정규화(130개 문서의 첫 차이)다.

**실제 앱.** 최종 Release generation `65442a921eece4d4a64949143c3ff8f2f76c88ac1902599b2b8d05720205f908`(WASM `561161070853051cf032d78daf2284d1ad652fd0a90e8718929be94049f5d691`, 검증한 후보와 바이트 동일, 일곱 패치), debug 앱 `26733632…`, 앱이 실제로 불러온 WASM URL이 그 generation이다. `list_marker_head_synthetic.hwpx`·`종이기준.hwpx`는 Stage 1 검증기로 preflight safe→IBus 한글→저장(revision 2)→재열기·전 부분 비교 PASS, 외부 수정 `FileConflict`·ID 누락·한컴 2024 미리보기 낡음 거절에서 원본 해시가 그대로다. `blank_hwpx.hwpx`는 앱 preflight가 이제 `partChanged:Contents/section0.xml`만 보고하고(header 근거 없음) 편집 저장은 `UnsafeSave`로 거절, 원본 해시·dirty/미보존 상태 유지. Stage 4 세 형식(양성 3·거절 9) PASS. 편집 표면 코드는 바뀌지 않아 IME·일반 편집·지연 검사는 이 generation으로 다시 실행하지 않았다. 되돌림용 이전 Release `4fc10a9d…`는 남겼고, 보존 한도 때문에 선택되지 않은 중간 세대 `bf911743…`을 지우지 않고 `target/rhwp-preserved-generations/`로 옮겼다. 근거 [hwpx-duplicate-id-acceptance-2026-11-02.json](hwpx-duplicate-id-acceptance-2026-11-02.json) `charPrPresenceFollowup`, 원시 결과 `target/hwpx-twostage-20261102/`.

### 독립 검증기: `hp:lineseg` 속성 집합과 정수 범위 (2026-11-03 Stage 1)

앞 절의 줄 배치 계약은 `hp:lineseg` 속성을 9개 이름의 **부분 집합**과 `-?[0-9]+`로만 확인해 `<hp:lineseg/>`, 필수 속성 누락, `textpos="4294967296"`, i32를 넘는 `vertpos`·`vertsize`, 음수 `flags`, `007`·`-0` 같은 표기를 받아들였다(저장 쪽 12가지·원본 쪽 3가지 재현). rhwp `render_one_lineseg`는 9개 속성을 **모두** 쓰고, 모델 `LineSeg`의 `text_start`·`tag`는 u32, 나머지 7개는 i32다. 고정 734개 코퍼스의 `hp:lineseg` 319,909개(열리는 722개 문서)도 모두 정확히 이 9개를 정규 10진 표기(2,879,257개 값, 앞 0·`+`·`-0` 없음)로 가지며 범위 밖 값이 없다(속성 `data-text-length`가 더 있는 5개 문서 76개 요소는 기존처럼 확인 불가로 실패). 이제 원본·저장 양쪽에서 정확한 9개 속성, 정규 10진 표기, 필드 형식의 범위를 요구하고 `textpos` 비감소 검사를 유지한다. 1→1(줄 수 변화 포함)·1→0·0→0 허용과 0→1 거부, tail·중첩·다른 문단 비교는 그대로다. 부분 속성만 쓰던 합성 양성 fixture를 직렬화기 출력 모양으로 고쳤고 기존 음성 사례도 단일 변형으로 바꿨다. 실제 게시 파일(`list_marker_head_synthetic.hwpx`·`종이기준.hwpx`, Release `65442a92…`)은 새 검사도 통과한다. 운영 판정기·저장 정책·엔진은 바꾸지 않았다.

### 독립 검증기: ZIP 중복 이름을 압축 해제 전에 거부 (2026-11-03 Stage 2)

`archive_parts`는 중복 이름을 거부했지만 그 전에 `testzip()`이 모든 항목을 열어 압축을 풀었고(문서의 "어떤 부분도 읽기 전" 보장과 어긋남), 중복 확인은 이름마다 `names.count`를 불러 이름 수의 제곱에 비례했다(같은 메모리 이름 목록 측정: 20,000개 5,070 ms 대 `Counter` 3.7 ms). 이제 중앙 디렉터리 메타데이터에서 이름을 모아 한 번의 `Counter` 집계로 중복을 거부한 **다음에** `testzip()`으로 CRC를 확인하고 부분을 읽는다. `ZipFile.open`을 기록하는 시험이 중복 거부 전에 열린 항목이 0개임을 확인한다(수정 전에는 5개). 원본·결과 중복 거부, 손상 항목·누락·추가·바이너리 변경 거부, 순서만 다른 패키지와 표기만 다른 XML 허용, 실제 게시 파일 비교는 그대로 통과한다. 운영 패키지 검사기·저장 정책·엔진은 바꾸지 않았다.

### `charPr` 음성 시험의 원인 단언 (2026-11-03 Stage 3)

`scripts/tests/hwpx-charpr-presence-roundtrip.py`의 음성 사례는 이미 `section0.xml` 차이로 unsafe인 `blank_hwpx.hwpx`를 변형하고 `verdict != "safe"`만 확인했다. 그래서 의도한 `charPr` 결함을 놓쳐도 통과할 수 있었다: 속성 순서만 바꾼 무변형 대조군도 같은 조건을 통과하며 그 판정은 변형 전과 같다(`partChanged:Contents/section0.xml`만). 이제 (1) 변형 전 무편집 내보내기가 `safe`이고 근거가 없는 `list_marker_head_synthetic.hwpx`를 독립 기준으로 쓰고, 알 수 없는 자식·상충 중복 `underline`·잘못된 열거값은 판정이 정확히 `unsafe`·`["partChanged:Contents/header.xml"]`이며 독립 비교에서 header 차이가 변형한 `charPr id="0"` 안에만 있어야 한다(다른 `charPr`와 나머지 header 동일). (2) 없는 `charPrIDRef`는 **내보내기** 단계 거부와 진단 `charPrIDRef: [77]`, 깨진 header는 **열기** 단계 XML 파싱 오류를 확인하고 출력 파일이 없어야 한다. 모든 경우 원본 바이트가 그대로다. (3) `blank_hwpx`에서는 같은 변형이 기존 근거 위에 정확히 header 근거 하나만 더하는지 차등 비교한다. 양성 사례와 HWP5 기준 비교는 그대로 통과한다. 시험만 바꿨고 엔진·운영 판정기·저장 정책은 바꾸지 않았다(Release `65442a92…`).

### HWPX `hh:strikeout shape="3D"` 보존 (2026-11-03 Stage 4)

**결함.** 한컴은 그리지 않는 비활성 취소선을 `<hh:strikeout shape="3D" …/>`로 쓴다. rhwp 파서(`parser/hwpx/header.rs`)는 화이트리스트(`is_real_strike_shape`)로 `3D`를 비활성(`strikethrough=false`, `strike_shape=0`)으로 읽어 `NONE`과 같은 IR이 되고, 직렬화기(`strike_shape_str(false, _)`)는 늘 `shape="NONE"`을 썼다. Release `65442a92…`의 734개 코퍼스 출력에서 `strikeout` 차이는 이 한 종류뿐이었다: `3D`→`NONE`(색은 `#000000`·`#FF0000`·`#0000FF`·`none` 모두 보존), 148개 문서의 7,933개 `charPr`. 안전한 `list_marker_head_synthetic.hwpx`의 `charPr id="0"`만 `3D`로 바꾼 문서도 이 엔진에서 `partChanged:Contents/header.xml`로 unsafe였다.

**계약과 교정.** 추적 패치 `patches/rhwp/hwpx-strikeout-3d-placeholder.patch`(SHA-256 `5f9ca456cadaf6b895590dcf1755f80e37534e9052ca191826b1ae0f43adc281`, 계열 8번째). `CharShape.hwpx_inactive_strike_3d`는 원본이 비활성 취소선을 `3D`로 적었음만 기록한다. 파서는 `shape="3D"`일 때만 켜고 `strikethrough`에는 영향을 주지 않아 자리표가 활성 취소선이 될 수 없다. 직렬화기는 `strikethrough`가 꺼져 있을 때만 `3D`를 쓰고, 취소선을 켠 편집은 실제 모양을 쓴다. 서식 명령이 만드는 파생 `charPr`(`CharShapeMods::apply_to`)는 이 값을 지워 표준 `NONE`을 쓴다 — geul의 덧붙인 정의 규칙이 받는 직렬화기 표준 모양이며 의미는 같다. 이 값은 표기이므로 `CharShape` 동일성에서 뺐고(서식 재사용 그대로), HWP5·HWP3·HML·새 모양은 false라 출력이 그대로다. `4D` 같은 다른 값·`shape` 생략·잘못된 색은 보존하지 않아 header 차이로 geul이 막는다(fail-closed). geul 판정기·저장 정책은 바꾸지 않았다.

**검증.** rhwp lib 시험 A/B(같은 fixture, 각 트리를 다시 컴파일): 기준 3771/121, 교정 3773/121 — 새 실패 0, 새 시험 2개 통과. 실제 WASM 회귀 `scripts/tests/hwpx-strikeout-roundtrip.py`: 실제 `3D` 문서 3개(색별)의 `strikeout` 속성이 정확히 보존(그중 2개는 header 전체 동일), 반복 내보내기 안정; 안전한 고정 문서에 `3D`(빨강·`none` 색)·활성 `DASH`를 넣어도 `safe`; 그 `3D` `charPr`를 쓰는 글에 삽입·취소선·기울임을 적용하면 원본 `charPr`는 그대로, 덧붙인 `charPr`는 활성 `SOLID`·파생 `NONE`이고 geul `check_saved`가 셋 다 `safe`; HWP5→HWPX header는 이전 엔진과 바이트 동일; 알 수 없는 `4D`·`shape` 생략·잘못된 색·상충 중복은 정확히 header 근거 하나(변형한 `charPr` 안), 깨진 XML은 열기 단계 거부. 교정 전 엔진에서는 실패한다. `charPr` 유무·중복 ID·spine·식별자·textDir 회귀 PASS.

**코퍼스(같은 734개·같은 SHA-256·같은 checker `f4d256e7…`).** 결과 분포 그대로(safe 98·unsafe 478·unknown 9·내보내기 실패 149), `partChanged:Contents/header.xml`이 114개 문서에서 사라지고(실제 결재문서·보도자료 다수) 새 근거 0. 출력이 바뀐 148개는 모두 `Contents/header.xml`만 달랐고 그 차이는 `3D` 7,933개 복원만으로 정확히 설명된다(설명되지 않는 차이 0, 원본과 다른 `strikeout` 0). **새로 safe가 된 문서는 없다** — 구역 차이 등 다른 근거가 남는다.

**실제 앱.** 최종 Release generation `977146659a542b27fea278ba7977b51bb6962bb1887f35439158dff2cb08748b`(WASM `49ed4cf33bca0b1ccfc30d2829918ff9641fef89f79d8c1b764cbe40b44f82e8`, 후보와 바이트 동일, 여덟 패치), debug 앱 `26733632…`, 앱이 불러온 WASM URL이 그 generation이다. `list_marker_head_synthetic.hwpx`·`종이기준.hwpx`와 `3D` 고정 문서는 preflight safe→IBus 한글→저장(revision 2)→재열기·전 부분 비교(`3D` 포함 header 동일) PASS. 실제 `3D` 문서 `samples/issue5543_carried_anchor_ladder.hwpx`와 `blank_hwpx.hwpx`는 앱 preflight가 이제 `partChanged:Contents/section0.xml`만 보고하고 편집 저장은 `UnsafeSave`로 거절, 원본 해시·dirty/미보존 유지. 외부 수정 `FileConflict`·ID 누락·한컴 2024 미리보기 낡음 거절, Stage 4 세 형식(양성 3·거절 9) PASS. 편집 표면 코드는 바뀌지 않아 IME·일반 편집·지연 검사는 이 generation으로 다시 실행하지 않았다. 되돌림용 `65442a92…`는 남겼고, 보존 한도 때문에 경로로 쓰이지 않는 가장 오래된 Release `50b5ff67…`을 지우지 않고 `target/rhwp-preserved-generations/`로 옮겼다. 근거 [hwpx-duplicate-id-acceptance-2026-11-02.json](hwpx-duplicate-id-acceptance-2026-11-02.json) `strikeoutFollowup`, 원시 결과 `target/hwpx-fourstage-20261103/`.

### 파생 `charPr`의 `3D` 출처 무효화: HTML 붙여넣기·표 셀 (2026-11-03 후속)

**결함.** 앞 절의 `hwpx_inactive_strike_3d`는 `CharShapeMods::apply_to`에서만 지워졌다. HTML 붙여넣기(`document_core/commands/html_import/inline_content.rs` `css_to_char_shape_id`)와 CLI·MCP 표 셀 쓰기(`cli/commands/edit/cells.rs` `recolor_cell_text_black`)는 원본 `charPr`를 직접 복제·수정한 뒤 같은 정의가 없으면 새로 덧붙이는데, 이때 원본의 `3D` 표기 출처가 새 정의에 남았다. 재현(Release `97714665…`): 0번 `charPr`가 `3D`(빨강)인 안전 문서에 실제 WASM `pasteHtml`로 굵게·취소선 글을 붙이면 새 굵게 `charPr`가 `shape="3D"`로 쓰였고, geul `check_saved`는 덧붙인 정의가 직렬화기 표준 모양이 아니라 `partChanged:Contents/header.xml`(unsafe)로 저장을 거절했다(fail-closed, 원본 보존). 실제 CLI `rhwp edit set-cell`로 `3D`·파란 글자의 표 셀을 쓰면 새 검정 `charPr`도 `3D`를 가졌다. 같은 갈래를 찾아본 결과 `CharShape`를 복제해 덧붙이는 나머지 라이브러리 경로(`find_or_create_char_shape`, `updateStyleShapes`)는 `apply_to`를 거쳐 이미 올바르다.

**교정.** 추적 패치 `patches/rhwp/hwpx-strike3d-derived-styles.patch`(SHA-256 `992074268325dcc9f1bcc972455a6b90e202db6d25efaa4295b36c3a940e19c2`, 계열 9번째)는 두 경로에서 `raw_data`를 비우는 자리에서 `hwpx_inactive_strike_3d`도 지운다. 동일성 비교가 이 값을 보지 않으므로 같은 기존 `charPr`가 있으면 그대로 재사용되고 그 정의는 자기 표기(`3D` 포함)를 유지한다. 새로 덧붙는 정의만 비활성이면 표준 `NONE`, 취소선이 켜지면 실제 모양을 쓴다. 원본 `charPr`·`hwpx_omitted_children`·HWP5/HWP3/HML 경로·파서의 `3D` 해석·geul 판정기·저장 정책은 바꾸지 않았다.

**검증.** Rust 시험(실제 HWPX header 파싱 + `css_to_char_shape_id`): 새 굵게 정의 `NONE`, 원본 `3D`, 취소선 `SOLID`, 무서식은 원본 재사용, 같은 굵게는 새 정의 재사용. rhwp lib 시험 3774/121(이전 계열 3773/121과 같은 121개 기존 실패, 새 실패 0). 실제 경로 회귀 `scripts/tests/hwpx-strike3d-derived-roundtrip.py`: WASM `pasteHtml` 뒤 원본 `charPr`는 그대로, 새 굵게 `charPr`는 `<hh:strikeout shape="NONE" color="#FF0000"/>`, 새 취소선은 `SOLID`, 반복 내보내기·재열기 동일, geul `check_saved` `safe`; CLI `set-cell`(같은 계열로 빌드한 rhwp CLI) 뒤 원본 `charPr 7`은 `3D` 유지, 셀은 새 검정 `charPr`(`NONE`)를 쓰고 다른 표는 그대로, 둘째 표 셀은 그 정의를 재사용. 교정 전 WASM·CLI에서는 둘 다 실패한다. 취소선 `3D`·`charPr` 유무·중복 ID·spine 회귀 PASS. 최종 Release generation `fe235d2f5df9cac5c2756949f6aba182a4e6e0bca4cd59fe1084c07d80d2d2d4`(WASM `c631c4e9b77c6bf745b5ab027ec802da249992cc47f66e579c9cf6a329603af5`, 후보와 바이트 동일, 아홉 패치)과 debug 앱 `26733632…`로 `list_marker_head_synthetic.hwpx`와 `3D` 고정 문서의 실제 IBus 편집→저장→재열기, 외부 수정·ID 누락·미리보기 낡음·남은 차이 문서(`blank_hwpx`)의 거절과 원본 해시 유지가 PASS. 되돌림용 `97714665…`를 남기고, 경로로 쓰이지 않는 가장 오래된 Release `50780a46…`을 `target/rhwp-preserved-generations/`로 옮겼다. 한계: 표 셀 경로는 rhwp CLI·MCP 기능이라 geul 앱 UI에서는 쓰이지 않으며, CLI 빌드에는 `include_str!`로 쓰는 상류 문서(`llms.txt`, `mydocs/manual/*`)를 고정 커밋에서 더해야 했다. 근거 `hwpx-duplicate-id-acceptance-2026-11-02.json` `strike3dDerivedFollowup`, 원시 결과 `target/hwpx-strike3d-20261103/`.

### HWPX `secPr@tabStopVal/tabStopUnit` 원본 표현 보존 (2026-11-03)

**재현.** 기준 HEAD `ad201978…`, 9패치 Release `fe235d2f…`/WASM `c631c4e9…`에서 `saved/blank_hwpx.hwpx`(SHA-256 `42a10023dccae3041d8ca3b9ae13f38ee2dbc69097eecfa97380427584994c87`)를 실제 WASM으로 무편집 내보냈다. 원본 여는 태그는 `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">`였고, 결과는 `tabStop="8000"` 뒤에 `tabStopVal="4000" tabStopUnit="HWPUNIT"`만 추가했다. 두 속성만 제외하면 독립 canonical event 전체가 같았다. 실제 Geul preflight는 `unsafe`, finding은 `partChanged:Contents/section0.xml` 하나였다. header 차이는 이미 이전 작업으로 해결된 상태였다.

**소유권과 계약.** 10번째 추적 패치 [`hwpx-secpr-tabstop-presence.patch`](../../patches/rhwp/hwpx-secpr-tabstop-presence.patch)(SHA-256 `4a973d709e129fd4e2c22d538c6f426adfaf562cf5b70f82a5f704106b319ed1`)가 `SectionDef`마다 선택적 `HwpxTabStop` 원본 정보를 둔다. `Some`은 각 속성의 존재/부재와 XML 정규화 후 값을 보존하고, `None`은 생성·HWP5/HWP3/HML 변환의 기존 템플릿 기본값 `4000/HWPUNIT`을 유지한다. 로컬 OWPML ParaList 스키마의 `tabStopVal`은 선택적 `xs:integer`(생략 기본값 **0**), `tabStopUnit`은 선택적 `CHAR|HWPUNIT`(생략 기본값 `HWPUNIT`)이다. 따라서 각각 생략할 수 있고, 생략과 명시적 기본값의 표현은 구분한다. 유효한 부호·앞자리 0·공백 등 정수 표기도 보존하며 엔티티와 공백은 quick-xml 0.42 `normalized_value`로 처리한다. 이 정보는 렌더러가 읽지 않고 effective-state serde 출력에서도 제외된다. 기존 `tabStop`/`default_tab_spacing`, TabDef 및 실제 탭 배치 경로는 그대로다.

원래 section 파서는 두 속성을 버렸고 직렬화기는 템플릿의 두 기본 속성을 남겼다. 신규 파싱 오류를 일반 `XmlError`로 반환한 첫 후보에서는 상위 컨테이너가 이를 잡아 빈 `Section::default()`로 바꾸는 실제 WASM 음성 실패도 발견했다. 최종 패치는 전용 `SecPrTabStop` 오류만 section/master-page 컨테이너 경계까지 전달하며, 무관한 오류 처리 방식은 바꾸지 않는다. 중복/깨진 속성·잘못된 숫자·알 수 없는 단위·엔티티는 특정 원인으로 거부한다. 템플릿 자체는 유지하고, 첫 `hp:secPr` **여는 태그 범위 안**의 정확한 두 앵커를 한 번씩만 치환/생략한다. 앵커가 없거나 중복이면 실패하며 뒤의 구역 정의·중첩 요소는 건드리지 않는다.

문단 텍스트나 무관한 구역 속성 편집은 출처를 유지한다. 전체 구역 복제/이동은 출처와 함께 이동하고 새 구역은 생성 기본값을 사용한다. 기존 API가 legacy 탭 간격을 바꾸면 새 속성 쌍의 변환 관계를 추정하지 않고 `tab spacing changed; conversion unsupported`로 내보내기를 거부한다. 한 스트림의 head와 첫 정의가 서로 다른 출처를 가진 상태도 `inconsistent section head`로 거부한다. 일반 구역 구조 재작성은 하지 않았다. 서로 다른 section XML의 출처는 독립적이다.

**입력과 회귀.** 동일성이 확인된 734개 원본에서 806개 `secPr`: 둘 다 생략 74개, `4000/HWPUNIT` 730개, `2000/CHAR`·`3500/HWPUNIT` 각 1개였다. 한 속성만 존재하거나 섹션마다 표현이 다른 실물은 없어서 해당 사례는 합성으로 표시했다. Rust `secpr` 18/18(생성 기본값 기존 시험 포함), section 파서 94/94, 실제 WASM 양성 11·음성 9, 두 section 인덱스의 전체 canonical XML, 반복 내보내기·다시 열기·복제·편집 거부가 PASS다. HWP3/HML 두 선택 샘플은 기준/후보의 25/11개 모든 part 및 package SHA가 같았고 손실 보고는 0이었다. 기존 ID·중복/clipboard ID·spine·charPr·strikeout·파생 HTML 붙여넣기 회귀도 PASS다. `charPr` 차등 시험의 과거 “blank는 unsafe” 전제는 명시적 합성 `lineNumberShape@distance=12345` 기준으로 옮겼으며, 각 변형이 자기 header finding을 추가해야 하는 단언을 유지했다.

| 734개 코퍼스 | 기준 | 최종 |
| --- | ---: | ---: |
| 내보내기 성공 / 실패 | 585 / 149 | 585 / 149 |
| safe | 98 | 112 |
| unsafe | 478 | 464 |
| unknown | 9 | 9 |

같은 원본 SHA와 같은 checker(`f4d256e7…`)로 비교했다. 출력이 바뀐 50개 문서는 모두 `Contents/sectionN.xml`의 대상 두 속성으로만 설명됐고 다른 part/속성 변화는 0이었다. 16개 문서에서 section finding이 사라졌으며 **새로 safe 14개**, 기존 safe 회귀 0·새 finding 0이다. 새 safe 14개 모두 독립 package/model/반복 내보내기/reopen 검사를 통과했다. 다른 13개의 편집 저장·preview 자격까지 승인한 결과는 아니다.

**최종 실제 앱.** Release generation `f817bec0ffa17773e8f7e5412f3cbcf7458bf7140d329fc5e0986d0d98c157eb`, WASM SHA-256 `0340e34c0887dc3153525123fd56a7333e60acb10a85758f790020783554d2c5`, source tree `e30ee2d2…`를 검증했다. 보호된 Geul debug 빌드(HEAD `ad201978…`, executable SHA-256 `2673363242817c4d7610f2c396d65dc04ba5279ce02012d3d3e8f5571c3fda7d`)와 NixOS/Xvfb/X11/IBus/Tauri 실제 앱에서 `list_marker_head_synthetic.hwpx`, `종이기준.hwpx`, **`blank_hwpx.hwpx`** 모두 safe preflight → 실제 한글 조합 → revision 0→2/dirty → IPC saved/synced → 닫기/재열기 revision 0 → 편집 텍스트/문단 ID/section/package/독립 XML 보존을 통과했다. 실행 앱이 해당 immutable generation의 WASM URL을 로드한 증거를 남겼다. blank의 section0은 이제 원본과 같고 다른 section 차이는 없으며, 기존의 알려진 빈 preview 계약도 충족해 실제 편집 저장까지 PASS다.

FileConflict·잘못된 문단 ID 각 3건, stale preview·남은 unsafe section 차이·불일치한 section 출처 각 1건, 총 9건은 거부됐고 저장 시도 전후 SHA가 모두 같았다. preview는 `previewStale` finding을 가진 `UnsafeSave`, section 출처는 특정 엔진 진단을 가진 `EngineFailure`였다. dirty/unpreserved 유지·잘못된 출력 미게시·임시 파일 없음·세 실행 cleanup 잔존 프로세스 0을 확인했다. 운영 canonical 비교·손실 보고·preflight·정책·최종 패키지 검증·원자적 게시·내구성/복구·충돌/preview/ID 검사는 변경하지 않았다.

**재현과 한계.** 전체 10패치는 깨끗한 pinned RHWP에 재현 적용했고 두 gitlink·lockfile·앞선 9패치는 그대로다. 기존 캐시/`--locked --offline`으로 실제 빌드했다. 세대 6개 제한에서 선택되지 않은 `afad27eb…`와 `4fc10a9d…`를 소비자 중지 후 해시와 함께 ignored 보관소로 옮겼다. 기준 `fe235d2f…`, 직전 `97714665…`, Debug `0c2faef3…`와 실패 중간 후보는 보존했고 삭제하지 않았다. 최초 QName 시험 컴파일 오류·상위 파서의 오류 삼킴·오래된 charPr 전제 실패 증거도 남겼다. 최종 검증 명령/종료 코드/원시 증거는 `target/hwpx-secpr-tabstop-20261103/`의 결과 JSON·로그에 있다. 실제 WASM 명령은 `python3 scripts/tests/hwpx-secpr-tabstop-roundtrip.py --package public/rhwp/generations/f817bec0ffa17773e8f7e5412f3cbcf7458bf7140d329fc5e0986d0d98c157eb --baseline public/rhwp/generations/fe235d2f5df9cac5c2756949f6aba182a4e6e0bca4cd59fe1084c07d80d2d2d4 --checker src-tauri/target/debug/examples/save_check --out target/hwpx-secpr-tabstop-20261103/wasm-fixed --corpus-list target/hwpx-compat-20261102/corpus/list.txt --reuse-baseline target/hwpx-secpr-tabstop-20261103/baseline-corpus`이다. 전체 RHWP library suite/전체 Clippy·workspace·성능/시각 시험, 최종 10패치 CLI table-cell 빌드는 NOT RUN이며 과거 fixture 누락 121개 실패를 PASS로 바꾸지 않았다. 464 unsafe·9 unknown·149 내보내기 실패와 다른 공백/빈 `hp:t` 구조 차이는 남는다. 다음 좁은 작업 후보는 `156492236___min.hwpx`의 빈 `hp:t` 유실 한 건 재현이다. T007/T008 INCOMPLETE, T009 미체크, T010 INCOMPLETE·Undo/Redo NO-GO, T011 NOT STARTED를 유지한다. 상세 공개 기록은 [acceptance JSON](hwpx-duplicate-id-acceptance-2026-11-02.json)의 `secPrTabStopPresenceFollowup`이다. 앞 절의 수치는 각 당시의 관측으로 보존한다.

### HWPX 빈 `hp:t`·빈 run 위상 보존의 최종 안정화 (2026-11-03 후속)

**출발점.** WIP 커밋 `025c321d…`(11번째 패치 `hwpx-empty-text-boundaries.patch` SHA-256 `5af2aec7…`, 후보 generation `0bc2c0f2…`/WASM `0d0f2b30…`)는 문단 소유 `HwpxTextTopology`로 `156492236___min.hwpx`의 빈 `hp:t` 57개·빈 run 111개를 복원했지만 다음 한계가 있었다(전부 실제 재현으로 확인). ① 봉인은 식별자 운반체 `Arc` 포인터만 비교해 **같은 운반체 안의 숫자 문단 ID 변경**을 통과시켰다(새 회귀가 WIP에서 실패). ② 컨트롤 사건 키가 `id`/`beginIDRef`/`fieldid`만 써서 `bookmark name`·`pageNum pos`가 다른 두 컨트롤이 같은 키가 되었고, 출력에서 둘을 바꿔도 통과했다. ③ 글자 서식은 경계가 그대로여도 언제나 `stale`로 거부했다. ④ 새 거부 18건 중 6건(`hp:t@charStyleIDRef`)은 **문서 열기 자체**를 실패시켰다. ⑤ WIP는 교차 기능 회귀(`duplicate-id`·`strikeout`·`strike3d-derived`)를 실행하지 않았고, 실행하면 셋 다 실패했다(WIP generation으로도 같은 실패 재현). 원인은 한컴의 일반적인 빈 줄(`<hp:run><hp:t/></hp:run>`만 있는 빈 문단)까지 위상으로 잡아 빈 줄 삭제(문단 병합)·부분 서식·HTML 붙여넣기를 모두 거부한 것이다.

**식별자 소유권(1단계).** 위상은 운반체와 함께 **묶일 때의 숫자 값**(`owner_value`)을 기록한다. 같은 운반체에서 값이 바뀌면 `paragraph identity value changed without a supported reidentification`으로 거부한다. 허가된 전이는 명시적이다: 직렬화기 `prepare_paragraph_ids`가 지연(0) ID를 한 번 예약하면 `record_reservation`으로 그 값만 인정하고(스냅숏 복제와 공유), 클립보드 재식별(`rebind_clone`: 새 지연 운반체)과 병합 실행 취소의 ID 복원(`apply_meta` → `rebind_restored_identity`)은 다시 묶는다. 한컴의 반복 `id="0"`은 운반체마다 따로 유지된다. 표 셀 자식 문단의 값 변경도 부모와 무관하게 거부된다.

**컨트롤 사건 대응(1단계).** 키를 역할로 나눴다: 안정 소유 식별자(`id`·`beginIDRef`·`fieldid`), 서로 같은 컨트롤을 구별하는 방출 식별 속성(`pageNum` pos/formatType/sideChar, `autoNum`·`newNum` num/numType, `bookmark` name, `fieldBegin` type/name, `header`·`footer` applyPageType, `footNote`·`endNote` number, `pageHiding` hide*, `colPr` layout/colCount/sameSz/sameGap — 734개 코퍼스에서 직렬화기가 값 그대로 쓰는 것을 실측), 직렬화기가 정규화하는 표현(`fieldBegin` dirty/zorder/metaTag, `footNote` instId/suffixChar, `colPr` type)과 하위 서식·배치(키에서 제외, 바이트는 언제나 생성 조각에서). `hp:t` 안 인라인 토큰(`hp:tab` width/leader/type 등)은 위치 사건이므로 원소 이름과 소유 ID만 비교한다. 같은 키인데 원본 표현이 다른 두 컨트롤은 대응을 증명할 수 없어 `ambiguous control event identity`로 거부하고, 완전히 같은 컨트롤은 서로 바꿔도 같으므로 허용한다. 직렬화기의 의도된 정규화 `[#6869]`(한 문단에서 첫 `hp:pageNum`만 방출)는 명시적 대응 규칙으로 다룬다: 접힌 원본 사건은 기대 목록과 출력에서 빠지고 나머지 사건과 빈 `hp:t` 위치는 그대로 검증된다.

**글자 서식(2단계).** 실제 서식 경로(`try_map_char_shape_range`, 실행 취소의 `restore_char_shape_runs`)만 `format_edit`을 부른다. 모든 IR run 발생의 개수·순서·시작 위치가 같고, 이전 모양 ID를 넣은 봉인이 편집 전 봉인과 정확히 같을 때(즉 글자 모양 ID 외에는 바뀌지 않음)만 원본 run이 새 `charPrIDRef`를 따른다. 새 참조의 유효성은 기존 header 참조 검사가 바이트 전에 확인한다. 경계를 나누거나 합치는 서식(부분 범위, 엔진의 같은 ID 이웃 병합, 같은 위치의 0폭 발생 흡수)은 `character formatting changed run occurrence boundaries`, 서식 외 변경이 섞이면 `character formatting edit changed more than run character shapes`, `charStyleIDRef` 글에 직접 서식을 주면 `character formatting of hp:t charStyleIDRef text is unsupported`로 거부한다. `char_shapes` 직접 변경은 서식 명령이 아니므로 `stale`이다.

**새 거부 18건의 개별 분류(3단계).** 각 문서를 경로·원본 SHA-256로 고정해 `scripts/tests/hwpx-empty-text-roundtrip.py`의 `WIP_REFUSALS`가 결과와 정확한 원인을 단언한다.

| 분류 | 문서 수 | 결정 | 근거 |
| --- | ---: | --- | --- |
| `hp:t@charStyleIDRef` (OWPML 글자 스타일 참조) | 6 | 지원 | 모든 참조가 header `type="CHAR"` 스타일. 위상이 값을 보존·재방출하고 내보낼 때 글자 스타일인지 검사(아니면 `hp:t charStyleIDRef does not reference a character style`). 그 밖의 `hp:t` 속성은 계속 거부. 위상 포착 실패는 이제 문서 열기를 막지 않고 HWPX 내보내기만 원인과 함께 거부 |
| `[#6869]` `pageNum` 접기 | 3 | 대응 | 위 명시적 규칙 |
| 인라인 `hp:tab` type 0→1 | 2 | 대응 | 인라인 배치 속성은 사건 식별이 아님 |
| `fieldEnd`와 표의 같은 위치 순서 뒤바뀜 | 4 | 거부 유지 | 기존 직렬화기 순서 결함(위상 범위 밖) |
| 컨테이너 id 0→1000 재번호 | 1 | 거부 유지 | 로더의 개체 식별자 재번호, 기록된 대응 없음 |
| `hp:unknownObj` → 표 | 1 | 거부 유지 | 원본 사건이 출력되지 않음 |
| 인라인 `hp:hypen` 소실 | 1 | 거부 유지 | 파서가 토큰을 버림 |

해결된 11개는 모두 내보내지고 원본 위치별 run/사건 검사와 기준선 대비 설명 투영 검사를 통과했다(여전히 이전부터 있던 다른 차이로 unsafe).

**빈 줄의 정규형(교차 회귀 교정).** 글이 없고 secPr/colPr 외 컨트롤이 없으며 IR 글자 모양 발생이 **하나**이고 그 발생의 유일한 글 run이 속성 없는 빈 `hp:t` 하나뿐인 문단(한컴 빈 줄·빈 첫 문단)은 IR이 전부를 담고 작성기가 정확히 그 형태를 쓰므로 위상을 잡지 않는다. 그 run에 대한 편집 효과(입력은 채움, 줄 삭제는 제거)가 곧 의도다. 글 옆의 0폭 빈 `hp:t`는 엔진의 같은 ID 이웃 병합으로 사라질 수 있어 계속 추적한다. 템플릿 run과 글 run의 `charPrIDRef`가 달라 발생이 둘이면 작성기가 템플릿 발생에 글 run을 덧붙이므로 추적한다(첫 시도에서 이 조건이 빠져 `hwpx-02.hwpx`·`s-hwpx-02.hwpx` 출력이 기준선 결함으로 되돌아간 것을 후보 간 바이트 대조로 발견해 고쳤다). 교정 뒤 `duplicate-id`·`strikeout`·`strike3d-derived`를 포함한 교차 회귀 7개가 통과한다. `duplicate-id`의 표 복사 시험은 표 앵커 `<hp:tbl/><hp:t/>`(작성기가 끝 `hp:t`를 버리므로 위상이 필요)를 붙여넣으면 클립보드의 컨트롤 식별자 재매핑이 지원되지 않아 거부되므로, ID 할당 검증은 끝 빈 `hp:t`를 뺀 파생 사본에서 하고 원본의 구체적 거부(바이트 없음)를 따로 단언하도록 바꿨다.

**최종 산출물.** 11번째 패치를 제자리에서 고쳤다(SHA-256 `1fc2efea7d66a1a1c96eef5b3103e06b9bac69ce62108c3784a38c1e220b29f5`, 같은 13개 파일, 앞 10개 패치 불변, pinned RHWP `1a76570e…`에 11개 전체 적용이 개발 원본과 바이트 동일). 기존 캐시 `--locked --offline` Release generation `89fbb642fa17f12104ddbebb5d20e90ab9a1007f358e3bde9aa77418698b1baf`, WASM SHA-256 `c3fd55c45fdb8670e18be75db8e67de13eef9f719bb9c8bb102771b9ed92e5dd`, `rhwp.js` `70cde06a…`, source fingerprint `9da3a08f…`, source tree `d0f47625…`. 세대 6개 제한 때문에 `65442a92…`와 대체된 중간 후보 `7b1bef5f…`·`63edd865…`를 해시와 함께 ignored 보관소로 옮겼다(삭제 없음). WIP `0bc2c0f2…`, 기준 `f817bec0…`·`fe235d2f…`, Debug `0c2faef3…`는 그대로다.

**검증.** Rust `empty_text` 44/44(새 회귀: 같은 운반체 ID 변경·중첩 셀·반복 ID·클립보드 예약·병합 실행 취소·컨트롤 교환/대체/식별 속성 변경·모호 키·정규화 허용·`pageNum` 접기·통째 run 서식·서식 실행 취소·부분 서식 거부·무관 문단 서식·셀 서식·`charStyleIDRef` 보존/검증·빈 줄 정규형). WIP 코드에 대해 같은 운반체 시험을 포함한 6개가 실패했고, 얕은 키로 되돌린 변이에서 교환 반례가 실패함을 확인했다. 전체 RHWP library 3820 통과·121 실패·13 무시이며 실패 121개는 이전 기록과 **같은 집합**이다(fixture 누락; PASS로 바꾸지 않음). 실제 WASM 시험 양성 19·편집 11, 교차 회귀 7개(duplicate-id·identity·spine·charPr·strikeout·strike3d-derived·secPr) PASS. HWP5/HWP3/HML/새 문서의 HWPX·HWP 출력과 위상 문서의 HWP5 출력은 기준 `f817bec0…`와 바이트 동일하다.

| 734개 코퍼스(같은 원본 SHA·checker) | 기준(WIP 전) | WIP `0bc2c0f2` | 최종 `89fbb642` |
| --- | ---: | ---: | ---: |
| 내보내기 성공 / 실패 | 585 / 149 | 567 / 167 | 578 / 156 |
| safe / unsafe / unknown | 112 / 464 / 9 | 157 / 401 / 9 | 157 / 412 / 9 |
| 기존 safe 회귀 · 새 finding | — | 0 · 0 | 0 · 0 |

WIP와 최종이 함께 내보낸 567개 출력은 **모두 바이트 동일**하고, 바뀐 것은 해결된 11개(export-failed→unsafe)뿐이다. 새 safe 45개(기준 대비)는 그대로다. 성공 578개 모두 첫/반복 내보내기·재열기·재내보내기를 거쳤고 563개는 완전 안정, 15개는 기준 generation에서도 같은 조건으로 불안정한 기존 문제다(`reopenModel` 10: `pageNum` 접기 4개 포함 — 접힌 컨트롤이 다시 열면 없음, `reopenedBytes` 5). 새 안정성 finding 0.

원래 대상 `156492236___min.hwpx`(SHA-256 `d6f4d431…`)의 출력은 WIP와 바이트 동일(`78be2943…`)하고, 빈 `hp:t` 57·빈 run 111·run 1428·공백 `hp:t` 127이 위치별(문단/run/사건 단위)로 보존되며 B/C/D 바이트 동일·모델 같음이다. header `typeInfo@familyType`와 41개 `cellMargin` 차이는 범위 밖으로 남아 Geul preflight는 계속 `unsafe`(header·section)로 거부한다.

**실제 앱.** 같은 Geul debug 실행 파일(HEAD 이후 Geul 원본 무변경, SHA-256 `2673363242817c4d7610f2c396d65dc04ba5279ce02012d3d3e8f5571c3fda7d`)과 NixOS/Xvfb/X11/IBus Hangul/Tauri에서 최종 generation URL 로드를 확인했다. `종이기준.hwpx`·`list_marker_head_synthetic.hwpx`·`blank_hwpx.hwpx`·합성 빈 `hp:t` 문서 모두 safe preflight → 실제 한글 조합(revision 0→2, dirty) → IPC saved/synced → 닫기·재열기(revision 0) → 글·문단 ID·독립 package/XML·모델 보존 PASS. 서식 수용(시험 빌드 `VITE_GEUL_TEST_RHWP_HISTORY=1`·`VITE_GEUL_TEST_RHWP_FORMAT=1`): 빈 `hp:t`가 있는 run을 실제 Shift+→ 선택과 Ctrl+I로 기울임 → 덧붙인 `charPr` 7을 그 run이 가리키고 `<hp:t>AB</hp:t><hp:t></hp:t>`가 그대로이며 Geul 서식 덧붙임 규칙으로 saved/synced, 재열기 깨끗, 모델은 그 run의 모양만 다르다. 거부(모두 원본 SHA 전후 동일, dirty/unpreserved 유지, 임시 파일·게시 없음, cleanup 잔존 0): FileConflict, 문단 ID 누락(EngineFailure), PreviewStale(UnsafeSave), 원래 대상의 남은 unsafe(UnsafeSave), 모호 컨트롤(EngineFailure, 같은 WASM 원인 `ambiguous control event identity`), 실제 Enter 분할 — 캐럿 `0:0:1`→`0:1:0`, 편집 전 preflight safe라서 저장은 `SaveFailure`(내보내기 단계 문구)이고 같은 WASM 재현에서 편집 없는 내보내기는 성공·문단 1→2·편집 내보내기는 `paragraph split has unsupported run correspondence`, 디렉터리 목록 불변. WIP 하네스가 기대한 `EngineFailure`는 실제 앱 경로와 맞지 않아 원인 증거를 강화해 고쳤다.

**남은 한계.** 문단 분할·병합·클립보드 붙여넣기는 secPr/colPr만 있는 분할 가능 문단에서만 대응되고, 그 밖(표·필드 등 컨트롤이 있는 위상 문단의 분할/병합, 컨트롤 식별자를 재매핑하는 복사, HTML 붙여넣기의 비서식 경로)은 구체 원인으로 거부된다. 부분 범위 서식과 엔진의 같은 ID 이웃 병합으로 경계가 바뀌는 서식·실행 취소는 거부된다. secPr/colPr 템플릿 run과 `charPrIDRef`가 다른 첫 글 run의 맨 앞 입력은 엔진이 글자를 템플릿 발생에 넣으므로 거부된다(`ambiguous textless run insertion ownership`). 같은 운반체 ID 변경·모호 매핑의 native 음성은 이를 만들 실제 UI 경로가 없어 NOT RUN(Rust·패키지 내보내기 시험으로 검증). 남은 거부 7건, unsafe 412·unknown 9·내보내기 실패 156과 다른 XML 차이는 남는다. 이 결과는 일반 한컴 HWPX 호환이나 새 편집 저장 자격을 뜻하지 않는다. T007/T008 INCOMPLETE, T009 미체크, T010 INCOMPLETE·Undo/Redo NO-GO, T011 NOT STARTED 유지. 상세 공개 기록은 [acceptance JSON](hwpx-duplicate-id-acceptance-2026-11-02.json)의 `emptyTextTopologyFinalFollowup`, 원시 근거는 ignored `target/hwpx-empty-text-final-20261103/`.

### 위상 검증 경계 강화: 예약된 문단 ID와 중첩 컨트롤 내용 (2026-11-03 후속)

앞 절(`e685c6c`)의 두 경계를 반례로 확인하고 고쳤다. 둘 다 교정 전 코드에서 새 회귀가 실패했다.

- **예약된 지연 ID의 되돌림.** 지연(0) 운반체를 직렬화기가 101로 예약한 뒤 같은 운반체를 0으로 되돌리면, 이전 검사(`now != owner_value && !(owner_value == 0 && reserved == now)`)는 `now == owner_value`라서 받아들였다. 전체 내보내기는 다시 예약하려다 `OnceLock`이 이미 차 있어 다른 값으로 거부되었지만(바이트 없음), 위상 검증 자체는 통과시켰다. 이제 예약이 기록되면 현재 값은 **그 예약값과 같아야** 한다(0으로 돌아가도 예약 생애가 다시 열리지 않음). 예약 전 0, 예약 뒤 반복 검증, 예약값 복원, 클립보드 재식별, 병합 실행 취소 복원, 반복 `id="0"`, 셀 문단 거부는 그대로다.
- **중첩 컨트롤 내용.** 모호성 지문은 `hp:ctrl`과 직계 자식의 이름·속성만 담아, 얕은 키와 직계 지문이 같고 중첩 `hp:autoNumFormat` type만 다른 두 `hp:autoNum`을 서로 바꾼 출력을 받아들였다. 이제 원본 컨트롤끼리 비교하는 지문이 `hp:ctrl` 하위 트리 전체(요소 이름·속성·공백 아닌 글)를 담아, 그런 쌍은 `ambiguous control event identity`로 내보내기를 거부한다(바이트 없음). 출력과 비교하는 사건 키는 바꾸지 않았으므로 직렬화기 정규화(하위 속성 순서·표기)는 계속 통과하고, 완전히 같은 컨트롤 쌍은 계속 지원된다. 모델에서의 교환은 이전부터 봉인(컨트롤 전체 다이제스트)이 막았고, 이 결함은 원본·출력 대응 단계의 증명 부족이었다.

패치 `hwpx-empty-text-boundaries.patch`를 제자리에서 고쳤다(SHA-256 `3724832d27606dd7c27fcf72400a26aa1ce570084d6485e941be4bde72cf6a73`, 같은 13개 파일, 앞 10개 패치 불변, pinned RHWP에 11개 전체 적용이 개발 원본과 동일). `--locked --offline` Release generation `629d15fd37b09f771b6228e45335ea88218dc466aecb6af720ddc477a8eec93d`, WASM `423a84ffff6f44ff42cece97775062d86cc3b217f7fcef22b6b19955da2df8a4`. 세대 제한으로 선택되지 않은 `97714665…`를 해시와 함께 ignored 보관소로 옮겼다. 검증: Rust `empty_text` 47/47, 전체 RHWP library 3823 통과·121 실패(이전과 같은 집합)·13 무시, 교차 회귀 7개 PASS, 실제 WASM 734개 코퍼스 결과 분포(성공 578·safe 157·unsafe 412·unknown 9·safe 회귀 0) 그대로이며 직전 generation `89fbb642…`와 **578개 출력 모두 바이트 동일**, 원래 대상 출력 `78be2943…`·57/111/1428/127 위치 보존 그대로. 코퍼스에 중첩 내용만 다른 같은 키 컨트롤 쌍이 없어 새 거부는 0이다. native 앱 재검증은 도달 가능한 저장 동작 변화가 코퍼스에서 관측되지 않아 실행하지 않았다(NOT RUN). 상세는 [acceptance JSON](hwpx-duplicate-id-acceptance-2026-11-02.json)의 `topologyBoundaryHardening`.

### 위상 검증 경계 마감: 중첩 값의 의미 있는 공백과 거부된 내보내기의 ID 변경 (2026-11-03 마감)

앞 절(`755d6d3`)에 남은 두 경계를 반례로 확인하고 고쳤다(교정 전 코드에서 새 회귀 실패, 교정 뒤 통과).

- **중첩 컨트롤 값의 공백.** 모호성 지문은 공백뿐인 글을 버려 `hp:stringParam xml:space="preserve"` 값이 `" "`/`"  "`, `""`/`" "`인 두 `CLICK_HERE` 필드를 같은 컨트롤로 보았고, 출력에서 둘을 바꿔도 받아들였다. 반대로 `&#x20;`(문자 참조)과 `" "`, `<a/>`와 `<a></a>`는 표기만 달라도 다르다고 보아 거짓 거부를 냈다. 이제 지문은 원소의 **의미 값**을 쓴다: 글·CDATA·참조를 풀어 이어 붙이고, 잎 원소의 값은 비었거나 공백뿐이어도 남기며, 구조 자식 사이의 공백(들여쓰기)만 버리고, 빈 원소 두 표기를 같게 본다. 출력과 비교하는 사건 키와 생성 조각 출력은 그대로라 직렬화기 정규화·`pageNum` 접기·인라인 탭 정규화·`autoNumFormat` 회귀가 유지된다. 실제 WASM 패키지 내보내기에서도 두 반례는 `ambiguous control event identity`로 거부되고 바이트가 없으며 원본은 그대로다.
- **거부된 내보내기의 ID 변경.** 예약(101)된 지연 운반체를 0으로 되돌리면, 내보내기의 `prepare_paragraph_ids`가 검증 전에 그 운반체와 **관계없는 다른 지연 문단까지** 새 ID로 예약한 뒤에야 위상 검증이 거부했다(관측 `[1,1,3,4]`). 이제 위상이 묶인 모든 문단의 식별(고정된 거부 사유 포함)을 **어떤 할당·예약보다 먼저** 검사한다. 거부된 내보내기는 같은 원인·바이트 없음이며, 문제 운반체와 다른 문단의 값, `hwpx_paragraph_next`가 바뀌지 않고 반복해도 같다. 예약값을 되돌리면 다시 내보내지고 그때 다른 지연 문단이 정상 예약된다. 중간 후보에서 분할 거부의 오른쪽 반쪽(왼쪽 고정 위상의 복제)이 원인 대신 `owner changed`로 보고된 회귀를 실제 WASM 시험이 잡아, 고정 사유를 먼저 보고하도록 고쳤다(전용 회귀 추가). 일반적인 내보내기 트랜잭션 보장을 뜻하지는 않는다.

패치를 제자리에서 고쳤다(SHA-256 `fced0270450adc639d9d432b8857befbf399fa65b2da4e73e1e9e0d8cd6084e2`, 같은 13개 파일, 앞 10개 패치 불변, 11개 전체 적용이 개발 원본과 동일). `--locked --offline` Release generation `853a0689147be17336110a227b22bef2054629430d53126076b84879308329b4`, WASM `77d01d6c004d74948681b208370740cefd576e26f10712abe6a7bc5ba3a32285`. 세대 제한으로 `89fbb642…`와 중간 후보 `c20da3d8…`를 해시와 함께 ignored 보관소로 옮겼다. 검증: Rust `empty_text` 51/51, 전체 RHWP library 3827 통과·121 실패(이전과 같은 집합)·13 무시, 교차 회귀 7개 PASS, 실제 WASM 734개 코퍼스 분포 그대로(성공 578·safe 157·unsafe 412·unknown 9·safe 회귀 0·새 거부 0)이며 직전 `629d15fd…`와 578개 출력 모두 바이트 동일, 원래 대상 `78be2943…`·57/111/1428/127 그대로. 도달 가능한 앱 저장 동작 변화가 코퍼스에서 관측되지 않아 native 앱 시험은 실행하지 않았다(NOT RUN). 상세는 [acceptance JSON](hwpx-duplicate-id-acceptance-2026-11-02.json)의 `topologyFinalClosure`.

### DOCX 관계 참조 위치 및 WordCraft 재열기 진단 (2026-11-05)

이 절은 pinned WordCraft `fc41918814f62645b6746ed68e71e8c2c2e85d6f`를 사용한 합성 진단의 결과다. 테스트는 `src-tauri/src/services/save/docx_diagnostics.rs`에 있으며, 임시 진단 접근자는 `cfg(test)` 전용이다. 생산 검증 정책이나 엔진은 변경하지 않았다.

**관계 참조 위치 경계.** 동일한 `r:id` 참조를 다른 요소/문단으로 옮기거나 일관되게 재번호한 합성 XML(A2/A3/A4), DrawingML 클릭 링크 위치 사례(A7), 이미지 `r:embed` 위치 사례(A8), Strict 참조 사례(A9)는 XML 관계 비교기와 패키지 비교기에서 통과했다. `reopen_equal=true`를 주입한 `service::check_saved` 및 저장 경계도 통과했다. 이는 해당 비교기가 부모/조상 위치를 보존하지 않는다는 증거이며 실제 WordCraft 재열기 성공을 뜻하지 않는다. 대상 변경(A5)과 참조 교환(A6)은 비교기 및 하위 검사에서 거부되었다. 동일 위치(A1)는 통과했다.

별도 실제 모델 검사에서 본문 하이퍼링크 참조를 옮긴 사례는 `DocxModel::same_as`가 거부했고, 그 결과를 사용한 저장 서비스는 `ReopenMismatch`로 발행을 거부했다(원본 SHA-256 불변, dirty 유지, 임시 파일 없음). 반면 실제 `Session`의 링크 삽입 명령으로 링크가 첫 문장에서 둘째 문장으로 이동한 경우에는 변경이 모델에 표현되어 모델/출력 비교와 저장이 통과했다. 따라서 본문 관계 참조 위치는 편집 가능한 내용일 수 있으며, 위치 비교기를 일괄 강화하면 정당한 편집을 막을 수 있다. 이 실험은 모든 관계 참조 요소의 의미가 모델에서 다뤄진다는 것을 증명하지 않는다. 특히 pinned DOCX reader에서 `a:hlinkClick` 처리를 찾지 못했다. A7의 모델 불일치는 DrawingML 클릭 링크 의미를 완전하게 보존한다는 증거가 아니므로 해당 지원 범위는 미확인/미지원으로 취급한다. 현재 증거로 무단 위치 변경의 실제 발행 취약점은 입증되지 않았고, 모든 유형에 대해 부재가 입증된 것도 아니다.

추가 호환성 사례에서는 WordCraft가 하이퍼링크 일부에 주석을 넣으며 관계 참조를 주석 경계의 두 조각으로 나누었다. 모델 재열기는 같다고 판정했지만 관계 비교기의 순서/중복 계약은 이를 거부했다. 수정하지 않았다. 후속 개선은 주석 범위와 링크 대상이 모델에서 독립적으로 증명된 경우에만 같은 링크의 분할을 허용해야 하며, 전역 위치 무시나 위치 동일성 강제는 적절하지 않다.

**리치 DOCX 재열기 경계.** 11개 생성 fixture(B0 기본, B1 헤더, B2 푸터, B3 본문 인라인 PNG, B4/B5 헤더/푸터 이미지, B6 헤더+푸터, B7/B8 헤더/푸터+본문 이미지, B9 헤더+푸터+본문 이미지, B10 기존 결합 사례)에서 기능 존재를 확인했다. 모두 최초 모델→내보내기→재열기 비교와 미편집 preflight가 통과했고, 주석 추가 후 패키지 비교도 통과했다. 주석 후 B0와 B3은 모델 비교 및 실제 저장에 성공했다. B1, B2, B4–B10은 주석 후 모델 비교에서 처음 실패하여 실제 저장이 `ReopenMismatch`로 거부되었다(원본 SHA-256 불변, dirty 유지, 임시 파일 정리). 따라서 이 fixture들의 최초 실패는 주석 전 라운드트립이나 preflight가 아니라 경계 3(로드된 모델에 주석 추가 후 내보내기/재열기 비교)이다.

**진단 시험 강화(2026-11-05).** `diagnostic_b_feature_matrix`는 이제 B0/B3의 게시 바이트·dirty 해제·임시 파일 없음을, B1·B2·B4–B10의 거부가 `UnsafeSave`이고 근거가 정확히 `[ReopenMismatch]` 하나임을(`SharedDirectory`·`FileConflict`·`PartChanged` 등 다른 분류는 실패), 원본 SHA-256 불변·dirty 유지·임시 파일 없음·저장 표 해제를 단언한다. `diagnostic_a_comment_splits_hyperlink_conservative_refusal`은 실제 geul DOCX 세션(`docx::edit`, 3개 연산 모두 수락·메모 1개 생성)에서 엔진 분할(관계 참조 1→2), 모델 재열기 동등, 비교기 거부(`PartAdded` comments/commentsExtended, `PartChanged` `[Content_Types].xml`·본문 rels, `ReopenMismatch` 없음), 실제 저장 서비스가 같은 판정으로 거부함을 구분해 확인한다(비교기는 바꾸지 않음). `diagnostic_a_engine_authorized_link_edit`는 WordCraft의 실제 표현(`Paragraph.text` UTF-8 바이트 위에 `Run.len`·`CharProps.link`)으로 편집 전 `First`(0..5)=`https://example.org/A`, `Second`(5..11)=`#bookmark`가 편집 후·내보내기/재열기 후·실제 게시 파일에서 서로 바뀌었음을 단언한다(11..17은 링크 없는 책갈피 표지 두 개). 보호 실행(`scripts/cargo-geul.py test`)은 bwrap 아래 `SharedDirectory`로 게시 경로 시험이 실패하며(기반 환경 문제, 기준선과 동일), 직접 `cargo test --locked --offline`로 6개 모두 통과했다. 저장 정책은 바꾸지 않았다.

첫 모델 차이는 콘텐츠 손실이 아니라 WordCraft 내부 part ID 재배치였다. 헤더 단독은 주석 part가 2→1, 기본 헤더 참조가 1→2로 바뀌었고 푸터도 동일한 형태였다. 헤더+푸터에서는 원래 H=1/F=2/C=3이 재열기 뒤 C=1/H=2/F=3이 되었다. 테스트 전용 의미 루트 매핑으로 part ID를 재명명한 뒤 part 내용의 완전한 동등성과 전체 모델 동등성을 확인했고, 11개 fixture 모두 이 반사실 비교를 통과했다. 이 검사는 해당 생성 사례에서 다른 차이를 찾지 못했다는 뜻이지 생산 동등성 규칙의 교체나 일반적인 그래프 등가성 증명은 아니다. 헤더/푸터 XML, 해당 source-part 소유 `.rels`, 기존 인라인 미디어 바이트는 이 사례들에서 변경되지 않았다. 이미지 fixture는 생성한 1×1 인라인 PNG에 한정되며 부동/앵커 이미지 등은 검증하지 않았다.

확인한 WordCraft 경로는 다음과 같다. `crates/engine/src/cmd/review.rs::new_comment`는 새 Comment part를 현재 최대 ID 뒤에 추가한다. DOCX reader `crates/docx/src/read/mod.rs`는 주석을 먼저 읽어 part를 만들고, `read/story.rs`의 섹션 처리에서 헤더/푸터 story를 지연 생성한다. writer `crates/docx/src/write/mod.rs::hf_rel`은 내부 ID가 아니라 발견 순서로 헤더/푸터 파일명을 정한다. `wordcraft_doc::Document`의 파생 `PartialEq`는 part ID와 내용을 포함한 모델 전체를 비교한다. `DocxModel::same_as`는 재열기한 문서에 그 동등성을 적용한다. 이는 생성 사례에서 관측한 비의미적 ID 재할당과 `ReopenMismatch` 사이의 직접 경로다. `Paragraph`의 별도 비교는 revision 캐시만 제외하며, 미디어 바이트는 값으로 비교된다.

안전한 후속 수정은 전역 `Document`/undo 동등성을 약화하는 대신, WordCraft에 명시적이고 검증된 DOCX round-trip 의미 동등성 경로를 두는 것이다. 섹션의 헤더/푸터 참조와 주석 ID 등 안정된 루트에서 시작해 모든 part 참조 간선의 별칭 관계를 보존하는 완전한 일대일 대응을 만들고, 대응된 part·story·주석·스타일·미디어 바이트 및 의미 있는 속성은 그대로 비교해야 한다. 누락·병합·분할·모호한 part나 미지원 참조는 거부해야 한다. 구현 전 `Part` ID 참조의 전체 사용처를 확인해야 한다. 회귀 수용은 B0–B10 실제 first/second published-file reopen 및 geul preflight/save 경로를 포함하고, ID 순열만 허용하되 내용·미디어·차원·앵커·섹션 참조 변경은 거부해야 한다. 이 진단에서는 엔진 수정이나 T013 기능 완료를 주장하지 않는다.

합성 비교/주입 검사, 실제 WordCraft 모델/저장 검사, 외부 Office 호환 검사는 서로 다른 증거다. 이 작업에서 native 앱 및 Microsoft Word 검증은 실행하지 않았다. T012 및 T013은 미완료 상태로 유지한다.

구현 제안의 적용 지점은 WordCraft의 명시적 `roundtrip_equivalent(authoritative, reopened) -> Result<bool, UnsupportedReference>` 같은 별도 API와 geul `DocxModel::same_as` 호출부다(이름은 제안이며 미구현). `Document::PartialEq` 자체나 저장 서비스의 필수 재열기 결과를 제거하지 않는다. reader를 헤더 먼저 읽도록 재배치하는 것만으로는 임의 편집 순서와 두 번째 새 메모의 ID 할당을 안정화할 수 없다. 역할별 전단사 비교는 모든 섹션과 중첩 섹션, `Comment.part`, note part, shape/textbox story 등 실제 ID 간선을 열거하고 공유 참조·순환을 보존해야 한다. 미지원 구조는 기존처럼 거부하고, 중복 내용의 서로 다른 story를 합치거나 정렬·해시만으로 같다고 간주하지 않는다. 단위 회귀는 ID 순열 허용과 별칭 변경·part 누락·헤더 텍스트·이미지 bytes/차원·주석 앵커 변조 거부를 함께 요구한다. 엔진 왕복 후에는 B0–B10에서 첫 게시 파일을 실제 다시 열어 둘째 메모까지 저장하는 geul 수용 시험을 실행해야 한다. 관계 위치의 일반 동일성 검사는 제안하지 않는다.

진단 범위는 한 섹션의 기본 헤더/푸터와 같은 67-byte PNG를 사용하는 인라인 그림이다. first/even 헤더, 여러 섹션, 별도 이미지 파일 간 basename 충돌, 부동 그림, 도형/textbox/각주/미주 그래프의 왕복 동등성은 이 행렬로 입증하지 않았다. 진단용 전단사 함수는 생성 fixture만 다루며 생산 API로 재사용하지 않는다.

### DOCX 의미 왕복 동등성 통합 (2026-11-05)

위 "리치 DOCX 재열기 경계"와 B 행렬의 `ReopenMismatch`는 **통합 전** 동작이다(기록 보존: 진단 커밋 `ad89e53`). 이 절은 그 뒤의 생산 계약이다.

**WordCraft 의존성(로컬 전용).** 원래 고정 `fc41918814f62645b6746ed68e71e8c2c2e85d6f` → API 커밋 `d38fec08da2aea0d8ffc00d00f4629b71d390608` → 감사 뒤 시험 보강 `90b1877180ffb78959f55c642cba8d13172ec796`(로컬 브랜치 `geul/semantic-roundtrip-equivalence`). geul gitlink는 `90b1877`을 기록한다. **두 커밋은 원격에 없다**: 새 clone은 이 gitlink를 받을 수 없으므로 WordCraft 커밋을 게시하기 전에는 재현 가능한 의존성이 아니다.

**API 계약.** `wordcraft_doc::roundtrip::roundtrip_equivalent(authoritative, reopened) -> Result<bool, RoundTripError>`(세부: `compare_roundtrip(.., &RoundTripLimits) -> Result<Equivalence, RoundTripError>`). 두 문서를 안정 루트(메모 ID 순, 마지막 섹션 머리글/바닥글 역할, 각주 구분선, 본문)부터 같은 구조 순서로 함께 걷고, Part ID를 담는 모든 자리(모든 `SectionProps`의 `HeaderSet` — `last_section`·문단 `section`(본문·Part·표 셀)·`fmt_change.old` 연쇄, `Comment.part`, `NoteRef.id`, 중첩 그룹 포함 `Shape.story`, `TextBody.next`)를 짝지어 양방향 일대일 대응을 만든다. 종류 보존, 분할(공유 Part가 둘로)·병합(서로 다른 Part가 하나로) 거부, 전체 Part 포함을 요구하고 나머지 모든 필드는 값으로 비교한다(내용이 같아도 별개 Part는 별개). 탐색·백트래킹 없음, 반복적 순회, 기본 한도 5천만 방문·중첩 512(리더 XML 깊이 256보다 큼). 끊긴 참조·위치와 맞지 않는 Part 종류·루트에서 닿지 않는 authoritative Part·한도 초과·할당 실패는 `Err`이며 동등이 아니다. `Document::PartialEq`(실행 취소·편집 기록)는 바뀌지 않았다.

**감사 결과.** `fc41918..d38fec0` 전체(5개 파일)를 직접 읽었다. 알고리즘 결함은 찾지 못했다. 다른 `u32` 필드(`ShapeExtra.id`·`ConnEnd` 그리기 ID, `ins`/`del`/`rev` 수정 색인, `PermStart.id`, `CoreProps.revision`, `Comment.parent`)는 Part ID가 아니어서 값 비교가 맞다. 메모 삭제는 그 Part도 지워 고아를 남기지 않는다. 시험 공백 두 가지(중첩 그룹 안 텍스트 상자 재지정, 각주↔미주 Part 종류 치환)를 `90b1877`에 시험으로 보강했다.

**geul 통합.** `DocxModel::same_as`만 바꿨다: 출력 바이트를 엔진으로 한 번 다시 읽고 `roundtrip_equivalent`가 `Ok(true)`일 때만 true. `Ok(false)`·`Err`·읽기 실패는 false → 저장 증거 단계가 `ReopenMismatch`로 거부(원본 불변). 호출부는 실제 저장·복구 checkpoint(`adapters/wordcraft/commands.rs`)와 빈 문서 생성 검증(`services/files.rs::blank_docx`)이며 둘 다 DOCX 재열기 검증 경계다. 진단용 `DocxModel::round_trip()`의 `model_equal`은 구조 동등성 그대로다(저장 경로 아님). 패키지 보존·관계 비교기·T009 단계는 바꾸지 않았다.

**실제 저장 수용(`services/save/docx_semantic_acceptance.rs`).** B0–B10 각각: preflight → 타입 `DocxOp::Comment` → 실제 `docx::save`(강제 `reopen_equal` 없음) → 디스크의 게시 파일로 새 세션 → preflight → 둘째 메모 → 둘째 게시 → 다시 불러오기. 머리글/바닥글 경우는 구조 동등성이 false(ID 순열이 실제로 일어남), 의미 동등성 true를 매번 단언한다. 최종 파일에서 메모 2개(본문·작성자 `geul`), 머리글/바닥글 글, 미디어 바이트·그림 크기, 원본 머리글/바닥글/미디어·그 `.rels` 부분 바이트 동일, 임시 파일 없음, 저장 표 해제를 확인했다. 11/11 통과. 공유·별개(같은 내용) 첫 페이지 머리글과 연결된 텍스트 상자도 두 번 게시 뒤 별칭·연결 위상이 같다. `diagnostic_b_feature_matrix`와 `comment_real_rich_export_preservation_and_reopen_guard`는 새 계약으로 바꾸되 구조 동등성 false(과거 원인)를 계속 단언한다.

**적대적 거부(주입 출력 경계 시험).** 권위 모델은 실제 편집 세션이고, 출력만 WordCraft writer로 쓴 변조 모델이나 바이트 패치다. `same_as`는 실제로 계산해 `service::save`에 넘긴다. A 머리글 글·B 바닥글 글·C 그림 바이트·D 그림 크기·E 메모 글·F 메모 작성자·G 메모 앵커 이동·H 머리글/바닥글 참조 교환·I 공유 Part 분할·J 같은 내용 별개 Part 병합·K 참조된 부분 삭제·L 예상하지 않은 Part(짝수 머리글)·M Part 종류 변경(`headerReference`→`footerReference`)·N 텍스트 상자 연결 끊기·O 순열 + 본문 변경·P 없는 관계 ID·Q 증명할 수 없는 구조(`Err(UnexpectedPartKind)`) 모두 API가 동등이 아니고 `same_as` false, 저장은 정확히 `[ReopenMismatch]`로 거부, 원본 SHA-256 불변, dirty 유지, 임시 파일 없음, 저장 표 해제. 고아 Part는 writer가 버려 출력이 이미 단순 차이(`parts.len`)가 되므로 `Err` 경로 시험에는 쓸 수 없었다. 한도 초과(`LimitExceeded`)는 API 수준에서만 시험했다(같은 `Err` 경로).

**성능(디버그 빌드, `measure_semantic_vs_structural_comparison`, `--ignored`).** 비교 1회 평균: 기본 0.011 ms(구조 0.023), 머리글+바닥글·그림·메모 2개 0.011 ms(구조 비교는 첫 ID 차이에서 0.002 ms에 false로 끝남), 2000문단·Part 42·메모 40 0.379 ms(구조 0.346). 같은 문서 DOCX 다시 읽기 14.4 ms. `same_as`는 여전히 한 번만 파싱한다. 방문 계수기는 API 작업량 한도일 뿐 프로세스 메모리 한도가 아니다.

**남은 한계.** 하이퍼링크 일부 메모의 관계 참조 분할은 여전히 관계 비교기가 거부한다(바꾸지 않음). 각주·미주·목차·변경 내용 추적은 계속 planned(T013 미완료). 외부 Microsoft Word 호환성과 native 앱 시험은 NOT RUN.

### 의미 왕복 동등성 후속 검증·안정화 (2026-11-05)

**WordCraft 2차 독립 감사 — PASS(구현 결함 없음).** `fc41918..d38fec0`, `d38fec0..90b1877`의 실제 로컬 소스를 다시 읽었다(`roundtrip.rs`는 `d38fec0` 이후 바뀌지 않음, `90b1877`은 시험만). 모든 Part ID 자리가 `pair()`를 거치고 그 밖의 `u32`(그리기 ID, 수정 색인, 권한 ID, 메모 부모)는 값 비교임을 확인했다. `Block`은 `_` 갈래로 비교하므로 새 변형은 컴파일 오류가 아니라 `Different`(거부)가 된다(fail-closed, 단 컴파일 가시성은 없음). 시험 공백(표 중첩·섹션 변경 연쇄 20단계의 가장 깊은 참조 비교와 `max_depth` 거부, Part가 아닌 ID가 순열 아래서도 값 비교됨)을 시험 전용 커밋 `e723192f0c1c1a2229a11ad87abccdc8b4ae517c`로 보강했다. geul gitlink는 `e723192`을 기록한다.

**적대적 시험의 근거 범주 분리(`docx_semantic_acceptance.rs`).** 이전 `refuse`는 다시 읽기 실패를 `None`으로 허용해 비교기가 실행됐는지 증명하지 못했다. 이제 셋으로 나눈다.
- 범주 2(의미 비교기 거부, `refuse_semantic`): 출력이 반드시 다시 열리고 `compare_roundtrip`의 정확한 결과를 단언한다. A·B·E·G·H·K·O `Field("paragraph")`, C `Field("media")`, D `Field("inline object")`, F `Field("comment")`, L·P·I·J `Field("parts.len")`, M `ReferencePresence("header/footer default")`, N `ReferencePresence("text box link")`, Part 수를 맞춘 I `Split{..}`, J `Merge{..}`. A–P 가운데 파서 거부는 하나도 없었다(헤더 부분 파일 삭제·없는 관계 ID도 리더가 모델로 만들고 비교기가 거부).
- 범주 1(파서 거부, `refuse_parser`): R1 잘린 패키지, R3 `word/document.xml` 없음. 다시 열기 실패를 단언하고(비교기 미실행), `same_as` false, 저장은 `[ReopenMismatch]`로 거부, 패키지 계층 판정은 따로 `OutputMalformed`.
- **확인된 경계(R2):** WordCraft 리더는 `word/document.xml`의 잘못된 XML(끝 태그 불일치, 깨진 시작 태그)을 너그럽게 읽어 **동등한 모델**을 만든다. 따라서 `same_as`는 true이고(통합 전 구조 동등성도 같았음) 저장을 막는 것은 패키지 계층의 `OutputMalformed`다. 엔진 게이트는 XML 정형성 검사가 아니다. 이 시험은 그렇게 단언한다.
- 모든 범주에서 원본 SHA-256 불변, dirty 유지, 임시 파일 없음, 저장 표 해제.

**Q의 경계 재분류.** `authoritative_model_corruption_is_refused`(구 `equivalence_error_is_refused`)는 출력 변조가 아니라 시험 전용 `diagnostic_document_mut`로 **권위 모델을 손상**시키는 시험이며 사용자 편집이 아니다. `Err(UnexpectedPartKind { side: Authoritative, expected: Header, found: Footer })`를 정확히 단언한다. 출력만으로 `Err`를 만드는 사례는 없었다(리더는 끊긴·종류가 틀린 참조를 만들지 않음: K·M·P가 단순 차이로 다시 열림).

**연결 텍스트 상자 위상.** `aliases_and_linked_text_boxes_publish_twice`는 사슬 개수 대신 ID에 의존하지 않는 `StoryGraph`(머리글/바닥글 역할, 메모 표지를 뺀 안정 앵커의 도형과 도형 속성, 발견 순서로 매긴 노드의 공유/별개 정체성, `next` 간선과 종료, `text_box_chains` 진입점과 순서, 이야기 내용·`TextBody` 속성)를 원본 → 첫 게시 파일 → 첫 다시 열기 → 둘째 게시 파일 → 최종 다시 열기에서 같다고 단언한다. 고정 사실(두 별개 상자, 첫째 → 둘째, 끝남)도 따로 단언하고, N에서 연결을 끊으면 그래프가 달라짐도 확인한다.

**`blank_docx()` 오류 분류 수정.** 이전에는 preflight가 safe이고 `same_as`가 false이면 `UnsafeSave { preservation: Safe, findings: [] }`라는 모순된 근거를 돌려주었다(재현 시험으로 확인). 이제 `blank_verdict`가 preflight unsafe면 그 판정 그대로(재열기 검사는 하지 않음, 기존 순서), safe인데 동등성이 증명되지 않으면(`Ok(false)`, `Err`, 다시 읽기 실패) `check_saved`와 같이 `ReopenMismatch`를 더한 unsafe 판정, 둘 다 통과면 성공을 돌려준다. 내보내기·열기 실패는 그대로 `Internal`이다.

**WordCraft 의존성 재현성 — 미해결(원격 차단).** 읽기 전용 확인(2026-11-05):
- 로컬: `d38fec0`, `90b1877`, `e723192`은 `external/wordcraft`의 로컬 브랜치 `geul/semantic-roundtrip-equivalence`에만 있다.
- 원격: `.gitmodules` URL `https://github.com/storytold/wordcraft.git`(`shallow = true`)의 `ls-remote`에 세 커밋을 가리키는 ref가 없고, GitHub API는 세 SHA 모두 422(커밋 없음), `fc41918`은 200(`v0.7.0` 태그). `git fetch --depth 1 <url> 90b1877…`은 `upload-pack: not our ref`. `MinGyu2/wordcraft` 포크는 없다(404).
- geul `origin/master`는 이미 `fefe420`(gitlink `90b1877`)으로 공개되어 있다. **현재 공개 master의 새 clone은 WordCraft 서브모듈을 받을 수 없다.**
- 권장(B): 사용자 소유 WordCraft 포크(또는 전용 의존성 저장소)에 `geul/semantic-roundtrip-equivalence`(`fc41918` → `d38fec0` → `90b1877` → `e723192`)를 올리고 보호 태그를 단 뒤, geul `.gitmodules` URL을 그 저장소로 바꾸는 커밋을 만들고 geul을 올린다. 포크·push·URL 변경은 이 작업에서 허용되지 않아 실행하지 않았다. `shallow = true` 서브모듈은 gitlink SHA를 깊이 1로 직접 가져오므로 그 SHA가 원격 ref에서 도달 가능해야 한다(브랜치 삭제·강제 push 시 다시 깨짐 → 태그 권장). 되돌리기(D)는 코드와 gitlink를 함께 되돌려야 하며(gitlink만 되돌리면 빌드 불가) 리치 DOCX가 다시 `ReopenMismatch`가 되므로 선택하지 않았다.

### 3차 검증: 파서 거부 판정 고정·WordCraft 변이 감사·의존성 재현성 재확인 (2026-11-05)

**R1/R3 패키지 판정 단언(`7e7fb0f`).** R1(잘린 패키지)·R3(`word/document.xml` 없음)은 둘 다 `check_saved`의 형식 판별(`detect` → ZIP 디렉터리 읽기 실패 / 주 부분 없음)에서 막히고, 그 계약은 `Finding::at(OutputMalformed, "container")` 뒤 즉시 반환이다(자원 실패 시 `LimitExceeded`가 더해질 수 있어 단독이 아님). 호출부가 이제 그 판정의 **포함**을 단언하고, 패키지 계층 평가에 `ReopenMismatch`가 없음도 확인한다. 파서 거부·`same_as` false·저장 거부(`[ReopenMismatch]`)·원본/세션 검사는 그대로이며, R2(리더가 관대해 엔진 동등, 패키지 계층 `OutputMalformed`만 거부)는 별도 범주로 남는다.

**WordCraft 3차 감사 — 구현 PASS, 시험 공백 1건 수정(`42e8a67`).** 감사 범위 `fc41918..e723192`(커밋별: `d38fec0` 구현 5개 파일, `90b1877`·`e723192` 시험만). `roundtrip.rs`는 `d38fec0` 이후 그대로다. 실제 기본값 `max_steps = 50_000_000`, `max_depth = 512`. 시험 이름이 아니라 효력을 확인하려고 `roundtrip.rs`에서 순회·검사를 하나씩 없앤 변이 12개(표 셀, `fmt_change` 연쇄, 그룹 구성원, `TextBody.next`, 문단 섹션, Part 블록, 도형 story, 각주 짝짓기, 전체 포함 검사, 분할/병합 검사, 종류 검사, 깊이 한도)를 시험했고 모두 하나 이상의 시험이 잡았다. 다만 `e723192`의 "20단계 표 안쪽 참조 변경" 음성 사례는 실제로 `Field("paragraph")`로 판정되었다: 루트(마지막 섹션) 머리글이 다른 글의 Part로 바뀌는 앞선 차이가 결정해, 가장 깊은 참조 비교를 증명하지 못했다. 같은 내용의 두 Part로 다시 만들어 안쪽 참조만 바뀌게 하고 정확한 `Merge { reopened: 1 }`을 단언한다(셀 순회를 없애면 `Err(UnreachablePart)`가 됨을 변이로 확인). n18 첫 사례도 정확한 `Merge`로 고정했다. 구현은 바꾸지 않았다. 작업 스택은 표 행마다 셀 수만큼 미리 쌓이므로 메모리는 입력 문서 크기에 비례할 뿐 독립된 상한은 없다(`try_reserve`로 실패는 오류). 방문 계수기는 프로세스 메모리 한도가 아니다. geul gitlink는 `42e8a67`.

**의존성 재현성 — 미해결, 게시 승인 대기(2026-11-05 읽기 전용 재확인).**
- geul 공개 `master` = `020c25e`(gitlink `e723192`), `.gitmodules` URL `https://github.com/storytold/wordcraft.git`, `shallow = true`.
- `storytold/wordcraft`(공개, `MIT OR Apache-2.0`, NOTICE 있음): `ls-remote` 4439개 ref 중 해당 커밋 없음, API는 `d38fec0`·`90b1877`·`e723192`·`42e8a67` 모두 422, `fc41918` 200. 빈 저장소의 `fetch --depth 1 <SHA>`는 `fc41918` 성공(얕은 SHA 직접 받기는 동작함), `e723192`는 `not our ref`.
- 공개 geul의 새 clone에서 `git submodule update --init external/wordcraft`는 `Direct fetching of that commit failed`(exit 128)로 실패하고 서브모듈을 업스트림 `main`(`5a4c45e`)에 체크아웃한 채 남긴다. 즉 오류를 무시하면 **다른 WordCraft 리비전**으로 빌드하게 된다.
- `MinGyu2/wordcraft` 포크는 없다(404).
- 권장 계획(승인 필요, 실행하지 않음): 공개 포크 `MinGyu2/wordcraft`에 브랜치 `geul/semantic-roundtrip-equivalence`와 주석 태그(`geul-roundtrip-42e8a67`)로 `fc41918 → d38fec0 → 90b1877 → e723192 → 42e8a67`을 올리고, 원격 SHA·얕은 SHA 받기를 확인한 뒤 geul `.gitmodules` URL을 `https://github.com/MinGyu2/wordcraft.git`로 바꾸는 커밋을 만들고 geul `master`를 올린다. 이미 공개된 `fefe420`·`1caf267`·`ed68414`·`020c25e`의 `.gitmodules`는 그대로 storytold를 가리키므로, 그 과거 커밋을 새 clone에서 꺼낼 때는 `git submodule set-url`/`sync`가 필요하다. 라이선스는 업스트림 LICENSE·NOTICE 유지로 재배포 가능하다.

### WordCraft 의존성 재현성 복구 (2026-11-05)

사용자의 명시 승인(대상·연산 지정)에 따라 실행했다.
- 사용자가 공개 포크 `MinGyu2/wordcraft`(부모 `storytold/wordcraft`, 공개)를 만들었다. `git push`(강제 아님) 한 번으로 새 ref 두 개만 만들었다: 브랜치 `geul/semantic-roundtrip-equivalence` → `42e8a67`, 주석 태그 `geul-roundtrip-42e8a67`(태그 객체 `419306e`) → `42e8a67`. 포크 `main`(`5a4c45e`)과 업스트림은 바뀌지 않았다. 브랜치 보호는 꺼져 있다(`protected: false`). 태그 보호는 인증 없이 확인할 수 없어 보호되었다고 주장하지 않는다.
- 원격 확인: API에서 `fc41918`·`d38fec0`·`90b1877`·`e723192`·`42e8a67` 모두 200. LICENSE-APACHE·LICENSE-MIT·NOTICE·`roundtrip.rs`가 태그에 있다. 빈 저장소에서 익명 HTTPS `fetch --depth 1 <42e8a67>` 성공(얕은 저장소, `FETCH_HEAD` = `42e8a67`), 태그 받기도 같은 커밋.
- geul `bf77e7e`(`.gitmodules` 한 줄: WordCraft URL → `https://github.com/MinGyu2/wordcraft.git`, `shallow = true`·gitlink `42e8a67`·rhwp 그대로)를 빨리 감기로 `master`에 올렸다(`0a67aa0..bf77e7e`, pre-push 민감정보·Gitleaks 전체 이력 검사 통과). 원격 `master`의 `.gitmodules`와 gitlink를 API로 확인했다.
- 새 clone 확인: `git clone --no-recurse-submodules https://github.com/MinGyu2/geul.git` → `git submodule update --init external/wordcraft`가 exit 0으로 포크에서 `42e8a67`을 깊이 1로 직접 받았다(분리 HEAD, 깨끗, alternates 없음, rhwp는 초기화하지 않음). 그 clone의 소스로 WordCraft `roundtrip` 시험 23개 통과, geul 백엔드 `cargo check --lib` 통과. geul lib 시험은 공개 clone에서 컴파일되지 않는다: `tests/`는 `45b63b4`부터 비공개 저장소이고 lib 시험이 rhwp 샘플을 `include_bytes!`하므로 rhwp 서브모듈(약 6.7 GB)이 필요하다(NOT RUN).
- 과거 커밋: 이용할 수 없는 의존성을 처음 넣은 커밋은 `fefe420`(gitlink `90b1877`)이고, `1caf267`·`ed68414`(`90b1877`), `020c25e`·`7e7fb0f`(`e723192`), `0a67aa0`(`42e8a67`)도 `.gitmodules`가 업스트림을 가리킨다. 이력은 다시 쓰지 않았다. 해당 SHA는 모두 포크 브랜치에서 도달 가능하므로 `git config submodule.external/wordcraft.url https://github.com/MinGyu2/wordcraft.git` 뒤 `git submodule update --init external/wordcraft`로 재현된다(`020c25e` → `e723192`을 새 clone에서 확인).

### T013 각주·미주 저장 규칙 (2026-11-05)

엔진이 각주·미주를 더한 DOCX 출력의 패키지 차이(실측): 새 `word/footnotes.xml`(`endnotes.xml`), `[Content_Types].xml`에 그 `Override` 하나, 본문 관계에 그
부분의 내부 관계 하나(다른 관계 `Id`는 다시 매김), `word/settings.xml`의 `w:footnotePr`(`w:endnotePr`) 끝에 구분선 참조
`<w:footnote w:id="-1"/><w:footnote w:id="0"/>` 둘. 규칙(`package::compare_saved_docx`):
- 처음 더함: 기존 메모 덧붙임 규칙을 덧붙일 수 있는 부분 표로 일반화했다(`parts_added`): 메모 부분(원본에 메모 부분이 하나도 없을 때)과 각주·미주 부분
  (원본에 그 부분이 없을 때) 가운데 새로 생긴 것만 있고, 내용 형식 목록 = 원본 + 그 부분들의 `Override`, 본문 관계(`Id` 제외) = 원본 + 그 부분들의 내부
  관계, 본문 r:* 참조 연결이 일관될 때만. 각주·미주가 있으면 `note_settings_added`가 settings 정규화 사건 열에서 그 설정 요소(뿌리 바로 아래) 끝의
  참조 둘을 정확히 확인·제거한 결과가 원본과 같아야 한다. 메모만 더한 출력의 판정은 그대로다(`comment_parts_added`는 일반형의 감싸개).
- 이미 있던 부분: `note_part_extended` — 뿌리 같음, 뿌리 아래는 그 요소들뿐, 구분선류(`w:type` separator·continuationSeparator·continuationNotice)는
  번호까지 그대로, 보통 각주는 원본 것이 순서·내용 그대로 출력의 부분 열이고(본문 순서로 다시 매기므로 뿌리 `w:id`만 다를 수 있음) 하나 이상 더해졌을
  때만. 더한 각주의 내용과 본문 참조 대상은 엔진 다시 읽기(의미 동등)가 확인한다. 각주 부분 관계·목록 변경은 부분 비교가 그대로 막는다.
- 거부를 확인한 변이(합성 출력 주입, 저장 규칙 증거): settings 참조 ID 다름, settings의 무관한 변경, 참조 없음(→ 규칙 전체 불성립, `PartAdded`), 내용
  형식 틀림, 외부 관계·다른 대상, 각주 말고 다른 부분 덧붙임, 기존 각주 글 변경, 구분선 변경, 기존 각주 삭제.
- 실제 저장(엔진 성공 증거): basic·rich B10 × 각주·미주, 첫 저장 → 디스크의 게시 파일로 다시 열기 → 기존 각주 **앞**에 새 각주(번호 다시 매김) + 메모 →
  둘째 저장 → 다시 열기, 각주 글·순서·메모·원본 머리글/바닥글/미디어 부분 바이트·dirty·임시 파일·저장 표 확인. 원본 settings에 `w:footnotePr`가
  없는 문서·각주 안 그림/링크(각주 관계 부분)·메모 부분이 이미 있는 문서의 각주 첫 추가 + 메모 덧붙임 조합은 검증하지 않았다(규칙상 거부될 수 있음).

### 이미 추적이 켜진 DOCX의 저장 (2026-11-05)

추적 문서에서 지운 글이 남는 편집 뒤 출력은 WordCraft 의미 비교가 `Field("revisions")`로 다르다고 한다(수정 기록 색인 순서·쓰이지 않는 기록). `same_as`가
false라 저장은 `ReopenMismatch`로 거부되고 원본은 그대로다. 패키지 보존은 통과한다. 고치는 곳은 WordCraft 의미 비교(수정 기록 색인 대응)이며 저장 규칙을
넓히지 않았다([command-registry.md](command-registry.md) "T013 각주·미주 연결과 T012/T013 재검토").


### T012/T013 후속 안전성 감사 — 2026-11-05

기존 감사 기록은 위에 보존한다. 현재 geul gitlink는 `b39a8fb49c6fefbdd960792f2a4effd0d7660e3c`다. 공개 포크 `https://github.com/MinGyu2/wordcraft.git`의 `geul/semantic-roundtrip-equivalence` 브랜치가 이미 같은 SHA여서 push하지 않았다. `42e8a67..b39a8fb`는 reader와 집중 시험 세 파일뿐이며 `42e8a67`의 자손이다. 태그 `geul-roundtrip-42e8a67`는 이전 SHA에 남는다. 빈 저장소의 depth-one 직접 SHA fetch와 새 geul master clone의 WordCraft 단독 초기화가 모두 exit 0, HEAD `b39a8fb`로 성공했다(RHWP 초기화 없음).

실제 `read/mod.rs`의 구분선 판정과 `write/mod.rs` 생성 XML을 대조했다. 일반·연속 구분선은 문단 하나, pPr/spacing 하나(after=0, line=240, lineRule=auto), bare mark run 하나의 순서와 속성·자식을 검사한다. continuation notice는 기본값으로 정규화하지 않는다. 첫 종류의 구분선을 별도로 기억하므로 첫 기본값 뒤의 사용자 구분선으로 덮어쓰지 않는다. XML 파서는 URI를 canonical prefix로 바꾼 뒤 비교한다. note wrapper의 type/id는 종류·참조 식별자로 처리하며 이 판정의 문단 subtree와 별개다. 새 32개 변이와 각주/미주 별칭·continuation notice 검사는 geul의 고정 의존성 시험에 두었다. WordCraft 소스·HEAD는 바꾸지 않았다.

각주 출력 변이 10개는 기존 저장 서비스 경계에 합성 바이트를 전달하며 실제 모델 `same_as` 결과를 사용한다. 패키지 분류와 서비스의 첫 거부 원인을 분리한다: 모델 불일치는 `ReopenMismatch`가 먼저 반환되며, 모델이 같은 설정 ID/참조/유형/추가 부분 변이는 패키지 finding으로 거부된다. 원본 bytes/SHA-256, 전체 SessionInfo, dirty/revision, 티켓 재획득, 임시 파일 없음 및 뒤이은 정상 저장을 단언한다. production export가 악성 출력을 생성했다고 주장하지 않는다. 각 거부 전에 정상 출력의 복구 snapshot을 만들고 `save_with_options(recovery=Some)`를 호출한다. 거부 뒤 후보 ID·revision·유효성을 검증하고 원래 세션의 `forget_session`으로 정리됨을 단언해 소유권 보존도 확인한다. 기존 복구 경로는 변경하지 않았다.

추적 문서는 원시 엔진의 한글 삽입 성공과 선택 재치환 `Field("revisions")` 실패를 구분해 재현했다. 이제 엔진의 tracking 상태로 문서 변경을 실행 전에 거부하고 프런트엔드 입력/IME/명령 경계도 같은 상태를 사용한다. 탐색·선택은 유지한다. 문서 PartialEq·왕복 비교·T009 검증은 완화하지 않았다. native X11/IBus와 외부 Office 호환은 DISPLAY/ibus 부재로 NOT RUN. T012/T013은 미완료다.

검증 명령과 결과(이번 후속 감사):

- `git ls-remote https://github.com/MinGyu2/wordcraft.git refs/heads/geul/semantic-roundtrip-equivalence`: exit 0, `b39a8fb`. 빈 임시 저장소에서 `git fetch --depth=1 https://github.com/MinGyu2/wordcraft.git b39a8fb49c6fefbdd960792f2a4effd0d7660e3c` 및 `git rev-parse FETCH_HEAD`: 각각 exit 0.
- `git clone --depth=1 --branch master https://github.com/MinGyu2/geul.git <tmp>/geul`, `git -C <tmp>/geul submodule update --init --depth=1 external/wordcraft`, 서브모듈 `rev-parse HEAD`: 각각 exit 0, gitlink와 HEAD `b39a8fb`.
- `npm run typecheck`, `npm run lint`: exit 0. `npm run test -- src/commands src/components/Editor/wordcraft src/adapters/docx.test.ts src/language/language.test.ts`: exit 0, 18 파일/304 시험 PASS. jsdom canvas 미구현 메시지는 발생하지만 native 증거로 쓰지 않는다.
- `python3 scripts/cargo-geul.py test --lib adapters::wordcraft::tests`: exit 0, 70 PASS/1 ignored. `python3 scripts/cargo-geul.py test --lib --no-run`: exit 0. 생성된 `src-tauri/target/debug/deps/geul_lib-180e9fedd477bbac docx_semantic_acceptance --nocapture`: exit 0, 9 PASS/1 ignored.
- 보호 래퍼의 `test --lib docx_semantic_acceptance`는 기존 `SharedDirectory` 게시 제한으로 exit 101이었다. 같은 보호 빌드의 바이너리를 일반 파일시스템에서 실행해 실제 atomic publication과 두 회차 저장을 검증했다. 초기 새 시험의 PreflightMissing 및 서비스 선행 ReopenMismatch 기대 오류는 시험 준비/단언을 수정했고 최종 집중 시험은 통과했다. 검증 규칙은 변경하지 않았다.
- `python3 scripts/cargo-geul.py fmt --check`, `clippy --lib -- -D warnings`, `check --lib`: exit 0(locked/offline).
- WordCraft 시험은 `python3 scripts/external-integrity.py --require external/wordcraft --writable src-tauri/target --writable target/rhwp-wasm --report target/rhwp-wasm/<report>.json -- env CARGO_TARGET_DIR="$PWD/src-tauri/target" cargo test --manifest-path external/wordcraft/Cargo.toml --locked --offline` 뒤에 각각 `-p wordcraft-docx --test note_separators`(4 PASS), `-p wordcraft-engine roundtrip_equiv`(9 PASS), `-p wordcraft-doc roundtrip`(23 PASS)를 사용했다. 각각 exit 0. 불필요한 새 target 디렉터리 없이 기존 캐시를 재사용했다.
- 음성 첫 저장 원본 SHA-256: `7286a49b2801ea1d4069a2173a440c4ad06718ae779345626fed52b27b56ee6c`; 둘째 저장 원본: `3977811171bcd008654bec546c9de916071706da7050e334c03a15752098dcde`. 각 변이 거부 후 byte equality와 SHA equality를 별도 단언했다.
- native Tauri/X11/IBus, 외부 Office: NOT RUN. 기존 `file_access` 전체 엔진 소스 시험은 이 집중 범위에서 재실행하지 않았다.

### Stage 1: 기존 각주 부분의 구분선 래퍼·settings 변이 (2026-11-05)

실제 WordCraft reader/writer와 저장 경로로 기존 각주·미주 부분의 래퍼 속성·번호·중복·순서·settings 참조 변이 11가지를 확인했다(각주·미주 각각). 엔진 모델
왕복은 모두 같지만(`same_as`), writer가 래퍼 속성을 쓰지 않고 구분선을 -1/0으로 다시 쓰므로 `note_part_extended`(구분선 정확 비교)와 settings 비교가
`PartChanged`로 거부하고 원본을 보존한다. 접두어 별칭만 안전하다. 저장 규칙은 바꾸지 않았다([command-registry.md](command-registry.md) "Stage 1 안정화").

### T013 목차 출력 (Stage 2, 2026-11-05)

목차 넣기·갱신 출력은 WordCraft 생성 픽스처(제목 없음·제목 1/2)에서 `word/document.xml`과 `docProps/app.xml`만 바뀌고 기존 규칙으로 안전하다. 실제 저장
두 회차(게시 파일 다시 열기 → 본문 편집 + 갱신 → 둘째 게시)를 통과했다. 저장 규칙은 바꾸지 않았다([command-registry.md](command-registry.md) "T013 목차").

### T013 Stage 3: 변경 내용 추적 settings 규칙 (2026-11-05)

추적 켜기·끄기 출력의 패키지 차이는 `word/settings.xml`의 `<w:trackRevisions/>` 하나다(실측). `track_revisions_toggled`: 양쪽 settings 정규화 사건 열에서 뿌리
바로 아래의 맨 `w:trackRevisions`(속성·자식 없음, 하나만)를 빼면 같고 그 있고 없음이 다를 때만 settings를 편집 부분으로 본다. 각주 settings 규칙과 함께여도
같은 판정을 쓴다. 모델의 `settings.track_changes`는 엔진 다시 읽기 비교가 확인한다. 거부를 확인한 변이(합성 출력 주입, 원본·dirty·복구 후보·티켓 확인):
`w:val` 속성, 두 번, 다른 설정 요소 함께, 무관한 설정 변경 함께, 다른 이름공간. 추적 편집의 본문 변경은 기존 규칙과 의미 왕복 비교(수정 기록 색인 일대일,
WordCraft `b74830b`)가 판정한다. 실제 게시 두 회차(켜기 + 추적 편집 → 게시 → 다시 열어 수락·전체 거절·끄기 → 게시)를 통과했다.

### T013 Stage 4: 하이퍼링크를 나누는 메모 (2026-11-05)

메모·각주 덧붙임 규칙의 본문 r:* 대조는 이제 출력에서 **바로 앞 하이퍼링크와 같은 r:* 속성을 가진 인접 `w:hyperlink`**(메모 경계에서 나뉜 같은 링크)를
건너뛴다(`relationship_references_equal_with`, split_hyperlinks). 관계 목록·관계 속성 대조와 모델 왕복 비교는 그대로이고, 합침·다른 관계·다른 요소·사이에
다른 참조가 있는 반복은 거부한다. 대상·형식 변이와 외부 관계 추가는 계속 거부된다([command-registry.md](command-registry.md) "T013 하이퍼링크").

### T012 Stage 5: HWP DocInfo 글자 모양 덧붙임 규칙 (2026-11-05)

편집한 HWP의 DocInfo는 이제 캐럿 외에 **장평·자간만 다른 글자 모양 덧붙임**을 받는다(`docinfo_char_shapes_appended` +
`appended_char_shapes_referenced`). 근거는 한컴 저장 `KTX.hwp`에서 잰 실제 RHWP 출력 차이(`ID_MAPPINGS`와 끼운 `CHAR_SHAPE`뿐)다. 원본 글자
모양·다른 모든 DocInfo 레코드는 바이트까지 같아야 하고, 새 정의는 원본 하나와 장평·자간 바이트 밖이 같으며 모두 본문이 가리켜야 한다. 그 밖의
변경(굵게 등 속성, 쓰이지 않는 덧붙임, 다른 레코드)은 `recordsChanged{DocInfo}`로 거부하고 원본을 보존한다([command-registry.md](command-registry.md)
"T012 Stage 5 구현").


## 2026-11-06: 비동기 게시 중 글자 모양 보호 (B1)

실제 Release generation `b03ae7bd36ae56a023d0154c02e2dab0dc8fedcaeb85ea998962fdddd5393762`에서 HWP/HWPX 각각 장평150 → 내보내기/저장 응답 대기 → 장평160 → 자간10의 경합을 재현했다. 이전 구현은 첫 출력의 ID를 정리하고, 후속 편집이 있으면 성공 응답에서도 게시 기준을 올리지 않았다(수정 전 회귀2 FAIL).

내보낸 정의 수를 백엔드 호출 전에 임시 보호하고 `finally`에서 해제한다. 성공한 교체는 후속 편집·내구성 미확정 여부와 무관하게 영구 보호 prefix를 올린다. 실패·stale 오류는 올리지 않는다. 내구성 미확정과 후속 편집은 계속 dirty다. 이전 epoch 응답은 새 문서를 변경하지 않는다. 문서 전체 복제나 저장 서비스의 엄격 비교 변경은 없다.

실제 WASM33 PASS(두 형식: 대기 중 width/spacing/연속 서식/Undo/Redo/수식, 실패, 내구성 미확정, stale 오류, 닫기, 탭 전환), focused 저장·내구성·기록·세션82 PASS, typecheck/lint PASS. 실제 보호 저장 서비스는 HWP/HWPX 각각 같은 파일에 두 회차 총4회 durable 게시와 다음 원본 비교를 통과했다. 실제 게시 파일 재개방에서 본문·7언어 장평160/자간20을 확인했다. 명령·원본/출력·서비스 결과: `target/remaining-work/b1-*`.

B1은 과거 snapshot의 표를 현재 게시 표로 복구하지 않는다. 게시 이전 Undo 뒤 저장은 별도 B2이며 엄격한 거부를 유지한다. 제품 명령 관문은 변경하지 않는다.

## 2026-11-06: 게시 이전 Undo snapshot의 안전한 저장 (B2)

B1 이후에도 `load → 장평150 → save → Undo → save`는 실제 HWP/HWPX 모델의 표가 게시8개에서 과거7개로 돌아가 보존 검사에 걸렸다. 수정 전 출력은 실제 저장 서비스에서 두 형식 모두 `unsafe`로 거부됐으며 원본 바이트가 유지됐다. 단순한 비교 완화로 해결하지 않는다.

14번째 패치 `char-shape-publication.patch`는 문서 전체 대신 엔진 소유의 불변 글자 모양 prefix만 복사한다. 성공한 게시의 실제 정의를 세션이 보관하고, 저장 대기 중에는 그 출력의 정의를 임시로 보관한다. Undo/Redo는 저장된 snapshot을 바꾸지 않고 **복원된 live 모델**만 조정한다. 최초 정의의 ID와 전체 직렬화 메타데이터(raw/presence 포함)는 같아야 한다. 충돌하는 세션 추가 정의는 정확히 같은 정의를 재사용하거나 prefix 뒤에 유지하고, 기존 compaction과 같은 검증된 참조 방문으로 추가 ID만 옮긴다. 저장 직전에는 게시되지 않은 미사용 추가 정의를 정리한다. 이는 과거에 실제 게시한 레코드의 복구이며 임의의 미사용 정의를 만들어 비교를 통과시키는 규칙이 아니다. T009 DocInfo 비교는 그대로다.

원본 정의 불일치·범위 밖 참조·고정 DocInfo 참조의 번호 이동은 모델 변경 전에 거부한다. 문서 snapshot에 포함되지 않는 내부 clipboard/transpose 버퍼의 추가 ID는 소유 표를 증명할 수 없어 거부한다(원본 ID만 가진 버퍼는 허용). 현 geul UI는 이 엔진 내부 버퍼를 사용하지 않는다. 복원 후 조정 실패는 uncertain으로 편집·저장을 중단한다. 이전 API가 없는 세대는 기존 엄격 저장 거부를 유지한다. HWP stale-preview 정책도 유지한다.

최종 Release generation `8087a8415e32e254846a745808083bb2c9c6c0fc85504345f88d825defcf71b7`, patched source `f221f3f36a529d868f47a0feb54c4d552070d835070e989322035ad255427ed4`. native5 PASS(원본 metadata·dangling/fixed·버퍼 안전 거부/무변경, snapshot 불변), 실제 WASM51 PASS(B1 포함, B2 A–H와 저장 대기 중 Undo→새 서식), 기존 WASM37 PASS/1 skip. focused frontend82·typecheck·lint PASS. 실제 저장 서비스는20 chains/66시도에서64 durable 게시와 수정 전2 안전 거부를 확인했다. 각 서비스 호출은 새 registry에서1 revision을 확정하지만 파일은 체인 안에서 같은 경로로 이어 써 다음 원본과 비교한다. 세션 시간선·dirty/Undo/Redo는 deferred backend 실제 WASM 시험에서 따로 검증했다. 최종 게시 파일18개를 실제 WASM으로 재개방해 전체 본문·컨트롤·쪽 수·셀 속성을 의도한 Undo/재편집 상태와 비교했다. 이후 편집·저장도 A 이외 B–H 분기에서 통과했다.

근거: `target/remaining-work/b2-{native-reviewed,build-reviewed,wasm-reviewed,regressions-reviewed}.log`, `b2-service/matrix-summary.json`, `b2-service-reviewed/`, `b2-reopen-reviewed.json`. canonical build 입력에 없는 기존 시험 fixture의 최초 컴파일 실패는 native 시험 결과와 구별했다. pin의 읽기 전용 fixture 링크를 시험 중에만 사용하고 제거했다. generation cap은 유지하고 실행 소비자가 없는 비활성629d…/853a… 세대는 기존 `target/rhwp-preserved-generations/`로 해시를 보존해 옮겼다. 실패/중간 소스·generation·로그도 보존했다. Word/Hancom 외부 수용과 제품 명령 활성화는 별도 관문이다.

### 2026-11-06 P2 publication identity review (unresolved)

Count matching is not a publication identity proof. The existing Release WASM exact-prefix reconciliation probe found a reachable same-count HWP mismatch after bold formatting, while simple HWP/HWPX metric edits retained exact identity (`target/p2-reliability/identity-probe.log`). A defensive exact check against the reopened document was tried and rejected 23 existing HWP B1/B2 cases (28 passed); that experiment was removed (`target/p2-reliability/wasm-after.log`). No publication fix or commit is claimed. The remaining design must account for serializer normalization and preserve T009's strict original metadata checks; P2-1 cases A–M and service/reopen publication coverage remain incomplete. The current Release generation `8087a8415e32e254846a745808083bb2c9c6c0fc85504345f88d825defcf71b7` and source `f221f3f36a529d868f47a0feb54c4d552070d835070e989322035ad255427ed4` were reused; no engine rebuild occurred.

P2-2 initialization transaction: `RhwpText` (including initial count and prefix capture) is now constructed before requesting backend `loading → ready`. Constructor errors follow the existing `EngineFailure(init)` and `loading → failed` path; the document is released. A captured valid prefix is released with its document if ready is rejected or the session becomes stale. A prefix value without callable `free()` is rejected. Six controlled tests cover count/capture exceptions, malformed prefix, recovery by reload, ready rejection, stale dispose, and history initialization failure. These are fault-injected frontend cases, not evidence that the real engine throws. History setup already degrades to unavailable without failing a healthy load. See `target/p2-reliability/load-before.log`, `load-expanded.log`, and `final-frontend.log`. Promise rejection from backend `setState` remains outside the structured Result contract and currently releases local resources then propagates; no claim is made for that transport failure mode.

### 2026-11-06 P2-1 serializer identity correction (verified WASM; real service follow-up pending)

기존 HWP 표에서 live `CharShape.raw_data=None`, 재개방 표에서 `Some`이 되는 경우가 있어, 전체 Rust 구조/원시 원본 비교는 정상 직렬화 정규화도 불일치로 판정했다. 실제 출력 의미를 확인하려고 HWP writer의 `serialize_char_shape` 결과와, 원본 raw 레코드가 있으면 그 바이트를 함께 비교한다. HWPX는 ID를 고정한 `char_pr_xml` writer 출력으로 비교한다. 이 투영은 실제 저장 형식이 내보낼 속성만 증명하며, T009 원본 DocInfo 검사에는 적용하지 않는다. count 및 형식도 동일해야 하고 정의별 ID 순서도 그대로여야 한다. 검증된 뒤에도 history 복구용 prefix는 원본 raw/presence 정보를 보유한 live 정의에서 캡처한다.

실제 Release WASM 탐색은 HWP/HWPX 각 7개 정의의 변경 사례 7종(무변경·폭·자간·굵게·조합)을 다뤘다. width/spacing 계열은 live/reopen의 유효 속성이 같았고, HWP는 live 전체 prefix가 재개방 구조와 exact 비교되지 않았어도 저장 서비스에 durable 게시되고 Undo 뒤 두 번째 게시도 통과했다. HWP 굵게가 포함된 3개 사례는 서비스가 `recordsChanged`로 거부했고 원본을 보존했다. HWPX 7개는 게시에 성공했다. 무변경/폭/자간 및 허용 조합 출력은 복원된 Undo snapshot과 실제 저장 서비스에서 두 번째 저장 후 재개방했다. 세부 결과는 `target/p2-continuation/summary.json`과 사례별 `report.json`, `*.service.log`에 있다. 이 행렬은 생성한 표 fixture에 한정하며, 모든 production 문서의 동일성을 보증하지 않는다.

추가로 실제 표 생성 WASM의 same-count semantic mismatch, 양방향 count mismatch, 교차 형식을 15개 시험에서 거부하고 두 문서가 변하지 않는 것을 확인했다. adapter 결함 주입 시험은 활성 검증 lease 없이 `markPublished(5)`가 baseline 3을 5로 바꾸던 방어 경로를 재현했다. 이제 actual reopened export를 엔진에서 형식별 투영으로 검증하고 live prefix를 캡처한다. 게시 성공 시 같은 lease/count만 baseline과 함께 이동한다. 후속 편집은 이미 검증한 export identity를 잃게 하지 않는다. 실패/거부는 lease를 해제하고 baseline을 올리지 않는다. T009, original IDs, fixed references 및 저장 서비스 코드는 바꾸지 않았다.

실제 Release generation `53b6ad7a4c6de7a8f4ada4c61b0ad1934461e656527f6e6b440f08898bebf6d6`; JS `3e9c1687af9aabe8ca78c68ab01e569622bcb880341ae4c100faf543782e0027`; WASM `e08e5ce86fad632fde6b7e1051f09597e771ae3924b01685567296a31a453757`; patched source tree `5d08748867c6218b2152ec3abc32f9fb9037abd92edffc2581ce237c192f402c`. 보호 빌드와 15개 identity/51개 B1-B2 WASM 시험은 PASS다. 시험 산출물은 `target/p2-continuation/p3-wasm-identity.log`, `p3-wasm-regressions.log`; 실제 저장 서비스로 전수 두 번째 저장하는 Phase 5는 아직 실행되지 않았다.

### 2026-11-06 P2-2 cleanup failure boundary follow-up

초기화 중 임시 `RhwpText`와 문서를 각각 한 번씩 해제하도록 시도하며, 첫 해제 예외가 나도 두 번째 해제를 건너뛰지 않는다. 주 오류(`EngineFailure(init)`, backend rejection, stale close 결과)는 유지하고, 부가 해제 실패는 `EditorStatus.failed.cleanupFailed`에 표시한다. 이 표시는 이미 분리한 문서의 `uncertain` 상태나 dirty/save 가능 상태인 것처럼 꾸미지 않는다. 테스트 double이 destructor 예외를 던진 경우 자원이 실제로 해제됐다고 주장할 수는 없으며, 각 자원의 해제는 정확히 한 번 시도되고 재호출하지 않는다. 새 차원의 UI 복구 표시나 allocator 오류 보고는 범위 밖이다. 실제 wasm-bindgen 문서 API는 엔진이 만든 prefix wrapper를 반환하지만, TypeScript의 callable `free`만으로 임의 객체가 유효한 wasm 포인터인지 증명하지 않는다.

7개 cleanup fault-injection 시험, 앞서 있던 초기화 6개 및 session 회귀 19개가 통과했다. Tauri adapter invoke rejection을 `Result`로 감싸는 기존 시험도 15개 통과했다. 실행 기록 `target/p2-continuation/p4-after-final.log`, `p4-adapter-regressions.log`; 새 backend 시험 경로 `src/adapters/backend.test.ts`는 저장소에 없으며 실제 대응 파일 `src/adapters/adapters.test.ts`를 별도로 실행했다.

### 2026-11-06 P2 Phase 5 final service acceptance

최종 Release `53b6ad7a4c6de7a8f4ada4c61b0ad1934461e656527f6e6b440f08898bebf6d6`(JS `3e9c1687af9aabe8ca78c68ab01e569622bcb880341ae4c100faf543782e0027`, WASM `e08e5ce86fad632fde6b7e1051f09597e771ae3924b01685567296a31a453757`)과 실제 save-service binary SHA `314c77750e0d04dac24177775f3ceb0b69753ca9bf602f975dc36547c9f172aa`로 acceptance 기록을 확인했다. 18 HWP/HWPX service chains에서 62 durable 게시가 성공했고, 같은 target 경로로 파일을 연결해 전체 최종 파일 18개를 WASM으로 재개방했다. 수용 보고에서 18개 전부 내용·쪽·컨트롤 및 출력 byte 일치가 확인됐다. 별도의 14 serializer-normalization 사례는 실제 서비스 첫 게시→Undo 상태 재개방→두 번째 게시까지 확인했다. HWP unchanged/width/spacing/width-spacing 4종과 HWPX 7종은 양쪽 게시가 durable였다. HWP bold, width+bold, bold+spacing 3종은 T009 `recordsChanged`로 strict 거부됐고 입력 target을 보존했다. HWPX 7종은 모두 durable 게시됐다. 수용 증거: `target/p2-continuation/p5-acceptance.json`, `p5-service-summary.json`, `p5-reopen.json`, `p5-normalization/summary.json`, 사례별 `p5-service/`와 `p5-normalization/` 결과.

fresh registry 기반 service chain은 같은 논리 파일 경로와 앞 저장 파일을 다음 입력으로 이어간다. 이는 하나의 frontend session이 여러 revision을 소유한다는 시험은 아니다. in-session pending/history/session 경합은 별도 actual-WASM frontend suite로 검증했다. 전체 요청에 있는 모든 불가능 참조·stale transaction 조합을 18체인이 다 다뤘다고 해석하지 않는다. 안전 거부 시 service report는 target 원본 hash와 directory entry 유지, temporary 파일 부재를 확인한다. 외부 Word/Hancom GUI 호환성은 이 결과에 포함되지 않는다.

P5 frontend 120 PASS, actual Release publication/session WASM 51 PASS, legacy Undo/format-save/multisection WASM 37 PASS·선택 시험 1 SKIP, lint/typecheck PASS다. 다만 지시한 `python3 scripts/cargo-geul.py test --locked --offline --lib services::save`는 exit 101 (`target/p2-continuation/p5-rust-save.log`): 161 tests 중 100 PASS, 46 FAIL, 15 ignored. 첫 failure는 `src/services/save/tests.rs:3851`에서 temp 경로 상위에 uid 0 소유 디렉터리가 없다는 assertion; 여러 이어지는 실패가 fixture 경로를 `SharedDirectory`로 거부해 예상한 path/permission 결과 대신 실패했다. 환경 제약이라고 단정하지 않으며 코드 결함이라는 증거로도 분류하지 않는다. 이 Rust gate는 PASS가 아니고 후속 원인 확인 전까지 전체 P2 수용 상태를 막는다.

P5 초기화 경계에서도 `readPages` 예외 뒤 `doc.free` trap이 loading→failed 처리 전에 빠져나가는 문제가 실패 시험으로 재현됐다(`p5-page-before.log`). 초기 문서 해제를 독립 helper로 해 render-limit/stale/초기 prefix 경로에서 예외 뒤에도 상태 전이 처리를 계속한다. 수정 후 cleanup 8 + 이전 초기화 6 + session 19 = 33 PASS (`p5-page-after.log`); 실제 WASM 코드/엔진은 이 수정으로 재빌드할 필요가 없었다. P4 cleanup fault 시험은 destructor가 실제 해제됐다는 보증이 아니며 한 번의 해제 시도만 검증한다.

P5 결과 집계 보완: `p5-independent-review.json`은 84 durable 저장, 3 strict refusal, 18 same-path chain, 18 full run reopen PASS를 요약한다. 84는 service chain 62건과 normalization의 성공 시나리오 22건을 합한 값이며, HWP bold 세 refusal은 별도다. `p5-reopen-refs.json`은 최종 파일의 18개 모두 네 셀의 run/ID/속성 및 canonical prefix 검증을 PASS로 기록한다. 초기에 tuple 형태를 잘못 넘긴 reopen harness는 실패 기록 `p5-reopen-refs-harness-error.*`로 남기고, 실제 WASM API에 맞춰 수정한 후 검증했다(`p5-reopen-refs.log`). 이는 실파일 결과다. `p5-pointer-validation.json`은 유효 캡처 prefix와 위조 callable-free 객체를 분리해, 후자를 `expected instance of CharShapePrefix`로 거부하고 문서 count가 그대로임을 보인다. 실제 allocator destructor 예외를 유도한 것은 아니다.

Rust save 시험 환경 분류 보완: sandbox 바깥 UID는1000이며 UID map의 sandbox root도65534로 매핑됐다. 시험 경로 `/`, `/home`, `/tmp` 어느 것도 UID0으로 보이지 않았다(`p5-rust-environment.json`). 실패 46건 중 44건은 root ancestor assertion 또는 `SharedDirectory` 결과가 이 전제와 직접 관련된다. 나머지 2건도 같은 공유 경로 전제에 의한 후속 assertion 실패로 설명과 일치하지만, 개별적으로 독립 원인까지 입증하지는 않았다. privileged `sudo-bwrap` 경로는 구현되어 있지만 `sudo -n true`가 암호를 요구해 실행할 수 없었다. 무보호 실행으로 재시도하거나 UID 검사를 완화하지 않았다. 따라서 Rust gate는 환경 차단/실패로 남고 PASS가 아니다.
