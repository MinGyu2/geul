# external/

외부 문서 엔진을 Git submodule로 관리하는 디렉터리입니다. 이 디렉터리의 엔진 소스는 직접 수정하지
않습니다. 필요한 대응은 `src/adapters/`, `src-tauri/src/adapters/` 같은 앱 쪽 어댑터에서 처리합니다.

## 고정 버전

| 경로 | 업스트림 | 고정 커밋 | 태그 | 라이선스 | 검토일 |
|------|----------|-----------|------|----------|--------|
| `external/wordcraft/` | https://github.com/storytold/wordcraft.git | `fc41918814f62645b6746ed68e71e8c2c2e85d6f` | `v0.7.0` (2026-10-14 릴리스) | MIT OR Apache-2.0 | 2026-10-16 |
| `external/rhwp/` | https://github.com/edwardkim/rhwp.git | `1a76570e833917d15817415a53c09ad61ab3203f` | `v0.8.7` (2026-10-06 릴리스) | MIT | 2026-10-16 |

- 두 커밋 모두 이동 브랜치(`main`)가 아니라 업스트림 정식 릴리스 태그가 가리키는 커밋입니다.
- `.gitmodules`의 `shallow = true`는 얕은 복제를 권장한다는 뜻입니다. 고정 커밋은 부모 저장소의
  gitlink(모드 `160000`)가 결정합니다.
- 용량(2026-10-16 측정, 얕은 복제 기준): WordCraft 작업 트리 약 32 MB, rhwp 작업 트리 약 8.7 GB
  (그중 Git 객체 약 3.3 GB, `pdf/`·`mydocs/`·`samples/`가 대부분). 디스크 여유를 확인하고 받으세요.
- 상세 검토: [`docs/upstream/wordcraft.md`](../docs/upstream/wordcraft.md),
  [`docs/upstream/rhwp.md`](../docs/upstream/rhwp.md). 라이선스 고지:
  [`docs/licenses/`](../docs/licenses/).

## 받기와 확인

```sh
git submodule update --init --depth 1
git submodule status          # 각 줄의 SHA가 위 표와 같아야 합니다
git ls-tree HEAD external/    # 160000 commit <sha> 항목이 두 개여야 합니다
```

SHA 앞에 `-`가 붙으면 아직 받지 않은 상태, `+`가 붙으면 체크아웃이 고정 커밋과 다른 상태입니다.
빈 디렉터리는 설치된 의존성이 아닙니다.

## 고정 버전 갱신 절차

1. 업스트림 릴리스 노트, 라이선스, NOTICE/서드파티 고지 변경을 확인합니다.
2. 새 커밋을 받습니다.

   ```sh
   git -C external/rhwp fetch --depth 1 origin tag <tag>
   git -C external/rhwp checkout --detach <tag>
   ```

3. 위 표, `docs/upstream/*.md`, `docs/licenses/*.md`를 함께 갱신합니다.
4. 어댑터 빌드와 관련 테스트를 다시 실행한 뒤 `git add external/rhwp`로 gitlink를 커밋합니다.

이동 브랜치를 자동으로 따라가도록(`branch = main` 후 `--remote`) 설정하지 않습니다.
