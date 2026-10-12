/**
 * Vite設定
 * - 開発時: /apiリクエストをバックエンド(port 8001)にプロキシ
 * - ビルド時: dist/にPWA対応の静的ファイルを生成
 *   - React / TanStack Query は別チャンク（vendor）に分ける。アプリ更新時も変わらないため
 *     ブラウザ・PWAのキャッシュがそのまま使え、本体チャンクも500kB未満に収まる
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'react-vendor'
          }
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) {
            return 'query-vendor'
          }
        },
      },
    },
  },
  server: {
    // 開発サーバーのプロキシ設定
    // /apiへのリクエストをバックエンドに転送
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
