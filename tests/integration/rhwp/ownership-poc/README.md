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
