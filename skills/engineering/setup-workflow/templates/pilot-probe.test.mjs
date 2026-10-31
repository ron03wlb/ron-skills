import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { orcaReplySource } from './test/fake-orca.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./pilot-probe.mjs', import.meta.url).pathname;
// pre-commit hook 匯出的 GIT_DIR 等會讓暫存 repo 的 git 指令寫到本 repo。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const SHA = 'a'.repeat(40);

// 主 checkout（origin 是暫存的 bare repo，不碰網路）＋ `.scratch/pilot/` ＋ 假 Orca CLI。
// `screens` 是 handle → `terminal read --screen` 的 `{ status, tail }`；不在表裡的 handle 回 terminal_handle_stale。
// 假 Orca 會把 stdin 讀光並記錄讀到的內容：真實 Orca CLI 會吃掉 stdin，逐一讀成員時後面的成員就讀不到。
// `guard` 是專案自備 Bare guard（pilot-unbare.sh）的內容：有給時把 probe 複製到暫存的 scripts/，guard 放在它旁邊。
function fixture(t, { screens = {}, guard } = {}) {
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

  const batch = (key, current, members) => writeFileSync(join(pilot, `batch-${key}.md`), `# batch ${key}
current: ${current}
integration: pilot/integration @ 1234567

| Issue | branch | worktree | handle | started | stuck-after | state | candidate |
|---|---|---|---|---|---|---|---|
${members.map(m => `| ${m.n} | issue/${m.n}-x | /w/issue-${m.n} | ${m.handle ?? `term_${m.n}`} | ${m.started ?? ago(5)} | ${m.stuckAfter ?? '90m'} | ${m.state ?? 'running'} | ${m.candidate ?? ''} |`).join('\n')}
`);
  let probeScript = script;
  if (guard !== undefined) {
    const scripts = join(temp, 'scripts');
    mkdirSync(join(scripts, 'lib'), { recursive: true });
    for (const name of ['pilot-probe.mjs', 'orca-session-send.mjs', 'lib/pilot-store.mjs']) copyFileSync(new URL(`./${name}`, import.meta.url), join(scripts, name));
    writeFileSync(join(scripts, 'pilot-unbare.sh'), guard);
    chmodSync(join(scripts, 'pilot-unbare.sh'), 0o755);
    probeScript = join(scripts, 'pilot-probe.mjs');
  }
  const probe = ({ input = 'stdin 不該被 orca 讀到\n', args = [] } = {}) =>
    spawnSync('node', [probeScript, repo, ...args], { encoding: 'utf8', input, env: { ...env, ORCA_CLI_COMMAND: cli } });
  return { repo, pilot, origin, git, log, batch, probe };
}

const lines = result => result.stdout.trim().split('\n');

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
    + `regression: ${staged} bin/check --upstream exit 0\n`);
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

// 主 checkout 的狀態沒問題時不印任何一行，有問題才各印一行：Bare guard 印的行、不在 main、有 hold 檔、
// `git status --short` 有內容（每行一個 DIRTY，帶 status 原文）。
test('主 checkout 正常時不印狀態行；沒有 Bare guard 時略過', t => {
  const { probe } = fixture(t);
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
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
  assert.equal(result.stdout, '');
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
  const { repo, pilot, batch } = fixture(t);
  writeFileSync(join(pilot, 'hold'), '');
  batch('23', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 23 }]);
  const result = spawnSync('node', [script, repo], { encoding: 'utf8', env: Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'ORCA_CLI_COMMAND')) });
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
  assert.equal(probe().stdout, '');
  git('branch', 'pilot/integration');
  assert.equal(probe().stdout, '');

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
  assert.equal(probe().stdout, '');
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

test('--status 沒有 coordinator 檔、gate 與 batch 時照樣寫出', t => {
  const { pilot, probe } = fixture(t);
  const result = probe({ args: ['--status'] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const status = readFileSync(join(pilot, 'status.md'), 'utf8');
  assert.match(status, /^# pilot status（[^，]+，coordinator \(none\)）\n/);
  assert.match(status, /^- 沒有開著的 batch$/m);
  assert.match(status, /^- pilot\/integration none$/m);
});
