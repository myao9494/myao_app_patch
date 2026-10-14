/**
 * errorLog のテスト: エラーがコンソールに出ること
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installGlobalErrorLogging, logError } from "./errorLog";

describe("errorLog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logError は文脈つきで console.error に出す", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("boom");
    logError("テスト", err);
    expect(spy).toHaveBeenCalledWith("[file_manager] テスト", err);
  });

  it("未処理エラーと Promise 拒否を console.error に出し、解除できる", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handlers: Record<string, (e: unknown) => void> = {};
    const fakeWindow = {
      addEventListener: (type: string, h: (e: unknown) => void) => { handlers[type] = h; },
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const uninstall = installGlobalErrorLogging(fakeWindow);
    handlers.error({ error: new Error("e1"), message: "e1" });
    handlers.unhandledrejection({ reason: "r1" });
    expect(spy).toHaveBeenCalledTimes(2);
    uninstall();
    expect(fakeWindow.removeEventListener).toHaveBeenCalledTimes(2);
  });
});
