/**
 * ファイル選択・モード判定の純粋ロジック (selection.js)
 *
 * 仕様:
 * 1. flattenFiles: ツリーから選択可能なファイル(ignored除外)のパスを再帰的に列挙する。
 * 2. filterReferenceFilesByInclusion: 「呼び出されているモジュールを含む」がONのときだけ、選択された参照ファイルをAPI形式で返す。
 * 3. mergeAutoSelectedFiles: 現在の選択に自動検出ファイルを重複なく追加する。
 * 4. resolveRepositoryMode: MkDocs判定と手動切替から実際のモード(code / mkdocs)を決める。
 * 5. initialSelection: 保存済み選択とツリーを突き合わせ、存在するファイルだけを復元する（保存なしなら全選択）。
 * 6. toggleSelection: ディレクトリ/ファイルのチェック切替後の選択集合を返す。
 * 7. mergeReferenceSelection: 参照ライブラリの再解析後、新規に現れたファイルは選択、既存は直前の選択状態を維持する。
 * 8. parseIgnoreText: 無視リスト編集テキストを、区切りを / に統一し空行と重複を除いたパターン配列にする。
 * 9. nodeMatchesFilter: ファイル検索フィルターに一致するか（大文字小文字無視）。
 **/

export const flattenFiles = (nodes) => nodes.flatMap(node => node.type === 'file' ? (node.ignored ? [] : [node.path]) : flattenFiles(node.children || []));

export const filterReferenceFilesByInclusion = (repositories, selected, includeExternal) => {
  if (!includeExternal) return [];
  return (repositories || []).map(repo => {
    const files = (repo.files || []).filter(file => selected.has(`${repo.path}::${file}`));
    return { repository_path: repo.path, files };
  }).filter(repo => repo.files.length > 0);
};

export const mergeAutoSelectedFiles = (currentSelected, detectedFiles) => {
  return new Set([...Array.from(currentSelected), ...detectedFiles]);
};

export const resolveRepositoryMode = (isMkdocsRepo, userOverrideMode = '') => {
  if (userOverrideMode === 'mkdocs' || userOverrideMode === 'code') {
    return userOverrideMode;
  }
  return isMkdocsRepo ? 'mkdocs' : 'code';
};

export const initialSelection = (savedFiles, allFiles) => {
  if (!savedFiles?.length) return new Set(allFiles);
  const available = new Set(allFiles);
  return new Set(savedFiles.filter(file => available.has(file)));
};

export const toggleSelection = (previous, paths, checked) => {
  const next = new Set(previous);
  paths.forEach(path => (checked ? next.delete(path) : next.add(path)));
  return next;
};

export const mergeReferenceSelection = (available, previousAvailable, previousSelected) =>
  new Set(Array.from(available).filter(key => !previousAvailable.has(key) || previousSelected.has(key)));

export const parseIgnoreText = text =>
  Array.from(new Set(text.split(/\r?\n/).map(item => item.replaceAll('\\', '/').trim()).filter(Boolean)));

export const nodeMatchesFilter = (path, filter) => !filter || path.toLowerCase().includes(filter.toLowerCase());
