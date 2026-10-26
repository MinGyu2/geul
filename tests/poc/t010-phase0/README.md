# T010 Phase 0 PoC — rhwp 실행 취소·글자 서식·T009 저장 실증

시험 전용 코드다. 제품 코드·T009 규칙·submodule은 바꾸지 않는다. 기본 시험(`npm test`, `cargo test`)에는 들어가지 않는다:
Vitest는 별도 설정, Rust 시험은 `#[ignore]`이고 환경 변수가 없으면 실패한다(실행 0건을 통과로 보지 않음).

## 고정 엔진과 픽스처

- rhwp: submodule `external/rhwp` `1a76570`(v0.8.7). WASM은 `public/rhwp/`(`BUILD.json` `commit`이 같은 값). WordCraft는 쓰지 않는다.
- 픽스처: `tests/fixtures/rhwp/generate.mjs`가 매번 만든다(저장소에 바이너리 없음). 같은 WASM이면 바이트가 같다(2회 생성 비교):
  - `basic-ko.hwp` SHA-256 `57c901cc394abf6f58f4838315d1ea2c5ecf8a03d9934d3fc098fd8be6e6e12f`
  - `basic-ko.hwpx` SHA-256 `26d434b7b427149110751c6ef5b19e9ecb4818f3ba7eadfe201b5afd3de442a8`
  - 둘 다 편집 없는 사전 검사가 `safe`(실제 `service::preflight`).
- 큰 실제 문서(성능 G): 비공개 로컬 문서 둘(크기만 기록). 저장소에서 재현할 수 없다.

## 실행

모두 저장소 뿌리에서. `TMPDIR`은 쓰기 가능한 임시 디렉터리(기본 `/tmp`가 막힌 환경 대비). 출력은 그 아래 임시 디렉터리에만 쓰고 끝나면 지운다.

| 명령 | 내용 | 엔진 |
|------|------|------|
| `TMPDIR=… python3 tests/poc/t010-phase0/save_service.py --evidence tests/poc/t010-phase0/evidence/save-service.json` | Stage A·B: 진짜 서식 출력을 `SessionRegistry` → `service::preflight` → `record_preflight` → `commit` → `begin_save` → `service::save`에 넣고, 원본 사본 SHA-256·디렉터리 목록을 저장 전후 비교. Stage B 참조 공백 사본 | 진짜 WASM + 진짜 저장 서비스(`src-tauri/tests/t010_phase0_save_service.rs`) |
| `TMPDIR=… python3 tests/poc/t010-phase0/check.py --out <JSON>` | Phase 0 A·B·D·E·F·G(`rhwp_phase0.mjs`) + `save_check` 판정 | 진짜 WASM + 진짜 판정 함수 |
| `npx vitest run --config tests/poc/t010-phase0/vitest.config.ts` | Phase 0 C(`lifecycle.poc.test.ts` 9개): 세션 편집·조합 수명주기. Phase 1(`typing_groups.poc.test.ts` 13개): 타자 그룹과 백엔드 확정의 분리 — 세션을 바꾸지 않고 시험용 문서 감싸개가 기록 모델에 트랜잭션 시작을 알림(세션 메서드 호출, 입력기 아님, 제품 통합 아님) | 진짜 WASM, 백엔드 시험 응답 |
| `TMPDIR=… node tests/poc/t010-phase0/history_boundary.mjs [--out evidence/history-boundary.json]` | Phase 1 기록 경계 18개: 고친 알고리즘(`history_model.mjs`)의 용량·보호·거부·실패 주입·이전 설계 반례(실제 WASM 13개), 무작위 불변식(흉내 엔진 4개 — 엔진 증거 아님), 깊이 식 산술 1개 | 진짜 WASM 스냅숏 + 흉내 엔진 |

| `TMPDIR=… python3 tests/poc/t010-phase0/selfclosing.py --evidence tests/poc/t010-phase0/evidence/selfclosing.json` | T009 2차 고침: HWPX 자기 닫힘 `charPr`·`paraPr` 정의를 엔진이 등록하는지(실측)와 판정·실제 저장의 해석이 같은지 | 진짜 WASM + 진짜 판정·저장 서비스 |
| `TMPDIR=… node tests/poc/t010-phase0/snapshot_side_effects.mjs [--out evidence/snapshot-side-effects.json]` | Phase 2 선행 B1: `saveSnapshot`(찍기 전 `flush_cell_format_vpos`)이 표 셀 서식 상태에서 관찰 가능한 상태·내보내기·T009 판정을 바꾸는지 | 진짜 WASM + `save_check` |
| (위 Vitest 설정) `checkpoint.poc.test.ts` | Phase 2 선행 B2: 구조 편집·복원을 지난 커서·선택 체크포인트의 정확·대체 계약 | 진짜 WASM + 제품 `RhwpText` |

Phase 2 안정화(2026-10-22 2차): `tests/integration/rhwp/multisection.wasm.test.ts`(여러 구역 쪽 계약, 실제 WASM), `src/components/Editor/rhwp/
historyFocus.test.ts`(초점 경계), 이 디렉터리의 `checkpoint.poc.test.ts`(이제 제품 체크포인트 함수), `tests/integration/rhwp/undo_native.py`(시험 활성화 빌드 —
`VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1` — 의 실제 앱 그리기·ibus-hangul·성능 관문). 주의: `cargo test`는 `target/debug/geul`을 개발 서버용
빌드로 다시 만든다 — 네이티브 시험 전에 `npm run tauri build -- --debug --no-bundle`로 다시 빌드한다.

Phase 2 제품 기록의 시험은 `src/components/Editor/rhwp/rhwpHistory.test.ts`(기본 `npm test`), `tests/integration/rhwp/undo.wasm.test.ts`·
`history-perf.wasm.test.ts`(`npx vitest run --config tests/integration/rhwp/vitest.config.ts`, 성능은 `GEUL_PERF=1`), `tests/integration/rhwp/undo_save.py`
(실제 `service::save`)에 있다. 결과는 [rhwp-undo-redo.md](../../../docs/architecture/rhwp-undo-redo.md) "Phase 2 구현".

`save_service.py`의 종료 코드: 지금 동작(CURRENT 표 — 판정·저장 성공·**근거 코드와 부분까지 정확히**)과 다르면 1. 바라는 동작(DESIRED: 판정과
반드시 있어야 할 근거, 거부된 저장은 그 근거로 거부)과 다르면 `--strict-desired`에서 1. 2026-10-22 T009 수정 뒤 두 표 모두 0건이다(수정 전에는
DESIRED 9건 실패 — 재현 기록은 이 파일의 git 이력과 아래 Stage B 표).

변형 감지: `history_boundary.mjs`는 대상 보호를 지운 모델에서 "후보 없는 거부" 시험이 실패한다(확인함). "상한이 줄 때 보호" 시험은 그 시나리오에서
가장 오래된 과거가 대상이 아니라 보호 없이도 통과한다(보호의 검출은 거부 시험이 맡는다). T009 정규 시험 3개(`hwpx_저장_검사는…`, `hwp_본문의…`,
`실제_저장_서비스는…`)는 수정의 두 호출을 끄면 실패한다(확인함).

`evidence/`: `save-service.json`(위 명령의 정리된 결과, 경로는 `<tmp>`, 2026-10-22 수정 뒤 실행), `history-boundary.json`(기록 경계 결과),
`selfclosing.json`·`snapshot-side-effects.json`(T009 2차·B1), `history-perf.json`(Phase 2 성능, node — WebView 아님), `undo-save.json`(Phase 2 D3),
`phase0-summary.json`(이전 Phase 0 실행의 A·B·C·G 요약을 임시 디렉터리에서 옮긴 것, 문서 내용·경로 제거).

## Stage A 결과: 실제 저장 서비스(2026-10-21)

모든 사례에서 사전 검사 `safe`, 다시 열기 네 값 모두 참(서식은 다시 열기 비교 대상이 아니다).

| 사례 | `check_saved` | `service::save` | 원본 사본 |
|------|---------------|-----------------|-----------|
| HWP 기울임·굵게(본문), 밑줄(셀) — 새 모양 9번째 | unsafe `recordsChanged(DocInfo)` + `previewStale(PrvText, PrvImage)` | `UnsafeSave` | SHA-256 그대로, 임시 파일 없음 |
| HWP 글자 넣기(대조) | unsafe `previewStale` ×2 | `UnsafeSave` | 그대로 |
| HWP 기울임 뒤 스냅숏 복원 | safe | 게시(원본과 같은 바이트) | 바이트 같음 |
| HWPX 기울임(본문)·밑줄(셀) — 새 `charPr` | unsafe `partChanged(Contents/header.xml)` (2026-10-26 Phase 3B 뒤: safe, **게시**) | `UnsafeSave` (뒤: 게시) | 그대로 (뒤: 출력과 같음) |
| HWPX 굵게 — 엔진이 있는 모양 7을 재사용, header 그대로 | safe | **게시**(서식 바뀐 파일로 교체) | 출력과 같음, `dirty=false` |
| HWPX 글자 넣기·기울임 뒤 복원(대조) | safe | 게시 | 출력과 같음 |

거부는 `check_saved`가 unsafe일 때 `service::save`가 `publish::stage` **전에** 돌려준다(코드 순서, `service.rs`). 거부 뒤 작업 디렉터리 목록은
`doc.<형식>` 하나뿐이고 원본 사본 SHA-256이 같다. 게시 사례는 교체 뒤 파일이 출력과 같고 세션이 깨끗해진다(내구성 확인).

## Stage B 결과: 글자 모양 참조 무결성 공백 — 2026-10-22 고침

**수정 뒤(VERIFIED, `save_service.py --strict-desired` 0건):** 아래 "게시"였던 고친 사본 8개(HWPX)는 모두 `referenceInvalid{Contents/section0.xml}`
(unsafe)로 실제 `service::save`가 거부하고 원본 사본 SHA-256이 그대로다. HWP `hwp-b-dangling-9999`는 `previewStale` ×2와 **따로**
`referenceInvalid{BodyText/Section0}`, 미리보기 없는 합성 쌍은 `referenceInvalid`만으로 unsafe. header id 중복은 `partChanged`에 더해
`unsupported{Contents/header.xml}`(정의를 정할 수 없음)로 unknown(수정 전 unsafe, 둘 다 저장 차단). 대조(있는 모양 `7`, 굵게 재사용, 글자 넣기,
복원)는 safe·게시 그대로. 규칙: [save-preservation.md](../../../docs/architecture/save-preservation.md) "모양 참조 무결성".

수정 전 재현(VERIFIED, 2026-10-21·10-22 재실행): 엔진이 낸 HWPX 글자 편집 출력의 `Contents/section0.xml` 한 곳만 고친 사본을, 같은 엔진으로
다시 연 근거와 함께 실제 `service::save`에 넣었다.

| 고친 곳 | 판정(수정 전) | 저장(수정 전) | 엔진이 다시 열어 본 값 |
|---------|------|------|------------------------|
| 본문 글 run `charPrIDRef="9999"` | safe | **게시** | 열림, 다시 열기 네 값 참, `charShapeId` 9999, 서식은 엔진 기본값(없는 모양의 대체) |
| 표 셀 run `9999` | safe | **게시** | 셀 `charShapeId` 9999, 기본값 |
| 본문 `8`(itemCnt 8, id 0–7 다음 빈 번호) | safe | **게시** | 8, 기본값 |
| 본문 `70000` | safe | **게시** | 70000, 기본값 |
| 본문 `abc`, `-1` | safe | **게시** | 0으로 읽힘(조용히 다른 모양) |
| 구역 정의 run `9999`, `paraPrIDRef="9999"` | safe | **게시** | 열림 |
| 대조: 본문 `7`(있는 굵게 모양) | safe | 게시 | 7, 굵게 — 올바른 참조라 바라는 판정도 safe |
| 대조: header `charPr` id 중복 | unsafe `partChanged(header.xml)` | `UnsafeSave` | — |

원인(VERIFIED 코드): `package::compare_saved_hwpx`는 `Contents/section<N>.xml`을 통째로 비교에서 빼고("엔진 다시 열기가 확인"),
`package::validate_hwpx`는 XML 끝까지 읽기·`mimetype`·manifest만 본다. 다시 열기 근거(`exportAndCompare`)는 쪽 수·본문 글·컨트롤만
비교한다. 엔진은 `charPr`의 `id`를 배열 위치로 쓰고(`parser/hwpx/header.rs` `set_indexed`, 빈 번호는 기본값으로 채움), 없는 ID는
`char_styles.get()`이 `None` → 기본 서식으로 그린다(`build_char_properties_json` `None` 분기). 그래서 아무도 참조를 확인하지 않는다.

조건: header가 원본과 같고 본문만 고친 출력이면 참조가 무엇이든 통과한다. header를 바꾸면 이미 `partChanged`로 막힌다.

HWP 대응: 같은 종류의 공백이 판정 함수에 있다(VERIFIED, 합성 쌍): `hwp::compare_saved`는 본문 구역을 레코드로 읽히는지만 본다.
본문 `PARA_CHAR_SHAPE` 첫 ID를 9999로 바꾼 출력은 지금 `previewStale`로만 막히고(참조 근거 없음), 미리보기를 뺀 합성 쌍에서는 `check_saved`가
safe다. 다만 실제 저장 경로로는 도달하지 않는다: 미리보기 없는 HWP는 엔진이 `PrvText`를 새로 만들어 사전 검사가 unsafe(`partAdded PrvText`,
VERIFIED)이고, 미리보기가 있으면 본문을 바꾼 저장은 모두 `previewStale`이다. → **HWP는 확인된 판정 공백, 지금 저장 경로에서는 가려짐**.

수정(2026-10-22): `package::validate_hwpx_references`(service `check_saved` HWPX 분기), `hwp::references`(`compare_saved` 편집 모드),
근거 코드 `referenceInvalid`(`preserve.rs`·`src/adapters/contract.ts`·화면 문구). 정규 시험은 `src-tauri/src/services/save/tests.rs`의 5개(합성
HWPX·HWP, 실제 `service::save`와 원본 보존). 오탐 확인: 업스트림 예제 1076개(`external/rhwp/samples`)의 편집 없는 rhwp 출력을 편집 저장 판정에
넣어 `referenceInvalid` 0건(새로 막힌 문서 없음).

## Stage B5: HWP 미리보기 규칙

`hwp::compare_with`(Edited)는 본문 구역 레코드가 하나라도 바뀌면(`body_changed`) 원본 그대로 남은 `PrvText`·`PrvImage`가 빈 값·엔진 상수인지
증명을 요구한다. 픽스처 HWP의 `PrvText`(120바이트)는 본문 앞부분 글이고 `PrvImage`는 5126바이트 PNG(엔진 상수 아님)라 글자 편집·서식 모두
`previewStale`이다.

- 글자를 바꾼 편집: `PrvText`가 편집 전 글을 담는다 → 의도한 보수적 안전 제한(T009 F).
- 서식만 바꾼 편집: 글은 그대로라 `PrvText`가 낡지 않았을 수 있다(INFERRED). 그러나 규칙은 본문 레코드 변경만 보고, `PrvImage`는 서식을 보여 줄 수
  있으므로 증명할 수 없다 → 지금 규칙으로는 막히는 것이 맞고, 좁은 보존 작업(서식만 바뀐 편집에서 `PrvText`가 출력 본문 글과 같음을
  증명)의 후보이지만 `PrvImage` 때문에 그것만으로는 저장이 풀리지 않는다.
- 빈 미리보기(빈 값·`\r\n`·엔진 상수 PNG)·미리보기 없음: 판정은 통과하지만, `PrvText`가 비었거나 없으면 엔진이 본문으로 새로 만들어 사전 검사가
  `PrvText` 바뀜·추가로 unsafe(VERIFIED 없음 사례). 본문 글이 없는 문서만 예외(INFERRED, `supplement_preview`).
- 결론: 엔진 능력 한계(미리보기를 다시 만들거나 지우는 API가 없음)와 의도한 안전 제한이 겹친 것. 모든 HWP가 막힌다는 뜻은 아니다(편집 없는
  저장·되돌린 출력은 게시된다, Stage A). 정책은 바꾸지 않았다([save-preservation.md](../../../docs/architecture/save-preservation.md) F).

## 다음 단계(계획만, 실행하지 않음)

| 단계 | 선행 조건 | 바뀔 곳 | 수용 시험 | 안전·성능 |
|------|-----------|---------|-----------|-----------|
| Phase 2 rhwp 실행 취소 | [rhwp-undo-redo.md](../../../docs/architecture/rhwp-undo-redo.md)(2026-10-22 고침) 승인, 열린 질문 1·4 PoC | `RhwpEditorSession`, `rhwpModule.ts`(스냅숏 함수 타입), `target.ts`·`capability.ts`(한도 이유), 시험 | 설계 §11 표 전부(실제 WASM 세션·Rust·네이티브 ibus-hangul) | 참조 중 스냅숏을 엔진이 지우지 않음, 실행 취소 p95 ≤ 1.5초(WebView), 레지스트리는 아직 `unsupported` |
| Phase 3A T009 참조 무결성 — **2026-10-22 완료** | Stage B 결과 승인 | `services/save/package.rs`(+ `hwp.rs`), `preserve.rs`(근거 코드), 시험 | `save_service.py --strict-desired` 통과, 기존 T009 시험·`roundtrip.py` 그대로 | 해석 불가 = unsafe, header 전체 허용 없음, 기존 규칙 완화 없음 |
| Phase 3B HWPX 서식 — **2026-10-26 판정 규칙만 완료** | 3A 완료 | `package.rs`의 좁은 header 규칙(완료: `hwpx_char_shapes_appended`, [save-preservation.md](../../../docs/architecture/save-preservation.md) "글자 서식 덧붙임"), 서식 명령(미구현) | 완료: `save_service.py --strict-desired` CURRENT 0·DESIRED 0(HWPX 기울임·셀 밑줄 safe·게시, 음성 대조 그대로), 다시 연 서식 같음(생성 픽스처). 남음: 세션 서식 명령, 서식 비교를 다시 열기 근거에 추가, 실제 앱 | 바뀐 header 부분은 덧붙임뿐 |
| Phase 3C HWP 서식 | 3B와 별개 | `hwp.rs` DocInfo 규칙(덧붙인 CHAR_SHAPE + `ID_MAPPINGS[9]`), 미리보기 | 미리보기 규칙을 풀 근거가 생기기 전에는 저장 불가가 맞는 결과. 모양 재사용 실패·고아 모양(Phase 0 D) 처리 | HWPX가 되어도 HWP를 준비됨으로 보지 않음 |
| Phase 4 명령 켜기 | 2·3 해당 부분 완료 | `registry.ts`, 문서 | SC-003 rhwp 몫, 네이티브 앱 시험 | 검증한 명령만 `supported`, T010 체크는 그때 판정 |

T010은 미완료로 남고, T011의 선행 조건은 바꾸지 않는다.
