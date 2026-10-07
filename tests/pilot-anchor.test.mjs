import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { repositoryContext } from '../scripts/orchestration/server.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pilot-anchor-'));
  const service = join(root, 'services/api');
  mkdirSync(join(root, 'changes'));
  mkdirSync(join(service, '.github'), { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  for (const cwd of [service, root]) {
    git(cwd, 'init', '-qb', 'main');
    git(cwd, 'config', 'user.name', 'Test');
    git(cwd, 'config', 'user.email', 'test@example.invalid');
    git(cwd, 'config', 'advice.addEmbeddedRepo', 'false');
  }
  writeFileSync(join(service, 'README.md'), 'Unimplemented API anchor\n');
  git(service, 'add', '.');
  git(service, 'commit', '-qm', 'anchor with governance');
  writeFileSync(join(root, 'services/registry.yaml'), 'version: 2\ngithub:\n  host: github.com\nservices:\n  - id: api\n    path: services/api\n    repo: https://github.com/example/api.git\n    owners: [reviewer]\n    verify: []\n');
  writeFileSync(join(root, '.gitmodules'), '[submodule "services/api"]\n  path = services/api\n  url = https://github.com/example/api.git\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'registered anchor');
  return { root, service, git };
}

test('README-only anchor remains eligible for the first service implementation', () => {
  const { root } = fixture();
  try {
    assert.equal(repositoryContext(root).services[0].bootstrapEligible, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a committed product source file makes the service ineligible for bootstrap scope', () => {
  const { root, service, git } = fixture();
  try {
    writeFileSync(join(service, 'app.py'), 'print("product")\n');
    git(service, 'add', 'app.py');
    git(service, 'commit', '-qm', 'product implementation');
    git(root, 'add', 'services/api');
    git(root, 'commit', '-qm', 'pin implemented service');
    assert.equal(repositoryContext(root).services[0].bootstrapEligible, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
