# RHWP 일반 글자 서식 — 2026-11-12

## 현재 구현 범위

제품 일반 빌드에서 HWP와 HWPX 선택 텍스트에 `format.bold`, `format.italic`, `format.underline`, `format.strikethrough`를 연결한다. 테스트 활성화 환경 변수는 필요하지 않다. 단축키 Ctrl/Cmd+B, Ctrl/Cmd+I, Ctrl/Cmd+U와 기존 취소선 리본 동작을 유지한다. DOCX는 기존 WordCraft 경로를 사용한다.

서식 상태와 실행 가능성은 현재 RHWP 세션의 capability snapshot 및 실행 시 검증에 연결된다. 실제 형식, 편집 가능성, 선택 범위, 활성 composition, 대기/불확실 변경, history, 엔진 API 및 문서의 원본 안전성 증명이 필요하다. HWP는 로드 시점에 기록한 불변 자격 증명을 사용해 일반 입력으로 원본 raw stream이 지워져도 보수적 판정을 유지한다. 편집/실행/게시 중 세션·generation이 바뀌거나 composition, pending mutation, 잘못된/낡은 선택이 있으면 명령을 거부한다.

## 선택과 토글 규칙

- 선택 범위는 같은 본문 section 안의 텍스트 또는 같은 table cell 안의 텍스트다. 지원되는 범위에는 여러 문단 선택이 포함된다. 접힌 caret 선택은 지원하지 않는다.
- section을 가로지르는 선택, 서로 다른 cell, field/object 등 텍스트 좌표로 안전하게 표현할 수 없는 문맥과 알 수 없는 원본 body record는 지원하지 않는다. capability는 이를 사용 가능하다고 표시하지 않는다.
- 선택된 모든 문자가 해당 flag를 가지고 있을 때만 토글이 끈다. 하나라도 꺼져 있으면 지원되는 전체 선택에 적용한다. 이미 켜진 문자 모양은 건너뛰어 underline/strike의 기존 variant 및 다른 속성을 보존한다.
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
