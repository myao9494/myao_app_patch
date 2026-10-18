// Service Worker: アプリ本体をキャッシュしてオフラインでも起動できるようにする。
//  - 画面遷移(HTML): ネットワーク優先。成功したら最新を /index.html として保存し、失敗時はそれを返す
//  - /assets/*（ファイル名にハッシュが付く）: キャッシュ優先。古いハッシュのファイルが溜まらないよう件数を制限する
//  - その他（manifest、アイコンなど）: ネットワーク優先、失敗時にキャッシュ
//  - /api と CSV はキャッシュしない
// 動作を変えたら CACHE_NAME を上げる（古いキャッシュは activate 時に削除される）。
const CACHE_NAME = 'outlook-address-maker-v2'
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg']
const MAX_ASSET_ENTRIES = 40

const shouldHandleRequest = request => {
  const url = new URL(request.url)
  return (
    request.method === 'GET' &&
    url.origin === self.location.origin &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.pathname.startsWith('/api/') &&
    !url.pathname.endsWith('.csv')
  )
}

const isAsset = request => new URL(request.url).pathname.startsWith('/assets/')

const putInCache = (request, response) =>
  caches.open(CACHE_NAME).then(cache => cache.put(request, response)).catch(() => undefined)

// 新しいものを残し、古い /assets/ のキャッシュから削除する
const trimAssetCache = async () => {
  const cache = await caches.open(CACHE_NAME)
  const keys = (await cache.keys()).filter(isAsset)
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSET_ENTRIES)).map(key => cache.delete(key)))
}

const networkFirst = (request, cacheKey) =>
  fetch(request)
    .then(response => {
      if (response.ok) {
        putInCache(cacheKey, response.clone())
      }
      return response
    })
    .catch(() => caches.match(cacheKey))

const cacheFirst = request =>
  caches.match(request).then(cached => (
    cached || fetch(request).then(response => {
      if (response.ok) {
        putInCache(request, response.clone()).then(trimAssetCache)
      }
      return response
    })
  ))

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => (
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )),
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (!shouldHandleRequest(request)) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/index.html'))
  } else if (isAsset(request)) {
    event.respondWith(cacheFirst(request))
  } else {
    event.respondWith(networkFirst(request, request))
  }
})
