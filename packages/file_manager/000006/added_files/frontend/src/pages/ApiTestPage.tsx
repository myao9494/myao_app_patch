/**
 * APIテストページ
 * 外部連携用APIをテストするためのページ
 * PWA配信時は同一オリジンのため相対パスを使用
 */
import { useState } from "react";
import "./ApiTestPage.css";
import { errorMessage } from "../utils/errorMessage";

const API_BASE_URL = "/api";

interface ApiResult {
    status: string;
    message?: string;
    action?: string;
    content?: string;
    detail?: string;
}

export function ApiTestPage() {
    const [path, setPath] = useState("");
    const [result, setResult] = useState<ApiResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // API呼び出し共通関数
    const callApi = async (endpoint: string, method: "GET" | "POST" = "GET") => {
        setLoading(true);
        setError(null);
        setResult(null);

        try {
            const url = method === "GET"
                ? `${API_BASE_URL}${endpoint}?path=${encodeURIComponent(path)}`
                : `${API_BASE_URL}${endpoint}`;

            const options: RequestInit = { method };
            if (method === "POST") {
                options.headers = { "Content-Type": "application/json" };
                options.body = JSON.stringify({ path });
            }

            const response = await fetch(url, options);
            const data = await response.json();

            if (!response.ok) {
                setError(data.detail || "APIエラー");
            } else {
                setResult(data);
            }
        } catch (e) {
            setError(errorMessage(e) || "接続エラー");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="api-test-page">
            <h1>API テストページ</h1>
            <p className="subtitle">外部連携用APIをテストします</p>

            <div className="input-section">
                <label htmlFor="path-input">ファイル/フォルダのフルパス:</label>
                <input
                    id="path-input"
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="/Users/xxx/Documents/file.pdf または \\server\share\file.txt"
                    className="path-input"
                />
            </div>

            <div className="api-buttons">
                <h2>file_viewer互換API (GET)</h2>
                <div className="button-group">
                    <button onClick={() => callApi("/fullpath")} disabled={loading || !path}>
                        /fullpath<br /><small>スマートオープン</small>
                    </button>
                </div>

                <h2>file_viewer互換API (POST)</h2>
                <div className="button-group">
                    <button onClick={() => callApi("/open-path", "POST")} disabled={loading || !path}>
                        /open-path<br /><small>パスを開く</small>
                    </button>
                    <button onClick={() => callApi("/open-folder", "POST")} disabled={loading || !path}>
                        /open-folder<br /><small>フォルダを開く</small>
                    </button>
                </div>

                <h2>内部API (POST)</h2>
                <div className="button-group">
                    <button onClick={() => callApi("/open/smart", "POST")} disabled={loading || !path}>
                        /open/smart<br /><small>スマートオープン</small>
                    </button>
                    <button onClick={() => callApi("/open/default", "POST")} disabled={loading || !path}>
                        /open/default<br /><small>デフォルトアプリ</small>
                    </button>
                    <button onClick={() => callApi("/open/vscode", "POST")} disabled={loading || !path}>
                        /open/vscode<br /><small>VSCodeで開く</small>
                    </button>
                    <button onClick={() => callApi("/open/explorer", "POST")} disabled={loading || !path}>
                        /open/explorer<br /><small>Finderで開く</small>
                    </button>
                </div>
            </div>

            <div className="result-section">
                <h2>結果</h2>
                {loading && <div className="loading">読み込み中...</div>}
                {error && <div className="error">エラー: {error}</div>}
                {result && (
                    <pre className="result">
                        {JSON.stringify(result, null, 2)}
                    </pre>
                )}
            </div>

            <div className="api-docs">
                <h2>使い方</h2>
                <p>ブラウザやcmdから直接APIを呼び出せます:</p>
                <code>
                    http://localhost:5001/api/fullpath?path=/path/to/file.pdf
                </code>
                <p>Windowsネットワークドライブの場合:</p>
                <code>
                    http://localhost:5001/api/fullpath?path=//server/share/file.txt
                </code>
            </div>
        </div>
    );
}
