/**
 * MkDocsモードの「統合マークダウン＋図PDF」state と操作 (useMkdocsBundle.js)
 *
 * 仕様:
 * 1. 保存先フォルダ設定をサーバーから読み込み、変更後の保存時にサーバーへ永続化する。
 * 2. preview: /api/mkdocs/context でコンテキストと図PDFのData URLを生成する（保存はしない）。
 *    20万文字超のMDはtext_parts、図PDFは上限(pdfMaxMb。既定10MB)以下ごとのpdf_partsに分割されて返る。
 * 3. save: 保存先へ「*_context.md」と「*_images.pdf」を書き出す（分割時は _partNofM を付けた複数ファイル）。サーバー側で読み直し検証済み。
 * 4. openFolder: 保存先フォルダをFinder / Explorerで開く。
 * 5. persistExportFolder: 保存先設定を永続化する（コードモードの保存も同じ保存先を使う）。
 * 6. pdfMaxMbText: 図PDFの上限(MB)の入力文字列。localStorageへ保存し、リクエストには範囲内に丸めた数値(pdfMaxMb)を送る。
 * エラーは呼び出し側(MainPage)へ例外として伝える。
 **/

import { useEffect, useState } from 'react';
import { api } from '../api';
import { downloadDataUrl, partFileName } from '../lib/download';
import { DEFAULT_PDF_MAX_MB, parsePdfMaxMb } from '../lib/pdfLimit';
import { usePersistentState } from './usePersistentState';

export function useMkdocsBundle({ libraryPath, selected, siteName, notify, setOutput }) {
  const [exportFolder, setExportFolder] = useState('~/Desktop/AI_Inputs');
  const [pdfParts, setPdfParts] = useState([]);
  const [pdfMaxMbText, setPdfMaxMbText] = usePersistentState('pdfMaxMb', String(DEFAULT_PDF_MAX_MB));
  const pdfMaxMb = parsePdfMaxMb(pdfMaxMbText);
  const [stats, setStats] = useState(null);
  const [viewTab, setViewTab] = useState('markdown');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/api/mkdocs/export_config', undefined, 'GET').then(data => { if (data.export_folder) setExportFolder(data.export_folder); }).catch(() => {});
  }, []);

  const reset = () => { setPdfParts([]); setStats(null); };
  const apply = data => { setOutput(data.context || '', data.text_parts || []); setPdfParts(data.pdf_parts || []); setStats(data.stats || null); };
  const partsMessage = data => {
    const markdown = data.text_parts?.length || 1;
    const pdfs = data.pdf_parts?.length || 0;
    return markdown > 1 || pdfs > 1 ? `（MD${markdown}ファイル・図PDF${pdfs}ファイルに分割）` : '';
  };

  const preview = async () => {
    const data = await api('/api/mkdocs/context', { library_path: libraryPath, selected_files: Array.from(selected), title: siteName || '', pdf_max_mb: pdfMaxMb });
    apply(data);
    notify(`MkDocsコンテキスト（文書${data.stats?.total_documents || 0}件・図${data.stats?.total_images || 0}枚）を作成しました。${partsMessage(data)}${data.warning ? ` ${data.warning}` : ''}`);
  };

  const persistExportFolder = () => api('/api/mkdocs/export_config', { export_folder: exportFolder });

  const save = async () => {
    setSaving(true);
    try {
      await persistExportFolder();
      const data = await api('/api/mkdocs/save_bundle', { library_path: libraryPath, selected_files: Array.from(selected), target_dir: exportFolder, title: siteName || '', pdf_max_mb: pdfMaxMb });
      apply(data);
      const markdownNames = data.markdown_files.map(item => item.name).join(' / ');
      const pdfNames = data.pdf_files.map(item => item.name).join(' / ');
      notify(`保存・検証完了: ${markdownNames}${data.has_images ? ` ＋ ${pdfNames} (図${data.stats?.total_images || 0}枚)` : ' (図なし)'}${data.warning ? ` ${data.warning}` : ''}`);
    } finally { setSaving(false); }
  };

  const openFolder = async () => {
    await api('/api/mkdocs/open_folder', { export_folder: exportFolder });
    notify(`保存先フォルダを開きました: ${exportFolder}`);
  };

  const downloadPdf = () => {
    if (pdfParts.length === 0) return;
    const names = pdfParts.map(part => {
      const filename = partFileName('mkdocs_images', part.index, part.total, 'pdf');
      downloadDataUrl(filename, part.data_url);
      return filename;
    });
    notify(`${names.join(' / ')}を保存しました。`);
  };

  return { exportFolder, setExportFolder, pdfParts, pdfMaxMbText, setPdfMaxMbText, stats, viewTab, setViewTab, saving, reset, preview, save, persistExportFolder, openFolder, downloadPdf };
}
