import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../skills/engineering/setup-workflow/scripts/health.mjs', import.meta.url).pathname;

/** 暫存 repo，目錄名為 acme（體檢以目錄名認出「本 repo」）；files 為 { 相對路徑: 內容 }，寫入後 commit。 */
function repo(t, files = {}) {
  const parent = mkdtempSync(join(realTmpdir(), 'setup-workflow-health-'));
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
  assert.match(divergence.find(line => line.includes('scripts/local.mjs')), /local-modified .*回饋到正本.*# .*commit abc/);
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
  assert.match(crossRepo.join('\n'), /~\/code\/spay2\/scripts\/orca-session-send\.mjs .*# docs\/agents\/issue-run\.md:9/);
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

test('等級標示：adapter 寫明「等級」的行不必提到 repo 名，描述某級機制的句子不算；同一行提到兩個等級不算宣稱', t => {
  const { lines } = health(repo(t, {
    'docs/agents/issue-run.md': '# issue-run adapter\n\n導入等級：L3\n\n- Push: L2 起由 pre-push hook 重驗。\n',
    'docs/guide.md': 'acme 的 adapter 只看五段就是 L1；其餘段落屬於 L3。\n',
  }));
  const level = lines.filter(line => line.startsWith('FINDING level'));
  assert.equal(level.length, 1, lines.join('\n'));
  assert.match(level[0], /claimed L3 detected L0 .*# docs\/agents\/issue-run\.md:3/);
});

test('已追蹤但工作樹刪掉的檔案不讓體檢中斷；清單缺 sha256 的項目回報而不中斷', t => {
  const root = repo(t, { 'notes.md': 'acme 是 L1\n', 'docs/agents/workflow-templates.json': JSON.stringify({ copies: { 'scripts/x.mjs': { template: TEMPLATE, commit: 'a' } } }) });
  rmSync(join(root, 'notes.md'));
  const { status, stderr, lines } = health(root);
  assert.equal(status, 1, stderr);
  assert.match(lines.find(line => line.startsWith('FINDING divergence')), /invalid-entry scripts\/x\.mjs/);
  assert.equal(lines.at(-1), 'FINDINGS 1');
});

test('清單項目缺 template 也回報 invalid-entry 而不中斷', t => {
  const { status, stderr, lines } = health(repo(t, { 'docs/agents/workflow-templates.json': JSON.stringify({ copies: { 'scripts/x.mjs': { commit: 'a', sha256: 'ab' } } }) }));
  assert.equal(status, 1, stderr);
  assert.match(lines.at(-2), /invalid-entry scripts\/x\.mjs/);
});

test('分歧：正本已不存在時回報 missing-canonical', t => {
  const manifest = { copies: { 'scripts/x.mjs': { template: 'skills/engineering/setup-workflow/templates/no-such.mjs', commit: 'a', sha256: sha256('x\n') } } };
  const { lines } = health(repo(t, { 'scripts/x.mjs': 'x\n', 'docs/agents/workflow-templates.json': JSON.stringify(manifest) }));
  assert.match(lines.find(line => line.startsWith('FINDING divergence')), /missing-canonical scripts\/x\.mjs/);
});

test('隱性跨 repo 依賴：bin/ 與 git hook 也掃；家目錄下直接放 repo 的檔案路徑也算', t => {
  const { lines } = health(repo(t, {
    'bin/check': '#!/usr/bin/env bash\nnode ~/code/spay2/scripts/x.mjs\n',
    '.githooks/pre-push': '#!/usr/bin/env bash\nnode ~/spay2/send.mjs\n',
  }));
  const crossRepo = lines.filter(line => line.startsWith('FINDING cross-repo')).join('\n');
  assert.match(crossRepo, /~\/code\/spay2\/scripts\/x\.mjs .*# bin\/check:2/);
  assert.match(crossRepo, /~\/spay2\/send\.mjs .*# \.githooks\/pre-push:2/);
});

test('不是 git repo 時 exit 2；不認得的旗標 exit 2', t => {
  const dir = mkdtempSync(join(realTmpdir(), 'setup-workflow-health-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(health(dir).status, 2);
  assert.equal(spawnSync('node', [script, repo(t), '--fix'], { encoding: 'utf8', env }).status, 2);
});

test('清單不是合法 JSON 時回報 invalid-manifest', t => {
  const { status, stderr, lines } = health(repo(t, { 'docs/agents/workflow-templates.json': '{bad' }));
  assert.equal(status, 1, stderr);
  assert.match(lines.at(-2), /^FINDING divergence invalid-manifest /);
});

test('清單是合法 JSON 但不是物件（null、copies 是陣列）時回報 invalid-manifest 而不中斷', t => {
  for (const content of ['null', '[]', '{"copies":null}', JSON.stringify({ copies: [{ template: TEMPLATE, sha256: 'ab' }] })]) {
    const { status, stderr, lines } = health(repo(t, { 'docs/agents/workflow-templates.json': content }));
    assert.equal(status, 1, `${content}\n${stderr}`);
    assert.match(lines.at(-2), /^FINDING divergence invalid-manifest /, content);
    assert.equal(lines.at(-1), 'FINDINGS 1', content);
  }
});

test('掃到的路徑是目錄（指向目錄的 symlink）時略過而不中斷', t => {
  const root = repo(t, { 'lib/a.mjs': 'x\n' });
  symlinkSync('../lib', join(root, 'scripts'));
  symlinkSync('lib', join(root, 'notes.md'));
  symlinkSync('loop-b', join(root, 'loop-a'));
  symlinkSync('loop-a', join(root, 'loop-b'));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'links');
  const { status, stderr, lines } = health(root);
  assert.equal(status, 0, stderr);
  assert.equal(lines.at(-1), 'HEALTHY');
});

test('清單項目的副本或正本是目錄時回報而不中斷', t => {
  const manifest = { copies: {
    lib: { template: TEMPLATE, commit: 'a', sha256: 'ab' },
    'scripts/x.mjs': { template: 'skills', commit: 'a', sha256: 'ab' },
  } };
  const { status, stderr, lines } = health(repo(t, { 'lib/a.mjs': 'x\n', 'scripts/x.mjs': 'x\n', 'docs/agents/workflow-templates.json': JSON.stringify(manifest) }));
  assert.equal(status, 1, stderr);
  assert.match(lines.join('\n'), /missing-copy lib /);
  assert.match(lines.join('\n'), /missing-canonical scripts\/x\.mjs /);
  assert.equal(lines.at(-1), 'FINDINGS 2');
});

test('隱性跨 repo 依賴：settings.json 裡跳脫的雙引號（\\"$HOME\\"/...）也算', t => {
  const { lines } = health(repo(t, { '.claude/settings.json': '{"command":"node \\"$HOME\\"/code/spay2/a.mjs"}\n' }));
  assert.match(lines.find(line => line.startsWith('FINDING cross-repo')) ?? '', /^FINDING cross-repo \$HOME\/code\/spay2\/a\.mjs .*# \.claude\/settings\.json:1/);
});

test('隱性跨 repo 依賴：bash 把 $HOME 單獨加引號的寫法也算；"~" 與 \'$HOME\' 不會展開，不算', t => {
  const { lines } = health(repo(t, {
    'scripts/run.sh': '#!/usr/bin/env bash\nnode "$HOME"/code/spay2/scripts/a.mjs\nnode "${HOME}"/code/spay2/scripts/b.mjs\nnode "~"/code/spay2/scripts/c.mjs\nnode "$HOME/code/spay2"/scripts/d.mjs\nnode \'$HOME\'/code/spay2/scripts/e.mjs\n',
  }));
  const crossRepo = lines.filter(line => line.startsWith('FINDING cross-repo')).join('\n');
  assert.equal(crossRepo.split('\n').length, 3, crossRepo);
  assert.doesNotMatch(crossRepo, /"/, '證據不留半個引號');
  assert.match(crossRepo, /\$HOME\/code\/spay2\/scripts\/d\.mjs .*# scripts\/run\.sh:5/);
  assert.match(crossRepo, /spay2\/scripts\/a\.mjs .*# scripts\/run\.sh:2/);
  assert.match(crossRepo, /spay2\/scripts\/b\.mjs .*# scripts\/run\.sh:3/);
  assert.doesNotMatch(crossRepo, /c\.mjs|e\.mjs/);
});

test('非 ASCII 檔名（core.quotePath 會加引號跳脫）也掃到，不只回報 ASCII 那份', t => {
  const { lines } = health(repo(t, {
    'scripts/部署.sh': '#!/usr/bin/env bash\ncat ~/code/other/x.sh\n',
    'scripts/deploy.sh': '#!/usr/bin/env bash\ncat ~/code/other/x.sh\n',
    'docs/說明.md': 'acme 是 L2\n',
  }));
  const text = lines.join('\n');
  assert.match(text, /# scripts\/部署\.sh:2/);
  assert.match(text, /# scripts\/deploy\.sh:2/);
  assert.match(text, /claimed L2 detected L0 .*# docs\/說明\.md:1/);
  assert.equal(lines.at(-1), 'FINDINGS 3');
});

test('讀不到的檔案（EACCES）不讓體檢中斷：掃描時警告略過，清單的副本讀不到時回報 unreadable', { skip: process.getuid?.() === 0 && 'root 讀得到 000 的檔案' }, t => {
  const manifest = { copies: { 'scripts/copy.mjs': { template: TEMPLATE, commit: 'a', sha256: sha256(canonical) } } };
  const root = repo(t, { 'scripts/secret.sh': 'cat ~/code/other/x.sh\n', 'notes.md': 'acme 是 L1\n', 'scripts/copy.mjs': canonical, 'docs/agents/workflow-templates.json': JSON.stringify(manifest) });
  for (const file of ['scripts/secret.sh', 'notes.md', 'scripts/copy.mjs']) chmodSync(join(root, file), 0o000);
  const { status, stderr, lines } = health(root);
  assert.equal(status, 1, stderr);
  assert.match(stderr, /scripts\/secret\.sh/);
  assert.match(stderr, /notes\.md/);
  assert.match(lines.join('\n'), /^FINDING divergence unreadable scripts\/copy\.mjs /m);
  assert.equal(lines.at(-1), 'FINDINGS 1');
});

test('隱性跨 repo 依賴：regex 字面值裡跳脫的斜線（\\/）不是路徑', t => {
  const { status, lines } = health(repo(t, {
    'scripts/check.mjs': 'const pattern = /\\$HOME\\/code\\/spay2\\/x\\.mjs/;\nconst other = /~\\/code\\/spay2\\/scripts/;\n',
  }));
  assert.equal(status, 0, lines.join('\n'));
  assert.equal(lines.at(-1), 'HEALTHY');
});

test('分歧：副本與正本一致、只有清單記錄的 sha256 過時時回報 stale-record，不當成兩邊都改', t => {
  const { status, lines } = health(withCopies(t, { 'scripts/x.mjs': [canonical, '// 舊版正本\n'] }));
  assert.equal(status, 1);
  assert.match(lines.find(line => line.startsWith('FINDING divergence')), /^FINDING divergence stale-record scripts\/x\.mjs .*記錄過時/);
  assert.doesNotMatch(lines.join('\n'), /both-modified/);
  assert.equal(lines.at(-1), 'FINDINGS 1');
});

test('SKILL.md 的 Health check 寫明 exit 2 的情況，並列出體檢會印的每個 divergence 類別', () => {
  const skill = readFileSync(new URL('../skills/engineering/setup-workflow/SKILL.md', import.meta.url), 'utf8');
  const section = skill.slice(skill.indexOf('## Health check'), skill.indexOf('## Templates'));
  assert.match(section, /exit 2/);
  for (const kind of ['canonical-newer', 'local-modified', 'both-modified', 'stale-record', 'missing-copy', 'missing-canonical', 'invalid-entry', 'invalid-manifest', 'unreadable']) {
    assert.match(section, new RegExp(`\`(divergence )?${kind}\``), kind);
  }
});

test('隱性跨 repo 依賴：JSON 字串值開頭的 ~ 會展開，要回報；~ 後面緊接雙引號（~"/x"）不展開，不算', t => {
  const { lines } = health(repo(t, {
    '.claude/settings.json': '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"~/code/spay2/scripts/hook.mjs"}]}]}}\n',
    'scripts/run.sh': '#!/usr/bin/env bash\ncat ~"/code/spay2/x.sh"\n',
  }));
  const crossRepo = lines.filter(line => line.startsWith('FINDING cross-repo'));
  assert.equal(crossRepo.length, 1, lines.join('\n'));
  assert.match(crossRepo[0], /~\/code\/spay2\/scripts\/hook\.mjs .*# \.claude\/settings\.json:1/);
});

test('清單本身讀不到時回報 unreadable，不說成不是合法 JSON', { skip: process.getuid?.() === 0 && 'root 讀得到 000 的檔案' }, t => {
  const root = repo(t, { 'docs/agents/workflow-templates.json': '{"copies":{}}' });
  chmodSync(join(root, 'docs/agents/workflow-templates.json'), 0o000);
  const { status, stderr, lines } = health(root);
  assert.equal(status, 1, stderr);
  assert.match(lines.at(-2), /^FINDING divergence unreadable docs\/agents\/workflow-templates\.json /);
  assert.doesNotMatch(lines.join('\n'), /合法 JSON/);
});

test('清單路徑是目錄時回報 invalid-manifest，不說成讀不到', t => {
  const root = repo(t, { 'docs/agents/workflow-templates.json/x': '{}' });
  const { status, stderr, lines } = health(root);
  assert.equal(status, 1, stderr);
  assert.match(lines.at(-2), /^FINDING divergence invalid-manifest docs\/agents\/workflow-templates\.json /);
});
