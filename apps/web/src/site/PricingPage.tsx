import { REGION_AREAS, browserEstimate, type PublicPricing, type RegionId } from '@cloudbrowser/contracts';
import { Button, Card, cn, Hint, Label, Select, Skeleton } from '@cloudbrowser/ui';
import { ArrowRight, ChevronDown, Gift } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { regionPlace } from '../features/instances/region-names.js';
import type { MessageKey } from '../messages/en.js';
import { useI18n } from '../lib/i18n.js';
import { money } from '../lib/money.js';
import { usePublicPricing, useSignedIn } from './hooks.js';
import { container, PublicHero } from './PublicShell.js';

type RegionPrice = PublicPricing['regions'][number];
/** Typical live-view traffic per hour of watching, for the estimate (the docs say 0.5–1.5 GB). */
const GB_PER_HOUR = 1;

/**
 * Prepaid pricing for visitors: what a browser costs running and asleep in each region, the unit
 * rates behind it, an estimate for a month, and how charges and the held amount work.
 */
export function PricingPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const pricing = usePublicPricing();
  const regions = pricing.data?.regions ?? [];
  const [regionId, setRegionId] = useState<RegionId | null>(null);
  useEffect(() => {
    if (!regionId && regions.length) setRegionId((regions.find((r) => r.available && r.acceptingNew) ?? regions[0]!).regionId);
  }, [regions, regionId]);
  const region = regions.find((r) => r.regionId === regionId);
  const m = (v: number) => money(v, locale);
  const selectId = useId();
  // Many regions: one list grouped by continent, each option with its running price.
  const groups = [...REGION_AREAS, null].map((area) => [area, regions.filter((r) => r.area === area).sort((a, b) => regionPlace(a, locale).localeCompare(regionPlace(b, locale)))] as const).filter(([, list]) => list.length);
  const trialRegion = regions.find((r) => r.regionId === pricing.data?.trial.regionId);

  return (
    <>
      <PublicHero title={t('pricing.title')} subtitle={t('pricing.subtitle')} />

      <section className={`${container} pb-12`}>
        {pricing.isPending ? (
          <Skeleton className="h-72" />
        ) : pricing.isError || !regions.length ? (
          <Card className="p-6 text-sm text-muted">{t('pricing.unavailable')}</Card>
        ) : (
          <>
            <div className="mb-4 max-w-md">
              <Label htmlFor={selectId}>{t('pricing.region')}</Label>
              <Select id={selectId} value={regionId ?? ''} onChange={(e) => setRegionId(e.target.value)}>
                {groups.map(([area, list]) => (
                  <optgroup key={area ?? 'other'} label={area ? t(`area.${area}` as MessageKey) : t('area.other')}>
                    {list.map((r) => (
                      <option key={r.regionId} value={r.regionId}>
                        {regionPlace(r, locale)}
                        {r.rates ? ` · ${t('price.perHour', { amount: m(browserEstimate(r.rates, { storageGb: r.defaultStorageGb, rootVolumeGb: r.rootVolumeGb, backups: false }).runningTotalHour) })}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </div>
            {region ? <RegionCard region={region} /> : null}
          </>
        )}
      </section>

      {region?.rates ? (
        <section className={`${container} grid gap-4 pb-16 lg:grid-cols-2`}>
          <UnitRates region={region} />
          <Estimator region={region} />
        </section>
      ) : null}

      <section className="border-y border-border bg-surface py-16">
        <div className={container}>
          <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{t('pricing.how')}</h2>
          <ol className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {([1, 2, 3, 4] as const).map((n) => (
              <li key={n}>
                <span className="grid size-8 place-items-center rounded-full bg-accent/10 font-mono text-sm font-semibold text-accent">{n}</span>
                <h3 className="mt-3 font-semibold">{t(`pricing.how.${n}.title`)}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted">{t(`pricing.how.${n}.body`, { days: pricing.data?.retentionDays ?? 7 })}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8 flex flex-col gap-2 text-xs text-subtle">
            {pricing.data ? <p>{t('pricing.minBalance', { amount: m(pricing.data.minBalanceMicros) })}</p> : null}
            <p>{t('pricing.source')}</p>
            <Link to="/docs/billing" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
              {t('pricing.more')} <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </div>
      </section>

      {pricing.data ? (
        <section className={`${container} pt-16`}>
          <Card className="flex flex-col gap-4 border-accent/30 bg-accent/5 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <Gift className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
              <div>
                <h2 className="font-semibold">{t('pricing.trial.title')}</h2>
                <p className="mt-1 text-sm text-muted">
                  {t('pricing.trial.body', { minutes: pricing.data.trial.minutes, region: trialRegion ? regionPlace(trialRegion, locale) : pricing.data.trial.regionId })}
                </p>
              </div>
            </div>
            <Button variant="primary" onClick={() => navigate(signedIn ? '/browsers/new' : '/sign-in')}>
              {signedIn ? t('trial.start') : t('nav.signIn')}
            </Button>
          </Card>
        </section>
      ) : null}

      <Faq />
    </>
  );
}

function RegionCard({ region }: { region: RegionPrice }) {
  const { t, locale } = useI18n();
  const m = (v: number) => money(v, locale);
  if (!region.rates) return <Card className="p-6 text-sm text-muted">{t('pricing.unavailable')}</Card>;
  const e = browserEstimate(region.rates, { storageGb: region.defaultStorageGb, rootVolumeGb: region.rootVolumeGb, backups: false });
  const cells = [
    { label: t('pricing.running'), hint: t('pricing.runningHint'), value: m(e.runningTotalHour), unit: t('pricing.unit.hour'), strong: true },
    { label: t('pricing.asleep'), hint: t('pricing.asleepHint'), value: m(e.alwaysOnHour), unit: t('pricing.unit.hour') },
    { label: t('pricing.transfer'), hint: t('pricing.transferHint'), value: m(region.rates.transfer), unit: t('pricing.unit.gb') },
  ];
  return (
    <Card className="overflow-hidden">
      <div className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
        {cells.map((c) => (
          <div key={c.label} className="p-6">
            <p className="text-sm font-medium text-muted">{c.label}</p>
            <p className={cn('mt-2 font-semibold tracking-tight tabular-nums', c.strong ? 'text-[32px] leading-none' : 'text-2xl')}>
              {c.value} <span className="text-sm font-normal text-subtle">{c.unit}</span>
            </p>
            <Hint className="mt-2">{c.hint}</Hint>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface px-6 py-3 text-xs text-subtle">
        <span>{region.machine ? t('pricing.machine', { vcpu: region.machine.vcpu, memory: region.machine.memoryGb, gb: region.defaultStorageGb + region.rootVolumeGb }) : null}</span>
        {!region.acceptingNew ? <span className="font-medium text-starting">{t('pricing.notAccepting')}</span> : null}
      </div>
    </Card>
  );
}

function UnitRates({ region }: { region: RegionPrice }) {
  const { t, locale } = useI18n();
  const r = region.rates!;
  const m = (v: number) => money(v, locale);
  const rows = [
    [t('pricing.rate.compute'), m(r.compute), t('pricing.unit.hour')],
    [t('pricing.rate.ip'), m(r.ip), t('pricing.unit.hour')],
    [t('pricing.rate.storage'), m(r.storage), t('pricing.unit.gbMonth')],
    [t('pricing.rate.transfer'), m(r.transfer), t('pricing.unit.gb')],
  ];
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">{t('pricing.rates')}</h2>
      <table className="mt-3 w-full text-sm">
        <tbody className="divide-y divide-border">
          {rows.map(([label, value, unit]) => (
            <tr key={label}>
              <td className="py-2.5 pr-3 text-muted">{label}</td>
              <td className="py-2.5 text-right font-medium tabular-nums">
                {value} <span className="text-xs font-normal text-subtle">{unit}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Estimator({ region }: { region: RegionPrice }) {
  const { t, locale } = useI18n();
  const id = useId();
  const [hours, setHours] = useState(2);
  const m = (v: number) => money(v, locale);
  const e = browserEstimate(region.rates!, { storageGb: region.defaultStorageGb, rootVolumeGb: region.rootVolumeGb, backups: false });
  const running = e.runningHour * hours * 30;
  const transfer = region.rates!.transfer * GB_PER_HOUR * hours * 30;
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">{t('pricing.estimate')}</h2>
      <div className="mt-4 flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm text-muted">
          {t('pricing.hoursPerDay')}
        </label>
        <span className="font-mono text-sm font-medium">{t('pricing.hoursValue', { n: hours })}</span>
      </div>
      <input id={id} type="range" min={0} max={24} step={1} value={hours} onChange={(ev) => setHours(Number(ev.target.value))} className="mt-2 w-full accent-[var(--color-accent)]" />
      <p className="mt-4 text-2xl font-semibold tracking-tight tabular-nums">{t('pricing.estimateTotal', { amount: m(running + e.alwaysOnMonth) })}</p>
      <p className="mt-1 text-sm text-muted">{t('pricing.estimateBreakdown', { running: m(running), kept: m(e.alwaysOnMonth), transfer: m(transfer) })}</p>
      <Hint className="mt-3">{t('pricing.estimateNote')}</Hint>
    </Card>
  );
}

function Faq() {
  const { t } = useI18n();
  return (
    <section className={`${container} py-16`}>
      <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{t('pricing.faq')}</h2>
      <div className="mt-6 divide-y divide-border rounded-[var(--radius-card)] border border-border">
        {([1, 2, 3, 4, 5] as const).map((n) => (
          <details key={n} className="group px-5 py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium [&::-webkit-details-marker]:hidden">
              {t(`pricing.faq.${n}.q`)}
              <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {t(`pricing.faq.${n}.a`)}
              {n === 4 ? (
                <>
                  {' '}
                  <Link to="/refunds" className="text-accent hover:underline">
                    {t('footer.refunds')}
                  </Link>
                </>
              ) : null}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
