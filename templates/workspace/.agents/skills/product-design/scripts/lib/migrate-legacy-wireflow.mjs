import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseStructuredText } from '../../../../../.psp/harness/scripts/lib/repository.mjs';

function fail(message) {
  throw Object.assign(new Error(message), { code: 'AIH_PATH_INVALID' });
}

function numbered(prefix, index, width = 3) {
  return prefix + String(index + 1).padStart(width, '0');
}

function mapLayout(node, regionIds) {
  if (node.type === 'region') return { type: 'region', region: regionIds.get(node.region) };
  return { type: node.type, children: (node.children || []).map((child) => mapLayout(child, regionIds)) };
}

function stateType(oldState, entryStates) {
  if (oldState.terminal) return oldState.type === 'success' ? 'success' : oldState.type === 'error' ? 'failure' : 'cancelled';
  if (entryStates.has(oldState.id)) return 'entry';
  if (['loading', 'disabled'].includes(oldState.type)) return 'waiting';
  return oldState.type === 'error' ? 'failure' : 'in-progress';
}

function referencedUseCaseText(capabilities, stepRefs, field) {
  const values = [];
  for (const useCase of capabilities.useCases || []) {
    for (const step of useCase.mainScenario || []) if (stepRefs.includes(step.id)) values.push(step[field]);
    for (const scenario of useCase.alternateScenarios || []) for (const step of scenario.steps || []) if (stepRefs.includes(step.id)) values.push(step[field]);
  }
  return values.filter(Boolean).join('；');
}

export async function migrateLegacyWireflowDirectory(capabilities, directory) {
  const absolute = resolve(process.cwd(), directory);
  let info;
  try { info = await stat(absolute); } catch { fail('旧 Wireflow 输入目录不存在：' + directory); }
  if (!info.isDirectory()) fail('旧 Wireflow 输入必须是目录：' + directory);
  const members = [];
  for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^ACTOR-[0-9]{3}$/.test(entry.name)) fail('旧 Wireflow 目录只能包含 ACTOR-NNN 子目录：' + entry.name);
    const memberPath = resolve(absolute, entry.name, 'wireflow-mid.yaml');
    let source;
    try { source = parseStructuredText(await readFile(memberPath, 'utf8'), 'yaml'); } catch (error) { fail('无法读取旧 Wireflow：' + memberPath + '；' + error.message); }
    if (source?.metadata?.actor !== entry.name) fail('旧 Wireflow 目录与 metadata.actor 不一致：' + entry.name);
    members.push(source);
  }
  if (members.length === 0) fail('旧 Wireflow 输入目录没有参与者分区。');

  const legacyFlows = members.flatMap((member) => member.wireflows || []);
  const legacyStates = members.flatMap((member) => member.interactionStates || []);
  const legacyScreens = members.flatMap((member) => member.screens || []);
  const entryStates = new Set(legacyFlows.map((flow) => flow.entry?.state));
  const stateIds = new Map(legacyStates.map((state, index) => [state.id, numbered('INT-STATE-', index)]));
  const flowIds = new Map(legacyFlows.map((flow, index) => [flow.id, numbered('IF-', index)]));
  const screenIds = new Map(legacyScreens.map((screen, index) => [screen.id, numbered('LF-SCREEN-', index)]));
  const allRegions = legacyScreens.flatMap((screen) => screen.regions || []);
  const allControls = allRegions.flatMap((region) => region.controls || []);
  const regionIds = new Map(allRegions.map((region, index) => [region.id, numbered('LF-REGION-', index)]));
  const controlIds = new Map(allControls.map((control, index) => [control.id, numbered('LF-CONTROL-', index)]));
  const scenarioById = new Map((capabilities.useCases || []).flatMap((useCase) => (useCase.alternateScenarios || []).map((scenario) => [scenario.id, scenario])));

  const interactionStates = legacyStates.map((state) => ({
    id: stateIds.get(state.id),
    name: state.condition,
    type: stateType(state, entryStates),
    description: '由旧 Wireflow 状态 ' + state.id + ' 一次性迁移：' + state.condition,
    terminal: state.terminal,
  }));
  const interactionFlows = legacyFlows.map((flow) => {
    const id = flowIds.get(flow.id);
    return {
      id,
      useCase: flow.useCase,
      name: flow.name,
      coveredScenarios: flow.coveredScenarios,
      entryState: stateIds.get(flow.entry.state),
      completionStates: flow.completionStates.map((stateId) => stateIds.get(stateId)),
      transitions: flow.steps.map((step, index) => {
        const scenario = scenarioById.get(step.scenarioRef);
        const failure = scenario?.type === 'exception';
        return {
          id: id + '-TRANS-' + String(index + 1).padStart(2, '0'),
          scenarioRef: step.scenarioRef,
          useCaseStepRefs: step.useCaseStepRefs,
          from: stateIds.get(step.from.state),
          to: stateIds.get(step.to.state),
          userAction: step.trigger.control ? referencedUseCaseText(capabilities, step.useCaseStepRefs, 'action') || '操作 ' + step.trigger.control : null,
          systemResponse: referencedUseCaseText(capabilities, step.useCaseStepRefs, 'outcome') || step.trigger.event,
          guard: step.guard,
          branchLabel: step.branchLabel,
          failureResponse: failure ? {
            failure: scenario.outcome,
            retry: null,
            recovery: null,
            returnToState: stateIds.get(step.from.state),
          } : null,
        };
      }),
    };
  });

  const lowFiUiBlueprints = members.filter((member) => (member.screens || []).length > 0).map((member, index) => {
    const useCases = [...new Set(member.screens.flatMap((screen) => screen.useCases || []))];
    return {
      id: numbered('BLUEPRINT-', index),
      actor: member.metadata.actor,
      useCases,
      informationArchitecture: {
        entryScreen: screenIds.get(member.siteMap.entryScreen),
        nodes: member.siteMap.nodes.map((node) => ({ screen: screenIds.get(node.screen), parent: node.parent ? screenIds.get(node.parent) : null })),
      },
      screens: member.screens.map((screen) => ({
        id: screenIds.get(screen.id), name: screen.name, purpose: screen.purpose, useCases: screen.useCases,
        layoutTree: mapLayout(screen.layoutTree, regionIds),
        regions: screen.regions.map((region) => ({
          id: regionIds.get(region.id), name: region.name, purpose: region.purpose, content: region.content,
          controls: region.controls.map((control) => ({ id: controlIds.get(control.id), type: control.type, label: control.label, purpose: control.purpose, action: control.action })),
        })),
      })),
      statePresentations: member.interactionStates.map((state) => ({
        interactionState: stateIds.get(state.id),
        screen: screenIds.get(state.screen),
        suggestion: state.condition + '；状态差量：' + JSON.stringify(state.stateDelta),
      })),
    };
  });
  const uiUseCases = new Set(interactionFlows.map((flow) => flow.useCase));
  return {
    ...capabilities,
    useCases: (capabilities.useCases || []).map((useCase) => ({
      ...useCase,
      uiApplicability: uiUseCases.has(useCase.id)
        ? { mode: 'required', reason: null }
        : { mode: 'not-applicable', reason: '旧 Wireflow 输入中没有该 Use Case 的 UI 流程。' },
    })),
    interactionStates,
    interactionFlows,
    lowFiUiBlueprints,
  };
}
