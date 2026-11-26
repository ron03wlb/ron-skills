// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 測試行程一載入就清掉 GIT_* 環境變數：在 git hook 內（linked worktree 會匯出 GIT_DIR）或帶 GIT_DIR 的 shell 執行測試時，
// fixture 與被測腳本的 git 指令才會作用在各自的暫存 repo，而不是真正的 repo。
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
// 同時 import isolate-orca-env.mjs 清掉 session 繼承的 ORCA_CLI_COMMAND、ORCA_TERMINAL_HANDLE：測試設的假 Orca 失效時改為失敗，不會碰到真的 Orca；要用假 Orca 的測試自己設（#524）。
import "./isolate-orca-env.mjs";
// 也把 heavy-slot.mjs 的鎖檔目錄換成暫存目錄：被測的 pilot-land.mjs、land.mjs 經 slot 跑檢查，不能去排全機真實的 slot。
import "./isolate-heavy-slot-env.mjs";
// 再 import isolate-claude-env.mjs 清掉 Claude session 繼承的 CLAUDE_CODE_SESSION_ID、CLAUDE_PID：被測腳本寫出 session 值時，測試只在 Claude 裡失敗（retro spay2 d5492792#1）；要用的測試自己設。
import "./isolate-claude-env.mjs";
