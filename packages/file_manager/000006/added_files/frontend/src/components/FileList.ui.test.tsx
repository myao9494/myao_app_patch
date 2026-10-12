// @vitest-environment jsdom
/**
 * FileList の画面操作テスト
 * - 実際の FileList を jsdom 上に描画し、偽バックエンド（src/test/fakeBackend.ts）に対して操作する
 * - 分割リファクタリングの前後で、利用者から見た挙動が変わらないことを確認するためのテスト
 *   （一覧表示・並べ替え・選択・キーボード操作・絞り込み・フォルダ移動と戻る/進む・
 *    削除・コピー/切り取り/貼り付け・同名衝突時の上書き確認・作成・リネーム・右クリックメニュー・ドラッグ&ドロップ）
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderFileList } from "../test/renderFileList";

const TREE = {
  "/root/docs": "dir",
  "/root/docs/inner.txt": "inner",
  "/root/photos": "dir",
  "/root/b.md": "# b",
  "/root/a.txt": "aaa",
  "/root/c.py": "print(1)",
};

const ROOT_NAMES = ["docs", "photos", "a.txt", "b.md", "c.py"];

async function ready(tree: Parameters<typeof renderFileList>[0] = TREE, options?: Parameters<typeof renderFileList>[1]) {
  const ui = await renderFileList(tree, options);
  await waitFor(() => expect(ui.names().length).toBeGreaterThan(0));
  return ui;
}

const selectedNames = (ui: Awaited<ReturnType<typeof ready>>) =>
  ui.rows().filter((r) => r.classList.contains("selected")).map((r) => r.querySelector(".name-info-wrapper span")?.textContent);

/** アプリ内ドラッグ用の DataTransfer（setData / getData だけを持つ） */
function appDataTransfer() {
  return {
    data: {} as Record<string, string>,
    setData(type: string, value: string) { this.data[type] = value; },
    getData(type: string) { return this.data[type] ?? ""; },
    effectAllowed: "all",
    dropEffect: "move",
    types: [] as string[],
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    setDragImage() {},
  };
}

/** OS（Explorer / Finder）からのドロップ用の DataTransfer */
function osDataTransfer(files: File[]) {
  return {
    files: files as unknown as FileList,
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })) as unknown as DataTransferItemList,
    types: ["Files"],
    getData: () => "",
    setData() {},
    dropEffect: "copy",
    effectAllowed: "all",
  };
}

const focusedName = (ui: Awaited<ReturnType<typeof ready>>) =>
  ui.rows().find((r) => r.classList.contains("focused"))?.querySelector(".name-info-wrapper span")?.textContent;

describe("一覧表示と並べ替え", () => {
  it("フォルダを先に、名前順で表示する", async () => {
    const ui = await ready();
    expect(ui.names()).toEqual(ROOT_NAMES);
  });

  it("フォルダ行・ファイル行ともにチェックボックス列に checkbox-col が付く（列の垂直揃えの前提）", async () => {
    const ui = await ready();
    for (const row of ui.rows()) {
      expect(row.querySelector("td")).toHaveClass("checkbox-col");
      expect(row.querySelector("td.name-cell")).not.toBeNull();
    }
  });

  it("Name 列見出しのクリックで昇順/降順を切り替える", async () => {
    const ui = await ready();
    await ui.user.click(screen.getByText(/^Name/));
    expect(ui.names()).toEqual(["photos", "docs", "c.py", "b.md", "a.txt"]);
    await ui.user.click(screen.getByText(/^Name/));
    expect(ui.names()).toEqual(ROOT_NAMES);
  });
});

describe("選択", () => {
  it("クリックで1件選択、Ctrl+クリックで追加、Shift+クリックで範囲選択", async () => {
    const ui = await ready();
    await ui.user.click(ui.row("a.txt"));
    expect(selectedNames(ui)).toEqual(["a.txt"]);

    await ui.user.keyboard("{Control>}");
    await ui.user.click(ui.row("c.py"));
    await ui.user.keyboard("{/Control}");
    expect(selectedNames(ui)).toEqual(["a.txt", "c.py"]);

    await ui.user.click(ui.row("docs"));
    await ui.user.keyboard("{Shift>}");
    await ui.user.click(ui.row("a.txt"));
    await ui.user.keyboard("{/Shift}");
    expect(selectedNames(ui)).toEqual(["docs", "photos", "a.txt"]);
  });

  it("チェックボックスで選択を切り替える", async () => {
    const ui = await ready();
    const checkbox = ui.within(ui.row("b.md")).getByRole("checkbox");
    await ui.user.click(checkbox);
    expect(selectedNames(ui)).toEqual(["b.md"]);
    await ui.user.click(checkbox);
    expect(selectedNames(ui)).toEqual([]);
  });

  it("Ctrl+A で全選択、Escape で選択解除", async () => {
    const ui = await ready();
    await ui.press("{Control>}a{/Control}");
    expect(selectedNames(ui)).toEqual(ROOT_NAMES);
    await ui.press("{Escape}");
    expect(selectedNames(ui)).toEqual([]);
  });
});

describe("キーボードでのカーソル移動とフォルダ移動", () => {
  it("↓↑でカーソルが動き、Shift+↓で連続選択する", async () => {
    const ui = await ready();
    expect(focusedName(ui)).toBe("docs");
    await ui.press("{ArrowDown}{ArrowDown}");
    expect(focusedName(ui)).toBe("a.txt");
    await ui.press("{ArrowUp}");
    expect(focusedName(ui)).toBe("photos");
    await ui.press("{Shift>}{ArrowDown}{/Shift}");
    expect(selectedNames(ui)).toEqual(["photos", "a.txt"]);
  });

  it("Enter は未選択なら選択し、選択済みのフォルダなら開く", async () => {
    const ui = await ready();
    await ui.press("{Enter}");
    expect(selectedNames(ui)).toEqual(["docs"]);
    await ui.press("{Enter}");
    await waitFor(() => expect(ui.names()).toEqual(["inner.txt"]));
    expect(ui.onPathChange).toHaveBeenLastCalledWith("/root/docs");
  });

  it("フォルダ名クリックで移動し、戻る/進むボタンで行き来できる", async () => {
    const ui = await ready();
    await ui.user.click(ui.within(ui.row("docs")).getByText("docs"));
    await waitFor(() => expect(ui.names()).toEqual(["inner.txt"]));

    await ui.user.click(screen.getByTitle("戻る"));
    await waitFor(() => expect(ui.names()).toEqual(ROOT_NAMES));

    await ui.user.click(screen.getByTitle("進む"));
    await waitFor(() => expect(ui.names()).toEqual(["inner.txt"]));
  });

  it("Ctrl+↑ で上の階層へ戻り、元いたフォルダにカーソルを合わせる", async () => {
    const ui = await ready();
    await ui.user.click(ui.within(ui.row("photos")).getByText("photos"));
    await waitFor(() => expect(ui.names()).toEqual([]));
    await ui.press("{Control>}{ArrowUp}{/Control}");
    await waitFor(() => expect(ui.names()).toEqual(ROOT_NAMES));
    await waitFor(() => expect(focusedName(ui)).toBe("photos"));
  });

  it("パス入力欄にフォルダを入力して移動できる", async () => {
    const ui = await ready();
    const input = screen.getByPlaceholderText("フルパスを入力");
    await ui.user.clear(input);
    await ui.user.type(input, "/root/docs{Enter}");
    await waitFor(() => expect(ui.names()).toEqual(["inner.txt"]));
  });
});

describe("セクション間のキーボード移動", () => {
  const keyboardFocused = (ui: Awaited<ReturnType<typeof ready>>) =>
    Array.from(ui.container.querySelectorAll(".keyboard-focused")).map(
      (el) => el.getAttribute("title") ?? el.getAttribute("placeholder") ?? el.textContent?.trim()
    );

  it("一覧の先頭で↑を押すと検索ボックスへ、検索ボックスで↓を押すと一覧へ戻る", async () => {
    const ui = await ready();
    await ui.press("{ArrowUp}");
    const search = screen.getByPlaceholderText("正規表現で検索... (Ctrl+F / /)");
    await waitFor(() => expect(search).toHaveFocus());
    await ui.user.keyboard("{ArrowDown}");
    await waitFor(() => expect(ui.container.querySelector(".file-list")).toHaveFocus());
    expect(focusedName(ui)).toBe("docs");
  });

  it("ツールバー → パス → フィルタ → 履歴検索 → 検索 の順に↓で移動し、←→でボタンを選ぶ", async () => {
    const ui = await ready();
    const pathInput = screen.getByPlaceholderText("フルパスを入力");
    await ui.user.click(pathInput);
    await ui.user.keyboard("{Control>}{ArrowUp}{/Control}");
    await waitFor(() => expect(keyboardFocused(ui)).toEqual(["戻る"]));

    await ui.user.keyboard("{ArrowRight}{ArrowRight}");
    expect(keyboardFocused(ui)).toEqual(["上の階層へ"]);
    await ui.user.keyboard("{ArrowLeft}");
    expect(keyboardFocused(ui)).toEqual(["進む"]);

    // パスのボタン: フルパスをコピー → リンクをコピー → パス入力欄
    await ui.user.keyboard("{ArrowDown}");
    expect(keyboardFocused(ui)).toEqual(["フルパスをコピー"]);
    await ui.user.keyboard("{ArrowRight}");
    expect(keyboardFocused(ui)).toEqual(["リンクをコピー"]);
    await ui.user.keyboard("{ArrowRight}");
    expect(keyboardFocused(ui)).toEqual(["フルパスを入力"]);
    await ui.user.keyboard("{ArrowRight}");
    expect(keyboardFocused(ui)).toEqual(["フルパスを入力"]);

    await ui.user.keyboard("{ArrowDown}");
    const filterButtons = ui.container.querySelectorAll(".filter-bar .filter-btn");
    expect(filterButtons[0]).toHaveClass("keyboard-focused");
    await ui.user.keyboard("{ArrowRight}");
    expect(filterButtons[1]).toHaveClass("keyboard-focused");
    expect(filterButtons[0]).not.toHaveClass("keyboard-focused");

    await ui.user.keyboard("{ArrowUp}");
    expect(keyboardFocused(ui)).toEqual(["フルパスをコピー"]);
    await ui.user.keyboard("{ArrowDown}{ArrowDown}");
    await waitFor(() => expect(screen.getByPlaceholderText("履歴を検索...")).toHaveFocus());
    expect(keyboardFocused(ui)).toEqual([]);

    await ui.user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByPlaceholderText("正規表現で検索... (Ctrl+F / /)")).toHaveFocus());
  });

  it("ツールバーで Enter を押すと選んだボタンを実行する", async () => {
    const ui = await ready();
    const list = ui.container.querySelector(".file-list");
    const toolbarTitles = Array.from(ui.container.querySelectorAll(".icon-toolbar button")).map((b) => b.getAttribute("title"));
    const searchIndex = toolbarTitles.indexOf("ファイル名検索 (Ctrl+F / /)");
    expect(searchIndex).toBeGreaterThan(0);

    await ui.user.click(screen.getByPlaceholderText("フルパスを入力"));
    await ui.user.keyboard("{Control>}{ArrowUp}{/Control}");
    await waitFor(() => expect(list).toHaveFocus());
    await ui.user.keyboard("{ArrowRight}".repeat(searchIndex));
    expect(keyboardFocused(ui)).toEqual(["ファイル名検索 (Ctrl+F / /)"]);
    await ui.user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByPlaceholderText("正規表現で検索... (Ctrl+F / /)")).toHaveFocus());
  });

  it("パスのボタンで Enter を押すと、ハイライトしたボタンを実行する", async () => {
    const ui = await ready();
    await ui.user.click(screen.getByPlaceholderText("フルパスを入力"));
    await ui.user.keyboard("{Control>}{ArrowUp}{/Control}{ArrowDown}");
    expect(keyboardFocused(ui)).toEqual(["フルパスをコピー"]);
    await ui.user.keyboard("{Enter}");
    await waitFor(() => expect(ui.clipboardText.value).toBe("/root"));

    // パス入力欄で Enter を押すと入力欄にフォーカスする
    await ui.user.keyboard("{ArrowRight}{ArrowRight}{Enter}");
    await waitFor(() => expect(screen.getByPlaceholderText("フルパスを入力")).toHaveFocus());
  });

  it("フィルタで Enter を押すと選んだフィルタを適用する", async () => {
    const ui = await ready();
    await ui.user.click(screen.getByPlaceholderText("フルパスを入力"));
    await ui.user.keyboard("{Control>}{ArrowDown}{/Control}");
    const filterButtons = Array.from(ui.container.querySelectorAll<HTMLButtonElement>(".filter-bar .filter-btn"));
    const fileOnlyIndex = filterButtons.findIndex((b) => b.textContent?.trim() === "F");
    expect(fileOnlyIndex).toBeGreaterThan(0);
    await ui.user.keyboard("{ArrowRight}".repeat(fileOnlyIndex));
    expect(filterButtons[fileOnlyIndex]).toHaveClass("keyboard-focused");
    await ui.user.keyboard("{Enter}");
    await waitFor(() => expect(ui.names()).toEqual(["a.txt", "b.md", "c.py"]));
  });
});

describe("一覧での選択キー", () => {
  it("Ctrl+Enter で選択を切り替え、Ctrl+Shift+A で全解除する", async () => {
    const ui = await ready();
    await ui.press("{Control>}{Enter}{/Control}");
    expect(selectedNames(ui)).toEqual(["docs"]);
    await ui.press("{Control>}{Enter}{/Control}");
    expect(selectedNames(ui)).toEqual([]);

    await ui.press("{Control>}a{/Control}");
    expect(selectedNames(ui)).toEqual(ROOT_NAMES);
    await ui.press("{Control>}{Shift>}a{/Shift}{/Control}");
    expect(selectedNames(ui)).toEqual([]);
  });

  it("Ctrl+← と Ctrl+↓ で戻り、Ctrl+→ で進む", async () => {
    const ui = await ready();
    await ui.press("{Enter}{Enter}"); // docs へ移動
    await waitFor(() => expect(ui.names()).toEqual(["inner.txt"]));
    await ui.press("{Control>}{ArrowLeft}{/Control}");
    await waitFor(() => expect(ui.names()).toEqual(ROOT_NAMES));
    await ui.press("{Control>}{ArrowRight}{/Control}");
    await waitFor(() => expect(ui.names()).toEqual(["inner.txt"]));
    await ui.press("{Control>}{ArrowDown}{/Control}");
    await waitFor(() => expect(ui.names()).toEqual(ROOT_NAMES));
  });

  it("Shift+↑ でも連続選択し、最後の行で↓を押してもカーソルは動かない", async () => {
    const ui = await ready();
    await ui.press("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(focusedName(ui)).toBe("c.py");
    await ui.press("{Shift>}{ArrowUp}{ArrowUp}{/Shift}");
    expect(selectedNames(ui)).toEqual(["a.txt", "b.md", "c.py"]);
    expect(focusedName(ui)).toBe("a.txt");
  });
});

describe("フォルダ履歴の検索", () => {
  async function visitDocsAndReturn() {
    const ui = await ready({ ...TREE, "/root/docs/deep": "dir" });
    await ui.press("{Enter}{Enter}"); // docs へ移動
    await waitFor(() => expect(ui.names()).toEqual(["deep", "inner.txt"]));
    await ui.press("{Control>}{ArrowLeft}{/Control}");
    await waitFor(() => expect(ui.names()).toEqual(ROOT_NAMES));
    // 読み込み完了時に一覧へフォーカスが戻るのを待ってから履歴検索欄を操作する
    await waitFor(() => expect(ui.container.querySelector(".file-list")).toHaveFocus());
    return ui;
  }
  const dropdownPaths = (ui: Awaited<ReturnType<typeof ready>>) =>
    Array.from(ui.container.querySelectorAll(".history-item")).map((el) => el.querySelector("span")?.textContent);

  it("入力すると候補を出し、Enter で選んだフォルダへ移動して一覧に戻る", async () => {
    const ui = await visitDocsAndReturn();
    const input = screen.getByPlaceholderText("履歴を検索...");
    await ui.user.click(input);
    await ui.user.type(input, "docs");
    await waitFor(() => expect(dropdownPaths(ui)).toEqual(["/root/docs"]));
    expect(ui.container.querySelector(".history-item")).toHaveClass("selected");

    await ui.user.keyboard("{Enter}");
    await waitFor(() => expect(ui.names()).toEqual(["deep", "inner.txt"]));
    expect(ui.container.querySelector(".history-dropdown")).toBeNull();
    await waitFor(() => expect(ui.container.querySelector(".file-list")).toHaveFocus());
  });

  it("↓↑で候補を選び、Escape で閉じる。候補のクリックでも移動する", async () => {
    const ui = await visitDocsAndReturn();
    const input = screen.getByPlaceholderText("履歴を検索...");
    await ui.user.click(input);
    await ui.user.type(input, "root");
    await waitFor(() => expect(dropdownPaths(ui)).toHaveLength(2));
    const items = () => Array.from(ui.container.querySelectorAll(".history-item"));
    expect(items()[0]).toHaveClass("selected");
    await ui.user.keyboard("{ArrowDown}");
    expect(items()[1]).toHaveClass("selected");
    await ui.user.keyboard("{ArrowDown}");
    expect(items()[1]).toHaveClass("selected");
    await ui.user.keyboard("{ArrowUp}");
    expect(items()[0]).toHaveClass("selected");

    await ui.user.keyboard("{Escape}");
    expect(ui.container.querySelector(".history-dropdown")).toBeNull();

    await ui.user.type(input, "/docs");
    await waitFor(() => expect(dropdownPaths(ui)).toEqual(["/root/docs"]));
    // user.click だと入力欄の blur から 200ms で閉じる処理と競合するため、クリックだけを送る
    fireEvent.click(items()[0]);
    await waitFor(() => expect(ui.names()).toEqual(["deep", "inner.txt"]));
  });
});

describe("一覧の絞り込み", () => {
  it("検索ボックスの入力で名前を絞り込み、件数を表示する", async () => {
    const ui = await ready();
    const search = screen.getByPlaceholderText(/検索\.\.\. \(Ctrl\+F/);
    await ui.user.type(search, "txt");
    await waitFor(() => expect(ui.names()).toEqual(["a.txt"]));
    expect(ui.container.textContent).toMatch(/1\s*\/\s*1/);
  });

  it("Escape で検索語を消し、一覧に戻る", async () => {
    const ui = await ready();
    const search = screen.getByPlaceholderText(/検索\.\.\. \(Ctrl\+F/);
    await ui.user.type(search, "md");
    await waitFor(() => expect(ui.names()).toEqual(["b.md"]));
    await ui.user.keyboard("{Escape}");
    await waitFor(() => expect(ui.names()).toEqual(ROOT_NAMES));
    expect(search).toHaveValue("");
  });

  it("フィルタバーの「F」でファイルだけ、「D」でフォルダだけを表示する", async () => {
    const ui = await ready();
    await ui.user.click(screen.getByRole("button", { name: "F" }));
    expect(ui.names()).toEqual(["a.txt", "b.md", "c.py"]);
    await ui.user.click(screen.getByRole("button", { name: "D" }));
    expect(ui.names()).toEqual(["docs", "photos"]);
  });
});

describe("削除", () => {
  it("Delete キー → 確認ダイアログ → ゴミ箱へ移動し、一覧から消える", async () => {
    const ui = await ready();
    await ui.user.click(ui.row("a.txt"));
    await ui.press("{Delete}");

    expect(await screen.findByText("「a.txt」を削除しますか？", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/ゴミ箱に移動します/)).toBeInTheDocument();
    await ui.user.click(screen.getByRole("button", { name: "削除" }));

    await waitFor(() => expect(ui.names()).toEqual(["docs", "photos", "b.md", "c.py"]));
    expect(ui.backend.callsTo("/api/delete/batch")[0].body).toMatchObject({ paths: ["/root/a.txt"], async_mode: false });
    expect(await screen.findByText("1件削除しました")).toBeInTheDocument();
  });

  it("確認ダイアログでキャンセルすると何も削除しない", async () => {
    const ui = await ready();
    await ui.user.click(ui.row("a.txt"));
    await ui.press("{Delete}");
    await ui.user.click(await screen.findByRole("button", { name: "キャンセル" }));
    expect(ui.backend.callsTo("/api/delete/batch")).toHaveLength(0);
    expect(ui.names()).toEqual(ROOT_NAMES);
  });

  it("フォルダを含む削除は非同期モードで依頼する", async () => {
    const ui = await ready();
    await ui.user.click(ui.row("docs"));
    await ui.press("{Delete}");
    await ui.user.click(await screen.findByRole("button", { name: "削除" }));
    await waitFor(() => expect(ui.backend.callsTo("/api/delete/batch")).toHaveLength(1));
    expect(ui.backend.callsTo("/api/delete/batch")[0].body).toMatchObject({ paths: ["/root/docs"], async_mode: true });
  });
});

describe("コピー・切り取り・貼り付け", () => {
  it("Ctrl+C → 別フォルダで Ctrl+V でコピーする", async () => {
    const ui = await ready();
    await ui.user.click(ui.row("a.txt"));
    await ui.press("{Control>}c{/Control}");
    expect(await screen.findByText(/コピーしました|件をコピー/)).toBeInTheDocument();

    await ui.user.click(ui.within(ui.row("docs")).getByText("docs"));
    await waitFor(() => expect(ui.names()).toEqual(["inner.txt"]));
    await ui.press("{Control>}v{/Control}");

    await waitFor(() => expect(ui.names()).toEqual(["a.txt", "inner.txt"]));
    expect(ui.backend.callsTo("/api/copy/batch")[0].body).toMatchObject({
      src_paths: ["/root/a.txt"],
      dest_path: "/root/docs",
      overwrite: false,
    });
    expect(ui.backend.exists("/root/a.txt")).toBe(true);
  });

  it("Ctrl+X → Ctrl+V で移動する", async () => {
    const ui = await ready();
    await ui.user.click(ui.row("b.md"));
    await ui.press("{Control>}x{/Control}");
    await ui.user.click(ui.within(ui.row("photos")).getByText("photos"));
    await waitFor(() => expect(ui.names()).toEqual([]));
    await ui.press("{Control>}v{/Control}");

    await waitFor(() => expect(ui.names()).toEqual(["b.md"]));
    expect(ui.backend.exists("/root/b.md")).toBe(false);
    expect(ui.backend.exists("/root/photos/b.md")).toBe(true);
  });

  it("同名の項目がある場合は上書き確認を出し、確認すると overwrite=true で再実行する", async () => {
    const ui = await ready({ ...TREE, "/root/docs/a.txt": "old" });
    await ui.user.click(ui.row("a.txt"));
    await ui.press("{Control>}c{/Control}");
    await ui.user.click(ui.within(ui.row("docs")).getByText("docs"));
    await waitFor(() => expect(ui.names()).toEqual(["a.txt", "inner.txt"]));
    await ui.press("{Control>}v{/Control}");

    await waitFor(() => expect(ui.confirmSpy).toHaveBeenCalledWith(expect.stringContaining("既に存在します")));
    await waitFor(() => expect(ui.backend.callsTo("/api/copy/batch")).toHaveLength(2));
    expect(ui.backend.callsTo("/api/copy/batch")[1].body).toMatchObject({ overwrite: true, async_mode: true });
  });

  it("上書き確認でキャンセルすると再実行しない", async () => {
    const ui = await ready({ ...TREE, "/root/docs/a.txt": "old" }, { confirm: false });
    await ui.user.click(ui.row("a.txt"));
    await ui.press("{Control>}c{/Control}");
    await ui.user.click(ui.within(ui.row("docs")).getByText("docs"));
    await waitFor(() => expect(ui.names()).toEqual(["a.txt", "inner.txt"]));
    await ui.press("{Control>}v{/Control}");

    await waitFor(() => expect(ui.confirmSpy).toHaveBeenCalled());
    expect(ui.backend.callsTo("/api/copy/batch")).toHaveLength(1);
  });
});

describe("ドラッグ&ドロップ", () => {
  it("ファイルをフォルダ行にドロップすると移動する（同じペインでは確認を出す）", async () => {
    const ui = await ready();
    const dataTransfer = appDataTransfer();
    fireEvent.dragStart(ui.row("c.py"), { dataTransfer });
    fireEvent.dragOver(ui.row("docs"), { dataTransfer });
    fireEvent.drop(ui.row("docs"), { dataTransfer });

    await waitFor(() => expect(ui.backend.callsTo("/api/move/batch")).toHaveLength(1));
    expect(ui.confirmSpy).toHaveBeenCalledWith("同じペイン内での移動です。よろしいですか？");
    expect(ui.backend.callsTo("/api/move/batch")[0].body).toMatchObject({
      src_paths: ["/root/c.py"],
      dest_path: "/root/docs",
      overwrite: false,
    });
    await waitFor(() => expect(ui.names()).not.toContain("c.py"));
  });

  it("同じペイン内の移動の確認でキャンセルすると移動しない", async () => {
    const ui = await ready(TREE, { confirm: false });
    const dataTransfer = appDataTransfer();
    fireEvent.dragStart(ui.row("c.py"), { dataTransfer });
    fireEvent.drop(ui.row("docs"), { dataTransfer });
    await waitFor(() => expect(ui.confirmSpy).toHaveBeenCalled());
    expect(ui.backend.callsTo("/api/move/batch")).toHaveLength(0);
    expect(ui.names()).toContain("c.py");
  });

  it("選択中の行をドラッグすると選択項目をまとめて移動し、フォルダを含むと非同期で依頼する", async () => {
    const ui = await ready();
    await ui.user.click(ui.within(ui.row("photos")).getByRole("checkbox"));
    await ui.user.click(ui.within(ui.row("a.txt")).getByRole("checkbox"));
    const dataTransfer = appDataTransfer();
    fireEvent.dragStart(ui.row("a.txt"), { dataTransfer });
    fireEvent.drop(ui.row("docs"), { dataTransfer });

    await waitFor(() => expect(ui.backend.callsTo("/api/move/batch")).toHaveLength(1));
    expect(ui.backend.callsTo("/api/move/batch")[0].body).toMatchObject({
      src_paths: ["/root/photos", "/root/a.txt"],
      dest_path: "/root/docs",
      async_mode: true,
    });
  });

  it("OS からファイルを余白にドロップすると現在のフォルダへアップロードする", async () => {
    const ui = await ready();
    const file = new File(["hello"], "new.txt", { type: "text/plain" });
    fireEvent.drop(ui.container.querySelector(".file-list")!, { dataTransfer: osDataTransfer([file]) });

    await waitFor(() => expect(ui.backend.callsTo("/api/upload")).toHaveLength(1));
    const call = ui.backend.callsTo("/api/upload")[0];
    expect(call.query.path).toBe("/root");
    expect(call.body).toMatchObject({ files: ["new.txt"] });
    await waitFor(() => expect(ui.names()).toContain("new.txt"));
  });

  it("OS からファイルをフォルダ行にドロップするとそのフォルダへアップロードする", async () => {
    const ui = await ready();
    const file = new File(["hello"], "new.txt", { type: "text/plain" });
    fireEvent.drop(ui.row("docs"), { dataTransfer: osDataTransfer([file]) });

    await waitFor(() => expect(ui.backend.callsTo("/api/upload")).toHaveLength(1));
    expect(ui.backend.callsTo("/api/upload")[0].query.path).toBe("/root/docs");
    expect(ui.backend.callsTo("/api/move/batch")).toHaveLength(0);
  });
});

describe("ファイルを開く", () => {
  const OPEN_TREE = {
    ...TREE,
    "/root/obsidian/note.md": "# n",
    "/root/doc.pdf": "pdf",
    "/root/pic.png": "png",
    "/root/sheet.xlsx": "x",
    "/root/lab.ipynb": "{}",
  };
  const openSmartCalls = (ui: Awaited<ReturnType<typeof ready>>) =>
    ui.backend.callsTo("/api/open/smart").map((c) => c.body);

  it("テキストはダブルクリックで内蔵エディタに開く", async () => {
    const ui = await ready(OPEN_TREE);
    await ui.user.dblClick(ui.row("a.txt"));
    await waitFor(() => expect(screen.getByDisplayValue("content of a.txt")).toBeInTheDocument());
    expect(openSmartCalls(ui)).toEqual([{ path: "/root/a.txt", prefer_embedded: false }]);
  });

  it("Markdown は（Web エディタ設定なら）内蔵の Markdown エディタを優先して開く", async () => {
    const ui = await ready(OPEN_TREE);
    await ui.user.dblClick(ui.row("b.md"));
    await waitFor(() => expect(screen.getByTitle("Markdown編集: b.md")).toBeInTheDocument());
    expect(openSmartCalls(ui)).toEqual([{ path: "/root/b.md", prefer_embedded: true }]);
  });

  it("「Obsidian or Web」設定では obsidian 配下の Markdown を Obsidian で開き、それ以外は内蔵エディタ", async () => {
    const ui = await ready(OPEN_TREE, { markdownOpenMode: "obsidian_or_web" });
    await ui.user.dblClick(ui.row("b.md"));
    await waitFor(() => expect(screen.getByTitle("Markdown編集: b.md")).toBeInTheDocument());
    expect(ui.backend.callsTo("/api/open/obsidian")).toHaveLength(0);
    await ui.user.click(screen.getByRole("button", { name: "キャンセル" }));

    await ui.user.click(ui.within(ui.row("obsidian")).getByText("obsidian"));
    await waitFor(() => expect(ui.names()).toEqual(["note.md"]));
    await ui.user.dblClick(ui.row("note.md"));
    await waitFor(() => expect(ui.backend.callsTo("/api/open/obsidian")).toHaveLength(1));
    expect(ui.backend.callsTo("/api/open/obsidian")[0].body).toMatchObject({ path: "/root/obsidian/note.md" });
    expect(openSmartCalls(ui)).toHaveLength(1);
  });

  it("テキストを VS Code で開く設定では open/smart を使わずに VS Code で開く", async () => {
    const ui = await ready(OPEN_TREE, { textFileOpenMode: "vscode" });
    await ui.user.dblClick(ui.row("c.py"));
    await waitFor(() => expect(ui.backend.callsTo("/api/open/vscode")).toHaveLength(1));
    expect(ui.backend.callsTo("/api/open/vscode")[0].body).toMatchObject({ path: "/root/c.py" });
    expect(openSmartCalls(ui)).toHaveLength(0);
  });

  it("PDF はブラウザの別タブ、画像は内蔵の画像プレビュー、Notebook は URL、その他は既定のアプリで開く", async () => {
    const ui = await ready(OPEN_TREE);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      await ui.user.dblClick(ui.row("doc.pdf"));
      expect(open).toHaveBeenCalledWith(expect.stringContaining("/api/view-pdf?path=%2Froot%2Fdoc.pdf"), "_blank", "noopener,noreferrer");

      await ui.user.dblClick(ui.row("lab.ipynb"));
      await waitFor(() => expect(open).toHaveBeenCalledWith("http://localhost:8888/lab/tree/root/lab.ipynb", "_blank", "noopener,noreferrer"));

      await ui.user.dblClick(ui.row("sheet.xlsx"));
      await waitFor(() => expect(screen.getByText("既定のアプリで開きました")).toBeInTheDocument());

      await ui.user.dblClick(ui.row("pic.png"));
      await waitFor(() => expect(ui.container.querySelector(".image-preview-filename")?.textContent).toContain("pic.png"));
      expect(openSmartCalls(ui).map((c) => (c as { path: string }).path)).toEqual(["/root/lab.ipynb", "/root/sheet.xlsx"]);
    } finally {
      open.mockRestore();
    }
  });
});

describe("フォルダの Git 状態・最新更新日", () => {
  const gitCell = (ui: Awaited<ReturnType<typeof ready>>, name: string) =>
    ui.row(name).querySelector(".git-col")?.textContent?.trim();

  it("g キーでフォルダの Git 状態を表示し、Push 待ちのボタンで git push コマンドをコピーする", async () => {
    const ui = await ready();
    ui.backend.gitStatuses["/root/docs"] = { ahead: 1, behind: 0, changed: [] };
    ui.backend.gitStatuses["/root/photos"] = { ahead: 0, behind: 0, changed: ["a.png"] };
    await ui.press("g");
    await waitFor(() => expect(gitCell(ui, "docs")).toBe("Push"));
    expect(gitCell(ui, "photos")).toBe("G");
    expect(ui.backend.callsTo("/api/git-folder-statuses")[0].body).toEqual({ paths: ["/root/docs", "/root/photos"] });

    await ui.user.click(ui.within(ui.row("docs")).getByRole("button", { name: "Push" }));
    await waitFor(() => expect(ui.clipboardText.value).toBe("cd '/root/docs' && git push"));
  });

  it("フォルダを移動すると Git 状態の表示を消す", async () => {
    const ui = await ready({ ...TREE, "/root/docs/sub": "dir" });
    ui.backend.gitStatuses["/root/docs"] = { ahead: 0, behind: 2, changed: [] };
    await ui.press("g");
    await waitFor(() => expect(gitCell(ui, "docs")).toBe("Pull"));
    await ui.press("{Enter}{Enter}");
    await waitFor(() => expect(ui.names()).toEqual(["sub", "inner.txt"]));
    await ui.press("{Control>}{ArrowLeft}{/Control}");
    await waitFor(() => expect(ui.names()).toEqual(ROOT_NAMES));
    expect(gitCell(ui, "docs")).toBe("");
  });

  it("d キーでカーソル行のフォルダの最新更新日を集計して Date 列に表示する", async () => {
    const ui = await ready();
    ui.backend.latestModified["/root/docs"] = "2030-04-05T06:07:08";
    await ui.press("d");
    await waitFor(() => expect(ui.row("docs").textContent).toContain("2030"));
    expect(ui.backend.callsTo("/api/folder-latest-modified")[0].body).toEqual({ path: "/root/docs" });
  });

  it("d キーはファイル行では集計せずにエラーを表示する", async () => {
    const ui = await ready();
    await ui.press("{ArrowDown}{ArrowDown}"); // a.txt
    await ui.press("d");
    await waitFor(() => expect(screen.getByText("フォルダを1件選択するか、フォルダ行にカーソルを置いてください")).toBeInTheDocument());
    expect(ui.backend.callsTo("/api/folder-latest-modified")).toHaveLength(0);
  });
});

describe("範囲選択（ラバーバンド）", () => {
  it("余白からドラッグした矩形に重なる行を選択する", async () => {
    const ui = await ready();
    const list = ui.container.querySelector<HTMLElement>(".file-list")!;
    // jsdom にはレイアウトがないため、行の位置を data-index から決める（1行 30px、先頭は y=40）
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const index = this.getAttribute("data-index");
      if (this.tagName === "TR" && index !== null) {
        const top = 40 + Number(index) * 30;
        return { left: 0, top, width: 400, height: 30, right: 400, bottom: top + 30, x: 0, y: top, toJSON() {} } as DOMRect;
      }
      return { left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
    try {
      fireEvent.mouseDown(list, { button: 0, clientX: 10, clientY: 75 });
      expect(ui.container.querySelector(".selection-box")).not.toBeNull();
      fireEvent.mouseMove(list, { clientX: 200, clientY: 125 });
      fireEvent.mouseUp(list);
      // y=75〜125 に重なるのは index 1（70〜100）と index 2（100〜130）
      expect(selectedNames(ui)).toEqual(["photos", "a.txt"]);
      expect(ui.container.querySelector(".selection-box")).toBeNull();

      // 微小なドラッグはクリック扱いで選択を変えない
      fireEvent.mouseDown(list, { button: 0, clientX: 10, clientY: 160 });
      fireEvent.mouseMove(list, { clientX: 12, clientY: 162 });
      fireEvent.mouseUp(list);
      expect(selectedNames(ui)).toEqual(["photos", "a.txt"]);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});

describe("作成・リネーム", () => {
  it("a キーでフォルダ作成ダイアログを開き、作成する", async () => {
    const ui = await ready();
    await ui.press("a");
    const input = await screen.findByPlaceholderText("フォルダ名");
    await waitFor(() => expect(input).toHaveFocus());
    await ui.user.type(input, "new-folder{Enter}");

    await waitFor(() => expect(ui.names()).toContain("new-folder"));
    expect(ui.backend.callsTo("/api/create-folder")[0].body).toEqual({ path: "/root", name: "new-folder" });
  });

  it("t キーでテキストファイル作成ダイアログを開き、名前と拡張子からファイルを作る", async () => {
    const ui = await ready();
    await ui.press("t");
    const nameInput = await screen.findByPlaceholderText("ファイル名");
    await waitFor(() => expect(nameInput).toHaveFocus());
    await ui.user.type(nameInput, "memo");
    const extInput = screen.getByPlaceholderText("txt");
    await ui.user.clear(extInput);
    await ui.user.type(extInput, ".log{Enter}");

    await waitFor(() => expect(ui.backend.callsTo("/api/create-file")).toHaveLength(1));
    expect(ui.backend.callsTo("/api/create-file")[0].body).toEqual({ path: "/root", name: "memo.log", content: "" });
    await waitFor(() => expect(ui.names()).toContain("memo.log"));
  });

  it("「Markdownファイル作成」で名前に .md を付けてエディタを開く（保存するまでファイルは作らない）", async () => {
    const ui = await ready();
    await ui.user.click(screen.getByTitle("Markdownファイル作成"));
    const input = await screen.findByPlaceholderText("ファイル名");
    await waitFor(() => expect(input).toHaveFocus());
    await ui.user.type(input, "note{Enter}");
    await waitFor(() => expect(screen.getByTitle("Markdown編集: note.md")).toBeInTheDocument());
    expect(ui.backend.callsTo("/api/create-file")).toHaveLength(0);
  });

  it("「Excalidrawで開く」で空の図面を作って開く（obsidian 配下では .excalidraw.md）", async () => {
    const ui = await ready({ ...TREE, "/root/obsidian": "dir" });
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("drawing");
    try {
      await ui.user.click(screen.getByTitle("Excalidrawで開く"));
      await waitFor(() => expect(ui.backend.callsTo("/api/open/excalidraw")).toHaveLength(1));
      expect(ui.backend.callsTo("/api/create-file")[0].body).toMatchObject({ path: "/root", name: "drawing.excalidraw" });
      expect(ui.backend.callsTo("/api/open/excalidraw")[0].body).toEqual({ path: "/root/drawing.excalidraw" });

      await ui.user.click(ui.within(ui.row("obsidian")).getByText("obsidian"));
      await waitFor(() => expect(ui.names()).toEqual([]));
      await ui.user.click(screen.getByTitle("Excalidrawで開く"));
      await waitFor(() => expect(ui.backend.callsTo("/api/create-file")).toHaveLength(2));
      expect(ui.backend.callsTo("/api/create-file")[1].body).toMatchObject({ path: "/root/obsidian", name: "drawing.excalidraw.md" });
    } finally {
      prompt.mockRestore();
    }
  });

  it("n キーでカーソル行のリネームを始め、拡張子を保ったまま名前を変える", async () => {
    const ui = await ready();
    await ui.press("{ArrowDown}{ArrowDown}"); // a.txt
    await ui.press("n");
    const nameInput = await screen.findByDisplayValue("a");
    expect(screen.getByDisplayValue("txt")).toBeInTheDocument();
    await ui.user.clear(nameInput);
    await ui.user.type(nameInput, "renamed{Enter}");

    await waitFor(() => expect(ui.backend.callsTo("/api/rename")).toHaveLength(1));
    expect(ui.backend.callsTo("/api/rename")[0].body).toEqual({ old_path: "/root/a.txt", new_name: "renamed.txt" });
    await waitFor(() => expect(ui.names()).toContain("renamed.txt"));
  });
});

describe("右クリックメニュー", () => {
  it("余白の右クリックで一覧をチェックボックス形式・リンク付き形式でコピーできる", async () => {
    const ui = await ready();
    fireEvent.contextMenu(ui.container.querySelector(".file-table thead")!);
    await ui.user.click(await screen.findByText("リスト取得(check_box)"));
    await waitFor(() => expect(ui.clipboardText.value).toBe(
      "- [ ] docs\n- [ ] photos\n- [ ] a.txt\n- [ ] b.md\n- [ ] c.py",
    ));

    fireEvent.contextMenu(ui.container.querySelector(".file-table thead")!);
    await ui.user.click(await screen.findByText("リスト取得(リンク付)"));
    await waitFor(() => expect(ui.clipboardText.value.split("\n")[0]).toBe("- [docs](file:///root/docs)"));
  });

  it("行の右クリックで項目メニューを開き、削除を選ぶと確認ダイアログを出す", async () => {
    const ui = await ready();
    fireEvent.contextMenu(ui.row("b.md"));
    await ui.user.click(await screen.findByText(/^削除$/));
    expect(await screen.findByText("「b.md」を削除しますか？", { exact: false })).toBeInTheDocument();
  });
});

describe("ツールバー・ショートカット", () => {
  it("「上の階層へ」「ホームへ」ボタンでフォルダを移動する", async () => {
    const ui = await ready();
    await ui.user.click(ui.within(ui.row("docs")).getByText("docs"));
    await waitFor(() => expect(ui.names()).toEqual(["inner.txt"]));
    await ui.user.click(screen.getByTitle("上の階層へ"));
    await waitFor(() => expect(ui.names()).toEqual(ROOT_NAMES));
  });

  it("「選択項目を削除」ボタンで削除確認を出す", async () => {
    const ui = await ready();
    await ui.user.click(ui.row("c.py"));
    await ui.user.click(screen.getByTitle("選択項目を削除"));
    expect(await screen.findByText("「c.py」を削除しますか？", { exact: false })).toBeInTheDocument();
  });

  it("r キーで一覧を再読み込みし、外部での変更を反映する", async () => {
    const ui = await ready();
    ui.backend.add("/root/z-new.txt", { type: "file", size: 1 });
    await ui.press("r");
    await waitFor(() => expect(ui.names()).toContain("z-new.txt"));
    expect(await screen.findByText("一覧を更新しました")).toBeInTheDocument();
  });

  it("h キーで使い方を表示する", async () => {
    const ui = await ready();
    await ui.press("h");
    expect(await screen.findByText("ショートカットキー")).toBeInTheDocument();
  });

  it("拡張子フィルタ「MD」で Markdown だけを表示する（フォルダは表示したまま）", async () => {
    const ui = await ready();
    await ui.user.click(screen.getByRole("button", { name: "MD" }));
    expect(ui.names().filter((n) => n.includes("."))).toEqual(["b.md"]);
  });

  it("戻ったときに、そのフォルダで選んでいた項目とカーソル位置を復元する", async () => {
    const ui = await ready();
    await ui.press("{ArrowDown}{ArrowDown}{ArrowDown}"); // b.md
    await ui.user.click(ui.row("b.md"));
    expect(selectedNames(ui)).toEqual(["b.md"]);
    await ui.user.click(ui.within(ui.row("docs")).getByText("docs"));
    await waitFor(() => expect(ui.names()).toEqual(["inner.txt"]));
    await ui.user.click(screen.getByTitle("戻る"));
    await waitFor(() => expect(ui.names()).toEqual(ROOT_NAMES));
    await waitFor(() => expect(selectedNames(ui)).toEqual(["b.md"]));
    expect(focusedName(ui)).toBe("b.md");
  });
});
