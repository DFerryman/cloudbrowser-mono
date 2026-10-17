import { AwsClient } from 'aws4fetch';

/**
 * Where archive backups live (page 4): an R2 bucket. The agent never gets R2 credentials; the
 * engine hands it a presigned URL for exactly one object, valid 15 minutes. Deleting goes through
 * the R2 binding of the reaper.
 */
export interface ArchiveStore {
  presignPut(objectKey: string): Promise<string>;
  presignGet(objectKey: string): Promise<string>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const EXPIRES_S = 900;

export function r2ArchiveStore(cfg: R2Config): ArchiveStore {
  const client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: 'auto' });
  const sign = async (method: 'PUT' | 'GET', key: string) => {
    const url = new URL(`https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key}`);
    url.searchParams.set('X-Amz-Expires', String(EXPIRES_S));
    const signed = await client.sign(new Request(url, { method }), { aws: { signQuery: true } });
    return signed.url;
  };
  return { presignPut: (k) => sign('PUT', k), presignGet: (k) => sign('GET', k) };
}

export const archiveObjectKey = (instanceId: string, backupId: string) => `archives/${instanceId}/${backupId}.cbar`;
