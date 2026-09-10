/**
 * パス操作ユーティリティ（quickアプリ用）
 * - 相対パスの解決（resolvePath）
 * - 絶対パス判定（isAbsolutePath）
 * - パスのサニタイズ（sanitizePath）
 */

export function sanitizePath(path: string): string {
  if (!path) return "";
  let cleanPath = path.trim();
  if (cleanPath.startsWith('"') && cleanPath.endsWith('"')) {
    cleanPath = cleanPath.slice(1, -1);
  }
  cleanPath = cleanPath.replace(/\\/g, "/");
  return cleanPath.trim();
}

export function isAbsolutePath(path: string): boolean {
  if (!path) return false;
  const clean = sanitizePath(path);
  return (
    clean.startsWith("/") ||
    clean.startsWith("//") ||
    /^[a-zA-Z]:/.test(clean)
  );
}

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
    if (seg === ".") continue;
    if (seg === "..") {
      if (segments.length > 0) segments.pop();
    } else {
      segments.push(seg);
    }
  }

  const combined = segments.join("/");
  if (prefix === "//") return "//" + combined;
  if (prefix === "/") return "/" + combined;
  if (prefix) return prefix + "/" + combined;
  return combined;
}

export function getParentDir(filePath: string): string {
  const clean = sanitizePath(filePath);
  const lastSlash = clean.lastIndexOf("/");
  if (lastSlash <= 0) return "";
  return clean.slice(0, lastSlash);
}
