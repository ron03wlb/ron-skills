import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, git, write } from './helpers/git-fixture.mjs';

const script = new URL('../skills/engineering/setup-workflow/scripts/health.mjs', import.meta.url).pathname;

/** 暫存 repo，目錄名為 acme（體檢以目錄名認出「本 repo」）；files 為 { 相對路徑: 內容 }，寫入後 commit。 */
function repo(t, files = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'setup-workflow-health-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'acme');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  write(root, { 'README.md': 'x\n', ...files });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

function health(root) {
  const result = spawnSync('node', [script, root], { encoding: 'utf8', env });
  return { status: result.status, stderr: result.stderr, lines: result.stdout.trim().split('\n') };
}

const ADAPTER = '# issue-run adapter: acme\n\n## Checks\n\nOne command: `bin/check`.\n';

/** L3：tracker、adapter（含 Pilot 段）、檢查入口、跑 bin/check 的 pre-push、整合分支、合入過的 Issue 分支與 stage batch commit。 */
function l3(t, files = {}) {
  const root = repo(t, {
    'docs/agents/issue-tracker.md': 'Read an Issue: `gh issue view <n> --json body`\n',
    'docs/agents/issue-run.md': `${ADAPTER}\n## Pilot\n\n- **Pool.** x\n`,
    'bin/check': '#!/usr/bin/env bash\ntrue\n',
    '.githooks/pre-push': '#!/usr/bin/env bash\nbin/check\n',
    ...files,
  });
  chmodSync(join(root, '.githooks/pre-push'), 0o755);
  git(root, 'switch', '-q', '-c', 'issue/3-fix');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'fix');
  git(root, 'switch', '-q', '-c', 'pilot/integration', 'main');
  git(root, 'merge', '-q', '--no-ff', '-m', "stage batch-3: merge issue/3-fix (#3)", 'issue/3-fix');
  git(root, 'switch', '-q', 'main');
  git(root, 'config', 'core.hooksPath', '.githooks');
  return root;
}

test('等級標示錯誤：已是 L3 的 repo 在文件裡被標成 L1（#28 修正前的 ron-skills）', t => {
  const root = l3(t, { 'docs/workflow/README.md': '## 實例\n\n- **L1：acme 本身。** adapter 是 docs/agents/issue-run.md。\n' });
  const { status, lines } = health(root);
  assert.equal(status, 1);
  const finding = lines.find(line => line.startsWith('FINDING level'));
  assert.match(finding, /claimed L1 detected L3/);
  assert.match(finding, /docs\/workflow\/README\.md:3/);
  assert.equal(lines.at(-1), 'FINDINGS 1');
});

const TEMPLATE = 'skills/engineering/setup-workflow/templates/check-secrets.mjs';
const canonical = readFileSync(new URL(`../${TEMPLATE}`, import.meta.url), 'utf8');
const sha256 = text => createHash('sha256').update(text).digest('hex');

/** 有 workflow-templates.json 的 repo：copies 為 { 副本路徑: [副本內容, 清單記錄的內容] }。 */
function withCopies(t, copies) {
  const manifest = { source: 'ron03wlb/ron-skills', copies: {} };
  const files = {};
  for (const [path, [content, recorded]] of Object.entries(copies)) {
    files[path] = content;
    manifest.copies[path] = { template: TEMPLATE, commit: 'abc', sha256: sha256(recorded) };
  }
  return repo(t, { ...files, 'docs/agents/workflow-templates.json': `${JSON.stringify(manifest, null, 2)}\n` });
}

test('分歧：正本較新、專案本地改過（如語言 hook 移植後註解不同）、兩邊都改了各自分類，一致的副本不回報', t => {
  const old = '// 舊版正本\n';
  const local = `${canonical}// 專案自己加的一行\n`;
  const { status, lines } = health(withCopies(t, {
    'scripts/same.mjs': [canonical, canonical],
    'scripts/canonical-newer.mjs': [old, old],
    'scripts/local.mjs': [local, canonical],
    'scripts/both.mjs': [local, old],
  }));
  assert.equal(status, 1);
  const divergence = lines.filter(line => line.startsWith('FINDING divergence'));
  assert.equal(divergence.length, 3, lines.join('\n'));
  assert.match(divergence.find(line => line.includes('scripts/canonical-newer.mjs')), /canonical-newer .*人確認後覆蓋/);
  assert.match(divergence.find(line => line.includes('scripts/local.mjs')), /local-modified .*回饋到正本/);
  assert.match(divergence.find(line => line.includes('scripts/both.mjs')), /both-modified .*交給人決定/);
  assert.match(lines.join('\n'), /專案自己加的一行/, '兩邊都改了要列出差異');
  assert.equal(lines.at(-1), 'FINDINGS 3');
});

test('分歧：清單裡的副本不存在也回報', t => {
  const manifest = { source: 'ron03wlb/ron-skills', copies: { 'scripts/gone.mjs': { template: TEMPLATE, commit: 'abc', sha256: sha256(canonical) } } };
  const { lines } = health(repo(t, { 'docs/agents/workflow-templates.json': JSON.stringify(manifest) }));
  assert.match(lines.find(line => line.startsWith('FINDING divergence')), /missing-copy scripts\/gone\.mjs/);
});

test('隱性跨 repo 依賴：adapter、settings、scripts 裡指向其他 repo 的絕對路徑（#22 修正前的 Dispatch）', t => {
  const { status, lines } = health(repo(t, {
    'docs/agents/issue-run.md': `${ADAPTER}\n## Pilot\n\n- **Dispatch.** \`node ~/code/spay2/scripts/orca-session-send.mjs --terminal <handle>\`\n`,
    '.claude/settings.json': '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node /home/someone/code/other-repo/scripts/hook.mjs"}]}]}}\n',
    'scripts/run.sh': '#!/usr/bin/env bash\nnode "$HOME/work/tools/bin/x.mjs"\n',
  }));
  assert.equal(status, 1);
  const crossRepo = lines.filter(line => line.startsWith('FINDING cross-repo'));
  assert.equal(crossRepo.length, 3, lines.join('\n'));
  assert.match(crossRepo[0], /~\/code\/spay2\/scripts\/orca-session-send\.mjs .*# docs\/agents\/issue-run\.md:9/);
  assert.match(crossRepo.join('\n'), /\/home\/someone\/code\/other-repo\/scripts\/hook\.mjs .*# \.claude\/settings\.json:1/);
  assert.match(crossRepo.join('\n'), /\$HOME\/work\/tools\/bin\/x\.mjs .*# scripts\/run\.sh:2/);
});

test('隱性跨 repo 依賴：指向本 repo、使用者設定目錄或只到 repo 目錄本身的路徑不算', t => {
  const { status, lines } = health(repo(t, {
    'docs/agents/issue-run.md': `${ADAPTER}\n- \`/home/ron/code/acme/.scratch/pilot/\`、\`/home/ron/orca/workspaces/acme/pilot-stage/bin/check\`\n- \`~/.claude/skills/tdd/SKILL.md\`；本機 \`~/code/skills\` 是 fork。\n`,
  }));
  assert.equal(status, 0, lines.join('\n'));
  assert.equal(lines.at(-1), 'HEALTHY');
});
