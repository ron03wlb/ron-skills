// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './test/isolate-git-env.mjs';
import './test/isolate-orca-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDLE_MS, STATE_FILE, coordinatorHandle, inMain, rosterRows, screenBusy, sweep } from './tab-sweep.mjs';
import { ORCA_SAMPLES, mergeSample, orcaReplySource } from './test/fake-orca.mjs';
import { scriptClosure } from './test/script-deps.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

// CoS item 91 D／item 153：上游化 spay2 2958c8ac7 的 Tab sweep；判斷要比看守的 TAB_DONE 保守（前綴、lastOutputAt、畫面閒置、現任 coordinator）。
const HERE = fileURLToPath(new URL('.', import.meta.url));
const NOW = Date.parse('2026-11-25T06:00:00Z');
const MAIN = '/home/ron/code/proj';
const idle = NOW - IDLE_MS - 60_000;
const busy = NOW - 3 * 60_000;
const IDLE_SCREEN = ['● 報告完了', '✻ Cogitated for 46s', '', '╭──────────╮', '│ ❯        │', '╰──────────╯', '  ⏵⏵ auto mode on (shift+tab to cycle)'];
const BUSY_SCREEN = ['● 跑測試中', '✻ Brewing… (12s · ↓ 1.2k tokens · esc to interrupt)', '❯'];

const term = (handle, extra = {}) => ({ handle, worktreePath: MAIN, tabId: `tab_${handle}`, lastOutputAt: idle, ...extra });
const TERMINALS = [
  term('term_retro'),
  term('term_close'),
  term('term_working'),
  term('term_coord'),
  term('term_self'),
  term('term_retro_recent', { lastOutputAt: busy }),
  term('term_close_busy'),
  term('term_worker', { worktreePath: '/home/ron/orca/workspaces/proj/feature-1' }),
];
const TITLES = {
  term_retro: '待 Retro｜refine 1100',
  term_close: '待關閉｜issue-queue 1125',
  term_working: '處理中｜#12 worker',
  term_coord: '待 Retro｜coordinator proj-2c',
  term_self: '處理中｜coordinator proj-2d',
  term_retro_recent: '待 Retro｜問答',
  term_close_busy: '待關閉｜retro collect 1125a',
  term_worker: '待 Retro｜#1 worker',
};
const SCREENS = { term_close_busy: BUSY_SCREEN };

/** 每個 handle 一個分頁的 visualLayouts（形狀照 list-visual 樣本：root.first.tabs[]）；panes 的 first 與 second 都寫，免得留下樣本的 term_sample。
 *  panes[handle] 給了時它是分頁的第一個 pane，handle 是 split 出來的。 */
const layouts = (titles, panes = {}) => [{
  root: { first: { tabs: Object.entries(titles).map(([handle, title]) => ({
    tabId: `tab_${handle}`, title, panes: { first: { handle: panes[handle] ?? handle }, second: { handle } },
  })) } },
}];

/** 注入的 async Orca：回應由真實樣本合出（mergeSample 不讓替身自創欄位）。 */
function fakeOrca({ terminals = TERMINALS, titles = TITLES, screens = SCREENS, drafts = {}, panes = {}, fail = {} } = {}) {
  const calls = [];
  const at = main => terminals.map(t => (t.worktreePath === MAIN ? { ...t, worktreePath: main } : t));
  const orca = main => async (...args) => {
    calls.push(args.join(' '));
    const [, sub] = args;
    if (fail[sub]) throw new Error(fail[sub]);
    if (sub === 'list') return mergeSample(ORCA_SAMPLES['list-visual'], { terminals: at(main), visualLayouts: layouts(titles, panes) }, 'list-visual');
    if (sub === 'read') {
      const handle = args[args.indexOf('--terminal') + 1];
      return mergeSample(ORCA_SAMPLES.read, { terminal: { handle, tail: screens[handle] ?? IDLE_SCREEN, draft: drafts[handle] ?? '' } }, 'read');
    }
    if (sub === 'send') return ORCA_SAMPLES.send;
    if (sub === 'close') return ORCA_SAMPLES.close;
    throw new Error(`unexpected ${sub}`);
  };
  return { orca, calls };
}

function fixture(state) {
  const main = mkdtempSync(join(realTmpdir(), 'tab-sweep-'));
  mkdirSync(join(main, '.scratch/pilot'), { recursive: true });
  writeFileSync(join(main, '.scratch/pilot/sessions.md'), '2026-11-25T00:56:25Z   handoff from-session abc → terminal term_coord   reason HANDOFF_DUE\n');
  if (state) writeFileSync(join(main, STATE_FILE), JSON.stringify(state));
  return main;
}

const run = (main, extra = {}) => {
  const recorded = [];
  const fake = extra.fake ?? fakeOrca();
  return sweep({ main, orca: fake.orca(main), self: 'term_self', now: NOW, record: (line, reason) => recorded.push(`${line} — ${reason}`), ...extra })
    .then(result => ({ ...result, recorded, calls: fake.calls }));
};
const sendsAndCloses = calls => calls.filter(c => /^terminal (send|close) /.test(c));

test('待關閉的分頁被關、待 Retro 的分頁送 /retro；處理中、現任 coordinator、自己、其他 worktree 不動', async () => {
  const main = fixture();
  try {
    const { lines, calls, recorded } = await run(main);
    assert.deepEqual(sendsAndCloses(calls), [
      'terminal send --terminal term_retro --text /retro --enter',
      'terminal close --terminal term_close --tab',
    ]);
    assert.ok(lines.includes('TAB_RETRO_SENT term_retro 待 Retro｜refine 1100'));
    assert.ok(lines.includes('TAB_CLOSED term_close 待關閉｜issue-queue 1125'));
    assert.ok(lines.includes('TAB_SKIP term_working working'));
    assert.ok(lines.includes('TAB_SKIP term_coord coordinator'));
    assert.ok(lines.includes('TAB_SKIP term_self self'));
    assert.ok(lines.includes('TAB_SKIP term_retro_recent not-idle 3m'));
    assert.equal(lines.at(-1), 'SUMMARY sent=1 closed=1 skipped=5 failed=0 other=1');
    assert.ok(!calls.some(c => /term_(worker|coord|self|working)\b/.test(c)), '不讀、不送、不關這些分頁的畫面');
    assert.equal(recorded.length, 3, '動作各記一筆 decisions，最後再記一筆 SUMMARY');
    assert.match(recorded.at(-1), /^SUMMARY sent=1 closed=1 skipped=5 failed=0 other=1 — /);
    const state = JSON.parse(readFileSync(join(main, STATE_FILE), 'utf8'));
    assert.deepEqual(Object.keys(state.sent), ['term_retro']);
    const again = await run(main);
    assert.ok(again.lines.some(l => l.startsWith('TAB_SKIP term_retro already-sent ')), '同一 handle 只送一次');
    assert.ok(!again.calls.some(c => c.startsWith('terminal send')));
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

// #649：retro-collect 收完、report 已落地，分頁標題卻留在處理中｜，狀態列殘留「1 shell still running」或「← 1 agent」，
// 這裡每輪 TAB_SKIP working，分頁 12 小時沒人關。收集者（.scratch/retro/collector）啟動後已有 report 或 collect 紀錄時當待關閉處理。
test('收完的收集者分頁停在處理中｜、狀態列殘留 shell／agent 計數：當待關閉關掉；還沒收完的仍是 working', async () => {
  const main = fixture();
  try {
    const started = NOW - 3 * 3_600_000;
    mkdirSync(join(main, '.scratch/retro/reports'), { recursive: true });
    writeFileSync(join(main, '.scratch/retro/collector'), `${new Date(started).toISOString()} term_collect\n`);
    const old = join(main, '.scratch/retro/reports/2026-11-24-1124a.md');
    writeFileSync(old, 'x');
    utimesSync(old, (started - 3_600_000) / 1000, (started - 3_600_000) / 1000);
    const residue = ['✻ Baked for 20m 9s · done 3:34 PM', '', '│ ❯        │', '  ⏵⏵ auto mode on · 1 shell still running · ← 1 agent'];
    const fake = () => fakeOrca({
      terminals: [term('term_collect'), term('term_working')],
      titles: { term_collect: '處理中｜retro-collect', term_working: '處理中｜#12 worker' },
      screens: { term_collect: residue },
    });
    const before = await run(main, { fake: fake() });
    assert.ok(before.lines.includes('TAB_SKIP term_collect working'), '啟動前的舊 report 不算收完');
    const report = join(main, '.scratch/retro/reports/2026-11-25-1125a.md');
    writeFileSync(report, 'x');
    utimesSync(report, (NOW - 3_600_000) / 1000, (NOW - 3_600_000) / 1000);
    const after = await run(main, { fake: fake() });
    assert.deepEqual(sendsAndCloses(after.calls), ['terminal close --terminal term_collect --tab']);
    assert.ok(after.lines.includes('TAB_CLOSED term_collect 處理中｜retro-collect'));
    assert.ok(after.lines.includes('TAB_SKIP term_working working'), '不是收集者的處理中｜照舊不動');
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('畫面不閒置就跳過：工作中、有草稿、看不到空的 ❯；看不清楚的記一筆且只記一次', async () => {
  const main = fixture();
  try {
    const screens = { term_retro: ['● 想一下', '✶ Pondering…', '❯'], term_close: ['● 報告', '❯ /retro 打到一半'], term_close_busy: BUSY_SCREEN };
    const { lines, calls, recorded } = await run(main, { fake: fakeOrca({ screens }) });
    assert.deepEqual(sendsAndCloses(calls), []);
    assert.ok(lines.includes('TAB_SKIP term_retro screen-busy'));
    assert.ok(lines.includes('TAB_SKIP term_close screen-no-prompt'));
    assert.ok(lines.includes('TAB_SKIP term_close_busy screen-busy'));
    const notSummary = rows => rows.map(r => r.split(' — ')[0]).filter(r => !r.startsWith('SUMMARY '));
    assert.deepEqual(notSummary(recorded), ['TAB_SKIP term_close screen-no-prompt']);
    const again = await run(main, { fake: fakeOrca({ screens }) });
    assert.deepEqual(notSummary(again.recorded), [], '同一分頁同一原因不重記');
    const unreadable = await run(main, { fake: fakeOrca({ fail: { read: 'timeout terminal read 15000ms' } }) });
    assert.ok(unreadable.lines.includes('TAB_SKIP term_retro screen-unreadable timeout terminal read 15000ms'));
    assert.deepEqual(sendsAndCloses(unreadable.calls), []);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

// #646：coordinator 漏跑第 4 步時 decisions.md 沒有任何 Tab sweep 列，看守分不出「跑了但沒事」與「沒跑」；每輪都記一筆 SUMMARY。
test('全是 TAB_SKIP 的一輪也在 decisions 記一筆 SUMMARY；dry-run 不記', async () => {
  const main = fixture();
  try {
    const terminals = [term('term_w'), term('term_self')];
    const titles = { term_w: '處理中｜w', term_self: '處理中｜self' };
    const { lines, recorded } = await run(main, { fake: fakeOrca({ terminals, titles }) });
    assert.ok(lines.every(l => l.startsWith('TAB_SKIP ') || l.startsWith('SUMMARY ')), lines.join('\n'));
    assert.deepEqual(recorded.map(r => r.split(' — ')[0]), [lines.at(-1)]);
    assert.match(lines.at(-1), /^SUMMARY sent=0 closed=0 skipped=2 failed=0 /);
    const dry = await run(main, { dryRun: true, fake: fakeOrca({ terminals, titles }) });
    assert.deepEqual(dry.recorded, []);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

// #660：sessions.md 讀不到（例如是目錄，EISDIR）時直接拋錯，CLI exit 1、stdout 空、decisions.md 沒有列，看守會判成沒跑。
test('sessions.md 讀不到：印 TAB_SWEEP_FAILED sessions 再印 SUMMARY，兩列都記，不動任何分頁', async () => {
  const main = fixture();
  try {
    rmSync(join(main, '.scratch/pilot/sessions.md'));
    mkdirSync(join(main, '.scratch/pilot/sessions.md'));
    const { lines, recorded, calls } = await run(main);
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /^TAB_SWEEP_FAILED sessions \S/);
    assert.equal(lines[1], 'SUMMARY sent=0 closed=0 skipped=0 failed=0 other=0');
    assert.deepEqual(recorded.map(r => r.split(' — ')[0]), lines);
    assert.deepEqual(sendsAndCloses(calls), []);
    assert.ok(!calls.some(c => c.startsWith('terminal read')), '不讀任何分頁的畫面');
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('screenBusy：esc to interrupt、spinner、…ing…、草稿、沒有空提示列都不算閒置；框線內的空 ❯ 算', () => {
  assert.equal(screenBusy(IDLE_SCREEN), null);
  assert.equal(screenBusy(['❯']), null);
  assert.equal(screenBusy(['● x', '❯ ']), null);
  assert.equal(screenBusy(BUSY_SCREEN), 'screen-busy');
  assert.equal(screenBusy(['  Running tests (esc to interrupt)', '❯']), 'screen-busy');
  assert.equal(screenBusy(['✻ Compacting conversation…', '❯']), 'screen-busy');
  assert.equal(screenBusy(['❯'], '/retro', ['/loop /issue-pilot']), 'screen-draft');
  assert.equal(screenBusy(['❯'], '打一半'), 'screen-draft');
  assert.equal(screenBusy(['❯ 打一半']), 'screen-no-prompt');
  assert.equal(screenBusy([]), 'screen-no-prompt');
});

// #713：Orca 的 draft 留著分頁啟動時送的 prompt（`/loop /issue-pilot`），畫面輸入框卻是空的 `❯`，每輪 TAB_SKIP screen-draft、分頁 193 分鐘沒關。
// G51 定案：draft 等於這個分頁已記下的啟動 prompt、最後一行 ❯ 提示列是空的，才當殘留；沒有記錄時退到「`/` 開頭的單行」加空提示列。
test('screenBusy：draft 是已記下的啟動 prompt、最後一行 ❯ 是空的才當殘留；沒有記錄時只放過 / 開頭的單行', () => {
  const launch = ['/loop /issue-pilot'];
  assert.equal(screenBusy(IDLE_SCREEN, '/loop /issue-pilot', launch), null);
  assert.equal(screenBusy(IDLE_SCREEN, '  /loop /issue-pilot\n', launch), null, '前後空白不算差別');
  assert.equal(screenBusy(IDLE_SCREEN, '/loop /issue-pilot 再補一句', launch), 'screen-draft', '不等於啟動 prompt');
  assert.equal(screenBusy(['❯', '❯ /loop /issue-pilot'], '/loop /issue-pilot', launch), 'screen-draft', '最後一行 ❯ 有字：真的打在輸入框');
  assert.equal(screenBusy(BUSY_SCREEN, '/loop /issue-pilot', launch), 'screen-busy');
  assert.equal(screenBusy(IDLE_SCREEN, '/loop /issue-pilot'), null, '沒有記錄：/ 開頭的單行放過');
  assert.equal(screenBusy(IDLE_SCREEN, '/retro', []), null);
  assert.equal(screenBusy(IDLE_SCREEN, '打一半的話'), 'screen-draft', '沒有記錄：不是 / 開頭');
  assert.equal(screenBusy(IDLE_SCREEN, '/loop\n/issue-pilot'), 'screen-draft', '沒有記錄：多行');
  assert.equal(screenBusy(['❯ /retro'], '/retro'), 'screen-draft', '沒有記錄：提示列有字');
});

test('殘留的啟動 prompt 不擋關分頁，真的草稿仍 TAB_SKIP screen-draft；送 /retro 後記下它；lastOutputAt 晚於現在不印負分鐘', async () => {
  const main = fixture();
  try {
    const terminals = [term('term_launch'), term('term_typed'), term('term_bare'), term('term_retro'), term('term_future', { lastOutputAt: NOW + 30_000 })];
    const titles = { term_launch: '待關閉｜Loop issue-pilot command', term_typed: '待關閉｜typed', term_bare: '待關閉｜bare', term_retro: '待 Retro｜r', term_future: '待關閉｜future' };
    const drafts = { term_launch: '/loop /issue-pilot', term_typed: '/loop /issue-pilot', term_bare: '/issue-run 12 --worker x' };
    const launches = { term_launch: ['/loop /issue-pilot'], term_typed: ['/issue-run 9 --worker y'] };
    const remembered = [];
    const { lines, calls } = await run(main, {
      fake: fakeOrca({ terminals, titles, drafts }), launched: handle => launches[handle] ?? [],
      remember: (handle, prompt) => remembered.push(`${handle} ${prompt}`),
    });
    assert.ok(lines.includes('TAB_CLOSED term_launch 待關閉｜Loop issue-pilot command'), lines.join('\n'));
    assert.ok(lines.includes('TAB_SKIP term_typed screen-draft'), '有記錄但 draft 不等於它');
    assert.ok(lines.includes('TAB_CLOSED term_bare 待關閉｜bare'), '沒有記錄：/ 開頭單行加空提示列');
    assert.ok(lines.includes('TAB_SKIP term_future not-idle 0m'));
    assert.ok(!lines.some(line => /not-idle -/.test(line)));
    assert.deepEqual(sendsAndCloses(calls), [
      'terminal close --terminal term_launch --tab',
      'terminal close --terminal term_bare --tab',
      'terminal send --terminal term_retro --text /retro --enter',
    ]);
    assert.deepEqual(remembered, ['term_retro /retro'], '送出的 /retro 也算這個分頁的已知 prompt');
    const dry = await run(main, { dryRun: true, fake: fakeOrca({ terminals: [term('term_r2')], titles: { term_r2: '待 Retro｜r2' } }), remember: (handle, prompt) => remembered.push(`${handle} ${prompt}`) });
    assert.ok(dry.lines.includes('TAB_RETRO_SENT term_r2 待 Retro｜r2 dry-run'));
    assert.deepEqual(remembered, ['term_retro /retro'], 'dry-run 不記');
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('認不出現任 coordinator 時整輪不動；split pane、同分頁其他 pane、roster 未收、roster 失敗都不關', async () => {
  const blind = fixture();
  try {
    writeFileSync(join(blind, '.scratch/pilot/sessions.md'), '');
    const { lines, calls, recorded } = await run(blind, { self: null });
    assert.deepEqual(lines, ['TAB_SWEEP_FAILED coordinator-unknown']);
    assert.deepEqual(calls, ['terminal list --include-visual-layouts']);
    assert.equal(recorded.length, 1);
  } finally {
    rmSync(blind, { recursive: true, force: true });
  }
  const main = fixture();
  try {
    const terminals = [term('term_a'), term('term_b'), term('term_c'), term('term_d'), term('term_e', { tabId: 'tab_term_d' })];
    const titles = { term_a: '待關閉｜a', term_b: '待關閉｜b', term_c: '待 Retro｜c', term_d: '待關閉｜d' };
    const roster = () => 'DONE 5d9e6069aa term_a /x.md\nCOLLECTED 11111111 term_b /y.md\nSUMMARY done=1\n';
    const { lines, calls } = await run(main, { roster, fake: fakeOrca({ terminals, titles, panes: { term_c: 'term_c2' } }) });
    assert.ok(lines.includes('TAB_SKIP term_a retro-uncollected DONE 5d9e6069'));
    assert.ok(lines.includes('TAB_CLOSED term_b 待關閉｜b'));
    assert.ok(lines.includes('TAB_SKIP term_c split-pane'));
    assert.ok(lines.includes('TAB_SKIP term_d shared-tab term_e'));
    assert.deepEqual(sendsAndCloses(calls), ['terminal close --terminal term_b --tab']);
    const broken = await run(main, { roster: () => { throw new Error('exit 1'); }, fake: fakeOrca({ terminals, titles, panes: { term_c: 'term_c2' } }) });
    assert.ok(broken.lines.includes('TAB_SWEEP_FAILED roster exit 1'));
    assert.ok(broken.lines.includes('TAB_SKIP term_a roster-failed'));
    assert.deepEqual(sendsAndCloses(broken.calls), []);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('送出失敗記 TAB_FAILED 不記 sent；enabled false 不呼叫 Orca；dry-run 不送不寫；list 失敗只記錄', async () => {
  const main = fixture();
  try {
    const { lines } = await run(main, { fake: fakeOrca({ fail: { send: 'send refused' } }) });
    assert.ok(lines.includes('TAB_FAILED term_retro retro-send send refused'));
    assert.deepEqual(JSON.parse(readFileSync(join(main, STATE_FILE), 'utf8')).sent, {});
    const down = await run(main, { fake: fakeOrca({ fail: { list: 'orca down' } }) });
    assert.deepEqual(down.lines, ['TAB_SWEEP_FAILED terminal-list orca down']);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
  const off = fixture({ enabled: false, sent: {} });
  try {
    const { lines, calls, recorded } = await run(off);
    assert.deepEqual(lines, ['TAB_SWEEP_OFF']);
    assert.deepEqual(calls, []);
    assert.deepEqual(recorded.map(r => r.split(' — ')[0]), ['TAB_SWEEP_OFF'], '暫停中也記一筆，看守分得出沒跑與暫停');
  } finally {
    rmSync(off, { recursive: true, force: true });
  }
  const dry = fixture();
  try {
    const { lines, calls, recorded } = await run(dry, { dryRun: true });
    assert.ok(lines.includes('TAB_RETRO_SENT term_retro 待 Retro｜refine 1100 dry-run'));
    assert.deepEqual(sendsAndCloses(calls), []);
    assert.deepEqual(recorded, []);
    assert.throws(() => readFileSync(join(dry, STATE_FILE)));
  } finally {
    rmSync(dry, { recursive: true, force: true });
  }
});

test('inMain、coordinatorHandle、rosterRows', () => {
  assert.ok(inMain(MAIN, MAIN));
  assert.ok(inMain(`${MAIN}/`, MAIN));
  assert.ok(inMain('\\\\wsl.localhost\\Ubuntu\\home\\ron\\code\\proj', MAIN));
  assert.ok(!inMain('\\\\wsl.localhost\\Ubuntu\\home\\ron\\code\\proj-x', MAIN));
  assert.ok(!inMain('/mnt/x/home/ron/code/proj', MAIN));
  assert.ok(!inMain('', MAIN));
  assert.equal(coordinatorHandle('a → terminal term_a reason x\nb → terminal term_b reason y'), 'term_b');
  assert.equal(coordinatorHandle(''), null);
  assert.deepEqual(rosterRows('DONE a term_x\nPENDING b -\nX y\n').map(r => [r.state, r.handle]), [['DONE', 'term_x'], ['PENDING', null]]);
});

test('CLI：經假 Orca 送 /retro、關分頁，decisions.md 由 pilot-decision.mjs 記列；沒有 ORCA_CLI_COMMAND 時不動', () => {
  const temp = mkdtempSync(join(realTmpdir(), 'tab-sweep-cli-'));
  try {
    const main = join(temp, 'main');
    mkdirSync(join(main, 'scripts'), { recursive: true });
    for (const name of scriptClosure(HERE, ['tab-sweep.mjs'])) {
      mkdirSync(join(main, 'scripts', name, '..'), { recursive: true });
      copyFileSync(join(HERE, name), join(main, 'scripts', name));
    }
    mkdirSync(join(main, '.scratch/pilot'), { recursive: true });
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    const log = join(temp, 'orca.log');
    const terminals = [term('term_r', { worktreePath: main }), term('term_c', { worktreePath: main })];
    writeFileSync(join(bin, 'orca'), `#!/usr/bin/env node
const fs = require('fs'); const [, b] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${orcaReplySource()}
if (b === 'list') reply('list-visual', ${JSON.stringify({ terminals, visualLayouts: layouts({ term_r: '待 Retro｜r', term_c: '待關閉｜c' }) })});
else if (b === 'read') reply('read', { terminal: { tail: ['❯'], draft: '' } });
else if (b === 'send') reply('send');
else if (b === 'close') reply('close');
else fail('unknown');
`);
    chmodSync(join(bin, 'orca'), 0o755);
    const cli = (env, ...args) => spawnSync(process.execPath, [join(main, 'scripts/tab-sweep.mjs'), main, ...args], {
      encoding: 'utf8', env: { ...process.env, TAB_SWEEP_NOW: new Date(NOW).toISOString(), TAB_STATE_DIR: join(temp, 'titles'), ...env },
    });
    const none = cli({});
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout.trim(), 'TAB_SWEEP_FAILED no-orca');
    const result = cli({ ORCA_CLI_COMMAND: join(bin, 'orca'), ORCA_TERMINAL_HANDLE: 'term_me' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^TAB_RETRO_SENT term_r 待 Retro｜r$/m);
    assert.match(result.stdout, /^TAB_CLOSED term_c 待關閉｜c$/m);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /^terminal send --terminal term_r --text \/retro --enter --json$/m);
    assert.match(calls, /^terminal close --terminal term_c --tab --json$/m);
    const decisions = readFileSync(join(main, '.scratch/pilot/decisions.md'), 'utf8');
    assert.match(decisions, /\| Tab sweep：TAB_SWEEP_FAILED no-orca \|/);
    assert.match(decisions, /\| Tab sweep：TAB_RETRO_SENT term_r 待 Retro｜r \|/);
    assert.match(decisions, /\| Tab sweep：TAB_CLOSED term_c 待關閉｜c \|/);
    assert.match(decisions, /\| Tab sweep：SUMMARY sent=1 closed=1 skipped=0 failed=0 other=0 \|/);
    assert.equal(cli({}, '--roster').status, 2);
    // #646 review：decisions.md 寫不進去時不能只在 stderr 說，否則看守的「有 tick 沒這一列就是沒跑」會誤判。
    rmSync(join(main, '.scratch/pilot/decisions.md'));
    mkdirSync(join(main, '.scratch/pilot/decisions.md'));
    const unrecorded = cli({ ORCA_CLI_COMMAND: join(bin, 'orca'), ORCA_TERMINAL_HANDLE: 'term_me' });
    assert.notEqual(unrecorded.status, 0, unrecorded.stdout);
    assert.match(unrecorded.stdout, /^SUMMARY sent=\d+ closed=\d+ skipped=\d+ failed=\d+ other=\d+$/m, 'SUMMARY 照印');
    assert.match(unrecorded.stdout.trim().split('\n').at(-1), /^TAB_RECORD_FAILED \d+ \S/);
    const unrecordedOff = cli({});
    assert.notEqual(unrecordedOff.status, 0);
    assert.match(unrecordedOff.stdout, /^TAB_SWEEP_FAILED no-orca\nTAB_RECORD_FAILED \d+ \S/);
    // tab-sweep.json 也寫不進去時不拋錯中斷：印 TAB_SWEEP_FAILED state、SUMMARY 照印，最後仍是 TAB_RECORD_FAILED。
    rmSync(join(main, '.scratch/pilot/tab-sweep.json'), { force: true });
    mkdirSync(join(main, '.scratch/pilot/tab-sweep.json'));
    const bothFailed = cli({ ORCA_CLI_COMMAND: join(bin, 'orca'), ORCA_TERMINAL_HANDLE: 'term_me' });
    assert.equal(bothFailed.status, 1, bothFailed.stderr);
    assert.match(bothFailed.stdout, /(^|\n)TAB_SWEEP_FAILED state \S[^\n]*\nSUMMARY [^\n]*\nTAB_RECORD_FAILED \d+ \S[^\n]*\n$/);
    // 只有 tab-sweep.json 寫不進去：TAB_SWEEP_FAILED state 與 SUMMARY 都記進 decisions.md，exit 0。
    rmSync(join(main, '.scratch/pilot/decisions.md'), { recursive: true });
    const stateFailed = cli({ ORCA_CLI_COMMAND: join(bin, 'orca'), ORCA_TERMINAL_HANDLE: 'term_me' });
    assert.equal(stateFailed.status, 0, stateFailed.stderr);
    const rows = readFileSync(join(main, '.scratch/pilot/decisions.md'), 'utf8');
    assert.match(rows, /\| Tab sweep：TAB_SWEEP_FAILED state \S/);
    assert.match(rows, /\| Tab sweep：SUMMARY sent=/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
