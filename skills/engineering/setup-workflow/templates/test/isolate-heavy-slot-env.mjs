// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 測試行程一載入就把 heavy-slot.mjs 的鎖檔目錄換成這個行程自己的暫存目錄：pilot-land.mjs、land.mjs 的 Regression 指令經 slot 執行，
// 測試裡的假檢查若拿全機真實的 slot（~/.local/state/orca-heavy-check），機器忙時會排在真正的 bin/check 後面直到逾時。
// 同時清掉 HEAVY_SLOT_HELD：在 slot 裡跑的 bin/check 會把它帶給測試，被測腳本就不經 slot，測不到它。
// isolate-git-env.mjs 已 import 本檔。
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './real-tmpdir.mjs';

const dir = mkdtempSync(join(realTmpdir(), 'heavy-slot-test-'));
process.env.HEAVY_CHECK_DIR = dir;
delete process.env.HEAVY_SLOT_HELD;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
