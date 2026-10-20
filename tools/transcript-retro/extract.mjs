// 將 Claude Code session transcript 濃縮成 retro 用的摘要（不呼叫 API、不花錢）。
// 只保留：使用者訊息、assistant 文字、工具呼叫摘要、失敗的工具結果、系統訊息。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// Haiku 5.5 在 100K token 以內是低價區間，留安全邊界
export const CHUNK_TOKEN_LIMIT = 80_000;

const LIMITS = { user: 2000, text: 800, toolInput: 240, error: 600, system: 400 };

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /glpat-[A-Za-z0-9_-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(password|passwd|pwd|token|secret|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
];

export function redact(s) {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, k, sep) => (sep !== undefined ? `${k}${sep}<redacted>` : '<redacted>'));
  }
  return out;
}

// 保留頭尾、剪掉中間：收尾標記（例如 worker 的 `DONE <iid> <SHA>`）與串接指令的最後一步都在尾端
function clip(s, n) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= n) return flat;
  const head = Math.ceil(n * 0.6);
  const tail = n - head;
  return `${flat.slice(0, head)}…(+${flat.length - n})…${flat.slice(-tail)}`;
}

// 粗估 token：CJK 約 1 字 1 token，其餘約 3.5 字元 1 token；
// 2026-10-20 以 count_tokens 實測（Sonnet 5.5）約為此值的 1.45–1.6 倍，乘上 1.6 取保守值
export function estimateTokens(s) {
  const cjk = (s.match(/[　-鿿＀-￯]/g) || []).length;
  return Math.ceil((cjk + (s.length - cjk) / 3.5) * 1.6);
}

function toolInputSummary(name, input = {}) {
  if (name === 'Bash') return input.command;
  if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(name)) return input.file_path;
  if (name === 'Grep' || name === 'Glob') return `${input.pattern ?? ''} ${input.path ?? ''}`;
  if (name === 'Skill') return `${input.skill ?? ''} ${input.args ?? ''}`;
  if (name === 'Agent') return `${input.subagent_type ?? ''}: ${input.description ?? ''}`;
  return JSON.stringify(input);
}

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

function hhmm(ts) {
  return ts ? ts.slice(11, 16) : '--:--';
}

export function digestSession(file) {
  const lines = [];
  let title = '';
  let cwd = '';
  let first = '';
  let last = '';
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw) continue;
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      continue;
    }
    if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
    if (d.cwd && !cwd) cwd = d.cwd;
    if (d.timestamp) {
      first ||= d.timestamp;
      last = d.timestamp;
    }
    const t = hhmm(d.timestamp);
    if (d.type === 'system' && d.content) {
      lines.push(`[${t}] SYS: ${clip(d.content, LIMITS.system)}`);
      continue;
    }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    if (d.isMeta) continue;
    const content = d.message?.content;
    if (typeof content === 'string') {
      if (d.type === 'user') lines.push(`[${t}] USER: ${clip(content, LIMITS.user)}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (d.type === 'user' && b.type === 'text') {
        lines.push(`[${t}] USER: ${clip(b.text, LIMITS.user)}`);
      } else if (d.type === 'user' && b.type === 'tool_result' && b.is_error) {
        lines.push(`[${t}] TOOL-ERROR: ${clip(resultText(b), LIMITS.error)}`);
      } else if (d.type === 'assistant' && b.type === 'text') {
        lines.push(`[${t}] ASSISTANT: ${clip(b.text, LIMITS.text)}`);
      } else if (d.type === 'assistant' && b.type === 'tool_use') {
        lines.push(`[${t}] CALL ${b.name}: ${clip(toolInputSummary(b.name, b.input), LIMITS.toolInput)}`);
      }
    }
  }
  const header = `# session ${path.basename(file, '.jsonl')}\ntitle: ${title}\ncwd: ${cwd}\ntime: ${first} → ${last}`;
  return { header, lines: lines.map(redact), title, cwd, first, last };
}

// 依 token 上限切段，每段都帶 header
export function chunkDigest({ header, lines }) {
  const chunks = [];
  let cur = [];
  let tokens = estimateTokens(header);
  for (const line of lines) {
    const n = estimateTokens(line) + 1;
    if (cur.length && tokens + n > CHUNK_TOKEN_LIMIT) {
      chunks.push(cur);
      cur = [];
      tokens = estimateTokens(header);
    }
    cur.push(line);
    tokens += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c, i) => ({
    text: `${header}\npart: ${i + 1}/${chunks.length}\n\n${c.join('\n')}`,
  }));
}

// 回傳 session 第一次使用該 skill 的時間（使用者輸入 /name 或模型呼叫 Skill），沒用過回傳 null
export function findSkillInvocation(file, name) {
  const typed = `<command-name>/${name}</command-name>`;
  const all = fs.readFileSync(file, 'utf8');
  // 先用字串比對快速排除，避免逐行解析整個大檔
  if (!all.includes(typed) && !all.includes(`"skill":"${name}"`)) return null;
  for (const raw of all.split('\n')) {
    if (!raw.includes(name)) continue;
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      continue;
    }
    const c = d.message?.content;
    if (d.type === 'user' && typeof c === 'string' && c.includes(typed)) return d.timestamp;
    if (d.type === 'assistant' && Array.isArray(c) && c.some((b) => b.type === 'tool_use' && b.name === 'Skill' && b.input?.skill === name)) {
      return d.timestamp;
    }
  }
  return null;
}

// 只取主 session 檔，不含 subagent 子目錄
export function listSessions({ project, since } = {}) {
  const out = [];
  for (const dir of fs.readdirSync(PROJECTS_DIR)) {
    if (project && !dir.includes(project)) continue;
    const full = path.join(PROJECTS_DIR, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(full, f);
      const st = fs.statSync(file);
      if (since && st.mtime < since) continue;
      out.push({ file, project: dir, id: f.slice(0, -6), mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}
