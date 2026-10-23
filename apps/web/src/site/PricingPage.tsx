import { REGION_AREAS, TIERS, browserEstimate, type BrowserTier, type PublicPricing, type RegionId } from '@cloudbrowser/contracts';
import { Button, Card, cn, CountryTag, Eyebrow, Hint, Menu, MenuItem, MenuLabel, Skeleton } from '@cloudbrowser/ui';
import { ArrowRight, Check, ChevronDown, ChevronsUpDown, Gift, MapPin, Minus, Plus } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { regionPlace } from '../features/instances/region-names.js';
import type { MessageKey } from '../messages/en.js';
import { useI18n } from '../lib/i18n.js';
import { money } from '../lib/money.js';
import { usePublicPricing, useSignedIn } from './hooks.js';
import { LiveSlot } from './LiveSlot.js';
import { container, PublicHero } from './PublicShell.js';

type RegionPrice = PublicPricing['regions'][number];
/** Typical live-view traffic per hour of watching, for the estimate (the docs say 0.5–1.5 GB). */
const GB_PER_HOUR = 1;
/** A region a visitor can price and a user can create in: open, taking new browsers, priced. */
const supported = (r: RegionPrice) => r.available && r.acceptingNew && !!r.rates;

/** A region's prices for a browser of this tier: Premium's rates and machine, where it is offered. */
function forTier(r: RegionPrice, tier: BrowserTier): RegionPrice {
  if (tier === 'basic') return r;
  return r.premium
    ? { ...r, rates: r.premium.rates, machine: r.premium.machine, cost: r.premiumCost ?? r.cost, acceptingNew: (r.premiumAvailability ?? 'unavailable') !== 'unavailable' }
    : { ...r, rates: null, machine: null, cost: null, acceptingNew: false };
}

/**
 * Prepaid pricing for visitors: what a browser costs running and asleep in each region, the unit
 * rates behind it, an estimate for a month, and how charges and the held amount work.
 */
export function PricingPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const pricing = usePublicPricing();
  // Premium is shown where the operator offers it to new accounts and some region prices it.
  const premiumShown = !!pricing.data?.premiumOffered && !!pricing.data.regions.some((r) => r.premium);
  const [tierChoice, setTier] = useState<BrowserTier>('basic');
  const tier: BrowserTier = premiumShown ? tierChoice : 'basic';
  const regions = (pricing.data?.regions ?? []).map((r) => forTier(r, tier));
  const [regionId, setRegionId] = useState<RegionId | null>(null);
  useEffect(() => {
    if (!regionId && regions.length) setRegionId((regions.find(supported) ?? regions[0]!).regionId);
  }, [regions, regionId]);
  const region = regions.find((r) => r.regionId === regionId);
  const m = (v: number) => money(v, locale);
  // Many regions: one list grouped by continent, each option with its running price.
  const groups = [...REGION_AREAS, null].map((area) => [area, regions.filter((r) => r.area === area).sort((a, b) => regionPlace(a, locale).localeCompare(regionPlace(b, locale)))] as const).filter(([, list]) => list.length);

  return (
    <>
      <PublicHero eyebrow={t('nav.pricing')} title={t('pricing.title')} subtitle={t('pricing.subtitle')} />

      <section className={`${container} pb-12`}>
        {pricing.isPending ? (
          // Prerendered for search engines and AI assistants: the api Worker fills in current prices.
          import.meta.env.SSR ? <LiveSlot name="prices" text={t('seo.prices.fallback')} link={{ href: '/pricing.md', label: 'nevazu.com/pricing.md' }} /> : <Skeleton className="h-72" />
        ) : pricing.isError || !regions.length ? (
          <Card className="p-6 text-sm text-muted">{t('pricing.unavailable')}</Card>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <RegionMenu groups={groups} value={region} onChange={setRegionId} />
                {premiumShown ? <TierSwitch value={tier} onChange={setTier} /> : null}
              </div>
              <p className="text-xs text-subtle">{t('pricing.regionHint')}</p>
            </div>
            {region ? <RegionCard region={region} tier={tier} /> : null}
          </>
        )}
      </section>

      {region?.rates && pricing.data ? (
        <section className={`${container} grid gap-4 pb-16`}>
          <Estimator region={region} />
          <UnitRates region={region} model={pricing.data.model} />
        </section>
      ) : null}

      <section className="border-y border-border bg-surface py-16">
        <div className={container}>
          <h2 className="text-[28px] leading-tight font-semibold tracking-[-0.03em] md:text-[40px]">{t('pricing.how')}</h2>
          <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {([1, 2, 3, 4] as const).map((n) => (
              <li key={n} className="border-t border-fg pt-5">
                <span className="font-mono text-sm font-medium text-subtle">{String(n).padStart(2, '0')}</span>
                <h3 className="mt-4 text-base font-semibold">{t(`pricing.how.${n}.title`)}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted">{t(`pricing.how.${n}.body`, { days: pricing.data?.retentionDays ?? 7 })}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8 flex flex-col gap-2 text-xs text-subtle">
            {pricing.data ? <p>{t('pricing.minBalance', { amount: m(pricing.data.minBalanceMicros) })}</p> : null}
            <p>{t('pricing.source')}</p>
            <Link to="/docs/billing" className="group inline-flex items-center gap-1 font-medium text-accent underline-offset-4 hover:underline">
              {t('pricing.more')} <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </section>

      {pricing.data && pricing.data.signupCreditMicros > 0 && !signedIn ? (
        <section className={`${container} pt-16`}>
          <Card className="flex flex-col gap-4 border-l-2 border-l-fg p-6 sm:flex-row sm:items-center sm:justify-between md:p-8">
            <div className="flex gap-3">
              <Gift className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div>
                <h2 className="font-semibold">{t('signup.creditTitle', { amount: m(pricing.data.signupCreditMicros) })}</h2>
                <p className="mt-1 text-sm text-muted">
                  {t('signup.creditBody')}
                </p>
              </div>
            </div>
            <Button variant="primary" onClick={() => navigate(signedIn ? '/browsers/new' : '/sign-up')}>
              {t('signup.createAccount')}
            </Button>
          </Card>
        </section>
      ) : null}

      <Faq />
    </>
  );
}

/** Basic or Premium: the machine the prices below are for. */
function TierSwitch({ value, onChange }: { value: BrowserTier; onChange: (tier: BrowserTier) => void }) {
  const { t } = useI18n();
  return (
    <div className="inline-flex border border-border" role="radiogroup" aria-label={t('create.machine')}>
      {(['basic', 'premium'] as const).map((tier) => (
        <button
          key={tier}
          type="button"
          role="radio"
          aria-checked={value === tier}
          className={cn('h-10 px-4 text-sm font-medium transition-colors', value === tier ? 'bg-fg text-bg' : 'text-muted hover:text-fg')}
          onClick={() => onChange(tier)}
        >
          {t(`tier.${tier}`)} <span className={cn('font-normal', value === tier ? 'text-bg/70' : 'text-subtle')}>· {t('pricing.spec', { vcpu: TIERS[tier].vcpu, memory: TIERS[tier].memoryGb })}</span>
        </button>
      ))}
    </div>
  );
}

function RegionCard({ region, tier }: { region: RegionPrice; tier: BrowserTier }) {
  const { t, locale } = useI18n();
  const m = (v: number) => money(v, locale);
  if (!region.rates) return <Card className="p-6 text-sm text-muted">{t(tier === 'premium' ? 'pricing.noPremium' : 'pricing.unavailable')}</Card>;
  const e = browserEstimate(region.rates, { storageGb: region.defaultStorageGb, rootVolumeGb: region.rootVolumeGb, backups: false });
  const cells = [
    { label: t('pricing.running'), hint: t('pricing.runningHint'), value: m(e.runningTotalHour), unit: t('pricing.unit.hour'), strong: true },
    { label: t('pricing.asleep'), hint: t('pricing.asleepHint'), value: m(e.alwaysOnHour), unit: t('pricing.unit.hour') },
    { label: t('pricing.transfer'), hint: t('pricing.transferHint'), value: m(region.rates.transfer), unit: t('pricing.unit.gb') },
  ];
  return (
    <Card className="relative overflow-hidden">
      <div className="grid grid-cols-2 md:grid-cols-[1.4fr_1fr_1fr]">
        {cells.map((c, n) => (
          <div key={c.label} className={cn('p-4 md:border-l md:p-8 md:first:border-l-0', n === 0 ? 'col-span-2 border-b md:col-span-1 md:border-b-0' : 'border-l first-of-type:border-l-0', n === 1 && 'border-l-0')}>
            <Eyebrow as="h2" className={cn(c.strong && 'text-fg')}>{c.label}</Eyebrow>
            <p className={cn('mt-3 font-semibold tracking-[-0.03em] tabular-nums md:mt-4', c.strong ? 'text-[40px] leading-none md:text-[56px]' : 'text-[22px] leading-none md:text-[28px]')}>
              {c.value} <span className="text-xs font-normal tracking-normal text-subtle md:text-sm">{c.unit}</span>
            </p>
            <Hint className={cn('mt-2 md:mt-3', !c.strong && 'hidden sm:block')}>{c.hint}</Hint>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface px-6 py-3 font-mono text-xs text-muted md:px-8">
        <span>{region.machine ? `${t('pricing.machine', { vcpu: region.machine.vcpu, memory: region.machine.memoryGb, gb: region.defaultStorageGb + region.rootVolumeGb })} · ${t('pricing.spec', { vcpu: TIERS[tier].vcpu, memory: TIERS[tier].memoryGb })}` : null}</span>
        {!region.acceptingNew ? <span className="font-medium text-starting">{t('pricing.notAccepting')}</span> : null}
      </div>
    </Card>
  );
}

/**
 * The published pricing model for the selected region: each unit's AWS list price (data sent
 * includes the TURN relay), the markup for that kind of cost, and the resulting price.
 */
function UnitRates({ region, model }: { region: RegionPrice; model: PublicPricing['model'] }) {
  const { t, locale } = useI18n();
  const r = region.rates!;
  const c = region.cost;
  const m = (v: number) => money(v, locale);
  const rows: [string, number | undefined, number, number, string][] = [
    [t('pricing.rate.compute'), c?.compute, model.computeMarkupPercent, r.compute, t('pricing.unit.hour')],
    [t('pricing.rate.ip'), c?.ip, model.fixedMarkupPercent, r.ip, t('pricing.unit.hour')],
    [t('pricing.rate.storage'), c?.storage, model.fixedMarkupPercent, r.storage, t('pricing.unit.gbMonth')],
    [t('pricing.rate.transfer'), c?.transfer, model.transferMarkupPercent, r.transfer, t('pricing.unit.gb')],
  ];
  return (
    <Card className="min-w-0 p-5 md:p-6" data-testid="pricing-model">
      <h2 className="text-[15px] font-semibold tracking-tight">{t('pricing.model')}</h2>
      <p className="mt-1 text-sm text-muted">{t('pricing.modelIntro')}</p>
      <div className="mt-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] tracking-[0.1em] text-subtle uppercase">
              <th className="py-2.5 pr-3 font-semibold">{t('pricing.model.item')}</th>
              <th className="hidden py-2.5 pr-3 text-right font-semibold sm:table-cell">{t('pricing.model.cost')}</th>
              <th className="hidden py-2.5 pr-3 text-right font-semibold sm:table-cell">{t('pricing.model.markup')}</th>
              <th className="py-2.5 text-right font-semibold">{t('pricing.model.price')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(([label, cost, markup, price, unit]) => (
              <tr key={label}>
                <td className="py-2.5 pr-3 text-muted">{label}</td>
                <td className="hidden py-2.5 pr-3 text-right tabular-nums sm:table-cell">{cost === undefined ? '—' : m(cost)}</td>
                <td className="hidden py-2.5 pr-3 text-right tabular-nums sm:table-cell">× {(markup / 100).toFixed(2)}</td>
                <td className="py-2.5 text-right font-medium tabular-nums">
                  {m(price)} <span className="text-xs font-normal text-subtle">{unit}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-4 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-muted">
        <li>{t('pricing.model.relay', { relay: m(model.relayGbMicros) })}</li>
        <li>{model.billTransitions ? t('pricing.model.transitionsOn') : t('pricing.model.transitionsOff')}</li>
        <li>{t('pricing.model.fees')}</li>
      </ul>
    </Card>
  );
}

/**
 * The region list as a dropdown, grouped by continent with each running price. Regions that
 * cannot take a browser (closed, out of stock, unpriced) are grayed out and cannot be chosen.
 */
function RegionMenu({ groups, value, onChange }: { groups: (readonly [string | null, RegionPrice[]])[]; value?: RegionPrice; onChange: (id: RegionId) => void }) {
  const { t, locale } = useI18n();
  const hourly = (r: RegionPrice) => (r.rates ? t('price.perHour', { amount: money(browserEstimate(r.rates, { storageGb: r.defaultStorageGb, rootVolumeGb: r.rootVolumeGb, backups: false }).runningTotalHour, locale) }) : null);
  return (
    <div className="w-full max-w-md">
      <p className="mb-1.5 text-[13px] font-medium">{t('pricing.region')}</p>
      <Menu
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)] max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))]"
        trigger={
          <button type="button" className="flex h-12 w-full items-center gap-3 border border-border-strong bg-bg px-3 text-left transition-colors hover:border-fg/40 focus-visible:border-fg data-[state=open]:border-fg">
            {value ? (
              <>
                <CountryTag code={value.country} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{regionPlace(value, locale)}</span>
                <span className="shrink-0 text-xs text-muted tabular-nums">{hourly(value)}</span>
              </>
            ) : (
              <span className="flex flex-1 items-center gap-2 text-sm text-subtle"><MapPin className="size-4" /> {t('pricing.choose')}</span>
            )}
            <ChevronsUpDown className="size-4 shrink-0 text-subtle" aria-hidden />
          </button>
        }
      >
        {groups.map(([area, list]) => (
          <div key={area ?? 'other'}>
            <MenuLabel>{area ? t(`area.${area}` as MessageKey) : t('area.other')}</MenuLabel>
            {list.map((r) => {
              const ok = supported(r);
              return (
                <MenuItem key={r.regionId} disabled={!ok} onSelect={() => onChange(r.regionId)}>
                  <span className={cn('w-7 shrink-0 font-mono text-[11px] font-medium', ok ? 'text-muted' : 'text-subtle')}>{r.country}</span>
                  <span className={cn('min-w-0 flex-1 truncate', !ok && 'text-subtle')}>{regionPlace(r, locale)}</span>
                  <span className="shrink-0 text-xs text-muted tabular-nums">{ok ? hourly(r) : t('pricing.regionUnsupported')}</span>
                  {value?.regionId === r.regionId ? <Check className="text-fg" aria-hidden /> : <span className="w-4" />}
                </MenuItem>
              );
            })}
          </div>
        ))}
      </Menu>
    </div>
  );
}

const PRESETS = [
  { key: 'light', hours: 1, days: 20 },
  { key: 'daily', hours: 3, days: 30 },
  { key: 'work', hours: 8, days: 22 },
  { key: 'always', hours: 24, days: 30 },
] as const;

/**
 * What a month would cost: pick a usage pattern (or tune hours, days, browsers and how much of
 * the time the live view is watched) and the total, its parts and the per-day figure follow.
 */
function Estimator({ region }: { region: RegionPrice }) {
  const { t, locale } = useI18n();
  const [hours, setHours] = useState(3);
  const [days, setDays] = useState(30);
  const [count, setCount] = useState(1);
  const [watching, setWatching] = useState(50);
  const m = (v: number) => money(v, locale);
  const e = browserEstimate(region.rates!, { storageGb: region.defaultStorageGb, rootVolumeGb: region.rootVolumeGb, backups: false });
  const running = e.runningHour * hours * days * count;
  const kept = e.alwaysOnMonth * count;
  const transfer = region.rates!.transfer * GB_PER_HOUR * (watching / 100) * hours * days * count;
  const total = running + kept + transfer;
  const parts = [
    { key: 'running', label: t('pricing.part.running'), value: running, color: 'bg-chart-1' },
    { key: 'kept', label: t('pricing.part.kept'), value: kept, color: 'bg-chart-2' },
    { key: 'transfer', label: t('pricing.part.transfer'), value: transfer, color: 'bg-chart-3' },
  ];
  const preset = PRESETS.find((p) => p.hours === hours && p.days === days)?.key ?? null;

  return (
    <Card className="overflow-hidden" data-testid="pricing-estimator">
      <div className="grid lg:grid-cols-[1.25fr_1fr]">
        <div className="p-5 md:p-8">
          <h2 className="text-lg font-semibold tracking-tight md:text-xl">{t('pricing.estimate')}</h2>
          <p className="mt-1 text-sm text-muted">{t('pricing.estimateIntro')}</p>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label={t('pricing.estimate')}>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={preset === p.key}
                onClick={() => { setHours(p.hours); setDays(p.days); }}
                className={cn(
                  'border px-3 py-2.5 text-left transition-colors duration-150',
                  preset === p.key ? 'border-fg bg-fg text-bg' : 'border-border hover:border-border-strong hover:bg-surface',
                )}
              >
                <span className="block text-sm font-semibold">{t(`pricing.preset.${p.key}`)}</span>
                <span className={cn('block text-[11px] tabular-nums', preset === p.key ? 'text-bg/70' : 'text-subtle')}>{t('pricing.presetHint', { hours: p.hours, days: p.days })}</span>
              </button>
            ))}
          </div>
          <div className="mt-6 space-y-5">
            <Slider label={t('pricing.hoursPerDay')} value={hours} min={1} max={24} onChange={setHours} display={t('pricing.hoursValue', { n: hours })} />
            <Slider label={t('pricing.daysPerMonth')} value={days} min={1} max={30} onChange={setDays} display={t('pricing.daysValue', { n: days })} />
            <Slider label={t('pricing.watching')} value={watching} min={0} max={100} step={10} onChange={setWatching} display={t('pricing.watchingValue', { n: watching })} />
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted">{t('pricing.browsers')}</span>
              <div className="flex items-center border border-border-strong">
                <button type="button" className="grid size-9 place-items-center text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40" disabled={count <= 1} onClick={() => setCount((c) => Math.max(1, c - 1))} aria-label="−">
                  <Minus className="size-4" />
                </button>
                <span className="w-10 text-center font-mono text-sm font-medium tabular-nums" aria-live="polite">{count}</span>
                <button type="button" className="grid size-9 place-items-center text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40" disabled={count >= 20} onClick={() => setCount((c) => Math.min(20, c + 1))} aria-label="+">
                  <Plus className="size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="relative flex flex-col justify-between gap-6 overflow-hidden border-t border-border bg-surface p-5 md:p-8 lg:border-t-0 lg:border-l">
          <div className="relative">
            <Eyebrow>{t('pricing.perMonth')}</Eyebrow>
            <p className="mt-3 text-[44px] font-semibold leading-none tracking-[-0.03em] tabular-nums md:text-[56px]" aria-live="polite">{m(total)}</p>
            <p className="mt-2 text-sm text-muted tabular-nums">
              {t('pricing.perDay', { amount: m(days ? total / days : 0) })}
              {count > 1 ? <> · {t('pricing.perBrowser', { amount: m(total / count) })}</> : null}
            </p>
          </div>
          <div className="relative">
            <div className="flex h-2 w-full gap-px overflow-hidden bg-surface-2" aria-hidden>
              {parts.map((p) => (
                <span key={p.key} className={cn('h-full transition-[width] duration-300 ease-out', p.color)} style={{ width: `${total ? (p.value / total) * 100 : 0}%` }} />
              ))}
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              {parts.map((p) => (
                <div key={p.key} className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-2 text-muted">
                    <span className={cn('size-2', p.color)} aria-hidden /> {p.label}
                  </dt>
                  <dd className="font-medium tabular-nums">{m(p.value)}</dd>
                </div>
              ))}
            </dl>
            <Hint className="mt-4">{t('pricing.estimateNote')}</Hint>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, display }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; display: ReactNode }) {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm text-muted">{label}</label>
        <span className="font-mono text-sm font-medium tabular-nums">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(ev) => onChange(Number(ev.target.value))}
        className="cb-range mt-2 w-full"
        style={{ '--cb-range': `${pct}%` } as React.CSSProperties}
      />
    </div>
  );
}

function Faq() {
  const { t } = useI18n();
  return (
    <section className={`${container} py-16`}>
      <h2 className="text-[22px] font-semibold tracking-[-0.02em] md:text-[28px]">{t('pricing.faq')}</h2>
      <div className="mt-6 divide-y divide-border border border-border">
        {([1, 2, 3, 4, 5] as const).map((n) => (
          <details key={n} className="group px-5 py-4 transition-colors open:bg-surface md:px-6">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-1 font-medium [&::-webkit-details-marker]:hidden">
              {t(`pricing.faq.${n}.q`)}
              <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {t(`pricing.faq.${n}.a`)}
              {n === 4 ? (
                <>
                  {' '}
                  <Link to="/refunds" className="text-accent underline-offset-4 hover:underline">
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
