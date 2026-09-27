/**
 * AIインプット用自己完結HTML生成ページコンポーネント (Chat AI Context Export)。
 * 仕様:
 * - 質問やキーワードを入力し、ハイブリッド検索（Vector × FTS5 API）で前提候補ドキュメント群を高速抽出。
 * - 検索ボックス右側の拡張子フィルター（デフォルト: `md`、包含 `md` / 除外 `-png` 等）によるAPI絞り込みおよび候補一覧のリアルタイム動的フィルタリング。
 * - ドラッグ連続選択 & Shift+ドラッグ連続解除に対応した洗練された候補選択テーブル。
 * - ステップ2（候補ノート選択）上部アクションバーから直接「AI用HTMLファイルを生成する」またはプレビューモーダルを開いて即座にエクスポート可能。
 * - クエリからの安全なファイル名・HTMLタイトル自動生成。
 * - 画像・図面（Excalidraw, draw.io, PNG, JPG等）のBase64インライン埋め込み、Markdown元データ含有オプション。
 * - 概算トークン数インジケータ（Claude / ChatGPT コンテキスト窓対応チェック）。
 * - デュアルタブ（iframeによる自己完結HTMLプレビュー / 生HTMLソース表示）。
 * - HTMLダウンロード（.html）およびクリップボードコピー（フィードバック付き）。
 * - 特大プレビューモーダル（100vw × 100vh のフルスクリーン最大化表示、左右2カラム、チェックボックスによるリアルタイム除外連動、ドラッグ＆ドロップおよび▲▼ボタンによるMarkdownドキュメントの順序並び替え、ローカル保存＆絶対パスのクリップボード自動格納）。
 **/

import React, { useState, useEffect, useRef } from "react";
import {
  search,
  generateAiHtml,
  downloadAiHtml,
  saveAiHtmlToFile,
  saveAiBundleToFile,
  openExportFolder,
  getAiExportConfig,
  saveAiExportConfig,
} from "../api/client";
import { catppuccinIconForResult } from "../fileIcon";
import { copyTextToClipboard } from "../clipboard";
import type { SearchResult, ExpandedNode } from "../types";

export interface PromptPreset {
  id: string;
  label: string;
  prompt: string;
}

export const PROMPT_PRESETS: PromptPreset[] = [
  {
    id: "answer",
    label: "❓ 質問に対する根拠付き回答",
    prompt: `以下の参考ドキュメントの内容のみに基づいて、上記の質問に対して過不足なく正確に回答してください。ドキュメントに記載のない推測は含めず、根拠となるノート名やセクションを明記してください。`,
  },
  {
    id: "refine",
    label: "🛠️ 資料の修正・推敲",
    prompt: `以下の参考ドキュメントを精査し、記載内容の誤り・論理矛盾・表現の不備・不足している情報を洗い出し、具体的な修正案および改善後の文章を提示してください。`,
  },
  {
    id: "summary",
    label: "💡 総合要約 & 決定事項とアクション抽出",
    prompt: `以下の参考ドキュメントをすべて熟読した上で、全体の内容を論理的に要約し、重要な決定事項（Decisions）と今後のネクストアクション（Action Items / TODO）を箇条書きで明確に整理して回答してください。`,
  },
  {
    id: "risk",
    label: "📝 課題・リスクの網羅的レビュー",
    prompt: `以下の参考ドキュメントを精査し、プロジェクトやシステムにおける潜在的な課題・リスク・未決定事項を抽出し、その影響度と推奨対策案を整理して提示してください。`,
  },
  {
    id: "custom",
    label: "✏️ カスタム指示（自由入力）",
    prompt: ``,
  },
];

// スニペット・根拠文の整形（HTMLタグ除去またはmark保持）
function truncateSnippet(item: SearchResult, maxLength = 220): string {
  const raw = item.salient_sentence || item.snippet || "";
  if (!raw) return "";

  const plainText = raw.replace(/<[^>]+>/g, "").trim();
  if (!plainText) return "";

  if (plainText.length <= maxLength) {
    return raw;
  }
  return plainText.slice(0, maxLength) + "...";
}

interface AiInputPageProps {
  initialQuery?: string;
  initialExtensionFilter?: string;
  results?: SearchResult[];
  excludeKeywords?: string;
  onOpenFileLocation?: (path: string) => void;
}

import { isExcludedByKeywords } from "../filterUtils.ts";
import { isAiInputDocumentCandidate } from "../aiInputCandidate.ts";
import { filterSearchResultsByExtensions } from "../extensionFilter.ts";

/**
 * 展開された子ノードの木構造型 (spoon_feeder2 風)
 **/
export interface TreeChildNode {
  node: ExpandedNode;
  children: TreeChildNode[];
}

/**
 * フラットなExpandedNode配列から親パスに基づく階層ツリーを構築する
 **/
export function buildChildTree(nodes: ExpandedNode[], rootPath: string): TreeChildNode[] {
  const relevant = nodes.filter(
    (n) => (n.root_path === rootPath) && n.depth_level > 0
  );
  if (relevant.length === 0) return [];

  const byParent = new Map<string, ExpandedNode[]>();
  relevant.forEach((n) => {
    const p = n.parent_path || rootPath;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(n);
  });

  const visited = new Set<string>();

  function buildSubtree(parentPath: string, expectedDepth: number): TreeChildNode[] {
    let direct = byParent.get(parentPath) || [];
    if (direct.length === 0 && expectedDepth === 1) {
      direct = relevant.filter((n) => n.depth_level === 1 && !visited.has(n.full_path));
    }

    const result: TreeChildNode[] = [];
    for (const item of direct) {
      if (visited.has(item.full_path)) continue;
      visited.add(item.full_path);
      result.push({
        node: item,
        children: buildSubtree(item.full_path, item.depth_level + 1),
      });
    }
    return result;
  }

  const tree = buildSubtree(rootPath, 1);

  // 孤立したノードがあればルート直下に安全に追加
  for (const item of relevant) {
    if (!visited.has(item.full_path)) {
      visited.add(item.full_path);
      tree.push({
        node: item,
        children: buildSubtree(item.full_path, item.depth_level + 1),
      });
    }
  }

  return tree;
}

/**
 * spoon_feeder2風の折りたたみ・展開可能な子ノードツリーアイテムコンポーネント
 **/
export function AiChildTreeNode({
  treeNode,
  excludedChildPaths,
  collapsedNodes,
  onToggleChildNode,
  onToggleCollapse,
  openFileViaHub,
  depth = 1,
}: {
  treeNode: TreeChildNode;
  excludedChildPaths: Set<string>;
  collapsedNodes: Set<string>;
  onToggleChildNode: (path: string) => void;
  onToggleCollapse: (path: string) => void;
  openFileViaHub: (path: string) => void;
  depth?: number;
}) {
  const child = treeNode.node;
  const isChildExcluded = excludedChildPaths.has(child.full_path);
  const hasSubChildren = treeNode.children.length > 0;
  const isCollapsed = collapsedNodes.has(child.full_path);

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        className="ai-child-node-item"
        onClick={() => openFileViaHub(child.full_path)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "11.5px",
          color: isChildExcluded ? "#64748b" : "#cbd5e1",
          padding: "3px 8px",
          backgroundColor: isChildExcluded
            ? "rgba(100, 116, 139, 0.08)"
            : "rgba(99, 102, 241, 0.08)",
          borderRadius: "4px",
          border: isChildExcluded
            ? "1px solid rgba(100, 116, 139, 0.15)"
            : "1px solid rgba(99, 102, 241, 0.15)",
          cursor: "pointer",
          textDecoration: isChildExcluded ? "line-through" : "none",
          opacity: isChildExcluded ? 0.6 : 1,
        }}
        title={`クリックして 8001 Open Hub で開く\n階層 ${child.depth_level} (リンク元: ${child.parent_name || "親ノート"})\nパス: ${child.full_path}`}
      >
        {/* 開閉トグルボタンまたはスペーサー */}
        {hasSubChildren ? (
          <button
            type="button"
            className="ai-tree-toggle-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(child.full_path);
            }}
            title={isCollapsed ? "展開する" : "折りたたむ"}
          >
            {isCollapsed ? "▶" : "▼"}
          </button>
        ) : (
          <span className="ai-tree-spacer" style={{ color: "rgba(99, 102, 241, 0.5)", fontSize: "11px", fontWeight: "bold" }}>
            ↳
          </span>
        )}

        {/* 除外チェックボックス */}
        <input
          type="checkbox"
          checked={!isChildExcluded}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation();
            onToggleChildNode(child.full_path);
          }}
          style={{
            cursor: "pointer",
            width: "14px",
            height: "14px",
            accentColor: "#6366f1",
            flexShrink: 0,
          }}
          title={isChildExcluded ? "コンテキストに含める" : "コンテキストから除外する"}
        />

        {/* 階層バッジ */}
        <span
          className="badge"
          style={{
            fontSize: "9.5px",
            padding: "1px 5px",
            backgroundColor: isChildExcluded
              ? "rgba(100, 116, 139, 0.2)"
              : "rgba(99, 102, 241, 0.25)",
            color: isChildExcluded ? "#94a3b8" : "#a5b4fc",
            borderRadius: "3px",
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          階層 {child.depth_level}
        </span>

        {/* ファイル名 */}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {child.file_name}
        </span>

        {/* 8001 アイコン */}
        <span style={{ fontSize: "10px", opacity: 0.6, color: "#38bdf8", flexShrink: 0 }} title="8001ハブで開く">
          ↗
        </span>

        {/* リンク元名 */}
        {child.parent_name && (
          <span style={{ fontSize: "10px", color: "#64748b", flexShrink: 0 }}>
            (リンク元: {child.parent_name})
          </span>
        )}
      </div>

      {/* サブツリー（子ノードが展開されている場合） */}
      {hasSubChildren && !isCollapsed && (
        <div className="ai-child-tree-subgroup">
          {treeNode.children.map((subChild, sIdx) => (
            <AiChildTreeNode
              key={`${subChild.node.full_path}-${sIdx}`}
              treeNode={subChild}
              excludedChildPaths={excludedChildPaths}
              collapsedNodes={collapsedNodes}
              onToggleChildNode={onToggleChildNode}
              onToggleCollapse={onToggleCollapse}
              openFileViaHub={openFileViaHub}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}


export function AiInputPage({
  initialQuery = "",
  initialExtensionFilter = "md",
  results,
  excludeKeywords,
  onOpenFileLocation,
}: AiInputPageProps) {
  const [query, setQuery] = useState(initialQuery);
  const [extensionFilterText, setExtensionFilterText] = useState(initialExtensionFilter.trim() || "md");
  const [isSearching, setIsSearching] = useState(false);
  const [rawCandidates, setRawCandidates] = useState<SearchResult[]>(() => {
    if (results && results.length > 0) {
      return results.filter(
        (r) => !isExcludedByKeywords(r.full_path, r.file_name, excludeKeywords) && isAiInputDocumentCandidate(r)
      );
    }
    return [];
  });

  // initialExtensionFilter が親から渡されたときに同期（空文字・未指定時は "md" にフォールバック）
  useEffect(() => {
    if (initialExtensionFilter !== undefined) {
      setExtensionFilterText(initialExtensionFilter.trim() || "md");
    }
  }, [initialExtensionFilter]);

  // results や excludeKeywords が渡された・更新されたときに rawCandidates を同期
  useEffect(() => {
    if (results && results.length > 0) {
      setRawCandidates(
        results.filter(
          (r) => !isExcludedByKeywords(r.full_path, r.file_name, excludeKeywords) && isAiInputDocumentCandidate(r)
        )
      );
    }
  }, [results, excludeKeywords]);

  // 拡張子フィルタ（包含・除外）を適用した表示候補
  const candidates = filterSearchResultsByExtensions(rawCandidates, extensionFilterText);

  // デフォルト選択数（初期値: 10、サーバーに保存して次回自動復元）
  const [defaultSelectCount, setDefaultSelectCount] = useState<number>(10);

  // 上位N件を自動選択する関数
  const applyAutoSelectTopN = (targetCandidates: SearchResult[], count: number) => {
    const targetCount = Math.max(0, count);
    const topPaths = targetCandidates.slice(0, targetCount).map((c) => c.full_path);
    setSelectedPaths(new Set(topPaths));
  };

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => {
    if (results && results.length > 0) {
      const initialFiltered = results.filter(
        (r) => !isExcludedByKeywords(r.full_path, r.file_name, excludeKeywords) && isAiInputDocumentCandidate(r)
      );
      const initialExt = filterSearchResultsByExtensions(initialFiltered, initialExtensionFilter.trim() || "md");
      return new Set(initialExt.slice(0, 10).map((r) => r.full_path));
    }
    return new Set();
  });

  // エクスポート設定
  const [docTitle, setDocTitle] = useState("AI_Context_Document");
  const [includeRawMarkdown, setIncludeRawMarkdown] = useState(false);
  const [includeImages, setIncludeImages] = useState(true);
  const [includeLinkedEmails, setIncludeLinkedEmails] = useState(true);
  const [optimizeTokens, setOptimizeTokens] = useState(true);

  // 生成結果
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedData, setGeneratedData] = useState<{
    html_content: string;
    total_documents: number;
    total_linked_emails?: number;
    total_images_embedded: number;
    size_bytes: number;
    file_name: string;
  } | null>(null);
  const [copiedHtml, setCopiedHtml] = useState(false);
  const [previewTab, setPreviewTab] = useState<"preview" | "code">("preview");

  // フルスクリーンプレビューモーダル & ファイル選択除外連動 & ドキュメント表示順序
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalOrderedPaths, setModalOrderedPaths] = useState<string[]>([]);
  const [modalActivePaths, setModalActivePaths] = useState<Set<string>>(new Set());
  const [onlyTopTag, setOnlyTopTag] = useState<boolean>(false);
  const [fileDepths, setFileDepths] = useState<Record<string, number>>({});
  const [expandedNodes, setExpandedNodes] = useState<ExpandedNode[]>([]);
  const [excludedChildPaths, setExcludedChildPaths] = useState<Set<string>>(new Set());
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isModalUpdating, setIsModalUpdating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [exportFolder, setExportFolder] = useState<string>("~/Desktop/AI_Inputs");
  const [tempExportFolder, setTempExportFolder] = useState<string>("~/Desktop/AI_Inputs");
  const [isFolderConfigOpen, setIsFolderConfigOpen] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [configToast, setConfigToast] = useState<string | null>(null);
  const [isSavingBundle, setIsSavingBundle] = useState(false);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const [savedPathFeedback, setSavedPathFeedback] = useState<string | null>(null);
  const modalDebounceRef = useRef<number | null>(null);

  // サーバーに保存されたエクスポートフォルダ設定およびデフォルト選択数を初期ロード（次回起動時も自動適用）
  useEffect(() => {
    getAiExportConfig()
      .then((cfg) => {
        if (cfg?.export_folder) {
          setExportFolder(cfg.export_folder);
          setTempExportFolder(cfg.export_folder);
        }
        if (cfg?.default_select_count !== undefined && cfg.default_select_count >= 0) {
          const loadedCount = cfg.default_select_count;
          setDefaultSelectCount(loadedCount);
          // 初期候補が存在する場合は復元されたカウントで自動選択
          if (candidates.length > 0) {
            applyAutoSelectTopN(candidates, loadedCount);
          }
        }
      })
      .catch((err) => {
        console.warn("保存先設定の取得に失敗しました:", err);
      });
  }, []);

  // 設定トーストの自動消去
  useEffect(() => {
    if (!configToast) return;
    const timer = setTimeout(() => setConfigToast(null), 3000);
    return () => clearTimeout(timer);
  }, [configToast]);

  // モーダル表示中の Esc キー監視
  useEffect(() => {
    if (!isModalOpen && !isFolderConfigOpen) return;
    const handleModalEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isFolderConfigOpen) {
          setIsFolderConfigOpen(false);
        } else if (isModalOpen) {
          setIsModalOpen(false);
        }
      }
    };
    window.addEventListener("keydown", handleModalEsc);
    return () => window.removeEventListener("keydown", handleModalEsc);
  }, [isModalOpen, isFolderConfigOpen]);

  // ドラッグ連続選択の状態管理
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragModeRef = useRef(true); // true: 選択 (ON), false: 解除 (OFF)

  // グローバルマウスアップ監視（ドラッグ終了）
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        setIsDragging(false);
      }
    };
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, []);

  // 候補検索実行
  const handleSearchCandidates = async (overrideQuery?: string) => {
    const q = overrideQuery !== undefined ? overrideQuery : query;
    if (!q || !q.trim()) {
      alert("質問や探したいキーワードを入力してください");
      return;
    }

    setIsSearching(true);
    try {
      const res = await search({
        q: q.trim(),
        full_path: "",
        search_all_enabled: true,
        refresh_window_minutes: 0,
        search_type: "hybrid",
        exclude_keywords: excludeKeywords,
        types: extensionFilterText.trim() || undefined,
        limit: 40,
      });

      const filteredItems = res.items.filter(
        (it) => !isExcludedByKeywords(it.full_path, it.file_name, excludeKeywords) && isAiInputDocumentCandidate(it)
      );
      setRawCandidates(filteredItems);
      const extFiltered = filterSearchResultsByExtensions(filteredItems, extensionFilterText);
      applyAutoSelectTopN(extFiltered, defaultSelectCount);

      // クエリから安全なタイトルを自動設定
      const safeQ = q.trim().replace(/[\\/*?:"<>| ]+/g, "_").slice(0, 30);
      setDocTitle(`AI_Context_${safeQ || "Export"}`);
    } catch (err: any) {
      alert(`候補ドキュメントの検索に失敗しました: ${err.message}`);
    } finally {
      setIsSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (e.nativeEvent.isComposing || (e as any).keyCode === 229) {
        return;
      }
      void handleSearchCandidates();
    }
  };

  // チェックボックスでのマウスダウン（ドラッグ選択開始）
  const handleCheckboxMouseDown = (e: React.MouseEvent, path: string) => {
    if (e.button !== 0) return; // 左クリックのみ
    e.preventDefault();

    const isDeselect = e.shiftKey;
    const targetMode = !isDeselect;
    dragModeRef.current = targetMode;
    isDraggingRef.current = true;
    setIsDragging(true);

    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (targetMode) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  };

  // 行 / チェックボックス上をマウスが通過した時（ドラッグ継続中）
  const handleRowMouseEnter = (e: React.MouseEvent, path: string) => {
    if (!isDraggingRef.current) return;

    const targetMode = e.shiftKey ? false : dragModeRef.current;
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (targetMode) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  };

  // 通常クリックでの単一トグル
  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedPaths(new Set(candidates.map((c) => c.full_path)));
  };

  const deselectAll = () => {
    setSelectedPaths(new Set());
  };

  // デフォルト選択数の変更とサーバー永続化
  const handleDefaultSelectCountChange = async (valStr: string) => {
    const parsed = parseInt(valStr, 10);
    const newCount = isNaN(parsed) ? 0 : Math.max(0, parsed);
    setDefaultSelectCount(newCount);
    applyAutoSelectTopN(candidates, newCount);
    try {
      await saveAiExportConfig({ default_select_count: newCount });
    } catch (e) {
      console.warn("デフォルト選択数の保存に失敗しました:", e);
    }
  };

  // 推定トークン数の計算（選択された候補の概算）
  const estimatedChars = candidates
    .filter((c) => selectedPaths.has(c.full_path))
    .reduce((acc, c) => acc + (c.snippet?.length || 500) + 1500, 0); // 1ファイル平均約1.5k〜3k文字
  const estimatedTokens = Math.round(estimatedChars * 1.1);

  // 各ノートのデフォルトリンク階層数（topタグありは5、それ以外は1）
  const getNoteDefaultDepth = (path: string): number => {
    const item = candidates.find((c) => c.full_path === path) || rawCandidates.find((c) => c.full_path === path);
    return item?.has_obsidian_top_tag ? 5 : 1;
  };

  // 現在のモーダルフィルタ（onlyTopTag等）を反映した有効アクティブパス一覧
  const getActivePathsForRegeneration = (
    orderedPaths = modalOrderedPaths,
    activeSet = modalActivePaths,
    isTopTagOnly = onlyTopTag
  ): string[] => {
    return orderedPaths.filter((p) => {
      if (!activeSet.has(p)) return false;
      if (isTopTagOnly) {
        const item = candidates.find((c) => c.full_path === p) || rawCandidates.find((c) => c.full_path === p);
        return item?.has_obsidian_top_tag === true;
      }
      return true;
    });
  };

  // HTML生成実行
  const handleGenerateHtml = async () => {
    // 候補リストの表示順序を維持してパス配列を生成
    const ordered = candidates.filter((c) => selectedPaths.has(c.full_path)).map((c) => c.full_path);
    selectedPaths.forEach((p) => {
      if (!ordered.includes(p)) ordered.push(p);
    });
    const paths = ordered.length > 0 ? ordered : Array.from(selectedPaths);

    if (paths.length === 0) {
      alert("エクスポートするドキュメントを1件以上選択してください");
      return;
    }

    // 初期深度マップの構築（topタグあり: 5, 他: 1）
    const initialDepths: Record<string, number> = { ...fileDepths };
    paths.forEach((p) => {
      if (initialDepths[p] === undefined) {
        initialDepths[p] = getNoteDefaultDepth(p);
      }
    });
    setFileDepths(initialDepths);

    setIsGenerating(true);
    try {
      const res = await generateAiHtml({
        file_paths: paths,
        file_depths: initialDepths,
        prompt: "",
        title: docTitle || "AI_Context_Document",
        include_raw_markdown: includeRawMarkdown,
        include_images: includeImages,
        include_linked_emails: includeLinkedEmails,
        optimize_tokens: optimizeTokens,
      });

      const sizeBytes = new Blob([res.html_content]).size;
      setGeneratedData({
        html_content: res.html_content,
        total_documents: res.total_documents ?? paths.length,
        total_linked_emails: res.total_linked_emails ?? 0,
        total_images_embedded: res.total_images_embedded ?? 0,
        size_bytes: sizeBytes,
        file_name: `${docTitle || "AI_Context_Document"}.html`,
      });
      setExpandedNodes(res.expanded_nodes || []);
      setExcludedChildPaths(new Set());
      setCollapsedNodes(new Set());
      setModalOrderedPaths(paths);
      setModalActivePaths(new Set(paths));
      setIsModalOpen(true);
    } catch (err: any) {
      alert(`HTML生成に失敗しました: ${err.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // モーダル内でのファイルチェック切り替え & 順序を維持したデバウンス再生成
  const handleToggleModalFile = (path: string) => {
    setModalActivePaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        if (next.size <= 1) {
          alert("少なくとも1件のファイルを選択してください。");
          return prev;
        }
        next.delete(path);
      } else {
        next.add(path);
      }

      const activePathsInOrder = getActivePathsForRegeneration(modalOrderedPaths, next);
      if (modalDebounceRef.current) {
        window.clearTimeout(modalDebounceRef.current);
      }
      modalDebounceRef.current = window.setTimeout(() => {
        void regenerateModalHtml(activePathsInOrder);
      }, 200);

      return next;
    });
  };

  // モーダル内でのファイル表示順序変更（▲: 上へ / ▼: 下へ）
  const handleMoveModalFile = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= modalOrderedPaths.length) return;

    const nextPaths = [...modalOrderedPaths];
    const temp = nextPaths[index];
    nextPaths[index] = nextPaths[targetIndex];
    nextPaths[targetIndex] = temp;

    setModalOrderedPaths(nextPaths);

    // チェックが入っているドキュメントのみを並び替え後の順序で取得
    const activePathsInOrder = getActivePathsForRegeneration(nextPaths, modalActivePaths);
    if (modalDebounceRef.current) {
      window.clearTimeout(modalDebounceRef.current);
    }
    modalDebounceRef.current = window.setTimeout(() => {
      void regenerateModalHtml(activePathsInOrder);
    }, 200);
  };

  // モーダル内でのドラッグ＆ドロップによるドキュメント順序変更
  const handleDropModalFile = (targetIndex: number) => {
    if (draggedIndex === null || draggedIndex === targetIndex) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    const nextPaths = [...modalOrderedPaths];
    const [draggedItem] = nextPaths.splice(draggedIndex, 1);
    nextPaths.splice(targetIndex, 0, draggedItem);

    setModalOrderedPaths(nextPaths);
    setDraggedIndex(null);
    setDragOverIndex(null);

    // チェックが入っているドキュメントを並び替え後の順序で取得してHTML再生成
    const activePathsInOrder = getActivePathsForRegeneration(nextPaths, modalActivePaths);
    if (modalDebounceRef.current) {
      window.clearTimeout(modalDebounceRef.current);
    }
    modalDebounceRef.current = window.setTimeout(() => {
      void regenerateModalHtml(activePathsInOrder);
    }, 200);
  };

  // 各ノートのリンク展開階層数の変更
  const handleDepthChange = (path: string, valStr: string) => {
    const parsed = parseInt(valStr, 10);
    const depth = isNaN(parsed) ? 0 : Math.max(0, Math.min(10, parsed));
    setFileDepths((prev) => {
      const next = { ...prev, [path]: depth };
      if (modalDebounceRef.current) {
        window.clearTimeout(modalDebounceRef.current);
      }
      const activePaths = getActivePathsForRegeneration();
      modalDebounceRef.current = window.setTimeout(() => {
        void regenerateModalHtml(activePaths, next);
      }, 200);
      return next;
    });
  };

  // obsidianのtopタグのみを出す チェックボックスの切り替え
  const handleToggleOnlyTopTag = (checked: boolean) => {
    setOnlyTopTag(checked);
    const activePaths = getActivePathsForRegeneration(modalOrderedPaths, modalActivePaths, checked);
    if (activePaths.length === 0 && checked) {
      alert("topタグを含むノートが選択されていません");
      return;
    }
    if (modalDebounceRef.current) {
      window.clearTimeout(modalDebounceRef.current);
    }
    modalDebounceRef.current = window.setTimeout(() => {
      void regenerateModalHtml(activePaths);
    }, 100);
  };

  // 展開された子ノードの個別除外・復帰トグル
  const handleToggleChildNode = (childPath: string) => {
    setExcludedChildPaths((prev) => {
      const next = new Set(prev);
      if (next.has(childPath)) {
        next.delete(childPath);
      } else {
        next.add(childPath);
      }
      if (modalDebounceRef.current) {
        window.clearTimeout(modalDebounceRef.current);
      }
      const activePathsInOrder = getActivePathsForRegeneration();
      modalDebounceRef.current = window.setTimeout(() => {
        void regenerateModalHtml(activePathsInOrder, undefined, next);
      }, 200);
      return next;
    });
  };

  // ツリーノードの開閉（折りたたみ/展開）トグル (spoon_feeder2 風)
  const toggleNodeCollapse = (path: string) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // すべてのツリーを展開する
  const expandAllNodes = () => {
    setCollapsedNodes(new Set());
  };

  // すべてのツリーを折りたたむ
  const collapseAllNodes = () => {
    const all = new Set<string>();
    modalOrderedPaths.forEach((p) => all.add(p));
    expandedNodes.forEach((n) => all.add(n.full_path));
    setCollapsedNodes(all);
  };

  // モーダル内でのHTML自動再生成（指定された配列順序および階層数設定を厳格に保持）
  const regenerateModalHtml = async (
    pathsOrSet: string[] | Set<string> = getActivePathsForRegeneration(),
    overrideDepths?: Record<string, number>,
    overrideExcluded?: Set<string>
  ) => {
    const paths = Array.isArray(pathsOrSet) ? pathsOrSet : Array.from(pathsOrSet);
    if (paths.length === 0) return;
    setIsModalUpdating(true);
    try {
      const currentDepths = overrideDepths || fileDepths;
      const activeDepths: Record<string, number> = {};
      paths.forEach((p) => {
        activeDepths[p] = currentDepths[p] ?? getNoteDefaultDepth(p);
      });
      const activeExcluded = overrideExcluded || excludedChildPaths;

      const res = await generateAiHtml({
        file_paths: paths,
        file_depths: activeDepths,
        excluded_file_paths: Array.from(activeExcluded),
        prompt: "",
        title: docTitle || "AI_Context_Document",
        include_raw_markdown: includeRawMarkdown,
        include_images: includeImages,
        include_linked_emails: includeLinkedEmails,
        optimize_tokens: optimizeTokens,
      });

      const sizeBytes = new Blob([res.html_content]).size;
      setGeneratedData({
        html_content: res.html_content,
        total_documents: res.total_documents ?? paths.length,
        total_linked_emails: res.total_linked_emails ?? 0,
        total_images_embedded: res.total_images_embedded ?? 0,
        size_bytes: sizeBytes,
        file_name: `${docTitle || "AI_Context_Document"}.html`,
      });
      setExpandedNodes(res.expanded_nodes || []);
    } catch (err: any) {
      console.error("HTML再生成に失敗しました:", err);
    } finally {
      setIsModalUpdating(false);
    }
  };

  // ローカルファイル保存 & 絶対パスをクリップボードにコピー
  const handleSaveHtmlAndCopyPath = async () => {
    if (!generatedData?.html_content) return;
    setIsSaving(true);
    let res: { success: boolean; saved_path: string; file_name: string; size_bytes: number } | undefined;
    try {
      res = await saveAiHtmlToFile({
        html_content: generatedData.html_content,
        file_name: generatedData.file_name || `${docTitle || "AI_Context_Document"}.html`,
      });
    } catch (err: any) {
      alert(`HTML保存に失敗しました: ${err.message}`);
      setIsSaving(false);
      return;
    } finally {
      setIsSaving(false);
    }

    if (res?.saved_path) {
      const copied = await copyTextToClipboard(res.saved_path);
      if (copied) {
        setSavedPathFeedback(`✅ パスをコピーしました: ${res.saved_path}`);
      } else {
        setSavedPathFeedback(`✅ HTML保存完了 (パス手動コピー): ${res.saved_path}`);
      }
      setTimeout(() => setSavedPathFeedback(null), 8000);
    }
  };

  // マークダウン＆結合画像の2ファイルを指定フォルダに保存
  const handleSaveBundle = async () => {
    let paths = isModalOpen
      ? modalOrderedPaths.filter((p) => modalActivePaths.has(p))
      : Array.from(selectedPaths);

    if (isModalOpen && onlyTopTag) {
      paths = paths.filter((p) => {
        const item = candidates.find((c) => c.full_path === p) || rawCandidates.find((c) => c.full_path === p);
        return item?.has_obsidian_top_tag === true;
      });
    }

    if (paths.length === 0) {
      alert("対象ドキュメントが選択されていません");
      return;
    }

    setIsSavingBundle(true);
    try {
      const activeDepths: Record<string, number> = {};
      paths.forEach((p) => {
        activeDepths[p] = fileDepths[p] ?? getNoteDefaultDepth(p);
      });

      const res = await saveAiBundleToFile({
        file_paths: paths,
        file_depths: activeDepths,
        excluded_file_paths: Array.from(excludedChildPaths),
        title: docTitle || "AIコンテキスト統合ドキュメント",
        file_base_name: docTitle || "AI_Context_Document",
        target_dir: exportFolder,
        optimize_tokens: optimizeTokens,
        include_linked_emails: includeLinkedEmails,
      });

      if (res.success) {
        const msg = res.has_images
          ? `✅ 2ファイル保存完了: ${res.markdown_name} & ${res.image_name}`
          : `✅ マークダウン保存完了: ${res.markdown_name}`;
        setSavedPathFeedback(msg);
        setTimeout(() => setSavedPathFeedback(null), 10000);
      }
    } catch (err: any) {
      alert(`保存に失敗しました: ${err.message}`);
    } finally {
      setIsSavingBundle(false);
    }
  };

  // 出力先フォルダを OS で開く (Finder / Explorer)
  const handleOpenFolder = async () => {
    setIsOpeningFolder(true);
    try {
      await openExportFolder(exportFolder);
    } catch (err: any) {
      alert(`フォルダを開けませんでした: ${err.message}`);
    } finally {
      setIsOpeningFolder(false);
    }
  };

  // 保存先フォルダ設定をサーバーに永続保存する
  const handleSaveExportFolderConfig = async () => {
    const trimmed = tempExportFolder.trim();
    if (!trimmed) {
      alert("保存先フォルダのパスを入力してください");
      return;
    }
    setIsSavingConfig(true);
    try {
      const res = await saveAiExportConfig(trimmed);
      if (res?.export_folder) {
        setExportFolder(res.export_folder);
        setTempExportFolder(res.export_folder);
      }
      setConfigToast(`✅ 保存先フォルダを設定しました: ${res.export_folder}`);
      setIsFolderConfigOpen(false);
    } catch (err: any) {
      alert(`保存先フォルダの設定保存に失敗しました: ${err.message}`);
    } finally {
      setIsSavingConfig(false);
    }
  };

  // ファイルダウンロード
  const handleDownload = () => {
    if (!generatedData?.html_content) return;
    const blob = new Blob([generatedData.html_content], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = generatedData.file_name || `${docTitle}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // HTMLコードのコピー
  const copyHtmlCode = () => {
    if (!generatedData?.html_content) return;
    void copyTextToClipboard(generatedData.html_content);
    setCopiedHtml(true);
    setTimeout(() => setCopiedHtml(false), 2000);
  };

  // 8001 ハブで開く
  const openFileViaHub = (fullPath: string) => {
    const hubBase = "http://127.0.0.1:8001";
    const targetUrl = `${hubBase}/api/fullpath?path=${encodeURIComponent(fullPath)}`;
    window.open(targetUrl, "_blank");
  };

  return (
    <div className="ai-input-page-container" style={{ padding: "16px 20px" }}>
      {/* イントロダクションバナー */}
      <div
        className="panel glass-panel"
        style={{
          marginBottom: "16px",
          padding: "16px 22px",
          background: "linear-gradient(135deg, rgba(99, 102, 241, 0.16), rgba(168, 85, 247, 0.16))",
          border: "1px solid rgba(168, 85, 247, 0.4)",
          borderRadius: "14px",
          backdropFilter: "blur(16px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <span style={{ fontSize: "24px", flexShrink: 0 }}>✨</span>
          <div>
            <strong style={{ fontSize: "15px", color: "#f8fafc" }}>
              🤖 ChatAI インプット用 HTMLドキュメントビルダー
            </strong>
            <div style={{ fontSize: "12.5px", color: "var(--text-muted, #94a3b8)", marginTop: "3px", lineHeight: "1.5" }}>
              ChatGPT、Claude、社内チャットAIなどの外部AIに、複数ドキュメント＋図面・画像（Base64内包）＋Markdown原文を1つの自己完結HTMLファイルとしてワンショット投入できます。
            </div>
          </div>
        </div>
      </div>

      {/* ステップ1: 質問・キーワード検索 & 候補抽出 */}
      <div className="panel glass-panel" style={{ marginBottom: "16px", padding: "18px 22px", borderRadius: "14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
          <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: "8px", color: "#f8fafc" }}>
            <span>🔍</span>
            ステップ 1: 質問・キーワードで関連候補ノートを抽出
          </h2>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            {/* 保存先フォルダのミニバッジ */}
            <div
              style={{
                fontSize: "11.5px",
                color: "#cbd5e1",
                background: "rgba(255, 255, 255, 0.06)",
                padding: "3px 8px",
                borderRadius: "6px",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                maxWidth: "240px",
              }}
              title={`現在の保存先フォルダ: ${exportFolder}`}
            >
              <span>📁</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {exportFolder}
              </span>
            </div>

            {/* 保存先フォルダ設定ボタン */}
            <button
              type="button"
              className="btn btn-secondary"
              style={{
                fontSize: "12px",
                padding: "4px 10px",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                borderRadius: "6px",
                borderColor: "rgba(59, 130, 246, 0.4)",
              }}
              onClick={() => {
                setTempExportFolder(exportFolder);
                setIsFolderConfigOpen(true);
              }}
              title="AIインプット保存先フォルダを設定・サーバーに永続保存します"
            >
              <span>⚙️</span>
              保存先設定
            </button>

            {/* Explorerで開くボタン */}
            <button
              type="button"
              className="btn btn-secondary"
              style={{
                fontSize: "12px",
                padding: "4px 10px",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                borderRadius: "6px",
              }}
              onClick={() => void handleOpenFolder()}
              disabled={isOpeningFolder}
              title="保存先フォルダをOSのファイルマネージャー（Explorer / Finder）で開きます"
            >
              {isOpeningFolder ? <span className="spin">🔄</span> : <span>📂</span>}
              Explorerで開く
            </button>

            <div style={{ fontSize: "11.5px", color: "#94a3b8", background: "rgba(255, 255, 255, 0.05)", padding: "3px 10px", borderRadius: "6px", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
              ⚡ <strong>ハイブリッド検索（Vector × FTS5）</strong>
            </div>
          </div>
        </div>

        {/* 設定変更時のトースト通知 */}
        {configToast && (
          <div
            style={{
              marginTop: "8px",
              padding: "6px 12px",
              backgroundColor: "rgba(16, 185, 129, 0.15)",
              border: "1px solid rgba(16, 185, 129, 0.4)",
              color: "#34d399",
              borderRadius: "6px",
              fontSize: "12px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span>{configToast}</span>
          </div>
        )}


        <div style={{ display: "flex", gap: "10px", marginTop: "14px", alignItems: "center" }}>
          <input
            type="text"
            className="input-field"
            style={{ flex: 1, fontSize: "15px", padding: "10px 14px", borderRadius: "8px" }}
            placeholder="AIに回答させたい質問やテーマを入力（例: 次期システム刷新の決定事項、PJ-Xの仕様と課題）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isSearching}
          />
          <input
            className="small-input extension-filter-input"
            style={{
              minWidth: "160px",
              maxWidth: "240px",
              fontSize: "14px",
              padding: "10px 14px",
              borderRadius: "8px",
            }}
            value={extensionFilterText}
            onChange={(e) => setExtensionFilterText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="md excalidraw"
            title="拡張子フィルタ (例: md, -png, -.jpg)"
            aria-label="検索拡張子フィルタ"
            disabled={isSearching}
          />
          <button
            className="btn btn-primary"
            style={{ padding: "0 22px", fontSize: "14px", minWidth: "170px", borderRadius: "8px", fontWeight: 600, height: "42px" }}
            onClick={() => void handleSearchCandidates()}
            disabled={isSearching}
          >
            {isSearching ? (
              <>
                <span className="spin">🔄</span>
                検索中...
              </>
            ) : (
              <>
                <span>✨</span>
                候補ノートを抽出
              </>
            )}
          </button>
        </div>
      </div>

      {/* ステップ2: 候補ドキュメントの選択 (ドラッグ選択対応テーブル) */}
      {candidates.length > 0 && (
        <div className="panel glass-panel" style={{ marginBottom: "16px", padding: "18px 22px", borderRadius: "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: "8px", color: "#f8fafc" }}>
                <span>☑️</span>
                ステップ 2: AIにインプットするノートを選択
              </h2>
              <span className="badge" style={{ backgroundColor: "rgba(168, 85, 247, 0.2)", color: "#c084fc", fontSize: "12px", padding: "2px 8px" }}>
                {selectedPaths.size} / {candidates.length} 件 選択中
              </span>
              {selectedPaths.size > 0 && (
                <span style={{ fontSize: "12px", color: "#38bdf8", fontWeight: 500 }}>
                  約 {estimatedTokens.toLocaleString()} トークン
                </span>
              )}
              <span style={{ fontSize: "11.5px", color: "#94a3b8" }}>
                💡 <strong>ドラッグ</strong>で連続選択 / <strong>Shift+ドラッグ</strong>で連続解除
              </span>
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <button
                className="btn btn-primary ai-generate-top-btn"
                title="AI用HTMLファイルを生成する"
                onClick={() => void handleGenerateHtml()}
                disabled={isGenerating || selectedPaths.size === 0}
              >
                {isGenerating ? (
                  <>
                    <span className="spin">🔄</span>
                    HTML生成中...
                  </>
                ) : (
                  <>
                    <span>🚀</span>
                    AI用HTMLファイルを生成する ({selectedPaths.size}件)
                  </>
                )}
              </button>
              <button className="btn btn-secondary" style={{ fontSize: "12px", padding: "4px 12px" }} onClick={selectAll}>
                全選択
              </button>
              <button className="btn btn-secondary" style={{ fontSize: "12px", padding: "4px 12px" }} onClick={deselectAll}>
                全解除
              </button>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  marginLeft: "4px",
                  padding: "3px 8px",
                  borderRadius: "6px",
                  backgroundColor: "rgba(255, 255, 255, 0.05)",
                  border: "1px solid rgba(255, 255, 255, 0.12)",
                  fontSize: "12px",
                  color: "#cbd5e1",
                }}
                title="検索時に上位から自動で選択する件数（サーバーに保存され次回起動時も維持されます）"
              >
                <span>デフォルト選択数:</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  className="default-select-count-input"
                  style={{
                    width: "48px",
                    padding: "2px 4px",
                    borderRadius: "4px",
                    border: "1px solid rgba(255, 255, 255, 0.2)",
                    backgroundColor: "#0f172a",
                    color: "#f8fafc",
                    fontSize: "12px",
                    textAlign: "center",
                    fontWeight: "bold",
                  }}
                  value={defaultSelectCount}
                  onChange={(e) => void handleDefaultSelectCountChange(e.target.value)}
                />
                <span>件</span>
              </div>
            </div>
          </div>

          <div
            className="table-responsive-container ai-candidate-table-container"
            style={{
              height: "calc(100vh - 210px)",
              minHeight: "480px",
              overflowY: "auto",
              userSelect: isDragging ? "none" : "auto",
              cursor: isDragging ? (dragModeRef.current ? "crosshair" : "not-allowed") : "auto",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              borderRadius: "8px",
            }}
          >
            <table className="ai-export-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead style={{ position: "sticky", top: 0, backgroundColor: "#1e293b", zIndex: 2 }}>
                <tr style={{ textAlign: "left", color: "#94a3b8", borderBottom: "1px solid rgba(255, 255, 255, 0.1)" }}>
                  <th style={{ width: "48px", textAlign: "center", padding: "8px 4px" }}>選択</th>
                  <th style={{ width: "55px", padding: "8px" }}>順位</th>
                  <th style={{ width: "120px", padding: "8px" }}>一致種別</th>
                  <th style={{ padding: "8px", minWidth: "160px" }}>ノートタイトル</th>
                  <th style={{ padding: "8px", minWidth: "180px" }}>パス</th>
                  <th style={{ padding: "8px" }}>スニペット / 根拠文</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((item, idx) => {
                  const isChecked = selectedPaths.has(item.full_path);
                  return (
                    <tr
                      key={item.full_path}
                      className={isChecked ? "row-selected" : ""}
                      onMouseEnter={(e) => handleRowMouseEnter(e, item.full_path)}
                      style={{
                        cursor: "pointer",
                        backgroundColor: isChecked ? "rgba(99, 102, 241, 0.15)" : "transparent",
                        borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
                      }}
                    >
                      <td
                        style={{
                          textAlign: "center",
                          cursor: "pointer",
                          padding: "8px 4px",
                          userSelect: "none",
                        }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          handleCheckboxMouseDown(e, item.full_path);
                        }}
                        title="ドラッグで連続選択 / Shift+ドラッグで連続解除"
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          style={{ cursor: "pointer", width: "16px", height: "16px", accentColor: "#6366f1" }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            handleCheckboxMouseDown(e, item.full_path);
                          }}
                        />
                      </td>
                      <td
                        style={{ padding: "8px", fontFamily: "monospace", fontWeight: 600, color: "#38bdf8" }}
                        onClick={() => toggleSelect(item.full_path)}
                      >
                        #{idx + 1}
                      </td>
                      <td style={{ padding: "8px" }} onClick={() => toggleSelect(item.full_path)}>
                        {item.match_source === "both" && (
                          <span className="badge badge-both" style={{ fontSize: "11px" }}>🌟 両方一致</span>
                        )}
                        {item.match_source === "vector" && (
                          <span className="badge badge-vector" style={{ fontSize: "11px" }}>🔮 意味一致</span>
                        )}
                        {item.match_source === "keyword" && (
                          <span className="badge badge-keyword" style={{ fontSize: "11px" }}>🏷️ キーワード</span>
                        )}
                        {!item.match_source && (
                          <span className="badge" style={{ fontSize: "11px", color: "#94a3b8" }}>通常一致</span>
                        )}
                      </td>
                      <td style={{ padding: "8px" }}>
                        <button
                          type="button"
                          className="table-title-link"
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "#60a5fa",
                            cursor: "pointer",
                            textAlign: "left",
                            fontWeight: 600,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            openFileViaHub(item.full_path);
                          }}
                          title="8001 Open Hub で開く"
                        >
                          <span>{item.file_name}</span>
                          <span style={{ fontSize: "11px" }}>↗</span>
                        </button>
                      </td>
                      <td
                        style={{ padding: "8px", fontFamily: "monospace", fontSize: "11px", color: "#94a3b8" }}
                        onClick={() => toggleSelect(item.full_path)}
                      >
                        {item.full_path}
                      </td>
                      <td
                        style={{ padding: "8px", fontSize: "11.5px", color: "#cbd5e1", maxWidth: "340px", lineHeight: "1.4" }}
                        onClick={() => toggleSelect(item.full_path)}
                      >
                        {(() => {
                          const formatted = truncateSnippet(item, 200);
                          return formatted.includes("<mark>") ? (
                            <span dangerouslySetInnerHTML={{ __html: formatted }} />
                          ) : (
                            <span>{formatted}</span>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ステップ3: 生成結果プレビュー & ダウンロード */}
      {generatedData && (
        <div
          className="panel glass-panel"
          style={{
            marginTop: "20px",
            padding: "18px 22px",
            borderRadius: "14px",
            border: "1px solid rgba(16, 185, 129, 0.4)",
          }}
        >
          {/* 結果ヘッダー */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "12px",
              borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
              paddingBottom: "14px",
              marginBottom: "14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "20px" }}>✅</span>
              <div>
                <strong style={{ fontSize: "15px", color: "#f8fafc" }}>
                  自己完結型 HTML ファイルの生成が完了しました！
                </strong>
                <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}>
                  ドキュメント: {generatedData.total_documents} 件
                  {typeof generatedData.total_linked_emails === "number" && generatedData.total_linked_emails > 0 && ` | メール: ${generatedData.total_linked_emails} 件`}
                  {typeof generatedData.total_images_embedded === "number" && generatedData.total_images_embedded > 0 && ` | 埋め込み画像: ${generatedData.total_images_embedded} 枚`}
                  {" "}| サイズ: {(generatedData.size_bytes / 1024).toFixed(1)} KB | 概算トークン: 約 {estimatedTokens.toLocaleString()}
                </div>
              </div>
            </div>

            {savedPathFeedback && (
              <div
                style={{
                  width: "100%",
                  marginBottom: "12px",
                  padding: "8px 14px",
                  borderRadius: "8px",
                  background: "rgba(16, 185, 129, 0.15)",
                  border: "1px solid rgba(16, 185, 129, 0.4)",
                  color: "#10b981",
                  fontSize: "13px",
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  wordBreak: "break-all",
                }}
              >
                <span>{savedPathFeedback}</span>
                <button
                  className="btn btn-sm btn-secondary"
                  style={{ marginLeft: "10px", fontSize: "11px", padding: "2px 8px" }}
                  onClick={() => setSavedPathFeedback(null)}
                >
                  ✕
                </button>
              </div>
            )}

            {/* アクションボタン群 */}
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
              <button
                className="btn btn-primary"
                style={{ padding: "8px 18px", fontSize: "13.5px", background: "linear-gradient(135deg, #6366f1, #a855f7)", border: "none", fontWeight: 600 }}
                onClick={() => setIsModalOpen(true)}
              >
                <span>👁️</span>
                特大モーダルでプレビュー & 選択調整
              </button>

              {/* 出力先フォルダ入力 */}
              <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "12px", color: "#94a3b8" }}>📁 保存先:</span>
                <input
                  type="text"
                  className="input-text"
                  value={exportFolder}
                  onChange={(e) => setExportFolder(e.target.value)}
                  style={{
                    fontSize: "12px",
                    padding: "4px 8px",
                    width: "160px",
                    borderRadius: "6px",
                    backgroundColor: "rgba(0, 0, 0, 0.3)",
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                    color: "#f8fafc",
                  }}
                  title="2ファイルの出力先フォルダパス"
                />
              </div>

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
                disabled={isSavingBundle}
                title="マークダウン(.md)と全図面を縦連結した結合画像(<=4.5MB)の2ファイルを保存します"
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
                className="btn btn-secondary"
                style={{ padding: "8px 18px", fontSize: "13.5px", fontWeight: 600 }}
                onClick={() => void handleSaveHtmlAndCopyPath()}
                disabled={isSaving}
                title="HTMLをローカル保存してパスをコピー"
              >
                <span>💾</span>
                HTML保存
              </button>

              <button
                className="btn btn-secondary"
                style={{ fontSize: "13px", padding: "6px 14px" }}
                onClick={handleDownload}
                title="HTMLダウンロード"
              >
                <span>📥</span>
                HTML DL
              </button>

              <button
                className="btn btn-secondary"
                style={{ fontSize: "13px", padding: "6px 14px" }}
                onClick={copyHtmlCode}
              >
                {copiedHtml ? "✅ コードをコピー完了！" : "📋 HTMLコピー"}
              </button>
            </div>
          </div>

          {/* ビュー切り替えタブ */}
          <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <button
              className={`btn btn-sm ${previewTab === "preview" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setPreviewTab("preview")}
            >
              <span>👁️</span>
              プレビュー表示
            </button>
            <button
              className={`btn btn-sm ${previewTab === "code" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setPreviewTab("code")}
            >
              <span>📄</span>
              HTMLソース
            </button>
          </div>

          {/* プレビューコンテナ */}
          {previewTab === "preview" ? (
            <div
              className="html-preview-frame-container"
              style={{
                width: "100%",
                height: "560px",
                borderRadius: "8px",
                overflow: "hidden",
                border: "1px solid rgba(255, 255, 255, 0.12)",
                backgroundColor: "#ffffff",
              }}
            >
              <iframe
                title="AI Context HTML Preview"
                srcDoc={generatedData.html_content}
                style={{ width: "100%", height: "100%", border: "none" }}
              />
            </div>
          ) : (
            <pre
              className="rag-code-block"
              style={{
                maxHeight: "500px",
                overflowY: "auto",
                padding: "14px",
                borderRadius: "8px",
                backgroundColor: "rgba(0, 0, 0, 0.4)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                fontSize: "12px",
                color: "#94a3b8",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {generatedData.html_content}
            </pre>
          )}
        </div>
      )}

      {/* 特大プレビュー & ファイル選択モーダル */}
      {isModalOpen && generatedData && (
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
                  title="マークダウン(.md)と全図面を縦連結した結合画像(<=4.5MB)の2ファイルを保存します"
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

                <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                  {previewTab === "preview" ? (
                    <iframe
                      title="AI Context HTML Preview Modal"
                      srcDoc={generatedData.html_content}
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
                      {generatedData.html_content}
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
                        onChange={(e) => {
                          setOptimizeTokens(e.target.checked);
                          const activePathsInOrder = getActivePathsForRegeneration();
                          if (modalDebounceRef.current) {
                            window.clearTimeout(modalDebounceRef.current);
                          }
                          modalDebounceRef.current = window.setTimeout(() => {
                            void regenerateModalHtml(activePathsInOrder);
                          }, 50);
                        }}
                      />
                      <span>🧹 トークン最適化</span>
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
                              {item.has_obsidian_top_tag && (
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
                              value={fileDepths[fullPath] ?? (item?.has_obsidian_top_tag ? 5 : 1)}
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
      )}

      {/* 保存先フォルダ設定モーダル */}
      {isFolderConfigOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            backgroundColor: "rgba(0, 0, 0, 0.75)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10000,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsFolderConfigOpen(false);
          }}
        >
          <div
            className="glass-panel"
            style={{
              backgroundColor: "rgba(15, 23, 42, 0.96)",
              border: "1px solid rgba(255, 255, 255, 0.16)",
              borderRadius: "14px",
              padding: "24px 26px",
              width: "520px",
              maxWidth: "92vw",
              boxShadow: "0 24px 48px rgba(0, 0, 0, 0.7)",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            {/* モーダルヘッダー */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "#f8fafc", display: "flex", alignItems: "center", gap: "8px" }}>
                <span>📁</span> 保存先フォルダの設定
              </h3>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: "4px 8px", fontSize: "12px", borderRadius: "6px" }}
                onClick={() => setIsFolderConfigOpen(false)}
              >
                ✕
              </button>
            </div>

            <div style={{ fontSize: "12.5px", color: "#94a3b8", lineHeight: "1.6" }}>
              AIインプット用の統合マークダウン（<code>.md</code>）および全図面を縦連結した結合画像（<code>.png</code> / <code>.jpg</code>）を保存するローカルフォルダを指定します。
              <br />
              設定したフォルダは<strong>サーバー側に永続保存</strong>され、次回アプリ起動時や画面再読み込み時にも自動的に初期指定されます。
            </div>

            {/* パス入力欄 */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12.5px", color: "#cbd5e1", fontWeight: 500 }}>
                保存先フォルダパス:
              </label>
              <input
                type="text"
                className="input-field"
                style={{
                  fontSize: "13.5px",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  width: "100%",
                  boxSizing: "border-box",
                  backgroundColor: "rgba(0, 0, 0, 0.35)",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  color: "#f8fafc",
                }}
                value={tempExportFolder}
                onChange={(e) => setTempExportFolder(e.target.value)}
                placeholder="例: ~/Desktop/AI_Inputs または C:\Users\user\AI_Inputs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleSaveExportFolderConfig();
                  } else if (e.key === "Escape") {
                    setIsFolderConfigOpen(false);
                  }
                }}
              />
              <span style={{ fontSize: "11px", color: "#64748b" }}>
                ※「~」から始まるパスはユーザーのホームディレクトリに自動展開されます。
              </span>
            </div>

            {/* ボタン群 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "8px" }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: "12px", padding: "6px 12px", display: "inline-flex", alignItems: "center", gap: "5px" }}
                onClick={() => setTempExportFolder("~/Desktop/AI_Inputs")}
                title="初期値 ~/Desktop/AI_Inputs にリセットします"
              >
                <span>🔄</span> 既定値に戻す
              </button>

              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: "12.5px", padding: "6px 14px" }}
                  onClick={() => setIsFolderConfigOpen(false)}
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{
                    fontSize: "12.5px",
                    padding: "6px 18px",
                    fontWeight: 600,
                    background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
                    border: "none",
                    borderRadius: "8px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                  onClick={() => void handleSaveExportFolderConfig()}
                  disabled={isSavingConfig}
                >
                  {isSavingConfig ? (
                    <>
                      <span className="spin">🔄</span>
                      保存中...
                    </>
                  ) : (
                    <>
                      <span>💾</span>
                      設定を保存
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


