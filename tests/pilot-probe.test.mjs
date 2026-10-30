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

// 沒有 ORCA_CLI_COMMAND 時 Bare guard、主 checkout、gate 等與 Orca 無關的檢查照跑，只有 running 成員讀不到。
test('沒有 ORCA_CLI_COMMAND 時其他檢查照跑，running 成員印 STUCK no-orca', t => {
  const { repo, git, batch } = fixture(t);
  git('config', 'core.bare', 'true');
  batch('23', 'dispatched 2026-10-30T17:31:36+08:00', [{ n: 23 }]);
  const result = spawnSync('node', [script, repo], { encoding: 'utf8', env: Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'ORCA_CLI_COMMAND')) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), [`UNBARE ${repo}`, 'WORKER 23 STUCK no-orca']);
});

// #52：coordinator 讀主 checkout 的 adapter，pilot/integration 上的版本比較新時會照過時的規則 stage（#21 的 Stage worktree）。
// issue-run.md 與 pilot.md（#45 之後）都比；只有 integration 有也算，兩邊相同或沒有 pilot/integration 時不印。
// review 第一輪：main 自己改了 adapter、integration 還沒跟上時，integration 的版本比較舊，不印（否則 coordinator 會改讀舊規則）。
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
  commit({ 'docs/agents/issue-run.md': '# adapter\n- Stage worktree\n', 'docs/agents/pilot.md': '# pilot\n' }, 'newer adapter');
  git('switch', '-q', 'main');
  const result = probe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ['ADAPTER_AHEAD docs/agents/issue-run.md', 'ADAPTER_AHEAD docs/agents/pilot.md']);

  // main 跟上 integration 之後只剩 integration 新改的 pilot.md。
  git('merge', '-q', '--ff-only', 'pilot/integration');
  git('switch', '-q', 'pilot/integration');
  commit({ 'docs/agents/pilot.md': '# pilot\n- Probe\n' }, 'newer pilot');
  git('switch', '-q', 'main');
  assert.deepEqual(lines(probe()), ['ADAPTER_AHEAD docs/agents/pilot.md']);

  // main 直接合入新的 issue-run.md：integration 那份比較舊，不印。
  commit({ 'docs/agents/issue-run.md': '# adapter\n- Push gate\n' }, 'main adapter');
  assert.deepEqual(lines(probe()), ['ADAPTER_AHEAD docs/agents/pilot.md']);

  // review 第二輪：integration 刪掉的檔讀不到（`git show pilot/integration:<檔案>` 會失敗），不印。
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', 'pilot/integration');
  git('switch', '-q', 'pilot/integration');
  git('merge', '-q', '--ff-only', 'main');
  git('rm', '-q', 'docs/agents/pilot.md');
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
