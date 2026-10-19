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
- 2026-10-18 원인 규명: preedit이 오지 않은 원인은 wry의 `set_enable_preedit(false)`였다. 되돌린 뒤 실제 IME 필수 7개가
  X11 + ibus-hangul에서 통과했다(아래 ["T007 한국어 IME 원인 규명과 해결"](#t007-한국어-ime-원인-규명과-해결-2026-10-18)). 이 절의 IME 기록은 당시 결과로 남긴다.
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
- (5차에서 바뀐 정책: 예산 초과를 배율에 대한 표시 한도로 다루고, 가장 작은 배율로도 넘는 문서만 ready 전에 거부한다.
  [5차 렌더링 정책](#렌더링-한도와-복구) 참고. 위 기록은 4차 당시의 정책이다.)

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


## T007 5차 안정화: IME 확정 실패·실패 전이 순서·복구 가능한 표시 한도 (2026-10-18)

검토 기준은 `29c1f01e46028b5d761d81a259063899f1a085aa`(브랜치 `master`, 작업 트리 깨끗)이며 R-A와 엔진 고정
(`rhwp 1a76570`, `wordcraft fc41918`), 앞선 네 번의 안정화 장치(epoch·`committingEpoch`·`loadGeneration`·`ImeContext`·
uncertain 보호·창 닫기 확인·픽셀 예산·backing store 해제)를 유지한다. 저장·자동 저장·복구·가상화·T008 이후 기능은 추가하지 않는다.

### 재현과 수정

새 `fifthStabilization.test.tsx`를 먼저 수정 전 구현에 돌렸다: 30개 중 22개가 지적한 원인으로 실패, 8개는 기존 계약대로 통과
(정상 조합·취소 회계, 이미 끝난 전이 뒤 reload, 중복 reload 합치기, StaleLoad·늦은 sequence, 배율만 바꾸기, 진짜 그리기 예외).

| 항목 | 판정 | 수정 전 관측과 원인 | 수정 |
|------|------|-------------------|------|
| P1-A 조합 확정 실패의 거짓 revision | CONFIRMED DEFECT | 선택을 지운 조합(`deletedSelection`)에서 마지막 글자 넣기가 예외를 던지면 `updateComposition()`이 조합을 버리지만 `endComposition()`이 남은 `deletedSelection`만 보고 `recordMutation()` → `localRevision` 0→1(확정 요청은 failed라 안 감). 같은 추론 때문에 반대 방향도 틀림: 넣기는 성공하고 페이지 정보 갱신이 실패하면 `markFailed`가 조합을 지워 성공한 변경을 세지 않음(0, `""` 반환). 선택 지우기 뒤 갱신이 실패하면 failed 상태에서 조합이 계속 열려 있음. 실패한 조합의 늦은 `compositionend`가 다시 불러온 새 모델에 `하`를 넣음 | 조합 기록(`Composition`)은 엔진 호출이 성공한 **mutation 안에서만** 바꾼다(선택 지우기 뒤 생성, 넣기 뒤 글자 갱신). 엔진 예외는 `mutate`가 조합을 세지 않고 끝내며(uncertain), 다른 이유로 편집이 멈추면(`markFailed`·StaleLoad) `settleComposition()`이 그때까지 성공한 조합 변경을 한 번 센다. `endComposition()`은 `replaceComposition()`의 명시적 결과(모델과 맞음/엔진 예외)로 성공·취소·실패를 가르고, 끝난 조합은 다시 세지 않는다. `ImeInput`은 세션 쪽에서 조합이 끝나면 그 조합의 늦은 이벤트를 끊긴 트랜잭션으로 소비하고, 완료 기록은 IME의 최종 글자로 남긴다 |
| P1-B 실패 전이와 reload 경합 | CONTRACT DEFICIENCY | `markFailed()`는 화면을 곧바로 failed로 바꾸고 `ready → failed` 전이 응답을 기다리지 않는다. 그 응답 전에 reload하면 옛 모델을 놓고 `document_load`를 바로 보냄(제어 backend에서 전이 보류 중 `load` 호출 확인). Rust `begin_load`는 `ready`를 `InvalidState`로 거부하므로 IPC 처리 순서가 바뀌면 정당한 복구가 2차 실패가 된다. 실제 Tauri에서는 sync 명령인 `document_set_state`가 먼저 처리되어 이 실패를 관측하지 않았지만 순서는 계약으로 보장되지 않음 | `markFailed()`가 그 시도의 전이 하나(`FailureTransition`, 세대·from·결과 Promise)를 기록한다. `load()`는 기존처럼 미보존 변경을 먼저 확인하고(버리기 확인 전에는 아무것도 하지 않음), `runLoad()`는 **epoch를 바꾸거나 모델을 놓기 전에** 그 결과를 확인한다(`settleFailure`). 성공·`InvalidState(failed)`·`StaleLoad`면 진행, 그 밖의 오류(응답 유실 등)는 이번 reload에서 한 번만 다시 보낸다(백엔드가 알려 준 `InvalidState(ready/loading)`의 상태를 from으로 사용). 그래도 확인하지 못하면 성공을 보고하지 않고 모델·편집·버리기 보호를 그대로 둔 채 그 오류로 끝낸다. 기다리는 동안 닫히면 닫힘으로 끝나고 늦은 응답은 투영을 바꾸지 않는다. 같은 대기 중 두 reload는 같은 작업 하나다. 고정 지연·폴링·`InvalidState` 맹목 재시도는 쓰지 않는다 |
| P2 배율·DPR 예산 초과의 치명적 실패 | CONFIRMED DEFECT | `prepareRendering(scale)`의 예산 초과가 `EngineFailure(render)`로 `markFailed` → 배율을 되돌려도 편집을 이어 갈 수 없고 다시 불러오기(버리기)만 남음. 처음 불러올 때도 100% 합계 초과를 엔진 실패로 표시해 올바른 문서와 손상 문서를 구분하지 않음 | 예산 검사(`fitsRenderBudget`, `RenderBudgetExceeded`)를 그리는 배율에만 적용한다. ready 모델에서 넘으면 표시 한도(`renderLimit`): 그리지 않고 이전 backing store를 놓은 뒤 편집만 멈추고, 쪽 대신 이유·배율·할 일을 알리는 `role=alert` 안내를 보인다. 보이는 조합은 한도 직전에 그 자리에 한 번 확정한다. 예산 안의 배율로 돌아오면 같은 모델로 다시 그리고 편집을 이어 간다(모델·revision·확정·dirty 그대로, 백엔드 전이 없음). `readPages()`는 페이지 정보의 올바름만 본다. 지원하는 가장 작은 배율(50%, DPR 1)로도 넘는 문서만 ready 전에 새 `ClientError` `RenderLimit`으로 거부한다(엔진 실패와 다른 문구). 진짜 WASM 그리기 예외는 계속 `EngineFailure(render)`다 |

검증 중 함께 고친 것: 표면의 세션 구독을 `useEffect`에서 `useLayoutEffect`로 옮겼다. 처음 그리는 layout effect가 표시
한도를 정하면서 내는 알림을 구독 전이라 놓쳐, 처음부터 예산을 넘는 문서가 빈 쪽으로 남던 것을 회귀 테스트로 확인했다.

### 조합·revision 계약

- 정상 조합: 끝날 때 문서가 바뀌었으면(글자를 남김 또는 선택을 지움) 변경 정확히 1개. 선택 없는 취소는 변경이 아니고,
  선택을 지우고 취소하면 그 지우기만 1개(기존 계약 유지).
- 엔진 호출이 예외를 던진 조합: 세지 않는다. pending·`localRevision`·Rust revision을 올리지 않으며 모델은 uncertain으로
  보호된다(편집 중지, 닫기·reload는 버리기 확인 필요). 엔진에 되돌리기 보장이 없으므로 되돌림을 흉내 내지 않는다.
- 변경 성공 뒤 화면 갱신 준비가 실패: 그 조합의 성공한 변경을 한 번 센다(확정은 보내지 않음, failed).
- 끝난 조합의 중복 끝·늦은 확정·`insertCommittedAt`은 새 변경을 만들지 않는다(편집 불가 또는 끊긴 트랜잭션으로 소비).
- 남은 한계: native transaction ID가 없으므로 새 입력 경계 뒤 도착한 옛 확정은 여전히 구별할 수 없다(4차 기록과 같음).

### 실패 전이와 reload 순서

```
편집 중 실패(엔진·그리기·확정 거부) → status=failed(즉시, 편집 중지) + FailureTransition{generation, from, result}
reload(discard 확인 뒤) → result 확인 ─ 성공·InvalidState(failed)·StaleLoad → epoch++ → 옛 모델·canvas 놓기 → document_load
                                    └ 그 밖의 오류 → 한 번 다시 전이 ─ 확인 → 위와 같음
                                                                  └ 실패 → failed(오류 표시), 모델 유지, 성공 알림 없음
닫기 → dispose(epoch++) → 대기 중 reload는 StaleSession으로 끝남, 늦은 전이 응답은 무시
```

옛 모델을 놓는 시점은 (1) 사용자가 버리기를 확인했거나 미보존 변경이 없고 (2) 백엔드가 그 시도를 더 이상 ready·loading으로
두지 않음을 확인한 뒤다. 새 모델과 옛 모델을 동시에 두지 않기 위해 `document_load` 전에 놓는다. 그 뒤 `document_load`가
실패하면(예: `FileChanged`) Rust `LoadingGuard`가 세션을 failed로 돌리고 화면도 그 오류로 failed이며 다시 불러오기를 할 수 있다
(버리기를 확인한 편집은 이미 버려졌고 성공으로 보고하지 않는다). 백엔드가 전이 요청에 영원히 답하지 않으면 reload도
기다린다. IPC 응답 부재를 고정 시간으로 추정하지 않으며, 닫기는 계속 가능하다.

### 렌더링 한도와 복구

- 예산은 그대로다: per-canvas `16 * 1024 * 1024` pixels(RGBA 64 MiB), 활성 표면 합계 `32 * 1024 * 1024` pixels(128 MiB).
  모든 그리기 전에 실제 배율(zoom × devicePixelRatio)로 검사하며 초과 bitmap은 할당하지 않는다.
- 구분: 모델 손상·엔진 parse 실패(`EngineFailure parse`), 실제 WASM 그리기 예외와 잘못된 페이지 정보(`EngineFailure render`),
  가장 작은 배율로도 그릴 수 없는 작업량(`RenderLimit`, ready 전 거부), 배율·DPR 때문인 초과(표시 한도, 복구 가능).
- 배율 표시는 사용자가 고른 값 그대로이며 다른 배율로 몰래 그리지 않는다. 안내 문구가 그 배율을 그릴 수 없다고 말하고,
  가장 작은 배율로도 안 되면(예: 고DPI) 배율을 낮추라고 하지 않는다. zoom 상태는 App 하나가 계속 소유한다.
- 큰 문서: 100%에서만 넘는 문서(예: A4 46쪽, 16000×4096 px 한 쪽)는 이제 열리고 50%에서 편집할 수 있다. 50%·DPR 1로도
  넘는 문서(예: 16383² px 한 쪽, A4 200쪽)는 열지 않는다. 가상화 없이 모든 쪽을 그리는 구조와 큰 문서의 재그리기 비용,
  고DPI에서 더 낮은 한도는 그대로 남는다(T007 범위 밖).

### 5차 검증 기록

작업 디렉터리는 별도 표시가 없으면 저장소 루트다. 아래는 이번 실행의 결과이며 앞선 기록을 재사용하지 않았다.

| 검사 | 실제 결과 |
|------|-----------|
| 수정 전 구현에 새 `fifthStabilization.test.tsx` | 30개 중 22 실패·8 통과(위 표의 원인) |
| `npm run typecheck`, `npm run lint`, `npm test -- --reporter=dot`, `npm run build` | 오류 없음, Vitest 308개 통과(새 31개). 기존 테스트 중 옛 계약을 담은 것(전이 응답 전 reload, 예산 초과 = 실패)은 새 계약으로 바꾸고 단언은 유지·강화 |
| Vitest 전체 반복(현재 36회·기준 코드 37회, 같은 장비에서 번갈아) | `stabilization.test.tsx`의 "Escape(취소)면 모델이 그대로다"가 현재 4/36, **기준 코드에서도 3/37** 간헐 실패(비율이 같아 이번 변경과 무관). 원인: 확인 창의 첫 초점이 passive `useEffect`라 `findByRole`이 창을 본 직후 아직 편집 textarea에 초점이 있을 수 있음. 실험으로 확인: 초점을 `useLayoutEffect`로 옮기면 0/20. 그러나 그 빌드에서 실제 Xvfb native close의 마지막 승인 단계가 3/3 실패(초점 복원이 승인 클릭 안에서 동기로 돌고 창이 WebDriver 응답 전에 사라짐; 원래 코드 빌드는 3/3 통과)해, 범위 밖 변경으로 보고 되돌렸다. 고치지 않음(별도 작업) |
| `src-tauri`: `cargo fmt --check`, `cargo check --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | 통과, 단위 51개 + 통합 1개(Rust 변경 없음) |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과(WASM `BUILD.json` commit `1a76570e`). 아래 실제 앱 결과는 최종 소스와 같은 앱 소스의 빌드에서 얻었다(그 뒤에는 시험 스크립트·문서만 바뀜; 위 초점 실험 빌드의 결과는 쓰지 않음) |
| `python3 tests/e2e/tauri_smoke.py --app src-tauri/target/debug/geul --driver <TAURI_DRIVER>` | 62/62, 건너뜀 0(T004~T006) |
| `python3 tests/integration/rhwp/rhwp_poc.py --app ... --driver ... --report <REPORT>` | 64/64. HWP/HWPX hit test 각각 32/32 정확·최대 편차 0, 입력 표본 각 86개 p95 83/77 ms(≤150), max 243/240 ms |
| `python3 tests/integration/rhwp/fourth_stabilization.py --app ... --driver ...` | 22/22(과대 쪽 wide/tall·46쪽 합계는 새 정책대로 100% 표시 한도·canvas 없음, near-limit은 `RenderLimit`) |
| 같은 명령 `--scenario dpi`(weston `--scale=2`, 실제 DPR 2) | 13/13 |
| 같은 명령 `--scenario close --native-close`(Xvfb X11, IME 모듈 없음) | 4/4, 최종 소스 재빌드에서 다시 3회 모두 4/4 |
| `python3 tests/integration/rhwp/fifth_stabilization.py --app ... --driver ...` | 19/19: 실제 키 편집 뒤 200% 한도(백엔드 ready·revision 그대로·canvas 0·입력 비활성)→100% 복귀 후 같은 모델 편집, 빠른 배율 변경, 46쪽 100% 한도→50% 46쪽 전부(10,263,244 px)·편집, 실제 그리기 예외는 엔진 실패, 실제 Rust 전이 응답을 보류하는 동안 reload가 새 세대를 시작하지 않고 응답 뒤 generation 2 ready·InvalidState 없음(HWP/HWPX) |
| 같은 명령 `--scenario dpi`(실제 DPR 2) | 8/8: 50%(배율 1) 편집 → 100%(배율 2) 한도 → 50% 복귀·편집 |
| 보안 | `npm audit` 취약점 0. `GITLEAKS=<GITLEAKS> scripts/security-scan-ci.sh .` 회귀 86개·추적 파일·이력·Gitleaks 통과. staged 검사는 커밋 때 pre-commit으로 실행 |

환경: Linux, WebKitGTK 2.54.1, tauri-driver 2.x, weston 15.0.1 headless pixman `--idle-time=0`,
`LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1`. native close·IME는 Xvfb 21.1.23 X11. HWP의 실제 표시 한도는
바이너리 픽스처 크기를 바꾸지 않아 실제 앱에서는 HWPX로만 쟀다(HWP는 실제 앱 100/200% 정상 그리기·전이 순서, 한도는 결정적 시험).

### 실제 한국어 IME 게이트(5차 재실행)

`rhwp_poc.py --ime --ibus <IBUS> --xdotool <XDOTOOL>`, Xvfb X11 + WebKitGTK 2.54.1 + ibus 1.5.33 + ibus-hangul 1.5.5 두벌식,
preedit syllable·초기 hangul 모드·`use-event-forwarding=false`·비동기 모드, 설정은 임시 디렉터리(keyfile). 실제 xdotool 키 입력이다.

| 필수 항목(기준 변경 없음) | HWP | HWPX |
|-------------------|-----|------|
| 조합 중 글자가 문서에 보임(preedit) | FAIL(composing=false, 글자 수 15→15) | FAIL |
| 조합 중 caret이 조합 글자 뒤 | FAIL(오프셋 15, 기대 16) | FAIL |
| 확정 문자가 커서에 정확히 한 번·누락 없음 | PASS(`한글 입력 테스트`) | PASS |
| 확정 음절·공백마다 revision 1 | PASS(0→9) | PASS(0→9) |
| 동일 음절 연속(가가) | PASS(+2) | PASS(+2) |
| 조합 중 ← | PASS | PASS |
| 조합 중 클릭 | FAIL(넣은 글자 없음, revision +0, 클릭 뒤 이벤트 0) | FAIL |

결과는 **FAIL, 4/7 PASS**, 종료 코드 1로 4차와 같다. 같은 WebView의 일반 textarea 탐침도 조합 중 이벤트 0개·값 0글자이고
확정 때만 `input(composing)`·`compositionend`·`input`이 와서, 이 환경의 WebKitGTK가 preedit을 페이지에 전달하지 않는다는
기존 관측과 같다. 이번 TypeScript 수정은 이 native 전달 문제를 고치지 않으며 그렇게 주장하지 않는다. 정상 확정의
revision 회계(+9, 가가 +2)는 실제 키에서 중복·누락 없이 유지됐다. 선택 항목 창 초점 이동은 다른 X 창을 주지 않아 NOT RUN.
preedit을 실제로 전달하는 데스크톱(GNOME/KDE의 ibus·fcitx5)·Windows/macOS는 이 환경에 없어 미검증이다. T007 체크박스는
유지하며, T008 이후 작업은 시작하지 않았다.


## T007 6차 안정화: 불러오기 실패 전이·IME 취소 수정 표시·확인 창 초점 (2026-10-18)

검토 기준은 `74eef8bb0105d12162d7b5c504f76b7e8dc2c660`(브랜치 `master`, 작업 트리 깨끗, origin과 같음)이다. R-A·엔진 고정
(`rhwp 1a76570`, `wordcraft fc41918`)과 앞선 다섯 번의 장치를 유지한다. Rust 코드·권한·CSP·의존성은 바꾸지 않았다.

### 재현과 판정

새 `sixthStabilization.test.tsx`(21개)를 먼저 기준 코드에 돌렸다: 처음 20개 중 10개가 지적한 원인으로 실패(P1 7개, P2-B 3개),
P2-A 5개는 기존 동작 그대로 통과(정책 유지를 문서화하는 시험). 확인 창 교체 시험 1개는 수정 도중 발견한 결함의 회귀다.

| 항목 | 판정 | 근거 | 수정 |
|------|------|------|------|
| P1 불러오기 실패의 `loading → failed` 전이 | CONFIRMED DEFECT | `failLoading()`이 전이를 직접 기다리고 결과를 버림. 전이가 `Protocol`·`InvalidState(loading)`·전송 예외로 끝나 Rust가 loading에 남아도 `this.failure`가 없어 다음 reload가 확인 없이 바로 `document_load`를 보냄(parse·render 단계 모두 재현). Rust `begin_load`는 identified·failed만 받으므로 InvalidState로 실패함. 요청 Promise가 거부되면 `load()`가 거부되어 상태가 loading에 멈춤 | `failLoading()`도 `reportFailure()`·`FailureTransition`을 쓴다. 성공·`InvalidState(failed)`·`StaleLoad`로 확인되면 기록을 바로 지우고(기존 정상 경로는 그대로 동기), 아니면 남겨 다음 reload가 `settleFailure()`로 먼저 확인한다(reload마다 재전송 1회, `InvalidState`의 실제 상태를 from으로). `reportFailure()`는 거부된 Promise를 `Protocol` 결과로 바꾼다. `markFailed()`의 from은 비동기 투영 대신 편집 세션의 단계(loading/ready)로 정한다 |
| P2-A 취소한 조합의 `modified` | ACCEPTABLE POLICY(변경 안 함) | 고정 rhwp의 `insert_text_native`·`delete_text_native`는 구역의 원본 `raw_stream`을 버리고 문단을 다시 흐르게 한다(`text_editing.rs` 1491·1618행). 실제 샘플(`external/rhwp/samples`, 읽기만)에서 미리보기 한 글자를 넣고 지우면 글자·컨트롤은 200개 모두 같지만 원본 형식 내보내기 바이트가 HWP 113/120, HWPX 42/80개에서 달랐다(`tests/integration/rhwp/preedit_reversibility.mjs`). 저장소 픽스처는 rhwp가 만든 정규형이라 같게 보였을 뿐이다 | 취소한 조합이 엔진 호출을 한 번이라도 했으면 모델을 계속 미보존으로 보호한다(버리기 확인 유지). revision·pending은 늘지 않는다. 엔진 호출 없이 끝난 조합은 미보존으로 만들지 않는다. 텍스트 비교로 깨끗함을 추정하지 않는다 |
| P2-B 확인 창 첫 초점 | CONFIRMED DEFECT | 계측(모든 `focus()` 호출 기록): 경쟁 핸들러는 없고, 확인 창이 DOM에 들어온 뒤에도 passive effect가 돌 때까지 초점이 편집 textarea에 남음(기준 코드 300회 중 10회 관측, 한 task 뒤 취소 버튼). 앱 scheduler 경로에서 탭·창 닫기 모두 "보이는 순간 초점 = TEXTAREA"를 결정적으로 재현. 그 사이의 키는 뒤의 문서로 간다. 또 확인 창이 열린 동안 표면이 다시 편집 가능해지면 autofocus가 초점을 가져감(재현) | 첫 초점을 layout effect(같은 commit)로 옮긴다. 복원은 passive cleanup 그대로이며, 여는 요소를 `Editor`가 가진 `focusReturnRef`로 이어받아 탭 → 창 닫기 교체 때 옛 창이 새 창의 초점을 빼앗지 않는다(첫 구현에서 기존 4차 시험으로 발견해 고침). 편집 표면 autofocus는 `aria-modal` 창이 초점을 가진 동안 양보한다 |
| 5차 실험의 native 창 닫기 3/3 실패 | CONTRACT DEFICIENCY(시험기) | 변경을 하나씩 넣은 빌드로 A/B: 표면 양보만 넣은 빌드는 통과, 확인 창 변경 빌드는 승인 단계에서 `Session terminated without a reply`. 임시 Rust 기록(되돌림): 실패한 실행에서도 앱은 CloseRequested(막음)·`window_close_confirmed` 1회·Destroyed 1회로 기준 코드와 같았다. 창을 파괴하지 않는 진단 빌드(되돌림)에서 클릭→Rust는 두 빌드 모두 3–6 ms로 차이가 없었다. 시험기가 WebDriver `execute` 안에서 승인을 눌러 그 응답이 창 파괴와 몇 ms 차이로 경합한 것이다(WebKitWebDriver 안의 정확한 순서 차이는 확정하지 못함). 5차 문서의 "초점 복원이 승인 클릭 안에서 동기로 돌아서"라는 설명은 틀렸다(클릭은 discrete 갱신이라 passive effect도 그 안에서 동기로 돈다) | `fourth_stabilization.py` close 시나리오의 취소·승인을 실제 X11 포인터(xdotool, CSS px × devicePixelRatio)로 누르고 창 파괴를 X11에서 확인한다. 진행 중인 WebDriver 명령이 없어 경합이 구조적으로 없다. 단언은 그대로다 |

### 수명주기와 데이터 보호

- 불러오기: `loading`(백엔드 begin_load) → 엔진 실패 → 쓰지 못한 임시 문서 해제 → `loading → failed` 전이(기록) → 결과 확인
  뒤 화면 failed. 확인되지 않은 전이는 다음 reload의 전제다. reload는 epoch를 올리거나 모델을 놓기 전에 전이를 한 번 다시
  보내 확인하고, 확인하지 못하면 거짓 성공 없이 그 오류로 끝난다(다음 reload가 다시 확인, 반복 상한은 reload마다 1회).
- 기다리는 중 닫으면 dispose가 epoch를 바꿔 늦은 응답은 투영·상태·모델에 반영되지 않고 reload는 `StaleSession`으로 끝난다.
  같은 대기 중 reload 두 번은 같은 작업이다. `StaleLoad`는 더 새 시도의 상태를 고치지 않고 진행한다.
- 지금 세대의 모델은 실패 경로가 놓지 않는다(해제는 `runLoad`의 지역 문서·`releaseDocument`뿐).
- 실제 Rust 오류 모양 확인: 실제 앱에서 첫 전이 응답을 전송 오류로 바꾸고(Rust는 실제로 failed) reload하면 재전송이
  Rust의 `InvalidState{state:"failed"}`로 확인되어 generation 2를 시작했다(`fifth_stabilization.py --scenario loading`).

### 5차 정책·기록의 정정

- 5차 기록의 확인 창 간헐 실패 원인 추정(passive effect 시점)은 계측으로 맞았다. 그러나 그 수정을 버린 이유(native 창 닫기
  회귀)는 시험기의 경합이었다. 이전 기록은 그대로 두고 이 절에서 바로잡는다.

### 6차 검증 기록

| 검사 | 실제 결과 |
|------|-----------|
| 기준 코드에 새 `sixthStabilization.test.tsx` | 20개 중 10 실패·10 통과(위 표) |
| `npm run typecheck`, `npm run lint`, `npm test -- --reporter=dot`, `npm run build` | 오류 없음, Vitest 329개(새 21개) |
| 확인 창 초점 반복(같은 장비, 번갈아) | 계측 300회 ×3: 수정 0/900, 기준 13/900 실패. 전체 Vitest 20회: 수정 0/20, 기준 4/20 실패 |
| `src-tauri`: `cargo fmt --check`, `cargo check --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | 통과, 단위 51 + 통합 1(Rust 변경 없음) |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과(WASM commit `1a76570e`). 이후 소스 변경은 주석 한 곳뿐 |
| `tests/e2e/tauri_smoke.py` | 62/62 |
| `tests/integration/rhwp/rhwp_poc.py` | 64/64 ×3회. hit test 32/32·편차 0. p95(HWP/HWPX) 90/112, 102/80, 95/108 ms(≤150). 같은 부하(load avg 약 5.5)의 기준 빌드 95/82 ms(다른 1회는 기존 WebDriver 연결 끊김) — 입력 경로 변경 없음 |
| `fourth_stabilization.py` / `--scenario dpi` | 22/22 / 13/13 |
| `fourth_stabilization.py --scenario close --native-close`(Xvfb, 세션 D-Bus 필요) | 고친 시험기: 최종 소스 7/7회 통과(각 4/4), 기준 소스 3/3. 원래 시험기: 기준 3/3 통과, 확인 창 변경 빌드 승인 단계 실패(위 표의 원인) |
| `fifth_stabilization.py` / `--scenario dpi` | 21/21(새 loading 2개 포함) / 8/8 |
| `preedit_reversibility.mjs` | HWP 113/120, HWPX 42/80 바이트 다름(글자 200/200 같음) |

환경 주의: Xvfb 실행에 세션 D-Bus가 없으면 WebKit 보조 프로세스가 남아 기준 코드도 close 시나리오 정리 단계에서 실패했다
(3/3). 세션 D-Bus를 띄우면 통과한다. 이는 앱 회귀가 아니다.

### 실제 한국어 IME 게이트(6차 재실행)

같은 환경(Xvfb + WebKitGTK 2.54.1 + ibus 1.5.33 + ibus-hangul 1.5.5, 실제 xdotool 키)에서 **FAIL, 4/7**: preedit 표시·조합 중
caret·조합 중 클릭은 FAIL(조합 중 이벤트가 페이지에 오지 않음), 확정 1회·revision(0→9)·가가·조합 중 ←는 PASS(HWP·HWPX 같음).
창 초점 이동은 NOT RUN. T007은 체크하지 않고 T008 이후는 시작하지 않았다.


## T007 한국어 IME 원인 규명과 해결 (2026-10-18)

기준 `5e6c663`. 앞선 여섯 번의 기록(preedit FAIL)은 그대로 두고, 이 절에서 원인과 해결을 기록한다. 결론: **preedit을 막은 것은
WebKitGTK가 아니라 wry였다.** wry 0.57.0은 WebView를 만들 때마다 `input_method_context().set_enable_preedit(false)`를 호출한다
(`src/webkitgtk/mod.rs` 421–424행, 주석 "fcitx input editor can anchor at edit cursor position"). 이 호출이 있으면 WebKitGTK는
조합 문자열을 페이지에 보내지 않고 확정만 보낸다. 실제 IME 게이트는 Linux X11 + ibus-hangul에서 **필수 7개 모두 PASS**(HWP·HWPX,
비동기 5회·sync 1회)가 됐다. 다만 실제 IME 입력의 응답 지연이 이 환경에서 150 ms를 넘는 경우가 있어 T007은 체크하지 않는다(아래).

### 탐침 비교(같은 Xvfb :78 + ibus 1.5.33 + ibus-hangul 1.5.5 두벌식 syllable, 실제 xdotool 키 'gk'→'s', 이어서 클릭)

| 탐침 | 조합 중 이벤트 | 조합 글자 표시 | caret | 조합 중 클릭 | 실패 경계 |
|------|----------------|----------------|-------|--------------|-----------|
| 1. GTK3 `GtkTextView`(WebKit 없음) | native `preedit-changed` ㅎ→하→한 | 보임 | 조합 뒤 | 원래 자리에 '한' 확정 | 없음 |
| 2. WebKitGTK 2.54.1 단독(webkit2gtk 2.0.2, tauri/tao/wry 없음, 기본값) | compositionstart·update ㅎ→하→한, `insertCompositionText`, native 신호 `preedit-changed` | textarea·contenteditable 모두 밑줄 표시(화면 캡처) | 조합 뒤 | mousedown 전에 '한' 확정, 그 뒤 입력 정상 | 없음 |
| 2'. 같은 탐침 + `set_enable_preedit(false)`만 추가 | **0개**, native 신호 없음, 조합 키의 keydown 없음 | 안 보임 | 움직이지 않음 | **'한'이 사라짐** | WebView IM 문맥(설정) |
| 2''. 2 + tao의 `IMContextSimple` 키 필터(tao 0.37.1과 같은 형태) | 2와 같음 | 2와 같음 | 2와 같음 | 2와 같음 | 영향 없음 |
| 3. Tauri 앱의 보이는 textarea(기준 `5e6c663`) | 0개·값 0글자(앞선 기록) | 안 보임 | — | — | wry 설정 |
| 3. 같은 탐침, 수정 빌드 | compositionstart 1·update 2·composing input 2, 조합 중 값 1글자 | 보임 | — | — | 없음 |
| 4. 실제 rhwp 표면(숨긴 textarea → `ImeInput` → WASM → canvas), 수정 빌드 | 조합 입력마다 WASM 조합 범위 교체, revision 그대로 | 문서 안에 밑줄과 함께 보임(`*-ime-preedit.png`) | 조합 글자 뒤 | 아래 꼬리 처리로 원래 자리에 1회 | 없음 |

2와 2'의 차이가 이 호출 하나뿐이므로 원인은 재현으로 확정했다. 수정 전 Tauri 앱의 증상(이벤트 0개, 조합 키의 keydown 없음,
확정만 `insertFromComposition`, 클릭 때 음절 사라짐)은 2'와 같다.

### 플랫폼 조사

- 판: GTK 3.24.52, WebKitGTK 2.54.1(abi 4.1), Tauri 2.12.1, tauri-runtime-wry 2.12.2, wry 0.57.0, tao 0.37.1, webkit2gtk 크레이트 2.0.2,
  ibus 1.5.33, ibus-hangul 1.5.5, Xvfb 21.1.23(창 관리자 없음), weston 15.0.1(headless pixman). 실제 GNOME/KDE 세션·fcitx5(설치 안 됨)·
  Wayland의 ibus 실제 키 입력(xdotool이 Wayland에 키를 넣지 못함)은 이 장비에서 시험하지 못했다.
- wry: 이 호출은 wry 0.29.0에서 fcitx5 후보 창 위치 문제(tauri-apps/tauri#5986, sway, 2023)를 피하려고 들어갔다. 이를 설정
  가능하게 하는 wry PR #1724(2026-05, 열림·미병합)에는 같은 증상(한국어·일본어·중국어 조합 글자가 페이지에 오지 않음)과,
  호출을 빼면 고쳐진다는 보고(GNOME Wayland + fcitx5 Mozc, X11 pinyin)가 있다. 메인테이너는 기본값을 켜는 쪽을 검토 중이다.
- WebKit 146639(2015, IM이 키 없이 preedit 신호를 보내면 충돌, r186892에서 수정)·40518(2010, 클릭으로 끝난 조합의 확정이
  mousedown 뒤에 와 새 입력란에 들어감, r65209 수정): 수정 시기가 2.54.1보다 훨씬 앞서고 이번 증상(이벤트 0개)과 다르다.
  218148(preedit 모드에서 커서를 옮기면 후보 창 위치가 빈 사각형, 278261@main 2024-05 수정): preedit을 켜면 해당하는 경로이며,
  수정 커밋이 2.46 분기보다 앞서 2.54.1에 들어 있을 것으로 본다(설치 라이브러리 소스로 확인하지는 않음). 이번 재현에는 관여하지 않는다.
- 새로 확인한 WebKitGTK 동작(플랫폼, 앱 무관): 조합 중 **창 초점을 잃으면 같은 음절이 두 번 들어간다.** 단독 탐침(2)의 일반
  textarea도 '하하'가 된다. WebView가 조합을 스스로 확정(`deleteCompositionText` → `insertFromComposition` → `compositionend`)한 뒤
  입력기의 확정(native `committed` 신호는 1번)이 한 번 더 온다. upstream 보고 후보다.

### 해결(선택: Tauri/WebKitGTK 연결의 좁은 설정 수정 + 실측 이벤트 순서에 맞춘 상태 기계 보정)

- `src-tauri/src/ime.rs`: 페이지 로드 시작마다 `Webview::with_webview` → `PlatformWebview::inner()`(Tauri 2.12.1 공개 API) →
  `input_method_context().set_enable_preedit(true)`. WebKitGTK 기본값으로 되돌릴 뿐 키 이벤트를 만들거나 번역하지 않고, 다른 앱의
  입력을 가로채지 않는다. 권한·CSP 변경 없음. 의존성: tauri 트리에 이미 있는 `webkit2gtk =2.0.2`(기능 `v2_28`)를 Linux/BSD 대상
  직접 의존성으로 올림 — `Cargo.lock`은 geul 의존성 목록 한 줄만 바뀌고 새 패키지 없음. 다른 플랫폼에서는 아무것도 하지 않는다.
- 실제 preedit이 오자 드러난 결함과 수정(Vitest는 기록한 실제 순서를 재생, `nativeImeOrder.test.tsx` 13개 중 5개가 기준 코드에서 실패):

| 결함(실측) | 원인 | 수정 |
|------------|------|------|
| 조합 중 클릭 뒤 **모든 키가 keydown만 남고 입력되지 않음**(공백도) | 클릭 때 textarea 값을 비우고 `blur()`/`focus()`(preedit 없는 플랫폼에서 IME가 조합을 버리게 하려던 것) | 클릭에서 textarea 값·초점을 건드리지 않는다. 입력기(ibus GTK 모듈)가 클릭에서 조합을 스스로 확정한다 |
| mousedown이 입력기 확정보다 먼저 오면 확정 꼬리가 **클릭한 곳에 다시** 들어감 | WebKitGTK의 확정은 `deleteCompositionText` → 빈 `compositionend` → 229 keydown → `insertFromComposition` → `compositionend(글자)`로 나뉘어 오는데, 빈 끝·229 keydown이 끊긴 조합을 닫음 | 앱이 확정한 보이는 조합(클릭·blur·표면 사라짐)은 이 꼬리가 끝날 때까지 같은 트랜잭션. 입력기의 최종 글자가 다르면(페이지가 입력을 따라가지 못한 채 클릭) 원래 자리에서 고침(`replaceCommittedAt`, 변경 1개 더) |
| 클릭이 빈 끝과 확정 절반 **사이**에 오면 음절이 클릭한 곳으로 감(게이트에서 관측) | 빈 끝(취소처럼 보임) 뒤 클릭은 "막 끝난 조합"으로 보고 아무것도 기억하지 않음 | 빈 끝 바로 뒤 클릭은 확정 절반을 빈 끝의 자리에 넣는다(그 사이 229 keydown은 닫지 않음). 실제 취소였으면 아무것도 넣지 않음 |
| 창 초점 잃음에서 '하하' | 위 플랫폼 이중 확정 | WebView가 확정한 조합(조합 중 `insertFromComposition`) 직후, 조합 시작 없이 229 keydown만 지나 오는 같은 글자의 확정은 소비. 사용자가 다시 친 같은 음절은 compositionstart와 함께 오므로 남음. 다른 글자면 새 입력 |

preedit 없는 플랫폼용 기존 규칙(시작 없는 조합 입력, 같은 음절 연속 확정, 클릭 뒤 키가 먼저 오면 새 입력 등)은 그대로이고 기존
Vitest가 모두 통과한다. revision 권한(Rust)·epoch·`loadGeneration`·`ImeContext` 공유·취소한 조합의 미보존 보호는 바꾸지 않았다.

### 시험기(`rhwp_poc.py --ime`) 정정

- 고정 대기(0.3–0.8초) 뒤 상태를 읽던 것을 `settle()`로 바꿨다: 입력 이벤트 기록·편집 상태가 0.7초 동안 그대로일 때 판정하고,
  30초 안에 끝나지 않으면 실패. 기다린 시간은 보고서 `imeDrain`에 남긴다. preedit이 오면 조합 키마다 문서가 바뀌므로 느린
  환경에서는 페이지가 입력을 늦게 따라잡고, 고정 대기는 처리 전 상태를 읽어 잘못 FAIL했다. 판정 기준 7개는 바꾸지 않았다.
  클릭 항목은 클릭 전에 페이지가 조합 중인지도 확인한다.
- `xdotool search --name ^geul`의 마지막 창이 보이지 않는 창이라 초점을 되돌릴 때 `BadMatch`가 났다(선택 항목 "창 초점 이동"이
  돌아와 친 공백을 잃음) → `--onlyvisible`. 창 초점이 돌아온 뒤 페이지 초점까지 기다린다(WM 없는 Xvfb에서 약 1초 늦음).
- `--screenshots`를 주면 조합 중 화면(`hwp-ime-preedit.png`, `hwpx-ime-preedit.png`)을 남긴다.

### 실제 한국어 IME 게이트(수정 빌드, Xvfb X11 + WebKitGTK 2.54.1 + ibus 1.5.33 + ibus-hangul 1.5.5, 실제 xdotool 키)

| 항목 | HWP | HWPX |
|------|-----|------|
| 조합 중 글자가 문서에 보임(preedit) | PASS(composing, 15→16글자, 화면 캡처) | PASS |
| 조합 중 커서가 조합 글자 뒤 | PASS(오프셋 16) | PASS |
| 확정 글자 1회·누락 없음('한글 입력 테스트') | PASS | PASS |
| 음절·공백마다 revision 1(0→9) | PASS | PASS |
| 같은 음절 연속('가가', +2) | PASS | PASS |
| 조합 중 ← | PASS | PASS |
| 조합 중 클릭(원래 자리에 '하' 1회, 커서는 클릭한 곳, +1, 그 뒤 공백이 클릭한 곳에 들어감) | PASS | PASS |
| (선택) 조합 중 창 초점 이동 뒤 돌아옴('하 ', +2) | — | PASS |

비동기 모드 3회 연속, `IBUS_ENABLE_SYNC_MODE=1` 1회, 최종 바이너리 2회(`cargo test` 뒤 다시 빌드, 마지막은 최종 소스) 모두 **PASS 7/7**(종료 코드 0, load average 1.5–5.3). 탭 전환 중 조합(기록): 이전 'lost' →
'keptInOriginal'(원래 문서에 '하', 다른 문서에는 공백만). 이 결과는 위 X11 + ibus 한 구성의 결과이며 GNOME/KDE 실제 세션,
Wayland, fcitx5, Windows/macOS는 미검증이다.

### 응답 지연(실제 IME, 같은 환경, GPU 없음 `LIBGL_ALWAYS_SOFTWARE=1`, 다른 작업의 빌드로 load average 2–7)

| 빌드 | 문장('한글 입력 테스트 ', 21키) | 다시 그림 | 앱 p95(입력 이벤트→두 번째 frame) | 마지막 키 뒤 따라잡는 시간 |
|------|-------------------------------|-----------|------------------------------------|----------------------------|
| 기준(preedit 없음, 확정만) | 키 간격 약 50/129 ms | 9 | 91/94 ms | 0.2초 이하 |
| 수정(조합 키마다 갱신) | 키 간격 약 50–129 ms, 7회 | 34 | **100–190 ms**(실행마다 크게 다름) | **0.9–2.7초** |

모든 실행에서 최종 글자·revision은 맞았다(+10). 조합 키마다 rhwp 쪽 전체를 다시 그리므로 다시 그림이 약 3.8배이고, 이 환경의
편집 한 번은 WebKit frame 2개(각 55–75 ms)를 쓴다(JS 쪽은 8–35 ms, rhwp 넣기·지우기는 각 0.4 ms). 상태 표시·캐럿 애니메이션·
그림자·scrollIntoView·CPU canvas를 하나씩 바꿔 봐도 줄지 않았다. 확정 입력만 재는 기존 측정(`rhwp_poc.py`)은 p95 91/79 ms로
기준을 지킨다. 실제 GPU 데스크톱에서의 지연은 측정하지 못했다. 조합 미리보기 다시 그리기 비용 줄이기(부분 다시 그리기 등)는
별도 결정이 필요한 후속 작업이다.

### 검증 기록

| 검사 | 실제 결과 |
|------|-----------|
| 기준 코드에 새 `nativeImeOrder.test.tsx` | 실측 순서 13개 중 5개 실패(클릭 2, 빈 끝 뒤 클릭 1, 창 초점 2), 8개 통과. 14번째(`replaceCommittedAt` 보호)는 새 함수라 기준에 없음 |
| `npm run typecheck`, `npm run lint`, `npm test -- --reporter=dot`, `npm run build` | 오류 없음, Vitest 343개(새 14개). act 경고 2개는 기준 코드에도 있음 |
| `src-tauri`: `cargo fmt --check`, `cargo check --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | 통과, 단위 51 + 통합 1 |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과(`cargo test` 뒤 마지막으로 다시 빌드) |
| `tests/e2e/tauri_smoke.py`(weston) | 62/62(최종 소스에서 다시 62/62) |
| `tests/integration/rhwp/rhwp_poc.py`(weston) | 1회 WebDriver 연결 끊김(기존 관측 현상, 32개 통과 뒤), 다시 64/64(p95 91/79 ms). 최종 소스 64/64, hit test 편차 0, p95(HWP/HWPX) 104/106 ms |
| `fourth_stabilization.py` / `--scenario dpi`(scale 2) | 22/22 / 13/13(최종 소스에서 다시 같음) |
| `fourth_stabilization.py --scenario close --native-close`(Xvfb, 세션 D-Bus, IME 모듈 없음) | 4/4 ×3, 최종 소스 4/4 ×2. ibus-hangul을 켠 채 실행하면 WebDriver 키가 한글 조합으로 바뀌어 기준 빌드도 같은 곳에서 실패(환경 설정) |
| `fifth_stabilization.py` / `--scenario dpi` | 21/21 / 8/8(최종 소스에서 다시 같음) |
| `rhwp_poc.py --ime` | 위 표(PASS 7/7 ×6, 선택 항목 PASS ×6, 마지막은 최종 소스) |
| `preedit_reversibility.mjs` | NOT RUN(엔진·취소 정책 변경 없음) |
| `GITLEAKS=… scripts/security-scan-ci.sh .`, `check-sensitive-info.py --all` | 모두 통과(보안 회귀 86개, 추적 파일 119개, 이력, Gitleaks) |

T007 체크박스는 그대로 둔다: 필수 IME 7개는 이 X11 + ibus 구성에서 통과했지만, 실제 IME 입력의 지연이 150 ms 기준을 넘는 실행이
있고(이 소프트웨어 렌더링·부하 환경), 실제 데스크톱 세션·fcitx5·Wayland는 미검증이다. 판단 근거: 위 표.

## T007 7차: IME 성능·조합 트랜잭션 무결성 (2026-10-18)

기준 `e04d54d`(origin/master와 같음). 앞 절의 기록은 그대로 두고 이 절에 7차를 기록한다. 실제 IME 필수 7개는 계속 PASS이고,
**한 문서의 실제 한국어 입력 지연은 p95 약 70 ms로 줄었다**(기준 약 900 ms). DPR 2와 "다른 문서를 고친 채 열어 둔 상태"는
여전히 150 ms를 넘어 T007은 체크하지 않는다.

### 재현과 판정

| 항목 | 판정 | 수정 전 재현(기준 코드) | 원인 | 수정 |
|------|------|------------------------|------|------|
| P1-A 한 조합이 두 변경 | CONFIRMED DEFECT | 'ㅎ'만 보인 채 클릭 → 늦게 온 'ㅏ'와 입력기 끝 '하' → 문서 '하'이지만 revision 2·확정 요청 2개 | 클릭 때 보이는 'ㅎ'를 확정(세기)하고, 입력기 최종 글자로 고치기를 또 셈 | 앱이 먼저 끝낸 보이는 조합(클릭·blur·표면 사라짐)은 모델에 두되 **아직 세지 않는다**(`provisional`). 입력기의 끝(`resolveProvisional`)이 오면 다르면 원래 자리를 고친 뒤 그 조합 전체를 **한 번** 센다. 입력기의 끝 없이 새 조합·입력기가 처리하지 않은 키·조합 계열 아닌 input·다른 변경·편집 중지(실패·표시 한도·닫는 중)가 오면 모델 그대로 한 번 센다(시간 대기 없음). 고치기의 엔진 호출이 예외면 5차 정책대로 세지 않고 uncertain |
| P1-B `isComposing=false` 늦은 확정 | CONFIRMED DEFECT | 'ㅎ' 클릭 → `input(insertFromComposition,"하",false)` → `compositionend("하")`: 문서 'ㅎ'(최종 글자 잃음). 끝 → input 순서는 '하'지만 revision 2 | 그 분기가 끊긴 조합 기록을 `{finalized:true}`로 덮어 `VisibleTail`을 버림 | 보이는 조합이면 그 input을 입력기의 최종 글자로 보고 `resolveProvisional`. 뒤따르는 끝은 소비 |
| P2 클릭 뒤 다음 입력 | CONTRACT DEFICIENCY(시험) | 클릭 항목은 클릭 직후만 판정, 공백 결과는 기록만 | — | 클릭 항목에 클릭 뒤 공백(클릭한 곳에 하나, +1, 옛 음절 없음)과 새 '하 '(그 자리, +2)를 더함. 탭 전환을 선택 항목으로 판정 |
| P2 `ime.rs` 진단 | CONTRACT DEFICIENCY | `with_webview` 오류·입력기 문맥 없음을 조용히 무시 | — | 각각 stderr에 한 번(문서·키 내용 없음). wry가 끄는 호출은 WebView 생성 때 한 번뿐(0.57.0의 유일한 호출)이고 이 훅은 매 로드 시작에 돌아 다시 불러오기 뒤에도 켜짐(실측). wry PR #1724는 2026-10-18에 여전히 열림·미병합(제안 기본값 false) — 들어오면 공개 설정으로 옮김 |

기록한 실제 순서를 재생하는 Vitest(`nativeImeOrder.test.tsx`·`imeRendering.test.tsx`)를 기준 코드에 돌리면 34개 중 16개가 실패한다
(그중 일부는 새 `awaitingCompositionEnd`를 읽어 실패). 앞선 기대 하나를 계약대로 바꿨다: '페이지가 입력을 따라가지 못한 채
클릭'은 revision 2 → **1**.

### 조합·revision 계약(7차에서 바뀐 것)

- 정상 조합·취소·엔진 예외의 회계는 그대로다. 바뀐 것은 **앱이 먼저 끝낸 보이는 조합**: 글자는 바로 모델에 남고 커서는 클릭한
  곳으로 가지만, 그 조합의 변경 1개는 입력기의 끝 또는 위의 경계에서 센다. 기다리는 동안 확정 요청은 보내지 않고
  `hasUnpreservedChanges`로 보호한다. 앞 확정이 응답을 기다리는 중이면 다음 확정에 묶인다(순서·한 번에 하나 그대로).
- 다시 불러오기·닫기는 그 기록을 모델과 함께 버린다(늦게 온 끝은 새 모델에 아무것도 넣지 않음). 탭 전환 뒤 다른 표면에 온 꼬리는
  원래 문서만 고치고 센다. Rust의 revision 권한·`loadGeneration`·epoch 규칙은 바꾸지 않았다(Rust 변경은 `ime.rs` 진단뿐).
- 한계: 네이티브 트랜잭션 번호가 없으므로, 입력기의 끝보다 새 조합 시작이 먼저 오면 그 뒤에 온 옛 끝은 구별할 수 없다(실측
  WebKitGTK + ibus에서는 꼬리가 새 입력보다 먼저 온다).

### 지연의 원인(실제 IME, 실측)

측정: xdotool로 키를 보낸 시각부터 그 키의 상태(문단 글자·조합·커서)가 처음 보인 frame의 다음 frame까지(probe7, 기존 앱 측정
`data-latency-*`는 DOM 이벤트 생성부터라 입력기·큐 대기를 못 봄 — 그 정의는 바꾸지 않고 따로 보고). 같은 창의 일반 textarea는
같은 키로 p95 23–41 ms였으므로 WebKit·입력기 경로는 빠르고, 편집 표면의 일이 원인이었다. JS(이벤트·React·WASM)는 입력마다
4–11 ms였고 WebKit 주 스레드의 나머지(렌더링 갱신)가 지배했다. 일반 textarea 입력마다 한 가지만 바꿔 원인을 갈랐다:

| 입력마다 하는 일 | p95 | 마지막 키 뒤 |
|------------------|-----|--------------|
| 없음 / caret·textarea 이동 / canvas 크기 재설정·전체 다시 그리기 | 22–41 ms | 13–52 ms |
| **편집 영역 위 알림 글자 바꾸기**(판·입력 반영 p95) | 746 ms | 2.8초 |
| **조합 밑줄 요소 만들고 지우기** | 717 ms | 2.9초 |
| **초점 있는 textarea 값 비우기**(위 둘을 고친 뒤 남은 가장 큰 몫) | 66–88 ms(조합) | 114–161 ms |

접근성 끄기·containment·합성 layer·canvas 숨기기·`scrollIntoView` 끄기·확정 IPC 미루기는 효과가 없었다(각각 측정).

### 수정(그리기·입력 정책)

- 조합 밑줄은 쪽마다 하나를 늘 두고 모양·보임만 바꾼다(`RhwpSurface`).
- 알림의 판·입력 반영 **글자**는 입력이 500 ms 멈춘 뒤 바꾼다. `data-*` 속성(검사·진단)은 바로 바뀐다(`Editor.tsx`).
- 숨긴 textarea 값을 키마다 비우지 않는다. 조합 입력·확정·일반 입력의 글자는 이벤트 `data`에서 읽는다(실측: 조합 입력의 data는
  지금 조합 문자열 전체, 확정은 확정 글자). `data`가 없는 입력(붙여넣기)만 값에서 읽고 비우고, 쌓인 값은 조합이 없을 때 256자를
  넘으면 비운다. blur 때 비우기는 그대로.
- 같은 크기로 이미 그린 쪽은 고정 rhwp의 `renderPagePatchToCanvasFilteredWithProfile`로 **쪽 전체**를 그 자리에서 다시 그린다
  (Canvas 크기를 다시 정하지 않음). 조건이 안 맞거나 엔진이 거부하면 원래 `renderPageToCanvas`. bitmap은 크기가 바뀔 수 있을
  때(배율·DPR·쪽 수·쪽 크기)만 먼저 놓는다(예산 정책 그대로).
- 입력 중에는 커서 쪽만 바로 그리고, 이미 그림이 있는 다른 쪽은 입력이 200 ms 멈춘 뒤 마지막 모델로 한 번 그린다. 그림이 없는
  쪽은 바로 그리고, 옛 작업은 version 검사로 새 모델을 덮지 않는다.
- **버린 대안**: 바뀐 문단 띠만 다시 그리기(같은 API의 부분 사각형). 커서 사각형으로 구한 문단 상자가 같아도 실제 엔진에서 표·뒤
  문단이 움직여 10,380 픽셀(RGB 차이 최대 255)이 어긋났다. 본문 편집 API는 엔진의 dirty 사각형을 주지 않는다(`focusedPagePatch`는
  표 셀의 지연 쪽 나눔 API에만 있음). 쓰지 않는다.

### 그리기 정확성(실제 엔진)

실제 IME로 입력한 뒤 그 자리 다시 그린 Canvas와, 같은 모델을 배율 90%→100%로 처음부터 다시 그린 Canvas를 픽셀로 비교했다.
기준 빌드(매번 전체 그리기)는 해시가 같아 비교 방법이 맞다. 수정 빌드: HWP·HWPX 본문, 표 셀, 줄이 늘어나는 긴 입력, DPR 2,
12쪽 문서의 모든 쪽에서 **RGB 차이 0**. 다른 것은 Canvas 오른쪽·아래 끝 한 줄의 alpha뿐(1,992 = 826+1,168−2, DPR 2는 3,985)이고
흰 쪽 배경 위에서 같게 보인다. hit test 편차 0(기존 PoC).

### 실제 한국어 IME 지연(같은 Xvfb X11 + ibus-hangul, GPU 없음, 키 간격 120 ms, 문장 21키, 기준과 번갈아 측정)

| 조건 | 기준 `e04d54d` p50 / p95 / max | 최종 p50 / p95 / max | 마지막 키 뒤 | 판정(≤150) |
|------|------------------------------|--------------------|--------------|-----------|
| HWP 1쪽 | 467–537 / 900–933 / ~1,000 ms | 25 / 68 / 71 ms(load 5.4) | 54–67 ms | PASS |
| HWPX 1쪽 | 442 / 934 / 1,064 ms | 27 / 69 / 79 ms | 57–66 ms | PASS |
| 표 셀(HWP / HWPX) | 577 / 993 / 1,121 ms | 29 / 84 / 90 ms | ~78 ms | PASS |
| 배율 200% | 48 / 101 / 107 ms(HWP) | 33 / 91 / 97 ms(HWPX) | — | PASS |
| 12쪽 HWPX | 1,285 / 2,444 / 2,569 ms | 27 / 71 / 77 ms | — | PASS |
| **DPR 2**(`GDK_SCALE=2`) | 817 / 1,673 / 1,794 ms(HWP) | 280 / **547** / 651(HWP), 385 / **752** / 889(HWPX) | — | **FAIL** |
| **다른 문서를 고친 채 열어 둠**(HWPX) | 측정 불가(기준은 이 흐름에서 HWP 음절을 잃고 HWPX 입력이 0) | 112 / **194** / 291 ms | — | **FAIL** |

모든 실행의 최종 글자·revision(+10)은 맞았다. 다시 그림 수는 기준과 같다(21키에 35, 조합 상태마다 하나 — 조합 표시에 필요).
DPR 2: Canvas를 얼려 두면 p95 67 ms이므로 남은 몫은 4배 픽셀의 쪽 전체 다시 그리기다(부분 다시 그리기는 위 이유로 못 씀 — 엔진의
dirty 영역이 필요). 다른 문서를 고친 채: 그 문서를 닫으면 71 ms로 돌아오고, JS·DOM 변경·Rust 명령은 같으며 WebKit 주 스레드
시간만 약 2배였다(원인 미확인, 이 흐름에서 기준 빌드는 입력 자체가 깨짐). 실제 GPU 데스크톱은 측정하지 못했다.

### 검증 기록(최종 소스)

| 검사 | 실제 결과 |
|------|-----------|
| `npm run typecheck`, `npm run lint`, `npm test -- --reporter=dot`, `npm run build` | 오류 없음, Vitest 363개(15파일) |
| `src-tauri`: `cargo fmt --check`, `cargo check --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | 통과, 단위 51 + 통합 1 |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과(`cargo test` 뒤 마지막 빌드) |
| `tests/e2e/tauri_smoke.py`(weston) | 62/62 |
| `rhwp_poc.py`(weston) | 64/64 ×2, hit test 편차 0, 확정 입력 p95(HWP/HWPX) 38/59, 27/67 ms |
| `fourth_stabilization.py` / `--scenario dpi` | 22/22 / 13/13 |
| `fifth_stabilization.py` / `--scenario dpi` | 21/21 / 8/8 |
| `fourth_stabilization.py --scenario close --native-close`(Xvfb, IME 모듈 없음) | 4/4 ×2 |
| `rhwp_poc.py --ime --focus-window`(강화한 클릭 항목 포함) | 필수 7/7 PASS, 선택 2개(창 초점·탭 전환) PASS — 비동기 4회·sync 1회, 마지막은 최종 바이너리 |
| 다시 불러오기 뒤 preedit | 첫 로드·`location.reload()` 뒤 모두 compositionupdate·조합 표시 |
| `security-scan-ci.sh`(Gitleaks 포함) | 모두 통과(회귀 86, 추적 파일 121, 이력 364) |

T007 체크박스는 그대로 둔다: 필수 IME 7개는 X11 + ibus에서 통과하고 한 문서 입력은 기준 안이지만, DPR 2와 다른 문서를 고친 채
열어 둔 상태의 실제 IME 지연이 150 ms를 넘는다. GNOME/KDE·Wayland·fcitx5·Windows/macOS는 미검증이다.

## T007 8차: 숨긴 입력 버퍼 정확성·남은 한국어 IME 성능 (2026-10-18)

기준 `a15002b`(origin/master와 같음). 앞 절의 기록은 그대로 두고 이 절에 8차를 기록한다. 측정 환경은 7차와 같다(Xvfb X11 :78,
WebKitGTK 2.54.1, GTK 3.24.52, ibus 1.5.33 + ibus-hangul 1.5.5, GPU 없음 `LIBGL_ALWAYS_SOFTWARE=1`·`WEBKIT_DISABLE_DMABUF_RENDERER=1`,
xdotool 실제 키, 키 간격 120 ms, 문장 21키). 지연은 7차의 키→frame 정의(xdotool이 키를 보낸 시각부터 그 키의 상태가 처음 보인
frame의 다음 frame까지) 그대로이고, 앱의 `data-latency-*` 정의는 바꾸지 않았다.

### 재현과 판정

| 항목 | 판정 | 수정 전 재현 | 원인 | 수정 |
|------|------|-------------|------|------|
| P1-A 쌓인 textarea 값과 `data` 없는 입력 | CONFIRMED DEFECT | 합성: 새 `inputBuffer.test.tsx` 17개 중 13개가 기준 코드에서 실패('a' 뒤 'bc' 붙여넣기 → 'aabc', 지우기·되돌리기 input이 쌓인 값을 넣음, 선택 붙여넣기가 엉뚱한 글자). 실제 WebView(`paste.py`, 실제 X 클립보드): WebKitGTK는 `insertFromPaste`에 `data`를 주므로 **중복 붙여넣기는 실제로는 재현되지 않음**. 대신 Ctrl+Backspace(`deleteWordBackward`, data 없음)가 쌓인 값을 새 글자로 **넣었고**(기준), 선택을 바꾸는 붙여넣기 결과가 틀렸다(기준 `…\nL2LQ`) | `data`가 없으면 textarea 값 전체를 새 입력으로 읽음 | 아래 "입력 해석" |
| P1-B 다른 문서를 고친 채 열어 두면 느림 | CONFIRMED(원인 기전 확인, WebKit 내부 이유 미확인) | 통제 행렬: 다른 문서를 **한 번이라도 고치면** 느린 상태로 바뀌고 그 문서를 닫을 때까지 유지. 활성 Canvas를 얼리면 빠름 | WebKit은 Canvas 무효화 영역을 **잘라 내기 전(unclipped) 그린 사각형**으로 잡는다. rhwp 패치 그리기(`renderPagePatchToCanvasFilteredWithProfile`)는 쪽 배경을 **쪽 전체 `fillRect`**로 다시 칠하므로 7차의 그 자리 다시 그리기는 키마다 Canvas 전체를 다시 합성했다(실측: 50×50으로 잘라 낸 전체 fillRect 58 ms frame, 전체 칠하기 56 ms) | 바뀐 띠만 다시 그리고 그동안 fillRect를 띠 안으로 제한(아래). 다른 문서 상태에서 WebKit 전체 무효화가 왜 약 2배로 비싸지는지는 확인하지 못했다 |
| P1-C DPR 2 | CONFIRMED(같은 기전) | 4배 픽셀의 Canvas 전체 다시 합성 | 위와 같음 | 위와 같음(bitmap 해상도는 그대로 DPR × 배율) |
| P2 여러 쪽 나중 그리기 | CONFIRMED(실측 long task) | 입력이 아닌 그리기(처음·배율)는 커서 쪽 밖 모든 쪽을 한 task에: 12쪽 63–71 ms, 30쪽 144–164 ms. 입력 중 화면에 보이는 다른 쪽도 입력이 멈출 때까지 옛 그림 | 한 `setTimeout`에 모든 쪽 | 아래 "여러 쪽 그리기" |

배제한 것(P1-B, 각각 측정): DOM 표시 글자, 탭 그리기, JS 시간, Canvas 연산 구성, 글꼴, RSS, Canvas 사각형, 입력기 초점 다시 잡기,
CPU Canvas, 시간 누적. 버린 시도: 띠만 그리되 fillRect를 그대로 둔 것(8c) — 픽셀은 같지만 지연이 줄지 않았다(위 기전).

### 입력 해석(`RhwpSurface`)

- 숨긴 textarea는 IME가 쓰는 입력 버퍼일 뿐 문서의 근거가 아니다(7차처럼 키마다 비우지 않음 — 비우기가 실제 IME 지연의 원인이었다).
- `beforeinput` 때 값과 선택(`selectionStart/End`)을 기억하고, `input`에서 글자는 이렇게 읽는다: 조합 중·조합 계열 inputType은
  `data`; 조합이 아니고 `insert*`가 아니면(`delete*`·`history*`·`format*`) 아무것도 넣지 않으며 `beforeinput`을 막는다; `insert*`에
  `data`가 있으면 `data`; 없으면 기억한 값의 선택 앞·뒤가 지금 값의 앞·뒤와 같을 때만 그 사이를 새 글자로 본다. 기억이 없거나 앞·뒤가
  맞지 않으면 **넣지 않는다**(쌓인 값을 새 입력으로 보지 않는 안전한 미지원 처리).
- 문서 선택은 textarea 선택과 무관하게 모델의 선택으로 바뀐다(`controller.input`). 지우기·되돌리기·잘라내기는 기존 키 처리(엔진
  명령)만 쓰고 WebKit 기본 편집을 거치지 않는다. 실측: Ctrl+X·Ctrl+Z·Ctrl+Shift+Z는 WebKitGTK에서 input을 만들지 않고, Ctrl+Backspace는
  `beforeinput`에서 막혀 문서가 그대로다.
- 조합·revision 계약(7차)은 그대로다: 조합 하나 = 변경 하나, Rust가 revision 권한, 새 필드·Rust 변경 없음.
- 한계(기존 동작): 여러 줄 붙여넣기는 문단을 나누지 않고 문단 안에 `\n`을 넣는다(기준과 같음).

### 바뀐 띠만 다시 그리기(`paintDiff.ts`, `RhwpEditorSession.repaintInPlace`)

- 고정 rhwp의 `getPageLayerTreeWithProfile(page, "screen", true, true)`(그리기가 그대로 재생하는 레이어 트리 JSON)를 요약해 Canvas마다
  마지막으로 그린 것을 기억하고, 다음 그리기 때 비교한다. 노드 구조(종류·순서·층·잘라내기)가 다르면 쪽 전체, 같으면 잎마다 사라지거나
  생긴 연산의 bbox(이전·지금 자리 모두, 위아래 여유 max(8, 높이))를 합친 쪽 너비 띠, 같으면 그리지 않는다. 모르는 노드·bbox 없는 연산·
  읽기 실패는 쪽 전체. 7차에서 버린 "커서 사각형으로 짐작한 띠"와 달리 이 띠는 실제로 그린 입력의 차이라 표·뒤 문단이 움직인 경우를
  포함한다.
- 띠 위아래를 Canvas 픽셀 경계에 맞춘다(바깥쪽으로). 맞추지 않은 띠(8b)는 띠 끝 두 줄의 RGB가 달랐다.
- 띠를 그리는 동안 그 Canvas 2D context의 `fillRect`를 띠와 겹치는 부분만 칠하게 바꾸고(지금 변환이 확대·이동일 때만, 아니면 그대로)
  끝나면 돌려놓는다(`confineFills`). 잘라 낸 결과와 같은 픽셀이므로 그림은 같고 WebKit의 무효화 영역만 띠로 줄어든다.
- 엔진 API가 없거나 거부하면 7차의 쪽 전체 그 자리 다시 그리기 → 원래 `renderPageToCanvas` 순서. bitmap 해상도는 줄이지 않았다.
- 커서 쪽의 다시 그림 횟수는 기준과 같다(21키에 35). 앱 진단 카운터(`getContext` 횟수)는 띠마다 한 번 더 세어 70으로 보인다.
- 비교의 범위(고정 rhwp 코드 확인): 패치 그리기는 같은 Canvas2D 레이어 트리를 재생하고 노드 bounds로 거르지 않으며(글자 연산만
  잉크 범위로 거름), `clipKind`·`cacheHint`는 재생에 쓰이지 않는다. 그림 연산은 바이트를 빼도 bin-data 세대가 든 키가 남는다.
  트리 밖의 그리기 설정(문단 부호·조판 부호 보이기)은 앱이 바꾸지 않는다 — 그 토글을 넣으면 쪽 전체를 다시 그려야 한다.

### 여러 쪽 그리기(`RhwpSurface`)

- 커서 쪽은 바로 그리고, 나머지는 커서 쪽에서 가까운 쪽부터 **한 task에 한 쪽**씩 그린다. 그림이 없는 쪽(새 쪽·놓은 bitmap)과 지금
  화면에 보이는 쪽은 바로(다음 task부터), 이 배율의 그림이 있고 화면 밖인 쪽은 입력 중이면 입력이 200 ms 멈춘 뒤 그린다.
- 기다리는 쪽이 스크롤로 보이게 되면 `.editor__scroll`의 scroll에서 바로 그린다. 새 변경은 기다리던 작업을 취소하고 다시 정하며,
  옛 작업은 version 검사로 새 모델을 덮지 않는다. unmount는 작업을 취소하고 bitmap을 놓는다(기존).
- 바뀌지 않은 쪽은 위 비교로 그리지 않으므로 나중 그리기의 비용도 줄었다. 쪽 virtualization은 하지 않았다(범위 밖).

### 그리기 정확성(실제 엔진, 실제 IME 입력 뒤 그 자리 그림 vs 배율 90%→100% 처음부터 그림)

| 경우 | RGB 차이 |
|------|----------|
| HWP·HWPX 본문, HWP 표 셀, HWPX 표 셀 긴 입력(줄 늘어남·표 아래 이동), HWP 긴 입력 | 0 |
| DPR 2 본문, DPR 2 표 셀 긴 입력 | 0 |
| 12쪽 HWPX 모든 쪽 | 0 |
| 흐르는 글 6쪽(`flow200`), Enter 12번으로 뒤 쪽이 바뀜(마지막 쪽 바뀜 확인), DPR 1·2, 모든 쪽 | 0 |
| 스크롤 중 입력(`probe10`): Enter 12번 직후 바뀐 마지막 쪽을 스크롤로 보이게 해 두 frame 뒤 잡음 | 0(마지막 키 뒤 106 ms, DPR 2 163 ms — 200 ms 나중 그리기 전). 대조 8d는 옛 그림(6,864 / 19,296 픽셀 다름) |

다른 것은 Canvas 오른쪽·아래 끝 한 줄의 alpha뿐(1,992, DPR 2는 3,985 — 7차와 같은 수, 앞 절 참고)이고 쪽 배경은 늘 흰색이다.

### 실제 한국어 IME 지연(p95, ms; 기준 그리기 = 8a: `a15002b` + 입력 해석 수정만)

| 조건 | 기준 그리기 8a | 최종 | 판정(≤150) |
|------|---------------|------|-----------|
| HWP / HWPX 1쪽 | ~73 / ~73 | 49 / 57 (최대 52 / 63) | PASS |
| **DPR 2**(`GDK_SCALE=2`) HWP / HWPX | **453 / 484** | 75 / 72 (최대 91 / 77) | PASS |
| 표 셀 HWP / HWPX, DPR 2 HWPX 셀 | — | 61 / 65, 76 | PASS |
| 배율 200% HWP / HWPX | — | 74 / 74 | PASS |
| 12쪽 / 30쪽 HWPX | 72 / 75 | 58 / 62 | PASS |
| **HWPX 입력, 고친 HWP 열어 둠** | **201** | 55, 56 | PASS |
| **HWP 입력, 고친 HWPX 열어 둠**(반대) | **213** | 55, 54 | PASS |
| **세 문서, 둘 고침** | **216** | 56 | PASS |
| **A→B→A 전환 뒤** | **183** | 55, 58 | PASS |
| 고친 다른 문서 + DPR 2 | — | 73 | PASS |

마지막 키 뒤 보이기까지(최종): 1쪽 54–68 ms, DPR 2 57–64 ms. 모든 실행의 최종 글자·revision(+10)·다른 문서 내용이 맞았다.
기록해 둘 느린 실행: 다른 작업의 빌드(rustc)가 돌던 동안 고친 다른 문서 상태에서 205 ms(load 4.6)·336 ms(load 12)가 나왔다. 같은
부하의 한 문서 측정이 없어 비교할 수 없다. 합성 부하(바쁜 루프 8개, load 5.6)에서 반대 방향 상태는 126 ms였고, 같은 부하의 한 문서
측정은 아래 WebDriver 끊김으로 얻지 못했다. 실제 GPU 데스크톱은 측정하지 못했다.

long task(시간 8 ms 넘는 setTimeout 작업, 입력 중 12쪽 / 30쪽): 기준 그리기 처음 그리기 63–71 / 144–164 ms, 입력 뒤 나중 그리기
22 / 53–60 ms → 최종 가장 긴 것 10 ms(두 경우 모두 하나).

### 검증 기록(최종 소스)

| 검사 | 실제 결과 |
|------|-----------|
| 새 테스트를 기준 코드에 | `inputBuffer.test.tsx` 17개 중 13 실패. `repaintScheduling.test.tsx`의 순서 3개는 이전(한 task 묶음) 스케줄러에서 실패 |
| `npm run typecheck`, `npm run lint`, `npm test -- --reporter=dot`, `npm run build` | 오류 없음, Vitest 396개(18파일, 부하 중 5회 반복 통과) |
| `src-tauri`: `cargo fmt --check`, `cargo check --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | 통과, 단위 51 + 통합 1 |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과(`cargo test` 뒤 다시 빌드 — `cargo test`가 개발 서버용 바이너리로 덮어써 첫 weston 실행이 모두 화면 없이 실패했다. 다시 빌드한 바이너리는 측정한 것과 바이트가 같음. 주석만 고친 뒤의 마지막 빌드는 JS 묶음 해시가 같고(`index-DP_f4Iy2.js`) 그 바이너리로 스모크 62/62·IME 게이트를 다시 통과) |
| `tests/e2e/tauri_smoke.py`(weston) | 62/62 |
| `rhwp_poc.py`(weston) | 64/64 ×2 |
| `fourth_stabilization.py` / `--scenario dpi` | 22/22 / 13/13 |
| `fifth_stabilization.py` / `--scenario dpi` | 21/21 / 첫 실행 WebDriver 끊김, 다시 8/8 ×5(기준 바이너리도 8/8 ×5) |
| `fourth_stabilization.py --scenario close --native-close`(Xvfb, IME 모듈 없음) | 4/4 ×2 |
| `rhwp_poc.py --ime --focus-window '^wkprobe$'` | 필수 7/7 PASS, 선택 2개 PASS — 측정 바이너리 3회 + 마지막 빌드 1회 |
| 실제 붙여넣기(`paste.py`, HWP·HWPX) | 'a' 뒤 'bc' → 'abc', 같은 'abc' 두 번 → 'abcabc', 한글 뒤 붙여넣기, Ctrl+Backspace·Ctrl+X·Ctrl+Z·Ctrl+Shift+Z 문서 그대로 — 모두 PASS |
| `security-scan-ci.sh`(Gitleaks 포함) | 모두 통과 |

WebDriver 끊김(`RemoteDisconnected`): 합성 부하 밖의 실제 앱 실행 약 90회 중 6회(최종 바이너리 5 — 그중 3회는 다른 작업의 빌드 중 —,
대조 8d 1). 합성 CPU 부하(바쁜 루프)에서는 대부분의 실행에서 재현된다. 실행 기록: 끊길 때 WebKitWebDriver·tauri-driver가 먼저 사라지고 **앱은 살아 있었으며**(stderr 없음, 30초 뒤 시험
정리의 SIGTERM으로 끝남), tauri-driver 기록은 WebKitWebDriver 쪽 연결의 "Connection reset by peer"다. 앱 충돌이 아니라 시험 중계의
문제로 보이지만(keep-alive 경합은 가설) 원인은 확정하지 못했다.

T007 체크박스는 그대로 둔다. 이 환경(Xvfb X11, 소프트웨어 렌더링)에서 필수 IME 7개와 한 문서·DPR 2·여러 문서 지연 기준을 모두
통과했지만, (1) 큰 외부 부하에서의 여러 문서 느린 실행을 같은 부하의 한 문서와 비교하지 못했고, (2) 다른 문서 상태에서 WebKit의 전체
무효화가 비싸지는 이유는 미확인이며(기전은 피했음), (3) 실제 GPU 데스크톱·Wayland·fcitx5·Windows/macOS는 미검증이다.

## T007 9차: 렌더 배율 정확성·바꾸기 입력 안전성·화면 변화 다시 그리기 (2026-10-18)

기준 `84a6e8e`(origin/master와 같음). 앞 절의 기록은 그대로 두고 이 절에 9차를 기록한다. 측정 환경은 8차와 같다(Xvfb X11 :78,
WebKitGTK 2.54.1, ibus 1.5.33 + ibus-hangul 1.5.5, GPU 없음, xdotool 실제 키, 키 간격 120 ms, 문장 21키). 이 Xvfb에서
`devicePixelRatio`는 1.04(기본)·2.08(`GDK_SCALE=2`)이다. 지연 정의는 7·8차와 같다.

### 재현과 판정

| 항목 | 판정 | 수정 전 재현(기준 `84a6e8e` 빌드) | 원인 | 수정 |
|------|------|-------------------------------|------|------|
| P1 엔진 배율과 띠 좌표 | CONFIRMED DEFECT | 300×6000 CSS px 쪽(150문단), 배율 200%, DPR 2.08 → 요청 4.159, 엔진 2.7307, Canvas 820×16384. 61번째 줄에 입력 뒤 처음 그리기와 비교: **RGB 87,188 px 다름(채널 최대 255)**, 행 3478–3587. HWP 86,435. 300×9000 DPR 1.04(요청 2.08 → 엔진 1.8204, 547×16384) 39,821. 축소가 없는 같은 쪽(요청 2.08, 624×12479)은 0 | 고정 rhwp `renderPagePatchToCanvasFilteredWithProfile`은 `normalize_canvas_scale`(0.25..12로 자르고 한 변이 16,384 px를 넘으면 줄임)한 배율로 `setTransform(1,0,0,1,0,0)` + `scale(엔진 배율)`을 쓰고, 쪽 좌표 사각형으로 잘라 내(clip) `clearRect` 뒤 쪽 배경을 칠한다. 앱은 띠의 픽셀 경계 맞춤과 `confineFills`의 Canvas 픽셀 변환을 **요청 배율**로 했다. 엔진 배율이 더 작으면 fillRect 제한 영역이 잘라 낸 곳보다 아래로 밀려 띠 위쪽이 지워진 채(투명) 배경 없이 남았다 | 아래 "배율 계약" |
| P2-A `insertReplacementText` | CONTRACT DEFICIENCY(합성 확인, 실제 이벤트 미발생) | 합성: 새 `inputBuffer.test.tsx` 바꾸기 10개 모두 기준 코드에서 실패(예: textarea "teh" → 바꾸기 "the" 가 문서에 "tehthe"로 덧붙음, 조합 중 바꾸기가 보이는 조합을 바꿈). 실제 WebKitGTK + ibus-hangul(`probe12`): 한자 변환(Hangul_Hanja)은 `deleteCompositionText` → `insertFromComposition "韓"`의 조합 이벤트로 오고, 확정된 글자의 변환은 입력기가 하지 않았다(HanjaMode keydown이 앱에 옴). 이 환경에서 `insertReplacementText`는 **나오지 않았다** | `insert*`를 모두 커서에 넣는 처리. 바꾸는 범위는 textarea의 것이고 textarea는 문서가 아니며 방향키·클릭으로 옮긴 문서 커서를 따르지 않아, 문서의 어느 범위인지 정할 수 없다 | 아래 "바꾸기 입력" |
| P2-B 스크롤 없이 보이게 된 쪽 | CONFIRMED(유한한 지연) | 긴 문단 문서(5쪽, 첫 문단에 8,100자를 넣음), 배율 50%, 1쪽을 화면 바로 아래에 두고 0쪽 한 줄에 입력, 마지막 revision 때 페이지 스크립트가 리본을 접음(편집 영역이 커져 1쪽이 보임, scroll 이벤트 없음): 1쪽이 **240–251 ms 옛 그림**(frame 12개, HWP·HWPX, 3회) | 기다리는 쪽을 그리는 계기가 scroll 이벤트와 다음 키·200 ms 쉼뿐이었다. 다음 키나 쉼 뒤에는 수렴하므로 무한히 남지는 않는다 | 아래 "화면 변화" |
| 같은 부하 비교 | 아래 표 | 8차의 205·336 ms는 같은 부하의 한 문서 측정이 없었다 | — | 측정만(코드 변경 없음) |

### 배율 계약(`renderBudget.drawsAtRequestedScale`, `RhwpEditorSession.repaintInPlace`)

- 좌표: 레이어 트리·패치 사각형·띠는 배율 1의 쪽 CSS px다. 엔진은 Canvas 크기를 `ceil(쪽 크기 × 엔진 배율)`로 정하고 쪽 좌표 →
  Canvas 픽셀을 `× 엔진 배율`(변환 하나, 이동 없음)로 그린다. 패치 그리기는 Canvas 크기가 지금 쪽·배율의 크기와 다르면 그리기 전에
  거부한다(그때 앱은 전체 그리기). 쪽마다 크기가 다르면 엔진 배율도 쪽마다 다르다.
- 엔진이 요청 배율을 **그대로** 쓰는 것이 확실할 때만(요청이 0.25..12이고, `getPageInfo` 반올림을 생각해 각 변 + 1 CSS px에 요청 배율을
  곱해도 16,384 이하) 그 자리에서 다시 그린다(8차의 띠·`confineFills`·쪽 전체 패치 그대로). 이때 요청 배율 = 엔진 배율이므로 띠 경계와
  fillRect 제한이 엔진의 잘라 내기와 같은 Canvas 픽셀이다.
- 아니면 `repaintInPlace`가 false를 돌려 처음 그리기와 같은 `renderPageToCanvas`(Canvas 크기를 다시 정함)를 쓴다. 엔진 배율을 앱에서
  정확히 알 수 없다(`getPageInfo`는 0.1 px, 레이어 트리 JSON은 소수 셋째 자리로 반올림). 쪽 전체 패치도 그 배율에서는 처음 그리기와
  달랐다(300×9000, 엔진 1.8204: 9 px, 채널 차 최대 6, 표 괘선 자리, 원인 미확인 — 편집하지 않으면 0, 같은 쪽을 축소 없이 쪽 전체
  패치하면 0). 바뀐 것이 없는 쪽은 그대로 그리지 않는다. 이 경로는 한 변이 아주 긴 쪽에서만 쓰이고 A4·B4 등 보통 쪽은 배율 200% ×
  DPR 2에서도 해당하지 않는다(1123 × 4 < 16,384). 픽셀 예산(쪽 16 Mi px, 표면 32 Mi px)과 배율 표시는 그대로다.
- `confineFills`(그대로): 바꾼 `fillRect`는 그 context 인스턴스에만 두고 `finally`에서 지워 prototype 메서드로 돌아간다(엔진이 던져도).
  지금 변환이 회전·기울임·뒤집기면 바꾸지 않은 fillRect를 부른다(잘라 내기가 같은 픽셀을 지킴). 다른 Canvas의 context에는 닿지 않는다.

| 경우(실제 rhwp, 실제 IME 입력 뒤 그 자리 그림 vs 배율을 바꿨다 되돌려 처음부터 그림) | 요청 → 엔진 배율, Canvas | 기준 RGB 다름 | 9차 RGB / alpha 다름 |
|------|------|------|------|
| 300×6000 HWPX, 200%, DPR 2.08, 61번째 줄 | 4.159 → 2.7307, 820×16384 | 87,188(최대 255) | 0 / 0 |
| 같은 쪽 HWP | 같음 | 86,435 | 0 / 0 |
| 같은 쪽 Enter 2번(쪽 전체가 바뀜) | 같음 | — | 0 / 0 |
| 300×9000 HWPX, 200%, DPR 1.04, 91번째 줄 | 2.080 → 1.8204, 547×16384 | 39,821 | 0 / 0(쪽 전체 패치였던 9a에서는 9 / 0) |
| 6000×80 HWPX(넓고 짧음, 2쪽), 200%, DPR 2.08, 표 셀 | 4.159 → 2.7307, 16384×219 | 0(띠가 쪽 높이를 덮어 쪽 전체) | 0 / 0 |
| 축소 없음: 300×6000 200% DPR 1.04 / Enter 2번 100% | 2.080, 624×12479 / 1.04, 312×6240 | 0 / 0 | — |
| 보통 쪽(A4): HWP·HWPX 본문, HWPX 표 셀, DPR 2 본문, DPR 2 표 셀(키보드로 셀에 들어감), 12쪽, 흐르는 6쪽 + Enter 12번 DPR 1·2 | 요청 = 엔진 | — | 모든 쪽 RGB 0, alpha는 Canvas 오른쪽·아래 끝 줄만(1,992 / 3,985, 셀 띠는 85·43 — 8차와 같은 종류) |

### 바꾸기 입력(`RhwpSurface`)

- `insertReplacementText`·`insertTranspose`는 지원하지 않는 입력으로 처리한다: 조합 중이 아니면 `beforeinput`을 막아 textarea 값이
  바뀌지 않게 하고, 막히지 않았거나 조합 중이어도 `input`에서 문서·조합에 아무것도 넣지 않는다(조합 제어기를 부르지 않음 — 보이는
  조합, 끊긴 조합의 늦은 끝 기다리기, 앞 확정 요청은 그대로). 다음 `beforeinput`이 새 값·선택을 기억하므로 다음 입력은 그대로 읽힌다.
- 문서 선택(rhwp 선택)은 지우거나 바꾸지 않는다. 다른 문서로 가지 않는다(표면마다 textarea, 탭 전환은 표면을 다시 만듦).
- 일반 `insertText`·`insertFromPaste`·`insertFromYank`·조합 입력은 8차 그대로다. 8차 테스트 "data 없는 insertText·insertReplacementText도
  새로 들어온 글자만"은 정책이 바뀌어 insertText 부분만 남기고 바꾸기는 새 묶음으로 옮겼다.
- 실제 WebKitGTK에서 이 이벤트를 만들 방법을 찾지 못했다(맞춤법 검사·자동 고침은 textarea에서 꺼 둠, ibus-hangul 한자 변환은 조합
  이벤트). 다른 플랫폼(macOS 글자 대치, 다른 입력기)의 바꾸기는 **미검증**이고, 그 플랫폼에서는 바꾸기가 문서에 반영되지 않는다.

### 화면 변화와 나중 그리기(`RhwpSurface`)

- 보이는 쪽은 `.editor__scroll`의 스크롤 위치·크기와 쪽 상자 위치로 정한다. 쪽 크기·배율·DPR·쪽 수가 바뀌면 그리기 효과가 모든 쪽을
  바로 다시 정한다(기다리지 않음). 스크롤 없이 바뀌는 것은 편집 영역 크기(창 크기, 리본 접기, 옆 패널, 알림 줄)뿐이어서 같은 처리를
  `ResizeObserver(.editor__scroll)`에도 붙였다. 키마다 하는 일은 늘지 않는다.
- 기다리는 쪽만 그리고(`stalePages`에서 지운 쪽은 나중 작업이 다시 그리지 않음), 그리기는 version 검사가 있는 같은 함수다. unmount는
  observer를 끊고 기다리는 쪽을 비운다. 표시 한도 중에는 쪽 상자가 없어 그리지 않는다.
- 실측(`probe14`, 기준 vs 9차): 리본을 접은 뒤 1쪽이 지금 모델과 같아지기까지 기준 240–251 ms(옛 그림 frame 12개) → 9차 91–103 ms
  (frame 2개: React가 리본을 접기 전 frame과 그 쪽 한 번 그리기, DPR 2 포함), HWP·HWPX. 마지막 그림은 처음부터 그린 것과 RGB 0.
- DPR만 바뀌고 다른 갱신이 없을 때(모니터 사이 이동)는 다음 갱신 때 새 해상도로 다시 그린다(기존 동작, 이 환경에서 미검증). 모델은
  옛 것이 아니다.

### 같은 부하에서 한 문서·여러 문서 비교(실제 한국어 IME, 최종 바이너리)

방법: `probe7`(8차와 같은 키→frame 정의, 21키 × 2회)을 장면 순서를 번갈아 돌렸다. 장면: HWPX 한 문서 / HWPX + 깨끗한 HWP 열어 둠 /
HWPX + 고친 HWP 열어 둠. 부하는 바쁜 루프(`python3 -c 'while True: pass'`, nice 0, 8 CPU) 0·6·12개를 **입력하는 동안만**(첫 키 직전부터
마지막 키 1.5초 뒤까지) 돌리고, 그동안의 전체 CPU 사용률을 `/proc/stat`으로 기록했다. 처음에는 부하를 계속 돌렸으나(행렬 1) WebDriver
중계가 대부분의 부하 실행에서 끊겨(`RemoteDisconnected`) 입력 구간에만 부하를 걸도록 바꿨다(입력 구간은 WebDriver를 쓰지 않음). 측정하는
동안 다른 작업(다른 저장소의 빌드·헤드리스 Chrome)이 CPU를 1–2코어 쓰고 있었다 — 바쁜 루프 0개도 조용한 상태가 아니다.

| 바쁜 루프 | DPR | 입력 중 CPU | 한 문서 p95(최대) | 깨끗한 다른 문서 | 고친 다른 문서 |
|-----------|-----|-------------|------------------|------------------|----------------|
| 0 | 1.04 | 11–42% | 56 (57) | 56 (59) | 56 (59) |
| 0 | 2.08 | 32–89% | 230 (573)¹ | 82 (91) | 72 (90) |
| 6 | 1.04 | 90–100% | 82 (88) | 171 (238) | 141 (254) |
| 6 | 2.08 | 85–98% | 149 (159) | 169 (242) | 135 (172) |
| 12 | 1.04 | 100% | 167 (209) | 154 (168) | 156 (162) |
| 12 | 2.08 | 100% | 1906 (1934)² | 842 (1905) | 382 (662) |

¹ 4회 중 한 번(외부 작업으로 CPU 89%, 바쁜 루프 없음)이 p95 491이고 나머지는 76·84·106. 행렬 1·2의 앞선 같은 칸은 81.
² 같은 조건의 4회가 p95 259·371·1926·193으로 흔들린다.

- 표본: 칸마다 성공한 실행 × 21키(대부분 84, 실패가 있는 칸 42). 모든 성공 실행에서 키를 못 찾은 것 0, 최종 글자·revision(+10) 일치,
  확정 대기 0, 커서 쪽 다시 그림 35번(진단 카운터 70). 실패 36회 중 5회: WebDriver 끊김 4(입력 전 준비 단계), 부하 중 앱 프로세스가
  늦게 끝나 시험 정리가 실패 1(측정은 끝났으나 결과 파일을 쓰기 전).
- 판정: 바쁜 루프가 없을 때는 세 장면 모두 DPR 1에서 56 ms, DPR 2에서 72–106 ms(외부 부하가 큰 한 실행 제외)로 150 ms 안이다. CPU를
  채우면 **한 문서도** 150 ms를 넘고(12개: 167 / 1906), 여러 문서가 한 문서보다 일관되게 느리지 않다(6개 DPR 1만 한 문서가 빠르고,
  12개 DPR 2는 한 문서가 가장 느림). 8차의 205·336 ms는 Geul의 여러 문서 특유의 느려짐이 아니라 CPU 포화 때 모든 장면에 나타나는
  지연으로 판단하고, 코드는 바꾸지 않았다. CPU 포화 상태의 p95 ≤ 150 ms는 이 환경(GPU 없는 소프트웨어 렌더링)에서 **FAIL**로 남는다.

### 검증 기록(최종 소스)

| 검사 | 실제 결과 |
|------|-----------|
| 새 테스트를 기준 코드에 | 배율 계약 17개 중 5개(엔진이 배율을 바꾸는 5경우) 실패, 바꾸기 10개 모두 실패, 화면 변화 5개 중 1개(스크롤 없이 영역이 커짐) 실패 — 나머지는 이웃 계약(요청 배율 그대로인 띠, 엔진 예외 뒤 돌려놓기, 트리 읽기 실패, 새 키·배율·DPR·표시 한도·unmount, 46쪽 수렴)을 지키는 회귀 검사로 기준에서도 통과 |
| `npm run typecheck`, `npm run lint`, `npm test -- --reporter=dot`, `npm run build` | 오류 없음, Vitest 428개(18파일, 8차 396 + 32) |
| `src-tauri`: `cargo fmt --check`, `cargo check --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | 통과, 단위 51 + 통합 1(Rust 변경 없음) |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과. 픽셀·화면 변화 측정 바이너리(9b)와 JS 묶음 해시가 같음(`index-1ColMwpX.js`, 그 뒤 바뀐 것은 주석뿐). 아래 회귀·IME·지연은 최종 바이너리 |
| `tests/e2e/tauri_smoke.py`(weston) | 62/62 |
| `rhwp_poc.py`(weston) | 64/64 ×2 |
| `fourth_stabilization.py` / `--scenario dpi` | 22/22 / 13/13 |
| `fifth_stabilization.py` / `--scenario dpi` | 21/21 / 8/8 |
| `fourth_stabilization.py --scenario close --native-close` | 4/4 ×2 |
| `rhwp_poc.py --ime --focus-window '^wkprobe$'` | 필수 7/7 PASS 3회(HWP·HWPX), 선택: 창 초점 이동 PASS(탐침 창을 띄운 실행), 탭 전환 PASS. 클릭 뒤 공백·이어 친 음절 정상(입력기의 늦은 끝 포함) |
| 실제 붙여넣기(`paste.py`) | 실제 `insertFromPaste`(data 있음)는 클립보드 글자를 한 번만 넣고(+1 revision), 한글 뒤 붙여넣기, Ctrl+Backspace·X·Z·Shift+Z 문서 그대로 — HWP·HWPX, 기준 바이너리도 같음. 이번 실행에서는 탐침 창의 복사가 의도한 글자('bc')가 아니라 페이지 글자를 복사해 글자 내용 비교는 하지 못했다(탐침 문제, 기준 바이너리도 같은 결과) |
| `security-scan-ci.sh`(Gitleaks 포함) | 모두 통과 |

T007 체크박스는 그대로 둔다. 이 환경에서 필수 IME 7개와 보통 부하의 한 문서·DPR 2·여러 문서 지연 기준을 통과했고 9차의 세 결함은
고쳤지만, (1) CPU를 채운 부하에서는 한 문서를 포함한 모든 장면이 150 ms를 넘고(이 환경의 소프트웨어 렌더링 한계로 보이나 실제 GPU
데스크톱에서 확인하지 못함), (2) 실제 GPU 데스크톱·Wayland·fcitx5·Windows/macOS와 다른 플랫폼의 바꾸기 입력은 미검증이며, (3) 다른
문서 상태에서 WebKit 전체 무효화가 비싸지는 이유(8차)와 축소된 배율에서 쪽 전체 패치가 다른 이유는 확인하지 못했다(둘 다 피했음).

## T008 결과: WordCraft W-A PoC (2026-10-19)

- 상태: **구현·이 환경의 게이트 통과(체크는 T007과 같은 기준으로 보류)**. W-A(백엔드의 네이티브 WordCraft 엔진)로 열기·렌더·커서·
  선택·키보드·표 셀 이동·revision 확정·메모리 내보내기 검사·실제 한국어 IME를 실제 앱(WebKitGTK 2.54.1)에서 확인했다. 저장은 막아 둔다
  (T009/T014). 실제 GPU 데스크톱·Wayland IME·fcitx5·Windows/macOS는 확인하지 못했다(아래 "남은 한계").
- 업스트림 소스는 고치지 않았다. `src-tauri`가 고정 submodule `external/wordcraft`(v0.7.0, `fc41918`)의 `wordcraft-engine`을 path
  의존성으로 링크한다(L3). 빌드 산출물은 submodule 밖(`CARGO_TARGET_DIR`)에 생기고, 빌드 뒤 submodule 작업 트리는 그대로다.
- egui(`wordcraft-ui-egui`)는 쓰지 않는다(W-A 결정대로). 과제 계약의 "egui/WebView 연동"은 egui UI를 끼워 넣는 연동이 아니라
  WebView 편집 표면과 백엔드 엔진의 연동으로 기록한다.

### 설계 검토에서 정한 것

| 문제 | 근거 | 결정(구현) | 검증 |
|------|------|------------|------|
| A. revision 권한 | T007의 `document_commit`·`document_set_state`·`document_load`는 프런트엔드가 모델을 가진다는 전제다. W-A 모델은 백엔드에 있어 이 명령을 쓰면 권한이 둘이 된다 | WordCraft 세션은 백엔드만 바꾼다. 새 명령 `docx_edit`가 모델 잠금 안에서 기준 revision 확인 → 실행 → 실제로 바뀐 연산 수만큼 확정을 한 번에 한다. 세 T007 명령은 WordCraft 세션에 `InvalidRequest` | Rust `편집은_기준_revision을…`, `프런트엔드_모델_명령은…`; 실제 앱: 옛 기준 `RevisionMismatch`, 옛 시도 `StaleLoad`, T007 명령 3개 `InvalidRequest` |
| B. 명령 노출 범위 | WordCraft 명령에는 인자로 받은 경로에 쓰는 것이 있다(`cmd/file.rs:55`, `cmd/mailings.rs:658`, `cmd/tools.rs:431`). `Session::run`을 그대로 열면 IPC가 파일 쓰기 권한이 된다 | 허용한 연산 목록 `DocxOp`(글자 넣기·지우기·문단·표 Tab·이동·클릭/끌기·전체 선택·자리 기억·기억한 자리에 넣기·앞 넣기 고치기)만 받고 어댑터 안에서 명령 ID로 바꾼다. 알 수 없는 연산·필드는 역직렬화에서 거부, 글자는 제어 문자·U+FFFC·4096자 초과 거부, 한 요청 256개 | Rust `계약_밖의_요청은…`; 실제 앱: `{"op":"run","id":"file.saveAs"}` 거부, 파일 없음 |
| C. 변경 수 | WordCraft `rev()`는 문서를 바꾸지 않은 "바꾸는 명령"에도 는다(셀 사이 Tab, 문서 처음 Backspace, 끝 Delete — 탐침 실측) | 바꾸는 명령 앞뒤 `Document`(PartialEq)를 비교해 실제로 바뀐 연산만 센다 | Rust `문서를_바꾸지_않은…`; 실제 앱: 이동·선택·셀 이동 Tab은 revision 그대로 |
| D. 스레드 | Tauri 동기 명령은 주 스레드에서 돈다 | 모든 엔진 작업은 비동기 명령 + 차단 작업 스레드. 같은 세션 작업은 모델 잠금으로 차례로. 프런트엔드는 요청 하나씩 보내고 기다리는 동안의 입력은 다음 요청에 순서대로 묶는다 | Vitest `요청은 한 번에 하나…` |
| E. 글자 그대로 | `text.insert`는 자동 고침·자동 서식을 적용한다 | `raw: true`로 넣는다(IME 확정 글자가 그대로 남음) | Rust `확정한_한글은…`(같은 음절·마침표 그대로) |
| F. IME 조합 표시 | 엔진은 조합을 모른다(조합 처리는 `ui-egui`에만 있음) | 조합 중 글자는 모델에 넣지 않고 커서 자리에 겹쳐 그리며(배경으로 아래 글자를 가림, 밑줄), 커서 막대는 그 뒤에 둔다. 확정 글자만 `InsertText` 하나(조합 하나 = revision 하나, 취소는 연산 없음). 선택이 있을 때 시작한 조합은 시작할 때 선택을 지운다(따로 한 연산) | 실제 IME 게이트(아래) |
| G. 조합 중 클릭의 좌표 | 겹침은 뒤 글자를 밀지 않으므로, 앱이 조합 글자를 먼저 넣은 뒤 지금 배치로 클릭을 찾으면 같은 줄 뒤쪽 클릭이 조합 길이만큼 어긋난다 | `Pointer.beforeInsert`: 바로 앞 넣기 전에 보이던 배치로 찾고 같은 문단의 그 뒤 자리를 넣은 만큼 민다. 입력기의 최종 글자가 다르면 `ReplaceInserted`(그 뒤 문서 변경이 없을 때만). 미리보기 없는 플랫폼의 늦은 확정은 클릭 직전 `Mark`로 백엔드에 기억한 자리에 `InsertAt` | Rust `조합_중_클릭은…`, `기억한_자리에…`, `앱이_먼저_확정한…`; Vitest(실제 WebKitGTK 순서 재생) |
| H. IME 상태 기계 중복 | T007 `ImeInput`이 `Pick<RhwpEditorSession>`에 묶여 있었다 | `ImeSession` 계약(+`markCaret()`)으로 일반화하고, 숨긴 textarea 이벤트 해석은 `src/components/Editor/textInput.ts`로 옮겨(동작 같음) 두 표면이 같이 쓴다. `ImeContext`는 WebView에 하나라 엔진이 다른 탭 사이에도 같은 규칙 | 기존 rhwp Vitest 282개 그대로 통과, rhwp 실제 IME 게이트 9/9 PASS(아래) |
| I. 수명주기 | 모델이 백엔드에 있다 | `docx_load`: 세션 파일을 T007과 같은 확인으로 읽고(`load_bytes`) 엔진이 읽은 뒤 모델을 넣고 `loading → ready`(실패·버려짐은 `failed`, 그사이 닫히면 모델을 빼고 `StaleSession`). 닫기는 기록에서 뺀 뒤 모델을 놓는다. 엔진 패닉은 `failed` + 모델 놓기 + `EngineFailure`. 사용자가 버리기를 확인한 다시 불러오기는 `reloadGeneration`으로 백엔드가 그 시도의 ready 모델을 버리고 새로 읽는다. WebView가 다시 시작되면 rhwp 세션만 failed로 돌리고 WordCraft 모델은 남아 편집 표면이 다시 붙는다 | Rust 수명주기 시험(불러오기·읽는 중 닫기·버려진 불러오기·엔진 실패·패닉·다시 불러오기); 실제 앱: WebView 다시 시작 뒤 편집 내용·revision 그대로, 닫기 확인, 다시 불러오기, 판별 뒤 파일이 바뀌면 `FileChanged` |
| J. 그리기 비용 | 디버그 빌드의 WordCraft는 키 하나에 수백 ms(p95 약 380 ms) | 개발 프로필이 의존성을 최적화한다(`[profile.dev.package."*"] opt-level = 2`, WordCraft 워크스페이스와 같은 값). 백엔드는 쪽·배율마다 마지막 래스터를 기억하고 받는 쪽이 가진 판과 다른 줄의 띠만 PNG로 보내며(머리 24바이트), 화면 canvas에도 그 띠만 옮긴다(T007 8차와 같은 이유). canvas 크기는 바뀔 때만 다시 잡는다 | Rust `띠는_기준_판과…`, Vitest 띠 합성; 실제 앱 지연(아래) |
| K. 열기의 관대함 | 본문 XML이 중간에서 끊긴 DOCX를 오류 없이 끊긴 곳까지 읽어 연다(뒤 내용은 조용히 빠짐) | 열기 성공을 무손실 근거로 쓰지 않는다 — T009 저장 판단의 입력으로 기록 | Rust `본문_xml이_끊긴_docx도…`(동작이 바뀌면 알림) |
| L. 글꼴 | WordCraft는 정해진 폴더만 찾고 fontconfig를 쓰지 않는다. NixOS에서는 한글이 빈 상자 | 앱은 바꾸지 않는다(업스트림 또는 별도 결정). 시험기는 `--font-home`으로 앱 프로세스의 HOME을 한글 글꼴을 `.fonts`에 둔 임시 디렉터리로 바꿔 실행 | 스크린숏(한글·굵게·표) |
| M. CI | `quality.yml` Rust 작업은 submodule을 받지 않는다 | Rust 작업만 `external/wordcraft`를 고정 커밋으로 얕게 받는다(23 MB, rhwp는 받지 않음) | GitHub에서는 **NOT RUN**(푸시하지 않음) |

### 측정(실제 앱, 개발 빌드 + 검사 훅, 고정 픽스처 1쪽)

픽스처는 `tests/fixtures/wordcraft/basic.rs`가 WordCraft 엔진 명령으로 만든 한·영 문단, 굵게, 2×2 표 문서다(T007과 같은 내용).
실행: `tests/integration/wordcraft/wordcraft_poc.py`(33개 항목 모두 통과, 두 환경).

| 항목 | Xvfb X11(DPR 1.041) | 헤드리스 weston(DPR 1) |
|------|------|------|
| 불러오기·첫 쪽 표시 | ready, 155 ms | ready, 174 ms |
| 100%/200% 쪽 그림 | 850×1100 / 1699×2199(= CSS 크기 × DPR) | 816×1056 / 1632×2112 |
| hit test(본문 12글자·셀 4글자, 경계 사이 30%/70% 실제 포인터 클릭 32회) | 최대 편차 1글자(31/32 정확) | 0글자(32/32 정확) |
| 드래그·Shift 선택·Home/End·↑↓·Backspace/Delete·Enter·문단 합치기·표 Tab/Shift+Tab·셀 입력 | 통과 | 통과 |
| 키 입력→화면 반영(입력마다, 키 간격 150 ms, 그 시나리오의 키 80개) p50 / p95 / 최대 | 35 / 56 / 507 ms | 28 / 47 / 56 ms |
| 같은 실행의 키 표본 전체(시험기가 키마다 WebDriver로 상태를 물은 앞 시나리오 포함) p50 / p95 | 32 / 267 ms | 27 / 206 ms |
| 메모리 내보내기 → 다시 읽기(편집 뒤) | 쪽·본문 글자·문서 모델 같음(통과) | 같음 |

- 단계별(앱 안에서 잰 중앙값, Xvfb): 편집 IPC 3 ms, 100% 쪽 래스터+PNG 10 ms, PNG 디코드 10 ms, canvas 옮기기 2 ms. 띠로 바꾼 뒤 같은 실행의
  전체 키 표본 중앙값이 67 → 39 ms가 됐다.
- 측정하는 동안 같은 기계에서 다른 작업(다른 저장소의 `cargo test --release`)이 CPU 4코어를 쓰고 있었다(load average 4–8). 전체 표본의
  p95가 큰 것은 그 경합과 시험기의 상태 질의가 WebView 주 스레드와 겹친 몫이다(같은 앱으로 키만 친 실행: p95 115–128 ms). T007 9차처럼
  CPU를 채운 부하에서는 150 ms를 넘을 수 있다.

### 한국어 IME(실제 ibus 1.5.33 + ibus-hangul 1.5.5 두벌식, Xvfb X11 + xdotool 실제 키, 3회 실행)

| 항목 | 결과 |
|------|------|
| 조합 중 글자가 문서에 보임(커서 자리 겹침, 모델·revision 그대로) | PASS ×3 |
| 조합 중 커서가 조합 글자 뒤에 있음 | PASS ×3 |
| "한글 입력 테스트" 확정이 커서 위치에 정확히 한 번 | PASS ×3 |
| 확정 음절·공백마다 revision 1(0→9) | PASS ×3 |
| 같은 음절 연속 확정('가가') | PASS ×3 |
| 조합 중 ← | PASS ×3 |
| 조합 중 클릭: 원래 자리에 한 번, 커서는 클릭한 곳, 이어 친 공백·음절 정상 | PASS ×3 |
| (선택) 조합 중 창 초점 이동 뒤 돌아옴(MiniBrowser 탐침 창) | PASS ×2 |
| (선택) 조합 중 탭 전환(DOCX → DOCX): 원래 문서에 한 번, 다른 문서에 섞이지 않음 | PASS ×3 |

같은 빌드로 T007 rhwp 실제 IME 게이트도 다시 돌려 9/9 PASS였다(공유한 `ImeInput`·`textInput.ts`의 회귀 확인).

### 시험기에서 알게 된 것(앱 동작이 아님)

- Xvfb의 devicePixelRatio 1.041에서 WebKitWebDriver 포인터 위치가 요청 값 ÷ 1.042에 떨어졌다(415.4 요청 → clientX 398). 시험기는 처음에
  상태 표시줄을 한 번 눌러 비율을 잰다. weston(DPR 1)에서는 1.0.
- 비IME 시나리오를 ibus-hangul이 켜진 채 돌리면 WebDriver의 ASCII 키가 한글로 조합된다('ab' → '뮤'). `GTK_IM_MODULE=gtk-im-context-simple`.
- `cargo test`는 같은 대상 디렉터리의 `debug/geul`을 `custom-protocol` 없이 다시 빌드한다(개발 서버 주소를 열어 빈 화면). 앱 시험 전에
  `tauri build`를 다시 한다.
- WebKitWebDriver 연결이 가끔 끊겼다(앱·WebProcess는 살아 있음). 키마다 상태를 묻지 않도록 바꾼 뒤 재현되지 않았다(T007의 기록과 같은 현상).

### 검증 기록(최종 소스)

| 검사 | 결과 |
|------|------|
| `npm run typecheck`, `npm run lint`, `npm test` | 오류 없음, Vitest 462개(22파일, 기준 428 + 34) |
| `src-tauri`: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | 통과, 단위 78(기준 51 + 27) + 통합 1 |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과 |
| `tests/e2e/tauri_smoke.py`(weston) | 62/62 |
| `tests/integration/rhwp/rhwp_poc.py`(weston) | 64/64 |
| `tests/integration/rhwp/rhwp_poc.py --ime --focus-window wkprobe`(Xvfb + ibus-hangul) | 필수 7/7 PASS, 선택 2/2 PASS |
| `tests/integration/wordcraft/wordcraft_poc.py --font-home …`(Xvfb, weston, 최종 소스로 weston 재실행) | 33/33, 33/33, 33/33(키 반영 p95 59 ms) |
| `tests/integration/wordcraft/wordcraft_poc.py --ime [--focus-window wkprobe]` | 필수 7/7 PASS 3회, 선택 창 초점 PASS 2회·탭 전환 PASS 3회 |
| `python3 scripts/check-sensitive-info.py <바뀐 파일 42개>` | 통과 |
| GitHub Actions(`quality.yml`의 WordCraft submodule 단계) | **NOT RUN**(푸시하지 않음) |

### 남은 한계

- 실제 GPU 데스크톱, Wayland IME, fcitx5, Windows/macOS는 확인하지 않았다(T007과 같음, 플랫폼 검증은 T016). 그래서 T008도 T007과 같은
  기준으로 체크하지 않는다.
- 조합 중 글자는 겹쳐 그리므로 뒤 글자를 밀지 않는다(가림). 줄 끝을 넘는 긴 조합은 쪽 밖으로 나갈 수 있다(조합은 한 음절이라 실측
  문제는 없었다). 겹침 글꼴은 WebView 글꼴이라 문서 글꼴과 모양이 다를 수 있다.
- 바꾸는 연산마다 문서 모델을 복제·비교하므로 큰 문서에서는 비용이 커진다(1쪽 픽스처만 측정). 큰 문서·여러 쪽 지연은 측정하지 않았다.
- NixOS처럼 글꼴이 fontconfig로만 있는 시스템에서는 한글이 빈 상자로 그려진다(편집 모델은 정상). 앱 쪽 해결(fontconfig 경로를
  WordCraft에 알려 주기 등)은 따로 정한다.
- 열기의 관대함(K)은 T009 저장 판단에서 다뤄야 한다. 실행 취소·서식 명령은 T010이다.
- 키 반영 지연은 같은 기계의 CPU 경합에 따라 꼬리가 길어진다(측정 표 참고).

## T008 안정화: 붙여넣기·그림 실패·조합 선택·래스터 예산·복합 연산·닫기 보호 (2026-10-19)

- 상태: **이 환경에서 구현·검증 완료(체크는 T007·T008과 같은 플랫폼 기준으로 보류)**. 기준 `99c9a4c`(master, 작업 트리 깨끗, submodule
  rhwp `1a76570`·wordcraft `fc41918` 그대로). W-A·IPC 권한(`DocxOp` 목록만)·revision 권한(`SessionRegistry`)은 유지했다. 저장은 하지 않는다.
- 수정 전 확인: 새 회귀 시험을 수정 전 구현에 먼저 돌렸다(Vitest 31개 중 26개 실패 — 그중 행동 근거가 있는 실패는 아래 표, 나머지는 새 API가
  없어서). Rust는 `cfg(test)` 실패 주입(`DocxModel::fail_at`)만 먼저 넣어 3개 실패를 확인했다. 실제 앱도 수정 전 소스(`git archive 99c9a4c`)를
  따로 빌드해 같은 탐침으로 비교했다(Xvfb X11, 실제 X11 클립보드).

| 지적 | 판정 | 증거(수정 전) | 원인 | 수정 |
|------|------|---------------|------|------|
| P1-A 긴·여러 줄 입력 | CONFIRMED DEFECT | 실제 앱: 실제 클립보드로 `붙여 첫째\r\n붙여\t둘째\n붙여 셋째` Ctrl+V → `failed`, "잘못된 요청입니다."(revision 0). Vitest: LF·CRLF·CR·탭 → failed, 제어 문자도 보내고 failed | Rust `valid_text`가 `\n`·`\t`·4096자 초과를 거부(요청 전체 `InvalidRequest`)하는데 `typeText`가 받은 글자를 연산 하나로 보냄. 실측 WebKitGTK 2.54 붙여넣기는 `insertFromPaste` 하나(data 있음, CRLF→LF) | 새 연산 `PasteText{text, chain}`(`\n` = 문단, `\t` = 탭 글자, 4096자 이하, WordCraft `text.insert` 한 명령 = 실패 시 엔진이 되돌림)과 `textOps.ts`(CRLF·CR·U+2029 → `\n`, 유니코드 문자 경계 4096자 조각, 둘째 조각부터 `chain` — 앞 조각이 거부되면 같은 요청에서는 백엔드가, 다음 요청으로 넘어간 조각은 프런트엔드가 건너뜀). 그 밖의 제어 문자·U+FFFC·고립 서러게이트·1,048,576자(한 요청 = 256조각) 초과는 넣지 않고 안내(`inputNotice`), 일부 조각 거부는 "앞부분만 들어감" 안내. `InsertText`의 계약(한 문단, 탭·줄바꿈 없음)은 그대로. 한도(`MAX_TEXT_CHARS`·`MAX_OPS`)는 올리지 않음 |
| P1-A 부수: 줄마다 나뉜 input | CONFIRMED DEFECT(실측) | 실제 앱: `execCommand('insertText', '첫째\n둘째\n셋째')`는 beforeinput 하나 뒤 줄마다 `insertText`·`insertParagraph`(data 없음) input이 옴 → 비교할 앞 상태가 없는 `insertParagraph`를 버려 줄이 합쳐짐 | `textInput.ts`가 data 없는 넣기를 beforeinput 때 값과만 비교 | `attachTextInput`의 `paragraphBreaks` 선택지(DOCX 표면만): data 없는 `insertParagraph`·`insertLineBreak`는 `\n` 하나. rhwp 동작은 그대로 |
| P1-B 그림 실패 | CONFIRMED DEFECT | Vitest: 편집 뒤 지금 판 그림이 계속 `InvalidRequest`·PNG 디코드 실패여도 `ready`·편집 가능, 옛 그림(판 0)을 보인 채 요청마다 무제한 재요청. 세션을 잃은 `InvalidState`도 ready. canvas 문맥이 없으면 빈 래스터를 지금 판으로 표시. 띠 너비가 달라도 덮음 | `requestPages`가 `!result.ok`·디코드 실패를 조용히 버림, `getContext()?.` | 분류: 옛 시도·옛 판(편집 보내는 중의 `RevisionMismatch`)은 무시, 세션 오류(`StaleSession`·`UnknownSession`·`StaleLoad`·`InvalidState`·`EngineFailure`, 기다리는 연산 없는 `RevisionMismatch`)는 failed, 그 밖(백엔드 거부·`Protocol`·디코드·문맥 없음·크기 불일치)은 쪽 실패로 250·500 ms 간격 3번까지. 다 쓰면 그 쪽과 안내(`docx-render-failed`, 다시 그리기)에 보이고 편집을 멈춘다. 멈춤은 그 쪽이 지금 판으로 그려지거나 보이지 않게 될 때까지(아래 새 결함). 이미 failed면 늦은 그림 오류가 원래 오류를 덮지 않음. 바뀐 띠 최적화는 그대로 |
| P1-B 부수: 멈춤 해제 | CONFIRMED DEFECT(새 시험에서 발견) | 조합 중 그림 실패로 편집이 멈출 때 보이던 조합을 확정 → 판이 바뀌어 실패 기록이 옛 판 것이 됨 → 편집 재개 → 같은 조합의 늦은 IME 이벤트가 새 조합으로 '하' 다음 '한'을 한 번 더 넣음 | 실패를 판마다 따로 셈 | 멈춘 쪽의 실패는 새 판으로 다시 시도하되 그려질 때까지 멈춤 유지 |
| P1-C 선택 + 조합 취소 | ACCEPTABLE EXISTING POLICY(계약) + CONFIRMED DEFECT 2건 | 계약: 미리보기가 보인 뒤 취소하면 지운 선택은 남는다(T007 rhwp "선택을 지우고 취소하면 그 지우기만 1개", T008 결과 F) — 유지하고 회귀 시험·실제 IME 선택 항목 추가. 결함: ① 선택을 접는 연산(→)이 보내는 중일 때 조합을 시작하면 옛 보기(`collapsed=false`)로 Backspace를 보내 '가나다' → '가나마'(접은 뒤의 '다' 삭제). ② 미리보기 없이 끝난 빈 조합(compositionstart → compositionend(""))이 선택을 지움 | `beginComposition`이 응답 전 보기로 Backspace를 보냄 | 새 연산 `DeleteSelection`(백엔드가 실행할 때 선택이 있을 때만 지움, 없으면 변경 0). 조합 글자가 처음 보일 때 보이던 선택이 있으면 보냄. 확정만 온 조합은 `InsertText`가 그때 남은 선택을 바꿈(WordCraft 기본 `typing_replaces_selection`) |
| P2-A 여러 쪽 메모리 | CONFIRMED DEFECT | 실제 앱(같은 탐침, 118쪽 스크롤): 수정 전 화면 canvas 118개 모두 유지 110,330,000 px(약 421 MiB RGBA, 같은 크기의 화면 밖 래스터가 따로 있음), WebKitWebProcess RSS 751 → 1,151 MB. Vitest: 120쪽 → 화면 밖 래스터 120개 103,403,520 px | 쪽 래스터 `Map`에 예산·놓기가 없음, 화면 canvas도 놓지 않음, 표면이 사라져도 유지 | 화면 밖 래스터 예산 `MAX_RETAINED_PIXELS` 32 Mi px(RGBA 128 MiB, T007 활성 표면 예산과 같음), 넘으면 지금 요청한(보이는·커서) 쪽이 아닌 것부터 오래 쓰지 않은 순으로 놓음(크기 0). 놓은 쪽의 화면 canvas도 다음 그리기에서 놓음. 표면 unmount(탭 전환·닫기) 때 모두 놓음(T007과 같음). 수정 뒤 같은 탐침: canvas 35개 32,725,000 px, RSS 515 → 510 MB. DOM 가상화는 하지 않음(0×0 canvas는 비용이 작음) |
| P2-B 복합 연산 원자성 | CONTRACT DEFICIENCY(잠재) | 고정 WordCraft `select.range`는 위치를 `clamp`하므로 정상 입력으로는 실패하지 않는다(소스 확인). 실패를 주입하면 `InsertAt`·`ReplaceInserted`가 넣은 뒤 선택 되돌리기에서 거부 → `rejected [0]`·revision 0·dirty false인데 본문은 바뀜(Rust 3개 FAILED) | 여러 명령 사이에 되돌림이 없음 | WordCraft `Session::edit_snapshot`/`restore`(문서·선택·실행 취소 기록·dirty를 되돌리는 엔진 공개 계약, `session.rs` 확인)로 두 연산을 묶음. 스냅숏 복제는 이 두 연산(IME 예외 경로)에만 |
| P2-C 닫기 보호 | CONTRACT DEFICIENCY | Vitest: 편집 세션 객체가 없는 dirty 세션(`reconcile` 뒤)의 `DocumentWorkspace.close()` → 확인 없이 닫음. 실제 UI는 탭 표시줄이 모든 탭의 편집 객체를 바로 만들어 이 틈이 거의 드러나지 않는다(소스 확인). 실제 앱 시나리오(WebView 다시 시작 뒤 보지 않은 dirty 탭 닫기)는 수정 뒤 앱에서 확인 창이 뜨는 회귀 항목으로만 실행했다(수정 전 앱에서는 실행하지 않음) | `close()`가 편집 객체의 `hasUnpreservedChanges`만 봄(작업 공간 전체 판정은 백엔드 dirty도 봄) | `close()`도 같은 기준(백엔드 기록의 dirty 또는 편집 객체의 보내는 중·조합 중·uncertain) |

### 검증(최종 소스)

| 검사 | 결과 |
|------|------|
| `npm run typecheck`, `npm run lint`, `npm test` | 오류 없음, Vitest 500개(24파일, 기준 462 + 38) |
| `src-tauri`: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | 통과, 단위 86(기준 78 + 8) + 통합 1, 측정 1개 `#[ignore]` |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과(`cargo test` 뒤 다시 빌드) |
| `wordcraft_poc.py --font-home …`(Xvfb X11 DPR 1.041) | 44/44(기존 33 + 새 11: 표 셀 탭 글자, 줄마다 나뉜 input, 실제 클립보드 붙여넣기, 9,000자, 제어 문자 안내, 그림 실패 표시·멈춤, 다시 그리기, 실제 클립보드 262,144자 64조각 297쪽, 스크롤 뒤 canvas 예산, 다시 그림, 다시 시작 뒤 보지 않은 dirty 탭 닫기 확인) |
| 같은 명령(헤드리스 weston DPR 1) | 43/43(실제 클립보드 항목은 키보드 seat가 없어 건너뜀, 여러 쪽은 4,000자 넣기 60번 122쪽) |
| `tauri_smoke.py`(weston) · `rhwp_poc.py`(weston) | 62/62 · 64/64 |
| `wordcraft_poc.py --ime`(Xvfb + ibus 1.5.33 + ibus-hangul 1.5.5, xdotool 실제 키) | 필수 7/7 PASS 4회, 선택: 탭 전환 PASS 4회, 창 초점 이동(gtk3-widget-factory 창) PASS 1회(1회는 다른 창을 주지 않았고 2회는 창 이름이 맞지 않아 NOT RUN), 새 선택 항목 "선택 위 조합 확정"·"선택 위 조합 취소(BackSpace로 비움)" PASS 4회 |
| `rhwp_poc.py --ime`(같은 환경) | 필수 7/7 PASS 2회, 탭 전환 PASS 2회, 창 초점 PASS 1회 |
| `check-sensitive-info.py <바뀐 파일 15개>` | 통과 |

### 측정

- 키 반영(키만 친 시나리오 80–81개, 간격 150 ms): Xvfb p50/p95/최대 36/54/407 ms, weston 32/47/63 ms(T008: 47–59 ms). 같은 실행의 전체
  표본 p95 247·246 ms는 시험기가 WebDriver로 상태를 묻는 앞 시나리오가 섞인 값이다(T008: 206–267 ms). 실행 중 load average 1–6(다른 작업 있음).
- 엔진(개발 빌드, `붙여넣기_한도_측정`): 1,048,576자 256조각 한 요청 넣기 0.36 s, 그 결과 683쪽 문서의 배치까지 3.1 s, 그 뒤 글자 하나 58 ms.
  실제 앱: 실제 클립보드 262,144자(64조각, 4,096문단) 붙여넣기 → 화면 반영 2.6 s, 9,000자 0.55–0.82 s.
- 여러 쪽 스크롤: 297쪽(Xvfb) 화면 canvas 35개 32,725,000 px, 122쪽(weston) 38개 32,744,448 px.

### 남은 한계

- execCommand처럼 줄마다 나뉜 input은 input마다 연산 하나다(연산마다 문서 모델 복제·비교). 줄이 아주 많을 때의 시간은 재지 않았다(실제
  클립보드 붙여넣기는 input 하나라 조각 수만큼만). CRLF가 그 경로로 오면 WebKit이 `\r`을 글자로 남겨 빈 문단이 하나 더
  생길 수 있다(execCommand 경로만, **2차 안정화에서 실측·고침**).
- 문단 나누기는 `text.insert`의 Enter 의미(빈 목록 항목에서 목록을 끝냄)다. WordCraft의 붙여넣기 의미(`paste_text`)는 IPC로 열지 않았다.
- 시험기 수정: `idle()`이 창 높이로 보이는 쪽을 정해, 여러 쪽 문서에서 스크롤 영역 아래(앱이 그리지 않는 자리)에 걸친 쪽을 기다리다 시간
  초과가 났다 → 앱과 같이 `.editor__scroll` 사각형으로. 넣기 뒤에는 revision이 바뀐 것을 본 뒤 기다린다(React 반영 전 상태를 읽던 경합).
  WebKitWebDriver 연결 끊김(앱·WebProcess는 살아 있음)이 weston 실행 2번·Xvfb 1번 있었다(T008 기록과 같은 현상, 다시 실행해 통과).
- 화면 canvas 2D 문맥 없음은 감지하지 않는다(화면 밖 래스터만, **2차 안정화에서 고침**). 백엔드 래스터 기억은 세션마다 4개(최대 4 × 64 MiB)이고 문서 수만큼 늘어난다.
- 실제 GPU 데스크톱·Wayland IME·fcitx5·Windows/macOS는 확인하지 않았다(T007·T008과 같음). 그래서 체크박스 정책은 그대로다.

## T008 2차 안정화: 화면 canvas 그리기·그림 수명·복합 연산 뒤 어댑터 기억·CRLF (2026-10-19)

- 상태: **이 환경에서 구현·검증 완료(체크는 T007·T008과 같은 플랫폼 기준으로 보류)**. 기준 `3f8a885`(master, 작업 트리 깨끗, submodule
  rhwp `1a76570`·wordcraft `fc41918` 그대로). W-A·IPC 권한(`DocxOp` 목록, 새 연산 없음)·revision 권한(`SessionRegistry`)·저장 없음은 그대로다.
- 수정 전 확인: 새 회귀 시험을 수정 전 구현에 먼저 돌렸다 — Vitest 세션 시험 23개 중 22개, 표면 시험 11개 중 6개 실패(나머지는 바뀌지 않아야
  하는 동작의 보호 시험: LF·CR·붙여넣기·다시 불러오기). Rust 새 시험 6개 중 5개 실패(나머지 하나는 끼어든 변경이 앞 넣기를 끝내는 보호 시험).
  실제 앱도 수정 전 소스로 따로 빌드해 같은 탐침으로 비교했다(Xvfb X11, WebKitGTK 2.54.1).

| 지적 | 판정 | 증거(수정 전) | 원인 | 수정 |
|------|------|---------------|------|------|
| A 화면 canvas 거짓 성공 | CONFIRMED DEFECT | 실제 앱: 문서에 붙은 canvas의 `getContext`가 `null`을 주게 한 뒤 키 하나 → 쪽 `data-current=true`, 실패 표시 없음, 입력 가능, 화면 픽셀은 앞 판 그대로. 문맥을 되돌려도 다시 그리지 않음(같은 판이라 painted로 건너뜀). Vitest: `null`이면 `firstPaintMs`가 남고, `getContext`·`drawImage` 예외는 `paint()` 밖으로 나감 | `paint()`가 `context?.drawImage` 뒤 결과와 상관없이 painted·첫 그림 시간을 기록 | 실제로 옮긴 뒤에만 painted·`firstPaintMs`. 실패는 백엔드 그림 실패(`failures`)와 따로 `paintFailures`에 센다(그 래스터·판, PNG를 다시 받지 않음). 실패한 canvas는 다음에 쪽 전체를 옮김. 같은 간격(250·500 ms)·`MAX_RENDER_ATTEMPTS`번 뒤 그 쪽을 그리지 못했다고 보이며 편집을 멈추고(보이던 조합은 한 번 확정), 다시 그리기·새 판에서 다시 옮김. 보이지 않는 쪽의 실패는 세지 않음. 쪽 `data-current`와 키 반영 시간은 화면에 옮긴 판(`isShown`) 기준 |
| B 놓은 뒤 늦은 그림 | CONFIRMED DEFECT | 실제 앱: 다른 탭 표면이 쪽 전체 PNG 디코드를 기다리는 동안 원래 탭으로 돌아온 뒤 그 디코드를 끝내면, 놓은 표면의 세션에 850×1100 화면 밖 래스터가 다시 생김(표면 없이 메모리 유지). 띠 응답은 기준 래스터가 없어 버려짐(그래서 첫 탐침의 편집 뒤 탭 전환은 재현되지 않음). Vitest: 응답 전·디코드 중 놓기 뒤 래스터 부활, 옛 요청의 `finally`가 같은 키의 새 요청 기록을 지워 중복 요청, 늦은 거부가 다시 들어온 표면의 요청을 미룸, 늦은 세션 오류가 편집기를 failed로 | `releaseRendering()`이 epoch을 바꾸지 않고(편집 모델 수명), 요청 기록이 키만 가진 `Set` | 그림 수명 `renderLife`(놓을 때마다 +1)와 요청마다 토큰(`Map<key, request>`, 끝나면 자기 것만 지움). 응답 뒤·디코드 뒤마다 같은 epoch·그림 수명·ready인지 확인, 아니면 래스터·실패·알림을 바꾸지 않고 버림(그림은 닫음). epoch·불러오기 시도·그림 수명은 따로이며 놓기는 편집·조합·revision을 바꾸지 않음. 래스터 예산·띠 최적화 그대로 |
| C1 거부한 `InsertAt`의 자리 표시 | CONTRACT DEFICIENCY(주입으로만) | Rust 주입(`caret.set`·`text.insert`·`select.range` 거부): 문서·선택·실행 취소·dirty는 되돌아오지만 자리 표시가 사라져 같은 자리에 다시 넣기 거부 | 넣기 전에 `marks.remove` | 성공한 뒤에만 지움(거부하면 문서가 스냅숏 그대로라 그 자리의 뜻도 그대로). 프런트엔드는 거부한 연산을 다시 보내지 않으므로 사용자 경로에서 드러나지는 않았다 |
| C2 거부한 복합 연산 뒤 `last_insert` | CONTRACT DEFICIENCY(주입으로만) | Rust 주입: `ReplaceInserted` 실패 → `restore`가 WordCraft `rev()`를 올려 넣은 직후 그대로인 글자를 더는 고칠 수 없음. 거부한 `InsertAt`도 앞 넣기의 고치기·`Pointer.before_insert`를 막음 | `restore`(엔진 계약: 판을 올림, `session.rs` 확인)와 판으로 유효성을 보는 `recent_insert` | `atomic()`이 되돌린 뒤, **연산 전에 유효했던** 앞 넣기만 그 판을 새 판으로 옮김(문서가 스냅숏과 같으므로 넣은 글자가 그 자리에 있고 사이 변경이 없음). 그 뒤 문서를 바꾼 연산·성공한 복합 연산은 여전히 앞 넣기를 끝냄(시험). 무조건 고쳐 쓰지 않음 |
| D 비동기 그림 경로의 예외 | CONFIRMED DEFECT | Vitest: 화면 밖 canvas 만들기·크기·`getContext`·`drawImage` 예외, 백엔드 호출 거부(reject)가 처리되지 않은 거부(unhandledRejection)가 되고 그림 실패로 세지 않음. 띠를 덮다 난 예외는 반쯤 덮은 래스터를 남김 | `.then(...).finally(...)`에 거부 처리 없음, `applyRender`에 예외 처리 없음 | `renderPage()`: 백엔드 거부 → `Protocol` 거부로, 디코드(동기 예외 포함) → 디코드 실패, `applyRender` 예외 → 그 쪽 래스터를 놓고 canvas 실패(다음은 쪽 전체). 기록은 `finally`에서 한 번, 실패 처리 자체의 예외는 마지막 `catch`가 이 요청만 끝냄. 시도 수는 같음(끝없는 재시도 없음) |
| CRLF 나뉜 input | CONFIRMED DEFECT(실측) | 실제 앱 `execCommand('insertText', …)`: `가\r\n나` → input `insertText "가\r"`·`insertParagraph`·`insertText "나"` → 빈 문단 하나 더. `\r\n\r\n`은 둘 더, 끝의 `\r\n`도 하나 더. LF·LF 둘·CR만(input 하나)·실제 클립보드 붙여넣기(input 하나)는 맞음 | WebKit이 `\n`에서만 줄을 나눠 `\r`이 앞 조각에 글자로 남고, `textOps`가 그 `\r`을 문단 나누기로 바꾼 뒤 `insertParagraph`도 `\n`이 됨 | DOCX `paragraphBreaks`에서 `\r`로 끝난 `insertText` input **바로 다음 input**인 `insertParagraph`는 넣지 않음(다른 input·키·조합 시작·초점 잃음이 사이에 오면 잊음). 처음에는 같은 디스패치(microtask까지)로 묶었으나 실제 WebKit은 나눈 input 사이에 microtask를 돌려(실측) 고쳐지지 않았다 → 이벤트 순서로. 빈 줄은 줄이지 않음(연속 줄바꿈을 지우는 추정 없음). rhwp 동작 그대로 |

### 검증(최종 소스)

| 검사 | 결과 |
|------|------|
| `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` | 오류 없음, Vitest 534개(26파일, 기준 500 + 34) |
| `src-tauri`: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | 통과, 단위 92(기준 86 + 6) + 통합 1, 측정 1개 `#[ignore]` |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과(최종 소스) |
| `wordcraft_poc.py --font-home …`(Xvfb X11 DPR 1.041) | 52/52(기존 44 + 새 8: CRLF·CRLF 빈 줄·끝의 CRLF·LF 빈 줄 문단 구조, 화면 canvas 문맥 없음 표시·멈춤, 다시 PNG 없이 다시 그림, 탭 전환 중 늦은 디코드가 래스터를 되살리지 않음·돌아온 탭 지금 판, 돌아온 탭 입력) 2회. 그 밖의 3회는 WebKitWebDriver 연결 끊김(아래) |
| 같은 명령(헤드리스 weston DPR 1) | 51/51(실제 클립보드 항목은 키보드 seat가 없어 건너뜀) |
| 같은 명령, 수정 전 소스로 빌드한 앱(Xvfb) | 새 CRLF 항목 실패(`["", "나x…"]`, revision +3, 빈 문단 하나 더) — 탐침(아래)과 같은 결과 |
| `tauri_smoke.py`(weston) · `rhwp_poc.py`(weston) | 62/62 · 64/64 |
| `wordcraft_poc.py --ime`(Xvfb + ibus 1.5.33 + ibus-hangul 1.5.5, xdotool 실제 키) | 필수 7/7 PASS 3회, 선택: 탭 전환·선택 위 조합 확정·선택 위 조합 취소 PASS 3회, 창 초점 이동 NOT RUN(다른 창을 주지 않음) |
| `rhwp_poc.py --ime`(같은 환경, `textInput.ts`를 같이 씀) | 필수 7/7 PASS 2회, 탭 전환 PASS 2회, 창 초점 NOT RUN |

실제 앱 탐침(수정 전·뒤 같은 스크립트, Xvfb): 화면 canvas 문맥 없음 — 수정 전 `current=true`·실패 표시 없음·입력 가능·화면 그대로·문맥을 되돌려도
다시 그리지 않음 / 수정 뒤 `current=false`·실패 표시·입력 멈춤, 다시 그리기 시도 3번, 되돌린 뒤 다시 그리기로 화면이 실제로 바뀜. 탭 전환 중 늦은
쪽 전체 디코드 — 수정 전 놓은 표면에 850×1100 래스터가 다시 생김 / 수정 뒤 0개(그림은 닫음). CRLF — 위 표.

### 측정

- 키 반영(키만 친 시나리오 80–81개, 간격 150 ms): 수정 뒤 Xvfb p95 54·55·57·59·71 ms(5번 실행), weston 46 ms. 같은 날 수정 전 소스 앱 Xvfb 55 ms.
  1차 안정화 기록은 54·47 ms. 화면 그리기 경로에 더한 것은 쪽마다 Map 조회 하나와 try뿐이고 띠만 옮기기는 그대로다(화면 canvas가 실패한
  뒤에만 쪽 전체). 키만 친 시나리오의 값이며 모든 부하에서 150 ms를 보장하지 않는다(같은 실행의 전체 표본 p95는 212–327 ms, 다른 작업과 겹침).
- 여러 쪽 스크롤: 297쪽(Xvfb) 화면 canvas 35개 32,725,000 px, 122쪽(weston) 38개 32,744,448 px — 128 MiB 예산 그대로(1차 안정화와 같은 값).

### 시험기·환경에서 알게 된 것(앱 동작이 아님)

- 세션 D-Bus 없이 Xvfb·weston을 띄우면 GLib가 `dbus-launch --autolaunch`로 세션 버스를 띄워 시나리오 뒤에 남고, 시험기의 "남은 프로세스" 검사가
  실패한다. 시험 실행을 `dbus-run-session`으로 감싸면 없다(시험 환경 보정).
- WebKitWebDriver 연결 끊김(`Remote end closed connection`, 앱은 살아 있음): Xvfb 실행 7번 중 수정 뒤 앱 3번(297쪽 스크롤 2번, 시작 탐침 1번),
  수정 전 앱 1번(지연 시나리오). 1차 안정화 기록(weston 2번·Xvfb 1번)과 같은 현상이며 수정 전 앱에서도 일어나 이번 수정 때문이라는 근거는 없다.
- `__TAURI_INTERNALS__.invoke`는 바꿀 수 없어(writable false) 실제 앱에서는 IPC 응답 대신 PNG 디코드(`createImageBitmap`)를 붙잡아 늦은 응답을 재현했다.
  백엔드 응답 자체를 붙잡는 경우는 Vitest로만 확인했다.

### 남은 한계

- 화면 canvas 실패 재현은 `getContext`를 막는 주입이다. 실제 GPU 프로세스 손실·메모리 부족에서 WebKit이 어떻게 실패하는지는 확인하지 않았다.
- CRLF 규칙은 "`\r`로 끝난 `insertText` input 바로 다음 input인 `insertParagraph`"다. 같은 순서를 다른 경로(프로그램이 `\r`로 끝난 글자를 넣고
  키 없이 따로 문단 나누기를 보냄)로 만들면 그 문단 나누기도 넣지 않는다(그 `\r`이 이미 문단을 나눔). WebKitGTK 2.54 밖의 나누기 방식은 보지 않았다.
- 거부한 복합 연산은 프런트엔드가 다시 보내지 않는다(거부 수만 보임). C1·C2 수정은 같은 요청의 뒤 연산과 엔진 계약을 위한 것이다.
- 실제 GPU 데스크톱·Wayland IME·fcitx5·Windows/macOS는 확인하지 않았다(T007·T008과 같음). 체크박스 정책은 그대로다.

## T008 3차 안정화: 화면에 보임·복합 연산 뒤 WordCraft 보조 상태·그림 경로의 정리 예외 (2026-10-19)

- 상태: **이 환경에서 구현·검증 완료(체크는 T007·T008과 같은 플랫폼 기준으로 보류)**. 기준 `095237b`(master, 작업 트리 깨끗, submodule
  rhwp `1a76570`·wordcraft `fc41918` 그대로). W-A·IPC 권한(`DocxOp` 목록, 새 연산 없음)·revision 권한·저장 없음은 그대로다.
- 수정 전 확인: 새 Vitest 9개 중 8개, 새 Rust 시험 3개 중 2개가 수정 전 구현에서 실패했다(나머지는 바뀌지 않아야 하는 동작의 보호 시험).

| 지적 | 판정 | 증거(수정 전) | 원인 | 수정 |
|------|------|---------------|------|------|
| A `isShown()`이 실제 화면 그리기를 보지 않음 | CONTRACT DEFICIENCY | Vitest: 래스터만 받고 화면 canvas에 옮기기 전, 새 판의 띠를 받고 옮기기 전, 놓은 뒤 다시 받은 래스터, 보이지 않는 쪽의 그리기 실패에서 모두 `isShown() = true`. 표면에서는 렌더 때 `data-current`를 계산하고 같은 동기 작업의 layout effect가 곧 그리므로, 실패하면 곧 다시 렌더되어 사용자·WebDriver가 어긋난 값을 볼 틈은 찾지 못했다(실제 앱 재현 없음) | 2차 안정화의 `isShown`이 `isCurrent && 실패 기록 없음`이고, canvas마다의 `painted` 기록을 보지 않음 | 쪽마다 활성 화면 canvas(`screens`, 표면이 마지막으로 `paint`에 준 canvas)를 두고, 그 canvas에 지금 래스터·판을 옮긴 기록이 있을 때만 보임. 다른 canvas·놓기 전 기록은 근거가 아님, 놓기(`releaseRendering`)가 활성 기록도 지움. 표면은 `data-current`를 렌더 때가 아니라 layout effect의 그리기 뒤에 쓴다(추가 렌더 없음). 띠만 옮기기·첫 그림 시간·키 반영 측정은 그대로(측정도 `isShown` 기준) |
| B 복합 연산 뒤 WordCraft 보조 상태 | CONFIRMED DEFECT(주입으로만, `goal_x`) · 상태 차이(`pending`) | 고정 WordCraft 확인: `caret.set`은 `goal_x`·`pending`을 지우고(`cmd/caret.rs` `set`·`apply`), raw `text.insert`는 `goal_x`를 지운다(`cmd/mod.rs`). `select.range`는 선택만. `edit_snapshot`/`restore`는 둘 다 담지 않는다. Rust 주입: ↓로 짧은 문단에 내려온 뒤(지키는 x 있음) `InsertAt`·`ReplaceInserted`가 `text.insert`·`select.range`에서 거부되면, 다음 ↓가 대조 모델 `body:2:33` 대신 `body:2:3`(짧은 문단 끝의 x). `pending`(웹 주소 뒤 Enter의 자동 고침이 정함)은 거부 뒤 `None`으로 남지만, 그 뒤 글자 서식·문서·실행 취소 기록은 대조와 같았다(관측 차이 없음) | `restore`가 스냅숏 밖 상태를 되돌리지 않음 | `atomic()`이 거부했을 때만 `goal_x`·`pending`을 연산 전 값으로(성공하면 엔진이 정한 대로). `page_hint`는 이 명령들이 바꾸지 않고(`pos` 형식), `edit_marks`·`last_command`·`column`은 IPC로 열지 않은 명령(`edit.goBack`·`edit.repeat`·단 선택)만 읽으므로 되돌리지 않음. 세션 전체 복제 없음 |
| C 그림 경로의 정리·알림 예외 | CONFIRMED DEFECT(주입) | Vitest: 래스터 예산으로 놓던 canvas가 크기 0에서 예외를 내면 `trimRasters`가 멈춰 예산 밖 래스터가 남음(45쪽에서 38,776,320 px > 33,554,432 px), 반영한 쪽의 알림도 빠짐. `releaseRendering()`·놓은 쪽의 `paint()`는 예외를 그대로 냄(요청·실패 기록을 놓지 못함). 구독자 하나의 예외가 다른 구독자 알림을 막고 마지막 `.catch`가 조용히 삼킴 | 정리를 보호하지 않고, 마지막 `.catch(() => {})`가 모든 예외를 숨김 | canvas 놓기는 할 수 있는 만큼만(`releaseCanvas`, 예외가 나도 기억에서는 뺌). 구독자마다 격리하고 예외는 `reportError`로 보고. `renderPage` 전체를 한 경계로: 기대하지 않은 예외는 보고하고, 지금 요청이며 그 쪽이 지금 판이 아니면 `unexpected` 실패로 셈(시도 수 같음, 옛 요청은 지금 상태를 바꾸지 않음). 마지막 `.catch`도 보고(처리되지 않은 거부 없음). `bitmap.close()` 예외는 앞 결과를 덮지 않고 보고 |

### 검증(최종 소스)

| 검사 | 결과 |
|------|------|
| `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` | 오류 없음, Vitest 543개(26파일, 기준 534 + 9) |
| `src-tauri`: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | 통과, 단위 95(기준 92 + 3) + 통합 1, 측정 1개 `#[ignore]` |
| `VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` | 통과(최종 소스) |
| `wordcraft_poc.py --font-home …`(Xvfb X11 DPR 1.041) | 52/52 — 첫 그림·편집 뒤 띠 그림·지금 판 화면 그리기(`data-current`는 이제 그린 뒤 값)·화면 canvas 문맥 없음과 회복·탭 전환과 돌아오기·놓은 뒤 다시 그림·문서 내용 유지 포함 |
| 같은 명령(헤드리스 weston DPR 1) | 51/51(실제 클립보드 항목은 키보드 seat가 없어 건너뜀) |
| `tauri_smoke.py`(weston) · `rhwp_poc.py`(weston) | 62/62 · 64/64 |
| `wordcraft_poc.py --ime`(Xvfb + ibus 1.5.33 + ibus-hangul 1.5.5, xdotool 실제 키) | 필수 7/7 PASS 3회(선택 3항목도 PASS, 창 초점 NOT RUN) |
| `rhwp_poc.py --ime`(같은 환경) | 필수 7/7 PASS 2회(탭 전환 PASS, 창 초점 NOT RUN) |

- 실제 앱에서 주입한 것은 2차와 같은 화면 canvas 문맥 막기·디코드 붙잡기다. C의 정리 예외(크기 0 설정이 예외)와 구독자 예외는 Vitest 주입으로만
  확인했다(실제 WebKit에서 그 setter가 예외를 내는 조건은 찾지 못함). 실제 GPU 프로세스 손실은 확인하지 않았다.
- 측정: 키 반영 p95(키만 친 80–81개) Xvfb 55 ms, weston 46 ms(2차 54–71·46 ms). 여러 쪽 스크롤 297쪽 화면 canvas 35개 32,725,000 px,
  122쪽 38개 32,744,448 px(128 MiB 예산 그대로). rhwp 키 반영 p95 30·29 ms. 모든 부하에서 150 ms를 보장하는 값이 아니다.

### 남은 한계

- `isShown`의 활성 canvas는 표면이 마지막으로 `paint`에 준 canvas다. 표면 밖에서 canvas를 바꾸고 `paint`를 부르지 않으면 앞 canvas를 기준으로 본다
  (표면은 렌더마다 모든 쪽을 `paint`하므로 이 경로는 없다).
- `pending` 되돌리기는 대조 모델과 상태를 맞추는 수정이다. 시험한 경로(웹 주소 뒤 Enter)에서는 수정 전에도 다음 글자 서식이 같았다.
- 실제 GPU 데스크톱·Wayland IME·fcitx5·Windows/macOS는 확인하지 않았다(T007·T008과 같음). 체크박스 정책은 그대로다.
