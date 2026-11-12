# RHWP 일반 글자 서식 — 2026-11-12

## 현재 구현 범위

제품 일반 빌드에서 HWP와 HWPX 선택 텍스트에 `format.bold`, `format.italic`, `format.underline`, `format.strikethrough`를 연결한다. 테스트 활성화 환경 변수는 필요하지 않다. 단축키 Ctrl/Cmd+B, Ctrl/Cmd+I, Ctrl/Cmd+U와 기존 취소선 리본 동작을 유지한다. DOCX는 기존 WordCraft 경로를 사용한다.

서식 상태와 실행 가능성은 현재 RHWP 세션의 capability snapshot 및 실행 시 검증에 연결된다. 실제 형식, 편집 가능성, 선택 범위, 활성 composition, 대기/불확실 변경, history, 엔진 API 및 문서의 원본 안전성 증명이 필요하다. HWP는 로드 시점에 기록한 불변 자격 증명을 사용해 일반 입력으로 원본 raw stream이 지워져도 보수적 판정을 유지한다. 편집/실행/게시 중 세션·generation이 바뀌거나 composition, pending mutation, 잘못된/낡은 선택이 있으면 명령을 거부한다.

## 선택과 토글 규칙

- 선택 범위는 같은 본문 section 안의 텍스트 또는 같은 table cell 안의 텍스트다. 지원되는 범위에는 여러 문단 선택이 포함된다. 접힌 caret 선택은 지원하지 않는다.
- section을 가로지르는 선택, 서로 다른 cell, field/object 등 텍스트 좌표로 안전하게 표현할 수 없는 문맥과 알 수 없는 원본 body record는 지원하지 않는다. capability는 이를 사용 가능하다고 표시하지 않는다.
- 선택된 모든 문자가 해당 flag를 가지고 있을 때만 토글이 끈다. 하나라도 꺼져 있으면 지원되는 전체 선택에 적용한다. 한 번의 native 범위 변경에서 이미 켜진 underline/strike variant와 다른 속성을 보존하며, 개별 문자를 건너뛰기 위해 여러 번 호출하지 않는다.
- cursor와 selection을 유지하며 선택 밖 문자는 수정하지 않는다. 표 셀 범위도 cell 로컬로 제한한다.

## 저장 보존 경계

HWPX는 기존 character-shape append/publish 경로와 원본 구조 보존·재열기 검증을 사용한다. HWP는 DocInfo 글자 모양을 뒤에 추가하고, 실제 본문 참조와 ID/count 및 metric/flag 변경을 증명한다. 원래 DocInfo의 다른 바이트와 알 수 없는 record는 보존한다. ID 충돌, 잘못된 참조, 직렬화 불가 원본 글자 모양은 실패 폐쇄한다.

HWP 자격 증명은 original SAFE preflight, 완전한 HWP 모델, Section0 및 `canFormatCharacters` 시점의 원본 증거를 결합한다. 직렬화 가능한 원본 char-shape 정의와 이해 가능한 body record만 허용한다. 이전 68/70-byte shape 또는 기타 lossless하게 재구성할 수 없는 shape, 비어 있지 않은 PARA_RANGE_TAG, opaque body record가 있는 원본은 서식을 거부한다. 이는 이미 타이핑해 section raw stream이 비워진 뒤에도 로드 epoch의 원본 증거로 적용된다.

저장 시 T009 original preflight, 구조/내용 손실 검사, 출력 재열기 비교, conflict 검사, safe publication, atomic replacement, durability/recovery 경계는 그대로 적용한다. HWP PrvText/PrvImage는 기존 검증된 original/reopened-export 처리와 실제 출력 identity에 맞춘 미리보기 복원 경로를 사용한다. 제품 `capturePreviewRaster`는 정확한 내보내기 바이트를 다시 연 문서의 1쪽을 별도 Canvas에 그려 raster를 캡처한다. focused 시험은 독립 raster 증거로 정확한 RHWP SVG를 librsvg로 렌더링해 사용하며, 이 결과는 제품 Canvas 또는 native GUI에서 캡처했다는 뜻이 아니다. HWP 미리보기 재생성이 필요한 저장에서 raster가 없거나 미리보기가 낡았거나 출력이 malformed면 원본을 유지하고 저장을 거부한다. HWPX에는 HWP preview raster 요구가 없다. 이전 진단에서 별도 emoji-generated PrvText의 original preflight가 거부된 호환성 제한이 확인됐으며 이 검사는 완화하지 않았다.

## History, IME, 자원 수명

각 성공 서식 작업은 기존 `RhwpHistory`의 단일 논리 변경이다. 관련 history 경계를 분리하고 선택/caret을 복원하며, Undo/Redo에서 서식과 publication prefix를 맞춘다. history rollback은 before state를 복원한다. 보조 rollback도 실패하면 uncertain state를 freeze하고 저장을 거부한다. 실패를 성공 history/revision으로 기록하지 않는다. 새로운 변경은 redo를 무효화한다. 세션 전환과 generation 변경은 stale 결과 적용을 막는다.

미완성 한국어 IME 조합은 암묵적으로 commit하지 않는다. composition, queued 입력, 불확실한 history transaction 중에는 서식을 거부하고 문서를 건드리지 않는다. 글자 모양 정의는 엔진의 소유권·snapshot·append publication·compaction 흐름을 재사용하며 별도 history나 formatting engine을 만들지 않는다.

## 단계 1–4 focused 증거 (2026-11-12)

실제 Release RHWP WASM을 통해 HWP/HWPX 각 서식 네 종류 및 반복 사례 총 10개를 생성하고, save service에서 실제 파일을 게시한 뒤 독립 재열기 검사로 결과를 확인했다. HWP 미리보기는 새 raster를 검증하고, malformed/stale preview 및 malformed export 거부 시 원본 보존도 확인했다. 추가 negative source fixture는 opaque body/range-tag eligibility 거부를 검증한다. 이 focused 근거는 전체 Stage 5 acceptance가 아니다.

| 단계 | 상태 |
|---|---|
| 1 — HWPX production formatting | 구현 및 focused checks 완료 |
| 2 — HWP DocInfo/preview preservation | 지원 문서의 실제 save/reopen 및 fail-closed checks 완료 |
| 3 — HWP production formatting | 구현 및 focused checks 완료 |
| 4 — shared selection/history/IME integration | 구현 및 focused checks 완료 |
| 5 — full integration acceptance | 미실행 |
| 6 — native Tauri/product acceptance | 미실행 |

핵심 변경 파일과 함수:

- `src/commands/registry.ts`, `capability.ts`, `commands.test.ts`: 제품 지원 선언, pending/saving 상태 거부 및 레지스트리 회귀 검사.
- `src/components/Editor/rhwp/RhwpEditorSession.ts`, `rhwpText.ts`, `rhwpModule.ts`: `formatState()`/`applyFormat()`, `formatSelection()`/`prepareFlag()`, `canFormatCharacters` 인터페이스와 로드 세대 소유권.
- `src-tauri/src/services/save/hwp.rs`, `tests.rs`: `derived_char_shape`, 기존 DocInfo append 증명 확장, 실제 게시·미리보기 재생성·손상 출력 거부 검사.
- `patches/rhwp/general-formatting-eligibility.patch`, `scripts/rhwp-patches.py`: 읽기 전용 원본 자격 API와 관리 패치 등록.
- `scripts/rhwp-artifacts.py`, `rhwpArtifactIdentity.ts`, `scripts/tests/rhwpAssets.test.ts`: 패치 17개 신원 검증과 상한 회귀 검사.
- `scripts/tests/general-formatting.wasm.test.ts`: 실제 엔진 명령·상태·렌더링·저장 출력·게시 파일 재열기 검사.
- 설계 문서 3개와 계획 문서 3개에는 현재 구현 상태를 연결하는 addendum을 추가했다.

명령 dispatch(`commands.ts`), 기존 단축키(`shortcuts.ts`), `RhwpHistory`, 미리보기 캡처·재구성 및 WASM 빌드 스크립트는 기존 경로를 재사용한다.

Release proof의 generation은 `eb3aaadce87dc108e9b4b8d501581463b7e6b23863c00b4aac321a6255c85618`이며 10개 case proof가 같은 generation을 사용했다. 빌드 신원은 JS `448b561f679417fb860e50e41f8532b2762006e82f2a80d70cb6f3fee6274cc3`, WASM `79e1f0fbdb8266e787dfab52cc0941bb18a6ff400276b8e14f9589a371489b87`이다. 실제 빌드 명령은 `python3 scripts/build-rhwp-wasm.py`다. 실행 환경에서는 생성 identity에 맞는 `wasm-bindgen 0.2.127` 바이너리 디렉터리를 `PATH` 앞에 추가했다. RHWP pin `1a76570e833917d15817415a53c09ad61ab3203f`, WordCraft pin `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5`는 그대로다. 파일 게시를 포함한 Rust 검증에는 `GEUL_SANDBOX=userns-root-bwrap`을 사용했다. 기본 bwrap 경로는 root-owned ancestors가 UID 65534로 보이는 환경이라 T009가 올바르게 거부했다. 지원 namespace-root 모드에서 Rust publication/HWP 회귀가 통과했다. 패치 17 및 schema bound 17.

실행한 focused 명령과 결과:

| 실행 | 결과 |
|---|---:|
| `GEUL_FORMAT_PHASE=seed npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/general-formatting.wasm.test.ts` | 1 통과, 8 skip |
| `GEUL_SANDBOX=userns-root-bwrap GEUL_FORMAT_DIR=$PWD/src-tauri/target/general-formatting python3 scripts/cargo-geul.py test --lib general_formatting_seed_preview -- --ignored` | 1 통과 |
| `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/general-formatting.wasm.test.ts` | 7 통과, 2 skip |
| `GEUL_SANDBOX=userns-root-bwrap GEUL_FORMAT_DIR=$PWD/src-tauri/target/general-formatting python3 scripts/cargo-geul.py test --lib general_formatting_real_publication -- --ignored` | 1 통과, 실제 10개 case 게시 |
| `GEUL_FORMAT_PHASE=verify npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/general-formatting.wasm.test.ts` | 1 통과, 8 skip |
| `npx vitest run src/commands/commands.test.ts src/commands/imeBoundary.test.tsx src/commands/imeGap.test.tsx src/commands/history.test.tsx src/components/Editor/rhwp/rhwpHistory.test.ts src/components/Editor/rhwp/historyAdmission.test.ts src/components/Editor/rhwp/nativeImeOrder.test.tsx src/components/Editor/rhwp/previewRaster.test.ts src/components/Editor/rhwp/repaintScheduling.test.tsx src/components/Editor/rhwp/publicationIdentity.test.ts src/components/Editor/rhwp/prefixCleanup.test.ts src/components/Editor/rhwp/prefixInitialization.test.ts src/commands/hangulTools.test.tsx` | 13 files, 230 통과 |
| `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --lib hwp_` | 36 통과, 10 ignored |
| `npx vitest run --config scripts/tests/vitest.config.ts --maxWorkers=1 scripts/tests/advanced-production.wasm.test.ts scripts/tests/hwp-preview-capture.wasm.test.ts scripts/tests/rhwpAssets.test.ts` | 3 files, 22 통과 |
| `npm run build` | PASS (`tsc --noEmit` 포함, normal production build) |
| `npx eslint src/commands/registry.ts src/commands/capability.ts src/commands/commands.test.ts src/components/Editor/rhwp/RhwpEditorSession.ts src/components/Editor/rhwp/rhwpText.ts src/components/Editor/rhwp/rhwpModule.ts src/components/Editor/rhwp/rhwpArtifactIdentity.ts scripts/tests/general-formatting.wasm.test.ts` | PASS |
| `python3 -m unittest discover -s scripts/tests -p test_rhwp_profiles.py` | 3 통과 |
| `npm run lint` | PASS |
| `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py fmt --check` | PASS |
| `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py check --lib --bins` | PASS |
| `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py clippy --lib --bins -- -D warnings` | PASS |

이 증거는 focused implementation/regression/save 검증이다. full Stage 5 통합 acceptance, Stage 6 native Tauri/GUI acceptance, 실제 한컴/Word 호환성 판정은 수행하지 않았다. 릴리스 GO 판정이 아니다.


## Formatting hardening A–C — 2026-11-13

A는 `getFormattingRuns` native API로 선택 구간의 scalar 경계와 UTF-16 control-slot 배치를 실제 문서 모델에서 확인하고, 글꼴·언어 JSON 없이 연속 flag 구간만 반환한다. 기존 477개 API와 각 인자 수를 유지하고 읽기 전용 메서드 하나만 추가했다. B는 현재 epoch/model/selection에 귀속된 증명을 실행 단계에서 재사용하고 문단마다 한 번만 변경한 뒤 한 차례 compaction한다. 회귀 corpus는 본문과 셀에서 네 flag, 여러 문단, 빈 문단, 역방향 selection, supplementary Unicode, 선택 밖 속성, Undo/Redo, 이후 native 실패 뒤 rollback/uncertain freeze를 확인한다. C는 clipboard 추출과 별도로 native 증명에서 선택 범위 안의 object slot만 거부한다. object에 닿기 전후의 텍스트와 다른 문단/셀은 허용하고 slot을 가로지르면 거부하며, HWPX 인접 셀 그림도 유지한다.

현재 Release generation은 `c51dd0fe7fcf845cfe2b1e0c67400606babf65888279a1ebe0c722d15be3a101`이다. JS SHA-256은 `436cd46b94def9d95d1d6b33eafb7586df60a1bcae9f44adcbd4564ffeb1b577`, WASM SHA-256은 `ee44446b64ac65d096ed5849d2d134feafb4ec7085c6eae080a33d855b8a0649`이다. 새 20-case positive corpus의 실제 save-service publication과 게시 파일 fresh-engine reopen이 모두 통과했다. 여덟 HWP case는 새 preview를 만들었고, 인접-object HWP case 두 개는 기존에 허용된 known-blank preview 예외를 별도로 증명했다. 이는 모든 HWP 원본을 허용한다는 뜻이 아니다.

동일한 Release engine과 여덟 개 동일 source/state 조합에서 분석 시 개별 character-property 읽기가 10,000회에서 0회로 줄었고, 단일 문단은 batch 1회, 20문단은 batch 20회였다. 10,000자 분석 시간은 이전 207.9–320.5 ms에서 새 경로 0.21–0.86 ms였다. 별도 짝지은 16자 adapter 측정 60개에서 median은 0.4745 ms에서 0.0153 ms, p95는 0.6049 ms에서 0.0368 ms였다. 이는 선택 분석 경로의 측정이며 전체 편집 지연 보장이 아니다. 20문단 적용과 제거에는 렌더링을 포함해 약 0.38–0.41초가 걸렸다.

추가 hardening 24건과 기존 production 7건은 앞서 통과한 결과를 재사용했다. 최종 검증은 20건 publication 및 fresh reopen, focused frontend 230건, production WASM 22건, Rust HWP 36건(pass; 10 ignored), Python profile 3건, normal build, lint, Rust fmt/check/clippy를 통과했다. 상세 로그는 ignored evidence 경로 `src-tauri/target/general-formatting-hardening/final-checks/`에 있다. corpus와 benchmark JSON은 `src-tauri/target/general-formatting-hardening/`에 있다. 앞 절의 10-case 기록은 당시 실행된 역사적 증거로 보존한다. 이 A–C hardening 결과는 Stage 5/6 native acceptance 또는 릴리스 승인으로 확대하지 않는다.


## Stage 5/6 native acceptance addendum — 2026-11-13

앞 절의 단계 표("5/6 미실행")와 focused/hardening 기록은 당시 상태로 보존한다. 이 addendum이 Stage 5/6의 현재 상태다.

**범위.** HWP 한 번, HWPX 한 번의 연속 native GUI 시나리오. 내부 알고리즘·저장 보존·부분 실패·성능 증거(20-case publication/reopen, frontend 230, WASM 22, Rust HWP 36, hardening 24, production 7)는 다시 실행하지 않고 identity로 재사용했다: HEAD `89a0fa2`, worktree의 `src`/`src-tauri`/`public`/`patches` diff 없음, RHWP pin `1a76570e`, WordCraft pin `dc25d8a2`, Release generation `c51dd0fe7fcf845cfe2b1e0c67400606babf65888279a1ebe0c722d15be3a101`(JS `436cd46b…`, WASM `ee44446b…`)이 A–C 기록과 같고 WASM은 다시 빌드하지 않았다.

**환경.** Linux x86_64(kernel 7.2.14), WebKitGTK 2.54.1, Tauri 2 debug profile 일반 제품 빌드(`npm run build`, `python3 scripts/rhwp-artifacts.py --verify-product dist/rhwp --profile release`, `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py build --bin geul --features tauri/custom-protocol`), 앱 SHA-256 `b974a28a2d03bbee13ccb5297186b64dc6261199e9ffa13d8689048c90f4ecf8`, origin `tauri://localhost`. `VITE_GEUL_TEST_*` 없음(frontend-build `testFlags: {}`, 실행 프로세스 환경 확인), test hook/trace 없음, 앱이 제공한 frontend asset과 RHWP artifact hash가 빌드 증거·Release와 일치. 입력은 test-owned 비공개 X11(Xvfb 1440x1000) + D-Bus + IBus 1.5.33 + ibus-hangul 1.5.5 세션(`scripts/tests/native-ibus-session.py --hangul-initial-mode hangul`)의 xdotool 키보드/포인터와 GTK 파일 선택기다. WebDriver(tauri-driver)는 DOM 속성, 쪽 Canvas, 스크린샷 관찰과 열기 경로 양식 제출에만 썼다. 물리 디스플레이/Wayland 세션, 사용자 IBus 설정은 사용하지 않았다.

**시나리오**(`scripts/tests/native-formatting-acceptance.py`, 문서는 `tests/fixtures/rhwp/generate.mjs`가 만든 `basic-ko.hwp`/`.hwpx`의 일회용 사본): 열기 → 편집 가능·caret만 있을 때 네 명령 비활성 확인 → IBus 한글 `dkssud` → "안녕" 확정 → 그 글자를 선택해 Ctrl+B → Ctrl+I, Ctrl+U → 리본 취소선 → 둘째 문단 "Bold"에 리본 굵게/기울임/밑줄 → 표 셀 "Cell two"의 "Cell"에 Ctrl+B → Ctrl+Z → Ctrl+S → Ctrl+Y → Ctrl+S → 탭 닫기 → Ctrl+O native 선택기로 재열기 → 재열린 문서에서 선택별 리본 상태 확인. 서식 8회마다 revision +1, 선택 유지, 리본 pressed 상태, Canvas 픽셀 변화를 확인했다. Undo 뒤 Canvas는 서식 전과, Redo 뒤 Canvas는 서식 후와 같았다.

**저장 파일 증거.** 제품이 저장한 실제 파일을 앱 밖에서 hash 검증된 Release runtime으로 열어(`scripts/tests/rhwp-char-flags.mjs`) 모든 본문·셀 문단의 글자와 글자별 bold/italic/underline/strikethrough를 기대값과 정확히 비교했다. Undo 저장본은 셀 서식이 없고, 최종 저장본은 `안녕`=B, `문단`=I, `입니다`=U, `Korean`=S, `Bold`=BIU, 셀 `Cell`=B이며 기존 `굵은 글씨` 굵게를 포함한 나머지 글자와 다른 셀은 변하지 않았다. 텍스트는 `안녕한글 문단입니다. Korean paragraph.`로 손실·중복이 없다. 재열기 세션은 revision 0/clean이고 저장 파일과 원본 fixture 바이트는 그대로였다.

| 항목 | HWP | HWPX |
|---|---|---|
| 네 서식 명령(단축키 B/I/U, 리본 B/I/U/S) | PASS | PASS |
| 일반 텍스트·표 셀 선택, 인접 글자 불변 | PASS | PASS |
| Undo/Redo(Ctrl+Z/Ctrl+Y, Canvas·저장 파일) | PASS | PASS |
| 실제 한국어 IME(IBus hangul, trusted composition) | PASS | PASS |
| GUI 저장(2회, HWP는 preview 재생성 포함) | PASS | PASS |
| 닫기 → native 재열기 후 글자·서식 보존 | PASS | PASS |
| 검사 수 | 54/54 | 54/54 |

실행: `python3 scripts/tests/native-ibus-session.py --hangul-initial-mode hangul --out <E>/run3-session -- python3 scripts/tests/native-formatting-acceptance.py --app <abs>/src-tauri/target/debug/geul --app-sha256 <sha> --driver <tauri-driver> --out <E>/run3 --xdotool @XDOTOOL@ --ibus @IBUS@`, `<E>` = ignored `src-tauri/target/general-formatting-native/`. 결과 `run3/result.json`(SHA-256 `f5f2e7850099ec38c485eddd99bdbfcd4e375ff235bf96ff5fe73904ada5858b`), launcher 정리 `run3-session/cleanup.json`(`proven`/`filesystemProven` true, 생존 프로세스 없음, SHA-256 `009e53c3…`), 스크린샷 10장과 저장본 4개가 같은 디렉터리에 있다. 앞선 두 실행은 하네스/환경 문제로 FAIL했고 제품 결함이 아니다: run1은 상대 `--out` 경로를 앱이 올바르게 거부, run2는 비공개 ibus-hangul이 기본 Latin 모드라 한글이 조합되지 않아 IME 검사가 FAIL. 제품 코드 수정은 없었다.

**한계.** 승인 범위는 위 Linux/X11(Xvfb)/WebKitGTK/IBus-hangul 환경, debug profile 실행 파일, 생성된 `basic-ko` 두 문서에 한정한다. Windows/macOS, Wayland native 세션, 다른 IME(fcitx 등), 패키지된 release 번들, 한컴오피스/MS Word로 연 결과, 일반 문서 corpus는 시험하지 않았다. 취소선은 제품에 단축키가 없어 리본으로만 확인했다. T014(내구성/플랫폼), T015(corpus/외부 호환), T016(패키징/릴리스)은 별도이며 이 결과로 완료되지 않는다.

| 단계 | 상태 | 근거 |
|---|---|---|
| 5 — full integration acceptance | COMPLETED | 일반 빌드 한 세션에서 IME 입력·선택·네 서식·표 셀·history·저장 서비스·재열기가 함께 동작하고 저장 파일 글자 속성이 정확함 |
| 6 — native Tauri/product acceptance | COMPLETED | 같은 흐름을 실제 Tauri 창에서 native 키보드/포인터/IBus/GTK 선택기만으로 수행, test flag·hook 없음 |

지원 native 환경(위 범위) 판정: GO.
