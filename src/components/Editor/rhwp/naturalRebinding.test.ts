// Stage 5-A: natural-font binding requested during an unsettled IME transaction is deferred (never committed while
// composing) and resumed once, event-driven, after the transaction fully settles — for the current document only.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NaturalBinding, NaturalFontDocument, NaturalFontService } from "../../../fonts/naturalFonts";
import { flush, readySession } from "./testing";

/** Controlled binder: records each bind, applies the commit gate like NaturalFontService (current() before commit). */
function fakeBinder() {
  const state = { catalog: 1, partial: false, starts: [] as number[], commits: [] as { catalog: number; doc: unknown }[] };
  const binder = {
    ready: () => true,
    bind: async (doc: NaturalFontDocument, current: () => boolean): Promise<NaturalBinding> => {
      const catalog = state.catalog;
      state.starts.push(catalog);
      await Promise.resolve(); // fetch/load happen asynchronously in the real binder
      const base = { generation: null, bound: [], unbound: [], fallbacks: [], omitted: [], engineTruncated: false, faceLimited: false, complete: true };
      if (!current()) return { ...base, status: "stale" };
      state.commits.push({ catalog, doc });
      if (state.partial) return { ...base, status: "bound", generation: catalog, omitted: ["Over Limit"], complete: false };
      return { ...base, status: "bound", generation: catalog };
    },
  } as unknown as NaturalFontService;
  return { binder, state };
}

async function session() {
  const { binder, state } = fakeBinder();
  const ready = await readySession(["가나다", "abc"], { history: true, natural: binder });
  await flush();
  state.starts.length = 0; state.commits.length = 0; // the load-time binding
  return { ...ready, state };
}

afterEach(() => { vi.useRealTimers(); });

describe("natural font rebinding across IME settlement", () => {
  it("A1/A2/A6: a catalog change during a long composition commits nothing until settlement, then binds once", async () => {
    const { editor, doc, state } = await session();
    vi.useFakeTimers();
    editor.beginComposition();
    editor.updateComposition("한");
    const revision = editor.localRevision, model = editor.modelVersion, layout = editor.layoutVersion;
    state.catalog = 2;
    editor.fontsChanged();
    // Far beyond the old 20 x 250 ms retry window.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.commits).toEqual([]);
    expect(editor.layoutVersion).toBe(layout + 1); // fontsChanged repaint only, no binding relayout
    vi.useRealTimers();
    editor.endComposition("한");
    await flush();
    expect(state.commits).toEqual([{ catalog: 2, doc }]);
    expect(editor.naturalFontStatus?.status).toBe("bound");
    // Binding re-lays out and repaints without touching the document revision or model version.
    expect(editor.layoutVersion).toBe(layout + 2);
    expect(editor.localRevision).toBe(revision + 1); // the composition itself is the one change
    expect(editor.modelVersion).toBeGreaterThanOrEqual(model);
    const afterSettle = editor.modelVersion;
    await flush();
    expect(editor.modelVersion).toBe(afterSettle);
    expect(state.commits).toHaveLength(1);
  });

  it("A3: two catalog changes in one composition coalesce into one binding with the newest catalog", async () => {
    const { editor, state } = await session();
    editor.beginComposition();
    editor.updateComposition("가");
    state.catalog = 2; editor.fontsChanged();
    state.catalog = 3; editor.fontsChanged();
    await flush();
    expect(state.commits).toEqual([]);
    editor.endComposition("가");
    await flush();
    expect(state.commits.map((c) => c.catalog)).toEqual([3]);
    expect(state.starts).toEqual([3]);
  });

  it("A3: an in-flight binding superseded by a deferred request is never committed", async () => {
    const { editor, state } = await session();
    editor.fontsChanged(); // starts binding with catalog 1 (not composing yet)
    editor.beginComposition(); // composition begins before that binding commits
    editor.updateComposition("가");
    state.catalog = 2; editor.fontsChanged();
    await flush();
    expect(state.commits).toEqual([]);
    editor.endComposition("가");
    await flush();
    expect(state.commits.map((c) => c.catalog)).toEqual([2]);
  });

  it("A4: closing or disposing before settlement delivers no binding to the old document", async () => {
    const closing = await session();
    closing.editor.beginComposition();
    closing.editor.updateComposition("가");
    closing.state.catalog = 2; closing.editor.fontsChanged();
    closing.editor.dispose(); // disposal ends the transaction and owns nothing afterwards
    await flush();
    expect(closing.state.commits).toEqual([]);

    const reload = await session();
    reload.editor.beginComposition();
    reload.editor.updateComposition("가");
    reload.state.catalog = 2; reload.editor.fontsChanged();
    reload.editor.setClosing(true); // the close path settles the composition without keeping the session editable
    await flush();
    // A settled-but-closing session may bind its own still-current document, never a different one.
    expect(reload.state.commits.every((c) => c.doc === reload.doc)).toBe(true);
  });

  it("A5: provisional and awaiting-final-input states keep the binding deferred until the whole transaction ends", async () => {
    const { editor, state } = await session();
    editor.beginComposition();
    editor.updateComposition("한");
    state.catalog = 2; editor.fontsChanged();
    editor.endComposition("한", { provisional: true }); // composition null, provisional pending
    await flush();
    expect(editor.composing).toBe(false);
    expect(editor.awaitingCompositionEnd).toBe(true);
    expect(state.commits).toEqual([]);
    editor.setAwaitingCommit(true);
    editor.resolveProvisional("한"); // provisional settled, still awaiting the input method's final text
    await flush();
    expect(state.commits).toEqual([]);
    editor.setAwaitingCommit(false);
    await flush();
    expect(state.commits.map((c) => c.catalog)).toEqual([2]);
  });

  it("a partial binding (requests beyond the limit) still re-lays out and repaints, and is reported as partial", async () => {
    const { editor, state } = await session();
    const layout = editor.layoutVersion, revision = editor.localRevision;
    state.partial = true; state.catalog = 5;
    editor.fontsChanged();
    await flush();
    expect(state.commits.map((c) => c.catalog)).toEqual([5]);
    expect(editor.naturalFontStatus).toMatchObject({ status: "bound", complete: false, omitted: ["Over Limit"] });
    expect(editor.layoutVersion).toBe(layout + 2); // fontsChanged repaint + binding relayout
    expect(editor.localRevision).toBe(revision);
  });

  it("a binding with no IME transaction still commits immediately", async () => {
    const { editor, state } = await session();
    state.catalog = 4; editor.fontsChanged();
    await flush();
    expect(state.commits.map((c) => c.catalog)).toEqual([4]);
  });
});
