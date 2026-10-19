import { Card } from '@cloudbrowser/ui';
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
      <PublicHero title={t('contact.title')} subtitle={t('contact.subtitle')} />
      <section className={`${container} grid gap-4 pb-16 md:grid-cols-3`}>
        {cards.map(({ key, icon: Icon, email }) => (
          <Card key={key} className="p-6">
            <Icon className="size-5 text-accent" aria-hidden />
            <h2 className="mt-3 font-semibold">{t(`contact.${key}.title`)}</h2>
            <p className="mt-1 text-sm text-muted">{t(`contact.${key}.body`)}</p>
            <a href={`mailto:${email}`} className="mt-4 inline-block text-sm font-medium text-accent hover:underline">
              {email}
            </a>
          </Card>
        ))}
      </section>
    </>
  );
}
