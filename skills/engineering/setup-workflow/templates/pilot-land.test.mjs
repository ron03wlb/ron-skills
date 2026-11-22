// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { gateIssues } from './lib/pilot-store.mjs';

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
function fixture(t, { members, base = {}, integration = 'pilot/integration', extraEnv = {} }) {
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
      + `${members.map(({ n, state = 'done', started = '2026-11-01T07:00:00+08:00' }) => `| ${n} | issue/${n}-x | ${temp}/issue-${n} | term_${n} | ${started} | 90m | ${state} | ${state === 'done' ? 'abc1234' : ''} |`).join('\n')}\n`,
  });
  const log = join(temp, 'check.log');
  writeFileSync(log, '');
  const land = (...args) => {
    const result = spawnSync('node', [script, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, FAKE_CHECK_LOG: log, ...extraEnv } });
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

// #367：gate 用 `- hold：#<n>` 擋住的成員不能被 stage；resolved 之後照常落地。
test('done 成員被開著的 gate hold 住：STOP held <n> G<k>、exit 4，不 stage、不跑 Regression；gate resolved 後 MERGED', t => {
  const f = fixture(t, { members: [{ n: 320, files: { 'a.txt': 'a\n' } }] });
  const tip = git(f.repo, 'rev-parse', 'pilot/integration');
  const gate = resolved => `# Gates\n\n## G28 #320 等人決定\n- Issue：#320\n- parked：batch 320 的 Stage\n- hold：#320\n- opened：2026-11-18T11:00:00+08:00\n${resolved}`;
  write(f.repo, { '.scratch/pilot/gates.md': gate('') });
  const held = f.land(f.key);
  assert.equal(held.status, 4, held.stdout + held.stderr);
  assert.equal(held.last, 'STOP held 320 G28');
  assert.equal(f.checks(), '');
  assert.match(f.read(), /^current: dispatched /m);
  assert.equal(git(f.repo, 'rev-parse', 'pilot/integration'), tip);
  write(f.repo, { '.scratch/pilot/gates.md': gate('- resolved 2026-11-18T12:00:00+08:00 選 A\n') });
  const landed = f.land(f.key);
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.last, /^MERGED 320 [0-9a-f]{40}$/);
});

// #406（investing#457 第 2 項）：#432 帶著沒人答的 Operator 問題（confirm ruling）落地，下游 #434 照樣派工、停在 STOP decision。
// 成員 checkpoint 的 `[confirm]` ruling 在 gates.md 沒有任何 gate 指向該 Issue 時不 stage；開了 gate（開著或已 resolved）就照常。
test('done 成員的 checkpoint 有 [confirm] ruling、gates.md 沒有它的 gate：STOP operator-questions <n> <數量>；開了 gate 後 MERGED', t => {
  const f = fixture(t, { members: [{ n: 432, files: { 'a.txt': 'a\n' } }] });
  const tip = git(f.repo, 'rev-parse', 'pilot/integration');
  write(f.temp, { 'issue-432/.scratch/issue-run-432/state.md': '# issue-run 432\n\n## rulings\n'
    + '- [confirm] 來源用 A；Issue 沒指定；source 驗收 2；rejected B\n[confirm] budgets.yaml 額度 300；沿用舊值；source ADR 0002；rejected 500\n'
    + '- [reversible] 測試放 tests/；慣例；source 驗收 1；rejected 無\n' });
  write(f.repo, { '.scratch/pilot/gates.md': '# Gates\n\n## G7 #77 別張單\n- Issue：#77\n- opened：2026-11-18T11:00:00+08:00\n' });
  const stopped = f.land(f.key);
  assert.equal(stopped.status, 4, stopped.stdout + stopped.stderr);
  assert.equal(stopped.last, 'STOP operator-questions 432 2');
  assert.equal(f.checks(), '');
  assert.match(f.read(), /^current: dispatched /m);
  assert.equal(git(f.repo, 'rev-parse', 'pilot/integration'), tip);
  write(f.repo, { '.scratch/pilot/gates.md': '# Gates\n\n## G29 #432 來源與額度\n- Issue：#432\n- opened：2026-11-19T11:00:00+08:00\n- resolved 2026-11-19T12:00:00+08:00 照 ruling\n' });
  const landed = f.land(f.key);
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.last, /^MERGED 432 [0-9a-f]{40}$/);
});

test('gateIssues：表格列的 Issue 欄與段落的 `- Issue：` 行，開著或已 resolved 都算；batch 欄與段落標題不算', () => {
  const text = '# Gates\n\n| id | Issue | question | options | default | parks | opened | status |\n|---|---|---|---|---|---|---|---|\n'
    + '| G1 | #9 | 誰？ | a｜b | b | #10 | 2026-10-30T13:23:09+08:00 | resolved 2026-10-30T13:29:27+08:00 選 b |\n'
    + '| G5 | batch 11 | 改名？ | 改｜不改 | 改 | - | 2026-10-31T11:00:00+08:00 | open |\n\n'
    + '## G28 #320 等人決定\n- Issue：#320、#321\n- hold：#320\n\n## G29 #55 只有標題\n- opened：2026-11-18T11:00:00+08:00\n';
  assert.deepEqual([...gateIssues(text)].sort(), ['320', '321', '9']);
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

// #430：旗標表是 object literal 時，`constructor`、`toString` 會命中 Object.prototype 而不是被當成未知旗標。
test('未知旗標（含 constructor、toString）：用法錯誤 exit 2，什麼都不動', t => {
  const f = fixture(t, { members: [{ n: 1, files: { 'a.txt': 'a\n' } }] });
  const before = f.read();
  for (const flag of ['--bogus', 'constructor', 'toString']) {
    const result = f.land(f.key, flag, 'x');
    assert.equal(result.status, 2, `${flag}：${result.stdout}${result.stderr}`);
  }
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

// #345：current:／regression: 的讀改寫走 checkpoint 鎖；手動 pilot-batch 持鎖到逾時時印 CHECKPOINT_LOCKED、exit 3，不拿舊內容整檔寫回。
test('checkpoint 被活著的 pid 鎖住到逾時：印 CHECKPOINT_LOCKED、exit 3，checkpoint 不動', t => {
  const f = fixture(t, { members: [{ n: 1, files: { 'a.txt': 'a\n' } }], extraEnv: { PILOT_STORE_LOCK_TIMEOUT_MS: '200' } });
  const before = f.read();
  const holder = `pid=${process.pid} at=2026-11-21T00:00:00.000Z test`;
  writeFileSync(`${f.file}.lock`, `${holder}\n`);
  const result = f.land(f.key);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.last, `CHECKPOINT_LOCKED ${f.file}.lock ${holder}`);
  assert.equal(f.read(), before);
});

// 假 Orca CLI：`screens` 是 handle → `terminal read --screen` 的 `{ status, tail }`，不在表裡的 handle 回 terminal_handle_stale。
function fakeOrca(temp, screens) {
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const arg = k => process.argv[process.argv.indexOf(k) + 1];
${orcaReplySource()}
const screen = ${JSON.stringify(screens)}[arg('--terminal')];
if (!screen) { fail('terminal_handle_stale'); process.exit(1); }
reply('read', { terminal: screen });
`);
  chmodSync(cli, 0o755);
  return cli;
}

const recent = () => new Date(Date.now() - 5 * 60000).toISOString();

// #361：pilot-watch 已印 `DONE 133 …`，緊接的 pilot-land 仍因 checkpoint 還記 running 而 STOP member，要先跑一輪 probe --apply。
// running 成員先用 Probe 的 worker 解析讀一次畫面：讀到 DONE 就照 --apply 寫回 done 與 candidate 再繼續。
test('running 成員的畫面最後是 DONE <n> <sha>：寫回 done 與 candidate 後照常 stage、MERGED', t => {
  const f = fixture(t, { members: [{ n: 133, state: 'running', started: recent(), files: { 'a.txt': 'a\n' } }] });
  const sha = git(f.repo, 'rev-parse', 'issue/133-x');
  const cli = fakeOrca(f.temp, { term_133: { status: 'running', tail: ['工作完成', `DONE 133 ${sha}`, ''] } });
  const result = spawnSync('node', [script, f.key], { cwd: f.repo, encoding: 'utf8', env: { ...env, FAKE_CHECK_LOG: join(f.temp, 'check.log'), ORCA_CLI_COMMAND: cli } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = result.stdout.trim().split('\n');
  assert.equal(out[0], `WORKER 133 DONE ${sha}`);
  assert.match(out.at(-1), /^MERGED 133 [0-9a-f]{40}$/);
  assert.match(f.read(), new RegExp(`^\\| 133 \\| issue/133-x \\|.*\\| done \\| ${sha} \\|$`, 'm'));
});

test('running 成員仍在工作或讀不到畫面：STOP member <n> running 並提示 probe --apply，成員列不動', t => {
  const working = fixture(t, { members: [{ n: 133, state: 'running', started: recent(), files: { 'a.txt': 'a\n' } }] });
  const before = working.read();
  const cli = fakeOrca(working.temp, { term_133: { status: 'running', tail: ['● 跑測試中…'] } });
  const run = (f, extra) => spawnSync('node', [script, f.key], { cwd: f.repo, encoding: 'utf8', env: { ...env, FAKE_CHECK_LOG: join(f.temp, 'check.log'), ...extra } });
  const busy = run(working, { ORCA_CLI_COMMAND: cli });
  assert.equal(busy.status, 4, busy.stdout + busy.stderr);
  assert.match(busy.stdout.trim().split('\n').at(-1), /^STOP member 133 running \(RUNNING \d+\)，先跑 pilot-probe\.mjs --apply$/);
  assert.equal(working.read(), before);
  assert.equal(working.checks(), '');

  const stale = fixture(t, { members: [{ n: 133, state: 'running', started: recent(), files: { 'a.txt': 'a\n' } }] });
  const staleBefore = stale.read();
  const failed = run(stale, { ORCA_CLI_COMMAND: fakeOrca(stale.temp, {}) });
  assert.equal(failed.status, 4, failed.stdout + failed.stderr);
  assert.equal(failed.stdout.trim().split('\n').at(-1), 'STOP member 133 running (STUCK orca terminal_handle_stale)，先跑 pilot-probe.mjs --apply');
  assert.equal(stale.read(), staleBefore);

  const noOrca = fixture(t, { members: [{ n: 133, state: 'running', started: recent(), files: { 'a.txt': 'a\n' } }] });
  const bare = spawnSync('node', [script, noOrca.key], { cwd: noOrca.repo, encoding: 'utf8',
    env: Object.fromEntries(Object.entries({ ...env, FAKE_CHECK_LOG: join(noOrca.temp, 'check.log') }).filter(([key]) => key !== 'ORCA_CLI_COMMAND')) });
  assert.equal(bare.stdout.trim().split('\n').at(-1), 'STOP member 133 running (STUCK no-orca)，先跑 pilot-probe.mjs --apply');
});

// 畫面是 STOP 時照 --apply 寫回 stop，接著和以前一樣 STOP member <n> stop（stop 成員要先 move）。
test('running 成員的畫面最後是 STOP <n> <cause>：寫回 stop 後 STOP member <n> stop', t => {
  const f = fixture(t, { members: [{ n: 133, state: 'running', started: recent(), files: { 'a.txt': 'a\n' } }] });
  const cli = fakeOrca(f.temp, { term_133: { status: 'running', tail: ['STOP 133 decision 選哪個格式'] } });
  const result = spawnSync('node', [script, f.key], { cwd: f.repo, encoding: 'utf8', env: { ...env, FAKE_CHECK_LOG: join(f.temp, 'check.log'), ORCA_CLI_COMMAND: cli } });
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['WORKER 133 STOP decision 選哪個格式', 'STOP member 133 stop']);
  assert.match(f.read(), /^\| 133 \|.*\| stop \| +\|$/m);
});

// #361：Regression 期間 checkpoint 留 `regressing: <staged sha> pid <pid>`，Probe 據此印 REGRESSING 而不是 RESTAGE … none；
// regression 行寫入時同一次寫入拿掉它。
test('Regression 期間 checkpoint 有 regressing 標記，寫 regression 行時拿掉', t => {
  const f = fixture(t, { members: [{ n: 1, files: { 'a.txt': 'a\n' } }] });
  const during = join(f.temp, 'during.md');
  const result = f.land(f.key, '--check-command', `cp '${f.file}' '${during}' && echo 'CHECK_PASS tests 1'`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const staged = result.lines.find(line => line.startsWith('STAGED ')).split(' ')[2];
  const copy = readFileSync(during, 'utf8');
  assert.match(copy, new RegExp(`^current: staged ${staged} onto [0-9a-f]{40}$`, 'm'));
  assert.match(copy, new RegExp(`^regressing: ${staged} pid \\d+$`, 'm'));
  assert.doesNotMatch(f.read(), /^regressing:/m);
  assert.match(f.read(), new RegExp(`^regression: ${staged} exit 0 CHECK_PASS tests 1$`, 'm'));
});

/**
 * 給 fixture 加 origin（bare，主分支 main）：先在整合分支（stage worktree）commit `integration`，再在 main commit `upstream`，最後 push main。
 * 傳回 origin/main 的 SHA。兩邊都空時整合分支就是 origin/main。
 */
function withOrigin(f, { upstream = {}, integration = {} } = {}) {
  const origin = join(f.temp, 'origin.git');
  git(f.temp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(f.repo, 'remote', 'add', 'origin', origin);
  for (const [tree, files, message] of [[f.stageTree, integration, 'integration only'], [f.repo, upstream, 'upstream']]) {
    if (!Object.keys(files).length) continue;
    write(tree, files);
    git(tree, 'add', '--', ...Object.keys(files));
    git(tree, 'commit', '-qm', message);
  }
  git(f.repo, 'push', '-q', 'origin', 'main');
  return git(f.repo, 'rev-parse', 'main');
}

// #366（investing#313：batch 299 stage 在落後 origin/develop 的整合分支上，Push gate 拒推，完整回歸跑了兩次）：
// 要 stage 時先確認 origin/<主分支> 是整合分支的祖先，不是就在同一次執行裡照 sync-main 同步，再從同步後的 tip stage。
test('stage 前 origin/<主分支> 不是整合分支的祖先（落後）：同一次執行先 SYNCED … ff 再從新的 tip stage、MERGED', t => {
  const f = fixture(t, { members: [{ n: 1, files: { 'a.txt': 'a\n' } }] });
  const upstream = withOrigin(f, { upstream: { 'up.txt': 'up\n' } });
  const result = f.land(f.key);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.lines.length, 3, result.stdout);
  assert.equal(result.lines[0], `SYNCED ${upstream} ff`);
  assert.match(result.lines[1], new RegExp(`^STAGED 1 [0-9a-f]{40} onto ${upstream}$`));
  assert.match(result.last, /^MERGED 1 [0-9a-f]{40}$/);
  const tip = git(f.repo, 'rev-parse', 'pilot/integration');
  assert.equal(git(f.repo, 'merge-base', '--is-ancestor', upstream, tip), '');
  assert.equal(f.checks(), 'check \n');
});

test('stage 前整合分支與 origin/<主分支> 分叉：照 sync-main 合併並跑 Regression，通過後才 stage', t => {
  const f = fixture(t, { members: [{ n: 1, files: { 'a.txt': 'a\n' } }] });
  const upstream = withOrigin(f, { upstream: { 'up.txt': 'up\n' }, integration: { 'int.txt': 'int\n' } });
  const result = f.land(f.key);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [synced, staged] = result.lines;
  const [, sha] = synced.match(/^SYNCED ([0-9a-f]{40}) CHECK_PASS tests 1\+2$/) ?? [];
  assert.ok(sha, result.stdout);
  assert.equal(git(f.repo, 'merge-base', '--is-ancestor', upstream, sha), '');
  assert.match(staged, new RegExp(`^STAGED 1 [0-9a-f]{40} onto ${sha}$`));
  assert.match(result.last, /^MERGED 1 [0-9a-f]{40}$/);
  assert.equal(f.checks(), 'check \ncheck \n');
});

test('stage 前 origin/<主分支> 已是整合分支的祖先：不同步，輸出與沒有 origin 時相同', t => {
  const f = fixture(t, { members: [{ n: 1, files: { 'a.txt': 'a\n' } }] });
  withOrigin(f);
  const result = f.land(f.key);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.lines.length, 2, result.stdout);
  assert.match(result.lines[0], /^STAGED 1 [0-9a-f]{40} onto [0-9a-f]{40}$/);
  assert.match(result.last, /^MERGED 1 [0-9a-f]{40}$/);
  assert.equal(f.checks(), 'check \n');
});

test('stage 前同步失敗（sync-main 衝突）：STOP conflict sync-main、不 stage、不跑 Regression，checkpoint 與整合分支都不動', t => {
  const f = fixture(t, { members: [{ n: 1, files: { 'a.txt': 'a\n' } }] });
  withOrigin(f, { upstream: { 'same.txt': 'up\n' }, integration: { 'same.txt': 'int\n' } });
  const tip = git(f.repo, 'rev-parse', 'pilot/integration');
  const before = f.read();
  const result = f.land(f.key);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(result.last, 'STOP conflict sync-main same.txt');
  assert.ok(!result.stdout.includes('STAGED'), result.stdout);
  assert.equal(f.checks(), '');
  assert.equal(f.read(), before);
  assert.equal(git(f.repo, 'rev-parse', 'pilot/integration'), tip);
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
});
