/**
 * Vite設定 - PWA対応
 * vite-plugin-pwaによりService Worker、manifest.jsonを自動生成
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// 開発サーバーのポートと、/api の転送先（バックエンド）。
// 稼働中のアプリとは別のバックエンドで動作確認したいときは、環境変数で差し替える。
const devPort = Number(process.env.GANTT_DEV_PORT) || 5172
const apiTarget = process.env.GANTT_API_TARGET || 'http://localhost:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192x192.png', 'icons/icon-512x512.png'],
      manifest: {
        name: 'ガントチャート',
        short_name: 'Gantt',
        description: 'ガントチャート プロジェクト管理アプリ',
        theme_color: '#1a1d21',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icons/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        // APIリクエストはキャッシュしない（常にサーバーから取得）
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            // 静的アセット（JS, CSS, 画像）はキャッシュファースト
            urlPattern: /\.(?:js|css|png|jpg|jpeg|svg|gif|woff2?)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-assets',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30日
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: devPort,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
