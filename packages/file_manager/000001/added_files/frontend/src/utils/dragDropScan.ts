/**
 * ドラッグ＆ドロップされたファイル・フォルダを再帰走査するユーティリティ
 * ExplorerやFinderからドロップされたフォルダ内のファイルおよび空フォルダを相対パス付きで取得する
 */

export interface ScannedFileItem {
  file: File;
  relativePath: string;
}

export interface ScanResult {
  files: ScannedFileItem[];
  emptyDirectories: string[];
}

/**
 * FileSystemEntry を再帰的に探索し、ファイルリストと空ディレクトリリストを収集する
 */
async function traverseEntry(
  entry: any,
  pathPrefix: string,
  files: ScannedFileItem[],
  emptyDirectories: string[]
): Promise<void> {
  if (!entry) return;

  const currentRelativePath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file(resolve, reject);
    });
    files.push({ file, relativePath: currentRelativePath });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let allChildEntries: any[] = [];

    // readEntriesは小分けにして結果を返す仕様のため、空配列が返るまでループして全て読み取る
    const readBatch = (): Promise<any[]> => {
      return new Promise((resolve, reject) => {
        reader.readEntries((entries: any[]) => {
          resolve(entries);
        }, reject);
      });
    };

    try {
      let batch: any[] = [];
      do {
        batch = await readBatch();
        allChildEntries = allChildEntries.concat(batch);
      } while (batch && batch.length > 0);
    } catch (e) {
      console.error("Directory read error:", e);
    }

    if (allChildEntries.length === 0) {
      emptyDirectories.push(currentRelativePath);
    } else {
      for (const child of allChildEntries) {
        await traverseEntry(child, currentRelativePath, files, emptyDirectories);
      }
    }
  }
}

/**
 * DataTransferからファイルおよびフォルダ（空フォルダ含む）を再帰的にスキャンする
 */
export async function scanDataTransferItems(dataTransfer: DataTransfer): Promise<ScanResult> {
  const files: ScannedFileItem[] = [];
  const emptyDirectories: string[] = [];

  const items = dataTransfer.items;
  const hasItems = items && items.length > 0;

  if (!hasItems) {
    if (dataTransfer.files) {
      for (let i = 0; i < dataTransfer.files.length; i++) {
        const file = dataTransfer.files[i];
        files.push({ file, relativePath: file.name });
      }
    }
    return { files, emptyDirectories };
  }

  // webkitGetAsEntry をサポートしているか確認
  const entries: any[] = [];
  let hasAnyEntry = false;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file") {
      const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      if (entry) {
        hasAnyEntry = true;
        entries.push(entry);
      } else {
        const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
        if (file) {
          files.push({ file, relativePath: file.name });
        }
      }
    }
  }

  if (hasAnyEntry) {
    for (const entry of entries) {
      await traverseEntry(entry, "", files, emptyDirectories);
    }
  } else if (files.length === 0 && dataTransfer.files && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i];
      files.push({ file, relativePath: file.name });
    }
  }

  return { files, emptyDirectories };
}
