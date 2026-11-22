// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// macOS 內建 /bin/bash 是 3.2；只裝了 Homebrew bash 的機器，`#!/usr/bin/env bash` 拿到的是新版，3.2 才有的錯測不出來（#85）。
// systemBashPath 回傳把 PATH 上的 bash 換成 /bin/bash 的 PATH；沒有 /bin/bash 時以 hasSystemBash 決定 skip。
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { realTmpdir } from './real-tmpdir.mjs';

export const hasSystemBash = existsSync('/bin/bash');

export function systemBashPath(t) {
  const dir = mkdtempSync(join(realTmpdir(), 'bash32-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  symlinkSync('/bin/bash', join(dir, 'bin/bash'));
  return `${join(dir, 'bin')}:${process.env.PATH}`;
}
