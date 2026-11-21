// #166：pilot.md 每任 coordinator 都整份讀（63544 bytes），多數條目只在少數分支用到。
// pilot.md 只留每輪都用的條目，其餘拆到 adapter Pilot 段連到的其他檔；移出的條目在 pilot.md 留一行 pointer，寫明什麼情況要讀。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { pilotDocs, pilotEntry } from './helpers/pilot-docs.mjs';

const PILOT = 'docs/agents/pilot.md';
const files = pilotDocs.map(({ path }) => path);
const pilot = pilotDocs[0].text;
const splitDocs = pilotDocs.slice(1);
const entries = text => [...text.matchAll(/^- \*\*(.+?)\.\*\*/gm)].map(m => m[1]);

// #344：pilot.md 是必讀核心，上限改由 scripts/adapter-size-budget.json 訂（check-adapter-size.mjs 檢查）；拆出去的每份都要列在預算表，adapter-line.mjs 才查得到。
const budget = JSON.parse(readFileSync(new URL('../scripts/adapter-size-budget.json', import.meta.url), 'utf8'));
test('pilot.md 在必讀核心預算內（14000 bytes 以下），Pilot 段連到的每份都列在預算表', () => {
  assert.ok(budget[PILOT] <= 14000, `${PILOT} 的預算 ${budget[PILOT]}`);
  const size = statSync(new URL(`../${PILOT}`, import.meta.url)).size;
  assert.ok(size <= budget[PILOT], `${PILOT} ${size} bytes`);
  for (const path of files) assert.ok(budget[path], `adapter-size-budget.json 沒列 ${path}`);
});

test('adapter 的 Pilot 段以 pilot.md 開頭，另外連到拆出去的檔', () => {
  assert.equal(files[0], PILOT);
  assert.ok(splitDocs.length > 0, 'Pilot 段沒有連到拆出去的檔');
});

test('拆出去的每個條目在 pilot.md 都有一行 pointer，連到它所在的檔並寫明什麼時候讀', () => {
  for (const { path, text } of splitDocs) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const moved = entries(text);
    assert.ok(moved.length > 0, `${path} 沒有條目`);
    for (const entry of moved) {
      const lines = pilot.split('\n').filter(line => line.startsWith(`- **${entry}.**`));
      assert.equal(lines.length, 1, `${PILOT} 要有一行 **${entry}.** pointer`);
      assert.ok(lines[0].includes(`](${name})`), `**${entry}.** 的 pointer 要連到 ${name}`);
      assert.ok(lines[0].length < 400, `**${entry}.** 的 pointer 只寫一行，不帶內容`);
    }
  }
});

// #240：來源改列在清單檔，Sources 條目只指向它；Sessions 指令以 --sources-file 讀同一份。
const SOURCES_FILE = 'docs/agents/pilot-sources.txt';
test('Sources 清單檔列出 Pilot 段連到的每個檔，來源檢查才涵蓋拆出去的檔', () => {
  const listed = readFileSync(new URL(`../${SOURCES_FILE}`, import.meta.url), 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (const path of ['CLAUDE.md', ...files]) assert.ok(listed.includes(path), `${SOURCES_FILE} 沒列 ${path}`);
  const entry = name => pilotEntry(name).line;
  assert.ok(entry('Sources').includes(`\`${SOURCES_FILE}\``), `Sources 沒指向 ${SOURCES_FILE}`);
  assert.ok(entry('Sessions').includes(`--sources-file ${SOURCES_FILE}`), `Sessions 指令沒帶 --sources-file ${SOURCES_FILE}`);
});
