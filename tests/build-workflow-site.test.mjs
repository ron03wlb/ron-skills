// build-workflow-site.mjs 的回歸：以 OS 暫存 fixture 產站，確認側邊欄、iframe、連結換算、重產零 diff 與 --check 擋手改（#8）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildSite, diffSite, renderMarkdown, rewriteHref } from '../scripts/build-workflow-site.mjs';

const script = new URL('../scripts/build-workflow-site.mjs', import.meta.url).pathname;
let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'build-workflow-site-test-'));
  mkdirSync(join(root, 'diagrams', 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# 首頁\n\n導讀文字，正式規則見 [`README.md`](../../README.md)。\n\n| 章 | 內容 |\n| --- | --- |\n| [01 工具](01-tooling.md) | 工具 |\n| [02 主流程](02-lifecycle.md) | 流程 |\n');
  writeFileSync(join(root, '01-tooling.md'), '# 01 工具版圖\n\n![工具版圖](diagrams/01-tooling.png)\n\n互動版：[diagrams/01-tooling.html](diagrams/01-tooling.html)\n\n## 角色\n\n- Operator：`git push`\n  - 續行說明\n- Claude Code\n\n```bash\nnode scripts/x.mjs\n```\n');
  writeFileSync(join(root, '02-lifecycle.md'), '# 02 主流程\n\n![沒有互動版的圖](diagrams/02-static.png)\n\n> 引言 **粗體** 與 *斜體*\n\n1. 第一步，見 [07](07-setup.md#1-skills)\n2. 第二步\n');
  writeFileSync(join(root, 'diagrams', '01-tooling.html'), '<!doctype html><html><head><title>工具版圖互動版</title></head><body></body></html>');
  writeFileSync(join(root, 'diagrams', '01-tooling.png'), 'png');
  writeFileSync(join(root, 'diagrams', '02-static.png'), 'png');
});

after(() => rmSync(root, { recursive: true, force: true }));

test('rewriteHref：章節 .md 換成 .html，README 換成 index.html，其餘相對路徑加 ../，外部與錨點不動', () => {
  const chapters = [{ file: '01-tooling.md', stem: '01-tooling' }];
  assert.equal(rewriteHref('01-tooling.md', chapters), '01-tooling.html');
  assert.equal(rewriteHref('01-tooling.md#x', chapters), '01-tooling.html#x');
  assert.equal(rewriteHref('README.md', chapters), 'index.html');
  assert.equal(rewriteHref('diagrams/01-tooling.html', chapters), '../diagrams/01-tooling.html');
  assert.equal(rewriteHref('../../README.md', chapters), '../../../README.md');
  assert.equal(rewriteHref('https://example.com/x', chapters), 'https://example.com/x');
  assert.equal(rewriteHref('#anchor', chapters), '#anchor');
});

test('renderMarkdown：標題、表格、巢狀清單、程式碼區塊、引言、行內樣式', () => {
  const { html, title, headings } = renderMarkdown('# 標題\n\n## 一\n\n| a | b |\n| --- | --- |\n| `x` | **y** |\n\n- 甲\n  - 乙\n- 丙\n\n```sh\necho <hi>\n```\n\n> 引 *言*\n', [], []);
  assert.equal(title, '標題');
  assert.deepEqual(headings, [{ id: '一', text: '一' }]);
  assert.match(html, /<h2 id="一">一<\/h2>/);
  assert.match(html, /<th>a<\/th><th>b<\/th>/);
  assert.match(html, /<td><code>x<\/code><\/td><td><strong>y<\/strong><\/td>/);
  assert.match(html, /<ul>\n<li>甲\n<ul>\n<li>乙<\/li>\n<\/ul><\/li>\n<li>丙<\/li>\n<\/ul>/);
  assert.match(html, /<pre><code class="language-sh">echo &lt;hi&gt;<\/code><\/pre>/);
  assert.match(html, /<blockquote><p>引 <em>言<\/em><\/p><\/blockquote>/);
});

test('buildSite：首頁與每章一頁，側邊欄列出每章、每張圖與正式規範，互動圖以 iframe 內嵌', () => {
  const files = buildSite(root);
  assert.deepEqual(Object.keys(files).sort(), ['01-tooling.html', '02-lifecycle.html', 'index.html', 'static/site.css', 'static/site.js']);
  const index = files['index.html'];
  assert.match(index, /<title>首頁｜ron-skills 交付流程<\/title>/);
  assert.match(index, /<a href="index.html" aria-current="page">首頁<\/a>/);
  assert.match(index, /<a href="01-tooling.html">01 工具版圖<\/a>/);
  assert.match(index, /<a href="02-lifecycle.html">02 主流程<\/a>/);
  assert.match(index, /<a href="\.\.\/diagrams\/01-tooling.html" target="_blank" rel="noopener">工具版圖互動版<\/a>/);
  assert.match(index, /<nav class="rules"[^>]*><h2>正式規範（原始 Markdown）<\/h2><a href="\.\.\/\.\.\/\.\.\/README.md">README.md<\/a><a href="\.\.\/\.\.\/\.\.\/skills\/engineering\/issue-run\/ADAPTER.md">skills\/engineering\/issue-run\/ADAPTER.md<\/a><\/nav>/);
  assert.match(index, /<a href="\.\.\/\.\.\/\.\.\/README.md"><code>README.md<\/code><\/a>/);
  const tooling = files['01-tooling.html'];
  assert.match(tooling, /<a href="01-tooling.html" aria-current="page">/);
  assert.match(tooling, /<iframe src="\.\.\/diagrams\/01-tooling.html" title="工具版圖互動版" loading="lazy"><\/iframe>/);
  assert.match(tooling, /全頁開啟/);
  assert.match(tooling, /<li>Operator：<code>git push<\/code>\n<ul>\n<li>續行說明<\/li>\n<\/ul><\/li>/);
  const lifecycle = files['02-lifecycle.html'];
  assert.match(lifecycle, /<figure><img src="\.\.\/diagrams\/02-static.png"/);
  assert.doesNotMatch(lifecycle, /<iframe/);
  assert.match(lifecycle, /<a href="\.\.\/07-setup.md#1-skills">07<\/a>/, '不在 fixture 內的章節視為一般相對路徑');
  assert.match(lifecycle, /<ol>\n<li>/);
  for (const content of Object.values(files)) {
    assert.doesNotMatch(content, /20\d\d-\d\d-\d\dT|\/home\//, '輸出不得含時間戳或絕對路徑');
    assert.doesNotMatch(content, /spay|AGENTS\.md|issue-lifecycle/i, '通用版不得帶 spay2 專屬字串或規範');
  }
});

test('重產零 diff；手改 HTML 或多出檔案時 diffSite 與 --check 都擋下', () => {
  const siteDir = join(root, 'site');
  const first = spawnSync('node', [script, `--source=${root}`], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const check = spawnSync('node', [script, '--check', `--source=${root}`], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(diffSite(buildSite(root), siteDir), []);
  const indexPath = join(siteDir, 'index.html');
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('導讀文字', '手改'));
  writeFileSync(join(siteDir, 'extra.html'), 'x');
  assert.deepEqual(diffSite(buildSite(root), siteDir), ['extra.html', 'index.html']);
  const failed = spawnSync('node', [script, '--check', `--source=${root}`], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /node scripts\/build-workflow-site\.mjs/);
  assert.match(failed.stderr, /index\.html/);
  const rebuilt = spawnSync('node', [script, `--source=${root}`], { encoding: 'utf8' });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.deepEqual(diffSite(buildSite(root), siteDir), [], '重產會移除多出的檔案');
});

test('README 沒有 H1 時首頁標題用站名', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'build-workflow-site-noh1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'README.md'), '只有段落\n');
  assert.match(buildSite(dir)['index.html'], /<title>ron-skills 交付流程｜ron-skills 交付流程<\/title>/);
});
