# T010 캐시 보강 증거 (2026-10-23)

기준 HEAD `c02681c`(master), rhwp `1a76570e`(v0.8.7)·WordCraft `fc419188`(v0.7.0) 그대로. **rhwp 실행 취소·다시 실행 제품 활성화: NO-GO**
(레지스트리 그대로). 원 증거 `../t010-followup/`은 바꾸지 않았다. 개인 경로·문서 내용 없음(fixture는 생성 그림·공개 표본).

| 파일 | 내용 | 분류 |
|---|---|---|
| `upstream-rhwp-bounded-image-cache-v2.patch`, `upstream-rhwp-cache-hardening-incremental.patch`, `PATCH-README.md` | 교정한 upstream 캐시 패치(미통합) | 검토용 |
| `browser-lifecycle.json` | 실제 WASM 렌더러 그림 수명 검사 12 시나리오 × 고정/원 패치/교정, Chrome 155·WebKitGTK 2.54.1 | 브라우저 실행 |
| `cache-budget.json` | 예산 128/256/384/512 MiB × 원 패치/교정 + 고정, 3회씩(Chrome), 작업 집합, 오프라인 정책 모의 | 브라우저 실행 + 모의 |
| `perf-current.json` | 4문서 native WebKitGTK 지연(실제 X11 키, 같은 계약), 엔진 layer JSON/JS 요약 분리 | native |
| `undo-save.json`, `save-preservation.json` | 실행 취소 저장 13 시나리오·T009 판정(strict desired) 다시 실행 | 실제 저장 경로 |
| `ime-env-matrix.json` | ibus 환경 4종 × 36회 native 순서 행렬 + 확정 dispatch 관찰 | NATIVE OBSERVED |

## 활성화 관문

| 관문 | 결과 | 근거 |
|---|---|---|
| D1 렌더링·표 셀 | PASS | render 33/33, cells 6/6(시험 활성화 빌드) |
| D2 native IME | INCONCLUSIVE | 216회 모두 안전, 목표 순서 0회(누적 0/298); 늦은 확정이 빈 끝의 posted task보다 먼저 128/128 |
| D3 저장 보존 | PASS | undo_save 불일치 0, `save_service.py --strict-desired` CURRENT 0·DESIRED 회귀 0, cargo test 175 |
| D4 응답성·메모리 | FAIL | 묶음 시작 p95 77/77/87/121 ms(기준 50); 출하 엔진 캐시는 그대로(교정 패치 미통합), 수명주기 RSS 판정 INCONCLUSIVE 2 |
| D5 실패 안전 | PASS | Vitest 779(실패 주입·용량 거절 포함), lifecycle 소유 검사 30/30 |

## 회귀 (마지막 소스 변경 뒤 실행)

typecheck·lint 통과, Vitest 40파일 779, WASM Vitest 27(+2 opt-in 건너뜀 — 통과로 세지 않음), phase0 50, Python e2e 66·security 86,
cargo fmt·clippy(-D warnings) 통과, cargo test 175(6 opt-in 무시), undo_save·T009 strict 불일치 0, native IME 25/25·T007 7/7·T008 7/7,
제품 빌드 검사(두 형식 Undo/Redo 비활성·키/리본 변경 없음·시험 표지 없음), Tauri 스모크 62/62(Xvfb `-dpi 96`; 기본 DPI에서는 알려진 1px
가로 넘침으로 1항목 실패 — 이번 변경과 무관한 환경 문제).

## 남은 한계

- 교정 패치는 고정 툴체인(1.93.1)으로 확인하지 못했다(1.99로만). geul 통합·호스트 알림 연결·예산 결정은 별도 승인 필요.
- 예산이 작업 집합보다 작으면 교정판도 고정 엔진보다 느리다(256 MiB 전체 다시 그리기 773 ms vs 54 ms). 두 문서 동시 작업 집합은 512 MiB로도 부족.
- 브라우저 비동기 그림의 첫 그리기는 고정 엔진처럼 비어 있다(알림을 받은 호스트가 다시 그려야 함 — geul 미연결).
- WebView 지연은 엔진(텍스트 변경·layer JSON·띠 그리기)과 Xvfb frame 주기가 지배; native 프로파일러 없음(ptrace 제한).
- D2는 이 WebKitGTK·ibus 경로만; 다른 플랫폼·입력기(fcitx5, Windows TSF, macOS) 미실행.
