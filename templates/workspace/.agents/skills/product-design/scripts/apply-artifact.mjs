import { executeArtifactTransaction } from '../../../runtime/artifact-transaction.mjs';
import { preparedArtifactOutputs } from './lib/rendering.mjs';

await executeArtifactTransaction({
  stageId: 'product-design',
  allowedArtifacts: ['capabilities', 'functional-delivery-baseline'],
  prepareOutputs({ root, project, stageId, artifactId, data }) {
    return preparedArtifactOutputs(root, project, stageId, artifactId, data);
  },
});
