// 合併中途只有戳記檔衝突時重算戳記（#173）：land.mjs（setup-workflow 正本）在 PR 和 main 衝突時、pilot-land.mjs 的 Stage 共用。
// land.mjs 的契約：repo 有 scripts/restamp.mjs 時，衝突檔全在 STAMP_FILES 裡就呼叫 restamp(tree, files)；它解完並 git add，回傳 true，
// 解不了回傳 false（呼叫端 merge --abort）。只處理 files 裡的戳記檔，沒衝突的不動。
//   scripts/workflow-doc-sync.json     取目標分支（--theirs）版本，有 build-workflow-site.mjs 就重產 docs/workflow/site/，
//                                      再以 check-workflow-sync.mjs --restamp 依合併後的來源重寫（#72）。
//   docs/agents/workflow-templates.json  兩邊 copies 的聯集，依路徑排序（同 copy-templates.mjs）；每個條目取 sha256 等於合併後副本的那一邊，
//                                      兩邊都不等（副本兩邊都改、合併出新內容）時 sha256 依檔案重算、commit 取兩邊歷史裡最後一個改正本的 commit；
//                                      副本已不在的條目拿掉。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STAMPS = 'scripts/workflow-doc-sync.json';
const MANIFEST = 'docs/agents/workflow-templates.json';
export const STAMP_FILES = [STAMPS, MANIFEST];

// 從 pre-commit hook 或 worktree 呼叫時繼承的 GIT_DIR 等會讓 git -C 讀寫到別的 repo。
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));
const run = (cwd, command, args) => spawnSync(command, args, { cwd, encoding: 'utf8', env: childEnv });
const git = (tree, ...args) => run(tree, 'git', args);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** 合併中途某一邊（2 ours、3 theirs）的清單；那一邊沒有這個檔或讀不懂時 copies 是空的。 */
function manifestAt(tree, stage) {
  const shown = git(tree, 'show', `:${stage}:${MANIFEST}`);
  try {
    return { copies: {}, ...(shown.status === 0 ? JSON.parse(shown.stdout) : {}) };
  } catch {
    return { copies: {} };
  }
}

function restampManifest(tree) {
  const ours = manifestAt(tree, 2);
  const theirs = manifestAt(tree, 3);
  const copies = {};
  for (const path of [...new Set([...Object.keys(theirs.copies), ...Object.keys(ours.copies)])].sort((a, b) => a.localeCompare(b))) {
    const file = join(tree, path);
    if (!existsSync(file)) continue;
    const actual = sha256(file);
    const sides = [theirs.copies[path], ours.copies[path]].filter(Boolean);
    const match = sides.find(side => side.sha256 === actual);
    if (match) {
      copies[path] = match;
      continue;
    }
    const { template } = sides[0];
    const commit = git(tree, 'log', '-1', '--format=%H', 'HEAD', 'MERGE_HEAD', '--', template).stdout.trim() || sides[0].commit;
    copies[path] = { template, commit, sha256: actual };
  }
  // 其他欄位（source）取目標分支那邊的。
  writeFileSync(join(tree, MANIFEST), `${JSON.stringify({ ...ours, ...theirs, copies }, null, 2)}\n`);
  return git(tree, 'add', MANIFEST).status === 0;
}

function restampDocSync(tree) {
  if (git(tree, 'checkout', '--theirs', '--', STAMPS).status !== 0) return false;
  const build = join(tree, 'scripts/build-workflow-site.mjs');
  if (existsSync(build)) {
    if (run(tree, 'node', [build]).status !== 0) return false;
    if (git(tree, 'add', '-A', '--', 'docs/workflow/site').status !== 0) return false;
  }
  if (run(tree, 'node', [join(tree, 'scripts/check-workflow-sync.mjs'), '--restamp']).status !== 0) return false;
  return git(tree, 'add', STAMPS).status === 0;
}

/** 重算 files 裡的戳記檔並 git add；有不是戳記檔的、或任一步失敗時回傳 false。 */
export function restamp(tree, files) {
  if (!files.length || !files.every(file => STAMP_FILES.includes(file))) return false;
  if (files.includes(MANIFEST) && !restampManifest(tree)) return false;
  // 戳記檔最後重算：讀的是其他檔解完之後的來源。
  if (files.includes(STAMPS) && !restampDocSync(tree)) return false;
  return true;
}
