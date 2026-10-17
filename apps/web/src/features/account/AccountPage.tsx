import { Button, Section, Select } from '@cloudbrowser/ui';
import { PageHeader, signOut } from '../../app/AppShell.js';
import { api } from '../../lib/api.js';
import { useI18n, type Locale } from '../../lib/i18n.js';
import { BillingSection } from '../billing/BillingSection.js';
import { useMe } from '../instances/hooks.js';

export function AccountPage() {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  return (
    <div className="max-w-[720px]">
      <PageHeader title={t('account.title')} />
      <div className="space-y-4">
        <Section title={t('account.profile')}>
          <p className="text-sm">
            <span className="text-muted">{t('account.email')}: </span>
            {me.data?.user.email ?? '…'}
          </p>
          <div className="mt-4 max-w-xs">
            <label htmlFor="ui-locale" className="mb-1.5 block text-sm font-medium">
              {t('account.language')}
            </label>
            <Select id="ui-locale" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </Select>
          </div>
        </Section>
        <BillingSection />
        <Section title={t('account.security')} description={t('account.securityBody')}>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={async () => {
                await api('POST', '/api/auth/revoke-sessions', { body: {} }).catch(() => {});
                await signOut();
              }}
            >
              {t('account.signOutEverywhere')}
            </Button>
            <Button variant="ghost" onClick={() => void signOut()}>
              {t('nav.signOut')}
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}
