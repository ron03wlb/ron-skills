#!/usr/bin/env node
// Local fixture preparation only: never calls GitLab, Orca, Pi, or a push command.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { run } from '../../skills/in-progress/project-batch/scripts/lib/platform.mjs';
import { validatePlan } from '../../skills/in-progress/project-batch/scripts/lib/contracts.mjs';

const files = {
  'README.md': '# Disposable project-batch fixture\n\nNode behavior tests only; no database, network, provider, deployment or push work.\n',
  'src/payment.mjs': 'export function payment(amount) { return { amount }; }\n',
  'src/reconcile.mjs': 'export function total(payments) { return 0; }\n',
  'tests/payment.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { payment } from '../src/payment.mjs';
test('positive finite payment amounts only', () => {
  for (const amount of [0, -1, NaN, Infinity, '1']) assert.throws(() => payment(amount));
  assert.deepEqual(payment(3), { amount: 3 });
});
`,
  'tests/reconcile.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { payment } from '../src/payment.mjs';
import { total } from '../src/reconcile.mjs';
test('reconcile accepted payments', () => {
  assert.equal(total([payment(3), payment(7)]), 10);
  assert.equal(total([]), 0);
});
`,
};
export function scratchPlan(binding, id, multi = true) {
  const verify = test => ({ file: 'node', args: ['--test', `tests/${test}.test.mjs`], effect: 'offline' });
  const payment = { key: 'payment', title: 'Validate payment amounts', goal: 'Only positive finite amounts are accepted', scope: 'Validate numeric input and preserve valid payment records', exclusions: 'No network, provider, push or deployment', criteria: ['Reject zero, negative, non-number and non-finite amounts; preserve valid amounts'], dependsOn: [], external: [], prerequisites: [], verify: [verify('payment')] };
  const reconcile = { key: 'reconcile', title: 'Reconcile accepted payments', goal: 'Sum accepted payments', scope: 'Total accepted amounts, with zero for an empty list', exclusions: 'No persistence, currency or network work', criteria: ['Payments of 3 and 7 total 10; empty input totals zero'], dependsOn: ['payment'], external: [], prerequisites: [], verify: [verify('reconcile')] };
  const issues = multi ? [payment, reconcile] : [payment];
  return validatePlan({ version: 1, ...binding, id, revision: 1, database: { version: 1, targets: [] }, planning: { requirements: 'Implement only the seeded positive-payment and total behaviors', design: 'Pure functions; documented input rejection and empty total, no persistence', boundaries: 'Disposable repository only; no DB, network, provider, deployment or push', implementation: 'Payment validation precedes reconciliation; one domain per bounded segment', testing: 'Run existing offline Node behavior tests before acceptance; no DB fixtures', risks: 'Expected-red seeds are deliberate; reject unknown scope and preserve invalid input behavior' },  title: `Disposable ${multi ? 'multi' : 'single'} batch`, targetBranch: 'main', issues, segments: issues.map(i => ({ id: i.key, domain: i.key, issues: [i.key], effort: 'Small: implement the seeded behavior and inspect its test', verificationCost: 'One Node behavior test', handoffCondition: 'Member accepted, checkpoint and stop' })), verify: issues.flatMap(i => i.verify) });
}
export async function createScratch(binding) {
  const suffix = randomUUID().slice(0, 8);
  // Validate before creating anything. Binding is explicit; doctor verifies it later.
  const plans = [scratchPlan(binding, `scratch-single-${suffix}`, false), scratchPlan(binding, `scratch-multi-${suffix}`)];
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'project-batch-scratch-')));
  const receipts = [];
  for (const [index, plan] of plans.entries()) {
    const cwd = path.join(root, index ? 'multi' : 'single');
    await run('git', ['init', '-b', 'main', cwd]);
    for (const [name, content] of Object.entries(files)) {
      if (!index && name.includes('reconcile')) continue;
      await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
      await writeFile(path.join(cwd, name), content);
    }
    await run('git', ['-C', cwd, 'config', 'user.name', 'Disposable Batch Trial']);
    await run('git', ['-C', cwd, 'config', 'user.email', 'batch-trial@example.invalid']);
    await run('git', ['-C', cwd, 'remote', 'add', 'origin', `${plan.origin}/${plan.projectPath}.git`]);
    await run('git', ['-C', cwd, 'add', '.']);
    await run('git', ['-C', cwd, 'commit', '-m', 'Seed disposable batch behavior tests (expected red)']);
    const planFile = path.join(root, `${index ? 'multi' : 'single'}.plan.json`);
    await writeFile(planFile, JSON.stringify(plan, null, 2) + '\n');
    const setupFile = path.join(root, `${index ? 'multi' : 'single'}.setup.json`);
    await writeFile(setupFile, JSON.stringify({ id: binding.provider === 'local' ? binding.projectId : `fixture-project-${suffix}-${index}`, tracker: { ...binding, provider: binding.provider ?? 'gitlab' }, standards: ['README.md'], databases: [] }, null, 2) + '\n');
    receipts.push({ cwd, planFile, setupFile, id: plan.id });
  }
  await writeFile(path.join(root, 'binding.json'), JSON.stringify(binding, null, 2) + '\n');
  return { root, receipts, next: 'Obtain explicit disposable-project Issue/Orca/terminal/FF/closure/cleanup authorization, register these repos in Orca, then doctor/init (confirm and commit profile)/plan/publish/start separately. Nothing has been pushed or published.' };
}
const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--binding') throw new Error('Usage: node tests/project-batch/create-scratch.mjs --binding <explicit-disposable-project.json>');
    console.log(JSON.stringify(await createScratch(JSON.parse(await readFile(process.argv[3], 'utf8'))), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
