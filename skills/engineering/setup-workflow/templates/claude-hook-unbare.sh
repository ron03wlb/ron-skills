#!/usr/bin/env bash
# PreToolUse（Bash）hook：Orca 從 WSL 做 worktree 操作時，可能在任何 session 進行中把主 checkout 的 core.bare 設成 true，
# 不只在 pilot 的 Probe、Dispatch、Close（retro 2026-10-30：互動 session 一小時內碰到兩次，git status 回 `must be run in a work tree`）。
# 從 git common dir 找主 checkout：在 linked worktree 裡 --is-bare-repository 照樣回 false，看不出主 checkout 已壞。
# stdout 與 exit code 同 pilot-unbare.sh；git 失敗時非 0，hook 不擋工具呼叫。
set -euo pipefail
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE
common=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --path-format=absolute --git-common-dir)
exec "$(dirname "$0")/pilot-unbare.sh" "$(dirname "$common")" hook
