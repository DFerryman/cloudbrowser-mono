import { BrowserLocale, CreateInstanceBody, DEFAULT_REGION, HOURS_PER_MONTH, SCREEN_SIZES, browserEstimate, type Region } from '@cloudbrowser/contracts';
import { Button, cn, Dialog, Input, Label, Select } from '@cloudbrowser/ui';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useI18n, type Locale } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { useBilling, usePricing } from '../billing/hooks.js';
import { PriceBreakdown } from '../billing/PriceBreakdown.js';
import { useCreateInstance, useInstances, useMe, useRegions } from './hooks.js';

const UI_TO_BROWSER_LOCALE: Record<Locale, BrowserLocale> = { en: 'en-US', 'zh-CN': 'zh-CN' };

/** Measures latency from the user's own network as a hint; the region is never picked for them. */
function useLatency(regions: Region[] | undefined) {
  const [ms, setMs] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!regions) return;
    let cancelled = false;
    for (const r of regions) {
      if (!r.probeUrl) continue;
      const url = r.probeUrl;
      void (async () => {
        const samples: number[] = [];
        for (let n = 0; n < 3; n++) {
          const start = performance.now();
          try {
            await fetch(url, { mode: 'no-cors', cache: 'no-store' });
            samples.push(performance.now() - start);
          } catch {
            return;
          }
        }
        if (!cancelled) setMs((m) => ({ ...m, [r.id]: Math.round(Math.min(...samples)) }));
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [regions]);
  return ms;
}

export function CreateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (instanceId: string) => void }) {
  const { t, locale, errorMessage } = useI18n();
  const regions = useRegions();
  const instances = useInstances();
  const me = useMe();
  const create = useCreateInstance();
  const pricing = usePricing();
  const billing = useBilling();
  const latency = useLatency(regions.data);

  const [name, setName] = useState('');
  const [regionId, setRegionId] = useState<Region['id']>(DEFAULT_REGION);
  const [browserLocale, setBrowserLocale] = useState<BrowserLocale>(UI_TO_BROWSER_LOCALE[locale]);
  const [screen, setScreen] = useState<(typeof SCREEN_SIZES)[number]>('auto');
  const [advanced, setAdvanced] = useState(false);
  const [useTrial, setUseTrial] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(`Browser ${(instances.data?.length ?? 0) + 1}`);
      setError(null);
    }
  }, [open, instances.data?.length]);
  // Never preselect a region that cannot take new browsers.
  useEffect(() => {
    const list = regions.data;
    if (list && !list.find((r) => r.id === regionId)?.acceptingNew) {
      const first = list.find((r) => r.acceptingNew);
      if (first) setRegionId(first.id);
    }
  }, [regions.data, regionId]);

  const atLimit = me.data ? me.data.usage.browsers >= me.data.entitlements.maxBrowsers : false;
  // The price of the chosen region is shown before creating, and sent back so it cannot change unseen.
  const price = pricing.data?.find((p) => p.regionId === regionId);
  const b = billing.data;
  const rateOf = (id: string) => pricing.data?.find((p) => p.regionId === id)?.rates?.compute ?? null;
  const prepaid = b?.mode === 'prepaid';
  const balanceTooLow = prepaid && b ? b.balanceMicros < b.minBalanceMicros : false;
  // The one free trial (page 6): offered once, in its own region, while that region takes new browsers.
  const trialOffer = !!b?.trial.eligible && !!regions.data?.find((r) => r.id === b.trial.regionId)?.acceptingNew;
  const trial = trialOffer && useTrial;
  const needsCredit = balanceTooLow && !trial;
  useEffect(() => {
    if (open) setUseTrial(trialOffer && balanceTooLow);
  }, [open, trialOffer, balanceTooLow]);
  useEffect(() => {
    if (trial && b) setRegionId(b.trial.regionId);
  }, [trial, b]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = CreateInstanceBody.safeParse({ name, regionId, locale: browserLocale, screen, priceVersion: price?.version ?? undefined, ...(trial ? { trial: true } : {}) });
    if (!parsed.success) {
      setError(t('error.validation_failed'));
      return;
    }
    try {
      const res = await create.mutateAsync(parsed.data);
      onCreated(res.instanceId);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('create.title')} closeLabel={t('common.cancel')} size="lg">
      <form onSubmit={submit} className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="space-y-5">
        <div>
          <Label htmlFor="name">{t('create.name')}</Label>
          <Input id="name" value={name} maxLength={64} required onChange={(e) => setName(e.target.value)} />
        </div>

        {trialOffer && b ? (
          <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border border-accent/50 bg-accent/5 p-3">
            <input type="checkbox" className="mt-1 size-4 accent-[var(--color-accent)]" checked={useTrial} onChange={(e) => setUseTrial(e.target.checked)} />
            <span>
              <span className="block text-sm font-medium">{t('trial.option')}</span>
              <span className="block text-xs text-muted">
                {t('trial.optionHint', { minutes: b.trial.minutes, region: t(`create.region.${b.trial.regionId}`), gb: b.trial.storageGb })}
              </span>
            </span>
          </label>
        ) : null}

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{t('create.region')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(regions.data ?? []).map((r) => {
              const trialOnly = r.acceptingNew && trial && r.id !== b?.trial.regionId;
              const disabled = !r.acceptingNew || trialOnly;
              return (
                <label
                  key={r.id}
                  className={cn(
                    'flex cursor-pointer flex-col rounded-[var(--radius-control)] border p-3 transition-colors',
                    regionId === r.id ? 'border-accent ring-1 ring-accent' : 'border-border hover:bg-surface',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name="region"
                    value={r.id}
                    className="sr-only"
                    checked={regionId === r.id}
                    disabled={disabled}
                    onChange={() => setRegionId(r.id)}
                  />
                  <span className="flex items-center justify-between font-medium">
                    {t(`create.region.${r.id}`)}
                    {latency[r.id] !== undefined ? <span className="font-mono text-xs text-muted">{latency[r.id]} ms</span> : null}
                  </span>
                  <span className="text-xs text-muted">{trialOnly && b
                      ? t('trial.regionOnly', { region: t(`create.region.${b.trial.regionId}`) })
                      : disabled
                        ? t('create.region.unavailable')
                        : t(`create.region.${r.id}.hint`)}</span>
                  {!disabled && rateOf(r.id) !== null ? (
                    <span className="mt-1 text-xs font-medium tabular-nums">{t('price.perHour', { amount: money(rateOf(r.id)!, locale) })}</span>
                  ) : null}
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">{t('create.note')}</p>
        </fieldset>

        <div>
          <button type="button" className="flex items-center gap-1 text-sm font-medium" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
            <ChevronRight className={cn('size-4 transition-transform', advanced && 'rotate-90')} />
            {t('create.advanced')}
          </button>
          {advanced ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="locale">{t('create.language')}</Label>
                <Select id="locale" value={browserLocale} onChange={(e) => setBrowserLocale(e.target.value as BrowserLocale)}>
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English (US)</option>
                  <option value="ja-JP">日本語</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="screen">{t('create.screen')}</Label>
                <Select id="screen" value={screen} onChange={(e) => setScreen(e.target.value as typeof screen)}>
                  {SCREEN_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s === 'auto' ? t('create.screen.auto') : s.replace('x', ' × ')}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ) : null}
        </div>

        </div>

        <aside className="space-y-3 rounded-[var(--radius-card)] border border-border bg-surface p-4 md:row-span-2">
          <h3 className="text-sm font-semibold">{t('create.priceTitle', { region: t(`create.region.${regionId}`) })}</h3>
          {trial && b && price?.rates ? (
            <TrialPrice minutes={b.trial.minutes} days={b.trial.keptDays} gb={b.trial.storageGb} pricing={price} />
          ) : price ? (
            <PriceBreakdown pricing={price} pilot={b?.mode === 'pilot'} />
          ) : (
            <p className="text-sm text-muted">{t('common.loading')}</p>
          )}
          {trial ? null : <p className="text-xs text-muted">{t('create.chargesStart')}</p>}
          {prepaid && b && !trial ? (
            <p className="border-t border-border pt-3 text-sm">
              {t('create.balance', { amount: money(b.balanceMicros, locale) })}{' '}
              {needsCredit ? (
                <>
                  <span className="text-error">{t('create.needCredit', { amount: money(b.minBalanceMicros, locale) })}</span>{' '}
                  <Link to="/billing" className="font-medium text-accent hover:underline">
                    {t('create.addCredit')}
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
        </aside>

        <div className="space-y-3">
          {atLimit && me.data ? <p className="text-sm text-muted">{t('create.atLimit', { max: me.data.entitlements.maxBrowsers })}</p> : null}
          {error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={create.isPending || atLimit || needsCredit || !price?.available}>
              {t('create.submit')}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

/** What the free trial costs (nothing), what happens to it, and what it costs once the user keeps it. */
function TrialPrice({ minutes, days, gb, pricing }: { minutes: number; days: number; gb: number; pricing: NonNullable<ReturnType<typeof usePricing>['data']>[number] }) {
  const { t, locale } = useI18n();
  const e = browserEstimate(pricing.rates!, { storageGb: gb, rootVolumeGb: pricing.rootVolumeGb, backups: false });
  return (
    <div className="space-y-3 text-sm">
      <p className="text-2xl font-semibold text-running">{t('trial.free')}</p>
      {pricing.machine ? <p className="text-xs text-muted">{t('price.machineShort', { vcpu: pricing.machine.vcpu, memory: pricing.machine.memoryGb })}</p> : null}
      <p>{t('trial.how', { minutes, days })}</p>
      <p className="text-muted">
        {t('trial.after', {
          running: money(e.runningHour, locale),
          kept: money(e.alwaysOnMonth, locale),
          gb: gb + pricing.rootVolumeGb,
        })}
      </p>
      <p className="text-xs text-muted">
        {t('price.ip')}: {t('price.perMonth', { amount: money(pricing.rates!.ip * HOURS_PER_MONTH, locale) })} · {t('billing.item.storage')}:{' '}
        {t('price.perMonth', { amount: money(e.storageMonth, locale) })}
      </p>
    </div>
  );
}
