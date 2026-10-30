import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { orcaReplySource } from './helpers/fake-orca.mjs';

const script = new URL('../scripts/pilot-probe.mjs', import.meta.url).pathname;
// pre-commit hook 匯出的 GIT_DIR 等會讓暫存 repo 的 git 指令寫到本 repo（見 pilot-unbare.test.mjs）。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const SHA = 'a'.repeat(40);

// 主 checkout（origin 是暫存的 bare repo，不碰網路）＋ `.scratch/pilot/` ＋ 假 Orca CLI。
// `screens` 是 handle → `terminal read --screen` 的 `{ status, tail }`；不在表裡的 handle 回 terminal_handle_stale。
// 假 Orca 會把 stdin 讀光並記錄讀到的內容：真實 orca-ide 會吃掉 stdin，逐一讀成員時後面的成員就讀不到（#23 retro）。
function fixture(t, { screens = {} } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'pilot-probe-'));
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

  const batch = (key, current, members) => writeFileSync(join(pilot, `batch-${key}.md`), `# batch ${key}
current: ${current}
integration: pilot/integration @ 1234567

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
${members.map(m => `| ${m.n} | issue/${m.n}-x | /w/issue-${m.n} | ${m.handle ?? `term_${m.n}`} | ${m.started ?? ago(5)} | ${m.stuckAfter ?? '90m'} | ${m.state ?? 'running'} | ${m.candidate ?? ''} |`).join('\n')}
`);
  const probe = ({ input = 'stdin 不該被 orca 讀到\n' } = {}) =>
    spawnSync('node', [script, repo], { encoding: 'utf8', input, env: { ...env, ORCA_CLI_COMMAND: cli } });
  return { repo, pilot, origin, git, log, batch, probe };
}

const lines = result => result.stdout.trim().split('\n');

// 重現 #23 retro：TUI 畫了框線時結果行尾端帶空白和 `│`，不先去掉就比對不到 DONE。
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

// 真實 orca-ide 會吃掉 stdin（#23 retro）；呼叫時 stdin 一律接 /dev/null，假 Orca 讀光 stdin 也只會讀到空的。
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

// 這一輪剛讀到 DONE／STOP 的成員與 checkpoint 已記成 done／stop 的成員都算結束；
// 已經 staged、merged、closed 的 batch 不再印（它們的成員也都是 done）。
test('dispatched 的 batch 每個成員都 done 或 stop 時印 STAGEABLE <key>', t => {
  const { batch, probe } = fixture(t, { screens: {
    term_23: { status: 'running', tail: [`DONE 23 ${SHA}`] },
    term_30: { status: 'running', tail: ['❯'] },
  } });
  batch('22-23', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 22, state: 'stop', candidate: 'abc1234' }, { n: 23 }]);
  batch('30-31', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 30 }, { n: 31, state: 'done', candidate: 'abc1234' }]);
  batch('8', 'closed 2026-10-30T13:38:21+08:00', [{ n: 8, state: 'done', candidate: 'abc1234' }]);
  const out = lines(probe());
  assert.ok(out.includes('STAGEABLE 22-23'), out.join('\n'));
  assert.ok(!out.some(line => /^STAGEABLE (30-31|8)$/.test(line)), out.join('\n'));
});

// pushed 的 batch 在 checkpoint 只剩 `regression: <sha>` 指出合入的內容（Integrate 是 ff-only，staged SHA 就是 pilot/integration 的 tip）；
// merged <sha> 的 batch 同樣要判斷（adapter 的 Probe 對兩者都決定做 Close 或重跑 Push gate）。
// 判斷的是 fetch 之後的 origin/main：另一個 clone 推上去、本機還沒 fetch 的合入也要算 IN_MAIN。
test('pushed、merged 的 batch fetch 後印 IN_MAIN 或 NOT_IN_MAIN', t => {
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
  batch('9', `merged ${pending}`, [{ n: 9, state: 'done', candidate: 'abc1234' }]);
  batch('10', 'pushed', [{ n: 10, state: 'done', candidate: 'abc1234' }]);
  const out = lines(probe());
  assert.ok(out.includes('IN_MAIN 8'), out.join('\n'));
  assert.ok(out.includes('NOT_IN_MAIN 9'), out.join('\n'));
  assert.ok(out.includes('NOT_IN_MAIN 10 no-sha'), out.join('\n'));
});

// 主 checkout 的狀態沒問題時不印任何一行，有問題才各印一行：被設成 bare（Bare guard 還原並印 UNBARE，#20）、
// 不在 main（#21）、有 hold 檔、`git status --short` 有內容（每行一個 DIRTY，帶 status 原文）。
test('主 checkout 正常時不印狀態行', t => {
  const { probe } = fixture(t);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('主 checkout 被設成 bare、不在 main、有 hold、有改動時各印一行', t => {
  const { repo, pilot, git, probe } = fixture(t);
  git('switch', '-q', '-c', 'pilot/stage-8');
  writeFileSync(join(repo, 'stray.txt'), 'x');
  writeFileSync(join(pilot, 'hold'), '');
  git('config', 'core.bare', 'true');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), [`UNBARE ${repo}`, 'NOT_MAIN pilot/stage-8', 'HOLD', 'DIRTY ?? stray.txt']);
  assert.match(readFileSync(join(pilot, 'decisions.md'), 'utf8'), /還原 core\.bare \| [^|]*probe/);
});

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
