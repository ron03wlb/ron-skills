#!/usr/bin/env bash
# 用 Codex 跑 understand-anything 任一代理定義（assemble-reviewer、architecture-analyzer、tour-builder…）。
# 用法：run-agent.sh <agent-name> <dispatch-prompt-file> <tag>
# 派工提示內的大型輸入請寫成檔案並給路徑，不要內嵌 JSON。
set -u
source "$(dirname "$0")/common.sh"
agent=${1:-}; promptfile=${2:-}; tag=${3:-}
[[ -n $tag && -f $UA_PLUGIN_ROOT/agents/$agent.md && -f $promptfile ]] || { echo "用法：run-agent.sh <agent-name> <dispatch-prompt-file> <tag>（agent 須存在於 $UA_PLUGIN_ROOT/agents/，提示檔須存在）" >&2; exit 2; }
head_gate || exit $?
FULL=$OUT/$tag.prompt.md
{ echo "# Role: understand-anything $agent (agent definition follows)"; echo; agent_body "$agent"
  echo; echo "---"; echo; echo "# Dispatch (from main orchestrator session)"; echo; cat "$promptfile"
  echo; echo "Notes for Codex runtime: run Node scripts with \`node\`, Python with \`python3\`. Non-interactive: never ask questions, never spawn sub-agents. Reply with a short summary when done."
} > "$FULL"
run_codex "$FULL" "$tag"; rc=$?
echo "$tag codex_exit=$rc last message: $OUT/$tag.last.md"; cat "$OUT/$tag.last.md" 2>/dev/null; exit $rc
