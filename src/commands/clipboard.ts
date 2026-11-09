import { invoke, isTauri } from "@tauri-apps/api/core";
import { documentCommandState } from "./capability";
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

export function clipboardAccessAvailable(command: ClipboardCommand): boolean {
  if (command === "edit.paste" && isTauri()) return true;
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.[command === "edit.paste" ? "readText" : "writeText"] === "function";
}

export interface PlainClipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}
export const systemClipboard: PlainClipboard = {
  readText: async () => {
    if (isTauri()) {
      try { return await invoke<string>("clipboard_read_text"); }
      catch (error) {
        // The bridge is intentionally Linux-only. Other hosts retain their
        // browser API; a Linux read failure never starts a competing pipeline.
        if (error !== "Unsupported") throw error;
      }
    }
    return navigator.clipboard.readText();
  },
  writeText: text => navigator.clipboard.writeText(text),
};

export interface ClipboardEditing {
  read(): Promise<string | null>;
  remove(): boolean;
  insert(text: string): boolean;
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
      // Start the permission-sensitive read in the original user gesture.
      const text = await clipboard.readText();
      return current() && text !== "" && validClipboardText(text) && editing.insert(text);
    }
    const text = await editing.read();
    if (!current() || !text || !validClipboardText(text)) return false;
    await clipboard.writeText(text);
    if (!current()) return false;
    return command === "edit.copy" || editing.remove();
  } catch {
    return false;
  } finally {
    running.delete(target);
  }
}
