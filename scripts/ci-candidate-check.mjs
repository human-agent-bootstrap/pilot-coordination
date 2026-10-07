import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fail, parseArgs, readRegistry, readYaml, required } from './lib.mjs';
import { verifySetupPointer } from './verify-setup-pointers.mjs';

function git(args) {
  return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
}

function run(change, candidate, targetRef) {
  const prs = spawnSync(process.execPath, [
    join(import.meta.dirname, 'verify-prs.mjs'),
    '--change', change,
  ], { cwd: process.cwd(), stdio: 'inherit' });
  if (prs.status !== 0) process.exit(prs.status ?? 1);
  const candidateArgs = [
    join(import.meta.dirname, 'verify-candidate.mjs'),
    '--change', change,
    '--candidate', candidate,
    '--target-ref', targetRef,
  ];
  const result = spawnSync(process.execPath, candidateArgs, { cwd: process.cwd(), stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const e2e = spawnSync(process.execPath, [
    join(import.meta.dirname, 'test-e2e.mjs'),
    '--if-present',
  ], { cwd: process.cwd(), stdio: 'inherit' });
  if (e2e.status !== 0) process.exit(e2e.status ?? 1);
}

try {
  const options = parseArgs(process.argv.slice(2));
  required(options, 'event');
  if (options.event === 'pull_request') {
    required(options, 'branch', 'target-ref');
    const match = options.branch.match(/^change\/([A-Za-z0-9-]+)\/candidate-integration$/);
    if (!match) {
      process.stdout.write('NOTE: this is not a candidate-integration branch; candidate verification skipped.\n');
    } else {
      run(match[1], options.candidate ?? '001', options['target-ref']);
    }
  } else if (options.event === 'push') {
    required(options, 'before', 'after');
    const changed = git(['diff', '--name-only', options.before, options.after]).split('\n').filter(Boolean);
    const candidateFiles = changed
      .map((path) => ({ path, match: path.match(/^changes\/([^/]+)\/releases\/candidate-(\d{3})\.yaml$/) }))
      .filter(({ match }) => match);
    const servicePaths = new Set(readRegistry().services.map((service) => service.path));
    const changedServices = changed.filter((path) => servicePaths.has(path));
    const declaredServices = new Set();
    for (const { path, match } of candidateFiles) {
      const candidate = readYaml(path);
      if (candidate.state === 'draft') {
        process.stdout.write(`NOTE: ${path} is draft; candidate verification skipped.\n`);
        continue;
      }
      for (const service of candidate.services ?? []) declaredServices.add(service.path);
      run(match[1], match[2], options.before);
    }
    const unrecorded = changedServices.filter((path) => !declaredServices.has(path));
    const setupReceiptPath = 'changes/CHG-PILOT-SETUP-001/PRS.yaml';
    const setup = [];
    if (unrecorded.length && changed.includes(setupReceiptPath)) {
      const receipts = readYaml(setupReceiptPath).prs ?? [];
      for (const path of unrecorded) {
        const service = readRegistry().services.find((entry) => entry.path === path);
        const receipt = receipts.find((row) => row.repo === service.id);
        verifySetupPointer({ root: process.cwd(), path, before: options.before, after: options.after, service, receipt });
        setup.push(path);
      }
      const verified = spawnSync(process.execPath, [join(import.meta.dirname, 'verify-prs.mjs'), '--change', 'CHG-PILOT-SETUP-001'], { cwd: process.cwd(), stdio: 'inherit' });
      if (verified.status !== 0) process.exit(verified.status ?? 1);
      for (const path of setup) process.stdout.write(`NOTE: verified metadata-only setup pointer: ${path}; not a product Candidate.\n`);
    }
    const initial = options['allow-initial-registration'] === 'true'
      ? unrecorded.filter((path) => !git(['ls-tree', options.before, '--', path]))
      : [];
    for (const path of initial) process.stdout.write(`NOTE: initial service registration: ${path}; no product integration claimed.\n`);
    const missingCandidates = unrecorded.filter((path) => !initial.includes(path) && !setup.includes(path));
    if (missingCandidates.length) throw new Error(`submodule pointer changed without a matching candidate: ${missingCandidates.join(', ')}`);
    if (!candidateFiles.length && !changedServices.length) {
      process.stdout.write('NOTE: this push did not change a candidate or service pointer.\n');
    }
  } else {
    throw new Error(`unsupported --event: ${options.event}`);
  }
} catch (error) {
  fail(error.message);
}
