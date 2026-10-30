# RHWP 본문 증분 쪽 나눔 안전 계약 (T010 D4, 2026-10-30)

상태: **계약 정의 + 격리 실험용**. 제품 RHWP(고정 `1a76570`)·제품 WASM에는 적용하지 않는다.
배경과 원인 측정은 [rhwp-undo-redo.md](rhwp-undo-redo.md)의 "T010 첫 그리기 재시도·D4 엔진 경계 조사"를 본다
(자산 문서 키 하나의 `insertText` 약 24 ms 중 쪽 나눔(`endBatch`)이 약 24 ms).

이 문서는 "증분 결과가 같은 입력의 새 전체 쪽 나눔과 같다"를 무엇으로 입증하는지, 입증하지 못하면 언제 전체 쪽 나눔으로
돌아가는지를 정한다. 속도는 그 다음 문제다.

## 1. 실제 기본 경로 (고정 소스 확인)

- 편집: `insert_text_at_caret_native`(`text_editing.rs:1434`) → `reflow_paragraph`(편집 문단 줄 나눔) →
  `recalculate_section_vpos`(`renderer/composer/line_breaking.rs:4833`, 편집 문단 **뒤** 문단들의 저장 vpos를 다시 매김)
  → `recompose_paragraph`(`rendering.rs:4279`: 쪽 트리 캐시 전부 무효화, `dirty_sections`·`dirty_paragraphs` 표시)
  → `paginate_if_needed`(batch가 아니면 즉시) → `paginate` → `paginate_pass`(`rendering.rs:4919`).
- `paginate_pass`: 문서 전체 번호 표지 재계산(`assign_numbering_markers`), 렌더 정규화 갱신, dirty 구역마다
  선택 측정(`measure_section_selective`) 뒤 **`TypesetEngine::typeset_section_with_variant`**(→ `run_section`,
  `renderer/typeset/section.rs:22`)로 구역 전체를 처음부터 조판, 그 뒤 구역 간 쪽번호·머리말/꼬리말·바탕쪽 후처리.
- `RHWP_USE_PAGINATOR=1`일 때만 옛 `Paginator`를 쓴다. 제품(WASM)은 환경 변수가 없으므로 **TypesetEngine이 기본**이다.
  이 계약과 실험은 TypesetEngine만 다룬다.
- `find_convergence`(`pagination.rs:947`)는 전체 조판이 끝난 **뒤** 진단 출력에만 쓰이고, `copy_converged_pages`(`:987`)는
  어디서도 호출되지 않는다.

### 기존 수렴 코드를 안전 판정에 쓰지 않는 이유 (VERIFIED, 코드)

- `find_convergence`는 `offset == 0`이면 아무것도 보지 않고 `Some(0)`을 돌려준다. 문단 수가 그대로인 글자 입력은 항상
  offset 0이므로, 이 함수는 그 경우 "0쪽부터 수렴"이라고 주장한다.
- `offset != 0`에서도 쪽 항목·인라인 배치 개수와 값만 비교한다. 아래 3절의 조판기 상태(현재 높이, 각주 예약, 어울림 밴드,
  vpos 기준, 이월 표 큐 등)는 보지 않는다. 같은 문단 번호·같은 쪽 수·같은 쪽 항목은 뒤 조판이 같다는 증거가 아니다.
- `copy_converged_pages`는 `items`·인라인 배치·`wrap_around_paras`·`wrap_anchors`만 offset으로 옮기고
  `overlay_continuations`·`overlay_cuts`·`footnotes`·머리말/꼬리말 참조·`ladder_band_tables`의 문단 번호와
  `page_index`는 옮기지 않으며, 결과 수준 집합(`hidden_empty_paras`, `pre_emitted_host_*`, 미주 참조)도 다루지 않는다.
  음수 문단 번호를 `.max(0)`으로 조용히 0으로 만든다.
- 그래서 두 함수는 이 계약의 판정·재사용에 **연결하지 않는다**.

## 2. 안전한 시작 checkpoint

checkpoint는 **이전 패스가 실제로 지나간 조판기 상태 전체**다. 쪽 번호나 문단 번호만 아는 것은 checkpoint가 아니다.

- 위치: `run_section` 문단 루프의 **문단 처리 시작 시점** 중, 직전 checkpoint 뒤에 `st.pages`가 늘어난 첫 문단(쪽마다 하나).
  문단 가운데서 쪽이 바뀌어도(분할 문단) 다음 문단 시작에서 잡는다.
- 저장 내용: `TypesetState`의 모든 필드(`StateView`, 3절)에서 `pages`만 빼고 복제, 그때의 현재 쪽(`pages.last()`) 복제,
  쪽 수, 문단 번호, 루프 지역 상태 `variant_prev_para_idx`.
- 앞 쪽들(`pages[..k-1]`)은 checkpoint마다 복제하지 않고 그 패스의 **루프 끝 상태**에서 가져온다. 이는 그 checkpoint
  뒤에 앞 쪽을 고친 일이 없을 때만 맞다. 조판기는 완료된 쪽을 소급해 고친다(어울림 문단 부착 `state.rs:164`·
  `commands.rs:405`, 완료 쪽 각주 `notes.rs:218/241`, 단 확정 `transition.rs:355/430`). 그래서 이 지점들을
  "(고친 시점의 문단, 고친 쪽)"으로 기록하고, checkpoint `(p, k)`는 문단 ≥ p에서 쪽 < k−1을 고친 기록이 하나라도 있으면
  **무효**다.
- 소유·무효화: checkpoint는 구역 하나의 조판 캐시에 속한다. 구역 수·문단 수가 바뀌거나, 그 구역이 다른 경로로 다시
  조판되었거나(아래 입력 지문 불일치), 캐시를 만든 패스가 증분 실패로 끝나면 버린다. 새 패스는 결과에 맞는 checkpoint
  집합을 다시 만든다(앞부분은 재사용, 다시 조판한 구간은 새로 기록, 수렴 뒤는 이전 것 그대로).
- 시작 지점 선택: 편집 문단 `e`보다 앞(문단 번호 ≤ e)에 있는 마지막 **유효** checkpoint. 없으면 전체 조판.

## 3. 경계 상태 동등성

다음 경계(쪽마다 checkpoint 자리)에서 새 상태와 이전 패스의 같은 문단 번호 checkpoint를 비교한다. 비교 대상은 **필드 목록을
고르지 않고 `StateView` 전체**다(derive한 `PartialEq`). 필드를 고르면 빠뜨린 필드가 곧 결함이 되기 때문이다.
고정 소스의 `StateView`(`renderer/typeset/state/data.rs`, 약 110개 필드)는 이 계약이 요구하는 범주를 모두 담는다.

| 범주 | 대표 필드 |
|---|---|
| 쪽·단 위치와 남은 공간 | `pages`, `current_items`, `current_height`, `current_start_height`, `current_column`, `col_count`, `layout`, `current_zone_*`, `on_first_multicolumn_page`, `pending_body_wide_top_reserve` |
| 문단·줄 이어짐 | `paragraph_fragment_content_bottoms`, `prefilled_paras`, `prefilled_line_prefixes`, `pre_emitted_host_*`, `defer_host_line_item_para`, `hidden_empty_*` |
| vpos 기준 | `vpos_page_base`, `vpos_lazy_base`, `vpos_page_base_stored`, `vpos_ladder_dirty`, `vpos_compacted_stored_delta`, `vpos_snapped_flow_start`, `vpos_prev_*`, `vpos_col_anchor`, `prev_body_bottom_vpos`, `flow_underrun`, `ladder_band_floor` |
| 표 이어짐·이월 | `deferred_table_controls`, `fragment_queued_table_footnotes`, `current_ladder_band_tables`, `pending_overlay_continuations`, `current_column_overlay_*` |
| 각주·미주 | `current_footnote_height`, `is_first_footnote_on_page`, `current_page_has_footnote_separator`, `deferred_hwpx_note_body`, `endnotes`, `endnote_paragraphs`, `endnote_para_sources`, 미주 간격 |
| 떠 있는 개체·어울림 | `visible_float_exclusions`, `side_wrap_exclusions`, `inline_placements`, `inline_flow_plans`, `paragraph_float_placements`, `square_band_*`, `wrap_around_*`, `wrap_synth_rects`, `behind_*`, `deferred_next_page_*`, `page_start_*`, `page_tail_spilled_floats` |
| 하단 고정·머리말 영향 | `current_bottom_fixed_exclusion`, `bottom_fixed_consumed_flow`, `page_has_page_abs_top_table`, `section_has_no_footer` |
| 구역 시작 사전 판별 | `profile`, `has_stored_line_segs`, `hide_empty_line`, `omit_fresh_recalc_doc`, `stored_ladder_spacing_omitted`, `skip_spacing_before_prededuct` |
| 다음 문단 관측값 | `next_para_first_stored_vpos`, `next_para_lane_probe`, `next_para_is_*` |

- 직접 비교: 위 전부(값). 앞 쪽 `pages[..k-1]`도 이전 루프 끝 상태의 같은 쪽과 **값 그대로** 같아야 한다.
  조판 중에 앞 쪽을 읽는 경로가 있기 때문이다(각주 `notes/footnotes/body.rs`, `table/footnotes.rs`, `whole_fit.rs` 등).
- 문단 번호 재매핑: 이 계약의 지원 범위는 **문단 수가 변하지 않는 편집**(offset 0)뿐이다. 문단 번호를 담은 필드를
  옮겨 맞추는 일은 하지 않는다. 문단 삽입·삭제는 전체 조판이다(5절). 재매핑을 넣으려면 위 표의 모든 문단·제어 번호
  필드와 결과 집합의 번호 공간을 하나씩 정의하고, 그것을 별도로 검증해야 한다(미지원).
- 실수: `f64`는 `==`로 비교한다. `+0.0 == -0.0`, `NaN != NaN`이다. NaN은 수렴을 막을 뿐(안전 쪽)이다. 부호 있는 0을
  구별하는 하류 계산은 찾지 못했으나 전수 확인은 아니다(잔여 위험, 7절).
- 소급 수정 기록은 상태 안에 두되 비교에서는 늘 같다고 본다(조판 출력이 아니라 계측). 상태 데이터는 `state` 모듈 밖에서
  쓸 수 없으므로 기록 지점은 그 모듈 안의 쪽 수정 지점 전부다(실험 감사에서 처음에 하나를 빠뜨렸다가 찾아 넣었다).
- 해시 컨테이너: `PartialEq`는 순서와 무관하게 비교하므로 정규화가 필요 없다.

## 4. 수렴과 재사용

경계 `B`(문단 `p > e`, 쪽 수 `k`)에서 다음을 **모두** 만족하면, `B` 뒤의 조판은 이전 패스와 같다고 보고 이전 패스의
루프 끝 상태를 그대로 쓴다. 그 뒤의 구역 끝 처리(미주, 남은 이월 표, 마지막 빈 쪽 버리기, `finalize_pages`)는 새 입력으로
다시 실행한다.

1. 3절의 상태 동등(앞 쪽 포함)과 `variant_prev_para_idx` 동일.
2. 이전 checkpoint `(p, k)`가 유효(2절의 소급 기록 없음).
3. **입력 동일.** `e`를 뺀 모든 문단(`Paragraph`의 모든 필드), 그 문단의 `ComposedParagraph`, 측정 표, 스타일 집합,
   쪽·단 정의, 각주·미주 모양, 렌더 정규화 overlay, `hide_empty_line`, 프로파일, `force_break_before`, 미주 이월 방식이
   이전 패스와 같다. 비교는 이전 패스의 복제본을 보관해 derive `PartialEq`로 한다(바뀐 문단만 다시 복제). 해시·serde 지문은
   쓰지 않는다(serde는 `source_line_seg_vertical_pos`·`numbering_marker`·`layout_space_metrics`처럼 조판에 쓰는 필드를
   건너뛰고, `Debug` 문자열 해시는 측정상 쪽 나눔보다 비쌌다). 스타일 집합 안의 공유 글꼴 문맥(`Arc` 커닝·가로 shaping
   문맥)은 **같은 할당일 때만** 같다고 본다 — 내용이 같은 다른 할당은 다르다고 보아 전체 조판으로 간다(틀린 "같음" 없음).
4. **구역 사전 판별 동일.** `run_section` 시작에서 문단 전체로 정하는 값: 초기 `TypesetState`, `uniform_filler_ladder`,
   `float_carve_evidence`, 머리말/꼬리말 목록과 쪽번호 위치, 마지막 내용 문단 번호.
5. **편집 문단의 이웃 노출 서명 동일.** 문단 처리는 앞뒤 문단을 읽는다(고정 소스의 typeset 경로에 비현재 문단 접근
   364곳: `paragraphs.get(para_idx + 1)`, `(0..para_idx).rev().find(..)`, 구역 전체 스캔 등). 그래서 `B` 뒤 문단이나
   checkpoint 앞 문단이 `e`를 읽을 수 있다. 서명은 `e`에서 `text`·`char_offsets`·`char_shapes`·줄의 `text_start`처럼
   글자 위치를 담은 필드를 뺀 나머지 전부(제어, 문단 모양, 단 나눔 종류, 줄의 세로 지표, 저장 vpos, 번호 표지 등)와,
   이웃 판정이 실제로 읽는 글자 계급(비었는지, 공백만인지, 제어 문자를 뺀 뒤 비었는지, `trim_start` 뒤 첫 글자, 마지막 글자)이다.

조건 5는 **표적 감사로 만든 근사**다. 364곳을 모두 증명하지 않았으므로 "e의 다른 글자 내용을 읽는 이웃 규칙이 없다"는
가정은 **증명되지 않았다**(UNVERIFIED). 이 가정은 6절의 오라클로만 경험적으로 확인한다. 이것이 이 계약이 제품 활성화를
허용하지 않는 첫째 이유다.

수렴하지 못하면 checkpoint에서 구역 끝까지 그대로 조판한다. 이것은 그 checkpoint에서 시작한 전체 조판이므로 결과는 같다
(시작 checkpoint가 조건 2–5를 만족할 때). 수렴 없이 끝까지 간 실행은 "증분 성공"으로 세지 않는다(7절 계측).

## 5. 전체 쪽 나눔으로 돌아가는 조건

하나라도 해당하면 전체 조판(현재 동작)을 한다. 모두 이유 코드로 계측한다.

| 코드 | 조건 |
|---|---|
| `no-cache` | 그 구역의 이전 조판 캐시가 없음(처음 열기, 캐시 무효화 뒤) |
| `not-single-paragraph-edit` | `dirty_paragraphs`가 `None`(구역 전체 dirty)이거나 dirty 문단이 정확히 하나가 아님 |
| `paragraph-count-changed` | 문단 수 변경(문단 나누기·합치기·붙여넣기·삭제) — offset 재매핑 미지원 |
| `multiple-dirty-sections` | dirty 구역이 둘 이상 |
| `input-changed` | 조건 3 위반: `e` 밖의 문단·조합 결과·측정 표·스타일·쪽/단/각주 정의가 바뀜. 구역 정의·단 정의·쪽 정의·머리말/꼬리말 제어·쪽번호 제어·숨은 문단의 변경이 여기에 걸린다 |
| `section-prepass-changed` | 조건 4 위반(예: 압축 사다리 판별, 어울림 증거, 머리말/꼬리말 목록 변화) |
| `neighbour-signature-changed` | 조건 5 위반: 편집 문단의 제어·문단 모양·단 나눔·줄 수·줄 세로 지표·저장 vpos·번호 표지 또는 글자 계급이 바뀜. 줄 수가 바뀌는 입력과 vpos reset은 여기서 걸린다 |
| `no-valid-checkpoint` | `e` 앞에 유효한 checkpoint 없음(소급 수정으로 무효 포함) |
| `paginator-mode` | `RHWP_USE_PAGINATOR=1` |
| `force-breaks` | `force_break_before`가 비어 있지 않음 |

표가 쪽을 넘는 경우, 떠 있는 개체, 각주·미주는 문서 종류로 막지 않는다. 그런 상태가 경계에 걸리면 3절의 상태 비교
(이월 표 큐, 어울림 밴드, 각주 예약 등)와 2절의 소급 기록이 수렴·checkpoint 사용을 막는다. 처음 실험은 그래도 단순 본문
문서에서만 성능을 주장한다(6절).

## 6. 오라클

**두 문서 비교(A/B).** 같은 파일을 두 번 연다. A는 증분 경로를 켜고, B는 끄고(항상 전체 조판) 같은 편집 순서를 똑같이
실행한다. 편집마다 A와 B의 구역별 쪽 나눔 결과 전체를 비교하고, 끝에 모든 쪽의 SVG를 비교한다.

- 비교 대상: `PaginationResult`의 모든 필드. 구조체는 `..` 없이 구조 분해하고, 해시 컨테이너는 정렬해 비교한다
  (2026-10-30 format-memo 오라클과 같은 방식). 이로써 쪽 수, 쪽 크기(`layout`), 쪽 번호·재시작, 구역 번호, 단별 항목(문단·줄
  범위·표 조각), 어울림·인라인 배치, 각주, 머리말/꼬리말·바탕쪽 참조, 숨은 문단, 미주가 모두 들어간다.
- 쪽 트리·렌더 메타데이터: 끝의 쪽별 SVG 비교로 그리기 입력 전체를 본다. 편집 중간 상태의 SVG는 일부 지점에서만 본다.
- 정확 RGBA: 실험 WASM과 기준 WASM으로 같은 편집 뒤 Canvas를 그려 픽셀 단위로 비교한다(가능한 경우).
- 허용하는 정규화: 해시 컨테이너의 순회 순서뿐이다. 내용이 같은지는 정렬 뒤 문자열로 비교한다. 다른 정규화는 없다.
- 무작위 편집은 고정 seed를 쓰고, 실패하면 seed·문서·편집 번호를 기록한다.
- 증분 경로를 실제로 탄 편집 수(수렴 성공)와 fallback 수·이유를 함께 낸다. fallback만 탄 통과는 정확성 증거일 뿐
  성능 증거가 아니다.

## 7. 계측과 합격 기준

- 계측: 패스마다 증분 자격 여부, fallback 이유 코드, 시작 checkpoint(문단·쪽), 다시 조판한 쪽 범위, 수렴 지점(문단·쪽)
  또는 "끝까지", 재사용한 쪽 수, 지문 계산 시간, 조판 시간, 패스 전체 시간.
- 정확성 합격: 지원 범위의 모든 오라클 사례에서 A=B(구조·SVG). 설명되지 않은 차이는 하나라도 실패다. 실패하면
  지원 범위를 좁히지 않고 원인을 찾는다.
- 성능 주장 조건: 정확성 합격 뒤, 같은 문서·같은 위치·같은 편집 순서의 짝 측정(Release WASM, 제품과 같은 빌드 방식)에서
  p50/p95, 증분 경로 실제 사용률을 함께 낸다. 쪽 나눔 개선과 전체 상호작용 지연을 섞지 않는다.
- 제품 관문: 엔진 측정은 D4 근거가 아니다. 공식 native D4(3-RAF, 기존 표본·기준)를 실제로 다시 돌려 통과해야 한다.
- 지원하지 않는 것: 문단 수 변경, 여러 문단 편집, 구역·쪽·단 정의 변경, 셀 안 편집(`insertTextInCell` 경로),
  `RHWP_USE_PAGINATOR`, `force_break_before` 사용(reflow 힌트), 문단 번호 재매핑, 증분 상태의 저장·Undo 기록 경계 공유.

## 8. 실험 결과

격리 실험의 구현 위치, 오라클 결과와 측정값은 [rhwp-undo-redo.md](rhwp-undo-redo.md)의 "T010 지연 표본 소유·엔진 실패 중단·
격리 증분 쪽 나눔 실험"에 남긴다(원시 자료는 비공개 `geul-tests`). 요약: 지원 범위의 오라클 불일치 0, 정확 RGBA PASS,
자산 엔진 비용 약 87% 감소, 공식 D4는 여전히 FAIL — 제품 활성화 안 함.
