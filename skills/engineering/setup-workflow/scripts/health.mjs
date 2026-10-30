#!/usr/bin/env node
// /setup-workflow 的體檢：比對已導入專案的 adapter、文件與實際使用，回報落差，不寫任何檔。
// 用法：node health.mjs [<repo>]（repo 預設 cwd；不收任何旗標）
// 每個落差一行 `FINDING <類別> <說明>  # <證據>`，類別為 level（等級標示錯誤）、divergence（副本與正本分歧，兩邊都改了時下接縮排的 diff）、cross-repo（隱性跨 repo 依賴）；
// 最後一行 `HEALTHY`（exit 0）或 `FINDINGS <n>`（exit 1）。帶旗標、不是 git repo 或 detect.mjs 失敗時 exit 2。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = message => { console.error(`health: ${message}`); process.exit(2); };
const args = process.argv.slice(2);
if (args.some(arg => arg.startsWith('-')) || args.length > 1) fail('用法：health.mjs [<repo>]');
const root = resolve(args[0] ?? '.');
const here = dirname(fileURLToPath(import.meta.url));
const run = (command, ...rest) => {
  const result = spawnSync(command, rest, { encoding: 'utf8', maxBuffer: 64 << 20 });
  return result.status === 0 ? result.stdout.trim() : null;
};
const git = (...rest) => run('git', '-C', root, ...rest);
if (git('rev-parse', '--show-toplevel') === null) fail(`${root} 不是 git repo`);

const lines = text => (text ? text.split('\n').filter(Boolean) : []);
// 已追蹤與未追蹤（不含 gitignore）的檔案；工作樹裡刪掉的不算。
const files = lines(git('ls-files', '--cached', '--others', '--exclude-standard')).filter(file => existsSync(join(root, file)));
const read = path => readFileSync(join(root, path), 'utf8');

// 本 repo 的名稱：主 checkout 的目錄名（worktree 的目錄名不算），以及 origin 的 repo 名。
const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
const names = new Set([basename(dirname(commonDir))]);
const origin = git('remote', 'get-url', 'origin')?.match(/([^/:]+?)(\.git)?$/)?.[1];
if (origin) names.add(origin);

const adapterPath = 'docs/agents/issue-run.md';
const findings = [];
const finding = (kind, message, evidence, detail = []) => findings.push({ line: `FINDING ${kind} ${message}  # ${evidence}`, detail });

// 等級標示：只提到一個等級的非表格行，在 adapter 裡、或在其他 Markdown 裡且提到本 repo，就是宣稱；和 detect.mjs 判定的實際等級不同就回報。
const detectOutput = run('node', join(here, 'detect.mjs'), root, '--json');
if (detectOutput === null) fail('detect.mjs 失敗');
const detected = JSON.parse(detectOutput);
const namePattern = new RegExp(`(^|[^\\w-])(${[...names].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`);
for (const path of files.filter(file => file.endsWith('.md'))) {
  read(path).split('\n').forEach((text, i) => {
    if (text.trimStart().startsWith('|') || (path !== adapterPath && !namePattern.test(text))) return;
    const claims = [...new Set(text.match(/\bL[0-3]\b/g) ?? [])];
    if (claims.length === 1 && claims[0] !== detected.level) {
      finding('level', `claimed ${claims[0]} detected ${detected.level}`, `${path}:${i + 1}`);
    }
  });
}

// 分歧：workflow-templates.json 記錄的 sha256、副本與目前正本（本腳本所在 repo 的檔案）三方比對。
const MANIFEST = 'docs/agents/workflow-templates.json';
const sourceRoot = run('git', '-C', here, 'rev-parse', '--show-toplevel');
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
  if (typeof entry.sha256 !== 'string' || typeof entry.template !== 'string') { finding('divergence', `invalid-entry ${path} 清單項目缺 template 或 sha256`, MANIFEST); continue; }
  if (!existsSync(copy)) { finding('divergence', `missing-copy ${path} 清單有記錄但副本不存在`, MANIFEST); continue; }
  if (!existsSync(template)) { finding('divergence', `missing-canonical ${path} 正本 ${entry.template} 已不存在`, MANIFEST); continue; }
  const [copySha, canonicalSha] = [sha256(copy), sha256(template)];
  const copyChanged = copySha !== entry.sha256;
  const canonicalChanged = canonicalSha !== entry.sha256;
  if (!copyChanged && !canonicalChanged) continue;
  const kind = copyChanged && canonicalChanged ? 'both-modified' : copyChanged ? 'local-modified' : 'canonical-newer';
  const diff = kind === 'both-modified' ? lines(spawnSync('git', ['diff', '--no-index', '--', copy, template], { encoding: 'utf8' }).stdout) : [];
  finding('divergence', `${kind} ${path} ${ADVICE[kind]}`, `${MANIFEST} sha256 ${entry.sha256.slice(0, 12)}、副本 ${copySha.slice(0, 12)}、正本 ${entry.template} ${canonicalSha.slice(0, 12)}`, diff);
}

// 隱性跨 repo 依賴：adapter、.claude/settings.json 與 scripts/、bin/、git hook 目錄裡家目錄下的絕對路徑，路徑中沒有本 repo 的名稱就是指向別的 repo。
// 家目錄下的設定目錄（~/.claude）與只到某個目錄本身（~/code/<repo>）的提及不算：依賴的是那個 repo 裡的檔案，
// 所以路徑要指到檔案（最後一段有副檔名，如 ~/spay2/send.mjs），或在家目錄下至少三段（~/code/spay2/scripts）。
const HOME_PATH = /(?:~|\$\{?HOME\}?|\/home\/[\w.-]+|\/Users\/[\w.-]+)((?:\/[\w.@+-]+)+)/g;
const hooksPath = git('config', 'core.hooksPath');
const scriptDirs = ['scripts/', 'bin/', '.githooks/', '.husky/', ...(hooksPath && !hooksPath.startsWith('/') ? [`${hooksPath.replace(/\/?$/, '/')}`] : [])];
const scanned = files.filter(file => file === adapterPath || file === '.claude/settings.json' || scriptDirs.some(dir => file.startsWith(dir)));
for (const path of scanned) {
  read(path).split('\n').forEach((text, i) => {
    for (const match of text.matchAll(HOME_PATH)) {
      const segments = match[1].replace(/\.+$/, '').split('/').filter(Boolean);
      const toFile = /\.\w+$/.test(segments.at(-1));
      if (segments.length < (toFile ? 2 : 3) || segments[0].startsWith('.') || segments.some(segment => names.has(segment))) continue;
      finding('cross-repo', `${match[0].replace(/\.+$/, '')} 指向本 repo 以外的檔案`, `${path}:${i + 1}`);
    }
  });
}

for (const { line, detail } of findings) console.log([line, ...detail.map(text => `  ${text}`)].join('\n'));
console.log(findings.length ? `FINDINGS ${findings.length}` : 'HEALTHY');
process.exit(findings.length ? 1 : 0);
