import { DOCS } from '../../content/docs.js';
import { POLICIES, type PolicySlug } from '../../content/legal.js';
import type { Article } from '../../content/types.js';
import { en, type MessageKey } from '../../messages/en.js';

/**
 * The public pages as search engines and AI assistants see them: prerendered HTML in English at a
 * canonical URL, with a markdown twin (src/prerender, docs/deploy-cloudflare.md "AI crawlers and
 * search"). Everything here comes from the same content and messages the app shows.
 */

/** The canonical origin; www.nevazu.com redirects here (deploy/cloudflare-www-redirect.json). */
export const SITE_URL = 'https://nevazu.com';
export const SITE_NAME = 'Nevazu';

export type PageKind = 'home' | 'pricing' | 'docs' | 'doc' | 'policy' | 'contact' | 'status';

export interface PublicPage {
  /** The URL path, served without a redirect (no trailing slash). */
  path: string;
  kind: PageKind;
  title: string;
  description: string;
  /** The prerendered HTML file in dist/. Workers static assets serve `x.html` at `/x` (html_handling). */
  file: string;
  /** The page as markdown, for language models; null where the page is only live data (status). */
  markdown: string | null;
  /** The docs article or policy the page shows. */
  article?: Article;
}

/** An English message with its {placeholders} filled in. */
export function message(key: MessageKey, vars: Record<string, string | number> = {}): string {
  let s: string = en[key];
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export const POLICY_SLUGS: readonly PolicySlug[] = ['terms', 'privacy', 'refunds'];

export function publicPages(): PublicPage[] {
  return [
    // The home page is not dist/index.html: that file is also the app's fallback for every private
    // route. The api Worker serves home.html at / (apps/api/src/site.ts).
    { path: '/', kind: 'home', title: message('seo.home.title'), description: message('seo.home.description'), file: 'home.html', markdown: '/index.md' },
    { path: '/pricing', kind: 'pricing', title: message('seo.pricing.title'), description: message('seo.pricing.description'), file: 'pricing.html', markdown: '/pricing.md' },
    { path: '/docs', kind: 'docs', title: message('seo.docs.title'), description: message('seo.docs.description'), file: 'docs.html', markdown: '/docs.md' },
    ...DOCS.en.map((article): PublicPage => ({
      path: `/docs/${article.slug}`,
      kind: 'doc',
      title: message('seo.doc.title', { title: article.title }),
      description: article.summary,
      file: `docs/${article.slug}.html`,
      markdown: `/docs/${article.slug}.md`,
      article,
    })),
    ...POLICY_SLUGS.map((slug): PublicPage => {
      const article = POLICIES.en[slug];
      return { path: `/${slug}`, kind: 'policy', title: message('seo.policy.title', { title: article.title }), description: article.summary, file: `${slug}.html`, markdown: `/${slug}.md`, article };
    }),
    { path: '/contact', kind: 'contact', title: message('seo.contact.title'), description: message('seo.contact.description'), file: 'contact.html', markdown: '/contact.md' },
    { path: '/status', kind: 'status', title: message('seo.status.title'), description: message('seo.status.description'), file: 'status.html', markdown: null },
  ];
}

/** The page's canonical URL: the home page with its slash, every other page without one. */
export const canonicalUrl = (page: Pick<PublicPage, 'path'>) => SITE_URL + page.path;
