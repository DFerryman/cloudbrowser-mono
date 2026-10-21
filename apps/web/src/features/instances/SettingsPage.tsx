import { useRegionInfo } from './hooks.js';
import { IDLE_TIMEOUT_OPTIONS_S, NEVER_SLEEP_TIMEOUT_S, TIERS } from '@cloudbrowser/contracts';
import { Button, cn, Hint, Input, Label, Pagination, Section, Select, useToast } from '@cloudbrowser/ui';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { PAGE_SIZE, usePagerLabels } from '../../lib/paging.js';
import { useManagedInstance } from './BrowserLayout.js';
import { DeleteBrowserForm } from './DeleteBrowser.js';
import { NeverSleepDialog } from './NeverSleep.js';
import { useMe, useRecentSessions, useUpdateInstance, useVerifyIp } from './hooks.js';
import { regionPlace } from './region-names.js';


function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border py-3 first:pt-0 last:border-0 last:pb-0 sm:grid-cols-[160px_1fr] sm:gap-4">
      <dt className="text-sm text-subtle">{label}</dt>
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
  const update = useUpdateInstance();
  const [sessionPage, setSessionPage] = useState(0);
  const sessions = useRecentSessions(i.id, sessionPage, PAGE_SIZE.sessions);
  const pagerLabels = usePagerLabels(false);
  const region = useRegionInfo(i.regionId);
  const [name, setName] = useState(i.name);
  useEffect(() => setName(i.name), [i.name]);
  useEffect(() => setSessionPage(0), [i.id]);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale) : '—');
  const save = (patch: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate({ id: i.id, patch }, { onSuccess: () => toast(t('settings.saved')), onError: (e) => toast(errorMessage(e), 'error') });
  const maxIdle = me.data?.entitlements.idleTimeoutMaxS ?? 3600;
  const [neverSleepOpen, setNeverSleepOpen] = useState(false);
  const neverSleep = i.idleTimeoutS === NEVER_SLEEP_TIMEOUT_S;
  // Offered by the operator; the dialog checks credit and price.
  const neverSleepOffered = (me.data?.entitlements.neverSleep ?? false) || neverSleep;
  const check = i.lastIpCheck;
  const tier = i.tier ?? 'basic';

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title={t('settings.identity')}>
        <dl>
          <Row label={t('settings.region')}>
            {region.name} <span className="text-muted">· {t('settings.regionPermanent')}</span>
          </Row>
          <Row label={t('settings.machine')}>
            {t(`tier.${tier}`)}{' '}
            <span className="text-muted">· {t('create.machine.hint', { vcpu: TIERS[tier].vcpu, memory: TIERS[tier].memoryGb })}</span>
          </Row>
          <Row label={t('settings.ip')}>
            <span className="font-mono">{i.ipAddress ?? t('browsers.reservingIp')}</span>
          </Row>
          <Row label={t('settings.location')}>{regionPlace(region, locale)}</Row>
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
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <Button
            disabled={verify.isPending || (i.status !== 'running' && i.status !== 'needs_attention')}
            onClick={() => verify.mutate(i.id, { onError: (e) => toast(errorMessage(e), 'error') })}
          >
            {t('settings.verify')}
          </Button>
          {i.status !== 'running' ? <span className="text-xs text-subtle">{t('settings.verifyRunningOnly')}</span> : null}
        </div>
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
              <Select
                id="idle"
                value={i.idleTimeoutS}
                onChange={(e) => {
                  const s = Number(e.target.value);
                  // Never sleep is saved only after its 24-hour cost is confirmed.
                  if (s === NEVER_SLEEP_TIMEOUT_S) setNeverSleepOpen(true);
                  else save({ idleTimeoutS: s });
                }}
              >
                {IDLE_TIMEOUT_OPTIONS_S.filter((s) => s !== NEVER_SLEEP_TIMEOUT_S || neverSleepOffered).map((s) => (
                  <option key={s} value={s} disabled={s !== NEVER_SLEEP_TIMEOUT_S && s > maxIdle}>
                    {s === NEVER_SLEEP_TIMEOUT_S ? t('settings.neverSleep') : t('settings.minutes', { n: s / 60 })}
                  </option>
                ))}
              </Select>
              <Hint className="mt-1.5">{neverSleep ? t('settings.neverSleepOn') : t('settings.autoSleepHint')}</Hint>
              {/* Longer choices are greyed out by the operator's limit; say so rather than leave them unexplained. */}
              {maxIdle < Math.max(...IDLE_TIMEOUT_OPTIONS_S) ? <Hint className="mt-1">{t('settings.autoSleepMax', { n: maxIdle / 60 })}</Hint> : null}
              <NeverSleepDialog instance={i} open={neverSleepOpen} onClose={() => setNeverSleepOpen(false)} />
            </div>
          </div>
        </Section>

        <Section title={t('settings.activity')}>
          {sessions.rows?.length ? (
            <ul className={cn('divide-y divide-border text-sm transition-opacity', sessions.isPlaceholderData && 'opacity-60')}>
              {sessions.rows.map((s) => (
                <li key={s.id} className="flex flex-wrap justify-between gap-2 py-2.5 tabular-nums">
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
          <Pagination page={sessionPage} hasMore={sessions.hasMore} onPage={setSessionPage} labels={pagerLabels} />
        </Section>
      </div>

      <Section title={t('settings.danger')} description={t('settings.deleteBody')} className="border-error/30 lg:col-span-2">
        <DeleteBrowserForm instance={i} onDeleted={() => navigate('/browsers')} />
      </Section>

    </div>
  );
}
