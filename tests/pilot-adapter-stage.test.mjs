import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

// coordinator 照 adapter Pilot 段逐行執行；這裡驗的是它讀到的那幾行。Pilot 段只指向 pilot.md，內容都在那裡（#45）。
const adapter = readFileSync(new URL('../docs/agents/issue-run.md', import.meta.url), 'utf8');
const pilot = readFileSync(new URL('../docs/agents/pilot.md', import.meta.url), 'utf8');
const line = name => pilot.match(new RegExp(`^- \\*\\*${name}\\.\\*\\*.*$`, 'm'))?.[0] ?? '';
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

test('pilot.md 條目之間空一行：兩條分支各改相鄰條目可以自動合併', t => {
  assert.doesNotMatch(pilot, /^- \*\*.*\n- \*\*/m, '相鄰兩個條目之間要空一行');
  assert.match(pilot, /^- \*\*Close\.\*\*.*\n\n- \*\*Handoff\.\*\*/m, 'Close 與 Handoff 要相鄰');
  const merge = mergeAdjacentEdits(t, pilot);
  assert.equal(merge.status, 0, merge.stdout + merge.stderr);
});

test('對照：去掉條目間空行的舊格式，同樣的修改會衝突', t => {
  const merge = mergeAdjacentEdits(t, pilot.replace(/\n\n(?=- \*\*)/g, '\n'));
  assert.notEqual(merge.status, 0, '舊格式應該衝突');
  assert.match(merge.stdout, /CONFLICT/);
});

test('Stage：衝突 hunk 兩邊改的是不同條目時各取各的版本，並在新的 staged SHA 重跑 Regression', () => {
  const stage = line('Stage');
  assert.match(stage, /不同的 `- \*\*<名稱>\.\*\*` 條目/);
  assert.match(stage, /重跑 Regression/);
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
test('pilot.md 不寫死機器路徑與 Orca 指令名：Orca 一律 "$ORCA_CLI_COMMAND"', () => {
  assert.doesNotMatch(pilot, /\/home\/|\/Users\//, '不寫機器專屬的絕對路徑');
  assert.doesNotMatch(pilot, /orca-ide/, 'Orca 指令寫 "$ORCA_CLI_COMMAND"');
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
  const hits = [...pilot.matchAll(/git -C (<[^>]+>|[^\s<]\S*) (?:checkout|switch)\b/g)].map(([, target]) => target);
  assert.ok(hits.length > 0, '應該找得到 stage worktree 的 switch');
  for (const target of hits) assert.equal(target, stageWorktree);
});
