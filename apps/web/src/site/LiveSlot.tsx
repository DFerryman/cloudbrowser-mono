/**
 * Where the api Worker writes live data (current prices, the regions open for new browsers) into a
 * prerendered public page: on every request it replaces everything between `<!--live:NAME-->` and
 * `<!--/live:NAME-->` (apps/api/src/site.ts). Only the prerender renders this (src/prerender); in
 * the app, the page loads the same data itself. The text in between stands in when no live data
 * is available, and points to a page that has it.
 */
export function LiveSlot({ name, text, link }: { name: string; text: string; link: { href: string; label: string } }) {
  const [before = '', after = ''] = text.split('{link}');
  const fallback = `<p>${escapeHtml(before)}<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>${escapeHtml(after)}</p>`;
  return <div data-live={name} className="text-sm leading-relaxed text-muted" dangerouslySetInnerHTML={{ __html: `<!--live:${name}-->${fallback}<!--/live:${name}-->` }} />;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
