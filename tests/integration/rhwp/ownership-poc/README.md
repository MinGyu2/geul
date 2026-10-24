# T010 격리 renderer 소유권 native PoC

이 디렉터리는 일반 Vite 설정이나 제품 코드가 불러오지 않는다. 완성 패치를 적용한 별도 WASM 패키지와 Chrome/WebKit 안전 관문이 모두 통과한 경우에만 명시적 시험 서버가 실행된다. `public/rhwp` 및 submodule을 교체하지 않는다. 판정과 제한은 `../evidence/t010-render-ownership/REPORT.ko.txt`에 기록한다.

`session.mjs`는 기존 `RhwpEditorSession`의 loader에 후보를 주입한다. 하나의 WASM 모듈 listener가 최대 8개 session에 완료 알림을 합쳐 전달한다. 문서마다 하나의 job과 최대 256개 Canvas 요청 메타데이터를 소유하며, 세대·모델 판·연결 상태를 다시 검사한다. listener는 직접 그리지 않는다. `vite.config.mjs`의 시험 변환은 비동기 대기 프레임을 완료로 기록하지 않도록 Surface의 호출 지점도 바꾼다. 운영 파일은 수정하지 않는다.

먼저 cache-concurrency README의 prepare/build 절차로 최종 패키지를 만든다. 패키지의 `ENGINE.json`은 빌드 전후 소스 일치 및 실제 산출물 해시를 기록해야 한다. 이 작업의 검증 패키지는 `ownership-final-package`이며 진단용 `ownership-package`와 구별한다.

저장소 루트에서 실행한다. 아래 경로 변수는 설치된 도구의 절대 경로로 지정한다. `APP`은 기존 Tauri debug/dev 서버 접속 바이너리, `CANDIDATE`는 위 최종 패키지 디렉터리다. Python 외 추가 Python 패키지는 없다.

```sh
GEUL_T010_OWNERSHIP_POC=1 VITE_GEUL_TEST_HOOKS=1 \
GEUL_T010_CANDIDATE="$CANDIDATE" npm run dev -- \
  --config tests/integration/rhwp/ownership-poc/vite.config.mjs \
  --host 127.0.0.1 --port 1420 --strictPort
```

다른 터미널에서 실행한다. 관리되는 D-Bus 세션은 Xvfb 앱이 자동 시작한 `dbus-launch`/`dbus-daemon`이 시험의 임시 XDG 디렉터리와 함께 남는 문제를 막는다. 종료 검사와 실패 판정은 그대로 사용한다.

```sh
dbus-run-session -- python3 tests/integration/rhwp/ownership-poc/native.py \
  --extended --matrix --app "$APP" --driver "$TAURI_DRIVER" \
  --webkit-driver "$WEBKIT_DRIVER" --xvfb "$XVFB" \
  --output /tmp/ownership-native.json
```

이 검사는 생성한 HWP/HWPX의 이미지·표와 세 구역의 실제 native RGBA를 pinned 렌더와 비교한다. 50/100/150% 확대·스크롤, PENDING 중 확대 교체·닫기, 닫은 이미지의 늦은 이벤트와 새 문서의 픽셀, 공유 listener, 256/384/512 MiB 단일/다중 문서 cold/warm·RSS·trim을 기록한다. host에서 관찰한 repaint 시간은 공식 D4 입력 지연이 아니다. RSS는 관측값이며 예산의 하드 상한이 아니다. 문서는 임시 생성물 또는 공개 예제의 임시 복사본만 사용한다.

공식 D4는 위 서버를 종료한 뒤 다음 명시적 시험 모드로 다시 실행한다. 기존 history 시험 플래그는 이 별도 모드에서만 허용한다. 일반 제품의 Undo/Redo 정책은 바뀌지 않는다. 두 native 측정을 동시에 실행하지 않는다.

```sh
GEUL_T010_OWNERSHIP_POC=1 GEUL_T010_HISTORY_PERF_ONLY=1 \
VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 \
GEUL_T010_CANDIDATE="$CANDIDATE" npm run dev -- \
  --config tests/integration/rhwp/ownership-poc/vite.config.mjs \
  --host 127.0.0.1 --port 1420 --strictPort

dbus-run-session -- python3 tests/integration/rhwp/ownership-poc/history-perf.py \
  --app "$APP" --driver "$TAURI_DRIVER" --webkit-driver "$WEBKIT_DRIVER" \
  --xvfb "$XVFB" --xdotool "$XDOTOOL" --output /tmp/ownership-history-perf.json
```

`history-perf.py`는 기존 `undo_native.scenario_perf`와 `MEASURE`를 그대로 호출한다. 계측 모듈 URL만 후보로 연결한다. 문서당 새 앱 세션, native X11 키, 기존 4문서·50% 배율·30 group-start/extend·20 Undo/Redo·5 Undo 뒤 입력을 유지한다. p95 50 ms/Undo 1,500 ms 기준을 넘으면 종료 코드 1이다. 실패도 유효한 측정 결과로 보존한다.

`typing.py`는 history 비활성 진단용이다. 공식 history 성능 결과와 합치지 않는다. 과거의 설정 재로드 중단·자동 D-Bus 정리 실패는 별도 JSON으로 보존한다.

## Resource scheduler 후보

새 complete patch와 두 브라우저 gate가 승인된 패키지에는 `GEUL_T010_SCHEDULER_POC=1`을 추가한다.
이 모드는 `t010-resource-scheduler`의 gate와 정확한 candidate WASM을 검사한다. 새 모드에서 history
시험 플래그는 켜지 않는다. 일반 build와 public WASM은 그대로다.

```sh
GEUL_T010_OWNERSHIP_POC=1 GEUL_T010_SCHEDULER_POC=1 VITE_GEUL_TEST_HOOKS=1 \
GEUL_T010_CANDIDATE="$CANDIDATE" npm run dev -- \
  --config tests/integration/rhwp/ownership-poc/vite.config.mjs \
  --host 127.0.0.1 --port 1420 --strictPort

dbus-run-session -- python3 tests/integration/rhwp/ownership-poc/native.py \
  --extended --matrix --scheduler --app "$APP" --driver "$TAURI_DRIVER" \
  --webkit-driver "$WEBKIT_DRIVER" --xvfb "$XVFB" --output /tmp/scheduler-native.json
```

`--scheduler --scheduler-only`는 이미 검증한 기존 44개를 다시 실행하지 않고 집중 검사만 실행한다.
출력 scope도 이를 구별한다. 이번 증거는 기존 44개 실행 부분과 focused 11개(초기화 2+추가 9)를 별도로
기록하며, 앞선 전체 runner 실패를 전체 PASS로 바꾸지 않는다. focused 내부에 실제 WebView engine의
scheduler 48개 실행이 포함된다. 문서 세션을 통한 포화 후 이미지, 동일 요청 50회, 완료 픽셀, PENDING 중
탭 전환·늦은 응답·공유 close·마지막 lease 반납은 실제 geul session에서 검사한다.

`probeEngine()` observer는 시험에만 쓰며 원 module listener를 교체하지 않는다. 새로운 observer가
별도 문서 모델이나 snapshot/history를 보관하지 않는다. 정상 session hub는 계속 유일한 listener를 소유한다.
기준 public JS는 Vite 소스 import 대상으로 만들지 않고 기존 WebDriver의 runtime import로 전달한다.
`node --test tests/integration/rhwp/ownership-poc/test-session.mjs`는 모듈 loader만 fake engine으로 바꾼
10개 결정적 identity 계약 검사다. native 또는 실제 decoder 실행 증거와 구별한다.

## Lease-progress 후보의 추가 검증

새 evidence는 `t010-lease-progress`에 기록한다. 기존 PoC flag에
`GEUL_T010_EVIDENCE=<lease-progress evidence directory>`를 더해 해당 후보의 engine/browser gate와
WASM identity를 확인한다. 기존 전체 `native.py --scheduler --extended --matrix`와 별도
`--scheduler --scheduler-only`를 각각 실행하며, focused 결과로 기존44 검사를 대신하지 않는다.

후보 history/save 실패 경계는 `candidate-safety.py`로 실제 앱에서 검사한다.
`VITE_GEUL_TEST_RHWP_HISTORY=1 GEUL_T010_HISTORY_SAFETY_ONLY=1`의 명시적 시험 서버가 필요하다.
D4는 동일 native 입력·revision 관찰 RAF·추가2RAF 계약의 `history-perf.py --engine pinned|candidate`를
각각 실행한다. pinned arm만 `pinned-perf.vite.config.mjs`와 `GEUL_T010_PINNED_PERF_ONLY=1`을 사용한다.
두 arm의 렌더 경로와 WASM build provenance 차이가 있으므로 scheduler 수정만의 인과 효과라고 부르지 않는다.
D3/D5의 실제 검증 범위와 공식 D4 FAIL은 새 한국어 보고서에 구분한다. 모든 injection은 시험 config에만
있으며 production Undo/Redo와 formatting 지원·저장/preview 정책은 변경하지 않는다.

## 최종 안정화 실행

`GEUL_T010_EVIDENCE=<t010-final-stabilization evidence>`와 검증된 새 candidate package를 지정한다.
`GEUL_T010_DAMAGE_POC=1`이면 확인된 warm frame의 동일 paint 입력을 재사용하며,0이면 같은 후보의 Full 대조군이다.
변경된 모든 쪽은 Full이다. 정수·소수 지역 replay의 실제 native RGBA 차이 때문에 지역 재생 실험을 제거했으며, 새 `beginRenderPatchJob`도 Full로 실행한다. 길이0 HWP 문단의 기존 caret 좌표 결함은 별도 FAIL로 기록한다. 제품 config와 Session/Surface 파일은 수정하지 않는다.
요약은 최대64개·각262144·합계2097152 UTF-16 code unit로 제한한다(이전8개×개별 상한과 같은 합계). 초과 시 화면 밖 요약부터 LRU로 버려 표시 페이지의 damage 근거를 보호한다. 동일 요청의 job/decode/deadline 재시작은 하지 않는다.

- `native.py --scheduler --extended --matrix`: 기존 전체 기능+새 engine 검사.
- `native.py --scheduler --scheduler-only`: 별도 집중 검사(전체 검사를 대신하지 않음).
- `visual-native.py`: 실제 키/포인터·본문/셀/여러 구역 history, 부착된 Canvas readback을 별도 Full
  재생과 비교하며 caret/selection/scroll/zoom/revision을 확인한다. `HISTORY_SAFETY_ONLY` 시험 flag가 필요하다.
- `history-pending-native.py`: HTTP 이미지 응답을 실제 보류한 채 history·trim·문서 교체·늦은 콜백과 표시 RGBA를 확인한다.
- `candidate-safety.py`: 실제 저장·통제된 history 실패 경계. 동일 safety flag로 별도 실행한다.
- `performance-visual-native.py`: 성능용 네 문서의 같은 warm-up/배율/편집 위치에서 표시 RGBA·Undo/Redo를 별도 확인한다(성능 표본에 readback을 끼우지 않음).
- `history-perf.py --engine pinned|candidate`: 기존 공식 입력·RAF·표본·문턱을 그대로 쓰며,
  pinned/damage와 candidate Full/damage를 각각 별도 서버에서 순차 측정한다. `HISTORY_PERF_ONLY`와
  pinned 전용 config의 명시적 flag를 사용한다. `exitReason`은 관문 실패와 측정 누락/도구 오류를 구분한다.
- `ime-native.py`: 호환 GTK IBus module/IBus·hangul 엔진이 있을 때 격리된 Xvfb/DBus 실제 입력만
  실행한다. `--ibus-root --hangul-root --gtk-query --glib-compile --setxkbmap`과 공통 app/driver/xdotool 인자가 필요하다.
  Hangul이 요구하는 IBus config component도 격리된 D-Bus/XDG 디렉터리에서 실행한다.

모든 스크립트의 공통 `--app --driver --webkit-driver --xvfb --output` 인자와 actual argv·flags는 새 증거에
기록한다. 활성 native 실행 중 adapter/config를 편집하지 않는다. 실패한 중간 결과를 보존하고 원인을
교정한 뒤 별도 파일로 재실행한다. D1~D5와 제품 활성화 판정은 새 보고서의 검증 범위대로만 해석한다.

현재 adapter 단위 검사는 기존10개를 유지한23개다. `node --experimental-strip-types --test tests/integration/rhwp/ownership-poc/test-session.mjs`로 실행한다. fake loader 검사와 실제 native/decoder 결과는 합산하지 않는다.

`performance-visual-native.py --continue-after-caret-failure`는 실패 뒤 나머지 픽셀 진단을 수집한다. caret FAIL과 최종 exit1은 그대로 유지하며 이 옵션으로 D1을 PASS로 올리지 않는다.

`performance-visual-native.py`의 PASS는 선택한 문서 집합 전체에만 준다. 기본은 네 문서 엄격 실행(Full RGBA 참조24개)이고,
`--sample`은 네 fixture 이름 중 하나만 받는다(참조6개). 모르는 이름이나 빈 이름은 Xvfb/앱을 띄우기 전에 exit2로 거부한다.
문서 목록·참조(sample/frame/이름/순서)·verified·pixels0·maxDelta0·필수 assertion·세션/driver/display 정리가 모두 맞아야 PASS다.
공식 네 문서 목록은 이 harness의 `OFFICIAL_FIXTURES`에 직접 적으며 공유 `undo_native.LARGE`에서 만들지 않는다. 공개 예제가 없으면 실행 실패다.
필수 assertion은 실제 실행 순서 그대로 각각 정확히 한 번 나와야 하며 중복·예상 밖 이름·순서 바뀜은 FAIL이다.
`pixels`/`maxDelta`는 0 이상 정수(bool/실수/누락 불가)여야 하고, 참조의 sample/frame/이름은 엔진 반환값이 아니라 harness가 정한다.
Undo/Redo는 이름 붙은 필수 assertion(모델 revision·caret·복원 문단·exact frame)으로 검사한다. 이 harness는 `undo_native` gate를
만들지 않으므로 `historyGates`/`historyChecks`는 반드시 비어 있어야 하며, 빈 목록을 별도 history gate 통과로 보고하지 않는다.
`python3 -I -m unittest discover -s tests/integration/rhwp/ownership-poc -p 'test_*.py'`가 가짜 native 도구로 main()을 돌려
알 수 없는 sample·빈 선택·참조 누락·미검증/잘못된 픽셀 증거·중복/예상 밖 assertion·필수 caret 실패·정리 미완료를 거부하는지 검사한다.

`lifecycle-continuous-native.py`: 2문서×3모드×20회=120회를 한 앱/WebDriver 세션에서 연속 실행한다(`scenario_lifecycle` 그대로,
강제 GC·cache trim 없음, 요청 재시도 없음). 판정은 순수 함수 `lifecycle_evidence.classify`만 내린다. 모든 memory point(366개)가
sequence·문서·세션에 묶여 순서대로 있어야 하고, WebProcess는 정확히 하나·양의 정수 PID·`/proc` start time이 시작부터 끝까지 같아야
한다(PID 재사용 구분). RSS는 양의 정수여야 하지만 승인된 RSS 기준이 없어 판정은 항상 INCONCLUSIVE다. 닫힌 상태의 owner/Canvas/session/
job/lease/staging/backup/timer 정리, 선언 예산 필드(누락·변경 불가)와 상한, 엔진 detached Canvas가 decoded cache 상주 항목과 정확히
일치하는지 확인한다. 선언 예산은 renderer/cache 추정치이며 process RSS/GPU 상한이 아니다.
`cache-trim-native.py`: trim 없는 open/close 반복·idle 뒤 명시적 trim, 다시 열기를 별도로 실행하는 cache 소유 진단이다.
`d4-frame-attribution-native.py --graphics software|gpu`: 공식 `scenario_perf`/MEASURE 그대로에 revision 관찰자 하나를 더해
rendering update 작업과 다음 frame 대기를 나눈다. 관찰자가 일정을 조금 바꾸므로 그 실행의 지연 값은 공식 D4가 아니다.
실제 graphics backend는 `/proc`의 DRM fd·fdinfo engine counter·GL 라이브러리로 기록한다.
