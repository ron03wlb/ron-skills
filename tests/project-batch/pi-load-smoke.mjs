#!/usr/bin/env node
// Real-host resource/schema smoke only. No session, model request, or tracker writes.
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

try {
  assert.equal(process.argv.length, 4, 'Usage: node tests/project-batch/pi-load-smoke.mjs --pi-root <installed-pi-coding-agent-package>');
  assert.equal(process.argv[2], '--pi-root');
  const root = path.resolve(process.argv[3]);
  const sdk = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
  const ai = await import(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'batch-pi-load-'));
  try {
    const skill = path.resolve(import.meta.dirname, '../../skills/in-progress/project-batch');
    const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [path.join(skill, 'extensions/session-handoff.ts')], additionalSkillPaths: [skill] });
    await loader.reload();
    const result = loader.getExtensions(); assert.deepEqual(result.errors, []);
    assert.deepEqual(loader.getSkills().skills.map(s => s.name), ['project-batch']);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.deepEqual([...extension.commands.keys()], ['project-batch-next']);
    assert.deepEqual([...extension.tools.keys()], ['project_batch_claim', 'project_batch_checkpoint']);
    const tool = extension.tools.get('project_batch_checkpoint').definition;
    const handoff = { summary: 'pause', completed: [], remaining: [], verification: [], blockers: [], decisions: [], next: [] };
    assert.equal(ai.validateToolArguments(tool, { name: tool.name, arguments: { ref: '#101', action: 'checkpoint', handoff } }).action, 'checkpoint');
    assert.equal(ai.validateToolArguments(tool, { name: tool.name, arguments: { ref: '#101', action: 'schema-stop', reason: 'New unapproved column' } }).action, 'schema-stop');
    assert.equal(ai.validateToolArguments(tool, { name: tool.name, arguments: { ref: '#101', action: 'cleanup' } }).action, 'cleanup');
    const claim = extension.tools.get('project_batch_claim').definition;
    assert.equal(ai.validateToolArguments(claim, { name: claim.name, arguments: { ref: '#101' } }).ref, '#101');
    assert.throws(() => ai.validateToolArguments(tool, { name: tool.name, arguments: { ref: '#101', action: 'integrate' } }), /Validation failed/);
    console.log(JSON.stringify({ result: 'pass', skill: 'project-batch', command: 'project-batch-next', tool: tool.name, schema: 'accepts claim/checkpoint/schema-stop/cleanup, refuses integrate', limit: 'load/schema smoke, not interactive TUI or reviewer execution' }));
  } finally { await rm(dir, { recursive: true, force: true }); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
