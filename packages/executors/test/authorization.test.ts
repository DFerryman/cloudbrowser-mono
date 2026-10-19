import { expect, it, vi } from 'vitest';
import { assumeRoleCredentials, AwsApi, Ec2Client } from '../src/index.js';

it('coalesces STS requests and refreshes before expiry without reusing expired credentials', async()=>{
  let now=Date.parse('2026-10-19T00:00:00Z');let calls=0;
  const request: typeof fetch=async()=>{
    calls++;
    return new Response(`<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>key${calls}</AccessKeyId><SecretAccessKey>secret</SecretAccessKey><SessionToken>session${calls}</SessionToken><Expiration>${new Date(now+3600_000).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`);
  };
  const credentials=assumeRoleCredentials({accessKeyId:'base',secretAccessKey:'base-secret'},{arn:'arn:aws:iam::123456789012:role/reader',externalId:'external'},request,()=>now);
  expect((await Promise.all([credentials(),credentials(),credentials()])).map((c)=>c.accessKeyId)).toEqual(['key1','key1','key1']);
  now+=54*60_000;expect((await credentials()).accessKeyId).toBe('key1');
  now+=2*60_000;expect((await credentials()).accessKeyId).toBe('key2');
  expect(calls).toBe(2);
});

it('does not fall back to expired credentials when STS permission is revoked',async()=>{
  let now=Date.now();let revoked=false;
  const request: typeof fetch=async()=>revoked ? new Response('<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>',{status:403}) : new Response(`<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>key</AccessKeyId><SecretAccessKey>secret</SecretAccessKey><SessionToken>token</SessionToken><Expiration>${new Date(now+3600_000).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`);
  const credentials=assumeRoleCredentials({accessKeyId:'base',secretAccessKey:'base-secret'},{arn:'reader'},request,()=>now);
  await credentials();now+=3600_000;revoked=true;
  await expect(credentials()).rejects.toThrow('AccessDenied');
  await expect(credentials()).rejects.toThrow('AccessDenied');
});

it('signs billing calls with the refreshed session token and correct AWS protocol',async()=>{
  const requests:Request[]=[];
  const api=new AwsApi(async()=>({accessKeyId:'session-key',secretAccessKey:'secret',sessionToken:'session-token'}),async(req)=>{requests.push(req as Request);return Response.json({credits:[]});});
  await api.call('billing','us-east-1','AWSBilling.GetCredits',{accountId:'123456789012',startDate:0});
  expect(requests[0]!.headers.get('x-amz-security-token')).toBe('session-token');
  expect(requests[0]!.headers.get('content-type')).toBe('application/x-amz-json-1.0');
  expect(requests[0]!.headers.get('x-amz-target')).toBe('AWSBilling.GetCredits');
});

it('preserves the Workers fetch receiver for native global functions',async()=>{
  vi.stubGlobal('fetch',function(this:unknown){expect(this).toBe(globalThis);return Promise.resolve(Response.json({ok:true}));});
  try {await new AwsApi(async()=>({accessKeyId:'key',secretAccessKey:'secret'})).call('billing','us-east-1','AWSBilling.GetCredits',{});}
  finally {vi.unstubAllGlobals();}
});

const session=(n:number,expires:number)=>new Response(`<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>key${n}</AccessKeyId><SecretAccessKey>secret</SecretAccessKey><SessionToken>session${n}</SessionToken><Expiration>${new Date(expires).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`);
const stsError=(code:string,status:number)=>new Response(`<ErrorResponse><Error><Code>${code}</Code></Error></ErrorResponse>`,{status});

it('retries STS throttling and outages, but not a refusal',async()=>{
  const now=Date.now();let calls=0;const waits:number[]=[];
  const replies=[()=>stsError('Throttling',400),()=>stsError('ServiceUnavailable',503),()=>session(1,now+3600_000)];
  const credentials=assumeRoleCredentials({accessKeyId:'base',secretAccessKey:'s'},{arn:'reader'},async()=>replies[calls++]!(),()=>now,async(ms)=>waits.push(ms));
  expect((await credentials()).accessKeyId).toBe('key1');
  expect(waits).toEqual([500,1000]);
  let denied=0;
  const refused=assumeRoleCredentials({accessKeyId:'base',secretAccessKey:'s'},{arn:'reader'},async()=>{denied++;return stsError('AccessDenied',403);},()=>now,async()=>{});
  await expect(refused()).rejects.toThrow('AccessDenied');
  expect(denied).toBe(1);
});

it('keeps a session that is still valid when renewal fails, and renews at once after invalidate',async()=>{
  let now=Date.now();let calls=0;let down=false;
  const credentials=assumeRoleCredentials({accessKeyId:'base',secretAccessKey:'s'},{arn:'reader'},async()=>{calls++;return down?stsError('ServiceUnavailable',503):session(calls,now+3600_000);},()=>now,async()=>{});
  expect((await credentials()).accessKeyId).toBe('key1');
  now+=57*60_000;down=true;
  expect((await credentials()).accessKeyId).toBe('key1');
  now+=2.5*60_000;
  await expect(credentials()).rejects.toThrow('ServiceUnavailable');
  down=false;expect((await credentials()).accessKeyId).toMatch(/^key/);
  const before=calls;credentials.invalidate!();
  expect((await credentials()).accessKeyId).toBe(`key${before+1}`);
});

it('renews an expired session and resends the AWS call once',async()=>{
  const now=Date.now();let sts=0;const seen:string[]=[];
  const credentials=assumeRoleCredentials({accessKeyId:'base',secretAccessKey:'s'},{arn:'reader'},async()=>{sts++;return session(sts,now+3600_000);},()=>now,async()=>{});
  const api=new AwsApi(credentials,async(req)=>{
    const token=(req as Request).headers.get('x-amz-security-token')!;seen.push(token);
    return token==='session1' ? Response.json({__type:'com.amazon.coral.service#ExpiredTokenException'},{status:400}) : Response.json({ok:true});
  });
  expect(await api.call('ce','us-east-1','AWSInsightsIndexService.GetCostAndUsage',{})).toEqual({ok:true});
  expect(seen).toEqual(['session1','session2']);
});

it('renews an expired session for an EC2 call, including a create AWS refused before acting',async()=>{
  const now=Date.now();let sts=0;const seen:string[]=[];
  const credentials=assumeRoleCredentials({accessKeyId:'base',secretAccessKey:'s'},{arn:'runtime'},async()=>{sts++;return session(sts,now+3600_000);},()=>now,async()=>{});
  const ec2=new Ec2Client({accessKeyId:'base',secretAccessKey:'s',credentials,endpoint:()=>'https://ec2.test/',fetch:async(req)=>{
    const token=(req as Request).headers.get('x-amz-security-token')!;seen.push(token);
    return token==='session1' ? new Response('<Response><Errors><Error><Code>RequestExpired</Code><Message>Request has expired.</Message></Error></Errors></Response>',{status:400}) : new Response('<RunInstancesResponse><reservationId>r-1</reservationId></RunInstancesResponse>');
  }});
  const out=await ec2.call('ap-southeast-2','RunInstances',{},Date.now()+30_000,true);
  expect(out.name).toBe('RunInstancesResponse');
  expect(seen).toEqual(['session1','session2']);
});

it('reports a failed renewal as retryable and nothing sent, not as an unknown create outcome',async()=>{
  let sent=0;
  const ec2=new Ec2Client({accessKeyId:'base',secretAccessKey:'s',credentials:async()=>{throw new Error('fetch failed');},endpoint:()=>'https://ec2.test/',fetch:async()=>{sent++;return new Response('<x/>');}});
  await expect(ec2.call('ap-southeast-2','RunInstances',{},Date.now()+30_000,true)).rejects.toMatchObject({errorClass:'retryable'});
  expect(sent).toBe(0);
});
