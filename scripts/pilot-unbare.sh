#!/usr/bin/env bash
# Orca 從 WSL 做 worktree create、rm 時會把主 checkout 的 core.bare 設成 true，之後 git status、stage、merge 全部失敗（#20）。
# pilot 的 Probe、Dispatch、Close 都只呼叫這支：是 bare 就還原為 false，並在 <checkout>/.scratch/pilot/decisions.md 記一筆。
# 用法：scripts/pilot-unbare.sh <主 checkout> <時機>（如 probe、dispatch #20、close #20）
# stdout：還原時一行 `UNBARE <主 checkout>`，沒事時不輸出；exit 0 結束時不是 bare，其他為 git 失敗。
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE
checkout=${1:?用法：scripts/pilot-unbare.sh <主 checkout> <時機>}
when=${2:?用法：scripts/pilot-unbare.sh <主 checkout> <時機>}

[[ $(git -C "$checkout" rev-parse --is-bare-repository) == true ]] || exit 0
git -C "$checkout" config core.bare false
mkdir -p "$checkout/.scratch/pilot"
echo "- $(date -Iseconds) core.bare 被設成 true（$when），已還原為 false" >> "$checkout/.scratch/pilot/decisions.md"
echo "UNBARE $checkout"
