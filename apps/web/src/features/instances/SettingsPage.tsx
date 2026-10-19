import { useRegionInfo } from './hooks.js';
import { HOURS_PER_MONTH, IDLE_TIMEOUT_OPTIONS_S, SCREEN_SIZES, type BrowserLocale, type Instance, type RegionPricing } from '@cloudbrowser/contracts';
import { Button, Dialog, Input, Label, Section, Select, useToast } from '@cloudbrowser/ui';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { isPriceChanged, useBilling, usePricing } from '../billing/hooks.js';
import { canSpend } from '../billing/access.js';
import { BalanceRequired } from '../billing/BalanceRequired.js';
import { useManagedInstance } from './BrowserLayout.js';
import { useLifecycle, useMe, useRecentSessions, useUpdateInstance, useVerifyIp } from './hooks.js';


function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border py-2.5 last:border-0 sm:grid-cols-[160px_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** The Settings tab: identity and IP, behavior, activity and deletion (page 1, "Screen: browser settings"). */
export function SettingsPage() {
  const i = useManagedInstance();
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const me = useMe();
  const verify = useVerifyIp();
  const lifecycle = useLifecycle();
  const update = useUpdateInstance();
  const sessions = useRecentSessions(i.id);
  const pricing = usePricing();
  const billing = useBilling();
  const region = useRegionInfo(i.regionId);
  const [name, setName] = useState(i.name);
  const [ipQuote, setIpQuote] = useState<RegionPricing | null>(null);
  const [ipError, setIpError] = useState<string | null>(null);
  const [deleteText, setDeleteText] = useState('');
  useEffect(() => setName(i.name), [i.name]);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale) : '—');
  const save = (patch: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate({ id: i.id, patch }, { onSuccess: () => toast(t('settings.saved')), onError: (e) => toast(errorMessage(e), 'error') });
  const maxIdle = me.data?.entitlements.idleTimeoutMaxS ?? 1800;
  // A free trial browser keeps its IP until the user adds credit (page 6).
  const onTrial = i.trial !== null && i.trial.state !== 'converted';
  const check = i.lastIpCheck;
  const price = pricing.isError ? undefined : pricing.data?.find((p) => p.regionId === i.regionId);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title={t('settings.identity')}>
        <dl>
          <Row label={t('settings.region')}>
            {region.name} <span className="text-muted">· {t('settings.regionPermanent')}</span>
          </Row>
          <Row label={t('settings.ip')}>
            <span className="font-mono">{i.ipAddress ?? t('browsers.reservingIp')}</span>
          </Row>
          <Row label={t('settings.location')}>
            {{ AU: 'Australia', JP: 'Japan', US: 'United States' }[region.country]} · {region.city}
          </Row>
          <Row label={t('settings.dedicatedSince')}>{fmt(i.dedicatedSince)}</Row>
          <Row label={t('settings.timezone')}>{region.timezone}</Row>
          <Row label={t('settings.lastCheck')}>
            {check ? (
              <span className="inline-flex items-start gap-1.5">
                {check.ok ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-running" /> : <ShieldAlert className="mt-0.5 size-4 shrink-0 text-error" />}
                <span>
                  {check.ok
                    ? t('settings.checkOk', { time: fmt(check.checkedAt), ip: check.observed.join(', ') })
                    : t('settings.checkFailed', { time: fmt(check.checkedAt), observed: check.observed.join(', ') || '—' })}
                </span>
              </span>
            ) : (
              <span className="text-muted">{t('settings.noCheck')}</span>
            )}
          </Row>
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            disabled={verify.isPending || (i.status !== 'running' && i.status !== 'needs_attention')}
            onClick={() => verify.mutate(i.id, { onError: (e) => toast(errorMessage(e), 'error') })}
          >
            {t('settings.verify')}
          </Button>
          <Button disabled={!canSpend(billing.data) || !['running', 'sleeping'].includes(i.status) || onTrial || !price?.rates || !price.version} onClick={() => { setIpError(null); setIpQuote(price!); }}>
            {t('settings.requestIp')}
          </Button>
          {onTrial ? (
            <span className="text-xs text-muted">{t('settings.ipTrial')}</span>
          ) : i.status !== 'running' ? (
            <span className="text-xs text-muted">{t('settings.verifyRunningOnly')}</span>
          ) : null}
        </div>
        {ipError ? <p role="alert" className="mt-2 text-sm text-error">{ipError}</p> : null}
      </Section>

      <div className="space-y-4">
        <Section title={t('settings.behavior')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="name">{t('settings.name')}</Label>
              <div className="flex gap-2">
                <Input id="name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
                <Button disabled={!name.trim() || name.trim() === i.name} onClick={() => save({ name: name.trim() })}>
                  {t('settings.save')}
                </Button>
              </div>
            </div>
            <div>
              <Label htmlFor="idle">{t('settings.autoSleep')}</Label>
              <Select id="idle" value={i.idleTimeoutS} onChange={(e) => save({ idleTimeoutS: Number(e.target.value) })}>
                {IDLE_TIMEOUT_OPTIONS_S.map((s) => (
                  <option key={s} value={s} disabled={s > maxIdle}>
                    {t('settings.minutes', { n: s / 60 })}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="screen">{t('settings.screen')}</Label>
              <Select id="screen" value={i.screen} onChange={(e) => save({ screen: e.target.value as Instance['screen'] })}>
                {SCREEN_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s === 'auto' ? t('create.screen.auto') : s.replace('x', ' × ')}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="locale">{t('settings.language')}</Label>
              <Select id="locale" value={i.locale} onChange={(e) => save({ locale: e.target.value as BrowserLocale })}>
                <option value="zh-CN">简体中文</option>
                <option value="en-US">English (US)</option>
                <option value="ja-JP">日本語</option>
              </Select>
            </div>
          </div>
        </Section>

        <Section title={t('settings.activity')}>
          {sessions.data?.length ? (
            <ul className="divide-y divide-border text-sm">
              {sessions.data.slice(0, 8).map((s) => (
                <li key={s.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>{fmt(s.startedAt)}</span>
                  <span className="text-muted">
                    {s.country ?? '—'} ·{' '}
                    {s.endedAt ? `${Math.max(1, Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60_000))} min` : t('settings.ongoing')}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{t('settings.noActivity')}</p>
          )}
        </Section>
      </div>

      <Section title={t('settings.danger')} description={t('settings.deleteBody')} className="border-error/40 lg:col-span-2">
        <Label htmlFor="confirm-delete">{t('settings.deleteType', { name: i.name })}</Label>
        <div className="flex max-w-xl gap-2">
          <Input id="confirm-delete" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} autoComplete="off" />
          <Button
            variant="danger"
            disabled={deleteText !== i.name || (lifecycle.isPending && lifecycle.variables.action === 'delete') || i.status === 'deleting'}
            onClick={() =>
              lifecycle.mutate({ id: i.id, action: 'delete' }, { onSuccess: () => navigate('/browsers'), onError: (e) => toast(errorMessage(e), 'error') })
            }
          >
            {t('settings.delete')}
          </Button>
        </div>
      </Section>

      <Dialog open={ipQuote !== null} onOpenChange={(open) => !open && setIpQuote(null)} title={t('settings.requestIpTitle')} description={t('settings.requestIpBody')} closeLabel={t('common.cancel')}>
        <BalanceRequired />
        {ipQuote?.rates ? (
          <p className="mb-4 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-sm">
            {t('settings.requestIpCost', { amount: money(ipQuote.rates.ip, locale), monthly: money(ipQuote.rates.ip * HOURS_PER_MONTH, locale) })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setIpQuote(null)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={lifecycle.isPending || !ipQuote?.version || !canSpend(billing.data)}
            onClick={() =>
              lifecycle.mutate(
                { id: i.id, action: 'ip-change', body: { priceVersion: ipQuote!.version! } },
                {
                  onSuccess: () => {
                    setIpQuote(null);
                    toast(t('settings.requestIpDone'));
                  },
                  onError: (e) => {
                    if (isPriceChanged(e)) setIpQuote(null);
                    setIpError(errorMessage(e));
                    toast(errorMessage(e), 'error');
                  },
                },
              )
            }
          >
            {t('settings.requestIpConfirm')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
