import { retentionReserve, type Instance, type RegionPricing } from '@cloudbrowser/contracts';
import { Button, cn, Dialog, Hint, Input, Label, Section, Skeleton, useToast } from '@cloudbrowser/ui';
import { DocsLink } from '../../app/DocsLink.js';
import { useEffect, useState } from 'react';
import { useI18n } from '../../lib/i18n.js';
import { bytes, money } from '../../lib/money.js';
import { isPriceChanged, useBilling, usePricing } from '../billing/hooks.js';
import { canSpend } from '../billing/access.js';
import { BalanceRequired } from '../billing/BalanceRequired.js';
import { useManagedInstance } from './BrowserLayout.js';
import { useResizeStorage, useStorage } from './hooks.js';
import { LoadError } from '../../app/LoadError.js';

/** Current storage capacity, filesystem usage, and a confirmed quote before growing the volume. */
export function StoragePage() {
  const i = useManagedInstance();
  const pricing = usePricing();
  const price = pricing.isError ? undefined : pricing.data?.find((p) => p.regionId === i.regionId);
  return (
    <div className="space-y-4">
      <BalanceRequired />
      <StorageCard instance={i} pricing={price} />
    </div>
  );
}

function StorageCard({ instance: i, pricing }: { instance: Instance; pricing: RegionPricing | undefined }) {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const storage = useStorage(i.id);
  const resize = useResizeStorage();
  const billing = useBilling();
  const [size, setSize] = useState(i.storageGb + 10);
  const [quote, setQuote] = useState<{ pricing: RegionPricing; from: number; to: number; rootVolumeGb: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSize((s) => Math.max(s, i.storageGb + 1)), [i.storageGb]);
  const s = storage.data;
  if (!s && storage.isError) return <LoadError error={storage.error} onRetry={() => void storage.refetch()} />;
  if (!s) return <Skeleton className="h-64" />;
  const rate = pricing?.rates?.storage ?? null;
  const m = (v: number) => money(v, locale);
  const monthly = (gb: number) => (rate === null ? null : rate * (gb + s.rootVolumeGb));
  const target = Math.min(s.maxGb, Math.max(s.sizeGb + 1, Math.floor(size) || 0));
  const before = monthly(s.sizeGb);
  const after = monthly(target);
  const reserveFor = (gb: number, p = pricing) => p?.rates ? retentionReserve(p.rates, { storageGb: gb, rootVolumeGb: s.rootVolumeGb, backups: false }) : 0;
  const reserveIncrease = Math.max(0, reserveFor(target) - reserveFor(s.sizeGb));
  const quoteReserveIncrease = quote ? Math.max(0, reserveFor(quote.to, quote.pricing) - reserveFor(quote.from, quote.pricing)) : 0;
  const quoteMonthly = (gb: number) => quote!.pricing.rates!.storage * (gb + quote!.rootVolumeGb);
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
          className="h-2 overflow-hidden bg-surface-2"
          role="progressbar"
          aria-valuenow={pct === null ? undefined : Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={cn('h-full', pct !== null && pct >= 90 ? 'bg-error' : pct !== null && pct >= 75 ? 'bg-starting' : 'bg-fg')} style={{ width: `${pct ?? 0}%` }} />
        </div>
        {capacityPending && (i.status === 'sleeping' || i.status === 'running') ? (
          <p role="status" className="mt-2 text-sm text-starting">
            {t(i.status === 'sleeping' ? 'storage.capacityAfterStart' : 'storage.capacityPending')}
          </p>
        ) : null}
        <Hint className="mt-2">{t('storage.system', { gb: s.rootVolumeGb })}</Hint>
        {before !== null && rate !== null ? (
          <p className="mt-1 text-sm">{t('storage.cost', { amount: m(before), rate: t('price.perGbMonth', { amount: m(rate) }) })}</p>
        ) : null}
      </div>

      <div className="mt-5">
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
              <Button variant="primary" disabled={!canSpend(billing.data, reserveIncrease) || rate === null || !pricing?.version || resize.isPending || target <= s.sizeGb} onClick={() => { setError(null); setQuote({ pricing: pricing!, from: s.sizeGb, to: target, rootVolumeGb: s.rootVolumeGb }); }}>
                {t('storage.grow')}
              </Button>
            </div>
            {after !== null && before !== null ? (
              <p className="mt-2 text-sm">{t('storage.extra', { gb: target - s.sizeGb, amount: m(after - before), total: m(after) })}</p>
            ) : (
              <p className="mt-2 text-sm text-muted">{t('price.unavailable')}</p>
            )}
            {reserveIncrease > 0 ? <Hint className="mt-1">{t('storage.reserveIncrease', { amount: m(reserveIncrease) })}</Hint> : null}
            <BalanceRequired additionalReserve={reserveIncrease} />
          </>
        )}
        <Hint className="mt-2">
          {t('storage.rules')} <DocsLink to="storage#grow" />
        </Hint>
        {error ? <p role="alert" className="mt-2 text-sm text-error">{error}</p> : null}
      </div>

      <Dialog
        open={quote !== null}
        onOpenChange={(open) => !open && setQuote(null)}
        title={t('storage.confirmTitle', { gb: quote ? quote.to - quote.from : 0 })}
        description={quote ? t('storage.confirmBody', { from: quote.from, to: quote.to, amount: m(quoteMonthly(quote.to)), before: m(quoteMonthly(quote.from)) }) : ''}
        closeLabel={t('common.cancel')}
      >
        {quoteReserveIncrease > 0 ? <Hint className="mb-3">{t('storage.reserveIncrease', { amount: m(quoteReserveIncrease) })}</Hint> : null}
        <BalanceRequired additionalReserve={quoteReserveIncrease} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => setQuote(null)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={resize.isPending || !quote?.pricing.version || !canSpend(billing.data, quoteReserveIncrease)}
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
