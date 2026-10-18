/**
 * DOM操作に関するユーティリティ
 */

/**
 * イベントの対象が文字入力に使われる要素（input / textarea / select / contenteditable）か判定する。
 * グローバルなキーボードショートカットが、入力中のキー操作を奪わないために使う。
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true
  }
  const editable = target.closest('[contenteditable]')
  return editable !== null && editable.getAttribute('contenteditable') !== 'false'
}
