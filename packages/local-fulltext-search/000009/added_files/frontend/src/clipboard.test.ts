/**
 * クリップボード安全コピーユーティリティ (copyTextToClipboard) の単体テスト。
 * Modern Clipboard API (navigator.clipboard) および Legacy DOM フォールバック (execCommand) の動作、
 * 非同期処理待ち後の User Activation 失効時の安全フォールバックを検証する。
 **/
import assert from "node:assert/strict";
import test from "node:test";
import { copyTextToClipboard } from "./clipboard.ts";

test("navigator.clipboard.writeText が利用可能な場合は正常にコピーし true を返す", async () => {
  let writtenText = "";
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: async (text: string) => {
          writtenText = text;
        },
      },
    },
    configurable: true,
    writable: true,
  });

  try {
    const result = await copyTextToClipboard("テスト文字列123");
    assert.equal(result, true);
    assert.equal(writtenText, "テスト文字列123");
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalDescriptor);
    }
  }
});

test("navigator.clipboard.writeText が権限エラー (NotAllowedError) で失敗した場合は document.execCommand にフォールバックする", async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocument = (globalThis as any).document;

  let execCommandCalled = false;
  let appendedValue = "";

  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: async () => {
          throw new Error("The request is not allowed by the user agent or the platform in the current context");
        },
      },
    },
    configurable: true,
    writable: true,
  });

  // @ts-ignore
  globalThis.document = {
    createElement: () => {
      const el: any = {
        style: {},
        setAttribute: () => {},
        focus: () => {},
        select: () => {},
        remove: () => {},
      };
      Object.defineProperty(el, "value", {
        set: (v) => {
          appendedValue = v;
        },
        get: () => appendedValue,
      });
      return el;
    },
    body: {
      appendChild: () => {},
    },
    execCommand: (cmd: string) => {
      if (cmd === "copy") {
        execCommandCalled = true;
        return true;
      }
      return false;
    },
  };

  try {
    const result = await copyTextToClipboard("/Users/mine/Desktop/test.pdf");
    assert.equal(result, true);
    assert.equal(execCommandCalled, true);
    assert.equal(appendedValue, "/Users/mine/Desktop/test.pdf");
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalDescriptor);
    }
    // @ts-ignore
    globalThis.document = originalDocument;
  }
});

test("全方式が失敗した場合でも例外を投げず false を返す", async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocument = (globalThis as any).document;

  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: async () => {
          throw new Error("Denied");
        },
      },
    },
    configurable: true,
    writable: true,
  });

  // @ts-ignore
  globalThis.document = {
    createElement: () => {
      throw new Error("DOM access failed");
    },
  };

  try {
    const result = await copyTextToClipboard("fail text");
    assert.equal(result, false);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalDescriptor);
    }
    // @ts-ignore
    globalThis.document = originalDocument;
  }
});
