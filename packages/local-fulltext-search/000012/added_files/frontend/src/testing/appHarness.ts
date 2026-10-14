/**
 * アプリ全体を DOM へ描画して操作するテストの共通の準備。
 * 起動時の API へ既定の応答を返し、ページの切り替えや通知の読み取りなど、よく使う操作をまとめる。
 */
import { installAppApi } from "./apiFixtures.ts";
import {
  click,
  findBySelector,
  findByText,
  hasElement,
  installAppStyles,
  installDom,
  last,
  mount,
  normalizeText,
  typeInto,
} from "./dom.ts";
import { loadSourceModule } from "./render.ts";

type AppModule = typeof import("../App.tsx");
export type Routes = NonNullable<Parameters<typeof installAppApi>[0]>;

export type OpenAppOptions = {
  /** 起動 URL のクエリ文字列（例: "?q=alpha"） */
  search?: string;
  /** 保存済みの localStorage の値 */
  storage?: Record<string, string>;
  /** 差し替える API の応答 */
  routes?: Routes;
  /** 開いた直後に切り替えるページ（上部タブの表示名） */
  page?: string;
  /** アプリのスタイルシートを読み込む（適用されるスタイルを確かめるテスト用） */
  withStyles?: boolean;
};

export async function openApp(options: OpenAppOptions = {}) {
  const dom = installDom({ search: options.search, storage: options.storage });
  const api = installAppApi(options.routes);
  if (options.withStyles) {
    await installAppStyles();
  }
  const { default: App } = await loadSourceModule<AppModule>("/src/App.tsx");
  const view = await mount(App, {});
  const container = view.container;
  const app = {
    api,
    dom,
    container,
    /** 画面全体の文字（要素の間に空白は入らない） */
    text: () => normalizeText(container.textContent),
    /** ページ本体（設定ドロワーを除く）の文字 */
    pageText: () => normalizeText(findBySelector(container, "main.content-grid > :first-child").parentElement?.firstElementChild?.textContent),
    notice: () => normalizeText(container.querySelector(".notice-banner")?.textContent),
    error: () => normalizeText(container.querySelector(".error-banner")?.textContent),
    openPage: async (tabName: string) => {
      await click(findByText(container, "button.page-tab", tabName));
    },
    isDrawerOpen: () => hasElement(container, "aside.settings-drawer.open"),
    drawer: () => findBySelector(container, "aside.settings-drawer"),
    runSearch: async (query = "alpha") => {
      await typeInto(findBySelector<HTMLInputElement>(container, "input.search-input"), query);
      await click(findBySelector(container, ".search-nav .primary-button"));
    },
    lastBody: (route: string) => last(api.requestsTo(route))?.body as Record<string, unknown>,
    close: async () => {
      await view.unmount();
      api.restore();
      dom.close();
    },
  };
  if (options.page) {
    await app.openPage(options.page);
  }
  return app;
}

export type AppHarness = Awaited<ReturnType<typeof openApp>>;

/** アプリを開いてテスト本体を実行し、成功・失敗にかかわらず後始末をする。 */
export async function withApp(options: OpenAppOptions, body: (app: AppHarness) => Promise<void>): Promise<void> {
  const app = await openApp(options);
  try {
    await body(app);
  } finally {
    await app.close();
  }
}
