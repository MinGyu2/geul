# geul

HWP/HWPX와 DOCX를 함께 다루는 오픈소스 데스크톱 워드프로세서 프로젝트입니다.

> 상태: 초기 기반 구축 단계입니다. Tauri/React 6영역 화면(제목 표시줄, 리본, 탐색 창, 편집 영역, 속성 창,
> 상태 표시줄)만 동작하며, **문서 열기·편집·저장은 아직 구현되지 않았습니다**(두 엔진 모두 통합 전).
> 화면 언어(한국어/English, 제목 표시줄에서 선택)와 패널·리본·테마·배율 설정은 다시 시작해도 유지됩니다.
> 진행 상황은 [`docs/planning/tasks.md`](docs/planning/tasks.md)를 기준으로 합니다.

## 구성

| 영역 | 기술 |
|------|------|
| 데스크톱 | Tauri 2 |
| 프런트엔드 | React + TypeScript |
| 백엔드 | Rust |
| HWP/HWPX 엔진 | [rhwp](https://github.com/edwardkim/rhwp) — `external/rhwp/` (Git submodule) |
| DOCX 엔진 | [WordCraft](https://github.com/storytold/wordcraft) — `external/wordcraft/` (Git submodule) |

두 엔진은 서로 독립적으로 유지합니다. 문서 모델을 합치거나 엔진 소스를 앱 디렉터리로 복사하지 않고,
앱 쪽 어댑터 계층에서 연결합니다. HWP↔DOCX 형식 변환은 초기 범위에서 제외됩니다.

## 계획 문서

프로젝트 계획의 기준본은 다음 세 파일뿐입니다.

- [`docs/planning/spec.md`](docs/planning/spec.md) — 요구사항, 범위, 수용 기준
- [`docs/planning/plan.md`](docs/planning/plan.md) — 아키텍처, 기술 결정, 검증 전략
- [`docs/planning/tasks.md`](docs/planning/tasks.md) — 작업, 의존성, 완료 조건과 진행 상태

## 시작하기

```sh
git clone https://github.com/MinGyu2/geul.git
cd geul
# 두 엔진을 고정된 커밋으로 받아 옵니다. rhwp 체크아웃은 수 GB이므로 얕은 복제를 권장합니다.
git submodule update --init --depth 1
git submodule status
```

고정 버전과 갱신 절차는 [`external/README.md`](external/README.md)에 있습니다.

## 개발 환경

필요한 도구: Node.js 22 이상(npm), Rust 1.90 이상, Tauri 2의 플랫폼 의존성
([Tauri 사전 준비](https://v2.tauri.app/start/prerequisites/), Linux는 WebKitGTK 4.1 등).
지금의 앱은 엔진을 빌드하지 않으므로 submodule 없이도 실행됩니다.

```sh
npm ci                     # 잠금 파일(package-lock.json) 기준 설치
npm run tauri dev          # 개발 서버(Vite, 포트 1420)와 데스크톱 앱 실행

npm run typecheck          # TypeScript 검사
npm run lint               # ESLint
npm test                   # 컴포넌트·상호작용 테스트(Vitest + Testing Library)
npm run build              # 프런트엔드 빌드(dist/)
(cd src-tauri && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings)
(cd src-tauri && cargo test --locked)   # 문서 형식 판별·세션 테스트(합성 컨테이너, T006)

# CI(.github/workflows/quality.yml)도 위 프런트엔드·Rust 검사를 같은 명령으로 실행한다.

# 실제 앱 스모크 테스트(Linux): tauri-driver와 WebKitWebDriver, 그래픽 세션 필요
# 타일링 창 관리자에서는 최소 창 검사가 건너뛰어지므로 헤드리스 weston에서 실행한다(스크립트 설명 참고)
npm run tauri build -- --debug --no-bundle
python3 tests/e2e/tauri_smoke.py --app src-tauri/target/debug/geul --driver <tauri-driver 경로>
```

## 공개 저장소 보안 검사

이 저장소는 공개를 전제로 합니다. 커밋 전에 민감정보 검사를 반드시 활성화하세요.

```sh
# pre-commit 설치 (예: uv tool install pre-commit 또는 pipx install pre-commit)
pre-commit install   # 커밋 전: 스테이징된 내용, 푸시 전: 모든 ref의 전체 이력(자체 검사기 + Gitleaks)
# 수동 실행
python3 scripts/check-sensitive-info.py --staged   # 스테이징된 변경
python3 scripts/check-sensitive-info.py --all      # 추적 중인 전체 파일
python3 scripts/check-sensitive-info.py --history  # 전체 Git 이력
```

정책과 사고 대응 절차:

- [`docs/development/security-policy.md`](docs/development/security-policy.md)
- [`docs/development/security-incident.md`](docs/development/security-incident.md)

## 라이선스

이 저장소 자체의 라이선스는 아직 정하지 않았습니다. 외부 엔진의 라이선스와 고지 의무는
[`docs/licenses/`](docs/licenses/)에 정리되어 있습니다.
