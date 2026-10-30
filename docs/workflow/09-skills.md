# 09 Skills 索引

依交付階段列出 skill，並標出它從哪一級開始用。**等級**欄：L1 是基本流程就會用到；L2、L3 是導入到該級才需要；「輔助」是隨時可用、但不是流程的必經入口。

使用者輸入的 skill（`/名稱`）有些設了 `disable-model-invocation`，只能由人輸入，agent 不會自己觸發；表中以「人輸入」標示。

## 設定（每個 repo 一次）

| skill | 做什麼 | 等級 | 來源 |
| --- | --- | --- | --- |
| `/setup-workflow` | 導入入口：偵測等級（L0–L3）與擴充，建議往上一級；經人確認後寫 tracker、label、domain docs 與 adapter，並把 script 正本複製到 `scripts/`、記錄在 `docs/agents/workflow-templates.json`；`/setup-workflow health` 體檢已導入的專案（等級標示錯誤、分歧、隱性跨 repo 依賴），只回報不寫檔 | L1（人輸入） | ron-skills |
| `/setup-matt-pocock-skills` | 產生 `docs/agents/` 的 tracker、triage label、domain docs 設定 | L1（人輸入；`/setup-workflow` 會照它的步驟做，手動時才單獨用） | Matt |
| `wizard` | 產生互動式 bash 精靈，帶人走完只有人能做的設定（建專案、token、CI secret） | 輔助 | Matt |
| `writing-for-agents` | 寫 skill、`CLAUDE.md`、adapter 這類給 agent 讀的文件 | 輔助 | Matt |

## 需求與開單

| skill | 做什麼 | 等級 | 來源 |
| --- | --- | --- | --- |
| `grilling`、`grill-me`、`grill-with-docs` | 逐題追問一個計畫或想法，直到決策都定案 | 輔助 | Matt（ron-skills overlay） |
| `to-spec` | 把對話整理成 spec | 輔助 | Matt |
| `to-tickets` | 把 spec 拆成可獨立交付的 Issue | 輔助 | Matt |
| `domain-modeling` | 維護 `GLOSSARY.md` 與 ADR | 輔助 | Matt（ron-skills overlay） |
| `research`、`prototype` | 查證事實寫成檔案；做一個丟棄式原型回答設計問題 | 輔助 | Matt |

## 分級

| skill | 做什麼 | 等級 | 來源 |
| --- | --- | --- | --- |
| `/triage` | 把 Issue 推進五個 triage 狀態，ready 的單寫好 agent brief | L1（人輸入） | Matt |
| 專案自訂的分級 skill | 分級規則多到 `/triage` 裝不下時取代它的專案層入口（見 [05 專案自訂的分級](05-level3.md#專案自訂的分級)） | L3（可選） | 各專案 |

## 實作與驗證

| skill | 做什麼 | 等級 | 來源 |
| --- | --- | --- | --- |
| `/issue-run` | 把 ready 的 Issue 不中斷地跑到本機 candidate commit；`--worker` 模式由 coordinator 派出 | L1（人輸入） | ron-skills |
| `implement` | 單張 ticket 的實作程序（`/issue-run` 照它做） | L1（由 `/issue-run` 引用） | Matt |
| `implement-spec` | 多張 ticket：task graph、每張一個 implementer subagent 與 worktree | L1（由 `/issue-run` 引用） | Matt |
| `tdd` | 紅、綠、重構；第一個產品改動前先有會紅的測試 | L1 | Matt |
| `code-review` | Standards 與 Spec 兩軸平行審查，並排回報 | L1 | Matt |
| `diagnosing-bugs` | 難解的 bug 與效能退化的診斷迴圈 | 輔助 | Matt |
| `codebase-design` | 設計深模組、找 seam 的共用詞彙 | 輔助 | Matt |

## 交付與結案

| skill | 做什麼 | 等級 | 來源 |
| --- | --- | --- | --- |
| `pr` | 寫 PR／MR 的描述 | L1 | Matt |
| `orca-cli` | 操作 Orca 的 worktree、terminal 與交棒 | L2（有 Orca 時）、L3 | 使用者層 |

## 常駐交付

| skill | 做什麼 | 等級 | 來源 |
| --- | --- | --- | --- |
| `/loop /issue-pilot` | 常駐 coordinator：挑單、派 worker、整批回歸、合入整合分支、push 與開 PR 合併（adapter 允許時），再結案 | L3 | ron-skills |
| `poteto-mode` | pstack 的 Autopilot、Orchestrate playbook；`/issue-pilot` 的協調方法來源 | L3（由 `/issue-pilot` 引用） | pstack（ron-skills overlay） |
| `principle-*` | pstack 的決策原則，每條寫明何時套用 | L3（由 `poteto-mode` 引用） | pstack |
| `arena` | 幾個 agent 各自實作同一題、交叉評審後挑一個；只用在昂貴、難逆轉、有多種合理做法的設計決策 | 輔助 | pstack（ron-skills overlay） |
| `loop` | 讓一個 skill 依固定間隔或自行排程重複執行 | L3 | Claude Code 內建 |

## 回顧與沉澱

| skill | 做什麼 | 等級 | 來源 |
| --- | --- | --- | --- |
| `/retro` | 回顧一次 session，提出環境改善（檢查、導覽、規範） | L2（人輸入） | Matt（ron-skills overlay：開 Issue 前依候選提到的名稱查開著的 Issue；寫入前查並行修改；退役 coordinator 改為收集模式） |
| `/retro-collect` | 收集退役 coordinator 的 `/retro` 檔，在一個 retro worktree 實作全部採用項 | L3（人輸入） | ron-skills |
| `handoff` | 把對話壓成交接文件，讓新的 session 接手 | 輔助 | Matt |

## 怎麼看完整清單

```bash
~/code/ron-skills/bin/sync-skills --list   # 每個 skill 一行：user/model、名稱、來源；在專案目錄執行會含專案 skill
```

哪些 Matt 與 pstack 的 skill 被連結、哪些刻意不連結，記在 ron-skills 的 `matt-skills.txt` 與 `pstack-skills.txt`。
