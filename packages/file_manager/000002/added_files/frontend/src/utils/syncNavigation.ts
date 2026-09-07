/**
 * 左右ペイン同期移動ユーティリティ
 * - 左右ペインのフォルダ移動を連動させるパス計算
 * - 親フォルダへの移動同期 (getParentFolderPath)
 * - 直下サブフォルダ名の抽出 (getSubfolderName)
 * - 同期先パスの解決 (resolveSyncedPath)
 */

/**
 * 指定されたパスの親フォルダパスを返す
 */
export function getParentFolderPath(pathStr: string): string | null {
  if (!pathStr) return null;

  const isWindows = pathStr.includes("\\") || /^[a-zA-Z]:/.test(pathStr);

  // 末尾のセパレータをトリム（ルートドライブ等を除く）
  let normalized = pathStr;
  while (normalized.length > 1 && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
    // Windowsの "C:\" などのルートは維持
    if (/^[a-zA-Z]:[\\/]$/.test(normalized)) {
      return null;
    }
    normalized = normalized.slice(0, -1);
  }

  // ルートディレクトリの場合
  if (normalized === "/" || /^[a-zA-Z]:[\\/]?$/.test(normalized)) {
    return null;
  }

  const lastSepIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSepIndex < 0) {
    return null;
  }

  if (lastSepIndex === 0) {
    return "/";
  }

  // Windows "C:\folder" の場合、lastSepIndexが2なら "C:\"
  if (isWindows && lastSepIndex === 2 && normalized[1] === ":") {
    return normalized.slice(0, 3);
  }

  return normalized.slice(0, lastSepIndex);
}

/**
 * sourceNewPath が sourceOldPath の直下サブフォルダである場合、そのサブフォルダ名を返す
 */
export function getSubfolderName(sourceOldPath: string, sourceNewPath: string): string | null {
  if (!sourceOldPath || !sourceNewPath) return null;

  const normalize = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const oldNorm = normalize(sourceOldPath);
  const newNorm = normalize(sourceNewPath);

  if (!newNorm.startsWith(oldNorm + "/")) {
    return null;
  }

  const relative = newNorm.slice(oldNorm.length + 1);
  // スラッシュが含まれていれば多階層下なので直下ではない
  if (relative.includes("/")) {
    return null;
  }

  return relative;
}

export type SyncReason = "identical" | "subfolder" | "parent" | "not_found" | "unchanged";

export interface SyncedPathResult {
  nextPath: string | null;
  reason: SyncReason;
}

/**
 * ソースペインの移動に伴い、ターゲットペインの同期先パスを計算する
 * @param sourceOldPath 移動前のソースパス
 * @param sourceNewPath 移動後のソースパス
 * @param targetCurrentPath ターゲットペインの現在パス
 * @param targetSubfolders ターゲットペイン内の利用可能なサブフォルダ名一覧（省略可）
 */
export function resolveSyncedPath(
  sourceOldPath: string,
  sourceNewPath: string,
  targetCurrentPath: string,
  targetSubfolders?: string[]
): SyncedPathResult {
  if (sourceOldPath === sourceNewPath) {
    return { nextPath: null, reason: "unchanged" };
  }

  // ケース1: 移動前に左右が完全に同一パスだった場合、移動先も同一にする
  if (sourceOldPath === targetCurrentPath) {
    return { nextPath: sourceNewPath, reason: "identical" };
  }

  // ケース2: 親フォルダへの移動
  const sourceParent = getParentFolderPath(sourceOldPath);
  if (sourceParent !== null && sourceParent === sourceNewPath) {
    const targetParent = getParentFolderPath(targetCurrentPath);
    if (targetParent !== null) {
      return { nextPath: targetParent, reason: "parent" };
    }
  }

  // ケース3: サブフォルダへの移動
  const subName = getSubfolderName(sourceOldPath, sourceNewPath);
  if (subName) {
    const isWindows = targetCurrentPath.includes("\\") || /^[a-zA-Z]:/.test(targetCurrentPath);
    const sep = isWindows ? "\\" : "/";
    const candidatePath = `${targetCurrentPath.replace(/[\\/]+$/, "")}${sep}${subName}`;

    if (targetSubfolders !== undefined) {
      const exists = targetSubfolders.some((f) => f.toLowerCase() === subName.toLowerCase());
      if (exists) {
        return { nextPath: candidatePath, reason: "subfolder" };
      } else {
        return { nextPath: null, reason: "not_found" };
      }
    }

    return { nextPath: candidatePath, reason: "subfolder" };
  }

  return { nextPath: null, reason: "unchanged" };
}
