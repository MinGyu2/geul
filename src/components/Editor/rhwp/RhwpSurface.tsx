// rhwp 편집 표면(T007). 페이지마다 canvas에 rhwp가 그리고, 커서·선택·조합 밑줄은 그 위의 DOM 겹침으로 그린다.
//
// 좌표: rhwp 페이지 좌표는 배율 1의 CSS px다. 화면 배율 z = zoom/100에서 페이지 상자는 (너비·높이 × z) CSS px,
// canvas 비트맵은 × z × devicePixelRatio로 그려 고배율에서도 선명하다. 마우스 위치는 canvas의 화면 사각형을 기준으로
// ÷ z 해서 hitTest에 넘기고, 커서·선택 사각형은 × z로 그린다. 그리기와 hit test가 같은 변환 하나만 쓴다
// (스크롤·페이지 사이 간격은 canvas 사각형에 이미 반영됨).
//
// 입력: 화면에 보이지 않는 textarea 하나가 키보드·IME를 받는다. 커서 위치로 옮겨 두어 IME 후보 창이 커서 옆에 뜬다.
// React가 다시 그려도 같은 요소를 쓰므로 조합 상태·초점이 사라지지 않는다. 이벤트는 네이티브 리스너로 받는다.
// textarea 이벤트 해석(조합 계열 input·data 없는 넣기·바꾸기 입력 거부·쌓인 값 비우기)은 WordCraft 표면(T008)과 함께 쓰는
// ../textInput.ts에 있다(T007에서 옮김, 동작 같음).
// - 조합 이벤트 해석(조합 하나는 끝이 한 번, 클릭·초점 잃음으로 끝낸 조합의 늦은 확정)은 imeInput.ts의 ImeInput이
//   맡는다. 여기서는 DOM 이벤트를 넘기고 textarea를 비운다. 끊긴 조합은 편집 표면 사이에서 공유하는 ImeContext에
//   두므로(작업 공간이 하나를 넘겨 줌) 탭을 바꾼 뒤 도착한 옛 조합의 늦은 확정이 다른 문서에 들어가지 않는다. 표면이
//   사라질 때(초점 잃음 이벤트가 없어도) 문서에 보이던 조합을 그 문서에 확정해, 조합 상태가 남아 다음 입력을 막지 않게 한다.
// - 조합 중 방향키 등은 조합이 끝난 뒤 처리한다. 페이지를 누르면 ImeInput이 진행 중인 조합을 끝낸다(보이면 그 자리에
//   확정하고 입력기가 뒤이어 보내는 그 조합의 꼬리를 소비). textarea 값·초점은 건드리지 않는다: 실측(WebKitGTK 2.54 +
//   ibus, preedit 사용)에서 조합 중 클릭 때 값을 비우고 blur/focus하면 그 뒤 모든 키가 keydown만 남기고 입력되지 않았다.
//   입력기는 클릭에서 조합을 스스로 확정한다(ibus GTK 모듈). preedit 없을 때도 초점을 빼면 확정이 오지 않아 음절이 사라졌다.
// 표시 한도: 지금 배율 × devicePixelRatio로 그리면 픽셀 예산을 넘으면(세션의 renderLimit) 쪽을 그리지 않고 그 자리에
// 이유와 할 일(배율 낮추기)을 알린다. 큰 bitmap을 할당하지 않고 이전 것도 놓으며, 편집은 멈춘다(보이는 조합은 한도에
// 들어가기 직전에 그 자리에 확정). 배율 표시는 사용자가 고른 값 그대로이고 다른 배율로 몰래 그리지 않는다. 예산 안의
// 배율로 돌아오면 같은 모델로 다시 그리고 편집을 이어 간다.
// 응답 시간: 입력 이벤트 시각부터 바뀐 페이지를 다시 그린 뒤 두 번째 animation frame까지를 잰다(화면 반영의 상한).
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import { ZOOM_STEPS } from "../../../hooks/layoutState";
import { useTranslation } from "../../../language/LanguageContext";
import { attachTextInput } from "../textInput";
import { ImeContext, ImeInput } from "./imeInput";
import type { RhwpEditorSession } from "./RhwpEditorSession";
import type { PageRect } from "./rhwpText";
import { trace } from "../imeTrace";

interface RhwpSurfaceProps {
  session: RhwpEditorSession;
  zoom: number;
  /** WebView의 IME 문맥(편집 표면 사이에서 공유). 없으면 이 표면만의 문맥을 쓴다. */
  imeContext?: ImeContext;
}

/** 입력 중 커서 쪽이 아닌 쪽을 다시 그리기까지 기다리는 시간(새 입력이 오면 다시 기다림). */
const REST_DELAY_MS = 200;
const HIDDEN_UNDERLINE: CSSProperties = { left: 0, top: 0, width: 0, visibility: "hidden" };
/** 조합 밑줄 자리: 조합이 없어도 하나(숨김)를 둔다. */
const padComposition = (rects: PageRect[]): (PageRect | null)[] => (rects.length > 0 ? rects : [null]);

/** 세션이 바뀔 때마다 다시 그린다. 그리기 layout effect보다 먼저 구독해, 처음 그릴 때의 상태 변화(표시 한도)도 받는다. */
function useSessionUpdates(session: RhwpEditorSession) {
  const [, update] = useReducer((tick: number) => tick + 1, 0);
  useLayoutEffect(() => session.subscribe(update), [session]);
}

export function RhwpSurface({ session, zoom, imeContext }: RhwpSurfaceProps) {
  const { t } = useTranslation();
  trace("rhwp:surface-render");
  useSessionUpdates(session);
  const scale = zoom / 100;
  const ratio = window.devicePixelRatio || 1;
  const pagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const pageBoxes = useRef(new Map<number, HTMLDivElement>());
  const inputAt = useRef<number | null>(null);
  const renderTimer = useRef<number | null>(null);
  const ime = useRef<ImeInput | null>(null);
  const [ownContext] = useState(() => new ImeContext());
  const context = imeContext ?? ownContext;
  const dragging = useRef(false);
  const rendered = useRef({ version: -1, scale: 0, ratio: 0, pages: 0, sizes: "" });
  /** 지금 모델로 아직 다시 그리지 않은 쪽(커서 쪽 밖, 그리기 예약됨). */
  const stalePages = useRef(new Set<number>());
  const drawStale = useRef<((page: number) => void) | null>(null);
  /** 스크롤 영역에 조금이라도 보이는 쪽. */
  const visiblePages = useCallback(() => {
    const result = new Set<number>();
    const scroller = pagesRef.current?.closest(".editor__scroll");
    if (!scroller) return result;
    const view = scroller.getBoundingClientRect();
    for (const [page, box] of pageBoxes.current) {
      const rect = box.getBoundingClientRect();
      if (rect.bottom > view.top && rect.top < view.bottom && rect.right > view.left && rect.left < view.right) result.add(page);
    }
    return result;
  }, []);

  const caret = session.caretRect();
  const selection = session.selectionRects();
  const composition = session.compositionRects();

  // ---- 그리기 ----
  useLayoutEffect(() => {
    trace("rhwp:surface-effect");
    const last = rendered.current;
    const sizes = session.pages.map((size) => `${size.width}x${size.height}`).join(",");
    const all = last.scale !== scale || last.ratio !== ratio || last.pages !== session.pages.length || last.sizes !== sizes;
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
    // bitmap 크기가 바뀔 수 있으면(배율·DPR·쪽 수·쪽 크기) 이전 bitmap을 먼저 놓아 새 크기와 함께 예산을 넘지 않게 한다.
    // 크기가 같으면 놓지 않고 그 자리에서 다시 그린다(편집마다 bitmap을 새로 잡지 않음).
    if (all) session.releaseRendering();
    rendered.current = { version: session.modelVersion, scale, ratio, pages: session.pages.length, sizes };
    // 커서 쪽을 먼저 그리고 나머지는 다음 task에 그린다. WebView가 frame clock을 멈춰도 빈 쪽으로 남기지 않는다.
    const first = session.caretRect()?.page ?? 0;
    const version = session.modelVersion;
    const draw = (page: number) => {
      if (session.modelVersion !== version) return; // 대기 중 모델이 교체·변경됐으면 이 작업은 무효다
      const canvas = canvases.current.get(page);
      if (canvas) session.renderPage(page, canvas, scale * ratio);
    };
    const drawStarted = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
    draw(first);
    trace("rhwp:surface-first-draw", () => ({ page: first, ms: performance.now() - drawStarted }));
    drawStale.current = draw;
    const started = inputAt.current;
    inputAt.current = null;
    if (started !== null) {
      requestAnimationFrame(() => requestAnimationFrame(() => session.recordLatency(performance.now() - started)));
    }
    // 커서 쪽에서 가까운 쪽부터, 한 task에 한 쪽씩 그린다(8차: 30쪽을 한 task에 그리면 160 ms 넘게 입력을 막았다).
    const rest = session.pages.map((_, page) => page).filter((page) => page !== first)
      .sort((a, b) => Math.abs(a - first) - Math.abs(b - first));
    // 모든 쪽을 새로 정할 때(처음·배율·DPR·쪽 수·쪽 크기)는 모든 쪽을 바로(다음 task부터) 그린다. 편집 뒤에는 화면에 보이는 쪽만
    // 바로 그리고, 화면 밖 쪽은 입력이 멈춘 뒤(REST_DELAY_MS) 그린다: 키마다 모든 쪽을 다시 그리면 그만큼 입력이 밀린다. 아직
    // 그림이 없는 화면 밖 쪽(처음 그리기를 입력이 끊은 쪽)도 같다(T010 실측 60쪽 HWPX: 키마다 그런 쪽을 하나씩 전체 그리기로
    // 50~160 ms 그려 다음 키가 120~230 ms 늦게 들어왔다). 기다리는 쪽이 스크롤로 보이게 되면 그때 바로 그린다(아래 scroll 처리).
    // 새 변경이 오면 이 작업을 취소하고 다시 정하므로 마지막 모델로 그리며, 옛 작업은 version 검사로 새 모델을 덮지 않는다.
    const visible = visiblePages();
    // Undo/Redo·명령도 모델 변경이다. DOM input 시각이 없다는 이유로 화면 밖 모든 쪽을 즉시 그리면
    // 복원 직후 입력을 막는다. 화면 밖 쪽은 같은 버전 검사·scroll/resize 갱신 아래 쉬는 시간에 그린다.
    const later = !all ? rest.filter((page) => !visible.has(page)) : [];
    const now = rest.filter((page) => !later.includes(page));
    stalePages.current = new Set(rest);
    const queue = [...now.map((page) => [page, 0] as const), ...later.map((page, index) => [page, index === 0 ? REST_DELAY_MS : 0] as const)];
    const step = (index: number) => {
      const next = queue[index];
      if (!next) return;
      renderTimer.current = window.setTimeout(() => {
        renderTimer.current = null;
        if (stalePages.current.delete(next[0])) draw(next[0]);
        step(index + 1);
      }, next[1]);
    };
    step(0);
    // 실제 새 render·unmount만 이 작업을 취소한다. firstPaint·commit 알림의 단순 React 갱신은 취소하지 않는다.
  });

  useLayoutEffect(() => () => {
    if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
    renderTimer.current = null;
    stalePages.current.clear();
    drawStale.current = null;
    session.releaseRendering();
  }, [session]);

  // 그리기를 기다리던 쪽이 보이게 되면 바로 그린다(입력이 이어져도 보이는 쪽이 옛 그림으로 남지 않게). 보이는 쪽은 스크롤 영역의
  // 스크롤 위치와 크기로 정해진다(쪽 크기·배율이 바뀌면 위의 그리기가 모든 쪽을 다시 정함). 스크롤 없이 영역만 커지는 경우(창 크기,
  // 리본 접기, 옆 패널)도 받는다(9차 실측: 리본을 접어 보이게 된 쪽이 입력이 멈춘 뒤까지 251 ms 옛 그림이었다).
  useEffect(() => {
    const scroller = pagesRef.current?.closest(".editor__scroll");
    if (!scroller) return;
    const onViewChange = () => {
      if (stalePages.current.size === 0) return;
      for (const page of visiblePages()) {
        if (stalePages.current.delete(page)) drawStale.current?.(page);
      }
    };
    scroller.addEventListener("scroll", onViewChange, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onViewChange);
    resize?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onViewChange);
      resize?.disconnect();
    };
  }, [visiblePages]);

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
    return attachTextInput(input, controller, {
      composing: () => session.composing,
      handleKey,
      mark,
      detached: () => {
        ime.current = null;
      },
    });
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
    // 진행 중인 조합을 끝낸다(보이면 그 자리에 확정, 아니면 늦게 오는 확정을 클릭 전 자리에 넣도록 기억).
    ime.current?.pointerDown();
    trace("ime:pointerDown", () => ime.current?.phase() ?? {});
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
            {/* 조합 밑줄은 쪽마다 하나를 늘 두고 위치·보임만 바꾼다. 조합 키마다 요소를 만들고 지우면 WebKitGTK(소프트웨어
                렌더링 실측)가 frame마다 수십 ms를 써 입력이 밀렸다. 모양만 바꾸는 것은 커서처럼 싸다. */}
            {padComposition(composition.filter((rect) => rect.page === page)).map((rect, index) => (
              <div
                key={`c${index}`}
                className="rhwp-composition"
                style={rect
                  ? { left: rect.x * scale, top: (rect.y + rect.height) * scale - 2, width: rect.width * scale }
                  : HIDDEN_UNDERLINE}
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
