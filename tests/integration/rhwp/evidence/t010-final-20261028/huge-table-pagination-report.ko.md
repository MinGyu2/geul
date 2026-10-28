# T010 Stage B — 대형 표 페이지네이션 수정 및 검증

## 판정

Stage B PASS. issue2063_huge_cellbreak_table.hwp를 원본 바이트 그대로 열어 30회 deterministic edit, 각 단계의 canonical pagination 비교, 최종 모든 페이지의 SVG 비교를 완료했다. 원본 external/rhwp gitlink는 1a76570e833917d15817415a53c09ad61ab3203f에 남아 있고 워킹 트리는 수정하지 않았다. 수정은 격리 소스 export에만 적용하고 패치로 보존했다.

## 입력과 원인

- Fixture: issue2063_huge_cellbreak_table.hwp, 694,272 bytes.
- SHA-256: 47de1ce82472050a4c5f33ccab2a3eac2c7e55d0e2a688febd085f0b4c8320ca.
- 원래 실행은 read/parse/reflow/recompose 이후 최초 DocumentCore::paginate()가 120초 동안 끝나지 않았다. 테스트는 첫 edit에 도달하지 않았으므로 이 기록은 equivalence mismatch가 아니다.
- 계측 결과 표는 5,277 rows / 52,694 cells였다. row cursor는 매 조각에서 전진했고 repeated_same_row=0; 정체 루프가 아니라 반복된 전체 셀 순회로 인한 과도한 계산이었다.
- 반복 계산은 (1) 페이지마다 row 전체를 훑던 saved-vpos reset 검사, (2) 각 row마다 모든 cell을 다시 검사하던 rowspan coverage 구축, (3) row-cut 후보마다 전체 cell 목록을 필터·정렬하던 조회, (4) 각 fragment에서 모든 row×cell을 훑던 저장 높이 계산이었다.

## 수정 내용

격리 export /tmp/geul-t010-rhwp-export-clean-20261028에 다음을 반영했다.

1. saved-vpos reset 판정을 cell 기준 단일 순회로 계산하고 기존 row 범위 조건을 보존.
2. rowspan 점유를 차분 배열로 구축해 rows + cells에 비례하도록 변경.
3. table identity를 key로 row별 cell index를 한 번 묶고 column 순으로 정렬해 cache. layout cache 초기화 시 이 cache도 비운다.
4. continuation budget에서 저장된 row 높이를 캐시된 row cell 목록으로 가져온다.
5. GEUL_T010_PAGINATE_TRACE가 켜졌을 때만 단계/row cursor/처리량을 기록하는 제한된 진단 정보를 유지.

회귀는 row_cut_cell_order_cache_preserves_column_order_and_rebuilds_after_clear와 table_scan_detects_saved_reset_in_one_row_and_ignores_out_of_range_rows에 추가했다. 두 회귀 테스트 모두 마지막 소스에서 다시 실행해 각각 1/1 PASS했다.

## 검증 결과

### 대형 표 1회 편집

GEUL_ORACLE_OPS=1 릴리스 진단:

- A/B 모두 열기·페이지네이션 성공.
- 초기 161-page canonical pagination 일치.
- deterministic Insert(0, 5, 0, "x")가 양쪽 엔진에서 성공하고 post-edit canonical pagination 일치.
- 최종 SVG exact equality: 161/161.
- Rust test 1 passed, 0 failed; command exit 0; test elapsed 386.98s.

Raw log: huge-pagination-equivalence-release-ops1-900s.log.

### 대형 표 30회 편집

GEUL_ORACLE_OPS=30 릴리스 진단:

- 초기 161-page canonical pagination 일치.
- 30/30 edits가 양쪽 엔진에서 성공; 30/30 post-edit canonical pagination 비교 일치.
- 편집으로 최종 문서는 159 pages가 됐고 SVG exact equality 159/159.
- Rust test 1 passed, 0 failed; command exit 0; test elapsed 1170.85s.
- COMMAND_EXIT=0; test 프로세스가 정상 종료했다.

Raw log: huge-pagination-equivalence-release-ops30-1800s.log.

실행 명령:

```sh
GEUL_T010_PAGINATE_TRACE=1 \
GEUL_ORACLE_MODE=diagnostic \
GEUL_ORACLE_SAMPLES=/tmp/geul-oracle-huge \
GEUL_ORACLE_OPS=30 \
GEUL_ORACLE_OPEN_PROGRESS=1 \
timeout 1800 cargo test --release --locked --offline \
  --manifest-path Cargo.toml \
  --target-dir /tmp/geul-incr-pagination/target \
  --lib geul_format_memo_equivalence_oracle -- --ignored --nocapture
```

추가 회귀/형식 확인:

```sh
cargo test --locked --offline --manifest-path Cargo.toml \
  --target-dir /tmp/geul-incr-pagination/target --lib \
  row_cut_cell_order_cache_preserves_column_order_and_rebuilds_after_clear -- --nocapture

cargo test --locked --offline --manifest-path Cargo.toml \
  --target-dir /tmp/geul-incr-pagination/target --lib \
  table_scan_detects_saved_reset_in_one_row_and_ignores_out_of_range_rows -- --nocapture

rustfmt --edition 2021 --config skip_children=true --check \
  src/renderer/layout.rs src/renderer/layout/table_layout.rs \
  src/renderer/typeset/table/block.rs \
  src/renderer/typeset/table/block/prepare.rs \
  src/renderer/typeset/table/continuation/fragment/budget.rs \
  src/renderer/typeset/table/continuation/fragment/emit.rs \
  src/renderer/typeset/table/continuation/fragment/scan.rs \
  src/renderer/typeset/table/scan/runner.rs \
  src/renderer/typeset/table/scan/runner/row_step.rs \
  src/document_core/commands/document.rs
```

각 명령 exit 0. Stage A 최종 소스 재검증도 strict mode에서 별도로 PASS했으며 결과는 oracle-strict-stage-a-post-stageb-result.json에 있다.

## 제한 종료를 분류한 방법

- 120s debug 실행은 A 문서 open/paginate/seal 후 B 문서 열기 중 종료됐다. 해당 실행은 편집 동등성 결과가 아니며 Stage B PASS로 계산하지 않았다.
- 첫 release 실행은 LTO 컴파일까지 900s 상한에 포함되어 SVG 96/161 지점에서 종료됐다. initial pagination 및 첫 edit 비교는 성공했지만 전체 테스트 완료가 아니었다.
- 이후 이미 빌드된 동일 release binary로 ops=1과 ops=30을 각각 충분한 상한으로 다시 실행해 모든 필수 비교를 완료했다.

## 소스 및 증거 식별자

- Pinned source revision: 1a76570e833917d15817415a53c09ad61ab3203f.
- huge-table-pagination-fix.patch SHA-256: 3e8e3e86b2e74727b8ca8a4a4bfb14c908e2a8b95bcc2730eca293b76a4b16eb.
- 이 패치를 pinned source scratch copy에 적용해 수정 대상 9개 파일과 document.rs cache callsite를 검증했다. 9개 파일은 실행 export와 바이트 단위로 일치했다.
- Native test binary SHA-256: f71d2586d843709b75839d97440113848031676da2d4aa65a1840af99339e406.
- Toolchain: cargo 1.99.0 (5f94df478 2026-08-27).
- Final strict Stage A raw log SHA-256: 93c8d3c4ba3ed7af575ae3e7c8be853f1655f72dfc199945869141c8c5479efe.
