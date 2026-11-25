// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHits, findTemplateCopies, parseArgs, parseWorktrees } from './concurrent-edits.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./concurrent-edits.mjs', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const commit = (cwd, file, message) => { writeFileSync(join(cwd, file), message); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', message); };

test('parseArgs：至少一個檔案；--base 取值；--json 旗標；未知旗標回傳 null', () => {
  assert.deepEqual(parseArgs(['a.md', 'b.mjs']), { base: null, json: false, files: ['a.md', 'b.mjs'] });
  assert.deepEqual(parseArgs(['--json', '--base', 'abc', 'a.md']), { base: 'abc', json: true, files: ['a.md'] });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['--base']), null);
  assert.equal(parseArgs(['--force', 'a.md']), null);
});

test('parseWorktrees：第一筆是主 worktree；detached 的 branch 為 null', () => {
  assert.deepEqual(parseWorktrees('worktree /m\nHEAD aaa\nbranch refs/heads/integration\n\nworktree /w\nHEAD bbb\ndetached\n'),
    [{ path: '/m', branch: 'integration' }, { path: '/w', branch: null }]);
});

test('findHits：略過自己的 worktree；他人已提交、未提交與整合分支 commit 各成一筆，只算指定檔案', () => {
  const hits = findHits({
    files: ['a.md', 'b.mjs'], self: '/self', integration: 'integration',
    worktrees: [
      { path: '/self', branch: 'me', committed: ['a.md'], uncommitted: ['b.mjs'] },
      { path: '/other', branch: 'other', committed: ['a.md', 'c.txt'], uncommitted: ['b.mjs'] },
    ],
    integrationCommits: [{ sha: '0123456789abcdef', subject: 'chore: x', files: ['b.mjs', 'z.txt'] }],
  });
  assert.deepEqual(hits.map(hit => [hit.kind, hit.file]), [['COMMITTED', 'a.md'], ['UNCOMMITTED', 'b.mjs'], ['INTEGRATION', 'b.mjs']]);
  assert.equal(hits[2].detail, '012345678 chore: x');
});

/** 主 worktree 在 integration；other 分支改了 a.md（已提交）與 b.mjs（未提交）；整合分支在 base 之後又動了 c.txt。 */
const fixture = t => {
  const root = mkdtempSync(join(realTmpdir(), 'concurrent-edits-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  git(root, 'init', '-q', '-b', 'integration', main);
  for (const file of ['a.md', 'b.mjs', 'c.txt']) commit(main, file, `base ${file}`);
  const base = git(main, 'rev-parse', 'HEAD');
  const mine = join(root, 'mine'); git(main, 'worktree', 'add', '-q', '-b', 'mine', mine, 'integration');
  const other = join(root, 'other'); git(main, 'worktree', 'add', '-q', '-b', 'other', other, 'integration');
  commit(other, 'a.md', 'other a');
  writeFileSync(join(other, 'b.mjs'), 'dirty');
  commit(main, 'c.txt', 'integration c');
  return { root, main, mine, base };
};
const run = (cwd, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });

test('CLI：從自己的 worktree 查，列出他人分支已提交、他人工作目錄未提交與整合分支 base 之後的 commit；exit 3', t => {
  const { mine } = fixture(t);
  const result = run(mine, 'a.md', 'b.mjs', 'c.txt');
  assert.equal(result.status, 3, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3, result.stdout);
  assert.match(lines[0], /^COMMITTED .*\/other a\.md other 已提交、未合入 integration$/);
  assert.match(lines[1], /^UNCOMMITTED .*\/other b\.mjs 工作目錄有未提交變更$/);
  assert.match(lines[2], /^INTEGRATION integration c\.txt [0-9a-f]{9} integration c$/);
});

test('CLI：沒有命中印 CLEAR 並 exit 0；--json 輸出 hits 陣列；路徑相對於 cwd 解析', t => {
  const { mine } = fixture(t);
  const clear = run(mine, 'z.txt');
  assert.equal(clear.status, 0, clear.stderr);
  assert.equal(clear.stdout.trim(), 'CLEAR');
  const json = JSON.parse(run(mine, '--json', './a.md').stdout);
  assert.equal(json.integration, 'integration');
  assert.deepEqual(json.hits.map(hit => hit.kind), ['COMMITTED']);
});

test('CLI：沒有檔案參數 exit 2', t => {
  const { mine } = fixture(t);
  assert.equal(run(mine).status, 2);
});

test('findTemplateCopies：只取清單 copies 有 template 的檔，依輸入順序；沒有清單時為空', () => {
  const copies = { 'scripts/b.mjs': { template: 'skills/engineering/setup-workflow/templates/b.mjs' }, 'scripts/a.mjs': { template: 'skills/engineering/setup-workflow/templates/a.mjs' } };
  assert.deepEqual(findTemplateCopies(['scripts/a.mjs', 'x.md', 'scripts/b.mjs'], copies).map(copy => copy.file), ['scripts/a.mjs', 'scripts/b.mjs']);
  assert.deepEqual(findTemplateCopies(['scripts/a.mjs'], undefined), []);
});

// retro spay2 ddc8bd0e#1：舊版對 workflow-templates.json 列出的副本 scripts/claude-hook-language.mjs 只印 CLEAR，
// 之後只改正本就 commit，ron-skills pre-commit 才報 CHECK_FAIL docs-rules。
test('CLI：檔案是 workflow-templates.json 列出的副本時，在 CLEAR／命中之前印 TEMPLATE_COPY 與下一步，不改 exit code；沒有清單不印', t => {
  const { mine } = fixture(t);
  const template = 'skills/engineering/setup-workflow/templates/claude-hook-language.mjs';
  assert.doesNotMatch(run(mine, 'scripts/claude-hook-language.mjs').stdout, /TEMPLATE_COPY/);
  mkdirSync(join(mine, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(mine, 'docs', 'agents', 'workflow-templates.json'), JSON.stringify({ copies: { 'scripts/claude-hook-language.mjs': { template } } }));
  const result = run(mine, 'scripts/claude-hook-language.mjs', 'z.txt');
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines[0], `TEMPLATE_COPY scripts/claude-hook-language.mjs ${template}`);
  assert.match(lines[1], /^  下一步：改 ron-skills 正本 → .*copy-templates\.mjs <ron-skills> --no-tests --yes --staged claude-hook-language\.mjs → ron-skills commit 並 push → .*copy-templates\.mjs <本 worktree> --no-tests --yes claude-hook-language\.mjs$/);
  assert.match(lines[2], /^  開上游單前：node <ron-skills>\/\S*copy-templates\.mjs <本 worktree> --dry-run --no-tests claude-hook-language\.mjs（.*SAME.*UPDATE.*DIFF.*workflow-templates\.json.*不開上游單$/);
  assert.equal(lines[3], 'CLEAR');
  assert.equal(lines.length, 4, result.stdout);
  assert.deepEqual(JSON.parse(run(mine, '--json', 'scripts/claude-hook-language.mjs').stdout).templateCopies, [{ file: 'scripts/claude-hook-language.mjs', template }]);
});

// #553（investing#679 第 9 項）：git-bypass 移出 copies、改列 localExceptions 後，改這支暫留的舊 hook 沒有 TEMPLATE_COPY 提示，
// 本地修補在拿掉例外重新複製時無聲消失。
test('TEMPLATE_COPY：localExceptions 內的檔也印 TEMPLATE_COPY 與來源行；只在 copies 內的檔輸出不變', t => {
  const { mine } = fixture(t);
  const template = name => `skills/engineering/setup-workflow/templates/${name}`;
  mkdirSync(join(mine, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(mine, 'docs', 'agents', 'workflow-templates.json'), JSON.stringify({
    localExceptions: ['scripts/claude-hook-git-bypass.mjs', 'test/fixtures/orca/'],
    copies: { 'scripts/claude-hook-language.mjs': { template: template('claude-hook-language.mjs') } },
  }));
  const result = run(mine, 'scripts/claude-hook-git-bypass.mjs', 'scripts/test/fixtures/orca/a.json', 'scripts/claude-hook-language.mjs', 'scripts/other.mjs');
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.deepEqual(lines.filter(line => !line.startsWith(' ')), [
    `TEMPLATE_COPY scripts/claude-hook-git-bypass.mjs ${template('claude-hook-git-bypass.mjs')}`,
    `TEMPLATE_COPY scripts/test/fixtures/orca/a.json ${template('test/fixtures/orca/a.json')}`,
    `TEMPLATE_COPY scripts/claude-hook-language.mjs ${template('claude-hook-language.mjs')}`,
    'CLEAR',
  ]);
  assert.match(lines[1], /^  來源：skills\/engineering\/setup-workflow\/templates\/claude-hook-git-bypass\.mjs（workflow-templates\.json 的 localExceptions 列了 scripts\/claude-hook-git-bypass\.mjs.*重新複製.*正本/);
  assert.match(lines[3], /^  來源：.*localExceptions 列了 test\/fixtures\/orca\/，/);
  // copies 內的檔：與沒有 localExceptions 時逐字相同。
  const copiesOnly = run(mine, 'scripts/claude-hook-language.mjs').stdout;
  writeFileSync(join(mine, 'docs', 'agents', 'workflow-templates.json'), JSON.stringify({ copies: { 'scripts/claude-hook-language.mjs': { template: template('claude-hook-language.mjs') } } }));
  assert.equal(run(mine, 'scripts/claude-hook-language.mjs').stdout, copiesOnly);
  assert.deepEqual(lines.slice(4, -1), copiesOnly.trimEnd().split('\n').slice(0, -1));
  writeFileSync(join(mine, 'docs', 'agents', 'workflow-templates.json'), JSON.stringify({ localExceptions: ['claude-hook-git-bypass.mjs'], copies: {} }));
  assert.deepEqual(JSON.parse(run(mine, '--json', 'scripts/claude-hook-git-bypass.mjs').stdout).templateCopies,
    [{ file: 'scripts/claude-hook-git-bypass.mjs', template: template('claude-hook-git-bypass.mjs'), localException: 'claude-hook-git-bypass.mjs' }]);
  // localExceptions 讀不懂時當作沒有，copies 照常。
  writeFileSync(join(mine, 'docs', 'agents', 'workflow-templates.json'), JSON.stringify({ localExceptions: 'scripts/claude-hook-git-bypass.mjs', copies: {} }));
  assert.equal(run(mine, 'scripts/claude-hook-git-bypass.mjs').stdout, 'CLEAR\n');
});

// #503：consumer 為副本開上游單前沒比對副本與範本，兩次開出早已修好的單；#498 真正擋住那條指令的是另一支 PreToolUse hook（bash-pitfalls）。
test('TEMPLATE_COPY：PreToolUse Bash hook 的副本多一行，把 fixture 送過每支 PreToolUse Bash hook；正本在本 repo（ron-skills）時不印開上游單前', t => {
  const { mine } = fixture(t);
  const template = name => `skills/engineering/setup-workflow/templates/${name}`;
  mkdirSync(join(mine, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(mine, 'docs', 'agents', 'workflow-templates.json'), JSON.stringify({ copies: {
    'scripts/claude-hook-zsh-equals.mjs': { template: template('claude-hook-zsh-equals.mjs') },
    'scripts/x.mjs': { template: template('x.mjs') },
  } }));
  const lines = run(mine, 'scripts/claude-hook-zsh-equals.mjs').stdout.trimEnd().split('\n');
  assert.equal(lines.length, 5, lines.join('\n'));
  assert.match(lines[2], /^  開上游單前：.*--dry-run --no-tests claude-hook-zsh-equals\.mjs（/);
  assert.match(lines[3], /^  hook 類：.*for h in zsh-equals bash-pitfalls git-bypass main-checkout; do node <ron-skills>\/skills\/engineering\/setup-workflow\/templates\/claude-hook-\$h\.mjs < <fixture\.json>.*exit 2.*不開上游單$/);
  mkdirSync(join(mine, 'skills', 'engineering', 'setup-workflow', 'templates'), { recursive: true });
  writeFileSync(join(mine, template('x.mjs')), '// 正本\n');
  assert.deepEqual(run(mine, 'scripts/x.mjs').stdout.trimEnd().split('\n').map(line => line.split('：')[0]), ['TEMPLATE_COPY scripts/x.mjs skills/engineering/setup-workflow/templates/x.mjs', '  下一步', 'CLEAR']);
});
