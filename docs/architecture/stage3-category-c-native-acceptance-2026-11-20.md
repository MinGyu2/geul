# Stage 3-C Linux Native 수용 (2026-11-20)

형식별 판정, 실행 파일과 WASM 식별자, 저장 해시, 원시 실행 경로는 [Stage 3-C 실행 기록](stage3-c-native-acceptance-2026-11-20.json)에 있다. 전체 Stage 3의 상태는 **PARTIALLY COMPLETED**다.

이전 완료 응답의 **격리 세션 13개** 표기를 정정한다. 원본 실행 디렉터리에서 `session.json`, `cleanup.json`, `result.json`이 쌍을 이루는 고유 실행은 각각 **12개**였다. 그중 재검증 배치는 4개이며, 배치 안의 개별 WebDriver 앱 세션 종료는 **50건**이다. 기존 **13개 항목, 19개 형식별 PASS, 18개 게시·재열기** 판정은 그대로다. 후속 검증의 격리 세션 3개와 그 결과는 [별도 후속 기록](stage3-c-resize-followup-2026-11-20.json)에 보존했다.

Stage 3-C 시험은 실제 Tauri 앱을 격리된 Linux X11/Xvfb에서 실행한다. 문서는 GTK 열기 대화상자로 연다. 개체와 편집 조작부는 WebDriver 포인터로 선택하고 키보드 입력은 xdotool을 사용한다. 문서 관찰에는 편집기 상태와 독립 RHWP 또는 DOCX 패키지 검사를 사용한다. C05의 한국어 입력은 실제 IBus Hangul 조합이다. 발행된 HWP/HWPX에는 앱 보존 검사가 적용된다.

## 재실행

Release 앱, Release RHWP 매니페스트와 아티팩트, xdotool, Xvfb, IBus 및 `tauri-driver`와 `WebKitWebDriver`가 필요하다. `WebKitWebDriver`는 PATH에 둔다. 앱을 다시 만들 때는 `VITE_GEUL_TEST_HOOKS=1 npm run tauri -- build --no-bundle`을 사용한다. 보존된 실행 디렉터리를 덮어쓰지 않도록 새 경로를 지정한다.

```sh
run=target/stage3c-native/replay
fixtures="$PWD/$run/fixtures"
mkdir -p "$fixtures"

GEUL_STAGE3_OUT="$fixtures" node_modules/.bin/vitest run \
  --config scripts/tests/vitest.config.ts \
  stage3-object-edit.wasm.test.ts stage3-shapes.wasm.test.ts \
  -t 'edits and deletes HWP pictures|newly inserted HWP rectangle|positions a plain|reorders existing HWP|resizes a depth-2|multipara|existing paragraph|copies, cuts|group container|outer geometry'
python3 scripts/tests/stage3-c-docx-fixture.py "$fixtures/c03-original.docx"
# Set wordcraft_rlib and cfb_rlib to the Release build's WordCraft Engine and cfb 0.14 rlibs.
rustc --edition=2024 -L dependency=src-tauri/target/release/deps \
  --extern wordcraft_engine="$wordcraft_rlib" scripts/tests/stage3-c-docx-normalize.rs \
  -o "$run/normalize-docx"
"$run/normalize-docx" "$fixtures/c03-original.docx" "$fixtures/c03-canonical.docx"
rustc --edition=2024 -L dependency=src-tauri/target/release/deps \
  --extern cfb="$cfb_rlib" scripts/tests/stage3-c-hwp-chart-fixture.rs -o "$run/hwp-chart-fixture"
"$run/hwp-chart-fixture" external/rhwp/samples/issue7406/7406_OLE__CHART.hwp \
  "$fixtures/gso-original.hwp" "$fixtures/c12-blank-preview-original.hwp"
node scripts/tests/stage3-c-caption-fixtures.cjs "$fixtures"

python3 -O scripts/tests/native-ibus-session.py \
  --hangul-initial-mode hangul --hangul-disable-latin --out "$run/session" -- \
  python3 -O scripts/tests/native-stage3-c.py --out "$run/run" --fixtures "$fixtures" \
    --xdotool @XDOTOOL@ --ibus @IBUS@ --cases \
    C01 C02 C03 C04-hwp C04-hwpx C05 \
    C06 C07-hwp C07-hwpx C08-hwp C08-hwpx C09-hwp C09-hwpx \
    C10 C11 C12-hwp-blank C12-hwpx-bar C13-hwp C13-hwpx
```

`result.json`은 각 앱 실행의 확인 내용을 보존한다. `session.json`과 `cleanup.json`은 실행기 및 프로세스·파일시스템 정리 근거를 보존한다. 오류가 난 시나리오에는 화면 캡처, 드라이버 로그 및 가능한 경우 앱 상태가 남는다. 저장본과 원본 fixture는 `target/stage3c-native/` 아래 보존한다. 이 파일들은 로컬 검증 산출물이다.

C03은 WordCraft가 직렬화한 패키지를 시험 원본으로 사용한다. 최초 최소 OOXML 패키지에서는 앱이 기본 파트 추가를 안전 저장 검사에서 차단했다. C07의 GTK 목록은 WebDriver의 항목 클릭과 신뢰된 `change` 이벤트로 확인했다.

C12의 재실행 명령은 기존 T009에서 인정하는 빈 미리보기를 가진 원본 fixture를 사용한다. 미리보기 외 원본 차트, 소유 관계와 리소스는 유지한다. 배포 앱이 실제로 게시한 파일을 독립 검사한다. 비어 있지 않은 미리보기와 다른 패키지 구조에서 발생한 저장 거부는 집계 기록에 따로 남긴다.

## 부유 개체 크기 안전 및 C09 후속 검증

이동 가능 RHWP 도형·그룹의 서쪽·북쪽 앵커를 옮기는 핸들(`nw`, `n`, `ne`, `sw`, `w`)은 표시하지 않는다. 해당 혼합 위치·크기 명령은 선택 권한 검사에서도 거부한다. 기존 이동과 동·남동·남쪽 크기 변경, 부유 그림 이동, 지원 인라인 그림의 여덟 크기 핸들은 유지한다. 남쪽 크기 변경에서는 선택 모델의 치수로 변환해 원래 너비를 정확히 보존한다. 초기에 발견한 0.03pt 너비 변동과 그 교정 결과는 후속 기록에 별도로 남겼다.

기존 fixture를 쓸 수 있으면 `--fixtures target/stage3c-native/fixtures`를 사용한다. 위의 X11 실행기와 Release 빌드 조건에서 `native-stage3-c-resize.py`의 `floating-picture floating-shape floating-group inline-picture`를 실행한다. 별도 출력 경로에서 `native-stage3-c.py`의 `C09-hwp C09-hwpx`를 실행한다. C09 검사는 종이 기준 왼쪽·위쪽 정렬을 확인하고, 10pt 이동 뒤 예상 가로·세로 오프셋과 게시본을 비교한다. 재열기 화면의 양쪽 위치와 페이지도 독립 RHWP 레이아웃과 대조한다.

## 기존 검증 범위

- [P6 Native 기록](stage3-p6-native-acceptance-2026-11-19.json)은 당시 사용한 앱, 실행 범위, 아티팩트의 출처를 보존한다. 역사 실행의 `native2/shape.hwp` 해시 불일치는 기존 기록에 명시돼 있다.
- [캡션 Native 기록](stage3-caption-native-acceptance-2026-11-20.json)은 기존 IBus와 잠금 보호 결과를 보존한다.
- [저장 보존 계약](save-preservation.md)과 [명령 레지스트리](command-registry.md)의 지원 경계를 사용한다. Linux Wayland, Windows, macOS는 이 X11 실행 범위 밖이다.
