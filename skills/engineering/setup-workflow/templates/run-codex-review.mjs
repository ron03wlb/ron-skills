#!/usr/bin/env node
// issue-run adapter 的 Review：以固定模型／effort 執行 Codex code-review，並以確定性規則判定結果。
// 用法：node scripts/run-codex-review.mjs <baseline> <spec> <worktree> <out-dir> [rulings]
// rulings：已裁決項目（接受為已知限制或不修，各附理由）；重新審查時帶入，避免重提已裁決的 finding。
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
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MODEL = 'gpt-6-astra';
const FALLBACK_MODEL = 'gpt-6.1-sol';
const AT_CAPACITY = /^ERROR: Selected model is at capacity/m;
const EFFORT = 'high';
// 只認帶時間戳的 log 行；review diff 或 Codex 讀取的檔案引用這句時不會以時間戳開頭。
const SPAWN_FAILED = /^[0-9TZ:.-]+ ERROR codex_core::tools::router: error=collab spawn failed/m;

function fail(error, detail = {}) {
  process.stderr.write(JSON.stringify({ error, ...detail }) + '\n');
  process.exit(1);
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

const [baseline, spec, worktree, outDir, rulings] = process.argv.slice(2);
if (!baseline || !spec || !worktree || !outDir) fail('USAGE', { usage: 'run-codex-review.mjs <baseline> <spec> <worktree> <out-dir> [rulings]' });
if (rulings && (!existsSync(rulings) || statSync(rulings).size === 0)) fail('RULINGS_MISSING', { rulings });
mkdirSync(outDir, { recursive: true });
const report = join(outDir, 'review.md'); const logPath = join(outDir, 'codex.log');
const own = new Set([resolve(report), resolve(logPath)]);
rmSync(report, { force: true });

// 不加 --ephemeral：reviewer 以 fork_turns 載入父 rollout，ephemeral session 沒有 rollout。
const args = model => ['exec', '-s', 'workspace-write', '--ignore-user-config', '-m', model, '-c', `model_reasoning_effort=${EFFORT}`,
  '-c', 'sandbox_workspace_write.network_access=true', '-C', worktree, '-o', report, '-'];
const before = snapshot(worktree, own);
const resolved = spawnSync('git', ['-C', worktree, 'rev-parse', '--verify', '--quiet', `${baseline}^{commit}`], { encoding: 'utf8' });
if (resolved.status !== 0) fail('BASELINE_INVALID', { baseline, worktree });
const fixedPoint = resolved.stdout.trim();
const expected = expectedBaseline(outDir, worktree);
if (expected && expected !== fixedPoint) fail('BASELINE_STALE', { baseline: fixedPoint, mergeBase: expected, hint: '先把 state.md 的 baseline: 更新為 HEAD 與整合分支的 merge-base，再以它重跑' });
const ruled = rulings ? ` Rulings: ${rulings}. These findings were already arbitrated; re-raise a ruled finding only when this diff changes the premise of its ruling, and say which change.` : '';
const prompt = `Use the code-review skill. Fixed point: ${fixedPoint}. Spec: ${spec}.${ruled} Diff against the fixed point including uncommitted worktree changes (git diff <fixed-point>). You may run fixture tests that create temporary files, but write nothing to the repository. The controller has already run the verification suites; run only the focused tests that confirm or refute a suspected finding. Report in Traditional Chinese.\n`;
const exec = model => {
  const logFd = openSync(logPath, 'w');
  const run = spawnSync(process.env.CODEX_BIN || 'codex', args(model), { input: prompt, stdio: ['pipe', logFd, logFd] });
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
if (wrote.length) fail('REVIEW_WROTE_REPO', { paths: wrote, log: logPath });

if (result.error) fail('CODEX_START_FAILED', { message: result.error.message, log: logPath });
if (result.status !== 0) fail('CODEX_EXIT', { status: result.status, signal: result.signal, log: logPath });
const log = readFileSync(logPath, 'utf8');
const { model, 'reasoning effort': effort } = header(log);
if (model !== expectedModel || effort !== EFFORT) fail('MODEL_MISMATCH', { expected: { model: expectedModel, effort: EFFORT }, actual: { model, effort }, log: logPath });
if (SPAWN_FAILED.test(log)) fail('SPAWN_FAILED', { log: logPath });
if (!existsSync(report) || statSync(report).size === 0) fail('NO_REPORT', { log: logPath });
process.stdout.write(JSON.stringify({ status: 'OK', model, ...(fallbackFrom && { fallbackFrom }), effort, report, log: logPath }) + '\n');
