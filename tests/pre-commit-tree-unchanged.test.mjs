// 要 commit 的樹和 HEAD 的樹相同時（只改訊息的 --amend、--allow-empty），pre-commit 不跑檢查（#621）。
// 真實情境：`git commit --amend -F msg` 只改訊息，那棵樹 commit 時已以 CHECK_PASS_SUBSET 通過，hook 卻又排 heavy-slot，
// 等滿 SLOT_TIMEOUT（exit 75）、印「下一步：先在要 commit 的樹上跑完整 bin/check…」後 exit 1，十幾分鐘後 amend 失敗。
// fixture 是真的 git commit：core.hooksPath 指向本 repo 的 .githooks/pre-commit 複本，bin/check 與 scripts/heavy-slot.mjs 是假的：
// 記下被呼叫，heavy-slot 一律 SLOT_TIMEOUT（exit 75），所以 hook 只要碰到檢查，commit 就失敗。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const hook = new URL('../.githooks/pre-commit', import.meta.url).pathname;
// 本檔自己也會在 pre-commit hook 裡跑：清掉繼承來的 GIT_* 與會改變分支的 CHECK_*。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('CHECK_')));

function fixture(t, { head = true } = {}) {
  const repo = mkdtempSync(join(realTmpdir(), 'pre-commit-tree-unchanged-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const dir of ['.githooks', 'bin', 'scripts']) mkdirSync(join(repo, dir));
  copyFileSync(hook, join(repo, '.githooks/pre-commit'));
  writeFileSync(join(repo, 'bin/check'), `#!/usr/bin/env bash\necho "$*" >> "${repo}/check-calls"\necho "CHECK_FAIL tests"\nexit 1\n`);
  chmodSync(join(repo, 'bin/check'), 0o755);
  writeFileSync(join(repo, 'scripts/heavy-slot.mjs'), `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(repo, 'slot-calls'))}, args.join(' ') + '\\n');
if (args[0] === 'status') { console.log('SLOTS 2/2 dir=/fake'); process.exit(0); }
console.error('SLOT_TIMEOUT ron-skills:pre-commit 1799s holders=spay2:check-contracts@1:1216s');
process.exit(75);
`);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { encoding: 'utf8', env });
  git('init', '-q');
  git('config', 'core.hooksPath', '.githooks');
  git('add', '-A');
  if (head) assert.equal(git('commit', '-q', '--no-verify', '-m', 'first').status, 0);
  const read = name => existsSync(join(repo, name)) ? readFileSync(join(repo, name), 'utf8') : '';
  return { repo, git, slotCalls: () => read('slot-calls'), checkCalls: () => read('check-calls') };
}

test('只改訊息的 --amend：exit 0、印 CHECK_TREE_UNCHANGED，不碰 heavy-slot 與 bin/check', t => {
  const f = fixture(t);
  const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
  const result = f.git('commit', '--amend', '-q', '-m', 'reworded');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`^CHECK_TREE_UNCHANGED ${tree}$`, 'm'));
  assert.equal(f.slotCalls(), '');
  assert.equal(f.checkCalls(), '');
  assert.equal(f.git('log', '-1', '--format=%s').stdout.trim(), 'reworded');
});

test('--allow-empty 的 commit 也不跑檢查', t => {
  const f = fixture(t);
  const result = f.git('commit', '--allow-empty', '-q', '-m', 'empty');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^CHECK_TREE_UNCHANGED [0-9a-f]+$/m);
  assert.equal(f.slotCalls(), '');
  assert.equal(f.checkCalls(), '');
});

test('樹有變的 --amend 照常檢查（這裡 slot 逾時，commit 失敗）', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'a.txt'), 'two\n');
  f.git('add', 'a.txt');
  const result = f.git('commit', '--amend', '-q', '-m', 'changed');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /CHECK_TREE_UNCHANGED/);
  assert.match(f.slotCalls(), /^run --label ron-skills:pre-commit -- bin\/check --changed$/m);
  assert.match(result.stderr, /^SLOT_TIMEOUT /m);
});

test('沒有 HEAD（第一個 commit）時照常檢查', t => {
  const f = fixture(t, { head: false });
  const result = f.git('commit', '-q', '-m', 'first');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /CHECK_TREE_UNCHANGED/);
  assert.match(f.slotCalls(), /^run --label ron-skills:pre-commit -- bin\/check --changed$/m);
});
