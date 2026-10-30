#!/usr/bin/env node
// 以 Orca 建立 worktree 的唯一入口：`orca worktree create` 只呼叫一次，再以 git worktree list 確認新出現的 worktree。
// Orca 從 WSL 建立時常先回 runtime_unavailable，卻仍在背景完成 checkout；重試會多出 `<name>-2`，所以一律不重試、改為輪詢。
//
// 用法：node scripts/orca-worktree-create.mjs <orca worktree create 的參數…>（須含 --name；--json 由本腳本補上）
// stdout 一行 JSON：{"status":"CREATED"|"CREATED_LATE","path","branch"}；失敗為 {"status":"NOT_FOUND"|"FAILED","error"}。
// exit code：0 已建立、1 失敗、2 參數錯誤或沒有 Orca CLI。
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

const ORCA = process.env.ORCA_BIN || process.env.ORCA_CLI_COMMAND || '';
const POLL_SECONDS = Number(process.env.ORCA_POLL_SECONDS || 180);
const USAGE = '用法：node scripts/orca-worktree-create.mjs --name <name> [orca worktree create 其他參數]（需設定 ORCA_CLI_COMMAND）';

const print = (value, code) => { console.log(JSON.stringify(value)); process.exit(code); };

function worktrees() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (result.status !== 0) print({ status: 'FAILED', error: `git worktree list：${result.stderr.trim()}` }, 1);
  return result.stdout.split(/\n\n+/).filter(Boolean).map(block => ({
    path: block.match(/^worktree (.*)$/m)?.[1],
    branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] ?? null,
  }));
}

/** 建立前沒有、目錄名是 <name> 或 Orca 去重後的 <name>-<n> 的 worktree；Orca 會把名稱的 / 換成 - 當目錄名。 */
function created(name, before) {
  const dir = name.replaceAll('/', '-');
  const pattern = new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`);
  return worktrees().find(w => !before.has(w.path) && pattern.test(basename(w.path)));
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const args = process.argv.slice(2).filter(arg => arg !== '--json');
const name = args[args.indexOf('--name') + 1];
if (!ORCA || !args.includes('--name') || !name) { console.error(USAGE); process.exit(2); }
// Orca 記的 repo 路徑是 Windows UNC 形式，--repo path:<WSL 路徑> 回 repo_not_found；id: 又可能對到同名的另一個 repo。省略時 Orca 從 cwd 推斷。
if (args.includes('--repo')) { console.error(`不要帶 --repo：Orca 從目前目錄推斷 repo（path: 會 repo_not_found）。${USAGE}`); process.exit(2); }

const before = new Set(worktrees().map(w => w.path));
const result = spawnSync(ORCA, ['worktree', 'create', ...args, '--json'], { encoding: 'utf8' });
let out = null;
try { out = JSON.parse(result.stdout); } catch { /* 非 JSON 輸出視為失敗 */ }
const code = out?.error?.code ?? null;
if (!out?.ok && code !== 'runtime_unavailable') {
  print({ status: 'FAILED', error: `orca worktree create：${code ?? (result.stderr || result.stdout || '').trim()}` }, 1);
}
const deadline = Date.now() + POLL_SECONDS * 1000;
for (;;) {
  const found = created(name, before);
  if (found) print({ status: out?.ok ? 'CREATED' : 'CREATED_LATE', path: found.path, branch: found.branch }, 0);
  if (Date.now() >= deadline) break;
  sleep(2000);
}
print({ status: 'NOT_FOUND', error: `orca 回 ${code ?? 'ok'}，${POLL_SECONDS} 秒內 git worktree list 未出現 ${name}；Orca 可能仍在背景建立，不得重試，先查 Orca 再決定` }, 1);
