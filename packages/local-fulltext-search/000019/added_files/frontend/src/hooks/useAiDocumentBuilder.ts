/**
 * AIインプット用ドキュメント（自己完結 HTML）の生成と、プレビュー画面での調整。
 * - 選択したノートと、そこからリンクで辿れるノートをまとめて 1 つの HTML にする。
 * - プレビュー画面では、含めるノートの切り替え・並べ替え・リンクを辿る深さの変更ができ、変更のたびに作り直す。
 *   連続した操作で何度も作り直さないよう、少し待ってからまとめて実行する。
 * - 生成した HTML は、ダウンロード・コピー・保存先フォルダへの保存ができる。
 * - トークン最適化・メールの宛先を含めるかを切り替えると、新しい値で作り直す。
 * - サーバーが処理できなかったリンク（見つからない・10 秒で打ち切り・エラー）を生成結果に持ち、画面へ出せるようにする。
 * - 社内AIの上限（20万文字・4.5MB）に合わせてサーバーが分割した HTML（パート）を持つ。表示・コピーは選んだパート、
 *   ダウンロード・保存は全パートを対象にする（1 つなら従来どおり 1 ファイル）。分割前の文字数と上限も持つ。
 * - 「2 ファイルを保存」で分割されたときは、保存したファイル名とマークダウンの文字数を知らせる。
 */
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { generateAiHtml, saveAiBundleToFile, saveAiHtmlParts, saveAiHtmlToFile } from "../api/client";
import type { AiBundleSaveResponse } from "../api/client";
import { copyTextToClipboard } from "../clipboard";
import { countChars, DEFAULT_CHAR_LIMIT, DEFAULT_SIZE_LIMIT_BYTES, formatMan, formatMegabytes } from "../outputSize";
import type { AiHtmlExportResponse, AiHtmlPart, ExpandedNode, SkippedLink } from "../types";
import type { SearchResult } from "../types";

/** 切り替えた直後の出力オプション（まだ画面の値に反映されていないもの）。 */
type ExportOptionOverrides = {
  includeEmailRecipients?: boolean;
  optimizeTokens?: boolean;
};

type UseAiDocumentBuilderDeps = {
  candidates: SearchResult[];
  docTitle: string;
  exportFolder: string;
  /** 図面 PDF の最大サイズ（MB）。「2 ファイルを保存」で使う */
  figurePdfMaxMb: number;
  /** リンクされたメールの宛先（To・CC・BCC）を含めるか。 */
  includeEmailRecipients: boolean;
  includeImages: boolean;
  includeLinkedEmails: boolean;
  includeRawMarkdown: boolean;
  isFolderConfigOpen: boolean;
  /** メールの宛先を含めるかの設定を切り替える。 */
  onIncludeEmailRecipientsChange: (enabled: boolean) => void;
  /** トークン最適化の設定を切り替える。 */
  onOptimizeTokensChange: (enabled: boolean) => void;
  optimizeTokens: boolean;
  rawCandidates: SearchResult[];
  selectedPaths: Set<string>;
  setIsFolderConfigOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

/** 生成結果。html_parts は上限に合わせて分割した HTML（上限以内なら 1 つ） */
export type GeneratedHtml = {
  html_content: string;
  html_parts: AiHtmlPart[];
  total_chars: number;
  char_limit: number;
  size_limit_bytes: number;
  limit_problems: string[];
  total_documents: number;
  total_linked_emails?: number;
  total_images_embedded: number;
  size_bytes: number;
  file_name: string;
  skipped_links: SkippedLink[];
};

/** サーバーの応答を生成結果にする。パートが無い応答（古いサーバー）は HTML 全体を 1 パートとして扱う。 */
export function toGeneratedHtml(res: AiHtmlExportResponse, fallbackDocuments: number, fileName: string): GeneratedHtml {
  const sizeBytes = new Blob([res.html_content]).size;
  const parts = res.html_parts && res.html_parts.length > 0
    ? res.html_parts
    : [{ index: 1, total: 1, chars: countChars(res.html_content), bytes: sizeBytes, html_content: res.html_content }];
  return {
    html_content: res.html_content,
    html_parts: parts,
    total_chars: res.total_chars ?? parts.reduce((sum, part) => sum + part.chars, 0),
    char_limit: res.char_limit ?? DEFAULT_CHAR_LIMIT,
    size_limit_bytes: res.size_limit_bytes ?? DEFAULT_SIZE_LIMIT_BYTES,
    limit_problems: res.limit_problems ?? [],
    total_documents: res.total_documents ?? fallbackDocuments,
    total_linked_emails: res.total_linked_emails ?? 0,
    total_images_embedded: res.total_images_embedded ?? 0,
    size_bytes: sizeBytes,
    file_name: fileName,
    skipped_links: res.skipped_links ?? [],
  };
}

/**
 * 「2 ファイルを保存」の完了メッセージ。分割されたときは全ファイル名と、マークダウンのパートごとの文字数・
 * 図面 PDF ごとの容量を書く。
 */
export function bundleSavedMessage(res: AiBundleSaveResponse): string {
  const markdownNames = res.markdown_names ?? [res.markdown_name];
  const imageNames = res.figure_pdf_names ?? [];
  const warning = res.attachment_warning ? ` ⚠️ ${res.attachment_warning}` : "";
  const problems = res.problems && res.problems.length > 0 ? ` ⚠️ 上限超過: ${res.problems.join(" / ")}` : "";
  if (markdownNames.length <= 1 && imageNames.length <= 1) {
    const base = imageNames.length > 0
      ? `✅ 2ファイル保存完了: ${markdownNames[0]} & ${imageNames[0]}`
      : `✅ マークダウン保存完了: ${markdownNames[0]}`;
    return base + warning + problems;
  }
  const count = markdownNames.length + imageNames.length;
  const images = imageNames.length > 0 ? ` & ${imageNames.join(", ")}` : "";
  const chars = (res.text_parts ?? []).map((part) => formatMan(part.chars)).join(" / ");
  const pdfSizes = imageNames.length > 1 ? (res.figure_pdf_sizes ?? []).map(formatMegabytes).join(" / ") : "";
  const sizes = [chars ? `マークダウン ${chars}` : "", pdfSizes ? `図面PDF ${pdfSizes}` : ""].filter(Boolean).join(" | ");
  return `✅ ${count}ファイル保存完了: ${markdownNames.join(", ")}${images}${sizes ? ` (${sizes})` : ""}${warning}${problems}`;
}

export function useAiDocumentBuilder({
  candidates,
  docTitle,
  exportFolder,
  figurePdfMaxMb,
  includeEmailRecipients,
  includeImages,
  includeLinkedEmails,
  includeRawMarkdown,
  isFolderConfigOpen,
  onIncludeEmailRecipientsChange,
  onOptimizeTokensChange,
  optimizeTokens,
  rawCandidates,
  selectedPaths,
  setIsFolderConfigOpen,
}: UseAiDocumentBuilderDeps) {
  // 生成結果
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedData, setGeneratedData] = useState<GeneratedHtml | null>(null);
  // 表示中のパート（0 始まり）
  const [activePartIndex, setActivePartIndex] = useState(0);
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

  // 各ノートのデフォルトリンク階層数（topタグありは2、それ以外は1）
  const getNoteDefaultDepth = (path: string): number => {
    const item = candidates.find((c) => c.full_path === path) || rawCandidates.find((c) => c.full_path === path);
    return item?.has_obsidian_top_tag ? 2 : 1;
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
        include_email_recipients: includeEmailRecipients,
      });

      setGeneratedData(toGeneratedHtml(res, paths.length, `${docTitle || "AI_Context_Document"}.html`));
      setActivePartIndex(0);
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

  // 出力オプションを切り替えて作り直す。切り替えた直後は画面の値がまだ古いので、新しい値を明示して渡す
  const regenerateWithOptions = (overrideOptions: ExportOptionOverrides) => {
    const activePaths = getActivePathsForRegeneration();
    if (modalDebounceRef.current) {
      window.clearTimeout(modalDebounceRef.current);
    }
    modalDebounceRef.current = window.setTimeout(() => {
      void regenerateModalHtml(activePaths, undefined, undefined, overrideOptions);
    }, 50);
  };

  // トークン最適化の切り替え
  const handleToggleOptimizeTokens = (enabled: boolean) => {
    onOptimizeTokensChange(enabled);
    regenerateWithOptions({ optimizeTokens: enabled });
  };

  // メールの宛先を含めるかの切り替え
  const handleToggleEmailRecipients = (enabled: boolean) => {
    onIncludeEmailRecipientsChange(enabled);
    regenerateWithOptions({ includeEmailRecipients: enabled });
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
    overrideOptions: ExportOptionOverrides = {}
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
        optimize_tokens: overrideOptions.optimizeTokens ?? optimizeTokens,
        include_email_recipients: overrideOptions.includeEmailRecipients ?? includeEmailRecipients,
      });

      const next = toGeneratedHtml(res, paths.length, `${docTitle || "AI_Context_Document"}.html`);
      setGeneratedData(next);
      // 作り直してパートの数が減ったら、表示中のパートを範囲内へ戻す
      setActivePartIndex((index) => Math.min(index, next.html_parts.length - 1));
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
    if (generatedData.html_parts.length > 1) {
      await saveHtmlPartsAndCopyPaths(generatedData);
      return;
    }
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

  // 分割した HTML を全パート保存し、保存したパスを改行区切りでクリップボードへコピー
  const saveHtmlPartsAndCopyPaths = async (data: GeneratedHtml) => {
    setIsSaving(true);
    let res: Awaited<ReturnType<typeof saveAiHtmlParts>> | undefined;
    try {
      res = await saveAiHtmlParts({
        html_parts: data.html_parts.map((part) => part.html_content),
        file_name: data.file_name || `${docTitle || "AI_Context_Document"}.html`,
      });
    } catch (err: any) {
      alert(`HTML保存に失敗しました: ${err.message}`);
      return;
    } finally {
      setIsSaving(false);
    }
    const pathsText = res.saved_paths.join("\n");
    const copied = await copyTextToClipboard(pathsText);
    const count = res.saved_paths.length;
    const warning = res.attachment_warning ? ` ⚠️ ${res.attachment_warning}` : "";
    setSavedPathFeedback(
      copied
        ? `✅ ${count}ファイルのパスをコピーしました: ${res.saved_paths.join(" , ")}${warning}`
        : `✅ HTML保存完了 (パス手動コピー): ${res.saved_paths.join(" , ")}${warning}`
    );
    setTimeout(() => setSavedPathFeedback(null), 10000);
  };

  // マークダウン＆図面PDFの2ファイルを指定フォルダに保存
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
        include_email_recipients: includeEmailRecipients,
        figure_pdf_max_mb: figurePdfMaxMb,
      });

      if (res.success) {
        setSavedPathFeedback(bundleSavedMessage(res));
        setTimeout(() => setSavedPathFeedback(null), 10000);
      }
    } catch (err: any) {
      alert(`保存に失敗しました: ${err.message}`);
    } finally {
      setIsSavingBundle(false);
    }
  };

  // ファイルダウンロード
  // 全パートをダウンロードする（分割したときは {名前}_part{n}of{m}.html）
  const handleDownload = () => {
    if (!generatedData?.html_content) return;
    const fileName = generatedData.file_name || `${docTitle}.html`;
    generatedData.html_parts.forEach((part) => {
      const blob = new Blob([part.html_content], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = part.total > 1 ? fileName.replace(/\.html$/i, "") + `_part${part.index}of${part.total}.html` : fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  };

  // 表示中のパートの HTML
  const currentPartHtml = generatedData
    ? (generatedData.html_parts[activePartIndex] ?? generatedData.html_parts[0]).html_content
    : "";

  // HTMLコードのコピー
  const copyHtmlCode = () => {
    if (!generatedData?.html_content) return;
    void copyTextToClipboard(currentPartHtml);
    setCopiedHtml(true);
    setTimeout(() => setCopiedHtml(false), 2000);
  };

  return {
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
    handleToggleEmailRecipients,
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
    setActivePartIndex,
    setIsModalOpen,
    setPreviewTab,
    setSavedPathFeedback,
    toggleNodeCollapse,
  } as const;
}

export type UseAiDocumentBuilderResult = ReturnType<typeof useAiDocumentBuilder>;
