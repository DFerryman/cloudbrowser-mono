import { DATA_KEPT_DAYS, TIERS } from '@cloudbrowser/contracts';
import { DOCS } from '../../content/docs.js';
import { POLICIES } from '../../content/legal.js';
import type { Article, Block } from '../../content/types.js';
import { LEGAL_UPDATED, SECURITY_EMAIL, SUPPORT_EMAIL } from '../../lib/site.js';
import { canonicalUrl, message, POLICY_SLUGS, SITE_NAME, SITE_URL, type PublicPage } from './pages.js';

/**
 * The machine-readable side of the public site: robots.txt, sitemap.xml, llms.txt (llmstxt.org),
 * llms-full.txt and a markdown twin of each page, generated at build time from the same content
 * the pages show. Live data (prices, open regions) goes between `<!--live:NAME-->` markers, which
 * the api Worker fills on each request (apps/api/src/site.ts); the text between them is the
 * fallback when prices cannot be read.
 */

/** A slot the api Worker fills with live data; `fallback` stays when it cannot. */
export const liveSlot = (name: string, fallback: string) => `<!--live:${name}-->${fallback}<!--/live:${name}-->`;

/** Paths only a signed-in user (or the operator) can use; nothing there is for an index. */
export const PRIVATE_PATHS = ['/api/', '/b/', '/browsers', '/account', '/billing', '/promotions', '/sign-up/complete', '/admin'];

/**
 * Crawlers named so their operators see they are welcome. Each gets the same group as `*`: a
 * crawler that finds a group with its own name ignores the `*` group.
 */
export const WELCOME_CRAWLERS = [
  'Googlebot', 'Bingbot', 'Applebot', 'DuckAssistBot',
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
  'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
  'PerplexityBot', 'Perplexity-User',
  'Google-Extended', 'Applebot-Extended', 'CCBot', 'Amazonbot', 'meta-externalagent', 'MistralAI-User', 'cohere-ai',
];

export function robotsTxt(): string {
  const rules = [
    // Cloudflare's Content Signals Policy (contentsignals.org): search, AI answers and training all allowed.
    'Content-Signal: search=yes, ai-input=yes, ai-train=yes',
    'Allow: /',
    ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`),
  ];
  return [
    `# ${SITE_NAME} welcomes search engines and AI assistants on its public pages.`,
    `# A plain-text guide for language models: ${SITE_URL}/llms.txt`,
    '',
    'User-agent: *',
    ...rules,
    '',
    ...WELCOME_CRAWLERS.map((bot) => `User-agent: ${bot}`),
    ...rules,
    '',
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    '',
  ].join('\n');
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export function sitemapXml(pages: PublicPage[], lastmod: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...pages.map((p) => `  <url><loc>${xml(canonicalUrl(p))}</loc><lastmod>${xml(lastmod)}</lastmod></url>`),
    '</urlset>',
    '',
  ].join('\n');
}

const mdUrl = (path: string) => SITE_URL + path;

function blockMarkdown(b: Block): string {
  if ('h' in b) return `## ${b.h}`;
  if ('ul' in b) return b.ul.map((li) => `- ${li}`).join('\n');
  if ('note' in b) return `> **Note:** ${b.note}`;
  if ('code' in b) return [b.label ? `${b.label}:` : null, '```', b.code, '```'].filter((l) => l !== null).join('\n');
  // A folded section is unfolded for language models: all of it is meant to be read.
  if ('details' in b) return [`### ${b.details}`, ...b.blocks.map(blockMarkdown)].join('\n\n');
  return b.p;
}

/** A docs article or policy as markdown, with where it lives. */
export function articleMarkdown(article: Article, page: Pick<PublicPage, 'path'>, extra: string[] = []): string {
  return [
    `# ${article.title}`,
    `> ${article.summary}`,
    ...extra,
    ...article.blocks.map(blockMarkdown),
    `Source: ${canonicalUrl(page)}`,
  ].join('\n\n') + '\n';
}

/** "- [Title](url): summary" for every docs article. */
const docsLinks = () => DOCS.en.map((a) => `- [${a.title}](${mdUrl(`/docs/${a.slug}.md`)}): ${a.summary}`);
const policyLinks = () => POLICY_SLUGS.map((slug) => `- [${POLICIES.en[slug].title}](${mdUrl(`/${slug}.md`)}): ${POLICIES.en[slug].summary}`);

/** One paragraph on what Nevazu is: the answer to the first question anyone asks. */
const definition = () => message('home.faq.1.a');

const tiers = () =>
  `${message('tier.basic')} (${TIERS.basic.vcpu} vCPU, ${TIERS.basic.memoryGb} GB memory) and ${message('tier.premium')} (${TIERS.premium.vcpu} vCPU, ${TIERS.premium.memoryGb} GB memory, where offered): they differ only in CPU and memory.`;

/** Short facts for llms.txt and the home page's markdown, each traceable to the docs. */
const keyFacts = () => [
  `- Each browser is a real Chrome on its own cloud computer (Amazon Web Services), in the region chosen when it is created; the browser keeps that region and its dedicated IPv4 address for life.`,
  `- Profile, cookies, extensions and sign-ins are kept on encrypted storage between sessions; an idle browser sleeps (10 minutes by default) and wakes in about a minute.`,
  `- The live view streams Chrome over WebRTC to any desktop, tablet or phone browser, with ordered keyboard, mouse, touch, input-method and clipboard input.`,
  `- Coding agents (Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI, OpenCode or any MCP client) connect to a browser's own hosted MCP server over HTTPS, either signing in with the user's Nevazu account (OAuth, approved for 1 to 90 days) or with an access key the user keeps in an environment variable; nothing is installed, and the agent adds the server to its own configuration (${mdUrl('/docs/agent-setup.md')}). The user watches and takes control back with any click or key.`,
  `- Two machine tiers: ${tiers()}`,
  `- Prepaid, no subscription: running time per minute while awake; the dedicated IP per hour and storage per GB-month while the browser exists; data sent per GB. Prices are public AWS list prices for the region times a published multiplier.`,
  `- Sign-in with one-time email codes (no password), optional passkeys and two-step verification; payments through Stripe, or Creem as merchant of record.`,
];

const SUMMARY_FALLBACK = `The regions open for new browsers and current prices are listed at ${mdUrl('/pricing')} and ${mdUrl('/pricing.md')}.`;

export function homeMarkdown(): string {
  const pillars = (['cloud', 'persist', 'ip'] as const).map((k) => `- **${message(`home.p.${k}.title`)}.** ${message(`home.p.${k}.body`)}`);
  const features = (['view', 'agents', 'sleep', 'billing', 'devices'] as const).map((k) => `- **${message(`home.f.${k}.title`)}.** ${message(`home.f.${k}.body`)}`);
  const steps = ([1, 2, 3] as const).map((n) => `${n}. **${message(`home.how.${n}.title`)}.** ${message(`home.how.${n}.body`)}`);
  const faq = ([1, 2, 3, 4] as const).map((n) => `### ${message(`home.faq.${n}.q`)}\n\n${message(`home.faq.${n}.a`)}`);
  return [
    `# ${SITE_NAME}: ${message('home.title.lead')} ${message('home.title.accent')}`,
    `> ${message('seo.home.description')}`,
    definition(),
    message('home.subtitle'),
    `## ${message('home.pillars.title')}`,
    [...pillars, ...features].join('\n'),
    '## How it works',
    steps.join('\n'),
    `## ${message('home.regions.title')}`,
    message('home.regions.body'),
    liveSlot('summary-md', SUMMARY_FALLBACK),
    `## ${message('home.faq.title')}`,
    ...faq,
    `More answers: ${mdUrl('/docs/faq.md')}`,
    '## Pages',
    [`- [Pricing](${mdUrl('/pricing.md')})`, `- [Documentation](${mdUrl('/docs.md')})`, `- [Contact](${mdUrl('/contact.md')})`, `- [Create an account](${SITE_URL}/sign-up)`].join('\n'),
    `Source: ${SITE_URL}/`,
  ].join('\n\n') + '\n';
}

/** How billing works, in markdown: the pricing page's text without the live numbers. */
function pricingModel(): string[] {
  const billing = DOCS.en.find((a) => a.slug === 'billing')!;
  const charged = billing.blocks.find((b): b is { ul: string[] } => 'ul' in b)!;
  return [
    `## ${message('pricing.how')}`,
    ([1, 2, 3, 4] as const).map((n) => `${n}. **${message(`pricing.how.${n}.title`)}.** ${message(`pricing.how.${n}.body`, { days: DATA_KEPT_DAYS })}`).join('\n'),
    '## What is charged',
    charged.ul.map((li) => `- ${li}`).join('\n'),
    message('pricing.source'),
    `Machine tiers: ${tiers()}`,
  ];
}

export function pricingMarkdown(): string {
  return [
    `# ${message('pricing.title')}`,
    `> ${message('pricing.subtitle')}`,
    '## Current prices',
    liveSlot('prices-md', `Current prices for each region are shown at ${mdUrl('/pricing')}.`),
    ...pricingModel(),
    `## ${message('pricing.faq')}`,
    ...([1, 2, 3, 4, 5] as const).map((n) => `### ${message(`pricing.faq.${n}.q`)}\n\n${message(`pricing.faq.${n}.a`)}`),
    `More: ${mdUrl('/docs/billing.md')} · ${mdUrl('/refunds.md')}`,
    `Source: ${SITE_URL}/pricing`,
  ].join('\n\n') + '\n';
}

export function docsMarkdown(): string {
  return [`# ${message('seo.docs.title')}`, `> ${message('seo.docs.description')}`, docsLinks().join('\n'), `Source: ${SITE_URL}/docs`].join('\n\n') + '\n';
}

export function contactMarkdown(): string {
  const rows = (['support', 'billing', 'security'] as const).map((k) => `- **${message(`contact.${k}.title`)}** (${k === 'security' ? SECURITY_EMAIL : SUPPORT_EMAIL}): ${message(`contact.${k}.body`)}`);
  return [`# ${message('contact.title')}`, `> ${message('contact.subtitle')}`, rows.join('\n'), `Source: ${SITE_URL}/contact`].join('\n\n') + '\n';
}

/** The markdown twin of a public page; null for the status page, which is only live data. */
export function pageMarkdown(page: PublicPage): string | null {
  switch (page.kind) {
    case 'home': return homeMarkdown();
    case 'pricing': return pricingMarkdown();
    case 'docs': return docsMarkdown();
    case 'contact': return contactMarkdown();
    case 'doc': return articleMarkdown(page.article!, page);
    case 'policy': return articleMarkdown(page.article!, page, [`Last updated: ${LEGAL_UPDATED}`]);
    case 'status': return null;
  }
}

/** /llms.txt (llmstxt.org): what Nevazu is, the key facts, and links to every page as markdown. */
export function llmsTxt(): string {
  return [
    `# ${SITE_NAME}`,
    `> ${definition()}`,
    keyFacts().join('\n'),
    liveSlot('summary-md', SUMMARY_FALLBACK),
    '## Docs',
    docsLinks().join('\n'),
    '## Pricing',
    [`- [Pricing](${mdUrl('/pricing.md')}): current prices per region and tier, and how prepaid, per-minute billing works`, `- [Billing and credit](${mdUrl('/docs/billing.md')}): what is charged, held credit, and what happens when credit runs out`].join('\n'),
    '## Policies',
    policyLinks().join('\n'),
    '## Optional',
    [`- [Full text](${mdUrl('/llms-full.txt')}): every page above in one file`, `- [Home](${mdUrl('/index.md')}): the home page`, `- [Contact](${mdUrl('/contact.md')}): support, billing and security email addresses`].join('\n'),
  ].join('\n\n') + '\n';
}

/** /llms-full.txt: the home page, pricing (with live prices), every docs article and the policies' summaries. */
export function llmsFullTxt(): string {
  const policies = POLICY_SLUGS.map((slug) => {
    const p = POLICIES.en[slug];
    return `## ${p.title}\n\n${p.summary} Last updated ${LEGAL_UPDATED}. Full text: ${mdUrl(`/${slug}.md`)}`;
  });
  return [
    `# ${SITE_NAME}: full text for language models`,
    `> ${definition()}`,
    `This file joins ${SITE_NAME}'s public pages in English. Index: ${mdUrl('/llms.txt')}`,
    homeMarkdown(),
    pricingMarkdown(),
    ...DOCS.en.map((a) => articleMarkdown(a, { path: `/docs/${a.slug}` })),
    `# Policies\n\n${policies.join('\n\n')}`,
    contactMarkdown(),
  ].join('\n\n---\n\n');
}
