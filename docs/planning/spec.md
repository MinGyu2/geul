# Feature Specification: HWP/HWPX + DOCX 통합 오픈소스 워드프로세서

> **2026-11-11 Linux native GUI + IBus Phase 5: COMPLETED.** 새 스키마의 실제 X11/Xvfb·IBus 인수 111개와 최종 집계가 통과했다(과거 시나리오 재사용 0). [실행 신원·검증 범위](../architecture/phase5-native-gui-ibus-closure-2026-11-11.json), [증거 재사용 계약](tasks.md#linux-native-guiibus-인수-증거-계약--2026-11-11). 이 사용자 지정 단계는 계획의 T012/T013 고급 기능 Phase 5와 구분한다. T014/T015/T016 및 기존 미완료 조건, 물리 데스크톱·Wayland·Word/Hancom NOT RUN은 유지한다.

Created: 2026-10-13
Updated: 2026-11-09
Status: 구현 진행 중. T007–T009 △ 조건부 범위 인정, T011은 기록된 범위에서 완료. T021–T023 신규 생성·연결·X11/IBus 수용 완료(추가 플랫폼 NOT RUN). T010은 INCOMPLETE(D2 INCONCLUSIVE, D4 latency FAIL/resources INCONCLUSIVE), T012/T013은 △ 조건부 미완료. WordCraft remote reproducibility는 `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5` 게시·fresh checkout PASS. Word/Hancom 외부 호환성은 NOT RUN.
Source baseline: `4bc1ac986026ccadb2d673a66ad69e6296e3a39e` (`MinGyu2/geul`, master).
Input: WordCraft + RHWP 독립 코어, Tauri/React 신규 UI, 6개 영역, 언어별 JSON, 공개 저장소 민감정보 사전 차단. 2026-11-04 사용자가 T007–T010의 잔여 사유 기록 및 T011 진행, DOCX/HWP/HWPX 신규 생성 계획 반영을 승인했다.


## 현재 최종 검증 — 2026-11-09

세 패키지를 요청된 순서 B→C→A로 검증했다. WordCraft UI 포커스 교정과 전체 CI PASS, 지정 개발 브랜치의 정상 fast-forward 게시와 독립 fetch, 공개 geul SHA의 얕은 submodule 초기화, geul Rust 및 실제 native HWP 저장 회귀를 완료했다. unknown 원본 record가 내보내기 중 사라져도 빈 미리보기 저장이 거부되도록 geul HWP 수정 `8bf22c1e8b042458a2e7087ad5cc879f479c7b22`를 로컬 커밋했다. geul은 push하지 않았다. 전체 실행 신원·명령·결과는 [Stage 5–7 최종 검증](../architecture/stage567-acceptance-2026-11-05.md#wordcraft-rust-hwp-final-20261109)에 있다.

| 범위 | 현재 결과 | 남은 수용 조건 |
|---|---|---|
| WordCraft UI/CI | `dc25d8a27303b35d0ef7d61e56276f7b8f3feab5`; 원래 포커스 회귀 PASS, 전체 6단계 CI PASS | 없음 — 이 UI/CI 묶음 |
| WordCraft 원격 재현성 | `geul/semantic-roundtrip-equivalence`에 non-force fast-forward 게시, exact fetch/fsck 및 공개 geul `a9609bb` fresh submodule PASS | 없음 — 이 gitlink의 재현성 |
| geul Rust/HWP | Rust fmt/check/clippy, save 163 PASS·15 ignored, WordCraft adapter 80 PASS·1 ignored, 네이티브 blank/calc 실제 두 회차 저장·재열기 PASS | T012/T013의 독립 조건, 외부 Office 호환성은 별도 |
| T010 / D2 / D4 | T010 INCOMPLETE; D2 INCONCLUSIVE; D4 latency FAIL, resources INCONCLUSIVE | 원래 기술 수용 기준 유지 |
| T012 / T013 | △ 조건부 미완료 | T012의 한컴 GUI·독립 수용 조건; T013의 Word 외부 호환성 |

이하 날짜가 붙은 절은 그 날짜에 관측한 역사 기록이며, 당시의 `BLOCKED`, `previewStale`, 실패 수치는 이 2026-11-09 판정으로 다시 쓰지 않는다.


## 2026-11-08 후속 2: 빈 첫 쪽 미리보기·WordCraft CI

**PARTIALLY COMPLETED**. 빈 첫 쪽 미리보기는 1쪽 그리기 목록과 첫 문단 구조의 두 근거로만 허용하고 실제 앱 두 회차 저장으로 확인했다. WordCraft 직접 파일 접근을 승인된 관문으로 옮겨 정책 시험은 통과하지만, 전체 CI는 기존 UI 시험 1건으로 FAIL이다. T010/T012/T013/D2/D4, WordCraft 원격 BLOCKED, Word/Hancom NOT RUN은 그대로. [기록](../architecture/stage567-acceptance-2026-11-05.md#blank-preview-wc-ci-20261108).

## 2026-11-08 후속: HWP 미리보기·한컴 수식 서식·추적 TOC 경계

결과는 **PARTIALLY COMPLETED**다. 한컴 HWP의 `PrvText`/`PrvImage`는 다시 연 내보내기의 1쪽 렌더로 재생성·검증되어, 이전에 `previewStale`로 막히던 `calc-cell.hwp` 편집이 실제 앱에서 두 차례 durable 저장·재열기되었다(비동기 그림이 1쪽에 있으면 기존 거부 유지). 한컴 고정소수 수식 결과 서식(`%.Nf`)을 인정해 다중 수식 표를 제품 명령으로 편집할 수 있다. WordCraft는 문단을 넘는 책갈피 경계를 보존하고 TOC 대상 제거 시 같은 명령 안에서 TOC를 다시 만든다. T012/T013은 계속 △ 조건부 미완료, WordCraft 원격 재현성 BLOCKED, Word/Hancom NOT RUN, T010/D2/D4 변경 없음. [기록](../architecture/stage567-acceptance-2026-11-05.md#preview-tables-toc-20261108).

이전 기록: 아래 2026-11-08 절은 이 후속 전의 상태다.

## 2026-11-08 T012/T013 상호운용 후속

결과는 **PARTIALLY COMPLETED**다. T012의 병합 셀·일부 다중 문단 표 수식 편집은 실제 Release WASM과 HWP/HWPX 두 차례 저장·재열기로 확인했지만, `calc-cell.hwp`의 `PrvText`/`PrvImage`는 편집 후 오래된 상태로 검출되어 실제 저장이 계속 안전 거부된다. T013은 선택된 추적 TOC 책갈피 수락·거절·갱신 경계를 보정하고 실제 DOCX 두 차례 저장·재열기를 확인했지만, WordCraft 원격 재현성은 BLOCKED, Microsoft Word 호환성은 NOT RUN이다. T010 INCOMPLETE, T012/T013 △ 조건부 미완료, D2 INCONCLUSIVE, D4 지연 FAIL/자원 INCONCLUSIVE 상태를 유지한다. 상세 검증·해시·남은 범위는 [2026-11-08 기록](../architecture/stage567-acceptance-2026-11-05.md#interoperability-repair-20261108)을 따른다.

<a id="conditional-advanced-20261106"></a>

## 2026-11-06 T012/T013 조건부 개발 결정

사용자는 T010 D2/D4가 미완료인 동안 T012/T013 개발을 계속하고, 독립적으로 검증한 좁은 T012 제품 명령 경로를 활성화하는 작업을 명시적으로 승인했다. 이에 영향을 받는 선행 조건은 **△ 조건부 보류/미완료**다. 기존의 “D2/D4 완료 전 제품 고급 기능 작업 불허” 계획 정책은 이 범위에서 대체한다. 이는 시험 통과나 전체 출시 승인이 아니다.

| 항목 | 기술 결과 | 관리/개발 결정 |
|---|---|---|
| D2 native IME 순서 | **INCONCLUSIVE** | △ 조건부 보류. 원래 E→U→F predicate 유지 |
| D4 큰 문서 지연 | **FAIL** | △ 조건부 보류. 기존 50 ms 문턱·측정 끝점 유지 |
| D4 자원/메모리 | **INCONCLUSIVE** | 회계·자원 검사를 유지, 전체 성능 READY 아님 |
| T010 | **INCOMPLETE** | 일반 RHWP 입력 history/Undo 활성화는 계속 NO-GO |
| T012 | △ 조건부 미완료 — 지원 부분집합 제품 활성화 | 고급 명령 전용 history와 보존·실제 제품 UI를 별도로 검증한 부분집합만 조건부 활성화. 한컴 외부 수용 미실행, 미리보기 있는 한컴 HWP 저장 거부로 전체 미완료 |
| T013 | △ 조건부 미완료 — 선택 내부 혼합 수용 완료 | WordCraft 원격 재현성 BLOCKED, Word 외부 호환성 NOT RUN으로 전체 미완료 |

구현 완료, 지원 부분집합 검증, 제품 명령 노출, 조건부 수용, 전체 T010/T012 수용은 서로 다른 상태다. 제품을 시험 훅으로 빌드해서 활성화하지 않는다. 일반 입력과 분리된 고급 명령 history는 불러온 원본 128 KiB 이하·현재 8쪽 이하, 최대 4단계에 한정한다. 다른 편집은 고급 기록을 폐기하고, 조합/최종 입력 대기·revision 확정 대기·낡은 세션 요청·필수 API/기록 실패는 거부한다. 장평 50–200, 자간 -50–50의 정수/7언어 표현과 수식 길이 256·깊이 16·셀 방문 4096 제한 및 T009 검사는 유지한다. 이 숫자 제한은 D4 합격을 보증하는 새 기준이 아니다.

지원 부분집합의 실제 제품 UI·일반 빌드 검증을 마치고 제품 명령을 조건부로 켰다. 결과와 신원은 [통합 수용 기록](../architecture/stage567-acceptance-2026-11-05.md)에 갱신한다. 아래 날짜별 이전 NO-GO/PASS/FAIL 기록은 당시 결과로 보존한다.

최신 2026-11-06 후속에서는 간접 순환 안전 거부(`f18233ddd321e52cc2b4f99c32e1ce5f7e63a2fe`)와 native Linux GTK 하단 페이지/스크롤바 경계 교정(`9dbd68c5433578c2ddf9989a6c273ced0ca02e1b`)을 구현·검증했다. native 검증은 명시적 non-overlay 스크롤바 경계를 확인하며, 기존 y=751 클릭을 페이지로 전달하지 않는다. T010 INCOMPLETE, T012/T013 △ 조건부 미완료, D2 INCONCLUSIVE, D4 FAIL/자원 INCONCLUSIVE, WordCraft 원격 재현성 BLOCKED, Word/Hancom NOT RUN은 유지한다. [상세 결과](../architecture/stage567-acceptance-2026-11-05.md#cycle-pointer-repair-20261106).

이전 조사 기록: 2026-11-06 소규모 신뢰성 후속은 **PARTIALLY COMPLETED**다. Safari 수식 lookbehind 제거와 LOG10 검증 순서 수정은 완료했고, 같은 세션 reload 중 열린 수식 입력창의 stale 거부를 App·Release WASM으로 직접 검증했다. 간접 순환의 캐시 값 변동과 WebKitGTK 하단 overlay 스크롤바 입력 영역의 클릭 누락은 재현됐으나 미수정이다. Safari 13 실제 실행은 NOT RUN이다. [상세 결과](../architecture/stage567-acceptance-2026-11-05.md#reliability-small-20261106)를 따른다. T010 INCOMPLETE, T012/T013 △ conditionally incomplete 및 기존 D2/D4·외부 수용 상태는 유지한다.

> **2026-11-05 Stage 5–7 재검증:** Stage 5–7과 T012/T013은 부분 완료 상태다. 실제 Release WASM·13개 패치·controlled typed formula 연결과 수식 저장 검증을 마쳤지만, D2 25 PASS/2 INCONCLUSIVE(E→U→F 미관측), D4 원래 기준 6 PASS/2 FAIL 때문에 제품 RHWP history·장평/자간·영속 수식은 NO-GO다. 현재 native 완료 범위, 두 차례 저장의 6게시·2안전 거부, DOCX 표식 교정 뒤 native10개 통과 상태, Word/Hancom NOT RUN은 [통합 수용 보고서](../architecture/stage567-acceptance-2026-11-05.md)를 따른다. 이 기록은 기존 요구사항이나 acceptance threshold를 바꾸지 않는다.

## Delivery Decision — 2026-11-04

`△ 조건부 완료`는 검증된 개발 범위를 인정하고 명시한 후속 개발을 허용하는 관리 상태다. 전체 수용 PASS, 미검증 환경의 지원 선언, 제품 명령 활성화, 출시 승인이 아니다. 기존 FR-001–FR-015와 SC-001–SC-008은 유지하고, 신규 생성 요구를 FR-016–FR-019와 SC-009–SC-011로 추가한다.

T007/T008의 기본 근거는 Linux X11/Xvfb + IBus + WebKitGTK의 기록된 구성에 한정한다. T009는 대표 지원 문서 왕복과 안전 거절 근거를 인정한다. 최신 앱·WASM 변경 영향은 해당 작업의 회귀로 남기고, GPU 데스크톱·Wayland·fcitx5·다른 OS·추가 부하/초점 조합은 T016의 환경 수용 목록으로 추적한다. Linux라는 이름만 같다고 환경을 동일시하지 않는다.

T010의 D2 특수 native 순서는 INCONCLUSIVE, D4 지연은 FAIL, 자원·메모리는 INCONCLUSIVE로 남긴다. 두 조사를 현재 개발의 우선순위에서 보류하되 PASS로 바꾸지 않는다. RHWP 제품 Undo/Redo·시험 전용 서식의 활성화도 승인하지 않는다. D1은 마지막 공식 PASS 범위, D3/D5는 2026-11-04 재검증 범위를 따른다.

T011은 검증된 공통 명령 기반을 사용한 리본 구성·형식/선택별 표시·지원 명령 연결·미지원 사유 안내부터 진행한다. FR-005의 실제 기본 편집 결함은 여전히 해당 기능의 확대를 막는다. 미실행 확장 환경이나 보류한 D2/D4만으로 안전한 UI 작업 전체를 중단하지 않는다. T012/T013의 새 변형 명령은 각각 실제 API·저장·기록 안전성을 검증한 뒤에만 노출한다.

작업 상태와 착수 정책은 이 결정 및 [tasks.md](./tasks.md)가 기준이다. architecture 문서의 과거 `T011 NOT STARTED/착수 불허` 관리 문구는 이번 결정으로 대체되지만, 기술적 FAIL·INCONCLUSIVE·제품 NO-GO와 측정 계약은 그대로 유효하다. 상세 생성 계약은 [new-document-creation.md](../architecture/new-document-creation.md)를 따른다.

## User Scenarios & Testing

### User Story 1 - 기본 UI와 다국어 (Priority: P1)
사용자로서 독립 UI 시작과 언어·패널 변경을 수행할 수 있어야 한다.
Independent Test: 실행 중 언어 전환과 재실행 시 값 복원
Acceptance Scenarios:
1. Given 지원되는 입력과 정상 환경, When 독립 UI 시작과 언어·패널 변경을 요청하면, Then 실행 중 언어 전환과 재실행 시 값 복원 결과가 확인된다.
2. Given 실패/미지원/충돌 조건, When 같은 동작을 요청하면, Then 데이터 유실 또는 정보 노출 없이 거절되고 사용자가 이유를 확인할 수 있다.

### User Story 2 - HWP/HWPX/DOCX 기본 편집 (Priority: P1)
사용자로서 세 가지 형식에서 문서 열기·입력·저장·재열기를 수행할 수 있어야 한다.
Independent Test: 형식별 왕복 검사 또는 명시적인 읽기 전용 차단
Acceptance Scenarios:
1. Given 지원되는 입력과 정상 환경, When 열기·입력·저장·재열기를 요청하면, Then 형식별 왕복 검사 또는 명시적인 읽기 전용 차단 결과가 확인된다.
2. Given 실패/미지원/충돌 조건, When 같은 동작을 요청하면, Then 데이터 유실 또는 정보 노출 없이 거절되고 사용자가 이유를 확인할 수 있다.

### User Story 3 - 공통 명령과 리본 (Priority: P1)
사용자로서 문서 형식에 맞는 서식 명령을 실행할 수 있어야 한다.
Independent Test: 명령 상태·선택 영역 반영 및 미지원 실행 차단
Acceptance Scenarios:
1. Given 지원되는 입력과 정상 환경, When 문서 형식에 맞는 서식 명령을 실행하면, Then 명령 상태와 선택 영역 반영이 확인된다.
2. Given 미지원 명령 또는 조합/모달/세션 변경 등 차단 상태, When 리본이나 단축키로 실행하면, Then 문서를 변경하지 않고 사유를 표시한다.

### User Story 4 - 형식별 고급 기능 (Priority: P2)
사용자로서 형식별로 검증된 고급 기능을 수행할 수 있어야 한다.
Independent Test: 실제 API 지원 명령만 활성화
Acceptance Scenarios:
1. Given 지원되는 입력과 정상 환경, When 고급 기능을 요청하면, Then 실제 API와 문서 왕복을 검증한 명령만 실행된다.
2. Given 실패/미지원/충돌 조건, When 같은 동작을 요청하면, Then 데이터 유실 또는 정보 노출 없이 거절되고 이유를 확인할 수 있다.

### User Story 5 - 데이터 보존 및 출시 (Priority: P1)
사용자로서 저장 실패에 보호되고 배포 환경별 검증 결과를 확인할 수 있어야 한다.
Independent Test: 원본 보존·회귀 검사 및 OS별 증거
Acceptance Scenarios:
1. Given 지원되는 문서와 정상 환경, When 저장 또는 출시 검증을 수행하면, Then 원본 보존·회귀 검사 및 OS별 증거가 기록된다.
2. Given 실패/미지원/충돌 조건, When 저장을 요청하면, Then 게시 전후 실제 상태를 구분하고 오류 및 복구 상태를 정확히 알린다.

### User Story 6 - 공개 저장소 보안 (Priority: P1)
사용자로서 공개하기 전 변경 내용 검사를 수행할 수 있어야 한다.
Independent Test: 로컬 테스트 누출 차단 및 PR 검사 정책 확인
Acceptance Scenarios:
1. Given 공개할 변경, When 검사를 수행하면, Then 로컬 누출 차단과 PR 검사 정책의 결과가 확인된다.
2. Given 민감정보 또는 검사 불능 조건, When 공개를 시도하면, Then 성공으로 처리하지 않고 원문 비밀을 로그에 노출하지 않는다.

### User Story 7 - 형식별 새 문서 (Priority: P1)
사용자로서 새 문서 또는 Ctrl+N에서 DOCX/HWP/HWPX를 선택하고, 선택 형식의 문서를 생성해 즉시 편집·저장할 수 있어야 한다.
Independent Test: 형식별 신규 생성 → 실제 한국어 입력·기본 편집 → 저장 → 추가 편집·재저장 → 닫기·재열기 → 내용·구조 비교
Acceptance Scenarios:
1. Given 생성이 검증된 형식, When 형식과 새 파일 경로를 선택하면, Then 해당 형식의 문서가 안전하게 생성·등록되고 활성 편집기가 준비된 뒤 입력 포커스를 받는다.
2. Given 선택 취소 또는 생성 실패, When 요청이 끝나면, Then 기존 문서·입력·파일을 훼손하지 않고 거짓 성공이나 불필요한 세션을 남기지 않는다.
3. Given 이미 존재하는 대상 또는 확장자/내용 불일치, When 생성을 요청하면, Then 덮어쓰기나 암묵적 형식 변환 없이 거절한다.
4. Given 파일 게시 뒤 내구성 확인 또는 세션 등록 실패, When 결과를 표시하면, Then 파일이 존재할 수 있음을 알리고 무조건 삭제하거나 ‘아무것도 쓰지 않음’으로 보고하지 않는다.
5. Given 선택적 미저장 문서 단계가 별도로 승인·구현된 경우, When 제목 없음 문서를 편집하고 첫 저장을 취소하면, Then 모델과 미보존 입력을 유지하고 경로 없는 세션의 닫기·복구 정책을 적용한다.

### Edge Cases
- 외부 파일 변경, 디스크 공간 부족, 권한 거부, 중간 크래시, 확장자와 실제 형식 불일치.
- 미지원 그림·수식·차트·SmartArt·암호화 문서; 무조건 저장 가능하다고 표시하지 않는다.
- IME 조합 중 이동·명령·탭 전환, 복합 표 선택, 고배율, 미설치 폰트.
- 비밀값과 유사한 예제·공개 경로의 오탐은 검토형 예외로 관리한다.
- Ctrl+N 연타, 형식/경로 선택 취소, 기존 조합이 남은 상태에서 생성, 생성 중 탭/창 닫기와 늦은 응답.
- 새 문서의 필수 구조·기본 글꼴/스타일/미리보기·메타데이터, 잘못된 손실 보고, 크기·개수·시간 제한.
- 빈 파일의 왕복 성공과 실제 글자 입력 후 저장 성공을 구분한다. 같은 엔진 재열기를 외부 한글/Word 호환성 증명으로 확대하지 않는다.

## Requirements

### Functional Requirements
- FR-001: Tauri 2와 React/TypeScript로 제작하는 독립 데스크톱 앱에서 상단 바, 리본, 왼쪽 탐색, 중앙 편집기, 오른쪽 속성, 상태 표시줄의 6개 영역을 제공하고 패널 접기·크기 조절을 지원한다.
- FR-002: UI 번역 파일을 `src/language/ko.json`, `src/language/en.json`으로 분리하며 고정 키, 영어 fallback, 즉시 전환, 선택 언어 복원과 번역 키 누락 검사를 제공한다.
- FR-003: WordCraft는 `external/wordcraft/`, rhwp는 `external/rhwp/`에 독립 Git submodule로 등록하고 검토한 커밋을 부모 저장소 gitlink로 고정한다. 버전·라이선스·NOTICE 의무를 기록한다.
- FR-004: HWP/HWPX는 rhwp, DOCX는 WordCraft로 분기하고 문서별 모델·렌더링·편집 히스토리의 엔진 소유권을 독립적으로 유지한다. HOP는 코어가 아닌 참고 사례다.
- FR-005: 두 편집 표면에서 페이지 렌더링, 한국어 IME 조합, 마우스 선택, 커서 hit-test, 키보드 조작, 표 안 이동 가능성을 각기 PoC로 검증한다. 검증 실패 시 고급 기능 구현을 중단한다.
- FR-006: 지원 가능한 문서는 열기·편집·원본 형식 저장·재열기를 제공하고, 손실 우려·지원하지 않는 개체·쓰기 불가 문서는 읽기 전용으로 전환하거나 저장을 차단하며 원본을 보호한다.
- FR-007: Command Registry는 변하지 않는 명령 ID, 국제화 라벨 키, 단축키, 엔진별 capability, 선택 영역 및 상태를 통합한다. 미지원 명령은 실행되지 않는다.
- FR-008: WordCraft 스타일의 공통 리본(파일·홈·삽입·그리기·디자인·레이아웃·참조·편지·검토·보기·도움말)과 상황별 메뉴를 설계하되 실제 엔진 기능에 따라 표시/비활성화를 결정한다.
- FR-009: HWP/HWPX 전용 한글 도구(장평·자간·조판·표 계산 등)와 DOCX 고급 기능은 실제 API·문서 왕복 검증이 된 항목부터 제공한다.
- FR-010: 저장 시 문서 revision과 디스크 버전 충돌을 검사하고, 가능하면 동일 파일시스템에 임시 사본을 작성·검증·원자적 교체한다. 실패하면 원본을 보존하고 복구 사본을 별도 관리한다.
- FR-011: HWP/HWPX/DOCX 대표 샘플 및 손상·암호화·표·그림·수식·폰트·IME 회귀 테스트와 지원 플랫폼(Windows/macOS/Linux)의 실제 빌드·실행·PDF 출력 검증을 수행한다.
- FR-012: 프로젝트 전체 계획 문서는 `docs/planning/spec.md`, `docs/planning/plan.md`, `docs/planning/tasks.md`만을 기준본으로 관리한다. `src/`, `src-tauri/`, `external/`, `docs/`, `tests/`, `scripts/`를 독립적으로 배치한다.
- FR-013: 공개 저장소 커밋 전 변경 파일의 비밀키·인증정보·개인 홈 절대 경로·내부 주소·개인정보 노출을 검사하며 최초 공개 전 전체 파일과 Git 이력을 검사한다. 발견되면 기본적으로 커밋/병합을 차단하고 수동 검토 후 예외를 허용한다.
- FR-014: 공개 저장소의 로컬 훅을 우회하거나 GitHub Actions 실행 전 푸시하는 경로를 고려한다. 최초 공개 및 커밋/푸시/PR 단계의 다중 검사를 실시하고 누출된 비밀은 이력 정리만이 아니라 폐기·재발급한다.
- FR-015: 초기 버전은 HWP↔DOCX 및 HWPX↔DOCX 파일 형식 상호 변환과 공동 편집을 제공하지 않는다. PDF 내보내기는 형식 변환과 분리된 출력 기능이다.
- FR-016: 새 문서와 Ctrl+N은 DOCX/HWP/HWPX 형식 선택을 제공하고, 검증된 형식만 생성할 수 있게 한다. 기존 문서 열기·저장과 별개이며 다른 형식으로 몰래 대체하지 않는다.
- FR-017: 선택한 엔진에서 생성한 새 문서는 형식·필수 구조·손실 보고·참조 무결성과 재열기 동등성을 확인하고, 실제 편집 후 같은 형식으로 저장·재열기할 수 있어야 한다. 최초 단계는 경로 선택 후 파일 생성 방식이다.
- FR-018: 신규 생성은 create-only 게시로 기존 대상을 덮어쓰지 않는다. 게시·내구성·세션 등록 상태를 분리하고, 취소·실패·늦은 응답·중복 요청에서 세션/세대/입력 소유권을 유지한다. 검증 실패를 성공으로 표시하지 않는다.
- FR-019: 선택적 후속 기능으로 제목 없음 문서와 첫 저장 시 경로 선택을 도입할 때는 경로 없는 세션·dirty·첫 저장·재저장·복구·닫기 계약을 별도 검증한다. 이 단계는 별도 승인 전 구현하지 않으며 최초 신규 생성 및 기본 출시의 필수 선행 조건이 아니다.

## Success Criteria

### Measurable Outcomes
- SC-001: 6개 영역이 표시되고 패널 설정과 ko/en 변경이 재시작 이후 복원되는 UI 검사가 통과한다.
- SC-002: HWP/HWPX/DOCX별 최소 1개의 대표 문서에 대해 열기→IME 입력→저장→재열기 및 문서 구조 비교 결과가 기록된다. 손실이 있으면 차단/읽기 전용 처리 근거가 남는다.
- SC-003: 공통 서식 명령(예: 굵게)과 실행 취소, 미지원 명령 처리가 각각 실제 대상 엔진에서 검증된다.
- SC-004: 쓰기 중 강제 실패와 외부 수정 충돌 시 원본 바이트가 유지되고 오류 및 복구 사본 상태가 확인된다.
- SC-005: Windows/macOS/Linux 실제 환경에서 앱 시작, 샘플 파일 열기·저장, PDF 내보내기 및 라이선스 고지 점검이 완료된다.
- SC-006: 계획 문서가 `docs/planning/`에만 기준본으로 존재하고 두 submodule의 gitlink 및 고정 SHA가 확인되며 코어 중복 복사가 없다.
- SC-007: 의도적으로 만든 테스트용 비밀·개인 홈 경로가 사전 검사에 걸리고 허용되는 상대 경로와 공개 시스템 경로는 통과하며, 비밀 본문은 로그에 노출되지 않는다.
- SC-008: 최초 공개 체크리스트, 우회 위험, 누출 대응 및 PR 필수 검사 정책이 문서화되고 테스트용 누출 샘플에 대한 검사 결과가 보존된다.
- SC-009: DOCX/HWP/HWPX 각각 실제 제품 생성 경로로 새 문서를 만들고, native 한글 입력·기본 편집·저장·추가 편집·재저장·닫기·재열기에서 요청 형식과 내용·구조가 보존됨을 기록한다. 현재 앱/엔진/패치/WASM/fixture/환경 신원을 함께 남긴다.
- SC-010: 기존 대상·권한·공간 부족·잘못된 출력/참조·게시 전후 실패·등록 실패·취소·닫기/탭 경합을 시험한다. 기존 파일은 불변이며, 생성 파일의 실제 게시·내구성·등록 결과와 사용자 안내가 일치하고 누락 입력·중복 세션·거짓 성공이 없어야 한다.
- SC-011: 선택적 미저장 문서를 활성화할 때만, 경로 없는 세션의 첫 저장 성공/취소/충돌, 추가 편집 중 저장, 저장 후 재저장, 닫기 확인과 지원 범위의 복구를 검증한다. 미도입은 미실행/범위 제외로 기록하고 PASS로 바꾸지 않는다.

## Assumptions
- 엔진 README나 API 존재는 geul 제품의 입력·렌더·저장 수용을 대신하지 않는다.
- 고정 WordCraft 본체는 MIT OR Apache-2.0, RHWP 본체는 MIT라는 기존 검토를 유지한다. 실제 링크 의존성·글꼴·템플릿·배포물 고지는 별도다. 라이선스 문서 검토를 모든 번들 자산의 재배포 승인으로 읽지 않는다.
- submodule은 소스 고정 수단이며 자동 연결 수단이 아니다. RHWP는 고정 pin과 승인된 패치 계열을 함께 식별한다.
- 현재 제품 신규 생성은 T021 검증 경계와 T022 연결을 거쳐 DOCX/HWP/HWPX를 지원한다. `createEmpty()`와 템플릿 기반 `createBlankDocument()`의 차이를 검토해야 하며, HWP/HWPX 생성 경계는 2026-11-04 T021에서 실행 검증했다. 제품 연결은 T022에서 완료했으며 T023은 실제 X11/IBus에서 세 형식 생성·한글/영문 편집·2회 안전 저장·native 재열기 및 실패/경합 24개를 수용했다. [상세 신원/결과](../architecture/new-document-native-acceptance-2026-11-04.json)를 따른다.
- 기존 문서의 안전한 저장 거절은 유지한다. 이 정책이 새로 지원한다고 표시한 빈 문서의 기본 입력·저장 실패까지 정상 수용으로 인정하는 것은 아니다.

## Out of Scope
- 초기 버전의 HWP↔DOCX 및 HWPX↔DOCX 변환, 공동 편집, 클라우드 동기화.
- 문서 모델 통합, 외부 원본 UI 재배포, 신규 생성이라는 이름의 임의 기존 문서 변환.
- 이번 문서 변경에서 제품 코드·submodule·패치·WASM 변경, T011 구현, 새 생성 기능 실행, D2/D4 PASS 처리, RHWP 시험 전용 명령의 제품 활성화.

## 핵심 삽입 구현 상태 — 2026-11-10

`insert.table`, `insert.image`, `paragraph.bullets`의 DOCX/HWPX 구현과 HWP 비활성 경계, 검증 상태를 [핵심 삽입 기능 보고](../architecture/core-insertions.md)에 기록했다. Linux native GUI 수용은 NOT RUN이고 HWP 저장 보존은 미완료이므로 전체 성공 기준 완료로 취급하지 않는다.
