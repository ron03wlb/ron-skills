#!/usr/bin/env node
// 本 repo 的 tracker 寫入：.claude/settings.json 只放行這支，auto mode 才不會把留言、關單擋成 External System Writes（#96）。
// 前綴規則 Bash(gh issue comment:*) 也放行 -R other/repo、Issue URL 與 -wR 這類短旗標串，所以這裡固定 repo、只收白名單旗標與數字 Issue 號碼。
// 用法：node scripts/gh-tracker.mjs comment <n> (--body|-b <text> | --body-file|-F <file>)
//       node scripts/gh-tracker.mjs close <n> [--comment|-c <text>] [--reason|-r <reason>]
//       node scripts/gh-tracker.mjs edit <n> [--title|-t、--body|-b、--body-file|-F、--add-label、--remove-label、--add-assignee、--remove-assignee <值>]...
//       node scripts/gh-tracker.mjs create --title|-t <title> (--body|-b | --body-file|-F) [--label|-l、--assignee|-a <值>]...
//       node scripts/gh-tracker.mjs sub-issue add|remove <parent> <child>
//       node scripts/gh-tracker.mjs blocked-by add|remove <n> <blocker>
// 不合規則時 exit 2、不呼叫 gh；其餘照 gh 的 exit code。
import { spawnSync } from 'node:child_process';

const REPO = 'ron03wlb/ron-skills';

// 每個子命令：Issue 號碼的個數，以及可用的旗標（都帶一個值）與它的短名。
const ISSUE = {
  comment: { numbers: 1, flags: { '--body': '-b', '--body-file': '-F' } },
  close: { numbers: 1, flags: { '--comment': '-c', '--reason': '-r' } },
  edit: { numbers: 1, flags: { '--title': '-t', '--body': '-b', '--body-file': '-F', '--add-label': null, '--remove-label': null, '--add-assignee': null, '--remove-assignee': null } },
  create: { numbers: 0, flags: { '--title': '-t', '--body': '-b', '--body-file': '-F', '--label': '-l', '--assignee': '-a' } },
};

// 本機 gh 2.92 還沒有 issue edit --add-sub-issue、--add-blocked-by，所以走 REST API；兩者都要對方的 database id，不是 #號碼。
const RELATION = {
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
const gh = args => {
  const result = spawnSync('gh', args, { stdio: 'inherit' });
  if (result.error) fail(`無法執行 gh：${result.error.message}`);
  process.exit(result.status ?? 1);
};

/** 依白名單拆出 Issue 號碼與旗標；旗標一律寫成 `--長名=值`（值以 - 開頭也不會被當成旗標），所以 gh 收到的參數裡不會出現白名單以外的旗標或位置參數。 */
function parse(args, { numbers, flags }) {
  const long = Object.fromEntries(Object.entries(flags).flatMap(([name, short]) => (short ? [[name, name], [short, name]] : [[name, name]])));
  const positional = [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const [key, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg];
    if (!long[key]) fail(`不接受的旗標：${arg}`);
    const value = inline ?? args[++i];
    if (value === undefined) fail(`${arg} 缺少值`);
    out.push(`${long[key]}=${value}`);
  }
  if (positional.length !== numbers || !positional.every(n => /^\d+$/.test(n))) fail(`要 ${numbers} 個 Issue 號碼（純數字），收到：${positional.join(' ') || '（無）'}`);
  return [...positional, ...out];
}

const [command, ...rest] = process.argv.slice(2);
if (ISSUE[command]) gh(['issue', command, ...parse(rest, ISSUE[command]), '--repo', REPO]);
if (!RELATION[command]) fail(`不支援的子命令：${command ?? '（空）'}`);
const [action, n, other, ...extra] = rest;
if (!Object.hasOwn(RELATION[command], action) || extra.length || ![n, other].every(arg => /^\d+$/.test(arg ?? ''))) fail(`用法：${command} add|remove <n> <m>（m、n 是純數字 Issue 號碼）`);
const lookup = spawnSync('gh', ['api', `repos/${REPO}/issues/${other}`, '--jq', '.id'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
if (lookup.error) fail(`無法執行 gh：${lookup.error.message}`);
if (lookup.status !== 0) process.exit(lookup.status ?? 1);
const id = lookup.stdout.trim();
if (!/^\d+$/.test(id)) fail(`#${other} 的 database id 不是數字：${id}`);
gh(['api', ...RELATION[command][action](n, id)]);
