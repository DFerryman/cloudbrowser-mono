/**
 * Signed calls to the EC2 Query API and the Service Quotas JSON API (SigV4 through aws4fetch).
 * Every failure leaves here as an ExecutorError with its class (page 10, "Executor interface").
 */
import { AwsClient } from 'aws4fetch';
import { ExecutorError, type ErrorClass } from '../executor.js';
import { parseXml, text, type XmlNode } from './xml.js';

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
]);

export function classify(code: string, status: number): ErrorClass {
  if (CAPACITY.has(code)) return 'capacity';
  if (QUOTA.has(code)) return 'quota';
  if (FORBIDDEN.has(code) || status === 401 || status === 403) return 'forbidden';
  if (RETRYABLE.has(code) || status === 429 || status >= 500) return 'retryable';
  return 'invalid';
}

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

export const isNotFound = (e: unknown) => e instanceof Ec2Error && /NotFound$|\.Malformed$/.test(e.code);

export interface ClientOptions {
  accessKeyId: string;
  secretAccessKey: string;
  /** Tests point this at a fake EC2. */
  endpoint?: (service: 'ec2' | 'servicequotas', region: string) => string;
  fetch?: typeof fetch;
}

export class Ec2Client {
  private readonly signers = new Map<string, AwsClient>();
  constructor(private readonly opts: ClientOptions) {}

  private signer(service: string, region: string) {
    const key = `${service}/${region}`;
    let s = this.signers.get(key);
    if (!s) {
      // Retries are ours (the engine's journal decides), never aws4fetch's.
      s = new AwsClient({ accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey, service, region, retries: 0 });
      this.signers.set(key, s);
    }
    return s;
  }

  private url(service: 'ec2' | 'servicequotas', region: string) {
    return this.opts.endpoint?.(service, region) ?? `https://${service}.${region}.amazonaws.com/`;
  }

  /**
   * One Query API call. `mutating` decides how a lost response is classified: a create that may
   * have happened is `unknown_outcome` (look up before retrying); a read is just `retryable`.
   */
  async call(region: string, action: string, params: Params, deadline: number, mutating: boolean): Promise<XmlNode> {
    const body = new URLSearchParams({ Action: action, Version: '2016-11-15' });
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ExecutorError(mutating ? 'unknown_outcome' : 'retryable', `${action}: deadline passed`);
    const signer = this.signer('ec2', region);
    let res: Response;
    try {
      const req = await signer.sign(this.url('ec2', region), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: body.toString(),
      });
      res = await (this.opts.fetch ?? fetch)(req, { signal: AbortSignal.timeout(Math.min(remaining, 30_000)) });
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
    const signer = this.signer('servicequotas', region);
    try {
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
}
