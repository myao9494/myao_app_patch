/**
 * ペイン背景・テーブルヘッダーの右クリックメニュー表示判定
 * tbody内のファイル/フォルダ行（tbody tr）以外の余白やヘッダーでの右クリック時にtrueを返す
 */
export function shouldShowPaneContextMenu(target: { closest: (selector: string) => any } | null): boolean {
  if (!target) {
    return false;
  }
  return !target.closest("tbody tr");
}
