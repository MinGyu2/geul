# Stage 3-B Safety-Blocked Object Editing Acceptance (2026-11-20)

- **기준 커밋 (`HEAD`)**: `41f0b075e721674e6fd0f0134801bbd35fb0855f`
- **적용 커밋**:
  - Stage B1: `08109a1c07983513c2e6a86d1638be77d81427f4` (`fix(stage3b): preserve combined HWP object edits`)
  - Stage B2: `4096acc` (`fix(stage3b): safely delete owned HWP objects`)
  - Stage B3: `a735b17` (`feat(stage3b): support proven structured object transfers`)
  - 네이티브/T010 교정: `0be8877` (`fix(stage3b): align HWPX caption offsets and T010 drawText save gate`)
- **RHWP Release WASM 세대**: `92b8135be4772ec7247a7208a252c1e3126bfbec9d620bf75ed12e03c4a8074f` (`rhwp_bg.wasm`: `f745d40020ed362537ff545c285919fa8607fb8f6b5ba21c5fd2faadb8a5c914`)
- **Linux X11 Release 앱 SHA-256**: `9921a5a641ab36e8d15a928c2a5e3fe706f6552b440cf93f78c3cc5572cc1681`
- **Submodule 상태**: `external/rhwp` (`1a76570e833917d15817415a53c09ad61ab3203f`), `external/wordcraft` (`b2c974369dd02d322a5498db484bcf96906dad15`) 모두 clean

이 문서는 원래 Stage 3-B 수용 당시의 범위와 실행 결과를 기록한다. B3.1의 동일 문서 HWP5 구조 복제 및 B3.2의 HWPX 교차 문서 지원은 앞선 P4/C11의 거부 범위보다 좁은 승인 조건을 새로 정의했다. Historical behavior at the time; superseded within the documented Stage 3-B supported subset.

현재 B3.2는 실선·무윤곽 구분, 문단 정렬과 전체 문자 서식 범위, 명시 글꼴의 7개 언어별 참조를 확인한다. 실패 시 개체와 글꼴 등록을 함께 되돌린다. 새 Linux X11 B3-2 실행 및 저장·재열기 증거는 [후속 검증](stage3-b-clipboard-fidelity-followup-2026-11-20.json)에 별도로 기록했다.

## 당시 지원 및 거부 경계 요약

| 항목 | 수용 범위 | 계속 거부되는 범위 |
|---|---|---|
| **B1.1** | SAFE Section0 비잠금 본문 기본 도형(공유 배치 유형, 고유 초기 순위)의 한 저장 내 다중 `zOrder` 변경, Undo/Redo 및 재열기 일치 | 잠긴 형제, 혼합 개체 유형, 비고유 초기 순위, 비-`zOrder` 기하/앵커 변조 |
| **B1.2** | SAFE Section0 비잠금 그림/기본 도형(글상자 제외)의 1–64문단 캡션(`atno` 보존) 편집 + 외곽 서식 결합 저장 | 캡션 포함 도형 `outlineWidth`, 캡션 포함 그림 위치 프리셋, 글상자+캡션 중첩, Stage 3-C 서쪽/북쪽 핸들 |
| **B2.1** | SAFE Section0 비잠금 캡션 포함 그림/기본 도형 삭제(캡션 커서 복구, 형제 캡션 및 공유 `BinData` 보존) | 잠긴 개체, 캡션 포함 글상자, 미소유 `LIST_HEADER`·`atno` 불일치 |
| **B2.2** | `groupFlatDeletable=true` 평면 HWP5 그룹(비잠금, 캡션 없음, 평문 리프 도형·유효 본문 `Picture` 자식) 삭제 | 중첩 `Group`, `Chart`/`Ole`/외부 그림 자식, 잠금/캡션 포함 그룹 및 자식 |
| **B3.1** | 동일 문서 HWP5 본문 그림·기본 도형·평문 글상자·평면 그룹 복사/잘라내기/붙여넣기 | 교차 문서 HWP5 붙여넣기, 교차 형식 변환, 잠금/OLE/차트/비평면 그룹, 예약 표식 폴백 |
| **B3.2** | HWPX 교차 문서 휴대용 붙여넣기: `Picture`(<=8 MiB MIME/매직바이트 검증), `Rect`/`Ellipse`/`Line`(단색/무채우기, 실선/없음, 선택적 캡션), `TextBox`(1–64문단 정렬/서식 run) | 교차 문서 `Group`, `Polygon`/`Curve`, 그라데이션/그림 채우기, 내부 컨트롤, 위조 MIME/매직바이트, 예약 표식 폴백, DOCX 간 변환 |

## 당시 검증 요약

- `npm run typecheck`: **PASS**
- `python3 -m unittest scripts/tests/test_rhwp_profiles.py`: **3/3 PASS**
- Vitest 단위 (`pictureProperties.test.ts`, `objectClipboard.test.ts`, `clipboard.test.ts`): **65/65 PASS**
- Vitest Stage 3 WASM (`rhwpAssets` 12 + `stage3-hwpx-clipboard-safety` 7 + `stage3-object-edit` 14 + `stage3-shapes` 27 + `stage3-picture-size` 4 + `stage3-chart-inspection` 7): **71/71 PASS**
- Rust `cargo test services::save`: **302 PASS / 0 FAIL / 54 ignored**
- Rust Release T009 `--ignored` 실파일 검증 (`b1`, `b2`, `b3`): **4/4 PASS**
- 격리 Linux X11/Xvfb Release GUI (`native-stage3-b.py` under `native-ibus-session.py`): **6/6 PASS** (`B1-1`, `B1-2`, `B2-1`, `B2-2`, `B3-1`, `B3-2`; 세션 정리 `proven: true`, `filesystemProven: true`)
