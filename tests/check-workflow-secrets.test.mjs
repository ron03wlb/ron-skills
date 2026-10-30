import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/check-workflow-secrets.mjs', import.meta.url).pathname;

// docs/workflow/ 整個資料夾會公開部署到 Cloudflare Pages；部署前擋機密與私有網址（#11，R2-Q4）。
// 假憑證在執行時拼出來，避免測試原始碼本身被 secret scanning 當成外洩。
function fixture(t, files) {
  const dir = mkdtempSync(join(realTmpdir(), 'workflow-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return spawnSync('node', [script, dir], { encoding: 'utf8' });
}

test('乾淨的站：exit 0', t => {
  const result = fixture(t, {
    'README.md': '# 首頁\n\n見 https://ron-skills-workflow.pages.dev/site/ 與 https://github.com/ron03wlb/ron-skills。\n',
    'site/index.html': '<p>版本 1.2.3.4 不是位址</p>\n',
  });
  assert.equal(result.status, 0, result.stdout);
});

test('憑證：逐個報檔名、行號與類型，exit 1', t => {
  const result = fixture(t, {
    'README.md': `a\nexport TOKEN=${'ghp_'}${'A1b2'.repeat(9)}\n`,
    'site/index.html': `<pre>${'-----BEGIN '}PRIVATE KEY-----</pre>\n`,
    'site/static/site.js': `fetch("https://user:${'hunter2'}@example.com/x")\n`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^WORKFLOW_SECRET README\.md:2 GitHub-token$/m);
  assert.match(result.stdout, /^WORKFLOW_SECRET site\/index\.html:1 private-key$/m);
  assert.match(result.stdout, /^WORKFLOW_SECRET site\/static\/site\.js:1 credential-url$/m);
  assert.doesNotMatch(result.stdout, /hunter2|A1b2A1b2/, '輸出只報位置與類型，不印出命中的值');
});

test('私有 IP 與內部主機：10／172.16-31／192.168、localhost 與 .internal 都擋', t => {
  const result = fixture(t, {
    '01-x.md': '連 10.0.0.5\n192.168.1.10\n172.20.3.4 與 172.32.0.1\n',
    'site/01-x.html': '<a href="http://localhost:3000/">本機</a> <a href="https://ci.internal/x">CI</a>\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^WORKFLOW_SECRET 01-x\.md:1 private-ip$/m);
  assert.match(result.stdout, /^WORKFLOW_SECRET 01-x\.md:2 private-ip$/m);
  assert.match(result.stdout, /^WORKFLOW_SECRET 01-x\.md:3 private-ip$/m);
  assert.equal(result.stdout.match(/01-x\.md:3/g).length, 1, '172.32.x 不是私有網段');
  assert.match(result.stdout, /^WORKFLOW_SECRET site\/01-x\.html:1 internal-host$/m);
});

test('二進位圖檔不掃內容', t => {
  const result = fixture(t, { 'diagrams/01.png': '10.0.0.5', 'README.md': '# ok\n' });
  assert.equal(result.status, 0, result.stdout);
});
