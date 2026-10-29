import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.TELNO_API ?? 'http://127.0.0.1:8791';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5178,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/prov': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
