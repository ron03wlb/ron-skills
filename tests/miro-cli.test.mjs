// skills/productivity/miro/scripts/miro.mjs 對本機假 Miro server（node:http）的測試；不打真的 API。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../skills/productivity/miro/scripts/miro.mjs', import.meta.url).pathname;
const TOKEN = 'test-token-SHOULD-NEVER-APPEAR-9f8e7d';

/** 假 Miro server：handler(req, body) 回傳 { status, headers, json }；每個 request 記在 calls。 */
async function fakeMiro(t, handler) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => { chunks.push(c); });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const raw = Buffer.concat(chunks);
      const type = req.headers['content-type'] || '';
      const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, contentType: type };
      if (type.startsWith('multipart/form-data')) call.parts = parseMultipart(raw, type);
      else call.body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
      calls.push(call);
      const r = handler(call, calls) || { status: 404, json: { message: 'not found' } };
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
      res.end(r.json === undefined ? '' : JSON.stringify(r.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { calls, base: `http://127.0.0.1:${server.address().port}/v2` };
}

/** 照 RFC 7578 解析 multipart/form-data：回傳 { <name>: { filename, contentType, bytes } }。 */
function parseMultipart(raw, type) {
  const boundary = /boundary=(.+)$/.exec(type)[1];
  const delim = Buffer.from(`--${boundary}`);
  const parts = {};
  let pos = raw.indexOf(delim);
  for (;;) {
    const start = pos + delim.length;
    if (raw.subarray(start, start + 2).toString() === '--') break;
    const next = raw.indexOf(delim, start);
    const part = raw.subarray(start + 2, next - 2);
    const sep = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, sep).toString('utf8');
    const name = /name="([^"]*)"/.exec(head)[1];
    parts[name] = { filename: /filename="([^"]*)"/.exec(head)?.[1], contentType: /Content-Type: (.+)/i.exec(head)?.[1].trim(), bytes: part.subarray(sep + 4) };
    pos = next;
  }
  return parts;
}

function home(t) {
  const dir = mkdtempSync(join(realTmpdir(), 'miro-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 跑 CLI，回傳 { code, stdout, stderr }。env 預設沒有 MIRO_ACCESS_TOKEN、HOME 指向空目錄。 */
function cli(t, args, env = {}) {
  const h = home(t);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, HOME: h, USERPROFILE: h, MIRO_BACKOFF_MS: '1', ...env },
    });
    t.after(() => child.kill());
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const withToken = base => ({ MIRO_API_BASE: base, MIRO_ACCESS_TOKEN: TOKEN });
const noLeak = r => assert.ok(!(r.stdout + r.stderr).includes(TOKEN), 'token 出現在輸出裡');

test('items list 依 cursor 翻完所有頁，每個 item 帶深連結', async t => {
  const { calls, base } = await fakeMiro(t, call => {
    if (call.path !== '/v2/boards/b1/items') return;
    if (!call.query.cursor) return { json: { data: [{ id: '1', type: 'card' }, { id: '2', type: 'card' }], cursor: 'c2', size: 2, limit: 50 } };
    if (call.query.cursor === 'c2') return { json: { data: [{ id: '3', type: 'card' }], size: 1, limit: 50 } };
  });
  const r = await cli(t, ['items', 'list', 'b1', '--type', 'card'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.data.map(i => i.id), ['1', '2', '3']);
  assert.equal(out.data[2].deep_link, 'https://miro.com/app/board/b1/?moveToWidget=3');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query.type, 'card');
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  noLeak(r);
});

test('items list --limit 只取前 N 筆，不再翻頁', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ json: { data: Array.from({ length: 10 }, (_, i) => ({ id: String(i) })), cursor: 'more' } }));
  const r = await cli(t, ['items', 'list', 'b1', '--limit', '3'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).count, 3);
  assert.equal(calls.length, 1);
});

test('items list --parent 帶 parent_item_id 並在本機篩選', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ json: { data: [{ id: 'a', parent: { id: 'f1' } }, { id: 'b' }, { id: 'c', parent: { id: 'f2' } }] } }));
  const r = await cli(t, ['items', 'list', 'b1', '--parent', 'f1'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).data.map(i => i.id), ['a']);
  assert.equal(calls[0].query.parent_item_id, 'f1');
});

test('items list --type connector 改打 connectors endpoint', async t => {
  const { calls, base } = await fakeMiro(t, call => call.path === '/v2/boards/b1/connectors' ? { json: { data: [{ id: 'k1', type: 'connector' }] } } : undefined);
  const r = await cli(t, ['items', 'list', 'b1', '--type', 'connector'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).data[0].deep_link, 'https://miro.com/app/board/b1/?moveToWidget=k1');
  assert.equal(calls.length, 1);
});

test('boards list 依 offset／total 翻頁', async t => {
  const { calls, base } = await fakeMiro(t, call => {
    const offset = Number(call.query.offset || 0);
    return { json: { data: offset ? [{ id: 'B3' }] : [{ id: 'B1' }, { id: 'B2' }], total: 3, offset, size: offset ? 1 : 2 } };
  });
  const r = await cli(t, ['boards', 'list'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).data.map(b => b.id), ['B1', 'B2', 'B3']);
  assert.equal(calls[1].query.offset, '2');
});

test('items create 組出 data、position、geometry、parent，輸出帶深連結', async t => {
  const { calls, base } = await fakeMiro(t, call => call.method === 'POST' ? { status: 201, json: { id: 'n1', type: 'sticky_note', ...call.body } } : undefined);
  const r = await cli(t, ['items', 'create', 'b1', '--type', 'sticky_note', '--content', '<p>練習 <strong>一</strong></p>',
    '--x', '10', '--y=-20', '--width', '200', '--parent', 'f1', '--fill-color', 'light_yellow'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls[0].path, '/v2/boards/b1/sticky_notes');
  assert.deepEqual(calls[0].body, { data: { content: '<p>練習 <strong>一</strong></p>' }, position: { x: 10, y: -20 }, geometry: { width: 200 }, parent: { id: 'f1' }, style: { fillColor: 'light_yellow' } });
  assert.equal(JSON.parse(r.stdout).deep_link, 'https://miro.com/app/board/b1/?moveToWidget=n1');
});

test('items create connector 送 startItem、endItem', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ status: 201, json: { id: 'k1' } }));
  const r = await cli(t, ['items', 'create', 'b1', '--type', 'connector', '--start', 'a', '--end', 'b', '--caption', '依賴'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls[0].path, '/v2/boards/b1/connectors');
  assert.deepEqual(calls[0].body, { startItem: { id: 'a' }, endItem: { id: 'b' }, captions: [{ content: '依賴' }] });
});

test('items create connector 缺起點或終點：exit 2、不送出', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ json: {} }));
  const r = await cli(t, ['items', 'create', 'b1', '--type', 'connector', '--start', 'a'], withToken(base));
  assert.equal(r.code, 2);
  assert.equal(calls.length, 0);
});

test('items update 依類型 PATCH；只改位置時走通用 items endpoint', async t => {
  const { calls, base } = await fakeMiro(t, call => ({ json: { id: call.path.split('/').pop() } }));
  const a = await cli(t, ['items', 'update', 'b1', 'c1', '--type', 'card', '--title', '新標題'], withToken(base));
  assert.equal(a.code, 0, a.stderr);
  const b = await cli(t, ['items', 'update', 'b1', 'c1', '--x', '5', '--parent', 'f9'], withToken(base));
  assert.equal(b.code, 0, b.stderr);
  assert.deepEqual(calls.map(c => [c.method, c.path, c.body]), [
    ['PATCH', '/v2/boards/b1/cards/c1', { data: { title: '新標題' } }],
    ['PATCH', '/v2/boards/b1/items/c1', { position: { x: 5 }, parent: { id: 'f9' } }],
  ]);
  assert.equal(JSON.parse(b.stdout).deep_link, 'https://miro.com/app/board/b1/?moveToWidget=c1');
});

test('items delete 有 --confirm 才送出', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ status: 204 }));
  const no = await cli(t, ['items', 'delete', 'b1', 'x1'], withToken(base));
  assert.equal(no.code, 2);
  assert.match(no.stderr, /--confirm/);
  assert.equal(calls.length, 0);
  const yes = await cli(t, ['items', 'delete', 'b1', 'x1', '--confirm'], withToken(base));
  assert.equal(yes.code, 0, yes.stderr);
  assert.deepEqual(calls.map(c => [c.method, c.path]), [['DELETE', '/v2/boards/b1/items/x1']]);
  assert.deepEqual(JSON.parse(yes.stdout), { deleted: true, board_id: 'b1', item_id: 'x1' });
});

test('boards create 沒有 --confirm 不送出', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ status: 201, json: { id: 'nb' } }));
  const r = await cli(t, ['boards', 'create', '--name', '練習地圖'], withToken(base));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--confirm/);
  assert.equal(calls.length, 0);
  const ok = await cli(t, ['boards', 'create', '--name', '練習地圖', '--confirm'], withToken(base));
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(calls[0].body, { name: '練習地圖' });
});

test('文字超過長度：本機擋下、exit 1、不送出', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ json: {} }));
  const r = await cli(t, ['items', 'create', 'b1', '--type', 'text', '--content', 'x'.repeat(6000)], withToken(base));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /6000/);
  assert.equal(calls.length, 0);
});

test('文字有不允許的標籤：本機擋下並指出標籤', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ json: {} }));
  const r = await cli(t, ['items', 'create', 'b1', '--type', 'card', '--title', 'ok', '--description', '<h1>標題</h1><script>x</script><b>粗</b>'], withToken(base));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /<h1>/);
  assert.match(r.stderr, /<script>/);
  assert.doesNotMatch(r.stderr, /<b>/);
  assert.equal(calls.length, 0);
});

test('429 照 Retry-After 重試後成功', async t => {
  const { calls, base } = await fakeMiro(t, (_, all) => all.length < 3
    ? { status: 429, headers: { 'retry-after': '0' }, json: { status: 429, code: 'tooManyRequests' } }
    : { json: { id: 'b1', name: 'ok' } });
  const r = await cli(t, ['boards', 'get', 'b1'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(r.stdout).name, 'ok');
});

test('429 沒有 Retry-After 時退避重試，用完上限後 exit 1', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ status: 429, json: { status: 429 } }));
  const r = await cli(t, ['boards', 'get', 'b1'], { ...withToken(base), MIRO_MAX_RETRIES: '2' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /429/);
  assert.equal(calls.length, 3);
  noLeak(r);
});

test('--dry-run 不送出、不需要 token，印出 method、URL、body 並遮住 Authorization', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ json: {} }));
  const r = await cli(t, ['items', 'create', 'b1', '--type', 'frame', '--title', '第一週', '--x', '0', '--y', '0', '--width', '800', '--height', '600', '--dry-run'], { MIRO_API_BASE: base });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls.length, 0);
  const req = JSON.parse(r.stdout);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, `${base}/boards/b1/frames`);
  assert.equal(req.headers.Authorization, 'Bearer <redacted>');
  assert.deepEqual(req.body.data, { title: '第一週', format: 'custom', type: 'freeform' });
});

test('--dry-run 有 token 時也不外洩', async t => {
  const r = await cli(t, ['items', 'delete', 'b1', 'x1', '--dry-run'], { MIRO_ACCESS_TOKEN: TOKEN, MIRO_API_BASE: 'http://127.0.0.1:9/v2' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).method, 'DELETE');
  noLeak(r);
});

test('API 錯誤回應夾帶 token 時，錯誤訊息遮住 token', async t => {
  const { base } = await fakeMiro(t, call => ({ status: 401, json: { message: `bad token ${call.auth}` } }));
  const r = await cli(t, ['boards', 'get', 'b1'], withToken(base));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HTTP 401/);
  assert.match(r.stderr, /<redacted>/);
  noLeak(r);
});

test('token 從設定檔讀取；環境變數優先', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ json: { id: 'b1' } }));
  const h = home(t);
  mkdirSync(join(h, '.config', 'miro'), { recursive: true });
  writeFileSync(join(h, '.config', 'miro', 'token'), `${TOKEN}-file\n`);
  const a = await cli(t, ['boards', 'get', 'b1'], { MIRO_API_BASE: base, HOME: h, USERPROFILE: h });
  assert.equal(a.code, 0, a.stderr);
  const b = await cli(t, ['boards', 'get', 'b1'], { MIRO_API_BASE: base, HOME: h, USERPROFILE: h, MIRO_ACCESS_TOKEN: TOKEN });
  assert.equal(b.code, 0, b.stderr);
  assert.deepEqual(calls.map(c => c.auth), [`Bearer ${TOKEN}-file`, `Bearer ${TOKEN}`]);
  noLeak(a);
});

test('沒有 token：說明環境變數與設定檔路徑，exit 1、不送出', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ json: {} }));
  const r = await cli(t, ['boards', 'list'], { MIRO_API_BASE: base });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /MIRO_ACCESS_TOKEN/);
  assert.match(r.stderr, /\.config[\\/]miro[\\/]token/);
  assert.equal(calls.length, 0);
});

test('tags：list 翻頁、create、attach、detach', async t => {
  const { calls, base } = await fakeMiro(t, call => {
    if (call.method === 'GET') return { json: { data: [{ id: 't1', title: '待練' }], total: 1, offset: 0 } };
    if (call.method === 'POST' && call.path.endsWith('/tags')) return { status: 201, json: { id: 't2', ...call.body } };
    return { status: 204 };
  });
  const env = withToken(base);
  assert.equal(JSON.parse((await cli(t, ['tags', 'list', 'b1'], env)).stdout).data[0].id, 't1');
  assert.equal(JSON.parse((await cli(t, ['tags', 'create', 'b1', '--title', '已掌握', '--color', 'green'], env)).stdout).id, 't2');
  const at = await cli(t, ['tags', 'attach', 'b1', 'i1', 't2'], env);
  assert.equal(JSON.parse(at.stdout).deep_link, 'https://miro.com/app/board/b1/?moveToWidget=i1');
  assert.equal((await cli(t, ['tags', 'detach', 'b1', 'i1', 't2'], env)).code, 0);
  assert.deepEqual(calls.map(c => [c.method, c.path, c.query.tag_id ?? null, c.body ?? null]), [
    ['GET', '/v2/boards/b1/tags', null, null],
    ['POST', '/v2/boards/b1/tags', null, { title: '已掌握', fillColor: 'green' }],
    ['POST', '/v2/boards/b1/items/i1', 't2', null],
    ['DELETE', '/v2/boards/b1/items/i1', 't2', null],
  ]);
});

test('不認得的指令與選項：exit 2', async t => {
  assert.equal((await cli(t, ['boards', 'nuke'])).code, 2);
  assert.equal((await cli(t, ['items', 'list', 'b1', '--bogus'])).code, 2);
  assert.equal((await cli(t, ['items', 'list', 'b1', '--type', 'bogus'])).code, 2);
  const img = await cli(t, ['items', 'create', 'b1', '--type', 'image']);
  assert.equal(img.code, 2);
  assert.match(img.stderr, /images create/);
});

test('tags create 沒帶 --color 時送預設 blue', async t => {
  const { calls, base } = await fakeMiro(t, call => ({ status: 201, json: { id: 't9', ...call.body } }));
  const r = await cli(t, ['tags', 'create', 'b1', '--title', '待練'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(calls[0].body, { title: '待練', fillColor: 'blue' });
});

test('tags create 合法色名照送；不合法色名本機擋下、列出可用值、不送出', async t => {
  const { calls, base } = await fakeMiro(t, call => ({ status: 201, json: { id: 't9', ...call.body } }));
  const ok = await cli(t, ['tags', 'create', 'b1', '--title', 'x', '--color', 'dark_blue'], withToken(base));
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(calls[0].body.fillColor, 'dark_blue');
  const bad = await cli(t, ['tags', 'create', 'b1', '--title', 'x', '--color', 'orange'], withToken(base));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /orange/);
  assert.match(bad.stderr, /light_green/);
  assert.equal(calls.length, 1);
});

test('boards update 送 PATCH /boards/{id}；--dry-run 不送出、不需要 token；沒有欄位時 exit 2', async t => {
  const { calls, base } = await fakeMiro(t, call => ({ json: { id: 'b1', ...call.body } }));
  const r = await cli(t, ['boards', 'update', 'b1', '--name', '演算法', '--description', '練習地圖'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(calls.map(c => [c.method, c.path, c.body]), [['PATCH', '/v2/boards/b1', { name: '演算法', description: '練習地圖' }]]);
  const dry = await cli(t, ['boards', 'update', 'b1', '--name', '演算法', '--dry-run'], { MIRO_API_BASE: base });
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).body, { name: '演算法' });
  assert.equal(JSON.parse(dry.stdout).method, 'PATCH');
  assert.equal((await cli(t, ['boards', 'update', 'b1'], withToken(base))).code, 2);
  assert.equal(calls.length, 1);
});

// ---- images ----
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body\u0000ÿ')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg')]);

function imageFile(t, name, bytes) {
  const dir = home(t);
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

test('images create 送 multipart：resource 是檔案原樣、data 是 JSON（position、geometry、parent、title），輸出帶深連結', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ status: 201, json: { id: 'img1', type: 'image' } }));
  const file = imageFile(t, '筆記-two-sum.png', PNG);
  const r = await cli(t, ['images', 'create', 'b1', '--file', file, '--parent', 'f1', '--x', '100', '--y=-50', '--width', '640', '--title', 'Two Sum 筆記'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.deepEqual([c.method, c.path, c.auth], ['POST', '/v2/boards/b1/images', `Bearer ${TOKEN}`]);
  assert.match(c.contentType, /^multipart\/form-data; boundary=/);
  assert.deepEqual(Object.keys(c.parts).sort(), ['data', 'resource']);
  assert.equal(c.parts.resource.filename, '筆記-two-sum.png');
  assert.equal(c.parts.resource.contentType, 'image/png');
  assert.ok(c.parts.resource.bytes.equals(PNG), 'resource 位元組被改動');
  assert.equal(c.parts.data.contentType, 'application/json');
  assert.equal(c.parts.data.filename, undefined);
  assert.deepEqual(JSON.parse(c.parts.data.bytes.toString('utf8')), { title: 'Two Sum 筆記', position: { x: 100, y: -50 }, geometry: { width: 640 }, parent: { id: 'f1' } });
  assert.equal(JSON.parse(r.stdout).deep_link, 'https://miro.com/app/board/b1/?moveToWidget=img1');
  noLeak(r);
});

test('images create 沒有其他欄位時只送 resource', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ status: 201, json: { id: 'img2' } }));
  const r = await cli(t, ['images', 'create', 'b1', '--file', imageFile(t, 'a.jpg', JPG)], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(calls[0].parts), ['resource']);
  assert.equal(calls[0].parts.resource.contentType, 'image/jpeg');
});

test('images update 以 PATCH multipart 換檔，同一個 item id、輸出帶深連結', async t => {
  const { calls, base } = await fakeMiro(t, call => call.method === 'PATCH' ? { json: { id: 'img1', type: 'image', data: { title: 'v2' } } } : undefined);
  const v2 = Buffer.concat([PNG, Buffer.from('-v2')]);
  const r = await cli(t, ['images', 'update', 'b1', 'img1', '--file', imageFile(t, 'note.png', v2), '--title', 'v2'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(calls.map(c => [c.method, c.path]), [['PATCH', '/v2/boards/b1/images/img1']]);
  assert.ok(calls[0].parts.resource.bytes.equals(v2));
  assert.deepEqual(JSON.parse(calls[0].parts.data.bytes), { title: 'v2' });
  assert.equal(JSON.parse(r.stdout).deep_link, 'https://miro.com/app/board/b1/?moveToWidget=img1');
  noLeak(r);
});

test('images update 缺 --file 或 <item>：exit 2、不送出', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ json: {} }));
  assert.equal((await cli(t, ['images', 'update', 'b1', 'img1', '--title', 'x'], withToken(base))).code, 2);
  assert.equal((await cli(t, ['images', 'update', 'b1'], withToken(base))).code, 2);
  assert.equal(calls.length, 0);
});

test('images 本機驗證：不存在、副檔名不允許、內容與副檔名不符、空檔、超過 6 MiB、寬高同時給，都擋下且不送出', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ status: 201, json: { id: 'x' } }));
  const env = withToken(base);
  const cases = [
    [['--file', '/nonexistent/x.png'], 1, /找不到圖片檔/],
    [['--file', imageFile(t, 'x.bmp', PNG)], 1, /\.bmp/],
    [['--file', imageFile(t, 'x.pdf', Buffer.from('%PDF-1.4'))], 1, /\.pdf/],
    [['--file', imageFile(t, 'fake.png', JPG)], 1, /image\/jpeg.*不符/],
    [['--file', imageFile(t, 'text.png', Buffer.from('hello'))], 1, /不是 PNG/],
    [['--file', imageFile(t, 'empty.png', Buffer.alloc(0))], 1, /空檔/],
    [['--file', imageFile(t, 'big.png', Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]))], 1, /6 MiB/],
    [['--file', imageFile(t, 'ok.png', PNG), '--width', '10', '--height', '10'], 2, /擇一/],
    [['--file', home(t)], 1, /不是檔案/],
    [[], 2, /--file/],
  ];
  for (const [args, code, re] of cases) {
    const r = await cli(t, ['images', 'create', 'b1', ...args], env);
    assert.equal(r.code, code, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re);
  }
  assert.equal(calls.length, 0);
});

test('images：剛好 6 MiB 可送；SVG 與 GIF 認得出來', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ status: 201, json: { id: 'x' } }));
  const env = withToken(base);
  const exact = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024 - PNG.length)]);
  const svg = Buffer.from('﻿<?xml version="1.0"?>\n<!-- note -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  for (const [name, bytes, type] of [['exact.png', exact, 'image/png'], ['map.svg', svg, 'image/svg+xml'], ['a.gif', Buffer.from('GIF89a....'), 'image/gif'], ['b.JPEG', JPG, 'image/jpeg']]) {
    const r = await cli(t, ['images', 'create', 'b1', '--file', imageFile(t, name, bytes)], env);
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    assert.equal(calls.at(-1).parts.resource.contentType, type);
    assert.equal(calls.at(-1).parts.resource.bytes.length, bytes.length);
  }
});

test('images --dry-run 印 method、URL、multipart 摘要，不送出、不需要 token、token 不外洩', async t => {
  const { calls, base } = await fakeMiro(t, () => ({ json: {} }));
  const file = imageFile(t, 'note.png', PNG);
  for (const env of [{ MIRO_API_BASE: base }, { MIRO_API_BASE: base, MIRO_ACCESS_TOKEN: TOKEN }]) {
    const r = await cli(t, ['images', 'update', 'b1', 'img1', '--file', file, '--height', '300', '--parent', 'f1', '--dry-run'], env);
    assert.equal(r.code, 0, r.stderr);
    const req = JSON.parse(r.stdout);
    assert.equal(req.method, 'PATCH');
    assert.equal(req.url, `${base}/boards/b1/images/img1`);
    assert.equal(req.headers.Authorization, 'Bearer <redacted>');
    assert.match(req.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    assert.deepEqual(req.multipart, [
      { name: 'resource', filename: 'note.png', size: PNG.length, content_type: 'image/png' },
      { name: 'data', content_type: 'application/json', json: { geometry: { height: 300 }, parent: { id: 'f1' } } },
    ]);
    noLeak(r);
  }
  const bad = await cli(t, ['images', 'create', 'b1', '--file', imageFile(t, 'x.txt', 'hi'), '--dry-run'], { MIRO_API_BASE: base });
  assert.equal(bad.code, 1, '--dry-run 也要先做本機驗證');
  assert.equal(calls.length, 0);
});

test('images get 與 items list --type image 讀得到圖片 item', async t => {
  const { calls, base } = await fakeMiro(t, call => {
    if (call.path === '/v2/boards/b1/images/img1') return { json: { id: 'img1', type: 'image' } };
    if (call.path === '/v2/boards/b1/items') return { json: { data: [{ id: 'img1', type: 'image' }] } };
  });
  const g = await cli(t, ['images', 'get', 'b1', 'img1'], withToken(base));
  assert.equal(g.code, 0, g.stderr);
  assert.equal(JSON.parse(g.stdout).deep_link, 'https://miro.com/app/board/b1/?moveToWidget=img1');
  const l = await cli(t, ['items', 'list', 'b1', '--type', 'image'], withToken(base));
  assert.equal(l.code, 0, l.stderr);
  assert.equal(JSON.parse(l.stdout).data[0].deep_link, 'https://miro.com/app/board/b1/?moveToWidget=img1');
  assert.equal(calls[1].query.type, 'image');
});

test('images create 遇到 429 時重送同一份 multipart', async t => {
  const { calls, base } = await fakeMiro(t, (_, all) => all.length < 2 ? { status: 429, headers: { 'retry-after': '0' } } : { status: 201, json: { id: 'img3' } });
  const r = await cli(t, ['images', 'create', 'b1', '--file', imageFile(t, 'n.png', PNG), '--title', 't'], withToken(base));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].parts.resource.bytes.equals(PNG));
  assert.deepEqual(JSON.parse(calls[1].parts.data.bytes), { title: 't' });
});
