#!/usr/bin/env node
// 依條目名稱把 prior 的條目改動移植到條目搬走後的位置（#599）：條目搬到別的檔之後（#344 把 **Probe.**、**Stage.**
// 從 pilot.md 搬到 pilot-round.md），prior 對它們的改動用 `git apply -3` 一律衝突。
// 用法：node scripts/port-entries.mjs <base> <prior> <檔> [<目標檔>]（在 repo 內任一目錄跑；<檔>、<目標檔> 相對 repo 根）
//   <base> 是 prior 當初的基準，<prior> 是帶改動的 ref，<檔> 是 prior 改動所在的檔。
//   條目行與對應檔聯集沿用 entry-survival.mjs（#558）：`- **<條目>.**` 開頭的行，只去掉行尾空白比對；
//   聯集是預算表列的檔、*-TEMPLATE.md，加上 <檔> 與 <目標檔>。只處理 prior 相對 base 在 <檔> 內改了或新增的條目行，
//   每條在工作樹的聯集裡找同名條目，依 prior 內出現的順序印一行：
//     PORTED <條目> <檔>         恰好一條同名（撞名時 <目標檔> 恰好一條），且該行仍逐字等於 base 原文：換成 prior 的文字
//     NO_MATCH <條目>            沒有同名條目（含一條拆成兩條不同名），或同名但該行已不等於 base 原文；不寫入
//     AMBIGUOUS <條目> <檔>…     聯集內不只一條同名，且 <目標檔> 沒給或不是恰好一條；新增的條目已有同名時也印；不寫入
//     ADDED <條目> <檔>          base 沒有、聯集也沒有同名的新條目：整行接在 <檔>（不在了就 <目標檔>）最後一條條目之後
//   只改工作樹，不 commit。
// exit：0 全部 PORTED／ADDED；1 有 NO_MATCH 或 AMBIGUOUS；2 用法錯誤、不在 git repo、ref 不是 commit 或 <檔> 不在 prior。
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { correspondingFiles, entryLines } from './entry-survival.mjs';

const USAGE = '用法：node scripts/port-entries.mjs <base> <prior> <檔> [<目標檔>]';

function gitOut(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** prior 相對 base 改了或新增的條目：[{ name, from（base 原文，新增時 null）, to }]，依 prior 內順序。 */
export function changedEntries(baseContent, priorContent) {
  const baseByName = new Map();
  for (const entry of entryLines(baseContent)) baseByName.set(entry.name, [...(baseByName.get(entry.name) ?? []), entry.text]);
  const seen = new Map();
  const changes = [];
  for (const { name, text } of entryLines(priorContent)) {
    const nth = seen.get(name) ?? 0;
    seen.set(name, nth + 1);
    const from = baseByName.get(name)?.[nth] ?? null;
    if (from !== text) changes.push({ name, from, to: text });
  }
  return changes;
}

/** 新條目接在最後一條條目之後；條目之間空一行的檔也空一行，沒有條目時接在檔尾。 */
function insertEntry(lines, text) {
  let last = -1;
  lines.forEach((line, index) => { if (entryLines(line).length) last = index; });
  if (last === -1) {
    const end = lines.length && lines.at(-1) === '' ? lines.length - 1 : lines.length;
    lines.splice(end, 0, text);
  } else {
    lines.splice(last + 1, 0, ...(last > 0 && lines[last - 1] === '' ? ['', text] : [text]));
  }
}

/** 回傳 { reports: [{ kind, name, files }], writes: Map<檔, 內容> }；不寫檔。 */
export function port(root, base, baseContent, priorContent, file, target = null) {
  const files = correspondingFiles(root, base, [file, ...(target ? [target] : [])]);
  const tree = new Map();
  for (const path of files) {
    if (existsSync(join(root, path))) tree.set(path, readFileSync(join(root, path), 'utf8').split('\n'));
  }
  const holders = name => [...tree].flatMap(([path, lines]) => lines.flatMap((line, index) => {
    const match = entryLines(line)[0];
    return match?.name === name ? [{ path, index, text: match.text }] : [];
  }));
  const uniqueFiles = found => [...new Set(found.map(({ path }) => path))];
  const reports = [];
  const changed = new Set();
  const additions = [];
  for (const { name, from, to } of changedEntries(baseContent, priorContent)) {
    let found = holders(name);
    if (from === null) {
      const dest = tree.has(file) ? file : target && tree.has(target) ? target : null;
      if (found.length) reports.push({ kind: 'AMBIGUOUS', name, files: uniqueFiles(found) });
      else if (!dest) reports.push({ kind: 'NO_MATCH', name, files: [] });
      else { additions.push({ dest, text: to }); reports.push({ kind: 'ADDED', name, files: [dest] }); }
      continue;
    }
    if (found.length > 1) {
      const inTarget = found.filter(({ path }) => path === target);
      if (inTarget.length !== 1) { reports.push({ kind: 'AMBIGUOUS', name, files: uniqueFiles(found) }); continue; }
      found = inTarget;
    }
    if (found.length === 0 || found[0].text !== from) { reports.push({ kind: 'NO_MATCH', name, files: [] }); continue; }
    tree.get(found[0].path)[found[0].index] = to;
    changed.add(found[0].path);
    reports.push({ kind: 'PORTED', name, files: [found[0].path] });
  }
  for (const { dest, text } of additions) { insertEntry(tree.get(dest), text); changed.add(dest); }
  return { reports, writes: new Map([...changed].map(path => [path, tree.get(path).join('\n')])) };
}

function main(args) {
  if (args.length < 3 || args.length > 4 || args.some(arg => arg.startsWith('-'))) { console.error(USAGE); return 2; }
  const root = gitOut(process.cwd(), ['rev-parse', '--show-toplevel'])?.trim();
  if (!root) { console.error(`PORT_ENTRIES_ERROR 不在 git repo 裡\n${USAGE}`); return 2; }
  const [baseRef, priorRef, file, target = null] = args;
  const commits = [baseRef, priorRef].map(ref => gitOut(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim());
  const missing = [baseRef, priorRef].filter((_, index) => !commits[index]);
  if (missing.length) { console.error(`PORT_ENTRIES_ERROR ${missing.join(' ')} 不是 commit\n${USAGE}`); return 2; }
  const [base, prior] = commits;
  const priorContent = gitOut(root, ['show', `${prior}:${file}`]);
  if (priorContent === null) { console.error(`PORT_ENTRIES_ERROR ${file} 不在 ${priorRef}\n${USAGE}`); return 2; }
  const baseContent = gitOut(root, ['show', `${base}:${file}`]) ?? '';
  const { reports, writes } = port(root, base, baseContent, priorContent, file, target);
  for (const [path, content] of writes) writeFileSync(join(root, path), content);
  for (const { kind, name, files } of reports) console.log([kind, name, ...files].join(' '));
  return reports.every(({ kind }) => kind === 'PORTED' || kind === 'ADDED') ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
