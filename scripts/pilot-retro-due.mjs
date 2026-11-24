#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本（CoS item 41，owner 2026-11-20 核准）：未收集的 retro 達 N 則（預設 5），或最舊一則已滿 H 小時（預設 8，至少 1 則）時，
// issue-pilot coordinator 在安全點（一個 tick 的 Drain 與 Project tick hooks 之後、Pick 之前）開一個分頁跑 `/retro-collect`。
// 舊規則「retro-candidates 累積 ≥3（POOL_EMPTY 時 ≥1）」只寫在 issue-pilot SKILL 的 prose，沒有 script，ron-skills 的 adapter 也沒有 Retro trigger 條目，從沒觸發過。
//
// 用法：node scripts/pilot-retro-due.mjs <coordinator checkout> [--collect-in <checkout>] [--start]
//       node scripts/pilot-retro-due.mjs <Retro collect checkout> --log-collect <key> [--item <Issue 或名單項>=<結果>]...
//   <coordinator checkout>：`.scratch/pilot/` 與 adapter（工作樹的 docs/agents/issue-run.md 及其 Pilot 段連到、再連到的同目錄 .md）所在。
//   --collect-in：Retro collect 條目指定 `/retro-collect` 跑的 checkout（Roster command 在這裡跑、分頁在這裡開、紀錄寫在這裡），預設同上。
//   啟用：adapter 有 `- **Retro trigger.**` 條目；沒有時印 RETRO_OFF no-trigger-entry。門檻是同一批檔裡的宣告行 `Retro trigger: count=<n> age=<h>h`，
//     沒宣告時 count=5 age=8h；宣告了卻不是這個格式時 RETRO_FAILED bad-declaration。
//   未收集的 retro：
//     Retro collect 條目宣告了 `Roster command:`（ADR 0003 的 Declared roster）時，在 --collect-in 以 sh -c 跑它（反引號內的指令），
//       輸出裡第一個字在同一條目 `Roster due: <TOKEN>[,<TOKEN>…]` 列出的行各算一則（例如 spay2 的 `DONE`）；年齡取該行第一個 ISO 8601 時刻，
//       沒有時取該行第一個存在的檔案（絕對路徑或相對 --collect-in）的 mtime，都沒有時只計數、不算年齡。有 Roster command 卻沒有 Roster due 時 RETRO_FAILED roster-due-missing。
//     否則是開著的 `retro-candidates` Issue（tracker 照 docs/agents/issue-tracker.md：寫 glab 是 GitLab，其他用 gh，`--limit 1000`：gh 預設只回 30 張，
//       1123a 開著 42 張只看到 30 張），內文有 `From: retro-collect` 行的不算
//       （收集者自己的 retro，不讓一次收集觸發下一次），年齡取建立時間。
//   安全點：`.scratch/pilot/batch-*.md` 有 `current: staged …` 的 batch（stage 到整合分支合入之間，含 regression 在跑）時，到期也只印 RETRO_WAIT。
//   已有收集者：--collect-in 的 `.scratch/retro/collector`（`--start` 寫的 `<ISO 時刻> <handle>`）的 handle 還在 `orca terminal list`、標題是 `處理中｜` 開頭時，
//     到期也只印 RETRO_RUNNING；收集者跑完會把分頁換成待 Retro／待關閉，就不算在跑。讀不到 Orca（沒有 ORCA_CLI_COMMAND 或呼叫失敗）時當作沒有在跑。
//     手動開的收集者（沒經 --start、分頁標題沒有狀態前綴；CoS item 89：term_41eb9968「Retro-collect retro-candidates issues」收 20 張時這裡印了 RETRO_DUE）
//     由計畫檔認：--collect-in 的 `.scratch/retro/plan-<key>.md` 最近 4 小時內改過，而且還沒有 `reports/<日期>-<key>.md`、triggers.log 也沒有這個 key 的
//     collect 行（retro-collect 的 Close 兩者都寫，落地失敗也寫）時印 RETRO_RUNNING plan-<key>；超過 4 小時沒動的計畫檔當作中斷，不擋下一次。
// stdout（一律一行）：
//   RETRO_OFF no-trigger-entry
//   RETRO_IDLE <則數> oldest=<小時|-> threshold count=<n> age=<h>h
//   RETRO_DUE <則數> oldest=<小時|-> → node scripts/pilot-retro-due.mjs <coordinator checkout> [--collect-in <checkout>] --start
//   RETRO_WAIT staged <batch key> <則數> oldest=<小時|->（到期，但 land 中；下一個 tick 再看）
//   RETRO_RUNNING <handle> <則數> oldest=<小時|->（到期，但已有收集者在跑）
//   RETRO_FAILED <原因>（tracker 或 Roster command 失敗、宣告格式錯；exit 1）
//   --start：重新判斷，到期時開分頁（orca-session-split.mjs 的 openSession，新分頁、標題 `處理中｜retro-collect`，第一個 prompt `/retro-collect`），
//     寫 `.scratch/retro/collector`，印 RETRO_STARTED <handle>；沒到期時印上面那一行、不開；開分頁失敗印 RETRO_START_FAILED <原因>（exit 4）。
//     開成功時（CoS item 89：自動觸發沒接上卻沒人發現，要留證據）也在 --collect-in 的 `.scratch/retro/triggers.log`（JSONL）追加一行
//     `{"time","event":"start","trigger":"count"|"age"|"count+age","uncollected","oldestHours","handle","threshold":{"count","ageHours"}}`，
//     並以同目錄的 pilot-decision.mjs 在 coordinator checkout 的 decisions.md 記一列（沒有那支或它失敗時 stderr 說明，照樣印 RETRO_STARTED）。
//   --log-collect <key>：`/retro-collect` 結束時在 `.scratch/retro/triggers.log` 追加 `{"time","event":"collect","key","collected","items":[{"ref","result"}]}`，
//     collected 是 --item 的數量；印 `RETRO_LOGGED <key> <collected>`。
//   `<小時>` 取到小數一位。環境變數 RETRO_DUE_NOW（ISO 時刻）給測試固定現在時刻。
//   pilot-probe.mjs 每個 tick 以 evaluate() 印同一行（帶它已抓的 Issue，不再多跑一次 gh），coordinator 不必記得另外跑這一支。
// exit：0 印完；1 RETRO_FAILED；2 用法錯誤；4 RETRO_START_FAILED。
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trackerKind } from './lib/hosts.mjs';
import { orca } from './orca-session-send.mjs';
import { openSession } from './orca-session-split.mjs';
import { WORKING, recordedTitle, tabTitleOf } from './tab-state.mjs';

export const DEFAULT_COUNT = 5;
export const DEFAULT_AGE_HOURS = 8;
export const COLLECTOR_FILE = '.scratch/retro/collector';
export const TRIGGERS_LOG = '.scratch/retro/triggers.log';
export const TRACKER_LIMIT = 1000;
export const PLAN_FRESH_HOURS = 4;
const ADAPTER = 'docs/agents/issue-run.md';
const HOUR = 3_600_000;
const USAGE = '用法：node scripts/pilot-retro-due.mjs <coordinator checkout> [--collect-in <checkout>] [--start]｜<checkout> --log-collect <key> [--item <ref>=<result>]...';

/** adapter 檔：issue-run.md，加上它 Pilot 段連到的同目錄 .md，再加上那些檔連到的同目錄 .md（spay2 的 Retro collect 在第二層）。[{ file, content }] */
export function adapterTexts(root) {
  const read = file => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null);
  const top = read(ADAPTER);
  if (top === null) return [];
  const dir = ADAPTER.slice(0, ADAPTER.lastIndexOf('/') + 1);
  const links = text => [...text.matchAll(/\]\((?:\.\/)?([^)/#\s]+\.md)(?:#[^)\s]*)?\)/g)].map(m => `${dir}${m[1]}`);
  const pilot = top.match(/^## Pilot[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
  const seen = new Map([[ADAPTER, top]]);
  let frontier = links(pilot);
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    const next = [];
    for (const file of frontier) {
      if (seen.has(file)) continue;
      const content = read(file);
      if (content === null) continue;
      seen.set(file, content);
      next.push(...links(content));
    }
    frontier = next;
  }
  return [...seen].map(([file, content]) => ({ file, content }));
}

/** 條目 `- **<name>.**` 的本文（含縮排子行），各檔相符的都接起來；沒有時空字串。 */
export function entryText(texts, name) {
  const out = [];
  for (const { content } of texts) {
    let current = null;
    for (const line of content.split('\n')) {
      const head = line.match(/^- \*\*(.+?)\.?\*\*/);
      if (head) { current = head[1] === name ? [line] : null; if (current) out.push(current); continue; }
      if (current && /^\s+\S/.test(line)) current.push(line);
      else current = null;
    }
  }
  return out.map(lines => lines.join('\n')).join('\n');
}

/** 門檻：`Retro trigger: count=<n> age=<h>h`；沒宣告時預設；格式錯時 null。 */
export function declaredThreshold(text) {
  const line = (text ?? '').match(/\bRetro trigger:[^\n`]*/)?.[0];
  if (!line) return { count: DEFAULT_COUNT, ageHours: DEFAULT_AGE_HOURS };
  const match = line.match(/^Retro trigger:\s*count=([1-9]\d*)\s+age=([1-9]\d*)h\s*$/);
  return match ? { count: Number(match[1]), ageHours: Number(match[2]) } : null;
}

/** Retro collect 條目的 Declared roster：{ command, due: [TOKEN…] | null }；沒有 Roster command 時 null。 */
export function declaredRoster(collectEntry) {
  const command = collectEntry.match(/Roster command:\s*`([^`]+)`/)?.[1];
  if (!command) return null;
  const due = collectEntry.match(/Roster due:\s*`?([A-Z][A-Z0-9_]*(?:\s*,\s*[A-Z][A-Z0-9_]*)*)`?/)?.[1];
  return { command, due: due ? due.split(',').map(token => token.trim()) : null };
}

/** Roster 輸出 → [{ id, createdAt: ms | null }]：第一個字在 due 裡的行。 */
export function rosterItems(output, due, cwd) {
  return output.split('\n').filter(line => due.includes(line.trim().split(/\s+/)[0])).map(line => {
    const words = line.trim().split(/\s+/);
    const iso = words.find(word => /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(word) && !Number.isNaN(Date.parse(word)));
    if (iso) return { id: words[1] ?? line, createdAt: Date.parse(iso) };
    const file = words.slice(1).map(word => (isAbsolute(word) ? word : join(cwd, word))).find(path => {
      try { return statSync(path).isFile(); } catch { return false; }
    });
    return { id: words[1] ?? line, createdAt: file ? statSync(file).mtimeMs : null };
  });
}

/** GraphQL 抓的開著 Issue（labels.nodes[].name，pilot-probe 的 tracker 查詢）裡掛 `retro-candidates` 的。 */
export const labelledRetro = issues => issues.filter(issue => (issue.labels?.nodes ?? issue.labels ?? []).some(label => (label.name ?? label) === 'retro-candidates'));

/** tracker 的 Issue 列表 → 未收集的 [{ id, createdAt }]：內文有 `From: retro-collect` 行的不算。 */
export function trackerItems(issues) {
  return issues
    .filter(issue => !/^From: retro-collect\s*$/m.test(issue.body ?? issue.description ?? ''))
    .map(issue => ({ id: `#${issue.number ?? issue.iid}`, createdAt: Date.parse(issue.createdAt ?? issue.created_at) }));
}

/** stage 到合入之間的 batch key（`current: staged …`）；沒有時 null。 */
export function stagedBatch(checkout) {
  const dir = join(checkout, '.scratch/pilot');
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).sort()) {
    const key = name.match(/^batch-(.+)\.md$/)?.[1];
    if (key && /^current:[ \t]*staged\b/m.test(readFileSync(join(dir, name), 'utf8'))) return key;
  }
  return null;
}

const hours = ms => (ms === null ? '-' : `${(Math.floor(ms / HOUR * 10) / 10).toFixed(1)}h`);

/**
 * 判斷（純函式，測試邊界用）：items 為 [{ createdAt: ms | null }]。
 * 回 { state: 'IDLE'|'DUE'|'WAIT'|'RUNNING', count, oldest(ms|null) }：count ≥ threshold.count，或至少一則且最舊一則 ≥ ageHours 時到期；
 * 到期時 staged（batch key）優先於 running（handle）。
 */
export function retroDue({ items, threshold, now, staged = null, running = null }) {
  const ages = items.map(item => item.createdAt).filter(at => Number.isFinite(at)).map(at => now - at);
  const oldest = ages.length ? Math.max(...ages) : null;
  const due = items.length >= threshold.count || (items.length > 0 && oldest !== null && oldest >= threshold.ageHours * HOUR);
  const state = !due ? 'IDLE' : staged ? 'WAIT' : running ? 'RUNNING' : 'DUE';
  const byCount = items.length >= threshold.count;
  const byAge = items.length > 0 && oldest !== null && oldest >= threshold.ageHours * HOUR;
  const trigger = !due ? null : byCount && byAge ? 'count+age' : byCount ? 'count' : 'age';
  return { state, count: items.length, oldest, staged, running, trigger };
}

/** 判斷結果 → 輸出行。 */
export function dueLine(result, threshold, startCommand) {
  const tail = `${result.count} oldest=${hours(result.oldest)}`;
  if (result.state === 'IDLE') return `RETRO_IDLE ${tail} threshold count=${threshold.count} age=${threshold.ageHours}h`;
  if (result.state === 'WAIT') return `RETRO_WAIT staged ${result.staged} ${tail}`;
  if (result.state === 'RUNNING') return `RETRO_RUNNING ${result.running} ${tail}`;
  return `RETRO_DUE ${tail} → ${startCommand}`;
}

/** 收集者分頁還在跑：紀錄的 handle 在 terminal list，分頁標題（Orca 的版面資料；沒涵蓋時用 tab-state 的紀錄）以 `處理中｜` 開頭。 */
export async function runningCollector(collectIn, cli) {
  const record = join(collectIn, COLLECTOR_FILE);
  if (!cli || !existsSync(record)) return null;
  const handle = readFileSync(record, 'utf8').trim().split(/\s+/)[1];
  if (!handle) return null;
  try {
    const list = await orca({ cli, signal: AbortSignal.timeout(15000) }, 'terminal', 'list', '--include-visual-layouts');
    if (!(list.terminals ?? []).some(terminal => terminal.handle === handle)) return null;
    const title = tabTitleOf(list.visualLayouts, handle) ?? recordedTitle(handle) ?? '';
    return title.startsWith(`${WORKING}｜`) ? handle : null;
  } catch {
    return null;
  }
}

/** 還在收集的計畫檔：最近 PLAN_FRESH_HOURS 內改過、沒有報告、triggers.log 沒有 collect 行的 `plan-<key>.md`，回 `plan-<key>`；沒有時 null。 */
export function planInProgress(collectIn, now) {
  const dir = join(collectIn, '.scratch/retro');
  if (!existsSync(dir)) return null;
  const reports = existsSync(join(dir, 'reports')) ? readdirSync(join(dir, 'reports')) : [];
  const log = existsSync(join(collectIn, TRIGGERS_LOG)) ? readFileSync(join(collectIn, TRIGGERS_LOG), 'utf8') : '';
  const logged = new Set(log.split('\n').flatMap(line => {
    try { const record = JSON.parse(line); return record.event === 'collect' ? [record.key] : []; } catch { return []; }
  }));
  const plans = readdirSync(dir).map(name => ({ name, key: name.match(/^plan-(.+)\.md$/)?.[1] })).filter(({ key }) => key)
    .map(plan => ({ ...plan, mtime: statSync(join(dir, plan.name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  const live = plans.find(({ key, mtime }) => now - mtime < PLAN_FRESH_HOURS * HOUR
    && !reports.some(report => report.endsWith(`-${key}.md`)) && !logged.has(key));
  return live ? `plan-${live.key}` : null;
}

/** 未收集的 retro：[{ id, createdAt }]；失敗時 throw（訊息是 RETRO_FAILED 的原因）。
 *  issues：呼叫者已從 GitHub 抓好的開著 Issue（pilot-probe 的 GraphQL 結果，全部頁），給了就不再跑 gh；GitLab 與 Declared roster 不用它。 */
export function uncollected(checkout, collectIn, texts, issues) {
  const roster = declaredRoster(entryText(texts, 'Retro collect'));
  if (roster) {
    if (!roster.due) throw new Error('roster-due-missing');
    const run = spawnSync('sh', ['-c', roster.command], { cwd: collectIn, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`roster exit ${run.status ?? run.signal}：${(run.stderr || run.stdout).trim().split('\n').at(-1) ?? ''}`);
    return rosterItems(run.stdout, roster.due, collectIn);
  }
  const doc = existsSync(join(checkout, 'docs/agents/issue-tracker.md')) ? readFileSync(join(checkout, 'docs/agents/issue-tracker.md'), 'utf8') : null;
  const gitlab = trackerKind(doc) === 'gitlab';
  if (issues && !gitlab) return trackerItems(labelledRetro(issues));
  const [bin, args] = gitlab
    ? ['glab', ['issue', 'list', '--label', 'retro-candidates', '--per-page', '100', '-O', 'json']]
    : ['gh', ['issue', 'list', '--state', 'open', '--label', 'retro-candidates', '--limit', String(TRACKER_LIMIT), '--json', 'number,createdAt,body']];
  const run = spawnSync(bin, args, { cwd: checkout, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`${bin} exit ${run.status ?? run.error?.code ?? run.signal}：${(run.stderr ?? '').trim().split('\n').at(-1) ?? ''}`);
  return trackerItems(JSON.parse(run.stdout || '[]'));
}

/** 整支的判斷：{ line, result? }。 */
export async function evaluate({ checkout, collectIn, cli, now, startCommand, issues }) {
  const texts = adapterTexts(checkout);
  if (!entryText(texts, 'Retro trigger')) return { line: 'RETRO_OFF no-trigger-entry' };
  const threshold = declaredThreshold(texts.map(({ content }) => content).join('\n'));
  if (!threshold) return { line: 'RETRO_FAILED bad-declaration（格式：Retro trigger: count=<n> age=<h>h）', failed: true };
  let items;
  try {
    items = uncollected(checkout, collectIn, texts, issues);
  } catch (error) {
    return { line: `RETRO_FAILED ${error.message}`, failed: true };
  }
  const staged = stagedBatch(checkout);
  const probe = retroDue({ items, threshold, now, staged });
  const running = probe.state === 'DUE' ? (await runningCollector(collectIn, cli)) ?? planInProgress(collectIn, now) : null;
  const result = retroDue({ items, threshold, now, staged, running });
  return { line: dueLine(result, threshold, startCommand), result, threshold };
}

/** `.scratch/retro/triggers.log` 追加一行 JSON。 */
export function appendTrigger(collectIn, record) {
  mkdirSync(join(collectIn, '.scratch/retro'), { recursive: true });
  appendFileSync(join(collectIn, TRIGGERS_LOG), `${JSON.stringify(record)}\n`);
}

/** 開分頁成功後的紀錄：triggers.log 一行、decisions.md 一列（同目錄的 pilot-decision.mjs）。回 decisions 失敗的原因或 null。 */
export function recordStart({ checkout, collectIn, now, result, threshold, handle }) {
  const oldestHours = result.oldest === null ? null : Math.floor(result.oldest / HOUR * 10) / 10;
  appendTrigger(collectIn, { time: new Date(now).toISOString(), event: 'start', trigger: result.trigger, uncollected: result.count, oldestHours, handle, threshold });
  const decision = join(dirname(fileURLToPath(import.meta.url)), 'pilot-decision.mjs');
  if (!existsSync(decision)) return 'no-pilot-decision';
  const run = spawnSync(process.execPath, [decision, checkout,
    '--decision', `retro-collect 自動觸發，開分頁 ${handle}`,
    '--reason', `RETRO_DUE ${result.trigger} ${result.count} oldest=${hours(result.oldest)}（門檻 count=${threshold.count} age=${threshold.ageHours}h）`,
    '--evidence', `${join(collectIn, TRIGGERS_LOG)}`,
    '--result', `RETRO_STARTED ${handle}`], { encoding: 'utf8' });
  return run.status === 0 ? null : `pilot-decision exit ${run.status}：${(run.stderr || run.stdout).trim().split('\n').at(-1) ?? ''}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const positional = [];
  let collectArg;
  let start = false;
  let logKey;
  const logItems = [];
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start') start = true;
    else if (args[i] === '--log-collect') { logKey = args[++i]; if (!logKey || logKey.startsWith('--')) bad = true; }
    else if (args[i] === '--item') {
      const item = args[++i] ?? '';
      const at = item.indexOf('=');
      if (at < 1 || at === item.length - 1) bad = true;
      else logItems.push({ ref: item.slice(0, at), result: item.slice(at + 1) });
    }
    else if (args[i] === '--collect-in') { collectArg = args[++i]; if (!collectArg || collectArg.startsWith('--')) bad = true; }
    else if (args[i].startsWith('--')) bad = true;
    else positional.push(args[i]);
  }
  // --item 只跟 --log-collect；--log-collect 不和判斷用的 --start、--collect-in 混用。
  const logMisuse = logKey === undefined ? logItems.length > 0 : start || collectArg !== undefined;
  if (bad || positional.length !== 1 || logMisuse) {
    console.error(USAGE);
    process.exit(2);
  }
  if (logKey !== undefined) {
    const now = process.env.RETRO_DUE_NOW ? Date.parse(process.env.RETRO_DUE_NOW) : Date.now();
    appendTrigger(resolve(positional[0]), { time: new Date(now).toISOString(), event: 'collect', key: logKey, collected: logItems.length, items: logItems });
    console.log(`RETRO_LOGGED ${logKey} ${logItems.length}`);
    process.exit(0);
  }
  const checkout = resolve(positional[0]);
  const collectIn = resolve(collectArg ?? positional[0]);
  const now = process.env.RETRO_DUE_NOW ? Date.parse(process.env.RETRO_DUE_NOW) : Date.now();
  const cli = process.env.ORCA_CLI_COMMAND;
  const startCommand = `node scripts/pilot-retro-due.mjs ${positional[0]}${collectArg ? ` --collect-in ${collectArg}` : ''} --start`;
  const { line, result, failed, threshold } = await evaluate({ checkout, collectIn, cli, now, startCommand });
  if (!start || result?.state !== 'DUE') {
    console.log(line);
    process.exit(failed ? 1 : 0);
  }
  if (!cli) {
    console.log('RETRO_START_FAILED no-orca（沒有 ORCA_CLI_COMMAND；請人在主 checkout 輸入 /retro-collect）');
    process.exit(4);
  }
  const opened = await openSession({ cli }, { title: 'retro-collect', prompt: '/retro-collect', main: collectIn, newTab: true });
  if (opened.stop) {
    console.log(`RETRO_START_FAILED ${opened.stop}`);
    process.exit(4);
  }
  mkdirSync(join(collectIn, '.scratch/retro'), { recursive: true });
  writeFileSync(join(collectIn, COLLECTOR_FILE), `${new Date(now).toISOString()} ${opened.handle}\n`);
  const recordError = recordStart({ checkout, collectIn, now, result, threshold, handle: opened.handle });
  if (recordError) console.error(`decisions.md 沒記到（${recordError}）；triggers.log 已記`);
  console.log(`RETRO_STARTED ${opened.handle}`);
}
