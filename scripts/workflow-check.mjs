import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail, parseArgs, readChangeManifest, readRegistry, required, sha256 } from './lib.mjs';
import { validateCandidateApproval } from './candidate-approval.mjs';

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
  if (options['candidate-approval']) {
    if (unit.repo !== 'root') throw new Error('Candidate approval cannot authorize a service work unit');
    const { approval, state } = validateCandidateApproval(options['candidate-approval'], {
      cwd: repoPath, change: options.change, unit: options.unit, planSha: options['plan-sha'],
      agent: options['candidate-role'] === 'agent',
    });
    if (unit.branch !== approval.branch || JSON.stringify(unit.write_paths) !== JSON.stringify(approval.writePaths)
      || JSON.stringify(unit.verify) !== JSON.stringify(approval.verify)) throw new Error('Candidate approval cannot widen approved plan scope or checks');
    if (options['expected-branch'] && options['expected-branch'] !== approval.branch) throw new Error('Candidate approval cannot change its declared branch');
    unit.base_sha = approval.baseSha;
    if (options['candidate-role'] === 'agent') {
      unit.base_sha = state.agentBaseline.head;
      unit.write_paths = ['e2e/**'];
      // Coordinator records may be pending at agent dispatch; their baseline hashes are fixed.
      const protectedPaths = state.agentBaseline.files;
      for (const entry of protectedPaths) {
        if (sha256(readFileSync(resolve(repoPath, entry.path))) !== entry.digest) throw new Error('Agent changed Coordinator-owned files');
      }
    }
  }
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
  let outside = changed.filter((path) => !unit.write_paths.some((allowed) => allows(path, allowed)));
  if (options['candidate-role'] === 'agent' && options['candidate-approval']) {
    const { state } = validateCandidateApproval(options['candidate-approval'], {
      cwd: repoPath, change: options.change, unit: options.unit, planSha: options['plan-sha'], agent: true,
    });
    const baseline = new Set([...state.agentBaseline.files.map((entry) => entry.path), ...state.agentBaseline.pointers]);
    outside = outside.filter((path) => !baseline.has(path));
  }
  if (outside.length) throw new Error(`scope violation: ${outside.join(', ')}`);
  process.stdout.write(`Workflow check PASS: ${options.change}/${unit.id}; base ${unit.base_sha}; ${changed.length} changed file(s).\n`);
} catch (error) {
  fail(error.message);
}
