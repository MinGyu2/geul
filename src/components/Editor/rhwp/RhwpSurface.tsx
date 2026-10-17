// rhwp 편집 표면(T007). 페이지마다 canvas에 rhwp가 그리고, 커서·선택·조합 밑줄은 그 위의 DOM 겹침으로 그린다.
//
// 좌표: rhwp 페이지 좌표는 배율 1의 CSS px다. 화면 배율 z = zoom/100에서 페이지 상자는 (너비·높이 × z) CSS px,
// canvas 비트맵은 × z × devicePixelRatio로 그려 고배율에서도 선명하다. 마우스 위치는 canvas의 화면 사각형을 기준으로
// ÷ z 해서 hitTest에 넘기고, 커서·선택 사각형은 × z로 그린다. 그리기와 hit test가 같은 변환 하나만 쓴다
// (스크롤·페이지 사이 간격은 canvas 사각형에 이미 반영됨).
//
// 입력: 화면에 보이지 않는 textarea 하나가 키보드·IME를 받는다. 커서 위치로 옮겨 두어 IME 후보 창이 커서 옆에 뜬다.
// React가 다시 그려도 같은 요소를 쓰므로 조합 상태·초점이 사라지지 않는다. 이벤트는 네이티브 리스너로 받는다.
// - 조합 이벤트 해석(조합 하나는 끝이 한 번, 클릭·초점 잃음으로 끝낸 조합의 늦은 확정)은 imeInput.ts의 ImeInput이
//   맡는다. 여기서는 DOM 이벤트를 넘기고 textarea를 비운다. 끊긴 조합은 편집 표면 사이에서 공유하는 ImeContext에
//   두므로(작업 공간이 하나를 넘겨 줌) 탭을 바꾼 뒤 도착한 옛 조합의 늦은 확정이 다른 문서에 들어가지 않는다. 표면이
//   사라질 때(초점 잃음 이벤트가 없어도) 문서에 보이던 조합을 그 문서에 확정해, 조합 상태가 남아 다음 입력을 막지 않게 한다.
// - 조합 중 방향키 등은 조합이 끝난 뒤 처리한다. 페이지를 누르면 ImeInput이 진행 중인 조합을 끝낸다. 페이지에 보이는
//   조합이 있을 때만 textarea 초점을 뺐다가 돌려준다(IME가 그 조합을 버리게). 보이는 조합이 없으면 초점을 그대로 둔다:
//   실측(WebKitGTK + ibus, sync mode)에서 초점을 빼면 IME가 클릭 때 내보내는 확정이 페이지에 오지 않아 음절이 사라졌다.
// 표시 한도: 지금 배율 × devicePixelRatio로 그리면 픽셀 예산을 넘으면(세션의 renderLimit) 쪽을 그리지 않고 그 자리에
// 이유와 할 일(배율 낮추기)을 알린다. 큰 bitmap을 할당하지 않고 이전 것도 놓으며, 편집은 멈춘다(보이는 조합은 한도에
// 들어가기 직전에 그 자리에 확정). 배율 표시는 사용자가 고른 값 그대로이고 다른 배율로 몰래 그리지 않는다. 예산 안의
// 배율로 돌아오면 같은 모델로 다시 그리고 편집을 이어 간다.
// 응답 시간: 입력 이벤트 시각부터 바뀐 페이지를 다시 그린 뒤 두 번째 animation frame까지를 잰다(화면 반영의 상한).
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import { ZOOM_STEPS } from "../../../hooks/layoutState";
import { useTranslation } from "../../../language/LanguageContext";
import { ImeContext, ImeInput } from "./imeInput";
import type { RhwpEditorSession } from "./RhwpEditorSession";
import type { PageRect } from "./rhwpText";

interface RhwpSurfaceProps {
  session: RhwpEditorSession;
  zoom: number;
  /** WebView의 IME 문맥(편집 표면 사이에서 공유). 없으면 이 표면만의 문맥을 쓴다. */
  imeContext?: ImeContext;
}

const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter", "Tab", "Escape"]);

/** 세션이 바뀔 때마다 다시 그린다. 그리기 layout effect보다 먼저 구독해, 처음 그릴 때의 상태 변화(표시 한도)도 받는다. */
function useSessionUpdates(session: RhwpEditorSession) {
  const [, update] = useReducer((tick: number) => tick + 1, 0);
  useLayoutEffect(() => session.subscribe(update), [session]);
}

export function RhwpSurface({ session, zoom, imeContext }: RhwpSurfaceProps) {
  const { t } = useTranslation();
  useSessionUpdates(session);
  const scale = zoom / 100;
  const ratio = window.devicePixelRatio || 1;
  const pagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const pageBoxes = useRef(new Map<number, HTMLDivElement>());
  const inputAt = useRef<number | null>(null);
  const renderTimer = useRef<number | null>(null);
  const pendingNavigation = useRef<KeyboardEvent | null>(null);
  const ime = useRef<ImeInput | null>(null);
  const [ownContext] = useState(() => new ImeContext());
  const context = imeContext ?? ownContext;
  const dragging = useRef(false);
  const rendered = useRef({ version: -1, scale: 0, ratio: 0, pages: 0 });

  const caret = session.caretRect();
  const selection = session.selectionRects();
  const composition = session.compositionRects();

  // ---- 그리기 ----
  useLayoutEffect(() => {
    const last = rendered.current;
    const all = last.scale !== scale || last.ratio !== ratio || last.pages !== session.pages.length;
    if (!all && last.version === session.modelVersion) {
      inputAt.current = null; // 문서를 바꾸지 않은 입력(이동·처음에서 Backspace)은 측정하지 않는다
      return;
    }
    if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
    renderTimer.current = null;
    // 그리지 못했으면(표시 한도·실패) 다음 render에서 다시 확인한다. 한도에서 막 풀렸으면 쪽 canvas는 다음 commit에 생긴다.
    const retry = () => {
      rendered.current = { ...last, version: -1 };
      inputAt.current = null;
    };
    if (!session.prepareRendering(scale * ratio, () => ime.current?.detach())) return retry();
    if (canvases.current.size < session.pages.length) return retry();
    session.releaseRendering(); // 이전 bitmap과 새 크기의 bitmap이 함께 예산을 넘지 않게 한다
    rendered.current = { version: session.modelVersion, scale, ratio, pages: session.pages.length };
    // 커서 쪽을 먼저 그리고 나머지는 다음 task에 그린다. WebView가 frame clock을 멈춰도 빈 쪽으로 남기지 않는다.
    const first = session.caretRect()?.page ?? 0;
    const version = session.modelVersion;
    const draw = (page: number) => {
      if (session.modelVersion !== version) return; // 대기 중 모델이 교체·변경됐으면 이 작업은 무효다
      const canvas = canvases.current.get(page);
      if (canvas) session.renderPage(page, canvas, scale * ratio);
    };
    draw(first);
    const started = inputAt.current;
    inputAt.current = null;
    if (started !== null) {
      requestAnimationFrame(() => requestAnimationFrame(() => session.recordLatency(performance.now() - started)));
    }
    const rest = session.pages.map((_, page) => page).filter((page) => page !== first);
    renderTimer.current = window.setTimeout(() => {
      renderTimer.current = null;
      rest.forEach(draw);
    }, 0);
    // 실제 새 render·unmount만 이 작업을 취소한다. firstPaint·commit 알림의 단순 React 갱신은 취소하지 않는다.
  });

  useLayoutEffect(() => () => {
    if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
    renderTimer.current = null;
    session.releaseRendering();
  }, [session]);

  // ---- 커서 위치로 textarea 옮기기·보이게 하기 ----
  // 페이지 상자의 위치는 그린 뒤에야 알 수 있으므로 layout effect에서 직접 옮긴다(React 상태를 늘리지 않음).
  useLayoutEffect(() => {
    const input = inputRef.current;
    const box = caret ? pageBoxes.current.get(caret.page) : undefined;
    if (!input) return;
    input.style.left = `${box && caret ? box.offsetLeft + caret.x * scale : 0}px`;
    input.style.top = `${box && caret ? box.offsetTop + caret.y * scale : 0}px`;
    input.style.height = `${caret ? caret.height * scale : 16}px`;
  });
  const caretElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    caretElement.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [caret?.page, caret?.x, caret?.y]);

  const focusInput = useCallback(() => inputRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    // 모달 확인 창(aria-modal)이 초점을 가진 동안에는 다시 편집 가능해져도(잠금 해제·늦게 끝난 불러오기) 초점을 가져가지 않는다.
    if (session.editable && !document.activeElement?.closest("[aria-modal='true']")) focusInput();
  }, [session, session.editable, focusInput]);

  // ---- 키보드·IME ----
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const controller = new ImeInput(session, context);
    ime.current = controller;
    const mark = (event: Event) => {
      inputAt.current = event.timeStamp;
    };
    const handleKey = (event: KeyboardEvent): boolean => {
      const extend = event.shiftKey;
      // WebKitGTK는 Shift+Tab(GDK ISO_Left_Tab)을 key "Unidentified", code "Tab"으로 보낸다(실측).
      const key = event.key === "Unidentified" && event.code === "Tab" ? "Tab" : event.key;
      switch (key) {
        case "ArrowLeft": return session.moveHorizontal(-1, extend) || true;
        case "ArrowRight": return session.moveHorizontal(1, extend) || true;
        case "ArrowUp": return session.moveVertical(-1, extend) || true;
        case "ArrowDown": return session.moveVertical(1, extend) || true;
        case "Home": return session.moveLineEdge("start", extend) || true;
        case "End": return session.moveLineEdge("end", extend) || true;
        case "Backspace": mark(event); session.backspace(); return true;
        case "Delete": mark(event); session.deleteForward(); return true;
        case "Enter": mark(event); session.enter(); return true;
        // 표 안에서는 셀 이동(첫·마지막 셀에서 더 갈 곳이 없어도 편집 영역을 떠나지 않음, 행 추가는 범위 밖).
        // 표 밖의 Tab은 막지 않아 초점 이동(키보드 접근성)을 그대로 둔다.
        case "Tab":
          if (!session.caret.cell) return false;
          session.moveCell(extend ? -1 : 1);
          return true;
        default: return false;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      controller.keyDown();
      if (event.ctrlKey || event.metaKey || event.altKey) return; // 단축키는 명령 레지스트리(T010) 몫
      if (event.isComposing || event.keyCode === 229) {
        if (NAVIGATION_KEYS.has(event.code) || NAVIGATION_KEYS.has(event.key)) pendingNavigation.current = event;
        return;
      }
      if (handleKey(event)) event.preventDefault();
    };
    const onCompositionStart = (event: CompositionEvent) => {
      mark(event);
      controller.compositionStart();
    };
    const onInput = (event: Event) => {
      mark(event);
      const { inputType = "", isComposing = false } = event as InputEvent;
      const composing = session.composing || isComposing;
      const text = input.value;
      if (!composing) input.value = "";
      controller.input(text, inputType, isComposing);
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      mark(event);
      const finalText = input.value || event.data || "";
      input.value = "";
      controller.compositionEnd(finalText);
      const pending = pendingNavigation.current;
      pendingNavigation.current = null;
      if (pending) handleKey(pending);
    };
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("input", onInput);
    input.addEventListener("compositionend", onCompositionEnd);
    const onBlur = () => {
      controller.blur();
      input.value = "";
    };
    input.addEventListener("blur", onBlur);
    return () => {
      input.removeEventListener("blur", onBlur);
      controller.detach();
      ime.current = null;
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("input", onInput);
      input.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [session, context]);

  // ---- 마우스 ----
  const pointer = (event: React.MouseEvent<HTMLDivElement>, page: number, extend: boolean) => {
    const canvas = canvases.current.get(page);
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    session.pointAt(page, (event.clientX - box.left) / scale, (event.clientY - box.top) / scale, extend);
  };
  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>, page: number) => {
    if (event.button !== 0 || !session.editable) return;
    event.preventDefault(); // 초점은 textarea에 둔다
    const input = inputRef.current;
    // 진행 중인 조합을 끝낸다(보이면 그 자리에 확정, 아니면 늦게 오는 확정을 클릭 전 자리에 넣도록 기억).
    const visible = session.composing;
    ime.current?.pointerDown();
    if (input && visible) {
      input.value = "";
      input.blur();
    }
    pointer(event, page, event.shiftKey);
    dragging.current = true;
    const stop = () => {
      dragging.current = false;
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mouseup", stop);
    focusInput();
  };
  const onMouseMove = (event: React.MouseEvent<HTMLDivElement>, page: number) => {
    if (dragging.current && event.buttons & 1) pointer(event, page, true);
  };

  const rectStyle = (rect: PageRect): CSSProperties => ({
    left: rect.x * scale, top: rect.y * scale, width: rect.width * scale, height: rect.height * scale,
  });

  const limited = session.renderLimit !== null;
  // 가장 작은 배율로도 그릴 수 없으면 배율을 낮추라고 안내하지 않는다.
  const minimum = limited && !session.fitsRendering((ZOOM_STEPS[0] / 100) * ratio);
  return (
    <div className="rhwp-surface">
      <div className="rhwp-pages" ref={pagesRef}>
        {limited && (
          <p className="editor__notice rhwp-render-limit" role="alert" data-testid="rhwp-render-limit" data-minimum={minimum}>
            {t(minimum ? "editor.rhwp.renderLimitMinimum" : "editor.rhwp.renderLimit", { zoom })}
          </p>
        )}
        {!limited && session.pages.map((size, page) => (
          <div
            key={page}
            className="rhwp-page"
            data-page={page}
            ref={(element) => {
              if (element) pageBoxes.current.set(page, element);
              else pageBoxes.current.delete(page);
            }}
            style={{ width: size.width * scale, height: size.height * scale }}
            onMouseDown={(event) => onMouseDown(event, page)}
            onMouseMove={(event) => onMouseMove(event, page)}
          >
            <canvas
              className="rhwp-page__canvas"
              width={0}
              height={0}
              style={{ width: size.width * scale, height: size.height * scale }}
              ref={(element) => {
                if (element) canvases.current.set(page, element);
                else canvases.current.delete(page);
              }}
              aria-hidden="true"
            />
            {selection.filter((rect) => rect.page === page).map((rect, index) => (
              <div key={`s${index}`} className="rhwp-selection" style={rectStyle(rect)} />
            ))}
            {composition.filter((rect) => rect.page === page).map((rect, index) => (
              <div
                key={`c${index}`}
                className="rhwp-composition"
                style={{ left: rect.x * scale, top: (rect.y + rect.height) * scale - 2, width: rect.width * scale }}
              />
            ))}
            {caret && caret.page === page && session.editable && (
              <div
                ref={caretElement}
                className="rhwp-caret"
                data-testid="rhwp-caret"
                style={{ left: caret.x * scale, top: caret.y * scale, height: caret.height * scale }}
              />
            )}
          </div>
        ))}
        <textarea
          ref={inputRef}
          className="rhwp-input"
          aria-label={t("editor.input")}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={!session.editable}
        />
      </div>
    </div>
  );
}
