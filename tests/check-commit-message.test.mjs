import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkMessage } from '../scripts/check-commit-message.mjs';
import { env, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/check-commit-message.mjs', import.meta.url).pathname;
const hook = new URL('../.githooks/commit-msg', import.meta.url).pathname;

// retro spay2 ff00a288#2：46134ee 的訊息前三行原樣（`git commit -F -` 的 heredoc 第一行後沒空行）。
const MSG_46134EE = [
  'chore: retro 1119b git-bypass 只認被執行程式、pilot Entry 指令',
  '- claude-hook-git-bypass.mjs：node --check／-c、變數與陣列指派、-e 內動態 import 不再當成執行 gate 腳本；--whole-output 改用同一套執行判定；--exit-gate 對 update-issue-body／fix-land／check-contracts 的 --help 接管線放行（retro spay2 db0c0090#2、05f4385f#3）。',
  '- issue-pilot SKILL：Entry 先跑 adapter 的 entry 指令（ENTRY coordinator／retired／yield）；coordinator 檔只在 Entry 寫一次（retro spay2 b0cd7ce1#8、#10）。',
  '',
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
  '',
].join('\n');

test('第二行非空就擋（46134ee）；空行分隔的訊息通過；註解行與 scissors 以下不算', () => {
  assert.deepEqual(checkMessage(MSG_46134EE).errors, ['COMMIT_MSG_SECOND_LINE - claude-hook-git-bypass.mjs：node --check／-c、變數與陣列指派、-e 內動態']);
  assert.deepEqual(checkMessage('chore: retro 1119b 修正\n\n- 內文\n'), { errors: [], advisories: [] });
  assert.deepEqual(checkMessage('chore: 只有主旨\n').errors, []);
  assert.deepEqual(checkMessage('\nchore: x\n# Please enter the commit message\n\nbody\n# ------------------------ >8 ------------------------\ndiff\n').errors, []);
  assert.deepEqual(checkMessage('chore: x\n# 註解\nbody\n').errors, ['COMMIT_MSG_SECOND_LINE body']);
});

// #636：#395 worker 的訊息檔（主旨 `#395 Push gate 單一入口：…`、第二行空行）。`#` 開頭的主旨被當註解刪掉，內文第一行頂上來當主旨。
const MSG_395 = '#395 Push gate 單一入口：x\n\n內文第一行\n內文第二行\n';
// 同一則訊息刪掉 `#` 行之後（`git stripspace --strip-comments` 的輸出）。
const MSG_395_STRIPPED = '內文第一行\n內文第二行\n';

test('主旨以 # 開頭被刪掉後擋下時，修正提示點出 # 主旨與括號寫法（#636）', t => {
  const temp = mkdtempSync(join(realTmpdir(), 'commit-msg-hash-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const [name, raw] of [['raw', MSG_395], ['stripped', MSG_395_STRIPPED]]) {
    assert.deepEqual(checkMessage(raw).errors, ['COMMIT_MSG_SECOND_LINE 內文第二行'], name);
    write(temp, { [name]: raw });
    const result = spawnSync('node', [script, join(temp, name)], { encoding: 'utf8', env });
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /主旨以 `#` 開頭時會被當成註解刪掉/, name);
    assert.match(result.stderr, /Issue 編號放在括號裡，例如 `Push gate（#395）：…`/, name);
  }
  assert.deepEqual(checkMessage('Push gate（#395）：x\n\n內文第一行\n內文第二行\n').errors, [], '主旨改成括號後通過');
});

test('主旨描述超過 50 字只印 advisory，不擋', () => {
  const long = `chore: ${'字'.repeat(51)}\n\nbody\n`;
  assert.deepEqual(checkMessage(long), { errors: [], advisories: ['SUBJECT_TOO_LONG 51 字（advisory，上限 50）'] });
  assert.deepEqual(checkMessage(`chore: ${'字'.repeat(50)}\n`).advisories, []);
});

test('.githooks/commit-msg：git commit 時第二行非空 exit 1 不提交，正確訊息照常提交', t => {
  const temp = mkdtempSync(join(realTmpdir(), 'commit-msg-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  mkdirSync(join(temp, 'scripts'));
  mkdirSync(join(temp, '.githooks'));
  cpSync(script, join(temp, 'scripts/check-commit-message.mjs'));
  cpSync(hook, join(temp, '.githooks/commit-msg'));
  chmodSync(join(temp, '.githooks/commit-msg'), 0o755);
  git(temp, 'init', '-q', '-b', 'main');
  git(temp, 'config', 'core.hooksPath', '.githooks');
  write(temp, { 'a.txt': 'a\n' });
  git(temp, 'add', '.');
  const commit = input => spawnSync('git', ['-C', temp, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-F', '-'], { input, encoding: 'utf8', env });
  const bad = commit(MSG_46134EE);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /^COMMIT_MSG_SECOND_LINE - claude-hook-git-bypass\.mjs/m);
  assert.equal(spawnSync('git', ['-C', temp, 'rev-parse', '--verify', '-q', 'HEAD'], { env }).status, 1, '不該有 commit');
  const good = commit('chore: 修正\n\n內文\n');
  assert.equal(good.status, 0, good.stderr);
});

test('--rev 讀已存在 commit；用法錯誤 exit 2', t => {
  const temp = mkdtempSync(join(realTmpdir(), 'commit-msg-rev-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  git(temp, 'init', '-q', '-b', 'main');
  write(temp, { msg: 'chore: x\nbody\n' });
  git(temp, 'commit', '-q', '--allow-empty', '-F', join(temp, 'msg'));
  const result = spawnSync('node', [script, '--rev', 'HEAD'], { cwd: temp, encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^COMMIT_MSG_SECOND_LINE body$/m);
  assert.equal(spawnSync('node', [script], { encoding: 'utf8', env }).status, 2);
});
