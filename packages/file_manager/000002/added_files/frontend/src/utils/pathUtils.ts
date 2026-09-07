/**
 * パス操作ユーティリティ
 */

/**
 * パスをサニタイズする
 * - 前後の空白を除去
 * - 前後のダブルクォーテーション(")を除去 (Windowsのエクスプローラーからのコピペ対策)
 * 
 * @param path 入力パス
 * @returns サニタイズされたパス
 */
export function sanitizePath(path: string): string {
    if (!path) return "";

    let cleanPath = path.trim();

    // ダブルクォーテーションで囲まれている場合、それを取り除く
    // "パス" の形式
    if (cleanPath.startsWith('"') && cleanPath.endsWith('"')) {
        cleanPath = cleanPath.slice(1, -1);
    }

    // Windowsパス対策：バックスラッシュをスラッシュに置換
    cleanPath = cleanPath.replace(/\\/g, "/");

    // もう一度トリミング（引用符の中にスペースがあった場合など）
    return cleanPath.trim();
}

/**
 * クリップボードコピー用にパスを整形する
 * - Windows形式のパス（ドライブレター付きなど）の場合、バックスラッシュ区切りにする
 * - 先頭の不要なスラッシュを除去 (/C:/... -> C:\...)
 * 
 * @param path整形前のパス
 * @returns 整形後のパス
 */
export function formatPathForClipboard(path: string): string {
    if (!path) return "";

    let formatted = path;

    // /C:/Users... のような形式の場合、先頭のスラッシュを除去
    if (formatted.match(/^\/[a-zA-Z]:/)) {
        formatted = formatted.substring(1);
    }

    // ドライブレターがある場合、大文字に統一 (c: -> C:)
    if (formatted.match(/^[a-z]:/)) {
        formatted = formatted.charAt(0).toUpperCase() + formatted.slice(1);
    }

    // Windowsパスとみなされる場合（ドライブレターあり、またはUNCパス）
    // バックスラッシュ区切りに変換
    const isWindowsPath = /^[a-zA-Z]:/.test(formatted) || formatted.startsWith("//") || formatted.startsWith("\\\\");

    if (isWindowsPath) {
        return formatted.replace(/\//g, "\\");
    }

    return formatted;
}

/**
 * パスが絶対パスかどうか判定する
 */
export function isAbsolutePath(path: string): boolean {
    if (!path) return false;
    const clean = path.trim();
    if (clean.startsWith("/") || clean.startsWith("\\")) return true;
    if (/^[a-zA-Z]:[/\\]/.test(clean)) return true;
    if (/^(\/\/|\\\\)/.test(clean)) return true;
    return false;
}

/**
 * ファイルパスから親ディレクトリを取得する
 */
export function getParentDirectory(path: string): string {
    if (!path) return "";
    const clean = sanitizePath(path);
    if (!clean) return "";

    const isUnc = clean.startsWith("//");
    const driveMatch = clean.match(/^([a-zA-Z]:)(.*)$/);

    let pathWithoutDrive = clean;
    let prefix = "";

    if (isUnc) {
        prefix = "//";
        pathWithoutDrive = clean.slice(2);
    } else if (driveMatch) {
        prefix = driveMatch[1];
        pathWithoutDrive = driveMatch[2];
    }

    const parts = pathWithoutDrive.split("/").filter(Boolean);
    if (parts.length === 0) {
        return prefix ? prefix : "";
    }

    // 単一の相対ファイル名（例: "aaa.md"）の場合、親ディレクトリはないので ""
    if (!isAbsolutePath(clean) && parts.length <= 1) {
        return "";
    }

    parts.pop();

    if (parts.length === 0) {
        if (prefix) return prefix;
        if (clean.startsWith("/")) return "/";
        return "";
    }

    if (prefix === "//") {
        return "//" + parts.join("/");
    }
    if (prefix) {
        return prefix + "/" + parts.join("/");
    }

    return (clean.startsWith("/") ? "/" : "") + parts.join("/");
}

/**
 * ベースディレクトリと相対パスを結合して正規化された絶対パスを返す
 */
export function resolvePath(baseDir: string, relativePath: string): string {
    if (!baseDir) return relativePath;
    const cleanRelative = sanitizePath(relativePath);
    if (!cleanRelative) return baseDir;
    if (isAbsolutePath(cleanRelative)) {
        return cleanRelative;
    }

    const cleanBase = sanitizePath(baseDir);
    const isUnc = cleanBase.startsWith("//");
    const driveMatch = cleanBase.match(/^([a-zA-Z]:)(.*)$/);

    let prefix = "";
    let baseWithoutPrefix = cleanBase;

    if (isUnc) {
        prefix = "//";
        baseWithoutPrefix = cleanBase.slice(2);
    } else if (driveMatch) {
        prefix = driveMatch[1];
        baseWithoutPrefix = driveMatch[2];
    } else if (cleanBase.startsWith("/")) {
        prefix = "/";
        baseWithoutPrefix = cleanBase.slice(1);
    }

    const segments = baseWithoutPrefix.split("/").filter(Boolean);
    const relSegments = cleanRelative.split("/").filter(Boolean);

    for (const seg of relSegments) {
        if (seg === ".") {
            continue;
        }
        if (seg === "..") {
            if (segments.length > 0) {
                segments.pop();
            }
        } else {
            segments.push(seg);
        }
    }

    const combined = segments.join("/");
    if (prefix === "//") {
        return "//" + combined;
    }
    if (prefix === "/") {
        return "/" + combined;
    }
    if (prefix) {
        return prefix + "/" + combined;
    }
    return combined;
}

