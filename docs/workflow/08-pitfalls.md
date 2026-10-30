# 08 常見坑

換了專案也會再踩的坑。專案自己的坑（特定資料庫、特定 CI、特定測試環境）寫在專案的文件裡，不放這裡。

## 工具與環境

| 症狀 | 原因 | 做法 |
| --- | --- | --- |
| agent 讀 Issue 拿到空白 | `gh issue view <n> --comments` 在非 tty 環境（agent 的 Bash 工具）不輸出任何東西 | 一律 `gh issue view <n> --json number,title,body,labels,comments`；寫進 `docs/agents/issue-tracker.md` |
| `which orca` 有東西，Orca 指令卻都失敗 | Linux 上的 `orca` 是 GNOME 螢幕閱讀器 | Orca 可用與否只看 `ORCA_CLI_COMMAND` 是否設定 |
| Orca `worktree create` 回 `runtime_unavailable`，重試後多出一個 `<name>-2` | 從 WSL 呼叫時，回應早於實際完成 | 只呼叫一次，用 `git worktree list` 輪詢確認；絕不重試 |
| `git stash pop` 套上了別的 session 的改動 | stash 清單是所有 worktree 共用的 | worktree 之間不用 stash 搬東西；要暫存就用 WIP commit，非用 stash 不可時加唯一訊息、記下 SHA、以 `git stash apply <sha>` 還原 |
| 本機全綠，CI 一跑就紅 | 本機的上游 checkout（fork）落後上游 | acceptance 對上游最新版跑一次（ron-skills：`bin/check --upstream`） |
| 背景工作看起來像 timeout | 背景行程繼承了忽略 SIGINT 的設定 | 先在前景與背景各單獨重跑一次，再判斷是不是負載 |
| WSL 裡 headless Chromium 截圖的中文變方框 | WSL 預設沒有中文字型 | 把 Noto Sans TC 放進 `~/.local/share/fonts/`、在 fontconfig 加 fallback、`fc-cache -f` |
| 貼到終端的 SQL 或多行設定執行結果不對 | 換行被轉成 CRLF，或被終端折行 | 以檔案交付，請人用檔案執行，不要貼上 |

## 權限與規則

| 症狀 | 原因 | 做法 |
| --- | --- | --- |
| 每次啟動 Claude Code 都警告 `allows any option at its *` | allow 規則的 `*` 在中間（`git -C * fetch`），能夾帶 git 選項 | `*` 只放最後；git 寫入包進腳本或 `pilot_git.py`（見 [04 權限規則](04-level2.md#權限規則)） |
| agent 說它需要一條新的 allow 規則 | `.claude/settings.json` 只有人能改 | 人審過再加；不要讓 agent 自己編輯 settings |
| 規則寫在 memory 或 skill 裡，agent 還是一再違反 | 文字規則沒有強制力 | 做成檢查或入口（見 [07 規則沉澱](07-rules.md)） |
| `/loop /<skill>` 叫不起來 | skill 設了 `disable-model-invocation`，Skill tool 呼叫不了 | 被 `/loop` 驅動的 skill 不設這個旗標 |
| 改了一行註解，測試就紅 | 那個檔被其他檔以 hash 釘住 | 改既有檔前先查是否被釘住；adapter 的 Review 段列出釘住的檔 |

## 流程

| 症狀 | 原因 | 做法 |
| --- | --- | --- |
| 開了一堆空的 worktree，看板與 worktree 對不上 | 開單就建 worktree，或兩套看板各自記狀態 | 認領時才建；只用 tracker 的 label 當看板 |
| Issue 關了，改動卻還不在主線 | 合併與結案之間隔著 push，人忘了 | 兩段式結案：第二次先查 SHA 已在遠端才關單（見 [04](04-level2.md#兩段式結案)） |
| 換人或換標題後，又試了一次早就證明不行的做法 | 撤回的方案只留在舊對話或留言裡 | 被重開、回歸或長尾的 Issue，開工前先彙整已撤回的方案寫進 checkpoint |
| 兩個 session 同時合入，結果對不上 | 整合分支與回歸是共用資源 | 合入只有一個入口且有 lock（見 [04](04-level2.md#整合分支與-lock)） |
| 回歸通過了，合入後卻是紅的 | 回歸跑在 stage 時的 SHA，之後整合分支又有新 commit | 回歸只對那個 SHA 有效；整合分支有新 commit 就重新 stage、重跑 |
| worker 印了 `DONE` 之後又醒來，回報「沒事可做」 | 它自己排的 `/loop` 喚醒或背景工作還在 | worker 印完最後一行就停掉自己的 loop 與背景工作 |
| 長時間跑同一個 coordinator，判斷越來越差 | context 一直 compaction | coordinator 刻意短命：合入幾批或遇到 compaction 就交棒 |
