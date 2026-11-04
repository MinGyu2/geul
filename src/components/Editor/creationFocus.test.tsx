import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LanguageProvider } from "../../language/LanguageContext";
import { RhwpSurface } from "./rhwp/RhwpSurface";
import { readySession, flush } from "./rhwp/testing";
import { DocxSurface } from "./wordcraft/DocxSurface";
import { readyDocx, stubScreenContext } from "./wordcraft/testing";
import { captureSurfaceFocus, releaseSurfaceFocus, setSurfaceFocusLease } from "./surfaceFocus";

for (const engine of ["rhwp", "wordcraft"] as const) {
  for (const interrupted of [false, true]) {
    it(`${engine}: a created editor waits for its first usable paint, focus interrupted=${interrupted}`, async () => {
      const prior = document.createElement("input");
      document.body.append(prior); prior.focus();
      stubScreenContext();
      const state = engine === "rhwp" ? await readySession([""]) : await readyDocx([""]);
      const editor = state.editor;
      setSurfaceFocusLease(editor, captureSurfaceFocus());
      const paint = engine === "rhwp"
        ? vi.spyOn((state as Awaited<ReturnType<typeof readySession>>).editor, "renderPage").mockReturnValue(false)
        : vi.spyOn((state as Awaited<ReturnType<typeof readyDocx>>).editor, "paint").mockImplementation(() => {});
      const surface = (zoom: number) => <LanguageProvider language="ko" onLanguageChange={() => {}}>
        {engine === "rhwp" ? <RhwpSurface session={(state as Awaited<ReturnType<typeof readySession>>).editor} zoom={zoom} />
          : <DocxSurface session={(state as Awaited<ReturnType<typeof readyDocx>>).editor} zoom={zoom} />}
      </LanguageProvider>;
      const view = render(surface(100));
      try {
        await act(flush);
        expect(editor.status.kind).toBe("ready");
        expect(editor.firstPaintMs).toBeNull();
        expect(prior).toHaveFocus();
        if (interrupted) prior.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        paint.mockRestore();
        view.rerender(surface(200));
        await act(flush);
        expect(editor.firstPaintMs).not.toBeNull();
        if (interrupted) expect(prior).toHaveFocus();
        else expect(view.container.querySelector(".rhwp-input")).toHaveFocus();
      } finally {
        paint.mockRestore(); releaseSurfaceFocus(editor); view.unmount(); editor.dispose(); prior.remove();
      }
    });
  }
}
