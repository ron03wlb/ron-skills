#!/usr/bin/env node
// /setup-workflow 的複製：把 setup-workflow 正本連同執行期相依與測試複製到目標 repo 的 scripts/，
// 並在 docs/agents/workflow-templates.json 記錄每個副本的正本路徑、ron-skills commit 與 sha256（體檢以此判斷分歧）。
// 用法：node copy-templates.mjs <repo> [--dry-run] [--no-tests] [--yes] <template>...（template 為 templates/ 下的檔名，可省略 .mjs；
//       .sh 正本保留執行權限，並帶上它以 "$(dirname "$0")/<檔名>" 呼叫的同目錄腳本；<名稱>.test.mjs 是它的測試）
//       node copy-templates.mjs <repo> --verify
//       --exclude <路徑>（可重複；templates/ 下的檔或目錄，可帶 scripts/ 前綴）：目標 repo 有自己版本的檔，不複製、不記清單、不追它的相依，
//       既有檔與清單項目不動（spay2 的 scripts/test/fake-orca.mjs 與 scripts/test/fixtures/orca/），每個被排除的檔印一行 `EXCLUDE <副本路徑>`。
//       目標 repo 固定的本地例外寫在清單的 `localExceptions`（路徑字串陣列，格式同 --exclude），每次複製自動排除，不必記得帶 --exclude
//       （retro spay2 1bb1d94c#1(a)：忘了帶就連 --yes 一起蓋掉 fake-orca）；不是字串陣列時 exit 2。
//       --staged：正本已 `git add`、還沒 commit 時用（本 repo 的副本要和正本同一個 commit，bin/check 才過）：工作樹與 index 不同才擋，清單的 commit 記現在的 HEAD。
// 輸出每檔一行 `COPY|SAME|UPDATE|DIFF <副本路徑>`（UPDATE、DIFF 後接 unified diff，--staged 的 UPDATE 不接：diff 已在 git diff --cached；
//   UPDATE 是 sha256 與清單記錄一致、沒手改過的舊副本，直接覆寫），其下視情況多一行：
//   `MODE <副本路徑> <舊>→<新>`：既有副本的權限位元（八進位，例如 755→644）和正本不同，複製時改成正本的（#526：
//     scripts/check-node-version.mjs 手建時是 755、正本 644，重拷才在 diff 冒出 mode change）。正本權限才對就照常複製；副本該可執行時改正本的權限。
//   `ALSO_TESTED tests/<名稱>.test.mjs`：目標 repo 另有測副本的測試（不是 SAME 才印）；改範本時它和正本旁的測試都要跑（#454：只跑正本旁的那份，bin/check 才紅）。
// 最後一行：
//   PLANNED <n>（--dry-run）、COPIED <n>、CONFIRM_OVERWRITE <路徑...>（exit 3：既有檔內容不同且與清單記錄不一致，人確認後加 --yes 重跑；不是明列的範本時路徑緊接來源，例如 `scripts/b.mjs（a、c 的相依）`）、
//   VERIFIED <n>（--verify 全部一致；有 MISMATCH／MISSING／NO_ORIGIN 或沒有清單時 exit 1）。
// 來源 checkout 有 upstream 且落後（`git rev-list --count HEAD..@{u}` > 0，只看上次 fetch）時，複製前 stderr 印
//   `SOURCE_BEHIND <n> <upstream> → git -C <來源> merge --ff-only <upstream>`（actionable：照箭頭快轉後重跑）、exit 1、不寫任何檔；
//   與 spay2 check-template-copies.mjs --against-source 的同名行一致（#568）。沒有 upstream、--dry-run、--verify 不查。
// --verify 另查每個登記的 .mjs／.sh 副本（fixtures/ 下的不算）前三行有沒有來源行（ORIGIN），沒有印 `NO_ORIGIN <副本路徑>`：
//   正本檔頭都帶它，讓 consumer 不必查清單就知道檔案是副本（investing#529）；ron-skills 的 tests/template-copies.test.mjs 檢查每支正本都有。參數或旗標錯誤、正本不存在或有未提交改動時 exit 2。
// `正本不存在：templates/<檔>` 是相依時接 `（templates/<引用檔>:<行>）`（retro spay2 ff00a288#1(b)：只寫缺的檔名，要自己 grep 是誰引用的）；
//   actionable：改掉該行的引用，或在範本加 `// copy-templates: requires` 宣告真正的相依。
// 目標 repo 就是 ron-skills 本身（目標裡有 skills/engineering/setup-workflow/scripts/copy-templates.mjs）時，只處理清單已列的副本，
//   其餘每檔印 `SKIP_UNLISTED <templates/ 下的檔名>`、不複製也不記清單（不可動手，資訊；retro spay2 ff00a288#4：recopy 為 ron-skills
//   沒追蹤的範本建了 scripts/claude-hook-git-bypass.mjs 與清單項，要手動 rm 還原）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const MANIFEST = 'docs/agents/workflow-templates.json';

/** 每支程式正本檔頭第一段的來源行（`//` 或 `#` 註解）；`--verify` 認這段字。 */
const ORIGIN = '由 setup-workflow 範本同步，勿在此改';
/** 要帶來源行的檔：.mjs／.sh，fixtures/ 下的資料不算。 */
const needsOrigin = path => /\.(mjs|sh)$/.test(path) && !/(^|\/)fixtures\//.test(path);
/** 前三行有來源行。 */
const hasOrigin = text => text.split('\n', 3).some(line => line.includes(ORIGIN));

const fail = message => { console.error(`copy-templates: ${message}`); process.exit(2); };
const excludes = [];
const args = process.argv.slice(2).filter((arg, i, all) => {
  if (all[i - 1] === '--exclude') return false;
  if (arg !== '--exclude') return true;
  if (!all[i + 1] || all[i + 1].startsWith('--')) fail('--exclude 要接路徑');
  excludes.push(all[i + 1]);
  return false;
});
/** 排除路徑一律以 templates/ 為根：去掉 ./ 與 scripts/ 前綴及結尾的 /。 */
const templatePath = path => path.replace(/^(\.\/)?(scripts\/)?/, '').replace(/\/+$/, '');
/** 每個排除路徑 → 來源（`--exclude` 或清單的 `localExceptions`），排除明列的正本時報錯用。 */
const exclusions = new Map();
const excluded = file => [...exclusions.keys()].find(path => file === path || file.startsWith(`${path}/`));
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const [repoArg, ...names] = args.filter(arg => !arg.startsWith('--'));
const unknown = [...flags].filter(flag => !['--dry-run', '--no-tests', '--yes', '--verify', '--staged'].includes(flag));
if (unknown.length) fail(`不認得的旗標：${unknown.join(' ')}`);
if (!repoArg) fail('用法：copy-templates.mjs <repo> [--dry-run] [--no-tests] [--yes] [--staged] [--exclude <路徑>]... <template>... | <repo> --verify');
const repo = resolve(repoArg);

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifestPath = join(repo, MANIFEST);
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { source: 'ron03wlb/ron-skills', copies: {} };
const { localExceptions = [] } = manifest;
if (!Array.isArray(localExceptions) || localExceptions.some(path => typeof path !== 'string' || !path)) fail(`${MANIFEST} 的 localExceptions 要是路徑字串陣列`);
for (const path of localExceptions) exclusions.set(templatePath(path), `${MANIFEST} 的 localExceptions`);
for (const path of excludes) exclusions.set(templatePath(path), '--exclude');

if (flags.has('--verify')) {
  if (!existsSync(manifestPath)) { console.log(`MISSING ${MANIFEST}`); process.exit(1); }
  let bad = 0;
  for (const [path, entry] of Object.entries(manifest.copies)) {
    const file = join(repo, path);
    if (!existsSync(file)) { console.log(`MISSING ${path}`); bad++; continue; }
    if (sha256(file) !== entry.sha256) { console.log(`MISMATCH ${path}`); bad++; }
    if (needsOrigin(path) && !hasOrigin(readFileSync(file, 'utf8'))) { console.log(`NO_ORIGIN ${path}`); bad++; }
  }
  if (bad) process.exit(1);
  console.log(`VERIFIED ${Object.keys(manifest.copies).length}`);
  process.exit(0);
}
if (!names.length) fail('沒有指定正本');

const git = (...rest) => spawnSync('git', ['-C', TEMPLATES, ...rest], { encoding: 'utf8' });
const sourceRoot = git('rev-parse', '--show-toplevel').stdout.trim();

// 來源 checkout 落後 upstream（只看上次 fetch）時不複製：舊版範本會進下游，下游的 --against-source 也比對舊版（#568，spay2 retro 0b324fb8#2）。
// --dry-run 不寫檔，不擋。剝掉 GIT_*：在 git hook 內呼叫時它們會把指令導向別的 repo。
if (!flags.has('--dry-run')) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const sourceGit = (...rest) => spawnSync('git', ['-C', sourceRoot, ...rest], { encoding: 'utf8', env: cleanEnv });
  const upstream = sourceGit('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  const behind = upstream.status === 0 ? Number(sourceGit('rev-list', '--count', 'HEAD..@{u}').stdout.trim()) : 0;
  if (behind > 0) {
    const ref = upstream.stdout.trim();
    console.error(`SOURCE_BEHIND ${behind} ${ref} → git -C ${sourceRoot} merge --ff-only ${ref}`);
    process.exit(1);
  }
}

const isDir = path => existsSync(join(TEMPLATES, path)) && statSync(join(TEMPLATES, path)).isDirectory();
/** 目標是 ron-skills 本身（含其他 worktree）：本 repo 只追蹤清單已列的副本（retro spay2 ff00a288#4）。 */
const selfTarget = existsSync(join(repo, relative(sourceRoot, fileURLToPath(import.meta.url))));
/** text 中 index 所在的行號（1 起）。 */
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
/**
 * 動態 import 只認程式碼：註解行（`//`、`*`、`/*` 開頭）與同一行前面有未閉合 `"`／`` ` `` 字串的出現不算
 * （retro spay2 ff00a288#1(a)：claude-hook-git-bypass 的註解與測試 fixture 字串含 `import('./scripts/batch-watch.mjs')`，recopy 失敗兩次）。
 * 測試真的要動態載入的檔照常用 import，fixture 字串裡要帶的檔改寫 `// copy-templates: requires` 宣告。
 */
const inCode = (text, index) => {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const before = text.slice(start, index);
  if (/^\s*(?:\/\/|\/\*|\*)/.test(before)) return false;
  const plain = before.replace(/\\./g, '');
  return ['"', '`'].every(quote => plain.split(quote).length % 2 === 1);
};

/**
 * 檔案引用的同目錄相對檔，以及它讀取的整個 fixtures 目錄。
 * - shell：`"$(dirname "$0")/<檔名>"`。
 * - JS：行首的靜態 import／export（多行 import 的 `} from` 行也算）、動態 `import('./…')`、`new URL('./…')`。
 *   import 只認行首，字串或註解裡的 import 不算（#277：check-portability.test.mjs 的 fixture 字串）。
 * - fixtures：`'fixtures/<名稱>'`，以及 template literal 的 `` new URL(`./…/fixtures/<名稱>/${…}`) ``（#277：issue-pool.test.mjs）。
 * - 宣告：註解行 `// copy-templates: requires <檔名> ...`（shell 用 `#`），列出執行時一定要在旁邊的同目錄檔（#281）。
 *   `join(here, '<檔名>')` 這類呼叫不自動算：有些是「旁邊有才用」的選用檔（例如只支援 GitHub 的 gh-tracker.mjs），必要的才寫進宣告。
 */
function references(file) {
  const text = readFileSync(join(TEMPLATES, file), 'utf8');
  /** 引用 → { path, at }：at 是 `<引用檔>:<行>`，正本不存在時印出。 */
  const ref = (name, index) => ({ path: join(dirname(file), name), at: `${file}:${lineAt(text, index)}` });
  const required = [...text.matchAll(/^(?:\/\/|#) copy-templates: requires (.+)$/gm)]
    .flatMap(m => m[1].trim().split(/\s+/).map(name => ref(name, m.index)));
  if (file.endsWith('.sh')) return [...required, ...[...text.matchAll(/"\$\(dirname "\$0"\)\/([\w.-]+)"/g)].map(m => ref(m[1], m.index))];
  const patterns = [
    [/^\s*(?:(?:import|export)\b[^'"`;]*?\bfrom|\}\s*from|import)\s*'(\.\/[^']+)'/gm],
    [/\bimport\(\s*'(\.\/[^']+)'\s*\)/g, inCode],
    [/new URL\(\s*'(\.\/[^']+)'/g],
  ];
  const refs = [...required, ...patterns.flatMap(([pattern, keep]) => [...text.matchAll(pattern)].filter(m => !keep || keep(text, m.index)).map(m => ref(m[1], m.index)))];
  const dirs = [
    ...[...text.matchAll(/'(fixtures\/[^'/]+)'/g)].map(m => [m[1], m.index]),
    ...[...text.matchAll(/new URL\(\s*`\.\/((?:[^`$/]+\/)*fixtures\/[^`$/]+)\//g)].map(m => [m[1], m.index]),
  ];
  for (const [dir, index] of new Map(dirs)) {
    const base = join(dirname(file), dir);
    refs.push(...readdirSync(join(TEMPLATES, base), { recursive: true }).map(name => join(base, String(name))).filter(path => !isDir(path)).map(path => ({ path, at: `${file}:${lineAt(text, index)}` })));
  }
  return refs;
}

/** 每個要複製的檔 → 帶入它的明列範本（同一個相依可能被多個範本帶入）。 */
const broughtBy = new Map();
const skipped = new Set();
const visit = (file, root, at) => {
  if (broughtBy.get(file)?.has(root)) return;
  if (excluded(file)) { skipped.add(file); return; }
  if (!existsSync(join(TEMPLATES, file)) || isDir(file)) fail(`正本不存在：templates/${file}${at ? `（templates/${at}）` : ''}`);
  if (!broughtBy.has(file)) broughtBy.set(file, new Set());
  broughtBy.get(file).add(root);
  if (file.endsWith('.mjs') || file.endsWith('.sh')) references(file).forEach(({ path, at: from }) => visit(path, root, from));
};
const named = new Set();
for (const name of names) {
  const file = /\.(mjs|sh)$/.test(name) ? name : `${name}.mjs`;
  if (excluded(file)) fail(`${exclusions.get(excluded(file))} 排除了明列的正本：${file}`);
  named.add(file);
  visit(file, file);
  const testFile = file.replace(/\.(mjs|sh)$/, '.test.mjs');
  if (!flags.has('--no-tests') && existsSync(join(TEMPLATES, testFile))) visit(testFile, file);
}
const origin = file => (named.has(file) ? '' : `（${[...broughtBy.get(file)].map(root => root.replace(/\.mjs$/, '')).join('、')} 的相依）`);

const unlisted = selfTarget ? [...broughtBy.keys()].filter(file => !manifest.copies[join('scripts', file)]).sort() : [];
const plan = [...broughtBy.keys()].filter(file => !unlisted.includes(file)).sort().map(file => {
  const template = relative(sourceRoot, join(TEMPLATES, file));
  const status = git('status', '--porcelain', '--', join(TEMPLATES, file)).stdout;
  // --dry-run 不寫清單，正本改動中也能預覽；pre-commit 的測試才不會和改正本的 commit 互卡。
  if (flags.has('--staged')) {
    if (status.startsWith('??') || (status && status[1] !== ' ')) fail(`正本有未暫存改動：${template}（--staged 以 index 的內容為準，先 git add）`);
  } else if (!flags.has('--dry-run') && status.trim()) fail(`正本有未提交改動：${template}（先 commit，記錄的 commit 才對得上內容；副本要同一個 commit 時先 git add 再加 --staged）`);
  const dest = join('scripts', file);
  const target = join(repo, dest);
  const current = existsSync(target) && sha256(target);
  const state = !current ? 'COPY' : current === sha256(join(TEMPLATES, file)) ? 'SAME' : current === manifest.copies[dest]?.sha256 ? 'UPDATE' : 'DIFF';
  return { file, template, dest, target, state };
});

/** 權限位元的八進位字串（例如 755）。 */
const modeOf = path => (statSync(path).mode & 0o777).toString(8);
for (const file of [...skipped].sort()) console.log(`EXCLUDE ${join('scripts', file)}`);
for (const file of unlisted) console.log(`SKIP_UNLISTED ${file}`);
const diffs = [];
for (const { file, dest, target, state } of plan) {
  console.log(`${state} ${dest}`);
  if (state !== 'COPY' && modeOf(target) !== modeOf(join(TEMPLATES, file))) console.log(`MODE ${dest} ${modeOf(target)}→${modeOf(join(TEMPLATES, file))}`);
  const alsoTested = join('tests', file.replace(/\.(mjs|sh)$/, '.test.mjs'));
  if (state !== 'SAME' && !file.endsWith('.test.mjs') && /\.(mjs|sh)$/.test(file) && existsSync(join(repo, alsoTested))) console.log(`ALSO_TESTED ${alsoTested}`);
  if (state === 'DIFF') diffs.push(`${dest}${origin(file)}`);
  // --staged 的 UPDATE 不印 diff：內容就是剛暫存的正本改動，已在 git diff --cached（#454 第 2 項）。
  if (state === 'DIFF' || (state === 'UPDATE' && !flags.has('--staged'))) {
    process.stdout.write(spawnSync('git', ['diff', '--no-index', '--', target, join(TEMPLATES, file)], { encoding: 'utf8' }).stdout);
  }
}
if (flags.has('--dry-run')) { console.log(`PLANNED ${plan.length}`); process.exit(0); }
if (diffs.length && !flags.has('--yes')) { console.log(`CONFIRM_OVERWRITE ${diffs.join(' ')}`); process.exit(3); }

for (const { file, template, dest, target } of plan) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(join(TEMPLATES, file)));
  chmodSync(target, statSync(join(TEMPLATES, file)).mode & 0o777);
  const commit = (flags.has('--staged') ? git('rev-parse', 'HEAD') : git('log', '-1', '--format=%H', '--', join(TEMPLATES, file))).stdout.trim();
  manifest.copies[dest] = { template, commit, sha256: sha256(target) };
}
manifest.copies = Object.fromEntries(Object.entries(manifest.copies).sort(([a], [b]) => a.localeCompare(b)));
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`COPIED ${plan.length}`);
