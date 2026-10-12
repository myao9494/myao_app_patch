/**
 * Service Worker
 * PWAのオフライン対応とキャッシュ管理
 * - HTML/ナビゲーション: Network First（更新を優先、失敗時のみキャッシュ）
 * - ハッシュ付き静的アセット: Cache First（長期キャッシュ活用）
 * - APIリクエスト: Network Only（キャッシュなし、常にネットワーク）
 */

const CACHE_NAME = "file-manager-v2";
const APP_SHELL_CACHE = "file-manager-shell-v2";

// 初回オフライン起動に必要な最低限のファイルのみ事前キャッシュ
const STATIC_ASSETS = [
    "/manifest.json",
];

function isNavigationRequest(request) {
    return request.mode === "navigate";
}

function isHashedAsset(pathname) {
    // Vite のファイル名ハッシュは base64url（英数字と - _）
    return /\/assets\/.+-[0-9A-Za-z_-]{6,}\.(js|css|mjs)$/.test(pathname);
}

// インストール時: 静的アセットをキャッシュ
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(APP_SHELL_CACHE).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    // 新しいService Workerを即座にアクティブにする
    self.skipWaiting();
});

// アクティベーション時: 古いキャッシュを削除
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => ![CACHE_NAME, APP_SHELL_CACHE].includes(name))
                    .map((name) => caches.delete(name))
            );
        })
    );
    // すべてのクライアントを即座に制御
    self.clients.claim();
});

// フェッチ時: APIはネットワークのみ、静的アセットはキャッシュ優先
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // APIリクエストはネットワークのみ（キャッシュしない）
    if (url.pathname.startsWith("/api/")) {
        return;
    }

    // HTMLナビゲーションは常にネットワークを優先して最新版を取りに行く
    if (isNavigationRequest(event.request)) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response.ok) {
                        const responseClone = response.clone();
                        caches.open(APP_SHELL_CACHE).then((cache) => {
                            cache.put("/", responseClone);
                        });
                    }
                    return response;
                })
                .catch(async () => {
                    const cached = await caches.match("/");
                    if (cached) {
                        return cached;
                    }
                    throw new Error("Navigation request failed and no cached shell exists.");
                })
        );
        return;
    }

    // ハッシュ付き静的アセットはCache First戦略
    if (!isHashedAsset(url.pathname)) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) {
                return cached;
            }
            return fetch(event.request).then((response) => {
                // 成功レスポンスのみキャッシュ
                if (response.ok && event.request.method === "GET") {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            });
        })
    );
});
