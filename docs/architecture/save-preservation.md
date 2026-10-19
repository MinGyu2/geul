# T009 원본 형식 저장과 보존 검사 (2026-10-19)

상태: **이 환경(Linux)에서 구현·검증. T009 체크 안 함** — 선행 T007·T008이 플랫폼 기준으로 미체크이고, 원본 교체는 Linux에서만
검증했다(아래 "판정"). 기준 `ee402c3`(master, 작업 트리 깨끗, submodule rhwp `1a76570` v0.8.7·wordcraft `fc41918` v0.7.0, 바꾸지 않음).

## 목표와 범위

- FR-006: 지원 가능한 문서는 원본 형식으로 저장·재열기, 손실 우려·지원하지 않는 개체·쓰기 불가 문서는 저장을 막고 원본을 보호한다.
- 형식 변환(HWP↔DOCX)·다른 이름으로 저장·자동 저장·백업은 하지 않는다(FR-015, T009 밖).
- **T009/T014 경계**: T009는 "안전하게 저장할 수 있다는 근거가 있을 때만, 원본을 직접 덮어쓰지 않고(같은 디렉터리 임시 파일 →
  검증 → 원자적 교체) 저장하고, 그 밖은 거부해 원본을 그대로 둔다"까지다. 남은 임시 파일 복구, 정전·중단 뒤 내구성 시험,
  Windows·macOS 교체 방식, 확장 속성·ACL 보존, 저장 실패 뒤 복구 사본 관리는 T014(충돌 감지·안전한 임시 파일·복구)다.

## 조사 결과(근거)

| 대상 | 확인한 것 | 결론 |
|------|-----------|------|
| rhwp `exportHwp(x)WithReport` (`src/wasm_api.rs`, `src/serializer/content_loss.rs`) | 손실 보고 DTO `{schemaVersion:1, outputFormat, count, losses[{code, subject, path, reason, resourceId?}]}`. 직렬화가 **스스로 안 손실만** 적는다(코드 3종: `binaryContentEmptied`·`controlOmitted`·`metadataReduced`). | 빈 보고서는 보존 증거가 아니다. 엄격히 검사하되(모양이 다르면 unknown, 손실이 있으면 unsafe) 보존은 따로 판단한다. |
| rhwp 편집 없는 왕복(업스트림 `samples/`, 로컬 탐색만 — 자동 시험 입력 아님) | HWP 60개: 바이트는 모두 다르지만(CFB 섹터·압축) 레코드 수준 비교로 54개 같음, `PrvText` 재생성 2, `ViewText` 빠짐 1, 보호·배포용 2, 깨짐 1. **손실 보고는 60개 모두 0건.** HWPX 60개: rhwp가 만든 3개만 같고 57개는 `Contents/section0.xml`(실제 요소 `presentation`·`gradation`·`color`·`label` 등이 빠지거나 바뀜)·`header.xml`·`content.hpf`가 바뀌거나 부분이 생기고 사라짐. 역시 손실 보고 0건. | HWP는 레코드 수준 비교로 문서마다 판단할 수 있다. HWPX는 rhwp가 직접 만들지 않은 문서는 거의 모두 막힌다(정직한 결과). |
| rhwp 잘린 HWPX | `section0.xml`을 2/3에서 자른 HWPX를 rhwp가 **오류 없이 거의 빈 문서**(본문 2글자)로 연다. | 열기 성공은 근거가 아니다. 원본 XML을 끝까지 읽을 수 없으면 unknown. |
| WordCraft `io::open_bytes`/`save_bytes` (`crates/docx/src/lib.rs`, `xml.rs`) | 판독기는 "모르는 표시를 건너뛰고", 다시 내보내는 XML은 모르는 이름공간의 요소·속성을 버린다. 끊긴 본문 XML도 끊긴 곳까지 읽어 연다(T008 J). WordCraft가 쓴 문서는 왕복해도 부분마다 같다. Word식 패키지(`customXml`·`w14`·`w:rsid`)는 그 부분·속성이 사라지고 부분 6개가 생긴다. | DOCX도 문서마다 편집 없는 왕복으로 판단한다. |
| 편집이 바꾸는 부분(실측) | HWP: `BodyText/Section*`과 `DocInfo`의 문서 속성 레코드(tag 16) 캐럿 12바이트만. HWPX: `Contents/section<N>.xml`만. DOCX: `word/document.xml`과 `docProps/app.xml`의 통계(`Words`·`Paragraphs`). | 저장 검사에서 이 부분만 바뀔 수 있게 하고, 본문 내용은 엔진 다시 열기로 확인한다. |

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
                                              같은 디렉터리 임시 파일(create_new, 원본 권한) 쓰기·fsync·되읽기
                                              원본 해시 다시 확인
                                              기록 잠금 안: 세션·시도·ready·지문 다시 확인 → rename → 디렉터리 fsync
                                              깨끗한 판 = 저장한 판(그 사이 편집은 dirty로 남음), 새 inode·지문·해시
```

어느 단계든 실패하면 교체 전이므로 원본은 그대로이고 임시 파일은 지운다.

## 판정 규칙

- `safe`: 근거가 하나도 없음. `unknown`(판단 불가): 원본을 끝까지 읽지 못함(`originalMalformed`)·손실 보고 모양 오류
  (`lossReportInvalid`)·한도 초과·보호/배포용 HWP(`unsupported`)·이 원본의 사전 검사 없음(`preflightMissing`). 그 밖의 근거는 `unsafe`.
  **unknown도 저장하지 않는다.**
- HWP: 스트림 이름 집합, `FileHeader` 256바이트, 레코드 스트림(압축을 풀어 태그·수준·내용)이 같음. 그 밖의 스트림은 바이트가 같거나
  둘 다 풀어 같음. 편집 저장은 본문이 레코드로 끝까지 읽히는지만 보고(내용은 다시 열기), `DocInfo`는 tag 16의 캐럿 12바이트만 다를 수 있다.
- HWPX·DOCX: 항목 이름 집합, XML 부분은 정규화한 사건 열(이름공간 URI·지역 이름·정렬한 속성·문자 데이터 그대로; 접두사·속성 순서·
  XML 선언·이름공간 선언은 무시, DTD 거부), 그 밖은 압축을 푼 바이트. 저장 출력은 DOCX는 내용 형식이 모든 부분을 덮고 관계
  대상이 있으며, HWPX는 압축하지 않은 `mimetype`이 첫 항목이고 `content.hpf` manifest 항목이 있어야 한다.
- 다시 열기(rhwp, 프런트엔드): 다시 연 형식과 컨테이너 서명이 원본 형식, 쪽 수·본문(`getTextFileText`)·컨트롤(`getControls`)이 편집
  모델과 같음. DOCX(백엔드): 다시 읽은 문서 모델이 편집 모델과 같음.
- 원본 교체: Linux만. 하드 링크가 여럿인 파일, 소유자·그룹이 바뀌는 파일은 거부(`SaveUnsupported`). 심볼릭 링크로 연 파일은 대상
  파일을 바꾸고 링크는 남는다. 권한 비트는 원본 그대로.

## 오류 계약(경로·문서 본문·운영체제 문구 없음)

| 코드 | 뜻 |
|------|----|
| `UnsafeSave{preservation}` | 보존 근거 없음(unsafe/unknown + 근거 코드·부분 이름). 원본 그대로 |
| `SaveUnsupported{platform\|hard-link\|ownership}` | 이 환경·파일은 안전하게 바꿀 수 없음 |
| `SaveFailure{stage: export\|validate\|write\|publish, io?: permission-denied\|storage-full\|read-only\|other}` | 단계 실패. 원본 그대로 |
| `FileConflict` | 불러온 뒤 디스크의 파일이 바뀜(외부 수정). 덮어쓰지 않음 |
| `SaveInProgress{sessionId}` | 같은 세션 저장 중 |
| `RevisionMismatch`·`StaleLoad`·`StaleSession`·`InvalidState` | 옛 판·다시 불러온 시도·닫힌 세션·준비되지 않은 상태 |
| `SaveNotReady{pending\|composing\|uncertain\|state}`(프런트엔드) | 확정 전 편집·조합·불확실한 모델 |

## 형식별 저장 가능 여부(이 구현의 정책)

| 형식 | 저장되는 경우 | 막히는 경우(예) |
|------|---------------|-----------------|
| HWP 5 | 편집 없는 rhwp 왕복이 레코드 수준에서 원본과 같은 문서(업스트림 예제 60개 중 54개 해당) | `PrvText` 재생성·`ViewText` 빠짐(unsafe), 암호·DRM(열기 단계에서 거부), 배포용·보호(unknown), 깨진 레코드(unknown) |
| HWPX | 편집 없는 rhwp 왕복이 부분마다 원본과 같은 문서(사실상 rhwp가 만든 문서, 예제 60개 중 3개) | 한컴이 만든 대부분의 문서(실제 요소 손실, unsafe), 잘린 XML(unknown), 모르는 요소·속성·부분(unsafe) |
| DOCX | 편집 없는 WordCraft 왕복이 부분마다 같은 문서(WordCraft가 만든 문서) | Word가 만든 대부분의 문서(모르는 표시·부분 손실, unsafe), 끊긴 XML(unknown) |
| HWP 3·HML·암호화 OOXML·docm/dotx | 열기(형식 판별)에서 이미 거부(T006) | — |

모든 형식: Linux 밖의 플랫폼, 하드 링크·다른 소유자 파일은 저장하지 않는다.

## 검증

| 검사 | 결과 |
|------|------|
| `cargo test --locked`(src-tauri) | 116 passed, 3 ignored(기존 측정 1, 로컬 탐침 2) — 새 저장 시험 21개 |
| `python3 tests/roundtrip/roundtrip.py` | 18/18(실제 rhwp WASM + `cargo run --example save_check`: HWP·HWPX 대표 문서 편집 저장 safe, 손실 보고 불일치 unknown, 컨트롤 생략 손실 unsafe, 다시 열기 불일치·형식 불일치 unsafe, 잘린 HWPX unknown, 모르는 요소·속성·부분 unsafe) |
| Vitest | 559(28파일) — 새 16개 |
| `rhwp_poc.py`(weston) | 77/77 — 새 13: HWP·HWPX 실제 키 편집 → 저장 → dirty 풀림·컨테이너 올바름 → 확인 없이 닫힘 → 다시 열면 넣은 글자, 외부 수정 FileConflict(바뀐 파일 그대로), 잘린 HWPX unknown·모르는 요소 unsafe(원본 그대로), 임시 파일 없음 |
| `wordcraft_poc.py`(Xvfb X11 · 헤드리스 weston) | 60/60 · 59/59 — 새 8: DOCX 실제 키 편집 → 저장 → dirty 풀림·ZIP 올바름 → 확인 없이 닫힘 → 다시 열면 넣은 글자, 외부 수정 FileConflict, `customXml` 부분 unsafe·잘린 본문 XML unknown(원본 그대로), 임시 파일 없음. 기존 T008 항목(렌더·hit test·IME 경로·붙여넣기·래스터 예산 등) 그대로 통과 |
| `tauri_smoke.py`(weston) | 62/62 |
| 실제 한국어 IME(Xvfb + ibus-hangul, xdotool) | DOCX 필수 7/7 PASS 3회(선택 3항목 PASS), rhwp 필수 7/7 PASS 2회 — 창 초점 항목은 다른 창을 주지 않아 NOT RUN |
| 키 반영 p95(키만, 개발 빌드) | Xvfb 54 ms·weston 47 ms(DOCX), weston 31·32 ms(HWP·HWPX). 128 MiB 래스터 예산 그대로(297쪽 35개 32,725,000 px) |

실패 주입(Rust, 서비스 직접 호출): 임시 파일 만들기 권한 거부, 쓰기 공간 부족·읽기 전용, 되읽기 불일치, 교체 실패, 교체 직전 외부
수정 → 모두 원본 그대로·임시 파일 없음·dirty 유지·다시 저장 가능. 실제 권한(읽기 전용 디렉터리)·하드 링크·심볼릭 링크·권한 비트도 실제
파일 시스템에서 확인했다. 같은 크기·수정 시각으로 내용만 바꾼 외부 수정은 해시로 잡는다.

## 남은 위험

- 보존 비교는 컨테이너·XML·레코드 수준의 동일성이다. 한컴 오피스·Word가 같게 보인다는 증거가 아니며, 실제 프로그램 왕복 시험은
  T015·T016이다.
- 편집한 저장에서 본문 부분의 내용은 엔진 다시 열기 비교(본문 글자·컨트롤 목록·쪽 수, DOCX는 모델 동일)로만 본다. 본문 부분의
  비교 대상이 엔진 자신이므로, 엔진이 읽지도 쓰지도 않는 본문 속 표시는 사전 검사(편집 없는 왕복)가 잡는다는 가정에 기댄다.
- HWP의 `PrvText`(미리보기 글자)는 rhwp가 편집 뒤에도 원본 그대로 둔다: 저장한 파일의 미리보기에 편집 전 글자가 남는다(손실은 아님).
- 교체와 직전 확인 사이(기록 잠금 안의 stat 뒤 rename)에 다른 프로그램이 같은 크기·수정 시각으로 바꾸면 잡지 못한다. 원본 해시는
  임시 파일을 쓴 뒤 다시 확인한다.
- 디렉터리 `fsync`가 실패하면 교체는 이미 됐고 `durable: false`로 알린다. 중단 뒤 남은 `.geul-save-*.tmp`의 정리는 T014.
- 확장 속성·ACL은 옮기지 않는다. Windows·macOS는 저장하지 않는다(T014·T016).
