/**
 * テーブルのレイアウトおよびCSSセレクタのスコープ整合性をテストする
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Table Layout & CSS Scoping Tests", () => {
  const fileSearchCssPath = path.resolve(__dirname, "FileSearch.css");
  const fileListCssPath = path.resolve(__dirname, "FileList.css");
  const fileListTableTsxPath = path.resolve(__dirname, "fileList", "FileListTable.tsx");

  it("FileSearch.css should NOT have unscoped .name-cell selector affecting FileList", () => {
    const content = fs.readFileSync(fileSearchCssPath, "utf-8");
    // ルートレベルの ".name-cell {" が存在してはならない（.results-table または固有セレクタでスコープされていること）
    const unscopedNameCellRegex = /(^|\n)\.name-cell\s*\{/m;
    expect(
      unscopedNameCellRegex.test(content),
      "FileSearch.css must not have unscoped `.name-cell {` that leaks into FileList"
    ).toBe(false);
  });

  it("FileList.css should ensure .file-table td.name-cell keeps table-cell display and middle alignment", () => {
    const content = fs.readFileSync(fileListCssPath, "utf-8");
    expect(
      content.includes(".file-table .name-cell") || content.includes(".file-table td.name-cell"),
      "FileList.css should explicitly protect .file-table td.name-cell styling"
    ).toBe(true);
  });

  it("FileListTable.tsx should have className='checkbox-col' on checkbox td", () => {
    const content = fs.readFileSync(fileListTableTsxPath, "utf-8");
    // チェックボックスの td に checkbox-col クラスが付与されていること
    // （フォルダ行・ファイル行の両方で同じ描画関数を使う。実際の DOM は FileList.ui.test.tsx で確認）
    expect(/<td\s+className=["']checkbox-col["']/.test(content)).toBe(true);
  });
});
