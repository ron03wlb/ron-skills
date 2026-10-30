// node-test-guarded.mjs 經 NODE_OPTIONS --import 載入：記下每個測試子行程實際跑完的測試名稱（不含 suite 與 <root>）。
// `node --test` 父行程本身不載入 --import，只有測試子行程會；只記父行程由 wrapper 直接起的子行程（祖父行程即 wrapper，讀 /proc），
// 測試自己再起的 `node --test`（fixture）底下的子行程不寫，免得誤報。
// `traced` 記是否收到過任何 node.test 事件：Node 22 沒有這個 channel，一律 false，wrapper 據此放行。
import { tracingChannel } from 'node:diagnostics_channel';
import { appendFileSync, readFileSync } from 'node:fs';

/** pid 的父行程 pid（/proc/<pid>/stat 第 4 欄；讀不到時 null）。 */
function parentOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
  } catch { return null; }
}

const { NODE_TEST_COUNT_FILE: file, NODE_TEST_COUNT_ROOT: root, NODE_TEST_CONTEXT: context } = process.env;
if (file && context && parentOf(process.ppid) === root) {
  const names = [];
  let traced = false;
  tracingChannel('node.test').subscribe({
    start() {}, asyncStart() {}, asyncEnd() {}, error() {},
    end(ctx) { traced = true; if (ctx.type === 'test' && ctx.name !== '<root>') names.push(ctx.name); },
  });
  process.on('exit', () => appendFileSync(file, `${JSON.stringify({ file: process.argv[1], names, traced })}\n`));
}
