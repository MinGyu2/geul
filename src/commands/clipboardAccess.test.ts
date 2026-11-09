import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ native: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => bridge.native, invoke: bridge.invoke }));
import { clipboardAccessAvailable, resetClipboardCapabilityForTests, systemClipboard } from "./clipboard";

const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

describe("clipboard access adapter", () => {
  let previous: PropertyDescriptor | undefined;
  const agent = (value: string) => Object.defineProperty(navigator, "userAgent", { configurable: true, value });
  const browser = { readText: vi.fn(async () => "browser"), writeText: vi.fn(async () => {}) };
  beforeEach(() => {
    previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: browser });
    bridge.native = false; bridge.invoke.mockReset(); browser.readText.mockClear(); browser.writeText.mockClear();
    resetClipboardCapabilityForTests(); agent(LINUX);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "userAgent");
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
  it("a Linux build answering Unsupported falls back once and is remembered", async () => {
    bridge.native = true; bridge.invoke.mockRejectedValue("Unsupported");
    expect(await systemClipboard.readText()).toBe("browser"); expect(browser.readText).toHaveBeenCalledTimes(1);
    expect(await systemClipboard.readText()).toBe("browser");
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    expect(clipboardAccessAvailable("edit.paste")).toBe(false);
  });
  it.each([["Windows", WINDOWS], ["macOS", MAC]])("%s Tauri reads through the browser API inside the gesture, no bridge IPC", async (_, ua) => {
    bridge.native = true; agent(ua);
    const request = systemClipboard.readText();
    expect(browser.readText).toHaveBeenCalledTimes(1);
    expect(await request).toBe("browser");
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(clipboardAccessAvailable("edit.paste")).toBe(true);
  });
  it.each([["Windows", WINDOWS], ["macOS", MAC]])("%s Tauri without a browser read API does not advertise Paste", (_, ua) => {
    bridge.native = true; agent(ua);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: browser.writeText } });
    expect(clipboardAccessAvailable("edit.paste")).toBe(false);
    expect(clipboardAccessAvailable("edit.copy")).toBe(true);
  });
  it("a plain browser (not Tauri) depends only on the Clipboard API", () => {
    expect(clipboardAccessAvailable("edit.paste")).toBe(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    expect(clipboardAccessAvailable("edit.paste")).toBe(false);
    expect(clipboardAccessAvailable("edit.copy")).toBe(false);
  });
  it("an Android user agent is not the desktop Linux bridge", () => {
    bridge.native = true; agent("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    expect(clipboardAccessAvailable("edit.paste")).toBe(false);
  });
  it("permission denial is an execution failure, never a capability probe", async () => {
    agent(WINDOWS); bridge.native = true;
    browser.readText.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    expect(clipboardAccessAvailable("edit.paste")).toBe(true);
    expect(browser.readText).not.toHaveBeenCalled();
    await expect(systemClipboard.readText()).rejects.toThrow("denied");
    expect(clipboardAccessAvailable("edit.paste")).toBe(true);
  });
  it("browser-only read starts within the invoking gesture", async () => {
    const request = systemClipboard.readText(); expect(browser.readText).toHaveBeenCalledTimes(1);
    expect(await request).toBe("browser"); expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("write uses the proven browser path only", async () => {
    bridge.native = true; await systemClipboard.writeText("한😀");
    expect(browser.writeText).toHaveBeenCalledExactlyOnceWith("한😀"); expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("Linux native read remains available when the browser Clipboard API is absent", () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    bridge.native = true;
    expect(clipboardAccessAvailable("edit.paste")).toBe(true);
    expect(clipboardAccessAvailable("edit.cut")).toBe(false);
  });
});
