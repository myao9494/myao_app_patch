/**
 * Git差分取得・コピー補助機能 (gitDiff.js)
 * 
 * 仕様:
 * 1. DEFAULT_GIT_DIFF_COMMAND:
 *    - デフォルトの差分コマンド 'git diff HEAD -- *.py' を定義。
 * 2. resolveGitDiffCommand:
 *    - コマンド文字列を受け取り、未指定や空文字・空白のみの場合は DEFAULT_GIT_DIFF_COMMAND を返却。
 *    - カスタムコマンドが指定されている場合は前後の空白をトリムして返却。
 * 3. formatGitDiffMessage:
 *    - 差分テキストを受け取り、差分が存在する場合は行数を算出して通知メッセージを作成。
 *    - 差分が空または空白のみの場合は差分なしの通知メッセージを返却。
 **/

export const DEFAULT_GIT_DIFF_COMMAND = 'git diff HEAD -- *.py';

export function resolveGitDiffCommand(command) {
  if (typeof command !== 'string') return DEFAULT_GIT_DIFF_COMMAND;
  const trimmed = command.trim();
  return trimmed ? trimmed : DEFAULT_GIT_DIFF_COMMAND;
}

export function formatGitDiffMessage(diff) {
  if (!diff || !diff.trim()) {
    return 'Git差分はありませんでした（クリップボードを空にしました）。';
  }
  const lineCount = diff.trim().split(/\r?\n/).length;
  return `Git差分（${lineCount}行）をクリップボードにコピーしました。`;
}
