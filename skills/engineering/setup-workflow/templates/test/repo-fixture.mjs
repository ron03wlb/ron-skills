// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
import './isolate-git-env.mjs';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realTmpdir } from './real-tmpdir.mjs';

/** 被測 script 所在的目錄（本 helper 的上一層）。 */
export const source = fileURLToPath(new URL('../', import.meta.url));
export function run(cwd, args, options = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // 上限原為 30000：load 70+ 時 merge-into-integration.test 的 merge() 花 26–30 秒，且曾 quiet.word 為空、stdout／stderr 皆空，疑為此上限（spay2 #734，未確認，這裡只是緩解）。
  return spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', timeout: 90000, ...options,
    env: { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...options.env } });
}
export function git(cwd, ...args) {
  const result = run(cwd, ['git', ...args]); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
export function repoFixture(t) {
  const temp = mkdtempSync(join(realTmpdir(), 'workflow-scripts-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo'); const remote = join(temp, 'remote.git'); mkdirSync(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(temp, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  const commit = (name = 'fixture', content = name) => {
    writeFileSync(join(repo, 'source.md'), content); git(repo, 'add', '.'); git(repo, 'commit', '-qm', name); return git(repo, 'rev-parse', 'HEAD');
  };
  const base = commit();
  return { temp, repo, remote, base, commit };
}

/**
 * 在 fixture repo 寫 `scripts/<name>`：轉呼叫 `<sourceDir>/<name>`（預設 source，即真正的 scripts 目錄），參數、cwd、stdio 照傳，exit code 照回，被 signal 結束時 exit 1。
 * 被測程式以 `node scripts/<name>` 呼叫子程序、失敗時吞掉的路徑，fixture 缺這支腳本就靜默空轉，斷言在未修正的程式上照樣通過；
 * symlink 也不行：主程式判定 `import.meta.url === pathToFileURL(process.argv[1]).href` 在 symlink 路徑下不成立，子程序 exit 0、stdout 為空
 * （spay2 retro 83f3b2b9#1）。所以寫一支另起行程的 wrapper，不用 symlink 或 import。`.sh` 以 bash 轉呼叫，其餘以 node。傳回 wrapper 路徑。
 */
export function stubMainScript(repo, name, sourceDir = source) {
  const target = join(sourceDir, name);
  const wrapper = join(repo, 'scripts', name);
  mkdirSync(dirname(wrapper), { recursive: true });
  if (name.endsWith('.sh')) {
    writeFileSync(wrapper, `#!/usr/bin/env bash\nexec bash ${JSON.stringify(target)} "$@"\n`);
    chmodSync(wrapper, 0o755);
  } else {
    writeFileSync(wrapper, `#!/usr/bin/env node\n// 測試 fixture：轉呼叫 ${target}（repo-fixture.mjs stubMainScript）\n`
      + `import { spawnSync } from 'node:child_process';\n`
      + `const result = spawnSync(process.execPath, [${JSON.stringify(target)}, ...process.argv.slice(2)], { stdio: 'inherit' });\n`
      + `process.exit(result.status ?? 1);\n`);
  }
  return wrapper;
}
