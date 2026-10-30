import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../skills/engineering/setup-workflow/scripts/detect.mjs', import.meta.url).pathname;

/** 暫存 repo；files 為 { 相對路徑: 內容 }，寫入後 commit。 */
function repo(t, files = {}) {
  const root = mkdtempSync(join(realTmpdir(), 'setup-workflow-detect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  write(root, { 'README.md': 'x\n', ...files });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

function detect(root) {
  const result = spawnSync('node', [script, root, '--json'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const L1_FILES = {
  'docs/agents/issue-tracker.md': 'Read an Issue: `gh issue view <n> --json body`\n',
  'docs/agents/issue-run.md': '# issue-run adapter: x\n\n## Checks\n\nOne command: `bin/check`.\n',
  'bin/check': '#!/usr/bin/env bash\nnpm test\n',
};

/** L2：L1 加上跑 bin/check 的 pre-commit（core.hooksPath）、整合分支與合入過的 Issue 分支。 */
function l2(t, files = {}) {
  const root = repo(t, { ...L1_FILES, '.githooks/pre-commit': '#!/usr/bin/env bash\nbin/check\n', ...files });
  chmodSync(join(root, '.githooks/pre-commit'), 0o755);
  git(root, 'switch', '-q', '-c', 'issue/3-fix');
  write(root, { 'a.md': 'a\n' });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fix');
  git(root, 'switch', '-q', '-c', 'pilot/integration', 'main');
  git(root, 'merge', '-q', '--no-ff', '-m', "Merge branch 'issue/3-fix' into pilot/integration", 'issue/3-fix');
  git(root, 'config', 'core.hooksPath', '.githooks');
  return root;
}

test('沒有 adapter 的 repo 是 L0，建議 L1，並列出 L1 缺的條件', t => {
  const result = detect(repo(t));
  assert.equal(result.level, 'L0');
  assert.equal(result.recommend, 'L1');
  assert.deepEqual(result.levels.L1.missing, ['tracker', 'adapter', 'check']);
  assert.equal(result.extensions.tracker.value, 'none');
});

test('還沒有 adapter 時，現成的檢查入口（bin/check、npm run check、make check）也認得出來', t => {
  assert.equal(detect(repo(t, { 'bin/check': '#!/usr/bin/env bash\n' })).signals.check.value, 'bin/check');
  assert.equal(detect(repo(t, { 'package.json': '{"scripts":{"check":"eslint ."}}\n' })).signals.check.value, 'npm run check');
  assert.equal(detect(repo(t, { 'Makefile': 'check:\n\ttrue\n' })).signals.check.value, 'make check');
  const none = detect(repo(t, { 'package.json': '{"scripts":{"build":"tsc"}}\n' }));
  assert.equal(none.signals.check.met, false);
  assert.equal(none.level, 'L0');
});

test('檢查指令中選項的值（--base origin/main）不當成 repo 內路徑', t => {
  const adapter = '# a\n\n## Checks\n\nOne command: `bin/check --base origin/main`.\n';
  assert.equal(detect(repo(t, { ...L1_FILES, 'docs/agents/issue-run.md': adapter })).level, 'L1');
});

test('有 adapter 與單一檢查入口是 L1；tracker 從 issue-tracker.md 認出 GitHub', t => {
  const result = detect(repo(t, L1_FILES));
  assert.equal(result.level, 'L1');
  assert.equal(result.recommend, 'L2');
  assert.equal(result.signals.check.value, 'bin/check');
  assert.deepEqual(result.levels.L2.missing, ['integration', 'hook', 'worktrees']);
  assert.equal(result.extensions.tracker.value, 'github');
});

test('有 adapter 與檢查入口但沒有 tracker 設定時仍是 L0', t => {
  const result = detect(repo(t, { ...L1_FILES, 'docs/agents/issue-tracker.md': undefined }));
  assert.equal(result.level, 'L0');
  assert.deepEqual(result.levels.L1.missing, ['tracker']);
});

test('檢查入口：PATH 上的指令加上存在的 repo 內路徑才算；不存在的指令或路徑不算', t => {
  const adapter = command => `# a\n\n## Checks\n\nOne command: \`${command}\`.\n`;
  const files = { ...L1_FILES, 'bin/check': undefined, 'tests/a.test.mjs': '\n' };
  for (const command of ['node --test tests/', 'bash tests/a.test.mjs', 'git status']) {
    assert.equal(detect(repo(t, { ...files, 'docs/agents/issue-run.md': adapter(command) })).level, 'L1', command);
  }
  for (const command of ['bash bin/run-all', 'no-such-check-command', 'pilot']) {
    assert.equal(detect(repo(t, { ...files, 'docs/agents/issue-run.md': adapter(command) })).level, 'L0', command);
  }
});

test('分支名有數字但沒有 Issue 號碼時不算每張 Issue 一個 worktree 的紀錄', t => {
  const root = repo(t, L1_FILES);
  git(root, 'switch', '-q', '-c', 'feature/oauth2');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'x');
  git(root, 'switch', '-q', 'main');
  git(root, 'merge', '-q', '--no-ff', '-m', "Merge branch 'feature/oauth2'", 'feature/oauth2');
  assert.equal(detect(root).signals.worktrees.met, false);
});

test('AGENTS.md 沒提到 Codex 時不算 Codex 擴充', t => {
  assert.equal(detect(repo(t, { 'AGENTS.md': '## Agent skills\n' })).extensions.codex.detected, false);
});

test('adapter 寫的檢查入口不存在時不算 L1', t => {
  const result = detect(repo(t, { ...L1_FILES, 'bin/check': undefined }));
  assert.equal(result.level, 'L0');
  assert.deepEqual(result.levels.L1.missing, ['check']);
});

test('整合分支、跑檢查入口的 git hook、Issue 分支紀錄齊了是 L2；只有 pre-commit 時標明缺 pre-push', t => {
  const result = detect(l2(t));
  assert.equal(result.level, 'L2');
  assert.equal(result.recommend, 'L3');
  assert.equal(result.signals.integration.value, 'pilot/integration');
  assert.equal(result.signals.hook.value, 'pre-commit');
  assert.match(result.signals.hook.note, /pre-push/);
  assert.match(result.signals.worktrees.value, /issue\/3-fix/);
  assert.deepEqual(result.levels.L3.missing, ['pilot', 'pilotCommits']);
});

test('pre-push 沒有呼叫檢查入口時不算 hook 訊號', t => {
  const root = repo(t, { ...L1_FILES, '.git-hooks/pre-push': '#!/usr/bin/env bash\necho hi\n' });
  git(root, 'config', 'core.hooksPath', '.git-hooks');
  assert.equal(detect(root).signals.hook.met, false);
});

test('adapter 有 Pilot 段且近期有 pilot／stage commit 是 L3，不再建議升級', t => {
  const root = l2(t, { 'docs/agents/issue-run.md': `${L1_FILES['docs/agents/issue-run.md']}\n## Pilot\n\n- **Pool.** x\n` });
  assert.equal(detect(root).levels.L3.missing.join(), 'pilotCommits');
  git(root, 'switch', '-q', '-c', 'pilot/stage-3', 'pilot/integration');
  git(root, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'stage batch-3');
  const result = detect(root);
  assert.equal(result.level, 'L3');
  assert.equal(result.recommend, null);
});

test('擴充：GitLab tracker、卡關單、外部測試環境、多模組、自訂分級入口、Codex', t => {
  const result = detect(repo(t, {
    'docs/agents/issue-tracker.md': 'Read an Issue: `glab issue view <n>`\n',
    'db/migration/V1__init.sql': 'create table t (id int);\n',
    'docker-compose.yml': 'services: {}\n',
    'api/package.json': '{}\n',
    'web/package.json': '{}\n',
    '.claude/skills/project-triage/SKILL.md': '---\nname: project-triage\n---\n',
    'AGENTS.md': 'Codex implements tickets.\n',
  }));
  const ext = result.extensions;
  assert.equal(ext.tracker.value, 'gitlab');
  assert.match(ext.gated.evidence.join(), /db\/migration\/V1__init\.sql/);
  assert.match(ext.externalEnv.evidence.join(), /docker-compose\.yml/);
  assert.deepEqual(ext.multiModule.evidence, ['api/package.json', 'web/package.json']);
  assert.deepEqual(ext.customTriage.evidence, ['.claude/skills/project-triage']);
  assert.deepEqual(ext.codex.evidence, ['AGENTS.md']);
  for (const key of ['gated', 'externalEnv', 'multiModule', 'customTriage', 'codex']) {
    assert.equal(ext[key].detected, true, key);
    assert.ok(ext[key].section, key);
    assert.ok(Array.isArray(ext[key].templates), key);
  }
});

test('沒有擴充訊號時每項 detected 為 false；本機 Markdown tracker 認得出', t => {
  const result = detect(repo(t, { 'docs/agents/issue-tracker.md': 'Issues live as Markdown files under `.scratch/issues/`.\n' }));
  assert.equal(result.extensions.tracker.value, 'local');
  for (const key of ['gated', 'externalEnv', 'multiModule', 'customTriage', 'codex']) assert.equal(result.extensions[key].detected, false, key);
});

test('文字輸出最後一行是 LEVEL <等級>', t => {
  const result = spawnSync('node', [script, repo(t, L1_FILES)], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').pop(), 'LEVEL L1');
});
