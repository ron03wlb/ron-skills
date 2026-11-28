// bin/check --changed 的挑選（scripts/check-subset.mjs、對應表 scripts/check-subset.json，CoS item 67）。
// 拿不準一律退回完整套件；子集通過時印 CHECK_PASS_SUBSET，不記 stamp，pilot-land.mjs 不會把它當 Regression 通過。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dependencies, globRegExp, plan } from '../scripts/check-subset.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const root = new URL('..', import.meta.url).pathname;
const TABLE = JSON.parse(readFileSync(join(root, 'scripts/check-subset.json'), 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('NODE_TEST') && !['NODE_OPTIONS', 'CHECK_LOCK_PID', 'CHECK_FULL', 'CHECK_INDEX_TREE'].includes(key)));

test('globRegExp：** 跨目錄、* 不跨', () => {
  assert.ok(globRegExp('docs/workflow/**').test('docs/workflow/site/index.html'));
  assert.ok(globRegExp('skills/**/*.md').test('skills/a/b/SKILL.md'));
  assert.ok(globRegExp('skills/**/*.md').test('skills/SKILL.md'));
  assert.ok(globRegExp('*.md').test('README.md'));
  assert.ok(!globRegExp('*.md').test('docs/README.md'));
  assert.ok(globRegExp('tests/sync-skills*.test.mjs').test('tests/sync-skills-windows.test.mjs'));
  assert.ok(!globRegExp('scripts/check-subset.*').test('scripts/check-subsetx/a'));
});

test('dependencies：import、動態 import 與 new URL 的相對路徑', () => {
  const text = "import { a } from './lib/a.mjs';\nconst b = await import('../b.mjs');\nconst c = new URL('./c.mjs', import.meta.url);\nimport 'node:fs';\n// 見 ./d.mjs\n";
  assert.deepEqual(dependencies('scripts/x.mjs', text), ['scripts/lib/a.mjs', 'b.mjs', 'scripts/c.mjs']);
});

const TOY = {
  steps: ['base', 'links', 'code'],
  always: { steps: ['base'], tests: [] },
  full: ['bin/**'],
  rules: [
    { match: ['docs/**'], steps: ['links'], tests: ['tests/docs-*.test.mjs'], related: true },
    { match: ['scripts/**', 'tests/*.test.mjs', 'skills/**'], steps: ['code'], related: true },
  ],
};
const TOY_FILES = {
  'scripts/lib/util.mjs': 'export const x = 1;\n',
  'scripts/a.mjs': "import { x } from './lib/util.mjs';\n",
  'scripts/b.mjs': '// 和 util.mjs 的寫法相同\n',
  'scripts/c.mjs': 'console.log(1);\n',
  'tests/a.test.mjs': "import '../scripts/a.mjs';\n",
  'tests/b.test.mjs': "import '../scripts/b.mjs';\n",
  'tests/c.test.mjs': "spawnSync('node', ['scripts/c.mjs']);\n",
  'tests/docs-links.test.mjs': '',
  'tests/skill.test.mjs': "readFileSync(join(root, 'skills', 'one', 'SKILL.md'));\n",
  'docs/x.md': '',
  'skills/one/SKILL.md': '',
  'skills/two/SKILL.md': '',
};
const toyPlan = changed => plan({ changed, files: Object.keys(TOY_FILES), read: file => TOY_FILES[file] ?? '', table: TOY });

test('plan：符合 full 或沒有規則的路徑退回完整套件', () => {
  assert.deepEqual(toyPlan(['docs/x.md', 'bin/check']), { full: 'full-path bin/check' });
  assert.deepEqual(toyPlan(['docs/x.md', 'other/file']), { full: 'unmapped other/file' });
  assert.deepEqual(plan({ changed: ['docs/x.md'], files: [], read: () => '', table: { ...TOY, rules: [{ match: ['docs/**'], steps: ['typo'] }] } }), { full: 'unknown-step typo' });
});

test('plan：只改文件只跑該規則的步驟與指定測試', () => {
  assert.deepEqual(toyPlan(['docs/x.md']), { steps: ['base', 'links'], tests: ['tests/docs-links.test.mjs'] });
  assert.deepEqual(toyPlan([]), { steps: ['base'], tests: [] });
});

test('plan：沿 import 反向找到依賴的測試，註解裡的檔名不擴散', () => {
  assert.deepEqual(toyPlan(['scripts/lib/util.mjs']), { steps: ['base', 'code'], tests: ['tests/a.test.mjs'] });
  // 測試以字串提及腳本路徑（spawn）也算。
  assert.deepEqual(toyPlan(['scripts/c.mjs']).tests, ['tests/c.test.mjs']);
  // 改的就是測試檔：它自己要跑。
  assert.deepEqual(toyPlan(['tests/b.test.mjs']).tests, ['tests/b.test.mjs']);
});

test('plan：repo 裡不唯一的檔名要帶上層目錄才算提及', () => {
  assert.deepEqual(toyPlan(['skills/one/SKILL.md']).tests, ['tests/skill.test.mjs']);
  assert.deepEqual(toyPlan(['skills/two/SKILL.md']).tests, []);
});

// #628：docs/agents/ 的 adapter 檔，測試要從 repo 根讀它才算提及；暫存 repo 裡同名的 fixture 路徑與裸檔名不算。
const AGENT_FILES = {
  ...TOY_FILES,
  'docs/agents/adapter.md': '',
  'tests/agent-url.test.mjs': "const text = readFileSync(new URL('../docs/agents/adapter.md', import.meta.url), 'utf8');\n",
  'tests/agent-helper.test.mjs': "const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');\nassert.match(read('docs/agents/adapter.md'), /x/);\n",
  'tests/agent-root.test.mjs': "const root = new URL('..', import.meta.url).pathname;\nreadFileSync(join(root, 'docs', 'agents', 'adapter.md'));\n",
  'tests/agent-fixture.test.mjs': "const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');\nwriteFileSync(join(f.repo, 'docs/agents/adapter.md'), read('scripts/c.mjs'));\nconst PATH = 'docs/agents/adapter.md';\n",
  'tests/agent-name.test.mjs': '// 和 adapter.md 的 Probe 條目同名\n',
  'tests/agent-const.test.mjs': "const FILE = 'docs/agents/adapter.md';\nconst size = statSync(new URL(`../${FILE}`, import.meta.url)).size;\n",
  'tests/agent-const-fixture.test.mjs': "const FILE = 'docs/agents/adapter.md';\nconst read = path => readFileSync(join(dir, path), 'utf8');\nread(FILE);\n",
};

test('plan：docs/agents/ 的檔只有從 repo 根讀它的測試才相關，fixture 路徑與裸檔名不算（#628）', () => {
  const result = plan({ changed: ['docs/agents/adapter.md'], files: Object.keys(AGENT_FILES), read: file => AGENT_FILES[file] ?? '', table: TOY });
  // 路徑先存進常數再交給 repo 根的 URL 也算；常數交給暫存目錄的 reader 不算。
  assert.deepEqual(result.tests, ['tests/agent-const.test.mjs', 'tests/agent-helper.test.mjs', 'tests/agent-root.test.mjs', 'tests/agent-url.test.mjs', 'tests/docs-links.test.mjs']);
  // docs/agents/ 以外的檔維持原規則：唯一檔名照樣算提及。
  assert.deepEqual(plan({ changed: ['scripts/c.mjs'], files: Object.keys(AGENT_FILES), read: file => AGENT_FILES[file] ?? '', table: TOY }).tests, ['tests/agent-fixture.test.mjs', 'tests/c.test.mjs']);
});

// #628：PR #627 只改 pilot.md 一行就挑出 24 支，超過 pre-commit 免排 slot 的 CHECK_SLOT_FREE_TESTS（預設 10）。
test('本 repo 只改 docs/agents/pilot.md：子集不超過 10 支，仍含從 repo 根讀它的測試，不含暫存 repo 的 fixture 測試（#628）', () => {
  const files = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const read = file => { try { return readFileSync(join(root, file), 'utf8'); } catch { return ''; } };
  const { tests } = plan({ changed: ['docs/agents/pilot.md'], files, read, table: TABLE });
  assert.ok(tests.length <= 10, `${tests.length}：${tests.join(' ')}`);
  for (const reader of ['tests/auto-retro.test.mjs', 'tests/triage-brief.test.mjs', 'tests/pilot-probe-overlap.test.mjs']) assert.ok(tests.includes(reader), reader);
  for (const fixture of ['tests/entry-survival.test.mjs', 'tests/port-entries.test.mjs', 'skills/engineering/setup-workflow/templates/adapter-line.test.mjs']) assert.ok(!tests.includes(fixture), fixture);
});

// #628：這三支照 Pilot 段連結或 adapter-line.mjs 讀拆出檔的條目，不寫出檔名；提及規則收緊後要在對應表釘住。
test('掃 Pilot 段拆出檔條目的測試：改任一份 docs/agents/pilot-*.md 都在子集裡（#628）', () => {
  const files = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const split = files.filter(file => /^docs\/agents\/pilot-[^/]+\.md$/.test(file));
  assert.ok(split.includes('docs/agents/pilot-round.md') && split.includes('docs/agents/pilot-after-merge.md'));
  for (const changed of split) {
    const { tests } = plan({ changed: [changed], files: files.filter(file => file.startsWith('tests/')), read: () => '', table: TABLE });
    for (const scanner of ['tests/pilot-project-flags.test.mjs', 'tests/pilot-push-gate-scripts.test.mjs', 'tests/pilot-resume-tui-timeout.test.mjs']) assert.ok(tests.includes(scanner), `${changed}：${scanner}`);
  }
});

/** 去掉 `//` 與 `/* *\/` 註解，字串（含模板字串）原樣保留；只在註解裡提到的讀法不算。 */
export function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else out += c;
  }
  return out;
}

// 動態讀本 repo adapter、不寫出個別檔名的寫法：照 Pilot 段連結讀（pilot-probe.mjs 的 pilotFiles，或包它的 tests/helpers/pilot-docs.mjs）、
// 以 repo 根為 cwd spawn adapter-line.mjs、readdirSync 掃 docs/agents 目錄。都要求是程式碼裡的呼叫或 import，註解不算。
const DYNAMIC_READS = [
  ['pilotFiles', text => /\bpilotFiles\s*\(/.test(text) || /\bfrom\s*['"`][./]*helpers\/pilot-docs\.mjs['"`]/.test(text)],
  ['adapter-line', text => /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\([^;]*?['"`]scripts\/adapter-line\.mjs['"`]/.test(text)],
  ['readdir docs/agents', text => /\breaddirSync\s*\(/.test(text) && /['"`](?:\.\.\/)*docs\/agents\/?['"`]|['"`]docs['"`]\s*,\s*['"`]agents['"`]\s*\)/.test(text)],
];

/** 用到動態讀法的測試檔：`[{ file, reads }]`。 */
export function dynamicAdapterReaders({ files, read }) {
  return files.flatMap(file => {
    const code = stripComments(read(file));
    const reads = DYNAMIC_READS.filter(([, uses]) => uses(code)).map(([name]) => name);
    return reads.length ? [{ file, reads }] : [];
  });
}

/** 動態讀 adapter、卻沒釘在任一條 `docs/agents/` 開頭規則 tests 裡的測試檔，以 `檔名（讀法）` 列出。 */
export function unpinnedAdapterReaders({ files, read, table }) {
  const pinned = table.rules.filter(rule => rule.match.some(glob => glob.startsWith('docs/agents/'))).flatMap(rule => rule.tests ?? []);
  return dynamicAdapterReaders({ files, read })
    .filter(({ file }) => !pinned.some(glob => globRegExp(glob).test(file)))
    .map(({ file, reads }) => `${file}（${reads.join('、')}）`);
}

// #710：#628、#654 兩次都是動態讀 adapter 的測試被子集漏掉，到完整 bin/check 才紅。範本測試（setup-workflow/templates/*.test.mjs）
// 只對暫存 repo 跑副本，不讀本 repo 的 docs/agents，不在掃描範圍；本檔的命中是守門自己的假資料，也不算。
const repoTests = () => spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'tests/*.test.mjs'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(file => file && file !== 'tests/check-subset.test.mjs');
const readRepo = file => { try { return readFileSync(join(root, file), 'utf8'); } catch { return ''; } };

test('動態讀 adapter 的測試都釘在 docs/agents/ 規則的 tests 裡（#710）', () => {
  const files = repoTests();
  assert.ok(files.includes('tests/pilot-resume-tui-timeout.test.mjs'));
  assert.deepEqual(unpinnedAdapterReaders({ files, read: readRepo, table: TABLE }), []);
});

test('守門：拿掉一支已釘的測試就列出它；只在註解提到讀法的不算（#710）', () => {
  const files = repoTests();
  const without = { ...TABLE, rules: TABLE.rules.map(rule => ({ ...rule, tests: rule.tests?.filter(file => file !== 'tests/pilot-resume-tui-timeout.test.mjs') })) };
  assert.deepEqual(unpinnedAdapterReaders({ files, read: readRepo, table: without }), ['tests/pilot-resume-tui-timeout.test.mjs（adapter-line）']);
  const FAKE = {
    'tests/comment-only.test.mjs': "// 用 execFileSync('node', ['scripts/adapter-line.mjs', 'Resume']) 讀條目\n/* pilotFiles(adapter) 與 readdirSync('docs/agents') */\nconst s = 'see // scripts/adapter-line.mjs';\n",
    'tests/spawn.test.mjs': "const entry = execFileSync('node', ['scripts/adapter-line.mjs', 'Resume'], { cwd: root });\n",
    'tests/helper.test.mjs': "import { pilotEntry } from './helpers/pilot-docs.mjs';\n",
    'tests/readdir.test.mjs': "const dir = new URL('../docs/agents/', import.meta.url);\nreaddirSync(dir);\n",
  };
  const fake = { files: Object.keys(FAKE), read: file => FAKE[file], table: { rules: [] } };
  assert.deepEqual(dynamicAdapterReaders(fake).map(({ file }) => file), ['tests/spawn.test.mjs', 'tests/helper.test.mjs', 'tests/readdir.test.mjs']);
  assert.deepEqual(unpinnedAdapterReaders({ ...fake, table: { rules: [{ match: ['docs/agents/**'], tests: ['tests/spawn.test.mjs', 'tests/helper.test.mjs', 'tests/readdir.test.mjs'] }, { match: ['scripts/**'], tests: ['tests/comment-only.test.mjs'] }] } }), []);
  // 釘在 docs/agents/ 以外的規則不算。
  assert.deepEqual(unpinnedAdapterReaders({ ...fake, table: { rules: [{ match: ['scripts/**'], tests: ['tests/*.test.mjs'] }] } }).length, 3);
});

const source = readFileSync(join(root, 'bin/check'), 'utf8');

test('對應表與 bin/check 的步驟群組一致，每條規則的步驟都在清單裡', () => {
  const used = [...new Set([...source.matchAll(/^if want ([\w-]+); then$/gm)].map(match => match[1]))].sort();
  assert.deepEqual(used, TABLE.steps.filter(step => step !== 'base').sort());
  for (const rule of TABLE.rules) for (const step of rule.steps ?? []) assert.ok(TABLE.steps.includes(step), `${rule.match} 的 ${step}`);
  for (const step of TABLE.always.steps) assert.ok(TABLE.steps.includes(step), step);
});

// #654：pilot-adapter-stage.test.mjs 以 readdirSync 掃 docs/agents/*.md 與 issue-run 的 *TEMPLATE.md，不提及個別檔名，
// related 找不到它；只改 issue-run-checks.md 等文件的 commit，pre-commit 不跑這條，到完整 bin/check 才紅。
test('目錄掃描的 pilot-adapter-stage 測試：改它掃的任一份文件都在子集裡（#654）', () => {
  const files = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const scanned = files.filter(file => /^docs\/agents\/[^/]+\.md$/.test(file) || /^skills\/engineering\/issue-run\/[^/]*TEMPLATE\.md$/.test(file));
  assert.ok(scanned.includes('docs/agents/issue-run-checks.md') && scanned.includes('skills/engineering/issue-run/PILOT-TEMPLATE.md'));
  const tests = files.filter(file => file.startsWith('tests/'));
  for (const changed of scanned) {
    const result = plan({ changed: [changed], files: tests, read: () => '', table: TABLE });
    assert.ok(result.tests?.includes('tests/pilot-adapter-stage.test.mjs'), `${changed}：${JSON.stringify(result)}`);
  }
});

test('pre-commit 跑子集；CHECK_PASS_SUBSET 不以 `CHECK_PASS ` 開頭（pilot-land.mjs 只認後者為 Regression 通過）', () => {
  // 直接跑與經 heavy-slot 跑的兩種寫法都帶 --changed。
  const hook = readFileSync(join(root, '.githooks/pre-commit'), 'utf8');
  assert.match(hook, /^check=\(bin\/check --changed\)$/m);
  assert.match(hook, /heavy-slot\.mjs run [^\n]*-- bin\/check --changed\)$/m);
  assert.match(source, /^echo "CHECK_PASS\$\{subset:\+_SUBSET\} tests /m);
  assert.match(readFileSync(join(root, 'scripts/pilot-land.mjs'), 'utf8'), /startsWith\('CHECK_PASS '\)/);
});

/**
 * 暫存 repo 放真的 bin/check、check-subset.mjs 與對應表；其餘檢查腳本、bin/sync-skills 與 node-test-guarded 換成替身，
 * 只把自己的名稱（guard 另帶參數）寫進 $STEP_LOG。main 有一個 commit，之後在 work 分支改檔。
 */
function fixture(t) {
  const repo = mkdtempSync(join(realTmpdir(), 'check-subset-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const write = (path, content, mode) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
    if (mode) chmodSync(join(repo, path), mode);
  };
  const git = (...args) => spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: repo, encoding: 'utf8', env });
  for (const path of ['bin/check', 'scripts/check-subset.mjs', 'scripts/check-subset.json', 'scripts/check-stamp.mjs']) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    copyFileSync(join(root, path), join(repo, path));
  }
  const stub = name => `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.STEP_LOG, ${JSON.stringify(name)} + '\\n');\n`;
  for (const [, name] of source.matchAll(/node scripts\/([\w-]+\.mjs)/g)) if (!['check-subset.mjs', 'check-stamp.mjs'].includes(name)) write(`scripts/${name}`, stub(name));
  write('bin/sync-skills', '#!/bin/sh\necho sync-skills >> "$STEP_LOG"\n', 0o755);
  write('skills/engineering/setup-workflow/templates/node-test-guarded.mjs', "import { appendFileSync } from 'node:fs';\nconst files = process.argv.slice(2).filter(arg => !arg.startsWith('--'));\nappendFileSync(process.env.STEP_LOG, `guarded ${files.join(' ')}\\n`);\nconsole.log(`ℹ tests ${files.length}`);\n");
  const pass = "import { test } from 'node:test';\ntest('ok', () => {});\n";
  for (const path of source.match(/^docs_rules=\((.*)\)$/m)[1].split(' ')) write(path, pass);
  write('scripts/lib/util.mjs', 'export const x = 1;\n');
  write('scripts/a.mjs', "import { x } from './lib/util.mjs';\nconsole.log(x);\n");
  write('tests/a.test.mjs', `${pass}import '../scripts/a.mjs';\n`);
  write('tests/b.test.mjs', pass);
  write('skills/engineering/setup-workflow/templates/t.test.mjs', pass);
  write('docs/workflow/README.md', '# 首頁\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'base').status, 0);
  git('checkout', '-q', '-b', 'work');
  // log 放在 repo 外：repo 裡的新檔會被當成沒有規則的變更路徑，整條退回完整套件。
  const logDir = mkdtempSync(join(realTmpdir(), 'check-subset-log-'));
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const log = join(logDir, 'steps');
  const run = (args, extra = {}) => {
    writeFileSync(log, '');
    // HEAVY_SLOT_HELD：完整跑時不去排本機 heavy-slot、不看名額；名額 0 的機器單獨跑這支時，CHECK_FULL=1 那次會走 CI 委派分支，步驟一條都不記（retro 1126b）。
    const result = spawnSync('bin/check', args, { cwd: repo, encoding: 'utf8', env: { ...env, HEAVY_SLOT_HELD: '1', STEP_LOG: log, ...extra }, timeout: 60_000 });
    return { ...result, steps: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  };
  return { repo, write, git, run };
}

test('bin/check --changed：只改文件時只跑連結與流程站守門，不跑任何測試組，最後一行 CHECK_PASS_SUBSET', t => {
  const f = fixture(t);
  f.write('docs/workflow/README.md', '# 首頁\n\n改了。\n');
  const result = f.run(['--changed', 'main']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^CHECK_SUBSET steps base,links,workflow-site,docs-rules tests 0$/m);
  assert.ok(result.steps.includes('check-links.mjs') && result.steps.includes('build-workflow-site.mjs'), result.steps.join(' '));
  for (const skipped of ['sync-skills', 'check-portability.mjs', 'hook-acceptance.mjs', 'check-claude-settings.mjs']) assert.ok(!result.steps.includes(skipped), skipped);
  assert.deepEqual(result.steps.filter(step => step.startsWith('guarded')), []);
  assert.equal(result.stdout.trim().split('\n').at(-1), 'CHECK_PASS_SUBSET tests 0');
});

test('bin/check --changed：改 lib 只跑依賴它的測試；pre-commit 帶 CHECK_INDEX_TREE 時比對那棵樹', t => {
  const f = fixture(t);
  f.write('scripts/lib/util.mjs', 'export const x = 2;\n');
  const result = f.run(['--changed', 'main']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.steps.filter(step => step.startsWith('guarded')), ['guarded tests/a.test.mjs']);
  assert.match(result.stdout.trim().split('\n').at(-1), /^CHECK_PASS_SUBSET tests 1$/);
  // 工作區有改動，但要 commit 的樹（還沒 add）沒有：子集是空的。
  const tree = f.git('write-tree').stdout.trim();
  const staged = f.run(['--changed', 'main'], { CHECK_INDEX_TREE: tree });
  assert.match(staged.stdout, /^CHECK_SUBSET steps base,docs-rules tests 0$/m);
});

test('bin/check --changed：沒有規則的路徑、CHECK_FULL=1、沒有 --changed 都跑完整套件', t => {
  const f = fixture(t);
  f.write('somewhere/new.txt', 'x\n');
  const unmapped = f.run(['--changed', 'main']);
  assert.equal(unmapped.status, 0, unmapped.stdout + unmapped.stderr);
  assert.match(unmapped.stdout, /^CHECK_SUBSET full unmapped somewhere\/new\.txt$/m);
  const full = ['guarded tests/a.test.mjs tests/b.test.mjs tests/check-coordinator-permissions.test.mjs tests/gh-tracker.test.mjs tests/pilot-probe-adapter-entries.test.mjs tests/pilot-project-flags.test.mjs tests/pilot-push-gate-scripts.test.mjs tests/pilot-split.test.mjs tests/pilot-store-usage.test.mjs tests/setup-workflow-stations.test.mjs tests/template-copies.test.mjs', 'guarded skills/engineering/setup-workflow/templates/t.test.mjs'];
  assert.deepEqual(unmapped.steps.filter(step => step.startsWith('guarded')), full);
  assert.ok(unmapped.steps.includes('sync-skills') && unmapped.steps.includes('hook-acceptance.mjs'));
  assert.match(unmapped.stdout.trim().split('\n').at(-1), /^CHECK_PASS tests /);
  rmSync(join(f.repo, 'somewhere'), { recursive: true });
  f.write('docs/workflow/README.md', '# 改\n');
  const forced = f.run(['--changed', 'main'], { CHECK_FULL: '1' });
  assert.doesNotMatch(forced.stdout, /CHECK_SUBSET/);
  assert.deepEqual(forced.steps.filter(step => step.startsWith('guarded')), full);
  const plain = f.run([]);
  assert.deepEqual(plain.steps.filter(step => step.startsWith('guarded')), full);
  assert.match(plain.stdout.trim().split('\n').at(-1), /^CHECK_PASS tests /);
});

test('bin/check --changed：base 不存在時退回完整套件', t => {
  const f = fixture(t);
  const result = f.run(['--changed', 'no-such-ref']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^CHECK_SUBSET full no-merge-base no-such-ref$/m);
});
