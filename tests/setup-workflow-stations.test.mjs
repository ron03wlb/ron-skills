// /setup-workflow 一次完成（#278，取代 #91 的分段確認）：環境 → Host → 安裝目標都自動偵測、正常情況不問人，
// 寫入全在另開 worktree 的分支上，最後開 PR，人合併 PR 就是確認；全程用人的語言、不講等級代號。導讀站 docs/workflow/ 同步轉述。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

// 這支只讀文件（readFileSync／existsSync），列在 bin/check 的 docs_rules（#567）：不要加會 spawn 或寫檔的測試，那種放別的檔。

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function steps(skill) {
  const body = skill.split('\n## Steps\n')[1].split('\n## ')[0];
  return [...body.matchAll(/^(\d+)\. \*\*([^*]+)\.\*\* ([\s\S]*?)(?=^\d+\. \*\*|(?![\s\S]))/gm)]
    .map(([, number, name, text]) => ({ number: Number(number), name, text }));
}

const SKILL = 'skills/engineering/setup-workflow/SKILL.md';

test('SKILL.md 的步驟：偵測（環境、Host、目標、擴充）→ 開分支 → 寫入 → PR → 報告', () => {
  const names = steps(read(SKILL)).map(step => step.name);
  assert.deepEqual(names, ['Environment', 'Host', 'Target', 'Extensions', 'Branch', 'Tracker, labels, domain docs, language',
    'Adapter', 'Copy templates and gates', 'Remote CI', 'PR', 'Report']);
});

test('正常情況不問人：平台、目標、擴充都不問；Host 只在邊界情況問；沒有寫入清單確認', () => {
  const [environment, host, target, extensions] = steps(read(SKILL));
  assert.match(environment.text, /Do not ask about platforms/);
  assert.match(environment.text, /ENV stop/);
  assert.match(host.text, /ask the human only in these cases/);
  assert.match(host.text, /differ/);
  assert.match(host.text, /`local`/);
  assert.match(target.text, /TARGET/);
  assert.match(target.text, /never asked and never limited to one level per run/);
  assert.match(extensions.text, /Do not ask the human/);
  assert.doesNotMatch(read(SKILL), /--answer|RECOMMEND|Stop and wait for the human/);
});

test('寫入在 worktree 的分支上，最後開 PR；人合併 PR 是唯一確認', () => {
  const all = steps(read(SKILL));
  const branch = all.find(step => step.name === 'Branch');
  const pr = all.find(step => step.name === 'PR');
  assert.match(branch.text, /git -C <repo> worktree add -b setup-workflow/);
  assert.match(pr.text, /open a PR \(MR on GitLab\)/);
  assert.match(read(SKILL), /The PR is the confirmation/);
});

test('全程用人的語言，不對人講等級代號；非英文時寫語言規則，繁中帶語言 hook', () => {
  const skill = read(SKILL);
  assert.match(skill, /\*\*Talk to the human in their language\.\*\*/);
  assert.match(skill, /Never name the levels \(L0–L3\)/);
  const language = steps(skill).find(step => step.name.endsWith('language'));
  assert.match(language.text, /### Language/);
  assert.match(language.text, /claude-hook-language\.mjs/);
});

test('01-tooling 有支援平台表：WSL2、macOS、一般 Linux，原生 Windows 不支援', () => {
  const section = read('docs/workflow/01-tooling.md').split('\n## 支援平台\n')[1]?.split('\n## ')[0] ?? '';
  for (const platform of ['WSL2', 'macOS', 'Linux']) assert.match(section, new RegExp(`\\| ${platform}`));
  assert.match(section, /原生 Windows \| 不支援/);
});

test('08-pitfalls 的工具與環境依 WSL、macOS、通用分組，WSL 項目標其他平台無害', () => {
  const section = read('docs/workflow/08-pitfalls.md').split('\n## 工具與環境\n')[1].split('\n## ')[0];
  assert.deepEqual([...section.matchAll(/^### (.+)$/gm)].map(match => match[1]), ['WSL', 'macOS', '通用']);
  const wsl = section.split('\n### WSL\n')[1].split('\n### ')[0];
  assert.match(wsl, /其他平台無害/);
});

test('03-level1 的 checklist 開頭是一次完成的三步', () => {
  const checklist = read('docs/workflow/03-level1.md').split('\n## Checklist\n')[1];
  const headings = [...checklist.matchAll(/^### \d+\. (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(headings.slice(0, 3), ['環境', 'Host', '安裝目標與檢查入口']);
});

test('#281：04 章的 pre-push 範本在跑檢查前清掉 git 匯出給 hook 的環境變數', () => {
  const template = read('docs/workflow/04-level2.md').split('\n```bash\n').find(block => block.startsWith('#!/usr/bin/env bash\n# pre-push:')) ?? '';
  assert.match(template, /unset \$\(git rev-parse --local-env-vars\); cd "\$tmp" && \$CHECK/);
});

test('#281：adr-next.mjs 只帶給用 README 記下一個編號的 repo，用檔名編號的不帶', () => {
  const row = read(SKILL).split('\n').find(line => line.startsWith('| `adr-next.mjs` |')) ?? '';
  assert.match(row, /docs\/adr\/README\.md/);
  assert.match(row, /does not bring it/);
});

test('#281：L3 的 pilot.md 從 PILOT-TEMPLATE.md 複製填值，範本的每個 {{placeholder}} 都在開頭註解裡說明', () => {
  const adapter = steps(read(SKILL)).find(step => step.name === 'Adapter');
  assert.match(adapter.text, /PILOT-TEMPLATE\.md/);
  assert.match(adapter.text, /pilot-sources\.txt/);
  const template = read('skills/engineering/issue-run/PILOT-TEMPLATE.md');
  const [comment, body] = template.split('-->');
  const used = new Set([...body.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]));
  assert.ok(used.size > 0);
  for (const name of used) assert.ok(comment.includes(`{{${name}}}`), `開頭註解沒說明 {{${name}}}`);
  for (const entry of ['Sessions', 'Probe', 'Dispatch', 'Stage, regression, integrate', 'Push gate', 'Close', 'Handoff']) {
    assert.match(body, new RegExp(`^- \\*\\*${entry}\\.\\*\\*`, 'm'), `範本缺 ${entry}`);
  }
  assert.match(read('skills/engineering/issue-run/ADAPTER.md'), /\[PILOT-TEMPLATE\.md\]\(PILOT-TEMPLATE\.md\)/);
});

// #344：填好的 pilot.md 是 14000 bytes 的必讀核心；骨架本文本身就要在預算內留 2 KB 給填值與專案條目，最長的步驟條目在 PILOT-ROUND-TEMPLATE.md。
// #567：這支只讀文件、秒級，列在 bin/check 的 docs_rules，改 PILOT-TEMPLATE 超預算時在整條測試之前就報（#420：前幾次要等整條 tests 才報）。
test('#344：PILOT-TEMPLATE 本文在核心預算內留 2 KB，搬出的條目在 PILOT-ROUND-TEMPLATE 有整條、在 PILOT-TEMPLATE 留 pointer', () => {
  const [comment, body] = read('skills/engineering/issue-run/PILOT-TEMPLATE.md').split('-->');
  const [size, cap] = [Buffer.byteLength(body), 14000 - 2000];
  assert.ok(size <= cap, `PILOT-TEMPLATE 本文 ${size}/${cap} bytes，超 ${size - cap}`);
  const round = read('skills/engineering/issue-run/PILOT-ROUND-TEMPLATE.md').split('-->')[1];
  for (const name of new Set([...round.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]))) assert.ok(comment.includes(`{{${name}}}`), `PILOT-TEMPLATE 註解沒說明 {{${name}}}`);
  for (const entry of ['Pool', 'Dispatch', 'Probe', 'Brief check', 'Triage brief']) {
    assert.match(round, new RegExp(`^- \\*\\*${entry}\\.\\*\\* (?!See )`, 'm'), `PILOT-ROUND-TEMPLATE 缺 ${entry} 整條`);
    assert.match(body, new RegExp(`^- \\*\\*${entry}\\.\\*\\* See \`docs/agents/pilot-round\\.md\`.*adapter-line\\.mjs '${entry}'`, 'm'), `PILOT-TEMPLATE 的 ${entry} pointer`);
  }
  assert.match(read('skills/engineering/issue-run/ADAPTER.md'), /\[PILOT-ROUND-TEMPLATE\.md\]\(PILOT-ROUND-TEMPLATE\.md\)/);
});

/** Markdown 裡 `- **<名稱>.** <本文>` 條目 → Map(名稱 → 本文)。 */
const entries = text => new Map([...text.matchAll(/^- \*\*(.+?)\.\*\* (.*)$/gm)].map(([, name, body]) => [name, body]));
/** 刻意和 ADAPTER.md 的範本指令不同的 PILOT-TEMPLATE 條目：`['<條目>', '<原因>']`。 */
const PILOT_TEMPLATE_EXEMPT = new Map([]);

/**
 * ADAPTER.md Pilot 段寫了「with the setup-workflow templates, …」的條目，子句裡的 `node scripts/<x>.mjs` 與裸寫的範本名稱 `<x>`
 * 都要在 PILOT-TEMPLATE.md 同名條目出現 `scripts/<x>.mjs`；條目是 `See \`docs/agents/pilot-round.md\`` pointer 時看 PILOT-ROUND-TEMPLATE.md 的同名條目。
 * 回傳 `PILOT_TEMPLATE_MISSING <條目> scripts/<x>.mjs` 行（條目整個不在時 `<x>` 印 `-`）。
 */
function pilotTemplateDrift(adapter, pilot, round) {
  const isTemplate = name => existsSync(new URL(`../skills/engineering/setup-workflow/templates/${name}.mjs`, import.meta.url));
  const [pilotEntries, roundEntries] = [entries(pilot), entries(round)];
  const lines = [];
  for (const [name, body] of entries(adapter.split('\n## Pilot\n')[1].split('\n## ')[0])) {
    if (PILOT_TEMPLATE_EXEMPT.has(name)) continue;
    const clause = body.split('with the setup-workflow templates,')[1]?.split(/\.(?: |$)(?=(?:[^`]*`[^`]*`)*[^`]*$)/)[0];
    if (!clause) continue;
    const scripts = new Set([...clause.matchAll(/`node scripts\/([\w./-]+)\.mjs\b/g), ...clause.matchAll(/`([\w-]+)`/g)].map(match => match[1]).filter(isTemplate));
    if (!scripts.size) continue;
    let text = pilotEntries.get(name);
    if (text?.startsWith('See `docs/agents/pilot-round.md`')) text = roundEntries.get(name);
    if (text === undefined) { lines.push(`PILOT_TEMPLATE_MISSING ${name} -`); continue; }
    for (const script of scripts) if (!text.includes(`scripts/${script}.mjs`)) lines.push(`PILOT_TEMPLATE_MISSING ${name} scripts/${script}.mjs`);
  }
  return lines;
}

// #461：#346 把 brief-check.mjs 升為正本、ADAPTER.md 的 Brief check 補了 Default 指令，PILOT-TEMPLATE 還留著「No command」，bin/check 全綠。
test('#461：ADAPTER.md Pilot 段的範本指令，PILOT-TEMPLATE（或它指去的 PILOT-ROUND-TEMPLATE）同名條目都提到', () => {
  const adapter = read('skills/engineering/issue-run/ADAPTER.md');
  const pilot = read('skills/engineering/issue-run/PILOT-TEMPLATE.md');
  const round = read('skills/engineering/issue-run/PILOT-ROUND-TEMPLATE.md');
  const before346 = pilot.replace(/^- \*\*Brief check\.\*\* .*$/m, "- **Brief check.** No command: a worker's brief is `/issue-run <n> --worker <checkpoint>` plus the Issue body.");
  assert.match(before346, /^- \*\*Brief check\.\*\* No command:/m);
  assert.deepEqual(pilotTemplateDrift(adapter, before346, round), ['PILOT_TEMPLATE_MISSING Brief check scripts/brief-check.mjs']);
  const drift = pilotTemplateDrift(adapter, pilot, round);
  assert.deepEqual(drift, [], `PILOT-TEMPLATE 條目沒跟上 ADAPTER.md 的範本指令（刻意不同就登記到 PILOT_TEMPLATE_EXEMPT）：\n${drift.join('\n')}`);
});

// #459：ADAPTER.md 要 Pilot 段連 pilot.md 與 pilot-round.md（pilot.md 在前），Probe 的 ADAPTER_AHEAD 只比對 Pilot 段連到的檔。
test('#459：setup-workflow step 7 要 Pilot 段連到 pilot.md 與 pilot-round.md，PILOT-ROUND-TEMPLATE 註解不再要人加預算行', () => {
  const adapter = steps(read(SKILL)).find(step => step.name === 'Adapter');
  assert.match(adapter.text, /`## Pilot` section links `docs\/agents\/pilot\.md` and `docs\/agents\/pilot-round\.md`, `pilot\.md` first/);
  assert.doesNotMatch(adapter.text, /only points to `docs\/agents\/pilot\.md`/);
  const comment = read('skills/engineering/issue-run/PILOT-ROUND-TEMPLATE.md').split('-->')[0];
  assert.match(comment, /\[optional: …\]/);
  assert.doesNotMatch(comment, /give it a 58000 line/);
  assert.equal(JSON.parse(read('skills/engineering/setup-workflow/templates/adapter-size-budget.json'))['docs/agents/pilot-round.md'], 58000);
});

// #526：consumer 的舊副本早於來源行，--verify 會印 NO_ORIGIN；step 8 要說怎麼處理。
test('#526：step 8 說明 --verify 的 NO_ORIGIN 是重跑 copy-templates（sha 與清單一致時是不必確認的 UPDATE）', () => {
  const copy = steps(read(SKILL)).find(step => step.name === 'Copy templates and gates');
  assert.match(copy.text, /`NO_ORIGIN <copy>`[\s\S]*?source line: the copy predates that line, so rerun `copy-templates\.mjs <repo> <template>`[\s\S]*?as an `UPDATE` without asking when its sha256 still matches the record/);
});
