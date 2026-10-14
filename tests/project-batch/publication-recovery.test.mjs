import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLab } from '../../skills/in-progress/project-batch/scripts/lib/adapters.mjs';
import { fixture, plan } from './helpers.mjs';

const response = (status, body) => Buffer.from(`HTTP/1.1 ${status} Test\r\nX-Request-Id: trial-request-1\r\nSet-Cookie: PRIVATE_VALUE\r\n\r\n${JSON.stringify(body)}`);

test('GitLab transport pins the complete URL and verifies HTTP rather than CLI exit', async () => {
  const calls = [];
  const gl = new GitLab('http://gitlab.example:8080', 17, '.', async (file, args, options) => {
    calls.push({ file, args, options });
    return response(201, { iid: 101, project_id: 17 });
  });
  assert.equal((await gl.api('projects/17/issues', 'POST', { title: '中文 title' })).iid, 101);
  assert.deepEqual(calls[0].args, ['api', 'http://gitlab.example:8080/api/v4/projects/17/issues', '--hostname', 'gitlab.example', '--method', 'POST', '--include', '--header', 'Content-Type: application/json', '--input', '-']);
  assert.equal(calls[0].options.env.GITLAB_API_PROTOCOL, 'http');
  assert.deepEqual(JSON.parse(calls[0].options.input), { title: '中文 title' });
});

test('HTTP errors, missing envelopes and malformed JSON keep redacted transport evidence', async () => {
  const gl = new GitLab('https://gitlab.example', 17, '.', async () => response(400, { message: 'PRIVATE_BODY_VALUE' }));
  await assert.rejects(gl.api('projects/17/issues', 'POST', { title: 'trial' }), error => {
    assert.match(error.message, /HTTP 400/);
    assert.equal(error.transportReceipt.version, 1);
    assert.equal(error.transportReceipt.httpStatus, 400);
    assert.equal(error.transportReceipt.requestId, 'trial-request-1');
    assert.equal(error.transportReceipt.outcome, 'unresolved');
    assert.ok(!JSON.stringify(error.transportReceipt).includes('PRIVATE_'));
    assert.ok(!error.message.includes('PRIVATE_'));
    return true;
  });
  gl.runner = async () => Buffer.from('{"iid":101,"project_id":17}');
  await assert.rejects(gl.issue(101), error => error.transportReceipt.httpStatus === null && /verified HTTP/.test(error.message));
  gl.runner = async () => Buffer.from('HTTP/1.1 201 Created\nX-Request-Id: trial-request-1\n\nNOT_JSON_PRIVATE');
  await assert.rejects(gl.api('projects/17/issues', 'POST', { title: 'trial' }), error => {
    assert.equal(error.transportReceipt.httpStatus, 201);
    assert.equal(error.transportReceipt.outcome, 'unresolved');
    assert.ok(!error.message.includes('NOT_JSON_PRIVATE'));
    return true;
  });
  gl.runner = async () => { throw Object.assign(new Error('PRIVATE_STDERR_VALUE'), { stdout: response(403, {}), stderr: 'PRIVATE_STDERR_VALUE' }); };
  await assert.rejects(gl.issue(101), error => error.transportReceipt.httpStatus === 403 && !error.message.includes('PRIVATE_'));
  await assert.rejects(gl.api('http://different-host/projects/17/issues'), /endpoint/);
});

test('failed create saves HTTP receipt before stopping and does not blindly re-POST', async t => {
  const f = await fixture(t), s = await f.batch.store.load('demo');
  let posts = 0;
  const gl = new GitLab('https://gitlab.example', 17, f.git.cwd, async (_file, args) => {
    if (args[args.indexOf('--method') + 1] === 'POST') {
      posts++;
      return response(400, { message: 'PRIVATE_BODY_VALUE' });
    }
    return response(200, []);
  });
  const create = state => gl.ensureIssue(state, '@probe', 'Trial', 'Exact description', f.batch.save);
  await assert.rejects(create(s), /HTTP 400/);
  const saved = await f.batch.store.load('demo');
  assert.equal(saved.operations['issue-@probe'].status, 'attempted');
  assert.equal(saved.operations['issue-@probe'].transport.httpStatus, 400);
  assert.equal(saved.operations['issue-@probe'].transport.requestId, 'trial-request-1');
  assert.ok(!JSON.stringify(saved.operations['issue-@probe']).includes('PRIVATE_'));
  await assert.rejects(create(saved), /outcome uncertain/);
  assert.equal(posts, 1);
  await assert.rejects(gl.note(saved, 101, 'failed-note', 'Exact queued body', f.batch.save), /HTTP 400/);
  const note = (await f.batch.store.load('demo')).operations['failed-note'];
  assert.equal(note.iid, 101);
  assert.equal(note.transport.httpStatus, 400);
  await assert.rejects(gl.note(saved, 101, 'failed-note', 'Exact queued body', f.batch.save), /outcome uncertain/);
  assert.equal(posts, 2);
});

async function failedDraft(t) {
  const f = await fixture(t);
  const p = plan(2); p.id = 'publication-recovery';
  const draft = await f.batch.plan(p);
  f.tracker.fail = (_endpoint, method) => method === 'POST';
  await assert.rejects(f.batch.publish(p.id, draft.confirm), /ambiguous/);
  f.tracker.fail = null;
  return { ...f, recoveryId: p.id, input: { version: 1, key: '@parent', evidence: { source: 'human', conclusion: 'not_created', description: 'Human checked the exact failed request and confirms no Issue was created.' } } };
}

test('publication recovery needs exact human evidence and preview; it does not create Issues', async t => {
  const f = await failedDraft(t);
  const before = await f.batch.store.load(f.recoveryId), posts = f.tracker.calls.filter(c => c.method === 'POST').length;
  const missing = await f.batch.recoverPublication(f.recoveryId, { version: 1, key: '@parent' });
  assert.equal(missing.confirm, undefined);
  assert.match(missing.requiredHumanEvidence, /not.created/i);
  assert.deepEqual(await f.batch.store.load(f.recoveryId), before);
  const preview = await f.batch.recoverPublication(f.recoveryId, f.input);
  assert.equal(preview.action, 'recover-publication');
  assert.deepEqual(preview.payload.previous, before.operations['issue-@parent']);
  assert.equal(preview.payload.request.body.title, before.plan.title);
  assert.equal(preview.payload.readBackMatches, 0);
  assert.deepEqual(await f.batch.store.load(f.recoveryId), before);
  await assert.rejects(f.batch.recoverPublication(f.recoveryId, f.input, 'wrong-token'), /stale/);
  assert.equal(f.tracker.calls.filter(c => c.method === 'POST').length, posts);
  await f.batch.recoverPublication(f.recoveryId, f.input, preview.confirm);
  const authorized = await f.batch.store.load(f.recoveryId);
  assert.equal(authorized.operations['issue-@parent'].status, 'retry_authorized');
  assert.equal(authorized.operations['issue-@parent'].history[0].version, 1);
  assert.deepEqual(authorized.operations['issue-@parent'].history[0].previous, before.operations['issue-@parent']);
  assert.equal(f.tracker.calls.filter(c => c.method === 'POST').length, posts);
  const publish = await f.batch.publish(f.recoveryId);
  await f.batch.publish(f.recoveryId, publish.confirm);
  const ready = await f.batch.store.load(f.recoveryId);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.operations['issue-@parent'].history.length, 1);
  assert.equal(ready.operations['issue-@parent'].history[0].evidence.description, f.input.evidence.description);
});

test('publication recovery rejects stale state, changed request and evidence gaps', async t => {
  const f = await failedDraft(t), id = f.recoveryId;
  await assert.rejects(f.batch.recoverPublication(id, { ...f.input, key: 'not-planned' }), /planned/);
  await assert.rejects(f.batch.recoverPublication(id, { ...f.input, evidence: { ...f.input.evidence, source: 'agent' } }), /human/);
  await assert.rejects(f.batch.recoverPublication(id, { ...f.input, evidence: { ...f.input.evidence, description: ' ' } }), /evidence/);
  const preview = await f.batch.recoverPublication(id, f.input);
  const s = await f.batch.store.load(id); s.operations['issue-@parent'].diagnostic = 'new fact'; await f.batch.save(s);
  await assert.rejects(f.batch.recoverPublication(id, f.input, preview.confirm), /stale/);
  const current = await f.batch.recoverPublication(id, f.input);
  await f.batch.recoverPublication(id, f.input, current.confirm);
  const authorized = await f.batch.store.load(id);
  await assert.rejects(f.tracker.ensureIssue(authorized, '@parent', 'Unconfirmed title', 'Changed description', f.batch.save), /request/);
  assert.equal((await f.batch.store.load(id)).operations['issue-@parent'].status, 'retry_authorized');
});

test('marker appearing before recovery confirmation blocks another create; execution checkout cannot reconcile', async t => {
  const f = await failedDraft(t), id = f.recoveryId;
  const preview = await f.batch.recoverPublication(id, f.input);
  await assert.rejects(f.execution.recoverPublication(id, f.input), /target checkout/);
  const before = await f.batch.store.load(id);
  f.tracker.rows.set(9090, { iid: 9090, project_id: 17, state: 'opened', title: before.plan.title, description: `<!-- project-batch:v1:${id}:issue-@parent -->\nRecovered externally` });
  await assert.rejects(f.batch.recoverPublication(id, f.input, preview.confirm), /marker exists/);
  assert.deepEqual(await f.batch.store.load(id), before);
});

test('interrupted authorized retry retains history and requires a new exact recovery', async t => {
  const f = await failedDraft(t), id = f.recoveryId;
  const recovery = await f.batch.recoverPublication(id, f.input);
  await f.batch.recoverPublication(id, f.input, recovery.confirm);
  f.tracker.fail = (_endpoint, method) => method === 'POST';
  const publish = await f.batch.publish(id);
  await assert.rejects(f.batch.publish(id, publish.confirm), /ambiguous/);
  const stopped = await f.batch.store.load(id);
  assert.equal(stopped.operations['issue-@parent'].status, 'attempted');
  assert.equal(stopped.operations['issue-@parent'].history.length, 1);
  f.tracker.fail = null;
  const posts = f.tracker.calls.filter(c => c.method === 'POST').length;
  await assert.rejects(f.batch.publish(id, publish.confirm), /outcome uncertain/);
  assert.equal(f.tracker.calls.filter(c => c.method === 'POST').length, posts);
  await assert.rejects(f.batch.recoverPublication(id, f.input, recovery.confirm), /stale/);
  const second = await f.batch.recoverPublication(id, f.input);
  await f.batch.recoverPublication(id, f.input, second.confirm);
  await f.batch.publish(id, publish.confirm);
  const ready = await f.batch.store.load(id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.operations['issue-@parent'].history.length, 2);
  assert.deepEqual(ready.operations['issue-@parent'].history[0], stopped.operations['issue-@parent'].history[0]);
});

test('legacy attempts require confirmation; future records and already assigned IIDs fail closed', async t => {
  const f = await failedDraft(t), id = f.recoveryId, before = await f.batch.store.load(id);
  for (const fields of [{ request: { version: 2 } }, { transport: { version: 2 } }, { history: [{ version: 2 }] }]) {
    const unsupported = structuredClone(before);
    Object.assign(unsupported.operations['issue-@parent'], fields);
    await f.batch.save(unsupported);
    await assert.rejects(f.batch.recoverPublication(id, f.input), /record version/);
    assert.deepEqual(await f.batch.store.load(id), unsupported);
  }
  const legacy = structuredClone(before);
  legacy.operations['issue-@parent'] = { status: 'attempted' };
  await f.batch.save(legacy);
  const preview = await f.batch.recoverPublication(id, f.input);
  assert.match(preview.payload.uncertainty, /Legacy/);
  assert.deepEqual(await f.batch.store.load(id), legacy);
  legacy.publication.rootIID = 9999;
  await f.batch.save(legacy);
  await assert.rejects(f.batch.recoverPublication(id, f.input), /unassigned/);
  const running = structuredClone(before); running.runtime = { owner: { session: 'active', generation: 1 } };
  await f.batch.save(running);
  await assert.rejects(f.batch.recoverPublication(id, f.input), /unstarted draft/);
});
