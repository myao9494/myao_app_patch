/**
 * Vite設定（quickアプリ用）
 * - base: '/quick/'（/quick パス配信用のベースURL）
 * - 開発時: /apiリクエストをバックエンド(port 8001)にプロキシ
 * - モバイル向けビルド最適化
 *   - mermaid は ```mermaid ブロックがあるときだけ動的 import する（初回バンドル約260kB）
 *   - mermaid 内部の大きなチャンク（mermaid.core / cynefin 各約690kB）は図の描画時にだけ
 *     読み込まれ、こちらでは分割できないため、警告のしきい値をその少し上に設定している
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/quick/',
  build: {
    chunkSizeWarningLimit: 750,
  },
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
