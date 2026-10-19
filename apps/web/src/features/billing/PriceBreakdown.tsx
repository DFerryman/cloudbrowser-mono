import { browserEstimate, retentionReserve, type RegionPricing } from '@cloudbrowser/contracts';
import { cn } from '@cloudbrowser/ui';
import type { ReactNode } from 'react';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { useRegionInfo } from '../instances/hooks.js';

function Line({ label, hint, value, strong }: { label: string; hint?: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <p className={cn('text-sm', strong && 'font-medium')}>{label}</p>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      <p className={cn('shrink-0 text-right text-sm tabular-nums', strong && 'font-semibold')}>{value}</p>
    </div>
  );
}

/** Where the prices come from, and when they were read. */
export function PriceSource({ pricing }: { pricing: RegionPricing }) {
  const { t, locale } = useI18n();
  const region = useRegionInfo(pricing.regionId);
  if (!pricing.updatedAt) return null;
  return (
    <p className="text-xs text-muted">
      {pricing.source === 'simulated'
        ? t('price.source.simulated')
        : t('price.source.aws', { region: region.name, date: new Date(pricing.updatedAt).toLocaleDateString(locale) })}
    </p>
  );
}

/**
 * Everything a browser in this region costs, before the user commits to it (page 6): the running
 * price per hour, what it costs per month while it exists (dedicated IP and storage) and
 * data sent per GB.
 */
export function PriceBreakdown({ pricing, storageGb }: { pricing: RegionPricing; storageGb?: number }) {
  const { t, locale } = useI18n();
  if (!pricing.rates) return <p className="text-sm text-muted">{t('price.unavailable')}</p>;
  const r = pricing.rates;
  const gb = storageGb ?? pricing.defaultStorageGb;
  const e = browserEstimate(r, { storageGb: gb, rootVolumeGb: pricing.rootVolumeGb, backups: false });
  const m = (micros: number) => money(micros, locale);
  return (
    <div className="space-y-3">
      <div className="divide-y divide-border">
        <Line
          label={t('price.running')}
          hint={t('price.runningTotalHint')}
          value={t('price.perHour', { amount: m(e.runningTotalHour) })} strong />
        <Line
          label={t('price.compute')}
          hint={pricing.machine ? `${t('price.machine', { vcpu: pricing.machine.vcpu, memory: pricing.machine.memoryGb })} ${t('price.runningHint')}` : t('price.runningHint')}
          value={t('price.perHour', { amount: m(e.runningHour) })} />
        <div className="py-1.5">
          <p className="text-sm font-medium">{t('price.kept')}</p>
          <p className="text-xs text-muted">{t('price.keptHint')}</p>
          <div className="mt-1 pl-3">
            <Line label={t('price.ip')} hint={t('price.ipHint')} value={t('price.perHour', { amount: m(r.ip) })} />
            <Line
              label={t('price.storage', { gb: gb + pricing.rootVolumeGb })}
              hint={`${t('price.storageHint', { data: gb, root: pricing.rootVolumeGb })} ${t('price.storageProjection', { amount: m(e.storageMonth) })}`}
              value={t('price.perGbMonth', { amount: m(r.storage) })}
            />
            <Line label={t('price.keptTotal')} hint={t('price.hourlyEquivalent', { amount: m(e.alwaysOnHour) })} value={t('price.perMonth', { amount: m(e.alwaysOnMonth) })} strong />
          </div>
        </div>
        <Line label={t('price.transfer')} hint={t('price.transferHint')} value={t('price.perGb', { amount: m(r.transfer) })} strong />
      </div>
      <p className="text-xs text-muted">{t('price.example', { amount: m(e.runningHour * 60 + e.alwaysOnMonth) })}</p>
      <p className="text-xs text-muted">{t('price.reserve', { amount: m(retentionReserve(r, { storageGb: gb, rootVolumeGb: pricing.rootVolumeGb, backups: false })) })}</p>
      <PriceSource pricing={pricing} />
    </div>
  );
}
