/**
 * ヘッダーツールバーの左右矢印キーによるフォーカス移動。
 * ツールバー（.toolbar）内のフォーカス可能な要素を DOM の並び順にたどる。
 * DHTMLX Gantt がキー入力を横取りしないよう、ハンドラは必ず stopPropagation する。
 */
import type { KeyboardEvent } from 'react';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]):not([type="file"]), select:not([disabled])';

function findFocusableElements(): HTMLElement[] {
  const toolbar = document.querySelector('.toolbar');
  if (!toolbar) return [];
  return Array.from(toolbar.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** ツールバー内で、現在の要素の前後どちらかの要素へフォーカスを移す（端なら何もしない） */
function focusNeighbor(current: HTMLElement, step: 1 | -1): void {
  const elements = findFocusableElements();
  const index = elements.indexOf(current);
  const target = index === -1 ? undefined : elements[index + step];
  target?.focus();
}

export function focusNextElement(current: HTMLElement): void {
  focusNeighbor(current, 1);
}

export function focusPrevElement(current: HTMLElement): void {
  focusNeighbor(current, -1);
}

/** ボタン用: 左右キーで隣の要素へ */
export function handleButtonArrowKeys(event: KeyboardEvent<HTMLButtonElement>): void {
  event.stopPropagation();
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    focusNextElement(event.currentTarget);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    focusPrevElement(event.currentTarget);
  }
}

/** テキスト入力用: カーソルが末尾/先頭にあるときだけ、左右キーで隣の要素へ */
export function handleInputArrowKeys(event: KeyboardEvent<HTMLInputElement>): void {
  event.stopPropagation();
  const input = event.currentTarget;
  if (event.key === 'ArrowRight' && input.selectionStart === input.value.length) {
    event.preventDefault();
    focusNextElement(input);
  } else if (event.key === 'ArrowLeft' && input.selectionStart === 0) {
    event.preventDefault();
    focusPrevElement(input);
  }
}

/** select 用: 上下キーは選択肢の切り替えに使われるので、左右キーだけ処理する */
export function handleSelectArrowKeys(event: KeyboardEvent<HTMLSelectElement>): void {
  if (event.key === 'ArrowRight') {
    event.stopPropagation();
    event.preventDefault();
    focusNextElement(event.currentTarget);
  } else if (event.key === 'ArrowLeft') {
    event.stopPropagation();
    event.preventDefault();
    focusPrevElement(event.currentTarget);
  }
}

/**
 * 兄弟要素を指定方向にたどり、最初に pick で見つかったフォーカス先へ移す。
 * 区切り（span や divider）を飛ばして、隣のボタン・入力欄へ移るために使う。
 */
export function focusSiblingMatching(
  from: HTMLElement,
  direction: 'next' | 'prev',
  pick: (sibling: HTMLElement) => HTMLElement | null,
): boolean {
  let sibling = direction === 'next' ? from.nextElementSibling : from.previousElementSibling;
  while (sibling) {
    const target = pick(sibling as HTMLElement);
    if (target) {
      target.focus();
      return true;
    }
    sibling = direction === 'next' ? sibling.nextElementSibling : sibling.previousElementSibling;
  }
  return false;
}

/** その要素が input ならフォーカス先にする */
export const pickInput = (element: HTMLElement) => (element.tagName === 'INPUT' ? element : null);

/** その要素が button、または btn-group なら（その先頭の）ボタンをフォーカス先にする */
export const pickButton = (element: HTMLElement) => {
  if (element.tagName === 'BUTTON') return element;
  if (element.classList.contains('btn-group')) return element.querySelector<HTMLElement>('button');
  return null;
};
