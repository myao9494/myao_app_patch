/**
 * 外部のファイルハブ（Open hub。別アプリが 8001 番で提供する）で、ファイル・フォルダを開く URL を組み立てる。
 *
 * 接続先の既定は http://127.0.0.1:8001。ビルド時の VITE_OPEN_HUB_BASE_URL で差し替えられる。
 * 検索結果一覧と AIインプットが同じ接続先を使う。URL の形（/api/fullpath?path=、/?path=）は
 * ハブ側の既存の取り決めなので変えない（docs/open_hub.md）。
 */
type OpenHubEnv = { VITE_OPEN_HUB_BASE_URL?: string };

const DEFAULT_OPEN_HUB_BASE_URL = "http://127.0.0.1:8001";

function readBuildEnv(): OpenHubEnv | undefined {
  return (import.meta as ImportMeta & { env?: OpenHubEnv }).env;
}

/** ハブの接続先（末尾のスラッシュなし）を返す。 */
export function resolveOpenHubBaseUrl(env: OpenHubEnv | undefined = readBuildEnv()): string {
  const configured = env?.VITE_OPEN_HUB_BASE_URL?.trim();
  return (configured || DEFAULT_OPEN_HUB_BASE_URL).replace(/\/+$/, "");
}

/** ファイルをハブで開く URL。 */
export function buildOpenHubFileUrl(fullPath: string, env?: OpenHubEnv): string {
  return `${resolveOpenHubBaseUrl(env ?? readBuildEnv())}/api/fullpath?path=${encodeURIComponent(fullPath)}`;
}

/** フォルダをハブで開く URL。 */
export function buildOpenHubFolderUrl(folderPath: string, env?: OpenHubEnv): string {
  return `${resolveOpenHubBaseUrl(env ?? readBuildEnv())}/?path=${encodeURIComponent(folderPath)}`;
}
