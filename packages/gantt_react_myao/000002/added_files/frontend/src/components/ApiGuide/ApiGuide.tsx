import { useState } from 'react';
import './ApiGuide.css';

/**
 * API ガイドコンポーネント
 * AI や外部アプリがこのシステムの API を利用するためのリファレンス
 * 簡易的なテスト実行機能付き
 **/
/** テスト実行の結果（成功時は status / data / timestamp、通信エラー時は error） */
interface TestResult {
  status?: number;
  data?: unknown;
  timestamp?: string;
  error?: string;
}

export function ApiGuide() {
  const baseUrl = `${window.location.origin}/api`;
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const runTest = async (method: string, path: string, body?: unknown) => {
    setIsLoading(true);
    setTestResult(null);
    try {
      const options: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (body) options.body = JSON.stringify(body);

      const response = await fetch(`${baseUrl}${path}`, options);
      const data = await response.json();
      setTestResult({
        status: response.status,
        data,
        timestamp: new Date().toLocaleTimeString()
      });
    } catch (err) {
      setTestResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  const defaultTaskBody = {
    text: "AI テストタスク",
    start_date: new Date().toISOString().split('T')[0] + " 00:00:00",
    end_date: new Date(Date.now() + 86400000).toISOString().split('T')[0] + " 00:00:00",
    progress: 0.1,
    parent: 0,
    kind_task: 1,
    memo: "API ガイドから作成したメモ"
  };

  return (
    <div className="api-guide-page">
      <div className="api-guide-container">
        <header className="api-guide-header">
          <div className="header-top">
            <h1>Gantt App API Guide</h1>
            <button onClick={() => window.close()} className="btn close-window-btn">✕ 閉じる</button>
          </div>
          <p>このガイドは、AI や外部アプリケーションが本システムのデータを操作するためのリファレンスです。実際に API をテストすることもできます。</p>
        </header>

        <section className="api-section">
          <h2>基本情報</h2>
          <div className="info-card">
            <ul>
              <li><strong>Base URL:</strong> <code>{baseUrl}</code></li>
              <li><strong>認証:</strong> なし (個人利用・ローカルネットワーク想定)</li>
              <li><strong>形式:</strong> JSON (<code>application/json</code>)</li>
            </ul>
          </div>
        </section>

        <section className="api-section">
          <h2>主要エンドポイント</h2>

          <div className="endpoint-group">
            <h3>タスク (Tasks)</h3>
            
            <div className="method-box get">
              <div className="method-header">
                <span className="method">GET</span> <code>/tasks</code>
                <button 
                  className="test-btn" 
                  onClick={() => runTest('GET', '/tasks')}
                  disabled={isLoading}
                >
                  実行テスト
                </button>
              </div>
              <p className="description">全タスクとリンクのリストを取得します。</p>
            </div>

            <div className="method-box post">
              <div className="method-header">
                <span className="method">POST</span> <code>/tasks</code>
                <button 
                  className="test-btn" 
                  onClick={() => runTest('POST', '/tasks', defaultTaskBody)}
                  disabled={isLoading}
                >
                  実行テスト (サンプル送信)
                </button>
              </div>
              <p className="description">新しいタスクを作成します。</p>
              <pre className="code-block">
{JSON.stringify(defaultTaskBody, null, 2)}
              </pre>
            </div>

            <div className="method-box post">
              <div className="method-header">
                <span className="method">POST</span> <code>/tasks/{'{task_id}'}/open-input</code>
                <button
                  className="test-btn"
                  onClick={() => runTest('POST', '/tasks/1/open-input')}
                  disabled={isLoading}
                >
                  実行テスト (ID: 1)
                </button>
              </div>
              <p className="description">指定したタスクIDの入力画面を、開いているガント画面上で表示します。外部アプリからこのAPIを呼び出す用途です。</p>
              <pre className="code-block">
curl -X POST {baseUrl}/tasks/1/open-input
              </pre>
            </div>

            <div className="method-box get">
              <div className="method-header">
                <span className="method">GET</span> <code>/health</code>
                <button 
                  className="test-btn" 
                  onClick={() => runTest('GET', '/health')}
                  disabled={isLoading}
                >
                  実行テスト
                </button>
              </div>
              <p className="description">API の稼働状況を確認します。</p>
            </div>
          </div>

          <div className="endpoint-group">
            <h3>カレンダー (Holidays)</h3>
            <div className="method-box get">
              <div className="method-header">
                <span className="method">GET</span> <code>/holidays</code>
                <button 
                  className="test-btn" 
                  onClick={() => runTest('GET', '/holidays')}
                  disabled={isLoading}
                >
                  実行テスト
                </button>
              </div>
              <p className="description">設定済みの休日リストを取得します。</p>
            </div>
          </div>
        </section>

        {testResult && (
          <section className="test-result-section">
            <div className="test-result-header">
              <h2>テスト実行結果</h2>
              <button className="clear-btn" onClick={() => setTestResult(null)}>クリア</button>
            </div>
            <div className="result-box">
              <div className="result-meta">
                {testResult.status && <span className="status-badge">Status: {testResult.status}</span>}
                {testResult.timestamp && <span className="time-badge">{testResult.timestamp}</span>}
              </div>
              <pre className="code-block">
                {JSON.stringify(testResult.data || testResult.error, null, 2)}
              </pre>
            </div>
          </section>
        )}

        <section className="api-section">
          <h2>データ構造 (Task Object)</h2>
          <div className="table-wrapper">
            <table className="api-table">
              <thead>
                <tr>
                  <th>フィールド</th>
                  <th>型</th>
                  <th>説明</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>id</td><td>int</td><td>一意の識別子</td></tr>
                <tr><td>text</td><td>string</td><td>タスク名</td></tr>
                <tr><td>start_date</td><td>string</td><td>開始日時 (YYYY-MM-DD HH:mm:ss)</td></tr>
                <tr><td>end_date</td><td>string</td><td>終了日時 (YYYY-MM-DD HH:mm:ss)</td></tr>
                <tr><td>duration</td><td>int</td><td>期間（日）</td></tr>
                <tr><td>progress</td><td>float</td><td>進捗率 (0.0 - 1.0)</td></tr>
                <tr><td>parent</td><td>int</td><td>親タスクのID (0はルート)</td></tr>
                <tr><td>kind_task</td><td>int</td><td>種類 (1:task, 2:project, 3:milestone)</td></tr>
                <tr><td>memo</td><td>string</td><td>メモ</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="api-section">
          <h2>AI への指示例 (Prompt Example)</h2>
          <div className="prompt-box">
            <p>「ポート 8002 で稼働しているガントチャートアプリの API を使って、今日の進捗が 50% 未満のタスクをリストアップし、それらの終了日を 1日延期する Python スクリプトを書いてください。」</p>
          </div>
        </section>
      </div>
    </div>
  );
}
