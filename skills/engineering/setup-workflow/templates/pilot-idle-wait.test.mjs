import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./pilot-idle-wait.mjs', import.meta.url).pathname;
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// 暫存的主 checkout（有 pilot/integration 分支）＋ 一份 scripts/：pilot-idle-wait.mjs 的副本與假 pilot-probe.mjs。
// 假 probe 第 i 次被呼叫時印 rounds[i]（超過就印最後一個）的 lines，並先做它的 act：
//   gates → 改寫 .scratch/pilot/gates.md；commit → 在整合分支加一個 commit；fail → stderr 印一行並 exit 3。
// 每次呼叫的參數記進 probe.log。
function fixture(t, rounds) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-idle-wait-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const checkout = join(temp, 'checkout');
  mkdirSync(join(checkout, '.scratch/pilot'), { recursive: true });
  git(temp, 'init', '-q', '-b', 'main', checkout);
  git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git(checkout, 'branch', 'pilot/integration');
  writeFileSync(join(checkout, '.scratch/pilot/gates.md'), '# gates\n');
  const scripts = join(temp, 'scripts');
  mkdirSync(scripts);
  copyFileSync(script, join(scripts, 'pilot-idle-wait.mjs'));
  const log = join(temp, 'probe.log');
  writeFileSync(join(scripts, 'pilot-probe.mjs'), `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const rounds = ${JSON.stringify(rounds)};
const counter = ${JSON.stringify(join(temp, 'count'))};
const i = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(i + 1));
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const round = rounds[Math.min(i, rounds.length - 1)];
const checkout = process.argv[2];
if (round.act === 'gates') writeFileSync(checkout + '/.scratch/pilot/gates.md', '# gates\\n| G1 | #9 | 問題 | resolved 選 A |\\n');
if (round.act === 'commit') spawnSync('git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', '-m', 'x', '-p', 'pilot/integration', 'pilot/integration^{tree}'], { encoding: 'utf8' }).stdout.trim()
  .replace(/.+/, sha => spawnSync('git', ['-C', checkout, 'update-ref', 'refs/heads/pilot/integration', sha]));
if (round.act === 'fail') { process.stderr.write('gh: API rate limit\\n'); process.exit(3); }
process.stdout.write(round.lines.map(line => line + '\\n').join(''));
`);
  const run = (args = []) => spawnSync('node', [join(scripts, 'pilot-idle-wait.mjs'), checkout, '--interval', '0.02', ...args], { encoding: 'utf8', timeout: 20000 });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n');
  return { checkout, run, calls };
}

const idle = { lines: ['POOL_EMPTY'] };

test('probe 輸出一直不變：不結束，跑到上限時間印 IDLE_TIMEOUT', t => {
  const { run, calls } = fixture(t, [idle]);
  const result = run(['--max-wait', '1.5']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^IDLE_TIMEOUT 1\.5\n$/);
  assert.ok(calls().length >= 3, `probe 只跑了 ${calls().length} 次`);
});

test('probe 出現基準沒有的新行：結束並印那一行', t => {
  const { run, calls } = fixture(t, [idle, idle, { lines: ['POOL_READY 412', 'GATE G3 #9 要不要改格式'] }]);
  const result = run(['--max-wait', '30']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WAKE probe POOL_READY 412\nWAKE probe GATE G3 #9 要不要改格式\n');
  assert.equal(calls().length, 3);
});

test('probe 少了一行、其餘不變：不算變化', t => {
  const { run } = fixture(t, [{ lines: ['POOL_EMPTY', 'BEHIND_MAIN 1 abc'] }, idle]);
  const result = run(['--max-wait', '0.2']);
  assert.match(result.stdout, /^IDLE_TIMEOUT /);
});

test('gate 檔變了：結束並印 WAKE gates', t => {
  const { run } = fixture(t, [idle, { ...idle, act: 'gates' }]);
  const result = run(['--max-wait', '30']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WAKE gates .scratch/pilot/gates.md\n');
});

test('整合分支 HEAD 移動：結束並印新舊 SHA', t => {
  const { checkout, run } = fixture(t, [idle, { ...idle, act: 'commit' }]);
  const before = git(checkout, 'rev-parse', 'pilot/integration');
  const result = run(['--max-wait', '30']);
  const after = git(checkout, 'rev-parse', 'pilot/integration');
  assert.notEqual(before, after);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `WAKE integration ${before.slice(0, 7)} ${after.slice(0, 7)}\n`);
});

test('--integration、--main 原樣交給 probe，整合分支照 --integration 讀', t => {
  const { checkout, run, calls } = fixture(t, [idle, { ...idle, act: 'commit' }]);
  git(checkout, 'branch', 'int2');
  const result = run(['--max-wait', '0.2', '--integration', 'int2', '--main', 'trunk']);
  assert.match(result.stdout, /^IDLE_TIMEOUT /);
  assert.equal(calls()[0], `${checkout} --integration int2 --main trunk`);
});

test('probe 失敗一次只警告；連續 3 次失敗印 ERROR、exit 1', t => {
  const once = fixture(t, [idle, { act: 'fail' }, { lines: ['POOL_READY 5'] }]);
  const recovered = once.run(['--max-wait', '30']);
  assert.equal(recovered.stdout, 'WAKE probe POOL_READY 5\n');
  assert.match(recovered.stderr, /WARN probe exit 3 gh: API rate limit/);
  const broken = fixture(t, [idle, { act: 'fail' }]);
  const result = broken.run(['--max-wait', '30']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'ERROR probe exit 3 rounds 3 gh: API rate limit\n');
});

test('用法錯誤 exit 2', t => {
  const { run } = fixture(t, [idle]);
  assert.equal(run(['--max-wait', '0']).status, 2);
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(spawnSync('node', [script], { encoding: 'utf8' }).status, 2);
});
