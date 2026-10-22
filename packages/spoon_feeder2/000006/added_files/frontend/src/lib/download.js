/**
 * ブラウザでのファイル保存補助 (download.js)
 *
 * 仕様:
 * 1. downloadText: テキストをUTF-8のファイルとして保存する。
 * 2. downloadDataUrl: Data URL(図PDF等)をBlob経由でファイルとして保存する（大きなData URLをそのままリンクにしない）。
 * 3. dataUrlToBlob: Base64のData URLをBlobへ変換する（PDFのプレビュー表示にも使う）。
 * 4. partFileName: 分割出力のファイル名（分割なしは `base.ext`、ありは `base_part2of3.ext`。バックエンドの命名と揃える）。
 **/

export const partFileName = (base, index, total, extension) => (total <= 1 ? `${base}.${extension}` : `${base}_part${index}of${total}.${extension}`);

const clickDownload = (href, filename) => {
  const link = document.createElement('a');
  link.href = href; link.download = filename; link.click();
};

export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  clickDownload(url, filename);
  URL.revokeObjectURL(url);
}

export function dataUrlToBlob(dataUrl) {
  const [head, body = ''] = dataUrl.split(',');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: head.slice(5, head.indexOf(';')) || 'application/octet-stream' });
}

export function downloadDataUrl(filename, dataUrl) {
  const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
  clickDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
