# issue-run 檢查與 review 細則

[issue-run.md](issue-run.md) 的 `## Checks`、`## Review` 指到這裡。各條目用 `node scripts/adapter-line.mjs '<條目名>'` 單獨取。

- **Template copies.** 改正本後先 `cp` 副本、第一次 `bin/check` 才在 `tests/template-copies.test.mjs` 報 sha256 不符，各多跑一輪（#201，兩次 retro）。正本旁的範本測試與 `tests/<名稱>.test.mjs` 是兩份：後者跑的是 `scripts/` 副本，只跑正本旁那份會漏（#454：`tests/pilot-land.test.mjs` 的 sync-main 測試只在完整 `bin/check` 才紅）。改範本時兩份都跑；copy-templates 對有後者的副本多印 `ALSO_TESTED tests/<名稱>.test.mjs`。
- **Pre-commit output.** pre-commit 成功時在 stderr 印一行：跑過 `bin/check` 印它的最後一行 `CHECK_PASS tests …`，這棵樹剛通過而跳過時印 `CHECK_STAMP_FRESH <tree>`；`git commit … > <log> 2>&1` 的 log 裡就有，不必另讀 hook 或 `check-pass` 檔。證據直接引這一行；`CHECK_STAMP_FRESH` 時附先前單獨跑那次的 `CHECK_PASS` 行（#512：四個 worker 各多花兩三次呼叫確認 `bin/check` 有沒有跑）。
- **Result line format.** 改範本腳本結果行的格式（檔頭 stdout 段列的行）之前，先 `grep -rn '<結果行前綴>' skills docs tests scripts` 列出每一處測試斷言與文件，再動手；結果行由另一支腳本轉印時（例如 `pilot-probe.mjs` 的 `workerState` 經 `pilot-land.mjs` 印出），那支的檔頭與 `PILOT-STORE.md` 那一列也在清單裡（#504：`STOP capacity` 改格式漏了兩處斷言、五行文件，多一輪修正與 `bin/check`）。`tests/pilot-store-usage.test.mjs`（`docs-rules`）比對 `PILOT-STORE.md` Canonical scripts 表的用法欄與範本 `USAGE`、結果行欄與範本檔頭 stdout 段（#456）；`pilot-probe`、`pilot-watch`、`pilot-idle-wait`、`pilot-dispatch` 的結果行沒有反引號、不在結果行檢查範圍，改它們的結果行時 Spec reviewer 自己對照那一列。
- **Import check.** 改了範本的 import 或 export 之後，先對每支 import 它的範本跑 `node --check <檔>`（毫秒級，ESM 頂層撞名當場報 `SyntaxError: Identifier '<名>' has already been declared`），再跑單檔測試（#504：`pilot-dispatch.mjs` 自己的 `stopLine` 和新 import 的同名，等幾分鐘的測試才報）。
- **Edit scripts.** 多行的編輯腳本（Python、node）先用 Write 寫進 scratchpad 再執行，不寫成 heredoc：內文含 JS、`$`、反引號時，Claude Code 的內建安全檢查會擋下整條指令，多一輪改寫（#525）。Issue 留言內文同理（[issue-run.md](issue-run.md) Evidence 段，#444）。
- **Case-sensitive names.** review 判斷題：以名稱判斷檔案在不在、而名稱的大小寫有意義時（連結目標、條目名），對 `readdirSync` 的檔名清單比對，不用 `existsSync`／`statSync`：macOS 的 APFS 不分大小寫，`[[Open]]` 會找到 `open.md`，本機 Linux 的 regression 全綠，到 CI 的 `checks-macos` 才紅（#478：`memory-audit.mjs`，多花約 70 分鐘）。
