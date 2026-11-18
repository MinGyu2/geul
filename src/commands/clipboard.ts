import { invoke, isTauri } from "@tauri-apps/api/core";
import { documentCommandState } from "./capability";
import {
  clearStructuredClipboard,
  MAX_TABLE_CLIPBOARD_BYTES,
  parseTableClipboardPayload,
  recallStructuredClipboard,
  rememberStructuredClipboard,
  structuredClipboardVersion,
  TABLE_CLIPBOARD_MIME,
} from "./tableClipboard";
import type { DocumentCommandTarget } from "./target";

export type ClipboardCommand = "edit.copy" | "edit.cut" | "edit.paste";
export const isClipboardCommand = (id: string): id is ClipboardCommand =>
  id === "edit.copy" || id === "edit.cut" || id === "edit.paste";

/** One clipboard action, including paragraph separators. Never truncate. */
export const MAX_CLIPBOARD_CHARS = 1024 * 1024;
export function validClipboardText(text: string): boolean {
  return text.length <= MAX_CLIPBOARD_CHARS * 2 && [...text].length <= MAX_CLIPBOARD_CHARS
    && !/[^\P{Cc}\n\r\t]|\uFFFC|\p{Cs}/u.test(text);
}

/** The bounded GTK text-read bridge (`clipboard_read_text`) is compiled only for
 * Linux (`#[cfg(target_os = "linux")]`); every other target answers "Unsupported".
 * Desktop Tauri on Linux is always WebKitGTK, whose user agent names Linux, so the
 * user agent mirrors that cfg without an IPC round trip or a clipboard read. A
 * runtime "Unsupported" answer overrides the guess for the rest of the process. */
let nativeReadUnsupported = false;
function hasNativeTextRead(): boolean {
  if (nativeReadUnsupported || !isTauri() || typeof navigator === "undefined") return false;
  const agent = navigator.userAgent ?? "";
  return /\bLinux\b/.test(agent) && !/\bAndroid\b/.test(agent);
}
function browserClipboard(method: "readText" | "writeText"): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.[method] === "function";
}

/** API presence only: a present path may still be refused at run time (permission),
 * which is reported as an execution failure, never probed here. */
export function clipboardAccessAvailable(command: ClipboardCommand): boolean {
  if (command === "edit.paste") return hasNativeTextRead() || browserClipboard("readText");
  return browserClipboard("writeText");
}

/** Test seam: forget a remembered runtime "Unsupported" answer. */
export function resetClipboardCapabilityForTests(): void {
  nativeReadUnsupported = false;
}

export interface PlainClipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  readStructured?(mime: string): Promise<string | null>;
  writeStructured?(mime: string, data: string, plainText: string): Promise<void>;
}
export const systemClipboard: PlainClipboard = {
  readText: async () => {
    if (hasNativeTextRead()) {
      try { return await invoke<string>("clipboard_read_text"); }
      catch (error) {
        // A Linux read failure never starts a competing pipeline; only a host
        // without the bridge falls back (and is remembered as such).
        if (error !== "Unsupported") throw error;
        nativeReadUnsupported = true;
      }
    }
    // Hosts without the bridge call the browser API directly, inside the
    // invoking gesture (no IPC await in front of a permission-gated read).
    return navigator.clipboard.readText();
  },
  writeText: text => navigator.clipboard.writeText(text),
};

export type StructuredReadResult =
  | { status: "none" }
  | { status: "rejected" }
  | { status: "ok"; mime: string; data: string; plainText: string };

export interface ClipboardEditing {
  read(): Promise<string | null>;
  readStructured?(): Promise<StructuredReadResult>;
  remove(): boolean;
  removeStructured?(): boolean | Promise<boolean>;
  insert(text: string): boolean;
  insertStructured?(mime: string, data: string): Promise<"ok" | "notTable" | "rejected">;
}

const running = new WeakSet<DocumentCommandTarget>();

/** No event fallback: registered shortcuts cancel the browser's clipboard default.
 * Capture before yielding, and revalidate after every async boundary. The engine
 * session alone performs editing, using its existing queue and history policy. */
export async function runClipboard(
  target: DocumentCommandTarget, command: ClipboardCommand, editing: ClipboardEditing,
  owns: () => boolean, clipboard: PlainClipboard = systemClipboard,
): Promise<boolean> {
  if (running.has(target)) return false;
  const initial = target.snapshot();
  if (!owns() || !initial.clipboard || !documentCommandState(command, initial).available) return false;
  const key = initial.clipboard.key;
  const current = () => {
    const now = target.snapshot();
    return owns() && now.sessionId === initial.sessionId && now.loadGeneration === initial.loadGeneration
      && now.revision === initial.revision && now.clipboard?.key === key && documentCommandState(command, now).available;
  };
  running.add(target);
  try {
    if (command === "edit.paste") {
      const pasteStructured = async (raw: string, recalled: boolean): Promise<boolean> => {
        const parsed = parseTableClipboardPayload(raw);
        if (!parsed || !editing.insertStructured) return false;
        const version = structuredClipboardVersion();
        const outcome = await editing.insertStructured(TABLE_CLIPBOARD_MIME, raw);
        if (outcome === "ok") return true;
        if (outcome === "rejected") return false;
        // notTable: the plain-text fallback is a new mutation after an async boundary.
        // Revalidate the document/session/revision and the recalled payload identity
        // synchronously (no extra clipboard read, so no new permission prompt).
        if (!current() || (recalled && structuredClipboardVersion() !== version)) return false;
        const hasMerges = parsed.cells.some(c => c.rowSpan > 1 || c.colSpan > 1);
        return !hasMerges && parsed.plainText !== "" && validClipboardText(parsed.plainText) && editing.insert(parsed.plainText);
      };
      // Start the permission-sensitive read in the original user gesture.
      const rawStructured = clipboard.readStructured ? await clipboard.readStructured(TABLE_CLIPBOARD_MIME) : null;
      if (!current()) return false;
      if (rawStructured !== null) return await pasteStructured(rawStructured, false);
      const text = await clipboard.readText();
      if (!current()) return false;
      const recalled = recallStructuredClipboard(TABLE_CLIPBOARD_MIME, text);
      if (recalled !== null && editing.insertStructured) return await pasteStructured(recalled, true);
      return text !== "" && validClipboardText(text) && editing.insert(text);
    }
    if (editing.readStructured) {
      const structured = await editing.readStructured();
      if (!current()) return false;
      if (structured.status === "rejected") return false;
      if (structured.status === "ok") {
        const { mime, data, plainText } = structured;
        if (!plainText || !validClipboardText(plainText) || data.length > MAX_TABLE_CLIPBOARD_BYTES) return false;
        if (clipboard.writeStructured) await clipboard.writeStructured(mime, data, plainText);
        else await clipboard.writeText(plainText);
        if (!current()) return false;
        rememberStructuredClipboard(mime, data, plainText);
        if (command === "edit.copy") return true;
        return editing.removeStructured ? await editing.removeStructured() : editing.remove();
      }
    }
    const text = await editing.read();
    if (!current() || !text || !validClipboardText(text)) return false;
    await clipboard.writeText(text);
    if (!current()) return false;
    clearStructuredClipboard();
    return command === "edit.copy" || editing.remove();
  } catch {
    return false;
  } finally {
    running.delete(target);
  }
}
