import {
  outputDrift,
  writeExpectedOutputs,
} from './lib/rendering.mjs';
import { resolve } from 'node:path';
import { loadProject, repositoryRootFrom } from '../../../runtime/project.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
const stageId = 'architecture-design';
const check = process.argv.includes('--check');
const json = process.argv.includes('--json');
let result;

try {
  const project = await loadProject(root);
  const stage = project.stages?.[stageId];
  const initializing = process.env.PSP_STAGE_INITIALIZING === stageId;
  if (stage?.status === 'uninitialized' && !initializing) {
    result = check
      ? {
        status: 'PASS',
        mode: 'check',
        state: 'uninitialized',
        outputs: [],
        blockers: [],
        warnings: [{
          code: 'AIH_STAGE_UNINITIALIZED',
          message: '架构设计尚未初始化，没有待检查的 Markdown 用户产物。',
        }],
      }
      : {
        status: 'BLOCKED',
        mode: 'render',
        state: 'uninitialized',
        blockers: [{
          code: 'AIH_STAGE_UNINITIALIZED',
          message: '架构设计尚未初始化；请先通过 Architecture Design Skill 独立开始该阶段。',
        }],
      };
  } else if (stage?.status !== 'active' && !initializing) {
    result = {
      status: 'BLOCKED',
      mode: check ? 'check' : 'render',
      blockers: [{
        code: stage?.blockerCode || 'AIH_PROJECT_BINDING_INVALID',
        message: '架构阶段当前不可执行：' + (stage?.status || 'missing'),
      }],
    };
  } else if (check) {
    const drift = await outputDrift(root, project, stageId);
    result = {
      status: drift.length === 0 ? 'PASS' : 'BLOCKED',
      mode: 'check',
      blockers: drift.map((item) => ({
        code: 'AIH_GENERATED_DRIFT',
        location: item.output,
        message: 'Markdown 用户产物与内部模型不一致：' + item.internalModel,
      })),
    };
  } else if (!initializing && process.env.NODE_ENV !== 'test') {
    result = {
      status: 'BLOCKED',
      mode: 'render',
      blockers: [{
        code: 'AIH_COMMAND_INVALID',
        message: '日常架构产物更新必须使用 Architecture Design Skill 的受控写入；渲染器只供领域动作调用。',
      }],
    };
  } else {
    const outputs = await writeExpectedOutputs(root, project, stageId);
    result = {
      status: 'PASS',
      mode: 'render',
      outputs: outputs.map((item) => ({ internalModel: item.internalModel, output: item.output, role: item.role })),
      blockers: [],
    };
  }
} catch (error) {
  result = {
    status: 'BLOCKED',
    mode: check ? 'check' : 'render',
    blockers: [{
      code: error.code || 'AIH_PROJECT_BINDING_INVALID',
      message: error.message,
    }],
  };
}

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') {
  if (result.state === 'uninitialized') console.log('[PASS] 架构阶段未初始化，没有待生成 output。');
  else console.log('[PASS] ' + (check ? '架构 Markdown 用户产物与内部模型一致。' : '架构 Markdown 用户产物已确定性生成。'));
} else {
  for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
}

if (result.status !== 'PASS') process.exitCode = 1;
