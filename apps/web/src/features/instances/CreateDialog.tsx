import { CreateInstanceBody, DEFAULT_REGION, TIERS, browserEstimate, retentionReserve, type BrowserTier, type Instance, type Region, type RegionPricing } from '@cloudbrowser/contracts';
import { Button, cn, Hint, Input, Label, SidePanel } from '@cloudbrowser/ui';
import { DocsLink } from '../../app/DocsLink.js';
import { AlertCircle, Bot, ChevronDown, ChevronRight, Gauge, Monitor } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { useBilling, usePricing } from '../billing/hooks.js';
import { PriceBreakdown, PriceSource } from '../billing/PriceBreakdown.js';
import { RateRow } from '../billing/RateRow.js';
import { canSpend, minimumSpendBalance } from '../billing/access.js';
import { useCreateInstance, useInstances, useMe, useRegions } from './hooks.js';
import { RegionPicker } from './RegionPicker.js';
import { regionPlace } from './region-names.js';
import { pricingForTier, regionForTier } from './tiers.js';



/**
 * Creating a browser (page 1): what it is called, where it lives (permanently) and what it costs,
 * read top to bottom. The price the user saw is sent back with the request, so it cannot change
 * unseen.
 * Where the operator offers Premium, the machine is chosen first: regions and prices then show
 * that tier's availability and cost.
 */
export function CreateDialog({ open, initialInstance, onClose, onCreated }: { open: boolean; initialInstance?: Instance; onClose: () => void; onCreated: (instanceId: string) => void }) {
  const { t, locale, errorMessage } = useI18n();
  const formId = useId();
  const regions = useRegions();
  const instances = useInstances();
  const me = useMe();
  const create = useCreateInstance();
  const pricing = usePricing();
  const billing = useBilling();

  const [name, setName] = useState('');
  const [regionId, setRegionId] = useState<Region['id']>(DEFAULT_REGION);
  const [tier, setTier] = useState<BrowserTier>('basic');
  // Coding agents may connect unless unticked here (docs/agent-access.md); changeable in Settings later.
  const [agentAccess, setAgentAccess] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The cost stays folded away so the panel reads cleanly; one click shows the whole estimate.
  const [costOpen, setCostOpen] = useState(false);

  /** The user typed a name since the dialog opened: the default no longer replaces it. */
  const nameEdited = useRef(false);

  useEffect(() => {
    if (open) {
      setCostOpen(false);
      nameEdited.current = false;
      setName(initialInstance?.name ?? `Browser ${(instances.data?.length ?? 0) + 1}`);
      if (initialInstance) setRegionId(initialInstance.regionId);
      setTier(initialInstance?.tier ?? 'basic');
      setAgentAccess(initialInstance?.agentAccess ?? true);
      setError(null);
    }
  }, [open, initialInstance?.id]);

  // Closing the dialog ends the creation attempt; what is submitted after reopening is a new one.
  useEffect(() => {
    if (!open) create.newAttempt();
  }, [open]);

  // Opened before the browsers loaded (a visit straight to /browsers/new), the default was
  // "Browser 1" whatever the count: number it again once they have, unless the user typed a name.
  useEffect(() => {
    if (open && !initialInstance && !nameEdited.current && instances.data) setName(`Browser ${instances.data.length + 1}`);
  }, [open, instances.data?.length]);

  const b = billing.data;
  const atLimit = me.data ? me.data.usage.browsers >= me.data.entitlements.maxBrowsers : false;
  const premiumOffer = !!me.data?.entitlements.premium;
  const machine: BrowserTier = premiumOffer ? tier : 'basic';
  const tierRegions = useMemo(() => regions.data?.map((r) => regionForTier(r, machine)), [regions.data, machine]);
  const tierPricing = useMemo(() => pricing.data?.map((p) => pricingForTier(p, machine)), [pricing.data, machine]);
  const storageFor = (p: RegionPricing) => p.defaultStorageGb;
  const price = tierPricing?.find((p) => p.regionId === regionId);
  const reserve = price?.rates ? retentionReserve(price.rates, { storageGb: price.defaultStorageGb, rootVolumeGb: price.rootVolumeGb, backups: false }) : 0;
  const balanceTooLow = !!b && !canSpend(b, reserve);
  const needsCredit = balanceTooLow;

  // Never preselect a region that cannot take new browsers (of the chosen machine).
  useEffect(() => {
    const list = tierRegions;
    if (list && !list.find((r) => r.id === regionId)?.acceptingNew) {
      const first = list.find((r) => r.acceptingNew);
      if (first) setRegionId(first.id);
    }
  }, [tierRegions, regionId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = CreateInstanceBody.safeParse({ name, regionId, priceVersion: price?.version ?? undefined, storageGb: price?.defaultStorageGb, agentAccess, ...(machine === 'premium' ? { tier: machine } : {}) });
    if (!parsed.success) {
      setError(t('error.validation_failed'));
      return;
    }
    setError(null);
    try {
      const res = await create.mutateAsync(parsed.data);
      onCreated(res.instanceId);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const regionAvailable = tierRegions?.find((r) => r.id === regionId)?.acceptingNew === true;
  const blocked = create.isPending || pricing.isFetching || pricing.isError || regions.isError || !regionAvailable || !b || b.frozen || atLimit || needsCredit || !price?.available || !price.version;
  const notice = error
    ?? (atLimit && me.data ? t('create.atLimit', { max: me.data.entitlements.maxBrowsers }) : null)
    ?? (b?.frozen ? t('billing.frozen') : null)
    ?? (regions.isError ? t('create.regionsFailed') : tierRegions && !regionAvailable
      ? t(tierRegions.some((r) => r.acceptingNew) ? 'create.regionUnavailable' : machine === 'premium' ? 'create.premiumNowhere' : 'create.noInventory') : null);

  return (
    <SidePanel
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('create.title')}
      description={t('create.subtitle')}
      storageKey="nevazu.create.width"
      minWidth={460}
      maxWidth={1040}
      defaultWidth={640}
      resizeLabel={t('create.resize')}
      closeLabel={t('common.cancel')}
      footer={
        <div className="space-y-3">
          {notice ? (
            <p role="alert" className="flex gap-2 text-sm text-error">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {notice}
            </p>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CreateSummary pricing={price} needsCredit={needsCredit} needed={b ? minimumSpendBalance(b) + reserve : 0} />
            <div className="flex gap-2 sm:shrink-0">
              <Button className="flex-1 justify-center sm:flex-none" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" form={formId} variant="primary" className="flex-1 justify-center sm:flex-none" disabled={blocked}>
                {create.isPending ? t('create.creating') : t('create.submit')}
              </Button>
            </div>
          </div>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-6">
        <div>
          <Label htmlFor="name">{t('create.name')}</Label>
          <Input id="name" value={name} maxLength={64} required onChange={(e) => {
            nameEdited.current = true;
            setName(e.target.value);
          }} />
        </div>

        {premiumOffer ? (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t('create.machine')}</legend>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
              <Choice name="machine" checked={machine === 'basic'} onChange={() => setTier('basic')} icon={<Monitor className="size-4" />}
                title={t('tier.basic')}
                hint={t('create.machine.hint', { vcpu: TIERS.basic.vcpu, memory: TIERS.basic.memoryGb })} />
              <Choice name="machine" checked={machine === 'premium'} onChange={() => setTier('premium')} icon={<Gauge className="size-4" />}
                title={t('tier.premium')}
                hint={`${t('create.machine.hint', { vcpu: TIERS.premium.vcpu, memory: TIERS.premium.memoryGb })} ${t('create.machine.premiumHint')}`} />
            </div>
            {machine === 'premium' ? <Hint className="mt-2">{t('create.machine.premiumNote')} <DocsLink to="browsers#premium" newTab /></Hint> : null}
          </fieldset>
        ) : null}

        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('create.region')}</legend>
          <RegionPicker
            open={open}
            regions={tierRegions}
            loading={regions.isPending}
            pricing={tierPricing}
            value={regionId}
            onChange={setRegionId}
            storageFor={storageFor}
            reasonFor={machine === 'premium' ? (r) => (r.premium ? null : t('create.region.noPremium')) : undefined}
          />
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('create.agents')}</legend>
          <label className="flex cursor-pointer gap-3 border border-border p-3 transition-colors hover:border-border-strong has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-fg)]" checked={agentAccess} onChange={(e) => setAgentAccess(e.target.checked)} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium"><Bot className="size-4 text-muted" aria-hidden /> {t('create.agentAccess')}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-subtle">{t('create.agentAccess.hint')} <DocsLink to="coding-agents" newTab /></span>
            </span>
          </label>
        </fieldset>

        <section aria-labelledby={`${formId}-cost`} className="border border-border">
          <button
            type="button"
            className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface"
            aria-expanded={costOpen}
            aria-controls={`${formId}-cost-body`}
            onClick={() => setCostOpen((o) => !o)}
          >
            <span className="min-w-0 flex-1">
              <span id={`${formId}-cost`} className="block truncate text-sm font-semibold">
                {t('create.cost', { region: (() => { const r = regions.data?.find((x) => x.id === regionId); return r ? regionPlace(r, locale) : regionId; })() })}
              </span>
              <span className="block truncate text-xs text-muted tabular-nums">
                {price?.rates ? t('create.cost.summary', { amount: money(browserEstimate(price.rates, { storageGb: price.defaultStorageGb, rootVolumeGb: price.rootVolumeGb, backups: false }).runningTotalHour, locale) }) : pricing.isError ? t('price.unavailable') : t('common.loading')}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted transition-colors group-hover:text-fg">
              {costOpen ? t('create.cost.hide') : t('create.cost.show')}
              <ChevronDown className={cn('size-4 transition-transform duration-200', costOpen && 'rotate-180')} aria-hidden />
            </span>
          </button>
          {costOpen ? (
            <div id={`${formId}-cost-body`} className="border-t border-border bg-surface px-4 pb-4 pt-1 [animation:cb-in_150ms_var(--ease-out)]">
              {!price ? (
                <p className="mt-2 text-sm text-muted">{pricing.isError ? t('price.unavailable') : t('common.loading')}</p>
              ) : !price.rates ? (
                <p className="mt-2 text-sm text-muted">{t('price.unavailable')}</p>

              ) : (
                <PaidCost pricing={price} reserve={reserve} />
              )}
            </div>
          ) : null}
        </section>
      </form>
    </SidePanel>
  );
}

/** A large radio option: the plan. */
function Choice({ name, checked, onChange, icon, title, hint }: { name: string; checked: boolean; onChange: () => void; icon: ReactNode; title: string; hint: string }) {
  return (
    <label
      className={cn(
        'relative flex cursor-pointer gap-3 border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
        checked ? 'border-fg bg-surface shadow-[inset_0_0_0_1px_var(--color-fg)]' : 'border-border hover:border-border-strong',
      )}
    >
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} />
      <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center', checked ? 'bg-fg text-bg' : 'bg-surface-2 text-muted')} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-subtle">{hint}</span>
      </span>
    </label>
  );
}

/** The three numbers that matter, the deposit, and the full breakdown on request. */
function PaidCost({ pricing, reserve }: { pricing: RegionPricing; reserve: number }) {
  const { t, locale } = useI18n();
  const [details, setDetails] = useState(false);
  const m = (v: number) => money(v, locale);
  const e = browserEstimate(pricing.rates!, { storageGb: pricing.defaultStorageGb, rootVolumeGb: pricing.rootVolumeGb, backups: false });
  return (
    <div className="mt-2">
      <div className="divide-y divide-border">
        <RateRow strong label={t('create.cost.running')} hint={pricing.machine ? t('create.cost.runningHint', { vcpu: pricing.machine.vcpu, memory: pricing.machine.memoryGb }) : undefined} value={t('price.perHour', { amount: m(e.runningTotalHour) })} />
        <RateRow label={t('create.cost.asleep')} hint={t('create.cost.asleepHint', { gb: pricing.defaultStorageGb + pricing.rootVolumeGb })} value={t('price.perHour', { amount: m(e.alwaysOnHour) })} />
        <RateRow label={t('create.cost.transfer')} hint={t('create.cost.transferHint')} value={t('price.perGb', { amount: m(pricing.rates!.transfer) })} />
        <RateRow label={t('create.cost.held')} hint={t('create.cost.heldHint')} value={m(reserve)} />
      </div>
      <Hint className="mt-2">{t('create.chargesStart')}</Hint>
      <button type="button" className="mt-3 flex items-center gap-1 text-sm font-medium text-accent underline-offset-4 hover:underline" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
        <ChevronRight className={cn('size-4 transition-transform', details && 'rotate-90')} aria-hidden />
        {t('create.cost.details')}
      </button>
      {details ? (
        <div className="mt-3 border-t border-border pt-3">
          <PriceBreakdown pricing={pricing} />
        </div>
      ) : (
        <div className="mt-2">
          <PriceSource pricing={pricing} />
        </div>
      )}
    </div>
  );
}

/** Keep the selected region's monthly example visible beside the confirmation action. */
function CreateSummary({ pricing, needsCredit, needed }: { pricing?: RegionPricing; needsCredit: boolean; needed: number }) {
  const { t, locale } = useI18n();
  const { data: b } = useBilling();
  if (!b) return <span />;
  const estimate = pricing?.available && pricing.rates
    ? browserEstimate(pricing.rates, { storageGb: pricing.defaultStorageGb, rootVolumeGb: pricing.rootVolumeGb, backups: false }) : null;
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-sm font-medium tabular-nums">{estimate ? t('create.footer.monthly', { amount: money(estimate.runningHour * 2 * 30 + estimate.alwaysOnMonth, locale) }) : t('price.unavailable')}</p>
      {estimate ? <p className="hidden text-xs text-muted sm:block">{t('create.footer.monthlyHint')}</p> : null}
      {needsCredit && !b.frozen ? <p className="text-xs">
        <span className="text-error">{t('create.footer.need', { amount: money(needed, locale) })}</span>{' '}
        <Link to="/billing" className="font-medium whitespace-nowrap text-accent hover:underline">
          {t('create.addCredit')}
        </Link>
      </p> : null}
    </div>
  );
}
