import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fail, parseArgs, readRegistry, readYaml, required } from './lib.mjs';

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
    if (unrecorded.length) throw new Error(`submodule pointer changed without a matching candidate: ${unrecorded.join(', ')}`);
    if (!candidateFiles.length && !changedServices.length) {
      process.stdout.write('NOTE: this push did not change a candidate or service pointer.\n');
    }
  } else {
    throw new Error(`unsupported --event: ${options.event}`);
  }
} catch (error) {
  fail(error.message);
}
