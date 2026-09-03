/**
 * グローバルショートカット判定のテスト
 * Ctrl/Cmdショートカットと編集可能要素の除外条件を検証する
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isEditableEventTarget,
  matchesCmdOrCtrlShortcut,
  matchesCmdOrCtrlShiftShortcut,
  matchesPlainShortcut,
  isModalEventTarget,
} from "./globalShortcuts";

describe("globalShortcuts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function installHTMLElementStubs() {
    class FakeHTMLElement {
      isContentEditable = false;
    }

    class FakeHTMLInputElement extends FakeHTMLElement {}
    class FakeHTMLTextAreaElement extends FakeHTMLElement {}
    class FakeHTMLButtonElement extends FakeHTMLElement {}

    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    vi.stubGlobal("HTMLInputElement", FakeHTMLInputElement);
    vi.stubGlobal("HTMLTextAreaElement", FakeHTMLTextAreaElement);

    return {
      FakeHTMLElement,
      FakeHTMLInputElement,
      FakeHTMLTextAreaElement,
      FakeHTMLButtonElement,
    };
  }

  it("matches Ctrl+R shortcut", () => {
    const event = { key: "r", ctrlKey: true, metaKey: false } as KeyboardEvent;

    expect(matchesCmdOrCtrlShortcut(event, "r")).toBe(true);
  });

  it("matches Cmd+R shortcut with uppercase key values", () => {
    const event = { key: "R", ctrlKey: false, metaKey: true } as KeyboardEvent;

    expect(matchesCmdOrCtrlShortcut(event, "r")).toBe(true);
  });

  it("does not match when modifier keys are missing", () => {
    const event = { key: "r", ctrlKey: false, metaKey: false } as KeyboardEvent;

    expect(matchesCmdOrCtrlShortcut(event, "r")).toBe(false);
  });

  it("does not match when Shift is also pressed", () => {
    const event = { key: "R", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false } as KeyboardEvent;

    expect(matchesCmdOrCtrlShortcut(event, "r")).toBe(false);
  });

  it("matches Cmd+Shift+P shortcut", () => {
    const event = { key: "P", ctrlKey: false, metaKey: true, shiftKey: true, altKey: false } as KeyboardEvent;

    expect(matchesCmdOrCtrlShiftShortcut(event, "p")).toBe(true);
  });

  it("does not match Cmd+Shift+P when Alt is also pressed", () => {
    const event = { key: "P", ctrlKey: false, metaKey: true, shiftKey: true, altKey: true } as KeyboardEvent;

    expect(matchesCmdOrCtrlShiftShortcut(event, "p")).toBe(false);
  });

  it("treats input and textarea as editable targets", () => {
    const { FakeHTMLInputElement, FakeHTMLTextAreaElement } = installHTMLElementStubs();

    expect(isEditableEventTarget(new FakeHTMLInputElement())).toBe(true);
    expect(isEditableEventTarget(new FakeHTMLTextAreaElement())).toBe(true);
  });

  it("detects keyboard events that originate inside a modal", () => {
    class FakeHTMLElement {
      constructor(private readonly inModal: boolean) {}

      closest(selector: string) {
        return selector === ".modal-overlay" && this.inModal ? this : null;
      }
    }

    vi.stubGlobal("HTMLElement", FakeHTMLElement);

    expect(isModalEventTarget(new FakeHTMLElement(true))).toBe(true);
    expect(isModalEventTarget(new FakeHTMLElement(false))).toBe(false);
    expect(isModalEventTarget(null)).toBe(false);
  });

  it("treats contenteditable elements as editable targets", () => {
    const { FakeHTMLElement } = installHTMLElementStubs();
    const element = new FakeHTMLElement();
    element.isContentEditable = true;

    expect(isEditableEventTarget(element)).toBe(true);
  });

  it("does not treat plain elements as editable targets", () => {
    const { FakeHTMLButtonElement } = installHTMLElementStubs();

    expect(isEditableEventTarget(new FakeHTMLButtonElement())).toBe(false);
    expect(isEditableEventTarget(null)).toBe(false);
  });

  describe("matchesPlainShortcut", () => {
    it("matches a key with no modifier keys", () => {
      const event = { key: "a", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
      expect(matchesPlainShortcut(event, "a")).toBe(true);
    });

    it("matches A key with no modifier keys (case insensitive)", () => {
      const event = { key: "A", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
      expect(matchesPlainShortcut(event, "a")).toBe(true);
    });

    it("does not match if ctrlKey is pressed", () => {
      const event = { key: "a", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
      expect(matchesPlainShortcut(event, "a")).toBe(false);
    });

    it("does not match if metaKey is pressed", () => {
      const event = { key: "a", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false } as KeyboardEvent;
      expect(matchesPlainShortcut(event, "a")).toBe(false);
    });

    it("does not match if altKey is pressed", () => {
      const event = { key: "a", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false } as KeyboardEvent;
      expect(matchesPlainShortcut(event, "a")).toBe(false);
    });

    it("matches r and n keys for refresh and rename", () => {
      const eventR = { key: "r", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
      const eventN = { key: "N", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
      expect(matchesPlainShortcut(eventR, "r")).toBe(true);
      expect(matchesPlainShortcut(eventN, "n")).toBe(true);
    });

    it("does not match if shiftKey is pressed", () => {
      const event = { key: "a", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true } as KeyboardEvent;
      expect(matchesPlainShortcut(event, "a")).toBe(false);
    });
  });
});
