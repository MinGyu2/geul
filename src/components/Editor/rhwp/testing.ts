// 편집 세션·표면 테스트용 가짜 rhwp 문서와 응답을 손으로 주는 백엔드(테스트에서만 가져다 쓴다).
import type { DocumentBackend, LoadedBytes } from "../../../adapters/backend";
import type { DocumentError, Result, SessionInfo } from "../../../adapters/contract";
import { DocumentSessions } from "../../../adapters/sessions";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";

export const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** ZIP 지역 머리 서명(HWPX 컨테이너). */
export const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

// 본문 문단만 있는 가짜 rhwp 문서(글자 하나 = 가로 10px). 실제 엔진 동작은 tests/integration/rhwp/에서 확인한다.
export class FakeDocument {
  paragraphs: string[];
  freed = false;
  failNext = false;
  /** 열었다고 알리는 원본 형식(`getSourceFormat`). */
  format: "hwp" | "hwpx" = "hwp";
  constructor(text: string[]) {
    this.paragraphs = [...text];
  }
  private guard() {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("engine");
    }
  }
  free() { this.freed = true; }
  // 스냅숏(고정 rhwp save/restore/discard_snapshot_native 흉내): 상한 100, 넘치면 가장 오래된 것을 알림 없이 지움, 없는 ID는
  // "스냅샷 N 없음". failNext와 따로 실패를 주입한다(편집 실패 시험이 스냅숏 호출에 먹히지 않게).
  snapshots: [number, string[]][] = [];
  private nextSnapshot = 0;
  failSnapshot = false;
  failRestore = false;
  snapshotCapacity() { return 100; }
  saveSnapshot() {
    if (this.failSnapshot) {
      this.failSnapshot = false;
      throw new Error("RuntimeError: unreachable");
    }
    this.snapshots.push([this.nextSnapshot, [...this.paragraphs]]);
    while (this.snapshots.length > this.snapshotCapacity()) this.snapshots.shift();
    return this.nextSnapshot++;
  }
  restoreSnapshot(id: number) {
    if (this.failRestore) {
      this.failRestore = false;
      throw new Error("RuntimeError: unreachable");
    }
    const hit = this.snapshots.find(([sid]) => sid === id);
    if (!hit) throw new Error(`렌더링 오류: 스냅샷 ${id} 없음`);
    this.paragraphs = [...hit[1]];
    return '{"ok":true}';
  }
  discardSnapshot(id: number) {
    this.snapshots = this.snapshots.filter(([sid]) => sid !== id);
  }
  pageCount() { return 1; }
  getPageInfo(page: number) { return JSON.stringify({ pageIndex: page, sectionIndex: 0, width: 800, height: 1000 }); }
  getSourceFormat(): string { return this.format; }
  renderPageToCanvas() {}
  hitTest(_page: number, x: number, y: number) {
    const paragraph = Math.min(this.paragraphs.length - 1, Math.max(0, Math.floor(y / 20)));
    const offset = Math.min([...this.paragraphs[paragraph]!].length, Math.max(0, Math.round(x / 10)));
    return JSON.stringify({ sectionIndex: 0, paragraphIndex: paragraph, charOffset: offset });
  }
  getCursorRect(_s: number, paragraph: number, offset: number) {
    return JSON.stringify({ pageIndex: 0, x: offset * 10, y: paragraph * 20, height: 16 });
  }
  getParagraphCount() { return this.paragraphs.length; }
  getParagraphLength(_s: number, paragraph: number) { return [...this.paragraphs[paragraph]!].length; }
  getLineInfo(_s: number, paragraph: number) {
    return JSON.stringify({ lineIndex: 0, lineCount: 1, charStart: 0, charEnd: this.getParagraphLength(0, paragraph) });
  }
  moveVertical(_s: number, paragraph: number, offset: number, delta: number) {
    const target = Math.min(this.paragraphs.length - 1, Math.max(0, paragraph + delta));
    const clamped = Math.min(offset, this.getParagraphLength(0, target));
    return JSON.stringify({ sectionIndex: 0, paragraphIndex: target, charOffset: clamped, preferredX: offset * 10 });
  }
  getSelectionRects(_s: number, sp: number, so: number, ep: number, eo: number) {
    return JSON.stringify([{ pageIndex: 0, x: so * 10, y: sp * 20, width: Math.max(0, (eo - so) * 10), height: ep === sp ? 16 : 36 }]);
  }
  getTextRange(_s: number, paragraph: number, offset: number, count: number) {
    return [...this.paragraphs[paragraph]!].slice(offset, offset + count).join("");
  }
  insertText(_s: number, paragraph: number, offset: number, text: string) {
    this.guard();
    const chars = [...this.paragraphs[paragraph]!];
    chars.splice(offset, 0, text);
    this.paragraphs[paragraph] = chars.join("");
    return "{}";
  }
  deleteText(_s: number, paragraph: number, offset: number, count: number) {
    this.guard();
    const chars = [...this.paragraphs[paragraph]!];
    chars.splice(offset, count);
    this.paragraphs[paragraph] = chars.join("");
    return "{}";
  }
  deleteRange(_s: number, sp: number, so: number, ep: number, eo: number) {
    this.guard();
    const head = [...this.paragraphs[sp]!].slice(0, so).join("");
    const tail = [...this.paragraphs[ep]!].slice(eo).join("");
    this.paragraphs.splice(sp, ep - sp + 1, head + tail);
    return "{}";
  }
  splitParagraph(_s: number, paragraph: number, offset: number) {
    this.guard();
    const chars = [...this.paragraphs[paragraph]!];
    this.paragraphs.splice(paragraph, 1, chars.slice(0, offset).join(""), chars.slice(offset).join(""));
    return "{}";
  }
  mergeParagraph(_s: number, paragraph: number) {
    this.guard();
    this.paragraphs.splice(paragraph - 1, 2, this.paragraphs[paragraph - 1]! + this.paragraphs[paragraph]!);
    return "{}";
  }
  getTextFileText() { return this.paragraphs.join("\r\n"); }
  getControls() { return "[]"; }
  /** HWP 5 컨테이너(CFB) 서명 + 본문(다시 열면 같은 가짜 문서가 "hwp"로 열린다). */
  exportHwpWithReport() {
    const text = new TextEncoder().encode(this.paragraphs.join("\n"));
    const bytes = new Uint8Array([...CFB_SIGNATURE, ...text]);
    return { contentLoss: () => JSON.stringify({ count: 0, losses: [] }), takeBytes: () => bytes, free() {} };
  }
  /** HWPX 컨테이너(ZIP) 서명 + 본문. */
  exportHwpxWithReport() {
    const text = new TextEncoder().encode(this.paragraphs.join("\n"));
    const bytes = new Uint8Array([...ZIP_SIGNATURE, ...text]);
    return { contentLoss: () => JSON.stringify({ count: 0, losses: [] }), takeBytes: () => bytes, free() {} };
  }
}

export type Call = { method: string; args: unknown[]; reply: (value: Result<unknown>) => void };

export function controlledBackend() {
  const calls: Call[] = [];
  const queue = (method: string) => (...args: unknown[]) => new Promise<Result<unknown>>((reply) => calls.push({ method, args, reply }));
  const backend = {
    open: queue("open"), close: queue("close"), session: queue("session"), sessions: queue("sessions"),
    load: queue("load"), setState: queue("setState"), commit: queue("commit"),
    original: queue("original"), preflight: queue("preflight"), save: queue("save"),
  } as unknown as DocumentBackend;
  const take = (method: string) => {
    const at = calls.findIndex((call) => call.method === method);
    if (at < 0) throw new Error(`no ${method} call: ${calls.map((call) => call.method).join(",")}`);
    return calls.splice(at, 1)[0]!;
  };
  return { backend, calls, take };
}

export const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: DocumentError): Result<never> => ({ ok: false, error });
export const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

export const base: SessionInfo = { sessionId: 1, format: "hwp", engine: "rhwp", revision: 0, state: "identified", displayName: "a.hwp", dirty: false, sequence: 0, loadGeneration: 0 };
export const info = (patch: Partial<SessionInfo>): SessionInfo => ({ ...base, ...patch });
/** document_load 응답(불러오기 시도 번호 + 문서 바이트). */
export const loaded = (bytes: Uint8Array = new Uint8Array([1]), generation = 1): Result<LoadedBytes> => ok({ generation, bytes });

/** 열고 불러온 세션. 백엔드 응답은 테스트가 직접 준다. */
export async function readySession(text = ["가나다", "abc"]) {
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const doc = new FakeDocument(text);
  const module: RhwpModule = { openDocument: () => doc as unknown as RhwpDocument };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
  const loading = editor.load();
  take("load").reply(loaded());
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  return { editor, doc, sessions, calls, take };
}
