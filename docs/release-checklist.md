# 출시 점검표 (T016, Stage 5-A 로컬 범위 — 2026-11-16)

> **2026-11-16 검토:** 출시 **NO-GO** 유지. 지원되는 HWP/HWPX font mutation, T009 proofs, Undo/Redo, Linux Release native save/reopen, independent Canvas/PDF checks와 RHWP natural font metrics(줄바꿈·caret·selection·table-cell native acceptance run12)는 PASS다. 복합 shaping은 지원 범위 밖(문서화), Windows/macOS·외부 오피스 재열기 미실행, Release private-path cleanup은 아래 후속 검증으로 COMPLETED이며, 배포판 이식성·고지 동봉 등 출시 선행 조건은 남아 있다. Stage 5-A overall은 PARTIALLY COMPLETED, Stage 5는 INCOMPLETE다.

**판정: 출시 NO-GO.** 이 표는 현재 Linux 개발 환경에서 실행한 범위와 남은 선행 조건을 구분한다. 출시 GO, T016 Done, 전체 Stage 5 완료가 아니다. 검증된 앱(SHA-256 `29bd1c6ca0627d812c12d167834acc2bf5c451ecc6cd322d1b8c914289b75e74`, RHWP generation `cfb26d65…`)은 시작 HEAD `a42d7c0c4cfda033fc0e05b68f5d10e9d24623c1`의 제품 소스와 per-language selection/caret 수정을 포함한 최종 implementation diff로 빌드한 당시 증거다. 현재 Release 실행파일의 경로 정리·최소 smoke 결과는 아래 후속 기록과 구분한다. 품질 근거는 [품질 행렬](quality-matrix.md).

| 영역 | 요구 | 상태 | 근거·구현 | 남은 차이 | 완료 선행 조건 |
|---|---|---|---|---|---|
| Linux 로컬 빌드 | Release 앱 빌드(검증된 RHWP Release 자산) | CURRENT PASS | `python3 scripts/tauri-geul.py build --no-bundle` exit 0(`target/stage5a/build-release.log`), `rhwp-artifacts.py --verify-product dist/rhwp --profile release` PASS, `dist/frontend-build.json` `mode: production`, `testFlags: {}` | — | — |
| Linux 패키지 생성 | 실제 패키지 | CURRENT PASS(생성) | 설정 파일 변경 없이 `tauri-geul.py build --bundles deb --config '{"bundle":{"active":true}}'` → `geul_0.1.0_amd64.deb` 21.7 MiB(`ar`: debian-binary/control/data; `/usr/bin/geul`, `.desktop`, hicolor 아이콘; Depends `libwebkit2gtk-4.1-0, libgtk-3-0`). 저장소 설정은 `bundle.active: false` 그대로 | 아래 이식성·메타데이터 | — |
| Linux 패키지 수용 | 대상 배포판에서 설치·실행 | **FAIL (이식성) / NOT RUN** | 기존 생성 .deb의 ELF 인터프리터가 `/nix/store/…glibc-2.44…/ld-linux-x86-64.so.2`, RUNPATH가 Nix store와 개발자 경로를 가리킴: Debian/Ubuntu에서 실행 불가. 후속 실행파일은 개발자 경로만 제거했으며 Nix store 런타임 의존성은 유지된다. .deb 재생성·대상 배포판 설치/실행은 이번에 하지 않음 | 대상 배포판(또는 그 컨테이너)에서 빌드·설치·실행; glibc 최소 버전 결정 | 배포판 빌드 환경(외부) |
| 패키지 메타데이터 | 관리자·설명·분류·저작권 문서 | GAP | control `Maintainer: github`, 긴 설명 `(none)`, `.desktop` `Categories=` 비어 있음, `/usr/share/doc/geul/copyright` 없음 | `tauri.conf.json` bundle 메타데이터·고지 파일 포함 | 소유자 결정(관리자·분류)과 고지 확정 |
| 바이너리 경로 노출 | 개발자 사적 절대 경로 미포함 | COMPLETED (Linux Release 실행파일) | 이전 GAP: 홈 경로 문자열 930줄·개발 RUNPATH. 후속 보호 빌드에 Release 전용 `--remap-path-prefix`와 실제 ELF 검사 gate 적용, 사적 경로 931회→0회·개발 RUNPATH 1개→0개. 빌드·HWPX/DOCX 최소 GUI smoke PASS(아래 상세) | Nix store 경로는 런타임에 필요해 유지; 배포판 이식성·패키지 수용은 별도 | — |
| PDF 출력 | 지원 형식 PDF | CURRENT PASS(Linux, 조건) | [품질 행렬 3절](quality-matrix.md#3-pdf-출력-수용-s5-4): native 4 양성·3 음성, 독립 구조·시각 검사; Phase 2: GTK 확인에 묶인 일회용 덮어쓰기 허가 + RENAME_EXCHANGE 신원 조건 교체, native 덮어쓰기 3건·독립 텍스트(ToUnicode) 검사 PASS; 후속 안정화: 허가를 내보내기(토큰·세션·generation)에 묶음, 확인 뒤 삭제된 대상 거부, 교환 뒤 정리 실패 보고·이전 파일 보존, 두 엔진의 게시를 레지스트리 잠금 안에서 선형화, native run7 PASS; 최종 예외 경계: **첫** 교환 뒤 identity 조회 오류는 게시 성공이 아니라 `PdfReplacementUnverified` 부분 게시 상태로 반환하고 파일·journal을 보존; identity 확인 뒤 **두 번째 cleanup 조회**가 불확실할 때만 `cleanupUncertain` 게시 성공. export 종료 시 세션 소유 grant 회수, cleanup/durability 동시 경고. 최종 identity 회귀 1건(실제 파일/journal 5 하위 경우), 프런트엔드 부분 게시 회귀 1건 및 `npm run typecheck` PASS(세부 결과와 재사용 기록은 품질 행렬 3절 참조) | ~~DOCX 한글 글꼴 GAP~~: 2026-11-15 fontconfig 제공자로 NixOS 해결(독립 PDF 검사 PASS, [글꼴 시스템](architecture/font-system.md)); HWP/HWPX PDF는 쪽 그림(글자 선택 불가); 인쇄 미구현; Windows/macOS NOT RUN | S5-3 |
| 라이선스: 엔진 | RHWP(MIT)·WordCraft(MIT OR Apache-2.0 + NOTICE) 고지 | CURRENT PASS(생성) / GAP(동봉) | [rhwp](licenses/rhwp.md), [wordcraft](licenses/wordcraft.md); `scripts/generate-notices.py`가 LICENSE/NOTICE 원문 포함 `THIRD_PARTY_NOTICES.md` 생성 | 패키지에 고지 파일 동봉 안 됨 | bundle 리소스 설정 |
| 라이선스: 링크 crate | 실제 링크 그래프 고지 | CURRENT PASS (Phase 2) / GAP(동봉) | `python3 scripts/generate-notices.py --out <dir>`: 종료 0, `missingLicenseText` 0, geul 326·RHWP WASM 138 crate·npm 4, 원문 256개, 재생성 바이트 동일, 출력에 로컬 절대 경로 없음. 게시 패키지에 원문이 없던 6개(alloc-stdlib, dlopen2, krilla, libappindicator-sys, selectors, wuff)는 게시 커밋의 원문을 이름·버전·checksum·SHA-256으로 고정([근거](licenses/third-party.md)); 변조·버전/checksum 불일치·항목 없음은 실패(검증). GPL/LGPL 없음. MPL-2.0 4개(cssparser, dtoa-short, option-ext, selectors) + krilla의 MPL 파생 코드(상류 NOTICE.md)를 §3.2 소스 제공 안내에 포함 | 패키지에 고지 파일 미동봉 | 배포 작업(bundle 리소스) |
| 라이선스: 번들 자산 | 글꼴·패턴·프런트엔드 | CURRENT PASS(목록·원문) / GAP(동봉) | WordCraft가 바이너리에 넣는 OFL-1.1 글꼴 4계열(Source Sans 3, Source Serif 4, Inter, JetBrains Mono — 원문 `external/wordcraft/assets/fonts/OFL-*.txt`), 하이픈 패턴 pt(BSD-3)·pl/it(MIT) 머리 고지, en(퍼블릭 도메인); npm 번들 4개(react·react-dom·scheduler MIT, @tauri-apps/api Apache-2.0 OR MIT). `CRAFT_FONTS_DIR` 미사용 → CJK craft-fonts 미포함. RHWP 자산은 WASM/JS만(글꼴 미포함) | 동봉 미설정 | bundle 리소스 설정 |
| 라이선스: geul 자체 | 저장소 라이선스 | CURRENT PASS (Phase 2) | 소유자 결정에 따라 MIT: 루트 `LICENSE`(표준 MIT 원문, "Copyright (c) 2026 MinGyu2" — 저장소 커밋 403개 모두의 작성자이자 GitHub 소유자 표기), `src-tauri/Cargo.toml` `license = "MIT"`, `package.json` `license`, README | 법적 성명 표기를 원하면 소유자가 저작권 줄을 바꿀 수 있음(저장소 기록에는 `MinGyu2`만 있음) | — |
| 아이콘·템플릿 | 재배포 권리 | REUSED(프로젝트 자체) | `src-tauri/icons`(프로젝트 초기 커밋), WordCraft/ArtCraft 브랜드 자산 미사용([wordcraft](licenses/wordcraft.md)) | 출처 기록 없음(자체 제작으로 추정, 확인 필요) | 소유자 확인 |
| 로컬 보안: 민감정보 | 추적 파일 검사 | CURRENT PASS | `python3 scripts/check-sensitive-info.py --all`: 추적 파일 436개 통과; Stage 5-A 커밋마다 pre-commit(민감정보·gitleaks) 통과(한 번 시험 파일의 사용자 홈 경로 문자열을 잡아 수정, 우회 없음) | 전체 Git 이력 재검사는 요구 없음(미실행) | — |
| 로컬 보안: 권한 | Tauri 권한·파일 경계 | CURRENT PASS(검토) | `capabilities/default.json`: 추가는 `document_export_pdf`·`docx_export_pdf` 두 앱 명령뿐, fs/shell 플러그인 없음. PDF는 native 대화상자 경로의 `.pdf`만 쓰고 세션 원본을 열지 않음 | — | — |
| 로컬 보안: 외부 명령 | 제품 코드의 프로세스 실행 | CURRENT PASS(검토) | 제품 소스의 `std::process::Command`는 시험 코드(recovery SIGKILL 시험)에만 있음 | — | — |
| 로컬 보안: 산출물 | 생성물 추적 금지 | CURRENT PASS | `git ls-files`에 target/dist/WASM/PDF/deb 없음; `.agent-tmp.md`는 로컬 exclude | — | — |
| 로컬 보안: 훅 | 로컬 훅 | CURRENT PASS | `.git/hooks/pre-commit`, `pre-push` 설치(pre-commit 프레임워크) | — | — |
| T014 잔여 | 정전·실제 FS 고장, Windows/macOS 저장 | DEFERRED | [T014](architecture/t014-final-acceptance-2026-11-12.json) | 외부 환경 | 별도 승인 |
| T015 잔여 | 외부 corpus GAP(글꼴 metrics는 해결) | HWP/HWPX supported font mutation/T009/native save-reopen PASS; RHWP natural metrics PASS(2026-11-16, run12); external corpus remains GAP | [품질 행렬 6·7절](quality-matrix.md#7-stage-5-a-글꼴-패키지-2026-11-16) | complex shaping unsupported(documented); external office reopen NOT RUN; Windows/macOS DEFERRED |
| 글꼴 시스템 | 시스템 글꼴 탐색·사용자 글꼴·선택·PDF | WordCraft/DOCX CURRENT PASS(NixOS); RHWP HWP/HWPX mutation/T009, natural metrics(줄바꿈·caret·selection·Canvas/PDF)·table-cell native(run12) CURRENT PASS; package COMPLETED(지원 범위; 2026-11-15/16 초기 PARTIAL은 역사 기록); complex shaping·Windows/macOS·다른 배포판·외부 오피스 재열기는 미수용 | [글꼴 시스템](architecture/font-system.md): per-language document IDs, safe existing/new definitions, publication/history, native evidence | Natural advances·지원 범위 줄바꿈은 구현·검증됨(2026-11-16). 복합 shaping(문맥형·합자·RTL·일반 kerning) UNSUPPORTED; nested-cell native·글꼴 제거/refresh native NOT RUN; 외부 오피스 재열기 NOT RUN; Windows/macOS·다른 배포판 DEFERRED | 플랫폼 수용(S5-3), 외부 오피스 호환(S5-2), 배포 패키지·라이선스 동봉 (metrics integration은 2026-11-16 완료) |
| 외부 Office 상호운용 (S5-2) | 한컴·Word GUI | DEFERRED / NOT RUN | 이번 작업 지시로 보류 | 전부 | 허가된 GUI 환경 |
| Windows/macOS (S5-3) | 빌드·설치·IME·저장·PDF | DEFERRED / NOT RUN | 보류 | 전부 | 각 OS 환경 |
| 다른 입력·그래픽 환경 | Wayland/fcitx5 등 | DEFERRED / NOT RUN | 보류 | 전부 | 해당 환경 |
| 원격 보안·공개 게이트 (T019 R) | GitHub Actions 등 | NOT RUN | push 금지 작업 | 전부 | 원격 실행 승인 |

## Release private-path cleanup 후속 검증 (2026-11-16)

**COMPLETED: Linux Release 실행파일의 개발자 사적 경로 제거.** Stage 5-A font package는 지원 범위 COMPLETED, Stage 5-A overall은 PARTIALLY COMPLETED, Stage 5는 INCOMPLETE, Release는 NO-GO다. .deb 이식성, 라이선스 고지 동봉, 패키지 메타데이터, Windows/macOS·다른 Linux 배포판 및 외부 Office 호환성은 별도 미완료 항목이다.

- 기준: 시작 HEAD `b701bf2a20dc8e4f5f3e8cca855f0d0151b22669`; RHWP `1a76570e833917d15817415a53c09ad61ab3203f`, WordCraft `6931bcc12af12ff874a9ebb4c63cebe17b3f8b82` 유지. rustc/Cargo 1.99.1. 이전 조사에서 Cargo 1.99.1의 `trim-paths`가 불안정이라는 확인 기록은 유지하며, 이번에는 지원되는 `--remap-path-prefix`를 사용했다. 기존 Release 실행파일 SHA-256 `9ac79fe56beda3e79512a84aec254a3fd2ce49cc882b34cca99ffbb03b1609ac`(57,450,008 bytes)을 수정 전에 조사했다.
- 원인: Cargo registry의 절대 소스 위치와 프로젝트/WordCraft 소스의 panic·파일 위치 문자열. DWARF 섹션은 없고 `.symtab`은 있어 debug strip만으로 해결할 문제가 아니었다. 개발 RUNPATH는 상속된 `NIX_LDFLAGS`의 존재하지 않는 개발 shell 출력 디렉터리였다. `build.rs`·소스의 `include_*`/`env!` 사용도 확인했으며, 최종 전체 바이트 검사에 잔여 사적 경로는 없다.
- 정책: `scripts/tauri-geul.py`가 Release에만 실제 홈→`/src/home`, Cargo home→`/src/cargo`, 프로젝트→`/src/geul`을 `--remap-path-prefix`로 매핑한다. 실제/해결된 prefix를 런타임에 도출하며 특정 사용자·checkout 경로를 설정에 기록하지 않는다. [Cargo 플래그 우선순위](https://doc.rust-lang.org/cargo/reference/config.html#buildrustflags)에 따라 encoded 인자를 우선 보존하고, `RUSTFLAGS`는 Cargo와 같은 공백 분리 후 encoded 형식으로 합성한다. 충돌하는 remap·안전하게 합성할 수 없는 target/cfg 설정은 명시적으로 실패한다. 개발·Debug의 기존 플래그/자산 선택은 유지한다. Release profile·strip 정책, C/C++ 플래그와 정상 linker 옵션은 변경하지 않았다.
- RUNPATH: Nix linker 변수에서 **존재하지 않는 사적 `-rpath` 성분만** 제거한다. 실제로 존재하는 사적 런타임 디렉터리는 자동 제거하지 않고 실패시켜 의존성 검토를 요구한다. Nix store의 필수 라이브러리 경로와 인터프리터는 보존한다.
- gate: 보호 sandbox 안에서 이전 최종 실행파일만 무효화해 이번 build가 만든 파일을 검사한다(의존성 cache 삭제 없음). `external-integrity.py`의 read-only source/Git 보호, `require_clean`, 고정 submodule 검사, `--locked --offline`과 허용 writable 디렉터리는 유지한다. 보호 빌드 성공 뒤 `scripts/check-release-paths.py`가 실제 native ELF64 실행파일·전체 바이트·`readelf` 결과를 검사한다. 사적 경로/런타임 사적 경로/도구 오류는 빌드 실패다. `privacyStatus`, `runtimePathStatus`, `portabilityStatus`는 별도이며 PE/Mach-O·타 아키텍처를 검증된 ELF로 취급하지 않는다.

실행 명령:

```sh
python3 -m unittest scripts/tests/test_release_paths.py scripts/tests/test_tauri_geul.py scripts/tests/test_external_integrity.py
python3 scripts/tauri-geul.py build --no-bundle
python3 scripts/check-release-paths.py src-tauri/target/release/geul --report target/release-path-cleanup/final-gate.json
```

집중 시험 **44 PASS**: 실제 host ELF fixture에 사적 프로젝트/Cargo/home 문자열 주입, 외부 사용자 홈 패턴, RUNPATH(제어된 GNU readelf 출력), virtual/system 경로, 누락/빈/잘못된 artifact, 검사 도구 실패·timeout·경고, CLI 종료 코드, 플래그 보존·충돌 거부, 보호 빌드/gate 순서·실패 경계, Debug 유지. 최종 Debug 선택 보존을 위한 wrapper 시험을 재확인했다. 일반 홈 탐지 정규식을 보안 훅의 사적 경로 literal 오탐과 겹치지 않게 동등하게 묶은 뒤 checker·wrapper 시험과 실제 artifact gate를 재확인했으며, 나머지 유효한 결과는 재사용했다.

실제 보호 Release build exit 0: Cargo 372 units를 재컴파일했고 geul·WordCraft 의존성에 remap 플래그가 적용된 것을 확인했다(기존 cache만으로 판정하지 않음). 관찰된 Release compiler 옵션은 `-C opt-level=3`, `-C strip=debuginfo`. 무결성 보고 `PASS`, `readOnlySandbox: true`, command exit `[0]`, 외부 소스 신원 불변. RHWP Release WASM은 기존 generation `5dc438563e192fe4370b6ec0bb5f0b9bddf70f637b72e53ab889f77e8402e124`을 그대로 사용했고 재빌드하지 않았다.

| 경로 분류 (바이트 출현 횟수) | 이전 | 최종 |
|---|---:|---:|
| Cargo 사적 소스 | 841 | 0 |
| 프로젝트/외부 dependency 사적 소스 | 89 | 0 |
| 나머지 개발자 홈 (RUNPATH) | 1 | 0 |
| 사적 경로 합계 | 931 | 0 |
| 중립 virtual source | 0 | 930 |
| 정상 system runtime 참조 | 59 | 59 |
| Nix store 참조 | 63 | 63 |
| Rust/build-system source 참조 | 73 | 73 |

이전의 `strings` 930줄과 바이트 출현 931회의 차이는 한 줄에 연결된 경로 때문이다. 사적 분류는 중복 없는 합계이며, 정상 경로 분류는 서로 겹칠 수 있다. 예시는 `$CARGO_HOME/registry/src/…/src/*.rs`, `$PROJECT_ROOT/external/wordcraft/…` → `/src/cargo/…`, `/src/geul/external/wordcraft/…`; 시스템 경로와 `/rustc/…`·`/build/…`는 사적 홈 경로와 구분한다.

최종 artifact: `src-tauri/target/release/geul`, **58,022,832 bytes**, SHA-256 **`3f3e64656ff1fe485eaf9c3e525fb0996f4a0a7aaa971918cc97439699777e72`**. ELF64 x86-64 PIE, 인터프리터 `/nix/store/pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57/lib/ld-linux-x86-64.so.2`; RUNPATH는 Nix store 13개만, RPATH 없음, 사적 런타임 경로 0개. NEEDED 15개: `libgdk-3.so.0`, `libgdk_pixbuf-2.0.so.0`, `libcairo.so.2`, `libgobject-2.0.so.0`, `libglib-2.0.so.0`, `libdbus-1.so.3`, `libwebkit2gtk-4.1.so.0`, `libgtk-3.so.0`, `libsoup-3.0.so.0`, `libgio-2.0.so.0`, `libjavascriptcoregtk-4.1.so.0`, `libgcc_s.so.1`, `libm.so.6`, `libc.so.6`, `ld-linux-x86-64.so.2`. DWARF 없음, `.symtab` 유지. gate는 privacy/runtime-path **PASS**, portability **NOT VERIFIED**; Nix 의존성 때문에 일반 Debian/Ubuntu 수용을 증명하지 않는다.

최소 GUI smoke **PASS**: 동일 SHA의 실제 Release 앱을 기존 private X11/IBus launcher·Tauri WebDriver로 실행했다(`LD_LIBRARY_PATH` 미설정). 1280×800 창, production frontend(`testFlags: {}`), 위 RHWP Release generation 로드 확인. 기존 지원 HWPX·DOCX fixture의 복사본을 각각 열어 Canvas paint를 확인하고 실제 키 입력으로 `RELEASESMOKE`를 넣은 뒤 정상 UI로 저장했다. 두 형식 모두 `saved`, dirty 해제, 파일 hash 변경, ZIP CRC 정상·저장 XML의 입력 내용 확인. 새 dynamic-loader/missing-library 오류 없음. driver/session·Xvfb/IBus 종료와 잔존 프로세스 없음 확인. 전체 형식 왕복 수용이나 T009/T014 재수용으로 확대 해석하지 않는다.

상세 원본 경로/환경과 로그는 무시되는 `target/release-path-cleanup/`에만 보관: `baseline-*`, `release-build.log`, `unit-tests.log`, `final-gate.json`, `runtime-smoke.log`, `smoke/result.json`, `smoke-session/session.json`, `smoke-session/cleanup.json`. 자동 gate 보고는 `src-tauri/target/release-paths.json`, 보호 빌드 증거는 `target/rhwp-wasm/tauri-integrity.json`. 전체 Vitest/Rust/RHWP/WordCraft suite, native run12, PDF·T009/T014 acceptance, natural-font 시험 재실행, D4, 패키징·.deb 재생성, 외부 Office·타 OS/배포판 수용은 NOT RUN; 바꾸지 않은 문서 기능의 이전 근거를 재사용한다.

## 알려진 기존 시험 실패 (출시 전 해결 필요)

- `services::save` 3개(`calc_cell_stale_previews_are_regenerated_only_from_a_valid_render`, `calc_cell_two_durable_saves_with_regenerated_previews`, `hwp_편집한_저장은_본문과_캐럿만_달라도_되고_그_밖은_원본과_같아야_한다`): 보호 sandbox 밖에서도 실패(추가 `OutputMalformed` 근거 — 거부 쪽으로 엄격). Stage 4 보고 이전부터 있던 실패다. 정정: Stage 5-A는 일반 문서 저장 경로를 바꾸지 않았지만 공유 `publish.rs`에 PDF 전용 교환 연산을, `session.rs`에 PDF 게시 지점을 더했다. 그 뒤에도 `--lib services::save`는 249/3/25로 같은 3개만 실패한다. 원인 수정은 이번 범위 밖으로 기록만 한다.
- 프런트엔드 4개(`hangulTools` 1, `sessions` rhwp 1, `hwpReopenModel` 2): 시작 HEAD에서 같은 실패.
- 보호 실행기(`scripts/cargo-geul.py`)의 sandbox `/tmp`는 1777 tmpfs이고 uid 매핑 때문에 게시 계층이 모든 상위 디렉터리를 공유 디렉터리로 본다. 실제 게시를 하는 시험(예: `services::files::tests::a_replaced_published_inode…`, 새 `services::pdf` 게시 시험)은 이 sandbox에서 `SaveUnsupported{shared-directory}`로 실패하고 일반 파일 시스템에서는 통과한다. 시험 환경 문제로 기록한다(제품 정책은 바꾸지 않음).
