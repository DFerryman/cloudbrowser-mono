import { createDb, awsInventory } from '@cloudbrowser/db';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { expect, it } from 'vitest';

function setup() {
  const d1=createTestD1();const db=createDb(d1);const now=Date.now();
  d1.sqlite.exec(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('u','test','u@example.test',1,${now},${now});
    UPDATE regions SET executor='aws-ec2',enabled=1;
    UPDATE aws_provider_settings SET inventory_mode='quota';
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

it('shares one budget across regions and updates inventory immediately when the budget changes',async()=>{
  const {d1,db,add,now}=setup();
  const unit=(await awsInventory(db)).get('syd1')!.monthly_unit_micros;
  d1.sqlite.prepare("UPDATE aws_provider_settings SET inventory_mode='budget',monthly_budget_micros=?").run(unit);
  d1.sqlite.prepare('UPDATE aws_provider_state SET billing=?,billing_at=?').run(JSON.stringify({month:new Date().toISOString().slice(0,7),spendMicros:0}),now);
  add('one','tyo1');
  expect(()=>add('two','syd1')).toThrow('aws_inventory_unavailable');
  d1.sqlite.prepare('UPDATE aws_provider_settings SET monthly_budget_micros=?').run(unit*2);
  expect((await awsInventory(db)).get('syd1')!.available).toBe(1);
  add('two');
  expect((await awsInventory(db)).get('usw1')!.available).toBe(0);
});

it('withdraws stale quotas and stale billing instead of treating missing data as free capacity',async()=>{
  const {d1,add,now}=setup();
  d1.sqlite.prepare("UPDATE aws_provider_regions SET checked_at=? WHERE region_id='syd1'").run(now-21*60_000);
  expect(()=>add('stale')).toThrow('aws_inventory_unavailable');
  d1.sqlite.exec("UPDATE aws_provider_settings SET inventory_mode='budget',monthly_budget_micros=1000000000;");
  expect(()=>add('billing','tyo1')).toThrow('aws_inventory_unavailable');
});

it('retains reservations until purge or the reaper confirms failed-create resources are absent',async()=>{
  const {d1,db,add}=setup();add('one');
  for(const status of ['failed','deleting']) {d1.sqlite.prepare('UPDATE browser_instances SET status=? WHERE id=?').run(status,'one');expect((await awsInventory(db)).get('syd1')!.available).toBe(0);}
  d1.sqlite.exec("UPDATE browser_instances SET status='failed', provider_released_at=1 WHERE id='one'");
  expect((await awsInventory(db)).get('syd1')!.available).toBe(1);
  d1.sqlite.exec("UPDATE browser_instances SET status='purged' WHERE id='one'");
  expect((await awsInventory(db)).get('syd1')!.available).toBe(1);
});


it('reserves a larger per-user storage default atomically against the same budget',async()=>{
  const {d1,db,add,now}=setup();
  const unit=(await awsInventory(db)).get('syd1')!.monthly_unit_micros;
  d1.sqlite.prepare("UPDATE aws_provider_settings SET inventory_mode='budget',monthly_budget_micros=?").run(unit);
  d1.sqlite.prepare('UPDATE aws_provider_state SET billing=?,billing_at=?').run(JSON.stringify({month:new Date().toISOString().slice(0,7),spendMicros:0}),now);
  expect(()=>add('large','syd1',100)).toThrow('aws_inventory_unavailable');
  add('normal');
});
