/**
 * AIインプット画面（チャット型 AI へ渡す資料の作成）。
 *
 * 質問やキーワードから関連するノートを探し、選んだノートと、そこからリンクで辿れるノート・図面・画像を
 * 1 つの自己完結した HTML（または Markdown と画像のまとめ）として出力する。
 *
 * 画面は 3 つのステップで構成する。
 * 1. 候補の抽出（AiCandidateSearchPanel）: ハイブリッド検索で候補ノートを集め、拡張子フィルターで絞り込む。
 * 2. 候補の選択（AiCandidateTable）: 上位 N 件を自動で選び、ドラッグでまとめて選択・解除できる。
 * 3. 生成結果（AiGeneratedResultPanel / AiPreviewModal）: プレビューを見ながら、含めるノートと順序を調整して保存する。
 *
 * 状態と操作は hooks/useAi*.ts のフックが持ち、ここではフックどうしをつないで各部品へ渡す。
 */
import type { SearchResult } from "../types";
import { useAiCandidates } from "../hooks/useAiCandidates";
import { useAiDocumentBuilder } from "../hooks/useAiDocumentBuilder";
import { useAiExportFolder } from "../hooks/useAiExportFolder";
import { useAiExportOptions } from "../hooks/useAiExportOptions";
import { AiCandidateSearchPanel } from "./aiInput/AiCandidateSearchPanel";
import { buildOpenHubFileUrl } from "../openHub";
import { AiCandidateTable } from "./aiInput/AiCandidateTable";
import { AiExportFolderModal } from "./aiInput/AiExportFolderModal";
import { AiGeneratedResultPanel } from "./aiInput/AiGeneratedResultPanel";
import { AiPreviewModal } from "./aiInput/AiPreviewModal";

interface AiInputPageProps {
  initialQuery?: string;
  initialExtensionFilter?: string;
  results?: SearchResult[];
  excludeKeywords?: string;
}

export function AiInputPage({
  initialQuery = "",
  initialExtensionFilter = "md",
  results,
  excludeKeywords,
}: AiInputPageProps) {
  const options = useAiExportOptions();
  const candidateList = useAiCandidates({
    excludeKeywords,
    initialExtensionFilter,
    initialQuery,
    results,
    setDocTitle: options.setDocTitle,
  });
  const exportFolderSettings = useAiExportFolder({
    applyAutoSelectTopN: candidateList.applyAutoSelectTopN,
    candidates: candidateList.candidates,
    setDefaultSelectCount: candidateList.setDefaultSelectCount,
  });
  const builder = useAiDocumentBuilder({
    candidates: candidateList.candidates,
    docTitle: options.docTitle,
    exportFolder: exportFolderSettings.exportFolder,
    includeImages: options.includeImages,
    includeLinkedEmails: options.includeLinkedEmails,
    includeRawMarkdown: options.includeRawMarkdown,
    isFolderConfigOpen: exportFolderSettings.isFolderConfigOpen,
    onOptimizeTokensChange: options.setOptimizeTokens,
    optimizeTokens: options.optimizeTokens,
    rawCandidates: candidateList.rawCandidates,
    selectedPaths: candidateList.selectedPaths,
    setIsFolderConfigOpen: exportFolderSettings.setIsFolderConfigOpen,
  });

  const openFileViaHub = (fullPath: string): void => {
    window.open(buildOpenHubFileUrl(fullPath), "_blank");
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
      <AiCandidateSearchPanel candidateList={candidateList} exportFolderSettings={exportFolderSettings} />

      {/* ステップ2: 候補ドキュメントの選択 (ドラッグ選択対応テーブル) */}
      {candidateList.candidates.length > 0 && (
        <AiCandidateTable builder={builder} candidateList={candidateList} openFileViaHub={openFileViaHub} />
      )}

      {/* ステップ3: 生成結果プレビュー & ダウンロード */}
      {builder.generatedData && (
        <AiGeneratedResultPanel
          builder={builder}
          candidateList={candidateList}
          exportFolderSettings={exportFolderSettings}
        />
      )}

      {/* 特大プレビュー & ファイル選択モーダル */}
      {builder.isModalOpen && builder.generatedData && (
        <AiPreviewModal
          builder={builder}
          candidateList={candidateList}
          exportFolderSettings={exportFolderSettings}
          options={options}
          openFileViaHub={openFileViaHub}
        />
      )}

      {/* 保存先フォルダ設定モーダル */}
      {exportFolderSettings.isFolderConfigOpen && (
        <AiExportFolderModal exportFolderSettings={exportFolderSettings} />
      )}
    </div>
  );
}

