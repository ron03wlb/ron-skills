// 測試行程一載入就清掉 GIT_* 環境變數：在 git hook 內（linked worktree 會匯出 GIT_DIR）或帶 GIT_DIR 的 shell 執行測試時，
// fixture 與被測腳本的 git 指令才會作用在各自的暫存 repo，而不是真正的 repo。
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
// 同時清掉 session 繼承的 ORCA_CLI_COMMAND：測試設的假 Orca 失效時改為失敗，不會碰到真的 Orca；要用假 Orca 的測試自己設。
delete process.env.ORCA_CLI_COMMAND;
