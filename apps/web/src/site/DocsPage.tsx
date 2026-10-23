import { cn, Eyebrow, Input } from '@cloudbrowser/ui';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router';
import { DOCS } from '../content/docs.js';
import { anchor } from '../content/types.js';
import { useI18n } from '../lib/i18n.js';
import { ArticleBody, headings } from './Article.js';
import { container } from './PublicShell.js';

/** The user guide: a list of articles on the left, one article (or, at /docs, all of them) on the right. */
export function DocsPage() {
  const { slug } = useParams();
  const { t, locale } = useI18n();
  const articles = DOCS[locale];
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter((a) => JSON.stringify(a).toLowerCase().includes(q));
  }, [articles, query]);
  const article = slug ? articles.find((a) => a.slug === slug) : undefined;
  if (slug && !article) return <Navigate to="/docs" replace />;
  const toc = article ? headings(article) : [];

  return (
    <div className={`${container} grid gap-10 py-10 md:grid-cols-[220px_1fr] md:py-16 lg:grid-cols-[220px_1fr_200px] lg:gap-14`}>
      {/* min-w-0: on phones the article list scrolls sideways inside the page, never the page itself. */}
      <aside className="min-w-0 md:sticky md:top-24 md:self-start">
        <Eyebrow className="mb-4">{t('docs.title')}</Eyebrow>
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('docs.search')} aria-label={t('docs.search')} className="pl-8" />
        </div>
        <nav className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 md:mx-0 md:flex-col md:gap-0 md:border-b-0 md:border-l md:px-0">
          {matches.map((a) => (
            <NavLink
              key={a.slug}
              to={`/docs/${a.slug}`}
              className={({ isActive }) =>
                cn(
                  '-mb-px shrink-0 border-b-2 px-2.5 py-2 text-sm whitespace-nowrap transition-colors md:mb-0 md:-ml-px md:border-b-0 md:border-l-2 md:px-4 md:whitespace-normal',
                  isActive ? 'border-fg font-semibold text-fg' : 'border-transparent text-muted hover:text-fg',
                )
              }
            >
              {a.title}
            </NavLink>
          ))}
          {!matches.length ? <p className="px-2.5 text-sm text-subtle">{t('docs.noResults')}</p> : null}
        </nav>
      </aside>
      {article ? (
        <article className="min-w-0 max-w-[68ch]">
          <h1 className="text-[32px] leading-[1.1] font-semibold tracking-[-0.03em] md:text-[44px] md:leading-[1.08]">{article.title}</h1>
          <p className="mt-4 mb-10 border-b border-border pb-8 text-lg leading-relaxed text-muted">{article.summary}</p>
          <ArticleBody article={article} />
        </article>
      ) : (
        // The guide's own page lists every article, so /docs has content of its own to link and quote.
        <section className="min-w-0 max-w-[68ch]">
          <h1 className="text-[32px] leading-[1.1] font-semibold tracking-[-0.03em] md:text-[44px] md:leading-[1.08]">{t('docs.title')}</h1>
          <p className="mt-4 mb-10 border-b border-border pb-8 text-lg leading-relaxed text-muted">{t('seo.docs.description')}</p>
          <ul className="divide-y divide-border">
            {articles.map((a) => (
              <li key={a.slug} className="py-4 first:pt-0">
                <h2 className="text-lg font-semibold tracking-tight">
                  <Link to={`/docs/${a.slug}`} className="hover:underline">{a.title}</Link>
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-muted">{a.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {toc.length > 1 ? (
        <nav className="hidden lg:sticky lg:top-24 lg:block lg:self-start" aria-label={t('docs.onThisPage')}>
          <Eyebrow className="mb-4">{t('docs.onThisPage')}</Eyebrow>
          <ul className="space-y-2.5 border-l border-border pl-4 text-[13px]">
            {toc.map((h) => (
              <li key={anchor(h)}>
                <Link to={`#${anchor(h)}`} className="text-muted transition-colors hover:text-fg">
                  {h.h}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
