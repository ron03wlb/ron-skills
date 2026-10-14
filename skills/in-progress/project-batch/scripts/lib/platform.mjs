import { spawn } from 'node:child_process';
import { realpath, readFile, lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { assert, digest } from './contracts.mjs';

export function supported(platform = process.platform, version = process.versions.node) {
  assert(['linux', 'darwin'].includes(platform), 'Supported: macOS, Linux, WSL Linux toolchain; native Windows is unsupported');
  const [major, minor] = version.split('.').map(Number);
  assert(major > 22 || major === 22 && minor >= 19, 'Node.js >=22.19 required');
}
export function orcaExecutable(env = process.env, platform = process.platform) {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  if (env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  if (platform === 'linux' && !env.ORCA_TERMINAL_HANDLE) return 'orca-ide';
  return 'orca';
}
export function localOrcaPath(value, env = process.env) {
  if (!value.startsWith('\\\\')) return value;
  const m = value.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/i);
  assert(m && env.WSL_DISTRO_NAME && m[1].toLowerCase() === env.WSL_DISTRO_NAME.toLowerCase(), 'Orca path is not on this WSL distro; remote/Windows execution is unsupported');
  return '/' + m[2].split('\\').join('/');
}
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function run(file, args, { cwd, input, signal, timeoutMs = 300000, env = process.env } = {}) {
  if (signal?.aborted) return Promise.reject(new Error(`${file} cancelled before launch`));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const out = [], err = []; let size = 0, killed, escalation;
    const stop = reason => {
      if (killed) return;
      killed = reason;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      escalation = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 1000);
      escalation.unref();
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutMs); timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const collect = list => chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) stop('output limit'); else list.push(chunk); };
    child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const cleanup = () => { clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort); };
    child.on('error', e => { cleanup(); reject(new Error(`${file}: ${e.message}`)); });
    child.on('close', (code, exitSignal) => {
      cleanup();
      const stdout = Buffer.concat(out), stderr = Buffer.concat(err);
      if (code !== 0 || killed) {
        const error = new Error(`${file} failed (${killed || exitSignal || code}): ${stderr.toString().slice(-2000)}`);
        Object.assign(error, { stdout, stderr, exitCode: code }); reject(error);
      } else {
        // CLI consumers parse stdout only; verification also persists captured stderr.
        Object.assign(stdout, { stderr }); resolve(stdout);
      }
    });
  });
}
export class Git {
  constructor(cwd, runner = run) { this.cwd = cwd; this.runner = runner; }
  bytes(args) { return this.runner('git', args, { cwd: this.cwd }); }
  async text(args) { return (await this.bytes(args)).toString('utf8').trim(); }
  async common() { return realpath(path.resolve(this.cwd, await this.text(['rev-parse', '--git-common-dir']))); }
  head() { return this.text(['rev-parse', 'HEAD']); }
  branch() { return this.text(['symbolic-ref', '--short', 'HEAD']); }
  target(branch) { return this.text(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]); }
  async clean() { assert((await this.bytes(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length === 0, `Dirty checkout: ${this.cwd}`); }
  async ancestor(a, b) { await this.text(['merge-base', '--is-ancestor', a, b]); }
  async worktrees() {
    const entries = (await this.bytes(['worktree', 'list', '--porcelain', '-z'])).toString().split('\0\0').filter(Boolean);
    return entries.map(e => Object.fromEntries(e.split('\0').filter(Boolean).map(l => { const n = l.indexOf(' '); return n < 0 ? [l, true] : [l.slice(0, n), l.slice(n + 1)]; })));
  }
  async targetCheckout(branch) {
    const all = (await this.worktrees()).filter(w => w.branch === `refs/heads/${branch}`);
    assert(all.length === 1, 'Target must have exactly one local checkout');
    return new Git(await realpath(all[0].worktree), this.runner);
  }
  async fingerprint() {
    const status = await this.bytes(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const parts = status.toString().split('\0').filter(Boolean), files = [];
    for (let n = 0; n < parts.length; n++) {
      const entry = parts[n], name = entry.slice(3);
      files.push(name);
      if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) files.push(parts[++n]);
    }
    const content = [];
    for (const f of [...new Set(files)].sort()) {
      const full = path.join(this.cwd, f);
      try {
        const s = await lstat(full);
        assert(!s.isDirectory(), 'Dirty submodule/directory requires manual recovery');
        content.push([f, s.mode, digest(s.isSymbolicLink() ? await readlink(full) : await readFile(full))]);
      } catch (e) { if (e.code === 'ENOENT') content.push([f, 'deleted']); else throw e; }
    }
    return { head: await this.head(), dirty: status.length > 0, files: [...new Set(files)], hash: digest([status.toString(), (await this.bytes(['diff', '--binary'])).toString(), (await this.bytes(['diff', '--cached', '--binary'])).toString(), content]) };
  }
}
