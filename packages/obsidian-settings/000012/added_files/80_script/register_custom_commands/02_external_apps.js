// =============================================================================
// 外部アプリ連携（Excalidraw Webアプリ、フォルダを開く、VS Code、差分表示）
// =============================================================================

const getEncodedExcalidrawUrl = (file) => {
    const basePath = app.vault.adapter.basePath || "";
    const fullPath = `${basePath}/${file.path}`.replace(/\\/g, "/");
    const encodedPath = fullPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    return `http://localhost:3001/?filepath=${encodedPath}`;
};

// 通常の .md ファイルでも、Excalidraw の裏面データを持つファイルを判定する。
// Excalidraw プラグインの判定を優先し、メタデータキャッシュがまだ更新されていない場合は
// フロントマターを直接確認する。
const isExcalidrawBackedMarkdown = (file) => {
    if (!file || file.extension !== "md") return false;

    if (file.name.toLowerCase().endsWith(".excalidraw.md")) return true;

    const excalidrawPlugin = app.plugins?.plugins?.["obsidian-excalidraw-plugin"];
    try {
        if (typeof excalidrawPlugin?.isExcalidrawFile === "function" && excalidrawPlugin.isExcalidrawFile(file)) {
            return true;
        }
    } catch (error) {
        console.warn("Failed to detect Excalidraw-backed Markdown:", error);
    }

    const frontmatter = app.metadataCache?.getFileCache?.(file)?.frontmatter;
    return Boolean(frontmatter && Object.prototype.hasOwnProperty.call(frontmatter, "excalidraw-plugin"));
};

const toFileUrl = (absolutePath) => {
    let normalized = absolutePath.replace(/\\/g, "/");
    if (!normalized.startsWith("/")) {
        normalized = "/" + normalized;
    }
    return `file://${normalized}`;
};

const IMAGE_DIFF_API_BASE_URL = "http://127.0.0.1:8078/api";
const IMAGE_DIFF_APP_BASE_URL = "http://127.0.0.1:8078/";
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "tif", "tiff"]);

const getAbsoluteVaultPath = (file) => {
    const basePath = app.vault?.adapter?.basePath || "";
    return `${basePath}/${file?.path || ""}`.replace(/\\/g, "/").replace(/\/+/g, "/");
};

/**
 * コマンド実行ヘルパー関数
 * @param {string} command - 実行するコマンド
 * @param {string[]} args - 引数配列
 * @returns {Promise<boolean>} 成功時true、失敗時false
 **/
const runShellCommand = (command, args) => new Promise((resolve) => {
    try {
        let req;
        try { req = require; } catch (e) { req = window.require; }
        if (!req) return resolve(false);
        const { execFile } = req("child_process");
        execFile(command, args, (error) => resolve(!error));
    } catch (e) {
        resolve(false);
    }
});

/**
 * 対象ファイルが所在する親フォルダをOSのファイルマネージャー（Finder / エクスプローラー）で開く
 * @param {TFile} file - 対象ファイル（省略時はアクティブファイル）
 **/
const openContainingFolder = async (file) => {
    const targetFile = file || app.workspace?.getActiveFile?.();
    if (!targetFile) {
        new Notice("対象のファイルが見つかりません");
        return;
    }

    try {
        const basePath = app.vault?.adapter?.basePath || "";
        const folderRelativePath = targetFile.parent ? targetFile.parent.path : "";
        const folderFullPath = folderRelativePath
            ? `${basePath}/${folderRelativePath}`.replace(/\\/g, "/").replace(/\/+/g, "/")
            : basePath.replace(/\\/g, "/");

        let opened = false;

        // 1. Electron shell.openPath でフォルダそのものを開く
        let electron;
        try { electron = require("electron"); } catch (e) {
            try { electron = window.require ? window.require("electron") : null; } catch (err) {}
        }
        if (electron?.shell?.openPath && folderFullPath) {
            const err = await electron.shell.openPath(folderFullPath);
            if (!err) opened = true;
        }

        // 2. child_process (open / explorer / xdg-open)
        if (!opened && folderFullPath) {
            try {
                let req;
                try { req = require; } catch (e) { req = window.require; }
                if (req) {
                    const { execFile } = req("child_process");
                    const platform = typeof process !== "undefined" ? process.platform : "";
                    if (platform === "darwin") {
                        execFile("open", [folderFullPath], (error) => {
                            if (!error) opened = true;
                        });
                        opened = true;
                    } else if (platform === "win32") {
                        execFile("explorer", [folderFullPath.replace(/\//g, "\\")], (error) => {
                            if (!error) opened = true;
                        });
                        opened = true;
                    } else if (platform === "linux") {
                        execFile("xdg-open", [folderFullPath], (error) => {
                            if (!error) opened = true;
                        });
                        opened = true;
                    }
                }
            } catch (e) {}
        }

        // 3. Obsidian標準 app.showInFolder でフォールバック
        if (!opened && typeof app.showInFolder === "function") {
            app.showInFolder(targetFile.path);
            opened = true;
        }

        if (opened) {
            new Notice("フォルダを開きました");
        } else {
            new Notice("フォルダを開けませんでした");
        }
    } catch (error) {
        console.error("Failed to open folder:", error);
        new Notice(`フォルダを開けませんでした: ${error?.message || error}`);
    }
};

/**
 * 対象ファイルをVS Codeで開く
 * @param {TFile} file - 対象ファイル（省略時はアクティブファイル）
 **/
const openInVsCode = async (file) => {
    const targetFile = file || app.workspace?.getActiveFile?.();
    if (!targetFile) {
        new Notice("対象のファイルが見つかりません");
        return;
    }

    try {
        let req;
        try { req = require; } catch (e) { req = window.require; }
        const fs = req ? (() => { try { return req("fs"); } catch (e) { return null; } })() : null;
        const path = req ? (() => { try { return req("path"); } catch (e) { return null; } })() : null;
        const platform = typeof process !== "undefined" ? process.platform : "";
        const fileFullPath = getAbsoluteVaultPath(targetFile);

        if (!fileFullPath) {
            new Notice("ファイルパスを取得できませんでした");
            return;
        }

        let opened = false;

        // 1. Sidebar Explorer 設定で指定されたVS Code実行パスを優先
        const sidebarPlugin = app.plugins?.plugins?.["obsidian-sidebar-explorer"];
        const configuredVscodePath = sidebarPlugin?.settings?.vscodeExecutablePath?.trim();
        if (configuredVscodePath && fs && fs.existsSync(configuredVscodePath)) {
            opened = await runShellCommand(configuredVscodePath, [fileFullPath]);
        }

        // 2. プラットフォーム別起動
        if (!opened && platform === "darwin") {
            // Mac: open -a "Visual Studio Code"
            opened = await runShellCommand("open", ["-a", "Visual Studio Code", fileFullPath]);
            if (!opened) {
                opened = await runShellCommand("open", ["-b", "com.microsoft.VSCode", fileFullPath]);
            }
            if (!opened && fs) {
                const macCodeCli = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
                if (fs.existsSync(macCodeCli)) {
                    opened = await runShellCommand(macCodeCli, [fileFullPath]);
                }
            }
            if (!opened) {
                opened = await runShellCommand("code", [fileFullPath]);
            }
        } else if (!opened && platform === "win32") {
            // Windows: 定番パスおよび code コマンド
            const env = typeof process !== "undefined" ? process.env || {} : {};
            if (path && fs) {
                const codeCandidates = [
                    path.join(env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
                    path.join(env.ProgramFiles || "", "Microsoft VS Code", "Code.exe"),
                    path.join(env["ProgramFiles(x86)"] || "", "Microsoft VS Code", "Code.exe"),
                    path.join(env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "bin", "code.cmd"),
                ].filter((cand) => fs.existsSync(cand));

                if (codeCandidates.length > 0) {
                    opened = await runShellCommand(codeCandidates[0], [fileFullPath]);
                }
            }
            if (!opened) {
                opened = await runShellCommand("code", [fileFullPath]);
            }
        } else if (!opened && platform === "linux") {
            // Linux: code コマンド
            opened = await runShellCommand("code", [fileFullPath]);
        }

        // 3. 最終フォールバック: vscode:// カスタムURLスキーム
        if (!opened) {
            const vscodeUrl = `vscode://file/${encodeURI(fileFullPath)}`;
            try {
                let electron;
                try { electron = req("electron"); } catch (e) {
                    try { electron = window.require ? window.require("electron") : null; } catch (err) {}
                }
                if (electron?.shell?.openExternal) {
                    await electron.shell.openExternal(vscodeUrl);
                    opened = true;
                } else if (typeof window !== "undefined" && window.open) {
                    window.open(vscodeUrl, "_blank");
                    opened = true;
                }
            } catch (urlErr) {
                console.warn("Failed to open via vscode:// URL:", urlErr);
            }
        }

        if (opened) {
            new Notice("VS Codeで開きました");
        } else {
            new Notice("VS Codeを起動できませんでした");
        }
    } catch (error) {
        console.error("Failed to open in VS Code:", error);
        new Notice(`VS Codeで開けませんでした: ${error?.message || error}`);
    }
};

const openMarkdownDiff = async (file) => {
    if (!file?.path || file.extension !== "md" || file.name.endsWith(".excalidraw.md")) return;
    try {
        const markdownPath = getAbsoluteVaultPath(file);
        let response = await fetch(`${IMAGE_DIFF_API_BASE_URL}/git/markdown`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ markdown_path: markdownPath }),
        });
        // 旧BackendがGET版だけを公開している場合も、ノートから起動できるようにする。
        if (response.status === 405) {
            response = await fetch(`${IMAGE_DIFF_API_BASE_URL}/git/markdown?path=${encodeURIComponent(markdownPath)}`);
        }
        if (!response.ok) {
            throw new Error(await getApiErrorMessage(response));
        }
        const body = await response.json();
        const diffUrl = body.diff_url || `${IMAGE_DIFF_APP_BASE_URL}?markdown_path=${encodeURIComponent(markdownPath)}`;
        window.open(diffUrl, "_blank");
    } catch (error) {
        console.error("Failed to open Markdown diff:", error);
        new Notice(`差分表示を開けませんでした: ${error.message}`);
    }
};

const isImageFile = (file) => file?.extension && IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
const isDrawioEditableFile = (file) => {
    const name = file?.name?.toLowerCase() || "";
    return name.endsWith(".drawio.svg") || name.endsWith(".dio.svg") || name.endsWith(".drawio");
};
