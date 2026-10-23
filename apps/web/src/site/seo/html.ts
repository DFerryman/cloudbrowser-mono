import { canonicalUrl, SITE_NAME, SITE_URL, type PublicPage } from './pages.js';
import { jsonLdScript } from './structured.js';

/** The tags that describe one page to search engines, link previews and AI assistants. */
export function headTags(page: PublicPage, data: unknown): string {
  const url = canonicalUrl(page);
  const a = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return [
    `<title>${a(page.title)}</title>`,
    `<meta name="description" content="${a(page.description)}" />`,
    '<meta name="robots" content="index, follow" />',
    `<link rel="canonical" href="${a(url)}" />`,
    ...(page.markdown ? [`<link rel="alternate" type="text/markdown" href="${a(page.markdown)}" title="Markdown" />`] : []),
    `<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt" />`,
    `<meta property="og:type" content="${page.kind === 'doc' ? 'article' : 'website'}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${a(page.title)}" />`,
    `<meta property="og:description" content="${a(page.description)}" />`,
    `<meta property="og:url" content="${a(url)}" />`,
    '<meta property="og:locale" content="en_US" />',
    `<meta property="og:image" content="${SITE_URL}/apple-touch-icon.png" />`,
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${a(page.title)}" />`,
    `<meta name="twitter:description" content="${a(page.description)}" />`,
    `<script type="application/ld+json">${jsonLdScript(data)}</script>`,
  ].join('\n    ');
}

/** Replaces exactly one match, or fails the build: a changed index.html must not silently lose a tag. */
function replaceOnce(html: string, pattern: RegExp, by: string, what: string): string {
  const matches = html.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
  if (matches?.length !== 1) throw new Error(`prerender: expected one ${what} in index.html, found ${matches?.length ?? 0}`);
  return html.replace(pattern, () => by);
}

/**
 * A prerendered page from the built app shell (dist/index.html): the page's own head tags in
 * place of the shell's title, description and noindex, and its content inside #root. The hashed
 * script and stylesheet tags stay, so the app starts as usual and its first render replaces the
 * content (createRoot, not hydration: nothing has to match).
 */
export function fillTemplate(template: string, head: string, body: string): string {
  let html = replaceOnce(template, /\n\s*<title>[^<]*<\/title>/, '', 'title');
  html = replaceOnce(html, /\n\s*<meta name="description"[^>]*>/, '', 'meta description');
  html = replaceOnce(html, /(<!--[^>]*-->\s*)?<meta name="robots"[^>]*>/, head, 'meta robots');
  return replaceOnce(html, /<div id="root"><\/div>/, `<div id="root">${body}</div>`, 'empty #root');
}
