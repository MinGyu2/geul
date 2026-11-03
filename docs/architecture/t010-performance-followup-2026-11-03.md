# T010 시간 단축: 근거·알고리즘·반증 시험

Date: 2026-11-03
Status: DESIGN ONLY; native performance NOT RUN. D4 해결 VERIFIED 아님.
Source baseline: geul `8d3f21a2b4aed80c070a6ad874db479365e96caf`; RHWP gitlink `1a76570e833917d15817415a53c09ad61ab3203f`.

## 1. 결론과 변경하지 않는 계약

단일 토글이나 UI 배치 변경으로 50ms를 달성한다는 근거는 없다. 그러나 원인과 줄일 계산을 구체적으로 지정할 수는 있다. 우선순위는 (A) 전체 그리기가 이미 필요한 요청의 불필요한 JSON 비교 제거, (B) 동일 편집 트랜잭션의 파생 결과 중복 생산 제거, (C) 완전한 의존성 계약을 갖춘 증분 쪽 나눔이다. A는 더 많은 계산/전체 그리기를 허용하는 보수적 경로라 기존 출력 재사용 증명을 우회할 이유가 없다. B/C의 결과 재사용에는 별도의 증명이 필요하다. 세 방법의 실측 이득이 단순 합산된다고 가정하지 않는다.

이 문서는 구현할 위치, 알고리즘, 실패 시 되돌아갈 경로, 반증 시험, 채택 조건을 제시한다. 코드를 바꾸거나 후보 WASM을 만들거나 새 공식 성능을 측정하지 않았다. 과거 성능과 새 설계를 혼동하지 않는다. 기존 [T010 단일 수용 행렬](./rhwp-undo-redo.md#t010-current-status)이 최종 권한이다. T010 INCOMPLETE — ON HOLD, 제품 RHWP Undo/Redo NO-GO, T011 NOT STARTED를 유지한다. 개발 우선순위는 여전히 T007/T008 기본 수용이다.

보존 조건: 원래 4개 fixture·warmup·표본 수·평가식·3RAF 끝점·group-start p95≤50ms·Undo p95≤1500ms. 필수 쪽을 늦게 그리거나 revision만 먼저 발행해서 측정에 통과하지 않는다. 제품 FULL_PAGE_ONLY와 원본 보존·세션/세대/bitmap 소유권·메모리 예산을 유지한다. partial-band, sample 제외, 임계값 상향, 기본 문서로 큰 문서 대체는 해결책이 아니다.

## 2. 확인된 사실과 근거의 한계

### 2.1 공개 기록에서 확인한 병목

[수용 문서](./rhwp-undo-redo.md)의 2026-11-01 canonical 결과는 당시 geul d1ec335·Release ca284e06·WASM 3f99a74b 신원에 속한다. 440표본/timeout0, group p95는 기본 HWP44/HWPX45/화학52/자산95ms, Undo p95는 50/50/78/160ms다. 새 HWPX 패치가 포함된 8d3f21a 산출물의 재측정 결과가 아니다.

같은 공개 요약의 자산 문서 30개 handler는58–69ms이며 insertText26ms, layer JSON8ms, full draw13ms는 p50과 중첩 경계의 기록이다. 그 밖의 세부 분해·꼬리 비용은 비공개 원시 표본을 새로 확보해 확인해야 한다. 내부 쪽 나눔의 비중은 같은 pin의 과거 별도 계측으로 뒷받침되며 현재 내부 실행을 다시 측정한 것은 아니다. 각 열의 p95를 더해 전체 p95라고 하지 않는다. 부모/자식 span도 중복 합산하지 않는다.

격리 증분 실험은 자산 insertText 약21.7→2.8ms와 해당 실험의 오라클/RGBA 성공을 기록했지만 공식 native group p95는92→72ms로 실패했다. ‘쪽 나눔만 빠르게 하면 끝’은 이 반례로 부정된다. ID index·clone·순수 tree walk 등 세부 최적화가 최신 제품의 전체 D4를 해결했다는 근거도 이번 조사에서는 확보하지 못했다.

### 2.2 현재 코드에서 확인한 실제 호출

기준 코드의 [RhwpEditorSession.ts](../../src/components/Editor/rhwp/RhwpEditorSession.ts)에서 `renderPage`는 `paintedSummary`를 얻고 `isPageUnchanged`를 검사한 뒤 필요할 때 `renderPageToCanvas`를 호출한다. `paintedSummary`는 `getPageLayerTreeWithProfile(page, 'screen', true, true)` JSON을 받아 `summarizeLayerTree`로 검증하고 성공 시 전체 JSON 문자열을 보관한다. 따라서 그림을 생략할 수 있는지 알아내는 비용과 실제 full draw 비용은 별개다. 그림을 반드시 다시 그릴 경우에도 먼저 비교용 자료를 만들면 그 경로가 최적화 후보가 된다.

같은 파일의 편집 경로는 history 경계, 엔진 mutation, modelVersion 갱신, page 정보 조회, 상태 발행을 처리한다. [RhwpSurface.tsx](../../src/components/Editor/rhwp/RhwpSurface.tsx)는 실제 쪽 그리기·retry·stale/terminal 수명과 지연 표본을 관리한다. [rhwpHistory.ts](../../src/components/Editor/rhwp/rhwpHistory.ts)의 snapshot/group/restore 경계도 바꾸면 안 된다.

상류의 고정 소스 `src/document_core/queries/rendering.rs`, text editing 및 typeset 경로와 [증분 쪽 나눔 계약](./rhwp-incremental-pagination.md)을 함께 대조해야 한다. 부분 문단 조판, clean section 캐시, 표 셀용 지연 모드 등 기존 최적화가 이미 있으므로 ‘캐시가 전혀 없다’거나 기존 API를 새 발명이라고 설명하지 않는다.

### 2.3 현재 보류의 의미

기존 G0에는 JSON에 직렬화되지 않는 shaping sidecar/control code, 반올림된 bbox와 실제 부동소수점 값, font metric의 mutable 상태, resource/metadata, native raw mutable borrow 등 출력 동등성과 mutation 추적의 공백이 남아 있다. PageContent·JSON·Arc 주소·문서 revision 중 하나만 같다고 전체 렌더 결과가 같다고 선언할 수 없다.

D2는 일반 한국어 IME 성공과 별개의 필수 순서 E(empty compositionend)→U(Undo)→F(late final insert) 관문이다. 기존 조사에서 관측한 E→F→U는 그 관문 PASS가 아니다. 이번 성능 설계는 D2를 해결하지 않는다. D1의 과거31/31, D5의 부분2/2도 다른 산출물의 전체 승인으로 승계하지 않는다.

## 3. 후보 A: 비교가 불필요한 요청을 먼저 분기한다

### 3.1 문제와 최소 범위

출력 재사용을 늘리기 전에, ‘이번 요청은 정책상 무조건 full draw한다’는 경우에만 JSON 생산/parse/summary를 생략할 수 있는지 검사한다. 이는 changed page가 무엇인지 완벽히 판정하는 알고리즘이 아니다. 변경 여부를 모르면 그려 버리는 보수적 정책이다. **같은 revision이라서 안 그리는 경로를 새로 만들지 않는다.**

두 하위 경우를 분리한다.

A0: 새 Canvas, 해제 후 재할당, bitmap 크기/scale/geometry 불일치 등 기존 조건만으로 생략 불가능한 요청. JSON 비교 이전에 그리기 결정을 내리는 short-circuit. 주로 초기/zoom/resize 경로이므로 타이핑 D4의 큰 개선을 기대할 근거는 부족하다.

A1: 성공한 편집 이후 화면 갱신 요청 가운데, 이번 revision에서 반드시 전체 재도색하도록 명시한 쪽. current mutation token과 해당 요청을 묶고, 출력 같음 판정을 아예 시도하지 않는다. 실제로 그림이 바뀌지 않은 쪽을 포함해도 정확성은 보수적이지만 추가 비용은 생긴다. 그러므로 전체 문서에 무조건 적용하지 말고 현재 요청·가시 쪽 경계에서만 후보를 계측한다.

### 3.2 제안 의사코드

현재 `paintedSummary`는 쿼리 부재·실패·미지 트리에서 null을 돌려주고, `isPageUnchanged`는 painted가 null이면 false다. 이 기존 분기를 활용해 조건부로 painted=null을 선택하면 나머지 full draw·실패 시 drawnAt 삭제·성공 뒤 기록·firstPaint 처리를 재작성하지 않아도 된다. 제안의 최소 변경은 `const painted = mustDrawFullWithoutComparison ? null : this.paintedSummary(doc, page)`에 해당한다. mustDrawFullWithoutComparison은 새 설계 변수이지 존재하는 API가 아니다. 구현 전에 호출 횟수·엔진 쿼리 부수효과를 확인해야 한다.

아래 이름은 현재 API가 아니라 알고리즘 설명이다. 기존 prepare/예산/오류 처리의 위치를 유지한다.

```text
render_request(request):
    validate_session_generation_revision_and_canvas_owner(request)
    prepare_rendering_under_existing_budget(request)
    if existing_geometry_rules_already_require_full(request)
       or explicitly_forced_full_for_this_mutation_request(request):
        invalidate_comparison_record_for_canvas(request.canvas)
        draw_full_using_existing_engine(request.page, request.canvas)
        publish_success_only_after_successful_draw(request)
        keep_comparison_record_unknown()
        return
    run_existing_json_comparison_and_full_render_path(request)
```

핵심은 이전 JSON을 새 bitmap의 JSON인 것처럼 남기지 않는 것이다. 비교 기록은 UNKNOWN으로 만들고 후속 비교는 기존 경로에서 새로 만든다. full draw 실패·context loss·세션 변경이면 성공 기록과 지연 표본을 발행하지 않는다. bitmap을 살려 두는 수명·retry·해제 규칙도 동일해야 한다.

새 force token은 세션·엔진 세대·revision·요청 소유권을 포함해 stale 작업에 재사용되지 않게 한다. 정책 대상이 아닌 요청은 기존 코드로 돌아간다. 후속 비편집 요청에서 digest가 없기 때문에 full draw가 한 번 더 생길 수 있다. 이를 숨기거나 ‘revision만 같음’으로 생략하지 말고 횟수·총 CPU·지연·메모리로 평가한다.

### 3.3 안전성·손익·기존 실패와 차이

모델/쪽 나눔은 그대로이며 기존 full draw를 더 일찍 선택한다. 그러므로 새로운 cross-revision 출력 동일성 토큰을 승인받는 접근과 다르다. 하지만 성공 발행 순서, 추가 그리기, summary의 검증 오류 처리에 실제 부작용이 없는지는 시험해야 한다. 기존 summary 검증을 안전성 경계로 사용하는 소비자가 있으면 해당 검증을 삭제할 수 없다. 읽기/쓰기/오류 전파 전체를 다시 확인한 뒤 실험 범위를 확정한다.

기존 전체 구조·micro-optimization 조사에서 end-to-end 성공이 확보되지 않았다는 보류 결정을 유지한다. 과거 일부 단계 개선을 새 전체 성공 사례로 바꾸지 않는다. A1을 검토할 이유는 **현재 제품의 안전한 full render 정책에서, 특정 요청에만 적용하는 비교용 자료 생략**이라는 범위를 분리할 수 있기 때문이다. 실제 호출 변화와 비용 제거가 관측되지 않거나 같은 실패를 반복하면 중단한다.

기록상 layer JSON p50 8ms는 해당 경로의 규모를 보여줄 뿐, 8ms 순이익 보장이 아니다. parse/summary의 추가 비용은 같은 실행에서 별도로 측정한다. 엔진이 JSON 쿼리 덕분에 생성한 캐시를 full draw가 다시 만들면 이득이 작거나 음수일 수 있다. 따라서 JSON 생성·parse·tree build·full draw의 배타 시간과 횟수를 같은 input에 붙여 비교해야 한다. A만으로95→50ms를 주장하지 않는다.

## 4. 후보 B: 한 트랜잭션 안에서 파생 결과를 한 번만 만든다

### 4.1 목표와 기존 아키텍처 조사와의 차이

원격 worker로 넘기거나 필수 렌더를 미루는 것이 아니라, 동기 편집 한 번에서 이미 필요한 결과의 중복 생성·거대한 직렬화 경로를 줄이는 설계다. 기존 staged publication/worker/full fusion의 구현 NO-GO를 해제한 것이 아니다. 아래의 bounded 자료구조·수명·실제 중복 비용 증명이 갖춰질 때만 별도 후보가 된다.

제안 `PreparedFrame`은 mutation이 끝난 단일 모델 스냅숏, 필요한 page/tree, caret/selection 투영, font/metric/resource 입력을 묶는다. 엔진은 동일 프레임에 대해 UI에 필요한 작은 자료만 내보내고 full renderer는 엔진 내부 프레임을 사용한다. JS로 넘긴 전체 tree JSON을 다시 순회하는 경로를 단순히 큰 JS object 전환으로 대체하지 않는다.

### 4.2 자료구조와 트랜잭션

```text
PreparedFrame {
  owner_session, engine_generation, model_revision,
  render_profile, scale_and_device_geometry,
  frozen_semantic_inputs,
  complete_page_tree_and_render_sidecars,
  bounded_resource_leases,
  compact_ui_projection
}

transaction(command):
  enter_existing_history_boundary()
  apply_command_and_complete_required_layout()
  prepare_frame_once_for_required_page_set()
  validate_frame_owner_and_frozen_inputs()
  draw_each_required_page_fully_from_frame()
  publish_matching_ui_projection_and_completion()
  release_frame_and_leases()
```

정확한 함수 이름·현재 코드에 가능한 borrow 구조는 구현 설계에서 확정한다. 지금 존재하는 API라고 인용하지 않는다. async로 변경하거나 revision을 먼저 publish할 필요가 없다. reentrant callback·동시 resource 변경·context loss로 frozen 입력이 깨지면 해당 프레임 사용을 중단하고 기존 경로로 복귀하거나 기존 실패 정책을 적용한다.

### 4.3 반드시 증명할 사항

- UI projection과 renderer가 같은 revision을 본다. caret/hit-test/history 상태가 새 모델인데 그림은 옛 모델인 상태를 성공으로 발행하지 않는다.
- renderer가 읽는 serde-skipped sidecar·정밀 bbox·field/numbering/header/footer·font metric·resource를 전부 포함하거나 프레임 수명 동안 변경을 막는다. JSON이나 PageContent만 복사해 충족했다고 하지 않는다.
- native raw `document_mut`나 공유 mutable 객체가 epoch를 우회하지 못한다. 모든 writer를 감싼 mutation guard 또는 명시적인 frozen owned input이 필요하다. 범위를 WASM single-thread로 좁혀도 callback/자원 변화가 자동으로 사라지지 않는다.
- 보존될 frame/decoded buffer/Canvas 참조의 peak memory를 기존 예산에 포함한다. 이전·새 frame을 동시에 보유한 순간을 빼면 안 된다. 취소·실패·close·세션 교체 시 lease를 정확히 한 번 해제한다.

프레임 재사용은 처음에는 **한 동기 트랜잭션 안으로만** 제한한다. 다음 revision 재사용은 추가 계약 없이는 금지한다. 같은 트랜잭션 제한도 입력의 실제 불변성을 자동 증명하지는 않으므로 관련 G0 의무를 대조한다.

### 4.4 전송 방식 대안

가장 작은 UI projection을 우선한다. 필요한 rect·page count·capability·selection만 구조체로 노출하고 tree는 엔진에 둔다. 다음 선택은 묶음 typed buffer이며 길이·offset·정수 범위·소유권·WASM memory 성장 후 view 유효성을 검사해야 한다. JS object 직접 전환은 그 다음 비교 후보다.

`serde-wasm-bindgen`은 Rust와 JS native type 사이의 변환을 제공하지만 현재 tree에서 반드시 빠르다는 보장은 없다. JSON과 기본 Map/undefined 표현이 다를 수 있으므로 기존 소비자 호환성도 필요하다. JSON→큰 JS object라는 API 이름 변경만으로 비용 제거가 입증되지 않는다. [외부 근거 E1]

## 5. 후보 C: 읽기 의존성이 완전한 증분 쪽 나눔

### 5.1 왜 과거 실험을 그대로 채택할 수 없는가

과거 candidate의 큰 엔진 속도 개선은 유의미한 근거다. 그러나 finite corpus에서 불일치가 없었다는 사실이 모든 외부 읽기·공유 mutable font·paragraph 밖 영향·종료 상태를 완전히 포착했다는 증명은 아니다. [기존 계약](./rhwp-incremental-pagination.md)의 미해결 I-READ/I-EXACT/I-FONT를 닫지 않고 적용하지 않는다. Debug 문자열 hash나 u64 hash만으로 의미 동등성을 확정하지 않는다.

### 5.2 제안 알고리즘

```text
on_mutation(change_set):
  update_immutable_model_versions_for_every_affected_input()
  first = earliest_affected_safe_checkpoint(change_set)
  if first is UNKNOWN or any_writer_or_dependency_is_untracked:
      return full_section_layout()
  state = restore_exact_checkpoint(first)
  recompute_forward(state):
      record_all_external_reads_with_exact_semantic_versions()
      if backward_effect_touches_preserved_prefix:
          restart_from_earlier_safe_checkpoint_or_full()
      if exact_state_equal(old_boundary, new_boundary)
         and all_future_inputs_and_dependencies_are_unchanged
         and pending_backward_effects_are_empty:
          append_verified_immutable_suffix()
          return
  return recomputed_to_end
```

‘모든 future input 불변’은 인접 문단 한 개나 쪽 수만 비교한다는 뜻이 아니다. 변경되지 않은 immutable suffix의 신원과 global style/resource/metric/section 조건을 포함한다. global numbering·각주/미주·header/footer·표 이어짐·keep-with-next·floating object·앞쪽 수정 영향이 있으면 영향 구간을 확장하거나 full로 되돌아간다.

### 5.3 상태·신원·복잡도

체크포인트에는 실제 TypesetState 필드, 현재 쪽의 아직 변하는 내용, 문단/표 진행 상태, 전후 문맥, 남은 floating/footnote 처리, prefix 역수정 가능성을 담는다. 필드 목록을 자동 추출해 누락을 검토하되 필드 수 일치만으로 의미 검증을 대체하지 않는다.

`Arc::ptr_eq`는 같은 allocation인지 확인할 뿐 내부 Atomic/Mutex 상태가 바뀌지 않았다는 뜻이 아니다. immutable root 또는 mutable semantic version/내용이 필요하다. `Arc::make_mut` 사용 자체도 내부의 별도 공유 mutable 자원까지 동결하지 않는다. [외부 근거 E2]

매 키마다 전체 문서를 hash·clone·비교하면 줄인 조판 비용을 되돌려 쓰게 된다. 변경 단위의 persistent version tree와 명시적 read-set을 사용하되 version 갱신 누락을 막는 writer 경계를 먼저 만든다. 정상 국소 편집의 작업량은 재계산한 k개 단위와 검증 의존성 r에 비례하도록 설계할 수 있으나, global 변경/불확실성/수렴 실패의 최악 비용은 전체 구역이다. 현재 구현의 복잡도가 이미 이렇다고 주장하지 않는다.

Typst의 comemo는 실제 사용된 외부 읽기를 기록하고 재검증하는 constrained memoization의 공개 사례다. RHWP의 조판·역방향 효과·mutable context에 그 증명이 자동 적용되지는 않는다. 라이브러리 추가가 아니라 read-dependency discipline의 참고 근거다. [외부 근거 E3]

## 6. 화학 문서·렌더러 꼬리는 별도로 다룬다

자산 문서는 주로 synchronous layout/JSON/full draw 복합 비용이고 화학 문서는 이미지·validation·캐시/자원 조건에 따른 큰 꼬리가 기록되어 있다. 자산 개선만으로 네 문서 전체 관문을 충족했다고 하지 않는다.

ID 검증 병목이 최신 후보에서도 재현되면 lookup index를 고려할 수 있다. key에 해당하는 모든 후보를 원래 순서의 vector로 유지하고 기존 정확 predicate와 오류 우선순위를 그대로 적용한다. 중복 imported hp:p ID가 허용되므로 ID→단일 항목 map은 안전한 대체가 아니다. 일반적인 비용은 한 번의 O(N) index 구축과 후보 조회로 줄일 수 있으나 중복이 몰린 최악 입력에서는 개선이 제한된다. 성공뿐 아니라 거절 결과·오류 순서의 차등 검사도 필요하다.

PNG 최적화·캐시 admission 변경은 exact image key와 실제 miss/admission/eviction/lease의 표본별 귀속이 새로 확인될 때만 후보로 삼는다. 이미지 decoder의 미세 측정이나 특정 포맷의 개선을 현재 제품 통합/D4 성공으로 읽지 않는다. 필터가 다른 cache hit/miss 계측을 비교해 반복 decode라고 단정하지 않는다. hot cache만 보고 cold 경로를 제외하거나 메모리 예산을 키워 통과시키지 않는다.

full draw 자체에는 native Canvas 호출 비용이 남는다. font setter memoization·glyph 처리·SIMD·문자열 지연 생성 등은 새로운 계측으로 해당 비용이 주경로에 있음을 확인하기 전까지 우선 해결책으로 지정하지 않는다. display list 생성 감소와 실제 Canvas raster 감소는 다른 목표다. exact full 결과를 바꾸는 bitmap 캐시·레이어 분해·GPU partial redraw는 더 큰 검증 과제이며 다음의 작은 수정으로 포장하지 않는다.

## 7. 측정과 반증: 해결이라고 부를 조건

### 7.1 먼저 동일 신원을 만든다

geul SHA, gitlinks, 패치 계열/source tree, WASM generation/hash, JS/frontend, 실제 앱, fixture, producer/evaluator, OS/runtime·Canvas backend·DPR·IME를 기록한다. 최신 제품 source와 과거 실험 source를 같은 baseline으로 섞지 않는다. source-before/after가 같아야 하고 실제 앱이 같은 WASM module을 사용하는지 확인한다. 기존 alias mismatch로 geometry가 비었던 시험 오류를 제품 오류로 재분류하지 않는다.

### 7.2 같은 input의 배타 구간을 측정한다

input ID·세션·generation·revision·page·Canvas epoch로 mutation/layout/validation/JSON/parse/summary/render/RAF를 연결한다. 부모 span에서 자식 interval의 합집합을 빼서 exclusive time을 구한다. 겹치는 interval을 두 번 빼지 않는다. 서로 다른 실행의 p50이나 각 구간 p95를 더해 새 end-to-end 예측값으로 쓰지 않는다.

계측 ON/OFF 교대 실행으로 계측 오버헤드부터 확인한다. 성능 채택은 계측 OFF의 원래 공식 producer를 사용한다. 동일 fixture 순서의 편향을 피하려고 진단 A/B는 사전에 정한 교대 순서를 쓰되 공식 시나리오 자체는 바꾸지 않는다. 실패한 실행과 느린 표본도 남긴다.

3RAF는 계약의 끝점이지 고정50ms 하한이나 항상 실제 compositor 완료를 보장하는 신호가 아니다. HTML은 rendering opportunity를 event-loop 절차로 정의한다. 따라서 rAF 수를 줄이거나 no-work 시간을 빼서 성능 점수를 보정하지 않는다. [외부 근거 E4]

### 7.3 후보별 반례

| 후보 | 필수 음성·경계 시험 | 거절 조건 |
|---|---|---|
| A 비교 생략 | full draw 예외, stale 요청, context loss, resize/DPR, session swap, 같은 revision 재요청, 그림이 안 바뀐 편집 | 성공 조기 발행, stale JSON/bitmap 승계, full 호출 폭증으로 총 지연 악화 |
| B prepared frame | model 동일·font/resource/field 변경, reentrant writer, lease release 실패, 취소, close, memory 성장 | 같은 snapshot 내부의 입력 불변성 미증명, 혼합 revision, 예산 초과 |
| C 증분 쪽 나눔 | 표/각주/float/section/style/global numbering, 앞쪽 역수정, 합치기/나누기/붙이기/Undo, 중복 ID, 마지막 문단 | 읽기 누락, 수렴 오판, prefix 변동, 거절 진단 변화 |
| ID index | 동률/중복 후보, 누락/잘못된 ID, 앞선 오류, 악성 큰 입력 | 후보 손실·원래 첫 오류 변화·비선형 메모리 증가 |

모든 후보는 독립 full layout/semantic oracle, strict full RGBA, caret/selection/hit-test, 저장·재열기와 실패 안전성을 통과해야 한다. 후보와 과거 불완전 patch끼리만 같다는 비교는 full 정답 증명이 아니다. native WebKitGTK GPU/CPU 및 지원 browser의 해당 scale/DPR 범위를 명시한다. 음성 pixel/identity perturbation이 실제 실패를 검출해야 한다. 메모리 제한 때문에 실행하지 못한 scale은 NOT RUN으로 남긴다.

### 7.4 채택·중단 조건

단일 후보는 제거한 호출·비용이 실제로 관측되고, correctness/resource 회귀가 없으며, 원래 D4의 관련 표본과 전체 네 문서에서 새 평가 결과가 있어야 채택 검토 대상이다. 미세 단계가 빨라졌어도 전체 p95가 그대로면 성능 해결로 채택하지 않는다. 원래 기준을 통과하지 못하면 D4 FAIL을 유지한다. D4가 통과해도 D2, D3, D5 및 선행 작업이 자동으로 완료되지는 않는다.

이득이 없거나 기존 실패 가설을 반복하는 후보는 패치를 격리하고 다음 독립 가설로 간다. 표본 반복으로 우연히 PASS 하나를 고르는 작업, 원시 실패 삭제, 버퍼 예산 확대, 필요한 그림 지연, 새 체크포인트 시스템 구축으로 조사만 늘리는 작업은 중단한다.

## 8. 실행 순서와 기대 효과의 정직한 한계

1. 기본 개발은 T007/T008·T009의 남은 수용을 우선한다. 본 연구의 존재는 T010 ON HOLD를 해제하지 않는다.
2. T010을 별도로 재개할 때 현재 FULL_PAGE_ONLY 신원의 A0/A1 호출 경로를 정적으로 한정하고, summary 검증의 다른 소비자가 없음을 확인한다. 제거할 작업이 실제 존재하는 경우에만 최소 후보와 현 baseline을 비교한다.
3. A가 충분하지 않고 중복 tree/projection 생산이 실제로 남으면 B의 단일 트랜잭션 불변성·수명·예산 계약을 먼저 닫는다. 실패하면 현행 경로를 유지한다.
4. C는 큰 조판 비용을 줄일 가능성이 과거 실험으로 뒷받침되지만 I-READ/I-EXACT/I-FONT 등 미해결 증명을 마친 별도 엔진 후보여야 한다. 당시 candidate를 최신 제품에 그대로 덮어쓰지 않는다.
5. A/B/C를 조합할 때는 각 단독 결과와 조합 결과를 새로 측정한다. 제거되는 중복 비용이 겹치므로 합산 이득을 주장하지 않는다. 화학 문서 꼬리·자원도 독립적으로 점검한다.

기록의 자산95ms와 목표50ms 간 차이는45ms다. 다른 신원의 과거 incremental engine 개선 약19ms는 전체 관문을 통과시키지 못했고, JSON p50 8ms도 전부 제거된다고 보장할 수 없다. full draw·caret·상태 발행·프레임 대기를 포함한 경로 전체의 실측이 필요하다. 예컨대 ‘후행 대기28ms라면 동기 작업 예산22ms’는 해당 상황의 산술적 설계 참고일 뿐 서로 다른 p95를 빼서 구한 보장 예산이 아니다. 확정된 해결책은 새 native 원래 관문과 correctness 증거가 생긴 뒤에만 보고한다.

## 9. 근거와 출처

### 저장소 근거 (기준 SHA 8d3f21a)

- [rhwp-undo-redo.md](./rhwp-undo-redo.md): 단일 수용 행렬, canonical D1/D4, 병목/실험 실패, 보류·재개 조건.
- [rhwp-incremental-pagination.md](./rhwp-incremental-pagination.md): full 등가·checkpoint·수렴·실험 범위.
- [RhwpEditorSession.ts](../../src/components/Editor/rhwp/RhwpEditorSession.ts): paintedSummary/isPageUnchanged/renderPage와 full 정책, mutation/history/geometry.
- [RhwpSurface.tsx](../../src/components/Editor/rhwp/RhwpSurface.tsx): 실제 그리기·수명·지연 표본·retry.
- [rhwpHistory.ts](../../src/components/Editor/rhwp/rhwpHistory.ts): group/snapshot/restore 계약.
- [tasks.md](../planning/tasks.md): 선행 조건·현황·원래 계약 보존.

### 외부 1차 자료 (2026-11-03 조회; geul 성능 검증을 대신하지 않음)

- E1: serde-wasm-bindgen 문서, https://docs.rs/serde-wasm-bindgen/latest/serde_wasm_bindgen/ — Rust/JS 변환과 표현 호환성.
- E2: Rust std::sync::Arc 문서, https://doc.rust-lang.org/std/sync/struct.Arc.html — ptr_eq·내부 가변성·make_mut.
- E3: Typst comemo 저장소, https://github.com/typst/comemo — 외부 읽기 추적에 기반한 constrained memoization.
- E4: WHATWG HTML event loop/rendering, https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering — rendering opportunity와 event loop.

최종 구분: 저장소 코드/공개 기록은 관측 근거, A/B/C·의사코드·순서는 새 설계 제안, 외부 자료는 설계 원리의 참고다. 새 runtime 원인·성능 PASS·무결함은 주장하지 않는다.
