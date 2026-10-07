import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs, readWorkUnits, required } from './lib.mjs';

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options['branch-from-git'] && !options.branch) {
    options.branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
    if (!options.branch) throw new Error('detached HEAD: pass --branch explicitly');
  }
  required(options, 'branch');
  const match = options.branch.match(/^(?:change|feat|fix|refactor|test|docs|chore)\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_-]+)$/);
  if (!match) throw new Error(`branch does not identify a Change and work unit: ${options.branch}`);

  const [, change] = match;
  const units = readWorkUnits(change).filter((unit) => unit.branch === options.branch);
  if (units.length !== 1) {
    throw new Error(`${units.length || 'no'} work unit in ${change} declares branch ${options.branch}`);
  }

  const result = spawnSync(process.execPath, [
    new URL('./workflow-check.mjs', import.meta.url).pathname,
    '--change', change,
    '--unit', units[0].id,
    '--expected-branch', options.branch,
  ], { cwd: process.cwd(), encoding: 'utf8', stdio: 'inherit' });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} catch (error) {
  fail(error.message);
}
