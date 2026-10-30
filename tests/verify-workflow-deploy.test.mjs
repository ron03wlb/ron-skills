import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyDeployment } from '../scripts/verify-workflow-deploy.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

// 部署後以匿名 GET 逐檔比對固定網址；CDN 可能還沒一致，所以有上限地重試（#11，spay2 實測 6 次 × 20 秒內一致）。
function site(t, files) {
  const dir = mkdtempSync(join(realTmpdir(), 'workflow-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** 假的 CDN：每次 sleep 進入下一輪，第 n 輪回 rounds[n]，超過就沿用最後一輪；沒列出的路徑回 404。 */
function cdn(rounds) {
  const requests = [];
  let round = 0;
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const served = rounds[Math.min(round, rounds.length - 1)];
    const path = decodeURIComponent(new URL(url).pathname.slice(1));
    return path in served ? new Response(served[path], { status: 200 }) : new Response('not found', { status: 404 });
  };
  const sleep = async () => { round += 1; };
  return { requests, fetch, sleep };
}

test('每個檔案都與線上一致：一輪就通過，逐檔匿名 GET', async t => {
  const dir = site(t, { 'README.md': '# 首頁\n', 'site/index.html': '<p>站</p>\n', 'site/static/流程.css': 'a{}\n' });
  const fake = cdn([{ 'README.md': '# 首頁\n', 'site/index.html': '<p>站</p>\n', 'site/static/流程.css': 'a{}\n' }]);
  const result = await verifyDeployment({ source: dir, baseUrl: 'https://example.pages.dev/', fetch: fake.fetch, sleep: fake.sleep });
  assert.deepEqual(result, { ok: true, attempts: 1, mismatches: [] });
  assert.deepEqual(fake.requests.map(r => r.url).sort(), [
    'https://example.pages.dev/README.md',
    'https://example.pages.dev/site/index.html',
    'https://example.pages.dev/site/static/%E6%B5%81%E7%A8%8B.css',
  ]);
  assert.ok(fake.requests.every(r => !r.init?.headers?.authorization && !r.init?.headers?.Authorization), '匿名：不帶憑證');
});

test('CDN 第三輪才一致：重試到通過，回報用了幾輪', async t => {
  const dir = site(t, { 'README.md': 'new\n', 'site/index.html': 'new\n' });
  const fake = cdn([
    { 'README.md': 'old\n', 'site/index.html': 'new\n' },
    { 'README.md': 'old\n' },
    { 'README.md': 'new\n', 'site/index.html': 'new\n' },
  ]);
  const result = await verifyDeployment({ source: dir, baseUrl: 'https://example.pages.dev', fetch: fake.fetch, sleep: fake.sleep });
  assert.deepEqual(result, { ok: true, attempts: 3, mismatches: [] });
});

test('重試上限用完仍不一致：失敗並逐檔列出原因', async t => {
  const dir = site(t, { 'README.md': 'new\n', 'site/index.html': 'new\n', 'site/ok.html': 'ok\n' });
  const fake = cdn([{ 'README.md': 'old\n', 'site/ok.html': 'ok\n' }]);
  const waits = [];
  const result = await verifyDeployment({
    source: dir, baseUrl: 'https://example.pages.dev', attempts: 4, delayMs: 20_000,
    fetch: fake.fetch, sleep: async ms => { waits.push(ms); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 4);
  assert.deepEqual(result.mismatches, [
    { path: 'README.md', reason: 'sha256 不同' },
    { path: 'site/index.html', reason: 'HTTP 404' },
  ]);
  assert.deepEqual(waits, [20_000, 20_000, 20_000], '輪與輪之間等待，最後一輪後不等');
});
