# 06 品質校驗時間軸

從改第一行到結案，每一道維持品質的校驗都列在這裡：它什麼時候跑、檢查什麼、**不能證明什麼**。最後一欄比前面幾欄重要：知道一道校驗證明不了什麼，才知道後面還需要哪一道。

具體指令以各 repo 的 adapter 與單一檢查入口為準；本章的例子取自 ron-skills，L3 實例的例子只當參考。

## 強度分級

| 強度 | 意思 | 例子 |
| --- | --- | --- |
| **本地強制** | git hook 或 Claude Code hook 擋下；agent 繞不過，人在自己的終端也要刻意繞 | pre-commit、pre-push、`PreToolUse` hook、`.claude/settings.json` 的 deny |
| **流程內** | skill 或入口腳本在固定步驟呼叫，失敗就停；但沒有 hook 強制，另開終端手動操作可以跳過 | `/issue-run` 的 focused 測試、review、acceptance |
| **遠端** | CI 或 tracker 端跑；擋得住合併，但要 push 之後才看得到結果 | GitHub Actions、GitLab pipeline、branch protection |

同一個檢查可以同時出現在好幾個強度：ron-skills 的 `bin/check` 在 `/issue-run` 裡是流程內、在 pre-commit 是本地強制、在 CI 是遠端。檢查本身只寫在單一入口裡，強度由誰呼叫它決定。

## 1. 編輯時

| 校驗 | 強度 | 檢查什麼 | 不能證明什麼 |
| --- | --- | --- | --- |
| `.claude/settings.json` 的 allow／deny | 本地強制 | agent 的每次工具呼叫是否在放行範圍內；deny 的指令（例如直接開 MR、連資料庫）一律拒絕 | 人在自己的終端做同樣的事不受限；包在放行腳本裡的動作也看不到 |
| `PreToolUse` hook：擋繞過 git hook | 本地強制 | Bash 指令含 `--no-verify`、`git commit -n`、`-c core.hooksPath=` 即拒絕 | 只比對字串；寫進腳本檔再執行的繞過抓不到 |
| `PreToolUse` hook：擋改主 checkout | 本地強制 | Edit／Write，以及 Bash 的 `sed -i`、`perl -i`、`>`／`>>` 重導向與 `tee`，會讓本專案主 checkout 的 `git status` 不乾淨就拒絕（追蹤檔，以及沒被 gitignore 的新檔；別的 repo 不管），要求改在 worktree；L3 必接，因為 pilot 的 Probe 看到主 checkout 有改動就停止合併 | Bash 是啟發式辨識：子 shell、`eval`、腳本檔裡的寫入擋不到；解析不了的指令一律放行；目標裡的 `$變數` 先用同一條指令的賦值或環境變數代換，代換不了的（含 `$(…)`、`$$`、`${X:-y}`）不算目標；`cd`／`git -C` 到代換不了的目錄時照原本的目錄判斷 |

L1 通常一個 hook 都沒有；L2 開始多 session 並行時再加。

## 2. commit 時

| 校驗 | 強度 | 檢查什麼 | 不能證明什麼 |
| --- | --- | --- | --- |
| pre-commit 跑單一檢查入口 | 本地強制 | 工作樹目前的內容通過所有檢查（ron-skills：`.githooks/pre-commit` 跑 `bin/check`） | 檢查的是工作樹，不是 commit 本身；`git add -p` 留在工作樹的改動也一起被檢查到 |

沒有 pre-commit 的 repo，錯誤會留到 push 或 CI 才被抓到。

## 3. 實作中

| 校驗 | 強度 | 檢查什麼 | 不能證明什麼 |
| --- | --- | --- | --- |
| 紅燈測試（`tdd`） | 流程內 | 第一個產品改動之前，先有一個會失敗的測試，失敗的指令與 exit code 記進 checkpoint | 測試斷言的是對的行為；只證明「改之前它會紅」 |
| 行為不變的重構先綠 | 流程內 | 重構前 baseline 套件（ron-skills：`bin/check` 在 base 上）是綠的 | baseline 沒涵蓋的行為；需要時補 characterization test |
| focused 測試 | 流程內 | 本單動到的測試檔（ron-skills：`node --test tests/<name>.test.mjs`） | 其他模組、沒跑到的測試 |

## 4. candidate 前

| 校驗 | 強度 | 檢查什麼 | 不能證明什麼 |
| --- | --- | --- | --- |
| 單一檢查入口 | 流程內 | 整個 repo 的檢查在 run 的分支上全過 | 只在跑的那個 SHA 有效；之後合入別的東西要重跑 |
| `code-review` 兩軸 | 流程內 | **Standards**：是否符合 repo 的規範；**Spec**：是否做了 Issue 要的事。兩軸分開列，最多兩輪修正與重審 | finding 只有在有失敗的執行、失敗的 gate、或這次改動讓文件某行變錯時才擋；「看起來怪」不擋，記成 follow-up |
| 安全事實 | 流程內 | 動到 wire format、共用契約、會解析原始碼的工具時，review 要點名這個改動「因為哪一兩個事實而安全」，並各附一次證明它的執行 | 呼叫端搜尋只證明「找到的呼叫端」沒壞 |
| 獨立情境驗證（L3） | 流程內 | 高風險 Issue 由沒寫程式的全新 verifier 在 candidate SHA 跑至少一個情境（見 [05](05-level3.md#codex-跨模型-review)） | candidate 自己加的測試不算獨立；只證明被跑的那幾個情境 |

只改文件或註解、不改行為的 diff 略過 review 指令，文件檢查照跑。adapter 釘 hash 的檔案（ron-skills：所有 `SKILL.md`、`ADAPTER.md`、`overlays/*.patch`）永遠不算只改文字，因為它們會改變 agent 的行為。

## 5. 合入整合分支

| 校驗 | 強度 | 檢查什麼 | 不能證明什麼 |
| --- | --- | --- | --- |
| acceptance | 流程內 | 在 candidate 的完整 SHA、工作樹乾淨時跑 adapter 的 acceptance（ron-skills：`bin/check --upstream`，對上游最新版重跑 overlay 檢查） | 只對那個 SHA 有效 |
| 批次回歸（L3） | 流程內 | 整批合進批次分支後，在 staged SHA 跑一次回歸，過了才合入整合分支 | 整合分支在 stage 之後又有新 commit 時就失效，要重新 stage、重跑 |
| 合入入口（L2） | 流程內 | lock、合入前後各跑一次檢查（見 [04](04-level2.md#整合分支與-lock)） | 沒有 `reference-transaction` hook 時擋不住繞過入口的 `git merge` |

## 6. push 時

| 校驗 | 強度 | 檢查什麼 | 不能證明什麼 |
| --- | --- | --- | --- |
| pre-push hook | 本地強制 | 在要 push 的 SHA 上重跑單一檢查入口（範本見 [04](04-level2.md#pre-push)） | `--no-verify` 跳得過，要靠 `PreToolUse` hook 補 |
| CI | 遠端 | 乾淨環境、乾淨 clone 上重跑；ron-skills 每次 push 與每週一跑 `bin/check --upstream`，上游改到 overlay 補丁位置時先在這裡變紅 | 只有 push 之後才知道；沒設 branch protection 時紅了也合得進去 |

## 7. 結案時

| 校驗 | 強度 | 檢查什麼 | 不能證明什麼 |
| --- | --- | --- | --- |
| 可結案檢查（L2 兩段式結案） | 流程內 | candidate SHA 已在遠端主線或整合分支 | 合進主線之後的部署與實際運作 |
| 文件同步守門 | 流程內 | 規範（skill、adapter 範本）改了，導讀也有人對照過（ron-skills：`check-workflow-sync.mjs`） | 對照的品質；restamp 只代表有人看過 |

## L3 實例的 `check-*`

L3 實例在 push 前跑一組專案專屬的 `check-*`：例如 DDL 不承載業務規則、每個資料表欄位都有寫入者、各環境設定檔的 secret 欄位在 repo 中留白、每個測試檔都接進檢查入口。它們都是同一個模式的例子：**一個真實發生過的失誤 → 一個在那次失誤上會失敗的檢查 → 接進單一檢查入口。** 你的 repo 需要的是你自己的那一組，不是這一組（見 [07 規則沉澱](07-rules.md)）。

## 整體邊界

- 每一道校驗只證明它跑的那個 SHA；合入、rebase、re-stage 之後都要重跑。
- 本地強制擋得住 agent，擋不住刻意繞過的人；遠端擋得住合併，但回饋最慢。
- 沒有任何一道校驗證明「需求本身是對的」：那是 `/triage` 與 Spec 軸 review 的工作，最後由人決定。
