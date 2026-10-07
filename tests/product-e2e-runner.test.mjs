import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const runner = resolve(import.meta.dirname, '../scripts/test-e2e.mjs');
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

test('product E2E excludes the planning UI suite and reports no product coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-e2e-discovery-'));
  try {
    mkdirSync(join(root, 'e2e'));
    writeFileSync(join(root, 'e2e/orchestration-ui.test.mjs'), "throw new Error('planning UI must use Playwright Test');\n");
    const optional = spawnSync(process.execPath, [runner, '--if-present'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(optional.status, 0, optional.stdout + optional.stderr);
    assert.match(optional.stdout, /optional E2E skipped/);
    const required = spawnSync(process.execPath, [runner], { cwd: root, env, encoding: 'utf8' });
    assert.equal(required.status, 1);
    assert.match(required.stderr, /no e2e\/\*\.test\.mjs files found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
