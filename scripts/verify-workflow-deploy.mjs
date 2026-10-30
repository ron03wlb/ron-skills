#!/usr/bin/env node
// 部署 docs/workflow/ 到 Cloudflare Pages 之後，以匿名 GET 逐檔比對固定網址上的內容與本機 sha256（#11）。
// CDN 剛部署時可能還回舊版或 404，所以整輪有上限地重試：每輪只重抓還不一致的檔案（spay2 實測一分鐘內一致：預設 6 輪 × 20 秒）。
// 用法：node scripts/verify-workflow-deploy.mjs <資料夾> <網址>（如 docs/workflow https://ron-skills-workflow.pages.dev）
// stdout：不一致時每檔一行 `WORKFLOW_DEPLOY_MISMATCH <相對路徑> <原因>`，最後一行是通過或失敗的摘要；
// exit 0 全部一致、1 重試用完仍不一致、2 參數不足。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

export async function verifyDeployment({
  source, baseUrl, attempts = 6, delayMs = 20_000,
  fetch = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const base = baseUrl.replace(/\/+$/, '');
  const expected = new Map([...files(source)].map(file => [relative(source, file).split(sep).join('/'), sha256(readFileSync(file))]));
  let pending = [...expected.keys()];
  let mismatches = [];
  for (let attempt = 1; ; attempt += 1) {
    mismatches = [];
    for (const path of pending) {
      const response = await fetch(`${base}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { 'cache-control': 'no-cache' } });
      if (!response.ok) mismatches.push({ path, reason: `HTTP ${response.status}` });
      else if (sha256(Buffer.from(await response.arrayBuffer())) !== expected.get(path)) mismatches.push({ path, reason: 'sha256 不同' });
    }
    if (!mismatches.length || attempt === attempts) return { ok: !mismatches.length, attempts: attempt, mismatches };
    pending = mismatches.map(item => item.path);
    await sleep(delayMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, baseUrl] = process.argv.slice(2);
  if (!source || !baseUrl) {
    console.log('用法：node scripts/verify-workflow-deploy.mjs <資料夾> <網址>');
    process.exit(2);
  }
  const result = await verifyDeployment({ source, baseUrl });
  for (const { path, reason } of result.mismatches) console.log(`WORKFLOW_DEPLOY_MISMATCH ${path} ${reason}`);
  console.log(result.ok ? `逐檔比對通過（第 ${result.attempts} 輪）。` : `重試 ${result.attempts} 輪後仍有 ${result.mismatches.length} 個檔案與線上不一致。`);
  process.exit(result.ok ? 0 : 1);
}
