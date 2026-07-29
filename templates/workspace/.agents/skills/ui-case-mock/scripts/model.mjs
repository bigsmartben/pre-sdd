function blocker(code, message, location) {
  return { code, message, ...(location ? { location } : {}) };
}

function byId(items = []) {
  return new Map(items.map((item) => [item.id, item]));
}

function stableUnique(items) {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}

function routeInstances(model, routeId) {
  const route = (model.routes || []).find((item) => item.id === routeId);
  if (!route) return [];
  return (model.componentContracts || []).flatMap((contract) => (
    (contract.pageInstances || [])
      .filter((instance) => instance.screenId === route.screenId)
      .map((instance) => ({ contract, instance }))
  ));
}

function selectedEntry(model, contract, override) {
  const entryId = override?.stateMatrixEntryId || contract.defaultStateMatrixEntryId;
  return (model.stateMatrix || []).find((entry) => entry.id === entryId);
}

function sameStringRecord(left = {}, right = {}) {
  return JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
}

function visualCaseBlockers(model, visualSpec) {
  if (!visualSpec) return [];
  const blockers = [];
  const visualComponents = byId(visualSpec.components);
  const contractsByVisualComponent = new Map();

  for (const contract of model.componentContracts || []) {
    const location = `componentContracts.${contract.id}.visualComponentId`;
    const visualComponent = visualComponents.get(contract.visualComponentId);
    if (!visualComponent) {
      blockers.push(blocker(
        'AIH_UI_CASE_VISUAL_TRACE_INVALID',
        `Component Contract 引用未知 Component Visual Spec：${contract.id} / ${contract.visualComponentId}`,
        location,
      ));
      continue;
    }
    if (contractsByVisualComponent.has(visualComponent.id)) {
      blockers.push(blocker(
        'AIH_UI_CASE_VISUAL_TRACE_INVALID',
        `同一 Component Visual Spec 只能由一个 Component Contract 解析：${visualComponent.id}`,
        location,
      ));
    }
    contractsByVisualComponent.set(visualComponent.id, contract.id);

    const axes = (model.stateAxes || []).filter((axis) => axis.componentContractId === contract.id);
    const variantAxes = axes.filter((axis) => axis.kind === 'variant');
    const expectedVariants = Object.fromEntries(
      (visualComponent.variantAxes || []).map((axis) => [axis.name, [...axis.values].sort()]),
    );
    const actualVariants = Object.fromEntries(
      variantAxes.map((axis) => [axis.name, axis.values.map((value) => value.value).sort()]),
    );
    if (!sameStringRecord(
      Object.fromEntries(Object.entries(expectedVariants).map(([name, values]) => [name, JSON.stringify(values)])),
      Object.fromEntries(Object.entries(actualVariants).map(([name, values]) => [name, JSON.stringify(values)])),
    )) {
      blockers.push(blocker(
        'AIH_UI_CASE_VISUAL_TRACE_INVALID',
        `Component Visual Case 的 Variant Axis 必须与 Canonical UI State Axis 一致：${contract.id}`,
        location,
      ));
    }

    const interactionAxis = axes.find((axis) => axis.kind === 'interaction-state');
    const expectedInteractionStates = stableUnique(visualComponent.interactionStateRefs || []);
    const actualInteractionStates = stableUnique(
      (interactionAxis?.values || []).map((value) => value.stateId).filter(Boolean),
    );
    if (JSON.stringify(expectedInteractionStates) !== JSON.stringify(actualInteractionStates)) {
      blockers.push(blocker(
        'AIH_UI_CASE_VISUAL_TRACE_INVALID',
        `Component Visual Case 的 Interaction State 必须与 Canonical UI State Axis 一致：${contract.id}`,
        location,
      ));
    }

    for (const visualCase of visualComponent.visualCases || []) {
      const expected = new Map((visualCase.variants || []).map((item) => [item.name, item.value]));
      const resolvable = (model.stateMatrix || []).some((entry) => {
        if (entry.componentContractId !== contract.id || entry.classification !== 'legal') return false;
        if (interactionAxis) {
          const value = interactionAxis.values.find((item) => item.id === entry.values[interactionAxis.id]);
          if (value?.stateId !== visualCase.interactionStateRef) return false;
        }
        return variantAxes.every((axis) => {
          const value = axis.values.find((item) => item.id === entry.values[axis.id]);
          return value?.value === expected.get(axis.name);
        });
      });
      if (!resolvable) {
        blockers.push(blocker(
          'AIH_UI_CASE_VISUAL_TRACE_INVALID',
          `Component Visual Case 无法解析到合法 State Matrix Entry：${visualCase.id}`,
          `visualCases.${visualCase.id}`,
        ));
      }
    }
  }
  return blockers;
}

export function analyzeUiCaseCoverage(model, visualSpec) {
  const blockers = [];
  const routes = byId(model.routes);
  const viewports = byId(model.viewports);
  const viewModels = byId(model.uiViewModels);
  const matrix = byId(model.stateMatrix);
  const instanceOwners = new Map();

  for (const contract of model.componentContracts || []) {
    for (const instance of contract.pageInstances || []) {
      if (instanceOwners.has(instance.id)) {
        blockers.push(blocker(
          'AIH_UI_CASE_CONTRACT_INVALID',
          `Page Instance ID 必须全局唯一：${instance.id}`,
          `componentContracts.${contract.id}.pageInstances`,
        ));
      }
      instanceOwners.set(instance.id, { contract, instance });
    }
  }

  const viewModelIds = new Set();
  for (const viewModel of model.uiViewModels || []) {
    const location = `uiViewModels.${viewModel.id}`;
    if (viewModelIds.has(viewModel.id)) {
      blockers.push(blocker('AIH_UI_CASE_CONTRACT_INVALID', `UI ViewModel ID 重复：${viewModel.id}`, location));
    }
    viewModelIds.add(viewModel.id);
    const route = routes.get(viewModel.routeId);
    if (!route) {
      blockers.push(blocker('AIH_UI_CASE_CONTRACT_INVALID', `UI ViewModel 引用未知 Route：${viewModel.id} / ${viewModel.routeId}`, location));
      continue;
    }
    const validInstances = new Map(routeInstances(model, route.id).map((item) => [item.instance.id, item]));
    const overridden = new Set();
    for (const override of viewModel.overrides || []) {
      if (overridden.has(override.pageInstanceId)) {
        blockers.push(blocker(
          'AIH_UI_CASE_CONTRACT_INVALID',
          `同一 UI ViewModel 不得重复覆盖 Page Instance：${viewModel.id} / ${override.pageInstanceId}`,
          location,
        ));
        continue;
      }
      overridden.add(override.pageInstanceId);
      const owner = validInstances.get(override.pageInstanceId);
      if (!owner) {
        blockers.push(blocker(
          'AIH_UI_CASE_CONTRACT_INVALID',
          `UI ViewModel Override 引用未知或跨 Route Page Instance：${viewModel.id} / ${override.pageInstanceId}`,
          location,
        ));
        continue;
      }
      const entry = matrix.get(override.stateMatrixEntryId);
      if (!entry || entry.componentContractId !== owner.contract.id || entry.classification !== 'legal') {
        blockers.push(blocker(
          'AIH_UI_CASE_CONTRACT_INVALID',
          `UI ViewModel Override 必须引用该 Component Contract 的合法 State Matrix Entry：${viewModel.id} / ${override.stateMatrixEntryId}`,
          location,
        ));
      }
    }
  }

  const caseIds = new Set();
  const effectiveCases = [];
  for (const uiCase of model.uiCases || []) {
    const location = `uiCases.${uiCase.id}`;
    if (caseIds.has(uiCase.id)) {
      blockers.push(blocker('AIH_UI_CASE_CONTRACT_INVALID', `UI Case ID 重复：${uiCase.id}`, location));
    }
    caseIds.add(uiCase.id);
    const viewModel = viewModels.get(uiCase.viewModelId);
    if (!viewModel) {
      blockers.push(blocker('AIH_UI_CASE_CONTRACT_INVALID', `UI Case 引用未知 UI ViewModel：${uiCase.id} / ${uiCase.viewModelId}`, location));
      continue;
    }
    for (const viewportId of uiCase.viewportIds || []) {
      if (!viewports.has(viewportId)) {
        blockers.push(blocker('AIH_UI_CASE_CONTRACT_INVALID', `UI Case 引用未知 Viewport：${uiCase.id} / ${viewportId}`, location));
      }
    }
    const overrides = new Map((viewModel.overrides || []).map((item) => [item.pageInstanceId, item]));
    const selections = routeInstances(model, viewModel.routeId).map(({ contract, instance }) => ({
      contract,
      instance,
      entry: selectedEntry(model, contract, overrides.get(instance.id)),
    }));
    effectiveCases.push({ uiCase, viewModel, selections });
  }

  for (const { contract, instance } of [...instanceOwners.values()]) {
    const relevant = effectiveCases.flatMap((item) => (
      item.selections
        .filter((selection) => selection.instance.id === instance.id)
        .map((selection) => selection.entry)
        .filter(Boolean)
    ));
    if (!relevant.some((entry) => entry.id === contract.defaultStateMatrixEntryId)) {
      blockers.push(blocker(
        'AIH_UI_CASE_COVERAGE_INCOMPLETE',
        `UI Case 必须覆盖 Page Instance 默认态：${instance.id} / ${contract.defaultStateMatrixEntryId}`,
        `uiCases.${instance.id}`,
      ));
    }
    for (const axis of (model.stateAxes || []).filter((item) => item.componentContractId === contract.id)) {
      for (const value of axis.values || []) {
        if (!relevant.some((entry) => entry.values?.[axis.id] === value.id)) {
          blockers.push(blocker(
            'AIH_UI_CASE_COVERAGE_INCOMPLETE',
            `UI Case 必须至少覆盖一次 State Axis Value：${instance.id} / ${axis.id} / ${value.id}`,
            `uiCases.${instance.id}`,
          ));
        }
      }
    }
  }

  blockers.push(...visualCaseBlockers(model, visualSpec));
  return {
    status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    policy: 'axis-value-coverage',
    counts: {
      viewModels: (model.uiViewModels || []).length,
      uiCases: (model.uiCases || []).length,
      pageInstances: instanceOwners.size,
    },
    blockers,
  };
}

function serialized(value) {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function operationsForEntry(model, contract, entry) {
  const mapping = (model.componentMappings || []).find((item) => item.id === contract.mappingId);
  return (model.stateAxes || [])
    .filter((axis) => axis.componentContractId === contract.id)
    .flatMap((axis) => {
      const selected = (axis.values || []).find((value) => value.id === entry.values?.[axis.id]);
      if (!selected) return [];
      const binding = axis.renderBinding || {};
      if (binding.kind === 'workflow-state') {
        return selected.stateId ? [{
          kind: 'workflow-state',
          axisId: axis.id,
          stateId: selected.stateId,
          ...(binding.name ? { name: binding.name } : {}),
        }] : [];
      }
      if (binding.kind === 'mapped-variant') {
        const property = mapping?.propertyMappings?.find((item) => item.kind === 'variant' && item.figmaProperty === axis.name);
        const mapped = property?.values?.find((item) => item.figmaValue === selected.value);
        if (!mapped) return [];
        return [
          ...(property.litProperty ? [{ kind: 'property', name: property.litProperty, value: mapped.litValue }] : []),
          ...(property.litAttribute ? [{ kind: 'attribute', name: property.litAttribute, value: mapped.litValue }] : []),
        ];
      }
      if (binding.kind === 'component-state' || binding.kind === 'lit-property') {
        return [{ kind: 'property', name: binding.name, value: selected.renderValue }];
      }
      if (binding.kind === 'lit-attribute') {
        const attribute = (contract.attributes || []).find((item) => item.name === binding.name);
        const property = (contract.properties || []).find((item) => item.name === attribute?.propertyName);
        return [{
          kind: 'attribute',
          name: binding.name,
          value: selected.renderValue,
          valueType: property?.type || 'string',
        }];
      }
      if (binding.kind === 'slot-text') {
        return [{ kind: 'slot', name: binding.name, value: serialized(selected.renderValue), axisId: axis.id }];
      }
      return [];
    });
}

export function compileUiCaseRuntime(model) {
  const analysis = analyzeUiCaseCoverage(model);
  if (analysis.blockers.some((item) => item.code === 'AIH_UI_CASE_CONTRACT_INVALID')) {
    return { status: 'BLOCKED', blockers: analysis.blockers, cases: [] };
  }
  const viewModels = byId(model.uiViewModels);
  const cases = (model.uiCases || []).map((uiCase) => {
    const viewModel = viewModels.get(uiCase.viewModelId);
    const overrides = new Map((viewModel.overrides || []).map((item) => [item.pageInstanceId, item]));
    const route = (model.routes || []).find((item) => item.id === viewModel.routeId);
    return {
      id: uiCase.id,
      name: uiCase.name,
      viewModelId: viewModel.id,
      routeId: route.id,
      routePath: route.path,
      viewportIds: [...uiCase.viewportIds],
      components: routeInstances(model, route.id).map(({ contract, instance }) => {
        const entry = selectedEntry(model, contract, overrides.get(instance.id));
        return {
          pageInstanceId: instance.id,
          componentContractId: contract.id,
          stateMatrixEntryId: entry.id,
          selector: `[data-component-instance-id="${instance.id}"]`,
          operations: operationsForEntry(model, contract, entry),
        };
      }),
    };
  });
  return { status: 'PASS', blockers: [], cases };
}
