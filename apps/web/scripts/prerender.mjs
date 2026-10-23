/**
 * Prerenders the public site into dist/ after `vite build` (part of `pnpm build`): it bundles
 * src/prerender/entry.tsx for Node with the app's own Vite config, renders every public page into
 * the built index.html and writes the machine-readable files (robots.txt, sitemap.xml, llms.txt,
 * markdown). The bundle goes to node_modules/.prerender, outside dist/, so it is never deployed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const web = fileURLToPath(new URL('..', import.meta.url));
const dist = join(web, 'dist');
const out = join(web, 'node_modules', '.prerender');

await build({
  root: web,
  configFile: join(web, 'vite.config.ts'),
  mode: 'production',
  logLevel: 'warn',
  // Everything in one bundle: the workspace packages' own dependencies are not reachable from here.
  ssr: { noExternal: true },
  build: {
    ssr: 'src/prerender/entry.tsx',
    outDir: out,
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: {
      output: { entryFileNames: 'entry.mjs', inlineDynamicImports: true },
      // zod's sources carry comments Rollup cannot place; harmless, and not ours to fix.
      onwarn: (warning, warn) => warning.code === 'INVALID_ANNOTATION' || warn(warning),
    },
  },
});

const { siteFiles } = await import(pathToFileURL(join(out, 'entry.mjs')).href);

/** When the docs content last changed, from git; absent outside a checkout. */
function contentModified() {
  try {
    const date = execFileSync('git', ['log', '-1', '--format=%cI', '--', 'src/content/docs.ts'], { cwd: web, encoding: 'utf8' }).trim();
    return date || undefined;
  } catch {
    return undefined;
  }
}

const template = readFileSync(join(dist, 'index.html'), 'utf8');
const files = siteFiles({ template, builtAt: new Date().toISOString(), modified: contentModified() });
for (const [path, content] of files) {
  const file = join(dist, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
console.log(`prerendered ${files.size} files into dist/`);
