# 通用 script 的正本放在 ron-skills，複製進各專案

各專案共用的通用 script（pilot、hook 這類）要有一份**正本**，各專案才能追蹤**分歧**。我們決定正本連同它的測試放在 ron-skills 的 `skills/engineering/setup-workflow/templates/`，由 `/setup-workflow` 複製進各專案的 `scripts/`；專案記一份清單，寫明每個副本對應的正本 commit 與 hash，用來追分歧。

## 被否決的做法

- **專案直接引用 `~/.claude/skills/...`。** 團隊 repo 的同事不一定能存取 private 的 ron-skills；而且 permissions allowlist 需要專案內的固定路徑，`pilot_git.py` 用複製也是這個原因。
- **正本留在 spay2，其他專案跨 repo 引用。** ron-skills 已經因此出現對 `~/code/spay2` 的隱性依賴，`claude-hook-language.mjs` 也在複製後分歧。

## 後果

專案本地改過的副本，要先把改動回饋到正本，再從正本同步回專案；不能只留在專案裡。
