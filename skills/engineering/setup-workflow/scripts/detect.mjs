#!/usr/bin/env node
// /setup-workflow 的偵測：讀目標 repo 的檔案與 git 歷史，判定導入等級（L0–L3）與擴充，不寫任何檔。
// 用法：node detect.mjs [<repo>] [--json]（repo 預設 cwd）
// 文字輸出每個訊號一行 `SIGNAL <name> met|missing <value>`、每項擴充一行 `EXTENSION <name> <value> ...`，
// 每個缺口一行 `GAP <name> <原因>`（不是等級訊號，不影響 LEVEL；目前只有 ci：程式碼 host 不是 local，卻沒有 CI 檔或 CI 檔沒呼叫檢查入口），
// 接著 `RECOMMEND <等級>|none`，最後一行 `LEVEL <等級>`；--json 印同樣內容的物件（缺口在 gaps）。exit 0；不是 git repo 時 exit 2。
//
// 環境站：node detect.mjs [<repo>] --env [--copy <template>...] [--json]，只看這台機器，repo 只讀它的 CI 設定，不必是 git repo。
// 每項一行：`ENV platform <macos|wsl|linux|…>`、必要工具 `REQUIRED <name> met|missing|skipped <value>`、
// 選用工具 `OPTIONAL <name> met|missing <value>`（缺了只記錄，它解鎖的等級或擴充列入 unavailable）；
// 每個停點一行 `STOP <name> <原因>` 加一行 `FIX <name> <修正指令>`，最後一行 `ENV ok`（exit 0）或 `ENV stop <n>`（exit 1）。
// --copy 是這次要複製的正本，含 `.py` 時才檢查 Python。測試以 DETECT_PLATFORM、DETECT_PROC_VERSION（檔案路徑）、DETECT_NODE_VERSION
// 取代 process.platform、/proc/version 與 process.versions.node。
//
// Host 站：node detect.mjs [<repo>] --host [--json]，只讀 repo 的 docs/agents/issue-tracker.md 與 origin，不寫檔。
// `HOST tracker <github|gitlab|local> <主機|->`、`HOST code <github|gitlab|local> <主機|->` 各一行（判定規則見 ../templates/lib/hosts.mjs），
// 每個要用到的 CLI 一行 `CLI <gh|glab> met|missing|unauthenticated <主機|->`（local 不需要 CLI，交付端略過），
// 停點同環境站印 `STOP`／`FIX`，最後一行 `HOST ok`（exit 0）或 `HOST stop <n>`（exit 1）。DETECT_PLATFORM 同環境站，決定安裝提示。
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { CLI, codeHost, hostInDoc, trackerKind } from '../templates/lib/hosts.mjs';
import { ciGap } from './ci.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const copyAt = args.indexOf('--copy');
const copyEnd = copyAt < 0 ? -1 : args.findIndex((arg, i) => i > copyAt && arg.startsWith('--'));
const copy = copyAt < 0 ? [] : args.slice(copyAt + 1, copyEnd < 0 ? undefined : copyEnd);
const root = resolve(args.find((arg, i) => !arg.startsWith('--') && !(copyAt >= 0 && i > copyAt && (copyEnd < 0 || i < copyEnd))) ?? '.');

if (args.includes('--env')) process.exit(environment());
if (args.includes('--host')) process.exit(hostStation());

/** PATH 上（或絕對路徑）可執行的檔案；沒有時 null。 */
function which(name) {
  const executable = path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  };
  if (name.includes('/')) return executable(name) ? name : null;
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, name)).find(executable) ?? null;
}

/** `<command> --version` 的第一行（python 2 印在 stderr）；失敗時 null。 */
function versionOf(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 ? `${result.stdout}${result.stderr}`.trim().split('\n')[0] || null : null;
}

// 環境站：平台、必要工具（node、git、要複製 .py 時的 Python）與選用工具（Orca、Codex）。setup 不安裝、不切換 runtime，不符只給修正指令。
function environment() {
  const name = process.env.DETECT_PLATFORM ?? process.platform;
  const procPath = process.env.DETECT_PROC_VERSION ?? '/proc/version'; // portability-ok: 只在 process.platform 是 linux 時讀，WSL 判定的依據
  const wsl = name === 'linux' && existsSync(procPath) && /microsoft/i.test(readFileSync(procPath, 'utf8'));
  const platform = name === 'darwin' ? { value: 'macos', evidence: ['process.platform darwin'] }
    : name === 'linux' ? { value: wsl ? 'wsl' : 'linux', evidence: [`process.platform linux；${procPath} ${wsl ? '含' : '不含'} microsoft`] }
    : { value: name, evidence: [`process.platform ${name}`] };
  const install = { git: { macos: 'xcode-select --install', other: 'sudo apt install git' }, python: { macos: 'brew install python', other: 'sudo apt install python3' } };
  const installHint = tool => install[tool][platform.value === 'macos' ? 'macos' : 'other'];

  // node：以 CI 鎖定的版本為準，同 ron-skills scripts/check-node-version.mjs 的規則（各 workflow 一致、主版本等於本機），
  // 另讀 setup-node 的 node-version-file（.nvmrc 等）。和它不同的是 CI 沒有鎖版本時不擋：目標 repo 不一定有 CI。
  function nodeRuntime() {
    const local = process.env.DETECT_NODE_VERSION ?? process.versions.node;
    const dir = join(root, '.github/workflows');
    // 版本取開頭的數字段（24.x 取 24）；YAML 註解行不算。
    const leading = text => text.trim().match(/^v?(\d+(?:\.\d+)*)/)?.[1];
    const pinned = path => (existsSync(join(root, path)) && statSync(join(root, path)).isFile() ? leading(readFileSync(join(root, path), 'utf8')) : null);
    const pins = (existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter(file => /\.ya?ml$/.test(file)).sort() : [])
      .flatMap(file => [...readFileSync(join(dir, file), 'utf8').matchAll(/^[^#\n]*?node-version(-file)?:\s*['"]?([^'"\s#]+)/gm)]
        .map(([, fromFile, value]) => ({ file, version: fromFile ? pinned(value) : leading(value) }))
        .filter(pin => pin.version));
    if (!pins.length) return { met: true, value: local, required: null, evidence: ['.github/workflows 沒有鎖定 node-version'] };
    const split = pins.find(pin => pin.version !== pins[0].version);
    if (split) {
      return { met: false, value: local, required: null, evidence: pins.map(pin => `${pin.file} ${pin.version}`),
        reason: `CI 的 node-version 不一致：${split.file} 是 ${split.version}，${pins[0].file} 是 ${pins[0].version}`, fix: '把所有 workflow 的 node-version 改成同一版，再重跑環境站' };
    }
    const required = pins[0].version;
    const met = required.split('.')[0] === local.split('.')[0];
    return { met, value: local, required, evidence: [`.github/workflows/${pins[0].file} node-version ${required}`],
      ...(!met && { reason: `本機 Node ${local}，CI 鎖定 ${required}，主版本要相同`, fix: `nvm install ${required} && nvm use ${required}` }) };
  }

  // git：detect 與正本都用 `rev-parse --path-format`，要 2.31 以上。
  function gitTool() {
    const path = which('git');
    const value = path && versionOf(path);
    const [, major, minor] = value?.match(/(\d+)\.(\d+)/) ?? [];
    if (!major) return { met: false, value: null, evidence: ['PATH 上沒有 git'], reason: '找不到 git', fix: installHint('git') };
    const met = Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 31);
    return { met, value, evidence: [`${path} --version；需要 2.31 以上`], ...(!met && { reason: `git ${major}.${minor} 低於 2.31`, fix: installHint('git') }) };
  }

  function python() {
    const scripts = copy.filter(file => file.endsWith('.py'));
    if (!scripts.length) return { met: null, value: null, evidence: ['要複製的正本沒有 .py'] };
    // 只認 python3：pilot_git.py 的 allow rule 與 adapter 指令都寫 `python3 scripts/pilot_git.py`。
    const path = which('python3');
    const value = path && versionOf(path);
    if (/^Python 3\./.test(value ?? '')) return { met: true, value, evidence: [`${path}；要複製 ${scripts.join('、')}`] };
    return { met: false, value: null, evidence: [path ? `${path} --version 失敗或不是 Python 3` : 'PATH 上沒有 python3'], reason: `要複製的 ${scripts.join('、')} 需要 Python 3`, fix: installHint('python') };
  }

  const orcaCommand = process.env.ORCA_CLI_COMMAND;
  const orcaPath = orcaCommand ? which(orcaCommand) : null;
  const codexPath = which('codex');
  const optional = {
    orca: { met: Boolean(orcaPath), value: orcaPath, unlocks: 'L3',
      evidence: [orcaPath ? 'ORCA_CLI_COMMAND' : orcaCommand ? `ORCA_CLI_COMMAND 指向的 ${orcaCommand} 不存在或不可執行` : 'ORCA_CLI_COMMAND 未設定'] },
    codex: { met: Boolean(codexPath), value: codexPath && (versionOf(codexPath) ?? codexPath), unlocks: 'codex', evidence: [codexPath ?? 'PATH 上沒有 codex'] },
  };
  const required = { node: nodeRuntime(), git: gitTool(), python: python() };
  const stops = [
    ...(name === 'win32' ? [{ name: 'platform', reason: '原生 Windows 不支援', fix: '改在 WSL2 裡執行（wsl --install），在 WSL2 的 checkout 重跑 /setup-workflow' }]
      : !['macos', 'wsl', 'linux'].includes(platform.value) ? [{ name: 'platform', reason: `不支援的平台 ${name}`, fix: '改在 macOS、WSL2 或一般 Linux 上執行' }] : []),
    ...Object.entries(required).filter(([, tool]) => tool.met === false).map(([tool, { reason, fix }]) => ({ name: tool, reason, fix })),
  ];
  const unavailable = Object.values(optional).filter(tool => !tool.met).map(tool => tool.unlocks);
  const result = { root, platform, required, optional, unavailable, stops, ok: stops.length === 0 };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ENV platform ${platform.value}  # ${platform.evidence.join('; ')}`);
    for (const [tool, s] of Object.entries(required)) {
      const state = s.met === null ? 'skipped' : s.met ? 'met' : 'missing';
      console.log(`REQUIRED ${tool} ${state} ${s.value ?? '-'}  # ${[...s.evidence, ...(s.required ? [`需要 ${s.required.split('.')[0]}.x`] : [])].join('; ')}`);
    }
    for (const [tool, s] of Object.entries(optional)) console.log(`OPTIONAL ${tool} ${s.met ? 'met' : 'missing'} ${s.value ?? '-'}  # ${s.evidence.join('; ')}${s.met ? '' : `；${s.unlocks} 不可選`}`);
    for (const stop of stops) console.log(`STOP ${stop.name} ${stop.reason}\nFIX ${stop.name} ${stop.fix}`);
    console.log(stops.length ? `ENV stop ${stops.length}` : 'ENV ok');
  }
  return stops.length ? 1 : 0;
}

// Host 站：tracker host 與程式碼 host 分開判定，可以不同；非 local 的 host 要有對應 CLI 並已登入該主機。
function hostStation() {
  const run = (command, rest) => spawnSync(command, rest, { encoding: 'utf8', timeout: 20_000 });
  const origin = run('git', ['-C', root, 'remote', 'get-url', 'origin']);
  const originUrl = origin.status === 0 ? origin.stdout.trim() : null;
  const code = { ...codeHost(originUrl), evidence: [originUrl ? `origin ${originUrl}` : '沒有 origin remote'] };
  const trackerDoc = 'docs/agents/issue-tracker.md';
  const docPath = join(root, trackerDoc);
  const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : null;
  const kind = trackerKind(doc);
  // 還沒有 tracker 文件時依 origin 推定（setup 之後才寫這份文件）。
  // 和程式碼不同種的 tracker 先從文件網址找主機；GitHub 找不到時用 github.com，GitLab 找不到時不帶 --hostname，查 glab 的預設主機。
  const tracker = kind === 'none'
    ? { value: code.value, host: code.host, evidence: [`${trackerDoc} 不存在，依 origin 推定`] }
    : { value: kind, host: kind === 'local' ? null : kind === code.value ? code.host : hostInDoc(doc, kind) ?? (kind === 'github' ? 'github.com' : null),
        evidence: [`${trackerDoc} 寫 ${CLI[kind] ?? '本機 Markdown（沒有 gh、glab）'}`] };

  const macos = (process.env.DETECT_PLATFORM ?? process.platform) === 'darwin';
  // glab 官方只支援 Homebrew（含 Linux、WSL）；gh 在 Linux 走官方 apt 來源。
  const installHint = { gh: macos ? 'brew install gh' : '照 https://github.com/cli/cli/blob/trunk/docs/install_linux.md 加入 apt 來源後 sudo apt install gh', glab: 'brew install glab' };
  const needs = new Map();
  for (const side of [tracker, code]) {
    if (side.value === 'local') continue;
    const cli = CLI[side.value];
    needs.set(cli, [...new Set([...(needs.get(cli) ?? []), side.host])]);
  }
  const cli = {};
  const stops = [];
  for (const [name, hosts] of needs) {
    const path = which(name);
    if (!path) {
      cli[name] = { met: false, state: 'missing', path: null, hosts, evidence: [`PATH 上沒有 ${name}`] };
      stops.push({ name, reason: `找不到 ${name}`, fix: installHint[name] });
      continue;
    }
    const checks = hosts.map(host => ({ host, loggedIn: run(path, ['auth', 'status', ...(host ? ['--hostname', host] : [])]).status === 0 }));
    const missing = checks.filter(check => !check.loggedIn);
    cli[name] = { met: missing.length === 0, state: missing.length ? 'unauthenticated' : 'met', path, hosts,
      evidence: checks.map(check => `${name} auth status${check.host ? ` --hostname ${check.host}` : ''} ${check.loggedIn ? 'exit 0' : '失敗'}`) };
    for (const { host } of missing) stops.push({ name, reason: `${name} 沒有登入 ${host ?? '預設主機'}`, fix: `${name} auth login${host ? ` --hostname ${host}` : ''}` });
  }
  const result = { root, tracker, code, cli, stops, ok: stops.length === 0 };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const [side, s] of Object.entries({ tracker, code })) console.log(`HOST ${side} ${s.value} ${s.host ?? '-'}  # ${s.evidence.join('; ')}`);
    for (const [name, s] of Object.entries(cli)) console.log(`CLI ${name} ${s.state} ${s.hosts.map(host => host ?? '-').join(',')}  # ${s.evidence.join('; ')}`);
    if (!Object.keys(cli).length) console.log('CLI none -  # tracker 與程式碼 host 都是 local，交付端略過');
    for (const stop of stops) console.log(`STOP ${stop.name} ${stop.reason}\nFIX ${stop.name} ${stop.fix}`);
    console.log(stops.length ? `HOST stop ${stops.length}` : 'HOST ok');
  }
  return stops.length ? 1 : 0;
}

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
const trackerDoc = 'docs/agents/issue-tracker.md';
const adapter = read(adapterPath);

// 單一檢查入口：adapter Checks 段的第一個指令；第一段要是 PATH 上的指令或 repo 內的檔案，後面含 `/` 的參數（repo 內路徑）也必須存在，
// 選項的值（`--base origin/main`）不算路徑。adapter 還沒寫 Checks 時，改找現成的入口：bin/check、npm run check、make check。
const onPath = name => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { stdio: 'ignore' }).status === 0;
function existingEntry() {
  if (existsSync(join(root, 'bin/check'))) return 'bin/check';
  try { if (JSON.parse(read('package.json') ?? '{}').scripts?.check) return 'npm run check'; } catch { /* package.json 不合法視為沒有 */ }
  if (/^check:/m.test(read('Makefile') ?? '')) return 'make check';
  return null;
}
function checkEntry() {
  const command = section(adapter, 'Checks')?.match(/`([^`]+)`/)?.[1];
  if (!command) {
    const entry = existingEntry();
    return entry ? signal(entry, [`${entry}（adapter 尚未寫 Checks）`]) : signal(null, [`${adapterPath} 沒有 Checks 指令，repo 也沒有 bin/check、npm run check 或 make check`]);
  }
  const [head, ...rest] = command.trim().split(/\s+/);
  const paths = rest.filter((arg, i) => arg.includes('/') && !arg.startsWith('-') && !/^--[^=]+$/.test(rest[i - 1] ?? ''));
  const absent = [head.includes('/') || !onPath(head) ? head : null, ...paths].filter(path => path && !existsSync(join(root, path)));
  if (!absent.length) return signal(command, [`${adapterPath} ## Checks`]);
  return signal(null, [`${adapterPath} ## Checks 寫的 ${absent.join('、')} 不存在`]);
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
const extension = (evidence, adapterSection, templates) => ({ detected: evidence.length > 0, value: evidence.length > 0, evidence, section: adapterSection, templates });

const manifests = matching(/(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|pyproject\.toml|go\.mod|Cargo\.toml)$/).filter(file => !file.includes('node_modules/'));
const manifestDirs = new Set(manifests.map(file => file.replace(/\/?[^/]+$/, '')));
const testcontainers = manifests.filter(file => /testcontainers/i.test(read(file) ?? ''));

// tracker 與程式碼 host 不在這裡：由 Host 站（--host）判定。
const extensions = {
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

// 缺口：L2 該有、但不當等級訊號的設定（#139：加成訊號會讓現有 L2 專案被判回 L1）。
const origin = git('remote', 'get-url', 'origin');
const gaps = { ci: ciGap(root, check.value, codeHost(origin).value) };

const result = { root, level, recommend, levels, signals, extensions, gaps };
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const [name, s] of Object.entries(signals)) console.log(`SIGNAL ${name} ${s.met ? 'met' : 'missing'} ${s.value ?? '-'}  # ${s.evidence.join('; ')}${s.note ? `; ${s.note}` : ''}`);
  for (const [name, e] of Object.entries(extensions)) console.log(`EXTENSION ${name} ${e.value}  section=${e.section} templates=${e.templates.join(',') || '-'}  # ${e.evidence.join('; ') || '-'}`);
  for (const [name, l] of Object.entries(levels)) if (!l.met) console.log(`MISSING ${name} ${l.missing.join(',')}`);
  for (const [name, g] of Object.entries(gaps)) if (!g.met) console.log(`GAP ${name} ${g.evidence.join('; ')}`);
  console.log(`RECOMMEND ${recommend ?? 'none'}`);
  console.log(`LEVEL ${level}`);
}
