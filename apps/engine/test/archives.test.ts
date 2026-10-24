import { describe, expect, it } from 'vitest';
import type { AwsCredentialProvider } from '@cloudbrowser/executors';
import { archiveObjectKey, archiveStore, deleteS3Archive, s3Location } from '../src/archives.js';

const r2 = { accountId: 'acct', accessKeyId: 'r2key', secretAccessKey: 'r2secret', bucket: 'cloudbrowser-archives' };
const key = archiveObjectKey('inst1', 'op1-archive');

function session(expiresInMs: number): AwsCredentialProvider & { renewals: number } {
  let expiration = Date.now() + expiresInMs;
  const provider = Object.assign(async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token', expiration }), { renewals: 0 }) as AwsCredentialProvider & { renewals: number };
  provider.invalidate = () => { provider.renewals++; expiration = Date.now() + 3_600_000; };
  return provider;
}

describe('archive storage', () => {
  it('puts new archives in the S3 bucket of the browser’s own region', async () => {
    const store = archiveStore({ r2, s3: { credentials: session(3_600_000), bucketPrefix: 'nevazu-archives-123-' } })!;
    const location = store.locate!('ap-northeast-1', key);
    expect(location).toBe(`s3:ap-northeast-1/${key}`);
    expect(s3Location(location)).toEqual({ region: 'ap-northeast-1', key });
    const put = new URL(await store.presignPut(location));
    expect(put.host).toBe('nevazu-archives-123-ap-northeast-1.s3.ap-northeast-1.amazonaws.com');
    expect(put.pathname).toBe(`/${key}`);
    expect(put.searchParams.get('X-Amz-Credential')).toContain('/ap-northeast-1/s3/aws4_request');
    expect(put.searchParams.get('X-Amz-Security-Token')).toBe('token');
    expect(put.searchParams.get('X-Amz-Expires')).toBe('900');
  });

  it('keeps archives made in R2 restorable after the switch', async () => {
    const store = archiveStore({ r2, s3: { credentials: session(3_600_000), bucketPrefix: 'nevazu-archives-123-' } })!;
    expect(s3Location(key)).toBeNull();
    const get = new URL(await store.presignGet(key));
    expect(get.host).toBe('acct.r2.cloudflarestorage.com');
    expect(get.pathname).toBe(`/cloudbrowser-archives/${key}`);
  });

  it('stays on R2 when S3 is not configured', async () => {
    const store = archiveStore({ r2 })!;
    expect(store.locate!('eu-west-2', key)).toBe(key);
    await expect(store.presignGet(`s3:eu-west-2/${key}`)).rejects.toThrow('S3 archive storage is not configured');
    expect(archiveStore({})).toBeNull();
  });

  it('renews a role session that would end before a presigned URL expires', async () => {
    const credentials = session(10 * 60_000);
    const store = archiveStore({ s3: { credentials, bucketPrefix: 'p-' } })!;
    await store.presignPut(`s3:sa-east-1/${key}`);
    expect(credentials.renewals).toBe(1);
    await store.presignPut(`s3:sa-east-1/${key}`);
    expect(credentials.renewals).toBe(1);
  });

  it('deletes an S3 archive in its own region, and treats one already gone as deleted', async () => {
    const cfg = { credentials: session(3_600_000), bucketPrefix: 'p-' };
    const seen: Request[] = [];
    const respond = (status: number) => (async (req: Request) => { seen.push(req); return new Response(status === 204 ? null : '', { status }); }) as typeof fetch;
    await deleteS3Archive(cfg, `s3:me-central-1/${key}`, respond(204));
    await deleteS3Archive(cfg, `s3:me-central-1/${key}`, respond(404));
    expect(seen.map((r) => [r.method, new URL(r.url).host])).toEqual([
      ['DELETE', 'p-me-central-1.s3.me-central-1.amazonaws.com'],
      ['DELETE', 'p-me-central-1.s3.me-central-1.amazonaws.com'],
    ]);
    await expect(deleteS3Archive(cfg, `s3:me-central-1/${key}`, respond(403))).rejects.toThrow('HTTP 403');
    await expect(deleteS3Archive(cfg, key, respond(204))).rejects.toThrow('not an S3 archive location');
  });
});
