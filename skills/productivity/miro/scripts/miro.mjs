#!/usr/bin/env node
// 輕量 Miro REST API v2 CLI：只用 node 內建模組（global fetch），Windows 與 WSL／Linux／macOS 都能跑。用法見 usage() 與同目錄上一層的 SKILL.md。
// 輸出一律是 stdout 的 JSON；錯誤寫 stderr、exit 1（API 或驗證失敗）或 2（用法錯誤）。
// token：MIRO_ACCESS_TOKEN > <home>/.config/miro/token（Windows 的 <home> 是 %USERPROFILE%）。token 不出現在任何輸出：--dry-run 的 Authorization 遮成 <redacted>，
// 錯誤訊息與 API 回應印出前也把 token 字串換掉。
// 測試用環境變數：MIRO_API_BASE（預設 https://api.miro.com/v2）、MIRO_MAX_RETRIES（429 重試上限，預設 5）、MIRO_BACKOFF_MS（沒有 Retry-After 時的退避起點，預設 1000）。
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const TEXT_MAX = 6000;
// https://developers.miro.com/docs/text_text-1
export const ALLOWED_TAGS = new Set(['p', 'a', 'strong', 'b', 'em', 'i', 'u', 's', 'span', 'ol', 'ul', 'li', 'br']);
const ITEM_TYPES = ['card', 'sticky_note', 'text', 'shape', 'frame', 'connector'];
const PLURAL = { card: 'cards', sticky_note: 'sticky_notes', text: 'texts', shape: 'shapes', frame: 'frames', connector: 'connectors' };
// items list 的 --type 可多查 image（https://developers.miro.com/reference/get-items-1 的 type enum 含 image）；建立與更新圖片走 images 指令。
const LIST_TYPES = [...ITEM_TYPES, 'image'];
const PAGE_SIZE = 50;
// 上傳圖片：上限見 https://developers.miro.com/reference/create-image-item-using-local-file 的 resource 說明「Maximum file size is 6 MB」（未說明 MB 是 10^6 還是 2^20，這裡取 6 MiB）。
// 官方 API 文件沒有列可上傳的格式（未確認）；這裡只收 PNG、JPG、SVG、GIF，副檔名與檔頭內容都要對得上。
export const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
// tag 的 fillColor 只收這些值（https://developers.miro.com/reference/create-tag）；不帶時 Miro 回 400，所以 CLI 預設 blue。
export const TAG_COLORS = ['red', 'light_green', 'cyan', 'yellow', 'magenta', 'green', 'blue', 'gray', 'violet', 'dark_green', 'dark_blue', 'black'];
export const TAG_DEFAULT_COLOR = 'blue';

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

const USAGE = `用法：miro.mjs <指令> [選項]
  boards list [--limit N]
  boards get <board>
  boards create --name <名稱> [--description <說明>] [--team <team_id>] --confirm
  boards update <board> [--name <名稱>] [--description <說明>]
  items list <board> [--type card|sticky_note|text|shape|frame|connector|image] [--parent <frame>] [--limit N]
  items get <board> <item>
  items create <board> --type <類型> [欄位]
  items update <board> <item> [--type <類型>] [欄位]
  items delete <board> <item> --confirm
  images create <board> --file <PNG|JPG|SVG|GIF> [--parent <frame>] [--x N --y N] [--width N | --height N] [--title <文字>] [--alt-text <文字>]
  images update <board> <item> --file <新檔> [同 create 的欄位]（PATCH 換掉同一個 item 的圖，item id 與深連結不變）
  images get <board> <item>
  tags list <board> [--item <item>]
  tags create <board> --title <名稱> [--color <色名>]（預設 ${TAG_DEFAULT_COLOR}）
  tags attach|detach <board> <item> <tag>
欄位：--content --title --description --shape --fill-color --x --y --width --height --parent <frame>
      --start <item> --end <item>（connector）--caption <文字>（connector）--data <JSON> --style <JSON>
tag 色名：${TAG_COLORS.join(' ')}
圖片：最大 6 MiB；--width 與 --height 只能擇一（Miro 依原圖比例算另一邊）
共用：--dry-run（只印 request，不送出、不需要 token）`;

/** 本機驗證文字欄位：長度少於 TEXT_MAX、只用允許的 HTML 標籤。回傳錯誤訊息陣列。 */
export function validateText(field, value) {
  const errors = [];
  if (typeof value !== 'string') return errors;
  if (value.length >= TEXT_MAX) errors.push(`${field} 有 ${value.length} 字元，必須少於 ${TEXT_MAX}`);
  const bad = new Set();
  for (const m of value.matchAll(/<\/?\s*([a-zA-Z][\w:-]*)[^>]*>/g)) {
    const tag = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) bad.add(tag);
  }
  if (bad.size) errors.push(`${field} 有不允許的標籤 ${[...bad].map(t => `<${t}>`).join(' ')}（只允許 ${[...ALLOWED_TAGS].join('、')}）`);
  return errors;
}

/** 找出 body 裡所有文字欄位（content、title、description，含 connector captions）並驗證。 */
export function validateBody(body) {
  const errors = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const p = path ? `${path}.${k}` : k;
        if (['content', 'title', 'description'].includes(k) && typeof v === 'string') errors.push(...validateText(p, v));
        else walk(v, p);
      }
    }
  };
  walk(body, '');
  return errors;
}

export const deepLink = (boardId, itemId) => `https://miro.com/app/board/${boardId}/?moveToWidget=${itemId}`;
const withLink = (boardId, item) => (item && item.id ? { ...item, deep_link: deepLink(boardId, item.id) } : item);

export function tokenPath(env = process.env) {
  // Windows：%USERPROFILE%\.config\miro\token；其他：~/.config/miro/token。homedir() 在 Windows 讀 USERPROFILE。
  const home = process.platform === 'win32' ? (env.USERPROFILE || homedir()) : (env.HOME || homedir());
  return join(home, '.config', 'miro', 'token');
}

export function readToken(env = process.env) {
  const fromEnv = env.MIRO_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const path = tokenPath(env);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { text = ''; }
  const token = text.split(/\r?\n/)[0].trim();
  if (token) return token;
  throw new CliError(`找不到 Miro access token：設環境變數 MIRO_ACCESS_TOKEN，或把 token 單獨一行寫進 ${path}（權限設成只有自己能讀）`);
}

function num(name, value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new CliError(`--${name} 要是數字，收到 ${value}`, 2);
  return n;
}

function json(name, value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { throw new CliError(`--${name} 不是合法 JSON`, 2); }
}

function need(value, what) {
  if (!value) throw new CliError(`缺少 ${what}\n${USAGE}`, 2);
  return value;
}

/** 依類型把旗標組成 Miro 的 request body；只放有給的欄位（update 共用）。 */
export function buildItemBody(type, o) {
  const body = {};
  const data = {};
  const style = {};
  if (type === 'connector') {
    if (o.start) body.startItem = { id: o.start };
    if (o.end) body.endItem = { id: o.end };
    if (o.shape) body.shape = o.shape;
    if (o.caption !== undefined) body.captions = [{ content: o.caption }];
  } else {
    if (o.content !== undefined) data.content = o.content;
    if (o.title !== undefined) data.title = o.title;
    if (o.description !== undefined) data.description = o.description;
    if (o.shape) data.shape = o.shape;
    if (type === 'frame' && o.mode === 'create') Object.assign(data, { format: 'custom', type: 'freeform' }, data);
    const x = num('x', o.x), y = num('y', o.y);
    if (x !== undefined || y !== undefined) body.position = { ...(x !== undefined && { x }), ...(y !== undefined && { y }) };
    const width = num('width', o.width), height = num('height', o.height);
    if (width !== undefined || height !== undefined) body.geometry = { ...(width !== undefined && { width }), ...(height !== undefined && { height }) };
    if (o.parent) body.parent = { id: o.parent };
  }
  if (o['fill-color']) style.fillColor = o['fill-color'];
  Object.assign(data, json('data', o.data));
  Object.assign(style, json('style', o.style));
  if (Object.keys(data).length) body.data = data;
  if (Object.keys(style).length) body.style = style;
  return body;
}

/** 讀圖片並在本機驗證：存在、是檔案、副檔名在 IMAGE_TYPES、檔頭內容與副檔名一致、不超過 IMAGE_MAX_BYTES。回傳 { filename, contentType, bytes }。 */
export function loadImage(file) {
  let st;
  try { st = statSync(file); } catch { throw new CliError(`找不到圖片檔 ${file}，未送出`); }
  if (!st.isFile()) throw new CliError(`${file} 不是檔案，未送出`);
  const ext = extname(file).toLowerCase();
  const contentType = IMAGE_TYPES[ext];
  if (!contentType) throw new CliError(`${file} 的副檔名 ${ext || '（沒有）'} 不在允許的格式（${Object.keys(IMAGE_TYPES).join(' ')}），未送出`);
  if (st.size === 0) throw new CliError(`${file} 是空檔，未送出`);
  if (st.size > IMAGE_MAX_BYTES) throw new CliError(`${file} 有 ${st.size} bytes，超過 Miro 上限 6 MiB（${IMAGE_MAX_BYTES} bytes），未送出`);
  const bytes = readFileSync(file);
  const sniffed = sniffImage(bytes);
  if (sniffed !== contentType) throw new CliError(`${file} 的內容${sniffed ? `是 ${sniffed}` : '不是 PNG、JPG、GIF 或 SVG'}，和副檔名 ${ext}（${contentType}）不符，未送出`);
  return { filename: basename(file), contentType, bytes };
}

/** 從檔頭判斷圖片格式；認不出來回傳 null。 */
export function sniffImage(bytes) {
  const b = bytes.subarray(0, 8);
  if (b.length >= 8 && b.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const head6 = b.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  // SVG 是文字：去掉 BOM、XML 宣告、註解、DOCTYPE 之後第一個元素要是 <svg。
  const text = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '');
  const rest = text.replace(/^(\s*(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>))*\s*/i, '');
  if (/^<svg[\s>]/i.test(rest)) return 'image/svg+xml';
  return null;
}

/** 組 images create／update 的 data JSON（Miro 的 UploadFileFromDevice.data）：title、altText、position、geometry（寬或高擇一）、parent，再合併 --data。 */
export function buildImageData(o) {
  const data = {};
  if (o.title !== undefined) data.title = o.title;
  if (o['alt-text'] !== undefined) data.altText = o['alt-text'];
  const x = num('x', o.x), y = num('y', o.y);
  if (x !== undefined || y !== undefined) data.position = { ...(x !== undefined && { x }), ...(y !== undefined && { y }) };
  const width = num('width', o.width), height = num('height', o.height);
  if (width !== undefined && height !== undefined) throw new CliError('圖片的 --width 與 --height 只能擇一（Miro 依原圖比例算另一邊）', 2);
  if (width !== undefined) data.geometry = { width };
  if (height !== undefined) data.geometry = { height };
  if (o.parent) data.parent = { id: o.parent };
  Object.assign(data, json('data', o.data));
  return data;
}

/** 手動組 multipart/form-data：resource（檔案）＋ data（application/json，沒有欄位時省略）。 */
export function buildMultipart(image, data, boundary = `----miro-cli-${randomBytes(12).toString('hex')}`) {
  const q = s => s.replace(/["\\\r\n]/g, '_');
  const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="resource"; filename="${q(image.filename)}"\r\nContent-Type: ${image.contentType}\r\n\r\n`), image.bytes, Buffer.from('\r\n')];
  const hasData = Object.keys(data).length > 0;
  if (hasData) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n`));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
    summary: [
      { name: 'resource', filename: image.filename, size: image.bytes.length, content_type: image.contentType },
      ...(hasData ? [{ name: 'data', content_type: 'application/json', json: data }] : []),
    ],
  };
}

const redact = (text, token) => (token ? String(text).split(token).join('<redacted>') : String(text));

export class Miro {
  constructor({ env = process.env, dryRun = false, out = s => process.stdout.write(s) } = {}) {
    this.base = (env.MIRO_API_BASE || 'https://api.miro.com/v2').replace(/\/$/, '');
    this.dryRun = dryRun;
    this.env = env;
    this.out = out;
    this.maxRetries = Number(env.MIRO_MAX_RETRIES ?? 5);
    this.backoff = Number(env.MIRO_BACKOFF_MS ?? 1000);
    this.token = dryRun ? null : readToken(env);
  }

  url(path, query = {}) {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** 送出一個 request；--dry-run 時只印出並回傳 null。429 照 Retry-After（沒有時指數退避）重試，最多 maxRetries 次。 */
  async request(method, path, { query, body, multipart } = {}) {
    const url = this.url(path, query);
    const contentType = multipart ? multipart.contentType : body !== undefined ? 'application/json' : undefined;
    if (this.dryRun) {
      const req = { dry_run: true, method, url, headers: { Authorization: 'Bearer <redacted>', ...(contentType && { 'Content-Type': contentType }) } };
      if (body !== undefined) req.body = body;
      if (multipart) req.multipart = multipart.summary;
      this.out(JSON.stringify(req, null, 2) + '\n');
      return null;
    }
    const headers = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    if (contentType) headers['Content-Type'] = contentType;
    const payload = multipart ? multipart.body : body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { method, headers, body: payload });
      } catch (err) {
        throw new CliError(redact(`${method} ${url} 連線失敗：${err.cause?.message || err.message}`, this.token));
      }
      if (res.status === 429) {
        if (attempt >= this.maxRetries) throw new CliError(`${method} ${url} 收到 429，重試 ${this.maxRetries} 次仍被限流`);
        await new Promise(r => setTimeout(r, this.waitMs(res, attempt)));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try { const j = JSON.parse(text); msg = j.message || text; } catch { /* 非 JSON 照原文 */ }
        throw new CliError(redact(`${method} ${url} 失敗：HTTP ${res.status} ${msg}`.trim(), this.token));
      }
      if (!text) return {};
      try { return JSON.parse(text); } catch { throw new CliError(`${method} ${url} 回應不是 JSON`); }
    }
  }

  waitMs(res, attempt) {
    const ra = res.headers.get('retry-after');
    if (ra !== null) {
      const s = Number(ra);
      if (Number.isFinite(s)) return Math.max(0, s * 1000);
      const at = Date.parse(ra);
      if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
    }
    return Math.min(this.backoff * 2 ** attempt, 60_000);
  }

  /** 翻完 list 類 API：有 cursor 用 cursor，否則用 offset/total；limit 是總筆數上限。 */
  async list(path, query = {}, limit = Infinity) {
    const items = [];
    let cursor, offset = 0;
    for (;;) {
      const page = await this.request('GET', path, { query: { ...query, limit: Math.min(PAGE_SIZE, Math.max(10, limit === Infinity ? PAGE_SIZE : limit)), cursor, offset: cursor === undefined && offset ? offset : undefined } });
      if (page === null) return null;
      const data = page.data || [];
      items.push(...data);
      if (items.length >= limit) return items.slice(0, limit);
      if (page.cursor) { cursor = page.cursor; continue; }
      offset += data.length;
      if (!data.length || page.total === undefined || offset >= page.total) return items;
    }
  }
}

const OPTIONS = {
  'dry-run': { type: 'boolean' }, confirm: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  limit: { type: 'string' }, type: { type: 'string' }, parent: { type: 'string' }, item: { type: 'string' },
  name: { type: 'string' }, team: { type: 'string' },
  content: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, shape: { type: 'string' },
  'fill-color': { type: 'string' }, color: { type: 'string' },
  x: { type: 'string' }, y: { type: 'string' }, width: { type: 'string' }, height: { type: 'string' },
  start: { type: 'string' }, end: { type: 'string' }, caption: { type: 'string' },
  data: { type: 'string' }, style: { type: 'string' },
  file: { type: 'string' }, 'alt-text': { type: 'string' },
};

function checkType(type, required, allowed = ITEM_TYPES) {
  if (type === undefined && !required) return;
  const hint = type === 'image' ? '（圖片用 images create／images update）' : '';
  if (!allowed.includes(type)) throw new CliError(`--type 要是 ${allowed.join('|')}，收到 ${type ?? '（沒給）'}${hint}`, 2);
}

function checkBody(body) {
  const errors = validateBody(body);
  if (errors.length) throw new CliError(`文字欄位不合 Miro 規則，未送出：\n- ${errors.join('\n- ')}`);
}

export async function run(argv, { env = process.env, out = s => process.stdout.write(s) } = {}) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); } catch (err) { throw new CliError(`${err.message}\n${USAGE}`, 2); }
  const { values: o, positionals: [group, action, ...rest] } = parsed;
  if (o.help || !group) { out(USAGE + '\n'); return; }
  const print = v => { if (v !== null && v !== undefined) out(JSON.stringify(v, null, 2) + '\n'); };
  const limit = o.limit === undefined ? Infinity : num('limit', o.limit);
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new CliError('--limit 要是正整數', 2);
  const api = () => new Miro({ env, dryRun: !!o['dry-run'], out });
  const enc = encodeURIComponent;
  const key = `${group} ${action ?? ''}`.trim();

  switch (key) {
    case 'boards list': {
      const data = await api().list('/boards', {}, limit);
      return print(data && { data, count: data.length });
    }
    case 'boards get': {
      const id = need(rest[0], '<board>');
      return print(await api().request('GET', `/boards/${enc(id)}`));
    }
    case 'boards create': {
      need(o.name, '--name');
      if (!o.confirm && !o['dry-run']) throw new CliError('boards create 要加 --confirm 才會建立白板（Free 方案只有 3 塊可編輯白板），未送出', 2);
      const body = { name: o.name, ...(o.description && { description: o.description }), ...(o.team && { teamId: o.team }) };
      return print(await api().request('POST', '/boards', { body }));
    }
    case 'boards update': {
      const id = need(rest[0], '<board>');
      if (o.name === undefined && o.description === undefined) throw new CliError('boards update 要帶 --name 或 --description', 2);
      const body = { ...(o.name !== undefined && { name: o.name }), ...(o.description !== undefined && { description: o.description }) };
      return print(await api().request('PATCH', `/boards/${enc(id)}`, { body }));
    }
    case 'items list': {
      const board = need(rest[0], '<board>');
      checkType(o.type, false, LIST_TYPES);
      const client = api();
      let data;
      if (o.type === 'connector') {
        data = await client.list(`/boards/${enc(board)}/connectors`, {}, limit);
      } else {
        // parent_item_id 是 Miro frame 的 links.related 用來列子項目的參數；伺服器若忽略它，下面仍以 parent.id 在本機篩選。
        const all = await client.list(`/boards/${enc(board)}/items`, { type: o.type, parent_item_id: o.parent }, o.parent ? Infinity : limit);
        data = all && (o.parent ? all.filter(i => i.parent?.id === o.parent).slice(0, limit) : all);
      }
      if (data === null) return;
      data = data.map(i => withLink(board, i));
      return print({ data, count: data.length });
    }
    case 'items get': {
      const board = need(rest[0], '<board>'), item = need(rest[1], '<item>');
      return print(withLink(board, await api().request('GET', `/boards/${enc(board)}/items/${enc(item)}`)));
    }
    case 'items create': {
      const board = need(rest[0], '<board>');
      checkType(o.type, true);
      const body = buildItemBody(o.type, { ...o, mode: 'create' });
      if (o.type === 'connector' && !(body.startItem && body.endItem)) throw new CliError('connector 要有 --start <item> 與 --end <item>', 2);
      checkBody(body);
      return print(withLink(board, await api().request('POST', `/boards/${enc(board)}/${PLURAL[o.type]}`, { body })));
    }
    case 'items update': {
      const board = need(rest[0], '<board>'), item = need(rest[1], '<item>');
      checkType(o.type, false);
      const body = buildItemBody(o.type, { ...o, mode: 'update' });
      if (!Object.keys(body).length) throw new CliError('items update 沒有要改的欄位', 2);
      const generic = Object.keys(body).every(k => k === 'position' || k === 'parent');
      if (!o.type && !generic) throw new CliError('改 position、parent 以外的欄位要帶 --type <類型>', 2);
      checkBody(body);
      const path = o.type ? `/boards/${enc(board)}/${PLURAL[o.type]}/${enc(item)}` : `/boards/${enc(board)}/items/${enc(item)}`;
      return print(withLink(board, await api().request('PATCH', path, { body })));
    }
    case 'items delete': {
      const board = need(rest[0], '<board>'), item = need(rest[1], '<item>');
      if (!o.confirm && !o['dry-run']) throw new CliError(`items delete 要加 --confirm 才會刪除 ${item}，未送出`, 2);
      const res = await api().request('DELETE', `/boards/${enc(board)}/items/${enc(item)}`);
      return print(res && { deleted: true, board_id: board, item_id: item });
    }
    case 'images create':
    case 'images update': {
      const board = need(rest[0], '<board>');
      const item = action === 'update' ? need(rest[1], '<item>') : undefined;
      const image = loadImage(need(o.file, '--file <圖片路徑>'));
      const data = buildImageData(o);
      checkBody(data);
      const multipart = buildMultipart(image, data);
      const path = item ? `/boards/${enc(board)}/images/${enc(item)}` : `/boards/${enc(board)}/images`;
      return print(withLink(board, await api().request(item ? 'PATCH' : 'POST', path, { multipart })));
    }
    case 'images get': {
      const board = need(rest[0], '<board>'), item = need(rest[1], '<item>');
      return print(withLink(board, await api().request('GET', `/boards/${enc(board)}/images/${enc(item)}`)));
    }
    case 'tags list': {
      const board = need(rest[0], '<board>');
      if (o.item) {
        const res = await api().request('GET', `/boards/${enc(board)}/items/${enc(o.item)}/tags`);
        return print(res && { data: res.tags || res.data || [], count: (res.tags || res.data || []).length });
      }
      const data = await api().list(`/boards/${enc(board)}/tags`, {}, limit);
      return print(data && { data, count: data.length });
    }
    case 'tags create': {
      const board = need(rest[0], '<board>');
      const color = o.color ?? TAG_DEFAULT_COLOR;
      if (!TAG_COLORS.includes(color)) throw new CliError(`tag 色名 ${color} 不在 Miro 允許的清單，未送出；可用：${TAG_COLORS.join(' ')}`, 2);
      const body = { title: need(o.title, '--title'), fillColor: color };
      if (body.title.length > 120) throw new CliError('tag title 最多 120 字元，未送出');
      return print(await api().request('POST', `/boards/${enc(board)}/tags`, { body }));
    }
    case 'tags attach':
    case 'tags detach': {
      const board = need(rest[0], '<board>'), item = need(rest[1], '<item>'), tag = need(rest[2], '<tag>');
      const res = await api().request(action === 'attach' ? 'POST' : 'DELETE', `/boards/${enc(board)}/items/${enc(item)}`, { query: { tag_id: tag } });
      return print(res && { [action === 'attach' ? 'attached' : 'detached']: true, board_id: board, item_id: item, tag_id: tag, deep_link: deepLink(board, item) });
    }
    default:
      throw new CliError(`不認得的指令：${key}\n${USAGE}`, 2);
  }
}

// 經 ~/.claude/skills 的 symlink 執行時 argv[1] 是 symlink 路徑，import.meta.url 卻已解析成實際路徑；比對前先 realpath。
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run(process.argv.slice(2)).catch(err => {
    let token = null;
    try { token = readToken(); } catch { /* 沒有 token 就沒有東西要遮 */ }
    process.stderr.write(`miro: ${redact(err instanceof CliError ? err.message : err.stack || err, token)}\n`);
    process.exitCode = err instanceof CliError ? err.code : 1;
  });
}
