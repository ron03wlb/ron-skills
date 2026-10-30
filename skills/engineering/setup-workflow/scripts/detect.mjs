#!/usr/bin/env node
// /setup-workflow 的偵測：讀目標 repo 的檔案與 git 歷史，判定導入等級（L0–L3）與擴充，不寫任何檔。
// 用法：node detect.mjs [<repo>] [--json]（repo 預設 cwd）
// 文字輸出每個訊號一行 `SIGNAL <name> met|missing <value>`、每項擴充一行 `EXTENSION <name> <value> ...`，
// 接著 `RECOMMEND <等級>|none`，最後一行 `LEVEL <等級>`；--json 印同樣內容的物件。exit 0；不是 git repo 時 exit 2。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const json = args.includes('--json');
const root = resolve(args.find(arg => !arg.startsWith('--')) ?? '.');

const git = (...rest) => {
  const result = spawnSync('git', ['-C', root, ...rest], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return result.status === 0 ? result.stdout.trim() : null;
};
if (git('rev-parse', '--show-toplevel') === null) {
  console.error(`detect: ${root} 不是 git repo`);
  process.exit(2);
}

const read = path => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);
const files = (git('ls-files', '--cached', '--others', '--exclude-standard') ?? '').split('\n').filter(Boolean);
const lines = text => (text ? text.split('\n').filter(Boolean) : []);
const signal = (value, evidence, note) => ({ met: Boolean(value), value: value || null, evidence, ...(note && { note }) });

/** adapter 中 `## <heading>` 段的內文。 */
function section(adapter, heading) {
  const match = adapter?.match(new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return match ? match[1] : null;
}

const adapterPath = 'docs/agents/issue-run.md';
const adapter = read(adapterPath);

// 單一檢查入口：adapter Checks 段的第一個指令；第一段是 repo 內路徑（含 `/`）時檔案必須存在，PATH 上的指令（npm、node、bash…）直接採用。
function checkEntry() {
  const command = section(adapter, 'Checks')?.match(/`([^`]+)`/)?.[1];
  if (!command) return signal(null, [`${adapterPath} 沒有 Checks 段或其中沒有指令`]);
  const head = command.trim().split(/\s+/)[0];
  if (!head.includes('/') || existsSync(join(root, head))) return signal(command, [`${adapterPath} ## Checks`]);
  return signal(null, [`${adapterPath} ## Checks 寫的 ${head} 不存在`]);
}

// 跑檢查入口的 git hook：優先 pre-push，只有 pre-commit 也算（L2 的本地強制），並註明缺 pre-push。
function hook(check) {
  const configured = git('config', 'core.hooksPath');
  const dir = configured ? (isAbsolute(configured) ? configured : join(root, configured)) : git('rev-parse', '--path-format=absolute', '--git-path', 'hooks');
  const head = check.value?.trim().split(/\s+/)[0];
  const runs = name => {
    const path = join(dir, name);
    return head && existsSync(path) && readFileSync(path, 'utf8').includes(head) ? path : null;
  };
  const prePush = runs('pre-push');
  if (prePush) return signal('pre-push', [prePush]);
  const preCommit = runs('pre-commit');
  if (preCommit) return signal('pre-commit', [preCommit], '沒有 pre-push：pre-commit 檢查的是工作樹，不是要 push 的 SHA；建議補 pre-push（docs/workflow/04-level2.md#pre-push）');
  return signal(null, [`${dir} 沒有呼叫 ${head ?? '檢查入口'} 的 pre-push 或 pre-commit`]);
}

// 整合分支：本機或遠端名為 integration 的分支（可帶前綴，如 pilot/integration）。
function integration() {
  const refs = lines(git('for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'));
  const hit = refs.find(ref => /(^|\/)integration$/.test(ref) && !ref.startsWith('origin/')) ?? refs.find(ref => /(^|\/)integration$/.test(ref));
  return signal(hit, hit ? [`git branch: ${hit}`] : ['沒有名為 integration 的分支']);
}

// 每張 Issue 一個 worktree 的紀錄：現有 worktree 或合入紀錄裡帶 Issue 號碼的分支（issue/12-x、feature/ron/#12）。
const ISSUE_BRANCH = /\b(?:issue|feature|fix|bug)s?\/(?:[\w.-]+\/)*#?\d+\b[^\s'"]*/;
function worktrees() {
  const branches = lines(git('worktree', 'list', '--porcelain')).filter(line => line.startsWith('branch ')).map(line => line.slice(7).replace('refs/heads/', ''));
  const merges = lines(git('log', '--all', '--merges', '-n', '300', '--format=%s'));
  const hit = [...branches, ...merges].map(text => text.match(ISSUE_BRANCH)?.[0]).find(Boolean);
  return signal(hit, hit ? ['git worktree list／合入紀錄'] : ['worktree 與最近 300 個合入紀錄都沒有帶 Issue 號碼的分支']);
}

// 近期的 pilot 或 stage commit：90 天內的 commit 主旨提到 pilot/stage-<key> 或 stage batch-<key>。
function pilotCommits() {
  const subjects = lines(git('log', '--all', '-n', '300', '--since=90.days', '--format=%h %s'));
  const hit = subjects.find(subject => /\bpilot\/stage-|\bstage[\s-]batch-/i.test(subject));
  return signal(hit, hit ? ['git log --all --since=90.days'] : ['90 天內沒有 pilot/stage 或 stage batch commit']);
}

const check = checkEntry();
const trackerDoc = 'docs/agents/issue-tracker.md';
const signals = {
  tracker: existsSync(join(root, trackerDoc)) ? signal(trackerDoc, [trackerDoc]) : signal(null, [`${trackerDoc} 不存在`]),
  adapter: adapter !== null ? signal(adapterPath, [adapterPath]) : signal(null, [`${adapterPath} 不存在`]),
  check,
  integration: integration(),
  hook: hook(check),
  worktrees: worktrees(),
  pilot: section(adapter, 'Pilot') !== null ? signal('## Pilot', [`${adapterPath} ## Pilot`]) : signal(null, [`${adapterPath} 沒有 ## Pilot 段`]),
  pilotCommits: pilotCommits(),
};

const LEVEL_SIGNALS = { L1: ['tracker', 'adapter', 'check'], L2: ['integration', 'hook', 'worktrees'], L3: ['pilot', 'pilotCommits'] };
const levels = {};
let level = 'L0';
let reached = true;
for (const [name, keys] of Object.entries(LEVEL_SIGNALS)) {
  const missing = keys.filter(key => !signals[key].met);
  levels[name] = { met: missing.length === 0, missing };
  reached &&= missing.length === 0;
  if (reached) level = name;
}
const recommend = { L0: 'L1', L1: 'L2', L2: 'L3', L3: null }[level];

// 擴充：每項附偵測訊號（evidence）、要填的 adapter 段落與要帶入的正本。
const matching = pattern => files.filter(file => pattern.test(file));
const extension = (evidence, adapterSection, templates, value) => ({ detected: evidence.length > 0, value: value ?? (evidence.length > 0), evidence, section: adapterSection, templates });

function tracker() {
  const doc = read('docs/agents/issue-tracker.md');
  const value = doc === null ? 'none' : /\bglab\b/.test(doc) ? 'gitlab' : /\bgh\b/.test(doc) ? 'github' : 'local';
  const remote = git('remote', 'get-url', 'origin');
  const evidence = doc === null ? [] : ['docs/agents/issue-tracker.md'];
  if (doc === null && remote) evidence.push(`origin ${/gitlab/.test(remote) ? 'GitLab' : /github\.com/.test(remote) ? 'GitHub' : remote}（尚未設定 tracker）`);
  return { ...extension(evidence, 'Tracker', [], value), detected: doc !== null };
}

const manifests = matching(/(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|pyproject\.toml|go\.mod|Cargo\.toml)$/).filter(file => !file.includes('node_modules/'));
const manifestDirs = new Set(manifests.map(file => file.replace(/\/?[^/]+$/, '')));
const testcontainers = manifests.filter(file => /testcontainers/i.test(read(file) ?? ''));

const extensions = {
  tracker: tracker(),
  gated: extension([
    ...(section(adapter, 'Gated tickets') !== null ? [`${adapterPath} ## Gated tickets`] : []),
    ...matching(/\.sql$|(^|\/)(migrations?|migrate|changelog)\//i).slice(0, 5),
  ], 'Gated tickets', []),
  externalEnv: extension([...matching(/(^|\/)(docker-)?compose[^/]*\.ya?ml$/), ...testcontainers], 'Checks, Stops', []),
  multiModule: extension(manifestDirs.size >= 2 ? manifests : [], 'Checks', []),
  customTriage: extension([...new Set(matching(/^\.claude\/skills\/[^/]*(triage|grade|refine|分級)[^/]*\//i).map(file => file.split('/').slice(0, 3).join('/')))], 'Readiness', []),
  codex: extension([
    ...matching(/^\.codex\//).slice(0, 1),
    ...(/\bcodex\b/i.test(read('AGENTS.md') ?? '') ? ['AGENTS.md'] : []),
    ...(/\bcodex\b/i.test(adapter ?? '') ? [adapterPath] : []),
  ], 'Review', ['run-codex-review.mjs']),
};

const result = { root, level, recommend, levels, signals, extensions };
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const [name, s] of Object.entries(signals)) console.log(`SIGNAL ${name} ${s.met ? 'met' : 'missing'} ${s.value ?? '-'}  # ${s.evidence.join('; ')}${s.note ? `; ${s.note}` : ''}`);
  for (const [name, e] of Object.entries(extensions)) console.log(`EXTENSION ${name} ${e.value}  section=${e.section} templates=${e.templates.join(',') || '-'}  # ${e.evidence.join('; ') || '-'}`);
  for (const [name, l] of Object.entries(levels)) if (!l.met) console.log(`MISSING ${name} ${l.missing.join(',')}`);
  console.log(`RECOMMEND ${recommend ?? 'none'}`);
  console.log(`LEVEL ${level}`);
}
