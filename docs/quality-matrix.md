# 문서 품질 행렬 (T015 로컬 범위, Stage 5-A — 2026-11-15)

이 행렬은 **지원 선언 범위** 안에서 이미 있는 PASS 근거를 재사용하고, Stage 5-A에서 새로 실행한 로컬 검사만 CURRENT로 적는다. 지원 범위를 넓히지 않는다. T015 전체 Done, 외부 Office 호환, Windows/macOS 수용, 출시 GO가 **아니다**.

- 기준 소스: 시작 `9471d7e`, PDF 구현 `639657a`, 미리보기 오라클 `9027acc`(이 문서와 같은 브랜치 `master`). 엔진 고정: RHWP `1a76570e`, WordCraft `dc25d8a2`. RHWP Release generation `1b09639e…a36565`(WASM `669acfeb…c0831`, `scripts/rhwp-artifacts.py --verify-product dist/rhwp --profile release` PASS).
- 분류: **REUSED PASS**(과거 실행, 관련 소스 불변 — 이번에 다시 실행하지 않음) · **CURRENT PASS**(Stage 5-A에서 실행) · **GAP** · **FAIL** · **NOT RUN** · **DEFERRED** · **OUT OF SCOPE**.
- 구현 상태: **IV** 구현·검증 · **IU** 구현·미검증 · **SR** 미지원·안전 거부 · **IM** 구현 없음 · **EXT** 외부 수용 필요.
- 적용성(change-impact): Stage 5-A 제품 변경은 PDF 명령·PDF 서비스·파일 대화상자 `pdf` 모드·알림 키뿐이다. 저장 서비스(`src-tauri/src/services/save`), 문서 판별(`src-tauri/src/document`), 엔진·패치·WASM·IME·Undo/Redo 경로는 바뀌지 않았다(`git diff 9471d7e HEAD -- src-tauri/src/services/save src-tauri/src/document` 비어 있음). 그래서 아래 REUSED 행은 현재 소스에 그대로 적용된다.

## 1. 형식 × 기능 행렬

| # | 기능군 | DOCX | HWPX | HWP | 분류 | 근거 | 미검증 범위 |
|---|---|---|---|---|---|---|---|
| 1 | 기존 지원 문서 열기·표시 | IV | IV | IV | REUSED PASS + CURRENT PASS(외부 작성 HWP/HWPX 3건 열기·전 쪽 렌더) | T007/T008/T009 기록, [T009 왕복](architecture/save-roundtrip-acceptance-2026-11-02.json); Stage 5-A `target/stage5a/native-pdf-run2/result.json`(hongbo.hwp 4쪽, 3-10월 hwpx 18쪽, 가로 hwp 2쪽) | 모든 제3자 HWP 편집 가능성은 주장하지 않음 |
| 2 | 새 문서 생성 | IV | IV | IV | REUSED PASS | T021–T023, [native](architecture/new-document-native-acceptance-2026-11-04.json), [생성 계약](architecture/new-document-creation.md) | T024 DEFERRED |
| 3 | 글자 입력·한글 IME | IV | IV | IV | REUSED PASS (Linux X11/IBus) | [T010 제품 활성화](architecture/t010-production-activation-2026-11-12.json), [phase5 IBus](architecture/phase5-native-gui-ibus-closure-2026-11-11.json) | Wayland/fcitx5·Windows·macOS DEFERRED |
| 4 | 글자·문단 서식 | IV | IV | IV | REUSED PASS | T010/T011, [일반 서식](architecture/rhwp-general-formatting.md), [명령 레지스트리](architecture/command-registry.md) | 지원 명령 밖 서식 없음 |
| 5 | 표·중첩 표 | IV(기본 표) | IV | IV | REUSED PASS | T012 Phase 2, Stage 2/4 기록([stage567](architecture/stage567-acceptance-2026-11-05.md)) | DOCX 표 구조 명령은 미지원(레지스트리 unsupported) |
| 6 | 그림·내장 자원 | IV(삽입) | IV | IV | REUSED PASS | Stage 2 그림, Stage 4 native(BinData 동일성) | 비동기 그림 MIME은 PDF에서 SR(아래 3절) |
| 7 | 수식 필드(표 계산식) | OUT OF SCOPE | IV | IV | REUSED PASS | Stage 3 캐시 수용, Stage 4 native, [S5-6 오라클](#4-s5-6-hwp-미리보기-오라클) | 한컴 재계산 EXT |
| 8 | 고급 요소 | IV(TOC·메모·각주·변경 추적 내부) | IV(장평·자간 등 T012 부분) | IV(동일) | REUSED PASS(내부) | T012·T013 기록 | Word/한컴 외부 호환 EXT(S5-2 DEFERRED) |
| 9 | 저장·다른 이름으로 저장 | IV | IV | IV | REUSED PASS | T009, [T014](architecture/t014-final-acceptance-2026-11-12.json) | 정전·실제 FS 고장 DEFERRED |
| 10 | 재열기·추가 편집 | IV | IV | IV | REUSED PASS | SC-002/SC-009: T009·T023 native 재열기 | — |
| 11 | Undo/Redo | IV | IV | IV | REUSED PASS | T010 D1–D5 | D4 지연 목표 TARGET NOT MET(별도, T010) |
| 12 | 손상·미지원·암호화 입력 | SR | SR | SR | REUSED PASS + CURRENT PASS(`document::` 63 PASS/0 FAIL/4 ignored, 코드 불변) | T006 판별·거부 계약(`src-tauri/src/document/tests.rs` `암호화와_drm_문서를_거부한다` 등) | 실제 외부 암호화 표본 corpus 없음(합성 컨테이너로 검증) |
| 13 | 보존·안전 거부 | IV | IV | IV | REUSED PASS | T009 보존 판정, Stage 3/4 거부 경로 | — |
| 14 | Linux native 통합 | IV | IV | IV | REUSED PASS + CURRENT PASS(PDF 명령·GTK 대화상자) | Stage 4 native, Stage 5-A PDF native run2 | Windows/macOS DEFERRED(S5-3) |
| 15 | **PDF 출력** | IV(벡터·글자 선택 가능) | IV(쪽 그림) | IV(쪽 그림) | CURRENT PASS (조건: 3절) | 3절 | 다른 OS·인쇄 미구현 |
| 16 | 글꼴·글꼴 누락 | **GAP**(아래) | IV | IV | CURRENT FAIL(이 호스트 DOCX) / CURRENT PASS(사적 HOME에 한글 글꼴) | 2절 | 3절 |

요구 사항 대응: FR-011(대표·손상·암호화·표·그림·수식·폰트·IME·PDF) → 행 1·3·5·6·7·12·15·16; SC-002 → 행 9·10; SC-004 → 행 9·13(T014); SC-009 → 행 2; SC-010 → 행 2·9(T023·T014).

## 2. Stage 5-A에서 찾은 로컬 품질 GAP

| 항목 | 관측 | 원인(확인) | 분류 | 남은 일 |
|---|---|---|---|---|
| DOCX 한글 글꼴 | 이 NixOS 호스트에서 DOCX 편집 화면과 PDF 모두 한글이 .notdef(네모)로 보임. PDF에는 Source Sans 3 부분 글꼴만 들어감 | WordCraft `FontDb::global()`이 `/usr/share/fonts`·`/usr/local/share/fonts`·`~/.fonts`·`~/.local/share/fonts`만 훑는다(`external/wordcraft/crates/fonts/src/fontdb.rs` `system_font_dirs`). 이 호스트의 한글 글꼴은 fontconfig/Nix store에만 있다 | GAP (기존 동작, PDF 결함 아님: PDF가 화면과 같다) | fontconfig 경로 등록 또는 번들 한글 글꼴 결정(DOCX 레이아웃이 바뀌므로 별도 승인·회귀 필요). 표준 배포판(/usr/share/fonts에 한글 글꼴)에서는 NOT RUN |
| 같은 실행을 사적 HOME(`~/.local/share/fonts/NanumGothic.ttf`, 시험 소유)으로 | DOCX 화면·PDF 한글 정상, PDF에 `NanumGothic` 부분 글꼴과 ToUnicode(한글 매핑) 포함 | — | CURRENT PASS | — |
| 외부 작성 DOCX 표본 | 로컬에 Word 작성 DOCX corpus 없음. PDF 시험 DOCX는 표준 라이브러리로 만든 OOXML(`rich-ko.docx`) | — | GAP / EXT | 외부 표본 확보는 S5-2와 함께 |

## 3. PDF 출력 수용 (S5-4)

- 구현: `file.exportPdf` (리본 파일 탭). DOCX = WordCraft `Session::print_pdf`(krilla, 인쇄 레이아웃, 벡터·부분 글꼴·ToUnicode). HWP/HWPX = 편집기와 같은 RHWP `renderPageToCanvas`로 쪽마다 192 px/in PNG → 백엔드 전체 디코드·크기/비율 검사 → krilla 쪽 그림 PDF(쪽 크기 = 실제 용지). **HWP/HWPX PDF는 글자 선택·검색 불가**(안내 문구에 표시).
- 실패 시 안전: 비동기 그림(rawSvg, 동기 디코드가 아닌 MIME) 쪽은 빠뜨리지 않고 **거부**(SR), 캡처 중 모델·판 변경·렌더 실패·한도 초과 거부, 대상은 `.pdf` 절대 경로만, 새 이름은 create-only, 기존 일반 파일은 GTK 덮어쓰기 확인 뒤 검증된 원자적 교체, 링크·폴더 거부, 부분 출력 없음, 문서·원본·dirty/revision/history 불변.

| 검사 | 결과 | 근거 |
|---|---|---|
| Rust 단위·명령 | CURRENT PASS 6/6 | `cargo test --lib services::pdf` 4, wordcraft `pdf_` 2 (실제 파일 시스템; 보호 sandbox의 1777 `/tmp`에서는 게시 계층이 `shared-directory`로 거부하므로 sandbox 밖에서 실행) |
| 프런트엔드 | CURRENT PASS 9/9 | `src/components/Editor/rhwp/pdfCapture.test.ts` |
| Linux native (Release, X11, GTK 대화상자) | CURRENT PASS 4 양성 + 3 음성 | `scripts/tests/native-pdf-export.py` → `target/stage5a/native-pdf-run2/result.json`: DOCX 3쪽, HWP 4쪽, HWPX 18쪽, 가로 HWP 2쪽; 취소(파일 없음), 쓰기 불가 폴더(실패 안내·잔여물 없음), 비동기 그림 HWP(거부·파일 없음). 원본 SHA-256·세션(revision/dirty/state) 전후 동일 |
| 독립 구조 검사 | CURRENT PASS | `scripts/tests/pdf-export-inspect.mjs`(geul/krilla 코드 미사용): 쪽 수 = 원본 쪽 수 = 제품 안내, 쪽 순서(page tree), MediaBox = 원본 용지(A4 세로 595.3×841.9, 가로 841.9×595.3), 쪽 그림 1개/쪽·1588×2246(≈192 px/in), DOCX 글꼴 내장 |
| 독립 시각 검사 | CURRENT PASS(조건) | Firefox 내장 pdf.js 렌더 화면 확인(`target/stage5a/visual/`): HWP 한글·표·사진, HWPX 수식·도형·2단, 가로 쪽, DOCX 서식·표·그림. DOCX 한글은 2절 조건 |
| 다른 OS·인쇄 | NOT RUN / IM | `file.print`는 여전히 planned(구현 없음) |

## 4. S5-6 HWP 미리보기 오라클

`scripts/tests/hwp-preview-oracle.mjs`가 재생성 PrvImage를 독립 판정한다: 정규 PNG 엄격 디코드, 게시 파일 Section0 PAGE_DEF로 다시 계산한 크기, 게시 파일 1쪽의 독립 렌더(RHWP SVG + librsvg)와 블록 휘도 상관 ≥ 0.8, 원본 대비 실제 재생성, 다른 T009 근거 없음. 서비스가 그 저장에서 부호화한 바이트와의 동일성은 오프라인으로 증명할 수 없어 `serviceIdentity: product-gate`로만 적는다.

| 검사 | 결과 |
|---|---|
| Stage 4 기존 게시 10건 재검증(`--report-dir`, 과거 증거 불변) | CURRENT PASS, 재생성 미리보기 2건 상관 0.9983 |
| 음성 대조(실제 게시 파일 CFB 스트림 제자리 변조) | CURRENT PASS 5/5: PNG 서명만 있는 손상 PrvImage 거부(이전 오라클은 통과시킴), 크기 맞는 정규 PNG지만 다른 내용 거부, PrvText 추가 근거 거부 |

## 5. 의도적으로 다시 실행하지 않은 것

T009 전체, T010 D1–D5, native 50/50·56/56, Stage 2 그림/수식/깊은 표, Stage 3 수용, Stage 4 Scenario A/B native, 187/64 렌더 행렬, D4 벤치마크, WordCraft/DOCX 전체 시험. 관련 소스가 바뀌지 않았다. 프런트엔드 전체 vitest는 명령 레지스트리(전역) 변경 때문에 한 번 실행했다: 1460 PASS / 4 FAIL — 네 FAIL(`hangulTools` 1, `sessions` rhwp 1, `hwpReopenModel` 2)은 시작 HEAD 작업 트리에서 그대로 실패하는 기존 실패다.

## 6. 남은 T015 의무

외부 작성 DOCX/HWP corpus 확대, 글꼴 탐색 GAP 해결, Word/한컴 외부 호환(S5-2), Windows/macOS(S5-3), 정전·FS 고장(T014). 이 문서는 T015 로컬 범위 수용 기록이며 T015 전체 Done이 아니다.
