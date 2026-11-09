import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ native: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => bridge.native, invoke: bridge.invoke }));
import { clipboardAccessAvailable, systemClipboard } from "./clipboard";

describe("clipboard access adapter", () => {
  let previous: PropertyDescriptor | undefined;
  const browser = { readText: vi.fn(async () => "browser"), writeText: vi.fn(async () => {}) };
  beforeEach(() => {
    previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: browser });
    bridge.native = false; bridge.invoke.mockReset(); browser.readText.mockClear(); browser.writeText.mockClear();
  });
  afterEach(() => {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  it("Linux native text read uses one bounded IPC and no browser read", async () => {
    bridge.native = true; bridge.invoke.mockResolvedValue("native 한😀");
    expect(await systemClipboard.readText()).toBe("native 한😀");
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("clipboard_read_text");
    expect(browser.readText).not.toHaveBeenCalled();
  });
  it.each(["Unavailable", "TooLarge"])("%s is a failure without a competing fallback", async error => {
    bridge.native = true; bridge.invoke.mockRejectedValue(error);
    await expect(systemClipboard.readText()).rejects.toBe(error);
    expect(browser.readText).not.toHaveBeenCalled();
  });
  it("a host without this Linux bridge retains browser access", async () => {
    bridge.native = true; bridge.invoke.mockRejectedValue("Unsupported");
    expect(await systemClipboard.readText()).toBe("browser"); expect(browser.readText).toHaveBeenCalledTimes(1);
  });
  it("browser-only read starts within the invoking gesture", async () => {
    const request = systemClipboard.readText(); expect(browser.readText).toHaveBeenCalledTimes(1);
    expect(await request).toBe("browser"); expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("write uses the proven browser path only", async () => {
    bridge.native = true; await systemClipboard.writeText("한😀");
    expect(browser.writeText).toHaveBeenCalledExactlyOnceWith("한😀"); expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("native read remains available when the browser Clipboard API is absent", () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    bridge.native = true;
    expect(clipboardAccessAvailable("edit.paste")).toBe(true);
    expect(clipboardAccessAvailable("edit.cut")).toBe(false);
  });
});
