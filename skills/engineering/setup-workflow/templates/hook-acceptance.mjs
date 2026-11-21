#!/usr/bin/env node
// 以真實 `.claude/settings.json` 驗收 hook：照設定的 matcher 找出每個工具呼叫會觸發的 hook 指令（含參數），餵 Claude Code 同形狀的 stdin JSON，核對 exit code。
// spay2 retro 8eaa8b41#2：新參數的 PreToolUse hook 落地後，使用者用 `!` 與終端機都測不到（PreToolUse 只攔 Claude 的工具呼叫），白跑兩次才改開新 session。
// check-claude-settings 只查 permissions 規則格式，各 hook 的測試直接帶自己的參數跑，兩者都驗不到「settings.json 真的帶了這些參數」。
// 本腳本只驗到 hook 的判斷；權限提示這類只有人看得到的行為，仍由 settings 生效後開的 Claude session 驗收。
//
// 用法：node scripts/hook-acceptance.mjs [--project-dir <dir>] [--settings <path>] [--cases <path>]
//   project dir 預設 $CLAUDE_PROJECT_DIR，再來是 cwd 的 git toplevel；hook 指令裡的 $CLAUDE_PROJECT_DIR 指向它，hook 的 cwd 也是它。
//   settings 預設 <project dir>/.claude/settings.json；cases 預設 <project dir>/scripts/hook-acceptance-cases.json。
// 案例檔：JSON 陣列，每項 `{ "event", "expected", "label" }`，加上選填的 `"tool"`＋`"input"`、`"stdin"`、`"env"`（expected 是預期的彙總 exit code，擋下記 2）。
//   tool、input：工具事件（PreToolUse、PostToolUse…）的 tool_name 與 tool_input，兩個一起給；matcher 比對 tool。不帶 tool 的事件（UserPromptSubmit、Stop）兩個都不給。
//   stdin：併入 hook stdin JSON 頂層的欄位，例如 UserPromptSubmit 的 `prompt`、Stop 的 `transcript_path` 與 `stop_hook_active`。
//   env：字串值的物件，併入 hook 的環境變數：依環境啟用的 hook（例如只在 `$SHELL` 是 zsh 時擋）固定環境，結果才不隨機器而變。
//   input 與 stdin 字串值裡的 `<main>` 換成主 checkout 路徑（git common dir 的上一層；不是 git repo 時是 project dir），`<project>` 換成 project dir
//   （例如 repo 裡的 transcript 樣本）。每支 hook 至少一個案例；新的 hook 或參數上線時在案例檔加真實案例。
// 多支 hook 命中同一呼叫時，任一支擋下就算擋下（Claude Code 的語意），否則取最大的 exit code。擋下有兩種形式，都記為 actual=2：
//   exit 2；或 exit 0 且 stdout 是 JSON、`hookSpecificOutput.permissionDecision` 為 `deny`。
//   `ask`／`allow` 不算擋下（ask 交給使用者確認、不是 hook 擋下），exit 非 0 時 Claude Code 不解析 stdout JSON，這裡也不解析。
// stdout：每個案例一行 `PASS|FAIL <event> <tool 或 -> expected=<n> actual=<n> <label>`（FAIL 時下一行縮排附擋下或失敗那支 hook 的 stderr 末行；JSON deny 附 permissionDecisionReason），
//   最後一行 `HOOK_ACCEPTANCE PASS <n>` 或 `HOOK_ACCEPTANCE FAIL <k>/<n>`。
// exit：0 全過；1 有案例不符；2 用法錯誤，或讀不到 settings、案例檔（案例檔格式錯也是）。
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = '用法：node scripts/hook-acceptance.mjs [--project-dir <dir>] [--settings <path>] [--cases <path>]';

/** 把值裡每個字串的 `<main>`、`<project>` 換掉；物件與陣列遞迴處理，其他型別原樣回傳。 */
const substitute = (value, paths) => typeof value === 'string' ? value.replaceAll('<main>', paths.main).replaceAll('<project>', paths.project)
  : Array.isArray(value) ? value.map(item => substitute(item, paths))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, paths)]))
  : value;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 讀案例檔並把 input、stdin 的 `<main>`、`<project>` 換成路徑；格式不符時丟出帶案例序號的錯誤。
 * @param {string} file 案例檔路徑
 * @param {string} main 主 checkout 路徑
 * @param {string} [project] project dir（預設同 main）
 */
export function loadCases(file, main, project = main) {
  const cases = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(cases)) throw new Error(`${file}：案例檔要是 JSON 陣列`);
  return cases.map((item, index) => {
    const fail = message => { throw new Error(`${file} 第 ${index + 1} 個案例：${message}`); };
    for (const key of ['event', 'label']) if (typeof item?.[key] !== 'string' || !item[key]) fail(`${key} 要是非空字串`);
    if ((item.tool === undefined) !== (item.input === undefined)) fail('input 要和 tool 一起給（不帶 tool 的事件兩個都不給）');
    if (item.tool !== undefined && (typeof item.tool !== 'string' || !item.tool)) fail('tool 要是非空字串');
    if (item.input !== undefined && !isObject(item.input)) fail('input 要是物件');
    if (item.stdin !== undefined && !isObject(item.stdin)) fail('stdin 要是物件');
    if (!Number.isInteger(item.expected)) fail('expected 要是整數');
    if (item.env !== undefined && (!isObject(item.env) || Object.values(item.env).some(value => typeof value !== 'string'))) fail('env 要是字串值的物件');
    const paths = { main, project };
    return { ...item, input: substitute(item.input, paths), stdin: substitute(item.stdin, paths) };
  });
}

/** 這個事件與工具會觸發的 hook 指令，依 settings 的順序；matcher 是整串比對的 regex，沒有 matcher 與 `*` 都是全部。 */
export function hookCommands(settings, event, tool) {
  return (settings.hooks?.[event] ?? [])
    .filter(({ matcher }) => !matcher || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(tool))
    .flatMap(({ hooks }) => hooks ?? []).filter(hook => hook.type === 'command').map(hook => hook.command);
}

/** exit 0 的 hook stdout 是 PreToolUse JSON 時取 permissionDecision；不是 JSON 或沒有該欄位時 null。 */
export function permissionDecision(stdout) {
  try { return JSON.parse(stdout)?.hookSpecificOutput?.permissionDecision ?? null; } catch { return null; }
}

/** 跑一個案例：回傳彙總的 exit code（擋下記為 2）與每支 hook 的結果。 */
export function runCase(settings, projectDir, { event, tool, input, stdin: extra = {}, env = {} }) {
  const stdin = JSON.stringify({ hook_event_name: event, ...(tool === undefined ? {} : { tool_name: tool, tool_input: input }), cwd: projectDir, ...extra });
  const results = hookCommands(settings, event, tool).map(command => {
    const result = spawnSync('sh', ['-c', command], { cwd: projectDir, input: stdin, encoding: 'utf8', env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: projectDir } });
    const status = result.status ?? 1;
    const stdout = result.stdout ?? '';
    // Claude Code 只在 exit 0 時解析 stdout JSON
    const decision = status === 0 ? permissionDecision(stdout) : null;
    return { command, status, stdout, stderr: result.stderr ?? '', decision, blocked: status === 2 || decision === 'deny' };
  });
  const statuses = results.map(result => result.status);
  return { exit: results.some(result => result.blocked) ? 2 : Math.max(0, ...statuses), results };
}

const gitOutput = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const known = new Set(['--project-dir', '--settings', '--cases']);
  const invalid = args.length % 2 || args.some((arg, i) => i % 2 === 0 && !known.has(arg));
  if (invalid) { console.error(USAGE); process.exit(2); }
  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const projectDir = resolve(value('--project-dir') ?? process.env.CLAUDE_PROJECT_DIR ?? gitOutput(process.cwd(), 'rev-parse', '--show-toplevel') ?? '.');
  const common = gitOutput(projectDir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  let settings;
  let all;
  try {
    settings = JSON.parse(readFileSync(value('--settings') ?? join(projectDir, '.claude/settings.json'), 'utf8'));
    all = loadCases(value('--cases') ?? join(projectDir, 'scripts/hook-acceptance-cases.json'), common ? dirname(common) : projectDir, projectDir);
  } catch (error) {
    console.error(`hook-acceptance: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  let failed = 0;
  for (const item of all) {
    const { exit, results } = runCase(settings, projectDir, item);
    const pass = exit === item.expected;
    if (!pass) failed += 1;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${item.event} ${item.tool ?? '-'} expected=${item.expected} actual=${exit} ${item.label}`);
    const culprit = results.find(result => result.blocked) ?? results.find(result => result.status !== 0);
    const noted = culprit?.decision === 'deny'
      ? JSON.parse(culprit.stdout).hookSpecificOutput.permissionDecisionReason
      : culprit?.stderr.trim().split('\n').pop();
    if (!pass && noted) console.log(`  ${noted}`);
  }
  console.log(failed ? `HOOK_ACCEPTANCE FAIL ${failed}/${all.length}` : `HOOK_ACCEPTANCE PASS ${all.length}`);
  process.exit(failed ? 1 : 0);
}
