import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { env, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/port-entries.mjs', import.meta.url).pathname;
// #344 的真實情形：c581b85^ 的 pilot.md（base），c581b85 把 **Probe.**、**Stage.** 搬到 pilot-round.md、pilot.md 留同名指標條目。
const fixture = name => readFileSync(new URL(`fixtures/port-entries-344/${name}.md.txt`, import.meta.url), 'utf8');
const PILOT = 'docs/agents/pilot.md';
const ROUND = 'docs/agents/pilot-round.md';
const BUDGET = JSON.stringify({ [PILOT]: 14000, [ROUND]: 58000 });

/** 條目名為 name 的行（整行，含行尾換行之前的所有字元）。 */
function entry(content, name) {
  const lines = content.split('\n').filter(line => line.startsWith(`- **${name}.**`));
  assert.equal(lines.length, 1, `${name} 應恰好一行`);
  return lines[0];
}

/** 改條目行的一個字（在行尾的句號前插入「改」）。 */
function edit(content, name) {
  const line = entry(content, name);
  return content.replace(line, `${line}改`);
}

/** 拿掉條目行（連同前面的空行）。 */
const drop = (content, name) => content.replace(`\n\n${entry(content, name)}`, '');

/**
 * 暫存 repo：base commit 寫 baseFiles，prior 分支在 base 上寫 priorFiles，main 再寫 treeFiles（null 刪檔）並 commit，
 * 工作樹停在 main。回傳 { dir, base, prior, read }。
 */
function repo(t, { base: baseFiles, prior: priorFiles, tree: treeFiles }) {
  const dir = mkdtempSync(join(realTmpdir(), 'port-entries-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, { 'scripts/adapter-size-budget.json': BUDGET, ...baseFiles });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'prior');
  write(dir, priorFiles);
  git(dir, 'commit', '-qam', 'prior');
  const prior = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  for (const [path, content] of Object.entries(treeFiles)) {
    if (content === null) rmSync(join(dir, path));
    else write(dir, { [path]: content });
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'move');
  return { dir, base, prior, read: path => readFileSync(join(dir, path), 'utf8') };
}

function run(dir, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const basePilot = fixture('base-pilot');
const movedPilot = fixture('moved-pilot');
const movedRound = fixture('moved-pilot-round');
// pilot.md 拿掉指標條目：聯集內 **Probe.**、**Stage.** 只在 pilot-round.md。
const pointerless = drop(drop(movedPilot, 'Probe'), 'Stage');

test('#344 搬檔：prior 改 pilot.md 的 Probe，移植到 pilot-round.md', t => {
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: basePilot }, prior: { [PILOT]: edit(basePilot, 'Probe') }, tree: { [PILOT]: pointerless, [ROUND]: movedRound },
  });
  const result = run(dir, base, prior, PILOT);
  assert.deepEqual(result, { status: 0, stdout: `PORTED Probe ${ROUND}\n`, stderr: '' });
  assert.equal(read(ROUND), edit(movedRound, 'Probe'));
  assert.equal(read(PILOT), pointerless);
});

test('同一次 prior 改 Probe 與 Stage：各印一行 PORTED，依 prior 內順序', t => {
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: basePilot }, prior: { [PILOT]: edit(edit(basePilot, 'Stage'), 'Probe') },
    tree: { [PILOT]: pointerless, [ROUND]: movedRound },
  });
  assert.deepEqual(run(dir, base, prior, PILOT), { status: 0, stdout: `PORTED Probe ${ROUND}\nPORTED Stage ${ROUND}\n`, stderr: '' });
  assert.equal(read(ROUND), edit(edit(movedRound, 'Probe'), 'Stage'));
});

test('#344 現況撞名、沒給目標檔：AMBIGUOUS 列出兩個候選檔，不寫入', t => {
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: basePilot }, prior: { [PILOT]: edit(basePilot, 'Probe') }, tree: { [PILOT]: movedPilot, [ROUND]: movedRound },
  });
  assert.deepEqual(run(dir, base, prior, PILOT), { status: 1, stdout: `AMBIGUOUS Probe ${PILOT} ${ROUND}\n`, stderr: '' });
  assert.equal(read(PILOT), movedPilot);
  assert.equal(read(ROUND), movedRound);
});

test('#344 現況撞名、給目標檔：只移植目標檔那一條，pilot.md 的指標條目不動', t => {
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: basePilot }, prior: { [PILOT]: edit(basePilot, 'Probe') }, tree: { [PILOT]: movedPilot, [ROUND]: movedRound },
  });
  assert.deepEqual(run(dir, base, prior, PILOT, ROUND), { status: 0, stdout: `PORTED Probe ${ROUND}\n`, stderr: '' });
  assert.equal(read(ROUND), edit(movedRound, 'Probe'));
  assert.equal(read(PILOT), movedPilot);
});

test('目標檔自己也有兩條同名：AMBIGUOUS，不寫入', t => {
  const doubled = `${movedRound}\n${entry(movedRound, 'Probe')}\n`;
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: basePilot }, prior: { [PILOT]: edit(basePilot, 'Probe') }, tree: { [PILOT]: movedPilot, [ROUND]: doubled },
  });
  assert.deepEqual(run(dir, base, prior, PILOT, ROUND), { status: 1, stdout: `AMBIGUOUS Probe ${PILOT} ${ROUND}\n`, stderr: '' });
  assert.equal(read(ROUND), doubled);
  assert.equal(read(PILOT), movedPilot);
});

test('一條拆成兩條不同名：NO_MATCH，兩條新條目與其他檔不動', t => {
  const stage = entry(movedRound, 'Stage');
  const split = movedRound.replace(stage, `${stage.replace('- **Stage.**', '- **Stage-A.**')}\n\n${stage.replace('- **Stage.**', '- **Stage-B.**')}`);
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: basePilot }, prior: { [PILOT]: edit(basePilot, 'Stage') }, tree: { [PILOT]: pointerless, [ROUND]: split },
  });
  assert.deepEqual(run(dir, base, prior, PILOT), { status: 1, stdout: 'NO_MATCH Stage\n', stderr: '' });
  assert.equal(read(ROUND), split);
  assert.equal(read(PILOT), pointerless);
});

test('目標處原文已被改過：NO_MATCH，不寫入；其他條目照常 PORTED', t => {
  const rewritten = movedRound.replace(entry(movedRound, 'Stage'), `${entry(movedRound, 'Stage')}（別處改過）`);
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: basePilot }, prior: { [PILOT]: edit(edit(basePilot, 'Probe'), 'Stage') },
    tree: { [PILOT]: pointerless, [ROUND]: rewritten },
  });
  assert.deepEqual(run(dir, base, prior, PILOT), { status: 1, stdout: `PORTED Probe ${ROUND}\nNO_MATCH Stage\n`, stderr: '' });
  assert.equal(read(ROUND), edit(rewritten, 'Probe'));
});

test('AMBIGUOUS 不擋其他條目移植', t => {
  const withStage = `${pointerless}\n- **Stage.** 指標，見 pilot-round.md。\n`;
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: basePilot }, prior: { [PILOT]: edit(edit(basePilot, 'Probe'), 'Stage') },
    tree: { [PILOT]: withStage, [ROUND]: movedRound },
  });
  assert.deepEqual(run(dir, base, prior, PILOT), { status: 1, stdout: `PORTED Probe ${ROUND}\nAMBIGUOUS Stage ${PILOT} ${ROUND}\n`, stderr: '' });
  assert.equal(read(ROUND), edit(movedRound, 'Probe'));
  assert.equal(read(PILOT), withStage);
});

test('prior 新增 base 沒有的條目：ADDED，整行接在 <檔> 最後一條條目之後', t => {
  const added = '- **Fresh.** 新條目。';
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: '# Pilot\n\n- **Old.** a\n\n- **Last.** b\n\n## 附註\n\n文字。\n' },
    prior: { [PILOT]: `# Pilot\n\n- **Old.** a\n\n- **Last.** b\n\n${added}\n\n## 附註\n\n文字。\n` },
    tree: { [PILOT]: '# Pilot\n\n- **Old.** a\n\n- **Moved-in.** c\n\n## 附註\n\n文字。\n', [ROUND]: '# Round\n\n- **Last.** b\n' },
  });
  assert.deepEqual(run(dir, base, prior, PILOT), { status: 0, stdout: `ADDED Fresh ${PILOT}\n`, stderr: '' });
  assert.equal(read(PILOT), `# Pilot\n\n- **Old.** a\n\n- **Moved-in.** c\n\n${added}\n\n## 附註\n\n文字。\n`);
  assert.equal(read(ROUND), '# Round\n\n- **Last.** b\n');
});

test('新增的條目在 <檔> 已不存在時接到 <目標檔>；聯集已有同名時 AMBIGUOUS', t => {
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: '- **Old.** a\n' },
    prior: { [PILOT]: '- **Old.** a\n- **Fresh.** b\n- **Taken.** c\n' },
    tree: { [PILOT]: null, [ROUND]: '- **Old.** a\n- **Taken.** z\n' },
  });
  assert.deepEqual(run(dir, base, prior, PILOT, ROUND), { status: 1, stdout: `ADDED Fresh ${ROUND}\nAMBIGUOUS Taken ${ROUND}\n`, stderr: '' });
  assert.equal(read(ROUND), '- **Old.** a\n- **Taken.** z\n- **Fresh.** b\n');
});

test('比對只去行尾空白：行尾空白不同仍移植，行內多一個空白 NO_MATCH', t => {
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: '- **Probe.** 讀分頁。  \n\n- **Stage.** 合入 整合。\n' },
    prior: { [PILOT]: '- **Probe.** 讀分頁改。\n\n- **Stage.** 合入 整合改。\n' },
    tree: { [PILOT]: '# Pilot\n', [ROUND]: '- **Probe.** 讀分頁。\n\n- **Stage.** 合入  整合。\n' },
  });
  assert.deepEqual(run(dir, base, prior, PILOT), { status: 1, stdout: `PORTED Probe ${ROUND}\nNO_MATCH Stage\n`, stderr: '' });
  assert.equal(read(ROUND), '- **Probe.** 讀分頁改。\n\n- **Stage.** 合入  整合。\n');
});

test('參數不足或 ref 不存在：exit 2，stderr 印用法，不寫入', t => {
  const { dir, base, prior, read } = repo(t, {
    base: { [PILOT]: basePilot }, prior: { [PILOT]: edit(basePilot, 'Probe') }, tree: { [PILOT]: pointerless, [ROUND]: movedRound },
  });
  for (const args of [[], [base, prior], [base, 'no-such-ref', PILOT], ['no-such-ref', prior, PILOT], [base, prior, 'docs/agents/none.md']]) {
    const result = run(dir, ...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /用法：node scripts\/port-entries\.mjs <base> <prior> <檔> \[<目標檔>\]/);
  }
  assert.equal(read(ROUND), movedRound);
  assert.equal(read(PILOT), pointerless);
});

test('對應檔與條目行解析只有 entry-survival.mjs 一處定義', () => {
  const code = readFileSync(script, 'utf8').split('\n').filter(line => !/^\s*(\/\/|\/\*\*|#!)/.test(line)).join('\n');
  assert.match(code, /^import \{ correspondingFiles, entryLines \} from '\.\/entry-survival\.mjs';$/m);
  assert.doesNotMatch(code, /adapter-size-budget\.json|-TEMPLATE|\\\*\\\*|function (correspondingFiles|entryLines)\b/);
});
