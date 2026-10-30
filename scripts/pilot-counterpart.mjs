#!/usr/bin/env node
// pilot 的 Close 關單前要到成員 Issue 的跨 repo 對應單留言交接（#53）；對應單寫在本文，如「spay2 對應單：spay/spay2#692」。
// 用法：gh issue view <n> --json body --jq .body | node scripts/pilot-counterpart.mjs
// stdout：每張對應單一行 `COUNTERPART <owner>/<repo>#<n>`（依出現順序、去重；code block、code span 與「」引號內不算），沒有對應單時不輸出；exit 0。
import { readFileSync } from 'node:fs';

// code block、code span 與「」裡的是引用（如 #53 引用 #30 的原文與 fixture），不是這張 Issue 的對應單。
const body = readFileSync(0, 'utf8').replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '').replace(/「[^」\n]*」/g, '');
const refs = [...body.matchAll(/對應單[：:]\s*([\w.-]+\/[\w.-]+#\d+)/g)].map(([, ref]) => ref);
for (const ref of new Set(refs)) console.log(`COUNTERPART ${ref}`);
