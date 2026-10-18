/**
 * 参照ライブラリ（外部リポジトリ）の自動検出state (useReferences.js)
 *
 * 仕様:
 * 1. 選択ファイルが変わるたびに220ms後(デバウンス)に /api/reference_modules を呼び、参照リポジトリ・未解決モジュール・警告を更新する。
 * 2. Embedded Python / MkDocsモード / リポジトリ未選択では機能を無効にし、選択を空にする。
 * 3. 再解析後、新しく現れた参照ファイルは選択状態にし、既存のファイルは直前の選択を維持する。
 **/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { mergeReferenceSelection } from '../lib/selection';

const DISABLED = { enabled: false, repositories: [], unresolved: [], manual_references: {}, warnings: [] };

export function useReferences({ activePath, pythonMode, selected, activeMode }) {
  const [referenceData, setReferenceData] = useState({ ...DISABLED, enabled: true });
  const [referenceSelected, setReferenceSelected] = useState(new Set());
  const availableRef = useRef(new Set());

  const refreshReferences = useCallback(async () => {
    if (!activePath || pythonMode === 'embedded' || activeMode === 'mkdocs') {
      availableRef.current = new Set(); setReferenceSelected(new Set());
      setReferenceData(DISABLED);
      return;
    }
    try {
      const data = await api('/api/reference_modules', { library_path: activePath, selected_files: Array.from(selected), python_mode: pythonMode });
      const available = new Set((data.repositories || []).flatMap(repo => (repo.files || []).map(file => `${repo.path}::${file}`)));
      const previousAvailable = availableRef.current;
      setReferenceSelected(previous => mergeReferenceSelection(available, previousAvailable, previous));
      availableRef.current = available;
      setReferenceData(data);
    } catch (err) {
      setReferenceData(previous => ({ ...previous, warnings: [err.message] }));
    }
  }, [activePath, pythonMode, selected, activeMode]);

  useEffect(() => {
    const timer = setTimeout(refreshReferences, 220);
    return () => clearTimeout(timer);
  }, [refreshReferences]);

  const referenceFileCount = useMemo(() => (referenceData.repositories || []).reduce((total, repo) => total + (repo.files || []).length, 0), [referenceData]);
  return { referenceData, referenceSelected, setReferenceSelected, refreshReferences, referenceFileCount };
}
