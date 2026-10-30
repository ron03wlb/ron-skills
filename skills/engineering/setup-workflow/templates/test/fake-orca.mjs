// 假 Orca CLI 的回應一律從真實樣本長出來，測試替身才不會和真實輸出形狀分家
// （曾發生：假 Orca 回 `{ satisfied }`、真實是 `{ wait: { satisfied } }`，測試全綠、派工兩次都誤報 tui-timeout）。
// 樣本在 fixtures/orca/<名稱>.json，是 `"$ORCA_CLI_COMMAND" terminal <子指令> --json` 的 `result`（字串已去識別化）；Orca 改版時重錄樣本：
//   "$ORCA_CLI_COMMAND" terminal wait --terminal <h> --for tui-idle --timeout-ms 3000 --json → wait.json，其餘依檔名類推。
// 用法：在假 CLI 的原始碼裡放 `${orcaReplySource()}`，之後 `reply('wait', { wait: { satisfied } })` 印出 `{ ok: true, result }`。
// patch 只能覆寫樣本已有的欄位；寫了樣本沒有的欄位會丟錯，替身因此無法自創真實 Orca 沒有的形狀。陣列整個取代，每個元素以樣本第一個元素為底。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, 'fixtures/orca');

/** 縮短 orca-session-send 的等待，讓重送與兩輪 TUI 等待在測試裡瞬間跑完。 */
export const FAST = { SESSION_TUI_WAIT_MS: '10', SESSION_SEND_CONFIRM_MS: '1', SESSION_SEND_RESEND_MS: '1', SESSION_SEND_LATE_RESEND_MS: '1' };

export const ORCA_SAMPLES = Object.fromEntries(readdirSync(dir).filter(file => file.endsWith('.json'))
  .map(file => [file.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, file), 'utf8'))]));

export function mergeSample(sample, patch, path) {
  if (Array.isArray(patch)) {
    if (!Array.isArray(sample)) throw new Error(`fake-orca：${path} 在真實樣本不是陣列`);
    return patch.map((item, i) => mergeSample(sample[0], item, `${path}[${i}]`));
  }
  if (patch === null || typeof patch !== 'object') return patch;
  if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) {
    if (sample === null) return patch;
    throw new Error(`fake-orca：${path} 在真實樣本不是物件`);
  }
  const merged = { ...sample };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in sample)) throw new Error(`fake-orca：${path}.${key} 不在真實樣本`);
    merged[key] = mergeSample(sample[key], value, `${path}.${key}`);
  }
  return merged;
}

/** 嵌進假 CLI（CommonJS）原始碼的片段：定義 `reply(name, patch)` 與 `fail(code)`。 */
export function orcaReplySource() {
  return `const ORCA_SAMPLES = ${JSON.stringify(ORCA_SAMPLES)};
const mergeSample = ${mergeSample.toString()};
const reply = (name, patch = {}) => console.log(JSON.stringify({ ok: true, result: mergeSample(ORCA_SAMPLES[name], patch, name) }));
const fail = code => console.log(JSON.stringify({ ok: false, error: { code } }));`;
}
