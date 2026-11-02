#!/bin/sh
# orca-tab-title.sh 回歸測試：以假的 orca CLI 記錄 rename 呼叫，不動真的 Orca 分頁。
# 用法：sh ~/.claude/hooks/orca-tab-title.test.sh（需至少兩個存在的 Orca worktree）
set -u
hook="$(dirname "$0")/orca-tab-title.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp" "$HOME/.cache/orca-tab-title/test_handle"*' EXIT
fail=0
export TAB_STATE_DIR="$tmp/tab-titles"
mkdir -p "$TAB_STATE_DIR"

cat > "$tmp/fake-orca" <<EOF
#!/bin/sh
echo "\$*" >> "$tmp/calls.log"
printf '{"result":{"terminal":{"title":"%s"}}}' "\${FAKE_TITLE:-✳ 測試標題}"
EOF
chmod +x "$tmp/fake-orca"

# 取兩個存在、分支含不同 issue 編號的 worktree
set -- $(git -C "$HOME/code/spay2" worktree list --porcelain | sed -n 's/^worktree //p' | grep '/orca/workspaces/.*issue-[0-9]' |
  awk '{ n = $0; sub(/.*issue-/, "", n); sub(/[^0-9].*/, "", n) } !seen[n]++' | head -2)
[ $# -eq 2 ] || { echo "SKIP：找不到兩個 Orca issue worktree"; exit 0; }
a=$1 b=$2
issue_a="#$(git -C "$a" branch --show-current | sed -n 's/.*issue-\([0-9]*\).*/\1/p')"
issue_b="#$(git -C "$b" branch --show-current | sed -n 's/.*issue-\([0-9]*\).*/\1/p')"

mk() { printf '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"command":"%s"}}]}}\n' "$1"; }
{ mk "cd $a && git status"; mk "for d in $a $b; do git -C \$d status; done"; } > "$tmp/transcript.jsonl"

# $1 事件 $2 提示 $3 期望的 rename 參數（空字串表示不應呼叫）$4 情境名稱 $5 假 CLI 回傳的原生標題（省略用預設）
# $6 為 keep 時保留前一案例的快取
check() {
  [ "${6:-}" = keep ] || rm -rf "$HOME/.cache/orca-tab-title/test_handle"*; : > "$tmp/calls.log"
  printf '{"hook_event_name":"%s","prompt":"%s","cwd":"%s/code/spay2","transcript_path":"%s"}' \
    "$1" "$2" "$HOME" "$tmp/transcript.jsonl" |
    ORCA_TERMINAL_HANDLE=test_handle ORCA_CLI_COMMAND="$tmp/fake-orca" FAKE_TITLE="${5:-}" sh "$hook"
  sleep 3
  got=$(grep rename "$tmp/calls.log" | sed 's/^terminal rename --terminal test_handle *//')
  if [ "$got" = "$3" ]; then echo "PASS $4"; else echo "FAIL $4：期望 [$3] 實得 [$got]"; fail=1; fi
}

check UserPromptSubmit '<task-notification>\n<task-id>x</task-id>' '' '背景通知不改標題'
check UserPromptSubmit 'Another Claude session sent a message: x' '' '其他 session 訊息不改標題'
check UserPromptSubmit '繼續實作' "--title $issue_a 繼續實作" '跳過碰到多個 worktree 的呼叫'
check Stop '' "--title $issue_a 測試標題" 'Stop 用原生標題'
check Stop '' "--title $issue_a" '/clear 後原生標題為 Claude Code 時只寫前綴' '◑ Claude Code'
check UserPromptSubmit '繼續實作' "--title $issue_a 繼續實作" '提示寫入描述快取'
check Stop '' "--title $issue_a 繼續實作" '原生標題為 Claude Code 時沿用上次提示描述' '◑ Claude Code' keep

# PostToolUse：只看本次 tool_input；$1 指令 $2 期望的 rename 參數 $3 情境名稱 $4 為 keep 時保留快取
check_post() {
  [ "${4:-}" = keep ] || rm -rf "$HOME/.cache/orca-tab-title/test_handle"*; : > "$tmp/calls.log"
  printf '{"hook_event_name":"PostToolUse","tool_input":{"command":"%s"},"cwd":"%s/code/spay2","transcript_path":"%s"}' \
    "$1" "$HOME" "$tmp/transcript.jsonl" |
    ORCA_TERMINAL_HANDLE=test_handle ORCA_CLI_COMMAND="$tmp/fake-orca" sh "$hook"
  sleep 3
  got=$(grep rename "$tmp/calls.log" | sed 's/^terminal rename --terminal test_handle *//')
  if [ "$got" = "$2" ]; then echo "PASS $3"; else echo "FAIL $3：期望 [$2] 實得 [$got]"; fail=1; fi
}

check_post "git -C $b status" "--title $issue_b" '回合中途無描述快取時只寫前綴'
check_post "for d in $a $b; do git -C \$d status; done" '' '回合中途同一呼叫碰到多個 worktree 不改名'
check UserPromptSubmit '開始處理' "--title $issue_a 開始處理" '回合中途前準備描述快取'
check_post "git -C $b status" "--title $issue_b 開始處理" '回合中途碰到另一個 issue worktree 立即改名' keep
check_post "cd $b && ls" '' '回合中途前綴未變不呼叫 orca' keep

# tab-state 記錄帶狀態前綴時標題歸它管理；記錄沒有前綴時維持原行為
printf '處理中｜主題' > "$TAB_STATE_DIR/test_handle"
check UserPromptSubmit '繼續實作' '' '狀態前綴：送出提示不改標題'
check Stop '' '' '狀態前綴：回合結束不改標題'
check_post "git -C $b status" '' '狀態前綴：回合中途不改標題'
printf '待 Retro｜主題' > "$TAB_STATE_DIR/test_handle"
check Stop '' '' '待 Retro 前綴同樣不改標題'
printf '主題' > "$TAB_STATE_DIR/test_handle"
check Stop '' "--title $issue_a 測試標題" '記錄沒有狀態前綴時照舊改名'
rm -f "$TAB_STATE_DIR/test_handle"
exit $fail
