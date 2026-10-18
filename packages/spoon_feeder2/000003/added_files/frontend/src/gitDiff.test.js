/**
 * Git差分取得・コピー補助機能のテスト (gitDiff.test.jsx)
 * 
 * 仕様:
 * 1. resolveGitDiffCommand:
 *    - 未指定または空白文字列の場合はデフォルトコマンド 'git diff HEAD -- *.py' を返す。
 *    - カスタムコマンドが指定されている場合は前後の空白をトリムして返す。
 * 2. formatGitDiffMessage:
 *    - 差分テキストが存在する場合、行数を含めた完了メッセージを返す。
 *    - 差分テキストが空または空白のみの場合、差分なしの通知メッセージを返す。
 **/

import { describe, expect, it } from 'vitest';
import { formatGitDiffMessage, resolveGitDiffCommand } from './gitDiff';

describe('resolveGitDiffCommand', () => {
  it('未指定または空文字・空白のみの場合はデフォルトのPython差分コマンドを返す', () => {
    expect(resolveGitDiffCommand()).toBe('git diff HEAD -- *.py');
    expect(resolveGitDiffCommand('')).toBe('git diff HEAD -- *.py');
    expect(resolveGitDiffCommand('   ')).toBe('git diff HEAD -- *.py');
    expect(resolveGitDiffCommand(null)).toBe('git diff HEAD -- *.py');
    expect(resolveGitDiffCommand(undefined)).toBe('git diff HEAD -- *.py');
  });

  it('有効なカスタムコマンドが指定された場合は前後の空白をトリムして返す', () => {
    expect(resolveGitDiffCommand('git diff HEAD')).toBe('git diff HEAD');
    expect(resolveGitDiffCommand('  git diff --staged  ')).toBe('git diff --staged');
    expect(resolveGitDiffCommand('git diff HEAD~1 -- src/')).toBe('git diff HEAD~1 -- src/');
  });
});

describe('formatGitDiffMessage', () => {
  it('差分が存在する場合、行数を含めたメッセージを返す', () => {
    const sampleDiff = 'diff --git a/main.py b/main.py\n--- a/main.py\n+++ b/main.py\n@@ -1 +1 @@\n-hello\n+world';
    expect(formatGitDiffMessage(sampleDiff)).toBe('Git差分（6行）をクリップボードにコピーしました。');
  });

  it('差分が空または空白のみの場合、差分なしのメッセージを返す', () => {
    expect(formatGitDiffMessage('')).toBe('Git差分はありませんでした（クリップボードを空にしました）。');
    expect(formatGitDiffMessage('   \n  \n')).toBe('Git差分はありませんでした（クリップボードを空にしました）。');
    expect(formatGitDiffMessage(null)).toBe('Git差分はありませんでした（クリップボードを空にしました）。');
  });
});
