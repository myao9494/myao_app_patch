import { describe, expect, it } from "vitest";
import {
  MAX_NAVIGATION_ENTRIES,
  canGoBack,
  canGoForward,
  createNavigation,
  pushNavigation,
  stepNavigation,
} from "./navigationHistory";

const none = { focusedIndex: 0, selectedItems: [] };

describe("navigationHistory", () => {
  it("移動するとエントリが増え、離れたフォルダのカーソルと選択を保存する", () => {
    let state = createNavigation("/a");
    state = pushNavigation(state, { focusedIndex: 3, selectedItems: new Set(["/a/x"]) }, "/a/b");
    expect(state.index).toBe(1);
    expect(state.entries).toEqual([
      { path: "/a", focusedIndex: 3, selectedItems: ["/a/x"] },
      { path: "/a/b", focusedIndex: 0, selectedItems: [] },
    ]);
    expect(canGoBack(state)).toBe(true);
    expect(canGoForward(state)).toBe(false);
  });

  it("戻る/進むで移動先のエントリを返し、今のフォルダの状態を保存する", () => {
    let state = pushNavigation(createNavigation("/a"), { focusedIndex: 2, selectedItems: [] }, "/b");
    const back = stepNavigation(state, { focusedIndex: 5, selectedItems: ["/b/y"] }, -1);
    expect(back?.target).toEqual({ path: "/a", focusedIndex: 2, selectedItems: [] });
    state = back!.state;
    expect(state.index).toBe(0);
    expect(state.entries[1]).toEqual({ path: "/b", focusedIndex: 5, selectedItems: ["/b/y"] });

    const forward = stepNavigation(state, none, 1);
    expect(forward?.target.path).toBe("/b");
    expect(forward?.target.selectedItems).toEqual(["/b/y"]);
  });

  it("端ではそれ以上戻れない/進めない", () => {
    const state = createNavigation("/a");
    expect(stepNavigation(state, none, -1)).toBeNull();
    expect(stepNavigation(state, none, 1)).toBeNull();
  });

  it("戻った位置から別のフォルダへ移動すると、進む側の履歴を捨てる", () => {
    let state = createNavigation("/a");
    state = pushNavigation(state, none, "/b");
    state = pushNavigation(state, none, "/c");
    state = stepNavigation(state, none, -1)!.state;
    state = stepNavigation(state, none, -1)!.state;
    state = pushNavigation(state, none, "/d");
    expect(state.entries.map((e) => e.path)).toEqual(["/a", "/d"]);
    expect(state.index).toBe(1);
  });

  it(`最大 ${MAX_NAVIGATION_ENTRIES} 件まで保持し、古いものから捨てる`, () => {
    let state = createNavigation("/0");
    for (let i = 1; i <= MAX_NAVIGATION_ENTRIES + 5; i++) {
      state = pushNavigation(state, none, `/${i}`);
    }
    expect(state.entries).toHaveLength(MAX_NAVIGATION_ENTRIES);
    expect(state.entries[0].path).toBe("/6");
    expect(state.index).toBe(MAX_NAVIGATION_ENTRIES - 1);
  });
});
