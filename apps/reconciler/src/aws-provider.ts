/** Live AWS catalog, quota and organization billing synchronization. No infrastructure mutations. */
import { AWS_REGION_FACTS, TIERS } from '@cloudbrowser/contracts';
import { createDb, schema, type Db } from '@cloudbrowser/db';
import { AwsApi, AwsExecutor, DEFAULT_TIER_INSTANCE_TYPES, Ec2Client, RequestLimiter, assumeRoleCredentials, xmlItems, xmlText, type AwsCredentials, type AwsRegionConfig, type XmlNode } from '@cloudbrowser/executors';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from './index.js';

const { awsProviderState: state, awsProviderRegions: catalog, regions, providerPrices } = schema;
const usdMicros = (usd: unknown) => {
  const value = Number(usd);
  if (!Number.isFinite(value) || value < 0) throw new Error('AWS returned an invalid monetary amount');
  return Math.ceil(value * 1_000_000);
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'AWS synchronization failed').slice(0, 500);

/** A region observed more recently than this is not read again; the cron runs every 5 minutes. */
export const REGION_REFRESH_MS = 4 * 60_000;
/** Longer than a region's 120-second read deadline and its writes; released as soon as it finishes. */
const REGION_LEASE_MS = 5 * 60_000;
/** Guards billing, the only account-level work two runs must not repeat. */
const ACCOUNT_LEASE_MS = 5 * 60_000;
/**
 * A run starts no region after this, so it ends before the next cron instead of holding regions
 * past it. Regions it did not reach are the oldest the next run refreshes first.
 */
export const RUN_BUDGET_MS = 3 * 60_000;
const CONCURRENCY = 6;
/** A quota limit Service Quotas could not return is taken from the last snapshot for this long. */
export const QUOTA_LIMIT_MAX_AGE_MS = 7 * 86_400_000;

/**
 * The limit a snapshot records for a quota: the one just read, else the last one observed while
 * it is no older than QUOTA_LIMIT_MAX_AGE_MS (snapshots before limitAt existed date it by their
 * own observation), else none.
 */
export function quotaLimit(read: number | null, last: { limit: number; limitAt?: number } | undefined, snapshotAt: number | undefined, now: number) {
  if (read !== null) return { limit: read, limitAt: now };
  const limitAt = last?.limitAt ?? snapshotAt;
  return last && limitAt !== undefined && now - limitAt < QUOTA_LIMIT_MAX_AGE_MS ? { limit: last.limit, limitAt } : null;
}

/** AWS answered, and the region cannot host browsers: unlike a failed read, the snapshot is withdrawn. */
export class RegionUnusable extends Error {}

type Log = (event: string, fields: Record<string, unknown>) => void;

/**
 * Each synchronization owns its clients and session cache; never shares request data globally.
 * Runs may overlap: each region is claimed by one run at a time, so a slow region or a slow run
 * no longer makes the next runs skip every other region.
 */
export async function syncAwsProvider(env: Env, opts: { force?: boolean; trigger?: string; scheduledTime?: number; budgetMs?: number } = {}) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error('AWS reader credentials are not configured');
  const force = !!opts.force;
  const db = createDb(env.DB);
  const now = new Date();
  const runId = crypto.randomUUID().slice(0, 8);
  // One JSON line per event, so a gap in refreshes can be reconstructed from the Worker's logs.
  const log: Log = (event, fields) => console.log(JSON.stringify({ event: `aws_sync.${event}`, runId, ...fields }));
  // How late a cron started: a scheduling delay would otherwise look like a slow refresh.
  const lagMs = opts.scheduledTime ? now.getTime()-opts.scheduledTime : null;
  log('start', { trigger: opts.trigger ?? 'manual', force, lagMs });
  const base: AwsCredentials = { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY };
  const memberCredentials = env.AWS_ROLE_ARN ? assumeRoleCredentials(base, { arn: env.AWS_ROLE_ARN, externalId: env.AWS_ROLE_EXTERNAL_ID }) : async () => base;
  const managementCredentials = env.AWS_MANAGEMENT_ROLE_ARN ? assumeRoleCredentials(base, { arn: env.AWS_MANAGEMENT_ROLE_ARN, externalId: env.AWS_MANAGEMENT_EXTERNAL_ID }) : null;
  const api = new AwsApi(memberCredentials);
  // Every region's reads share one invocation's connections (MAX_AWS_REQUESTS).
  const limiter = new RequestLimiter();
  const ec2 = new Ec2Client({ ...base, credentials: memberCredentials, limiter });
  try {
    const [current] = await db.select().from(state).where(eq(state.id,1));
    if (!current) throw new Error('AWS provider state is missing');
    const identity = await api.call<XmlNode>('sts','us-east-1','GetCallerIdentity',{}, { queryVersion:'2011-06-15' });
    const accountId = xmlText(identity,'GetCallerIdentityResult','Account');
    if (!accountId) throw new Error('AWS caller identity is unavailable');
    const session = await memberCredentials();
    await db.update(state).set({ accountId, connection: {
      ...current.connection,
      runtimeAuthorization: env.AWS_ROLE_ARN ? 'sts-assume-role' : 'access-key', automaticSessionRefresh: !!env.AWS_ROLE_ARN,
      sessionExpiresAt: session.expiration ? new Date(session.expiration).toISOString() : null,
      managementAuthorization: managementCredentials ? 'sts-assume-role' : 'not-configured',
      baseCredentialRotation: 'operator-managed', checkedAt: now.toISOString(),
    } }).where(eq(state.id,1));

    // Refresh billing separately: a Cost Explorer delay must not hide regional quota observations.
    if (managementCredentials && (force || !current.billingAt || now.getTime()-current.billingAt.getTime() >= 6*3_600_000)) {
      const [lease] = await db.update(state).set({ syncLeaseUntil: new Date(Date.now() + ACCOUNT_LEASE_MS) })
        .where(and(eq(state.id,1), sql`${state.syncLeaseUntil}<${Date.now()}`)).returning({ id: state.id });
      if (!lease) log('billing_skipped', { reason: 'another run holds the account lease', leaseUntil: current.syncLeaseUntil.toISOString() });
      else {
        const began = Date.now();
        try { await syncBilling(db, new AwsApi(managementCredentials), accountId, now); log('billing', { ok: true, ms: Date.now()-began }); }
        catch (e) {
          await db.update(state).set({ lastError: errorText(e), lastErrorAt: new Date() }).where(eq(state.id,1));
          log('billing', { ok: false, ms: Date.now()-began, error: errorText(e) });
        } finally {
          await db.update(state).set({ syncLeaseUntil: new Date(0) }).where(eq(state.id,1));
        }
      }
    }

    const result = await ec2.call('ap-southeast-2','DescribeRegions',{ AllRegions:true }, Date.now()+30_000,false);
    const discovered = xmlItems(result,'regionInfo').map((r)=>({ code:xmlText(r,'regionName')!, optIn:xmlText(r,'optInStatus') ?? 'unknown' })).filter((r)=>!!r.code);
    const catalogDue = force || !current.catalogAt || now.getTime()-current.catalogAt.getTime()>86_400_000;
    const outcome = await refreshRegions(db, discovered, {
      force, catalogDue, budgetMs: opts.budgetMs ?? RUN_BUDGET_MS, log,
      metadata: async (code) => {
        const metadata = await api.call<{Parameters?:{Name:string;Value:string}[]}>('ssm','ap-southeast-2','AmazonSSM.GetParameters',{Names:[`/aws/service/global-infrastructure/regions/${code}/longName`,`/aws/service/global-infrastructure/regions/${code}/geolocationCountry`]});
        return { name: metadata.Parameters?.find((p)=>p.Name.endsWith('/longName'))?.Value, country: metadata.Parameters?.find((p)=>p.Name.endsWith('/geolocationCountry'))?.Value };
      },
      observe: (code, regionId) => syncRegion(db, env, ec2, limiter, memberCredentials, code, regionId, force, log),
    });
    // API removals or account opt-out must withdraw old inventory too.
    const known = await db.select().from(catalog);
    for (const old of known) if (!discovered.some((r)=>r.code===old.providerRegion)) await db.update(catalog).set({status:'not-supported',capacity:0,lastError:'No longer returned by AWS DescribeRegions'}).where(eq(catalog.regionId,old.regionId));
    // The catalog is refreshed once every region was reached; otherwise the next run finishes it.
    if (catalogDue && !outcome.deferred.length) await db.update(state).set({catalogAt:now}).where(eq(state.id,1));
    const [oldest] = await db.all<{ checked_at: number | null }>(sql`SELECT MIN(a.checked_at) AS checked_at FROM aws_provider_regions a JOIN regions r ON r.id=a.region_id WHERE r.enabled=1 AND a.status='ready'`);
    const summary = {
      runId, trigger: opts.trigger ?? 'manual', force, lagMs, startedAt: now.toISOString(), finishedAt: new Date().toISOString(), ms: Date.now()-now.getTime(),
      regions: discovered.length, refreshed: outcome.refreshed.length, fresh: outcome.fresh, failed: outcome.failed, taken: outcome.taken, deferred: outcome.deferred,
      slowest: outcome.refreshed.sort((a,b)=>b.ms-a.ms).slice(0,3),
      oldestReadyAgeMs: oldest?.checked_at ? Date.now()-oldest.checked_at : null,
    };
    await db.update(state).set({ lastRun: summary }).where(eq(state.id,1));
    log('done', summary);
    return summary;
  } catch (e) {
    await db.update(state).set({lastError:errorText(e),lastErrorAt:new Date()}).where(eq(state.id,1));
    log('failed', { ms: Date.now()-now.getTime(), error: errorText(e) });
    throw e;
  }
}

/**
 * Refreshes the regions AWS returned, oldest snapshot first, `CONCURRENCY` at a time. A region is
 * skipped while its snapshot is fresh or another run holds it, and none is started once the
 * budget is spent. A failed read keeps the last snapshot, which expires on its own (20 minutes):
 * one throttled call no longer withdraws a region at once.
 */
export async function refreshRegions(db: Db, discovered: { code: string; optIn: string }[], deps: {
  force: boolean; catalogDue: boolean; budgetMs: number; log: Log;
  /** Region names from SSM; read for new regions and the daily catalog refresh only. */
  metadata: (code: string) => Promise<{ name?: string; country?: string }>;
  /** Reads one region's quotas and usage and writes its snapshot. */
  observe: (code: string, regionId: string) => Promise<void>;
  clock?: () => number;
}) {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const existing = new Map((await db.select().from(regions).where(eq(regions.executor,'aws-ec2'))).map((r)=>[r.providerRegion,r]));
  const known = new Map((await db.select().from(catalog)).map((r)=>[r.providerRegion,r]));
  const out = { refreshed: [] as { region: string; ms: number }[], failed: [] as { region: string; error: string; failures: number; unusable: boolean }[], fresh: 0, taken: [] as string[], deferred: [] as string[] };
  // Oldest first: when AWS is slow and the budget runs out, the regions closest to expiring were refreshed.
  const pending = [...discovered].sort((a,b)=>(known.get(a.code)?.checkedAt?.getTime() ?? 0)-(known.get(b.code)?.checkedAt?.getTime() ?? 0));
  const refreshAfter = () => clock()-REGION_REFRESH_MS;
  await Promise.all(Array.from({length:CONCURRENCY},async()=>{
    for (let r=pending.shift(); r; r=pending.shift()) {
      const row = known.get(r.code);
      const previous = existing.get(r.code);
      const regionId = previous?.id ?? row?.regionId ?? r.code;
      // A forced refresh, a new region, a changed opt-in and the daily catalog refresh read it even when fresh.
      const due = deps.force || !row || row.optInStatus!==r.optIn || deps.catalogDue;
      if (!due && row.checkedAt && row.checkedAt.getTime() >= refreshAfter()) { out.fresh++; continue; }
      if (clock()-started >= deps.budgetMs) { out.deferred.push(r.code); continue; }
      const began = clock();
      let claimed = false;
      try {
        let name = previous?.name ?? r.code;
        let country = previous?.country ?? '';
        if (!row || deps.catalogDue) {
          const metadata = await deps.metadata(r.code);
          name = metadata.name || name;
          country = metadata.country || country;
        }
        // Where the region's servers are: the browser's timezone and its IP's country and city.
        // SSM has no city or timezone, and reports Hong Kong as CN where IP geolocation says HK.
        const facts = AWS_REGION_FACTS[r.code];
        const place = facts ? { country: facts.country, city: facts.city, timezone: facts.timezone } : { country, city: name, timezone: 'UTC' };
        // Publish discovery and its readiness marker atomically. Pricing must not see a new
        // region before it can tell that network discovery is still in progress.
        await db.batch([
          db.insert(regions).values({id:regionId,name,...place,enabled:true,executor:'aws-ec2',providerRegion:r.code})
            .onConflictDoUpdate({target:regions.id,set:facts ? {name,...place} : {name,country}}),
          db.insert(catalog).values({regionId,providerRegion:r.code,optInStatus:r.optIn,status:'syncing',capacity:0})
            .onConflictDoUpdate({target:catalog.regionId,set:{optInStatus:r.optIn}}),
        ]);
        // Claimed by one run at a time, and not again if another run refreshed it meanwhile.
        const [lease] = await db.update(catalog).set({ syncLeaseUntil: new Date(clock()+REGION_LEASE_MS) })
          .where(and(eq(catalog.regionId,regionId),
            sql`(${catalog.syncLeaseUntil} IS NULL OR ${catalog.syncLeaseUntil}<${clock()})`,
            ...(due ? [] : [sql`(${catalog.checkedAt} IS NULL OR ${catalog.checkedAt}<${refreshAfter()})`])))
          .returning({ regionId: catalog.regionId });
        if (!lease) { out.taken.push(r.code); continue; }
        claimed = true;
        if (!['opt-in-not-required','opted-in'].includes(r.optIn)) {
          await db.update(catalog).set({status:'not-enabled',capacity:0,checkedAt:new Date(clock()),lastError:'AWS region is not enabled for this account',lastErrorAt:null,syncFailures:0}).where(eq(catalog.regionId,regionId));
          continue;
        }
        await deps.observe(r.code, regionId);
        out.refreshed.push({ region: r.code, ms: clock()-began });
      } catch (e) {
        const error = errorText(e);
        const unusable = e instanceof RegionUnusable;
        try {
          const [failed] = await db.update(catalog).set(unusable
            ? { status:'unavailable', capacity:0, lastError:error, lastErrorAt:new Date(clock()), syncFailures:sql`${catalog.syncFailures}+1` }
            : { lastError:error, lastErrorAt:new Date(clock()), syncFailures:sql`${catalog.syncFailures}+1` })
            .where(eq(catalog.regionId,regionId)).returning({ failures: catalog.syncFailures, checkedAt: catalog.checkedAt });
          out.failed.push({ region: r.code, error, failures: failed?.failures ?? 1, unusable });
          deps.log('region_failed', { region: r.code, ms: clock()-began, error, unusable, consecutiveFailures: failed?.failures ?? 1,
            snapshotAgeMs: failed?.checkedAt ? clock()-failed.checkedAt.getTime() : null });
        } catch (write) {
          deps.log('region_failed', { region: r.code, ms: clock()-began, error, unusable, recordError: errorText(write) });
        }
      } finally {
        if (claimed) await db.update(catalog).set({ syncLeaseUntil: null }).where(eq(catalog.regionId,regionId)).catch((e)=>deps.log('lease_release_failed',{region:r.code,error:errorText(e)}));
      }
    }
  }));
  return out;
}

async function syncRegion(db: Db, env: Env, ec2: Ec2Client, limiter: RequestLimiter, credentials: () => Promise<AwsCredentials>, code: string, regionId: string, force: boolean, log: Log) {
  const began = Date.now();
  // Capture local intents before provider reads. A later create is then deducted by the SQL view.
  const held=await db.all<{id:string}>(sql`SELECT id FROM aws_browser_commitments WHERE region_id=${regionId}`);
  const heldIds=new Set(held.map((r)=>r.id));
  const heldResource=(r:XmlNode)=> {
    const tags=Object.fromEntries(xmlItems(r,'tagSet').map((t)=>[xmlText(t,'key'),xmlText(t,'value')]));
    return tags['cb:managed']==='true' && tags['cb:env']===(env.ENV_NAME ?? 'prod') && heldIds.has(tags['cb:instance'] ?? '');
  };
  const deadline = Date.now()+120_000;
  const call = (action:string, params:Record<string,string|number|boolean|undefined>={})=>ec2.call(code,action,params,deadline,false);
  const all = async (action:string,set:string,params:Record<string,string|number|boolean|undefined>={})=>{
    const out:XmlNode[]=[]; let next:string|undefined;
    do {const page=await call(action,{...params,NextToken:next});out.push(...xmlItems(page,set));next=xmlText(page,'nextToken');}while(next);
    return out;
  };
  // Network ids and instance availability are discovered, not copied from a Sydney JSON constant.
  const vpcs=await all('DescribeVpcs','vpcSet',{'Filter.1.Name':'tag:Name','Filter.1.Value.1':'cloudbrowser'});
  const legacy=(env.AWS_REGIONS ? JSON.parse(env.AWS_REGIONS) : {}) as Record<string,AwsRegionConfig>;
  let config:AwsRegionConfig|undefined=legacy[code];
  if (vpcs.length) {
    const vpcId=xmlText(vpcs[0],'vpcId')!;
    const [subnets,groups]=await Promise.all([
      all('DescribeSubnets','subnetSet',{'Filter.1.Name':'vpc-id','Filter.1.Value.1':vpcId}),
      all('DescribeSecurityGroups','securityGroupInfo',{'Filter.1.Name':'vpc-id','Filter.1.Value.1':vpcId,'Filter.2.Name':'tag:Name','Filter.2.Value.1':'cloudbrowser-browser'}),
    ]);
    if (groups[0] && subnets.length) config={subnets:Object.fromEntries(subnets.filter((s)=>xmlText(s,'state')==='available' && Number(xmlText(s,'availableIpAddressCount'))>0).map((s)=>[xmlText(s,'availabilityZone')!,xmlText(s,'subnetId')!])),securityGroupId:xmlText(groups[0],'groupId')!};
  }
  if (!config || !Object.keys(config.subnets).length) throw new RegionUnusable('Regional browser network is not provisioned');
  const tiers=DEFAULT_TIER_INSTANCE_TYPES;
  const offerings=await all('DescribeInstanceTypeOfferings','instanceTypeOfferingSet',{
    LocationType:'availability-zone','Filter.1.Name':'instance-type',...Object.fromEntries([...tiers.basic,...tiers.premium].map((t,i)=>[`Filter.1.Value.${i+1}`,t])),
  });
  const offeredIn=(types:string[])=>types.filter((type)=>offerings.some((o)=>xmlText(o,'instanceType')===type && xmlText(o,'location')! in config!.subnets));
  const offered=offeredIn(tiers.basic);
  if (!offered.length) throw new RegionUnusable('No supported browser machine is offered in the configured availability zones');
  // Premium is optional: a region without its machines keeps taking Basic browsers.
  const premiumOffered=offeredIn(tiers.premium);
  // Per zone, so a launch never asks a zone for a type it does not offer (EC2: Unsupported).
  const byZone=(types:string[])=>Object.fromEntries(Object.keys(config!.subnets).map((zone)=>[zone,types.filter((type)=>offerings.some((o)=>xmlText(o,'instanceType')===type && xmlText(o,'location')===zone))]));
  config={...config,instanceTypes:offered,zoneInstanceTypes:byZone(offered),premium:{instanceTypes:premiumOffered,zoneInstanceTypes:byZone(premiumOffered)}};
  const executor=new AwsExecutor({accessKeyId:env.AWS_ACCESS_KEY_ID!,secretAccessKey:env.AWS_SECRET_ACCESS_KEY!,credentials,limiter,mode:'readonly',regions:{[code]:config},appUrl:'',agentImage:'',browserImage:''});
  const ctx={operationId:'aws-provider-sync',step:'provider-sync',token:'provider-sync',tags:{'cb:managed':'true' as const,'cb:env':env.ENV_NAME ?? 'prod','cb:instance':'provider-sync','cb:op':'provider-sync','cb:gen':'0'},deadline};
  // What the snapshot describes: AWS as of these reads, not the run's start. Taken before the first
  // read so its age is never understated.
  const observedAt=new Date();
  const [previous]=await db.select({quotas:catalog.quotas,checkedAt:catalog.checkedAt}).from(catalog).where(eq(catalog.regionId,regionId));
  const [volumes,enis,subnets,machines,addresses,reservations]=await Promise.all([
    all('DescribeVolumes','volumeSet'), all('DescribeNetworkInterfaces','networkInterfaceSet'),
    all('DescribeSubnets','subnetSet',{'Filter.1.Name':'subnet-id',...Object.fromEntries(Object.values(config.subnets).map((v,i)=>[`Filter.1.Value.${i+1}`,v]))}),
    all('DescribeInstanceTypes','instanceTypeSet',Object.fromEntries([...offered,...premiumOffered].map((v,i)=>[`InstanceType.${i+1}`,v]))),
    all('DescribeAddresses','addressesSet'),all('DescribeInstances','reservationSet',{'Filter.1.Name':'instance-state-name','Filter.1.Value.1':'pending','Filter.1.Value.2':'running'}),
  ]);
  // Usage is read live every time; a limit changes only when AWS grants a request. One Service
  // Quotas read that failed (slow or throttled) used to withdraw the whole region, so a limit it
  // could not return now is the last one observed, for up to a week (limitAt says when).
  const unread:string[]=[];
  const limit=async(metric:string,service:string,quotaCode:string,scale=1)=>{
    const value=await ec2.serviceQuota(code,service,quotaCode,deadline,(reason)=>unread.push(reason));
    return quotaLimit(value===null ? null : value*scale,previous?.quotas?.find((q)=>q.metric===metric),previous?.checkedAt?.getTime(),observedAt.getTime());
  };
  const [ipLimit,cpuLimit,storageLimit,eniLimit]=await Promise.all([
    limit('static_ips','ec2','L-0263D0A3'), // EC2-VPC Elastic IPs
    limit('vcpus','ec2','L-1216C47A'), // Running On-Demand Standard vCPUs
    limit('gp3_gib','ebs','L-7A658B76',1024), // gp3 storage, in TiB
    limit('network_interfaces','vpc','L-DF5E4CA3'), // network interfaces per Region
  ]);
  if (!ipLimit || !cpuLimit || !storageLimit || !eniLimit) throw new Error(`Required AWS quota is unavailable: ${unread.join('; ') || 'no value'}`);
  if (unread.length) log('quota_fallback',{region:code,unread});
  const vcpusUsed=reservations.flatMap((r)=>xmlItems(r,'instancesSet')).reduce((n,i)=>n+Number(xmlText(i,'cpuOptions','coreCount') ?? 1)*Number(xmlText(i,'cpuOptions','threadsPerCore') ?? 2),0);
  const quotas:{metric:string;limit:number;used:number;limitAt?:number}[]=[
    {metric:'static_ips',...ipLimit,used:addresses.length},
    {metric:'vcpus',...cpuLimit,used:vcpusUsed},
    {metric:'gp3_gib',...storageLimit,used:volumes.filter((v)=>xmlText(v,'volumeType')==='gp3').reduce((sum,v)=>sum+Number(xmlText(v,'size')),0)},
    {metric:'network_interfaces',...eniLimit,used:enis.length},
  ];
  const [price]=await db.select().from(providerPrices).where(eq(providerPrices.regionId,regionId));
  const configurationKey=executor.pricingConfigKey(code);
  let sheet=price?.sheet as import('@cloudbrowser/contracts').ProviderPriceSheet|null;
  if (force || !price?.fetchedAt || Date.now()-price.fetchedAt.getTime()>12*3_600_000 || configurationKey!==price.configurationKey) {
    const historical=await db.all<{instance_type:string}>(sql`SELECT DISTINCT instance_type FROM placements WHERE provider_region=${code} AND executor='aws-ec2' AND status IN ('current','building') AND instance_type IS NOT NULL`);
    sheet=await executor.prices(ctx,code,historical.map((p)=>p.instance_type));
    const values={executor:'aws-ec2',providerRegion:code,sheet,configurationKey,fetchedAt:new Date(),lastError:null,lastErrorAt:null};
    await db.insert(providerPrices).values({regionId,...values}).onConflictDoUpdate({target:providerPrices.regionId,set:values});
  }
  if (!sheet) throw new Error('AWS prices are unavailable');
  // What one browser of each tier needs: the most any of its launch candidates has.
  const vcpusOf=(types:string[])=>Math.max(...machines.filter((m)=>types.includes(xmlText(m,'instanceType')!)).map((m)=>Number(xmlText(m,'vCpuInfo','defaultVCpus'))));
  const vcpu=vcpusOf(offered);
  if (!Number.isFinite(vcpu) || vcpu<=0) throw new Error('AWS machine CPU requirements are unavailable');
  const premiumVcpu=premiumOffered.length ? vcpusOf(premiumOffered) : TIERS.premium.vcpu;
  if (!Number.isFinite(premiumVcpu) || premiumVcpu<=0) throw new Error('AWS machine CPU requirements are unavailable');
  const remaining=(metric:string)=>{const q=quotas.find((q)=>q.metric===metric)!;return Math.max(0,q.limit-q.used);};
  const [storage]=await db.all<{gb:number}>(sql`SELECT COALESCE(MAX("limit"),10) gb FROM caps WHERE metric='storage_gb'`);
  const subnetFree=subnets.reduce((n,s)=>n+Number(xmlText(s,'availableIpAddressCount')),0);
  const usedCpu=(i:XmlNode)=>Number(xmlText(i,'cpuOptions','coreCount'))*Number(xmlText(i,'cpuOptions','threadsPerCore'));
  const managedCpu=reservations.flatMap((r)=>xmlItems(r,'instancesSet')).filter(heldResource).reduce((n,i)=>n+usedCpu(i),0);
  const managedStorage=volumes.filter((v)=>heldResource(v) && xmlText(v,'volumeType')==='gp3').reduce((n,v)=>n+Number(xmlText(v,'size')),0);
  // Browsers every dimension but vCPUs allows (one of each per browser, whatever its tier), and the
  // vCPUs the account can give its browsers: aws_region_inventory divides those by each tier's need.
  const capacity=Math.floor(Math.min(remaining('static_ips')+addresses.filter(heldResource).length,(remaining('gp3_gib')+managedStorage)/((storage?.gb ?? 10)+sheet.rootVolumeGb),remaining('network_interfaces')+enis.filter(heldResource).length,subnetFree+enis.filter((e)=>heldResource(e) && Object.values(config!.subnets).includes(xmlText(e,'subnetId')!)).length));
  const vcpuCapacity=Math.floor(remaining('vcpus')+managedCpu);
  if (!Number.isFinite(capacity) || !Number.isFinite(vcpuCapacity)) throw new Error('AWS returned an incomplete quota usage observation');
  await db.update(catalog).set({config:config as unknown as Record<string,unknown>,quotas,capacity:Math.max(0,capacity),vcpuCapacity:Math.max(0,vcpuCapacity),
    basicVcpus:vcpu,premiumVcpus:premiumVcpu,premiumOffered:premiumOffered.length>0 && !!sheet.premium,checkedAt:observedAt,status:'ready',lastError:null,lastErrorAt:null,syncFailures:0,syncMs:Date.now()-began}).where(eq(catalog.regionId,regionId));
}

async function syncBilling(db: Db, api: AwsApi, accountId: string, now: Date) {
  const org=await api.call<{Organization:{Id:string;MasterAccountId?:string;ManagementAccountId?:string}}>('organizations','us-east-1','AWSOrganizationsV20161128.DescribeOrganization',{});
  const managementAccountId=org.Organization.ManagementAccountId ?? org.Organization.MasterAccountId!;
  const accounts:Record<string,unknown>[]=[];let token:string|undefined;
  do {const page=await api.call<{Accounts?:Record<string,unknown>[];NextToken?:string}>('organizations','us-east-1','AWSOrganizationsV20161128.ListAccounts',{...(token?{NextToken:token}:{})});accounts.push(...page.Accounts??[]);token=page.NextToken;}while(token);
  if (!accounts.some((a)=>a.Id===accountId)) throw new Error('Runtime account does not belong to the authorized AWS organization');
  const month=now.toISOString().slice(0,7);
  const today=now.toISOString().slice(0,10);
  const tomorrow=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)).toISOString().slice(0,10);
  const start=`${month}-01`;
  const byRegion:Record<string,number>={};const byAccount:Record<string,number>={};let spendMicros=0;let organizationSpendMicros=0;let estimated=false;token=undefined;
  do {
    const page: {ResultsByTime?:{Estimated:boolean;Groups?:{Keys:string[];Metrics:{UnblendedCost:{Amount:string;Unit:string}}}[]}[];NextPageToken?:string}=await api.call('ce','us-east-1','AWSInsightsIndexService.GetCostAndUsage',{
      TimePeriod:{Start:start,End:tomorrow},Granularity:'MONTHLY',Metrics:['UnblendedCost'],
      Filter:{Not:{Dimensions:{Key:'RECORD_TYPE',Values:['Credit','Refund']}}},
      GroupBy:[{Type:'DIMENSION',Key:'LINKED_ACCOUNT'},{Type:'DIMENSION',Key:'REGION'}],...(token?{NextPageToken:token}:{}),
    });
    for (const period of page.ResultsByTime??[]) {estimated ||= period.Estimated;for(const g of period.Groups??[]) {if(g.Metrics.UnblendedCost.Unit!=='USD') throw new Error('AWS billing currency is not USD');const cost=usdMicros(g.Metrics.UnblendedCost.Amount);organizationSpendMicros+=cost;byAccount[g.Keys[0]!]=(byAccount[g.Keys[0]!]??0)+cost;if(g.Keys[0]===accountId){spendMicros+=cost;byRegion[g.Keys[1]??'global']=(byRegion[g.Keys[1]??'global']??0)+cost;}}}
    token=page.NextPageToken;
  }while(token);
  const auxiliaryErrors:Record<string,string>={};
  let credits:unknown=null;
  try {
    const raw=await api.call<{credits?:Record<string,unknown>[],nextToken?:string}>('billing','us-east-1','AWSBilling.GetCredits', {accountId:managementAccountId,startDate:Date.parse(`${start}T00:00:00Z`)/1000,payerAccountFlag:true});
    if (!Array.isArray(raw.credits)) throw new Error('AWS credits response is incomplete');
    credits=raw.credits.map((c)=>Object.fromEntries(['accountId','creditId','creditType','description','creditStatus','estimatedAmount','initialAmount','remainingAmount','startDate','endDate','creditSharingType','accountHasCreditSharingEnabled','shareableAccounts'].map((key)=>[key,c[key]])));
  } catch(e){auxiliaryErrors.credits=errorText(e);}
  const session=await api.credentials();
  const [previous]=await db.select().from(state).where(eq(state.id,1));
  await db.update(state).set({managementAccountId,organizationId:org.Organization.Id,billingAt:now,connection:{...previous?.connection,managementSessionExpiresAt:session.expiration ? new Date(session.expiration).toISOString():null,managementCheckedAt:now.toISOString()},billing:{month,spendMicros,byRegion,byAccount,organizationSpendMicros,estimated,accounts,credits,auxiliaryErrors,through:today},lastError:null,lastErrorAt:null}).where(eq(state.id,1));
}
