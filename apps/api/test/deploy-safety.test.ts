import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module script, no declarations
import { pendingMigrations } from '../../../scripts/d1-migrations.mjs';

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const known = ['0033_viewer_presence.sql', '0034_agent_access.sql', '0035_agent_keys.sql'];

describe('pending D1 migrations preflight', () => {
  it('reads the pending migrations from wrangler\'s table, colours and all', () => {
    const table = [
      '\x1b[33mMigrations to be applied:\x1b[0m',
      '┌───────────────────────┐',
      '│ Name                  │',
      '├───────────────────────┤',
      '│ 0035_agent_keys.sql   │',
      '├───────────────────────┤',
      '│ 0034_agent_access.sql │',
      '└───────────────────────┘',
    ].join('\n');
    expect(pendingMigrations(table, known)).toEqual(['0034_agent_access.sql', '0035_agent_keys.sql']);
    expect(pendingMigrations('| 0035_agent_keys.sql |', known)).toEqual(['0035_agent_keys.sql']);
  });

  it('passes only when wrangler says there is nothing to apply, and refuses output it cannot read', () => {
    expect(pendingMigrations('\n ⛅️ wrangler 4.x\n✅ No migrations to apply!\n', known)).toEqual([]);
    // A truncated name, an error or an empty answer is not "nothing pending".
    for (const output of ['Migrations to be applied:\n│ 0035_agent_ke… │', '✘ [ERROR] Couldn\'t find a D1 DB', '']) {
      expect(() => pendingMigrations(output, known)).toThrow(/Could not tell/);
    }
    // A name inside a longer one is not that migration.
    expect(() => pendingMigrations('│ 10034_agent_access.sql │', known)).toThrow(/Could not tell/);
  });

  it('knows every migration in the repository', () => {
    expect(pendingMigrations('│ 0000_init.sql │\n│ 0034_agent_access.sql │')).toEqual(['0000_init.sql', '0034_agent_access.sql']);
  });
});

describe('deploy safety', () => {
  it('checks main and the migrations before the root deploy builds or deploys any Worker', () => {
    const deploy = JSON.parse(read('package.json')).scripts.deploy as string;
    expect(deploy.startsWith('node scripts/deploy-api-main.mjs --check && ')).toBe(true);
    const script = read('scripts/deploy-api-main.mjs');
    // Both the --check run and the api deploy check the migrations, after main.
    expect(script).toMatch(/const commit = verifyMain\(\);\n.*\n\s*verifyMigrations\(\);\n\s*if \(!process\.argv\.includes\('--check'\)\)/);
    expect(script).toContain("process.env.ALLOW_PENDING_D1_MIGRATIONS === '1'");
  });

  it('documents migrations first, `pnpm run deploy` and every queue the Workers use', () => {
    const docs = read('docs/deploy-cloudflare.md');
    const aws = read('docs/aws.md');
    // `pnpm deploy` is pnpm's own command; only the warning against it may mention it.
    expect(`${docs}\n${aws}`.replace('not `pnpm deploy`', '')).not.toMatch(/pnpm deploy\b/);
    expect(docs).toMatch(/Apply the migrations before deploying any Worker/);
    expect(docs.indexOf('pnpm db:migrate:remote\npnpm run deploy')).toBeGreaterThan(0);
    const queues = new Set(['api', 'engine', 'gateway', 'reconciler'].flatMap((app) =>
      [...read(`apps/${app}/wrangler.jsonc`).matchAll(/"queue": "([\w-]+)"/g)].map((m) => m[1]!)));
    expect([...queues].sort()).toContain('cloudbrowser-aws-provider');
    for (const queue of queues) expect(docs).toContain(`pnpm exec wrangler queues create ${queue}\n`);
  });

  it('sends HSTS for the app and gives CI a read-only token', () => {
    const headers = read('apps/web/public/_headers');
    expect(headers.split(/\n(?=\/)/).find((block) => block.startsWith('/*\n'))).toContain('  Strict-Transport-Security: max-age=31536000; includeSubDomains\n');
    expect(read('.github/workflows/ci.yml')).toMatch(/^permissions:\n {2}contents: read\n/m);
  });
});
