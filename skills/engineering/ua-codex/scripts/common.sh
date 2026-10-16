#!/usr/bin/env bash
# 共用：解析專案根、資料目錄、plugin 根與 Codex 參數。由其他腳本 source。
set -u
PROJECT_ROOT=${PROJECT_ROOT:-$(pwd -P)}
[[ -d $PROJECT_ROOT/.git || -f $PROJECT_ROOT/.git ]] || { echo "ua-codex: PROJECT_ROOT 不是 git 專案：$PROJECT_ROOT" >&2; exit 2; }
if [[ -d $PROJECT_ROOT/.understand-anything ]]; then UA_DIR=$PROJECT_ROOT/.understand-anything; else UA_DIR=$PROJECT_ROOT/.ua; fi
if [[ -z ${UA_PLUGIN_ROOT:-} ]]; then
  UA_PLUGIN_ROOT=$(ls -d "$HOME"/.claude/plugins/cache/understand-anything/understand-anything/*/ 2>/dev/null | sort -V | tail -1)
  UA_PLUGIN_ROOT=${UA_PLUGIN_ROOT%/}
fi
[[ -f ${UA_PLUGIN_ROOT:-}/agents/file-analyzer.md ]] || { echo "ua-codex: 找不到 understand-anything plugin（設 UA_PLUGIN_ROOT）" >&2; exit 2; }
CODEX_MODEL=${CODEX_MODEL:-gpt-6.1-sol}
CODEX_EFFORT=${CODEX_EFFORT:-high}
OUT=$UA_DIR/tmp/codex
mkdir -p "$OUT"
SCRATCH=${CLAUDE_SCRATCHPAD:-/tmp/claude-$(id -u)}

# 去掉 agent 定義的 YAML frontmatter
agent_body() { awk 'BEGIN{fm=0} NR==1&&/^---$/{fm=1;next} fm==1&&/^---$/{fm=0;next} fm==0{print}' "$UA_PLUGIN_ROOT/agents/$1.md"; }

# HEAD 漂移 gate：第一次呼叫記錄 HEAD，之後每次比對；不同即以 3 結束。
head_gate() {
  local now; now=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null) || return 0
  if [[ -f $OUT/head.txt ]]; then
    local start; start=$(<"$OUT/head.txt")
    if [[ $start != "$now" ]]; then
      echo "ua-codex: HEAD 已從 $start 前進到 $now，分析基準漂移；停止派工。處理後刪除 $OUT/head.txt 再續跑。" >&2
      git -C "$PROJECT_ROOT" diff --name-status "$start" "$now" | head -50 >&2
      return 3
    fi
  else
    echo "$now" > "$OUT/head.txt"
  fi
}

run_codex() { # <prompt-file> <tag>
  local prompt=$1 tag=$2
  ( cd "$PROJECT_ROOT" && codex exec -m "$CODEX_MODEL" -c "model_reasoning_effort=\"$CODEX_EFFORT\"" \
      -c project_doc_max_bytes=0 -s workspace-write --add-dir "$SCRATCH" -C "$PROJECT_ROOT" \
      --skip-git-repo-check --color never -o "$OUT/$tag.last.md" - < "$prompt" > "$OUT/$tag.log" 2>&1 )
  local rc=$?; echo "$tag codex exit=$rc" >> "$OUT/status.txt"; return $rc
}
