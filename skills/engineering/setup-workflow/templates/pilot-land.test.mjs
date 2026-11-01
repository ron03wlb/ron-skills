import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';

// 正本的通用路徑：沒有專案 resolver 時只自己解 workflow-templates.json 的 restamp，其他衝突一律 STOP conflict；
// 專案值（regression 指令、整合分支、主分支、resolver）都從參數來。ron-skills 的條目解法另在 tests/pilot-land.test.mjs 測。
const script = fileURLToPath(new URL('./pilot-land.mjs', import.meta.url));
const MANIFEST = 'docs/agents/workflow-templates.json';

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'PILOT_LOAD_MAX')),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', PILOT_LOAD_NOW: '0' };

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

// 假 regression 指令：每次呼叫在 $FAKE_CHECK_LOG 記下參數，通過時印 CHECK_PASS。
const FAKE_CHECK = `#!/bin/sh
echo "check $*" >> "$FAKE_CHECK_LOG"
echo "CHECK_PASS tests 1+2"
`;

/**
 * 主 checkout（main、整合分支）＋ stage worktree（停在整合分支）＋ 成員分支。members 是 [{ n, files }]，每個成員從整合分支開分支、寫入 files 後 commit。
 * `integration` 是整合分支名稱；`base` 是 main 上的額外檔案。
 */
function fixture(t, { members, base = {}, integration = 'pilot/integration' }) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-land-template-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@t');
  write(repo, { '.gitignore': '.scratch/\n', 'bin/check': FAKE_CHECK, ...base });
  chmodSync(join(repo, 'bin/check'), 0o755);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'branch', integration);
  for (const { n, files } of members) {
    const tree = join(temp, `issue-${n}`);
    git(repo, 'worktree', 'add', '-q', '-b', `issue/${n}-x`, tree, integration);
    write(tree, files);
    git(tree, 'add', '.');
    git(tree, 'commit', '-qm', `issue ${n}`);
  }
  const stageTree = join(temp, 'pilot-stage');
  git(repo, 'worktree', 'add', '-q', stageTree, integration);
  const key = members.map(m => m.n).join('-');
  const file = join(repo, `.scratch/pilot/batch-${key}.md`);
  write(repo, {
    [`.scratch/pilot/batch-${key}.md`]: `# batch ${key}\ncurrent: dispatched 2026-11-01T07:00:00+08:00\nintegration: ${integration} @ ${git(repo, 'rev-parse', '--short', integration)}\n\n`
      + '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n'
      + `${members.map(({ n }) => `| ${n} | issue/${n}-x | ${temp}/issue-${n} | term_${n} | 2026-11-01T07:00:00+08:00 | 90m | done | abc1234 |`).join('\n')}\n`,
  });
  const log = join(temp, 'check.log');
  writeFileSync(log, '');
  const land = (...args) => {
    const result = spawnSync('node', [script, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, FAKE_CHECK_LOG: log } });
    const lines = result.stdout.trim().split('\n');
    return { ...result, lines, last: lines.at(-1) };
  };
  return { temp, repo, stageTree, key, file, land, checks: () => readFileSync(log, 'utf8'), read: () => readFileSync(file, 'utf8') };
}

test('預設 regression 指令是 bin/check；--check-command 以 sh 跑指定的指令', t => {
  const plain = fixture(t, { members: [{ n: 1, files: { 'a.txt': 'a\n' } }] });
  const result = plain.land(plain.key);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.last, /^MERGED 1 [0-9a-f]{40}$/);
  assert.equal(plain.checks(), 'check \n');
  assert.match(plain.read(), /^regression: [0-9a-f]{40} exit 0 CHECK_PASS tests 1\+2$/m);

  const custom = fixture(t, { members: [{ n: 2, files: { 'b.txt': 'b\n' } }] });
  const flagged = custom.land(custom.key, '--check-command', 'bin/check --upstream');
  assert.equal(flagged.status, 0, flagged.stdout + flagged.stderr);
  assert.equal(custom.checks(), 'check --upstream\n');
});

test('--integration：stage 從指定的整合分支開、MERGED 後快轉它', t => {
  const f = fixture(t, { members: [{ n: 3, files: { 'c.txt': 'c\n' } }], integration: 'trunk/integration' });
  const result = f.land(f.key, '--integration', 'trunk/integration');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sha = git(f.repo, 'rev-parse', 'trunk/integration');
  assert.equal(result.last, `MERGED 3 ${sha}`);
  assert.equal(git(f.repo, 'show', `${sha}:c.txt`), 'c');
  assert.equal(git(f.stageTree, 'symbolic-ref', '--short', 'HEAD'), 'trunk/integration');
});

test('沒有 resolver：Markdown 條目衝突也不自己解，abort 後 STOP conflict（種類 other）', t => {
  const entry = name => `- **${name}.** 內容\n`;
  const f = fixture(t, {
    base: { 'docs/a.md': `${entry('A')}${entry('B')}` },
    members: [{ n: 1, files: { 'docs/a.md': `- **A.** 一\n${entry('B')}` } }, { n: 2, files: { 'docs/a.md': `${entry('A')}- **B.** 二\n` } }],
  });
  const result = f.land(f.key);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(result.last, 'STOP conflict 2 docs/a.md=member 1:other');
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
  assert.equal(f.checks(), '');
});

test('程式檔衝突的種類是 code', t => {
  const f = fixture(t, {
    base: { 'lib/x.mjs': 'export const x = 0;\n' },
    members: [{ n: 1, files: { 'lib/x.mjs': 'export const x = 1;\n' } }, { n: 2, files: { 'lib/x.mjs': 'export const x = 2;\n' } }],
  });
  assert.equal(f.land(f.key).last, 'STOP conflict 2 lib/x.mjs=member 1:code');
});

test('只有 workflow-templates.json 衝突：取兩邊 copies 的聯集重算，RESOLVED restamp', t => {
  const entry = (template, sha256) => ({ template, commit: 'c0ffee', sha256 });
  const manifest = copies => `${JSON.stringify({ copies }, null, 2)}\n`;
  const hash = text => spawnSync('shasum', ['-a', '256'], { input: text, encoding: 'utf8' }).stdout.split(' ')[0];
  const f = fixture(t, {
    base: { [MANIFEST]: manifest({}) },
    members: [
      { n: 1, files: { 'scripts/a.mjs': 'a\n', [MANIFEST]: manifest({ 'scripts/a.mjs': entry('t/a.mjs', hash('a\n')) }) } },
      { n: 2, files: { 'scripts/b.mjs': 'b\n', [MANIFEST]: manifest({ 'scripts/b.mjs': entry('t/b.mjs', hash('b\n')) }) } },
    ],
  });
  const result = f.land(f.key);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.lines.filter(line => line.startsWith('RESOLVED')), [`RESOLVED 2 restamp ${MANIFEST}`]);
  const merged = JSON.parse(git(f.repo, 'show', `pilot/integration:${MANIFEST}`));
  assert.deepEqual(Object.keys(merged.copies), ['scripts/a.mjs', 'scripts/b.mjs']);
  assert.equal(merged.copies['scripts/b.mjs'].sha256, hash('b\n'));
});

test('--resolver：專案模組解它認得的檔、補種類，專案戳記檔最後交給它的 restamp', t => {
  const f = fixture(t, {
    base: { 'notes.txt': 'base\n', 'stamp.json': '{}\n', 'other.txt': 'o\n' },
    members: [
      { n: 1, files: { 'notes.txt': 'one\n', 'stamp.json': '{"a":1}\n' } },
      { n: 2, files: { 'notes.txt': 'two\n', 'stamp.json': '{"b":1}\n' } },
    ],
  });
  // 專案 resolver：notes.txt 兩邊都留（依號碼），stamp.json 是專案戳記檔，寫成固定內容；other.txt 不認得（種類 custom）。
  write(f.temp, {
    'resolver.mjs': `import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const show = (tree, spec) => spawnSync('git', ['-C', tree, 'show', spec], { encoding: 'utf8' }).stdout;
export const STAMP_FILES = ['stamp.json'];
export function resolveFile(tree, path, kinds) {
  if (path !== 'notes.txt') return undefined;
  kinds.add('both');
  return show(tree, ':2:' + path) + show(tree, ':3:' + path);
}
export function conflictKind(tree, path) { return path === 'other.txt' ? 'custom' : undefined; }
export function restamp(tree, files) {
  writeFileSync(join(tree, 'stamp.json'), '{"restamped":true}\\n');
  return spawnSync('git', ['-C', tree, 'add', ...files]).status === 0;
}
`,
  });
  const resolver = join(f.temp, 'resolver.mjs');
  const result = f.land(f.key, '--resolver', resolver);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.lines.filter(line => line.startsWith('RESOLVED')), ['RESOLVED 2 both+restamp notes.txt stamp.json']);
  assert.equal(git(f.repo, 'show', 'pilot/integration:notes.txt'), 'one\ntwo');
  assert.equal(git(f.repo, 'show', 'pilot/integration:stamp.json'), '{"restamped":true}');

  const g = fixture(t, {
    base: { 'other.txt': 'o\n' },
    members: [{ n: 1, files: { 'other.txt': '1\n' } }, { n: 2, files: { 'other.txt': '2\n' } }],
  });
  write(g.temp, { 'resolver.mjs': readFileSync(resolver, 'utf8') });
  assert.equal(g.land(g.key, '--resolver', join(g.temp, 'resolver.mjs')).last, 'STOP conflict 2 other.txt=member 1:custom');
});

test('--resolver 指向不存在的模組：用法錯誤 exit 2，什麼都不動', t => {
  const f = fixture(t, { members: [{ n: 1, files: { 'a.txt': 'a\n' } }] });
  const before = f.read();
  const result = f.land(f.key, '--resolver', join(f.temp, 'missing.mjs'));
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(f.read(), before);
});

test('sync-main --main：讓整合分支包含 origin/<主分支>，落後時快轉', t => {
  const f = fixture(t, { members: [{ n: 1, files: { 'a.txt': 'a\n' } }] });
  const origin = join(f.temp, 'origin.git');
  git(f.temp, 'init', '-q', '--bare', '-b', 'trunk', origin);
  git(f.repo, 'remote', 'add', 'origin', origin);
  git(f.repo, 'branch', 'trunk', 'main');
  write(f.repo, { 'up.txt': 'up\n' });
  git(f.repo, 'add', 'up.txt');
  // 在 trunk 上多一個 commit 再 push：pilot/integration 落後 origin/trunk。
  const tree = git(f.repo, 'write-tree');
  const sha = git(f.repo, 'commit-tree', tree, '-p', 'trunk', '-m', 'up');
  git(f.repo, 'reset', '-q');
  git(f.repo, 'update-ref', 'refs/heads/trunk', sha);
  git(f.repo, 'push', '-q', 'origin', 'trunk');
  const result = f.land('sync-main', '--main', 'trunk');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.last, `SYNCED ${sha} ff`);
  assert.equal(git(f.repo, 'rev-parse', 'pilot/integration'), sha);
});
