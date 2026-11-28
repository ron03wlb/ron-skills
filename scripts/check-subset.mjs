#!/usr/bin/env node
// bin/check --changed 的挑選：依變更路徑決定要跑哪些步驟群組與哪些測試檔（CoS item 67：每個 worker 的 pre-commit 都跑完整套件，WSL load 衝到 110）。
// 完整套件仍在 pilot 每批的 Regression（bin/check --upstream）、issue-run 的 acceptance 與 GitHub CI 跑；這裡只決定 pre-commit 跑多少。
// 對應表在 scripts/check-subset.json（規則見該檔 comment）。拿不準一律退回完整套件：路徑符合 full、有路徑不符合任何規則、取不到 base 或變更清單。
// related：從變更路徑出發，沿相對路徑的依賴（`import … from './x.mjs'`、`import('./x.mjs')`、`new URL('./x.mjs', import.meta.url)`）
//   反向一層層找依賴它的 .mjs，直到不再增加；這些檔（含變更路徑本身）被測試檔依賴或「提及」，那支測試就是相關測試。
//   不沿註解或字串裡的檔名擴散：腳本在註解裡互相提及，照提及擴散幾乎每次都選到全部測試（實測 132/137）。
//   「提及」是內文出現相對路徑，或出現檔名（前後不是英數、`-`、`_`、`.`）。.mjs 以外、檔名在 repo 裡不唯一的（例如 SKILL.md），
//   檔名不算，要出現「上層目錄/檔名」或 `'上層目錄', '檔名'`（path.join 的寫法）。
//   docs/agents/ 底下的 adapter 檔另有規則：測試要從 repo 根讀它才算提及，也就是寫出相對於測試目錄的路徑（`new URL('../docs/agents/x.md', import.meta.url)`），
//   或把完整路徑（或存著它的常數）傳給本檔以 import.meta.url 解析到 repo 根的識別字（`read('docs/agents/x.md')`、`join(root, 'docs', 'agents', 'x.md')`、
//   `new URL(`../${FILE}`, import.meta.url)`）。很多測試在暫存 repo 裡用同名路徑當 fixture，照完整路徑或檔名算，改一行 pilot.md 就挑出 24 支、
//   要排 heavy-slot（#628）。照 Pilot 段連結或 adapter-line.mjs 讀條目、不寫出路徑的測試，釘在 check-subset.json 的 tests。
//   漏選的測試（例如腳本以 spawn 呼叫另一支腳本）仍由 Regression 與 CI 的完整套件攔下，只是晚一點發現。
// 用法：node scripts/check-subset.mjs [--base <ref>] [--tree <tree>]
//   --base <ref>   比對基準，取 merge-base(<ref>, HEAD)；預設 origin/main，沒有時 main
//   --tree <tree>  要檢查的樹（pre-commit 傳要 commit 的 index tree）；沒給時是工作區（含沒暫存的修改與沒被忽略的新檔）
// stdout：退回完整套件時一行 `SUBSET_FULL <原因>`；否則兩行 `SUBSET_STEPS <群組>…`、`SUBSET_TESTS <測試檔>…`（沒有測試時只有前綴）。
// exit：0；用法錯誤 2。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const TABLE = new URL('./check-subset.json', import.meta.url);

/** glob 轉 RegExp：`**` 跨目錄（`a/**` 也符合 a 底下任何深度）、`*` 與 `?` 不跨 `/`。 */
export function globRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const matchesAny = (path, globs = []) => globs.some(glob => globRegExp(glob).test(path));

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isTest = path => path.endsWith('.test.mjs');

const DEPENDENCY = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|new URL\(\s*)(['"`])(\.{1,2}\/[^'"`$]+)\1/g;

/** file 以相對路徑依賴的 repo 檔（已正規化成 repo 相對路徑）。 */
export function dependencies(file, text) {
  return [...text.matchAll(DEPENDENCY)].map(match => posix.normalize(posix.join(posix.dirname(file), match[2])));
}

const ROOT_ANCHOR = /\b(?:const|let|var)\s+(\w+)\s*=[^\n]*?new URL\(\s*(['"`])((?:\.{1,2}\/?)+)(?:\$\{\w+\})?\2\s*,\s*import\.meta\.url/g;
const ROOT_TEMPLATE = /new URL\(\s*`((?:\.{1,2}\/?)+)\$\{(\w+)\}`\s*,\s*import\.meta\.url/g;

/**
 * test 從 repo 根讀 path：字面寫出相對於 test 目錄的路徑；或把 path（整串、path.join 分段，或存著 path 的常數）
 * 傳給本檔宣告、以 import.meta.url 解析到 repo 根的識別字，或填進解析到 repo 根的 `new URL(`../${常數}`, import.meta.url)`。
 */
function readsFromRoot(test, text, path) {
  const quote = '[\'"`]';
  const toRoot = base => posix.join(posix.dirname(test), base, '.') === '.';
  if (new RegExp(`${quote}${escape(posix.relative(posix.dirname(test), path))}${quote}`).test(text)) return true;
  const literal = `${quote}${path.split('/').map(escape).join(`(?:/|${quote},\\s*${quote})`)}${quote}`;
  const aliases = [...text.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*${quote}${escape(path)}${quote}`, 'g'))].map(match => match[1]);
  const argument = [literal, ...aliases.map(alias => `${alias}\\b`)].join('|');
  for (const [, name, , base] of text.matchAll(ROOT_ANCHOR)) {
    if (toRoot(base) && new RegExp(`\\b${name}(?:\\(|\\s*,)\\s*(?:${argument})`).test(text)) return true;
  }
  return [...text.matchAll(ROOT_TEMPLATE)].some(([, base, name]) => toRoot(base) && aliases.includes(name));
}

/** 回傳判斷測試檔 test（內文 text）是否提及 path 的函式；names 是 repo 裡每個檔名出現的次數。 */
function mentionOf(path, names) {
  if (path.startsWith('docs/agents/')) return (test, text) => readsFromRoot(test, text, path);
  const name = basename(path);
  const parent = basename(dirname(path));
  const word = text => new RegExp(`(^|[^\\w.-])${escape(text)}($|[^\\w-])`);
  const patterns = [word(path)];
  if (path.endsWith('.mjs') || names.get(name) === 1) patterns.push(word(name));
  else if (parent !== '.') patterns.push(word(`${parent}/${name}`), new RegExp(`['"\`]${escape(parent)}['"\`],\\s*['"\`]${escape(name)}['"\`]`));
  return (test, text) => patterns.some(pattern => pattern.test(text));
}

/**
 * 依變更路徑挑步驟與測試。
 * @param {{ changed: string[], files: string[], read: (path: string) => string, table: object }} input
 *   changed 是變更路徑（含刪除）；files 是 repo 目前的所有檔（追蹤檔與沒被忽略的新檔）；read 讀檔，讀不到回空字串。
 * @returns {{ full: string } | { steps: string[], tests: string[] }}
 */
export function plan({ changed, files, read, table }) {
  for (const path of changed) if (matchesAny(path, table.full)) return { full: `full-path ${path}` };
  const steps = new Set(table.always?.steps ?? []);
  const tests = new Set(files.filter(file => matchesAny(file, table.always?.tests)));
  const seeds = [];
  for (const path of changed) {
    const rules = table.rules.filter(rule => matchesAny(path, rule.match));
    if (!rules.length) return { full: `unmapped ${path}` };
    for (const rule of rules) {
      for (const step of rule.steps ?? []) steps.add(step);
      for (const file of files) if (isTest(file) && matchesAny(file, rule.tests)) tests.add(file);
      if (rule.related) seeds.push(path);
    }
  }
  const unknown = [...steps].filter(step => !table.steps.includes(step));
  if (unknown.length) return { full: `unknown-step ${unknown.join(',')}` };

  const names = new Map();
  for (const file of files) names.set(basename(file), (names.get(basename(file)) ?? 0) + 1);
  const modules = files.filter(file => file.endsWith('.mjs'));
  const texts = new Map();
  const text = file => { if (!texts.has(file)) texts.set(file, read(file)); return texts.get(file); };
  const dependents = new Map();
  for (const file of modules) {
    for (const target of dependencies(file, text(file))) {
      if (!dependents.has(target)) dependents.set(target, new Set());
      dependents.get(target).add(file);
    }
  }
  const reached = new Set(seeds);
  const queue = [...reached];
  while (queue.length) {
    for (const file of dependents.get(queue.shift()) ?? []) {
      if (reached.has(file)) continue;
      reached.add(file);
      queue.push(file);
    }
  }
  const mentions = [...reached].map(path => mentionOf(path, names));
  for (const file of files) if (isTest(file) && (reached.has(file) || mentions.some(mention => mention(file, text(file))))) tests.add(file);
  return { steps: table.steps.filter(step => steps.has(step)), tests: [...tests].sort() };
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

const lines = text => text.split('\n').filter(Boolean);

function main(argv) {
  let base = null;
  let tree = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) base = argv[++i];
    else if (argv[i] === '--tree' && argv[i + 1]) tree = argv[++i];
    else {
      console.error('用法：node scripts/check-subset.mjs [--base <ref>] [--tree <tree>]');
      return 2;
    }
  }
  const full = reason => { console.log(`SUBSET_FULL ${reason}`); return 0; };
  base ??= ['origin/main', 'main'].find(ref => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null);
  if (!base) return full('no-base');
  const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
  if (!mergeBase) return full(`no-merge-base ${base}`);
  const diff = tree
    ? git(['diff', '--name-only', '--no-renames', mergeBase, tree])
    : git(['diff', '--name-only', '--no-renames', mergeBase]);
  const others = git(['ls-files', '--others', '--exclude-standard']);
  const tracked = git(['ls-files']);
  if (diff === null || others === null || tracked === null) return full('git-error');
  const changed = [...new Set([...lines(diff), ...(tree ? [] : lines(others))])];
  const files = [...new Set([...lines(tracked), ...lines(others)])].filter(file => existsSync(file));
  const read = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
  const result = plan({ changed, files, read, table: JSON.parse(readFileSync(TABLE, 'utf8')) });
  if (result.full) return full(result.full);
  console.log(`SUBSET_STEPS ${result.steps.join(' ')}`.trimEnd());
  console.log(`SUBSET_TESTS ${result.tests.join(' ')}`.trimEnd());
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
