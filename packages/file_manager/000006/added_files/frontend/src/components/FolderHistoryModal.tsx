/**
 * フォルダ履歴検索モーダル
 * Ctrl+Rで開く、ディレクトリの移動履歴から検索して選択する
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { Modal } from "./Modal";
import "./FolderHistoryModal.css";

interface FolderHistoryModalProps {
  isOpen: boolean;
  history: string[];
  onClose: () => void;
  onSelectPath: (path: string) => void;
}

export function FolderHistoryModal({
  isOpen,
  history,
  onClose,
  onSelectPath,
}: FolderHistoryModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- 開いた時点の内容で入力欄を初期化する（開いている間の親の再描画では入力を消さない）
    setQuery("");
    setSelectedIndex(0);

    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [isOpen]);

  const filteredHistory = useMemo(() => {
    if (!query.trim()) {
      return history;
    }
    const lowerQuery = query.toLowerCase();
    return history.filter((p) => p.toLowerCase().includes(lowerQuery));
  }, [history, query]);

  const selectedPath = useMemo(
    () => filteredHistory[selectedIndex] ?? null,
    [filteredHistory, selectedIndex]
  );

  useEffect(() => {
    const selectedResult = resultRefs.current[selectedIndex];
    selectedResult?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedIndex]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 絞り込みで件数が減ったとき選択位置を範囲内に収める
    setSelectedIndex((current) => Math.min(current, Math.max(filteredHistory.length - 1, 0)));
  }, [filteredHistory.length]);

  const handleOpenPath = (path: string | null) => {
    if (!path) {
      return;
    }
    onSelectPath(path);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const isImeComposing =
      e.nativeEvent.isComposing ||
      (e.nativeEvent as KeyboardEvent).keyCode === 229;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredHistory.length > 0) {
        setSelectedIndex((prev) => Math.min(prev + 1, filteredHistory.length - 1));
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredHistory.length > 0) {
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }
      return;
    }

    if (e.key === "Enter") {
      if (isImeComposing) {
        return;
      }
      e.preventDefault();
      handleOpenPath(selectedPath);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="フォルダ履歴検索"
      width="720px"
      height="70vh"
    >
      <div className="folder-history-modal">
        <div className="folder-history-modal-input-row">
          <Search size={16} className="folder-history-modal-icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="folder-history-modal-input"
            placeholder="パスの一部を入力して検索..."
          />
        </div>

        <div className="folder-history-modal-meta">
          <span>{filteredHistory.length} 件の履歴</span>
        </div>

        <div className="folder-history-modal-results">
          {filteredHistory.length === 0 && (
            <div className="folder-history-modal-empty">一致する履歴がありません</div>
          )}

          {filteredHistory.map((pathItem, index) => {
            return (
              <button
                key={`${index}-${pathItem}`}
                type="button"
                ref={(element) => {
                  resultRefs.current[index] = element;
                }}
                className={`folder-history-modal-result ${index === selectedIndex ? "selected" : ""}`}
                aria-pressed={index === selectedIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onFocus={() => setSelectedIndex(index)}
                onClick={() => handleOpenPath(pathItem)}
              >
                <div className="folder-history-modal-result-path">{pathItem}</div>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
