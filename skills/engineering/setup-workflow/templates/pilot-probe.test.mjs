import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { changedUnits } from './pilot-probe.mjs';

const script = new URL('./pilot-probe.mjs', import.meta.url).pathname;
// pre-commit hook 匯出的 GIT_DIR 等會讓暫存 repo 的 git 指令寫到本 repo。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const SHA = 'a'.repeat(40);

// 主 checkout（origin 是暫存的 bare repo，不碰網路）＋ `.scratch/pilot/` ＋ 假 Orca CLI。
// `screens` 是 handle → `terminal read --screen` 的 `{ status, tail }`；不在表裡的 handle 回 terminal_handle_stale。
// 假 Orca 會把 stdin 讀光並記錄讀到的內容：真實 Orca CLI 會吃掉 stdin，逐一讀成員時後面的成員就讀不到。
// `guard` 是 Bare guard（pilot-unbare.sh）的內容：有給時把 probe 複製到暫存的 scripts/，guard 放在它旁邊。
// PATH 上的假 gh：`repo view` 回 acme/app，`api graphql` 回一頁 `issues`（GraphQL 的 issue 節點），`issues` 是 null 時 gh 失敗；每次呼叫記進 gh.log。
// `world` 是 tracker 上的 Issue（{ number, state, labels, parent, body }）：給了它時假 gh 從它算出 GraphQL 節點（parent、subIssuesSummary），
// 並把 `issue edit <n> --add-label/--remove-label`、`issue reopen <n>` 寫回同一份檔，所以 --apply 之後再跑會看到改過的狀態。
function fixture(t, { screens = {}, guard, issues = [], world, tracker } = {}) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-probe-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const origin = join(temp, 'origin.git');
  const repo = join(temp, 'checkout');
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, '.gitignore'), '.scratch/\n');
  git('add', '.gitignore');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  const pilot = join(repo, '.scratch/pilot');
  mkdirSync(pilot, { recursive: true });

  const log = join(temp, 'orca.log');
  writeFileSync(log, '');
  const cli = join(temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const arg = k => process.argv[process.argv.indexOf(k) + 1];
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + (stdin ? ' STDIN ' + JSON.stringify(stdin) : '') + '\\n');
${orcaReplySource()}
const screens = ${JSON.stringify(screens)};
const screen = screens[arg('--terminal')];
if (!screen) { fail('terminal_handle_stale'); process.exit(1); }
reply('read', { terminal: screen });
`);
  chmodSync(cli, 0o755);

  const bin = join(temp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(temp, 'gh.log'))}, JSON.stringify([process.cwd(), ...args]) + '\\n');
const worldFile = ${JSON.stringify(join(temp, 'world.json'))};
let issues = ${JSON.stringify(issues)};
if (fs.existsSync(worldFile)) {
  const world = JSON.parse(fs.readFileSync(worldFile, 'utf8'));
  const find = n => world.find(issue => issue.number === Number(n));
  if (args[0] === 'issue' && ['edit', 'reopen'].includes(args[1])) {
    const target = find(args[2]);
    if (!target || target.failEdit) { process.stderr.write('HTTP 403: Resource not accessible\\n'); process.exit(1); }
    if (args[1] === 'reopen') target.state = 'OPEN';
    for (let i = 3; i < args.length; i++) {
      const [flag, inline] = args[i].split(/=(.*)/s);
      const value = inline ?? args[++i];
      if (flag === '--add-label' && !target.labels.includes(value)) target.labels.push(value);
      if (flag === '--remove-label') target.labels = target.labels.filter(name => name !== value);
    }
    fs.writeFileSync(worldFile, JSON.stringify(world));
    process.exit(0);
  }
  issues = world.filter(issue => issue.state === 'OPEN').map(issue => ({
    number: issue.number, body: issue.body ?? '',
    labels: { nodes: issue.labels.map(name => ({ name })) },
    blockedBy: { nodes: [] },
    subIssuesSummary: { total: world.filter(child => child.parent === issue.number).length },
    parent: issue.parent ? { number: issue.parent, state: find(issue.parent).state, repository: { nameWithOwner: 'acme/app' }, labels: { nodes: find(issue.parent).labels.map(name => ({ name })) } } : null,
  }));
}
if (issues === null) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }
// issue-pool 的分桶（POOL_*）要的欄位，fixture 沒寫的補成沒指派、沒有 blocking、沒有子單。
const node = issue => ({ title: '', assignees: { nodes: [] }, blocking: { nodes: [] }, comments: { nodes: [] }, timelineItems: { nodes: [] }, subIssuesSummary: { total: 0 }, ...issue });
if (args[0] === 'repo' && args[1] === 'view') process.stdout.write('acme/app\\n');
else if (args[0] === 'api' && args[1] === 'graphql') process.stdout.write(JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues.map(node) } } } }));
else process.exit(1);
`);
  chmodSync(join(bin, 'gh'), 0o755);
  if (world) writeFileSync(join(temp, 'world.json'), JSON.stringify(world));
  const probeEnv = { ...env, PATH: `${bin}:${env.PATH}` };

  const batch = (key, current, members) => writeFileSync(join(pilot, `batch-${key}.md`), `# batch ${key}
current: ${current}
integration: pilot/integration @ 1234567

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
${members.map(m => `| ${m.n} | issue/${m.n}-x | /w/issue-${m.n} | ${m.handle ?? `term_${m.n}`} | ${m.started ?? ago(5)} | ${m.stuckAfter ?? '90m'} | ${m.state ?? 'running'} | ${m.candidate ?? ''} |`).join('\n')}
`);
  // guard、world、tracker 都在暫存的 scripts/ 跑副本：templates/ 裡同目錄就有 gh-tracker.mjs 正本，--apply 會經它寫入（#244）。
  // tracker 是 adapter 內文：給了才連 gh-tracker.mjs 一起複製、寫 docs/agents/issue-run.md，否則 --apply 直接跑 gh issue。
  let probeScript = script;
  if (guard !== undefined || world !== undefined || tracker !== undefined) {
    const scripts = join(temp, 'scripts');
    mkdirSync(join(scripts, 'lib'), { recursive: true });
    const names = ['pilot-probe.mjs', 'pilot-capacity.mjs', 'orca-session-send.mjs', 'issue-pool.mjs', 'lib/hosts.mjs', 'lib/pilot-store.mjs', ...(tracker === undefined ? [] : ['gh-tracker.mjs'])];
    for (const name of names) copyFileSync(new URL(`./${name}`, import.meta.url), join(scripts, name));
    if (guard !== undefined) {
      writeFileSync(join(scripts, 'pilot-unbare.sh'), guard);
      chmodSync(join(scripts, 'pilot-unbare.sh'), 0o755);
    }
    if (tracker !== undefined) {
      mkdirSync(join(temp, 'docs', 'agents'), { recursive: true });
      writeFileSync(join(temp, 'docs', 'agents', 'issue-run.md'), tracker);
    }
    probeScript = join(scripts, 'pilot-probe.mjs');
  }
  const probe = ({ input = 'stdin 不該被 orca 讀到\n', args = [], extraEnv = {} } = {}) =>
    spawnSync('node', [probeScript, repo, ...args], { encoding: 'utf8', input, env: { ...probeEnv, ORCA_CLI_COMMAND: cli, ...extraEnv } });
  return { repo, pilot, origin, git, log, batch, probe, probeEnv, ghLog: join(temp, 'gh.log') };
}

// 池子摘要（POOL_EMPTY｜POOL_READY｜POOL_FAILED，#240）每次都印一行；其他測試只看自己的行，比對前去掉它，池子的測試另外看 stdout。
const rest = result => result.stdout.split('\n').filter(line => !/^POOL_/.test(line)).join('\n');
const lines = result => rest(result).trim().split('\n');

// 重現過的錯：TUI 畫了框線時結果行尾端帶空白和 `│`，不先去掉就比對不到 DONE。
test('結果行帶 TUI 框線時仍讀出 DONE 與 STOP', t => {
  const { batch, probe } = fixture(t, { screens: {
    term_23: { status: 'running', tail: ['● 報告', `  DONE 23 ${SHA}      │`, '╰──────╯', '❯'] },
    term_46: { status: 'running', tail: ['│ STOP 46 findings after two review cycles      │', '❯'] },
  } });
  batch('23-46', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 23 }, { n: 46 }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lines(result).includes(`WORKER 23 DONE ${SHA}`), result.stdout);
  assert.ok(lines(result).includes('WORKER 46 STOP findings after two review cycles'), result.stdout);
});

// 過去手拼 probe 時漏掉的情況：worker 的 terminal 已經 exited，畫面卻沒有 DONE／STOP 行。
test('terminal exited 但沒有結果行時印 STUCK', t => {
  const { batch, probe } = fixture(t, { screens: { term_23: { status: 'exited', tail: ['● 還在想', 'Bye!'] } } });
  batch('23', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 23 }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lines(result).includes('WORKER 23 STUCK exited'), result.stdout);
});

test('超過 stuck-after 印 STUCK，還沒超過印 RUNNING <分鐘>；讀不到 terminal 也算 STUCK', t => {
  const { batch, probe } = fixture(t, { screens: {
    term_1: { status: 'running', tail: ['❯'] },
    term_2: { status: 'running', tail: ['❯'] },
  } });
  batch('1-2', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 1, started: ago(120) }, { n: 2, started: ago(7), stuckAfter: '30m' }]);
  batch('3', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 3 }]);
  const out = lines(probe());
  assert.ok(out.some(line => /^WORKER 1 STUCK stuck-after 1[12]\d$/.test(line)), out.join('\n'));
  assert.ok(out.some(line => /^WORKER 2 RUNNING [78]$/.test(line)), out.join('\n'));
  assert.ok(out.includes('WORKER 3 STUCK orca terminal_handle_stale'), out.join('\n'));
});

// 全機上限（#178）：--capacity <repo> 把這一輪還在跑的成員數（running 列扣掉這一輪讀到 DONE、STOP 的）寫進全機帳本自己那一列，
// 合計超過 $PILOT_MACHINE_WORKER_CAP 時印 OVER_CAP <合計> <上限>；只回報，不改派工。沒帶旗標時不碰帳本。
test('--capacity <repo> 把在跑的成員數寫進帳本，合計超過上限印 OVER_CAP', t => {
  const { batch, probe, repo } = fixture(t, { screens: {
    term_1: { status: 'running', tail: ['❯'] },
    term_2: { status: 'running', tail: ['DONE 2 ' + SHA] },
    term_3: { status: 'running', tail: ['❯'] },
  } });
  batch('1-2', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 1 }, { n: 2 }]);
  batch('3', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 3, started: ago(500) }, { n: 4, state: 'done', candidate: SHA }]);
  const ledger = join(repo, '..', 'pilot-workers.tsv');
  const extraEnv = { PILOT_WORKERS_LEDGER: ledger, PILOT_MACHINE_WORKER_CAP: '3' };
  assert.equal(probe({ extraEnv }).status, 0);
  assert.throws(() => readFileSync(ledger), /ENOENT/, '沒帶 --capacity 不該寫帳本');
  let out = lines(probe({ args: ['--capacity', 'acme'], extraEnv }));
  assert.match(readFileSync(ledger, 'utf8'), /^acme\t2\t\d{4}-/);
  assert.ok(!out.some(line => line.startsWith('OVER_CAP')), out.join('\n'));
  writeFileSync(ledger, `${readFileSync(ledger, 'utf8')}investing\t2\t${new Date().toISOString()}\n`);
  out = lines(probe({ args: ['--capacity', 'acme'], extraEnv }));
  assert.equal(out.at(-1), 'OVER_CAP 4 3', out.join('\n'));
  assert.equal(probe({ args: ['--capacity'], extraEnv }).status, 2);
  assert.equal(probe({ args: ['--capacity', 'a\tb'], extraEnv }).status, 2);
  assert.equal(probe({ args: ['--capacity', 'acme'], extraEnv: { ...extraEnv, PILOT_MACHINE_WORKER_CAP: 'x' } }).status, 2);
});

// 真實 Orca CLI 會吃掉 stdin；呼叫時 stdin 一律接 /dev/null，假 Orca 讀光 stdin 也只會讀到空的。
test('呼叫 orca 時不把 stdin 交給它，每個成員都讀得到', t => {
  const { batch, probe, log } = fixture(t, { screens: {
    term_23: { status: 'running', tail: [`DONE 23 ${SHA}`] },
    term_46: { status: 'running', tail: [`DONE 46 ${SHA}`] },
  } });
  batch('23-46', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 23 }, { n: 46 }]);
  const out = lines(probe({ input: 'term_46\n' }));
  assert.ok(out.includes(`WORKER 46 DONE ${SHA}`), out.join('\n'));
  assert.doesNotMatch(readFileSync(log, 'utf8'), /STDIN/);
  assert.match(readFileSync(log, 'utf8'), /^terminal read --terminal term_46 --screen --json$/m);
});

// 這一輪剛讀到 DONE 的成員與 checkpoint 已記成 done 的成員都算 done；stop 的成員要先移走（#163：照跑 pilot-land 只得到 STOP member）；
// 已經 staged、merged、closed 的 batch 不再印（它們的成員也都是 done）。
test('dispatched 的 batch 每個成員都 done 時才印 STAGEABLE <key>；有 done 也有 stop 時印 MOVE <key> <stop 成員>', t => {
  const { batch, probe } = fixture(t, { screens: {
    term_23: { status: 'running', tail: [`DONE 23 ${SHA}`] },
    term_30: { status: 'running', tail: ['❯'] },
  } });
  batch('22-23', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 22, state: 'done', candidate: 'abc1234' }, { n: 23 }]);
  batch('24-25', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 24, state: 'stop' }, { n: 25, state: 'done', candidate: 'abc1234' }]);
  batch('30-31', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 30 }, { n: 31, state: 'done', candidate: 'abc1234' }]);
  batch('8', 'closed 2026-10-30T13:38:21+08:00', [{ n: 8, state: 'done', candidate: 'abc1234' }]);
  const out = lines(probe());
  assert.ok(out.includes('STAGEABLE 22-23'), out.join('\n'));
  assert.ok(!out.some(line => /^STAGEABLE (24-25|30-31|8)$/.test(line)), out.join('\n'));
  assert.ok(out.includes('MOVE 24-25 24'), out.join('\n'));
});

// #191：batch 94 停在 `current: staged`，兩次 Regression 都 exit 1（計時測試在高負載下 flake），成員 done；
// probe 對 staged 的 batch 什麼都不印，接手的 coordinator 照 probe 行動就漏掉它。最後一行 regression 不是 staged SHA 的 exit 0
// （exit 不是 0、沒寫 exit、SHA 是先前那次 stage 的，或根本沒有這行）時印 RESTAGE <key> regression-failed <code 或 none>。
test('staged 的 batch 最後一行 regression 不是 staged SHA 的 exit 0：印 RESTAGE，通過的不印', t => {
  const { batch, probe, pilot } = fixture(t);
  const staged = 'd4a2f71' + '0'.repeat(33);
  const earlier = '0b8077b' + '0'.repeat(33);
  const onto = '4c080c6' + '0'.repeat(33);
  const regress = (key, rows) => writeFileSync(join(pilot, `batch-${key}.md`), readFileSync(join(pilot, `batch-${key}.md`), 'utf8') + rows.map(row => `${row}\n`).join(''));
  batch('94', `staged ${staged} onto ${onto}`, [{ n: 94, state: 'done', candidate: 'abc1234' }]);
  regress('94', [`regression: ${earlier} exit 1`, `regression: ${staged} exit 1`]);
  batch('95', `staged ${staged} onto ${onto}`, [{ n: 95, state: 'done', candidate: 'abc1234' }]);
  regress('95', [`regression: ${earlier} exit 1`, `regression: ${staged} exit 0 CHECK_PASS tests 1+2+3`]);
  batch('96', `staged ${staged} onto ${onto}`, [{ n: 96, state: 'done', candidate: 'abc1234' }]);
  batch('97', `staged ${staged} onto ${onto}`, [{ n: 97, state: 'done', candidate: 'abc1234' }]);
  regress('97', [`regression: ${earlier} exit 0 CHECK_PASS tests 1+2+3`]);
  batch('98', `staged ${staged.slice(0, 7)} onto ${onto}`, [{ n: 98, state: 'done', candidate: 'abc1234' }]);
  regress('98', [`regression: ${staged} exit 0`]);
  batch('99', `staged ${staged} onto ${onto}`, [{ n: 99, state: 'done', candidate: 'abc1234' }]);
  regress('99', [`regression: ${staged} bin/check --upstream`]);
  const out = lines(probe());
  assert.deepEqual(out.filter(line => /^RESTAGE /.test(line)), [
    'RESTAGE 94 regression-failed 1',
    'RESTAGE 96 regression-failed none',
    'RESTAGE 97 regression-failed none',
    'RESTAGE 99 regression-failed none',
  ], out.join('\n'));
  assert.ok(!out.some(line => /^STAGEABLE 9\d$/.test(line)), out.join('\n'));
});

// 舊格式 `pushed` 的 batch 在 checkpoint 只剩 `regression: <sha>` 指出合入的內容（Integrate 是 ff-only，staged SHA 就是 pilot/integration 的 tip）；
// `pushed <sha>`（#37）帶著同一個 SHA，還沒進 origin/main（PR 還開著）時印 NOT_IN_MAIN，coordinator 重跑 Push gate 接著合併。
// 判斷的是 fetch 之後的 origin/main：另一個 clone 推上去、本機還沒 fetch 的合入也要算 IN_MAIN。
test('pushed 的 batch fetch 後印 IN_MAIN 或 NOT_IN_MAIN', t => {
  const { batch, probe, git, origin, repo, pilot } = fixture(t);
  const commit = message => {
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('switch', '-q', '-c', 'pilot/integration');
  const landed = commit('landed');
  const other = join(origin, '..', 'other');
  spawnSync('git', ['clone', '-q', origin, other], { env });
  spawnSync('git', ['-C', other, 'fetch', '-q', repo, `${landed}:refs/heads/landed`], { env });
  spawnSync('git', ['-C', other, 'push', '-q', 'origin', 'landed:main'], { env });
  const pending = commit('pending');
  git('switch', '-q', 'main');
  batch('8', 'pushed', [{ n: 8, state: 'done', candidate: 'abc1234' }]);
  writeFileSync(join(pilot, 'batch-8.md'), readFileSync(join(pilot, 'batch-8.md'), 'utf8') + `regression: ${landed.slice(0, 7)} bin/check --upstream exit 0\n`);
  batch('9', `pushed ${pending}`, [{ n: 9, state: 'done', candidate: 'abc1234' }]);
  batch('10', 'pushed', [{ n: 10, state: 'done', candidate: 'abc1234' }]);
  const out = lines(probe());
  assert.ok(out.includes('IN_MAIN 8'), out.join('\n'));
  assert.ok(out.includes('NOT_IN_MAIN 9'), out.join('\n'));
  assert.ok(out.includes('NOT_IN_MAIN 10 no-sha'), out.join('\n'));
});

// #268：retro 直接合進 main 之後，整合分支落後 origin/main，Probe 沒報，coordinator 自己算 rev-list 才知道要 sync-main。
test('整合分支沒有包含 origin/main 時印 BEHIND_MAIN <落後數> <SHA>，跟上之後不印', t => {
  const { probe, git, origin, repo } = fixture(t);
  git('branch', 'pilot/integration', 'main');
  assert.ok(!lines(probe()).some(line => line.startsWith('BEHIND_MAIN')));
  const other = join(origin, '..', 'other');
  spawnSync('git', ['clone', '-q', origin, other], { env });
  spawnSync('git', ['-C', other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'retro'], { env });
  spawnSync('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:main'], { env });
  git('fetch', '-q', 'origin');
  const upstream = git('rev-parse', 'origin/main');
  const out = lines(probe());
  assert.ok(out.includes(`BEHIND_MAIN 1 ${upstream}`), out.join('\n'));
  git('branch', '-f', 'pilot/integration', upstream);
  assert.ok(!lines(probe()).some(line => line.startsWith('BEHIND_MAIN')), repo);
});

// #37：Integrate 設成 `merged <sha>` 之後、Push gate 做完之前中斷的 batch 沒人接手。
// pilot/integration 的 tip 等於最後一次 Regression SHA 才符合 Push gate 的前提，印 RESUME_PUSH 讓 coordinator 從第 1 步接著做；
// tip 不等於（Integrate 之後又有 commit）或沒有 regression 行時不能直接推，印 NOT_IN_MAIN 帶出原因交給人。
test('merged 的 batch 還沒進 origin/main：tip 等於 Regression SHA 印 RESUME_PUSH，否則印 NOT_IN_MAIN 與原因', t => {
  const { batch, probe, git, pilot } = fixture(t);
  const commit = message => {
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('switch', '-q', '-c', 'pilot/integration');
  const staged = commit('staged');
  const regression = key => writeFileSync(join(pilot, `batch-${key}.md`), readFileSync(join(pilot, `batch-${key}.md`), 'utf8')
    + `regression: ${staged} exit 0 CHECK_PASS tests 1+2\n`);
  batch('11', `merged ${staged}`, [{ n: 11, state: 'done', candidate: 'abc1234' }]);
  regression('11');
  batch('12', `merged ${staged}`, [{ n: 12, state: 'done', candidate: 'abc1234' }]);
  let out = lines(probe());
  assert.ok(out.includes('RESUME_PUSH 11'), out.join('\n'));
  assert.ok(out.includes('NOT_IN_MAIN 12 no-regression'), out.join('\n'));

  // 合入、還沒設成 pushed 就中斷：已經進 origin/main 的 merged batch 直接做 Close。
  git('push', '-q', 'origin', `${staged}:main`);
  assert.ok(lines(probe()).includes('IN_MAIN 11'));
  git('push', '-q', '-f', 'origin', `${staged}~1:main`);

  const moved = commit('after integrate');
  git('switch', '-q', 'main');
  out = lines(probe());
  assert.ok(out.includes(`NOT_IN_MAIN 11 tip ${moved.slice(0, 7)}`), out.join('\n'));
});

// #130：batch-96 第一次 stage 的 Regression 是 exit 1 卻被當成通過 ff 進整合分支，checkpoint 是 `merged <sha>` 加 `regression: <sha> exit 1`、
// tip 等於那個 SHA。只比 tip 會印 RESUME_PUSH，下一任 coordinator 照 Push gate 把沒通過的內容推進 PR；最後一行 regression 的 exit 不是 0
// 或 SHA 後面沒緊接 `exit <code>`（同 pilot-pr-body.mjs 的認定）時改印 NOT_IN_MAIN <key> regression-failed <code 或 none>。
test('merged 的 batch 最後一行 regression 沒通過或沒寫 exit：印 NOT_IN_MAIN regression-failed，不印 RESUME_PUSH', t => {
  const { batch, probe, git, pilot } = fixture(t);
  git('switch', '-q', '-c', 'pilot/integration');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'staged');
  const staged = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  const regression = (key, ...rows) => writeFileSync(join(pilot, `batch-${key}.md`), readFileSync(join(pilot, `batch-${key}.md`), 'utf8')
    + rows.map(row => `regression: ${staged} ${row}\n`).join(''));
  batch('96', `merged ${staged}`, [{ n: 96, state: 'done', candidate: 'abc1234' }]);
  regression('96', 'exit 1');
  batch('97', `merged ${staged}`, [{ n: 97, state: 'done', candidate: 'abc1234' }]);
  regression('97', 'exit 0 CHECK_PASS tests 1+2', 'exit 2');
  batch('98', `merged ${staged}`, [{ n: 98, state: 'done', candidate: 'abc1234' }]);
  regression('98', 'note only');
  batch('95', `merged ${staged}`, [{ n: 95, state: 'done', candidate: 'abc1234' }]);
  regression('95', 'bin/check --upstream exit 0');
  batch('99', `merged ${staged}`, [{ n: 99, state: 'done', candidate: 'abc1234' }]);
  regression('99', 'exit 1', 'exit 0 CHECK_PASS tests 1+2');
  const out = lines(probe());
  assert.ok(out.includes('NOT_IN_MAIN 96 regression-failed 1'), out.join('\n'));
  assert.ok(out.includes('NOT_IN_MAIN 97 regression-failed 2'), out.join('\n'));
  assert.ok(out.includes('NOT_IN_MAIN 98 regression-failed none'), out.join('\n'));
  assert.ok(out.includes('NOT_IN_MAIN 95 regression-failed none'), out.join('\n'));
  assert.ok(out.includes('RESUME_PUSH 99'), out.join('\n'));
  assert.deepEqual(out.filter(line => /^RESUME_PUSH (95|96|97|98)$/.test(line)), []);
});

// #136：G4（GitHub Actions 帳務）擋住所有 push 時，每輪 probe 對每個沒進 origin/main 的 batch 各印一行 NOT_IN_MAIN／RESUME_PUSH，
// coordinator 要逐行判斷「還在 gate 底下」，RESUME_PUSH 還可能被誤當成要接著做 Push gate。開著的 gate 的 parked 以 `all-push` 開頭時，
// 這些行合成一行 PUSH_PARKED <gate id> <batch 數> batches；IN_MAIN 照印（Close 不 push），gate resolved 後恢復原本的各行。
test('有 parked all-push 的開著 gate 時只印 PUSH_PARKED，resolved 後恢復 NOT_IN_MAIN／RESUME_PUSH', t => {
  const { batch, probe, git, pilot } = fixture(t);
  git('switch', '-q', '-c', 'pilot/integration');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'staged');
  const staged = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  batch('11', `merged ${staged}`, [{ n: 11, state: 'done', candidate: 'abc1234' }]);
  writeFileSync(join(pilot, 'batch-11.md'), readFileSync(join(pilot, 'batch-11.md'), 'utf8') + `regression: ${staged} exit 0 CHECK_PASS tests 1+2\n`);
  batch('12', `merged ${staged}`, [{ n: 12, state: 'done', candidate: 'abc1234' }]);
  batch('13', `pushed ${staged}`, [{ n: 13, state: 'done', candidate: 'abc1234' }]);
  batch('14', `pushed ${git('rev-parse', 'main')}`, [{ n: 14, state: 'done', candidate: 'abc1234' }]);
  const gates = resolved => `# Gates

| id | Issue | question | options | default | parks | opened | status |
|---|---|---|---|---|---|---|---|
| G2 | #12 | 要不要拆？ | 拆｜不拆 | 拆 | all-push | 2026-10-30T13:40:00+08:00 | resolved 2026-10-30T13:50:00+08:00 拆 |

## G3 只擋 batch 13
- Issue：batch 13
- parked：batch 13 的 Push gate
- opened：2026-10-31T09:00:00+08:00

## G4 GitHub Actions 帳務
- Issue：batch 120
- parked：all-push（帳務恢復前不 push）
- opened：2026-10-31T10:00:00+08:00
${resolved ? '- resolved 2026-10-31T12:00:00+08:00 帳務已恢復\n' : ''}`;
  writeFileSync(join(pilot, 'gates.md'), gates(false));
  let out = lines(probe());
  assert.deepEqual(out.filter(line => /^(PUSH_PARKED|NOT_IN_MAIN|RESUME_PUSH|IN_MAIN) /.test(line)), ['IN_MAIN 14', 'PUSH_PARKED G4 3 batches'], out.join('\n'));
  assert.ok(out.includes('GATE G4 GitHub Actions 帳務'), out.join('\n'));

  // 表格形式的 gate 讀 parks 欄；`all-pushes` 不是固定寫法，不算。
  writeFileSync(join(pilot, 'gates.md'), `${gates(true)}
| id | Issue | question | options | default | parks | opened | status |
|---|---|---|---|---|---|---|---|
| G5 | batch 11 | 改名？ | 改｜不改 | 改 | all-pushes | 2026-10-31T11:00:00+08:00 | open |
| G6 | batch 120 | 帳務？ | 等｜不等 | 等 | all-push | 2026-10-31T11:30:00+08:00 | open |
`);
  out = lines(probe());
  assert.deepEqual(out.filter(line => /^(PUSH_PARKED|NOT_IN_MAIN|RESUME_PUSH|IN_MAIN) /.test(line)), ['IN_MAIN 14', 'PUSH_PARKED G6 3 batches'], out.join('\n'));

  writeFileSync(join(pilot, 'gates.md'), gates(true));
  out = lines(probe());
  assert.deepEqual(out.filter(line => /^(PUSH_PARKED|NOT_IN_MAIN|RESUME_PUSH|IN_MAIN) /.test(line)),
    ['RESUME_PUSH 11', 'NOT_IN_MAIN 12 no-regression', 'NOT_IN_MAIN 13', 'IN_MAIN 14'], out.join('\n'));
});

// 主 checkout 的狀態沒問題時不印任何一行，有問題才各印一行：Bare guard 印的行、不在 main、有 hold 檔、
// `git status --short` 有內容（每行一個 DIRTY，帶 status 原文）。
test('主 checkout 正常時不印狀態行；沒有 Bare guard 時略過', t => {
  const { probe } = fixture(t);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(rest(result), '');
});

test('Bare guard 先跑（時機 probe），不在 main、有 hold、有改動時各印一行', t => {
  const { repo, pilot, git, probe } = fixture(t, { guard: '#!/bin/sh\necho "UNBARE $1 $2"\n' });
  git('switch', '-q', '-c', 'pilot/stage-8');
  writeFileSync(join(repo, 'stray.txt'), 'x');
  writeFileSync(join(pilot, 'hold'), '');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), [`UNBARE ${repo} probe`, 'NOT_MAIN pilot/stage-8', 'HOLD', 'DIRTY ?? stray.txt']);
});

test('Bare guard 失敗時 exit 1，不印狀態行', t => {
  const { probe } = fixture(t, { guard: '#!/bin/sh\necho 壞了 >&2\nexit 3\n' });
  const result = probe();
  assert.equal(result.status, 1);
  assert.equal(rest(result), '');
  assert.match(result.stderr, /pilot-unbare\.sh exit 3：壞了/);
});

// hold 檔是一行 JSON（PILOT-STORE.md）；舊的空檔仍然合法，代表「有 hold、沒有原因」（#55）。
for (const [name, content] of [['空檔', ''], ['JSON 行', '{"since":"2026-10-30T21:00:00+08:00","reason":"等 #27 合入","session":"1d6719b0-c957-4d42-84bc-8474ba2fa7c7"}\n']]) {
  test(`hold 檔是${name}時判定為 hold`, t => {
    const { pilot, probe } = fixture(t);
    writeFileSync(join(pilot, 'hold'), content);
    const result = probe();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(lines(result), ['HOLD']);
  });
}

// 開著的列：requests.md 沒標 `applied`／`declined` 的行；gates.md 表格 status 不是 `resolved` 的列，
// 以及 `## G<n>` 段落裡沒有 `resolved` 那一行的 gate。只印開著的，applied 的請求動輒數 KB（retro 7b74eb0b#2）。
test('requests.md 與 gates.md 只印還開著的列', t => {
  const { pilot, probe } = fixture(t);
  writeFileSync(join(pilot, 'requests.md'), `2026-10-30T16:54:31+08:00  request: 整理 preferences  source ab  applied 2026-10-30T17:00:43+08:00
2026-10-30T17:10:00+08:00  request: 先做 #46  source ac  declined 已在 batch
2026-10-30T17:26:01+08:00   hold 到 #27 合入   source ad
`);
  writeFileSync(join(pilot, 'gates.md'), `# Gates

| id | Issue | question | options | default | parks | opened | status |
|---|---|---|---|---|---|---|---|
| G1 | #9 | 試跑誰指定？ | (a)｜(b) | (b) | #10 | 2026-10-30T13:23:09+08:00 | resolved 2026-10-30T13:29:27+08:00 選 (b) |
| G2 | #12 | 要不要拆？ | 拆｜不拆 | 拆 | #12 | 2026-10-30T13:40:00+08:00 | open |

## G3 handoff 連續兩次 STOP create
- Issue：#38
- opened：2026-10-30T15:58:09+08:00
- resolved 2026-10-30T16:03:46+08:00 Operator 選「先合 #38 再交接」

## G5 #44 Node 22.19 沒有 node.test tracing channel
- Issue：#44
- opened：2026-10-30T17:01:03+08:00
`);
  const out = lines(probe());
  assert.deepEqual(out, [
    'REQUEST 2026-10-30T17:26:01+08:00   hold 到 #27 合入   source ad',
    'GATE G2 #12 要不要拆？',
    'GATE G5 #44 Node 22.19 沒有 node.test tracing channel',
  ]);
});

// 寫錯格式的 resolved（retro a6：G8 寫成 `- status：resolved …`）不算解除，gate 會一直被當成開著，
// 下一任 coordinator 再問一次人已經回答過的問題；另印 GATE_MALFORMED 指出那一行。
test('段落 gate 的 resolved 寫進別的欄位時印 GATE_MALFORMED', t => {
  const { pilot, probe } = fixture(t);
  writeFileSync(join(pilot, 'gates.md'), `# Gates

## G8 #31 consolidated 重派後仍有 findings
- Issue：#31（batch-31）
- question：resolved 以前的做法要不要沿用？
- opened：2026-10-30T19:13:47+08:00
- status：resolved 2026-10-30T19:21:18+08:00 Operator 選預設
`);
  assert.deepEqual(lines(probe()), [
    'GATE G8 #31 consolidated 重派後仍有 findings',
    'GATE_MALFORMED G8 - status：resolved 2026-10-30T19:21:18+08:00 Operator 選預設',
  ]);
});

// review 第一、二輪：標記只認最後一個 `source` 欄之後的 `applied`／`declined`，請求內文提到這兩個字（連同 source）不算已處理。
test('請求內文出現 applied 但沒有標記時仍是開著的', t => {
  const { pilot, probe } = fixture(t);
  writeFileSync(join(pilot, 'requests.md'), `2026-10-30T18:00:00+08:00  request: 撤回昨天 applied 的 preferences   source ad
2026-10-30T18:01:00+08:00  request: 刪掉 source 表裡 declined 的那幾列  source ae
`);
  assert.deepEqual(lines(probe()), [
    'REQUEST 2026-10-30T18:00:00+08:00  request: 撤回昨天 applied 的 preferences   source ad',
    'REQUEST 2026-10-30T18:01:00+08:00  request: 刪掉 source 表裡 declined 的那幾列  source ae',
  ]);
});

// checkpoint 的 started、stuck-after 寫壞時算不出是否卡住，不能默默印 RUNNING NaN 或退回 90 分鐘。
test('started 或 stuck-after 解析不了時印 STUCK checkpoint', t => {
  const { batch, probe } = fixture(t, { screens: { term_1: { status: 'running', tail: ['❯'] }, term_2: { status: 'running', tail: ['❯'] } } });
  batch('1-2', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 1, started: '17:31' }, { n: 2, stuckAfter: '2h' }]);
  const out = lines(probe());
  assert.ok(out.includes('WORKER 1 STUCK checkpoint started 17:31'), out.join('\n'));
  assert.ok(out.includes('WORKER 2 STUCK checkpoint stuck-after 2h'), out.join('\n'));
});

// 沒有 ORCA_CLI_COMMAND 時主 checkout、gate 等與 Orca 無關的檢查照跑，只有 running 成員讀不到。
test('沒有 ORCA_CLI_COMMAND 時其他檢查照跑，running 成員印 STUCK no-orca', t => {
  const { repo, pilot, batch, probeEnv } = fixture(t);
  writeFileSync(join(pilot, 'hold'), '');
  batch('23', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 23 }]);
  const result = spawnSync('node', [script, repo], { encoding: 'utf8', env: Object.fromEntries(Object.entries(probeEnv).filter(([key]) => key !== 'ORCA_CLI_COMMAND')) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['HOLD', 'WORKER 23 STUCK no-orca']);
});

// coordinator 讀主 checkout 的 adapter，pilot/integration 上的版本比較新時會照過時的規則 stage。
// issue-run.md 與它 Pilot 段連到的檔案 都比；只有 integration 有也算，兩邊相同或沒有 pilot/integration 時不印。
// review 第一輪：main 自己改了 adapter、integration 還沒跟上時，integration 的版本比較舊，不印（否則 coordinator 會改讀舊規則）。
const PILOT_SECTION = '# adapter\n\n## Pilot\n\n設定整份在 [pilot-rules.md](pilot-rules.md)。\n';

test('pilot/integration 的 adapter 比 main 新時印 ADAPTER_AHEAD <檔案>', t => {
  const { repo, git, probe } = fixture(t);
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), text);
      git('add', path);
    }
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  };
  commit({ 'docs/agents/issue-run.md': '# adapter\n' }, 'adapter');
  assert.equal(rest(probe()), '');
  git('branch', 'pilot/integration');
  assert.equal(rest(probe()), '');

  git('switch', '-q', 'pilot/integration');
  commit({ 'docs/agents/issue-run.md': PILOT_SECTION + '- Stage worktree\n', 'docs/agents/pilot-rules.md': '# pilot\n' }, 'newer adapter');
  git('switch', '-q', 'main');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['ADAPTER_AHEAD docs/agents/issue-run.md', 'ADAPTER_AHEAD docs/agents/pilot-rules.md']);

  // main 跟上 integration 之後只剩 integration 新改的 pilot-rules.md。
  git('merge', '-q', '--ff-only', 'pilot/integration');
  git('switch', '-q', 'pilot/integration');
  commit({ 'docs/agents/pilot-rules.md': '# pilot\n- Probe\n' }, 'newer pilot');
  git('switch', '-q', 'main');
  assert.deepEqual(lines(probe()), ['ADAPTER_AHEAD docs/agents/pilot-rules.md']);

  // main 直接合入新的 issue-run.md：integration 那份比較舊，不印。
  commit({ 'docs/agents/issue-run.md': PILOT_SECTION + '- Push gate\n' }, 'main adapter');
  assert.deepEqual(lines(probe()), ['ADAPTER_AHEAD docs/agents/pilot-rules.md']);

  // review 第二輪：integration 刪掉的檔讀不到（`git show pilot/integration:<檔案>` 會失敗），不印。
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', 'pilot/integration');
  git('switch', '-q', 'pilot/integration');
  git('merge', '-q', '--ff-only', 'main');
  git('rm', '-q', 'docs/agents/pilot-rules.md');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'drop pilot');
  git('switch', '-q', 'main');
  assert.equal(rest(probe()), '');
});

test('沒有本機 main 時不比 adapter，其他檢查照跑', t => {
  const { repo, git, probe } = fixture(t);
  git('switch', '-q', '-c', 'pilot/integration');
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  writeFileSync(join(repo, 'docs/agents/issue-run.md'), '# adapter\n');
  git('add', 'docs/agents/issue-run.md');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'adapter');
  git('branch', '-q', '-D', 'main');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['NOT_MAIN pilot/integration']);
});

// `moved` 的成員已經移到別的 batch（如 batch-21-27 的 #27），不再擋這個 batch；Claude Code 的結果 bullet 也可能是 `⏺`。
test('moved 成員不擋 STAGEABLE，⏺ 開頭的結果行也讀得到', t => {
  const { batch, probe } = fixture(t, { screens: { term_21: { status: 'running', tail: [`⏺ DONE 21 ${SHA}`] } } });
  batch('21-27', 'dispatched 2026-10-30T15:06:42+08:00', [{ n: 21 }, { n: 27, state: 'moved', candidate: '→ batch-27' }]);
  const out = lines(probe());
  assert.ok(out.includes(`WORKER 21 DONE ${SHA}`), out.join('\n'));
  assert.ok(out.includes('STAGEABLE 21-27'), out.join('\n'));
});

// adapter 的 Stage 條目把移走的成員寫成 `moved batch-<n>`；只認全等的 `moved` 時，batch-126-128 剩下 done 的 #128 一直不是 STAGEABLE。
test('moved batch-<n> 的成員同樣不擋 STAGEABLE', t => {
  const { batch, probe } = fixture(t);
  batch('126-128', 'dispatched 2026-10-31T09:07:00+08:00', [{ n: 126, state: 'moved batch-126' }, { n: 128, state: 'done', candidate: SHA }]);
  const out = lines(probe());
  assert.ok(out.includes('STAGEABLE 126-128'), out.join('\n'));
});

// #163：batch-131 只剩一個 stop 成員，舊判斷印 STAGEABLE 131，照跑 pilot-land 只得到 `STOP member 131 stop`。
test('只有 stop 成員的 batch 不印 STAGEABLE，改印 PARKED <key> <n…>', t => {
  const { batch, probe } = fixture(t);
  batch('131', 'dispatched 2026-10-31T13:49:54+08:00', [{ n: 131, state: 'stop' }]);
  const out = lines(probe());
  assert.ok(!out.includes('STAGEABLE 131'), out.join('\n'));
  assert.ok(out.includes('PARKED 131 131'), out.join('\n'));
});

// #163：#94 與 #123 改同一列，#94 暫緩到 #123 合入；#123 所在的 batch closed 之後才印 UNPARK，#123 被移走的舊 batch 關了不算。
test('parked after #m 的成員在 #m 以 done 留在 closed 的 batch 後印 UNPARK <n>', t => {
  const { batch, probe } = fixture(t);
  batch('94', 'dispatched 2026-10-31T13:57:05+08:00', [{ n: 94, state: 'parked after #123', candidate: SHA }]);
  batch('88', 'dispatched 2026-10-31T13:57:05+08:00', [{ n: 88, state: 'parked after #124', candidate: SHA }]);
  batch('123-131', 'closed moved', [{ n: 123, state: 'moved batch-123' }, { n: 131, state: 'moved batch-131' }]);
  batch('123', 'closed', [{ n: 123, state: 'done', candidate: SHA }]);
  batch('124', 'dispatched 2026-10-31T13:57:05+08:00', [{ n: 124, state: 'done', candidate: SHA }]);
  // review：#125 的 batch 關了卻沒合入（stop），不算 #125 合入。
  batch('77', 'dispatched 2026-10-31T13:57:05+08:00', [{ n: 77, state: 'parked after #125', candidate: SHA }]);
  batch('125', 'closed not dispatchable', [{ n: 125, state: 'stop' }]);
  const out = lines(probe());
  assert.ok(!out.includes('UNPARK 77'), out.join('\n'));
  assert.ok(out.includes('PARKED 94 94'), out.join('\n'));
  assert.ok(out.includes('UNPARK 94'), out.join('\n'));
  assert.ok(!out.includes('UNPARK 88'), out.join('\n'));
});

// 整合分支與主分支是專案的值：由參數傳入，預設 pilot/integration 與 main。
test('--integration、--main 換掉整合分支與主分支', t => {
  const { repo, git, pilot, probe } = fixture(t);
  const commit = (path, text, message) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
    git('add', path);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('branch', '-q', '-m', 'trunk');
  git('switch', '-q', '-c', 'feature-int');
  const staged = commit('docs/agents/issue-run.md', '# adapter\n', 'adapter');
  git('switch', '-q', 'trunk');
  writeFileSync(join(pilot, 'batch-5.md'), `# batch 5\ncurrent: merged ${staged}\nintegration: feature-int @ 1234567\n\n`
    + '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n'
    + `| 5 | issue/5-x | /w/issue-5 | term_5 | ${ago(5)} | 90m | done | abc1234 |\nregression: ${staged} exit 0\n`);
  git('push', '-q', 'origin', 'trunk');
  assert.deepEqual(lines(probe()), ['NOT_MAIN trunk', 'NOT_IN_MAIN 5 tip none']);
  assert.deepEqual(lines(probe({ args: ['--integration', 'feature-int', '--main', 'trunk'] })),
    ['ADAPTER_AHEAD docs/agents/issue-run.md', 'RESUME_PUSH 5']);
});

test('參數錯誤時 exit 2', t => {
  const { probe } = fixture(t);
  for (const args of [['--integration'], ['--bogus', 'x'], ['--main', 'a', '--main', 'b'], ['--integration', '--main']]) {
    const result = probe({ args });
    assert.equal(result.status, 2, `${args.join(' ')}：${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /^用法：/);
  }
});

// Pilot 段指向的同目錄檔案才算 adapter；其他段落的連結（Tracker 的 issue-tracker.md）與其他目錄的契約、skill 不算。
test('ADAPTER_AHEAD 只比 adapter 與它 Pilot 段連到的同目錄檔案', t => {
  const { repo, git, probe } = fixture(t);
  const files = {
    'docs/agents/issue-run.md': '# adapter\n\n## Tracker\n\n[issue-tracker.md](issue-tracker.md)\n\n## Pilot\n\n見 [pilot-rules.md](./pilot-rules.md#probe)、[契約](../../skills/x/PILOT-STORE.md)。\n\n## Permissions\n\n[perms.md](perms.md)\n',
    'docs/agents/issue-tracker.md': 'v1\n', 'docs/agents/pilot-rules.md': 'v1\n', 'docs/agents/perms.md': 'v1\n', 'skills/x/PILOT-STORE.md': 'v1\n',
  };
  const commit = (changes, message) => {
    for (const [path, text] of Object.entries(changes)) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), text);
      git('add', path);
    }
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  };
  commit(files, 'adapter');
  git('switch', '-q', '-c', 'pilot/integration');
  commit(Object.fromEntries(Object.keys(files).filter(path => path !== 'docs/agents/issue-run.md').map(path => [path, 'v2\n'])), 'newer');
  git('switch', '-q', 'main');
  assert.deepEqual(lines(probe()), ['ADAPTER_AHEAD docs/agents/pilot-rules.md']);
});

// #144：pilot.md 的 Close 條目單行約 3 KB，coordinator 讀整份 diff 被截斷。改動都在 `- **<名稱>.**` 條目裡時，檔名後面附
// 改動的條目名稱（依名稱排序、以 `,` 分隔，名稱可能有空格）；有任何條目以外的改動時省略名稱欄，表示要讀整份。
test('ADAPTER_AHEAD 附改動的條目名稱，有條目以外的改動時省略', t => {
  const { repo, git, probe } = fixture(t);
  const commit = (changes, message) => {
    for (const [path, text] of Object.entries(changes)) {
      writeFileSync(join(repo, path), text);
      git('add', path);
    }
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  };
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  const rules = entries => `# pilot\n\n前言。\n\n${entries.join('\n\n')}\n`;
  const base = ['- **Stage.** v1', '- **Scripts ahead.** v1', '- **Close.** v1\n  續行 v1'];
  commit({ 'docs/agents/issue-run.md': PILOT_SECTION, 'docs/agents/pilot-rules.md': rules(base) }, 'adapter');
  git('branch', 'pilot/integration');
  const ahead = (entries, message) => {
    git('switch', '-q', 'pilot/integration');
    git('reset', '-q', '--hard', 'main');
    commit({ 'docs/agents/pilot-rules.md': entries }, message);
    git('switch', '-q', 'main');
    const result = probe();
    assert.equal(result.status, 0, result.stderr);
    return lines(result);
  };

  assert.deepEqual(ahead(rules(['- **Stage.** v2', base[1], '- **Close.** v1\n  續行 v2']), 'stage+close'),
    ['ADAPTER_AHEAD docs/agents/pilot-rules.md Close,Stage']);
  assert.deepEqual(ahead(rules([...base, '- **New entry.** v1']), 'new entry'),
    ['ADAPTER_AHEAD docs/agents/pilot-rules.md New entry']);
  // 刪掉的條目取改動前的名稱，整合分支那份讀不到。
  assert.deepEqual(ahead(rules([base[0], base[2]]), 'drop entry'), ['ADAPTER_AHEAD docs/agents/pilot-rules.md Scripts ahead']);
  assert.deepEqual(ahead(rules(base).replace('前言。', '前言 v2。'), 'prose'), ['ADAPTER_AHEAD docs/agents/pilot-rules.md']);
  assert.deepEqual(ahead(rules(['- **Stage.** v2', ...base.slice(1)]).replace('前言。', '前言 v2。'), 'mixed'),
    ['ADAPTER_AHEAD docs/agents/pilot-rules.md']);
});

// #77：coordinator 拿 probe 的 WORKER 行手寫 sed 改成員列，表頭或空的 candidate 欄一變就靜默沒寫進去。
// `--apply` 照 PILOT-STORE.md 把 DONE 寫成 `done` 與 SHA、STOP 寫成 `stop`；stdout 與不帶 `--apply` 時相同，其他行一個 byte 都不動。
test('--apply 把 DONE、STOP 寫回成員列的 state 與 candidate，其他行不變', t => {
  const { batch, pilot, probe } = fixture(t, { screens: {
    term_23: { status: 'running', tail: [`DONE 23 ${SHA}`] },
    term_46: { status: 'running', tail: ['STOP 46 findings after two review cycles'] },
    term_50: { status: 'running', tail: ['❯'] },
  } });
  batch('23-46-50', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 23 }, { n: 46 }, { n: 50 }, { n: 51, state: 'done', candidate: 'abc1234' }]);
  const file = join(pilot, 'batch-23-46-50.md');
  const before = readFileSync(file, 'utf8');
  const plain = probe();
  assert.equal(readFileSync(file, 'utf8'), before, '不帶 --apply 時不寫檔');
  const applied = probe({ args: ['--apply'] });
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(lines(applied).filter(line => !/^WORKER 50 RUNNING/.test(line)), lines(plain).filter(line => !/^WORKER 50 RUNNING/.test(line)));
  const [old, now] = [before, readFileSync(file, 'utf8')].map(text => text.split('\n'));
  assert.equal(now.length, old.length);
  const changed = now.map((line, i) => [old[i], line]).filter(([a, b]) => a !== b);
  const row23 = old.find(line => line.startsWith('| 23 |'));
  const row46 = old.find(line => line.startsWith('| 46 |'));
  assert.deepEqual(changed, [
    [row23, row23.replace(/\| running \| +\|$/, `| done | ${SHA} |`)],
    // STOP 的 candidate 欄原樣保留（fixture 的空欄是兩個空白）。
    [row46, row46.replace('| running |', '| stop |')],
  ]);
  // 寫回之後再跑一次：成員已不是 running，不再讀 terminal，也不再改檔。
  const again = probe({ args: ['--apply'] });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(line => line.startsWith('| 23 |'))[0], row23.replace(/\| running \| +\|$/, `| done | ${SHA} |`));
});

// coordinator 的 retro：sed 沒對到成員列時沒有輸出也沒報錯。`--apply` 寫不回去時印出是哪一列，exit 1。
test('--apply 對不到唯一的成員列時印 APPLY_MISS 並 exit 1', t => {
  const { batch, pilot, probe } = fixture(t, { screens: { term_23: { status: 'running', tail: [`DONE 23 ${SHA}`] } } });
  batch('23', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 23 }, { n: 23 }]);
  const file = join(pilot, 'batch-23.md');
  const before = readFileSync(file, 'utf8');
  const result = probe({ args: ['--apply'] });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result).includes(`WORKER 23 DONE ${SHA}`), result.stdout);
  assert.ok(lines(result).includes('APPLY_MISS 23 23 rows 2'), result.stdout);
  assert.equal(readFileSync(file, 'utf8'), before);
});

// coordinator 的 retro：Push gate 印 LANDED 之後沒有指令把 `current: merged` 改成 `pushed`。
// `--apply` 看到 merged 的 batch 已在 origin/<主分支>（IN_MAIN）時寫成 `pushed <sha>`，後面的附註照留；pushed 的 batch 不動。
test('--apply 把已進 origin/main 的 merged batch 寫成 pushed <sha>', t => {
  const { batch, pilot, probe, git } = fixture(t);
  git('switch', '-q', '-c', 'pilot/integration');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'staged');
  const staged = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  git('push', '-q', 'origin', `${staged}:main`);
  batch('11', `merged ${staged} PR #9`, [{ n: 11, state: 'done', candidate: 'abc1234' }]);
  batch('12', `pushed ${staged}`, [{ n: 12, state: 'done', candidate: 'abc1234' }]);
  const [file11, file12] = ['11', '12'].map(key => join(pilot, `batch-${key}.md`));
  const [before11, before12] = [file11, file12].map(file => readFileSync(file, 'utf8'));
  assert.ok(lines(probe()).includes('IN_MAIN 11'));
  assert.equal(readFileSync(file11, 'utf8'), before11, '不帶 --apply 時不寫檔');
  const result = probe({ args: ['--apply'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['IN_MAIN 11', 'IN_MAIN 12']);
  assert.equal(readFileSync(file11, 'utf8'), before11.replace(`current: merged ${staged} PR #9`, `current: pushed ${staged} PR #9`));
  assert.equal(readFileSync(file12, 'utf8'), before12);
});

// issue-pilot 要 status.md 從存檔重產、不手寫，adapter 卻沒有指令（#77）。`--status` 寫出每個沒關的 batch 與成員、
// 開著的 gate（已解除的不列）與 request、主分支與整合分支的 SHA；stdout 照舊。
test('--status 從存檔與 git 重產 status.md，只列開著的 gate 與沒關的 batch', t => {
  const { batch, pilot, probe, git } = fixture(t, { screens: { term_77: { status: 'running', tail: [`DONE 77 ${SHA}`] } } });
  git('branch', 'pilot/integration');
  const main = git('rev-parse', 'HEAD');
  writeFileSync(join(pilot, 'coordinator'), `pid 42   loop yes   since ${ago(60)}   name ron-x-1\n`);
  writeFileSync(join(pilot, 'gates.md'), `# Gates

| id | Issue | question | options | default | parks | opened | status |
|---|---|---|---|---|---|---|---|
| G1 | #9 | 試跑誰指定？ | (a)｜(b) | (b) | #10 | ${ago(300)} | resolved ${ago(200)} 選 (b) |
| G2 | #12 | 要不要拆？ | 拆｜不拆 | 拆 | #12 | ${ago(95)} | open |

## G3 已解除的段落 gate
- Issue：#38
- opened：${ago(30)}
- resolved ${ago(10)} 選預設

## G5 段落 gate
- Issue：#44
- opened：${ago(20)}
`);
  writeFileSync(join(pilot, 'requests.md'), `2026-10-30T16:54:31+08:00   request: 已處理   source ab   applied 2026-10-30T17:00:43+08:00
2026-10-30T17:26:01+08:00   hold 到 #27 合入   source ad
`);
  batch('77-124', 'dispatched 2026-10-31T11:32:03+08:00', [{ n: 77 }, { n: 124, state: 'stop' }]);
  batch('8', 'closed 2026-10-30T13:38:21+08:00', [{ n: 8, state: 'done', candidate: 'abc1234' }]);
  const plain = lines(probe());
  const result = probe({ args: ['--status', '--apply'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), plain);
  const status = readFileSync(join(pilot, 'status.md'), 'utf8');
  assert.match(status, /^# pilot status（\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d，coordinator ron-x-1）\n/);
  assert.match(status, /^- batch 77-124：dispatched 2026-10-31T11:32:03\+08:00$/m);
  // --apply 先寫回，status.md 讀到的是寫回之後的 state。
  assert.match(status, new RegExp(`^  - #77 done ${SHA.slice(0, 7)}$`, 'm'));
  assert.match(status, /^ {2}- #124 stop$/m);
  assert.doesNotMatch(status, /batch 8\b/);
  assert.match(status, /^- gate G2 #12 要不要拆？（開了 1h3\dm）$/m);
  assert.match(status, /^- gate G5 #44 段落 gate（開了 \d+m）$/m);
  assert.doesNotMatch(status, /G1|G3/);
  assert.match(status, /^- request 2026-10-30T17:26:01\+08:00   hold 到 #27 合入   source ad$/m);
  assert.doesNotMatch(status, /已處理/);
  for (const ref of ['origin/main', 'main', 'pilot/integration']) assert.match(status, new RegExp(`^- ${ref} ${main.slice(0, 7)}$`, 'm'));
});

// #191：`--status` 只寫 `staged <sha>`，看不出 Regression 沒過。batch 那行附最後一行 regression 的 SHA 前 7 碼與 exit；
// staged 而沒有 regression 行時寫 `regression none`，其他狀態沒有就不附。
test('--status 的 batch 行附最後一次 regression 的結果', t => {
  const { batch, pilot, probe } = fixture(t);
  const staged = 'd4a2f71' + '0'.repeat(33);
  batch('94', `staged ${staged} onto 4c080c6`, [{ n: 94, state: 'done', candidate: 'abc1234' }]);
  writeFileSync(join(pilot, 'batch-94.md'), readFileSync(join(pilot, 'batch-94.md'), 'utf8') + `regression: 0b8077b exit 1\nregression: ${staged} exit 1\n`);
  batch('95', `staged ${staged} onto 4c080c6`, [{ n: 95, state: 'done', candidate: 'abc1234' }]);
  batch('96', `merged ${staged}`, [{ n: 96, state: 'done', candidate: 'abc1234' }]);
  writeFileSync(join(pilot, 'batch-96.md'), readFileSync(join(pilot, 'batch-96.md'), 'utf8') + `regression: ${staged} bin/check\n`);
  batch('97', 'dispatched 2026-10-31T11:32:03+08:00', [{ n: 97, state: 'done', candidate: 'abc1234' }]);
  const result = probe({ args: ['--status'] });
  assert.equal(result.status, 0, result.stderr);
  const status = readFileSync(join(pilot, 'status.md'), 'utf8');
  assert.match(status, new RegExp(`^- batch 94：staged ${staged} onto 4c080c6，regression d4a2f71 exit 1$`, 'm'));
  assert.match(status, new RegExp(`^- batch 95：staged ${staged} onto 4c080c6，regression none$`, 'm'));
  assert.match(status, new RegExp(`^- batch 96：merged ${staged}，regression d4a2f71 exit none$`, 'm'));
  assert.match(status, /^- batch 97：dispatched 2026-10-31T11:32:03\+08:00$/m);
});

test('--status 沒有 coordinator 檔、gate 與 batch 時照樣寫出', t => {
  const { pilot, probe } = fixture(t);
  const result = probe({ args: ['--status'] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(rest(result), '');
  const status = readFileSync(join(pilot, 'status.md'), 'utf8');
  assert.match(status, /^# pilot status（[^，]+，coordinator \(none\)）\n/);
  assert.match(status, /^- 沒有開著的 batch$/m);
  assert.match(status, /^- pilot\/integration none$/m);
});

// 兩個成員都改了 adapter 同一個條目，做完才在 stage 衝突、整批重做（#123）。
const RULES = '# rules\n\n- **Handoff.** 交接。\n  1. 第一步\n\n- **Close.** 關單。\n\n- **Probe.** 對帳。\n';

/** 從 `from` 開 `issue/<n>-x`，寫入 `files`（路徑 → 內容），commit 後切回 main。 */
function memberBranch(repo, git, n, from, files) {
  git('switch', '-q', '-c', `issue/${n}-x`, from);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
    git('add', path);
  }
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `#${n}`);
  git('switch', '-q', 'main');
}

function rulesFixture(t) {
  const f = fixture(t);
  mkdirSync(join(f.repo, 'docs'), { recursive: true });
  writeFileSync(join(f.repo, 'docs/rules.md'), RULES);
  f.git('add', 'docs/rules.md');
  f.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'rules');
  f.git('branch', 'pilot/integration');
  return f;
}

const overlapOf = result => result.stdout.split('\n').filter(line => line.startsWith('OVERLAP '));

test('兩個成員改到同一個條目時印 OVERLAP <n> <m> 1 files **<條目>.**，同一組只印一次；改不同條目不印', t => {
  const { repo, git, batch, probe } = rulesFixture(t);
  memberBranch(repo, git, 8, 'pilot/integration', { 'docs/rules.md': RULES.replace('交接。', '交接（#8）。').replace('第一步', '第一步（#8）') });
  memberBranch(repo, git, 9, 'pilot/integration', { 'docs/rules.md': RULES.replace('交接。', '交接（#9）。').replace('對帳。', '對帳（#9）。') });
  memberBranch(repo, git, 10, 'pilot/integration', { 'docs/rules.md': RULES.replace('關單。', '關單（#10）。') });
  batch('9-10', 'dispatched 2026-10-31T00:00:00+08:00', [{ n: 9, state: 'done', candidate: SHA }, { n: 10, state: 'done', candidate: SHA }]);
  batch('8', 'dispatched 2026-10-31T00:00:00+08:00', [{ n: 8, state: 'done', candidate: SHA }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(overlapOf(result), ['OVERLAP 8 9 1 files **Handoff.**']);
});

test('成員改的條目在整合分支上自它的 base 以來也改過時印 OVERLAP <n> integration', t => {
  const { repo, git, batch, probe } = rulesFixture(t);
  memberBranch(repo, git, 8, 'pilot/integration', { 'docs/rules.md': RULES.replace('關單。', '關單（#8）。'), 'tool.mjs': 'a\n' });
  git('switch', '-q', 'pilot/integration');
  writeFileSync(join(repo, 'docs/rules.md'), RULES.replace('關單。', '關單（整合）。').replace('對帳。', '對帳（整合）。'));
  writeFileSync(join(repo, 'tool.mjs'), 'b\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'integration moved');
  git('switch', '-q', 'main');
  batch('8', 'dispatched 2026-10-31T00:00:00+08:00', [{ n: 8, state: 'done', candidate: SHA }]);
  assert.deepEqual(overlapOf(probe()), ['OVERLAP 8 integration 2 files **Close.**']);
});

// #176：成員 base 較舊時，和整合分支重疊的每個檔各印一行，一輪幾十行，coordinator 只好整個濾掉 OVERLAP。
test('同一個成員和整合分支重疊 5 個檔時只印一行 OVERLAP <n> integration 5 files **<條目>.**', t => {
  const { repo, git, batch, probe } = rulesFixture(t);
  const others = ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs'];
  memberBranch(repo, git, 8, 'pilot/integration', {
    'docs/rules.md': RULES.replace('關單。', '關單（#8）。'),
    ...Object.fromEntries(others.map(path => [path, '#8\n'])),
  });
  git('switch', '-q', 'pilot/integration');
  writeFileSync(join(repo, 'docs/rules.md'), RULES.replace('關單。', '關單（整合）。'));
  for (const path of others) writeFileSync(join(repo, path), 'integration\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'integration moved');
  git('switch', '-q', 'main');
  batch('8', 'dispatched 2026-10-31T00:00:00+08:00', [{ n: 8, state: 'done', candidate: SHA }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(overlapOf(result), ['OVERLAP 8 integration 5 files **Close.**']);
});

test('兩個成員之間的重疊與各自和整合分支的重疊各印一行', t => {
  const { repo, git, batch, probe } = rulesFixture(t);
  memberBranch(repo, git, 8, 'pilot/integration', { 'docs/rules.md': RULES.replace('交接。', '交接（#8）。'), 'a.mjs': '#8\n', 'b.mjs': '#8\n' });
  memberBranch(repo, git, 9, 'pilot/integration', { 'docs/rules.md': RULES.replace('交接。', '交接（#9）。'), 'a.mjs': '#9\n', 'c.mjs': '#9\n' });
  git('switch', '-q', 'pilot/integration');
  writeFileSync(join(repo, 'b.mjs'), 'integration\n');
  writeFileSync(join(repo, 'c.mjs'), 'integration\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'integration moved');
  git('switch', '-q', 'main');
  batch('8-9', 'dispatched 2026-10-31T00:00:00+08:00', [8, 9].map(n => ({ n, state: 'done', candidate: SHA })));
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(overlapOf(result), ['OVERLAP 8 9 2 files **Handoff.**', 'OVERLAP 8 integration 1 files', 'OVERLAP 9 integration 1 files']);
});

test('條目外的改動算整個檔；closed batch、stop 成員、本機沒有分支的成員不比', t => {
  const { repo, git, batch, probe } = rulesFixture(t);
  memberBranch(repo, git, 8, 'pilot/integration', { 'docs/rules.md': RULES.replace('# rules', '# rules v2') });
  memberBranch(repo, git, 9, 'pilot/integration', { 'docs/rules.md': RULES.replace('對帳。', '對帳（#9）。') });
  memberBranch(repo, git, 10, 'pilot/integration', { 'docs/rules.md': RULES.replace('對帳。', '對帳（#10）。') });
  memberBranch(repo, git, 11, 'pilot/integration', { 'docs/rules.md': RULES.replace('對帳。', '對帳（#11）。') });
  batch('8-9', 'dispatched 2026-10-31T00:00:00+08:00', [{ n: 8 }, { n: 9, state: 'stop' }, { n: 12, state: 'done' }]);
  batch('10', 'closed 2026-10-31T00:00:00+08:00', [{ n: 10, state: 'done', candidate: SHA }]);
  batch('11', 'dispatched 2026-10-31T00:00:00+08:00', [{ n: 11, state: 'done', candidate: SHA }]);
  assert.deepEqual(overlapOf(probe()), ['OVERLAP 8 11 1 files']);
});

// review：git 是照改動的位置合併，不看條目名稱；在同一處各加一個新條目、或改到相鄰的行（中間沒有沒改的行）也會衝突。
test('在同一處各加新條目、或改到相鄰條目的相接行時，算在相接處的條目上', t => {
  const { repo, git, batch, probe } = rulesFixture(t);
  memberBranch(repo, git, 8, 'pilot/integration', { 'docs/rules.md': `${RULES}\n- **Eight.** 新的。\n` });
  memberBranch(repo, git, 9, 'pilot/integration', { 'docs/rules.md': `${RULES}\n- **Nine.** 新的。\n` });
  const tight = '# rules\n\n- **Handoff.** 交接。\n  1. 第一步\n- **Close.** 關單。\n';
  git('switch', '-q', '-c', 'tight', 'pilot/integration');
  writeFileSync(join(repo, 'docs/tight.md'), tight);
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tight');
  git('switch', '-q', 'pilot/integration');
  git('merge', '-q', '--ff-only', 'tight');
  git('switch', '-q', 'main');
  memberBranch(repo, git, 10, 'pilot/integration', { 'docs/tight.md': tight.replace('第一步', '第一步（#10）') });
  memberBranch(repo, git, 11, 'pilot/integration', { 'docs/tight.md': tight.replace('關單。', '關單（#11）。') });
  batch('8-11', 'dispatched 2026-10-31T00:00:00+08:00', [8, 9, 10, 11].map(n => ({ n, state: 'done', candidate: SHA })));
  assert.deepEqual(overlapOf(probe()), ['OVERLAP 8 9 1 files **Probe.**', 'OVERLAP 10 11 1 files **Handoff.** **Close.**']);
});

// 開單時依賴只寫在內文（「依賴 #87」）、沒建 blocked_by，Pool 只讀 blocked_by，會把兩組同時派出（#94）。
// createdAt 預設跟著號碼遞增（號碼越大越新），DEPS_PROSE last 以它比新舊（#228）。
const created = number => new Date(Date.UTC(2026, 0, 1) + number * 3600_000).toISOString();
const issue = (number, body, { labels = ['ready-for-agent'], blockedBy = [] } = {}) => ({
  number, body, createdAt: created(number),
  labels: { nodes: labels.map(name => ({ name })) },
  blockedBy: { nodes: blockedBy.map(n => (typeof n === 'number' ? { number: n, createdAt: created(n), repository: { nameWithOwner: 'acme/app' } } : n)) },
});

test('ready Issue 內文寫「依賴 #m」、#m 開著卻不在 blocked_by 時印 DEPS_PROSE <n> #m', t => {
  const before = issue(88, '依賴 #87（同一支腳本）。\n\n## 要做的事\n\n- 改 #12 提到的那段');
  const { probe, repo, ghLog } = fixture(t, { issues: [before, issue(87, '')] });
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['DEPS_PROSE 88 #87']);
  // gh 在主 checkout 裡跑，才會讀到那個 repo 的 Issue。
  assert.ok(readFileSync(ghLog, 'utf8').trim().split('\n').every(line => JSON.parse(line)[0] === repo));
});

test('補上 blocked_by 之後不印 DEPS_PROSE', t => {
  const after = issue(88, '依賴 #87（同一支腳本）。', { blockedBy: [87] });
  const { probe } = fixture(t, { issues: [after, issue(87, '')] });
  assert.equal(rest(probe()), '');
});

test('依賴的 Issue 已關閉、別的 repo 的同號單、不是 ready-for-agent 的 Issue 都不印', t => {
  const { probe } = fixture(t, { issues: [
    issue(56, '依賴 #55'),
    issue(57, '依賴 #87', { blockedBy: [{ number: 87, repository: { nameWithOwner: 'acme/other' } }] }),
    issue(58, '依賴 #87', { labels: ['needs-triage'] }),
    issue(87, ''),
  ] });
  assert.deepEqual(lines(probe()), ['DEPS_PROSE 57 #87']);
});

// 實際的內文：「依賴：#58、#77」、「依賴 #58（註解）、#77（註解），兩者合入後再做」、「依賴 ①（#103）；提示沿用 #94 的實作」。
test('「依賴」到句末（。；，或換行）的每個 #m 都檢查，句子之後的 #m 與跨 repo 參照不算', t => {
  const { probe } = fixture(t, { issues: [
    issue(90, '依賴：#83（同一支腳本）、#84 和 ①（#85）兩者合入後再做；#86 另外處理。\n依賴 acme/other#87。', { blockedBy: [84] }),
    issue(83, ''), issue(84, ''), issue(85, ''), issue(86, ''), issue(87, ''),
  ] });
  assert.deepEqual(lines(probe()), ['DEPS_PROSE 90 #83', 'DEPS_PROSE 90 #85']);
});

// review：「不依賴 #82」、逗號之後換了主詞（「另開子單，依賴本單與 #89」仍算，「依賴 #87，跟 #86 無關」的 #86 不算）、內文提到自己都不是缺的 blocked_by。
test('「不依賴」「無依賴」、逗號之後的 #m 與自己的號碼都不印', t => {
  const { probe } = fixture(t, { issues: [
    issue(91, '本單不依賴 #82；無依賴 #83。依賴 #84，跟 #85 無關。依賴 #91 的舊版。'),
    issue(82, ''), issue(83, ''), issue(84, ''), issue(85, ''),
  ] });
  assert.deepEqual(lines(probe()), ['DEPS_PROSE 91 #84']);
});

// #206：retro 開的 #166、#176 只寫先後（「以它們為 blocker，最後做」「排在它之後」），沒建 blocked_by，#166 排進 ready 第二位。
const ISSUE_166 = 'pilot.md 正被 #131、#132、#134、#145、#94 修改，拆檔會和它們全部衝突：以它們為 blocker，最後做。';
const ISSUE_176 = '來源：#172 候選 3。`scripts/pilot-probe.mjs` 正被 #94 改，排在它之後。';

test('#166 原句：以「它們」為 blocker 的每個還開著的號碼都印，最後做沒號碼再印 last', t => {
  const { probe } = fixture(t, { issues: [
    issue(166, ISSUE_166),
    issue(131, ''), issue(132, ''), issue(134, ''), issue(94, ''),
  ] });
  assert.deepEqual(lines(probe()), ['DEPS_PROSE 166 #131', 'DEPS_PROSE 166 #132', 'DEPS_PROSE 166 #134', 'DEPS_PROSE 166 #94', 'DEPS_PROSE 166 last ok']);
});

test('#176 原句「排在它之後」：單數的「它」沒號碼不印；「它們」「這些」才回指同一句前面的號碼', t => {
  const { probe } = fixture(t, { issues: [
    issue(176, ISSUE_176),
    issue(177, '#94、#172 都在改 probe，排在這些之後。'),
    issue(94, ''), issue(172, ''),
  ] });
  assert.deepEqual(lines(probe()), ['DEPS_PROSE 177 #94', 'DEPS_PROSE 177 #172']);
});

test('「排在 #m 之後」「以 #m、#n 為 blocker」「等 #m 合入」都印，句子之外的號碼與否定不算', t => {
  const { probe } = fixture(t, { issues: [
    issue(60, '#61 也改這支，本單排在 #62 之後。\n以 #63、#64（同一條目）為 Blocker；#65 另開。\n先等 #66 合入再做，#67 無關。\n不必等 #68 合入，也不用排在 #69 之後。'),
    ...[61, 62, 63, 64, 65, 66, 67, 68, 69].map(n => issue(n, '')),
  ] });
  assert.deepEqual(lines(probe()), ['DEPS_PROSE 60 #62', 'DEPS_PROSE 60 #63', 'DEPS_PROSE 60 #64', 'DEPS_PROSE 60 #66']);
});

test('「最後做」：同一小句有號碼、「不必／不要／無需最後做」不印 last，已有 blocked_by 照印', t => {
  const { probe } = fixture(t, { issues: [
    issue(70, '等 #71 合入，最後做 #72。'),
    issue(73, '這張最後做。', { blockedBy: [71] }),
    issue(74, '不必最後做；不要最後做；無需最後做。'),
    issue(71, ''), issue(72, ''),
  ] });
  assert.deepEqual(lines(probe()), ['DEPS_PROSE 70 #71', 'DEPS_PROSE 73 last new #72 #74']);
});

// #228：判斷過 `last` 之後又開了新單（#221），blocked_by 沒掛它，coordinator 要從 Pool 的 blocked 桶才發現。
test('「最後做」：比 blocked_by 最新一張還新、開著的單印 last new，加進 blocked_by 後印 last ok', t => {
  const others = [issue(130, ''), issue(193, ''), issue(221, '')];
  const before = fixture(t, { issues: [issue(166, '以它們為 blocker，最後做。', { blockedBy: [193] }), ...others] });
  assert.deepEqual(lines(before.probe()), ['DEPS_PROSE 166 last new #221']);
  const after = fixture(t, { issues: [issue(166, '以它們為 blocker，最後做。', { blockedBy: [193, 221] }), ...others] });
  assert.deepEqual(lines(after.probe()), ['DEPS_PROSE 166 last ok']);
});

// review：新單自己已在等 #n 時，照 last new 再加 blocked_by 會成環。
test('「最後做」：比基準新、但 blocked_by 已有 #n 的單不列進 last new', t => {
  const { probe } = fixture(t, { issues: [issue(166, '最後做。', { blockedBy: [193] }), issue(193, ''), issue(240, '', { blockedBy: [166] })] });
  assert.deepEqual(lines(probe()), ['DEPS_PROSE 166 last ok']);
});

test('「最後做」：blocked_by 空時以自己的 createdAt 為基準，retro-candidates、母單不算新單，別的 repo 的 blocker 不當基準', t => {
  const { probe } = fixture(t, { issues: [
    issue(80, '最後做。'),
    issue(79, ''), issue(81, ''), issue(82, '', { labels: ['retro-candidates'] }), issue(83, '', { labels: ['parent'] }),
    issue(90, '最後做。', { blockedBy: [{ number: 85, createdAt: created(85), repository: { nameWithOwner: 'acme/other' } }] }),
    issue(85, ''), issue(91, ''),
  ] });
  assert.deepEqual(lines(probe()), ['DEPS_PROSE 80 last new #81 #85 #90 #91', 'DEPS_PROSE 90 last new #91']);
});

test('gh 失敗時印 DEPS_PROSE_FAILED，其他檢查照跑', t => {
  const { probe, pilot } = fixture(t, { issues: null });
  writeFileSync(join(pilot, 'hold'), '');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['HOLD', 'DEPS_PROSE_FAILED gh repo view 失敗：HTTP 502: Bad Gateway']);
  assert.ok(result.stdout.split('\n').includes('POOL_FAILED gh repo view 失敗：HTTP 502: Bad Gateway'), result.stdout);
});

// #240：閒置輪原本另跑 issue-pool.mjs 才知道池子是空的；分桶與排序共用 issue-pool 的 pool()。
const poolOutput = result => result.stdout.split('\n').filter(line => /^POOL_/.test(line));

test('池子沒有 ready 單時印 POOL_EMPTY', t => {
  const { probe } = fixture(t, { issues: [issue(5, '', { labels: ['needs-triage'] }), issue(6, '', { labels: ['ready-for-human'] })] });
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(poolOutput(result), ['POOL_EMPTY']);
});

test('有 ready 單時印 POOL_READY <n>...：照 issue-pool 的排序，略過開著的 batch checkpoint 裡的 Issue', t => {
  const { probe, batch } = fixture(t, { screens: { term_7: { status: 'running', tail: ['❯'] } }, issues: [
    issue(7, ''), issue(8, ''), issue(9, '', { labels: ['ready-for-agent', 'priority'] }), issue(10, ''), issue(11, '', { blockedBy: [{ number: 8, state: 'OPEN', createdAt: created(8), repository: { nameWithOwner: 'acme/app' } }] }),
    { ...issue(12, ''), assignees: { nodes: [{ login: 'someone' }] }, comments: { nodes: [{ createdAt: new Date().toISOString() }] } },
  ] });
  batch('7', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 7 }]);
  batch('10', 'closed 2026-10-30T18:00:00+08:00', [{ n: 10, state: 'done', candidate: SHA }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(poolOutput(result), ['POOL_READY 9 8 10']);
  batch('8-9-10', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 8, state: 'stop' }, { n: 9, state: 'parked after #8' }, { n: 10 }]);
  assert.deepEqual(poolOutput(probe()), ['POOL_EMPTY']);
});

// #164：母單的 parent label 與重開原本是 Probe 條目尾端要 coordinator 手動做的散文，好幾輪都沒做。
const ghWrites = ghLog => readFileSync(ghLog, 'utf8').trim().split('\n').map(line => JSON.parse(line).slice(1)).filter(([cmd]) => cmd === 'issue');

test('有 sub-issue 卻沒有 parent label、或還掛 triage label 的開著的母單印 PARENT_LABEL <n>', t => {
  const { probe } = fixture(t, { world: [
    { number: 10, state: 'OPEN', labels: ['ready-for-agent'] },
    { number: 11, state: 'OPEN', labels: ['ready-for-agent'], parent: 10 },
    { number: 20, state: 'OPEN', labels: ['parent', 'needs-triage'] },
    { number: 21, state: 'OPEN', labels: [], parent: 20 },
    { number: 30, state: 'OPEN', labels: ['parent', 'enhancement'] },
    { number: 31, state: 'OPEN', labels: [], parent: 30 },
  ] });
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['PARENT_LABEL 10', 'PARENT_LABEL 20']);
});

test('開著的子單指向已關閉的母單時印 PARENT_REOPEN <母單>，每張母單一次', t => {
  const { probe } = fixture(t, { world: [
    { number: 40, state: 'CLOSED', labels: ['parent'] },
    { number: 41, state: 'OPEN', labels: ['ready-for-agent'], parent: 40 },
    { number: 42, state: 'OPEN', labels: ['ready-for-agent'], parent: 40 },
    { number: 50, state: 'CLOSED', labels: ['parent'] },
    { number: 51, state: 'CLOSED', labels: [], parent: 50 },
  ] });
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['PARENT_REOPEN 40']);
});

test('--apply 補上 parent label、移除 triage label、重開母單，輸出不變；再跑不印', t => {
  const { probe, ghLog } = fixture(t, { world: [
    { number: 10, state: 'OPEN', labels: ['ready-for-agent', 'enhancement'] },
    { number: 11, state: 'OPEN', labels: ['ready-for-agent'], parent: 10 },
    { number: 40, state: 'CLOSED', labels: ['parent'] },
    { number: 41, state: 'OPEN', labels: ['ready-for-agent'], parent: 40 },
  ] });
  const result = probe({ args: ['--apply'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['PARENT_LABEL 10', 'PARENT_REOPEN 40']);
  assert.deepEqual(ghWrites(ghLog), [
    ['issue', 'edit', '10', '--add-label', 'parent', '--remove-label', 'ready-for-agent'],
    ['issue', 'reopen', '40'],
  ]);
  assert.equal(rest(probe({ args: ['--apply'] })), '');
  assert.equal(rest(probe()), '');
});

test('--apply 經同目錄的 gh-tracker.mjs 正本寫入：參數改寫成 --長名=值，寫到 adapter Tracker 段的專案', t => {
  const { probe, ghLog } = fixture(t, { tracker: '# adapter\n\n## Tracker\n\nhttps://github.com/acme/app\n', world: [
    { number: 10, state: 'OPEN', labels: ['ready-for-agent'] },
    { number: 11, state: 'OPEN', labels: [], parent: 10 },
    { number: 40, state: 'CLOSED', labels: ['parent'] },
    { number: 41, state: 'OPEN', labels: [], parent: 40 },
  ] });
  const result = probe({ args: ['--apply'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['PARENT_LABEL 10', 'PARENT_REOPEN 40']);
  assert.deepEqual(ghWrites(ghLog), [
    ['issue', 'edit', '10', '--add-label=parent', '--remove-label=ready-for-agent', '--repo', 'github.com/acme/app'],
    ['issue', 'reopen', '40', '--repo', 'github.com/acme/app'],
  ]);
  assert.equal(rest(probe()), '');
});

test('不帶 --apply 時不寫 tracker', t => {
  const { probe, ghLog } = fixture(t, { world: [
    { number: 10, state: 'OPEN', labels: [] },
    { number: 11, state: 'OPEN', labels: [], parent: 10 },
  ] });
  assert.deepEqual(lines(probe()), ['PARENT_LABEL 10']);
  assert.deepEqual(ghWrites(ghLog), []);
  assert.deepEqual(lines(probe()), ['PARENT_LABEL 10']);
});

test('TRIAGE_STATES 與 issue-pool 的相同', async () => {
  const probeModule = await import('./pilot-probe.mjs');
  const pool = await import('./issue-pool.mjs');
  assert.deepEqual(probeModule.TRIAGE_STATES, pool.TRIAGE_STATES);
});

test('--apply 寫入失敗時印 PARENT_APPLY_FAILED <n> <錯誤> 並 exit 1，其他母單照修', t => {
  const { probe } = fixture(t, { world: [
    { number: 10, state: 'OPEN', labels: [], failEdit: true },
    { number: 11, state: 'OPEN', labels: [], parent: 10 },
    { number: 20, state: 'OPEN', labels: [] },
    { number: 21, state: 'OPEN', labels: [], parent: 20 },
  ] });
  const result = probe({ args: ['--apply'] });
  assert.equal(result.status, 1);
  assert.deepEqual(lines(result), ['PARENT_LABEL 10', 'PARENT_LABEL 20', 'PARENT_APPLY_FAILED 10 gh issue edit exit 1：HTTP 403: Resource not accessible']);
  assert.deepEqual(lines(probe()), ['PARENT_LABEL 10']);
});

// review：已關閉又缺 parent label 的母單，查詢只列開著的單，一次 --apply 只重開、下一輪才補 label。
test('已關閉的母單同時缺 parent label 時一起印 PARENT_LABEL，一次 --apply 修完', t => {
  const { probe, ghLog } = fixture(t, { world: [
    { number: 40, state: 'CLOSED', labels: ['ready-for-agent'] },
    { number: 41, state: 'OPEN', labels: [], parent: 40 },
  ] });
  const result = probe({ args: ['--apply'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['PARENT_LABEL 40', 'PARENT_REOPEN 40']);
  assert.deepEqual(ghWrites(ghLog), [
    ['issue', 'edit', '40', '--add-label', 'parent', '--remove-label', 'ready-for-agent'],
    ['issue', 'reopen', '40'],
  ]);
  assert.equal(rest(probe()), '');
});

// #194：worktree-overlap 以 `to` 為 null 比對工作樹：已 commit、暫存、未暫存的改動與未追蹤的新檔都算，ignore 的檔不算。
test('changedUnits：to 為 null 時比對工作樹，未追蹤的 .md 新檔也細到條目', t => {
  const repo = mkdtempSync(join(realTmpdir(), 'pilot-probe-worktree-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const run = (...args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run('init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'ignored.md\n');
  writeFileSync(join(repo, 'rules.md'), '# rules\n\n- **A.** 一\n\n- **B.** 二\n');
  writeFileSync(join(repo, 'staged.txt'), '1\n');
  run('add', '.');
  run('commit', '-q', '-m', 'base');
  const base = run('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'staged.txt'), '2\n');
  run('commit', '-q', '-am', 'committed');
  writeFileSync(join(repo, 'rules.md'), '# rules\n\n- **A.** 一\n\n- **B.** 改了\n');
  writeFileSync(join(repo, 'new.md'), '- **C.** 新條目\n');
  writeFileSync(join(repo, 'ignored.md'), '- **D.** x\n');
  const units = changedUnits(repo, base, null, { adjacent: false });
  assert.deepEqual([...units].map(([path, { whole, entries }]) => [path, whole, [...entries]]), [
    ['new.md', false, ['C']],
    ['rules.md', false, ['B']],
    ['staged.txt', true, []],
  ]);
  assert.deepEqual([...changedUnits(repo, base, null, { paths: ['new.md'] }).keys()], ['new.md']);
});
