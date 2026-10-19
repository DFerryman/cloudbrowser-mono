import { AwsClient } from 'aws4fetch';
import { parseXml, text } from './xml.js';

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: number }
/** `invalidate` drops a cached session AWS refused (expired or revoked early); the next call renews it. */
export type AwsCredentialProvider = (() => Promise<AwsCredentials>) & { invalidate?: () => void };
export interface AwsRole { arn: string; externalId?: string }

/** AWS refused the request's session itself: renew it and send the request again. */
export const SESSION_EXPIRED = new Set(['ExpiredToken', 'ExpiredTokenException', 'RequestExpired', 'TokenRefreshRequired']);
const STS_RETRYABLE = new Set(['Throttling', 'ThrottlingException', 'RequestLimitExceeded', 'ServiceUnavailable', 'InternalFailure', 'IDPCommunicationError']);
const RENEW_BEFORE_MS = 300_000;
/** A renewal that fails may keep using a session with at least this much time left. */
const MIN_REMAINING_MS = 60_000;

/**
 * STS AssumeRole sessions, cached per Worker isolate. Renewed five minutes before expiry (or at
 * once after `invalidate`); concurrent callers share one STS request. Throttling, STS outages and
 * network errors are retried; if renewal still fails, a session with more than a minute left is
 * used rather than failing the caller, and an expired one is never used.
 */
export function assumeRoleCredentials(base: AwsCredentials, role: AwsRole, request: typeof fetch = globalThis.fetch.bind(globalThis), now: () => number = Date.now, sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))): AwsCredentialProvider {
  let cached: AwsCredentials | undefined;
  let pending: Promise<AwsCredentials> | undefined;
  const assume = async (): Promise<AwsCredentials> => {
    const signer = new AwsClient({ ...base, service: 'sts', region: 'us-east-1', retries: 0 });
    const req = await signer.sign('https://sts.us-east-1.amazonaws.com/', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: role.arn, RoleSessionName: 'nevazu-provider', DurationSeconds: '3600', ...(role.externalId ? { ExternalId: role.externalId } : {}) }).toString(),
    });
    const res = await request(req, { signal: AbortSignal.timeout(20_000) });
    const doc = parseXml(await res.text()).children[0];
    if (!res.ok) {
      const code = text(doc, 'Error', 'Code') ?? `HTTP${res.status}`;
      throw Object.assign(new Error(`AWS AssumeRole: ${code}`), { retryable: STS_RETRYABLE.has(code) || res.status === 429 || res.status >= 500 });
    }
    const result = doc?.children.find((n) => n.name === 'AssumeRoleResult');
    const accessKeyId = text(result, 'Credentials', 'AccessKeyId');
    const secretAccessKey = text(result, 'Credentials', 'SecretAccessKey');
    const sessionToken = text(result, 'Credentials', 'SessionToken');
    const expiration = Date.parse(text(result, 'Credentials', 'Expiration') ?? '');
    if (!accessKeyId || !secretAccessKey || !sessionToken || !Number.isFinite(expiration) || expiration <= now() + RENEW_BEFORE_MS) throw new Error('AWS AssumeRole returned invalid credentials');
    return { accessKeyId, secretAccessKey, sessionToken, expiration };
  };
  const renew = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return cached = await assume();
      } catch (e) {
        // A network failure has no AWS code; a refusal such as AccessDenied will not change on retry.
        const retryable = (e as { retryable?: boolean }).retryable ?? !(e instanceof Error && e.message.startsWith('AWS AssumeRole'));
        if (!retryable || attempt >= 3) {
          if (cached?.expiration && cached.expiration - now() > MIN_REMAINING_MS) return cached;
          throw e;
        }
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  };
  const provider: AwsCredentialProvider = async () => {
    if (cached?.expiration && cached.expiration - now() > RENEW_BEFORE_MS) return cached;
    if (!pending) pending = renew().finally(() => { pending = undefined; });
    return pending;
  };
  provider.invalidate = () => { cached = undefined; };
  return provider;
}

/** AWS JSON/Query APIs used for provider discovery and billing, with short-lived role credentials. */
export class AwsApi {
  constructor(readonly credentials: AwsCredentialProvider, private readonly request: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  async call<T>(service: string, region: string, target: string, body: Record<string, unknown>, opts: { queryVersion?: string; path?: string; method?: string } = {}): Promise<T> {
    try {
      return await this.send<T>(service, region, target, body, opts);
    } catch (e) {
      // The session expired or was revoked early: renew it once and send again.
      if (!(e instanceof AwsApiError) || !SESSION_EXPIRED.has(e.code) || !this.credentials.invalidate) throw e;
      this.credentials.invalidate();
      return this.send<T>(service, region, target, body, opts);
    }
  }

  private async send<T>(service: string, region: string, target: string, body: Record<string, unknown>, opts: { queryVersion?: string; path?: string; method?: string }): Promise<T> {
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
      throw new AwsApiError(code, `AWS ${service}/${target || opts.path}: ${code}`);
    }
    return (opts.queryVersion ? parseXml(raw).children[0] : JSON.parse(raw || '{}')) as T;
  }
}

export class AwsApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
