// scripts/ 裡從 setup-workflow 正本複製來的副本（清單在 docs/agents/workflow-templates.json）必須與正本逐位元組相同、
// 與清單記錄的 sha256 一致：要改就改正本，git add 正本後用 setup-workflow 的 copy-templates.mjs --staged 複製過來，副本與正本同一個 commit。
// 不能先 commit 正本再複製：pre-commit 跑本測試，副本還舊就擋下 commit（retro spay2 1bb1d94c#3）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { join } from 'node:path';
import { pilotFiles } from '../scripts/pilot-probe.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const { copies } = JSON.parse(read('docs/agents/workflow-templates.json'));
const RECOPY = 'node skills/engineering/setup-workflow/scripts/copy-templates.mjs . --no-tests --yes --staged <名稱>';

for (const [path, entry] of Object.entries(copies)) {
  test(`${path} 與 setup-workflow 正本相同，hash 與清單一致`, () => {
    assert.ok(read(path).equals(read(entry.template)),
      `${path} 與正本不同：改 ${entry.template}，git add 它之後執行 ${RECOPY}，再 git add 副本與清單一起 commit`);
    assert.equal(createHash('sha256').update(read(path)).digest('hex'), entry.sha256,
      `${path} 與清單記錄的 sha256 不同：不手動 cp、不手算 sha256，git add 正本後執行 ${RECOPY}，它複製副本並更新清單（#250）`);
    assert.match(entry.commit, /^[0-9a-f]{40}$/);
    // #526：scripts/check-node-version.mjs 手建時是 755、正本 644，內容一樣沒人發現，重拷才在 diff 冒出 mode change。
    const executable = file => Boolean(statSync(new URL(`../${file}`, import.meta.url)).mode & 0o100);
    assert.equal(executable(path), executable(entry.template),
      `${path} 與正本的執行權限不同：副本該可執行就 chmod 正本、git add 後執行 ${RECOPY}；否則直接執行 ${RECOPY}，它把副本權限改成正本的（印 MODE）`);
  });
}

// #674：--staged 記的是當下 HEAD；在 wip commit 上複製、之後把 wip 壓成單一 commit，stamp 就不是 HEAD 的祖先（#592 的 5264f3b），
// 內容與 sha256 都對，只有最終 verifier 發現。淺 clone（CI 的 actions/checkout 預設 fetch-depth 1）沒有歷史可比，整項跳過；
// 完整 clone 裡 commit 不存在（壓掉後被 gc）也算失敗。
function staleStamps(entries, cwd) {
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (git('rev-parse', '--is-shallow-repository').stdout.trim() !== 'false') return null;
  const result = new Map();
  return entries.filter(([, { commit }]) => {
    if (!result.has(commit)) result.set(commit, git('merge-base', '--is-ancestor', commit, 'HEAD').status);
    return result.get(commit) !== 0;
  }).map(([path, { commit }]) => `${path} ${commit}`);
}
const STALE_FIX = '清單的 commit 不是 HEAD 的祖先（多半是 --staged 在 wip commit 上記下 HEAD，之後 wip 被 squash 或 rebase）：'
  + '對每個列出的副本，在 squash 後的分支 git add 正本後重跑 ' + RECOPY + '（stamp 改記現在的 HEAD），或把清單那筆 commit 改成 squash 後的 base 再一起 commit（#674）';

test('清單每個副本的 commit 都是 HEAD 的祖先', t => {
  const stale = staleStamps(Object.entries(copies), new URL('..', import.meta.url));
  if (stale === null) return t.skip('淺 clone，沒有歷史可比（CI 的 actions/checkout 預設 fetch-depth 1）');
  assert.deepEqual(stale, [], STALE_FIX);
});

test('fixture：wip commit 記下的 stamp 在 squash 後被抓出，祖先 stamp 通過，淺 clone 跳過', () => {
  const dir = mkdtempSync(join(realTmpdir(), 'template-stamp-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git('init', '-q');
    writeFileSync(join(dir, 'a'), 'base\n'); git('add', 'a'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'a'), 'wip\n'); git('commit', '-qam', 'wip');
    const wip = git('rev-parse', 'HEAD'); // copy-templates --staged 此時記下的 stamp
    writeFileSync(join(dir, 'a'), 'done\n'); git('commit', '-qam', 'wip 2');
    assert.deepEqual(staleStamps([['scripts/x.mjs', { commit: wip }]], dir), [], '壓之前 stamp 是祖先');
    git('reset', '-q', '--soft', base); git('commit', '-qm', 'squashed');
    assert.deepEqual(staleStamps([['scripts/x.mjs', { commit: wip }], ['scripts/y.mjs', { commit: base }]], dir), [`scripts/x.mjs ${wip}`]);
    assert.deepEqual(staleStamps([['scripts/z.mjs', { commit: 'f'.repeat(40) }]], dir), [`scripts/z.mjs ${'f'.repeat(40)}`], '不存在的 commit 也算');
    const shallow = join(dir, 'shallow');
    git('clone', '-q', '--depth', '1', `file://${dir}`, shallow);
    assert.equal(staleStamps([['scripts/x.mjs', { commit: base }]], shallow), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// L3 必接：主 checkout 的未提交改動與新檔會讓 pilot 的 Probe 停止合併（#30）；Bash 的 sed -i、重導向也會寫檔（#47）。
test('.claude/settings.json 以 PreToolUse（Edit|Write|Bash）接上主 checkout 防護', () => {
  assert.ok(copies['scripts/claude-hook-main-checkout.mjs'], '清單沒有 scripts/claude-hook-main-checkout.mjs');
  const { hooks } = JSON.parse(read('.claude/settings.json'));
  const wired = hooks.PreToolUse.some(({ matcher, hooks: list }) => /\bEdit\b/.test(matcher) && /\bWrite\b/.test(matcher) && /\bBash\b/.test(matcher)
    && list.some(({ command }) => command.includes('scripts/claude-hook-main-checkout.mjs')));
  assert.ok(wired, '.claude/settings.json 的 PreToolUse 沒有以 Edit|Write|Bash 呼叫 scripts/claude-hook-main-checkout.mjs');
});

// pilot-handoff 是合併兩邊後的正本（#57）：本 repo 的 Handoff 跑的是副本，連同它開 session 用的 orca-session-split。
test('scripts/pilot-handoff.mjs 與它 import 的 orca-session-send、orca-session-split 都登記為副本', () => {
  for (const path of ['scripts/pilot-handoff.mjs', 'scripts/orca-session-send.mjs', 'scripts/orca-session-split.mjs']) assert.ok(copies[path], `清單沒有 ${path}`);
});

// pilot 存檔的寫入者由副本負責，adapter 的 Pilot 段不再要求手寫（#56；gates.md 的 pilot-gate，#134；batch 成員搬移的 pilot-batch，#163）。
test('清單涵蓋寫 pilot 存檔的 7 個副本與它們的共用 lib', () => {
  for (const name of ['pilot-register', 'pilot-decision', 'pilot-request', 'pilot-hold', 'pilot-sources', 'pilot-gate', 'pilot-batch', 'lib/pilot-store']) {
    assert.ok(copies[`scripts/${name}.mjs`], `清單沒有 scripts/${name}.mjs`);
  }
});

// Probe 與 Dispatch 改用正本（#58）：adapter 的呼叫方式不變；正本不寫死本 repo 的路徑與名稱，
// ADAPTER_AHEAD 要比的 pilot.md 由 adapter 的 Pilot 段連結推出。
test('pilot-probe、pilot-dispatch 登記為副本，正本與測試 grep 不到本 repo 專屬的路徑或名稱', () => {
  for (const name of ['pilot-probe', 'pilot-dispatch']) {
    assert.ok(copies[`scripts/${name}.mjs`], `清單沒有 scripts/${name}.mjs`);
    for (const file of [`${name}.mjs`, `${name}.test.mjs`]) {
      const text = read(`skills/engineering/setup-workflow/templates/${file}`).toString();
      for (const word of ['ron-skills', 'ron03wlb', 'spay2', 'docs/agents/pilot.md', '/Users/', '/home/', '/root/']) {
        assert.ok(!text.includes(word), `${file} 含有 ${word}`);
      }
    }
  }
});

test('本 repo adapter 的 Pilot 段連到 pilot.md 與拆出去的檔，Probe 會把它們都當 adapter 比對', () => {
  assert.deepEqual(pilotFiles(read('docs/agents/issue-run.md').toString()),
    ['pilot.md', 'pilot-round.md', 'pilot-after-merge.md', 'pilot-conflict.md', 'pilot-exceptions.md', 'pilot-retro-collect.md'].map(name => `docs/agents/${name}`));
});

// 分頁狀態（#126）：LANDED、HANDED_OFF 在 Bash 輸出，worker 的 DONE 與前綴檢查在 Stop。
test('.claude/settings.json 以 PostToolUse（Bash）與 Stop 接上分頁狀態 hook', () => {
  for (const path of ['scripts/tab-state.mjs', 'scripts/claude-hook-tab-state.mjs']) assert.ok(copies[path], `清單沒有 ${path}`);
  const { hooks } = JSON.parse(read('.claude/settings.json'));
  const calls = list => list.some(({ command }) => command.includes('scripts/claude-hook-tab-state.mjs'));
  assert.ok(hooks.PostToolUse.some(({ matcher, hooks: list }) => /\bBash\b|^\*$/.test(matcher) && calls(list)), 'PostToolUse 沒有對 Bash 呼叫 scripts/claude-hook-tab-state.mjs');
  assert.ok(hooks.Stop.some(({ hooks: list }) => calls(list)), 'Stop 沒有呼叫 scripts/claude-hook-tab-state.mjs');
});

// investing#529：consumer 的 worker 看檔頭就知道是範本副本，不必查清單；copy-templates.mjs --verify 對 consumer 的副本檢查同一行（NO_ORIGIN）。
test('setup-workflow 每支 .mjs／.sh 正本（fixtures/ 除外）前三行有來源行', () => {
  const root = new URL('../skills/engineering/setup-workflow/templates/', import.meta.url);
  const files = readdirSync(root, { recursive: true }).map(String)
    .filter(path => /\.(mjs|sh)$/.test(path) && !/(^|\/)fixtures\//.test(path.replaceAll('\\', '/')));
  assert.ok(files.length > 50, `只找到 ${files.length} 支正本`);
  const missing = files.filter(path => !readFileSync(new URL(path, root), 'utf8').split('\n', 3).some(line => line.includes('由 setup-workflow 範本同步，勿在此改')));
  assert.deepEqual(missing, [], '這些正本的檔頭沒有來源行：在 shebang 之後（沒有就在第一行）加 `// 由 setup-workflow 範本同步，勿在此改…`');
});
