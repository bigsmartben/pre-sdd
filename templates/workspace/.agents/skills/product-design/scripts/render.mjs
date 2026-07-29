import {
  outputDrift,
  writeExpectedOutputs,
} from './lib/rendering.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { canonicalExpectedOutputs, canonicalOutputDrift } from '../canonical-ui-prototype/scripts/project.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
const stageId = 'product-design';
const check = process.argv.includes('--check');
const json = process.argv.includes('--json');
let result;

try {
  const project = await loadProject(root);
  const productStage = project.stages?.['product-design'];
  if (productStage?.status === 'uninitialized' && process.env.PSP_STAGE_INITIALIZING !== stageId) {
    result = check
      ? {
        status: 'PASS',
        mode: 'check',
        state: 'uninitialized',
        outputs: [],
        blockers: [],
        warnings: [{
          code: 'AIH_STAGE_UNINITIALIZED',
          message: '产品设计尚未初始化，没有待检查的用户产物或机器支撑。',
        }],
      }
      : {
        status: 'BLOCKED',
        mode: 'render',
        state: 'uninitialized',
        blockers: [{
          code: 'AIH_STAGE_UNINITIALIZED',
          message: '产品设计尚未初始化；请先通过 Product Design Skill 开始该阶段。',
        }],
      };
  } else if (check) {
    const drift = [
      ...await outputDrift(root, project, stageId),
      ...await canonicalOutputDrift(root, project),
    ];
    result = {
      status: drift.length === 0 ? 'PASS' : 'BLOCKED',
      mode: 'check',
      blockers: drift.map((item) => ({
        code: 'AIH_GENERATED_DRIFT',
        location: item.output,
        message: 'output 与内部模型不一致：' + item.internalModel,
      })),
    };
  } else if (process.env.PSP_STAGE_INITIALIZING !== stageId && process.env.NODE_ENV !== 'test') {
    result = {
      status: 'BLOCKED',
      mode: 'render',
      blockers: [{
        code: 'AIH_COMMAND_INVALID',
        message: '日常产品产物更新必须使用 Product Design Skill 的受控写入；渲染器只供领域动作调用。',
      }],
    };
  } else {
    const outputs = [
      ...await writeExpectedOutputs(root, project, stageId),
      ...await canonicalExpectedOutputs(root, project),
    ];
    for (const output of outputs.filter((item) => item.authorityPath)) {
      const absolute = repositoryFile(root, output.output);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, output.content, 'utf8');
    }
    result = {
      status: 'PASS',
      mode: 'render',
      outputs: outputs.map((item) => ({ authority: item.authorityPath || item.internalModel, output: item.output, role: item.role })),
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
  if (result.state === 'uninitialized') console.log('[PASS] 产品阶段未初始化，没有待生成 output。');
  else console.log('[PASS] ' + (check ? '用户产物与机器支撑均与内部模型一致。' : '用户产物与机器支撑已确定性生成。'));
}
else for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);

if (result.status !== 'PASS') process.exitCode = 1;
