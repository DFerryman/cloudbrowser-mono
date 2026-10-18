import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { internalApi } from '../src/internal.js';
import { setup } from './helpers.js';

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
  t.d1.sqlite.exec(`
    INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('command-owner', 'Owner', 'command@example.test', 0, 0);
    INSERT INTO browser_instances
      (id,user_id,name,region_id,status,desired_state,idle_timeout_s,locale,screen,fingerprint,created_at,updated_at)
      VALUES ('command-browser','command-owner','Browser','tyo1','stopping','stopped',900,'en-US','auto','{}',0,0);
    INSERT INTO agent_credentials (instance_id,generation,created_at) VALUES ('command-browser',1,0);
    INSERT INTO operations (id,instance_id,kind,status,deadline_at,created_at,updated_at,finished_at)
      VALUES ('old-op','command-browser','restore','canceled',9999999999999,0,1,1);
  `);
});
afterEach(() => t.d1.sqlite.close());

describe('late command replies after operation preemption', () => {
  it('cannot turn a canceled command back into success', async () => {
    t.d1.sqlite.exec(`INSERT INTO agent_commands (id,instance_id,kind,payload,status,reply,created_at,completed_at)
      VALUES ('old-op:restore:1','command-browser','restore_archive','{}','failed','{"error":"operation superseded"}',0,1)`);
    await internalApi(t.env as never).agentMessage('command-browser',1,{t:'reply',commandId:'old-op:restore:1',ok:true,result:{restored:true}});
    expect(t.d1.sqlite.prepare(`SELECT status,reply,completed_at FROM agent_commands`).get())
      .toEqual({status:'failed',reply:'{"error":"operation superseded"}',completed_at:1});
  });

  it('ignores a delivered command reply when its operation was canceled', async () => {
    t.d1.sqlite.exec(`INSERT INTO agent_commands (id,instance_id,kind,payload,status,created_at)
      VALUES ('old-op:restore:1','command-browser','restore_archive','{}','delivered',0)`);
    await internalApi(t.env as never).agentMessage('command-browser',1,{t:'reply',commandId:'old-op:restore:1',ok:true});
    expect(t.d1.sqlite.prepare(`SELECT status,completed_at FROM agent_commands`).get())
      .toEqual({status:'delivered',completed_at:null});
  });

  it('records the live operation reply only once and preserves the first result', async () => {
    t.d1.sqlite.exec(`UPDATE operations SET status='waiting',finished_at=NULL WHERE id='old-op';
      INSERT INTO agent_commands (id,instance_id,kind,payload,status,created_at)
      VALUES ('old-op:restore:1','command-browser','restore_archive','{}','delivered',0)`);
    const api=internalApi({...t.env,OPERATIONS:{send:async()=>{}}} as never);
    await api.agentMessage('command-browser',1,{t:'reply',commandId:'old-op:restore:1',ok:true,result:{version:'first'}});
    await api.agentMessage('command-browser',1,{t:'reply',commandId:'old-op:restore:1',ok:false,error:'late'});
    const row=t.d1.sqlite.prepare(`SELECT status,reply FROM agent_commands`).get() as {status:string;reply:string};
    expect(row.status).toBe('succeeded');
    expect(JSON.parse(row.reply)).toEqual({version:'first'});
  });

  it('still accepts independent periodic IP-check replies', async () => {
    t.d1.sqlite.exec(`INSERT INTO agent_commands (id,instance_id,kind,payload,status,created_at)
      VALUES ('ipcheck:command-browser:1','command-browser','ip_check','{}','delivered',0)`);
    await internalApi(t.env as never).agentMessage('command-browser',1,{t:'reply',commandId:'ipcheck:command-browser:1',ok:true});
    expect(t.d1.sqlite.prepare(`SELECT status FROM agent_commands`).get()).toEqual({status:'succeeded'});
  });
});
