// #144：ADAPTER_AHEAD 附了條目名稱時，coordinator 照 Probe lines 條目（#166 從 pilot.md 的 Probe 移到 pilot-exceptions.md）給的指令只讀那幾個 `- **<名稱>.**` 條目。
// 這裡把那條指令從條目抽出來，跑在真的 adapter 與 fixture 上：條目範圍要和 pilot-probe.mjs 的 entryAt 一樣，
// 從條目那一行讀到下一個不縮排的非空行為止（中間的空行與縮排續行都算），條目之間沒有空行分隔時也不能多讀下一條。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pilot = read('docs/agents/pilot-after-merge.md');
const probeEntry = read('docs/agents/pilot-exceptions.md').match(/^- \*\*Probe lines\.\*\*.*$/m)?.[0] ?? '';
const prefix = 'git -C <主 checkout> show pilot/integration:<檔案> | ';
const command = probeEntry.split('`').find(span => span.startsWith(prefix))?.slice(prefix.length);

/** 照 Probe 條目的指令從 `text` 抽出名稱為 `name` 的條目（去掉結尾空白）。 */
function extract(text, name) {
  assert.ok(command, 'pilot-exceptions.md 的 Probe lines 條目沒有 `git -C <主 checkout> show pilot/integration:<檔案> | …` 的抽條目指令');
  const result = spawnSync('sh', ['-c', command.replaceAll('<名稱>', name)], { input: text, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd();
}

test('條目之間沒有空行分隔時只讀到該條目（issue-run.md 的分頁狀態）', () => {
  const adapter = read('docs/agents/issue-run.md');
  const entry = adapter.match(/^- \*\*待 Retro\.\*\*.*$/m)?.[0];
  assert.ok(entry);
  assert.equal(extract(adapter, '待 Retro'), entry);
});

test('縮排續行算在條目裡（pilot-after-merge.md 的 Push gate）', () => {
  const lines = pilot.split('\n');
  const start = lines.findIndex(line => line.startsWith('- **Push gate.**'));
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
  const entry = lines.slice(start, end).join('\n').trimEnd();
  assert.ok(entry.split('\n').length > 1, 'Push gate 應有縮排續行');
  assert.equal(extract(pilot, 'Push gate'), entry);
});

test('空行之後的縮排續行也算，讀到下一個不縮排的行為止', () => {
  const text = '# t\n\n- **A.** a\n\n  續行\n- **B.** b\n\n前言\n';
  assert.equal(extract(text, 'A'), '- **A.** a\n\n  續行');
  assert.equal(extract(text, 'B'), '- **B.** b');
  assert.equal(extract(text, 'C'), '');
});
