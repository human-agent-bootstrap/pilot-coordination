import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as setup from '../scripts/verify-setup-pointers.mjs';

function fixture(product = false) {
  const root = mkdtempSync(join(tmpdir(), 'setup-pointers-'));
  const service = join(root, 'services/api');
  mkdirSync(service, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commit = (cwd, msg) => { git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', msg); return git(cwd, 'rev-parse', 'HEAD'); };
  for (const cwd of [service, root]) {
    git(cwd, 'init', '-qb', 'main'); git(cwd, 'config', 'user.name', 'Test'); git(cwd, 'config', 'user.email', 'test@example.invalid');
  }
  writeFileSync(join(service, 'README.md'), 'anchor');
  const base = commit(service, 'anchor');
  const before = commit(root, 'registered');
  writeFileSync(join(service, product ? 'app.py' : 'README.md'), product ? 'print("product")' : 'one-account instructions');
  const sha = commit(service, 'service setup');
  const after = commit(root, 'pointer receipt');
  return { root, before, after, receipt: { repo: 'api', state: 'merged', base_sha: base, merge_sha: sha } };
}

test('setup pointer exception requires exact metadata-only merge receipt', () => {
  assert.equal(typeof setup.verifySetupPointer, 'function', 'metadata receipt validator is required');
  const data = fixture();
  try {
    const args = { ...data, path: 'services/api', service: { id: 'api' } };
    assert.equal(setup.verifySetupPointer(args), true);
    assert.throws(() => setup.verifySetupPointer({ ...args, receipt: { ...data.receipt, merge_sha: 'a'.repeat(40) } }), /receipt does not match/);
  } finally { rmSync(data.root, { recursive: true, force: true }); }
});

test('product source cannot bypass Candidate validation as a setup pointer', () => {
  assert.equal(typeof setup.verifySetupPointer, 'function', 'metadata receipt validator is required');
  const data = fixture(true);
  try {
    assert.throws(() => setup.verifySetupPointer({ ...data, path: 'services/api', service: { id: 'api' } }), /product files/);
  } finally { rmSync(data.root, { recursive: true, force: true }); }
});
