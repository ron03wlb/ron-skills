#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本（ron-skills #347，移植自 spay2 #1025 的 scripts/memory-audit.mjs）：稽核 Claude memory 目錄的健康度，只讀 memory 目錄。
// 背景：spay2 的 MEMORY.md 長到 11171 字元（超過 6000 的上限）才被人工修剪，斷連結、已結案的 `until #n` 條目、沒進索引的檔沒人檢查。
//
// memory 目錄：預設是 cwd 所在 repo 的主 checkout（worktree 也取主 checkout；--root <dir> 覆寫）路徑照 Claude Code 的規則
//   （英數以外的字元都換成 `-`，同 lib/claude-projects.mjs）編碼後的 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<編碼>/memory`；--dir <path> 直接指定。
//   字元數一律以 Unicode code point 計。索引行＝MEMORY.md 中以 `- [` 開頭的行。
// 時間：環境變數 MEMORY_AUDIT_NOW（ISO 時刻，測試用）；否則現在時刻。日期一律取 UTC。
// tracker：`until #<n>` 的單照主 checkout 的 docs/agents/issue-tracker.md（lib/hosts.mjs 的 trackerKind：寫 glab 是 GitLab、寫 gh 是 GitHub，
//   沒有這份文件時依 origin）在主 checkout 跑 `gh issue view <n> --json state` 或 `glab issue view <n> -F json`；tracker 和程式碼不同種 host 時
//   帶文件裡該種 host 的專案（projectInDoc）。state 為 closed 才算結案；本機 Markdown tracker 一律算查不到。
//
// 用法：
//   node scripts/memory-audit.mjs [--dir <path>] [--root <dir>]
//     每項一行：
//       `INDEX_OVER size=<n> limit=6000`、`INDEX_LINE_LONG line=<n> len=<n> limit=100`、`ORPHAN_FILE <檔名>`（沒有被 MEMORY.md 的 `](x.md)` 連到的 .md）、
//       `BROKEN_LINK <來源檔>:<行> <目標>`（MEMORY.md 的 `](x.md)` 對不到檔；任一 memory 檔的 `[[名稱]]` 對不到 `名稱.md`、卻恰有一個只差大小寫
//         或副檔名的檔。對不到任何檔的 `[[名稱]]` 是還沒寫的 memory，memory 規則允許，不報）、
//       `UNTIL_CLOSED line=<n> #<n>`（索引行的 `until #<n>` 已結案）、
//       `DATED_STALE line=<n> date=<MM-DD> age=<d>d`（索引行內獨立的 MM-DD 距今超過 30 天；年份取今年，今年或明年的該日在今天之後 60 天內
//         是未來日期、不報，晚於今天超過 60 天則取前一年）；
//     最後一行摘要 `MEMORY_AUDIT items=<k> index_over=<a> long=<b> orphan=<c> broken=<d> until_closed=<e> dated_stale=<f>`，乾淨時 `MEMORY_AUDIT items=0`。
//     `WARN memory-audit reason=tracker-unreachable issue=#<n>`（在摘要之前）：查不到該單，那一條略過（不算結案）；
//     `WARN memory-audit reason=<dir-missing|dir-unreadable|index-missing> dir=<path>`：無法稽核，只印這一行（沒有摘要）。
//   node scripts/memory-audit.mjs --run [--dir <path>] [--root <dir>]
//     同上，再把 `<UTC 日期> <摘要行>` 追加到 <主 checkout>/.scratch/pilot/memory-audit.md（MEMORY_AUDIT_FILE）；pilot-probe 以它的最後一行判斷
//     MEMORY_AUDIT_DUE（memoryAuditLine）。目錄 WARN 時不追加，下一輪照樣到期。
// exit：0 印完（有問題也是 0）；2 用法錯誤。
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codeHost, projectInDoc, trackerKind } from './lib/hosts.mjs';

export const INDEX_LIMIT = 6000;
export const LINE_LIMIT = 100;
export const STALE_DAYS = 30;
export const FUTURE_DAYS = 60;
export const INDEX = 'MEMORY.md';
/** --run 的紀錄檔（主 checkout 下）；pilot-probe 的 MEMORY_AUDIT_DUE 讀它。 */
export const MEMORY_AUDIT_FILE = '.scratch/pilot/memory-audit.md';
const DAY = 86_400_000;
const cp = text => [...text].length;
const isIndexLine = line => line.startsWith('- [');
const DATE = /(?<![\d-])(\d{2})-(\d{2})(?![\d-])/g;
const INDEX_LINK = /\]\(([^)\s]+?\.md)\)/gi;
const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;

/** 主 checkout 路徑 → Claude Code 的 memory 目錄（英數以外的字元換成 `-`）。 */
export const memoryDirFor = root => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');

/** cwd 所在 repo 的主 checkout（在 linked worktree 裡也取主 checkout）；不在 git repo 時 null。 */
export function mainCheckout(cwd = process.cwd()) {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
  if (common.status !== 0) return null;
  const gitDir = common.stdout.trim();
  return gitDir.endsWith('/.git') ? dirname(gitDir) : gitDir.replace(/\.git$/, '');
}

/** 目錄列表（Dirent）中的 `*.md`（不含 `.` 開頭者），依名稱排序。 */
const memoryFiles = entries => entries
  .filter(entry => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.')).map(entry => entry.name).sort();

/** 目錄列表（Dirent[]）；audit 的 listDir 預設值，測試注入以模擬大小寫不敏感的檔案系統。 */
export const listMemoryDir = dir => readdirSync(dir, { withFileTypes: true });

/** 去掉 `.md` 後不分大小寫同名的檔恰有一個時回其檔名，否則 null。 */
export function uniqueMatch(target, files) {
  const key = name => name.replace(/\.md$/i, '').toLowerCase();
  const hits = files.filter(name => key(name) === key(target));
  return hits.length === 1 ? hits[0] : null;
}

/** 在主 checkout 查 Issue 狀態：'closed'｜'open'｜null（查不到、或本機 Markdown tracker）。 */
export function trackerState(n, root) {
  let doc = null;
  try { doc = readFileSync(join(root, 'docs/agents/issue-tracker.md'), 'utf8'); } catch {}
  const documented = trackerKind(doc);
  if (documented === 'local') return null;
  const origin = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const code = codeHost(origin).value;
  const kind = documented === 'none' ? (code === 'gitlab' ? 'gitlab' : 'github') : documented;
  const project = code !== kind ? projectInDoc(doc, kind) : null;
  const env = { ...process.env };
  let args;
  if (kind === 'gitlab') args = ['glab', 'issue', 'view', String(n), '-F', 'json', ...(project ? ['-R', `${project.origin}/${project.path}`] : [])];
  else {
    args = ['gh', 'issue', 'view', String(n), '--json', 'state', ...(project ? ['--repo', project.path] : [])];
    if (project && project.host !== 'github.com') env.GH_HOST = project.host;
  }
  const result = spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  if (result.status !== 0) return null;
  try {
    const state = JSON.parse(result.stdout).state;
    return typeof state === 'string' ? (state.toLowerCase() === 'closed' ? 'closed' : 'open') : null;
  } catch { return null; }
}

/** 索引行內獨立 MM-DD 的距今天數（未來日期規則見檔頭）。 */
export function datedAges(line, now) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out = [];
  for (const match of line.matchAll(DATE)) {
    const [month, day] = [Number(match[1]), Number(match[2])];
    let at = Date.UTC(now.getUTCFullYear(), month - 1, day);
    if (month < 1 || month > 12 || new Date(at).getUTCDate() !== day) continue;
    if (at > today && at - today <= FUTURE_DAYS * DAY) continue;
    if (at < today && Date.UTC(now.getUTCFullYear() + 1, month - 1, day) - today <= FUTURE_DAYS * DAY) continue; // 12 月看到明年 1 月的日期
    if (at > today) at = Date.UTC(now.getUTCFullYear() - 1, month - 1, day);
    out.push({ date: match[0], age: Math.floor((today - at) / DAY) });
  }
  return out;
}

/** 摘要行。 */
export function summaryLine(counts) {
  const items = Object.values(counts).reduce((a, b) => a + b, 0);
  return items ? `MEMORY_AUDIT items=${items} ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ')}` : 'MEMORY_AUDIT items=0';
}

/** 目錄無法稽核時回 WARN 行，否則 null。 */
export function dirProblem(dir) {
  if (!existsSync(dir)) return `WARN memory-audit reason=dir-missing dir=${dir}`;
  try { readdirSync(dir); } catch { return `WARN memory-audit reason=dir-unreadable dir=${dir}`; }
  if (!existsSync(join(dir, INDEX))) return `WARN memory-audit reason=index-missing dir=${dir}`;
  return null;
}

/**
 * 稽核（唯讀）→ { lines, warns, counts, summary }。
 * 連結目標在不在一律對 listDir 的檔名做大小寫敏感比對、不用 existsSync：APFS 等大小寫不敏感的檔案系統上
 * `existsSync('Open.md')` 會找到 `open.md`，Linux 與 macOS 結果就不同（PR 477 checks-macos）。
 * @param {{ dir: string, root: string, now: Date, state?: (n: number, root: string) => 'closed'|'open'|null,
 *   listDir?: (dir: string) => import('node:fs').Dirent[] }} options
 */
export function audit({ dir, root, now, state = trackerState, listDir = listMemoryDir }) {
  const entries = listDir(dir);
  const names = new Set(entries.map(entry => entry.name));
  const files = memoryFiles(entries);
  const index = readFileSync(join(dir, INDEX), 'utf8');
  const lines = index.split('\n');
  const found = { index_over: [], long: [], orphan: [], broken: [], until_closed: [], dated_stale: [] };
  const warns = new Set();
  const size = cp(index);
  if (size > INDEX_LIMIT) found.index_over.push(`INDEX_OVER size=${size} limit=${INDEX_LIMIT}`);
  lines.forEach((line, at) => { if (isIndexLine(line) && cp(line) > LINE_LIMIT) found.long.push(`INDEX_LINE_LONG line=${at + 1} len=${cp(line)} limit=${LINE_LIMIT}`); });
  const linked = new Set([...index.matchAll(INDEX_LINK)].map(match => match[1]));
  for (const name of files) if (name !== INDEX && !linked.has(name)) found.orphan.push(`ORPHAN_FILE ${name}`);
  lines.forEach((line, at) => {
    for (const match of line.matchAll(INDEX_LINK)) if (!names.has(match[1])) found.broken.push(`BROKEN_LINK ${INDEX}:${at + 1} ${match[1]}`);
  });
  const others = files.filter(file => file !== INDEX);
  for (const name of files) {
    readFileSync(join(dir, name), 'utf8').split('\n').forEach((line, at) => {
      for (const match of line.matchAll(WIKI_LINK)) {
        if (!names.has(`${match[1]}.md`) && uniqueMatch(match[1], others)) found.broken.push(`BROKEN_LINK ${name}:${at + 1} ${match[0]}`);
      }
    });
  }
  const states = new Map();
  lines.forEach((line, at) => {
    if (!isIndexLine(line)) return;
    for (const match of line.matchAll(/until #(\d+)/g)) {
      const n = Number(match[1]);
      if (!states.has(n)) states.set(n, state(n, root));
      if (states.get(n) === null) warns.add(`WARN memory-audit reason=tracker-unreachable issue=#${n}`);
      else if (states.get(n) === 'closed') found.until_closed.push(`UNTIL_CLOSED line=${at + 1} #${n}`);
    }
    for (const { date, age } of datedAges(line, now)) if (age > STALE_DAYS) found.dated_stale.push(`DATED_STALE line=${at + 1} date=${date} age=${age}d`);
  });
  const counts = Object.fromEntries(Object.entries(found).map(([kind, items]) => [kind, items.length]));
  return { lines: Object.values(found).flat(), warns: [...warns], counts, summary: summaryLine(counts) };
}

/** `Memory audit days: <n>`（adapter 宣告的稽核間隔，pilot-probe 讀主分支的 adapter）；沒有宣告或不是正整數時 null。 */
export function declaredDays(adapter) {
  const days = Number((adapter ?? '').match(/\bMemory audit days:\s*(\d+)\b/)?.[1]);
  return Number.isInteger(days) && days > 0 ? days : null;
}

/**
 * pilot-probe 的到期行：紀錄檔（MEMORY_AUDIT_FILE 的內容，不存在時 null）最後一筆 `<YYYY-MM-DD> …` 距今 `days` 天以上、或沒有紀錄時
 * `MEMORY_AUDIT_DUE <天數|?>d last=<YYYY-MM-DD|none> → node scripts/memory-audit.mjs --run`，否則 null；`days` 為 null（沒宣告）時一律 null。
 */
export function memoryAuditLine(text, days, now = Date.now()) {
  if (!days) return null;
  const last = (text ?? '').split('\n').map(line => line.match(/^(\d{4}-\d{2}-\d{2})\s/)?.[1]).filter(Boolean).at(-1) ?? null;
  const age = last ? Math.floor((now - Date.parse(`${last}T00:00:00Z`)) / DAY) : null;
  if (age !== null && age < days) return null;
  return `MEMORY_AUDIT_DUE ${age ?? '?'}d last=${last ?? 'none'} → node scripts/memory-audit.mjs --run`;
}

function main(argv) {
  const usage = () => { console.error('用法：node scripts/memory-audit.mjs [--run] [--dir <memory 目錄>] [--root <主 checkout>]'); return 2; };
  let run = false; let rootArg; let dirArg;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '--run') run = true;
    else if (arg === '--root' || arg === '--dir') {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) return usage();
      if (arg === '--root') rootArg = value; else dirArg = value;
      at += 1;
    } else return usage();
  }
  const now = process.env.MEMORY_AUDIT_NOW ? new Date(process.env.MEMORY_AUDIT_NOW) : new Date();
  if (Number.isNaN(now.getTime())) { console.error(`MEMORY_AUDIT_NOW 不是有效時刻：${process.env.MEMORY_AUDIT_NOW}`); return 2; }
  const root = rootArg ? resolve(rootArg) : mainCheckout();
  if (!root) { console.error('不在 git repo 裡：用 --root 指定主 checkout'); return 2; }
  const dir = dirArg ? resolve(dirArg) : memoryDirFor(root);
  const problem = dirProblem(dir);
  if (problem) { console.log(problem); return 0; }
  const result = audit({ dir, root, now });
  for (const line of [...result.lines, ...result.warns, result.summary]) console.log(line);
  if (run) {
    const file = join(root, MEMORY_AUDIT_FILE);
    mkdirSync(dirname(file), { recursive: true });
    const gap = existsSync(file) && !/(^|\n)$/.test(readFileSync(file, 'utf8')) ? '\n' : '';
    appendFileSync(file, `${gap}${now.toISOString().slice(0, 10)} ${result.summary}\n`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
