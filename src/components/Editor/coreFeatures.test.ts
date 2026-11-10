import { describe, expect, it, vi } from "vitest";
import { documentCommandState } from "../../commands/capability";
import { readyDocx, flush } from "./wordcraft/testing";
import type { ImportedPicture } from "../../commands/target";

const picture: ImportedPicture = { data: "AA==", width: 1, height: 1 };
const deferred = () => {
  let resolve!: (p: ImportedPicture | null) => void;
  const promise = new Promise<ImportedPicture | null>(r => { resolve = r; });
  return { promise, resolve };
};

describe("core insertions use the owned session queue", () => {
  it("validates table dimensions before queuing, preserves active selections", async () => {
    const { editor, fake } = await readyDocx(["keep"]);
    expect(editor.execute("insert.table", { command: "insert.table", rows: 0, cols: 2 }).accepted).toBe(false);
    editor.selectAll(); await flush();
    expect(editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 2 }).accepted).toBe(false);
    expect(fake.paragraphs).toEqual(["keep"]);
    editor.move("docStart", false); await flush();
    expect(editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 3 }).accepted).toBe(true);
    await flush();
    expect(fake.calls.filter(c => c.method === "edit").at(-1)?.args[3]).toEqual([{ op: "table", rows: 2, cols: 3 }]);
  });
  it("cancellation leaves the document and revision untouched", async () => {
    const { editor, fake } = await readyDocx(["keep"]);
    const before = editor.snapshot();
    expect(await editor.executeImage(() => true, async () => null)).toBe("cancelled");
    expect(editor.snapshot()).toEqual(before);
    expect(fake.calls.filter(c => c.method === "edit")).toHaveLength(0);
  });
  it.each(["tab", "caret", "edit", "ime", "close"])("rejects late pictures after %s changes", async change => {
    const { editor, fake } = await readyDocx(["keep"]);
    const job = deferred(); let owner = true;
    const pending = editor.executeImage(() => owner, () => job.promise);
    if (change === "tab") owner = false;
    if (change === "caret") { editor.move("docEnd", false); editor.move("docStart", false); }
    if (change === "edit") editor.typeText("new");
    if (change === "ime") editor.beginComposition();
    if (change === "close") editor.setClosing(true);
    await flush(); job.resolve(picture);
    expect(await pending).toBe("stale");
    expect(fake.calls.filter(c => c.method === "edit").flatMap(c => c.args[3] as { op: string }[]).some(o => o.op === "image")).toBe(false);
  });
  it("rejects duplicate chooser requests, queues only one fixed image operation", async () => {
    const { editor, fake } = await readyDocx(["keep"]);
    const job = deferred(), second = vi.fn(async () => picture);
    const pending = editor.executeImage(() => true, () => job.promise);
    expect(await editor.executeImage(() => true, second)).toBe("stale");
    expect(second).not.toHaveBeenCalled();
    job.resolve(picture); expect(await pending).toBe("inserted"); await flush();
    expect(fake.calls.filter(c => c.method === "edit").at(-1)?.args[3]).toEqual([{ op: "image", data: picture.data }]);
  });
  it("protects IME, pending caret operations and protected documents", async () => {
    const { editor } = await readyDocx(["keep"]);
    for (const id of ["insert.table", "insert.image", "paragraph.bullets"] as const) {
      editor.beginComposition(); expect(documentCommandState(id, editor.snapshot())).toEqual({ available: false, reason: "composing" });
      editor.endComposition("");
      editor.move("docEnd", false); expect(documentCommandState(id, editor.snapshot()).available).toBe(false); await flush();
      const snapshot = editor.snapshot(); snapshot.formatAccess = "protected";
      expect(documentCommandState(id, snapshot)).toEqual({ available: false, reason: "protected" });
    }
  });
});
