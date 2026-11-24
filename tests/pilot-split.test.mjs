// #166：pilot.md 每任 coordinator 都整份讀（63544 bytes），多數條目只在少數分支用到。
// pilot.md 只留每輪都用的條目，其餘拆到 adapter Pilot 段連到的其他檔；移出的條目在 pilot.md 留一行 pointer，寫明什麼情況要讀。
// 搬條目前先看別的測試綁在 pilot.md 本身的斷言（#434）：pilot-adapter-stage.test.mjs 要 **Close.** 與 **Handoff.** 在 pilot.md 相鄰，
// auto-retro.test.mjs 與 triage-brief.test.mjs 驗 Retro trigger、Triage brief 的 pointer 寫法；結果行（`MERGED <key> <sha>`、`STOP …`）原本也要在 pilot.md，
// #344 起改成 pilot 各檔任一份有即可。另外 grep `見 <條目>`、`照 <條目>`：別的條目以名稱引用被搬走的句子時（#433：Defaults 的「worker 指令見 Dispatch」），
// 把句子或指令留在 pointer 行，或改引用處。
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
  assert.ok(budget[PILOT] <= 14000, `${PILOT} 的預算 ${budget[PILOT]}/14000 bytes，超 ${budget[PILOT] - 14000}`);
  const size = statSync(new URL(`../${PILOT}`, import.meta.url)).size;
  // #420：失敗訊息帶大小與上限，一次就知道要刪多少（worker 曾為了不知道超多少試縮 6 次）。
  assert.ok(size <= budget[PILOT], `${PILOT} ${size}/${budget[PILOT]} bytes，超 ${size - budget[PILOT]}`);
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

// #502：pilot-land 落地後印的 POSTLAND_PENDING 要有處理規則：不需要 Operator 的 coordinator 自己跑，需要的一律開 gate。
// 本 repo 的 Stage 條目與給其他 repo 的範本（PILOT-ROUND-TEMPLATE 的 Stage, regression, integrate）都要寫兩條。
test('Stage 條目與 PILOT-ROUND-TEMPLATE 寫明 POSTLAND_PENDING 的兩條處理規則', () => {
  const { line } = pilotEntry('Stage');
  assert.match(line, /POSTLAND_PENDING <n> <command>/);
  assert.match(line, /不需要 Operator 的由 coordinator 在 `<stage worktree>` 跑/);
  assert.match(line, /需要 Operator 的[^。]*一律照 \*\*Gates\.\*\* 開 gate/);
  const template = readFileSync(new URL('../skills/engineering/issue-run/PILOT-ROUND-TEMPLATE.md', import.meta.url), 'utf8').match(/^- \*\*Stage, regression, integrate\.\*\* .*$/m)?.[0] ?? '';
  assert.match(template, /POSTLAND_PENDING <n> <command>/);
  assert.match(template, /run each one that needs no Operator in the stage worktree/);
  assert.match(template, /open a gate[^.]*for each that needs the Operator/);
});
