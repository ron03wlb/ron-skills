// /setup-workflow 的分段確認流程（#91，#82 R1-Q3）：環境 → Host → 等級三站各自呈現證據、確認後才往下、都不寫檔，
// 接著 extensions、寫檔清單確認，最後才寫檔。導讀站 docs/workflow/ 同步轉述這個順序與支援平台。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function steps(skill) {
  const body = skill.split('\n## Steps\n')[1].split('\n## ')[0];
  return [...body.matchAll(/^(\d+)\. \*\*([^*]+)\.\*\* ([\s\S]*?)(?=^\d+\. \*\*|(?![\s\S]))/gm)]
    .map(([, number, name, text]) => ({ number: Number(number), name, text }));
}

test('SKILL.md 的步驟依序是三站、extensions、寫檔清單確認，之後才寫檔', () => {
  const names = steps(read('skills/engineering/setup-workflow/SKILL.md')).map(step => step.name);
  assert.deepEqual(names.slice(0, 5), ['Environment', 'Host', 'Level', 'Extensions', 'Confirm']);
  assert.ok(names.indexOf('Tracker, labels, domain docs') > names.indexOf('Confirm'));
});

test('三站各自停下等人確認，都不寫檔，並寫明自己的邊界情況', () => {
  const [environment, host, level] = steps(read('skills/engineering/setup-workflow/SKILL.md'));
  for (const station of [environment, host, level]) {
    assert.match(station.text, /write nothing/, `${station.name} 沒寫明不寫檔`);
    assert.match(station.text, /Stop and wait for the human/, `${station.name} 沒寫明停下等人確認`);
    assert.match(station.text, /Done when [^.]*the human confirmed/, `${station.name} 的完成條件不是人確認`);
  }
  assert.match(environment.text, /ENV stop/);
  assert.match(environment.text, /optional tool/);
  assert.match(host.text, /differ/);
  assert.match(host.text, /`local`/);
  assert.match(level.text, /jump/);
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

test('03-level1 的 checklist 開頭是三站', () => {
  const checklist = read('docs/workflow/03-level1.md').split('\n## Checklist\n')[1];
  const headings = [...checklist.matchAll(/^### \d+\. (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(headings.slice(0, 3), ['環境站', 'Host 站', '等級站']);
});
