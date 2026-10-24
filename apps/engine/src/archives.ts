import { AwsClient } from 'aws4fetch';
import type { AwsCredentialProvider } from '@cloudbrowser/executors';

/**
 * Where archive backups live (page 4). New archives go to an S3 bucket in the browser's own AWS
 * region, so a browser's data stays in the region the user chose; archives made before that are
 * in the R2 bucket and stay readable there until they expire. The agent never gets storage
 * credentials: the engine hands it a presigned URL for exactly one object, valid 15 minutes.
 *
 * A backup's `location` says where its object is: `s3:<region>/<key>` in that region's bucket, or
 * a bare key in R2.
 */
export interface ArchiveStore {
  /** The location of a new archive of a browser in this AWS region. Absent: the bare key (R2). */
  locate?(providerRegion: string, objectKey: string): string;
  presignPut(location: string): Promise<string>;
  presignGet(location: string): Promise<string>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface S3Config {
  credentials: AwsCredentialProvider;
  /** Bucket names are this prefix plus the region, for example `nevazu-archives-346565070970-ap-northeast-1`. */
  bucketPrefix: string;
}

const EXPIRES_S = 900;

export const archiveObjectKey = (instanceId: string, backupId: string) => `archives/${instanceId}/${backupId}.cbar`;

const S3_LOCATION = /^s3:([a-z0-9-]+)\/(archives\/.+)$/;

/** The region and key of an S3 location; null for an R2 key. */
export function s3Location(location: string): { region: string; key: string } | null {
  const m = S3_LOCATION.exec(location);
  return m ? { region: m[1]!, key: m[2]! } : null;
}

const s3Url = (cfg: S3Config, region: string, key: string) => new URL(`https://${cfg.bucketPrefix}${region}.s3.${region}.amazonaws.com/${key}`);

/**
 * Role credentials with enough time left to cover a presigned URL's whole validity: a URL signed
 * with a session stops working when the session ends, so renew a session that ends sooner.
 */
async function longEnough(credentials: AwsCredentialProvider, now = Date.now()) {
  const c = await credentials();
  if (!c.expiration || c.expiration - now > EXPIRES_S * 1000 || !credentials.invalidate) return c;
  credentials.invalidate();
  return credentials();
}

async function presignS3(cfg: S3Config, method: 'PUT' | 'GET', region: string, key: string) {
  const c = await longEnough(cfg.credentials);
  const client = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, service: 's3', region });
  const url = s3Url(cfg, region, key);
  url.searchParams.set('X-Amz-Expires', String(EXPIRES_S));
  return (await client.sign(new Request(url, { method }), { aws: { signQuery: true } })).url;
}

/** Deletes one archive object in its region's bucket; an object that is already gone is fine. */
export async function deleteS3Archive(cfg: S3Config, location: string, request: typeof fetch = globalThis.fetch.bind(globalThis)) {
  const at = s3Location(location);
  if (!at) throw new Error(`not an S3 archive location: ${location}`);
  const c = await cfg.credentials();
  const client = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, service: 's3', region: at.region, retries: 0 });
  const res = await request(await client.sign(s3Url(cfg, at.region, at.key).toString(), { method: 'DELETE' }), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok && res.status !== 404) throw new Error(`S3 DeleteObject ${at.region}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

function presignR2(cfg: R2Config, client: AwsClient, method: 'PUT' | 'GET', key: string) {
  const url = new URL(`https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key}`);
  url.searchParams.set('X-Amz-Expires', String(EXPIRES_S));
  return client.sign(new Request(url, { method }), { aws: { signQuery: true } }).then((r) => r.url);
}

/**
 * New archives in S3 when `s3` is set, else in R2; each location is presigned where it is, so
 * archives in R2 stay restorable after the switch.
 */
export function archiveStore(opts: { r2?: R2Config; s3?: S3Config }): ArchiveStore | null {
  const { r2, s3 } = opts;
  if (!r2 && !s3) return null;
  const r2Client = r2 ? new AwsClient({ accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey, service: 's3', region: 'auto' }) : null;
  const sign = async (method: 'PUT' | 'GET', location: string) => {
    const at = s3Location(location);
    if (at) {
      if (!s3) throw new Error('S3 archive storage is not configured');
      return presignS3(s3, method, at.region, at.key);
    }
    if (!r2 || !r2Client) throw new Error('R2 archive storage is not configured');
    return presignR2(r2, r2Client, method, location);
  };
  return {
    locate: (region, key) => (s3 ? `s3:${region}/${key}` : key),
    presignPut: (l) => sign('PUT', l),
    presignGet: (l) => sign('GET', l),
  };
}
