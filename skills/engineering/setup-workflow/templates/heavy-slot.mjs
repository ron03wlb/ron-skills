#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// setup-workflow 正本（CoS item 67）：全機共用的重型檢查 slot。同一台機器上的每個 repo（ron-skills、spay2…）跑重型檢查（bin/check、
// check-contracts…）前都經它拿 slot，全機同時最多 N 支；各 repo 自己限流擋不住彼此（WSL 16 核 load 到 110、OOM 三次）。
// 實作：每個 slot 一個鎖檔 `<dir>/slot-<i>.lock`，以 perl 的 flock(2) 拿排他鎖（macOS 沒有 flock(1)，perl 兩邊都有）。
// 鎖由一支 perl 子行程持有，它的 stdin 接本行程：本行程結束（含被 SIGKILL）時 stdin 關閉，perl 讀到 EOF 就結束，核心隨即釋放 flock；
// perl 自己被殺也一樣由核心釋放。所以行程死掉不會留下佔住的 slot，不必清鎖檔。
// 持有者把 `{ label, pid, cwd, since }` 寫進自己的鎖檔，排隊者寫 `<dir>/wait-<pid>.json`（`{ label, pid, cwd, since, priority }`；拿到 slot 或結束時刪掉；
//   行程已不在的，任何讀到它的行程（status、其他排隊者）都略過並清掉）。
// 排隊（CoS item 67，2026-11-24：搶鎖時 repo 的等待者越多越容易搶到，spay2 的 push-gate 連續逾時）：等待者不再各自輪詢搶鎖，
//   每 $HEAVY_CHECK_POLL 秒讀一次全部 wait 檔與持有者，依下面的規則算出「現在輪到誰」，只有輪到自己時才去試 flock（試不到就下一輪再算）。
//   規則（CoS item 126，owner：spay 的專案優先）：先看 repo 優先序，同一個 repo 內才看用途優先級。
//     repo 是 label 冒號前的字串（沒有冒號的 label，例如手動跑的 `dbg`，整個 label 就是 repo、用途優先級 normal）。
//     repo 優先序：$HEAVY_CHECK_REPO_PRIORITY（逗號分隔，測試用）＞ ~/.config/orca-heavy-check/repo-priority（一行一個 repo，越前面越優先；
//     空行與 # 開頭的行略過）＞ 預設 spay2、ron-skills；沒列出的 repo 都排在最後、彼此同級。
//     只有排在最前面的那一級 repo 有人在等時，就只有那一級的等待者能拿新空出的 slot（例如 spay2 在等時，ron-skills 和其他 repo 一個都不拿）；
//     已經在跑的不搶占。同一級裡依（有效用途優先級、since、pid）排成一列，空出的 slot 由列首往後分配；那一級沒人在等才輪到下一級。
//   拿鎖仍是 flock，持有狀態全在核心，排隊狀態只有 wait 檔（死掉的 pid 會被清掉），沒有要手動清的東西。
//   用途優先級（從 label 冒號後的「用途」判斷；`--priority <high|normal|low>` 覆寫，只影響同一個 repo 內的順序）：
//     high    推送前最後一關：用途是 push、push-gate、pre-push、land、land-checks，或以 `push-`、`land-` 開頭
//     normal  其他一切，包括 check、check-contracts、regression 與不認得的用途
//     low     pre-commit，或以 `pre-commit-` 開頭
//   防餓死：每等滿 $HEAVY_CHECK_AGE_S 秒（預設 900，0 不升級）用途優先級升一級（low→normal→high），不會比 high 更高；
//     只在沒有更前面的 repo 在等時生效（有 spay2 在等時，ron-skills 的等待者不升級，也不會排到 spay2 前面）。
//   餓死保底（owner 2026-11-26 經 CoS item 126 核准，規則 B；起因 11-25 ron-skills #395 的 stage commit 被不斷進場的 spay2 檢查擋了 4.3 小時以上，item 93、#637）：
//     不在最前面那一級 repo 的等待者，已等滿 $HEAVY_CHECK_STARVE_S 秒（預設 7200，0 關閉這條規則；從 since 算，沿用的 since 也算）時，
//     有空出的 slot 就先給它 1 個，即使前面那一級還有人在等；全機同時最多 1 個 slot 是用這條規則拿的（持有者的鎖檔記 `starve: true`），
//     那個 slot 還在用時其他人都不再用這條規則，其餘空出的 slot 照舊只給最前面那一級。符合的等待者不只一個時給 since 最早的（再比 pid）。
//     只用空出的 slot，不搶占已經在跑的檢查。
//   還沒換成這版的副本（舊版等待者）照舊每秒搶鎖、不看排隊；它的 wait 檔照樣算進列裡（優先級由 label 推）。
// 逾時重跑保留排隊位置（retro 00abd5f9#1：spay2 check-contracts 逾時前 rank 1/5，照原指令重跑後 since 重設成現在，掉到 3/5、老化歸零）：
//   SLOT_TIMEOUT 時把這次排隊用的 since 與基本優先級寫進 `<dir>/resume-<鍵>.json`（鍵＝label＋cwd＋<command> argv 的 sha256 前 16 字元，
//   `{ label, cwd, argv, since, priority, saved_at }`）。同鍵的下一次 run 若在 saved_at 後 $HEAVY_CHECK_RESUME_S 秒內（預設 7200，0 不沿用也不寫）
//   開始排隊，就沿用該 since（排序與防餓死升級都照原 since 算）與 priority（有給 --priority 時以它為準），並印 SLOT_RESUMED；
//   認領與寫回都在 `<紀錄>.lock`（檔案鎖，內容是持有者 pid；只回收持有者已不在的鎖，回收先 rename 再確認內容，釋放只刪自己的鎖）裡：開始排隊的那一支以 rename 認領後讀、刪（同時重跑兩次只有一支沿用），再次逾時則以同一個 since 寫回；
//   同鍵另一支較晚逾時時保留較早的 since；停用（0）時不讀也不刪；過期的紀錄讀到時忽略並刪掉；刪除不遞迴；鎖、認領或清理失敗只影響續排，不擋檢查。--timeout、SLOT_WAIT 的已等秒數與 log 的 wait_ms 仍從這次 run 起算。
// 每個 repo 的名額（CoS item 67，owner 2026-11-26：ron-skills 的完整檢查改走 GitHub Actions，本機名額 0）：
//   $HEAVY_CHECK_REPO_SLOTS（測試用，`<repo>=<n>` 逗號分隔；空字串是都不限）＞ ~/.config/orca-heavy-check/repo-slots（一行 `<repo> <n>`，n 是非負整數；
//   空行、# 開頭與格式不對的行略過）＞ 沒有限制。沒列出的 repo 不限，只受全機 slot 數限制；沒有這個檔時行為和以前完全一樣。
//   n > 0：同一個 repo 同時最多 n 個持有者；已滿的 repo 的等待者不拿新空出的 slot，也不擋後面的 repo（它不算「最前面那一級在等」）。
//   n = 0：run 不排隊、不執行命令，印 `SLOT_DELEGATED <label> ci`、exit 76（SLOT_DELEGATED_EXIT）：呼叫端改交給 CI（例如 ci-run.mjs），
//     不是通過、不是檢查失敗、也不是負載逾時，不要重試同一行。CI 不可用時呼叫端以 `run --fallback`（或環境變數 HEAVY_SLOT_FALLBACK=1）重跑：
//     忽略名額 0、照舊排隊（repo 優先序、防餓死、餓死保底都照舊，所以排在優先序較前的 repo 後面）。
//   `quota <repo>` 印 `QUOTA <repo> <n>`（沒有限制時 `-`），給 pre-commit、bin/check 在拿 slot 之前決定要不要交給 CI。
// 巢狀：在 slot 裡跑的命令帶環境變數 HEAVY_SLOT_HELD；裡面再呼叫 run（例如 bin/check 的測試跑 pre-commit）時直接執行，不再拿第二個 slot（避免 N 個持有者互等）。
//
// 用法：node scripts/heavy-slot.mjs run --label <repo>:<用途> [--priority <high|normal|low>] [--timeout <秒>] [--interval <秒>] [--fallback] -- <command> [<arg>...]
//       node scripts/heavy-slot.mjs status
//       node scripts/heavy-slot.mjs quota <repo>
//       node scripts/heavy-slot.mjs stats [--since <ISO 時間>] [--label <glob>]
//   run     拿到 slot 才執行 <command>（不經 shell；要 shell 時寫 `-- sh -c '<指令>'`），結束就釋放，exit code 照傳（被信號殺掉時 128+信號值）。
//           等待中收到 SIGINT／SIGTERM 就放棄排隊並以 128+信號值結束；執行中收到的信號轉給 <command>。
//   --label <repo>:<用途>（必填，[A-Za-z0-9_.:@/-]）：status 與 SLOT_WAIT 顯示的名字，例如 `ron-skills:pre-commit`、`spay2:check-contracts`。
//   --priority 選填，覆寫由用途判斷的優先級（見上面的對照表）。
//   --timeout 等待上限秒數（預設 $HEAVY_CHECK_TIMEOUT，再來 1800；0 是不設上限）；--interval SLOT_WAIT 的間隔秒數（預設 $HEAVY_CHECK_WAIT_INTERVAL，再來 30）。
//   --fallback 選填，名額 0 的 repo 也照舊排隊（CI 不可用時的退路，見「每個 repo 的名額」）。
//   status  列出每個 slot 的持有者與排隊者。
//   quota   印 repo 的名額（見「每個 repo 的名額」）。
//   stats   讀量測 log，依 label 印件數與 wait_ms、run_ms 的中位數、P90（nearest-rank）；--since 只算 started_at 在它之後的，--label 是 glob（`*`、`?`）。
// slot 數（全機一個設定）：$HEAVY_CHECK_SLOTS（測試用）＞ ~/.config/orca-heavy-check/slots（內容是一個正整數）＞ 2。adapter 不宣告 slot 數，只宣告哪些檢查經 slot 跑。
// 鎖檔目錄：$HEAVY_CHECK_DIR，預設 ~/.local/state/orca-heavy-check。不用 /tmp、~/.cache（會被清理：持有中的鎖檔被刪，下一個行程建新的同名檔
//   就 flock 得到，兩支同時在 slot 裡），也不用 $XDG_RUNTIME_DIR（git hook、cron、Orca 分頁不一定都有它，有的有、有的沒有就分成兩組 slot）。
// 其他環境變數：HEAVY_CHECK_TIMEOUT、HEAVY_CHECK_WAIT_INTERVAL、HEAVY_CHECK_REPO_PRIORITY（repo 優先序，逗號分隔）、HEAVY_CHECK_AGE_S（防餓死升級的間隔秒數）、HEAVY_CHECK_POLL（排隊重算的間隔秒數，預設 1）、
//   HEAVY_CHECK_RESUME_S（逾時紀錄的沿用期限秒數，預設 7200，0 停用）、HEAVY_CHECK_STARVE_S（餓死保底的門檻秒數，預設 7200，0 關閉）、
//   HEAVY_CHECK_REPO_SLOTS（每個 repo 的名額）、HEAVY_SLOT_FALLBACK（1 同 --fallback）。
// 量測 log：每次 run 拿到 slot 並結束、或等到逾時，在鎖檔目錄的 log.jsonl 追加一行
//   `{ label, repo（label 冒號前）, pid, wait_ms, run_ms, exit, load1（拿到 slot 時的 1 分鐘 load；逾時時是放棄時的）, started_at（開始排隊，ISO）, timed_out,
//   priority（基本優先級）, effective_priority（拿到 slot 或逾時那一刻的有效優先級）, starve（這個 slot 是不是用餓死保底拿的；逾時時是 false） }`；
//   priority 兩欄與 starve 是後來加的，舊紀錄沒有，stats 不用它們。--fallback 拿到 slot 或逾時的紀錄多一欄 `fallback: true`。
//   名額 0 交給 CI（SLOT_DELEGATED）也記一行：`{ label, repo, pid, started_at, wait_ms: 0, run_ms: 0, exit: 76, timed_out: false, delegated: true }`。
//   寫不進去只略過，不影響命令與 exit code。巢狀（SLOT_NESTED）與 SLOT_UNAVAILABLE 不記。
// stderr（run；命令自己的輸出照原樣）：
//   SLOT_WAIT <label> <已等秒數>s holders=<label>@<pid>:<已持有秒數>s[,…] rank=<名次>/<排隊數> priority=<有效優先級>[ starve=1]
//                                                                           排隊中，每 interval 秒一行（第一行在等滿 interval 時）；holders 沒人時是 `-`；
//                                                                           rank、priority 是最近一次算的排隊結果（還沒算過時是 `?`）；
//                                                                           starve=1：已符合餓死保底（等下一個空出的 slot，或在等保底 slot 釋放）
//   SLOT_ACQUIRED <label> slot-<i>/<N> waited=<秒數>s[ starve=1]            拿到 slot，接著執行命令（量排隊時間用）；starve=1 是用餓死保底拿的
//   SLOT_TIMEOUT <label> <已等秒數>s holders=…                               等到上限，不執行命令，exit 75：呼叫端當負載關卡處理（稍後重跑），不是檢查失敗
//   SLOT_RESUMED <label> since=<ISO>                                         沿用上次逾時留下的 since（見「逾時重跑保留排隊位置」），只是資訊、不必處理，接著照常排隊
//   SLOT_DELEGATED <label> ci                                               repo 名額 0：不執行命令，exit 76，交給 CI（見「每個 repo 的名額」）
//   SLOT_NESTED <label> held=<外層>                                          已在 slot 裡（HEAVY_SLOT_HELD），直接執行
//   SLOT_UNAVAILABLE <label> <原因>                                          沒有 perl 或鎖檔目錄建不了，不限流、直接執行
// stdout（status）：`SLOTS <忙>/<N> dir=<目錄>`，每個持有者 `HOLDER slot-<i> <label> pid=<pid> held=<秒數>s cwd=<目錄>[ starve=1]`，
//   每個排隊者依排隊順序 `WAITER <label> pid=<pid> waited=<秒數>s cwd=<目錄> rank=<名次> priority=<有效優先級> base=<基本優先級> repo_rank=<repo 名次>[ starve=1]`
//   （repo_rank 從 1 起算，沒列在 repo 優先序裡的 repo 是清單長度 + 1；持有者的 starve=1 是用餓死保底拿的 slot，排隊者的是已符合餓死保底）。
// stdout（stats）：每個 label 一行（依 label 排序）`STATS <label> n=<件數> timeouts=<逾時件數> wait_p50=<ms> wait_p90=<ms> run_p50=<ms> run_p90=<ms> run_sum=<ms> wait_sum=<ms> delegated=<件數> fallback=<件數>`
//   （n、百分位與總和不含 delegated 的紀錄；run 只算拿到 slot 的件數，沒有時印 `-`；fallback 是 --fallback 排隊的件數）；沒有任何符合的紀錄時印 `STATS none`。
// 不提供 acquire／release：wrapper 已涵蓋兩個 repo 的入口；而且 Claude 的每次 Bash 呼叫是新的行程，
//   「acquire 的行程死掉就釋放」與「跨呼叫持有」互斥，只能靠常駐的持有者，又會回到行程死了 slot 卻沒放的風險。
// exit：run 是命令的 exit code，75 等待逾時，76 交給 CI（名額 0），2 用法錯誤；status、stats、quota 0，2 用法錯誤。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants, homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/heavy-slot.mjs run --label <repo>:<用途> [--priority <high|normal|low>] [--timeout <秒>] [--interval <秒>] [--fallback] -- <command> [<arg>...]｜node scripts/heavy-slot.mjs status｜node scripts/heavy-slot.mjs quota <repo>｜node scripts/heavy-slot.mjs stats [--since <ISO>] [--label <glob>]';

/** 等待逾時的 exit code（EX_TEMPFAIL）：呼叫端以它加 SLOT_TIMEOUT 行判斷，不當成檢查失敗。 */
export const SLOT_TIMEOUT_EXIT = 75;
/** repo 名額 0 時 run 的 exit code：交給 CI，不是通過也不是失敗；呼叫端以它加 SLOT_DELEGATED 行判斷（slotDelegatedLine）。 */
export const SLOT_DELEGATED_EXIT = 76;
const LABEL = /^[\w.:@/-]+$/;
/** perl 輪詢鎖檔的間隔秒數。 */
const POLL = process.env.HEAVY_CHECK_POLL || '1';

const SCRIPT = fileURLToPath(import.meta.url);

// stdin 每收到一行（本程式在輪到自己時送 TRY）就依序試每個鎖檔一次：拿到就清空鎖檔、印 ACQUIRED <i>（持有者資訊由本程式接著寫入），
// 然後讀 stdin 直到 EOF（呼叫者結束或關閉 stdin）才結束、釋放；都拿不到印 BUSY。排隊時 stdin 關閉（呼叫者死掉）就結束，不留孤兒。
const HOLDER = `use strict; use Fcntl qw(:flock);
$| = 1;
my @files = @ARGV;
while (defined(my $line = <STDIN>)) {
  for my $i (0 .. $#files) {
    open(my $fh, '>>', $files[$i]) or die "open $files[$i]: $!\\n";
    if (flock($fh, LOCK_EX | LOCK_NB)) {
      truncate($fh, 0);
      print "ACQUIRED $i\\n";
      1 while <STDIN>;
      exit 0;
    }
    close($fh);
  }
  print "BUSY\\n";
}
exit 0;`;

// 每個鎖檔一行 busy 或 free：拿得到共用鎖就是沒人持有（立刻放掉）。
const PROBE = `use strict; use Fcntl qw(:flock);
for my $f (@ARGV) {
  my $fh;
  if (!open($fh, '<', $f)) { print "free\\n"; next; }
  print flock($fh, LOCK_SH | LOCK_NB) ? "free\\n" : "busy\\n";
  close($fh);
}`;

const home = env => env.HOME || homedir();

/** 鎖檔目錄：$HEAVY_CHECK_DIR，預設 ~/.local/state/orca-heavy-check。 */
export const slotDir = (env = process.env) => env.HEAVY_CHECK_DIR || join(home(env), '.local/state/orca-heavy-check');

/** 全機的 slot 數設定檔。 */
export const slotsFile = (env = process.env) => join(home(env), '.config/orca-heavy-check/slots');

/** slot 數：$HEAVY_CHECK_SLOTS ＞ ~/.config/orca-heavy-check/slots ＞ 2；取到的值不是正整數時 undefined。 */
export function slotCount(env = process.env) {
  let value = env.HEAVY_CHECK_SLOTS;
  if (value === undefined) {
    try { value = readFileSync(slotsFile(env), 'utf8').trim(); } catch { value = '2'; }
  }
  return /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

/** 量測 log 追加一行；失敗只略過。 */
function logRun(dir, record) {
  try { appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify(record)}\n`); } catch { /* 不影響命令 */ }
}

/** nearest-rank 百分位；空陣列時 undefined。 */
export function percentile(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const globRegExp = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/** log.jsonl 的內容 → 依 label 的統計行；since 是 ISO 時間、label 是 glob，都可省略。壞掉的行略過。 */
export function statsLines(text, { since, label } = {}) {
  const sinceMs = since ? Date.parse(since) : undefined;
  const match = label ? globRegExp(label) : undefined;
  const groups = new Map();
  for (const line of text.split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record.label !== 'string') continue;
    if (sinceMs !== undefined && !(Date.parse(record.started_at) >= sinceMs)) continue;
    if (match && !match.test(record.label)) continue;
    if (!groups.has(record.label)) groups.set(record.label, []);
    groups.get(record.label).push(record);
  }
  const sum = values => values.reduce((a, b) => a + b, 0);
  if (!groups.size) return ['STATS none'];
  const show = value => (value === undefined ? '-' : String(value));
  return [...groups.keys()].sort().map(name => {
    const all = groups.get(name);
    const records = all.filter(r => !r.delegated);
    const waits = records.map(r => r.wait_ms).filter(Number.isFinite);
    const runs = records.filter(r => !r.timed_out).map(r => r.run_ms).filter(Number.isFinite);
    return `STATS ${name} n=${records.length} timeouts=${records.filter(r => r.timed_out).length} wait_p50=${show(percentile(waits, 50))} wait_p90=${show(percentile(waits, 90))} run_p50=${show(percentile(runs, 50))} run_p90=${show(percentile(runs, 90))} run_sum=${sum(runs)} wait_sum=${sum(waits)} delegated=${all.length - records.length} fallback=${records.filter(r => r.fallback).length}`;
  });
}

const lockFiles = (dir, slots) => Array.from({ length: slots }, (_, i) => join(dir, `slot-${i + 1}.lock`));
const seconds = ms => Math.floor(ms / 1000);
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
};

/**
 * 目前的持有者與排隊者：{ holders: [{ slot, label, pid, cwd, since }], waiters: [{ label, pid, cwd, since }] }。
 * 持有者以 flock 判斷（鎖檔內容可能是上一個持有者留下的）；排隊者的 pid 已不在時刪掉它的檔。沒有 perl 時丟出。
 */
export function readSlots({ dir = slotDir(), slots = slotCount() ?? 2 } = {}) {
  const files = lockFiles(dir, slots);
  const probe = spawnSync('perl', ['-e', PROBE, ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (probe.error) throw probe.error;
  const states = probe.stdout.trim().split('\n');
  const holders = files.flatMap((file, i) => states[i] === 'busy' ? [{ slot: i + 1, label: '?', ...readJson(file) }] : []);
  let names = [];
  try { names = readdirSync(dir).filter(name => /^wait-\d+\.json$/.test(name)); } catch { /* 目錄還沒建 */ }
  const holding = new Set(holders.map(h => h.pid));
  const waiters = names.flatMap(name => {
    const info = readJson(join(dir, name));
    const pid = Number(name.match(/\d+/)[0]);
    if (!alive(pid)) { rmSync(join(dir, name), { force: true }); return []; }
    // 剛拿到 slot、還沒刪 wait 檔的持有者不算排隊者。舊版 wait 檔沒有 priority：由 label 推。
    if (!info || holding.has(pid)) return [];
    return [{ ...info, pid, priority: PRIORITIES.includes(info.priority) ? info.priority : labelPriority(String(info.label ?? '')) }];
  });
  return { holders, waiters };
}

/** 優先級由高到低；排序時用索引，小的先。 */
export const PRIORITIES = ['high', 'normal', 'low'];

/** label 冒號後的用途 → 基本優先級（對照表見檔頭）。 */
export function labelPriority(label) {
  const use = label.includes(':') ? label.slice(label.indexOf(':') + 1) : '';
  if (/^(push|push-gate|pre-push|land|land-checks)$|^(push|land)-/.test(use)) return 'high';
  if (/^pre-commit$|^pre-commit-/.test(use)) return 'low';
  return 'normal';
}

/** 防餓死升級的間隔毫秒數：$HEAVY_CHECK_AGE_S（預設 900；0 不升級）；不是非負數時用預設。 */
export function ageMs(env = process.env) {
  const value = env.HEAVY_CHECK_AGE_S ?? '900';
  return /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : 900_000;
}

/** 等了 now - since 之後的有效優先級：每滿 age 毫秒升一級，最高 high。 */
export function effectivePriority(priority, since, now = Date.now(), age = ageMs()) {
  const base = Math.max(0, PRIORITIES.indexOf(priority));
  const waited = now - Date.parse(since);
  const steps = age > 0 && waited > 0 ? Math.floor(waited / age) : 0;
  return PRIORITIES[Math.max(0, base - steps)];
}

/** 餓死保底的門檻毫秒數：$HEAVY_CHECK_STARVE_S（預設 7200；0 關閉）；不是非負數時用預設。 */
export function starveMs(env = process.env) {
  const value = env.HEAVY_CHECK_STARVE_S ?? '7200';
  return /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : 7_200_000;
}

/** 逾時紀錄的沿用期限毫秒數：$HEAVY_CHECK_RESUME_S（預設 7200；0 停用）；不是非負數時用預設。 */
export function resumeMs(env = process.env) {
  const value = env.HEAVY_CHECK_RESUME_S ?? '7200';
  return /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : 7_200_000;
}

/** 逾時紀錄的鍵：label＋cwd＋命令 argv 的 sha256 前 16 字元。 */
export const resumeKey = (label, cwd, argv) => createHash('sha256').update(JSON.stringify([label, cwd, argv])).digest('hex').slice(0, 16);

/** 紀錄在期限內而且 since 可解析。 */
const freshResume = (saved, now, limit) => Boolean(saved) && limit > 0 && now - Date.parse(saved.saved_at) <= limit && !Number.isNaN(Date.parse(saved.since));

/**
 * 回收 `lock`（測試用而匯出）：`seen` 是先前判定持有者已不在時讀到的內容。先 rename 成這個行程專屬的檔名再看內容：
 * 仍是 `seen` 才刪；已變成別支剛建的鎖（另一支同時回收同一個死鎖並搶先建了新鎖）就以 link 放回原名（原名已有新鎖時放不回，只能放棄），
 * 不刪掉活著的持有者的鎖。只刪鎖檔本身（非遞迴）。
 */
export function reclaimStaleLock(lock, seen) {
  const mine = `${lock}.${process.pid}.stale`;
  try { renameSync(lock, mine); } catch { return; }
  let content;
  try { content = readFileSync(mine, 'utf8'); } catch { /* 讀不到就當成已變，放回原名 */ }
  if (content !== seen) { try { linkSync(mine, lock); } catch { /* 原名已有新鎖 */ } }
  try { rmSync(mine, { force: true }); } catch { /* 只留下這支專屬的檔名 */ }
}

/**
 * 在 `<file>.lock`（檔案鎖，內容是持有者 pid，以 `wx` 建立）裡跑 fn：同鍵的認領與寫回不交錯（讀和寫之間不會插進另一支）。
 * 等不到鎖（約 2 秒）或建不了鎖時不跑、傳回 undefined。只回收持有者已不在的鎖（還沒寫進 pid 的鎖要超過 10 秒才算；回收見 reclaimStaleLock）；
 * 持有者還活著時鎖再舊也不動。釋放時只刪內容仍是自己 pid 的鎖。認領另是原子 rename，同一筆紀錄不會給兩支沿用。測試用而匯出。
 */
export function withResumeLock(file, fn) {
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') return undefined;
      try {
        const seen = readFileSync(lock, 'utf8');
        const pid = Number(seen);
        const stale = pid > 0 ? !alive(pid) : Date.now() - statSync(lock).mtimeMs > 10_000;
        if (stale) reclaimStaleLock(lock, seen);
      } catch { /* 別人剛放掉或剛清掉 */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }
    try { return fn(); } finally {
      try { if (readFileSync(lock, 'utf8') === String(process.pid)) rmSync(lock); } catch { /* 只影響下一支等鎖 */ }
    }
  }
  return undefined;
}

/**
 * 認領同鍵的逾時紀錄（在鎖裡呼叫）：先 rename 成這個行程專屬的檔名再讀（rename 是原子的，同一筆只有一支拿得到；之後刪除失敗也不會再給別支），
 * 期限內傳回 { since, priority }；過期、壞掉、不是一般檔案或認領失敗傳回 undefined。同名路徑是目錄時不動它；刪除不遞迴；清理失敗只影響續排，不擋檢查。
 */
function takeResume(file, now, limit) {
  try { if (!lstatSync(file).isFile()) return undefined; } catch { return undefined; }
  const claim = `${file}.${process.pid}.claim`;
  try { renameSync(file, claim); } catch { return undefined; }
  const saved = readJson(claim);
  try { rmSync(claim, { force: true }); } catch { /* 只留下這支專屬的檔名，不影響別支 */ }
  if (!freshResume(saved, now, limit)) return undefined;
  return { since: saved.since, priority: PRIORITIES.includes(saved.priority) ? saved.priority : undefined };
}

/** 逾時時寫紀錄（在鎖裡呼叫）：同鍵已有期限內、since 較早的紀錄（另一支同指令先逾時）就保留它，不以較晚的 since 覆蓋；先寫暫存檔再 rename。 */
function saveResume(file, record, limit) {
  const saved = readJson(file);
  const keep = freshResume(saved, Date.now(), limit) && Date.parse(saved.since) < Date.parse(record.since);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(keep ? { ...record, since: saved.since, priority: saved.priority ?? record.priority } : record));
  try { renameSync(temp, file); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

/** label 的 repo：冒號前的字串；沒有冒號時整個 label。 */
export const repoOf = label => String(label ?? '').split(':')[0];

/** repo 優先序設定檔。 */
export const repoPriorityFile = (env = process.env) => join(home(env), '.config/orca-heavy-check/repo-priority');

/** repo 優先序（越前面越優先）：$HEAVY_CHECK_REPO_PRIORITY（逗號分隔）＞ 設定檔（一行一個，空行與 # 開頭略過）＞ spay2、ron-skills。 */
export function repoPriority(env = process.env) {
  let text = env.HEAVY_CHECK_REPO_PRIORITY?.split(',').join('\n');
  if (text === undefined) {
    try { text = readFileSync(repoPriorityFile(env), 'utf8'); } catch { return ['spay2', 'ron-skills']; }
  }
  return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

/** 每個 repo 的名額設定檔。 */
export const repoSlotsFile = (env = process.env) => join(home(env), '.config/orca-heavy-check/repo-slots');

/** 每個 repo 的名額：Map(repo → 非負整數)。$HEAVY_CHECK_REPO_SLOTS（`<repo>=<n>` 逗號分隔）＞ 設定檔（一行 `<repo> <n>`）＞ 空 Map；格式不對的項目略過。 */
export function repoSlots(env = process.env) {
  let entries;
  if (env.HEAVY_CHECK_REPO_SLOTS !== undefined) entries = env.HEAVY_CHECK_REPO_SLOTS.split(',').map(item => item.trim().split('='));
  else {
    let text = '';
    try { text = readFileSync(repoSlotsFile(env), 'utf8'); } catch { return new Map(); }
    entries = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => line.split(/\s+/));
  }
  return new Map(entries.filter(([repo, n, extra]) => repo && extra === undefined && /^\d+$/.test(n ?? '')).map(([repo, n]) => [repo, Number(n)]));
}

/** repo 的名次（0 起算）；沒列出的是清單長度，彼此同級。 */
export const repoRank = (repo, order) => (order.includes(repo) ? order.indexOf(repo) : order.length);

/**
 * 排隊結果：{ order: [排好的等待者，各帶 effective（有效用途優先級）、repoRank 與 starve（已符合餓死保底）], granted: Set(這輪可以去試鎖的 pid),
 * starved（這輪用餓死保底分到 slot 的 pid，沒有時 undefined） }。
 * 依（repo 名次、有效用途優先級、since、pid）排序；只有最前面那一級 repo 的等待者能分到空出的 slot（slots - holders.length），
 * 由列首往後分配。防餓死升級只給最前面那一級，後面的 repo 用基本優先級。
 * 餓死保底（見檔頭）：後面那幾級裡已等滿 starve 毫秒的等待者，在沒有持有者帶 starve 記號時，先拿 1 個空出的 slot（since 最早的），剩下的才照上面分。
 */
export function queuePlan({ holders, waiters, slots, now = Date.now(), age = ageMs(), repos = repoPriority(), starve = starveMs(), quotas = repoSlots() }) {
  // 每個 repo 的名額（n > 0）：已持有 n 個的 repo 的等待者這輪不分配（full），也不算進「最前面那一級」；分配時連這輪給出去的一起算。
  // 名額 0 的 repo 只有 --fallback 的等待者會排進來，照舊排隊、不受名額限制。
  const held = new Map();
  for (const h of holders) held.set(repoOf(h.label), (held.get(repoOf(h.label)) ?? 0) + 1);
  const full = repo => quotas.get(repo) > 0 && (held.get(repo) ?? 0) >= quotas.get(repo);
  const take = repo => held.set(repo, (held.get(repo) ?? 0) + 1);
  const ranked = waiters.map(w => ({ ...w, repoRank: repoRank(repoOf(w.label), repos) }));
  const top = Math.min(...ranked.filter(w => !full(repoOf(w.label))).map(w => w.repoRank));
  const sinceMs = w => Date.parse(w.since) || 0;
  const order = ranked
    .map(w => ({
      ...w,
      effective: w.repoRank === top ? effectivePriority(w.priority, w.since, now, age) : w.priority,
      starve: starve > 0 && w.repoRank > top && Date.parse(w.since) <= now - starve,
    }))
    .sort((a, b) => a.repoRank - b.repoRank || PRIORITIES.indexOf(a.effective) - PRIORITIES.indexOf(b.effective)
      || sinceMs(a) - sinceMs(b) || a.pid - b.pid);
  let free = Math.max(0, slots - holders.length);
  let starved;
  if (free > 0 && !holders.some(h => h.starve)) {
    const pick = order.filter(w => w.starve && !full(repoOf(w.label))).sort((a, b) => sinceMs(a) - sinceMs(b) || a.pid - b.pid)[0];
    if (pick) { starved = pick.pid; take(repoOf(pick.label)); free -= 1; }
  }
  // 每分出一個就重算「最前面那一級」：只有名額 n > 0 的 repo 拿滿時才輪到下一級（已分到的等待者仍算在它那一級裡，
  // 所以沒設名額時和以前一樣：最前面那一級的人分完，剩下的空 slot 也不給後面的 repo）。
  const granted = new Set();
  while (free > 0) {
    const tier = Math.min(...order.filter(w => !full(repoOf(w.label))).map(w => w.repoRank));
    const next = order.find(w => w.repoRank === tier && !granted.has(w.pid) && w.pid !== starved);
    if (!next) break;
    granted.add(next.pid); take(repoOf(next.label)); free -= 1;
  }
  if (starved !== undefined) granted.add(starved);
  return { order, granted, starved };
}

/** SLOT_WAIT／SLOT_TIMEOUT 的 holders 欄：`<label>@<pid>:<秒數>s`，逗號分隔；沒人時 `-`。 */
export function holdersField(holders, now = Date.now()) {
  if (!holders.length) return '-';
  return holders.map(h => `${h.label}@${h.pid ?? '?'}:${h.since ? seconds(now - Date.parse(h.since)) : '?'}s`).join(',');
}

/**
 * 給呼叫端（pilot-land.mjs、land.mjs）組出經 slot 執行 argv 的 [command, args]：同目錄的本程式 `run --label <label> -- <argv>`。
 * timeoutSec 有給時帶 --timeout。一律帶 --fallback：land.mjs、pilot-land.mjs 還不處理 SLOT_DELEGATED（exit 76），名額 0 時照舊在本機排隊，
 * 不會把 76 當成檢查沒過（CoS item 67 的 PR 2 讓它們改交給 CI 後拿掉）。label 裡 --label 不收的字元（目錄名的空白、中文）換成 `_`，否則 run 以用法錯誤 exit 2、被當成檢查沒過。
 */
export function slotCommand(label, argv, { timeoutSec } = {}) {
  return [process.execPath, [SCRIPT, 'run', '--fallback', '--label', label.replace(/[^\w.:@/-]/g, '_'), ...(timeoutSec === undefined ? [] : ['--timeout', String(timeoutSec)]), '--', ...argv]];
}

/** 呼叫端的輸出是不是 slot 等待逾時（exit 75 而且有 SLOT_TIMEOUT 行）；是的話傳回那一行，否則 undefined。 */
export function slotTimeoutLine(code, output) {
  return code === SLOT_TIMEOUT_EXIT ? String(output).match(/^SLOT_TIMEOUT .*$/m)?.[0] : undefined;
}

/** 呼叫端的輸出是不是交給 CI（exit 76 而且有 SLOT_DELEGATED 行）；是的話傳回那一行，否則 undefined。 */
export function slotDelegatedLine(code, output) {
  return code === SLOT_DELEGATED_EXIT ? String(output).match(/^SLOT_DELEGATED .*$/m)?.[0] : undefined;
}

/** 命令列 → { command: 'run', label, timeoutSec, intervalSec, argv, priority?（有給 --priority 才有） } 或 { command: 'status' }；錯誤時 { error }。 */
export function parseArgs(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (command === 'status') return rest.length ? { error: 'status 不接參數' } : { command };
  if (command === 'quota') return rest.length === 1 && rest[0] ? { command, repo: rest[0] } : { error: 'quota 要接一個 repo 名稱' };
  if (command === 'stats') {
    const options = { command };
    for (let i = 0; i < rest.length; i += 2) {
      const [flag, value] = [rest[i], rest[i + 1]];
      if (value === undefined) return { error: `${flag} 要有值` };
      if (flag === '--since') {
        if (Number.isNaN(Date.parse(value))) return { error: `--since 要是 ISO 時間：${value}` };
        options.since = value;
      } else if (flag === '--label') options.label = value;
      else return { error: `不認得的選項 ${flag}` };
    }
    return options;
  }
  if (command !== 'run') return { error: `不認得的子命令：${command ?? '（沒有）'}` };
  const split = rest.indexOf('--');
  if (split < 0 || split === rest.length - 1) return { error: 'run 要以 -- 接要執行的命令' };
  const options = { command, timeoutSec: env.HEAVY_CHECK_TIMEOUT ?? '1800', intervalSec: env.HEAVY_CHECK_WAIT_INTERVAL ?? '30', argv: rest.slice(split + 1) };
  if (env.HEAVY_SLOT_FALLBACK === '1') options.fallback = true;
  const flags = rest.slice(0, split);
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] === '--fallback') { options.fallback = true; i -= 1; continue; }
    const [flag, value] = [flags[i], flags[i + 1]];
    if (value === undefined) return { error: `${flag} 要有值` };
    if (flag === '--label') options.label = value;
    else if (flag === '--timeout') options.timeoutSec = value;
    else if (flag === '--interval') options.intervalSec = value;
    else if (flag === '--priority') options.priority = value;
    else return { error: `不認得的選項 ${flag}` };
  }
  if (!options.label || !LABEL.test(options.label)) return { error: `--label 要是 <repo>:<用途>（[A-Za-z0-9_.:@/-]）：${options.label ?? '（沒有）'}` };
  if (options.priority !== undefined && !PRIORITIES.includes(options.priority)) return { error: `--priority 要是 ${PRIORITIES.join('、')} 之一：${options.priority}` };
  for (const key of ['timeoutSec', 'intervalSec']) {
    const n = Number(options[key]);
    if (!/^\d+(\.\d+)?$/.test(String(options[key])) || (key === 'intervalSec' && n <= 0)) return { error: `${key === 'timeoutSec' ? '--timeout' : '--interval'} 要是${key === 'timeoutSec' ? '非負' : '正'}數：${options[key]}` };
    options[key] = n;
  }
  return options;
}

const signalExit = signal => 128 + (constants.signals[signal] ?? 1);

/** 直接執行命令（不經 slot），exit code 照傳。 */
function runDirect(argv, env = process.env) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env });
    const forward = signal => child.kill(signal);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward);
    child.on('error', error => { process.stderr.write(`heavy-slot: ${argv[0]}：${error.message}\n`); resolve(127); });
    child.on('close', (code, signal) => resolve(code ?? signalExit(signal)));
  });
}

async function run({ label, timeoutSec, intervalSec, argv, priority: override, fallback = false }) {
  if (process.env.HEAVY_SLOT_HELD) {
    process.stderr.write(`SLOT_NESTED ${label} held=${process.env.HEAVY_SLOT_HELD}\n`);
    return runDirect(argv);
  }
  if (!fallback && repoSlots().get(repoOf(label)) === 0) {
    process.stderr.write(`SLOT_DELEGATED ${label} ci\n`);
    const dir = slotDir();
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* logRun 會略過 */ }
    logRun(dir, { label, repo: repoOf(label), pid: process.pid, started_at: new Date().toISOString(), wait_ms: 0, run_ms: 0, exit: SLOT_DELEGATED_EXIT, timed_out: false, delegated: true });
    return SLOT_DELEGATED_EXIT;
  }
  const slots = slotCount();
  if (!slots) {
    process.stderr.write(`slot 數要是正整數（$HEAVY_CHECK_SLOTS 或 ${slotsFile()}）\n${USAGE}\n`);
    return 2;
  }
  const dir = slotDir();
  const started = Date.now();
  const age = ageMs();
  const repos = repoPriority();
  const starve = starveMs();
  const resumeLimit = resumeMs();
  const resumeFile = join(dir, `resume-${resumeKey(label, process.cwd(), argv)}.json`);
  const record = { label, repo: label.split(':')[0], pid: process.pid, started_at: new Date(started).toISOString(), ...(fallback ? { fallback: true } : {}) };
  const waitFile = join(dir, `wait-${process.pid}.json`);
  let priority = override ?? labelPriority(label);
  let info = { label, pid: process.pid, cwd: process.cwd(), since: new Date(started).toISOString() };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 停用（0）時不讀也不刪：仍有效的紀錄留給之後啟用的重跑。
    const resumed = resumeLimit > 0 ? withResumeLock(resumeFile, () => takeResume(resumeFile, started, resumeLimit)) : undefined;
    if (resumed) {
      info = { ...info, since: resumed.since };
      priority = override ?? resumed.priority ?? priority;
      process.stderr.write(`SLOT_RESUMED ${label} since=${resumed.since}\n`);
    }
    writeFileSync(waitFile, JSON.stringify({ ...info, priority, ...(fallback ? { fallback: true } : {}) }));
  } catch (error) {
    process.stderr.write(`SLOT_UNAVAILABLE ${label} ${error.code ?? error.message}\n`);
    return runDirect(argv);
  }
  const dropWait = () => rmSync(waitFile, { force: true });
  process.on('exit', dropWait);

  const holder = spawn('perl', ['-e', HOLDER, ...lockFiles(dir, slots)], { stdio: ['pipe', 'pipe', 'inherit'] });
  holder.stdin.on('error', () => { /* perl 已結束：close 事件會處理 */ });
  // 最近一次算的排隊結果：SLOT_WAIT 的 holders、rank、priority 都從這裡來，不另外再讀。
  // starving：最近一次算的時候已符合餓死保底；starveGrant：最近一次輪到自己是靠餓死保底（拿到 slot 時據此在鎖檔記 starve）。
  let latest = { holders: undefined, rank: '?', total: '?', effective: '?', starving: false, starveGrant: false };
  const plan = () => {
    let state;
    try { state = readSlots({ dir, slots }); } catch { return true; } // 讀不到排隊狀態（例如 probe 失敗）：退回直接試鎖
    if (!state.waiters.some(w => w.pid === process.pid)) state.waiters.push({ ...info, priority });
    const { order, granted, starved } = queuePlan({ ...state, slots, age, repos, starve });
    const rank = order.findIndex(w => w.pid === process.pid);
    latest = { holders: state.holders, rank: rank + 1, total: order.length, effective: order[rank].effective, starving: order[rank].starve, starveGrant: starved === process.pid };
    return granted.has(process.pid);
  };
  const holdersNow = () => {
    try { return holdersField(readSlots({ dir, slots }).holders); } catch { return '?'; }
  };
  const acquired = await new Promise(resolve => {
    let out = '';
    let trying = false;
    let finished = false;
    const timers = [];
    const done = value => {
      if (finished) return;
      finished = true;
      timers.forEach(clearInterval); timers.forEach(clearTimeout);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, onSignal);
      resolve(value);
    };
    const onSignal = signal => { holder.kill('SIGKILL'); done({ signal }); };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
    const tick = () => {
      if (finished || trying) return;
      if (plan()) { trying = true; holder.stdin.write('TRY\n'); }
    };
    holder.on('error', error => done({ error }));
    holder.on('close', code => done({ error: new Error(`perl exit ${code}`) }));
    holder.stdout.setEncoding('utf8').on('data', chunk => {
      out += chunk;
      const slot = out.match(/^ACQUIRED (\d+)$/m)?.[1];
      if (slot !== undefined) return done({ slot: Number(slot) + 1 });
      if (/^BUSY$/m.test(out)) { out = out.replace(/^BUSY\n/gm, ''); trying = false; }
    });
    tick();
    timers.push(setInterval(tick, Number(POLL) * 1000));
    timers.push(setInterval(() => {
      const holders = latest.holders ? holdersField(latest.holders) : holdersNow();
      process.stderr.write(`SLOT_WAIT ${label} ${seconds(Date.now() - started)}s holders=${holders} rank=${latest.rank}/${latest.total} priority=${latest.effective}${latest.starving ? ' starve=1' : ''}\n`);
    }, intervalSec * 1000));
    if (timeoutSec > 0) timers.push(setTimeout(() => { holder.kill('SIGKILL'); done({ timeout: true }); }, timeoutSec * 1000));
  });
  const effective = effectivePriority(priority, info.since, Date.now(), age);
  if (acquired.signal) { dropWait(); return signalExit(acquired.signal); }
  if (acquired.timeout) {
    dropWait();
    if (resumeLimit > 0) {
      try { withResumeLock(resumeFile, () => saveResume(resumeFile, { label, cwd: info.cwd, argv, since: info.since, priority, saved_at: new Date().toISOString() }, resumeLimit)); } catch { /* 只影響下次重跑的排隊位置 */ }
    }
    process.stderr.write(`SLOT_TIMEOUT ${label} ${seconds(Date.now() - started)}s holders=${holdersNow()}\n`);
    logRun(dir, { ...record, wait_ms: Date.now() - started, run_ms: 0, exit: SLOT_TIMEOUT_EXIT, load1: loadavg()[0], timed_out: true, priority, effective_priority: effective, starve: false });
    return SLOT_TIMEOUT_EXIT;
  }
  if (acquired.error) {
    dropWait();
    process.stderr.write(`SLOT_UNAVAILABLE ${label} ${acquired.error.code ?? acquired.error.message}\n`);
    return runDirect(argv);
  }
  holder.removeAllListeners('close');
  // 持有期間 perl 不再印東西，只等 stdin 關閉後自己結束。鎖檔只是記錄，從另一個 fd 寫入不影響 flock。
  // 先寫鎖檔再刪 wait 檔：其他排隊者讀到的持有者才不會是上一個持有者留下的 label。
  // 靠餓死保底拿到的 slot 在鎖檔記 starve：其他排隊者讀到它就知道保底 slot 已在用，不再用這條規則。
  const starveSlot = latest.starveGrant;
  try { writeFileSync(lockFiles(dir, slots)[acquired.slot - 1], JSON.stringify({ ...info, since: new Date().toISOString(), ...(starveSlot ? { starve: true } : {}) })); } catch { /* 只影響 status 顯示與保底計數 */ }
  dropWait();
  process.stderr.write(`SLOT_ACQUIRED ${label} slot-${acquired.slot}/${slots} waited=${seconds(Date.now() - started)}s${starveSlot ? ' starve=1' : ''}\n`);
  const runStarted = Date.now();
  const load1 = loadavg()[0];
  const code = await runDirect(argv, { ...process.env, HEAVY_SLOT_HELD: `${label} slot-${acquired.slot}` });
  holder.stdin.end();
  logRun(dir, { ...record, wait_ms: runStarted - started, run_ms: Date.now() - runStarted, exit: code, load1, timed_out: false, priority, effective_priority: effective, starve: starveSlot });
  return code;
}

function status() {
  const slots = slotCount();
  if (!slots) {
    process.stderr.write(`slot 數要是正整數（$HEAVY_CHECK_SLOTS 或 ${slotsFile()}）\n`);
    return 2;
  }
  const dir = slotDir();
  const { holders, waiters } = readSlots({ dir, slots });
  const now = Date.now();
  const age = since => (since ? `${seconds(now - Date.parse(since))}s` : '?');
  console.log(`SLOTS ${holders.length}/${slots} dir=${dir}`);
  for (const h of holders) console.log(`HOLDER slot-${h.slot} ${h.label} pid=${h.pid ?? '?'} held=${age(h.since)} cwd=${h.cwd ?? '?'}${h.starve ? ' starve=1' : ''}`);
  const { order } = queuePlan({ holders, waiters, slots, now, repos: repoPriority() });
  order.forEach((w, i) => console.log(`WAITER ${w.label} pid=${w.pid} waited=${age(w.since)} cwd=${w.cwd ?? '?'} rank=${i + 1} priority=${w.effective} base=${w.priority} repo_rank=${w.repoRank + 1}${w.starve ? ' starve=1' : ''}`));
  return 0;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stderr.write(`${options.error}\n${USAGE}\n`);
    return 2;
  }
  if (options.command === 'stats') {
    let text = '';
    try { text = readFileSync(join(slotDir(), 'log.jsonl'), 'utf8'); } catch { /* 還沒有紀錄 */ }
    for (const line of statsLines(text, options)) console.log(line);
    return 0;
  }
  if (options.command === 'quota') {
    console.log(`QUOTA ${options.repo} ${repoSlots().get(options.repo) ?? '-'}`);
    return 0;
  }
  return options.command === 'status' ? status() : run(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
