/** Live AWS catalog, quota and organization billing synchronization. No infrastructure mutations. */
import { AWS_REGION_FACTS } from '@cloudbrowser/contracts';
import { createDb, schema, type Db } from '@cloudbrowser/db';
import { AwsApi, AwsExecutor, DEFAULT_INSTANCE_TYPES, Ec2Client, assumeRoleCredentials, xmlItems, xmlText, type AwsCredentials, type AwsRegionConfig, type XmlNode } from '@cloudbrowser/executors';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from './index.js';

const { awsProviderState: state, awsProviderRegions: catalog, regions, providerPrices } = schema;
const usdMicros = (usd: unknown) => {
  const value = Number(usd);
  if (!Number.isFinite(value) || value < 0) throw new Error('AWS returned an invalid monetary amount');
  return Math.ceil(value * 1_000_000);
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'AWS synchronization failed').slice(0, 500);

/** Each synchronization owns its clients, session cache and lease; never shares request data globally. */
export async function syncAwsProvider(env: Env, force = false) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error('AWS reader credentials are not configured');
  const db = createDb(env.DB);
  const now = new Date();
  const [claimed] = await db.update(state).set({ syncLeaseUntil: new Date(now.getTime() + 14 * 60_000) })
    .where(and(eq(state.id,1), sql`${state.syncLeaseUntil}<${now.getTime()}`)).returning();
  if (!claimed) return { busy: true };
  const base: AwsCredentials = { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY };
  const memberCredentials = env.AWS_ROLE_ARN ? assumeRoleCredentials(base, { arn: env.AWS_ROLE_ARN, externalId: env.AWS_ROLE_EXTERNAL_ID }) : async () => base;
  const managementCredentials = env.AWS_MANAGEMENT_ROLE_ARN ? assumeRoleCredentials(base, { arn: env.AWS_MANAGEMENT_ROLE_ARN, externalId: env.AWS_MANAGEMENT_EXTERNAL_ID }) : null;
  const api = new AwsApi(memberCredentials);
  const ec2 = new Ec2Client({ ...base, credentials: memberCredentials });
  try {
    const identity = await api.call<XmlNode>('sts','us-east-1','GetCallerIdentity',{}, { queryVersion:'2011-06-15' });
    const accountId = xmlText(identity,'GetCallerIdentityResult','Account');
    if (!accountId) throw new Error('AWS caller identity is unavailable');
    const session = await memberCredentials();
    await db.update(state).set({ accountId, connection: {
      ...claimed.connection,
      runtimeAuthorization: env.AWS_ROLE_ARN ? 'sts-assume-role' : 'access-key', automaticSessionRefresh: !!env.AWS_ROLE_ARN,
      sessionExpiresAt: session.expiration ? new Date(session.expiration).toISOString() : null,
      managementAuthorization: managementCredentials ? 'sts-assume-role' : 'not-configured',
      baseCredentialRotation: 'operator-managed', checkedAt: now.toISOString(),
    } }).where(eq(state.id,1));

    // Refresh billing separately: a Cost Explorer delay must not hide regional quota observations.
    if (managementCredentials && (force || !claimed.billingAt || now.getTime()-claimed.billingAt.getTime() >= 6*3_600_000)) {
      try { await syncBilling(db, new AwsApi(managementCredentials), accountId, now); }
      catch (e) {
        await db.update(state).set({ lastError: errorText(e), lastErrorAt: now }).where(eq(state.id,1));
      }
    }

    const result = await ec2.call('ap-southeast-2','DescribeRegions',{ AllRegions:true }, Date.now()+30_000,false);
    const discovered = xmlItems(result,'regionInfo').map((r)=>({ code:xmlText(r,'regionName')!, optIn:xmlText(r,'optInStatus') ?? 'unknown' })).filter((r)=>!!r.code);
    const existing = new Map((await db.select().from(regions).where(eq(regions.executor,'aws-ec2'))).map((r)=>[r.providerRegion,r]));
    const known = new Map((await db.select().from(catalog)).map((r)=>[r.providerRegion,r]));
    const errors: { region:string; error:string }[] = [];
    // Bounded concurrency respects API throttles and Worker connection limits.
    const pending = [...discovered];
    await Promise.all(Array.from({length:3},async()=>{
      for (let r=pending.shift(); r; r=pending.shift()) {
        const previous = existing.get(r.code);
        const regionId = previous?.id ?? r.code;
        let name = previous?.name ?? r.code;
        let country = previous?.country ?? ''; 
        try {
          if (!known.has(r.code) || force || !claimed.catalogAt || now.getTime()-claimed.catalogAt.getTime()>86_400_000) {
            const metadata = await api.call<{Parameters?:{Name:string;Value:string}[]}>('ssm','ap-southeast-2','AmazonSSM.GetParameters',{Names:[`/aws/service/global-infrastructure/regions/${r.code}/longName`,`/aws/service/global-infrastructure/regions/${r.code}/geolocationCountry`]});
            name = metadata.Parameters?.find((p)=>p.Name.endsWith('/longName'))?.Value || name;
            country = metadata.Parameters?.find((p)=>p.Name.endsWith('/geolocationCountry'))?.Value || country;
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
          if (!['opt-in-not-required','opted-in'].includes(r.optIn)) {
            await db.update(catalog).set({status:'not-enabled',capacity:0,checkedAt:now,lastError:'AWS region is not enabled for this account'}).where(eq(catalog.regionId,regionId));
            continue;
          }
          await syncRegion(db, env, ec2, memberCredentials, r.code, regionId, now, force);
        } catch (e) {
          const error = errorText(e); errors.push({region:r.code,error});
          await db.update(catalog).set({status:'unavailable',lastError:error,capacity:0}).where(eq(catalog.regionId,regionId));
        }
      }
    }));
    // API removals or account opt-out must withdraw old inventory too.
    for (const old of known.values()) if (!discovered.some((r)=>r.code===old.providerRegion)) await db.update(catalog).set({status:'not-supported',capacity:0,lastError:'No longer returned by AWS DescribeRegions'}).where(eq(catalog.regionId,old.regionId));
    await db.update(state).set({catalogAt:now}).where(eq(state.id,1));
    return {regions:discovered.length,errors};
  } catch (e) {
    await db.update(state).set({lastError:errorText(e),lastErrorAt:now}).where(eq(state.id,1));
    throw e;
  } finally {
    await db.update(state).set({syncLeaseUntil:new Date(0)}).where(eq(state.id,1));
  }
}

async function syncRegion(db: Db, env: Env, ec2: Ec2Client, credentials: () => Promise<AwsCredentials>, code: string, regionId: string, now: Date, force: boolean) {
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
  if (!config || !Object.keys(config.subnets).length) throw new Error('Regional browser network is not provisioned');
  const offerings=await all('DescribeInstanceTypeOfferings','instanceTypeOfferingSet',{
    LocationType:'availability-zone','Filter.1.Name':'instance-type',...Object.fromEntries(DEFAULT_INSTANCE_TYPES.map((t,i)=>[`Filter.1.Value.${i+1}`,t])),
  });
  const offered=DEFAULT_INSTANCE_TYPES.filter((type)=>offerings.some((o)=>xmlText(o,'instanceType')===type && xmlText(o,'location')! in config!.subnets));
  if (!offered.length) throw new Error('No supported browser machine is offered in the configured availability zones');
  // Per zone, so a launch never asks a zone for a type it does not offer (EC2: Unsupported).
  const zoneInstanceTypes=Object.fromEntries(Object.keys(config.subnets).map((zone)=>[zone,offered.filter((type)=>offerings.some((o)=>xmlText(o,'instanceType')===type && xmlText(o,'location')===zone))]));
  config={...config,instanceTypes:offered,zoneInstanceTypes};
  const executor=new AwsExecutor({accessKeyId:env.AWS_ACCESS_KEY_ID!,secretAccessKey:env.AWS_SECRET_ACCESS_KEY!,credentials,mode:'readonly',regions:{[code]:config},appUrl:'',agentImage:'',browserImage:''});
  const ctx={operationId:'aws-provider-sync',step:'provider-sync',token:'provider-sync',tags:{'cb:managed':'true' as const,'cb:env':env.ENV_NAME ?? 'prod','cb:instance':'provider-sync','cb:op':'provider-sync','cb:gen':'0'},deadline};
  const quotas:{metric:string;limit:number;used:number}[]=await executor.quotas(ctx,code);
  const [volumes,enis,subnets,machines,addresses,reservations]=await Promise.all([
    all('DescribeVolumes','volumeSet'), all('DescribeNetworkInterfaces','networkInterfaceSet'),
    all('DescribeSubnets','subnetSet',{'Filter.1.Name':'subnet-id',...Object.fromEntries(Object.values(config.subnets).map((v,i)=>[`Filter.1.Value.${i+1}`,v]))}),
    all('DescribeInstanceTypes','instanceTypeSet',Object.fromEntries(offered.map((v,i)=>[`InstanceType.${i+1}`,v]))),
    all('DescribeAddresses','addressesSet'),all('DescribeInstances','reservationSet',{'Filter.1.Name':'instance-state-name','Filter.1.Value.1':'pending','Filter.1.Value.2':'running'}),
  ]);
  const [storageLimit,eniLimit]=await Promise.all([ec2.serviceQuota(code,'ebs','L-7A658B76',deadline),ec2.serviceQuota(code,'vpc','L-DF5E4CA3',deadline)]);
  if (storageLimit===null || eniLimit===null || !quotas.some((q)=>q.metric==='static_ips') || !quotas.some((q)=>q.metric==='vcpus')) throw new Error('Required AWS quota is unavailable');
  quotas.push({metric:'gp3_gib',limit:storageLimit*1024,used:volumes.filter((v)=>xmlText(v,'volumeType')==='gp3').reduce((sum,v)=>sum+Number(xmlText(v,'size')),0)});
  quotas.push({metric:'network_interfaces',limit:eniLimit,used:enis.length});
  const [price]=await db.select().from(providerPrices).where(eq(providerPrices.regionId,regionId));
  const configurationKey=executor.pricingConfigKey(code);
  let sheet=price?.sheet as import('@cloudbrowser/contracts').ProviderPriceSheet|null;
  if (force || !price?.fetchedAt || now.getTime()-price.fetchedAt.getTime()>12*3_600_000 || configurationKey!==price.configurationKey) {
    const historical=await db.all<{instance_type:string}>(sql`SELECT DISTINCT instance_type FROM placements WHERE provider_region=${code} AND executor='aws-ec2' AND status IN ('current','building') AND instance_type IS NOT NULL`);
    sheet=await executor.prices(ctx,code,historical.map((p)=>p.instance_type));
    const values={executor:'aws-ec2',providerRegion:code,sheet,configurationKey,fetchedAt:now,lastError:null,lastErrorAt:null};
    await db.insert(providerPrices).values({regionId,...values}).onConflictDoUpdate({target:providerPrices.regionId,set:values});
  }
  if (!sheet) throw new Error('AWS prices are unavailable');
  const vcpu=Math.max(...machines.map((m)=>Number(xmlText(m,'vCpuInfo','defaultVCpus'))));
  if (!Number.isFinite(vcpu) || vcpu<=0) throw new Error('AWS machine CPU requirements are unavailable');
  const remaining=(metric:string)=>{const q=quotas.find((q)=>q.metric===metric)!;return Math.max(0,q.limit-q.used);};
  const [storage]=await db.all<{gb:number}>(sql`SELECT COALESCE(MAX("limit"),10) gb FROM caps WHERE metric='storage_gb'`);
  const subnetFree=subnets.reduce((n,s)=>n+Number(xmlText(s,'availableIpAddressCount')),0);
  const usedCpu=(i:XmlNode)=>Number(xmlText(i,'cpuOptions','coreCount'))*Number(xmlText(i,'cpuOptions','threadsPerCore'));
  const managedCpu=reservations.flatMap((r)=>xmlItems(r,'instancesSet')).filter(heldResource).reduce((n,i)=>n+usedCpu(i),0);
  const managedStorage=volumes.filter((v)=>heldResource(v) && xmlText(v,'volumeType')==='gp3').reduce((n,v)=>n+Number(xmlText(v,'size')),0);
  const capacity=Math.floor(Math.min(remaining('static_ips')+addresses.filter(heldResource).length,(remaining('vcpus')+managedCpu)/vcpu,(remaining('gp3_gib')+managedStorage)/((storage?.gb ?? 10)+sheet.rootVolumeGb),remaining('network_interfaces')+enis.filter(heldResource).length,subnetFree+enis.filter((e)=>heldResource(e) && Object.values(config!.subnets).includes(xmlText(e,'subnetId')!)).length));
  if (!Number.isFinite(capacity)) throw new Error('AWS returned an incomplete quota usage observation');
  await db.update(catalog).set({config:config as unknown as Record<string,unknown>,quotas,capacity:Math.max(0,capacity),checkedAt:now,status:'ready',lastError:null}).where(eq(catalog.regionId,regionId));
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
