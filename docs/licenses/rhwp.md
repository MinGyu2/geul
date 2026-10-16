# rhwp 라이선스 및 고지 의무

- 대상: `external/rhwp/` @ `1a76570e833917d15817415a53c09ad61ab3203f` (`v0.8.7`)
- 검토일: 2026-10-16. 법률 자문이 아닌 엔지니어링 검토 기록입니다.

## 본체

- 라이선스: **MIT**. 근거: `LICENSE`("Copyright (c) 2025-2026 Edward Kim"), `Cargo.toml`
  `license = "MIT"`.
- 서드파티 목록: `THIRD_PARTY_LICENSES.md` (`Cargo.lock`, 각 `package-lock.json`, `assets/fonts/FONTS.md` 기준)
- 하위 구성요소 중 `rhwp-desk`는 `MIT OR Apache-2.0`으로 별도 표기되어 있습니다(사용 계획 없음).

## 배포 시 의무 (앱이 rhwp를 링크하거나 WASM으로 포함하는 경우)

1. MIT 저작권 표기와 허가 문구를 배포물에 포함합니다.
2. `THIRD_PARTY_LICENSES.md`에 따른 고지:
   - Rust 의존성: MIT/Apache-2.0/BSD/ISC/Zlib/Unlicense/CC0 계열. `encoding_rs`(BSD-3-Clause 조항),
     `ed25519-dalek`(BSD-3-Clause) 등 BSD 계열은 고지가 필요합니다.
   - 직접 포팅한 코드: Volexity `hwp-extract`의 HWP5 암호 키 파생·복호화(`src/parser/crypto.rs`) —
     BSD-3-Clause, 저작권 고지 필요.
   - 스펙 참조: hancom-io `hwpx-owpml-model`, `dvc` (Apache-2.0) — rhwp는 코드 복사 없이 스펙 정보만
     참조했다고 밝힘.
3. 글꼴: 저장소에 포함된 글꼴은 SIL OFL 1.1(Pretendard, Noto, 나눔, D2 Coding 등)과 GUST Font
   License(Latin Modern Math)입니다. 앱에 포함하는 글꼴만 골라 라이선스 텍스트를 동봉합니다.
   한컴·Microsoft 글꼴은 저장소에 없으며 재배포하지 않습니다.
4. 실제 배포 목록은 앱이 링크하는 기능 범위와 `Cargo.lock`/`package-lock.json` 기준으로 다시 생성해야
   하며 아직 수행하지 않았습니다(T016).

## 상표·자료

- "한글", "한컴", "HWP", "HWPX"는 한글과컴퓨터의 등록 상표라고 README에 명시되어 있습니다. 앱 설명에서
  형식 이름으로만 사용하고 로고나 제품명처럼 쓰지 않습니다.
- `samples/`, `pdf/`, `mydocs/`의 문서·PDF는 파일별 출처와 라이선스가 명시되어 있지 않습니다.
  이 저장소로 복사하거나 배포물에 포함하지 않습니다.

## 미확인 사항

- 링크 범위(네이티브 vs WASM, 사용 feature)에 따른 전이 의존성 목록 (T007, T016)
