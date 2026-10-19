import { expect, it, vi } from 'vitest';
import { assumeRoleCredentials, AwsApi } from '../src/index.js';

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
