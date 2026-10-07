import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const scripts = join(root, 'scripts');
const frontSha = 'e9f0fb31c9f72fdf1c3a30923c3d7b62a69d3166';
const backSha = '75c54550c79d5a86ab6685c3de428ff3fd261586';

function run(script, args, cwd = root) {
  return spawnSync(process.execPath, [join(scripts, script), ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coord-root-fixture-'));
  mkdirSync(join(dir, 'changes/CHG-FIXTURE-001/releases'), { recursive: true });
  mkdirSync(join(dir, 'services/front'), { recursive: true });
  mkdirSync(join(dir, 'services/back'), { recursive: true });
  writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml'), `change_id: CHG-FIXTURE-001\nwork_units:\n  - id: sample-ui\n    repo: front\n    branch: feat/CHG-FIXTURE-001/sample-ui\n    base_sha: ${frontSha}\n    write_paths:\n      - src/**\n      - tests/**\n    depends_on:\n      - contract\n    verify:\n      - npm test\n`);
  writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/releases/candidate-001.yaml'), `change_id: CHG-FIXTURE-001\ncandidate: 1\nservices:\n  - repo: front\n    path: services/front\n    sha: ${frontSha}\n  - repo: back\n    path: services/back\n    sha: ${backSha}\n`);
  writeRegistry(dir, ['front', 'back']);
  return dir;
}

function writeRegistry(dir, ids) {
  const services = ids
    .map((id) => `  - id: ${id}\n    path: services/${id}\n    repo: https://example.invalid/${id}.git\n    stack: test\n    verify:\n      - npm test\n`)
    .join('');
  writeFileSync(join(dir, 'services/registry.yaml'), `version: 1\nservices:\n${services}`);
  writeFileSync(join(dir, '.gitmodules'), ids.map((id) => `[submodule "services/${id}"]\n\tpath = services/${id}\n\turl = https://example.invalid/${id}.git\n`).join(''));
}

// Initialize each named service directory as a git repo and return its HEAD.
function initServices(dir, ids) {
  const shas = new Map();
  for (const id of ids) {
    const serviceDir = join(dir, 'services', id);
    mkdirSync(serviceDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: serviceDir });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: serviceDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: serviceDir });
    writeFileSync(join(serviceDir, 'README.md'), id);
    execFileSync('git', ['add', '.'], { cwd: serviceDir });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: serviceDir });
    shas.set(id, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: serviceDir, encoding: 'utf8' }).trim());
  }
  return shas;
}

function writeCandidate(dir, change, entries, candidate = '001') {
  const services = entries.map(({ repo, path, sha }) => `  - repo: ${repo}\n    path: ${path}\n    sha: ${sha}\n`).join('');
  writeFileSync(join(dir, `changes/${change}/releases/candidate-${candidate}.yaml`), `change_id: ${change}\ncandidate: ${Number(candidate)}\nservices:\n${services}`);
}

function workflowFixture() {
  const dir = fixture();
  const worktree = join(dir, 'child-worktree');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worktree });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktree });
  writeFileSync(join(worktree, 'README.md'), 'baseline\n');
  writeFileSync(join(worktree, 'src/app.js'), 'export const baseline = true;\n');
  execFileSync('git', ['add', '.'], { cwd: worktree });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: worktree });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  execFileSync('git', ['checkout', '-qb', 'feat/CHG-FIXTURE-001/sample-ui'], { cwd: worktree });
  writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml'), `change_id: CHG-FIXTURE-001\nwork_units:\n  - id: sample-ui\n    repo: front\n    branch: feat/CHG-FIXTURE-001/sample-ui\n    base_sha: ${base}\n    write_paths:\n      - src/**\n    depends_on: []\n    verify:\n      - npm test\n`);
  return { dir, worktree };
}

test('bootstrap defaults to dry-run and writes no task packet', () => {
  const dir = fixture();
  try {
    const result = run('bootstrap.mjs', ['--change', 'CHG-FIXTURE-001', '--unit', 'sample-ui', '--writer', 'alice', '--run', 'run-1'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN/);
    assert.match(result.stdout, /feat\/CHG-FIXTURE-001\/sample-ui/);
    assert.match(result.stdout, /does not create a branch or workspace/);
    assert.throws(() => readFileSync(join(dir, '.task-packets/run-1.md')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bootstrap apply writes a packet and refuses unknown unit', () => {
  const dir = fixture();
  try {
    const applied = run('bootstrap.mjs', ['--change', 'CHG-FIXTURE-001', '--unit', 'sample-ui', '--writer', 'alice', '--run', 'run-2', '--apply'], dir);
    assert.equal(applied.status, 0, applied.stderr);
    const packet = readFileSync(join(dir, '.task-packets/run-2.md'), 'utf8');
    assert.match(packet, /# TASK/);
    assert.match(packet, /# HANDOFF/);
    const missing = run('bootstrap.mjs', ['--change', 'CHG-FIXTURE-001', '--unit', 'missing', '--writer', 'alice', '--run', 'run-3'], dir);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /unknown work unit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bootstrap apply refuses identifiers that could escape or corrupt a task packet', () => {
  const dir = fixture();
  try {
    const readme = join(dir, 'README.md');
    writeFileSync(readme, 'do not overwrite\n');
    const cases = [
      ['--run', '../README'],
      ['--change', '../CHG-FIXTURE-001'],
      ['--unit', '../sample-ui'],
      ['--writer', 'alice\n# injected'],
    ];
    for (const [flag, value] of cases) {
      const args = ['--change', 'CHG-FIXTURE-001', '--unit', 'sample-ui', '--writer', 'alice', '--run', 'run-escape', '--apply'];
      args[args.indexOf(flag) + 1] = value;
      const result = run('bootstrap.mjs', args, dir);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid (run ID|change ID|work unit ID|writer)/);
    }
    assert.equal(readFileSync(readme, 'utf8'), 'do not overwrite\n');
    assert.equal(existsSync(join(dir, '.task-packets', '..', 'README.md.md')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workflow check rejects an incorrect branch before validation', () => {
  const dir = fixture();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), 'fixture');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir });
    const result = run('workflow-check.mjs', ['--change', 'CHG-FIXTURE-001', '--unit', 'sample-ui'], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /branch mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workflow check accepts an explicit branch expected by a follow-up PR', () => {
  const { dir, worktree } = workflowFixture();
  try {
    execFileSync('git', ['branch', '-m', 'fix/CHG-FIXTURE-001/main-ci-validation'], { cwd: worktree });
    const result = run('workflow-check.mjs', [
      '--change', 'CHG-FIXTURE-001',
      '--unit', 'sample-ui',
      '--repo-path', worktree,
      '--expected-branch', 'fix/CHG-FIXTURE-001/main-ci-validation',
    ], dir);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CI workflow check resolves a planning unit by its declared branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-root-ci-branch-'));
  try {
    execFileSync('git', ['init', '-qb', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), 'version: 1\nservices: []\n');
    writeFileSync(join(dir, 'README.md'), 'baseline\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-qb', 'change/CHG-CUSTOM-001/coordination'], { cwd: dir });
    mkdirSync(join(dir, 'changes/CHG-CUSTOM-001'), { recursive: true });
    writeFileSync(join(dir, 'changes/CHG-CUSTOM-001/WORK_UNITS.yaml'), `change_id: CHG-CUSTOM-001
work_units:
  - id: contract
    repo: root
    branch: change/CHG-CUSTOM-001/coordination
    base_sha: ${base}
    write_paths: [changes/CHG-CUSTOM-001/**]
    depends_on: []
    verify: [npm test]
`);
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'planning'], { cwd: dir });
    const result = run('ci-workflow-check.mjs', [
      '--branch', 'change/CHG-CUSTOM-001/coordination',
    ], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CHG-CUSTOM-001\/contract/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const state of ['untracked', 'unstaged', 'staged']) {
  test(`workflow check rejects an out-of-scope ${state} change`, () => {
    const { dir, worktree } = workflowFixture();
    try {
      if (state === 'untracked') writeFileSync(join(worktree, 'outside.txt'), 'outside\n');
      else writeFileSync(join(worktree, 'README.md'), `${state}\n`);
      if (state === 'staged') execFileSync('git', ['add', 'README.md'], { cwd: worktree });
      const result = run('workflow-check.mjs', ['--change', 'CHG-FIXTURE-001', '--unit', 'sample-ui', '--repo-path', worktree], dir);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /scope violation/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('workflow check treats ** as full-repository scope', () => {
  const { dir, worktree } = workflowFixture();
  try {
    const manifestPath = join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8')
      .replace('      - src/**', '      - "**"'));
    mkdirSync(join(worktree, '.github/workflows'), { recursive: true });
    writeFileSync(join(worktree, 'README.md'), 'greenfield repository\n');
    writeFileSync(join(worktree, '.github/workflows/ci.yml'), 'name: ci\n');
    const result = run('workflow-check.mjs', [
      '--change', 'CHG-FIXTURE-001',
      '--unit', 'sample-ui',
      '--repo-path', worktree,
    ], dir);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workflow check never lets --allow-descendant bypass ancestry', () => {
  const { dir, worktree } = workflowFixture();
  try {
    const tree = execFileSync('git', ['write-tree'], { cwd: worktree, encoding: 'utf8' }).trim();
    const unrelated = execFileSync('git', ['commit-tree', tree], {
      cwd: worktree,
      encoding: 'utf8',
      input: 'unrelated\n',
    }).trim();
    const manifestPath = join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8')
      .replace(/base_sha: [0-9a-f]{40}/, `base_sha: ${unrelated}`));
    const result = run('workflow-check.mjs', [
      '--change', 'CHG-FIXTURE-001',
      '--unit', 'sample-ui',
      '--repo-path', worktree,
      '--allow-descendant',
    ], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not descend from base_sha/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('candidate verification accepts matching submodule SHAs', () => {
  const dir = fixture();
  try {
    const actualShas = new Map();
    for (const service of ['front', 'back']) {
      const serviceDir = join(dir, 'services', service);
      execFileSync('git', ['init', '-q'], { cwd: serviceDir });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: serviceDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: serviceDir });
      writeFileSync(join(serviceDir, 'README.md'), service);
      execFileSync('git', ['add', '.'], { cwd: serviceDir });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: serviceDir });
      actualShas.set(service, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: serviceDir, encoding: 'utf8' }).trim());
    }
    writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/releases/candidate-001.yaml'), `change_id: CHG-FIXTURE-001\ncandidate: 1\nservices:\n  - repo: front\n    path: services/front\n    sha: ${actualShas.get('front')}\n  - repo: back\n    path: services/back\n    sha: ${actualShas.get('back')}\n`);
    const result = run('verify-candidate.mjs', ['--change', 'CHG-FIXTURE-001'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Candidate CHG-FIXTURE-001: PASS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('candidate verification rejects duplicate service identities', () => {
  const dir = fixture();
  try {
    const actualShas = new Map();
    for (const service of ['front', 'back']) {
      const serviceDir = join(dir, 'services', service);
      execFileSync('git', ['init', '-q'], { cwd: serviceDir });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: serviceDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: serviceDir });
      writeFileSync(join(serviceDir, 'README.md'), service);
      execFileSync('git', ['add', '.'], { cwd: serviceDir });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: serviceDir });
      actualShas.set(service, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: serviceDir, encoding: 'utf8' }).trim());
    }
    writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/releases/candidate-001.yaml'), `change_id: CHG-FIXTURE-001\ncandidate: 1\nservices:\n  - repo: front\n    path: services/front\n    sha: ${actualShas.get('front')}\n  - repo: front\n    path: services/back\n    sha: ${actualShas.get('back')}\n`);
    const result = run('verify-candidate.mjs', ['--change', 'CHG-FIXTURE-001'], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lists front more than once/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('candidate verification supports one service and a subset of the registry', () => {
  const dir = fixture();
  try {
    writeRegistry(dir, ['front', 'back', 'search', 'ingest', 'gateway']);
    const shas = initServices(dir, ['front', 'back', 'search', 'ingest', 'gateway']);
    // A change may involve only one of five registered services.
    writeCandidate(dir, 'CHG-FIXTURE-001', [{ repo: 'search', path: 'services/search', sha: shas.get('search') }]);
    const single = run('verify-candidate.mjs', ['--change', 'CHG-FIXTURE-001'], dir);
    assert.equal(single.status, 0, single.stderr);
    assert.match(single.stdout, /1 service\(s\)/);

    writeCandidate(dir, 'CHG-FIXTURE-001', ['front', 'back', 'search', 'ingest', 'gateway']
      .map((id) => ({ repo: id, path: `services/${id}`, sha: shas.get(id) })));
    const all = run('verify-candidate.mjs', ['--change', 'CHG-FIXTURE-001'], dir);
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /5 service\(s\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('candidate verification rejects a service that is not registered', () => {
  const dir = fixture();
  try {
    const shas = initServices(dir, ['front', 'back']);
    writeCandidate(dir, 'CHG-FIXTURE-001', [{ repo: 'payments', path: 'services/payments', sha: shas.get('front') }]);
    const result = run('verify-candidate.mjs', ['--change', 'CHG-FIXTURE-001'], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /payments is not in services\/registry\.yaml/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('candidate verification resolves an explicit candidate number', () => {
  const dir = fixture();
  try {
    const shas = initServices(dir, ['front', 'back']);
    writeCandidate(dir, 'CHG-FIXTURE-001', [{ repo: 'front', path: 'services/front', sha: shas.get('front') }], '002');
    const result = run('verify-candidate.mjs', ['--change', 'CHG-FIXTURE-001', '--candidate', '2'], dir);
    assert.equal(result.status, 0, result.stderr);
    const missing = run('verify-candidate.mjs', ['--change', 'CHG-FIXTURE-001', '--candidate', '7'], dir);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /candidate-007\.yaml/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registry verification requires registry and .gitmodules to agree', () => {
  const dir = fixture();
  try {
    initServices(dir, ['front', 'back']);
    assert.equal(run('verify-registry.mjs', [], dir).status, 0);

    // A submodule missing from the registry must fail.
    writeFileSync(join(dir, '.gitmodules'), `${readFileSync(join(dir, '.gitmodules'), 'utf8')}[submodule "services/orphan"]\n\tpath = services/orphan\n\turl = https://example.invalid/orphan.git\n`);
    const orphan = run('verify-registry.mjs', [], dir);
    assert.notEqual(orphan.status, 0);
    assert.match(orphan.stderr, /services\/orphan is not registered/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registry verification rejects a work unit naming an unknown repo', () => {
  const dir = fixture();
  try {
    initServices(dir, ['front', 'back']);
    writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml'), 'change_id: CHG-FIXTURE-001\nwork_units:\n  - id: ghost\n    repo: nowhere\n    write_paths:\n      - src/**\n    depends_on: []\n');
    const result = run('verify-registry.mjs', [], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repo "nowhere" is not a registry id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registry verification flags concurrent work units that share write paths', () => {
  const dir = fixture();
  try {
    initServices(dir, ['front', 'back']);
    // Two independent units in the same repo both claiming src/** is the team-collision case.
    writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml'), 'change_id: CHG-FIXTURE-001\nwork_units:\n  - id: story-a\n    repo: front\n    write_paths:\n      - src/**\n    depends_on: []\n  - id: story-b\n    repo: front\n    write_paths:\n      - src/api/sample.ts\n    depends_on: []\n');
    const warn = run('verify-registry.mjs', [], dir);
    assert.equal(warn.status, 0, warn.stderr);
    assert.match(warn.stdout, /concurrent units story-a and story-b both write/);

    const strict = run('verify-registry.mjs', ['--strict'], dir);
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /write-path overlap/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registry verification treats ** as overlapping every path', () => {
  const dir = fixture();
  try {
    initServices(dir, ['front', 'back']);
    writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml'), 'change_id: CHG-FIXTURE-001\nwork_units:\n  - id: greenfield\n    repo: front\n    write_paths:\n      - "**"\n    depends_on: []\n  - id: feature\n    repo: front\n    write_paths:\n      - src/api/**\n    depends_on: []\n');
    const result = run('verify-registry.mjs', ['--strict'], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /greenfield and feature both write/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registry verification allows shared paths when depends_on orders the units', () => {
  const dir = fixture();
  try {
    initServices(dir, ['front', 'back']);
    writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml'), 'change_id: CHG-FIXTURE-001\nwork_units:\n  - id: story-a\n    repo: front\n    write_paths:\n      - src/**\n    depends_on: []\n  - id: story-b\n    repo: front\n    write_paths:\n      - src/api/sample.ts\n    depends_on:\n      - story-a\n');
    const result = run('verify-registry.mjs', ['--strict'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 warning\(s\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registry verification ignores units in a terminal state', () => {
  const dir = fixture();
  try {
    initServices(dir, ['front', 'back']);
    writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml'), 'change_id: CHG-FIXTURE-001\nwork_units:\n  - id: story-a\n    repo: front\n    state: merged\n    write_paths:\n      - src/**\n    depends_on: []\n  - id: story-b\n    repo: front\n    write_paths:\n      - src/**\n    depends_on: []\n');
    const result = run('verify-registry.mjs', ['--strict'], dir);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('task packets derive contracts from the change and verify from the registry', () => {
  const dir = fixture();
  try {
    mkdirSync(join(dir, 'changes/CHG-FIXTURE-001/contracts'), { recursive: true });
    writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/contracts/search.openapi.yaml'), 'openapi: 3.1.0\n');
    // No verify list on the unit, so the registry's commands must be inherited.
    writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml'), 'change_id: CHG-FIXTURE-001\nwork_units:\n  - id: sample-ui\n    repo: front\n    goal: build it\n    branch: feat/CHG-FIXTURE-001/sample-ui\n    base_sha: abc123\n    write_paths:\n      - src/**\n    depends_on: []\n');
    const applied = run('bootstrap.mjs', ['--change', 'CHG-FIXTURE-001', '--unit', 'sample-ui', '--writer', 'w', '--run', 'run-1', '--apply'], dir);
    assert.equal(applied.status, 0, applied.stderr);
    const packet = readFileSync(join(dir, '.task-packets/run-1.md'), 'utf8');
    assert.match(packet, /changes\/CHG-FIXTURE-001\/contracts\/search\.openapi\.yaml/);
    assert.doesNotMatch(packet, /todo-api\.openapi\.yaml/);
    assert.match(packet, /VERIFY \(service registry\)/);
    assert.match(packet, /- npm test \(expect exit 0\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('task packets refuse to invent a contract or verification', () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, 'changes/CHG-FIXTURE-001/WORK_UNITS.yaml'), 'change_id: CHG-FIXTURE-001\nwork_units:\n  - id: lonely\n    repo: root\n    goal: coordinate\n    branch: change/CHG-FIXTURE-001/coordination\n    base_sha: abc123\n    write_paths:\n      - changes/**\n    depends_on: []\n');
    const applied = run('bootstrap.mjs', ['--change', 'CHG-FIXTURE-001', '--unit', 'lonely', '--writer', 'w', '--run', 'run-2', '--apply'], dir);
    assert.equal(applied.status, 0, applied.stderr);
    const packet = readFileSync(join(dir, '.task-packets/run-2.md'), 'utf8');
    assert.match(packet, /declares no contract snapshot/);
    assert.match(packet, /No verification is declared/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init removes the template\'s own change records but keeps the skeleton', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-root-init-'));
  try {
    mkdirSync(join(dir, 'changes/_TEMPLATE'), { recursive: true });
    mkdirSync(join(dir, 'changes/CHG-OWN-001'), { recursive: true });
    mkdirSync(join(dir, 'services'), { recursive: true });
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, 'changes/_TEMPLATE/PLAN.md'), '# <CHANGE-ID>\n');
    writeFileSync(join(dir, 'changes/CHG-OWN-001/PLAN.md'), '# CHG-OWN-001\n');
    writeFileSync(join(dir, 'services/registry.yaml'), 'version: 2\ngithub:\n  host: <GITHUB-HOST>\n  api_base: <GITHUB-API-BASE>\nservices: []\n');
    writeFileSync(join(dir, '.gitmodules'), '');
    writeFileSync(join(dir, 'README.md'), '# <PROJECT-NAME>\nclone https://<GITHUB-HOST>/<ORG>/<PROJECT-NAME>.git\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '<PROJECT-NAME>', scripts: { test: 'x' } }, null, 2));

    const result = run('init-project.mjs', [
      '--name', 'acme-coord',
      '--org', 'acme',
      '--github-host', 'github.com',
      '--apply',
    ], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(join(dir, 'changes')), ['_TEMPLATE']);
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /acme-coord/);
    assert.doesNotMatch(readFileSync(join(dir, 'README.md'), 'utf8'), /<PROJECT-NAME>|<ORG>|<GITHUB-HOST>/);
    assert.match(readFileSync(join(dir, 'services/registry.yaml'), 'utf8'), /api_base: https:\/\/api\.github\.com/);
    assert.equal(existsSync(join(dir, '.github/CODEOWNERS')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('candidate verification reports an all-digit SHA as a mismatch, not as missing', () => {
  const dir = fixture();
  try {
    initServices(dir, ['front', 'back']);
    // YAML parses a 40-digit SHA as the number 0, which a falsy check would misreport.
    writeCandidate(dir, 'CHG-FIXTURE-001', [{ repo: 'front', path: 'services/front', sha: '0'.repeat(40) }]);
    const result = run('verify-candidate.mjs', ['--change', 'CHG-FIXTURE-001'], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA mismatch/);
    assert.doesNotMatch(result.stderr, /needs path and sha/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
