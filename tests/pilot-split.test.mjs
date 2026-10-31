// #166：pilot.md 每任 coordinator 都整份讀（63544 bytes），多數條目只在少數分支用到。
// pilot.md 只留每輪都用的條目，其餘拆到 adapter Pilot 段連到的其他檔；移出的條目在 pilot.md 留一行 pointer，寫明什麼情況要讀。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { pilotFiles } from '../scripts/pilot-probe.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const PILOT = 'docs/agents/pilot.md';
const files = pilotFiles(read('docs/agents/issue-run.md'));
const branches = files.filter(path => path !== PILOT);
const entries = text => [...text.matchAll(/^- \*\*(.+?)\.\*\*/gm)].map(m => m[1]);

test('pilot.md 至少減半（拆檔前 63544 bytes），也低於 Read 的單次上限', () => {
  assert.ok(statSync(new URL(PILOT, root)).size <= 63544 / 2, `${PILOT} ${statSync(new URL(PILOT, root)).size} bytes`);
});

test('adapter 的 Pilot 段以 pilot.md 開頭，另外連到拆出去的檔', () => {
  assert.equal(files[0], PILOT);
  assert.ok(branches.length > 0, 'Pilot 段沒有連到拆出去的檔');
});

test('拆出去的每個條目在 pilot.md 都有一行 pointer，連到它所在的檔並寫明什麼時候讀', () => {
  const pilot = read(PILOT);
  for (const path of branches) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const moved = entries(read(path));
    assert.ok(moved.length > 0, `${path} 沒有條目`);
    for (const entry of moved) {
      const lines = pilot.split('\n').filter(line => line.startsWith(`- **${entry}.**`));
      assert.equal(lines.length, 1, `${PILOT} 要有一行 **${entry}.** pointer`);
      assert.ok(lines[0].includes(`](${name})`), `**${entry}.** 的 pointer 要連到 ${name}`);
      assert.ok(lines[0].length < 400, `**${entry}.** 的 pointer 只寫一行，不帶內容`);
    }
  }
});

test('pilot.md 的 Sources 列出 Pilot 段連到的每個檔，來源檢查才涵蓋拆出去的檔', () => {
  const sources = read(PILOT).match(/^- \*\*Sources\.\*\*.*$/m)?.[0] ?? '';
  for (const path of files) assert.ok(sources.includes(`\`${path}\``), `Sources 沒列 ${path}`);
});
