#!/usr/bin/env python3
"""/issue-pilot 的 git 入口：先驗證目標 checkout 與參數，再以 `git -C` 執行固定的子命令。

`.claude/settings.json` 只放行 `python3 scripts/pilot_git.py:*`。allow rule 寫成 `git -C * <subcommand>` 時，
中間的 `*` 也能吞下 `-c core.sshCommand=…` 這類 git 全域選項（Claude Code 會警告 "allows any option at its *"），
所以路徑與參數改由這裡檢查：主 checkout 只能 fetch 與唯讀查詢，寫入只限 WORKTREE_ROOT 下以 BRANCH_PREFIX 開頭的 worktree。

用法：python3 scripts/pilot_git.py <子命令> <checkout> [參數]
  fetch <checkout>                 git fetch origin
  sync  <worktree>                 git fetch origin && git merge --ff-only origin/<BASE_BRANCH>
  stage <worktree> <a>..<b>        git cherry-pick <a>..<b>
  push  <worktree> <branch>        git push -u origin HEAD:<branch>（branch 須以 BRANCH_PREFIX 開頭）
  rev   <checkout> <rev>           git rev-parse <rev>
  log   <checkout> <range>         git log --oneline <range>
驗證失敗 exit 2，stderr 一行原因；其餘 exit code 與輸出照 git。

範本：複製成專案的 scripts/pilot_git.py，只改下面四個常數；步驟見 ADAPTER.md「Permissions」段。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# 依專案改這四個常數（參考實作：Growth 的 scripts/pilot_git.py）。
MAIN_CHECKOUT = Path("/home/ron/code/<repo>")
WORKTREE_ROOT = Path("/home/ron/orca/workspaces/<repo>")
BRANCH_PREFIX = "feature-ron-"
BASE_BRANCH = "main"

READ_ONLY = {"fetch", "rev", "log"}
# 參數不得以 `-` 開頭，否則又能夾帶 git 選項（例如 log --output=<檔>）。
REV = re.compile(r"[A-Za-z0-9_./^~{}@-]+")
BRANCH = re.compile(rf"{re.escape(BRANCH_PREFIX)}[A-Za-z0-9._/-]+")
ARITY = {"fetch": 0, "sync": 0, "stage": 1, "push": 1, "rev": 1, "log": 1}


class Refused(Exception):
    pass


def resolve_checkout(command: str, raw: str) -> Path:
    """主 checkout 只給唯讀子命令；其他一律須為 WORKTREE_ROOT 的直接子目錄且名稱以 BRANCH_PREFIX 開頭。"""
    path = Path(raw).resolve()
    if path == MAIN_CHECKOUT.resolve():
        if command not in READ_ONLY:
            raise Refused(f"{command} 不能在主 checkout 執行（主 checkout 的 Git 寫入需逐次批准）")
        return path
    if path.parent != WORKTREE_ROOT.resolve() or not path.name.startswith(BRANCH_PREFIX):
        raise Refused(f"{raw} 不是主 checkout，也不是 {WORKTREE_ROOT}/{BRANCH_PREFIX}* worktree")
    return path


def git_args(command: str, args: list[str]) -> list[list[str]]:
    """子命令與參數 → 依序執行的 git 參數列（不含 `git -C <path>`）。"""
    if command not in ARITY or len(args) != ARITY[command]:
        raise Refused(f"用法錯誤：{command} {' '.join(args)}".rstrip())
    for arg in args:
        if arg.startswith("-") or not REV.fullmatch(arg):
            raise Refused(f"參數不合法：{arg}")
    if command == "fetch":
        return [["fetch", "origin"]]
    if command == "sync":
        return [["fetch", "origin"], ["merge", "--ff-only", f"origin/{BASE_BRANCH}"]]
    if command == "stage":
        if ".." not in args[0]:
            raise Refused(f"stage 需要 <a>..<b> 範圍：{args[0]}")
        return [["cherry-pick", args[0]]]
    if command == "push":
        if not BRANCH.fullmatch(args[0]):
            raise Refused(f"只能推 {BRANCH_PREFIX}* branch：{args[0]}")
        return [["push", "-u", "origin", f"HEAD:{args[0]}"]]
    if command == "rev":
        return [["rev-parse", args[0]]]
    return [["log", "--oneline", args[0]]]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    command, raw, *args = argv
    try:
        checkout = resolve_checkout(command, raw)
        steps = git_args(command, args)
    except Refused as refused:
        print(f"拒絕：{refused}", file=sys.stderr)
        return 2
    for step in steps:
        code = subprocess.run(["git", "-C", str(checkout), *step]).returncode
        if code:
            return code
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
