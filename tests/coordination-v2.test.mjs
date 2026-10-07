import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { verifyPrs } from '../scripts/verify-prs.mjs';

const root = resolve(import.meta.dirname, '..');
const scripts = join(root, 'scripts');

function run(script, args, cwd, env = {}) {
  return spawnSync(process.execPath, [join(scripts, script), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function git(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  git(dir, 'init', '-qb', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
}

function commit(dir, message) {
  git(dir, 'add', '.');
  const result = git(dir, 'commit', '-qm', message);
  assert.equal(result.status, 0, result.stderr);
  return git(dir, 'rev-parse', 'HEAD').stdout.trim();
}

test('change:create scaffolds registered services without Front/Back assumptions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-create-'));
  try {
    mkdirSync(join(dir, 'changes'), { recursive: true });
    cpSync(join(root, 'changes/_TEMPLATE'), join(dir, 'changes/_TEMPLATE'), { recursive: true });
    mkdirSync(join(dir, 'services/api'), { recursive: true });
    initRepo(join(dir, 'services/api'));
    writeFileSync(join(dir, 'services/api/README.md'), 'api\n');
    const serviceSha = commit(join(dir, 'services/api'), 'base');
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 1
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    verify:
      - npm test
`);
    initRepo(dir);
    writeFileSync(join(dir, '.gitmodules'), '');
    commit(dir, 'root');

    const result = run('change-create.mjs', [
      '--change', 'CHG-API-001',
      '--services', 'api',
      '--apply',
    ], dir);
    assert.equal(result.status, 0, result.stderr);
    const units = readFileSync(join(dir, 'changes/CHG-API-001/WORK_UNITS.yaml'), 'utf8');
    assert.match(units, /id: api-implementation/);
    assert.match(units, new RegExp(`base_sha: ${serviceSha}`));
    assert.doesNotMatch(units, /front|back/i);
    assert.match(units, /npm test/);
    assert.match(units, /changes\/CHG-API-001\/WORK_UNITS\.yaml/);
    assert.match(units, /e2e\/\*\*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('change:create requires a service anchor commit before planning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-anchor-'));
  try {
    mkdirSync(join(dir, 'changes'), { recursive: true });
    cpSync(join(root, 'changes/_TEMPLATE'), join(dir, 'changes/_TEMPLATE'), { recursive: true });
    mkdirSync(join(dir, 'services/api'), { recursive: true });
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 1
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    verify:
      - npm test
`);
    initRepo(dir);
    writeFileSync(join(dir, '.gitmodules'), '');
    commit(dir, 'root');

    const result = run('change-create.mjs', [
      '--change', 'CHG-API-001',
      '--services', 'api',
      '--apply',
    ], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /anchor commit before change:create/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('change:create uses the committed Root gitlink for registry v2 services', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-gitlink-'));
  try {
    mkdirSync(join(dir, 'changes'), { recursive: true });
    cpSync(join(root, 'changes/_TEMPLATE'), join(dir, 'changes/_TEMPLATE'), { recursive: true });
    mkdirSync(join(dir, 'services/api'), { recursive: true });
    initRepo(join(dir, 'services/api'));
    writeFileSync(join(dir, 'services/api/README.md'), 'api\n');
    const serviceSha = commit(join(dir, 'services/api'), 'base');

    writeFileSync(join(dir, 'services/registry.yaml'), `version: 2
github:
  host: github.com
  api_base: https://api.github.com
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    owners: [acme/api]
    verify: [npm test]
`);
    writeFileSync(join(dir, '.gitmodules'), `[submodule "services/api"]
\tpath = services/api
\turl = https://github.com/acme/api.git
`);
    initRepo(dir);
    git(dir, 'add', '.gitmodules', 'services/registry.yaml');
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${serviceSha},services/api`);
    commit(dir, 'register service');

    const created = run('change-create.mjs', [
      '--change', 'CHG-API-001',
      '--services', 'api',
      '--apply',
    ], dir);
    assert.equal(created.status, 0, created.stderr);
    assert.match(
      readFileSync(join(dir, 'changes/CHG-API-001/WORK_UNITS.yaml'), 'utf8'),
      new RegExp(`base_sha: ${serviceSha}`),
    );

    writeFileSync(join(dir, 'services/api/README.md'), 'drift\n');
    commit(join(dir, 'services/api'), 'drift');
    const drifted = run('change-create.mjs', [
      '--change', 'CHG-API-002',
      '--services', 'api',
      '--apply',
    ], dir);
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /does not match Root gitlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap reads the approved plan commit and emits stable hashes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-packet-'));
  try {
    mkdirSync(join(dir, 'changes/CHG-PACKET-001/contracts'), { recursive: true });
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 2
github:
  host: github.com
  api_base: https://api.github.com
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    owners: [acme/api]
    verify: [npm test]
`);
    writeFileSync(join(dir, 'changes/CHG-PACKET-001/WORK_UNITS.yaml'), `schema_version: 1
change_id: CHG-PACKET-001
state: approved
work_units:
  - id: api-implementation
    repo: api
    state: ready
    goal: approved goal
    branch: feat/CHG-PACKET-001/api-implementation
    base_sha: ${'a'.repeat(40)}
    writer: alice
    write_paths: [src/**]
    depends_on: []
    verify: []
`);
    writeFileSync(join(dir, 'changes/CHG-PACKET-001/contracts/api.json'), '{"type":"object"}\n');
    initRepo(dir);
    const planSha = commit(dir, 'approved plan');
    writeFileSync(join(dir, 'changes/CHG-PACKET-001/WORK_UNITS.yaml'), 'working tree drift\n');

    const result = run('bootstrap.mjs', [
      '--change', 'CHG-PACKET-001',
      '--unit', 'api-implementation',
      '--writer', 'alice',
      '--run', 'run-001',
      '--plan-sha', planSha,
      '--apply',
    ], dir);
    assert.equal(result.status, 0, result.stderr);
    const packet = readFileSync(join(dir, '.task-packets/run-001.md'), 'utf8');
    assert.match(packet, new RegExp(`Plan SHA: ${planSha}`));
    assert.match(packet, /Goal: approved goal/);
    assert.match(packet, /api\.json \(sha256:[0-9a-f]{64}\)/);
    assert.match(packet, /Packet SHA-256: [0-9a-f]{64}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap rejects the wrong writer, non-ready state, and unmet dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-dispatch-'));
  try {
    mkdirSync(join(dir, 'changes/CHG-DISPATCH-001'), { recursive: true });
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 2
github:
  host: github.com
  api_base: https://api.github.com
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    owners: [acme/api]
    verify: [npm test]
`);
    initRepo(dir);
    const writeManifest = ({ state = 'ready', dependencyState = 'merged' } = {}) => {
      writeFileSync(join(dir, 'changes/CHG-DISPATCH-001/WORK_UNITS.yaml'), `schema_version: 1
change_id: CHG-DISPATCH-001
state: approved
work_units:
  - id: prerequisite
    repo: api
    state: ${dependencyState}
    goal: prerequisite
    branch: feat/CHG-DISPATCH-001/prerequisite
    base_sha: ${'a'.repeat(40)}
    writer: bob
    write_paths: [src/prerequisite/**]
    depends_on: []
    verify: [npm test]
  - id: implementation
    repo: api
    state: ${state}
    goal: implementation
    branch: feat/CHG-DISPATCH-001/implementation
    base_sha: ${'a'.repeat(40)}
    writer: alice
    write_paths: [src/implementation/**]
    depends_on: [prerequisite]
    verify: [npm test]
`);
      return commit(dir, `plan ${state} ${dependencyState}`);
    };

    let planSha = writeManifest();
    const wrongWriter = run('bootstrap.mjs', [
      '--change', 'CHG-DISPATCH-001',
      '--unit', 'implementation',
      '--writer', 'mallory',
      '--run', 'wrong-writer',
      '--plan-sha', planSha,
    ], dir);
    assert.notEqual(wrongWriter.status, 0);
    assert.match(wrongWriter.stderr, /writer mismatch/);

    planSha = writeManifest({ state: 'draft' });
    const wrongState = run('bootstrap.mjs', [
      '--change', 'CHG-DISPATCH-001',
      '--unit', 'implementation',
      '--writer', 'alice',
      '--run', 'wrong-state',
      '--plan-sha', planSha,
    ], dir);
    assert.notEqual(wrongState.status, 0);
    assert.match(wrongState.stderr, /must be ready or in_progress/);

    planSha = writeManifest({ dependencyState: 'in_progress' });
    const unmet = run('bootstrap.mjs', [
      '--change', 'CHG-DISPATCH-001',
      '--unit', 'implementation',
      '--writer', 'alice',
      '--run', 'unmet-dependency',
      '--plan-sha', planSha,
    ], dir);
    assert.notEqual(unmet.status, 0);
    assert.match(unmet.stderr, /dependency prerequisite must be merged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry blocks overlapping paths across active Changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-reservation-'));
  try {
    mkdirSync(join(dir, 'services/api'), { recursive: true });
    initRepo(join(dir, 'services/api'));
    writeFileSync(join(dir, 'services/api/README.md'), 'api\n');
    const base = commit(join(dir, 'services/api'), 'base');
    mkdirSync(join(dir, 'changes/CHG-A'), { recursive: true });
    mkdirSync(join(dir, 'changes/CHG-B'), { recursive: true });
    writeFileSync(join(dir, '.gitmodules'), `[submodule "services/api"]
\tpath = services/api
\turl = https://github.com/acme/api.git
`);
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 1
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    verify: [npm test]
`);
    const manifest = (change, path, state = 'ready') => `schema_version: 1
change_id: ${change}
state: active
work_units:
  - id: api-work
    repo: api
    state: ${state}
    goal: work
    branch: feat/${change}/api-work
    base_sha: ${base}
    writer: alice
    write_paths: [${path}]
    depends_on: []
    verify: [npm test]
`;
    writeFileSync(join(dir, 'changes/CHG-A/WORK_UNITS.yaml'), manifest('CHG-A', 'src/**'));
    writeFileSync(join(dir, 'changes/CHG-B/WORK_UNITS.yaml'), manifest('CHG-B', 'src/api/**'));
    const blocked = run('verify-registry.mjs', ['--strict'], dir);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stdout, /CHG-A\/api-work and CHG-B\/api-work/);

    writeFileSync(join(dir, 'changes/CHG-A/WORK_UNITS.yaml'), manifest('CHG-A', 'src/**', 'merged'));
    const released = run('verify-registry.mjs', ['--strict'], dir);
    assert.equal(released.status, 0, released.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry rejects a ready unit whose dependency is not merged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-dependency-'));
  try {
    mkdirSync(join(dir, 'changes/CHG-DEP-001'), { recursive: true });
    mkdirSync(join(dir, 'services/api'), { recursive: true });
    initRepo(join(dir, 'services/api'));
    writeFileSync(join(dir, 'services/api/README.md'), 'api\n');
    const base = commit(join(dir, 'services/api'), 'base');
    writeFileSync(join(dir, '.gitmodules'), `[submodule "services/api"]
\tpath = services/api
\turl = https://github.com/acme/api.git
`);
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 1
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    verify: [npm test]
`);
    writeFileSync(join(dir, 'changes/CHG-DEP-001/WORK_UNITS.yaml'), `schema_version: 1
change_id: CHG-DEP-001
state: approved
work_units:
  - id: prerequisite
    repo: api
    state: in_progress
    goal: prerequisite
    branch: feat/CHG-DEP-001/prerequisite
    base_sha: ${base}
    writer: bob
    write_paths: [src/prerequisite/**]
    depends_on: []
    verify: [npm test]
  - id: implementation
    repo: api
    state: ready
    goal: implementation
    branch: feat/CHG-DEP-001/implementation
    base_sha: ${base}
    writer: alice
    write_paths: [src/implementation/**]
    depends_on: [prerequisite]
    verify: [npm test]
`);
    const result = run('verify-registry.mjs', ['--strict'], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dependency prerequisite must be merged before ready/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry allows ready units whose only unmerged dependency is the planning unit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-planning-dep-'));
  try {
    mkdirSync(join(dir, 'changes/CHG-DEP-002'), { recursive: true });
    mkdirSync(join(dir, 'services/api'), { recursive: true });
    initRepo(join(dir, 'services/api'));
    writeFileSync(join(dir, 'services/api/README.md'), 'api\n');
    const base = commit(join(dir, 'services/api'), 'base');
    writeFileSync(join(dir, '.gitmodules'), `[submodule "services/api"]
\tpath = services/api
\turl = https://github.com/acme/api.git
`);
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 1
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    verify: [npm test]
`);
    // The planning PR itself carries this manifest, so contract-and-plan cannot
    // already be merged; the implementation unit must still be approvable as ready.
    writeFileSync(join(dir, 'changes/CHG-DEP-002/WORK_UNITS.yaml'), `schema_version: 1
change_id: CHG-DEP-002
state: approved
work_units:
  - id: contract-and-plan
    repo: root
    state: in_progress
    goal: planning
    branch: change/CHG-DEP-002/coordination
    base_sha: ${base}
    writer: coordinator
    write_paths: [changes/CHG-DEP-002/**]
    depends_on: []
    verify: [npm test]
  - id: implementation
    repo: api
    state: ready
    goal: implementation
    branch: feat/CHG-DEP-002/implementation
    base_sha: ${base}
    writer: alice
    write_paths: [src/**]
    depends_on: [contract-and-plan]
    verify: [npm test]
`);
    const result = run('verify-registry.mjs', ['--strict'], dir);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('candidate verification enforces evidence and an exact squash-commit range', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-candidate-'));
  const remote = join(dir, 'api.git');
  const service = join(dir, 'services/api');
  try {
    mkdirSync(service, { recursive: true });
    git(dir, 'init', '--bare', '-q', remote);
    initRepo(service);
    writeFileSync(join(service, 'app.txt'), 'base\n');
    const base = commit(service, 'base');
    git(service, 'remote', 'add', 'origin', remote);
    git(service, 'push', '-qu', 'origin', 'main');

    mkdirSync(join(dir, 'changes/CHG-CAND-001/releases'), { recursive: true });
    writeFileSync(join(dir, 'changes/CHG-CAND-001/PLAN.md'), `# Plan

## Acceptance criteria

- [AC-001] Candidate service tests pass.
`);
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 2
github:
  host: github.com
  api_base: https://api.github.com
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    owners: [acme/api]
    verify: [npm test]
`);
    writeFileSync(join(dir, '.gitmodules'), `[submodule "services/api"]
\tpath = services/api
\turl = ${remote}
`);
    initRepo(dir);
    const planSha = commit(dir, 'approved plan');

    writeFileSync(join(service, 'app.txt'), 'change\n');
    const mergeSha = commit(service, 'feat: change');
    git(service, 'push', 'origin', 'main');
    writeFileSync(join(dir, 'changes/CHG-CAND-001/PRS.yaml'), `schema_version: 1
change_id: CHG-CAND-001
state: merged
plan_merge_sha: ${planSha}
prs:
  - key: root-planning
    repo: root
    state: merged
    merge_sha: ${planSha}
  - key: api-implementation
    repo: api
    state: merged
    merge_sha: ${mergeSha}
`);
    writeFileSync(join(dir, 'changes/CHG-CAND-001/releases/candidate-001.yaml'), `schema_version: 1
change_id: CHG-CAND-001
candidate: 1
plan_sha: ${planSha}
services:
  - repo: api
    path: services/api
    base_sha: ${base}
    sha: ${mergeSha}
    source_prs: [api-implementation]
evidence:
  - criterion: AC-001
    kind: command
    command: npm test
    target_sha: ${mergeSha}
    exit_code: 0
`);
    const passed = run('verify-candidate.mjs', [
      '--change', 'CHG-CAND-001',
      '--target-ref', planSha,
    ], dir);
    assert.equal(passed.status, 0, passed.stderr);

    const candidatePath = join(dir, 'changes/CHG-CAND-001/releases/candidate-001.yaml');
    writeFileSync(candidatePath, readFileSync(candidatePath, 'utf8')
      .replace(`plan_sha: ${planSha}`, `plan_sha: ${'d'.repeat(40)}`));
    const wrongPlan = run('verify-candidate.mjs', [
      '--change', 'CHG-CAND-001',
      '--target-ref', planSha,
    ], dir);
    assert.notEqual(wrongPlan.status, 0);
    assert.match(wrongPlan.stderr, /must match PRS\.yaml plan_merge_sha/);
    writeFileSync(candidatePath, readFileSync(candidatePath, 'utf8')
      .replace(`plan_sha: ${'d'.repeat(40)}`, `plan_sha: ${planSha}`));

    writeFileSync(candidatePath, readFileSync(candidatePath, 'utf8')
      .replace('schema_version: 1\n', ''));
    const downgraded = run('verify-candidate.mjs', [
      '--change', 'CHG-CAND-001',
      '--target-ref', planSha,
    ], dir);
    assert.notEqual(downgraded.status, 0);
    assert.match(downgraded.stderr, /candidate schema_version must be 1/);
    writeFileSync(candidatePath, `schema_version: 1\n${readFileSync(candidatePath, 'utf8')}`);

    writeFileSync(join(service, 'app.txt'), 'unrecorded\n');
    const unrecorded = commit(service, 'feat: another change');
    git(service, 'push', 'origin', 'main');
    writeFileSync(candidatePath, readFileSync(candidatePath, 'utf8')
      .replaceAll(mergeSha, unrecorded));
    const blocked = run('verify-candidate.mjs', [
      '--change', 'CHG-CAND-001',
      '--target-ref', planSha,
    ], dir);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /integration range does not exactly match source_prs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify:prs checks GitHub merge SHAs without a separate approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-prs-'));
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const merge = 'c'.repeat(40);
  let responseMerge = merge;
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return ({
    ok: true,
    json: async () => ({
        merged_at: '2026-09-29T00:00:00Z',
        user: { login: 'alice' },
        base: { sha: base },
        head: { sha: head },
        merge_commit_sha: responseMerge,
      }),
    });
  };
  try {
    mkdirSync(join(dir, 'changes/CHG-PRS-001'), { recursive: true });
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 2
github:
  host: github.com
  api_base: https://api.github.com
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
`);
    writeFileSync(join(dir, 'changes/CHG-PRS-001/PRS.yaml'), `schema_version: 1
prs:
  - key: api-implementation
    repo: api
    number: 7
    state: merged
    base_sha: ${base}
    head_sha: ${head}
    merge_sha: ${merge}
`);
    const passed = await verifyPrs({
      argv: ['--change', 'CHG-PRS-001'],
      cwd: dir,
      env: { COORDINATION_GITHUB_TOKEN: 'test' },
      fetchImpl,
    });
    assert.match(passed, /1 merged PR/);
    assert.ok(requested.every((url) => url.startsWith('https://api.github.com/')));

    assert.equal(requested.some((url) => url.includes('/reviews')), false);
    responseMerge = 'd'.repeat(40);
    await assert.rejects(() => verifyPrs({
      argv: ['--change', 'CHG-PRS-001'],
      cwd: dir,
      env: { COORDINATION_GITHUB_TOKEN: 'test' },
      fetchImpl,
    }), /merge_sha.*does not match GitHub/);
    responseMerge = merge;

    writeFileSync(join(dir, 'changes/CHG-PRS-001/PRS.yaml'), 'schema_version: 1\nprs: []\n');
    await assert.rejects(() => verifyPrs({
      argv: ['--change', 'CHG-PRS-001'],
      cwd: dir,
      env: { COORDINATION_GITHUB_TOKEN: 'test' },
      fetchImpl,
    }), /must declare at least one PR/);

    writeFileSync(join(dir, 'changes/CHG-PRS-001/PRS.yaml'), `schema_version: 1
prs:
  - key: api-implementation
    repo: api
    state: merged
`);
    await assert.rejects(() => verifyPrs({
      argv: ['--change', 'CHG-PRS-001'],
      cwd: dir,
      env: { COORDINATION_GITHUB_TOKEN: 'test' },
      fetchImpl,
    }), /expected state merged and a positive PR number/);

    writeFileSync(join(dir, 'changes/CHG-PRS-001/PRS.yaml'), `prs:
  - key: api-implementation
    repo: api
    number: 7
    state: merged
    base_sha: ${base}
    head_sha: ${head}
    merge_sha: ${merge}
`);
    await assert.rejects(() => verifyPrs({
      argv: ['--change', 'CHG-PRS-001'],
      cwd: dir,
      env: { COORDINATION_GITHUB_TOKEN: 'test' },
      fetchImpl,
    }), /PRS\.yaml schema_version must be 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify:prs supports an SSH origin URL for Root PRs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-root-pr-'));
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const merge = 'c'.repeat(40);
  const requested = [];
  try {
    mkdirSync(join(dir, 'changes/CHG-ROOT-001'), { recursive: true });
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 2
github:
  host: github.com
  api_base: https://api.github.com
services: []
`);
    writeFileSync(join(dir, 'changes/CHG-ROOT-001/PRS.yaml'), `schema_version: 1
prs:
  - key: root-planning
    repo: root
    number: 9
    state: merged
    base_sha: ${base}
    head_sha: ${head}
    merge_sha: ${merge}
`);
    initRepo(dir);
    git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/root.git');
    const result = await verifyPrs({
      argv: ['--change', 'CHG-ROOT-001'],
      cwd: dir,
      env: { COORDINATION_GITHUB_TOKEN: 'test' },
      fetchImpl: async (url) => {
        requested.push(url);
        return {
          ok: true,
          json: async () => url.endsWith('/reviews?per_page=100')
            ? [{ user: { login: 'bob' }, state: 'APPROVED' }]
            : {
              merged_at: '2026-09-29T00:00:00Z',
              user: { login: 'alice' },
              base: { sha: base },
              head: { sha: head },
              merge_commit_sha: merge,
            },
        };
      },
    });
    assert.match(result, /1 merged PR/);
    assert.ok(requested.every((url) => url.includes('/repos/acme/root/pulls/9')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('candidate push gate skips draft files but not submodule pointer changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-draft-candidate-'));
  try {
    mkdirSync(join(dir, 'changes/CHG-DRAFT-001/releases'), { recursive: true });
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 1
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
`);
    writeFileSync(join(dir, '.gitmodules'), `[submodule "services/api"]
\tpath = services/api
\turl = https://github.com/acme/api.git
`);
    initRepo(dir);
    git(dir, 'add', '.gitmodules', 'services/registry.yaml');
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},services/api`);
    let committed = git(dir, 'commit', '-qm', 'baseline');
    assert.equal(committed.status, 0, committed.stderr);
    const before = git(dir, 'rev-parse', 'HEAD').stdout.trim();

    const candidatePath = join(dir, 'changes/CHG-DRAFT-001/releases/candidate-001.yaml');
    writeFileSync(candidatePath, `schema_version: 1
change_id: CHG-DRAFT-001
candidate: 1
state: draft
plan_sha: pending-planning-merge
services: []
evidence: []
`);
    git(dir, 'add', 'changes/CHG-DRAFT-001/releases/candidate-001.yaml');
    committed = git(dir, 'commit', '-qm', 'planning');
    assert.equal(committed.status, 0, committed.stderr);
    const planning = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const skipped = run('ci-candidate-check.mjs', [
      '--event', 'push',
      '--before', before,
      '--after', planning,
    ], dir);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /is draft; candidate verification skipped/);

    writeFileSync(candidatePath, readFileSync(candidatePath, 'utf8').replace('evidence: []', 'evidence: []\n# changed'));
    git(dir, 'add', 'changes/CHG-DRAFT-001/releases/candidate-001.yaml');
    git(dir, 'update-index', '--cacheinfo', `160000,${'b'.repeat(40)},services/api`);
    committed = git(dir, 'commit', '-qm', 'change pointer with draft');
    assert.equal(committed.status, 0, committed.stderr);
    const pointerChange = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const blocked = run('ci-candidate-check.mjs', [
      '--event', 'push',
      '--before', planning,
      '--after', pointerChange,
    ], dir);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /submodule pointer changed without a matching candidate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test:e2e fails with zero tests and runs discovered tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-e2e-'));
  try {
    const empty = run('test-e2e.mjs', [], dir);
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /no e2e\/\*\.test\.mjs files found/);

    const optional = run('test-e2e.mjs', ['--if-present'], dir);
    assert.equal(optional.status, 0, optional.stderr);
    assert.match(optional.stdout, /optional E2E skipped/);

    mkdirSync(join(dir, 'e2e'));
    writeFileSync(join(dir, 'e2e/smoke.test.mjs'), `import test from 'node:test';
test('smoke', () => {});
`);
    const passed = run('test-e2e.mjs', [], dir);
    assert.equal(passed.status, 0, passed.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry v2 rejects a manifest that removes schema_version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-schema-'));
  try {
    mkdirSync(join(dir, 'changes/CHG-SCHEMA-001'), { recursive: true });
    mkdirSync(join(dir, 'services/api'), { recursive: true });
    initRepo(join(dir, 'services/api'));
    writeFileSync(join(dir, 'services/api/README.md'), 'api\n');
    const base = commit(join(dir, 'services/api'), 'base');
    writeFileSync(join(dir, '.gitmodules'), `[submodule "services/api"]
\tpath = services/api
\turl = https://github.com/acme/api.git
`);
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 2
github:
  host: github.com
  api_base: https://api.github.com
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    owners: [acme/api]
    verify: [npm test]
`);
    writeFileSync(join(dir, 'changes/CHG-SCHEMA-001/WORK_UNITS.yaml'), `change_id: CHG-SCHEMA-001
state: approved
work_units:
  - id: implementation
    repo: api
    state: ready
    goal: implementation
    branch: feat/CHG-SCHEMA-001/implementation
    base_sha: ${base}
    writer: alice
    write_paths: [src/**]
    depends_on: []
    verify: [npm test]
`);
    const result = run('verify-registry.mjs', ['--strict'], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WORK_UNITS\.yaml schema_version must be 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service:add accepts only HTTPS repositories on the configured GitHub host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-service-host-'));
  try {
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 2
github:
  host: github.com
  api_base: https://api.github.com
services: []
`);
    const rejected = run('service-add.mjs', [
      '--id', 'api',
      '--repo', 'https://git.example.internal/acme/api.git',
      '--owners', '@acme/api',
      '--verify', 'npm test',
    ], dir);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /must use HTTPS on github\.com/);

    const accepted = run('service-add.mjs', [
      '--id', 'api',
      '--repo', 'https://github.com/acme/api.git',
      '--owners', '@acme/api',
      '--verify', 'npm test',
    ], dir);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /DRY RUN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service:add derives the id and owner from the repository URL and permits omitted verify commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-service-derived-'));
  try {
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 2
github:
  host: github.com
  api_base: https://api.github.com
services: []
`);
    const result = run('service-add.mjs', [
      '--repo', 'https://github.com/acme/payments-api.git',
      '--stack', 'node',
    ], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /services\/payments-api/);
    assert.match(result.stdout, /id: payments-api/);
    assert.match(result.stdout, /"@acme"/);
    assert.match(result.stdout, /verify: \[\]/);
    assert.match(result.stdout, /Nothing is written without --apply/);
    assert.equal(existsSync(join(dir, 'services/payments-api')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry v2 permits an empty service verify list until a Work Unit is activated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-empty-verify-'));
  try {
    mkdirSync(join(dir, 'services/api'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), `version: 2
github:
  host: github.com
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    owners: ["@acme"]
    verify: []
`);
    writeFileSync(join(dir, '.gitmodules'), `[submodule "services/api"]
  path = services/api
  url = https://github.com/acme/api.git
`);
    mkdirSync(join(dir, 'changes/CHG-DRAFT-001'), { recursive: true });
    writeFileSync(join(dir, 'changes/CHG-DRAFT-001/WORK_UNITS.yaml'), `schema_version: 1
change_id: CHG-DRAFT-001
state: draft
work_units:
  - id: api-bootstrap
    repo: api
    state: draft
    branch: feat/CHG-DRAFT-001/api-bootstrap
    base_sha: pending
    writer: unassigned
    write_paths: []
    depends_on: []
    verify: []
`);
    const result = run('verify-registry.mjs', ['--strict', '--allow-uninitialized'], dir);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry permits at most one draft Change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-v2-single-draft-'));
  try {
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services/registry.yaml'), 'version: 2\nservices: []\n');
    writeFileSync(join(dir, '.gitmodules'), '');
    for (const id of ['CHG-DRAFT-A', 'CHG-DRAFT-B']) {
      mkdirSync(join(dir, `changes/${id}`), { recursive: true });
      writeFileSync(join(dir, `changes/${id}/WORK_UNITS.yaml`), `schema_version: 1
change_id: ${id}
state: draft
work_units: []
`);
    }
    const result = run('verify-registry.mjs', ['--strict', '--allow-uninitialized'], dir);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /only one draft Change is allowed.*CHG-DRAFT-A.*CHG-DRAFT-B/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
