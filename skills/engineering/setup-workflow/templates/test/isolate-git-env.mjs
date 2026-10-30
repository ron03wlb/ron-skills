// 測試行程一載入就清掉 GIT_* 環境變數：在 git hook 內（linked worktree 會匯出 GIT_DIR）或帶 GIT_DIR 的 shell 執行測試時，
// fixture 與被測腳本的 git 指令才會作用在各自的暫存 repo，而不是真正的 repo。
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
