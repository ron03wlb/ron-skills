import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../skills/engineering/setup-workflow/scripts/copy-templates.mjs', import.meta.url).pathname;
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const env = { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const MANIFEST = 'docs/agents/workflow-templates.json';
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** 假的 ron-skills（帶 copy-templates.mjs 與幾支正本）與一個空的目標 repo。 */
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'setup-workflow-copy-'));
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
