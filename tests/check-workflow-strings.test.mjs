import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/check-workflow-strings.mjs', import.meta.url).pathname;

// docs/workflow/ 是通用版流程站的來源；spay2 的內網位址、分支命名與專案名不得混進來（#8，R2-Q7）。
function fixture(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-strings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return spawnSync('node', [script, dir], { encoding: 'utf8' });
}

test('乾淨的 Markdown 與圖來源 JSON：exit 0', t => {
  const result = fixture(t, { 'README.md': '# 首頁\n\nron-skills 的流程。\n', 'diagrams/src/01.workflow.json': '{"title":"主流程"}\n' });
  assert.equal(result.status, 0, result.stdout);
});

test('Markdown 寫入 spay（不分大小寫）：逐行報檔名與行號、exit 1', t => {
  const result = fixture(t, { 'README.md': '# 首頁\n\n照 SPay 的做法\n', '01-x.md': 'a\nb\nspay2 專案\n' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^WORKFLOW_SPECIFIC_STRING 01-x\.md:3 spay$/m);
  assert.match(result.stdout, /^WORKFLOW_SPECIFIC_STRING README\.md:3 SPay$/m);
});

test('內網位址與 spay2 分支命名也擋；圖來源 JSON 一併掃描', t => {
  const result = fixture(t, {
    '02-x.md': '連 192.168.1.10\n',
    'diagrams/src/02.workflow.json': '{"branch":"feature/ron/#123"}\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^WORKFLOW_SPECIFIC_STRING 02-x\.md:1 192\.168\.$/m);
  assert.match(result.stdout, /^WORKFLOW_SPECIFIC_STRING diagrams\/src\/02\.workflow\.json:1 feature\/ron\/#$/m);
});

test('spay2 公開站網址是唯一白名單：通過；同一行另有 spay 仍擋', t => {
  const ok = fixture(t, { 'README.md': 'L3 實例見 https://spay2-workflow-docs.pages.dev 與 [站](https://spay2-workflow-docs.pages.dev/02-lifecycle.html)。\n' });
  assert.equal(ok.status, 0, ok.stdout);
  const mixed = fixture(t, { 'README.md': 'https://spay2-workflow-docs.pages.dev 是 spay2 的站\n' });
  assert.equal(mixed.status, 1);
  assert.match(mixed.stdout, /^WORKFLOW_SPECIFIC_STRING README\.md:1 spay$/m);  const lookalike = fixture(t, { 'README.md': '見 https://spay2-workflow-docs.pages.dev.example.com/x\n' });
  assert.equal(lookalike.status, 1, '只放行那個網址本身，不放行以它開頭的其他網域');
});

test('產出的 site/ 與非 Markdown／JSON 檔不掃描', t => {
  const result = fixture(t, { 'README.md': '# ok\n', 'site/index.html': 'spay', 'site/x.md': 'spay', 'diagrams/01.html': 'spay' });
  assert.equal(result.status, 0, result.stdout);
});
