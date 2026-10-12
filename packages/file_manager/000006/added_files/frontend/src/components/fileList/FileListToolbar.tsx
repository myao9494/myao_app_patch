/**
 * ファイル一覧のアイコンツールバー（file_viewer の base.html 準拠のアイコン配置）
 * - 移動（戻る/進む/上の階層/ホーム/ネットワークドライブ/クリップボードのパス）
 * - 外部アプリ（VS Code / Antigravity / Obsidian / Finder・Explorer / Jupyter / Excalidraw）
 * - 作成・削除・更新、テストフォルダ・ゴミ箱を開く
 * キーボード操作ではボタンの並び順（DOM順）でフォーカス位置を決めるため、ボタンの順番を変えないこと
 */
import {
  ArrowLeft,
  ArrowRight,
  ChevronUp,
  ClipboardPaste,
  Code,
  Download,
  FlaskConical,
  FolderOpen,
  FolderPlus,
  Gem,
  Home,
  Network,
  RefreshCw,
  Rocket,
  Search,
  Trash2,
} from "lucide-react";

export interface FileListToolbarProps {
  isSectionFocused: boolean;
  focusedButtonIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;
  canGoUp: boolean;
  /** 左・中央ペインだけに表示するボタン（ファイル名検索・全文検索） */
  showPaneSearchButtons: boolean;
  /** パスに obsidian を含む場合だけ表示する「Obsidianで開く」 */
  showObsidianButton: boolean;
  hasSelection: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onHome: () => void;
  onNetworkDrive: () => void;
  onOpenFromClipboard: () => void;
  onDownload: () => void;
  onOpenVSCode: () => void;
  onOpenAntigravity: () => void;
  onOpenObsidianDaily: () => void;
  onOpenExplorer: () => void;
  onFocusSearch: () => void;
  onOpenFullTextSearch: () => void;
  onOpenJupyter: () => void;
  onOpenExcalidraw: () => void;
  onCreateMarkdown: () => void;
  onOpenObsidian: () => void;
  onCreateFolder: () => void;
  onDeleteSelected: () => void;
  onRefresh: () => void;
  onOpenTestFolder: () => void;
  onOpenTrash: () => void;
}

export function FileListToolbar(props: FileListToolbarProps) {
  return (
    <div
      className={`icon-toolbar ${props.isSectionFocused ? 'section-focused' : ''}`}
      data-focused-index={props.isSectionFocused ? props.focusedButtonIndex : undefined}
    >
      <button onClick={props.onBack} disabled={!props.canGoBack} title="戻る">
        <ArrowLeft size={14} />
      </button>
      <button onClick={props.onForward} disabled={!props.canGoForward} title="進む">
        <ArrowRight size={14} />
      </button>
      <button onClick={props.onUp} disabled={!props.canGoUp} title="上の階層へ">
        <ChevronUp size={14} />
      </button>
      <button onClick={props.onHome} title="ホームへ">
        <Home size={14} />
      </button>
      <button onClick={props.onNetworkDrive} title="ネットワークドライブへ">
        <Network size={14} />
      </button>
      <button onClick={props.onOpenFromClipboard} title="クリップボードから開く">
        <ClipboardPaste size={14} />
      </button>
      <button onClick={props.onDownload} title="ダウンロード">
        <Download size={14} />
      </button>
      <button onClick={props.onOpenVSCode} title="VSCodeで開く">
        <Code size={14} />
      </button>
      <button onClick={props.onOpenAntigravity} title="Antigravityで開く">
        <Rocket size={14} />
      </button>
      <button onClick={props.onOpenObsidianDaily} title="Obsidian 今日のフォルダ">
        <img src="/obsidian.svg" alt="Obsidian Daily" width={14} height={14} />
      </button>
      <button onClick={props.onOpenExplorer} title="フォルダを開く">
        <FolderOpen size={14} />
      </button>
      {props.showPaneSearchButtons && (
        <>
          <button onClick={props.onFocusSearch} title="ファイル名検索 (Ctrl+F / /)">
            <Search size={14} />
          </button>
          <button onClick={props.onOpenFullTextSearch} title="全文検索 (Ctrl+P)">
            <Search size={14} style={{ opacity: 0.6 }} />
          </button>
        </>
      )}
      <button onClick={props.onOpenJupyter} title="Jupyterで開く">
        <img src="/icons/catppuccin/jupyter.svg" alt="Jupyter" width={14} height={14} />
      </button>
      <button onClick={props.onOpenExcalidraw} title="Excalidrawで開く">
        <img src="/icons/catppuccin/excalidraw.svg" alt="Excalidraw" width={14} height={14} />
      </button>
      <button onClick={props.onCreateMarkdown} title="Markdownファイル作成">
        <img src="/icons/catppuccin/markdown.svg" alt="Markdown" width={14} height={14} />
      </button>
      {props.showObsidianButton && (
        <>
          <div className="toolbar-divider" />
          <button onClick={props.onOpenObsidian} title="Obsidianで開く">
            <Gem size={14} />
          </button>
        </>
      )}
      <div className="toolbar-divider" />
      <button onClick={props.onCreateFolder} title="フォルダ作成">
        <FolderPlus size={14} />
      </button>
      <button
        onClick={props.onDeleteSelected}
        disabled={!props.hasSelection}
        title="選択項目を削除"
        className="delete-btn"
      >
        <Trash2 size={14} />
      </button>
      <button onClick={props.onRefresh} title="更新 (R)">
        <RefreshCw size={14} />
      </button>

      <div style={{ flex: 1 }} />
      <div className="toolbar-divider" />

      {/* テストフォルダ・ゴミ箱（透明/アウトライン表示） */}
      <button className="toolbar-btn test-folder-btn" onClick={props.onOpenTestFolder} title="テストフォルダを開く">
        <FlaskConical size={14} />
      </button>
      <button className="toolbar-btn trash-open-btn" onClick={props.onOpenTrash} title="ゴミ箱を開く">
        <Trash2 size={14} />
      </button>
    </div>
  );
}
