import type { Backup, Instance, RegionPricing } from '@cloudbrowser/contracts';
import { Button, cn, Dialog, Input, Label, Section, Skeleton, useToast } from '@cloudbrowser/ui';
import { useEffect, useState } from 'react';
import { useI18n } from '../../lib/i18n.js';
import { bytes, money } from '../../lib/money.js';
import { isPriceChanged, usePricing } from '../billing/hooks.js';
import { useManagedInstance } from './BrowserLayout.js';
import { useBackups, useResizeStorage, useRestoreBackup, useStorage, useUpdateInstance } from './hooks.js';

/** The Storage & backups tab: space used, adding storage, snapshots (billed) and archives (free), with prices shown first. */
export function StoragePage() {
  const i = useManagedInstance();
  const pricing = usePricing();
  const price = pricing.isError ? undefined : pricing.data?.find((p) => p.regionId === i.regionId);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <StorageCard instance={i} pricing={price} />
      <SnapshotsCard instance={i} pricing={price} />
      <Backups instance={i} />
    </div>
  );
}

function StorageCard({ instance: i, pricing }: { instance: Instance; pricing: RegionPricing | undefined }) {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const storage = useStorage(i.id);
  const resize = useResizeStorage();
  const [size, setSize] = useState(i.storageGb + 10);
  const [quote, setQuote] = useState<{ pricing: RegionPricing; from: number; to: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSize((s) => Math.max(s, i.storageGb + 1)), [i.storageGb]);
  const s = storage.data;
  if (!s) return <Skeleton className="h-64" />;
  const rate = pricing?.rates?.storage ?? null;
  const m = (v: number) => money(v, locale);
  const monthly = (gb: number) => (rate === null ? null : rate * (gb + s.rootVolumeGb));
  const target = Math.min(s.maxGb, Math.max(s.sizeGb + 1, Math.floor(size) || 0));
  const before = monthly(s.sizeGb);
  const after = monthly(target);
  const quoteMonthly = (gb: number) => quote!.pricing.rates!.storage * (gb + quote!.pricing.rootVolumeGb);
  const pct = s.usedBytes !== null && s.totalBytes ? Math.min(100, (s.usedBytes / s.totalBytes) * 100) : null;
  // A completed EBS resize can precede filesystem growth or the next agent report.
  // Leave room for filesystem overhead; missing usage reports are not evidence of a mismatch.
  const capacityPending = s.totalBytes !== null && s.totalBytes > 0 && s.totalBytes < s.sizeGb * 1024 ** 3 * 0.85;
  const blocked =
    s.blockedReason === 'cooldown'
      ? t('storage.blocked.cooldown', { time: new Date(s.nextResizeAt ?? Date.now()).toLocaleString(locale) })
      : s.blockedReason === 'max'
        ? t('storage.blocked.max', { gb: s.maxGb })
        : s.blockedReason
          ? t(`storage.blocked.${s.blockedReason}`)
          : null;

  return (
    <Section title={t('storage.title')}>
      <div>
        <div className="mb-1 flex flex-wrap justify-between gap-2 text-sm">
          <span className="font-medium">{t('storage.size', { gb: s.sizeGb })}</span>
          <span className="text-muted">{pct !== null ? t('storage.used', { used: bytes(s.usedBytes), total: bytes(s.totalBytes) }) : t('storage.usedUnknown')}</span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={pct === null ? undefined : Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={cn('h-full rounded-full', pct !== null && pct >= 90 ? 'bg-error' : pct !== null && pct >= 75 ? 'bg-starting' : 'bg-accent')} style={{ width: `${pct ?? 0}%` }} />
        </div>
        {capacityPending && (i.status === 'sleeping' || i.status === 'running') ? (
          <p role="status" className="mt-2 text-sm text-starting">
            {t(i.status === 'sleeping' ? 'storage.capacityAfterStart' : 'storage.capacityPending')}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted">{t('storage.system', { gb: s.rootVolumeGb })}</p>
        {before !== null && rate !== null ? (
          <p className="mt-1 text-sm">{t('storage.cost', { amount: m(before), rate: t('price.perGbMonth', { amount: m(rate) }) })}</p>
        ) : null}
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <h3 className="mb-2 text-sm font-medium">{t('storage.grow')}</h3>
        {blocked ? (
          <p className="text-sm text-muted">{blocked}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-32">
                <Label htmlFor="size">{t('storage.newSize')}</Label>
                <Input id="size" type="number" inputMode="numeric" min={s.sizeGb + 1} max={s.maxGb} value={size} onChange={(e) => setSize(Number(e.target.value))} />
              </div>
              <Button variant="primary" disabled={rate === null || !pricing?.version || resize.isPending || target <= s.sizeGb} onClick={() => { setError(null); setQuote({ pricing: pricing!, from: s.sizeGb, to: target }); }}>
                {t('storage.grow')}
              </Button>
            </div>
            {after !== null && before !== null ? (
              <p className="mt-2 text-sm">{t('storage.extra', { gb: target - s.sizeGb, amount: m(after - before), total: m(after) })}</p>
            ) : (
              <p className="mt-2 text-sm text-muted">{t('price.unavailable')}</p>
            )}
          </>
        )}
        <p className="mt-2 text-xs text-muted">{t('storage.rules')}</p>
        {error ? <p role="alert" className="mt-2 text-sm text-error">{error}</p> : null}
      </div>

      <Dialog
        open={quote !== null}
        onOpenChange={(open) => !open && setQuote(null)}
        title={t('storage.confirmTitle', { gb: quote ? quote.to - quote.from : 0 })}
        description={quote ? t('storage.confirmBody', { from: quote.from, to: quote.to, amount: m(quoteMonthly(quote.to)), before: m(quoteMonthly(quote.from)) }) : ''}
        closeLabel={t('common.cancel')}
      >
        <div className="flex justify-end gap-2">
          <Button onClick={() => setQuote(null)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={resize.isPending || !quote?.pricing.version}
            onClick={() =>
              resize.mutate(
                { id: i.id, sizeGb: quote!.to, priceVersion: quote!.pricing.version! },
                {
                  onSuccess: () => {
                    setQuote(null);
                    toast(t('storage.started'));
                  },
                  onError: (e) => {
                    if (isPriceChanged(e)) setQuote(null);
                    setError(errorMessage(e));
                    toast(errorMessage(e), 'error');
                  },
                },
              )
            }
          >
            {t('storage.confirm')}
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}

function SnapshotsCard({ instance: i, pricing }: { instance: Instance; pricing: RegionPricing | undefined }) {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const storage = useStorage(i.id);
  const update = useUpdateInstance();
  const [confirm, setConfirm] = useState<'off' | RegionPricing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const days = storage.data?.snapshots.retentionDays ?? 7;
  const rate = pricing?.rates?.snapshot ?? null;
  const m = (v: number) => money(v, locale);
  const monthly = rate === null ? null : rate * i.storageGb;
  const trial = !!i.trial && i.trial.state !== 'converted';
  const quote = confirm && confirm !== 'off' ? confirm : null;
  const set = (backupsEnabled: boolean) =>
    update.mutate(
      { id: i.id, patch: { backupsEnabled, ...(backupsEnabled && quote?.version ? { priceVersion: quote.version } : {}) } },
      {
        onSuccess: () => {
          setConfirm(null);
          toast(backupsEnabled ? t('snapshots.enabled') : t('snapshots.disabled'));
        },
        onError: (e) => {
          if (isPriceChanged(e)) setConfirm(null);
          setError(errorMessage(e));
          toast(errorMessage(e), 'error');
        },
      },
    );

  return (
    <Section title={t('snapshots.title')} description={t('snapshots.body', { days })}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={cn('text-sm font-medium', i.backupsEnabled ? 'text-running' : 'text-muted')}>
          {i.backupsEnabled ? t('snapshots.statusOn') : t('snapshots.statusOff')}
        </span>
        {i.backupsEnabled ? (
          <Button disabled={update.isPending} onClick={() => setConfirm('off')}>
            {t('snapshots.disable')}
          </Button>
        ) : (
          <Button variant="primary" disabled={update.isPending || monthly === null || !pricing?.version || trial || i.status === 'deleting'} onClick={() => { setError(null); setConfirm(pricing!); }}>
            {t('snapshots.enable')}
          </Button>
        )}
      </div>
      {trial ? <p className="mt-3 text-sm text-muted">{t('snapshots.trial')}</p> : null}
      {error ? <p role="alert" className="mt-2 text-sm text-error">{error}</p> : null}
      {monthly !== null && rate !== null ? (
        <p className="mt-3 text-sm">{t('snapshots.cost', { amount: m(monthly), rate: t('price.perGbMonth', { amount: m(rate) }), gb: i.storageGb })}</p>
      ) : (
        <p className="mt-3 text-sm text-muted">{t('price.unavailable')}</p>
      )}
      <div className="mt-5 border-t border-border pt-4">
        <h3 className="text-sm font-medium">{t('archives.title')}</h3>
        <p className="mt-1 text-sm text-muted">{t('archives.body')}</p>
      </div>

      <Dialog
        open={quote !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('snapshots.enableTitle')}
        description={
          quote?.rates ? t('snapshots.enableBody', { gb: i.storageGb, days, amount: m(quote.rates.snapshot * i.storageGb), rate: t('price.perGbMonth', { amount: m(quote.rates.snapshot) }) }) : ''
        }
        closeLabel={t('common.cancel')}
      >
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={update.isPending || !quote?.version} onClick={() => set(true)}>
            {t('snapshots.enable')}
          </Button>
        </div>
      </Dialog>
      <Dialog open={confirm === 'off'} onOpenChange={(o) => !o && setConfirm(null)} title={t('snapshots.disableTitle')} description={t('snapshots.disableBody')} closeLabel={t('common.cancel')}>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={update.isPending} onClick={() => set(false)}>
            {t('snapshots.disable')}
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}

/** Snapshots restore while the browser sleeps, archives while it runs (page 4). */
function Backups({ instance: i }: { instance: Instance }) {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const backups = useBackups(i.id);
  const restore = useRestoreBackup();
  const [pick, setPick] = useState<Backup | null>(null);
  const list = (backups.data ?? []).filter((b) => b.status !== 'pending');
  const fmt = (iso: string) => new Date(iso).toLocaleString(locale);

  return (
    <Section title={t('backups.title')} className="lg:col-span-2">
      {backups.isPending ? (
        <Skeleton className="h-16" />
      ) : list.length ? (
        <ul className="divide-y divide-border text-sm">
          {list.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                {fmt(b.createdAt)} · {t(`backups.kind.${b.kind}`)}
                <span className="text-muted">
                  {' '}
                  · {t(`backups.reason.${b.reason}`)}
                  {b.sizeBytes ? ` · ${bytes(b.sizeBytes)}` : ''}
                </span>
                {b.status === 'failed' ? <span className="text-error"> · {t('backups.failed')}</span> : null}
              </span>
              {b.status === 'complete' ? (
                <Button
                  disabled={i.status !== b.restorableWhen || restore.isPending}
                  title={i.status !== b.restorableWhen ? t(`backups.when.${b.restorableWhen}`) : undefined}
                  onClick={() => setPick(b)}
                >
                  {t('backups.restore')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t('backups.none')}</p>
      )}
      <Dialog
        open={pick !== null}
        onOpenChange={(o) => !o && setPick(null)}
        title={t('backups.confirmTitle')}
        description={pick ? t('backups.confirmBody', { time: fmt(pick.createdAt) }) : ''}
        closeLabel={t('common.cancel')}
      >
        <div className="flex justify-end gap-2">
          <Button onClick={() => setPick(null)}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            disabled={restore.isPending}
            onClick={() =>
              pick &&
              restore.mutate(
                { id: i.id, backupId: pick.id },
                {
                  onSuccess: () => {
                    setPick(null);
                    toast(t('backups.started'));
                  },
                  onError: (e) => toast(errorMessage(e), 'error'),
                },
              )
            }
          >
            {t('backups.restore')}
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}
