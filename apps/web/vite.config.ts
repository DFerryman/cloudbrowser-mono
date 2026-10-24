import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
/** The commit a build was made from (a trailing + when the tree had changes); '' outside a checkout. */
function commit() {
  try {
    return git('rev-parse', '--short=12', 'HEAD') + (git('status', '--porcelain') !== '' ? '+' : '');
  } catch {
    return '';
  }
}

// In development the api Worker (wrangler dev, port 8787) serves /api; Vite proxies to it so the
// app and the API share an origin, as they do in production.
export default defineConfig(({ command }) => ({
  // Sent with every api request (src/lib/api.ts) so a report names the code that sent it.
  define: { __CLIENT_BUILD__: JSON.stringify(command === 'build' ? commit() : '') },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'build-provenance',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'build-info.json',
          source: JSON.stringify({
            commit: git('rev-parse', 'HEAD'),
            branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
            dirty: git('status', '--porcelain') !== '',
          }) + '\n',
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
  // No public source maps: everything in dist/ is served as a static asset.
  // Never inline assets as data: URIs, so the CSP can stay at font-src 'self'.
  build: { sourcemap: false, assetsInlineLimit: 0 },
}));
