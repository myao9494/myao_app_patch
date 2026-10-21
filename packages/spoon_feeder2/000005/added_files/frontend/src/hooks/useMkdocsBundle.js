/**
 * MkDocsモードの「統合マークダウン＋結合画像」state と操作 (useMkdocsBundle.js)
 *
 * 仕様:
 * 1. 保存先フォルダ設定をサーバーから読み込み、変更後の保存時にサーバーへ永続化する。
 * 2. preview: /api/mkdocs/context でコンテキストと結合画像のData URLを生成する（保存はしない）。
 *    20万文字超のMDはtext_parts、画像は4.5MB以下ごとのimage_partsに分割されて返る。
 * 3. save: 保存先へ「*_context.md」と「*_images.png/.jpg」を書き出す（分割時は _partNofM を付けた複数ファイル）。サーバー側で読み直し検証済み。
 * 4. openFolder: 保存先フォルダをFinder / Explorerで開く。
 * 5. persistExportFolder: 保存先設定を永続化する（コードモードの保存も同じ保存先を使う）。
 * エラーは呼び出し側(MainPage)へ例外として伝える。
 **/

import { useEffect, useState } from 'react';
import { api } from '../api';
import { downloadDataUrl, imageExtension, partFileName } from '../lib/download';

export function useMkdocsBundle({ libraryPath, selected, siteName, notify, setOutput }) {
  const [exportFolder, setExportFolder] = useState('~/Desktop/AI_Inputs');
  const [imageParts, setImageParts] = useState([]);
  const [stats, setStats] = useState(null);
  const [viewTab, setViewTab] = useState('markdown');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/api/mkdocs/export_config', undefined, 'GET').then(data => { if (data.export_folder) setExportFolder(data.export_folder); }).catch(() => {});
  }, []);

  const reset = () => { setImageParts([]); setStats(null); };
  const apply = data => { setOutput(data.context || '', data.text_parts || []); setImageParts(data.image_parts || []); setStats(data.stats || null); };
  const partsMessage = data => {
    const markdown = data.text_parts?.length || 1;
    const images = data.image_parts?.length || 0;
    return markdown > 1 || images > 1 ? `（MD${markdown}ファイル・画像${images}枚に分割）` : '';
  };

  const preview = async () => {
    const data = await api('/api/mkdocs/context', { library_path: libraryPath, selected_files: Array.from(selected), title: siteName || '' });
    apply(data);
    notify(`MkDocsコンテキスト（文書${data.stats?.total_documents || 0}件・結合画像${data.stats?.total_images || 0}枚）を作成しました。${partsMessage(data)}${data.warning ? ` ${data.warning}` : ''}`);
  };

  const persistExportFolder = () => api('/api/mkdocs/export_config', { export_folder: exportFolder });

  const save = async () => {
    setSaving(true);
    try {
      await persistExportFolder();
      const data = await api('/api/mkdocs/save_bundle', { library_path: libraryPath, selected_files: Array.from(selected), target_dir: exportFolder, title: siteName || '' });
      apply(data);
      const markdownNames = data.markdown_files.map(item => item.name).join(' / ');
      const imageNames = data.image_files.map(item => item.name).join(' / ');
      notify(`保存・検証完了: ${markdownNames}${data.has_images ? ` ＋ ${imageNames} (${data.stats?.total_images || 0}枚結合)` : ' (画像なし)'}${data.warning ? ` ${data.warning}` : ''}`);
    } finally { setSaving(false); }
  };

  const openFolder = async () => {
    await api('/api/mkdocs/open_folder', { export_folder: exportFolder });
    notify(`保存先フォルダを開きました: ${exportFolder}`);
  };

  const downloadImage = () => {
    if (imageParts.length === 0) return;
    const names = imageParts.map(part => {
      const filename = partFileName('mkdocs_images', part.index, part.total, imageExtension(part.data_url));
      downloadDataUrl(filename, part.data_url);
      return filename;
    });
    notify(`${names.join(' / ')}を保存しました。`);
  };

  return { exportFolder, setExportFolder, imageParts, stats, viewTab, setViewTab, saving, reset, preview, save, persistExportFolder, openFolder, downloadImage };
}
