/**
 * FileList の画面操作テスト用ヘルパー
 * - 実際のアプリと同じ Provider（Query / 操作履歴 / フォルダ履歴 / トースト）で FileList を描画する
 * - fetch を偽バックエンドに差し替え、jsdom にない API（scrollIntoView・clipboard）を補う
 * - window.confirm の応答をテストごとに指定できる
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, vi } from "vitest";
import { FileList } from "../components/FileList";
import { FolderHistoryProvider } from "../contexts/FolderHistoryContext";
import { OperationHistoryProvider } from "../contexts/OperationHistoryContext";
import { ToastProvider } from "../contexts/ToastContext";
import { FakeBackend, type FakeEntry } from "./fakeBackend";
import type { MarkdownOpenMode, TextFileOpenMode } from "../utils/editorPreferences";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

export interface RenderFileListOptions {
  path?: string;
  panelId?: string;
  confirm?: boolean;
  textFileOpenMode?: TextFileOpenMode;
  markdownOpenMode?: MarkdownOpenMode;
}

export async function renderFileList(
  tree: Record<string, FakeEntry | "dir" | string>,
  options: RenderFileListOptions = {},
) {
  const backend = new FakeBackend(tree);
  vi.stubGlobal("fetch", vi.fn(backend.fetch));
  Element.prototype.scrollIntoView = vi.fn();
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(options.confirm ?? true);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // userEvent.setup() は navigator.clipboard を差し替えるため、その後でクリップボードの代役を設定する
  const user = userEvent.setup();
  const clipboardText = { value: "" };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => { clipboardText.value = text; }),
      readText: vi.fn(async () => clipboardText.value),
    },
  });
  const onPathChange = vi.fn();
  const startPath = options.path ?? "/root";

  const utils = render(
    <QueryClientProvider client={queryClient}>
      <OperationHistoryProvider>
        <FolderHistoryProvider>
          <ToastProvider>
            <FileList
              panelId={options.panelId ?? "left"}
              initialPath={startPath}
              isFocused
              onPathChange={onPathChange}
              textFileOpenMode={options.textFileOpenMode}
              markdownOpenMode={options.markdownOpenMode}
            />
          </ToastProvider>
        </FolderHistoryProvider>
      </OperationHistoryProvider>
    </QueryClientProvider>,
  );

  // 初期パスの検証と一覧の取得が終わるまで待つ
  await screen.findByRole("table");
  // 読み込み完了の1フレーム後に、フォーカス中のペインは一覧コンテナへフォーカスを移す。
  // それより前に入力を始めると途中でフォーカスが移ってしまうため、実際の利用時と同じ状態になるまで待つ
  await waitFor(() => expect(document.activeElement).toBe(utils.container.querySelector(".file-list")));

  /** 一覧の行（tbody tr）をフォルダ→ファイルの順で返す */
  const rows = () => [...utils.container.querySelectorAll<HTMLTableRowElement>(".file-table tbody tr")];
  /** 表示されている名前の一覧 */
  const names = () => rows().map((row) => row.querySelector(".name-info-wrapper span")?.textContent ?? "");
  /** 名前で行を探す */
  const row = (name: string) => {
    const found = rows().find((r) => r.querySelector(".name-info-wrapper span")?.textContent === name);
    if (!found) throw new Error(`row not found: ${name} (rows: ${names().join(", ")})`);
    return found;
  };
  /** 一覧のコンテナにフォーカスしてキーを押す */
  const press = async (keys: string) => {
    utils.container.querySelector<HTMLElement>(".file-list")?.focus();
    await user.keyboard(keys);
  };

  return {
    ...utils,
    backend,
    user,
    queryClient,
    confirmSpy,
    clipboardText,
    onPathChange,
    rows,
    names,
    row,
    press,
    within,
  };
}
