# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below). Without sub-issues, put `Part of #<parent>` at the top of the child body.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue of a parent**). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh issue edit <child> --add-blocked-by <blocker>` (`#number`; verified on `gh` 2.101). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: `gh issue list --state open --search 'parent-issue:<owner>/<repo>#<map> -is:blocked'` lists the map's open children without an open blocker (where sub-issues aren't enabled, scope to the map's task list and drop any with an open issue in the `Blocked by` line); then drop any with an assignee; first in map order wins.

## 母單

母單是範圍已定、子單已拆好的 issue：它只把子單分組，不派工、不驗收，開關跟著子單走。和 **Map**（`wayfinder:map`）不同：Map 還在探索，子票會陸續長出來；母單在建立時就拆完了。

- **辨識**：有 sub-issue（`sub_issues_summary.total > 0`）的 issue 就是母單，掛 `parent` label、不掛任何 triage label（[triage-labels.md](triage-labels.md#parent-label)）。
- **上游行為**：`/to-spec` 給 spec issue 掛 `ready-for-agent`；`/to-tickets` 把子單掛成該 spec 的 sub-issue、各掛 `ready-for-agent`，不動母單。所以 spec 一拆成子單，母單和子單都帶 `ready-for-agent`。本 repo 不改這兩個 skill，改由 pilot 的 Pool 規則排除母單、Reconcile 整理母單的 label（[issue-run.md](issue-run.md) 的 **Pool**、**Probe**），Close 在子單全部結束後關掉母單（**Close**）。
- **檢視**：
  - 可開工：`gh issue list --search 'is:open label:ready-for-agent -is:blocked'`
  - 母單：`gh issue list --search 'is:open label:parent'`
  - 某一組：`gh issue list --state all --search 'parent-issue:ron03wlb/ron-skills#<n>'`
- **關係總覽**：一次列出每張開著的 issue 的 parent、子單進度與相依：

  ```bash
  gh api graphql -f query='{repository(owner:"ron03wlb",name:"ron-skills"){issues(first:100,states:OPEN){nodes{number title parent{number} subIssuesSummary{total completed} blockedBy(first:10){nodes{number state}} blocking(first:10){nodes{number}}}}}}'
  ```
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
