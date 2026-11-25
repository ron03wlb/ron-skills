// spay2 retro 83f3b2b9#1：pilot-status 以 `node scripts/issue-queue.mjs` 呼叫子程序、失敗時吞掉，fixture repo 沒有這支腳本，
// 新斷言在未修正的程式上照樣通過；改 symlink 也一樣（主程式判定不 realpath 時 exit 0、stdout 空）。stubMainScript 寫轉呼叫的 wrapper。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { repoFixture, stubMainScript } from '../skills/engineering/setup-workflow/templates/test/repo-fixture.mjs';

// 真實腳本的樣子：主程式判定不 realpath（issue-queue.mjs:1502 的寫法），印 cwd 與參數，FAKE_EXIT 決定 exit code，FAKE_SIGNAL 讓自己被 signal 結束
const MAIN = "import { pathToFileURL } from 'node:url';\n"
  + "if (import.meta.url === pathToFileURL(process.argv[1]).href) {\n"
  + "  process.stdout.write(`cwd=${process.cwd()} args=${process.argv.slice(2).join(',')}\\n`);\n"
  + "  if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);\n"
  + "  process.exit(Number(process.env.FAKE_EXIT ?? 0));\n}\n";

function sourceDir(t) {
  const dir = mkdtempSync(join(realTmpdir(), 'repo-fixture-src-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'queue.mjs'), MAIN);
  writeFileSync(join(dir, 'gate.sh'), 'echo "sh cwd=$PWD args=$*"\nexit "${FAKE_EXIT:-0}"\n');
  return dir;
}
const node = (cwd, args, env = {}) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

test('fixture 缺腳本時子程序失敗；symlink 進 fixture 則 exit 0 但 stdout 空（重現 83f3b2b9#1）', t => {
  const src = sourceDir(t);
  const { repo } = repoFixture(t);
  assert.notEqual(node(repo, ['scripts/queue.mjs']).status, 0);
  mkdirSync(join(repo, 'scripts'));
  symlinkSync(join(src, 'queue.mjs'), join(repo, 'scripts/queue.mjs'));
  const linked = node(repo, ['scripts/queue.mjs', '--pilot-order']);
  assert.equal(linked.status, 0);
  assert.equal(linked.stdout, '');
});

test('stubMainScript：wrapper 以 fixture repo 為 cwd 執行真實腳本，參數與 stdout 照傳、exit code 照回', t => {
  const src = sourceDir(t);
  const { repo } = repoFixture(t);
  assert.equal(stubMainScript(repo, 'queue.mjs', src), join(repo, 'scripts/queue.mjs'));
  const ok = node(repo, ['scripts/queue.mjs', '--pilot-order', '--table']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `cwd=${repo} args=--pilot-order,--table\n`);
  assert.equal(node(repo, ['scripts/queue.mjs'], { FAKE_EXIT: '3' }).status, 3);
});

test('stubMainScript：真實腳本被 signal 結束時 wrapper exit 非 0，不當成成功', t => {
  const src = sourceDir(t);
  const { repo } = repoFixture(t);
  stubMainScript(repo, 'queue.mjs', src);
  const killed = node(repo, ['scripts/queue.mjs'], { FAKE_SIGNAL: 'SIGTERM' });
  assert.equal(killed.status, 1, killed.stderr);
});

test('stubMainScript：.sh 以 bash 轉呼叫；sourceDir 預設為範本 scripts 目錄', t => {
  const src = sourceDir(t);
  const { repo } = repoFixture(t);
  stubMainScript(repo, 'gate.sh', src);
  const sh = spawnSync('bash', ['scripts/gate.sh', 'a', 'b'], { cwd: repo, encoding: 'utf8', env: { ...process.env, FAKE_EXIT: '4' } });
  assert.equal(sh.status, 4);
  assert.equal(sh.stdout, `sh cwd=${repo} args=a b\n`);
  stubMainScript(repo, 'adapter-line.mjs');
  const real = node(repo, ['scripts/adapter-line.mjs', '--list']);
  // 真正的 adapter-line.mjs 以 fixture repo 為 cwd 跑：fixture 沒有預算表，exit 2（用法錯誤或沒有預算表），不是 MODULE_NOT_FOUND
  assert.equal(real.status, 2, real.stderr);
  assert.doesNotMatch(real.stderr, /MODULE_NOT_FOUND/);
});
