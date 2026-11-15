# 문서 품질 행렬 (T015 로컬 범위, Stage 5-A — 2026-11-16)

> **2026-11-16 추가 근거:** fresh WordCraft bootstrap/protected compile 1/1 PASS, fontconfig real Boolean 1/1 및 bounded traversal 1/1 PASS, RHWP inventory unit 2/2·generated Release WASM 4/4·TypeScript typecheck PASS. 이는 read-only inventory까지만 증명한다. HWP/HWPX font mutation·T009 proof·registered user font save/render/native acceptance는 구현되지 않았거나 NOT RUN이다. 자세한 identity와 명령은 [font system 6절](architecture/font-system.md#6-검증)을 따른다.

이 행렬은 **지원 선언 범위** 안에서 이미 있는 PASS 근거를 재사용하고, Stage 5-A에서 새로 실행한 로컬 검사만 CURRENT로 적는다. 지원 범위를 넓히지 않는다. T015 전체 Done, 외부 Office 호환, Windows/macOS 수용, 출시 GO가 **아니다**.

- 기준 소스: 시작 `9471d7e`, PDF 구현 `639657a`, 미리보기 오라클 `9027acc`(이 문서와 같은 브랜치 `master`). 엔진 고정: RHWP `1a76570e`, WordCraft `6931bcc`(reproducible public-parent patch bootstrap). RHWP Release generation `2745ff0089af491711bed4ab1caf5ee60051950fe810fd2cfee2b1e5549fda8c`(WASM `7d63bfa38cbbc0919f78fe0c149cf18549071898afb4bf0c039df2689008503d`, source tree `a5265cb664d8e3a2cb57076afff19317ba3a711024e7b6e3ddd07b91f0461a0c`, build/publication and `externalUnchanged` PASS).
- 분류: **REUSED PASS**(과거 실행, 관련 소스 불변 — 이번에 다시 실행하지 않음) · **CURRENT PASS**(Stage 5-A에서 실행) · **GAP** · **FAIL** · **NOT RUN** · **DEFERRED** · **OUT OF SCOPE**.
- 구현 상태: **IV** 구현·검증 · **IU** 구현·미검증 · **SR** 미지원·안전 거부 · **IM** 구현 없음 · **EXT** 외부 수용 필요.
- 적용성(change-impact): Stage 5-A 제품 변경은 PDF 명령·PDF 서비스·PDF 전용 대화상자·알림 키다. **정정(후속 안정화)**: 처음 기록(“저장 서비스·문서 판별 불변, diff 비어 있음”)은 `929a0a2`까지만 맞다. Phase 2(`14880d6`)와 후속 안정화에서 공유 게시 모듈 `src-tauri/src/services/save/publish.rs`에 PDF 전용 `publish_exchange`(+ `ExchangeOutcome`, 시험용 fault `UnlinkReplaced`)가 추가되고 `snapshot`이 crate 공개로 바뀌었으며, `src-tauri/src/document/session.rs`에 PDF 게시 지점 `SessionRegistry::publish_for_current`가 추가됐다. 일반 문서 저장 경로(`service`·`stage`/`publish`/`stage_new`/`publish_new`·`finish_save`·판정·journal)는 바뀌지 않았고, 공유 모듈 회귀 `--lib services::save`는 249 PASS/3 FAIL/25 ignored로 Stage 4 기록과 같다(같은 기존 3개 실패). 엔진·패치·WASM·IME·Undo/Redo 경로는 바뀌지 않았다. 그래서 아래 REUSED 행은 현재 소스에 그대로 적용된다.

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
| 16 | 글꼴·글꼴 누락 | IV(fontconfig·사용자 글꼴·선택·저장·PDF) | 표시+read-only font inventory; mutation unsupported | 표시+read-only font inventory; mutation unsupported | CURRENT PASS(2026-11-15 native run10/DOCX 독립 검사; 2026-11-16 inventory API/tests) / 이전 CURRENT FAIL은 이력 | [글꼴 시스템](architecture/font-system.md) 6절 | HWP/HWPX font mutation·T009 proof·Canvas/PDF acceptance, Windows/macOS DEFERRED |

요구 사항 대응: FR-011(대표·손상·암호화·표·그림·수식·폰트·IME·PDF) → 행 1·3·5·6·7·12·15·16; SC-002 → 행 9·10; SC-004 → 행 9·13(T014); SC-009 → 행 2; SC-010 → 행 2·9(T023·T014).

## 2. Stage 5-A에서 찾은 로컬 품질 GAP

| 항목 | 관측 | 원인(확인) | 분류 | 남은 일 |
|---|---|---|---|---|
| DOCX 한글 글꼴 | 이 NixOS 호스트에서 DOCX 편집 화면과 PDF 모두 한글이 .notdef(네모)로 보임. PDF에는 Source Sans 3 부분 글꼴만 들어감 | WordCraft `FontDb::global()`이 `/usr/share/fonts`·`/usr/local/share/fonts`·`~/.fonts`·`~/.local/share/fonts`만 훑는다(`external/wordcraft/crates/fonts/src/fontdb.rs` `system_font_dirs`). 이 호스트의 한글 글꼴은 fontconfig/Nix store에만 있다 | GAP (기존 동작, PDF 결함 아님: PDF가 화면과 같다) | fontconfig 경로 등록 또는 번들 한글 글꼴 결정(DOCX 레이아웃이 바뀌므로 별도 승인·회귀 필요). 표준 배포판(/usr/share/fonts에 한글 글꼴)에서는 NOT RUN |
| 같은 실행을 사적 HOME(`~/.local/share/fonts/NanumGothic.ttf`, 시험 소유)으로 | DOCX 화면·PDF 한글 정상, PDF에 `NanumGothic` 부분 글꼴과 ToUnicode(한글 매핑) 포함 | — | CURRENT PASS | — |
| **해결(2026-11-15 글꼴 패키지)** — 위 두 행은 이력 | WordCraft FontDb가 fontconfig 제공자(실행 시 적재)의 파일 목록으로 시스템 글꼴을 카탈로그한다. 이 호스트 기본 환경에서 시스템 얼굴 137개, DOCX 선택 글꼴 NanumMyeongjo가 화면·배치·PDF(`OUCARL+NanumMyeongjo`, 한글 ToUnicode, `.notdef` 0)에 쓰임 | 폴더 고정 순회 → fontconfig 설정 | CURRENT PASS | Windows/macOS·다른 배포판 DEFERRED, [글꼴 시스템](architecture/font-system.md) |
| 외부 작성 DOCX 표본 | 로컬에 Word 작성 DOCX corpus 없음. PDF 시험 DOCX는 표준 라이브러리로 만든 OOXML(`rich-ko.docx`) | — | GAP / EXT | 외부 표본 확보는 S5-2와 함께 |

## 3. PDF 출력 수용 (S5-4)

- 구현: `file.exportPdf` (리본 파일 탭). DOCX = WordCraft `Session::print_pdf`(krilla, 인쇄 레이아웃, 벡터·부분 글꼴·ToUnicode). HWP/HWPX = 편집기와 같은 RHWP `renderPageToCanvas`로 쪽마다 192 px/in PNG → 백엔드 전체 디코드·크기/비율 검사 → krilla 쪽 그림 PDF(쪽 크기 = 실제 용지). **HWP/HWPX PDF는 글자 선택·검색 불가**(안내 문구에 표시).
- 실패 시 안전: 비동기 그림(rawSvg, 동기 디코드가 아닌 MIME) 쪽은 빠뜨리지 않고 **거부**(SR), 캡처 중 모델·판 변경·렌더 실패·한도 초과 거부, 대상은 `.pdf` 절대 경로만, 새 이름은 create-only(`RENAME_NOREPLACE`), 링크·폴더 거부, 부분 출력 없음, 문서·원본·dirty/revision/history 불변.
- **기존 PDF 덮어쓰기(Phase 2, 후속 안정화로 갱신)**: 프런트엔드가 경로를 보내는 것만으로는 덮어쓰지 않는다. PDF 대상은 전용 IPC `pdf_export_dialog(sessionId, loadGeneration, …)`로만 고르고(일반 `document_file_dialog`는 `pdf`를 거부), 백엔드가 직접 띄운 GTK 대화상자가 덮어쓰기 확인(`set_do_overwrite_confirmation`)을 거쳐 기존 일반 파일을 돌려줄 때만 **예측할 수 없는 128비트 토큰**의 일회용 허가를 발급해 경로와 함께 돌려준다. 허가는 정규화 대상, 관측한 파일 상태(장치·inode·크기·mtime·ctime·mode), 그 **세션·load generation**에 묶이고 10분 뒤 만료되며 최대 32개만 둔다. 토큰은 그 내보내기 요청에만 전달된다(DOCX `overwriteGrant` 인자, HWP/HWPX GPD1 메타 `overwriteGrant`). 다른 세션·generation·대상으로 제시하면 거부하고 허가는 주인에게 남는다(소비 못 함). 맞는 요청은 게시 전에 허가를 소비하고(한 번만), 게시 전에 거부된 내보내기는 자기 허가를 버린다. 취소한 대화상자는 아무것도 발급하지 않고, 겹친 두 내보내기는 각자 토큰을 가지며 먼저 교체한 쪽이 파일을 바꾸므로 다른 쪽은 신원 불일치로 `FileConflict`이다. 확인한 기존 파일이 그 뒤 삭제되면 새 파일 만들기로 바뀌지 않고 `FileConflict`이다(새 대상은 허가 없이 create-only). 교체는 기존 검증 staging 뒤 `renameat2(RENAME_EXCHANGE)` 원자 교환과 교환 뒤 신원 확인·되돌리기(`publish::publish_exchange`).
  - **교환 뒤 정리(후속 안정화)**: 교환되어 나온 이전 파일의 `unlinkat` 결과를 확인한다. 실패하면 PDF는 이미 게시된 상태로 성공을 돌려주되 이전 파일이 같은 폴더의 staging 이름에 남았음을 `retainedReplaced`로 보고하고 사용자에게 알린다(“이전 내용은 …에 남아 있습니다”, 자동 삭제 없음). 그 이름이 이미 다른 파일이면 지우지 않는다. journal 기록은 이때 은퇴시키지 않고 보존(release)한다 — 기록은 게시된 PDF inode를 가리키므로 이후 정리 단계는 staging 이름의 다른 inode를 보고 기록만 은퇴시키고 파일은 남긴다(시험으로 확인). 디렉터리 fsync 실패는 `durable: false`(미확인 안내). 게시가 보인 뒤에는 원본 보존을 약속하지 않는다.
  - **최종 예외 경계 안정화(2026-11-15)**: 첫 교환 후 staging 이름 조회에서 이전 inode 신원을 확인하지 못하면 `cleanupUncertain` 성공으로 처리하지 않고 `PdfReplacementUnverified`를 반환한다. 교환이 이미 일어났으므로 PDF가 보일 수 있으며, 이름을 추측해 되돌리거나 지우지 않고 journal 소유권을 보존한다. 신원 불일치가 관찰된 경우에만 staging 이름의 displaced snapshot·대상의 staged PDF inode·held directory 경로를 다시 확인한 뒤 rollback을 시도한다. 되돌리기 전후 결과를 확인할 수 없으면 파일과 journal을 보존하고 같은 부분 게시 오류를 반환한다. `FileConflict`는 관찰한 displaced 파일의 복귀와 staging의 소유 PDF 확인 후에만 반환한다. 이는 사용자가 확인한 원본 A가 복귀했다는 뜻은 아니다. **교체 identity가 검증된 뒤의 두 번째 cleanup lookup 실패**에 한해 기존 `cleanupUncertain: true`, `retainedReplaced: null` 성공 계약을 유지한다. `cleanupUncertain`과 교체 identity 불확실성은 다른 상태다.
  - 덮어쓰기 허가는 GTK 확인 뒤 백엔드가 발급한 128비트 일회용 토큰 자체가 해당 내보내기의 capability다. 매 chooser 확인마다 별도 토큰을 발급하고 프런트엔드는 토큰을 저장·재사용하지 않는다. Workspace가 내보내기 작업을 직렬화하고 grant 반환이 끝날 때까지 file-operation 예약을 유지하며, 종료 시 같은 세션과 정확한 토큰으로 `pdf_release_overwrite_grant`를 호출한다. 반환은 발급하지 않고 제거만 하며, 이미 소비된 토큰에도 안전하고 세션과 토큰이 일치할 때만 지운다. 10분 TTL, 최대 32개, 대상·파일 snapshot·세션·generation 결합과 기존 게시 검사는 유지한다. 백엔드는 같은 대상·세션·generation에 대한 별도 사용자 workflow를 토큰 제시만으로 더 구분할 수 없으므로, 토큰을 다른 workflow에 의도적으로 넘기는 클라이언트는 bearer capability를 양도한 것이다. 프런트엔드는 이를 하지 않고 겹친 export는 직렬화한다. 프런트엔드 프로세스 종료 때 `finally`는 실행되지 않는다. 백엔드 프로세스가 계속 살아 있으면 10분 만료가 fallback이며, 백엔드 프로세스 종료 시 프로세스 소유 grant 상태가 함께 사라진다. 생존 프로세스에서 IPC 반환이 실패해도 TTL 만료에 의존한다.
  - 남는 한계(문서화): GTK의 존재 확인과 허가 스냅숏 사이에 새로 생긴 파일은 보이지 않은 채 허가될 수 있다(신뢰하는 같은 사용자·root만 가능). 교환 직전~직후 사이의 ctime만 바뀌는 변경(확장 속성 등)은 교환 뒤 검사에서 잡지 못한다(교환이 ctime을 바꾸므로). 충돌 시 되돌리기 전 잠깐 PDF가 대상 이름에 보인다. 이전 구현은 되돌리기 자체가 실패하면 두 파일 모두 지우지 않고 `SaveFailure{publish}`로 알렸다. 이번 최종 마감에서는 되돌리기가 안전하지 않거나 실패·미확인인 경우 `PdfReplacementUnverified`로 부분 게시 가능성을 알린다. 허가는 프로세스 메모리에만 있어 앱 재시작으로 사라진다.
- **세션 게시 선형화(후속 안정화)**: 이전 구현은 세션을 스냅숏으로 확인한 뒤 잠금 밖에서 게시해, 확인과 rename 사이의 닫기·다시 불러오기·편집이 끼어들 수 있었다. 이제 두 엔진 모두 `services::pdf::publish_session_pdf` 하나를 쓴다: 허가 소비 → 잠금 밖 staging → `SessionRegistry::publish_for_current` 안에서(일반 저장 `finish_save`와 같은 방식으로 **레지스트리 잠금을 쥔 채**) 세션 존재·엔진·load generation·`ready`·확정 revision을 확인하고 마지막 원자 단계(rename/exchange, 디렉터리 fsync)만 실행한다. 닫기·다시 불러오기·실패 전이·편집 확정은 모두 이 잠금을 거치므로 게시 지점보다 앞서면 거부(아무것도 쓰지 않음, staged 파일 삭제), 뒤면 이미 커밋된 그 revision의 PDF로 남는다(뒤늦게 stale로 만들지 않음). 정책: 게시 지점 전 revision 변경은 거부(`RevisionMismatch`). 레지스트리가 유일한 권한이다: DOCX 모델 보관소 확인은 없앴다 — 닫기는 레지스트리에서 먼저 빼고 모델을 놓으며, 실패 전이는 `release_if`보다 앞서고, 다시 불러오기는 새 generation이라 놓이거나 바뀐 모델은 이 확인을 통과할 수 없다. 모델 mutex는 게시 동안 쥐지 않는다(잠금 순서: 레지스트리 안에서 콜백은 레지스트리·모델을 다시 잡지 않음). 레지스트리 잠금은 rename·fsync 동안만 쥔다(staging 쓰기는 밖에서).
| 검사 | 결과 | 근거 |
|---|---|---|
| Rust 단위·명령 (후속 안정화) | CURRENT PASS 11/11 | `CARGO_TARGET_DIR=src-tauri/target cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib -- pdf obsolete`: 새 이름 create-only·특수 대상 거부; 허가 토큰(다른 세션·generation·대상 사용 불가하고 주인에게 남음, 모르는 토큰, 1회, 만료, 실패 시 해제, 겹친 두 내보내기, **확인 뒤 삭제된 대상 → FileConflict**, 재생성·수정·rename·심볼릭 링크·hard link); 교환 경합 되돌리기·교환 전 실패; **정리 실패**(fault `UnlinkReplaced`: PDF 게시·이전 파일 보존·`retainedReplaced` 보고·journal 기록 보존 → 이후 `journal::cleanup` 이 파일 삭제 0·기록 은퇴 1, 관계없는 파일 불변) 및 정상 정리·디렉터리 fsync 실패(`durable: false`); **레지스트리 게시 지점**(게시 중 레지스트리 잠금 보유 확인, staging 뒤·게시 전 결정적 훅으로 편집·실패 전이·닫기 → 거부·파일 없음·staging 없음, 다시 불러오기 → `StaleLoad`, 다른 엔진 거부, 게시 뒤 편집·닫기는 PDF 유지, 세션 기록 불변); DOCX `obsolete_docx_pdf_results_are_never_published`(결정적 훅으로 게시 직전 편집·닫기, 다시 불러오기, 다른 세션 토큰 거부, 거부된 내보내기의 허가 소비). 공유 모듈 `--lib services::save` 249/3/25(기존 3개). 이전 기록: |
| Rust 단위·명령 (Phase 2, 이전) | 8/8 (역사 기록) | `CARGO_TARGET_DIR=src-tauri/target cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib -- pdf obsolete`: `services::pdf` 5(덮어쓰기 허가: 확인 교체·재사용 거부·다른 대상 거부·내용 변경·rename 교체·삭제 후 재생성·심볼릭 링크·hard link·만료·교환 전 실패·**교환 직전 경합 2건**(이름 교체, 제자리 쓰기 → 교환 뒤 검사로 되돌림)·새 이름 create-only·잔여물 없음), wordcraft `pdf_` 2 + `obsolete_docx_pdf_results_are_never_published`(revision 변경·다시 불러오기·닫기 거부, 확인된 기존 대상 불변·허가 소비). 실제 파일 시스템에서 실행(보호 sandbox의 1777 `/tmp`는 게시 계층이 `shared-directory`로 거부). 공유 모듈 확인: `--lib services::save` 249 PASS/3 FAIL/25 ignored — Stage 4 기록과 같은 기존 3개 실패 |
| 프런트엔드 | CURRENT PASS 9/9 | `src/components/Editor/rhwp/pdfCapture.test.ts` |
| Linux native (Release, X11, GTK 대화상자) | CURRENT PASS 4 양성 + 3 음성 | `scripts/tests/native-pdf-export.py` → `target/stage5a/native-pdf-run2/result.json`: DOCX 3쪽, HWP 4쪽, HWPX 18쪽, 가로 HWP 2쪽; 취소(파일 없음), 쓰기 불가 폴더(실패 안내·잔여물 없음), 비동기 그림 HWP(거부·파일 없음). 원본 SHA-256·세션(revision/dirty/state) 전후 동일 |
| 독립 구조 검사 | CURRENT PASS | `scripts/tests/pdf-export-inspect.mjs`(geul/krilla 코드 미사용): 쪽 수 = 원본 쪽 수 = 제품 안내, 쪽 순서(page tree), MediaBox = 원본 용지(A4 세로 595.3×841.9, 가로 841.9×595.3), 쪽 그림 1개/쪽·1588×2246(≈192 px/in), DOCX 글꼴 내장 |
| Linux native 후속 안정화 (새 Release, `pdf_export_dialog`) | CURRENT PASS 4 양성 + 덮어쓰기 3 + 음성 3 | `target/stage5a/native-pdf-run7-fu/result.json`(시험 소유 HOME에 NanumGothic): 대화상자 계약이 바뀌어 한 번 다시 실행 — GTK 확인 바꾸기 → 교체, 취소 → 불변, staging 잔여물 없음, 취소·쓰기 불가 폴더·비동기 그림 거부. `pdf-export-inspect.mjs` run7 PASS(쪽 수·크기·ToUnicode 한글 문구) |
| Linux native Phase 2 (새 Release, GTK 덮어쓰기 확인) | CURRENT PASS 4 양성 + 덮어쓰기 3 + 음성 3 | `target/stage5a/native-pdf-run6-p2/result.json`(시험 소유 HOME에 NanumGothic): 실제 GTK 확인 대화상자 "이 파일을 바꾸시겠습니까?"에서 바꾸기 → 교체(inode 바뀜), 취소 → 파일 불변(inode·mtime·SHA 동일), staging 잔여물 없음; X 화면 증거 `overwrite-confirm-{accept,decline}.png`. 앞선 run4/run5는 시험 도구가 GTK 파일명 자동 완성 팝업에 Return을 보내 실패했다(제품 결함 아님, 두 번째 활성화와 Alt+R로 수정) |
| 독립 텍스트·쪽 수 검사 (Phase 2) | CURRENT PASS(run6) / 기대대로 FAIL(run2) | `pdf-export-inspect.mjs`가 내용 스트림 Tj/TJ를 ToUnicode CMap으로 풀어 쪽별 문구 13개(한글·영문·표 칸)를 확인하고 매핑 없는 글리프 코드 0을 요구한다. DOCX 쪽 수는 WordCraft와 무관하게 `word/document.xml` 쪽 나눔+1(이 fixture에서 정확)과 편집기 상태 표시 쪽 수 모두 3과 일치. run6: 한글이 `NanumGothic` ToUnicode로 추출됨. run2(기본 환경): 한글 문구 없음으로 FAIL — 2절 글꼴 GAP을 독립 검사가 드러낸다 |
| 독립 시각 검사 | CURRENT PASS(조건) | Firefox 내장 pdf.js 렌더 화면 확인(`target/stage5a/visual/`): HWP 한글·표·사진, HWPX 수식·도형·2단, 가로 쪽, DOCX 서식·표·그림. DOCX 한글은 2절 조건 |
| 다른 OS·인쇄 | NOT RUN / IM | `file.print`는 여전히 planned(구현 없음) |

### 최종 PDF 예외 경계 회귀 (2026-11-15)

표의 `CARGO_TARGET_DIR`은 실제 실행에 사용한 동일한 `src-tauri/target` 디렉터리를 상대 경로로 표기했다. 신규 실행은 아래 4건만 했다. 기존 PASS 테스트는 재실행하지 않았습니다.

| 신규 테스트 | 실행 명령 | 결과·확인한 속성 |
|---|---|---|
| `pdf_post_exchange_lookup_failure_preserves_uncertain_cleanup` | `CARGO_TARGET_DIR=src-tauri/target cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib services::pdf::tests::pdf_post_exchange_lookup_failure_preserves_uncertain_cleanup -- --exact` | PASS 1/1: 교환 뒤 조회 오류에서 이전 inode 무삭제, journal 보존, PDF 게시 유지, `cleanupUncertain` 직렬화 |
| `pdf_abandoned_grants_release_only_the_owned_capability` | `CARGO_TARGET_DIR=src-tauri/target cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib services::pdf::tests::pdf_abandoned_grants_release_only_the_owned_capability -- --exact` | PASS 1/1: 조기 종료 허가 해제·다른 세션의 해제/소비 차단·반환 멱등성·소비 후 반환 안전성·정상 교체 |
| `releases each early or overlapping workflow grant without letting another export inherit it` | `npx vitest run src/components/Editor/rhwp/pdfCapture.test.ts -t 'releases each early or overlapping workflow grant without letting another export inherit it'` | PASS 1, 9 skipped: 잘못된 목적지와 RHWP 비동기 캡처 조기 종료 시 각 토큰 반환, 겹친 export 차단 |
| `queues both PDF cleanup and durability warnings, including unverified cleanup` | `npx vitest run src/components/StatusBar/publicationWarning.test.ts -t 'queues both PDF cleanup and durability warnings, including unverified cleanup'` | PASS 1, 6 skipped: 확인된 보존/불확실 정리와 내구성 경고가 KO·EN 확인 대기열에 모두 남음 |

필요한 프런트엔드 빌드 계약 검사 `npm run typecheck`도 PASS했다. 역사 근거는 REUSED이며 다시 실행하지 않았다: 기존 Rust PDF 11/11, `services::save` 249 PASS/3 기존 FAIL/25 ignored, PrvImage 오라클 6/6, Stage 4 게시 재검사 10/10, 기존 Vitest 34/34 및 editor/commands 테스트, TypeScript/ESLint/Clippy, native PDF run7, 독립 PDF 검사, 렌더링·ToUnicode 수용. 위 기존 실패 3 Rust와 4 Vitest는 그대로 유지한다. 최종 세 PDF 예외 경계는 수용 완료; Stage 5-A 전체는 PARTIALLY COMPLETED다.

### 교환 직후 identity 조회 실패 최종 수정 (2026-11-15)

`16a447f` 후속 검토에서 첫 `RENAME_EXCHANGE` 뒤 `fstatat` 오류를 `identity_uncertain`으로 삼아도 성공 경로가 계속될 수 있음을 확인했다. 이전 `InspectReplaced` 근거는 교체 identity 확인 뒤 두 번째 cleanup 조회만 다뤘다. 이제 첫 조회 오류는 `PdfReplacementUnverified`로 반환한다: 게시가 이미 일어났을 수 있음을 사용자에게 알리고, 교체됐다고 승인하지 않으며, 추측 rollback·삭제를 하지 않고 staging entry와 journal record를 보존한다. 이 오류는 `cleanupUncertain` 상태와 분리되고 Workspace의 publication notice에도 기록된다. 관찰된 identity 불일치 rollback은 displaced snapshot과 link count, destination의 staged inode, held directory 경로를 재확인하고 rollback 후 displaced snapshot 및 staging 소유 PDF를 확인할 때만 `FileConflict`를 반환한다. 이는 확인된 A가 복귀했다는 보장이 아니다. 검사와 두 번째 exchange 사이에 같은 사용자/root가 이름을 바꾸는 경쟁은 커널의 두 이름 조건부 교환 primitive가 없어 완전히 막을 수 없으며, 열린 file descriptor 쓰기와 교환 구간의 ctime-only 변경 제한도 남는다. 알 수 없는 첫 조회 오류에서는 rollback을 시도하지 않는다.

아래 `CARGO_TARGET_DIR`은 실제 실행한 절대 경로와 같은 디렉터리의 상대 표기다. 신규 실행은 아래 Rust·프런트엔드 테스트와 필요한 typecheck만 했다. 기존 PASS 테스트는 재실행하지 않았습니다.

| 신규 테스트 | 실제 실행 명령 | 결과·확인 |
|---|---|---|
| `pdf_first_exchange_identity_failure_never_accepts_unverified_replacement` | `CARGO_TARGET_DIR=src-tauri/target cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib services::pdf::tests::pdf_first_exchange_identity_failure_never_accepts_unverified_replacement -- --exact` | PASS 1, 494 filtered. 실제 파일과 journal 검사 5개 하위 경우: 첫 조회 실패, A→B 치환+첫 조회 실패, 확인된 rollback, guard 직전 destination 이동, guard 직전 staging 이동. 미검증 overwrite 성공 없음, unrelated file 삭제 없음. |
| `retains unverified PDF replacement as a partial publication error` | `npx vitest run src/components/StatusBar/publicationWarning.test.ts -t 'retains unverified PDF replacement as a partial publication error'` | PASS 1, 7 skipped. Backend error parsing, Workspace publication notice/grant release, KO·EN acknowledgement 문구 확인. |
| TypeScript contract | `npm run typecheck` | PASS. |

커밋 훅의 Gitleaks가 신규 테스트의 가짜 토큰 리터럴을 키로 판정해 첫 커밋 시도를 거부했다. 훅을 우회하지 않고 fixture를 반복 문자열 생성으로 바꿔 동일 신규 프런트엔드 사례만 다시 검증했다. Rust 및 제품 소스는 바뀌지 않았다.

역사 근거는 **REUSED**: 기존 Rust PDF 11/11, 직전 최종 경계 Rust 2/2와 frontend 2/2, save 249 PASS/3 기존 FAIL, PrvImage 6/6, Stage 4 게시 10/10, 이전 Vitest/native run7/독립 구조·텍스트·ToUnicode·렌더링 근거. 이전 rollback 테스트는 재실행하지 않았다. Package A — PDF Safety: COMPLETED(본 변경의 검증된 로컬 커밋 포함); Package B — MIT 및 third-party notices: COMPLETED; Stage 5-A: PARTIALLY COMPLETED; Stage 5: INCOMPLETE; Release: NO-GO.

## 4. S5-6 HWP 미리보기 오라클

`scripts/tests/hwp-preview-oracle.mjs`가 재생성 PrvImage를 독립 판정한다: 정규 PNG 엄격 디코드, 게시 파일 Section0 PAGE_DEF로 다시 계산한 크기, 게시 파일 1쪽의 독립 렌더(RHWP SVG + librsvg)와 블록 휘도 상관 ≥ 0.8, 원본 대비 실제 재생성, 다른 T009 근거 없음. 서비스가 그 저장에서 부호화한 바이트와의 동일성은 오프라인으로 증명할 수 없어 `serviceIdentity: product-gate`로만 적는다.

| 검사 | 결과 |
|---|---|
| Stage 4 기존 게시 10건 재검증(`--report-dir`, 과거 증거 불변) | CURRENT PASS, 재생성 미리보기 2건 상관 0.9983 (Phase 2 오라클로 다시 PASS, `target/stage5a/s5-6/oracle-phase2`) |
| 빈 첫 쪽 RGB 비교 (후속 안정화) | 결함 확인 후 수정: 휘도만 보던 기준은 균일한 빨강 rgb(255,0,0) 미리보기와 균일한 회색 rgb(76,76,76) 참조(휘도 76.2 vs 76)를 같은 빈 쪽으로 받았다(실행으로 확인). 이제 채널별(R·G·B) 범위 ≤ 2면 균일, 채널별 평균 차 ≤ 4면 같은 색. 시험 PASS: 흰/흰, 검/검, ±1 잡음 같은 색 통과; 빨강/같은 휘도 회색, 파랑/흰, 6단계 채널 차, 균일/내용, 내용/균일, 범위 초과 잡음 거부; 내용 있는 쪽은 상관 규칙 그대로. 오라클 node 시험 6/6, Stage 4 게시 10건 재검증 PASS(`target/stage5a/s5-6/oracle-followup`). 실제 빈 첫 쪽 게시본 native 시험은 여전히 NOT RUN |
| 빈 첫 쪽 경계 (Phase 2) | 문제 확인 후 수정: 균일한(빈) 래스터는 분산 0이라 상관이 0이 되어 정당한 빈 첫 쪽 미리보기가 거부됐다. 실제 빈 HWP 2건(`target/hwp-record-investigation/external-blank.hwp`, `…/blank2010.hwp`)의 독립 참조 렌더는 휘도 범위 0.00(완전 균일). 이제 참조·미리보기가 모두 균일(휘도 범위 ≤ 2)하고 평균이 4 이내일 때만 빈 쪽으로 인정하고, 한쪽만 균일하면 거부한다. 단위 시험 PASS; 로컬에 실제 빈 첫 쪽 게시본은 없어(정규 미리보기 57개 검사, 균일 0) 실제 게시본 양성 시험은 NOT RUN |
| 음성 대조(실제 게시 파일 CFB 스트림 제자리 변조) | CURRENT PASS 6/6 (Phase 2 빈 쪽 시험 포함): PNG 서명만 있는 손상 PrvImage 거부(이전 오라클은 통과시킴), 크기 맞는 정규 PNG지만 다른 내용 거부, PrvText 추가 근거 거부 |

## 5. 의도적으로 다시 실행하지 않은 것

T009 전체, T010 D1–D5, native 50/50·56/56, Stage 2 그림/수식/깊은 표, Stage 3 수용, Stage 4 Scenario A/B native, 187/64 렌더 행렬, D4 벤치마크, WordCraft/DOCX 전체 시험. 관련 소스가 바뀌지 않았다. 프런트엔드 전체 vitest는 명령 레지스트리(전역) 변경 때문에 한 번 실행했다: 1460 PASS / 4 FAIL — 네 FAIL(`hangulTools` 1, `sessions` rhwp 1, `hwpReopenModel` 2)은 시작 HEAD 작업 트리에서 그대로 실패하는 기존 실패다.

## 6. 남은 T015 의무

외부 작성 DOCX/HWP corpus 확대, ~~글꼴 탐색 GAP 해결~~(2026-11-15 NixOS에서 해결, 다른 OS DEFERRED), HWP/HWPX 글꼴 변경 저장 증명, Word/한컴 외부 호환(S5-2), Windows/macOS(S5-3), 정전·FS 고장(T014). 이 문서는 T015 로컬 범위 수용 기록이며 T015 전체 Done이 아니다.

## 7. Stage 5-A 글꼴 패키지 (2026-11-16)

| 구분 | 내용 |
|---|---|
| IMPLEMENTED | 공유 카탈로그(시스템·사용자·번들), fontconfig 실행 시 적재 제공자(경로 하드코딩 없음, 없으면 unavailable 보고), TTF/OTF/WOFF/WOFF2 등록·앱 전용 저장·재적재·제거, 리본 글꼴 선택기(한/영), DOCX `format.font`·배치·저장·PDF, RHWP 글꼴 표시·사용자 글꼴 WebView 전달 |
| CURRENT PASS | Historical: Rust 글꼴/DOCX 15, WordCraft fonts 51, native run10 and independent DOCX/PDF. 2026-11-16: WordCraft fresh bootstrap/compile 1, fontconfig Boolean/iteration 2, RHWP inventory unit 2 + Release-WASM 4, typecheck; details in [font system 6절](architecture/font-system.md#6-검증) |
| REUSED PASS | PDF 게시 안전, T009, IME, Stage 2–4 (코드 경로 불변) |
| NOT RUN / UNVERIFIED | 가변 CJK 대체 얼굴의 시각 굵기, RHWP Canvas 사용자 글꼴 픽셀 비교, 글꼴 선택기 native 키보드 전체 탐색 |
| 미구현 | HWP/HWPX 글꼴 변경(저장 증명이 글꼴 ID·새 글꼴 이름을 받지 않음 — 명시적 거부) |
| DEFERRED | Windows/macOS 빌드·설치·실행, 다른 Linux 배포판, fontconfig 배포 의존성 |
