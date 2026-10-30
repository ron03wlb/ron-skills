import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { hasSystemBash, systemBashPath } from './helpers/bash32.mjs';

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
    'model\tlocal\tother',
    'model\tproj-only\tproject',
    'user\tbeta\tpstack',
    'user\tissue-run\tron-skills',
    '',
  ].join('\n'));
});

test('同步只換掉受管連結：清掉清單外的舊連結，不碰別處的連結與實體目錄', t => {
  const tmp = scratch(t);
  const xdg = join(tmp, 'xdg'), a = join(tmp, 'a'), b = join(tmp, 'b');
  mkdirSync(a);
  symlinkSync(join(root, 'skills/engineering/removed-skill'), join(a, 'removed-skill'));
  symlinkSync(join(tmp, 'foreign'), join(a, 'foreign'));
  skill(join(a, 'issue-pilot'));
  const extra = { XDG_DATA_HOME: xdg, SKILL_DIRS: `${a} ${b}` };

  const count = run(['--check'], extra).stdout.match(/^CHECK_OK (\d+) skills$/m)?.[1];
  const result = run([], extra);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `SYNCED ${count} skills → ${a} ${b}\n`);
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
