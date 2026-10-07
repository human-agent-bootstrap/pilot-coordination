import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8');
const candidateGate = readFileSync(resolve(import.meta.dirname, '../scripts/ci-candidate-check.mjs'), 'utf8');
const e2eRunner = readFileSync(resolve(import.meta.dirname, '../scripts/test-e2e.mjs'), 'utf8');
const codeowners = readFileSync(resolve(import.meta.dirname, '../.github/CODEOWNERS'), 'utf8');
const gitignore = readFileSync(resolve(import.meta.dirname, '../.gitignore'), 'utf8');
const pullRequestJob = workflow.slice(
  workflow.indexOf('  pull-request:'),
  workflow.indexOf('\n  main:'),
);
const mainJob = workflow.slice(workflow.indexOf('  main:'));

test('CI validates the registry before trusting any manifest', () => {
  assert.match(workflow, /npm run verify:registry/);
});

test('pull requests run untrusted code without private credentials', () => {
  assert.match(pullRequestJob, /runs-on: ubuntu-latest/);
  assert.match(pullRequestJob, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(pullRequestJob, /npm ci --ignore-scripts/);
  assert.match(pullRequestJob, /verify:registry -- --strict --allow-uninitialized/);
  assert.doesNotMatch(pullRequestJob, /self-hosted|submodules:|COORDINATION_GITHUB_TOKEN/);
});

test('trusted main pushes run remote candidate verification', () => {
  assert.match(mainJob, /runs-on: ubuntu-latest/);
  assert.match(mainJob, /submodules: recursive/);
  assert.match(mainJob, /verify:candidate:ci -- --event push/);
  assert.match(mainJob, /COORDINATION_GITHUB_TOKEN/);
});

test('work-unit scope validation stays scoped to pull requests', () => {
  assert.match(pullRequestJob, /node scripts\/ci-workflow-check\.mjs --branch "\$\{\{ github\.head_ref \}\}"/);
  assert.doesNotMatch(mainJob, /ci-workflow-check/);
});

test('root CI assumes no service stack', () => {
  // Per-stack setup belongs to each service repository's own CI.
  assert.doesNotMatch(workflow, /uv sync|setup-uv|--prefix services\//);
});

test('public pilot uses only the built-in read token and does not persist credentials', () => {
  assert.match(workflow, /persist-credentials: false/);
  assert.match(mainJob, /token: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test('final candidates run E2E when a suite is present', () => {
  assert.match(candidateGate, /test-e2e\.mjs'?\),?\s*'--if-present'/);
  assert.match(e2eRunner, /no e2e\/\*\.test\.mjs files found/);
  assert.match(e2eRunner, /optional E2E skipped/);
  assert.doesNotMatch(workflow, /hashFiles\('e2e\/\*\.test\.mjs'\)/);
});

test('trusted executable inputs require coordinator review', () => {
  for (const path of ['/.github/', '/scripts/', '/tests/', '/e2e/', '/package.json', '/package-lock.json']) {
    assert.match(codeowners, new RegExp(`^${path.replaceAll('/', '\\/').replace('.', '\\.')} `, 'm'));
  }
});

test('local task packets are ignored separately from macOS metadata', () => {
  assert.match(gitignore, /^\.DS_Store$/m);
  assert.match(gitignore, /^\.task-packets\/$/m);
});

test('documented local commands resolve to real scripts', () => {
  const repository = resolve(import.meta.dirname, '..');
  const docs = ['README.md', 'RUNBOOK.md', 'AGENTS.md', 'WRITER.md']
    .filter((path) => existsSync(resolve(repository, path)))
    .map((path) => readFileSync(resolve(repository, path), 'utf8'))
    .join('\n')
    .replace(/```ya?ml[\s\S]*?```/g, '');
  const pkg = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8'));
  for (const [, script] of docs.matchAll(/node scripts\/([A-Za-z0-9.-]+\.mjs)/g)) {
    assert.equal(existsSync(resolve(repository, 'scripts', script)), true, `missing scripts/${script}`);
  }
  for (const [, command] of docs.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
    assert.ok(pkg.scripts[command], `missing npm script ${command}`);
  }
});
