import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env as baseEnv, git, write } from './helpers/git-fixture.mjs';
import { realTmpdir } from './helpers/real-tmpdir.mjs';
import { CI_FILES, COMMANDS } from '../skills/engineering/setup-workflow/templates/lib/hosts.mjs';

// Host 站（detect.mjs --host）：tracker host 讀 docs/agents/issue-tracker.md，程式碼 host 讀 origin。
// gh／glab 是暫存 bin 目錄裡的假腳本：`auth status --hostname <h>` 在 h 列於 FAKE_LOGGED_IN 時 exit 0，否則 exit 1。
const script = new URL('../skills/engineering/setup-workflow/scripts/detect.mjs', import.meta.url).pathname;
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

const GH_DOC = 'Read an Issue: `gh issue view <n> --json body`\n';
const GLAB_DOC = 'Read an Issue: `glab issue view <n> --comments`\n';
const FAKE_CLI = `#!/bin/sh
if [ "$1 $2 $3" = "auth status --hostname" ]; then
  case " $FAKE_LOGGED_IN " in *" $4 "*) echo "Logged in to $4"; exit 0;; esac
  echo "$4: not logged in" >&2; exit 1
fi
echo "$0 1.0.0"
`;

function tmp(t, prefix) {
  const dir = mkdtempSync(join(realTmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 只含 git 與 clis 的 PATH 目錄。 */
function bin(t, clis) {
  const dir = tmp(t, 'setup-workflow-host-bin-');
  symlinkSync(realGit, join(dir, 'git'));
  for (const name of clis) {
    write(dir, { [name]: FAKE_CLI });
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/** 跑 Host 站；opts：tracker（issue-tracker.md 內容，undefined 表示沒有）、origin（remote URL，undefined 表示沒有）、clis、loggedIn。 */
function station(t, { tracker, origin, clis = ['gh', 'glab'], loggedIn = [] } = {}) {
  const root = tmp(t, 'setup-workflow-host-repo-');
  git(root, 'init', '-q', '-b', 'main');
  write(root, { 'docs/agents/issue-tracker.md': tracker });
  if (origin) git(root, 'remote', 'add', 'origin', origin);
  const env = { ...baseEnv, PATH: bin(t, clis), FAKE_LOGGED_IN: loggedIn.join(' ') };
  const run = json => spawnSync(process.execPath, [script, root, '--host', ...(json ? ['--json'] : [])], { encoding: 'utf8', env });
  const json = run(true);
  const text = run(false);
  assert.equal(json.status, text.status, text.stderr);
  return { status: json.status, result: JSON.parse(json.stdout), lines: text.stdout.trim().split('\n') };
}

test('GitHub：tracker 與程式碼 host 都是 github.com，gh 已登入時 exit 0、最後一行 HOST ok', t => {
  const { status, result, lines } = station(t, { tracker: GH_DOC, origin: 'git@github.com:acme/app.git', loggedIn: ['github.com'] });
  assert.equal(status, 0);
  assert.deepEqual([result.tracker.value, result.tracker.host], ['github', 'github.com']);
  assert.deepEqual([result.code.value, result.code.host], ['github', 'github.com']);
  assert.equal(result.cli.gh.met, true);
  assert.equal(result.cli.glab, undefined);
  assert.deepEqual(result.stops, []);
  assert.match(lines[0], /^HOST tracker github github\.com {2}# docs\/agents\/issue-tracker\.md/);
  assert.match(lines[1], /^HOST code github github\.com {2}# origin git@github\.com:acme\/app\.git/);
  assert.match(lines[2], /^CLI gh met github\.com /);
  assert.equal(lines.at(-1), 'HOST ok');
});

test('自架 GitLab：http、IP 的 origin 算 GitLab；glab 沒登入該主機時停下，給 glab auth login --hostname', t => {
  const { status, result, lines } = station(t, { tracker: GLAB_DOC, origin: 'http://192.168.200.202/spay/spay2.git' });
  assert.equal(status, 1);
  assert.deepEqual([result.tracker.value, result.tracker.host], ['gitlab', '192.168.200.202']);
  assert.deepEqual([result.code.value, result.code.host], ['gitlab', '192.168.200.202']);
  assert.equal(result.cli.gh, undefined);
  assert.equal(result.cli.glab.state, 'unauthenticated');
  assert.ok(lines.includes('FIX glab glab auth login --hostname 192.168.200.202'), lines.join('\n'));
  assert.equal(lines.at(-1), 'HOST stop 1');
});

test('自架 GitLab 已登入時 HOST ok；PATH 上沒有 glab 時停下，給 brew install glab', t => {
  const ok = station(t, { tracker: GLAB_DOC, origin: 'ssh://git@gitlab.example.org:2222/team/app.git', loggedIn: ['gitlab.example.org'] });
  assert.equal(ok.status, 0);
  assert.match(ok.lines.find(line => line.startsWith('CLI ')), /^CLI glab met gitlab\.example\.org /);
  const missing = station(t, { tracker: GLAB_DOC, origin: 'ssh://git@gitlab.example.org:2222/team/app.git', clis: ['gh'] });
  assert.equal(missing.status, 1);
  assert.equal(missing.result.cli.glab.state, 'missing');
  assert.ok(missing.lines.includes('FIX glab brew install glab'), missing.lines.join('\n'));
});

test('tracker 與程式碼 host 不同：兩邊分開記錄，各自檢查 gh 與 glab', t => {
  const { status, result, lines } = station(t, { tracker: GH_DOC, origin: 'http://192.168.200.202/spay/spay2.git', loggedIn: ['github.com'] });
  assert.equal(status, 1);
  assert.deepEqual([result.tracker.value, result.tracker.host], ['github', 'github.com']);
  assert.deepEqual([result.code.value, result.code.host], ['gitlab', '192.168.200.202']);
  assert.equal(result.cli.gh.state, 'met');
  assert.equal(result.cli.glab.state, 'unauthenticated');
  assert.deepEqual(result.stops.map(stop => stop.name), ['glab']);
  // GitLab tracker 的主機取自文件裡的網址，程式碼在 GitHub。
  const reverse = station(t, { tracker: 'Issues live on http://192.168.200.202/spay/spay2/-/issues; read with `glab issue view <n>`.\n', origin: 'https://github.com/acme/app', loggedIn: ['github.com', '192.168.200.202'] });
  assert.equal(reverse.status, 0, reverse.lines.join('\n'));
  assert.deepEqual([reverse.result.tracker.value, reverse.result.tracker.host], ['gitlab', '192.168.200.202']);
  assert.deepEqual([reverse.result.code.value, reverse.result.code.host], ['github', 'github.com']);
  assert.ok(lines.some(line => /^HOST tracker github github\.com /.test(line)));
});

test('GitHub Enterprise 的 tracker、程式碼在 GitLab：tracker 主機取自文件裡的 GitHub 網址，不預設 github.com', t => {
  const doc = 'Issues: https://github.acme.corp/team/app/issues — read with `gh issue view <n> --json body`.\n';
  const { result } = station(t, { tracker: doc, origin: 'git@gitlab.acme.corp:team/app.git', loggedIn: ['github.acme.corp', 'gitlab.acme.corp'] });
  assert.deepEqual([result.tracker.value, result.tracker.host], ['github', 'github.acme.corp']);
  assert.equal(result.ok, true);
});

test('無 remote：程式碼 host 是 local；本機 Markdown tracker 也是 local，不需要任何 CLI', t => {
  const { status, result, lines } = station(t, { tracker: 'Issues live as Markdown files under `.scratch/issues/`.\n', clis: [] });
  assert.equal(status, 0);
  assert.deepEqual([result.tracker.value, result.tracker.host], ['local', null]);
  assert.deepEqual([result.code.value, result.code.host], ['local', null]);
  assert.deepEqual(result.cli, {});
  assert.match(lines[1], /^HOST code local - {2}# 沒有 origin remote/);
  assert.match(lines[2], /^CLI none /);
  assert.equal(lines.at(-1), 'HOST ok');
});

test('還沒有 issue-tracker.md 時 tracker 依 origin 推定；本機路徑的 origin 算 local', t => {
  const inferred = station(t, { origin: 'git@github.com:acme/app.git', loggedIn: ['github.com'] });
  assert.deepEqual([inferred.result.tracker.value, inferred.result.tracker.host], ['github', 'github.com']);
  assert.match(inferred.result.tracker.evidence[0], /不存在，依 origin 推定/);
  const path = station(t, { origin: '/srv/git/app.git', clis: [] });
  assert.equal(path.status, 0);
  assert.deepEqual([path.result.code.value, path.result.tracker.value], ['local', 'local']);
});

// 對照表：hosts.mjs 是腳本讀的那一份（pilot-counterpart 也讀它），HOSTS.md 是人與 adapter 填寫時讀的那一份，兩者逐列一致。
const hostsDoc = readFileSync(new URL('../skills/engineering/setup-workflow/HOSTS.md', import.meta.url), 'utf8');

test('對照表：每個動作的 gh 與 glab 指令都以同一列出現在 HOSTS.md，每列都有 --help 核對紀錄', () => {
  assert.ok(Object.keys(COMMANDS).length >= 10);
  for (const [action, row] of Object.entries(COMMANDS)) {
    const line = hostsDoc.split('\n').find(text => text.startsWith(`| ${row.label} |`));
    assert.ok(line, `HOSTS.md 缺 ${action}（${row.label}）這一列`);
    assert.ok(line.includes(`\`${row.github}\``), `${action} 的 gh 指令和 HOSTS.md 不同：${row.github}`);
    assert.ok(line.includes(`\`${row.gitlab}\``), `${action} 的 glab 指令和 HOSTS.md 不同：${row.gitlab}`);
    assert.match(row.github, /^gh /);
    assert.match(row.gitlab, /^glab /);
    for (const command of [row.github, row.gitlab]) {
      const sub = command.split(' ').slice(0, 3).filter(word => /^[a-z]+$/.test(word)).join(' ');
      assert.ok(hostsDoc.includes(`\`${sub} --help\``), `HOSTS.md 的核對紀錄缺 ${sub}`);
    }
  }
  for (const [kind, path] of Object.entries(CI_FILES)) assert.ok(hostsDoc.includes(`\`${path}\``), `HOSTS.md 缺 ${kind} 的 CI 檔位置`);
});

test('對照表：GitLab 留言用 glab issue note -m（沒有 --body-file），跨 repo 用 -R；GitHub 用 --body-file 與 --repo', () => {
  assert.match(COMMANDS.commentIssue.gitlab, /^glab issue note <n> -m "\$\(cat <file>\)"$/);
  assert.doesNotMatch(COMMANDS.commentIssue.gitlab, /--body-file|-F\b/);
  assert.match(COMMANDS.commentIssue.github, /^gh issue comment <n> --body-file <file>$/);
  assert.match(COMMANDS.otherRepo.gitlab, /-R <owner>\/<repo>/);
  assert.match(COMMANDS.otherRepo.github, /--repo <owner>\/<repo>/);
  assert.deepEqual(CI_FILES, { github: '.github/workflows/', gitlab: '.gitlab-ci.yml' });
});
