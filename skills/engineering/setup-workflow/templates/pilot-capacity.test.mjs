import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineTotal, readLedger, report } from './pilot-capacity.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-capacity.mjs', import.meta.url));
const ledger = t => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-capacity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state/pilot-workers.tsv');
};
const run = (file, args, extra = {}) => {
  const env = { ...process.env, PILOT_WORKERS_LEDGER: file, ...extra };
  if (!('PILOT_MACHINE_WORKER_CAP' in extra)) delete env.PILOT_MACHINE_WORKER_CAP;
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
};
const NOW = new Date('2026-10-31T12:00:00+08:00');
const ago = minutes => new Date(NOW.getTime() - minutes * 60000).toISOString();

test('report 只改寫自己那一列，其他 repo 的列原樣保留；沒有帳本時建出來', t => {
  const file = ledger(t);
  assert.deepEqual(report(file, 'ron-skills', 2, { now: NOW, cap: 4 }), { total: 2, cap: 4 });
  assert.equal(readFileSync(file, 'utf8'), `ron-skills\t2\t${NOW.toISOString()}\n`);
  writeFileSync(file, `${readFileSync(file, 'utf8')}investing\t1\t${ago(5)}\n`);
  assert.deepEqual(report(file, 'ron-skills', 3, { now: NOW, cap: 4 }), { total: 4, cap: 4 });
  assert.equal(readFileSync(file, 'utf8'), `ron-skills\t3\t${NOW.toISOString()}\ninvesting\t1\t${ago(5)}\n`);
});

test('合計不算超過 2 小時沒更新的列與壞掉的列', t => {
  const file = ledger(t);
  report(file, 'x', 0, { now: NOW });
  writeFileSync(file, `a\t2\t${ago(119)}\nb\t3\t${ago(121)}\nc\tmany\t${ago(1)}\nd\t1\tyesterday\ngarbage\n`);
  assert.equal(machineTotal(readLedger(file), NOW), 2);
});

test('check：合計加上新增人數不超過上限印 CAPACITY ok，超過印 STOP capacity、exit 4', t => {
  const file = ledger(t);
  report(file, 'ron-skills', 2);
  report(file, 'investing', 1);
  const ok = run(file, ['check', '1']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'CAPACITY ok 4/4\n');
  const over = run(file, ['check', '2']);
  assert.equal(over.status, 4, over.stderr);
  assert.equal(over.stdout, 'STOP capacity 5/4\n');
  const raised = run(file, ['check', '2'], { PILOT_MACHINE_WORKER_CAP: '6' });
  assert.equal(raised.stdout, 'CAPACITY ok 5/6\n');
});

test('沒有帳本時 check 以 0 起算；上限預設 4', t => {
  const file = ledger(t);
  assert.equal(run(file, ['check', '4']).stdout, 'CAPACITY ok 4/4\n');
  assert.equal(run(file, ['check', '5']).stdout, 'STOP capacity 5/4\n');
  assert.equal(existsSync(file), false);
});

test('CLI report 印 REPORTED <repo> <running> <合計>/<上限>', t => {
  const file = ledger(t);
  const result = run(file, ['report', 'ron-skills', '3'], { PILOT_MACHINE_WORKER_CAP: '4' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'REPORTED ron-skills 3 3/4\n');
  assert.match(readFileSync(file, 'utf8'), /^ron-skills\t3\t\d{4}-\d\d-\d\dT/);
});

test('用法錯誤 exit 2：缺參數、人數不是非負整數、repo 帶 tab、上限不是正整數', t => {
  const file = ledger(t);
  for (const args of [[], ['check'], ['check', '-1'], ['report', 'a'], ['report', 'a\tb', '1'], ['report', 'a', '1.5'], ['bogus', '1']]) {
    assert.equal(run(file, args).status, 2, `${JSON.stringify(args)} 應該是用法錯誤`);
  }
  assert.equal(run(file, ['check', '1'], { PILOT_MACHINE_WORKER_CAP: '0' }).status, 2);
  assert.equal(existsSync(file), false);
});
