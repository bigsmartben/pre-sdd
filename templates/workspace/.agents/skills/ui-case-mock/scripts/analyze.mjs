import { resolve } from 'node:path';
import {
  artifactCollectionMembers,
  artifactMemberPath,
  artifactPaths,
  artifactDefinition,
  loadProject,
  readStructured,
  repositoryRootFrom,
} from '../../../runtime/project.mjs';
import { extractCanonicalUi } from '../../product-design/canonical-ui-prototype/scripts/extract.mjs';
import { analyzeUiCaseCoverage } from './model.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
const actorIndex = process.argv.indexOf('--actor');
const requestedActor = actorIndex >= 0 ? process.argv[actorIndex + 1] : null;
const json = process.argv.includes('--json');

async function analyzeActor(actor, project, visualSpec) {
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const authorityPath = artifactMemberPath(paths, actor);
  try {
    const model = await extractCanonicalUi(root, authorityPath);
    return { actor, ...analyzeUiCaseCoverage(model, visualSpec) };
  } catch (error) {
    return {
      actor,
      status: 'BLOCKED',
      policy: 'axis-value-coverage',
      counts: { viewModels: 0, uiCases: 0, pageInstances: 0 },
      blockers: [{
        code: error.code || 'AIH_UI_CASE_CONTRACT_INVALID',
        message: error.message,
        location: authorityPath,
      }],
    };
  }
}

const project = await loadProject(root);
const visualRegistry = artifactDefinition(project, 'visual-spec', 'product-design');
const visualPaths = artifactPaths(project, 'visual-spec', 'product-design');
const visualSpec = await readStructured(root, visualPaths.authorityPath, visualRegistry.format);
let results;
if (requestedActor) {
  results = [await analyzeActor(requestedActor, project, visualSpec)];
} else {
  const canonicalPaths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const members = await artifactCollectionMembers(root, canonicalPaths);
  results = await Promise.all(members.map((member) => analyzeActor(member.actor, project, visualSpec)));
  if (members.length === 0) {
    results = [{
      actor: null,
      status: 'BLOCKED',
      policy: 'axis-value-coverage',
      counts: { viewModels: 0, uiCases: 0, pageInstances: 0 },
      blockers: [{
        code: 'AIH_ARTIFACT_INCOMPLETE',
        message: '尚未创建参与者 Canonical UI 应用。',
        location: canonicalPaths.authorityRoot,
      }],
    }];
  }
}

const blockers = results.flatMap((result) => result.blockers);
const output = {
  status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
  operation: 'analyze:ui-case-coverage',
  policy: 'axis-value-coverage',
  actors: results,
  blockers,
};
if (json) console.log(JSON.stringify(output, null, 2));
else if (output.status === 'PASS') console.log(`[PASS] UI Case 轴值覆盖完整（${results.length} 个参与者）。`);
else for (const item of blockers) console.error(`[${item.code}] ${item.message}`);
process.exit(output.status === 'PASS' ? 0 : 1);
