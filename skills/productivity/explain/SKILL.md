---
name: explain
description: Explain confusing issues and decision questions, with causes, alternatives, and expected effects. Read-only, in Traditional Chinese by default.
disable-model-invocation: true
---

# Explain

Help the user understand confusing bugs, requirements, design tradeoffs, or questions an agent is asking them. Explain in plain language; leave decisions and action to the user. This is read-only: do not implement fixes, edit files, run mutating experiments, or choose an option for the user. No report file, glossary, or ADR is required.

## 1. Identify the problems

Use the target the user supplies. If omitted, resolve it from the preceding message and outstanding questions that need the user's reply or decision. Ask for clarification only when insufficient context prevents identifying or understanding any actual target.

When there are multiple problems, consolidate related or duplicate questions, distinguish separate problems, and identify their dependencies. Cover all of them together rather than asking the user to pick one. Assign each a stable short label, such as P1 and P2, to use throughout the explanation.

Finish with an identified target or labelled set of problems, including any relationships between them.

## 2. Investigate once, in fresh context

Use the harness's native delegation mechanism to launch one fresh-context, read-only subagent for scoped investigation and synthesis of all identified problems. Send only the relevant problem statements, constraints, short excerpts, and file paths or source pointers. Do not fork or send the full conversation.

Give the subagent this investigation contract:

- Read the supplied materials and narrowly relevant repository evidence. Consult external primary sources only when required and available.
- Use read-only inspection. Separate confirmed facts from suspected causes, and explicitly label unknowns or unavailable evidence.
- For every problem, identify feasible alternatives, meaningful tradeoffs, dependencies, and expected effects. Include a short concrete example that makes the issue understandable.
- Return a compact summary of at most 600 words, covering every problem label with compact source pointers. Keep raw logs and large transcripts child-side, out of the parent context; write no report file.

If subagents are unsupported or unavailable, briefly disclose the limitation and do the scoped reading directly. This fallback is already authorized; do not ask permission.

Finish when each problem has an evidence-backed explanation or explicitly labelled gaps, alternatives, and expected effects. The parent uses the returned summary, rather than repeating the investigation.

## 3. Present the explanation

Write in Traditional Chinese by default, honoring any explicitly requested language. Keep these four headings exactly as written and in this order, even when another language is requested:

## 問題情境

Describe what is happening, what the user needs to understand or decide, and the relevant confirmed facts.

## 為甚麼會有問題

Explain why it matters and the causal mechanism. Distinguish confirmed facts from suspected causes and explicitly label unknowns. Do not turn a plausible cause into a diagnosis.

## 有什麼解決方案

Offer feasible alternatives with meaningful tradeoffs, constraints, and dependencies. Leave the choice to the user; do not auto-select or execute a solution.

## 解決後的結果

Describe the expected effects of the alternatives, including remaining costs, risks, and uncertainties. These are conditional expectations, not claims that a fix has been applied or verified.

Under each heading, give 2 to 4 concise bullets per problem. For multiple problems, group bullets under the same short problem labels in all four sections, and show dependencies where relevant. Define jargon locally where it appears and include a short concrete example for each problem. Cite compact file paths, line references, or source links beside the claims they support within these sections. Keep the user's explanation in the chat, not in a new questionnaire or an investigation transcript.
