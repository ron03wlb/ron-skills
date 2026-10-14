#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { Batch } from './lib/runtime.mjs';
import { readJSON } from './lib/store.mjs';
import { assert } from './lib/contracts.mjs';
import { run } from './lib/platform.mjs';
import { loadProfile } from './lib/project.mjs';
import { prepareReader, requireNativeQualification, nativeSourceHashes } from './lib/mysql.mjs';

export const usage = `project-batch.mjs <init|doctor|plan|publish|schema|start|resume|status|review|integrate|step|revise> [draft-id|issue-ref]
  --input <JSON-file>       Structured plan, handoff, acceptance or prerequisite evidence
  --prepare-reader         init only: offline candidate MySQL reader SQL/checklist; never installs
  --qualify                schema only: currently blocked; no native DML authority or certification
  --confirm <SHA256>        Exact preview token, only after explicit human confirmation
  --reconcile-create <JSON-file>  publish only: preview/confirm one failed create recovery; never POST
  --reconcile-orca <JSON-file>    integrate only: preview/confirm reviewed-delivery forward patch recovery; no FF
  --session <Pi-session-id> --generation <integer>  Required execution owner
  --action <begin|accept|checkpoint|sync|regress|prerequisite|schema-stop|cleanup>  Internal step
  --percent <number>        Current Pi context percent, unknown if omitted
  --inactive-evidence <text> Verified old-executor inactivity for crash takeover
  --cwd <repo>             Defaults to current directory
  --view <summary|full>    Default summary; full retains all evidence; previews always complete
Without --confirm, publish/start/revise/integrate/takeover return a read-only preview.
No push, MR, deployment, raw worktree fallback, or stale-lock timeout takeover.`;
export async function main(argv, { signal } = {}) {
  if (!argv.length || argv.includes('--help')) return { usage };
  const [command, ...rest] = argv, options = {}, positional = [];
  const flags = new Set(['prepare-reader', 'qualify']);
  const allowed = new Set(['input', 'confirm', 'session', 'generation', 'action', 'percent', 'inactive-evidence', 'cwd', 'view', 'reconcile-create', 'reconcile-orca']);
  for (let n = 0; n < rest.length; n++) {
    if (!rest[n].startsWith('--')) positional.push(rest[n]);
    else {
      const key = rest[n].slice(2);
      assert(options[key] === undefined, 'Duplicate option');
      if (flags.has(key)) options[key] = true;
      else {
        assert(allowed.has(key) && rest[n + 1] !== undefined && !rest[n + 1].startsWith('--'), 'Unknown option or missing value');
        options[key] = rest[++n];
      }
    }
  }
  assert(positional.length <= 1, 'Only one Issue reference/draft ID accepted');
  assert(options.view === undefined || ['summary', 'full'].includes(options.view), 'View must be summary or full');
  assert(!options['reconcile-orca'] || command === 'integrate' && !options.input && !options['reconcile-create'], 'Orca reconciliation belongs only to integrate, without --input or create reconciliation');
  assert(!options['prepare-reader'] || command === 'init' && options.input && !positional.length && Object.keys(options).every(k => ['prepare-reader', 'input', 'cwd', 'view'].includes(k)), 'Reader preparation is offline init only, without confirmation or execution options');
  assert(!options.qualify || command === 'schema' && !options['prepare-reader'] && Object.keys(options).every(k => ['qualify', 'input', 'cwd', 'view'].includes(k)), 'Qualification belongs only to schema; confirmation cannot bypass missing native implementation');
  const input = options.input ? await readJSON(path.resolve(options.input)) : undefined;
  if (options.input) assert(input, 'Input JSON file absent');
  if (options['prepare-reader']) {
    assert(Array.isArray(input.databases) && input.databases.length && input.databases.every(d => d.native), 'Reader preparation requires explicit native database targets');
    return { operation: 'prepare-reader', applied: false, profilesChanged: false, sources: await nativeSourceHashes(), packages: input.databases.map(prepareReader) };
  }
  if (options.qualify) requireNativeQualification();
  const runner = signal ? (file, args, options) => run(file, args, { ...options, signal }) : undefined;
  const batch = await Batch.open(options.cwd, { runner });
  assert(!options['reconcile-create'] || command === 'publish' && !options.input, 'Create reconciliation belongs only to publish, without --input');
  const recovery = options['reconcile-create'] ? await readJSON(path.resolve(options['reconcile-create'])) : undefined;
  if (options['reconcile-create']) assert(recovery, 'Recovery JSON file absent');
  const orcaRecovery = options['reconcile-orca'] ? await readJSON(path.resolve(options['reconcile-orca'])) : undefined;
  if (options['reconcile-orca']) assert(orcaRecovery, 'Orca recovery JSON file absent');
  const ref = positional[0];
  const execute = async () => { switch (command) {
    case 'init': return batch.init(input, options.confirm);
    case 'doctor': return batch.doctor(input);
    case 'plan': await loadProfile(batch.git.cwd, true); return batch.plan(input);
    case 'schema': return batch.schema(ref, input, options.confirm);
    case 'publish': return recovery ? batch.recoverPublication(ref, recovery, options.confirm) : batch.publish(ref, options.confirm);
    case 'revise': return batch.revise(ref, input, options.confirm);
    case 'start': return batch.start(ref, options.confirm);
    case 'resume': return batch.resume(ref, { session: options.session, confirm: options.confirm, inactiveEvidence: options['inactive-evidence'] });
    case 'status': return batch.status(ref);
    case 'review': return batch.review(ref);
    case 'integrate': return orcaRecovery ? batch.recoverOrca(ref, orcaRecovery, options.confirm) : batch.integrate(ref, options.confirm);
    case 'step': return batch.step(ref, { action: options.action, input, confirm: options.confirm, session: options.session, generation: Number(options.generation), percent: options.percent === undefined ? undefined : Number(options.percent) });
    default: throw new Error(usage);
  } };
  return batch.view(await execute(), options.view ?? 'summary');
}
const invokedPath = process.argv[1] ? await realpath(path.resolve(process.argv[1])).catch(() => null) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(); let interruptedCode = 1;
  const interrupt = () => { interruptedCode = 130; controller.abort(); };
  const terminate = () => { interruptedCode = 143; controller.abort(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const result = await main(process.argv.slice(2), { signal: controller.signal });
    if (controller.signal.aborted) process.exitCode = interruptedCode;
    else console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, ...(error.transportReceipt ? { transport: error.transportReceipt } : {}) })); process.exitCode = interruptedCode;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  }
}
