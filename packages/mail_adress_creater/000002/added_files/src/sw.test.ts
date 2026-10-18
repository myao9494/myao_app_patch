/**
 * Service Worker (public/sw.js) のテスト
 * fetch / install / activate の各ハンドラを、偽の self・caches・fetch で動かして確認する
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import swSource from '../public/sw.js?raw'

type Handler = (event: unknown) => void

class FakeCache {
  entries = new Map<string, Response>()
  async match(key: Request | string) { return this.entries.get(typeof key === 'string' ? key : new URL(key.url).pathname)?.clone() }
  async put(key: Request | string, value: Response) { this.entries.set(typeof key === 'string' ? key : new URL(key.url).pathname, value) }
  async delete(key: Request | string) { return this.entries.delete(typeof key === 'string' ? key : new URL(key.url).pathname) }
  async keys() { return Array.from(this.entries.keys(), path => new Request(`http://app.test${path}`)) }
  async addAll(paths: string[]) { paths.forEach(path => this.entries.set(path, new Response(`shell:${path}`))) }
}

function loadServiceWorker() {
  const handlers: Record<string, Handler> = {}
  const stores = new Map<string, FakeCache>()
  const fakeCaches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new FakeCache())
      return stores.get(name)!
    },
    keys: async () => Array.from(stores.keys()),
    delete: async (name: string) => stores.delete(name),
    match: async (key: Request | string) => {
      for (const store of stores.values()) {
        const hit = await store.match(key)
        if (hit) return hit
      }
      return undefined
    },
  }
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>()
  const fakeSelf = {
    location: { origin: 'http://app.test' },
    addEventListener: (type: string, handler: Handler) => { handlers[type] = handler },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  }
  new Function('self', 'caches', 'fetch', swSource)(fakeSelf, fakeCaches, fetchMock)
  return { handlers, stores, fetchMock, fakeSelf }
}

async function dispatchFetch(sw: ReturnType<typeof loadServiceWorker>, path: string, init: { mode?: string; method?: string } = {}) {
  const request = Object.assign(new Request(`http://app.test${path}`, { method: init.method ?? 'GET' }), {})
  Object.defineProperty(request, 'mode', { value: init.mode ?? 'cors' })
  let responded: Promise<Response> | undefined
  sw.handlers.fetch({ request, respondWith: (promise: Promise<Response>) => { responded = promise } })
  return responded
}

const ok = (body: string) => new Response(body, { status: 200 })

describe('service worker', () => {
  let sw: ReturnType<typeof loadServiceWorker>

  beforeEach(() => {
    sw = loadServiceWorker()
  })

  it('/api・CSV・他オリジン・GET以外は処理せずブラウザに任せる', async () => {
    expect(await dispatchFetch(sw, '/api/health')).toBeUndefined()
    expect(await dispatchFetch(sw, '/send_mail-ranking_tabulator.csv')).toBeUndefined()
    expect(await dispatchFetch(sw, '/assets/app.js', { method: 'POST' })).toBeUndefined()
  })

  it('画面遷移はネットワーク優先で、成功した応答を /index.html として保存する', async () => {
    sw.fetchMock.mockResolvedValue(ok('<html>new</html>'))

    const response = await dispatchFetch(sw, '/', { mode: 'navigate' })

    expect(await (await response)!.text()).toBe('<html>new</html>')
    const cached = await sw.stores.get('outlook-address-maker-v2')!.match('/index.html')
    expect(await cached!.text()).toBe('<html>new</html>')
  })

  it('オフライン時の画面遷移は保存済みの /index.html を返す', async () => {
    sw.fetchMock.mockResolvedValueOnce(ok('<html>cached</html>'))
    await dispatchFetch(sw, '/', { mode: 'navigate' })
    sw.fetchMock.mockRejectedValue(new Error('offline'))

    const response = await dispatchFetch(sw, '/', { mode: 'navigate' })

    expect(await (await response)!.text()).toBe('<html>cached</html>')
  })

  it('ハッシュ付きassetsはキャッシュ優先で、2回目以降はネットワークに行かない', async () => {
    sw.fetchMock.mockResolvedValue(ok('console.log(1)'))
    await (await dispatchFetch(sw, '/assets/index-abc.js'))

    const second = await dispatchFetch(sw, '/assets/index-abc.js')

    expect(await (await second)!.text()).toBe('console.log(1)')
    expect(sw.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('assetsのキャッシュは上限を超えた分を古い順に削除する', async () => {
    sw.fetchMock.mockImplementation(async () => ok('x'))
    for (let i = 0; i < 45; i += 1) {
      await (await dispatchFetch(sw, `/assets/file-${i}.js`))
    }
    await new Promise(resolve => setTimeout(resolve, 0))

    const keys = (await sw.stores.get('outlook-address-maker-v2')!.keys()).map(k => new URL(k.url).pathname)
    expect(keys.filter(path => path.startsWith('/assets/'))).toHaveLength(40)
    expect(keys).toContain('/assets/file-44.js')
    expect(keys).not.toContain('/assets/file-0.js')
  })

  it('manifestなど固定名のファイルはネットワーク優先で、失敗時にキャッシュを返す', async () => {
    sw.fetchMock.mockResolvedValueOnce(ok('{"name":"v1"}'))
    await (await dispatchFetch(sw, '/manifest.webmanifest'))
    sw.fetchMock.mockResolvedValueOnce(ok('{"name":"v2"}'))
    expect(await (await (await dispatchFetch(sw, '/manifest.webmanifest'))!).text()).toBe('{"name":"v2"}')

    sw.fetchMock.mockRejectedValue(new Error('offline'))
    expect(await (await (await dispatchFetch(sw, '/manifest.webmanifest'))!).text()).toBe('{"name":"v2"}')
  })

  it('エラー応答（404など）はキャッシュしない', async () => {
    sw.fetchMock.mockResolvedValue(new Response('nope', { status: 404 }))
    await (await dispatchFetch(sw, '/assets/missing.js'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(await sw.stores.get('outlook-address-maker-v2')?.match('/assets/missing.js')).toBeUndefined()
  })

  it('install でアプリ本体を保存し、activate で古い名前のキャッシュを削除する', async () => {
    const waits: Promise<unknown>[] = []
    sw.handlers.install({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    expect(sw.fakeSelf.skipWaiting).toHaveBeenCalled()
    sw.stores.set('outlook-address-maker-v1', new FakeCache())

    const activateWaits: Promise<unknown>[] = []
    sw.handlers.activate({ waitUntil: (p: Promise<unknown>) => activateWaits.push(p) })
    await Promise.all(activateWaits)

    expect(Array.from(sw.stores.keys())).toEqual(['outlook-address-maker-v2'])
    expect(sw.fakeSelf.clients.claim).toHaveBeenCalled()
  })
})
