import path from 'node:path';
import { assert, digest } from './contracts.mjs';
import { GitLab } from './adapters.mjs';
import { atomicJSON, readJSON } from './store.mjs';
import { run } from './platform.mjs';

// GitLab's publication/note journals are reused, not its HTTP transport.
export class GitHub extends GitLab {
  constructor(p, cwd, runner = run) { super(p.origin, p.projectId, cwd, runner); this.projectPath = p.projectPath; }
  async api(endpoint, method = 'GET', data) {
    assert(['GET', 'POST', 'PUT'].includes(method), 'Unsupported tracker method');
    const project = endpoint.match(/^projects\/([^/]+)$/);
    let target, payload = data;
    if (project) target = `repos/${decodeURIComponent(project[1])}`;
    else {
      const m = endpoint.match(/^projects\/([^/]+)\/issues(?:\/(\d+))?(?:\/notes(?:\/(\d+))?)?(\?.*)?$/);
      assert(m && String(this.projectId) === m[1], 'Unsupported GitHub endpoint');
      const query = new URLSearchParams((m[4] ?? '').slice(1));
      // List all states/pages; do not rely on GitHub search's indexing or 1000-hit cap.
      query.delete('scope'); query.delete('search');
      if (endpoint.includes('/notes')) target = m[3] ? `repos/${this.projectPath}/issues/comments/${m[3]}` : `repos/${this.projectPath}/issues/${m[2]}/comments`;
      else target = `repos/${this.projectPath}/issues${m[2] ? `/${m[2]}` : ''}`;
      if (query.size) target += `?${query}`;
      if (data) { payload = { ...data }; if (payload.description !== undefined) { payload.body = payload.description; delete payload.description; } if (payload.state_event) { payload.state = payload.state_event === 'close' ? 'closed' : 'open'; delete payload.state_event; } }
    }
    let origin; try { origin = new URL(this.origin); } catch { throw new Error('Invalid GitHub origin'); }
    const args = ['api', target, '--hostname', origin.host, '--method', method === 'PUT' ? 'PATCH' : method, '--include'];
    if (payload !== undefined) args.push('--input', '-');
    let output;
    try { output = await this.runner('gh', args, { cwd: this.cwd, input: payload === undefined ? undefined : JSON.stringify(payload) }); }
    catch { throw new Error(`GitHub ${method} outcome unresolved; reconcile marker before retry`); }
    const envelope = output.toString().match(/^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*)$/u);
    assert(envelope && Number(envelope[1]) >= 200 && Number(envelope[1]) < 300, 'GitHub HTTP outcome unresolved');
    let result; try { result = JSON.parse(envelope[2]); } catch { throw new Error('GitHub returned invalid JSON; outcome unresolved'); }
    const normalize = r => {
      assert(r && typeof r === 'object', 'Invalid GitHub response');
      if (project) { assert(r.has_issues === true && r.id === this.projectId || this.projectId === undefined && r.has_issues === true, 'GitHub Issues disabled or repository identity changed'); return { ...r, path_with_namespace: r.full_name, web_url: r.html_url }; }
      return { ...r, ...(r.number ? { iid: r.number, project_id: this.projectId, description: r.body ?? '', state: r.state === 'open' ? 'opened' : r.state } : {}) };
    };
    if (Array.isArray(result)) this.lastPageSize = result.length;
    return Array.isArray(result) ? result.filter(r => !r.pull_request).map(normalize) : normalize(result);
  }
  // Filter PRs after pagination: an API page full of PRs is not an end-of-list signal.
  async pages(endpoint) {
    const rows = [];
    for (let page = 1; page <= 10000; page++) {
      const items = await this.api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      assert(Array.isArray(items), 'Expected GitHub paginated array'); rows.push(...items);
      if (this.lastPageSize < 100) return rows;
    }
    throw new Error('GitHub pagination incomplete');
  }
}
export class LocalTracker extends GitLab {
  constructor(p, store, cwd) { super(p.origin, p.projectId, cwd); this.store = store; this.projectPath = p.projectPath; this.file = path.join(store.root, 'local-tracker', `${p.projectId}.json`); }
  async api(endpoint, method = 'GET', data) {
    if (method === 'GET') return this.request(endpoint, method, data);
    return this.store.locked(`local-${digest(this.projectId).slice(0, 16)}`, () => this.request(endpoint, method, data), { repository: true });
  }
  async request(endpoint, method = 'GET', data) {
    assert(['GET', 'POST', 'PUT'].includes(method), 'Unsupported local tracker method');
    if (endpoint === `projects/${encodeURIComponent(this.projectPath)}`) return { id: this.projectId, path_with_namespace: this.projectPath, web_url: this.origin };
    const m = endpoint.match(/^projects\/([^/]+)\/issues(?:\/(\d+))?(?:\/notes(?:\/(\d+))?)?(?:\?(.*))?$/);
    assert(m && m[1] === String(this.projectId), 'Local tracker identity mismatch');
    const state = await readJSON(this.file) ?? { version: 1, nextIssue: 1, nextNote: 1, issues: [], notes: {} };
    assert(state.version === 1, 'Unsupported local tracker version');
    const iid = m[2] ? Number(m[2]) : null;
    let result;
    if (endpoint.includes('/notes')) {
      assert(state.issues.some(i => i.iid === iid), 'Local Issue absent');
      const notes = state.notes[iid] ??= [];
      if (method === 'POST') { result = { id: state.nextNote++, body: data.body }; notes.push(result); }
      else result = m[3] ? notes.find(n => n.id === Number(m[3])) : notes;
    } else if (method === 'POST') { result = { iid: state.nextIssue++, project_id: this.projectId, state: 'opened', ...data }; state.issues.push(result); }
    else if (iid) {
      result = state.issues.find(i => i.iid === iid); assert(result, 'Local Issue absent');
      if (method === 'PUT') { Object.assign(result, data); if (data.state_event === 'close') result.state = 'closed'; }
    } else result = state.issues;
    if (method !== 'GET') await atomicJSON(this.file, state);
    if (Array.isArray(result)) {
      const query = new URLSearchParams(m[4]); const page = Number(query.get('page') ?? 1);
      result = result.filter(r => !query.get('search') || r.description?.includes(query.get('search'))).slice((page - 1) * 100, page * 100);
    }
    assert(result !== undefined, 'Local record absent'); return structuredClone(result);
  }
}
export function trackerFor(p, store, cwd, runner) {
  if (p.provider === 'github') return new GitHub(p, cwd, runner);
  if (p.provider === 'local') return new LocalTracker(p, store, cwd);
  assert(p.provider === undefined || p.provider === 'gitlab', 'Unsupported tracker provider');
  return new GitLab(p.origin, p.projectId, cwd, runner);
}
export function noteURL(p, iid, noteId) { return `${p.provider === 'local' ? p.origin : p.origin + '/' + p.projectPath}${p.provider === 'github' ? `/issues/${iid}#issuecomment-${noteId}` : p.provider === 'local' ? `/issues/${iid}#note-${noteId}` : `/-/issues/${iid}#note_${noteId}`}`; }
