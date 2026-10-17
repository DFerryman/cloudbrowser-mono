import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the api Worker (wrangler dev, port 8787) serves /api; Vite proxies to it so the
// app and the API share an origin, as they do in production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
  // No public source maps: everything in dist/ is served as a static asset.
  // Never inline assets as data: URIs, so the CSP can stay at font-src 'self'.
  build: { sourcemap: false, assetsInlineLimit: 0 },
});
