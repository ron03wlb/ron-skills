#!/usr/bin/env bash
# Orca 從 WSL 做 worktree create、rm 時可能把主 checkout 的 core.bare 設成 true，之後 git status、stage、merge 全部失敗（#20）。
# pilot 的 Probe、Dispatch、Close 都只呼叫這支：是 bare 就還原為 false，並在 <checkout>/.scratch/pilot/decisions.md 的表格追加一列。
# 用法：scripts/pilot-unbare.sh <主 checkout> <時機>（如 probe、dispatch #20、close #20）
# stdout：還原時一行 `UNBARE <主 checkout>`，沒事時不輸出；exit 0：結束時主 checkout 不是 bare（含剛還原），其他為 git 失敗。
set -euo pipefail
# 從 pre-commit hook 或 worktree 呼叫時繼承的 GIT_DIR 等會讓 git -C 讀寫到別的 repo。
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE
checkout=${1:?用法：scripts/pilot-unbare.sh <主 checkout> <時機>}
when=${2:?用法：scripts/pilot-unbare.sh <主 checkout> <時機>}

bare=$(git -C "$checkout" rev-parse --is-bare-repository)
[[ $bare == true ]] || exit 0
git -C "$checkout" config core.bare false
mkdir -p "$checkout/.scratch/pilot"
echo "| $(date -Iseconds) | 還原 core.bare | 被設成 true（$when） | git rev-parse --is-bare-repository 印出 true | git config core.bare false |" >> "$checkout/.scratch/pilot/decisions.md"
echo "UNBARE $checkout"
