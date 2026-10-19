import { POLICIES, type PolicySlug } from '../content/legal.js';
import { useI18n } from '../lib/i18n.js';
import { rich } from '../lib/rich.js';
import { LEGAL_UPDATED, SUPPORT_EMAIL } from '../lib/site.js';
import { ArticleBody } from './Article.js';
import { container } from './PublicShell.js';

/** Terms of Service, Privacy Policy or Refund Policy. */
export function LegalPage({ policy }: { policy: PolicySlug }) {
  const { t, locale } = useI18n();
  const article = POLICIES[locale][policy];
  return (
    <div className={`${container} py-12`}>
      <article className="mx-auto max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{article.title}</h1>
        <p className="mt-2 text-xs text-subtle">
          {t('legal.updated', { date: new Date(`${LEGAL_UPDATED}T00:00:00Z`).toLocaleDateString(locale, { dateStyle: 'long', timeZone: 'UTC' }) })}
        </p>
        <p className="mt-4 mb-6 text-base text-muted">{article.summary}</p>
        <ArticleBody article={article} />
        <p className="mt-10 border-t border-border pt-6 text-sm text-muted">
          {rich(t('legal.questions'), {
            email: (
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-accent hover:underline">
                {SUPPORT_EMAIL}
              </a>
            ),
          })}
        </p>
      </article>
    </div>
  );
}
