---
name: spec-review
description: "Fresh-reader review of a draft spec, once, after the discussion and before the human sees the final version. Use when to-spec or grilling says to, or the user runs /spec-review <spec>; never inside issue-run, issue-pilot, or another unattended run."
---

# Spec review

A spec written at the end of a discussion leans on that discussion: what everyone in the room already knows never makes it onto the page, and the implementer was not in the room. One _fresh reader_, a sub-agent that never saw the discussion, reads the draft with only the files it cites and reports where it cannot follow, where the spec contradicts itself, and what it leaves undecided. You fix the draft, ask the human only what needs their decision, and then show them the final.

**The human is present.** The review ends in questions only the human can answer, so it runs only in a session the human is in: `to-spec`, a `grilling` session, or `/spec-review`. In an issue-run worker, an issue-pilot coordinator, a `/loop`, or any dispatched worker, skip it and say so in one line.

## 1. Build the reading set

- **The spec.** When the draft exists only in this conversation, write it to a temporary file outside the repo (`mktemp -t spec-review.XXXXXX`); when it is already a file or a tracker item, copy its current text there. Findings cite line numbers of this file, so edit this file in step 4 and publish from it.
- **What it cites, one level deep.** Add each repo file the spec names directly: ADRs, the glossary, module READMEs, contracts, other specs. Leave out what those files cite in turn, tracker items, and anything outside the repo; list them for the reviewer as _not provided_.
- **Budget.** The reviewer's whole run aims for about 80k tokens, so keep the reading set at most 8 files and about 150 KB (`wc -c`). For a cited file over 400 lines, pass only the sections the spec cites, by heading. When the set is still over, drop the least-cited files first and add them to _not provided_.

Done when you have the spec file, a list of reading-set paths (each with its section headings when trimmed), and a _not provided_ list.

## 2. Read the repo's Not defects

The repo declares the finding categories it does not want under a fixed heading in its adapter, `## Spec review`, with a `Not defects:` list:

```markdown
## Spec review

Not defects:
- Missing test plan, file boundaries, or phasing: child Issues and the adapter's acceptance section carry them.
- Wording, tone, or formatting preferences.
```

Each bullet is a category, optionally followed by a colon and the reason. Find it with `grep -rn -A 20 '^## Spec review' docs/agents/`. Take the bullets until the next heading; ignore other lines in the section. With no adapter, no such section, or an empty list, use only the defaults in the brief below.

## 3. Dispatch one reviewer

One `Agent` call, `model: sonnet`, a fresh context, in the foreground. Fill in the brief and send it as the prompt:

````markdown
You are a fresh reader: a capable engineer who just joined this project. You know software well; you know nothing about this project beyond the files below, and nothing about the discussion that produced this spec. An implementer will build exactly what the spec says, so anything you cannot follow, the implementer will guess.

Read only, and only these files:
- Spec: <spec path>
- Reading set: <paths, with the sections to read when trimmed>
- Not provided (out of your view): <list>

First, paraphrase. Under **What this proposes** and **How the existing system works, per this spec**, write 2-5 sentences each in your own words. A section you cannot paraphrase is a finding.

Then report findings in exactly three categories:
- **unclear**: a term, step, or rule specific to this project that is neither defined in the spec nor in the reading set, or a description too vague to build from ("handled automatically" with no how).
- **contradiction**: two places that cannot both hold: inside the spec, between the spec and a reading-set file, or one name used for two things.
- **undecided**: a choice the implementer would have to make: an open option, an "if X then maybe Y" left hanging, a value or boundary not given.

Report only what would make an implementer build the wrong thing or stop to ask. These are not defects; leave them out:
- General engineering terms.
- Anything about files in the not-provided list or outside your view: do not guess what they say. Report the spec only when it relies on such a file and gives no summary of what it takes from it.
- <each Not defects bullet from the repo, verbatim>

Before reporting a term as undefined, search the whole spec and the reading set for its definition.

Output the paraphrase, then the findings, most damaging first, at most 15, one block each:

F<n> | L<start>-<end> § <section heading> | <unclear|contradiction|undecided>
Problem: <what you read and why it blocks, quoting the spec briefly>
Fix: <the edit you propose>   (or, when only the spec's owner can choose)   Ask: <the question, with the options you see>

End with one line: `FINDINGS <n>`.
````

Done when the reviewer's report ends in a `FINDINGS` line. Run one round; a second pass is the human's call, not yours.

## 4. Resolve every finding

The reviewer lacks the discussion, so check each finding against it and the files before acting:

- **Settled in the discussion, or a fact you can look up**: edit the spec so the page says it. The reader's confusion is the defect, even when you knew the answer.
- **Wrong paraphrase**: the section misleads; rewrite it until the paraphrase would come out right.
- **Needs the human's decision**: collect it. Ask all of them in one round, in `grilling`'s round format: numbered, each with your recommended answer, worded so "yes" accepts it. Edit the spec with their answers.
- **Noise**: a category the repo's Not defects covers, or a claim the reading set refutes. Reject it with a one-line reason.

**Test-only spec.** When the spec forbids production changes (for example "不改 src/main"), open the production code behind each sub-case yourself: where it reads a clock, a random source, or other system state directly at the point the sub-case depends on, no test-only change can control it, so edit the spec to exclude that sub-case by name, or ask the human to lift the restriction (spay2 #1118: `ongoing()` read `System.nanoTime()` before signing, so only the lookup half was feasible).

Done when every finding is marked fixed, asked and answered, or rejected with its reason.

## 5. Hand over

Show the human the final spec and one tally line (`spec-review: <n> findings, <a> fixed, <b> asked, <c> rejected`), followed by one line per rejected finding. Then continue the flow that called you: `to-spec` publishes the reviewed text.

## Attribution

The fresh-reader role, the paraphrase-first check, and the "you know software, not this project" boundary are rewritten from the Comprehension agent of Google's Elephant-Goldfish Model (<https://github.com/google/elephant-goldfish-model>, `agents/comprehension.md`), licensed under the Apache License 2.0. The categories, the reading-set budget, the Not defects list, and the output format are this skill's own.
