import { Button, Section, Select } from '@cloudbrowser/ui';
import { Link } from 'react-router';
import { PageHeader, signOut } from '../../app/AppShell.js';
import { DocsLink } from '../../app/DocsLink.js';
import { useI18n, type Locale } from '../../lib/i18n.js';
import { Passkeys } from './Passkeys.js';
import { TwoFactorSettings } from './TwoFactor.js';
import { useMe } from '../instances/hooks.js';

/** The account: who you are and how you sign in. Money is on Billing & usage. */
export function AccountPage() {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  return (
    <>
      <PageHeader title={t('account.title')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('account.profile')}>
          <p className="text-xs text-muted">{t('account.email')}</p>
          <p className="mt-1 text-lg font-semibold tracking-tight break-all">{me.data?.user.email ?? '…'}</p>
          <div className="mt-6 max-w-xs">
            <label htmlFor="ui-locale" className="mb-1.5 block text-[13px] font-medium">
              {t('account.language')}
            </label>
            <Select id="ui-locale" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </Select>
          </div>
        </Section>
        <Section title={t('account.billingTitle')} description={t('account.billingBody')}>
          <Link to="/billing">
            <Button>{t('nav.billing')}</Button>
          </Link>
        </Section>
        <Section title={t('account.security')} action={<DocsLink to="security" />} className="lg:col-span-2">
          <div className="divide-y divide-border">
            <div className="pb-5">
              <TwoFactorSettings />
            </div>
            <div className="py-5">
              <Passkeys />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-border pt-5">
            <Button onClick={() => void signOut({ everywhere: true })}>
              {t('account.signOutEverywhere')}
            </Button>
            <Button variant="ghost" onClick={() => void signOut()}>
              {t('nav.signOut')}
            </Button>
          </div>
        </Section>
      </div>
    </>
  );
}
