#!/usr/bin/env node
// setup-workflow 正本（#370）：`/issue-queue` 第 6 步（Parent hints）的母單提示，取代 agent 每次手寫的 sub_issues、blocked_by、`prose-deps.mjs` 迴圈。
// 用法：node scripts/parent-hints.mjs [--repo <owner>/<name>] [<母單>...]
//   不帶母單時查所有開著、有 sub-issue 的單。只支援 GitHub（subIssues）：docs/agents/issue-tracker.md 寫的是 GitLab 或本機 Markdown 時 exit 2。
// stdout：每張母單、每類提示一行，依母單號碼；沒有提示時不輸出。提示只給人看，不擋任何流程，腳本也不寫 tracker。
//   PARENT_ALL_CLOSED <p> #<c>...            子單全關、母單還開著
//   PARENT_TRIAGE_LABEL <p> <label>,...      母單掛著 triage 狀態 label（TRIAGE_STATES）
//   PARENT_PROSE_DEPS <p> #<c>:#<m>,... ...  開著的子單本文的依賴（pilot-probe.mjs 的 proseDeps，#94 的規則）是開著、同 repo、不在它 blocked_by 的單
//   PARENT_NO_ACCEPTANCE <p> #<c>...         開著的子單沒有 `## 驗收` 標題（`## 驗收條件` 也算）
//   PARENT_DECISIONS_MISSING <p> R<r>-Q<q>... 母單「已確認的決策／決定」段列的編號沒出現在任何子單本文（開著或關著）；同輪範圍（R2-Q1～R2-Q4、R2-Q1～Q4）與省略輪次的列舉（R2-Q1、Q2）
//                                             在兩邊都展開；段裡那一行送到別張單（`→ #88`、「見 #13」、「#13 的內文補充」；只提到號碼不算）時，那張單的本文提到也算
//   PARENT_DECISION_RANGE <p> R<a>-Q<x>～R<b>-Q<y>... 段裡的跨輪範圍展不開，請人列出；子單裡的跨輪範圍不算涵蓋任何編號
// exit 0；gh 失敗時 stderr 印原因、exit 1；用法錯誤或 tracker 不是 GitHub 時 exit 2。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { trackerKind } from './lib/hosts.mjs';
import { TRIAGE_STATES, proseDeps } from './pilot-probe.mjs';

const USAGE = '用法：node scripts/parent-hints.mjs [--repo <owner>/<name>] [<母單>...]';
const LIST_QUERY = 'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN){pageInfo{hasNextPage endCursor} nodes{number subIssuesSummary{total}}}}}';
const PARENT_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number state body labels(first:50){nodes{name}} subIssues(first:100){nodes{number state body blockedBy(first:50){nodes{number state repository{nameWithOwner}}}}}}}}';

const RANGE = String.raw`\s*(?:～|~|〜|–|—|至|到)\s*`;
const END = String.raw`Q\d+(?!\d)(?:${RANGE}(?:R\d+-)?Q\d+(?!\d))?`;
// 一串決策：第一個要帶輪次，之後以 `、` `,` `，` `/` 接的項目可以省略輪次（`R2-Q1、Q2`），沿用前一個。
const DECISION_CHAIN = new RegExp(String.raw`R\d+-${END}(?:\s*[、,，/]\s*(?:R\d+-)?${END})*`, 'g');
const DECISION_ITEM = new RegExp(String.raw`(?:R(\d+)-)?Q(\d+)(?!\d)(?:${RANGE}(?:R(\d+)-)?Q(\d+)(?!\d))?`, 'g');
const SECTION = /^(#{2,6})\s*(?:已確認(?:的)?決[策定]|confirmed decisions)/i;
const ACCEPTANCE = /^##\s*驗收/m;

/** 文字裡的決策編號：同輪範圍展開成每個編號，跨輪範圍（R2-Q4～R3-Q2）收進 crossRanges。 */
export function decisionsIn(text) {
  const numbers = new Set();
  const crossRanges = [];
  for (const [chain] of (text ?? '').matchAll(DECISION_CHAIN)) {
    let round;
    for (const [, r = round, q, r2, q2] of chain.matchAll(DECISION_ITEM)) {
      round = r2 ?? r;
      if (q2 === undefined) numbers.add(`R${r}-Q${q}`);
      else if (r2 !== undefined && r2 !== r) crossRanges.push(`R${r}-Q${q}～R${r2}-Q${q2}`);
      else for (let i = Math.min(+q, +q2); i <= Math.max(+q, +q2); i++) numbers.add(`R${r}-Q${i}`);
    }
  }
  return { numbers, crossRanges };
}

/** 母單本文的已確認決策段：標題到下一個同級或更高級的標題為止，逐行。 */
function decisionLines(body) {
  const lines = (body ?? '').split('\n');
  const start = lines.findIndex(line => SECTION.test(line));
  if (start < 0) return [];
  const level = lines[start].match(SECTION)[1].length;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const heading = line.match(/^(#{1,6})\s/);
    if (heading && heading[1].length <= level) break;
    out.push(line);
  }
  return out;
}

const isOpen = ({ state }) => state === 'OPEN';
const children = parent => parent.subIssues.nodes;
const openBlockers = (issue, repo) => new Set(issue.blockedBy.nodes.filter(({ repository }) => repository.nameWithOwner === repo).map(({ number }) => number));
const proseCandidates = (issue, repo) => {
  const listed = openBlockers(issue, repo);
  return proseDeps(issue.body).filter(m => m !== issue.number && !listed.has(m));
};
// 決策行把編號送到別張單的寫法：`→ #88`、`-> #88`、「見 #13」、「#13 的內文」；只是提到（「依 #94 的規則」）不算。
const REDIRECT = /(?:(?:→|->|見)\s*#(\d+)\b|(?<![\w/.-])#(\d+)\s*的內文)/g;
const redirects = line => [...line.matchAll(REDIRECT)].map(([, a, b]) => Number(a ?? b));

/** 要另外查狀態或本文的號碼：開著的子單本文依賴、不在 blocked_by 的單，與決策段裡送去的單（子單本身不必查）。升冪、不重複。 */
export function refsNeeded(parent, repo) {
  const own = new Set(children(parent).map(({ number }) => number));
  const out = new Set();
  for (const issue of children(parent).filter(isOpen)) for (const m of proseCandidates(issue, repo)) out.add(m);
  for (const line of decisionLines(parent.body)) if (decisionsIn(line).numbers.size) for (const m of redirects(line)) if (!own.has(m)) out.add(m);
  return [...out].sort((a, b) => a - b);
}

/**
 * 一張母單的提示行。others 是 refsNeeded 那些號碼的 `{ state, body }`（Map<number, …>），查不到的號碼當作沒有本文、不是開著。
 */
export function parentHints(parent, others, repo) {
  const p = parent.number;
  const kids = children(parent);
  const out = [];
  if (isOpen(parent) && kids.length && !kids.some(isOpen)) out.push(`PARENT_ALL_CLOSED ${p} ${kids.map(({ number }) => `#${number}`).join(' ')}`);
  const triage = parent.labels.nodes.map(({ name }) => name).filter(name => TRIAGE_STATES.includes(name));
  if (triage.length) out.push(`PARENT_TRIAGE_LABEL ${p} ${triage.join(',')}`);
  const prose = kids.filter(isOpen)
    .map(issue => [issue.number, proseCandidates(issue, repo).filter(m => (others.get(m) ?? kids.find(({ number }) => number === m))?.state === 'OPEN')])
    .filter(([, deps]) => deps.length);
  if (prose.length) out.push(`PARENT_PROSE_DEPS ${p} ${prose.map(([c, deps]) => `#${c}:${deps.map(m => `#${m}`).join(',')}`).join(' ')}`);
  const noAcceptance = kids.filter(issue => isOpen(issue) && !ACCEPTANCE.test(issue.body ?? ''));
  if (noAcceptance.length) out.push(`PARENT_NO_ACCEPTANCE ${p} ${noAcceptance.map(({ number }) => `#${number}`).join(' ')}`);
  const covered = decisionsIn(kids.map(({ body }) => body ?? '').join('\n')).numbers;
  const missing = new Set();
  const ranges = [];
  for (const line of decisionLines(parent.body)) {
    const { numbers, crossRanges } = decisionsIn(line);
    ranges.push(...crossRanges);
    const elsewhere = decisionsIn(redirects(line).map(m => others.get(m)?.body ?? '').join('\n')).numbers;
    for (const id of numbers) if (!covered.has(id) && !elsewhere.has(id)) missing.add(id);
  }
  if (missing.size) out.push(`PARENT_DECISIONS_MISSING ${p} ${[...missing].join(' ')}`);
  if (ranges.length) out.push(`PARENT_DECISION_RANGE ${p} ${ranges.join(' ')}`);
  return out;
}

class CliError extends Error {}
class UsageError extends Error {}
function gh(...args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new CliError(`gh ${args.slice(0, 2).join(' ')} 失敗：${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}
const graphql = (repo, query, vars = {}) => {
  const [owner, name] = repo.split('/');
  const fields = Object.entries(vars).flatMap(([key, value]) => ['-F', `${key}=${value}`]);
  return JSON.parse(gh('api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, ...fields, '-f', `query=${query}`)).data.repository;
};

function openParents(repo) {
  const out = [];
  for (let cursor = null, more = true; more;) {
    const page = graphql(repo, LIST_QUERY, cursor ? { cursor } : {}).issues;
    out.push(...page.nodes.filter(({ subIssuesSummary }) => subIssuesSummary.total > 0).map(({ number }) => number));
    ({ hasNextPage: more, endCursor: cursor } = page.pageInfo);
  }
  return out.sort((a, b) => a - b);
}

function lookup(repo, numbers) {
  if (!numbers.length) return new Map();
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map(n => `i${n}: issue(number:${n}){number state body}`).join(' ')}}}`;
  return new Map(Object.values(graphql(repo, query)).filter(Boolean).map(issue => [issue.number, issue]));
}

function trackerIsGithub() {
  let doc = null;
  try { doc = readFileSync('docs/agents/issue-tracker.md', 'utf8'); } catch {}
  const kind = trackerKind(doc);
  if (kind !== 'github' && kind !== 'none') throw new UsageError(`parent-hints 只支援 GitHub tracker（docs/agents/issue-tracker.md 是 ${kind}）`);
}

function main(argv) {
  let repo;
  const parents = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) repo = argv[++i];
    else if (/^\d+$/.test(argv[i])) parents.push(Number(argv[i]));
    else { console.error(USAGE); return 2; }
  }
  try {
    trackerIsGithub();
    repo ??= gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim();
    for (const n of parents.length ? parents : openParents(repo)) {
      const parent = graphql(repo, PARENT_QUERY, { number: n }).issue;
      if (!parent) throw new CliError(`gh api 失敗：查不到 #${n}`);
      for (const line of parentHints(parent, lookup(repo, refsNeeded(parent, repo)), repo)) console.log(line);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof CliError) && !(error instanceof UsageError)) throw error;
    console.error(error.message);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
