import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedUrls, contentHash, prepareIndexNow, sitemapUrls, submitIndexNow, validateUrl } from './indexnow.mjs';

const origin = 'https://nevazu.com';
const config = JSON.parse(readFileSync(new URL('../deploy/indexnow.json', import.meta.url), 'utf8'));
const page = (text, asset = 'old') => `<html><head><title>Page</title><link rel="canonical" href="${origin}/docs" /><script type="module" src="/assets/${asset}.js"></script><link rel="stylesheet" href="/assets/${asset}.css" /><script type="application/ld+json">{"name":"Page"}</script></head><body><div id="root">${text}</div></body></html>`;

test('only public canonical URLs can be submitted, including old URLs for removed docs', () => {
  assert.equal(validateUrl(origin + '/docs/removed-guide'), origin + '/docs/removed-guide');
  for (const path of ['/api/v1/me', '/admin', '/b/private-id', '/browsers', '/account', '/sign-in', '/pricing?user=x', '/docs#fragment']) {
    assert.throws(() => validateUrl(origin + path));
  }
  assert.throws(() => validateUrl('https://evil.example/docs'));
  assert.throws(() => validateUrl('https://user:password@nevazu.com/docs'));
  assert.throws(() => sitemapUrls('<html>SPA shell</html>'));
  assert.deepEqual(sitemapUrls(`<urlset><url><loc>${origin}/docs</loc></url><url><loc>${origin}/</loc></url></urlset>`), [origin + '/', origin + '/docs']);
});

test('asset rebuilds do not trigger notifications; page text, metadata and structured data do', () => {
  assert.equal(contentHash(page('hello', 'a')), contentHash(page('hello', 'b')));
  assert.notEqual(contentHash(page('hello')), contentHash(page('updated')));
  assert.notEqual(contentHash(page('hello')), contentHash(page('hello').replace('<title>Page', '<title>Updated')));
  assert.notEqual(contentHash(page('hello')), contentHash(page('hello').replace('"name":"Page"', '"name":"Updated"')));
  assert.throws(() => contentHash('<div id="root"></div>'));
});

test('notifications include additions, edits and removals, and skip unchanged pages', () => {
  assert.deepEqual(changedUrls({ [origin + '/docs/old']: 'a', [origin + '/pricing']: 'a', [origin + '/docs']: 'a' },
    { [origin + '/docs/new']: 'a', [origin + '/pricing']: 'b', [origin + '/docs']: 'a' }),
  [origin + '/docs/new', origin + '/docs/old', origin + '/pricing']);
  assert.deepEqual(changedUrls({ [origin + '/']: 'a' }, { [origin + '/']: 'a' }), []);
});

test('deploy preparation compares the live manifest and carries unsubmitted URLs forward', () => {
  const dir = mkdtempSync(join(tmpdir(), 'indexnow-'));
  const retryFile = join(dir, 'pending.json');
  try {
    writeFileSync(join(dir, 'sitemap.xml'), `<urlset><url><loc>${origin}/pricing</loc></url></urlset>`);
    writeFileSync(join(dir, 'pricing.html'), page('price'));
    writeFileSync(retryFile, JSON.stringify({ urls: [origin + '/docs/removed'] }));
    const transport = () => ({ status: 200, body: JSON.stringify({ version: 1, pages: { [origin + '/pricing']: contentHash(page('price', 'previous-build')) } }) });
    assert.deepEqual(prepareIndexNow(dir, { transport, retryFile }), [origin + '/docs/removed']);
    writeFileSync(join(dir, 'pricing.html'), page('new price'));
    assert.deepEqual(prepareIndexNow(dir, { transport, retryFile }), [origin + '/docs/removed', origin + '/pricing']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'indexnow-manifest.json'))).version, 1);
    const firstDeploy = () => ({ status: 200, body: '<html>old SPA shell</html>' });
    assert.deepEqual(prepareIndexNow(dir, { transport: firstDeploy, retryFile }), [origin + '/docs/removed', origin + '/pricing']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed IndexNow requests keep a retry record; successful requests clear it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'indexnow-'));
  const retryFile = join(dir, 'pending.json');
  let status = 429;
  const calls = [];
  const transport = (url, body) => {
    calls.push({ url, body });
    if (url.includes('/build-info.json')) return { status: 200, body: JSON.stringify({ commit: 'deployed' }) };
    if (url.endsWith('.txt')) return { status: 200, body: config.key + '\n' };
    return { status, body: 'test response' };
  };
  try {
    await assert.rejects(() => submitIndexNow([origin + '/docs'], { commit: 'deployed', transport, retryFile }), /HTTP 429/);
    assert.deepEqual(JSON.parse(readFileSync(retryFile, 'utf8')).urls, [origin + '/docs']);
    status = 200;
    await submitIndexNow([origin + '/docs', origin + '/docs'], { commit: 'deployed', transport, retryFile });
    assert.equal(existsSync(retryFile), false);
    assert.deepEqual(calls.at(-1).body.urlList, [origin + '/docs']);
    assert.equal(calls.at(-1).url, 'https://api.indexnow.org/indexnow');
    status = 202;
    await submitIndexNow([origin + '/docs'], { transport, retryFile });
    assert.equal(existsSync(retryFile), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stale deployment or an invalid ownership file prevents notification and preserves retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'indexnow-'));
  const retryFile = join(dir, 'pending.json');
  const calls = [];
  const transport = (url) => { calls.push(url); return { status: 200, body: JSON.stringify({ commit: 'old' }) }; };
  try {
    await assert.rejects(() => submitIndexNow([origin + '/'], { commit: 'new', transport, retryFile, sleep: async () => {} }), /does not match/);
    assert.equal(calls.length, 3);
    assert.equal(existsSync(retryFile), true);
    calls.length = 0;
    await assert.rejects(() => submitIndexNow([origin + '/'], { transport, retryFile }), /ownership file/);
    assert.equal(calls.length, 1);
    assert.equal(existsSync(retryFile), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('notification waits for deployment propagation before contacting IndexNow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'indexnow-'));
  let buildReads = 0;
  let submissions = 0;
  const transport = (url) => {
    if (url.includes('/build-info.json')) return { status: 200, body: JSON.stringify({ commit: ++buildReads === 1 ? 'old' : 'new' }) };
    if (url.endsWith('.txt')) return { status: 200, body: config.key };
    submissions++;
    return { status: 200, body: '' };
  };
  try {
    await submitIndexNow([origin + '/'], { commit: 'new', transport, retryFile: join(dir, 'pending.json'), sleep: async () => {} });
    assert.equal(buildReads, 2);
    assert.equal(submissions, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
