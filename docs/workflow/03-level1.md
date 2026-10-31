# 03 L1 導入

L1 的目標：在一個還沒有 adapter 的 repo 裡，把第一張 Issue 用 `/issue-run` 跑到本機 candidate commit。照下面的 checklist 由上往下做，每一步都有「做完的樣子」，對不上就停在那一步。

實例：ron-skills 的 adapter [`docs/agents/issue-run.md`](../agents/issue-run.md) 只看 Tracker、Readiness、Checks、Candidate and acceptance、Evidence and closing 五段，就是一份 L1 adapter；其餘段落屬於 L3。唯一檢查入口是 `bin/check`。

## Checklist

第 1～3 步是 `/setup-workflow` 開頭的三站：環境 → Host → 等級。每一站都只讀不寫，先列出證據、問這一站的問題，然後停下來等你確認，確認了才進下一站；三站都確認之後它才列出要寫的檔案（第 4 步），你再確認一次才寫入。哪一站停在「不寫檔、只給修正指令」，修好之後重跑 `/setup-workflow`，從第一站重新開始。

### 1. 環境站

先在這台機器裝 skills（每台機器一次）：

```bash
git clone https://github.com/ron03wlb/ron-skills ~/code/ron-skills   # private：先取得讀取權限
git clone https://github.com/ron03wlb/skills ~/code/skills           # Matt skills 的 fork
git clone https://github.com/backnotprop/pstack ~/code/pstack
~/code/ron-skills/bin/sync-skills --check   # overlay 能套用、沒有 OVERLAY_FAILED
~/code/ron-skills/bin/sync-skills           # 連結到 ~/.claude/skills/
```

新開的 Claude Code session 打 `/` 要看得到 `issue-run`、`triage`、`setup-workflow`、`setup-matt-pocock-skills`。Matt 或 pstack 放在別的路徑時，用 `MATT_SKILLS`、`PSTACK_SKILLS` 環境變數指定。

然後在目標 repo 開 Claude Code，輸入 `/setup-workflow`。環境站列出這台機器的平台（macOS、WSL2、Linux，見[支援平台](01-tooling.md#支援平台)）、必要工具（符合 repo CI 鎖定版本的 Node、git 2.31 以上；要複製 `.py` 正本時還有 `python3`）與選用工具（Orca、Codex），再問團隊還有誰用哪些平台，確認的清單之後寫進 adapter 的 `## Platforms`。

- 必要工具缺漏或版本不符：停下、不寫檔，只給修正指令；setup 不安裝、也不切換 runtime。
- 原生 Windows：停下，提示改用 WSL2。
- 選用工具缺漏：只記錄，不停；但它解鎖的東西不能選（沒有 Orca 不能選 L3，沒有 Codex 不能選 `codex` 擴充）。要用的話先裝好再重跑這一站。

做完的樣子：環境站印出 `ENV ok`，你確認了證據和團隊的平台清單。

### 2. Host 站

Host 站分別判斷 tracker host（看 `docs/agents/issue-tracker.md`）與程式碼 host（看 `origin`），各是 GitHub、GitLab 或 `local`，並檢查對應的 `gh`／`glab` 已安裝、已登入。指令對照見 [HOSTS.md](../../skills/engineering/setup-workflow/HOSTS.md)。

- 兩個 host 不同（例如 tracker 在 GitHub、程式碼在 GitLab）：它會兩個都列出來讓你確認，adapter 的 Tracker 段與 Delivery 段各用各的 CLI。
- 任一個是 `local`（沒有 remote，或 tracker 是本機 Markdown）：程式碼 host 是 `local` 時沒有 Delivery 段，也就沒有 PR／MR 與遠端 CI。之後還會加 remote 的話，先加好再重跑這一站。
- 自架 GitLab（http、IP）算 GitLab；GitHub、GitLab 以外的主機不支援。
- 缺 `gh`／`glab` 或沒登入：和環境站一樣停下、不寫檔，只給修正指令。

做完的樣子：Host 站印出 `HOST ok`，你確認了 tracker host 與程式碼 host。

### 3. 等級站

等級站需要一條單一檢查入口：一條指令跑完這個 repo 所有該跑的檢查（lint、型別、測試、文件守門），全過才 exit 0。pre-commit、CI 和 adapter 都只呼叫它，檢查清單只寫在這一個地方。等級站會找 `bin/check`、`npm run check`、`make check`，或 adapter 已寫的 Checks；找不到就停下、不寫任何檔、也不問是非題，先做好它再重跑（回答「願意做」也一樣要先做好）。

- 已經有的就沿用：`npm test`、`make check`、`./gradlew check`、`pytest`。
- 沒有的就建一個 `bin/check`，把現有的指令依序串起來，開頭 `set -euo pipefail`。在乾淨的 `main` 上跑它是 exit 0；故意弄壞一個測試再跑是非 0。這兩個 exit code 記下來，第 6 步要用。

有了檢查入口，等級站偵測現況（目前的等級與每個訊號的證據），列出量測證據（近 90 天貢獻者數、同時存在的 Issue 分支與 worktree、開放 Issue 數、有沒有 CI、有沒有 gated 工作，不設門檻數字），再問下一級進入條件的是非題（題目對應 [README 等級表](README.md#導入等級)的進入條件）。都符合才建議升一級，否則建議維持目前等級，維持也是合理的建議。

- 一次最多升一級。要跳級得你明說，它會列出跳過的每一級與目標等級還沒滿足的訊號與條件，你看過再確認。
- 環境站標為不可選的等級（沒有 Orca 的 L3）不會是建議目標。

做完的樣子：你確認了目標等級。

### 4. 設定 tracker 與 label（每個 repo 一次）

三站都確認之後，`/setup-workflow` 確認這個 repo 的擴充（卡關單、外部測試環境等），然後在一則訊息裡列出要寫或要改的每個檔案（tracker、label、domain docs、adapter 各段、`scripts/` 的正本副本、`.claude/settings.json` 的 hook、遠端 CI 檔），你確認後才寫入。tracker、triage label、domain docs 三段會在同一個流程裡照 `setup-matt-pocock-skills` 的步驟問完，不必另外執行。第 5 步的 adapter 也在同一次流程裡完成。

手動備用：不用 `/setup-workflow` 時，輸入 `/setup-matt-pocock-skills`，依序回答 tracker、triage label、domain docs 三段。兩種做法都會寫出：

- `docs/agents/issue-tracker.md`：讀單、開單、留言、改 label、依賴關係的指令
- `docs/agents/triage-labels.md`：五個角色對應的 label 字串
- `docs/agents/domain.md`，以及 `CLAUDE.md`（或 `AGENTS.md`）的 `## Agent skills` 段

手動時再在 tracker 上建出 label（`/setup-workflow` 會自己建；已存在的會報錯，略過即可）：

```bash
# GitHub
for l in needs-triage needs-info ready-for-agent ready-for-human wontfix; do gh label create "$l"; done
# GitLab
for l in needs-triage needs-info ready-for-agent ready-for-human wontfix; do glab label create --name "$l"; done
```

做完的樣子：`gh label list`（或 `glab label list`）列得出五個 label；`docs/agents/issue-tracker.md` 的讀單指令在 agent 的 Bash 工具裡跑得出內容（GitHub 用 `--json`，見 [02](02-lifecycle.md#tracker-指令對照)）。

### 5. adapter

用 `/setup-workflow` 時，它在第 4 步的同一次流程裡以 [`ADAPTER.md`](../../skills/engineering/issue-run/ADAPTER.md) 為骨架寫出 `docs/agents/issue-run.md`，填入第 1 步確認的平台（`## Platforms`）、第 2 步確認的 host（Tracker 段；程式碼 host 不是 `local` 時還有 Delivery 段）與第 3 步的檢查入口，並把該等級用得到的 script 正本複製到 `scripts/`、記錄在 `docs/agents/workflow-templates.json`。寫完照下面的「做完的樣子」核對。

手動備用：把 [`ADAPTER.md`](../../skills/engineering/issue-run/ADAPTER.md) 複製成目標 repo 的 `docs/agents/issue-run.md`，每段填這個 repo 真的有的指令；沒寫的段落採範本裡的 Default。L1 至少填下面五段。adapter 是給 agent 讀的，用英文寫：

```markdown
# issue-run adapter: <repo>

Sections not written here take the defaults in ADAPTER.md.

## Tracker

docs/agents/issue-tracker.md. Read Issues with `gh issue view <n> --json number,title,body,labels,comments`.

## Readiness

Ready state: the `ready-for-agent` label (docs/agents/triage-labels.md). No preflight. Refine with `/triage <n>`.

## Checks

One command: `bin/check`. Cite only this command while building and in acceptance criteria.

## Candidate and acceptance

The candidate is the branch tip. Acceptance is `bin/check` at the candidate SHA on a clean worktree.

## Evidence and closing

Post evidence as an Issue comment (candidate SHA, commands with exit codes, findings). The human pushes and merges the PR; close the Issue only after the candidate is on `origin/main`.
```

做完的樣子：每一段提到的指令都能在 repo 根目錄照抄執行。

### 6. 第一張 Issue

開一張小而確定的單，本文寫清楚「要做的事」與可檢查的「驗收」，驗收裡的檢查只引用第 3 步的那條指令。然後分級：

```text
/triage <n>
```

做完的樣子：Issue 帶 `ready-for-agent`，本文有 `/triage` 寫的 agent brief。`/triage` 留下產品問題時它會設 `needs-info`，回答完再跑一次。

### 7. `/issue-run`

在 repo 的主 checkout 開新 session：

```text
/issue-run <n>
```

它依序做 Gate、Graph、Claim、Build、Candidate、Report，中間不停下來問；只在[停點](#什麼時候會停)停。分支與 worktree 照 adapter 的 Worktrees and checkpoint 段；沒寫就照 `implement-spec` 的預設。ron-skills 的寫法是：每張 ticket 都從 `main` 開一個 `issue/<n>-<slug>` 的 worktree，因為它的主 checkout 有 hook 擋寫入（L3 才接，見 [06](06-quality-gates.md#1-編輯時)）；L1 的 repo 沒有這個 hook，一張 ticket 可以直接在主 checkout 開分支。

做完的樣子：報告列出 candidate 的完整 SHA、每條指令與 exit code、review findings（Standards 與 Spec 分開列）、沒跑的檢查，以及你接下來要做的事；Issue 上有一則證據留言。

### 8. push、PR／MR、合併、結案

報告最後的「下一步」照順序做：

```bash
git push -u origin issue/<n>-<slug>
gh pr create --base main --fill            # GitLab：glab mr create --target-branch main --fill
# 合併之後
gh issue close <n> --comment "已合進 main：<merge commit>"   # GitLab：glab issue close <n>
git branch -d issue/<n>-<slug> && git push origin --delete issue/<n>-<slug>
```

做完的樣子：Issue 關閉，candidate 在 `origin/main` 上，本機與遠端都沒有工作分支。

## 什麼時候會停

`/issue-run` 只在這些情況停下來交回給你，同時把其他不受影響的 ticket 繼續做完：

- Issue 留了產品決策，或 spec 和程式碼矛盾。
- 缺前置條件、帳密、資料庫或 fixture 的授權。
- worktree 裡有不屬於這張單的改動。
- 合併衝突需要設計判斷。
- 兩輪 review 修正後仍有 finding。
- 工具壞掉擋住某一步（它會回報，不會自己修共用工具）。

停下來的訊息會寫已確認的事實、卡在哪一步、證據在哪、需要你做什麼決定。

## L1 之後

L1 跑順的訊號：連續幾張單不用你插手就到 candidate，你只做 review 與 push。開始同時開好幾個 session、或已經發生過狀態對不上與繞過檢查時，往 [04 L2 導入](04-level2.md) 走。
