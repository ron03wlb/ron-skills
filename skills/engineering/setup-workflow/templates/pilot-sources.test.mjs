import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-sources.mjs', import.meta.url));
const checkout = t => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-sources-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'docs/agents'), { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), 'rules\n');
  writeFileSync(join(dir, 'docs/agents/pilot.md'), 'pilot v1\n');
  return dir;
};
const run = (dir, ...args) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8' });
const SOURCES = ['AGENTS.md', 'docs/agents/pilot.md'];
const sha = text => createHash('sha256').update(text).digest('hex');

test('沒有記錄：每個來源都印 SOURCE_CHANGED，不寫記錄', t => {
  const dir = checkout(t);
  const result = run(dir, ...SOURCES);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SOURCE_CHANGED AGENTS.md\nSOURCE_CHANGED docs/agents/pilot.md\n');
  assert.throws(() => readFileSync(join(dir, '.scratch/pilot/sources')));
});

test('--record 先回報變動再寫記錄（每行 `<sha256>   <path>`），印 RECORDED <n>；之後沒有變動就只印 RECORDED', t => {
  const dir = checkout(t);
  const first = run(dir, '--record', ...SOURCES);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'SOURCE_CHANGED AGENTS.md\nSOURCE_CHANGED docs/agents/pilot.md\nRECORDED 2\n');
  assert.equal(readFileSync(join(dir, '.scratch/pilot/sources'), 'utf8'), `${sha('rules\n')}   AGENTS.md\n${sha('pilot v1\n')}   docs/agents/pilot.md\n`);
  assert.equal(run(dir, ...SOURCES).stdout, '');
  assert.equal(run(dir, '--record', ...SOURCES).stdout, 'RECORDED 2\n');
});

test('改過的來源印 SOURCE_CHANGED；不存在的來源印 SOURCE_MISSING，不中止', t => {
  const dir = checkout(t);
  run(dir, '--record', ...SOURCES);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), 'pilot v2\n');
  rmSync(join(dir, 'AGENTS.md'));
  const result = run(dir, ...SOURCES, 'skills/x/SKILL.md');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SOURCE_MISSING AGENTS.md\nSOURCE_CHANGED docs/agents/pilot.md\n  outside\nSOURCE_MISSING skills/x/SKILL.md\n');
});

test('來源從 checkout 解析，與呼叫者的 cwd 無關；也接受絕對路徑', t => {
  const dir = checkout(t);
  const result = spawnSync('node', [SCRIPT, dir, '--record', 'AGENTS.md', join(dir, 'docs/agents/pilot.md')], { encoding: 'utf8', cwd: realTmpdir() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SOURCE_CHANGED AGENTS.md\nSOURCE_CHANGED docs/agents/pilot.md\nRECORDED 2\n');
});

test('checkout 裡以 .. 開頭的檔名仍記成相對路徑', t => {
  const dir = checkout(t);
  writeFileSync(join(dir, '..notes.md'), 'x\n');
  assert.equal(run(dir, '--record', join(dir, '..notes.md')).stdout, 'SOURCE_CHANGED ..notes.md\nRECORDED 1\n');
});

test('經由 symlink 路徑執行仍會跑（macOS 的 /tmp 是 /private/tmp 的 symlink）', t => {
  const dir = checkout(t);
  const link = join(dir, 'link.mjs');
  symlinkSync(SCRIPT, link);
  const result = spawnSync('node', [link, dir, 'AGENTS.md'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SOURCE_CHANGED AGENTS.md\n');
});

const PILOT = '# Pilot\n\n- **Sessions.** 跑 register\n  續行\n\n- **Handoff.** 手動附加一行\n\n## Notes\n\n一段說明\n\n- **Extra.** x\n';

test('有快照時 SOURCE_CHANGED 下一行縮排列出改動的條目；重新記錄後不再印', t => {
  const dir = checkout(t);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), PILOT);
  run(dir, '--record', ...SOURCES);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), PILOT.replace('手動附加一行', 'pilot-handoff 已附加'));
  assert.equal(run(dir, '--record', ...SOURCES).stdout, 'SOURCE_CHANGED docs/agents/pilot.md\n  entry Handoff\nRECORDED 2\n');
  assert.equal(run(dir, '--record', ...SOURCES).stdout, 'RECORDED 2\n');
});

test('改了 ## 標題底下條目以外的內容列出該標題，第一個標題之前的列 outside；檔案沒變時不印任何行', t => {
  const dir = checkout(t);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), PILOT);
  run(dir, '--record', ...SOURCES);
  assert.equal(run(dir, ...SOURCES).stdout, '');
  writeFileSync(join(dir, 'docs/agents/pilot.md'), PILOT.replace('一段說明', '改過的說明').replace('# Pilot', '# Pilot v2'));
  assert.equal(run(dir, ...SOURCES).stdout, 'SOURCE_CHANGED docs/agents/pilot.md\n  outside\n  heading Notes\n');
});

test('刪掉的條目與改名的標題取兩邊的名稱，刪掉的接在後面', t => {
  const dir = checkout(t);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), PILOT);
  run(dir, '--record', ...SOURCES);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), PILOT.replace('- **Handoff.** 手動附加一行\n\n', '').replace('## Notes', '## Remarks'));
  assert.equal(run(dir, ...SOURCES).stdout, 'SOURCE_CHANGED docs/agents/pilot.md\n  heading Remarks\n  entry Handoff\n  heading Notes\n');
});

test('沒有舊快照（舊格式紀錄）時只印 SOURCE_CHANGED，不報錯；repo 外的來源也存快照', t => {
  const dir = checkout(t);
  const outside = mkdtempSync(join(realTmpdir(), 'pilot-sources-home-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const skill = join(outside, 'SKILL.md');
  writeFileSync(skill, PILOT);
  mkdirSync(join(dir, '.scratch/pilot'), { recursive: true });
  writeFileSync(join(dir, '.scratch/pilot/sources'), `${sha('rules\n')}   AGENTS.md\n${sha('pilot v0\n')}   docs/agents/pilot.md\n`);
  const result = run(dir, '--record', ...SOURCES, skill);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `SOURCE_CHANGED docs/agents/pilot.md\nSOURCE_CHANGED ${skill}\nRECORDED 3\n`);
  assert.equal(readFileSync(join(dir, '.scratch/pilot/source-snapshots', sha(PILOT)), 'utf8'), PILOT);
  writeFileSync(skill, PILOT.replace('x\n', 'y\n'));
  assert.equal(run(dir, ...SOURCES, skill).stdout, `SOURCE_CHANGED ${skill}\n  entry Extra\n`);
});

test('code fence 裡的 ## 與條目行不算標題或條目，算在所在的單位', t => {
  const dir = checkout(t);
  const text = '## Format\n\n```\n## fake\n- **Fake.** x\n```\n';
  writeFileSync(join(dir, 'docs/agents/pilot.md'), text);
  run(dir, '--record', ...SOURCES);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), text.replace('x\n', 'y\n'));
  assert.equal(run(dir, ...SOURCES).stdout, 'SOURCE_CHANGED docs/agents/pilot.md\n  heading Format\n');
});

test('--record 只留這次清單的快照', t => {
  const dir = checkout(t);
  run(dir, '--record', ...SOURCES);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), 'pilot v2\n');
  run(dir, '--record', ...SOURCES);
  assert.deepEqual(readdirSync(join(dir, '.scratch/pilot/source-snapshots')).sort(), [sha('pilot v2\n'), sha('rules\n')].sort());
});

test('沒給來源：exit 2', t => {
  assert.equal(run(checkout(t)).status, 2);
  assert.equal(run(checkout(t), '--record').status, 2);
});

// #236、#239：**Probe.** 是好幾 KB 的單行條目，只印 `entry Probe` 時 coordinator 得自己跑 `git diff --word-diff`
// 才看得出多了 `regression-failed` 一個變體。fixture 是某個 repo 的 docs/agents/pilot.md 改動前後的 Probe 條目（專案名稱換成 example-repo）。
const probe = name => readFileSync(new URL(`./test/fixtures/pilot-sources/probe-${name}.txt`, import.meta.url), 'utf8');

test('長條目下面印詞級改動片段，讀片段就看得出改了什麼', t => {
  const dir = checkout(t);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), `# Pilot\n\n${probe('old')}`);
  run(dir, '--record', ...SOURCES);
  writeFileSync(join(dir, 'docs/agents/pilot.md'), `# Pilot\n\n${probe('new')}`);
  const lines = run(dir, ...SOURCES).stdout.split('\n');
  assert.deepEqual(lines.slice(0, 2), ['SOURCE_CHANGED docs/agents/pilot.md', '  entry Probe']);
  const snippets = lines.slice(2).filter(Boolean);
  assert.equal(snippets.length, 2, lines.join('\n'));
  assert.ok(snippets.every(line => line.startsWith('    ') && line.length < 400), lines.join('\n'));
  assert.match(snippets[0], /\{\+且那一行是 exit 0，\+\}/);
  assert.match(snippets[1], /\{\+.*NOT_IN_MAIN <key> regression-failed .*\+\}/);
});

test('片段太多時改印 reread；短條目不印片段', t => {
  const dir = checkout(t);
  const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
  writeFileSync(join(dir, 'docs/agents/pilot.md'), `- **Long.** ${long}\n- **Short.** a\n`);
  run(dir, '--record', ...SOURCES);
  const rewritten = long.split(' ').map((w, i) => (i % 2 ? `${w}x` : w)).join(' ');
  writeFileSync(join(dir, 'docs/agents/pilot.md'), `- **Long.** ${rewritten}\n- **Short.** b\n`);
  assert.equal(run(dir, ...SOURCES).stdout, `SOURCE_CHANGED docs/agents/pilot.md\n  entry Long\n    (diff ${`- **Long.** ${rewritten}`.length} chars, reread)\n  entry Short\n`);
});
