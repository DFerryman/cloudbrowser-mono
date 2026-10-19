import { Button, Input, Label, useToast } from '@cloudbrowser/ui';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
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
  useEffect(() => {
    if (data.data && !draft) setDraft(data.data.settings);
  }, [data.data, draft]);
  if (!data.data || !draft) return <p className="text-sm text-muted">{t('common.loading')}</p>;
  const d = data.data;
  const mo = d.month;
  const marginPct = mo.revenueMicros > 0 ? Math.round((mo.grossMarginMicros / mo.revenueMicros) * 100) : null;
  const field = (key: keyof PricingOverview['settings'], label: AdminKey, scale = 1, step = '1') => (
    <div>
      <Label htmlFor={key}>{t(label)}</Label>
      <Input id={key} type="number" step={step} value={draft[key] / scale} onChange={(e) => setDraft({ ...draft, [key]: Math.round(Number(e.target.value) * scale) })} className="w-36" />
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
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirm(true);
          }}
        >
          {field('markupPercent', 'pricing.markup')}
          {field('minBalanceMicros', 'pricing.minBalance', 1_000_000, '0.01')}
          {field('lowBalanceMicros', 'pricing.lowBalance', 1_000_000, '0.01')}
          {field('paymentFeeBps', 'pricing.feePct', 100, '0.01')}
          {field('paymentFeeFixedCents', 'pricing.feeFixed', 100, '0.01')}
          <Button type="submit" variant="primary" disabled={save.isPending || JSON.stringify(draft) === JSON.stringify(d.settings)}>
            {t('common.save')}
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted">{t('pricing.settingsNote')}</p>
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
        description={t('pricing.confirmHelp', { from: d.settings.markupPercent, to: draft.markupPercent })}
        confirm={t('common.save')}
        busy={save.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={(reason) => save.mutate({ ...draft, reason }, { onSuccess: () => setConfirm(false), onError: (e) => toast(errorText(e), 'error') })}
      />
    </div>
  );
}
