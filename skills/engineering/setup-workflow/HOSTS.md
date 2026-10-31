# Hosts: gh / glab reference

The tracker host and the code host of a repo, and the `gh` (GitHub) or `glab` (GitLab) command for each tracker and delivery action. `/setup-workflow`'s Host station (`detect.mjs --host`) decides the hosts; the adapter's **Tracker** and **Delivery** sections are written from the table below, and pilot's Counterpart reads the same data. The data scripts read is [`templates/lib/hosts.mjs`](templates/lib/hosts.mjs) (`COMMANDS`, `CI_FILES`); this file is its human copy, and `tests/setup-workflow-host.test.mjs` fails when a row here differs from it. Change both together, and re-run the row's `--help` check below.

## Hosts

There are two hosts, recorded separately, and they may differ (Issues on GitHub, code on a self-hosted GitLab):

- **Tracker host**: from `docs/agents/issue-tracker.md`: it names `glab` → `gitlab`, `gh` → `github`, neither → `local` (Markdown Issues in the repo). Before that file exists, the Host station infers it from `origin`. A tracker on a different kind of host than the code takes its hostname from the first URL of that kind in the file; without one, GitHub falls back to `github.com` and GitLab to `glab`'s default host.
- **Code host**: from the `origin` URL: `github.com` or a hostname containing `github` (GitHub Enterprise) → `github`; any other network host → `gitlab`, including a self-hosted instance over plain http or an IP (`http://192.168.200.202/spay/spay2`); no `origin`, or one that is a local path or `file://` → `local`. Only GitHub and GitLab are supported: another hosting service (Bitbucket, Codeberg) is classified `gitlab` and gets a wrong `glab` stop, so confirm the code host with the human before trusting the CLI line.

A `local` side needs no CLI, and a `local` code host has no remote delivery (no PR/MR, no remote CI). Every other host needs its CLI installed and logged in to that hostname (`<cli> auth status --hostname <host>` exits 0); the Host station stops otherwise and prints the install or `auth login` command.

## Commands

`<…>` is a value to substitute. Run tracker commands in the repo's checkout, which both CLIs infer the project from; for another repo, use the **Comment in another repo** row's flag.

| Action | GitHub | GitLab | Notes |
| --- | --- | --- | --- |
| Read an Issue with comments | `gh issue view <n> --json number,title,body,labels,comments` | `glab issue view <n> --comments` | `gh issue view --comments` without `--json` prints nothing outside a tty |
| List ready Issues | `gh issue list --state open --label ready-for-agent --json number,title,labels` | `glab issue list --label ready-for-agent -O json` | `glab issue list` takes `-O` for JSON; `-F` there is `--output-format` (details, ids, urls) |
| Create an Issue | `gh issue create --title <title> --body-file <file>` | `glab issue create --title <title> --description-file <file> --yes` | |
| Comment on an Issue | `gh issue comment <n> --body-file <file>` | `glab issue note <n> -m "$(cat <file>)"` | `glab issue note` has no `--body-file` or `-F`; only `-m`/`--message` |
| Change labels | `gh issue edit <n> --add-label <add> --remove-label <remove>` | `glab issue update <n> --label <add> --unlabel <remove>` | |
| Assign yourself | `gh issue edit <n> --add-assignee @me` | `glab issue update <n> --assignee +<username>` | `glab` has no `@me`: `<username>` is `glab api user`'s `username`; a bare username replaces the assignees, `+` adds |
| Close an Issue | `gh issue close <n> --comment <text>` | `glab issue close <n>` | `glab issue close` takes no comment: post it with **Comment on an Issue** first |
| Create a label | `gh label create <name>` | `glab label create --name <name>` | |
| Comment in another repo | `gh issue comment <n> --repo <owner>/<repo> --body-file <file>` | `glab issue note <n> -R <owner>/<repo> -m "$(cat <file>)"` | `--repo` and `-R` are on every issue and PR/MR subcommand; `glab -R` also takes `group/subgroup/repo` or a full URL |
| Open a PR / MR | `gh pr create --base <base> --head <branch> --title <title> --body-file <file>` | `glab mr create --target-branch <base> --source-branch <branch> --title <title> --description-file <file> --yes` | |
| Read a PR / MR | `gh pr view <pr> --json state,headRefOid,mergeCommit` | `glab mr view <pr> -F json` | `glab mr view` and `glab issue view` take `-F` for JSON |
| Wait for CI | `gh pr checks <pr> --watch` | `glab ci status --branch <branch> --wait` | `glab ci status` JSON output does not combine with `--wait` |
| Merge | `gh pr merge <pr> --merge --match-head-commit <sha>` | `glab mr merge <pr> --sha <sha> --auto-merge=false --yes` | `glab mr merge` defaults to `--auto-merge` (merge when the pipeline passes); `=false` merges now. Both refuse when the head moved off `<sha>` |
| Login status | `gh auth status --hostname <host>` | `glab auth status --hostname <host>` | the Host station's check |
| Log in | `gh auth login --hostname <host>` | `glab auth login --hostname <host>` | the Host station's fix |

CI configuration lives in `.github/workflows/` (one `.yml` per workflow) on GitHub and in `.gitlab-ci.yml` at the repo root on GitLab.

## `--help` check record

Checked 2026-10-31 for #89. `gh`: `gh version 2.92.0 (2026-04-28)` on macOS, each subcommand's `--help` run locally. `glab`: not installed on the checking machine, so the record is glab v1.126.0's `docs/source/<command>.md` at that tag in `gitlab-org/cli`, which `make gen-docs` generates from the same command definitions `--help` prints (each page says so). Re-run `<command> --help` when bumping either CLI.

The assignee flags were added for #108 the same way (`gh issue edit --help` locally, glab v1.126.0's `docs/source/issue/update.md`). `templates/issue-pool.mjs` also reads through `glab api` (its `docs/source/api/_index.md`: `graphql`, the `:id` placeholder, `--hostname`, `--paginate`, `--output ndjson`, `-X DELETE`; that page says `--paginate` merges REST arrays into one, but v1.126.0's `internal/commands/api/api.go` writes each page as is, so a multi-page read needs `--output ndjson`), on GitLab's GraphQL work item widgets and REST issue notes.

| Command | Flags confirmed |
| --- | --- |
| `gh issue view --help` | `-c, --comments`, `--json fields`, `-R, --repo` |
| `gh issue list --help` | `-s, --state {open\|closed\|all}`, `-l, --label`, `--json fields` |
| `gh issue create --help` | `-t, --title`, `-F, --body-file`, `-l, --label` |
| `gh issue comment --help` | `-F, --body-file`, `-R, --repo [HOST/]OWNER/REPO` |
| `gh issue edit --help` | `--add-label`, `--remove-label`, `-F, --body-file`, `--add-assignee` (`@me` assigns yourself) |
| `gh issue close --help` | `-c, --comment` |
| `gh label create --help` | `<name>` positional, `-R, --repo` |
| `gh pr create --help` | `-B, --base`, `-H, --head`, `-t, --title`, `-F, --body-file` |
| `gh pr view --help` | `--json fields`, `-c, --comments` |
| `gh pr checks --help` | `--watch`, `--json fields` |
| `gh pr merge --help` | `-m, --merge`, `--match-head-commit SHA` |
| `gh auth status --help` | `-h, --hostname` |
| `gh auth login --help` | `-h, --hostname` |
| `glab issue view --help` | `-c, --comments`, `-F, --output text\|json`, `-R, --repo` |
| `glab issue list --help` | `-l, --label`, `-O, --output text\|json`, `-F, --output-format details\|ids\|urls` |
| `glab issue create --help` | `-t, --title`, `--description-file`, `-y, --yes` |
| `glab issue note --help` | `-m, --message` only (plus `--attach`, `--internal`); no `--body-file`; inherits `-R, --repo` (`OWNER/REPO`, `GROUP/NAMESPACE/REPO`, or the full URL or Git URL; rechecked for #79, which passes the project URL so a self-hosted http host such as `http://192.168.200.202/spay/spay2` resolves) |
| `glab issue update --help` | `-l, --label`, `-u, --unlabel`, `-a, --assignee` (`+` adds, `!`/`-` removes, otherwise replaces) |
| `glab issue close --help` | `<id>` positional and `-R, --repo` only; no comment flag |
| `glab label create --help` | `-n, --name`, `-d, --description` |
| `glab mr create --help` | `-b, --target-branch`, `-s, --source-branch`, `-t, --title`, `--description-file`, `-y, --yes` |
| `glab mr view --help` | `-F, --output text\|json`, `-c, --comments` |
| `glab ci status --help` | `-b, --branch`, `-w, --wait`, `-F, --output` (not with `--wait`) |
| `glab mr merge --help` | `--sha`, `--auto-merge` (default true), `-y, --yes` |
| `glab auth status --help` | `--hostname`, `-a, --all` |
| `glab auth login --help` | `--hostname` |
