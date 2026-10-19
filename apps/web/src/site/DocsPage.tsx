import { cn, Input } from '@cloudbrowser/ui';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router';
import { DOCS } from '../content/docs.js';
import { anchor } from '../content/types.js';
import { useI18n } from '../lib/i18n.js';
import { ArticleBody, headings } from './Article.js';
import { container } from './PublicShell.js';

/** The user guide: a list of articles on the left, one article on the right. */
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
  const article = articles.find((a) => a.slug === slug);
  if (!slug) return <Navigate to={`/docs/${articles[0]!.slug}`} replace />;
  if (!article) return <Navigate to="/docs" replace />;
  const toc = headings(article);

  return (
    <div className={`${container} grid gap-8 py-10 md:grid-cols-[220px_1fr] lg:grid-cols-[220px_1fr_180px]`}>
      <aside className="md:sticky md:top-20 md:self-start">
        <p className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">{t('docs.title')}</p>
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('docs.search')} aria-label={t('docs.search')} className="pl-8" />
        </div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {matches.map((a) => (
            <NavLink
              key={a.slug}
              to={`/docs/${a.slug}`}
              className={({ isActive }) =>
                cn(
                  'shrink-0 rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors md:whitespace-normal',
                  isActive ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                )
              }
            >
              {a.title}
            </NavLink>
          ))}
          {!matches.length ? <p className="px-2.5 text-sm text-subtle">{t('docs.noResults')}</p> : null}
        </nav>
      </aside>
      <article className="min-w-0 max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{article.title}</h1>
        <p className="mt-2 mb-6 text-base text-muted">{article.summary}</p>
        <ArticleBody article={article} />
      </article>
      {toc.length > 1 ? (
        <nav className="hidden lg:sticky lg:top-20 lg:block lg:self-start" aria-label={t('docs.onThisPage')}>
          <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{t('docs.onThisPage')}</p>
          <ul className="space-y-1.5 text-sm">
            {toc.map((h) => (
              <li key={anchor(h)}>
                <Link to={`#${anchor(h)}`} className="text-muted hover:text-fg">
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
