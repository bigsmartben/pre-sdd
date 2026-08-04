import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertAuthority,
  repairEvidence,
  staleArtifact,
} from '../scripts/lib/findings.mjs';

test('root-cause category must point to its earliest authority boundary', () => {
  assert.doesNotThrow(() => assertAuthority('SCHEMA', '.agents/skills/visual-spec/schemas/visual-spec.schema.json'));
  assert.doesNotThrow(() => assertAuthority('CHECKLIST_BASELINE', '01-product-design/.psp/models/functional-delivery-baseline.json'));
  assert.doesNotThrow(() => assertAuthority('FIGMA_SOURCE', 'figma://file/12:34'));
  assert.doesNotThrow(() => assertAuthority('FLUTTER_L1', 'lib/ui/widgets/checkout_button.dart'));
  assert.throws(
    () => assertAuthority('FIGMA_SOURCE', 'lib/ui/widgets/checkout_button.dart'),
    (error) => error.code === 'RVW_ROOT_CAUSE_INVALID',
  );
});

test('Stale propagation is local to related Checklist items and increments artifact revision', () => {
  const record = {
    path: '.psp/ui-spec/flutter-visual-coverage.json',
    data: {
      metadata: { artifactId: 'FLUTTER-VISUAL-COVERAGE', revision: 3, status: 'ready' },
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

  const preview = staleArtifact({
    path: '.psp/ui-spec/preview-manifest.json',
    data: {
      metadata: { artifactId: 'FLUTTER-UI-PREVIEW', revision: 2, status: 'accepted' },
      preview: { acceptanceStatus: 'accepted' },
    },
  }, 'VSI-FDBI-001-PAGE-01');
  assert.equal(preview.data.metadata.status, 'stale');
  assert.equal(preview.data.preview.acceptanceStatus, 'stale');
});

test('repair evidence derives digest and revision from actual bytes instead of caller claims', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'repair-evidence-'));
  try {
    await mkdir(resolve(root, '.psp/visual-spec'), { recursive: true });
    await writeFile(resolve(root, '.psp/visual-spec/figma-evidence.json'), '{"metadata":{"revision":7}}\n');
    await mkdir(resolve(root, 'lib/ui'), { recursive: true });
    await writeFile(resolve(root, 'lib/ui/widget.dart'), 'class Widget {}\n');
    const source = await repairEvidence(root, 'lib/ui/widget.dart', '.psp/visual-spec/figma-evidence.json');
    assert.equal(source.revision, null);
    assert.equal(source.verificationPath, 'lib/ui/widget.dart');
    assert.match(source.digest, /^sha256:[a-f0-9]{64}$/);
    const figma = await repairEvidence(root, 'figma://fixture/12:34', '.psp/visual-spec/figma-evidence.json');
    assert.equal(figma.revision, 7);
    assert.equal(figma.verificationPath, '.psp/visual-spec/figma-evidence.json');
  } finally { await rm(root, { recursive: true, force: true }); }
});
