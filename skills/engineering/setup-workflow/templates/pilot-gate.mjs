#!/usr/bin/env node
// pilot 的人工 gate（PILOT-STORE.md 的 `.scratch/pilot/gates.md`）：開、解、列出 gate，coordinator 不手改檔案（手寫曾把 resolved 寫進別的欄位，probe 才有 GATE_MALFORMED）。
// 用法：node scripts/pilot-gate.mjs <checkout> open --title <text> --issue <text> --question <text> --options <text> --default <text> --parked <text> [--script <file>]
//       node scripts/pilot-gate.mjs <checkout> resolve <G<n>> --how <text>
//       node scripts/pilot-gate.mjs <checkout> list
// stdout：open 以表格與段落中最大的 G<n> 加一為 id，附加 `## G<n> <title>` 段落（六個欄位，`- opened：<time>`），檔案不存在或是空的就先寫 `# Gates`；印 `GATE_OPENED G<n>`。
//   帶 --script 時把 <file> 的步驟包成 `.scratch/pilot/gates/G<n>.sh`（bash 與 zsh 共通語法，Operator 以 `! bash <path>` 或 `! zsh <path>` 在任何目錄執行，都先 cd 到 checkout 根目錄），
//   段落在 opened 前多一個 `- script：<path>` 欄位，`GATE_OPENED` 前先印 `GATE_SCRIPT <path>`。腳本開頭 `set -e`、pipefail、`trap … ERR`：
//   任一步回非零時 stderr 印 `停止：第 <行> 行失敗（步驟：<最後一個 step 的說明>）`（investing G16：裸 `set -e` 遇查詢指令回非零時什麼都沒印就結束，#325、#371）；
//   question 欄尾端自動補上 ` 執行：! bash <path>`（開 gate 前還不知道 G<n>）；同一路徑留著的舊 `G<n>.done` 先刪掉。
//   步驟本體每步先 `step <說明>`（印 `▶ <說明>`），只讀狀態的查詢寫成 `x="$(<指令>)" || true` 再自己判斷輸出，改狀態的步驟先查狀態、已做過就跳過，中途失敗重跑才不會重做。跑完寫 `G<n>.done`（以 checkout 的絕對路徑，本體 cd 到別處也一樣）、印 `GATE_SCRIPT_DONE G<n>`；
//   之後再跑只印 `GATE_SCRIPT_DONE G<n> <完成時間> 已執行完成…`、exit 0，不重做步驟；中途失敗沒有標記，重跑從頭執行。
//   resolve 在該段落最後一個 `- ` 欄位之後插入 `- resolved <time> <how>`（表格列則把 status 欄換成 `resolved <time> <how>`），印 `GATE_RESOLVED G<n>`；
//   gate 已 resolved 印 `STOP G<n> resolved`、找不到印 `STOP G<n> missing`，都不改檔。
//   list 印開著的 gate，與 pilot-probe 的 `GATE …`、`GATE_MALFORMED <id> <行>` 相同（沒有就不輸出）。
// exit：0 成功；4 STOP；2 用法錯誤（每個旗標給一次；欄位不能空白、含換行或三個連續空白，--how 也不能含 `|`；--script 的檔案要存在），不寫任何檔。
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateLines, gateRow, gateSections, isField, isResolvedRow, isResolvedSection, now, storeDir, usage } from './lib/pilot-store.mjs';

const USAGE = '用法：node scripts/pilot-gate.mjs <checkout> open --title <text> --issue <text> --question <text> --options <text> --default <text> --parked <text> [--script <file>] | <checkout> resolve <G<n>> --how <text> | <checkout> list';
// 旗標名與段落欄位名：只有 Issue 的大小寫不同。
// gate 腳本與完成標記的目錄，相對於 checkout。
const SCRIPT_DIR = '.scratch/pilot/gates';
const FIELDS = [['issue', 'Issue'], ['question', 'question'], ['options', 'options'], ['default', 'default'], ['parked', 'parked']];

const [checkout, command, ...rest] = process.argv.slice(2);
if (!checkout || checkout.startsWith('--')) usage(USAGE);
const file = join(storeDir(checkout), 'gates.md');
const read = () => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** 解析 `--<name> <value>`：names 每個都要給、optional 可以不給，都只給一次；值不能以 `--` 開頭（漏給值時吃到下一個旗標），names 的值是一個欄位（isField）。 */
function parseFlags(args, names, optional = []) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || ![...names, ...optional].includes(name) || name in values || args[i + 1] === undefined || args[i + 1].startsWith('--')) usage(USAGE, `參數錯誤：${args[i]}`);
    values[name] = args[i + 1];
  }
  for (const name of names) {
    if (values[name] === undefined) usage(USAGE, `缺少 --${name}`);
    if (!isField(values[name])) usage(USAGE, `--${name} 不能空白、含換行或三個連續空白`);
  }
  return values;
}

/** gate 腳本：表頭（回到 checkout 根目錄、完成標記、step、trap ERR、set -e、pipefail）＋原樣的步驟本體＋完成標記。只用 bash 與 zsh 共通的語法。 */
function gateScript(id, title, steps) {
  const done = `"$gate_root"/${SCRIPT_DIR}/${id}.done`;
  return [
    '#!/usr/bin/env bash',
    `# ${id} ${title}：pilot-gate.mjs open --script 產生。用 \`bash <本檔>\` 或 \`zsh <本檔>\` 在任何目錄執行。`,
    `# 跑完寫 ${SCRIPT_DIR}/${id}.done，之後再跑不重做；要整份重跑先刪掉它。中途失敗的話修好原因再跑，會從頭執行。`,
    // 標記用絕對路徑：步驟本體 cd 到別處（例如進 worktree）後照樣寫得到、讀得到。
    'cd "$(dirname "$0")/../../.." || exit 1',
    'gate_root="$(pwd)"',
    `if [ -e ${done} ]; then echo "GATE_SCRIPT_DONE ${id} $(cat ${done}) 已執行完成；要重跑先刪 ${SCRIPT_DIR}/${id}.done"; exit 0; fi`,
    "gate_step='（還沒進入任何 step）'",
    `step() { gate_step="$*"; printf '▶ %s\\n' "$*"; }`,
    // bash 加 set -E 讓函式裡的失敗也觸發 trap；trap 因此也會在 $(…) 子 shell 裡觸發，只在最外層印，同一個失敗只印一行。
    `trap '[ "\${BASH_SUBSHELL:-\${ZSH_SUBSHELL:-0}}" = 0 ] && printf "停止：第 %s 行失敗（步驟：%s）\\n" "$LINENO" "$gate_step" >&2' ERR`,
    'if [ -n "${BASH_VERSION:-}" ]; then set -E; fi',
    'set -e',
    'set -o pipefail',
    '# ---- 步驟（每步先 step <說明>；只讀狀態的查詢寫成 x="$(<指令>)" || true 再自己判斷）----',
    steps.replace(/\n?$/, ''),
    '# ---- 步驟結束 ----',
    'trap - ERR',
    `date '+%Y-%m-%dT%H:%M:%S%z' > ${done}`,
    `echo "GATE_SCRIPT_DONE ${id}"`,
    '',
  ].join('\n');
}

if (command === 'list' && !rest.length) {
  for (const line of gateLines(read())) console.log(line);
} else if (command === 'open') {
  const values = parseFlags(rest, ['title', ...FIELDS.map(([name]) => name)], ['script']);
  if (values.script !== undefined && !existsSync(values.script)) usage(USAGE, `--script 的檔案不存在：${values.script}`);
  const steps = values.script === undefined ? undefined : readFileSync(values.script, 'utf8');
  mkdirSync(storeDir(checkout), { recursive: true });
  // 只附加不整份改寫：其他 session 同時附加的 gate 不會被蓋掉；id 從附加前重讀的內容算。
  const text = read();
  const ids = [...gateSections(text).map(({ id }) => id), ...text.split('\n').map(gateRow).filter(Boolean).map(row => row[0])];
  const id = `G${Math.max(0, ...ids.map(value => Number(value.slice(1)))) + 1}`;
  const prefix = !text.trim() ? '# Gates\n\n' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  const script = steps === undefined ? undefined : `${SCRIPT_DIR}/${id}.sh`;
  if (script) {
    mkdirSync(join(checkout, SCRIPT_DIR), { recursive: true });
    writeFileSync(join(checkout, script), gateScript(id, values.title, steps));
    chmodSync(join(checkout, script), 0o755);
    // gates.md 重新編號時同一路徑可能留著舊腳本的完成標記，新腳本會被當成已執行。
    rmSync(join(checkout, SCRIPT_DIR, `${id}.done`), { force: true });
    // 開 gate 前還不知道 G<n>，question 由這裡補上執行指令。
    values.question = `${values.question} 執行：! bash ${script}`;
  }
  if (!text.trim()) writeFileSync(file, '');
  appendFileSync(file, `${prefix}${[`## ${id} ${values.title}`, ...FIELDS.map(([name, label]) => `- ${label}：${values[name]}`), ...(script ? [`- script：${script}`] : []), `- opened：${now()}`].join('\n')}\n`);
  if (script) console.log(`GATE_SCRIPT ${script}`);
  console.log(`GATE_OPENED ${id}`);
} else if (command === 'resolve' && /^G[1-9]\d*$/.test(rest[0] ?? '')) {
  const [id, ...args] = rest;
  const { how } = parseFlags(args, ['how']);
  if (how.includes('|')) usage(USAGE, '--how 不能含 |');
  const mark = `resolved ${now()} ${how}`;
  const text = read();
  const lines = text.split('\n');
  const rowIndex = lines.findIndex(line => gateRow(line)?.[0] === id);
  const section = gateSections(text).find(entry => entry.id === id);
  if (rowIndex >= 0) {
    const row = gateRow(lines[rowIndex]);
    if (isResolvedRow(row)) { console.log(`STOP ${id} resolved`); process.exit(4); }
    lines[rowIndex] = `| ${[...row.slice(0, -1), mark].join(' | ')} |`;
    writeFileSync(file, lines.join('\n'));
  } else if (section) {
    if (isResolvedSection(section.body)) { console.log(`STOP ${id} resolved`); process.exit(4); }
    // 插在段落最後一個 `- ` 欄位之後：段落後面的空行、下一個 `## ` 或接在後面的表格都不動。
    const body = text.slice(section.start, section.end);
    const at = section.start + Math.max(...[...body.matchAll(/^- .*$/gm)].map(match => match.index + match[0].length), body.includes('\n') ? body.indexOf('\n') : body.length);
    const after = text.slice(at);
    writeFileSync(file, `${text.slice(0, at)}\n- ${mark}${after || '\n'}`);
  } else { console.log(`STOP ${id} missing`); process.exit(4); }
  console.log(`GATE_RESOLVED ${id}`);
} else usage(USAGE);
