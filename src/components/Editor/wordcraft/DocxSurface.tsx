// WordCraft(DOCX) 편집 표면(T008, W-A). 쪽은 백엔드가 그린 PNG를 canvas에 옮겨 그리고, 커서·선택·IME 조합 글자는 그 위의
// DOM 겹침으로 그린다.
//
// 좌표: WordCraft 좌표는 pt(쪽 왼쪽 위 기준)다. 화면 배율 z = zoom/100에서 1pt = z × 96/72 CSS px(k). 쪽 상자 = 크기 × k CSS px,
// 쪽 그림은 × k × devicePixelRatio 픽셀로 그려 받는다(선명도). 마우스 위치는 쪽 상자 사각형 기준 ÷ k로 백엔드에 보내 hit test
// 한다. 커서·선택 사각형은 × k로 그린다. 그리기와 hit test가 같은 변환 하나만 쓴다.
//
// 입력: 숨긴 textarea 하나와 그 이벤트 해석(../textInput.ts)·조합 규칙(ImeInput)은 rhwp 표면(T007)과 같다. 조합 중 글자는
// 모델을 바꾸지 않고 커서 자리에 겹쳐 보이며(배경을 칠해 아래 글자를 가림), 커서 막대는 조합 글자 뒤에 둔다. 확정 글자만
// 백엔드로 간다.
// 표시 한도: 지금 배율 × DPR로 그리면 그림 예산을 넘으면 그리지 않고 안내하며 편집을 멈춘다(배율을 낮추면 이어 감).
// 그림 실패(T008 안정화): 다시 시도해도 지금 판을 그리지 못한 쪽은 그 쪽과 안내에 보이고(편집 멈춤), 다시 그리기를 고를 수 있다.
// 화면 canvas에 옮기지 못한 쪽(2차 안정화)도 같다. 쪽의 data-current는 화면에 지금 판을 옮겼는지다(화면 밖 래스터만이 아님).
// 넣지 못한 입력(넣을 수 없는 글자·한도 초과·엔진이 일부 거부)은 안내한다. 표면이 사라지면 쪽 그림(화면·화면 밖)을 놓는다.
// 응답 시간(키 입력, T007과 같은 기준이며 문서를 바꾸지 않는 방향키도 센다. 마우스는 세지 않음): 입력 이벤트마다, 보내는 중인 연산이 없고 보이는 쪽 그림이 모두 지금 판이 되어 그린 뒤 두 번째 animation frame까지
// (입력이 밀려 여러 입력이 한 화면에 함께 반영되면 각 입력의 대기를 따로 센다).
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import type { DocxRect } from "../../../adapters/docx";
import { ZOOM_STEPS } from "../../../hooks/layoutState";
import { useTranslation } from "../../../language/LanguageContext";
import { ImeContext, ImeInput } from "../rhwp/imeInput";
import { attachTextInput } from "../textInput";
import { CSS_PX_PER_PT, type DocxEditorSession } from "./DocxEditorSession";

interface DocxSurfaceProps {
  session: DocxEditorSession;
  zoom: number;
  /** WebView의 IME 문맥(편집 표면 사이에서 공유). */
  imeContext?: ImeContext;
}

function useSessionUpdates(session: DocxEditorSession) {
  const [, update] = useReducer((tick: number) => tick + 1, 0);
  useLayoutEffect(() => session.subscribe(update), [session]);
}

export function DocxSurface({ session, zoom, imeContext }: DocxSurfaceProps) {
  const { t } = useTranslation();
  useSessionUpdates(session);
  const k = (zoom / 100) * CSS_PX_PER_PT;
  const ratio = window.devicePixelRatio || 1;
  const scale = k * ratio;
  const pagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const pageBoxes = useRef(new Map<number, HTMLDivElement>());
  const overlayRef = useRef<HTMLSpanElement>(null);
  const [overlayWidth, setOverlayWidth] = useState(0);
  /** 아직 화면에 반영하지 않은 입력 이벤트 시각들. */
  const inputAt = useRef<number[]>([]);
  const ime = useRef<ImeInput | null>(null);
  const [ownContext] = useState(() => new ImeContext());
  const context = imeContext ?? ownContext;
  const dragging = useRef(false);
  const view = session.view;
  const pages = view?.pages ?? [];
  const caret = view?.caret ?? null;
  const composition = session.compositionText;

  const visiblePages = useCallback(() => {
    const result: number[] = [];
    const scroller = pagesRef.current?.closest(".editor__scroll");
    const bounds = scroller?.getBoundingClientRect();
    for (const [page, box] of pageBoxes.current) {
      const rect = box.getBoundingClientRect();
      // 크기를 알 수 없으면(시험 환경) 보이는 것으로 본다.
      if (!bounds || bounds.height === 0 || (rect.bottom > bounds.top && rect.top < bounds.bottom)) result.push(page);
    }
    return result;
  }, []);

  // ---- 그림 요청과 그리기 ----
  const limited = !session.fitsScale(scale);
  useLayoutEffect(() => {
    session.setScale(scale);
  }, [session, scale, view]);
  useEffect(() => {
    if (limited || !view) return;
    const wanted = new Set(visiblePages());
    if (caret) wanted.add(caret.page);
    session.requestPages([...wanted].sort((a, b) => a - b), scale);
  });

  useLayoutEffect(() => {
    for (const [page, canvas] of canvases.current) session.paint(page, canvas);
    // 쪽의 data-current는 그린 뒤의 화면 상태다(렌더 때 값은 그리기 전이라 쓰지 않음, 3차 안정화).
    for (const [page, box] of pageBoxes.current) box.setAttribute("data-current", String(session.isShown(page, scale)));
    // 입력 반영 시간: 보내는 중인 입력이 없고 보이는 쪽 그림이 모두 지금 판으로 화면에 옮겨졌을 때.
    const started = inputAt.current;
    if (started.length > 0 && !session.busy && visiblePages().every((page) => session.isShown(page, scale))) {
      inputAt.current = [];
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const now = performance.now();
        for (const at of started) session.recordLatency(now - at);
      }));
    }
  });

  // 표면이 사라지면(탭 전환·닫기) 화면 canvas와 세션의 화면 밖 래스터를 놓는다(다시 보이면 새로 받는다, T007과 같음).
  // layout effect 정리는 자식 canvas의 ref가 떨어지기 전에 돈다.
  useLayoutEffect(() => {
    const owned = canvases.current;
    return () => {
      for (const canvas of owned.values()) {
        try {
          canvas.width = 0;
          canvas.height = 0;
        } catch {
          // 놓기는 할 수 있는 만큼만: 세션의 래스터는 아래에서 모두 놓는다.
        }
      }
      session.releaseRendering();
    };
  }, [session]);

  useEffect(() => {
    const scroller = pagesRef.current?.closest(".editor__scroll");
    if (!scroller) return;
    const onViewChange = () => session.requestPages(visiblePages(), scale);
    scroller.addEventListener("scroll", onViewChange, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onViewChange);
    resize?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onViewChange);
      resize?.disconnect();
    };
  }, [session, scale, visiblePages]);

  // ---- 조합 글자 겹침의 너비(커서를 그 뒤에 둔다) ----
  useLayoutEffect(() => {
    const width = composition ? overlayRef.current?.getBoundingClientRect().width ?? 0 : 0;
    if (width !== overlayWidth) setOverlayWidth(width);
  }, [composition, overlayWidth, caret?.height, k]);

  // ---- 커서 위치로 textarea 옮기기·보이게 하기 ----
  useLayoutEffect(() => {
    const input = inputRef.current;
    const box = caret ? pageBoxes.current.get(caret.page) : undefined;
    if (!input) return;
    input.style.left = `${box && caret ? box.offsetLeft + caret.x * k + overlayWidth : 0}px`;
    input.style.top = `${box && caret ? box.offsetTop + caret.y * k : 0}px`;
    input.style.height = `${caret ? caret.height * k : 16}px`;
  });
  const caretElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    caretElement.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [caret?.page, caret?.x, caret?.y]);

  const focusInput = useCallback(() => inputRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (session.editable && !document.activeElement?.closest("[aria-modal='true']")) focusInput();
  }, [session, session.editable, focusInput]);

  // ---- 키보드·IME ----
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const controller = new ImeInput(session, context);
    ime.current = controller;
    const mark = (event: Event) => {
      inputAt.current.push(event.timeStamp);
    };
    const handleKey = (event: KeyboardEvent): boolean => {
      const extend = event.shiftKey;
      // WebKitGTK는 Shift+Tab(GDK ISO_Left_Tab)을 key "Unidentified", code "Tab"으로 보낸다(T007 실측).
      const key = event.key === "Unidentified" && event.code === "Tab" ? "Tab" : event.key;
      const move = (to: Parameters<DocxEditorSession["move"]>[0]) => {
        mark(event);
        session.move(to, extend);
        return true;
      };
      switch (key) {
        case "ArrowLeft": return move("left");
        case "ArrowRight": return move("right");
        case "ArrowUp": return move("up");
        case "ArrowDown": return move("down");
        case "Home": return move("lineStart");
        case "End": return move("lineEnd");
        case "Backspace": mark(event); session.backspace(); return true;
        case "Delete": mark(event); session.deleteForward(); return true;
        case "Enter": mark(event); session.enter(); return true;
        // 표 안에서는 셀 이동(WordCraft: 마지막 셀에서 행 추가). 표 밖의 Tab은 막지 않아 초점 이동(키보드 접근성)을 둔다.
        case "Tab":
          if (!session.view?.inTable) return false;
          mark(event);
          session.tab(extend);
          return true;
        default: return false;
      }
    };
    return attachTextInput(input, controller, {
      composing: () => session.composing,
      handleKey,
      mark,
      paragraphBreaks: true,
      detached: () => {
        ime.current = null;
      },
    });
  }, [session, context]);

  // ---- 마우스 ----
  const pointer = (event: React.MouseEvent<HTMLDivElement>, page: number, extend: boolean) => {
    const box = pageBoxes.current.get(page);
    if (!box) return;
    const rect = box.getBoundingClientRect();
    session.pointAt(page, (event.clientX - rect.left) / k, (event.clientY - rect.top) / k, extend);
  };
  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>, page: number) => {
    if (event.button !== 0 || !session.editable) return;
    event.preventDefault(); // 초점은 textarea에 둔다
    // 진행 중인 조합을 끝낸다(보이면 그 자리에 확정, 아니면 늦게 오는 확정을 클릭 전 자리에 넣도록 기억).
    ime.current?.pointerDown();
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

  const rectStyle = (rect: DocxRect): CSSProperties => ({
    left: rect.x * k, top: rect.y * k, width: rect.width * k, height: rect.height * k,
  });
  // 가장 작은 배율로도 그릴 수 없으면 배율을 낮추라고 안내하지 않는다.
  const minimum = limited && !session.fitsScale((ZOOM_STEPS[0] / 100) * CSS_PX_PER_PT * ratio);
  const editable = session.editable;
  const failedPages = limited ? [] : session.renderFailedPages;
  const notice = session.inputNotice;
  return (
    <div className="docx-surface rhwp-surface">
      <div className="docx-pages rhwp-pages" ref={pagesRef}>
        {limited && (
          <p className="editor__notice rhwp-render-limit" role="alert" data-testid="docx-render-limit" data-minimum={minimum}>
            {t(minimum ? "editor.docx.renderLimitMinimum" : "editor.docx.renderLimit", { zoom })}
          </p>
        )}
        {failedPages.length > 0 && (
          <div className="editor__notice rhwp-render-limit" role="alert" data-testid="docx-render-failed" data-pages={failedPages.join(",")}>
            <p>{t("editor.docx.renderFailed", { pages: failedPages.map((page) => page + 1).join(", ") })}</p>
            <button type="button" className="document-bar__button" data-testid="docx-render-retry" onClick={() => session.retryRendering()}>
              {t("editor.docx.renderRetry")}
            </button>
          </div>
        )}
        {notice && (
          <p className="editor__notice" role="status" data-testid="docx-input-notice" data-notice={notice}>
            {t(`editor.docx.${notice}`)}
          </p>
        )}
        {!limited && pages.map((size, page) => {
          return (
            <div
              key={page}
              className="docx-page rhwp-page"
              data-page={page}
              data-revision={session.pageRevision(page) ?? ""}
              data-render-failed={failedPages.includes(page) || undefined}
              ref={(element) => {
                if (element) pageBoxes.current.set(page, element);
                else pageBoxes.current.delete(page);
              }}
              style={{ width: size.width * k, height: size.height * k }}
              onMouseDown={(event) => onMouseDown(event, page)}
              onMouseMove={(event) => onMouseMove(event, page)}
            >
              <canvas
                className="rhwp-page__canvas"
                width={0}
                height={0}
                style={{ width: size.width * k, height: size.height * k }}
                ref={(element) => {
                  if (element) canvases.current.set(page, element);
                  else canvases.current.delete(page);
                }}
                aria-hidden="true"
              />
              {(view?.selection ?? []).filter((rect) => rect.page === page).map((rect, index) => (
                <div key={`s${index}`} className="rhwp-selection" style={rectStyle(rect)} />
              ))}
              {caret && caret.page === page && (
                // 조합 글자 겹침은 늘 두고 글자·보임만 바꾼다(조합 키마다 요소를 만들지 않음, T007 실측).
                <span
                  ref={overlayRef}
                  className="docx-composition"
                  data-testid="docx-composition"
                  style={{
                    left: caret.x * k, top: caret.y * k, height: caret.height * k,
                    fontSize: caret.height * k * 0.8, lineHeight: `${caret.height * k}px`,
                    visibility: composition ? "visible" : "hidden",
                  }}
                >
                  {composition}
                </span>
              )}
              {caret && caret.page === page && editable && (
                <div
                  ref={caretElement}
                  className="rhwp-caret"
                  data-testid="docx-caret"
                  style={{ left: caret.x * k + overlayWidth, top: caret.y * k, height: caret.height * k }}
                />
              )}
            </div>
          );
        })}
        <textarea
          ref={inputRef}
          className="rhwp-input"
          aria-label={t("editor.input")}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={!editable}
        />
      </div>
    </div>
  );
}
