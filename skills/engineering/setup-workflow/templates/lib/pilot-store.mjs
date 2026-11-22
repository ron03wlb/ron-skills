// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// pilot 存檔（issue-pilot 的 PILOT-STORE.md）正本 script 共用的小工具：存檔目錄、時間格式、用法錯誤，requests.md、gates.md 的解析（probe 與 pilot-request、pilot-gate 共用），以及 checkpoint 讀改寫的加鎖與原子寫入（withCheckpointLock、updateCheckpoint，#345）與 land 存活標記（regressingMark、landAlive，#361）。
// 存檔一律在 coordinator checkout 的 `.scratch/pilot/`；checkout 由呼叫者傳入，不寫死任何專案路徑。
import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Push gate 的入口轉交：從主 checkout 的 `scripts/<x>.mjs` 跑時，改跑 stage worktree（分支是整合分支或 pilot/stage-*）的同名腳本，以它的 exit code 結束。
 * stage worktree 停在整合分支，就是要推的內容，推的 batch 改了這支腳本時 main 上的舊版會誤判（#239）；coordinator 不必自己從 porcelain 算路徑（#275：每任都手算，
 * awk 只比 pilot/integration 時，停在 pilot/stage-* 會撈空）。不是主 checkout 的副本（已在 stage worktree、正本、測試）、沒有 stage worktree、或那邊沒有這支腳本時直接返回，照常跑本檔。
 * @param {string} scriptUrl 呼叫端的 import.meta.url
 * @param {string[]} args 原樣轉交的參數
 * @param {{integration?: string}} [options] 整合分支名稱
 */
export function runInStageWorktree(scriptUrl, args, { integration = 'pilot/integration' } = {}) {
  const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (list.status !== 0) return;
  const trees = list.stdout.split(/\n\n+/).map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] })).filter(({ path }) => path);
  const self = realpathSync(fileURLToPath(scriptUrl));
  const main = trees[0]?.path;
  if (!main || !existsSync(main) || self !== join(realpathSync(main), 'scripts', basename(self))) return;
  const stage = trees.slice(1).find(({ path, branch }) => existsSync(path) && (branch === integration || branch?.startsWith('pilot/stage-')));
  const target = stage && join(stage.path, 'scripts', basename(self));
  if (!target || !existsSync(target)) return;
  process.exit(spawnSync(process.execPath, [target, ...args], { stdio: 'inherit' }).status ?? 1);
}

export const storeDir = checkout => join(resolve(checkout), '.scratch/pilot');

/** checkpoint 鎖的預設逾時（毫秒）；`PILOT_STORE_LOCK_TIMEOUT_MS` 可改。 */
export const CHECKPOINT_LOCK_TIMEOUT_MS = 10000;
/** 鎖檔讀不出 pid（剛建還沒寫入、或損壞）時，超過這麼久才當成殘留鎖。 */
const EMPTY_LOCK_MS = 2000;
const heldLocks = new Set();
let exitHook = false;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** 等到逾時還拿不到鎖：`message` 是 `CHECKPOINT_LOCKED <lock> <持鎖內容>`。 */
export class CheckpointLocked extends Error {}

function lockHolder(lock) {
  try {
    const raw = readFileSync(lock, 'utf8');
    return { raw, mtime: statSync(lock).mtimeMs, pid: Number(/^pid=(\d+)/.exec(raw)?.[1]) || null };
  } catch { return null; } // 剛被釋放
}

/** 殘留鎖先改名搬開再刪：兩個等待者同時判定殘留時只有一個搬得到；搬到的已是別人剛建的新鎖（內容不同）就放回去。 */
function breakLock(lock, holder) {
  const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
  try { renameSync(lock, aside); } catch { return; }
  let raw = null;
  try { raw = readFileSync(aside, 'utf8'); } catch { /* 讀不到就當不同 */ }
  if (raw !== holder.raw) { try { linkSync(aside, lock); } catch { /* 原位已有新鎖 */ } }
  rmSync(aside, { force: true });
}

/**
 * 持有 `files` 每個檔的 `<file>.lock` 執行 action（#345，PILOT-STORE.md 的 Checkpoint lock）：依路徑排序逐一以 O_EXCL 建立，內容 `pid=<pid> at=<ISO> <script>`。
 * 占用中每 20–50 ms 重試；持鎖 pid 已不存在、或讀不出 pid 且超過 2 秒時搬開重搶，pid 還活著就不論鎖齡一直等，到逾時 throw CheckpointLocked。
 * 同一程序重入已持有的鎖直接執行；action 中 process.exit 時由 exit hook 放鎖。
 */
export function withCheckpointLock(files, action, { timeout = Number(process.env.PILOT_STORE_LOCK_TIMEOUT_MS) || CHECKPOINT_LOCK_TIMEOUT_MS } = {}) {
  const locks = [...new Set((Array.isArray(files) ? files : [files]).map(file => `${resolve(file)}.lock`))].sort().filter(lock => !heldLocks.has(lock));
  const taken = [];
  try {
    for (const lock of locks) {
      for (const deadline = Date.now() + timeout; ;) {
        try {
          const fd = openSync(lock, 'wx');
          try { writeSync(fd, `pid=${process.pid} at=${new Date().toISOString()} ${basename(process.argv[1] ?? 'node')}\n`); } finally { closeSync(fd); }
          break;
        } catch (error) {
          // 存檔目錄還沒建（第一次寫 coordinator、或 batch 檔不存在而要印 STOP missing）：建了再搶。
          if (error.code === 'ENOENT') { mkdirSync(dirname(lock), { recursive: true }); continue; }
          if (error.code !== 'EEXIST') throw error;
        }
        const holder = lockHolder(lock);
        if (!holder) continue;
        if (holder.pid ? !pidAlive(holder.pid) : Date.now() - holder.mtime > EMPTY_LOCK_MS) { breakLock(lock, holder); continue; }
        if (Date.now() > deadline) throw new CheckpointLocked(`CHECKPOINT_LOCKED ${lock} ${holder.raw.trim()}`);
        pause(20 + Math.floor(Math.random() * 30));
      }
      taken.push(lock);
      heldLocks.add(lock);
    }
    if (taken.length && !exitHook) {
      exitHook = true;
      process.on('exit', () => { for (const held of heldLocks) rmSync(held, { force: true }); });
    }
    return action();
  } finally {
    for (const lock of taken) { heldLocks.delete(lock); rmSync(lock, { force: true }); }
  }
}

/**
 * 寫 `<file>.tmp-<pid>` 再改名：不加鎖的讀者（probe 不帶 --apply、status）不會讀到半份檔。
 * 原檔不可寫時照直接寫入一樣丟 EACCES（改名會繞過唯讀，pilot-land 的 sync-main 靠這個錯誤印 STOP checkpoint）。
 */
export function writeCheckpoint(file, text) {
  if (existsSync(file)) accessSync(file, constants.W_OK);
  const temp = `${resolve(file)}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** 帶鎖的讀改寫：鎖內重讀 file，edit(目前內容) 傳回新內容（不是字串或內容相同時不寫）；傳回寫後（或沒改）的內容。 */
export function updateCheckpoint(file, edit, options) {
  return withCheckpointLock(file, () => {
    const before = readFileSync(file, 'utf8');
    const after = edit(before);
    if (typeof after !== 'string') return before;
    if (after !== before) writeCheckpoint(file, after);
    return after;
  }, options);
}

/**
 * batch checkpoint 的 land 存活標記（#361）：pilot-land 寫 `current: staged` 時同一次寫入留 `regressing: <staged sha> pid <pid>`，
 * 追加 regression 行時同一次寫入拿掉。傳回最後一個標記 `{ sha, pid }`，沒有時 undefined。
 */
export function regressingMark(text) {
  const match = [...text.matchAll(/^regressing:[ \t]*([0-9a-f]{7,40}) pid (\d+)\b/gm)].at(-1);
  return match && { sha: match[1], pid: Number(match[2]) };
}

/** 拿掉 regressing 標記行（追加 regression 行、重新 stage 時用）。 */
export const dropRegressing = text => text.replace(/^regressing:.*\n?/gm, '');

/**
 * 標記的 pid 還是一支 pilot-land：行程在（kill 0 成功或 EPERM），而且 `ps` 印的命令列含 `pilot-land`
 * （land 被 kill -9、重開機之後 pid 可能被別的行程重用，只看 pid 會一直印 REGRESSING）。ps 跑不起來時只看 kill 0。
 */
export function landAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (ps.error) return true;
  return ps.status === 0 && ps.stdout.includes('pilot-land');
}

/** CLI 的頂層 catch：CheckpointLocked 印它的訊息並 exit 3（可動手：等持鎖者結束後重跑同一條指令，鎖住的那個檔沒寫）；其他錯誤直接返回，由呼叫端照原本的方式處理。 */
export function exitIfLocked(error) {
  if (!(error instanceof CheckpointLocked)) return;
  console.log(error.message);
  process.exit(3);
}

/** 帶本地時差的 ISO 8601，與 `date -Iseconds` 同形（2026-10-30T21:12:24+08:00）。 */
export function now(date = new Date()) {
  const pad = n => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${pad(offset / 60)}:${pad(offset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
}

export function usage(text, message) {
  console.error(message ? `${message}\n${text}` : text);
  process.exit(2);
}

/** 欄位值不能含三個連續空白或換行（行格式以三個空白分欄）。 */
export const isField = value => typeof value === 'string' && value.trim() !== '' && !/ {3}|\n/.test(value);

/**
 * requests.md 的一行是不是還開著的 request：不是空行或 `#` 標題，而且最後一個 ` source ` 之後沒有 ` applied <字>`／` declined <字>`
 * （request 內文提到這兩個字或 source 都不算）。新格式以三個空白分欄，舊格式兩個空白，都接受。
 */
export const isOpenRequest = line => Boolean(line.trim()) && !line.startsWith('#')
  && !/\s(?:applied|declined)\s+\S/.test(line.split(/\ssource\s/).slice(1).at(-1) ?? '');

/** Markdown 表格一列的各欄（去掉首尾的 `|` 與空白）；不是表格列時回空陣列。 */
export const tableCells = line => line.split('|').slice(1, -1).map(cell => cell.trim());

const isMemberRow = line => tableCells(line).length >= 8 && /^\d+$/.test(tableCells(line)[0]);

/**
 * batch checkpoint 的行陣列裡成員全是 `moved …` 時，把 `current:` 就地寫成 `closed moved`；傳回這次是否改了。
 * pilot-batch 的 move／park 與 pilot-dispatch 的 --fresh 共用（#205：--fresh 搬走全部成員的舊 batch 留在 dispatched，status.md 一直列成開著）。
 */
export function closeIfAllMoved(lines) {
  const members = lines.filter(isMemberRow);
  if (!members.length || !members.every(line => /^moved\b/.test(tableCells(line)[6]))) return false;
  const i = lines.findIndex(line => /^current:/.test(line));
  if (i < 0 || /^current:\s*closed moved$/.test(lines[i])) return false;
  lines[i] = 'current: closed moved';
  return true;
}
/** gates.md 的每個 `## G<n>` 段落：id、標題行（不含 `## `）、內文、段落在檔案中的起訖位置（訖點是下一個 `## ` 或檔尾）。 */
export const gateSections = text => [...text.matchAll(/^## (G\d+\b.*)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)]
  .map(match => ({ id: match[1].match(/^G\d+/)[0], title: match[1].trim(), body: match[2], start: match.index, end: match.index + match[0].length }));
/** 表格形式的 gate 列（第一欄是 `G<n>`）的各欄；不是時回 undefined。 */
export const gateRow = line => (/^G\d+$/.test(tableCells(line)[0] ?? '') ? tableCells(line) : undefined);
/** 表格 gate 列的 status 欄（最後一欄）以 `resolved` 開頭。 */
export const isResolvedRow = cells => /^resolved\b/.test(cells.at(-1));
/** `## G<n>` 段落內文有 `- resolved …` 那一行（寫進別的欄位的 resolved 不算）。 */
export const isResolvedSection = body => /^- (?:G\d+ )?resolved\b/m.test(body);

/**
 * gates.md 還開著的 gate：表格 status 欄不以 `resolved` 開頭的列，或 `## G<n>` 段落裡沒有 `resolved` 那一行的 gate。
 * 每個 `{ line, id, issue, title, parked, opened, malformed }`：`line` 是 GATE 行去掉前綴的內容；表格列的 title 是 question 欄，段落的是標題去掉 id；
 * `parked` 是表格的 parks 欄或段落的 `- parked：` 那一行；`hold` 是段落 `- hold：#<n>` 的號碼（pilot-gate open --hold，#367），沒有時空字串（表格列沒有這欄）。
 */
export function openGates(text) {
  const gates = [];
  for (const cells of text.split('\n').map(gateRow)) {
    if (cells && !isResolvedRow(cells)) {
      gates.push({ line: `${cells[0]} ${cells[1]} ${cells[2]}`, id: cells[0], issue: cells[1], title: cells[2], parked: cells[5] ?? '', opened: cells[6] ?? '', hold: '' });
    }
  }
  for (const { id, title, body } of gateSections(text)) {
    if (isResolvedSection(body)) continue;
    // resolved 寫進別的欄位（`- status：resolved …`）不算解除；指出那一行（retro a6）。
    const malformed = body.match(/^- [^：:\n]+[：:]\s*resolved\s+\d{4}-\d\d-\d\dT.*$/m)?.[0].trim();
    const field = name => body.match(new RegExp(`^- ${name}[：:]\\s*(.*)$`, 'm'))?.[1].trim() ?? '';
    gates.push({ line: title, id, issue: field('Issue').match(/#\d+/)?.[0] ?? '', title: title.slice(id.length).trim(), parked: field('parked'), opened: field('opened'), hold: field('hold').match(/^#(\d+)$/)?.[1] ?? '', malformed });
  }
  return gates;
}

/**
 * 開著的 gate hold 住的 Issue（#367）：號碼字串 → 第一個 hold 它的 gate id（照 openGates 的順序）。
 * pilot-probe 對其中 done 的 batch 成員印 `HELD <n> G<k>`、不印 STAGEABLE；pilot-land 對其中的 done 成員 `STOP held <n> G<k>`。
 */
export function heldIssues(gates) {
  const held = new Map();
  for (const gate of gates) if (gate.hold && !held.has(gate.hold)) held.set(gate.hold, gate.id);
  return held;
}

/** gate 的 parked 以固定寫法 `all-push` 開頭：擋住所有 push（例如 GitHub Actions 帳務），probe 把沒進主分支的 batch 合成一行 PUSH_PARKED（#136）。 */
export const parksAllPush = gate => /^all-push(?![\w-])/.test(gate.parked);

/**
 * gates.md 裡有 gate 指向的 Issue 號碼字串（不分開著或已 resolved；#406）：表格列的 Issue 欄、`## G<n>` 段落的 `- Issue：` 那一行裡的每個 `#<n>`。
 * pilot-land 的 operator-questions 關卡用它判斷成員的 `[confirm]` ruling 有沒有開過 gate。
 */
export function gateIssues(text) {
  const issues = new Set();
  const add = cell => { for (const [, n] of String(cell).matchAll(/#(\d+)/g)) issues.add(n); };
  for (const cells of text.split('\n').map(gateRow)) if (cells) add(cells[1]);
  for (const { body } of gateSections(text)) add(body.match(/^- Issue[：:]\s*(.*)$/m)?.[1] ?? '');
  return issues;
}

/** sessions.md 裡當過 coordinator 的 session id（start 行與舊格式 start 行，PILOT-STORE.md；#466）。 */
export function coordinatorSessions(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    const id = line.match(/^\S+ {3}session (\S+) {3}pid \d+\b/)?.[1] ?? line.match(/^\S+ {2}(\S+) {2}.* {2}coordinator start\s*$/)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * 別人代為 resolve、答案還沒套用的 gate（#466 第 3 項，investing G80）：`## G<n>` 段落有 `- by：<session>`（pilot-gate open 記的開啟者）而那是
 * sessions.md 的 coordinator session、已 resolved、沒有 `- applied` 行，而且 `- resolver：<session>` 不在或不是任何 coordinator session 時，
 * 每個印 `GATE_RESOLVED G<n> by <resolver|?> <how>`（how 是 resolved 行時間之後的文字）。coordinator 自己 resolve 的當場套用，不印；表格列沒有這些欄，不印。
 */
export function resolvedGateLines(text, sessions) {
  const coordinators = coordinatorSessions(sessions);
  return gateSections(text).flatMap(({ id, body }) => {
    const field = name => body.match(new RegExp(`^- ${name}[：:]\\s*(\\S+)`, 'm'))?.[1];
    const resolved = body.match(/^- (?:G\d+ )?resolved \S+(?: (.*))?$/m);
    const by = field('by');
    if (!resolved || !by || !coordinators.has(by) || /^- applied\b/m.test(body)) return [];
    const resolver = field('resolver');
    if (resolver && coordinators.has(resolver)) return [];
    return [`GATE_RESOLVED ${id} by ${resolver ?? '?'} ${resolved[1] ?? ''}`.trimEnd()];
  });
}

/** pilot-probe 與 pilot-gate list 印的 gate 行：每個開著的 gate 一行 `GATE <line>`，resolved 寫錯欄位的再加 `GATE_MALFORMED <id> <那一行>`。 */
export const gateLines = text => openGates(text)
  .flatMap(gate => [`GATE ${gate.line}`, ...(gate.malformed ? [`GATE_MALFORMED ${gate.id} ${gate.malformed}`] : [])]);
