import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createScratch, scratchPlan } from './create-scratch.mjs';
import { run } from '../../skills/in-progress/project-batch/scripts/lib/platform.mjs';

const binding = { origin: 'https://gitlab.example', projectPath: 'disposable/batch', projectId: 17 };
test('scratch fixture creates distinct local repos and single/multi plans, without external adapters', async t => {
  assert.throws(() => scratchPlan({ ...binding, projectId: 0 }, 'invalid'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // Nested test runner must report its own exit code.
  const f = await createScratch(binding); t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const [index, receipt] of f.receipts.entries()) {
    const p = JSON.parse(await readFile(receipt.planFile, 'utf8'));
    assert.equal(p.issues.length, index ? 2 : 1); assert.equal(p.segments.length, index ? 2 : 1);
    assert.equal((await run('git', ['status', '--porcelain'], { cwd: receipt.cwd })).length, 0);
    const command = p.issues[0].verify[0];
    await assert.rejects(run(command.file, command.args, { cwd: receipt.cwd, env }), /failed/);
    await writeFile(path.join(receipt.cwd, 'src/payment.mjs'), 'export function payment(amount) { if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount"); return { amount }; }\n');
    await run(command.file, command.args, { cwd: receipt.cwd, env });
    if (index) {
      await writeFile(path.join(receipt.cwd, 'src/reconcile.mjs'), 'export function total(payments) { return payments.reduce((sum, p) => sum + p.amount, 0); }\n');
      await run(p.verify[1].file, p.verify[1].args, { cwd: receipt.cwd, env });
    }
  }
});
