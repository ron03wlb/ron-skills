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
    assert.ok(pilot.includes(`\`${out}`), `pilot.md 要寫出 ${out}`);
  }
});

test('Stage：允許的衝突解法（不同條目、只新增、表格的不同列、相鄰改動、戳記檔在其他檔解完後 restamp），解完照樣跑 Regression', () => {
  assert.match(line('Stage'), /解完的 staged SHA 一樣要跑 Regression.*`STOP conflict <n> <檔>=<來源>:<種類> …`.*Stage conflict/);
  const stage = line('Stage conflict');
  assert.match(stage, /不同的 `- \*\*<名稱>\.\*\*` 條目/);
  // #173：戳記檔是 scripts/restamp.mjs 的 STAMP_FILES，兩個都列出來，restamp 在其他衝突檔解完之後。
  assert.match(stage, /戳記檔（`scripts\/restamp\.mjs` 的 `STAMP_FILES`：`scripts\/workflow-doc-sync\.json`、`docs\/agents\/workflow-templates\.json`）.*其他衝突檔先用下列解法解完.*--restamp/);
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
  for (const name of ['Watch', 'Stage', 'Close']) {
    assert.match(line(name), /`"\$ORCA_CLI_COMMAND" (terminal|worktree) /, `**${name}.** 的 Orca 指令`);
  }
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
