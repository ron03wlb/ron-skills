#!/usr/bin/env node
// token 消耗量測（#373 由另一專案的量測腳本通用化）：讀 Claude Code transcript，依日、模型、角色彙總，並給 worker 每張單的加權值與中位數。唯讀，只量測。
//
// 用法：node scripts/token-usage.mjs [--since YYYY-MM-DD] [--summary] [--root <dir>] [--project <子字串>]
//   --since 期間起日（Asia/Taipei，含當日；預設 7 天前）；--summary 只印最後一行 TOKENS_SUMMARY；
//   --root transcript 根目錄（預設 ~/.claude/projects，供測試改路徑）；
//   --project 只讀名稱含該子字串的專案目錄（英數以外的字元照 Claude Code 目錄名換成 -；預設取目前 repo 主 checkout 的目錄名，
//   不在 git repo 時取目前目錄名，見 lib/claude-projects.mjs）。
//
// 來源：<root> 下名稱含 <子字串> 的目錄（沒有時 stderr 印 `WARN <root> 沒有名稱含 <子字串> 的專案目錄`，照常印空報表、exit 0）；`<dir>/<session>.jsonl` 是 session，`<dir>/<session>/subagents/*.jsonl` 是該 session 的子代理。
//   修改時間早於期間起點的檔案不讀（裡面不會有期間內的 turn）；子代理的父 session 檔案被略過時仍讀它判定角色。
// 計算：
//   - 每則 assistant message 依 message id（沒有時用 uuid）只算一次，取第一次出現的時間、模型與 usage，output 取各次最大值；
//     跨檔案重複的 id（續接或 fork 帶進來的歷史）也只算第一次，session 先於子代理，output 同樣取各檔最大值。
//   - 加權值＝input + 1.25×cache write + 0.1×cache read + 5×output（來源專案 2026-11-16 grill 的定義）；日期以 turn 時間的台北日期計。
//   - 角色看 session 第一則非 tool_result 的使用者訊息（classify）：/issue-pilot 或 /loop /issue-pilot → pilot；/issue-run → worker；
//     /retro、/retro-collect → retro；/issue-queue（含 /loop）→ queue；/grilling、/grill-with-docs → grilling；
//     `讀 …/scenario/…`、`讀 …/pilot/briefs/verify-<iid>…`、`獨立驗證者` → scenario；`讀 …/deliver-<iid>/(fix|ruling|fresh|stale)…`（pilot 送給 worker 的 brief）→ worker；
//     `讀 …/pilot/briefs/…` 其餘 → pilot；其他 → interactive。子代理的成本算進父 session 的角色（worker 也算進父 session 的 iid）。
//   - worker 的 iid：/issue-run 參數開頭的數字，否則訊息裡的 `deliver-<iid>`；每張單合計其所有 worker session（含子代理）的加權值，中位數取這些合計。
//   - retro opus 佔比＝retro 角色子代理中模型含 `opus` 的加權值 ÷ retro 角色子代理加權值；另列子代理數（以第一個 turn 的模型判定）。
// 輸出（數字為 token，不帶單位）：
//   `TOKENS_DAY <YYYY-MM-DD> input=<n> cacheWrite=<n> cacheRead=<n> output=<n> weighted=<n>`（每日一行）、
//   `TOKENS_MODEL <model> …`（同欄位）、`TOKENS_ROLE <role> sessions=<n> subagents=<n> …`（同欄位）、
//   `TOKENS_WORKER #<iid> weighted=<n> sessions=<n>`（每張單一行，依 iid），最後一行
//   `TOKENS_SUMMARY since=<起日> until=<期間內最後一個 turn 的日期> workerMedian=<百萬，兩位小數>M workers=<張數> retroOpus=<百分比>%|- retroOpusAgents=<opus 數>/<子代理數>`。
// 讀不到或壞掉的資料不中止：stderr 印 `WARN <session id|路徑> <原因>`（只帶 id 與缺什麼，不帶對話內容），該筆略過。
// exit：0 完成；1 根目錄讀不到（不存在或不是目錄，印 WARN <root> <原因>）；2 用法錯誤。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { defaultProject, projectMatcher } from './lib/claude-projects.mjs';

const USAGE = '用法：node scripts/token-usage.mjs [--since YYYY-MM-DD] [--summary] [--root <dir>] [--project <子字串>]';
export const ROLES = ['pilot', 'worker', 'retro', 'queue', 'grilling', 'scenario', 'interactive'];
const FIELDS = ['input', 'cacheWrite', 'cacheRead', 'output'];

export const weighted = item => item.input + 1.25 * item.cacheWrite + 0.1 * item.cacheRead + 5 * item.output;

const taipeiDate = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
/** 台北日期 00:00 的毫秒。 */
const taipeiStart = date => Date.parse(`${date}T00:00:00+08:00`);

const textOf = content => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => (block?.type === 'text' ? block.text ?? '' : '')).join(' ') : '');

/** transcript 全文 → { firstUser, turns: [{ id, ts, model, input, cacheWrite, cacheRead, output }], badLines }。 */
export function parseTranscript(text) {
  const turns = new Map(); let firstUser = null; let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // 不需解析的行只檢查外形（截斷的寫入），免得每行 JSON.parse
    if (!line.startsWith('{') || !line.trimEnd().endsWith('}')) { badLines++; continue; }
    const isAssistant = line.includes('"assistant"');
    if (!isAssistant && (firstUser !== null || !line.includes('"user"'))) continue;
    let record;
    try { record = JSON.parse(line); } catch { badLines++; continue; }
    if (record.type === 'user' && firstUser === null) {
      const content = record.message?.content;
      if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) continue;
      firstUser = textOf(content);
    } else if (record.type === 'assistant') {
      const message = record.message ?? {}; const id = message.id ?? record.uuid; const usage = message.usage ?? {};
      if (!id) continue;
      const output = usage.output_tokens ?? 0;
      if (turns.has(id)) { const turn = turns.get(id); turn.output = Math.max(turn.output, output); continue; }
      turns.set(id, { id, ts: Date.parse(record.timestamp), model: message.model ?? '-', input: usage.input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, output });
    }
  }
  return { firstUser, turns: [...turns.values()], badLines };
}

/** 第一則使用者訊息 → { role, iid }（規則見 header）。 */
export function classify(text) {
  const first = text ?? '';
  const name = /<command-name>(.*?)<\/command-name>/.exec(first)?.[1];
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(first)?.[1] ?? '';
  const deliver = Number(/deliver-(\d+)/.exec(first)?.[1]) || null;
  if (name) {
    if (name === '/issue-run') return { role: 'worker', iid: Number(/^\s*#?(\d+)/.exec(args)?.[1]) || null };
    if (name === '/issue-pilot' || (name === '/loop' && /issue-pilot/.test(args))) return { role: 'pilot', iid: null };
    if (name === '/issue-queue' || (name === '/loop' && /issue-queue/.test(args))) return { role: 'queue', iid: null };
    if (name === '/loop' && /issue-run/.test(args)) return { role: 'worker', iid: null };
    if (name === '/retro' || name === '/retro-collect') return { role: 'retro', iid: null };
    if (name === '/grilling' || name === '/grill-with-docs') return { role: 'grilling', iid: null };
    return { role: 'interactive', iid: null };
  }
  if (first.startsWith('讀')) {
    if (/\/scenario\//.test(first)) return { role: 'scenario', iid: deliver };
    const verify = /pilot\/briefs\/verify-(\d+)/.exec(first);
    if (verify) return { role: 'scenario', iid: Number(verify[1]) };
    if (/deliver-\d+\/(fix|ruling|fresh|stale)/.test(first)) return { role: 'worker', iid: deliver };
    if (/pilot\/briefs\//.test(first)) return { role: 'pilot', iid: null };
  }
  if (first.includes('獨立驗證者')) return { role: 'scenario', iid: deliver ?? (Number(/#(\d+)/.exec(first)?.[1]) || null) };
  return { role: 'interactive', iid: null };
}

const empty = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, weighted: 0 });
const add = (total, turn) => { for (const field of FIELDS) total[field] += turn[field]; total.weighted += weighted(turn); };

/** 中位數（偶數筆取中間兩值平均）；空陣列 null。 */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * sessions：[{ sid, parent（子代理的父 session id，session 為 null）, firstUser, turns }] → 彙總。
 * 回 { days, models, roles: Map<名稱, 合計＋sessions／subagents>, workers: Map<iid, { weighted, sessions }>, workerMedian, retro, period }。
 */
export function aggregate(sessions, { since, warn = () => {} }) {
  const from = taipeiStart(since);
  const bySid = new Map(sessions.filter(item => !item.parent).map(item => [item.sid, item]));
  const ordered = [...sessions.filter(item => !item.parent), ...sessions.filter(item => item.parent)];
  const days = new Map(); const models = new Map(); const roles = new Map(); const workers = new Map(); const seen = new Set();
  // 跨檔同 message id 只算第一次出現，但 output 取各檔最大值（與檔內去重一致）
  const maxOutput = new Map();
  for (const session of sessions) for (const turn of session.turns) maxOutput.set(turn.id, Math.max(maxOutput.get(turn.id) ?? 0, turn.output));
  const retro = { opusWeighted: 0, weighted: 0, opusAgents: 0, agents: 0 }; let until = null;
  const bucket = (map, key, init = empty) => { if (!map.has(key)) map.set(key, init()); return map.get(key); };
  for (const session of ordered) {
    let owner = session;
    if (session.parent) {
      owner = bySid.get(session.parent);
      if (!owner) { warn(`WARN ${session.sid} 子代理的父 session ${session.parent} 讀不到，角色記 interactive`); owner = { sid: session.parent, firstUser: null }; }
    }
    const { role, iid } = classify(owner.firstUser);
    const turns = session.turns.filter(turn => turn.ts >= from && !seen.has(turn.id)).map(turn => ({ ...turn, output: maxOutput.get(turn.id) }));
    turns.forEach(turn => seen.add(turn.id));
    const roleTotal = bucket(roles, role, () => ({ ...empty(), sessions: 0, subagents: 0 }));
    if (turns.length) roleTotal[session.parent ? 'subagents' : 'sessions'] += 1;
    if (role === 'worker' && !session.parent && iid === null && turns.length) warn(`WARN ${session.sid} worker session 讀不出 iid，不計入每張單`);
    let sessionWeighted = 0; let opusWeighted = 0;
    for (const turn of turns) {
      const date = taipeiDate(turn.ts); if (!until || date > until) until = date;
      add(bucket(days, date), turn); add(bucket(models, turn.model), turn); add(roleTotal, turn);
      sessionWeighted += weighted(turn); if (/opus/.test(turn.model)) opusWeighted += weighted(turn);
    }
    if (role === 'worker' && iid !== null && turns.length) {
      const item = bucket(workers, iid, () => ({ weighted: 0, sessions: 0 }));
      item.weighted += sessionWeighted; if (!session.parent) item.sessions += 1;
    }
    if (role === 'retro' && session.parent && turns.length) {
      retro.weighted += sessionWeighted; retro.opusWeighted += opusWeighted; retro.agents += 1;
      if (/opus/.test(turns[0].model)) retro.opusAgents += 1;
    }
  }
  const sortMap = map => new Map([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    days: sortMap(days), models: sortMap(models), roles, workers: new Map([...workers].sort(([a], [b]) => a - b)),
    workerMedian: median([...workers.values()].map(item => item.weighted)), retro, period: { since, until: until ?? since },
  };
}

const round = value => Math.round(value);
const fields = total => FIELDS.map(field => `${field}=${round(total[field])}`).concat(`weighted=${round(total.weighted)}`).join(' ');

export function summaryLine(result) {
  const median = result.workerMedian === null ? '-' : `${(result.workerMedian / 1e6).toFixed(2)}M`;
  const opus = result.retro.weighted ? `${(result.retro.opusWeighted / result.retro.weighted * 100).toFixed(1)}%` : '-';
  return `TOKENS_SUMMARY since=${result.period.since} until=${result.period.until} workerMedian=${median} workers=${result.workers.size} retroOpus=${opus} retroOpusAgents=${result.retro.opusAgents}/${result.retro.agents}`;
}

export function reportLines(result) {
  return [
    ...[...result.days].map(([date, total]) => `TOKENS_DAY ${date} ${fields(total)}`),
    ...[...result.models].map(([model, total]) => `TOKENS_MODEL ${model} ${fields(total)}`),
    ...ROLES.filter(role => result.roles.has(role)).map(role => { const total = result.roles.get(role); return `TOKENS_ROLE ${role} sessions=${total.sessions} subagents=${total.subagents} ${fields(total)}`; }),
    ...[...result.workers].map(([iid, item]) => `TOKENS_WORKER #${iid} weighted=${round(item.weighted)} sessions=${item.sessions}`),
    summaryLine(result),
  ];
}

/** <root> 下名稱含 project 子字串的目錄 → sessions（修改時間早於 from 的檔案略過，但子代理的父 session 仍讀）；根目錄讀不到時 WARN 並回 null。 */
export function loadSessions(root, from, warn, project) {
  const sessions = [];
  const read = (path, sid, parent) => {
    let text;
    try { text = readFileSync(path, 'utf8'); } catch (error) { warn(`WARN ${sid} ${error.code ?? error.message}`); return; }
    const parsed = parseTranscript(text);
    if (parsed.badLines) warn(`WARN ${sid} ${parsed.badLines} 行無法解析`);
    sessions.push({ sid, parent, firstUser: parsed.firstUser, turns: parsed.turns });
  };
  const recent = path => { try { return statSync(path).mtimeMs >= from; } catch { return false; } };
  let names;
  try { names = readdirSync(root); } catch (error) { warn(`WARN ${root} ${error.code ?? error.message}`); return null; }
  const projects = names.filter(projectMatcher(project)).sort();
  if (!projects.length) warn(`WARN ${root} 沒有名稱含 ${project} 的專案目錄`);
  for (const name of projects) {
    const dir = join(root, name); let entries;
    try { entries = readdirSync(dir); } catch (error) { warn(`WARN ${dir} ${error.code ?? error.message}`); continue; }
    const subagentParents = entries.filter(entry => existsSync(join(dir, entry, 'subagents')));
    const parentsNeeded = new Set();
    for (const parent of subagentParents) {
      const subDir = join(dir, parent, 'subagents');
      let files;
      try { files = readdirSync(subDir); } catch (error) { warn(`WARN ${parent} 子代理目錄讀不到（${error.code ?? error.message}），略過其子代理`); continue; }
      for (const file of files.filter(item => item.endsWith('.jsonl')).sort()) {
        if (!recent(join(subDir, file))) continue;
        read(join(subDir, file), basename(file, '.jsonl'), parent); parentsNeeded.add(parent);
      }
    }
    for (const file of entries.filter(item => item.endsWith('.jsonl')).sort()) {
      const sid = basename(file, '.jsonl');
      // 不同目錄的同名 session（續接帶進來的歷史）也逐檔讀，重複的 message id 由 aggregate 去重
      if (!(recent(join(dir, file)) || parentsNeeded.has(sid))) continue;
      read(join(dir, file), sid, null);
    }
  }
  return sessions;
}

function main(argv) {
  const args = [...argv];
  let since = taipeiDate(Date.now() - 7 * 86400 * 1000); let summaryOnly = false; let root = join(homedir(), '.claude/projects'); let project = null;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--since') since = args.shift();
    else if (arg === '--summary') summaryOnly = true;
    else if (arg === '--root') root = args.shift();
    else if (arg === '--project') project = args.shift() ?? '';
    else { console.error(USAGE); return 2; }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? '') || Number.isNaN(taipeiStart(since)) || !root || project === '') { console.error(USAGE); return 2; }
  project ??= defaultProject();
  const warn = line => console.error(line);
  const sessions = loadSessions(root, taipeiStart(since), warn, project);
  if (!sessions) return 1;
  const result = aggregate(sessions, { since, warn });
  const lines = reportLines(result);
  console.log((summaryOnly ? lines.slice(-1) : lines).join('\n'));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
