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
//       node scripts/gh-tracker.mjs batch <file.json>
// sub-issue、blocked-by 一次可帶多個對象（ron-skills #201），每個成功的對象在 stdout 印一行 `SUB_ISSUE <add|remove> <parent> <child>` 或
// `BLOCKED_BY <add|remove> <n> <blocker>`，不印 API 回應（整份 issue JSON，#140）；某個對象失敗時照樣做完其餘的，最後以第一個失敗的 gh exit code 結束。
// batch（ron-skills #401）：<file.json> 是步驟陣列，依序執行，取代一次性的開單腳本。每步一個物件，`op` 決定可用欄位（其他欄位 exit 2）：
//   {"op":"create","code":"a","title":…,"body"|"bodyFile":…,"labels":[…],"assignees":[…],"parent":<ref>,"blockedBy":[<ref>…]}
//   {"op":"comment","issue":<ref>,"body"|"bodyFile":…}
//   {"op":"close","issue":<ref>,"comment":…,"reason":…}
//   {"op":"edit","issue":<ref>,"title"、"body"|"bodyFile"、"addLabels"、"removeLabels"、"addAssignees"、"removeAssignees"、"parent"、"blockedBy"}
// <ref> 是 "#<n>"，或同批前面某個 create 的 code（字母開頭）；bodyFile 相對於批次檔所在目錄，開跑前要存在。整份先驗過才呼叫 gh，不合規則 exit 2、不呼叫 gh。
// 每完成一步（開單、comment、close、edit，以及每個 parent、blocked-by 關係）就寫進旁邊的 <file.json>.state.json，含建立的單號；
// 重跑同一份檔時跳過已完成的步驟，只做剩下的（狀態檔記的步驟和檔案對不上時 exit 2）。某步失敗就停，以 gh 的 exit code 結束。
// stdout 每步一行：`CREATED <code|-> <n>`、`COMMENTED <n>`、`CLOSED <n>`、`EDITED <n>`、`SUB_ISSUE add <parent> <child>`、`BLOCKED_BY add <n> <blocker>`，
// 全部做完時最後一行 `BATCH_DONE <步驟數>`；重跑時已完成的步驟不印。
// 沒有子命令或子命令不認得時，把上面的用法印到 stderr、exit 2（#219）。
// 在 repo 根目錄執行：allow 規則比對的是 `node scripts/gh-tracker.mjs` 這個相對路徑。
// 不合規則時 exit 2、不呼叫 gh；gh 無法執行、或查到的 database id 不是數字時也 exit 2；其餘照 gh 的 exit code。主機也固定：不帶主機的 --repo 與 gh api 會用 gh config 的預設主機。
// gh 收到的環境也沒有 GH_HOST、GH_REPO。
// --body-file 照樣讀本機任何檔案，內容會公開貼到 Issue 上：只指向要貼的檔。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

// GitHub 主機上不是專案的網址：文件站、API、gist、raw 等子網域，以及 orgs、users 這類保留的第一段路徑（審查 #244）。
const NON_PROJECT_HOST = /^(?:docs|api|gist|raw|uploads|objects|codeload|status)\.|githubusercontent\.com$/;
const RESERVED_OWNERS = new Set(['orgs', 'users', 'settings', 'enterprises', 'apps', 'marketplace', 'features', 'topics', 'sponsors', 'notifications', 'search', 'login', 'about']);

/** adapter `## Tracker` 段裡唯一的 GitHub 專案：{ host, repo }；找不到或不唯一時 exit 2。 */
function trackerTarget() {
  const where = 'docs/agents/issue-run.md 的 ## Tracker 段';
  if (!existsSync(ADAPTER)) fail(`找不到 ${ADAPTER}：寫入目標要寫在 ${where}`);
  const lines = readFileSync(ADAPTER, 'utf8').split('\n');
  const start = lines.findIndex(line => /^## Tracker\s*$/.test(line));
  if (start < 0) fail(`adapter 沒有 ## Tracker 段：寫入目標要寫在 ${where}`);
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  const projects = new Map();
  for (const [match] of lines.slice(start + 1, end < 0 ? undefined : end).join('\n').matchAll(/https?:\/\/[^\s`'")<>]+/g)) {
    const url = match.replace(/[.,;:]+$/, '');
    const host = remoteHostname(url);
    if (!host || hostKind(host) !== 'github' || NON_PROJECT_HOST.test(host)) continue;
    const [owner, name] = new URL(url).pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (owner && name && !RESERVED_OWNERS.has(owner.toLowerCase())) projects.set(`${host}/${owner}/${name}`, { host, repo: `${owner}/${name}` });
  }
  if (projects.size !== 1) fail(`${where}要恰好有一個 GitHub 專案網址（https://<host>/<owner>/<repo>），找到 ${projects.size} 個：${[...projects.keys()].join(' ') || '（無）'}`);
  return [...projects.values()][0];
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

/** 對 #n 加或移除一個關係（先查 other 的 database id）；成功時印一行結果，回傳 exit code。 */
function relate(target, command, action, n, other) {
  const { host, repo } = target;
  const lookup = spawnGh(['api', '--hostname', host, `repos/${repo}/issues/${other}`, '--jq', '.id'], ['ignore', 'pipe', 'inherit']);
  const id = lookup.stdout?.trim();
  const status = lookup.status !== 0 ? lookup.status ?? 1
    : !isNumber(id) ? (console.error(`gh-tracker: #${other} 的 database id 不是數字：${id}`), 2)
    : spawnGh(['api', '--hostname', host, ...RELATION_COMMANDS[command][action](repo, n, id)], ['ignore', 'ignore', 'inherit']).status ?? 1;
  if (status === 0) console.log(`${command.replace('-', '_').toUpperCase()} ${action} ${n} ${other}`);
  else console.error(`gh-tracker: ${command} ${action} ${n} ${other} 失敗（exit ${status}）`);
  return status;
}

// batch 每個 op 的欄位：[欄位, 種類, gh 旗標]；種類 text 是字串、list 是字串陣列（旗標重複）、ref 是 <ref>、refs 是 <ref> 陣列（後兩者走關係 API，不是旗標）。
const BATCH_OPS = {
  create: { subject: 'code', fields: [['title', 'text', '--title'], ['body', 'text', '--body'], ['bodyFile', 'file', '--body-file'], ['labels', 'list', '--label'], ['assignees', 'list', '--assignee'], ['parent', 'ref'], ['blockedBy', 'refs']] },
  comment: { subject: 'issue', fields: [['body', 'text', '--body'], ['bodyFile', 'file', '--body-file']] },
  close: { subject: 'issue', fields: [['comment', 'text', '--comment'], ['reason', 'text', '--reason']] },
  edit: { subject: 'issue', fields: [['title', 'text', '--title'], ['body', 'text', '--body'], ['bodyFile', 'file', '--body-file'], ['addLabels', 'list', '--add-label'], ['removeLabels', 'list', '--remove-label'], ['addAssignees', 'list', '--add-assignee'], ['removeAssignees', 'list', '--remove-assignee'], ['parent', 'ref'], ['blockedBy', 'refs']] },
};
const BATCH_LINES = { create: 'CREATED', comment: 'COMMENTED', close: 'CLOSED', edit: 'EDITED' };
const CODE = /^[A-Za-z][\w.-]*$/;
const ISSUE_REF = /^#([1-9]\d*)$/;

/** 讀並驗整份批次檔；任何不合規則都 exit 2（還沒呼叫 gh）。回傳每步 { op, code?, issue?, flags, parent?, blockedBy, sig }。 */
function loadBatch(file) {
  const where = (i, message) => fail(`${file} 第 ${i + 1} 步：${message}`);
  if (!existsSync(file) || !statSync(file).isFile()) fail(`找不到批次檔：${file}`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { fail(`${file} 不是合法 JSON：${error.message}`); }
  if (!Array.isArray(raw) || !raw.length) fail(`${file} 要是非空的步驟陣列`);
  const codes = new Set();
  const isText = value => typeof value === 'string';
  return raw.map((step, i) => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) where(i, '要是物件');
    if (!Object.hasOwn(BATCH_OPS, step.op)) where(i, `不支援的 op：${JSON.stringify(step.op)}（${Object.keys(BATCH_OPS).join('、')}）`);
    const { subject, fields } = BATCH_OPS[step.op];
    const allowed = new Set(['op', subject, ...fields.map(([name]) => name)]);
    for (const key of Object.keys(step)) if (!allowed.has(key)) where(i, `${step.op} 不接受的欄位：${key}`);
    const ref = value => {
      if (!isText(value)) where(i, `引用要是 "#<n>" 或同批前面的 code，收到：${JSON.stringify(value)}`);
      if (ISSUE_REF.test(value) || codes.has(value)) return value;
      where(i, `引用要是 "#<n>" 或同批前面的 code，收到：${value}`);
    };
    const out = { op: step.op, flags: [], parent: undefined, blockedBy: [] };
    if (subject === 'code') {
      if (step.code !== undefined) {
        if (!isText(step.code) || !CODE.test(step.code)) where(i, `code 要字母開頭（英數、_、.、-），收到：${JSON.stringify(step.code)}`);
        if (codes.has(step.code)) where(i, `code 重複：${step.code}`);
        out.code = step.code;
      }
    } else {
      if (step.issue === undefined) where(i, `${step.op} 要有 issue`);
      out.issue = ref(step.issue);
    }
    if ('body' in step && 'bodyFile' in step) where(i, 'body 與 bodyFile 只能擇一');
    for (const [name, kind, flag] of fields) {
      if (!Object.hasOwn(step, name)) continue;
      const value = step[name];
      if (kind === 'text' && isText(value)) out.flags.push(`${flag}=${value}`);
      else if (kind === 'file' && isText(value)) {
        const path = resolve(dirname(file), value);
        if (!existsSync(path) || !statSync(path).isFile()) where(i, `找不到 ${name}：${value}`);
        out.flags.push(`${flag}=${path}`);
      } else if (kind === 'list' && Array.isArray(value) && value.every(isText)) out.flags.push(...value.map(item => `${flag}=${item}`));
      else if (kind === 'ref') out.parent = ref(value);
      else if (kind === 'refs' && Array.isArray(value)) out.blockedBy = value.map(ref);
      else where(i, `${name} 的型別不對：${JSON.stringify(value)}`);
    }
    if (step.op === 'create' && !isText(step.title)) where(i, 'create 要有 title');
    if ((step.op === 'create' || step.op === 'comment') && !('body' in step || 'bodyFile' in step)) where(i, `${step.op} 要有 body 或 bodyFile`);
    if (step.op === 'edit' && !out.flags.length && !out.parent && !out.blockedBy.length) where(i, 'edit 至少要改一項');
    if (out.code) codes.add(out.code);
    out.sig = `${i} ${out.op} ${out.code ?? out.issue ?? '-'}`;
    return out;
  });
}

function runBatch(args) {
  if (args.length !== 1 || args[0].startsWith('-')) fail('用法：batch <file.json>');
  const file = resolve(args[0]);
  const steps = loadBatch(file);
  const target = trackerTarget();
  const stateFile = `${file}.state.json`;
  const state = { created: {}, done: [] };
  if (existsSync(stateFile)) {
    let saved;
    try { saved = JSON.parse(readFileSync(stateFile, 'utf8')); } catch (error) { fail(`狀態檔 ${stateFile} 不是合法 JSON：${error.message}`); }
    if (!saved || typeof saved.created !== 'object' || !Array.isArray(saved.done) || !saved.done.every(key => typeof key === 'string')) fail(`狀態檔 ${stateFile} 格式不對（要有 created 物件與 done 字串陣列）`);
    // 單號會進 gh 的參數與 REST 路徑：狀態檔被改過時，非 create 步驟的鍵或不是正整數的值（路徑、網址、旗標）一律不收（審查 #401）。
    const forged = Object.entries(saved.created).find(([i, n]) => steps[i]?.op !== 'create' || !Number.isSafeInteger(n) || n < 1);
    if (Array.isArray(saved.created) || forged) fail(`狀態檔 ${stateFile} 的 created 要是 create 步驟索引對正整數單號，收到：${JSON.stringify(forged ?? saved.created)}`);
    Object.assign(state, { created: saved.created, done: saved.done });
    const stale = state.done.find(key => { const [i] = key.split(' '); return !steps[i] || !(key === steps[i].sig || key.startsWith(`${steps[i].sig} `)); });
    const missing = steps.find((step, i) => step.op === 'create' && saved.done.includes(step.sig) && !Object.hasOwn(saved.created, i));
    if (missing) fail(`狀態檔 ${stateFile} 記「${missing.sig}」已完成，卻沒有它建立的單號：先到 tracker 查出單號補進 created，或刪掉這筆 done 重建`);
    if (stale) fail(`狀態檔 ${stateFile} 記的步驟「${stale}」和批次檔對不上：批次檔在中斷後改過步驟順序或內容；改回原樣再跑，或刪掉狀態檔從頭來`);
  }
  const done = new Set(state.done);
  const save = key => { state.done.push(key); done.add(key); writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`); };
  const codeIndex = new Map(steps.flatMap((step, i) => (step.code ? [[step.code, i]] : [])));
  const number = ref => ISSUE_REF.exec(ref)?.[1] ?? String(state.created[codeIndex.get(ref)]);
  const stop = (key, status) => { console.error(`gh-tracker: batch 停在「${key}」，重跑同一份檔會從這裡接著做`); process.exit(status); };
  steps.forEach((step, i) => {
    if (!done.has(step.sig) && (step.op !== 'edit' || step.flags.length)) {
      const subject = step.op === 'create' ? [] : [number(step.issue)];
      const result = spawnGh(['issue', step.op, ...subject, ...step.flags, '--repo', `${target.host}/${target.repo}`], ['ignore', 'pipe', 'inherit']);
      if (result.status !== 0) { console.error(`gh-tracker: ${step.sig} 失敗（exit ${result.status ?? 1}）`); stop(step.sig, result.status ?? 1); }
      if (step.op === 'create') {
        const created = [...(result.stdout ?? '').matchAll(/\/issues\/([1-9]\d*)/g)].at(-1)?.[1];
        if (!created) { console.error(`gh-tracker: ${step.sig} 已執行，但讀不到新單號（gh 輸出：${result.stdout?.trim()}）；先到 tracker 確認有沒有建出來`); process.exit(2); }
        state.created[i] = Number(created);
        console.log(`CREATED ${step.code ?? '-'} ${created}`);
      } else console.log(`${BATCH_LINES[step.op]} ${subject[0]}`);
      save(step.sig);
    }
    const self = step.op === 'create' ? String(state.created[i]) : number(step.issue);
    if (step.parent && !done.has(`${step.sig} parent`)) {
      const status = relate(target, 'sub-issue', 'add', number(step.parent), self);
      if (status !== 0) stop(`${step.sig} parent`, status);
      save(`${step.sig} parent`);
    }
    for (const blocker of step.blockedBy) {
      const key = `${step.sig} blocked-by ${blocker}`;
      if (done.has(key)) continue;
      const status = relate(target, 'blocked-by', 'add', self, number(blocker));
      if (status !== 0) stop(key, status);
      save(key);
    }
  });
  console.log(`BATCH_DONE ${steps.length}`);
  process.exit(0);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'batch') runBatch(rest);
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
const target = trackerTarget();
let exitCode = 0;
for (const other of others) {
  const status = relate(target, command, action, n, other);
  exitCode ||= status;
}
process.exit(exitCode);
