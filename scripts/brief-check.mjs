#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 派工前的 brief 欄位檢查（spay2 #649 起源，ron-skills #346 升為正本；issue-pilot〈Briefs〉：缺欄位的 brief 不派工，修 brief 而不是改 worker 的 prompt）。
// 欄位以行首標籤辨識，標籤後須有內容（全形或半形冒號）：目標（goal）、範圍（scope）、驗收（acceptance）、驗證（verify）、TIMEBOX（timebox，須含分鐘數）、
// 禁止（forbidden）、回報（report）、Standing orders（standing-orders，須指向 preferences.md）。
// 用法：node scripts/brief-check.mjs <brief.md> [--batch <key>] [--iid <n>] ｜ --skeleton
// stdout：`BRIEF_OK <path>`（exit 0），或 `BRIEF_REJECTED <batch> #<iid> <path> class=missing-fields missing=<欄位,…>`（exit 1；未給 --batch／--iid 時為 `?`；
//   只列缺項，不印 brief 內文）；用法錯誤或讀不到檔案 exit 2。
// --skeleton（spay2 retro b20cba58#1：照 pstack 範本寫英文 `## Goal` 標題，八欄全缺；補標籤後又缺 preferences.md 路徑）：
//   印一份已能通過本檢查的標籤骨架（不是判定行，exit 0）：`Standing orders：` 預填主 checkout（git worktree list 第一筆；不在 git repo 時用 cwd）的
//   `.scratch/pilot/preferences.md` 絕對路徑，`驗證：` 的 node test 範例用 `grep -E '^ℹ (pass|fail)'`（node 24 的 --test 摘要是 `ℹ pass <n>`，`^# pass` 抓不到）。
//   把 `<…>` 換成實際內容後寫檔，再跑本 CLI。
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** [欄位名, 行首標籤的 pattern]，依 brief 慣用順序。 */
export const BRIEF_FIELDS = [
  ['goal', /^目標[：:][ \t]*\S/m],
  ['scope', /^範圍[：:][ \t]*\S/m],
  ['acceptance', /^驗收[：:][ \t]*\S/m],
  ['verify', /^驗證[：:][ \t]*\S/m],
  ['timebox', /^TIMEBOX[：:][ \t]*\d+[ \t]*分鐘/m],
  ['forbidden', /^禁止[：:][ \t]*\S/m],
  ['report', /^回報[：:][ \t]*\S/m],
  ['standing-orders', /^Standing orders[：:][ \t]*\S*preferences\.md/m],
];

/** brief 缺的欄位名（依 BRIEF_FIELDS 順序）；齊全時為空陣列。 */
export const missingFields = text => BRIEF_FIELDS.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);

/** 主 checkout：git worktree list 的第一筆；不在 git repo 時用 cwd。 */
function mainCheckout() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\n')[0].replace(/^worktree /, '') : process.cwd();
}

/** 能通過 missingFields 的標籤骨架；`<…>` 由 coordinator 填。 */
export const skeleton = (main = mainCheckout()) => ['# <brief 標題>', '',
  '目標：<一句話：要達成的結果>',
  '範圍：<worktree 絕對路徑、分支；可改的檔案>',
  '驗收：<可觀察的完成條件；新行為要有 fixture>',
  "驗證：<指令>；node test 例：`node --test <x>.test.mjs 2>&1 | grep -E '^ℹ (pass|fail)'`",
  'TIMEBOX：60 分鐘；超過時最後一行 `STOP <iid> timebox <進度>`', '',
  '<步驟、背景、證據>', '',
  '禁止：不 push、不 merge、不改範圍外的檔案',
  `Standing orders：${join(main, '.scratch/pilot/preferences.md')}`,
  '回報：<最後一行的格式>', ''].join('\n');

/** 拒絕派工的一行。 */
export const briefRejectLine = ({ batch = '?', iid = '?', file, missing }) => `BRIEF_REJECTED ${batch} #${iid} ${file} class=missing-fields missing=${missing.join(',')}`;

const USAGE = '用法：node scripts/brief-check.mjs <brief.md> [--batch <key>] [--iid <n>] ｜ --skeleton';

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [file, ...rest] = process.argv.slice(2);
  if (file === '--skeleton') {
    if (rest.length) { console.error(USAGE); process.exit(2); }
    process.stdout.write(skeleton());
    process.exit(0);
  }
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--batch', '--iid'].includes(rest[i]) || rest[i + 1] === undefined) { options.bad = true; break; }
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (!file || file.startsWith('--') || options.bad) { console.error(USAGE); process.exit(2); }
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) { console.error(`讀不到 ${file}：${error.message}`); process.exit(2); }
  const missing = missingFields(text);
  console.log(missing.length ? briefRejectLine({ batch: options.batch, iid: options.iid, file, missing }) : `BRIEF_OK ${file}`);
  process.exit(missing.length ? 1 : 0);
}
