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
const offline = { ...env, DETECT_GH: 'false' };

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

test('沒有 adapter 的 repo 是 L0，列出 L1 缺的條件；L1 的是非題沒答時建議維持 L0', t => {
  const result = detect(repo(t));
  assert.equal(result.level, 'L0');
  assert.equal(result.recommend, 'L0');
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
  assert.equal(result.recommend, 'L1');
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
  assert.equal(result.recommend, 'L2');
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

test('adapter 有 Pilot 段且近期有 pilot／stage commit 是 L3，建議維持 L3', t => {
  const root = l2(t, { 'docs/agents/issue-run.md': `${L1_FILES['docs/agents/issue-run.md']}\n## Pilot\n\n- **Pool.** x\n` });
  assert.equal(detect(root).levels.L3.missing.join(), 'pilotCommits');
  git(root, 'switch', '-q', '-c', 'pilot/stage-3', 'pilot/integration');
  git(root, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'stage batch-3');
  const result = detect(root);
  assert.equal(result.level, 'L3');
  assert.equal(result.recommend, 'L3');
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

const L2_YES = ['--answer', 'delivered=yes', '--answer', 'sessions=yes'];

test('RECOMMEND：下一級的進入條件都不符時等於目前等級，都符合時升一級', t => {
  const root = repo(t, L1_FILES);
  const none = detect(root, '--answer', 'delivered=no', '--answer', 'sessions=no', '--answer', 'incident=no');
  assert.equal(none.recommend, 'L1');
  assert.equal(none.entry.L2.met, false);
  const yes = detect(root, ...L2_YES);
  assert.equal(yes.recommend, 'L2');
  assert.equal(yes.entry.L2.met, true);
});

test('等級站證據：近 90 天貢獻者數以作者 email 去重，90 天前的 commit 不算', t => {
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

test('等級站證據：同時存在的 Issue 分支與 linked worktree 數', t => {
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

test('等級站證據：GitHub tracker 的開放 Issue 數取自 gh；其他 tracker 記 unknown', t => {
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

test('等級站證據：還沒有 issue-tracker.md 時照 Host 站依 origin 推定 tracker', t => {
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

test('等級站證據：CI 與 gated 有無', t => {
  const none = detect(repo(t)).evidence;
  assert.equal(none.ci.value, 'no');
  assert.equal(none.gated.value, 'no');
  const github = detect(repo(t, { '.github/workflows/check.yml': 'on: push\n', 'db/V1__init.sql': 'select 1;\n' })).evidence;
  assert.equal(github.ci.value, 'yes');
  assert.deepEqual(github.ci.evidence, ['.github/workflows/check.yml']);
  assert.equal(github.gated.value, 'yes');
  assert.equal(detect(repo(t, { '.gitlab-ci.yml': 'stages: []\n' })).evidence.ci.value, 'yes');
});

test('L2 的「多個 session」與「發生過事故」擇一即可；L3 另需環境站的 Orca', t => {
  const root = repo(t, L1_FILES);
  assert.equal(detect(root, '--answer', 'delivered=yes', '--answer', 'incident=yes').recommend, 'L2');
  assert.deepEqual(detect(root, '--answer', 'delivered=yes').entry.L2.unmet, ['sessions|incident']);
  const l3 = l2(t);
  const answers = ['--answer', 'exitCodes=yes', '--answer', 'unattended=yes'];
  const noOrca = spawnSync('node', [script, l3, '--json', ...answers], { encoding: 'utf8', env: { ...offline, ORCA_CLI_COMMAND: '' } });
  assert.deepEqual(JSON.parse(noOrca.stdout).entry.L3.unmet, ['orca']);
  assert.equal(JSON.parse(noOrca.stdout).recommend, 'L2');
  const orca = spawnSync('node', [script, l3, '--json', ...answers], { encoding: 'utf8', env: { ...offline, ORCA_CLI_COMMAND: process.execPath } });
  assert.equal(JSON.parse(orca.stdout).recommend, 'L3');
});

test('文字輸出：目前等級以上每級的是非題與 ENTRY 行；不認得的 --answer exit 2', t => {
  const root = repo(t, L1_FILES);
  const result = spawnSync('node', [script, root, '--answer', 'delivered=yes'], { encoding: 'utf8', env: { ...offline, ORCA_CLI_COMMAND: '' } });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.split('\n');
  assert.ok(out.includes('QUESTION L2 delivered yes 是否已用 L1 的 /issue-run 交付過幾張 Issue？'), result.stdout);
  assert.ok(out.some(line => /^QUESTION L2 sessions unanswered .*（與 incident 擇一）$/.test(line)), result.stdout);
  assert.ok(out.includes('ENTRY L2 unmet sessions|incident'), result.stdout);
  assert.ok(out.includes('ENTRY L3 unmet exitCodes,orca,unattended'), result.stdout);
  assert.ok(!out.some(line => line.startsWith('QUESTION L1 ')), result.stdout);
  assert.ok(out.some(line => line.startsWith('EVIDENCE contributors ')), result.stdout);
  assert.equal(out.at(-3), 'RECOMMEND L1');
  for (const bad of ['delivered=maybe', 'nope=yes']) {
    assert.equal(spawnSync('node', [script, root, '--answer', bad], { encoding: 'utf8', env: offline }).status, 2, bad);
  }
});

test('L1 的檢查入口量得到就符合，量不到時人回答願意做也算', t => {
  const root = repo(t);
  const answers = ['--answer', 'useTracker=yes', '--answer', 'skills=yes'];
  assert.deepEqual(detect(root, ...answers).entry.L1.unmet, ['check|buildCheck']);
  assert.equal(detect(root, ...answers, '--answer', 'buildCheck=yes').recommend, 'L1');
  assert.equal(detect(repo(t, { 'bin/check': '#!/usr/bin/env bash\n' }), ...answers).recommend, 'L1');
});

test('--answer=<id>=yes 的寫法與分開寫的效果相同', t => {
  const root = repo(t, L1_FILES);
  assert.equal(detect(root, '--answer=delivered=yes', '--answer=incident=yes').recommend, 'L2');
});

test('一個 --answer 後面接好幾個答案、或 --answer 沒有值時 exit 2，不靜默丟掉', t => {
  const root = repo(t, L1_FILES);
  const run = (...args) => spawnSync('node', [script, ...args], { encoding: 'utf8', env: offline }).status;
  assert.equal(run(root, '--answer', 'delivered=yes', 'incident=yes'), 2);
  assert.equal(run(root, '--answer'), 2);
});

test('L1 的 tracker 量到 issue-tracker.md 就符合，量不到才問', t => {
  const answers = ['--answer', 'skills=yes', '--answer', 'buildCheck=yes'];
  assert.equal(detect(repo(t, { 'docs/agents/issue-tracker.md': 'gh\n' }), ...answers).recommend, 'L1');
  assert.deepEqual(detect(repo(t), ...answers).entry.L1.unmet, ['tracker|useTracker']);
  assert.equal(detect(repo(t), ...answers, '--answer', 'useTracker=yes').recommend, 'L1');
});

// detect.mjs 的 ENTRY_CONDITIONS 照 README 導入等級表的「進入條件」欄手寫；這欄改了，這個測試失敗，提醒同步是非題再更新下面的文字。
test('README 等級表的進入條件與 detect.mjs 的是非題同一版', () => {
  const readme = readFileSync(new URL('../docs/workflow/README.md', import.meta.url), 'utf8');
  const cells = Object.fromEntries(readme.split('\n').map(line => line.match(/^\| \*\*(L[1-3]) [^*]+\*\* \| [^|]+ \| ([^|]+) \|/)).filter(Boolean).map(([, level, cell]) => [level, cell.trim()]));
  assert.deepEqual(cells, {
    L1: '有 tracker、能裝 skills、repo 有（或願意做）一條能跑完所有檢查的指令',
    L2: 'L1 已交付過幾張；開始同時開好幾個 session，或已經發生過「繞過檢查」「合錯分支」「狀態對不上」',
    L3: 'L2 的入口都有固定 exit code；裝了 Orca；願意讓 agent 在無人值守時跑 git',
  });
});
