# Implementation Plan: HWP/HWPX + DOCX 통합 편집기

Date: 2026-11-03
Spec: [spec.md](./spec.md)
Status: 구현 진행 중. 이번 변경은 문서 정합성 교정과 성능 조사이며 제품 수용이나 T010 재개 승인이 아니다.

## Summary

`geul`은 RHWP와 WordCraft의 문서 엔진을 독립적으로 사용하면서 Tauri/React 통합 UI를 구현한다. 외관만 제공하는 목업도, 두 엔진을 새로 만드는 프로젝트도 아니다. 기본 편집·안전 저장에 필요한 연결과 실제 수용 검증을 우선한다.

현재 구현·작업 상태는 [tasks.md](./tasks.md), T010의 제품 활성화 판정은 [단일 수용 행렬](../architecture/rhwp-undo-redo.md#t010-current-status)을 따른다.

### 기록 보존과 정정 범위

기준 소스는 `8d3f21a2b4aed80c070a6ad874db479365e96caf`다. 수정 전 계획 전문은 [plan.snapshot-8d3f21a.md](./plan.snapshot-8d3f21a.md)에 Git blob `ef96a2c1ce4860851577d62ba16f03288d3a98b6` 그대로 보존한다. 이 보관본은 별도의 활성 계획이 아니다. 기존 세부 인터페이스·불변식·테스트 계약은 이 문서에서 정정한 상태 설명을 제외하고 보존되며, 구현 변경 시 함께 대조한다. 보관본의 날짜별 ‘현재’, ‘미착수’, PASS는 당시 신원에 한정한다.

이번 정정은 다음을 명확히 한다. T006 시점의 ‘엔진 연결 없음’은 이후 전체 제품의 상태가 아니다. Linux 파일 대화상자·새 DOCX·다른 이름으로 저장과 복구 UI는 구현되어 있다. WordCraft 표면은 egui를 임베딩하는 방식이 아니라 native Rust raster+hit-test를 Tauri IPC로 연결하는 W-A다. 공통 명령·DOCX 서식/Undo의 부분 구현과 T010 전체 승인을 구분한다. HWPX의 빈 hp:t 후속 보완은 더 이상 미착수 후보가 아니다.

## Technical Context

- UI는 React/TypeScript, host는 Tauri/Rust, 번역 기준은 `src/language/en.json`과 `ko.json`이다. 설치 버전은 lockfile과 실제 실행 보고서에 묶고 과거 환경 목록을 현재 설치 상태로 단정하지 않는다.
- RHWP gitlink는 `1a76570e833917d15817415a53c09ad61ab3203f`, WordCraft는 `fc41918814f62645b6746ed68e71e8c2c2e85d6f`다.
- RHWP는 gitlink 외에도 `patches/rhwp/`와 `scripts/rhwp-patches.py`의 패치 계열이 산출물 신원에 포함된다. 같은 gitlink라도 source tree·패치·WASM generation/hash가 다르면 같은 검증 대상이 아니다.
- `tests/`는 공개 저장소에 모든 테스트가 있다는 뜻이 아니다. 로컬 테스트 루트와 공개된 재현 진입점 `scripts/`를 구분한다. 경로와 공개 정책은 [보안 정책](../development/security-policy.md)을 따른다.

## Constitution Check

계획 기준본은 기존대로 spec.md, plan.md, tasks.md 세 파일이다. 새 계획 프레임워크를 설치하지 않는다. 보관본과 architecture 문서는 이 세 기준본이 참조하는 기록·세부 계약이다. 원래 FR/SC ID, 작업 ID, 완료 체크, 선행 조건, 안전 저장·보안 조건은 유지한다. 이번 문서 검토는 사용자 로컬 작업 트리·설치 도구·훅을 검사한 것으로 간주하지 않는다.

## Architecture

Tauri host → React 6영역 UI → 공통 명령/세션 투영 → 형식별 편집 표면 → 독립 엔진의 순서다. Rust SessionRegistry가 세션 신원의 권한 있는 기록이며 프런트엔드 목록은 투영이다. RHWP는 WASM 모델과 Canvas 표면, WordCraft W-A는 native 모델·raster·hit-test 경로를 사용한다. 모델/selection/history를 엔진 사이에 공유하지 않는다.

문서 상태 UI는 엔진의 관측 가능한 상태를 표시한다. 지원되지 않는 속성을 임의로 추정해 제공하지 않는다. dirty와 아직 보존되지 않은 입력/비동기 변경은 동일한 개념으로 합치지 않는다.

## Data Flow

1. 확장자·헤더 판별 후 엔진 배정과 세션 생성. 판별 성공은 엔진 열기 성공이 아니다.
2. 세션·세대·revision에 묶인 편집/렌더 결과만 현재 화면에 반영. stale 응답을 폐기한다.
3. 저장 전 보존 검사 → 검증된 출력 → 원본 충돌 확인 → 안전 게시 → 해당 revision의 동기화 상태 반영. unsafe 출력은 그대로 차단한다.
4. 복구 후보는 원본 덮어쓰기와 분리한다. 게시 여부, 내구성 확인, 세션 등록 여부를 각각 다룬다.

## Interfaces

실제 앱 계약은 `src/adapters/`, `src/commands/`, `src-tauri/src/document/`, `src-tauri/src/services/`가 정의한다. 과거 계획의 개념적 EditorAdapter 인터페이스를 외부 엔진의 실재 API로 사용하지 않는다. WordCraft의 구현 표면은 W-A이며 T008 검증 문구도 이에 맞춘다. 신규 성능 문서의 Frame/epoch/lease 이름은 제안이지 현재 API가 아니다.

## Algorithms and Invariants

- 설정은 기존 버전 검사·충돌 감지·fallback 계약을 유지한다. localStorage의 프로세스 간 원자성 한계를 해결된 것으로 표시하지 않는다.
- 안전 저장은 사전 검사 결과를 완화해 호환성 비율을 올리는 방식으로 수정하지 않는다. HWP preview 재생성·HWPX 패치의 허용 범위는 [저장 보존 계약](../architecture/save-preservation.md)을 따른다.
- RHWP 렌더링은 FULL_PAGE_ONLY다. 바뀐 쪽은 기존 full render로 그리고, 검증된 동일 입력/geometry/bitmap 조건에서만 기존 생략 규칙을 사용한다. GPU partial-band 최적화를 재활성화하지 않는다.
- 복구의 잠금·세대·fsync·소유권 계약은 보존한다. 성공한 rename이나 process 종료만으로 내구성·메모리 해제를 증명하지 않는다.
- 성능 설계는 [T010 상세 조사](../architecture/t010-performance-followup-2026-11-03.md)를 따른다. 이 문서는 조사 근거와 검증할 가설이며 구현 승인이나 50ms 달성 증명이 아니다.

## Error Handling

미지원 명령은 실행 전에 차단한다. 저장 거부·충돌·엔진 실패·복구 후보 오류를 성공으로 표시하지 않는다. 비동기 응답이 오래된 세션에 속하면 채택하지 않는다. 캐시 신원이나 비교가 불확실하면 UNKNOWN으로 처리하고 원래 전체 계산/전체 그리기를 사용한다. 기존 오류 우선순위와 원본 보존 조건을 바꾸지 않는다.

## Project Structure

관측 경로: `src/`, `src-tauri/`, `src/language/`, `src/commands/`, `external/`, `patches/rhwp/`, `scripts/`, `docs/`. 고급 리본·출시 체크리스트 등 tasks의 미착수 경로는 구현 목표이며 존재나 완성을 보증하지 않는다. `tests/`의 로컬 배치 및 비공개 fixture 정책은 보안 정책을 따른다.

## Testing and Verification Strategy

T007과 T008은 T006 이후 독립적으로 수용을 검토한다. 현재 제품 신원에 매핑된 원래 표면 PoC·IME·선택·커서·표·렌더 증거를 모으고, 없는 조건만 구분해 검증한다. Windows/macOS 전체 출시는 T016 책임이며, 기존 표면 계약이 추가한 환경 의무를 이번 편집으로 삭제하지 않는다. 의무 중복/충돌은 명시적인 범위 결정 전까지 미해결로 남긴다.

T009는 두 표면의 선행 조건과 대표 문서 SC-002를 함께 확인한다. T014는 T009에 의존하며 T010에 직접 의존하지 않는다. 공통 리본 T011의 T010 의존성은 유지한다. 코드 일부가 있다는 이유로 후속 전체 작업을 완료 처리하지 않는다.

검증 신원은 geul SHA, 두 gitlink, RHWP 패치/source tree, WASM generation/hash, 실행 앱·frontend, fixture, OS/runtime·DPR·IME, producer/evaluator를 함께 기록한다. 과거 PASS를 최신 산출물 전체 PASS로 자동 승계하지 않는다. 이번 작업의 native/빌드/공식 D1–D5 실행은 NOT RUN이다.

## Risks and Tradeoffs

과도한 호환성 확장과 T010 반복 실험이 기본 수용 마감을 대신하지 않게 한다. 안전한 거절은 지원 범위의 일부이지 검사 완화의 이유가 아니다. 작업의 구현, 제한된 검증, 전체 수용, 제품 활성화를 분리한다. 보안 CI의 성공과 기본 브랜치 필수 검사 강제는 서로 다른 증거다.

## Requirement Coverage

아래 표의 Verify는 요구되는 검증이며 이번 문서 작업의 실행 결과가 아니다.

| Requirement | Design | Tasks | Verification |
|---|---|---|---|
| FR-001 | 6영역 UI | T004 | 실제 UI·패널 검사 |
| FR-002 | locale·설정 | T005 | fallback·변경·재시작 복원 |
| FR-003 | 엔진 고정·라이선스 | T017, T001, T002 | gitlink·API·NOTICE |
| FR-004 | 독립 세션·어댑터 | T006 | 판별·세션 격리 |
| FR-005 | 두 편집 표면 | T003, T007, T008 | 원래 PoC·IME·커서·표·렌더 |
| FR-006 | 안전 저장 | T009, T014 | 정상 왕복·거절·원본 보존 |
| FR-007 | 공통 명령 | T010 | 두 엔진 명령·미지원 차단 |
| FR-008 | 리본 연결 | T011 | 형식·선택별 capability |
| FR-009 | 고급 기능 | T012, T013 | 실제 API와 왕복 |
| FR-010 | 충돌·복구 | T014 | 강제 실패·원본·복구 상태 |
| FR-011 | 회귀·다중 OS | T015, T016 | 형식 행렬·세 OS·PDF |
| FR-012 | 계획 기준본 | T017 | 세 기준본·기록 구분 |
| FR-013 | 민감정보 검사 | T018, T019 | 양성·음성·공개 게이트 |
| FR-014 | 다중 보안·대응 | T019, T020 | 훅·CI·정책·대응 |
| FR-015 | 변환 제외 | T009, T011 | 원본 형식·지원 기능 |
| SC-001 | UI 수용 | T004, T005 | 실제 UI·설정 복원 |
| SC-002 | 대표 문서 수용 | T007, T008, T009, T015 | IME→저장→재열기·구조 |
| SC-003 | 명령 수용 | T010, T011 | 실제 서식·Undo·미지원 |
| SC-004 | 실패 안전성 | T014, T015 | 실패·충돌·복구 |
| SC-005 | 출시 수용 | T016 | 세 OS 실행·PDF·고지 |
| SC-006 | 엔진·계획 신원 | T017 | gitlink·기준본·중복 방지 |
| SC-007 | 검사기 수용 | T018 | 누출 차단·허용·마스킹 |
| SC-008 | 공개 절차 수용 | T019, T020 | 필수 검사·사고 대응 |

## Handoff

다음 구현은 T007/T008의 남은 필수 조건과 실행 신원 정합화부터 선정한다. 이 문서 교정은 T010 구현 보류를 해제하거나 T011을 시작하라는 지시가 아니다. 자세한 과거 계약과 실패 기록은 보관본 및 architecture 원문을 참조하며 그대로 보존한다.
