#!/usr/bin/env node
// /setup-workflow 的體檢：比對已導入專案的 adapter、文件與實際使用，回報落差，不寫任何檔。
// 用法：node health.mjs [<repo>]（repo 預設 cwd）
// 每個落差一行 `FINDING <類別> <說明>  # <證據>`，類別為 level（等級標示錯誤）、divergence（副本與正本分歧，兩邊都改了時下接縮排的 diff）、cross-repo（隱性跨 repo 依賴）；
// 最後一行 `HEALTHY`（exit 0）或 `FINDINGS <n>`（exit 1）。不是 git repo 時 exit 2。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? '.');
const git = (...rest) => {
  const result = spawnSync('git', ['-C', root, ...rest], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return result.status === 0 ? result.stdout.trim() : null;
};
if (git('rev-parse', '--show-toplevel') === null) {
  console.error(`health: ${root} 不是 git repo`);
  process.exit(2);
}

const lines = text => (text ? text.split('\n').filter(Boolean) : []);
const tracked = lines(git('ls-files'));
const read = path => readFileSync(join(root, path), 'utf8');

// 本 repo 的名稱：主 checkout 的目錄名（worktree 的目錄名不算），以及 origin 的 repo 名。
const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
const names = new Set([basename(dirname(commonDir))]);
const origin = git('remote', 'get-url', 'origin')?.match(/([^/:]+?)(\.git)?$/)?.[1];
if (origin) names.add(origin);

const adapterPath = 'docs/agents/issue-run.md';
const findings = [];
const finding = (kind, message, evidence, detail = []) => findings.push({ line: `FINDING ${kind} ${message}  # ${evidence}`, detail });

// 等級標示：文件中提到本 repo、且只提到一個等級的非表格行就是宣稱；和 detect.mjs 判定的實際等級不同就回報。
const detectScript = join(dirname(fileURLToPath(import.meta.url)), 'detect.mjs');
const detected = JSON.parse(spawnSync('node', [detectScript, root, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout);
const namePattern = new RegExp(`(^|[^\\w-])(${[...names].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`);
for (const path of tracked.filter(file => file.endsWith('.md'))) {
  read(path).split('\n').forEach((text, i) => {
    if (text.trimStart().startsWith('|') || !namePattern.test(text)) return;
    const claims = [...new Set(text.match(/\bL[0-3]\b/g) ?? [])];
    if (claims.length === 1 && claims[0] !== detected.level) {
      finding('level', `claimed ${claims[0]} detected ${detected.level}`, `${path}:${i + 1}`);
    }
  });
}

// 分歧：workflow-templates.json 記錄的 sha256、副本與目前正本（本腳本所在 repo 的檔案）三方比對。
const MANIFEST = 'docs/agents/workflow-templates.json';
const sourceRoot = spawnSync('git', ['-C', dirname(fileURLToPath(import.meta.url)), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const ADVICE = {
  'canonical-newer': '正本較新：經人確認後覆蓋（copy-templates.mjs --yes）',
  'local-modified': '專案本地改過：先把改動回饋到正本',
  'both-modified': '兩邊都改了：列出差異，交給人決定',
};
const manifest = existsSync(join(root, MANIFEST)) ? JSON.parse(read(MANIFEST)) : { copies: {} };
for (const [path, entry] of Object.entries(manifest.copies ?? {})) {
  const copy = join(root, path);
  const template = join(sourceRoot, entry.template);
  if (!existsSync(copy)) { finding('divergence', `missing-copy ${path} 清單有記錄但副本不存在`, MANIFEST); continue; }
  if (!existsSync(template)) { finding('divergence', `missing-canonical ${path} 正本 ${entry.template} 已不存在`, MANIFEST); continue; }
  const local = sha256(copy) !== entry.sha256;
  const upstream = sha256(template) !== entry.sha256;
  if (!local && !upstream) continue;
  const kind = local && upstream ? 'both-modified' : local ? 'local-modified' : 'canonical-newer';
  const diff = kind === 'both-modified' ? lines(spawnSync('git', ['diff', '--no-index', '--', copy, template], { encoding: 'utf8' }).stdout) : [];
  finding('divergence', `${kind} ${path} ${ADVICE[kind]}`, `${MANIFEST} sha256 ${entry.sha256.slice(0, 12)}、副本 ${sha256(copy).slice(0, 12)}、正本 ${entry.template} ${sha256(template).slice(0, 12)}`, diff);
}

// 隱性跨 repo 依賴：adapter、.claude/settings.json 與 scripts/ 裡家目錄下的絕對路徑，路徑中沒有本 repo 的名稱就是指向別的 repo。
// 家目錄下的設定目錄（~/.claude）與只到某個目錄本身（~/code/<repo>）的提及不算：依賴的是那個 repo 裡的檔案。
const HOME_PATH = /(?:~|\$\{?HOME\}?|\/home\/[\w.-]+|\/Users\/[\w.-]+)((?:\/[\w.@+-]+)+)/g;
const others = lines(git('ls-files', '--others', '--exclude-standard', 'scripts'));
const scanned = [adapterPath, '.claude/settings.json', ...[...tracked, ...others].filter(file => file.startsWith('scripts/'))];
for (const path of [...new Set(scanned)].filter(file => existsSync(join(root, file)))) {
  read(path).split('\n').forEach((text, i) => {
    for (const match of text.matchAll(HOME_PATH)) {
      const segments = match[1].replace(/\.+$/, '').split('/').filter(Boolean);
      if (segments.length < 3 || segments[0].startsWith('.') || segments.some(segment => names.has(segment))) continue;
      finding('cross-repo', `${match[0].replace(/\.+$/, '')} 指向本 repo 以外的檔案`, `${path}:${i + 1}`);
    }
  });
}

for (const { line, detail } of findings) console.log([line, ...detail.map(text => `  ${text}`)].join('\n'));
console.log(findings.length ? `FINDINGS ${findings.length}` : 'HEALTHY');
process.exit(findings.length ? 1 : 0);
