#!/usr/bin/env node
// setup-workflow 正本（#58）：/issue-pilot coordinator 的 Dispatch，一個指令把 batch 的每個成員派給一個 `/issue-run <n> --worker <checkpoint>` worker。
// batch checkpoint 的格式照 issue-pilot 的 PILOT-STORE.md；專案不同的值（整合分支、stuck-after）由參數傳入。
// 每個成員依序：orca-worktree-create → Bare guard → 確認 worktree → terminal create → orca-session-send。
// Bare guard 是同目錄專案自備的 pilot-unbare.sh（`<checkout> <時機>`，時機 `dispatch #<n>`；Orca 從 WSL 建 worktree 會把主 checkout 設成 bare），沒有就略過。
// 派每個成員之前先讀 Issue 最近一則認領留言（同目錄 issue-pool.mjs 的格式與判斷，含 claim 的前任 coordinator 接手）：不是這個 session
// （$CLAUDE_CODE_SESSION_ID，其次 $ORCA_TERMINAL_HANDLE）的就印 `STOP <n> not-claimed`，不開 worktree、不開分頁（#165：claim 印 STOP 後照樣派出）。
// 讀留言用 gh，所以只支援 GitHub tracker（同 issue-pool.mjs）。
// worktree 有沒有建好只看目錄存在、`git worktree list` 裡有這個分支，不信 create 回傳的 ok（曾經建好卻回 "ok": false）。
// 所有子行程的 stdin 都接 /dev/null：Orca CLI 會吃掉 stdin，`while read` 迴圈因此只派到第一個成員。
// 總時間有上限（比照 pilot-handoff.mjs）：Bash 工具最多等 600 秒，被殺就來不及寫 checkpoint，所以預算到了（timeout）或收到 SIGTERM、SIGINT（signal <名稱>）
// 都中止進行中的步驟，進行中與還沒派的成員都 STOP 並寫進 checkpoint。預設預算 510 秒，加上收尾的 git 與寫檔，在 540 秒內結束。
//
// --fresh（#124）把一個成員重派成 fresh worker（Stage 的同一條目衝突之後），worktree 與分支名稱不變，舊分支就地另存：
//   工作樹有未提交改動 → `STOP dirty <n>`，什麼都不動；關掉 worktree 裡每個 terminal（checkpoint 可能只記了其中一個）；
//   `branch -m <分支> <分支>-prior`；`switch -c <分支> <整合分支>`；worker 的 `.scratch/issue-run-<n>` 改名成 `issue-run-<n>-prior`（fresh worker 才不讀到舊 checkpoint）；
//   在 Issue 留言 --note 的內容加一行 `prior: <prior 分支> @ <sha>`（gh）；把成員拆到自己的 batch（原 batch 那列記 `moved batch-<n>`，batch-<n>.md 是表頭加一列；
//   原 batch 就是 `<n>` 時就地改寫 `current:` 與 `integration:`）；最後照一般 Dispatch 開分頁、送出 `/issue-run <n> --worker <batch-<n>.md>`。
//   不刪 worktree、不 `branch -D`（auto mode 擋 reset --hard 這類指令，就地改名也不必重建 worktree 與分頁），不刪 prior 分支。
//   每一步先看做過沒有：已有 prior、分支還沒有自己的 commit（相對整合分支）時是同一次重派中斷了，同一行指令接著做；留言已含 `prior:` 行就不再留。
//   batch-<n>.md 那列已是 running、它的分頁還開在這個 worktree 時，這次重派已經做完、fresh worker 正在跑：印 `STOP <n> running <handle>`，不關分頁。
//   留言用 gh，所以 --fresh 只支援 GitHub tracker（同 issue-pool.mjs）。
//   prior 依序找 `-prior`、`-prior2`…：手動重派留下的 `-prior` 也算，那張 Issue 第一次跑 --fresh 就是 refresh-twice。
//   prior 已在、分支又有了 commit 就是第二次重派：印 `STOP refresh-twice <n>`，由 coordinator 開 gate；gate 選了再重派時帶 --again，另存成 `-prior2`（依序編號）。
//   認領不在這裡做：coordinator 照 Dispatch 先跑 claim；這裡只在動手前同樣檢查認領，不是這個 session 的就 `STOP <n> not-claimed`，什麼都不動。
//
// 用法：node scripts/pilot-dispatch.mjs <batch key> <n>:<slug>... [--integration <分支>] [--stuck-after <分鐘>m]（在主 checkout 跑，需要 ORCA_CLI_COMMAND）
//       node scripts/pilot-dispatch.mjs <batch key> --fresh <n>:<slug> --note <檔> [--again] [--integration <分支>] [--stuck-after <分鐘>m]
//   --integration worktree 的 base 與表頭的整合分支，預設 pilot/integration；--stuck-after 成員行的 stuck-after，預設 90m。
// stdout：每個成員一行 DISPATCHED <n> <terminal handle> 或 STOP <n> <原因>（not-claimed、claim-check（讀不到留言）、create、unbare、terminal、tui-timeout、send、orca、timeout、signal）；
//   Bare guard 還原主 checkout 時另有一行 UNBARE <主 checkout>。成員行同時寫進 <主 checkout>/.scratch/pilot/batch-<key>.md，
//   state 只寫 running 或 stop（pilot-probe.mjs 只認 PILOT-STORE.md 的 running／done／stop），STOP 原因只在 stdout。
//   --fresh 成功時 DISPATCHED 之後再印 `PRIOR <n> <prior 分支> <sha>`；另有 `STOP dirty <n>`、`STOP refresh-twice <n>`、`STOP <n> running <handle>`、`STOP <n> worktree …`、`STOP <n> git …`、`STOP <n> terminal-close …`、`STOP <n> comment …`。
// exit：0 全部派出；4 有成員 STOP；2 用法錯誤或沒有 ORCA_CLI_COMMAND；1 其他失敗。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claimedBy, defaultSession } from './issue-pool.mjs';
import { orca, sendToSession } from './orca-session-send.mjs';
import { recordTitle, withState } from './tab-state.mjs';

const USAGE = '用法：node scripts/pilot-dispatch.mjs <batch key> <n>:<slug>... [--integration <分支>] [--stuck-after <分鐘>m]（需要 ORCA_CLI_COMMAND）\n'
  + '      node scripts/pilot-dispatch.mjs <batch key> --fresh <n>:<slug> --note <檔> [--again] [--integration <分支>] [--stuck-after <分鐘>m]';
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'pilot-unbare.sh');
const WORKTREE_CREATE = fileURLToPath(new URL('./orca-worktree-create.mjs', import.meta.url));
const BUDGET_MS = Number(process.env.PILOT_DISPATCH_BUDGET_MS || 510000);
const DEADLINE = Date.now() + BUDGET_MS;

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

/** --fresh 拆出的 batch：沒有就照 writeHeader 寫；已有（中斷後重跑、原 batch 就是 `<n>`）時改寫 `current:` 與 `integration:`。 */
function freshHeader(main, checkpoint, key, integration) {
  if (!existsSync(checkpoint)) return writeHeader(main, checkpoint, key, integration);
  const sha = run('git', ['-C', main, 'rev-parse', '--short', integration]).stdout.trim();
  writeFileSync(checkpoint, readFileSync(checkpoint, 'utf8')
    .replace(/^current:.*$/m, `current: dispatched ${now()}`).replace(/^integration:.*$/m, `integration: ${integration} @ ${sha}`));
}

/** 把成員行的 state 欄改成 `state`；沒有這一行就不動。 */
function setRowState(checkpoint, n, state) {
  if (!existsSync(checkpoint)) return;
  const lines = readFileSync(checkpoint, 'utf8').split('\n');
  const i = lines.findIndex(line => line.startsWith(`| ${n} |`));
  if (i < 0) return;
  const cells = lines[i].split('|');
  cells[7] = ` ${state} `;
  lines[i] = cells.join('|');
  writeFileSync(checkpoint, lines.join('\n'));
}

/** 寫入成員行：同一個 Issue 已有一行就就地換掉，否則接在最後。 */
function writeRow(checkpoint, n, cells) {
  const row = `| ${n} | ${cells.join(' | ')} | |`;
  const lines = readFileSync(checkpoint, 'utf8').replace(/\n$/, '').split('\n');
  const i = lines.findIndex(line => line.startsWith(`| ${n} |`));
  if (i >= 0) lines[i] = row; else lines.push(row);
  writeFileSync(checkpoint, `${lines.join('\n')}\n`);
}

/**
 * 認領檢查：這個 session 的認領傳回 undefined，否則傳回 STOP 原因（不含 `STOP <n> ` 前綴）。
 * spawnSync 期間總預算的計時器不會觸發，所以 gh 自己限時（60 秒與剩餘預算取小），預算用完就是 `timeout`；原因壓成一行，stdout 才維持每個成員一行。
 */
function claimStop(n) {
  const left = DEADLINE - Date.now();
  if (left <= 0) return 'timeout';
  const viewed = run('gh', ['issue', 'view', n, '--json', 'comments'], { timeout: Math.min(60000, left) });
  if (Date.now() >= DEADLINE) return 'timeout';
  const detail = (viewed.stderr ?? '').trim().replace(/\s*\n\s*/g, ' ');
  if (viewed.status !== 0) return `claim-check ${detail || `exit ${viewed.status ?? viewed.error?.code}`}`;
  try {
    return claimedBy(JSON.parse(viewed.stdout).comments, defaultSession()) ? undefined : 'not-claimed';
  } catch {
    return 'claim-check gh issue view 的輸出不是 JSON';
  }
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
  const unclaimed = claimStop(n);
  if (unclaimed) return { stop: unclaimed };
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

const priorName = (branch, k) => `${branch}-prior${k > 1 ? k : ''}`;
const hasBranch = (main, branch) => run('git', ['-C', main, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`]).status === 0;

/**
 * --fresh 的重派前置：做到「worktree 停在從整合分支新開的分支、batch-<n>.md 準備好」為止（步驟見檔頭）。
 * 傳回 `{ checkpoint, prior, sha, worktree }`，或 `{ stop }`（整段 STOP 字串，不含 `STOP `）。
 */
async function refresh(cli, main, key, integration, { n, branch }, note, again, signal) {
  const unclaimed = claimStop(n);
  if (unclaimed) return { stop: `${n} ${unclaimed}` };
  const priors = [];
  while (hasBranch(main, priorName(branch, priors.length + 1))) priors.push(priorName(branch, priors.length + 1));
  const latest = priors.at(-1);
  // 同一次重派中斷了：prior 已在，分支還沒開或還沒有 fresh worker 的 commit。
  const resuming = latest && (!hasBranch(main, branch)
    || run('git', ['-C', main, 'rev-list', '--count', `${integration}..${branch}`]).stdout.trim() === '0');
  if (latest && !resuming && !again) return { stop: `refresh-twice ${n}` };
  if (!latest && !hasBranch(main, branch)) return { stop: `${n} git 沒有分支 ${branch}` };
  const prior = resuming ? latest : priorName(branch, priors.length + 1);
  const worktree = worktreeOf(main, branch) ?? (resuming ? worktreeOf(main, prior) : undefined);
  if (!worktree) return { stop: `${n} worktree 找不到 ${branch} 的 worktree` };
  const checkpoint = join(main, `.scratch/pilot/batch-${n}.md`);
  const ctx = { cli, signal };
  let open;
  try {
    open = (await orca(ctx, 'terminal', 'list', '--worktree', `path:${worktree}`)).terminals.map(({ handle }) => handle);
  } catch (error) {
    return { stop: signal.aborted ? `${n} ${signal.reason}` : `${n} terminal-close ${error.message}` };
  }
  const row = resuming && existsSync(checkpoint)
    ? readFileSync(checkpoint, 'utf8').split('\n').find(line => line.startsWith(`| ${n} |`))?.split('|').map(cell => cell.trim()) : undefined;
  if (row?.[7] === 'running' && open.includes(row[4])) return { stop: `${n} running ${row[4]}` };
  const git = (...args) => run('git', ['-C', worktree, ...args]);
  const status = git('status', '--porcelain');
  if (status.status !== 0) return { stop: `${n} git status ${status.stderr.trim()}` };
  if (status.stdout.trim()) return { stop: `dirty ${n}` };

  try {
    for (const handle of open) await orca(ctx, 'terminal', 'close', '--terminal', handle);
  } catch (error) {
    return { stop: signal.aborted ? `${n} ${signal.reason}` : `${n} terminal-close ${error.message}` };
  }
  for (const [check, args] of [
    [() => hasBranch(main, prior), ['branch', '-m', branch, prior]],
    [() => hasBranch(main, branch), ['switch', '-q', '-c', branch, integration]],
    [() => git('branch', '--show-current').stdout.trim() === branch, ['switch', '-q', branch]],
  ]) {
    if (check()) continue;
    const result = git(...args);
    if (result.status !== 0) return { stop: `${n} git ${args[0]} ${result.stderr.trim()}` };
  }
  const sha = run('git', ['-C', main, 'rev-parse', prior]).stdout.trim();
  const suffix = prior.slice(branch.length);
  const [oldState, priorState] = [`issue-run-${n}`, `issue-run-${n}${suffix}`].map(name => join(worktree, '.scratch', name));
  if (existsSync(oldState) && !existsSync(priorState)) renameSync(oldState, priorState);

  const marker = `prior: ${prior} @ ${sha}`;
  const gh = (...args) => run('gh', args);
  const viewed = gh('issue', 'view', n, '--json', 'comments');
  if (viewed.status !== 0) return { stop: `${n} comment ${viewed.stderr.trim()}` };
  let comments;
  try { comments = JSON.parse(viewed.stdout).comments; } catch { return { stop: `${n} comment gh issue view 的輸出不是 JSON` }; }
  if (!comments.some(({ body }) => body.includes(marker))) {
    const posted = gh('issue', 'comment', n, '--body', `${note.replace(/\s+$/, '')}\n\n${marker}`);
    if (posted.status !== 0) return { stop: `${n} comment ${posted.stderr.trim()}` };
  }

  if (key !== n) setRowState(join(main, `.scratch/pilot/batch-${key}.md`), n, `moved batch-${n}`);
  freshHeader(main, checkpoint, n, integration);
  return { checkpoint, prior, sha, worktree };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const positional = [];
  const given = {};
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    if (args[i] === '--again') { bad ||= 'again' in given; given.again = true; continue; }
    const name = { '--integration': 'integration', '--stuck-after': 'stuckAfter', '--fresh': 'fresh', '--note': 'note' }[args[i]];
    const value = args[++i];
    if (!name || !value || value.startsWith('--') || name in given) bad = true;
    else given[name] = value;
  }
  const options = { integration: 'pilot/integration', stuckAfter: '90m', ...given };
  if (!/^\d+m$/.test(options.stuckAfter)) bad = true;
  const [key, ...specs] = positional;
  const fresh = 'fresh' in given;
  // --fresh 只帶一個成員、一定要有 --note；--note 與 --again 只跟 --fresh 一起用。
  if (fresh ? specs.length || !given.note || !existsSync(given.note) : 'note' in given || given.again) bad = true;
  const members = (fresh ? [given.fresh] : specs).map(spec => spec.match(/^(\d+):([a-z0-9][a-z0-9-]*)$/)).map(m => m && { n: m[1], branch: `issue/${m[1]}-${m[2]}` });
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
    if (fresh) {
      const [member] = members;
      const started = now();
      const ready = await refresh(cli, main, key, options.integration, member, readFileSync(given.note, 'utf8'), Boolean(given.again), controller.signal);
      if (ready.stop) {
        console.log(`STOP ${ready.stop}`);
        clearTimeout(budget);
        process.exit(4);
      }
      const result = await dispatchMember(cli, main, ready.checkpoint, options.integration, member, controller.signal);
      writeRow(ready.checkpoint, member.n, [member.branch, result.worktree ?? ready.worktree, result.handle ?? '', started, options.stuckAfter, result.stop ? 'stop' : 'running']);
      console.log(result.stop ? `STOP ${member.n} ${result.stop}` : `DISPATCHED ${member.n} ${result.handle}\nPRIOR ${member.n} ${ready.prior} ${ready.sha}`);
      clearTimeout(budget);
      process.exit(result.stop ? 4 : 0);
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
