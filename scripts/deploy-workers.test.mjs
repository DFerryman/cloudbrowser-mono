import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedSince, deployedCommit, SHARED_INPUTS, workerInputs } from './deploy-workers.mjs';

const sha = 'a'.repeat(40);
const deployment = (message, versions = 1) => ({
  annotations: message === undefined ? {} : { 'workers/message': message },
  versions: Array.from({ length: versions }, (_, i) => ({ version_id: `v${i}`, percentage: 100 / versions })),
});

test('reads the live commit from the newest deployment only when it is one labelled main version', () => {
  assert.equal(deployedCommit([deployment('Deploy origin/main ' + 'b'.repeat(40)), deployment('Deploy origin/main ' + sha)]), sha);
  assert.equal(deployedCommit([deployment('Deploy origin/main ' + sha), deployment(undefined)]), null);
  assert.equal(deployedCommit([deployment('Rollback to v1')]), null);
  assert.equal(deployedCommit([deployment('Deploy origin/main ' + sha, 2)]), null);
  assert.equal(deployedCommit([deployment('Deploy origin/main ' + sha.slice(1))]), null);
  assert.equal(deployedCommit([]), null);
});

test('a Worker is built from its directory, its workspace packages, theirs, and the shared files', () => {
  const packages = {
    'apps/gateway': { name: '@cb/gateway', dependencies: { '@cb/contracts': 'workspace:*', zod: '^3' }, devDependencies: { '@cb/db': 'workspace:*' } },
    'packages/db': { name: '@cb/db', dependencies: { '@cb/contracts': 'workspace:*' } },
    'packages/contracts': { name: '@cb/contracts' },
    'packages/viewer': { name: '@cb/viewer', dependencies: { '@cb/contracts': 'workspace:*' } },
  };
  const read = (dir) => {
    if (!packages[dir]) throw new Error('no package');
    return packages[dir];
  };
  assert.deepEqual(workerInputs('apps/gateway', read), ['apps/gateway', 'packages/contracts', 'packages/db', ...SHARED_INPUTS]);
});

test('deploys when the inputs changed or the live commit is not in this clone, and skips when they did not', () => {
  const git = (statuses) => (args) => ({ status: statuses[args[0]] });
  assert.equal(changedSince(sha, ['apps/gateway'], git({ 'cat-file': 0, diff: 0 })), false);
  assert.equal(changedSince(sha, ['apps/gateway'], git({ 'cat-file': 0, diff: 1 })), true);
  assert.equal(changedSince(sha, ['apps/gateway'], git({ 'cat-file': 128 })), true);
  assert.throws(() => changedSince(sha, ['apps/gateway'], git({ 'cat-file': 0, diff: 128 })));
});
