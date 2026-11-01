// #164：本 repo 的 Probe 副本 `--apply` 整理母單時，寫入要經同目錄的 scripts/gh-tracker.mjs（auto mode 只放行它的 tracker 寫入，#96），
// 所以 gh 收到的是 gh-tracker 改寫過、固定 repo 的參數。這裡跑真的副本與真的 gh-tracker，只把 gh 換成假的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, git } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/pilot-probe.mjs', import.meta.url).pathname;

/** 主 checkout 在 main 上、沒有 batch；假 gh 回一頁開著的 Issue（母單 #10 缺 parent label、子單 #41 的母單 #40 已關），每次呼叫記一行 argv。 */
function fixture(t) {
  const repo = mkdtempSync(join(realTmpdir(), 'pilot-probe-parent-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '.scratch/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const bin = join(repo, '.scratch/bin');
  mkdirSync(bin, { recursive: true });
  const log = join(repo, '.scratch/gh.log');
  const node = (number, labels, extra = {}) => ({ number, body: '', labels: { nodes: labels.map(name => ({ name })) }, blockedBy: { nodes: [] }, blocking: { nodes: [] }, assignees: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, subIssuesSummary: { total: 0 }, parent: null, ...extra });
  const nodes = [
    node(10, ['ready-for-agent'], { subIssuesSummary: { total: 1 } }),
    node(11, ['ready-for-agent'], { parent: { number: 10, state: 'OPEN', repository: { nameWithOwner: 'ron03wlb/ron-skills' } } }),
    node(41, ['ready-for-agent'], { parent: { number: 40, state: 'CLOSED', repository: { nameWithOwner: 'ron03wlb/ron-skills' } } }),
  ];
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'repo') console.log('ron03wlb/ron-skills');
else if (args[0] === 'api') console.log(JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: ${JSON.stringify(nodes)} } } } }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const probe = (...args) => spawnSync('node', [script, repo, ...args], { encoding: 'utf8', env: { ...env, ORCA_CLI_COMMAND: '', PATH: `${bin}:${env.PATH}` } });
  const writes = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(([cmd]) => cmd === 'issue');
  return { probe, writes };
}

test('--apply 經 scripts/gh-tracker.mjs 補 parent label、移除 triage label、重開母單', t => {
  const { probe, writes } = fixture(t);
  const result = probe('--apply');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['PARENT_LABEL 10', 'PARENT_REOPEN 40', 'POOL_READY 11 41']);
  assert.deepEqual(writes(), [
    ['issue', 'edit', '10', '--add-label=parent', '--remove-label=ready-for-agent', '--repo', 'github.com/ron03wlb/ron-skills'],
    ['issue', 'reopen', '40', '--repo', 'github.com/ron03wlb/ron-skills'],
  ]);
});
