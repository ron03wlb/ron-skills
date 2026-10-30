// scripts/ 裡從 setup-workflow 正本複製來的副本必須與正本逐位元組相同：要改就改正本，再複製過來。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const COPIES = ['orca-session-send.mjs', 'claude-hook-language.mjs', 'orca-worktree-create.mjs'];
const read = path => readFileSync(new URL(`../${path}`, import.meta.url));

for (const name of COPIES) {
  test(`scripts/${name} 與 setup-workflow 正本相同`, () => {
    assert.ok(read(`scripts/${name}`).equals(read(`skills/engineering/setup-workflow/templates/${name}`)),
      `scripts/${name} 與正本不同：改 skills/engineering/setup-workflow/templates/${name}，再複製到 scripts/`);
  });
}
