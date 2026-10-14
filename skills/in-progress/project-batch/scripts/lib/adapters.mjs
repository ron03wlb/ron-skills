import { realpath } from 'node:fs/promises';
import { assert, digest, marker } from './contracts.mjs';
import { Git, run, orcaExecutable, localOrcaPath, quote } from './platform.mjs';

function url(value) {
  try { return new URL(value); } catch { throw new Error('Invalid adapter URL'); }
}
function json(bytes) {
  try { return JSON.parse(bytes.toString()); } catch { throw new Error('CLI returned invalid JSON'); }
}
const httpReceipt = Symbol('project-batch HTTP receipt');
function envelope(output, origin, endpoint, method) {
  const match = String(output ?? '').match(/^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n([\s\S]*)$/u);
  return { body: match?.[3], receipt: { version: 1, origin, endpoint, method,
    httpStatus: match ? Number(match[1]) : null,
    requestId: match?.[2].match(/^x-request-id:\s*([a-zA-Z0-9_.-]{1,128})\s*$/imu)?.[1] ?? null,
    bodyHash: match ? digest(match[3]) : null, outcome: 'unresolved' } };
}
function transportError(method, receipt, detail) {
  return Object.assign(new Error(`GitLab ${method} ${detail}${receipt.httpStatus === null ? ' without a verified HTTP result' : ` (HTTP ${receipt.httpStatus})`}.`),
    { code: 'PROJECT_BATCH_TRANSPORT', transportReceipt: receipt });
}
export function issueCreateRequest(p, key, title, description) {
  const body = { title, description: `${marker(p.id, `issue-${key}`)}\n${description}` };
  return { version: 1, origin: p.origin, projectId: p.projectId, endpoint: `projects/${p.projectId}/issues`, method: 'POST', body,
    hash: digest({ origin: p.origin, projectId: p.projectId, body }) };
}
export class GitLab {
  constructor(origin, projectId, cwd, runner = run) {
    this.origin = origin; this.projectId = projectId; this.cwd = cwd; this.runner = runner;
  }
  async api(endpoint, method = 'GET', data) {
    const origin = url(this.origin);
    assert(['http:', 'https:'].includes(origin.protocol) && origin.origin === this.origin && !origin.username && !origin.password, 'Invalid GitLab origin');
    assert(typeof endpoint === 'string' && endpoint.startsWith('projects/') && !endpoint.includes('..') && !endpoint.includes('://'), 'Unsupported GitLab endpoint');
    assert(['GET', 'POST', 'PUT'].includes(method), 'Unsupported GitLab method');
    const args = ['api', `${origin.origin}/api/v4/${endpoint}`, '--hostname', origin.hostname, '--method', method, '--include'];
    if (data !== undefined) args.push('--header', 'Content-Type: application/json', '--input', '-');
    let output;
    try {
      output = await this.runner('glab', args, { cwd: this.cwd, input: data === undefined ? undefined : JSON.stringify(data),
        env: { ...process.env, GITLAB_API_PROTOCOL: origin.protocol.slice(0, -1) } });
    } catch (error) {
      throw transportError(method, envelope(error.stdout, this.origin, endpoint, method).receipt, 'request failed');
    }
    const { receipt, body } = envelope(output, this.origin, endpoint, method);
    if (receipt.httpStatus === null || receipt.httpStatus < 200 || receipt.httpStatus >= 300) throw transportError(method, receipt, 'request failed');
    let result;
    try { result = JSON.parse(body); } catch { throw transportError(method, receipt, 'returned invalid JSON'); }
    if (!result || typeof result !== 'object') throw transportError(method, receipt, 'returned an unsupported JSON body');
    Object.defineProperty(result, httpReceipt, { value: { ...receipt, outcome: 'response_received' } });
    return result;
  }
  project(projectPath) { return this.api(`projects/${encodeURIComponent(projectPath)}`); }
  issue(iid) { return this.api(`projects/${this.projectId}/issues/${iid}`); }
  update(iid, data) { return this.api(`projects/${this.projectId}/issues/${iid}`, 'PUT', data); }
  async pages(endpoint) {
    const rows = [];
    for (let page = 1; page <= 10000; page++) {
      const result = await this.api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      assert(Array.isArray(result), 'Expected GitLab paginated array'); rows.push(...result);
      if (result.length < 100) return rows;
    }
    throw new Error('GitLab pagination limit; operation is incomplete');
  }
  async find(operationMarker) {
    return (await this.pages(`projects/${this.projectId}/issues?state=all&scope=all&search=${encodeURIComponent(operationMarker)}`)).filter(i => i.description?.includes(operationMarker));
  }
  async ensureIssue(s, key, title, description, save) {
    assert(this.projectId === s.plan.projectId && this.origin === s.plan.origin, 'Publication tracker binding changed');
    const op = `issue-${key}`, tag = marker(s.plan.id, op);
    const found = await this.find(tag); assert(found.length <= 1, 'Duplicate publication marker; manual reconciliation required');
    const journal = s.operations[op];
    if (found.length === 1) {
      assert(found[0].project_id === s.plan.projectId, 'Publication project mismatch');
      if (journal?.iid) assert(found[0].iid === journal.iid, 'Publication IID changed');
      s.operations[op] = { ...journal, status: 'read_back', iid: found[0].iid }; await save(s);
      return found[0].iid;
    }
    const request = issueCreateRequest(s.plan, key, title, description);
    assert(!journal || journal.status === 'retry_authorized', 'Publication outcome uncertain: marker absent after attempted create; reconcile manually, never blindly recreate');
    if (journal) assert(journal.planHash === s.planHash && journal.request?.hash === request.hash && journal.history?.at(-1)?.version === 1, 'Authorized publication request changed; confirm fresh recovery');
    const { body, ...requestIdentity } = request;
    s.operations[op] = { status: 'attempted', request: requestIdentity, ...(journal?.history ? { history: journal.history } : {}) }; await save(s);
    let created;
    try { created = await this.api(request.endpoint, 'POST', body); }
    catch (error) {
      if (error.transportReceipt) { s.operations[op].transport = error.transportReceipt; await save(s); }
      throw error;
    }
    if (created?.[httpReceipt]) { s.operations[op].transport = created[httpReceipt]; await save(s); }
    assert(Number.isSafeInteger(created?.iid) && created.iid > 0 && created.project_id === this.projectId, 'Invalid create response');
    s.operations[op].iid = created.iid; await save(s);
    const back = await this.issue(created.iid);
    assert(back.description === `${tag}\n${description}`, 'Publication read-back mismatch');
    s.operations[op].status = 'read_back'; await save(s);
    return created.iid;
  }
  async note(s, iid, key, text, save) {
    assert(this.projectId === s.plan.projectId && this.origin === s.plan.origin, 'Note tracker binding changed');
    const tag = marker(s.plan.id, key), body = `${tag}\n${text}`;
    const found = (await this.pages(`projects/${this.projectId}/issues/${iid}/notes`)).filter(n => n.body?.includes(tag));
    assert(found.length <= 1, 'Duplicate checkpoint note');
    if (found.length) {
      assert(found[0].body === body, 'Checkpoint note content changed');
      assert(!s.operations[key] || s.operations[key].iid === iid && s.operations[key].hash === digest(body), 'Checkpoint operation destination/content changed');
      s.operations[key] = { ...s.operations[key], status: 'read_back', iid, noteId: found[0].id, hash: digest(body) }; await save(s);
      return found[0].id;
    }
    assert(!s.operations[key], 'Checkpoint outcome uncertain; reconcile note before retry');
    s.operations[key] = { status: 'attempted', iid, hash: digest(body) }; await save(s);
    let n;
    try { n = await this.api(`projects/${this.projectId}/issues/${iid}/notes`, 'POST', { body }); }
    catch (error) {
      if (error.transportReceipt) { s.operations[key].transport = error.transportReceipt; await save(s); }
      throw error;
    }
    if (n?.[httpReceipt]) { s.operations[key].transport = n[httpReceipt]; await save(s); }
    assert(Number.isSafeInteger(n?.id) && n.id > 0, 'Invalid note create response');
    const back = await this.api(`projects/${this.projectId}/issues/${iid}/notes/${n.id}`);
    assert(back.body === body, 'Checkpoint read-back mismatch');
    s.operations[key] = { ...s.operations[key], status: 'read_back', iid, noteId: n.id, hash: digest(body) }; await save(s);
    return n.id;
  }
}
export async function verifyBinding(git, p, tracker) {
  if (p.provider === 'local') {
    assert(p.origin === `local://${p.projectId}` && p.projectPath === p.projectId, 'Local project identity changed');
    const project = await tracker.project(p.projectPath);
    assert(project.id === p.projectId && project.path_with_namespace === p.projectPath && project.web_url === p.origin, 'Local project read-back mismatch');
    return { ...p, verified: true };
  }
  const remoteName = p.remote ?? 'origin';
  assert(typeof remoteName === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(remoteName), 'Invalid selected remote');
  const urls = (await git.text(['remote', 'get-url', '--all', remoteName])).split('\n');
  assert(urls.length === 1, 'Origin must have one unambiguous URL');
  const remote = urls[0]; let host, projectPath;
  if (/^[\w.-]+@[^:]+:.+/.test(remote)) {
    const m = remote.match(/^[\w.-]+@([^:]+):(.+)$/); host = m[1]; projectPath = m[2];
  } else {
    let u; try { u = new URL(remote); } catch { throw new Error('Unsupported origin URL'); }
    assert(['https:', 'http:', 'ssh:'].includes(u.protocol) && !u.password, 'Unsupported/credential-bearing origin');
    host = u.protocol === 'ssh:' ? u.hostname : u.host; projectPath = u.pathname.slice(1);
  }
  projectPath = decodeURIComponent(projectPath).replace(/\.git$/, '');
  const originURL = url(p.origin);
  assert(host === originURL.host && projectPath === p.projectPath, 'Git origin does not match the declared GitLab project');
  const project = await tracker.project(p.projectPath);
  assert(project.id === p.projectId && project.path_with_namespace === p.projectPath && url(project.web_url).origin === p.origin, 'GitLab project read-back mismatch');
  return { ...p, verified: true };
}
export class Orca {
  constructor(cwd, { runner = run, env = process.env, platform = process.platform } = {}) {
    this.cwd = cwd; this.runner = runner; this.env = env; this.exe = orcaExecutable(env, platform);
  }
  async call(args) {
    const result = json(await this.runner(this.exe, [...args, '--json'], { cwd: this.cwd, env: this.env }));
    assert(result.ok !== false, `Orca error: ${result.error?.code || 'unknown'}`);
    return result.result ?? result;
  }
  preflight({ fresh = false } = {}) {
    if (fresh || !this.capabilities) this.capabilities = this.probeCapabilities();
    return this.capabilities;
  }
  async probeCapabilities() {
    const guide = await this.call(['skills', 'get', 'orca-cli']);
    assert(typeof guide.markdown === 'string' && guide.markdown.includes('worktree') && guide.markdown.includes('terminal'), 'Version-matched Orca guide unavailable');
    for (const [args, flags] of [
      [['worktree', 'create', '--help'], ['--base-branch', '--no-parent', '--setup', '--comment']],
      [['terminal', 'create', '--help'], ['--command', '--worktree']],
      [['worktree', 'rm', '--help'], ['--worktree']],
      [['terminal', 'wait', '--help'], ['--timeout-ms', '--for']],
      [['terminal', 'send', '--help'], ['--wait-submit', '--retry-request']],
    ]) {
      const help = (await this.runner(this.exe, args, { cwd: this.cwd, env: this.env })).toString();
      assert(flags.every(f => help.includes(f)), `Selected Orca lacks required capability: ${args.join(' ')}`);
    }
    return { executable: this.exe, version: (await this.runner(this.exe, ['--version'], { cwd: this.cwd, env: this.env })).toString().trim(), guideHash: digest(guide.markdown) };
  }
  async current() { return (await this.call(['worktree', 'current'])).worktree; }
  async list(repoId) {
    const r = await this.call(['worktree', 'list', '--repo', `id:${repoId}`]);
    assert(!r.truncated && !(r.hostScope?.omittedHostIds?.length), 'Orca list is incomplete');
    assert(Array.isArray(r.worktrees), 'Invalid Orca worktree list'); return r.worktrees;
  }
  async address(w) {
    assert(w?.id && w.repoId && w.identity?.key && !w.isBare, 'Orca worktree lacks complete identity');
    assert(w.identity.executionHostId === 'local', 'Remote/unknown Orca execution host unsupported; use this workstation');
    return { id: w.id, identity: w.identity.key, repoId: w.repoId, path: await realpath(localOrcaPath(w.path, this.env)), branch: w.branch?.replace(/^refs\/heads\//, '') };
  }
  async create(s, save) {
    const name = `project-batch-${s.plan.id}`;
    const current = await this.address(await this.current());
    assert(await new Git(current.path, this.runner).common() === await new Git(this.cwd, this.runner).common(), 'Orca current repo does not match the Project batch repository; no worktree created');
    const previous = s.operations.worktree, tag = marker(s.plan.id, 'worktree');
    const matches = (await this.list(current.repoId)).filter(w => w.id === previous?.id || w.displayName === name || w.branch === name || w.branch === `refs/heads/${name}`);
    assert(matches.length <= 1, 'Multiple batch worktrees; manual reconciliation required');
    let w = matches[0];
    if (w) {
      assert(previous?.repoId === current.repoId, 'Unowned batch worktree name collision; no implicit adoption');
      if (previous.id) assert(w.id === previous.id && w.identity?.key === previous.identity, 'Recovered Orca worktree identity mismatch');
      else assert(w.comment?.includes(tag), 'Uncertain Orca creation lacks its batch operation marker');
    } else {
      assert(!s.operations.worktree, 'Orca creation outcome uncertain; reconcile before retry');
      s.operations.worktree = { status: 'attempted', repoId: current.repoId, name }; await save(s);
      const result = await this.call(['worktree', 'create', '--repo', `id:${current.repoId}`, '--name', name, '--base-branch', s.plan.targetBranch, '--no-parent', '--setup', 'skip', '--comment', tag]);
      w = result.worktree;
    }
    const address = await this.address(w);
    assert(address.repoId === current.repoId && address.path !== current.path && address.branch !== s.plan.targetBranch, 'Invalid batch worktree identity');
    s.operations.worktree = { status: 'read_back', ...address }; await save(s);
    return address;
  }
  async verify(address) {
    const matches = (await this.list(address.repoId)).filter(w => w.id === address.id || w.identity?.key === address.identity);
    assert(matches.length === 1 && digest(await this.address(matches[0])) === digest(address), 'Orca worktree identity changed');
  }
  async launch(s, skillPath, prompt, save) {
    assert(!s.operations.terminal, 'Terminal launch already attempted; verify its receipt rather than duplicate launch');
    const command = ['pi', '--skill', skillPath, '--extension', `${skillPath}/extensions/session-handoff.ts`, '--session-id', s.runtime.launchSession].map(quote).join(' ');
    s.operations.terminal = { status: 'attempted' }; await save(s);
    const result = await this.call(['terminal', 'create', '--worktree', `id:${s.runtime.worktree.id}`, '--title', `project-batch ${s.plan.id}`, '--command', command]);
    const handle = result.terminal?.handle ?? result.handle;
    assert(handle, 'Orca terminal handle missing; launch remains uncertain');
    s.operations.terminal.handle = handle; await save(s);
    const ready = await this.call(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '120000']);
    assert(ready.wait?.satisfied === true || ready.satisfied === true, 'Pi terminal not idle; no prompt sent');
    s.operations.terminal.status = 'sending'; await save(s);
    const receipt = await this.call(['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter', '--wait-submit', '10']);
    assert(receipt.accepted === true || receipt.send?.accepted === true, 'Pi input acceptance unproven; do not resend');
    s.operations.terminal = { status: 'accepted', handle, receipt }; await save(s);
    return s.operations.terminal;
  }
  async remove(address) {
    await this.verify(address);
    await this.call(['worktree', 'rm', '--worktree', `id:${address.id}`]);
    assert(!(await this.list(address.repoId)).some(w => w.id === address.id || w.identity?.key === address.identity), 'Orca cleanup read-back failed');
  }
}
