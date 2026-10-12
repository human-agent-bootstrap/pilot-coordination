import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, readWorkUnits, required } from './lib.mjs';

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
}

// A Root with no Change yet cannot have a branch that maps to a Work Unit. That is the
// state of a freshly initialized Root and of the template itself, so the gate has nothing
// to check rather than something to reject.
function uninitialized() {
  const directory = join(process.cwd(), 'changes');
  if (!existsSync(directory)) return true;
  return !readdirSync(directory, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && !entry.name.startsWith('_'));
}

function check(branch) {
  const match = branch.match(/^(?:change|feat|fix|refactor|test|docs|chore)\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_-]+)$/);
  if (!match) throw new Error(`branch does not identify a Change and work unit: ${branch}`);

  const [, change] = match;
  const units = readWorkUnits(change).filter((unit) => unit.branch === branch);
  if (units.length !== 1) {
    throw new Error(`${units.length || 'no'} work unit in ${change} declares branch ${branch}`);
  }

  const result = spawnSync(process.execPath, [
    new URL('./workflow-check.mjs', import.meta.url).pathname,
    '--change', change,
    '--unit', units[0].id,
    '--expected-branch', branch,
  ], { cwd: process.cwd(), encoding: 'utf8', stdio: 'inherit' });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options['branch-from-git'] && !options.branch) {
    options.branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
    if (!options.branch) throw new Error('detached HEAD: pass --branch explicitly');
  }
  required(options, 'branch');
  if (uninitialized()) {
    process.stdout.write('Workflow check SKIP: no Change exists yet; nothing maps to a work unit.\n');
  } else {
    check(options.branch);
  }
} catch (error) {
  fail(error.message);
}
