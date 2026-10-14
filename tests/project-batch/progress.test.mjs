import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, handoff } from './helpers.mjs';
import { digest, marker } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';

for (const count of [1, 3]) test(`${count} member publication exposes complete root plan and member execution`, async t => {
  const f = await fixture(t, count), s = await f.batch.store.load('demo');
  const root = await f.tracker.issue(s.publication.rootIID);
  assert.ok(root.description.includes(JSON.stringify(s.plan, null, 2)));
  assert.match(root.description, /Confirmed BatchPlan v1.*revision 1.*SHA256/);
  for (const i of s.plan.issues) {
    const member = await f.tracker.issue(s.publication.members[i.key]);
    assert.match(member.description, /targetBranch/);
    assert.match(member.description, /handoffCondition/);
    assert.ok(member.description.includes(f.ref));
  }
  assert.equal(f.tracker.rows.size, count === 1 ? 1 : count + 1);
});

test('member acceptance followed by linked parent summary recovers only remaining destination', async t => {
  const f = await fixture(t, 2), s = await f.batch.store.load('demo');
  f.tracker.fail = (endpoint, method) => endpoint.includes(`/${s.publication.rootIID}/notes`) && method === 'GET';
  const r = await f.accept('i1'); assert.match(r.synchronizationError, /offline/);
  const pending = (await f.batch.store.load('demo')).runtime.pendingSync;
  assert.equal(pending.position, 1); assert.equal(pending.items[0].iid, s.publication.members.i1);
  const note = f.tracker.notes.get(s.publication.members.i1)[0];
  assert.match(note.body, /observable test result/); assert.ok(note.body.includes(r.runtime.acceptance.i1.commit));
  assert.ok(!note.body.includes('"log":'));
  await assert.rejects(f.step('begin'), /Pending tracker/);
  f.tracker.fail = null; await f.step('sync'); await f.step('sync');
  assert.equal(f.tracker.notes.get(s.publication.members.i1).length, 1);
  assert.equal(f.tracker.calls.filter(c => c.method === 'POST' && c.endpoint.includes(`/${s.publication.members.i1}/notes`)).length, 1);
  const summary = f.tracker.notes.get(s.publication.rootIID)[0];
  assert.ok(summary.body.includes(`${f.p.origin}/${f.p.projectPath}/-/issues/${s.publication.members.i1}#note_${note.id}`));
  assert.equal((await f.step('begin')).issue.key, 'i2');
});

test('checkpoint appends to offline acceptance queue without dropping member evidence or uploading fingerprint', async t => {
  const f = await fixture(t, 2);
  f.tracker.fail = (e, m) => e.includes('/notes') && m === 'GET';
  await f.accept('i1'); await f.step('checkpoint', handoff());
  const s = await f.batch.store.load('demo'); assert.equal(s.runtime.pendingSync.items.length, 3);
  assert.ok(s.runtime.handoff.fingerprint); assert.ok(!s.runtime.pendingSync.items[2].text.includes('"fingerprint"'));
  f.tracker.fail = null; await f.step('sync');
  assert.equal(f.tracker.notes.get(s.publication.members.i1).length, 1);
  assert.equal(f.tracker.notes.get(s.publication.rootIID).length, 2);
});

test('legacy pending record retains exact original root destination, body and operation key', async t => {
  const f = await fixture(t, 2), s = await f.batch.store.load('demo');
  s.runtime.pendingSync = { key: 'legacy-accepted', text: '{"issue":"i1","legacy":true}' }; await f.batch.save(s);
  await f.step('sync');
  assert.equal(f.tracker.notes.get(s.publication.rootIID)[0].body, `${marker('demo', 'legacy-accepted')}\n${s.runtime.pendingSync.text}`);
  assert.equal(f.tracker.notes.has(s.publication.members.i1), false);
});

test('lost member note read-back recovers by exact marker without repeating either destination', async t => {
  const f = await fixture(t, 2), state = await f.batch.store.load('demo');
  f.tracker.fail = (e, m) => e.includes(`/${state.publication.members.i1}/notes/`) && m === 'GET';
  const r = await f.accept('i1'); assert.match(r.synchronizationError, /offline/);
  assert.equal((await f.batch.store.load('demo')).runtime.pendingSync.position, 0);
  f.tracker.fail = null; await f.step('sync');
  assert.equal(f.tracker.notes.get(state.publication.members.i1).length, 1);
  assert.equal(f.tracker.notes.get(state.publication.rootIID).length, 1);
});

test('an old published running format cannot be silently upgraded; pending original evidence blocks revision', async t => {
  const f = await fixture(t), s = await f.batch.store.load('demo'), root = f.tracker.rows.get(s.publication.rootIID);
  root.description = root.description.split('## Confirmed BatchPlan')[0];
  s.publication.descriptions[root.iid] = digest({ title: root.title, description: root.description });
  s.state = 'ready'; await f.batch.save(s);
  const before = root.description;
  await assert.rejects(f.batch.publish('demo', (await f.batch.publish('demo')).confirm), /confirm a revision/);
  assert.equal(root.description, before);
  s.state = 'handoff_ready'; s.runtime.pendingSync = { key: 'old-note', text: 'Original authorized body' }; await f.batch.save(s);
  const p = structuredClone(f.p); p.revision++;
  await assert.rejects(f.batch.revise('demo', p), /original pending/);
});

test('member integration notes carry own accepted commit, candidate and local-only evidence', async t => {
  const f = await fixture(t, 2); await f.accept('i1'); await f.accept('i2'); await f.step('checkpoint', handoff());
  await assert.rejects(f.execution.review(f.ref), /target checkout/);
  await f.batch.review(f.ref); await assert.rejects(f.execution.integrate(f.ref), /target checkout/);
  const s = await f.batch.store.load('demo'), token = (await f.batch.integrate(f.ref)).confirm;
  await f.batch.integrate(f.ref, token);
  for (const i of s.plan.issues) {
    const note = f.tracker.notes.get(s.publication.members[i.key]).find(n => n.body.includes('Locally integrated'));
    assert.match(note.body, /NOT pushed/); assert.ok(note.body.includes(s.runtime.acceptance[i.key].commit));
    assert.ok(note.body.includes(s.runtime.candidate.candidate)); assert.match(note.body, /"targetBranch":"main"/);
    assert.match(note.body, /observable test result/); assert.ok(!note.body.includes('"log":'));
  }
  assert.match(f.tracker.notes.get(s.publication.rootIID).find(n => n.body.includes('Locally integrated')).body, /"members"/);
});
