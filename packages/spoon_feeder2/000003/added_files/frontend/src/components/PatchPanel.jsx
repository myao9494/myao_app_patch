/**
 * AI出力の反映・テスト実行パネル (PatchPanel.jsx)
 *
 * 仕様:
 * 1. AIの回答を貼り付けて差分プレビューを作り、反映先が未確定の変更は候補から選ぶ。
 * 2. 差分が妥当ならまとめて反映する。反映後にテストコマンドを実行し、失敗時はLLMへ戻す文面をコピーできる。
 * 3. API・クリップボードのエラーは画面内のエラー欄に表示する。
 **/

import { useState } from 'react';
import { AlertTriangle, CirclePlay, Code2, Copy, LoaderCircle, Save, Search, TestTube2 } from 'lucide-react';
import { api } from '../api';

export function PatchPanel({ path, pythonMode, embeddedDir, notify, activeMode }) {
  const [output, setOutput] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [preview, setPreview] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testCommand, setTestCommand] = useState('python -m pytest');
  const [testResult, setTestResult] = useState(null);
  const requestPreview = async (nextOverrides = overrides) => {
    if (!path || !output.trim()) return setError('リポジトリとAI出力を指定してください。');
    setBusy(true); setError('');
    try { setPreview(await api('/api/patch/preview', { library_path: path, ai_output: output, target_path: targetPath, overrides: nextOverrides })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const choose = (key, value) => { const next = { ...overrides, [key]: value }; setOverrides(next); requestPreview(next); };
  const apply = async () => {
    setBusy(true); setError('');
    try { const data = await api('/api/patch/apply', { library_path: path, ai_output: output, target_path: targetPath, overrides }); if (data.status !== 'success') throw new Error(data.message); notify(data.message); setPreview(null); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setError('');
    try { setTestResult(await api('/api/test', { library_path: path, test_command: testCommand, python_mode: pythonMode, embedded_python_dir: embeddedDir })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const feedback = async () => {
    const merged = `${testResult?.stdout || ''}\n${testResult?.stderr || ''}`.trim();
    try {
      const data = await api('/api/feedback_context', { library_path: path, test_command: testCommand, output: merged, exit_code: testResult?.exit_code });
      await navigator.clipboard.writeText(data.context); notify('修正依頼用のテスト結果をコピーしました。');
    } catch (err) { setError(err.message); }
  };
  return <section className="card patch-card">
    <div className="section-heading"><div><span className="eyebrow">APPLY</span><h2><Code2/>AIの変更を反映</h2></div><span className="format-pill">{activeMode === 'mkdocs' ? 'Markdown・YAML反映対応' : '3形式を自動判定'}</span></div>
    <p className="section-help">{activeMode === 'mkdocs' ? 'AIが出力した <file_changes>、ファイルパス付きMarkdownブロック (```markdown path: docs/...)、またはファイル見出し形式を貼り付けてください。' : '関数全体、ファイルパス付きコードブロック、または <file_changes> を貼り付けてください。'}</p>
    <div className="patch-inputs"><textarea value={output} onChange={event => { setOutput(event.target.value); setPreview(null); }} placeholder="AIの回答をここに貼り付けます"/><div className="target-line"><input value={targetPath} onChange={event => setTargetPath(event.target.value)} placeholder="反映先ファイル（通常は空欄でOK）"/><button className="primary" onClick={() => requestPreview()} disabled={busy}>{busy ? <LoaderCircle className="spin"/> : <Search/>}差分を確認</button></div></div>
    {error && <div className="error-box"><AlertTriangle/>{error}</div>}
    {preview && <div className="preview-area">
      <div className="preview-title"><strong>{preview.message}</strong>{preview.status === 'success' && <button className="success-button" onClick={apply} disabled={busy}><Save/>この差分を反映</button>}</div>
      {preview.changes.map(change => <div className="change" key={change.key}>
        <div className="change-meta"><span>{change.path || change.symbol || '反映先未確定'}</span><em>{change.action}</em></div>
        {!change.path && <select value="" onChange={event => choose(change.key, event.target.value)}><option value="">反映先を選択…</option>{change.candidates.map(candidate => <option key={candidate}>{candidate}</option>)}</select>}
        {change.diff && <pre className="diff">{change.diff}</pre>}
      </div>)}
    </div>}
    <div className="test-row"><TestTube2/><input value={testCommand} onChange={event => setTestCommand(event.target.value)}/><button onClick={test} disabled={!path || busy}><CirclePlay/>テスト</button>{testResult && <span className={testResult.exit_code === 0 ? 'test-ok' : 'test-ng'}>{testResult.exit_code === 0 ? '成功' : `失敗 (${testResult.exit_code ?? 'timeout'})`}</span>}</div>
    {testResult && <div className="test-output"><pre>{`${testResult.stdout || ''}\n${testResult.stderr || ''}`}</pre>{testResult.exit_code !== 0 && <button onClick={feedback}><Copy/>LLMへ戻す文面をコピー</button>}</div>}
  </section>;
}
