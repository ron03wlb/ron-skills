import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { hasSystemBash, systemBashPath } from '../skills/engineering/setup-workflow/templates/test/bash32.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const sync = join(root, 'bin/sync-skills');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const run = (args, extra = {}, cwd = root) => spawnSync(sync, args, { encoding: 'utf8', cwd, env: { ...env, ...extra } });

const scratch = t => {
  const dir = mkdtempSync(join(realTmpdir(), 'sync-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const skill = (dir, front = '') => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: x\n${front}---\n`);
  return dir;
};

// 重現真實歷史：macOS 內建 bash 3.2 沒有 `declare -A`，bash 版的 sync-skills 一開始就失敗（#85）。
test('PATH 上的 bash 是 /bin/bash 時 --check 照樣通過', { skip: !hasSystemBash && '沒有 /bin/bash' }, t => {
  const result = run(['--check'], { PATH: systemBashPath(t) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CHECK_OK \d+ skills$/m);
});

// #287：連結目標消失時 --check 仍只印 CHECK_OK，依賴 repo 外來源也看不出來（~/Documents/Workspace/skills 四個連結）。
test('--check 回報失效連結與 repo 外的來源，不影響 exit；受管來源不報', t => {
  const tmp = scratch(t);
  const dest = join(tmp, 'dest');
  mkdirSync(dest);
  symlinkSync(join(tmp, 'gone/old-skill'), join(dest, 'gone'));
  const outside = realpathSync(skill(join(tmp, 'elsewhere/delta')));
  symlinkSync(outside, join(dest, 'delta'));
  symlinkSync(join(root, 'skills/engineering/issue-run'), join(dest, 'issue-run'));

  const result = run(['--check'], { SKILL_DIRS: dest });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`^DANGLING ${join(dest, 'gone')} -> `, 'm'));
  assert.match(result.stderr, new RegExp(`^EXTERNAL ${join(dest, 'delta')} -> ${outside}$`, 'm'));
  assert.doesNotMatch(result.stderr, /(DANGLING|EXTERNAL) \S*\/issue-run /);
});

test('--list 依連結的真實位置標出來源，並列出目前目錄的專案 skill', t => {
  const tmp = scratch(t);
  const matt = join(tmp, 'matt'), pstack = join(tmp, 'pstack'), xdg = join(tmp, 'xdg'), dest = join(tmp, 'dest'), proj = join(tmp, 'proj');
  mkdirSync(dest);
  symlinkSync(skill(join(matt, 'skills/eng/alpha')), join(dest, 'alpha'));
  symlinkSync(skill(join(pstack, 'skills/beta'), 'disable-model-invocation: true\n'), join(dest, 'beta'));
  symlinkSync(skill(join(xdg, 'ron-skills/overlay/gamma')), join(dest, 'gamma'));
  symlinkSync(join(root, 'skills/engineering/issue-run'), join(dest, 'issue-run'));
  symlinkSync(skill(join(tmp, 'elsewhere/delta')), join(dest, 'delta'));
  skill(join(dest, 'local'));
  mkdirSync(join(dest, 'no-skill-md'));
  writeFileSync(join(dest, 'README'), '');
  skill(join(proj, '.claude/skills/proj-only'));

  const result = run(['--list'], { MATT_SKILLS: matt, PSTACK_SKILLS: pstack, XDG_DATA_HOME: xdg, SKILL_DIRS: dest }, proj);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    'model\talpha\tmatt',
    'model\tdelta\tother',
    'model\tgamma\toverlay',
    'model\tissue-run\tron-skills',
    'model\tlocal\tother',
    'model\tproj-only\tproject',
    'user\tbeta\tpstack',
    '',
  ].join('\n'));
});

test('同步把 hooks/ 連到 HOOK_DIR：沒有就建，內容相同的實體檔換成連結，內容不同的不覆蓋', t => {
  const tmp = scratch(t);
  const hooks = join(tmp, 'hooks');
  mkdirSync(hooks);
  const same = join(hooks, 'orca-tab-title.sh'), different = join(hooks, 'orca-tab-title.test.sh');
  writeFileSync(same, readFileSync(join(root, 'hooks/orca-tab-title.sh')));
  writeFileSync(different, '本機改過\n');
  const result = run([], { XDG_DATA_HOME: join(tmp, 'xdg'), SKILL_DIRS: join(tmp, 'a'), HOOK_DIR: hooks });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(same), join(root, 'hooks/orca-tab-title.sh'));
  assert.equal(lstatSync(different).isSymbolicLink(), false);
  assert.equal(readFileSync(different, 'utf8'), '本機改過\n');
  assert.match(result.stderr, /SKIP .*orca-tab-title\.test\.sh/);
  const fresh = join(tmp, 'fresh');
  assert.equal(run([], { XDG_DATA_HOME: join(tmp, 'xdg'), SKILL_DIRS: join(tmp, 'a'), HOOK_DIR: fresh }).status, 0);
  assert.equal(readlinkSync(join(fresh, 'orca-tab-title.sh')), join(root, 'hooks/orca-tab-title.sh'));
});

test('同步只換掉受管連結：清掉清單外的舊連結，不碰別處的連結與實體目錄', t => {
  const tmp = scratch(t);
  const xdg = join(tmp, 'xdg'), a = join(tmp, 'a'), b = join(tmp, 'b');
  mkdirSync(a);
  symlinkSync(join(root, 'skills/engineering/removed-skill'), join(a, 'removed-skill'));
  symlinkSync(join(tmp, 'foreign'), join(a, 'foreign'));
  skill(join(a, 'issue-pilot'));
  const extra = { XDG_DATA_HOME: xdg, SKILL_DIRS: `${a} ${b}`, HOOK_DIR: join(tmp, 'hooks') };

  const count = run(['--check'], extra).stdout.match(/^CHECK_OK (\d+) skills$/m)?.[1];
  const result = run([], extra);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.replace(/^SKILL_CHANGED .*\n/gm, ''), `SYNCED ${count} skills → ${a} ${b}\n`);
  assert.match(result.stderr, new RegExp(`^SKIP ${a}/issue-pilot（實體目錄，不覆蓋）$`, 'm'));
  assert.equal(lstatSync(join(a, 'issue-pilot')).isSymbolicLink(), false);
  assert.equal(lstatSync(join(a, 'removed-skill'), { throwIfNoEntry: false }), undefined);
  assert.equal(readlinkSync(join(a, 'foreign')), join(tmp, 'foreign'));
  assert.equal(readlinkSync(join(b, 'issue-pilot')), join(root, 'skills/engineering/issue-pilot'));
  assert.equal(readlinkSync(join(b, 'issue-run')), join(root, 'skills/engineering/issue-run'));
  // 清單裡啟用、而且有補丁的 skill 才會連到 overlay build。
  const enabled = ['matt-skills.txt', 'pstack-skills.txt'].flatMap(file => readFileSync(join(root, file), 'utf8').split('\n')).map(line => line.trim()).filter(line => line && !/^[#-]/.test(line));
  const overlay = enabled.map(rel => rel.split('/').pop()).sort().find(name => existsSync(join(root, 'overlays', `${name}.patch`)));
  assert.equal(readlinkSync(join(b, overlay)), join(xdg, 'ron-skills/overlay', overlay));
  assert.equal(existsSync(join(xdg, 'ron-skills/overlay', overlay, 'SKILL.md')), true);
});

// retro spay2 b949589b#2：land.mjs 的 sync-skills 把 /retro 換版，輸出只有 SYNC_SKILLS ok。
test('同步：overlay 內容變了才印 SKILL_CHANGED <名稱>', t => {
  const tmp = scratch(t);
  const xdg = join(tmp, 'xdg'), dest = join(tmp, 'dest');
  const extra = { XDG_DATA_HOME: xdg, SKILL_DIRS: dest };
  const changed = out => out.split('\n').filter(line => line.startsWith('SKILL_CHANGED '));
  const first = run([], extra);
  assert.equal(first.status, 0, first.stderr);
  const built = changed(first.stdout);
  assert.ok(built.length > 0, '第一次建立視為變更');
  const again = run([], extra);
  assert.deepEqual(changed(again.stdout), []);
  const name = built[0].split(' ')[1];
  writeFileSync(join(xdg, 'ron-skills/overlay', name, 'SKILL.md'), 'stale\n');
  assert.deepEqual(changed(run([], extra).stdout), [`SKILL_CHANGED ${name}`]);
});

// retro spay2 b949589b#3：`bin/check >/dev/null` 吞掉 stdout 的 CHECK_FAIL，commit 只有 exit 1、沒有任何訊息。
test('pre-commit：bin/check 失敗時把 stdout 的 CHECK_FAIL 印到 stderr；成功時安靜', t => {
  const repo = join(scratch(t), 'repo');
  mkdirSync(join(repo, 'bin'), { recursive: true });
  spawnSync('git', ['init', '-q', repo], { env });
  const hook = join(root, '.githooks/pre-commit');
  const fake = script => writeFileSync(join(repo, 'bin/check'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  fake('echo noise; echo CHECK_FAIL step; exit 1');
  const failed = spawnSync('bash', [hook], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /CHECK_FAIL step/);
  fake('echo noise');
  const passed = spawnSync('bash', [hook], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout + passed.stderr, '');
});

// #300：3c9db54 只改正本、630edfb 才改副本，pre-commit 該擋卻進了分支；hook 要每個 clone 手動 ln，Mac 那份 clone 有沒有做過看不出來。
test('同步時連結 git 的 pre-commit hook；已有的不覆蓋；--check 不動', t => {
  const dir = scratch(t);
  const hooks = join(dir, 'git-hooks');
  const base = { SKILL_DIRS: join(dir, 'skills'), HOOK_DIR: join(dir, 'claude-hooks'), XDG_DATA_HOME: join(dir, 'data'), GIT_HOOKS_DIR: hooks };
  mkdirSync(hooks);
  assert.equal(run(['--check'], base).status, 0);
  assert.equal(existsSync(join(hooks, 'pre-commit')), false);

  const linked = run([], base);
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stderr, new RegExp(`^GIT_HOOK_LINKED ${join(hooks, 'pre-commit')}$`, 'm'));
  assert.ok(lstatSync(join(hooks, 'pre-commit')).isSymbolicLink());
  assert.match(readFileSync(join(hooks, 'pre-commit'), 'utf8'), /bin\/check/, '連結要指到真的 hook');

  rmSync(join(hooks, 'pre-commit'));
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\n# 使用者自己的 hook\n');
  const kept = run([], base);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stderr, /^SKIP .*pre-commit/m);
  assert.match(readFileSync(join(hooks, 'pre-commit'), 'utf8'), /使用者自己的 hook/);
});
