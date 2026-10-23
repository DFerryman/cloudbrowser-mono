import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { addOffers, fillSlots, resetSiteCache, usd } from '../src/site.js';
import { ORIGIN, setup, SIMULATED_SHEET } from './helpers.js';

/**
 * The prerendered public pages with live prices (src/site.ts). The assets binding is stood in for
 * by files shaped like apps/web's prerender output: slots between live markers and a JSON-LD graph,
 * with the content types it really sends (text files without a charset).
 */
const LD = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"https://nevazu.com/#organization"},{"@type":"WebApplication","@id":"https://nevazu.com/#app","name":"Nevazu"}]}</script>';
const FILES: Record<string, { body: string; type: string }> = {
  '/home': { body: `<html><head>${LD}</head><body><div id="root"><h1>Home</h1><!--live:summary--><p>See pricing.</p><!--/live:summary--></div></body></html>`, type: 'text/html; charset=utf-8' },
  '/pricing': { body: `<html><head>${LD}</head><body><div id="root"><h1>Pricing</h1><!--live:prices--><p>See pricing.md.</p><!--/live:prices--></div></body></html>`, type: 'text/html; charset=utf-8' },
  '/pricing.md': { body: '# Pricing\n\n<!--live:prices-md-->See https://nevazu.com/pricing.<!--/live:prices-md-->\n', type: 'text/markdown' },
  '/index.md': { body: '# Nevazu\n\n<!--live:summary-md-->See pricing.<!--/live:summary-md-->\n', type: 'text/markdown' },
  '/llms.txt': { body: '# Nevazu\n\n> A cloud browser.\n\n<!--live:summary-md-->See pricing.<!--/live:summary-md-->\n', type: 'text/plain' },
  '/llms-full.txt': { body: '# Nevazu\n\n<!--live:summary-md-->a<!--/live:summary-md-->\n\n<!--live:prices-md-->b<!--/live:prices-md-->\n', type: 'text/plain' },
  '/docs/agent-setup.md': { body: '# Coding agent setup\n\nIt’s for agents — 编程智能体.\n', type: 'text/markdown' },
  '/robots.txt': { body: '# Nevazu welcomes search engines\nUser-agent: *\n', type: 'text/plain' },
  '/sitemap.xml': { body: '<?xml version="1.0" encoding="UTF-8"?><urlset/>', type: 'application/xml' },
  '/': { body: '<html><body><div id="root"></div>app shell</body></html>', type: 'text/html; charset=utf-8' },
};

let t: ReturnType<typeof setup>;
let assetRequests: Request[];
beforeEach(() => {
  resetSiteCache();
  t = setup();
  assetRequests = [];
  (t.env as { ASSETS: unknown }).ASSETS = {
    fetch: async (input: Request) => {
      assetRequests.push(input);
      const file = FILES[new URL(input.url).pathname];
      if (!file) return new Response('<html>app shell</html>', { headers: { 'content-type': 'text/html' } });
      return new Response(file.body, { headers: { 'content-type': file.type, etag: '"built"', 'content-security-policy': "default-src 'self'" } });
    },
  };
});
afterEach(resetSiteCache);

const get = async (path: string, init: RequestInit = {}) => {
  const res = await app.fetch(new Request(new URL(path, ORIGIN), init), t.env as never, t.ctx);
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const jsonLd = (html: string) => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!);

describe('prerendered pages with live prices', () => {
  it('serves the home page from home.html with the open regions and offers', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(assetRequests.map((r) => new URL(r.url).pathname)).toEqual(['/home']);
    expect(res.headers.get('content-type')).toContain('text/html');
    // Headers from the assets (the _headers rules) stay; the ETag described the unfilled file.
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(res.headers.get('etag')).toBeNull();
    expect(res.text).toContain('<h1>Home</h1>');
    expect(res.text).toMatch(/new browsers can be created in \d+ regions?: [^<]*Tokyo/);
    expect(res.text).not.toContain('<!--live:');
    const app = jsonLd(res.text)['@graph'].find((n: { '@id': string }) => n['@id'].endsWith('#app'));
    expect(app.offers).toMatchObject({ '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: expect.any(Number), highPrice: expect.any(Number) });
    expect(app.offers.lowPrice).toBeGreaterThan(0);
    expect(app.offers.highPrice).toBeGreaterThanOrEqual(app.offers.lowPrice);
  });

  it('fills the pricing page with the same prices as the public price list', async () => {
    const list = (await t.call('GET', '/api/public/pricing')).body;
    const res = await get('/pricing');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<table');
    expect(res.text).toContain('Tokyo');
    expect(res.text).toContain('Basic (2 vCPU, 4 GB)');
    // Each region's headline price is the pricing page's: compute plus the IP and storage per hour.
    const tokyo = list.regions.find((r: { regionId: string }) => r.regionId === 'tyo1');
    const alwaysOnHour = Math.round((tokyo.rates.ip * 730 + tokyo.rates.storage * (tokyo.defaultStorageGb + tokyo.rootVolumeGb)) / 730);
    expect(res.text).toContain(usd(tokyo.rates.compute + alwaysOnHour));
    expect(res.text).toContain(`at least ${usd(list.minBalanceMicros)} of available credit`);
  });

  it('lists Premium where it is offered and priced', async () => {
    expect((await get('/pricing.md')).text).not.toContain('Premium');
    resetSiteCache();
    const sheet = { ...SIMULATED_SHEET, instanceTypes: { 'fake.large': 0.1, 'fake.xlarge': 0.21 }, premium: { instanceType: 'fake.xlarge', vmHour: 0.21, machine: { vcpu: 4, memoryGb: 8 } } };
    t.d1.sqlite.prepare(`UPDATE provider_prices SET sheet = ? WHERE region_id = 'tyo1'`).run(JSON.stringify(sheet));
    t.d1.sqlite.exec(`UPDATE caps SET "limit" = 1 WHERE scope = 'user:default' AND metric = 'premium'`);
    const md = (await get('/pricing.md')).text;
    expect(md).toMatch(/\| Tokyo \| Premium \(4 vCPU, 8 GB\) \| \$[\d.]+ \|/);
    expect((await get('/llms.txt')).text).toContain('A Premium (4 vCPU, 8 GB) browser costs');
  });

  it('fills the markdown and llms texts', async () => {
    const md = await get('/pricing.md');
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(md.text).toContain('| Region | Machine | Running, per hour |');
    expect(md.text).toMatch(/\| Tokyo \| Basic \(2 vCPU, 4 GB\) \| \$[\d.]+ \|/);
    const llms = await get('/llms.txt');
    expect(llms.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(llms.text).toMatch(/^# Nevazu\n\n> A cloud browser\.\n\nAs of \d{4}-\d{2}-\d{2}, new browsers can be created in/);
    const full = await get('/llms-full.txt');
    expect(full.text).not.toContain('<!--live:');
    expect(full.text).toContain('| Region |');
    expect((await get('/index.md')).text).toContain('an hour while running');
  });

  it('keeps the built fallback when prices cannot be read', async () => {
    t.d1.sqlite.exec('DROP TABLE provider_prices');
    const res = await get('/pricing');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<p>See pricing.md.</p>');
    expect(res.text).not.toContain('<!--live:');
    expect(jsonLd(res.text)['@graph'][1].offers).toBeUndefined();
    expect((await get('/pricing.md')).text).toContain('See https://nevazu.com/pricing.');
  });

  it('reads prices once per isolate for ten minutes', async () => {
    await get('/pricing');
    t.d1.sqlite.exec('DROP TABLE provider_prices');
    expect((await get('/pricing')).text).toContain('Tokyo');
    resetSiteCache();
    expect((await get('/pricing')).text).toContain('See pricing.md.');
  });

  it('answers HEAD, ignores conditional headers and redirects /home', async () => {
    const head = await get('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    await get('/pricing', { headers: { 'if-none-match': '"built"' } });
    expect(assetRequests.at(-1)!.headers.get('if-none-match')).toBeNull();
    const home = await get('/home');
    expect(home.status).toBe(301);
    expect(home.headers.get('location')).toBe('/');
  });

  it('leaves the operator console host to its own app shell', async () => {
    (t.env as Record<string, unknown>).ADMIN_URL = 'https://admin.example.com';
    const res = await app.fetch(new Request('https://admin.example.com/'), t.env as never, t.ctx);
    expect(await res.text()).toContain('app shell');
    expect(new URL(assetRequests[0]!.url).pathname).toBe('/');
  });
});

describe('text files', () => {
  it('say they are UTF-8, which the assets binding leaves out', async () => {
    for (const [path, type] of [['/docs/agent-setup.md', 'text/markdown; charset=utf-8'], ['/robots.txt', 'text/plain; charset=utf-8'], ['/index.md', 'text/markdown; charset=utf-8'], ['/llms-full.txt', 'text/plain; charset=utf-8']]) {
      const res = await get(path!);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe(type);
      // The asset's other headers (the _headers rules) and its body pass through unchanged.
      expect(res.headers.get('content-security-policy'), path).toBe("default-src 'self'");
    }
    expect((await get('/docs/agent-setup.md')).text).toBe('# Coding agent setup\n\nIt’s for agents — 编程智能体.\n');
    expect((await get('/robots.txt', { method: 'HEAD' })).headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('leaves other types, and a charset already given, as they are', async () => {
    expect((await get('/sitemap.xml')).headers.get('content-type')).toBe('application/xml');
    expect((await get('/browsers')).headers.get('content-type')).toBe('text/html');
    expect((await get('/')).headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect((await t.call('GET', '/api/public/pricing')).status).toBe(200);
    const api = await app.fetch(new Request(new URL('/api/public/pricing', ORIGIN)), t.env as never, t.ctx);
    expect(api.headers.get('content-type')).toMatch(/^application\/json/);
  });
});

describe('live slots', () => {
  it('replaces each slot by name and keeps the fallback of a slot without a value', () => {
    const text = 'a<!--live:x-->1<!--/live:x-->b<!--live:y-->2<!--/live:y-->c';
    expect(fillSlots(text, { x: 'X', y: null })).toBe('aXb2c');
  });

  it('adds offers to the application node only, with < escaped', () => {
    const out = addOffers(`<head>${LD}</head>`, { '@type': 'AggregateOffer', description: '</script>' });
    const data = jsonLd(out);
    expect(data['@graph'][0].offers).toBeUndefined();
    expect(data['@graph'][1].offers.description).toBe('</script>');
    expect(out).not.toContain('</script></script>');
  });
});
