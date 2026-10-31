---
name: setup-workflow
description: "Import the ron-skills delivery workflow into a repo: detect its level (L0–L3) and extensions, recommend the next level, then write the tracker, label, domain-doc and adapter setup and copy the canonical scripts after the human confirms. `/setup-workflow health` runs the health check on an imported repo instead: it reports mislabelled levels, copies that diverge from the canonical scripts, and hidden cross-repo paths, and writes nothing."
disable-model-invocation: true
---

# Setup workflow

Bring the target repo (the cwd, or the path in `$ARGUMENTS`) one **level** up the ron-skills delivery workflow: L1 basic, L2 gates, L3 resident pilot, as the guide at `docs/workflow/` in ron-skills defines them. Everything is **present first, write after the human confirms**: steps 1–3 only read; step 4 asks once; steps 5–7 write.

With `health` as the first word of `$ARGUMENTS`, run only the [Health check](#health-check) on the target repo (the path after it, or the cwd) and skip the steps below.

`<skill>` below is this skill's directory (`readlink -f ~/.claude/skills/setup-workflow`); `<ron-skills>` is the repo that holds it (`git -C <skill> rev-parse --show-toplevel`). Each script documents its usage and output lines in its header comment.

## Steps

1. **Detect.** Run `node <skill>/scripts/detect.mjs <repo>`. Each `SIGNAL` line is one level signal with its evidence; `MISSING` lists the unmet signals per level; the last line is `LEVEL <Ln>`.

   | Level | Signals (all of the previous level, plus) |
   | --- | --- |
   | L0 | no tracker setup, or no Issue delivery (`docs/agents/issue-run.md` missing) |
   | L1 | `tracker`: `docs/agents/issue-tracker.md`; `adapter`: `docs/agents/issue-run.md`; `check`: its `## Checks` names one command that exists (before the adapter exists: `bin/check`, `npm run check` or `make check`) |
   | L2 | `integration`: an `integration` branch; `hook`: a pre-push (or, second best, pre-commit) hook that runs the check entry; `worktrees`: Issue-numbered branches in worktrees or merges |
   | L3 | `pilot`: the adapter has `## Pilot`; `pilotCommits`: a `pilot/stage-*` or `stage batch-*` commit in the last 90 days |

   When `check` is missing, stop here and write nothing: the single check entry comes first, built by the human (`docs/workflow/03-level1.md` step 2); rerun `/setup-workflow` once it exists. Otherwise done when you hold the level and every signal's evidence. A `hook` met by pre-commit carries a note: keep it in the findings as a gap, since only pre-push checks the SHA being pushed.

2. **Extensions.** The same run prints one `EXTENSION` line per extension: the detection evidence, the adapter section to fill, and the templates to bring. Confirm each against the repo (read the evidence files) and drop false positives.

   | Extension | Signal | Adapter section | Templates |
   | --- | --- | --- | --- |
   | `tracker` | `docs/agents/issue-tracker.md` names `gh` (GitHub), `glab` (GitLab), or neither (local Markdown); without it, `origin`'s host is the hint | Tracker | — |
   | `gated` | `*.sql`, a `migrations/` or `changelog/` dir, or an adapter `## Gated tickets` | Gated tickets: the human-only steps on a shared target (SQL, data repair), their handoff evidence | — |
   | `externalEnv` | a compose file, or `testcontainers` in a build manifest | Checks (the env the suite needs) and Stops (the stop code when the env is unreachable) | — |
   | `multiModule` | build manifests in two or more directories | Checks: which tests to run per touched module | — |
   | `customTriage` | a project skill under `.claude/skills/` named for triage, grading or refining | Readiness: that skill replaces `/triage` | — |
   | `codex` | `.codex/`, or Codex named in `AGENTS.md` or the adapter | Review, and the implementer when Codex builds tickets | `run-codex-review.mjs` |

   Done when every extension is confirmed present or absent, each with its evidence.

3. **Recommend.** The target is exactly one level above the detected one (`RECOMMEND` line); a repo at L3 gets no new level and goes straight to step 4 with only its extensions and template gaps. Jump further only when the human explicitly asks, and then list every unmet signal of each level skipped (the `MISSING` lines) as conditions still owed. Pick the templates for the target level and the confirmed extensions from [Templates](#templates). Done when you have the target level, the adapter sections to fill, and the template list.

4. **Confirm.** Present in one message: detected level with evidence, extensions with evidence, the target level, every file you will write or change (the tracker, label and domain-doc files, `docs/agents/issue-run.md` sections, `scripts/` copies, `.claude/settings.json` hooks), and the output of `node <skill>/scripts/copy-templates.mjs <repo> --dry-run <template>...`. Ask the human to confirm or adjust. Done when the human confirmed; with no confirmation, stop here having written nothing.

5. **Tracker, labels, domain docs.** Read `setup-matt-pocock-skills`'s SKILL.md (`readlink -f ~/.claude/skills/setup-matt-pocock-skills`) and carry out its sections yourself within this run, skipping any whose output already exists and matches; the human answers its questions here, never in a second command. Then create the five triage labels on the tracker (`docs/workflow/03-level1.md` step 2 has the commands). Done when `docs/agents/issue-tracker.md`, `triage-labels.md` and `domain.md` exist and the tracker's read command prints an Issue from the agent's Bash.

6. **Adapter.** Write `docs/agents/issue-run.md` from `<ron-skills>/skills/engineering/issue-run/ADAPTER.md` as the skeleton: fill the sections the target level needs (L1: Tracker, Readiness, Checks, Candidate and acceptance, Evidence and closing; L2: Worktrees and checkpoint and Review too; L3: Pilot and Permissions) plus each confirmed extension's section, in English, with commands that exist in this repo. Keep an existing adapter's sections and fill only the gaps. Its `## Checks` names the check entry step 1 found. Done when every command the adapter names runs from the repo root, and every Pilot command was run once here.

7. **Copy templates.** Run `node <skill>/scripts/copy-templates.mjs <repo> <template>...`. It copies each template with its runtime dependencies and tests into `scripts/` and records each copy's template path, the last ron-skills commit that changed that template, and the copy's sha256 in `docs/agents/workflow-templates.json`; it refuses a template with uncommitted changes, since the recorded commit would not match the content. Exit 3 (`CONFIRM_OVERWRITE`) means an existing file differs: show the human the printed diff, and rerun with `--yes` only after they confirm. Wire each copy as its row in [Templates](#templates) says, and add the copied tests to the repo's check entry. Done when `copy-templates.mjs <repo> --verify` prints `VERIFIED <n>` and the check entry exits 0.

8. **Report.** Report the detected and new level, every file written, the commands with exit codes, and the gaps left: unmet signals of the target level and declined extensions.

## Health check

For a repo already imported: compare its adapter, docs and copies with what it actually runs, and report the gaps. It only reads; write nothing, even for a gap with an obvious fix.

1. Run `node <skill>/scripts/health.mjs <repo>`. Each gap is one `FINDING <kind> ...  # <evidence>` line (file:line, or the manifest with its recorded commit and the sha256s); the last line is `HEALTHY` (exit 0) or `FINDINGS <n>` (exit 1). A file it cannot read while scanning is skipped with a `health: 略過讀不到的 <path>：<code>` line on stderr. On exit 2, with no last line, the check did not run: a flag was passed, the target is not a git repo, or `detect.mjs` failed; report its stderr and stop.

   | Kind | Gap | Handling to recommend |
   | --- | --- | --- |
   | `level` | a non-table line of a tracked or unignored Markdown file mentions exactly one level and names this repo (in the adapter, saying 等級 or level is enough), and that level differs from the one `detect.mjs` finds | correct the doc to the detected level, citing the `SIGNAL` evidence |
   | `divergence canonical-newer` | the copy still matches `workflow-templates.json`, but the canonical script has changed since | overwrite with `copy-templates.mjs <repo> --yes <template>` once the human confirms |
   | `divergence local-modified` | the copy no longer matches the recorded sha256 | carry the change back to the canonical script in ron-skills first |
   | `divergence both-modified` | both of the above; the indented diff (copy → canonical) follows the line | show the diff and leave the decision to the human |
   | `divergence stale-record` | the copy and the canonical script are identical, but neither matches the recorded sha256 | rerun `copy-templates.mjs <repo> <template>` to refresh the record |
   | `divergence unreadable` | the manifest itself, or the copy or canonical script an entry names, cannot be read (permissions) | fix the permissions and rerun the check |
   | `divergence missing-copy`, `missing-canonical`, `invalid-entry`, `invalid-manifest` | the manifest records a copy or canonical path that no longer exists or is not a file, has an entry without `template` or `sha256`, or is not a file holding a valid JSON object with an object `copies` | recopy, or drop the entry, as the human decides |
   | `cross-repo` | the adapter, `.claude/settings.json`, `scripts/`, `bin/` or the git hooks use an absolute home path into another repo | copy the file into this repo (as a template when it is generic), or pass the path in through an env var |

2. **Report.** The `level` and `cross-repo` rules match text, so read each finding's evidence line and drop a false positive (a repo name that is also a common word, a path in an example, a `~` path inside shell quotes such as `"~/x"` or `'~/x'`, which bash does not expand) with the reason. List each remaining finding with its evidence and the handling above, every file the stderr says was skipped as not checked, then the script's last line verbatim. Done when every finding is listed or the run printed `HEALTHY`.

## Templates

Canonical scripts in `<skill>/templates/`. A row's level is the lowest level that brings it.

| Template | Level or extension | Wire-up |
| --- | --- | --- |
| `check-markdown-links.mjs`, `check-text-encoding.mjs`, `check-secrets.mjs` | L1 | steps in the check entry |
| `claude-hook-language.mjs` | L1, when the repo's agent rules require a non-English user-facing language | `.claude/settings.json` `Stop`, `PostToolUse`, `PostToolUseFailure` |
| `node-test-guarded.mjs` | L1, Node test suites | the check entry runs tests through it |
| `claude-hook-git-bypass.mjs` | L2 | `PreToolUse` matcher `Bash` |
| `check-claude-settings.mjs` | L2 | a step in the check entry |
| `report-push-scope.mjs` | L2 | the pre-push hook |
| `concurrent-edits.mjs`, `inflight-overlap.mjs`, `integration-status.mjs` | L2 | named in the adapter's Worktrees and Pilot steps |
| `adr-next.mjs` | L2, repos with `docs/adr/` | named in the repo's ADR rules |
| `claude-hook-main-checkout.mjs` | L3, always | `PreToolUse` matcher `Edit\|Write\|Bash`: blocks writes (Bash: `sed -i`, `perl -i`, `>`/`>>`, `tee` targets; `$VAR`s expand from assignments in the same command or the environment, and unresolvable ones are skipped) that would dirty the main checkout's `git status` (tracked files and new files that are not gitignored) of the project's own repo (`$CLAUDE_PROJECT_DIR`), which stop the pilot's Probe from merging |
| `tab-state.mjs`, `claude-hook-tab-state.mjs` (bring `orca-session-send.mjs` with them) | L1, with Orca | the hook on `.claude/settings.json` `PostToolUse` matcher `Bash` and `Stop`; the adapter's Tab state section names `node scripts/tab-state.mjs <state>` |
| `orca-worktree-create.mjs`, `orca-session-send.mjs`, `orca-session-split.mjs` | L3, with Orca | the adapter's Dispatch and Handoff lines |
| `pilot-handoff.mjs` | L3, with Orca | the adapter's Pilot Handoff line; pass `--held-check <command>` when the project has an "integration merge in progress" check |
| `issue-pool.mjs` | L3, GitHub trackers | the adapter's Pilot Pool line (list the buckets, pick `ready` in order) and Dispatch line (`claim <n>` before each member) |
| `pilot-register.mjs`, `pilot-decision.mjs`, `pilot-request.mjs`, `pilot-hold.mjs`, `pilot-sources.mjs` | L3 | the adapter's Pilot **Sessions**, **Sources**, and **Decisions, requests, hold** lines; their commands and result lines are in [PILOT-STORE.md](../issue-pilot/PILOT-STORE.md#canonical-scripts) |
| `pilot-probe.mjs`, `pilot-dispatch.mjs` | L3, with Orca | the adapter's Pilot **Probe** and **Dispatch** lines; pass `--integration <branch>` when the integration branch is not `pilot/integration` (and `--main <branch>` to the probe when the main branch is not `main`); put the project's Bare guard beside them as `scripts/pilot-unbare.sh` when Orca runs under WSL. Commands and result lines are in [PILOT-STORE.md](../issue-pilot/PILOT-STORE.md#canonical-scripts) |
| `pilot-counterpart.mjs` | L3, when Issues name cross-repo counterparts (`對應單：<owner>/<repo>#<m>`) | the adapter's Pilot Close step (or the Pilot line it points to) |
| `run-codex-review.mjs` | `codex` | the adapter's Review |
