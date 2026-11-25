import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { env, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/entry-survival.mjs', import.meta.url).pathname;
const fixture = name => readFileSync(new URL(`fixtures/entry-survival-344/${name}.md.txt`, import.meta.url), 'utf8');
const TEMPLATE = 'skills/engineering/issue-run/PILOT-TEMPLATE.md';
const ROUND = 'skills/engineering/issue-run/PILOT-ROUND-TEMPLATE.md';

/** base commit 寫入 baseFiles，之後工作樹換成 treeFiles（null 表示刪檔）；回傳 repo 與 base SHA。 */
function repo(t, baseFiles, treeFiles) {
  const dir = mkdtempSync(join(realTmpdir(), 'entry-survival-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, baseFiles);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  for (const [path, content] of Object.entries(treeFiles)) {
    if (content === null) rmSync(join(dir, path));
    else write(dir, { [path]: content });
  }
  return { dir, base };
}

function run(dir, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// #344：fresh 重做把 PILOT-TEMPLATE.md 整檔取 prior（410f613），蓋掉整合分支（c581b85^）上 #346 的 Brief check。
test('#344 整檔取 prior 的整併報出 Brief check', t => {
  const { dir, base } = repo(t, { [TEMPLATE]: fixture('base-PILOT-TEMPLATE') }, {
    [TEMPLATE]: fixture('lost-PILOT-TEMPLATE'), [ROUND]: fixture('lost-PILOT-ROUND-TEMPLATE'),
  });
  const result = run(dir, base);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^ENTRY_CHANGED skills\/engineering\/issue-run\/PILOT-TEMPLATE\.md Brief check$/m);
});

test('#344 正確整併（c581b85）不報', t => {
  const { dir, base } = repo(t, { [TEMPLATE]: fixture('base-PILOT-TEMPLATE') }, {
    [TEMPLATE]: fixture('merged-PILOT-TEMPLATE'), [ROUND]: fixture('merged-PILOT-ROUND-TEMPLATE'),
  });
  const result = run(dir, base);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ENTRY_SURVIVAL_OK \d+$/m);
});

test('條目原文搬到預算表列的另一份檔不報；名稱也消失時報 ENTRY_LOST', t => {
  const budget = JSON.stringify({ 'docs/agents/pilot.md': 14000, 'docs/agents/pilot-round.md': 58000 });
  const { dir, base } = repo(t, {
    'scripts/adapter-size-budget.json': budget,
    'docs/agents/pilot.md': '# Pilot\n\n- **Probe.** 讀每個分頁。\n\n- **Stage.** 合入整合分支。  \n\n- **Gone.** 舊條目。\n',
  }, {
    'docs/agents/pilot.md': '# Pilot\n\n- **Gone-ish.** 不同名稱。\n',
    'docs/agents/pilot-round.md': '# Round\n\n- **Probe.** 讀每個分頁。\n\n- **Stage.** 合入整合分支。\n',
  });
  const result = run(dir, base);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, 'ENTRY_LOST docs/agents/pilot.md Gone\n');
});

test('帶檔名只檢查那些檔的條目', t => {
  const { dir, base } = repo(t, {
    [TEMPLATE]: '- **Kept.** a\n', [ROUND]: '- **Dropped.** b\n',
  }, { [ROUND]: null });
  assert.deepEqual(run(dir, base, TEMPLATE), { status: 0, stdout: 'ENTRY_SURVIVAL_OK 1\n', stderr: '' });
  assert.equal(run(dir, base).stdout, `ENTRY_LOST ${ROUND} Dropped\n`);
});

test('base 不是 commit 時 exit 2', t => {
  const { dir } = repo(t, { [TEMPLATE]: '- **Kept.** a\n' }, {});
  assert.equal(run(dir, 'no-such-ref').status, 2);
  assert.equal(run(dir).status, 2);
});
