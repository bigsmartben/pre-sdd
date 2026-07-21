import { executeArtifactTransaction } from '../../../../.psp/harness/scripts/lib/artifact-transaction.mjs';
import { preparedArtifactOutputs } from './lib/rendering.mjs';
import { migrateLegacyWireflowDirectory } from './lib/migrate-legacy-wireflow.mjs';

await executeArtifactTransaction({
  stageId: 'product-design',
  async prepareCandidate({ artifactId, data, argumentValue }) {
    const legacyDirectory = argumentValue('--legacy-wireflow-input');
    if (!legacyDirectory) return data;
    if (artifactId !== 'capabilities') {
      throw Object.assign(new Error('--legacy-wireflow-input 只允许用于 capabilities 原子 UC 候选模型。'), { code: 'AIH_COMMAND_INVALID' });
    }
    return migrateLegacyWireflowDirectory(data, legacyDirectory);
  },
  prepareOutputs({ root, project, manifest, stageId, artifactId, data, members }) {
    return preparedArtifactOutputs(root, project, manifest, stageId, artifactId, data, members);
  },
});
