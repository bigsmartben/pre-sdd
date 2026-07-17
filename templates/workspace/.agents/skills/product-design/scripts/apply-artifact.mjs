import { executeArtifactTransaction } from '../../../../.psp/harness/scripts/lib/artifact-transaction.mjs';
import { preparedArtifactOutputs } from './lib/rendering.mjs';

await executeArtifactTransaction({
  stageId: 'product-design',
  prepareOutputs({ project, manifest, stageId, artifactId, data }) {
    return preparedArtifactOutputs(project, manifest, stageId, artifactId, data);
  },
});
