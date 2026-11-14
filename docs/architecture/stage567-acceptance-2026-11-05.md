# Stage 5–7 통합·수용 재검증 (2026-11-05)


<a id="wordcraft-rust-hwp-final-20261109"></a>

## CURRENT — WordCraft·geul Rust·HWP 최종 검증 (2026-11-09)

실행 순서는 B→C→A다. 기준 geul은 `a9609bbcd635f874a6af8996ade58a2d10b8c951` (`master`), WordCraft gitlink/local HEAD는 `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5`, RHWP gitlink는 `1a76570e833917d15817415a53c09ad61ab3203f`다. 원본 unknown record가 RHWP export 중 사라진 뒤 빈 미리보기 저장이 허용되던 결함을 수정해 geul 로컬 커밋 `8bf22c1e8b042458a2e7087ad5cc879f479c7b22`를 만들었다. WordCraft gitlink는 바뀌지 않았고 geul은 push하지 않았다. RHWP Release generation `342ebaad964f911b8dc83fe9cb7eaca5ee2625486336c3690c01ea16f0396bdc`, active patch count 15는 그대로다.

### Package B — WordCraft local UI and full CI

회귀의 원인은 문서 캔버스에서 리본/상태바 chrome으로 포커스가 이동한 다음, `canvas.want_focus`가 캔버스 레이아웃 시점에 처리되어 바로 뒤의 키 이벤트보다 늦게 복구되던 것이다. 수정은 현재 캔버스 위젯의 focus ID와 문서 키보드 필터를 기록하고 chrome 클릭 프레임 안에서 포커스를 복구한다. 실제 TextInput, dialog, menu/popup에 대한 기존 예외를 유지한다. 검증된 커밋의 변경 파일은 `crates/ui-egui/src/canvas.rs`, `crates/ui-egui/src/lib.rs`, `ROADMAP.md`, `docs/gaps.md`, `docs/ui-parity.md`다. 원래 `clicks_on_ribbon_and_status_bar_chrome_keep_typing_in_the_document`의 스타일 적용·탭/checkbox·빈 영역·view 버튼·언어 메뉴 취소·폰트 크기 입력 검증을 약화하거나 제거하지 않았다. 별도 새 회귀는 입력 전 같은 caret/selection 및 바로 다음 Text/Arrow 이벤트를 확인한다.

| 검증 | 실행 및 결과 |
|---|---|
| 변경 커밋 | 기존 `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5`; 중복 수정 commit 없음 |
| focused UI | `cargo test --manifest-path external/wordcraft/Cargo.toml --locked --offline -p wordcraft-ui-egui chrome`, protected wrapper exit 0; 4 passed/0 failed. 원래 회귀와 신규 즉시 포커스 시험 모두 PASS |
| full CI | `cargo run --manifest-path external/wordcraft/Cargo.toml --locked --offline -p xtask -- ci`, protected wrapper exit 0; fmt, clippy, workspace tests, assets, layers, WASM 6단계 모두 PASS |
| 결과 수 | workspace 2,080 PASS / 0 FAIL / 2 ignored; engine 453 PASS; UI 388 PASS / 2 ignored; assets 54, layers 20, WASM 16 crates |
| toolchain / integrity | WordCraft CI 환경에서 관측 `cargo/rustc 1.99.1`; `GEUL_SANDBOX=userns-root-bwrap` integrity wrapper PASS, source/status unchanged |

증거는 `target/final-verification-20261109/{targeted.log,targeted-integrity.json,full-ci.log,full-ci-integrity.json}`다. CI에서 사용한 실행은 local 소스 `dc25d8a`를 검증했다.

### Package C — authorized WordCraft publication and remote reproducibility

사전 remote tip은 `b39a8fb49c6fefbdd960792f2a4effd0d7660e3c`였고 `dc25d8a`의 조상이었다. 검토한 outgoing 8 commits는 순서대로 다음과 같다: `af80638f65f93e9bea5091f7cf69c6075942d809`, `b74830b293a49801b385b81efae865d65c905070`, `6c994e42dee106ca03c6f11628d2fe577fe27636`, `615697c6d9b0af3a2cd05026576ddff28c7deecf`, `077be5db9be28f26ea23940a2ef71786037aa393`, `4b90d31c67643f42aac8dedc38e2de0da92c238a`, `71b912edf6ff9398940bb1026b7b1cfa2a2505d9`, `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5`.

첫 HTTPS 인증 시도는 자격증명을 읽을 수 없어 exit 128로 끝났다. SSH 인증 경로를 확인한 뒤 command-scoped URL rewrite를 적용했고, remote 설정은 바꾸지 않았다. 사전 보안 검사는 8 commit gitleaks exit 0/0 leaks, 29 outgoing commit version에 새 민감정보 finding 0이었다. 전체 파일 scanner의 7 finding은 공개 baseline의 기존 false positive와 일치해 결과를 유지했고 억제하지 않았다. WordCraft에 설정된 active push hook은 없었다. 정상 fast-forward push는 지정 저장소/브랜치에 한 번 실행했으며 force, `--no-verify`, tag를 사용하지 않았다. 인증을 위해 명령 단위 URL rewrite로 HTTPS remote를 기존 SSH 인증에 연결했고 Git remote/config는 바꾸지 않았다.

`https://github.com/MinGyu2/wordcraft.git`의 `refs/heads/geul/semantic-roundtrip-equivalence` push exit 0, 원격 변경 `b39a8fb..dc25d8a`; 이후 `ls-remote` tip은 정확히 `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5`였다. 독립 full WordCraft HTTPS clone에서 exact SHA fetch/detached checkout, branch-tip equality, `git cat-file`, `git merge-base --is-ancestor b39a8fb dc25d8a`, `git fsck --full --strict --no-reflogs`, clean worktree가 모두 exit 0이었다. reference clone/alternates/environment object borrowing은 없었다.

공개 geul `a9609bbcd635f874a6af8996ade58a2d10b8c951`을 별도 clone해 지정한 그대로 `git submodule update --init --depth 1 external/wordcraft`를 실행했고 exit 0이다. 부모 gitlink·fresh WordCraft HEAD는 모두 `dc25d8a`; submodule commit object가 있고 worktree clean, alternates 없음. Fresh clone의 `cargo metadata --no-deps --format-version 1 --locked --offline`도 exit 0이며 `wordcraft-engine` path가 초기화된 submodule 안으로 해석됐다. 따라서 이 public gitlink의 원격 재현성은 VERIFIED다.

### Package A — geul Rust and HWP actual save/reopen

geul Rust 1.99.0을 선택해 `scripts/cargo-geul.py` protected wrapper와 기존 `src-tauri/target` cache를 사용했다. 아래 표는 `src-tauri` 디렉터리 기준이다. 모든 명령 exit 0, wrapper integrity PASS/unchanged였다:

| 명령 | 결과 |
|---|---|
| `python3 ../scripts/cargo-geul.py fmt --check` | PASS |
| `python3 ../scripts/cargo-geul.py check --lib --bins` | PASS |
| `python3 ../scripts/cargo-geul.py clippy --lib --bins -- -D warnings` | PASS |
| `python3 ../scripts/cargo-geul.py test --lib services::save` | 163 PASS / 0 FAIL / 15 ignored |
| `python3 ../scripts/cargo-geul.py test --lib adapters::wordcraft` | 80 PASS / 0 FAIL / 1 ignored |

GitHub Actions run `42562001193`의 재실행 결과: Rust job `128986325992`와 frontend job `128986327855` 모두 completed/success. 이 workflow는 공개 geul 기준 SHA `a9609bbcd635f874a6af8996ade58a2d10b8c951`을 검증했다. 새 로컬 HWP commit `8bf22c1e8b042458a2e7087ad5cc879f479c7b22`은 push하지 않았으므로 GitHub Actions 검증 대상이 아니다. Rust 단계는 pinned WordCraft shallow submodule fetch, Rust toolchain, cache/dependency preparation, fmt, check, clippy까지 PASS; frontend typecheck/lint/build도 PASS다. workflow run ID가 같아도 확인한 것은 최신 attempt의 job 결과다. 단계별 결과는 `target/final-verification-20261109/rust/remote-job.json`에 있다.

#### First-paragraph fail-closed classifier

기존 classifier commit `6afc29560f13e270668b737e359bc52cd408cf7f`의 `blank_paragraph_text`/`first_paragraph_visible`는 export 결과의 유한한 알려진 metadata/control/text 구조와 ownership을 확인한다. 최종 수정 `8bf22c1e8b042458a2e7087ad5cc879f479c7b22`는 export 전에 원본 첫 문단도 알려진 구조인지 요구해, 알 수 없는 직접·중첩 record가 export 중 누락되어도 안전한 blank 증거로 세탁되지 않게 한다. 원본의 정상 UTF-16 텍스트(유효한 BMP 및 surrogate pair 포함)는 삭제할 수 있고, lone high/low surrogate는 거부한다. 알 수 없는 direct/nested record, 예기치 않은 nesting, invalid control header, malformed UTF-16, truncated extended control, invalid paragraph metadata, unknown control parameters, 잘못 놓인 page-definition record 및 text/control ownership 불일치는 blank 증명에 실패해 거부된다. 유효한 빈 문단, 합법적인 비도화 문단 metadata, 지원된 section/column controls는 긍정 경계로 남는다. 이전 transient `cfg(test)` probe는 이전 classifier 경계의 27 negative/3 positive 사례를 확인(exit 0)했고 임시 instrumentation은 복구됐다. 최종 영구 회귀는 original direct/nested unknown record가 export 중 사라지는 경우, 정상 BMP/emoji, lone high/low surrogate를 포함한다. 확장된 service regression은 원본 bytes, dirty/revision, recovery ownership 및 부분 publication 부재를 확인한다. 이는 classifier/backend/service 직접 근거이며 모든 malformed 변형을 GUI에서 각각 실행했다는 뜻은 아니다. `PreviewStale` 저장 정책은 유지한다.

#### Actual native positive save chains

이전 일반 `cargo` launch는 개발용 localhost URL을 사용할 수 없어 실제 앱 문서 화면 진입에 실패했고 그 시도에서 저장은 실행되지 않았다. 그 뒤 verified Release assets를 사용하는 protected `cargo build --bin geul --features tauri/custom-protocol`가 exit 0으로 끝났다. 실제 X11/IBus에서 실행한 두 성공 시나리오는 모두 앱으로 열기 → 지원 편집 → 첫 durable save → disk reopen → 후속 edit → 두 번째 durable save → final reopen을 거쳤다. control/mocked backend의 응답만으로 성공 처리한 save는 없다.

| 시나리오 | native app checks | 독립 저장본 checks | 실제 durable save SHA-256 |
|---|---:|---:|---|
| HWP genuine blank page | 8/8 PASS | `verify-hwp-blank-preview.py` 18/18 PASS | first `df2cb1079ddb06c479906d3696d0d706b9ac5714f044d152c7781abc8d4e9411`; second `ff4cd7ef0104157be0f69299eeee5177b2597c91eee9288b8043051dea306b1a` |
| `calc-cell.hwp` formula edit | 10/10 PASS | independent verifier 21/21 PASS | first `93d265245036f6b9911cbd518865babff528c68709bf5e1c71e9c8b7d9027489`; second `cc627a3ffe0424dbe8d85875d3cff1dc77a9573e1e1b1b0fc2f5d77c4045d418` |

둘 다 canonical `PrvImage`가 PAGE_DEF에서 유도한 724×1024 크기이고, 두 번째 저장 후 재열기까지 이미지·본문 결과를 검증했다. blank 케이스는 `PrvText` CRLF, 원래 GIF 미리보기 제거, 독립 렌더와 빈 페이지 일치를 확인했다. calc 케이스는 formula cell 출력과 reopen를 확인했다. 두 fixture에서 관련 없는 CFB streams는 byte-identical이고 stream set도 기존과 같다. 최종 앱 SHA-256은 `06ee1acc930a303342c77a642f4eacef8ce36148247967985421fa5ff380c75c`; 앱은 커밋 전에 빌드됐으며 당시 HEAD `a9609bb`에 적용한 두 Rust 파일의 검증 해시는 local HWP commit `8bf22c1e8b042458a2e7087ad5cc879f479c7b22`의 파일과 일치한다(`rust-final/source-identity.json`). Toolchain은 1.99.0, feature `tauri/custom-protocol`, assets는 검증된 RHWP Release였다.

최초 native unknown-record control에서는 원본 fixture의 tag 1023 unknown record가 export 중 사라져 save가 성공하는 결함을 재현했다(`native/unknown-refused/result.json`; 수정 전 direct regression도 exit 101). 수정 후 같은 native 경로에서 6/6 PASS로 `UnsafeSave`와 `PreviewStale`의 PrvText/PrvImage 거부를 확인했고 원본 hash는 그대로, dirty=true, revision/localRevision=100, 부분 publication 없음(`native/unknown-fixed/result.json`). malformed UTF-16·기타 unknown 구조의 거부는 direct Rust/service 근거이며 전체 변형을 GUI로 실행하지 않았다. native PASS는 두 positive durable-save/reopen chains와 이 단일 unknown-record negative control이다.

기계 판독 결과와 로그: `target/final-verification-20261109/verified-summary.json`, `classifier-probe/{run.log,integrity.json,restored.json}`, `native/{blank-final/result.json,calc-final/result.json,unknown-fixed/result.json,blank-final-verified.json,calc-final-verified.json,cleanup.json}`, `rust-final/`(최종 HWP 소스 검사·빌드), `rust/`(기준 소스·어댑터·원격 CI), `fresh-wordcraft-checkout.json`, `fresh-geul-submodule.json`, `published-remote.json`, `push-result.json`. 이전 시도/오류는 target 로그에 남고 이후 성공의 근거와 섞지 않는다.

### 현재 미완료 수용

- T010 **INCOMPLETE**; 일반 RHWP 입력 history와 미검증 고급 기능은 NO-GO. D2 **INCONCLUSIVE**; D4 latency **FAIL**, resources **INCONCLUSIVE**. 원래 측정·predicate를 변경하지 않았다.
- T012 **△ 조건부 미완료**: HWP 미리보기의 이중 blank 증거, 알 수 없는 첫 문단 구조의 fail-closed 거부, 실제 blank/calc 두 회차 저장·재열기와 기존 병합 표·지원 수식/순환 감지 부분집합을 확인했다. Hancom Office GUI와 나머지 독립 acceptance는 NOT RUN/미완료다.
- T013 **△ 조건부 미완료**: WordCraft gitlink의 remote reproducibility는 VERIFIED. DOCX의 문단 간 bookmark 경계를 보존하고 지원 대상 제거 뒤 TOC를 갱신한다. 대상을 잃는 비-TOC 내부 링크·잘못된 표식·재생성할 수 없는 TOC 대상 제거를 원자적으로 거부하며 semantic round-trip 검증을 유지한다. Microsoft Word 외부 호환성은 NOT RUN이라 전체를 완료하지 않았다.
- Word/Hancom external compatibility **NOT RUN**. 외부 호환성 PASS를 내부 저장·재열기나 WordCraft CI로 추론하지 않는다.
- T009 strict preflight, original-file integrity, atomic publication, durable-save/revision/dirty checks, recovery ownership and preview freshness/content preservation remain in force.


실행 기간: 2026-11-05~11-06 KST. 문서 파일명의 날짜는 착수일이다.

> **2026-11-06 시점 최신 후속 판정 (historical): PARTIALLY COMPLETED.** B1 저장 중 편집 race와 B2 게시 전 Undo snapshot 복구는 각각 재현·수정·검증되어 별도 로컬 커밋됐다. D2 격리 native 조사에서 E→U→F는 여전히 0회 관측되어 INCONCLUSIVE이며 기존 predicate와 제품 입력/history 코드는 바꾸지 않았다. WordCraft pin은 현 원격 ref에서 clean fetch할 수 없어 A는 BLOCKED다. Microsoft Word와 Hancom Office가 없는 환경에서 D 외부 수용은 NOT RUN; 내부 파일 검증과 stale-preview 안전 거절만 기록했다. T012/T013은 완료하지 않았고 제품 RHWP Undo/Redo·장평/자간·영속 수식은 계속 비활성이다. D4는 이번 작업에서 제외했으며 기존 gate를 변경하지 않았다. 상세·증거·남은 수용 조건은 아래 2026-11-06 후속 기록을 따른다.

2026-11-06 시점 결론 (historical): **Stage 5/6/7 PARTIALLY COMPLETED, T012/T013 미완료, 제품 RHWP history·장평/자간·영속 수식 NO-GO**. 엔진 구현·실제 WASM·저장 서비스·실제 Tauri 검증을 구분한다. D2의 필수 순서는 관측되지 않았고 D4 원래 문턱을 넘었다. 과거의 native NOT RUN은 아래 실행 범위에 대해서만 대체한다. Word/Hancom 호환성은 NOT RUN이다.

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

### 2026-11-06 P2 reliability follow-up (partial)

Repository started at `f66fe0f0cbfa7777acbf90bab66a5bf2063ac613` on `master`; WordCraft/RHWP gitlinks remain `6c994e42dee106ca03c6f11628d2fe577fe27636` / `1a76570e833917d15817415a53c09ad61ab3203f`. The 14-patch series, Release generation `8087a8415e32e254846a745808083bb2c9c6c0fc85504345f88d825defcf71b7`, and source identity `f221f3f36a529d868f47a0feb54c4d552070d835070e989322035ad255427ed4` were unchanged; no WASM rebuild.

P2-1 is unresolved and uncommitted. Actual Release probing (`target/p2-reliability/identity-probe.log`) confirmed both matching identity for simple metric serialization and a reachable equal-count/different-definition HWP bold case. A proposed exact reopened comparison failed 23 existing HWP B1/B2 cases and was removed. The full requested A–M publication matrix, HWP/HWPX service publication and race scenarios remain incomplete. No speculative count-only correction was made; T009 remains authoritative.

P2-2 is implemented as a focused initialization correction. Prefix construction moved before backend ready; injected constructor failures normalize to `EngineFailure(init)`, transition loading to failed, and release the document. Malformed unusable prefix is rejected; rejection/stale completion releases document and prefix exactly once in the exercised controlled cases. History initialization failure retains the existing healthy-load/history-unavailable behavior. Focused frontend suite: 88 PASS; Release publication session WASM: 51 PASS; RHWP undo/format/reopen WASM: 37 PASS, 1 optional skip. `npm run lint` PASS. `npm run typecheck` initially failed TS2339 on test-double API assignments; changing the test injection to `Object.assign` corrected it, and the final typecheck and six focused tests PASS. Detailed logs are under `target/p2-reliability/final-*.log`. No engine build or push was performed.

Secondary status unchanged: WordCraft remote reproducibility remains BLOCKED because the required pinned revision is unpublished; no refetch was made here. D2 remains INCONCLUSIVE (E→U→F not observed; no new native hypothesis). Word/Hancom external compatibility remains NOT RUN due no new authorized application evidence. Production RHWP commands remain disabled; T012/T013 are not complete. D4 was excluded and its gate unchanged.

Verification commands: `npm test -- src/components/Editor/rhwp/prefixInitialization.test.ts src/components/Editor/rhwp/RhwpEditorSession.test.ts src/components/Editor/rhwp/rhwpHistory.test.ts src/components/Editor/save.test.tsx src/components/Editor/saveDurability.test.tsx`; `npm run typecheck`; `npm run lint`. WASM commands use `VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 VITE_GEUL_TEST_RHWP_FORMAT=1 VITE_GEUL_TEST_RHWP_FORMULA=1` with `npx vitest run --config scripts/tests/vitest.config.ts table-formula-session` and `npx vitest run --config tests/integration/rhwp/vitest.config.ts undo.wasm format-save.wasm multisection.wasm`. The optional format-save generator skips without `GEUL_FORMAT_SAVE_OUT`; no new native save-service run is claimed.

### 2026-11-06 P2-1 implementation milestone (Phase 5 pending)

P2-1 adapter lease gap was reproduced with controlled injection: `markPublished(5)` without a validated lease promoted baseline 3. The adapter now requires a pending validated export identity lease and the matching count before baseline promotion. The engine's new serializer-projection capture handles observed HWP raw-data/attribute normalization while preserving HWPX writer identity. It captures live definitions only after the reopened export is proven ID-by-ID. No T009 comparison or save-service code was changed. Active patch count remains14; gitlinks are unchanged. The official Release build and hashes are recorded in [`save-preservation`](save-preservation.md#2026-11-06-p2-1-serializer-identity-correction-verified-wasm-real-service-follow-up-pending).

P3 evidence: frontend focused 88 PASS, adapter identity 9 PASS, actual Release identity 15 PASS, actual Release B1/B2 session 51 PASS, typecheck/lint PASS. Logs: `target/p2-continuation/p3-{frontend,publicationIdentity,typecheck-fixed,lint,wasm-identity,wasm-regressions}.log`. Phase1/2 diagnostic service matrix is real, but generated fixtures and does not replace the requested full final acceptance. Phase5 service matrix over all generated race/history outputs, cleanup/error-boundary review and final commit remain pending; no completion claim yet. P2-2 commit `4ba1e3774013d96f0ad651f02bdb8b008293a3f5` is retained.

P3 focused native publication tests: 7 PASS (`target/p2-continuation/p3-native.log`, protected integrity report `p3-native-integrity.json`). Initial native compilation lacked existing test-only fixtures; read-only links to pinned samples/tests/ttfs were used and removed, then prepared-source provenance was reverified. Script-test TypeScript initially lacked the createBlankDocument declaration; the corrected declaration passes `npx tsc --noEmit -p target/p2-continuation/tsconfig.json` (`p3-script-types-fixed.log`). No engine rebuild was needed for that test-only type declaration.

### 2026-11-06 P2-2 cleanup audit

P4 audit added only controlled failure coverage: count trap plus document free trap, structured stale ready refusal with prefix/document/both release traps, raw `setState` promise rejection followed by reload, and disposal while ready is pending followed by stale completion. Seven new prefix-cleanup tests, six prior initialization tests, and nineteen `RhwpEditorSession` tests pass (`target/p2-continuation/p4-after-final.log`; 32 total). `createTauriBackend` rejection normalization/session tests: 15 pass (`src/adapters/adapters.test.ts`, direct command result). The assigned path `src/adapters/backend.test.ts` is absent; Vitest's invocation containing that nonexistent path silently ran only the other three suites, so it is not counted as backend coverage (`p4-adapter-regressions.log`). `npm run typecheck` and lint were reported PASS by the main implementation run (`p4-typecheck-final.log`, `p4-lint-final.log`).

A cleanup exception no longer masks the initial/structured backend error or prevents attempting release of the other resource. When either release throws, status records `cleanupFailed: true` but the disposed initialization does not claim a live uncertain model. Fault injection cannot prove actual engine deallocation succeeded after a trap; code ensures one attempt per owned reference. A duck-typed callable `free()` cannot validate an arbitrary wasm pointer in TypeScript; the real binding yields its engine wrapper, and wasm-bindgen checks the class reference when borrowed by another engine method. No actual wasm exception or invalid pointer was induced. P4 implementation and its focused tests are recorded together with this documentation update; P5 real save service final matrix is still pending.

### 2026-11-06 P2 Phase 5 result (Rust save unit gate failed)

실제 Release generation/JS/WASM identity는 위 P3 기록의 동일 artifact다. 실제 save-service 실행 파일 SHA `314c77750e0d04dac24177775f3ceb0b69753ca9bf602f975dc36547c9f172aa`; HWP/HWPX normalization 14개 사례에 첫 게시+Undo 뒤 두 번째 게시, 18 service chains / 62 durable saves / 18 full final-file reopens, byte equality를 기록했다. 세 HWP bold 계열은 strict `recordsChanged` refusal 및 원본 보존, 나머지 11개 normalization 흐름은 양쪽 게시 durable. 전체 detail은 `target/p2-continuation/p5-acceptance.json`, `p5-normalization/summary.json`, `p5-service-summary.json`, `p5-reopen.json`. Fresh registry per service call limitation과 별도 session WASM regression을 고려하며 하나의 실제 live registry가 race를 처리했다고 주장하지 않는다.

최종 실행: `npm test -- src/adapters/adapters.test.ts src/components/Editor/rhwp/publicationIdentity.test.ts src/components/Editor/rhwp/prefixCleanup.test.ts src/components/Editor/rhwp/prefixInitialization.test.ts src/components/Editor/rhwp/RhwpEditorSession.test.ts src/components/Editor/rhwp/rhwpHistory.test.ts src/components/Editor/save.test.tsx src/components/Editor/saveDurability.test.tsx` = 120 PASS (`p5-final-frontend.log`); release session `VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 VITE_GEUL_TEST_RHWP_FORMAT=1 VITE_GEUL_TEST_RHWP_FORMULA=1 npx vitest run --config scripts/tests/vitest.config.ts table-formula-session` =51 PASS (`p5-final-wasm-session.log`); same env + `npx vitest run --config tests/integration/rhwp/vitest.config.ts undo.wasm format-save.wasm multisection.wasm` =37 PASS/1 optional SKIP (`p5-final-wasm-legacy.log`); `npm run lint`, `npm run typecheck` PASS (`p5-final-lint.log`, `p5-typecheck.log`).

선택 Rust 명령 `python3 scripts/cargo-geul.py test --locked --offline --lib services::save`는 **FAIL** exit101, 100 PASS/46 FAIL/15 ignored. 첫 실패는 `src/services/save/tests.rs:3851`에서 test path의 조상에 uid0이 없다는 권한 fixture assertion이고, 다수 save fixture가 `SharedDirectory` 거부를 받아 기대한 테스트 결과 대신 실패했다 (`p5-rust-save.log`). 이 결과를 P2 code regression이나 단순 environmental baseline이라고 판정할 추가 증거가 없다. Rust gate 미통과로 전체 완료라고 표시하지 않는다.

추가 P2-2 경계 재현: readPages 중 exception 뒤 document free exception이 loading failure normalization을 우회하는 baseline 실패 (`p5-page-before.log`). helper 분리 뒤 33 focused init/session tests PASS (`p5-page-after.log`), typecheck/lint PASS. P5 단계의 소스 수정 commit과 Rust gate의 상태는 main의 최종 검토를 기다린다. Production RHWP capability remains disabled, WordCraft BLOCKED, D2 INCONCLUSIVE, Word/Hancom NOT RUN; D4 unchanged/excluded.

P5 최종 점검: 독립 집계는84 durable / 3 strict refusal /18 same-path service chains/18 final disk reopens다. `p5-reopen-refs.json`은 네 셀 각각의 char-shape runs·IDs·속성과 canonical prefix를 18/18 확인한다. 튜플을 잘못 전달했던 harness 실행은 `p5-reopen-refs-harness-error.*`로 보존되고 수정된 실제 WASM API 호출의 후속 `p5-reopen-refs.log`가 최종 증거다. Prefix type probe는 유효 엔진 객체 및 가짜 callable `free` 거부를 확인했다(`p5-pointer-validation.json`); 실제 allocator trap은 시험하지 않았다.

Protected Rust 환경 로그(`p5-rust-environment.json`)에서 외부 UID1000, sandbox UID mapping에서 root→65534, `/`, `/home`, `/tmp` 소유 UID65534를 관측했다. 46 Rust 테스트 실패 중 44개는 root-owned ancestor 또는 결과 `SharedDirectory`와 직접 연관된다. 나머지 2건은 같은 전제로 인한 후속 결과와 일치하지만 개별 진단은 미확정이다. 지원되는 `sudo-bwrap`는 `sudo -n true`가 암호를 요구해 쓸 수 없었고 무보호 fallback은 실행하지 않았다. Rust save suite 100 PASS/46 FAIL/15 ignored는 비통과이며, 이 gate 때문에 작업의 전체 상태는 PARTIALLY COMPLETED다.

P5 readPages/free 예외 처리 수정은 이 수용 기록과 함께 독립 커밋한다. 관련 frontend/typecheck/lint/WASM 검증은 통과했으며 protected Rust gate는 별도로 미해결이다. WordCraft BLOCKED, D2 INCONCLUSIVE, Word/Hancom NOT RUN, production RHWP mutation gates unchanged, D4 excluded/unchanged.

### 2026-11-06 save cleanup / Rust UID / external acceptance follow-up

저장 정리 예외를 주입한 controlled frontend 10개 중 수정 전 7개 실패, 최종 frontend 35 PASS; 실제 Release WASM 66 PASS, legacy WASM 37 PASS/1 선택 SKIP, real save-service 18 chain/62 durable publication PASS다. 결과와 cleanup 제약은 [`save-preservation`](save-preservation.md#2026-11-06-저장-후-prefixlease-정리-예외)에 있다. 이후 backend transport rejection 시 UI가 `saving`에 머무르는 별도 회귀(수정 전 1 FAIL/9 PASS)를 고쳐 원래 transport rejection은 전파하면서 `SaveFailure(write)` 상태와 lease cleanup을 남겼다. 사후 frontend 35 PASS.

B1/B2의 실제 first operation은 둘 다 `Err(SaveUnsupported { reason: SharedDirectory })`였다. B1의 임시 후보는 생성되지 않아 `names=[]`; `names[0]`은 후속 panic이다. B2도 같은 이유로 exact-budget 성공 assert 전에 거부됐다. sandbox `bwrap` 내부 `/`·`/home` 소유 UID는 65534이고 test process uid 1000이며 trusted root ancestor가 없다. 기존 보호 정책을 유지했다. `sudo-bwrap`는 비대화식 sudo 암호 요구로 시작되지 않아 지정된 protected suite를 실행하지 못했다. 이 시도는 suite 통계가 없다. 과거 100/46/15 보고는 유효 gate가 아니다. B1/B2 product/test 수정 또는 fix commit은 없다.

D2 runner는 실패 시점 native trace 저장과 초기 관측 구간 이후 fresh history phase 관측을 보완했다. 두 HWP 완료 trial에서 E74→F87→U121, 취소 E96→U111(no F), 세 번째 취소 assertion 중단이었다. E→U→F는 0회이며 native execution FAIL, D2 INCONCLUSIVE다. 기존 predicate/input은 유지했다. Word/Hancom 실행물·앱 파일·연결 문서 세션이 없어 둘 다 NOT RUN이며 버전/편집 output은 없다. 근거와 상태는 `target/save-cleanup-20261106/` 및 [`rhwp-undo-redo`](rhwp-undo-redo.md#2026-11-06-d2-native-capturephase-follow-up--inconclusive)에 기록했다.

Active WASM generation은 `53b6ad7a4c6de7a8f4ada4c61b0ad1934461e656527f6e6b440f08898bebf6d6`이며 identity manifest에서 JS `3e9c1687af9aabe8ca78c68ab01e569622bcb880341ae4c100faf543782e0027`, WASM `e08e5ce86fad632fde6b7e1051f09597e771ae3924b01685567296a31a453757`, active patches 14개를 확인했다. [`wasm-identity.json`](../../target/save-cleanup-20261106/wasm-identity.json). T012/T013와 production RHWP command gate는 미완료/비활성이다. D4는 제외됐고 기존 실패 gate를 변경하지 않았다.


실행 명령과 검증 범위(작업 디렉터리: 저장소 루트):

| 명령 | 이번 결과 / 증거 (`target/save-cleanup-20261106/`) |
| --- | --- |
| `npm test -- src/components/Editor/rhwp/saveCleanup.test.ts src/components/Editor/rhwp/publicationIdentity.test.ts src/components/Editor/rhwp/prefixCleanup.test.ts src/components/Editor/rhwp/RhwpEditorSession.test.ts src/components/Editor/save.test.tsx src/components/Editor/saveDurability.test.tsx` | A 수정 71 PASS, `frontend.log` |
| `npm test -- src/components/Editor/rhwp/saveCleanup.test.ts src/components/Editor/save.test.tsx src/components/Editor/saveDurability.test.tsx` | backend rejection 수정 후 35 PASS, `backend-state-after.log` |
| `npm run typecheck`; `npm run lint` | 최종 backend 수정 PASS, `backend-typecheck.log`, `backend-lint.log` |
| `npx vitest run --config scripts/tests/vitest.config.ts publication-identity table-formula-session` | A 수정에서 66 PASS, `wasm-session.log` |
| `npx vitest run --config tests/integration/rhwp/vitest.config.ts undo.wasm format-save.wasm multisection.wasm` | A 수정에서 37 PASS/1 선택 SKIP, `wasm-regression.log` |
| `python3` inline 실행으로 저장한 `service.py`를 `exec(compile(...))` | 동일 기존 서비스 binary/Release 입력, 18 chains/62 durable publications, `service-summary.json`; 보호 Rust 전체 gate와 별도 |
| `python3 scripts/cargo-geul.py test --locked --offline --lib services::save::tests::e_임시_파일을_만든_직후의_실패도_이_저장의_임시_파일만_지운다 -- --exact --nocapture` | 임시 진단 소스에서 0 PASS/1 FAIL, `b1-first-operation.log`; Rust 진단 편집 제거 |
| `python3 scripts/cargo-geul.py test --locked --offline --lib services::save::tests::reservation_real_save_exact_budget_and_one_byte_refusal -- --exact --nocapture` | 임시 진단 소스에서 0 PASS/1 FAIL, `b2-first-operation.log`; Rust 진단 편집 제거 |
| `GEUL_SANDBOX=sudo-bwrap python3 scripts/cargo-geul.py test --locked --offline --lib services::save` | BLOCKED, tests 미시작, `rust-valid-mode.log` |
| `python3 target/stage7-continuation/launch.py` | private native launcher, mode2/명령 JSON은 environment-result.json에 기록. 마지막 실행 FAIL, D2 INCONCLUSIVE, `d2-hybrid-fresh/environment/environment-result.json` |

WASM 명령에는 `VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 VITE_GEUL_TEST_RHWP_FORMAT=1 VITE_GEUL_TEST_RHWP_FORMULA=1`을 지정했다. final backend rejection 수정은 35개 focused frontend 및 typecheck/lint로 별도 검증했다. 66/37개 WASM 및 62개 서비스 결과는 첫 A 수정 상태의 검증이며 마지막 수정 이후 새로 실행했다고 주장하지 않는다. native runner 세 번의 private process cleanup survivors는 모두 0이다. trace 보존·fresh phase 관측 보완은 실제 실패 자료와 두 완료 trial을 대조해 검증했으며 전체 native suite PASS를 의미하지 않는다.

### 2026-11-06 신뢰성 후속 실행 기록

코드 기준 HEAD는 `de65a43e0ff583e6fdccd96708900a0eb6c731ae`이고 증거는 `target/reliability-20261106/`다. 이전 표의 FAIL·BLOCKED 기록은 그 시점의 결과로 유지한다.

| 명령 | 결과 |
|---|---|
| `npx vitest run` | 1201 PASS, `final/frontend.log` |
| `npm run typecheck`; `npm run lint` | PASS, `final/typecheck.log`, `final/lint.log` |
| `python3 -B -m unittest scripts/tests/test_external_integrity.py` | 26 PASS, `final/integrity-unit.log` |
| `npx vitest run --config scripts/tests/vitest.config.ts publication-identity table-formula-session` (WASM 시험 플래그 4개) | 66 PASS, `final/wasm-session.log` |
| `npx vitest run --config tests/integration/rhwp/vitest.config.ts undo.wasm format-save.wasm multisection.wasm` (같은 플래그) | 37 PASS / 1 선택 SKIP, `final/wasm-legacy.log` |
| `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --locked --offline --lib services::save` | 146 PASS / 0 FAIL / 15 ignored, `final/rust-save.log`. `sudo-bwrap`은 여전히 NOT RUN |
| `python3 target/stage7-continuation/launch.py` + `native-d2-order.py` | 비동기·동기·hybrid 실행 모두 PASS, D2 **INCONCLUSIVE**, E→U→F 0회, `c/{async,sync,mode2}/` |

실제 서비스 체인(`service.py`)은 다시 실행하지 않았다. 이번 수정은 Rust 저장 코드를 바꾸지 않았고 프런트 세션과 시험 도구만 바꿨다. Word/Hancom 수용은 계속 NOT RUN이고 D4는 다루지 않았다.


### 2026-11-06 advanced A–B acceptance

Baseline geul `1ee94c0235558641416b483e53590e2465e4ce4b`, master, clean index/worktrees. WordCraft `6c994e42dee106ca03c6f11628d2fe577fe27636`, RHWP `1a76570e833917d15817415a53c09ad61ab3203f`. Release generation `53b6ad7a4c6de7a8f4ada4c61b0ad1934461e656527f6e6b440f08898bebf6d6`, 14 patches unchanged. Evidence root: `target/advanced-20261106/`.

A remains **BLOCKED**. A new isolated geul checkout at the baseline ran `git submodule update --init external/wordcraft` and failed `upload-pack: not our ref 6c994e42…`. Remote `geul/semantic-roundtrip-equivalence` still resolves to `b39a8fb49c6fefbdd960792f2a4effd0d7660e3c`; local ancestry is a verified fast-forward with the three required TOC/revision/range-marker fixes. Protected local-pin app build PASS; that does not repair remote reproducibility. No repin, push, or A completion commit. `a/result.json` records exact commands/results. Future separately authorized procedure: verify clean pinned WordCraft, recheck `git merge-base --is-ancestor b39a8fb49c6fefbdd960792f2a4effd0d7660e3c HEAD`, ordinary non-force `git push origin HEAD:refs/heads/geul/semantic-roundtrip-equivalence`, then verify the remote SHA and fresh geul submodule checkout/build. This procedure was **not executed**.

B selected internal mixed matrix is verified. Three modes (retain tracking, selected+all accept, selected+all reject) each combine headings 1/2 and TOC insert/update, ordinary and partial hyperlink comments, footnote/endnote, tracked hyperlink and heading edits, Korean IME-style replacement, and advanced-command Undo/Redo. Each mode makes two actual durable save-service publications with disk reopen between them and a final fresh-session reopen; an unrelated bold Korean paragraph, note bodies, comment count, hyperlink target, heading hierarchy and TOC instructions are asserted. Full `same_as` verifies semantic equivalence including revision metadata/identity. Three relationship-only corrupt outputs are rejected by the actual service with original bytes unchanged, dirty retained, no staging leftovers and save ticket released. The authoritative uncorrupted output is first proven equivalent, so these negatives do not rely on an unrelated text mismatch.

| Layer / exact command | Result / evidence |
|---|---|
| `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --locked --offline --lib services::save -- --nocapture` | 147 PASS / 0 FAIL / 15 ignored; `b-final/rust-save.log`. Final narrowed-negative/TOC assertion change reruns only `--lib mixed_toc_hyperlink_comments_notes_tracking_publish_reopen_edit_publish -- --nocapture`, `b-final/mixed-final.log` |
| `GEUL_SANDBOX=userns-root-bwrap python3 scripts/external-integrity.py --require external/wordcraft --writable src-tauri/target --report target/advanced-20261106/b-final/wordcraft-integrity-absolute.json -- env CARGO_TARGET_DIR=$PWD/src-tauri/target cargo test --manifest-path $PWD/external/wordcraft/Cargo.toml --locked --offline -p wordcraft-engine --test toc_roundtrip --test tracked_roundtrip` | **7 TOC + 4 tracked PASS** (worker summary counted only last binary); identity unchanged; `b-final/wordcraft-engine-absolute.log`. Initial relative manifest attempt did not start Cargo tests and is retained separately |
| Same protected wrapper, `-p wordcraft-docx --test roundtrip tracked_bookmark_markers_round_trip` | 1 PASS; `b-final/wordcraft-marker.log` / integrity JSON |
| `npx vitest run src/commands/reviewTools.test.tsx src/components/Editor/wordcraft src/components/Editor/saveDurability.test.tsx src/components/Editor/save.test.tsx` | 173 PASS; `b-final/frontend.log`. Includes 8 controlled close/reload-during-advanced-response cases; mocks are not native proof |
| `npm run typecheck`; `npm run lint`; protected `cargo-geul.py fmt --check`; protected `cargo-geul.py build --locked --offline --bin geul` | PASS; corresponding `b-final/*.log` |
| `python3 target/stage7-continuation/launch.py` with recorded `GEUL_NATIVE_OUT` and `GEUL_NATIVE_COMMANDS` | actual isolated Tauri/X11/IBus PASS, 16 checks and 10 step saves; native Korean compositionstart/end, TOC+tracked deletion+hyperlink comment+notes, reject/accept all, Undo/Redo, disk reopen/edit/save/reopen. `b-final/native/{environment/environment-result.json,run/docx/result.json}` records complete arguments/environment. Cleanup survivors `[]` |

Native app SHA-256 `97a19f8d6f609a5da0eebba28421cc29ed627e4b7c8882e19f5312b862d2b897`, input `deb325ac9ee59d99d9155f3584b1c458843d1e4b9b11e22e12670cad5d4335e8`; final native DOCX `905457f9550b3f544cbc7d9618de8739275026df28eb581c893037610dba1fb2`, tracked snapshot `461f04ab70ac3e08ebfc2548b0676ac523a8fe241fc05077ae56a12bdf871129`. The native host is a protected dev build with diagnostic frontend flags; it is not a packaged Release or Microsoft Word. Raw engine tests use the exact local pinned source.

Unsupported combination discovered: resolving a tracked deletion of a generated TOC bookmark can leave an orphan marker in pinned WordCraft. Focused correction `ced0c02d84b40dd525efb24526c6c9dc2852a8c7` atomically refuses unroundtrippable TOC/tracking mutations and restores document/history; adapter 78 PASS / 1 ignored, protected fmt/Clippy PASS. Normal heading-text edits are separately exercised, rather than treating a click on the zero-width bookmark as text. T009 predicates were not changed. This is safe refusal, not successful acceptance of the unsupported mutation.

Microsoft Word external GUI interoperability remains **NOT RUN**. B internal acceptance does not complete T013: remote source reproduction and Word external compatibility remain open. D2 INCONCLUSIVE, D4 FAIL/resource INCONCLUSIVE are unchanged. No push.


### 2026-11-06 advanced C — Hancom external NOT RUN

C baseline `4585c2ae14f6cc025d1681888383948c9addb75d`; no product, patch, submodule or generation change. PATH, desktop entries, limited `/opt`/Wine installation paths, Nix profile and connected document sessions contain no accessible Hancom Office/Word installation or authorized document session. No application version or external GUI output exists. External HWP and HWPX formatting/formula interoperability is **NOT RUN**. Genuine Hancom-authored formula HWPX was not identified; HWPX formula inputs below are internal conversions. Accepted genuine-source fixture `external/rhwp/samples/calc-cell.hwp` SHA-256 `e22c45dc65998ec3da6000b897f17a88f41dc6fceefeefabacea1fd0785716b3` remained unchanged. No C compatibility completion commit.

`target/advanced-20261106/c/summary.json` records exact commands, source/artifact identities, all save findings and retained outputs. Current Release generation remains `53b6ad7a4c6de7a8f4ada4c61b0ad1934461e656527f6e6b440f08898bebf6d6`, prepared source tree `5d08748867c6218b2152ec3abc32f9fb9037abd92edffc2581ce237c192f402c`. Existing prepared input manifest and all 14 patch hashes/order matched Release integration; selected JS/WASM hashes matched. No rebuild. The product-only verifier was initially misapplied to `public/rhwp` (which intentionally retains old generations) and rejected its layout; selected immutable-generation validation passed. Product embedding must instead verify the selected `dist/rhwp` tree.

| Internal check | Observed result |
|---|---|
| `node scripts/tests/table-formula-runtime.mjs target/advanced-20261106/c/formula RELEASE.json` | 8 actual Release WASM cases; 22/22 invalid formulas refused, expression/cached result/field identity and other controls preserved, explicit recalculation and snapshot restore checked |
| Protected `t010_phase0_save_service` on those outputs, then `node scripts/tests/table-formula-runtime.mjs target/advanced-20261106/c/formula/sandbox-published RELEASE.json --published` | 6 durable publications and actual published-file reopen PASS; 2 genuine-source HWP cases refused with `previewStale` for PrvText/PrvImage, original unchanged and dirty retained |
| Same protected service on unnormalized original calc-cell copies, two attempts | Both unsafe outputs refused with the same preview findings. Original/copy SHA unchanged, session ready/revision 1/dirty true, directory unchanged. `c/preview/sandbox-integrity-report.json` and `sandbox-results.json` |
| `VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 VITE_GEUL_TEST_RHWP_FORMAT=1 VITE_GEUL_TEST_RHWP_FORMULA=1 npx vitest run --config tests/integration/rhwp/vitest.config.ts undo.wasm format-save.wasm multisection.wasm` | 37 PASS / 1 optional SKIP (format-save output directory not set). Controlled internal test, not Hancom/native acceptance |

Protected service setup failures are retained: first output subtree was read-only; after allowing that evidence subtree, project-path fixture publication was refused `shared-directory` because userns maps host root-owned `/home` to UID 65534. Final runner creates owned private fixture copies under sandbox `/tmp`, keeping source/submodules/Git read-only and preserving all trust predicates. It uses `GEUL_SANDBOX=userns-root-bwrap python3 scripts/external-integrity.py --require external/wordcraft --writable src-tauri/target --writable target/advanced-20261106/c/formula --report target/advanced-20261106/c/formula/sandbox-integrity-report.json -- python3 "$PWD/target/advanced-20261106/c/formula/sandbox-run.py"`; direct-preview invocation adds `C_EVIDENCE_KIND=preview` and its separate writable evidence subtree. Exact child Cargo command and temporary-path mapping are retained in reports. Passing test-executable exit alone was not treated as successful publication; every result row and final disk bytes were checked.

There is no demonstrated safe regeneration of the genuine calc-cell PrvImage. T009 refusal is retained; it is **not** successful formula-save compatibility. Two internal saves/reopens or XML well-formedness cannot establish Hancom behavior, seven-language rendering or genuine Hancom formula HWPX support. C2/C4 external acceptance and full T012 remain incomplete; continue separately authorized D work.


### 2026-11-06 advanced D — conditional production implementation

[사용자 승인](../planning/spec.md#conditional-advanced-20261106)과 [고급 전용 기록 계약](rhwp-undo-redo.md#advanced-only-history-20261106)에 따라 지원 부분집합의 제품 명령을 구현·활성화했다. 일반 RHWP 입력 history는 켜지 않고, `EngineSupport.historyScope: advanced`와 실제 세션 기록을 함께 검사한다. 원본 128 KiB 이하·현재 8쪽 이하, 최대 4고급 단계다. 일반 입력/IME는 snapshot을 만들지 않으며 다른 편집 전에 고급 기록을 폐기한다. `forget()` 뒤에도 초기 메모리 기준/증가 감시는 유지한다. 고급 엔진 호출이 변경 뒤 예외를 내면 트랜잭션의 before snapshot 복구를 시도하고, 복구 성공도 엔진 건강 PASS로 보지 않고 uncertain/failed로 격리해 저장을 막는다. 복구/폐기 자체의 trap도 fail closed다.

| 검증 계층 | 현재 관측 |
|---|---|
| 모든 시험 훅 0, 실제 Release WASM `npx vitest run --config scripts/tests/vitest.config.ts advanced-production table-formula-session` | 59 PASS (`d-final/production-wasm.log`): 기존 publication/history matrix 51 + 제품 기본값/본문/IME/한도/수식 재계산/실제 변경 뒤 예외·rollback/폐기·할당 실패 8. backend 응답은 controlled이며 실제 게시 증거와 구분 |
| 일반 history 시험 훅 1, `publication-identity table-formula-session` | 66 PASS; 기존 general-history 경로 회귀. 공식 D2/D4 native predicate나 수용 PASS가 아님 |
| 훅 1, `undo.wasm format-save.wasm multisection.wasm` | 37 PASS / 1 선택 SKIP. 기존 history와 multi-section 계약 회귀 |
| `npx tsc --noEmit -p target/advanced-20261106/d-final/tsconfig-advanced-tests.json` | PASS; 실제 WASM 시험 스크립트 타입 검사 |
| 모든 훅 0, 전체 `npx vitest run` (중간 기록) | 최초 1248 PASS / 2 FAIL: 과거 리본 tooltip이 무조건 engineUnsupported를 기대했음. 새 부분집합에서는 선택 필요/빈 기록 사유로 정확히 거부함. disabled·무변경·revision 검사 유지하며 기대 사유만 새 계약에 맞춘 뒤 해당 `src/components/Ribbon/Ribbon.test.tsx` 33 PASS (`ribbon-final.log`). 나머지 코드/시험의 유효한 통과 결과는 재사용 |
| ko/en 실제 입력창 | 4 PASS: 소유된 기존 수식 prefill, 같은 식 Enter 적용으로 재계산 요청, 새 식 빈 칸, 문법 오류 거부. 엔진 의미는 별도 actual-WASM 시험이 확인 |

정상 Tauri 빌드 최초 시도는 sandbox 안 CWD가 `/`여서 프로젝트 발견 전에 실패했다(오래된 Release binary는 시험하지 않음). 보호 탐침은 상대 프로젝트 False·절대 프로젝트 True를 확인했다(`d-final/cwd-probe.log`, `cwd-integrity.json`). `scripts/tauri-geul.py`는 동일한 읽기 전용 sandbox 안에서 검증한 저장소 root로 이동한 뒤 CLI를 exec하도록 좁게 고쳤다. `/`에서 시작한 경로·리터럴 인자 회귀 1 PASS (`build-cwd-unit.log`). 권한·네트워크·source/Git 보호·locked/offline 의무는 그대로다. 최종 결과는 아래에 있다.

**최종 빌드 신원.** `GEUL_SANDBOX=userns-root-bwrap VITE_GEUL_TEST_HOOKS=0 VITE_GEUL_TEST_RHWP_HISTORY=0 VITE_GEUL_TEST_RHWP_FORMAT=0 VITE_GEUL_TEST_RHWP_FORMULA=0 python3 scripts/tauri-geul.py build --no-bundle`, 앱 SHA-256 `987cee7ec7c777856a4170d148199307d77c433a9c3f945e05ea6b596ecdd25e`, `scripts/rhwp-artifacts.py --verify-product dist/rhwp --profile release` PASS, `dist/assets`에 시험 표지 0개. Release generation `53b6ad7a4c6de7a8f4ada4c61b0ad1934461e656527f6e6b440f08898bebf6d6`, 14패치, RHWP/WordCraft gitlink 변경 없음. 증거 `target/advanced-20261106/d-final/attempt6/`.

**네이티브 실패 원인과 교정.** attempt3·attempt4 실패는 제품 결함이 아니라 하네스 결함이었다. (1) 221 px 높이 편집 뷰포트 하단 띠의 클릭은 `.editor__scroll`로 가고(`elementFromPoint`는 Canvas를 보고) `hitTest`가 호출되지 않았는데(`d-final/diag1-3`), 약한 `includes("@")` 조건이 이전 셀 캐럿으로 통과해 한글과 수식이 B1을 덮어썼다. 하네스는 대상을 뷰포트 가운데로 옮겨 쪽 사각형이 안정된 뒤 누르고 정확한 셀 번호를 기다린다. (2) `xdotool type -7`이 값을 옵션으로 읽었다(`--` 추가). 같은 하단 띠의 실제 마우스 클릭도 스크롤러로 가서 캐럿이 움직이지 않으며, 이번 변경 범위로 고치지 않았다.

**이 과정에서 찾은 제품 결함.** 덮어쓴 저장본을 조사해 B1의 `=SUM(A1:B1)`처럼 자기 셀을 읽는 영속 수식이 수락되고 재계산마다 30→40→50으로 커짐을 실제 Release WASM에서 재현했다. 엔진은 고치지 않고 입력창·세션 공통 검증 `formulaReadsOwnCell`로 거부한다(읽기 전용 `hangul.tableFormula`는 문서를 바꾸지 않아 유지). 다른 수식을 거치는 간접 순환은 추적하지 않는다. 또 `=LOG10(...)`은 기존 `formulaSyntax`가 셀 참조로 읽어 거부한다(fail closed, 미수정).

| D8 | 항목 | 근거 계층 | 결과 |
|---|---|---|---|
| A–E | HWP/HWPX 장평·자간·연속 변경 | 실제 앱 + X11/IBus + 실제 저장 서비스 + 저장본 독립 재개방 | PASS |
| F | 안전 문맥 고급 Undo/Redo(셀 서식, 수식 교체, 본문 자간) | 실제 앱 네이티브 | PASS |
| G–I | 수식 삽입·교체·소스 변경 뒤 명시적 재계산(30/31/32) | 실제 앱 네이티브, field id 유지 | PASS |
| J | 잘못된 식 `=1+`, 자기 참조 `=SUM(A1:B2)` 무변경 거부 | 실제 앱 네이티브 | PASS |
| K | 본문 캐럿에서 수식 비활성 | 실제 앱 네이티브 | PASS |
| L | 실제 조합 중 장평·수식 비활성, 한글 입력 뒤 Undo 불가 | 실제 앱 네이티브(trusted composition) | PASS |
| M | commit 대기 거부 | 실제 WASM, backend 응답은 controlled | PASS(네이티브 아님) |
| N | 입력 창 열린 채 다른 문서로 전환하면 요청 폐기, 양쪽 판 0 | 실제 앱 네이티브 | PASS. 창이 열린 채 같은 세션을 reload하는 경우의 `App.tsx` 판 비교는 코드 확인만, 직접 시험 없음 |
| O | 저장·재개방·재편집·2차 이상 저장 | 실제 앱 네이티브, HWP/HWPX 각 7회 저장 | PASS |
| P | 진짜 한컴 `calc-cell.hwp` stale preview 거부, 원본·dirty 유지 | 실제 앱 네이티브 + 실제 저장 서비스 | PASS(안전 거부이며 저장 호환 성공이 아님) |
| Q | 엔진 실패 rollback·격리, 할당·폐기 trap | 실제 WASM + 주입 실패 | PASS(네이티브 아님) |
| R | 비내구 게시와 dirty 보존 | 프런트엔드 `saveCleanup`/`saveDurability` controlled 시험 | PASS(고급 명령 전용·실서비스 주입 아님) |
| S | 모든 시험 훅 0 일반 빌드 | 빌드 신원, `test-only text hook absent` 확인 | PASS |

| 명령 (모든 훅 0, 별도 표시 제외) | 결과 |
|---|---|
| `python3 scripts/tests/native-advanced-production.py` (기존 X11/IBus 격리 launcher) | PASS 56검사, 잔존 프로세스 0. `attempt6/native/run/advanced/result.json` |
| `... --stale-preview attempt6/calc-cell-geometry.json` | PASS. `attempt6/preview2/run/advanced/result.json` |
| `node scripts/tests/advanced-production-runtime.mjs verify ...` | PASS: HWP/HWPX 8단계 저장본, 최종 셀 `11,20,한글,32`, 식 `=SUM(A1:B1)+1`, 셀 180/10, 본문 125/-7. `attempt6/saved-verify.json` |
| `npx vitest run` | 1252 PASS |
| `npm run typecheck`, `npm run lint` | PASS |
| `npx vitest run --config scripts/tests/vitest.config.ts advanced-production table-formula-session` | 59 PASS |
| 훅 1, `--config scripts/tests/vitest.config.ts identity table-formula-session` | 66 PASS |
| 훅 1, `--config tests/integration/rhwp/vitest.config.ts undo.wasm format-save.wasm multisection.wasm` | 37 PASS / 1 선택 SKIP |

`src-tauri` 변경이 없어 보호 Rust `services::save`는 다시 돌리지 않았다(B 기록 유지). 입력창 Return→판 DOM 갱신은 HWP 13–29 ms, HWPX 12–16 ms이며 작은 fixture의 새 측정이다. **D4 끝점이 아니고 D4는 FAIL 그대로다.**

**남은 제한.** 시험한 내용은 생성/내부 변환 fixture의 2×2 표와 calc-cell 거부다. 한컴 원본 HWP처럼 미리보기가 있으면 수식 변경 저장은 거부되므로 실제 한컴 문서 활용은 제한된다. 128 KiB 초과·8쪽 초과는 `limit`으로 막아 큰 문서는 범위 밖이다. Hancom 외부 호환성 NOT RUN, 진짜 수식 HWPX 미확보, D2 INCONCLUSIVE, D4 FAIL/자원 INCONCLUSIVE, T010/T012 전체 미완료는 그대로다. 제품 명령 활성화는 사용자의 조건부 결정이지 시험 통과가 아니다.


<a id="reliability-small-20261106"></a>

## 2026-11-06 소규모 신뢰성 후속 — PARTIALLY COMPLETED

시작 `340f54d8f451313591253466b0743ca34f560649`, master, index/worktree clean. WordCraft gitlink `6c994e42dee106ca03c6f11628d2fe577fe27636`, RHWP `1a76570e833917d15817415a53c09ad61ab3203f`, 활성 14패치와 Release 세대 `53b6ad7a4c6de7a8f4ada4c61b0ad1934461e656527f6e6b440f08898bebf6d6` 유지. 근거 루트는 `target/reliability-small-20261106/`다. 앞 절의 LOG10 미수정 및 reload 직접 시험 없음은 당시 기록이며 아래가 후속 결과다. 로컬 커밋만 만들었고 push하지 않았다.

| 항목 | 결과·최소 변경 | 검증·남은 제한 | 로컬 커밋 |
|---|---|---|---|
| A Safari 정규식 | `(?<![A-Z0-9?_])` 제거. 문법 검사와 공통 토큰 경계로 직접/범위/상대 참조를 검사하고 함수 식별자를 제외 | 자기 참조·역방향/공백 범위·상대 참조·함수·표 경계/잘못된 문법 PASS. Safari 13 실제 런타임 NOT RUN | `9fad4d779fae6868ade696f67e0a5c47c9de475a` |
| B1 LOG10 | 호출 괄호가 뒤따르는 셀 모양 식별자를 함수로 파싱. 함수 목록/arity/비용 제한 유지 | 수정 전 unit 1 FAIL, HWP/HWPX WASM 2 FAIL. 수정 후 계산·동일 식 재계산·표현식/캐시 export/reopen·잘못된 식 무변경 거부 PASS | `543006e5b9ad8075a2b7e52ebd4d84eea25e3c6b` |
| B2 간접 순환 | **재현, 미수정**. A1=`=B1+1`, B1=`=A1+1` 수락 후 21/22 → 재계산 23/24 | 실제 세션·Release WASM. 직접 자기 참조 거부는 유지. 간접 순환 안전성을 주장하지 않음 | 수정 커밋 없음 |
| C 하단 포인터 | **재현, 미수정**. 독립 native 진단기 추가. 가운데 이동 helper는 유지 | HWP/HWPX native 진단 30 PASS는 결함 수정 PASS가 아님. 보이는 하단의 일부가 여전히 `.editor__scroll`에 잡힘 | 진단만 `315c416fbed8a93ea79e335e93403948036bd187` |
| D 입력창 reload | 기존 App 가드가 작동해 제품 수정 없이 회귀 6개 추가 | 실제 App/입력창/workspace/Release WASM, backend load 응답과 canvas paint는 controlled. 같은 세션 reload·전환·닫기 PASS; native reload 입력창은 NOT RUN | `971f8d4cfb1780d040138eb25ca814de32be2547` |

**A의 계층별 의미.** Vite의 비 Windows target은 `safari13`이다. 수정 전 `npm run build:frontend`는 성공했으나 산출물 `index-DUxu1U1j.js`에 `RegExp("(?<!...")`가 남았다(`a-before-build.log`, `a-before-syntax.txt`). 생성자 전환은 lookbehind 기능을 에뮬레이션하지 않으므로 성공한 빌드를 구형 런타임 검증으로 셀 수 없다. 수정 후 frontend-only 및 일반 Release production 빌드는 모두 성공했고 emitted JS에서 `(?<!`/`(?<=`가 0개다. 소스 호환성 교정 완료, **Runtime on Safari 13 NOT RUN**. 최초 수정 빌드의 TS nullable closure 오류는 상수 narrowing으로 고쳤으며 실패 로그도 보존했다.

**B의 범위.** `b-engine-examples.json`의 실제 엔진 결과는 LOG10(100)=2, LOG10(A1)=1(A1=10), LOG(100)=4.605170185988092(필드의 `%g` 캐시는 4.60517), SUM(A1:B1)=30이다. `table-formula-session`은 HWP/HWPX에서 invalid syntax/arity/unknown function/out-of-bounds/direct self-reference 거부 뒤 문서 바이트·revision·backend dirty·history가 그대로임을 단언한다. 지원 식은 명시적 재계산이 안정적이고 export/reopen 후 command와 value가 같다. backend 응답은 controlled이며 이 시험을 실제 저장 서비스 게시로 세지 않는다.

간접 순환 재현 소스는 `b-cycle-reproduction.test.ts.txt`, 실행은 `b-before-wasm.log`의 52 PASS 중 해당 캐시 변동 단언이다(다른 LOG10 두 시험은 수정 전 실패). unsafe 수락을 회귀 계약으로 고정하지 않도록 해당 재현은 제품 테스트에 남기지 않았다. 현재 `RhwpText.existingFormula`는 정확한 단일 소유 셀의 알려진 `??%g,;;` 형식만 읽고, unfamiliar/multiple/nested 필드·상대 참조가 든 command 등은 null로 돌려 부재와 구분하지 않는다. `getFieldList`는 unknown JSON이며 의존성 그래프 계약이 아니다. 셀 인덱스→표 좌표, 병합/다중 문단의 실제 숫자 읽기, 상대·범위·방향 참조, 원본 필드 형식의 검증 및 fail-closed 정책까지 정해야 누락 없는 그래프가 된다. 이 경계를 정의하지 않은 부분 그래프는 넣지 않았다. 후속 작업은 검증된 표 단위 dependency projection과 destination 관련 cycle 거부이며, 현재 간접 순환은 안전하게 거부되지 않는다. T009 원본 보존 검사를 완화하지 않았다.

**C의 원인과 미해결 경계.** baseline 일반 제품 앱 SHA256 `987cee7ec7c777856a4170d148199307d77c433a9c3f945e05ea6b596ecdd25e`로 실제 X11/GTK/WebKitGTK 2.54.1에서 실행했다(이번 A/B를 담은 새 native 앱 빌드가 아님; 포인터/CSS 제품 소스는 baseline과 동일). 높이 220.984375px, top 551.015625/bottom 772의 scrollport에서 y≈751의 `elementFromPoint`는 canvas지만 trusted mousedown target은 `.editor__scroll`, caret은 이전 셀이다. 실제 visible scrollbar thumb y=762 드래그는 scrollLeft 0→68이며 caret을 바꾸지 않는다. `scrollbar-width:none` **진단 조건에서만** 같은 셀 클릭이 통과해 native overlay 입력 영역과의 관련성을 확인했다(`c-probe3`). stable gutter/thin/custom scrollbar/relative/layer/overflow 실험으로 안전한 교정을 입증하지 못했다. 문제는 합성 좌표 오차나 엔진의 page→caret 변환으로 확인되지 않았으며, 하네스의 가운데 이동은 결함 수정이 아니다. 실제 scrollbar와 페이지 이벤트를 구분할 확실한 경계 없이 scroll 이벤트를 canvas로 강제 전달하거나 스크롤바를 숨기는 제품 수정은 넣지 않았다. 하단 겹침 영역의 사용성 문제는 남아 있다.

`c-native3`은 page top/middle/bottom-visible(80%)/scrolled-top의 **정확한 셀 ID**, trusted canvas target, 스크롤바 전용 드래그, 포인터 조작 중 revision0/dirtyfalse, 목표 셀에 X 입력을 확인했다. 실제 Tauri 저장 서비스로 HWP/HWPX 각 1회 게시한 뒤 `c-verify.mjs`가 현재 hash-verified Release WASM으로 열어 셀 `["10","20","","X"]`, formula fields 없음까지 확인했다(`c-reopen.json`). 이전 셀이 덮어써지지 않았다. native 프로세스 cleanup survivors=[]다. C의 native 진단 PASS와 하단 결함 해결은 별개다. 배율/선택/드래그의 controlled 회귀는 `RhwpSurface.test.tsx`를 재사용했다. 제품 CSS/이벤트 라우팅/IME ownership 변경 없음.

**D의 직접 검증.** `scripts/tests/formula-dialog-reload.wasm.test.ts`는 HWP/HWPX 각각 실제 App에서 표 셀→영속 수식 입력창 열기→창을 둔 채 같은 `RhwpEditorSession.load()`→새 generation2 준비 완료→옛 입력 Enter를 실행한다. session 객체는 재사용되고 이전 WASM 문서는 정확히 free된다. revision이 양쪽 모두 0이어도 generation이 달라 execute가 0회이고, formula field/문서 바이트/backend 상태/dirty/history가 바뀌지 않으며 기존 stale 안내가 표시된다. generation3으로 다시 불러와도 폐기된 요청은 되살아나지 않는다. 활성 문서 전환 뒤 돌아오기 및 닫기는 창 폐기·실행 없음·이전 문서 free/소유 해제를 단언한다. 키보드/IME 제품 코드나 전역 command queue는 바꾸지 않았다.

| 실제 실행 명령 | 최종 결과 | 근거(root 기준) |
|---|---|---|
| `npx vitest run src/commands/hangulTools.test.tsx src/components/Editor/advancedFormulaDialog.test.tsx` | 21 PASS | `b-after-tests.log` |
| `npx vitest run --config scripts/tests/vitest.config.ts table-formula-session advanced-production` | 실제 Release WASM 61 PASS | `b-after-wasm.log` |
| `npx vitest run src/App.test.tsx src/App.notifications.test.tsx src/components/Editor/advancedFormulaDialog.test.tsx src/commands/hangulTools.test.tsx src/components/Editor/rhwp/RhwpSurface.test.tsx src/components/Editor/rhwp/RhwpEditorSession.test.ts` | 79 PASS | `final-focused.log` |
| `npx vitest run --config scripts/tests/vitest.config.ts formula-dialog-reload` | 실제 App/Release WASM 6 PASS | `d-tests-final.log` |
| `npm run typecheck`; `npm run lint` | PASS | `b-types.log`, `final-lint.log` |
| `npx tsc --noEmit -p target/reliability-small-20261106/tsconfig-tests.json` | PASS(새 script 시험 포함) | `final-test-types.log` |
| `npm run build:frontend`; `npm run build` | Safari13 target PASS(일반 빌드는 Release 자산 포함), 기존 >500kB chunk 경고 유지 | `a-after-build.log`, `final-build.log` |
| `python3 scripts/rhwp-artifacts.py --verify-product dist/rhwp --profile release` | PASS | `final-rhwp-identity.log` |
| `python3 -m py_compile scripts/tests/native-bottom-pointer.py` | PASS | `c-pycompile.log` |
| `GEUL_NATIVE_OUT=... GEUL_NATIVE_COMMANDS=... python3 target/reliability-small-20261106/native-launch.py` | C native 진단 30 PASS, 하단 클릭 누락 REPRODUCED_UNFIXED | `c-native3/environment/environment-result.json`에 펼친 정확한 command/환경/cleanup, `c-native3/run/pointer/result.json` |
| `node target/reliability-small-20261106/c-verify.mjs`; `node target/reliability-small-20261106/b-engine-examples.mjs` | PASS | `c-reopen.json`, `b-engine-examples.json` |
| `git diff --check`, 각 로컬 commit의 configured hooks | PASS | `a/b/c/d-commit.log` |
| 실제 Safari 13; Microsoft Word; Hancom Office | NOT RUN | 이번 작업에서 실행하지 않음 |

일반 production JS `dist/assets/index-1DZ9L776.js` SHA256 `092fc856e8eeaab30a89598415c9f5186356f49b7463253258d935a6de3b5cd7`, Release JS `3e9c1687af9aabe8ca78c68ab01e569622bcb880341ae4c100faf543782e0027`, WASM `e08e5ce86fad632fde6b7e1051f09597e771ae3924b01685567296a31a453757`. `final-build-assets.txt`와 `final-repository.json`에 소스/산출물 신원을 기록한다. 엔진/패치/기존 Rust 보존 규칙 변경이나 WASM rebuild는 없다. 전체 D2·D4·Rust suite 재실행은 범위 밖으로 SKIP했다. **T010 Incomplete; T012/T013 △ conditionally incomplete; D2 INCONCLUSIVE; D4 FAIL; D4 resource INCONCLUSIVE; WordCraft remote reproducibility BLOCKED; Word/Hancom NOT RUN.** 기존 조건부 개발 결정과 과거 수용 증거를 유지한다.


<a id="cycle-pointer-repair-20261106"></a>

## 2026-11-06 간접 순환·하단 포인터 제품 교정 후속

시작 HEAD `86a63489dd5ef20ac14732c281a50dc398636479` master, clean index/worktree, RHWP `1a76570e833917d15817415a53c09ad61ab3203f`·WordCraft `6c994e42dee106ca03c6f11628d2fe577fe27636` 일치. 이전 절의 미수정 기록은 당시 결과로 보존한다. 새 근거는 `target/cycle-pointer-20261106/`다. 로컬 커밋만 허용하며 push하지 않는다.

### A — 영속 수식 간접 순환 거부

엔진 원문 `field_query.rs`의 `collect_fields_and_lists`와 `hwpctrl_sets.rs`의 `collect_controls`는 같은 리스트 ID를 쓴다. 전자는 field_ranges의 논리 필드, 후자는 필드 범위에 없는 컨트롤까지 열거한다. 기존 read-only `getCursorModel`, `getControls`, `getFieldList`, `getCellInfo`와 `validateTableFormulaField(=0)`를 교차 확인해 일반 셀·지원 필드·불명 구조를 구분한다. 필드 목록이 비어 있어도 컨트롤이 있으면 일반 값으로 간주하지 않는다. 필드 ID·셀 위치·전체 문단 범위·캐시 텍스트를 확인하고 엔진 validator가 sole formula ownership을 입증해야 기존 필드의 의존성을 읽는다. 읽기 전용 검증은 문단 사본에서만 수행되며 실제 바이트 무변경을 시험한다. 새 엔진 API나 WASM rebuild는 필요하지 않았다.

공통 토큰화/grammar/bounds/cost 검증 뒤 A1·상대 행/열·범위(역방향 포함)·함수 안 참조·LEFT/RIGHT/ABOVE/BELOW를 좌표 간선으로 만든다. 방향은 `table_calc/evaluator.rs`의 현재 셀 제외 행/열 좌표와 같다. IF의 모든 분기는 보수적으로 포함한다. 목적 셀의 기존 간선을 제안 간선으로 교체한 뒤 반복형 DFS로 목적지에서 도달 가능한 순환(이미 가져온 순환 포함)을 거부한다. 표 노드+간선 총합 ≤4096, 각 식 256자/깊이16/셀 방문4096, 메타데이터 JSON 각2MiB/항목4096으로 제한한다. 순회 재귀나 범위 밖 좌표 할당은 없다.

지원 경계: top-level 비병합 직사각형 표, 셀당 한 문단, 일반 셀은 컨트롤/필드 모두 없음, 기존 수식은 전체 문단을 소유한 `%g` formula 하나. 병합/중첩/다중 문단, 낯선 필드 인코딩, 모호한 위치/범위/ID, 누락/불일치 메타데이터 또는 총 그래프 예산 초과는 안전 거부한다. 관련 없는 필드를 해석하거나 수정하지 않는다. 기존 직접 자기 참조 거부와 읽기 전용 계산은 유지한다.

실제 HWP/HWPX Release WASM 행렬은 두 셀·세 셀·범위·교체·상대·방향 순환, 직접 자기 참조, malformed/missing/encoding/nested/duplicate/location 메타데이터, 실제 병합 표와 주입 불일치를 검사한다. 매 거부는 문서 바이트/로컬 revision/backend session(판·dirty)/history/ownership 불변, snapshot 0회, commit/save 0회다. 정상 사슬은 의존성 순 재계산 4/3/2, 같은 식 반복 시 revision 무변경, 비순환 교체 6/5/2, Undo/Redo, export/reopen/edit/second export의 field ID·command·value 보존을 확인한다. backend는 controlled이므로 실제 durable publication으로 세지 않는다.

A 검증(이번 실행): `npx vitest run src/commands/hangulTools.test.tsx src/components/Editor/advancedFormulaDialog.test.tsx src/components/Editor/rhwp/historyAdmission.test.ts src/components/Editor/rhwp/RhwpEditorSession.test.ts` 47 PASS(`a-frontend.log`), `npx vitest run --config scripts/tests/vitest.config.ts table-formula-session` 89 PASS(`a-merged-final.log`). `advanced-production` 8개와 `formula-dialog-reload` 6개는 이번 교정 후 `a-final-wasm.log`의 통과를 재사용했다(그 뒤 추가한 병합 fixture 시험은 table suite에서 별도 통과). `npm run typecheck`, `npm run lint`, `npx tsc --noEmit -p target/reliability-small-20261106/tsconfig-tests.json`, `git diff --check` PASS. 이전 단계의 상속 결과를 이번 실행으로 세지 않았다. T009·엔진·14패치·Release 신원 변경 없음. 별도 실제 저장 서비스 근거는 B의 최종 native 행렬에서 기록한다.


### B — WebKitGTK의 보이는 페이지와 스크롤바 경계 분리

제품 수정은 `src-tauri/src/lib.rs`의 Linux 시작 경계에서 process-local GTK `gtk-overlay-scrolling=false`를 설정하는 것이다. [실제 WebKitGTK 2.54.1 소스](https://raw.githubusercontent.com/WebKit/WebKit/webkitgtk-2.54.1/Source/WebKit/UIProcess/gtk/SystemSettingsManagerProxyGtk.cpp)는 이 GTK 속성을 읽고 notify 변경을 전달한다. 단순 `GTK_OVERLAY_SCROLLING=0` 환경변수는 이 실행에서 효과가 없었다. 기존 GTK 의존성의 `ObjectExt`로 속성 존재를 확인하고 설정하며, 크레이트 feature/최소 버전을 올리거나 OS 설정 파일을 쓰지 않는다. 다른 플랫폼은 변경하지 않았다. CSS scrollbar 숨김, pointer redirect, RHWP hitTest/IME 변경은 없다.

**교정한 플랫폼 경계.** 기존 앱 `987cee7e...`의 높이220.984375px scrollport는 clientHeight221/clientWidth760으로 overlay 공간을 예약하지 않았다. native y=751에서 `elementFromPoint`는 canvas였지만 실제 target은 `.editor__scroll`이며 A2 캐럿이 남았다. `b-before750`이라는 디렉터리 이름과 달리 해당 보고서의 실제 trusted 좌표는 **751**이다. 새 앱은 같은 outer rect(top551.015625/bottom772)에서 clientHeight200/clientWidth739로 21px native gutter를 확보한다. 같은 native **751은 이제 보이는 실제 스크롤바**이고 caret을 움직이지 않는 것이 정상이다. 이 위치를 페이지로 강제 전달하지 않았다. 마지막 전체 편집 픽셀 **750**은 canvas로 전달되어 정확히 `0:1:0@0/3/0`으로 이동한다. y751에서 caret이 이동했다고 주장하지 않는다. overlay의 눈에 보이지 않던 입력 영역에 페이지가 그려지던 문제를, 실제로 보이고 공간을 차지하는 scrollbar 경계로 교정한 것이다. GTK 테마에 따른 실제 gutter 크기는 DOM client 크기로 측정한다.

`native-bottom-pointer.py`의 기본 모드는 교정 수용이며 `--expect-bottom-loss`는 원래 overlay 재현 진단을 보존한다. 기본 시험은 raw fractional center를 무조건 round해서 실제 scrollbar 픽셀751을 누르던 가정을 버리고 마지막 전체 page 픽셀750을 명시한다. 원래751 클릭도 별도로 실행해 실제 scrollbar target/캐럿 무변경을 확인한다. 가운데로 옮기는 기존 우회로를 이 하단 수용에 쓰지 않는다. 새 경계가 필요한 플랫폼이라는 점을 숨기거나 원래 같은 좌표의 target이 canvas로 바뀐 것처럼 기록하지 않는다.

**이번 actual native 수용:** 정상 production Release 앱 SHA256 `e1ef33ab66922583ae5d0fbb892d1514ee89daa2c65d36a3cdd73de2eb8d8f6a`, 모든 시험 훅0, NixOS X11/Xvfb·GTK3.24.52·WebKitGTK2.54.1·IBus1.5.33/hangul1.5.5. `b-native2`는 HWP/HWPX 합계 **66 PASS**, cleanup survivors=[]다. page top/middle/bottom/스크롤한 page, 마지막 편집 가능 하단 픽셀750의 canvas target·정확한 셀0/1/2/3, 기존751의 실제 scrollbar 분류, 수평 thumb 0→70, 수직 thumb scrollTop0→339, native XTest wheel, 선택 `0:1:0@0/0/0|0:1:2@0/0/0`, zoom 뒤 정확한 셀, 새로 누른 B2의 X/한글 입력과 trusted composition을 검증했다. 포인터/선택/스크롤만으로 revision/dirty가 바뀌지 않는다.

**실제 저장 및 A의 서비스 교차 검증:** 형식당 pointer-first(`10,20,"",X한글`), formula-first(`21,20,"",X한글`, A1=`=B1+1`), formula-second(`22,20,"",X한글`, A1=`=B1+2`)를 실제 Tauri 저장 서비스로 각 게시해 총6건이다. B1=`=A1+1`로 순환을 닫는 실제 입력창 요청은 revision/dirty 변화 없이 거부되고 B1 필드는 게시본에 없다. 첫 수식 저장 뒤 앱에서 닫기/재열기, 기존 식 prefill/교체/두 번째 저장도 통과했다. `scripts/tests/verify-bottom-pointer.mjs`는 hash-verified Release WASM으로 6개 파일을 다시 열고 재export/reopen하여 셀 전체·수식 ID·표현식·캐시·top-level A1 위치가 일치함을 검증한다. 이전 셀/나머지 셀은 그대로다. `b-verifier-reviewed`의 입력은 `b-native2` 게시본의 byte-identical 복사이며 파일별 SHA256이 기록됐다. controlled backend 성공을 이 6건에 포함하지 않았다.

| 이번 실행 명령 | 결과 | 근거(`target/cycle-pointer-20261106/`) |
|---|---|---|
| `GEUL_SANDBOX=userns-root-bwrap VITE_GEUL_TEST_HOOKS=0 VITE_GEUL_TEST_RHWP_HISTORY=0 VITE_GEUL_TEST_RHWP_FORMAT=0 VITE_GEUL_TEST_RHWP_FORMULA=0 python3 scripts/tauri-geul.py build --no-bundle` | PASS. 최초 GTK feature 메서드 오류는 ObjectExt 속성 접근으로 교정 | `b-build.log`, 실패 로그 `b-build-failed-api.log` 보존 |
| `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py fmt --check` | PASS | `b-fmt.log` |
| `npx vitest run src/App.test.tsx src/components/Editor/rhwp/RhwpSurface.test.tsx src/components/Editor/rhwp/inputBuffer.test.tsx src/components/Editor/rhwp/imeRendering.test.tsx` | 64 PASS | `b-frontend.log` |
| `python3 scripts/rhwp-artifacts.py --verify-product dist/rhwp --profile release` | PASS. 기존 Release 세대/14패치 유지 | `b-rhwp-identity.log` |
| `python3 -m py_compile scripts/tests/native-bottom-pointer.py` | PASS | `b-pycompile.log`(추가 harness 갱신 뒤 main에서도 PASS) |
| `GEUL_NATIVE_OUT=... GEUL_NATIVE_COMMANDS=... python3 target/cycle-pointer-20261106/native-launch.py` | 수정 전30 진단PASS/수정 후66 수용PASS 구분 | `b-before750/environment/environment-result.json`, `b-native2/environment/environment-result.json`에 펼친 정확 command/환경/cleanup |
| `node scripts/tests/verify-bottom-pointer.mjs target/cycle-pointer-20261106/b-verifier-reviewed` | 저장본6개 재export/reopen PASS | `b-verifier-reviewed/reopen.json` |

위 native launcher는 기존 격리 X11/IBus 절차를 재사용했고, 수정 후에는 GTK 설정 파일 주입이나 overlay 환경변수 변경을 하지 않았다. 제품의 프로세스 내 설정이 유일한 변경이다. 첫 `b-native1`은 fractional 좌표를 round해 실제 bar를 페이지로 잘못 분류한 harness assertion으로 실패했다. 측정한 bar/page 경계를 명시하고 원래751 scrollbar 확인을 남겨 교정했다(실패 로그 보존). 제품 수정을 약화하거나 시험을 center-scroll만으로 바꾸지 않았다.

B는 이 Linux GTK/WebKitGTK 구성의 명시적인 non-overlay 경계에서 수용했다. Wayland/macOS/Windows 및 GTK 속성이 없는 구형 runtime은 NOT RUN으로 추가 환경의 합격을 주장하지 않는다. Rust 저장 서비스/보존 규칙 변경이 없어 storage suite는 재실행하지 않았다. D2 E/U/F, D4, WordCraft remote, Word/Hancom, HWP preview 재생성은 범위 밖이다.

<a id="interoperability-repair-20261108"></a>

## 2026-11-08 상호운용성 보수 — PARTIALLY COMPLETED

이 기록은 구현, 내부 검증, 실제 저장, 외부 호환성 판정을 분리한다. 공식 상태는 바꾸지 않는다: T010 **INCOMPLETE**, T012/T013 **△ 조건부 미완료**, D2 **INCONCLUSIVE**, D4 지연 **FAIL**·자원 **INCONCLUSIVE**, 이 geul 작업 트리에서 수정한 WordCraft 소스의 원격 재현성 **BLOCKED**, Hancom Office와 Microsoft Word **NOT RUN**.

| 패키지 | 구현 | 내부 검증 | 실제 영속 저장 | 외부 호환성 | 남은 작업 |
|---|---|---|---|---|---|
| A — HWP 미리보기 | 미완료. RHWP 내보내기는 현재 첫 페이지를 반영한 PrvText/PrvImage를 재생성·검증하지 않는다. T009 predicate는 완화하지 않았다. | calc-cell 수식 편집의 입력 preflight는 safe였다. 후보 출력 검사가 두 미리보기 stream의 stale 상태를 찾아 거부했다. | **안전 거부**. durable save 아님. 원본 해시와 dirty/revision 유지. | Hancom **NOT RUN**. | preview 재생성 및 텍스트·화상 일치의 독립 검사. 반복 저장 행렬 미실행. |
| B — 복잡 표 수식 | 검증된 top-level 병합 표와 첫 문단 수식 소유권, 꼬리 일반 문단 보존까지 지원. 덮임 좌표는 값 없는 좌표이며 앵커의 별칭이 아니다. 모호·불완전·중첩 구조는 거부. 길이 256, 중첩 16, 셀 방문 4096 제한 유지. | 최종 소스의 Release WASM 회귀 99건 PASS(`test-final-99.log`, 한 번의 전체 실행). RHWP native 수식 4건 PASS. 제품 신원과 포맷 검증 PASS. | 초기 16건과 현재 소스에서 새로 빌드한 서비스로 재실행한 동일 16건을 구분한다. 각 실행은 HWP/HWPX × 가로/세로/복수 병합/두 문단 × 두 차례 저장이다. 두 번째 실행의 16개 파일은 최종 Release WASM으로 다시 열어 식·캐시를 확인했다. 이를 서로 다른 32개 사례로 세지 않는다. | Hancom **NOT RUN**. | 제한된 부분집합이며 요청된 전체 행렬은 아님. 중첩, 다중/모호 수식 소유권, 지원되지 않는 메타데이터는 계속 거부. |
| C — DOCX 추적 TOC | 지원되는 추적 변경 처리에서 heading bookmark 쌍을 유지하고 TOC 갱신 전후 구조를 검사한다. geul의 원자적 의미 검사는 유지했다. | 기존 refusal 재현. WordCraft 집중 검사 및 TOC/추적 왕복 통과. geul adapter 79 PASS/1 ignored와 별도 추가 부정 검사 1 PASS. WordCraft 전체 엔진 446 PASS/1 FAIL(변경되지 않은 file-access scanner), DOCX 단위 시험 75 PASS, 별도 TOC 7·추적 왕복 4 PASS. 전체 `cargo xtask ci`는 **FAIL**. 개별 assets 54, layers 20, WASM 16 gate 통과. | 실제 DOCX 8개: 선택 수락/거절, 전체 수락/거절 × 두 저장 회차. 모두 실제 디스크 재열기·후속 편집 포함. 독립 패키지 구조 검사는 8개 모두 통과. | Microsoft Word **NOT RUN**. | 문단을 가로지르는 일부 책갈피 경계와 살아 있는 TOC 대상이 사라질 작업은 계속 fail-closed. 원격 재현성 BLOCKED. |

### A — calc-cell 미리보기 증거

불변 입력 `external/rhwp/samples/calc-cell.hwp` SHA-256은 `e22c45dc65998ec3da6000b897f17a88f41dc6fceefeefabacea1fd0785716b3`이다. CFB 추출 결과 `PrvText`는 98바이트 UTF-16LE, SHA-256 `9563b7e38cceef7ab28d74e7279324279b34e4a9bf7101789d7d004b5485466d`; `PrvImage`는 1289바이트 GIF89a, 177×250, SHA-256 `4cf0f3d8157c682f600a9769eb437378777610c61022797cc8ecbdb3207ab1b4`였다. 텍스트는 첫 페이지 표(`<1><2><3><4>`, `<3><7><2><7>`, `<2.00><14><5><13>`, 빈 행)를 나타내며, 독립 디코딩 및 육안 검사한 그림도 첫 페이지 표다. 원본·편집본 미리보기 복사본은 각 원래 CFB stream과 바이트 단위로 동일하며 갱신 미리보기가 아니다.

작업 시작 당시 Release WASM(`53b6ad7a…`)으로 field `2117925221`의 `=AVG(ABOVE)??%.2f,;;2.00`을 `=1+2??%g,;;3`으로 편집한 뒤 모델 export/reopen에서 식은 유지됐지만 두 미리보기 stream은 그대로였다. 실제 save service에서 **입력 preflight는 safe**였고 저장 후보 출력 검사는 두 stream을 `previewStale`로 판정해 `UnsafeSave`로 거부했다. 원본 및 private target SHA-256은 전후 모두 `e22c45dc65998ec3da6000b897f17a88f41dc6fceefeefabacea1fd0785716b3`; 세션 dirty=true, revision=1을 유지했다. 실행 증거는 `target/interoperability-20261108/a/service2.log`, `service-results.json`, 그리고 현재 소스로 새 빌드한 producer를 사용한 `fresh-service/results-summary.json`이다. 미리보기 형식 참고: [Hancom HWP 형식 구조 소개](https://tech.hancom.com/한-글-문서-파일-형식-hwp-포맷-구조-살펴보기/)는 PrvText/첫 페이지 범위와 이미지 정보를 다루고, [한글 문서 파일 형식 5.0 개정 1.3 PDF](https://cdn.hancom.com/link/docs/한글문서파일형식_5.0_revision1.3.pdf)는 BMP/GIF 인코딩을 기술한다. 빈 preview stream이 안전한 정책이라는 근거는 확인하지 못했다. Hancom 실행 미수행만이 blocker인 것은 아니다. 현재 export에는 검증된 preview 생성 경로가 없다.

### B — 검증된 셀·문단 소유권

논리 격자는 물리 셀 레코드와 row/column span으로 만든다. 소유권 누락·모순, 빈 구멍, 겹침, 중첩, 필드/control identity 모호성은 snapshot 전에 거부한다. 엔진의 정확한 앵커 조회 의미에 따라 병합 덮임 좌표에는 물리 소유 셀/값이 없으며 병합 앵커와 동일한 그래프 노드로 합치지 않는다. 수식은 첫 문단을 소유하고 꼬리 일반 문단은 유지한다. 다중 수식 필드, 혼합/모호한 소유권, 중첩 control 및 불일치 메타데이터는 계속 fail-closed다. 그래프와 식의 기존 한계는 증가시키지 않았다.

최종 Release 신원: generation `342ebaad964f911b8dc83fe9cb7eaca5ee2625486336c3690c01ea16f0396bdc`, JS SHA-256 `3e9c1687af9aabe8ca78c68ab01e569622bcb880341ae4c100faf543782e0027`, WASM SHA-256 `03c6ecfd87ae783661f1cc25cb51b0bc1c4bb21bed191608b0128d1cea7f7325`, canonical source SHA-256 `480e23c1dcd11c0a1b9ec5fec95023523eded93c134129cc35535abee3f79292`. RHWP 활성 patch는 15개. B 구현 commit `c91eca9a300a7e5b6fbed326872c263361107e4d`.

초기 16개 실제 publication 근거는 `target/interoperability-20261108/b/service-results.json` 및 `reopen-results.json`이다. source-producer를 확정하기 위해 저장 서비스 테스트를 현재 소스에서 보호된 offline/no-run 빌드하고 같은 16개 입력을 한 차례 더 실행했다. 산출물은 별도 `b/fresh-service/`에 있으며 `producer.json`은 Cargo compiler-artifact가 지정한 실행 파일 경로, SHA-256, 입력 Rust 파일 해시를 기록한다. 생산자 보고서는 `build-integrity.json`; 재실행 결과는 `fresh-service-results.json`; Release WASM 재열기는 `fresh-reopen-results.json`이다. 새 producer SHA-256은 `0373c39b031185a386bd358ab851d510b1bd2466147a6f6cda6e6b8b9b76c288`. 새 실행은 이전과 같은 16개 입력 사례를 재검증한 것이며 32개 독립 사례로 합산하지 않는다. 출력 16개 모두 safe preflight/save, durable publication, dirty=false 및 재열기 식/캐시 일치를 확인했다.

최종 소스는 `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/table-formula-session.wasm.test.ts`로 99 PASS를 확인했다(`target/interoperability-20261108/b/test-final-99.log`). 이전 97건 실행과 추가 부정 검사 증거도 보존하되 합산하지 않는다. Typecheck·lint·test-script TypeScript 검사, frontend 28건, 보조 실제 WASM 29건과 product identity 검사는 동일한 관련 코드의 증거를 재사용했다. RHWP native `geul_formula` 4건은 `b/native3.log` PASS; 최종 포맷 변경은 공백/정렬만이었다. 실제 WASM publication은 지원 가능한 생성 fixture로 수행했으며 Hancom 상호운용은 증명하지 않는다. 기존 수식 소유권은 문단 전체를 덮는 단일 `%g` 필드로 제한한다. 원본 셀을 바꾼 뒤 같은 식을 재적용하여 결과 캐시를 재계산한다.

### C — 추적 TOC 표식 수명주기와 저장

WordCraft 수정은 bookmark 경계 helper와 tracked review/TOC 코드에 있다. 지원되는 부분 범위 revision 처리는 살아남는 heading bookmark의 start/end identity를 보존한다. 잘못되었거나 지원되지 않는 표식 구조는 거부한다. geul pre/post 의미 수용 및 원자 rollback은 유지했다. TOC 대상을 잃게 되는 후검증 사례는 문서/history 변경 없이 거부되며 거부 후 Undo도 정상이다. 실행 로그: `target/interoperability-20261108/c/core-0.log`, `core-1.log`, `postvalidation.log`.

실제 저장 시험 `docx_semantic_acceptance::tracked_toc_boundary_resolution_durable_two_rounds`는 8개 DOCX를 저장·디스크 재열기하고 각 operation에 후속 편집/두 번째 저장을 수행했다. 독립 ZIP/XML 검사는 `c/docx-structure.json`에서 8개 전부 통과: 짝이 맞는 bookmark 24쌍, TOC field 8개, resolve되는 내부 anchor 16개, comment 16개, footnote/endnote reference와 package relationship 정상, revision metadata가 있는 생존 insertion 4개. note record 수에는 separator가 들어가므로 사용자 note가 24개라는 뜻은 아니다. WordCraft 의미 왕복 검사와 함께한 내부 검증이며 Microsoft Word 검사가 아니다. 북마크 범위 관련 외부 참고: [Microsoft 북마크 문제 해결 문서](https://support.microsoft.com/en-us/word/troubleshoot-bookmarks).

보호된 geul 검사: adapter 79 PASS/1 ignored, 추가 부정 검사 별도 1 PASS; save 148 PASS/15 ignored; `cargo fmt --all -- --check`, `cargo clippy --lib -- -D warnings`, locked/offline debug build PASS. debug binary SHA-256 `8173c861bebd31e3781de2e342670dda5d6a662f8f2507aa382db6e36952f66f`. 추가 포맷 검사는 `target/interoperability-20261108/c/geul-final-fmt-integrity.json`에 기록했다.

WordCraft `cargo xtask ci`는 **FAIL**이다. fmt/clippy는 통과했지만 test 단계는 변하지 않은 file-access scanner assertion에서 446 PASS/1 FAIL로 중단했다. 유일한 offender는 baseline부터 그대로인 `crates/engine/src/cmd/file.rs:264`; `file_access.rs`와 해당 파일은 pinned baseline과 바이트 동일하다. 67개 파일 Git archive에 scanner를 정적으로 replay했을 때도 같은 offender가 나왔으며 이는 native test가 아니다. 별도 `cargo xtask assets`, `layers`, `wasm`은 각각 54, 20, 16 gate 단위로 통과했다. 무결성 보고서와 baseline 비교는 `target/interoperability-20261108/c/` 아래에 있다. 원격 재현성 BLOCKED는 이 geul 작업 트리의 새 WordCraft 수정 commit을 원격에서 재현/취득하지 못했다는 상태다. WordCraft 일반 upstream 전체가 막혔다는 뜻이 아니다. 원격 게시를 하지 않았다.

### 실행 명령과 증거 범위

Rust 빌드/통합 검사는 `scripts/external-integrity.py` 보호 경로에서 `GEUL_SANDBOX=userns-root-bwrap` 및 명시적 writable 출력 경로로 실행했다. 프론트엔드의 npm 명령은 일반 프로젝트 환경에서 실행했으며 protected build라고 부르지 않는다. 저장 서비스는 기존 바이너리만 사용한 것이 아님을 별도로 확인했다:

- 현재 소스 producer: `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --test t010_phase0_save_service --no-run --message-format=json` — exit 0. `build.jsonl`의 compiler-artifact가 `src-tauri/target/debug/deps/t010_phase0_save_service-4f13e83260bc0eb8`를 지정. 실행 파일 SHA와 source hashes는 `b/fresh-service/producer.json`; 보호 보고서는 `b/fresh-service/build-integrity.json`.
- 실제 서비스 선택기: `t010_phase0_save_service --ignored --exact 진짜_엔진_출력을_저장_서비스에_넣는다 --nocapture` — 새로 빌드한 바이너리로 16/16 durable PASS. 입력 manifest·각 로그·요약은 `b/fresh-service/runs/`, `b/fresh-service/logs/`, and `b/fresh-service/fresh-service-results.json`.
- Release WASM 재열기: `node target/interoperability-20261108/b/fresh-service/reopen-fresh.mjs` — 16 PASS; `fresh-reopen-results.json` 및 `reopen-integrity2.json`.
- 동일한 신규 producer로 A의 calc-cell 재현 — 입력 preflight safe, output preservation `previewStale` 2건, `UnsafeSave`, 원본 유지/dirty 유지. `a/fresh-service/results-summary.json` 및 `integrity.json`.
- `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/table-formula-session.wasm.test.ts` — 99 PASS, 한 번의 전체 실행(`b/test-final-99.log`).
- `cargo test --locked --offline -p wordcraft-engine -p wordcraft-docx` — DOCX 집중 suite 통과; engine 446 PASS/1 baseline failure.
- `cargo test --locked --offline --lib adapters::wordcraft` — 79 PASS/1 ignored; 추가 부정 검사 별도 1 PASS. `cargo test --locked --offline --lib services::save` — 148 PASS/15 ignored.
- 보호된 `cargo fmt --all -- --check`, `cargo clippy --lib -- -D warnings`, `cargo build --locked --offline` — PASS. `cargo xtask ci` — **FAIL**; 별도 assets/layers/wasm gate는 PASS.

정확한 환경·전체 명령 배열과 종료 코드가 들어 있는 무결성 보고서는 각 증거 경로의 `*-integrity.json` 파일이다. 이 내부 검사와 패키지 구조 확인은 Microsoft Word 또는 Hancom Office 호환성을 입증하지 않는다. 두 프로그램 모두 실행하지 않았다.


### 로컬 커밋과 최종 소스 신원

작업 시작 geul HEAD는 `33adeedc85e9f03c92316625a91530a73cbfb66b`, branch는 `master`였다. RHWP gitlink는 `1a76570e833917d15817415a53c09ad61ab3203f` 그대로다. WordCraft gitlink는 로컬 수정 commit `615697c6d9b0af3a2cd05026576ddff28c7deecf`로 연결했다(parent `6c994e42dee106ca03c6f11628d2fe577fe27636`, branch `geul/semantic-roundtrip-equivalence`). 새 WordCraft 소스와 부모 geul gitlink가 일치한 뒤 정규 보호 빌드 `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py build`도 PASS했다(`c/final-pinned-build.log`, `final-pinned-build-integrity.json`). debug binary SHA는 위 `8173c861…`와 동일했다. `python3 scripts/rhwp-artifacts.py --verify-product dist/rhwp --profile release`도 PASS했다. 문서만 바뀐 뒤 코드 시험을 반복하지 않았다.

| 저장소·로컬 commit | 변경 파일/책임 | 검증 및 제한 |
|---|---|---|
| geul `c91eca9a300a7e5b6fbed326872c263361107e4d` | `src/components/Editor/rhwp/formulaDependencies.ts`, `scripts/rhwp-patches.py`, `patches/rhwp/table-formula-paragraphs.patch`, `scripts/tests/table-formula-session.wasm.test.ts` | 검증된 병합/다문단 첫 문단 소유권, Release 재빌드·실제 저장 16사례 |
| geul `a4fb314d42801cbb9dbdd306e3bf49264dcde986` | `scripts/tests/table-formula-session.wasm.test.ts` | 실제 재열린 꼬리 문단 필드의 수식 편집 거부 회귀, 최종 전체 WASM 99 PASS |
| WordCraft `615697c6d9b0af3a2cd05026576ddff28c7deecf` | `crates/engine/src/cmd/{bookmarks,mod,references,review}.rs`, `ROADMAP.md`, `docs/{gaps,file-format-parity}.md` | heading bookmark 수명주기, 집중 회귀/실제 DOCX 저장 PASS. 전체 CI의 기존 scanner 1 FAIL과 원격 BLOCKED는 유지 |
| geul `8ffc95820e0b90010ef68f72bdfecf7acdc457b4` | `external/wordcraft` gitlink, `src-tauri/src/adapters/wordcraft/{engine,tests}.rs`, `src-tauri/src/services/save/docx_semantic_acceptance.rs` | 새 소스 연결, 원자 거부·TOC 표식·실제 두 회차 저장/재열기 회귀 |

geul 커밋의 일반 훅에서 민감정보/하드코딩 비밀 검사가 PASS했다. 적용 대상이 없는 검사기 회귀 훅은 SKIP이었다. WordCraft 커밋은 hook 출력 없이 완료됐으며 전체 CI가 PASS했다는 의미가 아니다. A의 완료 commit은 만들지 않았다. 최종 문서 정리는 별도 로컬 commit이며 두 저장소 모두 push하지 않았다. 외부 Word/Hancom 검사는 NOT RUN이고, A 및 아직 실행하지 않은 전체 행렬/공식 수용은 남은 작업이다. `target/interoperability-20261108/`의 중간 실패와 최초 검사도 보존한다.

<a id="preview-tables-toc-20261108"></a>
## 2026-11-08 후속: HWP 미리보기 재생성 · 한컴 수식 결과 서식 · 추적 TOC 경계

결과: **PARTIALLY COMPLETED**. 아래 세 묶음은 각자의 지원 범위에서 실제 저장·재열기까지 확인했다. T012/T013은 남은 독립 수용 조건(외부 Word/Hancom, WordCraft 원격 재현성, 전체 행렬) 때문에 계속 **△ 조건부 미완료**다. T010 INCOMPLETE, D2 INCONCLUSIVE, D4 지연 FAIL/자원 INCONCLUSIVE는 바꾸지 않았다. 시작 HEAD `3a83de1170f7c9489747044f30c61cfd657886ab`, RHWP `1a76570e…`(15패치, Release `342ebaad…` 변경 없음). 증거 루트 `target/preview-tables-toc-20261108/`.

| 묶음 | 이전 한계 | 원인 | 수정 | 검증 | 남은 한계 |
| --- | --- | --- | --- | --- | --- |
| A HWP 미리보기 | 한컴 HWP(`PrvImage` GIF 등)는 본문 편집 뒤 `previewStale`로 저장 불가 | 엔진이 원본 미리보기를 그대로 쓰고, 검증된 재생성 경로가 없었다 | 프런트엔드가 **다시 연 원시 내보내기**의 1쪽을 그려 RGB를 저장 프레임에 붙이고, 백엔드가 출력 자신의 Section0 PAGE_DEF로 크기(긴 변 1024, 한컴 규칙)를 정해 정규 PNG를 만들고 PrvText/PrvImage만 다른 CFB로 다시 만든다. 최종 T009는 바뀐 PrvImage를 *이번 저장이 부호화한 바이트*이고 정규 PNG·PAGE_DEF 크기일 때만 받는다. 빈 PrvText는 RHWP가 다시 열 때 스트림을 버리므로(native1에서 발견) CRLF 빈값으로 쓴다 | Rust 단위 13 + `services::save` 154 PASS, native 실제 앱 2회 durable 저장·재열기, 독립 검증기 20/20 | 비동기 그림(GIF/WMF/EMF/SVG, rawSvg)이 1쪽에 있으면 렌더를 보내지 않아 기존 거부 유지. PrvText는 RHWP 관례(본문 최상위 문단)이며 한컴의 표·개체 `<…>` 형식은 재현하지 않음(가설 일치 18/341). Hancom NOT RUN |
| B 복잡 표 수식 | 한컴이 만든 다중 수식 표(calc-cell)는 제품 명령으로 어떤 수식도 편집 불가 | 투영이 `??%g`가 아닌 결과 서식을 모두 unknown으로 봄(`=AVG(ABOVE)??%.2f,;;2.00`) | `%.Nf`(N 0–9)를 소수 자릿수가 정확히 맞을 때만 인정, 식은 그대로 순환 분석 | 실제 WASM 103 PASS(새 4), 단위 17 PASS, 실제 서비스 HWPX 2 durable + 재열기, HWP는 native A로 durable | 천 단위 구분 기호 캐시(`4,319`), 중첩 표(경로 3), 그 밖의 서식은 계속 거부 |
| C 추적 TOC | 문단을 넘는 책갈피 경계와 살아 있는 TOC 대상 제거는 거부 | 경계 보존이 문단 안에서만 동작, TOC 대상 손실은 후검증 거부 | WordCraft가 문서 수준에서 한쪽 경계만 사라지는 쌍을 보존하고, TOC 대상이 사라지면 같은 명령(한 Undo 단계) 안에서 TOC를 다시 만든다. 본문 내부 하이퍼링크가 가리키는 책갈피 제거는 원자 거부 | WordCraft 새 4(이전 소스에서 3 FAIL), 31/450(+기존 scanner 1 FAIL), 왕복 7+4, geul lib 337 PASS, 실제 DOCX 16 + 독립 검사 PASS | 재생성할 TOC 필드가 없는 TOC 링크 손실, 모호·깨진 표식은 거부. WordCraft 원격 BLOCKED. Word NOT RUN |

### A — 근거와 경로

- 형식 근거: 공식 HWP 5.0 문서는 PrvImage를 BMP/GIF로 기술하지만, `external/rhwp/samples`의 626개 HWP 조사에서 실제 한컴 저장본은 GIF 긴 변 250(5.0.0–5.0.4) 또는 PNG 긴 변 1024(5.0.5+)였다. 크기는 Section0 첫 PAGE_DEF(가로 플래그면 가로·세로 교환, 반올림)이며 이 규칙이 250/1024 미리보기 563개 모두를 재현한다(`a/survey.json`, `a/survey.py`). RHWP 파서는 PNG/BMP/GIF를 모두 읽는다.
- 신뢰 경계: 렌더는 기존 `reopen` 증거와 같은 신뢰(프런트엔드 엔진)다. 실제 편집 세션이 아니라 저장 대상 바이트를 다시 연 문서에서 그린다. 백엔드는 픽셀이 내용을 나타낸다고 독자적으로 증명하지 않는다; 그 대신 크기·부호화 정규성·이번 저장 결속을 강제하고, 내용 일치는 아래 독립 검증으로 확인했다. 본문·표·개체가 있는데 한 색인 렌더는 실패로 보고 거부한다.
- `check_saved`(증거 없음)의 판정은 그대로다. 미리보기 증거 없이 바뀐 PrvImage는 여전히 `partChanged`, 남은 원본은 `previewStale`.

| 명령/시험 | 결과 | 증거 |
| --- | --- | --- |
| `GEUL_SANDBOX=userns-root-bwrap python3 scripts/cargo-geul.py test --locked --offline --lib -- services::save` | 154 PASS/15 ignored(새 시험 포함 후, lint 정리 뒤 재실행) | `a/test3.log`, `test4.log` |
| 제품 앱 `tauri-geul.py build --no-bundle`(시험 플래그 0) → `c5783fd0…`, HEAD `1573bece`; `rhwp-artifacts.py --verify-product` | PASS | `a/app-final.sha256`, `verify-product-final.log` |
| `scripts/tests/native-hwp-preview.py`(격리 X11/IBus, 실제 Tauri 저장 서비스): calc-cell 셀 A1 `1→15`, `=SUM(ABOVE)`=18, 저장, 디스크 재열기, `=MAX(ABOVE)`=15, 두 번째 저장, 최종 재열기 | 10/10 PASS, 정리 후 잔존 프로세스 0 | `a/native-final/` |
| `python3 -I scripts/tests/verify-hwp-preview.py`(표준 라이브러리만, 별도 CFB/PNG/GIF 해석) | 20/20 PASS: 스트림 집합 동일, 관련 없는 스트림 바이트 동일, 724×1024 정규 PNG, 원본 GIF·PrvText 바이트 부재, 셀 값 15/18→15, 재열기 화면 1쪽과 평균 차 0.108, 1·2회 미리보기 차이는 수식 셀 영역뿐 | `a/native-final-verify.json` |
| 실패 기록 | native1: 두 번째 저장이 `partMissing:PrvText`(빈 PrvText 결함, 수정). native2: 저장은 됐으나 수식 미적용을 독립 검증기가 검출. native3: 수식 거부(B 원인) | `a/native1`–`native3`, `native2-verify.json` |
| 원본 고정본 | `e22c45dc…` 변경 없음 | `sha256sum` |

### B — 지원 범위

top-level 완전 격자, 첫 문단 소유 단일 필드 셀에서 기존 필드 결과 서식이 `%g` 또는 `%.Nf`(소수 N자리 정확)일 때 투영이 식을 읽는다. 바뀌는 것은 대상 필드뿐이며 엔진은 대상 명령을 `%g`로 다시 쓴다. 다른 한컴 필드는 명령·값·fieldId가 그대로다. 직접·간접 순환, 깨진 고정소수 캐시(`2`, `2.000`, `%.12f`, `%.2e`, `%d`)는 기록 전에 거부한다. 제한 256/16/4096 유지. 실제 서비스 producer `cee91412…`(HEAD 소스로 새 빌드): `b/service-results.json`, 재열기 `b/reopen-published.json`. 조사(`b/formula-command-survey.txt`): 다른 한컴 표본의 `%g` 캐시 중 천 단위 구분 기호 값과 중첩 표 필드는 계속 거부한다.

### C — WordCraft 원격 재현성과 CI

`git ls-remote`: `refs/heads/geul/semantic-roundtrip-equivalence`=`b39a8fb…`. 새 빈 저장소의 정확 SHA fetch는 `not our ref`(exit 128). `6c994e4`, `615697c`, 새 `077be5db` 모두 로컬 전용이다. 원격 가지 끝은 로컬 HEAD의 조상이므로 공개는 fast-forward 하나면 된다(실행하지 않음):

```sh
# 승인된 경우에만, 저장소 소유자가 실행
git -C external/wordcraft push origin 077be5db9be28f26ea23940a2ef71786037aa393:refs/heads/geul/semantic-roundtrip-equivalence
# 이후 새 위치에서: git clone https://github.com/MinGyu2/geul && git submodule update --init external/wordcraft
```

WordCraft `cargo xtask ci`(077be5db, 보호 wrapper): fmt ok, clippy ok, **test FAIL** — 엔진 450 PASS/1 FAIL, 실패는 변경 전과 같은 file-access scanner(`crates/engine/src/cmd/file.rs:264`의 직접 `std::fs::File::open`)이다. 그래서 assets/layers/wasm은 ci 안에서 skip되었고 따로 실행해 assets 54, layers 20 crates, wasm 16 crates PASS였다. **전체 CI는 FAIL**로 기록한다; scanner 정책은 바꾸지 않았다(`c/wc-xtask-ci.log`, `wc-xtask-{assets,layers,wasm}.log`). geul: 보호 `cargo-geul.py test --lib` 337 PASS/24 ignored, `clippy --all-targets -D warnings` PASS(기존 adapter 시험 lint 포함 수정), `fmt --check` PASS. 프런트엔드: `npm test` 1260 PASS, typecheck·lint PASS, `table-formula-session` 103 PASS(시험 플래그 1), `advanced-production`+`table-formula-session` 111 PASS(플래그 0, 이 묶음의 기록 구성), legacy WASM 37 PASS/1 선택 SKIP. `advanced-production`을 플래그 1로 돌리면 4건이 실패하는데, 그 묶음은 제품(플래그 0) 전용 단정이며 이번 변경과 무관한 구성 차이로 판단했다(기준 HEAD에서 재실행하지는 않음).

### 커밋

| 저장소/커밋 | 내용 |
| --- | --- |
| geul `3ff5bee68bed258293274b0a964f7a29474fa59b` | A: 미리보기 재생성·검증, 프레임, 시험, native 하네스·독립 검증기 |
| geul `1573bececf7fa8ae2c9ddfea6ad0612b4e4c67f0` | B: 한컴 고정소수 수식 캐시 인정, 실제 WASM 시험 |
| WordCraft `077be5db9be28f26ea23940a2ef71786037aa393` (parent `615697c6`) | C 엔진: 문단을 넘는 경계 보존, TOC 대상 제거 시 재생성, 본문 링크 대상 보호 |
| geul `eb50a9dffe572543545367bc0153927c006b46fd` | C 통합: gitlink, adapter·두 회차 durable 시험, 기존 clippy 지적 수정 |
| geul `bbedf0a34f6a685f604ef512613d476a5d463411` | C 시험 문서 주석 lint |

push는 하지 않았다. Microsoft Word·Hancom Office는 **NOT RUN**.


<a id="blank-preview-wc-ci-20261108"></a>
## 2026-11-08 후속 2: HWP 빈 첫 쪽 미리보기 · WordCraft 감사와 CI

결과: **PARTIALLY COMPLETED**. A는 지원 범위에서 완료, B는 file-access 정책 위반을 고쳤지만 그 뒤에 드러난 기존 UI 시험 실패로 WordCraft 전체 CI는 여전히 **FAIL**. T010 INCOMPLETE, T012/T013 △ 조건부 미완료, D2 INCONCLUSIVE, D4 지연 FAIL/자원 INCONCLUSIVE, WordCraft 원격 BLOCKED, Word/Hancom NOT RUN 그대로. 시작 HEAD `157d3a87ce7fbbed9a967e601b53ec331ba966ae`, RHWP `1a76570e…`(15패치, Release `342ebaad…` 재빌드 없음). 증거 `target/blank-preview-wc-ci-20261108/`.

### A — 빈 첫 쪽

- 결함: `refresh_previews`가 한 색 렌더를 `text_preview` 결과가 비었는지로 판정했다. 빈 본문의 PrvText는 왕복 가능한 CRLF이므로 모든 한 색 렌더가 거부되었다.
- 재현(수정 전 실제 앱 `c5783fd0`): 한컴 `re-align-left-hancom.hwp`(5.0.3, GIF 177×250, 100자 한 문단)의 글자를 제품 키로 모두 지우고 Ctrl+S → `previewStale:PrvText,PrvImage` 거부, dirty·파일 유지(`a/native-before`). 실패한 하네스 시도와 `re-01-hangul-only-hancom.hwp`(글자 지우기만으로도 RHWP가 DocInfo ID_MAPPINGS를 64→72바이트로 다시 써 `recordsChanged:DocInfo`)는 `a/native-before-attempt*`에 보존.
- 수정: 한 색 렌더는 (1) 프런트엔드가 다시 연 내보내기의 엔진 1쪽 그리기 목록이 평범한 쪽 배경과 빈 글줄만임(`classifyFirstPage`→`blankPage`), (2) 백엔드가 Section0 첫 문단(항상 1쪽)에 보이는 글자·구역/단 외 컨트롤이 없음을 확인할 때만 받는다. 공백 글줄·선·도형·그림·테두리/그라데이션/그림 배경·알 수 없는 구조는 빈 쪽이 아니다.
- 대응 검증 강화: 실제 WASM에서 캡처 원본이 백엔드로 보낸 정확한 바이트를 다시 연 문서임을 증명(살아 있는 세션 아님), 실제 layer tree 분류(빈 쪽·글·표·동기/비동기 그림·1쪽 빈 뒤 2쪽 글). 독립 검증기는 8×8 블록 지표(같은 쪽 ≤5.2, 다른 저장의 쪽 ≥19.5, 한계 10)와 저장 간 교차 음성 대조를 매번 확인한다. 백엔드는 픽셀이 쪽을 나타냄을 증명하지 않으며(프런트엔드 근거), 그 경계를 시험으로 명시했다.
- 엔진 한계(이번 변경 밖): 이 HWP 5.0.3 파일에 글자를 넣으면 RHWP가 DocInfo를 다시 써 T009가 거부한다. 그래서 빈 쪽 시나리오의 후속 편집은 문단 나누기 두 번이다.

| 명령/시험 | 결과 | 증거 |
| --- | --- | --- |
| 보호 `cargo-geul.py test --lib -- services::save` | 160 PASS/15 ignored(새 6) | `a/rust-a1.log` |
| 보호 `test --lib`, `clippy --all-targets -D warnings`, `fmt --check` | 342 PASS/24 ignored, PASS, PASS | `a/rust-lib.log`, `clippy.log`, `fmt.log` |
| `npm test`, typecheck, lint | 1262 PASS, PASS, PASS | `a/frontend-all.log` |
| 실제 WASM `table-formula-session` + `hwp-preview-capture`(플래그 1) | 105 PASS | `a/wasm-session.log` |
| 제품 앱 `c17cd681…`(HEAD `e4b0b351`, 플래그 0), `--verify-product` | PASS | `a/app-final.sha256` |
| native 빈 쪽(`native-hwp-blank-preview.py --expect saved`): 100자 삭제→저장→디스크 재열기→문단 나누기 2회→두 번째 저장→최종 재열기 | 8/8, 잔존 프로세스 0 | `a/nbf/` |
| `verify-hwp-blank-preview.py` | 18/18: 정규 724×1024 흰 PNG, PrvText CRLF, 원본 GIF 부재, 관련 없는 스트림 동일, 재열기 화면도 빈 쪽, 원본 GIF는 빈 쪽과 불일치(블록 253) | `a/nbf-verify.json` |
| native calc-cell 회귀 | 10/10 | `a/nfc/` |
| `verify-hwp-preview.py`(강화) | 21/21, 교차 음성 대조 19.88/19.5 불일치 | `a/nfc-verify.json` |

### B — WordCraft 감사와 CI

- 감사: 로컬 `077be5db`의 `bookmarks.rs`/`review.rs`/`references.rs` 변경을 다시 읽고, Track Changes가 켜진 채 같은 명령 안에서 TOC를 다시 만들 때 추적 표시가 남지 않고 관련 없는 하이퍼링크가 남는지 시험했다(통과, 엔진 수정 불필요). 시험만 `71b912ed`로 남김.
- 정책 위반: `file_access::tests::commands_do_not_touch_the_file_system_themselves`가 `cmd/file.rs:264`의 직접 `std::fs::File::open`(Release 0.7.0 `fc41918`부터 동일)을 잡았다. 보호 실행으로 수정 전 exit 1 재현. 승인된 관문 `crate::io`에 `read_file_head(path, limit)`(read root 검사·열기·경계 읽기, 기존과 같은 의미)를 더하고 호출을 옮겼다. 정책·스캐너는 그대로. 새 시험과 #1081 Word 2003 저장 시험 통과(`4b90d31c`).
- CI: `cargo xtask ci`(보호 wrapper, 수정 후) exit 1 — fmt ok, clippy ok, **test FAIL**: 엔진 453 PASS/0 FAIL이 되었지만 `wordcraft-ui-egui`의 `clicks_on_ribbon_and_status_bar_chrome_keep_typing_in_the_document`(386 PASS/1 FAIL)가 실패해 assets/layers/wasm은 skip. 이 UI 시험은 `077be5db`(패치 없음), `6c994e4`, 업스트림 `fc41918`에서도 같은 위치(lib.rs:3426)로 실패한다 — 이전에는 엔진 실패에서 cargo가 멈춰 가려져 있던 **기존 실패**이며 geul과 무관하다. `--no-fail-fast` 전체 작업공간 2078 PASS/1 FAIL(그 UI 시험뿐), 따로 실행한 assets 54·layers 20·wasm 16 PASS(첫 layers 실행은 병렬 이력 빌드와의 무결성 검사 경합으로 실패, 재실행 PASS). **전체 CI는 FAIL**.
- geul: gitlink `71b912ed`(`efd42065`), 보호 lib 342 PASS(어댑터·두 회차 durable DOCX 포함), clippy·fmt PASS, DOCX 16개 독립 검사 PASS(`b/docx-structure.json`).
- 원격: `ls-remote` 가지 `b39a8fb`, 정확 fetch `not our ref`. 로컬은 fast-forward 7커밋(`af80638`…`71b912ed`). 승인 시 `git -C external/wordcraft push origin 71b912edf6ff9398940bb1026b7b1cfa2a2505d9:refs/heads/geul/semantic-roundtrip-equivalence`, 이후 새 체크아웃 `git clone https://github.com/MinGyu2/geul && git submodule update --init external/wordcraft`. 실행하지 않음 — **BLOCKED**.

| 커밋 | 내용 |
| --- | --- |
| geul `e4b0b3516a7c6fc524f2c32c890cb0ef0c9fe07c` | A |
| WordCraft `4b90d31c67643f42aac8dedc38e2de0da92c238a` | file-access 관문 수정 |
| WordCraft `71b912edf6ff9398940bb1026b7b1cfa2a2505d9` | TOC 재생성 감사 시험 |
| geul `efd4206575551a5abab914c5c0359b1b2dd5dd64` | gitlink |

push 없음.


<a id="t012-advanced-20261113"></a>

## 2026-11-13 — T012 고급 기능 차단 원인 보정과 제품 범위 확대

**판정: PARTIALLY COMPLETED.** 아래 구현과 명시한 내부/native 범위는 일반 Release 제품에서 활성화했다. T012 전체 완료나 임의의 복잡 HWP/HWPX·외부 한컴 호환성을 주장하지 않는다. 위 날짜별 수용 기록과 T010의 일반 입력/IME history 제품 GO는 보존한다. 과거의 “일반 history 비활성”, “128 KiB·8쪽”을 현재 일반 제품의 전역 한도로 읽지 않는다.

### 실제 차단 원인과 구현

| 기능 | 분류와 확인한 원인 | 현재 제품 경로와 남는 경계 |
|---|---|---|
| 기존 셀 글·다중 문단·병합 geometry | 이미 엔진/세션 지원. 새 표 생성과 기존 셀 편집은 다른 증명을 사용 | 기존 편집 유지. 병합 anchor/row·col·span 검사와 두 차례 왕복 회귀 유지. 병합에 덮인 비-anchor 좌표를 anchor 별칭으로 해석하지 않음 |
| 첫 문단 계산식 + 후속 필드 | C: 엔진은 첫 문단 사본만 바꾸는데 후속 문단에 필드가 있으면 셀 전체를 거부 | `table-formula-tail-preservation.patch`로 후속 문단 모델/직렬화 자료를 보존. 세션은 소유권·범위·텍스트가 증명된 단일 후속 ClickHere 필드만 추가 지원. 다른/중첩/모순 컨트롤은 계속 거부 |
| HWP 새 수식의 저장 | B: `hwpReopenModel`이 모든 child control을 unknown으로 보아 정확히 같은 live/reopen도 새 필드 inventory를 증명하지 못함 | cursor-list 소유자·문단의 단일 컨트롤·전체 field record를 교차 확인. 첫 문단 수식은 엔진의 읽기 전용 validator로 같은 fieldId/range를 확인하고 캐시·명령·이름·안내·위치를 비교. 모호한 소유권/누락/중복/미지원 종류는 incomplete 유지 |
| 한컴 `%.Nf` 식의 입력창 | A: 의존성 검사는 지원했으나 `existingFormula`의 `%g` 전용 정규식이 식을 놓침 | 공통 `cachedFormula`로 일치하는 캐시만 prefill. malformed/미지원 표현 거부 유지. 편집 결과는 기존 `%g` 기록 방식 |
| 큰 문서의 고급 명령 | E: 압축 원본 크기·쪽 수로 모든 연산을 거부. 일반 history는 이미 별도 자원 감시를 가짐 | 일반 timeline의 기존 `historyBudget`/snapshot capacity/실측 WASM 증가 감시 + 단일 문단 ownership/표 의존성 예산을 사용. advanced-only fallback의 128 KiB·8쪽·깊이 4는 유지; 일반 history 깊이는 기존 정책 그대로이며 한도를 올리지 않음 |
| 새 표/중첩 표/구조 변경 | B/C/G: 엔진의 경로/행·열 primitive 존재와 앱의 typed operation·보존 증명은 별개 | 기존 새 HWP 표 생성 한도(32행·16열·256셀) 유지. 직접 중첩 경로·새 행/열·병합 구조 변경을 일괄 제품 지원으로 선언하지 않음 |
| 외부 상호운용성 | F: 내부 왕복은 외부 Office 실행 증거가 아님 | Hancom Office 및 T015/T016 전체 corpus/platform 수용 NOT RUN/미완료 |

수식의 256자·깊이 16·셀 방문 4096·의존성/직간접 순환 거부를 유지한다. 값은 참조 셀 편집 뒤 명시적으로 재계산하며, 자동 연쇄 재계산을 추가하지 않았다. 수식 목적지는 셀의 첫 문단뿐이고 다른 문단에는 전용 거부 이유를 표시한다. 새 HWP 필드는 원본의 완전한 구조 증명이 있어야 하며, 기존 수식의 교체는 이미 지원하던 unchanged-inventory 경로를 보존한다. registry flag만으로 기능을 켜지 않았다. IME/pending/save·revision/세션 소유권·history transaction·T009 safe/unsafe/unknown·원본/참조/preview/recovery 규칙은 유지했다. Rust 저장 검사기는 수정하지 않았다.

### 실행 신원과 집중 증거

시작 HEAD `5ee56e30dc9f92111fa2320279b4ba52a1d15e23`, branch `master`. RHWP `1a76570e833917d15817415a53c09ad61ab3203f`, WordCraft `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5`는 그대로다. 최종 로컬 커밋은 Git 로그를 따른다. push/원격 branch/PR 생성 없음.

- 순서 있는 패치 18개. Python/TS 산출물 검증기는 정확히 18개까지 받으며 19개·중복·변조 provenance를 거부한다. 패치별 SHA/소스 트리/세대 digest 검사를 유지했다. Release generation `18e5dafdadfa5a4754f98b575eb93d22947c8fda549248241a02c8d7f181f56b`, WASM SHA-256 `e50b71e4c29d7aea3fbacb09e7cbce5be00b0b2f5f0ce9db3b02fd188faff912`.
- 일반 `python3 scripts/tauri-geul.py build --no-bundle` 제품 빌드. `dist/frontend-build.json`: production, `testFlags={}`. Release 실행 파일 SHA-256 `c134290f6074ad7bfc408424ff9542f65416b47015155bf3196061c5748e1c1c`.
- 로컬 ignored 증거: `target/t012-advanced-20261113/`. 초기 실패/거짓 reopen 증거도 보존했으며 성공 자료로 바꿔 쓰지 않았다. 이전 prepared source와 비활성 generation 하나는 소비자 종료 확인 후 해시 그대로 이 디렉터리에 보관했다. generation retention 한도는 늘리지 않았다.

| 실행 | 실제 결과와 증거 |
|---|---|
| `scripts/build-rhwp-wasm.py` (locked/offline, read-only dependencies) | Release 성공, external unchanged. `wasm-build-final.log` |
| `vitest --config scripts/tests/vitest.config.ts table-formula-session.wasm.test.ts advanced-production.wasm.test.ts -t '^(?!.*large .* document)' --testTimeout120000`, 네 시험 flag unset | 최종 117 PASS, 대용량 2건 의도적 제외. `wasm-activation-final.log`; 대용량은 아래 별도 근거 재사용 |
| 실제 대용량 두 형식 | 2 PASS. 원본 HWP 195,584 B/HWPX 159,951 B, 각각 100쪽. 장평·자간·수식 삽입·참조 편집·명시적 재계산·6 Undo/Redo·두 번 편집/재열기. `wasm-large-final.log`, `large/` |
| 다중 페이지 표 | HWP/HWPX 각각 480행×2열, 960셀, 10쪽. 모든 셀의 geometry·비대상 글 보존과 두 번 저장/재열기. `wasm-multipage.log`, `complex-activation-final/` |
| HWP 상세 재열기 모델 | 73 PASS(known field 정상·누락·중복·다른 소유자·nested path·cache/필드 명령·name/guide 변조 거부). `hwp-reopen-model-tests.log` |
| 집중 frontend·profile | 최종 소스 46 PASS(`frontend-activation-final.log`), Python profile 3 PASS(`profiles.log`); 18/19 경계·세대/provenance 변조 거부 포함 |
| 타입·린트·빌드 | scoped script+제품 TypeScript, 변경 TS/JS ESLint, diff check 및 일반 Release 빌드 PASS. `script-types-activation.log`, `eslint-activation.log`, `product-build-activation.log` |
| 실제 T009 service | 기존 보호된 `t010_phase0_save_service`의 generic driver 사용(관련 source compile만 수행, T010 전체 suite 아님). 후속 필드/다중 쪽 표/큰 문서 12 durable 저장, malformed HWP/HWPX 2건 `UnsafeSave/reopenMismatch` 거부·dirty 유지·원본 SHA/디렉터리 보존. `service-final/summary.json`; 원본 fixture 12개 hash 유지 |
| 게시 파일 독립 재열기 | 실제 게시 12파일을 같은 Release로 열어 형식/쪽/글/컨트롤/전체 필드 비교 PASS. `service-final/published-reopen.json`. generic 요청 두 회차와 실제 파일을 연속 저장하는 native 흐름을 구별함 |
| 최종 일반 Release native Tauri/X11/Xvfb/IBus | 두 형식 56/56 PASS: trusted Hangul/IME barrier, 일반 입력+고급 Undo/Redo, invalid width/식·self-cycle 거부, 장평·자간·수식 삽입/교체/참조 편집 뒤 재계산·반복 실제 저장/GTK 재열기. 후속 ClickHere 필드 fixture 사용. `native/result.json` |
| native 종료·독립 oracle | launcher/child exit 0, complete/proven/filesystemProven true, survivors/processErrors 없음. fixture hash 유지. `native-session/cleanup.json`; 실제 저장 상태 16개(형식별 8개) 재열기·필드 identity/캐시·7개 언어 속성·후속 문단/필드 보존 PASS: `native-published-reopen.json` |

큰 문서의 관측 WASM 선형 메모리는 HWP 24,641,536 B, HWPX 36,438,016 B였다. 이는 모듈 간 재사용을 포함한 high-water 관측이며 RSS/정확한 snapshot 크기/모든 입력의 상한 증거가 아니다. 기존 snapshot 증가 예산 256 MiB와 렌더 canvas/전체 픽셀 예산은 그대로다. 270k 문자/169쪽 fixture는 최소 배율에서도 렌더 예산을 넘어 `RenderLimit`로 안전 거부했다(`large-diagnostic.log`); 더 작은 실제 160k 문자/100쪽 fixture는 예산 안에서 검증했다. 기본 배율에서 표시 예산을 넘으면 낮은 배율이 필요하다. 원 T010 D4 지연 목표/결과는 재측정하거나 재정의하지 않았다.

초기 실행의 fixture 기대값 오류·5초 test timeout, HWP child-field proof 부재, 도구/patch-count/retention/실행 경로 준비 오류와 보정 후 결과는 각각의 로그에 남겼다. source가 같은 통과 검사를 재실행해 숫자를 불리지 않았으며, 변경된 가드와 새 증거 생성에 필요한 검사만 갱신했다. 네이티브 결과는 이번 생성 fixture의 T012 흐름만 증명한다. 과거 run5/Stage 5–6/T010의 날짜별 PASS를 새 엔진의 전체 수용으로 재사용하지 않았다. 전체 CI·T015/T016 행렬·20-case corpus·frontend 전체·Rust HWP 전체·성능 benchmark·외부 Hancom/Word는 이번 작업에서 재실행하지 않았다.


### T012 fixture/oracle 검증 보정 (2026-11-13)

시작 HEAD `88d15b4469abe8ec7be1258088a6902ade75098f`. 위 기존 PASS는 당시 소스·fixture의 기록으로 보존한다. 당시 생성기는 문단 분리/ClickHere 삽입 반환값을 확인하지 않았고, oracle은 source와 saved의 필드 목록이 모두 비어도 같다고 판단할 수 있었다. 제품 결함으로 확인된 것은 아니다.

생성기는 실제 JSON `ok`와 생성 직후/Release 재열기 후의 필수 후속 문단·ClickHere 존재를 확인한다. geometry 준비도 같은 검사를 요구한다. oracle은 필드 ID/type/command/name/guide/value, 표·물리 셀·문단·cursor-list·컨트롤 소유권, 비중첩 위치와 글 범위를 검증하고 저장본과 정확히 비교한다. 원본 SHA 검사를 유지하며 저장본의 전체 필드 inventory도 기록한다. 필드 없는 양쪽 목록의 동등성만으로는 PASS할 수 없다.

새 증거는 ignored `target/t012-verifier-20261113/`에 분리했다. 실제 Release HWP/HWPX 양성 및 누락·실패한 연산·잘못된 소유권/위치/범위·중복·저장 후 변경 음성 회귀 4건 PASS. 새 두 fixture는 B2 두 번째 문단의 ClickHere 하나를 독립 재열기로 증명했다. 동일한 기존 Release 제품(native binary SHA `c134290f6074ad7bfc408424ff9542f65416b47015155bf3196061c5748e1c1c`)으로 coherent native harness 56/56 PASS, 형식별 8개 저장 상태 독립 재열기 PASS. Release generation과 WASM SHA는 위 기록과 동일하다.

최초 native 실행은 IBus 초기 모드 미지정으로 HWP 조합 대기에서 실패했다(7개 선행 검사 PASS). 실패 자료를 보존하고 기존 실행과 동일한 `--hangul-initial-mode hangul` 설정으로 한 번 재실행했다. 성공 실행 launcher exit 0, cleanup complete/proven/filesystemProven true, survivors와 processErrors 없음. `native-rerun/result.json`, `session-rerun/cleanup.json`, `reopened-final.json`, `evidence.json`이 새 실행 근거다.

이번에는 전체 WASM 117건·T009/T010 전체·100쪽·성능·전체 CI·DOCX/WordCraft·T015/T016을 재실행하지 않았다. RHWP/WordCraft pin과 제품 소스는 변경하지 않았다. T012는 계속 조건부 미완료이며 Phase 2 및 중첩 표/구조 편집은 시작하지 않았다.


### T012 ordinary geometry·필드 ID/컨트롤 증거 보정 (2026-11-13)

시작 HEAD `694ec9ddceb9a035093435fa76777176a1d88be0`. ordinary `fixtures` 생성 후 `geometry`를 실제 실행하여 `required trailing paragraph missing or duplicated` 실패를 재현했다. 원인은 geometry가 complex 전용 `inspectRequiredTail`을 무조건 호출한 것이었다. CLI 인자는 유지하며 기존 생성 manifest `fixtures.json`의 boolean `complex`, Release 신원, 형식별 source 경로/SHA를 확인한 뒤 공통 geometry 구현에서 해당 구조를 검사한다. ordinary는 셀별 한 문단·빈 필드 목록을 요구하고 complex는 기존 필수 후속 ClickHere 검사를 유지한다. 모드 누락/비boolean·해시 불일치·선언과 실제 구조의 모순을 ordinary fallback으로 숨기지 않는다. 생성 manifest 없는 임의 디렉터리는 거부한다. 기존 native geometry 기록은 strict complex source 검사를 유지하는 조건으로 재사용한다.

필드 ID는 Release의 `getFieldList`가 반환한 하나의 전체 inventory에서만 검사한다. 엔진의 ID 기반 조회와 기존 ID 최댓값 이후 할당 계약을 확인했으며, 중복 ID(ClickHere와 formula 사이 및 다른 formula들 사이 포함)를 거부한다. 여러 API의 메타데이터를 합쳐 중복 계산하지 않는다. 실제 Release ClickHere 컨트롤의 `ctrlId=""`, `ctrlCh=0`, `controlIndex=0`, `pos=0`, `userDesc=""`, `props={}`를 확인했고, 누락/비객체/비어 있지 않은 props와 예상 밖 userDesc 및 중복 소유자를 거부한다. 기존 위치·cursor-list·범위·값·원본 SHA 가드는 유지했다.

새 로컬 증거: `target/t012-verifier-gaps-20261113/`. 집중 회귀 7/7 PASS(기존 양성·음성 유지, 실제 Release HWP/HWPX ordinary/complex geometry와 잘못된 선언·필드 누락·ID 충돌·컨트롤 메타데이터 변조 포함). `ordinary-geometry.json`, `complex-geometry.json` 모두 두 형식 PASS. 두 mjs 문법 검사와 diff 검사 PASS; 기존 ESLint 설정의 대상 glob은 mjs를 포함하지 않는다. 초기 회귀 실행의 테스트 기대/변조 대상 선택 오류를 수정한 뒤 관련 집중 검사만 다시 실행했다.

기존 `target/t012-verifier-20261113/`는 변경하지 않았다. `identity-check.json`에서 당시 Release generation/manifest·제품 binary·source 2개·저장 상태 16개 SHA 및 동일 `native-rerun` 결과/cleanup의 기존 증거 hash 일치를 확인했다. 그 뒤 보강 oracle을 기존 geometry와 저장본에 적용하여 HWP 8개·HWPX 8개 PASS(`reopened.json`). 이는 새 oracle 실행이며, native 56/56은 이전의 동일 입력·제품 실행 기록이다. 이번 native GUI 재실행은 없고 관련 없는 WASM 전체·T009/T010 전체·CI·대용량·성능·DOCX/WordCraft·T015/T016도 재실행하지 않았다.

제품 동작·엔진/패치·submodule pin은 그대로다. T012는 계속 조건부 미완료이며 Phase 2는 시작하지 않았다.


<a id="t012-phase2-20261113"></a>

## 2026-11-13 — T012 Phase 2: 중첩 표 직접 편집과 표 구조 명령

**판정: PARTIALLY COMPLETED.** 아래 지원 범위는 구현·일반 Release 제품 활성화·검증했다. 중첩 표 생성, 중첩 표 안의 구조 변경, 필드/개체/캡션이 있는 표의 구조 변경, 여러 셀 범위 병합은 미지원으로 막혀 있다. T012 전체 완료나 외부 Hancom 호환, T015/T016 행렬 수용을 주장하지 않는다. 위의 날짜별 기록은 그대로 보존한다.

시작 HEAD `e809b9327fe83dee20ec3b890701383d892100eb`, branch `master`. RHWP gitlink `1a76570e833917d15817415a53c09ad61ab3203f`, WordCraft `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5`는 바꾸지 않았다. **RHWP 패치는 추가하지 않았다**(18개 그대로). Release generation `18e5dafdadfa5a4754f98b575eb93d22947c8fda549248241a02c8d7f181f56b`, WASM SHA-256 `e50b71e4c29d7aea3fbacb09e7cbce5be00b0b2f5f0ce9db3b02fd188faff912` — 고정 엔진에 이미 있는 경로(`…ByPath`)·표 구조 API를 typed 경로로 사용했다.

### 구현

| 영역 | 변경 | 경계 |
|---|---|---|
| 위치·소유권 | `CellRef.nested`(바깥 셀 → … → 실제 셀의 명시적 경로, `rhwpText.ts`). 한 단계 셀은 기존 모양 그대로. `parsePosition`은 엔진 `cellPath`의 첫 단계가 scalar 필드와 정확히 같을 때만 받는다. `sameContext`는 모든 단계의 표 컨트롤·셀과 호스트 문단을 비교한다(부모 셀·형제 셀·다른 중첩 표와 구분). 캐시·기록 키(`positionKey`, `contextKey`)도 경로 전체를 포함 | 최대 깊이 4(바깥 + 3). 더 깊거나 모양이 다르면 `null`. 화면 좌표로 소유를 추정하지 않음 |
| 소유 증명 | `RhwpText.ownsNestedCell`: cursor model의 셀 목록을 뿌리부터 단계마다 (호스트 목록, 호스트 문단, 컨트롤, 셀)로 정확히 하나 찾고, 각 단계 표의 셀 수·문단 수를 `…ByPath` 응답과 교차 확인. 세션은 구조 판(`structureVersion`)마다 결과를 캐시 | 클릭·Tab·세로 이동·모든 편집(`mutate`) 전에 확인. 실패하면 엔진 호출·history 없이 거절하고 캐럿을 문서 처음으로 옮김 |
| 중첩 셀 편집 | 글 넣기·선택 바꾸기·Backspace/Delete·문단 나누기/합치기·조합(IME)·셀 사이 Tab·세로 이동·선택 사각형·캐럿을 `…ByPath`로. 엔진 응답의 `ok:true`를 요구 | Home/End는 엔진에 경로 줄 질의가 없어 문단 처음·끝. 장평·자간·서식·표 계산/수식은 중첩 셀에서 `nestedTable` 이유로 막음 |
| 표 구조 | `tableStructure.ts` + 세션 `table.*` 9개 명령(위/아래 행 넣기, 왼/오른쪽 열 넣기, 행/열 지우기, 오른쪽/아래 셀과 합치기, 합친 셀 나누기). 엔진 호출 전 격자와 모든 셀 글로 **정확한 결과 표**를 계산하고, 호출 뒤 표를 다시 읽어 셀마다(좌표·span·문단 글) 비교. 다르면 던져 `mutate`가 직전 snapshot으로 되돌림. 캐럿은 결과 격자에서 다시 찾음 | 본문 수준 표만. 표의 어느 셀이든 필드가 있으면 `tableFormula`(좌표 참조 이동 미지원), 셀에 컨트롤(중첩 표·그림 등)·캡션이 있으면 `tableContent`, 걸친 병합·크기 한도(512행·64열·4096셀)·정의되지 않는 모양은 `tableShape`/`limit`. HWP는 기존 구조 편집과 같은 원본 preflight 증명이 필요. 연산마다 따로 판정 |
| 명령·UI | registry/capability/parameters/target에 명령·이유 추가, 리본 "한글 도구 › 표 구조" 그룹, ko/en 문구 | 전역 flag 없음. 가용성은 세션의 실제 문서 구조로만 결정 |
| HWP 재열기 모델 | `hwpReopenModel`이 중첩 셀(경로·좌표·문단 글)을 `model`에 포함 | 중첩 컨트롤은 여전히 `complete=false`(구조 인벤토리 변화에는 증명 불충분) |
| T009 HWP 검사기 | `insertions.rs`: 같은 instance id의 원본 표가 행·열·병합(또는 셀별 문단 수)이 바뀐 경우 `restructured_table` 증명 — CTRL_HEADER 크기 외 동일, 표 속성 단어·셀 간격·안쪽 여백·테두리 동일·셀 영역 없음, 양쪽 모두 텍스트 문단만 있는 평범한 표, 출력 격자 정합·행별 셀 수 일치, 모든 출력 셀의 목록 속성·여백·테두리·후미 바이트가 어떤 원본 셀과 같음. 셀 글은 기존처럼 독립 live/reopen 모델 비교의 몫 | 격자가 같은데 글만 바뀐 원본 표, 깨진 격자, 컨트롤이 있는 표는 기존 계약(원본 객체 바이트 동일) 유지. 기존 거부 코드·순서 보존. HWPX 패키지 비교는 변경 없이 통과 |

### 실행 증거 (최종 소스)

로컬 ignored 증거: `src-tauri/target/t012-phase2-20261113/final/` (보호 sandbox 쓰기 허용 경로). 같은 디렉터리의 상위 `engine/`·`*.log`와 `target/t012-phase2-20261113/`는 최종 전 실행이며 성공 증거로 쓰지 않는다.

| 실행 | 결과 |
|---|---|
| `GEUL_T012P2_PHASE=generate … vitest --config scripts/tests/vitest.config.ts table-phase2.wasm.test.ts` (시험 flag 없음) | 11 PASS: 위치 파싱/동일성 경계; HWP·HWPX 중첩 셀 클릭 배치·삽입·선택 바꾸기·Backspace/Delete·문단 나누기/합치기·IME 조합·셀 이동·Undo 전체/Redo 전체(정확한 원래/편집 모델)·부모/형제/다른 중첩 셀 불변·저장; 소유하지 않은 경로 5종 거절(문서·revision·history 불변); 형식별 구조 11단계(행/열 넣기·지우기, 병합 3종, 나누기) 각각 1 revision·Undo 1단계·Redo·정확한 격자/글, 3회 저장; 걸친 병합·선택·본문 캐럿·필드 표 거절; 세션 가드를 우회한 엔진 직접 구조 변경(필드 표)의 검사기 `recordsChanged` 거부. `1-generate.log` |
| 실제 저장 서비스 1회차 | HWP `hwp_contract_real_engine_publication`: 4 durable 게시(PrvImage 재생성, dirty false) + 1 게시 거부·원본 bytes 유지. HWPX `t010_phase0_save_service`: 4 durable 게시. `engine/hwp/publication.json`, `engine/hwpx/results-first.json` |
| repeat(게시 파일을 다시 열어 편집) + 2회차 게시 | 4 PASS(중첩 셀 재편집, 재구성된 표의 행 지우기·나누기·입력), HWP 2 + HWPX 2 durable. `3-repeat.log`, `publication-repeat.json`, `results-repeat.json` |
| verify | 새 엔진으로 게시 파일 12개를 열어 저장 당시 모델(평문·컨트롤·표 격자/셀 글·중첩 셀)과 정확히 비교 2 PASS. `engine/*/published-reopen.json` |
| HWPX 거부 | 손상 출력: `UnsafeSave/outputMalformed`, dirty 유지, 원본 SHA-256 `6d95c92c…` 전후 동일, 디렉터리 목록 불변. `engine/hwpx/negative-malformed/` |
| Rust | `services::save` 215 PASS/25 ignored(기존 계약 포함), 새 `hwp_restructured_original_table_is_proven_or_refused` 1 PASS(양성 + 템플릿 위조·셀 간격·instance id·행 크기·셀 안 컨트롤 음성), fmt/clippy `-D warnings` PASS. `../rust-*.log` |
| 프런트엔드 | tsc, 변경 TS ESLint PASS. 관련 단위 시험 899/900: 실패 1건 `src/commands/sessions.test.tsx`(rhwp 서식 이유 기대값)은 시작 HEAD에서도 같은 실패로 확인된 기존 결함이며 이번 변경과 무관 |
| 일반 Release 제품 빌드 | `python3 scripts/tauri-geul.py build --no-bundle` PASS, `dist/frontend-build.json` production·`testFlags={}`, 실행 파일 SHA-256 `141ef74c95c6c35cfd064bebf50509e5db212e1ca638400718fd75cc055ceab7` |
| native Tauri/X11/Xvfb/IBus (`native-t012-phase2.py`, `--hangul-initial-mode hangul`) | `native-4` 50/50 PASS: 형식별 native 클릭이 중첩 셀 경로로 해석, 중첩 셀에서 장평/수식/구조 명령 비활성, 입력·Undo/Redo, 조합 중 구조 명령 비활성, 신뢰된 compositionstart/end(`한`), 실제 Ctrl+S durable·GTK 재열기 clean; 표 리본 행 넣기·병합(각 1 revision, Undo/Redo), 저장·재열기; 원본 fixture 불변. launcher exit 0, cleanup complete/proven/filesystemProven, survivors 없음. `native-session-4/cleanup.json` |
| native 저장본 독립 oracle | `t012-phase2-native-oracle.mjs` PASS: 중첩 저장본은 대상 중첩 셀 하나만 `N1한…`로 바뀜(셀 인벤토리·컨트롤·나머지 평문 불변), 표 저장본 격자 정확 일치. `native-4/oracle.json` |

native 1–3회차 실패는 하네스 결함(캐럿 접미사 자르기, 사용 가능 버튼의 `aria-disabled` 부재를 `"false"`로 기대)이었고 제품 결함이 아니다. 로그를 보존했고 고친 뒤 한 번 재실행했다. HWPX 게시 드라이버는 보호 sandbox 안의 사용자 namespace에서 `shared-directory`로 거부되어 기존 기록과 같이 보호 compile 후 private TMPDIR로 직접 실행했다.

### 미지원·잔여

- **중첩 표 생성**: 고정 RHWP `createTable`은 본문 문단만 받는다. 셀 안 표 생성 API와 그 HWP/HWPX 직렬화·T009 증명이 필요하다(새 RHWP 패치 범위). 구현하지 않았다.
- **중첩 표 안의 구조 변경**: 엔진 구조 API가 본문 수준 표만 받는다. 위와 같은 패치가 필요하다.
- **필드·개체·캡션이 있는 표의 구조 변경**: 수식 참조 이동과 컨트롤 소유권 이동 증명이 없어 거부한다.
- **여러 셀 범위 병합/선택**: 셀 범위 선택 모델이 없어 인접 셀 하나(오른쪽/아래)만 지원한다.
- 중첩 셀의 서식·장평·자간·수식, 경로 줄 정보(Home/End는 문단 경계), 깊이 4 초과.
- 미실행: 전체 WASM 117건, T009/T010 전체, 대용량·성능(D4), 전체 CI, DOCX/WordCraft, T015/T016, Windows/macOS/Wayland, 외부 Hancom.

<a id="stage2-implementation-20261113"></a>
## Stage 2 구현 후속 — 2026-11-13

**PARTIALLY COMPLETED.** 시작 HEAD는 `1595e2924044bada048be331c25eabef627d5eec`(master), 작업 전 tracked/untracked 변경과 두 서브모듈 변경은 없었다. 아래는 구현 범위이며 T012 전체 수용 완료 또는 출시 승인이 아니다.

- `stage2-table-paths.patch`를 기존 재현 가능한 RHWP series에 추가했다. 서브모듈 핀은 유지했다. 기존 표 생성기를 경로 대상으로 확장하고, 기존 `Table` 행·열·병합·분할 구현을 명시적 경로로 호출한다. 부모 셀의 글과 후속 글자 모양 run 위치를 보존한다.
- 일반 제품 HWPX의 평범한 셀 문단에서 중첩 표 생성, 평범한 중첩 표의 행/열 삽입·삭제, 병합/분할을 연결했다. 필드·개체·자식 표를 가진 대상 표는 여전히 거부한다. 생성은 실제 셀 경로의 ownership·격자·커서 기하를 증명하고, 구조 변경은 기대 격자/모든 셀 문단을 대조하며, 실패하면 기존 history snapshot으로 되돌린다.
- 같은 표의 Shift+클릭/드래그 셀 선택과 `table.mergeCells` 리본 명령(ko/en)을 추가했다. 동일한 격자에서 기존 병합 span의 완전 포함 여부를 검사한다. 행 우선 순서로 참여 셀 문단을 보존한다. 범위 선택은 일반 텍스트 삭제·입력·IME 조합으로 넘기지 않는다. 본문 표는 HWP/HWPX, 중첩 표는 위 HWPX 지원 범위다.
- 일반 제품 HWPX 중첩 셀의 굵게·기울임·밑줄·취소선·장평·자간에 경로 서식 proof/API를 연결했다. HWP 중첩 고급 서식은 원본 변환 증명 가드를 유지한다. 경로 줄 질의와 soft-wrap caret affinity를 적용했다. Undo/Redo의 기존 모델·선택 checkpoint를 재사용한다.
- 고정 UI 깊이 4 대신 유한 경로 디코딩 예산(32 KiB·64단계), cursor inventory 8 MiB, 표 512행/64열/4096셀, 연산 proof의 총 4 Mi 문자/100,000문단 및 기존 snapshot/WASM 자원 가드를 함께 쓴다. **64단계의 모든 문서가 표시/저장된다는 보장은 아니다.** 기존 height measurer의 재귀 한도 10과 형식 파서/렌더 자원 한도도 별도로 남는다. 이번 직접 확인 대상은 깊이 6이다.
- transparent 1×1 틀의 조판 최적화가 부모 소유 경로를 생략하던 결함을 부분 표/전체 표 렌더 경로에서 수정했다. 조판 기하는 그대로 두고 source path를 보존한다. 중첩 caret 조회는 기존 page-hint API를 사용하며, ownership inventory는 단계마다 전체 scan하는 대신 한 번 색인한다. 표 격자 cache는 마지막 셀/문단 이동에 재생성되지 않는다. 큰 문자열은 WASM에서 읽거나 scalar 배열을 만들기 전에 proof 예산으로 거부한다.

### 집중 검증과 시행 이력

최종 Release WASM 세대는 `0623152b5d718b5b42de349344d2db0c84a90304ead61b801d9d80ea056902f2`, WASM SHA-256은 `84b4cf70ac6b4d6f117707bc548bc2f8b6627f9243ffe024af03c62a4c743e92`다. 기존 로컬 wasm-bindgen 0.2.127 실행 디렉터리를 PATH 앞에 지정한 `python3 scripts/build-rhwp-wasm.py` PASS(Rust 1.99.1, wasm-bindgen 0.2.127, 보호 실행/고정 핀/오프라인; externalUnchanged=true).

- `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage2-tables.wasm.test.ts`: 실제 제품 기본 설정/Release WASM 7/7 PASS. HWPX 중첩 생성·9 구조 연산·범위 병합·서식·history·T009 saved SAFE 및 파일 재열기, 빈 1×1 깊이 6의 Home/End·hit-test·HWP/HWPX 파일 재열기, 본문 두 형식 범위 병합, 변이 후 예외의 정확한 snapshot 복구, 기하/문자열 예산 거부를 묶었다. HWP T009 중첩 안전 저장 PASS를 뜻하지 않는다.
- `npm run build`(tsc/Vite), `npm run lint`: PASS. Vite는 기존 큰 bundle 안내만 출력했다.
- `npx vitest run src/ribbon/visibility.test.ts src/commands/parameters.test.ts src/components/Editor/rhwp/caretCache.test.ts`: 실제 존재하는 두 파일 12 PASS. `parameters.test.ts`는 지정 경로 실수로 없었고 실행되지 않았다. 새 명령의 런타임 ACTION_COMMANDS 연결은 위 실제 WASM 명령 검사에서 확인했다.
- `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/rhwpAssets.test.ts -t 'patched source identity'`: 1 PASS/11 필터 제외. `python3 scripts/tests/test_rhwp_profiles.py`: 3 PASS. 기존 깊이 경계 assertion은 새 디코더 상한 + 1 거부로 갱신하고 `GEUL_T012P2_DIR=target/stage2-focused/legacy-boundary npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/table-phase2.wasm.test.ts -t 'parses nested positions'`만 실행했다(1 PASS/16 필터 제외).
- 엄격한 WASM Clippy는 **FAIL**이다. `CARGO_NET_OFFLINE=true python3 scripts/external-integrity.py --require external/rhwp --writable target/rhwp-wasm --report target/rhwp-wasm/stage2-clippy-integrity.json -- cargo clippy --manifest-path target/rhwp-patched-source/Cargo.toml -p rhwp --lib --target wasm32-unknown-unknown --target-dir target/rhwp-wasm --locked --offline -- -D warnings`는 변경하지 않은 password-crypto crate 경고 2개에서 멈췄다. 본체만 `--no-deps`로 선택한 검사도 41개 경고로 FAIL. 같은 compiler/options로 봉인된 Stage 2 이전 소스와 현재 소스의 JSON 진단을 비교하니 각각 41개, code/message/primary file/source text Counter 차이 0개였다(`target/stage2-focused/clippy-diff.json`). 새 Clippy 진단은 관측되지 않았지만 전체 lint PASS로 바꾸지 않는다. 린트 규칙/암호 코드는 수정하지 않았다.

HWP 중첩 장평·자간의 추가 가용성 검토에서 원본 증명 범위를 넘는 활성화를 발견해 일반 서식과 같은 제한을 유지했다. `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage2-tables.wasm.test.ts -t 'HWP nested metrics'`로 실제 HWP 중첩 fixture의 명령 거부·본문/리비전 불변을 확인했다(1 PASS/7 필터 제외). 이후 `npm run build`와 `npm run lint`도 PASS. 이 최종 TS 경계 변경은 HWPX/엔진 경로를 바꾸지 않아 앞서 통과한 7개를 반복하지 않았다. 따라서 고유 신규 집중 회귀는 8개 통과(7개 실행 + 추가 경계 1개 선택 실행)다. native GUI/새 durable publication은 실행하지 않았으며, 실제 세션 명령/엔진 파일 재열기/T009 판정과 구분한다. 모든 검증 프로세스는 종료됐다.

최초 staging whitespace 검사에서 새 patch의 빈 context 공백을 발견해 제거했다. 별도 baseline copy에 정리한 패치를 정상 `git apply`로 재적용하여 기존 검증 소스 1,650파일의 해시가 모두 같은지 확인한 뒤 provenance를 다시 봉인했다. 실제 기능 검사는 직전 세대 `f1279e1a…`에서 실행했으며, 재게시한 위 최종 세대의 JS/WASM 바이트는 그 세대와 동일하다(WASM SHA-256 위 값 유지). Cargo Release 재실행은 캐시 재사용 0.29초였고, 기능 검사를 반복하지 않았다. 세대 신원을 새로 포장하는 최종 `npm run build`도 PASS였다.

시행 이력: 최초 신규 WASM 집중 회귀는 4 PASS/1 FAIL(Home/End), 렌더 부분 경로 수정 후에는 6 PASS/1 FAIL(빈 깊은 셀 생성 시 실제 caret 기하 거부)이었다. 두 실패를 테스트 문제로 바꾸지 않았다. 원인은 각각 transparent wrapper의 부분 표/전체 표 렌더 provenance 누락으로 추적했고 엔진 패치에 반영했다.

초기 CLI 버전 선택 오류(0.2.129 대신 lockfile의 기존 0.2.127 CLI 필요)는 올바른 로컬 도구 경로를 사용해 해결했다. Release 컴파일 후 게시가 두 번 거부됐다: 추가된 19번째 패치가 기존 신원 상한 18을 넘었고, 보관된 세대가 한도 6개에 도달했다. 신원 검증기 두 개와 기존 경계 검사를 허용 19/거부 20으로 갱신했다. 세대 보관 한도는 유지했다. geul/Vite 소비자가 없는 상태에서 선택되지 않은 이전 세대만 해시 확인 후 `target/rhwp-retired-generations/stage2/`로 이동해 보존했다. 생성 WASM/JS, fixture 및 검증 산출물은 커밋하지 않는다. 최초 커밋 시 민감정보 훅이 문서의 로컬 사용자 절대 경로를 거부해 도구 버전과 저장소 상대 명령 표기로 정리했다. 검사 규칙/훅 예외는 추가하지 않았다.

### 남은 Stage 2 구현과 이후 단계

다음은 **구현 잔여**이며 Stage 3–5 시험 의무로 대체하지 않는다.

- HWP 중첩 생성/구조 변경/고급 서식을 허용하는 T009 원본 변환 증명 및 recursive HWP reopen 모델. 엔진의 HWP 내보내기/재열기와 제품의 안전 저장 지원은 별개다. 제품의 해당 HWP 가드는 유지한다.
- 수식/일반 필드/그림·개체/캡션/자식 컨트롤이 있는 표의 구조 편집, 수식 참조·의존성 재작성과 소유 relocation proof. 기존 거부는 해제하지 않았다.
- 중첩 셀의 수식 삽입·교체·재계산 API/의존성/영속화와 제품 연결.
- 더 깊은 구조에서의 height-measurement 한도 처리, 큰 표의 국소 조판/이력 메모리 개선에 대한 추가 구현. 기존 viewport 렌더·snapshot 예산을 제거하거나 메모리 상한을 올리지 않았다. T010 D4 지연 목표는 이번 게이트가 아니다.

기존 T010 제품 GO/자원 증거와 T012 Phase 2 native X11/IBus 50/50 등 날짜별 증거는 역사·변경하지 않은 범위에 한해 유지한다. 새 경로를 과거 PASS로 검증했다고 주장하지 않는다. 전체 T010/T012/DOCX·IBus·D4 행렬을 다시 실행하지 않는다. Stage 3의 기능 범위/보존 수용, Stage 4의 T012 통합, Stage 5의 T015/T016 외부 한컴·Word/다른 OS·출시 수용은 남는다. push하지 않는다.

<a id="stage2-final-20261113"></a>
## Stage 2 최종 구현 후속 — 2026-11-13 (2차)

**PARTIALLY COMPLETED.** 시작 HEAD `cf2f99b3759c25eaffb82d217beb3ccb08fc0058`(clean, 서브모듈 핀 불변). 아래는 Stage 2 구현 범위이며 Stage 3–5 수용(기능 범위·보존 수용, T012 통합, T015/T016 호환·출시)이 아니다.

### 구현

- **A1 이동 결과**: `moveTo()`가 적용/거부를 돌려주고 `pointAt`·`moveHorizontal`·`moveVertical`·`moveLineEdge`·`moveCell`이 그대로 전달한다. 다른 문맥으로의 Shift 확장은 상태를 바꾸지 않고 `false`를 보고한다(이전에는 `pointAt`이 거부 후에도 `true`). 같은 셀/같은 표 선택 의미는 그대로다.
- **A2 빈 중첩 셀 선택**: 글이 없는 2×2 중첩 표에서 Shift+클릭 범위가 4칸으로 식별·강조되고 범위 병합된다. 표/셀 provenance(기존 렌더 경로 수정)로 충분해 코드 변경은 없다.
- **B HWP 중첩 보존**: `insertions.rs`에 같은 원본 표 control(인스턴스 ID·record level 동일)의 하위 구조 진화 증명(`evolved_table`)을 추가했다. 셀 글(독립 live/reopen 비교 몫), 새 기본 중첩 표(`validate_table_at`: 본문 42바이트 정규형, 중첩 TAC 형식 `0x002a0301`/TABLE `0x04000002`, 저장 전 재구성된 새 표는 46바이트 형식과 정확한 격자·기본 셀 템플릿), 원본 중첩 표의 동일/재귀 진화, 표 자체의 재구성(기존 템플릿 규칙), 셀 수가 줄어든 삭제에서만 원본 자식의 제거를 받는다. **구조 변화가 전혀 없는 원본 표의 글 변경은 기존 계약대로 거부**하며(기존 계약 시험이 확인), 필드·캡션·알 수 없는 레코드도 거부한다. TS `hwpReopenModel`은 중첩 표를 명시적 셀 목록 소유 경로로 완전 모델링(크기·셀 좌표/속성·표 속성·control wrap 일치)하고 중첩 셀의 필드 증거를 경로로 확장했다. 엔진의 경로 생성 표가 live `attr`·바깥 여백·세로 기준을 직렬화 값과 다르게 두던 불일치를 경로 생성에 한해 고쳤다(본문 API 불변). 제품은 HWP에서 중첩 생성(`insertedNestedTable` 검증)·중첩 구조 변경·중첩 장평/자간을 원본 구조 증명(완전 baseline·SAFE preflight) 아래 활성화한다.
- **C 풍부한 내용 표 구조 편집**: `tableStructure.ts`가 셀 문단마다 digest(글, 소유 컨트롤의 종류·위치·속성, 필드 식별, 자식 표의 격자와 문단 digest를 재귀로)를 읽어 계획/결과를 비교한다. 요청한 행·열 삭제가 지운 셀 내용만 사라질 수 있다. 계산식 필드는 같은 필드 ID로 계획 좌표에 남아야 하고, 절대 참조를 새 좌표로 다시 써(`remapFormulaReferences`) 의존 순서대로 기존 엔진 필드 교체로 재계산한다. 지워질 셀을 참조하거나 병합으로 흡수되는 계산식은 엔진 호출 전에 거부한다. 캡션은 새 읽기 전용 `getTableCaptionByPath`로 전후 동일함을 증명한다. HWPX에서 자식 표·필드(계산식/ClickHere)·캡션을 지원한다. HWP는 T009 HWP 증명에 필드·캡션 이동 모델이 없어 해당 표를 계속 거부한다. 셀 안 inline 그림·기타 개체는 일반 digest 경로로 다루지만, 고정 엔진에 셀 inline 그림 생성 API가 없어(셀 그림은 한컴 방식의 표 문단 floating sibling) 직접 시험하지 못했다.
- **D 중첩 계산식**: 엔진에 `evaluateTableFormulaByPath`, `validate/insertTableFormulaFieldByPath`(본문과 같은 구현·필드 모델, `evaluate_formula_in_table` 공유)를 추가했다. `RhwpText`·`formulaDependencies`(경로 소유 host list·필드 위치 접두 일치, 자식 표 안 필드는 그 표의 격자로 분리)·세션 가용성을 경로화했다. HWPX 삽입·교체·재계산·구조 변경 후 참조 재작성·저장/재열기를 확인했다. **HWP 중첩 계산식 삽입은 T009 HWP 증명에 중첩 필드 모델이 없어 저장이 거부되므로(시험으로 확인) 제품에서 막았다**(읽기 전용 계산은 가능).
- **E 깊은 중첩**: 한 셀이 같은 자식 표를 최대 세 번(높이 합·미흡수 높이·하단) 재귀 측정해 깊이에 지수적이던 작업을 측정 세션 범위 캐시(4096 항목 한도, 기존 `SingleLineOverflowCache`와 같은 수명 규칙)로 없앴다. 엔진 높이 측정 재귀 한도 10은 올리지 않았다. 대신 제품의 새 표 생성은 측정 가능한 깊이 10까지만 허용한다(더 깊은 기존 경로는 편집 가능). 같은 2×2 중첩 문서에서 가장 깊은 셀 입력 시간(20회 평균): 이전 엔진 깊이 6/8/9 = 2.65/4.7/8.0 ms, 새 엔진 0.9/1.0/0.85 ms(로컬 일회 측정, 성능 수용 게이트 아님).

### 엔진·산출물

`stage2-table-paths.patch`를 갱신했다(서브모듈 핀 유지, series 수 19 불변). 새 준비 소스는 작업 사본과 파일 단위로 동일함을 확인했다. Release 세대 `3f3a649b691d5df615418025692f6faee3af98f5f1de4942720ef160f31fc054`, WASM SHA-256 `98f78277002ce3babf0a9b818cd96df481a4eff0332f541c3940cb995d9d5f92`(Rust 1.99.1, wasm-bindgen 0.2.127). 보관 한도 6은 유지하고, 소비자가 없는 상태에서 선택되지 않은 세대(이전 세대 2개와 이번 중간 세대 2개)를 `target/rhwp-retired-generations/stage2b/`로 옮겼다. 생성물·fixture는 커밋하지 않는다.

### 검증(이번 실행)

- `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage2-tables.wasm.test.ts`: 최종 세대에서 10 PASS. 새/변경 시나리오: A1/A2 빈 중첩 셀; HWP 원본 중첩 표 진화+새 중첩 표 재구성+중첩 장평 → 제품 저장의 live/reopen 비교 전부 일치, 실제 T009 검사기 결과 `previewStale`만(서비스가 재생성), 재열기 확인; HWPX 풍부한 표(자식 표·계산식·캡션·floating 그림) 행 넣기/지우기·참조 재작성·거부·Undo/Redo·중첩 계산식·중첩 열 넣기 → T009 SAFE 저장·재열기 수식 일치; 깊이 10 생성·11 거부. 기존 시나리오 7개도 함께 PASS.
- `cargo test --lib services::save`: 216 PASS/25 ignored(계약 시험 2개가 처음 실패해 증명을 기존 계약에 맞게 좁힌 뒤 통과 — 텍스트만 바뀐 원본 표 거부, 잘못된 격자 코드). `cargo fmt --check`, `cargo clippy --lib --all-targets -- -D warnings` PASS.
- `npm run build`, `npm run lint` PASS. 관련 단위 시험 6파일 140 PASS. `rhwpAssets` patched source identity 1 PASS.
- 엔진 범위 Clippy(`-p rhwp --lib --no-deps`, wasm32): 41개, 코드 구성이 기존 기준과 같다. 변경 파일의 유일한 진단은 손대지 않은 `height_measurer.rs:1233` 기존 코드. **엄격 Clippy는 여전히 FAIL**이다.
- 반복하지 않음: 전체 T009/T010/T012 행렬, native IBus, DOCX/WordCraft, D4, Windows/macOS, 외부 Hancom, 전체 WASM 시험.

### 남은 Stage 2 구현

- HWP 표의 필드(계산식/ClickHere)·캡션이 있을 때의 구조 편집, HWP 중첩 계산식 삽입: T009 HWP 본문 증명에 필드 control(`%fmu` 등)과 캡션 이동 모델이 필요하다. 지금은 거부한다.
- 셀 inline 그림/개체: 일반 digest로 처리하지만 엔진 생성 API가 없어 실제 실행 증거가 없다.
- 깊이 10을 넘는 기존 문서의 높이 측정(엔진 한도 10)은 그대로다.

<a id="stage2-corrections-20261114"></a>
## Stage 2 안전 보정 (Commit A) — 2026-11-14

- **A1 HWP 자식 컨트롤 보존**: `evolved_table`의 "셀 수가 줄면 평탄 목록에서 누락 허용"을 없앴다. 원본/결과 셀의 명시적 대응(동일, 행·열 삽입·삭제, 직사각형 병합, 분할)을 기하로 후보화하고, 각 결과 셀이 원본 셀의 자식을 순서대로 소유하는지(같은 표의 재귀 진화 포함) 확인한다. 자식은 연산이 지운 셀과 함께만 사라질 수 있고, 병합된 셀의 자식은 앵커로 따라가야 한다. 다른 셀에서 "새 것"으로 설명되는 원본 자식은 거부한다. 자식을 지우는 대응은 유지된 셀의 문단 글이 원본과 바이트 동일한 유일한 대응일 때만 받는다(기하만으로는 "소유 행 삭제"와 "다른 행 삭제+자식 유실"을 구별할 수 없음). 단일 연산으로 설명되지 않는 복합 변경은 자식 유실 0·순서 보존만 받는다.
- **A3 인스턴스 ID**: 원본 모든 구역의 표/그림 ID를 깊이와 무관하게 유일해야 하는 집합으로 먼저 등록하고, 새 표는 그 집합과 겹치면 거부하며, 출력의 모든 표/그림 ID가 깊이와 무관하게 한 번만 나와야 한다. 이전의 중복 무시 조건은 제거했다.
- **A2 계산식 사후 조건**: 참조 재작성 뒤 필드 목록을 다시 읽어 계획한 필드 ID 집합·소유 표/셀·최종 좌표·재작성된 식을 비교하고, 엔진의 읽기 전용 평가(`validateTableFormulaField(ByPath)`)가 `changed:false`로 같은 값을 내는지 확인한다. 어긋나면 세션 snapshot으로 되돌린다.
- **A4 캡션**: `getTableCaptionByPath`가 문단 글, 문단/글자 모양 참조, 소유 컨트롤 수, 캡션 방향·정렬·폭·간격·최대 폭·여백 포함을 보고하고 구조 편집 전후 전체가 같아야 한다. HWP 독립 검사기는 캡션이 있는 표를 계속 바이트 동일 계약(구조 변경 거부)으로 둔다.
- 검증: `cargo test --lib services::save` 217 PASS/25 ignored(새 ID 단위 시험 포함), fmt/clippy `-D warnings` PASS; Release 세대 `df6d968d3613841b70a4bdb56e874d13fae729b9de2ce17a88a494298c0858e0`(WASM `049b0acd…`)에서 `stage2-tables.wasm.test.ts` 12 PASS — 새 시나리오: 실제 검사기로 자식 유지/소유 행 삭제 수용, 같은 셀 수 감소의 자식 유실·병합 중 유실 거부; 엔진이 성공을 보고했지만 식이 적용되지 않은 재작성 탐지·롤백. `npm run build`/`lint`, 단위 23 PASS, 패치 신원 1 PASS.

<a id="stage2-final-features-20261114"></a>
## Stage 2 최종 기능 (Commit B) — 2026-11-14

- **원인**: 앞선 HWP 중첩 계산식 저장 거부(`outputMalformed`)는 출력 결함이 아니었다. 구조 증명(`prove`)의 문단 파서가 필드 시작 컨트롤(문자 3, `%fmu` CTRL_HEADER)을 모델링하지 않았다. 같은 필드를 구조 변경 없이 넣은 출력은 기존 경로에서 SAFE였다. RHWP 직렬화와 패치는 바꾸지 않았다(Release 세대 `df6d968d…` 유지).
- **T009 HWP 확장(`src-tauri/src/services/save/hwp/insertions.rs`)**: 문단 파서가 필드 시작을 확장 컨트롤 객체로 읽는다(필드 끝 문자 4는 기존 인라인 토큰). 셀 자식 대응에서 (1) 바이트 동일 필드, (2) 같은 계산식 필드(ctrl·속성·추가 속성·ID·꼬리 바이트 동일)의 정규형 명령 `={식}??%g,;;{수}`로의 재작성, (3) 엔진 형식의 새 계산식 필드(속성 0, 추가 0x08, 원본·출력과 겹치지 않는 ID)만 받는다. 누름틀은 바이트 동일만 허용한다. 출력의 모든 계산식/누름틀 필드 ID는 깊이와 무관하게 한 번만 나와야 한다. 캡션은 원본과 출력이 바이트 동일해야 하며(LIST_HEADER·문단·캡션 안 컨트롤) 셀 소유와 구별한다. 필드 글/값 일치는 독립 reopen 모델(누름틀은 모든 문단에서 증거로 인정)이 판정한다.
- **제품**: HWP 표 구조 명령도 필드·캡션 이동 규칙(`tableContent` fields=true)을 쓴다. HWP 중첩 셀 계산식 삽입·교체는 완전한 baseline·SAFE 원본 preflight 아래 활성화된다(시험 flag 없음).
- **검증**: `stage2-tables.wasm.test.ts` 14 PASS. 새 시나리오: HWP 계산식+누름틀+캡션 표의 행 넣기·범위 병합·나누기·열 넣기 → 식 `=SUM(B2:B3)` 재작성, 누름틀 ID·명령 유지, 캡션 정체성 유지, 끊어질 참조의 행 삭제 거부, 제품 저장 reopen 일치·검사기 `previewStale`만, 재열기 필드 목록 일치; HWP 새 중첩 표 계산식 삽입·교체(`=2*3`)·중첩 행 넣기 뒤 같은 필드 ID 유지, 저장·재열기; 실제 검사기 거부: 살아남은 셀의 누름틀 유실(unsafe). `cargo test --lib services::save` 217 PASS, fmt/clippy `-D warnings` PASS(새 `chunks_exact` 진단 1건은 수정), `npm run build`/`lint`, 단위 130 PASS.
- 실제 저장 서비스의 durable publication은 이번에 실행하지 않았다(제품 세션 + T009 검사기 증거).
- **잔여(Stage 2 범위 밖으로 명시된 것)**: 깊이 10 초과 기존 문서의 높이 측정 한도, 셀 inline 개체 생성 API 부재. 누름틀 명령 변경·새 누름틀 생성은 구조 편집 연산이 아니므로 HWP 증명에서 계속 거부한다.


<a id="stage2-final-safety-20261114"></a>
## Stage 2 최종 보존·소유권 보정 — 2026-11-14

구현 및 아래 집중 검증 PASS. 앞선 날짜별 PASS/FAIL/UNVERIFIED 기록은 이력으로 보존한다. Stage 3 지원 범위·보존 수용, Stage 4 T012 통합 수용, Stage 5 T015/T016 상호 운용·릴리스 수용은 이번 작업에서 수행하거나 완료로 변경하지 않았다.

- **A — 필드-only 경로**: `assess`의 표/그림/목록·DocInfo 변화만으로는 필드 CTRL_HEADER 변경을 선택하지 못했다. `compare_with`가 구조 증명과 별개로 `field_preservation`을 호출한다. 기존 `unique_field_ids`를 재사용하고 원본/결과의 ID·명령·속성·꼬리·표/셀/문단/컨트롤 순번을 연결한다. 구조 증명이 없는 필드 소실·ID 교환·누름틀 메타데이터 변경을 거부하며, 구조 증명이 있는 삭제는 해당 소유 셀의 삭제 대응이 필요하다. 지속적인 body-table ID를 유지한 일반 본문 문단 분할은 허용한다. 일반 글자 교체/삽입/삭제의 기존 경로는 유지한다.
- **B — 복합 셀 대응**: 평탄 자식 목록 fallback을 제거했다. 단일 연산 대응에 더해 제한된 행·열 삽입 후보와 고유 문단 증거의 단조 축 대응을 사용한다. 직사각형 병합/분할, 여러 축 삽입, 증거로 완전히 사라지는 축 구간의 삭제, 삽입 셀을 포함한 병합을 셀별로 증명한다. 삽입 셀의 빈 문단이 원본 자식 문단 앞에 오는 offset도 계산한다. 기존 자식은 원래 셀의 대응 결과와 올바른 문단/순서에 남아야 한다. 새 자식 앵커만 ancestry 증거에서 제외하며 `new_child`의 스키마·전역 새 ID 증명은 그대로 요구한다. 새 셀의 새 중첩 표도 이 경로로 지원한다. 기존 중첩 표 변화는 재귀 증명하고 unknown direct control의 구조 이동은 거부한다. 후보/격자 작업량은 유한 예산으로 묶고 비교 메모리도 기존 admission에 청구한다. 프런트엔드 연산 이력은 사용하지 않는다.
- **C — 수식 경계**: `patches/rhwp/table-calc/`의 parser/tokenizer/evaluator를 네이티브 검사기와 WASM 준비 소스가 공유한다(별도 평가기 없음). 새/재작성 명령은 지원 문법·함수/인수·참조/범위·방향/wildcard·유한 평가 결과를 검사하고 `%g` 캐시 및 실제 필드 범위 글과 일치해야 한다. 실제 출력 표의 정상 격자와 첫 문단 숫자 조회 규칙을 사용한다. 새/재작성 식에서 도달하는 AST 의존 그래프는 evaluator의 참조 해석을 재사용해 검사한다. 자기 참조, 상호 순환, 선택되지 않은 IF 분기의 순환도 거부한다. 미변경 한컴 필드 명령/서식은 기존 불투명 보존 계약을 유지한다.
- **D — 한 문단의 여러 필드**: RHWP `getFieldList`가 실제 field range의 `controlIndex`와 `controlPos`를 보고하고 `getControls`의 필드 위치도 같은 실제 BEGIN 경계로 구한다. `fieldOwnership.ts`가 ID·컨트롤 순번/위치·문자 범위·BEGIN/END 순서를 연결하며 `tableStructure`와 `hwpReopenModel`이 함께 사용한다. 서로 겹치지 않는 두 ClickHere 필드의 이름/명령/안내/편집 속성·값·범위·순서와 표/셀 소유권을 일반 제품 구조 편집/저장 경로에서 유지한다. capability/시험 활성화 flag를 바꾸지 않았다.

**집중 증거와 실행 명령**

- 기준 HEAD `203f833`의 실제 검사기에서 새 native 거부 회귀 2개가 의도한 이유로 FAIL했다: `BOGUS(1)` 필드-only 식과, 복합 편집 중 다른 생존 셀로 옮긴 자식이 허용됐다. 실제 잘못된 durable publication을 재현한 기록은 아니다. 수정 중 새 자식 앵커의 과도한 거부 및 자기 참조 캐시의 과허용도 실제 회귀로 확인하고 수정했다.
- `python3 scripts/cargo-geul.py test --lib hwp_safety_field_only_real_checker -- --nocapture`: PASS. 삽입/동일 ID 교체, 참조/방향, 정상 수식 연결, 일반 텍스트 편집과 필드 표 앞 문단 분할을 허용한다. 잘못된/중복 ID, 소실/교환/순서 교환, 잘린 CTRL_HEADER, 미지원 함수·잘못된 식/참조, 잘못된 캐시/범위 글, 자기/상호/IF 분기 순환은 거부한다. 실제 저장 서비스의 중복 필드 거부에서 디스크 원본 불변을 확인했다.
- `python3 scripts/cargo-geul.py test --lib hwp_safety_composite_cell_ownership_real_checker -- --nocapture`: PASS. 두 필드가 든 셀의 행+열 삽입(16×16 후보 예산 경계 포함), 여러 축 삽입, 병합 후 분할, 새 빈 셀로 흡수하는 병합의 문단 offset, 소유 행 삭제+열 삽입을 허용한다. 다른 생존 셀 이동, 한 필드 유실/순서 교환, 중복, 설명되지 않는 소실, unknown control 이동은 거부한다. `python3 scripts/cargo-geul.py test --lib hwp_boundary_ordinary_insert_delete_and_split_remain_eligible`: 기존 1 PASS 재사용.
- `python3 scripts/cargo-geul.py build --example save_check`, `python3 scripts/cargo-geul.py fmt --check`, `python3 scripts/cargo-geul.py clippy --lib -- -D warnings`: PASS. 초기 공유 formatter의 `manual_range_contains`와 새 helper 반환형의 `type_complexity`는 수정 후 통과했으며 경고 억제는 추가하지 않았다.
- `npm run typecheck`: PASS. `npx eslint`로 변경한 `fieldOwnership.ts`, `tableStructure.ts`, `hwpReopenModel.ts`, 해당 모델 단위 시험과 `scripts/tests/stage2-tables.wasm.test.ts`를 검사: PASS. `npx vitest run src/components/Editor/rhwp/hwpReopenModel.test.ts src/components/Editor/rhwp/formulaDependencies.test.ts`: 74 PASS.
- `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage2-tables.wasm.test.ts -t 'HWP: original nested|HWPX rich table|T009 HWP: child tables|HWP field-rich|field-only replacement|multiple fields|T009 HWP: a field lost|formula rewrite success|partial nested engine failure'`: 고유 9개 시나리오를 변경별 선택 실행으로 검증했다. 마지막 수식 보정 뒤에는 `-t 'HWP: original nested|HWP field-rich|field-only replacement'` 3 PASS/13 필터 제외로 영향 경로만 재실행했다. 실제 Release WASM·제품 세션 export/reopen·real `save_check`를 사용했다. 새 셀의 새 자식 표를 포함한 복합 저장, 필드-only 수식 ID/캐시 유지, 두 필드의 위치/범위/순서 저장·재열기, Undo/Redo, 엔진이 한 필드만 유실한 부분 변경의 snapshot 복원을 확인했다. 정상 저장의 새 native GUI/durable publication 캠페인은 수행하지 않았다.
- `python3 scripts/build-rhwp-wasm.py`(기존 wasm-bindgen 0.2.127 경로 사용): Release PASS. 최종 세대 `11365b8a0eebb42c66f7c8739a375e14ae176b217b177063191666fd6e9e69d3`, WASM SHA-256 `0d1d8fbb7cf9d7962fb1efbaf88f515bf5e2bcbda34b2d6f49aeffd42e420621`. 유지 패치 19개와 공통 수식 소스의 신원/최종 소스 트리 해시를 기록하며, 패치 재적용 결과와 준비 소스의 일치를 확인했다. RHWP `1a76570e833917d15817415a53c09ad61ab3203f`, WordCraft `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5` 핀은 유지한다. 보관 한도는 늘리지 않고 해시 검증한 비선택 세대만 `target/rhwp-retired-generations/final-safety/`로 보존 이동했다. 생성 WASM/JS·fixture·검증 로그는 커밋하지 않는다.

**지원 경계**: 이번 다중 필드 확장은 명시적인 paragraph-control/range가 있는 비중첩 ClickHere 범위를 다룬다. 겹치거나 모호한 범위는 거부한다. 수식 `validate/insertTableFormulaField(ByPath)`는 기존의 첫 문단 전체를 덮는 단일 수식 계약을 유지하므로 같은 문단의 여러 수식/부분 수식 재작성은 미지원이다. 독립 문단 증거를 잃거나 어떤 축 구간이 삭제됐는지 모호한 복합 변환은 저장을 거부한다. 이는 현재 증명의 지원 범위이며 Stage 3–5의 향후 시험으로 해결됐다고 간주하지 않는다. 전체 T009/T010/T012, native IBus, DOCX/WordCraft, D4, 외부 한컴/Word 및 Windows/macOS 검증은 반복하지 않았다.

<a id="stage2-deep-nesting-20261114"></a>
## Stage 2 깊은 중첩 표 조판·편집 — 2026-11-14

Stage 2 잔여 구현 항목 하나(깊이 10 초과 기존 문서)를 구현하고 집중 검증했다. 별도 잔여(셀 inline 개체 생성 API, 한 문단의 여러/부분 수식)는 그대로이며, Stage 3–5 수용은 수행하거나 완료로 바꾸지 않았다. 앞선 기록은 이력으로 보존한다.

**원인(관측)**

- `height_measurer.rs`의 `MAX_NESTED_DEPTH = 10`: 깊이 지수 10 이상(11번째 단계부터)의 표가 행 높이 0으로 측정됐다. 이전 Release `11365b8a…`에서 1500단어를 담은 깊이 12/16 문서는 1쪽으로 조판되고 각각 12/148단어만 보였다(나머지 무음 누락). 깊이 9/10은 정상.
- 위 한도를 없애자 숨어 있던 반복 측정이 드러났다: 조판의 각 중첩 단계(`layout_partial_table_resolved`/`cells`)와 조판기(typeset)가 표마다 만드는 임시 `LayoutEngine`이 같은 하위 트리의 높이(`calc_nested_table_height` → `resolve_row_heights` → 셀 compose → `calc_nested_controls_bottom_height`/`nested_table_mixed_fragment_heights`)를 매번 새로 쟀다. 깊이 16·1000단어에서 편집 1회 약 5.4초, 렌더 트리 15.7초로 깊이에 지수적으로 늘었다(깊이 10/12/14/16 = 1.4/1.8/2.9/5.8초).
- 파서 한도 밖 문서는 조용히 손상됐다: HWPX(문단 16단계 = 표 15단계)를 넘으면 구역 전체가 빈 구역으로 바뀌어 열렸고, HWP5(문단 64단계 = 표 63단계)를 넘으면 해당 하위 트리를 잘라냈다.
- 스택: WASM 정지 스택(1 MiB, stack-first) 사용량을 stack painting으로 쟀다. 63단계 HWP 재열기+렌더가 최대 481 KiB, 측정기 재귀 추가분 포함 조판 56 KiB.

**구현(`patches/rhwp/stage2-table-paths.patch`에 합침 — 산출물 신원 검증기가 패치 시리즈를 19개로 제한하므로 시리즈·검증기는 바꾸지 않았다)**

- 측정기 한도를 파서 구조 한도(`MAX_HWP5_SECTION_DEPTH`, 64)와 같게 했다. 모델에 그보다 깊은 표는 생기지 않으며 실제 내용으로 측정한다. 기존 측정 세션 캐시(4096 항목)는 그대로 쓴다.
- `NestedHeightMemo`(`table_layout.rs`): `calc_nested_table_height`와 `nested_table_mixed_fragment_heights` 결과를 (표 포인터, 스타일 포인터, 선언 신뢰 플래그, 본문 영역) 키와 호환 프로필 일치 조건으로 재사용한다. 범위는 가장 바깥 `layout_table`/`layout_partial_table`/측정 호출 동안(Drop 가드로 패닉 시에도 닫음)과, 표 하나를 배치하려고 만든 조판기 임시 엔진의 수명(`prepare.rs`, `whole_fit.rs`)뿐이다. 두 구간 모두 문서가 `&`로 빌려진 동안이라 포인터 재사용 오류가 없고, 항목 4096개 상한을 넘으면 다시 잰다. 결과: 깊이 16·1000단어 편집 0.06–0.11초, 렌더 트리 0.31–0.38초, 깊이 2는 0.15→0.09초.
- `BodyTextError::NestingLimit`, `HwpxError::NestingLimit`: 깊이 가드가 거부하면 스레드 로컬 표지를 세우고 구역 끝에서 문서 열기를 명시적으로 거부한다(빈 구역/절단 대신). HWP5 상한 초과를 절단으로 고정하던 엔진 단위 시험은 거부 + 상한 안쪽 63단계 보존으로 갱신했다.
- geul: `MAX_CREATED_TABLE_DEPTH` 10 → 15. 새 표는 두 형식 모두 다시 열리는 HWPX 읽기 한도 안에서만 만든다. 기존 HWP 문서는 엔진 한도(표 63단계, 경로 64)까지 열고 편집한다. 편집·IME·Undo/Redo·저장은 기존 경로 기반 연산 그대로이며 깊은 표 전용 구현은 없다.

**지원 경계**

- HWP: 표 63단계까지 열기·조판·편집·저장(직접 확인 16단계; 32·63단계는 엔진 탐침으로 열기/조판/HWP 재열기 확인). HWPX: 표 15단계까지(직접 확인 12단계, 생성 15단계), 16단계 이상은 명시적 거부. 경로 한도 64는 올리지 않았다.
- 기하: 기본 1×1 셀 여백이면 단계마다 폭이 약 10.6px 줄어 A4에서 약 30단계부터 셀 폭이 0이 된다. 문서가 정하는 기하이며 엔진 한도가 아니다.
- 기존 일반 결함(깊이 무관, 이번에 고치지 않음): 한 행이 쪽보다 약간 큰 표가 나뉘지 않고 쪽 아래로 잘리거나 다음 쪽에서 내용이 보이지 않는 경우가 있다(깊이 1·600단어, 깊이 4/8·500단어). 이전 Release에서도 같은 결과이며, 쪽을 충분히 넘는 행(1000/1500단어)은 깊이 4–16에서 모든 단어가 정확히 한 번씩 순서대로 나뉜다.

**집중 검증(실제 실행)**

- `scripts/build-rhwp-wasm.sh`(PATH에 기존 wasm-bindgen 0.2.127): Release PASS, 최종 세대 `03a37914dd4335d70f8fd4efe70a120eb433c09cef38182f8469a2222f263e49`, WASM `40848b54e79c8f53db782abc05018cd3cc07425d89e28f87ed1c86ef1ad34193`, `stage2-table-paths.patch` `90714a14…`. 세대 보관 한도 때문에 참조되지 않는 가장 오래된 세대 `c51dd0fe…`, `f1279e1a…`를 `target/rhwp-retired-generations/`로 옮겼다. 패치 재적용 결과가 작업 트리와 같음을 확인했다.
- 렌더 동일성: 메모 이전 세대 `23fa145d…`(측정 한도만 수정)와 최종 WASM(바이트 동일한 실험 빌드)의 `getPageRenderTree` JSON을 `external/rhwp/samples`의 HWP/HWPX 187개(6개마다 1개, 1.5 MB 이하, 문서당 최대 40쪽)에서 비교: 187 동일 / 0 차이 / 0 열기 오류. 합성 중첩 문서(깊이 2/5/9/12 × 50/1500단어 × 라벨 유무 × 메모리/HWP 재열기 × 1/3행, 64개, 모든 쪽): 64 동일 / 0 차이. 첫 전체 합성 행렬(216개)은 50분 제한에 걸려 요약 없이 중단됐고(그 전까지 차이 출력 없음) 위 축소 행렬로 대신했다.
- `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage2-tables.wasm.test.ts`: 18 PASS. 새 시나리오: (1) 기존 16단계 HWP(1000단어): 16단계 모두, 여러 쪽, 모든 단어 정확히 한 번·순서대로, 부모/자식 경계 포함; 포인터 캐럿이 같은 16단계 경로로 해석; 입력·삭제·Undo/Redo·IME·선택·굵게; 제품 저장의 live/reopen 비교와 실제 T009 검사기(`previewStale`만) 게시 가능; 독립 재열기에서 계층·대상 셀 글·1×1 구조·굵게 일치. (2) 기존 12단계 HWPX 조판·입력·T009 SAFE 저장·재열기, 16단계 HWPX는 `nesting` 오류로 거부. 기존 "깊이 10 생성·11 거부"는 "깊이 15 생성·16 거부"로 갱신, 나머지 기존 시나리오(얕은 표 회귀) PASS.
- `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/rhwpAssets.test.ts`: 12 PASS. `npx tsc --noEmit`, 변경 TS 파일 `npx eslint`: PASS.
- 엔진 Clippy(`-p rhwp --lib --no-deps`, wasm32): 41개로 기존 기준과 같고, 변경 파일의 진단은 모두 손대지 않은 기존 줄이다. 엄격 Clippy는 여전히 FAIL로 둔다.
- 엔진 단위 시험은 준비 소스에서 컴파일되지 않는다(샘플 누락·기존 구조체 필드 등 32개 오류, 변경 전후 동일). 갱신한 HWP5 깊이 시험은 실행하지 못했다(동작은 WASM 탐침과 위 HWPX 거부 시나리오로 확인).
- 반복하지 않은 것: T009/T010/T012 전체, native IBus, DOCX/WordCraft, D4 벤치마크, Windows/macOS, 한컴/Word 상호 운용, 전체 WASM 시험.


<a id="table-row-boundary-20261114"></a>
### 2026-11-14 표 행 페이지 경계 수정 — COMPLETED / Release 집중 검증 PASS

- 재현: 제품 생성 API로 만든 최소 1×1 HWPX 표(HWP는 같은 생성 모델의 편집/저장 대조), `TopAndBottom`, 기본 `pageBreak=None`, 한 셀에 `w0 … w599`(600단어). 기준 Release `03a37914…`에서 1쪽, 표 y=136.0/h=891.8/bottom=1027.8px, 본문 y=132.3/h=876.8/bottom=1009.1px. Native 진단은 effective/row=891.7600px, available/base=876.8267px, current=0, host spacing=3.7733px, 선언+host=20.8667px를 기록했다. 소스 600단어가 남아 있어도 마지막 글줄은 본문 밖이다. 깊이 4/500단어는 표 높이 943.3px, 하단 1079.3px. 깊이와 독립적인 결함이다.
- 첫 잘못된 전이: `prepare_block_table_entry`의 None 호환 분기가 실제 저장 프레임 입증 없이 `body < measured <= body + bottom paper slack`이면 `place_table_with_text` 뒤 완료를 반환했다. 따라서 조금 큰 행은 스캐너를 건너뛰고, 훨씬 큰 행은 상한을 넘어 정상 분할 경로로 갔다. 기본 생성 표는 명시적 RowBreak가 아니며, RowBreak=2의 깊이 1 대조군은 이미 정상 분할된다. None/CellBreak의 새 쪽에 들어가는 원자 단위 이월 정책은 유지한다. 저장 내용/행 프레임이 실제 표 선언에 포함되고 미편집인 원본의 None 호환 프레임만 보존한다.
- 직접 관련된 두 소비 경로도 수정한다. `nested_table_mixed_fragment_heights_uncached`의 scalar mixed fallback은 미소비 줄을 추가로 건너뛰어 깊이 4/1000단어에서 실제 표시가 976단어였다(원문·raw TextRun 집계로는 검출 불가). 저장 reset이 없고 내용이 선언 프레임을 초과한 단일 행·셀은 기존 canonical CellUnit → recursive RowCut으로 투영한다. `prepare_block_table_continuation`은 온전한 행의 실제 MeasuredTable 소유 높이를 예약하고, `scan_ordinary_row_step`은 그 높이로 강제 분할 여부를 판정하며 컷/출력의 실제 패딩 차이를 예산에서 예약한다. fragment budget의 2px whole-table drift 허용도 동일한 원본 프레임 근거를 요구한다. whole-fit과 확정 배치 프레임에는 기존 0.5px 기하 허용치를 적용해 같은 HWPUNIT 경계의 부동소수점 오차 때문에 불필요하게 쪽을 늘리지 않는다. 0.6px 초과 사례에서 내용 컷 889.9px와 출력 행 891.8px의 불일치를 검사한다.
- 호출 경로: MeasuredTable/셀 유닛 → entry 통째 수용/이월 → prepare whole-row 예산 → ordinary row scanner의 start/end cut → 기존 continuation cursor/fragment emit → partial table paint의 동일 child source cut. 새 paginator, 확대 canvas, overflow 숨김, 텍스트 삭제, 무한 재시도는 추가하지 않는다. 저장 reset/rowspan/원자 개체는 기존 각 경로에 남는다. NestedHeightMemo/HeightMeasurer 캐시·세션·깊이 한도·파서 refusal·소스 경로·IME·T009 보호는 변경하지 않는다.
- 유지 위치: 기존 19번째 `patches/rhwp/stage2-table-paths.patch`; upstream/WordCraft pin 변경 없음. `scripts/tests/stage2-tables.wasm.test.ts`의 생성 fixture를 재사용하여 원문, 순서·중복·누락, 본문 및 모든 셀/표 경계, 클립 안의 실제 표시 텍스트, 캐럿 소유, 제품 세션 revision/Undo/Redo, HWP/HWPX 저장과 실제 T009 검사기를 확인한다. 경계 sweep은 실제 출력 높이로 용지 본문을 산정한다. 클립 밖으로 완전히 이동한 이전 줄은 가시 내용으로 세지 않고, 부분 클리핑은 실패로 판정한다.
- 검증 범위: 187/64문서 비교, 전체 T009/T010/T012, IBus, WordCraft/DOCX, D4, Windows/macOS·외부 한컴/Word 상호운용 캠페인은 이 수정으로 재실행하지 않는다. 합성 문서의 구조/기하/저장 증거이며 한컴 독립 PDF 일치나 native GUI 표시의 새 인증은 아니다. 다른 Stage 2 잔여 및 Stage 3–5 수용과 별개다.


| 실제 본문/셀 클립 안의 완전한 표시 단어 | 수정 전 | 최종 Release |
| --- | --- | --- |
| 깊이 1, 600단어 | 1쪽: w0–w593(594개), w594–w599는 본문 밖 | 2쪽: w0–w579(580개) / w580–w599(20개) |
| 깊이 4, 500단어 | 1쪽: w0–w466(467개), 나머지는 본문 밖 | 2쪽: w0–w418(419개) / w419–w499(81개) |
| 깊이 4, 1000단어 | 3쪽: 419/456/101개, 총 976개(24개 미표시) | 3쪽 유지: 419/480/101개, 총 1000개 |

- 조각 기하: 깊이 1은 y=132.3px에서 h=847.5/36.8px, 깊이 4/500단어의 외곽 표는 y=132.3px에서 h=864.1/156.6px. 모든 가시 글줄은 본문 및 조상 셀/표 안에 있고, L1/L2/L3도 원래 순서로 한 번씩 표시된다. 시작/끝 컷의 내용 연속성은 위 마지막/첫 단어 및 원문 순서 비교로 검사했다. 큰 행은 3쪽을 유지하며 빈 쪽·중복·누락 없이 끝난다.
- 경계 sweep은 제품 paint layer의 0.001px 상자를 써서 완전 배치 점유 895.533px를 구하고 HWPUNIT(1/75px)으로 올림한다. 본문 약 896.133/895.533/894.933/875.533px에서 각각 1/1/2/2쪽, 모든 내용과 가시 기하 PASS. 처음 0.1px 요약 좌표로 만든 동일 높이는 실제보다 2 HWPUNIT 작았으므로, 입력 높이 계산을 고정밀 paint 상자로 바로잡았다. 비교를 완화하지 않았다. 별도 앞 문단(20줄) 뒤에서 새 쪽에는 들어가는 350단어 None 행은 원자 단위 이월한다. 같은 host 문단에 글을 넣는 탐침과 문단을 실제 앞에 넣는 API를 구별했다(`splitParagraph(…,0)`은 표를 앞에 남기므로 `insertParagraph(…,0)` 사용). 명시적 pageBreak=1/2의 쪽보다 큰 행도 기존 불가피 분할/행 분할 경로로 보존한다.
- 실제 명령/결과:
  - `PATH="$PWD/target/phase5-native-gui-ibus/20261111T172547+0900/environment/wasm-bindgen-cli/bin:$PATH" python3 scripts/build-rhwp-wasm.py`: Release 컴파일 PASS(6분28초). 첫 게시만 6세대 보관 한도로 거부됐고, 소비자 중단 확인 후 비선택 세대를 `target/stage2-focused/retained-generations/`에 이동 보존한 뒤 같은 명령의 캐시 재실행으로 PASS. 삭제·무결성 우회 없음.
  - `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/stage2-tables.wasm.test.ts -t 'row pagination boundary'`: **6 PASS / 18 필터 제외**. 위 세 문서, 4점 경계/중간 페이지 이월, HWP/HWPX 제품 편집(580→620단어), revision 증가·캐럿 쪽/셀 및 포인터 소유, Undo/Redo(1↔2쪽), 제품 저장/재열기·원문·1×1 구조를 확인했다. HWP는 실제 T009 검사기를 사용하며 서비스의 preview 재생성 대상인 `previewStale`만 허용한다. 재열기만으로 HWP 안전 게시를 판정하지 않는다.
  - `npm run build`: **PASS**(TypeScript + Vite, 기존 큰 chunk 경고). `npm run lint`: **PASS**.
  - `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/rhwpAssets.test.ts -t 'patched source identity'`: **1 PASS / 11 필터 제외**.
  - `python3 scripts/rhwp-artifacts.py --verify-product dist/rhwp --profile release`: **PASS**. 공개 Release 선택자/불변 세대/dist 제품 신원 및 JS/WASM 해시 일치, 패치 19개·현재 패치 해시 일치. `git diff --check` PASS. 최종 staged 검토에서 중첩 Table 상자 포함 및 None 행의 온전한 이월(0/350단어)을 명시적으로 강화한 뒤 같은 6개 시나리오와 `npx eslint scripts/tests/stage2-tables.wasm.test.ts`를 재실행해 PASS; 엔진 변경은 없어 Release 재빌드는 하지 않았다.
- 최종 Release 세대: `882071ff593572efae60aa6dfe03db374f4dcce8d48e11627a2f3514020f98fc`; WASM SHA-256 `ecc48674b9360f98b764f82705e58bd061c9a4d1c5adbb20725259a7a9d074e6`; Stage 2 패치 SHA-256 `e08bc8ca8418d82c5cb125aa759b83ad60580c1fde281c4a656bc971d5f9f064`. 캐시 key/scope/한도는 그대로이며 canonical 조각 선택만 정확해졌다. frontend pagination 코드는 수정하지 않았다.
- 증적(모두 ignored, 커밋 제외): `target/stage2-focused/row-final-release-build{,-retry}.log`, `row-final-tests.log`, `row-{before,after}-evidence.jsonl`, `before-1-600-0.png`, `after-{1-600,4-500}-{0,1}.{svg,png}`. 최종 WASM의 `renderPageSvg` → `rsvg-convert -w 600` 출력 4쪽과 기준 깊이1/600단어 1쪽 PNG를 직접 확인했다. 이는 SVG 출력 확인이며 브라우저/native GUI 상호작용 또는 독립 한컴 PDF 비교 PASS가 아니다. 기존 Rust strict Clippy/엔진 단위 시험의 과거 미해결 기록은 위에 보존했으며 이번에 재실행하지 않았다.
- **COMPLETED**: 로컬 구현 commit `c2144ef09fb8142bff2f151aced25ddea16d5755` (`fix(rhwp): prevent table row clipping at page boundaries`). 시작 HEAD `b7aa7b53711bb847d3e10a699c0cc62efdce26d8`, branch `master`. RHWP `1a76570e833917d15817415a53c09ad61ab3203f`, WordCraft `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5` pin 유지. 생성 WASM/fixture/log/build/checkpoint는 커밋하지 않았다. 정상 pre-commit 민감정보/secret 검사 PASS, 회귀 훅은 대상 없음으로 skip. push 없음. 다른 Stage 2 구현 잔여 및 Stage 3–5 수용은 별도다.
