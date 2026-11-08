import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** BFF 是独立进程，dev 与 preview 都靠这条代理把 /api 转过去 */
const API_TARGET = `http://127.0.0.1:${process.env.P3D_API_PORT ?? 8787}`;
const PROXY = {
  '/api': { target: API_TARGET, changeOrigin: false },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    // three.js 本身的体积就大，阈值调高避免噪音警告
    chunkSizeWarningLimit: 1800,
  },
  server: {
    port: Number(process.env.P3D_WEB_PORT ?? 5173),
    host: '127.0.0.1',
    proxy: PROXY,
  },
  preview: {
    port: 4173,
    host: '127.0.0.1',
    proxy: PROXY,
  },
});
