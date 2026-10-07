import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from './lib.mjs';

try {
  const directory = join(process.cwd(), 'e2e');
  const files = existsSync(directory)
    ? readdirSync(directory)
      .filter((name) => name.endsWith('.test.mjs') && name !== 'orchestration-ui.test.mjs')
      .sort()
      .map((name) => join('e2e', name))
    : [];
  if (files.length === 0) {
    if (process.argv.includes('--if-present')) {
      process.stdout.write('NOTE: no e2e/*.test.mjs files found; optional E2E skipped.\n');
      process.exit(0);
    }
    throw new Error('no e2e/*.test.mjs files found');
  }

  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} catch (error) {
  fail(error.message);
}
