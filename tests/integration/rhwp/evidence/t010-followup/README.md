# T010 후속 증거 (2026-10-22): 응답성·native IME 경계·렌더러 캐시·활성화 관문

판정: **production rhwp Undo/Redo NO-GO** — D2 INCONCLUSIVE, D4 FAIL. 근거 요약은
[docs/architecture/rhwp-undo-redo.md](../../../../../docs/architecture/rhwp-undo-redo.md)의 "T010 후속" 절.

- `environment.json` — 실행 환경·측정 계약(그대로)·부하 메모.
- `perf-baseline.json`, `perf-final.json`, `perf-final-capacity-refusal-control.json` — 같은 계약의 전/후와 기록 끔 대조(문서마다 앱 세션 하나).
- `perf-ab-before.json`, `perf-ab-after-rejected-input-change.json` — A/B. 뒤쪽에 들어 있던 입력 경로 변경은 이득이 없어 **되돌렸다**.
- `perf-diagnostic-busy-probe.json` — 진단 전용(MessageChannel 탐침이 일정을 흔듦). 관문 값에 쓰지 않는다.
- `webkit-main-thread-micro-probes.json` — 단일 DOM/Canvas/IPC 변경별 WebKit main-thread 정지(임시 실험, 관문 아님).
- `native-gates.json`, `ime-gap-matrix.json`, `lifecycle.json` — 최종 시험 빌드의 native 관문, Stage B 행렬(72회), 30사이클 수명주기.
- `renderer-cache-experiment.json` — 고정 엔진과 **통합하지 않은** upstream 패치의 캐시 보존 비교(headless Chrome, 픽셀 추정).
- `upstream-rhwp-bounded-image-cache.patch` — rhwp `1a76570` 기준 별도 패치. **geul에 통합하지 않았고 submodule은 그대로다.** 출하 앱의 메모리 관문 근거가 아니다.
- `undo-save.json`, `save-preservation.json`, `product-build.json`, `verification.json` — 저장 보존·일반 빌드·명령 검증.

문서 내용·개인 경로는 담지 않는다(글자 수·해시·시간·개수만).
