import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDraft } from '../scripts/orchestration/change-service.mjs';

test('work unit normalization does not repeatedly scan all preceding units', () => {
  const workUnits = Array.from({ length: 100 }, (_, index) => ({ id: `work-${index}`, service: 'api' }));
  workUnits.slice = () => { throw new Error('quadratic preceding-unit scan'); };
  const draft = normalizeDraft({ workUnits });
  assert.equal(draft.workUnits.length, 100);
  assert.equal(draft.workUnits[99].id, 'work-99');
});

test('linear normalization preserves generated ID counts without counting explicit IDs', () => {
  const draft = normalizeDraft({ workUnits: [
    { service: 'api' },
    { id: 'explicit-api', service: 'api' },
    { service: 'api' },
    { service: 'web' },
  ] });
  assert.deepEqual(draft.workUnits.map(({ id }) => id), ['api', 'explicit-api', 'api-2', 'web']);
});
