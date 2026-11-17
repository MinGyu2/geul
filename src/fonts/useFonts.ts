// Stage 5-A font controller: the catalog the font picker shows and the actions it runs (refresh, register, remove).
//
// The catalog comes from the backend's shared font database. After every change the WebView's user faces are synced
// (WebFontBridge), RHWP's natural-metric binder adopts the catalog (naturalFonts.ts) and open editors are told to
// redraw (DOCX re-lays out in the backend; RHWP rebinds exact font sources, re-lays out and repaints its Canvas).
// Browsing the list never edits a document; only choosing a family runs the `format.font` command.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { configureEmbedding } from "./embedding";
import type { FontBackend, FontCatalog, FontErrorCode } from "../adapters/fonts";
import type { Message, MessageKey, Translate } from "../language";
import { WebFontBridge } from "./webFonts";
import { naturalFonts } from "./naturalFonts";

export interface FontController {
  catalog: FontCatalog | null;
  busy: boolean;
  refresh(): Promise<void>;
  register(): Promise<void>;
  remove(family: string): Promise<void>;
}

const errorMessage = (code: FontErrorCode): Message => ({ key: `font.error.${code}` as MessageKey });

export function useFontController(
  backend: FontBackend | null, notify: (message: Message) => void, t: Translate, onFontsChanged: () => void,
): FontController | undefined {
  const [catalog, setCatalog] = useState<FontCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const bridge = useMemo(() => (backend ? new WebFontBridge(backend) : null), [backend]);
  const changed = useRef(onFontsChanged);
  useEffect(() => { changed.current = onFontsChanged; }, [onFontsChanged]);

  const adopt = useCallback(async (next: FontCatalog, engineChanged: boolean) => {
    setCatalog(next);
    const webChanged = bridge ? await bridge.sync(next) : false;
    // RHWP natural metrics resolve families against this catalog; configure before editors rebind on the change below.
    const naturalWasReady = naturalFonts.ready();
    naturalFonts.configure(backend, next);
    configureEmbedding(backend);
    if (engineChanged || webChanged || !naturalWasReady) changed.current();
  }, [bridge, backend]);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    void backend.catalog().then(async (result) => {
      if (!live) return;
      if (!result.ok) return notify(errorMessage(result.error));
      // Stored user fonts were loaded by the backend at start; the WebView receives them now.
      await adopt(result.value, false);
      if (!result.value.status.fontconfigAvailable) notify({ key: "font.fontconfigUnavailable" });
    });
    return () => { live = false; };
  }, [backend, adopt, notify]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } finally { setBusy(false); }
  }, []);

  return useMemo(() => {
    if (!backend) return undefined;
    return {
      catalog, busy,
      refresh: () => run(async () => {
        const result = await backend.refresh();
        if (!result.ok) return notify(errorMessage(result.error));
        await adopt(result.value, true);
        notify({ key: "font.refreshed", vars: { count: result.value.status.systemFaces } });
      }),
      register: () => run(async () => {
        const result = await backend.register(t("font.addTitle"), t("font.addAccept"), t("document.cancel"));
        if (!result.ok) return notify(errorMessage(result.error));
        if (result.value === null) return; // cancelled
        const families = result.value.font.families.join(", ");
        await adopt(result.value.catalog, true);
        notify(result.value.storageFailed ? { key: "font.storageFailed", vars: { families } } : { key: "font.registered", vars: { families } });
      }),
      remove: (family: string) => run(async () => {
        const result = await backend.remove(family);
        if (!result.ok) return notify(errorMessage(result.error));
        await adopt(result.value, true);
        notify({ key: "font.removed", vars: { family } });
      }),
    };
  }, [backend, catalog, busy, run, adopt, notify, t]);
}
