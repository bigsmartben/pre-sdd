import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const templateRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
export const repositoryRoot = resolve(templateRoot, '..', '..');

export function digest(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

export async function writeJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function fixtureWorkspace({ deliveryLevel = 'VISUAL' } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'visual-spec-chain-'));
  const workspace = resolve(parent, 'workspace');
  await cp(templateRoot, workspace, { recursive: true });
  await symlink(resolve(repositoryRoot, 'node_modules'), resolve(workspace, 'node_modules'), 'junction');

  const useCases = parseYaml(await readFile(resolve(workspace, '.agents/skills/product-design/capabilities/template.yaml'), 'utf8'));
  useCases.metadata.status = 'ready';
  useCases.metadata.revision = 1;
  useCases.intent = {
    productName: 'Fixture Product',
    productConcept: '用于契约测试',
    problem: '验证视觉链',
    businessGoal: '确定性通过',
    successSignal: '全部断言通过',
  };
  useCases.actors = [{ id: 'ACTOR-001', name: 'User', goal: '完成任务' }];
  useCases.productScope = { included: ['结算'], excluded: [] };
  useCases.businessRules = [];
  useCases.useCases = [{
    id: 'UC-001',
    name: '完成结算',
    actor: 'ACTOR-001',
    goal: '提交订单',
    value: '完成购买',
    trigger: '用户进入结算',
    preconditions: [],
    successOutcome: '订单已提交',
    minimumGuarantee: '输入被保留',
    uiApplicability: { mode: 'required', reason: null },
    mainScenario: [{
      id: 'UC-001-STEP-01',
      initiator: 'actor',
      action: '提交订单',
      outcome: '显示提交结果',
    }],
    alternateScenarios: [],
    businessRules: [],
    relationships: [],
  }];
  useCases.interactionStates = [];
  useCases.interactionFlows = [];
  useCases.lowFiUiBlueprints = [];
  useCases.gaps = [];
  await mkdir(resolve(workspace, '01-product-design/.psp/models'), { recursive: true });
  await writeFile(
    resolve(workspace, '01-product-design/.psp/models/use-cases.yaml'),
    stringifyYaml(useCases),
    'utf8',
  );

  const testCaseRefs = deliveryLevel === 'USER_PATH' ? ['TC-001'] : [];
  await writeJson(resolve(workspace, '01-product-design/.psp/models/functional-delivery-baseline.json'), {
    apiVersion: 'psp.dev/v1',
    kind: 'FunctionalDeliveryBaseline',
    metadata: {
      artifactId: 'FUNCTIONAL-DELIVERY-BASELINE',
      revision: 1,
      status: 'ready',
    },
    items: [{
      baselineItemId: 'FDBI-001',
      classification: 'visual',
      targetRefs: ['UC-001'],
      deliveryLevel,
      testCaseRefs,
      reason: 'Fixture 需要可见结算页',
      visualRequirements: [{
        kind: 'PAGE',
        sourceRef: 'UC-001',
        requirementRefs: ['UC-001'],
        name: '结算页',
        viewports: ['mobile'],
        states: ['default'],
        variants: [],
        contentCases: ['normal'],
        tokens: [],
        assets: [],
        motions: [],
      }],
    }],
    gaps: [],
  });

  if (deliveryLevel === 'USER_PATH') {
    await writeJson(resolve(workspace, 'Cases/test-cases.json'), {
      apiVersion: 'psp.dev/v1',
      kind: 'TestCaseCatalog',
      metadata: { artifactId: 'TEST-CASE-CATALOG', revision: 1, status: 'ready' },
      testCases: [{
        testCaseId: 'TC-001',
        useCaseRef: 'UC-001',
        scenarioRef: 'main',
        name: '提交订单',
        preconditions: [],
        steps: [{
          stepId: 'TC-001-STEP-01',
          useCaseStepRef: 'UC-001-STEP-01',
          action: '提交订单',
          expectedOutcome: '显示提交结果',
        }],
      }],
      gaps: [],
    });
  }
  return { parent, workspace };
}

export function run(workspace, relativeScript, args = []) {
  return spawnSync(process.execPath, [resolve(workspace, relativeScript), ...args], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PSP_REPOSITORY_ROOT: workspace },
  });
}

export function jsonResult(result) {
  return JSON.parse(result.stdout || result.stderr);
}
