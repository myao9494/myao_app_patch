/**
 * 検索ルール管理画面。
 * 除外キーワード・類似語・インデックス対象の拡張子を一覧で編集する。
 * 項目の追加・編集・削除・並べ替え（ドラッグ）と、右クリックメニュー、追加用のダイアログを持つ。
 */
import type { PageView } from "../appTypes";
import type { UseRuleManagementResult } from "../hooks/useRuleManagement";

type RuleManagementPageProps = {
  rules: UseRuleManagementResult;
  onChangePage: (nextView: PageView) => Promise<void>;
  onToggleMenu: () => void;
};

export function RuleManagementPage({ rules, onChangePage, onToggleMenu }: RuleManagementPageProps) {
  const {
    activeRuleKind,
    clearAllIndexExtensions,
    draggedRule,
    editingExcludeKeyword,
    editingExcludeKeywordValue,
    editingSynonymGroup,
    editingSynonymGroupValue,
    excludeKeywordSet,
    excludeRuleFilterText,
    extensionRuleFilterText,
    filteredCustomContentExtensions,
    filteredCustomFilenameExtensions,
    filteredExcludeKeywordEntries,
    filteredStandardExtensions,
    filteredSynonymGroupEntries,
    handleAddCustomExtension,
    handleDeleteRuleItem,
    handleMoveRuleItem,
    handleOpenRuleAddModal,
    handleRedoRuleChange,
    handleRemoveCustomExtension,
    handleSaveIndexExtensions,
    handleSubmitRuleAdd,
    handleUndoRuleChange,
    handleUpdateExcludeKeyword,
    handleUpdateSynonymGroup,
    hasUnsavedExcludeKeywords,
    hasUnsavedIndexExtensions,
    hasUnsavedSynonymGroups,
    isRuleAddModalOpen,
    isSavingExcludeKeywords,
    isSavingIndexExtensions,
    isSavingSynonymGroups,
    newContentExtension,
    newExcludeKeyword,
    newFilenameExtension,
    newSynonymDesc,
    newSynonymGroup,
    ruleAddKind,
    ruleContextMenu,
    selectedIndexExtensions,
    selectedRuleItem,
    setActiveRuleKind,
    setAllIndexExtensions,
    setDraggedRule,
    setEditingExcludeKeyword,
    setEditingExcludeKeywordValue,
    setEditingSynonymGroup,
    setEditingSynonymGroupValue,
    setExcludeRuleFilterText,
    setExtensionRuleFilterText,
    setIsRuleAddModalOpen,
    setNewContentExtension,
    setNewExcludeKeyword,
    setNewFilenameExtension,
    setNewSynonymDesc,
    setNewSynonymGroup,
    setRuleContextMenu,
    setSelectedRuleItem,
    setSynonymRuleFilterText,
    synonymRuleFilterText,
    toggleIndexExtension,
  } = rules;

  return (
    <section className="rule-management-panel" onClick={() => setRuleContextMenu(null)}>
      <div className="section-header">
        <div>
          <h2>検索ルール管理</h2>
          <div className="form-help">行全体をダブルクリックで編集。ドラッグで並べ替え、右クリックで削除できます。</div>
        </div>
        <div className="section-header-actions">
          <button className="secondary-button" onClick={handleUndoRuleChange} type="button">元に戻す</button>
          <button className="secondary-button" onClick={handleRedoRuleChange} type="button">やり直す</button>
          <button className="secondary-button" onClick={() => void onChangePage("search")} type="button">検索へ戻る</button>
          <button className="menu-button" onClick={onToggleMenu} type="button" aria-label="設定">☰</button>
        </div>
      </div>

      <div className="rule-management-grid">
        <div className={`rule-list-card ${activeRuleKind === "exclude" ? "active" : ""}`} onClick={() => setActiveRuleKind("exclude")}>
          <div className="section-header">
            <h3>除外キーワード</h3>
            <div className="rule-card-header-actions"><span>{filteredExcludeKeywordEntries.length}件</span><button className="secondary-button" onClick={() => handleOpenRuleAddModal("exclude")} type="button">追加</button></div>
          </div>
          <input className="rule-card-search" value={excludeRuleFilterText} onChange={(event) => setExcludeRuleFilterText(event.target.value)} placeholder="除外キーワードを検索" aria-label="除外キーワードを検索" />
          <div className="rule-list">
            {filteredExcludeKeywordEntries.map((item) => (
              <div
                className={`rule-list-item ${selectedRuleItem?.kind === "exclude" && selectedRuleItem.item === item ? "selected" : ""}`}
                draggable
                key={item}
                onDoubleClick={() => { if (editingExcludeKeyword !== item) { setEditingExcludeKeyword(item); setEditingExcludeKeywordValue(item); } }}
                onClick={(event) => { event.stopPropagation(); setActiveRuleKind("exclude"); setSelectedRuleItem({ kind: "exclude", item }); }}
                onContextMenuCapture={(event) => { event.preventDefault(); setRuleContextMenu({ kind: "exclude", item, x: event.clientX, y: event.clientY }); }}
                onDragStart={() => { setActiveRuleKind("exclude"); setSelectedRuleItem({ kind: "exclude", item }); setDraggedRule({ kind: "exclude", item }); }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => { if (draggedRule?.kind === "exclude") handleMoveRuleItem("exclude", draggedRule.item, item); setDraggedRule(null); }}
              >
                {editingExcludeKeyword === item ? (
                  <input
                    autoFocus
                    className="rule-inline-input"
                    value={editingExcludeKeywordValue}
                    onChange={(event) => setEditingExcludeKeywordValue(event.target.value)}
                    onBlur={() => handleUpdateExcludeKeyword(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                ) : <code title="ダブルクリックで編集">{item}</code>}
                <button
                  className="secondary-button"
                  onClick={(event) => { event.stopPropagation(); handleDeleteRuleItem("exclude", item); }}
                  type="button"
                >削除</button>
              </div>
            ))}
            {filteredExcludeKeywordEntries.length === 0 ? <div className="form-help">一致する除外キーワードはありません。</div> : null}
          </div>
          <div className={`settings-save-status ${hasUnsavedExcludeKeywords ? "dirty" : "saved"}`}>{isSavingExcludeKeywords ? "自動保存中..." : hasUnsavedExcludeKeywords ? "自動保存待ち" : "自動保存済み"}</div>
        </div>

        <div className={`rule-list-card ${activeRuleKind === "synonym" ? "active" : ""}`} onClick={() => setActiveRuleKind("synonym")}>
          <div className="section-header">
            <h3>類似語・専門用語リスト</h3>
            <div className="rule-card-header-actions"><span>{filteredSynonymGroupEntries.length}件</span><button className="secondary-button" onClick={() => handleOpenRuleAddModal("synonym")} type="button">追加</button></div>
          </div>
          <input className="rule-card-search" value={synonymRuleFilterText} onChange={(event) => setSynonymRuleFilterText(event.target.value)} placeholder="類似語・専門用語を検索" aria-label="類似語・専門用語を検索" />
          <div className="rule-list">
            {filteredSynonymGroupEntries.map((item) => {
              const [itemTerms, itemDesc] = item.includes(":") ? item.split(":", 2) : [item, ""];
              const conflicts = itemTerms.split(",").filter((token) => excludeKeywordSet.has(token.toLowerCase()));
              return (
                <div
                  className={`rule-list-item ${selectedRuleItem?.kind === "synonym" && selectedRuleItem.item === item ? "selected" : ""}`}
                  draggable
                  key={item}
                  onDoubleClick={() => { if (editingSynonymGroup !== item) { setEditingSynonymGroup(item); setEditingSynonymGroupValue(item); } }}
                  onClick={(event) => { event.stopPropagation(); setActiveRuleKind("synonym"); setSelectedRuleItem({ kind: "synonym", item }); }}
                  onContextMenuCapture={(event) => { event.preventDefault(); setRuleContextMenu({ kind: "synonym", item, x: event.clientX, y: event.clientY }); }}
                  onDragStart={() => { setActiveRuleKind("synonym"); setSelectedRuleItem({ kind: "synonym", item }); setDraggedRule({ kind: "synonym", item }); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => { if (draggedRule?.kind === "synonym") handleMoveRuleItem("synonym", draggedRule.item, item); setDraggedRule(null); }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editingSynonymGroup === item ? (
                      <input
                        autoFocus
                        className="rule-inline-input"
                        value={editingSynonymGroupValue}
                        onChange={(event) => setEditingSynonymGroupValue(event.target.value)}
                        onBlur={() => handleUpdateSynonymGroup(item)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        placeholder="例: PC,パソコン:パーソナルコンピュータの略称"
                      />
                    ) : (
                      <div>
                        <code title="ダブルクリックで編集">{itemTerms}</code>
                        {itemDesc ? (
                          <div style={{ fontSize: "11.5px", color: "#94a3b8", marginTop: "3px", display: "flex", alignItems: "center", gap: "4px" }}>
                            <span>💬</span>
                            <span>{itemDesc}</span>
                          </div>
                        ) : null}
                      </div>
                    )}
                    {conflicts.length ? <div className="rule-conflict">除外リストに登録済み: {conflicts.join(", ")}</div> : null}
                  </div>
                  <button
                    className="secondary-button"
                    onClick={(event) => { event.stopPropagation(); handleDeleteRuleItem("synonym", item); }}
                    type="button"
                  >削除</button>
                </div>
              );
            })}
            {filteredSynonymGroupEntries.length === 0 ? <div className="form-help">一致する類似語・専門用語はありません。</div> : null}
          </div>
          <div className={`settings-save-status ${hasUnsavedSynonymGroups ? "dirty" : "saved"}`}>{isSavingSynonymGroups ? "自動保存中..." : hasUnsavedSynonymGroups ? "自動保存待ち" : "自動保存済み"}</div>
        </div>

        <div className={`rule-list-card ${activeRuleKind === "extension" ? "active" : ""}`} onClick={() => setActiveRuleKind("extension")}>
          <div className="section-header">
            <h3>インデックス対象拡張子</h3>
            <div className="rule-card-header-actions">
              <span>{selectedIndexExtensions.length}件選択中</span>
              <button className="secondary-button" onClick={setAllIndexExtensions} type="button">全選択</button>
              <button className="secondary-button" onClick={clearAllIndexExtensions} type="button">全解除</button>
              <button
                className="secondary-button settings-save-button"
                onClick={() => void handleSaveIndexExtensions()}
                type="button"
                disabled={!hasUnsavedIndexExtensions || isSavingIndexExtensions}
              >
                {isSavingIndexExtensions ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
          <input
            className="rule-card-search"
            value={extensionRuleFilterText}
            onChange={(event) => setExtensionRuleFilterText(event.target.value)}
            placeholder="拡張子を検索 (例: .md)"
            aria-label="拡張子を検索"
          />

          <div className="extension-add-grid">
            <div className="extension-add-card">
              <div className="form-help">本文を index 化する追加拡張子</div>
              <div className="extension-add-row">
                <input
                  className="extension-add-input"
                  value={newContentExtension}
                  onChange={(event) => setNewContentExtension(event.target.value)}
                  placeholder=".py / .dat"
                />
                <button className="secondary-button" onClick={() => handleAddCustomExtension("content")} type="button">
                  追加
                </button>
              </div>
            </div>

            <div className="extension-add-card">
              <div className="form-help">ファイル名だけを index 化する追加拡張子</div>
              <div className="extension-add-row">
                <input
                  className="extension-add-input"
                  value={newFilenameExtension}
                  onChange={(event) => setNewFilenameExtension(event.target.value)}
                  placeholder=".cae / .mesh"
                />
                <button className="secondary-button" onClick={() => handleAddCustomExtension("filename")} type="button">
                  追加
                </button>
              </div>
            </div>
          </div>

          <div className="rule-list">
            <div className="form-help" style={{ fontWeight: 600, color: "#cbd5e1", marginTop: "4px" }}>標準拡張子</div>
            {filteredStandardExtensions.map((extension) => (
              <label className="extension-option" key={extension} style={{ padding: "4px 8px" }}>
                <input
                  checked={selectedIndexExtensions.includes(extension)}
                  onChange={() => toggleIndexExtension(extension)}
                  type="checkbox"
                />
                <span>{extension}</span>
              </label>
            ))}
            {filteredStandardExtensions.length === 0 && filteredCustomContentExtensions.length === 0 && filteredCustomFilenameExtensions.length === 0 ? (
              <div className="form-help">一致する拡張子はありません。</div>
            ) : null}

            {filteredCustomContentExtensions.length > 0 ? (
              <div className="extension-group" style={{ marginTop: "6px" }}>
                <div className="form-help" style={{ fontWeight: 600, color: "#cbd5e1" }}>追加した本文 index 用拡張子</div>
                {filteredCustomContentExtensions.map((extension) => (
                  <div className="extension-custom-row" key={extension} style={{ padding: "2px 8px" }}>
                    <label className="extension-option">
                      <input
                        checked={selectedIndexExtensions.includes(extension)}
                        onChange={() => toggleIndexExtension(extension)}
                        type="checkbox"
                      />
                      <span>{extension}</span>
                    </label>
                    <button
                      className="secondary-button extension-remove-button"
                      onClick={() => handleRemoveCustomExtension(extension, "content")}
                      type="button"
                    >
                      削除
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {filteredCustomFilenameExtensions.length > 0 ? (
              <div className="extension-group" style={{ marginTop: "6px" }}>
                <div className="form-help" style={{ fontWeight: 600, color: "#cbd5e1" }}>追加したファイル名のみ拡張子</div>
                {filteredCustomFilenameExtensions.map((extension) => (
                  <div className="extension-custom-row" key={extension} style={{ padding: "2px 8px" }}>
                    <label className="extension-option">
                      <input
                        checked={selectedIndexExtensions.includes(extension)}
                        onChange={() => toggleIndexExtension(extension)}
                        type="checkbox"
                      />
                      <span>{extension}</span>
                    </label>
                    <button
                      className="secondary-button extension-remove-button"
                      onClick={() => handleRemoveCustomExtension(extension, "filename")}
                      type="button"
                    >
                      削除
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className={`settings-save-status ${hasUnsavedIndexExtensions ? "dirty" : "saved"}`}>
            {isSavingIndexExtensions ? "保存中..." : hasUnsavedIndexExtensions ? "未保存の変更があります" : "保存済み"}
          </div>
          <div className="form-help">
            インデックス作成対象です。設定は backend のテキストファイルへ保存され、ベクトル検索にも連動して適用されます。
          </div>
        </div>
      </div>
      {ruleContextMenu ? (
        <div
          className="rule-context-menu"
          style={{ left: ruleContextMenu.x, top: ruleContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => handleDeleteRuleItem(ruleContextMenu.kind, ruleContextMenu.item)}>削除</button>
        </div>
      ) : null}
      {isRuleAddModalOpen ? (
        <div className="rule-add-modal-backdrop" role="presentation" onMouseDown={() => { setIsRuleAddModalOpen(false); setNewSynonymDesc(""); }}>
          <div className="rule-add-modal" role="dialog" aria-modal="true" aria-label={`${ruleAddKind === "exclude" ? "除外キーワード" : "類似語・専門用語"}を追加`} onMouseDown={(event) => event.stopPropagation()}>
            <h3>{ruleAddKind === "exclude" ? "除外キーワードを追加" : "類似語・専門用語を追加"}</h3>
            {ruleAddKind === "exclude" ? (
              <input
                autoFocus
                value={newExcludeKeyword}
                onChange={(event) => setNewExcludeKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) handleSubmitRuleAdd();
                }}
                placeholder="例: node_modules"
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div>
                  <label style={{ fontSize: "12px", color: "#cbd5e1", display: "block", marginBottom: "4px" }}>
                    類似語（カンマ区切り、必須）
                  </label>
                  <input
                    autoFocus
                    value={newSynonymGroup}
                    onChange={(event) => setNewSynonymGroup(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) handleSubmitRuleAdd();
                    }}
                    placeholder="例: スマートフォン,スマホ,モバイル"
                  />
                </div>
                <div>
                  <label style={{ fontSize: "12px", color: "#94a3b8", display: "block", marginBottom: "4px" }}>
                    意味・解説（専門用語としての説明、任意）
                  </label>
                  <input
                    value={newSynonymDesc}
                    onChange={(event) => setNewSynonymDesc(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) handleSubmitRuleAdd();
                    }}
                    placeholder="例: 多機能携帯電話。アプリ追加やWeb閲覧が可能。"
                  />
                </div>
              </div>
            )}
            <div className="rule-add-modal-actions">
              <button className="secondary-button" onClick={() => { setIsRuleAddModalOpen(false); setNewSynonymDesc(""); }} type="button">キャンセル</button>
              <button className="secondary-button" onClick={handleSubmitRuleAdd} type="button">追加する</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
