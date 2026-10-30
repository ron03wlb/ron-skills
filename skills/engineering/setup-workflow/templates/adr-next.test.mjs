import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { numbersIn, plan } from './adr-next.mjs';

const SCRIPT = fileURLToPath(new URL('./adr-next.mjs', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const readme = (next, rows) => `# ADR\n\n下一個可用編號：**ADR-${next}**。\n\n${rows.map(n => `| ADR-${n} | t | Accepted | [x.md](x.md#adr-${n}) |`).join('\n')}\n`;
const concept = numbers => `# X\n\n${numbers.map(n => `<a id="adr-${n}"></a>\n## ADR-${n}: t\n\n參見 ADR-0001。\n`).join('\n')}`;
const write = (cwd, next, numbers) => {
  mkdirSync(join(cwd, 'docs/adr'), { recursive: true });
  writeFileSync(join(cwd, 'docs/adr/README.md'), readme(next, numbers));
  writeFileSync(join(cwd, 'docs/adr/x.md'), concept(numbers));
};

test('numbersIn：只認章節標題與 README 索引列，內文引用不算', () => {
  assert.deepEqual(numbersIn(['## ADR-0012: t', '| ADR-0013 | t |', '依 ADR-0014 決定', '| ADR-0015 | superseded by ADR-0016 |']), [12, 13, 15]);
});

test('plan：下一號取整合分支與他人占用的最大值 +1；自己的編號撞到他人或整合分支列為衝突', () => {
  const result = plan({
    integrationNumbers: [1, 2], integrationNext: 3,
    trees: [
      { path: '/self', branch: 'me', self: true, claimed: [3, 2] },
      { path: '/other', branch: 'other', self: false, claimed: [3, 4] },
    ],
  });
  assert.equal(result.next, 5);
  assert.deepEqual(result.claims.map(claim => [claim.number, claim.branch]), [[2, 'me'], [3, 'me'], [3, 'other'], [4, 'other']]);
  assert.deepEqual(result.conflicts, [{ number: 2, with: 'integration' }, { number: 3, with: 'other' }]);
  assert.equal(plan({ integrationNumbers: [1], integrationNext: 7, trees: [] }).next, 7);
});

/** 整合分支已有 ADR-0001；other 已提交 ADR-0002；dirty 有未提交的 ADR-0003（未追蹤新概念檔）。 */
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'adr-next-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  git(root, 'init', '-q', '-b', 'integration', main);
  write(main, '0002', ['0001']);
  git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base');
  const add = name => { const path = join(root, name); git(main, 'worktree', 'add', '-q', '-b', name, path, 'integration'); return path; };
  const mine = add('mine');
  const other = add('other');
  write(other, '0003', ['0001', '0002']);
  git(other, 'commit', '-q', '-am', 'adr 2');
  const dirty = add('dirty');
  writeFileSync(join(dirty, 'docs/adr/y.md'), concept(['0003']));
  return { mine };
};
const run = (cwd, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });

test('CLI：他人已提交與未追蹤的編號都算占用，NEXT 跳過它們；無衝突 exit 0', t => {
  const { mine } = fixture(t);
  const result = run(mine);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'NEXT ADR-0004');
  assert.match(lines[1], /^CLAIMED ADR-0002 other /);
  assert.match(lines[2], /^CLAIMED ADR-0003 dirty /);
  assert.equal(lines.length, 3, result.stdout);
});

test('CLI：自己取了他人已占用的編號 exit 3 並列 CONFLICT；--json 同樣回報', t => {
  const { mine } = fixture(t);
  write(mine, '0003', ['0001', '0002']);
  const result = run(mine);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /^CONFLICT ADR-0002 other$/m);
  const json = JSON.parse(run(mine, '--json').stdout);
  assert.equal(json.next, 'ADR-0004');
  assert.deepEqual(json.conflicts, [{ number: 'ADR-0002', with: 'other' }]);
});

test('CLI：未知參數 exit 2', t => {
  const { mine } = fixture(t);
  assert.equal(run(mine, '--force').status, 2);
});
