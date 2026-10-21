/**
 * ブラウザでのファイル保存補助 (download.js)
 *
 * 仕様:
 * 1. downloadText: テキストをUTF-8のファイルとして保存する。
 * 2. downloadDataUrl: Data URL(画像等)をファイルとして保存する。
 * 3. imageExtension: 結合画像のData URLからPNG/JPEGの拡張子を判定する。
 * 4. partFileName: 分割出力のファイル名（分割なしは `base.ext`、ありは `base_part2of3.ext`。バックエンドの命名と揃える）。
 **/

export const imageExtension = dataUrl => (dataUrl.startsWith('data:image/png') ? 'png' : 'jpg');

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

export function downloadDataUrl(filename, dataUrl) {
  clickDownload(dataUrl, filename);
}
