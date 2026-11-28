#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// copy-templates: requires pilot-decision.mjs
// setup-workflow 正本（CoS item 91 D、item 153；上游化自 spay2 2958c8ac7 的 scripts/tab-sweep.mjs，CoS item 85）：
// issue-pilot coordinator 每個 tick 的 Tab sweep。分頁標題被換成待 Retro（LANDED／HANDED_OFF／DONE）或待關閉（/retro 最後一步）之後，
// 只有交接與 worker DONE 兩條路自己跑 retro；retro-collect、refine、臨時手動分頁停在待 Retro／待關閉，沒人送 /retro、也沒人關分頁，
// 原本由每小時看守代清（看守的 TAB_DONE）。改由 coordinator 每輪自己接手，看守只核對 coordinator 有沒有做到。
//
// 用法：node scripts/tab-sweep.mjs <主 checkout> [--roster <指令>] [--dry-run]
//   只看 `$ORCA_CLI_COMMAND terminal list --include-visual-layouts` 裡 worktreePath 是 <主 checkout> 的分頁（同一路徑、結尾斜線、WSL 的 UNC 寫法
//   `\\wsl.localhost\<distro>\…` 都算）；其他 worktree 的分頁由 worktree 清理處理，只計數。
//   標題（狀態前綴）照 tab-state.mjs：Orca 版面資料的分頁標題，沒涵蓋時退回 tab-state 的標題記錄。
//   每個分頁照下面順序判斷，任一條不成立就跳過（判斷比看守的 TAB_DONE 保守：看守只看前綴）：
//     1. 不是自己（ORCA_TERMINAL_HANDLE）、不是現任 coordinator（`.scratch/pilot/sessions.md` 最後一個 `→ terminal <handle>`）；
//        兩者都認不出來時整輪不動（TAB_SWEEP_FAILED coordinator-unknown）。
//     2. 標題以 `待 Retro｜` 或 `待關閉｜` 開頭（處理中｜、沒有前綴的不動）。例外（#649）：`.scratch/retro/collector` 記的收集者分頁
//        停在 `處理中｜`，但啟動之後 `.scratch/retro/reports/` 已有檔、或 `.scratch/retro/triggers.log` 已有 collect 行時，收集已完成，
//        當作待關閉（狀態列殘留的「1 shell still running」「← 1 agent」不算在跑；同 pilot-retro-due.mjs 的 collectedSince）。
//     3. 是分頁的第一個 pane（split 出來的 pane 不代表分頁）；待 Retro 而且沒送過（`.scratch/pilot/tab-sweep.json` 的 sent）。
//     4. lastOutputAt 距今至少 10 分鐘。
//     5. 畫面閒置（`terminal read --screen` 的最後 40 行）：沒有 `esc to interrupt`、沒有工作中的 spinner 或 `…ing…` 行、
//        有一行空的 `❯` 提示列（含輸入框邊框 `│ ❯   │` 的寫法），而且 draft（未送出的輸入）是空的。
//     6. 待關閉另外要：--roster 有給時，它的輸出沒有這個 handle 的 DONE／PENDING 列（spay2 這類宣告 roster 的專案：retro 檔還沒收就不關）；
//        同一分頁沒有其他 pane（`terminal close --tab` 會一起關）。
//   通過後：待 Retro → `terminal send --text /retro --enter`，記 sent[handle]（同一 handle 只送一次）；待關閉 → `terminal close --terminal <handle> --tab`。
//   --roster <指令>：以 sh -c 在主 checkout 跑，輸出每行 `<DONE|PENDING|COLLECTED> <session> <handle|-> …`（spay2 的 `node scripts/retro-collect.mjs --status`）；
//     只在有待關閉分頁時跑。沒給時待關閉直接可關（ron-skills：/retro 已把候選開成 Issue 才換待關閉）。
// stdout 每個主 checkout 分頁一行，最後一行 SUMMARY（decisions.md 有一列沒記到時，其後再多一行 TAB_RECORD_FAILED）：
//   TAB_RETRO_SENT <handle> <標題>
//   TAB_CLOSED <handle> <標題>
//   TAB_SKIP <handle> <原因>：self、coordinator、working、no-state、split-pane、already-sent <ISO>、not-idle <分>m、idle-unknown、
//     screen-busy、screen-no-prompt、screen-draft、screen-unreadable <錯誤>、retro-uncollected <DONE|PENDING> <session8>、roster-failed、shared-tab <handle,…>
//   TAB_FAILED <handle> <retro-send|close> <原因>（沒記入 sent，下個 tick 再試）
//   TAB_SWEEP_FAILED <原因>（no-orca、terminal-list、roster、coordinator-unknown；exit 0。state <錯誤>：tab-sweep.json 寫不進去，印在 SUMMARY 前；
//     sessions <錯誤>：sessions.md 讀不到，不動任何分頁，其後印全為 0 的 SUMMARY，#660）
//   TAB_SWEEP_OFF（tab-sweep.json 的 "enabled": false：用量吃緊時人暫停，每個 /retro 都花用量；不呼叫 Orca）
//   SUMMARY sent=<n> closed=<n> skipped=<n> failed=<n> other=<其他 worktree 分頁數>
//   TAB_RECORD_FAILED <exit> <stderr 首行>（有一列沒記進 decisions.md；印在最後、exit 1，其他行照印，#646）
// 寫入（--dry-run 都不寫，動作行尾加 ` dry-run`）：
//   `.scratch/pilot/decisions.md`（同目錄 pilot-decision.mjs）：TAB_RETRO_SENT、TAB_CLOSED、TAB_FAILED、TAB_SWEEP_FAILED、TAB_SWEEP_OFF 各一列，
//     每輪最後的 SUMMARY 也記一列（全是 TAB_SKIP 時也記：看守靠它分得出「跑了但沒事」與「沒跑」，#646）；
//     看不清楚而跳過的（UNCLEAR：idle-unknown、screen-unreadable、screen-no-prompt、roster-failed）也記一列，同一 handle 同一原因只記一次（noted）。
//   `.scratch/pilot/tab-sweep.json`：`{ "enabled": true|false, "sent": { "<handle>": { "at", "title" } }, "noted": { "<handle>": "<原因>" } }`；
//     不存在時當作 enabled；已不在 terminal list 的 handle 從 sent、noted 移除。
// 環境變數：ORCA_CLI_COMMAND（沒有時 TAB_SWEEP_FAILED no-orca）、ORCA_TERMINAL_HANDLE（自己）、TAB_SWEEP_NOW（ISO，測試固定現在時刻）。
// exit：0 完成（含只記錄的失敗）；1 有一列沒記進 decisions.md（TAB_RECORD_FAILED）；2 用法錯誤。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { orca as orcaCall } from './orca-session-send.mjs';
import { recordedTitle, tabTitleOf } from './tab-state.mjs';

export const IDLE_MS = 10 * 60_000;
/**
 * 工作中的 spinner 行（與 orca-session-send.mjs 的 SPINNER 同式）。自己帶一份：採用的 repo 可能以本地版 orca-session-send.mjs 為例外
 * （spay2 的本地版沒有匯出 SPINNER），本腳本只向它要 `orca({ cli, signal }, ...args)`。
 */
const SPINNER = /^\s*[·✢✳✶✻✽*]\s+\S[^…]*…\s*\((?:\d|esc\b)/u;
export const STATE_FILE = '.scratch/pilot/tab-sweep.json';
export const UNCLEAR = ['idle-unknown', 'screen-unreadable', 'screen-no-prompt', 'roster-failed'];
const RETRO = '待 Retro｜';
const CLOSE = '待關閉｜';
const STATE_PREFIX = /^(?:處理中|待 Retro|待關閉)｜/;
const SCREEN_LINES = 40;
const ORCA_MS = 15_000;
const USAGE = '用法：node scripts/tab-sweep.mjs <主 checkout> [--roster <指令>] [--dry-run]';

const norm = path => String(path ?? '').replaceAll('\\', '/').replace(/\/+$/, '');

/** worktreePath 是不是主 checkout：同一路徑，或 WSL 的 UNC 寫法 `//wsl.localhost/<distro>/<主 checkout>`。 */
export function inMain(worktreePath, main) {
  const path = norm(worktreePath);
  const root = norm(main);
  if (!path || !root) return false;
  return path === root || (path.endsWith(root) && /^\/\/[^/]+\/[^/]+$/.test(path.slice(0, -root.length)));
}

/** sessions.md 最後一個 `→ terminal <handle>`（現任 coordinator）；沒有時 null。 */
export function coordinatorHandle(sessions) {
  return [...String(sessions ?? '').matchAll(/→ terminal (\S+)/g)].at(-1)?.[1] ?? null;
}

/** roster 輸出 → [{ state, session, handle }]（只取 DONE／PENDING／COLLECTED 列）。 */
export function rosterRows(output) {
  return String(output ?? '').split('\n').map(line => line.trim().split(/\s+/))
    .filter(words => ['DONE', 'PENDING', 'COLLECTED'].includes(words[0]))
    .map(([state, session = '', handle]) => ({ state, session, handle: !handle || handle === '-' ? null : handle }));
}

/**
 * 畫面閒置判斷：工作中（`esc to interrupt`、spinner、`…ing…`）→ busy；有未送出的 draft → draft；
 * 沒有一行空的 `❯` 提示列 → no-prompt（看不清楚）；都不是 → null（閒置）。
 */
export function screenBusy(tail, draft = '') {
  const lines = (Array.isArray(tail) ? tail : [tail ?? '']).flatMap(line => String(line).split('\n'));
  if (lines.some(line => line.includes('esc to interrupt') || SPINNER.test(line) || /\b\w+ing\b.*…/u.test(line))) return 'screen-busy';
  if (String(draft ?? '').trim()) return 'screen-draft';
  if (!lines.some(line => /^[\s│]*❯[\s │]*$/u.test(line))) return 'screen-no-prompt';
  return null;
}

/**
 * 已收完的收集者 handle（#649）：`.scratch/retro/collector`（`<ISO 時刻> <handle>`）的啟動時刻之後，reports/ 有 mtime ≥ 該時刻的檔，
 * 或 triggers.log 有 time ≥ 該時刻的 collect 行；否則 null。與 pilot-retro-due.mjs 的 collectedSince 同一條規則，自己帶一份理由同 SPINNER。
 */
export function collectedCollector(main) {
  const retro = join(main, '.scratch/retro');
  const [at, handle] = (existsSync(join(retro, 'collector')) ? readFileSync(join(retro, 'collector'), 'utf8') : '').trim().split(/\s+/);
  const since = Date.parse(at);
  if (!handle || !Number.isFinite(since)) return null;
  const reports = join(retro, 'reports');
  if (existsSync(reports) && readdirSync(reports).some(name => statSync(join(reports, name)).mtimeMs >= since)) return handle;
  const log = existsSync(join(retro, 'triggers.log')) ? readFileSync(join(retro, 'triggers.log'), 'utf8') : '';
  return log.split('\n').some(line => {
    try { const record = JSON.parse(line); return record.event === 'collect' && Date.parse(record.time) >= since; } catch { return false; }
  }) ? handle : null;
}

/** pane 樹（first 先於 second）的第一個 terminal handle。 */
const firstPane = node => node === null || typeof node !== 'object' ? null
  : typeof node.handle === 'string' ? node.handle : firstPane(node.first) ?? firstPane(node.second);

/** 含 handle 這個 pane 的分頁（有 panes 的那一層）。 */
function tabOf(node, handle) {
  if (Array.isArray(node)) return node.map(item => tabOf(item, handle)).find(tab => tab) ?? null;
  if (node === null || typeof node !== 'object') return null;
  if (node.panes && JSON.stringify(node.panes).includes(JSON.stringify(handle))) return node;
  return tabOf(Object.values(node), handle);
}

/** 分頁擁有者（第一個 pane）；讀不到時 null，當作擁有者。 */
export const ownerOf = (layouts, handle) => firstPane(tabOf(layouts, handle)?.panes);

/**
 * 不讀畫面的判斷（純函式）：每個主 checkout 分頁回 skip，或候選動作 retro／close（之後還要過畫面與 roster）。
 * @returns {{ actions: {kind: 'retro'|'close'|'skip', handle: string, title?: string, reason?: string, terminal: object}[], other: number }}
 */
export function sweepPlan({ terminals, main, self = null, coordinator = null, titleOf, ownerOf: owner = () => null, sent, now, collected = null }) {
  const mine = terminals.filter(t => inMain(t.worktreePath, main));
  const actions = mine.map(terminal => {
    const { handle } = terminal;
    const skip = reason => ({ kind: 'skip', handle, reason, terminal });
    if (handle === self) return skip('self');
    if (handle === coordinator) return skip('coordinator');
    const title = titleOf(handle) ?? '';
    const retro = title.startsWith(RETRO);
    const done = handle === collected && title.startsWith('處理中｜');
    if (!retro && !done && !title.startsWith(CLOSE)) return skip(STATE_PREFIX.test(title) ? 'working' : 'no-state');
    const first = owner(handle);
    if (first && first !== handle) return skip('split-pane');
    if (retro && sent[handle]) return skip(`already-sent ${sent[handle].at}`);
    if (!Number.isFinite(terminal.lastOutputAt)) return skip('idle-unknown');
    const idle = now - terminal.lastOutputAt;
    if (idle < IDLE_MS) return skip(`not-idle ${Math.floor(idle / 60_000)}m`);
    return { kind: retro ? 'retro' : 'close', handle, title, terminal };
  });
  return { actions, other: terminals.length - mine.length };
}

/** tab-sweep.json → { enabled, sent, noted }；不存在或壞掉時 enabled、空表。 */
export function readState(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const table = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    return { ...data, enabled: data.enabled !== false, sent: table(data.sent), noted: table(data.noted) };
  } catch {
    return { enabled: true, sent: {}, noted: {} };
  }
}

/**
 * 整支流程；Orca（async）、roster、decisions 寫入都可注入，測試不碰真的 terminal。
 * @param {{ main: string, orca: (...args: string[]) => Promise<any>, roster?: (() => string) | null, record?: (line: string, reason: string) => void,
 *   self?: string|null, now: number, dryRun?: boolean, log?: (line: string) => void, recorded?: (handle: string) => string|null }} ctx
 */
export async function sweep({ main, orca, roster = null, record = () => {}, self = null, now, dryRun = false, log = () => {}, recorded = () => null }) {
  const lines = [];
  const emit = (line, reason) => {
    const out = dryRun && /^TAB_(RETRO_SENT|CLOSED)/.test(line) ? `${line} dry-run` : line;
    lines.push(out);
    log(out);
    if (reason && !dryRun) record(out, reason);
  };
  const statePath = join(main, STATE_FILE);
  const state = readState(statePath);
  if (!state.enabled) {
    emit('TAB_SWEEP_OFF', '人暫停了 Tab sweep（tab-sweep.json 的 enabled false）；記一列讓看守分得出暫停與沒跑');
    return { lines, state };
  }
  let list;
  try {
    list = await orca('terminal', 'list', '--include-visual-layouts');
  } catch (error) {
    emit(`TAB_SWEEP_FAILED terminal-list ${firstLine(error)}`, '讀不到 terminal list，這輪不動任何分頁');
    return { lines, state };
  }
  const terminals = list?.terminals ?? [];
  const sessionsPath = join(main, '.scratch/pilot/sessions.md');
  let coordinator;
  try {
    coordinator = coordinatorHandle(existsSync(sessionsPath) ? readFileSync(sessionsPath, 'utf8') : '');
  } catch (error) {
    // 比照 state 檔：不拋錯，印失敗再印 SUMMARY，看守才分得出跑了與沒跑（#660）；認不出 coordinator，這輪不動任何分頁
    emit(`TAB_SWEEP_FAILED sessions ${firstLine(error)}`, 'sessions.md 讀不到，認不出現任 coordinator，這輪不動任何分頁');
    emit('SUMMARY sent=0 closed=0 skipped=0 failed=0 other=0', '每輪都記一列，看守分得出跑了但沒事與沒跑（#646）');
    return { lines, state };
  }
  if (!self && !coordinator) {
    emit('TAB_SWEEP_FAILED coordinator-unknown', '認不出現任 coordinator（沒有 ORCA_TERMINAL_HANDLE，sessions.md 也沒有交接行），這輪不動任何分頁');
    return { lines, state };
  }
  const titleOf = handle => tabTitleOf(list.visualLayouts, handle) ?? recorded(handle);
  const { actions, other } = sweepPlan({
    terminals, main, self, coordinator, sent: state.sent, now, titleOf, ownerOf: handle => ownerOf(list.visualLayouts, handle),
    collected: collectedCollector(main),
  });
  let rows;
  const rosterOnce = () => {
    if (rows !== undefined) return rows;
    if (!roster) return (rows = []);
    try {
      rows = rosterRows(roster());
    } catch (error) {
      rows = null;
      emit(`TAB_SWEEP_FAILED roster ${firstLine(error)}`, 'roster 讀不到，這輪不關待關閉分頁');
    }
    return rows;
  };
  const counts = { sent: 0, closed: 0, skipped: 0, failed: 0 };
  const noted = {};
  const skip = (handle, reason) => {
    counts.skipped++;
    const key = reason.split(' ')[0];
    if (UNCLEAR.includes(key)) {
      noted[handle] = key;
      emit(`TAB_SKIP ${handle} ${reason}`, state.noted[handle] === key ? null : '看不清楚就跳過；同一分頁同一原因只記一次');
    } else emit(`TAB_SKIP ${handle} ${reason}`);
  };
  for (const action of actions) {
    const { handle } = action;
    if (action.kind === 'skip') { skip(handle, action.reason); continue; }
    let screen;
    try {
      screen = (await orca('terminal', 'read', '--terminal', handle, '--screen'))?.terminal;
    } catch (error) {
      skip(handle, `screen-unreadable ${firstLine(error)}`);
      continue;
    }
    const busy = screenBusy((screen?.tail ?? []).slice(-SCREEN_LINES), screen?.draft);
    if (busy) { skip(handle, busy); continue; }
    if (action.kind === 'close') {
      const roster = rosterOnce();
      if (roster === null) { skip(handle, 'roster-failed'); continue; }
      const open = roster.find(row => row.handle === handle && row.state !== 'COLLECTED');
      if (open) { skip(handle, `retro-uncollected ${open.state} ${open.session.slice(0, 8)}`); continue; }
      const shared = terminals.filter(o => o.handle !== handle && o.tabId != null && o.tabId === action.terminal.tabId).map(o => o.handle);
      if (shared.length) { skip(handle, `shared-tab ${shared.join(',')}`); continue; }
    }
    const step = action.kind === 'retro' ? 'retro-send' : 'close';
    try {
      if (action.kind === 'retro') {
        if (!dryRun) {
          await orca('terminal', 'send', '--terminal', handle, '--text', '/retro', '--enter');
          state.sent[handle] = { at: new Date(now).toISOString(), title: action.title };
        }
        counts.sent++;
        emit(`TAB_RETRO_SENT ${handle} ${action.title}`, '待 Retro 分頁閒置 ≥10 分鐘、畫面閒置、未送過');
      } else {
        if (!dryRun) await orca('terminal', 'close', '--terminal', handle, '--tab');
        delete state.sent[handle];
        counts.closed++;
        emit(`TAB_CLOSED ${handle} ${action.title}`, '待關閉分頁閒置 ≥10 分鐘、畫面閒置、retro 已收或沒有 roster');
      }
    } catch (error) {
      counts.failed++;
      emit(`TAB_FAILED ${handle} ${step} ${firstLine(error)}`, '失敗只記錄，不開 gate；下個 tick 再試');
    }
  }
  const open = new Set(terminals.map(t => t.handle));
  for (const handle of Object.keys(state.sent)) if (!open.has(handle)) delete state.sent[handle];
  state.noted = noted;
  if (!dryRun) {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify({ ...state, enabled: true }, null, 2)}\n`);
    } catch (error) {
      // 不拋錯：SUMMARY 仍要印、記（#646 review）；sent 沒存下，下個 tick 可能對同一分頁再送一次 /retro
      emit(`TAB_SWEEP_FAILED state ${firstLine(error)}`, 'tab-sweep.json 寫不進去，這輪的 sent 沒存下');
    }
  }
  emit(`SUMMARY sent=${counts.sent} closed=${counts.closed} skipped=${counts.skipped} failed=${counts.failed} other=${other}`,
    '每輪都記一列（全是 TAB_SKIP 也記），看守分得出跑了但沒事與沒跑（#646）');
  return { lines, state };
}

const firstLine = error => String(error?.message ?? error).split('\n')[0].replaceAll('|', '/');

/**
 * 同目錄 pilot-decision.mjs 在主 checkout 的 decisions.md 記一列；失敗時 stderr 說明、不中斷，
 * 回傳 `<exit> <stderr 首行>` 給 CLI 在最後印 TAB_RECORD_FAILED（#646 review：只寫 stderr，看守會把漏記當成沒跑）。
 */
function recordDecision(main, line, reason) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'pilot-decision.mjs');
  if (!existsSync(script)) { console.error(`decisions.md 沒記到（no-pilot-decision）：${line}`); return 'missing no-pilot-decision'; }
  const clean = text => String(text).replaceAll('|', '/').replace(/\s*\n\s*/g, ' ');
  const run = spawnSync(process.execPath, [script, main, '--decision', clean(`Tab sweep：${line}`), '--reason', clean(reason),
    '--evidence', 'scripts/tab-sweep.mjs', '--result', '—'], { encoding: 'utf8' });
  if (run.status === 0) return null;
  console.error(`decisions.md 沒記到（pilot-decision exit ${run.status}）：${line}`);
  const detail = String(run.stderr || run.error?.message || '').trim().split('\n')[0].trim() || 'no-stderr';
  return `${run.status ?? run.signal} ${detail}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const rest = args.filter(arg => arg !== '--dry-run');
  const rosterAt = rest.indexOf('--roster');
  const rosterCommand = rosterAt >= 0 ? rest[rosterAt + 1] : null;
  if (rosterAt >= 0) rest.splice(rosterAt, 2);
  if (rest.length !== 1 || rest[0].startsWith('--') || (rosterAt >= 0 && !rosterCommand?.trim())) {
    console.error(USAGE);
    process.exit(2);
  }
  const main = resolve(rest[0]);
  const cli = process.env.ORCA_CLI_COMMAND;
  const now = process.env.TAB_SWEEP_NOW ? Date.parse(process.env.TAB_SWEEP_NOW) : Date.now();
  let recordFailed = null;
  const record = (line, reason) => { const failed = recordDecision(main, line, reason); recordFailed ??= failed; };
  // 不用 process.exit：stdout 接管線時會截掉還沒寫完的 SUMMARY 與 TAB_RECORD_FAILED（#646 review）。
  const finish = () => {
    if (!recordFailed) return;
    console.log(`TAB_RECORD_FAILED ${recordFailed}`);
    process.exitCode = 1;
  };
  if (!cli) {
    console.log('TAB_SWEEP_FAILED no-orca');
    if (!dryRun) record('TAB_SWEEP_FAILED no-orca', '沒有 ORCA_CLI_COMMAND，這輪不動任何分頁');
    finish();
  } else {
    const roster = rosterCommand ? () => {
      const run = spawnSync('sh', ['-c', rosterCommand], { cwd: main, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
      if (run.status !== 0) throw new Error(`exit ${run.status ?? run.signal}：${(run.stderr || run.stdout || '').trim().split('\n').at(-1) ?? ''}`);
      return run.stdout;
    } : null;
    try {
      await sweep({
        main, roster, record, now, dryRun, self: process.env.ORCA_TERMINAL_HANDLE || null,
        orca: (...rest) => orcaCall({ cli, signal: AbortSignal.timeout(ORCA_MS) }, ...rest),
        recorded: recordedTitle, log: line => console.log(line),
      });
    } finally {
      finish(); // sweep 意外拋錯時，先前漏記的列也要報
    }
  }
}
