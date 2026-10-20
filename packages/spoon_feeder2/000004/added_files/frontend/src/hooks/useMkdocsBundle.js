/**
 * MkDocsモードの「統合マークダウン＋結合画像」state と操作 (useMkdocsBundle.js)
 *
 * 仕様:
 * 1. 保存先フォルダ設定をサーバーから読み込み、変更後の保存時にサーバーへ永続化する。
 * 2. preview: /api/mkdocs/context でコンテキストと結合画像のData URLを生成する（保存はしない）。
 * 3. save: 保存先へ「*_context.md」と「*_images.png/.jpg」の2ファイルを書き出す。
 * 4. openFolder: 保存先フォルダをFinder / Explorerで開く。
 * 5. persistExportFolder: 保存先設定を永続化する（コードモードの保存も同じ保存先を使う）。
 * エラーは呼び出し側(MainPage)へ例外として伝える。
 **/

import { useEffect, useState } from 'react';
import { api } from '../api';
import { downloadDataUrl, imageExtension } from '../lib/download';

export function useMkdocsBundle({ libraryPath, selected, siteName, notify, setContext }) {
  const [exportFolder, setExportFolder] = useState('~/Desktop/AI_Inputs');
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [stats, setStats] = useState(null);
  const [viewTab, setViewTab] = useState('markdown');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/api/mkdocs/export_config', undefined, 'GET').then(data => { if (data.export_folder) setExportFolder(data.export_folder); }).catch(() => {});
  }, []);

  const reset = () => { setImageDataUrl(''); setStats(null); };
  const apply = data => { setContext(data.context || ''); setImageDataUrl(data.image_data_url || ''); setStats(data.stats || null); };

  const preview = async () => {
    const data = await api('/api/mkdocs/context', { library_path: libraryPath, selected_files: Array.from(selected), title: siteName || '' });
    apply(data);
    notify(`MkDocsコンテキスト（文書${data.stats?.total_documents || 0}件・結合画像${data.stats?.total_images || 0}枚）を作成しました。`);
  };

  const persistExportFolder = () => api('/api/mkdocs/export_config', { export_folder: exportFolder });

  const save = async () => {
    setSaving(true);
    try {
      await persistExportFolder();
      const data = await api('/api/mkdocs/save_bundle', { library_path: libraryPath, selected_files: Array.from(selected), target_dir: exportFolder, title: siteName || '' });
      apply(data);
      notify(data.has_images
        ? `保存完了: ${data.markdown_name} ＋ ${data.image_name} (${data.stats?.total_images || 0}枚結合)`
        : `保存完了: ${data.markdown_name} (画像なし)`);
    } finally { setSaving(false); }
  };

  const openFolder = async () => {
    await api('/api/mkdocs/open_folder', { export_folder: exportFolder });
    notify(`保存先フォルダを開きました: ${exportFolder}`);
  };

  const downloadImage = () => {
    if (!imageDataUrl) return;
    const filename = `mkdocs_images.${imageExtension(imageDataUrl)}`;
    downloadDataUrl(filename, imageDataUrl);
    notify(`${filename}を保存しました。`);
  };

  return { exportFolder, setExportFolder, imageDataUrl, stats, viewTab, setViewTab, saving, reset, preview, save, persistExportFolder, openFolder, downloadImage };
}
