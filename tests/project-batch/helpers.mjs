import { mkdtemp, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Batch } from '../../skills/in-progress/project-batch/scripts/lib/runtime.mjs';
import { Git, run } from '../../skills/in-progress/project-batch/scripts/lib/platform.mjs';
import { GitLab } from '../../skills/in-progress/project-batch/scripts/lib/adapters.mjs';

export const issue = (key, dependsOn = []) => ({ key, title: key, goal: 'Deliver behavior', scope: 'Complete behavior', exclusions: 'No deployment', criteria: [`${key} works`], dependsOn, external: [], prerequisites: [], verify: [{ file: process.execPath, args: ['-e', 'process.exit(0)'] }] });
export function plan(count = 1) {
  const issues = Array.from({ length: count }, (_, n) => issue(`i${n + 1}`, n ? [`i${n}`] : []));
  return { version: 1, id: 'demo', revision: 1, origin: 'https://gitlab.example', projectPath: 'team/app', projectId: 17, title: 'Behavior batch', targetBranch: 'main', issues, segments: [{ id: 'A', domain: 'payments', issues: issues.slice(0, 2).map(i => i.key), effort: 'small, exploration + tests', verificationCost: 'one minute', handoffCondition: 'accepted members' }, ...(count > 2 ? [{ id: 'B', domain: 'reconciliation', issues: issues.slice(2).map(i => i.key), effort: 'small', verificationCost: 'one minute', handoffCondition: 'all accepted' }] : [])], verify: [{ file: process.execPath, args: ['-e', 'process.exit(0)'] }] };
}
export const handoff = () => ({ summary: 'Bounded checkpoint', completed: [], remaining: [], verification: [], blockers: [], decisions: [], next: ['Continue recorded work segment'] });
export class MockTracker extends GitLab {
  constructor() { super('https://gitlab.example', 17, '.'); this.rows = new Map(); this.notes = new Map(); this.nextIID = 100; this.nextNote = 1; this.calls = []; this.fail = null; }
  async api(endpoint, method = 'GET', data) {
    this.calls.push({ endpoint, method, data });
    if (this.fail?.(endpoint, method, data)) throw new Error('mock offline/ambiguous response');
    if (endpoint === 'projects/team%2Fapp') return { id: 17, path_with_namespace: 'team/app', web_url: 'https://gitlab.example/team/app' };
    const m = endpoint.match(/^projects\/17\/issues(?:\/(\d+))?(?:\/notes(?:\/(\d+))?)?(?:\?(.*))?$/);
    if (!m) throw new Error(`Unexpected endpoint ${endpoint}`);
    const iid = m[1] ? Number(m[1]) : null;
    if (endpoint.includes('/notes')) {
      const rows = this.notes.get(iid) ?? []; this.notes.set(iid, rows);
      if (method === 'POST') { const n = { id: this.nextNote++, body: data.body }; rows.push(n); return structuredClone(n); }
      return structuredClone(m[2] ? rows.find(n => n.id === Number(m[2])) : rows);
    }
    if (method === 'POST') {
      const row = { iid: ++this.nextIID, project_id: 17, state: 'opened', ...data }; this.rows.set(row.iid, row); return structuredClone(row);
    }
    if (method === 'PUT') {
      const row = this.rows.get(iid); Object.assign(row, data); if (data.state_event === 'close') row.state = 'closed'; return structuredClone(row);
    }
    if (iid) return structuredClone(this.rows.get(iid));
    const query = new URLSearchParams(m[3]); const page = Number(query.get('page') ?? 1), search = query.get('search') ?? '';
    return structuredClone([...this.rows.values()].filter(r => r.description.includes(search)).slice((page - 1) * 100, page * 100));
  }
}
export async function fixture(t, count = 1, configure = async () => {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gitlab batch 中文 ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'target checkout');
  await run('git', ['init', '-b', 'main', repo]);
  const git = new Git(repo);
  await git.text(['config', 'user.name', 'Batch Tests']); await git.text(['config', 'user.email', 'batch@example.test']);
  await git.text(['remote', 'add', 'origin', 'https://gitlab.example/team/app.git']);
  await writeFile(path.join(repo, 'base.txt'), 'baseline\n'); await git.text(['add', '.']); await git.text(['commit', '-m', 'baseline']);
  const tracker = new MockTracker(), calls = [], worktrees = new Map();
  let removeFails = false, reviews = 'pass';
  const runner = async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === 'git' && args.includes('push')) throw new Error('PUSH FORBIDDEN');
    if (file === 'pi' && args.includes('--print')) {
      const p = JSON.parse(await readFile(path.join(options.cwd, 'packet.json'), 'utf8'));
      const prompt = args.at(-1), shard = p.shards.find(s => prompt.includes(`"shard":"${s}"`));
      if (reviews === 'invalid') return Buffer.from('not JSON');
      return Buffer.from(JSON.stringify({ version: 1, target: p.target, candidate: p.candidate, shard, status: reviews, findings: [] }));
    }
    return run(file, args, options);
  };
  const orca = {
    preflight: async () => ({ version: 'mock', executable: 'mock' }),
    create: async s => {
      const wt = path.join(root, 'batch worktree 中文');
      await git.text(['worktree', 'add', '-b', 'project-batch-demo', wt, s.plan.targetBranch]);
      const a = { id: `repo::${wt}`, identity: 'wt2:mock:1', repoId: 'repo', path: wt, branch: 'project-batch-demo' }; worktrees.set(a.id, a); return a;
    },
    verify: async a => { if (!worktrees.has(a.id)) throw new Error('Orca identity absent'); },
    launch: async (s, skill, prompt, save) => { s.operations.terminal = { status: 'accepted', handle: 'mock-terminal', prompt }; await save(s); return s.operations.terminal; },
    list: async () => [...worktrees.values()].map(a => ({ id: a.id, identity: { key: a.identity } })),
    remove: async a => { if (removeFails) throw new Error('mock cleanup failure'); await git.text(['worktree', 'remove', a.path]); worktrees.delete(a.id); },
  };
  const options = { runner, trackerFactory: () => tracker, orca };
  const batch = await Batch.open(repo, options), p = plan(count);
  await configure(p, { tracker, git });
  const draft = await batch.plan(p); await batch.publish(p.id, draft.confirm);
  const s = await batch.store.load(p.id), ref = `https://gitlab.example/team/app/-/issues/${s.publication.rootIID}`;
  const preview = await batch.start(ref); await batch.start(ref, preview.confirm);
  const started = await batch.store.load(p.id), execution = await Batch.open(started.runtime.worktree.path, options);
  const session = started.runtime.launchSession;
  await execution.resume(ref, { session });
  const owner = async () => (await batch.store.load(p.id)).runtime.owner;
  const step = async (action, input, extra = {}) => execution.step(ref, { action, input, ...await owner(), ...extra });
  const accept = async key => {
    await step('begin');
    await writeFile(path.join(execution.git.cwd, `${key}.txt`), `${key} accepted\n`);
    return step('accept', { key, paths: [`${key}.txt`], message: `Deliver ${key}`, criteria: [{ criterion: `${key} works`, passed: true, evidence: 'observable test result' }] });
  };
  return { root, git, batch, execution, tracker, p, ref, session, calls, options, step, accept, owner, worktrees, setRemoveFails: value => { removeFails = value; }, setReview: value => { reviews = value; } };
}
