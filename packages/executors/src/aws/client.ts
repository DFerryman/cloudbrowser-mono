/**
 * Signed calls to the EC2 Query API, the Service Quotas JSON API and the Price List Query API
 * (SigV4 through aws4fetch).
 * Every failure leaves here as an ExecutorError with its class (page 10, "Executor interface").
 */
import { AwsClient } from 'aws4fetch';
import { ExecutorError, type ErrorClass } from '../executor.js';
import { parseXml, text, type XmlNode } from './xml.js';
import { SESSION_EXPIRED, type AwsCredentialProvider } from './authorization.js';

export type Params = Record<string, string | number | boolean | undefined>;

const CAPACITY = new Set([
  'InsufficientInstanceCapacity',
  'InsufficientAddressCapacity',
  'InsufficientCapacity',
  'InsufficientVolumeCapacity',
  'InsufficientHostCapacity',
  'InsufficientReservedInstanceCapacity',
  'Unsupported', // the instance type is not offered in this zone
]);
const QUOTA = new Set([
  'AddressLimitExceeded',
  'VcpuLimitExceeded',
  'InstanceLimitExceeded',
  'VolumeLimitExceeded',
  'MaxIOPSLimitExceeded',
  'NetworkInterfaceLimitExceeded',
  'ResourceLimitExceeded',
  'SnapshotLimitExceeded',
  'MaxSpotInstanceCountExceeded',
]);
const FORBIDDEN = new Set([
  'UnauthorizedOperation',
  'AuthFailure',
  'Blocked',
  'OptInRequired',
  'PendingVerification',
  'SignatureDoesNotMatch',
  'InvalidClientTokenId',
  'AccessDenied',
  'AccessDeniedException',
  'UnrecognizedClientException',
]);
const RETRYABLE = new Set([
  'RequestLimitExceeded',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'InternalError',
  'InternalFailure',
  'ServiceUnavailable',
  'Unavailable',
  'IncorrectState',
  'IncorrectInstanceState',
  'VolumeInUse',
  'InvalidNetworkInterface.InUse',
  'DependencyViolation',
  'InvalidIPAddress.InUse',
  'IncorrectModificationState', // a volume modification is still in progress
  ...SESSION_EXPIRED, // AWS did nothing; a renewed session can try again
]);

export function classify(code: string, status: number): ErrorClass {
  if (CAPACITY.has(code)) return 'capacity';
  if (QUOTA.has(code)) return 'quota';
  if (FORBIDDEN.has(code) || status === 401 || status === 403) return 'forbidden';
  if (RETRYABLE.has(code) || status === 429 || status >= 500) return 'retryable';
  return 'invalid';
}

/** Pauses before a read-only call is sent again after a transient failure. */
const READ_RETRY_MS = [250, 1_000];
/** One read-only request; Describe calls answer in well under a second when AWS is healthy. */
const READ_TIMEOUT_MS = 12_000;

/** An EC2 error with its provider code, e.g. `InvalidVolume.NotFound`. */
export class Ec2Error extends ExecutorError {
  constructor(
    errorClass: ErrorClass,
    readonly code: string,
    message: string,
  ) {
    super(errorClass, `${code}: ${message}`);
  }
}

// A malformed id is not proof that the intended resource was deleted.
export const isNotFound = (e: unknown) => e instanceof Ec2Error && /NotFound$/.test(e.code);

/**
 * AWS refused this account the action in this region (IAM or an organization SCP, an opt-in
 * region that is not enabled): every launch there is refused the same way until that changes.
 * Bad credentials are not regional, and our own guardrails are not AWS errors.
 */
const REGION_DENIALS = new Set(['UnauthorizedOperation', 'AccessDenied', 'AccessDeniedException', 'OptInRequired', 'Blocked']);
export const isRegionDenial = (e: unknown) => e instanceof Ec2Error && REGION_DENIALS.has(e.code);

type Service = 'ec2' | 'servicequotas' | 'pricing';

/** One product from the Price List API: its attributes and on-demand price dimensions. */
export interface PriceListProduct {
  attributes: Record<string, string>;
  onDemand: { unit: string; usd: number; beginRange: string; description: string }[];
  effectiveDate: string | null;
}

export interface ClientOptions {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  credentials?: AwsCredentialProvider;
  /** Tests point this at a fake EC2. */
  endpoint?: (service: Service, region: string) => string;
  fetch?: typeof fetch;
}

export class Ec2Client {
  private readonly signers = new Map<string, AwsClient>();
  constructor(private readonly opts: ClientOptions) {}

  private async signer(service: string, region: string) {
    let credentials: Pick<ClientOptions, 'accessKeyId' | 'secretAccessKey' | 'sessionToken'>;
    try {
      credentials = this.opts.credentials ? await this.opts.credentials() : this.opts;
    } catch (e) {
      // No request was sent, so nothing happened at AWS. A role AWS refuses needs an operator.
      const message = (e as Error).message;
      throw new ExecutorError(/AccessDenied|InvalidClientTokenId|SignatureDoesNotMatch|invalid credentials/.test(message) ? 'forbidden' : 'retryable', `AWS session renewal failed: ${message}`);
    }
    const key = `${service}/${region}/${credentials.accessKeyId}`;
    let s = this.signers.get(key);
    if (!s) {
      // Retries are ours (the engine's journal decides), never aws4fetch's.
      this.signers.clear();
      s = new AwsClient({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, service, region, retries: 0 });
      this.signers.set(key, s);
    }
    return s;
  }

  private url(service: Service, region: string) {
    if (this.opts.endpoint) return this.opts.endpoint(service, region);
    // The Price List Query API lives in a few regions only; us-east-1 serves every region's prices.
    return service === 'pricing' ? 'https://api.pricing.us-east-1.amazonaws.com/' : `https://${service}.${region}.amazonaws.com/`;
  }

  /**
   * One Query API call. `mutating` decides how a lost response is classified: a create that may
   * have happened is `unknown_outcome` (look up before retrying); a read is just `retryable`.
   */
  async call(region: string, action: string, params: Params, deadline: number, mutating: boolean, assertActive?: () => Promise<void>): Promise<XmlNode> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(region, action, params, deadline, mutating, assertActive);
      } catch (e) {
        // A read changes nothing at AWS, so a transient failure (a timeout, a 5xx such as
        // Cloudflare's 520 on the way to AWS, throttling) is retried while the deadline allows.
        // One slow Describe used to fail the whole reconcile run. Writes are left to the journal.
        const wait = READ_RETRY_MS[attempt];
        if (mutating || wait === undefined || !(e instanceof ExecutorError) || e.errorClass !== 'retryable' || deadline - Date.now() < wait + 2_000) throw e;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  private async callOnce(region: string, action: string, params: Params, deadline: number, mutating: boolean, assertActive?: () => Promise<void>): Promise<XmlNode> {
    try {
      return await this.send(region, action, params, deadline, mutating, assertActive);
    } catch (e) {
      // AWS refused the session before acting, even for a create: renew it once and send again.
      if (!(e instanceof Ec2Error) || !SESSION_EXPIRED.has(e.code) || !this.opts.credentials?.invalidate) throw e;
      this.opts.credentials.invalidate();
      return this.send(region, action, params, deadline, mutating, assertActive);
    }
  }

  private async send(region: string, action: string, params: Params, deadline: number, mutating: boolean, assertActive?: () => Promise<void>): Promise<XmlNode> {
    await assertActive?.();
    const body = new URLSearchParams({ Action: action, Version: '2016-11-15' });
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ExecutorError(mutating ? 'unknown_outcome' : 'retryable', `${action}: deadline passed`);
    const signer = await this.signer('ec2', region);
    let req: Request;
    try {
      req = await signer.sign(this.url('ec2', region), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: body.toString(),
      });
    } catch (e) {
      throw new ExecutorError(mutating ? 'unknown_outcome' : 'retryable', `${action}: ${(e as Error).message}`);
    }
    // Signing can yield to a newer stop/delete intent. Keep this callback outside the provider
    // error wrapper: an operation cancellation is neither an outage nor an unknown AWS outcome.
    await assertActive?.();
    const requestRemaining = deadline - Date.now();
    if (requestRemaining <= 0) throw new ExecutorError(mutating ? 'unknown_outcome' : 'retryable', `${action}: deadline passed`);
    let res: Response;
    try {
      // A read that hangs gives up sooner, leaving time to retry it within the same deadline.
      res = await (this.opts.fetch ?? fetch)(req, { signal: AbortSignal.timeout(Math.min(requestRemaining, mutating ? 30_000 : READ_TIMEOUT_MS)) });
    } catch (e) {
      throw new ExecutorError(mutating ? 'unknown_outcome' : 'retryable', `${action}: ${(e as Error).message}`);
    }
    const xml = await res.text();
    const doc = parseXml(xml);
    if (!res.ok) {
      const err = doc.children[0];
      const code = text(err, 'Errors', 'Error', 'Code') ?? text(err, 'Error', 'Code') ?? `HTTP${res.status}`;
      const message = text(err, 'Errors', 'Error', 'Message') ?? text(err, 'Error', 'Message') ?? xml.slice(0, 200);
      const cls = classify(code, res.status);
      // A 5xx on a create may still have created something.
      throw new Ec2Error(cls === 'retryable' && mutating && res.status >= 500 ? 'unknown_outcome' : cls, code, message);
    }
    return doc.children[0] ?? doc;
  }

  /** Service Quotas (JSON 1.1). Returns null when the quota cannot be read. */
  async serviceQuota(region: string, serviceCode: string, quotaCode: string, deadline: number): Promise<number | null> {
    try {
      const signer = await this.signer('servicequotas', region);
      const req = await signer.sign(this.url('servicequotas', region), {
        method: 'POST',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'ServiceQuotasV20190624.GetServiceQuota' },
        body: JSON.stringify({ ServiceCode: serviceCode, QuotaCode: quotaCode }),
      });
      const res = await (this.opts.fetch ?? fetch)(req, { signal: AbortSignal.timeout(Math.max(1, Math.min(deadline - Date.now(), 15_000))) });
      if (!res.ok) return null;
      const out = (await res.json()) as { Quota?: { Value?: number } };
      return typeof out.Quota?.Value === 'number' ? out.Quota.Value : null;
    } catch {
      return null;
    }
  }

  /**
   * Price List Query API `GetProducts` (JSON 1.1, all pages). Each price list item is a JSON string
   * with the product's attributes and its terms; only on-demand prices are kept. Errors are
   * `retryable`: the engine keeps the last good prices and tries again later.
   */
  async products(serviceCode: string, filters: Record<string, string>, deadline: number): Promise<PriceListProduct[]> {
    const signer = await this.signer('pricing', 'us-east-1');
    const out: PriceListProduct[] = [];
    let next: string | undefined;
    do {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ExecutorError('retryable', `GetProducts ${serviceCode}: deadline passed`);
      const body = {
        ServiceCode: serviceCode,
        FormatVersion: 'aws_v1',
        MaxResults: 100,
        Filters: Object.entries(filters).map(([Field, Value]) => ({ Type: 'TERM_MATCH', Field, Value })),
        ...(next ? { NextToken: next } : {}),
      };
      let res: Response;
      try {
        const req = await signer.sign(this.url('pricing', 'us-east-1'), {
          method: 'POST',
          headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSPriceListService.GetProducts' },
          body: JSON.stringify(body),
        });
        res = await (this.opts.fetch ?? fetch)(req, { signal: AbortSignal.timeout(Math.min(remaining, 20_000)) });
      } catch (e) {
        throw new ExecutorError('retryable', `GetProducts ${serviceCode}: ${(e as Error).message}`);
      }
      const text = await res.text();
      if (!res.ok) {
        const code = (() => {
          try {
            return String((JSON.parse(text) as { __type?: string }).__type ?? '').split('#').pop() ?? '';
          } catch {
            return '';
          }
        })();
        throw new ExecutorError(classify(code, res.status) === 'forbidden' ? 'forbidden' : 'retryable', `GetProducts ${serviceCode}: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      const page = JSON.parse(text) as { PriceList?: unknown[]; NextToken?: string };
      for (const raw of page.PriceList ?? []) out.push(parsePriceListItem(typeof raw === 'string' ? JSON.parse(raw) : raw));
      next = page.NextToken || undefined;
    } while (next);
    return out;
  }
}

/** Normalizes one Price List item (`{ product: { attributes }, terms: { OnDemand } }`). */
export function parsePriceListItem(item: unknown): PriceListProduct {
  const o = (item ?? {}) as { product?: { attributes?: Record<string, string> }; terms?: { OnDemand?: Record<string, unknown> }; publicationDate?: string };
  const onDemand: PriceListProduct['onDemand'] = [];
  let effectiveDate: string | null = null;
  for (const term of Object.values(o.terms?.OnDemand ?? {}) as { effectiveDate?: string; priceDimensions?: Record<string, unknown> }[]) {
    effectiveDate ??= term.effectiveDate ?? null;
    for (const d of Object.values(term.priceDimensions ?? {}) as { unit?: string; pricePerUnit?: { USD?: string }; beginRange?: string; description?: string }[]) {
      const usd = Number(d.pricePerUnit?.USD);
      if (Number.isFinite(usd)) onDemand.push({ unit: d.unit ?? '', usd, beginRange: d.beginRange ?? '0', description: d.description ?? '' });
    }
  }
  return { attributes: o.product?.attributes ?? {}, onDemand, effectiveDate: effectiveDate ?? o.publicationDate ?? null };
}
