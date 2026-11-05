# Stage 5–7 통합·수용 재검증 (2026-11-05)

실행 기간: 2026-11-05~11-06 KST. 문서 파일명의 날짜는 착수일이다.

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
