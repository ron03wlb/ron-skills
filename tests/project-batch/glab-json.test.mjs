import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { GitLab } from '../../skills/in-progress/project-batch/scripts/lib/adapters.mjs';
import { run } from '../../skills/in-progress/project-batch/scripts/lib/platform.mjs';

// Optional real CLI characterization. Loopback only, dummy credentials, no GitLab
// resources. The argv contract in adapters.test.mjs also runs without glab.
test('real glab sends JSON stdin with explicit content type for POST and PUT', async t => {
  const version = spawnSync('glab', ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.error?.code === 'ENOENT') return t.skip('glab is not installed; deterministic argv contract still runs');
  assert.equal(version.status, 0, version.stderr);
  t.diagnostic(version.stdout.trim());
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'project-batch-glab-json-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, contentType: req.headers['content-type'], body });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Request-Id', 'loopback-request-1');
      if (req.method !== 'GET' && req.headers['content-type'] !== 'application/json') {
        res.writeHead(415);
        res.end(JSON.stringify({ message: 'JSON stdin requires an explicit content type' }));
        return;
      }
      if (body && JSON.parse(body).title === 'reject-me') {
        res.writeHead(400);
        res.end(JSON.stringify({ message: 'PRIVATE_LOOPBACK_BODY' }));
        return;
      }
      res.end(JSON.stringify({ iid: 101, project_id: 17 }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v4/`;
  const runner = (file, args, options) => {
    assert.equal(file, 'glab');
    const localArgs = [...args];
    // Keep the real API adapter's method, stdin and header flags; replace only
    // its endpoint with a full loopback URL understood by glab's API command.
    const remote = new URL(args[1]);
    assert.equal(remote.origin, 'https://gitlab.invalid');
    assert.ok(remote.pathname.startsWith('/api/v4/projects/'));
    localArgs[1] = `${base}${remote.pathname.slice('/api/v4/'.length)}${remote.search}`;
    return run(file, localArgs, { ...options, timeoutMs: 10000, env: {
      ...process.env,
      GLAB_CONFIG_DIR: cwd,
      GITLAB_HOST: 'gitlab.invalid', GITLAB_URI: '', GITLAB_URL: '',
      GITLAB_TOKEN: 'loopback-dummy-token', OAUTH_TOKEN: '',
      NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
    } });
  };
  const gl = new GitLab('https://gitlab.invalid', 17, cwd, runner);
  const title = '中文 title with spaces\tand newline\n';
  assert.equal((await gl.api('projects/17/issues', 'POST', { title })).iid, 101);
  assert.equal((await gl.update(101, { state_event: 'close' })).iid, 101);
  assert.equal((await gl.issue(101)).iid, 101);
  assert.deepEqual(requests.map(r => r.method), ['POST', 'PUT', 'GET']);
  assert.deepEqual(requests.slice(0, 2).map(r => r.contentType), ['application/json', 'application/json']);
  assert.equal(requests[2].contentType, undefined);
  assert.deepEqual(requests.slice(0, 2).map(r => JSON.parse(r.body)), [{ title }, { state_event: 'close' }]);
  await assert.rejects(gl.api('projects/17/issues', 'POST', { title: 'reject-me' }), error => {
    assert.equal(error.transportReceipt.httpStatus, 400);
    assert.equal(error.transportReceipt.requestId, 'loopback-request-1');
    assert.ok(!error.message.includes('PRIVATE_LOOPBACK_BODY'));
    return true;
  });
});
