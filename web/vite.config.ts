import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(process.cwd(), 'web'),
  plugins: [react()],
  build: {
    outDir: 'dist',
    // 清理旧产物：hash 文件名每次构建都会变，不清理会残留历史 chunk 被打进安装包
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8700',
      '/ws': { target: 'ws://127.0.0.1:8700', ws: true },
    },
  },
});
