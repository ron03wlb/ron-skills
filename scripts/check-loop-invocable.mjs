#!/usr/bin/env node
// `/loop` 透過 Skill tool 呼叫它驅動的 skill；user-invoked skill（disable-model-invocation: true）會被 Skill tool 拒絕。
// 掃描本 repo 的 SKILL.md 與 README.md 中的 `/loop [<interval>] /<name>`，被驅動的 skill 若為 user-invoked 即報錯。
// 用法：node scripts/check-loop-invocable.mjs（環境變數 MATT_SKILLS、PSTACK_SKILLS 同 bin/sync-skills）
// stdout：每個違規一行 `LOOP_USER_INVOKED <name>（<引用檔>）`；exit 0 無違規、1 有違規。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const matt = process.env.MATT_SKILLS || join(homedir(), 'code/skills');
const pstack = process.env.PSTACK_SKILLS || join(homedir(), 'code/pstack');

const dirs = base => (existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(base, d.name)) : []);
const nested = base => dirs(base).flatMap(dirs);

/** skill 名稱 → SKILL.md 路徑；本 repo 優先，與 sync-skills 的連結結果一致。 */
const skills = new Map();
for (const dir of [...nested(join(root, 'skills')), ...nested(join(matt, 'skills')), ...dirs(join(pstack, 'skills'))]) {
  const file = join(dir, 'SKILL.md');
  const name = dir.split('/').pop();
  if (existsSync(file) && !skills.has(name)) skills.set(name, file);
}

const sources = [join(root, 'README.md'), ...nested(join(root, 'skills')).map(dir => join(dir, 'SKILL.md'))].filter(existsSync);
const failures = [];
for (const source of sources) {
  for (const [, name] of readFileSync(source, 'utf8').matchAll(/\/loop(?:\s+\d+[smhd])?\s+\/([\w-]+)/g)) {
    const target = skills.get(name);
    if (target && /^disable-model-invocation:\s*true\s*$/m.test(readFileSync(target, 'utf8'))) {
      failures.push(`LOOP_USER_INVOKED ${name}（${relative(root, source)}）：/loop 經 Skill tool 呼叫，請移除 disable-model-invocation 並在 description 限定觸發時機`);
    }
  }
}
for (const line of new Set(failures)) console.log(line);
process.exit(failures.length ? 1 : 0);
