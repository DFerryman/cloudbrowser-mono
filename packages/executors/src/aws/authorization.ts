import { AwsClient } from 'aws4fetch';
import { parseXml, text } from './xml.js';

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: number }
export type AwsCredentialProvider = () => Promise<AwsCredentials>;
export interface AwsRole { arn: string; externalId?: string }

/** Request-scoped cache. Refresh five minutes before expiry; coalesce concurrent STS requests. */
export function assumeRoleCredentials(base: AwsCredentials, role: AwsRole, request: typeof fetch = globalThis.fetch.bind(globalThis), now: () => number = Date.now): AwsCredentialProvider {
  let cached: AwsCredentials | undefined;
  let pending: Promise<AwsCredentials> | undefined;
  return async () => {
    if (cached?.expiration && cached.expiration - now() > 300_000) return cached;
    if (!pending) pending = (async () => {
      const signer = new AwsClient({ ...base, service: 'sts', region: 'us-east-1', retries: 0 });
      const req = await signer.sign('https://sts.us-east-1.amazonaws.com/', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: role.arn, RoleSessionName: 'nevazu-provider', DurationSeconds: '3600', ...(role.externalId ? { ExternalId: role.externalId } : {}) }).toString(),
      });
      const res = await request(req, { signal: AbortSignal.timeout(20_000) });
      const doc = parseXml(await res.text()).children[0];
      if (!res.ok) throw new Error(`AWS AssumeRole: ${text(doc, 'Error', 'Code') ?? res.status}`);
      const result = doc?.children.find((n) => n.name === 'AssumeRoleResult');
      const accessKeyId = text(result, 'Credentials', 'AccessKeyId');
      const secretAccessKey = text(result, 'Credentials', 'SecretAccessKey');
      const sessionToken = text(result, 'Credentials', 'SessionToken');
      const expiration = Date.parse(text(result, 'Credentials', 'Expiration') ?? '');
      if (!accessKeyId || !secretAccessKey || !sessionToken || !Number.isFinite(expiration) || expiration <= now() + 300_000) throw new Error('AWS AssumeRole returned invalid credentials');
      return cached = { accessKeyId, secretAccessKey, sessionToken, expiration };
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

/** AWS JSON/Query APIs used for provider discovery and billing, with short-lived role credentials. */
export class AwsApi {
  constructor(readonly credentials: AwsCredentialProvider, private readonly request: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  async call<T>(service: string, region: string, target: string, body: Record<string, unknown>, opts: { queryVersion?: string; path?: string; method?: string } = {}): Promise<T> {
    const signer = new AwsClient({ ...await this.credentials(), service, region, retries: 0 });
    // AWS global billing services use their published global/dual-stack endpoints.
    const endpoint = service === 'billing' ? 'billing.us-east-1.api.aws' : service === 'budgets' ? 'budgets.us-east-1.api.aws' : service === 'ce' ? 'ce.us-east-1.amazonaws.com' : service === 'pricing' ? 'api.pricing.us-east-1.amazonaws.com' : `${service}.${region}.amazonaws.com`;
    const req = await signer.sign(`https://${endpoint}${opts.path ?? '/'}`, {
      method: opts.method ?? 'POST',
      headers: opts.queryVersion ? { 'content-type': 'application/x-www-form-urlencoded' } : { 'content-type': service==='billing' ? 'application/x-amz-json-1.0' : 'application/x-amz-json-1.1', ...(target ? { 'x-amz-target': target } : {}) },
      body: opts.method === 'GET' ? undefined : opts.queryVersion ? new URLSearchParams({ Action: target, Version: opts.queryVersion, ...Object.fromEntries(Object.entries(body).map(([k,v])=>[k,String(v)])) }).toString() : JSON.stringify(body),
    });
    const res = await this.request(req, { signal: AbortSignal.timeout(25_000) });
    const raw = await res.text();
    if (!res.ok) {
      let code = `HTTP${res.status}`;
      try { const e = JSON.parse(raw) as { __type?: string; code?: string }; code = (e.__type ?? e.code ?? code).split('#').pop()!; }
      catch { code = text(parseXml(raw).children[0], 'Error', 'Code') ?? code; }
      throw new Error(`AWS ${service}/${target || opts.path}: ${code}`);
    }
    return (opts.queryVersion ? parseXml(raw).children[0] : JSON.parse(raw || '{}')) as T;
  }
}
