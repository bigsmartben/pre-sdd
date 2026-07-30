import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAuthority,
  staleArtifact,
} from '../scripts/lib/findings.mjs';

test('root-cause category must point to its earliest authority boundary', () => {
  assert.doesNotThrow(() => assertAuthority('SCHEMA', '.agents/skills/visual-spec/schemas/visual-spec.schema.json'));
  assert.doesNotThrow(() => assertAuthority('CHECKLIST_BASELINE', '01-product-design/.psp/models/functional-delivery-baseline.json'));
  assert.doesNotThrow(() => assertAuthority('FIGMA_SOURCE', 'figma://file/12:34'));
  assert.doesNotThrow(() => assertAuthority('LIT_L1', 'src/ui/components/checkout.ts'));
  assert.throws(
    () => assertAuthority('FIGMA_SOURCE', 'src/ui/components/checkout.ts'),
    (error) => error.code === 'RVW_ROOT_CAUSE_INVALID',
  );
});

test('Stale propagation is local to related Checklist items and increments artifact revision', () => {
  const record = {
    path: '.psp/visual-spec/lit-visual-coverage.json',
    data: {
      metadata: { artifactId: 'LIT-VISUAL-COVERAGE', revision: 3, status: 'ready' },
      items: [
        { itemId: 'VSI-FDBI-001-PAGE-01', status: 'accepted' },
        { itemId: 'VSI-FDBI-002-PAGE-01', status: 'accepted' },
      ],
    },
  };
  const result = staleArtifact(record, 'VSI-FDBI-001-PAGE-01');
  assert.equal(result.data.metadata.revision, 4);
  assert.equal(result.data.metadata.status, 'stale');
  assert.equal(result.data.items[0].status, 'stale');
  assert.equal(result.data.items[1].status, 'accepted');

  const authorization = staleArtifact({
    path: '.psp/visual-spec/ready-authorization.json',
    data: { artifactId: 'VISUAL-SPEC-READY-AUTHORIZATION', revision: 2, status: 'ready' },
  }, 'VSI-FDBI-001-PAGE-01');
  assert.equal(authorization.data.revision, 3);
  assert.equal(authorization.data.status, 'stale');

  const mock = staleArtifact({
    path: 'MockCase/suite.json',
    data: {
      metadata: { artifactId: 'MOCK-SCENARIO-SUITE', revision: 4, status: 'ready' },
      scenarios: [
        { scenarioId: 'case-tc-001', status: 'ready' },
        { scenarioId: 'case-tc-002', status: 'ready' },
      ],
    },
  }, 'VSI-FDBI-001-PAGE-01', new Set(['case-tc-001']));
  assert.equal(mock.data.scenarios[0].status, 'stale');
  assert.equal(mock.data.scenarios[1].status, 'ready');
});
