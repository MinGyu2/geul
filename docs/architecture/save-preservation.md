# T009 원본 형식 저장과 보존 검사 (2026-10-19)

상태: **이 환경(Linux)에서 구현·검증. T009 체크 안 함** — 선행 T007·T008이 플랫폼 기준으로 미체크이고, 원본 교체는 Linux에서만
검증했다(아래 "판정"). 기준 `ee402c3`(master, 작업 트리 깨끗, submodule rhwp `1a76570` v0.8.7·wordcraft `fc41918` v0.7.0, 바꾸지 않음).
구현 안정화(A~I)는 `93e6acf` 위에서, 3차 안정화(A~F: 내구성 미확인 뒤 다시 불러오기 보호, 게시 무결성, 미리보기 PNG 엄격 검증,
본문 구역 이름, 임시 파일 정리 소유, FileHeader 전체)는 `708a5e8` 위에서, 4차 안정화(A: 원본까지의 모든 상위 디렉터리 신뢰·확인한
디렉터리 핸들 기준 게시, B: 같은 바이트의 압축 BinData도 끝까지 풀기·정할 수 없는 BIN_DATA 선언 unknown, C: 남는 미리보기는 내용과
무관함이 증명된 엔진 상수만)는 `0a00938` 위에서 했다. 그 결과 **편집한 HWP 저장은 고정 rhwp에서 사실상 막힌다**(미리보기 낡음), 다른
사용자가 쓸 수 있는 원본·디렉터리·상위 디렉터리도 저장하지 않는다(아래 "게시 무결성").

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
