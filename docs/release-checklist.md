# 출시 점검표 (T016, Stage 5-A 로컬 범위 — 2026-11-15)

**판정: 출시 NO-GO.** 이 표는 현재 Linux 개발 환경에서 실제로 할 수 있는 항목만 Stage 5-A에서 실행하고 나머지는 상태와 선행 조건을 적는다. 출시 GO, T016 Done, 전체 Stage 5 완료가 아니다. 근거 소스: `master` `9027acc`(PDF `639657a`) 이후 문서 커밋. 품질 근거는 [품질 행렬](quality-matrix.md).

| 영역 | 요구 | 상태 | 근거·구현 | 남은 차이 | 완료 선행 조건 |
|---|---|---|---|---|---|
| Linux 로컬 빌드 | Release 앱 빌드(검증된 RHWP Release 자산) | CURRENT PASS | `python3 scripts/tauri-geul.py build --no-bundle` exit 0(`target/stage5a/build-release.log`), `rhwp-artifacts.py --verify-product dist/rhwp --profile release` PASS, `dist/frontend-build.json` `mode: production`, `testFlags: {}` | — | — |
| Linux 패키지 생성 | 실제 패키지 | CURRENT PASS(생성) | 설정 파일 변경 없이 `tauri-geul.py build --bundles deb --config '{"bundle":{"active":true}}'` → `geul_0.1.0_amd64.deb` 21.7 MiB(`ar`: debian-binary/control/data; `/usr/bin/geul`, `.desktop`, hicolor 아이콘; Depends `libwebkit2gtk-4.1-0, libgtk-3-0`). 저장소 설정은 `bundle.active: false` 그대로 | 아래 이식성·메타데이터 | — |
| Linux 패키지 수용 | 대상 배포판에서 설치·실행 | **FAIL (이식성) / NOT RUN** | ELF 인터프리터가 `/nix/store/…glibc-2.44…/ld-linux-x86-64.so.2`, RUNPATH가 Nix store와 개발자 경로를 가리킴: Debian/Ubuntu에서 실행 불가. 이 NixOS 호스트에 대상 배포판 없음 | 대상 배포판(또는 그 컨테이너)에서 빌드·설치·실행; glibc 최소 버전 결정 | 배포판 빌드 환경(외부) |
| 패키지 메타데이터 | 관리자·설명·분류·저작권 문서 | GAP | control `Maintainer: github`, 긴 설명 `(none)`, `.desktop` `Categories=` 비어 있음, `/usr/share/doc/geul/copyright` 없음 | `tauri.conf.json` bundle 메타데이터·고지 파일 포함 | 소유자 결정(관리자·분류)과 고지 확정 |
| 바이너리 경로 노출 | 로컬 절대 경로 미포함 | GAP | Release 바이너리에 사용자 홈 아래 절대 경로 문자열 930개(cargo registry·프로젝트 소스 경로, panic 위치)와 RUNPATH의 개발 경로. Cargo 1.99.1에서 `trim-paths`는 불안정(확인) | 출시 빌드에서 `--remap-path-prefix`(RUSTFLAGS) 적용과 확인 | 출시 빌드 파이프라인 결정 |
| PDF 출력 | 지원 형식 PDF | CURRENT PASS(Linux, 조건) | [품질 행렬 3절](quality-matrix.md#3-pdf-출력-수용-s5-4): native 4 양성·3 음성, 독립 구조·시각 검사; Phase 2: GTK 확인에 묶인 일회용 덮어쓰기 허가 + RENAME_EXCHANGE 신원 조건 교체, DOCX 게시 직전 세션 재확인, native 덮어쓰기 3건·독립 텍스트(ToUnicode) 검사 PASS | DOCX 한글은 WordCraft가 찾을 수 있는 한글 글꼴 필요(이 호스트 기본 환경 GAP); HWP/HWPX PDF는 쪽 그림(글자 선택 불가); 인쇄 미구현; Windows/macOS NOT RUN | 글꼴 탐색 GAP 결정, S5-3 |
| 라이선스: 엔진 | RHWP(MIT)·WordCraft(MIT OR Apache-2.0 + NOTICE) 고지 | CURRENT PASS(생성) / GAP(동봉) | [rhwp](licenses/rhwp.md), [wordcraft](licenses/wordcraft.md); `scripts/generate-notices.py`가 LICENSE/NOTICE 원문 포함 `THIRD_PARTY_NOTICES.md` 생성 | 패키지에 고지 파일 동봉 안 됨 | bundle 리소스 설정 |
| 라이선스: 링크 crate | 실제 링크 그래프 고지 | CURRENT PASS(목록) / **GAP 6건** | `generate-notices.py`(offline·locked, x86_64 Linux, 일반 의존성만, proc-macro 제외): geul 326 crate, RHWP WASM 138 crate, 서로 다른 라이선스 원문 251개. GPL/LGPL 없음. MPL-2.0 4개(cssparser, dtoa-short, option-ext, selectors — Tauri 경유)는 §3.2 소스 제공 안내를 생성 고지에 포함. Unicode-3.0(ICU 계열) 포함 | 배포된 crate 소스에 라이선스 파일이 없는 6개(alloc-stdlib, dlopen2, krilla, libappindicator-sys, selectors, wuff): 선언 라이선스·저자·저장소만 기록, 생성기는 이 때문에 실패 코드로 끝남 | 상류 저장소에서 원문 확인·첨부 |
| 라이선스: 번들 자산 | 글꼴·패턴·프런트엔드 | CURRENT PASS(목록·원문) / GAP(동봉) | WordCraft가 바이너리에 넣는 OFL-1.1 글꼴 4계열(Source Sans 3, Source Serif 4, Inter, JetBrains Mono — 원문 `external/wordcraft/assets/fonts/OFL-*.txt`), 하이픈 패턴 pt(BSD-3)·pl/it(MIT) 머리 고지, en(퍼블릭 도메인); npm 번들 4개(react·react-dom·scheduler MIT, @tauri-apps/api Apache-2.0 OR MIT). `CRAFT_FONTS_DIR` 미사용 → CJK craft-fonts 미포함. RHWP 자산은 WASM/JS만(글꼴 미포함) | 동봉 미설정 | bundle 리소스 설정 |
| 라이선스: geul 자체 | 저장소 라이선스 | **BLOCKED (소유자 결정)** | README "아직 정하지 않았습니다" | 결정 전 출시 불가 | 소유자 결정 |
| 아이콘·템플릿 | 재배포 권리 | REUSED(프로젝트 자체) | `src-tauri/icons`(프로젝트 초기 커밋), WordCraft/ArtCraft 브랜드 자산 미사용([wordcraft](licenses/wordcraft.md)) | 출처 기록 없음(자체 제작으로 추정, 확인 필요) | 소유자 확인 |
| 로컬 보안: 민감정보 | 추적 파일 검사 | CURRENT PASS | `python3 scripts/check-sensitive-info.py --all`: 추적 파일 436개 통과; Stage 5-A 커밋마다 pre-commit(민감정보·gitleaks) 통과(한 번 시험 파일의 사용자 홈 경로 문자열을 잡아 수정, 우회 없음) | 전체 Git 이력 재검사는 요구 없음(미실행) | — |
| 로컬 보안: 권한 | Tauri 권한·파일 경계 | CURRENT PASS(검토) | `capabilities/default.json`: 추가는 `document_export_pdf`·`docx_export_pdf` 두 앱 명령뿐, fs/shell 플러그인 없음. PDF는 native 대화상자 경로의 `.pdf`만 쓰고 세션 원본을 열지 않음 | — | — |
| 로컬 보안: 외부 명령 | 제품 코드의 프로세스 실행 | CURRENT PASS(검토) | 제품 소스의 `std::process::Command`는 시험 코드(recovery SIGKILL 시험)에만 있음 | — | — |
| 로컬 보안: 산출물 | 생성물 추적 금지 | CURRENT PASS | `git ls-files`에 target/dist/WASM/PDF/deb 없음; `.agent-tmp.md`는 로컬 exclude | — | — |
| 로컬 보안: 훅 | 로컬 훅 | CURRENT PASS | `.git/hooks/pre-commit`, `pre-push` 설치(pre-commit 프레임워크) | — | — |
| T014 잔여 | 정전·실제 FS 고장, Windows/macOS 저장 | DEFERRED | [T014](architecture/t014-final-acceptance-2026-11-12.json) | 외부 환경 | 별도 승인 |
| T015 잔여 | 외부 corpus·글꼴 GAP | GAP | [품질 행렬 6절](quality-matrix.md#6-남은-t015-의무) | — | — |
| 외부 Office 상호운용 (S5-2) | 한컴·Word GUI | DEFERRED / NOT RUN | 이번 작업 지시로 보류 | 전부 | 허가된 GUI 환경 |
| Windows/macOS (S5-3) | 빌드·설치·IME·저장·PDF | DEFERRED / NOT RUN | 보류 | 전부 | 각 OS 환경 |
| 다른 입력·그래픽 환경 | Wayland/fcitx5 등 | DEFERRED / NOT RUN | 보류 | 전부 | 해당 환경 |
| 원격 보안·공개 게이트 (T019 R) | GitHub Actions 등 | NOT RUN | push 금지 작업 | 전부 | 원격 실행 승인 |

## 알려진 기존 시험 실패 (출시 전 해결 필요)

- `services::save` 3개(`calc_cell_stale_previews_are_regenerated_only_from_a_valid_render`, `calc_cell_two_durable_saves_with_regenerated_previews`, `hwp_편집한_저장은_본문과_캐럿만_달라도_되고_그_밖은_원본과_같아야_한다`): 보호 sandbox 밖에서도 실패(추가 `OutputMalformed` 근거 — 거부 쪽으로 엄격). Stage 4 보고 이전부터 있던 실패이며 Stage 5-A는 저장 코드를 바꾸지 않았다. 원인 수정은 이번 범위 밖으로 기록만 한다.
- 프런트엔드 4개(`hangulTools` 1, `sessions` rhwp 1, `hwpReopenModel` 2): 시작 HEAD에서 같은 실패.
- 보호 실행기(`scripts/cargo-geul.py`)의 sandbox `/tmp`는 1777 tmpfs이고 uid 매핑 때문에 게시 계층이 모든 상위 디렉터리를 공유 디렉터리로 본다. 실제 게시를 하는 시험(예: `services::files::tests::a_replaced_published_inode…`, 새 `services::pdf` 게시 시험)은 이 sandbox에서 `SaveUnsupported{shared-directory}`로 실패하고 일반 파일 시스템에서는 통과한다. 시험 환경 문제로 기록한다(제품 정책은 바꾸지 않음).
