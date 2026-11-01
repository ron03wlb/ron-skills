import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// 開放 Issue 數不呼叫本機真的 gh：預設以一定失敗的指令取代，需要時測試自己放假的 gh。
const offline = { ...env, DETECT_GH: 'false', ORCA_CLI_COMMAND: '' };

function detect(root, ...args) {
  const result = spawnSync('node', [script, root, '--json', ...args], { encoding: 'utf8', env: offline });
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

test('沒有 adapter 的 repo 是 L0，列出 L1 缺的條件', t => {
  const result = detect(repo(t));
  assert.equal(result.level, 'L0');
  assert.deepEqual(result.levels.L1.missing, ['tracker', 'adapter', 'check']);
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

test('有 adapter 與單一檢查入口是 L1', t => {
  const result = detect(repo(t, L1_FILES));
  assert.equal(result.level, 'L1');
  assert.equal(result.signals.check.value, 'bin/check');
  assert.deepEqual(result.levels.L2.missing, ['integration', 'hook', 'worktrees']);
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

test('adapter 有 Pilot 段且近期有 pilot／stage commit 是 L3，安裝目標維持 L3', t => {
  const root = l2(t, { 'docs/agents/issue-run.md': `${L1_FILES['docs/agents/issue-run.md']}\n## Pilot\n\n- **Pool.** x\n` });
  assert.equal(detect(root).levels.L3.missing.join(), 'pilotCommits');
  git(root, 'switch', '-q', '-c', 'pilot/stage-3', 'pilot/integration');
  git(root, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'stage batch-3');
  const result = detect(root);
  assert.equal(result.level, 'L3');
  assert.equal(result.target.value, 'L3');
});

test('擴充：卡關單、外部測試環境、多模組、自訂分級入口、Codex；tracker 不再是擴充（改由 Host 站判定）', t => {
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
  assert.deepEqual(Object.keys(ext), ['gated', 'externalEnv', 'multiModule', 'customTriage', 'codex']);
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

test('沒有擴充訊號時每項 detected 為 false', t => {
  const result = detect(repo(t, { 'docs/agents/issue-tracker.md': 'Issues live as Markdown files under `.scratch/issues/`.\n' }));
  for (const key of ['gated', 'externalEnv', 'multiModule', 'customTriage', 'codex']) assert.equal(result.extensions[key].detected, false, key);
});

test('文字輸出最後一行是 LEVEL <等級>', t => {
  const result = spawnSync('node', [script, repo(t, L1_FILES)], { encoding: 'utf8', env: offline });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').pop(), 'LEVEL L1');
});

// #139 R2-Q1：沒有 CI 只印成缺口，不是等級訊號；現有的 L2 專案不會因此被判回 L1。
test('沒有 CI 的 L2 專案印 ci 缺口，LEVEL 仍是 L2；CI 檔沒呼叫檢查入口也是缺口，呼叫了就沒有', t => {
  const github = { 'docs/agents/issue-tracker.md': L1_FILES['docs/agents/issue-tracker.md'] };
  const none = l2(t);
  git(none, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  const result = detect(none);
  assert.equal(result.level, 'L2');
  assert.equal(result.gaps.ci.met, false);
  assert.match(result.gaps.ci.evidence.join(' '), /沒有 CI 檔/);
  const text = spawnSync('node', [script, none], { encoding: 'utf8', env: offline }).stdout;
  assert.match(text, /^GAP ci /m);
  assert.match(text.trim().split('\n').pop(), /^LEVEL L2$/);

  const silent = l2(t, { ...github, '.github/workflows/deploy.yml': 'on: push\njobs:\n  d:\n    steps:\n      - run: ./deploy.sh\n' });
  git(silent, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  assert.equal(detect(silent).gaps.ci.met, false);
  assert.match(detect(silent).gaps.ci.evidence.join(' '), /\.github\/workflows\/deploy\.yml 沒有呼叫 bin\/check/);

  const calls = l2(t, { '.gitlab-ci.yml': 'checks:\n  script:\n    - bin/check --upstream\n' });
  git(calls, 'remote', 'add', 'origin', 'http://192.168.200.202/g/r.git');
  assert.equal(detect(calls).gaps.ci.met, true);
  assert.doesNotMatch(spawnSync('node', [script, calls], { encoding: 'utf8', env: offline }).stdout, /^GAP /m);
});

test('程式碼 host 是 local（沒有 origin）時沒有遠端 CI，不印 ci 缺口', t => {
  const result = detect(l2(t));
  assert.equal(result.gaps.ci.met, true);
  assert.match(result.gaps.ci.evidence.join(' '), /local/);
});

test('量測證據：近 90 天貢獻者數以作者 email 去重，90 天前的 commit 不算', t => {
  const root = repo(t);
  const commit = (email, date) => {
    const result = spawnSync('git', ['-C', root, '-c', 'user.name=x', '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', 'x'],
      { encoding: 'utf8', env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    assert.equal(result.status, 0, result.stderr);
  };
  const now = new Date().toISOString();
  commit('a@x', now);
  commit('A@x', now);
  commit('b@x', now);
  // 舊 commit 放在另一條 orphan 分支：同一條線上比 --since 舊的 tip 會讓 git log 提早停止。
  git(root, 'switch', '-q', '--orphan', 'old');
  commit('old@x', '2000-01-01T00:00:00Z');
  git(root, 'switch', '-q', 'main');
  // repo() 的 init commit 作者是 t@t，也在 90 天內。
  assert.equal(detect(root).evidence.contributors.value, 3);
});

test('量測證據：同時存在的 Issue 分支與 linked worktree 數', t => {
  const root = repo(t);
  git(root, 'branch', 'issue/1-a');
  git(root, 'branch', 'issue/2-b');
  git(root, 'branch', 'feature/oauth2');
  git(root, 'worktree', 'add', '-q', join(root, '.wt'), 'issue/2-b');
  const { evidence } = detect(root);
  assert.equal(evidence.issueBranches.value, 2);
  assert.deepEqual(evidence.issueBranches.evidence, ['issue/1-a', 'issue/2-b']);
  assert.equal(evidence.worktrees.value, 1);
});

test('量測證據：GitHub tracker 的開放 Issue 數取自 gh；其他 tracker 記 unknown', t => {
  const root = repo(t, { 'docs/agents/issue-tracker.md': 'Read an Issue: `gh issue view <n> --json body`\n' });
  const bin = join(root, '.fake-bin');
  write(root, { '.fake-bin/gh': '#!/bin/sh\n[ "$1 $2" = "issue list" ] && echo 7\n' });
  chmodSync(join(bin, 'gh'), 0o755);
  const result = spawnSync('node', [script, root, '--json'], { encoding: 'utf8', env: { ...env, DETECT_GH: join(bin, 'gh') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).evidence.openIssues.value, 7);
  assert.equal(detect(repo(t)).evidence.openIssues.value, 'unknown');
  assert.equal(detect(repo(t, { 'docs/agents/issue-tracker.md': 'Issues live under `.scratch/issues/`.\n' })).evidence.openIssues.value, 'unknown');
});

test('量測證據：還沒有 issue-tracker.md 時照 Host 站依 origin 推定 tracker', t => {
  const root = repo(t);
  git(root, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  write(root, { '.fake-bin/gh': '#!/bin/sh\n[ "$1 $2" = "issue list" ] && echo 4\n' });
  chmodSync(join(root, '.fake-bin/gh'), 0o755);
  const result = spawnSync('node', [script, root, '--json'], { encoding: 'utf8', env: { ...env, DETECT_GH: join(root, '.fake-bin/gh') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).evidence.openIssues.value, 4);
  git(root, 'remote', 'set-url', 'origin', 'http://192.168.200.202/spay/spay2.git');
  assert.match(detect(root).evidence.openIssues.evidence.join(), /tracker gitlab/);
});

test('量測證據：CI 與 gated 有無', t => {
  const none = detect(repo(t)).evidence;
  assert.equal(none.ci.value, 'no');
  assert.equal(none.gated.value, 'no');
  const github = detect(repo(t, { '.github/workflows/check.yml': 'on: push\n', 'db/V1__init.sql': 'select 1;\n' })).evidence;
  assert.equal(github.ci.value, 'yes');
  assert.deepEqual(github.ci.evidence, ['.github/workflows/check.yml']);
  assert.equal(github.gated.value, 'yes');
  assert.equal(detect(repo(t, { '.gitlab-ci.yml': 'stages: []\n' })).evidence.ci.value, 'yes');
});

// #278：安裝目標不問是非題、不限一次升一級，依量得到的工具決定。
const withOrca = { ...offline, ORCA_CLI_COMMAND: process.execPath };
function target(root, extraEnv = offline) {
  const result = spawnSync('node', [script, root, '--json'], { encoding: 'utf8', env: extraEnv });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).target;
}

test('TARGET：有 Orca 而且 tracker 在 GitHub 時，空 repo 也直接裝到 L3', t => {
  const root = repo(t);
  git(root, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  const result = target(root, withOrca);
  assert.equal(result.value, 'L3');
  assert.deepEqual(result.evidence, ['tracker github', 'Orca 可用']);
});

test('TARGET：沒有 Orca，或 tracker 不在 GitHub 時裝到 L2，依據寫明原因', t => {
  const github = repo(t);
  git(github, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  assert.deepEqual(target(github), { value: 'L2', evidence: ['tracker github', '沒有 Orca', '常駐 pilot 需要 Orca'] });
  const gitlab = repo(t);
  git(gitlab, 'remote', 'add', 'origin', 'http://192.168.200.202/g/r.git');
  assert.deepEqual(target(gitlab, withOrca), { value: 'L2', evidence: ['tracker gitlab', 'Orca 可用', '常駐 pilot 需要 GitHub tracker'] });
  assert.equal(target(repo(t), withOrca).value, 'L2', '沒有 origin：tracker local');
});

test('TARGET：已經是 L3 的維持 L3，即使沒有 Orca；--no-station 等於目前等級', t => {
  const root = l2(t, { 'docs/agents/issue-run.md': `${L1_FILES['docs/agents/issue-run.md']}\n## Pilot\n\n- **Pool.** x\n` });
  git(root, 'switch', '-q', '-c', 'pilot/stage-3', 'pilot/integration');
  git(root, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'stage batch-3');
  assert.deepEqual(target(root), { value: 'L3', evidence: ['已經是 L3'] });
  assert.equal(detect(repo(t, L1_FILES), '--no-station').target.value, 'L1');
});

test('文字輸出：TARGET 在 LEVEL 前一行；不再印 QUESTION、ENTRY、RECOMMEND', t => {
  const root = repo(t, L1_FILES);
  git(root, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  const result = spawnSync('node', [script, root], { encoding: 'utf8', env: withOrca });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim().split('\n');
  assert.equal(out.at(-2), 'TARGET L3  # tracker github; Orca 可用');
  assert.equal(out.at(-1), 'LEVEL L1');
  assert.ok(!out.some(line => /^(QUESTION|ENTRY|RECOMMEND) /.test(line)), result.stdout);
});

test('已移除的 --answer 與其他不認得的旗標 exit 2，多個 repo 參數也是', t => {
  const root = repo(t, L1_FILES);
  const run = (...args) => spawnSync('node', [script, ...args], { encoding: 'utf8', env: offline });
  assert.equal(run(root, '--answer', 'delivered=yes').status, 2);
  assert.match(run(root, '--answer=delivered=yes').stderr, /不認得 --answer=delivered=yes/);
  assert.equal(run(root, root).status, 2);
});
