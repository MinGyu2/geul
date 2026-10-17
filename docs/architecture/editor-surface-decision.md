# 편집 표면 통합 방식과 PoC 게이트 (T003)

- 상태: 결정(PoC 전 후보 선정). PoC 결과에 따라 갱신합니다.
- 날짜: 2026-10-16
- 관련: FR-004, FR-005, SC-002, [plan.md](../planning/plan.md),
  [WordCraft 검토](../upstream/wordcraft.md), [rhwp 검토](../upstream/rhwp.md)
- 근거 수준: 업스트림 소스 정적 검토(L1/L2)만 수행했습니다. 아래 후보는 아직 빌드·실행하지 않았습니다.

## 배경

중앙 편집 영역은 React UI 안에 있어야 하고(6영역 레이아웃), 두 엔진은 모델·렌더·Undo를 각자 소유해야
합니다(FR-004). 두 엔진은 프런트엔드 연결 방식이 다릅니다.

| | rhwp | WordCraft |
|---|------|-----------|
| JS API | 있음 (`wasm_api.rs`, 467개 내보내기) | 없음 (egui 앱 전체를 WASM으로 띄우는 `wordcraft-web`만 있음) |
| 네이티브 API | `DocumentCore` (열기·내보내기·페이지 트리) | `Session`, `DocLayout::hit/caret`, `render_page` |
| IME 선행 구현 | `rhwp-studio` (DOM composition 이벤트) | `wordcraft-ui-egui` (egui IME 이벤트) |
| 렌더 출력 | Canvas2D/CanvasKit/SVG/HTML | CPU 래스터(PNG 등) |

## 결정

엔진마다 다른 편집 표면을 쓰되, React `Editor` 컴포넌트가 공통 계약(plan.md의 `EditorAdapter`)으로 감쌉니다.

### rhwp (HWP/HWPX)

- **1순위 R-A: WebView 안의 rhwp WASM.** `external/rhwp`를 wasm-pack으로 빌드한 모듈을 프런트엔드에서
  로드하고 `renderPageToCanvas`/`renderPageSvg`, `hitTest`, `getCursorRect`, `insertText`를 직접 호출합니다.
  파일 읽기·쓰기는 Tauri 백엔드가 맡고 바이트만 주고받습니다. 저장은 `export*WithReport` 결과를 백엔드의
  안전 저장(T014)으로 넘깁니다.
  - 이유: 편집·IME·커서 처리가 가장 많이 다듬어진 경로이며, 키 입력마다 IPC 왕복이 없습니다.
  - 위험: WebKitGTK의 WASM 성능, WebView가 죽으면 저장 안 된 편집 손실, 문서 모델이 백엔드에서 보이지 않음.
- 2순위 R-B: Tauri 백엔드의 네이티브 `DocumentCore` + 페이지 SVG/레이어 트리를 IPC로 전달.

### WordCraft (DOCX)

- **1순위 W-A: Tauri 백엔드의 네이티브 엔진.** `src-tauri`가 `wordcraft-engine`을 path 의존성으로 링크하고
  `Session`을 보유합니다. 페이지는 `render_page` → PNG 바이트로 보내고, 커서·선택·IME 조합 문자열은
  React 오버레이가 `hit`/`caret` 좌표로 그립니다. 확정된 문자열만 `Session::run`으로 보냅니다.
  - 이유: JS API가 없고, 엔진이 UI(egui)와 분리되어 있어 네이티브 링크가 가장 단순합니다.
  - 위험: 키 입력마다 IPC 왕복과 페이지 재래스터 비용, 고배율 선명도.
- 2순위 W-B: 앱 저장소 안에 얇은 wasm-bindgen 래퍼 크레이트를 만들어 엔진+렌더를 WASM으로 빌드하고 WebView에서
  호출(`wordcraft-web`이 엔진의 wasm32 빌드 가능성을 보여 줌). 업스트림 소스는 수정하지 않습니다.

### 채택하지 않는 방식

- `wordcraft-web`(eframe 캔버스)을 그대로 끼워 넣기: 자체 리본 UI 전체를 함께 띄우며 WebGPU/WebGL2 지원이
  WebView마다 다릅니다.
- 별도 egui 네이티브 창: 6영역 단일 창 구조를 깨고 IME를 두 곳에서 처리하게 됩니다.
- 두 엔진 문서 모델을 하나로 합치기(FR-004 위반).

## PoC 실행 경로

PoC 코드는 실제 앱 위치에 둡니다(별도 PoC 저장소 없음). 업스트림 소스는 수정하지 않고, 빌드 산출물이
submodule 안에 생기지 않도록 `CARGO_TARGET_DIR`과 wasm-pack `--out-dir`을 submodule 밖으로 지정합니다.

| 단계 | 작업 | 위치 | 통과 기준 |
|------|------|------|-----------|
| P0 (L3) | 두 엔진 빌드 확인: `src-tauri`에서 `wordcraft-engine`, `rhwp` path 의존성 `cargo check`; `wasm-pack build external/rhwp --target web` | `src-tauri/`, 빌드 출력은 `/target/`(무시 대상) | 경고 외 오류 없음, 업스트림 수정 없음 |
| P1 (T007) | rhwp R-A: 픽스처 열기 → 렌더 → 클릭 hit test → 한글 입력 → 저장 → 재열기 | `src/components/Editor/`, `tests/integration/rhwp/` | 아래 측정 항목 |
| P2 (T008) | WordCraft W-A: 같은 시나리오 | `src-tauri/src/adapters/`, `tests/integration/wordcraft/` | 아래 측정 항목 |

측정 항목(형식별로 기록, Linux WebKitGTK 우선, Windows/macOS는 T016):

1. 렌더: 10쪽 이하 픽스처의 첫 페이지 표시 시간, 100%/200% 배율 선명도
2. 한국어 IME: 두벌식으로 "한글 입력 테스트" 입력 시 조합 중 표시, 확정 1회 삽입(중복·누락 없음),
   조합 중 클릭/화살표 이동 시 동작
3. 마우스: 본문·표 셀에서 클릭한 글자 경계에 커서, 드래그 선택 범위
4. 키보드: 화살표, Home/End, Shift 선택, Backspace/Delete, Enter, 표에서 Tab 이동
5. 응답성: 키 입력부터 화면 반영까지 지연(p95)
6. 저장·재열기: 입력한 텍스트 유지, 손실 보고서(rhwp `*WithReport`) 내용, 원본 대비 구조 비교

## PoC 중단 조건 (FR-005 게이트)

다음 중 하나라도 해당하면 T010 이후 고급 UI 작업을 확대하지 않고, 결과를 이 문서에 기록한 뒤 계획을
다시 정합니다.

- 1순위와 2순위 후보 모두에서 IME 확정 문자가 중복·누락되거나, hit test가 클릭한 글자에서 1글자 넘게
  어긋나는 경우
- 최적화 후에도 키 입력 지연 p95가 150 ms를 넘는 경우
- 기본 열기·편집·저장에 업스트림 소스 수정이 필요한 경우(업스트림 기여 또는 포크 여부를 따로 결정)
- 픽스처 저장 결과에 손실 보고가 있거나 재열기 비교가 다를 때 원인을 설명할 수 없는 경우
  → 해당 형식은 읽기 전용 또는 저장 차단으로 처리(FR-006)
- 같은 장애에 진전 없는 수정을 두 번 반복한 경우(tasks.md 실행 정책)

## 테스트 데이터

[tests/fixtures/README.md](../../tests/fixtures/README.md)의 정책을 따릅니다. PoC 최소 픽스처는
형식별 기본 문서(한·영 문단, 굵게, 2×2 표)와 오류 사례(확장자-헤더 불일치, 잘린 파일, 암호화 문서)입니다.

## T007 결과: rhwp R-A PoC (2026-10-17)

- 상태: **부분 통과**. R-A(WebView 안의 rhwp WASM)로 열기·렌더·커서·선택·키보드·revision 확정·메모리 내보내기 검사가
  실제 앱(Linux WebKitGTK 2.54)에서 동작하고 측정 기준을 넘었다. 한국어 IME는 확정 문자 1회 삽입은 확인했지만, 시험
  환경에서 조합 중 글자(preedit)가 페이지에 전달되지 않아 조합 표시와 "조합 중 클릭"은 통과하지 못했다(아래). R-B로
  바꿀 근거는 아니다(같은 WebView 입력 경로를 쓴다). 저장은 막아 둔다(T009/T014).
- 빌드: `scripts/build-rhwp-wasm.sh`가 고정 커밋을 `wasm-pack --target web --release -- --locked`로 빌드한다(Rust 1.99,
  wasm-bindgen 0.2.127 = rhwp Cargo.lock 판, 약 17분, `rhwp_bg.wasm` 11.6 MB). 산출물은 `public/rhwp/`(Git 무시), cargo
  산출물은 `target/rhwp-wasm/`. 빌드 전후 submodule 작업 트리가 같은지 확인한다. 앱은 실행할 때 같은 출처 URL로 불러오므로
  CI(submodule 없음)의 타입 검사·테스트·프런트엔드 빌드는 산출물 없이 된다. 산출물이 없거나 초기화에 실패하면
  `EngineFailure(init)`으로 실패를 보인다.
- CSP: `script-src`에 `'wasm-unsafe-eval'`(WebAssembly 컴파일만, `'unsafe-eval'` 아님), `connect-src`에 `'self'`(같은
  출처의 `.wasm` 가져오기)만 더했다. 새 Tauri 플러그인·파일 시스템 권한은 없다.

### 설계 검토에서 정한 것

| 문제 | 근거 | 결정(구현) | 검증 |
|------|------|------------|------|
| A. 문서 모델(WASM)과 revision 권한(백엔드)이 둘 | T006 계약: revision은 백엔드 기록. R-A 모델은 WebView에 있음(미결정으로 넘어옴) | revision 권한은 백엔드 하나. 세션마다 하나뿐인 편집 세션(`RhwpEditorSession`)이 WASM을 바꾼 뒤 `document_commit(sessionId, baseRevision, count)`로 알림. 확정은 한 번에 하나, 기다리는 동안의 변경은 다음 확정에 묶음 → 순서 뒤바뀜·중복 없음. 기준이 다르면 백엔드가 `RevisionMismatch`로 거부하고 편집기는 세션을 failed로(조용한 분기 없음). 렌더·선택·실패한 변경은 확정 안 함. IME 조합은 끝날 때 1회. `SessionInfo.sequence`(기록 변경 횟수)로 늦게 온 응답을 버림 | Rust `t007` 5개·`commands` 3개, Vitest 편집 세션 14개, 실제 앱: 변경 키만 revision 증가, 옛·앞선 기준 거부, 다른 쓰는 쪽 확정 뒤 failed, 탭 전환 중 다른 세션 확정 |
| B. 판별과 불러오기 사이 파일 교체(TOCTOU)·경로 바꿔치기 | T006은 판별만, 이후 바이트 공급 경로 없음 | `document_load(sessionId)`: 경로 인자 없음. 세션의 정규화 경로만 다시 열어 장치·inode·크기·수정 시각을 판별 때와 비교하고, 읽은 바이트를 다시 판별해 형식이 같을 때만 그 바이트(원시 응답)를 WASM에 넘김. 다르면 `FileChanged`. 같은 동시 판별 상한·파일 크기 상한 | Rust: 덧붙임·끝 레코드 손상·inode 교체·삭제. 실제 앱: 바뀐 파일 다시 불러오기 `FileChanged`. 한계: 같은 크기·시각으로 바뀌었지만 여전히 같은 형식인 내용은 그 새 바이트를 씀(검사한 바이트만 넘김은 유지) |
| C. 세션 수명주기 | T006은 `identified`만 | `identified → loading → ready / failed`, `ready → failed`, `failed → loading`. 불러오기 명령이 끝나기 전에 버려지면 failed로(가드). 불러오는 중 닫으면 늦은 응답이 `StaleSession`이라 되살아나지 않음. WebView가 다시 시작되면 앱이 남은 loading·ready 세션을 failed로 돌림 | Rust·Vitest, 실제 앱: 확정 대기 중 닫기, 엔진 실패 문서 → 닫고 다른 문서 열기, WebView 재시작 |
| D. 좌표 | rhwp 페이지 좌표 = 배율 1 CSS px(`getPageInfo` 793.7×1122.5 = A4) | 그리기·hit test·커서가 한 변환만 씀: 페이지 상자 = 크기 × z, canvas 비트맵 = × z × devicePixelRatio, 마우스 = (client − canvas 사각형) ÷ z. 본문·셀 API 선택은 `rhwpText.ts` 한 곳 | 100%/200% canvas 해상도, 본문·셀 클릭 편차 측정 |
| E. IME·키 | `rhwp-studio` input-handler-text.ts 조합 모델 | 숨긴 textarea 하나(커서 위치, React가 다시 만들지 않음). 조합 중 입력마다 조합 범위 교체, 끝에 1회 확정, 직후 같은 글자 입력 무시. 실측으로 고친 것: WebKitGTK+ibus는 compositionstart 없이 input(isComposing)과 compositionend만 보냄 → 그 자리에서 조합 시작. Shift+Tab은 key "Unidentified"/code "Tab". 커서 위 textarea가 클릭을 가로챔 → pointer-events 없음. 표 마지막 셀의 Tab이 편집 영역 밖으로 초점을 옮김 → 표 안 Tab은 항상 소비 | 아래 IME 표 |
| F. 저장 경계 | 저장은 T009/T014 | 앱에 쓰기 명령 없음. "내보내기 검사"는 메모리에서 `export*WithReport` → 다시 열기 → 쪽 수·`getTextFileText`·`getControls` 비교만 함. 원본을 덮어쓰는 경로 없음 | 실제 앱 검사, Node로 임시 디렉터리에 내보내 다시 열기 |
| H. HWP와 HWPX | 같은 API라도 직렬화가 다름 | 모든 측정을 형식별로 따로 함 | 아래 표 |

### 측정(Linux, 헤드리스 weston 15 + WebKitGTK 2.54, 개발 빌드 앱 + 릴리스 WASM)

픽스처는 `tests/fixtures/rhwp/generate.mjs`가 rhwp API로 만든 한·영 문단, 굵게, 2×2 표 문서(1쪽)다. 실행 방법은
`tests/integration/rhwp/rhwp_poc.py`(전체 56개 검사 통과).

| 항목 | HWP | HWPX |
|------|-----|------|
| 불러오기·렌더 | ready, 실제 내용 렌더 | ready, 실제 내용 렌더 |
| 첫 페이지 표시 | 727 ms(그 실행의 첫 문서, WASM 컴파일 포함) | 30 ms(모듈 준비 뒤) |
| 100%/200% | canvas 794×1123 / 1588×2245(= CSS 크기 × DPR 1) | 같음 |
| hit test(본문 12글자·셀 4글자, 경계 사이 30%/70% 실제 포인터 클릭 32회) | 최대 편차 0글자(32/32 정확) | 같음 |
| 드래그 선택·Shift 선택·Home/End·↑↓·Backspace/Delete·Enter·문단 합치기·표 Tab/Shift+Tab·셀 입력 | 통과 | 통과 |
| 키 입력→화면 반영 p95(85회, 입력 이벤트 → 다시 그림 → 두 번째 frame) | 35 ms(최대 44) | 40 ms(최대 41) |
| 메모리 내보내기 → 다시 열기(편집 뒤) | 손실 보고 0, 쪽·텍스트·컨트롤 같음 | 같음 |
| 파일로 내보내기(Node, 임시 디렉터리) → 다시 열기 → 앱에서 열기 | 손실 0, 편집 결과·굵게 유지, 앱에서 ready | 같음 |

응답 시간은 개발 빌드(디버그 Rust 호스트) 측정이며 릴리스 빌드·Windows/macOS는 측정하지 않았다(T016).

### 한국어 IME(실제 ibus-hangul 1.5.5 두벌식, Xvfb X11 + xdotool로 실제 키 입력)

| 항목 | 결과 |
|------|------|
| "한글 입력 테스트"(gksrmf dlqfur xptmxm) 확정 | HWP·HWPX 모두 커서 위치에 정확히 1번(중복·누락 없음), 음절·공백마다 revision 1 |
| 조합 중 ← | 남은 음절을 그 자리에 확정한 뒤 이동(통과) |
| 조합 중 표시(preedit) | **미검증/실패**: WebView가 compositionstart·compositionupdate를 보내지 않아 조합 중 음절이 확정 전까지 보이지 않음(이벤트 0개). ibus 설정(event forwarding 끔, sync mode)을 바꿔도 같음 |
| 조합 중 클릭 | **실패(환경)**: 기본 비동기 모드에서 조합 중이던 음절이 사라짐, sync mode에서는 클릭한 새 위치에 확정됨. 페이지가 조합 중 글자를 받지 못하므로 앱에서 보정할 수 없음 |

원인(WebKitGTK의 IM 문맥이 preedit을 받지 않는 것인지, 패널 없는 헤드리스 X 환경 때문인지)은 이 환경에서 가리지 못했다.
실제 데스크톱(ibus/fcitx5 + 패널)에서 같은 시나리오를 다시 재야 한다(`rhwp_poc.py --ime`). 이것이 확인되기 전에는
FR-005 IME 게이트를 통과로 보지 않는다.

### 그 밖에 확인한 엔진 동작

- 판별(T006)을 통과해도 rhwp가 열지 못하는 문서가 있다(깨진 header.xml) → `EngineFailure(parse)`로 실패 표시.
- 반대로 rhwp는 section0.xml이 XML로 깨진 HWPX를 오류 없이 **빈 문서**로 연다. 이런 문서를 편집·저장하면 내용이 사라질
  수 있으므로 T009 저장 판단(왕복 비교·손실 보고)에서 다뤄야 한다.
- 실행 취소(Undo)는 PoC 범위 밖이다(rhwp-studio는 프런트엔드 history.ts를 씀).
