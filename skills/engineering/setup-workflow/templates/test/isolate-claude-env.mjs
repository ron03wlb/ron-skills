// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 測試行程一載入就清掉 Claude Code session 繼承的識別變數：在 Claude 裡跑測試時，被測腳本以 `...process.env` 繼承到真的 session 值，
// 把它寫進輸出或檔案，精確比對的測試只在 Claude 裡失敗、CI 上通過（retro spay2 d5492792#1：spay2 #1186 讓 merge-into-integration.sh
// 在合入訊息加 `Coordinator-Session: $CLAUDE_CODE_SESSION_ID`，queue-regression.test.mjs、close-issue.test.mjs 因此只在 Claude 內失敗）。
// 只清會被當成 session 識別寫出的兩個：CLAUDE_CODE_SESSION_ID（pilot-hold、pilot-gate、issue-pool claim、pilot-register 等寫進檔案與輸出）、
// CLAUDE_PID（pilot-register 寫進 coordinator 檔；spay2 的 pilot-idle-wait.mjs 也是清這兩個）。CLAUDE_CONFIG_DIR 這類設定不是 session 值，不動。
// 要用這些變數的測試自己設（在 spawn 的 env 帶上）。isolate-git-env.mjs 會 import 本檔，import 它（或 repo-fixture.mjs）的測試都已涵蓋。
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_PID;
