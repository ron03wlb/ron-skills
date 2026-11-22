#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 子代理模型稽核（唯讀）：掃 ~/.claude/projects/ 下相符專案目錄裡最近 N 個 transcript（含 <session>/subagents/*.jsonl），
// 找出沒指定 input.model 的 Agent（舊名 Task）呼叫，依「呼叫前最近的 slash 指令或 Skill tool_use 的 skill 名」歸屬。
// retro cf16948a#1：原本要在 session 內臨時手寫 Python，且無法確認 skill 改成 sonnet 後規則是否生效。
// 用法：node scripts/agent-model-audit.mjs [--dir <path>] [--project <子字串>] [--limit <N，預設 50>] [--since <YYYY-MM-DD>]
//   --project 只讀名稱含該子字串的專案目錄（英數以外的字元照 Claude Code 目錄名換成 -；預設取目前 repo 主 checkout 的目錄名，
//   不在 git repo 時取目前目錄名，見 lib/claude-projects.mjs）。
// 輸出行（皆為稽核資訊，不是 actionable 錯誤；exit 一律 0，用法錯誤 exit 2）：
//   UNMODELED <skill> <count> <最近一次 description>  該 skill 派出的 Agent 呼叫有 <count> 次沒指定 model；
//     下一步：確認該 skill 的 SKILL.md 有指定 model，仍出現代表規則未生效。無法歸屬時 skill 為 (none)。
//   SUMMARY transcripts=<n> agents=<n> unmodeled=<n>  掃描的 transcript 數、納入統計的 Agent 呼叫數、未指定 model 的數量。
//   stderr `WARN <dir> <原因>`：根目錄讀不到，或沒有名稱含 <子字串> 的專案目錄；照常印 SUMMARY（數字為 0）。
// subagent_type 為 Explore、claude-code-guide、fork 的呼叫略過（不計入 agents）。不輸出任何對話內容，只輸出 description。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { defaultProject, projectMatcher } from './lib/claude-projects.mjs';

const SKIP_TYPES = new Set(['Explore', 'claude-code-guide', 'fork']);

function parseArgs(argv) {
  const o = { dir: path.join(os.homedir(), '.claude', 'projects'), limit: 50, since: null, project: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') o.dir = argv[++i];
    else if (argv[i] === '--limit') o.limit = Number(argv[++i]);
    else if (argv[i] === '--since') o.since = argv[++i];
    else if (argv[i] === '--project') o.project = argv[++i] ?? '';
    else { console.error(`未知參數 ${argv[i]}`); process.exit(2); }
  }
  if (!Number.isInteger(o.limit) || o.limit < 1 || !o.dir || o.project === '' || (o.since && !/^\d{4}-\d{2}-\d{2}$/.test(o.since))) {
    console.error('用法：agent-model-audit.mjs [--dir <path>] [--project <子字串>] [--limit <N>] [--since <YYYY-MM-DD>]');
    process.exit(2);
  }
  o.project ??= defaultProject();
  return o;
}

// 遞迴找 *.jsonl（含 subagents/）；不跟隨 symlink 目錄以外的東西
function collect(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try { out.push({ p, m: fs.statSync(p).mtimeMs }); } catch { /* 略過 */ }
    }
  }
}

function userText(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  return '';
}

async function scan(file, stats) {
  let current = '(none)';
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j?.type === 'user') {
      const m = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(userText(j.message));
      if (m) current = m[1];
    } else if (j?.type === 'assistant' && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (b?.type !== 'tool_use') continue;
        if (b.name === 'Skill' && typeof b.input?.skill === 'string') current = b.input.skill;
        else if (b.name === 'Agent' || b.name === 'Task') {
          if (SKIP_TYPES.has(b.input?.subagent_type)) continue;
          stats.agents++;
          if (b.input?.model) continue;
          stats.unmodeled++;
          const e = stats.by.get(current) ?? { count: 0, desc: '' };
          e.count++;
          e.desc = String(b.input?.description ?? '').replace(/\s+/g, ' ');
          stats.by.set(current, e);
        }
      }
    }
  }
}

const o = parseArgs(process.argv.slice(2));
const files = [];
let projects = [];
try {
  projects = fs.readdirSync(o.dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter(projectMatcher(o.project));
  if (!projects.length) console.error(`WARN ${o.dir} 沒有名稱含 ${o.project} 的專案目錄`);
} catch (e) { console.error(`WARN ${o.dir} ${e.code ?? e.message}`); }
for (const name of projects) collect(path.join(o.dir, name), files);
const sinceMs = o.since ? Date.parse(`${o.since}T00:00:00`) : 0;
const picked = files.filter((f) => f.m >= sinceMs).sort((a, b) => b.m - a.m).slice(0, o.limit);
const stats = { agents: 0, unmodeled: 0, by: new Map() };
// 由舊到新掃，「最近一次 description」才是最新的
for (const f of picked.reverse()) await scan(f.p, stats);
for (const [skill, e] of [...stats.by].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))) {
  console.log(`UNMODELED ${skill} ${e.count} ${e.desc}`);
}
console.log(`SUMMARY transcripts=${picked.length} agents=${stats.agents} unmodeled=${stats.unmodeled}`);
