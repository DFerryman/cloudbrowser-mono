import { Button, Input, Label, useToast } from '@cloudbrowser/ui';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { post, put, usd, useAdmin, useAdminAction, when, type PricingOverview } from './data.js';
import { useT, type AdminKey } from './i18n.js';
import { Mono, PageTitle, Pill, ReasonDialog, Table, Tile } from './ui.js';

const ITEMS: [keyof NonNullable<PricingOverview['regions'][number]['cost']>, AdminKey][] = [
  ['compute', 'item.compute'],
  ['ip', 'item.ip'],
  ['storage', 'item.storage'],
  ['transfer', 'item.transfer'],
];
/** Usage rows: every item, so they add up to the totals. Snapshots are internal recovery costs, never charged. */
const USAGE_ROWS: [string, AdminKey][] = [...ITEMS, ['snapshot', 'item.snapshot']];
type Settings = PricingOverview['settings'];
type NumericSetting = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
/** The settings in the order the form shows them; each has its own explanation. */
const FIELDS: { key: NumericSetting; label: AdminKey; help: AdminKey; scale?: number; step?: string }[] = [
  { key: 'markupPercent', label: 'pricing.markup', help: 'pricing.markupHelp' },
  { key: 'fixedMarkupPercent', label: 'pricing.fixedMarkup', help: 'pricing.fixedMarkupHelp' },
  { key: 'transferMarkupPercent', label: 'pricing.transferMarkup', help: 'pricing.transferMarkupHelp' },
  { key: 'relayGbMicros', label: 'pricing.relay', help: 'pricing.relayHelp', scale: 1_000_000, step: '0.001' },
  { key: 'paymentFeeBps', label: 'pricing.feePct', help: 'pricing.feePctHelp', scale: 100, step: '0.01' },
  { key: 'paymentFeeFixedCents', label: 'pricing.feeFixed', help: 'pricing.feeFixedHelp', scale: 100, step: '0.01' },
  { key: 'minBalanceMicros', label: 'pricing.minBalance', help: 'pricing.minBalanceHelp', scale: 1_000_000, step: '0.01' },
  { key: 'lowBalanceMicros', label: 'pricing.lowBalance', help: 'pricing.lowBalanceHelp', scale: 1_000_000, step: '0.01' },
];
/** neko's full-quality stream is about 2 Mbit/s, constant while a viewer is open. */
const DEFAULT_VIDEO_GB_HOUR = 0.9;
const HOURS_PER_MONTH = 730;
const minimumMarkup = (feeBps: number) => 100 + Math.ceil(feeBps / 100);

/**
 * One hour with the live view open, for a browser with the default 10 GB disk: AWS and relay cost,
 * the customer price, and what is left after the payment provider's percentage fee.
 */
function liveHour(r: PricingOverview['regions'][number], videoGb: number, s: Settings) {
  if (!r.cost || !r.price || !r.sheet) return null;
  const gbMonths = (10 + r.sheet.rootVolumeGb) / HOURS_PER_MONTH;
  const sum = (x: NonNullable<typeof r.cost>) => x.compute + x.ip + x.storage * gbMonths + x.transfer * videoGb;
  const cost = sum(r.cost);
  const price = sum(r.price);
  const net = price * (1 - s.paymentFeeBps / 10_000) - cost;
  return { cost, price, net, pct: price > 0 ? Math.round((net / price) * 100) : 0 };
}

/**
 * Prices and margin: AWS cost per region from the AWS Price List API, the customer price
 * (cost × markup), and this month's metered revenue against its AWS cost. Every change is audited.
 */
export function PricingPage() {
  const { t, errorText } = useT();
  const toast = useToast();
  const data = useAdmin<PricingOverview>('/pricing');
  const save = useAdminAction((v: PricingOverview['settings'] & { reason: string }) => put('/pricing/settings', v));
  const refresh = useAdminAction(() => post('/pricing/refresh'));
  const [draft, setDraft] = useState<PricingOverview['settings'] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [videoGb, setVideoGb] = useState(DEFAULT_VIDEO_GB_HOUR);
  useEffect(() => {
    if (data.data && !draft) setDraft(data.data.settings);
  }, [data.data, draft]);
  if (!data.data || !draft) return <p className="text-sm text-muted">{t('common.loading')}</p>;
  const d = data.data;
  const mo = d.month;
  const marginPct = mo.revenueMicros > 0 ? Math.round((mo.grossMarginMicros / mo.revenueMicros) * 100) : null;
  const floor = minimumMarkup(draft.paymentFeeBps);
  const row = (id: string, label: ReactNode, input: ReactNode, help: AdminKey, warn?: string | null) => (
    <div key={id} className="grid gap-1 border-b border-border py-3 last:border-0 sm:grid-cols-[220px_160px_1fr] sm:items-start sm:gap-4">
      <div className="pt-2"><Label htmlFor={id}>{label}</Label></div>
      {input}
      <div className="text-xs text-muted">
        <p>{t(help)}</p>
        {warn ? <p className="mt-1 text-error">{warn}</p> : null}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageTitle title={t('nav.pricing')}>
        <Button disabled={refresh.isPending} onClick={() => refresh.mutate(undefined, { onSuccess: () => toast(t('pricing.refreshed')), onError: (e) => toast(errorText(e), 'error') })}>
          <RefreshCw /> {t('pricing.refresh')}
        </Button>
      </PageTitle>

      <section>
        <h2 className="mb-2 text-sm font-medium">{t('pricing.month', { month: mo.month })}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label={t('pricing.charged')} value={usd(mo.revenueMicros)} />
          <Tile label={t('pricing.cost')} value={usd(mo.costMicros)} />
          <Tile label={`${t('pricing.margin')}${marginPct !== null ? ` (${marginPct}%)` : ''}`} value={usd(mo.grossMarginMicros)} tone={mo.grossMarginMicros < 0 ? 'bad' : undefined} />
          <Tile label={t('pricing.topups', { n: mo.topups })} value={usd(mo.topupMicros)} />
          <Tile label={t('pricing.fees')} value={usd(mo.estimatedFeesMicros)} />
          <Tile label={t('pricing.refunds')} value={usd(mo.refundMicros)} tone={mo.refundMicros > 0 ? 'warn' : undefined} />
          <Tile label={t('pricing.credits')} value={usd(mo.creditMicros)} />
        </div>
        <p className="mt-2 text-xs text-muted">{t('pricing.note', { total: usd(d.balances.totalMicros), negative: usd(d.balances.negativeMicros) })}</p>
        <Table
          rows={[
            ...USAGE_ROWS.map(([key, label]) => ({ key, label: t(label).replace(/[（(].*[)）]$/, '').trim(), ...(mo.byItem[key] ?? { revenueMicros: 0, costMicros: 0 }) })),
            { key: 'total', label: t('pricing.total'), revenueMicros: mo.revenueMicros, costMicros: mo.costMicros },
          ]}
          rowKey={(r) => r.key}
          columns={[t('col.item'), t('col.charged'), t('col.awsCost'), t('col.margin')]}
          cells={(r) => {
            const strong = (v: string) => (r.key === 'total' ? <span className="font-semibold">{v}</span> : v);
            return [strong(r.label), strong(usd(r.revenueMicros)), strong(usd(r.costMicros)), strong(usd(r.revenueMicros - r.costMicros))];
          }}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">{t('pricing.settings')}</h2>
        <form
          className="max-w-5xl rounded-[var(--radius-card)] border border-border px-4"
          data-testid="pricing-settings"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirm(true);
          }}
        >
          {FIELDS.map(({ key, label, help, scale = 1, step = '1' }) => row(
            key,
            t(label),
            <Input id={key} type="number" step={step} value={draft[key] / scale} onChange={(e) => setDraft({ ...draft, [key]: Math.round(Number(e.target.value) * scale) })} className="w-36" />,
            help,
            key.endsWith('arkupPercent') && draft[key] < floor ? t('pricing.belowFloor', { floor }) : null,
          ))}
          {row(
            'billTransitions',
            t('pricing.transitions'),
            <label className="flex items-center gap-2 pt-2 text-sm">
              <input id="billTransitions" type="checkbox" checked={draft.billTransitions} onChange={(e) => setDraft({ ...draft, billTransitions: e.target.checked })} />
              {draft.billTransitions ? t('pricing.on') : t('pricing.off')}
            </label>,
            'pricing.transitionsHelp',
          )}
          <div className="flex justify-end py-3">
            <Button type="submit" variant="primary" disabled={save.isPending || JSON.stringify(draft) === JSON.stringify(d.settings)}>
              {t('common.save')}
            </Button>
          </div>
        </form>
        <p className="mt-2 text-xs text-muted">{t('pricing.settingsNote')}</p>
      </section>

      <section data-testid="pricing-breakeven">
        <h2 className="mb-1 text-sm font-medium">{t('pricing.breakeven')}</h2>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <label htmlFor="video-gb">{t('pricing.videoGb')}</label>
          <Input id="video-gb" type="number" step="0.1" min={0} value={videoGb} onChange={(e) => setVideoGb(Math.max(0, Number(e.target.value)))} className="w-24" />
          <span>{t('pricing.breakevenHelp')}</span>
        </div>
        <Table
          rows={d.regions.filter((r) => r.cost && r.price)}
          rowKey={(r) => r.regionId}
          columns={[t('col.region'), t('pricing.hourCost'), t('pricing.hourPrice'), t('pricing.hourNet')]}
          cells={(r) => {
            // Saved prices, so this shows what users are charged now (the draft applies on save).
            const h = liveHour(r, videoGb, d.settings)!;
            return [
              <span>{r.name} <Mono>{r.providerRegion}</Mono></span>,
              <span className="tabular-nums">{usd(Math.round(h.cost))}</span>,
              <span className="tabular-nums">{usd(Math.round(h.price))}</span>,
              <span className={h.net < 0 ? 'tabular-nums font-medium text-error' : 'tabular-nums'}>{usd(Math.round(h.net))} ({h.pct}%)</span>,
            ];
          }}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">{t('pricing.perRegion')}</h2>
        <Table
          rows={d.regions}
          rowKey={(r) => r.regionId}
          columns={[t('col.region'), ...ITEMS.map(([, label]) => t(label)), t('col.pricesFrom')]}
          cells={(r) => [
            <span>
              {r.name} {r.enabled ? null : <Pill>{t('pricing.disabled')}</Pill>}
              <br />
              <Mono>
                {r.providerRegion}
                {r.sheet ? ` · ${r.sheet.instanceType}` : ''}
              </Mono>
            </span>,
            ...ITEMS.map(([key]) =>
              r.cost && r.price ? (
                <span className="tabular-nums whitespace-nowrap">
                  {usd(r.cost[key])} → <span className="font-medium">{usd(r.price[key])}</span>
                </span>
              ) : (
                <span className="text-muted">—</span>
              ),
            ),
            <span className="text-xs">
              {r.sheet ? r.sheet.source === 'simulated' ? <Pill>{t('pricing.simulated')}</Pill> : <Pill tone="ok">{t('pricing.priceList')}</Pill> : <Pill tone="bad">{t('pricing.noPrices')}</Pill>}
              <br />
              {when(r.fetchedAt)}
              {r.lastError ? <span className="block text-error">{when(r.lastErrorAt)}: {r.lastError}</span> : null}
            </span>,
          ]}
        />
        <p className="mt-2 text-xs text-muted">{t('pricing.regionNote')}</p>
      </section>

      <ReasonDialog
        open={confirm}
        title={t('pricing.confirmTitle')}
        description={t('pricing.confirmHelp', {
          changes: [...FIELDS.map(({ key, label, scale = 1 }) => [t(label), d.settings[key] / scale, draft[key] / scale] as const),
            [t('pricing.transitions'), d.settings.billTransitions ? t('pricing.on') : t('pricing.off'), draft.billTransitions ? t('pricing.on') : t('pricing.off')] as const]
            .filter(([, from, to]) => from !== to).map(([label, from, to]) => `${label}: ${from} → ${to}`).join('; '),
        })}
        confirm={t('common.save')}
        busy={save.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={(reason) => save.mutate({ ...draft, reason }, { onSuccess: () => setConfirm(false), onError: (e) => toast(errorText(e), 'error') })}
      />
    </div>
  );
}
