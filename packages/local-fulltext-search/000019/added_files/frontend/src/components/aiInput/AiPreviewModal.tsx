/**
 * AIインプット用ドキュメントの全画面プレビュー。
 * 左に生成した HTML のプレビュー、右に含めるノートの一覧を表示する。
 * ノートの切り替え・並べ替え・リンクを辿る深さの変更・リンク先ノートの除外を行い、その場で保存できる。
 * 処理できなかったリンク（見つからない・時間切れ・エラー）があれば、プレビューの上に一覧を出す。
 * 「2 ファイルを保存」の隣に図面 PDF の最大サイズ（MB）の入力欄を置く。
 * プレビューの上に文字数・容量（社内AIの上限つき）を出し、上限で分割されたときはパートを切り替えて表示する。
 */
import React from "react";
import { catppuccinIconForResult } from "../../fileIcon";
import { AiChildTreeNode, buildChildTree } from "./AiChildTree";
import { AiFigurePdfLimitInput } from "./AiFigurePdfLimitInput";
import { AiOutputSummary } from "./AiOutputSummary";
import { AiSkippedLinksNotice } from "./AiSkippedLinksNotice";
import type { UseAiDocumentBuilderResult } from "../../hooks/useAiDocumentBuilder";
import type { UseAiCandidatesResult } from "../../hooks/useAiCandidates";
import type { UseAiExportFolderResult } from "../../hooks/useAiExportFolder";
import type { UseAiExportOptionsResult } from "../../hooks/useAiExportOptions";

type AiPreviewModalProps = {
  builder: UseAiDocumentBuilderResult;
  candidateList: UseAiCandidatesResult;
  exportFolderSettings: UseAiExportFolderResult;
  options: UseAiExportOptionsResult;
  openFileViaHub: (fullPath: string) => void;
};

export function AiPreviewModal({ builder, candidateList, exportFolderSettings, options, openFileViaHub }: AiPreviewModalProps) {
  const {
    activePartIndex,
    collapseAllNodes,
    currentPartHtml,
    collapsedNodes,
    copiedHtml,
    copyHtmlCode,
    dragOverIndex,
    draggedIndex,
    excludedChildPaths,
    expandAllNodes,
    expandedNodes,
    fileDepths,
    generatedData,
    handleDepthChange,
    handleDownload,
    handleDropModalFile,
    handleMoveModalFile,
    handleSaveBundle,
    handleSaveHtmlAndCopyPath,
    handleToggleChildNode,
    handleToggleEmailRecipients,
    handleToggleModalFile,
    handleToggleOptimizeTokens,
    handleToggleOnlyTopTag,
    isModalUpdating,
    isSaving,
    isSavingBundle,
    modalActivePaths,
    modalOrderedPaths,
    onlyTopTag,
    previewTab,
    savedPathFeedback,
    setDragOverIndex,
    setActivePartIndex,
    setDraggedIndex,
    setIsModalOpen,
    setPreviewTab,
    toggleNodeCollapse,
  } = builder;
  const { candidates, rawCandidates } = candidateList;
  const { handleOpenFolder, isOpeningFolder } = exportFolderSettings;
  const { includeEmailRecipients, optimizeTokens } = options;

  // 生成結果があるときだけ表示する画面（呼び出し側でも判定しているが、型の上でも保証する）
  if (!generatedData) {
    return null;
  }

  return (
    <div
      className="ai-preview-modal-backdrop"
      onClick={() => setIsModalOpen(false)}
    >
      <div
        className="ai-preview-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="AIインプット HTMLプレビュー & ファイル選択調整"
      >
        {/* ヘッダー */}
        <div className="ai-preview-modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "20px" }}>🤖</span>
            <strong style={{ fontSize: "16px", color: "#f8fafc" }}>
              AIインプット HTMLプレビュー & ファイル選択調整
            </strong>
            {isModalUpdating && (
              <span
                className="badge"
                style={{
                  background: "rgba(99, 102, 241, 0.2)",
                  color: "#818cf8",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "3px 10px",
                  borderRadius: "6px",
                  border: "1px solid rgba(99, 102, 241, 0.4)",
                  fontSize: "12px",
                }}
              >
                <span className="spin">🔄</span> 更新中...
              </span>
            )}
            {savedPathFeedback && (
              <span
                style={{
                  fontSize: "12px",
                  color: "#10b981",
                  background: "rgba(16, 185, 129, 0.15)",
                  padding: "4px 12px",
                  borderRadius: "6px",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                }}
              >
                {savedPathFeedback}
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <AiFigurePdfLimitInput exportFolderSettings={exportFolderSettings} />
            {/* 2ファイルを保存ボタン */}
            <button
              className="btn btn-primary"
              style={{
                padding: "8px 18px",
                fontSize: "13.5px",
                background: "linear-gradient(135deg, #10b981, #059669)",
                border: "none",
                fontWeight: 600,
                borderRadius: "8px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
              onClick={() => void handleSaveBundle()}
              disabled={isSavingBundle || isModalUpdating}
              title="マークダウン(.md)と図面PDF（1ページ1図・画質そのまま）を保存します。図面PDFは上限を超えると分割します"
            >
              {isSavingBundle ? (
                <>
                  <span className="spin">🔄</span>
                  保存中...
                </>
              ) : (
                <>
                  <span>📦</span>
                  💾 2ファイルを保存
                </>
              )}
            </button>

            {/* フォルダを開くボタン */}
            <button
              className="btn btn-secondary"
              style={{
                fontSize: "13px",
                padding: "6px 14px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
              onClick={() => void handleOpenFolder()}
              disabled={isOpeningFolder}
              title="保存先フォルダをFinder / Explorerで開き、チャットへのドラッグ＆ドロップを容易にします"
            >
              {isOpeningFolder ? <span className="spin">🔄</span> : <span>📂</span>}
              フォルダを開く
            </button>

            {/* HTML 保存＆パスコピーボタン */}
            <button
              className="btn btn-primary save-copy-path-button"
              style={{
                padding: "8px 18px",
                fontSize: "13.5px",
                background: "linear-gradient(135deg, #10b981, #059669)",
                border: "none",
                fontWeight: 600,
                borderRadius: "8px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
              onClick={() => void handleSaveHtmlAndCopyPath()}
              disabled={isSaving || isModalUpdating}
              title="HTMLファイルをローカル保存し、保存先絶対パスをクリップボードにコピーします"
            >
              {isSaving ? (
                <>
                  <span className="spin">🔄</span>
                  保存中...
                </>
              ) : (
                <>
                  <span>💾</span>
                  HTML保存
                </>
              )}
            </button>

            <button
              className="btn btn-secondary"
              style={{ fontSize: "13px", padding: "6px 14px" }}
              onClick={handleDownload}
              title="HTMLをブラウザでダウンロード"
            >
              <span>📥</span> HTML DL
            </button>

            <button
              className="btn btn-secondary"
              style={{ fontSize: "13px", padding: "6px 14px" }}
              onClick={copyHtmlCode}
            >
              {copiedHtml ? "✅ コピー完了！" : "📋 コードコピー"}
            </button>

            <button
              className="btn btn-secondary"
              style={{ fontSize: "16px", padding: "4px 12px", lineHeight: "1" }}
              onClick={() => setIsModalOpen(false)}
              title="閉じる (Esc)"
              aria-label="閉じる"
            >
              ✕
            </button>
          </div>
        </div>

        {/* ボディ: 左右2カラム */}
        <div className="ai-preview-modal-body">
          {/* 左側: HTMLプレビュー / ソース */}
          <div className="ai-preview-pane">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  className={`btn btn-sm ${previewTab === "preview" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setPreviewTab("preview")}
                >
                  <span>👁️</span> プレビュー表示
                </button>
                <button
                  className={`btn btn-sm ${previewTab === "code" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setPreviewTab("code")}
                >
                  <span>📄</span> HTMLソース
                </button>
              </div>
              <div style={{ fontSize: "11.5px", color: "#94a3b8" }}>
                サイズ: {(generatedData.size_bytes / 1024).toFixed(1)} KB | ドキュメント: {generatedData.total_documents} 件
              </div>
            </div>

            <AiOutputSummary data={generatedData} activePartIndex={activePartIndex} onSelectPart={setActivePartIndex} />
            <AiSkippedLinksNotice skippedLinks={generatedData.skipped_links} />

            <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
              {previewTab === "preview" ? (
                <iframe
                  title="AI Context HTML Preview Modal"
                  srcDoc={currentPartHtml}
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: "8px",
                    border: "none",
                    backgroundColor: "#ffffff",
                  }}
                />
              ) : (
                <pre
                  className="rag-code-block"
                  style={{
                    width: "100%",
                    height: "100%",
                    overflowY: "auto",
                    padding: "14px",
                    margin: 0,
                    borderRadius: "8px",
                    backgroundColor: "rgba(0, 0, 0, 0.4)",
                    border: "1px solid rgba(255, 255, 255, 0.08)",
                    fontSize: "12px",
                    color: "#94a3b8",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {currentPartHtml}
                </pre>
              )}
            </div>
          </div>

          {/* 右側: 対象ファイル選択チェックボックスリスト */}
          <div className="ai-file-selection-pane">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px", flexWrap: "wrap", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3 style={{ fontSize: "14px", fontWeight: 600, margin: 0, color: "#f8fafc", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span>📁</span> 対象ファイル選択
                </h3>
                <span
                  className="badge"
                  style={{
                    backgroundColor: "rgba(99, 102, 241, 0.2)",
                    color: "#a5b4fc",
                    border: "1px solid rgba(99, 102, 241, 0.4)",
                    fontSize: "11.5px",
                    padding: "2px 8px",
                  }}
                >
                  {modalActivePaths.size} 件選択
                  {expandedNodes.length > modalActivePaths.size && (
                    <span style={{ marginLeft: "4px", color: "#818cf8" }}>
                      (展開後: {expandedNodes.length} 件)
                    </span>
                  )}
                </span>
              </div>

              {/* spoon_feeder2 風のツリー全展開・全折りたたみボタン */}
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <button
                  type="button"
                  className="small-btn"
                  onClick={expandAllNodes}
                  style={{
                    fontSize: "11px",
                    padding: "3px 8px",
                    borderRadius: "4px",
                    backgroundColor: "rgba(99, 102, 241, 0.18)",
                    border: "1px solid rgba(99, 102, 241, 0.35)",
                    color: "#cbd5e1",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                  title="すべてのツリーを展開"
                >
                  <span>📂</span> すべて展開
                </button>
                <button
                  type="button"
                  className="small-btn"
                  onClick={collapseAllNodes}
                  style={{
                    fontSize: "11px",
                    padding: "3px 8px",
                    borderRadius: "4px",
                    backgroundColor: "rgba(255, 255, 255, 0.06)",
                    border: "1px solid rgba(255, 255, 255, 0.12)",
                    color: "#94a3b8",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                  title="すべてのツリーを折りたたむ"
                >
                  <span>📁</span> すべて折りたたむ
                </button>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", flexWrap: "wrap", gap: "6px" }}>
              <div style={{ fontSize: "11.5px", color: "#94a3b8" }}>
                ドラッグまたは▲▼で順序変更・除外連動
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <label style={{ fontSize: "11.5px", display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", color: "#38bdf8", fontWeight: 600 }} title="Obsidianのtopタグを持つノートのみを表示・出力対象にします">
                  <input
                    type="checkbox"
                    checked={onlyTopTag}
                    onChange={(e) => handleToggleOnlyTopTag(e.target.checked)}
                  />
                  <span>🏷️ obsidianのtopタグのみを出す</span>
                </label>

                <label style={{ fontSize: "11.5px", display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", color: "#10b981", fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={optimizeTokens}
                    onChange={(e) => handleToggleOptimizeTokens(e.target.checked)}
                  />
                  <span>🧹 トークン最適化</span>
                </label>

                <label style={{ fontSize: "11.5px", display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", color: "#f59e0b", fontWeight: 600 }} title="リンクされたメールの宛先（To・CC・BCC）を出力に含めます。外すと見出しと本文の引用ヘッダーから宛先行を除き、トークンを節約します">
                  <input
                    type="checkbox"
                    checked={includeEmailRecipients}
                    onChange={(e) => handleToggleEmailRecipients(e.target.checked)}
                  />
                  <span>✉️ メールの宛先を含める</span>
                </label>
              </div>
            </div>

            <div className="ai-file-selection-list">
              {(onlyTopTag
                ? modalOrderedPaths.filter((p) => {
                    const item = candidates.find((c) => c.full_path === p) || rawCandidates.find((c) => c.full_path === p);
                    return item?.has_obsidian_top_tag === true;
                  })
                : modalOrderedPaths
              ).map((fullPath, idx) => {
                const item = candidates.find((c) => c.full_path === fullPath) || rawCandidates.find((c) => c.full_path === fullPath) || {
                  full_path: fullPath,
                  file_name: fullPath.split(/[/\\]/).pop() || fullPath,
                };
                const isChecked = modalActivePaths.has(fullPath);
                const isDraggingThis = draggedIndex === idx;
                const isDragOverThis = dragOverIndex === idx;

                // この親ノートから展開された子ノード木構造 (spoon_feeder2 風)
                const childTree = buildChildTree(expandedNodes, fullPath);
                const isRootCollapsed = collapsedNodes.has(fullPath);

                return (
                  <React.Fragment key={fullPath}>
                    <div
                      className={`ai-file-selection-item ${isChecked ? "checked" : ""} ${isDraggingThis ? "is-dragging" : ""} ${isDragOverThis ? "is-drag-over" : ""}`}
                      title={`クリックして 8001 Open Hub で開く\nパス: ${fullPath}`}
                      style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}
                      onClick={() => openFileViaHub(fullPath)}
                      draggable={true}
                      onDragStart={(e) => {
                        setDraggedIndex(idx);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", idx.toString());
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dragOverIndex !== idx) setDragOverIndex(idx);
                      }}
                      onDragLeave={() => {
                        if (dragOverIndex === idx) setDragOverIndex(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        handleDropModalFile(idx);
                      }}
                      onDragEnd={() => {
                        setDraggedIndex(null);
                        setDragOverIndex(null);
                      }}
                    >
                      {/* ドラッグハンドル */}
                      <span
                        className="ai-drag-handle"
                        title="ドラッグして並び替え"
                        onClick={(e) => e.stopPropagation()}
                      >
                        ⋮⋮
                      </span>

                      {/* 順序変更ボタン（▲ / ▼） */}
                      <div className="ai-order-controls" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="ai-order-btn ai-order-up"
                          disabled={idx === 0}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveModalFile(idx, "up");
                          }}
                          title="上に移動 (表示順序を繰り上げ)"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          className="ai-order-btn ai-order-down"
                          disabled={idx === modalOrderedPaths.length - 1}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveModalFile(idx, "down");
                          }}
                          title="下に移動 (表示順序を繰り下げ)"
                        >
                          ▼
                        </button>
                      </div>

                      {/* 順位バッジ */}
                      <span className="ai-order-badge">#{idx + 1}</span>

                      {/* ツリー開閉トグルボタン (spoon_feeder2 風) */}
                      {childTree.length > 0 ? (
                        <button
                          type="button"
                          className="ai-tree-toggle-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleNodeCollapse(fullPath);
                          }}
                          title={isRootCollapsed ? "ツリーを展開する" : "ツリーを折りたたむ"}
                        >
                          {isRootCollapsed ? "▶" : "▼"}
                        </button>
                      ) : (
                        <span className="ai-tree-spacer" />
                      )}

                      {/* チェックボックス */}
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => handleToggleModalFile(fullPath)}
                        style={{ cursor: "pointer", width: "16px", height: "16px", accentColor: "#6366f1", flexShrink: 0 }}
                      />

                      {/* ファイル種別アイコン */}
                      <img
                        className="result-file-icon"
                        src={`/icons/catppuccin/${catppuccinIconForResult(item as any)}`}
                        alt=""
                        aria-hidden="true"
                        style={{ width: "16px", height: "16px", flexShrink: 0 }}
                      />

                      {/* ファイル名 & パス */}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontSize: "12.5px",
                            fontWeight: 500,
                            color: isChecked ? "#f8fafc" : "#94a3b8",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          <span>{item.file_name}</span>
                          <span style={{ fontSize: "11px", opacity: 0.6, color: "#38bdf8" }} title="8001ハブで開く">↗</span>
                          {"has_obsidian_top_tag" in item && item.has_obsidian_top_tag && (
                            <span
                              className="badge"
                              style={{
                                fontSize: "10px",
                                padding: "1px 5px",
                                backgroundColor: "rgba(56, 189, 248, 0.15)",
                                color: "#38bdf8",
                                border: "1px solid rgba(56, 189, 248, 0.4)",
                                borderRadius: "4px",
                                fontWeight: 600,
                              }}
                            >
                              🏷️ TOP
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#64748b",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            marginTop: "1px",
                          }}
                        >
                          {item.full_path}
                        </div>
                      </div>

                      {/* リンク展開階層数（おのおののmdファイルごとに設定、デフォルトはtopありなら5、他は1） */}
                      <div
                        style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}
                        title="このノートからリンクされているノートを辿る階層数 (デフォルト: topタグありは5、なしは1)"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span style={{ fontSize: "11px", color: "#94a3b8" }}>階層:</span>
                        <input
                          type="number"
                          min={0}
                          max={10}
                          value={fileDepths[fullPath] ?? ("has_obsidian_top_tag" in item && item.has_obsidian_top_tag ? 2 : 1)}
                          onChange={(e) => handleDepthChange(fullPath, e.target.value)}
                          className="small-input file-depth-input link-depth-input"
                          style={{
                            width: "42px",
                            padding: "2px 4px",
                            fontSize: "12px",
                            textAlign: "center",
                            borderRadius: "4px",
                            backgroundColor: "rgba(0, 0, 0, 0.4)",
                            border: "1px solid rgba(255, 255, 255, 0.2)",
                            color: "#f8fafc",
                          }}
                        />
                      </div>
                    </div>

                    {/* リンク展開された子ノートツリー (spoon_feeder2 風の階層開閉ツリー) */}
                    {isChecked && !isRootCollapsed && childTree.length > 0 && (
                      <div className="ai-child-nodes-container">
                        {childTree.map((childNode, cIdx) => (
                          <AiChildTreeNode
                            key={`${childNode.node.full_path}-${cIdx}`}
                            treeNode={childNode}
                            excludedChildPaths={excludedChildPaths}
                            collapsedNodes={collapsedNodes}
                            onToggleChildNode={handleToggleChildNode}
                            onToggleCollapse={toggleNodeCollapse}
                            openFileViaHub={openFileViaHub}
                            depth={1}
                          />
                        ))}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
