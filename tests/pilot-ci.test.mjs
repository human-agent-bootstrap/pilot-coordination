import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8'));

test('public pilot independently runs browser planning UI checks', () => {
  const job = workflow.jobs['planning-ui'];
  assert.ok(job, 'planning-ui job must exist');
  assert.equal(job['runs-on'], 'ubuntu-latest');
  const commands = job.steps.filter((step) => step.run).map((step) => step.run);
  assert.ok(commands.includes('npx playwright install --with-deps chromium'));
  assert.ok(commands.includes('npm run test:ui'));
});

test('public pilot pins third-party Actions to exact commit SHAs', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w/-]+@[0-9a-f]{40}$/);
    }
  }
});
