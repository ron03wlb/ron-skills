#!/usr/bin/env node
// 摘要某個本地日期的 agent session：Claude Code 依專案列 prompt，Codex 依 prompt 種類分組計數。
// 用法： node day-sessions.mjs <YYYY-MM-DD> [--tz-offset 8] [--claude-root <dir>]... [--codex-root <dir>] [--max-prompts 6]
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const NOISE = [
  /^<task-notification>/,
  /^<local-command/,
  /^<bash-std(out|err)>/,
  /^<command-name>\/clear<\/command-name>/,
  /^<command-message>clear<\/command-message>/,
  /^This session is being continued/,
  /^\[Request interrupted/,
  /^Caveat:/,
];
const CODEX_CONTEXT = /^(<environment_context>|<user_instructions>|<permissions|# AGENTS\.md)/;

export function parseArgs(argv) {
  const opts = { date: null, tzOffset: 8, claudeRoots: [], codexRoot: join(homedir(), '.codex/sessions'), maxPrompts: 6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tz-offset') opts.tzOffset = Number(argv[++i]);
    else if (a === '--claude-root') opts.claudeRoots.push(argv[++i]);
    else if (a === '--codex-root') opts.codexRoot = argv[++i];
    else if (a === '--max-prompts') opts.maxPrompts = Number(argv[++i]);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) opts.date = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.date) throw new Error('usage: day-sessions.mjs <YYYY-MM-DD>');
  if (!opts.claudeRoots.length) {
    opts.claudeRoots = [join(homedir(), '.claude/projects'), '/mnt/c/Users/ron.chang/.claude/projects'];
  }
  return opts;
}

export function dayWindow(date, tzOffset) {
  const start = Date.parse(`${date}T00:00:00Z`) - tzOffset * 3600e3;
  return { start, end: start + 86400e3 };
}

// 使用者常在 prompt 或 `!` 指令裡貼 token；摘要會進 daily-summary 的 context 與草稿，印出前先遮掉。
// 恰好 40 位的 hex 是 git sha，保留。
const SECRET = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}|\b(?:ghp_|gho_|ghs_|github_pat_)\w{25,}|\bglpat-[\w-]{15,}|\bsk-[\w-]{24,}|\beyJ[\w-]{15,}\.[\w-]{15,}\.[\w-]{15,}|\b(?![0-9a-f]{40}\b)[0-9a-f]{32,}\b/gi;

// 把使用者 prompt 壓成一行並遮掉 token；harness 雜訊（背景通知、/clear、續接摘要）回 null。
export function cleanPrompt(text) {
  const t = flatten(text);
  return t && t.replace(SECRET, '<redacted>');
}

function flatten(text) {
  const t = text.trim();
  if (!t || NOISE.some((re) => re.test(t))) return null;
  const cmd = t.match(/<command-name>(\/[^<]+)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?/);
  if (cmd) return `${cmd[1]}${cmd[2] ? ` ${cmd[2]}` : ''}`.replace(/\s+/g, ' ').trim();
  const bash = t.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return `! ${bash[1]}`.replace(/\s+/g, ' ').trim();
  return t.replace(/\s+/g, ' ');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && (c.type === 'text' || c.type === 'input_text'))
    .map((c) => c.text)
    .join(' ');
}

async function* lines(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

export async function readClaudeSession(file, win) {
  const prompts = [];
  let first = null;
  for await (const line of lines(file)) {
    // 大部分行是 assistant 輸出或 tool result，先用字串篩掉再 parse。
    if (!line.includes('"type":"user"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' || d.isMeta) continue;
    const ts = Date.parse(d.timestamp);
    if (!(ts >= win.start && ts < win.end)) continue;
    const p = cleanPrompt(textOf(d.message?.content));
    if (!p) continue;
    first ??= ts;
    prompts.push(p);
  }
  return { first, prompts };
}

export async function claudeSessions(roots, win) {
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const project of readdirSync(root)) {
      const dir = join(root, project);
      let files;
      try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const file = join(dir, f);
        // 最後寫入早於當天的檔案不可能有當天的紀錄。
        if (statSync(file).mtimeMs < win.start) continue;
        const s = await readClaudeSession(file, win);
        if (s.prompts.length) out.push({ project, id: f.slice(0, 8), ...s });
      }
    }
  }
  return out.sort((a, b) => a.first - b.first);
}

export function codexKind(prompt) {
  if (!prompt) return '(no prompt)';
  return prompt.slice(0, 60).replace(/\b[0-9a-f]{7,40}\b|\d+/g, '#').trim();
}

export async function codexGroups(codexRoot, date) {
  const dir = join(codexRoot, ...date.split('-'));
  if (!existsSync(dir)) return [];
  const groups = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    let cwd = '?';
    let prompt = null;
    for await (const line of lines(join(dir, f))) {
      if (!line.includes('"session_meta"') && !line.includes('"role":"user"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const p = d.payload ?? {};
      if (d.type === 'session_meta') cwd = p.cwd ?? cwd;
      else if (p.type === 'message' && p.role === 'user') {
        const t = textOf(p.content).trim();
        if (t && !CODEX_CONTEXT.test(t)) prompt = t.replace(/\s+/g, ' ');
      }
      if (prompt) break;
    }
    // 每個 worker 的 sha、Issue 編號、worktree 都不同；依 prompt 開頭分組，同類 run 合成一行。
    const key = codexKind(prompt);
    const g = groups.get(key) ?? { prompt: key, count: 0, cwds: new Set() };
    g.count++;
    g.cwds.add(cwd);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function render({ claude, codex }, { tzOffset, maxPrompts }) {
  const hhmm = (ms) => new Date(ms + tzOffset * 3600e3).toISOString().slice(11, 16);
  const out = [];
  const byProject = Map.groupBy(claude, (s) => s.project);
  for (const [project, sessions] of byProject) {
    out.push(`## ${project} (${sessions.length})`);
    for (const s of sessions) {
      const shown = s.prompts.slice(0, maxPrompts).map((p) => p.slice(0, 200));
      const more = s.prompts.length > maxPrompts ? ` (+${s.prompts.length - maxPrompts})` : '';
      out.push(`- ${hhmm(s.first)} ${s.id}: ${shown.join(' | ')}${more}`);
    }
  }
  if (codex.length) {
    out.push(`## codex (${codex.reduce((n, g) => n + g.count, 0)})`);
    for (const g of codex) {
      const where = g.cwds.size === 1 ? [...g.cwds][0] : `${g.cwds.size} cwds`;
      out.push(`- ×${g.count} (${where}): ${g.prompt}`);
    }
  }
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const win = dayWindow(opts.date, opts.tzOffset);
  const [claude, codex] = await Promise.all([
    claudeSessions(opts.claudeRoots, win),
    codexGroups(opts.codexRoot, opts.date),
  ]);
  console.log(render({ claude, codex }, opts));
}
