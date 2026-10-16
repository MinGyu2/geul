# geul

HWP/HWPX와 DOCX를 함께 다루는 오픈소스 데스크톱 워드프로세서 프로젝트입니다.

> 상태: 초기 기반 구축 단계입니다. 아직 앱 코드(`src/`, `src-tauri/`)는 없으며, 문서 열기·편집·저장
> 기능은 구현되지 않았습니다. 진행 상황은 [`docs/planning/tasks.md`](docs/planning/tasks.md)를 기준으로 합니다.

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

## 공개 저장소 보안 검사

이 저장소는 공개를 전제로 합니다. 커밋 전에 민감정보 검사를 반드시 활성화하세요.

```sh
# pre-commit 설치 (예: uv tool install pre-commit 또는 pipx install pre-commit)
pre-commit install
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
