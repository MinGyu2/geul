# WordCraft 라이선스 및 고지 의무

- 대상: `external/wordcraft/` @ `fc41918814f62645b6746ed68e71e8c2c2e85d6f` (`v0.7.0`)
- 검토일: 2026-10-16. 법률 자문이 아닌 엔지니어링 검토 기록입니다.

## 본체

- 라이선스: **MIT OR Apache-2.0** (선택). 근거: `Cargo.toml`의 `[workspace.package] license`,
  `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`.
- 저작권 표기: "Copyright (c) 2026 ArtCraft Team and the WordCraft contributors." (`NOTICE`)
- GitHub API는 저장소 라이선스를 `Apache-2.0` 하나로 표시하지만, 고정 커밋의 매니페스트와 NOTICE는
  이중 라이선스를 명시합니다. 판단은 고정 커밋의 파일을 기준으로 합니다.
- 기여자 목록: `contributors/people.toml`, `contributors/contributors.json`

## 배포 시 의무 (앱이 WordCraft 크레이트를 링크하는 경우)

1. MIT를 선택하면 저작권 표기와 허가 문구를, Apache-2.0을 선택하면 라이선스 사본과 `NOTICE` 내용을
   함께 배포합니다. 두 라이선스 문서와 NOTICE를 모두 포함하는 것을 기본으로 합니다.
2. 링크하는 크레이트가 끌어오는 crates.io 의존성의 라이선스를 배포물 고지에 포함합니다
   (NOTICE는 MIT/Apache-2.0/BSD/ISC/Zlib 계열이라고 설명함). 실제 목록은 앱의 `Cargo.lock` 기준으로
   생성·확인해야 하며 아직 수행하지 않았습니다(T016).
3. 번들되는 서드파티 자산(`ATTRIBUTION.md` 표 참고):
   - 글꼴: Source Sans 3, Source Serif 4, Inter, JetBrains Mono — SIL OFL 1.1 (라이선스 텍스트 동봉 필요)
   - 하이픈 패턴: 영어(CC0/퍼블릭 도메인), 폴란드어·이탈리아어(MIT), 포르투갈어(BSD-3-Clause, 고지 필요)
   - `CRAFT_FONTS_DIR`로 빌드한 경우 일본어 글꼴(OFL 1.1)이 포함됨

## 사용하지 않는 것

- **ArtCraft 브랜드 자산**(`docs/brand/`): 상표이며 오픈소스가 아닙니다
  (`docs/brand/LICENSE-brand.txt`). 앱 UI·문서·배포물에 사용하지 않습니다.
- WordCraft 앱 아이콘(`assets/app-icon/`)과 egui UI: 라이선스상 사용은 가능하지만, 독자 UI 원칙에 따라
  재사용하지 않습니다.
- UI는 "WordCraft-inspired" 배치만 참고하며 WordCraft의 상표·명칭을 제품명으로 쓰지 않습니다.

## 미확인 사항

- 앱이 실제로 링크할 크레이트 범위와 그에 따른 전이 의존성 라이선스 목록 (T008, T016)
