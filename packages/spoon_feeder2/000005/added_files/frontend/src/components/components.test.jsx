/**
 * 描画コンポーネントのテスト (components.test.jsx)
 *
 * 仕様: react-dom/server で実コンポーネントを描画し、props に応じた表示・無効状態・属性を確認する。
 * （クリック等の実操作はビルド済み画面を実ブラウザ・実バックエンドで確認する）
 **/

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodeContextPanel } from './CodeContextPanel';
import { ContextSummary } from './ContextSummary';
import { FileSelectPanel } from './FileSelectPanel';
import { HelpModal } from './HelpModal';
import { MkdocsContextPanel } from './MkdocsContextPanel';
import { PathBar } from './PathBar';
import { PreviewModal } from './PreviewModal';
import { SettingsDrawer } from './SettingsDrawer';
import { Toast } from './Toast';
import { TopBar } from './TopBar';
import { TreeContextMenu } from './TreeContextMenu';
import { TreeNode } from './TreeNode';

const html = element => renderToStaticMarkup(element);
const noop = () => {};

describe('Toast', () => {
  it('メッセージを表示する', () => expect(html(<Toast message="保存しました" onClose={noop}/>)).toContain('保存しました'));
});

describe('TreeNode', () => {
  const directory = { type: 'directory', name: 'src', path: 'src', children: [
    { type: 'file', name: 'main.py', path: 'src/main.py' },
    { type: 'file', name: 'gen.py', path: 'src/gen.py', ignored: true },
  ] };

  it('チェック状態をaria-selectedに反映し、ignoredにはバッジとdisabledを付ける', () => {
    const markup = html(<TreeNode node={directory} selected={new Set(['src/main.py'])} setSelected={noop} filter="" onPreview={noop}/>);
    expect(markup).toContain('data-tree-path="src/main.py"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('ignored-badge');
    expect(markup).toMatch(/<input[^>]*disabled[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*disabled/);
  });

  it('フィルターに一致しないノードは描画しない', () => {
    expect(html(<TreeNode node={directory} selected={new Set()} setSelected={noop} filter="zzz" onPreview={noop}/>)).toBe('');
  });

  it('フィルター一致時は祖先を展開して一致するファイルを表示する', () => {
    const markup = html(<TreeNode node={directory} selected={new Set()} setSelected={noop} filter="main" onPreview={noop}/>);
    expect(markup).toContain('main.py');
  });
});

describe('HelpModal', () => {
  it('閉じているときは何も描画せず、開くとショートカットを表示する', () => {
    expect(html(<HelpModal open={false} close={noop}/>)).toBe('');
    expect(html(<HelpModal open close={noop}/>)).toContain('ショートカット');
  });
});

describe('SettingsDrawer', () => {
  const base = { open: true, close: noop, path: '/repo', openIgnoreEditor: noop, showIgnored: false, setShowIgnored: noop, pythonMode: 'normal', setPythonMode: noop, embeddedDir: '', setEmbeddedDir: noop, gitDiffCommand: '', setGitDiffCommand: noop, reload: noop };

  it('通常モードではEmbeddedのフォルダ入力を表示せず、Git差分コマンドの既定値を案内する', () => {
    const markup = html(<SettingsDrawer {...base}/>);
    expect(markup).not.toContain('python.exeがあるフォルダ');
    expect(markup).toContain('git diff HEAD -- *.py');
  });

  it('Embeddedモードではフォルダ入力を表示する', () => {
    expect(html(<SettingsDrawer {...base} pythonMode="embedded"/>)).toContain('python.exeがあるフォルダ');
  });

  it('リポジトリ未選択では無視リスト編集を無効にする', () => {
    expect(html(<SettingsDrawer {...base} path=""/>)).toMatch(/<button[^>]*disabled[^>]*class="drawer-action"|<button[^>]*class="drawer-action"[^>]*disabled/);
  });
});

describe('TopBar', () => {
  it('リポジトリ未選択ではマップと無視リスト編集を無効にする', () => {
    const markup = html(<TopBar path="" onOpenMap={noop} onOpenIgnoreEditor={noop} onOpenSettings={noop}/>);
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe('PathBar', () => {
  const props = { path: '/repo', setPath: noop, repositories: [], setRepositories: noop, onLoad: noop, loading: false, showIgnored: false, notify: noop, activeMode: 'code', isMkdocsRepo: false, mkdocsConfig: {}, onToggleMode: noop, gitDiffCommand: '', loadingDiff: false, onCopyGitDiff: noop, onOpenCode: noop };

  it('コードモード表示と、実行されるGit差分コマンド(空欄は既定)をツールチップに出す', () => {
    const markup = html(<PathBar {...props}/>);
    expect(markup).toContain('コードモード');
    expect(markup).toContain('Git差分をクリップボードにコピー (git diff HEAD -- *.py)');
  });

  it('MkDocs検出時はYAMLファイル名を案内しMkDocsモードを表示する', () => {
    const markup = html(<PathBar {...props} activeMode="mkdocs" isMkdocsRepo mkdocsConfig={{ config_file: 'mkdocs.yml', site_name: 'Docs' }}/>);
    expect(markup).toContain('MkDocsモード');
    expect(markup).toContain('YAML検出: mkdocs.yml (Docs)');
  });

  it('リポジトリ未選択ではモード切替を出さない', () => {
    expect(html(<PathBar {...props} path=""/>)).not.toContain('mode-switch-button');
  });
});

describe('CodeContextPanel', () => {
  const props = { context: '', path: '/repo', loading: false, selectedCount: 2, includeExternalModules: true, setIncludeExternalModules: noop, onGenerate: noop, onCopy: noop, onDownload: noop, exportFolder: '~/out', setExportFolder: noop, onOpenFolder: noop };

  it('未作成ならプレースホルダー、作成済みならコピー/保存ボタンと本文を表示する', () => {
    expect(html(<CodeContextPanel {...props}/>)).toContain('repository_context.txt');
    expect(html(<CodeContextPanel {...props}/>)).toContain('~/out');
    expect(html(<CodeContextPanel {...props}/>)).toContain('フォルダを開く');
    const created = html(<CodeContextPanel {...props} context="<file/>"/>);
    expect(created).toContain('コピー');
    expect(created).toContain('&lt;file/&gt;');
  });

  it('選択ファイルが0件なら作成ボタンを無効にし、外部モジュールのチェックを反映する', () => {
    const markup = html(<CodeContextPanel {...props} selectedCount={0}/>);
    expect(markup).toMatch(/<button[^>]*class="primary large"[^>]*disabled|<button[^>]*disabled[^>]*class="primary large"/);
    expect(markup).toContain('checked=""');
  });
});

describe('MkdocsContextPanel', () => {
  const onePart = { index: 1, total: 1, size: 1200000, figures: [1, 1], data_url: 'data:image/png;base64,AA' };
  const mkdocs = { exportFolder: '~/out', setExportFolder: noop, imageParts: [], stats: null, viewTab: 'markdown', setViewTab: noop, saving: false, onOpenFolder: noop, onSave: noop, downloadImage: noop };
  const props = { context: '', path: '/repo', loading: false, selectedCount: 1, onGenerate: noop, onCopy: noop, onDownload: noop, mkdocs };

  it('保存先フォルダと未作成のプレースホルダーを表示する', () => {
    const markup = html(<MkdocsContextPanel {...props}/>);
    expect(markup).toContain('value="~/out"');
    expect(markup).toContain('*_context.md ＋ *_images.png');
  });

  it('作成後は文書数と画像数のタブ、画像があれば結合画像保存ボタンを表示する', () => {
    const stats = { total_documents: 3, total_images: 2, images_meta: [] };
    const markup = html(<MkdocsContextPanel {...props} context="# md" mkdocs={{ ...mkdocs, stats, imageParts: [onePart] }}/>);
    expect(markup).toContain('統合マークダウン (3件)');
    expect(markup).toContain('結合画像プレビュー (2枚連結)');
    expect(markup).toContain('結合画像保存');
  });

  it('画像タブで画像がなければ案内を表示し、結合画像があれば図の対応を表示する', () => {
    const empty = html(<MkdocsContextPanel {...props} context="# md" mkdocs={{ ...mkdocs, viewTab: 'image' }}/>);
    expect(empty).toContain('呼び出されている画像はありません');
    const stats = { total_documents: 1, total_images: 1, images_meta: [{ index: 1, doc_path: 'docs/a.md', link_text: '![x](x.png)' }] };
    const withImage = html(<MkdocsContextPanel {...props} context="# md" mkdocs={{ ...mkdocs, viewTab: 'image', stats, imageParts: [onePart] }}/>);
    expect(withImage).toContain('【図1】');
    expect(withImage).toContain('docs/a.md');
  });

  it('保存中は保存ボタンを無効にする', () => {
    expect(html(<MkdocsContextPanel {...props} mkdocs={{ ...mkdocs, saving: true }}/>).match(/disabled=""/g).length).toBeGreaterThanOrEqual(2);
  });
});

describe('FileSelectPanel', () => {
  const tree = [{ type: 'file', name: 'a.py', path: 'a.py' }];
  const base = {
    tree, allFiles: ['a.py'], selected: new Set(['a.py']), setSelected: noop, filter: '', setFilter: noop, treeRef: { current: null },
    onTreeKeyDown: noop, onPreview: noop, onContextMenu: noop, path: '/repo', loading: false, activeMode: 'code', autoCheckLoading: false,
    onAutoCheck: noop, referenceData: { enabled: true, repositories: [], unresolved: [], warnings: [] }, referenceSelected: new Set(),
    setReferenceSelected: noop, referenceFileCount: 0, onOpenReferenceEditor: noop
  };

  it('選択数、自動チェックボタンの文言(モード別)、全選択解除ボタンを表示する', () => {
    const code = html(<FileSelectPanel {...base}/>);
    expect(code).toContain('1 / 1');
    expect(code).toContain('ライブラリを自動チェック');
    expect(code).toContain('選択解除');
    expect(html(<FileSelectPanel {...base} activeMode="mkdocs"/>)).toContain('リンク先MDを自動チェック');
  });

  it('ツリーが空なら案内を表示する', () => {
    expect(html(<FileSelectPanel {...base} tree={[]} allFiles={[]}/>)).toContain('リポジトリを読み込むと');
  });

  it('コードモードでは参照ライブラリ・未解決・警告を表示し、MkDocsモードでは表示しない', () => {
    const referenceData = {
      enabled: true, warnings: ['解析に失敗'], unresolved: [{ module: 'x', language: 'python', source_files: [] }],
      repositories: [{ path: '/lib', name: 'lib', reason: 'manual', files: ['u.py'], tree: [{ type: 'file', name: 'u.py', path: 'u.py' }] }]
    };
    const code = html(<FileSelectPanel {...base} referenceData={referenceData} referenceFileCount={1}/>);
    expect(code).toContain('参照ライブラリ');
    expect(code).toContain('手動');
    expect(code).toContain('1件の参照先を確認');
    expect(code).toContain('解析に失敗');
    expect(html(<FileSelectPanel {...base} activeMode="mkdocs" referenceData={referenceData}/>)).not.toContain('参照ライブラリ');
  });
});

describe('TreeContextMenu', () => {
  globalThis.window = globalThis.window || { innerHeight: 800, innerWidth: 1200 };
  const referenceData = { unresolved: [], manual_references: {} };
  const menuFor = node => ({ x: 10, y: 20, node });

  it('通常項目は追加、ignored項目は除外を表示する', () => {
    expect(html(<TreeContextMenu menu={menuFor({ path: 'a', ignored: false })} pythonMode="normal" referenceData={referenceData}/>)).toContain('無視リストへ追加');
    expect(html(<TreeContextMenu menu={menuFor({ path: 'a', ignored: true })} pythonMode="normal" referenceData={referenceData}/>)).toContain('無視リストから除外');
  });

  it('Embeddedでは対象リポジトリの追加を出さず、通常は未解決も手動設定もなければ無効にする', () => {
    const node = { path: 'a' };
    expect(html(<TreeContextMenu menu={menuFor(node)} pythonMode="embedded" referenceData={referenceData}/>)).not.toContain('対象リポジトリを追加');
    expect(html(<TreeContextMenu menu={menuFor(node)} pythonMode="normal" referenceData={referenceData}/>)).toMatch(/disabled=""[^>]*>.*対象リポジトリを追加/);
    expect(html(<TreeContextMenu menu={menuFor(node)} pythonMode="normal" referenceData={{ unresolved: [{}], manual_references: {} }}/>)).not.toMatch(/disabled=""[^>]*>.*対象リポジトリを追加/);
  });
});

describe('ContextSummary', () => {
  it('未作成なら何も表示しない', () => expect(html(<ContextSummary context=""/>)).toBe(''));

  it('合計を万文字と実数で表示し、20万文字以内なら警告色にしない', () => {
    const markup = html(<ContextSummary context={'あ'.repeat(123456)}/>);
    expect(markup).toContain('合計 12.35万文字');
    expect(markup).toContain('123,456');
    expect(markup).not.toContain('over');
    expect(markup).not.toContain('分割して出力');
  });

  it('20万文字を超えたら警告色で分割数とパートのタブを表示する', () => {
    const parts = [1, 2, 3].map(index => ({ index, total: 3, chars: 100000, text: 'x' }));
    const markup = html(<ContextSummary context={'あ'.repeat(250000)} textParts={parts} partIndex={1} setPartIndex={noop}/>);
    expect(markup).toContain('char-count over');
    expect(markup).toContain('全3ファイルに分割して出力します');
    expect(markup).toContain('パート1/3 (10.00万文字)');
    expect(markup).toMatch(/class="active">パート2\/3/);
  });
});

describe('PreviewModal', () => {
  it('ファイル未指定なら何も描画しない', () => expect(html(<PreviewModal file="" content="" close={noop}/>)).toBe(''));

  it('ヘッダーにファイルの文字数を表示する', () => {
    const markup = html(<PreviewModal file="src/a.py" content={'a'.repeat(12000)} close={noop}/>);
    expect(markup).toContain('1.20万文字');
    expect(markup).toContain('12,000文字');
  });
});

describe('分割出力時のコンテキストパネル', () => {
  const parts = [1, 2].map(index => ({ index, total: 2, chars: 100000, text: `part-${index}-text` }));

  it('コードモードは選択中パートの本文を表示し、コピー・保存ボタンが分割を示す', () => {
    const props = { context: 'full', textParts: parts, partIndex: 1, setPartIndex: noop, shownText: parts[1].text, path: '/repo', loading: false, selectedCount: 1, includeExternalModules: true, setIncludeExternalModules: noop, onGenerate: noop, onCopy: noop, onDownload: noop, exportFolder: '~/out', setExportFolder: noop, onOpenFolder: noop };
    const markup = html(<CodeContextPanel {...props}/>);
    expect(markup).toContain('part-2-text');
    expect(markup).not.toContain('part-1-text');
    expect(markup).toContain('このパートをコピー');
    expect(markup).toContain('全2ファイルを保存');
  });

  it('MkDocsモードは分割された結合画像を図の範囲つきで全て表示する', () => {
    const mkdocs = { exportFolder: '~/out', setExportFolder: noop, stats: { total_documents: 1, total_images: 4, images_meta: [] }, viewTab: 'image', setViewTab: noop, saving: false, onOpenFolder: noop, onSave: noop, downloadImage: noop,
      imageParts: [{ index: 1, total: 2, size: 4200000, figures: [1, 2], data_url: 'data:image/jpeg;base64,AA' }, { index: 2, total: 2, size: 3100000, figures: [3, 4], data_url: 'data:image/jpeg;base64,BB' }] };
    const markup = html(<MkdocsContextPanel context="# md" textParts={parts} partIndex={0} setPartIndex={noop} shownText={parts[0].text} path="/repo" loading={false} selectedCount={1} onGenerate={noop} onCopy={noop} onDownload={noop} mkdocs={mkdocs}/>);
    expect(markup).toContain('2ファイルに分割');
    expect(markup).toContain('結合画像 1/2（【図1】〜【図2】・4.20MB）');
    expect(markup).toContain('結合画像 2/2（【図3】〜【図4】・3.10MB）');
    expect(markup).toContain('結合画像保存(全2枚)');
    expect(markup).toContain('MD保存(全2ファイル)');
  });
});
