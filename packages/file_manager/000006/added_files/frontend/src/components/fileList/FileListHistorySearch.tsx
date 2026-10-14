/**
 * フォルダ履歴の検索欄（入力するとドロップダウンに候補を最大10件表示）
 * - 候補は移動回数の多い順、同じ回数なら新しい順。全角・半角スペース区切りで AND 検索
 * - ドロップダウンが出ていないときの ↑/↓ はフィルタバー/検索バーへ移動、Enter でドロップダウンを開く
 * - ドロップダウン表示中は ↑↓ で候補を選び、Enter で移動、Escape で閉じる
 * - 入力欄からフォーカスが外れたら閉じる（候補のクリックを処理し終えてから）
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { History } from "lucide-react";
import { useFolderHistory } from "../../contexts/FolderHistoryContext";

const MAX_VISIBLE_ITEMS = 10;

interface FileListHistorySearchProps {
  inputRef: RefObject<HTMLInputElement | null>;
  /** 候補を選んだとき（viaKeyboard: Enter で選んだ場合は一覧へフォーカスを戻す） */
  onSelectPath: (path: string, viaKeyboard: boolean) => void;
  onFocusFilterBar: () => void;
  onFocusSearchBar: () => void;
}

export function FileListHistorySearch({
  inputRef,
  onSelectPath,
  onFocusFilterBar,
  onFocusSearchBar,
}: FileListHistorySearchProps) {
  const { history, searchHistory } = useFolderHistory();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const matched = query ? searchHistory(query) : history;
    return [...matched].sort((a, b) => b.count - a.count || b.timestamp - a.timestamp);
  }, [history, query, searchHistory]);

  // 開いたら（候補のクリック後なども）入力欄にフォーカスを置く
  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isOpen, inputRef]);

  const open = () => {
    setSelectedIndex(0);
    setIsOpen(true);
  };

  const select = (path: string, viaKeyboard: boolean) => {
    setIsOpen(false);
    onSelectPath(path, viaKeyboard);
  };

  const moveSelection = (index: number) => {
    setSelectedIndex(index);
    requestAnimationFrame(() => {
      dropdownRef.current
        ?.querySelector(`.history-item[data-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const isDropdownActive = isOpen && items.length > 0;
    if (e.key === "ArrowUp" && !isDropdownActive) {
      e.preventDefault();
      onFocusFilterBar();
      return;
    }
    if (e.key === "ArrowDown" && !isDropdownActive) {
      e.preventDefault();
      onFocusSearchBar();
      return;
    }
    if (e.key === "Enter" && !isOpen) {
      e.preventDefault();
      open();
      return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
    }
    if (e.key === "ArrowDown") {
      moveSelection(Math.min(selectedIndex + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      moveSelection(Math.max(selectedIndex - 1, 0));
    } else if (e.key === "Enter") {
      const item = items[selectedIndex];
      if (item) select(item.path, true);
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  return (
    <div className="history-search-bar">
      <History size={14} className="history-icon" />
      <input
        ref={inputRef}
        type="text"
        placeholder="履歴を検索..."
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelectedIndex(0);
          setIsOpen(true);
        }}
        onBlur={() => {
          // 候補のクリックを処理し終えてから閉じる
          setTimeout(() => setIsOpen(false), 200);
        }}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      />
      {isOpen && (
        <div className="history-dropdown" ref={dropdownRef}>
          {items.length > 0 ? (
            items.slice(0, MAX_VISIBLE_ITEMS).map((item, index) => (
              <div
                key={item.path}
                data-index={index}
                className={`history-item ${index === selectedIndex ? "selected" : ""}`}
                onClick={() => select(item.path, false)}
                onMouseEnter={() => setSelectedIndex(index)}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <span style={{ overflow: "hidden", whiteSpace: "normal", wordBreak: "break-all", overflowWrap: "anywhere" }}>
                  {item.path || "/"}
                </span>
                {item.count > 1 && (
                  <span style={{ fontSize: "0.8em", color: "#888", marginLeft: "8px", flexShrink: 0 }}>
                    {item.count}回
                  </span>
                )}
              </div>
            ))
          ) : (
            <div className="history-empty">履歴がありません</div>
          )}
        </div>
      )}
    </div>
  );
}
