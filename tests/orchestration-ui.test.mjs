import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {
  buildChangeFiles,
  recoverChangeWrites,
  saveChange,
  validateDraft,
} from '../scripts/orchestration/change-service.mjs';
import { createPlanPr } from '../scripts/orchestration/plan-pr.mjs';
import { createOrchestrationServer, repositoryContext } from '../scripts/orchestration/server.mjs';

function rootFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-ui-'));
  mkdirSync(join(root, 'changes'), { recursive: true });
  mkdirSync(join(root, 'services/api/.git'), { recursive: true });
  writeFileSync(join(root, 'services/registry.yaml'), `version: 2
github:
  host: github.com
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    owners: [acme/api]
    verify: [npm test]
`);
  writeFileSync(join(root, '.gitmodules'), `[submodule "services/api"]
  path = services/api
  url = https://github.com/acme/api.git
`);
  return root;
}

function serverFixture() {
  const root = rootFixture();
  const service = join(root, 'services/api');
  rmSync(join(service, '.git'), { recursive: true, force: true });
  execFileSync('git', ['init', '-qb', 'main'], { cwd: service });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: service });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: service });
  writeFileSync(join(service, 'README.md'), 'api\n');
  execFileSync('git', ['add', '.'], { cwd: service });
  execFileSync('git', ['commit', '-qm', 'service base'], { cwd: service });
  execFileSync('git', ['init', '-qb', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'advice.addEmbeddedRepo', 'false'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'root base'], { cwd: root });
  return root;
}

async function withServer(root, callback, options = {}) {
  const server = createOrchestrationServer({ root, ...options });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  }
}

function requestWithHost(origin, path, host) {
  const target = new URL(path, origin);
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { host },
    }, (response) => {
      response.resume();
      response.on('end', () => resolvePromise(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

const baseSha = 'a'.repeat(40);
const validDraft = {
  changeId: 'CHG-TEST-001',
  title: '계획 회의 산출물',
  coordinator: 'jpyoon',
  goals: [
    { id: 'GOAL-001', title: '계획 작성', outcome: '회의 내용을 검증 가능한 작업 계획으로 만든다.', participants: ['planning-team'] },
  ],
  nonGoals: ['GitHub 작업은 자동화하지 않는다.'],
  hasUserFlow: false,
  userFlow: [],
  acceptanceCriteria: ['계획 파일이 생성된다.', '승인 전 패킷 발급이 차단된다.'],
  services: ['api'],
  noSharedContract: true,
  contracts: [],
  workUnits: [{
    id: '',
    goalId: 'GOAL-001',
    service: 'api',
    goal: 'API 변경을 구현한다.',
    writer: 'alice',
    writePaths: ['src/api/**', 'tests/**'],
    dependsOn: [],
    verify: [],
  }],
};

test('validation reports plain field-addressable errors', () => {
  const result = validateDraft({ ...validDraft, goals: [], acceptanceCriteria: [], workUnits: [] }, {
    services: [{ id: 'api', verify: ['npm test'] }],
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map(({ field }) => field), ['goals', 'acceptanceCriteria', 'workUnits']);
  assert.match(result.errors[0].message, /목표/);
});

test('user flow is optional unless explicitly enabled', () => {
  const optional = validateDraft({ ...validDraft, hasUserFlow: false, userFlow: [] }, {
    services: [{ id: 'api', verify: ['npm test'] }],
  });
  assert.equal(optional.valid, true);

  const required = validateDraft({ ...validDraft, hasUserFlow: true, userFlow: [] }, {
    services: [{ id: 'api', verify: ['npm test'] }],
  });
  assert.equal(required.valid, false);
  assert.ok(required.errors.some(({ field }) => field === 'userFlow'));
});

test('non-goals can be explicitly declared empty', () => {
  const result = validateDraft({ ...validDraft, noNonGoals: true, nonGoals: [] }, {
    services: [{ id: 'api', verify: ['npm test'] }],
  });
  assert.equal(result.valid, true);
});

test('work unit verification commands are optional when the service has no defaults', () => {
  const result = validateDraft(validDraft, {
    services: [{ id: 'api', verify: [] }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.some(({ field }) => field === 'workUnits.0.verify'), false);

  const files = buildChangeFiles(validDraft, {
    rootHead: 'b'.repeat(40),
    services: [{ id: 'api', path: 'services/api', verify: [], baseSha }],
  });
  const manifest = YAML.parse(files.get('WORK_UNITS.yaml'));
  const unit = manifest.work_units.find(({ id }) => id === 'api');
  assert.equal(unit.state, 'draft');
  assert.deepEqual(unit.verify, []);

  const omittedDefaults = buildChangeFiles(validDraft, {
    rootHead: 'b'.repeat(40),
    services: [{ id: 'api', path: 'services/api', baseSha }],
  });
  const omittedManifest = YAML.parse(omittedDefaults.get('WORK_UNITS.yaml'));
  const omittedUnit = omittedManifest.work_units.find(({ id }) => id === 'api');
  assert.equal(omittedUnit.state, 'draft');
  assert.deepEqual(omittedUnit.verify, []);
});

test('implementation dependencies remain draft until their predecessors merge', () => {
  const files = buildChangeFiles({
    ...validDraft,
    workUnits: [
      { ...validDraft.workUnits[0], id: 'api-base', writePaths: ['src/base/**'] },
      {
        ...validDraft.workUnits[0],
        id: 'api-follow-up',
        writePaths: ['src/follow-up/**'],
        dependsOn: ['api-base'],
        verify: ['npm test'],
      },
    ],
  }, {
    rootHead: 'b'.repeat(40),
    services: [{ id: 'api', path: 'services/api', verify: [], baseSha }],
  });
  const manifest = YAML.parse(files.get('WORK_UNITS.yaml'));
  assert.equal(manifest.work_units.find(({ id }) => id === 'api-base').state, 'draft');
  assert.equal(manifest.work_units.find(({ id }) => id === 'api-follow-up').state, 'draft');
});

test('goal participants are ignored by the current product model', () => {
  const result = validateDraft({
    ...validDraft,
    goals: [{ ...validDraft.goals[0], participants: ['legacy-team'] }],
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.deepEqual(result.draft.goals[0], {
    id: 'GOAL-001',
    title: '계획 작성',
    outcome: '회의 내용을 검증 가능한 작업 계획으로 만든다.',
  });
  const files = buildChangeFiles(result.draft, {
    rootHead: 'b'.repeat(40),
    services: [{ id: 'api', path: 'services/api', verify: ['npm test'], baseSha }],
  });
  assert.doesNotMatch(files.get('PLAN.md'), /Participants|legacy-team/);
});

test('work unit IDs are generated and every unit belongs to one goal', () => {
  const normalized = validateDraft({
    ...validDraft,
    workUnits: [{ ...validDraft.workUnits[0], id: '', goal: 'API 인증 개선' }],
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.draft.workUnits[0].id, 'api');
  assert.equal(normalized.draft.workUnits[0].goalId, 'GOAL-001');

  const missingGoal = validateDraft({
    ...validDraft,
    workUnits: [{ ...validDraft.workUnits[0], goalId: 'GOAL-404' }],
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.equal(missingGoal.valid, false);
  assert.ok(missingGoal.errors.some(({ code }) => code === 'UNKNOWN_GOAL'));
});

test('goal IDs remain stable when an earlier goal is removed', () => {
  const result = validateDraft({
    ...validDraft,
    goals: [{ id: 'GOAL-002', title: '두 번째 목표', outcome: '두 번째 결과' }],
    workUnits: [{ ...validDraft.workUnits[0], goalId: 'GOAL-002' }],
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.equal(result.valid, true);
  assert.equal(result.draft.goals[0].id, 'GOAL-002');
  assert.equal(result.draft.workUnits[0].goalId, 'GOAL-002');
});

test('duplicate goal IDs are rejected', () => {
  const result = validateDraft({
    ...validDraft,
    goals: [validDraft.goals[0], { ...validDraft.goals[0] }],
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'DUPLICATE_ID'));
});

test('generated work unit IDs remain unique and inside the identifier limit', () => {
  const service = 's'.repeat(128);
  const result = validateDraft({
    ...validDraft,
    services: [service],
    workUnits: [
      { ...validDraft.workUnits[0], service },
      { ...validDraft.workUnits[0], service, writePaths: ['tests/**'] },
    ],
  }, { services: [{ id: service, verify: ['npm test'] }] });
  assert.equal(result.draft.workUnits[0].id, service);
  assert.equal(result.draft.workUnits[1].id, `${'s'.repeat(126)}-2`);
  assert.equal(result.errors.some(({ code }) => code === 'INVALID_ID'), false);
});

test('duplicate explicit work unit IDs are rejected', () => {
  const result = validateDraft({
    ...validDraft,
    workUnits: [
      { ...validDraft.workUnits[0], id: 'api-change' },
      { ...validDraft.workUnits[0], id: 'api-change', writePaths: ['tests/**'] },
    ],
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'DUPLICATE_ID'));
});

test('validation blocks parallel work units with overlapping paths', () => {
  const result = validateDraft({
    ...validDraft,
    workUnits: [
      validDraft.workUnits[0],
      { ...validDraft.workUnits[0], id: 'api-auth', writer: 'bob', writePaths: ['src/api/auth/**'] },
    ],
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.equal(result.valid, false);
  assert.equal(result.errors.at(-1).code, 'PATH_OVERLAP');
  assert.match(result.errors.at(-1).message, /같은 경로/);
});

test('build derives branches, base SHAs, inherited checks, and canonical files', () => {
  const files = buildChangeFiles(validDraft, {
    rootHead: 'b'.repeat(40),
    services: [{ id: 'api', path: 'services/api', verify: ['npm test'], baseSha }],
  });
  assert.deepEqual([...files.keys()].sort(), [
    'DRAFT.json',
    'PLAN.md',
    'PRS.yaml',
    'STATUS.md',
    'WORK_UNITS.yaml',
    'contracts/README.md',
    'releases/candidate-001.yaml',
  ]);
  const manifest = YAML.parse(files.get('WORK_UNITS.yaml'));
  const unit = manifest.work_units.find(({ id }) => id === 'api');
  assert.equal(unit.branch, 'feat/CHG-TEST-001/api');
  assert.equal(unit.base_sha, baseSha);
  assert.deepEqual(unit.verify, ['npm test']);
  assert.equal(unit.goal_id, 'GOAL-001');
  assert.match(files.get('PLAN.md'), /## Goals/);
  assert.match(files.get('PLAN.md'), /GOAL-001 — 계획 작성/);
  assert.doesNotMatch(files.get('PLAN.md'), /## User flow/);
  assert.match(files.get('PLAN.md'), /\[AC-001\] 계획 파일이 생성된다/);
});

test('generated manifest remains draft while dispatch remains SHA-gated', () => {
  const files = buildChangeFiles(validDraft, {
    rootHead: 'b'.repeat(40),
    services: [{ id: 'api', path: 'services/api', verify: ['npm test'], baseSha }],
  });
  const manifest = YAML.parse(files.get('WORK_UNITS.yaml'));
  assert.equal(manifest.state, 'draft');
  assert.equal(manifest.work_units.find(({ id }) => id === 'contract-and-plan').state, 'in_progress');
  assert.equal(manifest.work_units.find(({ id }) => id === 'api').state, 'ready');
});

test('save writes a complete artifact set and refuses overwrite', () => {
  const root = rootFixture();
  try {
    const files = buildChangeFiles(validDraft, {
      rootHead: 'b'.repeat(40),
      services: [{ id: 'api', path: 'services/api', verify: ['npm test'], baseSha }],
    });
    const saved = saveChange(root, validDraft.changeId, files);
    assert.equal(saved.files.length, 7);
    assert.match(readFileSync(join(root, 'changes/CHG-TEST-001/PLAN.md'), 'utf8'), /계획 회의 산출물/);
    assert.throws(() => saveChange(root, validDraft.changeId, files), /이미 존재/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('interrupted draft replacement restores the canonical Change directory', () => {
  const root = rootFixture();
  try {
    const changes = join(root, 'changes');
    const target = join(changes, 'CHG-RECOVER-001');
    const backup = join(changes, '_ui-backup-CHG-RECOVER-001-1-1');
    const staging = join(changes, '_ui-CHG-RECOVER-001-1-1');
    mkdirSync(backup, { recursive: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(backup, 'WORK_UNITS.yaml'), 'state: draft\n');
    writeFileSync(join(staging, 'WORK_UNITS.yaml'), 'state: draft\nchanged: true\n');
    writeFileSync(join(changes, '_ui-transaction-1-1.json'), JSON.stringify({
      target: 'CHG-RECOVER-001',
      backup: '_ui-backup-CHG-RECOVER-001-1-1',
      staging: '_ui-CHG-RECOVER-001-1-1',
    }));

    recoverChangeWrites(root);
    assert.equal(readFileSync(join(target, 'WORK_UNITS.yaml'), 'utf8'), 'state: draft\n');
    assert.equal(existsSync(backup), false);
    assert.equal(existsSync(staging), false);
    assert.equal(existsSync(join(changes, '_ui-transaction-1-1.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('draft replacement refuses generated-file symlinks and forged recovery markers', () => {
  const root = rootFixture();
  const external = join(tmpdir(), `coord-external-${process.pid}-${Date.now()}.md`);
  try {
    const files = buildChangeFiles(validDraft, {
      rootHead: 'b'.repeat(40),
      services: [{ id: 'api', path: 'services/api', verify: [], baseSha }],
    });
    saveChange(root, validDraft.changeId, files);
    writeFileSync(external, 'outside\n');
    rmSync(join(root, 'changes/CHG-TEST-001/PLAN.md'));
    symlinkSync(external, join(root, 'changes/CHG-TEST-001/PLAN.md'));
    assert.throws(() => saveChange(root, validDraft.changeId, files, { replaceDraft: true }), /심볼릭 링크/);
    assert.equal(readFileSync(external, 'utf8'), 'outside\n');

    const changes = join(root, 'changes');
    mkdirSync(join(changes, 'CHG-VICTIM-A'), { recursive: true });
    mkdirSync(join(changes, 'CHG-VICTIM-B'), { recursive: true });
    writeFileSync(join(changes, '_ui-transaction-1-2.json'), JSON.stringify({
      target: 'CHG-VICTIM-A',
      staging: 'CHG-VICTIM-B',
      backup: 'CHG-VICTIM-B',
    }));
    assert.throws(() => recoverChangeWrites(root), /손상된 Change 저장 복구 정보/);
    assert.equal(existsSync(join(changes, 'CHG-VICTIM-A')), true);
    assert.equal(existsSync(join(changes, 'CHG-VICTIM-B')), true);
  } finally {
    rmSync(external, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation rejects unsafe identifiers and contract paths', () => {
  const unsafeId = validateDraft({ ...validDraft, changeId: '../escape' }, {
    services: [{ id: 'api', verify: ['npm test'] }],
  });
  assert.equal(unsafeId.valid, false);
  assert.ok(unsafeId.errors.some(({ field }) => field === 'changeId'));

  const unsafeContract = validateDraft({
    ...validDraft,
    noSharedContract: false,
    contracts: [{ name: '../secret.md', content: 'x' }],
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.equal(unsafeContract.valid, false);
  assert.ok(unsafeContract.errors.some(({ field }) => field === 'contracts.0.name'));
});

test('validation rejects duplicate contract file names', () => {
  const result = validateDraft({
    ...validDraft,
    noSharedContract: false,
    contracts: [
      { name: 'api.md', content: 'first', serviceIds: ['api', 'web'] },
      { name: 'api.md', content: 'second', serviceIds: ['api', 'web'] },
    ],
    services: ['api', 'web'],
    workUnits: [
      validDraft.workUnits[0],
      { ...validDraft.workUnits[0], service: 'web', goal: 'Web 변경', writePaths: ['src/web/**'] },
    ],
  }, { services: [{ id: 'api', verify: ['npm test'] }, { id: 'web', verify: ['npm test'] }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'DUPLICATE_CONTRACT'));
});

test('shared contracts identify at least two participating services', () => {
  const result = validateDraft({
    ...validDraft,
    noSharedContract: false,
    contracts: [{ name: 'api.md', content: '# API', serviceIds: ['api'] }],
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ field }) => field === 'contracts.0.serviceIds'));
});

test('shared contract participants must be explicit and distinct', () => {
  const context = { services: [{ id: 'api', verify: ['npm test'] }, { id: 'web', verify: ['npm test'] }] };
  for (const serviceIds of [[], ['api', 'api']]) {
    const result = validateDraft({
      ...validDraft,
      services: ['api', 'web'],
      noSharedContract: false,
      contracts: [{ name: 'api.md', content: '# API', serviceIds }],
      workUnits: [
        validDraft.workUnits[0],
        { ...validDraft.workUnits[0], service: 'web', goal: 'Web 변경', writePaths: ['src/web/**'] },
      ],
    }, context);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(({ field }) => field === 'contracts.0.serviceIds'));
  }
});

test('JSON and YAML contracts are written byte-for-byte', () => {
  const files = buildChangeFiles({
    ...validDraft,
    services: ['api', 'web'],
    noSharedContract: false,
    contracts: [
      { name: 'api.json', content: '{"version":1}\n', serviceIds: ['api', 'web'] },
      { name: 'event.yaml', content: 'version: 1\n', serviceIds: ['api', 'web'] },
    ],
    workUnits: [
      validDraft.workUnits[0],
      { ...validDraft.workUnits[0], service: 'web', goal: 'Web 변경', writePaths: ['src/web/**'] },
    ],
  }, {
    rootHead: 'b'.repeat(40),
    services: [
      { id: 'api', path: 'services/api', verify: ['npm test'], baseSha },
      { id: 'web', path: 'services/web', verify: ['npm test'], baseSha: 'c'.repeat(40) },
    ],
  });
  assert.equal(files.get('contracts/api.json'), '{"version":1}\n');
  assert.equal(files.get('contracts/event.yaml'), 'version: 1\n');
});

test('validation rejects malformed JSON contract content', () => {
  const result = validateDraft({
    ...validDraft,
    services: ['api', 'web'],
    noSharedContract: false,
    contracts: [{ name: 'openapi.json', content: '{"openapi":', serviceIds: ['api', 'web'] }],
    workUnits: [
      validDraft.workUnits[0],
      { ...validDraft.workUnits[0], service: 'web', goal: 'Web 변경', writePaths: ['src/web/**'] },
    ],
  }, { services: [{ id: 'api', verify: ['npm test'] }, { id: 'web', verify: ['npm test'] }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'INVALID_JSON'));
});

test('generated plan names the repositories participating in a shared contract', () => {
  const files = buildChangeFiles({
    ...validDraft,
    services: ['api', 'web'],
    noSharedContract: false,
    contracts: [{ name: 'search-api.md', content: '# Search API', serviceIds: ['api', 'web'] }],
    workUnits: [
      validDraft.workUnits[0],
      { ...validDraft.workUnits[0], service: 'web', goal: '검색 화면 변경', writePaths: ['src/web/**'] },
    ],
  }, {
    rootHead: 'b'.repeat(40),
    services: [
      { id: 'api', path: 'services/api', verify: ['npm test'], baseSha },
      { id: 'web', path: 'services/web', verify: ['npm test'], baseSha: 'c'.repeat(40) },
    ],
  });
  assert.match(files.get('PLAN.md'), /`contracts\/search-api\.md` \(api ↔ web\)/);
  assert.equal(files.get('contracts/search-api.md'), '# Search API\n');
});

test('validation requires every work unit service to participate in the Change', () => {
  const result = validateDraft({ ...validDraft, services: [] }, {
    services: [{ id: 'api', verify: ['npm test'] }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'SERVICE_NOT_SELECTED'));
});

test('validation requires every selected service to own a work unit', () => {
  const result = validateDraft({ ...validDraft, services: ['api', 'web'] }, {
    services: [
      { id: 'api', verify: ['npm test'] },
      { id: 'web', verify: ['npm test'] },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'SERVICE_WITHOUT_WORK'));
});

test('validation requires safe coordinator and writer identifiers', () => {
  const result = validateDraft({
    ...validDraft,
    coordinator: 'team lead',
    workUnits: [{ ...validDraft.workUnits[0], writer: 'alice\nadmin' }],
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.filter(({ code }) => code === 'INVALID_ID').map(({ field }) => field), [
    'coordinator', 'workUnits.0.writer',
  ]);
});

test('validation rejects glob forms that workflow-check cannot enforce', () => {
  for (const path of ['src/*.js', 'src/*/**', 'src/?/**', 'src/**/generated/**']) {
    const result = validateDraft({
      ...validDraft,
      workUnits: [{ ...validDraft.workUnits[0], writePaths: [path] }],
    }, { services: [{ id: 'api', verify: ['npm test'] }] });
    assert.equal(result.valid, false, path);
    assert.ok(result.errors.some(({ code }) => code === 'UNSUPPORTED_SCOPE'), path);
  }
});

test('full-repository scope is limited to the first Work Unit of a new service', () => {
  const existing = validateDraft({
    ...validDraft,
    workUnits: [{ ...validDraft.workUnits[0], writePaths: ['**'] }],
  }, { services: [{ id: 'api', verify: ['npm test'], bootstrapEligible: false }] });
  assert.ok(existing.errors.some(({ code }) => code === 'FULL_SCOPE_NOT_ALLOWED'));

  const firstNew = validateDraft({
    ...validDraft,
    workUnits: [{ ...validDraft.workUnits[0], writePaths: ['**'] }],
  }, { services: [{ id: 'api', verify: ['npm test'], bootstrapEligible: true }] });
  assert.equal(firstNew.valid, true);

  const secondNew = validateDraft({
    ...validDraft,
    workUnits: [
      { ...validDraft.workUnits[0], writePaths: ['src/**'] },
      { ...validDraft.workUnits[0], writePaths: ['**'] },
    ],
  }, { services: [{ id: 'api', verify: ['npm test'], bootstrapEligible: true }] });
  assert.ok(secondNew.errors.some(({ code }) => code === 'FULL_SCOPE_NOT_ALLOWED'));
});

test('full-repository scope cannot depend on another implementation for the same service', () => {
  const result = validateDraft({
    ...validDraft,
    workUnits: [
      {
        ...validDraft.workUnits[0],
        id: 'api-full',
        writePaths: ['**'],
        dependsOn: ['api-bootstrap'],
      },
      {
        ...validDraft.workUnits[0],
        id: 'api-bootstrap',
        writePaths: ['README.md'],
      },
    ],
  }, { services: [{ id: 'api', verify: [], bootstrapEligible: true }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'FULL_SCOPE_NOT_ALLOWED'));
});

test('validation returns immediately when work unit count exceeds the limit', () => {
  const started = performance.now();
  const result = validateDraft({
    ...validDraft,
    workUnits: Array.from({ length: 10_000 }, (_, index) => ({
      ...validDraft.workUnits[0], id: `work-${index}`, writePaths: [`src/${index}/**`],
    })),
  }, { services: [{ id: 'api', verify: ['npm test'] }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'LIMIT_EXCEEDED'));
  assert.ok(performance.now() - started < 1_000);
});

test('server reports repository state and registered service bases', async () => {
  const root = serverFixture();
  try {
    await withServer(root, async (origin) => {
      const response = await fetch(`${origin}/api/status`);
      assert.equal(response.status, 200);
      const status = await response.json();
      assert.equal(status.branch, 'main');
      assert.match(status.head, /^[0-9a-f]{40}$/);
      assert.equal(status.services[0].id, 'api');
      assert.match(status.services[0].baseSha, /^[0-9a-f]{40}$/);
      assert.equal(status.services[0].bootstrapEligible, true);
      assert.deepEqual(status.changes, []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository context exposes the single structured draft as the active Change', () => {
  const root = serverFixture();
  try {
    const change = join(root, 'changes/CHG-RESUME-001');
    mkdirSync(join(change, 'contracts'), { recursive: true });
    writeFileSync(join(change, 'PLAN.md'), `# CHG-RESUME-001 — 이어서 작성할 계획

## State

- Status: DRAFT
- Coordinator: jpyoon

## Goals

### GOAL-001 — 계획 이어쓰기

저장된 내용을 다시 편집한다.

## Non-goals

- 배포는 하지 않는다.

## User flow

1. 초안을 불러온다.
2. 내용을 수정한다.

## Acceptance criteria

- [AC-001] 모든 단계가 복원된다.

## Contracts

- Shared snapshots: \`contracts/api.md\` (api ↔ web)
`);
    writeFileSync(join(change, 'WORK_UNITS.yaml'), `schema_version: 1
change_id: CHG-RESUME-001
state: draft
work_units:
  - id: contract-and-plan
    repo: root
    state: in_progress
    goal: approve
    branch: change/CHG-RESUME-001/coordination
    writer: jpyoon
    write_paths: [changes/CHG-RESUME-001/**]
    depends_on: []
    verify: [npm test]
  - id: api-change
    goal_id: GOAL-001
    repo: api
    state: draft
    goal: API를 수정한다.
    branch: feat/CHG-RESUME-001/api-change
    writer: alice
    write_paths: [src/api/**]
    depends_on: [contract-and-plan]
    verify: []
  - id: candidate-integration
    repo: root
    state: draft
    goal: integrate
    branch: change/CHG-RESUME-001/candidate-integration
    writer: jpyoon
    write_paths: [changes/CHG-RESUME-001/**]
    depends_on: [api-change]
    verify: [npm test]
`);
    writeFileSync(join(change, 'contracts/api.md'), '# API contract\n');

    const context = repositoryContext(root);
    assert.equal(context.activeDraft.changeId, 'CHG-RESUME-001');
    assert.deepEqual(context.activeDraft.goals, [{ id: 'GOAL-001', title: '계획 이어쓰기', outcome: '저장된 내용을 다시 편집한다.' }]);
    assert.deepEqual(context.activeDraft.nonGoals, ['배포는 하지 않는다.']);
    assert.deepEqual(context.activeDraft.userFlow, ['초안을 불러온다.', '내용을 수정한다.']);
    assert.deepEqual(context.activeDraft.acceptanceCriteria, ['모든 단계가 복원된다.']);
    assert.deepEqual(context.activeDraft.services, ['api', 'web']);
    assert.deepEqual(context.activeDraft.workUnits[0], {
      id: 'api-change', goalId: 'GOAL-001', service: 'api', goal: 'API를 수정한다.', writer: 'alice',
      writePaths: ['src/api/**'], dependsOn: [], verify: [],
    });
    assert.deepEqual(context.activeDraft.contracts, [{ name: 'api.md', content: '# API contract\n', serviceIds: ['api', 'web'] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('structured draft state round-trips Markdown-shaped content without parsing loss', () => {
  const root = serverFixture();
  try {
    const context = repositoryContext(root);
    const draft = {
      ...validDraft,
      goals: [{ id: 'GOAL-001', title: '문서 보존', outcome: '첫 문단\n\n## Details\n\n둘째 문단' }],
      nonGoals: ['첫 줄\n둘째 줄'],
    };
    saveChange(root, draft.changeId, buildChangeFiles(draft, {
      rootHead: context.head,
      services: context.services,
    }));
    const restored = repositoryContext(root).activeDraft;
    assert.equal(restored.goals[0].outcome, draft.goals[0].outcome);
    assert.deepEqual(restored.nonGoals, ['첫 줄', '둘째 줄']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy draft loading rejects a declared contract whose snapshot is missing', () => {
  const root = serverFixture();
  try {
    const change = join(root, 'changes/CHG-MISSING-CONTRACT');
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, 'PLAN.md'), `# CHG-MISSING-CONTRACT — 계약 확인

## State

- Status: DRAFT
- Coordinator: jpyoon

## Goals

### GOAL-001 — 계약 확인

계약을 복원한다.

## Non-goals

- None declared for this Change.

## Acceptance criteria

- [AC-001] 계약이 존재한다.

## Contracts

- Shared snapshots: \`contracts/api.md\` (api ↔ web)
`);
    writeFileSync(join(change, 'WORK_UNITS.yaml'), 'schema_version: 1\nchange_id: CHG-MISSING-CONTRACT\nstate: draft\nwork_units: []\n');
    assert.throws(() => repositoryContext(root), /계약 파일 contracts\/api\.md을 찾을 수 없습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('structured draft loading rejects a missing contract snapshot', () => {
  const root = serverFixture();
  try {
    const context = repositoryContext(root);
    saveChange(root, validDraft.changeId, buildChangeFiles(validDraft, {
      rootHead: context.head,
      services: context.services,
    }));
    const draftPath = join(root, 'changes/CHG-TEST-001/DRAFT.json');
    const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
    draft.contracts = [{ name: 'missing.md', content: '# Missing', serviceIds: ['api', 'web'] }];
    draft.noSharedContract = false;
    writeFileSync(draftPath, JSON.stringify(draft));
    assert.throws(() => repositoryContext(root), /계약 파일 contracts\/missing\.md을 찾을 수 없습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy single-goal drafts restore wrapped list content', () => {
  const root = serverFixture();
  try {
    const change = join(root, 'changes/CHG-LEGACY-001');
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, 'PLAN.md'), `# CHG-LEGACY-001 — 단일 목표 계획

## State

- Status: DRAFT
- Coordinator: jpyoon

## Goal

사용자가 저장된 계획을
다시 이어서 작성한다.

## Non-goals

- 자동 배포는
  수행하지 않는다.

## User flow

1. 초안을 열고
   내용을 확인한다.

## Acceptance criteria

- [AC-001] 입력 내용이
  손실 없이 복원된다.

## Contracts

- Shared snapshots: none
`);
    writeFileSync(join(change, 'WORK_UNITS.yaml'), `schema_version: 1
change_id: CHG-LEGACY-001
state: draft
work_units:
  - id: api-change
    repo: api
    state: draft
    goal: API를 수정한다.
    writer: alice
    write_paths: [src/api/**]
    depends_on: []
    verify: []
`);
    const draft = repositoryContext(root).activeDraft;
    assert.deepEqual(draft.goals, [{
      id: 'GOAL-001',
      title: '단일 목표 계획',
      outcome: '사용자가 저장된 계획을\n다시 이어서 작성한다.',
    }]);
    assert.deepEqual(draft.nonGoals, ['자동 배포는 수행하지 않는다.']);
    assert.deepEqual(draft.userFlow, ['초안을 열고 내용을 확인한다.']);
    assert.deepEqual(draft.acceptanceCriteria, ['입력 내용이 손실 없이 복원된다.']);
    assert.equal(draft.workUnits[0].goalId, 'GOAL-001');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository context rejects multiple draft Changes instead of choosing one', () => {
  const root = serverFixture();
  try {
    for (const id of ['CHG-DRAFT-A', 'CHG-DRAFT-B']) {
      const change = join(root, `changes/${id}`);
      mkdirSync(change, { recursive: true });
      writeFileSync(join(change, 'WORK_UNITS.yaml'), `schema_version: 1\nchange_id: ${id}\nstate: draft\nwork_units: []\n`);
    }
    assert.throws(() => repositoryContext(root), /draft Change는 하나만 허용.*CHG-DRAFT-A.*CHG-DRAFT-B/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('service registration API previews a derived service without applying it', async () => {
  const root = serverFixture();
  try {
    await withServer(root, async (origin) => {
      const response = await fetch(`${origin}/api/services/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: 'https://github.com/acme/payments-api.git' }),
      });
      assert.equal(response.status, 200);
      const preview = await response.json();
      assert.equal(preview.service.id, 'payments-api');
      assert.equal(preview.service.path, 'services/payments-api');
      assert.equal(preview.service.owners[0], '@acme');
      assert.equal(preview.service.stack, 'unspecified');
      assert.equal(existsSync(join(root, 'services/payments-api')), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('service registration API applies a dry-run-approved repository without verify commands', async () => {
  const root = serverFixture();
  const remoteRoot = mkdtempSync(join(tmpdir(), 'orchestration-service-remote-'));
  const source = join(remoteRoot, 'source');
  const bare = join(remoteRoot, 'payments-api.git');
  const previousEnv = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
    protocols: process.env.GIT_ALLOW_PROTOCOL,
  };
  try {
    mkdirSync(source, { recursive: true });
    execFileSync('git', ['init', '-qb', 'main'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source });
    writeFileSync(join(source, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: source });
    execFileSync('git', ['clone', '--bare', source, bare]);
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.file://${remoteRoot}/.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/acme/';
    process.env.GIT_ALLOW_PROTOCOL = 'file:https';

    await withServer(root, async (origin) => {
      const headers = { 'content-type': 'application/json' };
      const repo = 'https://github.com/acme/payments-api.git';
      const previewResponse = await fetch(`${origin}/api/services/preview`, {
        method: 'POST', headers, body: JSON.stringify({ repo }),
      });
      assert.equal(previewResponse.status, 200);
      const preview = await previewResponse.json();
      assert.equal(preview.service.stack, 'node');
      assert.equal(preview.service.marker, 'package.json');

      const applyResponse = await fetch(`${origin}/api/services`, {
        method: 'POST', headers, body: JSON.stringify({ repo, stack: preview.service.stack }),
      });
      assert.equal(applyResponse.status, 201, await applyResponse.text());
      const registry = readFileSync(join(root, 'services/registry.yaml'), 'utf8');
      assert.match(registry, /id: payments-api/);
      assert.match(registry, /verify: \[\]/);
      assert.equal(existsSync(join(root, 'services/payments-api/.git')), true);
    });
  } finally {
    for (const [key, value] of Object.entries({
      GIT_CONFIG_COUNT: previousEnv.count,
      GIT_CONFIG_KEY_0: previousEnv.key,
      GIT_CONFIG_VALUE_0: previousEnv.value,
      GIT_ALLOW_PROTOCOL: previousEnv.protocols,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('registry v2 requires every service base to come from a committed gitlink', () => {
  const root = rootFixture();
  try {
    rmSync(join(root, 'services/api/.git'), { recursive: true, force: true });
    execFileSync('git', ['init', '-qb', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['add', 'services/registry.yaml', '.gitmodules'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'root without service gitlink'], { cwd: root });
    assert.throws(() => repositoryContext(root), /등록 커밋/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staged-only service registration is visible but cannot anchor a plan', async () => {
  const root = serverFixture();
  const service = join(root, 'services/payments-api');
  try {
    mkdirSync(service, { recursive: true });
    execFileSync('git', ['init', '-qb', 'main'], { cwd: service });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: service });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: service });
    writeFileSync(join(service, 'README.md'), 'payments\n');
    execFileSync('git', ['add', '.'], { cwd: service });
    execFileSync('git', ['commit', '-qm', 'service base'], { cwd: service });
    writeFileSync(join(root, 'services/registry.yaml'), `${readFileSync(join(root, 'services/registry.yaml'), 'utf8')}  - id: payments-api\n    path: services/payments-api\n    repo: https://github.com/acme/payments-api.git\n    owners: [acme/payments-api]\n    verify: []\n`);
    writeFileSync(join(root, '.gitmodules'), `${readFileSync(join(root, '.gitmodules'), 'utf8')}[submodule "services/payments-api"]\n  path = services/payments-api\n  url = https://github.com/acme/payments-api.git\n`);
    execFileSync('git', ['add', 'services/registry.yaml', '.gitmodules', 'services/payments-api'], { cwd: root });

    const status = repositoryContext(root);
    assert.equal(status.services.find(({ id }) => id === 'payments-api').baseSha, null);

    await withServer(root, async (origin) => {
      const draft = {
        ...validDraft,
        services: ['payments-api'],
        workUnits: [{ ...validDraft.workUnits[0], service: 'payments-api', writePaths: ['src/**'] }],
      };
      const response = await fetch(`${origin}/api/changes/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      assert.equal(response.status, 422);
      const result = await response.json();
      assert.ok(result.errors.some(({ code }) => code === 'MISSING_BASE'));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preview is non-mutating and save requires its current revision', async () => {
  const root = serverFixture();
  try {
    await withServer(root, async (origin) => {
      const headers = { 'content-type': 'application/json' };
      const previewResponse = await fetch(`${origin}/api/changes/preview`, {
        method: 'POST', headers, body: JSON.stringify(validDraft),
      });
      assert.equal(previewResponse.status, 200);
      const preview = await previewResponse.json();
      assert.equal(preview.valid, true);
      assert.equal(preview.validation.exitCode, 0);
      assert.ok(preview.files.some(({ path }) => path === 'WORK_UNITS.yaml'));
      assert.equal(existsSync(join(root, 'changes/CHG-TEST-001')), false);

      const staleResponse = await fetch(`${origin}/api/changes`, {
        method: 'POST', headers, body: JSON.stringify({ draft: validDraft, revision: 'stale' }),
      });
      assert.equal(staleResponse.status, 409);

      writeFileSync(join(root, 'services/registry.yaml'), `${readFileSync(join(root, 'services/registry.yaml'), 'utf8')}\n`);
      const changedInputResponse = await fetch(`${origin}/api/changes`, {
        method: 'POST', headers, body: JSON.stringify({ draft: validDraft, revision: preview.revision }),
      });
      assert.equal(changedInputResponse.status, 409);

      const refreshedResponse = await fetch(`${origin}/api/changes/preview`, {
        method: 'POST', headers, body: JSON.stringify(validDraft),
      });
      const refreshed = await refreshedResponse.json();

      const saveResponse = await fetch(`${origin}/api/changes`, {
        method: 'POST', headers, body: JSON.stringify({ draft: validDraft, revision: refreshed.revision }),
      });
      assert.equal(saveResponse.status, 201);
      assert.equal(existsSync(join(root, 'changes/CHG-TEST-001/PLAN.md')), true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the active draft can be previewed and atomically updated in place', async () => {
  const root = serverFixture();
  try {
    const context = repositoryContext(root);
    saveChange(root, validDraft.changeId, buildChangeFiles(validDraft, {
      rootHead: context.head,
      services: context.services,
    }));
    writeFileSync(join(root, 'changes/CHG-TEST-001/review-notes.md'), 'keep this\n');
    const draftPath = join(root, 'changes/CHG-TEST-001/DRAFT.json');
    const savedDraft = JSON.parse(readFileSync(draftPath, 'utf8'));
    savedDraft.noSharedContract = false;
    savedDraft.contracts = [{ name: 'obsolete.md', content: '# obsolete', serviceIds: ['api', 'web'] }];
    writeFileSync(draftPath, JSON.stringify(savedDraft));
    writeFileSync(join(root, 'changes/CHG-TEST-001/contracts/obsolete.md'), '# obsolete\n');
    await withServer(root, async (origin) => {
      const headers = { 'content-type': 'application/json' };
      const updatedDraft = { ...validDraft, title: '수정한 활성 초안' };
      const previewResponse = await fetch(`${origin}/api/changes/preview`, {
        method: 'POST', headers, body: JSON.stringify(updatedDraft),
      });
      const previewBody = await previewResponse.text();
      assert.equal(previewResponse.status, 200, previewBody);
      const preview = JSON.parse(previewBody);
      const planPreview = preview.files.find(({ path }) => path === 'PLAN.md');
      assert.match(planPreview.diff, /^--- a\/changes\/CHG-TEST-001\/PLAN\.md/m);
      assert.doesNotMatch(planPreview.diff, /--- \/dev\/null/);
      const saveResponse = await fetch(`${origin}/api/changes`, {
        method: 'POST', headers, body: JSON.stringify({ draft: updatedDraft, revision: preview.revision }),
      });
      const saveBody = await saveResponse.text();
      assert.equal(saveResponse.status, 200, saveBody);
      assert.match(readFileSync(join(root, 'changes/CHG-TEST-001/PLAN.md'), 'utf8'), /수정한 활성 초안/);
      assert.equal(readFileSync(join(root, 'changes/CHG-TEST-001/review-notes.md'), 'utf8'), 'keep this\n');
      assert.equal(existsSync(join(root, 'changes/CHG-TEST-001/contracts/obsolete.md')), false);
      assert.equal(existsSync(join(root, 'changes/CHG-TEST-001/contracts/README.md')), true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an active draft blocks previewing a different Change ID', async () => {
  const root = serverFixture();
  try {
    const context = repositoryContext(root);
    saveChange(root, validDraft.changeId, buildChangeFiles(validDraft, {
      rootHead: context.head,
      services: context.services,
    }));
    await withServer(root, async (origin) => {
      const response = await fetch(`${origin}/api/changes/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...validDraft, changeId: 'CHG-OTHER-001' }),
      });
      assert.equal(response.status, 422);
      const result = await response.json();
      assert.ok(result.errors.some(({ code }) => code === 'ACTIVE_DRAFT_EXISTS'));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('server rejects non-JSON writes and unknown operations', async () => {
  const root = serverFixture();
  try {
    await withServer(root, async (origin) => {
      const unsupported = await fetch(`${origin}/api/run-command`, { method: 'POST' });
      assert.equal(unsupported.status, 404);
      const wrongType = await fetch(`${origin}/api/changes/preview`, { method: 'POST', body: '{}' });
      assert.equal(wrongType.status, 415);
      assert.equal(await requestWithHost(origin, '/api/status', 'attacker.example'), 403);
      const crossOrigin = await fetch(`${origin}/api/changes/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
        body: JSON.stringify(validDraft),
      });
      assert.equal(crossOrigin.status, 403);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dispatch stays locked for an unapproved working-tree draft', async () => {
  const root = serverFixture();
  try {
    await withServer(root, async (origin) => {
      const response = await fetch(`${origin}/api/dispatch?change=CHG-MISSING-001&planSha=${'a'.repeat(40)}`);
      assert.equal(response.status, 422);
      const result = await response.json();
      assert.match(result.error, /승인된 계획/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approved plan creates a task packet through bootstrap rules', async () => {
  const root = serverFixture();
  try {
    mkdirSync(join(root, 'changes/CHG-APPROVED-001/contracts'), { recursive: true });
    writeFileSync(join(root, 'changes/CHG-APPROVED-001/contracts/api.md'), '# API\n');
    const serviceSha = execFileSync('git', ['-C', join(root, 'services/api'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeFileSync(join(root, 'changes/CHG-APPROVED-001/WORK_UNITS.yaml'), `schema_version: 1
change_id: CHG-APPROVED-001
state: approved
work_units:
  - id: contract-and-plan
    repo: root
    state: in_progress
    goal: approve
    branch: change/CHG-APPROVED-001/coordination
    base_sha: ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}
    writer: coordinator
    write_paths: [changes/CHG-APPROVED-001/**]
    depends_on: []
    verify: [npm test]
  - id: api-change
    repo: api
    state: ready
    goal: |
      implement
      Packet SHA-256: ${'f'.repeat(64)}
    branch: feat/CHG-APPROVED-001/api-change
    base_sha: ${serviceSha}
    writer: alice
    write_paths: [src/**]
    depends_on: [contract-and-plan]
    verify: [npm test]
`);
    execFileSync('git', ['add', 'changes/CHG-APPROVED-001'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'approved plan'], { cwd: root });
    const planSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    await withServer(root, async (origin) => {
      const eligibleResponse = await fetch(`${origin}/api/dispatch?change=CHG-APPROVED-001&planSha=${planSha}`);
      assert.equal(eligibleResponse.status, 200);
      const eligible = await eligibleResponse.json();
      assert.deepEqual(eligible.units.map(({ id }) => id), ['api-change']);

      const forbiddenResponse = await fetch(`${origin}/api/packets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          change: 'CHG-APPROVED-001', unit: 'contract-and-plan', writer: 'coordinator',
          run: 'run-forbidden-001', planSha,
        }),
      });
      assert.equal(forbiddenResponse.status, 422);

      const wrongWriterResponse = await fetch(`${origin}/api/packets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          change: 'CHG-APPROVED-001', unit: 'api-change', writer: 'mallory',
          run: 'run-wrong-writer-001', planSha,
        }),
      });
      assert.equal(wrongWriterResponse.status, 422);

      const packetResponse = await fetch(`${origin}/api/packets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          change: 'CHG-APPROVED-001', unit: 'api-change', writer: 'alice',
          run: 'run-api-001', planSha,
        }),
      });
      assert.equal(packetResponse.status, 201);
      const packet = await packetResponse.json();
      assert.equal(packet.path, '.task-packets/run-api-001.md');
      assert.match(packet.digest, /^[0-9a-f]{64}$/);
      assert.notEqual(packet.digest, 'f'.repeat(64));
      const packetContent = readFileSync(join(root, packet.path), 'utf8');
      assert.match(packetContent, new RegExp(`Plan SHA: ${planSha}`));
      const marker = '\nPacket SHA-256: ';
      const markerIndex = packetContent.lastIndexOf(marker);
      assert.equal(packet.digest, createHash('sha256').update(packetContent.slice(0, markerIndex + 1)).digest('hex'));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dispatch rendering treats approved manifest text as text, not HTML', () => {
  const source = readFileSync(join(import.meta.dirname, '../ui/app.js'), 'utf8');
  const packetFunction = source.slice(source.indexOf('function packetForm'), source.indexOf('async function checkDispatch'));
  assert.doesNotMatch(packetFunction, /innerHTML/);
  assert.match(packetFunction, /textContent = unit\.goal/);
});

test('approval rewrites the manifest, plan, and status documents', () => {
  const baseSha = 'c'.repeat(40);
  const context = { rootHead: 'b'.repeat(40), services: [{ id: 'api', path: 'services/api', verify: ['npm test'], baseSha }] };

  const draftFiles = buildChangeFiles(validDraft, context);
  assert.equal(YAML.parse(draftFiles.get('WORK_UNITS.yaml')).state, 'draft');
  assert.match(draftFiles.get('PLAN.md'), /- Status: DRAFT/);

  const approvedFiles = buildChangeFiles(validDraft, { ...context, approval: 'approved' });
  const manifest = YAML.parse(approvedFiles.get('WORK_UNITS.yaml'));
  assert.equal(manifest.state, 'approved');
  assert.equal(manifest.work_units.find(({ repo }) => repo === 'api').state, 'ready');
  assert.equal(YAML.parse(approvedFiles.get('PRS.yaml')).state, 'approved');
  assert.match(approvedFiles.get('PLAN.md'), /- Status: APPROVED/);
  assert.match(approvedFiles.get('STATUS.md'), /\*\*State:\*\* APPROVED/);
  assert.match(approvedFiles.get('STATUS.md'), /\| `api` \| `GOAL-001` \| `api` \| ready \|/);
});

function approvalFixture(changeId, { verify = ['npm test'] } = {}) {
  const root = serverFixture();
  if (!verify.length) {
    writeFileSync(join(root, 'services/registry.yaml'), readFileSync(join(root, 'services/registry.yaml'), 'utf8').replace('verify: [npm test]', 'verify: []'));
  }
  const context = repositoryContext(root);
  const files = buildChangeFiles({ ...validDraft, changeId, workUnits: [{ ...validDraft.workUnits[0], verify }] }, {
    rootHead: context.head,
    services: context.services.map((service) => ({ ...service, verify: verify.length ? service.verify : [] })),
  });
  saveChange(root, changeId, files);
  return root;
}

test('approval is blocked while a work unit has no verification command', async () => {
  const root = approvalFixture('CHG-NOVERIFY-001', { verify: [] });
  try {
    await withServer(root, async (origin) => {
      const response = await fetch(`${origin}/api/changes/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changeId: 'CHG-NOVERIFY-001' }),
      });
      assert.equal(response.status, 422);
      const body = await response.json();
      assert.match(body.error, /검증 명령/);
      assert.deepEqual(body.units.map(({ id }) => id), ['api']);
      assert.equal(YAML.parse(readFileSync(join(root, 'changes/CHG-NOVERIFY-001/WORK_UNITS.yaml'), 'utf8')).state, 'draft');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approval promotes the saved change and reports it through status', async () => {
  const root = approvalFixture('CHG-APPROVE-001');
  try {
    await withServer(root, async (origin) => {
      const response = await fetch(`${origin}/api/changes/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changeId: 'CHG-APPROVE-001' }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.state, 'approved');
      assert.deepEqual(body.units.map(({ state: unitState }) => unitState), ['ready']);

      const manifest = YAML.parse(readFileSync(join(root, 'changes/CHG-APPROVE-001/WORK_UNITS.yaml'), 'utf8'));
      assert.equal(manifest.state, 'approved');

      const status = await (await fetch(`${origin}/api/status`)).json();
      assert.equal(status.changeStates['CHG-APPROVE-001'].state, 'approved');
      assert.equal(status.activeDraft, null);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function stubRunner(responses = {}) {
  const calls = [];
  const run = (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push(key);
    const match = Object.keys(responses).find((prefix) => key.startsWith(prefix));
    const value = match ? responses[match] : { status: 0, stdout: '' };
    return { command, args, status: value.status ?? 0, stdout: value.stdout ?? '', stderr: value.stderr ?? '' };
  };
  return { calls, run };
}

function approvedFixture(changeId) {
  const root = serverFixture();
  const context = repositoryContext(root);
  saveChange(root, changeId, buildChangeFiles({ ...validDraft, changeId }, {
    rootHead: context.head,
    services: context.services,
    approval: 'approved',
  }));
  return root;
}

const planPrResponses = (changeId) => ({
  'git rev-parse --verify origin/main': { status: 0, stdout: 'origin/main' },
  'git rev-parse --verify refs/heads/': { status: 1 },
  'git rev-parse --verify refs/remotes/origin/': { status: 1 },
  'git branch --show-current': { stdout: 'main' },
  'git status --porcelain --': { stdout: `?? changes/${changeId}/PLAN.md` },
  'git cat-file -e HEAD:': { status: 1 },
  'git diff --cached --name-only': { stdout: `changes/${changeId}/PLAN.md` },
  'git rev-parse HEAD': { stdout: 'd'.repeat(40) },
  'gh --version': { stdout: 'gh version 2.0.0' },
  'gh auth status': { status: 0 },
  'gh pr list': { stdout: '[]' },
  'gh pr create': { stdout: 'https://github.com/acme/root/pull/7' },
});

test('planning PR preflight blocks an unapproved change', async () => {
  const root = approvalFixture('CHG-PREFLIGHT-001');
  try {
    const { run } = stubRunner(planPrResponses('CHG-PREFLIGHT-001'));
    const planPr = createPlanPr({ root, run });
    await withServer(root, async (origin) => {
      const response = await fetch(`${origin}/api/plan-pr/preflight?change=CHG-PREFLIGHT-001`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ready, false);
      assert.deepEqual(body.blockers.map(({ code }) => code), ['NOT_APPROVED']);
    }, { planPr });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('planning PR creation requires the server access token', async () => {
  const root = approvedFixture('CHG-TOKEN-001');
  try {
    const { calls, run } = stubRunner(planPrResponses('CHG-TOKEN-001'));
    const planPr = createPlanPr({ root, run });
    await withServer(root, async (origin) => {
      const denied = await fetch(`${origin}/api/plan-pr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changeId: 'CHG-TOKEN-001' }),
      });
      assert.equal(denied.status, 403);
      assert.deepEqual(calls, []);
    }, { planPr, token: 'test-token' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('planning PR creation commits only the change directory and never merges', async () => {
  const root = approvedFixture('CHG-PR-001');
  try {
    const { calls, run } = stubRunner(planPrResponses('CHG-PR-001'));
    const planPr = createPlanPr({ root, run });
    await withServer(root, async (origin) => {
      const response = await fetch(`${origin}/api/plan-pr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-coordination-token': 'test-token' },
        body: JSON.stringify({ changeId: 'CHG-PR-001' }),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.prNumber, 7);
      assert.equal(body.branch, 'change/CHG-PR-001/coordination');

      assert.ok(calls.some((call) => call.startsWith('git switch -c change/CHG-PR-001/coordination origin/main')));
      assert.ok(calls.some((call) => call.includes('git commit -m plan(CHG-PR-001)') && call.endsWith('-- changes/CHG-PR-001')));
      assert.ok(calls.includes('git push -u origin change/CHG-PR-001/coordination'));
      assert.equal(calls.some((call) => call.startsWith('gh pr merge')), false);
      assert.equal(calls.some((call) => call.includes('--force')), false);
      assert.equal(calls.some((call) => /git push \S+ origin main/.test(call) || call === 'git push origin main'), false);

      const prs = YAML.parse(readFileSync(join(root, 'changes/CHG-PR-001/PRS.yaml'), 'utf8'));
      const planningRow = prs.prs.find(({ work_unit: unit }) => unit === 'contract-and-plan');
      assert.equal(planningRow.number, 7);
      assert.equal(planningRow.state, 'open');
      assert.ok(calls.some((call) => call.includes('record planning PR #7')));
    }, { planPr, token: 'test-token' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merged plan candidates are listed with their recorded state', async () => {
  const root = approvedFixture('CHG-CAND-001');
  try {
    const { run } = stubRunner({
      'git rev-parse --verify origin/main': { status: 0, stdout: 'origin/main' },
      'git log': { stdout: `${'e'.repeat(40)}\t2026-10-02\tplan(CHG-CAND-001): merge` },
      'git show': { stdout: 'schema_version: 1\nstate: approved\n' },
    });
    const planPr = createPlanPr({ root, run });
    await withServer(root, async (origin) => {
      const body = await (await fetch(`${origin}/api/plan-candidates?change=CHG-CAND-001`)).json();
      assert.deepEqual(body.candidates, [{
        sha: 'e'.repeat(40),
        date: '2026-10-02',
        subject: 'plan(CHG-CAND-001): merge',
        state: 'approved',
        dispatchable: true,
      }]);
    }, { planPr });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dispatch names the changes present in the supplied plan commit', async () => {
  const root = approvedFixture('CHG-PRESENT-001');
  try {
    execFileSync('git', ['add', 'changes'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'plan(CHG-PRESENT-001): add'], { cwd: root });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    await withServer(root, async (origin) => {
      const response = await fetch(`${origin}/api/dispatch?change=CHG-OTHER-001&planSha=${sha}`);
      assert.equal(response.status, 422);
      const body = await response.json();
      assert.match(body.error, /CHG-PRESENT-001/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
