import { IDLE_TIMEOUT_OPTIONS_S, SCREEN_SIZES, type BrowserLocale, type Instance } from '@cloudbrowser/contracts';
import { Button, Dialog, Input, Label, RegionIpChip, Section, Select, Skeleton, StatusBadge, useToast } from '@cloudbrowser/ui';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PageHeader } from '../../app/AppShell.js';
import { useI18n } from '../../lib/i18n.js';
import { useInstance, useLifecycle, useMe, useRecentSessions, useUpdateInstance, useVerifyIp } from './hooks.js';
import { regionInfo, STATUS_TONE, statusKey } from './status.js';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border py-2.5 last:border-0 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** One column, sections in order of importance (page 1, "Screen: browser settings"). */
export function SettingsPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const instance = useInstance(id);
  if (instance.isPending) return <Skeleton className="h-96 max-w-[720px]" />;
  if (instance.isError) return <p className="text-sm text-error">{t('error.not_found')}</p>;
  return <Settings instance={instance.data} />;
}

function Settings({ instance: i }: { instance: Instance }) {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const me = useMe();
  const verify = useVerifyIp();
  const lifecycle = useLifecycle();
  const update = useUpdateInstance();
  const sessions = useRecentSessions(i.id);
  const region = regionInfo(i.regionId);
  const [name, setName] = useState(i.name);
  const [confirmIp, setConfirmIp] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  useEffect(() => setName(i.name), [i.name]);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale) : '—');
  const save = (patch: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate({ id: i.id, patch }, { onSuccess: () => toast(t('settings.saved')), onError: (e) => toast(errorMessage(e), 'error') });
  const maxIdle = me.data?.entitlements.idleTimeoutMaxS ?? 1800;
  const check = i.lastIpCheck;

  return (
    <div className="max-w-[720px]">
      <PageHeader
        title={t('settings.title', { name: i.name })}
        action={
          <Button variant="primary" onClick={() => navigate(`/b/${i.id}`)} disabled={i.status === 'deleting' || i.status === 'failed'}>
            {i.status === 'sleeping' ? t('browsers.wakeOpen') : t('browsers.open')}
          </Button>
        }
      />
      <div className="space-y-4">
        <Section title={t('settings.identity')}>
          <dl>
            <Row label={t('settings.region')}>
              {t(`create.region.${i.regionId}`)} <span className="text-muted">· {t('settings.regionPermanent')}</span>
            </Row>
            <Row label={t('settings.ip')}>
              <RegionIpChip
                country={region.country}
                city={region.city}
                ip={i.ipAddress}
                dedicatedLabel={t('browsers.dedicated')}
                copyLabel={t('browsers.copyIp')}
                pendingLabel={t('browsers.reservingIp')}
              />
            </Row>
            <Row label={t('settings.location')}>
              {region.country === 'JP' ? 'Japan' : 'United States'} · {region.city}
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
            <Button disabled={!['running', 'sleeping'].includes(i.status)} onClick={() => setConfirmIp(true)}>
              {t('settings.requestIp')}
            </Button>
            {i.status !== 'running' ? <span className="text-xs text-muted">{t('settings.verifyRunningOnly')}</span> : null}
          </div>
        </Section>

        <Section title={t('settings.persistence')} description={t('settings.persistenceBody')}>
          <StatusBadge tone={STATUS_TONE[i.status]} label={t(statusKey(i.status))} />
        </Section>

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
              {sessions.data.map((s) => (
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

        <Section title={t('settings.danger')} description={t('settings.deleteBody')} className="border-error/40">
          <Label htmlFor="confirm-delete">{t('settings.deleteType', { name: i.name })}</Label>
          <div className="flex gap-2">
            <Input id="confirm-delete" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} autoComplete="off" />
            <Button
              variant="danger"
              disabled={deleteText !== i.name || lifecycle.isPending || i.status === 'deleting'}
              onClick={() =>
                lifecycle.mutate(
                  { id: i.id, action: 'delete' },
                  { onSuccess: () => navigate('/browsers'), onError: (e) => toast(errorMessage(e), 'error') },
                )
              }
            >
              {t('settings.delete')}
            </Button>
          </div>
        </Section>

        <p className="text-sm">
          <Link to="/browsers" className="text-accent hover:underline">
            ← {t('session.back')}
          </Link>
        </p>
      </div>

      <Dialog open={confirmIp} onOpenChange={setConfirmIp} title={t('settings.requestIpTitle')} description={t('settings.requestIpBody')} closeLabel={t('common.cancel')}>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirmIp(false)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={lifecycle.isPending}
            onClick={() =>
              lifecycle.mutate(
                { id: i.id, action: 'ip-change' },
                {
                  onSuccess: () => {
                    setConfirmIp(false);
                    toast(t('settings.requestIpDone'));
                  },
                  onError: (e) => toast(errorMessage(e), 'error'),
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
