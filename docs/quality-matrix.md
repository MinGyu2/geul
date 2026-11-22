# 문서 품질 행렬 (T015 로컬 범위, Stage 5-A — 2026-11-16)

> **현재 글꼴 판정(2026-11-16):** Stage 5-A 글꼴 패키지 COMPLETED(지원 범위) — HWP/HWPX font editing·T009 proof·native save/reopen, RHWP natural metrics·줄바꿈·table-cell native acceptance PASS([7절](#7-stage-5-a-글꼴-패키지-2026-11-16), [font system 6.3·6.4절](architecture/font-system.md#64-rhwp-natural-font-metrics-검증-2026-11-16-nixos-release-generation-5dc438563e192fe4370b6ec0bb5f0b9bddf70f637b72e53ab889f77e8402e124)). 복합 shaping·Windows/macOS·다른 배포판·외부 오피스 재열기는 미수용. Stage 5-A 전체 PARTIALLY COMPLETED, Release NO-GO.
>
> **역사 기록(2026-11-16 초기, read-only inventory 단계):** fresh WordCraft bootstrap/protected compile 1/1 PASS, fontconfig real Boolean 1/1 및 bounded traversal 1/1 PASS, RHWP inventory unit 2/2·generated Release WASM 4/4·TypeScript typecheck PASS. 당시에는 read-only inventory까지만 증명했고 HWP/HWPX font mutation·T009 proof·registered user font save/render/native acceptance는 구현 전 또는 NOT RUN이었다(이후 위 현재 판정으로 대체). 자세한 identity와 명령은 [font system 6절](architecture/font-system.md#6-검증)을 따른다.

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
| 5 | 표·중첩 표 (생성·구조 편집·셀 서식) | IV(삽입·구조 10명령·`1×1` 분할·셀 서식) | IV(본문/중첩·구조·`1×1` 분할·셀 서식) | IV(본문/중첩·구조·`1×1` 분할·셀 서식) | CURRENT PASS(HWP 테두리 재열기) + REUSED PASS(P1/P2/P3 전체 및 DOCX/HWPX native) | [Stage 1/2 7–9절](architecture/stage1-common-editing.md#7-stage-2--phase-1--docx-표-구조-편집-2026-11-17), [Stage 2/4](architecture/stage567-acceptance-2026-11-05.md) | RHWP 행 규칙 `exact`/auto 미지원(`atLeast`만), 비병합 외 병합 셀 재분할·교차 표/SDT/안전 재배치 불가 continuation 거부, 외부 Word/한컴 재열기 NOT RUN |
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
| 16 | 글꼴·글꼴 누락 | IV(fontconfig·사용자 글꼴·선택·저장·PDF) | seven-slot mutation + existing/new definitions + narrow T009 save/reopen + natural metrics | seven-slot mutation + existing/new definitions + narrow T009 save/reopen + natural metrics | CURRENT PASS: Linux Release native HWP/HWPX natural metrics(advance·wrap·caret·selection·Canvas/PDF) and table-cell acceptance run12, independent inspection | [글꼴 시스템](architecture/font-system.md) 6.3·6.4절 | complex shaping(ligature/contextual/RTL/kerning) unsupported and documented; external office NOT RUN; nested-cell native NOT RUN; Windows/macOS DEFERRED |

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

T009 전체 acceptance matrix, T010 D1–D5, native 50/50·56/56, Stage 2 그림/수식/깊은 표, Stage 3 수용, Stage 4 Scenario A/B native, 187/64 렌더 행렬, D4 벤치마크, WordCraft/DOCX 전체 시험. 글꼴 작업에는 별도 focused Rust/WASM/native 검증을 실행했으며, 위 전체 matrix들은 재실행하지 않았다. **역사 기록(PDF 단계):** 프런트엔드 전체 vitest는 당시 명령 레지스트리 변경 때문에 실행해 1460 PASS / 4 FAIL이었다. 네 FAIL(`hangulTools` 1, `sessions` rhwp 1, `hwpReopenModel` 2)은 당시 시작 HEAD 작업 트리에서도 재현된 기존 실패다. 이번 font task에서는 full Vitest suite를 실행하지 않았다.

## 6. 남은 T015 의무

외부 작성 DOCX/HWP corpus 확대, ~~글꼴 탐색 GAP 해결~~(2026-11-15 NixOS에서 해결, 다른 OS DEFERRED), ~~natural font metrics/wrapping~~(2026-11-16 해결; complex shaping은 지원 범위 밖으로 문서화), Word/한컴 외부 호환(S5-2), Windows/macOS(S5-3), 정전·FS 고장(T014), Release private-path cleanup. 이 문서는 T015 로컬 범위 수용 기록이며 T015 전체 Done이 아니다.

## 7. Stage 5-A 글꼴 패키지 (2026-11-16)

상태: **글꼴 패키지 COMPLETED (지원 범위, 2026-11-16 natural metrics 포함)**. 이전 기록(natural metrics 미구현)은 아래 표의 역사 행으로 남긴다. 복합 shaping은 지원 범위 밖으로 문서화했다. Stage 5-A 전체는 PARTIALLY COMPLETED(Release private-path cleanup 별도), Stage 5 INCOMPLETE, Release NO-GO다.

| 구분 | 내용 |
|---|---|
| IMPLEMENTED | 공유 시스템/사용자/번들 카탈로그와 fontconfig 제공자, TTF/OTF/WOFF/WOFF2 사용자 등록·앱 전용 영속화, DOCX `format.font`/layout/save/PDF; RHWP seven-slot exact document ID resolution, existing face reuse, supported missing face append, `format.font` session/history integration, HWP/HWPX-specific T009 proofs and font+shape publication identity. |
| CURRENT PASS | Rust `font_preservation_tests`: 4 PASS. Release WASM font-editing: 14 PASS (core, session/stale, cell/pending, per-language selection/caret). Resolver/picker: 15 PASS. Protected Release generation `cfb26d65aaf99c16386dbd24497f8a79dcf4caa63e17bd9da53ba839700b619c`; native run4/negative3/independent4 on that generation. Linux native Release: existing NanumMyeongjo and registered GeulMono Test1; HWP/HWPX apply, visible Canvas pixels, Undo/Redo, save/close/reopen and independent identity/PDF inspection PASS. Negative HWP unsupported FACE_NAME and HWPX unknown header attribute refusal plus original/recovery checks PASS. Details, hashes and reports: [font system 6.3절](architecture/font-system.md). |
| REUSED PASS | WordCraft 51, prior geul font 15, font bootstrap/fontconfig, DOCX native run10, PDF publication safety, unrelated T009/T014 and IME/history evidence. These are historical/reused, not new font mutation proof. |
| FAILED (historical, harness fixed) | Earlier native-run1/run2 and negative-run1 attempts failed on harness tab/close semantics; corrected harness runs are run3/negative2 PASS (prior generation); current-generation reruns run4/negative3 PASS. Initial Release build publication cap/retention and HWPX face type mismatch were corrected without relaxing caps or deleting retained artifacts. Logs remain under `target/font-completion/`. |
| CURRENT PASS (natural metrics, 2026-11-16) | RHWP natural font metrics on Release generation `5dc43856…`: native unit 12, Release WASM 9 (independent sfnt oracle), font-editing regression 14, general-formatting availability 2, binder 7, surface 4, sessions 10; neighbor unit 913 PASS / 3 pre-existing FAIL; native run12 HWP/HWPX PASS (body residual 0.083 px, wrap 41→70 with predicted column, cell monospace/no overlap/Undo/Redo/reopen) and independent inspection PASS (`save_check` safe, Canvas vs PDF band delta 0.0031). Details: [font system 6.4절](architecture/font-system.md). |
| FAILED (historical) | Natural native run1–run9 harness failures; run10 independent inspection exposed a real stale-Canvas repaint defect (fixed by `layoutVersion`, re-verified run11/run12). |
| NOT SUPPORTED / NOT RUN | Ligatures, contextual/RTL shaping and kerning (per-cluster painter; documented). External office reopen NOT RUN (no suitable application installed). Native font removal/refresh flow and nested-cell native NOT RUN (engine/binder unit coverage only). Windows/macOS/other Linux DEFERRED. |
| DEFERRED | Windows/macOS, other Linux distributions, external Hancom/Word compatibility, Release private-path cleanup/package work. |
| NOT RUN | Full Rust/Vitest/WordCraft/RHWP suites, old native corpus, D4 benchmark. No old acceptance corpus was rerun. |

## 8. Stage 1 공통 문서 편집 (2026-11-16)

| 기능군 | DOCX | HWPX | HWP | 분류 | 근거 | 미검증 |
|---|---|---|---|---|---|---|
| 문단 정렬 | IV | IV(본문) | IV(본문) | CURRENT PASS | [Stage 1](architecture/stage1-common-editing.md) 3절 | native GUI NOT RUN |
| 글자 크기·색·형광펜·첨자 | IV | IV(선택) | IV(선택) | CURRENT PASS | 같음 | 외부 호환 EXT |
| 문단 간격·여백·들여쓰기 | IV | IV(본문) | IV(본문) | CURRENT PASS | 같음 | 셀 문단 RHWP IM |
| 번호·다단계 목록 | IV | IM | IM | CURRENT PASS(DOCX) | 같음 | RHWP 저장 증명 없음 |
| 찾기·바꾸기 | IV | IV | IV | CURRENT PASS | 같음 | 중첩 셀·글상자 RHWP 제외 |
| 쪽 설정(여백·방향·용지) | IV | IV | IV | CURRENT PASS | 같음 | — |
| 다단 | IV | IM | IM | CURRENT PASS(DOCX) | 같음 | — |
| 글꼴 embedding | IM | IM | IM | NOT RUN | 같음 4절 | 생성 경로·저장 규칙 없음 |

이 절은 이전 행과 판정을 바꾸지 않는다(행 4 "글자·문단 서식"의 역사 판정은 그대로).

### Stage 1 P1·F (2026-11-17)

| 항목 | DOCX | HWPX | HWP | 판정 | 근거 |
|---|---|---|---|---|---|
| 다음 입력 서식(>64자·IME·붙여넣기·이동·Undo) | — | IV | IV | CURRENT PASS | [Stage 1 5.4](architecture/stage1-common-editing.md) |
| 번호 스타일·정의 수명 | — | IV | IV | CURRENT PASS | 같음 |
| 글자+목록 결합 저장 | — | IV | IV | CURRENT PASS | 같음 |
| 글꼴 embedding | IV | IV | 형식 제한 | CURRENT PASS(native는 5.5) | 같음 |

### Stage 1 P0 — S1-FONT-TYPING (2026-11-21)

| 항목 | DOCX | HWPX | HWP | 기능·보존 판정 | 증거 |
|---|---|---|---|---|---|
| collapsed caret에서 다음 글자 크기 유지: 같은 위치 focus-return, IME/연속 입력, 선택 교체·의도적 이동, Undo/Redo 및 저장 | `IV` | `IV` | `IV` | CURRENT PASS — DOCX/HWP/HWPX 모두 actual Linux X11/IBus Native 입력을 확인했다. DOCX는 WordCraft IPC와 `w:sz=48`; HWP/HWPX는 Release WASM 구조에서 원래 19자 1000(10pt), 입력 6자 2400(24pt), SVG 32px glyph를 확인했다. RHWP 선택 교체·Undo/Redo와 빈 조합 취소 후 전체 페이지·기존 기록 복구를 확인했다. | [Stage 1 §11](architecture/stage1-common-editing.md#11-p0--s1-font-typing-collapsed-caret-서식-유지-2026-11-21--22), [DOCX X11/IBus](architecture/stage1-font-typing-acceptance.json), [HWP/HWPX X11/IBus 및 저장 검사](architecture/stage1-font-typing-rhwp-acceptance.json), [실행 원장](architecture/stage3-a-current-inventory.md#p0-stage-1-회귀) |

기존 DOCX 집중 검사(`stage1_docx_` 13/13, `DocxSurface.test.tsx` 13/13)와 DOCX run7 수락은 유지된다. RHWP `RhwpEditorSession.test.ts`: 22/22; 실제 Release WASM 집중 회귀: 5/5; `npm run typecheck`: PASS. Linux X11/Xvfb + trusted IBus Hangul DOCX run7, HWP run18, HWPX run18 모두 PASS. HWP/HWPX는 T009 실제 파일 저장, Release WASM의 CFB/ZIP 구조·문자 모양 및 SVG 검사, fresh Native session 재열기를 확인했다. 앱 SHA-256 `b7e366162de885bdf04f435e57d96985c9a829cace3a6eba813962527a6ef9da`; `privacyStatus`·`runtimePathStatus` PASS, portability NOT VERIFIED. Wayland·Windows/macOS 및 외부 Word/한컴 재열기 NOT RUN.

### Stage 2 / Phase 0 — HWPX 분할 run 글자 서식 (2026-11-17)

| 항목 | HWPX | 판정 | 근거 |
|---|---|---|---|
| 분할 run·secPr handoff·표 셀 부분/교차/반복 글자 서식·Undo/Redo + T009 저장/재열기 | IV | CURRENT PASS (Release WASM `80024e5c…`, `stage2-p0-hwpx-split-run.patch`) | [Stage 1 6절](architecture/stage1-common-editing.md#6-stage-2--phase-0--hwpx-분할-run-글자-서식-및-안전-저장-안정화-2026-11-17), `native-stage2-p0.py` run2 PASS |

### Stage 2 / Phase 2 — HWP/HWPX 고급 표 편집 (2026-11-17)

| 항목 | DOCX | HWP/HWPX | 판정 | 근거 |
|---|---|---|---|---|
| 비병합 셀 `행×열` 분할(가로·세로·직사각형, 본문·중첩, 서식·필드·캡션 표)·병합 복원 유지·Undo/Redo·T009 저장/재열기 | 불변 | IV | CURRENT PASS (Release `5f3c8067…`, `stage2-p2-cell-split.patch`, WASM 58/58, Rust 2+2+47) | [Stage 1/2 8.1절](architecture/stage1-common-editing.md#81-task-1--병합하지-않은-일반-셀-나누기-hwphwpx) |
| 복합 내용 표(셀 inline 그림·중첩 표·분할 run 서식·계산식/누름틀/캡션·연속 구조 변경) × 구조 명령 11 + 입력/문단 나누기, 감사 매트릭스 140칸 | 불변 | IV | CURRENT PASS (137 저장·재열기, 3 의도된 사전 `tableFormula` 거부; HWP 교정 A/B/C; native run1 PASS) | [Stage 1/2 8.2–8.3절](architecture/stage1-common-editing.md#82-task-2--복합-내용-표-구조-편집-감사와-교정) |

### Stage 2 / Phase 1 — DOCX 표 구조 편집 (2026-11-17)

| 항목 | DOCX | HWP/HWPX | 판정 | 근거 |
|---|---|---|---|---|
| 표 구조 10개 명령(행/열 삽입·삭제, 오른쪽/아래/선택 합치기, 합친 셀 나누기)·Undo/Redo·T009 저장/재열기 | IV | 불변(기존 HWP/HWPX) | CURRENT PASS (WordCraft `23c0dc5…`, Release `665ead58…`) | [Stage 1 7절](architecture/stage1-common-editing.md#7-stage-2--phase-1--docx-표-구조-편집-2026-11-17), `native-docx-table-stage2-p1.py` PASS |
| Stage 2 / Phase 1 최종 안정화(`1×1` 셀 분할 UI, 비빈 `vMerge` 보존, 표 이미지 삭제 T009 저장 + Content Types/비이미지 rel 보호, 소스 재구성) | IV | 불변(기존 HWP/HWPX) | CURRENT PASS (WordCraft `dd14a0ae…`, T009 집중 41 PASS; Release/native REUSED PASS) | [Stage 1 7.3절](architecture/stage1-common-editing.md#73-최종-안정화--11-셀-분할-ui-vmerge-내용-보존-표-이미지-삭제-t009-저장-소스-빌드-재현성-2026-11-17), [보존 규칙](architecture/save-preservation.md#stage-2--phase-1-최종-안정화--docx-표-이미지-삭제-t009-증명-및-content-types-보완-2026-11-17) |

### Stage 2 / Phase 3 — 형식 공통 표·셀 서식 (2026-11-18)

| 항목 | DOCX | HWPX | HWP | 판정 | 근거 |
|---|---|---|---|---|---|
| 셀 배경색(`table.shading`)·테두리(`table.borders`)·가로/세로 맞춤(`table.alignment`)·열 너비(`table.columnWidth`)·행 높이(`table.rowHeight`), Undo/Redo, T009 안전 저장 및 독립 재열기 | IV(`pt`, `atLeast`/`exact`/`auto`) | IV(`mm`, `atLeast`만) | IV(`mm`, `atLeast`만) | CURRENT PASS (HWP 테두리 재열기 및 디스크 `BORDER_FILL` 오라클 `stage2-p3-native-acceptance.py --formats hwp`) / REUSED PASS (P3-1·P3-2·P3-3 단위/WASM 73/73·Rust 11/11 및 DOCX/HWPX/HWP 통합 native `target/p3-native-out/acceptance.json`) | [Stage 1/2 9절](architecture/stage1-common-editing.md#9-stage-2--phase-3--형식-공통-표셀-서식-2026-11-18), [T009 경계](architecture/save-preservation.md#stage-2--phase-3--표셀-서식-t009-저장-보존-경계-2026-11-18) (외부 Word/한컴 재열기 및 Windows/macOS: NOT RUN) |

### Stage 2 / Phase 4 — 고급 표 기능 (2026-11-18)

| 항목 | DOCX | HWPX | HWP | 판정 | 근거 |
|---|---|---|---|---|---|
| 다중 셀 구조 클립보드(Copy/Cut/Paste, 서식·병합 보존, 거부 안전·단일 Undo/Redo) | IV(`application/x-geul-table-cells+json` + fallback) | IV(`application/x-geul-table-cells+json` + fallback) | IV(호환 병합 범위·무손실 검증 범위) | CURRENT PASS (P4 안정화 뒤: `clipboard.test.ts` 41·`clipboardSessions.test.ts` 10·WASM 87/87(대상 서식 비상속·글꼴 명시 적용/거부·엔진 실패 원자성)·Rust·`stage2-p4-native-acceptance.py`) | [Stage 1/2 10절](architecture/stage1-common-editing.md#10-stage-2--phase-4--고급-표-기능-2026-11-18), [명령 레지스트리](architecture/command-registry.md#stage-2--phase-4--고급-표-기능-2026-11-18) (크로스 앱 구조 MIME·외부 오피스: NOT RUN) |
| 셀 여백(`table.cellMargins`)·표 위치(`table.positioning`)·반복 머리행(`table.repeatHeader`)·페이지 나눔(`table.rowBreak`), T009 저장 및 독립 재열기 | IV(`cell`/`row`, `treatAsCharSupported:false`) | IV(`cell`/`row`/`none`, `treatAsChar`·바깥 여백) | IV(`cell`/`row`/`none`, `treatAsChar`·바깥 여백, `0x0400` 유지) | CURRENT PASS (P4 안정화 뒤: Vitest 7파일 123/123·WASM 87/87·`stage2_p4_` 7/7·Release `82eae910…`/WASM `b5f0b768…` Linux native `stage2-p4-native-acceptance.py`·`stage2-p4-native-multipage.py`(실제 2쪽 머리행 반복 적중) DOCX/HWPX/HWP PASS; 머리행 끄기는 선택 행만·아래 머리행 있으면 거부); 새 HWP 표 셀 안 Enter 저장(후속 보수, Native `hwp-new-table-enter-native.py` Release `e9df51c8…` PASS) | [Stage 1/2 10절](architecture/stage1-common-editing.md#10-stage-2--phase-4--고급-표-기능-2026-11-18), [T009 경계](architecture/save-preservation.md#stage-2--phase-4--고급-표-기능-t009-저장-보존-경계-2026-11-18) (외부 Word/한컴 재열기 및 Windows/macOS: NOT RUN) |

## 공통 개체 편집 Stage 3 (2026-11-18)

| 기능 | DOCX | HWPX | HWP | 근거 |
|---|---|---|---|---|
| 그림 선택, 전환, 해제 | READ_ONLY_PRESERVED | READ_ONLY_PRESERVED | READ_ONLY_PRESERVED | Linux X11 Release에서 클릭·키 입력 거부·텍스트 복귀·닫기·재열기, 디스크 바이트 일치 |
| 그림 치수·배치·설명 조회 | READ_ONLY_PRESERVED | READ_ONLY_PRESERVED | READ_ONLY_PRESERVED | DOCX 그림 모델, RHWP가 소유한 본문 그림 속성 |
| 그림 크기 조정 | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | HWP 단순 본문 인라인 그림 40.5×20.25→54×27pt, 네이티브 속성 입력·저장·앱 재시작 후 재열기 |
| 그림 이동 | SUPPORTED_AND_VERIFIED | PARTIAL | SUPPORTED_AND_VERIFIED (범위 제한) | HWP 떠 있는 본문 그림의 Linux X11 끌기, 안전 저장 및 독립 재열기 PASS |
| GSO 삭제 | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | 초기 B1은 HWP 최상위 비잠금·비캡션 그림과 기본 도형 삭제를 검증했다. 공유 BinData/DocInfo 보존, Undo/Redo, Release WASM `stage3-object-edit` + `gso-deleted.hwp` T009 + `services::save` 288 PASS 및 P6 Linux X11 그림 Delete·Undo·재삭제·안전 저장 PASS. 현재 B2.1은 SAFE Section0의 소유된 비잠금 캡션 포함 그림·기본 도형도 지원한다. 캡션 포함 글상자와 소유권을 입증할 수 없는 삭제는 거부한다. 그룹은 B2.2 경계를 적용한다. |
| 선택 핸들·드래그 (P1) | SUPPORTED_AND_VERIFIED | PARTIAL | PARTIAL | DOCX 도형 이동·크기 핸들, HWP 포인터 선택·떠 있는 그림 끌기·속성 창 크기 조정·도형 키보드 이동 Linux X11 PASS. P1 당시 HWP 그림 크기 핸들 끌기는 NOT RUN. 이후 [C01](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 지원 인라인 그림의 여덟 방향이 PASS. [후속 수용](architecture/stage3-c-resize-followup-2026-11-20.json)에서 이동 가능 RHWP 도형·그룹은 동·남동·남쪽만 표시하고, 부유 그림은 이동만 제공함을 확인했다. |
| 사각형·타원·선 삽입 (P1) | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED (범위 제한) | HWP: 최상위 본문 Section0의 접힌 커서에서 기본 사각형·타원·직선 삽입. SAFE 사전 검사, 소유·기본 레코드 T009 증명, Undo/Redo 및 독립 재열기; 기본 실선 굵기의 후속 변경을 같은 저장에 허용하며, 그 외에는 별도 보존 증명이 필요 |
| 글상자 삽입 (P1) | SUPPORTED_AND_VERIFIED | PARTIAL (삽입·외곽만) | SUPPORTED_AND_VERIFIED (빈 글상자, 범위 제한) | HWP: 최상위 본문 Section0의 접힌 커서에서 소유된 빈 문단을 가진 기본 글상자 삽입; SAFE 사전 검사, T009, Undo/Redo 및 독립 재열기 |
| 글상자 내부 텍스트 편집 (P2) | SUPPORTED_AND_VERIFIED | PARTIAL (최상위 평문 편집 및 Stage 3-A P5 혼합 서식 문단 편집) | PARTIAL (SAFE 원본 Section0의 최상위 평문 문단) | HWPX는 비잠금 글상자의 커서·선택·한글 조합·문단 정렬·Undo/Redo·독립 재열기를 검증했다. HWP는 텍스트·문단 정렬과 삽입 후 같은 저장 및 기존 글상자 편집의 T009 증명을 확인했다. HWP/HWPX 모두 기존 평문 글상자의 각 문단을 편집할 수 있다(1–64개). Stage 3-A P5는 지원 HWPX 글상자의 혼합 서식 문단을 Enter로 분할한다. 지원 HWPX의 인접 문단 병합·교차 범위 삭제도 검증했다. HWP5의 구조 문단 편집, 다른 소유자·서식의 문단을 가로지르는 변경, 제어 개체를 포함한 글상자, HWP 내부 편집과 외곽 편집을 같은 저장에 적용하는 흐름은 범위 밖이다. DOCX story·IBus·재열기 근거를 재사용했다. [C05](architecture/stage3-c-native-acceptance-2026-11-20.json)는 HWPX 기존 글상자 둘째 문단의 실제 IBus·Undo/Redo·저장 재열기 PASS. |
| 차트 조회 | READ_ONLY_PRESERVED | READ_ONLY_PRESERVED | READ_ONLY_PRESERVED | Linux X11 Release 조회·독립 재열기, 입력 바이트 보존 |
| SmartArt 조회 | READ_ONLY_PRESERVED | UNSUPPORTED | UNSUPPORTED | DOCX의 모델을 읽을 수 있는 경우, 레이아웃·항목 |
| 차트 편집 (P4) | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | DOCX: WordCraft 모델이 있는 차트의 제목·종류·항목·계열 값(`chart.title`/`chart.type`/`chart.editData`), T009 재생성 부분 증명. HWPX(B6): `hwp-source-preservation.patch` 내부 OLE(`BinData/*.ole`, `isEmbeded="0"`) manifest·ZIP 보존 + `RhwpEditorSession` `chartData` 편집·Undo/Redo + `hwpx_charts` T009(`Chart/chartN.xml`·중첩 CFB `OOXMLChartContents` 의미 일치·`<hp:switch>`/`content.hpf` 고정) PASS. HWP(B7): `hwp/ole.rs`가 DocInfo 선언과 모든 지원 본문 구역의 OLE·그림·이미지 채우기 참조를 대조해 원본과 출력 모두에서 단독 소유가 확인된 최상위 비잠금 차트만 허용한다. 잠금·지원되지 않는 개체와 공유되거나 참조 소유권이 불명확한 BinData 변경은 거부한다. 기존 중첩 CFB·차트 내용 T009 증명과 `hwpReopenModel`·`RhwpEditorSession`의 HWP `chartData` 편집·Undo/Redo 검증을 유지한다. [C12](architecture/stage3-c-native-acceptance-2026-11-20.json) Linux X11 PASS는 알려진 빈 미리보기 HWP/HWPX fixture의 범주·계열명·값 편집에 한정한다. |
| 그림·도형 캡션 내부 (P5) | 기존 범위 | SUPPORTED_AND_VERIFIED (소유·경계 검증 범위) | SUPPORTED_AND_VERIFIED (소유·경계 검증 범위) | HWPX 및 SAFE Section0 비잠금 그림(`cell=0`)·기본 도형(`사각형`·`타원`·`직선`·`다각형`·`곡선`, `cell=65534`)의 1–64문단 캡션 텍스트·정렬·문단 분할(`Enter`)·병합·다문단 선택 교체 및 Undo/Redo. 선택 교체의 최종 문단 수는 원래 수에서 승인된 삭제 경계 수를 빼고 새 개행 수를 더해 mutation 전에 계산한다. 자동 번호(`atno`) 슬롯 경계 보호(백스페이스·Delete·겹치는 선택 삭제/덮어쓰기·IME 거부, 분할 시 슬롯 보존). Release WASM/T009/독립 재열기 경계는 아래 P5 기록 참조. Linux X11 Native에서 HWP/HWPX shape caption 포인터·키보드 편집, 분할·병합·교차 문단 선택 교체·Undo/Redo·정렬·저장/닫기/재열기 PASS. [캡션 Native 수용 기록](architecture/stage3-caption-native-acceptance-2026-11-20.json)의 HWPX 및 HWP IBus composition/저장·재열기와 잠긴 사각형 캡션 진입 거부 사례도 각각 PASS다. HWP 추가 사례는 기록된 Linux X11/Xvfb, IBus 1.5.33 + Hangul 1.5.5, 사각형 fixture 및 app SHA `9feec38c…` 세대에 한정된다. Wayland·Windows·macOS와 기타 입력기/개체 문맥은 NOT RUN |
| SmartArt 편집 (P4) | SUPPORTED_AND_VERIFIED | UNSUPPORTED | UNSUPPORTED | DOCX: 항목·단계·레이아웃(`smartArt.items`/`smartArt.layout`). HWP5/OWPML 정의와 RHWP 모델에서 편집 가능한 SmartArt 대응을 확인하지 못해 비활성 상태 |
| 외부 프로그램 차트·다이어그램 | READ_ONLY_PRESERVED | READ_ONLY_PRESERVED | READ_ONLY_PRESERVED | WordCraft 모델이 없으면 원본 markup·부분 그대로, 편집 연산 없음 |
| 구조 도형 클립보드 | SUPPORTED_AND_VERIFIED (기본 인라인 도형 및 v2 지원 도형) | SUPPORTED_AND_VERIFIED (동일 문서 구조 복제 및 B3.2 지원 도형의 교차 문서 붙여넣기) | SUPPORTED_AND_VERIFIED (B3.1 동일 문서 기본 도형) | HWPX 폐합 다각형의 교차 문서 전송과 HWPX → DOCX 자유형 변환은 아래 Stage 3-A P6의 지원 범위를 따른다. 다른 교차 형식과 교차 문서 HWP5는 거부한다. [B3.2 후속 검증](architecture/stage3-b-clipboard-fidelity-followup-2026-11-20.json) |
| 그림·도형·글상자·그룹 구조 클립보드 (P4/P5/B3) | SUPPORTED_AND_VERIFIED (앱 내 본문 및 본문 소속 글상자 안 지원 도형·글상자·평탄 그룹, glued 연결선·도형 ID 재매핑. 글상자 안 그림·중첩 그룹·차트/OLE 자식 거부) | PARTIAL (동일 문서 그림·도형·글상자·그룹 구조 복제. 교차 문서 그림·사각형·타원·기본 직선·글상자는 B3.2 보존 조건 충족 시 지원) | PARTIAL (B3.1의 SAFE Section0 비잠금 그림·기본 도형·평문 글상자·평면 그룹을 동일 문서에서 지원) | Stage 3-A P6는 검증된 HWPX 폐합 다각형의 교차 문서 전송과 HWPX → DOCX 자유형 변환을 지원한다. 교차 문서 그룹·곡선·미지원 윤곽선/채우기·중첩 제어와 나머지 교차 형식은 거부한다. [B3.2 후속 검증](architecture/stage3-b-clipboard-fidelity-followup-2026-11-20.json) |
| 차트·SmartArt 구조 클립보드 | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | 붙여넣기가 새 차트/다이어그램 부분을 더하는데 그 T009 증명이 없어 거부 |
| 시스템 클립보드 구조 MIME | Linux X11 (geul MIME) | Linux X11 (geul MIME, v3) | Linux X11 (geul MIME, 동일 문서 v3) | 별도 GTK 프로세스와 두 geul MIME 양방향 전송 및 평문 대체 읽기 PASS. HWPX/HWP는 `application/x-geul-object+json` v3에서 각각 B3.2/B3.1 소유권·서식 경계를 적용한다. 미확인 외부 오피스 형식은 NOT RUN이다. 잘못된 구조 MIME이나 소유된 복구 데이터 없는 예약 객체 표식은 평문으로 삽입하지 않는다. 유사 일반 문장은 허용하고 표 구조 `notTable` 폴백은 별도 승인 경로를 유지한다. |
| 그림 자르기·초기화 (P2) | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED (범위 제한) | HWP Release WASM·T009 및 Linux X11 속성 창 자르기·초기화 PASS |
| 그림 텍스트 배치 (P2) | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED (범위 제한) | HWP 인라인→위/아래 배치 Release WASM·T009 및 Linux X11 속성 창 이벤트·안전 저장 PASS |
| 그림 대체 텍스트(설명) (P2) | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | HWP 실제 속성 창에서 입력한 설명이 게시본에 남고 재열기 UI에서 일치 |
| 위치 프리셋 (P2/P3) | SUPPORTED_AND_VERIFIED | PARTIAL | PARTIAL | 여백 기준 9곳. RHWP는 비잠금 본문의 회전·반전·캡션·외부 링크 없는 어울림 그림으로 한정. 실제 렌더 좌표·T009·독립 재열기 PASS. 당시 네이티브 속성 창 NOT RUN. 이후 [C07](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 두 형식의 아홉 프리셋 Linux X11 PASS. |
| 기본 도형 서식 (P3) | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED (검증 범위) | PARTIAL | HWPX z-order는 B4 검증 범위에서 지원된다. HWP는 같은 배치 방식의 기존 비잠금 기본 도형을 한 번의 저장에서 한 개까지 맨 앞·뒤로 보낼 수 있다. HWP/HWPX에서 캡션·글상자 하위 구조가 없는 비잠금 기본 도형의 실선 굵기 0.01–72pt를 지원한다. HWP는 기본 도형 삽입 뒤 첫 저장 전에 굵기를 바꾸는 흐름도 지원한다. HWP 사각형 회전·좌우/상하 반전, 단색/없음 채우기와 선 색은 Linux X11에서 확인했다. 도형 배치는 WASM/T009 검증 범위다. |
| 기본 도형 이동·크기 (P3) | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | PARTIAL | HWP 사각형 키보드 이동은 검증됐다. 정규 사각형·타원·선의 크기 변경은 엔진·T009 검증을 통과했다. B2의 비정규 사각형 크기 변경은 원본 기하를 기준으로 변경 축 좌표를 비례 변환하고 미변경 축을 보존한다. 지원 범위에서 직렬화·T009 검증을 통과했으며 퇴화 또는 범위 초과 결과는 거부한다. |
| 다각형·곡선·자유형 (P3) | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED (외곽 기하·서식) | DOCX `ShapeKind::Freeform`은 크기 조정 시 `snap_to_emu`가 경로 좌표를 함께 비례·EMU 스냅하고 회전 시 `spin_pad` 여백을 스냅해 이동·크기·회전/반전·채우기·선·배치·삭제·T009 저장·독립 재열기를 지원한다(`stage3_docx_freeform_geometry_edit_preserves_paths_and_roundtrips` PASS). HWPX·HWP 본문 비잠금 다각형(`$pol`, `"다각형"`)·곡선(`$cur`, `"곡선"`)은 꼭짓점·곡선 세그먼트 레코드(`TAG_POLYGON`/`TAG_CURVE`)를 바이트 동일 보존한 채 외곽 크기·이동·회전/반전·배치·채우기·선 색/굵기·z-order·삭제를 지원한다(`stage3-shapes` 3 PASS, `hwp_polygon_and_curve_evolution_preserves_vertices_and_segments` PASS, `release_hwp_polygon_and_curve_geometry_preserves_vertices` PASS, `save_check` HWPX safe PASS). |
| 그룹 개체 기하·변형 (P3) | SUPPORTED_AND_VERIFIED | SUPPORTED_AND_VERIFIED | PARTIAL (외곽 이동·크기·배치, B2.2 평면 그룹 삭제) | DOCX 최상위 `InlineObject::Group`은 `move`·`resize`·`wrap`·`altText`·`delete`에 더해 `rotate`·`zOrder`와 `ShapeView` 프로젝션을 지원한다(`stage3_docx_group_geometry_rotate_layer_roundtrips` PASS). HWPX `Group`(`<hp:container>`, `"그리기"`)은 `move`·`resize`·`wrap`·`delete`를, HWP5 `SC_CONTAINER`(`$con`)는 자식 레코드와 아핀 렌더링 행렬 일치를 검증(`hwp_group_container_evolution_preserves_children`·`release_hwp_group_geometry_preserves_children` PASS)하는 `move`·`resize`·`wrap`을 지원하며(`stage3-shapes` 2 PASS, `save_check` HWPX safe PASS), 현재 HWP5 삭제는 B2.2의 SAFE Section0 비잠금 평면 그룹 중 자식·리소스 소유와 보존이 증명되는 경우에 한정한다. 중첩·잠금·캡션·OLE/차트 포함 그룹의 삭제와 HWP5 그룹 회전·윤곽·채우기는 거부한다. [C09](architecture/stage3-c-native-acceptance-2026-11-20.json) Linux X11 외곽 작업 PASS. [별도 후속 검사](architecture/stage3-c-resize-followup-2026-11-20.json)에서 HWP/HWPX의 이동 오프셋과 저장 재열기 위치를 비교했다. |
| 캡션 있는 GSO 편집 | — | — | PARTIAL | B5: 캡션 있는 최상위 비잠금 그림/기본 도형의 안전한 바깥 개체 편집(이동·크기·배치·채우기·선 색·회전·자르기·설명) 허용(캡션 `LIST_HEADER`/`PARA_TEXT`/이진 트리는 바이트 동일 유지). 당시 B5에서는 캡션 플래그 전환과 캡션 개체 삭제를 거부했다. 이후 B2.1에서 SAFE Section0의 소유된 비잠금 캡션 포함 그림·기본 도형의 삭제를 수용했다. 캡션 내부 편집은 위 P5의 별도 증명에 따른다 |
| 보호된 GSO 편집 | — | — | BLOCKED | 잠금 객체 변경, 크기 보호 객체 크기 변경 거부 |
| 미지·중첩 GSO 구조 변경 | — | — | BLOCKED | 최상위 기본 도형·그림으로 한정. 글상자 평문 레코드, 원본 리소스와 미지 확장 바이트 보존 |
| 중첩 개체 (P2) | PARTIAL | PARTIAL | PARTIAL | DOCX는 중첩 표 셀(깊이 2+ 포함)의 그림·도형·글상자 제자리 편집(`resize`·`crop`·`altText`·`fill`·`outline`·`delete`)과 본문 소속 글상자(`PartKind::TextBox`) 안 도형 제자리 편집을 지원한다(고정 WordCraft `read/story.rs:948`이 `wps:txbx` 안 `a:blip`을 바깥 `Image`로 삼켜 글상자 안 그림·그림 포함 그룹과 별도 OPC 이야기 개체는 이 P2 경로에서 제외; `stage3_docx_nested_cell_and_textbox_objects_admit_only_in_place_edits` PASS). HWPX는 본문 표(1단계 및 깊이 2+ 중첩 표, 최대 64단계) 안 비잠금 인라인 그림의 크기 조정·자르기·설명·삭제와 `hwpReopenModel` 검증을 지원한다(`stage3-shapes` 5 PASS + `save_check saved hwpx` PASS). HWP도 SAFE 원본 Section0의 본문 표(1단계 및 깊이 2+ 중첩 표)에서 모든 감싸는 표·그림이 비잠금이고 바깥 표가 어울림이며 그림이 비회전·비반전·고정 비율일 때 인라인 그림 크기를 변경할 수 있다(`release_hwp_nested_cell_picture_resize_preserves_tables_and_resource`·`release_hwp_cell_picture_resize_preserves_table_and_resource` PASS). Stage 3-A P5는 DOCX 머리말·꼬리말·각주·미주의 소유된 인라인 내장 그림 대체 설명을 지원한다. 다른 DOCX 이야기 개체 연산과 RHWP의 표 셀 도형·글상자 안 그림·별도 이야기 개체 편집은 전용 소유권과 저장 증명이 필요하다. [C03](architecture/stage3-c-native-acceptance-2026-11-20.json)는 DOCX 깊이 2 셀 그림·도형·글상자 및 본문 글상자 소속 도형 편집 PASS. [C04](architecture/stage3-c-native-acceptance-2026-11-20.json)는 HWP 중첩 인라인 그림 크기, HWPX 크기·자르기·설명·가역 삭제의 Linux X11 PASS. |

현재 P1 관련 Vitest 85 PASS, WordCraft 개체 선택 집중 시험 1 PASS,
T009 저장 278 PASS / 0 FAIL / 29 ignored. P2 집중 Vitest 59 PASS,
Release WASM 2 PASS, 그림 속성 WordCraft 집중 1 PASS. HWPX 크기 조정은
Linux X11 Release에서 Undo/Redo·게시·독립 재열기를 확인했다. P3 DOCX
저장 서비스 시험 및 Linux X11 Release의 도형 삽입·글상자 IME·독립
저장 검사도 통과했다.
[개체 선택 계약](architecture/command-registry.md#공통-개체-편집-stage-3-p1).


최종 Release 통합 결과는 P1–P5의 위 지원 범위에서 PASS다. Vitest
184 PASS, Stage 3 Rust 4 PASS, 표 구조 클립보드 WASM 3 PASS(87 필터
제외), T009 279 PASS / 0 FAIL / 29 ignored다. Microsoft Word·한컴오피스,
크로스 앱 객체 MIME, Windows/macOS 및 Wayland는 NOT RUN이다.

**2026-11-19 P1 완료 실행.** Rust: `stage3_object_edit_moves_resizes_deletes_with_t009_and_history`,
`stage3_docx_existing_objects_move_resize_delete_publish_and_reopen`(실제 저장 서비스 두 번 게시),
`docx_body_picture_deletion_proof_admits_only_drawing_owned_media`(양성 1·음성 4) PASS, `services::save`
281 PASS / 0 FAIL / 29 ignored, `adapters` 110 PASS. Release WASM `stage3-object-edit` 2 PASS(HWPX 이동·
이동량·삭제·Undo/Redo·재열기, HWP 무변경 거부), 그 출력의 `save_check saved hwpx` safe, BinData 변조·
header 변조·BinData 누락 음성 3건 unsafe. Vitest 전체 1634 PASS / 3 FAIL(`hangulTools` 1·`hwpReopenModel` 2,
시작 HEAD에서도 재현). 네이티브 X11/IBus 끌기는 이 단계에서 NOT RUN.

**2026-11-19 P2 그림 편집 실행.** Rust `stage3_docx_picture_crop_wrap_alt_text_position_roundtrip`(크롭·설명·배치·위치·
초기화·인라인 복귀·Undo, 편집마다 T009 `check_saved` safe, 재열기 값과 원본 미디어 바이트 일치) PASS, Stage 3+adapters
113 PASS. Release WASM `stage3-object-edit` 3 PASS + `stage3-picture-size` 2 PASS, HWPX 서식 출력 `save_check` safe,
BinData 1비트 변조 unsafe. Vitest 1640 중 1637 PASS(같은 기존 실패 3). 속성 창 UI 시험 3 PASS. 네이티브 NOT RUN.

**2026-11-19 P3 도형 실행.** Rust `stage3_docx_shape_fill_outline_rotation_layer_roundtrip`, `stage3_docx_picture_in_table_cell_admits_only_in_place_edits`
PASS(Stage 3 Rust 9, adapters 115). Release WASM `stage3-shapes` 2 PASS(HWPX 사각형·글상자 삽입, 채우기·선 색·회전·이동·크기·
뒤로·삭제·Undo, 재열기 값 확인, HWP 삽입 거부), 출력 `save_check saved hwpx` safe. Vitest 1645 중 기존 실패 3 외 PASS. 네이티브 NOT RUN.

**2026-11-19 P4 차트·SmartArt 실행.** Rust `stage3_docx_chart_and_smart_art_model_edits_save_and_reopen`(제목·종류·데이터·항목·
레이아웃, 편집마다 `check_saved` safe, 독립 재열기 모델 값, 바뀐 부분이 본문·통계·chart1·data1·drawing1·layout1뿐, Undo 다섯 번 뒤
원본 바이트), `docx_regenerated_graphic_part_proof_admits_only_bound_chart_and_diagram_parts`(양성 1·음성 7) PASS; Stage 3 + adapters +
services::save 396 PASS / 31 ignored. 기존 P4 조회 시험은 새 계약(패키지 부분은 받되 동기화 없는 원시 엔진 편집은 `ReopenMismatch`)으로
갱신. RHWP 차트 탐침: HWP `setChartData` 출력 `partChanged BinData/BIN0001.OLE`, HWPX 편집 없는 내보내기 실패. Vitest 1647 중 기존 실패 3 외 PASS.

**2026-11-19 P5 구조 클립보드 실행.** Rust `stage3_rich_object_clipboard_copies_and_pastes_pictures_shapes_and_text_boxes`(자르기·설명 있는 그림,
채우기 바꾼 타원, 한글 글상자를 다른 DOCX에 붙여넣기 → T009 safe·독립 재열기 값·미디어 바이트 동일, 세 번 Undo 뒤 붙인 미디어 제거·저장 safe,
Redo, 같은 문서 붙여넣기 미디어 공유, 낡은 선택 복사 거부, 해시 불일치·미디어 누락/추가·GIF·블록 둘·NaN 크기·글상자 story 누락 7건 무변경
거부) PASS. 전체 `cargo test --lib` 532 PASS / 0 FAIL / 40 ignored, clippy 새 경고 없음(기존 10). Vitest 객체 클립보드 5 PASS
(v2 봉투 검증, 표지 텍스트가 바뀐 뒤 낡은 페이로드 비사용).

**2026-11-19 Stage 3 완료 실행 — 결합 네이티브 수용(Linux X11/IBus, Release).** `VITE_GEUL_TEST_HOOKS=1 npm run tauri -- build --no-bundle`
앱 SHA-256 `a625a851909c6400f5f940dc6c99e301f7d0a3ad980e157b73c176af8e1e0699`, 시나리오 `target/stage3-completion/run11/accept.py`(무시되는 target).
- DOCX PASS: 리본 사각형 삽입 → 클릭 선택(8 핸들) → 포인터 끌기 이동(Δ+90,−176px, 한 판) → SE 핸들 끌기 크기(144×96→194×126px) →
  Shift+→ 이동 → Ctrl+C 구조 복사 → 문서 끝 Ctrl+V(같은 오프셋에 겹친 떠 있는 사본) → 사본 선택·Shift+→ 16번 분리 → Delete → Ctrl+Z/Ctrl+Y/Ctrl+Z →
  실제 저장(T009) → 탭 닫기 → GTK 열기 대화 상자로 독립 재열기: `word/document.xml`에 떠 있는 `rect` 2개, 크기 1847850×1200150 EMU, 본문 글 "Host".
- HWPX PASS: 리본 사각형·글상자 삽입 → Ctrl+Z/Ctrl+Y → 실제 저장 → 독립 재열기: `hp:rect` 2, `hp:drawText` 1.
- 첫 네이티브 실행이 찾은 결함(수정): HWPX 새 떠 있는 도형 저장이 `reopenMismatch`로 거부(RHWP `createShapeControl`이 배치 비트를
  동기화하지 않음 → 생성 직후 `setShapeProperties({textWrap:"Square"})`로 동기화). HWPX 앞/뒤 순서 변경도 재열기 컨트롤이 달라 제공하지 않는다.
  Release WASM 시험은 이제 제품 저장 경로와 같은 재열기 증거(쪽 수·글·컨트롤 JSON·손실 0)를 단언한다.
- NOT RUN: 이번 Release로 한글 IBus 입력·글상자 IME 재실행, HWP 시나리오, 그림 자르기/설명 UI 조작, 차트·SmartArt UI 조작, Word/한컴 상호 운용,
  다른 앱과의 구조 클립보드, Windows/macOS/Wayland.

**2026-11-19 Stage 3 안정화 실행.** Task 1–5 순차 구현 및 검증:
- Task 1 (`efb42aa`): DOCX 차트/SmartArt T009 재생성 부분 증명을 `word/charts/chartN.xml` 및 `word/diagrams/{data,layout,drawing}N.xml` 스키마·관계 바인딩 검증으로 축소(`colorsN.xml`·`quickStyleN.xml` 면제 제외).
- Task 2 (`e7614e5`): `documentCommandState("object.edit")`가 `MUTATING_OBJECT_OPERATIONS`(`chart`·`smartArt` 포함)로 가용성을 판정하도록 교정(`deselect`/`copy`/`cut` 제외, `DocxEditorSession` integration PASS).
- Task 3 (`537ec76`): `ObjectSelectionFrame` 모서리 비율 유지 크기 조정이 최소/최대 한계에서 공통 비율 `[sMin, sMax]`를 보존하고 모순 제약 시 시작 크기를 유지하도록 교정(`ObjectSelectionFrame.test.tsx` 13/13 PASS).
- Task 4 (`d44e484`): DOCX 그룹 리치 클립보드 v2 라운드트립 수정(중첩 그룹 거부·복수 `text_boxes()` story 검증·총 디코딩 미디어 용량 제한) 및 `stage3_grouped_rich_clipboard_roundtrip_and_negative_acceptance` + RHWP v2 거부/페이로드 시험 PASS.
- Task 5 **COMPLETED**. 크기·행렬·캡션 T009 경계, Rust 저장 286 PASS/0 FAIL/30 ignored, 실제 Release WASM HWP T009 별도 1 PASS, Release WASM 9/9 PASS. Linux X11/GTK/IBus Release `13729f450735…`에서 포인터 선택, 그림 크기·설명, 사각형 이동·회전·좌우 반전, 삭제 거부, Undo/Redo, 실제 게시 및 새 앱 프로세스에서 디스크 재열기 PASS. 범위와 증거는 [HWP GSO 저장 보존](architecture/save-preservation.md#stage-3-안정화-hwp-gso-필드-단위-진화-증명-2026-11-19) 참조.
- Stage 3 전체 **PARTIALLY COMPLETED**. 당시 수용에서는 HWP GSO 삭제, 도형·글상자 삽입, 복합 객체 편집, 교차 형식 구조 클립보드는 범위 밖이었다. 이후 수용 범위는 아래 Stage 3-B 기록을 따른다. 한컴 및 다른 플랫폼 상호운용 NOT RUN.

**B2 적용 전 HWP 사각형 꼭짓점 후속.** 테두리 색만 바꿀 때 기존 꼭짓점이 덮어써져 이전 T009를 통과하는 반례를 재현했다. HWP setter와 T009를 수정해 비정규 사각형의 서식·이동·회전/반전 시 꼭짓점을 보존하고 크기 변경 게시를 거부한다. 정규 사각형 너비·높이·동시 변경은 Release WASM/전체 T009 통과. `services::save` 287 PASS, Release WASM Stage 3 9 PASS. Linux Release는 비정규 사각형 이동·회전/반전과 꼭짓점 보존 저장·독립 재열기, 크기 변경 저장 거부와 게시본 불변을 확인했다. Task 5 수용 유지. [재현 및 저장 규칙](architecture/save-preservation.md#hwp-사각형-꼭짓점-보존-후속-2026-11-19)

**B1 HWP GSO 삭제 해결 (2026-11-19).** `hwp-source-preservation.patch`에 인라인 컨트롤 슬롯 삭제 시 `char_shapes`·`range_tags`·`markpen_marks`·`line_segs.text_start`·`field_ranges.inner_slot_count` 동기화(`Paragraph::delete_inline_control_slot`)와 남은 컨트롤/빈 문단 삭제 후 `stored_text_partition_dirty` 해제(`common.rs`)를 추가하고, `gso::deletable_gso` 및 `insertions` 토큰 정렬 증명으로 비잠금·비캡션·비그룹·불투명 레코드 없는 최상위 HWP 그림/기본 도형 삭제만 좁게 허용했다(잠금·캡션·그룹·`CTRL_DATA`·중첩 글상자 거부는 유지). Release WASM `38519a7e…`에서 `stage3-{object-edit,picture-size,shapes}` 9/9 PASS, `pictureProperties.test.ts` 13/13 PASS, 실제 WASM 생성 `gso-deleted.hwp` T009 `release_hwp_gso_bytes_pass_only_for_proven_edits` PASS, `services::save` 288 PASS / 0 FAIL / 32 ignored, `typecheck`·`eslint` PASS.

**B2 비정규 HWP 사각형 크기 조정 해결 (2026-11-19).** `hwp-source-preservation.patch`에 `RectangleShape::source_hwp_geometry`와 `scale_rectangle_axis`/`plan_rectangle_vertex_sync`를 추가해 비정규 HWP 사각형 크기 조정 시 변경 축 꼭짓점을 원본 기하 기준으로 정수 반올림(`i128` half-away-from-zero) 비례 변환하고 미변경 축·무크기 편집 좌표는 그대로 보존하며, 퇴화(`min >= max`) 또는 범위 초과(`>2_000_000` 또는 `|coord| > 10_000_000`) 변환을 변이 전 거부한다. `gso::prove_evolved_gso`는 `TAG_RECTANGLE` 크기 변경 시 `scale_rectangle_axis` 정합성과 `round_rate`/미변경 축 불변을 검증하고 임의 정규화·1 HWPUNIT 오차·퇴화/범위 초과 좌표를 거부한다. Release WASM `17aac3ba…`에서 `hwp-rectangle-geometry.mjs`(정규·비정규 8쌍 + 다단계 리사이즈 + Undo/Redo + 범위 초과 거부) PASS, `release_hwp_rectangle_geometry`·`release_hwp_gso_bytes_pass_only_for_proven_edits` PASS, `stage3-{object-edit,picture-size,shapes}` 9/9 PASS, `services::save` 288 PASS / 0 FAIL / 32 ignored.

**B3 회전 HWP 그림 크기 조정 해결 (2026-11-19).** `hwp-source-preservation.patch`에 `Picture::source_hwp_size`와 `plan_rotated_picture_resize`를 추가해 회전 HWP 그림(`rotation_angle % 360 != 0`) 크기 변경 시 `original_width/height > 0`, `current_width/height > 0`, `group_level == 0`, 유한·정합 원본 `raw_rendering`(평행이동·양의 대각 스케일·각도 일치 회전)을 변이 전 검증하고 다단계 연속 반올림 오차 없이 `current_width/height`를 비례 갱신하며 `rotation_center`·`flip`·`rotation_angle`을 보존한 채 `[T(offset), S(cur/orig), R(theta, pos_correction)]` 146바이트 행렬을 재생성하도록 했다. `gso::prove_evolved_gso`와 `validate_rendering_info`는 회전 그림의 비례 `current_*`와 재생성 3행렬을 검증하고 비유한·전단·각도 불일치·무단 행렬 변조를 거부하며, `pictureProperties.ts`의 `simpleInline`은 유효 `original`·정수 `rotationAngle`을 가진 회전 인라인 그림의 크기 조절을 허용한다. Release WASM `09e28d84…`에서 `stage3-{object-edit,picture-size,shapes}` 10/10 PASS, `pictureProperties.test.ts` 13/13 PASS, `release_hwp_gso_bytes_pass_only_for_proven_edits`(실제 회전 WASM 바이트 + 행렬 변조 거부 포함) PASS, `services::save` 289 PASS / 0 FAIL / 32 ignored, `typecheck`·`eslint` PASS.

**B4 HWPX 도형 z-order 영속성 및 명령 복구 (2026-11-19).** Release WASM `09e28d84…`에서 `changeShapeZOrder`와 HWPX 직렬화(`zOrder` 속성)·재파싱(`parse_i32`)·렌더 정렬(`paper_node_sort_key`) 경로를 전수 점검해 8종 도형과 양/음 `zOrder`·기존 샘플(`issue1858_paper_anchor_float_stack.hwpx` 등)이 손실 0 및 `getControls`/`getPageControlLayout`/`getPageLayerTree` 동일로 재열림을 확인했다. `RhwpEditorSession.ts`에서 `format === "hwpx"`에 한해 `"zOrder"` 연산과 `layer` 편집을 복원하고 미이동(`moves` 비어 있음) 호출은 이력을 남기지 않고 거부한다(HWP 형식은 `gso.rs` 불변 계약 유지를 위해 미제공). `stage3-shapes.wasm.test.ts`(3/3 PASS: `zOrder` 전환 + 겹침 도형 히트테스트/앞뒤 이동/재열기/Undo/Redo), `stage3-{object-edit,picture-size,shapes}` 11/11 PASS, `save_check saved hwpx` `{"outcome":"safe","findings":[]}`, `typecheck`·`eslint` PASS.

**B5 캡션 있는 HWP GSO 안전 편집 해결 (2026-11-19).** HWP5 캡션 GSO(`CTRL_HEADER` bit 29, level 2 `LIST_HEADER(72)` + 문단 `PARA_HEADER(66)`·하위 레코드 뒤에 `SHAPE_COMPONENT(76)`)에 대해 `gso::shape_component_pos`가 캡션 서브트리 뒤의 컴포넌트 위치를 정확히 찾도록 일반화하고, `check_ctrl_header`·`prove_evolved_gso`가 캡션 비트 고정 및 `&old[1..sc_idx] == &new[1..new_sc_idx]` 바이트 동일을 강제하면서 바깥 개체 편집(이동·크기·채우기·테두리·회전·배치·자르기·설명)을 수용하도록 확장했다(캡션 삭제·캡션 레코드 변조·bit 29 전환은 거부 유지). 프런트엔드 `pictureProperties.ts`(`deletable`은 `hasCaption === false` 유지), `RhwpEditorSession.ts`(HWP 캡션 도형 `delete` 제외), `hwpReopenModel.ts`(캡션 목록 안 `atno` 인식 및 캡션 도형 `complete` 수용)를 함께 갱신했다. `stage3-{object-edit,picture-size,shapes}` 12/12 PASS(실제 캡션 그림+도형 외곽 편집·삭제 거부·Undo/Redo·재열기 포함), `pictureProperties.test.ts` 13/13 PASS, `release_hwp_gso_bytes_pass_only_for_proven_edits` PASS, `services::save` 289 PASS / 0 FAIL / 32 ignored, `typecheck`·`eslint` PASS.

**B6 HWPX 차트 데이터 편집·저장 해결 (2026-11-19).** `hwp-source-preservation.patch`에 HWPX 직렬화 시 원본 `Contents/content.hpf`의 내부 OLE(`BinData/*.ole`, `isEmbeded="0"`) 항목 `id`/`href`/`media-type`/`isEmbeded` 보존과 `in_zip` 분리(`serializer/hwpx/{context,mod}.rs`)를 추가해 `7406_OLE__CHART.hwpx` 및 `samples/chart/*`의 무편집 내보내기(`loss=0`, `묶은세로막대형`·`꺽은선형`·`2차원원형` `save_check preflight` safe)를 복구했다. T009 `hwpx_charts.rs`는 `<hp:switch>`·`content.hpf`에 묶인 `(Chart/chartN.xml, BinData/*.ole)` 쌍에 대해 `c:chartSpace` 비데이터 XML 불변·기존 `<c:v>` 슬롯만 유한 수치/안전 문자열로 변경·중첩 CFB의 root CLSID 및 비차트 스트림 바이트 동일·양쪽 표현 논리 일치를 검증한다. `RhwpEditorSession.ts`는 HWPX 차트 `chartData` 편집·재열기·Undo/Redo 및 미지원 변이(`chartTitle`/`chartType`/`null`) 거부를 배선했다. Release WASM `18ab25e0…`에서 `stage3-chart-inspection.wasm.test.ts` 6/6 PASS, `release_hwpx_chart_bytes_pass_only_for_proven_edits` PASS, `services::save` 290 PASS / 0 FAIL / 33 ignored, `typecheck`·`eslint` PASS.

**B7 HWP 차트 데이터 편집·저장 해결 (2026-11-19).** Release WASM `18ab25e0…`의 HWP OLE 차트 경로(`7406_OLE__CHART.hwp` `getChartData`/`setChartData`/`exportHwpWithReport` `loss=0`, 일반 OLE `mixed_chart.hwp` `getChartData` 거부)와 연동해 `hwp.rs`에 `unlocked_ole_chart_keys` 및 `compare_stream_or_unpack`을 추가했다. 원본·출력 양쪽 `DocInfo` `BIN_DATA` 저장소가 일치하고 본문 비잠금 GSO `OLE`(`b" osg"`→`b"elo$"`→`TAG_OLE(84)`)가 해당 `BinData/BINxxxx.OLE`를 바인딩할 때만 언팩 바이트에 `hwpx_charts::prove_nested_ole_chart_cfb(&before, &after, true)`(4바이트 LE 길이 접두·root CLSID·비차트 스트림 동일·기존 `<c:v>` 셀만 유한 수치/안전 문자열 변경)를 적용해 허용하며 잠금/비차트/변조 OLE는 거부한다(`chart_changed` 시 `PrvImage` 갱신 허용). `hwpReopenModel.ts`는 유효 `parseGraphicProperties`·`getChartData`를 가진 본문 OLE 차트만 모델링(일반 OLE는 `complete=false` 유지)하고 `RhwpEditorSession.ts`·`chartsEqualOnReopen`은 HWP `chartData` 편집·Undo/Redo·재열기를 활성화했다. Stage 3 WASM 4파일 19/19 PASS(`stage3-chart-inspection` 7/7 PASS), `release_hwp_chart_bytes_pass_only_for_proven_edits` PASS, `services::save` 291 PASS / 0 FAIL / 34 ignored, 단위 테스트 3파일 45/45 PASS, `typecheck`·`eslint` PASS.

**P2 HWPX 단일 문단 글상자 CURRENT PASS.** Release WASM `f2c96060519075d4bd74021cb302cda8407341928822351d4c544d0c4b2828c9`의 `stage3-shapes.wasm.test.ts -t 'edits one owned HWPX text box'` 1 PASS. 실제 hit-test와 소유권 검사, 잠금 형제 진입 거부, 한글 조합·선택·문단 정렬·Undo/Redo, 내보내기·독립 재열기를 확인했다. 새 `p2-textbox-*.hwpx`와 엔진 손실 보고서의 T009 `save_check saved hwpx` 결과는 `safe`, `npm run typecheck`는 PASS다. 네이티브 입력기 확인과 중첩 개체는 후속 수용 범위다.

**P2 HWP 단일 문단 글상자 CURRENT PASS.** 동일 Release WASM에서 `stage3-shapes.wasm.test.ts -t 'edits a plain HWP text box'` 1 PASS. SAFE 사전 검사 뒤 글상자에 텍스트와 문단 정렬을 적용했고 원본 본문과 바깥 개체가 재열기 후 같았다. `release_hwp_p -- --ignored` 2 PASS. 새 HWP 실파일에서 삽입과 내부 편집 동시 저장, 기존 소유 글상자 편집, 잠금 글상자 내부 변경 거부를 확인했다. 글상자 신규 레코드 분기를 확장했으므로 P1은 기존 fixture로 T009만 재검증했다.

**P2 HWPX 표 셀 인라인 그림 CURRENT PASS.** 동일 Release WASM에서 `stage3-shapes.wasm.test.ts -t 'resizes an HWPX table-cell picture'` 1 PASS. 레이아웃과 모델 주소의 일치, 크기 변경·Undo/Redo, 독립 재열기와 자원 해시·형제 셀 텍스트 보존을 확인했다. `p2-cell-picture-*.hwpx` 실파일과 손실 보고서의 T009 `save_check saved hwpx` 결과는 `safe`, `npm run typecheck`는 PASS다.

**P3 HWP/HWPX 기본 도형 실선 굵기 CURRENT PASS.** 동일 Release WASM에서 `stage3-shapes.wasm.test.ts -t 'solid outline width'` 2 PASS. 속성 창의 `objectTools.test.tsx -t 'sends a positive RHWP line width'` 1 PASS. HWP T009 `release_hwp_p3_solid_outline_width_is_bounded`와 기존 GSO 변조 거부 시험이 통과했고, HWPX 실파일 T009 결과는 `safe`였다. 0.01–72pt를 1–7200 HWPUNIT으로 저장하며 선 종류와 다른 도형 기하·서식은 보존한다. 범위 밖 굵기, 선 없음, 캡션·글상자 하위 구조가 있는 도형은 이 연산의 범위 밖이다.

**P1/P3 결합 HWP 저장 CURRENT PASS.** Release `f2c96060519075d4bd74021cb302cda8407341928822351d4c544d0c4b2828c9`에서 `stage3-shapes.wasm.test.ts -t 'saves a newly inserted HWP rectangle'` 1 PASS. SAFE 원본에서 기본 사각형을 삽입하고 첫 저장 전에 2.45pt를 적용했다. Undo/Redo, 무손실 내보내기와 독립 재열기에서 굵기·기하·본문을 확인했다. 변경 전 T009는 이 출력의 BodyText를 거부했다. `release_hwp_inserted_shape_accepts_only_solid_outline_width`와 영향 범위의 `release_hwp_p1_shape_insertions_require_owned_canonical_records` 2 PASS. 출력 굵기 0·7201, 선 종류·기하·색 변조는 거부했다. 실파일·손실 보고서·T009 로그는 `target/stage3-combined-outline/`에 있다. 기존 도형 굵기와 P1 삽입 UI 근거는 REUSED PASS이며, 당시 결합 네이티브 UI는 NOT RUN. 이후 [C02](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 HWP 새 사각형을 삽입하고 첫 저장 전에 2.45pt를 바꾸는 조작이 Linux X11 PASS.

**P2 늦은 글상자 IME 확정 CURRENT PASS.** Release `f2c96060…`의 `stage3-shapes.wasm.test.ts -t 'binds delayed text-box IME'` 1 PASS. 교정 전에는 잠긴 원래 글상자에 확정이 수락됐다. 교정 후 형제로 커서를 옮겨도 원래 글상자에 한 번만 확정되며, 잠금·모델 변경·개체 삭제·다른 세션·폐기 이후에는 거부된다. 빈 취소와 중복 종료는 revision을 추가하지 않으며 Undo/Redo는 원래 글상자의 글자만 바꾼다. T010의 늦은 확정·취소·다시 불러오기 관련 합성 이벤트 8 PASS(`nativeImeOrder.test.tsx`, `imeOwnership.test.tsx`). 실행 로그는 `target/stage3-combined-outline/ime-{wasm,regression}.log`에 있다. 당시 늦은 확정 사례의 네이티브 재현은 NOT RUN. 이후 [C05](architecture/stage3-c-native-acceptance-2026-11-20.json)는 기존 HWPX 글상자 둘째 문단의 일반 IBus 조합·확정 PASS이며, 늦은 확정 반례의 별도 Native 증거로 사용하지 않는다.

**HWP GSO 잠금 검증 CURRENT PASS.** RHWP `control_props_json`은 공통 속성의 bool을 숫자 0/1로 내보낸다. Release `f2c96060…`에서 실제 잠금·해제, 누락·비정상 값, 잠금 확인 뒤 상태가 바뀐 선택의 명령 거부와 독립적인 크기 보호를 `stage3-shapes.wasm.test.ts -t 'requires an explicit HWP GSO unlock'` 1 PASS로 확인했다. 교정 전에는 누락된 값으로 선택한 개체를 편집할 수 있었다. 공통 판정 변경의 영향 범위인 기존 HWPX 실선 굵기와 HWP 차트 데이터 편집 WASM 시험 각 1 PASS. 로그는 `target/stage3-combined-outline/gso-lock-{wasm,chart}.log`에 있다. 저장 증명 코드는 변경하지 않아 기존 T009 보호·리소스 근거는 REUSED PASS다.

**P2 HWP 한 단계 표 셀 그림 크기 CURRENT PASS.** Release `f2c96060…`의 `stage3-shapes.wasm.test.ts -t 'resizes an hwp[x]? table-cell'` 2 PASS(HWP 신규 1, 공유 선택 경로를 변경한 HWPX 영향 회귀 1). 레이아웃·표·셀·문단·그림 소유권, 크기·Undo/Redo, 재열기·형제 셀·리소스 해시를 확인했다. HWP 실제 파일 T009 `release_hwp_cell_picture_resize_preserves_table_and_resource -- --ignored` 1 PASS. 표 높이·소유자·참조·형제 텍스트 변조, 양쪽 잠금 및 크기 보호 반례를 거부했다. 파일과 실행 로그는 `target/stage3-nested-pictures/`에 있다. 당시 한 단계 표 fixture의 네이티브 조작은 NOT RUN. 이후 [C04](architecture/stage3-c-native-acceptance-2026-11-20.json)의 두 형식 Linux X11 수용은 깊이 2 셀 fixture를 사용했다.

**P2 기존 다문단 글상자 편집 CURRENT PASS.** Release `f2c96060…`에서 `stage3-shapes.wasm.test.ts -t 'edits the second existing paragraph'` 양식별 1건씩 PASS. 두 번째 문단 적중·편집·Undo/Redo·독립 재열기와 첫 문단 보존, Enter/문단 경계 병합 거부를 확인했다. HWP T009 새 다문단 시험 및 같은 증명을 쓰는 기존 단일 문단 시험 2 PASS(목록 개수·기하·소유자 변조 거부). 동일 HWPX 판정 코드를 포함한 기존 `save_check saved hwpx`는 새 파일에 `safe`를 반환했다. `npm run typecheck` PASS. 실파일·로그는 `target/stage3-multipara/`에 있다. 당시 네이티브 글상자 조작은 NOT RUN. 이후 [C05](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 기존 HWPX 글상자 둘째 문단 IBus 편집이 Linux X11 PASS. HWP IBus는 아래 별도 실행을 참조한다.

**P2 HWP 글상자 네이티브 IME CURRENT PASS.** `native-stage3-textbox.py`를 격리된 Linux X11/IBus 세션에서 실행했다. 앱 SHA-256 `373e100a9e037f6c330c14a5801a38b9855109643b5f28ead908d26185a079c7`, Release WASM `f2c96060…`를 실제 실행에서 확인했다. 두 번째 문단에 실측한 두 번 클릭으로 들어가 신뢰된 조합 이벤트와 조합 중 revision 0을 확인했다. 두 음절 확정 뒤 revision 2를 안전 저장했고, 독립 WASM으로 디스크의 본문과 첫 문단이 그대로이며 둘째 문단이 `한글second`인지 확인했다. 새 앱 프로세스에서도 같은 문단이 열렸다. `target/stage3-multipara/native-result3/result.json` 및 `native-session3/cleanup.json`. 앞선 두 실행은 화면에서 문단에 적중하지 못했다. 이 하네스는 본문 영역에 목표 지점을 스크롤하고 실제 캔버스 적중을 확인한다.

**P2 당시와 현재의 경계.** 당시 RHWP는 단일 셀의 인라인 그림 크기까지 편집 증명을 썼으며 HWP 셀 그림의 네이티브 속성 조작은 NOT RUN이었다. 이후 [C03·C04](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 DOCX 중첩 셀과 본문 글상자 소속 도형, HWP/HWPX 깊이 2 셀 그림의 명시된 편집을 Linux X11에서 수용했다. P2 당시 별도 이야기 개체는 편집 범위 밖이었다. 이후 Stage 3-A P5에서 DOCX 머리말·꼬리말·각주·미주의 소유된 인라인 그림 대체 설명을 수용했다. 다른 이야기 개체 편집에는 전용 소유권과 저장 증명이 필요하다.

**P3 HWP 기본 도형 앞·뒤 보내기 CURRENT PASS.** Release `f2c96060…`의 `stage3-shapes.wasm.test.ts -t 'reorders existing HWP basic shapes|changes overlapping HWPX shape z-order'` 2 PASS(HWP 신규 1, HWPX 공유 명령 회귀 1). 겹침에서 적중 순서와 개체 주소, 잠긴 형제 거부, Undo/Redo 및 독립 재열기를 확인했다. 실제 HWP 출력의 T009 `release_hwp_basic_shape_layer_preserves_owned_records -- --ignored` 1 PASS. 순위·기하 변조와 잠금 반례를 거부했다. 파일과 로그는 `target/stage3-hwp-layer/`에 있다. 당시 네이티브 순위 조작은 NOT RUN. 이후 [C06](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 HWP 기본 도형 하나의 순위 변경과 겹침 적중·저장 재열기가 Linux X11 PASS.

**P3 그림 위치 프리셋 CURRENT PASS.** Release `f2c96060…`의 `stage3-object-edit.wasm.test.ts -t 'nine page-body alignments'` 2 PASS. HWP/HWPX에서 아홉 위치의 모델과 렌더 좌표, 인라인 그림 거부, Undo/Redo 및 독립 재열기를 확인했다. 영향 범위 WASM 개체 편집 2 PASS, 속성 창 동작 2 PASS, typecheck PASS. 새 HWP T009 실파일 시험과 기존 GSO 필드 증명 2 PASS(비호환 기준·정렬·오프셋·크기·여백 변조 거부), HWPX `save_check saved hwpx`는 `safe`. 실파일·실행 로그는 `target/stage3-position-presets/`에 있다. DOCX 모델·저장 근거는 REUSED PASS이며, 당시 새 네이티브 위치 프리셋 조작은 NOT RUN. 이후 [C07](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 HWP/HWPX 각 아홉 위치가 Linux X11 PASS.

**P3 남은 경계.** RHWP는 곡선 점·세그먼트와 그룹의 하위 그림을 직렬화한다. 곡선 편집 및 그룹 내부 편집에는 각 기하·변환과 자식 소유권을 증명하는 편집 및 T009 경로가 필요하다. 당시 범위 밖이었던 그룹 외곽 동작은 이후 [C09](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 지원 컨테이너 이동·크기·배치 및 HWPX 가역 삭제까지 Linux X11에서 수용했다. P3 당시 다각형 꼭짓점 변경, 그룹 내부 편집, HWP 그룹 삭제 및 여러 도형 순위가 바뀌는 한 번의 HWP 저장은 범위 밖이었다. 이후 B2.2는 소유가 증명된 평면 그룹 삭제, B1.1은 검증된 형제 도형 순위 변경을 수용했다. 이후 Stage 3-A P4는 HWPX 본문 다각형 꼭짓점, HWP5 본문 지원 곡선의 제어점과 공유 끝점, HWPX 평면 그룹의 사각형·타원 자식 단색 채우기를 수용했다.

**P3 HWP 다각형 실선 편집 CURRENT PASS.** Release `f2c96060…`의 `stage3-shapes.wasm.test.ts -t 'solid outline of an existing HWP polygon'` 1 PASS. 30° 회전된 기존 도형에 실선 색과 2.45pt를 적용했다. 크기·삭제는 거부했고 Undo/Redo와 독립 재열기를 확인했다. 실제 HWP는 T009 `release_hwp_polygon_outline_preserves_geometry -- --ignored` 1 PASS. 정점·변환 플래그·선 종류·범위 밖 굵기 변조를 거부했다. `target/stage3-polygon-outline/`에 출력과 로그가 있다. 이 회전 다각형 실선 fixture의 네이티브 편집은 NOT RUN이다. [C08](architecture/stage3-c-native-acceptance-2026-11-20.json)의 Linux X11 PASS는 HWP/HWPX 다각형·곡선의 대표 외곽 이동과 원래 꼭짓점·세그먼트 보존이다.

**P4 Linux 구조 MIME 전송 CURRENT PASS.** 실제 Release 앱 SHA-256 `66c2429408fb9efb2dec2846bccf20b5ed9a63866dde595c45269603c575e7ac`와 별도 GTK 프로세스가 X11에서 두 geul MIME의 바이트를 양방향으로 주고받았다. UTF-8 평문 제공·외부 평문 대체 읽기와 HTML MIME 거부를 확인했다. `native-stage3-clipboard-mime.py`의 `target/stage3-clipboard-mime/probe.IG8IGA/result/result.json` 및 런처 정리 기록, 전송 경로 신규 Vitest 1 PASS, 관련 클립보드 17 PASS, Rust 허용 목록·상한 1 PASS. 첫 네이티브 호출의 GTK 경로 오타와 결과 폴더 충돌은 하네스 실행 문제였으며, 올바른 경로와 새 폴더에서 재검증했다.

**P4 HWPX 교차 문서 휴대용 붙여넣기 손실 재현 및 차단 (기준 Release WASM `3414cfb09a20d6c51cc4d034f3350dc3997a4d85cc3fb93d93fb64775fcbbbd3`; 수정 acceptance는 같은 세대를 사용).** 기준 세대에서는 실제 다른 HWPX 문서 간 복사·붙여넣기 뒤 저장·독립 재열기에서 캡션 있는 도형의 캡션과 혼합 굵기 글상자의 굵은 서식이 사라졌다(과거 손실 재현 2건). 당시 수정은 모든 교차 문서 HWPX 개체 붙여넣기를 히스토리 경계 전에 거부했다. 새 `stage3-hwpx-clipboard-safety.wasm.test.ts` 5 PASS: 캡션·혼합 굵기·평문 기본 도형·평문 글상자 거부, 대상 직렬화 바이트/세션 스냅샷·커밋 이력 불변, schema-valid 위조 portable 페이로드 거부, 같은 문서 복제 Undo/Redo 및 재열기. 영향받은 기존 시험 `stage3-shapes.wasm.test.ts -t 'copies, cuts, and pastes HWPX body pictures'` 1 PASS(나머지 23건은 실행하지 않음). same-document `copyControl`/`pasteControl`은 유지된다. 당시 Native GUI는 NOT RUN. 이후 [C10·C11](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 HWPX 동일 문서 본문 그림 클립보드 및 교차 문서·예약 표식·잘못된 MIME 거부가 Linux X11 PASS. Historical behavior at the time; superseded within the documented Stage 3-B supported subset. [B3.2 후속 검증](architecture/stage3-b-clipboard-fidelity-followup-2026-11-20.json) 참조.

**P4 객체 표식 평문 폴백 차단 CURRENT PASS.** 구조 MIME이 없고 앱 내 payload 기억을 복구할 수 없는 경우, 정확한 `Geul <지원 object kind> [24 lowercase hex]` 표식은 문서에 평문으로 삽입되지 않는다. `clipboard.test.ts -t 'object marker fallback boundary|structured paste fallback ownership'` 12 PASS: orphan 표식 거부, 유사하지만 예약 문법과 다른 일반 텍스트 허용, 잘못된 구조 MIME에서 평문 읽기·강등 차단, 기존 표 구조 `notTable` 폴백과 비동기 소유권 경계 유지. `stage3-hwpx-clipboard-safety.wasm.test.ts -t 'routes missing MIME object markers'` 1 PASS: 평문 전용 모의 클립보드에서 같은 문서 기억 payload 복제, 다른 문서 거부, 기억 해제 뒤 orphan 표식 거부와 문서/revision 불변, 일반 문장 입력을 확인했다. 예약 문법과 정확히 일치하는 리터럴 텍스트는 거부된다. 표 구조 평문 폴백은 별도 승인 경로로 유지된다.

**P4 남은 경계.** 기존 DOCX 동일 문서·다른 DOCX 간 자원 재매핑 및 다중 셀 구조 붙여넣기의 문서·이력·T009 근거는 REUSED PASS다. 전송 시험은 외부 오피스 형식 상호운용을 포함하지 않는다. RHWP same-document `copyControl`·`pasteControl`의 기존 검증은 유지되며, 수정 후 기본 도형 clone에 대해 Undo/Redo·독립 재열기 회귀도 다시 통과했다. WordCraft의 리더는 중첩 그룹을 평탄화하고 라이터는 중첩 그룹 자식을 직렬화하지 않으므로 그대로 거부한다. P4 당시 RHWP 문서 간 리소스 재매핑은 미구현이었다. 이후 B3.2는 검증 가능한 HWPX 휴대용 개체의 대상 리소스를 재구성한다. 차트·SmartArt의 구조 복사에 필요한 새 패키지 부분 증명과 교차 형식 개체 변환은 미구현이다.

**P5 HWP 그림 캡션 CURRENT PASS.** Release `f2c96060…`의 `stage3-object-edit.wasm.test.ts -t 'edits an owned HWP picture caption|edits outer properties of caption-bearing'` 2 PASS. 실제 캡션 위치 적중, 텍스트·정렬, 실행 취소/다시 실행 시 캡션 커서 복구, 잠금·삭제 거부와 독립 재열기를 확인했다. 개발 중 이력 복원에서 캡션을 셀로 분류해 커서가 본문으로 돌아가는 결함을 교정했다. HWP T009 `release_hwp_picture_caption_preserves_owner_and_number_slot -- --ignored` 1 PASS. 번호 슬롯·번호 레코드·목록·그림 기하·자료 참조·잠금 반례를 거부했다. typecheck PASS. `target/stage3-caption-story/`에 파일과 로그가 있다. 당시 네이티브 캡션 편집은 NOT RUN이었으며 다문단 분할·병합, 도형 캡션 내부 편집 및 HWP/HWPX SmartArt 편집은 당시 범위 밖이었다. 후속 지원 그림 캡션의 64문단 교체와 경계 보호는 [C13](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 Linux X11 PASS.

**P5 HWP 그림 캡션 자동 번호 슬롯 경계 수정·검증 CURRENT PASS.** 실제 재현에서 `f2c96060…` 및 `RhwpText`가 `atno` 자리표시자 공백(오프셋 2) 삭제를 허용해 자동 번호 컨트롤이 문단 끝으로 밀리는 결함을 확인했다. `hwp-source-preservation.patch`에 `Control::Picture` 캡션 목록/`atno` 제어 노출(`field_query.rs`, `hwpctrl_sets.rs`)과 `AutoNumber` 슬롯 겹침 삭제·범위 교체 거부(`text_editing.rs`)를 추가해 Release WASM `bb0496bc3b10c42f2e4cdde8f27a0c55ad0e22357bdced355012107dc6c0253e`를 생성하고(`f2c96060…` 세대는 P6 출처 대조용으로 `public/rhwp/generations/`에 유지), `RhwpText.captionControlSlots`/`canDeleteRange`/`canInsertText` 및 `RhwpEditorSession.insertCommittedAt`에 `atno` 경계 거부를 배선했다. `stage3-object-edit.wasm.test.ts -t 'caption'` 3/3 PASS(신규 경계 음성 시나리오 포함: 백스페이스/Delete/선택 교체·IME 거부 시 텍스트·컨트롤·이력·revision 불변, `atno` 앞뒤 일반 편집·Undo/Redo·재열기 유지), `release_hwp_picture_caption_preserves_owner_and_number_slot` 1 PASS, `typecheck`·`eslint` PASS. 당시 경계 거부의 별도 네이티브 UI 재현은 NOT RUN. 이후 [C13](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 지원 그림 캡션의 Backspace·Delete·선택 교체 거부가 Linux X11 PASS. WASM 음성 사례의 모든 IME 조건을 재실행한 범위는 아니다.

### P6 증분 통합 수용 (2026-11-19)

Linux X11 Release 앱 SHA-256 `f6cffacdb0641ee642e8fdb0802ac5b4fbe6c920e8a00be5c4281b35ad4c0520`, 소스 `1ddbdd5`, RHWP Release `f2c96060519075d4bd74021cb302cda8407341928822351d4c544d0c4b2828c9` (`public/rhwp/generations/f2c96060...`에 보존). `VITE_GEUL_TEST_HOOKS=1 npm run tauri -- build --no-bundle` PASS. 실행·해시·오라클 감사 매니페스트와 재사용 스크립트는 [P6 감사 매니페스트](architecture/stage3-p6-native-acceptance-2026-11-19.json), [native-stage3-p6.py](../scripts/tests/native-stage3-p6.py), [stage3-p6-graphics-fixture.rs](../scripts/tests/stage3-p6-graphics-fixture.rs)로 Git에 보존하며, 대용량 바이너리(`target/stage3-p6/graphics-fixture` 609 MB)·원본 결과 디렉터리·XDG 프로필은 `target/stage3-p6/`에만 남는다.

| 범위 | 결과 | 확인한 동작 |
|---|---|---|
| HWP 그림 | CURRENT PASS | `native2/result.json`. 떠 있는 그림을 포인터로 (380.1, 172.3)에서 (426.1, 205.3)으로 이동. 다른 그림을 12% 자른 뒤 초기화하고 인라인에서 위/아래 배치로 변경. 저장 후 독립 재열기에서 위치·배치·초기화 및 본문·이미지 스트림 보존 확인. |
| HWP GSO 삭제 | CURRENT PASS | `native1/result.json`, `deletion-oracle.json`. 비잠금 그림 Delete→Undo→Delete와 실제 저장. 본문, 나머지 개체 레코드, 두 이미지 스트림 바이트 보존. |
| HWP 도형 서식 | CURRENT PASS | `native2/result.json`, `shape-oracle.json`. 사각형 단색 채우기·채우기 없음·Undo·선 색·상하 반전. 저장 후 채우기 `#996633`, 선 `#442277`, 상하 반전 및 기존 본문·그림 보존 확인. |
| HWP 캡션 | CURRENT PASS | `native1/result.json`. 실제 캔버스 클릭과 키 입력으로 한 문단 캡션 편집. 안전 저장과 독립 재열기 뒤 캡션 문자열·그림·본문 확인. 캡션 정렬과 캡션 커서 Undo/Redo는 P5 Release WASM 근거 재사용. |
| DOCX 차트·SmartArt | CURRENT PASS | `native2/result.json`. 차트 제목·막대 종류·값과 SmartArt 항목·단계·순환 배치 편집. 안전 저장, 패키지 XML 및 문서를 닫고 재열기한 속성 창 확인. |

포인터와 키 입력에는 WebDriver/xdotool을 사용했다. 색상 입력과 두 번째 실행의 드롭다운은 WebView DOM 이벤트로 변경했다. 네이티브 색상 선택기와 드롭다운 탐색은 수용 범위 밖이다. 첫 실행의 선택 프레임·GTK 옵션 처리 오류를 교정한 뒤 영향받은 그림·도형·DOCX 세 흐름만 실행했다. 삭제 검사에서 비교한 화면 개체 인덱스는 삭제로 다시 매겨졌고, 도형 검사에서 색상 값은 BGR로 반환됐다. 두 판정은 기존 게시 결과의 레코드·RGB 값을 독립 확인해 바로잡았다. 두 격리 세션의 프로세스와 소유 임시 디렉터리 정리 PASS.

DOCX 도형 끌기·크기 핸들, HWP 그림 선택·크기·설명, 사각형 키보드 이동·좌우 반전, 보호된 삭제 거부, HWP 글상자 IBus와 Linux 구조 MIME 전송은 관련 기록의 REUSED PASS다. P6에서 Rust·Vitest·WASM 전체 묶음과 기존 네이티브 시나리오를 다시 실행하지 않았다.

**P5 HWP/HWPX 도형 캡션 및 다문단 캡션 확장 CURRENT PASS.** `hwp-source-preservation.patch`에 `Control::AutoNumber(_)` 분할 오프셋 보정(`model/paragraph.rs`), 도형 캡션 레이아웃/셀 경로 `TABLE_CAPTION_CELL_SENTINEL` (`65534`) 배선(`shape_layout.rs`, `text_editing.rs`, `cursor_nav.rs`, `rendering.rs`), 1–64문단 캡션 분할·병합·다문단 범위 삭제(`delete_range_native`)를 추가해 Release WASM `3414cfb09a20d6c51cc4d034f3350dc3997a4d85cc3fb93d93fb64775fcbbbd3`를 생성했다(`f2c96060…` 세대는 P6 출처 대조용으로 유지). 프런트엔드 `RhwpText`·`RhwpEditorSession`은 그림(`cell=0`)과 기본 도형(`사각형`·`타원`·`직선`·`다각형`·`곡선`, `tbVerticalAlign === undefined`, `cell=65534`)에 대해 HWP/HWPX 양쪽의 1–64문단 캡션 편집·정렬·`Enter` 분할·병합·다문단 선택 교체·`atno` 경계 거부를 활성화한다(컨테이너·글상자+캡션 중첩 및 캡션 내 `\t` 제외). Rust T009(`gso.rs`·`insertions.rs::prove_caption_paragraphs`)는 지원 6종 leaf GSO 캡션과 `1..=64` 문단 `LIST_HEADER`(`[2..]` 불변)·전 문단 합산 `atno` 유지를 검증하고 `atno` 유실·이중 `atno`·잠금·`LIST_HEADER[2..]` 변조를 거부한다. `stage3-object-edit.wasm.test.ts` 11/11 PASS, `stage3-shapes.wasm.test.ts` 24/24 PASS, `save_check saved hwpx`(`p5-shape-caption-edited.hwpx`·`p5-multipara-caption-edited.hwpx`) SAFE, `services::save::hwp::gso` 9 PASS(18 ignored) + `services::save::hwp::insertions` 34 PASS + `release_hwp_shape_and_multiparagraph_captions -- --ignored` 1 PASS + `release_hwp_picture_caption_preserves_owner_and_number_slot -- --ignored` 1 PASS, `typecheck`·`eslint` PASS. 당시에는 도형·다문단 캡션 Native가 NOT RUN이었다. 이후 범위 한정 Native 수용은 [2026-11-20 기록](architecture/stage3-caption-native-acceptance-2026-11-20.json)에 기록했다.

**P5 64문단 선택 교체 경계 CURRENT PASS.** 기존 사전 검사는 선택 삭제로 없어질 캡션 문단 경계를 빼지 않아 64문단 상태의 유효한 교체를 거부할 수 있었다. 프런트엔드는 실제 선택이 허용된 경계 수를 제거한 뒤 삽입 개행 수를 더해, mutation 전에 최종 문단 수가 1..=64인지 검사한다. Release WASM `3414cfb09a20d6c51cc4d034f3350dc3997a4d85cc3fb93d93fb64775fcbbbd3`의 `stage3-object-edit.wasm.test.ts -t 'accepts a 64-paragraph caption replacement'` PASS (HWP/HWPX): 64→64 텍스트 교체와 선택 상태 Enter 허용, 결과 65와 선택 없는 64문단 Enter 거부, `atno` 겹침 거부, 거부 시 revision/history 불변, Undo/Redo 및 독립 재열기에서 문단·번호·그림 동일성을 확인했다. HWP 출력은 preview 갱신 후 `release_hwp_caption_boundary_preservation` T009 PASS; 갱신하지 않은 HWP 중간 출력은 `recordsChanged`/`previewStale`로 unsafe였고 최종 수용 근거로 사용하지 않았다. HWPX `save_check` SAFE. 이전 11개 object-edit PASS는 재실행하지 않았고 당시 이 경계의 Native GUI는 NOT RUN. 이후 [C13](architecture/stage3-c-native-acceptance-2026-11-20.json)에서 HWP/HWPX 지원 그림 캡션의 64/65문단과 자동 번호 안전 경계가 Linux X11 PASS.

**Stage 3 남은 경계 요약 — 전체 상태 PARTIALLY COMPLETED.** P6의 역사적 수용 범위와 이후 순차 구현·검증한 Stage 3 항목(P5 `atno` 슬롯 경계·도형/다문단 캡션, P2 중첩 표 셀 그림·본문/소속 글상자 도형, P3 그룹·곡선/다각형 기하, P4 DOCX v2 ID 재매핑·HWPX v3 동일 문서 구조 클립보드)은 각 항목의 Release WASM·Rust T009/단위 시험 근거로 검증됐다.

- Stage 3-B는 SAFE Section0의 소유된 비잠금 캡션 포함 본문 그림·기본 도형 삭제(B2.1)와 자식·공유 리소스 보존이 증명된 비잠금 평면 그룹 삭제(B2.2)를 수용했다. 캡션 포함 글상자, 잠금·중첩·미소유 개체와 안전한 저장을 증명할 수 없는 삭제는 거부한다. 크기 보호가 적용되는 크기 변경과 소유 불명·공유 OLE 변경도 거부한다.
- 동일 문서 HWP5 구조 클립보드(B3.1)와 제한된 HWPX 교차 문서 휴대용 클립보드(B3.2)는 각각 소유권과 보존 계약을 충족할 때 지원한다. Stage 3-A P6가 수용한 폐합 HWPX 다각형의 교차 문서 전송과 HWPX → DOCX 자유형 변환은 아래 P6 표에 명시한다. 교차 문서 HWP5, 나머지 교차 형식, 미지원 개체·서식·중첩 컨트롤·리소스 소유권 및 예약 표식의 평문 폴백은 거부한다. [B3.2 속성 보존 검증](architecture/stage3-b-portable-property-safety-2026-11-20.json)
- Stage 3-A는 아래 P4–P6의 범위에서 지원한다. DOCX 별도 이야기의 그림 대체 설명·지원 크기 조정 외 개체 연산, HWP/HWPX 별도 이야기 개체, 글상자 안 중첩 제어의 소유권과 저장 증명, 차트·SmartArt 구조 클립보드는 남아 있다. HWP/HWPX 캡션의 편집·IBus 조합·저장·재열기 및 잠긴 도형의 캡션 진입 거부는 해당 Linux X11 fixture 범위에서 검증됐다. 플랫폼별 수락 범위는 [현행 인벤토리](architecture/stage3-a-current-inventory.md)에 기록한다.

**Stage 3-C Linux X11 Native 수용 (2026-11-20) — COMPLETED, 13/13.** C01–C13의 형식별 실제 GUI 동작, Undo/Redo, 발행 저장 및 독립 재열기, 거부 불변식과 세션 정리를 [집계 실행 기록](architecture/stage3-c-native-acceptance-2026-11-20.json)에 남겼다. C01·C09의 RHWP 드래그 단위 변환과 C09의 기존 그룹 배치 명령 UI 연결을 수정했다. C11은 당시 HWPX 교차 문서 붙여넣기를 의도적으로 거부해 PASS했다. Historical behavior at the time; superseded within the documented Stage 3-B supported subset. C12는 HWP·HWPX의 검증된 빈 미리보기 fixture에 한정한다. 비어 있지 않은 미리보기와 증명되지 않은 패키지 구조는 보존 검사에서 계속 거부한다. Stage 3 전체는 **PARTIALLY COMPLETED**이며 A/B와 Wayland·Windows·macOS의 상태는 별도다. 기존 P6·캡션 기록의 범위와 출처는 그대로 유지한다.

**Stage 3-C 후속 안전 및 출처 확인.** 위치와 크기를 동시에 바꿀 수 없는 이동 가능 RHWP 도형·그룹은 서쪽 또는 북쪽 앵커를 바꾸는 5개 핸들을 숨긴다. 동·남동·남쪽 및 독립 이동은 지원되는 선택에서 유지한다. 부유 그림은 이동만 제공하고 인라인 그림의 여덟 방향은 유지한다. 남쪽 크기 변경이 원래 저장 너비를 유지하는지 확인했다. C09는 두 형식 모두 `(500, 500) → (1500, 500)` HWPUNIT과 재열기 위치를 확인했다. 원래 Stage 3-C 실행은 격리 X11/IBus 세션 12개와 개별 앱 세션 50개다. 후속 실행 3개는 별도다. [후속 실행 및 세션 감사](architecture/stage3-c-resize-followup-2026-11-20.json)

**P6 증거 보관 상태 점검 (2026-11-20; 수용 결과 자체를 재실행하지 않음).** [기존 P6 매니페스트](architecture/stage3-p6-native-acceptance-2026-11-19.json)는 원래 source/app/RHWP generation과 해당 시점의 테스트 결과를 기록한다. 기대 앱 SHA `f6cffacdb0641ee642e8fdb0802ac5b4fbe6c920e8a00be5c4281b35ad4c0520`와 일치하는 보존 앱 바이너리가 `target/stage3-caption-native-20261120/p6-app-preserved`에 있다. 현재 확인 가능한 저장물 중 `native1/delete.hwp`, `native1/caption.hwp`, `native2/picture.hwp`, `native2/graphics.docx`는 매니페스트 해시와 일치하지만 `native2/shape.hwp`는 존재해도 SHA가 매니페스트의 `cdd2cb29…`와 불일치한다. 따라서 현재 바이너리·출력 파일을 모두 독립 감사했다고 주장하지 않는다. 이 해시 불일치는 당시의 shape acceptance를 무효화하지 않으며, 역사 매니페스트의 결과는 기록 당시 범위로 보존한다. 새 도형/캡션 수용은 별도 세대와 산출물 식별자를 가진 2026-11-20 기록을 따른다.

**Stage 3-B 안전 차단 개체 편집 수용 (2026-11-20) — B1/B2/B3 COMPLETED.** 기준 HEAD `41f0b075e721674e6fd0f0134801bbd35fb0855f`에서 Stage B1(`08109a1`: HWP5 단일 저장 내 다중 기본 도형 z-order 연속 변경 및 캡션 편집+외곽 도형 서식 결합 저장), Stage B2(`4096acc`: 캡션 포함 비잠금 HWP 그림/기본 도형 삭제와 평면 리프 HWP5 그룹 삭제 + `stage3b-object-safety.patch`), Stage B3(`a735b17`: 동일 문서 HWP5 구조 개체 복사·잘라내기·붙여넣기 및 HWPX 교차 문서 휴대용 개체 붙여넣기)와 네이티브 캡션/T010 교정(`0be8877`)을 구현·검증했다. Release RHWP WASM `92b8135be4772ec7247a7208a252c1e3126bfbec9d620bf75ed12e03c4a8074f`(`rhwp_bg.wasm`: `f745d400...`) 기준 `npm run typecheck` PASS, Vitest 단위(`pictureProperties`·`objectClipboard`·`clipboard`) 65/65 PASS, Stage 3 WASM 6개 스위트 71/71 PASS, Rust `services::save` 302 PASS / 0 FAIL / 54 ignored 및 B1/B2/B3 Release T009 `--ignored` 실파일 검증 4/4 PASS, `test_rhwp_profiles.py` 3/3 PASS, 격리 Linux X11/Xvfb Release GUI 수용(`native-stage3-b.py`, 앱 SHA-256 `9921a5a6...`, 정리 `proven: true` / `filesystemProven: true`) 6/6 PASS([매니페스트](architecture/stage3-b-safety-acceptance-2026-11-20.json), [보고서](architecture/stage3-b-safety-acceptance-2026-11-20.md)). 기존 Stage 3-C 서쪽/북쪽 크기 조절 핸들 제한, 잠긴 개체·캡션 포함 글상자 삭제·중첩·OLE 포함 또는 자원 소유가 증명되지 않은 그룹 삭제·교차 문서 HWP5 붙여넣기·예약 객체 표식 평문 폴백 및 미지원 HWPX 교차 문서 개체(그룹·다각형·곡선·그라데이션/그림 채우기·내부 컨트롤) 거부는 그대로 유지한다. Stage 3-A 및 Wayland·Windows·macOS는 별도 범위로 남는다.

**Stage 3-B B3.2 클립보드 보존 후속 (2026-11-20) — COMPLETED.** 휴대용 그림·사각형·타원·기본 직선·글상자는 지원되는 속성을 모두 적용하고 다시 읽어 확인한 경우에 수용한다. 도형의 실선과 무윤곽을 명시적으로 구분한다. 문단 정렬, 전체 문자 서식 범위(캡션의 `atno` 슬롯 제외), 7개 언어별 글꼴 참조 일치를 확인하며 실패한 붙여넣기는 개체와 글꼴 표를 함께 되돌린다. Release WASM 33건, 클립보드 단위 52건, 저장 보존 Rust 3건, 새 Linux X11 Native B3-2 1건이 PASS했다. 실제 저장 및 독립 RHWP·ZIP 검사와 앱 재열기에서 다문단 캡션, `atno`, 혼합 서식과 명시 글꼴을 확인했다. 점선 도형은 거부됐다. Stage 3 전체는 **PARTIALLY COMPLETED**다. [B3.2 후속 검증](architecture/stage3-b-clipboard-fidelity-followup-2026-11-20.json)

**Stage 3-B B3.2 개체 속성 보존 후속 (2026-11-20).** 글상자의 세로 정렬과 네 내부 여백, 무테두리 그림과 실제 자르기 좌표를 확인한다. Linux X11 B3-2에서 Bottom 글상자와 자르기한 PNG를 게시·독립 검사·재열기했고 원본 바이트와 대상 본문을 보존했다. [속성 감사와 실행 기록](architecture/stage3-b-portable-property-safety-2026-11-20.json)

**Stage 3-A P4 고급 기하 및 그룹 자식 편집 (2026-11-20–22) — PARTIAL_SUPPORT.**

| 항목 | 수용 범위 | 증거와 남은 경계 |
|---|---|---|
| P4.1 다각형 | HWPX의 본문 비잠금·크기 비보호 다각형에서 정수 꼭짓점 드래그와 좌표 입력 | Release WASM과 Linux X11 게시·독립 XML 검사·앱 재열기 PASS. 폐합 유지. 회전·반전·캡션·중첩은 이 수용 범위 밖이다. |
| P4.2 Bézier | HWP5의 SAFE 본문 open cubic 및 직선 혼합 경로에서 제어점·공유 끝점 이동 | Release WASM, 집중 T009, Linux X11 게시·독립 CFB 검사·앱 재열기 PASS. 구간 종류·패딩 유지. 폐곡선·이차 및 HWPX/DOCX의 무손실 곡선 구간 모델은 남아 있다. |
| P4-HX-CURVE | HWPX 본문에서 연결된 `LINE`/`CURVE` 구간의 정수 endpoint 편집 | 원본 segment 속성·순서·폐합, shared endpoint, Undo/Redo, Release WASM 저장/재열기 및 Linux X11 실제 포인터·T009 게시·앱 재열기 PASS. 변경한 `section0.xml` 이외 OPC part 바이트 동일, 알 수 없는 `SPLINE`은 편집 거부. 명시 Bezier 제어점 좌표는 공식 HWPML SEGMENT 정의에 없어 전체 요청은 미완료/차단 상태다. [부분 수락 기록](architecture/stage3-a-p4-hwpx-curve-acceptance.json) |
| P4-DX-CURVE | DOCX 본문 최상위 자유형의 원본 quadratic/cubic 제어점 편집 | WordCraft typed DrawingML parser/model/render/writer와 geul 좌표 UI가 `quadBezTo`/`cubicBezTo` identity, 정수 좌표, path viewport 및 metadata를 유지한다. Rust/T009·TypeScript 및 Native X11 PASS. 신뢰된 포인터/키보드 입력으로 두 제어점을 편집하고 Undo/Redo; 저장 `word/document.xml`은 해당 두 점 외 동일, 관계 및 다른 8개 package parts 동일, T009 saved/synced이며 새 앱 세션에서 재열기 좌표가 일치한다. [수락 기록](architecture/stage3-a-p4-docx-curve-acceptance.json). 지원 밖 변환/metadata는 fail-closed; 구간 삽입·삭제는 P4-DX-PATH, 회전·반전 편집은 P4-PATH-XFM에서 제한 지원한다. 구현 커밋 WordCraft `0b9a5f2`, geul `7976452`, IPC parser/회귀 `4050b896`. |
| P4-DX-PATH | DOCX 본문 최상위 안전 freeform의 직선 경로 꼭짓점 삽입·삭제 | 직선 `lnTo` 또는 closing edge에 정수 lattice point를 삽입하고 기존 `lnTo`를 삭제한다. 열린 경로 최소 2개, 닫힌 경로 최소 3개 꼭짓점을 유지한다. WordCraft parser/engine, geul Rust T009와 TypeScript PASS. Linux X11에서 trusted pointer 선택·삽입/삭제·Undo/Redo·T009 저장·새 앱 재열기 PASS. 두 저장 DOCX는 각각 의도한 `lnTo` 삽입/삭제 외 `word/document.xml`이 동일하고, 관계 및 다른 8 package parts 바이트 동일하다. [수락 기록](architecture/stage3-a-p4-docx-path-acceptance.json). 곡선 분할, Ink, 미지원 구조와 변환 상태에서의 꼭짓점 삽입·삭제는 fail-closed; 회전·반전 상태의 control-point 이동은 [P4-PATH-XFM](architecture/stage3-a-p4-path-transform-acceptance.json) 지원 범위다. |
| P4-PATH-XFM | DOCX/HWP5/HWPX 지원 path control point의 회전·반전·offset 보존 편집 | 표시 handle을 선택 프레임 안에서 렌더 기준으로 배치하고 `R·F`의 역변환을 적용해 원래 path 정수 좌표에 반영한다. DOCX는 top-level custom DrawingML cubic, RHWP는 HWP5 Section0 cubic과 HWPX body polygon으로 범위를 제한한다. Rust T009, Release WASM, UI transform helper 4건, `ObjectSelectionFrame` 32건, typecheck 및 exact Release build PASS. [수락 증거](architecture/stage3-a-p4-path-transform-acceptance.json). X11 Native는 실제 trusted pointer/keyboard 입력, 각 편집의 Undo/Redo, T009 saved/synced 및 새 앱 재열기에서 세 형식 모두 PASS했다. DOCX는 `word/document.xml`의 제어점 외 동일, 관계 및 다른 8 parts 동일; HWPX는 예상 section XML 외 package part 동일; HWP5는 한 tag-83 leaf만 바뀌고 모든 인접 record와 비-preview CFB stream 동일, preview 갱신. |
| P4-DX-GROUP | DOCX 본문 최상위 group의 직접 자식 geometry 편집 | 중첩 group 자식 move/resize를 X11에서 실제 선택해 Undo/Redo, T009 saved/synced, 독립 패키지 검사와 앱 재열기를 확인했다. 저장 트리는 nested rect·picture relationship과 sibling ellipse를 유지했고, 의도된 그룹 geometry 외 XML 변경 없이 관계와 다른 9 OPC parts가 바이트 동일했다. [상세 수락](architecture/stage3-a-p4-docx-group-acceptance.json). 비보호·track changes 없음·canvas/회전/반전/scaled axes 없는 지원 group으로 한정한다. |
| P4-HX-NEST | HWPX 본문 중첩 그룹의 안전한 Rectangle/Ellipse 자식 선택·이동·크기 변경 | 재귀 컨테이너를 각 단계 index/id/instId로 주소 지정하고, 정확한 정수 local translation을 합성해 표시 좌표를 부모 로컬 저장 좌표로 역변환한다. 별도 container id/instid, groupLevel, 자식 순서·형제는 보존한다. 집중 Release WASM 사례에서 오래된 주소 요청의 무변이·이력 불변, SVG 기하, 원본 불변, 원본 XML geometry, 다른 OPC part 바이트와 독립 재열기를 확인했다. [상세 수락](architecture/stage3-a-p4-nested-group-acceptance.json) |
| P4.3 그룹 자식 | HWPX의 비잠금·비보호 평면 사각형·타원 그룹에서 지정 자식의 단색 배경 변경(`groupChildFill`) 및 위치·왼쪽/위 기준 크기 편집(`groupChildMove`/`groupChildResize`) | Release WASM(`972f25b9...`, P1–P4·N1–N12·T1–T8·E1–E7 포함 그룹 테스트 10 통과)·`save_check` safe·UI 22 통과(U1–U8 포함)·기존 Linux X11 Native(`P4.3`/`P4.6` PASS, `0b8a2e4`). [P4.6-1 그룹 기하 교정](architecture/stage3-a-p4-group-geometry-acceptance.json), [P4.6-2 그룹 자식 기하 편집 수용 기록](architecture/stage3-a-p4-group-child-edit-acceptance.json), [P4.6 안전화 후속 기록](architecture/stage3-a-p4-group-child-safety-stabilization.json). 홀수 타원의 변경되지 않은 축과 자식 식별자 왕복 보존, 절단 버퍼 거부, Linux X11 Release의 실제 핸들 밖 포인터 캡처·해제 및 저장을 추가 검증했다. [P4.6 최종 경계 검증](architecture/stage3-a-p4-group-child-boundary-verification.json). 상쇄 복합/비유한/손상 `raw_rendering`, 오버플로/비정규 타원 크기조절(비정규 끝점은 이동만 보존·크기조절 거부), 비정규 변환이 있는 중첩 그룹·전단·캡션·글상자 자식 및 HWP5/DOCX 자식 기하 편집은 거부하며 범위 밖이다. canonical local-translation HWPX 중첩 자식 편집은 [P4-HX-NEST](architecture/stage3-a-p4-nested-group-acceptance.json) 지원 범위에서 별도로 검증했다. |
| P4.4 다각형 구조 | 검증된 HWPX 본문 단순 폐합 다각형의 변에 정수 꼭짓점 추가·기존 꼭짓점 삭제 | Release WASM, 추가·삭제 각각 T009, Linux X11 실제 클릭·Undo/Redo·게시·독립 XML·앱 재열기 PASS. 교차·퇴화·열린 경로와 HWP5/DOCX는 제외. [수용 기록](architecture/stage3-a-p4-polygon-vertices-acceptance.json) |
| P4-H5-POLY HWP5 다각형 | SAFE Section0의 본문 단순 폐합에서 정수 점 이동, 공선 변 분할·병합 | Release WASM·T009·독립 CFB 검사·RHWP 재열기 PASS. X11 점 이동·변 분할/병합 및 Wayland 점 이동 PASS. 회전·반전·비영 오프셋, 비공선 모서리 삭제, 모서리 이동과 꼭짓점 수 변경을 함께 담은 게시는 제외한다. [검증 기록](architecture/stage3-a-p4-hwp5-polygon-acceptance.json) |
| P4.5 곡선 구간 | SAFE HWP5 본문의 지원 열린 cubic 경로에서 마지막 끝점에 직선 추가 및 마지막 직선 삭제 | 집중 T009·Release WASM·Linux X11 실제 게시 2건·독립 CFB·앱 재열기 PASS. 직선 내부의 정확한 정수 점 분할과 같은 방향의 인접 두 직선을 합치는 기능도 지원한다. 두 cubic 사이의 직선에서 새 Linux X11 실제 편집·Undo/Redo·두 차례 게시·독립 CFB·앱 재열기 PASS다. 비공선 접점 삭제와 cubic·이차 구간 삽입·삭제는 제외한다. [내부 직선 수락 기록](architecture/stage3-a-p4-curve-interior-acceptance.json) [수용 기록](architecture/stage3-a-p4-terminal-line-acceptance.json) |

일반 점 편집 중 path section 삽입·삭제는 변환 없는 프레임을 요구한다. 원본 control point 이동은 [P4-PATH-XFM](architecture/stage3-a-p4-path-transform-acceptance.json)의 한정된 회전·반전·offset 범위에서 별도로 처리한다. 지원 좌표는 원본 path viewport의 정수 격자에 반올림·제한하며 객체 placement, 원본 프레임·크기와 저장 변환은 유지한다. RHWP는 항등 raw rendering matrix, bounded offset, 지원되는 path kind를 요구하고 HWP5 polygon은 component offset이 0이어야 한다. 기타 비정규 행렬·구조는 fail-closed다. [기존 변환 경계](architecture/stage3-a-p4-transform-safety-acceptance.json)

기존 Linux X11 및 Undo/Redo는 [P4 수용 기록](architecture/stage3-a-p4-object-geometry-acceptance.json)에 있다. 구현 전 상태는 [초기 감사](architecture/stage3-a-initial-audit.md)에 보존한다.

**Stage 3-A P5 문서 이야기와 복합 글상자 (2026-11-20) — PARTIAL_SUPPORT.** DOCX의 머리말·꼬리말·각주·미주에서 최상위 인라인 내장 그림의 대체 설명을 수정할 수 있다. HWPX의 지원 본문 글상자에서는 혼합 서식 문단 내부를 Enter로 분할할 수 있다. 네 DOCX 이야기와 HWPX 글상자를 Linux X11에서 각각 편집·Undo/Redo·게시하고, 별도 XML/엔진으로 검사한 뒤 앱에서 다시 열었다. 이야기 개체 이동·삭제, 다른 형식의 이야기 개체와 중첩 컨트롤은 제외한다. [P5 수용 기록](architecture/stage3-a-p5-nested-story-acceptance.json)

**P5 DOCX 이야기 그림 크기 조정.** 원본 XML 왕복, 별도 OPC 관계 및 두 저장 치수가 확인되는 머리말·꼬리말·각주·미주의 최상위 내장 인라인 그림을 제자리에서 조정한다. Linux X11에서 네 이야기의 실제 편집·Undo/Redo·게시와 독립 OPC 검사·앱 재열기 PASS다. [크기 조정 수락](architecture/stage3-a-p5-story-size-acceptance.json)

**P5.5 글상자 문단 병합·범위 삭제.** 같은 문단 모양·스타일의 HWPX 본문 글상자 인접 문단 두 개에서 Backspace/Delete로 경계를 없애거나 선택 범위를 지울 수 있다. Linux X11 실제 키 입력·Undo/Redo·게시, 독립 XML과 앱 재열기를 확인했다. 같은 문단 모양·스타일의 일반 문단 세 개 이상에 걸친 키보드 삭제도 지원한다(글상자 최대 64문단). Linux X11에서 세 문단 선택과 Delete, Undo/Redo, 동기 게시, 독립 XML·RHWP 검사와 앱 재열기를 확인했다. HWP5와 다른 문단 서식, 중첩 제어, 다문단 IME 교체는 제외한다. [P5.5 수락 기록](architecture/stage3-a-p5-textbox-join-acceptance.json), [P5-TB-RANGE 수락 기록](architecture/stage3-a-p5-textbox-range-acceptance.json)


**P5-TB-REPLACE HWPX 글상자 붙여넣기.** 같은 모양과 스타일의 본문 글상자 다문단 선택을 평문 클립보드로 교체한다. 앞뒤의 문자 서식과 글상자 범위를 유지하며 삽입 실패 시 삭제도 되돌린다. Release WASM, T009, 독립 XML 및 RHWP 재열기 PASS. X11 실제 Ctrl+V·Undo/Redo·게시·앱 재열기 PASS. [검증 기록](architecture/stage3-a-p5-textbox-paste-acceptance.json)

**Stage 3-A P6 고급 개체 구조 (2026-11-20) — PARTIAL_SUPPORT.**

| 항목 | 수용 범위 | 증거와 남은 경계 |
|---|---|---|
| P6.1 구조 클립보드 | HWPX 본문 폐합 다각형을 다른 HWPX 문서에 붙여넣기 | 새 대상 ID, 경로·속성, 원본과 대상 형제 보존. HWP5 교차 문서 리소스 매핑, 그룹·중첩·곡선은 남아 있다. |
| P6.2 개체 유형 변환 | DOCX의 지원 인라인 사각형과 타원 간 변경. 원본 본문 XML 왕복이 일치하는 기본 `roundRect`에서 `rect`로 변환 | 둥근 사각형 변환은 집중 Rust·T009·독립 OPC 검사·재열기 및 X11·Wayland PASS. 사용자 조정·비슷한 프리셋 정규화는 거부한다. [검증 기록](architecture/stage3-a-p6-round-rect-acceptance.json) |
| P6.2 교차 형식 변환 | 단색 무윤곽 HWPX 인라인 폐합 다각형을 DOCX 편집 가능 자유형으로 붙여넣기 | 정확한 HWPUNIT→EMU, DrawingML 구간, 색·대체 설명과 원본 보존. 역방향, HWP5, 다른 개체에는 별도 매핑 증명이 필요하다. |
| P6.3 캡션 | HWPX 본문 내장 그림의 기존 캡션 위·아래 위치 변경 | 소유, 단일 `atno`, 서식 및 이미지 바이트 보존. 지원 열 기준 부유 그림에 좌우 위치와 위·가운데·아래 세로 정렬을 제공한다. Linux X11 실제 속성 편집, 각각 Undo/Redo, 안전 게시, 독립 XML/배치 검사와 앱 재열기 PASS다. 인라인 그림의 좌우 배치, 그룹 캡션, DOCX/HWP5 위치 변경은 남아 있다. [좌우 배치·정렬 수락](architecture/stage3-a-p6-caption-lateral-acceptance.json) |
| P6.7 캡션 간격 | HWPX 본문 그림의 기존 위·아래 캡션에서 간격 0–327.67pt | Linux X11 속성 입력·Undo/Redo·게시·앱 재열기 PASS. 독립 XML에서 `gap`만 바뀌고 번호·서식·이미지 바이트는 보존됐다. [수용 기록](architecture/stage3-a-p6-caption-spacing-acceptance.json) |
| P6.4 SmartArt | 기존 DOCX 모델의 항목·단계·지원 레이아웃 편집 | 집중 WordCraft 재검증 PASS, 기존 X11 수용 재사용. 일반 다이어그램 편집, 노드별 스타일, 외부·공유 파트 편집은 남아 있다. |

초기 P6 네 경로의 Linux X11 실제 조작, Undo/Redo, 안전 저장, 독립 저장본 검사 및 앱 재열기가 PASS했다. 이 수용 실행의 RHWP Release는 `5ca8f50d…`였다. 자세한 형식 조합, 실행 및 아티팩트는 [변환 조합](architecture/command-registry.md#stage-3-a-p6-구조-전송과-변환)과 [P6 수용 기록](architecture/stage3-a-p6-advanced-structure-acceptance.json)에 있다. Stage 3-A 및 Stage 3 전체 상태는 **PARTIALLY COMPLETED**다.

이 작업의 Linux Native는 X11 4건과 Wayland 5건 PASS다. Wayland에서 새 다각형 점·DOCX 프리셋과 기존 HWP5 내부 직선, HWPX 다문단 범위 삭제, 오른쪽/아래 캡션을 수락했다. Windows와 macOS는 Native 환경이 없어 NOT RUN이다. [실행·게시·재열기 기록](architecture/stage3-a-native-p4-p5-p6-acceptance.json)

최신 누락 기능, 안전 차단과 플랫폼 수락 의무는 [Stage 3-A 현행 인벤토리](architecture/stage3-a-current-inventory.md)에서 관리한다.

### P4-H5-SEG HWP5 cubic segment 편집 (2026-11-22)

**CURRENT PASS — 명시한 SAFE HWP5 범위.** Ordered RHWP patch 46과 geul 명령/UI가 안전한 최상위 Section0 열린 cubic path의 비공선 제어점 이동, cubic segment 한 개 삽입·삭제를 지원한다. 미지원 leaf·명령·패딩, 비항등 transform/오프셋, 잘못된 소유권과 마지막 cubic 삭제는 계속 거부한다.

Release WASM의 곡선 회귀 6건, 실제 HWP fixture 삽입·삭제 1건, `release_stage3a_hwp_cubic_segment_reopens` T009 1건, ObjectSelectionFrame UI 31건, TypeScript typecheck, protected Tauri Release build가 PASS다. Linux X11/Xvfb + private IBus Native run11은 제어점·삽입·삭제, 삭제 Undo/Redo, synced save 및 독립 앱 재열기를 확인했다. 독립 CFB 검사는 저장마다 tag 83 level-3 leaf 하나만 바뀌고 좌표·command identity·unused command bytes·4-byte padding과 다른 stream/record가 유지됨을 확인했다. 상세 빌드·해시·출력은 [P4-H5-SEG 수락 기록](architecture/stage3-a-p4-hwp5-cubic-segment-acceptance.json)을 따른다.

Wayland/Windows/macOS, 외부 오피스 재열기와 준비된 RHWP 소스의 전체 upstream Cargo test suite는 NOT RUN/UNVERIFIED이며 PASS로 세지 않는다. 지원 범위 밖 curve record는 계속 fail-closed다.

### P4-H5-GROUP HWP5 그룹 자식 편집 (2026-11-22)

**CURRENT PASS — 명시한 평면 HWP5 범위.** RHWP ordered patch 47은 HWP5 최상위 body-owned `$con` 안의 직접 Rectangle/Ellipse 자식을 `(ctrl_id, inst_id)`와 부모 child-ID 순서로 확인한다. 완전한 원본 컴포넌트/채우기 모델, 고유 ID, 항등 부모·자식 행렬, 양수 치수와 부모 내부 좌표를 요구한다. 자식 이동, 검증 가능한 사각형 크기 변경과 지원 단색 채우기를 API/UI에서 수행한다. 중첩 컨테이너, caption/textbox/resource child, 미지원 채우기/레코드, 변환·회전·반전·잠금·모호한 주소는 fail-closed다.

Release WASM fixture test, synthetic HWP T009 증명, 실제 CFB Release T009 저장 증명과 독립 스트림/레코드 검사가 PASS다. Linux X11/Xvfb + private IBus Native run12는 실제 신뢰된 포인터로 자식 이동·사각형 resize, 타원 채우기 UI 편집, 각 변경의 Undo/Redo, synced save 및 독립 앱 재열기를 확인했다. 저장본은 `BodyText/Section0`과 preview `PrvImage`만 바뀌었고 HWP 레코드 identity/order는 동일하며, 실제 변경 record는 소유 사각형 SC와 잎, 타원 SC뿐이다. 부모 컨테이너·ID 표·형제 잎은 유지됐다. [P4-H5-GROUP 수락 기록](architecture/stage3-a-p4-hwp5-group-acceptance.json).

Wayland/Windows/macOS와 외부 한컴/Office 재열기, RHWP 전체 upstream test suite는 이 이슈에서 수락하지 않았다. Native CFB 결과·Release generation 및 지원 경계는 위 수락 JSON을 따른다.

### P4-DX-GROUP DOCX 그룹 자식 선택·편집 (2026-11-22)

**CURRENT PASS — 명시한 본문 그룹 범위.** WordCraft는 원본 `GroupChild` 계층을 유지하고, geul은 body 최상위 그룹의 직접 자식을 owner position/epoch와 child index/id/instId로 주소 지정한다. X11 Native에서 실제 그룹 선택 후 중첩 group 자식을 이동하고 크기를 변경했으며, 각 변경의 Undo/Redo를 확인했다. 저장·재열기 후 nested group 안의 사각형과 그림 관계, 바깥 sibling ellipse가 유지됐다. `word/document.xml`에는 예상한 group geometry만 반영됐고 relationship과 다른 9 OPC parts는 바이트 동일했다. T009는 `saved`, `synced=true`, `changedSince=false`, 빈 findings를 반환했다. 새 앱 프로세스에서 저장 DOCX를 다시 열어 계층과 geometry를 확인했다. [상세 수락 기록](architecture/stage3-a-p4-docx-group-acceptance.json).

편집은 보호되지 않고 tracked changes가 없는 본문 최상위 그룹, 원본 canvas 없는 항등 local axes와 일치하는 group/frame extent, 지원되는 단순 child transform 및 유한한 부모 내부 정수 EMU 좌표로 제한된다. 회전·반전·hidden·scaled axes, 잘못된 위치·크기, 미지원 원본 group member는 편집 가능 응답에서 제외하거나 변이 전 거부한다. frontend IPC parser는 exact-key bounded `groupChildren` payload를 요구한다. WordCraft `0a8dbc1`, geul fixture provenance `231cac6`, core integration `504d8de`, strict IPC regression 및 Native checker `74165f8`에서 구현됐다.

Linux X11/Xvfb + private IBus Hangul Native run은 PASS이며 cleanup manifest가 complete/proven/filesystemProven이고 survivor가 없음을 확인했다. Wayland, Windows, macOS 및 외부 Microsoft Office 재열기는 NOT RUN이다. 이 항목의 수락은 회전·배율 변환 그룹의 자식 편집을 뜻하지 않으며, 전체 P4/Stage 3-A는 다른 미완료 요구사항이 있어 계속 PARTIAL이다.

### P4-GROUP-XFM HWPX 변환 그룹 자식 안전 편집 (2026-11-22)

**CURRENT PASS — 명시한 HWPX 지원 범위.** geul/RHWP는 본문 그룹의 직접 Rectangle/Ellipse 자식에 대해 owner/child 주소를 검증하고, 양수 대각 scale 0.5/1/2의 좌표 역변환과 exact integer inverse resize를 지원한다. 변환 체인은 최대 64개의 항등행렬 또는 하나의 canonical scale pair로 제한한다. finite bounded integer translation은 보존하며 지원 범위 밖 행렬·객체는 변이 전에 fail-closed로 거부한다. 이동은 translation만 갱신하고 resize는 검증된 scale inverse를 적용한다.

Release compile 및 WASM 생성·bindgen PASS. 공식 공개 게시 시도는 6-generation retention guard에 의해 거부됐으며 공개 artifact는 변경되지 않았다. 로컬 immutable artifact identity/hash 검증 PASS. Scratch `cargo check --package rhwp --lib --offline` PASS. RHWP focused Cargo tests는 pinned test source의 기존 compile 오류(`DocumentCore::from_hwp_bytes/from_hwpx_bytes` 부재, `GroupShape`/`Picture` initializer 누락) 때문에 실행되지 않아 새 Rust unit test는 NOT RUN이다. Vitest focused group-transform 및 기존 flat-group move/resize는 2 PASS, 75 skipped다.

Linux X11/Xvfb + private IBus Hangul Native run-v8는 실제 그룹 자식 선택·이동·resize, Undo/Redo, T009 saved/synced/`changedSince=false`/빈 findings, 독립 XML/package 검사와 새 세션 재열기를 PASS했다. scale resize의 local size 6000×5000, 위치 변경 시 translation만 갱신, sibling과 다른 package parts의 불변성을 확인했다. 앱 SHA-256 `ff97c92318189a9065ec698a3d51ffca1f41f3e8167b81fbf3dda577b82e1f06`; Release generation `4484cc6839caa4c41af49532387a640ec0567f983954f6aca7755d905af82c89`, WASM `5289d7b150d38b53d19b1e464a6f3b0970bd2bb0f23f3c37bb97ceaf4eb9ce61`, JS `fe3942733de35ff18566b529e0a0a26589e4bd40a7f0990cb2e7bce7957cb334`. RHWP pin은 `1a76570e833917d15817415a53c09ad61ab3203f`로 유지했고 ordered patch SHA-256은 `153622fa53a530aacba4ab5fa9ac5e8e9f23a7afc9a31dbb9e6748de256be64c`다. geul 구현 커밋은 `c3c4e5934639859c5de0e5568314d96a3d9f7fb9`다. 상세 evidence 및 정확한 경계는 [P4-GROUP-XFM 수락 기록](architecture/stage3-a-p4-group-transform-acceptance.json)을 따른다.

HWP5/DOCX에서 새 비항등 변환 지원을 주장하지 않는다. Wayland, Windows, macOS, 외부 Office 및 Release portability는 NOT RUN/UNVERIFIED다. 전체 P4/Stage 3-A는 다른 미완료 요구사항이 있어 PARTIAL이다.

### P4-HX-NEST HWPX 중첩 그룹 자식 편집 (2026-11-22)

**CURRENT PASS — 정규 local translation 지원 범위.** RHWP는 안정된 재귀 컨테이너 경로(index/id/instId)로 중첩 Rectangle/Ellipse 자식을 찾아 편집한다. 중첩 container 프레임은 항등 scale·회전·반전을 요구한다. 각 부모 프레임의 정수 local translation을 합성해 표시 좌표를 만들고, 저장할 때 주소된 부모의 좌표계로 역변환한다. 별도로 저장된 HWPX `id`/`instid`, `groupLevel`, child order를 보존한다. 비정규 변환, 미지원 child, 잘못되거나 오래된 주소, 부모 범위를 벗어난 요청은 변이 전에 fail-closed로 거부한다.

집중 Vitest의 P4-HX-NEST와 P4-GROUP-XFM 2건 PASS, TypeScript typecheck PASS, RHWP Release Cargo/WASM compile 및 scratch `cargo check --package rhwp --lib --offline` PASS다. 기존 공개 RHWP generation 유지 한도 때문에 공개 selector 갱신은 거부됐으며 공개 파일은 바뀌지 않았다. 검증은 정확한 49-patch ordered series로 Release를 재빌드했으며, 소스 트리 SHA-256 `46ebf1f5723f051efe4b79c4b362167218835d140f6586abe522e750afcc5ff7`, JS `0d5300276a71ea01db94ffbf8a4aa45e3b285dddbe0c053f82e28b093df8f986`, WASM `bc64940da830c399b80e194de359c0785626a3cdaeb81fc88aac5168eac29ab6`이다. 공개 selector와 assets는 그대로 두고 immutable local generation `030e51455535fc0d45294e6937e0328028c1dc557d7519a0e6d2087272b2533a`으로 검증했다. [통합·저장 수락 기록](architecture/stage3-a-p4-nested-group-acceptance.json).

geul 구현 commit `4b337fc114a6822378287f9393a5a686b0c837d1`; 최종 patch SHA-256 `5f78cc9a2b5f1160191fe0f7993d2bfe4741569c51bce842bc16ab080e116b04`. `npm run typecheck`, scratch Cargo check, Python syntax와 diff checks PASS. Tauri Release 앱 SHA-256 `721e88029d0054d43c272403a7c0f8989b05bcf163ccdf7f297835c017b52f5f`; runtimePath/privacy PASS, portability NOT VERIFIED. Linux X11/Xvfb + private IBus Hangul Native PASS: 신뢰된 포인터·키보드 입력으로 중첩 자식을 이동·크기 변경하고 각각 Undo/Redo했다. T009 저장은 `saved`, `synced=true`, `changedSince=false`, 빈 findings를 반환했다. 저장 XML에서 outer/inner ID·instID와 groupLevel, 중첩 잎의 위치·치수 및 변경하지 않은 형제들을 검사하고 다른 HWPX package entries를 대조했다. 새 앱 프로세스로 재열기한 뒤 ready/clean session과 편집 좌표를 확인했다. 이 exact app/generation의 결과 파일은 `target/p4-hx-nest-work/native-run-normalized/result.json`이다. Wayland/Windows/macOS와 외부 HWP 편집기 재열기는 NOT RUN이다.

### P4-PATH-XFM DOCX/HWP5/HWPX 변환 경로 점 편집 안전화 (2026-11-22)

**CURRENT PASS — 좁게 검증한 지원 범위.** `pathOverlayGeometry`는 회전된 보이는 선택 프레임의 중심에 원래 path frame을 놓고, `pathPointFromClientDelta`는 화면 pointer delta에 rotation·flip의 역행렬을 적용한 뒤 path viewport 정수 좌표로 반올림한다. DOCX는 top-level custom DrawingML path의 modeled `quadBezTo`/`cubicBezTo` control point를 대상으로 finite rotation `[-360°, 360°]`와 modeled flips를 허용한다. RHWP는 HWP5 Section0 cubic, HWPX body polygon으로 확인했다. HWP5는 local file version 1, original/current 크기 일치, bounded component/owner offsets, ±360° rotation과 비정수 회전 시 exact center, modeled flip bits 및 항등 raw matrices만 허용한다. HWPX는 제한된 offset/rotation/flip과 항등 raw rendering matrices만 허용한다. HWP5 polygon은 component offset 0으로 한정한다. 미지원 행렬·그룹 소유 경로·Ink·미지원 DrawingML metadata·변환 path segment 삽입/삭제는 여전히 fail-closed다.

focused transform helper 4건, `ObjectSelectionFrame` 32건, `npm run typecheck`, DOCX Rust T009 proof 1건, transformed HWP5 cubic Release T009 proof 1건, Release WASM의 HWPX/HWP5 transformed fixture 2건 PASS다(해당 Vitest 실행의 나머지 77건은 선택되지 않아 skip). 정확한 pinned RHWP `1a76570e833917d15817415a53c09ad61ab3203f`에 기존 ordered 49 patches를 적용해 만든 Release generation은 `1ed02bea67181e5d9098e5249ed8f740e08fbbfe9aa8a5f7301354ae69164225`, WASM SHA-256 `2532c1c298325174bb8184c268e2deff0717dd5c9dc5e4d78dd415e047443b6b`, JS SHA-256 `0d5300276a71ea01db94ffbf8a4aa45e3b285dddbe0c053f82e28b093df8f986`다. 새 public RHWP artifact는 교체하지 않았다. Tauri Release 앱 SHA-256은 세 Native 결과에서 `fd28796771bb51d1b7120866f29e0fd936df7c4f181a81ad39f1a864ac701115`로 일치한다.

Linux X11/Xvfb Native에서 세 형식의 실제 trusted pointer와 Undo/Redo, T009 `saved/synced/changedSince=false`, 저장 파일의 독립 검사를 수행하고 새 앱 세션에서 다시 열었다. HWP5 (`target/p4-path-xfm-work/native-out-v3/result.json`)는 transformed cubic 경로의 tag 83, level 3, 79-byte 단일 leaf만 같은 record index 17에서 바뀌었다. 인접 record와 preview 외 CFB streams는 유지했고 preview를 갱신했다. HWPX (`native-out-v6/result.json`)는 지정된 `Contents/section0.xml` 외 모든 package part가 동일하며 transform·offset과 path 좌표를 보존했다. DOCX (`native-out-docx-v8/result.json`)은 현재 Release app에서 PASS했고 지정 control point 외 `word/document.xml`, 관계, 다른 8 package parts를 보존했다. 각 X11 launcher cleanup manifest는 complete/proven/filesystemProven이며 survivor가 없다. 해당 세션/fixture·저장 해시와 필드 단위 결과는 [수락 JSON](architecture/stage3-a-p4-path-transform-acceptance.json)에 있다.

geul 구현·수락 커밋은 `d243398271bdd194880a11595a875cc7af9a87ba`다. Wayland, Windows/macOS, 외부 Microsoft Word·한컴 재열기, Release portability는 NOT RUN/UNVERIFIED다. 현재 P4 전체는 `P4-HX-CURVE`의 Bezier 제어점·segment contract가 해결되지 않아 PARTIAL이다.
