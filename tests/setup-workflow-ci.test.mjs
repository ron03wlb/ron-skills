// /setup-workflow 升到 L2 時寫遠端 CI 最小設定（#139）：依程式碼 host 寫 GitHub Actions、GitLab pipeline 或不寫，
// 已有 CI 檔時不改動，只回報有沒有呼叫單一檢查入口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';

const script = new URL('../skills/engineering/setup-workflow/scripts/ci.mjs', import.meta.url).pathname;
const ADAPTER = '# a\n\n## Checks\n\nOne command: `bin/check`.\n';

/** 暫存 repo：adapter 的 Checks 指向 bin/check；origin 為 null 時不加 remote。 */
function repo(t, { origin, files = {} } = {}) {
  const root = mkdtempSync(join(realTmpdir(), 'setup-workflow-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  write(root, { 'docs/agents/issue-run.md': ADAPTER, 'bin/check': '#!/usr/bin/env bash\n', ...files });
  if (origin) git(root, 'remote', 'add', 'origin', origin);
  return root;
}

const ci = (root, ...args) => spawnSync('node', [script, root, ...args], { encoding: 'utf8', env: { ...env, DETECT_NODE_VERSION: '24.21.0' } });
const last = result => result.stdout.trim().split('\n').pop();

test('GitHub：寫 .github/workflows/checks.yml，push 與 pull_request 跑檢查入口，node 鎖本機版本', t => {
  const root = repo(t, { origin: 'git@github.com:o/r.git' });
  const result = ci(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(last(result), 'CI_WRITTEN .github/workflows/checks.yml');
  const yml = readFileSync(join(root, '.github/workflows/checks.yml'), 'utf8');
  assert.match(yml, /^on:\n  push:\n  pull_request:\n/m);
  assert.match(yml, /node-version: '24\.21\.0'/);
  assert.match(yml, /^\s+- run: bin\/check$/m);
  assert.equal(existsSync(join(root, '.gitlab-ci.yml')), false);
});

test('GitLab（自架 http／IP 也算）：寫 .gitlab-ci.yml，branch 與 MR pipeline 都跑檢查入口', t => {
  const root = repo(t, { origin: 'http://192.168.200.202/spay/spay2.git' });
  const result = ci(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(last(result), 'CI_WRITTEN .gitlab-ci.yml');
  const yml = readFileSync(join(root, '.gitlab-ci.yml'), 'utf8');
  assert.match(yml, /\$CI_PIPELINE_SOURCE == "merge_request_event"/);
  assert.match(yml, /- if: \$CI_COMMIT_BRANCH$/m);
  assert.match(yml, /image: node:24\.21\.0/);
  assert.match(yml, /^\s+- bin\/check$/m);
  assert.equal(existsSync(join(root, '.github')), false);
});

test('local（沒有 origin）：不寫遠端 CI，只有本機執行端', t => {
  const root = repo(t);
  const result = ci(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(last(result), 'CI_SKIPPED local');
  assert.equal(existsSync(join(root, '.github')), false);
  assert.equal(existsSync(join(root, '.gitlab-ci.yml')), false);
});

test('--dry-run：印出要寫的內容與 CI_PLANNED，不寫檔', t => {
  const root = repo(t, { origin: 'https://github.com/o/r.git' });
  const result = ci(root, '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(last(result), 'CI_PLANNED .github/workflows/checks.yml');
  assert.match(result.stdout, /- run: bin\/check/);
  assert.equal(existsSync(join(root, '.github')), false);
});

test('已有 CI 檔而且呼叫檢查入口：不改動，CI_KEPT', t => {
  const existing = 'on: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bin/check --upstream\n';
  const root = repo(t, { origin: 'git@github.com:o/r.git', files: { '.github/workflows/main.yml': existing } });
  const result = ci(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CI_EXISTS \.github\/workflows\/main\.yml calls bin\/check$/m);
  assert.equal(last(result), 'CI_KEPT .github/workflows/main.yml');
  assert.equal(readFileSync(join(root, '.github/workflows/main.yml'), 'utf8'), existing);
  assert.equal(existsSync(join(root, '.github/workflows/checks.yml')), false);
});

test('已有 CI 檔但沒呼叫檢查入口：不改動，印 ci 缺口', t => {
  const existing = 'build:\n  script:\n    - mvn package\n';
  const root = repo(t, { origin: 'http://gitlab.example.com/g/r.git', files: { '.gitlab-ci.yml': existing } });
  const result = ci(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CI_EXISTS \.gitlab-ci\.yml missing bin\/check$/m);
  assert.match(last(result), /^GAP ci \.gitlab-ci\.yml 沒有呼叫 bin\/check/);
  assert.equal(readFileSync(join(root, '.gitlab-ci.yml'), 'utf8'), existing);
});

// ron-skills 的 workflow-site.yml 只在註解提到 bin/check（「檢查由 checks.yml 的 bin/check 跑」），不算呼叫。
test('只在 YAML 註解提到檢查入口不算呼叫', t => {
  const existing = '# 檢查由 checks.yml 的 bin/check 跑\non: push\njobs:\n  d:\n    steps:\n      - run: ./deploy.sh # 不跑 bin/check\n';
  const root = repo(t, { origin: 'git@github.com:o/r.git', files: { '.github/workflows/deploy.yml': existing } });
  const result = ci(root);
  assert.match(result.stdout, /^CI_EXISTS \.github\/workflows\/deploy\.yml missing bin\/check$/m);
  assert.match(last(result), /^GAP ci /);
});

// Spec review（#139）：GitHub 不會跑 .gitlab-ci.yml，只看程式碼 host 自己的 CI 檔。
test('只看程式碼 host 的 CI 檔：GitHub repo 只有 .gitlab-ci.yml 時照樣寫 checks.yml', t => {
  const root = repo(t, { origin: 'git@github.com:o/r.git', files: { '.gitlab-ci.yml': 'c:\n  script:\n    - bin/check\n' } });
  const result = ci(root);
  assert.doesNotMatch(result.stdout, /^CI_EXISTS /m);
  assert.equal(last(result), 'CI_WRITTEN .github/workflows/checks.yml');
});

test('沒有單一檢查入口：不寫 CI，exit 2', t => {
  const root = repo(t, { origin: 'git@github.com:o/r.git', files: { 'docs/agents/issue-run.md': '# a\n' } });
  rmSync(join(root, 'bin/check'));
  const result = ci(root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /檢查入口/);
  assert.equal(existsSync(join(root, '.github')), false);
});
