import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyPrs } from '../scripts/verify-prs.mjs';
import { buildChangeFiles } from '../scripts/orchestration/change-service.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'single-account-prs-'));
  mkdirSync(join(root, 'changes/CHG-SINGLE-001'), { recursive: true });
  mkdirSync(join(root, 'services'));
  const sha = { base: 'a'.repeat(40), head: 'b'.repeat(40), merge: 'c'.repeat(40) };
  writeFileSync(join(root, 'services/registry.yaml'), 'version: 2\ngithub:\n  host: github.com\nservices:\n  - id: api\n    repo: https://github.com/example/api.git\n');
  writeFileSync(join(root, 'changes/CHG-SINGLE-001/PRS.yaml'), `schema_version: 1\nprs:\n  - key: api-implementation\n    repo: api\n    number: 1\n    state: merged\n    base_sha: ${sha.base}\n    head_sha: ${sha.head}\n    merge_sha: ${sha.merge}\n`);
  return { root, sha };
}

test('same-account PR merge needs no approval lookup but still checks actual SHAs and merge state', async () => {
  const { root, sha } = fixture();
  let merged = true;
  let mergeSha = sha.merge;
  const requested = [];
  const run = () => verifyPrs({
    argv: ['--change', 'CHG-SINGLE-001'], cwd: root,
    env: { COORDINATION_GITHUB_TOKEN: 'test-fixture' },
    fetchImpl: async (url) => {
      requested.push(url);
      assert.equal(url.endsWith('/reviews?per_page=100'), false, 'single-account mode must not require reviews');
      return { ok: true, json: async () => ({ merged_at: merged ? '2026-10-07T00:00:00Z' : null, user: { login: 'author' }, merged_by: { login: 'author' }, base: { sha: sha.base }, head: { sha: sha.head }, merge_commit_sha: mergeSha }) };
    },
  });
  try {
    assert.match(await run(), /1 merged PR/);
    assert.equal(requested.length, 1);
    merged = false;
    await assert.rejects(run, /not merged/);
    merged = true;
    mergeSha = 'd'.repeat(40);
    await assert.rejects(run, /merge_sha.*does not match GitHub/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('generated plan supports one human merger without a separate reviewer role', () => {
  const files = buildChangeFiles({ changeId: 'CHG-SINGLE-001', title: 'Single account', coordinator: 'author', goals: [{ id: 'GOAL-001', title: 'Plan', outcome: 'Plan is recorded' }], noNonGoals: true, acceptanceCriteria: ['Recorded'], services: ['api'], noSharedContract: true, workUnits: [{ id: 'api-implementation', goalId: 'GOAL-001', service: 'api', goal: 'Implement', writer: 'author', writePaths: ['src/**'], verify: ['npm test'], dependsOn: [] }] }, { rootHead: 'a'.repeat(40), services: [{ id: 'api', path: 'services/api', baseSha: 'b'.repeat(40), verify: [] }] });
  assert.doesNotMatch(files.get('PLAN.md'), /independent reviewer|Required approvers/);
  assert.match(files.get('PLAN.md'), /Human merger: author/);
});
