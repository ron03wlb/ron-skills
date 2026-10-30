import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoFixture, source, run } from './test/repo-fixture.mjs';

function scan(f) { return run(f.repo, [process.execPath, join(source, 'check-markdown-links.mjs')]); }
function failures(result) { assert.notEqual(result.status, 0); return result.stderr.trim().split('\n').map(line => JSON.parse(line)); }
function docs(f, files) {
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(f.repo, path, '..'), { recursive: true }); writeFileSync(join(f.repo, path), text); }
}
test('檔案、<a id>、GitLab slug、reader slug 與重複 heading 皆可解析', t => {
  const f = repoFixture(t);
  docs(f, {
    'docs/a.md': '<a id="中文錨點"></a>\n## 4. Routing、金融與 workers\n## API freeze（目標）\n## 重複\n## 重複\n',
    'docs/b.md': ['[f](a.md)', '[id](a.md#中文錨點)', '[gl](a.md#4-routing金融與-workers)', '[reader](a.md#4-routing-金融與-workers)',
      '[dup-gl](a.md#重複-1)', '[dup-reader](a.md#重複-2)', '[self](#本頁)', '# 本頁', '[ext](https://example.invalid/x.md)', '[dir](../docs)'].join('\n'),
  });
  const result = scan(f); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
});
test('缺檔、缺 anchor、repo 外路徑皆拒絕並回報行號', t => {
  const f = repoFixture(t);
  docs(f, { 'docs/a.md': '## 標題\n', 'docs/b.md': '[x](missing.md)\n[y](a.md#不存在)\n[z](../../outside.md)\n' });
  assert.deepEqual(failures(scan(f)), [
    { path: 'docs/b.md', line: 1, href: 'missing.md', error: 'MISSING_FILE' },
    { path: 'docs/b.md', line: 2, href: 'a.md#不存在', error: 'MISSING_ANCHOR' },
    { path: 'docs/b.md', line: 3, href: '../../outside.md', error: 'OUTSIDE_REPO' },
  ]);
});
test('code fence 與 inline code 內的連結不檢查', t => {
  const f = repoFixture(t);
  docs(f, { 'docs/c.md': '```\n[x](missing.md)\n```\n`[y](missing.md)`\n' });
  assert.equal(scan(f).status, 0);
});
test('frontmatter 清單的 .md 路徑與 anchor 也檢查；非路徑項目與正文以外的 --- 不誤判', t => {
  const f = repoFixture(t);
  docs(f, {
    'docs/a.md': '<a id="adr-0001"></a>\n## 標題\n',
    'docs/b.md': ['---', 'source_documents:', '  - a.md#adr-0001', '  - ADR-0002（已移除，見 git abc1234）', '  - missing.md', '  - a.md#adr-0009', '---', '---', '  - also-missing.md'].join('\n'),
  });
  assert.deepEqual(failures(scan(f)), [
    { path: 'docs/b.md', line: 5, href: 'missing.md', error: 'MISSING_FILE' },
    { path: 'docs/b.md', line: 6, href: 'a.md#adr-0009', error: 'MISSING_ANCHOR' },
  ]);
});
test('docs/archive/ 內的來源檔凍結不檢查（連結與 frontmatter）', t => {
  const f = repoFixture(t);
  docs(f, { 'docs/archive/legacy/x.md': ['---', 'source_documents:', '  - gone.md', '---', '[x](missing.md)'].join('\n') });
  const result = scan(f); assert.equal(result.status, 0, result.stderr);
});
test('archive 以外指向 docs/archive/ 的連結照常檢查', t => {
  const f = repoFixture(t);
  docs(f, { 'docs/archive/legacy/x.md': '## 標題\n', 'docs/b.md': '[ok](archive/legacy/x.md#標題)\n[bad](archive/legacy/missing.md)\n' });
  assert.deepEqual(failures(scan(f)), [{ path: 'docs/b.md', line: 2, href: 'archive/legacy/missing.md', error: 'MISSING_FILE' }]);
});
