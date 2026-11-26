# Concurrency: CPU budget for checks and workers

Several repos on one machine (ron-skills, spay2, ...) share its CPUs. Three settings keep their checks and workers from saturating it; the setup report names each one this machine has not set. The numbers below come from a 16-core WSL machine (CoS item 67, measured 2026-11-25): CPU was 96–98% busy at load 67–86, the same `check-contracts` took 14 minutes at load under 20 and 36 minutes over 50, and 59–78% of heavy-check wall time was spent waiting, in the slot queue or on a starved CPU.

The slot count and the per-holder concurrency work together. `heavy-slot.mjs` limits how many heavy checks run at once (default 2 machine-wide); it does not limit how much CPU each one uses. Without a cap, `node --test` starts `availableParallelism() - 1` test processes (15 on 16 cores), so two slot holders alone fill the machine.

## Settings

| Setting | Where it is read | What it limits | Suggested on 16 cores |
| --- | --- | --- | --- |
| `NODE_TEST_CONCURRENCY` | `node-test-guarded.mjs`, which passes it as `--test-concurrency=<n>` unless the caller already passes `--test-concurrency=<n>` (the caller wins); an invalid value prints `WARN NODE_TEST_CONCURRENCY <value> ...` and uses the default | test processes per `node --test` run, so per slot holder | 6 (the default): two holders use about 12 cores and leave about 4 for workers' focused tests and the agents |
| `PILOT_MACHINE_WORKER_CAP` | `pilot-capacity.mjs` (`check` before dispatch, `report` each round) | pilot workers across every repo's coordinator on the machine | 3: of three working workers usually only one or two run heavy tests at the same time |
| `~/.config/orca-heavy-check/slots` | `heavy-slot.mjs` | heavy checks running at once, machine-wide | keep 2 once `NODE_TEST_CONCURRENCY` is in place; drop to 1 (with `HEAVY_CHECK_TIMEOUT=3600` so queued checks do not time out en masse) only as a stopgap while the per-holder cap is not yet deployed |

Set the environment variables in the user-level `~/.claude/settings.json` `env`, which the Bash tool reads (a shell rc file is not read there; see `pilot-capacity.mjs env`). They apply to sessions started afterwards. Scale them with the core count: about `cores / 2.5` for `NODE_TEST_CONCURRENCY`, and `PILOT_MACHINE_WORKER_CAP` so that slots × concurrency plus one worker's focused tests stays near the core count.

## What goes through the slot

Every full run of the repo's check entry goes through `heavy-slot.mjs`, including the one a worker runs by hand for acceptance, not only the pre-commit hook, `land.mjs`, and `pilot-land.mjs`. The simplest way is for the check entry to wrap itself: when `HEAVY_SLOT_HELD` is unset and the run is a full one, it re-runs itself as `node scripts/heavy-slot.mjs run --label <repo>:<use> -- <check entry> <original args>`; inside a slot (`HEAVY_SLOT_HELD` set) it runs directly. ron-skills' `bin/check` does this with label `ron-skills:bin-check`, skipping the slot for `--changed` subsets (the pre-commit hook decides those by size) and under CI. A repo whose check entry runs other parallel suites caps them the same way:

- **Python test shards.** A runner that splits Python tests across shards (spay2's `run-python-tests.py --shards 3`) adds one process per shard on top of the node tests in the same slot. Suggested: 2 shards on 16 cores. The repo changes its own runner; there is no template for it.
- **Gradle.** `org.gradle.workers.max` (4 suggested on 16 cores) in the user-level `~/.gradle/gradle.properties`, and test fork limits in the repo's build, belong to the repo.

## Handing a repo's full checks to CI

`~/.config/orca-heavy-check/repo-slots` sets a per-repo cap, one `<repo> <n>` per line; a repo not listed is capped only by the machine-wide slot count, and without the file nothing changes. A cap above 0 limits how many of that repo's checks hold a slot at once; a repo at its cap does not block the next repo in the priority order. A cap of 0 means the repo's full checks run on its CI instead (ron-skills since 2026-11-26, CoS item 67: it is public, so GitHub Actions is free): `run` prints `SLOT_DELEGATED <label> ci` and exits 76 without running the command, which is neither a pass, a failure, nor a load timeout. `node scripts/heavy-slot.mjs quota <repo>` prints the cap so a check entry can decide before it asks for a slot.

The caller then hands the check to CI. ron-skills' `bin/check` does this for a full run on a clean worktree: `scripts/ci-run.mjs` pushes `HEAD` to a `ci/*` branch and reads the `checks` job of `.github/workflows/checks.yml` on that SHA. A red CI job is a failed check; the caller does not rerun it locally. Only when CI is unavailable (the push fails, no run appears within 5 minutes, the job ends with no steps or as `startup_failure`, it stays queued past 20 minutes, or `gh` itself fails) does the caller rerun with `run --fallback` (or `HEAVY_SLOT_FALLBACK=1`), which ignores the 0 cap and queues as before, behind higher-priority repos and with the same anti-starvation rules. A dirty worktree cannot go to CI, so it falls back at once. `CHECK_FULL=1` on a commit is an explicit request for a local full run and always queues with `--fallback`.

With the cap at 0 the pre-commit hook still runs small subsets (10 test files or fewer) locally without a slot, as before; a larger subset, a fallback to the full suite, or an uncomputable subset runs only the light part (`bin/check --changed --light`: the static steps and at most 10 test files) and prints `CHECK_DELEGATED`. The merge gate does not move: the PR's required checks run the full `bin/check --upstream` on Linux and macOS before `land.mjs` merges. Deleting the repo's line in `repo-slots` restores the local path everywhere.

`stats` counts delegated runs (`delegated=`) and fallbacks (`fallback=`) per label and prints `run_sum` and `wait_sum`, so `stats --label '<repo>:*' --since <time>` over the week before and after setting the cap shows how much slot time the repo gave back.

## Sessions that count against the cap

`pilot-capacity.mjs` counts only the batch members each coordinator reports. Other sessions a coordinator opens that run the full check entry (a tooling fix unit, a `/retro-collect` collector) use the same CPU; until they are recorded in the ledger (ron-skills #622), the coordinator counts them by hand against its share before dispatching.
