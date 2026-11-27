# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

## 分類 label

每張 triage 過的 issue 掛一個分類 label 加一個上表的狀態 label（`/triage` 的規則）。本 repo 的分類 label 與 mattpocock/skills 相同：

| Label in mattpocock/skills | Label in our tracker | Meaning                       |
| -------------------------- | -------------------- | ----------------------------- |
| `bug`                      | `bug`                | Something is broken           |
| `enhancement`              | `enhancement`        | New feature or improvement    |

`scripts/issue-pool.mjs` 對有狀態 label 卻沒有這兩個分類的開著的單印一行 `NO_CATEGORY <n> <n>…`（見 [pilot.md](pilot.md) 的 **Pool**）；分類 label 改名時，Pool 的指令加上 `--categories <label>,<label>`。

## `ready-for-agent` 的輸入條件

標 `ready-for-agent` 之前，先照 [issue-run.md](issue-run.md#readiness) 的 **Readiness** 檢查驗收與做法用到的輸入取得到；取不到的維持 `needs-info`。驗收引用串接指令或結果依 repo 狀態而定的指令（`git fetch … && git checkout …`）時，寫明 fixture 的前提狀態（哪些 ref、檔案已存在），否則 reviewer 以另一種前提驗證會回報成 P2，worker 只能自己裁定（#687：#548 驗收沒寫本機 `develop` 是否已存在）。

把本文存檔後跑 `node scripts/brief-check.mjs --paths <本文檔>`：每行 `BRIEF_PATH_MISSING <path>` 都要處理，路徑寫錯就改本文，是要新增的檔或其他 repo 的路徑就在本文寫明（advisory，exit 0，不擋 label；#515：#381 寫了不存在的 `issue-pilot/ADAPTER.md`，worker 多花四次呼叫找真正的位置）。

驗收裡的輸出範例寫成腳本實際會印的完整字串，和 Desired behavior 的格式行逐字對得上：格式行的參數是 repo 相對路徑，範例也寫 repo 相對路徑，不寫 basename（#620：#599 的格式行是 `PORTED <條目> <目標檔>`、`<目標檔>` 相對 repo 根，驗收卻寫 `PORTED Probe pilot-round.md`，worker 只能自己挑一個讀法記成 ruling）。

驗收裡「改 `skills/engineering/setup-workflow/templates/` 的正本與測試，`scripts/` 副本用 `skills/engineering/setup-workflow/scripts/copy-templates.mjs` 同步」這一項，只在 `node scripts/worktree-overlap.mjs <要改的檔>…` 印 `TEMPLATE_COPY` 時才寫；沒印就不是範本副本，寫了 worker 得先查清單、記一條 ruling 才知道不適用（#438：#380 的 `scripts/sync-skills.mjs` 不在 `docs/agents/workflow-templates.json`）。

## `parent` label

帶 `parent` label 的 issue 是母單（見 [issue-tracker.md](issue-tracker.md#母單)）：`/triage` 不把它放進 Unlabeled 桶，也不給它掛上表中任何 triage label。母單的 label 由 pilot 的 Reconcile 整理（[pilot.md](pilot.md) 的 **Probe**）。

## `priority`、`retro` 與 `retro-candidates` label

三個都不是 triage 角色。`scripts/issue-pool.mjs` 讀它們：

- **`retro`**：`/retro-collect` 判定太大、交給 worker 的 retro 候選，可以和上表的 label 同時掛，照一般 triage 進池子；`ready` 桶排在最前，勝過 `priority`。
- **`priority`**：可以和上表的 label 同時掛；`ready` 桶排在 `retro` 之後，勝過 block 開著的單的數目和號碼。
- **`retro-candidates`**：一個 session 的 `/retro` 在收集模式開的候選清單，等 `/retro-collect`；不掛任何 triage label，也不進池子。不是母單或 `ready-for-human` 時，不論掛了什麼、有沒有被 `/retro-collect` 認領指派，都歸到 `retro-candidates` 桶，不混進 `claimed`、`stale`（優先序寫在腳本檔頭，#270）。`/triage` 比照 `parent`，不把它放進 Unlabeled 桶，也不給它掛 triage label。
