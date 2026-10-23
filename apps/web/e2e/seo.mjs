// What a crawler that runs no JavaScript gets from the built site. No browser, no network.
// Build apps/web (pnpm --filter @cloudbrowser/web build), then: node apps/web/e2e/seo.mjs
//
// Each public URL is resolved to a file the way Workers static assets serve dist/ (html_handling
// "auto-trailing-slash": x.html at /x; / from home.html through the api Worker, apps/api/src/site.ts).
// Live prices are filled in by the Worker at request time; that part is covered by apps/api/test/site.test.ts.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.WEB_DIST ?? join(here, '../dist'));
const wrangler = join(here, '../../api/wrangler.jsonc');
const SITE = 'https://nevazu.com';
const read = (path) => readFileSync(join(dist, path), 'utf8');
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`);
    process.exitCode = 1;
  }
};

/** The file behind a public URL. */
const fileFor = (route) => (route === '/' ? 'home.html' : `${route.slice(1)}.html`);
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const attr = (html, re) => re.exec(html)?.[1];

const docs = readdirSync(join(dist, 'docs')).filter((f) => f.endsWith('.html')).map((f) => `/docs/${f.slice(0, -5)}`);
const routes = ['/', '/pricing', '/docs', ...docs, '/terms', '/privacy', '/refunds', '/contact', '/status'];

/** Text each page must carry for a reader that runs no JavaScript. */
const KEY_TEXT = {
  '/': ['Your cloud browser, always there', 'Nevazu is a persistent cloud browser service', 'How is it different from a VPN or a proxy?'],
  '/pricing': ['Simple, prepaid pricing', 'How charges work', 'Is there a subscription?'],
  '/docs': ['Documentation', 'Getting started', 'Frequently asked questions'],
  '/docs/faq': ['What is Nevazu?', 'Model Context Protocol (MCP)', 'How do I start?'],
  '/docs/coding-agents': ['Coding agents', 'Connecting an agent'],
  '/terms': ['Terms of Service'],
  '/privacy': ['Privacy Policy', 'What we collect'],
  '/refunds': ['Refund Policy'],
  '/contact': ['Contact', 'support@nevazu.com', 'security@nevazu.com'],
  '/status': ['System status', 'refreshed every minute'],
};

assert.ok(existsSync(join(dist, 'index.html')), `no build at ${dist}`);
assert.ok(docs.includes('/docs/faq'), 'the FAQ article is not prerendered');
const titles = new Map();

for (const route of routes) {
  check(`${route} is prerendered HTML a crawler can read`, () => {
    const file = fileFor(route);
    assert.ok(existsSync(join(dist, file)), `missing dist/${file}`);
    const html = read(file);
    assert.match(html, /^<!doctype html>\s*<html lang="en">/);
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1, 'exactly one h1');
    const title = attr(html, /<title>([^<]+)<\/title>/);
    assert.ok(title && title !== 'Nevazu', 'a title of its own');
    assert.ok(!titles.has(title), `title also used by ${titles.get(title)}`);
    titles.set(title, route);
    assert.ok((attr(html, /<meta name="description" content="([^"]+)"/) ?? '').length > 40, 'a meta description');
    assert.equal(attr(html, /<link rel="canonical" href="([^"]+)"/), SITE + route);
    assert.equal(attr(html, /<meta property="og:url" content="([^"]+)"/), SITE + route);
    assert.match(html, /<meta name="twitter:card" content="summary"/);
    assert.match(html, /<meta name="robots" content="index, follow"/);
    assert.doesNotMatch(html, /noindex/);
    // The app still starts: the hashed bundle and stylesheet from the Vite build are there.
    assert.match(html, /<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" crossorigin href="\/assets\/index-[\w-]+\.css">/);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1, 'one JSON-LD block');
    const graph = JSON.parse(blocks[0][1])['@graph'];
    const types = graph.map((n) => n['@type']);
    for (const type of ['Organization', 'WebSite']) assert.ok(types.includes(type), `JSON-LD ${type}`);
    if (route === '/' || route === '/pricing') assert.ok(types.includes('WebApplication'), 'JSON-LD WebApplication');
    if (route.startsWith('/docs/')) assert.ok(types.includes('BreadcrumbList') && (types.includes('TechArticle') || types.includes('FAQPage')), 'docs JSON-LD');
    const root = /<div id="root">([\s\S]*)<\/div>\s*<\/body>/.exec(html)?.[1] ?? '';
    const words = text(root);
    for (const key of KEY_TEXT[route] ?? []) assert.ok(words.includes(key), `text "${key}"`);
    assert.ok(words.length > 400, 'the page text is in #root');
    for (const link of ['/pricing', '/docs', '/terms', '/privacy', '/contact']) assert.ok(root.includes(`href="${link}"`), `links to ${link}`);
  });
}

check('the app shell stays clean for private routes', () => {
  const html = read('index.html');
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /<meta name="robots" content="noindex"/);
  assert.equal(attr(html, /<title>([^<]+)<\/title>/), 'Nevazu');
  assert.doesNotMatch(html, /application\/ld\+json|rel="canonical"/);
  for (const path of ['browsers.html', 'b', 'account.html', 'billing.html', 'sign-in.html']) assert.ok(!existsSync(join(dist, path)), `dist/${path} would replace the app shell`);
});

check('robots.txt welcomes crawlers and points to the sitemap', () => {
  const robots = read('robots.txt');
  for (const bot of ['*', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Googlebot', 'Bingbot', 'Applebot', 'Applebot-Extended', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'meta-externalagent', 'MistralAI-User', 'cohere-ai']) {
    assert.ok(robots.includes(`User-agent: ${bot}\n`), bot);
  }
  assert.match(robots, /Content-Signal: search=yes, ai-input=yes, ai-train=yes/);
  for (const path of ['/api/', '/b/', '/browsers', '/account', '/billing', '/promotions', '/sign-up/complete', '/admin']) assert.ok(robots.includes(`Disallow: ${path}\n`), path);
  assert.match(robots, /^Sitemap: https:\/\/nevazu\.com\/sitemap\.xml$/m);
});

check('sitemap.xml lists every public page', () => {
  const xml = read('sitemap.xml');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs.sort(), routes.map((r) => SITE + r).sort());
  assert.equal(xml.match(/<lastmod>\d{4}-\d{2}-\d{2}T[\d:.]+Z<\/lastmod>/g)?.length, routes.length);
});

check('llms.txt follows llmstxt.org and every link resolves to a built file', () => {
  const llms = read('llms.txt');
  assert.match(llms, /^# Nevazu\n\n> Nevazu is a persistent cloud browser service/);
  for (const section of ['Docs', 'Pricing', 'Policies', 'Optional']) assert.match(llms, new RegExp(`^## ${section}$`, 'm'));
  const links = [...llms.matchAll(/\]\((https:\/\/nevazu\.com\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 15, 'links to the markdown pages');
  for (const link of links) assert.ok(existsSync(join(dist, new URL(link).pathname)), `${link} is built`);
  assert.match(read('llms-full.txt'), /# Frequently asked questions\n/);
});

check('every page but status has a markdown twin', () => {
  for (const route of routes.filter((r) => r !== '/status')) {
    const file = route === '/' ? 'index.md' : `${route.slice(1)}.md`;
    assert.ok(existsSync(join(dist, file)), file);
    assert.match(read(file), /^# .+\n\n> .+/, file);
    assert.match(read(fileFor(route)), new RegExp(`<link rel="alternate" type="text/markdown" href="/${file.replace('.', '\\.')}"`), `${route} links its markdown`);
  }
});

check('files with live slots run the api Worker first', () => {
  const config = JSON.parse(readFileSync(wrangler, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const first = config.assets.run_worker_first;
  const slotted = { 'home.html': '/', 'pricing.html': '/pricing', 'index.md': '/index.md', 'pricing.md': '/pricing.md', 'llms.txt': '/llms.txt', 'llms-full.txt': '/llms-full.txt' };
  for (const [file, route] of Object.entries(slotted)) {
    assert.match(read(file), /<!--live:[a-z-]+-->[\s\S]+?<!--\/live:[a-z-]+-->/, `${file} has a live slot`);
    assert.ok(first.includes(route), `run_worker_first lacks ${route}`);
  }
  // Nothing else carries a slot the Worker would never fill.
  for (const route of routes.filter((r) => !['/', '/pricing'].includes(r))) assert.doesNotMatch(read(fileFor(route)), /<!--live:/, route);
});

check('_headers keeps the security headers and marks private paths noindex', () => {
  const headers = read('_headers');
  assert.match(headers, /Content-Security-Policy: default-src 'self'; script-src 'self'/);
  assert.match(headers, /Strict-Transport-Security: max-age=31536000; includeSubDomains/);
  for (const path of ['/b/*', '/browsers*', '/account*', '/billing*', '/promotions*', '/sign-in*', '/sign-up*']) {
    assert.ok(headers.includes(`${path}\n  X-Robots-Tag: noindex`), path);
  }
});

console.log(results.join('\n'));
console.log(process.exitCode ? 'seo: failed' : `seo: ${results.length} checks passed`);
