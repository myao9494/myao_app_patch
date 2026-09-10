/**
 * quickアプリ用 型定義
 * - 検索結果、ファイル詳細、設定情報のインターフェース
 */

export interface SearchResultItem {
  name: string;
  path: string;
  is_directory: boolean;
  size?: number;
  modified?: string | number;
  snippet?: string; // 検索キーワードにヒットした前後のテキスト
}

export interface AppSettings {
  serverHost: string;       // サーバーホスト名（例: mineomacbook-air.taild3cb7c.ts.net またはローカルIP）
  serverPort: string;       // バックエンドポート（デフォルト: 8001）
  excalidrawPort: string;   // Excalidrawポート（デフォルト: 3001）
  basePath: string;         // 検索対象のルートパス（デフォルト: /Users/mine/000_work）
  theme: 'dark' | 'light';  // テーマ
}

export type FilterCategory = 'all' | 'doc' | 'diagram';

export interface FileContentResponse {
  path: string;
  name: string;
  content: string;
  extension: string;
  is_editable: boolean;
}
