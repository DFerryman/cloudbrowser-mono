import { LifeBuoy, Receipt, ShieldAlert } from 'lucide-react';
import { useI18n } from '../lib/i18n.js';
import { SECURITY_EMAIL, SUPPORT_EMAIL } from '../lib/site.js';
import { container, PublicHero } from './PublicShell.js';

export function ContactPage() {
  const { t } = useI18n();
  const cards = [
    { key: 'support', icon: LifeBuoy, email: SUPPORT_EMAIL },
    { key: 'billing', icon: Receipt, email: SUPPORT_EMAIL },
    { key: 'security', icon: ShieldAlert, email: SECURITY_EMAIL },
  ] as const;
  return (
    <>
      <PublicHero eyebrow={t('footer.contact')} title={t('contact.title')} subtitle={t('contact.subtitle')} />
      <section className={`${container} pb-20`}>
        <div className="grid gap-px border border-border bg-border md:grid-cols-3">
        {cards.map(({ key, icon: Icon, email }) => (
          <div key={key} className="flex flex-col bg-bg p-8">
            <Icon className="size-5" aria-hidden />
            <h2 className="mt-8 text-lg font-semibold tracking-tight">{t(`contact.${key}.title`)}</h2>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{t(`contact.${key}.body`)}</p>
            <a href={`mailto:${email}`} className="mt-6 inline-block border-t border-border pt-4 font-mono text-sm font-medium hover:underline">
              {email}
            </a>
          </div>
        ))}
        </div>
      </section>
    </>
  );
}
