# Implementation Plan: HWP/HWPX + DOCX 통합 편집기

Date: 2026-11-04
Spec: [spec.md](./spec.md)
Source baseline: `4bc1ac986026ccadb2d673a66ad69e6296e3a39e` (`MinGyu2/geul`, master).
Status: T007–T010 △ 조건부 완료, T011 완료(2026-11-04, native IME 포함 검증 — [tasks.md](./tasks.md) Verification Log). 신규 생성은 설계 단계이며 실제 실행 수용은 NOT RUN.

## Summary

RHWP와 WordCraft의 독립 모델·렌더·기록을 Tauri/React UI로 연결한다. 검증된 Linux 기본 기능을 재구현하지 않고 T011 리본 작업으로 진행한다. 새 문서는 형식 선택 후 해당 엔진에서 생성하며, 최초 단계는 기존 DOCX처럼 경로를 먼저 선택한다. 제목 없음 문서는 선택적 후속 단계다.

이번 사용자 승인으로 바뀌는 것은 작업 진행 정책과 신규 생성 범위다. D2/D4 실패·미검증, RHWP 제품 명령 차단, 원본 보존, 시험·보안 의무를 삭제하지 않는다. 기술 수용 근거는 [RHWP history 계약](../architecture/rhwp-undo-redo.md#t010-current-status), 관리 상태는 [tasks.md](./tasks.md)의 2026-11-04 결정을 따른다. 해당 architecture 문서의 과거 T011 착수 불허만 이번 결정으로 대체한다.

기존 상세 설계·실행 이력은 [plan.snapshot-8d3f21a.md](./plan.snapshot-8d3f21a.md) 및 architecture 문서에 유지한다. 보관본은 별도 활성 계획이 아니다. 이번 수정 직전 원문은 위 기준 커밋의 Git 이력에 남는다. 과거 시점의 ‘현재’, PASS, 미착수는 당시 범위로 읽는다.

## Technical Context

- UI: React/TypeScript. host: Tauri 2/Rust. locale: `src/language/en.json`, `ko.json`.
- RHWP pin: `1a76570e833917d15817415a53c09ad61ab3203f`. WordCraft pin: `fc41918814f62645b6746ed68e71e8c2c2e85d6f`.
- RHWP 실행 신원은 pin뿐 아니라 `patches/rhwp/`, `scripts/rhwp-patches.py`의 순서 있는 패치, source tree, JS/WASM generation/hash를 포함한다. 기준 코드의 계열은 11개 패치다.
- RHWP 모델·Canvas는 WebView WASM, WordCraft 모델·raster·hit-test는 Rust native W-A다. WordCraft egui UI 임베딩이 아니다.
- `tests/`는 로컬 논리 경로다. 비공개 자료와 공개 스크립트를 구분하고 [보안 정책](../development/security-policy.md)을 유지한다. 이번 작업에서 로컬 geul-tests·설치 도구·훅을 실행한 것으로 간주하지 않는다.

## Constitution Check

프로젝트 기준본은 spec.md, plan.md, tasks.md다. 원래 요구·안전 정책과 이번 사용자 승인 범위를 대조했다. 새로운 Spec Kit 초기화나 자동 재생성은 하지 않는다. 원격 기준 트리에서 루트 AGENTS.md 또는 .specify를 확인한 근거는 없으며, 사용자 로컬의 별도 지침·작업 트리·설치 상태 확인은 DEFERRED다. 문서 구조 검사 성공을 구현 준비 환경이나 제품 수용 PASS로 사용하지 않는다.

## Architecture

Tauri host → React 6영역 UI → 공통 명령/세션 투영 → 형식별 표면 → 독립 엔진 구조를 유지한다. Rust SessionRegistry가 세션 신원의 권한 있는 기록이며 UI 목록은 투영이다. 문서 모델·선택·기록을 엔진 사이에 공유하지 않는다.

T011은 기존 registry/capability/execute 경계를 재사용한다. visible은 문서 형식과 선택 문맥으로, enabled는 실제 엔진 지원·ready·IME·모달·저장·pending 상태로 정한다. 관측할 수 없는 표/그림 선택을 임의로 만들어 상황 탭을 켜지 않는다. 리본·단축키가 같은 실행 직전 재검사를 사용한다. RHWP history/format 시험 플래그를 제품 기능으로 켜지 않는다.

새 문서 구조와 검증의 상세 계약은 [new-document-creation.md](../architecture/new-document-creation.md)에 둔다. 이는 기준본의 보조 설계이며 별도 활성 작업 계획이 아니다.

## Data Flow

기존 문서: 내용 기반 형식 판별·확장자 대조 → 세션 등록 → 해당 엔진 모델/표면 준비 → 편집 → 보존/충돌 검증 → 안전 게시 → 저장 revision 반영. 판별 성공, 엔진 parse 성공, 화면 표시 완료는 각각 다르다.

신규 문서 1차 목표:

```text
new request + operation ticket
 -> format selection (docx / hwp / hwpx)
 -> native destination selection; cancel ends without creation
 -> fresh engine-owned blank candidate
 -> requested-format export + independent reopen + structural validation
 -> create-only stage / readback / publish
 -> publication durability result + session registration
 -> normal engine load / actual first paint
 -> focus only if same active session and operation still owns focus
 -> edit and save through the existing same-format save path
```

생성 파일을 등록했다고 편집기 ready가 된 것은 아니다. 현재 Workspace의 load는 후속 비동기 작업이다. 뒤늦은 완료가 사용자가 이동한 다른 탭의 포커스를 빼앗지 않게 한다.

## Interfaces

현재 `document_new(path)`·`FilePort.createDocx(path)`·`DocumentWorkspace.newDocx()`는 DOCX 전용이다. `RhwpModule`은 openDocument와 선택적 memoryBytes만 노출하고 생성 API를 연결하지 않았다. 구현 때 요청 형식·경로·작업 소유권·응답의 실제 형식/엔진·등록/내구 상태를 명시적으로 검증하는 계약으로 확장한다. 이 문서의 단계 이름은 설명용이며 현재 존재하는 새 IPC API가 아니다.

RHWP는 WASM에 있으므로 files.rs에 직접 Rust RHWP 생성을 추가하는 것으로 가정하지 않는다. 우선 동일 검증 generation의 좁은 WASM 생성 어댑터와 Rust 검증·게시 경계를 검토한다. 프런트엔드가 보낸 safe=true, 손실 보고, ‘빈 문서’ 표지만 믿어 쓰는 범용 파일 저장 IPC를 만들지 않는다. 백엔드가 입증할 수 있는 검증 범위와 입증하지 못하는 의미적 속성을 T021에서 구분한다.

RHWP `createEmpty()`는 정적 팩터리지만 시험/미리보기용 최소 구조다. `createBlankDocument()`는 기존 객체를 수정하는 인스턴스 메서드이며 새 문서 객체 대신 상태 JSON을 반환한다. fresh 임시 객체에만 사용하고 현재 편집 문서의 내용을 초기화하지 않는다. 내장 HWP 템플릿에서 HWPX 바이트를 만들더라도 최종 출력 형식으로 다시 열어 원본 형식과 후속 저장 경로를 맞춘다.

## Algorithms and Invariants

### 기존 정책

설정 버전·원문 충돌·fallback, 세션/세대/revision 소유권, 불확실 모델의 편집 차단을 유지한다. RHWP 제품은 FULL_PAGE_ONLY이며 검증되지 않은 partial-band를 되살리지 않는다. 저장 보존 비교를 완화해 호환성 수를 늘리지 않는다. 잠금·fsync·복구 소유권과 게시 후 실패 의미를 유지한다. T010 최적화 가설은 [기존 조사](../architecture/t010-performance-followup-2026-11-03.md)의 DESIGN ONLY 상태다.

### 신규 생성 검증

1. 선택한 형식과 사용 가능한 생성 capability를 확정한다. 미지원 형식은 이유를 보이고 실행하지 않는다.
2. 사용자 문서와 독립된 후보를 생성하고 요청 형식으로 export한다. 엔진 객체·export 결과는 모든 종료 경로에서 해제한다.
3. 출력 서명, 컨테이너 필수 구조, 크기/개수 제한, 참조, 유효한 손실 보고를 확인한다. 원본이 없으므로 기존 보존 preflight만으로 생성 유효성을 입증하지 않는다.
4. 별도 모델로 재열기해 기대 빈 구조·쪽/문단·텍스트·컨트롤·기본 스타일/글꼴 참조를 확인한다. 같은 바이트 두 번 비교는 의미 검증이 아니다. 엔진 roundtrip 외 독립 구조 검사와 음성 대조군을 둔다.
5. HWP 미리보기 등 안전한 정규화가 필요하면 기존 승인 범위만 적용하고, 최종 게시할 바이트를 다시 검증한다. 원시 export와 실제 게시본을 혼동하지 않는다.
6. 최종 바이트를 stage_new/readback/publish_new 계약으로 게시한다. 존재 확인 후 일반 rename으로 대체하지 않고 create-only 원자적 충돌 방지를 유지한다.
7. 게시 파일을 식별·등록하고 일반 엔진 load로 연결한다. 등록/로드 실패 후 이미 게시한 파일을 무조건 지우지 않는다.
8. 실제 입력·저장·재저장·재열기가 성공해야 해당 형식을 신규 생성 지원으로 표시한다.

중복 클릭은 file-operation 직렬화와 ticket으로 다루며 UI 버튼 비활성만 믿지 않는다. 취소가 게시 이전인지 이후인지 구분한다. 큰 임시 buffer/model을 중복 보유하는 최고 메모리와 자원 정리도 검사한다.

## Error Handling

취소, 검증 실패, 충돌, 게시 실패, 게시됐지만 내구성 미확인, 게시됐지만 등록 실패, 등록됐지만 엔진 로드 실패를 구분한다. 기존 파일 불변은 유지하되 새 파일이 이미 게시된 이후 ‘아무것도 쓰지 않음’이라고 표시하지 않는다. 재시도 때 존재 파일을 덮어쓰거나 삭제하지 않고 실제 상태를 확인한다.

현 DOCX의 `FilePublishedUnregistered`는 실제 오류다. 제품에 없는 세분화된 응답 형태는 설계 제안으로만 적고 구현 전 의미를 확정한다. 경로·본문·메타데이터 원문을 공개 로그에 남기지 않는다. 백엔드 권한, 파일 시스템 제한, 손실 검사, CSP를 편의를 위해 넓히지 않는다.

## Project Structure

관측된 수정 후보: `src/App.tsx`, `src/components/Editor/Editor.tsx`, `documentWorkspace.ts`, `filePort.ts`, `rhwp/rhwpModule.ts`, `src-tauri/src/services/files.rs`, `src-tauri/src/services/save/`, `src-tauri/src/document/`, `src/language/`. 실제 변경 파일은 구현 전 영향 분석으로 한정한다. 생성 기능이 모든 파일 수정을 요구하는 것은 아니다.

기존 `src/commands/`, `src/ribbon/`, `src/components/Ribbon/`은 T011에서 재사용한다. 새 테스트 경로 `tests/integration/new-document/`는 계획 경로이며 이번에 존재/실행한다고 주장하지 않는다. 고급 리본·품질/출시 문서의 미착수 경로도 목표 경로다.

## Testing and Verification Strategy

기존 PASS는 해당 소스·앱·패치·WASM·fixture·runtime에 귀속한다. 관련 입력이 불변이면 명시적 영향 검토로 재사용하고, 변경 경계만 집중 재검증한다. 모든 HEAD 변경이 전체 시험 반복을 요구하지도, 같은 pin이 모든 근거 재사용을 허용하지도 않는다.

T007/T008의 추가 환경은 T016에서 관리하지만 현재 지원 경로의 발견된 결함은 원래 작업에서 고친다. T009의 대표 지원 문서 수용과 전체 코퍼스 호환성을 분리한다. T010 D2·D4 재시험을 T011·신규 생성의 무조건적인 선행으로 삼지 않는다. 다만 변경된 공통 IME/Workspace/명령 경계는 두 엔진을 함께 회귀 검사한다.

T021은 현재 Release에서 API·출력·템플릿·검증 경계를 확인한다. T022는 형식 선택·안전 생성·UI/포커스를 구현하며 집중 시험한다. T023은 세 형식의 실제 native 신규 편집·저장·재저장과 실패/경합을 수용한다. T024는 별도 승인한 경우만 pathless 모델·첫 저장·복구를 확장한다.

성공 시험: 한국어·영문·줄 나누기/합치기·삭제·커서·선택·취소 후 정상 입력, 각 형식의 첫 생성/후속 저장/재저장, 동일 형식 Save As, 닫기·재열기. 지원하지 않는 표 삽입·서식·Undo를 시험 때문에 켜지 않는다.

실패 시험: 기존 대상/심볼릭 링크·확장자 불일치·권한·공간 부족·손상 출력·손실 보고·참조·내보내기·stage/readback/fsync·게시/등록/로드 경계·취소·연타·탭/닫기·늦은 응답. 시험이 0개 발견되거나 필수 fixture가 없으면 PASS로 세지 않는다. 같은 엔진 roundtrip 성공은 외부 한글/Word 상호운용 검증과 별도로 보고한다.

## Risks and Tradeoffs

첫 단계 경로 선선택은 기존 세션·저장 정책을 재사용해 변경 범위를 줄인다. 제목 없음 UX는 경로·원본 신원·dirty·복구·첫 저장 전후 전이를 바꾸므로 선택적 T024로 분리한다. HWP와 HWPX가 같은 엔진을 쓰더라도 생성·저장은 각각 검증한다. 템플릿 자산의 출처·재배포 조건·메타데이터는 엔진 라이선스와 별도 점검한다.

이 문서에서 새 HWP/HWPX 생성 성공이나 D4 해결을 주장하지 않는다. T010 자원 미결론을 없앤 것도 아니다. 새 경로에서 발견한 실제 자원 누수/원본 훼손은 보류 목록에 숨기지 않고 해당 기능을 차단한다.

## Requirement Coverage

Verification은 필요한 검사이며 이번 제품 실행 결과가 아니다.

| Requirement | Design | Tasks | Verification |
|---|---|---|---|
| FR-001 | 6영역 UI | T004 | 실제 UI·패널 |
| FR-002 | locale·설정 | T005 | fallback·변경·복원 |
| FR-003 | 고정 엔진·고지 | T017, T001, T002 | gitlink·API·NOTICE |
| FR-004 | 독립 세션 | T006 | 판별·소유권 |
| FR-005 | 두 표면 | T003, T007, T008 | PoC·IME·커서·표 |
| FR-006 | 안전 저장 | T009, T014 | 왕복·거절·원본 |
| FR-007 | 명령 경계 | T010 | 실제 명령·미지원 |
| FR-008 | 공통 리본 | T011 | 형식/선택별 capability |
| FR-009 | 검증된 고급 기능 | T012, T013 | API·왕복 |
| FR-010 | 충돌·복구 | T014 | 실패·복원 |
| FR-011 | 품질·플랫폼 | T015, T016 | 행렬·OS·PDF |
| FR-012 | 세 기준본 | T017 | ID·근거 보존 |
| FR-013 | 공개 전 검사 | T018, T019 | 누출·게이트 |
| FR-014 | 다중 보안·대응 | T019, T020 | 훅·CI·사고 절차 |
| FR-015 | 변환 제외 | T009, T011, T022 | 형식 일관성 |
| FR-016 | 형식별 신규 UI | T022, T023 | 선택·취소·native 생성 |
| FR-017 | 생성·검증·재열기 | T021, T022, T023 | 구조·손실·편집 왕복 |
| FR-018 | create-only·소유권 | T022, T023 | 충돌·게시·경합 |
| FR-019 | 선택적 미저장 UX | T024 | 별도 승인 후 첫 저장·복구 |
| SC-001 | UI 수용 | T004, T005 | 실제 UI·설정 |
| SC-002 | 대표 문서 수용 | T007, T008, T009, T015 | 기존 문서 IME→저장→재열기 |
| SC-003 | 명령 수용 | T010, T011 | 서식·Undo·거절 |
| SC-004 | 실패 안전 | T014, T015 | 원본·오류·복구 |
| SC-005 | 출시 | T016 | 세 OS·PDF·고지 |
| SC-006 | 고정 구조 | T017 | gitlink·기준본 |
| SC-007 | 검사기 | T018 | 검출·허용·마스킹 |
| SC-008 | 공개 절차 | T019, T020 | 필수 검사·대응 |
| SC-009 | 신규 생성 수용 | T021, T022, T023, T015 | 세 형식 생성·입력·재저장 |
| SC-010 | 신규 생성 실패 | T022, T023, T015 | 오류·충돌·경합·거짓 성공 없음 |
| SC-011 | 선택적 첫 저장 수용 | T024 | 별도 승인 후 pathless 왕복 |

## Handoff

T011을 다음 개발 대상으로 삼는다. 착수 시 현재 코드/환경과 기존 명령 가용성부터 확인하고 사용자 기능을 구현한다. T021–T023은 신규 생성의 별도 작업 계열이며 T010 성능 해결을 기다리지 않는다. 공유 Workspace·registry·locale 파일을 동시에 수정하는 경우 담당 범위를 조정한다.

기존 task ID와 9개 완료 체크를 보존하고 새 ID는 T021부터 사용한다. T015에 T023을 연결해 새로 제공할 생성 기능도 품질 행렬에 포함한다. 선택적 T024는 출시 선행으로 추가하지 않는다. 실행 환경의 별도 지침·훅·테스트 루트를 먼저 확인하며, 제품 실행과 문서 구조 검사를 구분해 보고한다.
