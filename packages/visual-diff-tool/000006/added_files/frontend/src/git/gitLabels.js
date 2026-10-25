/**
 * Git変更種別の表示名。
 */

export function changeTypeLabel(type) {
  return ({ modified: "変更", added: "追加", deleted: "削除", untracked: "未追跡", renamed: "名前変更", copied: "コピー" })[type] ?? type;
}
