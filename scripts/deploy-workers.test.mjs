import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundleHash, changedSince, deployReason, heldForWindow, liveBuild, SHARED_INPUTS, WORKERS, workerInputs } from './deploy-workers.mjs';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const hash = '0123456789abcdef';
const deployment = (message, versions = 1) => ({
  annotations: message === undefined ? {} : { 'workers/message': message },
  versions: Array.from({ length: versions }, (_, i) => ({ version_id: `v${i}`, percentage: 100 / versions })),
});

test('reads the live commit and bundle from the newest deployment only when it is one labelled main version', () => {
  assert.deepEqual(liveBuild([deployment(`Deploy origin/main ${other}`), deployment(`Deploy origin/main ${sha} bundle ${hash}`)]), { commit: sha, bundle: hash });
  assert.deepEqual(liveBuild([deployment(`Deploy origin/main ${sha}`)]), { commit: sha, bundle: null });
  assert.equal(liveBuild([deployment(`Deploy origin/main ${sha}`), deployment(undefined)]), null);
  assert.equal(liveBuild([deployment('Rollback to v1')]), null);
  assert.equal(liveBuild([deployment(`Deploy origin/main ${sha}`, 2)]), null);
  assert.equal(liveBuild([deployment(`Deploy origin/main ${sha.slice(1)}`)]), null);
  assert.equal(liveBuild([]), null);
});

test('the bundle hash covers the uploaded modules and the config, not source maps or the readme', () => {
  const files = [['index.js', Buffer.from('code')], ['index.js.map', Buffer.from('map /tmp/a')], ['README.md', Buffer.from('a')]];
  const base = bundleHash(files, Buffer.from('{}'));
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(bundleHash([['README.md', Buffer.from('b')], ['index.js.map', Buffer.from('map /tmp/b')], ['index.js', Buffer.from('code')]], Buffer.from('{}')), base);
  assert.notEqual(bundleHash([['index.js', Buffer.from('code2')]], Buffer.from('{}')), base);
  assert.notEqual(bundleHash([['index.js', Buffer.from('code')]], Buffer.from('{"vars":{}}')), base);
  assert.notEqual(bundleHash([['index.js', Buffer.from('code')], ['chunk.wasm', Buffer.from('w')]], Buffer.from('{}')), base);
});

test('deploys only when the live version does not match what this commit builds', () => {
  const never = () => assert.fail('not needed for this decision');
  assert.equal(deployReason({ live: { commit: sha, bundle: hash }, commit: sha, bundle: never, inputsChanged: never }), null);
  // A Terms constant in contracts changes the commit, not a bundle that never imports it.
  assert.equal(deployReason({ live: { commit: other, bundle: hash }, commit: sha, bundle: () => hash, inputsChanged: never }), null);
  assert.match(deployReason({ live: { commit: other, bundle: hash }, commit: sha, bundle: () => 'f'.repeat(16), inputsChanged: never }), /bundle changed/);
  assert.equal(deployReason({ live: { commit: other, bundle: null }, commit: sha, bundle: never, inputsChanged: () => false }), null);
  assert.match(deployReason({ live: { commit: other, bundle: null }, commit: sha, bundle: never, inputsChanged: () => true }), /changed since/);
  assert.match(deployReason({ live: null, commit: sha, bundle: never, inputsChanged: never }), /unlabelled/);
  assert.match(deployReason({ live: { commit: sha, bundle: hash }, commit: sha, bundle: never, inputsChanged: never, force: true }), /DEPLOY_ALL_WORKERS/);
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

test('inputs changed when the diff says so or the live commit is not in this clone', () => {
  const git = (statuses) => (args) => ({ status: statuses[args[0]] });
  assert.equal(changedSince(sha, ['apps/gateway'], git({ 'cat-file': 0, diff: 0 })), false);
  assert.equal(changedSince(sha, ['apps/gateway'], git({ 'cat-file': 0, diff: 1 })), true);
  assert.equal(changedSince(sha, ['apps/gateway'], git({ 'cat-file': 128 })), true);
  assert.throws(() => changedSince(sha, ['apps/gateway'], git({ 'cat-file': 0, diff: 128 })));
});

test('the gateway deploys only in the gateway deploy window; the other Workers never wait for it', () => {
  const gateway = WORKERS.find((w) => w.name === 'cloudbrowser-gateway');
  assert.equal(heldForWindow(gateway, {}), true);
  assert.equal(heldForWindow(gateway, { DEPLOY_ALL_WORKERS: '1' }), true);
  assert.equal(heldForWindow(gateway, { DEPLOY_GATEWAY_WINDOW: '1' }), false);
  for (const worker of WORKERS.filter((w) => w !== gateway)) assert.equal(heldForWindow(worker, {}), false);
});
