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
(안정화에서 좁혔다: 같은 환경의 일반 GTK3 입력란은 preedit을 보여 주므로 WebKitGTK 경로의 문제다 — 아래 "T007 안정화".)
실제 데스크톱(ibus/fcitx5 + 패널)에서 같은 시나리오를 다시 재야 한다(`rhwp_poc.py --ime`). 이것이 확인되기 전에는
FR-005 IME 게이트를 통과로 보지 않는다.

### 그 밖에 확인한 엔진 동작

- 판별(T006)을 통과해도 rhwp가 열지 못하는 문서가 있다(깨진 header.xml) → `EngineFailure(parse)`로 실패 표시.
- 반대로 rhwp는 section0.xml이 XML로 깨진 HWPX를 오류 없이 **빈 문서**로 연다. 이런 문서를 편집·저장하면 내용이 사라질
  수 있으므로 T009 저장 판단(왕복 비교·손실 보고)에서 다뤄야 한다.
- 실행 취소(Undo)는 PoC 범위 밖이다(rhwp-studio는 프런트엔드 history.ts를 씀).

## T007 안정화: 리뷰 지적 재현과 수정 (2026-10-17)

커밋 `bf4cc5e` 뒤 정적 리뷰 지적을 먼저 재현한 다음 고쳤다. 새 회귀 테스트(`src/components/Editor/rhwp/stabilization.test.tsx`
24개, Rust 1개)를 수정 전 코드에서 실행해 18개(Vitest)와 1개(Rust)가 지적한 원인으로 실패함을 확인했다. 수정 전에도 통과한
6개(WebKitGTK 순서의 같은 음절 반복, 조합 직후 Safari식 뒤따르는 입력, 이동 뒤 같은 음절, 조합 취소, 초점 잃음 뒤 다시 넣지
않음, 수정 안 한 문서 닫기)는 기존 동작이 계약에 맞는 경우로 남겼다.

| 지적 | 재현(수정 전) | 원인 | 수정 |
|------|---------------|------|------|
| IME A: 같은 글자 반복 버림 | 조합 확정 '가' 뒤 붙여넣은 '가'가 사라짐 | 직전 확정 글자와 **글자가 같으면** 다음 입력을 버림 | 표면의 입력 해석을 `imeInput.ts`(`ImeInput`)로 옮김. 버리는 것은 조합 끝 **바로 다음** 이벤트가 `insertFromComposition`·`insertCompositionText`(isComposing=false)이고 같은 글자일 때뿐. 키·다른 입력이 오면 해제 |
| IME B: 조합 하나에 끝이 여러 번 | compositionend가 두 번 오면 두 번 삽입(revision 2), 조합 중 클릭 뒤 늦은 끝이 클릭한 곳에 다시 삽입 | 조합이 없는데 온 끝을 새 조합으로 처리, 앱이 끝낸 조합과 플랫폼의 늦은 끝을 구분하지 않음 | 조합마다 끝은 한 번: 바로 앞이 끝이었으면 중복 끝 무시. 클릭 때 보이는 조합은 원래 자리에 확정하고 그 조합의 늦은 input·끝은 소비. 보이는 조합이 없으면 클릭 전 커서를 기억해 다음 키 전에 온 확정을 그 자리에 넣고(같은 문단 뒤쪽 커서는 그만큼 밈), 조합 시작·키·다른 입력이 오면 끝냄. `blur()`가 플랫폼 조합을 끝낸다고 가정하지 않음 |
| 편집 내용 확인 없이 버림 | 확정 대기 중인 문서를 닫으면 모델을 먼저 버리고 닫음, 편집한 모델 다시 불러오기도 확인 없음 | 닫기가 dirty·대기·조합을 보지 않음(백엔드 dirty는 확정 뒤에야 true) | `hasUnpreservedChanges` = 불러온 뒤 바꿈·확정 대기·확정 중·조합 중. 닫기·다시 불러오기는 `UnpreservedChanges`를 돌려주고, 화면은 확인 창(alertdialog, 처음 초점 취소, Escape 취소, Tab 순환)을 띄움. 버리기를 고른 경우에만 진행. 같은 세션 닫기를 되풀이하면 진행 중인 닫기 하나를 기다림. 닫는 동안 편집 막음, 백엔드가 닫은 뒤에 모델을 버림, 닫기 실패 시 모델 유지·편집 다시 허용. 탭의 ●는 백엔드 dirty 또는 저장 안 한 편집 |
| 불러오기 시도 분리 | (Rust) 시도 A가 끝나지 않은 채 B가 시작한 뒤 A의 취소 가드가 B를 failed로 바꿈 | 상태 전이가 상태만 검사 | 백엔드 `load_generation`(시도마다 +1). 응답 머리 8바이트, 전이·확정에 번호, 다르면 `StaleLoad`. 프런트엔드는 받은 번호로만 요청하고 응답 머리를 검사(길이·0·2^53 이상 거부). 실제 앱에서 다른 번호의 확정·전이 거부 확인 |
| 실패 순서 | 페이지 정보 API가 던지면 ready 뒤 예외, 그리기 실패가 무시됨, 변경 뒤 갱신 실패 시 변경이 세어지지 않고 예외 | ready를 페이지 정보보다 먼저 요청, 그리기 오류를 삼킴, `mutate`가 갱신 뒤에 셈 | 페이지 정보까지 얻은 뒤 ready 요청(실패 시 문서 해제·`loading → failed`, parse). 그리기 실패는 `EngineFailure(render)`로 편집 멈춤. 엔진 변경이 성공하면 바로 세고(확정 대기열) 그다음 갱신이 실패하면 render 실패로 편집 멈춤. 실패해도 확정하지 못한 변경을 지우지 않음(버리기 확인 대상) |
| 왕복 검사 | 손실 보고 1건·형식 오류여도 화면은 ✓, 편집 뒤에도 이전 결과가 남음, `takeBytes`·다시 열기 실패 때 내보낸 객체를 놓지 않음 | 손실 보고를 검사하지 않음, 결과에 판을 묶지 않음, `free`가 예외 경로 밖 | 손실 보고를 엄격히 읽음(`{count, losses[]}`, count = losses 수). `passed` = 손실 보고 올바름·0건·쪽·텍스트·컨트롤 같음. 모델을 바꾸면 결과를 지움. 모든 경로에서 `free`. `roundtrip.mjs`도 같은 규칙과 종료 코드 |
| 진단의 문서 내용 | 커서 문단 글자가 일반 빌드 DOM 속성에 있음 | 검사 편의 | `VITE_GEUL_TEST_HOOKS=1` 빌드에서만 노출(일반 빌드에서는 상수로 빠짐 — 번들 확인). 실패 화면은 편집이 저장되지 않았고 복구가 없다고 알림, 버리고 다시 불러오면 "버리고 다시 불러왔다"고만 알림 |
| IME 시험 정직성 | `--ime`가 조합 표시·조합 중 클릭을 기록만 함 | — | IME 게이트: 항목마다 PASS/FAIL/UNVERIFIED/NOT RUN, 필수 7개가 모두 PASS여야 종료 0, FAIL 1, 환경 없음 2, `--diagnostic-only`는 게이트 아님 |

### IME 게이트 실측(실제 키: Xvfb X11 + ibus 1.5.33 + ibus-hangul 1.5.5 + xdotool, WebKitGTK 2.54)

| 필수 항목 | 비동기(기본) | `IBUS_ENABLE_SYNC_MODE=1` |
|-----------|--------------|---------------------------|
| 조합 중 글자가 문서에 보임 | FAIL | FAIL |
| 조합 중 커서가 조합 글자 뒤 | FAIL | FAIL |
| 확정 글자가 정확히 한 번·누락 없음("한글 입력 테스트") | PASS | PASS |
| 확정 음절·공백마다 revision 1 | PASS | PASS |
| 같은 음절 연달아(가가) | PASS | PASS |
| 조합 중 ← | PASS | PASS |
| 조합 중 클릭 | FAIL(남은 음절 사라짐) | FAIL(남은 음절이 다음 키에서 클릭한 곳에 확정) |

결과: **IME 게이트 FAIL**(필수 7개 중 4개 PASS). 원인 분리:

- 앱의 숨긴 입력 설정 때문이 아니다: 같은 앱 안에 **보이는 일반 textarea**를 두고 같은 키를 보내도 조합 중 이벤트·값이
  없고 확정 때에만 input(isComposing)·compositionend가 온다.
- ibus·헤드리스 X 때문만도 아니다: 같은 Xvfb·ibus 설정에서 **일반 GTK3 입력란**(gtk3-widget-factory)은 조합 중 글자 '하'→'한'을
  표시한다(화면 캡처 확인, `embed-preedit-text=true`). 따라서 preedit이 WebKitGTK(WebView) 경로에서 페이지로 오지 않는다.
- 조합을 갱신하기만 하는 키는 페이지에 keydown조차 오지 않고, 확정을 일으키는 키만 keydown(key "Unidentified", keyCode 229)
  뒤에 input(isComposing, `insertFromComposition`)·compositionend가 온다. 페이지는 IME 안에 남은 음절이 있는지 알 수 없다.
- 그래서 조합 중 클릭은 앱이 바로잡을 수 없다: 클릭 뒤 이벤트가 하나도 오지 않고, 남은 음절은 sync mode에서 다음 키와 함께
  클릭한 곳에 확정되며 비동기 모드에서는 사라진다. 클릭 때마다 입력의 초점을 뺐다가 돌리는 방식도 시험했는데, sync mode에서
  그 음절이 **사라졌다**(위치가 바뀌는 것보다 나쁨). 그래서 초점은 페이지에 보이는 조합이 있을 때만 뺀다.
- 위 ImeInput 규칙(보이는 조합의 클릭 확정, 늦은 끝 소비, 클릭 전 자리의 늦은 확정)은 preedit이 오는 플랫폼의 이벤트 순서를
  재현한 Vitest로만 확인했다. 합성 이벤트는 실제 IME 검증이 아니며, preedit이 오는 실제 데스크톱(GNOME/KDE의 ibus·fcitx5,
  Windows WebView2)에서 `rhwp_poc.py --ime`로 다시 재야 한다.
- 시험 중 본 것: 앞 문서에서 클릭으로 남은 음절이 다음 문서의 첫 입력에 확정될 수 있다(sync mode, 문서를 스크립트로 열 때).
  IME 하나를 WebView 전체가 쓰기 때문이며, 게이트 시험은 문서마다 남은 음절을 내보내 서로 섞이지 않게 한다. 앱에서 막는
  두 방법(바꿀 때 초점 빼기, 키 전에 온 확정 버리기)은 측정에서 효과가 없거나 마우스로 고른 후보를 버릴 위험이 있어 넣지 않았다.

## T007 3차 안정화: 2차 리뷰 지적 재현과 수정 (2026-10-17)

커밋 `74cd676` 뒤 2차 정적 리뷰의 지적 4건을 가설로 보고 먼저 재현했다. 새 회귀 테스트
(`src/components/Editor/rhwp/thirdStabilization.test.tsx` 41개)를 `74cd676`의 구현(임시 worktree)에서 실행해 38개가
실패했다(지적한 원인 33개, 새 보고 필드·getter가 없어서 5개 — 성공 묶음 확정, 버리기 뒤 상태, 올바른 HWP·HWPX 통과, 손실 보고). 수정 전에도 통과한 3개(클릭 뒤 일반 입력, 클릭 뒤 키가 먼저 온
확정, 올바른 여러 쪽 페이지 정보)는 기존 동작이 계약에 맞는 경우다.

| 지적 | 판정 | 재현(수정 전) | 원인 | 수정 |
|------|------|---------------|------|------|
| P1-A 클릭으로 끊긴 조합의 늦은 이벤트 | 확인된 결함 | 클릭 → 조합 입력 → 조합 아닌 `insertFromComposition` → `compositionend`에서 '하'가 원래 자리·클릭한 곳·다시 클릭한 곳에 3번(revision 3). 선택이 있으면 선택한 글자까지 지움. 초점 잃음 뒤 늦은 이벤트도 3번. Safari 순서(끝 → 같은 글자 입력)로 클릭 확정 뒤 한 번 더 | 조합 아닌 input이 끊긴 조합을 정리한 뒤 같은 이벤트를 새 입력으로도 넣음. 끊긴 조합을 끝낸 compositionend가 뒤따르는 알림을 알아보지 못함. 빈 compositionend(취소)에 마지막 조합 입력을 넣음 | `imeInput.ts`: 끊긴 조합(트랜잭션)의 늦은 이벤트는 조합 입력·조합 계열의 조합 아닌 input·compositionend 모두 그 트랜잭션 것으로 다룸. 확정은 원래 문서·자리에 최대 한 번(조합 아닌 확정 input이 먼저 오면 그것으로 확정하고 뒤 끝은 소비). 빈 끝은 취소. 트랜잭션은 끝 또는 새 입력 시작(keydown·compositionstart·조합 계열 아닌 input)으로 닫힘. 끊긴 조합이 진행 중이면(확정했거나 그 조합 입력이 이미 옴) 다음 클릭이 자리를 바꾸지 않음 |
| P1-A 관련: 탭 전환 | 확인된 결함(앱 상태) | 보이는 조합이 있는 표면이 초점 잃음 없이 사라지면 그 세션이 조합 중으로 남아 다음 일반 입력을 버림. A에서 확정한 조합의 늦은 끝·확정 input이 B 표면에 오면 B에 삽입 | 끊긴 조합 상태가 표면마다 따로 있었음, 표면이 사라질 때 조합을 정리하지 않음 | IME 입력 문맥은 WebView에 하나이므로 끊긴 조합을 `ImeContext`(작업 공간의 `Editor`가 하나 만들어 모든 표면에 줌)에 둠. 표면이 사라질 때 보이는 조합을 그 문서에 확정(`detach`, 초점은 건드리지 않음) |
| P1-B 엔진 변경이 일부만 된 뒤 예외 | 확인된 결함 | 수정 전 문서에서 선택을 지운 뒤 넣기(또는 문단 나누기)가 예외 → 모델은 'cd'로 바뀌었는데 `hasUnpreservedChanges=false`라 확인 없이 닫기·다시 불러오기 가능 | `modified`를 `apply()` 성공 뒤에만 켬. 엔진은 예외 때 되돌리기를 보장하지 않음(되돌리기 API 없음) | 예외가 나면 그 변경을 세지도 확정하지도 않고(revision 그대로) 모델을 `uncertain`으로 표시, 편집 멈춤(failed). `hasUnpreservedChanges`에 포함(버리기 확인 필요), `hasUncertainChanges`로 성공한 변경과 구분, 실패 화면에 "일부만 바뀌었을 수 있음" 안내. 다시 불러오면 해제 |
| P2-A 왕복 검사의 실제 형식 | 계약 결함 | 다시 연 문서가 다른 형식이어도 `passed`(형식을 보지 않음). Node 검사는 `sourceFormat`을 기록만 함 | 통과 조건에 형식이 없음 | `reopenedFormat`(다시 연 문서의 `getSourceFormat()`)과 `formatEqual` = 요청 형식과 같고 내보낸 바이트가 그 형식의 컨테이너 서명(HWP 5 CFB `D0 CF 11 E0 A1 B1 1A E1`, HWPX ZIP `PK\x03\x04`)으로 시작. rhwp `getSourceFormat`은 HWPX·HML이 아니면 모두 "hwp"(HWP 3 포함)이라 서명을 함께 봄. 형식 조회 실패·빈 값·"hml"은 통과 아님, 다시 연 문서는 모든 경로에서 놓음. `roundtrip.mjs`·PoC도 같은 조건. 실제 엔진에서 HWPX 문서를 HWP로 내보내 다시 열면 "hwp"가 나와 구분됨을 확인 |
| P2-B 페이지 정보 검사 | 확인된 결함 | 실제 엔진: 용지 너비를 1 HWPUNIT으로 바꾼 HWPX를 rhwp가 열고 `getPageInfo`가 `width: 0`을 줌 → 수정 전 앱은 너비 0인 쪽으로 ready. 가짜 엔진: 빈 값·null·문자열·음수·무한대(1e400)·쪽 수 0/음수/소수/NaN도 ready | `Number(x) \|\| 0`로 바꿔 넣음, 쪽 수 검사 없음 | `readPages`: 쪽 수는 1 이상 정수(rhwp `page_count`는 빈 문서도 1), 쪽 정보는 JSON 객체이고 `pageIndex`가 그 쪽, width·height는 유한한 양수이며 rhwp canvas 한 변 최대값(16384 px, `MAX_CANVAS_DIMENSION`) 이하. 아니면 ready가 아니라 `EngineFailure(render)`(엔진이 읽었지만 그릴 준비가 안 됨 — `parse`는 엔진이 문서를 못 읽은 경우, 백엔드 판별은 컨테이너 확인일 뿐). 쪽 수에 임의 상한은 두지 않음(쪽마다 엔진에 물으므로 할당은 실제 쪽 수만큼). 편집 뒤에도 같은 검사(잘못되면 그 변경은 세고 편집 멈춤) |

### 실제 IME와 탭 전환(Xvfb X11 + ibus 1.5.33 + ibus-hangul 1.5.5 + xdotool, WebKitGTK 2.54)

- 필수 7개 결과는 1차 안정화와 같다: **FAIL(4 PASS, 3 FAIL)**, sync·비동기 모두. 이전 빌드(`74cd676`)와 이번 빌드의 항목별 결과도
  같다(이 환경은 조합 중 이벤트를 페이지에 보내지 않으므로 이번 ImeInput 수정이 닿는 이벤트 순서가 나오지 않는다).
- 선택 항목 "조합 중 창 초점 이동 뒤 돌아옴"을 처음 실제로 쟀다(`--focus-window`, 같은 X 서버의 gtk3-widget-factory 창):
  sync·비동기 모두 **PASS** — 다른 창에 있는 동안 문서는 그대로, 돌아와 공백을 치면 '하 '가 원래 자리에 한 번(revision +2).
- 탭 전환 중 조합(기록, 필수 아님): HWPX 문단 끝에서 'ㅎㅏ'를 조합하다 실제 포인터로 HWP 탭을 누르고 공백 → sync·비동기,
  이전·이번 빌드 모두 **음절이 사라짐**(어느 문서에도 없음, 다른 문서로 넘어가지도 않음). 탭 버튼이 초점을 가져가고 그 표면이
  사라지면서 IME 조합이 버려지는 것으로 보이며, 페이지에 조합 이벤트가 오지 않으므로 앱이 알 수 없다(플랫폼 한계). 1차에서 본
  다른 문서로의 확정은 스크립트로 문서를 열 때(초점이 경로 입력란으로 감)였다.
- `ImeContext`·`detach`는 조합 이벤트가 페이지에 오는 플랫폼에서만 효과가 있고, 위 동작은 Vitest의 합성 이벤트로만 확인했다.
  실제 IME 검증이 아니다.

### 실제 앱 검증과 WebDriver 연결 끊김

- 실제 앱(헤드리스 weston + WebKitGTK 2.54, 검사 훅 빌드): 너비 0 페이지 HWPX를 열면 이전 빌드(`74cd676`)는 `ready`·페이지 상자
  너비 0, 이번 빌드는 `failed`(백엔드도 failed, 페이지 없음). `rhwp_poc.py`에 이 검사와 형식 일치 검사를 더해 64개 항목이 됐다.
- 1차 안정화 때 최종 빌드 8회 중 2회 WebKitWebDriver 연결이 끊겼다. 이번에 이전 빌드와 이번 작업 트리 빌드를 번갈아 4회씩
  실행했고(매번 새 weston, 각 74초 안팎) 8회 모두 63개 통과·끊김 0·실행 뒤 남은 WebKitWebDriver·tauri-driver·앱·WebKit 프로세스
  0·가용 메모리 변화 없음(약 28 GB)이었다. 최종 빌드로 다시 3회 실행해도 64개 통과·끊김 0. 이번 측정에서는 재현되지 않아 원인은
  여전히 알 수 없다(편집기 코드 원인의 증거도 없음). 다시 나오면 `--driver-log`로 드라이버 출력을 남긴다.

### 남은 한계

- 클릭으로 끊긴 조합(보이지 않음) 뒤 keydown 없이 조합 입력이 오고, 그 뒤 keydown과 함께 같은 조합의 확정이 다시 오는 플랫폼이
  있다면 keydown에서 원래 자리에 넣은 글자가 새 위치에 한 번 더 들어갈 수 있다. 키 뒤의 확정이 옛 조합인지 새 조합인지 페이지는
  구분할 수 없고, 같은 음절 반복(가가)을 버리지 않기 위해 추측해서 버리지 않는다. 이런 순서는 측정 환경에서 나오지 않았다.
- 클릭 사이에 미리보기만 바꾸는 키를 친 경우(WebKitGTK는 keydown도 없음), 늦은 확정은 마지막 클릭 전 커서에 들어간다.

## T007 4차 안정화: 비동기 소유권·IME 완료·자원 보호 (2026-10-17)

검토 기준은 `7d5d635232e18d930572622e8d3e873493993219`이며 시작 작업 트리는 깨끗했다. R-A와 엔진 고정
(`rhwp 1a76570`, `wordcraft fc41918`)을 유지한다. 저장·자동 저장·복구·T008 이후 기능은 추가하지 않는다.

### 재현과 수정

| 항목 | 판정 | 수정 전 관측과 원인 | 수정 |
|------|------|-------------------|------|
| P1-A 이전 세대 commit | CONFIRMED DEFECT | 보류한 성공 응답을 reload 뒤 전달하면 새 local revision이 1→0, 거부는 새 모델을 failed/closed로 바꿈. 공유 `committing` 때문에 새 세대 commit도 전송되지 않음 | backend `loadGeneration`과 별도로 reload 시작·dispose 때 로컬 `epoch` 무효화. 각 dispatcher가 epoch·generation을 캡처하고 응답 **처리 전** 소유권 확인. `committingEpoch`로 이전 finally도 현재 dispatcher를 해제하지 못함. 같은 세대 batching은 순차 유지 |
| P1-B 완료 중복 | CONFIRMED DEFECT | `end(가) → input(가, insertFromComposition, false) → end(가)`가 가가·revision 2. 후속 input이 `ended`를 지움 | WebView의 공유 terminal 기록을 새 입력 경계까지 유지. 후속 input·중복 end가 기록을 소비해 지우지 않음. 빈 후속 composition input도 기록 유지; end의 data만 달라져도 새 트랜잭션으로 보지 않음 |
| P1-C 정상 완료 뒤 탭 전환 | CONFIRMED DEFECT | A의 정상 완료 표식이 표면 내부에 있어, B로 온 늦은 input/end가 B의 선택을 지우고 하를 삽입 | `ImeContext`가 정상 terminal도 공유. `keydown`·`compositionstart`·새 조합 입력·일반 입력/붙여넣기를 경계로 해제. B의 독립된 같은 음절 보존. 완료된 interrupted 기록은 모델 참조를 갖지 않음 |
| P2-A 창 닫기 | CONTRACT DEFICIENCY | 탭 닫기 보호만 있고 native 창 CloseRequested 보호 없음. 원래 Editor에서 새 window-close 회귀 7개 실패 | Rust가 `api.prevent_close()`로 동기 취소 후 `geul-close-requested` 통지. 모든 탭의 backend dirty·로컬 수정·pending·composition·uncertain을 확인하고 기존 alertdialog UX로 그룹 버리기. 취소는 모델 유지, 승인은 한 번만 `window_close_confirmed` → `Window.destroy()`(재귀 close 요청 없음) |
| P2-B canvas | CONFIRMED DEFECT | 변 길이만 제한. 16384² RGBA는 한 장 약 1 GiB, 전체 쪽·zoom·DPR 합계에 제한 없음. 과대 metadata 4종과 고배율 1종이 원래 코드에서 정상 처리됨 | 쪽 수가 아닌 per-canvas·합계 픽셀 예산, load 100% 및 실제 scale 사전 검사, 초과 시 `EngineFailure(render)`·편집 중단. canvas 초기 크기 0, 재할당 전/표면 해제/reload/dispose 때 backing store를 0으로 놓음 |

추가로 두 수명주기 경로를 재현했다. 창 종료 승인 뒤 진행 중인 탭 close가 실패하면 편집 잠금이 풀리던 경로는
`windowClosing`을 보존한다. 첫 페이지 그리기의 알림이 React 갱신을 일으켜 나머지 페이지 RAF를 취소하던 경로는
예약 작업은 실제 새 render·unmount에서만 취소한다. WebView가 RAF를 실행하지 않는 실제 다쪽 실행도 관측해,
나머지 쪽은 frame clock에 의존하지 않는 다음 task로 그린다. 두 경우 모두 수정 전 실패하는 회귀를 확인했다.

### 비동기·revision 계약

Rust는 계속 committed revision의 권한자다. WASM 변경 성공 뒤 pending을 세고, 현재 epoch의 commit 성공에만 pending을
빼고 Rust revision·세션 투영을 반영한다. 이전 epoch의 성공·StaleLoad·RevisionMismatch·InvalidState·닫힘 오류는 모두
현재 상태에 영향을 주지 않는다. pending은 새 load에서 초기화되며 이전 요청이 미해결이어도 새 dispatcher가 전송한다.
`markFailed`, load 실패 정리, editor에서 시작한 `refresh`도 소유권을 확인한다. dispose는 epoch를 무효화하고 모델·canvas를
놓으며, 세션 투영의 기존 sequence·닫힘 필터도 유지한다. 부분 편집 예외는 uncertain·미보존 보호를 유지한다.

### IME 경계와 한계

terminal 기록은 WebView당 마지막 완료 문자열 하나이며 끝난 모델을 참조하지 않는다. 같은 글자라는 이유로 일반 입력이나
붙여넣기를 막지 않는다. 새 조합 시작·키·조합 중 input은 독립된 입력 증거이므로 같은 음절도 받는다. 중단된 조합은 기존처럼
원래 문서·위치에 최대 한 번 확정하며, 빈 끝은 취소다. 앱의 blur/detach/클릭 확정은 native IME가 끝났다는 증거로 쓰지 않는다.

native transaction ID가 없으므로 새 입력 경계 없이 온 독립된 같은 확정과 중복 통지는 구별할 수 없다. 또 새 keydown 뒤
도착한 옛 확정, 페이지가 전혀 받지 못한 preedit은 이 상태 기계만으로 격리할 수 없다. 서로 다른 문자열의 단독 composition
input은 새 입력으로 다루며, 이를 네이티브 트랜잭션 식별의 증거로 주장하지 않는다. 합성 DOM 이벤트와 실제 native IME
게이트를 분리한다. 실제 데스크톱의 preedit 전달 확인 전에는 완전한 native 격리나 T007 통과를 주장하지 않는다.

### 렌더링 정책

- per-canvas: 최대 `16 * 1024 * 1024` pixels(RGBA 64 MiB), 활성 표면 합계 `32 * 1024 * 1024` pixels(128 MiB).
- rhwp는 scale을 0.25~12로 보정하고 최대 변 16384에 맞춰 더 낮춘 뒤 bitmap 변을 ceil한다. 같은 정규화를 계산하며,
  `getPageInfo`의 소수 첫째 자리 반올림에 대비해 각 변에 1 CSS px 여유를 더한 보수적인 예산을 적용한다.
- `readPages`는 100%에서 예산을 넘으면 ready 전에 모델을 놓는다. 편집 뒤 페이지 변경·zoom/DPR에서도 전체 workload를
  먼저 검사한다. 초과하면 할당하지 않고 실패를 표시하며, 이미 수정한 모델은 계속 미보존 보호 대상이다.
- 10쪽 제한은 없다. 12쪽 A4 문서는 예산 안에서 전체 canvas를 그리고, 46쪽 A4 합계처럼 예산을 넘는 문서는 거부한다.
- offscreen 쪽도 그리는 현재 구조는 유지한다. 가상화는 도입하지 않았다. 높은 DPR/zoom 또는 많은 쪽 때문에 정상 문서도
  거부될 수 있고, 큰 문서의 재그리기 비용은 남는다. 이 수치는 RGBA backing store 예산이며 WASM 모델·엔진 layout·GPU
  복사본·브라우저 전체 RSS의 상한이나 OS의 즉시 메모리 회수 보장은 아니다.

### 창 닫기 경계·권한

`@tauri-apps/api` 2.12.4를 정확히 고정해 공식 event listen/unlisten을 사용한다. 기존 `core:default`가 event 권한을 포함하므로
추가 core 권한은 없다([Tauri event API](https://v2.tauri.app/reference/javascript/api/namespaceevent/)). 새 앱 명령 권한은
`allow-window-close-confirmed` 하나로 현재 창의 destroy만 허용한다. 파일 시스템·셸·저장 권한과 CSP는 바꾸지 않는다.

JS listener가 아직 없거나 통지가 실패해도 Rust가 먼저 취소하므로 창은 남는다. 반복 close는 하나의 dialog·하나의 종료 요청으로
합쳐진다. 기존 탭 dialog가 있으면 그룹 결정으로 바꾸며 탭 닫기를 임의 승인하지 않는다. 이때 기존 확인 버튼의 초점을
이어받지 않도록 결정의 identity로 dialog를 다시 마운트하고 취소에 초점을 둔다(수정 전 회귀 시험 실패 확인). 승인 후 native destroy가 완료될 때까지
편집을 잠근다. force-kill·crash·전원 단절은 이 경로로 보호할 수 없다.


### 4차 검증 기록

검사 명령의 작업 디렉터리는 별도 표시가 없으면 저장소 루트다. 합성 이벤트 검증은 native IME 통과 증거가 아니다.

| 검사 | 실제 결과 |
|------|-----------|
| 기준 코드 `npm test -- --reporter=dot` | 234/234 |
| 새 `fourthStabilization.test.tsx` | 43개 통과. 최초 P1 20개는 기준 구현에서 15 실패·5 통과; P2 canvas 5개·window close 7개도 기준 구현에서 실패. 추가 완료 표식/렌더 수명주기 회귀도 각 수정 전 실패 확인 |
| `npm run typecheck`, `npm run lint`, `npm test -- --reporter=dot`, `npm run build` | 오류 없음, Vitest 277개 |
| `src-tauri`: `cargo fmt --check`, `cargo check --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings` | 통과 |
| `src-tauri`: `cargo test --locked` | 단위 51개 + 파일 핸들 정리 통합 1개 통과 |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과(Rust debug host + production frontend + 고정 release WASM) |
| `python3 tests/e2e/tauri_smoke.py --app src-tauri/target/debug/geul --driver <TAURI_DRIVER>` | 62/62, 건너뜀 0(T004~T006) |
| `python3 tests/integration/rhwp/rhwp_poc.py --app src-tauri/target/debug/geul --driver <TAURI_DRIVER> --report <REPORT_JSON>` | 64/64. HWP/HWPX hit test 각각 32/32 정확, 최대 편차 0. 입력 표본 각각 86, p95 73/72 ms(150 ms 기준 유지), max 118/173 ms. 첫 페이지 693/32 ms |
| `python3 tests/integration/rhwp/fourth_stabilization.py --app src-tauri/target/debug/geul --driver <TAURI_DRIVER>` | 22/22. 실제 WASM·Rust commit 응답만 보류/계약에 맞는 오류로 주입해 세대 격리 검증. DOM IME 3개는 합성. 실제 12쪽 전체 bitmap·46쪽 합계 거부·과대 페이지·zoom·release 포함 |
| 같은 명령 `--scenario dpi` | `weston --scale=2`의 **실제 DPR 2** WebView: 13/13(HWP/HWPX 100%·200%). JS `devicePixelRatio` 덮어쓰기는 실제 고DPI 증거로 사용하지 않음 |
| 같은 명령 `--scenario close --native-close --xdotool <XDOTOOL> --x11-library <LIBX11>` | Xvfb X11의 실제 GTK WM_DELETE_WINDOW: 4/4(기존 탭 확인창에서 전체 창 결정으로 전환·취소 초점·반복 요청 1회·취소 모델 유지·승인 종료·clean 즉시 종료) |

보안 검증: `npm audit --json` 취약점 0, `python3 scripts/check-sensitive-info.py --staged` 24개,
`--all` 115개, `--history` 기존 22개 commit의 302개 파일 버전/경로 통과.
`GITLEAKS=<GITLEAKS> scripts/security-scan-ci.sh .`는 보안 회귀 86개·전체 파일·전체 이력·Gitleaks를 모두 통과했다.
`pre-commit run`의 staged 민감정보·Gitleaks도 통과했다(검사기 소스 변경이 없어 hook의 회귀 시험은 skip, 위 CI에서 86개 실행).
검사 규칙·CSP·기존 보안 기준은 변경하지 않았다.

실제 앱 공통 환경은 Linux WebKitGTK 2.54.1, tauri-driver 2.0.4, weston 15.0.1 pixman(headless,
`--idle-time=0`), `LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1`이다. 고DPI는 별도 scale 2 compositor,
native close·IME는 Xvfb X11을 사용한다. `cargo test` 기본 빌드는 debug 실행 파일을 dev URL 방식으로 다시 만들 수 있으므로,
실제 앱 검증 전에는 custom protocol을 사용하는 위 Tauri CLI build를 마지막에 실행했다.

검증 중 관측한 불안정성과 시험기 수정:

- 기존 T005 스모크가 실패 알림을 React effect 실행 전에 읽어 `준비됨 / 준비됨`으로 실패했다. 실패 알림을 **먼저 실제로
  관측한 뒤** 설정을 되돌리도록 기다림을 추가했다. 복구/실패 기준은 그대로이며 최종 62개가 통과했다.
- 오래 켜 둔 headless Weston에서 RAF가 예약된 채 실행되지 않고 WebDriver 입력 요청이 timeout 나는 것을 관측했다.
  idle을 끈 새 compositor에서 전체 64개가 통과했다. canvas 자체는 frame clock이 멈춰도 예산 안에서 다음 task에 그린다.
- 다른 실행의 WebKitWebDriver 연결 끊김도 관측했다. 모든 시도가 통과했다고 주장하지 않는다. X11의 WM 없는 WebDriver 포인터
  시험은 최대 2글자 편차로 실패했고, 위 최종 hit test 0 결과는 idle을 끈 Wayland 실행의 결과다. 이 전송/환경 차이의 원인은
  확정하지 않았으며 앱 좌표 변환이나 허용 편차를 바꾸지 않았다.
- Rust 기존 테스트의 첫 poll 결과 무시도 확인했다. 완료된 future 재poll panic(닫기 시험)과 이미 끝난 작업을 취소했다고
  가정한 실패(취소 시험, 기대 failed/실제 loading)를 각각 관측했다. 기준 코드의 한 테스트 30회에서는 재현되지 않았으나
  현재 실행에서 두 경로가 실패했으므로 시험 계약 결함(`CONTRACT DEFICIENCY`)으로 고쳤다. 동일한 load 경로에서 읽기 함수만
  주입하는 `load_bytes_with`를 두고 실제 파일 읽기를 channel gate 뒤에 실행한다. 첫 poll의 Pending을 확인한 뒤 취소·닫기·
  새 generation 완료/취소를 검증하며, 남은 파일 작업도 기다린다. production에서는 기존 `read_identified`를 그대로 호출한다.
  Rust의 상태·revision·generation 규칙은 바꾸지 않았다. 수정 후
  `cargo test --locked --lib document::commands::tests`의 7개를 30회 반복해 210/210 통과했다.


### 실제 한국어 IME 최종 게이트

최신 입력/렌더 구현에서 `rhwp_poc.py --ime --ibus <IBUS> --xdotool <XDOTOOL>`를 다시 실행했다. 환경은
Xvfb X11 + WebKitGTK 2.54.1 + ibus 1.5.33 + ibus-hangul 1.5.5 두벌식, preedit syllable·초기 hangul 모드,
`use-event-forwarding=false`, 비동기 모드다. GTK ibus module cache와 engine component 경로를 명시하고 설정은 임시
디렉터리로 분리했다. 초기 설정이 잘못돼 ASCII가 들어간 실행은 한국어 IME 검증으로 사용하지 않는다.

| 필수 항목(변경 없음) | HWP | HWPX |
|-------------------|-----|------|
| 조합 중 글자가 문서에 보임(preedit) | FAIL | FAIL |
| 조합 중 caret이 조합 글자 뒤 | FAIL | FAIL |
| 확정 문자가 커서에 정확히 한 번·누락 없음 | PASS | PASS |
| 확정 음절·공백마다 revision 1 | PASS(+9) | PASS(+9) |
| 동일 음절 연속(가가) | PASS(+2) | PASS(+2) |
| 조합 중 ← | PASS | PASS |
| 조합 중 클릭 | FAIL(음절 사라짐) | FAIL(음절 사라짐) |

결과는 **FAIL, 4/7 PASS**, 종료 코드 1이다. 조합 중 문단·caret이 변하지 않고 클릭 뒤 조합 이벤트도 없다. 정상 확정
`한글 입력 테스트`·revision 9·가가·방향키의 통과를 실제 키 입력으로 확인했다. 선택 항목 창 초점 이동은 이번에 다른 X 창을
주지 않아 NOT RUN이다. native 탭 전환 중 미전달 조합은 음절이 사라지는 현상을 기록했으며, 합성 DOM 테스트의 격리 성공을
native preedit 문제 해결로 해석하지 않는다. preedit을 실제로 전달하는 데스크톱·Windows/macOS는 이번 환경에서 미검증이다.
T007 체크박스는 유지하며 T008 이후 구현은 이번 작업에 포함하지 않는다. 의존성 표의 T008 선행은 T006이므로 별도 PoC의
정책상 착수 가능성과 이번 요청의 명시적 T008 제외를 구분한다. T010 이후 고급 UI 확대 제한도 유지한다.
