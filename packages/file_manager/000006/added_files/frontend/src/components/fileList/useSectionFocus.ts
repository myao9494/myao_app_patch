/**
 * ファイル一覧ペイン内のセクション間キーボード移動
 * - セクション: ツールバー → パス → フィルタ → 履歴検索 → 検索 → 一覧（↑↓で移動）
 * - ツールバー・パス・フィルタでは ←→ でボタンを選び、Enter で実行する
 *   （左端で ← を押したときはペイン切り替えに任せるため何もしない）
 * - パスのボタンは「フルパスをコピー」「リンクをコピー」「パス入力欄」の順。
 *   ハイライトしたボタンと Enter で実行する内容を一致させる
 * - 選んでいるボタンには keyboard-focused クラスを付ける
 * - 一覧セクションのキー操作は FileList 側で処理する
 */
import { useEffect, useState, type KeyboardEvent, type RefObject } from "react";

export type FocusSection = "toolbar" | "path" | "filter" | "history" | "search" | "list";

const TOOLBAR_BUTTONS = ".icon-toolbar button";
const FILTER_BUTTONS = ".filter-bar .filter-btn";
// パスセクションの要素（この順に ←→ で移動する）
const PATH_ELEMENTS = [
  '.path-input-container button[title="フルパスをコピー"]',
  '.path-input-container button[title="リンクをコピー"]',
  ".path-input-container .path-input",
];
const PATH_INPUT_INDEX = PATH_ELEMENTS.length - 1;

interface SectionFocusOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  pathInputRef: RefObject<HTMLTextAreaElement | null>;
  historyInputRef: RefObject<HTMLInputElement | null>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onCopyPath: () => void;
  onCopyLink: () => void;
  /** 検索から一覧へ移ったとき（カーソルを先頭に戻す） */
  onEnterList: () => void;
}

/** 選んでいる要素に keyboard-focused クラスを付ける */
function useKeyboardFocusClass(
  containerRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  findElements: (container: HTMLElement) => Element[],
  index: number
) {
  useEffect(() => {
    if (!active || !containerRef.current) return;
    const elements = findElements(containerRef.current);
    elements[index]?.classList.add("keyboard-focused");
    return () => {
      elements.forEach((el) => el.classList.remove("keyboard-focused"));
    };
  }, [containerRef, active, findElements, index]);
}

const findToolbarButtons = (container: HTMLElement) => Array.from(container.querySelectorAll(TOOLBAR_BUTTONS));
const findFilterButtons = (container: HTMLElement) => Array.from(container.querySelectorAll(FILTER_BUTTONS));
const findPathElements = (container: HTMLElement) =>
  PATH_ELEMENTS.map((selector) => container.querySelector(selector)).filter((el): el is Element => el !== null);

export function useSectionFocus({
  containerRef,
  pathInputRef,
  historyInputRef,
  searchInputRef,
  onCopyPath,
  onCopyLink,
  onEnterList,
}: SectionFocusOptions) {
  const [focusedSection, setFocusedSection] = useState<FocusSection>("list");
  const [toolbarButtonIndex, setToolbarButtonIndex] = useState(0);
  const [filterButtonIndex, setFilterButtonIndex] = useState(0);
  const [pathButtonIndex, setPathButtonIndex] = useState(0);

  useKeyboardFocusClass(containerRef, focusedSection === "toolbar", findToolbarButtons, toolbarButtonIndex);
  useKeyboardFocusClass(containerRef, focusedSection === "filter", findFilterButtons, filterButtonIndex);
  useKeyboardFocusClass(containerRef, focusedSection === "path", findPathElements, pathButtonIndex);

  const clickNth = (selector: string, index: number) => {
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>(selector);
    buttons?.[index]?.click();
  };
  const lastIndexOf = (selector: string) =>
    Math.max(0, (containerRef.current?.querySelectorAll(selector).length ?? 1) - 1);

  /**
   * ツールバー・パス・フィルタ・履歴検索・検索セクションでのキー操作
   * 処理した（以降のショートカット処理を行わない）場合は true を返す
   */
  const handleSectionKeyDown = (e: KeyboardEvent): boolean => {
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    // ←→ でセクション内のボタンを選ぶ（左端の ← はペイン切り替えに任せる）
    const moveWithin = (index: number, lastIndex: number, setIndex: (index: number) => void): boolean => {
      if (e.key === "ArrowLeft") {
        if (index === 0) return true;
        consume();
        setIndex(index - 1);
        return true;
      }
      if (e.key === "ArrowRight") {
        consume();
        if (index < lastIndex) setIndex(index + 1);
        return true;
      }
      return false;
    };

    switch (focusedSection) {
      case "toolbar":
        if (moveWithin(toolbarButtonIndex, lastIndexOf(TOOLBAR_BUTTONS), setToolbarButtonIndex)) return true;
        if (e.key === "ArrowDown") {
          consume();
          setFocusedSection("path");
          setPathButtonIndex(0);
          return true;
        }
        if (e.key === "Enter") {
          consume();
          clickNth(TOOLBAR_BUTTONS, toolbarButtonIndex);
          return true;
        }
        return false;

      case "path":
        if (moveWithin(pathButtonIndex, PATH_INPUT_INDEX, setPathButtonIndex)) return true;
        if (e.key === "ArrowUp") {
          consume();
          setFocusedSection("toolbar");
          return true;
        }
        if (e.key === "ArrowDown") {
          consume();
          setFocusedSection("filter");
          return true;
        }
        if (e.key === "Enter") {
          consume();
          if (pathButtonIndex === 0) onCopyPath();
          else if (pathButtonIndex === 1) onCopyLink();
          else pathInputRef.current?.focus();
          return true;
        }
        return false;

      case "filter":
        if (moveWithin(filterButtonIndex, lastIndexOf(FILTER_BUTTONS), setFilterButtonIndex)) return true;
        if (e.key === "ArrowUp") {
          consume();
          setFocusedSection("path");
          setPathButtonIndex(0);
          return true;
        }
        if (e.key === "ArrowDown") {
          consume();
          setFocusedSection("history");
          historyInputRef.current?.focus();
          return true;
        }
        if (e.key === "Enter") {
          consume();
          clickNth(FILTER_BUTTONS, filterButtonIndex);
          return true;
        }
        return false;

      case "history":
        if (e.key === "ArrowUp") {
          consume();
          setFocusedSection("filter");
          return true;
        }
        if (e.key === "ArrowDown") {
          consume();
          setFocusedSection("search");
          searchInputRef.current?.focus();
          return true;
        }
        return false;

      case "search":
        if (e.key === "ArrowUp") {
          consume();
          setFocusedSection("history");
          historyInputRef.current?.focus();
          return true;
        }
        if (e.key === "ArrowDown") {
          consume();
          setFocusedSection("list");
          onEnterList();
          return true;
        }
        return false;

      case "list":
        return false;
    }
  };

  return {
    focusedSection,
    setFocusedSection,
    toolbarButtonIndex,
    pathButtonIndex,
    setToolbarButtonIndex,
    setFilterButtonIndex,
    setPathButtonIndex,
    handleSectionKeyDown,
  };
}
