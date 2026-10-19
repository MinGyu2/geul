// DOCX 편집 세션·표면 테스트용 가짜 백엔드(테스트에서만 가져다 쓴다). 백엔드(Rust adapters::wordcraft)의 계약을 흉내 낸다:
// 시도 번호·ready·기준 revision 확인, 실제로 바뀐 연산만 revision, 거부한 연산은 없던 일, Mark/InsertAt, ReplaceInserted,
// Pointer.beforeInsert, 요청 검사(validate: 글자 길이·제어 문자, 위반이면 요청 전체 InvalidRequest), PasteText의 문단 나누기·
// chain(앞 연산이 거부되면 건너뜀), DeleteSelection. 글자 하나 = 가로 10pt, 문단 하나 = 세로 20pt, 본문 왼쪽 위 (72, 72).
// 실제 엔진 동작은 Rust 시험과 tests/integration/wordcraft/에서 확인한다.
import type { DocumentBackend } from "../../../adapters/backend";
import type { DocumentError, Result, SessionInfo } from "../../../adapters/contract";
import type { DocxBackend, DocxEdited, DocxOp, DocxRender, DocxRoundTrip, DocxState, DocxView } from "../../../adapters/docx";
import { vi } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import { DocxEditorSession } from "./DocxEditorSession";

export const MARGIN = 72;
export const CHAR = 10;
export const LINE = 20;

type At = { p: number; o: number };
const chars = (text: string) => [...text];
/** 백엔드 MAX_TEXT_CHARS·MAX_OPS(engine.rs). */
const MAX_TEXT = 4096;
const MAX_OPS = 256;
/** 백엔드 valid_text(engine.rs): 비어 있지 않고 4096자 이하, 제어 문자(Cc)·U+FFFC 없음. PasteText는 \n·\t만 허용. */
const validText = (text: string, allowed = "") =>
  text !== "" && chars(text).length <= MAX_TEXT && !chars(text).some((c) => (/\p{Cc}/u.test(c) && !allowed.includes(c)) || c === "\uFFFC");
export function validOps(ops: DocxOp[]): boolean {
  return ops.length > 0 && ops.length <= MAX_OPS && ops.every((op) => {
    switch (op.op) {
      case "insertText": case "insertAt": return validText(op.text);
      case "pasteText": return validText(op.text, "\n\t");
      case "replaceInserted": return validText(op.expected) && validText(op.text);
      default: return true;
    }
  });
}
const cmp = (a: At, b: At) => (a.p - b.p) || (a.o - b.o);

export const docxInfo = (patch: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 1, format: "docx", engine: "wordcraft", revision: 0, state: "identified", displayName: "a.docx",
  dirty: false, sequence: 0, loadGeneration: 0, ...patch,
});

export class FakeDocx implements DocxBackend {
  paragraphs: string[];
  caret: At = { p: 0, o: 0 };
  anchor: At = { p: 0, o: 0 };
  info: SessionInfo = docxInfo();
  calls: { method: string; args: unknown[] }[] = [];
  /** 다음 edit을 이 오류로 거부한다. */
  failNext: DocumentError | null = null;
  /** true면 edit 응답을 release()까지 붙잡는다. */
  hold = false;
  /** 엔진이 거부하는 글자 넣기(InsertText·PasteText)의 글자(보호된 문서 등 흉내). */
  refuseText: ((text: string) => boolean) | null = null;
  /** 쪽 수(쪽마다 612×792pt, 커서·선택은 0쪽). */
  pageCount = 1;
  /** 그림 요청이 이 오류로 실패한다(그대로 둠, null이면 정상). */
  renderError: DocumentError | null = null;
  /** 그림 응답의 PNG를 이 바이트로 바꾼다(디코드 실패 흉내). */
  renderPng: Uint8Array | null = null;
  private held: (() => void)[] = [];
  private readonly original: string[];
  private cleanRevision = 0;
  private marks = new Map<number, At>();
  private engineRev = 0;
  private last: { at: At; text: string; rev: number; before: string[] } | null = null;

  constructor(text: string[] = ["가나다", "abc"]) {
    this.paragraphs = [...text];
    this.original = [...text];
  }

  release() {
    const held = this.held;
    this.held = [];
    for (const go of held) go();
  }

  private update(patch: Partial<SessionInfo>) {
    this.info = { ...this.info, ...patch, sequence: this.info.sequence + 1 };
    this.info.dirty = this.info.revision !== this.cleanRevision;
  }

  /** 지금 모델의 보기(백엔드 DocxView와 같은 모양). 키의 오프셋은 이 가짜에서는 문자 단위다. */
  snapshot(): DocxView {
    const at = (pos: At) => `body:${pos.p}:${pos.o}`;
    const collapsed = cmp(this.caret, this.anchor) === 0;
    const [from, to] = cmp(this.anchor, this.caret) <= 0 ? [this.anchor, this.caret] : [this.caret, this.anchor];
    const selection = collapsed ? [] : this.paragraphs.flatMap((text, p) => {
      if (p < from.p || p > to.p) return [];
      const start = p === from.p ? from.o : 0;
      const end = p === to.p ? to.o : chars(text).length;
      return [{ page: 0, x: MARGIN + start * CHAR, y: MARGIN + p * LINE, width: (end - start) * CHAR, height: 16 }];
    });
    return {
      pages: Array.from({ length: this.pageCount }, () => ({ width: 612, height: 792 })),
      caret: { page: 0, x: MARGIN + this.caret.o * CHAR, y: MARGIN + this.caret.p * LINE, height: 16 },
      selection, collapsed, inTable: false,
      caretKey: at(this.caret), anchorKey: at(this.anchor),
      paragraphText: this.paragraphs[this.caret.p]!, caretOffset: this.caret.o,
    };
  }

  private state(): DocxState {
    return { session: { ...this.info }, view: this.snapshot() };
  }

  private async respond<T>(value: () => Result<T>): Promise<Result<T>> {
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
    return value();
  }

  load(sessionId: number, reloadGeneration?: number): Promise<Result<DocxState>> {
    this.calls.push({ method: "load", args: [sessionId, reloadGeneration] });
    return this.respond(() => {
      if (reloadGeneration !== undefined) {
        if (this.info.state === "ready" && this.info.loadGeneration !== reloadGeneration) {
          return { ok: false, error: { code: "StaleLoad", sessionId, loadGeneration: this.info.loadGeneration } };
        }
        if (this.info.state === "ready") this.update({ state: "failed" });
      }
      if (this.info.state !== "identified" && this.info.state !== "failed") {
        return { ok: false, error: { code: "InvalidState", sessionId, state: this.info.state } };
      }
      this.paragraphs = [...this.original];
      this.caret = { p: 0, o: 0 };
      this.anchor = { p: 0, o: 0 };
      this.cleanRevision = this.info.revision;
      this.update({ state: "ready", loadGeneration: this.info.loadGeneration + 1 });
      return { ok: true, value: this.state() };
    });
  }

  private check(sessionId: number, generation: number): Result<DocxState> {
    if (generation !== this.info.loadGeneration) return { ok: false, error: { code: "StaleLoad", sessionId, loadGeneration: this.info.loadGeneration } };
    if (this.info.state !== "ready") return { ok: false, error: { code: "InvalidState", sessionId, state: this.info.state } };
    return { ok: true, value: this.state() };
  }

  view(sessionId: number, generation: number): Promise<Result<DocxState>> {
    this.calls.push({ method: "view", args: [sessionId, generation] });
    return Promise.resolve(this.check(sessionId, generation));
  }

  edit(sessionId: number, generation: number, baseRevision: number, ops: DocxOp[]): Promise<Result<DocxEdited>> {
    this.calls.push({ method: "edit", args: [sessionId, generation, baseRevision, ops] });
    return this.respond(() => {
      const checked = this.check(sessionId, generation);
      if (!checked.ok) return checked;
      if (this.failNext) {
        const error = this.failNext;
        this.failNext = null;
        if (error.code === "EngineFailure") this.update({ state: "failed" });
        return { ok: false, error };
      }
      if (baseRevision !== this.info.revision) return { ok: false, error: { code: "RevisionMismatch", sessionId, revision: this.info.revision } };
      if (!validOps(ops)) return { ok: false, error: { code: "InvalidRequest" } };
      const rejected: number[] = [];
      let changed = 0;
      ops.forEach((op, index) => {
        const before = JSON.stringify(this.paragraphs);
        const skipped = op.op === "pasteText" && op.chain && rejected.at(-1) === index - 1 && index > 0;
        if (skipped || !this.apply(op)) rejected.push(index);
        else if (JSON.stringify(this.paragraphs) !== before) {
          changed += 1;
          this.engineRev += 1;
        } else if (["backspace", "deleteForward", "newParagraph", "tab", "insertText"].includes(op.op)) this.engineRev += 1;
      });
      if (changed > 0) this.update({ revision: this.info.revision + changed });
      return { ok: true, value: { ...this.state(), applied: ops.length - rejected.length, rejected } };
    });
  }

  private deleteSelection(): boolean {
    if (cmp(this.caret, this.anchor) === 0) return false;
    const [from, to] = cmp(this.anchor, this.caret) <= 0 ? [this.anchor, this.caret] : [this.caret, this.anchor];
    const head = chars(this.paragraphs[from.p]!).slice(0, from.o).join("");
    const tail = chars(this.paragraphs[to.p]!).slice(to.o).join("");
    this.paragraphs.splice(from.p, to.p - from.p + 1, head + tail);
    this.caret = { ...from };
    this.anchor = { ...from };
    return true;
  }

  private insert(at: At, text: string) {
    const list = chars(this.paragraphs[at.p]!);
    list.splice(at.o, 0, text);
    this.paragraphs[at.p] = list.join("");
  }

  private moveTo(at: At, extend: boolean) {
    this.caret = at;
    if (!extend) this.anchor = { ...at };
  }

  private apply(op: DocxOp): boolean {
    const len = (p: number) => chars(this.paragraphs[p]!).length;
    switch (op.op) {
      case "insertText": {
        if (this.refuseText?.(op.text)) return false;
        const before = [...this.paragraphs];
        this.deleteSelection();
        const at = { ...this.caret };
        this.insert(at, op.text);
        this.moveTo({ p: at.p, o: at.o + chars(op.text).length }, false);
        this.last = { at, text: op.text, rev: this.engineRev + 1, before };
        return true;
      }
      case "pasteText": {
        if (this.refuseText?.(op.text)) return false;
        this.deleteSelection();
        op.text.split("\n").forEach((line, index) => {
          if (index > 0) {
            const list = chars(this.paragraphs[this.caret.p]!);
            this.paragraphs.splice(this.caret.p, 1, list.slice(0, this.caret.o).join(""), list.slice(this.caret.o).join(""));
            this.moveTo({ p: this.caret.p + 1, o: 0 }, false);
          }
          this.insert(this.caret, line);
          this.moveTo({ p: this.caret.p, o: this.caret.o + chars(line).length }, false);
        });
        this.last = null;
        return true;
      }
      case "deleteSelection":
        this.deleteSelection();
        return true;
      case "backspace":
        if (this.deleteSelection()) return true;
        if (this.caret.o > 0) {
          const list = chars(this.paragraphs[this.caret.p]!);
          list.splice(this.caret.o - 1, 1);
          this.paragraphs[this.caret.p] = list.join("");
          this.moveTo({ p: this.caret.p, o: this.caret.o - 1 }, false);
        } else if (this.caret.p > 0) {
          const p = this.caret.p - 1;
          const o = len(p);
          this.paragraphs.splice(p, 2, this.paragraphs[p]! + this.paragraphs[p + 1]!);
          this.moveTo({ p, o }, false);
        }
        return true;
      case "deleteForward":
        if (this.deleteSelection()) return true;
        if (this.caret.o < len(this.caret.p)) {
          const list = chars(this.paragraphs[this.caret.p]!);
          list.splice(this.caret.o, 1);
          this.paragraphs[this.caret.p] = list.join("");
        }
        return true;
      case "newParagraph": {
        this.deleteSelection();
        const list = chars(this.paragraphs[this.caret.p]!);
        this.paragraphs.splice(this.caret.p, 1, list.slice(0, this.caret.o).join(""), list.slice(this.caret.o).join(""));
        this.moveTo({ p: this.caret.p + 1, o: 0 }, false);
        return true;
      }
      case "tab":
        return true;
      case "move": {
        const { p, o } = this.caret;
        const target: At =
          op.to === "left" ? (o > 0 ? { p, o: o - 1 } : p > 0 ? { p: p - 1, o: len(p - 1) } : { p, o })
          : op.to === "right" ? (o < len(p) ? { p, o: o + 1 } : p + 1 < this.paragraphs.length ? { p: p + 1, o: 0 } : { p, o })
          : op.to === "up" ? { p: Math.max(0, p - 1), o: Math.min(o, len(Math.max(0, p - 1))) }
          : op.to === "down" ? { p: Math.min(this.paragraphs.length - 1, p + 1), o: Math.min(o, len(Math.min(this.paragraphs.length - 1, p + 1))) }
          : op.to === "lineStart" ? { p, o: 0 }
          : op.to === "lineEnd" ? { p, o: len(p) }
          : op.to === "docStart" ? { p: 0, o: 0 }
          : { p: this.paragraphs.length - 1, o: len(this.paragraphs.length - 1) };
        this.moveTo(target, op.extend);
        return true;
      }
      case "pointer": {
        if (op.page !== 0) return false;
        const last = this.last;
        const layout = op.beforeInsert && last && last.rev === this.engineRev ? last.before : this.paragraphs;
        const p = Math.min(layout.length - 1, Math.max(0, Math.floor((op.y - MARGIN) / LINE)));
        let o = Math.min(chars(layout[p]!).length, Math.max(0, Math.round((op.x - MARGIN) / CHAR)));
        if (layout !== this.paragraphs && last && p === last.at.p && o >= last.at.o) o += chars(last.text).length;
        this.moveTo({ p, o }, op.extend);
        return true;
      }
      case "selectAll":
        this.anchor = { p: 0, o: 0 };
        this.caret = { p: this.paragraphs.length - 1, o: len(this.paragraphs.length - 1) };
        return true;
      case "mark":
        this.marks.set(op.id, { ...this.caret });
        return true;
      case "insertAt": {
        const at = this.marks.get(op.mark);
        if (!at) return false;
        this.marks.delete(op.mark);
        this.insert(at, op.text);
        const n = chars(op.text).length;
        const shift = (pos: At): At => (pos.p === at.p && pos.o >= at.o ? { p: pos.p, o: pos.o + n } : pos);
        this.caret = shift(this.caret);
        this.anchor = shift(this.anchor);
        return true;
      }
      case "replaceInserted": {
        const last = this.last;
        if (!last || last.rev !== this.engineRev || last.text !== op.expected) return false;
        const list = chars(this.paragraphs[last.at.p]!);
        if (list.slice(last.at.o, last.at.o + chars(op.expected).length).join("") !== op.expected) return false;
        list.splice(last.at.o, chars(op.expected).length, op.text);
        this.paragraphs[last.at.p] = list.join("");
        this.last = null;
        return true;
      }
    }
  }

  /** 쪽·배율마다 마지막으로 보낸 판(백엔드의 래스터 기억과 같음). */
  private rendered = new Map<string, number>();

  render(sessionId: number, generation: number, revision: number, page: number, scale: number, base?: number): Promise<Result<DocxRender>> {
    this.calls.push({ method: "render", args: [sessionId, generation, revision, page, scale, base] });
    const checked = this.check(sessionId, generation);
    if (!checked.ok) return Promise.resolve(checked);
    if (revision !== this.info.revision) return Promise.resolve({ ok: false, error: { code: "RevisionMismatch", sessionId, revision: this.info.revision } });
    if (this.renderError) return Promise.resolve({ ok: false, error: this.renderError });
    if (page >= this.pageCount) return Promise.resolve({ ok: false, error: { code: "InvalidRequest" } });
    const key = `${page}:${scale}`;
    const known = this.rendered.get(key);
    this.rendered.set(key, revision);
    // 기준 판을 기억하면 바뀐 띠(커서 문단 줄)만, 같은 판이면 빈 띠, 아니면 쪽 전체.
    if (base !== undefined && base === known) {
      const band = revision === base ? { y: 0, height: 0, png: new Uint8Array() } : { y: 100 + this.caret.p * 20, height: 20, png: this.renderPng ?? new Uint8Array([revision, page, 1]) };
      return Promise.resolve({ ok: true, value: { revision, base, ...band } });
    }
    return Promise.resolve({ ok: true, value: { revision, base: null, y: 0, height: 1056, png: this.renderPng ?? new Uint8Array([revision, page]) } });
  }

  roundTrip(sessionId: number, generation: number, revision: number): Promise<Result<DocxRoundTrip>> {
    this.calls.push({ method: "roundTrip", args: [sessionId, generation, revision] });
    const checked = this.check(sessionId, generation);
    if (!checked.ok) return Promise.resolve(checked);
    return Promise.resolve({ ok: true, value: { sessionId, revision, bytes: 100, pages: 1, reopenedPages: 1, pagesEqual: true, textEqual: true, modelEqual: true, passed: true } });
  }
}

/** 세션 투영용 가짜 문서 백엔드: 열기·조회·닫기만, 상태는 FakeDocx가 가진다. */
export function docxSessions(fake: FakeDocx): DocumentSessions {
  const ok = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });
  const backend = {
    open: () => ok({ ...fake.info }),
    session: () => ok({ ...fake.info }),
    sessions: () => ok([{ ...fake.info }]),
    close: (sessionId: number) => ok({ sessionId, alreadyClosed: false }),
    load: () => Promise.resolve({ ok: false, error: { code: "InvalidRequest" } }),
    setState: () => Promise.resolve({ ok: false, error: { code: "InvalidRequest" } }),
    commit: () => Promise.resolve({ ok: false, error: { code: "InvalidRequest" } }),
  } as unknown as DocumentBackend;
  return new DocumentSessions(backend);
}

export const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 가짜 그림: 크기만 있는 ImageBitmap 대신(jsdom에는 없음). 띠(바이트 3개)는 높이 20. 빈 바이트·0xff로 시작하면 디코드 실패. */
export const decodeFake = (png: Uint8Array) =>
  png.length === 0 || png[0] === 0xff
    ? Promise.reject(new Error("decode"))
    : Promise.resolve({ width: 816, height: png.length === 3 ? 20 : 1056, close() {}, bytes: [...png] } as unknown as ImageBitmap);

/** drawImage 호출을 기록하는 가짜 canvas(jsdom에는 2D 문맥이 없음). */
export function recordingCanvas() {
  const draws: unknown[][] = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args: unknown[]) => draws.push(args) }) };
  return { canvas: canvas as unknown as HTMLCanvasElement, draws };
}

/**
 * 표면 시험의 화면 canvas 2D 문맥(jsdom canvas에는 문맥이 없어 화면 그리기 실패로 센다, T008 2차 안정화). 그린 것을 돌려준다.
 * vi.spyOn이므로 시험이 끝나면 되돌린다(restoreMocks).
 */
export function stubScreenContext() {
  const draws: { canvas: HTMLCanvasElement; args: unknown[] }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return { drawImage: (...args: unknown[]) => void draws.push({ canvas: this, args }) } as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement["getContext"]);
  return draws;
}

/** 열고 불러온 DOCX 편집 세션. 화면 밖 래스터는 2D 문맥이 있는 가짜 canvas다(jsdom canvas에는 문맥이 없어 그림 실패로 센다). */
export async function readyDocx(text?: string[]) {
  const fake = new FakeDocx(text);
  const sessions = docxSessions(fake);
  await sessions.open("/a.docx");
  const editor = new DocxEditorSession(1, fake, sessions, decodeFake, () => recordingCanvas().canvas);
  const result = await editor.load();
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return { fake, sessions, editor };
}
