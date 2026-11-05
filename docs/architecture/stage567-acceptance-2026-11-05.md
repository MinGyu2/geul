# Stage 5–7 통합·수용 재검증 (2026-11-05)

실행 기간: 2026-11-05~11-06 KST. 문서 파일명의 날짜는 착수일이다.

> **최신 후속 판정 (2026-11-06): PARTIALLY COMPLETED.** B1 저장 중 편집 race와 B2 게시 전 Undo snapshot 복구는 각각 재현·수정·검증되어 별도 로컬 커밋됐다. D2 격리 native 조사에서 E→U→F는 여전히 0회 관측되어 INCONCLUSIVE이며 기존 predicate와 제품 입력/history 코드는 바꾸지 않았다. WordCraft pin은 현 원격 ref에서 clean fetch할 수 없어 A는 BLOCKED다. Microsoft Word와 Hancom Office가 없는 환경에서 D 외부 수용은 NOT RUN; 내부 파일 검증과 stale-preview 안전 거절만 기록했다. T012/T013은 완료하지 않았고 제품 RHWP Undo/Redo·장평/자간·영속 수식은 계속 비활성이다. D4는 이번 작업에서 제외했으며 기존 gate를 변경하지 않았다. 상세·증거·남은 수용 조건은 아래 2026-11-06 후속 기록을 따른다.

현재 결론: **Stage 5/6/7 PARTIALLY COMPLETED, T012/T013 미완료, 제품 RHWP history·장평/자간·영속 수식 NO-GO**. 엔진 구현·실제 WASM·저장 서비스·실제 Tauri 검증을 구분한다. D2의 필수 순서는 관측되지 않았고 D4 원래 문턱을 넘었다. 과거의 native NOT RUN은 아래 실행 범위에 대해서만 대체한다. Word/Hancom 호환성은 NOT RUN이다.

## 실행 신원과 재현

- 시작 geul `e9e602ef855f7a6822cf2db25f90160e60942d06`, master. bounds 수정 `2f649b3ae306095cf9fa034c3314a868905cba80`.
- RHWP gitlink `1a76570e833917d15817415a53c09ad61ab3203f` 유지. `scripts/rhwp-patches.py`의 순서 있는 13개 패치, 마지막 둘은 compaction → formula. 후보를 active `patches/rhwp/table-formula-field.patch`로 통합했다.
- 최종 patched source SHA256 `49b8c76bdea8b7317d7d34a24145014fe8be304d77b34a193b8c4ae81e16057f`.
- compaction patch SHA256 `d164dee99f509c72c8c6411d8a08bd736001a7c5404a966398862654e181bab9`, formula patch `ba11170978c1177e77b87b347c14a1904218bdd36874e72a71dff809671722bd`.
- Release generation `b03ae7bd36ae56a023d0154c02e2dab0dc8fedcaeb85ea998962fdddd5393762`; WASM `3f45cc6c8c9884f96e744d8ac3150e97c832ceb7727dc484b917269711f18059`, JS `a56c020154e76e1526888b38c6bec801f0c2fc0ecf7a432a05140d4377ae2ef3`. Rust/Cargo 1.99.1, wasm-bindgen 0.2.127, wasm32 target, locked/offline 보호 빌드·generation publication 사용.
- Debug `0c2faef3a2966c4d717d50b83f51f839f5b4a14a7c26935723edc38bd36a90c4` 유지. 이 Debug를 Stage 6 수식 검증으로 세지 않는다.
- 최초 Stage 6 generation `f47aea85…`에서 새 HWP 생성 거부가 실제 native로 발견됐다. createEmpty 전역 기본값 변경을 철회하고, version 0 빈 문서에서 표를 만들 때에만 필요한 기본 모양을 보충했다. 생성 authority/hash를 바꾸지 않고 최종 generation에서 다시 검증했다. 이전 source/generation은 target의 task 소유 보관 경로에 남겼다.
- `package-lock.json`, geul/RHWP `Cargo.lock` 변경 없음. artifact는 ignored local generation이며 Git에 바이너리를 넣지 않는다. 원격 push 없음. WordCraft 시작 `b74830b293a49801b385b81efae865d65c905070` → 최종 로컬 `6c994e42dee106ca03c6f11628d2fe577fe27636`, geul pin milestone `9f5d031864eee9a1a800d5338e7a3e3181500514`. 미발행 엔진 신원의 원격 재현 제한은 유지한다.

최종 commit 전 새 패치의 빈 unified-diff context 11행이 공백 검사에 걸렸다. 검사 예외를 추가하지 않고 같은 빈 줄 삭제/추가와 nonempty hunk edge로 표현을 바꿨다. 정방향·역방향 `git apply --check` 및 전 series 재생성 뒤 소스 SHA49b8…가 그대로임을 확인했다. 승인된 Release 재빌드6분27초 → 최종 b03ae7… generation, JS/WASM은 이전 native/서비스 검증 generation8197…와 **바이트 단위 동일**하다. 이전 native·서비스 근거는 같은 관련 소스/바이트로 재사용하고 새 generation에서 runtime8cases/invalid22와 typed session5를 다시 통과했다. 최종 sourceFingerprint는 `60422606ea620ef0c39d64d33cf85d3f544e5976c0e623ba2aef0e6467371908`이다. 과거 generation/source는 보관했고 inactive task generation f47…도 target으로 이동 보관했으며 삭제하지 않았다.

## Stage 5: 안정화

`id_mappings_grew`의 동일 길이만으로 `[..36]`을 자르던 경로를 실제 `compare_saved`의 DocInfo append 비교로 재현했다. 빈 payload에서 panic이 발생했고, 최소 40바이트 guard로 바로잡았다. 0–39바이트·최소 길이·서로 다른 길이·정확/오류 증가·overflow·관계없는 앞/뒤 바이트 변경을 검사한다. count 읽기는 checked slicing, 증가 변환/덧셈은 기존 checked 연산을 유지한다.

추가로 원본 ID_MAPPINGS의 shape count가 실제 원본 레코드 수와 같아야 하고, 새 shape 길이는 실제 reader/writer의 68/70/74바이트 구조만 허용한다. 잘못된 count/shape/문단 참조를 실제 저장 서비스가 거부하고 원본·dirty/revision·ticket cleanup을 보존하는 회귀를 추가했다. 기존 출력 reference 수집기가 malformed PARA_CHAR_SHAPE를 이미 거부하므로 중복 검증기를 넣지 않았다.

compaction은 baseline 아래 ID를 보존한다. 본문·중첩 표·그림/텍스트박스·caption·header/footer·각주/미주·숨은 메모·field guide/memo·overlap·master page·style·numbering·bullet·clipboard·HWPX topology와 대응 직렬화 참조를 조사했다. 가변 paragraph 참조는 같은 순회로 collect/remap한다. fixed DocInfo 참조가 appended ID를 가리키거나 범위 밖이면 변경 전 거부한다. u32::MAX는 fixed의 없음 sentinel에만 허용하고 paragraph run에서는 dangling으로 거부하도록 수정했다. 원본의 opaque/raw 구조는 원본 ID를 그대로 유지하며 새 ID를 담는 알 수 없는 구조를 재번호하는 규칙은 추가하지 않았다. 실패 전 모델 동일성·결정적 매핑·공유 참조·불필요한 정리의 no-op은 엔진 회귀로 확인했다.

수식 응답의 cached text도 공백/hex를 숫자로 처리하지 않는 decimal grammar로 검사한다(수정 전 공백 응답 허용 재현 → focused14 PASS, 실제 WASM5 PASS). geul은 compaction JSON의 정확한 키·정수 범위·skip 종류·skip 시 count 불변을 검사한다. 부분 mutation/예외가 발생하면 uncertain으로 편집을 멈추고 저장 검사가 최종 판정한다. history allocation 실패로 기록이 비활성화된 뒤 필수 기록을 요구하는 서식/수식이 실행되던 경계도 거부하도록 수정했다.

동일 세션의 **장평 → 저장 → 자간 → 둘째 저장**은 최초 load baseline만 유지하면 첫 게시 정의가 재사용/삭제되어 보존 거부됨을 실제 WASM/서비스로 재현했다. 성공한 현재 판 게시의 정의 수를 다음 정리의 보호 prefix로 올려 수정했다. 실제 서비스 HWP/HWPX 두 회차 4게시가 통과했다. 오래된 Undo snapshot이 보호 prefix보다 짧으면 정리를 건너뛰고 저장의 엄격한 원본 비교를 유지한다. 과거 게시 이전 snapshot을 저장할 때는 안전하게 거부될 수 있으므로 모든 Undo 상태의 저장 수용을 완료했다고 하지 않는다. UI의 한 문단 내 선택 제한도 유지한다.

참조 증명은 구분한다: 모든 appended shape가 사용됐다는 것은 모든 기존 참조의 유효성이나 사용자 의도와 같은 서식이라는 증명과 다르다. 전자는 append 규칙, 참조 유효성은 출력 참조 검사, 실제 7언어 width/spacing·본문/표/여러 run의 변환과 재개방은 실제 WASM 시험으로 각각 확인한다. 스타일/metadata·관계없는 DocInfo 변경은 여전히 거부한다.

## Stage 6: 영속 수식

- authoritative engine parser가 전체 토큰을 소비하며 불완전 SUM/괄호/구분자/잘못된 숫자·cell/지원하지 않는 함수·잘못된 arity를 거부한다. 비활성 IF 가지도 검증한다. 길이 256, 깊이 16, checked cell budget 4096, 표 범위·유한 결과를 allocation/변경 전에 검사한다. wildcard `?`와 명시적인 overflow row를 혼동하지 않는다.
- UI grammar → typed session/command의 문맥/세션/판/세대/IME 검사 → 엔진의 독립 검증을 둔다. 임의 engine 문자열 실행 통로를 만들지 않았다. readonly `hangul.tableFormula`는 제품에서 유지한다.
- `validateTableFormulaField`는 읽기 전용 preparation, `insertTableFormulaField`는 clone에서 검증 후 단일 교체한다. malformed response/trap은 uncertain, 정상 거부는 기록/dirty/revision을 만들지 않는다. no-op replacement도 history를 만들지 않는다. 셀 전체 한 paragraph/기존 단일 Formula 소유권만 허용하고 다른 control은 거부한다.
- HWP `%fmu`, extra 0x08, expression과 `%g` cached-result command·visible text·field ID를 유지한다. HWPX reader는 Formula 타입으로 binary 기본 extra를 복원하고 XML에 근거 없는 속성을 만들지 않는다. 교체 시 기존 parsed Command parameter 하나를 갱신하고 다른 parameter는 유지하며 모호한 구조는 거부한다.
- 생성·교체·다중 필드·다른 셀 참조·의존 셀 편집 후 명시적 재계산·snapshot 복원·export/reopen/재편집/두 번째 저장을 실제 새 Release WASM으로 확인했다. 자동 의존성 재계산을 주장하지 않는다.
- generated HWP/HWPX 및 HWP에서 내부 변환한 fixture HWPX의 실제 서비스 같은 경로 두 회차 총 6게시와 게시 후 재개방 통과. Hancom `calc-cell.hwp`의 변경은 비어 있지 않은 기존 PrvText/PrvImage가 stale이므로 두 번 모두 안전 거부(원본 보존). 이 fixture에 대한 제품 저장 수용은 BLOCKED다. T009 preview 정책을 완화하지 않았다.
- Hancom이 작성한 formula HWPX 실물이 없으므로 HWPX는 **INTERNAL ROUND-TRIP VERIFIED**, **HANCOM COMPATIBILITY NOT RUN**이다.
- typed `hangul.insertTableFormula`는 `VITE_GEUL_TEST_HOOKS=1`, `VITE_GEUL_TEST_RHWP_HISTORY=1`, `VITE_GEUL_TEST_RHWP_FORMULA=1`을 모두 요구한다. 제품은 unsupported. 실제 Tauri의 제품 비활성 상태도 검사했다.

## Stage 7: 실제 native와 제품 관문

기존 T023 runner/격리 인프라를 재사용했다. Xvfb X11 1280×1024, 96dpi, private D-Bus/HOME/XDG/IBus, WebKitGTK 2.54.1, IBus 1.5.33 + Hangul 1.5.5, 실제 Tauri debug 바이너리와 Vite/Release WASM, WebDriver와 XTest 키 입력이다. 사용자 Wayland 세션/전역 설정은 변경하지 않았다. 모든 완료 runner의 process-scope cleanup은 survivors 없음이다. 실제 세션의 facade.openDocument 인스턴스를 관찰하도록 probe를 고쳤다. 다른 Vite module alias의 prototype이나 없는 heap을 0으로 꾸미지 않는다. 합성 composition 이벤트를 native 근거로 쓰지 않았다.

- New DOCX/HWP/HWPX: 실제 메뉴 생성·한글 입력·편집·두 번 저장·native 파일 대화상자 재개방 PASS, 기존 T023 거부/충돌/실패 검증 포함.
- controlled RHWP: 반복 장평/자간, Undo/Redo, 서식 후 한글 입력, 수식 생성/교체/두 번 저장, expression/cached result 유지·native reopen **12 PASS**.
- 제품 RHWP: readonly 계산·수식 비활성·metrics 비활성·재개방 **8 PASS**. 이를 제품 mutation 성공으로 세지 않는다.
- 공통 실제 Tauri: 기존 T011 러너를 재사용해 리본/키보드/ARIA/명령 대상20 PASS, 실제 IBus 조합 중 리본·문서 탭·닫기·모달26 PASS, 별도 실제 X11 창 초점 이동9 PASS. 최종 canonical generation b03ae7…로 실행했다. 모달 hardening의 프로그램 방식 click challenge는 별도 포함하지만 조합 이벤트는 합성하지 않는다. 원래 assertions는 유지하고 오래된 N8의 3개 미구현 명령 가정을 현재4개 명령/정확한 reason catalog로 바꿨다. fixture helper의 직접 Cargo 실행 대신 보호 build한 기존 example binary를 실행한다. `ribbon/`의 IME26 및 `ribbon-final/`의20/9와 cleanup survivors=[]가 근거다.
- DOCX: baseline·하이퍼링크 일부 메모·TOC 삽입/갱신·각주/미주·tracking toggle·실제 한글 tracked input까지 단계별 실제 저장 PASS. 이어진 TOC bookmark-end 추적 삭제에서 reopenMismatch 발견. 원본은 보존됐다. writer가 range marker의 revision wrapper를 빠뜨린 원인을 수정했다. [OOXML의 DeletedRun child 목록](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.deletedrun?view=openxml-3.0.1)은 bookmark/comment/permission range marker를 허용하며 reader는 이미 revision context를 받는다. 최종 새 엔진 native 재검증 **10 PASS**, 단계별 저장검사10 PASS, 실제 재개방 PASS(`native8/`). 추적 상태 대표 파일 `advanced-tracked.docx`를 별도 보존했다. 처음 최종 검사에서는 `<w:ins` 부분 문자열이 TOC의 `w:instrText`까지 세는 harness 결함을 발견했고 정확한 XML namespace/local-name으로 긍정/부정 검사를 모두 교정했다. `native7` 실제 파일은 수정 기록0/명령문1이었으며 `native8`에서 더 엄격한 검사를 재실행했다.

D2는 원래 predicate를 유지한 실제 입력 **25 PASS / 0 FAIL / 2 INCONCLUSIVE**다. HWP/HWPX native 순서 시도 36개는 안전했으나 필수 **empty compositionend(E) → native Undo(U) → late final insertion(F)**를 관측하지 못했다. 일반 입력·취소·선택/Backspace·Undo/Redo·탭/모달/초점 경계 통과를 그 race의 PASS로 바꾸지 않는다.

D4는 원래 4문서·warmup·3RAF·표본·문턱(group p95≤50ms, Undo p95≤1500ms)을 유지했다. 각 문서 group 30/Undo 25, timeout 0; **6 PASS / 2 FAIL**, 자원 수용은 미완료다.

| 문서 | 쪽 | group p95 ms | Undo p95 ms | 판정 |
|---|---:|---:|---:|---|
| basic HWP | 1 | 47 | 49 | PASS |
| basic HWPX | 1 | 45 | 48 | PASS |
| chemistry HWP | 24 | 176 | 88 | FAILED(group) |
| asset HWPX | 60 | 103 | 164 | FAILED(group) |

Asset group의 개별 stage p95는 snapshot 2, mutation 28, layoutTree 9, render 15, handler 71, backend ACK 54ms다. 이들은 중첩 경계이므로 합산하지 않는다. Chemistry key→frame p95 176과 input→frame 68ms도 분포를 서로 빼서 원인으로 단정하지 않는다. WASM memory는 3.9MB에서 큰 문서 뒤 약135MB, aggregate WebProcess RSS는 약1.21GB까지 관측됐고 닫은 뒤 canvas/owners는 0/빈 배열이었다. 미검증 constructor alias의 engineSurfaces는 null로 기록했다. 이를 누수 없음이나 자원 PASS로 해석하지 않는다. 전체 handler/dispatch/paint 경로가 중요하며 snapshot microbenchmark로 PASS를 대신할 수 없다. 기존 D4 구조 검토의 full oracle/ownership/메모리 조건을 만족하는 새 최적화 근거가 없어 광범위 renderer 재작성을 하지 않았다.

## 검증 명령·증거

최종 geul 보호 명령은 `python3 scripts/cargo-geul.py test --lib --no-run`, `build --bin geul`, `fmt --check`, `clippy --lib --bins -- -D warnings`다. 전부 PASS(locked/offline·source/Git read-only). test binary 실행은 해당 compile 산출물에 private `TMPDIR=target/stage7-continuation/final-backend-tmp`의 절대 경로를 지정했다. 명령 필터는 `adapters::wordcraft --nocapture`, `services::save --nocapture`, 새 marker 회귀의 정확한 이름이다. RHWP 최종 실제 빌드는 `scripts/build-rhwp-wasm.sh`의 Release 기본 경로이며 승인 wrapper·generation mechanism을 사용했다. 원본 `Cargo.lock`과 같은 wasm-bindgen 0.2.127 CLI를 기존 캐시에서 사용했다.

최종 실제 WASM 세션 명령은 `VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 VITE_GEUL_TEST_RHWP_FORMAT=1 VITE_GEUL_TEST_RHWP_FORMULA=1 npx vitest run --config scripts/tests/vitest.config.ts table-formula-session`다. 수식 runtime은 `node scripts/tests/table-formula-runtime.mjs target/stage6-continuation/runtime-recalculation-final`로 새 run 디렉터리를 만들었다. 같은 디렉터리의 무분별한 재실행은 금지하고 `--published`는 실제 service 게시 결과 검증에만 사용한다.


아래 `target/`는 로컬 ignored 증거이며 원격 파일 링크를 뜻하지 않는다. 직접 실행과 보호 환경을 구분한다. 전체 실행의 count를 합쳐 새로운 고유 시험 수처럼 표현하지 않는다.

| 범위 | 명령/방법 | 결과·증거 |
|---|---|---|
| HWP panic/서비스 | `python3 scripts/cargo-geul.py test --lib …` 및 보호 compile 후 private TMPDIR의 같은 test binary | bounds 3 PASS, 추가 hwp_docinfo 3 PASS; `target/stage5-bounds-before.log`, `target/stage5-continuation/` |
| 저장 회귀 | 보호 compile 후 `geul_lib-… services::save --nocapture` 직접 실행 | 146 PASS / 15 ignored; `save-regression-direct.log`. 기본 보호 runtime에서는 /tmp 소유권 SharedDirectory로 46실패(100 PASS/15 ignored), 권한을 완화하지 않았다 |
| WordCraft adapter | 같은 private TMPDIR 직접 실행 | 새 engine 기존76 PASS /1 ignored, 새 marker 회귀1 PASS; `final-wordcraft.log`(최초 새 test의 caret props 오용1실패), `marker-adapter-final.log`(실제 char props로 교정 뒤 통과). 시험의 assertion을 제거하지 않았다 |
| RHWP native | integrity 보호 `cargo test -p rhwp --locked --offline … --lib geul_`, `field`, `char_shape_compaction` | 최종 source geul_5 PASS, field144 PASS, compaction4 PASS; Stage6 target 로그 |
| RHWP Clippy | 보호 `cargo clippy … -- -D warnings` | FAILED: Rust1.99의 기존41 diagnostics, 최초 Stage5 source와 같은41 위치 재현(`clippy-comparison.json`); geul Clippy와 구분 |
| WordCraft 필수 CI | 보호 `cargo run --manifest-path external/wordcraft/Cargo.toml --locked --offline -p xtask -- ci` + 중단 뒤 독립 `assets/layers/wasm` | fmt/Clippy PASS, 실행972 PASS/1기존 static failure; 나머지3검사/WASM16패키지 PASS. `wordcraft-ci.log`, `wordcraft-rest.log`, baseline-static.json. 소스/metadata unchanged proof true |
| 실제 WASM | `node scripts/tests/table-formula-runtime.mjs …` | 8 serialize/reopen cases, invalid22 거부, 추가 재계산/복원 HWP/HWPX PASS; `runtime-canonical/` |
| typed 실제 WASM | 4개 test flag + `npx vitest run --config scripts/tests/vitest.config.ts table-formula-session` | 5 PASS; `target/stage6-continuation/session-canonical.log` |
| 실제 save service | `t010_phase0_save_service …` 보호 compile → private TMPDIR 직접 실행, runtime `--published` | 6게시/2정상 거부; `target/stage6-continuation/chain-final/`; metric 저장4게시 `target/stage5-continuation/postsave-fixed/` |
| Stage5 실제 WASM | 기존 private framework + 실제 save service | 최종 generation 15/15 PASS, history/format/multisection41 PASS; `wasm-save-final.json`, `history-wasm-final.log` |
| frontend 최종 | `npm run typecheck`, `npm run lint`, `npm test` | 모두 PASS, 64파일/1136시험; `target/stage7-continuation/final-frontend-*.log` |
| native | `native-new-document.py`, `scripts/tests/native-stage567.py`, `native-history-acceptance.py`를 기존 isolated launcher로 실행 | `target/stage7-continuation/native2/`, `native3/`, `production/`, `native8/`, `ribbon/`, `ribbon-final/`; 실제 실행 argv·app hash·WASM identity·cleanup은 각 environment-result.json |

## 독립 판정

| Stage/항목 | 판정 | 근거 또는 남은 조건 |
|---|---|---|
| 5 character-shape reference coverage | COMPLETED | supported model/serializer 감사, fixed와 mutable 구분; 미지원 문서까지 지원 선언 아님 |
| 5 deterministic compaction | COMPLETED | baseline 보존·공유/삭제/remap/no-op 회귀 |
| 5 invalid references | COMPLETED | paragraph sentinel/dangling/fixed appended 거부, 실패 전 불변 |
| 5 bounds safety | COMPLETED | 실제 이전 panic 경로 및 길이0–39/40+/overflow/변이 회귀 |
| 5 HWP DocInfo preservation | COMPLETED(지원 append 규칙) | 기존 레코드 불변, 정확 count/길이/reference, 서비스 원본 보존 |
| 5 HWPX serialization | COMPLETED(내부) | 실제 WASM·서비스; 한컴 외부 수용은 별도 |
| 5 actual WASM | COMPLETED | 최종 Release generation의15/15·history41 |
| 5 two-save correctness | COMPLETED(지원 행렬) | 같은 세션 metric/save/metric/save HWP/HWPX4게시 |
| 5 Undo/Redo | PARTIALLY COMPLETED | controlled 엔진/세션/native 통과; 게시 이전 snapshot 저장은 엄격 비교로 거부 가능 |
| 5 D2 | PARTIALLY COMPLETED | 25 PASS, 필수 E<U<F 미관측/2 INCONCLUSIVE |
| 5 D4 | FAILED | 큰 두 문서 group latency 초과, 자원 INCONCLUSIVE |
| 5 production capability | BLOCKED | T010 필수 관문 미충족, 비활성 유지 |
| 6 formula candidate correction | COMPLETED | strict parser/budgets/ownership/parameter/HWPX reader/empty-table 보완 |
| 6 active series integration | COMPLETED | 후보에서13번째 active patch로 이동, pinned gitlink 유지 |
| 6 actual newly built WASM | COMPLETED | genuine approved source/build/generation/hash |
| 6 formula creation | COMPLETED(내부) | actual WASM·typed session·controlled Tauri |
| 6 formula replacement | COMPLETED(내부) | reopened field 교체, 기존 control 보존/불명확 구조 거부 |
| 6 expression preservation | COMPLETED(내부) | live/serialized/reopened field command 확인 |
| 6 cached-result preservation | COMPLETED(내부) | visible text와 cached result, 명시적 재계산 |
| 6 HWP serialization | COMPLETED(내부) | Hancom-generated fixture 모델 + generated 저장; preview 게이트 별도 |
| 6 HWPX serialization | COMPLETED(내부) | 타입/Command 보존; Hancom-authored HWPX fixture 없음 |
| 6 actual save/reopen | PARTIALLY COMPLETED | 6게시·2정상 거부, Hancom HWP stale preview BLOCKED |
| 6 second save | PARTIALLY COMPLETED | 지원3경로 두 회차 통과; 위 HWP fixture는 원본 보존 거부 |
| 6 invalid refusal | COMPLETED | engine invalid22 및 UI/typed 검증, no mutation/dirty/revision/history; 잘못된 공백/hex cache 응답은 별도 회귀로 거부 |
| 6 Undo/Redo | PARTIALLY COMPLETED | controlled 실제 WASM/Tauri 통과, 제품 T010 관문 미충족 |
| 6 production capability | BLOCKED | test flag 세 가지 + history 필수; 제품 unsupported |
| 7 native environment | COMPLETED | 기존 격리 X11/IBus/Tauri 인프라 재사용 |
| 7 actual Tauri launch | COMPLETED | debug backend + 실제 WebView + 최종 Release WASM |
| 7 document interaction | COMPLETED(명시 범위) | 새3형식·입력·저장·재개방·다중 세션/거부 조건, 공통20/IME26/창초점9 |
| 7 native Korean IME | PARTIALLY COMPLETED | 일반/native 경계 및 리본26·창초점9 통과; 특수 D2 race 미관측 |
| 7 D2 native scenario | PARTIALLY COMPLETED | E<U<F 증거 없음, 합성 이벤트로 대체하지 않음 |
| 7 product performance | FAILED | 원래 D4 기준6 PASS/2 FAIL |
| 7 DOCX advanced features | PARTIALLY COMPLETED | native10 PASS·단계별 저장10 PASS, Word 외부 수용/추가 native 조합 필요 |
| 7 HWP/HWPX advanced features | PARTIALLY COMPLETED | controlled native12 PASS, 제품 비활성8 PASS; 제품/외부 수용 별도 |
| 7 Microsoft Word | NOT RUN | 허가된 사용 가능한 설치/접근 없음, 설치하지 않음 |
| 7 Hancom Office | NOT RUN | 허가된 사용 가능한 설치/접근 없음, 설치하지 않음 |
| 7 final regressions | PARTIALLY COMPLETED | frontend1136 PASS, focused 엔진/서비스 통과; RHWP 기존41 Clippy/WordCraft 기존 static gate 실패 명시 |
| 전체 Stage5 / Stage6 / Stage7 | PARTIALLY COMPLETED | 구현 완료와 제품 전체 수용을 구분 |
| T012 / T013 Done | PARTIALLY COMPLETED | T012 제품/T010·한컴, T013 최종 native 행렬·Word 외부 수용 |

## 외부 수용 수동 절차

대표 문서는 `target/stage7-continuation/native8/run/docx/advanced.docx`·`advanced-tracked.docx`와 `target/stage7-continuation/native3/run/advanced/`의 HWP/HWPX, `target/stage6-continuation/chain-final/`의 게시 문서와 `target/stage7-continuation/fixtures/advanced-normalized.docx` 및 DOCX 최종 native 결과에 보관한다. private fixture를 공개 저장소에 추가하지 않는다.

1. 허가된 Word에서 DOCX를 열어 TOC 표시·갱신·heading 링크/쪽 번호, 추적 삽입·삭제·수락/거절, hyperlink 일부 메모, 각주/미주를 확인한다. 다른 이름으로 저장하고 geul에서 열어 모델/저장 두 회차와 원본 보존을 확인한다. 앱 버전·문서 hash·화면/결과를 기록한다.
2. 허가된 Hancom에서 HWP와 HWPX 각각 7언어 장평/자간·반복 서식·수식 expression/result/편집 가능성·다른 셀 참조와 관계없는 서식을 확인한다. 한컴에서 저장→재개방→geul 재개방/수식 교체→두 번째 저장을 확인한다. Hancom-authored formula HWPX fixture도 확보한다.
3. `calc-cell.hwp` stale preview 거부는 안전 게이트의 정상 결과다. 미리보기의 정확한 재생성/보존 증거가 없는 한 게시 허용으로 바꾸지 않는다. 외부 호환성의 부재는 독립 구현이나 내부 시험 실패로 표시하지 않는다.

## 2026-11-06 후속: WordCraft 재현성, 게시 Undo, native D2, 외부 Office

### 판정과 저장소 신원

전체 상태는 **PARTIALLY COMPLETED**다. 시작 geul HEAD `7c5b7d00cc5f2030013f0400e64afdf3a483a086`, WordCraft `6c994e42dee106ca03c6f11628d2fe577fe27636`, RHWP gitlink `1a76570e833917d15817415a53c09ad61ab3203f`를 확인했다. 이번 작업의 로컬 geul 커밋은 B1 `ed916a2656da51de689e5609eb448eb31fbfd560`, B2 `7825e94b2b800843c1941ea50e19b099f7926c08`, C 진단 `4fcaa815c0b8647a7cc3036845d87afa39d64aad`다. 원격 push는 하지 않았다. 아래 A와 D는 완료된 것으로 세지 않는다.

### A — WordCraft gitlink 재현성: BLOCKED

pin `6c994e42dee106ca03c6f11628d2fe577fe27636`은 현재 checkout에 있지만 현재 공개 WordCraft ref에서 fetch할 수 없다. 원격 `geul/semantic-roundtrip-equivalence`는 `b39a8fb49c6fefbdd960792f2a4effd0d7660e3c`, `main`은 `5a4c45e79aec9757a0277d5dbe83c666704820df`다. 새 격리 clone에서 `git fetch --depth=1 origin 6c994e42dee106ca03c6f11628d2fe577fe27636`는 exit 128, `upload-pack: not our ref`로 실패했고 현재 ref를 fetch/deepen해도 pin과 `af80638`, `b74830b` 객체가 없었다. `af80638`은 TOC 범위 읽기, `b74830b`는 revision index의 1:1 의미 비교, pin의 `6c994e4`는 bookmark/comment/permission range marker의 revision wrapper 저장과 tracked-change 왕복 회귀를 포함한다. 공개 `b39a8fb`에는 동등 구현이 없어 더 오래된 ref로 repin하면 필요한 T013 기능을 잃는다.

geul은 현 intended WordCraft source로 보호 빌드 PASS했다(`target/remaining-work/a/geul-build.log`). 이는 현재 checkout 빌드이며 fresh submodule checkout 증거가 아니다. 재현성은 **BLOCKED**이고 원격 게시와 새 checkout이 필요하다. 이 작업에서는 게시를 실행하지 않았다. 근거: `target/remaining-work/a/report.txt`.

향후 별도 허가가 있을 때의 절차(이번에는 미실행):

1. `external/wordcraft`에서 worktree clean, HEAD가 pin과 일치하고 `b39a8fb`가 조상인지 확인한다.
2. force 없이 기존 development branch를 fast-forward로 게시한다: `git push origin HEAD:refs/heads/geul/semantic-roundtrip-equivalence`.
3. `git ls-remote`가 해당 branch를 정확히 `6c994e42dee106ca03c6f11628d2fe577fe27636`에 가리키는지 확인한다.
4. 새 geul checkout에서 `git submodule update --init external/wordcraft`, submodule HEAD를 확인하고 승인된 geul 빌드를 수행한다.

### B1 — 비동기 save 중 서식: 해결

실제 Release WASM으로 첫 저장이 pending인 동안 너비를 바꾸고, 게시된 정의가 아직 live 참조가 아닌 상태에서 간격 변경/compaction을 한 뒤 첫 publication을 완료하고 두 번째 저장하는 race를 HWP와 HWPX 모두 재현했다. 수정 전 두 format test는 `expected 8 to be greater than 8`로 실패했다(`b1-before.log`). 첫 revision의 export가 참조하는 shape ID prefix를 저장 중 보호하고 성공한 publication의 정의 수를 후속 편집 여부와 무관하게 보호 baseline으로 올리도록 했다. 저장 실패는 baseline을 전진시키지 않으며 뒤늦은 편집은 dirty로 유지된다. non-durable 결과에서도 성공한 export prefix를 보호하되 dirty 상태는 보존한다. Ticket/session/load ownership은 유지된다.

회귀 범위는 pending 중 width, spacing, width→spacing, Undo, Redo, formula, publication 뒤 다음 save, backend failure, non-durable 결과, stale session/load generation 및 close/switch 응답이다. 실제 Release WASM race 33 PASS, frontend session/save/history 82 PASS, lint/typecheck PASS, 실제 HWP/HWPX save-service 4 durable publication과 저장 파일 reopen PASS다. 독립 B1 커밋은 `ed916a2656da51de689e5609eb448eb31fbfd560`이다. 근거: `target/remaining-work/b1-before.log`, `b1-after.log`, `b1-verification-wasm.log`, `b1-session-tests.log`, `b1-service.log`, `b1-service/reopened-model.json`. 저장 계약은 [save-preservation.md](save-preservation.md)의 B1 기록에 있다.

### B2 — publication 이전 Undo snapshot: 해결된 지원 범위와 안전 거부

실제 WASM의 save→Undo로 publication 전 shape table 복구→save에서 HWP와 HWPX 모두 실패했고 실제 service는 strict DocInfo 비교로 unsafe 판정해 원본을 보존했다. 수정은 문서 전체 대신 실제 게시된 immutable definition prefix를 보관하고 복원된 live 모델만 조정한다. history snapshot은 직접 변경하지 않고 최초 원본과 게시 prefix의 ID를 유지하며, 충돌하는 과거 appended ID만 검증 후 옮긴다. 복구 source metadata는 raw/exact 비교하며 appended ID 충돌에는 검증된 remap만 허용한다. 원본 metadata 변경, fixed/dangling reference, snapshot에 없는 buffer appended ID 등 안전 증명을 못 하는 입력은 계속 거부한다. T009 비교를 완화하거나 미사용 shape를 만들지 않는다.

14-patch RHWP source SHA-256 `f221f3f36a529d868f47a0feb54c4d552070d835070e989322035ad255427ed4`, Release identity `8087a8415e32e254846a745808083bb2c9c6c0fc85504345f88d825defcf71b7`, JS `54084e84e83ca4c29c822684ca8e2ac9ffd385aeab870b666061b81fe2c4aefb`, WASM `dc1071662bc06d3e3947f91801369b89aef58993cc0e9274f898e93b534bdb32`다. 실제 WASM history/reopen 51 PASS, frontend 82 PASS, focused native 5 PASS, service 20 chains/66 게시 시도(64 durable 게시·2 정상 거부) PASS, 저장 파일 full reopen 18 PASS다. service 행렬에는 durable publication 64건과 기존 상태에 따른 안전 거부 2건이 포함된다. 실제 저장 파일 재개방 후 HWP/HWPX 둘 다 Undo 결과를 보존하고 후속 수정·저장이 동작했다. 독립 커밋 `7825e94b2b800843c1941ea50e19b099f7926c08`. 근거: `target/remaining-work/b2-before.log`, `b2-wasm-reviewed.log`, `b2-native-reviewed.log`, `b2-service-reviewed.log`, `b2-reopen-reviewed.json`, `b2-final-source-identity.json`, `b2-retired-generation-final.json`. cap retire는 비활성 `629d…`/`853a…` 두 세대만 선정하고 보관 전후 hash를 검증했으며 cap을 바꾸거나 파일을 삭제하지 않았다. 최종 소스 1건의 WASM test는 `GEUL_FORMAT_SAVE_OUT` 미설정으로 format-save 생성기가 선택되지 않아 SKIP이며 PASS로 세지 않는다. 기존 Release artifact를 불필요하게 반복 빌드하지 않았다.

### C — D2 native E→U→F: INCONCLUSIVE 유지

격리 Xvfb/X11, private D-Bus/IBus Hangul, 실제 Tauri/WebKitGTK, XTest 입력으로 IBus Hangul control-mask 전달의 GTK sync mode 0/1을 비교했다. 사용자 Wayland session에는 손대지 않았고 composition event를 합성하지 않았다. 각 mode에서 편집기 6 trial 및 일반 textarea 대조 3 trial을 얻었다. 원시 trace에는 composition payload, beforeinput/input, keydown/up, native Undo 요청, editor mutation/history, revision, session/load generation 및 최종 문서가 있다. mode 0에서 E seq74, F seq87, U seq117(End 경로 U seq126)이며 취소 경로는 E seq96 뒤 U seq116이고 F가 없다. mode 1에서도 확정 경로의 순서는 F가 U보다 앞섰고 취소는 E seq99→U seq116, F 없음이다. 따라서 핵심 E→U→F 관측은 0회다. Editor가 U를 가로챘다는 증거도, 다른 입력 환경에서도 이 순서가 불가능하다는 증명도 없다.

기존 D2 predicate를 그대로 적용해 **INCONCLUSIVE**를 유지한다. 취소 trial에서 취소 조합이 Undo로 되살아나지 않고 실제 후속 타이핑이 버려지지 않으며 session/load ownership과 revision/history가 일치했다. 일반 textarea 6회는 입력 전달 순서를 비교하는 진단이다. 추가 history/session assertion을 원시 trace에 재생한 12 PASS는 native trial을 추가한 것으로 세지 않는다. 제품 IME/history 수정은 없고 D2 predicate도 바꾸지 않았다. C 진단 커밋 `4fcaa815c0b8647a7cc3036845d87afa39d64aad`. 상세는 [rhwp-undo-redo.md의 2026-11-06 D2 기록](rhwp-undo-redo.md#2026-11-06-d2-원시-순서-조사-수용-inconclusive-유지), trace는 `target/remaining-work/c-native-{async,sync}/run/diagnosis/result.json`, replay는 `target/remaining-work/c-trace-validation.json`이다. 두 runner cleanup survivors는 0이다. 실제 native 실행 소스는 `target/remaining-work/c-native-recorded-harness.py`로 보관했으며, 두 기록의 harness SHA-256 `fa8ca43f734a5f0c88c002689e8a674dca5b09c2f672457ab07cbc44e76e3bc8`와 일치함을 확인했다. 이후 변경은 assertion·실패 기록 추가이며 native 이벤트 생성/관측 코드는 같다.

### D — Word/Hancom 외부 호환성: NOT RUN

현재 machine에서 Microsoft Word, Hancom Office, Wine, LibreOffice 실행 파일/desktop entry를 찾지 못했고 Nix profile app 목록과 connected document sessions도 비어 있었다(`target/remaining-work/d-application-access.json`). 외부 앱을 설치하거나 외부 machine에 접속하지 않았다. 따라서 Microsoft Word/Hancom 호환성은 **NOT RUN**이다.

내부 근거만 확인했다. DOCX 두 fixture에서 ZIP CRC와 XML well-formed 검사를 통과했고 TOC instruction, tracked insertion/deletion, comment range, hyperlink, footnote/endnote 구조를 확인했다. 이는 Word에서 열고 저장한 호환성 결과가 아니다. 현재 Release WASM으로 생성·재개방한 HWP/HWPX는 text/field/page 비교가 일치했고 formula `=1+2`, cached result `3`, metrics 7개 언어 width 180/spacing 10이 내부 모델에서 확인됐다. 내부 결과: [d-internal-reopen.json](../../target/remaining-work/d-internal-reopen.json), fixture identity: [d-fixtures.json](../../target/remaining-work/d-fixtures.json), 앱 탐색: [d-application-access.json](../../target/remaining-work/d-application-access.json).

Hancom `calc-cell.hwp` SHA-256 `e22c45dc65998ec3da6000b897f17a88f41dc6fceefeefabacea1fd0785716b3`를 원본 그대로 둔 채 현재 Release WASM으로 formula를 변경한 산출물을 실제 save-service에 넣었다. 두 번 모두 preflight safe, reopen 비교 true였으나 출력은 stale `PrvText`와 `PrvImage` 때문에 `previewStale` unsafe 판정 및 `UnsafeSave` 거부를 받았다. 저장 target SHA는 원본과 동일했고 dirty=true, ticket/temp listing 전후 동일했다. 출력 SHA-256은 `26d044630cf55fbe1ecb62a07bec40ed56b89c21c087202b67c8eb627621a397`. 이는 T009 preview 보존 정책이 기대대로 거부한 내부 증거이지 Hancom 수용 PASS가 아니다. 증거: `target/remaining-work/d-preview/service/results.json`, `run.log`. 호환성 수정 commit은 없다.

### 외부 수용 절차 (허가된 GUI 접근 확보 후)

Fixture 원본 bytes는 보존하고 복사본으로 시험한다. 기록에는 앱 정확한 버전/build, fixture SHA, 각 open/save/reopen 결과, 오류 문구, 화면 캡처와 저장 파일 hash를 포함한다. 라이선스가 있는 GUI 설치 또는 권한 있는 원격/가상 환경이 선행 조건이다. 내부 XML/HWPX 판정은 외부 결과를 대체하지 않는다.

| 앱 / 입력 fixture (SHA-256) | 절차 | 확인할 결과 |
|---|---|---|
| Word / [`advanced.docx`](../../target/stage7-continuation/native8/run/docx/advanced.docx) `c11b88316f30a9ddec4d4337c2ca02e87b17be748eafa037e2f7e96bfacbd4d9` | 복구 경고 없이 열기; 기존 TOC 갱신 및 별도 사본에 새 TOC 삽입·갱신; heading REF/PAGEREF 교차참조 작성·목표 heading 변경 후 field 갱신; 별도 사본에 PAGE page-number field 삽입; 한국어 편집; hyperlink 일부 선택 영역에 comment; footnote/endnote; Word 저장→geul 재열기·편집·2차 저장→Word 재열기 | 기존 TOC instruction은 있으나 PAGE field 존재는 증명되지 않았으므로 새 삽입 절차로 확인. 무관 문단/style/link/notes 보존 |
| Word / [`advanced-tracked.docx`](../../target/stage7-continuation/native8/run/docx/advanced-tracked.docx) `1b00ad94a9965fb7d3fd9d1113cebfb316b29ca6c6ee0ab99cb79008ec2a9e38` | 복구 없이 열기; 추적 상태에서 새 한국어 insertion/deletion 생성, 기존 insertion/deletion을 별도 복사본에서 각각 accept/reject; comment/hyperlink subselection·notes·한국어; Word 저장→geul reopen/edit/second save→Word reopen | accept/reject 상태와 주변 무관 콘텐츠·수정기록·관계 보존 |
| Hancom / [`native-formula.hwp`](../../target/stage7-continuation/native3/run/advanced/native-formula.hwp) `10f1d3e3b1e79a9bd8b2827bed0b1353f27a80b43e664af08a90bef47b9685d5` | 열기; width/spacing 180/10과 반복 서식·원래 스타일; formula `=1+2`, 결과 `3`, 편집 가능성; 별도 사본에서 A1=10/B1=20, `=SUM(A1:B1)` 결과30, A1=11 후 명시적 재계산31·참조식 유지; Hancom 저장→geul reopen/edit/second save→Hancom reopen | 수식 표현/결과와 무관 서식 보존. 제품 mutation gates는 계속 disabled이며 controlled test에서도 명시된 시험 경로만 사용 |
| Hancom / [`native-formula.hwpx`](../../target/stage7-continuation/native3/run/advanced/native-formula.hwpx) `939c45877f2aae427c56fa7cedb4ac8e2ec97a72ac981374db89afed8373ef21` | HWP와 같은 formula, repeated formatting, references/recalculation 및 양방향 저장·재열기 | fixture는 geul 생성물이다. Hancom-authored formula HWPX fixture를 별도 확보 |
| Hancom / [`calc-cell.hwp`](../../external/rhwp/samples/calc-cell.hwp) `e22c45dc65998ec3da6000b897f17a88f41dc6fceefeefabacea1fd0785716b3` | 복사본으로 열기; 편집 없는 preview 확인 후 controlled 사본에서 formula edit/save 시도 | stale preview가 남는 geul output의 safe refusal이 현재 기대 결과다. refusal 때 원본 hash 보존 확인. preview policy를 우회하지 않는다 |

Word/Hancom 실제 GUI 권한·앱 버전·fixture copy 경로가 기록되기 전까지 외부 행은 NOT RUN이다. Hancom-authored formula HWPX fixture도 준비 조건이다. 외부 호환 수정이 입증되지 않았으며 T013 완료를 주장하지 않는다.

### 검증 명령과 evidence

실제 WASM 세션 명령은 `VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 VITE_GEUL_TEST_RHWP_FORMAT=1 VITE_GEUL_TEST_RHWP_FORMULA=1 npx vitest run --config scripts/tests/vitest.config.ts table-formula-session`이다. 최종 B2는 `GEUL_HISTORY_SAVE_OUT`을 `target/remaining-work/b2-service-reviewed-inputs`의 절대 경로로 지정했다. 같은4개 test flag로 `npx vitest run --config tests/integration/rhwp/vitest.config.ts undo.wasm format-save.wasm multisection.wasm`는37 PASS/1 SKIP이었다. `npm run typecheck`, `npm run lint`, 마지막 시험 파일의 `npx eslint scripts/tests/table-formula-session.wasm.test.ts` 및 별도 `npx tsc --noEmit -p target/remaining-work/tsconfig-publication.json`도 PASS다.

최종 native 명령(공개 문서에는 workspace-relative 경로로 표기하며 실제 resolved 절대 경로는 로컬 integrity report에 보존)은 `python3 scripts/external-integrity.py --require external/rhwp --writable target/rhwp-wasm --report target/rhwp-wasm/b2-native-reviewed-integrity.json -- env CARGO_TARGET_DIR=target/rhwp-wasm cargo test --manifest-path target/rhwp-patched-source/Cargo.toml --locked --offline -p rhwp --lib geul_publication_`(5 PASS), Release는 lock과 같은 wasm-bindgen0.2.127 PATH로 `scripts/build-rhwp-wasm.sh`다. 실제 integrity report filename은 `target/rhwp-wasm/b2-native-reviewed-integrity.json`이다. backend는 B1에서 `python3 scripts/cargo-geul.py test --test t010_phase0_save_service --no-run`으로 보호 compile한 동일 Rust/WordCraft 신원의 binary를 재사용했다. 서비스 runtime은 위 table의 exact ignored test에 private absolute TMPDIR와 GEUL_T010_MANIFEST/RESULTS를 지정했다.

| 항목 | 실행/결과 | evidence 및 해석 |
|---|---|---|
| A | `git ls-remote https://github.com/MinGyu2/wordcraft.git`; fresh clone exact-SHA fetch 실패(exit 128, `not our ref`); `python3 scripts/cargo-geul.py build --bin geul` PASS | `target/remaining-work/a/report.txt`, `a/geul-build.log`; checkout build는 fresh submodule fetch 증거가 아님 |
| B1 | Release WASM race 33 PASS; `npm test -- src/components/Editor/save.test.tsx src/components/Editor/saveDurability.test.tsx src/components/Editor/rhwp/rhwpHistory.test.ts src/components/Editor/rhwp/RhwpEditorSession.test.ts` 82 PASS; lint/typecheck PASS | `b1-verification-wasm.log`, `b1-session-tests.log`, `b1-lint.log`; 수정 전 재현 `b1-before.log` |
| B1 service | 기존 `t010_phase0_save_service` exact ignored test를 private absolute `TMPDIR`로 실행; HWP/HWPX 4 durable publication/reopen PASS | `b1-service.log`, `b1-service/results.json`, `b1-service/reopened-model.json`; 기존 compiled service binary 사용 |
| B2 | Release WASM history 51 PASS; frontend 82 PASS; RHWP focused native 5 PASS; service 20 chains/66 게시 시도(64 durable 게시·2 정상 거부) PASS; saved-file reopen 18 PASS | `b2-wasm-reviewed.log`, `b2-native-reviewed.log`, `b2-service-reviewed.log`, `b2-reopen-reviewed.json`; 이번에 전체 legacy suite를 실행한 것은 아님 |
| C | isolated `scripts/tests/native-d2-order.py`; sync/async 각 6 editor + 3 textarea trace; 저장된 trace assertions 12 PASS; py_compile PASS | `c-native-async/`, `c-native-sync/`, `c-trace-validation.json`; E→U→F 0회, INCONCLUSIVE. runner survivors 0 |
| D internal | `node target/remaining-work/d-preview-input.mjs`; current Release WASM reopen driver; precompiled `src-tauri/target/debug/deps/t010_phase0_save_service-4f13e83260bc0eb8 --ignored --exact 진짜_엔진_출력을_저장_서비스에_넣는다` (private `TMPDIR`, 2 manifest rows), exit 0/test PASS | `d-fixtures.json`, `d-internal-reopen.json`, `d-preview/service/results.json`; 두 행 모두 stale-preview refusal이지 Office 결과가 아님 |
| Word/Hancom | NOT RUN | 앱/세션 부재: `d-application-access.json`; 위 수동 절차 pending |

전체 WordCraft CI와 RHWP Clippy는 이번에 재실행하지 않았다. 과거 보고서의 WordCraft static `file_access` failure 및 RHWP Clippy 41 diagnostics는 그 당시의 분류이며 이번 재확인 결과로 표현하지 않는다. 이 후속 작업에서 전체 frontend suite를 새로 실행한 것도 아니다. D4 성능 측정·구현·acceptance threshold는 제외했고 기존 gate를 변경하지 않았다.
