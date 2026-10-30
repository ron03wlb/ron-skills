#!/usr/bin/env node
// docs/workflow/ 整個資料夾由 .github/workflows/workflow-site.yml 公開部署到 Cloudflare Pages；部署前擋已知樣式的機密與私有網址（#11，R2-Q4）。
// 樣式取自 spay2 公開站發布模組的 SECRET_PATTERNS／INTERNAL_PATTERNS，是基礎檢查，不取代人工審查。
// 掃描資料夾內所有文字檔（含產出的 site/）；圖片與字型只看副檔名，不掃內容。
// 用法：node scripts/check-workflow-secrets.mjs [資料夾]（預設 docs/workflow）
// stdout：每個命中一行 `WORKFLOW_SECRET <相對路徑>:<行號> <類型>`，不印命中的值；exit 0 無命中、1 有命中。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? join(root, 'docs/workflow');
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|woff2?)$/i;
const PATTERNS = {
  'private-key': /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  'OpenAI-key': /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/,
  'GitLab-token': /\bglpat-[A-Za-z0-9_-]{15,}/,
  'GitHub-token': /\b(?:ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{25,}/,
  'AWS-access-key': /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  JWT: /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/,
  'credential-url': /https?:\/\/[^\s/<>"']+:[^\s/<>"']+@/,
  'private-ip': /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/,
  'internal-host': /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/<>"'@]+@)?(?:localhost|[\w.-]+\.(?:localhost|local|internal|lan))(?![\w.-])/i,
  'git-remote-url': /\b[\w.-]+@[\w.-]+:[\w./~-]+\.git\b/,
};

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (!BINARY.test(entry.name)) yield path;
  }
}

const failures = [];
for (const file of files(source)) {
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    for (const [label, pattern] of Object.entries(PATTERNS)) {
      if (pattern.test(line)) failures.push(`WORKFLOW_SECRET ${relative(source, file)}:${index + 1} ${label}`);
    }
  });
}
for (const line of failures) console.log(line);
if (failures.length) console.log('docs/workflow/ 會公開部署：移除憑證與內網位址，改用 placeholder（如 <TOKEN>）或公開網址。');
process.exit(failures.length ? 1 : 0);
