/**
 * 画面操作テスト用の偽バックエンド
 * - メモリ上のファイルツリーを持ち、globalThis.fetch を差し替えて /api/* に応答する
 * - 一覧・パス判定・削除・移動・コピー・作成・リネーム・件数・履歴・設定に対応
 * - 実際のバックエンドと同じく、同名衝突は「同名のファイルが存在します」エラーにし、何も変更しない
 * - calls に受け取ったリクエストを記録し、テストから検証できる
 */
import type { BatchItemResult, FileItem } from "../types/file";

export interface FakeEntry {
  type: "file" | "directory";
  size?: number;
  modified?: string;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

const CONFLICT = "同名のファイルが存在します";

function parent(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class FakeBackend {
  entries = new Map<string, FakeEntry>();
  calls: RecordedCall[] = [];
  /** /api/git-folder-statuses が返す各フォルダの状態（パス → ahead / behind / 変更ファイル） */
  gitStatuses: Record<string, { ahead: number; behind: number; changed: string[] }> = {};
  /** /api/folder-latest-modified が返す最新更新日時（パス → ISO 文字列） */
  latestModified: Record<string, string> = {};

  constructor(tree: Record<string, FakeEntry | "dir" | string>) {
    this.entries.set("/", { type: "directory" });
    for (const [path, value] of Object.entries(tree)) {
      this.add(path, value === "dir" ? { type: "directory" } : typeof value === "string"
        ? { type: "file", size: value.length, modified: "2026-01-02T03:04:05" }
        : value);
    }
  }

  add(path: string, entry: FakeEntry): void {
    let current = parent(path);
    while (!this.entries.has(current)) {
      this.entries.set(current, { type: "directory" });
      current = parent(current);
    }
    this.entries.set(path, entry);
  }

  exists(path: string): boolean {
    return this.entries.has(path);
  }

  children(dir: string): FileItem[] {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    return [...this.entries.entries()]
      .filter(([p]) => p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map(([p, e]) => ({ name: baseName(p), path: p, type: e.type, size: e.size, modified: e.modified }));
  }

  callsTo(path: string): RecordedCall[] {
    return this.calls.filter((c) => c.path === path);
  }

  private removeTree(path: string): void {
    for (const p of [...this.entries.keys()]) {
      if (p === path || p.startsWith(`${path}/`)) this.entries.delete(p);
    }
  }

  private copyTree(src: string, dest: string): void {
    for (const [p, e] of [...this.entries.entries()]) {
      if (p === src || p.startsWith(`${src}/`)) this.entries.set(dest + p.slice(src.length), { ...e });
    }
  }

  private transfer(body: { src_paths: string[]; dest_path: string; overwrite?: boolean }, mode: "move" | "copy") {
    const results: BatchItemResult[] = body.src_paths.map((src) => {
      const dest = `${body.dest_path === "/" ? "" : body.dest_path}/${baseName(src)}`;
      if (!this.exists(src)) return { path: src, dest, status: "error", message: "ファイルが見つかりません" };
      if (src === dest) {
        return mode === "move"
          ? { path: src, dest, status: "skipped", message: "移動元と移動先が同じです" }
          : { path: src, dest, status: "error", message: "同一ファイルへのコピーはできません" };
      }
      if (this.exists(dest) && !body.overwrite) return { path: src, dest, status: "error", message: CONFLICT };
      if (this.exists(dest)) this.removeTree(dest);
      this.copyTree(src, dest);
      if (mode === "move") this.removeTree(src);
      return { path: src, dest, status: "success", message: mode === "move" ? "移動完了" : "コピー完了" };
    });
    return {
      status: "completed",
      success_count: results.filter((r) => r.status === "success").length,
      fail_count: results.filter((r) => r.status === "error").length,
      results,
    };
  }

  /** globalThis.fetch の代わりに使う */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const query = Object.fromEntries(url.searchParams.entries());
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    } else if (init?.body instanceof FormData) {
      const form = init.body;
      body = {
        files: form.getAll("files").map((f) => (f as File).name),
        relative_paths: form.getAll("relative_paths"),
        empty_directories: form.getAll("empty_directories"),
      };
    }
    this.calls.push({ method, path: url.pathname, query, body });
    const b = body as Record<string, unknown>;

    switch (`${method} ${url.pathname}`) {
      case "GET /api/config":
        return json({ defaultBasePath: "/root", isWindows: false, textFileOpenMode: "web", markdownOpenMode: "web", apiTimeout: 10, pathMappings: {} });
      case "GET /api/history":
        return json([]);
      case "POST /api/history":
        return json({ status: "success" });
      case "GET /api/path-info": {
        const p = query.path;
        const entry = this.entries.get(p);
        if (!entry) return json({ path: p, type: "not_found" });
        return json(entry.type === "directory" ? { path: p, type: "directory" } : { path: p, type: "file", parent: parent(p) });
      }
      case "GET /api/files": {
        const p = query.path;
        const entry = this.entries.get(p);
        if (!entry) return json({ detail: "パスが見つかりません" }, 404);
        const dir = entry.type === "file" ? parent(p) : p;
        return json({ type: "directory", path: dir, items: this.children(dir) });
      }
      case "POST /api/delete/batch": {
        const results = (b.paths as string[]).map((p) => {
          if (!this.exists(p)) return { path: p, status: "error", message: "ファイルが見つかりません" };
          this.removeTree(p);
          return { path: p, status: "success", message: "ゴミ箱に移動しました" };
        });
        return json({
          status: "completed",
          success_count: results.filter((r) => r.status === "success").length,
          fail_count: results.filter((r) => r.status === "error").length,
          results,
        });
      }
      case "POST /api/move/batch":
        return json(this.transfer(b as never, "move"));
      case "POST /api/copy/batch":
        return json(this.transfer(b as never, "copy"));
      case "POST /api/count-files":
        return json({ total_count: (b.paths as string[]).length, details: [] });
      case "POST /api/create-folder": {
        const p = `${b.path}/${b.name}`;
        if (this.exists(p)) return json({ detail: "同名のファイル/フォルダが既に存在します" }, 400);
        this.add(p, { type: "directory" });
        return json({ status: "success" });
      }
      case "POST /api/create-file": {
        const p = `${b.path}/${b.name}`;
        if (this.exists(p)) return json({ detail: "同名のファイル/フォルダが既に存在します" }, 400);
        this.add(p, { type: "file", size: String(b.content ?? "").length, modified: "2026-01-02T03:04:05" });
        return json({ status: "success", message: "作成しました", path: p });
      }
      case "POST /api/rename": {
        const oldPath = b.old_path as string;
        const newPath = `${parent(oldPath)}/${b.new_name}`;
        if (this.exists(newPath)) return json({ detail: "同名のファイル/フォルダが既に存在します" }, 400);
        this.copyTree(oldPath, newPath);
        this.removeTree(oldPath);
        return json({ status: "success" });
      }
      case "POST /api/git-folder-statuses":
        return json({
          items: (b.paths as string[])
            .filter((p) => this.gitStatuses[p])
            .map((p) => ({
              path: p,
              changed_files: this.gitStatuses[p].changed,
              has_more_changes: false,
              ahead_count: this.gitStatuses[p].ahead,
              behind_count: this.gitStatuses[p].behind,
            })),
        });
      case "POST /api/folder-latest-modified":
        return json({ modified: this.latestModified[b.path as string] ?? null, truncated: false });
      case "POST /api/open/smart": {
        // 実際の判定（routers/launcher.py）を簡略化したもの
        const target = b.path as string;
        const name = baseName(target);
        if (/\.(md|txt|py)$/.test(name)) {
          return json({
            action: "open_modal",
            editor_mode: name.endsWith(".md") ? "markdown" : "code",
            content: `content of ${name}`,
            language: name.endsWith(".py") ? "python" : "plaintext",
          });
        }
        if (name.endsWith(".ipynb")) return json({ action: "open_url", url: `http://localhost:8888/lab/tree${target}` });
        return json({ action: "open_external", message: "既定のアプリで開きました" });
      }
      case "POST /api/upload": {
        const upload = b as { files: string[]; relative_paths: string[] };
        const names = upload.relative_paths.length > 0 ? upload.relative_paths : upload.files;
        names.forEach((name) => this.add(`${query.path}/${name}`, { type: "file", size: 0, modified: "2026-01-02T03:04:05" }));
        return json({ status: "success", message: `${names.length}件アップロードしました`, uploaded: names });
      }
      default:
        return json({ status: "success" });
    }
  };
}
