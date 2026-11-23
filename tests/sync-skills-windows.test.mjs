// Windows 目標（windows-skills.txt → Windows ~/.claude/skills）：Orca bot 是 Windows 上的 Claude Code，只讀 Windows 的 ~/.claude/skills，
// sync-skills 原本只寫 WSL 的 ~/.claude/skills，ron-skills 的 skill bot 都看不到。interop 以假的 wslpath、cmd.exe 代替，CI 上也能跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { release } from 'node:os';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const sync = join(root, 'bin/sync-skills');
// NODE_OPTIONS 也不傳：bin/check 經 node-test-guarded 跑時帶 `--import <preload>`，有 --import 時 node 拒載副檔名 .exe 的入口檔
// （假 cmd.exe 印 ERR_UNKNOWN_FILE_EXTENSION、exit 1，#483 改經 guard 後才出現）。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'SKILL_DIRS' && key !== 'WIN_SKILL_DIR' && key !== 'NODE_OPTIONS'));
const UNC = '\\\\wsl.localhost\\Fake';
const toWin = path => UNC + path.replaceAll('/', '\\');
const commonDir = spawnSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', env }).stdout.trim();
const expected = toWin(join(dirname(resolve(root, commonDir)), 'skills/productivity/session-handoff'));
const listed = readFileSync(join(root, 'windows-skills.txt'), 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));

// 假 cmd.exe：Windows 原生連結以「目標是 \\ 開頭的 POSIX symlink」表示；WSL 專用 symlink（目標是 / 開頭）不出現在 dir /AL。
const FAKE_WSLPATH = `#!/usr/bin/env node
const [flag, path] = process.argv.slice(2);
if (flag !== '-w') process.exit(1);
console.log(${JSON.stringify(UNC)} + path.replaceAll('/', '\\\\'));
`;
const FAKE_CMD = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const unix = win => win.slice(${JSON.stringify(UNC)}.length).replaceAll('\\\\', '/');
const [, verb, ...rest] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CMD_LOG, [verb, ...rest].join(' ') + '\\n');
if (verb === 'mklink') {
  if (process.env.FAKE_MKLINK_FAIL) process.exit(1);
  fs.symlinkSync(rest[2], unix(rest[1]));
} else if (verb === 'rmdir') {
  fs.unlinkSync(unix(rest[0]));
} else if (verb === 'dir') {
  const dir = unix(rest[1]);
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p).startsWith('\\\\')) console.log('2026/11/20  16:46    <SYMLINKD>     ' + name + ' [' + fs.readlinkSync(p) + ']');
  }
} else process.exit(1);
`;

function setup(t) {
  const tmp = mkdtempSync(join(realTmpdir(), 'sync-skills-win-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const bin = join(tmp, 'bin'), win = join(tmp, 'win-skills'), log = join(tmp, 'cmd.log');
  mkdirSync(bin);
  mkdirSync(win);
  writeFileSync(join(bin, 'wslpath'), FAKE_WSLPATH, { mode: 0o755 });
  writeFileSync(join(bin, 'cmd.exe'), FAKE_CMD, { mode: 0o755 });
  writeFileSync(log, '');
  const extra = { PATH: `${bin}:${env.PATH}`, FAKE_CMD_LOG: log, WIN_SKILL_DIR: win, SKILL_DIRS: join(tmp, 'wsl'), HOOK_DIR: join(tmp, 'hooks'), XDG_DATA_HOME: join(tmp, 'xdg'), GIT_HOOKS_DIR: join(tmp, 'git-hooks') };
  const run = (args, more = {}) => spawnSync(sync, args, { encoding: 'utf8', cwd: root, env: { ...env, ...extra, ...more } });
  const mklinks = () => readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('mklink'));
  return { tmp, win, run, mklinks };
}

// #400：owner 決定給 Orca bot retro（overlay 副本）、daily-summary、explain；依賴 WSL 主 checkout 的 issue-run、issue-pilot 等不給。
test('windows-skills.txt 列 #400 決定的 skill；每一行是本 repo 的 skill，或 overlay/<名稱> 且 overlays/<名稱>.patch 存在', () => {
  for (const rel of ['productivity/session-handoff', 'productivity/daily-summary', 'productivity/explain', 'overlay/retro']) assert.ok(listed.includes(rel), rel);
  for (const rel of ['engineering/issue-run', 'engineering/issue-pilot', 'engineering/retro-collect', 'engineering/issue-queue']) assert.ok(!listed.includes(rel), rel);
  for (const rel of listed) {
    if (rel.startsWith('overlay/')) assert.ok(existsSync(join(root, 'overlays', `${rel.slice('overlay/'.length)}.patch`)), rel);
    else assert.ok(existsSync(join(root, 'skills', rel, 'SKILL.md')), rel);
  }
});

test('overlay/<名稱> 項目的 Windows 連結指向 overlay build；--check 對指向 overlay build、不在清單上的連結印 WIN_ORPHAN', t => {
  const { tmp, win, run } = setup(t);
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  const build = join(tmp, 'xdg/ron-skills/overlay');
  assert.equal(readlinkSync(join(win, 'retro')), toWin(join(build, 'retro')));
  assert.ok(existsSync(join(build, 'retro/SKILL.md')));

  const removed = toWin(join(build, 'code-review'));
  symlinkSync(removed, join(win, 'removed-overlay'));
  const check = run(['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stderr, new RegExp(`^WIN_ORPHAN ${join(win, 'removed-overlay')} -> ${removed.replaceAll('\\', '\\\\')}（`, 'm'));
  assert.doesNotMatch(check.stderr, /^WIN_(MISSING|WRONG|NOT_LINK|ORPHAN) \S+\/retro\b/m);
});

test('同步在 Windows 目標建立指向主 checkout 的原生連結；清單外的項目一律不碰；再跑不重建', t => {
  const { tmp, win, run, mklinks } = setup(t);
  symlinkSync('\\??\\C:\\Workspace\\open_source\\skills\\skills\\engineering\\ask-matt', join(win, 'ask-matt'));
  symlinkSync(join(root, 'skills/engineering/issue-run'), join(win, 'issue-run'));
  mkdirSync(join(win, 'learned'));
  writeFileSync(join(win, 'learned/note.md'), 'x');

  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(join(win, 'session-handoff')), expected);
  assert.match(result.stderr, new RegExp(`^WIN_LINKED ${join(win, 'session-handoff')} -> `, 'm'));
  // 清單每一項各建一次（#400 起不只 session-handoff）
  assert.ok(mklinks().includes(`mklink /D ${toWin(join(win, 'session-handoff'))} ${expected}`));
  assert.equal(mklinks().length, listed.length);
  assert.equal(readlinkSync(join(win, 'ask-matt')), '\\??\\C:\\Workspace\\open_source\\skills\\skills\\engineering\\ask-matt');
  assert.equal(readlinkSync(join(win, 'issue-run')), join(root, 'skills/engineering/issue-run'));
  assert.equal(readFileSync(join(win, 'learned/note.md'), 'utf8'), 'x');
  // WSL 目標照舊收到本 repo 的 skill
  assert.equal(readlinkSync(join(tmp, 'wsl/session-handoff')), join(root, 'skills/productivity/session-handoff'));

  const again = run([]);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /WIN_LINKED/);
  assert.equal(mklinks().length, listed.length);
});

test('同步更新指錯的 Windows 連結與 WSL 專用 symlink；同名實體目錄不覆蓋', t => {
  const { win, run } = setup(t);
  symlinkSync('\\\\wsl.localhost\\Fake\\old\\session-handoff', join(win, 'session-handoff'));
  assert.equal(run([]).status, 0);
  assert.equal(readlinkSync(join(win, 'session-handoff')), expected);

  rmSync(join(win, 'session-handoff'));
  symlinkSync(join(root, 'skills/productivity/session-handoff'), join(win, 'session-handoff'));
  assert.equal(run([]).status, 0);
  assert.equal(readlinkSync(join(win, 'session-handoff')), expected);

  rmSync(join(win, 'session-handoff'));
  mkdirSync(join(win, 'session-handoff'));
  const kept = run([]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stderr, new RegExp(`^SKIP ${join(win, 'session-handoff')}（實體目錄或檔案，不覆蓋）$`, 'm'));
  assert.equal(lstatSync(join(win, 'session-handoff')).isDirectory(), true);
});

test('--check 回報 Windows 連結缺少、指錯或被實體目錄占用，不改任何東西也不影響 exit', t => {
  const { win, run, mklinks } = setup(t);
  const missing = run(['--check']);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, new RegExp(`^WIN_MISSING ${join(win, 'session-handoff')}（`, 'm'));
  assert.equal(existsSync(join(win, 'session-handoff')), false);

  symlinkSync(join(root, 'skills/productivity/session-handoff'), join(win, 'session-handoff'));
  const wsl = run(['--check']);
  assert.match(wsl.stderr, /^WIN_WRONG \S+session-handoff -> .*WSL 專用 symlink/m);

  rmSync(join(win, 'session-handoff'));
  mkdirSync(join(win, 'session-handoff'));
  assert.match(run(['--check']).stderr, /^WIN_NOT_LINK \S+session-handoff/m);

  rmSync(join(win, 'session-handoff'), { recursive: true });
  assert.equal(run([]).status, 0);
  const ok = run(['--check']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /^WIN_/m);
  assert.equal(mklinks().length, listed.length);
});

// #389-2：從 windows-skills.txt 移除的項目，同步不刪 Windows 端的連結（清單外一律不碰），之前也沒有任何管道會發現。
// 「移除過的項目」以指向本 repo、但不在清單上的 Windows 連結表示：連結名不是任何 skill 名，日後清單加項目也不會撞到。
test('--check 對指向本 repo、但不在清單上的 Windows 連結印 WIN_ORPHAN；其他來源與清單上的不印；同步也不刪', t => {
  const { win, run } = setup(t);
  const mainRoot = dirname(resolve(root, commonDir));
  const removed = toWin(join(mainRoot, 'skills/engineering/issue-pilot'));
  const fromWorktree = toWin(join(root, 'skills/engineering/issue-run'));
  const external = '\\??\\C:\\Workspace\\open_source\\skills\\skills\\engineering\\ask-matt';
  symlinkSync(removed, join(win, 'removed-main'));
  symlinkSync(fromWorktree, join(win, 'removed-worktree'));
  symlinkSync(external, join(win, 'ask-matt'));
  assert.equal(run([]).status, 0);

  const result = run(['--check']);
  assert.equal(result.status, 0, result.stderr);
  const orphans = result.stderr.split('\n').filter(line => line.startsWith('WIN_ORPHAN'));
  assert.deepEqual(orphans.map(line => line.replace(/（.*$/, '')).sort(), [
    `WIN_ORPHAN ${join(win, 'removed-main')} -> ${removed}`,
    `WIN_ORPHAN ${join(win, 'removed-worktree')} -> ${fromWorktree}`,
  ]);
  // 只看 WIN_ORPHAN 行：macOS 上 WSL 端的 EXTERNAL 行也會帶出 ask-matt 這類名稱（PR #404 的 checks-macos）。
  assert.doesNotMatch(orphans.join('\n'), /ask-matt|session-handoff/);
  assert.equal(readlinkSync(join(win, 'removed-main')), removed);
  assert.equal(readlinkSync(join(win, 'ask-matt')), external);
});

// 實測：沒開開發人員模式、不是系統管理員時 mklink /D 回「沒有足夠的權限」。
test('mklink 失敗時印 WIN_LINK_FAILED 並 exit 1，WSL 目標仍照常同步', t => {
  const { tmp, win, run } = setup(t);
  const result = run([], { FAKE_MKLINK_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`^WIN_LINK_FAILED ${join(win, 'session-handoff')}：.*開發人員模式`, 'm'));
  assert.match(result.stdout, /^SYNCED \d+ skills/m);
  assert.equal(readlinkSync(join(tmp, 'wsl/session-handoff')), join(root, 'skills/productivity/session-handoff'));
});

test('WIN_SKILL_DIR 空字串，或只設 SKILL_DIRS 時略過 Windows 目標並印一行說明', t => {
  const { run, mklinks } = setup(t);
  const empty = run([], { WIN_SKILL_DIR: '' });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stderr, /^WIN_SKIP WIN_SKILL_DIR 是空字串/m);
  const custom = spawnSync(sync, ['--check'], { encoding: 'utf8', cwd: root, env: { ...env, SKILL_DIRS: join(realTmpdir(), 'none') } });
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.stderr, /^WIN_SKIP 有設 SKILL_DIRS/m);
  assert.deepEqual(mklinks(), []);
});

const onWsl = Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(release());
test('不在 WSL 時 --check 略過 Windows 目標，exit 0（CI 的 ubuntu、macOS）', { skip: onWsl && '這台是 WSL' }, () => {
  const result = spawnSync(sync, ['--check'], { encoding: 'utf8', cwd: root, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^WIN_SKIP 不在 WSL 或沒有 \/mnt\/c/m);
});
