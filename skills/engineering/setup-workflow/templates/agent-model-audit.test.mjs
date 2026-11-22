// 由 setup-workflow 範本同步，勿在此改：改正本後以 copy-templates.mjs 複製（副本清單 docs/agents/workflow-templates.json）。
// agent-model-audit.mjs 測試（retro cf16948a#1；#373 通用化）：假 transcript fixture。
import './test/isolate-git-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir } from './test/real-tmpdir.mjs';

const script = new URL('./agent-model-audit.mjs', import.meta.url).pathname;
const cmd = (name) => ({ type: 'user', message: { role: 'user', content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>` } });
const agent = (input, name = 'Agent') => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
const skill = (s) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: s } }] } });
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const run = (args, options = {}) => spawnSync('node', [script, ...args], { encoding: 'utf8', ...options });

function tmp(t, prefix) {
  const dir = mkdtempSync(join(realTmpdir(), `${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('依 slash 指令與 Skill 歸屬、略過 Explore、壞行不中斷', t => {
  const dir = tmp(t, 'ama');
  mkdirSync(join(dir, '-home-u-code-proj', 's1', 'subagents'), { recursive: true });
  writeFileSync(join(dir, '-home-u-code-proj', 's1.jsonl'), jl([
    cmd('retro-collect'),
    agent({ description: 'scan A', subagent_type: 'general-purpose' }),
    agent({ description: 'scan B', subagent_type: 'general-purpose' }, 'Task'),
    agent({ description: 'scan C', model: 'sonnet' }),
    agent({ description: 'find', subagent_type: 'Explore' }),
  ]) + 'not json\n' + jl([
    skill('code-review'),
    agent({ description: 'review std' }),
  ]));
  writeFileSync(join(dir, '-home-u-code-proj', 's1', 'subagents', 'a.jsonl'), jl([]));
  const r = run(['--dir', dir, '--project', 'proj']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'UNMODELED retro-collect 2 scan B',
    'UNMODELED code-review 1 review std',
    'SUMMARY transcripts=2 agents=4 unmodeled=3',
  ]);
});

test('--limit 只取最新的檔', t => {
  const dir = tmp(t, 'ama');
  mkdirSync(join(dir, '-p'));
  const a = join(dir, '-p', 'old.jsonl'), b = join(dir, '-p', 'new.jsonl');
  writeFileSync(a, jl([cmd('x'), agent({ description: 'old' })]));
  writeFileSync(b, jl([cmd('y'), agent({ description: 'new' })]));
  utimesSync(a, 1000, 1000);
  const r = run(['--dir', dir, '--limit', '1', '--project', 'p']);
  assert.equal(r.stdout.trim(), 'UNMODELED y 1 new\nSUMMARY transcripts=1 agents=1 unmodeled=1');
});

test('--project 只讀名稱含該子字串的專案目錄；子字串的 . 與 _ 照 Claude Code 目錄名換成 -', t => {
  const dir = tmp(t, 'ama');
  for (const [name, desc] of [['-home-u-code-my-repo', 'mine'], ['-home-u-orca-workspaces-my-repo-issue-1', 'wt'], ['-home-u-code-other', 'other']]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, `${desc}.jsonl`), jl([cmd(desc), agent({ description: desc })]));
  }
  const r = run(['--dir', dir, '--project', 'my_repo']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').sort(), [
    'SUMMARY transcripts=2 agents=2 unmodeled=2',
    'UNMODELED mine 1 mine',
    'UNMODELED wt 1 wt',
  ]);
});

test('沒帶 --project 時取目前 repo 主 checkout 的目錄名（worktree 也一樣）；不在 git repo 時取目前目錄名', t => {
  const dir = tmp(t, 'ama');
  const root = join(dir, 'projects');
  for (const name of ['-x-alpha-repo', '-x-wt-dir', '-x-plain-dir']) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 's.jsonl'), jl([cmd(name.slice(3)), agent({ description: name })]));
  }
  const repo = join(dir, 'alpha.repo');
  mkdirSync(repo);
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', join(dir, 'wt-dir'));
  for (const cwd of [repo, join(dir, 'wt-dir')]) {
    const r = run(['--dir', root], { cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'UNMODELED alpha-repo 1 -x-alpha-repo\nSUMMARY transcripts=1 agents=1 unmodeled=1', cwd);
  }
  const plain = join(dir, 'plain-dir');
  mkdirSync(plain);
  const r = run(['--dir', root], { cwd: plain });
  assert.equal(r.stdout.trim(), 'UNMODELED plain-dir 1 -x-plain-dir\nSUMMARY transcripts=1 agents=1 unmodeled=1');
});

test('沒有 transcripts：根目錄不存在或沒有相符的專案目錄時 stderr 印 WARN、exit 0、SUMMARY 為 0', t => {
  const dir = tmp(t, 'ama');
  mkdirSync(join(dir, '-home-u-other'));
  const none = run(['--dir', dir, '--project', 'proj']);
  assert.equal(none.status, 0);
  assert.match(none.stderr, /^WARN \S+ 沒有名稱含 proj 的專案目錄$/m);
  assert.equal(none.stdout.trim(), 'SUMMARY transcripts=0 agents=0 unmodeled=0');
  const missing = run(['--dir', join(dir, 'nope'), '--project', 'proj']);
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /^WARN \S+nope ENOENT$/m);
  assert.equal(missing.stdout.trim(), 'SUMMARY transcripts=0 agents=0 unmodeled=0');
  assert.equal(run(['--project']).status, 2);
});
