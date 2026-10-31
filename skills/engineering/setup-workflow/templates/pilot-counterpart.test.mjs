import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./pilot-counterpart.mjs', import.meta.url));
const run = body => spawnSync('node', [SCRIPT], { input: body, encoding: 'utf8' });

test('本文有對應單：每張印一行 COUNTERPART <owner>/<repo>#<m>，依序去重，exit 0', () => {
  const result = run('來源：grill 2026-10-30。app 對應單：acme/app#7。\n\nweb 對應單:acme/web#12；app 對應單：acme/app#7\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART acme/app#7\nCOUNTERPART acme/web#12\n');
});

test('ref 本身包在 code span 裡仍是對應單', () => {
  const result = run('app 對應單：`acme/app#7`\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART acme/app#7\n');
});

test('對應單兩側各有一個 code span 時，只剝掉 code span 本身', () => {
  const result = run('依賴 `foo.mjs`。app 對應單：acme/app#7，見 `bar`、「說明」。\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART acme/app#7\n');
});

test('沒有「對應單」字樣的跨 repo 引用不算', () => {
  const result = run('來源：acme/app#7 refine。Blocked by #45。\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

// 一張 Issue 用「」或 code 引用另一張的對應單時，Close 不能到那張單留下假的交接。
test('整句包在「」、code span 或 code block 裡的對應單是引用，不算', () => {
  const result = run('#N 本文寫明「app 對應單：acme/app#7」。\n\n- 測試：本文含 `app 對應單：acme/app#7` 的 fixture。\n\n```\n對應單：acme/web#1\n```\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

// GitLab 與 GitHub Enterprise 的對應單寫成 issue 網址才帶得出 host；裸的 <owner>/<repo>#<m> 一律是 github.com（#79）。
test('GitLab issue 網址：帶出 host 種類與 -R 的值；github.com 網址與裸 ref 是同一張', () => {
  const result = run('app 對應單：http://192.168.200.202/acme/app/-/issues/7\nweb 對應單：https://gitlab.example.com/group/sub/web/issues/12\n'
    + 'api 對應單：https://github.com/acme/api/issues/3；api 對應單：acme/api#3\nops 對應單：https://github.corp.example/acme/ops/issues/5\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART acme/app#7 gitlab http://192.168.200.202/acme/app\n'
    + 'COUNTERPART group/sub/web#12 gitlab https://gitlab.example.com/group/sub/web\n'
    + 'COUNTERPART acme/api#3\n'
    + 'COUNTERPART acme/ops#5 github github.corp.example/acme/ops\n');
});

// Close 照 COMMAND 行留言，留言失敗時把同一行交給人用 `!` 執行；指令取自 hosts.mjs 的對照表（glab issue note 沒有 --body-file）。
test('--file：每張對應單後面印一行 COMMAND，照 host 用 gh issue comment 或 glab issue note -m', () => {
  const result = spawnSync('node', [SCRIPT, '--file', '/tmp/x y/counterpart-1.md'], { encoding: 'utf8',
    input: 'app 對應單：http://192.168.200.202/acme/app/-/issues/7\nweb 對應單：acme/web#12\nops 對應單：https://github.corp.example/acme/ops/issues/5\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'COUNTERPART acme/app#7 gitlab http://192.168.200.202/acme/app\n'
    + 'COMMAND glab issue note 7 -R http://192.168.200.202/acme/app -m "$(cat \'/tmp/x y/counterpart-1.md\')"\n'
    + 'COUNTERPART acme/web#12\n'
    + 'COMMAND gh issue comment 12 --repo acme/web --body-file \'/tmp/x y/counterpart-1.md\'\n'
    + 'COUNTERPART acme/ops#5 github github.corp.example/acme/ops\n'
    + 'COMMAND gh issue comment 5 --repo github.corp.example/acme/ops --body-file \'/tmp/x y/counterpart-1.md\'\n');
});
