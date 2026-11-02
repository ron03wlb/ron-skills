#!/bin/sh
# Orca 終端分頁標題：#<issue> + 正在做什麼
# issue：Claude 開在 linked worktree 時取該分支；開在主工作目錄時，取對話紀錄中
#        最後一次工具呼叫用到的 Orca worktree 分支；都找不到就不加前綴。
#       PostToolUse 只看本次工具輸入，碰到單一 issue worktree 且與快取前綴不同時立即改名。
# 描述：UserPromptSubmit 用提示第一行前 20 字（沿用上次的 issue）；Stop 用 Claude Code 原生摘要，
#       沒有摘要（如 /clear 後仍是 Claude Code）就沿用上次提示的描述，再沒有就只寫 #<issue>。
# 沒有 issue 時清掉自訂標題，回到原生標題。任何錯誤皆靜默結束。
# 例外：tab-state.mjs 的標題記錄帶狀態前綴（處理中｜、待 Retro｜、待關閉｜）時完全不動標題。

payload=$(cat)
[ -n "${ORCA_TERMINAL_HANDLE:-}" ] || exit 0
orca=${ORCA_CLI_COMMAND:-orca-ide}
command -v "$orca" >/dev/null 2>&1 || exit 0

# orca CLI 需呼叫 Windows 程式，放背景執行以免拖慢提示送出與回合結束
(
  printf %s "$payload" | python3 -I -c '
import json, os, re, subprocess, sys

orca, handle = sys.argv[1], sys.argv[2]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

cache_dir = os.path.expanduser("~/.cache/orca-tab-title")
cache_file = os.path.join(cache_dir, re.sub(r"[^\w-]", "_", handle))
SYSTEM_PROMPT_PREFIXES = ("<task-notification", "<agent-message", "Another Claude session sent a message")
WORKTREE_RE = re.compile(r"(?:~|/[^\s\"\x27\\;`)]*?)/orca/workspaces/[^/\s\"\x27\\;`)]+/[^/\s\"\x27\\;`)]+")

def run(*args):
    return subprocess.run([orca, *args], capture_output=True, text=True, timeout=20)

def rename(title=None):
    args = ["terminal", "rename", "--terminal", handle]
    if title:
        args += ["--title", title]
    run(*args)

def git(path, *args):
    try:
        return subprocess.run(["git", "-C", path, *args], capture_output=True,
                              text=True, timeout=5).stdout.strip()
    except Exception:
        return ""

def issue_of(path):
    branch = git(path, "branch", "--show-current")
    m = re.search(r"#(\d+)", branch) or re.search(r"issue-(\d+)", branch)
    return "#" + m.group(1) if m else ""

def is_linked_worktree(path):
    out = git(path, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir").splitlines()
    return len(out) == 2 and out[0] != out[1]

def single_worktree(tool_input):
    hits = WORKTREE_RE.findall(json.dumps(tool_input, ensure_ascii=False))
    found = {h for h in {os.path.expanduser(h) for h in hits} if os.path.isdir(h)}
    return found.pop() if len(found) == 1 else ""

def last_worktree_in_transcript(path):
    # 只看 assistant 的 tool_use 輸入，避免 git worktree list 之類的輸出誤判
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 4 * 1024 * 1024))
            lines = f.read().decode("utf-8", "ignore").splitlines()
    except Exception:
        return ""
    for line in reversed(lines):
        if "tool_use" not in line or "orca/workspaces" not in line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") != "assistant":
            continue
        content = (entry.get("message") or {}).get("content") or []
        for block in reversed(content if isinstance(content, list) else []):
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            # 同一次呼叫碰到多個 worktree（如盤點指令）無法判斷正在做哪個，往前找
            wt = single_worktree(block.get("input"))
            if wt:
                return wt
    return ""

def detect_issue():
    cwd = data.get("cwd") or "."
    if is_linked_worktree(cwd):
        return issue_of(cwd)
    wt = last_worktree_in_transcript(data.get("transcript_path") or "")
    return issue_of(wt) if wt else ""

def read_cache(suffix=""):
    try:
        return open(cache_file + suffix).read().strip()
    except Exception:
        return None

def write_cache(value, suffix=""):
    try:
        os.makedirs(cache_dir, exist_ok=True)
        with open(cache_file + suffix, "w") as f:
            f.write(value)
    except Exception:
        pass

def tab_state_owns_title():
    # tab-state.mjs 的記錄帶狀態前綴時，標題由它管理，本 hook 不改也不清
    state_dir = os.environ.get("TAB_STATE_DIR") or os.path.expanduser("~/.local/state/orca-tab-titles")
    try:
        with open(os.path.join(state_dir, re.sub(r"[^\w.-]", "_", handle)), encoding="utf-8") as f:
            return re.match(r"(?:處理中|待 Retro|待關閉)｜", f.read()) is not None
    except Exception:
        return False

if tab_state_owns_title():
    sys.exit(0)

event = data.get("hook_event_name")
if event == "UserPromptSubmit":
    # 背景任務通知、其他 session 的訊息也會觸發 UserPromptSubmit，不是使用者提示，維持原標題
    if (data.get("prompt") or "").lstrip().startswith(SYSTEM_PROMPT_PREFIXES):
        sys.exit(0)
    prefix = read_cache()
    if prefix is None:
        prefix = detect_issue()
        write_cache(prefix)
    lines = [l.strip() for l in (data.get("prompt") or "").splitlines() if l.strip()]
    text = lines[0][:20] if lines else ""
    write_cache(text, ".text")
elif event == "Stop":
    prefix = detect_issue()
    write_cache(prefix)
    try:
        shown = json.loads(run("terminal", "show", "--terminal", handle, "--json").stdout)
        title = shown["result"]["terminal"]["title"] or ""
    except Exception:
        title = ""
    # 去掉 Orca 狀態符號（如 ◐ ✳）
    text = re.sub(r"^[^\w#/]+\s*", "", title).strip()
    if text == "Claude Code":
        text = read_cache(".text") or ""
elif event == "PostToolUse":
    # 回合中途才碰到 issue worktree 時立即改名；前綴未變就不呼叫 orca
    if is_linked_worktree(data.get("cwd") or "."):
        sys.exit(0)
    wt = single_worktree(data.get("tool_input"))
    prefix = issue_of(wt) if wt else ""
    if not prefix or prefix == read_cache():
        sys.exit(0)
    write_cache(prefix)
    text = read_cache(".text") or ""
else:
    sys.exit(0)

rename(f"{prefix} {text}".strip() if prefix else None)
' "$orca" "$ORCA_TERMINAL_HANDLE"
) >/dev/null 2>&1 &

exit 0
