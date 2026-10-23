import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'deploy/indexnow.json'), 'utf8'));
const origin = `https://${config.host}`;
const endpoint = 'https://api.indexnow.org/indexnow';
const manifestPath = '/indexnow-manifest.json';
const pendingPath = join(root, '.wrangler/indexnow-pending.json');
if (config.host !== 'nevazu.com' || !/^[a-f0-9]{32}$/.test(config.key)) throw new Error('Invalid IndexNow configuration.');

// curl honors the deployment environment's HTTPS proxy and CA settings, including on Node 22.
function request(url, body) {
  const args = ['--silent', '--show-error', '--connect-timeout', '10', '--max-time', '25',
    '--user-agent', 'Nevazu-IndexNow/1.0', '--write-out', '\n%{http_code}'];
  if (body) args.push('--header', 'Content-Type: application/json; charset=utf-8', '--data-binary', '@-');
  args.push(url);
  const result = spawnSync('curl', args, { input: body && JSON.stringify(body), encoding: 'utf8', timeout: 30_000, maxBuffer: 5_000_000 });
  if (result.error || result.status !== 0) throw new Error(`IndexNow request failed: ${result.error?.message ?? result.stderr?.trim()}`);
  const split = result.stdout.lastIndexOf('\n');
  return { status: Number(result.stdout.slice(split + 1)), body: result.stdout.slice(0, split) };
}

/** Public canonical HTML only; never submit app, API, admin, query, or cross-host URLs. */
export function validateUrl(value) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
      !/^\/(?:pricing|docs(?:\/[a-z0-9-]+)?|terms|privacy|refunds|contact|status)?$/.test(url.pathname)) {
    throw new Error(`Not a public canonical URL: ${value}`);
  }
  return url.href;
}

export function sitemapUrls(xml) {
  if (!/<urlset\b/.test(xml)) throw new Error('Expected an XML sitemap, not an app shell.');
  const urls = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)].map((m) => validateUrl(m[1].trim()));
  if (!urls.length || urls.length > 10_000 || new Set(urls).size !== urls.length) throw new Error('Invalid sitemap URL list.');
  return urls.sort();
}

/** Ignore compiled asset filenames; meaningful HTML, metadata and JSON-LD still count. */
export function contentHash(html) {
  if (!/<link\b[^>]*rel="canonical"/.test(html) || /<meta\b[^>]*name="robots"[^>]*content="noindex/.test(html)) {
    throw new Error('Expected prerendered public HTML.');
  }
  const content = html
    .replace(/<script\b(?![^>]*type="application\/ld\+json")[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*rel="(?:stylesheet|modulepreload)"[^>]*>/g, '')
    .replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(content).digest('hex');
}

export function changedUrls(previous, current) {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((url) => previous[url] !== current[url]).map(validateUrl).sort();
}

function validManifest(value) {
  if (value?.version !== 1 || !value.pages || typeof value.pages !== 'object' || Array.isArray(value.pages)) throw new Error('Invalid IndexNow manifest.');
  for (const [url, hash] of Object.entries(value.pages)) {
    validateUrl(url);
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid content hash.');
  }
  return value.pages;
}

function pendingUrls(path = pendingPath) {
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value.urls)) throw new Error('Invalid IndexNow retry record.');
  return value.urls.map(validateUrl);
}

/** Called after the clean-main build, before upload. Reads the old manifest while it is live. */
export function prepareIndexNow(dist, { transport = request, retryFile = pendingPath } = {}) {
  const urls = sitemapUrls(readFileSync(join(dist, 'sitemap.xml'), 'utf8'));
  const pages = Object.fromEntries(urls.map((url) => {
    const path = new URL(url).pathname;
    return [url, contentHash(readFileSync(join(dist, path === '/' ? 'home.html' : `${path.slice(1)}.html`), 'utf8'))];
  }));
  let previous = {};
  try {
    const response = transport(origin + manifestPath);
    if (response.status === 200) {
      // A site without IndexNow can return its SPA shell for this previously unknown path.
      if (!/^\s*</.test(response.body)) previous = validManifest(JSON.parse(response.body));
    } else if (response.status !== 404) throw new Error(`Manifest HTTP ${response.status}`);
  } catch (error) {
    // Re-notifying public pages is safer than missing changes when the old manifest is unavailable.
    console.warn(`IndexNow: previous manifest unavailable; will notify all public pages (${error.message}).`);
  }
  writeFileSync(join(dist, manifestPath.slice(1)), JSON.stringify({ version: 1, pages }) + '\n');
  const changes = [...new Set([...pendingUrls(retryFile), ...changedUrls(previous, pages)])].sort();
  console.log(`IndexNow: ${changes.length} public URLs to notify after deployment.`);
  return changes;
}

/** Persist before contacting IndexNow; an unsuccessful request can be retried without redeploying. */
export function submitIndexNow(urls, { commit, dryRun = false, transport = request, retryFile = pendingPath } = {}) {
  urls = [...new Set(urls.map(validateUrl))].sort();
  if (!urls.length) { console.log('IndexNow: no public content changes.'); return; }
  if (urls.length > 10_000) throw new Error('IndexNow batch exceeds 10,000 URLs.');
  if (dryRun) { console.log(JSON.stringify({ endpoint, host: config.host, urls }, null, 2)); return; }
  mkdirSync(dirname(retryFile), { recursive: true });
  writeFileSync(retryFile, JSON.stringify({ urls, commit, createdAt: new Date().toISOString() }, null, 2) + '\n');
  if (commit) {
    const live = transport(origin + '/build-info.json');
    if (live.status !== 200 || JSON.parse(live.body).commit !== commit) throw new Error('Live build does not match the deployed commit; notification deferred.');
  }
  const keyLocation = `${origin}/${config.key}.txt`;
  const keyFile = transport(keyLocation);
  if (keyFile.status !== 200 || keyFile.body.trim() !== config.key) throw new Error('IndexNow ownership file is unavailable or incorrect.');
  const response = transport(endpoint, { host: config.host, key: config.key, keyLocation, urlList: urls });
  if (response.status !== 200 && response.status !== 202) throw new Error(`IndexNow HTTP ${response.status}: ${response.body.slice(0, 300)}. Retry with pnpm indexnow:retry.`);
  unlinkSync(retryFile);
  console.log(`IndexNow: HTTP ${response.status}, ${urls.length} URLs received${response.status === 202 ? '; ownership validation pending' : ''}. This does not guarantee indexing.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some((x) => !['--all', '--retry', '--dry-run'].includes(x)) || args.includes('--all') === args.includes('--retry')) {
      throw new Error('Usage: indexnow.mjs (--all | --retry) [--dry-run]');
    }
    let urls;
    if (args.includes('--all')) {
      const sitemap = request(origin + '/sitemap.xml');
      if (sitemap.status !== 200) throw new Error(`Live sitemap HTTP ${sitemap.status}`);
      urls = [...new Set([...pendingUrls(), ...sitemapUrls(sitemap.body)])];
    } else urls = pendingUrls();
    submitIndexNow(urls, { dryRun: args.includes('--dry-run') });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
