#!/usr/bin/env node
// fresh 重做整併後的條目存活檢查（#558）：非戳記檔整檔 `git checkout --theirs` 會把整合分支在同一檔已合好的條目蓋掉
// （#344：PILOT-TEMPLATE.md 的 **Brief check.** 回到 #346 之前的文字），bin/check 全綠、和 prior 比對也抓不到。
// 用法：node scripts/entry-survival.mjs <base> [<檔>…]（在 repo 內任一目錄跑；<base> 是整合分支那一邊的 commit）
//   對應檔：工作樹與 <base> 兩邊 scripts/adapter-size-budget.json 列的檔、兩邊的 skills/engineering/issue-run/*-TEMPLATE.md，
//   加上命令列帶的檔。<base> 每份對應檔裡的每一行 `- **<條目>.**`（或 `- **<條目>**`）只去掉行尾空白、不做其他正規化，
//   在工作樹任何一份對應檔（聯集，所以拆檔、搬條目不報）都找不到同一行時報出：
//     ENTRY_LOST <檔> <條目>      條目名稱也找不到（被刪掉或被整檔蓋掉）
//     ENTRY_CHANGED <檔> <條目>   名稱還在、整行不同（正常改寫或被舊文字蓋掉，reviewer 逐條說明是哪一種）
//   帶 <檔> 時只檢查這些檔在 <base> 的條目，查找仍用整個聯集。
// stdout：上述行，依檔、行號排序；沒有時一行 `ENTRY_SURVIVAL_OK <檢查的條目數>`。
// exit：0 全部還在；1 有 ENTRY_LOST／ENTRY_CHANGED；2 用法錯誤、不在 git repo 或 <base> 不是 commit。
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET_FILE = 'scripts/adapter-size-budget.json';
const TEMPLATE_DIR = 'skills/engineering/issue-run';
const TEMPLATE = /^[^/]*-TEMPLATE\.md$/;
const ENTRY = /^- \*\*(.+?)\.?\*\*/;

function gitOut(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** base 的檔內容；不存在時 null。 */
const baseFile = (root, base, path) => gitOut(root, ['show', `${base}:${path}`]);
const treeFile = (root, path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);

/** 預算表的鍵；沒有或讀不懂時空陣列。 */
function budgetKeys(text) {
  if (text === null) return [];
  try { return Object.keys(JSON.parse(text)); } catch { return []; }
}

/** 對應檔集合：兩邊的預算表鍵、兩邊的 *-TEMPLATE.md、命令列的檔，去重、保持順序。 */
export function correspondingFiles(root, base, extra = []) {
  const baseTemplates = (gitOut(root, ['ls-tree', '--name-only', `${base}:${TEMPLATE_DIR}`]) ?? '').split('\n').filter(name => TEMPLATE.test(name));
  const treeTemplates = existsSync(join(root, TEMPLATE_DIR)) ? readdirSync(join(root, TEMPLATE_DIR)).filter(name => TEMPLATE.test(name)).sort() : [];
  return [...new Set([
    ...budgetKeys(treeFile(root, BUDGET_FILE)),
    ...budgetKeys(baseFile(root, base, BUDGET_FILE)),
    ...[...baseTemplates, ...treeTemplates].map(name => `${TEMPLATE_DIR}/${name}`),
    ...extra,
  ])];
}

/** 文件內容 → 條目行 [{ name, line, text }]（text 只去掉行尾空白）。 */
export function entryLines(content) {
  return content.split('\n').flatMap((raw, index) => {
    const match = raw.match(ENTRY);
    return match ? [{ name: match[1], line: index + 1, text: raw.trimEnd() }] : [];
  });
}

/** 回傳 { checked, reports: [{ kind, file, name }] }。 */
export function survival(root, base, only = []) {
  const files = correspondingFiles(root, base, only);
  const treeLines = new Set();
  const treeNames = new Set();
  for (const file of files) {
    const content = treeFile(root, file);
    if (content === null) continue;
    for (const raw of content.split('\n')) treeLines.add(raw.trimEnd());
    for (const { name } of entryLines(content)) treeNames.add(name);
  }
  let checked = 0;
  const reports = [];
  for (const file of only.length ? only : files) {
    const content = baseFile(root, base, file);
    if (content === null) continue;
    for (const { name, text } of entryLines(content)) {
      checked += 1;
      if (treeLines.has(text)) continue;
      reports.push({ kind: treeNames.has(name) ? 'ENTRY_CHANGED' : 'ENTRY_LOST', file, name });
    }
  }
  return { checked, reports };
}

function main(args) {
  if (args.length === 0 || args[0].startsWith('-')) {
    console.error('用法：node scripts/entry-survival.mjs <base> [<檔>…]');
    return 2;
  }
  const root = gitOut(process.cwd(), ['rev-parse', '--show-toplevel'])?.trim();
  if (!root) { console.error('ENTRY_SURVIVAL_ERROR 不在 git repo 裡'); return 2; }
  const [base, ...only] = args;
  const commit = gitOut(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])?.trim();
  if (!commit) { console.error(`ENTRY_SURVIVAL_ERROR ${base} 不是 commit`); return 2; }
  const { checked, reports } = survival(root, commit, only);
  for (const { kind, file, name } of reports) console.log(`${kind} ${file} ${name}`);
  if (reports.length) return 1;
  console.log(`ENTRY_SURVIVAL_OK ${checked}`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
