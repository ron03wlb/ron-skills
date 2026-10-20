#!/usr/bin/env node
// transcript-retro：以 Batch API 分析 Claude Code session，彙整成報告。
// 兩種模式：
//   retro（預設）：找環境造成的摩擦，產出 retro 候選
//   --skill <name>：以該 skill 在 session 當時的 SKILL.md 為評分標準，檢查有沒有照步驟執行
//   node analyze.mjs estimate [--skill <name>] [--project <slug>] [--since YYYY-MM-DD] [--limit N] [--model <id>]
//   node analyze.mjs submit   [同上] [--skill-path <SKILL.md>] [--rubric <file>]...
//     --rerun：忽略已分析紀錄重送（萃取方式修正後重跑用；同一 session 的舊 finding 會被覆蓋）
//   node analyze.mjs collect
//   node analyze.mjs report   [--skill <name>] [--project <slug>] [--since YYYY-MM-DD] [--memory <MEMORY.md>] [--repo <path>]...
// API key 讀自 ~/.config/ron-skills/anthropic-api-key，只給本程式使用；
// 不可 export 成全域 ANTHROPIC_API_KEY，否則 Claude Code 會改走 API 計費。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { listSessions, digestSession, chunkDigest, estimateTokens, findSkillInvocation } from './extract.mjs';
import { resolveSkillFile, versionAt, historyOf, commitLog } from './rubric.mjs';

const KEY_FILE = path.join(os.homedir(), '.config', 'ron-skills', 'anthropic-api-key');
const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'transcript-retro');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

const REPORT_MODEL = 'claude-sonnet-5-5';
// 每百萬 token 單價（Batch 再打 5 折）
const PRICE = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
};

// 證據含這些字眼時，finding 可能是摘要截斷造成的誤判（2026-10-20：worker 末行 DONE 被截掉而誤報為缺漏）
const UNSURE = /截斷|無法(完全)?確認|看不到|truncat|clipped/i;

const SEVERITY = { type: 'string', enum: ['high', 'medium', 'low'] };

function findingsSchema(itemProps) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'findings'],
    properties: {
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: Object.keys(itemProps), properties: itemProps },
      },
    },
  };
}

const RETRO = {
  model: 'claude-haiku-5-5',
  schema: findingsSchema({
    category: {
      type: 'string',
      enum: [
        'navigation',
        'automated-check',
        'coding-standard',
        'steering-file',
        'tool-economy',
        'no-op-instruction',
        'information-access',
        'user-correction',
        'other',
      ],
    },
    severity: SEVERITY,
    title: { type: 'string' },
    evidence: { type: 'string' },
    suggestion: { type: 'string' },
  }),
  prompt: `You review one Claude Code session digest to find improvements to the agent's environment (repo docs, skills, scripts, checks, memory), not to the code it wrote.

Digest line kinds: USER (the human), ASSISTANT (agent text), CALL <tool> (tool call summary), TOOL-ERROR (failed or denied tool call), SYS (harness message). Long values keep their start and end and drop the middle, marked "…(+N)…".

Report friction that a better environment would have prevented:
- navigation: time spent finding files, facts, or commands.
- automated-check: a mistake a lint, test, hook, or script could have caught.
- coding-standard: a review rule that is missing or unclear.
- steering-file: AGENTS.md, CLAUDE.md, skill, or memory guidance that was missing, wrong, or ignored.
- tool-economy: expensive, repeated, or failing tool calls (retries, huge outputs, denied commands).
- no-op-instruction: guidance that clearly had no effect.
- information-access: information the agent needed but could not reach.
- user-correction: the user corrected, interrupted, or redirected the agent.

Rules:
- Each finding cites evidence from the digest with its [HH:MM] stamp; quote briefly.
- Report only what the digest shows. No finding is a valid result for a smooth session.
- Merge repeats of the same problem into one finding.
- severity high: cost many turns, a wrong result, or needed the user to step in; low: minor.
- Write summary, title, evidence commentary, and suggestion in Traditional Chinese; keep code, paths, and commands as written.`,
  reportPrompt: `You aggregate per-session retro findings from many Claude Code sessions into one retrospective report for the user.

Input: a JSON array of findings, each tagged with session id, title, and date; the user's memory index (one line per stored rule); and commit subjects of the user's repos since the earliest finding (may be empty).

Produce a Markdown report in Traditional Chinese (keep code, paths, and commands as written):
1. 結論: the top 3 to 5 problems, most costly first.
2. 重複問題: group findings describing the same underlying problem across sessions. For each group give the count of sessions, dates, two short evidence quotes with session ids, and a concrete fix. Prefer a script, hook, or check over more prose when the problem recurs.
3. 已有 memory 仍重犯: groups whose rule already appears in the memory index yet keep recurring; name the memory line. These are candidates to turn into scripts or gates.
4. 單次但嚴重: one-off high-severity findings worth a look.
5. 可能已修正: problems a commit dated after the finding appears to address; cite the commit hash, and state whether findings dated after that commit still show the problem. Leave these out of sections 1 to 4 unless they still occur after the fix.
Skip low-severity one-offs. Do not invent findings that are not in the input.`,
};

const SKILL = {
  model: 'claude-sonnet-5-5',
  schema: findingsSchema({
    type: {
      type: 'string',
      enum: ['skipped-step', 'out-of-order', 'instruction-ignored', 'wrong-execution', 'user-intervention', 'step-friction', 'unclear-instruction'],
    },
    step: { type: 'string' },
    severity: SEVERITY,
    evidence: { type: 'string' },
    suggestion: { type: 'string' },
  }),
  prompt: `You audit whether a Claude Code agent followed a skill's instructions in one session. The skill document in force at that time is given below as the rubric; files it references but that are not included are out of scope.

The user message is a session digest. Line kinds: USER (the human), ASSISTANT (agent text), CALL <tool> (tool call summary), TOOL-ERROR (failed or denied tool call), SYS (harness message). Long values keep their start and end and drop the middle, marked "…(+N)…", and tool output is omitted except errors, so judge only what the digest shows; when a step cannot be confirmed from the digest, do not report it as skipped.

Judge from the point where the skill is invoked (/<name> typed by the user or a Skill call). Report:
- skipped-step: a required step visibly not done.
- out-of-order: steps done in a different order than required.
- instruction-ignored: an explicit rule (must, never, only, before) visibly broken.
- wrong-execution: a step done with the wrong command, file, or arguments.
- user-intervention: the user had to correct, stop, or redirect the agent within the skill flow.
- step-friction: a step that cost many retries or turns even when followed.
- unclear-instruction: the agent visibly misread or hesitated over an ambiguous instruction.

Rules:
- step names the rubric section or step the finding is about, as written in the rubric.
- Each finding cites digest evidence with its [HH:MM] stamp; quote briefly.
- severity high: wrong result, broken safety rule, or user had to intervene; low: cosmetic.
- summary states in one or two sentences how far the run got and how faithfully it followed the skill.
- suggestion says what to change in the skill or its scripts so the problem cannot recur; prefer a script or gate over more prose.
- Write summary, evidence commentary, and suggestion in Traditional Chinese; keep code, paths, commands, and rubric step names as written.`,
  reportPrompt: `You aggregate per-session skill compliance findings into one report for the skill's author.

Input: the skill name; the git history of its SKILL.md (newest first, one commit per line); commit subjects of the user's repos since the earliest finding, which cover fixes to the scripts the skill calls (may be empty); a JSON array of findings, each tagged with session id, date, and the SKILL.md version (sha) in force for that session.

Produce a Markdown report in Traditional Chinese (keep code, paths, commands, and step names as written):
1. 結論: the 3 to 5 most costly compliance problems.
2. 依步驟彙整: group findings by rubric step. For each step: sessions affected and total sessions, the recurring failure, two short evidence quotes with session ids, and the fix.
3. 已修正 vs 仍發生: for each recurring problem, use the version shas and both commit lists to say whether a later SKILL.md or script commit appears to address it (cite the hash) and whether it still occurs in sessions on or after that version. Problems still occurring after a fix are the priority.
4. 從未被遵守的指示: instructions broken in most sessions that saw them; recommend turning them into a script or gate, or deleting them.
Skip low-severity one-offs. Do not invent findings that are not in the input.`,
};

function readKey() {
  try {
    return fs.readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    console.error(`找不到 API key：請建立 ${KEY_FILE}（chmod 600），內容為 Console 發的 key`);
    process.exit(2);
  }
}

function client() {
  return new Anthropic({ apiKey: readKey() });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { sessions: {}, batches: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// retro 模式沿用原本的 key 與目錄；skill 模式各自分開
function modeOf(opts) {
  return opts.skill ? `skill-${opts.skill}` : 'retro';
}

function stateKey(mode, id) {
  return mode === 'retro' ? id : `${mode}:${id}`;
}

function findingsDir(mode) {
  return mode === 'retro' ? path.join(DATA_DIR, 'findings') : path.join(DATA_DIR, 'findings', mode);
}

// 已分析且檔案未變動的 session 不重送
function pendingSessions(state, opts) {
  const mode = modeOf(opts);
  const since = opts.since ? new Date(opts.since) : undefined;
  const out = [];
  for (const s of listSessions({ project: opts.project, since })) {
    const prev = state.sessions[stateKey(mode, s.id)];
    if (prev && prev.mtimeMs === s.mtimeMs && !opts.rerun) continue;
    if (opts.skill) {
      s.invokedAt = findSkillInvocation(s.file, opts.skill);
      if (!s.invokedAt) continue;
    }
    out.push(s);
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

function skillRubric(opts, invokedAt) {
  const main = resolveSkillFile(opts.skill, opts['skill-path']);
  const files = [main, ...(opts.rubric ?? [])];
  const parts = files.map((f) => ({ file: f, ...versionAt(f, invokedAt) }));
  const text = parts.map((p) => `<file path="${p.file}" version="${p.sha}">\n${p.text}\n</file>`).join('\n\n');
  return { sha: parts.map((p) => p.sha).join('+'), text };
}

function buildRequests(sessions, opts) {
  const mode = modeOf(opts);
  const spec = opts.skill ? SKILL : RETRO;
  const model = opts.model ?? spec.model;
  const requests = [];
  const meta = {};
  for (const s of sessions) {
    const digest = digestSession(s.file);
    // 沒有任何使用者訊息的 session（只有系統提示）不值得分析
    if (!digest.lines.some((l) => l.includes('] USER: '))) continue;
    const rubric = opts.skill ? skillRubric(opts, s.invokedAt) : undefined;
    // rubric 放在 system 並加上 cache_control，同版本的請求可以共用快取
    const system = rubric
      ? [
          { type: 'text', text: spec.prompt.replace('<name>', opts.skill) },
          { type: 'text', text: `# Rubric: ${opts.skill}\n\n${rubric.text}`, cache_control: { type: 'ephemeral' } },
        ]
      : spec.prompt;
    const systemTokens = estimateTokens(spec.prompt) + (rubric ? estimateTokens(rubric.text) : 0);
    chunkDigest(digest).forEach((c, i) => {
      const customId = `${s.id}--${i + 1}`;
      meta[customId] = {
        session: s.id,
        project: s.project,
        title: digest.title,
        date: digest.first.slice(0, 10),
        mtimeMs: s.mtimeMs,
        ...(rubric && { skillVersion: rubric.sha }),
      };
      requests.push({
        custom_id: customId,
        estTokens: estimateTokens(c.text) + systemTokens,
        params: {
          model,
          max_tokens: 8000,
          system,
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: spec.schema } },
          messages: [{ role: 'user', content: c.text }],
        },
      });
    });
  }
  return { mode, model, requests, meta };
}

function costLine(tokensIn, tokensOut, model, batch) {
  const p = PRICE[model] ?? PRICE[REPORT_MODEL];
  const usd = ((tokensIn * p.in + tokensOut * p.out) / 1e6) * (batch ? 0.5 : 1);
  return `$${usd.toFixed(2)}`;
}

async function cmdEstimate(opts) {
  const sessions = pendingSessions(loadState(), opts);
  const { model, requests } = buildRequests(sessions, opts);
  const tokens = requests.reduce((a, r) => a + r.estTokens, 0);
  // 輸出粗估每段 1.5K token；未計入快取折扣，實際會更低
  const out = requests.length * 1500;
  console.log(`模式 ${modeOf(opts)}：待分析 session ${sessions.length}，請求 ${requests.length}，估計輸入 ${(tokens / 1e6).toFixed(2)}M token`);
  console.log(`${model} Batch 估計費用上限 ${costLine(tokens, out, model, true)}`);
}

async function cmdSubmit(opts) {
  const state = loadState();
  const sessions = pendingSessions(state, opts);
  const { mode, model, requests, meta } = buildRequests(sessions, opts);
  if (!requests.length) {
    console.log('沒有待分析的 session');
    return;
  }
  const batch = await client().messages.batches.create({
    requests: requests.map(({ custom_id, params }) => ({ custom_id, params })),
  });
  state.batches[batch.id] = { createdAt: new Date().toISOString(), mode, model, meta, status: batch.processing_status };
  saveState(state);
  console.log(`已送出 batch ${batch.id}（${mode}）：${requests.length} 個請求（${sessions.length} 個 session）`);
  console.log('通常 1 小時內完成；之後執行 node analyze.mjs collect');
}

async function cmdCollect() {
  const state = loadState();
  const api = client();
  for (const [id, b] of Object.entries(state.batches)) {
    if (b.status === 'collected') continue;
    const mode = b.mode ?? 'retro';
    const dir = findingsDir(mode);
    fs.mkdirSync(dir, { recursive: true });
    const batch = await api.messages.batches.retrieve(id);
    if (batch.processing_status !== 'ended') {
      const c = batch.request_counts;
      console.log(`${id}：${batch.processing_status}（處理中 ${c.processing}，完成 ${c.succeeded}）`);
      continue;
    }
    let ok = 0;
    let failed = 0;
    let tin = 0;
    let tout = 0;
    let unsure = 0;
    for await (const r of await api.messages.batches.results(id)) {
      const m = b.meta[r.custom_id];
      if (r.result.type !== 'succeeded') {
        failed++;
        console.log(`  ${r.custom_id}：${r.result.type}`);
        continue;
      }
      const msg = r.result.message;
      const u = msg.usage;
      tin += u.input_tokens + (u.cache_read_input_tokens ?? 0) * 0.1 + (u.cache_creation_input_tokens ?? 0) * 1.25;
      tout += u.output_tokens;
      if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') {
        failed++;
        console.log(`  ${r.custom_id}：stop_reason ${msg.stop_reason}`);
        continue;
      }
      const text = msg.content.find((c) => c.type === 'text')?.text ?? '';
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        failed++;
        console.log(`  ${r.custom_id}：輸出不是合法 JSON`);
        continue;
      }
      fs.writeFileSync(path.join(dir, `${r.custom_id}.json`), `${JSON.stringify({ ...m, ...parsed }, null, 2)}\n`);
      ok++;
      unsure += parsed.findings.filter((f) => UNSURE.test(`${f.evidence} ${f.suggestion}`)).length;
    }
    // 只有整個 session 的所有段落都成功才標記為已分析
    const failedSessions = new Set();
    for (const cid of Object.keys(b.meta)) {
      if (!fs.existsSync(path.join(dir, `${cid}.json`))) failedSessions.add(b.meta[cid].session);
    }
    for (const m of Object.values(b.meta)) {
      if (!failedSessions.has(m.session)) state.sessions[stateKey(mode, m.session)] = { mtimeMs: m.mtimeMs, batch: id };
    }
    b.status = 'collected';
    b.usage = { input: Math.round(tin), output: tout };
    saveState(state);
    console.log(`${id}（${mode}）：成功 ${ok}、失敗 ${failed}；約 ${costLine(tin, tout, b.model, true)}`);
    if (unsure) {
      console.log(`  警告：${unsure} 筆 finding 的證據提到截斷或無法確認；全量送出或據此修改前，先對照原始 transcript 確認摘要沒有漏掉關鍵內容`);
    }
  }
}

function loadFindings(opts) {
  const dir = findingsDir(modeOf(opts));
  if (!fs.existsSync(dir)) return { sessions: 0, findings: [] };
  const findings = [];
  const sessions = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (opts.project && !d.project.includes(opts.project)) continue;
    if (opts.since && d.date < opts.since) continue;
    sessions.add(d.session);
    for (const x of d.findings) {
      if (x.severity === 'low') continue;
      findings.push({ session: d.session.slice(0, 8), title: d.title, date: d.date, ...(d.skillVersion && { version: d.skillVersion }), ...x });
    }
  }
  return { sessions: sessions.size, findings };
}

async function cmdReport(opts) {
  const mode = modeOf(opts);
  const { sessions, findings } = loadFindings(opts);
  if (!findings.length) {
    console.log('沒有可彙整的 finding；先執行 submit 與 collect');
    return;
  }
  const earliest = findings.reduce((a, f) => (f.date < a ? f.date : a), findings[0].date);
  const commits = (opts.repo ?? []).map((r) => commitLog(r, earliest)).join('\n\n') || '（未提供）';
  let input;
  if (opts.skill) {
    const history = historyOf(resolveSkillFile(opts.skill, opts['skill-path']));
    input = `## Skill\n${opts.skill}（分析了 ${sessions} 個 session）\n\n## SKILL.md history\n${history}\n\n## Repo commits\n${commits}\n\n## Findings\n${JSON.stringify(findings)}`;
  } else {
    const memory = opts.memory && fs.existsSync(opts.memory) ? fs.readFileSync(opts.memory, 'utf8') : '（未提供）';
    input = `## Findings\n${JSON.stringify(findings)}\n\n## Memory index\n${memory}\n\n## Repo commits\n${commits}`;
  }
  console.log(`彙整 ${sessions} 個 session 的 ${findings.length} 筆 finding（約 ${estimateTokens(input)} token）…`);
  const stream = client().beta.messages.stream({
    model: REPORT_MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high' },
    system: (opts.skill ? SKILL : RETRO).reportPrompt,
    messages: [{ role: 'user', content: input }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    console.error('彙整請求被拒絕，未產出報告');
    process.exit(1);
  }
  const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const out = path.join(REPORTS_DIR, `${mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.md`);
  fs.writeFileSync(out, `${text}\n`);
  const u = msg.usage;
  console.log(`報告：${out}`);
  console.log(`用量 in ${u.input_tokens} / out ${u.output_tokens}，約 ${costLine(u.input_tokens, u.output_tokens, REPORT_MODEL, false)}`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string' },
    since: { type: 'string' },
    limit: { type: 'string' },
    model: { type: 'string' },
    memory: { type: 'string' },
    skill: { type: 'string' },
    'skill-path': { type: 'string' },
    rubric: { type: 'string', multiple: true },
    repo: { type: 'string', multiple: true },
    rerun: { type: 'boolean' },
  },
});
const opts = { ...values, limit: values.limit ? Number(values.limit) : undefined };
const commands = { estimate: cmdEstimate, submit: cmdSubmit, collect: cmdCollect, report: cmdReport };
const cmd = commands[positionals[0]];
if (!cmd) {
  console.error('用法：node analyze.mjs <estimate|submit|collect|report> [--skill <name>] [--project] [--since] [--limit] [--model] [--memory] [--rubric <file>]');
  process.exit(2);
}
await cmd(opts);
