// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// hook 測試的子行程一律帶逾時，加上一份 shell 形狀語料跑過每個切字的 export（ron-skills #687-1）：
// claude-hook-git-bypass 的前綴掃描寫成 `assigns ||= /^\w+=/.test(words[at++])`，第一個 `VAR=` 之後短路、`at++` 不再執行，
// `LC_ALL=C LANG=C git status` 讓 hook 無窮迴圈；測試的 hook() 沒有 timeout，88 個測試全綠，只有 reviewer 抓到（#548 commit 3dae65e）。
// spawnHook：spawnSync 帶 HOOK_TIMEOUT_MS，逾時丟出寫明指令的錯誤（測試失敗而不是掛住，也不是 `null !== 0` 這種看不懂的斷言）。
// unfinishedExports：每個 export 開一個子行程跑過整份語料，逾時的回報「<export> 卡在 <形狀>」。
// unfinishedHookRuns：整支 hook 以每個形狀當 Bash 指令跑一次，回報逾時的形狀。
import { execFile, spawnSync } from 'node:child_process';

export const HOOK_TIMEOUT_MS = 10_000;

/** shell 形狀語料：多個 `VAR=` 前綴、LEADING_WORD、`time`、`!`、`env`、子 shell、管線、here-doc、沒收尾的引號與只有關鍵字的指令。 */
export const SHELL_SHAPES = [
  '',
  ' ',
  'LC_ALL=C LANG=C git status',
  'A=1 B=2 C=3 echo x',
  'A=1 B=2 C=3 D=4 E=5 F=6 git checkout abc1234',
  'A=1',
  'A=1 B=2',
  'A=1 B=2 grep -n -o \'.\\{0,80\\}x.\\{0,80\\}\' f.md',
  'A=1 B=2 git commit --no-verify -m x',
  'A=1 B=2 git -C . checkout --detach develop',
  'A=1 B=2 node scripts/job-watch.mjs | tail -1',
  'A=1 B=2 node scripts/batch-merge.mjs restage 1 2>&1 | tail -n 25; echo "x $?"',
  'time git status',
  'time A=1 B=2 git status',
  'time time time git status',
  '! git diff --quiet',
  '! ! A=1 B=2 git diff --quiet',
  '!',
  'time',
  'if',
  'then',
  'do then else elif if while until { ! time',
  'if A=1 B=2 git diff --quiet; then git checkout abc1234; elif true; then :; else :; fi',
  'while A=1 B=2 true; do sleep 1; done',
  'until ! pgrep -f "x y" >/dev/null; do sleep 1; done',
  'for f in *.md; do A=1 B=2 echo "$f"; done',
  'select x in a b; do break; done',
  'case x in a) A=1 B=2 echo a;; *) :;; esac',
  'function f { A=1 B=2 git status; }',
  'f() { A=1 B=2 git status; }',
  '{ A=1 B=2 git status; }',
  '{',
  '}',
  'env A=1 B=2 git status',
  'env -i A=1 B=2 git commit --no-verify',
  'command A=1 git status',
  'nohup A=1 B=2 git status &',
  '(cd /tmp && A=1 B=2 git status)',
  '((x++)); [[ -n x ]] && A=1 B=2 git status',
  'echo $(A=1 B=2 git rev-parse HEAD) `A=1 B=2 git status`',
  'echo $((1 + 2)) ${x:-y} ${x:h} $pipestatus',
  'git log | head -5',
  'A=1 B=2 bin/check | tail -1',
  'A=1 B=2 bin/check 2>&1 | grep -E x | tail -1',
  'a && b || c; d & e | f |& g',
  ';;',
  '&&',
  '|',
  '&',
  '( )',
  'git',
  'git -C',
  'git -c',
  'git checkout',
  'git checkout --',
  'git switch --detach',
  'git commit -m',
  'git commit -F',
  'grep',
  'grep -e',
  'grep -o',
  'echo =foo ==x x=y --opt=z',
  'for f in *.nomatch; do :; done; ls *.nomatch',
  'cat <<EOF\nA=1 B=2 git status\nEOF\nA=1 B=2 git status',
  "cat <<'EOF'\nx\nEOF",
  'cat <<-EOF\n\tx\n\tEOF',
  'cat <<EOF\nno end',
  'cat <<',
  'cat <<< "A=1 B=2"',
  'git commit -F - <<EOF\n# subject\nEOF',
  'echo \'unterminated',
  'echo "unterminated',
  'echo `unterminated',
  'echo $(unterminated',
  'echo \\',
  'echo x \\\n  A=1 B=2 git status',
  '# A=1 B=2 git status',
  'echo x # A=1 B=2',
  'echo x > out 2>&1 &>/dev/null >&2 < in',
  '>',
  '2>',
  '<<<',
  'orca terminal rename --terminal "$ORCA_TERMINAL_HANDLE" --title "x"',
  'gh issue view 1 --comments',
  `${'A=1 '.repeat(50)}git status`,
  `${'if '.repeat(50)}git status`,
  `${'! '.repeat(50)}git status`,
  `${'( '.repeat(50)}git status`,
  `${'"'.repeat(51)}`,
  `${"'".repeat(51)}`,
  `${'\\'.repeat(51)}`,
];

/**
 * spawnSync 加上逾時；逾時時丟出寫明指令與 stdin 開頭的錯誤。
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [options] 可帶 timeout 覆寫 HOOK_TIMEOUT_MS
 */
export function spawnHook(command, args, options = {}) {
  const timeout = options.timeout ?? HOOK_TIMEOUT_MS;
  const result = spawnSync(command, args, { killSignal: 'SIGKILL', ...options, timeout });
  if (result.error?.code === 'ETIMEDOUT') {
    const input = String(options.input ?? '').slice(0, 300);
    throw new Error(`hook 子行程 ${timeout}ms 內沒有結束（多半是切字迴圈不前進）：${[command, ...args].join(' ')}\nstdin：${input}`);
  }
  return result;
}

const CHILD = `
import { writeSync } from 'node:fs';
const { url, name, extra, shapes } = JSON.parse(process.env.HOOK_SHAPES_JOB);
const fn = (await import(url))[name];
if (typeof fn !== 'function') { process.stderr.write('不是函式：' + name); process.exit(3); }
for (let i = 0; i < shapes.length; i++) {
  writeSync(1, i + '\\n');
  try { await fn(shapes[i], ...extra); } catch { /* 只量會不會結束，丟錯不算 */ }
}
writeSync(1, 'done\\n');
`;

/**
 * 每個 export 各開一個子行程，以語料的每個形狀當第一個參數呼叫一次；沒在逾時內跑完的回報卡住的形狀。
 * @param {string|URL} moduleUrl 被測模組的 file URL
 * @param {Record<string, unknown[]>} calls export 名稱 → 形狀之後的其他參數（JSON 可序列化）
 * @param {{timeout?: number, shapes?: string[], cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string[]} 每個沒結束或失敗的 export 一行
 */
export function unfinishedExports(moduleUrl, calls, { timeout = HOOK_TIMEOUT_MS, shapes = SHELL_SHAPES, cwd, env = process.env } = {}) {
  const failures = [];
  for (const [name, extra] of Object.entries(calls)) {
    const job = JSON.stringify({ url: String(moduleUrl), name, extra, shapes });
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
      cwd, env: { ...env, HOOK_SHAPES_JOB: job }, encoding: 'utf8', timeout, killSignal: 'SIGKILL',
    });
    const last = result.stdout?.trim().split('\n').at(-1);
    if (result.error?.code === 'ETIMEDOUT') failures.push(`${name} ${timeout}ms 內沒有結束，卡在 ${JSON.stringify(shapes[Number(last)])}`);
    else if (result.status !== 0 || last !== 'done') failures.push(`${name} exit ${result.status}：${result.stderr?.trim()}`);
  }
  return failures;
}

/**
 * 整支 hook 以每個形狀當 Bash 指令各跑一次（同時最多 8 個），回報逾時的形狀。
 * @param {string} script hook 路徑
 * @param {{input?: (command: string) => object, args?: string[], timeout?: number, shapes?: string[], cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string[]>} 每個逾時的形狀一行
 */
export async function unfinishedHookRuns(script, { input = command => ({ tool_name: 'Bash', tool_input: { command } }), args = [], timeout = HOOK_TIMEOUT_MS, shapes = SHELL_SHAPES, cwd, env = process.env } = {}) {
  const failures = [];
  const queue = shapes.map((shape, i) => [shape, i]);
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [shape] = next;
      const timedOut = await new Promise(resolve => {
        const child = execFile(process.execPath, [script, ...args], { cwd, env, timeout, killSignal: 'SIGKILL' }, error => resolve(Boolean(error?.killed)));
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(input(shape)));
      });
      if (timedOut) failures.push(`${timeout}ms 內沒有結束：${JSON.stringify(shape)}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return failures;
}
