// pre-commit 的流程站守門要比對要 commit 的內容（index），不是工作區（#329-4）。
// 真實情境：別的 session 留在工作區、沒 stage 的 docs/workflow/05-level3.md 修改，讓只 stage 了 day-sessions.mjs 的 commit
// 以 `CHECK_FAIL node scripts/build-workflow-site.mjs --check` 失敗；繞法 `git stash push -- <file>` 連帶收走已 stage 的檔。
// fixture 是真的 git commit：掛本 repo 的 .githooks/pre-commit，bin/check 只留真 bin/check 裡取 index_tree 與呼叫這兩支腳本的那幾行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const here = dirname(new URL(import.meta.url).pathname);
const repoRoot = join(here, '..');
// 本檔自己也會在 pre-commit hook 裡跑：清掉繼承來的 GIT_*，fixture 的 git 才不會改到真正的 repo。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'CHECK_INDEX_TREE'));
const SOURCES = [
  'skills/engineering/issue-run/SKILL.md',
  'skills/engineering/issue-pilot/SKILL.md',
  'skills/engineering/retro-collect/SKILL.md',
  'skills/engineering/setup-workflow/SKILL.md',
  'skills/engineering/issue-run/ADAPTER.md',
];
const DAY_SESSIONS = 'skills/productivity/daily-summary/scripts/day-sessions.mjs';

function fixture(t) {
  const repo = mkdtempSync(join(realTmpdir(), 'pre-commit-index-tree-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { encoding: 'utf8', env });
  const node = (...args) => spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', env });
  const write = (path, content) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); };
  git('init', '-q');
  for (const path of ['.githooks/pre-commit', 'scripts/build-workflow-site.mjs', 'scripts/check-workflow-sync.mjs']) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(repo, path));
  }
  const lines = readFileSync(join(repoRoot, 'bin/check'), 'utf8').split('\n').filter(line => /^index_tree=|^node scripts\/(build-workflow-site|check-workflow-sync)\.mjs/.test(line));
  assert.equal(lines.filter(line => line.startsWith('node ')).length, 2, `bin/check 裡呼叫兩支腳本的行：${lines.join(' / ')}`);
  write('bin/check', `#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")/.."\n${lines.join('\n')}\n`);
  chmodSync(join(repo, 'bin/check'), 0o755);
  write('docs/workflow/README.md', '# 首頁\n\n見 [05](05-level3.md)。\n');
  write('docs/workflow/05-level3.md', '# 05 Level 3\n\n原本的內容。\n');
  for (const path of SOURCES) write(path, `# ${path}\n`);
  write(DAY_SESSIONS, 'export const version = 1;\n');
  assert.equal(node('scripts/build-workflow-site.mjs').status, 0);
  assert.equal(node('scripts/check-workflow-sync.mjs', '--restamp').status, 0);
  git('add', '-A');
  assert.equal(git('commit', '-q', '--no-verify', '-m', 'base').status, 0);
  git('config', 'core.hooksPath', '.githooks');
  const commit = (...args) => git('commit', '-q', '-m', 'change', ...args);
  return { repo, git, node, write, commit };
}

test('工作區有沒 stage 的 docs/workflow/05-level3.md 修改、staged 只動無關檔：pre-commit 通過', t => {
  const f = fixture(t);
  f.write('docs/workflow/05-level3.md', '# 05 Level 3\n\n別的 session 改到一半。\n');
  f.write(DAY_SESSIONS, 'export const version = 2;\n');
  f.git('add', DAY_SESSIONS);
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // 沒 stage 的修改留在工作區，不必 stash。
  assert.match(f.git('status', '--short').stdout, /^ M docs\/workflow\/05-level3\.md$/m);
});

test('工作區有沒 stage 的 SKILL.md 修改、staged 只動無關檔：check-workflow-sync 不擋', t => {
  const f = fixture(t);
  f.write(SOURCES[0], '# 改到一半，還沒對照 docs/workflow/\n');
  f.write(DAY_SESSIONS, 'export const version = 2;\n');
  f.git('add', DAY_SESSIONS);
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('staged 的 Markdown 與產物不同步（工作區已重產但沒 stage）：pre-commit 仍失敗', t => {
  const f = fixture(t);
  f.write('docs/workflow/05-level3.md', '# 05 Level 3\n\n新的內容。\n');
  f.git('add', 'docs/workflow/05-level3.md');
  assert.equal(f.node('scripts/build-workflow-site.mjs').status, 0); // 工作區同步，但 site/ 沒 stage
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /05-level3\.html/);
});

test('staged 的 SKILL.md 沒 restamp（工作區已 restamp 但沒 stage）：pre-commit 仍失敗', t => {
  const f = fixture(t);
  f.write(SOURCES[0], '# 規範改了\n');
  f.git('add', SOURCES[0]);
  assert.equal(f.node('scripts/check-workflow-sync.mjs', '--restamp').status, 0);
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, new RegExp(`WORKFLOW_SYNC_STALE ${SOURCES[0]}`));
});

test('git commit -a（index 是暫存檔）同步時通過、不同步時失敗', t => {
  const f = fixture(t);
  f.write(DAY_SESSIONS, 'export const version = 2;\n');
  const ok = f.commit('-a');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  f.write('docs/workflow/05-level3.md', '# 05 Level 3\n\n忘了重產。\n');
  const stale = f.commit('-a');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /05-level3\.html/);
});

test('不經 pre-commit 直接跑 bin/check 照舊讀工作區', t => {
  const f = fixture(t);
  f.write('docs/workflow/05-level3.md', '# 05 Level 3\n\n沒重產。\n');
  const result = spawnSync(join(f.repo, 'bin/check'), { cwd: f.repo, encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /05-level3\.html/);
});
