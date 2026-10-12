/**
 * AIインプット用ドキュメント（自己完結 HTML）の生成と、プレビュー画面での調整。
 * - 選択したノートと、そこからリンクで辿れるノートをまとめて 1 つの HTML にする。
 * - プレビュー画面では、含めるノートの切り替え・並べ替え・リンクを辿る深さの変更ができ、変更のたびに作り直す。
 *   連続した操作で何度も作り直さないよう、少し待ってからまとめて実行する。
 * - 生成した HTML は、ダウンロード・コピー・保存先フォルダへの保存ができる。
 */
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { generateAiHtml, saveAiBundleToFile, saveAiHtmlToFile } from "../api/client";
import { copyTextToClipboard } from "../clipboard";
import type { ExpandedNode } from "../types";
import type { SearchResult } from "../types";

type UseAiDocumentBuilderDeps = {
  candidates: SearchResult[];
  docTitle: string;
  exportFolder: string;
  includeImages: boolean;
  includeLinkedEmails: boolean;
  includeRawMarkdown: boolean;
  isFolderConfigOpen: boolean;
  /** トークン最適化の設定を切り替える。 */
  onOptimizeTokensChange: (enabled: boolean) => void;
  optimizeTokens: boolean;
  rawCandidates: SearchResult[];
  selectedPaths: Set<string>;
  setIsFolderConfigOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export function useAiDocumentBuilder({
  candidates,
  docTitle,
  exportFolder,
  includeImages,
  includeLinkedEmails,
  includeRawMarkdown,
  isFolderConfigOpen,
  onOptimizeTokensChange,
  optimizeTokens,
  rawCandidates,
  selectedPaths,
  setIsFolderConfigOpen,
}: UseAiDocumentBuilderDeps) {
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
  const [isSavingBundle, setIsSavingBundle] = useState(false);
  const [savedPathFeedback, setSavedPathFeedback] = useState<string | null>(null);
  const modalDebounceRef = useRef<number | null>(null);

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

  // トークン最適化の切り替え。切り替えた直後は画面の値がまだ古いので、新しい値を明示して作り直す
  const handleToggleOptimizeTokens = (enabled: boolean) => {
    onOptimizeTokensChange(enabled);
    const activePaths = getActivePathsForRegeneration();
    if (modalDebounceRef.current) {
      window.clearTimeout(modalDebounceRef.current);
    }
    modalDebounceRef.current = window.setTimeout(() => {
      void regenerateModalHtml(activePaths, undefined, undefined, enabled);
    }, 50);
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
    overrideExcluded?: Set<string>,
    overrideOptimizeTokens?: boolean
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
        optimize_tokens: overrideOptimizeTokens ?? optimizeTokens,
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

  return {
    collapseAllNodes,
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
    getActivePathsForRegeneration,
    handleDepthChange,
    handleDownload,
    handleDropModalFile,
    handleGenerateHtml,
    handleMoveModalFile,
    handleSaveBundle,
    handleSaveHtmlAndCopyPath,
    handleToggleChildNode,
    handleToggleModalFile,
    handleToggleOptimizeTokens,
    handleToggleOnlyTopTag,
    isGenerating,
    isModalOpen,
    isModalUpdating,
    isSaving,
    isSavingBundle,
    modalActivePaths,
    modalOrderedPaths,
    onlyTopTag,
    previewTab,
    savedPathFeedback,
    setDragOverIndex,
    setDraggedIndex,
    setIsModalOpen,
    setPreviewTab,
    setSavedPathFeedback,
    toggleNodeCollapse,
  } as const;
}

export type UseAiDocumentBuilderResult = ReturnType<typeof useAiDocumentBuilder>;
