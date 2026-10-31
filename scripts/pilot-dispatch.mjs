#!/usr/bin/env node
// setup-workflow 正本（#58）：/issue-pilot coordinator 的 Dispatch，一個指令把 batch 的每個成員派給一個 `/issue-run <n> --worker <checkpoint>` worker。
// batch checkpoint 的格式照 issue-pilot 的 PILOT-STORE.md；專案不同的值（整合分支、stuck-after）由參數傳入。
// 每個成員依序：orca-worktree-create → Bare guard → 確認 worktree → terminal create → orca-session-send。
// Bare guard 是同目錄專案自備的 pilot-unbare.sh（`<checkout> <時機>`，時機 `dispatch #<n>`；Orca 從 WSL 建 worktree 會把主 checkout 設成 bare），沒有就略過。
// worktree 有沒有建好只看目錄存在、`git worktree list` 裡有這個分支，不信 create 回傳的 ok（曾經建好卻回 "ok": false）。
// 所有子行程的 stdin 都接 /dev/null：Orca CLI 會吃掉 stdin，`while read` 迴圈因此只派到第一個成員。
// 總時間有上限（比照 pilot-handoff.mjs）：Bash 工具最多等 600 秒，被殺就來不及寫 checkpoint，所以預算到了（timeout）或收到 SIGTERM、SIGINT（signal <名稱>）
// 都中止進行中的步驟，進行中與還沒派的成員都 STOP 並寫進 checkpoint。預設預算 510 秒，加上收尾的 git 與寫檔，在 540 秒內結束。
//
// 用法：node scripts/pilot-dispatch.mjs <batch key> <n>:<slug>... [--integration <分支>] [--stuck-after <分鐘>m]（在主 checkout 跑，需要 ORCA_CLI_COMMAND）
//   --integration worktree 的 base 與表頭的整合分支，預設 pilot/integration；--stuck-after 成員行的 stuck-after，預設 90m。
// stdout：每個成員一行 DISPATCHED <n> <terminal handle> 或 STOP <n> <原因>（create、unbare、terminal、tui-timeout、send、orca、timeout、signal）；
//   Bare guard 還原主 checkout 時另有一行 UNBARE <主 checkout>。成員行同時寫進 <主 checkout>/.scratch/pilot/batch-<key>.md，
//   state 只寫 running 或 stop（pilot-probe.mjs 只認 PILOT-STORE.md 的 running／done／stop），STOP 原因只在 stdout。
// exit：0 全部派出；4 有成員 STOP；2 用法錯誤或沒有 ORCA_CLI_COMMAND；1 其他失敗。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { orca, sendToSession } from './orca-session-send.mjs';
import { recordTitle, withState } from './tab-state.mjs';

const USAGE = '用法：node scripts/pilot-dispatch.mjs <batch key> <n>:<slug>... [--integration <分支>] [--stuck-after <分鐘>m]（需要 ORCA_CLI_COMMAND）';
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'pilot-unbare.sh');
const WORKTREE_CREATE = fileURLToPath(new URL('./orca-worktree-create.mjs', import.meta.url));
const BUDGET_MS = Number(process.env.PILOT_DISPATCH_BUDGET_MS || 510000);

/** 同步跑子行程；stdin 一律接 /dev/null。 */
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

/** 主 checkout：`git worktree list` 的第一列，從任何 worktree 呼叫都指回同一處。 */
function mainCheckout() {
  const result = run('git', ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) throw new Error(`git worktree list 失敗：${result.stderr.trim()}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/** `git worktree list` 裡分支是 `branch`、目錄也存在的 worktree 路徑；沒有傳回 undefined。 */
function worktreeOf(main, branch) {
  const result = run('git', ['-C', main, 'worktree', 'list', '--porcelain']);
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\n\n+/)
    .map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] }))
    .find(w => w.branch === branch && w.path && existsSync(w.path))?.path;
}

/** 本地時區的 ISO 時間到秒（同 `date -Iseconds`），例如 2026-10-30T17:31:36+08:00。 */
function now() {
  const date = new Date();
  const offset = -date.getTimezoneOffset();
  const pad = value => String(Math.floor(Math.abs(value))).padStart(2, '0');
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, 19);
  return `${local}${offset < 0 ? '-' : '+'}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** 沒有 batch checkpoint 時寫表頭（格式見 skills/engineering/issue-pilot/PILOT-STORE.md）；已有時不動，重跑同一個 batch 只換成員行。 */
function writeHeader(main, checkpoint, key, integration) {
  if (existsSync(checkpoint)) return;
  const sha = run('git', ['-C', main, 'rev-parse', '--short', integration]).stdout.trim();
  mkdirSync(dirname(checkpoint), { recursive: true });
  writeFileSync(checkpoint, `# batch ${key}\ncurrent: dispatched ${now()}\nintegration: ${integration} @ ${sha}\n\n`
    + '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n');
}

/** 寫入成員行：同一個 Issue 已有一行就就地換掉，否則接在最後。 */
function writeRow(checkpoint, n, cells) {
  const row = `| ${n} | ${cells.join(' | ')} | |`;
  const lines = readFileSync(checkpoint, 'utf8').replace(/\n$/, '').split('\n');
  const i = lines.findIndex(line => line.startsWith(`| ${n} |`));
  if (i >= 0) lines[i] = row; else lines.push(row);
  writeFileSync(checkpoint, `${lines.join('\n')}\n`);
}

/** 非同步跑子行程（stdin 接 /dev/null），傳回 stdout；`signal` 中止時殺掉它。 */
async function spawnText(command, args, options) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return stdout;
}

/**
 * 派一個成員；傳回 `{ worktree?, handle }` 或 `{ worktree?, handle?, stop }`（不含 `STOP <n> ` 前綴）。
 * worktree 已存在（重跑 STOP 的成員）時不再 create：再呼叫一次，Orca 會去重出 `issue-<n>-2`。
 * `signal` 中止時（reason 為 `timeout` 或 `signal <名稱>`）進行中的步驟丟錯，STOP 原因改用 reason；create 被中止時仍跑 Bare guard。
 */
async function dispatchMember(cli, main, checkpoint, integration, { n, branch }, signal) {
  if (signal.aborted) return { stop: signal.reason };
  let created = '';
  if (!worktreeOf(main, branch)) {
    try {
      created = await spawnText('node', [WORKTREE_CREATE, '--name', `issue-${n}`, '--base-branch', integration, '--branch', branch, '--issue', n],
        { cwd: main, env: { ...process.env, ORCA_BIN: cli }, signal });
    } catch (error) {
      created = error.message;
    }
  }
  if (existsSync(GUARD)) {
    const unbare = run(GUARD, [main, `dispatch #${n}`]);
    if (unbare.stdout) process.stdout.write(unbare.stdout);
    if (unbare.status !== 0) return { stop: `unbare ${(unbare.stderr ?? '').trim() || `exit ${unbare.status ?? unbare.error?.code}`}` };
  }
  const worktree = worktreeOf(main, branch);
  if (signal.aborted) return { worktree, stop: signal.reason };
  if (!worktree) {
    let detail = created.trim();
    try { detail = JSON.parse(detail).error ?? detail; } catch { /* 非 JSON 就原樣附上 */ }
    return { stop: `create ${detail}` };
  }
  const ctx = { cli, signal };
  const title = withState(`#${n}`, '處理中');
  let handle;
  try {
    handle = (await orca(ctx, 'terminal', 'create', '--worktree', `path:${worktree}`, '--title', title, '--command', 'claude')).terminal.handle;
    // Orca 讀不回 create 設的標題，worker 的 tab-state 靠這份記錄（scripts/tab-state.mjs）。
    recordTitle(handle, title);
  } catch (error) {
    // 殺掉 create 時 Orca 可能已開好分頁卻沒回 handle。
    if (signal.aborted) return { worktree, stop: `${signal.reason}（請確認有沒有留下標題 ${title} 的分頁）` };
    return { worktree, stop: `terminal ${error.message}` };
  }
  const sent = await sendToSession(ctx, handle, `/issue-run ${n} --worker ${checkpoint}`);
  return { worktree, handle, ...(sent.stop && signal.aborted ? { stop: signal.reason } : sent) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const positional = [];
  const given = {};
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const name = { '--integration': 'integration', '--stuck-after': 'stuckAfter' }[args[i]];
    const value = args[++i];
    if (!name || !value || value.startsWith('--') || name in given) bad = true;
    else given[name] = value;
  }
  const options = { integration: 'pilot/integration', stuckAfter: '90m', ...given };
  if (!/^\d+m$/.test(options.stuckAfter)) bad = true;
  const [key, ...specs] = positional;
  const members = specs.map(spec => spec.match(/^(\d+):([a-z0-9][a-z0-9-]*)$/)).map(m => m && { n: m[1], branch: `issue/${m[1]}-${m[2]}` });
  const cli = process.env.ORCA_CLI_COMMAND;
  if (bad || !key || !members.length || members.some(m => !m) || !cli) {
    console.error(USAGE);
    process.exit(2);
  }
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort('timeout'), BUDGET_MS);
  for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => controller.abort(`signal ${name}`));
  try {
    const main = mainCheckout();
    // 打錯的整合分支會寫出沒有 SHA 的表頭（PILOT-STORE 要 `<branch> @ <sha>`），表頭已存在時重跑也不改寫。
    if (run('git', ['-C', main, 'rev-parse', '--verify', '-q', `refs/heads/${options.integration}`]).status !== 0) {
      console.error(`整合分支 ${options.integration} 不存在\n${USAGE}`);
      process.exit(2);
    }
    const checkpoint = join(main, `.scratch/pilot/batch-${key}.md`);
    writeHeader(main, checkpoint, key, options.integration);
    let stopped = false;
    for (const member of members) {
      const started = now();
      const result = await dispatchMember(cli, main, checkpoint, options.integration, member, controller.signal);
      stopped ||= Boolean(result.stop);
      writeRow(checkpoint, member.n, [member.branch, result.worktree ?? '', result.handle ?? '', started, options.stuckAfter, result.stop ? 'stop' : 'running']);
      console.log(result.stop ? `STOP ${member.n} ${result.stop}` : `DISPATCHED ${member.n} ${result.handle}`);
    }
    clearTimeout(budget);
    process.exit(stopped ? 4 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
