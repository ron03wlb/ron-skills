// pre-commit 何時經全機共用的重型檢查 slot（#605）：子集只挑到少數測試檔卻和完整套件排同一個 slot，worker 兩次各等 1800 秒 SLOT_TIMEOUT，
// 而手動跑完整 bin/check 不經 slot、一跑就過。小子集直接跑；仍經 slot 而逾時時，hook 附上 slot 狀態與下一步。
// fixture：掛本 repo 的 .githooks/pre-commit，bin/check、scripts/check-subset.mjs、scripts/heavy-slot.mjs 都換成假的，記下被怎麼呼叫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const hook = new URL('../.githooks/pre-commit', import.meta.url).pathname;
// 本檔自己也會在 pre-commit hook 裡跑：清掉繼承來的 GIT_* 與會改變分支的 CHECK_*。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('CHECK_')));

function fixture(t, { plan, slotExit = 0 }) {
  const repo = mkdtempSync(join(realTmpdir(), 'pre-commit-slot-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const dir of ['.githooks', 'bin', 'scripts']) mkdirSync(join(repo, dir));
  copyFileSync(hook, join(repo, '.githooks/pre-commit'));
  writeFileSync(join(repo, 'bin/check'), `#!/usr/bin/env bash\necho "$*" >> "${repo}/check-calls"\necho "CHECK_SUBSET steps base tests 1"\necho "CHECK_PASS_SUBSET tests 3"\n`);
  chmodSync(join(repo, 'bin/check'), 0o755);
  if (plan !== undefined) writeFileSync(join(repo, 'scripts/check-subset.mjs'), plan === 'error' ? 'process.exit(1);\n' : `console.log(${JSON.stringify(plan)});\n`);
  writeFileSync(join(repo, 'scripts/heavy-slot.mjs'), `
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(repo, 'slot-calls'))}, args.join(' ') + '\\n');
if (args[0] === 'status') { console.log('SLOTS 2/2 dir=/fake'); console.log('HOLDER slot-1 spay2:check-contracts pid=1 held=1216s cwd=/x'); process.exit(0); }
if (${slotExit} === 75) { console.error('SLOT_TIMEOUT ron-skills:pre-commit 1799s holders=spay2:check-contracts@1:1216s'); process.exit(75); }
const command = args.slice(args.indexOf('--') + 1);
process.exit(spawnSync(command[0], command.slice(1), { stdio: 'inherit' }).status);
`);
  spawnSync('git', ['-C', repo, 'init', '-q'], { env });
  const run = (extra = {}) => spawnSync(join(repo, '.githooks/pre-commit'), { cwd: repo, encoding: 'utf8', env: { ...env, ...extra } });
  const read = name => existsSync(join(repo, name)) ? readFileSync(join(repo, name), 'utf8') : '';
  return { run, slotCalls: () => read('slot-calls'), checkCalls: () => read('check-calls') };
}

const tests = n => `SUBSET_STEPS base tests\nSUBSET_TESTS ${Array.from({ length: n }, (_, i) => `tests/t${i}.test.mjs`).join(' ')}`;

test('子集測試檔數不超過門檻：直接跑 bin/check --changed，不經 slot，stderr 印 CHECK_SLOT_SKIP', t => {
  const f = fixture(t, { plan: tests(2) });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.slotCalls(), '');
  assert.equal(f.checkCalls(), '--changed\n');
  assert.match(result.stderr, /^CHECK_SLOT_SKIP tests 2$/m);
  assert.match(result.stderr, /^CHECK_PASS_SUBSET tests 3$/m);
});

test('沒有測試檔的子集（只有 docs-rules 等步驟）也不經 slot', t => {
  const f = fixture(t, { plan: 'SUBSET_STEPS base docs-rules\nSUBSET_TESTS' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.slotCalls(), '');
  assert.match(result.stderr, /^CHECK_SLOT_SKIP tests 0$/m);
});

test('子集測試檔數超過門檻：照舊經 slot', t => {
  const f = fixture(t, { plan: tests(11) });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.slotCalls(), /^run --label ron-skills:pre-commit -- bin\/check --changed$/m);
  assert.doesNotMatch(result.stderr, /CHECK_SLOT_SKIP/);
});

test('門檻可用 CHECK_SLOT_FREE_TESTS 覆寫', t => {
  const f = fixture(t, { plan: tests(11) });
  const result = f.run({ CHECK_SLOT_FREE_TESTS: '20' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.slotCalls(), '');
  assert.match(result.stderr, /^CHECK_SLOT_SKIP tests 11$/m);
});

test('SUBSET_FULL、計畫出錯、CHECK_FULL=1：照舊經 slot', async t => {
  for (const [name, plan, extra] of [['full', 'SUBSET_FULL path .githooks/pre-commit', {}], ['error', 'error', {}], ['missing', undefined, {}], ['CHECK_FULL', tests(1), { CHECK_FULL: '1' }]]) {
    await t.test(name, t => {
      const f = fixture(t, { plan });
      const result = f.run(extra);
      assert.equal(result.status, 0, result.stderr);
      assert.match(f.slotCalls(), /^run --label ron-skills:pre-commit -- bin\/check --changed$/m);
      assert.doesNotMatch(result.stderr, /CHECK_SLOT_SKIP/);
    });
  }
});

test('經 slot 而 SLOT_TIMEOUT（exit 75）：stderr 附 heavy-slot status 與下一步，commit 失敗', t => {
  const f = fixture(t, { plan: tests(30), slotExit: 75 });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(f.checkCalls(), '');
  assert.match(f.slotCalls(), /^status$/m);
  assert.match(result.stderr, /^SLOT_TIMEOUT /m);
  assert.match(result.stderr, /^SLOTS 2\/2 dir=\/fake$/m);
  assert.match(result.stderr, /^HOLDER slot-1 spay2:check-contracts/m);
  assert.match(result.stderr, /bin\/check/);
  assert.match(result.stderr, /CHECK_STAMP_FRESH/);
});
