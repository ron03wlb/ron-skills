#!/usr/bin/env node
// copy-templates: requires orca-worktree-create.mjs pilot-unbare.sh
// setup-workflow 正本：/issue-pilot coordinator 的 Stage → Regression → hold 檢查 → Integrate，一個指令完成（adapter Pilot 段的 Stage、Regression、Integrate；
// 結果行與 checkpoint 格式見 skills/engineering/issue-pilot/PILOT-STORE.md 的 Canonical scripts）。專案值都從參數來：
//   --check-command <指令>  Regression 指令，在 stage worktree 以 sh 執行（預設 bin/check）；
//   --integration <分支>    整合分支（預設 pilot/integration）；stage 分支一律是 pilot/stage-<key>；
//   --main <分支>           sync-main 要跟上的 origin/<分支>（預設 main）；
//   --resolver <模組>       可選的專案衝突解法模組，相對本檔所在目錄的上一層（副本在 scripts/，就是 repo 根），或絕對路徑；不存在就是用法錯誤。
// 全部在 stage worktree 做（分支是整合分支或 pilot/stage-* 的那個 worktree；沒有就用 Orca 建 pilot-stage，再跑旁邊的 pilot-unbare.sh 當 Bare guard）：
//   Stage       stage worktree 要乾淨；`switch -C pilot/stage-<key> <integration tip>`，依號碼 `merge --no-ff` 每個 done 成員。
//               衝突時，衝突檔先交給 resolver 的 resolveFile 解（沒有 resolver 就解不了），最後重算戳記檔：
//                 docs/agents/workflow-templates.json（copy-templates.mjs 的副本清單，每個導入 repo 都有）由本檔的 restampManifest 重算，
//                 resolver 的 STAMP_FILES 交給它的 restamp(tree, files)；解法名稱是 resolver 加進 kinds 的名稱，戳記檔加 `restamp`，以 + 相連。
//               有一個檔解不了就 `merge --abort`，印 STOP conflict。
//               staged SHA 與 stage 時的 integration tip 寫成 checkpoint 的 `current: staged <sha> onto <tip>`。
//   load 關卡   要重新 stage（不是 RESUME）時，建 stage worktree 與 stage 之前先讀 1 分鐘 load（os.loadavg）；超過門檻就印
//               `STOP load <load> <門檻>`（load 取到小數兩位），stage 分支、stage worktree、checkpoint 與整合分支都不動，
//               下一輪重跑同一行就接著做（ron-skills #178：同時跑 8 個 worker 時 load 約 90，檢查時間加倍，計時測試失敗）。
//               門檻依序取 --load-max <n>、$PILOT_LOAD_MAX，都沒有時 3 × os.availableParallelism()；$PILOT_LOAD_NOW 取代實測值（測試用）。
//   Regression  在 staged SHA 跑 Regression 指令，完整輸出寫到 <主 checkout>/.scratch/pilot/reg-<key>.log，
//               checkpoint 追加 `regression: <sha> exit <code>`（通過、而且輸出最後一行以 `CHECK_PASS ` 開頭時附上那一行）。
//   hold        <主 checkout>/.scratch/pilot/hold 存在就停。
//   Integrate   整合分支的 tip 要還是 stage 時記下的那個（不數 parent：ron-skills batch-40-51 用 `$SHA^1` 誤判兩個成員的 batch）；
//               `switch <整合分支>`、`merge --ff-only`、`branch -d` stage 分支，`current:` 寫成 `merged <sha>`。
// 重跑：`current:` 是 `staged <sha> onto <tip>`、tip 沒變、stage 分支還在那個 SHA、成員組合與各分支都沒變、最後一個 regression 行是它的 exit 0 時，
//   不重新 stage、不重跑 Regression，直接從 hold 檢查繼續；其他情況一律從 Stage 重來。已經 `merged` 時只再印一次 MERGED。
// checkpoint 寫回之後再讀一次，沒寫進去就 STOP checkpoint，不會靜默失敗（ron-skills #74）。
// 請求分支（沒有 Issue 的 `retro/<x>`）：`req-<n> --branch retro/<x>`（<n> 是 requests.md 的行號）在 batch-req-<n>.md 不存在時開出它，
//   唯一的成員列 Issue 欄是 `-`、state `done`、candidate 是分支 tip；已存在時成員要是同一個分支，否則 STOP checkpoint。之後與一般 batch 相同。
//   分支不存在印 `STOP branch <分支> …`，不開 checkpoint。成員列是 `-` 時，STOP、RESOLVED 行裡的 <n> 是分支名稱。
// sync-main（Push gate 的 STOP behind-main）：從主 checkout 的副本跑時先交給 stage worktree 的同名腳本（lib/pilot-store.mjs 的 runInStageWorktree，#239、#275）；讓整合分支包含 origin/<主分支>，同樣在 stage worktree 做（要乾淨）。先 `git fetch origin`；
//   已包含印 `SYNCED <tip> current`；整合分支是 origin/<主分支> 的祖先時 `merge --ff-only`，印 `SYNCED <sha> ff`（不跑 Regression）；
//   分叉時先過 load 關卡（同 batch：超過門檻印 `STOP load <load> <門檻>`，stage worktree 與分支都不動），
//   再 `switch -C pilot/stage-sync-main <tip>`、`merge --no-ff origin/<主分支>`，衝突照 Stage 的解法（`RESOLVED sync-main <解法> <檔案…>`），
//   解不了 abort 後印 `STOP conflict sync-main <檔案…>`；在合併 SHA 跑 Regression（reg-sync-main.log），沒過印 `STOP regression sync-main <exit>`；
//   通過且整合分支的 tip 沒變（變了 `STOP drift`）時，先對每個 `current: merged <sha>`（<sha> 在合併 SHA 裡）的
//   batch 追加 `regression: <sha> exit 0 sync-main <CHECK_PASS 行>`（印 `RECORDED <key>`；Probe 才認得新的 tip、印 RESUME_PUSH，pilot-pr-body.mjs
//   認得 sync-main 標記、往前驗 staged SHA 那一行；寫不進去時 STOP checkpoint），再快轉整合分支、刪 stage 分支，
//   最後印 `SYNCED <sha> <CHECK_PASS 行>`（Regression 沒印 CHECK_PASS 時只有 `SYNCED <sha>`）。
//   STOP 時整合分支都不動，重跑同一行重新來過。exit 與 batch 相同（SYNCED 是 0）。
// resolver 模組的契約（都可省略；ron-skills 的 scripts/pilot-resolve.mjs 是一例）：
//   resolveFile(tree, path, kinds)  合併中途、不是戳記檔的衝突檔：傳回合併後的全文（本檔寫回並 git add），解不了傳回 undefined；
//                                   用到的解法名稱加進 Set kinds，依加入順序出現在 RESOLVED 行。
//   conflictKind(tree, path)        STOP conflict 的種類欄；傳回 undefined 時本檔照預設判斷 code／other。
//   STAMP_FILES、restamp(tree, files)  專案自己的戳記檔：其他檔都解完、workflow-templates.json 重算之後呼叫，重算並 git add，解不了傳回 false。
//
// 用法：node scripts/pilot-land.mjs <batch key> [--branch retro/<x>] [<選項>…] | sync-main [<選項>…]（在主 checkout 跑；沒有 stage worktree 時要 ORCA_CLI_COMMAND）
//   選項：--check-command <指令>、--integration <分支>、--main <分支>、--resolver <模組>、--load-max <n>
// stdout：最後一行是 `MERGED <key> <sha>`，或 `STOP regression <exit>`、`STOP hold`、`STOP drift`（tip 變了，下一輪重新 stage）、
//   `STOP conflict <n> <檔>=<來源>:<種類> …`（已 abort，stage worktree 乾淨；每個衝突檔一項）：來源是 `member <m>`（本次 stage
//     依號碼先合入、自己的分支改過這個檔的成員）、`integration`（成員開分支之後整合分支改過），或以 + 相連的多個來源（`member 79+integration`、`member 1+member 3`），
//     都看不出來（不該發生）時是 `unknown`；種類是 resolver 的 conflictKind，沒有時 `code`（程式檔）或 `other`。
//     例：`STOP conflict 108 scripts/lib/hosts.mjs=member 79:code docs/notes.md=integration:other`。以及 `STOP checkpoint …`、`STOP member <n> <state>`、`STOP dirty <worktree>`、
//   `STOP no-stage-worktree`、`STOP create …`、`STOP merge <n> …`、`STOP git …`、`STOP load <load> <門檻>`。之前的行：`STAGED <key> <sha> onto <tip>`、
//   `RESUME <key> <sha>`、`RESOLVED <n> <解法> <檔案…>`，Bare guard 還原主 checkout 時的 `UNBARE <主 checkout>`。
// exit：0 MERGED；4 STOP；2 用法錯誤；1 其他失敗（程式錯誤，不印 STOP）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInStageWorktree } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-land.mjs <batch key> [--branch retro/<x>] [--check-command <指令>] [--integration <分支>] [--main <分支>] [--resolver <模組>] [--load-max <n>] | sync-main [同上選項，不含 --branch]（--branch 時 key 是 req-<n>；門檻預設 $PILOT_LOAD_MAX，再來 3 × 核心數；在主 checkout 跑；沒有 stage worktree 時要 ORCA_CLI_COMMAND）';
const LOAD = /^\d+(\.\d+)?$/;
const MANIFEST = 'docs/agents/workflow-templates.json';
const here = dirname(fileURLToPath(import.meta.url));
// 從 pre-commit hook 或 worktree 呼叫時繼承的 GIT_DIR 等會讓 git -C 讀寫到別的 repo。
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(key)));

/** 專案值：命令列解析完填入。resolver 是載入後的模組（沒有時是空物件）。 */
const config = { check: 'bin/check', integration: 'pilot/integration', main: 'main', resolver: {} };

/** 停下：訊息就是 `STOP ` 後面那段。 */
class Stop extends Error {}

/** 同步跑子行程；stdin 一律接 /dev/null（Orca CLI 會吃掉 stdin）。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, ...options });
  // stderr 照常顯示（同 pilot-close.mjs），只濾掉 WSL 上 Orca 每次都印的 crashpad 錯誤行（#73）。
  const stderr = (result.stderr ?? '').split('\n').filter(line => !line.includes('registration_protocol_win.cc')).join('\n');
  if (stderr.trim()) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
  const reason = (result.stderr ?? '').trim().split('\n').pop() || (result.error?.message ?? `exit ${result.status}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', reason };
}

const gitIn = (cwd, ...args) => run('git', ['-C', cwd, ...args]);

/** git 指令，exit 非 0 就 STOP git。 */
function must(cwd, ...args) {
  const result = gitIn(cwd, ...args);
  if (result.status !== 0) throw new Stop(`git ${args[0]} ${result.reason}`);
  return result.stdout.trim();
}

/** 主 checkout：`git worktree list` 的第一列，從任何 worktree 呼叫都指回同一處。 */
function mainCheckout() {
  const result = run('git', ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) throw new Stop(`git worktree ${result.reason}`);
  return result.stdout.split('\n')[0].replace(/^worktree /, '');
}

/** stage worktree：分支是 pilot/integration 或 pilot/stage-* 的 worktree 路徑，主 checkout 不算（不在主 checkout 切分支，#21）；沒有傳回 undefined。 */
function stageWorktree(main) {
  return must(main, 'worktree', 'list', '--porcelain').split(/\n\n+/)
    .map(block => ({ path: block.match(/^worktree (.*)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] }))
    .find(w => w.path && w.path !== main && existsSync(w.path) && (w.branch === config.integration || w.branch?.startsWith('pilot/stage-')))?.path;
}

/** 用 Orca 建 stage worktree（orca-worktree-create.mjs 不重試、以 git worktree list 為準），接著跑 Bare guard。 */
function createStageWorktree(main, key) {
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!cli) throw new Stop('no-stage-worktree');
  const created = run('node', [join(here, 'orca-worktree-create.mjs'), '--name', 'pilot-stage', '--base-branch', config.integration, '--branch', `pilot/stage-${key}`],
    { cwd: main, env: { ...childEnv, ORCA_BIN: cli }, timeout: 300000 });
  const unbare = run(join(here, 'pilot-unbare.sh'), [main, `stage #${key}`]);
  if (unbare.stdout) process.stdout.write(unbare.stdout);
  if (unbare.status !== 0) throw new Stop(`create unbare ${unbare.reason}`);
  const tree = stageWorktree(main);
  if (!tree) {
    let detail = created.stdout.trim() || created.reason;
    try { detail = JSON.parse(detail).error ?? detail; } catch { /* 非 JSON 就原樣附上 */ }
    throw new Stop(`create ${detail}`);
  }
  return tree;
}

/**
 * batch checkpoint：`current:` 的值、成員 `{ n, branch, state }`（欄位見 PILOT-STORE.md）與最後一個 `regression:` 行的值。欄位前後的空格不影響。
 * Issue 欄是 `-` 的請求分支成員以分支名稱當 n，排在 Issue 成員之後、照表格順序。
 */
const order = ({ n }) => (typeof n === 'number' ? n : Number.MAX_SAFE_INTEGER);

function readCheckpoint(file) {
  if (!existsSync(file)) throw new Stop(`checkpoint 缺 ${file}`);
  const text = readFileSync(file, 'utf8');
  const current = text.match(/^current:[ \t]*(.*)$/m)?.[1].trim();
  if (current === undefined) throw new Stop(`checkpoint ${file} 沒有 current: 行`);
  const members = text.split('\n').filter(line => line.trim().startsWith('|'))
    .map(line => line.trim().split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(([n]) => /^(\d+|-)$/.test(n))
    .map(([n, branch, , , , , state]) => ({ n: n === '-' ? branch : Number(n), branch, state }))
    .sort((a, b) => order(a) - order(b));
  const regression = [...text.matchAll(/^regression:[ \t]*(.*)$/gm)].pop()?.[1].trim();
  return { current, members, regression };
}

/** 請求分支的 batch：checkpoint 不在就開出來（成員列 Issue 欄 `-`），在的話成員要是同一個分支。 */
function openRequest(key, branch, loadMax) {
  const main = mainCheckout();
  const file = join(main, `.scratch/pilot/batch-${key}.md`);
  if (existsSync(file)) {
    const others = readCheckpoint(file).members.map(m => m.branch);
    if (others.length !== 1 || others[0] !== branch) throw new Stop(`checkpoint ${file} 的成員是 ${others.join(' ') || '（沒有）'}，不是 ${branch}`);
    return;
  }
  // 新開的請求 batch 一定要 stage，load 關卡排在寫 checkpoint 之前（#178：STOP load 時 checkpoint 也不動）。
  loadGate(loadMax);
  const candidate = gitIn(main, 'rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`).stdout.trim();
  if (!candidate) throw new Stop(`branch ${branch} 不存在`);
  const worktree = must(main, 'worktree', 'list', '--porcelain').split(/\n\n+/)
    .find(block => block.split('\n').includes(`branch refs/heads/${branch}`))?.match(/^worktree (.*)$/m)?.[1] ?? '';
  const now = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# batch ${key}\ncurrent: dispatched ${now}\nintegration: ${config.integration} @ ${must(main, 'rev-parse', config.integration)}\n\n`
    + '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n'
    + `| - | ${branch} | ${worktree} | | ${now} | | done | ${candidate} |\n`);
  const { members } = readCheckpoint(file);
  if (members.length !== 1 || members[0].branch !== branch || members[0].state !== 'done') throw new Stop(`checkpoint ${file} 的成員列沒寫成 ${branch}`);
}

/** 改寫 `current:` 行；寫完再讀一次，不是這個值就 STOP（多一個空格就靜默不中的 sed 正是 #74 的起因）。 */
function setCurrent(file, value) {
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^current:.*$/m, `current: ${value}`));
  if (readCheckpoint(file).current !== value) throw new Stop(`checkpoint ${file} 的 current: 沒寫成 ${value}`);
}

/** 追加 `regression:` 行；寫完再讀一次，最後一個 regression 行不是它就 STOP。 */
function appendRegression(file, value) {
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, `${text}${text.endsWith('\n') ? '' : '\n'}regression: ${value}\n`);
  if (readCheckpoint(file).regression !== value) throw new Stop(`checkpoint ${file} 的 regression: 沒寫成 ${value}`);
}

/**
 * index 裡的一個 blob 解成 UTF-8 文字；不存在或不是合法 UTF-8 時傳回 undefined。
 * 以位元組讀再嚴格解碼：用 utf8 讀會把無效位元組換成 U+FFFD。
 */
function blob(tree, spec) {
  // stderr 不顯示：缺 stage（add/add、一邊刪掉）時 git show 的錯誤是預期中的。
  const result = spawnSync('git', ['-C', tree, 'show', spec], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnv });
  if (result.status !== 0) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout);
  } catch {
    return undefined;
  }
}

/** 程式檔的副檔名；副檔名不在清單裡時看 ours 那一版開頭是不是 shebang。 */
const CODE = /\.(mjs|cjs|js|jsx|ts|tsx|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cc|cpp)$/;

/** 這個檔在 from..to 之間有改動（新增、刪除也算）。 */
const touches = (tree, from, to, path) => gitIn(tree, 'diff', '--quiet', from, to, '--', path).status === 1;

/**
 * STOP conflict 的來源欄（#192）：本次 stage 先合入、自己的分支改過這個檔的成員是 `member <m>`，成員開分支之後整合分支改過的是
 * `integration`；兩者都有時以 + 連接（`member 79+integration`）。都看不出來（不該發生）時是 `unknown`。
 */
function conflictSource(tree, path, tip, branch, earlier) {
  const since = ref => must(tree, 'merge-base', tip, ref);
  const sources = earlier.filter(m => touches(tree, since(m.branch), m.branch, path)).map(m => `member ${m.n}`);
  if (touches(tree, since(branch), tip, path)) sources.push('integration');
  return sources.join('+') || 'unknown';
}

/** STOP conflict 的種類欄：resolver 的 conflictKind 優先；沒有時程式檔是 `code`（副檔名不在清單裡時看 ours 那一版開頭是不是 shebang），其他是 `other`。 */
function conflictKind(tree, path) {
  const kind = path === MANIFEST || stampFiles().includes(path) ? undefined : config.resolver.conflictKind?.(tree, path);
  if (kind) return kind;
  if (CODE.test(path)) return 'code';
  return blob(tree, `:2:${path}`)?.startsWith('#!') ? 'code' : 'other';
}

/** resolver 宣告的專案戳記檔。 */
const stampFiles = () => config.resolver.STAMP_FILES ?? [];

/** 合併中途某一邊（2 ours、3 theirs）的副本清單；那一邊沒有這個檔或讀不懂時 copies 是空的。 */
function manifestAt(tree, stage) {
  const shown = gitIn(tree, 'show', `:${stage}:${MANIFEST}`);
  try {
    return { copies: {}, ...(shown.status === 0 ? JSON.parse(shown.stdout) : {}) };
  } catch {
    return { copies: {} };
  }
}

/**
 * 合併中途重算 docs/agents/workflow-templates.json 並 git add（land.mjs 的專案 restamp.mjs 也可以拿來用）：兩邊 copies 的聯集，依路徑排序
 * （同 copy-templates.mjs）；每個條目取 sha256 等於合併後副本的那一邊，兩邊都不等（副本兩邊都改、合併出新內容）時 sha256 依檔案重算、
 * commit 取兩邊歷史裡最後一個改正本的 commit；副本已不在的條目拿掉。其他欄位取 theirs 那邊的。傳回是否成功。
 */
export function restampManifest(tree) {
  const ours = manifestAt(tree, 2);
  const theirs = manifestAt(tree, 3);
  const copies = {};
  for (const path of [...new Set([...Object.keys(theirs.copies), ...Object.keys(ours.copies)])].sort((a, b) => a.localeCompare(b))) {
    const file = join(tree, path);
    if (!existsSync(file)) continue;
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    const sides = [theirs.copies[path], ours.copies[path]].filter(Boolean);
    const match = sides.find(side => side.sha256 === actual);
    if (match) {
      copies[path] = match;
      continue;
    }
    const { template } = sides[0];
    const commit = gitIn(tree, 'log', '-1', '--format=%H', 'HEAD', 'MERGE_HEAD', '--', template).stdout.trim() || sides[0].commit;
    copies[path] = { template, commit, sha256: actual };
  }
  writeFileSync(join(tree, MANIFEST), `${JSON.stringify({ ...ours, ...theirs, copies }, null, 2)}\n`);
  return gitIn(tree, 'add', MANIFEST).status === 0;
}

/**
 * 解掉進行中 merge 的衝突並 add：一般檔交給 resolver 的 resolveFile，之後重算 workflow-templates.json、再交 resolver 的戳記檔給它的 restamp。
 * 傳回解法名稱（resolver 的 KINDS 有列時照它排序，否則照加入順序；restamp 最後），解不了傳回 undefined（呼叫端 abort）。
 */
function resolveConflicts(tree, files) {
  const projectStamps = stampFiles();
  const others = files.filter(path => path !== MANIFEST && !projectStamps.includes(path));
  const stamps = files.filter(path => projectStamps.includes(path));
  const kinds = new Set();
  const resolveFile = config.resolver.resolveFile ?? (() => undefined);
  const resolved = others.map(path => resolveFile(tree, path, kinds));
  if (resolved.includes(undefined)) return undefined;
  others.forEach((path, i) => writeFileSync(join(tree, path), resolved[i]));
  if (others.length) must(tree, 'add', '--', ...others);
  // 戳記檔最後重算：讀的是其他檔解完之後的來源；副本清單先，專案戳記（可能依副本重產）後。
  if (files.includes(MANIFEST)) {
    if (!restampManifest(tree)) return undefined;
    kinds.add('restamp');
  }
  if (stamps.length) {
    if (!config.resolver.restamp || config.resolver.restamp(tree, stamps) === false) return undefined;
    kinds.add('restamp');
  }
  const order = config.resolver.KINDS;
  const names = [...kinds].filter(kind => kind !== 'restamp');
  if (order) names.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...names, ...(kinds.has('restamp') ? ['restamp'] : [])].join('+');
}

/**
 * 在 stage worktree `merge --no-ff` 一個 ref，衝突照 resolveConflicts 解並印 `RESOLVED <label> <解法> <檔案…>`。
 * 解不了時先以 `describe(衝突檔)` 取得 STOP 訊息（要讀 index 的三個 stage，在 abort 之前），再 `merge --abort`。
 */
function mergeResolving(tree, ref, label, describe) {
  const merge = gitIn(tree, 'merge', '--no-ff', '--no-edit', ref);
  if (merge.status === 0) return;
  const conflicted = must(tree, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  // 解的途中失敗（restamp、add、commit 被 hook 擋）也先 abort，stage worktree 不停在 merge 中途。
  try {
    const how = conflicted.length ? resolveConflicts(tree, conflicted) : undefined;
    if (how) {
      must(tree, 'commit', '--no-edit');
      console.log(`RESOLVED ${label} ${how} ${conflicted.join(' ')}`);
      return;
    }
    if (!conflicted.length) throw new Stop(`merge ${label} ${merge.reason}`);
    throw new Stop(describe(conflicted));
  } catch (error) {
    if (gitIn(tree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0) must(tree, 'merge', '--abort');
    throw error;
  }
}

/** Stage：從 `tip` 重開 stage 分支、依號碼合入成員；傳回 staged SHA。 */
function stage(tree, key, members, tip) {
  must(tree, 'switch', '-q', '-C', `pilot/stage-${key}`, tip);
  for (const [index, { n, branch }] of members.entries()) {
    mergeResolving(tree, branch, n, conflicted => `conflict ${n} ${conflicted
      .map(path => `${path}=${conflictSource(tree, path, tip, branch, members.slice(0, index))}:${conflictKind(tree, path)}`).join(' ')}`);
  }
  return must(tree, 'rev-parse', 'HEAD');
}

/** load 關卡：1 分鐘 load 超過門檻就 STOP load，什麼都還沒動。 */
function loadGate(max) {
  const now = process.env.PILOT_LOAD_NOW;
  const load = Math.round((LOAD.test(now ?? '') ? Number(now) : loadavg()[0]) * 100) / 100;
  if (load > max) throw new Stop(`load ${load} ${max}`);
}

/** Regression：在 stage worktree 以 sh 跑 Regression 指令（--check-command），輸出寫到 reg-<key>.log；傳回 exit code、CHECK_PASS 行與 regression 行的值 `line`。 */
function regression(main, tree, key, sha) {
  const log = join(main, `.scratch/pilot/reg-${key}.log`);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'w');
  const result = spawnSync('sh', ['-c', config.check], { cwd: tree, env: childEnv, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const code = result.status ?? 1;
  const last = readFileSync(log, 'utf8').trimEnd().split('\n').pop() ?? '';
  const pass = code === 0 && last.startsWith('CHECK_PASS ') ? last : '';
  return { code, pass, line: `${sha} exit ${code}${pass ? ` ${pass}` : ''}` };
}

/**
 * staged SHA 合的還是現在這組成員：每個 done 成員的分支都在裡面，其他成員（如 hold 期間 `moved` 的）的分支沒有被這次 stage 合進來。
 * 成員分支在 stage 之後多了 commit 也不算，否則 RESUME 會把沒驗過的組合當成通過。
 */
function sameMembers(main, members, staged, tip) {
  const within = (branch, sha) => gitIn(main, 'merge-base', '--is-ancestor', branch, sha).status === 0;
  return members.every(({ branch, state }) => (state === 'done' ? within(branch, staged) : !within(branch, staged) || within(branch, tip)));
}

/** 整個流程；傳回 MERGED 的 SHA，其他結果丟 Stop。 */
function land(key, loadMax) {
  const main = mainCheckout();
  const file = join(main, `.scratch/pilot/batch-${key}.md`);
  const checkpoint = readCheckpoint(file);
  const branch = `pilot/stage-${key}`;
  const merged = checkpoint.current.match(/^merged ([0-9a-f]{40})\b/)?.[1];
  if (merged && gitIn(main, 'merge-base', '--is-ancestor', merged, config.integration).status === 0) return merged;
  if (!/^(dispatched|staged)\b/.test(checkpoint.current)) throw new Stop(`checkpoint current: ${checkpoint.current}`);
  const pending = checkpoint.members.find(m => m.state !== 'done' && !m.state?.startsWith('moved'));
  if (pending) throw new Stop(`member ${pending.n} ${pending.state}`);
  const members = checkpoint.members.filter(m => m.state === 'done');
  if (!members.length) throw new Stop(`checkpoint ${file} 沒有 done 成員`);

  const tip = must(main, 'rev-parse', config.integration);
  const [, staged, onto] = checkpoint.current.match(/^staged ([0-9a-f]{40}) onto ([0-9a-f]{40})\b/) ?? [];
  const resume = staged && onto === tip && checkpoint.regression?.startsWith(`${staged} exit 0`)
    && gitIn(main, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`).stdout.trim() === staged
    && sameMembers(main, checkpoint.members, staged, tip);
  if (!resume) loadGate(loadMax);
  const tree = stageWorktree(main) ?? createStageWorktree(main, key);
  if (must(tree, 'status', '--porcelain')) throw new Stop(`dirty ${tree}`);
  let sha;
  if (resume) {
    sha = staged;
    console.log(`RESUME ${key} ${sha}`);
  } else {
    sha = stage(tree, key, members, tip);
    setCurrent(file, `staged ${sha} onto ${tip}`);
    console.log(`STAGED ${key} ${sha} onto ${tip}`);
    const { code, line } = regression(main, tree, key, sha);
    appendRegression(file, line);
    if (code !== 0) throw new Stop(`regression ${code}`);
  }

  if (existsSync(join(main, '.scratch/pilot/hold'))) throw new Stop('hold');
  if (must(main, 'rev-parse', config.integration) !== tip) throw new Stop('drift');
  must(tree, 'switch', '-q', config.integration);
  must(tree, 'merge', '--ff-only', '-q', branch);
  must(tree, 'branch', '-d', branch);
  setCurrent(file, `merged ${sha}`);
  return sha;
}

const SYNC_BRANCH = 'pilot/stage-sync-main';

/** sync-main：讓整合分支包含 origin/<主分支>（Push gate 的 STOP behind-main，#193）；傳回 SYNCED 行 `<sha> <說明>`，其他結果丟 Stop。 */
function syncMain(loadMax) {
  const main = mainCheckout();
  must(main, 'fetch', '-q', 'origin');
  const tip = must(main, 'rev-parse', config.integration);
  const upstream = must(main, 'rev-parse', `origin/${config.main}`);
  const ancestor = (a, b) => gitIn(main, 'merge-base', '--is-ancestor', a, b).status === 0;
  if (ancestor(upstream, tip)) return `${tip} current`;
  const behind = ancestor(tip, upstream);
  // 分叉時要跑 Regression：和 batch 的 Stage 一樣，建 stage worktree、切分支之前先過 load 關卡（#178），STOP load 時什麼都不動。
  if (!behind) loadGate(loadMax);
  const tree = stageWorktree(main) ?? createStageWorktree(main, 'sync-main');
  if (must(tree, 'status', '--porcelain')) throw new Stop(`dirty ${tree}`);
  // 只是落後（retro 直接落地進 main）：快轉到 CI 已驗過的 origin/main，不必再跑 Regression；merged batch 這時都已在 origin/main。
  if (behind) {
    must(tree, 'switch', '-q', config.integration);
    must(tree, 'merge', '--ff-only', '-q', upstream);
    return `${upstream} ff`;
  }
  must(tree, 'switch', '-q', '-C', SYNC_BRANCH, tip);
  // 合入先記下的 SHA，不是 ref：上面的祖先判斷用的是它，期間別處 fetch 讓 origin/main 前進也合同一個。
  mergeResolving(tree, upstream, 'sync-main', conflicted => `conflict sync-main ${conflicted.join(' ')}`);
  const sha = must(tree, 'rev-parse', 'HEAD');
  const { code, pass } = regression(main, tree, 'sync-main', sha);
  if (code !== 0) throw new Stop(`regression sync-main ${code}`);
  if (must(main, 'rev-parse', config.integration) !== tip) throw new Stop('drift');
  // 先寫 checkpoint 再快轉：寫到一半失敗時整合分支還沒動，重跑會重新合併、再寫一次（最後一行為準）；
  // 反過來的話重跑只看到「已包含」，補不回 regression 行，Probe 又印 NOT_IN_MAIN（#193 review）。
  recordSync(main, sha, `${sha} exit 0 sync-main${pass ? ` ${pass}` : ''}`);
  must(tree, 'switch', '-q', config.integration);
  must(tree, 'merge', '--ff-only', '-q', SYNC_BRANCH);
  must(tree, 'branch', '-d', SYNC_BRANCH);
  return pass ? `${sha} ${pass}` : sha;
}

/**
 * sync-main 通過後、快轉之前，每個 `current: merged <sha>`、而且 <sha> 在合併 SHA 裡的 batch 追加同一個 `<sync sha> exit 0 sync-main …` 行並印 `RECORDED <key>`：
 * Probe 以最後一個 regression 行比對整合分支的 tip，沒有這行就把已驗過的 tip 印成 `NOT_IN_MAIN <key> tip …`；
 * `sync-main` 標記讓 pilot-pr-body.mjs 往前找 staged SHA 那一行來驗（#193）。
 */
function recordSync(main, sha, value) {
  const dir = join(main, '.scratch/pilot');
  const files = existsSync(dir) ? readdirSync(dir).filter(name => /^batch-.+\.md$/.test(name)).sort() : [];
  for (const name of files) {
    const file = join(dir, name);
    const merged = readFileSync(file, 'utf8').match(/^current:[ \t]*merged ([0-9a-f]{7,40})\b/m)?.[1];
    if (!merged || gitIn(main, 'merge-base', '--is-ancestor', merged, sha).status !== 0) continue;
    // 寫入本身失敗（唯讀、磁碟滿）也是 STOP checkpoint，不是程式錯誤：檔頭與 pilot-after-merge.md 的 Push gate 都這樣承諾，整合分支這時還沒動。
    try {
      appendRegression(file, value);
    } catch (error) {
      if (error instanceof Stop || !error?.code) throw error;
      throw new Stop(`checkpoint ${file} 寫不進去：${error.code}`);
    }
    console.log(`RECORDED ${name.slice('batch-'.length, -'.md'.length)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [key, ...rest] = process.argv.slice(2);
  const options = {};
  let bad = false;
  for (let i = 0; i < rest.length; i += 2) {
    const name = { '--branch': 'request', '--load-max': 'loadMax', '--check-command': 'check', '--integration': 'integration', '--main': 'main', '--resolver': 'resolver' }[rest[i]];
    if (!name || name in options || rest[i + 1] === undefined) bad = true;
    else options[name] = rest[i + 1];
  }
  const { request, check = config.check, integration = config.integration, main = config.main, resolver } = options;
  if (key === 'sync-main' && !bad) runInStageWorktree(import.meta.url, process.argv.slice(2), { integration });
  // 本檔所在 checkout 的根：副本在 <root>/scripts/，正本在 <root>/skills/engineering/setup-workflow/templates/，都以 scripts/ 的上一層為準。
  const resolverPath = resolver === undefined ? undefined : resolve(here, '..', resolver);
  const branchName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
  const loadMax = options.loadMax ?? (process.env.PILOT_LOAD_MAX || String(3 * availableParallelism()));
  if (bad || !/^[a-z0-9][a-z0-9-]*$/.test(key ?? '') || !LOAD.test(loadMax) || !check.trim()
    || !branchName.test(integration) || integration.startsWith('pilot/stage-') || !branchName.test(main)
    || (resolverPath !== undefined && !existsSync(resolverPath))
    || (request !== undefined && !(/^req-\d+$/.test(key) && /^retro\/[a-z0-9][a-z0-9-]*$/.test(request)))) {
    console.error(USAGE);
    process.exit(2);
  }
  Object.assign(config, { check, integration, main });
  if (resolverPath) config.resolver = await import(pathToFileURL(resolverPath).href);
  try {
    // `sync-main --branch …` 已被上面 req-<n> 的檢查擋成用法錯誤。
    if (key === 'sync-main') {
      console.log(`SYNCED ${syncMain(Number(loadMax))}`);
      process.exit(0);
    }
    if (request) openRequest(key, request, Number(loadMax));
    console.log(`MERGED ${key} ${land(key, Number(loadMax))}`);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.log(`STOP ${error.message}`);
    process.exit(4);
  }
}
