import type { SessionInfo } from "../../adapters/contract";
import type { CharFormatFlag } from "../../commands/target";
import type { EngineEditor } from "./documentWorkspace";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";

/** Read-only projection. Null means unavailable, never a made-up default. */
export interface DocumentPanelState {
  info: SessionInfo | null;
  status: string;
  pageCount: number | null;
  page: number | null; // zero based
  caret: string | null;
  selection: "none" | "selected" | "unavailable";
  paragraphStyle: string | null;
  selectedText: string | null; // preview, at most 500 characters
  format: Record<CharFormatFlag, boolean | null> | null;
  canNavigate: boolean;
  pending: boolean;
  composing: boolean;
}

export function documentPanelState(editor: EngineEditor | null, info: SessionInfo | null): DocumentPanelState {
  const empty: DocumentPanelState = {
    info, status: editor?.status.kind ?? "idle", pageCount: null, page: null, caret: null,
    selection: "unavailable", paragraphStyle: null, selectedText: null, format: null, canNavigate: false, pending: false, composing: false,
  };
  if (!editor || !info || editor.sessionId !== info.sessionId) return empty;
  const snapshot = editor.snapshot();
  empty.pending = snapshot.pending;
  empty.composing = snapshot.composing;
  if (!snapshot.loaded) return empty;
  const rhwp = editor instanceof RhwpEditorSession;
  const pages = rhwp ? editor.pages : editor.view?.pages;
  const count = pages?.length ?? 0;
  const caret = rhwp ? editor.caretRect() : editor.view?.caret;
  const selected = rhwp ? editor.hasSelection : editor.view ? !editor.view.collapsed : null;
  const format = !rhwp ? editor.view?.format : null;
  return {
    ...empty,
    pageCount: count > 0 ? count : null,
    page: caret && caret.page >= 0 && caret.page < count ? caret.page : null,
    caret: rhwp ? `${editor.caret.section}:${editor.caret.paragraph}:${editor.caret.offset}${editor.caret.cell ? ":cell" : ""}` : editor.view?.caretKey ?? null,
    selection: selected === null ? "unavailable" : selected ? "selected" : "none",
    selectedText: selected && !snapshot.composing && !snapshot.pending
      ? rhwp ? editor.selectionPreview() : editor.view?.selectionText ?? null : null,
    paragraphStyle: !rhwp && !snapshot.pending ? editor.view?.paragraphStyle ?? null : null,
    // WordCraft reports whether ALL selected text has a flag. False does not distinguish mixed from off.
    format: format && !snapshot.pending && !snapshot.composing ? {
      bold: selected && !format.bold ? null : format.bold,
      italic: selected && !format.italic ? null : format.italic,
      underline: selected && !format.underline ? null : format.underline,
      strikethrough: selected && !format.strikethrough ? null : format.strikethrough,
    } : null,
    canNavigate: snapshot.editable && !snapshot.pending && !snapshot.composing && !snapshot.saving && count > 0,
  };
}

/** Recheck live ownership/state at dispatch time; never finish composition to navigate. */
export function navigateDocumentPage(editor: EngineEditor | null, info: SessionInfo | null, page: number): boolean {
  const state = documentPanelState(editor, info);
  if (!editor || !state.canNavigate || !Number.isInteger(page) || page < 0 || page >= (state.pageCount ?? 0)) return false;
  return editor.pointAt(page, 0, 0, false);
}
