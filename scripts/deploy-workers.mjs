/**
 * Deploys the gateway, engine, reaper and reconciler Workers for `pnpm run deploy`, each only when
 * the code Wrangler would upload or its config changed since its live deployment. Each deploy
 * records `Deploy origin/main <commit> bundle <hash>` as its message, which the next run compares
 * against; a shared-package edit the Worker doesn't import (a Terms version in contracts) leaves
 * the bundle, and the Worker, alone.
 *
 * A gateway deploy restarts every InstanceGateway object, which drops every agent tunnel and live
 * view a few minutes later as the update reaches each object. So the gateway is deployed only in
 * the gateway deploy window, one combined deploy for every pending gateway change
 * (docs/deploy-cloudflare.md, "The gateway deploy window"): without DEPLOY_GATEWAY_WINDOW=1 a
 * changed gateway is held and its pending commits are listed. DEPLOY_ALL_WORKERS=1 deploys the
 * others even when unchanged; --only <name> deploys one; --dry-run only says what would happen.
 * Run after `deploy-api-main.mjs --check` and the build; the api is deployed separately, always.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** In deploy order: the gateway before the Workers that call it. */
export const WORKERS = [
  { name: 'cloudbrowser-gateway', dir: 'apps/gateway', config: 'wrangler.jsonc', windowed: true },
  { name: 'cloudbrowser-engine', dir: 'apps/engine', config: 'wrangler.jsonc' },
  { name: 'cloudbrowser-reaper', dir: 'apps/engine', config: 'wrangler.reaper.jsonc' },
  { name: 'cloudbrowser-reconciler', dir: 'apps/reconciler', config: 'wrangler.jsonc' },
];

/**
 * Repository files every Worker's build depends on, besides its own directory and workspace
 * packages: dependency versions (the lockfile changes with any version change in a package.json)
 * and build settings. Used to list a held gateway's pending commits, and to decide for a live
 * version labelled before bundle hashes were recorded.
 */
export const SHARED_INPUTS = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'turbo.json'];

const MESSAGE = /^Deploy origin\/main ([0-9a-f]{40})(?: bundle ([0-9a-f]{16}))?$/;

/**
 * The commit and bundle hash the live deployment was built from (the hash is null for one labelled
 * before hashes were recorded), or null when it can't be told: a rollback, a gradual split, an
 * unlabelled deploy.
 */
export function liveBuild(deployments) {
  const live = deployments.at(-1);
  if (!live || live.versions?.length !== 1) return null;
  const match = MESSAGE.exec(live.annotations?.['workers/message'] ?? '');
  return match ? { commit: match[1], bundle: match[2] ?? null } : null;
}

/** A hash of what Wrangler would upload (the modules it built, not their source maps) and of the Worker's config. */
export function bundleHash(files, config) {
  const hash = createHash('sha256');
  for (const [name, content] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (name.endsWith('.map') || name === 'README.md') continue;
    hash.update(`${name}\0${content.length}\0`).update(content);
  }
  return hash.update('\0config\0').update(config).digest('hex').slice(0, 16);
}

export function builtBundle(worker) {
  const out = mkdtempSync(join(tmpdir(), `${worker.name}-`));
  try {
    const result = wrangler(['deploy', '--dry-run', '--outdir', out, '-c', worker.config], worker.dir);
    if (result.status !== 0) throw new Error(`${worker.name}: building the bundle failed:\n${result.stdout}${result.stderr}`);
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((f) => f.isFile())
      .map((f) => {
        const path = join(f.parentPath ?? f.path, f.name);
        return [path.slice(out.length + 1), readFileSync(path)];
      });
    return bundleHash(files, readFileSync(join(root, worker.dir, worker.config)));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
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

/** A windowed Worker (the gateway) is deployed only inside the gateway deploy window. */
export const heldForWindow = (worker, env = process.env) => !!worker.windowed && env.DEPLOY_GATEWAY_WINDOW !== '1';

/**
 * Why a Worker needs deploying, or null when what is live already matches: the same commit, the
 * same bundle, or (for a live version without a bundle hash) no change in what it builds from.
 * `bundle` and `inputsChanged` are called only when needed: building a bundle takes seconds.
 */
export function deployReason({ live, commit, bundle, inputsChanged, force }) {
  if (force) return 'DEPLOY_ALL_WORKERS=1';
  if (!live) return 'live version unlabelled';
  if (live.commit === commit) return null;
  if (live.bundle) return live.bundle === bundle() ? null : `bundle changed since ${live.commit.slice(0, 7)}`;
  return inputsChanged() ? `changed since ${live.commit.slice(0, 7)}` : null;
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
  const dryRun = process.argv.includes('--dry-run');
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  if (only && !WORKERS.some((w) => w.name === only)) throw new Error(`--only: unknown Worker ${only}`);
  for (const worker of WORKERS.filter((w) => !only || w.name === only)) {
    const live = liveBuild(liveDeployments(worker));
    const held = heldForWindow(worker);
    let built;
    const bundle = () => (built ??= builtBundle(worker));
    const inputs = workerInputs(worker.dir);
    const reason = deployReason({
      live, commit, bundle, inputsChanged: () => changedSince(live.commit, inputs),
      force: !held && process.env.DEPLOY_ALL_WORKERS === '1',
    });
    if (!reason) {
      console.log(`${worker.name}: live ${live.commit.slice(0, 7)} already matches ${commit.slice(0, 7)}, skipped.`);
      continue;
    }
    if (held) {
      const pending = live ? execFileSync('git', ['log', '--format=  %h %s', `${live.commit}..HEAD`, '--', ...inputs], { cwd: root, encoding: 'utf8' }).trimEnd() : '';
      console.log(`${worker.name}: ${reason}; held for the gateway deploy window (DEPLOY_GATEWAY_WINDOW=1, `
        + `docs/deploy-cloudflare.md). Keep api changes working with the live gateway until then.${pending ? `\n${pending}` : ''}`);
      continue;
    }
    console.log(`${worker.name}: ${dryRun ? 'would deploy' : 'deploying'} ${commit.slice(0, 7)} (${worker.windowed ? `gateway deploy window, ${reason}` : reason}).`);
    if (dryRun) continue;
    const result = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', '-c', worker.config, '--message', `Deploy origin/main ${commit} bundle ${bundle()}`], {
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
