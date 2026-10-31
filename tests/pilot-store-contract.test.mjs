import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// pilot 存檔的格式只寫在 PILOT-STORE.md（ADR 0002）：契約要涵蓋每個檔案、與正本 script 實際寫出的格式一致，
// 其他文件只連過去，不再各寫一份（#55）。
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const CONTRACT = 'skills/engineering/issue-pilot/PILOT-STORE.md';
const contract = read(CONTRACT);

test('契約逐一涵蓋 pilot 存檔的每個檔案', () => {
  for (const file of ['coordinator', 'sessions.md', 'hold', 'decisions.md', 'requests.md', 'sources', 'gates.md', 'preferences.md', 'status.md', 'briefs/', 'batch-<key>.md']) {
    assert.match(contract, new RegExp(`^## \`[^\`\\n]*${file.replace(/[.*<>/]/g, '\\$&')}\``, 'm'), `缺少 ${file} 一節`);
  }
});

test('批次 checkpoint 的表頭與 pilot-dispatch 寫出的一致', () => {
  const header = '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |';
  assert.ok(read('scripts/pilot-dispatch.mjs').includes(header));
  assert.ok(contract.includes(header));
  for (const value of ['`dispatched`', '`staged <sha>`', '`merged <sha>`', '`pushed <sha>`', '`closed`', '`running`', '`done`', '`stop`']) {
    assert.ok(contract.includes(value), `缺少 ${value}`);
  }
});

test('hold 與 sessions.md 寫出新格式、註明舊格式照樣接受', () => {
  assert.ok(contract.includes('{"since":"2026-10-30T21:00:00+08:00","reason":"等 #27 合入","session":"1d6719b0-c957-4d42-84bc-8474ba2fa7c7"}'));
  assert.ok(contract.includes('2026-10-30T20:43:33+08:00   session 1d6719b0-c957-4d42-84bc-8474ba2fa7c7   pid 553382   ron-skills-0c'));
  assert.match(contract, /An empty file .* is a hold with no reason/);
  assert.match(contract, /coordinator start/);
});

test('skill、adapter 範本、本 repo adapter 與流程文件都連到契約，不再自己描述格式', () => {
  const links = {
    'skills/engineering/issue-pilot/SKILL.md': 'PILOT-STORE.md',
    'skills/engineering/issue-run/ADAPTER.md': '../issue-pilot/PILOT-STORE.md',
    'docs/agents/pilot.md': '../../skills/engineering/issue-pilot/PILOT-STORE.md',
    'docs/workflow/05-level3.md': '../../skills/engineering/issue-pilot/PILOT-STORE.md',
  };
  for (const [path, target] of Object.entries(links)) {
    const text = read(path);
    assert.ok(text.includes(`](${target}`), `${path} 沒有連到 ${target}`);
    assert.ok(!text.includes('stuck-after | state | candidate'), `${path} 仍有批次 checkpoint 表頭`);
    assert.ok(!/`?touch`? 設定|touch .*hold/.test(text), `${path} 仍描述 hold 的舊寫法`);
    assert.ok(!text.includes('pid <CLAUDE_PID>   loop'), `${path} 仍描述 coordinator 檔的行格式`);
    assert.ok(!text.includes('handoff from-session <'), `${path} 仍描述 sessions.md 的 handoff 行`);
  }
});

// 寫存檔的 6 支正本（#56；pilot-gate，#134）與從 batch checkpoint 產生 PR body 的 pilot-pr-body（#145），共 7 支：契約列出每支的指令與結果行；正本不能帶任何專案的路徑或名稱，專案值一律由參數傳入。
const PILOT_SCRIPTS = ['pilot-register', 'pilot-decision', 'pilot-request', 'pilot-hold', 'pilot-sources', 'pilot-gate', 'pilot-pr-body'];
test('契約的 Canonical scripts 列出每支寫存檔的正本，正本不含專案字樣', () => {
  const section = contract.slice(contract.indexOf('## Canonical scripts'));
  assert.ok(section.startsWith('## Canonical scripts'), '缺少 Canonical scripts 一節');
  for (const name of PILOT_SCRIPTS) {
    assert.ok(section.includes(`| \`${name}.mjs\` |`), `Canonical scripts 沒有 ${name}.mjs`);
    for (const file of [`${name}.mjs`, `${name}.test.mjs`]) {
      const text = read(`skills/engineering/setup-workflow/templates/${file}`);
      assert.doesNotMatch(text, /spay2|ron-skills|\/Users\/|\/home\//, `${file} 含專案字樣`);
    }
  }
  assert.doesNotMatch(read('skills/engineering/setup-workflow/templates/lib/pilot-store.mjs'), /spay2|ron-skills|\/Users\/|\/home\//, 'lib/pilot-store.mjs 含專案字樣');
});
