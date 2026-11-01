# 03 L1 導入

L1 的目標：在一個還沒有 adapter 的 repo 裡，把第一張 Issue 用 `/issue-run` 跑到本機 candidate commit，之後用 `/issue-queue` 看池子、用 `/loop /issue-run --pool` 一張接一張跑。照下面的 checklist 由上往下做，每一步都有「做完的樣子」，對不上就停在那一步。

實例：ron-skills 的 adapter [`docs/agents/issue-run.md`](../agents/issue-run.md) 只看 Tracker、Readiness、Checks、Candidate and acceptance、Evidence and closing 五段，就是一份 L1 adapter；其餘段落屬於 L3。唯一檢查入口是 `bin/check`。

## Checklist

第 1～5 步由 `/setup-workflow` 一次做完：它自己偵測作業系統、tracker 與程式碼放在哪裡，再依這台機器有的工具裝到能裝的最完整流程，不問等級，也不要你確認寫入清單。所有改動都寫在另開 worktree 的 `setup-workflow` 分支上，最後開一個 PR（GitLab 是 MR）。你合併那個 PR，就是唯一的確認。它全程用你的語言說明，只在三種情況問你：偵測不出來（沒有 remote）、tracker 和程式碼不在同一個 host，或要覆蓋你改過的檔案。

裝到哪裡由偵測結果決定：

- **有 Orca，而且 Issue 在 GitHub**：agent 常駐在這個 repo，自己從 Issue 池挑單、開 worktree 派工、驗證後合進 integration 分支；你只做產品決策，push 和合併到預設分支也由你來。
- **其他情況**（沒有 Orca，或 Issue 在 GitLab、本機 Markdown）：每張 Issue 一個 worktree，先合進 integration 分支，push 前自動跑檢查，遠端 CI 也會設好；派工由你在各 session 下指令。

下面每一步寫它做什麼、做完的樣子，以及不用 `/setup-workflow` 時的手動備用。哪一步停在「不寫檔、只給修正指令」，修好之後重跑 `/setup-workflow` 即可。

### 1. 環境

先在這台機器裝 skills（每台機器一次）：

```bash
git clone https://github.com/ron03wlb/ron-skills ~/code/ron-skills   # private：先取得讀取權限
git clone https://github.com/ron03wlb/skills ~/code/skills           # Matt skills 的 fork
git clone https://github.com/backnotprop/pstack ~/code/pstack
~/code/ron-skills/bin/sync-skills --check   # overlay 能套用、沒有 OVERLAY_FAILED
~/code/ron-skills/bin/sync-skills           # 連結到 ~/.claude/skills/
```

新開的 Claude Code session 打 `/` 要看得到 `issue-run`、`triage`、`setup-workflow`、`setup-matt-pocock-skills`。Matt 或 pstack 放在別的路徑時，用 `MATT_SKILLS`、`PSTACK_SKILLS` 環境變數指定。

然後在目標 repo 開 Claude Code，輸入 `/setup-workflow`。它先偵測這台機器的平台（macOS、WSL2、Linux，見[支援平台](01-tooling.md#支援平台)）、必要工具（符合 repo CI 鎖定版本的 Node、git 2.31 以上；要複製 `.py` 正本時還有 `python3`）與選用工具（Orca、Codex）。偵測到的平台直接寫進 adapter 的 `## Platforms`；團隊有人用別的平台，就由他在自己的機器上重跑一次 `/setup-workflow`，把平台補上去。

- 必要工具缺漏或版本不符：停下、不寫檔，只給修正指令；setup 不安裝、也不切換 runtime。
- 原生 Windows：停下，提示改用 WSL2。
- 選用工具缺漏：只記錄，不停。沒有 Orca 就不會裝常駐 pilot，沒有 Codex 就不會裝 `codex` 擴充；報告會說明裝了之後多什麼。

做完的樣子：印出 `ENV ok`。

### 2. Host

分別判斷 tracker host（看 `docs/agents/issue-tracker.md`，還沒有這份文件時看 `origin`）與程式碼 host（看 `origin`），各是 GitHub、GitLab 或 `local`，並檢查對應的 `gh`／`glab` 已安裝、已登入。指令對照見 [HOSTS.md](../../skills/engineering/setup-workflow/HOSTS.md)。偵測得出來就直接用，不問你。

- 兩個 host 不同（例如 tracker 在 GitHub、程式碼在 GitLab）：兩個都列出來問你一次，adapter 的 Tracker 段與 Delivery 段各用各的 CLI。
- 任一個是 `local`（沒有 remote，或 tracker 是本機 Markdown）：程式碼 host 是 `local` 時沒有 Delivery 段，也就沒有 PR／MR 與遠端 CI。它會問你之後會不會加 remote；會的話先加好再重跑。
- 自架 GitLab（http、IP）算 GitLab；GitHub、GitLab 以外的主機不支援，會直接告訴你並停下。
- 缺 `gh`／`glab` 或沒登入：和第 1 步一樣停下、不寫檔，只給修正指令。

做完的樣子：印出 `HOST ok`。

### 3. 安裝目標與檢查入口

`detect.mjs` 偵測現況（每個訊號的證據與量測數字），最後兩行是 `TARGET`（這次要裝到哪裡與依據）和目前狀態。它不問是非題，也不限一次只升一級：已經是常駐 pilot 的維持；有 Orca 而且 tracker 在 GitHub 就裝常駐 pilot；其他裝到 integration 分支加 push 前檢查。

所有檢查都要經過同一條單一檢查入口：一條指令跑完這個 repo 所有該跑的檢查（lint、型別、測試、文件守門），全過才 exit 0。pre-push、CI 和 adapter 都只呼叫它，檢查清單只寫在這一個地方。

- 已經有的就沿用：`bin/check`、`npm run check`、`make check`，或 adapter 已寫的 Checks。
- 沒有的話，`/setup-workflow` 自己建一個 `bin/check`：開頭 `set -euo pipefail`，把 repo 現有的 lint、型別、測試、建置指令依序串起來，再加上它複製進來的檢查。報告會列出串了哪些指令。
- 手動備用：自己建 `bin/check`，在乾淨的預設分支上跑是 exit 0，故意弄壞一個測試再跑是非 0。

做完的樣子：`TARGET` 行印出目標與依據。

### 4. tracker、label 與語言

`/setup-workflow` 在 worktree 裡照 `setup-matt-pocock-skills` 的步驟寫出下面的檔案，問題都用偵測結果和預設值回答：tracker 用第 2 步偵測到的 host，label 用五個預設名稱，domain docs 用單一 context（偵測到 monorepo 才分多個）。repo 沒有 `CLAUDE.md` 也沒有 `AGENTS.md` 時建 `CLAUDE.md`。你的語言不是英文時，它在同一個檔案加上 `### Language` 段，規定使用者看得到的訊息都用你的語言；繁體中文還會帶上語言檢查 hook。

- `docs/agents/issue-tracker.md`：讀單、開單、留言、改 label、依賴關係的指令
- `docs/agents/triage-labels.md`：五個角色對應的 label 字串
- `docs/agents/domain.md`，以及 `CLAUDE.md`（或 `AGENTS.md`）的 `## Agent skills` 段

手動備用：輸入 `/setup-matt-pocock-skills` 依序回答三段，再在 tracker 上建出 label（已存在的會報錯，略過即可）：

```bash
# GitHub
for l in needs-triage needs-info ready-for-agent ready-for-human wontfix; do gh label create "$l"; done
# GitLab
for l in needs-triage needs-info ready-for-agent ready-for-human wontfix; do glab label create --name "$l"; done
```

做完的樣子：`gh label list`（或 `glab label list`）列得出五個 label；`docs/agents/issue-tracker.md` 的讀單指令在 agent 的 Bash 工具裡跑得出內容（GitHub 用 `--json`，見 [02](02-lifecycle.md#tracker-指令對照)）。

### 5. adapter、檢查與 PR

`/setup-workflow` 以 [`ADAPTER.md`](../../skills/engineering/issue-run/ADAPTER.md) 為骨架寫出 `docs/agents/issue-run.md`，填入第 1 步的平台、第 2 步的 host 與第 3 步的檢查入口，以及目標用得到的其他段落。接著把要用的 script 正本複製到 `scripts/`，記錄在 `docs/agents/workflow-templates.json`；目標包含 integration 分支時，也一起建 integration 分支、push 前的 hook 和遠端 CI。最後 commit、push 分支、開 PR，PR 說明用你的語言寫清楚合併之後 agent 能做什麼、哪些仍由你做。

手動備用：把 [`ADAPTER.md`](../../skills/engineering/issue-run/ADAPTER.md) 複製成目標 repo 的 `docs/agents/issue-run.md`，每段填這個 repo 真的有的指令；沒寫的段落採範本裡的 Default。最少要填下面五段。adapter 是給 agent 讀的，用英文寫：

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

做完的樣子：PR 已開，PR 上的檢查入口 exit 0；adapter 每一段提到的指令都能在 repo 根目錄照抄執行。你合併 PR、重開 Claude Code 讓新的 hook 生效後，就可以開始第 6 步。

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

### 9. `/issue-queue`

第一張單跑順之後，用 `/issue-queue` 看所有開著的 Issue 怎麼分桶。它跑 `scripts/issue-pool.mjs`（`/setup-workflow` 在 L1 一定會複製這支；手動備用時自己跑 `copy-templates.mjs <repo> issue-pool`。tracker 要是 GitHub 或 GitLab，本機 Markdown tracker 沒有池子），第一行是 `進行中 <N>／上限 <M>`（L1 沒有 Pilot 段，上限顯示 `不限`），接著依 `ready`、`parent`、`human`、`retro-candidates`、`stale`、`claimed`…的順序列出分桶，`ready` 桶的順序就是開工順序。`needs-triage`、`unlabeled` 的單，以及上次分級後有新留言的 `needs-info` 單，它照 `/triage` 的規則逐張細化，每一則改動都等你確認；過期的認領（`stale`）只列出來，放不放由你決定。

做完的樣子：`/issue-queue` 印出上限行與分桶，你要開工的單在 `ready` 桶。

### 10. `/issue-run --pool`

池子裡有幾張 `ready` 的單時，不必逐張打 `/issue-run <n>`：

```text
/loop /issue-run --pool 3
```

它在同一個 session 照 `ready` 的順序先 `node scripts/issue-pool.mjs claim <n>` 認領、再照 `/issue-run <n>` 跑，一次一張、不開新分頁；別的 session 已認領的單略過。停下的單在 Issue 留言寫明停在哪一步、記成 `stopped`，被它擋住的單記成 `skipped`，其餘照跑；你在那張單留言回覆後，下一次醒來會接著做。不帶數字時不設上限，loop 只在你停掉時結束。每張單的 push 與結案照 adapter 的 Evidence and closing，L1 預設由你做（第 8 步）。

做完的樣子：`.scratch/issue-run-pool/state.md` 每張經手的單一列（認領過的，加上沒認領就略過的 `skipped`：別的 session 已認領，或被停下的單擋住），`done` 的單有 candidate SHA，`stopped` 的單有停點留言的網址。

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
