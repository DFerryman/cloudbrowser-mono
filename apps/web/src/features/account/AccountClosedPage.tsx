import { CLOSURE_ERASE_DAYS, CLOSURE_REFUND_DAYS } from '@cloudbrowser/contracts';
import { Button } from '@cloudbrowser/ui';
import { CheckCircle2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { rich } from '../../lib/rich.js';
import { SUPPORT_EMAIL } from '../../lib/site.js';
import { container } from '../../site/PublicShell.js';

/** Where closing the account lands, signed out. `refund` is the refund the closure fixed, in micro-dollars. */
export function AccountClosedPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const refund = Number(useSearchParams()[0].get('refund') ?? NaN);
  const mail = <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-fg underline underline-offset-2">{SUPPORT_EMAIL}</a>;
  return (
    <section className={`${container} grid min-h-[50vh] place-items-center py-16`}>
      <div className="max-w-lg">
        <CheckCircle2 className="size-8" aria-hidden />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">{t('closed.title')}</h1>
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted" data-testid="account-closed">
          <p>{t('closed.body')}</p>
          {Number.isSafeInteger(refund) && refund >= 0 ? (
            <p>{refund > 0 ? t('closed.refund', { amount: money(refund, locale), days: CLOSURE_REFUND_DAYS }) : t('closed.noRefund')}</p>
          ) : null}
          <p>{t('closed.erase', { days: CLOSURE_ERASE_DAYS })}</p>
          <p>{rich(t('closed.questions'), { email: mail })}</p>
        </div>
        <Button variant="primary" size="lg" className="mt-8" onClick={() => navigate('/')}>
          {t('closed.home')}
        </Button>
      </div>
    </section>
  );
}
