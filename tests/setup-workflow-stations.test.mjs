// /setup-workflow 一次完成（#278，取代 #91 的分段確認）：環境 → Host → 安裝目標都自動偵測、正常情況不問人，
// 寫入全在另開 worktree 的分支上，最後開 PR，人合併 PR 就是確認；全程用人的語言、不講等級代號。導讀站 docs/workflow/ 同步轉述。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
