import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const api = fileURLToPath(new URL('../apps/api/', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function verifyMain() {
  if (git('branch', '--show-current') !== 'main') throw new Error('Deploy from the main branch.');
  if (git('status', '--porcelain')) throw new Error('Commit all changes before deploying.');
  run('git', ['fetch', 'origin', 'main']);
  const commit = git('rev-parse', 'HEAD');
  if (commit !== git('rev-parse', 'origin/main')) {
    throw new Error('HEAD must equal the latest origin/main. Sync or push main before deploying.');
  }
  return commit;
}

try {
  if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: deploy-api-main.mjs [--check]');
  const commit = verifyMain();
  console.log(`Verified clean origin/main: ${commit}`);
  if (!process.argv.includes('--check')) {
    // Build here, even if another command already built: dist may belong to a different checkout.
    // Commit identity is not part of Turbo's cache key; never restore another commit's dist.
    run('pnpm', ['exec', 'turbo', 'run', 'build', '--force']);
    if (verifyMain() !== commit) throw new Error('main changed during the build; deploy stopped.');
    const info = JSON.parse(readFileSync(new URL('../apps/web/dist/build-info.json', import.meta.url), 'utf8'));
    if (info.commit !== commit || info.branch !== 'main' || info.dirty) {
      throw new Error('The frontend build does not belong to this clean main commit.');
    }
    run('pnpm', ['exec', 'wrangler', 'deploy', '--keep-vars', '--message', `Deploy origin/main ${commit}`], api);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
