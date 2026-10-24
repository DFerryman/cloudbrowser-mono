/**
 * Deploys the gateway, engine, reaper and reconciler Workers for `pnpm run deploy`, each only when
 * what it is built from changed since the commit its live deployment came from. A gateway deploy
 * restarts every InstanceGateway object, which drops every agent tunnel and live view a few minutes
 * later as the update reaches each object (docs/deploy-cloudflare.md, "Migrate and deploy"); a
 * Terms-page change must not do that. Each deploy records `Deploy origin/main <commit>` as its
 * message, which the next run compares against. DEPLOY_ALL_WORKERS=1 deploys all of them anyway;
 * --dry-run only says what would be deployed. Run after `deploy-api-main.mjs --check` and the
 * build; the api is deployed separately, always.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** In deploy order: the gateway before the Workers that call it. */
export const WORKERS = [
  { name: 'cloudbrowser-gateway', dir: 'apps/gateway', config: 'wrangler.jsonc' },
  { name: 'cloudbrowser-engine', dir: 'apps/engine', config: 'wrangler.jsonc' },
  { name: 'cloudbrowser-reaper', dir: 'apps/engine', config: 'wrangler.reaper.jsonc' },
  { name: 'cloudbrowser-reconciler', dir: 'apps/reconciler', config: 'wrangler.jsonc' },
];

/**
 * Repository files every Worker's build depends on: dependency versions (the lockfile changes with
 * any version change in a package.json, the root one included) and build settings. The root
 * package.json itself is left out so that a change to its scripts deploys nothing.
 */
export const SHARED_INPUTS = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'turbo.json'];

const MESSAGE = /^Deploy origin\/main ([0-9a-f]{40})$/;

/** The commit the live deployment was built from, or null when it can't be told (a rollback, a gradual split, an unlabelled deploy). */
export function deployedCommit(deployments) {
  const live = deployments.at(-1);
  if (!live || live.versions?.length !== 1) return null;
  return MESSAGE.exec(live.annotations?.['workers/message'] ?? '')?.[1] ?? null;
}

/** A Worker's directory and every workspace package it depends on, directly or not, plus the shared files. */
export function workerInputs(dir, readPackage = (d) => JSON.parse(readFileSync(join(root, d, 'package.json'), 'utf8'))) {
  const byName = new Map();
  for (const group of ['apps', 'packages']) {
    for (const entry of execFileSync('git', ['ls-tree', '--name-only', 'HEAD', `${group}/`], { cwd: root, encoding: 'utf8' }).split('\n')) {
      if (!entry) continue;
      try {
        byName.set(readPackage(entry).name, entry);
      } catch {
        // Not a package.
      }
    }
  }
  const dirs = new Set();
  const visit = (d) => {
    if (dirs.has(d)) return;
    dirs.add(d);
    const pkg = readPackage(d);
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (String(version).startsWith('workspace:') && byName.has(name)) visit(byName.get(name));
    }
  };
  visit(dir);
  return [...[...dirs].sort(), ...SHARED_INPUTS];
}

/** Whether `paths` differ between `commit` and HEAD; true when the commit is not in this clone. */
export function changedSince(commit, paths, gitCommand = (args) => spawnSync('git', args, { cwd: root })) {
  if (gitCommand(['cat-file', '-e', `${commit}^{commit}`]).status !== 0) return true;
  const diff = gitCommand(['diff', '--quiet', commit, 'HEAD', '--', ...paths]);
  if (diff.status === 0) return false;
  if (diff.status === 1) return true;
  throw new Error(`git diff failed for ${commit}`);
}

function wrangler(args, dir) {
  return spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: join(root, dir), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

function liveDeployments(worker) {
  const result = wrangler(['deployments', 'list', '--name', worker.name, '--json'], worker.dir);
  if (result.status !== 0) return [];
  const out = result.stdout ?? '';
  try {
    return JSON.parse(out.slice(out.indexOf('[')));
  } catch {
    return [];
  }
}

async function main() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const all = process.env.DEPLOY_ALL_WORKERS === '1';
  const dryRun = process.argv.includes('--dry-run');
  for (const worker of WORKERS) {
    const live = deployedCommit(liveDeployments(worker));
    const inputs = workerInputs(worker.dir);
    if (!all && live === commit) {
      console.log(`${worker.name}: already live from ${commit.slice(0, 7)}, skipped.`);
      continue;
    }
    if (!all && live && !changedSince(live, inputs)) {
      console.log(`${worker.name}: nothing it builds from changed since ${live.slice(0, 7)} (${inputs.join(', ')}), skipped.`);
      continue;
    }
    console.log(`${worker.name}: ${dryRun ? 'would deploy' : 'deploying'} ${commit.slice(0, 7)} (${all ? 'DEPLOY_ALL_WORKERS=1' : live ? `changed since ${live.slice(0, 7)}` : 'live commit unknown'}).`);
    if (dryRun) continue;
    const result = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', '-c', worker.config, '--message', `Deploy origin/main ${commit}`], {
      cwd: join(root, worker.dir), stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error(`${worker.name} deploy failed (status ${result.status}).`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
