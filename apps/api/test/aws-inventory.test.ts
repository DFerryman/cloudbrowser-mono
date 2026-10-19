import { createDb, awsInventory } from '@cloudbrowser/db';
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
  const add=(id:string,region='syd1',storage=10)=>d1.sqlite.prepare("INSERT INTO browser_instances (id,user_id,name,region_id,status,desired_state,storage_gb,idle_timeout_s,locale,screen,fingerprint,created_at,updated_at) VALUES (?,?,?,?,'creating','running',?,1800,'en-US','auto','{}',?,?)").run(id,'u',id,region,storage,now,now);
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
