// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { FAST, orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';
import { copyScripts } from './test/script-deps.mjs';
import { applyResults, changedUnits } from './pilot-probe.mjs';

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
const { scrollback, ...screen } = screens[arg('--terminal')] ?? {};
if (!screens[arg('--terminal')]) { fail('terminal_handle_stale'); process.exit(1); }
// pilot-batch resume 送 note（orca-session-send）：wait 一律就緒，send 收下的文字之後以 \`> <text>\` 接在畫面最後。
const sentFile = ${JSON.stringify(log)} + '.sent';
const sent = fs.existsSync(sentFile) ? fs.readFileSync(sentFile, 'utf8').split('\\n').filter(Boolean) : [];
if (process.argv[3] === 'wait') reply('wait', { wait: { satisfied: true } });
else if (process.argv[3] === 'send') { fs.appendFileSync(sentFile, arg('--text') + '\\n'); reply('send'); }
else if (screen.raw !== undefined) process.stdout.write(screen.raw);
// 不帶 --screen 的讀取（累積輸出，#537）：有 scrollback 時回它，沒有時同畫面。
else if (!process.argv.includes('--screen') && scrollback) reply('read', { terminal: { ...screen, tail: scrollback } });
else reply('read', { terminal: { ...screen, tail: [...(screen.tail ?? []), ...sent.map(text => '> ' + text)] } });
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
const node = issue => ({ title: '', assignees: { nodes: [] }, blocking: { nodes: [] }, comments: { nodes: [] }, timelineItems: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, subIssuesSummary: { total: 0 }, ...issue });
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
${members.map(m => `| ${m.n} | issue/${m.n}-x | ${m.worktree ?? `/w/issue-${m.n}`} | ${m.handle ?? `term_${m.n}`} | ${m.started ?? ago(5)} | ${m.stuckAfter ?? '90m'} | ${m.state ?? 'running'} | ${m.candidate ?? ''} |`).join('\n')}
`);
  // guard、world、tracker 都在暫存的 scripts/ 跑副本：templates/ 裡同目錄就有 gh-tracker.mjs 正本，--apply 會經它寫入（#244）。
  // tracker 是 adapter 內文：給了才連 gh-tracker.mjs 一起複製、寫 docs/agents/issue-run.md，否則 --apply 直接跑 gh issue。
  let probeScript = script;
  if (guard !== undefined || world !== undefined || tracker !== undefined) {
    const scripts = join(temp, 'scripts');
    // 依 import 相依閉包複製（test/script-deps.mjs），probe 多了相依不必回來補清單（#473）。
    copyScripts(new URL('.', import.meta.url).pathname, scripts, ['pilot-probe.mjs', ...(tracker === undefined ? [] : ['gh-tracker.mjs'])]);
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
  const pilotBatch = (...args) => spawnSync('node', [new URL('./pilot-batch.mjs', import.meta.url).pathname, repo, ...args], { encoding: 'utf8', env: { ...probeEnv, ORCA_CLI_COMMAND: cli, ...FAST } });
  return { repo, pilot, origin, git, log, batch, probe, probeEnv, cli, temp, pilotBatch, ghLog: join(temp, 'gh.log') };
}

// 池子摘要（POOL_EMPTY｜POOL_READY｜POOL_FAILED，#240）與 HANDOFF_COUNT（#368）每次都印一行；其他測試只看自己的行，比對前去掉它們，
// 池子與交接計數的測試另外看 stdout。
const rest = result => result.stdout.split('\n').filter(line => !/^(POOL_|HANDOFF_COUNT )/.test(line)).join('\n');
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

// #537：watcher 啟動前 worker 的 `DONE <n> <sha>` 已捲出 40 行的畫面，Probe 與 watch 都報 RUNNING，分頁標題卻已是 `待關閉｜`。
test('結果行已捲出畫面、畫面不是工作中：往回讀累積輸出找到 DONE；工作中不讀（#537）', t => {
  const filler = Array.from({ length: 45 }, (_, i) => `  報告第 ${i + 1} 行`);
  const { batch, probe, log } = fixture(t, { screens: {
    term_526: { status: 'running', tail: [...filler.slice(-38), '❯'], scrollback: ['● 完成', `  DONE 526 ${SHA}`, ...filler, '❯'] },
    term_527: { status: 'running', tail: ['✳ Fiddle-faddling… (1m 32s · ↓ 1.2k tokens)'], scrollback: [`DONE 527 ${SHA}`] },
  } });
  batch('526-527', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 526 }, { n: 527 }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lines(result).includes(`WORKER 526 DONE ${SHA}`), result.stdout);
  assert.ok(lines(result).some(line => /^WORKER 527 (RUNNING|STUCK)/.test(line)), result.stdout);
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /^terminal read --terminal term_526 --limit \d+ --json$/m);
  assert.doesNotMatch(calls, /^terminal read --terminal term_527 --limit/m);
});

// 過去手拼 probe 時漏掉的情況：worker 的 terminal 已經 exited，畫面卻沒有 DONE／STOP 行。
test('terminal exited 但沒有結果行時印 STUCK', t => {
  const { batch, probe } = fixture(t, { screens: { term_23: { status: 'exited', tail: ['● 還在想', 'Bye!'] } } });
  batch('23', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 23 }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lines(result).includes('WORKER 23 STUCK exited'), result.stdout);
});

// #466 第 2 項（investing#445）：worker 分頁已結束、畫面沒有結果行，但它的 checkpoint 已寫 `State: done, candidate <sha>`，
// Probe 只印 STUCK exited，coordinator 手讀 state.md 後用 sed 改 batch 檔。SHA 等於 worktree HEAD 時照 DONE 讀，--apply 寫回。
test('terminal exited 而 worker checkpoint 寫了 done 且 SHA 等於 worktree HEAD 時印 DONE from-state，--apply 寫回', t => {
  const { repo, pilot, git, batch, probe } = fixture(t, { screens: {
    term_445: { status: 'exited', tail: [] },
    term_446: { status: 'exited', tail: [] },
    term_447: { status: 'exited', tail: [] },
  } });
  const head = git('rev-parse', 'HEAD');
  const state = (n, text) => {
    mkdirSync(join(repo, `.scratch/issue-run-${n}`), { recursive: true });
    writeFileSync(join(repo, `.scratch/issue-run-${n}/state.md`), text);
  };
  state(445, `# issue-run 445\nState: running\n\nfull gate pytest 7830 passed\nState: done, candidate ${head}\n`);
  // SHA 不是 worktree HEAD：worker 之後又 commit 了，不能當結果。
  state(446, `State: done, candidate ${SHA}\n`);
  // 最後一行 State 不是 done。
  state(447, `State: done, candidate ${head}\nState: stop, review findings\n`);
  batch('445-447', 'dispatched 2026-11-21T15:00:00+08:00', [445, 446, 447].map(n => ({ n, worktree: repo })));
  const result = probe({ args: ['--apply'] });
  assert.equal(result.status, 0, result.stderr);
  const out = lines(result);
  assert.ok(out.includes(`WORKER 445 DONE ${head} from-state`), result.stdout);
  assert.ok(out.includes('WORKER 446 STUCK exited'), result.stdout);
  assert.ok(out.includes('WORKER 447 STUCK exited'), result.stdout);
  const text = readFileSync(join(pilot, 'batch-445-447.md'), 'utf8');
  assert.match(text, new RegExp(`^\\| 445 \\|.*\\| done \\| ${head} \\|$`, 'm'));
  assert.match(text, /^\| 446 \|.*\| running \|/m);
});

test('--worker-state：checkpoint 路徑照 <worktree>、<n> 佔位符展開（investing 放在資料目錄）', t => {
  const { repo, temp, git, batch, probe } = fixture(t, { screens: { term_445: { status: 'exited', tail: [] } } });
  const head = git('rev-parse', 'HEAD');
  mkdirSync(join(temp, 'notes/issue-445'), { recursive: true });
  writeFileSync(join(temp, 'notes/issue-445/state.md'), `State: done, candidate ${head}\n`);
  batch('445', 'dispatched 2026-11-21T15:00:00+08:00', [{ n: 445, worktree: repo }]);
  assert.ok(lines(probe()).includes('WORKER 445 STUCK exited'));
  const result = probe({ args: ['--worker-state', join(temp, 'notes/issue-<n>/state.md')] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lines(result).includes(`WORKER 445 DONE ${head} from-state`), result.stdout);
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

// #408（investing#500 第 2 項）：Probe 印 WORKER 437 STUCK exited，帳本仍把它算成在跑，接著派工印 STOP capacity 4/3，實際只有 2 個 worker。
test('--capacity：terminal 已 exited 的成員不算進帳本', t => {
  const { batch, probe, repo } = fixture(t, { screens: {
    term_437: { status: 'exited', tail: ['Bye!'] },
    term_493: { status: 'running', tail: ['❯'] },
    term_494: { status: 'running', tail: ['❯'] },
  } });
  batch('437-494', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 437 }, { n: 493 }, { n: 494 }]);
  const ledger = join(repo, '..', 'pilot-workers.tsv');
  const out = lines(probe({ args: ['--capacity', 'investing'], extraEnv: { PILOT_WORKERS_LEDGER: ledger, PILOT_MACHINE_WORKER_CAP: '3' } }));
  assert.ok(out.includes('WORKER 437 STUCK exited'), out.join('\n'));
  assert.match(readFileSync(ledger, 'utf8'), /^investing\t2\t/);
});

// #396：$PILOT_MACHINE_WORKER_CAP 空白時照預設 4 寫帳本，但先印 CAPACITY_ENV_MISSING，不再默默用預設值。
test('--capacity 時 $PILOT_MACHINE_WORKER_CAP 空白印 CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP；有值時不印', t => {
  const { batch, probe, repo } = fixture(t, { screens: { term_1: { status: 'running', tail: ['❯'] } } });
  batch('1', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 1 }]);
  const ledger = join(repo, '..', 'pilot-workers.tsv');
  const blank = probe({ args: ['--capacity', 'acme'], extraEnv: { PILOT_WORKERS_LEDGER: ledger, PILOT_MACHINE_WORKER_CAP: '' } });
  assert.equal(blank.status, 0, blank.stderr);
  assert.ok(lines(blank).includes('CAPACITY_ENV_MISSING PILOT_MACHINE_WORKER_CAP'), blank.stdout);
  assert.match(readFileSync(ledger, 'utf8'), /^acme\t1\t/);
  const set = probe({ args: ['--capacity', 'acme'], extraEnv: { PILOT_WORKERS_LEDGER: ledger, PILOT_MACHINE_WORKER_CAP: '4' } });
  assert.ok(!lines(set).some(line => line.startsWith('CAPACITY_ENV_MISSING')), set.stdout);
  const plain = probe({ extraEnv: { PILOT_WORKERS_LEDGER: ledger, PILOT_MACHINE_WORKER_CAP: '' } });
  assert.ok(!lines(plain).some(line => line.startsWith('CAPACITY_ENV_MISSING')), '沒帶 --capacity 不檢查');
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
// #295：batch-53-55 已 closed，兩列 state 還是 running，Probe 印 WORKER 53 STUCK orca terminal_handle_stale，帳本記 2。
test('closed batch 殘留的 running 列：不印 WORKER、不讀 terminal、不算容量', t => {
  const ledger = join(realTmpdir(), `probe-ledger-${process.pid}-closed.tsv`);
  t.after(() => rmSync(ledger, { force: true }));
  const { batch, probe } = fixture(t, { screens: {} });
  batch('53-55', 'closed 2026-10-30T13:38:21+08:00', [{ n: 53, state: 'running', handle: 'term_53', started: ago(5), stuckAfter: '60m' }]);

  const result = probe({ args: ['--capacity', 'app'], extraEnv: { PILOT_WORKERS_LEDGER: ledger } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^WORKER 53 /m);
  assert.match(readFileSync(ledger, 'utf8'), /^app\t0\b/m);
});

// #204、#355：tail 帶反斜線時 Orca 的 JSON 有不成立的跳脫；Probe 與 pilot-watch 共用 orca() 的修復，WORKER 照樣讀出結果行。
test('screen JSON 帶不成立的反斜線跳脫：WORKER 照樣讀出 DONE', t => {
  const raw = String.raw`{"ok":true,"result":{"terminal":{"handle":"term_61","status":"running","tail":["C:\Users\ron","  DONE 61 ${SHA}","❯"]}}}` + '\n';
  const { batch, probe } = fixture(t, { screens: { term_61: { raw } } });
  batch('61', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 61, handle: 'term_61' }]);
  const out = lines(probe());
  assert.ok(out.includes(`WORKER 61 DONE ${SHA}`), out.join('\n'));
});

test('--tail：印 worker 畫面的最後 n 行，不需要 jq', t => {
  const { cli, temp } = fixture(t, { screens: { term_9: { tail: ['a', 'b', 'c', 'DONE 9 abc'] } } });
  const run = (...args) => spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...env, ORCA_CLI_COMMAND: cli }, cwd: temp });
  const two = run('--tail', 'term_9', '--lines', '2');
  assert.equal(two.status, 0, two.stderr);
  assert.equal(two.stdout, 'c\nDONE 9 abc\n');
  assert.equal(run('--tail', 'term_9').stdout, 'a\nb\nc\nDONE 9 abc\n');
  assert.equal(run('--tail').status, 2);
  assert.equal(run('--tail', 'term_9', '--lines', '0').status, 2);
});

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

// #367（investing#320 等 G28）：成員都 done，但 G28 開著、hold 住 #320，舊版照印 STAGEABLE 320，coordinator 就 stage 了等人決定的成員。
test('done 成員被開著的 gate hold 住時印 HELD <n> G<k>、不印 STAGEABLE；gate resolved 後恢復 STAGEABLE', t => {
  const { batch, probe, pilot } = fixture(t);
  batch('320', 'dispatched 2026-11-18T10:00:00+08:00', [{ n: 320, state: 'done', candidate: 'abc1234' }]);
  batch('321-322', 'dispatched 2026-11-18T10:00:00+08:00', [{ n: 321, state: 'done', candidate: 'abc1234' }, { n: 322, state: 'stop' }]);
  const gate = (id, n, resolved = '') => `## ${id} #${n} 等人決定\n- Issue：#${n}\n- question：選哪個？\n- options：1. A；2. B\n- default：A\n- parked：batch ${n} 的 Stage\n- hold：#${n}\n- opened：2026-11-18T11:00:00+08:00\n${resolved}`;
  writeFileSync(join(pilot, 'gates.md'), `# Gates\n\n${gate('G28', 320)}\n${gate('G29', 321)}`);
  let out = lines(probe());
  assert.ok(out.includes('HELD 320 G28'), out.join('\n'));
  assert.ok(!out.includes('STAGEABLE 320'), out.join('\n'));
  assert.ok(out.includes('HELD 321 G29') && out.includes('MOVE 321-322 322'), out.join('\n'));
  writeFileSync(join(pilot, 'gates.md'), `# Gates\n\n${gate('G28', 320, '- resolved 2026-11-18T12:00:00+08:00 選 A\n')}`);
  out = lines(probe());
  assert.ok(out.includes('STAGEABLE 320'), out.join('\n'));
  assert.ok(!out.some(line => line.startsWith('HELD ')), out.join('\n'));
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

// #361：pilot-land 寫了 staged、Regression 還在跑（6 次再現），沒有 regression 行時 RESTAGE … none 分不出 land 還活著。
// land 在 checkpoint 留 `regressing: <staged sha> pid <pid>`：那個 pid 還是 pilot-land 時印 REGRESSING <key> <sha>，不印 RESTAGE；
// pid 已不在（land 被中斷）、標記的 SHA 是先前那次 stage 的時照舊 RESTAGE … none；regression 非 0 仍 RESTAGE，exit 0 不印。
test('staged、沒有 regression 行、land 還活著：印 REGRESSING，land 不在時仍 RESTAGE none', async t => {
  const { batch, probe, pilot, temp } = fixture(t);
  const staged = 'd4a2f71' + '0'.repeat(33);
  const earlier = '0b8077b' + '0'.repeat(33);
  const onto = '4c080c6' + '0'.repeat(33);
  // 活著的 land：命令列帶 pilot-land 的 node 行程；不是 land 的活行程：同一支 node 但命令列沒有 pilot-land。
  const sleeper = name => {
    const file = join(temp, name);
    writeFileSync(file, 'setTimeout(() => {}, 60000);\n');
    const child = spawn(process.execPath, [file], { stdio: 'ignore' });
    t.after(() => child.kill());
    return child.pid;
  };
  const land = sleeper('pilot-land.mjs');
  const other = sleeper('other.mjs');
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const append = (key, rows) => writeFileSync(join(pilot, `batch-${key}.md`), readFileSync(join(pilot, `batch-${key}.md`), 'utf8') + rows.map(row => `${row}\n`).join(''));
  const staging = (key, rows) => {
    batch(key, `staged ${staged} onto ${onto}`, [{ n: Number(key), state: 'done', candidate: 'abc1234' }]);
    append(key, rows);
  };
  staging('91', [`regressing: ${staged} pid ${land}`]);
  staging('92', [`regression: ${earlier} exit 1`, `regressing: ${staged} pid ${land}`]);
  staging('93', [`regressing: ${staged} pid ${gone}`]);
  staging('94', [`regressing: ${staged} pid ${other}`]);
  staging('95', [`regressing: ${earlier} pid ${land}`]);
  staging('96', [`regression: ${staged} exit 1`, `regressing: ${staged} pid ${land}`]);
  staging('97', [`regression: ${staged} exit 0 CHECK_PASS tests 1`]);
  const out = lines(probe());
  assert.deepEqual(out.filter(line => /^(RESTAGE|REGRESSING) /.test(line)), [
    `REGRESSING 91 ${staged}`,
    `REGRESSING 92 ${staged}`,
    'RESTAGE 93 regression-failed none',
    'RESTAGE 94 regression-failed none',
    'RESTAGE 95 regression-failed none',
    'RESTAGE 96 regression-failed 1',
  ], out.join('\n'));
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

// #379（#330 第 3 項，investing#251）：main 依決定暫停推送期間，每 tick 印所有 NOT_IN_MAIN／RESUME_PUSH（investing 約 150 行），
// 已在整合分支的也印。`pilot-hold set-main` 的旗標（.scratch/pilot/main-paused）有效時收成一行 MAIN_PAUSED，過期後恢復原輸出；
// IN_MAIN 照印；開著的 all-push gate 仍印 PUSH_PARKED（gate 要人處理）。
test('main 暫停旗標有效時 NOT_IN_MAIN／RESUME_PUSH 收成一行 MAIN_PAUSED，過期恢復原輸出', t => {
  const { batch, probe, git, pilot } = fixture(t);
  git('switch', '-q', '-c', 'pilot/integration');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'staged');
  const staged = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  // 三批在整合分支、不在 main：一批 merged（RESUME_PUSH），一批 merged 但 tip 已不是 Regression SHA（NOT_IN_MAIN tip），一批 pushed（NOT_IN_MAIN）；另一批已進 main。
  batch('11', `merged ${staged}`, [{ n: 11, state: 'done', candidate: 'abc1234' }]);
  writeFileSync(join(pilot, 'batch-11.md'), readFileSync(join(pilot, 'batch-11.md'), 'utf8') + `regression: ${staged} exit 0 CHECK_PASS tests 1+2\n`);
  batch('12', `merged ${staged}`, [{ n: 12, state: 'done', candidate: 'abc1234' }]);
  writeFileSync(join(pilot, 'batch-12.md'), readFileSync(join(pilot, 'batch-12.md'), 'utf8') + `regression: ${git('rev-parse', 'main')} exit 0 CHECK_PASS tests 1+2\n`);
  batch('13', `pushed ${staged}`, [{ n: 13, state: 'done', candidate: 'abc1234' }]);
  batch('14', `pushed ${git('rev-parse', 'main')}`, [{ n: 14, state: 'done', candidate: 'abc1234' }]);
  const pushLines = out => out.filter(line => /^(MAIN_PAUSED|PUSH_PARKED|NOT_IN_MAIN|RESUME_PUSH|IN_MAIN) /.test(line));
  const flag = until => writeFileSync(join(pilot, 'main-paused'), `${JSON.stringify({ since: '2026-11-21T10:00:00+08:00', reason: '等 #246 過渡期', until, session: 's' })}\n`);

  flag('2999-12-01');
  let out = lines(probe());
  assert.deepEqual(pushLines(out), ['IN_MAIN 14', 'MAIN_PAUSED 等 #246 過渡期 until 2999-12-01 pending 11 12 13'], out.join('\n'));

  // 過期：恢復各行。
  flag('2000-01-01');
  out = lines(probe());
  assert.deepEqual(pushLines(out), ['RESUME_PUSH 11', `NOT_IN_MAIN 12 tip ${staged.slice(0, 7)}`, 'NOT_IN_MAIN 13', 'IN_MAIN 14'], out.join('\n'));

  // 讀不懂的旗標不收合：寧可多印，也不藏住待推的 batch。
  writeFileSync(join(pilot, 'main-paused'), 'not json\n');
  assert.deepEqual(pushLines(lines(probe())), ['RESUME_PUSH 11', `NOT_IN_MAIN 12 tip ${staged.slice(0, 7)}`, 'NOT_IN_MAIN 13', 'IN_MAIN 14']);

  // 異常（regression 沒過、沒有 regression 行、沒有 SHA）照印：main 暫停不會有人來處理，收進 pending 就看不到了。
  flag('2999-12-01');
  batch('15', `merged ${staged}`, [{ n: 15, state: 'done', candidate: 'abc1234' }]);
  writeFileSync(join(pilot, 'batch-15.md'), readFileSync(join(pilot, 'batch-15.md'), 'utf8') + `regression: ${staged} exit 1\n`);
  batch('16', `merged ${staged}`, [{ n: 16, state: 'done', candidate: 'abc1234' }]);
  batch('17', 'pushed', [{ n: 17, state: 'done', candidate: 'abc1234' }]);
  assert.deepEqual(pushLines(lines(probe())), ['IN_MAIN 14', 'NOT_IN_MAIN 15 regression-failed 1', 'NOT_IN_MAIN 16 no-regression', 'NOT_IN_MAIN 17 no-sha',
    'MAIN_PAUSED 等 #246 過渡期 until 2999-12-01 pending 11 12 13']);
  for (const key of ['15', '16', '17']) rmSync(join(pilot, `batch-${key}.md`));

  // 有開著的 all-push gate 時印 PUSH_PARKED。
  writeFileSync(join(pilot, 'gates.md'), '# Gates\n\n## G4 帳務\n- Issue：batch 120\n- parked：all-push\n- opened：2026-10-31T10:00:00+08:00\n');
  assert.deepEqual(pushLines(lines(probe())), ['IN_MAIN 14', 'PUSH_PARKED G4 3 batches']);
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
// ADAPTER_AHEAD 行：檔名、改動的條目名稱，與讀整合分支那份的指令（#357）：存進 `.scratch/pilot/adapter/<檔名>` 再 Read，
// 不直接印到輸出（#333：`git show` 印 35 KB、67 KB，被存檔後又進 context 一次）；遠端 ref 先 fetch。
const aheadLine = (repo, path, names = '', ref = 'pilot/integration', fetch = '') =>
  `ADAPTER_AHEAD ${path}${names && ` ${names}`} ｜ mkdir -p ${repo}/.scratch/pilot/adapter && ${fetch && `git -C ${repo} fetch ${fetch} && `}` +
  `git -C ${repo} show ${ref}:${path} > ${repo}/.scratch/pilot/adapter/${path.slice(path.lastIndexOf('/') + 1)}`;

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
  assert.deepEqual(lines(result), [aheadLine(repo, 'docs/agents/issue-run.md'), aheadLine(repo, 'docs/agents/pilot-rules.md')]);

  // main 跟上 integration 之後只剩 integration 新改的 pilot-rules.md。
  git('merge', '-q', '--ff-only', 'pilot/integration');
  git('switch', '-q', 'pilot/integration');
  commit({ 'docs/agents/pilot-rules.md': '# pilot\n- Probe\n' }, 'newer pilot');
  git('switch', '-q', 'main');
  assert.deepEqual(lines(probe()), [aheadLine(repo, 'docs/agents/pilot-rules.md')]);

  // main 直接合入新的 issue-run.md：integration 那份比較舊，不印。
  commit({ 'docs/agents/issue-run.md': PILOT_SECTION + '- Push gate\n' }, 'main adapter');
  assert.deepEqual(lines(probe()), [aheadLine(repo, 'docs/agents/pilot-rules.md')]);

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

// #357（#330 第 4 項）：batch 151 的 #151 stop、#235 done，舊判斷印 `MOVE 151 151`，照做 `pilot-batch.mjs move 151 151` 得 `STOP 151 same-batch`；
// 改 `move 151 235` 才能 stage。沒 done 的成員裡有 batch key 那張時，改列可以移走的 done 成員。batch 383 的 #383 stop、#389 done 是第二組（investing retro 1119b）。
test('沒 done 的成員就是 batch key 時印 MOVE <key> <done 成員…>，不印走不通的 MOVE <key> <key>', t => {
  const { batch, probe } = fixture(t, { screens: { term_389: { status: 'running', tail: [`DONE 389 ${SHA}`] } } });
  batch('151', 'dispatched 2026-11-16T10:00:00+08:00', [{ n: 151, state: 'stop' }, { n: 235, state: 'done', candidate: SHA }]);
  batch('383', 'dispatched 2026-11-19T10:00:00+08:00', [{ n: 383, state: 'stop' }, { n: 389 }]);
  batch('400', 'dispatched 2026-11-19T10:00:00+08:00', [{ n: 400, state: 'stop' }, { n: 401, state: 'parked after #9' }, { n: 402, state: 'done', candidate: SHA }, { n: 403, state: 'done', candidate: SHA }]);
  const out = lines(probe());
  assert.ok(out.includes('MOVE 151 235'), out.join('\n'));
  assert.ok(out.includes('MOVE 383 389'), out.join('\n'));
  assert.ok(out.includes('MOVE 400 402 403'), out.join('\n'));
  assert.ok(!out.some(line => /^MOVE (151 151|383 383|400 400)\b/.test(line)), out.join('\n'));
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
  const staged = commit('docs/agents/issue-run.md', PILOT_SECTION, 'adapter');
  git('switch', '-q', 'trunk');
  writeFileSync(join(pilot, 'batch-5.md'), `# batch 5\ncurrent: merged ${staged}\nintegration: feature-int @ 1234567\n\n`
    + '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n'
    + `| 5 | issue/5-x | /w/issue-5 | term_5 | ${ago(5)} | 90m | done | abc1234 |\nregression: ${staged} exit 0\n`);
  git('push', '-q', 'origin', 'trunk');
  assert.deepEqual(lines(probe()), ['NOT_MAIN trunk', 'NOT_IN_MAIN 5 tip none']);
  assert.deepEqual(lines(probe({ args: ['--integration', 'feature-int', '--main', 'trunk'] })),
    [aheadLine(repo, 'docs/agents/issue-run.md', '', 'feature-int'), 'RESUME_PUSH 5']);
});

test('參數錯誤時 exit 2', t => {
  const { probe } = fixture(t);
  for (const args of [['--integration'], ['--bogus', 'x'], ['constructor', 'x'], ['--toString', 'x'], ['--main', 'a', '--main', 'b'], ['--integration', '--main']]) {
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
  assert.deepEqual(lines(probe()), [aheadLine(repo, 'docs/agents/pilot-rules.md')]);
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
    [aheadLine(repo, 'docs/agents/pilot-rules.md', 'Close,Stage')]);
  assert.deepEqual(ahead(rules([...base, '- **New entry.** v1']), 'new entry'),
    [aheadLine(repo, 'docs/agents/pilot-rules.md', 'New entry')]);
  // 刪掉的條目取改動前的名稱，整合分支那份讀不到。
  assert.deepEqual(ahead(rules([base[0], base[2]]), 'drop entry'), [aheadLine(repo, 'docs/agents/pilot-rules.md', 'Scripts ahead')]);
  assert.deepEqual(ahead(rules(base).replace('前言。', '前言 v2。'), 'prose'), [aheadLine(repo, 'docs/agents/pilot-rules.md')]);
  assert.deepEqual(ahead(rules(['- **Stage.** v2', ...base.slice(1)]).replace('前言。', '前言 v2。'), 'mixed'),
    [aheadLine(repo, 'docs/agents/pilot-rules.md')]);
});

// #537：主 checkout 有一條未提交、缺 `Bash(...)` 外層的放行規則，probe 每輪只印 DIRTY，新開的 Claude 卡在 Settings Warning 對話框。
test('.claude/settings.json 的規則格式錯或 JSON 壞掉時印 SETTINGS_INVALID；全部合格不印（#537）', t => {
  const { repo, probe } = fixture(t);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  const settings = allow => writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify({ permissions: { allow, deny: ['Bash(rm -rf /)'] } }));
  const invalid = () => lines(probe()).filter(line => line.startsWith('SETTINGS_INVALID'));
  settings(['Bash(node scripts/gh-tracker.mjs:*)', 'Read', 'mcp__orca__x']);
  assert.deepEqual(invalid(), []);
  settings(['Bash(node scripts/gh-tracker.mjs:*)', 'gh issue close -R acme/app']);
  assert.deepEqual(invalid(), ['SETTINGS_INVALID .claude/settings.json allow[1] "gh issue close -R acme/app"']);
  writeFileSync(join(repo, '.claude/settings.local.json'), '{ "permissions": ');
  assert.equal(invalid().filter(line => line.startsWith('SETTINGS_INVALID .claude/settings.local.json json ')).length, 1);
});

// #544：main 暫停期間每輪都印 ADAPTER_AHEAD 加 21 個條目（相對 main 的差異），coordinator 得手動 cmp 已存的 `.scratch/pilot/adapter/*.md`
// 才知道只改了一條。已存副本等於整合分支那份時印 ADAPTER_AHEAD_SEEN；不同時名稱欄只列相對已存副本變動的條目。
test('ADAPTER_AHEAD 比對已存副本：相同印 ADAPTER_AHEAD_SEEN，不同只列相對副本的條目（#544）', t => {
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
  commit({ 'docs/agents/issue-run.md': PILOT_SECTION, 'docs/agents/pilot-rules.md': rules(['- **Stage.** v1', '- **Watch.** v1', '- **Close.** v1']) }, 'adapter');
  git('branch', 'pilot/integration');
  git('switch', '-q', 'pilot/integration');
  const v2 = rules(['- **Stage.** v2', '- **Watch.** v2', '- **Close.** v2']);
  commit({ 'docs/agents/pilot-rules.md': v2 }, 'three entries');
  git('switch', '-q', 'main');
  const ahead = () => lines(probe()).filter(line => line.startsWith('ADAPTER_AHEAD'));
  // 還沒存過：照舊相對 main 列三條。
  assert.deepEqual(ahead(), [aheadLine(repo, 'docs/agents/pilot-rules.md', 'Close,Stage,Watch')]);
  // 照指令存過之後：已讀過，只印 SEEN。
  const saved = join(repo, '.scratch/pilot/adapter/pilot-rules.md');
  mkdirSync(join(saved, '..'), { recursive: true });
  writeFileSync(saved, v2);
  assert.deepEqual(ahead(), ['ADAPTER_AHEAD_SEEN docs/agents/pilot-rules.md']);
  // 整合分支再改一條：只列相對已存副本變動的 Watch。
  git('switch', '-q', 'pilot/integration');
  commit({ 'docs/agents/pilot-rules.md': rules(['- **Stage.** v2', '- **Watch.** v3', '- **Close.** v2']) }, 'watch');
  git('switch', '-q', 'main');
  assert.deepEqual(ahead(), [aheadLine(repo, 'docs/agents/pilot-rules.md', 'Watch')]);
  // 條目以外也變了：省略名稱欄。
  git('switch', '-q', 'pilot/integration');
  commit({ 'docs/agents/pilot-rules.md': rules(['- **Stage.** v2', '- **Watch.** v3', '- **Close.** v2']).replace('前言。', '前言 v2。') }, 'prose');
  git('switch', '-q', 'main');
  assert.deepEqual(ahead(), [aheadLine(repo, 'docs/agents/pilot-rules.md')]);
});

// #357（#325 第 3 項）：investing 每輪都印 `ADAPTER_AHEAD docs/agents/issue-run.md`，改的卻是 Review、Permissions 段；coordinator 用整檔
// `git diff` 讀，輸出 43.9 KB／51 KB。issue-run.md 只在 `## Pilot` 段變動時印，每行附 `git -C <主 checkout> show <整合分支>:<檔案>` 的讀取提示。
test('issue-run.md 只有 Pilot 段以外變動時不印 ADAPTER_AHEAD；Pilot 段變動時印，並附 git show 的讀取提示', t => {
  const { repo, git, probe } = fixture(t);
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  const adapter = ({ review = 'v1', pilot = 'v1', permissions = 'v1' }) =>
    `# adapter\n\n## Review\n\nreview ${review}\n\n## Pilot\n\npilot ${pilot}，見 [pilot-rules.md](pilot-rules.md)。\n\n## Permissions\n\nperms ${permissions}\n`;
  writeFileSync(join(repo, 'docs/agents/issue-run.md'), adapter({}));
  writeFileSync(join(repo, 'docs/agents/pilot-rules.md'), '# pilot\n\n- **Stage.** v1\n\n- **Push gate.** v1\n');
  git('add', 'docs');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'adapter');
  git('branch', 'pilot/integration');
  const ahead = files => {
    git('switch', '-q', 'pilot/integration');
    git('reset', '-q', '--hard', 'main');
    for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'ahead');
    git('switch', '-q', 'main');
    const result = probe();
    assert.equal(result.status, 0, result.stderr);
    return lines(result).filter(line => line.startsWith('ADAPTER_AHEAD'));
  };
  assert.deepEqual(ahead({ 'docs/agents/issue-run.md': adapter({ review: 'v2', permissions: 'v2' }) }), []);
  assert.deepEqual(ahead({ 'docs/agents/issue-run.md': adapter({ review: 'v2', pilot: 'v2' }) }),
    [aheadLine(repo, 'docs/agents/issue-run.md')]);
  assert.deepEqual(ahead({ 'docs/agents/pilot-rules.md': '# pilot\n\n- **Stage.** v2\n\n- **Push gate.** v2\n' }),
    [aheadLine(repo, 'docs/agents/pilot-rules.md', 'Push gate,Stage')]);
});

// #333：investing 的 adapter 規定讀 `origin/develop`，本機 `develop` 落後 origin 9 個 commit；probe 比本機分支就讀到舊 adapter。
// adapter 的 Pilot 條目 **Adapter ref.** 宣告遠端 ref 時，probe 比那個 ref，指令先 `git fetch <remote> <branch>` 再 show 存檔；印出的指令可以直接跑。
test('Pilot 段宣告 Adapter ref 為遠端 ref 時，ADAPTER_AHEAD 比那個 ref，指令含 fetch＋show 存檔', t => {
  const { repo, git, probe } = fixture(t);
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  const rules = stage => `# pilot\n\n- **Adapter ref.** \`origin/develop\`：本機 develop 會落後。\n\n- **Stage.** ${stage}\n`;
  writeFileSync(join(repo, 'docs/agents/issue-run.md'), PILOT_SECTION);
  writeFileSync(join(repo, 'docs/agents/pilot-rules.md'), rules('v1'));
  git('add', 'docs');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'adapter');
  git('push', '-q', 'origin', 'main');
  git('switch', '-q', '-c', 'develop');
  writeFileSync(join(repo, 'docs/agents/pilot-rules.md'), rules('v2'));
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'newer');
  git('push', '-q', 'origin', 'develop');
  git('switch', '-q', 'main');
  // 本機 develop 落後 origin/develop：比本機分支會讀不到新版。追蹤 ref 也停在舊版（別台機器 push 之後還沒 fetch），probe 要自己 fetch（review P2）。
  git('branch', '-f', 'develop', 'main');
  git('update-ref', 'refs/remotes/origin/develop', 'main');
  const result = probe({ args: ['--integration', 'develop'] });
  assert.equal(result.status, 0, result.stderr);
  const line = aheadLine(repo, 'docs/agents/pilot-rules.md', 'Stage', 'origin/develop', 'origin develop');
  assert.deepEqual(lines(result).filter(l => l.startsWith('ADAPTER_AHEAD')), [line]);
  // ` ｜ ` 之後的指令可以直接跑，存下的是 origin/develop 那份。
  const run = spawnSync('sh', ['-c', line.split(' ｜ ')[1]], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(join(repo, '.scratch/pilot/adapter/pilot-rules.md'), 'utf8'), rules('v2'));
  // fetch 失敗：印 FETCH_FAILED adapter-ref，照上次 fetch 的 ref 比（review-only 輪 P3）。
  git('remote', 'set-url', 'origin', join(repo, 'missing.git'));
  const failed = lines(probe({ args: ['--integration', 'develop'] }));
  assert.ok(failed.some(l => l.startsWith('FETCH_FAILED adapter-ref ')), failed.join('\n'));
  // 上面的指令已把那份存檔，所以照上次 fetch 的 ref 比的結果是已讀過（#544）。
  assert.ok(failed.includes('ADAPTER_AHEAD_SEEN docs/agents/pilot-rules.md'), failed.join('\n'));
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

// #376（#338 第 4 項）：Probe 對 326、345-398 印 STAGEABLE，stage 後兩批都 STOP conflict，衝突來自整合分支；OVERLAP 只說改到同一處，
// 要等 pilot-land 跑完才知道真的衝突。STAGEABLE 的 batch 以 lib/merge-tree.mjs 兩兩試合併 done 成員，也拿每個成員試合併整合分支。
const conflictOf = result => result.stdout.split('\n').filter(line => line.startsWith('CONFLICT '));

test('STAGEABLE 的 batch：done 成員兩兩衝突印 CONFLICT <key> <n> <m> <檔…>，和整合分支衝突印 CONFLICT <key> <n> integration <檔…>', t => {
  const { repo, git, batch, probe } = rulesFixture(t);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const at = (n, text) => `${lines.map((line, i) => (i === n - 1 ? `${line} ${text}` : line)).join('\n')}\n`;
  git('switch', '-q', 'pilot/integration');
  for (const path of ['tool.mjs', 'b.mjs', 'c.mjs']) writeFileSync(join(repo, path), `${lines.join('\n')}\n`);
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'files');
  git('switch', '-q', 'main');
  // #8、#9 改 tool.mjs 同一行 → 衝突；b.mjs 兩邊都改、隔得遠 → 合得起來（OVERLAP 會印，CONFLICT 不印）。
  memberBranch(repo, git, 8, 'pilot/integration', { 'tool.mjs': at(10, '#8'), 'b.mjs': at(2, '#8'), 'c.mjs': at(5, '#8') });
  memberBranch(repo, git, 9, 'pilot/integration', { 'tool.mjs': at(10, '#9'), 'b.mjs': at(28, '#9') });
  // 成員開出之後整合分支改了 c.mjs 同一行：#8 和整合分支衝突，#9 沒改 c.mjs。
  git('switch', '-q', 'pilot/integration');
  writeFileSync(join(repo, 'c.mjs'), at(5, 'integration'));
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'integration moved');
  git('switch', '-q', 'main');
  batch('8-9', 'dispatched 2026-10-31T00:00:00+08:00', [8, 9].map(n => ({ n, state: 'done', candidate: SHA })));
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.split('\n');
  assert.ok(out.includes('STAGEABLE 8-9'), result.stdout);
  assert.deepEqual(conflictOf(result), ['CONFLICT 8-9 8 9 tool.mjs', 'CONFLICT 8-9 8 integration c.mjs']);
  // CONFLICT 緊接在 STAGEABLE 之後。
  assert.equal(out[out.indexOf('STAGEABLE 8-9') + 1], 'CONFLICT 8-9 8 9 tool.mjs');
});

test('不是 STAGEABLE 的 batch（還有 running 成員）不試合併；成員都合得起來時不印 CONFLICT', t => {
  const { repo, git, batch, probe } = rulesFixture(t);
  memberBranch(repo, git, 8, 'pilot/integration', { 'tool.mjs': 'a\n' });
  memberBranch(repo, git, 9, 'pilot/integration', { 'tool.mjs': 'b\n' });
  memberBranch(repo, git, 10, 'pilot/integration', { 'x.mjs': 'x\n' });
  memberBranch(repo, git, 11, 'pilot/integration', { 'y.mjs': 'y\n' });
  batch('8-9', 'dispatched 2026-10-31T00:00:00+08:00', [{ n: 8, state: 'done', candidate: SHA }, { n: 9, state: 'running' }]);
  batch('10-11', 'dispatched 2026-10-31T00:00:00+08:00', [10, 11].map(n => ({ n, state: 'done', candidate: SHA })));
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split('\n').includes('STAGEABLE 10-11'), result.stdout);
  assert.deepEqual(conflictOf(result), []);
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

test('池子沒有 ready 單、也沒有 needs-triage 單時印 POOL_EMPTY', t => {
  const { probe } = fixture(t, { issues: [issue(5, '', { labels: ['needs-info'] }), issue(6, '', { labels: ['ready-for-human'] })] });
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(poolOutput(result), ['POOL_EMPTY']);
});

// #357（#325 第 4 項）：兩個 coordinator 的第一 tick 都印 POOL_EMPTY，issue-pool.mjs 卻列 13／9 張 needs-triage，idle 規則把喚醒拉到 1800／3600 秒。
test('沒有 ready 單但有 needs-triage 單時印 POOL_TRIAGE <n>...，略過開著的 batch 成員與 blocked、已認領的單；有 ready 單時照印 POOL_READY', t => {
  const triage = n => issue(n, '', { labels: ['needs-triage'] });
  const { probe, batch } = fixture(t, { screens: { term_9: { status: 'running', tail: ['❯'] } }, issues: [
    triage(12), triage(5), triage(9), issue(6, '', { labels: ['ready-for-human'] }),
    issue(7, '', { labels: ['needs-triage'], blockedBy: [{ number: 6, state: 'OPEN', createdAt: created(6), repository: { nameWithOwner: 'acme/app' } }] }),
    { ...triage(8), assignees: { nodes: [{ login: 'someone' }] }, comments: { nodes: [{ createdAt: new Date().toISOString() }] } },
  ] });
  batch('9', 'dispatched 2026-11-20T10:00:00+08:00', [{ n: 9 }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(poolOutput(result), ['POOL_TRIAGE 5 12']);
});

// #326：adapter 以 --skip-labels 宣告的 label（investing 的 `ci-report`）和 retro-candidates 一樣：不進 POOL_READY／POOL_TRIAGE，不算「最後做」的新單。
test('--skip-labels 的單不進 POOL_READY、POOL_TRIAGE，也不算「最後做」的新單；沒帶旗標時照算', t => {
  const { probe } = fixture(t, { issues: [
    issue(80, '最後做。'),
    issue(81, '', { labels: ['ci-report', 'ready-for-agent'] }),
    issue(82, '', { labels: ['ci-report', 'needs-triage'] }),
  ] });
  const skipped = probe({ args: ['--skip-labels', 'ci-report'] });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.deepEqual(lines(skipped), ['DEPS_PROSE 80 last ok']);
  assert.deepEqual(poolOutput(skipped), ['POOL_READY 80']);
  const plain = probe();
  assert.deepEqual(lines(plain), ['DEPS_PROSE 80 last new #81 #82']);
  assert.deepEqual(poolOutput(plain), ['POOL_READY 80 81']);
});

test('--skip-labels 沒給值時印用法、exit 2', t => {
  const { probe } = fixture(t);
  assert.equal(probe({ args: ['--skip-labels'] }).status, 2);
});

// #357（#325 第 2 項）：batch-138 唯一成員 #138 是 stop（等 #136），#136 結案後 probe 仍只印 `PARKED 138 138`，
// coordinator 讀前任 decisions.md 才知道要 fresh 重派。stop 成員的 blocker 全關時印 UNBLOCKED <key> <n>。
test('stop 成員的 blocker 全關時印 UNBLOCKED <key> <n>；還有開著的 blocker、沒有 blocker、不是 stop、batch 已關都不印', t => {
  const blocker = (number, state, repo = 'acme/app') => ({ number, state, createdAt: created(number), repository: { nameWithOwner: repo } });
  const member = (n, blockedBy) => issue(n, '', { labels: ['ready-for-agent'], blockedBy });
  const { probe, batch } = fixture(t, { screens: { term_150: { status: 'running', tail: ['STOP 150 prerequisite #149'] } }, issues: [
    { ...member(138, [blocker(136, 'CLOSED')]), assignees: { nodes: [{ login: 'me' }] } },
    member(140, [blocker(136, 'CLOSED'), blocker(139, 'OPEN')]),
    member(141, []),
    member(142, [blocker(136, 'CLOSED')]),
    member(143, [blocker(136, 'CLOSED')]),
    member(144, [blocker(7, 'CLOSED', 'acme/other')]),
    member(150, [blocker(149, 'CLOSED')]),
  ] });
  batch('138', 'dispatched 2026-11-14T10:00:00+08:00', [{ n: 138, state: 'stop' }]);
  batch('140-141-142', 'dispatched 2026-11-14T10:00:00+08:00', [{ n: 140, state: 'stop' }, { n: 141, state: 'stop' }, { n: 142, state: 'done', candidate: SHA }]);
  batch('143', 'closed not dispatchable', [{ n: 143, state: 'stop' }]);
  batch('144-150', 'dispatched 2026-11-14T10:00:00+08:00', [{ n: 144, state: 'stop' }, { n: 150 }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result).filter(line => line.startsWith('UNBLOCKED ')), ['UNBLOCKED 138 138', 'UNBLOCKED 144-150 144', 'UNBLOCKED 144-150 150']);
});

test('gh 失敗時不印 UNBLOCKED，其他行照印', t => {
  const { probe, batch } = fixture(t, { issues: null });
  batch('138', 'dispatched 2026-11-14T10:00:00+08:00', [{ n: 138, state: 'stop' }]);
  const out = lines(probe());
  assert.ok(out.includes('PARKED 138 138'), out.join('\n'));
  assert.ok(!out.some(line => line.startsWith('UNBLOCKED')), out.join('\n'));
});

test('有 ready 單時不印 POOL_TRIAGE', t => {
  const { probe } = fixture(t, { issues: [issue(5, '', { labels: ['needs-triage'] }), issue(6, '')] });
  assert.deepEqual(poolOutput(probe()), ['POOL_READY 6']);
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

// #304：adapter 宣告不在 github.com 的對應專案時，裸 ref 一律當成 github.com，要到 Close 才 STOP counterpart；Probe 在派工前就印出來。
test('adapter 宣告 Counterpart projects 時，ready 單與開著的 batch 成員的裸對應單 ref 印 COUNTERPART_BARE <n> <ref>', t => {
  const { probe, batch, repo, git } = fixture(t, { screens: { term_7: { status: 'running', tail: ['❯'] } }, issues: [
    issue(7, 'app 對應單：acme/app#70', { labels: ['enhancement'] }),
    issue(8, 'app 對應單：acme/app#80；web 對應單：acme/web#81'),
    issue(9, 'app 對應單：http://192.168.200.202/acme/app/-/issues/90'),
    issue(10, 'app 對應單：acme/app#100', { labels: ['needs-triage'] }),
  ] });
  batch('7', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 7 }]);
  const before = lines(probe());
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  writeFileSync(join(repo, 'docs/agents/issue-run.md'), '# adapter\n\n## Readiness\n\nCounterpart projects: `acme/app`\n');
  git('add', 'docs');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'adapter');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result).filter(line => !before.includes(line)), ['COUNTERPART_BARE 7 acme/app#70', 'COUNTERPART_BARE 8 acme/app#80']);
});

test('adapter 的 Pilot 段連到的檔宣告 Memory audit days 時，沒紀錄或逾期印 MEMORY_AUDIT_DUE，間隔內不印（#347）', t => {
  const { probe, repo, git } = fixture(t);
  const due = line => line.startsWith('MEMORY_AUDIT_DUE ');
  assert.deepEqual(lines(probe()).filter(due), [], '沒有 adapter：不印');
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  writeFileSync(join(repo, 'docs/agents/issue-run.md'), '# adapter\n\n## Pilot\n\n見 [coordinator.md](coordinator.md)。\n');
  writeFileSync(join(repo, 'docs/agents/coordinator.md'), '- **Memory audit.** `Memory audit days: 7`：Probe 印 MEMORY_AUDIT_DUE 時跑。\n');
  git('add', 'docs');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'adapter');
  assert.deepEqual(lines(probe()).filter(due), ['MEMORY_AUDIT_DUE ?d last=none → node scripts/memory-audit.mjs --run']);
  const record = join(repo, '.scratch/pilot/memory-audit.md');
  writeFileSync(record, '2020-01-01 MEMORY_AUDIT items=0\n');
  assert.match(lines(probe()).filter(due).join('\n'), /^MEMORY_AUDIT_DUE \d+d last=2020-01-01 → node scripts\/memory-audit\.mjs --run$/);
  writeFileSync(record, `2020-01-01 MEMORY_AUDIT items=0\n${new Date().toISOString().slice(0, 10)} MEMORY_AUDIT items=0\n`);
  assert.deepEqual(lines(probe()).filter(due), [], '今天跑過：不印');
});

test('adapter 沒有宣告 Counterpart projects 時不印 COUNTERPART_BARE', t => {
  const { probe, repo, git } = fixture(t, { issues: [issue(8, 'app 對應單：acme/app#80')] });
  mkdirSync(join(repo, 'docs/agents'), { recursive: true });
  writeFileSync(join(repo, 'docs/agents/issue-run.md'), '# adapter\n');
  git('add', 'docs');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'adapter');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(rest(result).trim(), '');
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

// #327 第 2 項（investing session 5936fde0）：pool 列 `human #133`、`human #184`，兩張都寫 `Operator prerequisite：` 等 Operator，
// gates.md 卻只有 G15（#133），probe 只印 `GATE G15`；coordinator 沒問，Operator 兩度追問「確認目前有什麼需要決策的？」。
const ISSUE_184 = '## 背景\n\n加 taifex 報價來源。\n\nOperator prerequisite：在 budgets.yaml 新增 taifex 來源…需 Operator 核准\n\n## 驗收\n\n- [ ] 測試';
const G15 = `# Gates

| id | Issue | question | options | default | parks | opened | status |
|---|---|---|---|---|---|---|---|
| G15 | #133 | 保留期要用掉嗎？ | 用｜不用 | 不用 | #133 | 2026-11-15T10:00:00+08:00 | open |
| G9 | #190 | 舊的 | a｜b | a | #190 | 2026-11-01T10:00:00+08:00 | resolved 2026-11-01T11:00:00+08:00 選 a |
`;

test('ready-for-human Issue 沒有對應的開放 gate 時印 HUMAN_NO_GATE <n> <prerequisite 摘要>，有 gate 的不印', t => {
  const human = ['ready-for-human'];
  const { pilot, probe } = fixture(t, { issues: [
    { ...issue(184, ISSUE_184, { labels: human }), title: 'taifex 來源' },
    { ...issue(133, 'Operator prerequisite：開跑前由 Operator 確認（保留期只能用一次）', { labels: human }), title: '保留期' },
    { ...issue(190, '只有 resolved 的 gate，沒寫 prerequisite。', { labels: human }), title: '要人做的事' },
    { ...issue(191, 'Operator prerequisite：無關，標的是 ready-for-agent'), title: 'agent 單' },
  ] });
  writeFileSync(join(pilot, 'gates.md'), G15);
  assert.deepEqual(lines(probe()), [
    'GATE G15 #133 保留期要用掉嗎？',
    'HUMAN_NO_GATE 184 在 budgets.yaml 新增 taifex 來源…需 Operator 核准',
    'HUMAN_NO_GATE 190 要人做的事',
  ]);
});

// #358（#324 第 5 項、#338 第 5 項）：ADAPTER_AHEAD 時 coordinator 照整合分支的 adapter 在主 checkout 跑腳本，
// 缺檔得 MODULE_NOT_FOUND（investing blocked-by-sync.mjs），舊版靜默做錯（`campaign-due.py` 讀不懂 6 欄、`pilot-watch.mjs` 多個 --batch 只看最後一個）。
test('ADAPTER_AHEAD 時 adapter 指名、主 checkout 缺檔或內容不同的 scripts/* 印 SCRIPT_AHEAD，有 stage worktree 時附 run-in', t => {
  const { repo, git, probe, temp } = fixture(t);
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), text);
      git('add', path);
    }
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  };
  const rules = version => `# pilot\n\n- **Watch.** ${version} \`node scripts/pilot-watch.mjs --batch <key>\`。\n\n- **Project tick hooks.** \`python3 scripts/campaign-due.py\`、\`node scripts/blocked-by-sync.mjs --apply\`、\`node scripts/same.mjs\`；正本在 \`skills/x/scripts/other.mjs\`，舊版改跑 \`node <stage worktree>/scripts/<x>.mjs\`。\n`;
  commit({
    'docs/agents/issue-run.md': PILOT_SECTION,
    'docs/agents/pilot-rules.md': rules('v1'),
    'scripts/pilot-watch.mjs': '// v1\n',
    'scripts/campaign-due.py': '# v1\n',
    'scripts/same.mjs': '// same\n',
  }, 'base');
  git('switch', '-q', '-c', 'pilot/integration');
  // 只改腳本、adapter 沒變：coordinator 照 main 的 adapter 跑 main 的腳本，不印。
  commit({ 'scripts/pilot-watch.mjs': '// v2 --tail\n', 'scripts/campaign-due.py': '# v2 6 欄\n', 'scripts/blocked-by-sync.mjs': '// new\n' }, 'scripts');
  git('switch', '-q', 'main');
  assert.deepEqual(lines(probe()).filter(line => line.startsWith('SCRIPT_AHEAD')), []);

  git('switch', '-q', 'pilot/integration');
  commit({ 'docs/agents/pilot-rules.md': rules('v2') }, 'adapter');
  git('switch', '-q', 'main');
  let result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), [
    aheadLine(repo, 'docs/agents/pilot-rules.md', 'Watch'),
    'SCRIPT_AHEAD scripts/blocked-by-sync.mjs sync-main',
    'SCRIPT_AHEAD scripts/campaign-due.py sync-main',
    'SCRIPT_AHEAD scripts/pilot-watch.mjs sync-main',
  ]);

  // main 自己改過（整合分支那份比較舊）的腳本不印。
  commit({ 'scripts/campaign-due.py': '# main hotfix\n' }, 'main hotfix');
  const stage = join(temp, 'stage');
  git('worktree', 'add', '-q', stage, 'pilot/integration');
  result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result).filter(line => line.startsWith('SCRIPT_AHEAD')), [
    `SCRIPT_AHEAD scripts/blocked-by-sync.mjs run-in ${stage}`,
    `SCRIPT_AHEAD scripts/pilot-watch.mjs run-in ${stage}`,
  ]);
});

// #358（#340 第 1 項）：main 暫停時 `.claude/settings.json` 的 hook 跑主 checkout 的舊版 script，已在整合分支修好的問題被 retro 重複回報（investing#407、#424）。
test('main 落後整合分支、hook 指令引用的 scripts/ 檔內容不同時印 HOOK_BEHIND <檔案>；相同或 main 不落後時不印', t => {
  const { repo, git, probe } = fixture(t);
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), text);
      git('add', path);
    }
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  };
  const hook = command => ({ type: 'command', command });
  commit({
    '.claude/settings.json': JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [hook('python3 "$CLAUDE_PROJECT_DIR/scripts/guard_git.py"'), hook('node "$CLAUDE_PROJECT_DIR/scripts/lang.mjs"')] }],
      Stop: [{ hooks: [hook('node "$CLAUDE_PROJECT_DIR/scripts/lang.mjs"')] }],
    } }, null, 2),
    'scripts/guard_git.py': '# v1\n',
    'scripts/lang.mjs': '// v1\n',
    'scripts/not-a-hook.mjs': '// v1\n',
  }, 'base');
  git('branch', 'pilot/integration');
  const hookLines = () => {
    const result = probe();
    assert.equal(result.status, 0, result.stderr);
    return lines(result).filter(line => line.startsWith('HOOK_BEHIND'));
  };
  assert.deepEqual(hookLines(), []);

  // main 落後，但 hook 檔沒變：不印。
  git('switch', '-q', 'pilot/integration');
  commit({ 'scripts/not-a-hook.mjs': '// v2\n' }, 'other');
  git('switch', '-q', 'main');
  assert.deepEqual(hookLines(), []);

  git('switch', '-q', 'pilot/integration');
  commit({ 'scripts/guard_git.py': '# v2 No closing quotation fixed\n' }, 'fix hook');
  git('switch', '-q', 'main');
  assert.deepEqual(hookLines(), ['HOOK_BEHIND scripts/guard_git.py']);

  // main 跟上之後不落後：不印。
  git('merge', '-q', '--ff-only', 'pilot/integration');
  assert.deepEqual(hookLines(), []);
});

// #358（#338 第 8 項，investing#353 第 2 項）：#316 的 Operator 腳本早已合入整合分支，Issue 仍 ready-for-human，下一個 session 又請 Operator 跑一次。
test('ready-for-human 的單已落地在整合分支時印 HUMAN_LANDED <n> <sha>；沒落地或不是 ready-for-human 的不印', t => {
  const human = ['ready-for-human'];
  const { repo, git, probe } = fixture(t, { issues: [
    { ...issue(316, '跑 Operator 腳本', { labels: human }), title: 'Operator 腳本' },
    { ...issue(317, '還沒做', { labels: human }), title: '還沒做' },
    issue(318, 'agent 單'),
  ] });
  git('switch', '-q', '-c', 'pilot/integration');
  writeFileSync(join(repo, 'op.sh'), 'echo op\n');
  git('add', 'op.sh');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'Operator 腳本 (#316)');
  const sha316 = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'issue/318-x', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'agent');
  git('switch', '-q', 'pilot/integration');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', "Merge branch 'issue/318-x' into pilot/stage-318", 'issue/318-x');
  git('switch', '-q', 'main');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), [
    'HUMAN_NO_GATE 316 Operator 腳本',
    'HUMAN_NO_GATE 317 還沒做',
    `HUMAN_LANDED 316 ${sha316}`,
  ]);
});

// #359（#338 第 2 項，investing#379 第 1 項）：#348 的 blocker #321 分支已在整合分支，#321 卻是改寫範圍後還沒做的 ready-for-agent，
// coordinator 照 `(landed …)` 派了 #348，10 分鐘後 `STOP 348 decision … 未實作`。
test('blocker 已落地在整合分支，卻沒指派、或本文在最後一次指派後改過，而掛 ready-for-agent／needs-triage／ready-for-human 時印 BLOCKER_OPEN_SCOPE <n> #<m> <label>', t => {
  const open = number => ({ number, state: 'OPEN', createdAt: created(number), repository: { nameWithOwner: 'acme/app' } });
  const { repo, git, probe } = fixture(t, { issues: [
    issue(321, '範圍已改寫'),
    { ...issue(322, '已做完、等進 main'), assignees: { nodes: [{ login: 'me' }] }, timelineItems: { nodes: [{ createdAt: '2026-11-18T12:01:15Z' }] }, lastEditedAt: '2026-11-18T11:00:00Z' },
    { ...issue(325, '做完後改寫範圍'), assignees: { nodes: [{ login: 'me' }] }, timelineItems: { nodes: [{ createdAt: '2026-11-18T12:01:15Z' }] }, lastEditedAt: '2026-11-18T12:32:00Z' },
    issue(323, '還沒落地'),
    issue(324, '等人', { labels: ['ready-for-human'] }),
    issue(348, '', { blockedBy: [open(321), open(322), open(323), open(325)] }),
    issue(349, '', { labels: ['needs-triage'], blockedBy: [open(324), { ...open(7), repository: { nameWithOwner: 'acme/other' } }] }),
  ] });
  git('switch', '-q', '-c', 'pilot/integration');
  for (const n of [321, 322, 324, 325]) {
    writeFileSync(join(repo, `f${n}`), `${n}\n`);
    git('add', `f${n}`);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `做 (#${n})`);
  }
  git('switch', '-q', 'main');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result).filter(line => !line.startsWith('HUMAN_')), [
    'BLOCKER_OPEN_SCOPE 348 #321 ready-for-agent',
    'BLOCKER_OPEN_SCOPE 348 #325 ready-for-agent',
    'BLOCKER_OPEN_SCOPE 349 #324 ready-for-human',
  ]);
});

// #359（#338 第 3 項，investing#379 第 2 項）：#321 在 worker 開工（2026-11-18T20:01:15+08:00）後 20:32 改寫範圍，worker 交付原範圍，
// batch 照常合入，新範圍 15 小時沒人接。
test('done 成員的 Issue 本文最後編輯晚於列的 started 時印 SCOPE_CHANGED <key> <n> <edited at>；更早、沒編輯過、還在跑、batch 已關都不印', t => {
  const edited = (n, lastEditedAt) => ({ ...issue(n, ''), lastEditedAt });
  const started = '2026-11-18T20:01:15+08:00';
  const { probe, batch } = fixture(t, { screens: { term_325: { status: 'running', tail: [`DONE 325 ${SHA}`] }, term_326: { status: 'running', tail: ['❯'] } }, issues: [
    edited(321, '2026-11-18T12:32:00Z'), edited(322, '2026-11-18T11:00:00Z'), edited(323, null),
    edited(325, '2026-11-18T12:40:00Z'), edited(326, '2026-11-18T12:40:00Z'), edited(327, '2026-11-18T12:40:00Z'),
  ] });
  batch('321-322-323', 'dispatched 2026-11-18T20:01:15+08:00', [321, 322, 323].map(n => ({ n, started, state: 'done', candidate: SHA })));
  batch('325-326', 'dispatched 2026-11-18T20:01:15+08:00', [{ n: 325, started }, { n: 326, started }]);
  batch('327', 'closed', [{ n: 327, started, state: 'done', candidate: SHA }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result).filter(line => line.startsWith('SCOPE_CHANGED ')), [
    'SCOPE_CHANGED 321-322-323 321 2026-11-18T12:32:00Z',
    'SCOPE_CHANGED 325-326 325 2026-11-18T12:40:00Z',
  ]);
});

// #345：手動 pilot-batch 持鎖時，probe --apply 不能拿開頭讀到的舊內容整檔寫回；等到逾時就印 CHECKPOINT_LOCKED，不寫檔。
test('applyResults：checkpoint 被活著的 pid 鎖住到逾時，傳回 CHECKPOINT_LOCKED 行、檔案不動', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-probe-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'batch-7.md');
  const text = '# batch 7\ncurrent: dispatched 2026-11-21T10:00:00+08:00\nintegration: pilot/integration @ 370114b\n\n'
    + '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n'
    + '| 7 | issue/7-x | /w/issue-7 | term_7 | 2026-11-21T10:00:00+08:00 | 90m | running | |\n';
  writeFileSync(file, text);
  const holder = `pid=${process.pid} at=2026-11-21T00:00:00.000Z test`;
  writeFileSync(`${file}.lock`, `${holder}\n`);
  const saved = process.env.PILOT_STORE_LOCK_TIMEOUT_MS;
  process.env.PILOT_STORE_LOCK_TIMEOUT_MS = '200';
  t.after(() => { if (saved === undefined) delete process.env.PILOT_STORE_LOCK_TIMEOUT_MS; else process.env.PILOT_STORE_LOCK_TIMEOUT_MS = saved; });
  assert.deepEqual(applyResults(file, '7', [{ n: '7', state: 'done', sha: 'a'.repeat(40) }]), [`CHECKPOINT_LOCKED ${file}.lock ${holder}`]);
  assert.equal(readFileSync(file, 'utf8'), text);
});

// #398：adapter 檔的大小預算由同時進行的成員共用，每個成員在自己的 base 上都通過，合計超過要到 stage 的 pre-commit 才發現（#353、#394）。
// 預算表是整合分支上的 scripts/adapter-size-budget.json（{ 路徑: bytes }，check-adapter-size 讀的同一份）。
function budgetFixture(t, { budget = { 'docs/a.md': 100 }, grow = { 1: 15, 2: 15 }, state = 'done' } = {}) {
  const f = fixture(t);
  const commit = message => f.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  f.git('switch', '-q', '-c', 'pilot/integration');
  mkdirSync(join(f.repo, 'docs'), { recursive: true });
  mkdirSync(join(f.repo, 'scripts'), { recursive: true });
  writeFileSync(join(f.repo, 'docs/a.md'), `${'a'.repeat(79)}\n`);
  if (budget) writeFileSync(join(f.repo, 'scripts/adapter-size-budget.json'), JSON.stringify(budget));
  f.git('add', '.');
  commit('integration');
  for (const [n, bytes] of Object.entries(grow)) {
    f.git('switch', '-q', '-c', `issue/${n}-x`, 'pilot/integration');
    if (bytes) writeFileSync(join(f.repo, 'docs/a.md'), `${readFileSync(join(f.repo, 'docs/a.md'), 'utf8')}${'b'.repeat(bytes - 1)}\n`);
    else writeFileSync(join(f.repo, `other-${n}.md`), 'x\n');
    f.git('add', '.');
    commit(`#${n}`);
  }
  f.git('switch', '-q', 'main');
  f.batch('1-2', 'dispatched 2026-11-21T00:00:00+08:00', Object.keys(grow).map(n => ({ n, state, candidate: state === 'done' ? SHA : '' })));
  const result = f.probe();
  if (budget && !Object.values(budget).every(limit => Number.isInteger(limit) && limit > 0)) return result;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter(line => line.startsWith('BUDGET '));
}

test('兩個成員各在預算內、合計超過時印 BUDGET <檔案> <合計> <上限> <成員…>', t => {
  assert.deepEqual(budgetFixture(t), ['BUDGET docs/a.md 110 100 1 2']);
});

test('成員合計仍在預算內、沒有預算表時不印 BUDGET', t => {
  assert.deepEqual(budgetFixture(t, { grow: { 1: 10, 2: 10 } }), []);
  assert.deepEqual(budgetFixture(t, { budget: null }), []);
});

test('running 成員已 commit 的增量也算；沒改這個檔的成員不列', t => {
  assert.deepEqual(budgetFixture(t, { grow: { 1: 25, 2: 0 }, state: 'running' }), ['BUDGET docs/a.md 105 100 1']);
});

test('預算表的上限不是正整數時 exit 1，不靜默略過', t => {
  const result = budgetFixture(t, { budget: { 'docs/a.md': '100' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /adapter-size-budget\.json/);
});

// #356（investing 五次再現）：coordinator 請停下的 worker 繼續、把列改回 running 後，畫面還留著舊結果行，
// `--apply` 把列寫回 stop／舊 SHA 的 done，照 STAGEABLE stage 又撞同一衝突。pilot-batch resume 在表格下方記 `resumed:` 那一行，Probe 忽略它。
const resumedLine = (n, line) => `resumed: #${n} ${ago(1)} ${line}\n`;

test('resume 後畫面殘留的舊 STOP：印 WORKER <n> RUNNING，--apply 不改列', t => {
  const old = 'STOP 234 decision pilot-close 與兩個 git 步驟偏離待 Operator 決定';
  const { batch, pilot, probe } = fixture(t, { screens: { term_234: { status: 'running', tail: [`│ ${old}      │`, '● 在 ab277c8 跑完整 gate · 57s', '❯'] } } });
  batch('234', 'dispatched 2026-11-16T10:00:00+08:00', [{ n: 234, started: ago(2) }]);
  const file = join(pilot, 'batch-234.md');
  writeFileSync(file, readFileSync(file, 'utf8') + resumedLine(234, old));
  const before = readFileSync(file, 'utf8');
  const result = probe({ args: ['--apply'] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lines(result).some(line => /^WORKER 234 RUNNING [23]$/.test(line)), result.stdout);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('resume 後畫面殘留的舊 DONE 不印 STAGEABLE；出現新的 DONE 才寫回新 SHA', t => {
  const OLD = '5234c1b8b40944a9e0ecc1526ce225e861e64b27';
  const NEW = '8cbfc83' + 'c'.repeat(33);
  const screens = { term_319: { status: 'running', tail: [`DONE 319 ${OLD}`, '● 合併 pilot/integration 中', '❯'] } };
  const { batch, pilot, probe } = fixture(t, { screens });
  batch('319', 'dispatched 2026-11-18T10:00:00+08:00', [{ n: 319, started: ago(1) }]);
  const file = join(pilot, 'batch-319.md');
  writeFileSync(file, readFileSync(file, 'utf8') + resumedLine(319, `DONE 319 ${OLD}`));
  let result = probe({ args: ['--apply'] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!lines(result).includes('STAGEABLE 319'), result.stdout);
  assert.ok(lines(result).some(line => /^WORKER 319 RUNNING/.test(line)), result.stdout);
  assert.match(readFileSync(file, 'utf8'), /\| 319 \|.*\| running \|/);
  // 之後 worker 印出新的 DONE：照常寫回、印 STAGEABLE。
  const { probe: again, batch: batch2, pilot: pilot2 } = fixture(t, { screens: { term_319: { status: 'running', tail: [`DONE 319 ${OLD}`, '● 合併完成', `DONE 319 ${NEW}`, '❯'] } } });
  batch2('319', 'dispatched 2026-11-18T10:00:00+08:00', [{ n: 319, started: ago(1) }]);
  const file2 = join(pilot2, 'batch-319.md');
  writeFileSync(file2, readFileSync(file2, 'utf8') + resumedLine(319, `DONE 319 ${OLD}`));
  result = again({ args: ['--apply'] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lines(result).includes(`WORKER 319 DONE ${NEW}`), result.stdout);
  assert.ok(lines(result).includes('STAGEABLE 319'), result.stdout);
  assert.match(readFileSync(file2, 'utf8'), new RegExp(`\\| 319 \\|.*\\| done \\| ${NEW} \\|`));
});

test('resumed 行只對同號成員、最後一行有效；舊格式（沒有 resumed 行）照常讀結果', t => {
  const { batch, pilot, probe } = fixture(t, { screens: {
    term_1: { status: 'running', tail: ['STOP 1 decision 舊的', '❯'] },
    term_2: { status: 'running', tail: ['STOP 2 decision 舊的', '❯'] },
    term_3: { status: 'running', tail: ['STOP 3 decision 舊的', '❯'] },
  } });
  batch('1-2-3', 'dispatched 2026-11-18T10:00:00+08:00', [{ n: 1 }, { n: 2 }, { n: 3 }]);
  const file = join(pilot, 'batch-1-2-3.md');
  writeFileSync(file, readFileSync(file, 'utf8') + resumedLine(1, 'STOP 1 decision 舊的') + resumedLine(2, 'STOP 2 decision 舊的') + resumedLine(2, 'STOP 2 decision 更早的'));
  const out = lines(probe());
  assert.ok(out.some(line => /^WORKER 1 RUNNING/.test(line)), out.join('\n'));
  assert.ok(out.includes('WORKER 2 STOP decision 舊的'), out.join('\n'));
  assert.ok(out.includes('WORKER 3 STOP decision 舊的'), out.join('\n'));
});

test('pilot-batch resume 之後：started 是現在，Probe 印 RUNNING 不印 STUCK，--apply 不把舊 STOP 寫回', t => {
  const old = 'STOP 385 decision G50 待 Operator';
  const { batch, pilot, probe, pilotBatch } = fixture(t, { screens: { term_385: { status: 'running', tail: [old, '❯'] } } });
  batch('385', 'dispatched 2026-11-20T18:35:00+08:00', [{ n: 385, started: ago(179), state: 'stop' }]);
  const resumed = pilotBatch('resume', '385', '385', '--note', 'G50 已解決，請繼續');
  assert.equal(resumed.stdout, 'RESUMED 385 385\n', resumed.stderr);
  const file = join(pilot, 'batch-385.md');
  const before = readFileSync(file, 'utf8');
  const result = probe({ args: ['--apply'] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lines(result).includes('WORKER 385 RUNNING 0'), result.stdout);
  assert.equal(readFileSync(file, 'utf8'), before);
});

// #368：交接門檻（合入 2 批）原本由 coordinator 自己數；investing 66e552ea 把前任派的 381、383 算進來，誤判已達門檻。
// probe 以 coordinator 檔的 pid 在 sessions.md 找本 session 的 start 行，只數成員 started 不早於它、已合入的 batch。
const handoffOutput = result => result.stdout.split('\n').filter(line => /^HANDOFF_/.test(line));
const PRIOR_START = '2026-11-20T08:00:00+08:00';
const SESSION_START = '2026-11-20T12:00:00+08:00';
function handoffFixture(t, { sessions = true, coordinator = true } = {}) {
  const f = fixture(t);
  if (coordinator) writeFileSync(join(f.pilot, 'coordinator'), `pid 4242   loop yes   since ${SESSION_START}   name coord-2\n`);
  if (sessions) writeFileSync(join(f.pilot, 'sessions.md'), [
    `${PRIOR_START}   session old-coord   pid 1111   coord-1`,
    `2026-11-20T03:59:58.000Z   handoff from-session old-coord → terminal term_x   reason 合入 2 批`,
    `${SESSION_START}   session new-coord   pid 4242   coord-2`,
    '',
  ].join('\n'));
  const landed = (key, current, started) => {
    f.batch(key, current, [{ n: key, started, state: 'done', candidate: SHA }]);
    writeFileSync(join(f.pilot, `batch-${key}.md`), `${readFileSync(join(f.pilot, `batch-${key}.md`), 'utf8')}regression: ${SHA} exit 0\n`);
  };
  return { ...f, landed };
}

test('HANDOFF_COUNT 只數本 session 派工、已合入的 batch；達門檻印 HANDOFF_DUE', t => {
  const { landed, batch, probe } = handoffFixture(t);
  landed('81', 'closed', '2026-11-20T09:00:00+08:00');
  landed('83', `pushed ${SHA}`, '2026-11-20T10:00:00+08:00');
  landed('90', 'closed', '2026-11-20T12:30:00+08:00');
  landed('91', `merged ${SHA}`, '2026-11-20T13:00:00+08:00');
  batch('92', 'dispatched 2026-11-20T13:30:00+08:00', [{ n: 92, started: '2026-11-20T13:30:00+08:00' }]);
  batch('93', 'closed moved', [{ n: 93, started: '2026-11-20T13:40:00+08:00', state: 'moved batch-92' }]);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(handoffOutput(result), ['HANDOFF_COUNT 2/2', 'HANDOFF_DUE']);
});

test('只有前任派的 batch 不計入：HANDOFF_COUNT 0/2，不印 HANDOFF_DUE', t => {
  const { landed, probe } = handoffFixture(t);
  landed('81', 'closed', '2026-11-20T09:00:00+08:00');
  landed('83', `pushed ${SHA}`, '2026-11-20T10:00:00+08:00');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(handoffOutput(result), ['HANDOFF_COUNT 0/2']);
});

test('沒有 sessions.md、coordinator 檔，或 sessions.md 沒有這個 pid 的 start 行時印 HANDOFF_COUNT 0/<門檻>、不報錯', t => {
  for (const options of [{ sessions: false }, { coordinator: false }]) {
    const { landed, probe } = handoffFixture(t, options);
    landed('90', 'closed', '2026-11-20T12:30:00+08:00');
    const result = probe();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(handoffOutput(result), ['HANDOFF_COUNT 0/2'], JSON.stringify(options));
  }
  const { landed, pilot, probe } = handoffFixture(t);
  writeFileSync(join(pilot, 'coordinator'), `pid 5555   loop yes   since ${SESSION_START}   name coord-3\n`);
  landed('90', 'closed', '2026-11-20T12:30:00+08:00');
  assert.deepEqual(handoffOutput(probe()), ['HANDOFF_COUNT 0/2']);
});

test('pid 被重用、start 行早於 coordinator 檔的 since 時以 since 為準：之間派的 batch 不算', t => {
  const { landed, pilot, probe } = handoffFixture(t);
  writeFileSync(join(pilot, 'coordinator'), `pid 4242   loop yes   since 2026-11-20T13:00:00+08:00   name coord-3\n`);
  landed('90', 'closed', '2026-11-20T12:30:00+08:00');
  landed('91', `merged ${SHA}`, '2026-11-20T13:30:00+08:00');
  assert.deepEqual(handoffOutput(probe()), ['HANDOFF_COUNT 1/2']);
});

test('--handoff-after <n> 帶入門檻；不是正整數時是用法錯誤', t => {
  const { landed, probe } = handoffFixture(t);
  landed('90', 'closed', '2026-11-20T12:30:00+08:00');
  landed('91', `merged ${SHA}`, '2026-11-20T13:00:00+08:00');
  assert.deepEqual(handoffOutput(probe({ args: ['--handoff-after', '3'] })), ['HANDOFF_COUNT 2/3']);
  assert.deepEqual(handoffOutput(probe({ args: ['--handoff-after', '1'] })), ['HANDOFF_COUNT 2/1', 'HANDOFF_DUE']);
  for (const bad of ['0', 'x', '1.5']) assert.equal(probe({ args: ['--handoff-after', bad] }).status, 2, bad);
});

// #413 第 1 項（investing#516 第 1 項、investing#533 第 2 項）：pilot-watch 已印 `RESULT … DONE 508 <sha>`，worker 隨後結束，
// 下一次 Probe 印 `WORKER 508 STUCK exited`、batch 列仍 running。畫面上沒有結果行時改讀 watch 記下的 `.scratch/pilot/results/<handle>`。
test('畫面沒有結果行、terminal 已結束：讀 watch 記下的結果，印 WORKER <n> DONE 並由 --apply 寫回', t => {
  const { batch, probe, pilot } = fixture(t, { screens: {
    term_508: { status: 'exited', tail: ['Bye!'] },
    term_437: { status: 'running', tail: ['● 取消 loop', '❯'] },
  } });
  batch('437-508', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 437, started: ago(30) }, { n: 508, started: ago(30) }]);
  mkdirSync(join(pilot, 'results'));
  writeFileSync(join(pilot, 'results', 'term_508'), `${ago(2)} DONE 508 ${SHA}\n`);
  writeFileSync(join(pilot, 'results', 'term_437'), `${ago(3)} STOP 437 decision 取捨\n`);
  const result = probe({ args: ['--apply'] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lines(result).includes(`WORKER 508 DONE ${SHA}`), result.stdout);
  assert.ok(lines(result).includes('WORKER 437 STOP decision 取捨'), result.stdout);
  const text = readFileSync(join(pilot, 'batch-437-508.md'), 'utf8');
  assert.match(text, new RegExp(`\\| 508 \\|.*\\| done \\| ${SHA} \\|`));
  assert.match(text, /\| 437 \|.*\| stop \| +\|/);
});

test('watch 的記錄早於成員的 started 或最後一次 resumed、號碼不符時不算；畫面上的結果行優先', t => {
  const OTHER = 'c'.repeat(40);
  const { batch, probe, pilot } = fixture(t, { screens: {
    term_1: { status: 'exited', tail: ['Bye!'] },
    term_2: { status: 'exited', tail: ['Bye!'] },
    term_3: { status: 'exited', tail: ['Bye!'] },
    term_4: { status: 'running', tail: [`DONE 4 ${OTHER}`, '❯'] },
  } });
  batch('1-4', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 1, started: ago(10) }, { n: 2, started: ago(30) }, { n: 3, started: ago(30) }, { n: 4, started: ago(30) }]);
  const file = join(pilot, 'batch-1-4.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}resumed: #2 ${ago(5)} -\n`);
  mkdirSync(join(pilot, 'results'));
  writeFileSync(join(pilot, 'results', 'term_1'), `${ago(20)} DONE 1 ${SHA}\n`);
  writeFileSync(join(pilot, 'results', 'term_2'), `${ago(8)} DONE 2 ${SHA}\n`);
  writeFileSync(join(pilot, 'results', 'term_3'), `${ago(2)} DONE 99 ${SHA}\n`);
  writeFileSync(join(pilot, 'results', 'term_4'), `${ago(2)} DONE 4 ${SHA}\n`);
  const out = lines(probe());
  for (const n of [1, 2, 3]) assert.ok(out.includes(`WORKER ${n} STUCK exited`), out.join('\n'));
  assert.ok(out.includes(`WORKER 4 DONE ${OTHER}`), out.join('\n'));
});
