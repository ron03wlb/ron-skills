import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/check-workflow-sync.mjs', import.meta.url).pathname;
const SOURCES = [
  'skills/engineering/issue-run/SKILL.md',
  'skills/engineering/issue-pilot/SKILL.md',
  'skills/engineering/retro-collect/SKILL.md',
  'skills/engineering/issue-run/ADAPTER.md',
];

// docs/workflow/ 轉述這四份規範；規範改了而沒對照，導讀會默默說法不一（#8，R3-Q5）。
function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'workflow-sync-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(script, join(repo, 'scripts/check-workflow-sync.mjs'));
  for (const path of SOURCES) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `# ${path}\n`);
  }
  const run = (...args) => spawnSync('node', [join(repo, 'scripts/check-workflow-sync.mjs'), ...args], { cwd: tmpdir(), encoding: 'utf8' });
  return { repo, run };
}

test('沒有記錄時失敗並列出全部來源；--restamp 後通過，記錄四份來源的 sha256', t => {
  const f = fixture(t);
  const first = f.run();
  assert.equal(first.status, 1);
  for (const path of SOURCES) assert.match(first.stderr, new RegExp(`^WORKFLOW_SYNC_STALE ${path}$`, 'm'));
  assert.equal(f.run('--restamp').status, 0);
  assert.equal(f.run().status, 0);
  const { sources } = JSON.parse(readFileSync(join(f.repo, 'scripts/workflow-doc-sync.json'), 'utf8'));
  assert.deepEqual(Object.keys(sources).sort(), [...SOURCES].sort());
  for (const hash of Object.values(sources)) assert.match(hash, /^[0-9a-f]{64}$/);
});

test('改 issue-run/SKILL.md 一行不 restamp：只列那份來源並提示對照 docs/workflow/ 後 --restamp、exit 1', t => {
  const f = fixture(t);
  f.run('--restamp');
  writeFileSync(join(f.repo, SOURCES[0]), '# changed\n');
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^WORKFLOW_SYNC_STALE skills\/engineering\/issue-run\/SKILL\.md$/m);
  assert.doesNotMatch(r.stderr, /ADAPTER\.md|issue-pilot|retro-collect/);
  assert.match(r.stderr, /對照 `docs\/workflow\/` 後執行 `--restamp`/);
});
