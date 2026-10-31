#!/usr/bin/env node
// /setup-workflow 升到 L2 時寫遠端 CI 最小設定（#139）：依程式碼 host（判定同 Host 站，../templates/lib/hosts.mjs）
// GitHub 寫 .github/workflows/checks.yml、GitLab 寫 .gitlab-ci.yml，local 不寫（只有本機 CI 執行端）。
// 內容只有 push 與 PR／MR 跑單一檢查入口（detect.mjs 的 check 訊號），node 鎖本機版本：同 ron-skills scripts/check-node-version.mjs，
// CI 的版本要等於跑 bin/check 的主版本。已有 CI 檔就不動，只回報它有沒有呼叫檢查入口。
// 用法：node ci.mjs <repo> [--dry-run]（測試以 DETECT_NODE_VERSION 取代 process.versions.node）
// stdout：既有 CI 檔每個一行 `CI_EXISTS <檔> calls|missing <入口>`；最後一行 `CI_WRITTEN <檔>`、`CI_PLANNED <檔>`（--dry-run，前面印內容）、
//   `CI_KEPT <檔...>`、`CI_SKIPPED local` 或 `GAP ci <原因>`（既有 CI 檔都沒呼叫入口，人決定怎麼補）。
// exit 0；沒有單一檢查入口、不是 git repo 或旗標錯誤時 exit 2，不寫檔。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CI_FILES, codeHost } from '../templates/lib/hosts.mjs';

/** 程式碼 host 會執行的 CI 設定檔（相對路徑）：GitHub 是 .github/workflows/*.yml|yaml，GitLab 是 .gitlab-ci.yml；別家的檔不會被跑，不算。 */
export function ciFiles(root, host) {
  if (host === 'gitlab') return existsSync(join(root, CI_FILES.gitlab)) ? [CI_FILES.gitlab] : [];
  const dir = join(root, CI_FILES.github);
  return existsSync(dir) && statSync(dir).isDirectory()
    ? readdirSync(dir).filter(file => /\.ya?ml$/.test(file)).sort().map(file => `${CI_FILES.github}${file}`) : [];
}

/** 比對 CI 檔用的入口：去掉選項之後的部分（`bin/check --upstream` 與 `bin/check` 都算呼叫了 `bin/check`）。 */
export function entryCommand(entry) {
  const words = entry.trim().split(/\s+/);
  const end = words.findIndex(word => word.startsWith('-'));
  return words.slice(0, end < 0 ? undefined : end).join(' ');
}

/** CI 檔去掉 YAML 註解（行首或空白之後的 `#` 到行尾）後的內容：只在註解提到檢查入口不算呼叫。 */
const withoutComments = text => text.replace(/(^|\s)#.*$/gm, '$1');

/**
 * CI 缺口：程式碼 host 是 local 時沒有遠端 CI，不算缺口；否則要有 CI 檔，而且至少一個呼叫單一檢查入口。
 * 回傳 `{ met, evidence, files: [{ file, calls }] }`；entry 為 null（還沒有檢查入口）時有 CI 檔也算缺口。
 */
export function ciGap(root, entry, host) {
  if (host === 'local') return { met: true, evidence: ['程式碼 host 是 local，沒有遠端 CI，只有本機執行端'], files: [] };
  const command = entry && entryCommand(entry);
  const files = ciFiles(root, host).map(file => ({ file, calls: Boolean(command) && withoutComments(readFileSync(join(root, file), 'utf8')).includes(command) }));
  if (!files.length) return { met: false, evidence: [`沒有 CI 檔（${CI_FILES[host]}）`], files };
  if (files.some(file => file.calls)) return { met: true, evidence: files.filter(file => file.calls).map(({ file }) => `${file} 呼叫 ${command}`), files };
  return { met: false, evidence: [`${files.map(({ file }) => file).join('、')} 沒有呼叫 ${command ?? '單一檢查入口'}`], files };
}

// 版本與 ron-skills 自己的 .github/workflows/checks.yml 相同（commit SHA 鎖定）。
const GITHUB = (entry, node) => `name: Checks

# /setup-workflow 寫的遠端 CI：push 與 pull_request 都跑單一檢查入口。
on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '${node}'
      - run: ${entry}
`;

// GitLab 預設只跑 branch pipeline；加上 merge_request_event 才有 MR pipeline，和 GitHub 的 push、pull_request 對應。
const GITLAB = (entry, node) => `# /setup-workflow 寫的遠端 CI：branch（push）與 merge request pipeline 都跑單一檢查入口。
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH

checks:
  image: node:${node}
  script:
    - ${entry}
`;

const TEMPLATES = { github: { file: `${CI_FILES.github}checks.yml`, content: GITHUB }, gitlab: { file: CI_FILES.gitlab, content: GITLAB } };

function main(args) {
  const fail = message => { console.error(`ci: ${message}`); return 2; };
  const unknown = args.filter(arg => arg.startsWith('--') && arg !== '--dry-run');
  if (unknown.length) return fail(`不認得的旗標：${unknown.join(' ')}`);
  const root = resolve(args.find(arg => !arg.startsWith('--')) ?? '.');
  const detected = spawnSync('node', [join(import.meta.dirname, 'detect.mjs'), root, '--json'], { encoding: 'utf8' });
  if (detected.status !== 0) return fail(`detect.mjs 失敗：${detected.stderr.trim()}`);
  const entry = JSON.parse(detected.stdout).signals.check.value;
  if (!entry) return fail('沒有單一檢查入口：先建好它（docs/workflow/03-level1.md 第 2 步），再寫 CI');

  const origin = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const host = codeHost(origin.status === 0 ? origin.stdout.trim() : null).value;
  if (host === 'local') { console.log('CI_SKIPPED local'); return 0; }
  const gap = ciGap(root, entry, host);
  for (const { file, calls } of gap.files) console.log(`CI_EXISTS ${file} ${calls ? 'calls' : 'missing'} ${entryCommand(entry)}`);
  if (gap.files.length) {
    console.log(gap.met ? `CI_KEPT ${gap.files.filter(file => file.calls).map(({ file }) => file).join(' ')}` : `GAP ci ${gap.evidence.join('; ')}`);
    return 0;
  }
  const { file, content } = TEMPLATES[host];
  const text = content(entry, process.env.DETECT_NODE_VERSION ?? process.versions.node);
  if (args.includes('--dry-run')) {
    process.stdout.write(text);
    console.log(`CI_PLANNED ${file}`);
    return 0;
  }
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  console.log(`CI_WRITTEN ${file}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
