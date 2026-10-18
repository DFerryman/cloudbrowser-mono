import { Button, Input, Label, useToast } from '@cloudbrowser/ui';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { post, put, usd, useAdmin, useAdminAction, when, type PricingOverview } from './data.js';
import { Mono, PageTitle, Pill, ReasonDialog, Table, Tile } from './ui.js';

const ITEMS = [
  ['compute', 'Running (per hour)'],
  ['ip', 'Dedicated IP (per hour)'],
  ['storage', 'Storage (per GB-month)'],
  ['snapshot', 'Snapshots (per GB-month)'],
  ['transfer', 'Data out (per GB)'],
] as const;

/**
 * Prices and margin (page 6): AWS cost per region from the AWS Price List API, the customer price
 * (cost × markup), and this month's metered revenue against its AWS cost. Every change is audited.
 */
export function PricingPage() {
  const toast = useToast();
  const data = useAdmin<PricingOverview>('/pricing');
  const save = useAdminAction((v: PricingOverview['settings'] & { reason: string }) => put('/pricing/settings', v));
  const refresh = useAdminAction(() => post('/pricing/refresh'));
  const [draft, setDraft] = useState<PricingOverview['settings'] | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (data.data && !draft) setDraft(data.data.settings);
  }, [data.data, draft]);
  if (!data.data || !draft) return <p className="text-sm text-muted">Loading…</p>;
  const d = data.data;
  const mo = d.month;
  const marginPct = mo.revenueMicros > 0 ? Math.round((mo.grossMarginMicros / mo.revenueMicros) * 100) : null;
  const field = (key: keyof PricingOverview['settings'], label: string, scale = 1, step = '1') => (
    <div>
      <Label htmlFor={key}>{label}</Label>
      <Input
        id={key}
        type="number"
        step={step}
        value={draft[key] / scale}
        onChange={(e) => setDraft({ ...draft, [key]: Math.round(Number(e.target.value) * scale) })}
        className="w-36"
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <PageTitle title="Pricing & margin">
        <Button disabled={refresh.isPending} onClick={() => refresh.mutate(undefined, { onSuccess: () => toast('Prices refreshed from AWS'), onError: (e) => toast((e as Error).message, 'error') })}>
          <RefreshCw /> Refresh prices now
        </Button>
      </PageTitle>

      <section>
        <h2 className="mb-2 text-sm font-medium">This month ({mo.month}), metered usage</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Charged to customers" value={usd(mo.revenueMicros)} />
          <Tile label="AWS cost of that usage" value={usd(mo.costMicros)} />
          <Tile label={`Gross margin${marginPct !== null ? ` (${marginPct}%)` : ''}`} value={usd(mo.grossMarginMicros)} tone={mo.grossMarginMicros < 0 ? 'bad' : undefined} />
          <Tile label="Top-ups received" value={`${usd(mo.topupMicros)} · ${mo.topups}`} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Est. payment fees" value={usd(mo.estimatedFeesMicros)} />
          <Tile label="Refunds and disputes" value={usd(mo.refundMicros)} tone={mo.refundMicros > 0 ? 'warn' : undefined} />
          <Tile label="Credits granted" value={usd(mo.creditMicros)} />
          <Tile label="AWS projected (all resources)" value={mo.projectedAwsCents !== null ? `$${(mo.projectedAwsCents / 100).toFixed(2)}` : '—'} />
        </div>
        <p className="mt-2 text-xs text-muted">
          Metered cost covers what customers are charged for. AWS projected (from the reconciler) also includes what nobody is charged for: browsers being created,
          deleted browsers during their 7-day recovery, old IPs kept 30 days after a change, and recover snapshots. Outstanding balances: {usd(d.balances.totalMicros)} (of which{' '}
          {usd(d.balances.negativeMicros)} below zero).
        </p>
        <Table
          rows={ITEMS.map(([key, label]) => ({ key, label, ...(mo.byItem[key] ?? { revenueMicros: 0, costMicros: 0 }) }))}
          rowKey={(r) => r.key}
          columns={['Item', 'Charged', 'AWS cost', 'Margin']}
          cells={(r) => [r.label.replace(/ \(.*\)/, ''), usd(r.revenueMicros), usd(r.costMicros), usd(r.revenueMicros - r.costMicros)]}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Customer price settings</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirm(true);
          }}
        >
          {field('markupPercent', 'Markup (% of AWS cost)')}
          {field('minBalanceMicros', 'Min. balance to create/wake ($)', 1_000_000, '0.01')}
          {field('lowBalanceMicros', 'Low-balance warning ($)', 1_000_000, '0.01')}
          {field('paymentFeeBps', 'Payment fee (%)', 100, '0.01')}
          {field('paymentFeeFixedCents', 'Payment fee per top-up ($)', 100, '0.01')}
          <Button type="submit" variant="primary" disabled={save.isPending || JSON.stringify(draft) === JSON.stringify(d.settings)}>
            Save
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted">
          Customer price = AWS cost × markup ÷ 100 (at least 100%). Changes apply to usage from now on; past usage keeps the price it was charged at. Payment fees
          are only used for the margin estimate above.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">AWS cost → customer price, per region</h2>
        <Table
          rows={d.regions}
          rowKey={(r) => r.regionId}
          columns={['Region', ...ITEMS.map(([, label]) => label), 'Prices from']}
          cells={(r) => [
            <span>
              {r.name} {r.enabled ? null : <Pill>disabled</Pill>}
              <br />
              <Mono>
                {r.executor} · {r.providerRegion}
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
              {r.sheet ? (r.sheet.source === 'simulated' ? <Pill>simulated</Pill> : <Pill tone="ok">AWS Price List</Pill>) : <Pill tone="bad">no prices</Pill>}
              <br />
              {when(r.fetchedAt)}
              {r.lastError ? (
                <>
                  <br />
                  <span className="text-error">
                    {when(r.lastErrorAt)}: {r.lastError}
                  </span>
                </>
              ) : null}
            </span>,
          ]}
        />
        <p className="mt-2 text-xs text-muted">The engine reads prices again when they are older than 12 hours; browsers cannot be created in a region without prices.</p>
      </section>

      <ReasonDialog
        open={confirm}
        title="Change customer prices"
        description={`Markup ${d.settings.markupPercent}% → ${draft.markupPercent}%. Users see the new prices at once; anything they had open is refused with “prices changed” until they review it.`}
        confirm="Save"
        busy={save.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={(reason) =>
          save.mutate({ ...draft, reason }, { onSuccess: () => setConfirm(false), onError: (e) => toast((e as Error).message, 'error') })
        }
      />
    </div>
  );
}
