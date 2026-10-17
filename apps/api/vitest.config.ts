import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The api tests run the engine in-process; its EventHub imports `cloudflare:workers`, which only
// exists inside workerd.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers-stub.ts', import.meta.url)) } },
});
