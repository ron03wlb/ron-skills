import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { pilotDocs, pilotEntry } from './helpers/pilot-docs.mjs';

// coordinator 照 adapter Pilot 段逐行執行；這裡驗的是它讀到的那幾行。Pilot 段只留一行，指向 pilot.md 與拆出去的檔（#45、#166）。
const adapter = readFileSync(new URL('../docs/agents/issue-run.md', import.meta.url), 'utf8');
const pilot = readFileSync(new URL('../docs/agents/pilot.md', import.meta.url), 'utf8');
// 條目內容取它所在的那份（移出 pilot.md 的條目在 pilot.md 只剩 pointer，#166）。
const line = name => pilotEntry(name).line;
// 路徑依機器決定（#93）：Coordinator checkout、Stage worktree 兩條各定義一次怎麼取得，其他條目只用佔位符。
const mainCheckout = '<主 checkout>';
const stageWorktree = '<stage worktree>';

test('issue-run.md 的 Pilot 段只留一行指向 pilot.md', () => {
  const section = adapter.match(/^## Pilot\n([\s\S]*?)(?=^## |(?![\s\S]))/m)[1].trim();
  assert.equal(section.split('\n').length, 1, 'Pilot 段只留一行');
  assert.match(section, /\]\(pilot\.md\)/);
});

// 重現真實歷史：#20 改 Close、#22 改 Handoff，兩條相鄰沒空行，git 併成同一個 hunk 判成衝突（gate G2）。
// 回傳 A 改 Close、B 改 Handoff 後 merge 的結果；每一步都要成功，免得 edit 沒改到時 merge 空轉通過。
function mergeAdjacentEdits(t, content) {
  const repo = mkdtempSync(join(realTmpdir(), 'pilot-md-merge-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
    if (args[0] !== 'merge') assert.equal(result.status, 0, `git ${args.join(' ')}：${result.stderr}`);
    return result;
  };
  const edit = (name, mark) => {
    const file = join(repo, 'pilot.md');
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes(`- **${name}.** `), `找不到 **${name}.** 條目`);
    writeFileSync(file, text.replace(`- **${name}.** `, `- **${name}.** ${mark} `));
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'pilot.md'), content);
  git('add', '.');
  git('commit', '-qm', 'base');
  git('switch', '-qc', 'a');
  edit('Close', '[A]');
  git('commit', '-qam', 'a');
  git('switch', '-qc', 'b', 'main');
  edit('Handoff', '[B]');
  git('commit', '-qam', 'b');
  git('switch', '-q', 'a');
  return git('merge', '--no-edit', 'b');
}

test('pilot 各檔條目之間空一行：兩條分支各改相鄰條目可以自動合併', t => {
  for (const { path, text } of pilotDocs) assert.doesNotMatch(text, /^- \*\*.*\n- \*\*/m, `${path}：相鄰兩個條目之間要空一行`);
  assert.match(pilot, /^- \*\*Close\.\*\*.*\n\n- \*\*Handoff\.\*\*/m, 'Close 與 Handoff 要相鄰');
  const merge = mergeAdjacentEdits(t, pilot);
  assert.equal(merge.status, 0, merge.stdout + merge.stderr);
});

test('對照：去掉條目間空行的舊格式，同樣的修改會衝突', t => {
  const merge = mergeAdjacentEdits(t, pilot.replace(/\n\n(?=- \*\*)/g, '\n'));
  assert.notEqual(merge.status, 0, '舊格式應該衝突');
  assert.match(merge.stdout, /CONFLICT/);
});

// Stage、Regression、Integrate 的 git 指令與 checkpoint 寫回都在 pilot-land.mjs 裡（#75），解法與 restamp 的行為由 tests/pilot-land.test.mjs 驗；
// 這裡驗三條都指向它，沒有留下要 coordinator 自己手打的 merge 或 sed（batch-40-51 手寫的 drift 檢查數錯 parent）。
test('Stage、Regression、Integrate 改成呼叫 pilot-land.mjs，不再列手打的 merge 與 checkpoint 寫回', () => {
  assert.ok(line('Stage').includes('node scripts/pilot-land.mjs <key>'), 'Stage 要跑 pilot-land.mjs');
  for (const name of ['Regression', 'Integrate']) assert.ok(line(name).includes('pilot-land.mjs'), `**${name}.** 要寫明由 pilot-land.mjs 做`);
  for (const name of ['Stage', 'Regression', 'Integrate']) {
    assert.doesNotMatch(line(name), /git -C <stage worktree> merge|`sed /, `**${name}.** 不再列手打的指令`);
  }
  for (const out of ['MERGED <key> <sha>', 'STOP regression <exit>', 'STOP hold', 'STOP drift', 'STOP conflict <n>']) {
    assert.ok(pilotDocs.some(({ text }) => text.includes(`\`${out}`)), `pilot 各檔要寫出 ${out}`);
  }
});

test('Stage：允許的衝突解法（不同條目、只新增、表格的不同列、相鄰改動、戳記檔在其他檔解完後 restamp），解完照樣跑 Regression', () => {
  assert.match(line('Stage'), /解完的 staged SHA 一樣要跑 Regression.*`STOP conflict <n> <檔>=<來源>:<種類> …`.*Stage conflict/);
  const stage = line('Stage conflict');
  assert.match(stage, /不同的 `- \*\*<名稱>\.\*\*` 條目/);
  // #173：兩個戳記檔都列出來，restamp 在其他衝突檔解完之後；#245：條目解法與流程站戳記由 Stage 指令的 --resolver 帶入。
  assert.match(stage, /`--resolver scripts\/pilot-resolve\.mjs`/);
  assert.match(stage, /戳記檔（`scripts\/workflow-doc-sync\.json`、`docs\/agents\/workflow-templates\.json`.*其他衝突檔先用下列解法解完.*--restamp/);
  assert.match(stage, /Markdown 表格列.*以第一格為鍵.*（`rows`，#162/);
  assert.match(stage, /一邊只改了 base 的某幾行、另一邊只在 base 行之間插入新行.*（`adjacent`，#175/);
  assert.match(stage, /（`adjacent`，#175.*純刪除不算改動.*兩邊動到同一個 `- \*\*<名稱>\.\*\*` 條目/);
  assert.match(stage, /`adjacent`.*切開另一邊正在改的條目.*對齊不只一種而合出不同結果.*換上的行和插入的行相同/);
  assert.match(stage, /新增不重疊的段落/);
  assert.match(stage, /解完的 staged SHA 一樣要跑 Regression/);
});

// #192：batch 79-108 照舊順序先重派 #108，fresh worker 從 #79 合入前的整合分支開始，做完一定再跟 #79 衝突（refresh-twice）；
// 判斷同一條目又對兩邊跑 diff（29.7 KB）。改成讀 STOP 行的來源與種類欄，衝突對象是同批成員時先搬出、讓其他成員合入，再以自己的 key 重派。
test('Stage：STOP conflict 標來源與種類；同批成員衝突先 move 出原 batch、重跑合入其餘成員，再以自己的 key --fresh；不再跑兩邊 diff', () => {
  const stage = line('Stage conflict');
  assert.match(stage, /`STOP conflict <n> <檔>=<來源>:<種類> …`/);
  assert.match(stage, /`member <m>`.*`integration`.*`member <m>\+integration`/);
  assert.match(stage, /`entry <名稱>`.*`code`.*`other`/);
  assert.doesNotMatch(stage, /git -C <主 checkout> diff/, '同一條目判斷不再跑兩邊 diff');
  const order = stage.match(/來源含 `member <m>`[^。]*。/)?.[0] ?? '';
  const steps = ['pilot-batch.mjs <主 checkout> move <key> <n> --state stop', 'pilot-land.mjs <key>', 'pilot-dispatch.mjs <n> --fresh <n>:<slug>'];
  const at = steps.map(step => order.indexOf(step));
  assert.ok(at.every(i => i >= 0), `同批成員衝突的步驟要依序寫在同一句：${order}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, '先 move、再合入其餘成員、最後重派');
});

// #560：來源全是 integration 的 code／other 衝突，G16–G33 每次都答預設的 fresh 重派，人不在時一個 gate 擋一整晚。
// fixture 是真實的 STOP 行（#131，tests/pilot-land.test.mjs 也用它）：讀來源與種類欄，找出 Stage conflict 管這個組合的那一句。
test('Stage：來源只有 integration 的 code 衝突照 Fresh redispatch 重派、open 後立刻 resolve，不開 gate 等人；例外仍問人', () => {
  const stage = line('Stage conflict');
  const fixture = 'STOP conflict 131 scripts/pilot-close.mjs=integration:code';
  const fields = fixture.split(' ').slice(3).map(field => field.slice(field.indexOf('=') + 1).split(':'));
  assert.deepEqual(fields, [['integration', 'code']]);
  const rule = stage.split('。').find(sentence => /來源全是 `integration`/.test(sentence) && /`code`/.test(sentence)) ?? '';
  assert.ok(rule, 'Stage conflict 要有一句管「來源全是 `integration`」的 `code`／`other` 衝突');
  assert.match(rule, /`code` 或 `other` 時也不等人，照 Fresh redispatch 重派/);
  assert.match(rule, /照 Gates 先 `open` 再立刻 `resolve` 留紀錄、不通知/);
  // 同 batch 有 OVERLAP 時的順序寫在同一句：先 move、讓其餘成員合入，再重派。
  assert.match(rule, /印過 `OVERLAP <n> <m>` 時先 move、讓其餘成員合入再重派/);
  assert.doesNotMatch(stage, /來源含 `integration` 的 `code`、`other`，或 `unknown`）照舊變成 gate/, '舊規則把它們一律變成 gate');
  // 例外清單：設計取捨、整合分支那一邊有不是經 pilot 合入的改動（從 main 帶進來或人改的）、要暫緩或放棄；unknown 照舊開 gate。
  const exceptions = stage.slice(stage.indexOf('仍開 gate 等人'));
  assert.ok(stage.includes('仍開 gate 等人'), '例外清單要寫明');
  assert.match(exceptions, /設計取捨/);
  assert.match(exceptions, /git -C <主 checkout> log --first-parent --format='%H %s' <base>\.\.pilot\/integration -- <路徑…>/);
  // 經 pilot 合入的不只 issue/ 分支：retro 請求分支也 stage 進來（`Merge branch 'retro/fix-347-case' into pilot/stage-req-347`）；sync-main 帶進的 main 改動不算。
  assert.match(exceptions, /`Merge branch '…' into pilot\/stage-<key>`.*`retro\/` 請求分支.*`pilot\/stage-sync-main` 不算/);
  assert.match(exceptions, /`main`/);
  assert.match(exceptions, /暫緩或放棄/);
  assert.match(exceptions, /`unknown`[^。]*照舊變成 gate/);
  // 同 batch 有 OVERLAP 先 move 再重派；多個 batch 互相 overlap 依號碼一次一張、其餘 park --after（與 Dispatch stops 一致）。
  // 暫擱的成員要帶 --fresh：Probe 才印 UNPARK_FRESH 直接重派，否則印 UNPARK、先 stage 再撞同一個整合衝突（#482）。
  for (const text of [stage, line('Dispatch stops')]) assert.match(text, /依號碼一次只重派一張.*park <key> <n> --after <先做的那張> --fresh --reason <原因>/);
});

// #560 review：人工改動可能藏在 stage 合併後面（成員分支合過 main、成員改了檔名），整合 PR 合併後整合分支快轉、
// first-parent 只剩 PR 合併，本機 main 也可能落後 origin/main。照 Stage conflict 寫的指令在真的 repo 上跑：
// 有人工改動的要保留 gate，只有 pilot 改動的才直接重派。
// human：人工改動落在 'main' 或直接進 'integration'；rename：'split' 改名與大改分兩個 commit，'combined' 同一個 commit（git 認不出改名）。
function hiddenChangeFixture(t, { human, rename, landed, lagging }) {
  const repo = mkdtempSync(join(realTmpdir(), 'pilot-stage-hidden-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, `git ${args.join(' ')}：${result.stderr}`);
    return result.stdout.trim();
  };
  const body = (mark, at = -1) => Array.from({ length: 30 }, (_, i) => `export const step${i} = '${i === at || at < 0 ? mark : 'base'}-${i}';`).join('\n') + '\n';
  const humanEdit = branch => {
    git('switch', '-q', branch);
    writeFileSync(join(repo, 'old.mjs'), body('human', 3));
    git('commit', '-qam', 'Human changes deploy policy');
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'old.mjs'), body('base'));
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('branch', 'pilot/integration');
  git('branch', 'issue/131-member');
  if (human === 'main') humanEdit('main');
  if (human === 'integration') humanEdit('pilot/integration');
  // 成員分支從 main 開出：main 上的人工改動跟著它進 stage。
  git('switch', '-qc', 'issue/100-member', 'main');
  if (rename === 'split') {
    git('mv', 'old.mjs', 'new.mjs');
    git('commit', '-qm', 'Rename old.mjs to new.mjs');
    // 改寫第 20 行以後：合併時 git 仍認得出改名，直接改進整合分支的第 3 行才能跟著合進來。
    const kept = readFileSync(join(repo, 'new.mjs'), 'utf8').split('\n').slice(0, 20);
    writeFileSync(join(repo, 'new.mjs'), [...kept, ...Array.from({ length: 10 }, (_, i) => `export const rewritten${i} = ${i};`)].join('\n') + '\n');
    git('commit', '-qam', 'Rewrite new.mjs');
  } else if (rename === 'combined') {
    git('rm', '-q', 'old.mjs');
    writeFileSync(join(repo, 'new.mjs'), Array.from({ length: 30 }, (_, i) => `export function task${i}() { return ${i * 7}; }`).join('\n') + '\n');
    git('add', 'new.mjs');
    git('commit', '-qm', 'Replace old.mjs with new.mjs');
  } else {
    writeFileSync(join(repo, 'old.mjs'), readFileSync(join(repo, 'old.mjs'), 'utf8').replace("'base-20'", "'member-20'"));
    git('commit', '-qam', 'Member edits old.mjs');
  }
  git('switch', '-q', 'pilot/integration');
  git('merge', '-q', '--no-ff', '-m', "Merge branch 'issue/100-member' into pilot/stage-100", 'issue/100-member');
  git('switch', '-q', 'main');
  if (landed) {
    // land.mjs：整合 PR 以 merge commit 合進 main，再讓整合分支快轉到 main。
    git('merge', '-q', '--no-ff', '-m', 'Merge pull request #200 from owner/pilot/integration', 'pilot/integration');
    git('branch', '-f', 'pilot/integration', 'main');
  }
  git('update-ref', 'refs/remotes/origin/main', 'main');
  // 本機 main 停在原處（主 checkout 有未提交改動，land.mjs 沒讓它跟上）。
  if (lagging) git('reset', '-q', '--hard', base);
  return { repo, file: rename ? 'new.mjs' : 'old.mjs' };
}

test('Stage：藏在 stage 合併後面、改名、整合 PR 快轉之後或本機 main 落後時，人工改動仍開 gate', t => {
  const stage = line('Stage conflict');
  const command = pattern => {
    const found = stage.match(pattern);
    assert.ok(found, `Stage conflict 要寫明指令 ${pattern}`);
    return found[1];
  };
  assert.match(stage, /`<base>` 是 `git -C <主 checkout> merge-base <分支> pilot\/integration`/);
  const paths = command(/`(git -C <主 checkout> log --follow --name-status --format= <base>\.\.pilot\/integration -- <檔>)`/);
  const absent = command(/`(git -C <主 checkout> cat-file -e <base>:<路徑>)`/);
  const integrationSide = command(/`(git -C <主 checkout> log --first-parent --format='%H %s' <base>\.\.pilot\/integration -- <路徑…>)`/);
  const beneathPr = command(/`(git -C <主 checkout> log --first-parent --format='%H %s' <base>\.\.<PR>\^2 -- <路徑…>)`/);
  const mainSide = command(/`(git -C <主 checkout> log --first-parent --format=%s main origin\/main \^<base> -- <路徑…>)`/);
  const pilotMerge = /^Merge branch '[^']+' into pilot\/stage-(?!sync-main)|^Merge pull request #\d+ from \S+\/pilot\/integration$/;
  const pilotPr = /^Merge pull request #\d+ from \S+\/pilot\/integration$/;
  assert.match(stage, /`Merge pull request #… from …\/pilot\/integration` 以外的行[^。]*開 gate/, 'main 那一邊只認整合 PR 合併');
  const run = (template, repo, values) => {
    const text = Object.entries(values).reduce((acc, [key, value]) => acc.replaceAll(key, value), template.replaceAll('<主 checkout>', repo));
    return spawnSync('bash', ['-c', text], { encoding: 'utf8', env });
  };
  const lines = result => {
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\n').filter(Boolean);
  };
  const decide = ({ repo, file }) => {
    const base = lines(spawnSync('git', ['-C', repo, 'merge-base', 'issue/131-member', 'pilot/integration'], { encoding: 'utf8', env }))[0];
    // 每行是「狀態\t路徑」，改名行是「R<相似度>\t舊\t新」：狀態欄之後的路徑都算。
    const names = [...new Set([file, ...lines(run(paths, repo, { '<base>': base, '<檔>': file })).flatMap(entry => entry.split('\t').slice(1))])];
    if (names.every(name => run(absent, repo, { '<base>': base, '<路徑>': name }).status !== 0)) return 'gate';
    const quoted = names.map(name => `'${name}'`).join(' ');
    // 整合 PR 合併後整合分支快轉：直接進整合分支的改動在 PR 合併的第二個 parent 底下，沿 ^2 用同一條查詢往下查。
    const integrationHuman = (template, values) => lines(run(template, repo, { '<base>': base, '<路徑…>': quoted, ...values })).some(entry => {
      const [sha, ...words] = entry.split(' ');
      const subject = words.join(' ');
      if (!pilotMerge.test(subject)) return true;
      return pilotPr.test(subject) && integrationHuman(beneathPr, { '<PR>': sha });
    });
    if (integrationHuman(integrationSide, {})) return 'gate';
    return lines(run(mainSide, repo, { '<base>': base, '<路徑…>': quoted })).some(subject => !pilotPr.test(subject)) ? 'gate' : 'redispatch';
  };
  const cases = [
    { rename: false, landed: false }, { rename: false, landed: true },
    { rename: 'split', landed: false }, { rename: 'split', landed: true },
    { rename: 'split', landed: true, lagging: true }, { rename: false, landed: true, lagging: true },
  ];
  for (const options of cases) {
    const label = JSON.stringify(options);
    assert.equal(decide(hiddenChangeFixture(t, { ...options, human: 'main' })), 'gate', `${label}：main 的人工改動要保留 gate`);
    assert.equal(decide(hiddenChangeFixture(t, { ...options, human: null })), 'redispatch', `${label}：只有 pilot 改動，照常重派`);
  }
  for (const landed of [false, true]) assert.equal(decide(hiddenChangeFixture(t, { human: 'integration', rename: 'split', landed })), 'gate', `landed=${landed}：直接改進整合分支的舊路徑也要保留 gate`);
  // 同一個 commit 改名又大改，git 認不出改名、接不回 merge-base 的路徑：看不出來源，有沒有人工改動都保留 gate。
  for (const human of ['main', null]) assert.equal(decide(hiddenChangeFixture(t, { human, rename: 'combined', landed: false })), 'gate', `combined/${human}：接不回舊路徑要保留 gate`);
});

test('Integrate 比對 stage 時記下的 tip，不數 parent', () => {
  assert.match(line('Integrate'), /`onto <tip>`.*`STOP drift`/);
  assert.match(line('Stage'), /`current: staged <sha> onto <tip>`/);
});

// 重現真實歷史：stage #15 時主 checkout 切到 pilot/stage-<key>，工作樹帶出該分支的 .claude/settings.json，
// 在主 checkout 跑的 session 都載入了它的 hook，切回 main 後每次 Stop 都報找不到腳本（#21）。
// 根因是主 checkout 的工作樹被換掉，所以只鎖 checkout／switch；merge、branch 不會換工作樹。
test('Stage、Regression、Integrate、Integration branch 寫明在 stage worktree，且不在主 checkout checkout／switch', () => {
  for (const name of ['Stage', 'Regression', 'Integrate', 'Integration branch']) {
    const text = line(name);
    assert.ok(text.includes(stageWorktree), `**${name}.** 要寫明在 stage worktree 執行`);
    for (const [hit, target] of text.matchAll(/git (?:-C (<[^>]+>|[^\s<]\S*) )?(?:checkout|switch)\b/g)) {
      assert.equal(target, stageWorktree, `${name}：${hit} 不在 stage worktree`);
    }
  }
});

// 主 checkout 不在 main 的偵測在 pilot-probe.mjs 裡（tests/pilot-probe.test.mjs 驗 NOT_MAIN）；這裡驗 Probe 跑它並處理 NOT_MAIN。
test('Probe 在主 checkout 跑 pilot-probe.mjs，並處理 NOT_MAIN', () => {
  assert.ok(line('Probe').includes(`node scripts/pilot-probe.mjs ${mainCheckout}`), 'Probe 要在主 checkout 跑 pilot-probe.mjs');
  assert.match(line('Probe'), /`NOT_MAIN <分支>` 回報人，不 stage、不 merge/);
});

// 重現 #93：pilot.md 寫死 WSL 的 /home/ron/... 與 orca-ide，macOS 上 Probe、Dispatch、Stage 第一步就失敗。
test('pilot 各檔不寫死機器路徑與 Orca 指令名：Orca 一律 "$ORCA_CLI_COMMAND"', () => {
  for (const { path, text } of pilotDocs) {
    assert.doesNotMatch(text, /\/home\/|\/Users\//, `${path}：不寫機器專屬的絕對路徑`);
    assert.doesNotMatch(text, /orca-ide/, `${path}：Orca 指令寫 "$ORCA_CLI_COMMAND"`);
  }
  for (const name of ['Stage', 'Close']) {
    assert.match(line(name), /`"\$ORCA_CLI_COMMAND" (terminal|worktree) /, `**${name}.** 的 Orca 指令`);
  }
  // Watch 經 pilot-probe --tail，它自己讀 ORCA_CLI_COMMAND，不手拼 JSON（#295：機器上沒有 jq）。
  assert.match(line('Watch'), /`node scripts\/pilot-probe\.mjs --tail <handle>`/);
  // #355：背景 watcher 用範本 pilot-watch.mjs，多批都監看，不自寫。
  assert.match(line('Watch'), /`node scripts\/pilot-watch\.mjs --batch <key>`/);
});

test('主 checkout 與 stage worktree 各在自己的條目定義一次怎麼取得', () => {
  const coordinator = line('Coordinator checkout');
  assert.ok(coordinator.includes(mainCheckout));
  assert.ok(coordinator.includes('git rev-parse --show-toplevel'));
  assert.ok(coordinator.includes('git rev-parse --path-format=absolute --git-common-dir'));
  const stage = line('Stage worktree');
  assert.ok(stage.includes(stageWorktree));
  assert.ok(stage.includes('git -C <主 checkout> worktree list --porcelain'));
  assert.match(stage, /`pilot\/integration`.*`pilot\/stage-\*`/);
});

// #21 的根因是主 checkout 的工作樹被換掉：路徑改成佔位符後，整份 pilot.md 對主 checkout 都不能 checkout／switch。
test('整份 pilot.md 沒有在主 checkout checkout／switch 的步驟', () => {
  const switches = text => [...text.matchAll(/git -C (<[^>]+>|[^\s<]\S*) (?:checkout|switch)\b/g)].map(([, target]) => target);
  // 手打的 switch 都已改成 pilot-land.mjs（含 #193 的 sync-main），pilot.md 可能一個都沒有：先確認 regex 認得兩種寫法，零命中才有意義。
  assert.deepEqual(switches('`git -C <主 checkout> switch x`、`git -C <stage worktree> checkout y`'), ['<主 checkout>', stageWorktree]);
  for (const { text } of pilotDocs) for (const target of switches(text)) assert.equal(target, stageWorktree);
});
