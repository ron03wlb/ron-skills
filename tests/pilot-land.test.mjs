import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../scripts/pilot-land.mjs', import.meta.url).pathname;
const SYNC = new URL('../scripts/check-workflow-sync.mjs', import.meta.url).pathname;
const SYNC_SOURCES = Object.keys(JSON.parse(readFileSync(new URL('../scripts/workflow-doc-sync.json', import.meta.url), 'utf8')).sources);

// 假 bin/check：每次呼叫在 $FAKE_CHECK_LOG 記一行；$FAKE_CHECK_EXIT 決定 exit code（預設 0，通過時印 CHECK_PASS）；
// $FAKE_CHECK_DRIFT 是主 checkout 時，跑的途中在 pilot/integration 多接一個 commit，模擬 stage 之後整合分支前進。
const FAKE_CHECK = `#!/usr/bin/env bash
echo "check $*" >> "$FAKE_CHECK_LOG"
if [[ -n \${FAKE_CHECK_DRIFT:-} ]]; then
  tree=$(git -C "$FAKE_CHECK_DRIFT" rev-parse pilot/integration^{tree})
  sha=$(git -C "$FAKE_CHECK_DRIFT" -c user.name=t -c user.email=t@t commit-tree "$tree" -p pilot/integration -m drift)
  git -C "$FAKE_CHECK_DRIFT" update-ref refs/heads/pilot/integration "$sha"
fi
code=\${FAKE_CHECK_EXIT:-0}
[[ $code == 0 ]] && echo "CHECK_PASS tests 3+4+5"
exit "$code"
`;

const ROW = (n, slug, state, temp) => `| ${n} | issue/${n}-${slug} | ${temp}/issue-${n} | term_${n} | 2026-10-31T07:00:00+08:00 | 90m | ${state} | ${state === 'done' ? 'abc1234' : ''} |`;

/**
 * 主 checkout（main、pilot/integration）＋ stage worktree（停在 pilot/integration）＋ 成員分支。
 * `members` 是 [{ n, slug, files: { 路徑: 內容 }, state }]，每個成員從 pilot/integration 開分支、寫入 files 後 commit。
 * `base` 是 main 上的額外檔案；`checkpoint` 可以傳函式改寫預設的 batch checkpoint 文字。
 */
function fixture(t, { members, base = {}, checkpoint = text => text, stage = true }) {
  const temp = mkdtempSync(join(realTmpdir(), 'pilot-land-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  // 被測腳本自己的 merge commit 也要有身分；GIT_CONFIG_GLOBAL 是 /dev/null，所以寫進 fixture 的 repo 設定。
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@t');
  write(repo, { '.gitignore': '.scratch/\n', 'bin/check': FAKE_CHECK, ...base });
  chmodSync(join(repo, 'bin/check'), 0o755);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'branch', 'pilot/integration');
  for (const { n, slug, files } of members) {
    const tree = join(temp, `issue-${n}`);
    git(repo, 'worktree', 'add', '-q', '-b', `issue/${n}-${slug}`, tree, 'pilot/integration');
    write(tree, typeof files === 'function' ? files(tree) : files);
    git(tree, 'add', '.');
    git(tree, 'commit', '-qm', `issue ${n}`);
  }
  const stageTree = join(temp, 'pilot-stage');
  if (stage) git(repo, 'worktree', 'add', '-q', stageTree, 'pilot/integration');
  const key = members.map(m => m.n).join('-');
  const file = join(repo, `.scratch/pilot/batch-${key}.md`);
  write(repo, {
    [`.scratch/pilot/batch-${key}.md`]: checkpoint(`# batch ${key}\ncurrent: dispatched 2026-10-31T07:00:00+08:00\nintegration: pilot/integration @ ${git(repo, 'rev-parse', '--short', 'pilot/integration')}\n\n`
      + '| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n'
      + `${members.map(m => ROW(m.n, m.slug, m.state ?? 'done', temp)).join('\n')}\n`),
  });
  const log = join(temp, 'check.log');
  writeFileSync(log, '');
  const land = (extra = {}, args = [key]) => {
    const result = spawnSync('node', [script, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, FAKE_CHECK_LOG: log, ...extra } });
    const lines = result.stdout.trim().split('\n');
    return { ...result, lines, last: lines.at(-1) };
  };
  return {
    temp, repo, stageTree, key, file, land,
    tip: () => git(repo, 'rev-parse', 'pilot/integration'),
    checks: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
    read: () => readFileSync(file, 'utf8'),
  };
}

const TWO = [{ n: 1, slug: 'a', files: { 'a.txt': 'a\n' } }, { n: 2, slug: 'b', files: { 'b.txt': 'b\n' } }];

test('兩個成員、integration 沒變：依號碼合入、跑 Regression、快轉 integration，印 MERGED', t => {
  const f = fixture(t, { members: TWO });
  const before = f.tip();
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sha = f.tip();
  assert.equal(result.last, `MERGED ${f.key} ${sha}`);
  assert.notEqual(sha, before);
  // 依號碼順序 --no-ff：第一個 parent 鏈是 integration ← merge #1 ← merge #2。
  assert.deepEqual(git(f.repo, 'log', '--first-parent', '--format=%s', `${before}..${sha}`).split('\n'),
    ["Merge branch 'issue/2-b' into pilot/stage-1-2", "Merge branch 'issue/1-a' into pilot/stage-1-2"]);
  assert.equal(git(f.repo, 'show', `${sha}:a.txt`), 'a');
  assert.equal(git(f.repo, 'show', `${sha}:b.txt`), 'b');
  assert.equal(git(f.repo, 'branch', '--list', 'pilot/stage-1-2'), '', 'stage 分支已刪');
  assert.equal(git(f.stageTree, 'symbolic-ref', '--short', 'HEAD'), 'pilot/integration', 'stage worktree 停在 pilot/integration');
  const text = f.read();
  assert.match(text, new RegExp(`^current: merged ${sha}$`, 'm'));
  assert.match(text, new RegExp(`^regression: ${sha} exit 0 CHECK_PASS tests 3\\+4\\+5$`, 'm'));
  assert.equal(f.checks(), 1);
  assert.match(readFileSync(join(f.repo, `.scratch/pilot/reg-${f.key}.log`), 'utf8'), /CHECK_PASS tests 3\+4\+5/);
  assert.equal(readFileSync(join(f.temp, 'check.log'), 'utf8'), 'check --upstream\n', 'Regression 跑 bin/check --upstream');
});

// 重現 batch-40-51：手寫的「stage 之後 integration 有沒有新 commit」用 `$SHA^1` 數 parent，兩個成員的 batch 判斷錯。
// 這裡在 Regression 途中讓 integration 前進，腳本要比對 stage 時記下的 tip，不能把沒驗過的組合合進去。
test('stage 之後 integration 多一個 commit：STOP drift，integration 沒有前進；下一輪重新 stage 後 MERGED', t => {
  const f = fixture(t, { members: TWO });
  const result = f.land({ FAKE_CHECK_DRIFT: f.repo });
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(result.last, 'STOP drift');
  const drifted = f.tip();
  assert.equal(git(f.repo, 'log', '-1', '--format=%s', drifted), 'drift', 'integration 停在別人推進的 commit，沒有快轉到 stage');
  assert.match(f.read(), /^current: staged [0-9a-f]{40} onto [0-9a-f]{40}$/m);

  const again = f.land();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.last, `MERGED ${f.key} ${f.tip()}`);
  git(f.repo, 'merge-base', '--is-ancestor', drifted, f.tip());
  assert.equal(f.checks(), 2, '重新 stage 後重跑 Regression');
});

test('hold 存在：STOP hold、integration 不動；移除 hold 後重跑沿用同一個 staged SHA 的 Regression', t => {
  const f = fixture(t, { members: TWO });
  const before = f.tip();
  write(f.repo, { '.scratch/pilot/hold': '{"since":"2026-10-31T07:00:00+08:00","reason":"等人","session":"s"}\n' });
  const held = f.land();
  assert.equal(held.status, 4, held.stdout + held.stderr);
  assert.equal(held.last, 'STOP hold');
  assert.equal(f.tip(), before);
  const staged = f.read().match(/^current: staged ([0-9a-f]{40}) /m)?.[1];
  assert.ok(staged, f.read());

  rmSync(join(f.repo, '.scratch/pilot/hold'));
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.last, `MERGED ${f.key} ${staged}`);
  assert.equal(f.checks(), 1, '同一個 staged SHA 已經通過，不重跑');
});

// review：RESUME 只看 SHA 沒看成員，hold 期間移出的成員或成員分支的新 commit 會被當成已驗過。
test('hold 期間成員組合變了（移出一個成員、另一個成員分支多了 commit）：重跑重新 stage，不沿用舊的 staged SHA', t => {
  const f = fixture(t, { members: [...TWO, { n: 3, slug: 'c', files: { 'c.txt': 'c\n' } }] });
  write(f.repo, { '.scratch/pilot/hold': '' });
  assert.equal(f.land().last, 'STOP hold');
  writeFileSync(f.file, f.read().replace(/(\| 2 \|.*)\| done \|/, '$1| moved batch-2 |'));
  write(join(f.temp, 'issue-3'), { 'c.txt': 'c2\n' });
  git(join(f.temp, 'issue-3'), 'commit', '-qam', 'issue 3 fix');
  rmSync(join(f.repo, '.scratch/pilot/hold'));
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.lines.some(line => line.startsWith('RESUME')), result.stdout);
  assert.equal(git(f.repo, 'ls-tree', '--name-only', f.tip()).split('\n').includes('b.txt'), false, '移出的 #2 沒合進去');
  assert.equal(git(f.repo, 'show', `${f.tip()}:c.txt`), 'c2');
  assert.equal(f.checks(), 2);
});

test('Regression 失敗：STOP regression <exit>，記下 regression 行，integration 不動', t => {
  const f = fixture(t, { members: TWO });
  const before = f.tip();
  const result = f.land({ FAKE_CHECK_EXIT: '3' });
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(result.last, 'STOP regression 3');
  assert.equal(f.tip(), before);
  assert.match(f.read(), /^regression: [0-9a-f]{40} exit 3$/m);
  // 下一輪同一個 staged SHA 不算通過：重新 stage 並重跑。
  assert.equal(f.land().last, `MERGED ${f.key} ${f.tip()}`);
  assert.equal(f.checks(), 2);
});

test('其他衝突：merge --abort、STOP conflict <n>，stage worktree 乾淨，integration 不動，沒跑 Regression', t => {
  const f = fixture(t, {
    base: { 'x.txt': 'one\n' },
    members: [{ n: 1, slug: 'a', files: { 'x.txt': 'from a\n' } }, { n: 2, slug: 'b', files: { 'x.txt': 'from b\n' } }],
  });
  const before = f.tip();
  const result = f.land();
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(result.last, 'STOP conflict 2 x.txt');
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(f.repo, '.git/worktrees/pilot-stage/MERGE_HEAD')), 'merge 已 abort');
  assert.equal(f.tip(), before);
  assert.equal(f.checks(), 0);
});

const ENTRIES = '# Pilot\n\n- **Close.** close v1\n- **Handoff.** handoff v1\n\n- **Tail.** tail\n';

test('允許的衝突解法：衝突 hunk 兩邊改的是不同的 `- **<名稱>.**` 條目，各取各的版本後 MERGED', t => {
  const f = fixture(t, {
    base: { 'pilot.md': ENTRIES },
    members: [
      { n: 1, slug: 'a', files: { 'pilot.md': ENTRIES.replace('close v1', 'close v2') } },
      { n: 2, slug: 'b', files: { 'pilot.md': ENTRIES.replace('handoff v1', 'handoff v2') } },
    ],
  });
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.lines.includes('RESOLVED 2 entries pilot.md'), result.stdout);
  assert.equal(git(f.repo, 'show', `${f.tip()}:pilot.md`) + '\n', ENTRIES.replace('close v1', 'close v2').replace('handoff v1', 'handoff v2'));
  assert.equal(f.checks(), 1, '解完在新的 staged SHA 跑 Regression');
});

test('允許的衝突解法：兩邊都只在同一處新增不重疊的段落，依號碼順序兩段都留下', t => {
  const f = fixture(t, {
    base: { 'notes.md': '# Notes\n' },
    members: [
      { n: 1, slug: 'a', files: { 'notes.md': '# Notes\n\nfrom a\n' } },
      { n: 2, slug: 'b', files: { 'notes.md': '# Notes\n\nfrom b\n' } },
    ],
  });
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.lines.includes('RESOLVED 2 additions notes.md'), result.stdout);
  assert.equal(git(f.repo, 'show', `${f.tip()}:notes.md`), '# Notes\n\nfrom a\n\nfrom b');
});

// 只新增的段落要不重疊：兩邊各自新增同一個檔（沒有 base），或在同一處新增同名條目，接起來會是兩份檔案或重複的條目。
test('兩邊都新增同一個檔：不是只新增段落，STOP conflict', t => {
  const f = fixture(t, {
    members: [{ n: 1, slug: 'a', files: { 'new.md': 'from a\n' } }, { n: 2, slug: 'b', files: { 'new.md': 'from b\n' } }],
  });
  const result = f.land();
  assert.equal(result.last, 'STOP conflict 2 new.md');
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
});

// review：diff3 不剝掉兩邊共有的行，兩邊都新增 `## Notes` 時接起來標題會重複。
test('兩邊新增的段落有相同的行：重疊，STOP conflict', t => {
  const f = fixture(t, {
    base: { 'n.md': '# N\n' },
    members: [
      { n: 1, slug: 'a', files: { 'n.md': '# N\n\n## Notes\nfrom a\n' } },
      { n: 2, slug: 'b', files: { 'n.md': '# N\n\n## Notes\nfrom b\n' } },
    ],
  });
  assert.equal(f.land().last, 'STOP conflict 2 n.md');
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
});

// verifier：內容本身有一行 `=======`（setext 標題底線）時，被當成衝突分隔線，解出來的檔案少了兩條底線。
test('段落裡有 `=======` 行：照樣解且不掉行', t => {
  const f = fixture(t, {
    base: { 'n.md': '# N\n' },
    members: [
      { n: 1, slug: 'a', files: { 'n.md': '# N\n\nTitle A\n=======\nbody a\n' } },
      { n: 2, slug: 'b', files: { 'n.md': '# N\n\nTitle B\n-------\nbody b\n' } },
    ],
  });
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(f.repo, 'show', `${f.tip()}:n.md`), '# N\n\nTitle A\n=======\nbody a\n\nTitle B\n-------\nbody b');
});

// verifier：blob 以 utf8 讀寫時，非 UTF-8 的位元組（latin1 的 é）變成 U+FFFD，兩邊都沒改的行也被改壞，照樣 MERGED。
test('非 UTF-8 的檔案衝突：不自己解，STOP conflict，integration 不動', t => {
  const latin1 = text => Buffer.from(text, 'latin1');
  const f = fixture(t, {
    base: { 'n.txt': latin1('café\n') },
    members: [
      { n: 1, slug: 'a', files: { 'n.txt': latin1('café\n\nfrom a\n') } },
      { n: 2, slug: 'b', files: { 'n.txt': latin1('café\n\nfrom b\n') } },
    ],
  });
  const before = f.tip();
  assert.equal(f.land().last, 'STOP conflict 2 n.txt');
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
  assert.equal(f.tip(), before);
});

// 用 TextDecoder 檢查 UTF-8 時，預設會剝掉開頭的 BOM；解出來的檔案要保留它。
test('開頭有 BOM 的 UTF-8 檔案：照樣解，BOM 保留', t => {
  const f = fixture(t, {
    base: { 'n.md': '\uFEFF# N\n' },
    members: [
      { n: 1, slug: 'a', files: { 'n.md': '\uFEFF# N\n\nfrom a\n' } },
      { n: 2, slug: 'b', files: { 'n.md': '\uFEFF# N\n\nfrom b\n' } },
    ],
  });
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // git() 的 trim 會連 BOM 一起剝掉，所以讀 stage worktree（停在 pilot/integration）的檔案。
  assert.equal(readFileSync(join(f.stageTree, 'n.md'), 'utf8'), '\uFEFF# N\n\nfrom a\n\nfrom b\n');
});

// review：解完衝突的 commit 失敗（例如啟用了會擋的 pre-commit hook）時，stage worktree 不能停在 merge 中途。
test('解完衝突後 commit 失敗：merge --abort，stage worktree 乾淨', t => {
  const f = fixture(t, {
    base: { 'notes.md': '# Notes\n' },
    members: [
      { n: 1, slug: 'a', files: { 'notes.md': '# Notes\n\nfrom a\n' } },
      { n: 2, slug: 'b', files: { 'notes.md': '# Notes\n\nfrom b\n' } },
    ],
  });
  write(f.repo, { '.git/hooks/pre-commit': '#!/bin/sh\nexit 1\n' });
  chmodSync(join(f.repo, '.git/hooks/pre-commit'), 0o755);
  // git merge 跑的是 pre-merge-commit，只有解完衝突後的 git commit 會跑 pre-commit。
  const result = f.land();
  assert.match(result.last, /^STOP git commit /);
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(f.repo, '.git/worktrees/pilot-stage/MERGE_HEAD')), 'merge 已 abort');
});

test('兩邊在同一處新增同名的 `- **<名稱>.**` 條目：重疊，STOP conflict', t => {
  const f = fixture(t, {
    base: { 'pilot.md': '# Pilot\n' },
    members: [
      { n: 1, slug: 'a', files: { 'pilot.md': '# Pilot\n\n- **New.** from a\n' } },
      { n: 2, slug: 'b', files: { 'pilot.md': '# Pilot\n\n- **New.** from b\n' } },
    ],
  });
  assert.equal(f.land().last, 'STOP conflict 2 pilot.md');
});

test('同一個條目兩邊都改：不是允許的解法，STOP conflict', t => {
  const f = fixture(t, {
    base: { 'pilot.md': ENTRIES },
    members: [
      { n: 1, slug: 'a', files: { 'pilot.md': ENTRIES.replace('close v1', 'close A') } },
      { n: 2, slug: 'b', files: { 'pilot.md': ENTRIES.replace('close v1', 'close B') } },
    ],
  });
  const result = f.land();
  assert.equal(result.last, 'STOP conflict 2 pilot.md');
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
});

// #162：PILOT-STORE.md canonical scripts 表格的真實衝突（base a15d600、#123 996b0f8、整合分支 60fb3fb、#94 9a36665），只取 `## Canonical scripts` 這段。
const STORE = 'skills/engineering/issue-pilot/PILOT-STORE.md';
const STORE_AT = name => readFileSync(new URL(`fixtures/pilot-land-rows/${name}.md`, import.meta.url), 'utf8');

/** 成員 n 從 base 的 STORE 開分支改成 member，之後 pilot/integration 改成 integration（成員之前合入的那一邊）。 */
function storeFixture(t, n, integration) {
  const f = fixture(t, { base: { [STORE]: STORE_AT('base') }, members: [{ n, slug: 'store', files: { [STORE]: STORE_AT(`member-${n}`) } }] });
  write(f.stageTree, { [STORE]: STORE_AT(integration) });
  git(f.stageTree, 'commit', '-qam', integration);
  return f;
}

const row = (text, script) => text.split('\n').find(line => line.startsWith(`| \`${script}\` |`));

test('衝突 hunk 都是表格列、兩邊改不同列（#123 改 pilot-probe、#124 改 pilot-dispatch）：各取各的版本，RESOLVED rows', t => {
  const f = storeFixture(t, 123, 'integration-124');
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.lines.includes(`RESOLVED 123 rows ${STORE}`), result.stdout);
  const merged = git(f.repo, 'show', `${f.tip()}:${STORE}`) + '\n';
  assert.equal(row(merged, 'pilot-probe.mjs'), row(STORE_AT('member-123'), 'pilot-probe.mjs'));
  assert.equal(row(merged, 'pilot-dispatch.mjs'), row(STORE_AT('integration-124'), 'pilot-dispatch.mjs'));
  assert.notEqual(row(merged, 'pilot-probe.mjs'), row(STORE_AT('base'), 'pilot-probe.mjs'));
  assert.notEqual(row(merged, 'pilot-dispatch.mjs'), row(STORE_AT('base'), 'pilot-dispatch.mjs'));
  assert.equal(merged, STORE_AT('integration-124').replace(row(STORE_AT('base'), 'pilot-probe.mjs'), row(STORE_AT('member-123'), 'pilot-probe.mjs')));
  assert.equal(f.checks(), 1, '解完在新的 staged SHA 跑 Regression');
});

test('表格的同一列兩邊都改（#123 與 #94 都改 pilot-probe）：STOP conflict，stage worktree 乾淨', t => {
  const f = storeFixture(t, 94, 'member-123');
  const tip = f.tip();
  const result = f.land();
  assert.equal(result.last, `STOP conflict 94 ${STORE}`);
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
  assert.equal(f.tip(), tip);
  assert.equal(f.checks(), 0);
});

const TABLE = '| Script | Note |\n| --- | --- |\n| `a.mjs` | a v1 |\n| `b.mjs` | b v1 |\n| `c.mjs` | c v1 |\n';

test('表格兩邊各改一列、各新增一列：改過的列各取各的版本，新增的列接在它前一列之後都留下', t => {
  const f = fixture(t, {
    base: { 'table.md': TABLE },
    members: [
      { n: 1, slug: 'a', files: { 'table.md': TABLE.replace('a v1', 'a v2').replace('| `b.mjs` | b v1 |\n', '| `b.mjs` | b v1 |\n| `b2.mjs` | from 1 |\n') } },
      { n: 2, slug: 'b', files: { 'table.md': TABLE.replace('b v1', 'b v2').replace('| `a.mjs` | a v1 |\n', '| `a.mjs` | a v1 |\n| `a2.mjs` | from 2 |\n') } },
    ],
  });
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.lines.includes('RESOLVED 2 rows table.md'), result.stdout);
  assert.equal(git(f.repo, 'show', `${f.tip()}:table.md`) + '\n',
    '| Script | Note |\n| --- | --- |\n| `a.mjs` | a v2 |\n| `a2.mjs` | from 2 |\n| `b.mjs` | b v2 |\n| `b2.mjs` | from 1 |\n| `c.mjs` | c v1 |\n');
});

test('表格兩邊新增同一個第一格的列：STOP conflict', t => {
  const f = fixture(t, {
    base: { 'table.md': TABLE },
    members: [
      { n: 1, slug: 'a', files: { 'table.md': TABLE.replace('a v1', 'a v2').replace('| `c.mjs`', '| `d.mjs` | from 1 |\n| `c.mjs`') } },
      { n: 2, slug: 'b', files: { 'table.md': TABLE.replace('b v1', 'b v2').replace('| `c.mjs`', '| `d.mjs` | from 2 |\n| `c.mjs`') } },
    ],
  });
  assert.equal(f.land().last, 'STOP conflict 2 table.md');
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
});

// review：一邊加欄、另一邊加列，逐列合併會留下欄數不對的列。
test('表格一邊改了欄數：不逐列合併，STOP conflict', t => {
  const f = fixture(t, {
    base: { 'table.md': TABLE },
    members: [
      { n: 1, slug: 'a', files: { 'table.md': TABLE.replace('| Note |\n| --- | --- |', '| Note | More |\n| --- | --- | --- |').replace('a v1 |', 'a v1 | x |').replace('b v1 |', 'b v1 | y |') } },
      { n: 2, slug: 'b', files: { 'table.md': TABLE.replace('| `b.mjs` | b v1 |\n', '| `b.mjs` | b v1 |\n| `b2.mjs` | from 2 |\n') } },
    ],
  });
  assert.equal(f.land().last, 'STOP conflict 2 table.md');
});

/** 兩個成員各改一個 check-workflow-sync 追蹤的來源並各自 restamp：戳記檔裡相鄰兩行各變一行，git 判成同一個 hunk 衝突（#72）。 */
function syncMembers(extra = {}) {
  const restamp = tree => {
    const result = spawnSync('node', [join(tree, 'scripts/check-workflow-sync.mjs'), '--restamp'], { cwd: tree, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const member = (n, slug, source, files = {}) => ({
    n, slug, files: tree => {
      write(tree, { [source]: `# ${slug}\n`, ...files });
      restamp(tree);
      return {};
    },
  });
  return [member(1, 'a', SYNC_SOURCES[0], extra.a), member(2, 'b', SYNC_SOURCES[1], extra.b)];
}

test('只有 scripts/workflow-doc-sync.json 衝突：restamp 完成 merge，check-workflow-sync 在結果上通過', t => {
  const f = syncFixture(t, syncMembers());
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.lines.includes('RESOLVED 2 restamp scripts/workflow-doc-sync.json'), result.stdout);
  const check = spawnSync('node', [join(f.stageTree, 'scripts/check-workflow-sync.mjs')], { cwd: f.stageTree, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(git(f.repo, 'show', `${f.tip()}:${SYNC_SOURCES[0]}`), '# a');
  assert.equal(git(f.repo, 'show', `${f.tip()}:${SYNC_SOURCES[1]}`), '# b');
});

test('workflow-doc-sync.json 和解不了的檔一起衝突：STOP conflict，不 restamp', t => {
  const f = syncFixture(t, syncMembers({ a: { 'x.txt': 'a\n' }, b: { 'x.txt': 'b\n' } }));
  const result = f.land();
  assert.equal(result.last, 'STOP conflict 2 scripts/workflow-doc-sync.json x.txt');
  assert.equal(git(f.stageTree, 'status', '--porcelain'), '');
});

test('workflow-doc-sync.json 和表格列衝突一起：rows 解完再 restamp，印 rows+restamp', t => {
  const f = syncFixture(t, syncMembers({
    a: { 'table.md': TABLE.replace('a v1', 'a v2') },
    b: { 'table.md': TABLE.replace('b v1', 'b v2') },
  }), { 'table.md': TABLE });
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.lines.includes('RESOLVED 2 rows+restamp scripts/workflow-doc-sync.json table.md'), result.stdout);
  assert.equal(git(f.repo, 'show', `${f.tip()}:table.md`) + '\n', TABLE.replace('a v1', 'a v2').replace('b v1', 'b v2'));
  const check = spawnSync('node', [join(f.stageTree, 'scripts/check-workflow-sync.mjs')], { cwd: f.stageTree, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

// batch-56（retro ron-skills-ac）：戳記檔和 pilot.md 的 entries 衝突同時出現，coordinator 手解後 Regression 通過，照舊規則卻要開 gate。
test('workflow-doc-sync.json 和可自己解的檔一起衝突：先解那些檔再 restamp，check-workflow-sync 在結果上通過', t => {
  const f = syncFixture(t, syncMembers({
    a: { 'pilot.md': ENTRIES.replace('close v1', 'close v2') },
    b: { 'pilot.md': ENTRIES.replace('handoff v1', 'handoff v2') },
  }), { 'pilot.md': ENTRIES });
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.lines.includes('RESOLVED 2 entries+restamp pilot.md scripts/workflow-doc-sync.json'), result.stdout);
  assert.equal(git(f.repo, 'show', `${f.tip()}:pilot.md`) + '\n', ENTRIES.replace('close v1', 'close v2').replace('handoff v1', 'handoff v2'));
  const check = spawnSync('node', [join(f.stageTree, 'scripts/check-workflow-sync.mjs')], { cwd: f.stageTree, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(f.checks(), 1, '解完在新的 staged SHA 跑 Regression');
});

/** 戳記檔與 check-workflow-sync.mjs 都在 base：從 repo 複製腳本，對 base 的來源先 restamp 一次。 */
function syncFixture(t, members, extraBase = {}) {
  return fixture(t, {
    members,
    base: {
      ...extraBase,
      ...Object.fromEntries(SYNC_SOURCES.map(path => [path, `# ${path}\n`])),
      'scripts/check-workflow-sync.mjs': readFileSync(SYNC, 'utf8'),
      'scripts/workflow-doc-sync.json': stampsFor(Object.fromEntries(SYNC_SOURCES.map(path => [path, `# ${path}\n`]))),
    },
  });
}

/** 依來源內容算出 restamp 會寫的戳記檔：在暫存目錄跑一次真的 --restamp。 */
function stampsFor(files) {
  const dir = mkdtempSync(join(realTmpdir(), 'pilot-land-stamps-'));
  try {
    write(dir, files);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    cpSync(SYNC, join(dir, 'scripts/check-workflow-sync.mjs'));
    const result = spawnSync('node', [join(dir, 'scripts/check-workflow-sync.mjs'), '--restamp'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(join(dir, 'scripts/workflow-doc-sync.json'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// #74：coordinator 用 sed 改表格，表格多一個空格正規式就靜默不中；腳本讀寫都要容得下多餘的空格，寫不進去要 STOP。
test('表格欄位與 current: 行多空格的 checkpoint：照樣找到 done 成員並寫回 current:', t => {
  const f = fixture(t, {
    members: TWO,
    checkpoint: text => text.replace('current: dispatched', 'current:   dispatched')
      .replace(/^\| (\d) \| (\S+) \|(.*)\| done \|/gm, '|   $1   |  $2  |$3|   done   |'),
  });
  assert.match(f.read(), /\|   1   \|  issue\/1-a  \|/);
  const result = f.land();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(f.read(), new RegExp(`^current: merged ${f.tip()}$`, 'm'));
  assert.doesNotMatch(f.read(), /dispatched/);
});

test('checkpoint 沒有 current: 行：STOP checkpoint，不 stage', t => {
  const f = fixture(t, { members: TWO, checkpoint: text => text.replace(/^current: .*\n/m, '') });
  const before = f.tip();
  const result = f.land();
  assert.equal(result.status, 4);
  assert.match(result.last, /^STOP checkpoint .*current:/);
  assert.equal(git(f.repo, 'branch', '--list', 'pilot/stage-1-2'), '');
  assert.equal(f.tip(), before);
});

test('還有 running 或 stop 成員：STOP member，不 stage', t => {
  const running = fixture(t, { members: [TWO[0], { ...TWO[1], state: 'running' }] });
  assert.equal(running.land().last, 'STOP member 2 running');
  const stopped = fixture(t, { members: [TWO[0], { ...TWO[1], state: 'stop' }] });
  assert.equal(stopped.land().last, 'STOP member 2 stop');
  assert.equal(stopped.checks(), 0);
});

test('stage worktree 不乾淨：STOP dirty，不動它', t => {
  const f = fixture(t, { members: TWO });
  writeFileSync(join(f.stageTree, 'junk.txt'), 'x\n');
  const result = f.land();
  assert.equal(result.last, `STOP dirty ${f.stageTree}`);
  assert.equal(git(f.stageTree, 'symbolic-ref', '--short', 'HEAD'), 'pilot/integration');
});

test('沒有 stage worktree 也沒有 ORCA_CLI_COMMAND：STOP no-stage-worktree', t => {
  const f = fixture(t, { members: TWO, stage: false });
  const result = f.land({ ORCA_CLI_COMMAND: '' });
  assert.equal(result.status, 4);
  assert.equal(result.last, 'STOP no-stage-worktree');
});

// Issue 的禁止：不在主 checkout 切分支（#21）。主 checkout 剛好停在 pilot/integration 也不能把它當成 stage worktree。
test('主 checkout 停在 pilot/integration、沒有 stage worktree：不在主 checkout stage，STOP no-stage-worktree', t => {
  const f = fixture(t, { members: TWO, stage: false });
  git(f.repo, 'switch', '-q', 'pilot/integration');
  const result = f.land({ ORCA_CLI_COMMAND: '' });
  assert.equal(result.last, 'STOP no-stage-worktree');
  assert.equal(git(f.repo, 'symbolic-ref', '--short', 'HEAD'), 'pilot/integration');
});

test('沒有 stage worktree：用 Orca 建 pilot-stage 後照常 MERGED', t => {
  const f = fixture(t, { members: TWO, stage: false });
  const cli = join(f.temp, 'orca');
  writeFileSync(cli, `#!/usr/bin/env node
const { execFileSync } = require('child_process'); const fs = require('fs');
const args = process.argv.slice(2); const arg = k => args[args.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(join(f.temp, 'orca.log'))}, args.join(' ') + '\\n');
const path = ${JSON.stringify(f.temp)} + '/' + arg('--name');
execFileSync('git', ['worktree', 'add', '-q', '-b', arg('--branch'), path, arg('--base-branch')], { stdio: 'ignore' });
console.log(JSON.stringify({ ok: true, result: { worktree: { path } } }));
`);
  chmodSync(cli, 0o755);
  const result = f.land({ ORCA_CLI_COMMAND: cli, ORCA_POLL_SECONDS: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.last, `MERGED ${f.key} ${f.tip()}`);
  assert.match(readFileSync(join(f.temp, 'orca.log'), 'utf8'), /^worktree create --name pilot-stage --base-branch pilot\/integration --branch pilot\/stage-1-2/m);
  assert.equal(git(join(f.temp, 'pilot-stage'), 'symbolic-ref', '--short', 'HEAD'), 'pilot/integration');
});

test('已經 merged：重跑不再 stage，照樣印 MERGED', t => {
  const f = fixture(t, { members: TWO });
  const first = f.land();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const again = f.land();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.last, first.last);
  assert.equal(f.checks(), 1);
});

test('用法錯誤：exit 2', () => {
  const result = spawnSync('node', [script], { encoding: 'utf8', env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /用法/);
});

// #143：沒有 Issue 的請求分支（retro/*）以 batch 落地，Stage、Regression、hold、Integrate 與一般 batch 相同。
test('請求分支：--branch retro/<x> 開 batch-req-<n>.md（成員列 Issue 欄 -），走到 MERGED 並留下 regression 行', t => {
  const f = fixture(t, { members: [] });
  const tree = join(f.temp, 'retro-hook');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'retro/hook-c-var', tree, 'pilot/integration');
  write(tree, { 'hook.txt': 'hook\n' });
  git(tree, 'add', '.');
  git(tree, 'commit', '-qm', 'request 10');
  const candidate = git(tree, 'rev-parse', 'HEAD');
  const before = f.tip();
  const result = f.land({}, ['req-10', '--branch', 'retro/hook-c-var']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sha = f.tip();
  assert.equal(result.last, `MERGED req-10 ${sha}`);
  assert.deepEqual(git(f.repo, 'log', '--first-parent', '--format=%s', `${before}..${sha}`).split('\n'), ["Merge branch 'retro/hook-c-var' into pilot/stage-req-10"]);
  const text = readFileSync(join(f.repo, '.scratch/pilot/batch-req-10.md'), 'utf8');
  assert.match(text, /^# batch req-10$/m);
  assert.match(text, new RegExp(`^integration: pilot/integration @ ${before}$`, 'm'));
  assert.match(text, new RegExp(`^\\| - \\| retro/hook-c-var \\| ${tree} \\| +\\| [^|]+ \\| +\\| done \\| ${candidate} \\|$`, 'm'));
  assert.match(text, new RegExp(`^current: merged ${sha}$`, 'm'));
  assert.match(text, new RegExp(`^regression: ${sha} exit 0 CHECK_PASS tests 3\\+4\\+5$`, 'm'));
  assert.equal(f.checks(), 1);

  // 重跑（帶不帶 --branch 都一樣）只再印一次 MERGED。
  assert.equal(f.land({}, ['req-10', '--branch', 'retro/hook-c-var']).last, result.last);
  assert.equal(f.land({}, ['req-10']).last, result.last);
  assert.equal(f.checks(), 1);
});

test('請求分支：key 不是 req-<n>、分支不是 retro/<x>，或既有 checkpoint 的分支不同：不動任何東西', t => {
  const f = fixture(t, { members: [] });
  git(f.repo, 'branch', 'retro/a', 'pilot/integration');
  assert.equal(f.land({}, ['10', '--branch', 'retro/a']).status, 2);
  assert.equal(f.land({}, ['req-10', '--branch', 'issue/10-a']).status, 2);
  assert.equal(f.land({}, ['req-10', '--branch']).status, 2);
  const missing = f.land({}, ['req-11', '--branch', 'retro/missing']);
  assert.equal(missing.status, 4, missing.stdout + missing.stderr);
  assert.match(missing.last, /^STOP branch retro\/missing/);
  assert.equal(existsSync(join(f.repo, '.scratch/pilot/batch-req-11.md')), false);
  write(f.repo, { '.scratch/pilot/batch-req-10.md': '# batch req-10\ncurrent: dispatched 2026-10-31T07:00:00+08:00\n\n| Issue | branch | worktree | handle | started | stuck-after | state | candidate |\n|---|---|---|---|---|---|---|---|\n| - | retro/b | | | 2026-10-31T07:00:00+08:00 | | done | abc1234 |\n' });
  const other = f.land({}, ['req-10', '--branch', 'retro/a']);
  assert.equal(other.status, 4, other.stdout + other.stderr);
  assert.match(other.last, /^STOP checkpoint .*retro\/b/);
  assert.equal(f.checks(), 0);
});
