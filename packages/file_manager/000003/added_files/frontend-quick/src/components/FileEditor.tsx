/**
 * スマホ最適化ファイル編集コンポーネント
 * - テキストエリアでの編集
 * - 保存処理と未保存警告
 * - モバイルキーボード対応（16px基準、自動ズーム防止）
 */
import React, { useState } from 'react';
import { FileContentResponse, AppSettings } from '../types';
import { saveFileContent } from '../api/client';
import { ArrowLeft, Save, Loader2, Check } from 'lucide-react';

interface FileEditorProps {
  file: FileContentResponse;
  settings: AppSettings;
  onBack: () => void;
  onSaved: (newContent: string) => void;
}

export const FileEditor: React.FC<FileEditorProps> = ({
  file,
  settings,
  onBack,
  onSaved,
}) => {
  const [content, setContent] = useState(file.content);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isDirty = content !== file.content;

  const handleCancel = () => {
    if (isDirty) {
      if (!window.confirm('変更が保存されていません。破棄して戻りますか？')) {
        return;
      }
    }
    onBack();
  };

  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      await saveFileContent(file.path, content, settings);
      setIsSaved(true);
      onSaved(content);
      setTimeout(() => setIsSaved(false), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存に失敗しました';
      setErrorMessage(msg);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="quick-editor-container">
      {/* エディタヘッダー */}
      <div className="quick-editor-header">
        <button className="quick-btn-back" onClick={handleCancel} aria-label="キャンセル">
          <ArrowLeft size={22} />
        </button>
        <div className="quick-editor-title-box">
          <h2 className="quick-editor-filename">{file.name}</h2>
          <span className="quick-editor-dirty-badge">
            {isDirty ? '● 未保存' : '保存済'}
          </span>
        </div>
        <div className="quick-editor-actions">
          <button
            className={`quick-btn-save ${isDirty ? 'active' : ''}`}
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            aria-label="保存"
          >
            {isSaving ? (
              <Loader2 size={18} className="animate-spin" />
            ) : isSaved ? (
              <Check size={18} />
            ) : (
              <Save size={18} />
            )}
            <span>{isSaving ? '保存中...' : isSaved ? '保存完了' : '保存'}</span>
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="quick-error-banner">
          <span>{errorMessage}</span>
        </div>
      )}

      {/* エディタ本体 */}
      <div className="quick-editor-body">
        <textarea
          className="quick-editor-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="テキストを入力..."
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
        />
      </div>
    </div>
  );
};
