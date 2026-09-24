/**
 * AIインプット用自己完結HTML生成ページコンポーネント (Chat AI Context Export)。
 * 仕様:
 * - 質問やキーワードを入力し、ハイブリッド検索（Vector × FTS5 API）で前提候補ドキュメント群を高速抽出。
 * - 検索ボックス右側の拡張子フィルター（デフォルト: `md`、包含 `md` / 除外 `-png` 等）によるAPI絞り込みおよび候補一覧のリアルタイム動的フィルタリング。
 * - ドラッグ連続選択 & Shift+ドラッグ連続解除に対応した洗練された候補選択テーブル。
 * - ステップ2（候補ノート選択）上部アクションバーに目立つ「AI用HTMLファイルを生成する」ボタンを配置し即座に生成可能。
 * - 5種のプロンプトテンプレートプリセット（根拠付き回答、修正・推敲、要約＆アクション、課題・リスク、カスタム）。
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
  downloadAiPdf,
  saveAiPdfToFile,
} from "../api/client";
import { catppuccinIconForResult } from "../fileIcon";
import { copyTextToClipboard } from "../clipboard";
import type { SearchResult } from "../types";

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
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  // エクスポート設定
  const [docTitle, setDocTitle] = useState("AI_Context_Document");
  const [selectedPromptPresetIndex, setSelectedPromptPresetIndex] = useState(0);
  const [promptText, setPromptText] = useState(PROMPT_PRESETS[0].prompt);
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
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isModalUpdating, setIsModalUpdating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  const [savedPathFeedback, setSavedPathFeedback] = useState<string | null>(null);
  const modalDebounceRef = useRef<number | null>(null);

  // モーダル表示中の Esc キー監視
  useEffect(() => {
    if (!isModalOpen) return;
    const handleModalEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleModalEsc);
    return () => window.removeEventListener("keydown", handleModalEsc);
  }, [isModalOpen]);

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
      setSelectedPaths(new Set()); // 新しい検索時は選択をリセット

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

  // プリセット変更
  const handlePresetChange = (idx: number) => {
    setSelectedPromptPresetIndex(idx);
    if (idx < PROMPT_PRESETS.length - 1) {
      setPromptText(PROMPT_PRESETS[idx].prompt);
    }
  };

  // 推定トークン数の計算（選択された候補の概算）
  const estimatedChars = candidates
    .filter((c) => selectedPaths.has(c.full_path))
    .reduce((acc, c) => acc + (c.snippet?.length || 500) + 1500, 0); // 1ファイル平均約1.5k〜3k文字
  const estimatedTokens = Math.round(estimatedChars * 1.1);

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

    setIsGenerating(true);
    try {
      const fullPrompt = query.trim()
        ? `【ユーザーの質問 / テーマ】\n${query.trim()}\n\n【指示】\n${promptText}`
        : promptText;

      const res = await generateAiHtml({
        file_paths: paths,
        prompt: fullPrompt,
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

      const activePathsInOrder = modalOrderedPaths.filter((p) => next.has(p));
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
    const activePathsInOrder = nextPaths.filter((p) => modalActivePaths.has(p));
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
    const activePathsInOrder = nextPaths.filter((p) => modalActivePaths.has(p));
    if (modalDebounceRef.current) {
      window.clearTimeout(modalDebounceRef.current);
    }
    modalDebounceRef.current = window.setTimeout(() => {
      void regenerateModalHtml(activePathsInOrder);
    }, 200);
  };

  // モーダル内でのHTML自動再生成（指定された配列順序を厳格に保持）
  const regenerateModalHtml = async (pathsOrSet: string[] | Set<string>) => {
    const paths = Array.isArray(pathsOrSet) ? pathsOrSet : Array.from(pathsOrSet);
    if (paths.length === 0) return;
    setIsModalUpdating(true);
    try {
      const fullPrompt = query.trim()
        ? `【ユーザーの質問 / テーマ】\n${query.trim()}\n\n【指示】\n${promptText}`
        : promptText;

      const res = await generateAiHtml({
        file_paths: paths,
        prompt: fullPrompt,
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

  // 高精度PDF保存 & 絶対パスをクリップボードにコピー
  const handleSavePdfAndCopyPath = async () => {
    if (!generatedData?.html_content) return;
    setIsSavingPdf(true);
    let res: { success: boolean; saved_path: string; file_name: string; size_bytes: number } | undefined;
    try {
      res = await saveAiPdfToFile({
        html_content: generatedData.html_content,
        file_name: `${docTitle || "AI_Context_Document"}.pdf`,
        optimize_tokens: optimizeTokens,
      });
    } catch (err: any) {
      alert(`PDF保存に失敗しました: ${err.message}`);
      setIsSavingPdf(false);
      return;
    } finally {
      setIsSavingPdf(false);
    }

    if (res?.saved_path) {
      const copied = await copyTextToClipboard(res.saved_path);
      if (copied) {
        setSavedPathFeedback(`✅ PDF保存 & パスコピー完了: ${res.saved_path}`);
      } else {
        setSavedPathFeedback(`✅ PDF保存完了 (パス手動コピー): ${res.saved_path}`);
      }
      setTimeout(() => setSavedPathFeedback(null), 8000);
    }
  };

  // 高精度PDFダウンロード
  const handleDownloadPdf = async () => {
    if (!generatedData?.html_content) return;
    setIsGeneratingPdf(true);
    try {
      await downloadAiPdf({
        html_content: generatedData.html_content,
        file_name: `${docTitle || "AI_Context_Document"}.pdf`,
        optimize_tokens: optimizeTokens,
      });
    } catch (err: any) {
      alert(`PDFダウンロードに失敗しました: ${err.message}`);
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  // 印刷ダイアログの起動（ブラウザ標準印刷）
  const handlePrint = () => {
    const iframe = document.querySelector(".html-preview-frame") as HTMLIFrameElement | null;
    if (iframe && iframe.contentWindow) {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        return;
      } catch (e) {
        console.warn("iframe print failed, falling back to window.print", e);
      }
    }
    window.print();
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
          <div style={{ fontSize: "11.5px", color: "#94a3b8", background: "rgba(255, 255, 255, 0.05)", padding: "3px 10px", borderRadius: "6px", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
            ⚡ <strong>ハイブリッド検索（Vector × FTS5）で高精度抽出</strong>
          </div>
        </div>

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
            </div>
          </div>

          <div
            className="table-responsive-container"
            style={{
              maxHeight: "380px",
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

      {/* ステップ3: AI指示（共通プロンプト） & エクスポート設定 */}
      {candidates.length > 0 && (
        <div className="panel glass-panel" style={{ marginBottom: "16px", padding: "18px 22px", borderRadius: "14px" }}>
          <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: "8px", color: "#f8fafc" }}>
            <span>📋</span>
            ステップ 3: AIへの指示（共通プロンプト） & エクスポート設定
          </h2>

          {/* プリセット選択ボタン */}
          <div style={{ marginTop: "14px" }}>
            <label style={{ fontSize: "12px", color: "#94a3b8", display: "block", marginBottom: "6px" }}>
              プロンプトテンプレート
            </label>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {PROMPT_PRESETS.map((p, idx) => (
                <button
                  key={p.id}
                  type="button"
                  className={`btn ${selectedPromptPresetIndex === idx ? "btn-primary" : "btn-secondary"}`}
                  style={{ fontSize: "12px", padding: "5px 12px", borderRadius: "6px" }}
                  onClick={() => handlePresetChange(idx)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* プロンプト入力欄 */}
          <div style={{ marginTop: "14px" }}>
            <label style={{ fontSize: "12px", color: "#94a3b8", display: "block", marginBottom: "6px" }}>
              AIへの指示文（自由にカスタマイズ可能）
            </label>
            <textarea
              className="input-field"
              style={{ width: "100%", height: "85px", fontSize: "13.5px", padding: "10px 14px", borderRadius: "8px", fontFamily: "inherit" }}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="AIへの具体的な指示や出力形式の希望を記述"
            />
          </div>

          {/* 出力オプション & 生成ボタン */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px", marginTop: "16px", borderTop: "1px solid rgba(255, 255, 255, 0.08)", paddingTop: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <label style={{ fontSize: "12px", color: "#94a3b8" }}>HTMLタイトル:</label>
                <input
                  type="text"
                  className="input-field"
                  style={{ width: "230px", fontSize: "12px", padding: "5px 8px" }}
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                />
              </div>

              <label style={{ fontSize: "12.5px", display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", color: "#f8fafc" }}>
                <input
                  type="checkbox"
                  checked={includeImages}
                  onChange={(e) => setIncludeImages(e.target.checked)}
                />
                <span>🖼️ 画像・図面をBase64埋め込み</span>
              </label>

              <label style={{ fontSize: "12.5px", display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", color: "#f8fafc" }}>
                <input
                  type="checkbox"
                  checked={includeLinkedEmails}
                  onChange={(e) => setIncludeLinkedEmails(e.target.checked)}
                />
                <span>✉️ アウトプットに呼び出されるメールを追加する</span>
              </label>

              <label style={{ fontSize: "12.5px", display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", color: includeRawMarkdown ? "#f59e0b" : "#94a3b8" }}>
                <input
                  type="checkbox"
                  checked={includeRawMarkdown}
                  onChange={(e) => setIncludeRawMarkdown(e.target.checked)}
                />
                <span>📝 マークダウン元データを含める (非推奨: トークン重複)</span>
              </label>

              <label style={{ fontSize: "12.5px", display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", color: "#10b981", fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={optimizeTokens}
                  onChange={(e) => setOptimizeTokens(e.target.checked)}
                />
                <span>🧹 トークン最適化 (メールのCC & DataviewJS除外)</span>
              </label>
            </div>

            <button
              className="btn btn-primary"
              style={{
                padding: "9px 24px",
                fontSize: "14.5px",
                background: "linear-gradient(135deg, #6366f1, #a855f7)",
                border: "none",
                fontWeight: 600,
                borderRadius: "8px",
              }}
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
                  <span>✨</span>
                  🚀 AI用HTMLファイルを生成する ({selectedPaths.size}件)
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ステップ4: 生成結果プレビュー & ダウンロード */}
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

              {/* 高精度PDF 保存＆パスコピーボタン */}
              <button
                className="btn btn-primary"
                style={{
                  padding: "8px 18px",
                  fontSize: "13.5px",
                  background: "linear-gradient(135deg, #ef4444, #f97316)",
                  border: "none",
                  fontWeight: 600,
                  borderRadius: "8px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
                onClick={() => void handleSavePdfAndCopyPath()}
                disabled={isSavingPdf}
                title="社内AI用: Base64画像・図面を完全描画したA4 PDFを保存し、絶対パスをクリップボードにコピー"
              >
                {isSavingPdf ? (
                  <>
                    <span className="spin">🔄</span>
                    PDF保存中...
                  </>
                ) : (
                  <>
                    <span>📕</span>
                    💾 PDFを保存（パスをコピー）
                  </>
                )}
              </button>

              {/* 高精度PDF ダウンロードボタン */}
              <button
                className="btn btn-secondary"
                style={{
                  fontSize: "13px",
                  padding: "6px 14px",
                  borderColor: "#f97316",
                  color: "#fdba74",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
                onClick={() => void handleDownloadPdf()}
                disabled={isGeneratingPdf}
                title="Base64画像・図面を完全描画したA4 PDFをダウンロード"
              >
                {isGeneratingPdf ? (
                  <>
                    <span className="spin">🔄</span>
                    PDF生成中...
                  </>
                ) : (
                  <>
                    <span>📕</span>
                    PDFダウンロード (.pdf)
                  </>
                )}
              </button>

              {/* ブラウザ印刷 (PDF) ボタン */}
              <button
                className="btn btn-secondary"
                style={{ fontSize: "13px", padding: "6px 14px" }}
                onClick={handlePrint}
                title="ブラウザ標準の印刷ダイアログからPDF保存"
              >
                <span>🖨️</span>
                印刷 (PDF)
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
                {/* 高精度PDF 保存＆パスコピーボタン */}
                <button
                  className="btn btn-primary"
                  style={{
                    padding: "8px 18px",
                    fontSize: "13.5px",
                    background: "linear-gradient(135deg, #ef4444, #f97316)",
                    border: "none",
                    fontWeight: 600,
                    borderRadius: "8px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                  onClick={() => void handleSavePdfAndCopyPath()}
                  disabled={isSavingPdf || isModalUpdating}
                  title="社内AI用: Base64画像・図面を完全描画したA4 PDFを保存し、絶対パスをクリップボードにコピー"
                >
                  {isSavingPdf ? (
                    <>
                      <span className="spin">🔄</span>
                      PDF保存中...
                    </>
                  ) : (
                    <>
                      <span>📕</span>
                      💾 PDFを保存（パスをコピー）
                    </>
                  )}
                </button>

                {/* PDF ダウンロードボタン */}
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: "13px", padding: "6px 14px", borderColor: "#f97316", color: "#fdba74" }}
                  onClick={() => void handleDownloadPdf()}
                  disabled={isGeneratingPdf || isModalUpdating}
                  title="高精度A4 PDFをダウンロード"
                >
                  {isGeneratingPdf ? <><span className="spin">🔄</span> 生成中...</> : <><span>📕</span> PDF DL</>}
                </button>

                {/* ブラウザ印刷 (PDF) ボタン */}
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: "13px", padding: "6px 14px" }}
                  onClick={handlePrint}
                  title="ブラウザ標準の印刷ダイアログからPDF保存"
                >
                  <span>🖨️</span> 印刷
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
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
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
                    {modalActivePaths.size} / {candidates.filter((c) => selectedPaths.has(c.full_path) || modalActivePaths.has(c.full_path)).length} 件
                  </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", flexWrap: "wrap", gap: "6px" }}>
                  <div style={{ fontSize: "11.5px", color: "#94a3b8" }}>
                    ドラッグまたは▲▼で順序変更・除外連動
                  </div>
                  <label style={{ fontSize: "11.5px", display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", color: "#10b981", fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={optimizeTokens}
                      onChange={(e) => {
                        setOptimizeTokens(e.target.checked);
                        const activePathsInOrder = modalOrderedPaths.filter((p) => modalActivePaths.has(p));
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

                <div className="ai-file-selection-list">
                  {modalOrderedPaths.map((fullPath, idx) => {
                    const item = candidates.find((c) => c.full_path === fullPath) || {
                      full_path: fullPath,
                      file_name: fullPath.split(/[/\\]/).pop() || fullPath,
                    };
                    const isChecked = modalActivePaths.has(fullPath);
                    const isDraggingThis = draggedIndex === idx;
                    const isDragOverThis = dragOverIndex === idx;
                    return (
                      <div
                        key={fullPath}
                        className={`ai-file-selection-item ${isChecked ? "checked" : ""} ${isDraggingThis ? "is-dragging" : ""} ${isDragOverThis ? "is-drag-over" : ""}`}
                        title={fullPath}
                        style={{ display: "flex", alignItems: "center", gap: "8px" }}
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
                        <span className="ai-drag-handle" title="ドラッグして並び替え">⋮⋮</span>

                        {/* 順序変更ボタン（▲ / ▼） */}
                        <div className="ai-order-controls">
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

                        {/* チェックボックス */}
                        <input
                          type="checkbox"
                          checked={isChecked}
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
                        <div
                          style={{ minWidth: 0, flex: 1, cursor: "pointer" }}
                          onClick={() => handleToggleModalFile(fullPath)}
                        >
                          <div
                            style={{
                              fontSize: "12.5px",
                              fontWeight: 500,
                              color: isChecked ? "#f8fafc" : "#94a3b8",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {item.file_name}
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
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

