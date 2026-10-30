#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstatSync, openSync, readFileSync, closeSync, constants } from 'node:fs';
import { basename, join } from 'node:path';

// 只輸出 path 與規則代碼，不輸出 file contents，避免把 secret 帶進 log。
const MAX_BYTES = 5 * 1024 * 1024;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\r?\n|\\n)[A-Za-z0-9+/=\r\n\\]{64,}/;
const SERVICE_ACCOUNT_TYPE = /"type"\s*:\s*"service_account"/;
const SERVICE_ACCOUNT_KEY = /"private_key"\s*:\s*"[^"]+"/;
const FIREBASE_CREDENTIAL_NAME = /-firebase\.json$/i;
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('GIT_QUERY_FAILED');
  return result.stdout;
}
function regularFile(root, path) {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) return null;
  }
  const stat = lstatSync(current);
  return stat.isFile() && stat.size <= MAX_BYTES ? current : null;
}
function checkPath(root, path) {
  const errors = [];
  if (FIREBASE_CREDENTIAL_NAME.test(basename(path))) errors.push('FIREBASE_CREDENTIAL_FILE');
  const file = regularFile(root, path);
  if (!file) return errors;
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try { bytes = readFileSync(fd); } finally { closeSync(fd); }
  if (bytes.includes(0)) return errors;
  const text = bytes.toString('utf8');
  if (PEM_PRIVATE_KEY.test(text)) errors.push('PRIVATE_KEY_PEM');
  if (SERVICE_ACCOUNT_TYPE.test(text) && SERVICE_ACCOUNT_KEY.test(text)) errors.push('SERVICE_ACCOUNT_KEY');
  return errors;
}
try {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const files = new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean));
  let failed = false; let checked = 0;
  for (const path of [...files].sort()) {
    if (path.split('/').includes('.git')) continue;
    checked++;
    let errors;
    try { errors = checkPath(root, path); } catch { errors = ['READ_FAILED']; }
    for (const error of errors) { console.error(JSON.stringify({ path, error })); failed = true; }
  }
  if (failed) {
    console.error('偵測到疑似 secret；移出版控並由 Operator 放置，已 commit 的 key 須輪替。');
    process.exitCode = 1;
  } else console.log(`Secret 檢查通過（${checked} 個候選 paths）。`);
} catch {
  console.error(JSON.stringify({ error: 'SECRET_SCAN_FAILED' })); process.exitCode = 1;
}
