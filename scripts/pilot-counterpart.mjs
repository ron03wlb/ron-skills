#!/usr/bin/env node
// pilot 的 Close 要到成員 Issue 的跨 repo 對應單留言交接；對應單寫在本文，如「app 對應單：acme/app#7」。
// 用法：gh issue view <n> --json body --jq .body | node scripts/pilot-counterpart.mjs
// stdout：每張對應單一行 `COUNTERPART <owner>/<repo>#<m>`（依出現順序、去重；整句在 code block、code span 或「」引號內的不算），沒有對應單時不輸出；exit 0。
import { readFileSync } from 'node:fs';

// 整句「對應單：ref」在 code block、code span 或「」裡是引用（如引用別張 Issue 的原文或測試 fixture），不是這張 Issue 的對應單；
// 只有 ref 包在 code span 裡（對應單：`acme/app#7`）仍算。
const body = readFileSync(0, 'utf8').replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*對應單[^`\n]*`/g, '').replace(/「[^」\n]*對應單[^」\n]*」/g, '');
const refs = [...body.matchAll(/對應單[：:]\s*`?([\w.-]+\/[\w.-]+#\d+)/g)].map(([, ref]) => ref);
for (const ref of new Set(refs)) console.log(`COUNTERPART ${ref}`);
