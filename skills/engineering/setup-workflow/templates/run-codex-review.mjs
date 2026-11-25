#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// issue-run adapter 的 Review：以固定模型／effort 執行 Codex code-review，並以確定性規則判定結果。
// 用法：node scripts/run-codex-review.mjs <baseline|state:<path>> <spec> <worktree> <out-dir> [rulings]
// baseline 寫成 `state:<path>` 時讀該檔（相對路徑以 runner cwd 解析）的 `baseline:` 行（40 位 SHA）當 fixed point，讓 sync 與 review 串在同一個命令時
// review 拿到 sync 剛寫回的值（spay2 retro 5e2b0c21#2：寫死的舊 baseline 回 BASELINE_STALE，多跑一輪）。檔案讀不到或沒有 40 位 SHA 的 `baseline:` 行時
// 判 BASELINE_STATE_UNREADABLE（actionable，JSON 帶 state 與 reason：檢查路徑，或先跑 sync 寫入 baseline:），不呼叫 Codex。
//       node scripts/run-codex-review.mjs --quota（唯讀：不呼叫 Codex，讀 $CODEX_HOME（預設 ~/.codex）/sessions 最新 rollout 的 rate_limits）
// --quota 印一行 `CODEX_QUOTA used_percent=<n|?> window_minutes=<n|?> resets_at=<ISO|?> reached=<rate_limit_reached_type|none>`（not actionable，只供參考：
// 是上一次 Codex 呼叫留下的舊紀錄，不能拿來決定跳過 runner），找不到任何 rollout 時印 `CODEX_QUOTA_UNKNOWN`；皆 exit 0。
// 欄位都取自最新一份帶 rate_limits 的 rollout：reached 取該檔最新一筆，used_percent／window_minutes／resets_at 取同一檔最新一筆帶 secondary（週額度）的；
// 同一檔沒有 secondary（額度用完時為 null）就印 ?，不拿更舊 rollout 的 resets_at 拼湊（CoS item 124）。resets_at 不用來擋人，也不寫進 hint。
// 不做額度預檢、一律真的呼叫 Codex（CoS item 124）：舊的預檢只讀本機 rollout，判定用完就不呼叫，於是不會產生新 rollout，
// 11-21 20:51 一筆 workspace_member_credits_depleted 之後擋了 spay2 約三天、25 次 review，期間 credits 早已恢復。額度不足改由執行後的 log 判定。
// 每次結束在 stdout 印一行 reviewer 結論（actionable）：`REVIEWER=codex model=<model>`（成功，JSON 在下一行），
// 或 `REVIEWER=claude reason=<quota|not-installed|not-logged-in|timeout|error:<CODE>>`（Codex 不可用，本輪改用 code-review skill，JSON 在 stderr）；
// 參數或 baseline 錯誤（USAGE、SPEC_MISSING、SPEC_NOT_REVIEWED、RULINGS_*、BASELINE_*、SNAPSHOT_FAILED）不印 REVIEWER：修正後重跑 runner，不是退回 Claude 的理由。
// 印 REVIEWER 時另寫 <out-dir>/reviewer.json，並在主 checkout（git common dir 的上層）的 .scratch/review-log.jsonl 附加一筆，worktree 刪掉後仍查得到。
// 呼叫前先跑 `codex login status`（20 秒上限）：找不到執行檔判 not-installed，exit 非 0 判 not-logged-in，逾時判 error:login-status。
// Codex 本身以 CODEX_REVIEW_TIMEOUT_MS（預設 40 分鐘）為上限，逾時判 timeout。
// rulings：已裁決項目（接受為已知限制或不修，各附理由）；重新審查時帶入，避免重提已裁決的 finding。
// spec 與 rulings 以 runner 自己的 cwd 解析成絕對路徑再放進 prompt：Codex 的 cwd 是 worktree，相對路徑會對 worktree 解析而找不到
// （retro fc336d0c#1：主 checkout 傳 `.scratch/retro/plan-1106a.md`，Spec 段整段沒審卻回 OK）。spec 不存在或為空時判 SPEC_MISSING；rulings 不存在判 RULINGS_MISSING，存在但為空判 RULINGS_EMPTY（actionable，JSON 帶 next：寫入裁定或刪檔後不帶 rulings 重跑），皆不呼叫 Codex
// （retro spay2 followups #797：空的 rulings.md 回 RULINGS_MISSING 讀起來像檔案不存在，多跑一輪）。
// review.md 寫出未完成需求（Spec）審查（如「未完成需求符合性審查」「Spec：缺少來源」）時判 SPEC_NOT_REVIEWED；反引號、「」、半形 "…" 與全形 “…” 內的引用不算。
// 產出 <out-dir>/review.md 與 <out-dir>/codex.log；成功 exit 0，任何失敗 exit 1 並於 stderr 輸出一行 JSON。
// baseline 先在 worktree 解析為完整 commit SHA 再交給 Codex：解析不到時 Codex 只會寫「無法開始 review」的報告，不能算 OK。
// out-dir（或其上層）有 checkpoint `state.md`（含 `integration:` 行）時，baseline 還必須等於 HEAD 與其 `integration:` 的 merge-base：
// drift check 剛合併過整合分支而 baseline 沒跟上時判 BASELINE_STALE，不讓 review 把上游變更當成任務 diff。
// 疊在 blocker 候選上（checkpoint `baseline:` 是 HEAD 的祖先但不在整合分支上）時，
// 預期值改為 checkpoint `baseline:` 本身，因為 stacked 卡的 merge-base 必然不等於 blocker 候選。
// 沙箱為 workspace-write（codex 一定讓 cwd 可寫，無法只開暫存目錄），故 review 前後比對 worktree 快照，有變動即判定 REVIEW_WROTE_REPO；
// runner 自己寫的 review.md／codex.log 不計入（out-dir 可能位於 worktree 內且未被忽略）。
// 模型降級：主模型回報容量不足（log 行首 `ERROR: Selected model is at capacity`）時，把該次 log 改名為 codex.<model>.log，
// 改用 FALLBACK_MODEL 重跑一次，MODEL_MISMATCH 改以實際使用的模型比對；stdout JSON 降級時另帶 fallbackFrom。
// 沙箱開放網路（sandbox_workspace_write.network_access=true）：網路關閉時 seccomp 擋下 Node 建 stdio pipe，reviewer 的 spawnSync 回 EPERM、無法跑 fixture 測試。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const MODEL = 'gpt-6.2-sol';
const FALLBACK_MODEL = 'gpt-6.2-astra';
const AT_CAPACITY = /^ERROR: Selected model is at capacity/m;
// 帳務問題，重跑無用（retro spay2 86eda4c4#2：只回 CODEX_EXIT 時要讀 log 才知道）。比對行首，diff 引用這句時不算。
// workspace credits 會由 workspace owner 補充或重置（CoS item 124），不是永久用完：hint 只說本輪退回，下一輪照樣先試 Codex。
// Codex CLI 0.166.0 的用量上限另印 `You've hit your usage limit`，撇號可能是彎撇號 ’（spay2 CoS item 124 review）。
const NO_CREDITS = /^ERROR: (?:Your workspace is out of credits|You['’]ve hit your usage limit)/m;
const NO_CREDITS_HINT = 'Codex 額度不足：本輪改用 code-review skill 審查；下一輪照樣先跑本 runner，不要沿用這次的結論';
const LOGIN_TIMEOUT_MS = 20000;
const TIMEOUT_MS = Number(process.env.CODEX_REVIEW_TIMEOUT_MS) || 40 * 60 * 1000;
const EFFORT = 'medium';
// 只認帶時間戳的 log 行；review diff 或 Codex 讀取的檔案引用這句時不會以時間戳開頭。
const SPAWN_FAILED = /^[0-9TZ:.-]+ ERROR codex_core::tools::router: error=collab spawn failed/m;

/** 依修改時間新到舊列出 rollout 檔，最多 limit 個。 */
function rollouts(limit = 20) {
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'); const files = [];
  const walk = dir => { let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) { const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path); else if (/^rollout-.*\.jsonl$/.test(entry.name)) files.push([statSync(path).mtimeMs, path]); } };
  walk(root);
  return files.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, path]) => path);
}
/** 讀最新一份帶 rate_limits 的 rollout：reached 取該檔最新一筆，週額度（secondary）只取同一檔最新一筆非 null；沒有 rollout 時回 null。
 *  不往更舊的 rollout 找週額度：新 rollout 的 reached 配舊 rollout 的 resets_at 會拼出一個不存在的重置時間（CoS item 124：印出「12/1 重置」，
 *  其實是 11-21 depleted 紀錄配上更早一份的週額度 resets_at，和 GitHub 帳單的重置日也對不上）。同一檔找不到週額度時 used_percent／window_minutes／resets_at 印 ?（未知）。 */
function codexQuota() {
  const files = rollouts(); if (!files.length) return null;
  for (const file of files) {
    let reached; let weekly;
    for (const line of readFileSync(file, 'utf8').split('\n').reverse()) {
      if (!line.includes('"rate_limits"')) continue;
      let limits; try { limits = findLimits(JSON.parse(line)); } catch { continue; }
      if (!limits) continue;
      if (reached === undefined) reached = limits.rate_limit_reached_type ?? 'none';
      if (limits.secondary) { weekly = limits.secondary; break; }
    }
    if (reached === undefined) continue;
    const iso = weekly?.resets_at ? new Date(weekly.resets_at * 1000).toISOString() : '?';
    return { used_percent: weekly?.used_percent ?? '?', window_minutes: weekly?.window_minutes ?? '?', resets_at: iso, reached };
  }
  return { used_percent: '?', window_minutes: '?', resets_at: '?', reached: 'none' };
}
function findLimits(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.rate_limits && typeof node.rate_limits === 'object') return node.rate_limits;
  for (const value of Object.values(node)) { const hit = findLimits(value); if (hit) return hit; }
  return null;
}
const quotaLine = quota => quota ? `CODEX_QUOTA used_percent=${quota.used_percent} window_minutes=${quota.window_minutes} resets_at=${quota.resets_at} reached=${quota.reached}` : 'CODEX_QUOTA_UNKNOWN';

function fail(error, detail = {}) {
  process.stderr.write(JSON.stringify({ error, ...detail }) + '\n');
  process.exit(1);
}
/** 主 checkout 的 .scratch/review-log.jsonl：git common dir 是 `<main>/.git` 時取其上層，否則（或不是 git repo）用 runner 的 cwd。 */
function reviewLogPath(wt) {
  const common = spawnSync('git', ['-C', wt, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const dir = common.status === 0 && basename(common.stdout.trim()) === '.git' ? dirname(common.stdout.trim()) : process.cwd();
  return join(dir, '.scratch', 'review-log.jsonl');
}
/** 印 REVIEWER 行並寫紀錄；紀錄寫不進去只在 stderr 提醒，不改變結論。 */
function announce(record) {
  process.stdout.write(record.reviewer === 'codex' ? `REVIEWER=codex model=${record.model}\n` : `REVIEWER=claude reason=${record.reason}\n`);
  const entry = { ts: new Date().toISOString(), ...record, worktree: resolve(worktree), outDir: resolve(outDir), baseline: fixedPoint,
    branch: spawnSync('git', ['-C', worktree, 'branch', '--show-current'], { encoding: 'utf8' }).stdout?.trim() || null };
  try {
    mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, 'reviewer.json'), JSON.stringify(entry, null, 2) + '\n');
    const logFile = reviewLogPath(worktree); mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch (error) { process.stderr.write(`REVIEWER_LOG_FAILED ${error.message}\n`); }
}
/** Codex 不可用：印 `REVIEWER=claude reason=<reason>`、寫紀錄，再以 error 結束。 */
function fallback(reason, error, detail = {}) {
  announce({ reviewer: 'claude', reason, error });
  fail(error, { reviewer: 'claude', reason, ...detail });
}
// Codex log 開頭兩條 `--------` 之間是 session 設定；只讀這段，避免後續 diff 內容冒充。
function header(log) {
  const lines = log.split('\n'); const start = lines.indexOf('--------');
  const end = start < 0 ? -1 : lines.indexOf('--------', start + 1);
  const fields = {};
  for (const line of end < 0 ? [] : lines.slice(start + 1, end)) {
    const match = /^([a-z ]+): (.*)$/.exec(line); if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}
// worktree 快照：porcelain 狀態碼加上每個已修改、intent-to-add 或未追蹤檔的內容 hash；被忽略的檔案（如 .scratch out dir）與 own（runner 自身輸出）不納入。
function snapshot(dir, own) {
  const status = spawnSync('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (status.error || status.status !== 0) fail('SNAPSHOT_FAILED', { worktree: dir, message: status.error?.message ?? status.stderr.trim() });
  return new Map(status.stdout.split('\0').filter(Boolean).filter(entry => !own.has(resolve(dir, entry.slice(3))))
    .map(entry => [entry.slice(3), `${entry.slice(0, 2)} ${digest(join(dir, entry.slice(3)))}`]));
}
function digest(file) {
  try {
    const content = lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(file);
    return createHash('sha256').update(content).digest('hex');
  } catch (error) { return error.code; }
}
function changedPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort();
}

const isAncestor = (wt, ancestor, descendant) => spawnSync('git', ['-C', wt, 'merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
/** out-dir 或其上層目錄的 checkpoint（state.md 含 integration:）所推得的預期 baseline：stacked 時為 checkpoint baseline:，否則為 merge-base；找不到 checkpoint 時回 null（不檢查）。 */
function expectedBaseline(dir, wt) {
  for (const candidate of [resolve(dir), resolve(dir, '..')]) {
    const file = join(candidate, 'state.md');
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const integration = /^integration:\s*(\S+)/m.exec(text)?.[1];
    if (!integration) return null;
    const recorded = /^baseline:[ \t]*([0-9a-f]{40})\b/m.exec(text)?.[1];
    if (recorded && !isAncestor(wt, recorded, integration) && isAncestor(wt, recorded, 'HEAD')) return recorded;
    const base = spawnSync('git', ['-C', wt, 'merge-base', 'HEAD', integration], { encoding: 'utf8' });
    return base.status === 0 ? base.stdout.trim() : null;
  }
  return null;
}

if (process.argv[2] === '--quota') { process.stdout.write(quotaLine(codexQuota()) + '\n'); process.exit(0); }
const [baseline, specArg, worktree, outDir, rulingsArg] = process.argv.slice(2);
if (!baseline || !specArg || !worktree || !outDir) fail('USAGE', { usage: 'run-codex-review.mjs <baseline|state:<path>> <spec> <worktree> <out-dir> [rulings]' });
/** `state:<path>` → 該檔 `baseline:` 行的 40 位 SHA；其他值原樣傳回。 */
function baselineFrom(arg) {
  if (!arg.startsWith('state:')) return arg;
  const state = resolve(arg.slice('state:'.length));
  let text;
  try { text = readFileSync(state, 'utf8'); } catch (error) { fail('BASELINE_STATE_UNREADABLE', { state, reason: error.code ?? error.message }); }
  const recorded = /^baseline:[ \t]*([0-9a-f]{40})\b/m.exec(text)?.[1];
  if (!recorded) fail('BASELINE_STATE_UNREADABLE', { state, reason: '沒有 40 位 SHA 的 baseline: 行' });
  return recorded;
}
const fixedArg = baselineFrom(baseline);
const spec = resolve(specArg); const rulings = rulingsArg && resolve(rulingsArg);
const missing = file => !existsSync(file) || statSync(file).size === 0;
if (missing(spec)) fail('SPEC_MISSING', { spec });
if (rulings && !existsSync(rulings)) fail('RULINGS_MISSING', { rulings });
if (rulings && statSync(rulings).size === 0) fail('RULINGS_EMPTY', { rulings, next: '寫入已裁決項目後重跑，或刪除此檔並不帶 rulings 參數重跑' });
// 報告表示 Spec 段沒審：先去掉反引號、「」、半形 "…" 與全形 “…” 內的引用，避免 diff 或 finding 引用這些字句時誤判（review 1106b：`- P3 regex 對 "未完成需求符合性審查" 判定過寬`）。
const SPEC_NOT_REVIEWED = /未完成(?:需求|Spec)(?:符合性)?審查|(?:無法|不能|未能)(?:進行|完成)(?:需求|Spec)(?:符合性)?審查|Spec[:：]\s*缺少來源/i;
const specNotReviewed = text => text.split('\n').some(line => SPEC_NOT_REVIEWED.test(line.replace(/`[^`]*`|「[^」]*」|"[^"]*"|“[^”]*”/g, '')));
mkdirSync(outDir, { recursive: true });
const report = join(outDir, 'review.md'); const logPath = join(outDir, 'codex.log');
const own = new Set([resolve(report), resolve(logPath), resolve(outDir, 'reviewer.json')]);
rmSync(report, { force: true }); rmSync(join(outDir, 'reviewer.json'), { force: true });

// 不加 --ephemeral：reviewer 以 fork_turns 載入父 rollout，ephemeral session 沒有 rollout。
const args = model => ['exec', '-s', 'workspace-write', '--ignore-user-config', '-m', model, '-c', `model_reasoning_effort=${EFFORT}`,
  '-c', 'sandbox_workspace_write.network_access=true', '-C', worktree, '-o', report, '-'];
const before = snapshot(worktree, own);
const resolved = spawnSync('git', ['-C', worktree, 'rev-parse', '--verify', '--quiet', `${fixedArg}^{commit}`], { encoding: 'utf8' });
if (resolved.status !== 0) fail('BASELINE_INVALID', { baseline: fixedArg, worktree });
const fixedPoint = resolved.stdout.trim();
const expected = expectedBaseline(outDir, worktree);
if (expected && expected !== fixedPoint) fail('BASELINE_STALE', { baseline: fixedPoint, mergeBase: expected, hint: '先把 state.md 的 baseline: 更新為 HEAD 與整合分支的 merge-base，再以它重跑' });
const ruled = rulings ? ` Rulings: ${rulings}. These findings were already arbitrated; re-raise a ruled finding only when this diff changes the premise of its ruling, and say which change.` : '';
const prompt = `Use the code-review skill. Fixed point: ${fixedPoint}. Spec: ${spec}.${ruled} Diff against the fixed point including uncommitted worktree changes (git diff <fixed-point>). You may run fixture tests that create temporary files, but write nothing to the repository. The controller has already run the verification suites; run only the focused tests that confirm or refute a suspected finding. Report in Traditional Chinese.\n`;
const bin = process.env.CODEX_BIN || 'codex';
const login = spawnSync(bin, ['login', 'status'], { encoding: 'utf8', timeout: LOGIN_TIMEOUT_MS });
if (login.error?.code === 'ENOENT') fallback('not-installed', 'CODEX_NOT_INSTALLED', { bin });
if (login.error) fallback('error:login-status', 'CODEX_LOGIN_STATUS_FAILED', { message: login.error.message });
if (login.status !== 0) fallback('not-logged-in', 'CODEX_NOT_LOGGED_IN', { status: login.status });
const exec = model => {
  const logFd = openSync(logPath, 'w');
  const run = spawnSync(bin, args(model), { input: prompt, stdio: ['pipe', logFd, logFd], timeout: TIMEOUT_MS });
  closeSync(logFd);
  return run;
};
let expectedModel = MODEL; let result = exec(expectedModel); let fallbackFrom;
if (!result.error && result.status !== 0 && AT_CAPACITY.test(readFileSync(logPath, 'utf8'))) {
  renameSync(logPath, join(outDir, `codex.${MODEL}.log`)); own.add(resolve(outDir, `codex.${MODEL}.log`));
  fallbackFrom = MODEL; expectedModel = FALLBACK_MODEL; result = exec(expectedModel);
}
// 先於其他判定：即使 Codex 失敗，寫入 repo 也必須回報，避免改動混入交付。
const wrote = changedPaths(before, snapshot(worktree, own));
if (wrote.length) fallback('error:REVIEW_WROTE_REPO', 'REVIEW_WROTE_REPO', { paths: wrote, log: logPath });

if (result.error?.code === 'ETIMEDOUT') fallback('timeout', 'CODEX_TIMEOUT', { timeoutMs: TIMEOUT_MS, log: logPath });
if (result.error?.code === 'ENOENT') fallback('not-installed', 'CODEX_NOT_INSTALLED', { bin });
if (result.error) fallback('error:CODEX_START_FAILED', 'CODEX_START_FAILED', { message: result.error.message, log: logPath });
if (result.status !== 0 && NO_CREDITS.test(readFileSync(logPath, 'utf8'))) fallback('quota', 'CODEX_NO_CREDITS', { status: result.status, log: logPath, hint: NO_CREDITS_HINT, quota: quotaLine(codexQuota()) });
if (result.status !== 0) fallback('error:CODEX_EXIT', 'CODEX_EXIT', { status: result.status, signal: result.signal, log: logPath });
const log = readFileSync(logPath, 'utf8');
const { model, 'reasoning effort': effort } = header(log);
if (model !== expectedModel || effort !== EFFORT) fallback('error:MODEL_MISMATCH', 'MODEL_MISMATCH', { expected: { model: expectedModel, effort: EFFORT }, actual: { model, effort }, log: logPath });
if (SPAWN_FAILED.test(log)) fallback('error:SPAWN_FAILED', 'SPAWN_FAILED', { log: logPath });
if (missing(report)) fallback('error:NO_REPORT', 'NO_REPORT', { log: logPath });
if (specNotReviewed(readFileSync(report, 'utf8'))) fail('SPEC_NOT_REVIEWED', { spec, report, hint: '確認 spec 路徑在 worktree 可讀後重跑' });
announce({ reviewer: 'codex', model, ...(fallbackFrom && { fallbackFrom }) });
process.stdout.write(JSON.stringify({ status: 'OK', reviewer: 'codex', model, ...(fallbackFrom && { fallbackFrom }), effort, report, log: logPath }) + '\n');
