import { createDb, awsInventory } from '@cloudbrowser/db';
import { admitCreate } from '../src/limits.js';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { expect, it } from 'vitest';
import { setup as appSetup, signIn } from './helpers.js';

function setup() {
  const d1=createTestD1();const db=createDb(d1);const now=Date.now();
  d1.sqlite.exec(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('u','test','u@example.test',1,${now},${now});
    UPDATE regions SET executor='aws-ec2',enabled=1;
    UPDATE caps SET "limit"=100 WHERE scope='user:default' AND metric='instances';
    INSERT INTO aws_provider_regions (region_id,provider_region,opt_in_status,status,capacity,checked_at) SELECT id,provider_region,'opted-in','ready',1,${now} FROM regions;
    INSERT INTO provider_prices (region_id,executor,provider_region,sheet,fetched_at) SELECT id,executor,provider_region,'{"vmHour":0.1,"ipHour":0.005,"volumeGbMonth":0.08,"rootVolumeGb":16}',${now} FROM regions;`);
  const add=(id:string,region='syd1',storage=10,tier='basic')=>d1.sqlite.prepare("INSERT INTO browser_instances (id,user_id,name,region_id,tier,status,desired_state,storage_gb,idle_timeout_s,locale,screen,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,'creating','running',?,1800,'en-US','auto','{}',?,?)").run(id,'u',id,region,tier,storage,now,now);
  return {d1,db,add,now};
}

it('enforces the final regional slot atomically, including creates not yet present in AWS',async()=>{
  const {db,add}=setup();add('first');
  expect((await awsInventory(db)).get('syd1')?.available).toBe(0);
  expect(()=>add('second')).toThrow('aws_inventory_unavailable');
});

it('counts only what AWS can allocate: regions do not share a limit, and money does not limit it',async()=>{
  const {d1,db,add}=setup();
  d1.sqlite.exec("UPDATE aws_provider_regions SET capacity=3 WHERE region_id='syd1'");
  add('one','tyo1');
  expect((await awsInventory(db)).get('syd1')!.available).toBe(3);
  add('a');add('b','syd1',100);add('c');
  expect((await awsInventory(db)).get('syd1')!.available).toBe(0);
  expect(()=>add('d')).toThrow('aws_inventory_unavailable');
});

it('shares the vCPU room between tiers: a Premium browser holds twice what a Basic one does',async()=>{
  const {d1,db,add}=setup();
  // Other dimensions allow 10 browsers; 8 vCPUs fit four Basic (2 each) or two Premium (4 each).
  d1.sqlite.exec("UPDATE aws_provider_regions SET capacity=10,vcpu_capacity=8,basic_vcpus=2,premium_vcpus=4,premium_offered=1 WHERE region_id='syd1'");
  expect((await awsInventory(db)).get('syd1')!.availableByTier).toEqual({basic:4,premium:2});
  add('p1','syd1',10,'premium');
  expect((await awsInventory(db)).get('syd1')!.availableByTier).toEqual({basic:2,premium:1});
  add('b1');
  expect((await awsInventory(db)).get('syd1')!.availableByTier).toEqual({basic:1,premium:0});
  expect(()=>add('p2','syd1',10,'premium')).toThrow('aws_inventory_unavailable');
  add('b2');
  expect(()=>add('b3')).toThrow('aws_inventory_unavailable');
  // A sleeping Premium browser keeps its vCPUs so it can wake.
  d1.sqlite.exec("UPDATE browser_instances SET status='sleeping' WHERE id='p1'");
  expect((await awsInventory(db)).get('syd1')!.availableByTier).toEqual({basic:0,premium:0});
});

it('offers no Premium stock until the reconciler reports Premium machines and vCPU room',async()=>{
  const {d1,db,add}=setup();
  d1.sqlite.exec("UPDATE aws_provider_regions SET capacity=3 WHERE region_id='syd1'");
  // An older reconciler's capacity already counts Basic vCPUs; Premium waits for the new one.
  expect((await awsInventory(db)).get('syd1')!.availableByTier).toEqual({basic:3,premium:0});
  expect(()=>add('p','syd1',10,'premium')).toThrow('aws_inventory_unavailable');
  d1.sqlite.exec("UPDATE aws_provider_regions SET vcpu_capacity=16 WHERE region_id='syd1'");
  expect((await awsInventory(db)).get('syd1')!.availableByTier).toEqual({basic:3,premium:0});
  d1.sqlite.exec("UPDATE aws_provider_regions SET premium_offered=1 WHERE region_id='syd1'");
  expect((await awsInventory(db)).get('syd1')!.availableByTier).toEqual({basic:3,premium:3});
  add('p','syd1',10,'premium');
  expect((await awsInventory(db)).get('syd1')!.availableByTier).toEqual({basic:2,premium:2});
});

it('never changes a browser\'s tier',()=>{
  const {d1,add}=setup();add('one');
  expect(()=>d1.sqlite.exec("UPDATE browser_instances SET tier='premium' WHERE id='one'")).toThrow('tier is immutable');
});

it('withdraws stale quotas and prices instead of treating missing data as free capacity',async()=>{
  const {d1,add,now}=setup();
  d1.sqlite.prepare("UPDATE aws_provider_regions SET checked_at=? WHERE region_id='syd1'").run(now-21*60_000);
  expect(()=>add('stale')).toThrow('aws_inventory_unavailable');
  d1.sqlite.prepare("UPDATE provider_prices SET fetched_at=? WHERE region_id='tyo1'").run(now-49*3_600_000);
  expect(()=>add('old-prices','tyo1')).toThrow('aws_inventory_unavailable');
});

it('retains reservations until purge or the reaper confirms failed-create resources are absent',async()=>{
  const {d1,db,add}=setup();add('one');
  for(const status of ['failed','deleting','sleeping']) {d1.sqlite.prepare('UPDATE browser_instances SET status=? WHERE id=?').run(status,'one');expect((await awsInventory(db)).get('syd1')!.available).toBe(0);}
  d1.sqlite.exec("UPDATE browser_instances SET status='failed', provider_released_at=1 WHERE id='one'");
  expect((await awsInventory(db)).get('syd1')!.available).toBe(1);
  d1.sqlite.exec("UPDATE browser_instances SET status='purged' WHERE id='one'");
  expect((await awsInventory(db)).get('syd1')!.available).toBe(1);
});

it('gives the last slot to exactly one of two people creating at the same moment, and charges nothing to the other',async()=>{
  const t=appSetup();
  const now=Date.now();
  t.d1.sqlite.exec(`UPDATE regions SET executor='aws-ec2' WHERE id='tyo1';
    UPDATE provider_prices SET executor='aws-ec2' WHERE region_id='tyo1';
    INSERT INTO aws_provider_regions (region_id,provider_region,opt_in_status,status,capacity,checked_at) VALUES ('tyo1','ap-northeast-1','opt-in-not-required','ready',1,${now});
    INSERT INTO invites (email) VALUES ('a@example.com'),('b@example.com');`);
  // The engine is not under test here: keep the accepted create queued.
  t.env.OPERATIONS={send:async()=>{}} as never;
  const cookies:string[]=[];
  for (const email of ['a@example.com','b@example.com']) {await signIn(t,email);cookies.push(t.cookie());}
  const version=(await t.call('GET','/api/v1/pricing')).body.find((p:{regionId:string})=>p.regionId==='tyo1').version as string;
  expect((await t.call('GET','/api/v1/regions')).body.find((r:{id:string})=>r.id==='tyo1').inventory.available).toBe(1);
  // Hold each create's transaction until both requests passed admission, as two Workers would.
  const batch=t.d1.batch.bind(t.d1);let arrived=0;let release=()=>{};const both=new Promise<void>((r)=>{release=r;});
  // D1 runs one transaction at a time; so does this queue.
  let queue:Promise<unknown>=Promise.resolve();
  t.d1.batch=(async(stmts:never)=>{if(++arrived===2) release();await Promise.race([both,new Promise((r)=>setTimeout(r,2000))]);const run=queue.then(()=>batch(stmts));queue=run.catch(()=>{});return run;}) as never;
  const create=(cookie:string,key:string)=>t.call('POST','/api/v1/instances',{name:key,regionId:'tyo1',storageGb:10,priceVersion:version},{cookie,'idempotency-key':key});
  const results=await Promise.all([create(cookies[0]!,'a'),create(cookies[1]!,'b')]);
  expect(results.map((r)=>r.status).sort(),JSON.stringify(results)).toEqual([202,409]);
  const lost=results.find((r)=>r.status===409)!;
  expect(lost.body).toMatchObject({type:'region_unavailable',limit:'no_stock'});
  // Both passed admission before either committed; the create trigger refused the second.
  expect(lost.body.detail).toContain('just took the last');
  t.d1.batch=batch;
  // Nothing of the refused create survives its transaction.
  expect(t.d1.sqlite.prepare("SELECT COUNT(*) n FROM browser_instances WHERE region_id='tyo1'").get()).toEqual({n:1});
  expect(t.d1.sqlite.prepare("SELECT COUNT(*) n FROM operations WHERE kind='create'").get()).toEqual({n:1});
  expect(t.d1.sqlite.prepare('SELECT COUNT(*) n FROM idempotency_keys').get()).toEqual({n:1});
  const region=(await t.call('GET','/api/v1/regions',undefined,{cookie:cookies[0]!})).body.find((r:{id:string})=>r.id==='tyo1');
  expect(region).toMatchObject({acceptingNew:false,availability:'unavailable',availabilityReason:'no_stock',inventory:{available:0}});
});

it('ends with a clean schema: the view has only the current columns and users have no running cap',()=>{
  const {d1}=setup();
  const columns=(d1.sqlite.prepare('PRAGMA table_info(aws_region_inventory)').all() as {name:string}[]).map((c)=>c.name);
  expect(columns).toEqual(['region_id','checked_at','status','availability','reason','premium_offered','last_error','last_error_at','sync_failures','quota_available','premium_available']);
  expect(d1.sqlite.prepare("SELECT COUNT(*) n FROM caps WHERE metric='running' AND scope LIKE 'user:%'").get()).toEqual({n:0});
});

it('says why a region is unavailable: an expired snapshot or a failing refresh is not an empty quota',async()=>{
  const {d1,db,add,now}=setup();
  d1.sqlite.exec("UPDATE aws_provider_regions SET capacity=5 WHERE region_id='syd1'");
  const syd=async()=>(await awsInventory(db)).get('syd1')!;
  expect(await syd()).toMatchObject({availability:'ready',reason:null,quota_available:5,available:5});
  // 20 minutes and 14 seconds old, with 5 browsers of quota left: stale, quota untouched.
  d1.sqlite.exec(`UPDATE aws_provider_regions SET checked_at=${now-1_214_000} WHERE region_id='syd1'`);
  expect(await syd()).toMatchObject({availability:'unavailable',reason:'stale',quota_available:5,available:0});
  expect(()=>add('blocked')).toThrow('aws_inventory_unavailable');
  d1.sqlite.exec(`UPDATE aws_provider_regions SET last_error='DescribeVolumes: deadline passed',sync_failures=3 WHERE region_id='syd1'`);
  expect(await syd()).toMatchObject({reason:'stale',last_error:'DescribeVolumes: deadline passed',sync_failures:3});
  d1.sqlite.exec(`UPDATE aws_provider_regions SET status='unavailable',checked_at=${now} WHERE region_id='syd1'`);
  expect((await syd()).reason).toBe('sync_failed');
  d1.sqlite.exec(`UPDATE aws_provider_regions SET status='syncing',last_error=NULL WHERE region_id='syd1'`);
  expect((await syd()).reason).toBe('pending');
  d1.sqlite.exec(`UPDATE aws_provider_regions SET status='ready'; UPDATE provider_prices SET fetched_at=${now-3*86_400_000} WHERE region_id='syd1'`);
  expect((await syd()).reason).toBe('prices');
  d1.sqlite.exec("UPDATE regions SET enabled=0 WHERE id='syd1'");
  expect((await syd()).reason).toBe('disabled');
});

it('tells users a region is being checked, not full, while its snapshot is stale',async()=>{
  const t=appSetup();
  const now=Date.now();
  t.d1.sqlite.exec(`UPDATE regions SET executor='aws-ec2' WHERE id='tyo1';
    UPDATE provider_prices SET executor='aws-ec2' WHERE region_id='tyo1';
    INSERT INTO aws_provider_regions (region_id,provider_region,opt_in_status,status,capacity,checked_at) VALUES ('tyo1','ap-northeast-1','opt-in-not-required','ready',5,${now-1_214_000});
    INSERT INTO invites (email) VALUES ('a@example.com');`);
  await signIn(t,'a@example.com');
  const region=(await t.call('GET','/api/v1/regions')).body.find((r:{id:string})=>r.id==='tyo1');
  expect(region).toMatchObject({acceptingNew:false,availability:'unavailable',availabilityReason:'refreshing',inventory:{status:'unavailable',constraint:'sync_unavailable'}});
  // A region whose refresh keeps failing (UAE without a browser network) is not coming back on its own.
  t.d1.sqlite.exec(`UPDATE aws_provider_regions SET status='unavailable',capacity=0,last_error='Regional browser network is not provisioned' WHERE region_id='tyo1'`);
  const failing=(await t.call('GET','/api/v1/regions')).body.find((r:{id:string})=>r.id==='tyo1');
  expect(failing).toMatchObject({acceptingNew:false,availability:'unavailable',availabilityReason:'closed'});
});

it('refuses a create in a stale region as "refreshing", and in a failing one without blaming AWS quota',async()=>{
  const {d1,db,now}=setup();
  d1.sqlite.exec(`UPDATE aws_provider_regions SET capacity=5,checked_at=${now-1_214_000} WHERE region_id='syd1'`);
  d1.sqlite.exec("UPDATE control_flags SET value='false' WHERE key='billing_required'");
  const refused=async()=>admitCreate(db,'u','syd1',new Date()).then(()=>null,(e:{type:string;detail?:string;extra:{limit?:string}})=>({type:e.type,detail:e.detail,limit:e.extra.limit}));
  expect(await refused()).toMatchObject({type:'region_unavailable',limit:'refreshing'});
  d1.sqlite.exec(`UPDATE aws_provider_regions SET status='unavailable',last_error='Regional browser network is not provisioned' WHERE region_id='syd1'`);
  const failing=await refused();
  expect(failing).toEqual({type:'region_unavailable',detail:'New browsers are temporarily unavailable in this region. Choose another region.',limit:undefined});
});
