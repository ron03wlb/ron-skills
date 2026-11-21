import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRows } from './pilot-probe.mjs';
import { realTmpdir } from './test/real-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('./pilot-gate.mjs', import.meta.url));
const GATES = [
  '# Gates',
  '',
  '| id | Issue | question | options | default | parks | opened | status |',
  '|---|---|---|---|---|---|---|---|',
  '| G1 | #10 | 要不要改 API | 1. 改；2. 不改 | 不改 | batch-10 | 2026-10-30T20:00:00+08:00 | open |',
  '',
  '## G2 #11 缺樣本',
  '- Issue：#11',
  '- question：樣本去哪拿',
  '- options：1. 補樣本；2. 改驗收',
  '- default：等樣本',
  '- parked：batch-11',
  '- opened：2026-10-30T21:00:00+08:00',
  '- resolved 2026-10-30T21:30:00+08:00 人選 2',
  '',
  '## G3 #12 手寫錯的 resolved',
  '- Issue：#12',
  '- opened：2026-10-30T22:00:00+08:00',
  '- status：resolved 2026-10-30T22:10:00+08:00 人選 1',
  '',
].join('\n');
const OPEN = ['--title', '#13 衝突', '--issue', 'batch 13（#13）', '--question', '怎麼處理衝突？', '--options', '1. 重派；2. 人解', '--default', '1. 重派', '--parked', 'batch 13 的 Stage'];
const TIME = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d[+-]\\d\\d:\\d\\d';

const checkout = (t, text = GATES) => {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (text !== null) {
    mkdirSync(join(dir, '.scratch/pilot'), { recursive: true });
    writeFileSync(join(dir, '.scratch/pilot/gates.md'), text);
  }
  return dir;
};
const run = (dir, ...args) => spawnSync('node', [SCRIPT, dir, ...args], { encoding: 'utf8' });
const gates = dir => readFileSync(join(dir, '.scratch/pilot/gates.md'), 'utf8');

test('open：以下一個 G<n> 附加 `## G<n> <title>` 段落與六個欄位，印 GATE_OPENED，list 與 probe 都看得到', t => {
  const dir = checkout(t);
  const result = run(dir, 'open', ...OPEN);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'GATE_OPENED G4\n');
  const added = gates(dir).slice(GATES.length);
  assert.match(added, new RegExp(`^\\n## G4 #13 衝突\\n- Issue：batch 13（#13）\\n- question：怎麼處理衝突？\\n- options：1\\. 重派；2\\. 人解\\n- default：1\\. 重派\\n- parked：batch 13 的 Stage\\n- opened：${TIME}\\n$`));
  assert.ok(gates(dir).startsWith(GATES), '既有內容被改寫');
  assert.match(run(dir, 'list').stdout, /^GATE G4 #13 衝突$/m);
  assert.ok(openRows(join(dir, '.scratch/pilot')).includes('GATE G4 #13 衝突'));
});

test('open：沒有 gates.md 時先寫 `# Gates` 標題，編號從 G1 起', t => {
  const dir = checkout(t, null);
  const result = run(dir, 'open', ...OPEN);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'GATE_OPENED G1\n');
  assert.match(gates(dir), /^# Gates\n\n## G1 #13 衝突\n- Issue：/);
});

test('open：編號取表格與段落中最大的 G<n> 加一，不重用', t => {
  const dir = checkout(t, `${GATES}\n## G9 舊的\n- opened：2026-10-30T23:00:00+08:00\n- resolved 2026-10-30T23:10:00+08:00 已解\n`);
  assert.equal(run(dir, 'open', ...OPEN).stdout, 'GATE_OPENED G10\n');
});

test('resolve：在該段落最後一個欄位後插入 `- resolved <time> <how>`，印 GATE_RESOLVED，probe 不再印這個 GATE', t => {
  const dir = checkout(t);
  run(dir, 'open', ...OPEN);
  const result = run(dir, 'resolve', 'G4', '--how', '使用者選 1 重派');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'GATE_RESOLVED G4\n');
  assert.match(gates(dir), new RegExp(`- opened：${TIME}\\n- resolved ${TIME} 使用者選 1 重派\\n$`));
  assert.ok(!openRows(join(dir, '.scratch/pilot')).some(line => line.startsWith('GATE G4')));
  assert.ok(!run(dir, 'list').stdout.includes('G4'));
});

test('resolve：段落中間的 gate 插在它自己的欄位之後，不動後面的段落', t => {
  const dir = checkout(t);
  run(dir, 'open', ...OPEN);
  assert.equal(run(dir, 'resolve', 'G3', '--how', '補正確的 resolved').status, 0);
  assert.match(gates(dir), new RegExp(`- status：resolved 2026-10-30T22:10:00\\+08:00 人選 1\\n- resolved ${TIME} 補正確的 resolved\\n\\n## G4 #13 衝突\\n`));
  assert.deepEqual(openRows(join(dir, '.scratch/pilot')).filter(line => line.startsWith('GATE')), ['GATE G1 #10 要不要改 API', 'GATE G4 #13 衝突']);
});

test('resolve：表格列把 status 欄換成 `resolved <time> <how>`', t => {
  const dir = checkout(t);
  assert.equal(run(dir, 'resolve', 'G1', '--how', '決定不改').stdout, 'GATE_RESOLVED G1\n');
  assert.match(gates(dir), new RegExp(`^\\| G1 \\| #10 \\| 要不要改 API \\| 1\\. 改；2\\. 不改 \\| 不改 \\| batch-10 \\| 2026-10-30T20:00:00\\+08:00 \\| resolved ${TIME} 決定不改 \\|$`, 'm'));
  assert.ok(!openRows(join(dir, '.scratch/pilot')).some(line => line.startsWith('GATE G1 ')));
});

test('resolve：段落後面接表格時，resolved 插在段落最後一個欄位之後，不接到表格後面', t => {
  const text = '# Gates\n\n## G1 段落\n- Issue：#1\n- opened：2026-10-30T20:00:00+08:00\n\n| id | Issue | question | options | default | parks | opened | status |\n|---|---|---|---|---|---|---|---|\n| G2 | #2 | q | o | d | p | 2026-10-30T20:00:00+08:00 | open |\n';
  const dir = checkout(t, text);
  assert.equal(run(dir, 'resolve', 'G1', '--how', '已解').status, 0);
  assert.match(gates(dir), new RegExp(`- opened：2026-10-30T20:00:00\\+08:00\\n- resolved ${TIME} 已解\\n\\n\\| id \\|`));
  assert.ok(gates(dir).endsWith('| open |\n'));
});

test('resolve：已 resolved 或不存在的 gate 印 STOP、exit 4、不改檔', t => {
  const dir = checkout(t);
  for (const [id, cause] of [['G2', 'resolved'], ['G7', 'missing']]) {
    const result = run(dir, 'resolve', id, '--how', '再解一次');
    assert.equal(result.status, 4, result.stderr);
    assert.equal(result.stdout, `STOP ${id} ${cause}\n`);
  }
  assert.equal(gates(dir), GATES);
});

test('list：印與 probe 相同的 GATE、GATE_MALFORMED 行；沒有 gates.md 不輸出', t => {
  const dir = checkout(t);
  const result = run(dir, 'list');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    'GATE G1 #10 要不要改 API',
    'GATE G3 #12 手寫錯的 resolved',
    'GATE_MALFORMED G3 - status：resolved 2026-10-30T22:10:00+08:00 人選 1',
    '',
  ].join('\n'));
  assert.equal(run(checkout(t, null), 'list').stdout, '');
});

test('用法錯誤 exit 2、不建檔：缺欄位、欄位含換行、--how 含 |、id 不是 G<n>、多餘參數', t => {
  const dir = checkout(t, null);
  for (const args of [
    ['open', ...OPEN.slice(0, -2)],
    ['open', ...OPEN.slice(0, -1), '多行\n內容'],
    ['open', ...OPEN, '--extra', 'x'],
    ['resolve', 'G1'],
    ['resolve', 'G1', '--how', 'a | b'],
    ['resolve', '1', '--how', '已解'],
    ['resolve', 'G01', '--how', '已解'],
    ['open', ...OPEN.slice(0, -1), '三個   空白'],
    ['open', ...OPEN.slice(0, 3), '--question', ...OPEN.slice(4)],
    ['open', ...OPEN, '--title', '重複'],
    ['list', 'x'],
    ['close'],
  ]) {
    assert.equal(run(dir, ...args).status, 2, args.join(' '));
  }
  assert.equal(run(dir, 'list').stdout, '');
  assert.throws(() => gates(dir));
});

// --script：Operator 用 `! bash <path>`（或 zsh）執行的 gate 腳本。本機與 CI 不一定有 zsh：bash 一定跑，有 zsh 時加跑。
const SHELLS = ['bash', ...(spawnSync('zsh', ['-c', 'true']).status === 0 ? ['zsh'] : [])];
const withScript = (t, dir, body) => {
  const file = join(dir, 'steps.sh');
  writeFileSync(file, body);
  const result = run(dir, 'open', ...OPEN, '--script', file);
  assert.equal(result.status, 0, result.stderr);
  return result;
};

test('open --script：腳本寫到 .scratch/pilot/gates/G<n>.sh，路徑記在段落的 script 欄，先印 GATE_SCRIPT 再印 GATE_OPENED', t => {
  const dir = checkout(t);
  const result = withScript(t, dir, 'step 查狀態\necho ok\n');
  assert.equal(result.stdout, 'GATE_SCRIPT .scratch/pilot/gates/G4.sh\nGATE_OPENED G4\n');
  const script = readFileSync(join(dir, '.scratch/pilot/gates/G4.sh'), 'utf8');
  assert.match(script, /^#!\/usr\/bin\/env bash\n/);
  assert.match(script, /^trap '.*停止：第 .*' ERR$/m);
  assert.ok(script.includes('step 查狀態\necho ok\n'), '步驟本體原樣保留');
  assert.match(gates(dir), /- question：怎麼處理衝突？ 執行：! bash \.scratch\/pilot\/gates\/G4\.sh\n/);
  assert.match(gates(dir), new RegExp(`- parked：batch 13 的 Stage\\n- script：\\.scratch/pilot/gates/G4\\.sh\\n- opened：${TIME}\\n$`));
  assert.equal(run(dir, 'list').stdout.includes('GATE_MALFORMED G4'), false);
  assert.ok(openRows(join(dir, '.scratch/pilot')).includes('GATE G4 #13 衝突'));
});

for (const shell of SHELLS) {
  test(`open --script（${shell}）：查詢指令回非零時，Operator 看得到停在第幾行、哪一步，後面的步驟不跑`, t => {
    const dir = checkout(t);
    withScript(t, dir, 'step 查 PR 狀態\nst="$(sh -c \'echo 未就緒; exit 1\')"\nstep 留言\necho 不該執行\n');
    const path = join(dir, '.scratch/pilot/gates/G4.sh');
    const result = spawnSync(shell, [path], { encoding: 'utf8', cwd: realTmpdir() });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /▶ 查 PR 狀態/);
    assert.doesNotMatch(result.stdout, /留言|不該執行/);
    assert.match(result.stderr, /停止：第 \d+ 行失敗（步驟：查 PR 狀態）/);
    assert.equal(result.stderr.match(/停止：/g).length, 1, result.stderr);
    if (shell === 'bash') {
      const line = readFileSync(path, 'utf8').split('\n').findIndex(text => text.startsWith('st="$(')) + 1;
      assert.match(result.stderr, new RegExp(`停止：第 ${line} 行失敗`));
    }
  });

  test(`open --script（${shell}）：查詢步驟帶 \`|| true\` 時照樣往下跑，自行判斷輸出`, t => {
    const dir = checkout(t);
    withScript(t, dir, 'step 查 PR 狀態\nst="$(sh -c \'echo 未就緒; exit 1\')" || true\nstep 判斷\necho "狀態：$st"\n');
    const result = spawnSync(shell, [join(dir, '.scratch/pilot/gates/G4.sh')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /▶ 判斷\n狀態：未就緒\n/);
  });

  test(`open --script（${shell}）：可重跑；跑完一次後再跑不重做步驟，印 GATE_SCRIPT_DONE，在任何目錄都在 checkout 根目錄執行`, t => {
    const dir = checkout(t);
    withScript(t, dir, 'step 記一筆\necho once >> ran.txt\n');
    const path = join(dir, '.scratch/pilot/gates/G4.sh');
    const first = spawnSync(shell, [path], { encoding: 'utf8', cwd: realTmpdir() });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /GATE_SCRIPT_DONE G4\n$/);
    const second = spawnSync(shell, [path], { encoding: 'utf8', cwd: realTmpdir() });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /^GATE_SCRIPT_DONE G4 .*已執行完成/);
    assert.equal(readFileSync(join(dir, 'ran.txt'), 'utf8'), 'once\n');
  });

  test(`open --script（${shell}）：步驟本體定義的函式裡失敗也印停止行，只印一次`, t => {
    const dir = checkout(t);
    withScript(t, dir, 'merge_pr() {\n  gh_status="$(sh -c \'exit 2\')"\n}\nstep 合入\nmerge_pr\necho 不該執行\n');
    const result = spawnSync(shell, [join(dir, '.scratch/pilot/gates/G4.sh')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /不該執行/);
    assert.equal(result.stderr.match(/停止：第 \d+ 行失敗（步驟：合入）/g)?.length, 1, result.stderr);
  });

  test(`open --script（${shell}）：步驟本體 cd 到別處時，完成標記仍寫在 checkout 裡，重跑不重做`, t => {
    const dir = checkout(t);
    const elsewhere = mkdtempSync(join(realTmpdir(), 'pilot-gate-cd-'));
    t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
    withScript(t, dir, `step 換目錄\ncd '${elsewhere}'\necho did >> ran.txt\n`);
    const path = join(dir, '.scratch/pilot/gates/G4.sh');
    const first = spawnSync(shell, [path], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(spawnSync(shell, [path], { encoding: 'utf8' }).stdout, /^GATE_SCRIPT_DONE G4 /);
    assert.equal(readFileSync(join(elsewhere, 'ran.txt'), 'utf8'), 'did\n');
  });

  test(`open --script（${shell}）：中途失敗沒有完成標記，修好後重跑從頭執行`, t => {
    const dir = checkout(t);
    withScript(t, dir, 'step 檢查\n[ -e ok ] || exit 3\nstep 完成\necho done >> ran.txt\n');
    const path = join(dir, '.scratch/pilot/gates/G4.sh');
    assert.equal(spawnSync(shell, [path], { encoding: 'utf8' }).status, 3);
    writeFileSync(join(dir, 'ok'), '');
    const again = spawnSync(shell, [path], { encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(join(dir, 'ran.txt'), 'utf8'), 'done\n');
  });
}

test('open --script：同一路徑留著舊的完成標記（gates.md 重新編號）時先刪掉，新腳本照常執行', t => {
  const dir = checkout(t, null);
  mkdirSync(join(dir, '.scratch/pilot/gates'), { recursive: true });
  writeFileSync(join(dir, '.scratch/pilot/gates/G1.done'), '2026-01-01T00:00:00+0800\n');
  withScript(t, dir, 'step 新的\necho new >> ran.txt\n');
  const result = spawnSync('bash', [join(dir, '.scratch/pilot/gates/G1.sh')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'ran.txt'), 'utf8'), 'new\n');
});

test('open --script：檔案不存在或旗標重複是用法錯誤 exit 2，不建 gate 也不寫腳本', t => {
  const dir = checkout(t, null);
  for (const args of [
    ['open', ...OPEN, '--script', join(dir, 'missing.sh')],
    ['open', ...OPEN, '--script'],
    ['open', ...OPEN, '--script', join(dir, 'a'), '--script', join(dir, 'b')],
  ]) {
    assert.equal(run(dir, ...args).status, 2, args.join(' '));
  }
  assert.throws(() => gates(dir));
  assert.throws(() => readFileSync(join(dir, '.scratch/pilot/gates/G1.sh')));
});
