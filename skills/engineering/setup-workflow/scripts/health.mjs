#!/usr/bin/env node
// /setup-workflow 的體檢：比對已導入專案的 adapter、文件與實際使用，回報落差，不寫任何檔。
// 用法：node health.mjs [<repo>]（repo 預設 cwd；不收任何旗標）
// 每個落差一行 `FINDING <類別> <說明>  # <證據>`，類別為 level（等級標示錯誤）、divergence（副本與正本分歧，兩邊都改了時下接縮排的 diff）、cross-repo（隱性跨 repo 依賴）、
// unwired-hook（清單裡的 claude-hook-* 副本沒掛在 .claude/settings.json 的 hook）、missing-section（adapter 缺 `## Platforms`，或程式碼 host 不是 local 卻缺 `## Delivery`）、platform（Platforms 列了 macOS 時，scripts/、bin/、git hook 違反可攜性規則）；
// 最後一行 `HEALTHY`（exit 0）或 `FINDINGS <n>`（exit 1）。掃描時讀不到的檔案在 stderr 印 `health: 略過讀不到的 <path>：<code>` 後略過。
// 帶旗標、不是 git repo、detect.mjs 或 check-portability.mjs 失敗時 exit 2，沒有最後一行。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeHost } from '../templates/lib/hosts.mjs';

const fail = message => { console.error(`health: ${message}`); process.exit(2); };
const args = process.argv.slice(2);
if (args.some(arg => arg.startsWith('-')) || args.length > 1) fail('用法：health.mjs [<repo>]');
const root = resolve(args[0] ?? '.');
const here = dirname(fileURLToPath(import.meta.url));
const runRaw = (command, ...rest) => {
  const result = spawnSync(command, rest, { encoding: 'utf8', maxBuffer: 64 << 20 });
  return result.status === 0 ? result.stdout : null;
};
const run = (command, ...rest) => runRaw(command, ...rest)?.trim() ?? null;
const git = (...rest) => run('git', '-C', root, ...rest);
if (git('rev-parse', '--show-toplevel') === null) fail(`${root} 不是 git repo`);

const lines = text => (text ? text.split('\n').filter(Boolean) : []);
// 已追蹤與未追蹤（不含 gitignore）的檔案；工作樹裡刪掉的，以及其實是目錄的（指向目錄的 symlink、submodule）都不算。
// stat 失敗（不存在、symlink 迴圈、路徑太長）都當成不是檔案。用 -z：不然 core.quotePath 會把非 ASCII 路徑輸出成加引號的跳脫字串。
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
const files = (runRaw('git', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard') ?? '').split('\0').filter(Boolean).filter(file => isFile(join(root, file)));
const read = path => readFileSync(join(root, path), 'utf8');
// 掃描用：讀不到（EACCES 等）的檔案在 stderr 警告後略過，回傳 null。
const readOrWarn = path => {
  try { return read(path); } catch (error) { console.error(`health: 略過讀不到的 ${path}：${error.code ?? error.message}`); return null; }
};

// 本 repo 的名稱：主 checkout 的目錄名（worktree 的目錄名不算），以及 origin 的 repo 名。
const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
const names = new Set([basename(dirname(commonDir))]);
const originUrl = git('remote', 'get-url', 'origin');
const origin = originUrl?.match(/([^/:]+?)(\.git)?$/)?.[1];
if (origin) names.add(origin);

const adapterPath = 'docs/agents/issue-run.md';
const findings = [];
const finding = (kind, message, evidence, detail = []) => findings.push({ line: `FINDING ${kind} ${message}  # ${evidence}`, detail });

// 等級標示：只提到一個等級的非表格行，提到本 repo，或在 adapter 裡寫明「等級」（`導入等級：L3`、`Level: L2`），就是宣稱；
// adapter 裡描述某級機制的句子（`L2 起由 pre-push 重驗`）不算。和 detect.mjs 判定的實際等級不同就回報。
const detectOutput = run('node', join(here, 'detect.mjs'), root, '--json', '--no-station');
if (detectOutput === null) fail('detect.mjs 失敗');
const detected = JSON.parse(detectOutput);
const namePattern = new RegExp(`(^|[^\\w-])(${[...names].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`);
for (const path of files.filter(file => file.endsWith('.md'))) {
  readOrWarn(path)?.split('\n').forEach((text, i) => {
    if (text.trimStart().startsWith('|') || !(namePattern.test(text) || (path === adapterPath && /等級|\blevel\b/i.test(text)))) return;
    const claims = [...new Set(text.match(/\bL[0-3]\b/g) ?? [])];
    if (claims.length === 1 && claims[0] !== detected.level) {
      finding('level', `claimed ${claims[0]} detected ${detected.level}`, `${path}:${i + 1}`);
    }
  });
}

// 分歧：workflow-templates.json 記錄的 sha256、副本與目前正本（本腳本所在 repo 的檔案）三方比對。
const MANIFEST = 'docs/agents/workflow-templates.json';
const sourceRoot = run('git', '-C', here, 'rev-parse', '--show-toplevel') ?? fail(`${here} 不在 git repo 裡，找不到正本`);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const ADVICE = {
  'canonical-newer': '正本較新：經人確認後覆蓋（copy-templates.mjs --yes）',
  'local-modified': '專案本地改過：先把改動回饋到正本',
  'both-modified': '兩邊都改了：列出差異，交給人決定',
  'stale-record': '副本與正本一致，只有清單記錄過時：重跑 copy-templates.mjs 更新記錄',
};
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
let copies = {};
let manifestText = null;
if (existsSync(join(root, MANIFEST)) && !isFile(join(root, MANIFEST))) finding('divergence', `invalid-manifest ${MANIFEST} 不是檔案`, MANIFEST);
else if (existsSync(join(root, MANIFEST))) {
  try { manifestText = read(MANIFEST); } catch (error) { finding('divergence', `unreadable ${MANIFEST} 清單讀不到：${error.code ?? error.message}`, MANIFEST); }
}
if (manifestText !== null) {
  try {
    const manifest = JSON.parse(manifestText);
    if (!isObject(manifest) || ('copies' in manifest && !isObject(manifest.copies))) finding('divergence', `invalid-manifest ${MANIFEST} 要是物件，copies 也要是物件`, MANIFEST);
    else copies = manifest.copies ?? {};
  } catch (error) { finding('divergence', `invalid-manifest ${MANIFEST} 不是合法 JSON：${error.message}`, MANIFEST); }
}
// 清單記錄而且內容和記錄的 sha256 一致的副本：它的內容屬於正本，cross-repo 不掃（#281：範本測試檔裡的示範路徑）。
const pristine = new Set();
for (const [path, entry] of Object.entries(copies)) {
  if (typeof entry?.sha256 !== 'string' || typeof entry?.template !== 'string') { finding('divergence', `invalid-entry ${path} 清單項目缺 template 或 sha256`, MANIFEST); continue; }
  const copy = join(root, path);
  const template = join(sourceRoot, entry.template);
  if (!isFile(copy)) { finding('divergence', `missing-copy ${path} 清單有記錄但副本不存在`, MANIFEST); continue; }
  if (!isFile(template)) { finding('divergence', `missing-canonical ${path} 正本 ${entry.template} 已不存在`, MANIFEST); continue; }
  let copySha, canonicalSha;
  try { [copySha, canonicalSha] = [sha256(copy), sha256(template)]; } catch (error) {
    finding('divergence', `unreadable ${path} ${error.path === copy ? '副本' : `正本 ${entry.template} `}讀不到：${error.code ?? error.message}`, MANIFEST);
    continue;
  }
  const copyChanged = copySha !== entry.sha256;
  const canonicalChanged = canonicalSha !== entry.sha256;
  if (!copyChanged) pristine.add(path);
  if (!copyChanged && !canonicalChanged) continue;
  const kind = copySha === canonicalSha ? 'stale-record' : copyChanged && canonicalChanged ? 'both-modified' : copyChanged ? 'local-modified' : 'canonical-newer';
  const diff = kind === 'both-modified' ? lines(spawnSync('git', ['diff', '--no-index', '--', copy, template], { encoding: 'utf8' }).stdout) : [];
  finding('divergence', `${kind} ${path} ${ADVICE[kind]}`, `${MANIFEST} commit ${typeof entry.commit === 'string' && entry.commit ? entry.commit : '(未記錄)'} sha256 ${entry.sha256.slice(0, 12)}、副本 ${copySha.slice(0, 12)}、正本 ${entry.template} ${canonicalSha.slice(0, 12)}`, diff);
}

// 沒掛上的 hook：清單裡的 claude-hook-* 副本（測試檔除外）要出現在 .claude/settings.json 某個 hook 的 command，否則複製了也不會生效（#246）。
const settingsPath = '.claude/settings.json';
let hookCommands = [];
if (isFile(join(root, settingsPath))) {
  try {
    const hooks = JSON.parse(read(settingsPath))?.hooks ?? {};
    hookCommands = Object.values(hooks).flat().flatMap(group => group?.hooks ?? []).map(hook => hook?.command).filter(command => typeof command === 'string');
  } catch { /* 格式錯誤的 settings 由 check-claude-settings 把關，這裡當成沒有 hook */ }
}
for (const path of Object.keys(copies).filter(path => /^claude-hook-.*(?<!\.test\.mjs)$/.test(basename(path)))) {
  if (!hookCommands.some(command => command.includes(path))) finding('unwired-hook', `${path} 沒有掛在任何 hook：照 setup-workflow Templates 那一列掛進 ${settingsPath}`, settingsPath);
}

// 缺段落：adapter 存在時，`## Platforms` 一律要有；程式碼 host 不是 local（origin 指向網路主機）時還要 `## Delivery`。
// 補法是重跑 /setup-workflow 逐站確認後補齊，不另寫遷移 script。
const adapterText = isFile(join(root, adapterPath)) ? readOrWarn(adapterPath) : null;
// 段落標題不分大小寫（`## platforms` 也算），標題後面可以接說明；回傳到下一個 `## ` 之前的內文，沒有這段時 null。
// code fence（``` 或 ~~~ 開頭的行之間）裡的 `## ` 是範例，不是標題。
const adapterLines = adapterText?.split('\n') ?? [];
let fenced = false;
const headings = adapterLines.map(text => {
  if (/^\s*(?:```|~~~)/.test(text)) { fenced = !fenced; return false; }
  return !fenced && /^##\s/.test(text);
});
const section = name => {
  const start = adapterLines.findIndex((text, i) => headings[i] && new RegExp(`^##\\s+${name}\\b`, 'i').test(text));
  if (start < 0) return null;
  const end = headings.findIndex((heading, i) => i > start && heading);
  return adapterLines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};
if (adapterText !== null) {
  const required = ['Platforms', ...(codeHost(originUrl).value === 'local' ? [] : ['Delivery'])];
  for (const name of required.filter(name => section(name) === null)) {
    finding('missing-section', `${name} adapter 缺 ## ${name}：重跑 /setup-workflow 逐站確認後補齊`, adapterPath);
  }
}

// 隱性跨 repo 依賴：adapter、.claude/settings.json 與 scripts/、bin/、git hook 目錄裡家目錄下的絕對路徑，路徑中沒有本 repo 的名稱就是指向別的 repo。
// 家目錄下的設定目錄（~/.claude）與只到某個目錄本身（~/code/<repo>）的提及不算：依賴的是那個 repo 裡的檔案，
// 所以路徑要指到檔案（最後一段有副檔名，如 ~/spay2/send.mjs），或在家目錄下至少三段（~/code/spay2/scripts）。
// bash 常在路徑中間開關雙引號（"$HOME"/code/x、"$HOME/code/x"/y，JSON 裡寫成 \"$HOME\"/code/x），所以每個 / 前後可以接一個（跳脫的）雙引號，比對前去掉；
// 反斜線只在接著雙引號時才算，regex 字面值裡跳脫的斜線（\/）不是路徑；
// '$HOME'/code/x 這種只把家目錄單引號起來的寫法，以及後面緊接雙引號的 ~（"~"/code/x、~"/code/x"）都不會展開，不算；
// JSON 字串值開頭的 ~（"command":"~/code/x"）交給 shell 時會展開，照算。
const HOME_PATH = /(?:~(?!\\?")|\$\{?HOME\}?|\/home\/[\w.-]+|\/Users\/[\w.-]+)((?:(?:\\?")?\/(?:\\?")?[\w.@+-]+)+)/g;
const unquote = text => text.replace(/\\?"/g, '').replace(/\.+$/, '');
const hooksPath = git('config', 'core.hooksPath');
const scriptDirs = ['scripts/', 'bin/', '.githooks/', '.husky/', ...(hooksPath && !hooksPath.startsWith('/') ? [`${hooksPath.replace(/\/?$/, '/')}`] : [])];
const scanned = files.filter(file => !pristine.has(file)).filter(file => file === adapterPath || file === '.claude/settings.json' || scriptDirs.some(dir => file.startsWith(dir)));
const unreadable = new Set();
for (const file of scanned) {
  const content = readOrWarn(file);
  if (content === null) unreadable.add(file);
  content?.split('\n').forEach((text, i) => {
    for (const match of text.matchAll(HOME_PATH)) {
      const path = unquote(match[0]);
      const segments = unquote(match[1]).split('/').filter(Boolean);
      const toFile = /\.\w+$/.test(segments.at(-1));
      if (segments.length < (toFile ? 2 : 3) || segments[0].startsWith('.') || segments.some(segment => names.has(segment))) continue;
      finding('cross-repo', `${path} 指向本 repo 以外的檔案`, `${file}:${i + 1}`);
    }
  });
}

// 平台：adapter 的 Platforms 列了 macOS 時，對 scripts/、bin/ 與 git hook 目錄跑可攜性規則。規則只在正本 templates/check-portability.mjs（#86），
// 這裡在目標 repo 執行它，只把這些目錄裡讀得到的檔案當路徑參數交給它，所以它的結果都在範圍內（讀不到的上面已在 stderr 略過；範圍外的檔案它不讀）；
// 它印 `<file>:<line>: <規則> <改法>`（只差大小寫的是 `<file>: case …`，沒有行號）。沒有路徑時不跑：不帶參數它會掃整個 repo。
const portable = scanned.filter(file => scriptDirs.some(dir => file.startsWith(dir)) && !unreadable.has(file));
if (/\bmacOS\b/i.test(section('Platforms') ?? '') && portable.length) {
  const result = spawnSync('node', [join(here, '../templates/check-portability.mjs'), ...portable], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  // 它拋例外（讀不到的檔案、git 失敗）時同樣 exit 1，stderr 是 stack trace：有任何一行不是違規格式就當成沒跑成。
  // Node 的執行期警告（`(node:<pid>) …Warning: …` 與接著的 `(Use \`node --trace-…\` …)`）不是它的輸出，先去掉；exit 0 時不看 stderr。
  const violations = result.status === 0 ? [] : lines(result.stderr).filter(text => !/^\((?:node:\d+\)|Use `node --trace-)/.test(text)).map(text => text.match(/^(.+?)(?::(\d+))?: (\S+) (.+)$/));
  if (![0, 1].includes(result.status) || violations.some(match => !match)) fail(`check-portability.mjs 失敗：${result.stderr.trim()}`);
  for (const match of violations) {
    finding('platform', `${match[3]} ${match[4]}`, match[2] ? `${match[1]}:${match[2]}` : match[1]);
  }
}

for (const { line, detail } of findings) console.log([line, ...detail.map(text => `  ${text}`)].join('\n'));
console.log(findings.length ? `FINDINGS ${findings.length}` : 'HEALTHY');
process.exit(findings.length ? 1 : 0);
