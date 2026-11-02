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

// #126：/retro 結束時由該分頁自己切成待關閉；收集模式略過步驟 5、6，但這一步不能跟著略過。
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

// #106：收集模式綁在 `scripts/retro-collect.mjs` 與 Orca 分頁點名，只有退役 coordinator 用得到，候選也只寫在本機檔。
// 改成任何 session 都把候選開成一張 `retro-candidates` Issue，不自己實作，另一台機器也看得到（ADR 0003）。
test('retro overlay 收集模式：每個 session 把候選開成一張 retro-candidates Issue，不實作', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'retro-overlay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(upstream, dir, { recursive: true });
  const applied = spawnSync('git', ['apply', patch], { cwd: dir, encoding: 'utf8', env });
  assert.equal(applied.status, 0, applied.stderr);

  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const step = skill.split('\n\n').find(paragraph => paragraph.includes('**Collect mode.**'));
  assert.ok(step, 'overlay 沒有 Collect mode 段落');
  assert.doesNotMatch(step, /retro-collect\.mjs|--role/, '收集模式不能再依賴收集腳本');
  // #156：handle 只是給 /retro-collect 收完關分頁的記錄，沒有 Orca 也照樣開單。
  assert.match(step, /starts with an `Orca: <handle>` line when `ORCA_TERMINAL_HANDLE` is set/);
  assert.match(step, /one Issue labelled `retro-candidates`/, '候選清單不能掛 retro：pilot 會把 retro 單當一般 Issue 派出去');
  assert.match(step, /Implement nothing/);
  assert.match(step, /\/retro-collect/);
  assert.match(step, /Tracker duplicates/, '開單前要照查重段落');
  assert.match(step, /\*\*Retro collect\*\* entry/, '沒有收集器的 repo 不能進收集模式，否則候選沒人收');
  const dedupe = skill.split('\n\n').find(paragraph => paragraph.includes('**Tracker duplicates.**'));
  assert.doesNotMatch(dedupe, /`retro` Issue in collect mode/, '收集模式開的是 retro-candidates，不是 retro');
});

// #293：spay2 選本機檔案（G77），它的收集指令還會回 NORMAL（不是退役 coordinator 就照常實作），所以開單不能是唯一路線。
test('retro overlay：條目宣告 Collect command 時照它的第一行走路線，不開 retro-candidates Issue', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'retro-overlay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(upstream, dir, { recursive: true });
  const applied = spawnSync('git', ['apply', patch], { cwd: dir, encoding: 'utf8', env });
  assert.equal(applied.status, 0, applied.stderr);

  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const collect = skill.split('\n\n').find(paragraph => paragraph.includes('**Collect mode.**'));
  assert.match(collect, /declares none of those lines/, '三行都沒宣告才走開單的收集模式');
  assert.ok(skill.indexOf('**Declared collect.**') < skill.indexOf('**Collect mode.**'), '先判斷宣告完不完整：只宣告一部分時，照順序讀不能先開單才停');
  assert.match(collect, /With no \*\*Retro collect\*\* entry at all/);
  const declared = skill.split('\n\n').find(paragraph => paragraph.includes('**Declared collect.**'));
  assert.ok(declared, 'overlay 沒有 Declared collect 段落');
  assert.match(declared, /opens no `retro-candidates` Issue/);
  assert.match(declared, /format the entry states/, 'spay2 的檔案首行有固定格式，少了它 --close 關不到分頁');
  assert.match(declared, /first line/, 'spay2 的第二行是換待關閉的提示，只能讀第一行');
  assert.match(declared, /`COLLECT <file>`[^.]*implement nothing/);
  assert.match(declared, /`NORMAL`[^.]*implement/);
  assert.match(declared, /any other first line[^.]*stop/i);
  assert.match(declared, /Step 7 runs once/);
  assert.match(declared, /`Roster command:`[^.]*`Close command:`[^.]*stop/, '只宣告一部分會寫一邊讀另一邊，要停下');
  assert.doesNotMatch(declared, /retro-collect\.mjs|--role/, 'overlay 不寫死專案的腳本名');
});
