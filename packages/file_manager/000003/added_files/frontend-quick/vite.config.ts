/**
 * Vite設定（quickアプリ用）
 * - base: '/quick/'（/quick パス配信用のベースURL）
 * - 開発時: /apiリクエストをバックエンド(port 8001)にプロキシ
 * - モバイル向けビルド最適化
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/quick/',
  server: {
    port: 5174,
    host: '0.0.0.0', // スマホなど同一ネットワークからアクセス可能にする
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
      },
    },
  },
})
