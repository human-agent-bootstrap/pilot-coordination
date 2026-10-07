import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fail, parseArgs, readChangeManifest, readRegistry, required } from './lib.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function lines(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function allows(path, pattern) {
  const allowed = String(pattern);
  if (allowed === '**') return true;
  if (allowed.endsWith('/**')) return path.startsWith(allowed.slice(0, -2));
  return path === allowed;
}

try {
  const options = parseArgs(process.argv.slice(2));
  required(options, 'change', 'unit');
  const manifest = readChangeManifest(options.change, options['plan-sha']);
  const strict = readRegistry(options['plan-sha']).version >= 2 || manifest.schema_version >= 1;
  if (strict && manifest.schema_version !== 1) throw new Error('WORK_UNITS.yaml schema_version must be 1');
  const unit = manifest.work_units.find((item) => item.id === options.unit);
  if (!unit) throw new Error(`unknown work unit: ${options.unit}`);
  if (strict && unit.repo !== 'root' && !options['plan-sha']) {
    throw new Error('--plan-sha is required for implementation work units');
  }
  const repoPath = resolve(process.cwd(), options['repo-path'] || '.');
  const branch = git(['branch', '--show-current'], repoPath);
  const expectedBranch = options['expected-branch'] || unit.branch;
  if (branch !== expectedBranch) throw new Error(`branch mismatch: expected ${expectedBranch}, found ${branch || '(detached HEAD)'}`);
  const head = git(['rev-parse', 'HEAD'], repoPath);
  if (unit.base_sha && head !== unit.base_sha) {
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', unit.base_sha, head], { cwd: repoPath });
    if (ancestry.status !== 0) {
      throw new Error(`base mismatch: HEAD ${head} does not descend from base_sha ${unit.base_sha}`);
    }
  }
  const changed = [...new Set([
    ...lines(git(['diff', '--name-only', `${unit.base_sha}...HEAD`], repoPath)),
    ...lines(git(['diff', '--cached', '--name-only'], repoPath)),
    ...lines(git(['diff', '--name-only'], repoPath)),
    ...lines(git(['ls-files', '--others', '--exclude-standard'], repoPath)),
  ])];
  const outside = changed.filter((path) => !unit.write_paths.some((allowed) => allows(path, allowed)));
  if (outside.length) throw new Error(`scope violation: ${outside.join(', ')}`);
  process.stdout.write(`Workflow check PASS: ${options.change}/${unit.id}; base ${unit.base_sha}; ${changed.length} changed file(s).\n`);
} catch (error) {
  fail(error.message);
}
