#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstatSync, openSync, readFileSync, closeSync, constants } from 'node:fs';
import { extname, join } from 'node:path';

const extensions = new Set(['.java', '.md', '.sql', '.yml', '.yaml', '.properties', '.mjs', '.mts', '.js', '.ts', '.sh', '.json']);
const hooks = new Set(['scripts/git-hooks/pre-push', 'scripts/git-hooks/pre-push-wrapper']);
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('GIT_QUERY_FAILED');
  return result.stdout;
}
function checkPath(root, path) {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (stat.isSymbolicLink()) return ['SYMLINK'];
  }
  if (!lstatSync(current).isFile()) return ['NOT_REGULAR_FILE'];
  const fd = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try { bytes = readFileSync(fd); } finally { closeSync(fd); }
  const errors = [];
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) errors.push('UTF8_BOM');
  if (bytes.includes(0)) errors.push('NUL_BYTE');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { errors.push('INVALID_UTF8'); }
  return errors;
}
try {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const files = new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean));
  let failed = false; let checked = 0;
  for (const path of [...files].sort()) {
    if (path.split('/').includes('.git') || (!extensions.has(extname(path)) && !hooks.has(path))) continue;
    checked++;
    let errors;
    try { errors = checkPath(root, path); } catch { errors = ['READ_FAILED']; }
    for (const error of errors) { console.error(JSON.stringify({ path, error })); failed = true; }
  }
  if (failed) process.exitCode = 1;
  else console.log(`文字 encoding 檢查通過（${checked} 個候選 paths）。`);
} catch {
  console.error(JSON.stringify({ error: 'ENCODING_SCAN_FAILED' })); process.exitCode = 1;
}
