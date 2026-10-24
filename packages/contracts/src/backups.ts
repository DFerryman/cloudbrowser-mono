import { z } from 'zod';

/**
 * Backups of a browser's data (page 4): provider snapshots of the volume (daily, kept 7 days) and
 * encrypted archives of the Chrome profile in an S3 bucket in the browser's own region (earlier ones in
 * R2) (on each sleep; last 10 plus one per day for 14 days).
 */
export const BackupKind = z.enum(['snapshot', 'archive']);
export type BackupKind = z.infer<typeof BackupKind>;

export const Backup = z.object({
  id: z.string(),
  kind: BackupKind,
  reason: z.enum(['daily', 'sleep', 'manual', 'recover', 'pre_upgrade']),
  status: z.enum(['pending', 'complete', 'failed']),
  sizeBytes: z.number().int().nullable(),
  createdAt: z.string(),
  /** Snapshots restore while the browser sleeps; archives while it runs. */
  restorableWhen: z.enum(['sleeping', 'running']),
});
export type Backup = z.infer<typeof Backup>;
