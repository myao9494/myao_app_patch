/**
 * サーバーターミナルの入力補助ロジックのテスト
 * Tabキーのフォーカス制御とローカルエコー整形を検証する
 */
import { describe, expect, it } from "vitest";

import {
  applyLocalTerminalEcho,
  buildLocalLineReplacement,
  getTerminalReconnectDelay,
  isPrintableTerminalInput,
  shouldPreventTerminalTabFocus,
  updateTrackedTerminalInput,
} from "./terminalInput";

describe("ServerTerminal helpers", () => {
  it("prevents plain Tab from moving browser focus away", () => {
    const event = { key: "Tab", altKey: false, ctrlKey: false, metaKey: false } as KeyboardEvent;

    expect(shouldPreventTerminalTabFocus(event)).toBe(true);
  });

  it("allows modified Tab combinations to pass through", () => {
    const event = { key: "Tab", altKey: false, ctrlKey: true, metaKey: false } as KeyboardEvent;

    expect(shouldPreventTerminalTabFocus(event)).toBe(false);
  });

  it("renders Enter locally as a line break when shell echo is unavailable", () => {
    expect(applyLocalTerminalEcho("\r")).toBe("\r\n");
  });

  it("renders typed characters locally without altering them", () => {
    expect(applyLocalTerminalEcho("abc")).toBe("abc");
  });

  it("renders Backspace locally so the visible line is updated", () => {
    expect(applyLocalTerminalEcho("\u007F")).toBe("\b \b");
  });

  it("tracks typed text for Tab completion requests", () => {
    expect(updateTrackedTerminalInput("cd Doc", "u")).toBe("cd Docu");
  });

  it("clears the tracked line after Enter", () => {
    expect(updateTrackedTerminalInput("dir", "\r")).toBe("");
  });

  it("keeps the tracked line unchanged for Tab and arrow keys", () => {
    expect(updateTrackedTerminalInput("cd Doc", "\t")).toBe("cd Doc");
    expect(updateTrackedTerminalInput("cd Doc", "\u001B[D")).toBe("cd Doc");
  });

  it("replaces the visible line for history navigation", () => {
    expect(buildLocalLineReplacement("cd old", "cd backend", 10)).toBe("\b \b\b \b\b \b\b \b\b \b\b \bcd backend");
  });

  it("moves the cursor left after replacing the visible line", () => {
    expect(buildLocalLineReplacement("abc", "backend", 4)).toBe("\b \b\b \b\b \bbackend\u001B[3D");
  });

  it("treats plain text as printable terminal input", () => {
    expect(isPrintableTerminalInput("backend")).toBe(true);
    expect(isPrintableTerminalInput("\u001B[A")).toBe(false);
  });

  it("uses bounded exponential delays for automatic reconnect", () => {
    expect(getTerminalReconnectDelay(0)).toBe(500);
    expect(getTerminalReconnectDelay(1)).toBe(1_000);
    expect(getTerminalReconnectDelay(10)).toBe(5_000);
  });
});
