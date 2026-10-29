# T010 후속 검증 요약 (2026-10-29)

현재 판정은 **T010 미완료**, 제품 RHWP Undo/Redo **NO-GO**, **T011 BLOCKED**다. q13은 실험 후보이며 `productionApproval=NOT_APPROVED`다. 이 결과는 D1 승인 기준을 변경하거나 생산 승인을 뜻하지 않는다. 요약과 증거 파일 SHA-256은 [q13-summary.json](q13-summary.json)에 기록했다. 개인·원시 실행 자료는 저장소 로컬 `.git` 아래에 두었고 이 폴더에는 복사하지 않았다.

## q13 공식 D4

고정된 공식 D4 절차로 네 문서를 모두 측정했다. group-start p95 한도는 50 ms, Undo 한도는 1,500 ms이며 각 문서에서 각각 30회와 25회를 측정했다. 순서는 group-start / Undo p95(ms)다.

| 문서 | group-start | Undo |
|---|---:|---:|
| basic-ko.hwp | 47 | 51 |
| basic-ko.hwpx | 46 | 49 |
| 연구노트(화학).hwp | 198 | 76 |
| 자산관리 규정.hwpx | 70 | 124 |

측정은 timeout 없이 끝났고 group-start 두 항목이 실패했다. 실행 전후 선택한 12개 source SHA-256은 일치했으며, 실행 중 source 안정성 및 adapter 안정성 표기도 참이다. 현재 저장소의 해당 12개 파일도 기록된 해시와 모두 일치한다. 따라서 이 완주 결과는 현재 adapter/source 신원에 연결된다. 이것은 실패한 성능 문턱을 통과로 바꾸지 않는다.

별도의 q13 Canvas 확인은 39개 검사와 24개 정확 RGBA 비교를 통과했다. 수정된 page-identity 수용 하네스는 Chrome과 WebKit에서 24쪽의 초기·편집·Undo·Redo·재열기 단계를 검사했다. 편집·Undo·Redo 각 단계에서 20쪽을 재사용하고 4쪽을 다시 그렸으며, 각 단계 24쪽 픽셀 비교가 정확했다. 이 결과는 해당 하네스 검사이며 승인된 anchor에 대한 D1 전체 재검증으로 간주하지 않는다. q13 D1 최종 승인은 미완료다.

## 기타 acceptance 근거와 미완료 항목

후보 안전성 14/14와 pending history 22/22 검사는 통과했다. 실제 IBus Hangul은 활성화됐고 HWP/HWPX 입력 기본 경로는 동작했으나, 필수 empty-end → Ctrl-Z → late-insert 지연 순서는 36개 변형에서 한 번도 관측되지 않았다. 따라서 D2는 **INCONCLUSIVE**다. 실행에서 window 미관측을 안전성 통과로 해석하지 않았다.

닫은 뒤 session/job/lease가 0인 검사는 프로세스 RSS를 재지 않는다. q13 화학 문서의 종료 후 decoded resident cache는 259,402,324 bytes로 기록됐고 실제 RSS는 미측정이다. 메모리 안전성 acceptance는 남아 있다.

독립 표 재현은 고정 upstream과 공통 패치를 8개 문서, 문서당 12회 편집·13개 canonical 상태로 비교했다. 결과 421개에 차이가 없었다. SVG seed 재생은 별도 5개 fixture의 두 seed 정책에서 각각 30회 편집 결과가 기존 집계와 맞음을 확인했다. 이는 제한된 fixture 재생이며 이전 전체 집계 차이 7건의 전부를 개별 문서에 귀속하지 않는다.

q13 native 전체 unit 실행은 3,931 pass, 4 fail, 15 ignored였다. 네 실패는 검증 export에 빠진 fixture를 요구했다. 최초 누락 fixture를 pinned 입력에서 공급한 뒤 단독 재실행 1·2가 통과했고, 이후 고정 template 17개를 추가 공급한 뒤 단독 재실행 3·4도 통과했다. 이는 전체 실행 뒤의 네 단독 결과이며, 단일 3,935개 전체 통과 실행으로 합산하지 않는다. fixture 신원과 각 실행 log/exit hash는 q13 요약에 연결했다.

포맷 검사는 별개다. 기본 `cargo fmt --manifest-path … --check` 실행은 검증 복사본 `typeset.rs` 끝의 빈 줄 차이를 출력하고 exit 1이었다. 뒤이은 `--lib` 인자를 추가한 재시도는 Cargo fmt가 그 인자를 지원하지 않아 검사 전에 exit 2였다. 후자는 포맷 위반 증거가 아니며, 수정된 포맷 검사도 통과하지 않았다. frozen candidate 원본은 수정하지 않았다.

Chrome CPU profile은 고정 후보로 asset warm 32회, chemical cold 6회를 실행한 비공식 진단이다. cold profile의 주요 sample은 PNG `unfilter` 416,222 µs, deflate read 141,954 µs, color cast 95,032 µs였다. 이는 Chrome sampler 관측이며 공식 D4나 native 성능 추정이 아니다. 별도 font setter 및 text-metrics 실험은 두 엔진에서 픽셀을 보존했지만 반복 기준보다 느려 채택하지 않았다.

따라서 제품 RHWP Undo/Redo는 계속 **NO-GO**이며 T010은 미완료, T011은 BLOCKED다. 선행 T007–T009와 D1, D2, RSS 및 공식 D4 성능 문제가 모두 해소될 때까지 상태를 바꾸지 않는다.

상세 q12 기록은 역사 자료로 [q12-surface-summary.json](q12-surface-summary.json)에 보존한다. q13 결과 요약은 [q13-summary.json](q13-summary.json)이다.


## q14 SIMD128 실험 (비공식, 채택 거절)

q13 소스에서 `src/renderer/typeset.rs` 끝의 불필요한 빈 줄 하나만 제거한 1,585개 입력 복사본을 `-C target-feature=+simd128`로 빌드했다. 빌드와 별도 native validation 복사본의 `cargo fmt --manifest-path … --check`는 통과했다. q13/q14 Chrome 및 WebKit 캐시 동시성 안전성 검사는 모두 통과했다. 이 결과는 q13의 fmt 실패를 바꾸지 않는다.

고정된 q13 대 q14 비공식 paired Full 렌더 진단은 엔진별 asset-warm 12쌍과 chemical-cold 6쌍을 픽셀 단위로 비교해 모두 정확했다. Chrome asset-warm p50은 11.2→11.2 ms, chemical-cold는 129.1→129.5 ms였다. WebKit harness 측정은 각각 13→13 ms, 127→128 ms였다. 측정에서 SIMD128의 실질적인 개선은 없었으므로 q14 후보를 거절했으며 승인하지 않았다.

WebKit harness의 18쌍 픽셀 비교는 통과했지만 wrapper는 D-Bus 종료 처리에서 exit 1을 냈고, 전체 diagnostic source guard도 WebKit wrapper 실패 때문에 FAIL이다. 종료 후 재확인에서는 남은 프로세스가 없었으나 이는 앞선 wrapper 실패를 소급해 통과로 바꾸지 않는다. 이 진단은 공식 D4가 아니다. q13 공식 D4가 최신 공식 결과로 남으며 p95 47/46/198/70 ms 중 두 항목이 한도를 넘어 실패했다. T010 미완료, RHWP Undo/Redo NO-GO, T011 BLOCKED를 유지한다. 상세한 공개 요약과 원시파일 basename/SHA-256은 [q14-simd-summary.json](q14-simd-summary.json)에 기록했다.
