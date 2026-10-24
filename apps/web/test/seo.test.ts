import { describe, expect, it } from 'vitest';
import { DOCS } from '../src/content/docs.js';
import { fillTemplate, headTags } from '../src/site/seo/html.js';
import { canonicalUrl, publicPages, SITE_URL } from '../src/site/seo/pages.js';
import { jsonLdScript, structuredData } from '../src/site/seo/structured.js';
import { llmsFullTxt, llmsTxt, pageMarkdown, PRIVATE_PATHS, robotsTxt, sitemapXml, WELCOME_CRAWLERS } from '../src/site/seo/text.js';

const pages = publicPages();
const page = (path: string) => pages.find((p) => p.path === path)!;
type Node = Record<string, unknown> & { '@type': string | string[]; '@id'?: string };
const graph = (path: string) => (JSON.parse(JSON.stringify(structuredData(page(path), { modified: '2026-10-01T00:00:00Z' }))) as { '@graph': Node[] })['@graph'];
const ofType = (nodes: Node[], type: string) => nodes.filter((n) => n['@type'] === type);

describe('public pages', () => {
  it('lists every public page once, with its own title, description and file', () => {
    const paths = pages.map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(['/', '/pricing', '/docs', '/terms', '/privacy', '/refunds', '/dpa', '/contact', '/status', ...DOCS.en.map((a) => `/docs/${a.slug}`)]));
    for (const key of ['path', 'title', 'description', 'file'] as const) expect(new Set(pages.map((p) => p[key])).size).toBe(pages.length);
    // No trailing slashes: Workers static assets serve x.html at /x and redirect /x/ there.
    for (const p of pages) expect(p.path === '/' || !p.path.endsWith('/')).toBe(true);
    // index.html stays the app shell for private routes.
    expect(pages.map((p) => p.file)).not.toContain('index.html');
    expect(canonicalUrl(page('/'))).toBe(`${SITE_URL}/`);
  });

  it('describes a short article by its opening or its sections, within 200 characters', () => {
    expect(page('/docs/troubleshooting').description).toBe('What to do when something does not work. It covers: I did not get a sign-in code; My browser will not open; The network is paused; The picture is slow or blurry.');
    for (const p of pages) expect(p.description.length).toBeLessThanOrEqual(200);
    expect(page('/docs/billing').description).toMatch(/[^,;: ]…$/);
  });

  it('has an FAQ in both languages, question for question', () => {
    const ids = (locale: 'en' | 'zh-CN') => DOCS[locale].find((a) => a.slug === 'faq')!.blocks.flatMap((b) => ('h' in b ? [b.id] : []));
    expect(ids('en').length).toBeGreaterThanOrEqual(10);
    expect(ids('zh-CN')).toEqual(ids('en'));
  });
});

describe('structured data', () => {
  it('describes the organization and the website on every page', () => {
    for (const p of pages) {
      const nodes = graph(p.path);
      expect(ofType(nodes, 'Organization')).toEqual([expect.objectContaining({ name: 'Nevazu', url: `${SITE_URL}/`, email: 'support@nevazu.com' })]);
      expect(ofType(nodes, 'WebSite')).toHaveLength(1);
      expect(nodes.find((n) => n['@id'] === `${canonicalUrl(p)}#webpage`)).toMatchObject({ url: canonicalUrl(p), name: p.title, description: p.description });
    }
  });

  it('describes the application on the home and pricing pages, without prices until the Worker adds them', () => {
    for (const path of ['/', '/pricing']) {
      const [app] = ofType(graph(path), 'WebApplication');
      expect(app).toMatchObject({ '@id': `${SITE_URL}/#app`, applicationCategory: 'BrowserApplication', operatingSystem: 'Web' });
      expect(app).not.toHaveProperty('offers');
    }
    expect(ofType(graph('/docs/billing'), 'WebApplication')).toEqual([]);
  });

  it('marks docs as technical articles with breadcrumbs, and the FAQ as an FAQPage', () => {
    const doc = graph('/docs/coding-agents');
    expect(ofType(doc, 'TechArticle')).toEqual([expect.objectContaining({ headline: 'Coding agents', dateModified: '2026-10-01T00:00:00Z' })]);
    const [crumbs] = ofType(doc, 'BreadcrumbList') as [{ itemListElement: { position: number; item: string }[] }];
    expect(crumbs.itemListElement.map((i) => i.item)).toEqual([`${SITE_URL}/`, `${SITE_URL}/docs`, `${SITE_URL}/docs/coding-agents`]);
    const [faq] = ofType(graph('/docs/faq'), 'FAQPage') as [{ mainEntity: { name: string; acceptedAnswer: { text: string } }[] }];
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(10);
    expect(faq.mainEntity[0]).toMatchObject({ name: 'What is Nevazu?', acceptedAnswer: { text: expect.stringMatching(/^Nevazu is a persistent cloud browser service/) } });
    for (const q of faq.mainEntity) expect(q.acceptedAnswer.text.length).toBeGreaterThan(40);
  });

  it('cannot close its script element', () => {
    expect(jsonLdScript({ a: '</script><script>x</script>' })).not.toContain('<');
    expect(JSON.parse(jsonLdScript({ a: '</script>' }))).toEqual({ a: '</script>' });
  });
});

describe('page HTML', () => {
  const template = '<html lang="en"><head>\n    <meta name="description" content="x" />\n    <title>Nevazu</title>\n    <!-- shell -->\n    <meta name="robots" content="noindex" />\n    <script type="module" src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>';

  it('replaces the shell’s head tags, keeps its scripts and puts the page in #root', () => {
    const p = page('/pricing');
    const html = fillTemplate(template, headTags(p, structuredData(p)), '<h1>Pricing</h1>');
    expect(html).toContain('<title>Pricing: prepaid cloud browsers billed per minute | Nevazu</title>');
    expect(html).toContain('<link rel="canonical" href="https://nevazu.com/pricing" />');
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/pricing.md"');
    expect(html).toContain('<meta property="og:url" content="https://nevazu.com/pricing" />');
    expect(html).toContain('<script type="module" src="/assets/index-abc.js"></script>');
    expect(html).toContain('<div id="root"><h1>Pricing</h1></div>');
    expect(html).not.toMatch(/noindex|<!-- shell -->|content="x"/);
    expect(html.match(/<title>/g)).toHaveLength(1);
  });

  it('fails the build when the shell no longer has a tag it replaces', () => {
    expect(() => fillTemplate(template.replace('<div id="root"></div>', '<div id="app"></div>'), '', '')).toThrow(/#root/);
  });
});

describe('robots.txt and sitemap.xml', () => {
  const robots = robotsTxt();

  it('welcomes every crawler with content signals and keeps private paths out', () => {
    const groups = robots.split('\n\n').filter((g) => g.includes('User-agent:'));
    expect(groups[0]).toMatch(/^User-agent: \*\n/);
    for (const bot of WELCOME_CRAWLERS) expect(robots).toContain(`User-agent: ${bot}\n`);
    for (const group of groups) {
      expect(group).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /');
      for (const path of PRIVATE_PATHS) expect(`${group}\n`).toContain(`Disallow: ${path}\n`);
    }
    expect(robots).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
    expect(robots).not.toMatch(/Disallow: \/\n|Disallow: \/(pricing|docs)/);
  });

  it('lists every public page with its build date', () => {
    const xml = sitemapXml(pages, '2026-10-23T00:00:00.000Z');
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
    expect(xml.match(/<url>/g)).toHaveLength(pages.length);
    for (const p of pages) expect(xml).toContain(`<url><loc>${canonicalUrl(p)}</loc><lastmod>2026-10-23T00:00:00.000Z</lastmod></url>`);
  });
});

describe('llms.txt and markdown', () => {
  it('follows llmstxt.org: a title, a summary, then sections of links to markdown', () => {
    const text = llmsTxt();
    expect(text).toMatch(/^# Nevazu\n\n> Nevazu is a persistent cloud browser service\. [^\n]+\n\n- /);
    const sections = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(sections).toEqual(['Docs', 'Pricing', 'Policies', 'Optional']);
    for (const a of DOCS.en) expect(text).toContain(`- [${a.title}](${SITE_URL}/docs/${a.slug}.md): ${a.summary}`);
    for (const [, url] of text.matchAll(/\]\((\S+?)\)/g)) expect(url).toMatch(/^https:\/\/nevazu\.com\/.+\.(md|txt)$/);
    expect(text).toMatch(/hosted MCP server over HTTPS/);
    // The Worker fills current regions and prices in here.
    expect(text).toMatch(/<!--live:summary-md-->[^<]+<!--\/live:summary-md-->/);
  });

  it('has a markdown twin of every page but the status page', () => {
    for (const p of pages) {
      const md = pageMarkdown(p);
      if (p.kind === 'status') {
        expect(md).toBeNull();
        expect(p.markdown).toBeNull();
        continue;
      }
      expect(p.markdown).toMatch(/\.md$/);
      expect(md).toMatch(/^# .+\n\n> .+/);
      expect(md).toContain(`Source: ${canonicalUrl(p)}`);
      for (const b of p.article?.blocks ?? []) if ('h' in b) expect(md).toContain(`## ${b.h}\n`);
    }
    expect(pageMarkdown(page('/pricing'))).toMatch(/<!--live:prices-md-->[^<]+<!--\/live:prices-md-->/);
  });

  it('joins the pages in llms-full.txt', () => {
    const full = llmsFullTxt();
    for (const a of DOCS.en) expect(full).toContain(`# ${a.title}\n`);
    for (const title of ['Terms of Service', 'Privacy Policy', 'Refund Policy']) expect(full).toContain(`## ${title}\n`);
    expect(full).toContain('<!--live:prices-md-->');
  });
});
