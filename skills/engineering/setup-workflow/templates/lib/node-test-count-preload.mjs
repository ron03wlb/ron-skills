// node-test-guarded.mjs 經 NODE_OPTIONS --import 載入：記下每個測試子行程實際跑完的測試名稱（不含 suite 與 <root>）。
// `node --test` 父行程本身不載入 --import，只有測試子行程會（有 NODE_TEST_CONTEXT）。只記 wrapper 這一輪的第一層測試子行程：
// 記錄的子行程把 NODE_TEST_COUNTED 設成 wrapper 的 pid（NODE_TEST_COUNT_ROOT）放進自己的 process.env，
// 測試自己再起的 `node --test`（fixture）底下的子行程繼承到同一個值就不寫，免得誤報；不讀 /proc，macOS 與 Linux 同一套判定。
// 值綁 wrapper pid：測試裡再起另一個 wrapper 時 ROOT 不同，那一輪的第一層子行程照常記錄。
// `traced` 記是否收到過任何 node.test 事件：Node 22 沒有這個 channel，一律 false，wrapper 據此放行。
// `started`／`failed`／`code` 讓 wrapper 在父行程漏掉回報時改信子行程紀錄（#256）：開始的測試數（結束數就是 names 的長度）、
// 收到 error 事件的測試數（含逾時與子測試），以及子行程的 exit code。hook、describe 本體或測試結束後的未捕捉錯誤
// 不發 error 事件、只讓 exit code 非 0，所以 wrapper 判定全過時 code 是必要條件，不能只看 failed。
import { tracingChannel } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';

const { NODE_TEST_COUNT_FILE: file, NODE_TEST_COUNT_ROOT: root, NODE_TEST_CONTEXT: context, NODE_TEST_COUNTED: counted } = process.env;
if (file && root && context && counted !== root) {
  process.env.NODE_TEST_COUNTED = root;
  const names = [];
  let traced = false;
  let started = 0;
  let failed = 0;
  const isUserTest = ctx => ctx.type === 'test' && ctx.name !== '<root>';
  tracingChannel('node.test').subscribe({
    start(ctx) { if (isUserTest(ctx)) started++; },
    asyncStart() {}, asyncEnd() {},
    error(ctx) { if (isUserTest(ctx)) failed++; },
    end(ctx) { traced = true; if (isUserTest(ctx)) names.push(ctx.name); },
  });
  process.on('exit', code => appendFileSync(file, `${JSON.stringify({ file: process.argv[1], names, traced, started, failed, code })}\n`));
}
