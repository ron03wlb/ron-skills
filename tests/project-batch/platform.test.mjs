import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { writeFile, chmod, readFile } from 'node:fs/promises';
import { fixture } from './helpers.mjs';
import { Orca } from '../../skills/in-progress/project-batch/scripts/lib/adapters.mjs';
import { run } from '../../skills/in-progress/project-batch/scripts/lib/platform.mjs';
import { marker } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';

test('Orca current must belong to the bound Git repository before create', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other repo'); await run('git', ['init', other]);
  const orca = new Orca(f.git.cwd);
  orca.current = async () => ({ id: 'other::path', repoId: 'other', path: other, branch: 'main', identity: { key: 'wt2:local:other', executionHostId: 'local' } });
  orca.call = async () => { throw new Error('Unexpected mutation'); };
  await assert.rejects(orca.create(await f.batch.store.load('demo'), f.batch.save), /does not match/);
});
test('unowned same-name worktree cannot be adopted; uncertain create uses its exact marker', async t => {
  const f = await fixture(t), s = await f.batch.store.load('demo'), orca = new Orca(f.git.cwd);
  orca.current = async () => ({ id: 'repo::target', repoId: 'repo', path: f.git.cwd, branch: 'main', identity: { key: 'wt2:local:target', executionHostId: 'local' } });
  const w = { id: 'repo::batch', repoId: 'repo', path: f.execution.git.cwd, branch: 'project-batch-demo', displayName: 'project-batch-demo', identity: { key: 'wt2:local:batch', executionHostId: 'local' }, comment: marker('demo', 'worktree') };
  orca.list = async () => [w]; orca.call = async () => { throw new Error('No duplicate create permitted'); };
  await assert.rejects(orca.create(s, f.batch.save), /Unowned/);
  s.operations.worktree = { status: 'attempted', repoId: 'repo', name: 'project-batch-demo' };
  w.comment = ''; await assert.rejects(orca.create(s, f.batch.save), /operation marker/);
  w.comment = marker('demo', 'worktree'); const recovered = await orca.create(s, f.batch.save);
  assert.equal(recovered.identity, 'wt2:local:batch'); assert.equal(s.operations.worktree.status, 'read_back');
});
test('public CLI SIGINT stops the active subprocess group and exits with 130', { timeout: 20000 }, async t => {
  const f = await fixture(t), exe = path.join(f.root, 'slow Orca 中文'), readyFile = path.join(f.root, 'child-ready'), stoppedFile = path.join(f.root, 'child-stopped');
  await writeFile(exe, `#!/usr/bin/env node\nconst fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(process.env.STOPPED_FILE,'stopped');process.exit(0)});fs.writeFileSync(process.env.READY_FILE,'ready');setInterval(()=>{},1000);\n`);
  await chmod(exe, 0o755);
  let ready; const launched = new Promise(resolve => { ready = resolve; });
  const watcher = watch(f.root, (_event, name) => { if (name === 'child-ready') ready(); }); t.after(() => watcher.close());
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../skills/in-progress/project-batch/scripts/project-batch.mjs'), 'doctor', '--cwd', f.git.cwd], { env: { ...process.env, ORCA_CLI_COMMAND: exe, READY_FILE: readyFile, STOPPED_FILE: stoppedFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; }); child.stdout.on('data', () => {});
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  await launched; watcher.close(); child.kill('SIGINT');
  assert.equal(await finished, 130, stderr); assert.equal(await readFile(stoppedFile, 'utf8'), 'stopped');
});
