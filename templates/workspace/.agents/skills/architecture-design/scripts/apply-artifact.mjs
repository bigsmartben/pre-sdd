import { executeArtifactTransaction } from '../../../runtime/artifact-transaction.mjs';
import { preparedArtifactOutputs } from './lib/rendering.mjs';

await executeArtifactTransaction({
  stageId: 'architecture-design',
  allowedArtifacts: ['architecture-package', 'system-boundary', 'conceptual-model', 'technical-validation'],
  prepareOutputs({ project, stageId, artifactId, data }) {
    return preparedArtifactOutputs(project, stageId, artifactId, data);
  },
});
