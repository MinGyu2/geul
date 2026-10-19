# T009 원본 형식 저장과 보존 검사 (2026-10-19)

상태: **이 환경(Linux)에서 구현·검증. T009 체크 안 함** — 선행 T007·T008이 플랫폼 기준으로 미체크이고, 원본 교체는 Linux에서만
검증했다(아래 "판정"). 기준 `ee402c3`(master, 작업 트리 깨끗, submodule rhwp `1a76570` v0.8.7·wordcraft `fc41918` v0.7.0, 바꾸지 않음).
구현 안정화(A~I)는 `93e6acf` 위에서 했다(아래 "안정화"). 그 결과 **편집한 HWP 저장은 고정 rhwp에서 사실상 막힌다**(미리보기 낡음, F).

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
                                              원본: 하드 링크·읽기 전용이면 거부, 확장 속성·ACL·플래그·권한 읽기
                                              같은 디렉터리 임시 파일(create_new, 원본 권한) 쓰기·fsync
                                              임시 파일의 메타데이터가 원본과 같은지(다르면 거부)·되읽기
                                              원본 해시 다시 확인
                                              기록 잠금 안: 세션·시도·ready·지문(ctime·권한·소유·링크 수 포함) 다시 확인
                                              → rename → 이 inode의 fstat으로 새 지문 → 디렉터리 fsync
                                              깨끗한 판 = 저장한 판(그 사이 편집은 dirty로 남음), 새 inode·지문·해시
                                              (fsync 실패: 새 파일 기록만 바꾸고 dirty 유지)
```

어느 단계든 실패하면 교체 전이므로 원본은 그대로이고 임시 파일은 지운다.

## 판정 규칙

- `safe`: 근거가 하나도 없음. `unknown`(판단 불가): 원본을 끝까지 읽지 못함(`originalMalformed`)·손실 보고 모양 오류
  (`lossReportInvalid`)·한도 초과·보호/배포용 HWP(`unsupported`)·이 원본의 사전 검사 없음(`preflightMissing`). 그 밖의 근거는 `unsafe`.
  **unknown도 저장하지 않는다.**
- HWP: 스트림 이름 집합, `FileHeader` 256바이트, 레코드 스트림(압축을 풀어 태그·수준·내용)이 같음. 레코드 스트림은 바이트가 같아도
  양쪽을 끝까지 읽는다(원본이 깨졌으면 unknown, 출력이 깨졌으면 unsafe — 같은 바이트의 깨진 레코드는 근거가 아니다, E). deflate 뒤에
  남는 바이트는 없거나 한컴 8바이트 꼬리(CRC-32·길이가 푼 내용과 맞음)여야 한다. BinData는 DocInfo BIN_DATA 속성으로 양쪽 저장 형태가
  같게 정해질 때만 압축이면 끝까지 풀어 같은지, 비압축이면 바이트가 같은지 본다. 그 밖의 스트림(형태를 정할 수 없는 BinData, 미리보기,
  스크립트, 요약 정보)은 **바이트가 같아야** 한다(한쪽만 풀리는 쌍을 같다고 보지 않음, D). 편집 저장은 본문이 레코드로 끝까지 읽히는지만
  보고(내용은 다시 열기), `DocInfo`는 정확히 26바이트인 tag 16의 캐럿 12바이트만 다를 수 있다(길이가 다르면 면제 없음, A).
- 미리보기(F): 본문을 바꾼 저장에서 원본 그대로 남는 미리보기는 내용이 없음을 증명해야 한다. 글 미리보기(HWP `PrvText` UTF-16,
  HWPX `Preview/PrvText.txt` UTF-8)는 공백·제어 문자뿐, 그림 미리보기(`PrvImage`, `Preview/PrvImage.png`)는 8비트·비인터레이스 PNG의
  모든 픽셀이 같고 글을 담을 자리가 없을 때(허용 보조 덩어리 `sRGB`·`gAMA`·`cHRM`·`pHYs`·`bKGD`·`tIME`만, `IEND` 뒤·남는 압축 해제
  내용·deflate 뒤 바이트 없음). 그 밖의 `Preview/*`와 DOCX 썸네일(`docProps/thumbnail.*`, 패키지 관계의 thumbnail 대상)은 증명할 수
  없어 막는다. 근거 `previewStale`(unsafe). 미리보기가 바뀐 출력은 바뀐 스트림·부분으로 unsafe다(재생성 내용을 검증하지 않음).
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
  `fsync`한다. 다시 불러오면(디스크에서 읽음) 깨끗하다. 둘 다 성공 = 게시됨·내구성 확인.
- 저장 검사 순서(H, 프런트엔드): 사전 검사 요청마다 소유 번호를 올린다. 결과는 그 번호가 그대로일 때만 기억·표시한다(겹친 검사 중
  늦게 끝난 옛 요청, 저장 성공·다시 불러오기·닫기 전에 시작한 검사는 버림). 수동 검사는 진행(`checking`)과 실패(`failed`)를 보이고,
  저장 중에는 하지 않는다(`SaveInProgress`). 저장 안의 검사는 그 결과를 바로 쓴다.

## 오류 계약(경로·문서 본문·운영체제 문구 없음)

| 코드 | 뜻 |
|------|----|
| `UnsafeSave{preservation}` | 보존 근거 없음(unsafe/unknown + 근거 코드·부분 이름). 원본 그대로 |
| `SaveUnsupported{platform\|hard-link\|ownership\|read-only\|metadata}` | 이 환경·파일은 안전하게 바꿀 수 없음(읽기 전용 원본, 교체로 잃을 확장 속성·ACL·플래그 포함) |
| `SaveFailure{stage: export\|validate\|write\|publish, io?: permission-denied\|storage-full\|read-only\|other}` | 단계 실패. 원본 그대로 |
| `FileConflict` | 불러온 뒤 디스크의 파일이 바뀜(외부 수정). 덮어쓰지 않음 |
| `SaveInProgress{sessionId}` | 같은 세션 저장 중 |
| `RevisionMismatch`·`StaleLoad`·`StaleSession`·`InvalidState` | 옛 판·다시 불러온 시도·닫힌 세션·준비되지 않은 상태 |
| `SaveNotReady{pending\|composing\|uncertain\|state}`(프런트엔드) | 확정 전 편집·조합·불확실한 모델 |

## 형식별 저장 가능 여부(이 구현의 정책)

| 형식 | 저장되는 경우 | 막히는 경우(예) |
|------|---------------|-----------------|
| HWP 5 | 편집 없는 rhwp 왕복이 레코드 수준에서 원본과 같고(업스트림 예제 60개 중 54개 해당) **미리보기에 글자·그림이 없는** 문서. 고정 rhwp에서는 사실상 없다: 원본 `PrvText`에 글자가 있으면 rhwp가 그대로 둬 `previewStale`, 비었으면 rhwp가 다시 만들어 `PrvText` 바뀜(둘 다 unsafe). 대표 픽스처도 막힌다 | 낡은 미리보기(unsafe), `PrvText` 재생성·`ViewText` 빠짐(unsafe), 암호·DRM(열기 단계에서 거부), 배포용·보호(unknown), 깨진 레코드(unknown) |
| HWPX | 편집 없는 rhwp 왕복이 부분마다 원본과 같고 `Preview/*`가 비었음을 증명할 수 있는 문서(사실상 rhwp가 만든 문서, 예제 60개 중 3개) | 한컴이 만든 대부분의 문서(실제 요소 손실, unsafe), 글자가 있는 미리보기(unsafe), 잘린 XML(unknown), 모르는 요소·속성·부분(unsafe) |
| DOCX | 편집 없는 WordCraft 왕복이 부분마다 같고 썸네일이 없는 문서(WordCraft가 만든 문서) | Word가 만든 대부분의 문서(모르는 표시·부분 손실, unsafe), 썸네일(unsafe), 끊긴 XML(unknown) |
| HWP 3·HML·암호화 OOXML·docm/dotx | 열기(형식 판별)에서 이미 거부(T006) | — |

모든 형식: Linux 밖의 플랫폼, 하드 링크·다른 소유자·읽기 전용 파일, 확장 속성·ACL·inode 플래그가 새 파일과 다른 파일은 저장하지
않는다.

## 검증

T009 구현(`93e6acf`) 때의 결과는 그 커밋의 이 문서에 있다(그때 적은 `cargo test` "116 passed"는 마지막 시험을 넣기 전 값이고 실제는
117+1이었다). 아래는 안정화 뒤 같은 작업 트리에서 다시 실행한 결과다.

| 검사 | 결과 |
|------|------|
| `cargo fmt --check`·`cargo clippy --locked --all-targets -- -D warnings`(src-tauri) | 통과 |
| `cargo test --locked`(src-tauri) | lib 129 passed, 3 ignored(기존 측정 1, 로컬 탐침 2) + 통합 1 — 안정화 시험 12개(A·D 2·E·F 3·G·B·C·I·직렬화) |
| `python3 tests/roundtrip/roundtrip.py` | 18/18(실제 rhwp WASM + `cargo run --example save_check`: HWP 편집 저장은 `previewStale PrvText`로 unsafe, HWPX 편집 저장 safe, 손실 보고 불일치 unknown, 컨트롤 생략 손실 unsafe, 다시 열기 불일치·형식 불일치 unsafe, 잘린 HWPX unknown, 모르는 요소·속성·부분 unsafe) |
| Vitest | 567(28파일) — 안정화 8개(H 수동 검사 실패 표시·겹친 검사 두 순서·저장 전 검사의 늦은 결과·닫기·다시 불러오기, I 내구성 미확인 dirty 유지·문구, 계약) |
| `npm run typecheck`·`lint`·`build` | 통과 |
| `rhwp_poc.py`(weston) | 73/73 — HWP 실제 키 편집 → 저장이 `previewStale:PrvText`로 막히고 파일·dirty 그대로, HWPX 저장·다시 열기·외부 수정·음성 사례·임시 파일 없음 그대로 |
| `wordcraft_poc.py`(Xvfb X11 · 헤드리스 weston) | 60/60 · 59/59 |
| `tauri_smoke.py`(weston) | 62/62 |
| 실제 한국어 IME(Xvfb + ibus-hangul, xdotool) | DOCX 필수 7/7 PASS 3회, rhwp 필수 7/7 PASS 2회 — 창 초점 항목은 다른 창을 주지 않아 NOT RUN |
| 키 반영 p95(키만, 개발 빌드) | Xvfb 67 ms·weston 47 ms(DOCX), weston 31·32 ms(HWP·HWPX) |

weston 세 묶음(wordcraft·smoke·rhwp)은 첫 실행에서 WebKitWebDriver 연결이 끊겨(`Remote end closed connection without response`, 저장과
무관한 앞 단계) 멈췄고, 다시 실행해 모두 통과했다(기준선에서도 본 현상).

수정 전 실패 확인: Rust 안정화 시험은 수정 전 코드에서 6개가 unsafe 입력을 safe로 판정해 실패했고(A·D·E·F 2·G), B·C·I는 각 수정만
되돌리면(쓰기 검사·지문 확장·메타데이터 비교·내구성 처리) 해당 시험이 실패한다. 프런트엔드 시험 8개 중 7개는 수정 전 세션 코드에서
실패한다(닫은 뒤 결과 버림은 기존 epoch 처리로도 통과하는 보호 시험).

실패 주입(Rust, 서비스 직접 호출): 임시 파일 만들기 권한 거부, 쓰기 공간 부족·읽기 전용, 되읽기 불일치, 교체 실패, 교체 직전 외부
수정, 메타데이터 읽기 실패, 교체 뒤 디렉터리 fsync 실패. 실제 파일 시스템(btrfs, ext4 모두): 0444·0400·0464 원본(읽기 전용, 디렉터리는
쓰기 가능), 0644, 읽기 전용 디렉터리, 보조 그룹 소유(`chgrp`), 저장 중 chmod·하드 링크·`user.*` 확장 속성 변경, 원본의 `user.*` 확장
속성·POSIX ACL(`setfacl`), 하드 링크(불러오기 전·뒤), 심볼릭 링크·권한 비트. 다른 사용자 소유(chown)는 root가 아니라 실행하지 않았다
(보조 그룹 경우로 같은 경로를 시험). 확장 속성을 지원하지 않는 파일 시스템은 이 환경에 없어 NOT RUN(그때는 양쪽 다 없음으로 본다).

## 남은 위험

- 보존 비교는 컨테이너·XML·레코드 수준의 동일성이다. 한컴 오피스·Word가 같게 보인다는 증거가 아니며, 실제 프로그램 왕복 시험은
  T015·T016이다.
- 편집한 저장에서 본문 부분의 내용은 엔진 다시 열기 비교(본문 글자·컨트롤 목록·쪽 수, DOCX는 모델 동일)로만 본다. 본문 부분의
  비교 대상이 엔진 자신이므로, 엔진이 읽지도 쓰지도 않는 본문 속 표시는 사전 검사(편집 없는 왕복)가 잡는다는 가정에 기댄다.
- HWP 편집 저장은 고정 rhwp에서 사실상 막힌다(F). 풀려면 rhwp가 편집 모델의 미리보기를 다시 만들거나 지우는 수단이 필요하다
  (업스트림 변경, 이 작업 밖). 재생성한 미리보기를 받아들이려면 그 내용이 편집한 본문에서만 왔는지 독립적으로 확인하는 규칙이 필요하다.
- 남는 경합(TOCTOU): 교체 직전 확인(기록 잠금 안의 stat: inode·크기·수정 시각·ctime·권한·소유·링크 수)과 `rename` 사이에 다른
  프로그램이 원본을 바꾸면 그 변경은 덮인다. POSIX에는 "이 inode일 때만 이름 바꾸기"가 없어 창을 줄일 뿐 없앨 수 없다. 일반 프로세스는
  ctime을 정할 수 없어(`utimensat`으로 수정 시각을 되돌려도 ctime은 바뀐다) 같은 크기·수정 시각으로 위장한 변경도 잡는다. 원본 해시는 임시 파일을
  쓴 뒤 다시 확인한다. 메타데이터 비교는 임시 파일을 다 쓴 시점이고, 그 뒤 원본의 변경은 ctime으로 잡는다.
- 내구성은 디렉터리 `fsync` 성공까지다(정전 시험은 T014). 중단 뒤 남은 `.geul-save-*.tmp`의 정리는 T014.
- 확장 속성·ACL·inode 플래그는 옮기지 않고, 원본에 있어 새 파일과 다르면 저장을 막는다. SELinux 등에서 새 파일이 다른 레이블을 받는
  환경은 저장이 막힌다(정직한 결과). Windows·macOS는 저장하지 않는다(T014·T016).
