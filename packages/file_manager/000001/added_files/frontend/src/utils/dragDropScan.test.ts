/**
 * ドラッグ＆ドロップされたファイル・フォルダの再帰スキャン機能のテスト
 */
import { describe, expect, it } from "vitest";
import { scanDataTransferItems } from "./dragDropScan";

describe("scanDataTransferItems", () => {
  it("extracts plain files when webkitGetAsEntry is not available or items is empty", async () => {
    const mockFile1 = new File(["test1"], "file1.txt", { type: "text/plain" });
    const mockFile2 = new File(["test2"], "file2.txt", { type: "text/plain" });

    const mockDataTransfer = {
      items: [],
      files: [mockFile1, mockFile2],
    } as unknown as DataTransfer;

    const result = await scanDataTransferItems(mockDataTransfer);

    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toEqual({ file: mockFile1, relativePath: "file1.txt" });
    expect(result.files[1]).toEqual({ file: mockFile2, relativePath: "file2.txt" });
    expect(result.emptyDirectories).toHaveLength(0);
  });

  it("extracts directory hierarchy with relative paths using webkitGetAsEntry", async () => {
    const mockSubFile = new File(["sub"], "sub.txt", { type: "text/plain" });

    // File entry
    const fileEntry = {
      isFile: true,
      isDirectory: false,
      name: "sub.txt",
      file: (callback: (f: File) => void) => callback(mockSubFile),
    };

    // Directory entry containing fileEntry
    let readCount = 0;
    const dirEntry = {
      isFile: false,
      isDirectory: true,
      name: "my_folder",
      createReader: () => ({
        readEntries: (callback: (entries: any[]) => void) => {
          if (readCount === 0) {
            readCount++;
            callback([fileEntry]);
          } else {
            callback([]); // 読み込み完了
          }
        },
      }),
    };

    const mockDataTransfer = {
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () => dirEntry,
          getAsFile: () => null,
        },
      ],
      files: [],
    } as unknown as DataTransfer;

    const result = await scanDataTransferItems(mockDataTransfer);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].relativePath).toBe("my_folder/sub.txt");
    expect(result.files[0].file).toBe(mockSubFile);
    expect(result.emptyDirectories).toHaveLength(0);
  });

  it("identifies empty directories", async () => {
    // Empty directory entry
    const emptyDirEntry = {
      isFile: false,
      isDirectory: true,
      name: "empty_dir",
      createReader: () => ({
        readEntries: (callback: (entries: any[]) => void) => {
          callback([]); // 空
        },
      }),
    };

    const mockDataTransfer = {
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () => emptyDirEntry,
          getAsFile: () => null,
        },
      ],
      files: [],
    } as unknown as DataTransfer;

    const result = await scanDataTransferItems(mockDataTransfer);

    expect(result.files).toHaveLength(0);
    expect(result.emptyDirectories).toEqual(["empty_dir"]);
  });
});
