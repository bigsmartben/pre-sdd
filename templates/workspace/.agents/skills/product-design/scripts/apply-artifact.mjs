import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { executeArtifactTransaction } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, readStructured } from '../../../runtime/project.mjs';
import { preparedArtifactOutputs } from './lib/rendering.mjs';
import { migrateLegacyWireflowDirectory } from './lib/migrate-legacy-wireflow.mjs';

await executeArtifactTransaction({
  stageId: 'product-design',
  allowedArtifacts: ['capabilities', 'visual-spec'],
  async prepareCandidate({ root, project, artifactId, data, argumentValue }) {
    const legacyDirectory = argumentValue('--legacy-wireflow-input');
    if (legacyDirectory) {
      if (artifactId !== 'capabilities') {
        throw Object.assign(new Error('--legacy-wireflow-input 只允许用于 capabilities 原子 UC 候选模型。'), { code: 'AIH_COMMAND_INVALID' });
      }
      return migrateLegacyWireflowDirectory(data, legacyDirectory);
    }
    if (artifactId !== 'visual-spec') return data;

    const upstream = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, 'validate.mjs'), '--step', 'use-cases', '--json'],
      { cwd: root, encoding: 'utf8', env: process.env, windowsHide: true },
    );
    if (upstream.status !== 0) {
      throw Object.assign(new Error('Use Cases 独立 readiness 未通过；拒绝写入 Visual Spec，也不会补写上游事实。'), { code: 'AIH_UPSTREAM_NOT_READY' });
    }

    const paths = artifactPaths(project, 'capabilities', 'product-design');
    if (!paths) {
      throw Object.assign(new Error('项目未绑定 Visual Spec 所需的 capabilities。'), { code: 'AIH_PROJECT_BINDING_INVALID' });
    }
    let capabilities;
    try {
      capabilities = await readStructured(root, paths.authorityPath, 'yaml');
    } catch {
      throw Object.assign(new Error('Visual Spec 写入要求已存在且可读取的 Use Cases 权威模型。'), { code: 'AIH_UPSTREAM_NOT_READY' });
    }
    if (capabilities?.metadata?.status !== 'ready' || (capabilities?.gaps || []).length > 0) {
      throw Object.assign(new Error('Use Cases 尚未通过独立 readiness；拒绝写入 Visual Spec，也不会补写上游事实。'), { code: 'AIH_UPSTREAM_NOT_READY' });
    }

    const useCaseIds = new Set((capabilities.useCases || []).map((item) => item.id));
    const stateIds = new Set((capabilities.interactionStates || []).map((item) => item.id));
    const references = [
      ...(data.pages || []).flatMap((item) => item.useCaseRefs || []),
      ...(data.components || []).flatMap((item) => item.useCaseRefs || []),
    ];
    const stateReferences = [
      ...(data.renderings || []).flatMap((item) => item.interactionStateRefs || []),
      ...(data.components || []).flatMap((item) => [
        ...(item.interactionStateRefs || []),
        ...(item.visualCases || []).map((visualCase) => visualCase.interactionStateRef),
      ]),
    ];
    const unresolvedUseCase = references.find((id) => !useCaseIds.has(id));
    const unresolvedState = stateReferences.find((id) => !stateIds.has(id));
    if (unresolvedUseCase || unresolvedState) {
      const value = unresolvedUseCase || unresolvedState;
      throw Object.assign(new Error('Visual Spec 引用了 Use Cases 权威模型中不存在的身份：' + value), { code: 'AIH_REFERENCE_UNRESOLVED' });
    }
    return data;
  },
  prepareOutputs({ root, project, stageId, artifactId, data, members }) {
    return preparedArtifactOutputs(root, project, stageId, artifactId, data, members);
  },
});
