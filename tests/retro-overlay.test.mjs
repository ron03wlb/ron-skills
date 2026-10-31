import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const patch = new URL('../overlays/retro.patch', import.meta.url).pathname;
const upstream = join(process.env.MATT_SKILLS ?? join(homedir(), 'code/skills'), 'skills/engineering/retro');
// pre-commit hook 會匯出 GIT_DIR，git apply 繼承後會套到本 repo（#25）。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

// #73／#76、#74／#75：兩個退役 coordinator 的 retro 各開一張重複單。查重要在開單前做，有沒有收集器都一樣（#95）。
test('retro overlay 在開 tracker Issue 前依候選提到的名稱查開著的 Issue', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'retro-overlay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(upstream, dir, { recursive: true });
  const applied = spawnSync('git', ['apply', patch], { cwd: dir, encoding: 'utf8', env });
  assert.equal(applied.status, 0, applied.stderr);

  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const step = skill.split('\n\n').find(paragraph => paragraph.includes('gh issue list --state open --search'));
  assert.ok(step, 'overlay 沒有查開著 Issue 的段落');
  assert.match(step, /in:title,body/);
  assert.match(step, /gets a comment/);
  assert.match(step, /blocked_by/);
  assert.doesNotMatch(step, /retro-collect\.mjs/, '查重不能只在收集模式裡');
});

// #126：/retro 結束時由該分頁自己切成待關閉；收集模式略過步驟 5，但這一步不能跟著略過。
test('retro overlay 的最後一步呼叫 tab-state 待關閉，一般模式與收集模式都要', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'retro-overlay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(upstream, dir, { recursive: true });
  const applied = spawnSync('git', ['apply', patch], { cwd: dir, encoding: 'utf8', env });
  assert.equal(applied.status, 0, applied.stderr);

  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const steps = skill.split('## Reference')[0].split('\n\n');
  const last = steps.findLast(paragraph => /^\d+\. /.test(paragraph));
  assert.match(last, /node scripts\/tab-state\.mjs 待關閉/);
  assert.match(last, /collect mode/i);
  const collect = steps.find(paragraph => paragraph.includes('**Collect mode.**'));
  assert.match(collect, /tab-state/, '收集模式的段落要指向切成待關閉的那一步');
});
