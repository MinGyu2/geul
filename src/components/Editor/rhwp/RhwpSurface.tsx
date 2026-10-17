// rhwp 편집 표면(T007). 페이지마다 canvas에 rhwp가 그리고, 커서·선택·조합 밑줄은 그 위의 DOM 겹침으로 그린다.
//
// 좌표: rhwp 페이지 좌표는 배율 1의 CSS px다. 화면 배율 z = zoom/100에서 페이지 상자는 (너비·높이 × z) CSS px,
// canvas 비트맵은 × z × devicePixelRatio로 그려 고배율에서도 선명하다. 마우스 위치는 canvas의 화면 사각형을 기준으로
// ÷ z 해서 hitTest에 넘기고, 커서·선택 사각형은 × z로 그린다. 그리기와 hit test가 같은 변환 하나만 쓴다
// (스크롤·페이지 사이 간격은 canvas 사각형에 이미 반영됨).
//
// 입력: 화면에 보이지 않는 textarea 하나가 키보드·IME를 받는다. 커서 위치로 옮겨 두어 IME 후보 창이 커서 옆에 뜬다.
// React가 다시 그려도 같은 요소를 쓰므로 조합 상태·초점이 사라지지 않는다. 이벤트는 네이티브 리스너로 받는다.
// - 조합: compositionstart → 조합 중 input마다 문서의 조합 범위를 textarea 값으로 바꿈 → compositionend에 최종값으로
//   한 번 확정. 조합 직후 같은 글자로 오는 입력 이벤트(WebKit)는 무시한다(중복 삽입 방지).
//   실측(WebKitGTK 2.54 + ibus-hangul, X11): 음절마다 compositionstart·compositionupdate 없이 input(isComposing=true)과
//   compositionend만 온다. 그래서 시작 이벤트 없이 조합 중 입력이나 조합 끝이 오면 그 자리에서 조합을 시작한다.
// - 조합 중 방향키 등은 조합이 끝난 뒤 처리하고, 조합 중 클릭은 지금 보이는 조합 글자를 확정한 뒤 이동한다.
// 응답 시간: 입력 이벤트 시각부터 바뀐 페이지를 다시 그린 뒤 두 번째 animation frame까지를 잰다(화면 반영의 상한).
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, type CSSProperties } from "react";
import { useTranslation } from "../../../language/LanguageContext";
import type { RhwpEditorSession } from "./RhwpEditorSession";
import type { PageRect } from "./rhwpText";

interface RhwpSurfaceProps {
  session: RhwpEditorSession;
  zoom: number;
}

const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter", "Tab", "Escape"]);

function useSessionUpdates(session: RhwpEditorSession) {
  const [, update] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => session.subscribe(update), [session]);
}

export function RhwpSurface({ session, zoom }: RhwpSurfaceProps) {
  const { t } = useTranslation();
  useSessionUpdates(session);
  const scale = zoom / 100;
  const pagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const pageBoxes = useRef(new Map<number, HTMLDivElement>());
  const inputAt = useRef<number | null>(null);
  const lastComposed = useRef("");
  const pendingNavigation = useRef<KeyboardEvent | null>(null);
  const dragging = useRef(false);
  const rendered = useRef({ version: -1, scale: 0, pages: 0 });

  const caret = session.caretRect();
  const selection = session.selectionRects();
  const composition = session.compositionRects();

  // ---- 그리기 ----
  useLayoutEffect(() => {
    const ratio = window.devicePixelRatio || 1;
    const last = rendered.current;
    const all = last.scale !== scale || last.pages !== session.pages.length;
    if (!all && last.version === session.modelVersion) {
      inputAt.current = null; // 문서를 바꾸지 않은 입력(이동·처음에서 Backspace)은 측정하지 않는다
      return;
    }
    rendered.current = { version: session.modelVersion, scale, pages: session.pages.length };
    // 커서가 있는 페이지를 먼저 그려 입력이 바로 보이게 하고, 나머지는 다음 frame에 그린다(조판이 뒤 페이지를 바꿀 수 있음).
    const first = caret?.page ?? 0;
    const draw = (page: number) => {
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
    const frame = requestAnimationFrame(() => rest.forEach(draw));
    return () => cancelAnimationFrame(frame);
  });

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
    if (session.editable) focusInput();
  }, [session, session.editable, focusInput]);

  // ---- 키보드·IME ----
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
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
      if (event.ctrlKey || event.metaKey || event.altKey) return; // 단축키는 명령 레지스트리(T010) 몫
      if (event.isComposing || event.keyCode === 229) {
        if (NAVIGATION_KEYS.has(event.code) || NAVIGATION_KEYS.has(event.key)) pendingNavigation.current = event;
        return;
      }
      if (handleKey(event)) event.preventDefault();
    };
    const onCompositionStart = (event: CompositionEvent) => {
      mark(event);
      lastComposed.current = "";
      session.beginComposition();
    };
    const onInput = (event: Event) => {
      mark(event);
      if (session.composing || (event as InputEvent).isComposing) {
        if (!session.composing) session.beginComposition(); // compositionstart 없이 온 조합
        session.updateComposition(input.value);
        return;
      }
      const text = input.value;
      input.value = "";
      if (!text) return;
      if (lastComposed.current && text === lastComposed.current) {
        lastComposed.current = ""; // 조합이 끝난 직후 같은 글자로 다시 온 입력(중복 삽입 방지)
        return;
      }
      lastComposed.current = "";
      session.typeText(text);
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      mark(event);
      const finalText = input.value || event.data || "";
      if (!session.composing && finalText) session.beginComposition(); // 시작 이벤트 없이 확정만 온 조합
      lastComposed.current = session.endComposition(finalText);
      input.value = "";
      const pending = pendingNavigation.current;
      pendingNavigation.current = null;
      if (pending) handleKey(pending);
    };
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("input", onInput);
    input.addEventListener("compositionend", onCompositionEnd);
    return () => {
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("input", onInput);
      input.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [session]);

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
    if (session.composing && input) {
      // 지금 보이는 조합 글자를 확정하고, IME가 늦게 보내는 확정 입력은 같은 글자라 무시된다.
      lastComposed.current = session.endComposition(input.value);
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

  return (
    <div className="rhwp-surface">
      <div className="rhwp-pages" ref={pagesRef}>
        {session.pages.map((size, page) => (
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
