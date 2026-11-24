#!/usr/bin/env node
// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// copy-templates: requires pilot-probe.mjs
// setup-workflow 正本（#377，改寫自 spay2 的 scripts/pilot-idle-wait.mjs，spay2 #868）：/issue-pilot coordinator 連續閒置時的背景等待。
// spay2 實測 27 次閒置喚醒每次重載 `/loop` 全文，輸入 token 從 55603 漲到 152429；閒置時改以 run_in_background 跑本程序，
// 有變化才結束、喚醒 coordinator，不再排 ScheduleWakeup（issue-pilot SKILL 的 Report and sleep）。
// 每 interval 秒讀一次：同目錄 pilot-probe.mjs 的輸出（不帶 --apply、--status，只讀）、`<主 checkout>/.scratch/pilot/gates.md` 的內容、
// 整合分支的 HEAD。第一輪是基準，之後任一項變了就印這一輪的全部變化並結束：
//   probe 只算基準沒有的行（少了行不算：gate 被回答、請求處理完會反映在 gates.md 或下一個新行）；gate 檔比整份內容（人回答 gate 不一定改 probe 輸出）。
//
// 用法：node scripts/pilot-idle-wait.mjs <主 checkout> [--integration <分支>] [--main <分支>] [--interval <秒>] [--max-wait <秒>]
//   --integration、--main 原樣交給 probe，--integration 也是要讀 HEAD 的分支（預設 pilot/integration）；
//   --interval 輪詢間隔秒數（預設 300，可帶小數）；--max-wait 上限秒數（預設 3600，即原本閒置時的 ScheduleWakeup 間隔）。
// stdout：WAKE probe <新行>（依 probe 輸出順序）｜WAKE gates .scratch/pilot/gates.md｜WAKE integration <舊 SHA 前 7 碼|none> <新 SHA 前 7 碼|none>
//         ｜IDLE_TIMEOUT <max-wait 秒數>（到上限仍沒有變化；逾時前至少比對過基準一次，probe 慢過 max-wait 時多跑到比對完才印）｜ERROR probe exit <code> rounds <n> <stderr 第一行>（probe 連續 3 輪失敗）
//   probe 失敗未滿 3 輪：stderr 印 WARN probe exit <code> <stderr 第一行>，該輪不比對。
// exit：0 印出 WAKE 或 IDLE_TIMEOUT（兩者都喚醒 coordinator）；1 ERROR；2 用法錯誤。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/pilot-idle-wait.mjs <主 checkout> [--integration <分支>] [--main <分支>] [--interval <秒>] [--max-wait <秒>]';
const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'pilot-probe.mjs');
const GATES = '.scratch/pilot/gates.md';
const FAIL_LIMIT = 3;

const firstLine = text => String(text ?? '').trim().split('\n')[0] ?? '';

/** 命令列 → { checkout, integration, mainBranch, intervalMs, maxWaitMs }；用法錯誤時 { error }。 */
export function parseArgs(argv) {
  const options = { integration: 'pilot/integration', intervalMs: 300_000, maxWaitMs: 3_600_000 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--integration', '--main', '--interval', '--max-wait'].includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} 要有值` };
      if (arg === '--integration') options.integration = value;
      else if (arg === '--main') options.mainBranch = value;
      else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) return { error: `${arg} 要是正數：${value}` };
        options[arg === '--interval' ? 'intervalMs' : 'maxWaitMs'] = seconds * 1000;
      }
    } else if (arg.startsWith('--')) return { error: `不認得的選項 ${arg}` };
    else positional.push(arg);
  }
  if (positional.length !== 1) return { error: '要剛好一個主 checkout' };
  return { ...options, checkout: positional[0] };
}

/** 讀一輪快照：{ probe: string[], gates, integration } 或 { error: { code, detail } }（probe 失敗）。 */
function snapshot({ checkout, integration, mainBranch }) {
  const args = [PROBE, checkout, '--integration', integration, ...(mainBranch ? ['--main', mainBranch] : [])];
  const probe = spawnSync(process.execPath, args, { cwd: checkout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (probe.status !== 0) return { error: { code: probe.status ?? probe.signal, detail: firstLine(probe.stderr) } };
  let gates = '';
  try { gates = readFileSync(join(checkout, GATES), 'utf8'); } catch { /* 沒有 gate 檔：當成空的 */ }
  const head = spawnSync('git', ['-C', checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${integration}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { probe: probe.stdout.split('\n').filter(line => line.trim()), gates, integration: head.status === 0 ? head.stdout.trim() : '' };
}

/** 基準與本輪快照比較，傳回要印的 WAKE 行（空陣列＝仍閒置）。 */
export function wakeLines(base, now) {
  const seen = new Set(base.probe);
  const out = now.probe.filter(line => !seen.has(line)).map(line => `WAKE probe ${line}`);
  if (base.gates !== now.gates) out.push(`WAKE gates ${GATES}`);
  if (base.integration !== now.integration) out.push(`WAKE integration ${base.integration.slice(0, 7) || 'none'} ${now.integration.slice(0, 7) || 'none'}`);
  return out;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stderr.write(`${options.error}\n${USAGE}\n`);
    return 2;
  }
  const deadline = Date.now() + options.maxWaitMs;
  let base;
  let failures = 0;
  let compared = 0;
  for (let round = 0; ; round++) {
    if (round) {
      const left = deadline - Date.now();
      // 逾時前至少完成一次比對：高負載下 probe 子程序慢過 max-wait 時，只有基準沒有比對，IDLE_TIMEOUT 就不是「沒有變化」的證據（#566）。
      if (left <= 0 && compared) break;
      await sleep(Math.max(0, Math.min(options.intervalMs, left)));
    }
    const now = snapshot(options);
    if (now.error) {
      const { code, detail } = now.error;
      if (++failures >= FAIL_LIMIT) {
        process.stdout.write(`${`ERROR probe exit ${code} rounds ${failures} ${detail}`.trimEnd()}\n`);
        return 1;
      }
      process.stderr.write(`${`WARN probe exit ${code} ${detail}`.trimEnd()}\n`);
      continue;
    }
    failures = 0;
    if (!base) { base = now; continue; }
    compared++;
    const wake = wakeLines(base, now);
    if (wake.length) {
      process.stdout.write(wake.map(line => `${line}\n`).join(''));
      return 0;
    }
  }
  process.stdout.write(`IDLE_TIMEOUT ${options.maxWaitMs / 1000}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
