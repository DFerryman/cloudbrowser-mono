import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The migrations `wrangler d1 migrations apply cloudbrowser` applies (migrations_dir in apps/api/wrangler.jsonc). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../packages/db/migrations/', import.meta.url));

/**
 * Reads the output of `wrangler d1 migrations list cloudbrowser --remote`: the names of the local
 * migrations the remote database has not applied yet, or [] when wrangler says there are none.
 * Names are matched against the migration files rather than read from wrangler's table, so its
 * layout and colours do not matter. Output that shows neither is an error: a deploy must not go
 * ahead on a guess.
 */
export function pendingMigrations(output, known = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const pending = known.filter((name) => new RegExp(`(^|[^\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w.-])`, 'm').test(text)).sort();
  if (pending.length) return pending;
  if (/No migrations to apply/i.test(text)) return [];
  throw new Error(`Could not tell from wrangler's output whether D1 migrations are pending:\n${text.trim()}`);
}
