import { Button, useToast } from '@cloudbrowser/ui';
import { useState } from 'react';
import { post, usd, useAdmin, useAdminAction, when } from './data.js';
import { useT } from './i18n.js';
import { Mono, PageTitle, Pill, ReasonDialog, StatusPill, Table, Tile } from './ui.js';

type Connection = { runtimeAuthorization?: string; sessionExpiresAt?: string | null; managementAuthorization?: string; managementSessionExpiresAt?: string | null };
type Provider = {
  state: { accountId:string|null;managementAccountId:string|null;connection:Connection|null;billing:{spendMicros:number;organizationSpendMicros?:number;byRegion?:Record<string,number>;estimated:boolean;credits:Record<string,unknown>[]|null}|null;billingAt:string|null;catalogAt:string|null;lastError:string|null;lastErrorAt:string|null };
  regions:{regionId:string;providerRegion:string;name:string;optInStatus:string;status:string;quotas:{metric:string;used:number;limit:number}[]|null;checkedAt:string|null;lastError:string|null;price:{fetchedAt:string|null;lastError:string|null};inventory?:{available:number;availableByTier?:{basic:number;premium:number};premium_offered?:number};held:number;launch?:Launch}[];
};
/** How launches went: tested by a real VM, or a provider failure that stops new browsers. */
type Launch={verifiedAt:string|null;issue:{at:string;class:string|null;message:string|null;zone:string|null;blocking:boolean}|null};

function LaunchCell({launch,onReopen}:{launch?:Launch;onReopen:()=>void}) {
  const {t}=useT();
  if(launch?.issue) return <span className="text-xs">
    <Pill tone="bad">{t(launch.issue.blocking?'aws.blocked':'aws.paused')}</Pill> {when(launch.issue.at)}{launch.issue.zone?` · ${launch.issue.zone}`:''}
    <span className="block max-w-xs text-error">{launch.issue.message}</span>
    <Button size="sm" onClick={onReopen}>{t('aws.reopen')}</Button>
  </span>;
  return launch?.verifiedAt ? <span className="text-xs"><Pill tone="ok">{t('aws.tested')}</Pill><br/>{when(launch.verifiedAt)}</span> : <span className="text-xs"><Pill tone="warn">{t('aws.untested')}</Pill></span>;
}

export function AwsProviderPage() {
  const {t,errorText}=useT();
  const query=useAdmin<Provider>('/aws-provider',{refetchInterval:15_000});
  const toast=useToast();
  const refresh=useAdminAction(()=>post('/aws-provider/refresh'));
  const reopen=useAdminAction((v:{regionId:string;reason:string})=>post(`/aws-provider/regions/${encodeURIComponent(v.regionId)}/reopen`,{reason:v.reason}));
  const [reopening,setReopening]=useState<string|null>(null);
  if(query.isError) return <p role="alert">{errorText(query.error)}</p>;
  if(!query.data) return <p className="text-muted">{t('common.loading')}</p>;
  const {state,regions}=query.data;
  const billing=state.billing;
  const c=state.connection;
  const session=(how:string|undefined,expires:string|null|undefined)=>how==='sts-assume-role' ? t('aws.expiresAt',{when:when(expires)}) : how==='access-key' ? t('aws.accessKeyOnly') : t('aws.notConfigured');
  return <div className="space-y-6">
    <PageTitle title={t('nav.aws')}><Button disabled={refresh.isPending} onClick={()=>refresh.mutate(undefined,{onSuccess:()=>toast(t('aws.syncQueued')),onError:(e)=>toast(errorText(e),'error')})}>{t('aws.sync')}</Button></PageTitle>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label={t('aws.runtimeAccount')} value={state.accountId ?? t('aws.notConnected')} />
      <Tile label={t('aws.managementAccount')} value={state.managementAccountId ?? t('aws.notConnected')} />
      <Tile label={t(billing?.estimated ? 'aws.costEstimated' : 'aws.costMonth')} value={billing ? usd(billing.spendMicros) : t('aws.unavailable')} />
      <Tile label={t('aws.orgCost')} value={billing?.organizationSpendMicros!==undefined ? usd(billing.organizationSpendMicros):t('aws.unavailable')} />
    </div>
    <section className="space-y-1 text-sm">
      <h2 className="font-medium">{t('aws.credentials')}</h2>
      <p>{t('aws.runtimeSession')}{t('common.colon')}{session(c?.runtimeAuthorization,c?.sessionExpiresAt)}</p>
      <p>{t('aws.managementSession')}{t('common.colon')}{session(c?.managementAuthorization,c?.managementSessionExpiresAt)}</p>
      <p>{t('aws.baseKey')}{t('common.colon')}<span className="text-muted">{t('aws.baseKeyNote')}</span></p>
      <p className="text-muted">{t('aws.lastSync',{catalog:when(state.catalogAt),billing:when(state.billingAt)})}</p>
      {state.lastError ? <p role="alert" className="text-error">{when(state.lastErrorAt)}: {state.lastError}</p>:null}
    </section>
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t('aws.regions')}</h2>
      <Table rows={regions} rowKey={(r)=>r.regionId} columns={[t('aws.col.region'),t('aws.col.status'),t('aws.col.launches'),t('aws.col.available'),t('aws.col.held'),t('aws.col.quotas'),t('aws.col.cost'),t('aws.col.sync')]} cells={(r)=>[
        <span>{r.name}<br/><Mono>{r.providerRegion}</Mono></span>,
        <span><StatusPill value={r.status} tone={r.status==='ready'?'ok':'warn'}/><br/><span className="text-xs text-muted"><StatusPill value={r.optInStatus} tone="muted"/></span></span>,
        <LaunchCell launch={r.launch} onReopen={()=>setReopening(r.regionId)} />,
        <span className="tabular-nums"><span className="font-semibold">{r.inventory?.available ?? 0}</span>{r.inventory?.availableByTier ? <span className="block text-xs text-muted">{r.inventory.premium_offered ? t('aws.premiumStock',{count:r.inventory.availableByTier.premium}) : t('aws.premiumNotOffered')}</span> : null}</span>,
        <span className="tabular-nums">{r.held}</span>,
        <span className="text-xs">{r.quotas?.map((q)=><span key={q.metric} className="block">{q.metric}: {q.used} / {q.limit}</span>) ?? t('aws.unavailable')}</span>,
        billing?.byRegion ? usd(billing.byRegion[r.providerRegion] ?? 0):'—',
        <span className="text-xs">{when(r.checkedAt)}<br/>{t('aws.prices',{when:when(r.price.fetchedAt)})}{r.lastError || r.price.lastError ? <span className="block text-error">{r.lastError ?? r.price.lastError}</span>:null}</span>,
      ]}/>
      <p className="text-xs text-muted">{t('aws.regionsNote')}</p>
      <p className="text-xs text-muted">{t('aws.launchNote')}</p>
    </section>
    {billing?.credits?.length ? <section className="space-y-2">
      <h2 className="text-sm font-medium">{t('aws.credits')}</h2>
      <Table rows={billing.credits} rowKey={(c)=>String(c.creditId)} columns={[t('aws.col.credit'),t('aws.col.remaining'),t('aws.col.expires')]} cells={(c)=>[
        String(c.description ?? c.creditType ?? 'AWS credit'),
        <span>{String((c.remainingAmount as {currencyAmount?:string})?.currencyAmount ?? '—')} / {String((c.estimatedAmount as {currencyAmount?:string})?.currencyAmount ?? '—')} USD</span>,
        typeof c.endDate==='number' ? when(new Date(c.endDate*1000).toISOString()):'—',
      ]}/>
      <p className="text-xs text-muted">{t('aws.creditsNote')}</p>
    </section> : null}
    <ReasonDialog open={reopening!==null} title={t('aws.reopenTitle',{region:reopening ?? ''})} description={t('aws.reopenHelp')} confirm={t('aws.reopen')} busy={reopen.isPending} onClose={()=>setReopening(null)} onConfirm={(reason)=>reopen.mutate({regionId:reopening!,reason},{onSuccess:()=>{setReopening(null);toast(t('aws.reopened'));},onError:(e)=>toast(errorText(e),'error')})}/>
  </div>;
}
