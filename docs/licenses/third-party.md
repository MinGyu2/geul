# 서드파티 고지 근거 (Stage 5-A Phase 2, 2026-11-15)

엔지니어링 검토 기록이며 법률 자문이 아니다. geul 자체는 [MIT](../../LICENSE)(Copyright (c) 2026 MinGyu2)이고, 아래 구성 요소는 각자의 라이선스를 그대로 따른다.

- 생성: `python3 scripts/generate-notices.py --out <dir>` → `THIRD_PARTY_NOTICES.md`, `inventory.json`. offline·locked 의존성 그래프(geul x86_64 Linux 링크 crate 326, RHWP WASM crate 138, 번들 npm 4)와 WordCraft OFL 글꼴·하이픈 패턴·엔진 LICENSE/NOTICE를 포함한다. 출력에는 로컬 절대 경로가 없다(레지스트리 파일은 `crates.io/<crate>-<ver>/<file>`, 고정 자료는 `pinned/…`).
- 2026-11-15 결과: 종료 코드 0, `missingLicenseText` 0, 서로 다른 라이선스 원문 256개, 두 번 생성한 출력 바이트 동일.
- 실패 시 닫힘(검증함): 고정 자료의 버전 불일치·Cargo.lock checksum 불일치·파일 변조·항목 없음은 각각 해당 패키지를 `missingLicenseText`로 보고하고 종료 코드 1.

## 게시된 패키지에 라이선스 파일이 없는 crate 6개

crates.io 패키지의 `.cargo_vcs_info.json`이 기록한 상류 커밋에서 원문을 가져와 [`third-party/`](third-party/)에 고정했다. [`manifest.json`](third-party/manifest.json)이 이름·정확한 버전·Cargo.lock checksum·커밋·파일별 원본 URL·SHA-256을 기록하고 생성기가 매번 검증한다.

| crate | 버전 | SPDX(매니페스트) | 원문 출처(게시 커밋) | 고지 처리 | 상태 |
|---|---|---|---|---|---|
| alloc-stdlib | 0.3.0 | BSD-3-Clause | dropbox/rust-alloc-no-stdlib `0a81fd69…` `LICENSE` ("Copyright (c) 2016 Dropbox, Inc.") | 저작권 표시·조건·면책을 바이너리 배포물 문서에 재현 | 해결 |
| dlopen2 | 0.8.2 | MIT | OpenByteDev/dlopen2 `cc80e4a0…` `LICENSE` (Szymon Wieloch 2017, Ahmed Masud 2019) | 저작권 표시·허가 문구 재현(원문의 저자 주소 포함 — 민감정보 검사 예외는 이 파일 정확한 경로·SHA-256에만) | 해결 |
| krilla | 0.8.2 | MIT OR Apache-2.0 | LaurenzV/krilla `3ffdf058…` `LICENSE_MIT`, `LICENSE_APACHE`, **`NOTICE.md`** | 두 원문과 NOTICE.md 모두 포함(MIT 선택 가능, Apache 선택 시 NOTICE 필요). NOTICE.md는 resvg(MPL)·typst/svg2pdf/vello(Apache-2.0)에서 가져온 코드를 밝힌다 → 아래 MPL 절 | 해결(MPL 파생 코드 표시) |
| libappindicator-sys | 0.9.0 | Apache-2.0 OR MIT | tauri-apps/libappindicator-rs `eafd1e36…` `LICENSE-MIT`, `LICENSE-APACHE` | 두 원문 포함. 매니페스트에 저장소가 없어, 같은 그래프의 `libappindicator 0.9.0`이 같은 커밋 저장소 루트에서 게시되었고 바이트가 같은 두 파일을 담고 있음으로 출처를 확인 | 해결 |
| selectors | 0.38.0 | MPL-2.0 | servo/stylo `572ecba2…`에는 라이선스 파일 없음(루트·`selectors/` 확인). 게시 crate의 `.rs` 16개 모두 MPL-2.0 Exhibit A 머리 → 정식 원문 `https://www.mozilla.org/media/MPL/2.0/index.txt` | MPL-2.0 원문 포함, 소스 제공 안내(아래) | 해결 |
| wuff | 0.2.9 | MIT | nicoburns/wuff `78e67f52…` `LICENSE` (WOFF2 Authors 2013-2017, Nico Burns 2025) | 저작권 표시·허가 문구 재현 | 해결 |

## MPL-2.0 구성 요소

- 링크되는 MPL-2.0 crate: cssparser 0.37.0, dtoa-short 0.3.5, option-ext 0.2.0, selectors 0.38.0(모두 Tauri 경유, 수정 없음). 앞의 셋은 게시 패키지에 MPL 원문 파일이 있다.
- krilla 0.8.2: 매니페스트는 MIT OR Apache-2.0이지만 상류 NOTICE.md가 `content_draw_path` 메서드(0.8.2 `src/content.rs`에 있음)를 MPL로 제공되는 resvg에서 가져왔다고 밝힌다. 해당 부분의 정확한 MPL 판본과 파일 경계는 상류 기록만으로 확정할 수 없어 보수적으로 MPL 소스 제공 안내 대상에 넣었다(불확실성 기록).
- 의무: MPL-2.0은 파일 단위다. geul 전체가 MPL이 되지 않으며 geul은 MIT다. 실행 형태로 배포할 때(§3.2) 해당 파일의 소스 코드 형태를 제공하거나 얻는 방법을 알리고, 그 파일들이 MPL-2.0을 따른다는 것과 원문을 함께 고지한다. 생성 고지는 정확한 버전의 crates.io 위치와 저장소를 적는다. 수정하지 않았으므로 수정 파일 공개 의무는 생기지 않는다.
- 현재 로컬 빌드(배포하지 않음)에는 배포 의무가 발생하지 않는다. `.deb` 등 배포물에 고지 파일을 넣는 일은 이후 배포 작업이다([출시 점검표](../release-checklist.md)).
