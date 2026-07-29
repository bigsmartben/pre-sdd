import { resolve } from 'node:path';
import {
  artifactPaths,
  loadProjectAndManifest,
  readStructured,
  repositoryRootFrom,
} from '../../../../.psp/harness/scripts/lib/repository.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
const json = process.argv.includes('--json');
const blockers = [];

function block(message, location) {
  blockers.push({ code: 'AIH_UC_CASE_COVERAGE_INCOMPLETE', message, ...(location ? { location } : {}) });
}

function stepsForPath(useCase, kind, path) {
  if (kind === 'main') return useCase.mainScenario || [];
  return path.steps || [];
}

function deriveUcCases(capabilities) {
  const flowsByUseCase = new Map();
  for (const flow of capabilities.interactionFlows || []) {
    const collection = flowsByUseCase.get(flow.useCase) || [];
    collection.push(flow);
    flowsByUseCase.set(flow.useCase, collection);
  }

  return (capabilities.useCases || []).flatMap((useCase) => {
    const uiRequired = useCase.uiApplicability?.mode === 'required';
    const paths = [
      { id: `${useCase.id}-MAIN`, kind: 'main', scenarioRef: 'main', value: useCase.mainScenario || {} },
      ...(useCase.alternateScenarios || []).map((scenario) => ({
        id: scenario.id,
        kind: scenario.type === 'exception' ? 'exception' : 'alternate',
        scenarioRef: scenario.id,
        value: scenario,
      })),
    ];
    const flows = flowsByUseCase.get(useCase.id) || [];
    if (!uiRequired && flows.length > 0) {
      block(`非 UI Use Case 不得声明 Interaction Flow：${useCase.id}`, `interactionFlows.${useCase.id}`);
    }
    return paths.map((path) => {
      const stepIds = stepsForPath(useCase, path.kind, path.value).map((step) => step.id);
      const transitions = flows.flatMap((flow) => (
        (flow.transitions || [])
          .filter((transition) => transition.scenarioRef === path.scenarioRef)
          .map((transition) => ({ ...transition, interactionFlowId: flow.id }))
      ));
      const coveredStepIds = new Set(transitions.flatMap((transition) => transition.useCaseStepRefs || []));
      const missingStepIds = stepIds.filter((id) => !coveredStepIds.has(id));
      const unknownStepIds = [...coveredStepIds].filter((id) => !stepIds.includes(id));
      if (uiRequired && transitions.length === 0) {
        block(`UC Case 缺少 Interaction Flow Transition：${path.id}`, `useCases.${useCase.id}`);
      }
      if (uiRequired && missingStepIds.length > 0) {
        block(`UC Case 的业务步骤未被 Interaction Flow 覆盖：${path.id} / ${missingStepIds.join(', ')}`, `useCases.${useCase.id}`);
      }
      if (uiRequired && unknownStepIds.length > 0) {
        block(`Interaction Flow 引用了不属于该 UC Case 的步骤：${path.id} / ${unknownStepIds.join(', ')}`, `interactionFlows.${useCase.id}`);
      }
      return {
        id: path.id,
        useCaseId: useCase.id,
        kind: path.kind,
        uiApplicability: useCase.uiApplicability?.mode || 'unknown',
        interactionCoverage: uiRequired
          ? (transitions.length > 0 && missingStepIds.length === 0 && unknownStepIds.length === 0 ? 'covered' : 'incomplete')
          : 'not-applicable',
        stepIds,
        interactionFlowIds: [...new Set(transitions.map((item) => item.interactionFlowId))],
        transitionIds: transitions.map((item) => item.id),
        covered: !uiRequired || (
          transitions.length > 0
          && missingStepIds.length === 0
          && unknownStepIds.length === 0
        ),
      };
    });
  });
}

try {
  const { project, manifest } = await loadProjectAndManifest(root);
  const registry = manifest.artifactRegistry.find((item) => item.id === 'capabilities');
  const paths = artifactPaths(project, 'capabilities', 'product-design');
  const capabilities = await readStructured(root, paths.authorityPath, registry.format);
  const cases = deriveUcCases(capabilities);
  const knownUseCases = new Set((capabilities.useCases || []).map((item) => item.id));
  for (const flow of capabilities.interactionFlows || []) {
    if (!knownUseCases.has(flow.useCase)) {
      block(`Interaction Flow 引用未知 Use Case：${flow.id} / ${flow.useCase}`, `interactionFlows.${flow.id}`);
    }
  }
  const output = {
    status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    operation: 'analyze:uc-case-coverage',
    readOnly: true,
    cases,
    blockers,
  };
  if (json) console.log(JSON.stringify(output, null, 2));
  else if (output.status === 'PASS') console.log(`[PASS] ${cases.length} 个 UC Case 均已被 Interaction Flow 覆盖。`);
  else for (const item of blockers) console.error(`[${item.code}] ${item.message}`);
  process.exit(output.status === 'PASS' ? 0 : 1);
} catch (error) {
  const output = {
    status: 'BLOCKED',
    operation: 'analyze:uc-case-coverage',
    readOnly: true,
    cases: [],
    blockers: [{
      code: error.code || 'AIH_UC_CASE_COVERAGE_INCOMPLETE',
      message: error.message,
    }],
  };
  if (json) console.log(JSON.stringify(output, null, 2));
  else console.error(`[${output.blockers[0].code}] ${output.blockers[0].message}`);
  process.exit(1);
}
