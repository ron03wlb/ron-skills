# ron-skills

個人 skill 層：把 Issue 交給 agent 交付的流程，以及各專案如何選擇並導入這套流程。

## 工作流程選擇

**導入等級**:
一個專案採用交付流程的深度，分 L0 不導入、L1 基本、L2 守門、L3 常駐四級；每一級都是完整可用的流程。
_Avoid_: 方案、模式、tier

**擴充**:
與導入等級正交、可分別勾選的專案特性，例如 tracker 種類、卡關單、外部測試環境、自訂分級入口；等級相同的兩個專案靠擴充區分。
_Avoid_: 外掛、preset、專案原型

**adapter**:
專案寫給 agent 讀的一份設定，記錄自己的 tracker、檢查、交付指令，以及 L3 的 Pilot 段。
_Avoid_: 設定檔、profile

## 共用 script

**正本**:
放在 ron-skills、供各專案複製使用的通用 script 與它的測試；專案裡的是副本，不是另一份來源。
_Avoid_: upstream、master copy、原版

**分歧**:
專案副本與正本不一致的狀態，分成正本較新、專案本地改過、兩邊都改了三類。
_Avoid_: drift、不同步

**體檢**:
對已導入的專案比對 adapter、文件與實際使用，找出等級標示錯誤、分歧與隱性跨 repo 依賴。
_Avoid_: audit、健檢、檢查

**pilot 存檔**:
coordinator 跨 session 保存進度的一組狀態檔，例如批次 checkpoint、決策紀錄、hold、session 紀錄；格式由契約固定，正本 script 只依這份契約讀寫。
_Avoid_: Program store、scratch、狀態檔

## Issue 組織

**母單**:
範圍已定、子單已拆好的分組 issue；本身不派工、不驗收，開關跟著子單走。
_Avoid_: epic、map、總單

**對應單**:
另一個 repo 裡處理同一件事的 issue，在本文寫成「對應單：<owner>/<repo>#<m>」；這張 issue 合入後，pilot 到對應單留言交接。整句寫在「」、code span 或 code block 裡的是引用，不算。
_Avoid_: 關聯單、mirror issue

**池子**:
開著、可以直接派工的 Issue：標 `ready-for-agent`，而且不是母單、沒被 block、沒被認領。
_Avoid_: queue、backlog、待辦

**認領**:
session 開始處理一張 Issue 前，在 tracker 上把它指派給自己，讓其他機器或 session 不會撿到同一張；同一個帳號分不出 session，所以先留一則「認領：<機器>／<session>」留言再指派。
_Avoid_: lock、claim、佔單
