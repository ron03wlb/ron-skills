// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// 測試行程一載入就清掉 session 繼承的 Orca 環境變數：在 Orca 分頁裡跑測試時，被測腳本以 `...process.env` 繼承到真的 ORCA_CLI_COMMAND，
// 會呼叫真的 Orca（#524：pilot-batch move 對 running 成員 `terminal read term_134`，只因 handle 不存在印 WARN 而照樣通過）；
// ORCA_TERMINAL_HANDLE 留著的話，tab-state 這類腳本在 ORCA_CLI_COMMAND 清掉後改用 PATH 上的 `orca`，改到本 session 的分頁。
// 要用假 Orca 或 handle 的測試自己設。會 spawn 讀這些變數的腳本的測試檔要 import 本檔（check-test-git-isolation.mjs 檢查）。
delete process.env.ORCA_CLI_COMMAND;
delete process.env.ORCA_TERMINAL_HANDLE;
