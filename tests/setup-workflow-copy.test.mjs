import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../skills/engineering/setup-workflow/scripts/copy-templates.mjs', import.meta.url).pathname;
const MANIFEST = 'docs/agents/workflow-templates.json';
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** 假的 ron-skills（帶 copy-templates.mjs 與幾支正本）與一個空的目標 repo。 */
function fixture(t) {
  const temp = mkdtempSync(join(realTmpdir(), 'setup-workflow-copy-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = join(temp, 'ron-skills');
  const skill = join(source, 'skills/engineering/setup-workflow');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  cpSync(script, join(skill, 'scripts/copy-templates.mjs'));
  write(join(skill, 'templates'), {
    'a.mjs': "import { b } from './b.mjs';\nconst PRELOAD = new URL('./lib/pre.mjs', import.meta.url);\n",
    'b.mjs': 'export const b = 1;\n',
    'lib/pre.mjs': '// preload\n',
    'a.test.mjs': "import './test/helper.mjs';\nimport { b } from './a.mjs';\n",
    'test/helper.mjs': "const dir = join(import.meta.dirname, 'fixtures/orca');\n",
    'test/fixtures/orca/send.json': '{}\n',
    'test/fixtures/other/x.json': '{}\n',
    'other.mjs': '// unrelated\n',
  });
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'templates');
  const target = join(temp, 'target');
  mkdirSync(target);
  git(target, 'init', '-q', '-b', 'main');
  return { source, target, copier: join(skill, 'scripts/copy-templates.mjs'), commit: git(source, 'rev-parse', 'HEAD') };
}

const run = (copier, ...args) => spawnSync('node', [copier, ...args], { encoding: 'utf8', env });

test('--dry-run 列出正本、執行期相依、測試與測試用 fixtures，不寫任何檔', t => {
  const { target, copier } = fixture(t);
  const result = run(copier, target, '--dry-run', 'a');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'COPY scripts/a.mjs',
    'COPY scripts/a.test.mjs',
    'COPY scripts/b.mjs',
    'COPY scripts/lib/pre.mjs',
    'COPY scripts/test/fixtures/orca/send.json',
    'COPY scripts/test/helper.mjs',
    'PLANNED 6',
  ]);
  assert.equal(existsSync(join(target, 'scripts')), false);
});

test('複製後 workflow-templates.json 記錄每個副本的正本路徑、ron-skills commit 與 sha256', t => {
  const { source, target, copier, commit } = fixture(t);
  const result = run(copier, target, 'a.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').pop(), 'COPIED 6');
  const { copies } = JSON.parse(readFileSync(join(target, MANIFEST), 'utf8'));
  assert.deepEqual(Object.keys(copies).sort(), ['scripts/a.mjs', 'scripts/a.test.mjs', 'scripts/b.mjs', 'scripts/lib/pre.mjs', 'scripts/test/fixtures/orca/send.json', 'scripts/test/helper.mjs']);
  assert.deepEqual(copies['scripts/b.mjs'], { template: 'skills/engineering/setup-workflow/templates/b.mjs', commit, sha256: sha256(join(source, 'skills/engineering/setup-workflow/templates/b.mjs')) });
  for (const [path, entry] of Object.entries(copies)) assert.equal(sha256(join(target, path)), entry.sha256, path);
});

test('--no-tests 只複製正本與執行期相依；再次複製保留清單中既有的項目', t => {
  const { target, copier } = fixture(t);
  assert.equal(run(copier, target, '--no-tests', 'a').status, 0);
  assert.equal(run(copier, target, '--no-tests', 'other').status, 0);
  const { copies } = JSON.parse(readFileSync(join(target, MANIFEST), 'utf8'));
  assert.deepEqual(Object.keys(copies).sort(), ['scripts/a.mjs', 'scripts/b.mjs', 'scripts/lib/pre.mjs', 'scripts/other.mjs']);
});

test('既有檔案內容不同時列出差異並以 exit 3 停下、不覆蓋；--yes 才覆蓋', t => {
  const { target, copier } = fixture(t);
  write(target, { 'scripts/b.mjs': 'export const b = 2;\n' });
  const refused = run(copier, target, '--no-tests', 'a');
  assert.equal(refused.status, 3);
  assert.match(refused.stdout, /^DIFF scripts\/b\.mjs$/m);
  assert.match(refused.stdout, /-export const b = 2;/);
  assert.match(refused.stdout, /\+export const b = 1;/);
  assert.equal(refused.stdout.trim().split('\n').pop(), 'CONFIRM_OVERWRITE scripts/b.mjs');
  assert.equal(readFileSync(join(target, 'scripts/b.mjs'), 'utf8'), 'export const b = 2;\n');
  assert.equal(existsSync(join(target, MANIFEST)), false);
  assert.equal(run(copier, target, '--no-tests', '--yes', 'a').status, 0);
  assert.equal(readFileSync(join(target, 'scripts/b.mjs'), 'utf8'), 'export const b = 1;\n');
});

// 副本的 sha256 與清單記錄一致就是沒手改過的上一版：正本更新後重新複製不必再要人確認（#156：tab-state 正本 commit 後還要 --yes）。
test('既有副本與清單記錄的 sha256 一致時直接覆寫，印 UPDATE 不要求確認', t => {
  const { source, target, copier } = fixture(t);
  assert.equal(run(copier, target, '--no-tests', 'a').status, 0);
  write(join(source, 'skills/engineering/setup-workflow/templates'), { 'b.mjs': 'export const b = 3;\n' });
  git(source, 'commit', '-qam', 'b 3');
  const result = run(copier, target, '--no-tests', 'a');
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^UPDATE scripts\/b\.mjs$/m);
  assert.equal(result.stdout.trim().split('\n').pop(), 'COPIED 3');
  assert.equal(readFileSync(join(target, 'scripts/b.mjs'), 'utf8'), 'export const b = 3;\n');
  const { copies } = JSON.parse(readFileSync(join(target, MANIFEST), 'utf8'));
  assert.equal(copies['scripts/b.mjs'].sha256, sha256(join(target, 'scripts/b.mjs')));
});

test('既有副本與清單記錄不一致（手改過）時仍 CONFIRM_OVERWRITE', t => {
  const { source, target, copier } = fixture(t);
  assert.equal(run(copier, target, '--no-tests', 'a').status, 0);
  write(target, { 'scripts/b.mjs': 'export const b = 2;\n' });
  write(join(source, 'skills/engineering/setup-workflow/templates'), { 'b.mjs': 'export const b = 3;\n' });
  git(source, 'commit', '-qam', 'b 3');
  const result = run(copier, target, '--no-tests', 'a');
  assert.equal(result.status, 3, result.stdout);
  assert.equal(result.stdout.trim().split('\n').pop(), 'CONFIRM_OVERWRITE scripts/b.mjs');
});

test('內容相同的既有檔案不算覆蓋，直接記錄', t => {
  const { target, copier } = fixture(t);
  write(target, { 'scripts/b.mjs': 'export const b = 1;\n' });
  const result = run(copier, target, '--no-tests', 'a');
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^SAME scripts\/b\.mjs$/m);
});

test('正本有未提交改動時 exit 2：記錄的 commit 會對不上內容', t => {
  const { source, target, copier } = fixture(t);
  write(source, { 'skills/engineering/setup-workflow/templates/b.mjs': 'export const b = 9;\n' });
  const result = run(copier, target, 'a');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /templates\/b\.mjs/);
  assert.equal(run(copier, target, 'missing').status, 2, '不存在的正本');
});

test('不認得的旗標 exit 2，不寫任何檔（打錯 --dry-run 不能變成真的複製）', t => {
  const { target, copier } = fixture(t);
  const result = run(copier, target, '--dryrun', 'a');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dryrun/);
  assert.equal(existsSync(join(target, 'scripts')), false);
});

test('--verify 沒有清單時 exit 1，不算驗證通過', t => {
  const { target, copier } = fixture(t);
  const result = run(copier, target, '--verify');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^MISSING docs\/agents\/workflow-templates\.json$/m);
});

test('--verify：每一筆 hash 與實際檔案一致時 VERIFIED，有一筆不同就 exit 1 並列出', t => {
  const { target, copier } = fixture(t);
  assert.equal(run(copier, target, 'a').status, 0);
  const ok = run(copier, target, '--verify');
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(ok.stdout.trim(), 'VERIFIED 6');
  write(target, { 'scripts/b.mjs': 'export const b = 3;\n' });
  rmSync(join(target, 'scripts/lib/pre.mjs'));
  const bad = run(copier, target, '--verify');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^MISMATCH scripts\/b\.mjs$/m);
  assert.match(bad.stdout, /^MISSING scripts\/lib\/pre\.mjs$/m);
});

// #246：Bare guard 的正本是 shell（pilot-unbare.sh、claude-hook-unbare.sh），hook 以 "$(dirname "$0")/pilot-unbare.sh" 呼叫旁邊那支。
test('shell 正本保留副檔名與執行權限，帶上 $(dirname "$0") 呼叫的同目錄腳本與 <名稱>.test.mjs', t => {
  const { source, target, copier } = fixture(t);
  const templates = join(source, 'skills/engineering/setup-workflow/templates');
  write(templates, {
    'hook.sh': '#!/usr/bin/env bash\nexec "$(dirname "$0")/guard.sh" "$PWD" hook\n',
    'guard.sh': '#!/usr/bin/env bash\necho guard\n',
    'hook.test.mjs': "const hook = new URL('./hook.sh', import.meta.url);\n",
  });
  chmodSync(join(templates, 'hook.sh'), 0o755);
  chmodSync(join(templates, 'guard.sh'), 0o755);
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'shell templates');

  const result = run(copier, target, 'hook.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['COPY scripts/guard.sh', 'COPY scripts/hook.sh', 'COPY scripts/hook.test.mjs', 'COPIED 3']);
  for (const file of ['scripts/guard.sh', 'scripts/hook.sh']) assert.equal(statSync(join(target, file)).mode & 0o111, 0o111, file);
  const copies = JSON.parse(readFileSync(join(target, MANIFEST), 'utf8')).copies;
  assert.deepEqual(Object.keys(copies).sort(), ['scripts/guard.sh', 'scripts/hook.sh', 'scripts/hook.test.mjs']);
});

test('#277：字串或註解裡的 import 不算相依；template literal 讀的 test/fixtures/<目錄> 整個帶上；多行與動態 import 也算', t => {
  const { source, target, copier } = fixture(t);
  const templates = join(source, 'skills/engineering/setup-workflow/templates');
  write(templates, {
    'c.mjs': "import {\n  b,\n} from './b.mjs';\n// import { x } from './gone-comment.mjs';\n",
    'c.test.mjs': [
      "const bad = \"import { realTmpdir } from './helpers/real-tmpdir.mjs';\";",
      "const fx = name => new URL(`./test/fixtures/github/${name}.json`, import.meta.url);",
      "const mod = await import('./lib/pre.mjs');",
      '',
    ].join('\n'),
    'test/fixtures/github/issues.json': '[]\n',
    'test/fixtures/github/nested/deep.json': '{}\n',
  });
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'more templates');
  const result = run(copier, target, '--dry-run', 'c');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'COPY scripts/b.mjs',
    'COPY scripts/c.mjs',
    'COPY scripts/c.test.mjs',
    'COPY scripts/lib/pre.mjs',
    'COPY scripts/test/fixtures/github/issues.json',
    'COPY scripts/test/fixtures/github/nested/deep.json',
    'PLANNED 6',
  ]);
});

test('#277：真正的範本 check-portability 與 issue-pool 可以 dry-run，issue-pool 帶上 github 與 gitlab 樣本', () => {
  const temp = mkdtempSync(join(realTmpdir(), 'setup-workflow-copy-real-'));
  try {
    git(temp, 'init', '-q', '-b', 'main');
    const result = run(script, temp, '--dry-run', 'check-portability.mjs', 'issue-pool.mjs');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^COPY scripts\/test\/fixtures\/github\/issues\.json$/m);
    assert.match(result.stdout, /^COPY scripts\/test\/fixtures\/gitlab\//m);
    assert.doesNotMatch(result.stdout, /helpers\/real-tmpdir/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('#281：開頭的 `// copy-templates: requires <檔名>...` 宣告一定要帶上的同目錄檔；沒宣告的 join(here, …) 選用檔不帶', t => {
  const { source, target, copier } = fixture(t);
  const templates = join(source, 'skills/engineering/setup-workflow/templates');
  write(templates, {
    'd.mjs': "#!/usr/bin/env node\n// copy-templates: requires e.mjs guard.sh\nconst opt = join(here, 'optional.mjs');\n",
    'e.mjs': '// e\n',
    'guard.sh': '#!/usr/bin/env bash\n',
    'optional.mjs': '// 旁邊有才用\n',
  });
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'requires');
  const result = run(copier, target, '--dry-run', 'd');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['COPY scripts/d.mjs', 'COPY scripts/e.mjs', 'COPY scripts/guard.sh', 'PLANNED 3']);
  write(templates, { 'f.mjs': '// copy-templates: requires missing.mjs\n' });
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'missing');
  const missing = run(copier, target, '--dry-run', 'f');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /正本不存在：templates\/missing\.mjs/);
});

test('#281：真正的 pilot-close 帶上 pilot-counterpart 與 pilot-unbare.sh，不帶只支援 GitHub 的 gh-tracker', () => {
  const temp = mkdtempSync(join(realTmpdir(), 'setup-workflow-copy-close-'));
  try {
    git(temp, 'init', '-q', '-b', 'main');
    const result = run(script, temp, '--dry-run', '--no-tests', 'pilot-close.mjs', 'pilot-land.mjs');
    assert.equal(result.status, 0, result.stderr);
    for (const file of ['pilot-counterpart.mjs', 'pilot-unbare.sh', 'orca-worktree-create.mjs']) assert.match(result.stdout, new RegExp(`^COPY scripts/${file}$`, 'm'), file);
    assert.doesNotMatch(result.stdout, /gh-tracker/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
