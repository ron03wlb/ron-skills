#!/usr/bin/env node
// 本 repo 的 tracker 寫入：.claude/settings.json 的 tracker 寫入只放行這支，auto mode 才不會把留言、關單擋成 External System Writes（#96）。
// 前綴規則 Bash(gh issue comment:*) 也放行 -R other/repo、Issue URL 與 -wR 這類短旗標串，所以這裡固定 repo、只收白名單旗標與數字 Issue 號碼。
// 用法：node scripts/gh-tracker.mjs comment <n> (--body|-b <text> | --body-file|-F <file>)
//       node scripts/gh-tracker.mjs close <n> [--comment|-c <text>] [--reason|-r <reason>]
//       node scripts/gh-tracker.mjs edit <n> [--title|-t、--body|-b、--body-file|-F、--add-label、--remove-label、--add-assignee、--remove-assignee <值>]...
//       node scripts/gh-tracker.mjs create --title|-t <title> (--body|-b | --body-file|-F) [--label|-l、--assignee|-a <值>]...
//       node scripts/gh-tracker.mjs sub-issue add|remove <parent> <child>
//       node scripts/gh-tracker.mjs blocked-by add|remove <n> <blocker>
// sub-issue、blocked-by 成功時 stdout 只印一行 `SUB_ISSUE <add|remove> <parent> <child>` 或 `BLOCKED_BY <add|remove> <n> <blocker>`，不印 API 回應（整份 issue JSON，#140）。
// 在 repo 根目錄執行：allow 規則比對的是 `node scripts/gh-tracker.mjs` 這個相對路徑。
// 不合規則時 exit 2、不呼叫 gh；gh 無法執行、或查到的 database id 不是數字時也 exit 2；其餘照 gh 的 exit code。主機也要寫死：不帶主機的 --repo 與 gh api 會用 gh config 的預設主機，不一定是 github.com。
// gh 收到的環境也沒有 GH_HOST、GH_REPO。
// --body-file 照樣讀本機任何檔案，內容會公開貼到 Issue 上：只指向要貼的檔。
import { spawnSync } from 'node:child_process';

const HOST = 'github.com';
const REPO = 'ron03wlb/ron-skills';

// 每個子命令：Issue 號碼的個數，以及可用的旗標（都帶一個值）與它的短名。
const ISSUE_COMMANDS = {
  comment: { numbers: 1, flags: { '--body': '-b', '--body-file': '-F' } },
  close: { numbers: 1, flags: { '--comment': '-c', '--reason': '-r' } },
  edit: { numbers: 1, flags: { '--title': '-t', '--body': '-b', '--body-file': '-F', '--add-label': null, '--remove-label': null, '--add-assignee': null, '--remove-assignee': null } },
  create: { numbers: 0, flags: { '--title': '-t', '--body': '-b', '--body-file': '-F', '--label': '-l', '--assignee': '-a' } },
};

// 本機 gh 2.92 還沒有 issue edit --add-sub-issue、--add-blocked-by，所以走 REST API；兩者都要對方的 database id，不是 #號碼。
const RELATION_COMMANDS = {
  'sub-issue': {
    add: (n, id) => ['--method', 'POST', `repos/${REPO}/issues/${n}/sub_issues`, '-F', `sub_issue_id=${id}`],
    remove: (n, id) => ['--method', 'DELETE', `repos/${REPO}/issues/${n}/sub_issue`, '-F', `sub_issue_id=${id}`],
  },
  'blocked-by': {
    add: (n, id) => ['--method', 'POST', `repos/${REPO}/issues/${n}/dependencies/blocked_by`, '-F', `issue_id=${id}`],
    remove: (n, id) => ['--method', 'DELETE', `repos/${REPO}/issues/${n}/dependencies/blocked_by/${id}`],
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
if (Object.hasOwn(ISSUE_COMMANDS, command)) gh(['issue', command, ...parse(rest, ISSUE_COMMANDS[command]), '--repo', `${HOST}/${REPO}`]);
if (!Object.hasOwn(RELATION_COMMANDS, command)) fail(`不支援的子命令：${command ?? '（空）'}`);
const [action, n, other, ...extra] = rest;
if (!Object.hasOwn(RELATION_COMMANDS[command], action) || extra.length || ![n, other].every(isNumber)) fail(`用法：${command} add|remove <n> <m>（m、n 是純數字 Issue 號碼）`);
const lookup = spawnGh(['api', '--hostname', HOST, `repos/${REPO}/issues/${other}`, '--jq', '.id'], ['ignore', 'pipe', 'inherit']);
if (lookup.status !== 0) process.exit(lookup.status ?? 1);
const id = lookup.stdout.trim();
if (!isNumber(id)) fail(`#${other} 的 database id 不是數字：${id}`);
const relation = spawnGh(['api', '--hostname', HOST, ...RELATION_COMMANDS[command][action](n, id)], ['ignore', 'ignore', 'inherit']);
if (relation.status !== 0) process.exit(relation.status ?? 1);
console.log(`${command.replace('-', '_').toUpperCase()} ${action} ${n} ${other}`);
