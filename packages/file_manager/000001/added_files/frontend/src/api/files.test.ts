/**
 * ファイルAPIクライアントのURL生成テスト
 * ダウンロードURL・全文検索URL・PDF表示URLのエンコードを確認する
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAppPathUrl, buildFullPathUrl, getDownloadUrl, getFolderGitStatuses, getFolderLatestModified, getFullTextSearchUrl, getHtmlViewUrl, getPdfViewUrl } from "./files";

describe("file api url builders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds download url with encoded path", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:5173",
      },
    });

    expect(getDownloadUrl("/Users/mine/My File.pdf")).toBe(
      "http://localhost:5173/api/download?path=%2FUsers%2Fmine%2FMy+File.pdf"
    );
  });

  it("builds full text search url with encoded path", () => {
    expect(getFullTextSearchUrl("/Users/mine/Documents/確定申告 2025")).toBe(
      "http://127.0.0.1:8079/?full_path=%2FUsers%2Fmine%2FDocuments%2F%E7%A2%BA%E5%AE%9A%E7%94%B3%E5%91%8A+2025"
    );
  });

  it("builds full text search url without a leading slash for Windows drive paths", () => {
    expect(getFullTextSearchUrl("/C:/Users/mine/Documents/report.docx")).toBe(
      "http://127.0.0.1:8079/?full_path=C%3A%2FUsers%2Fmine%2FDocuments%2Freport.docx"
    );
  });

  it("builds pdf view url with encoded path", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:5173",
      },
    });

    expect(getPdfViewUrl("/Users/mine/Documents/資料.pdf")).toBe(
      "http://localhost:5173/api/view-pdf?path=%2FUsers%2Fmine%2FDocuments%2F%E8%B3%87%E6%96%99.pdf"
    );
  });

  it("builds html view url with encoded path", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:5173",
      },
    });

    expect(getHtmlViewUrl("/Users/mine/Documents/index.html")).toBe(
      "http://localhost:5173/api/view-html?path=%2FUsers%2Fmine%2FDocuments%2Findex.html"
    );
  });

  it("builds fullpath url with editor preferences", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:5173",
      },
    });

    expect(
      buildFullPathUrl("/Users/mine/Documents/note.md", {
        textFileOpenMode: "web",
        markdownOpenMode: "external",
      })
    ).toBe(
      "http://localhost:5173/api/fullpath?path=%2FUsers%2Fmine%2FDocuments%2Fnote.md&text_mode=web&markdown_mode=external"
    );
  });

  it("builds app path url for directories in the web app", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:8001",
      },
    });

    expect(buildAppPathUrl("/Users/mine/000_work/temp/image_diff")).toBe(
      "http://localhost:8001/?path=%2FUsers%2Fmine%2F000_work%2Ftemp%2Fimage_diff"
    );
  });

  it("requests a folder's recursive latest modified timestamp", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        path: "/Users/mine/Documents",
        modified: "2026-07-23T10:00:00",
        scanned_entries: 4,
        truncated: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getFolderLatestModified("/Users/mine/Documents")).resolves.toMatchObject({
      scanned_entries: 4,
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/folder-latest-modified", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ path: "/Users/mine/Documents" }),
    }));
  });

  it("requests Git statuses for all folders in a pane", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{
        path: "/Users/mine/repo",
        has_changes: true,
        changed_files: ["src/App.tsx"],
        has_more_changes: false,
        ahead_count: 1,
        behind_count: 0,
      }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getFolderGitStatuses(["/Users/mine/repo"])).resolves.toEqual([
      {
        path: "/Users/mine/repo",
        has_changes: true,
        changed_files: ["src/App.tsx"],
        has_more_changes: false,
        ahead_count: 1,
        behind_count: 0,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/git-folder-statuses", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ paths: ["/Users/mine/repo"] }),
    }));
  });

  it("sends files, relative_paths, and empty_directories via FormData in uploadFiles", async () => {
    let capturedBody: FormData | null = null;
    let capturedUrl: string | null = null;

    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:5173",
      },
    });

    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init.body as FormData;
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: "success", message: "uploaded" }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { uploadFiles } = await import("./files");
    const mockFile = new File(["test"], "sub.txt", { type: "text/plain" });

    await uploadFiles(
      "/target/dir",
      [{ file: mockFile, relativePath: "folder/sub.txt" }],
      ["empty_dir"]
    );

    expect(capturedUrl).toContain("/api/upload?path=%2Ftarget%2Fdir");
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.getAll("files")).toHaveLength(1);
    expect(capturedBody!.getAll("relative_paths")).toEqual(["folder/sub.txt"]);
    expect(capturedBody!.getAll("empty_directories")).toEqual(["empty_dir"]);
  });
});
