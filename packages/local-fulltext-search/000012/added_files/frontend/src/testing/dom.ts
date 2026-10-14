/**
 * 画面を DOM（jsdom）へ描画し、クリックや入力のあとの動きまで検証するためのテスト補助。
 *
 * render.ts のサーバー描画は初回の表示しか確かめられない。こちらは React を実際に動かすので、
 * useEffect・状態の更新・API 呼び出し（fetch の代用品で記録する）まで検証できる。
 *
 * 使い方:
 *   const dom = installDom({ search: "?q=abc" });
 *   const api = installFetchStub({ "GET /api/index/status": { is_running: false } });
 *   const { App } = await loadSourceModule("/src/App.tsx");
 *   const view = await mount(App, {});
 *   await click(findByText(view.container, "button", "検索"));
 *   await view.unmount(); dom.close();
 */
import { createElement, type ComponentType } from "react";
import { JSDOM } from "jsdom";

type DomHandle = {
  window: JSDOM["window"];
  /** window.confirm / alert / prompt に渡された文言 */
  dialogs: string[];
  /** 次の confirm の答え（既定は true） */
  setConfirmAnswer(answer: boolean): void;
  /** window.open で開こうとした URL */
  openedUrls: string[];
  /** クリップボードへ書き込まれた文字列 */
  clipboardWrites: string[];
  /** クリップボードへの書き込みを失敗させる（権限が無い環境の再現） */
  denyClipboard(): void;
  /** ダウンロード用に作られた Blob の内容（URL.createObjectURL に渡されたもの） */
  downloads: Blob[];
  /** 監視中の要素が画面に入ったことにする（一覧の末尾での追加読み込みなど） */
  triggerIntersection(): Promise<void>;
  /** 要素の描画サイズを偽装する（jsdom はレイアウトを計算しないため、はみ出しの判定に使う） */
  setElementSize(size: { scrollHeight: number; clientHeight: number }): void;
  close(): void;
};

const GLOBAL_NAMES = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "CustomEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

/** jsdom のウィンドウを作り、React が参照するグローバルへ設定する。 */
export function installDom(options: { search?: string; storage?: Record<string, string> } = {}): DomHandle {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: `http://127.0.0.1:8079/${options.search ?? ""}`,
    pretendToBeVisual: true,
  });
  const globals = globalThis as Record<string, unknown>;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of GLOBAL_NAMES) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true,
    });
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  for (const [key, value] of Object.entries(options.storage ?? {})) {
    dom.window.localStorage.setItem(key, value);
  }

  const dialogs: string[] = [];
  let confirmAnswer = true;
  dom.window.confirm = (message?: string) => {
    dialogs.push(String(message ?? ""));
    return confirmAnswer;
  };
  dom.window.alert = (message?: string) => void dialogs.push(String(message ?? ""));
  // 画面のコードは window. を付けずに alert / confirm を呼ぶことがある
  for (const name of ["alert", "confirm"] as const) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    globals[name] = (message?: string) => dom.window[name](message);
  }

  // 「保存しました」の表示を数秒後に消すタイマーなどが、テストの終了後まで残らないよう、作られたタイマーを覚えておく
  // Node のタイマー（DOM の型定義では戻り値が number になるため、型を明示して扱う）
  type TimerHandle = unknown;
  type TimerFunction = (handler: () => void, delay?: number) => TimerHandle;
  const originalSetTimeout = globals.setTimeout as TimerFunction;
  const originalSetInterval = globals.setInterval as TimerFunction;
  const clearTimer = (timer: TimerHandle): void => {
    (globals.clearTimeout as (handle: TimerHandle) => void)(timer);
    (globals.clearInterval as (handle: TimerHandle) => void)(timer);
  };
  const pendingTimers = new Set<TimerHandle>();
  globals.setTimeout = (handler: () => void, delay?: number) => {
    const timer: TimerHandle = originalSetTimeout(() => {
      pendingTimers.delete(timer);
      handler();
    }, delay);
    pendingTimers.add(timer);
    return timer;
  };
  globals.setInterval = (handler: () => void, delay?: number) => {
    const timer = originalSetInterval(handler, delay);
    pendingTimers.add(timer);
    return timer;
  };

  const downloads: Blob[] = [];
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    downloads.push(blob);
    return `blob:test/${downloads.length}`;
  };
  URL.revokeObjectURL = () => undefined;
  // jsdom はリンクのクリックによる画面遷移を実装していない（ダウンロード用の a 要素のクリックで警告を出さない）
  dom.window.HTMLAnchorElement.prototype.click = () => undefined;
  dom.window.scrollTo = () => undefined;
  const openedUrls: string[] = [];
  dom.window.open = (url?: string | URL) => {
    openedUrls.push(String(url ?? ""));
    return null;
  };
  // jsdom は要素のスクロール位置合わせを実装していない
  dom.window.Element.prototype.scrollIntoView = () => undefined;

  const clipboardWrites: string[] = [];
  let isClipboardDenied = false;
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: {
      writeText: async (text: string) => {
        if (isClipboardDenied) {
          throw new Error("NotAllowedError: Write permission denied.");
        }
        clipboardWrites.push(text);
      },
    },
    configurable: true,
  });
  // 権限が無いときの代替手段（document.execCommand("copy")）も、同じように成否を切り替える
  dom.window.document.execCommand = () => !isClipboardDenied;

  // jsdom には IntersectionObserver が無い。監視の開始だけ記録し、テストから発火させる。
  type IntersectionCallback = (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;
  const intersectionObservers = new Set<{ callback: IntersectionCallback; targets: Set<Element> }>();
  class IntersectionObserverStub {
    private readonly record: { callback: IntersectionCallback; targets: Set<Element> };
    constructor(callback: IntersectionCallback) {
      this.record = { callback, targets: new Set() };
      intersectionObservers.add(this.record);
    }
    observe(target: Element): void {
      this.record.targets.add(target);
    }
    unobserve(target: Element): void {
      this.record.targets.delete(target);
    }
    disconnect(): void {
      intersectionObservers.delete(this.record);
    }
  }
  previous.set("IntersectionObserver", Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver"));
  globals.IntersectionObserver = IntersectionObserverStub;
  (dom.window as unknown as Record<string, unknown>).IntersectionObserver = IntersectionObserverStub;

  return {
    window: dom.window,
    dialogs,
    setConfirmAnswer: (answer) => {
      confirmAnswer = answer;
    },
    openedUrls,
    clipboardWrites,
    denyClipboard: () => {
      isClipboardDenied = true;
    },
    downloads,
    triggerIntersection: async () => {
      await reactAct(() => {
        for (const record of [...intersectionObservers]) {
          record.callback([...record.targets].map((target) => ({ isIntersecting: true, target })));
        }
      });
      await settle();
    },
    setElementSize: ({ scrollHeight, clientHeight }) => {
      Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { get: () => scrollHeight, configurable: true });
      Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => clientHeight, configurable: true });
    },
    close: () => {
      for (const timer of pendingTimers) {
        clearTimer(timer);
      }
      globals.setTimeout = originalSetTimeout;
      globals.setInterval = originalSetInterval;
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globals[name];
      }
    },
  };
}

export type RecordedRequest = { method: string; path: string; query: URLSearchParams; body: unknown };
type RouteResponse = object | string | number | boolean | null;
type RouteHandler = RouteResponse | ((request: RecordedRequest) => unknown);

export type FetchStub = {
  requests: RecordedRequest[];
  /** 経路（"GET /api/..." のように書く）への応答を追加・差し替える */
  respond(route: string, handler: RouteHandler): void;
  /** その経路へ送られた要求（古い順） */
  requestsTo(route: string): RecordedRequest[];
  restore(): void;
};

/** 配列の最後の要素を返す（無ければ undefined）。 */
export function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

/** 応答として返すと、その状態コードのエラー応答になる。 */
export function httpError(status: number, detail: string): { __httpError: true; status: number; detail: string } {
  return { __httpError: true, status, detail };
}

/**
 * fetch を代用品へ差し替える。routes は「"メソッド パス"」→ 応答（JSON にする値、または要求を受け取る関数）。
 * 登録の無い経路への要求は 404 を返し、テストが気づけるよう requests に記録する。
 */
export function installFetchStub(routes: Record<string, RouteHandler> = {}): FetchStub {
  const table = new Map(Object.entries(routes));
  const requests: RecordedRequest[] = [];
  const originalFetch = globalThis.fetch;
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://127.0.0.1:8079");
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const request: RecordedRequest = { method, path: url.pathname, query: url.searchParams, body };
    requests.push(request);
    const handler = table.get(`${method} ${url.pathname}`);
    if (handler === undefined) {
      return new Response(JSON.stringify({ detail: `no stub for ${method} ${url.pathname}` }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = typeof handler === "function" ? (handler as (r: RecordedRequest) => unknown)(request) : handler;
    if (result && typeof result === "object" && (result as { __httpError?: boolean }).__httpError) {
      const error = result as { status: number; detail: string };
      return new Response(JSON.stringify({ detail: error.detail }), {
        status: error.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(result ?? null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  globalThis.fetch = stub as typeof fetch;
  return {
    requests,
    respond: (route, handler) => void table.set(route, handler),
    requestsTo: (route) => requests.filter((request) => `${request.method} ${request.path}` === route),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function reactAct(callback: () => void | Promise<void>): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    await callback();
  });
}

/** 保留中の Promise とタイマー（0 ミリ秒）を進め、その結果の再描画まで終わらせる。 */
export async function settle(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await reactAct(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 指定ミリ秒だけ待ち、その間に動いたタイマー（入力から少し遅れて動く自動保存など）の結果まで反映する。 */
export async function wait(milliseconds: number): Promise<void> {
  await reactAct(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
  await settle();
}

/**
 * アプリのスタイルシート（src/styles/app.css）を DOM へ読み込む。
 * 読み込んだあとは getComputedStyle で、実際の要素に適用されるスタイルを確かめられる
 * （jsdom はレイアウトを計算しないので、確かめられるのは宣言された値だけ）。
 */
export async function installAppStyles(): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const cssPath = fileURLToPath(new URL("../styles/app.css", import.meta.url));
  const style = document.createElement("style");
  style.textContent = readFileSync(cssPath, "utf-8");
  document.head.appendChild(style);
}

/** 要素に適用されるスタイルの値を返す。 */
export function styleOf(element: Element, property: string): string {
  return window.getComputedStyle(element).getPropertyValue(property);
}

export type MountedView = { container: HTMLElement; unmount(): Promise<void> };

/** コンポーネントを DOM へ描画する。初回の useEffect と、そこから始まる通信の完了まで待つ。 */
export async function mount<P extends object>(component: ComponentType<P>, props: P): Promise<MountedView> {
  const { createRoot } = await import("react-dom/client");
  const container = document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await reactAct(() => {
    root.render(createElement(component, props));
  });
  await settle();
  return {
    container,
    unmount: async () => {
      await reactAct(() => root.unmount());
    },
  };
}

/** 表示されている文字（前後の空白を除く）が一致、または含む要素を探す。見つからなければ失敗させる。 */
export function findByText(scope: ParentNode, selector: string, text: string | RegExp): HTMLElement {
  const found = queryAllByText(scope, selector, text);
  if (found.length === 0) {
    const candidates = [...scope.querySelectorAll(selector)].map((element) => normalizeText(element.textContent)).slice(0, 30);
    throw new Error(`"${selector}" with text ${String(text)} not found. candidates: ${JSON.stringify(candidates)}`);
  }
  return found[0];
}

export function queryAllByText(scope: ParentNode, selector: string, text: string | RegExp): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(selector)].filter((element) => {
    const content = normalizeText(element.textContent);
    return typeof text === "string" ? content === text || content.includes(text) : text.test(content);
  });
}

/** セレクターに一致する最初の要素を返す。無ければ失敗させる。 */
export function findBySelector<T extends HTMLElement = HTMLElement>(scope: ParentNode, selector: string): T {
  const element = scope.querySelector<T>(selector);
  if (!element) throw new Error(`"${selector}" not found`);
  return element;
}

/**
 * セレクターに一致する要素があるかを返す。
 * assert へ DOM の要素そのものを渡すと、失敗時の差分表示で要素全体をたどって極端に遅くなるため、真偽値で比べる。
 */
export function hasElement(scope: ParentNode, selector: string): boolean {
  return scope.querySelector(selector) !== null;
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** クリックし、その結果の更新（通信を含む）が終わるまで待つ。 */
export async function click(element: Element): Promise<void> {
  await reactAct(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** 入力欄・テキストエリアへ値を入れる（React が変更を検知できる方法で設定する）。 */
export async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = element instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await reactAct(() => {
    setter?.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle(2);
}

/** チェックボックス・ラジオボタンの状態を切り替える。 */
export async function setChecked(element: HTMLInputElement, checked: boolean): Promise<void> {
  if (element.checked !== checked) await click(element);
}

/** セレクトボックスの値を選ぶ。 */
export async function selectOption(element: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  await reactAct(() => {
    setter?.call(element, value);
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await settle(2);
}

/**
 * キーを押す（Enter での検索実行、ショートカットなど）。
 * 入力欄以外で押したことにするには document.body を渡す。isComposing は日本語入力の変換中を表す。
 */
export async function pressKey(
  element: Element,
  key: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean } = {},
): Promise<void> {
  await reactAct(() => {
    element.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
  });
  await settle();
}

/** ダブルクリックする（行のインライン編集の開始など）。 */
export async function doubleClick(element: Element): Promise<void> {
  await reactAct(() => {
    element.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  await settle(2);
}

/** 右クリックする（コンテキストメニューを開く）。 */
export async function rightClick(element: Element): Promise<void> {
  await reactAct(() => {
    element.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }));
  });
  await settle(2);
}

/** マウスのボタンを押し下げる（ポップアップの外側を押して閉じる操作、ドラッグでの連続選択の開始など）。 */
export async function mouseDown(element: Element, modifiers: { shiftKey?: boolean } = {}): Promise<void> {
  await reactAct(() => {
    element.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...modifiers }));
  });
  await settle(2);
}

/** マウスを要素の上へ移動する（ドラッグ中に通過した行の選択など）。 */
export async function mouseEnter(element: Element, modifiers: { shiftKey?: boolean } = {}): Promise<void> {
  await reactAct(() => {
    // React の onMouseEnter は、外から入ってきた mouseover で発火する
    element.dispatchEvent(
      new window.MouseEvent("mouseover", { bubbles: true, cancelable: true, relatedTarget: document.body, ...modifiers }),
    );
  });
  await settle(2);
}

/** マウスのボタンを離す（ドラッグの終了）。 */
export async function mouseUp(): Promise<void> {
  await reactAct(() => {
    window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  });
  await settle(2);
}

/** source を target の上へドラッグして離す（一覧の並べ替え）。 */
export async function dragAndDrop(source: Element, target: Element): Promise<void> {
  const fire = (element: Element, type: string): void => {
    element.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  };
  await reactAct(() => fire(source, "dragstart"));
  await reactAct(() => fire(target, "dragover"));
  await reactAct(() => fire(target, "drop"));
  await reactAct(() => fire(source, "dragend"));
  await settle(2);
}

/** 入力欄からフォーカスを外す（インライン編集の確定など）。 */
export async function blur(element: HTMLElement): Promise<void> {
  await reactAct(() => {
    element.focus();
    element.blur();
  });
  await settle(2);
}

/** フォームを送信する。 */
export async function submitForm(form: Element): Promise<void> {
  await reactAct(() => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}
