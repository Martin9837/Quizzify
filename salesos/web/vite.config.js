import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = `http://localhost:${Number(process.env.PORT || 4000)}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    host: true,
    proxy: {
      // Single-origin in development so cookies, SSE and CORS behave the same
      // way they do behind a reverse proxy in production.
      //
      // The target follows PORT, the same variable the API reads. Hardcoding
      // 4000 here meant PORT was only half-configurable: the API would move and
      // the proxy would keep forwarding to 4000, where whatever else happened to
      // be listening answered instead -- which surfaces as a mystifying 404 on
      // sign-in rather than anything pointing at a port conflict.
      '/api': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
