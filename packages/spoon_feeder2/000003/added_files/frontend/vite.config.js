import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Spoonfeeder2', short_name: 'Spoonfeeder2',
        description: 'Repository context and safe AI code application',
        theme_color: '#0b1020', background_color: '#070b16', display: 'standalone',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
      }
    })
  ],
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8077', ws: true } } },
  build: { target: 'es2020' }
});
