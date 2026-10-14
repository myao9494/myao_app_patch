/**
 * コンポーネントを実際に描画して検証するテスト用の描画処理。
 *
 * Vite でソース（TSX）をその場で読み込み、React のサーバー描画で HTML 文字列にする。
 * ブラウザーを使わないため、描画されるのは初回の表示内容だけで、useEffect やクリック操作は実行されない。
 * 「この状態を渡すと、この内容が表示される」を確かめる用途に使う。
 */
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

let serverPromise: Promise<ViteDevServer> | null = null;

function getServer(): Promise<ViteDevServer> {
  serverPromise ??= createServer({
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  return serverPromise;
}

/** src からのパス（例: "/src/pages/SchedulerPage.tsx"）でモジュールを読み込む。 */
export async function loadSourceModule<T = Record<string, unknown>>(sourcePath: string): Promise<T> {
  const server = await getServer();
  return (await server.ssrLoadModule(sourcePath)) as T;
}

/** コンポーネントを描画し、HTML 文字列を返す。 */
export function renderToHtml<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(component, props));
}

/** HTML からタグを取り除き、表示される文字だけを返す。 */
export function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** テストの最後に呼び、読み込み用のサーバーを止める。 */
export async function closeRenderer(): Promise<void> {
  if (serverPromise) {
    const server = await serverPromise;
    serverPromise = null;
    await server.close();
  }
}

/**
 * ブラウザーにしか無いグローバル（window.location / localStorage / navigator）の代用品を用意する。
 * 起動 URL のクエリ文字列と、保存済みの設定値を指定できる。
 */
export function installBrowserStubs(options: { search?: string; storage?: Record<string, string> } = {}): void {
  const storage = new Map(Object.entries(options.storage ?? {}));
  const localStorageStub = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  const globals = globalThis as Record<string, unknown>;
  globals.localStorage = localStorageStub;
  globals.window = { location: { search: options.search ?? "" }, localStorage: localStorageStub };
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true });
}
