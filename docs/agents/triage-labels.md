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

## `ready-for-agent` 的輸入條件

標 `ready-for-agent` 之前，先照 [issue-run.md](issue-run.md#readiness) 的 **Readiness** 檢查驗收與做法用到的輸入取得到；取不到的維持 `needs-info`。

## `parent` label

帶 `parent` label 的 issue 是母單（見 [issue-tracker.md](issue-tracker.md#母單)）：`/triage` 不把它放進 Unlabeled 桶，也不給它掛上表中任何 triage label。母單的 label 由 pilot 的 Reconcile 整理（[issue-run.md](issue-run.md) 的 **Probe**）。

## `priority`、`retro` 與 `retro-candidates` label

三個都不是 triage 角色。`scripts/issue-pool.mjs` 讀它們：

- **`retro`**：`/retro-collect` 判定太大、交給 worker 的 retro 候選，可以和上表的 label 同時掛，照一般 triage 進池子；`ready` 桶排在最前，勝過 `priority`。
- **`priority`**：可以和上表的 label 同時掛；`ready` 桶排在 `retro` 之後，勝過 block 開著的單的數目和號碼。
- **`retro-candidates`**：一個 session 的 `/retro` 在收集模式開的候選清單，等 `/retro-collect`；不掛任何 triage label，也不進池子。沒被指派、也不是母單或 `ready-for-human` 時，不論掛了什麼，都歸到 `retro-candidates` 桶（優先序寫在腳本檔頭）。`/triage` 比照 `parent`，不把它放進 Unlabeled 桶，也不給它掛 triage label。
