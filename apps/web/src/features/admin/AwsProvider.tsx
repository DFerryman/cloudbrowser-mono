import { Button, Input, Label, Select, useToast } from '@cloudbrowser/ui';
import { useState } from 'react';
import { post, put, usd, useAdmin, useAdminAction, when } from './data.js';
import { Json, Mono, PageTitle, Pill, ReasonDialog, Table, Tile } from './ui.js';
import type { AwsProviderSettings } from '@cloudbrowser/contracts';

type Provider = {
  settings: AwsProviderSettings;
  state: { accountId:string|null;managementAccountId:string|null;organizationId:string|null;connection:Record<string,unknown>|null;billing:{month:string;spendMicros:number;organizationSpendMicros?:number;byAccount?:Record<string,number>;byRegion?:Record<string,number>;budgetMicros:number|null;estimated:boolean;accounts:Record<string,unknown>[];credits:Record<string,unknown>[]|null;auxiliaryErrors:Record<string,string>}|null;billingAt:string|null;catalogAt:string|null;lastError:string|null;lastErrorAt:string|null;syncLeaseUntil:string };
  regions:{regionId:string;providerRegion:string;name:string;optInStatus:string;status:string;quotas:{metric:string;used:number;limit:number}[]|null;checkedAt:string|null;lastError:string|null;price:{fetchedAt:string|null;lastError:string|null};inventory?:{available:number;quota_available:number;monthly_unit_micros:number;budget_remaining_micros:number;availability:string}}[];
};

export function AwsProviderPage() {
  const query=useAdmin<Provider>('/aws-provider',{refetchInterval:15_000});
  const toast=useToast();
  const refresh=useAdminAction(()=>post('/aws-provider/refresh'));
  const save=useAdminAction((v:AwsProviderSettings & {reason:string})=>put('/aws-provider/settings',v));
  const [draft,setDraft]=useState<AwsProviderSettings|null>(null);
  const [confirm,setConfirm]=useState(false);
  if(query.isError) return <p role="alert">{query.error.message}</p>;
  if(!query.data) return <p className="text-muted">Loading AWS Provider…</p>;
  const {settings,state,regions}=query.data;
  const form=draft ?? settings;
  const billing=state.billing;
  return <div className="space-y-6">
    <PageTitle title="AWS Provider"><Button disabled={refresh.isPending} onClick={()=>refresh.mutate(undefined,{onSuccess:()=>toast('AWS synchronization queued'),onError:(e)=>toast(e.message,'error')})}>Sync from AWS</Button></PageTitle>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="Runtime account" value={state.accountId ?? 'Not connected'} />
      <Tile label="Management account" value={state.managementAccountId ?? 'Not connected'} />
      <Tile label={`AWS cost this month${billing?.estimated ? ' (estimated by AWS)' : ''}`} value={billing ? usd(billing.spendMicros) : 'Unavailable'} />
      <Tile label="Organization cost this month" value={billing?.organizationSpendMicros!==undefined ? usd(billing.organizationSpendMicros):'Unavailable'} />
      <Tile label="Project monthly budget" value={form.monthlyBudgetMicros !== null ? usd(form.monthlyBudgetMicros) : billing?.budgetMicros !== null && billing?.budgetMicros !== undefined ? `${usd(billing.budgetMicros)} (AWS Budgets)` : 'Not configured'} />
    </div>
    <section className="space-y-2 text-sm">
      <h2 className="font-medium">Authorization & synchronization</h2>
      <p>Organization: <Mono>{state.organizationId ?? '—'}</Mono> · Regions checked: {when(state.catalogAt)} · Billing checked: {when(state.billingAt)}</p>
      <p>STS sessions renew automatically before expiry when an AssumeRole connection is configured. The underlying bootstrap access key requires operator rotation. Revoked permissions require reconnection.</p>
      <Json value={state.connection} />
      {state.lastError ? <p role="alert" className="text-error">{when(state.lastErrorAt)}: {state.lastError}</p>:null}
    </section>
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Inventory policy</h2>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e)=>{e.preventDefault();setConfirm(true);}}>
        <div><Label htmlFor="inventory-mode">Inventory limit</Label><Select id="inventory-mode" value={form.inventoryMode} onChange={(e)=>setDraft({...form,inventoryMode:e.target.value as 'quota'|'budget'})}><option value="budget">AWS quotas and monthly budget</option><option value="quota">AWS quotas</option></Select></div>
        <div><Label htmlFor="aws-budget">Project budget (USD/month)</Label><Input id="aws-budget" type="number" min="0" step="0.01" placeholder="Use AWS Budgets" value={form.monthlyBudgetMicros===null?'':form.monthlyBudgetMicros/1_000_000} onChange={(e)=>setDraft({...form,monthlyBudgetMicros:e.target.value===''?null:Math.round(Number(e.target.value)*1_000_000)})} /></div>
        <div><Label htmlFor="aws-hours">Estimated running hours/day</Label><Input id="aws-hours" type="number" min="1" max="24" value={form.estimatedHoursPerDay} onChange={(e)=>setDraft({...form,estimatedHoursPerDay:Number(e.target.value)})} /></div>
        <Button type="submit" variant="primary" disabled={save.isPending}>Save policy</Button>
      </form>
      <p className="text-xs text-muted">Regions share one project budget. Estimates reserve a full calendar month of compute, IP and storage per browser (24 hours/day by default), in addition to AWS month-to-date cost. Existing and pending resources retain their reservation until purged. Credits do not increase the budget. Variable traffic and billing delays can still affect the final bill. Raising the budget updates inventory immediately.</p>
    </section>
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Regional inventory from AWS APIs</h2>
      <Table rows={regions} rowKey={(r)=>r.regionId} columns={['Region','Status / opt-in','Available','Quota room','AWS cost this month','Est. cost / month','AWS quotas (used / limit)','Last sync']} cells={(r)=>[
        <span>{r.name}<br/><Mono>{r.providerRegion}</Mono></span>,
        <span><Pill tone={r.status==='ready'?'ok':'warn'}>{r.status}</Pill><br/>{r.optInStatus}</span>,
        r.inventory?.available ?? 0,r.inventory?.quota_available ?? '—',billing?.byRegion ? usd(billing.byRegion[r.providerRegion] ?? 0):'—',r.inventory ? usd(r.inventory.monthly_unit_micros):'—',
        <span className="text-xs">{r.quotas?.map((q)=><span key={q.metric} className="block">{q.metric}: {q.used} / {q.limit}</span>) ?? 'Unavailable'}</span>,
        <span className="text-xs">{when(r.checkedAt)}<br/>Prices: {when(r.price.fetchedAt)}{r.lastError || r.price.lastError ? <span className="block text-error">{r.lastError ?? r.price.lastError}</span>:null}</span>,
      ]}/>
      <p className="text-xs text-muted">Regions and country names come from AWS DescribeRegions and public infrastructure parameters. Inventory reflects account quotas and the selected budget policy; AWS physical capacity is confirmed at launch. Unavailable, disabled or stale regions cannot accept new browsers. Price List refreshes every 12 hours; new purchases stop after 48 hours without a successful price refresh.</p>
    </section>
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Organization accounts & credits</h2>
      <Table rows={billing?.accounts ?? []} rowKey={(a)=>String(a.Id)} columns={['Account','Status','Month-to-date AWS cost']} cells={(a)=>[<span>{String(a.Name)}<br/><Mono>{String(a.Id)}</Mono></span>,String(a.State ?? a.Status ?? '—'),billing?.byAccount?.[String(a.Id)]!==undefined ? usd(billing.byAccount[String(a.Id)]!):'—']}/>
      <Table rows={billing?.credits ?? []} rowKey={(c)=>String(c.creditId)} columns={['Credit','Remaining / estimated','Expires','Sharing']} cells={(c)=>[
        String(c.description ?? c.creditType ?? 'AWS credit'),
        <span>{String((c.remainingAmount as {currencyAmount?:string})?.currencyAmount ?? '—')} / {String((c.estimatedAmount as {currencyAmount?:string})?.currencyAmount ?? '—')} USD</span>,
        typeof c.endDate==='number' ? when(new Date(c.endDate*1000).toISOString()):'—',
        <span>{String(c.creditSharingType ?? '—')} · {c.accountHasCreditSharingEnabled ? 'Enabled':'Disabled'}</span>,
      ]}/>
      <p className="text-xs text-muted">AWS credits have service eligibility, expiry dates and sharing rules. Remaining and estimated values come directly from AWS and may update at different times.</p>
      {billing && Object.keys(billing.auxiliaryErrors).length ? <Json value={billing.auxiliaryErrors}/>:null}
    </section>
    <ReasonDialog open={confirm} title="Change AWS inventory policy" description="The new policy applies to browser creation immediately across all regions." confirm="Save" busy={save.isPending} onClose={()=>setConfirm(false)} onConfirm={(reason)=>save.mutate({...form,reason},{onSuccess:()=>{setConfirm(false);setDraft(null);},onError:(e)=>toast(e.message,'error')})}/>
  </div>;
}
