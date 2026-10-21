import { Card } from '@cloudbrowser/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Logo } from '../../app/AppShell.js';
import { LanguageButton, ThemeButton } from '../../app/Preferences.js';
import { useI18n } from '../../lib/i18n.js';
import { rich } from '../../lib/rich.js';

/** Only same-site paths, so a crafted link cannot send a fresh session elsewhere. */
export const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/browsers');

/** The frame shared by sign-in and sign-up: logo, preferences, one card, the policies line. */
export function AuthLayout({ notice, footer, agree = 'auth.agree', children }: { notice?: ReactNode; footer?: ReactNode; agree?: 'auth.agree' | 'signup.agree'; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-1 py-8 min-[360px]:px-3 sm:px-4">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" aria-label={t('auth.backHome')}>
            <Logo />
          </Link>
          <div className="flex items-center gap-1">
            <LanguageButton />
            <ThemeButton />
          </div>
        </div>
        {notice}
        <Card className="p-1 shadow-pop min-[360px]:p-3 min-[400px]:p-6 sm:p-8">{children}</Card>
        {footer ? <p className="mt-4 text-center text-sm text-muted">{footer}</p> : null}
        <div className="mt-4 space-y-2 px-1 text-center text-xs leading-relaxed text-subtle">
          <p>
            {rich(t(agree), {
              terms: <Link to="/terms" className="underline hover:text-fg">{t('footer.terms')}</Link>,
              privacy: <Link to="/privacy" className="underline hover:text-fg">{t('footer.privacy')}</Link>,
            })}
          </p>
        </div>
      </div>
    </div>
  );
}
