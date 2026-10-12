import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const runner = resolve(import.meta.dirname, '../scripts/test-e2e.mjs');
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

// e2e/ holds product suites only; the tool's own screen regression lives in tests-ui/.
test('product E2E reports no coverage when e2e/ holds no suite', () => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-e2e-discovery-'));
  try {
    mkdirSync(join(root, 'e2e'));
    writeFileSync(join(root, 'e2e/README.md'), '# Product E2E\n');
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

test('product E2E runs every suite in e2e/ with no name exempt from failing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-e2e-run-'));
  try {
    mkdirSync(join(root, 'e2e'));
    writeFileSync(join(root, 'e2e/product.test.mjs'), "import test from 'node:test'; test('product', () => {});\n");
    const passing = spawnSync(process.execPath, [runner], { cwd: root, env, encoding: 'utf8' });
    assert.equal(passing.status, 0, passing.stdout + passing.stderr);
    // A suite the tool used to exempt by filename is now an ordinary product suite.
    writeFileSync(join(root, 'e2e/orchestration-ui.test.mjs'), "throw new Error('still a product suite');\n");
    const failing = spawnSync(process.execPath, [runner], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(failing.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
