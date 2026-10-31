#!/usr/bin/env node
// setup-workflow 正本：tracker 寫入 wrapper。.claude/settings.json 的 tracker 寫入只放行這支，auto mode 才不會把留言、關單擋成 External System Writes（ron-skills #96）。
// 前綴規則 Bash(gh issue comment:*) 也放行 -R other/repo、Issue URL 與 -wR 這類短旗標串，所以這裡只收白名單旗標與數字 Issue 號碼，寫入目標不從命令列來。
// 寫入目標（GitHub 主機與 <owner>/<repo>）讀本檔所在 scripts/ 的上一層 docs/agents/issue-run.md 的 `## Tracker` 段：段裡的 GitHub 專案網址
// （https://<host>/<owner>/<repo>，可帶 /issues/… 等後綴；github.com 或名稱含 github 的 GitHub Enterprise 主機）要恰好指向一個專案。
// 沒有這份檔、沒有這一段、段裡沒有或有兩個以上的專案時 exit 2、不呼叫 gh（ron-skills #244）。
// 用法：node scripts/gh-tracker.mjs comment <n> (--body|-b <text> | --body-file|-F <file>)
//       node scripts/gh-tracker.mjs close <n> [--comment|-c <text>] [--reason|-r <reason>]
//       node scripts/gh-tracker.mjs reopen <n> [--comment|-c <text>]
//       node scripts/gh-tracker.mjs edit <n> [--title|-t、--body|-b、--body-file|-F、--add-label、--remove-label、--add-assignee、--remove-assignee <值>]...
//       node scripts/gh-tracker.mjs create --title|-t <title> (--body|-b | --body-file|-F) [--label|-l、--assignee|-a <值>]...
//       node scripts/gh-tracker.mjs sub-issue add|remove <parent> <child>...
//       node scripts/gh-tracker.mjs blocked-by add|remove <n> <blocker>...
// sub-issue、blocked-by 一次可帶多個對象（ron-skills #201），每個成功的對象在 stdout 印一行 `SUB_ISSUE <add|remove> <parent> <child>` 或
// `BLOCKED_BY <add|remove> <n> <blocker>`，不印 API 回應（整份 issue JSON，#140）；某個對象失敗時照樣做完其餘的，最後以第一個失敗的 gh exit code 結束。
// 沒有子命令或子命令不認得時，把上面的用法印到 stderr、exit 2（#219）。
// 在 repo 根目錄執行：allow 規則比對的是 `node scripts/gh-tracker.mjs` 這個相對路徑。
// 不合規則時 exit 2、不呼叫 gh；gh 無法執行、或查到的 database id 不是數字時也 exit 2；其餘照 gh 的 exit code。主機也固定：不帶主機的 --repo 與 gh api 會用 gh config 的預設主機。
// gh 收到的環境也沒有 GH_HOST、GH_REPO。
// --body-file 照樣讀本機任何檔案，內容會公開貼到 Issue 上：只指向要貼的檔。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hostKind, remoteHostname } from './lib/hosts.mjs';

const ADAPTER = fileURLToPath(new URL('../docs/agents/issue-run.md', import.meta.url));

// 每個子命令：Issue 號碼的個數，以及可用的旗標（都帶一個值）與它的短名。
const ISSUE_COMMANDS = {
  comment: { numbers: 1, flags: { '--body': '-b', '--body-file': '-F' } },
  close: { numbers: 1, flags: { '--comment': '-c', '--reason': '-r' } },
  reopen: { numbers: 1, flags: { '--comment': '-c' } },
  edit: { numbers: 1, flags: { '--title': '-t', '--body': '-b', '--body-file': '-F', '--add-label': null, '--remove-label': null, '--add-assignee': null, '--remove-assignee': null } },
  create: { numbers: 0, flags: { '--title': '-t', '--body': '-b', '--body-file': '-F', '--label': '-l', '--assignee': '-a' } },
};

// 本機 gh 2.92 還沒有 issue edit --add-sub-issue、--add-blocked-by，所以走 REST API；兩者都要對方的 database id，不是 #號碼。
const RELATION_COMMANDS = {
  'sub-issue': {
    add: (repo, n, id) => ['--method', 'POST', `repos/${repo}/issues/${n}/sub_issues`, '-F', `sub_issue_id=${id}`],
    remove: (repo, n, id) => ['--method', 'DELETE', `repos/${repo}/issues/${n}/sub_issue`, '-F', `sub_issue_id=${id}`],
  },
  'blocked-by': {
    add: (repo, n, id) => ['--method', 'POST', `repos/${repo}/issues/${n}/dependencies/blocked_by`, '-F', `issue_id=${id}`],
    remove: (repo, n, id) => ['--method', 'DELETE', `repos/${repo}/issues/${n}/dependencies/blocked_by/${id}`],
  },
};

const fail = message => { console.error(`gh-tracker: ${message}`); process.exit(2); };
const isNumber = arg => /^[1-9]\d*$/.test(arg ?? '');
const { GH_HOST, GH_REPO, ...env } = process.env;
const spawnGh = (args, stdio) => {
  const result = spawnSync('gh', args, { stdio, env, encoding: 'utf8' });
  if (result.error) fail(`無法執行 gh：${result.error.message}`);
  return result;
};
const gh = args => process.exit(spawnGh(args, 'inherit').status ?? 1);

/** adapter `## Tracker` 段裡唯一的 GitHub 專案：{ host, repo }；找不到或不唯一時 exit 2。 */
function trackerTarget() {
  const where = 'docs/agents/issue-run.md 的 ## Tracker 段';
  if (!existsSync(ADAPTER)) fail(`找不到 ${ADAPTER}：寫入目標要寫在 ${where}`);
  const lines = readFileSync(ADAPTER, 'utf8').split('\n');
  const start = lines.findIndex(line => /^## Tracker\s*$/.test(line));
  if (start < 0) fail(`adapter 沒有 ## Tracker 段：寫入目標要寫在 ${where}`);
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  const projects = new Set();
  for (const [match] of lines.slice(start + 1, end < 0 ? undefined : end).join('\n').matchAll(/https?:\/\/[^\s`'")<>]+/g)) {
    const url = match.replace(/[.,;:]+$/, '');
    const host = remoteHostname(url);
    if (!host || hostKind(host) !== 'github') continue;
    const [owner, name] = new URL(url).pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (owner && name) projects.add(`${host}/${owner}/${name}`);
  }
  if (projects.size !== 1) fail(`${where}要恰好有一個 GitHub 專案網址（https://<host>/<owner>/<repo>），找到 ${projects.size} 個：${[...projects].join(' ') || '（無）'}`);
  const [project] = projects;
  const [host, ...repo] = project.split('/');
  return { host, repo: repo.join('/') };
}

/** 依白名單拆出 Issue 號碼與旗標；旗標一律寫成 `--長名=值`（值以 - 開頭也不會被當成旗標），所以 gh 收到的參數裡不會出現白名單以外的旗標或位置參數。 */
function parse(args, { numbers, flags }) {
  const canonical = Object.fromEntries(Object.entries(flags).flatMap(([name, short]) => (short ? [[name, name], [short, name]] : [[name, name]])));
  const positional = [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const [key, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg];
    if (!Object.hasOwn(canonical, key)) fail(`不接受的旗標：${arg}`);
    const value = inline ?? args[++i];
    if (value === undefined) fail(`${arg} 缺少值`);
    out.push(`${canonical[key]}=${value}`);
  }
  if (positional.length !== numbers || !positional.every(isNumber)) fail(`要 ${numbers} 個 Issue 號碼（純數字），收到：${positional.join(' ') || '（無）'}`);
  return [...positional, ...out];
}

const [command, ...rest] = process.argv.slice(2);
if (Object.hasOwn(ISSUE_COMMANDS, command)) {
  const args = parse(rest, ISSUE_COMMANDS[command]);
  const { host, repo } = trackerTarget();
  gh(['issue', command, ...args, '--repo', `${host}/${repo}`]);
}
if (!Object.hasOwn(RELATION_COMMANDS, command)) {
  const usage = readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(line => /^\/\/ (用法：|\s+node )/.test(line)).map(line => line.slice(3));
  fail(`不支援的子命令：${command ?? '（空）'}\n${usage.join('\n')}`);
}
const [action, n, ...others] = rest;
if (!Object.hasOwn(RELATION_COMMANDS[command], action) || !others.length || ![n, ...others].every(isNumber)) fail(`用法：${command} add|remove <n> <m>...（m、n 是純數字 Issue 號碼）`);
const { host, repo } = trackerTarget();
let exitCode = 0;
for (const other of others) {
  const lookup = spawnGh(['api', '--hostname', host, `repos/${repo}/issues/${other}`, '--jq', '.id'], ['ignore', 'pipe', 'inherit']);
  const id = lookup.stdout?.trim();
  const status = lookup.status !== 0 ? lookup.status ?? 1
    : !isNumber(id) ? (console.error(`gh-tracker: #${other} 的 database id 不是數字：${id}`), 2)
    : spawnGh(['api', '--hostname', host, ...RELATION_COMMANDS[command][action](repo, n, id)], ['ignore', 'ignore', 'inherit']).status ?? 1;
  if (status === 0) console.log(`${command.replace('-', '_').toUpperCase()} ${action} ${n} ${other}`);
  else { console.error(`gh-tracker: ${command} ${action} ${n} ${other} 失敗（exit ${status}）`); exitCode ||= status; }
}
process.exit(exitCode);
