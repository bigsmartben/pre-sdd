function selectedValue(axis, entry) {
  return axis.values.find((value) => value.id === entry.values[axis.id]);
}

function comparable(value) {
  return JSON.stringify(value);
}

function propertyValue(property, value) {
  if (!property || property.type === 'string') return String(value);
  if (property.type === 'boolean') return value === true || value === 'true' || value === '';
  if (property.type === 'number') return Number(value);
  if (property.type === 'object') {
    try { return typeof value === 'string' ? JSON.parse(value) : value; }
    catch { return value; }
  }
  return value;
}

function serialized(value) {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function settle(host) {
  await host.evaluate(async (node) => {
    if (node.updateComplete && typeof node.updateComplete.then === 'function') await node.updateComplete;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function visibleComposedText(host) {
  return host.evaluate((node) => {
    const chunks = [];
    const visible = (element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && element.getClientRects().length > 0;
    };
    const visit = (current) => {
      if (current.nodeType === Node.TEXT_NODE) {
        if (current.parentElement && visible(current.parentElement)) chunks.push(current.textContent || '');
        return;
      }
      if (current instanceof Element && !visible(current)) return;
      if (current instanceof Element && current.shadowRoot) visit(current.shadowRoot);
      for (const child of current.childNodes) visit(child);
    };
    visit(node);
    return chunks.join(' ').replace(/\s+/g, ' ').trim();
  });
}

export async function verifyMatrixMount({
  surface,
  model,
  contract,
  entry,
  mapping,
  block,
  code,
  location,
}) {
  const preview = surface.locator(
    '[data-component-preview][data-component-contract-id="' + contract.id + '"][data-state-matrix-id="' + entry.id + '"]',
  );
  try {
    await preview.first().waitFor({ state: 'attached', timeout: 60000 });
  } catch {
    block(code, 'Matrix Mount 缺少唯一的隔离预览根：' + contract.id + ' / ' + entry.id, location);
    return null;
  }
  if (await preview.count() !== 1) {
    block(code, 'Matrix Mount 缺少唯一的隔离预览根：' + contract.id + ' / ' + entry.id, location);
    return null;
  }

  const declaredTags = [...new Set(model.componentContracts.map((item) => item.litTagName))];
  const declaredHosts = preview.locator(declaredTags.join(','));
  const host = preview.locator(contract.litTagName);
  if (await declaredHosts.count() !== 1 || await host.count() !== 1) {
    block(code, 'Matrix Mount 每次必须且只能挂载一个声明的 Lit Tag：' + contract.id + ' / ' + entry.id, location);
    return null;
  }
  if (
    await host.getAttribute('data-component-id') !== contract.componentId
    || await host.getAttribute('data-component-contract-id') !== contract.id
    || await host.getAttribute('data-state-matrix-id') !== entry.id
  ) {
    block(code, '隔离 Lit Host 的 Component、Contract 或 Matrix 身份不匹配：' + entry.id, location);
  }
  await settle(host);

  const axes = model.stateAxes.filter((axis) => axis.componentContractId === contract.id);
  for (const axis of axes) {
    const selected = selectedValue(axis, entry);
    if (!selected) {
      block(code, 'Matrix Mount 无法解析轴值：' + entry.id + ' / ' + axis.id, location);
      continue;
    }
    if (axis.renderBinding.kind === 'mapped-variant') {
      const property = mapping?.propertyMappings.find(
        (item) => item.kind === 'variant' && item.figmaProperty === axis.name,
      );
      const expected = property?.values.find((item) => item.figmaValue === selected.value)?.litValue;
      const observed = property?.litAttribute ? await host.getAttribute(property.litAttribute) : null;
      const contractProperty = contract.properties.find((item) => item.name === property?.litProperty);
      const observedProperty = property?.litProperty
        ? await host.evaluate((node, name) => node[name], property.litProperty)
        : undefined;
      const expectedProperty = expected === undefined ? undefined : propertyValue(contractProperty, expected);
      if (
        !property?.litAttribute
        || !property?.litProperty
        || expected === undefined
        || observed !== expected
        || comparable(observedProperty) !== comparable(expectedProperty)
      ) {
        block(code, 'Variant 未通过声明的 Lit Attribute 实际渲染：' + entry.id + ' / ' + axis.name, location);
      }
      continue;
    }
    if (axis.renderBinding.kind === 'component-state') {
      const observedProperty = await host.evaluate((node, name) => node[name], axis.renderBinding.name);
      if (comparable(observedProperty) !== comparable(selected.renderValue)) {
        block(code, 'Component State 未通过声明的 Lit Property 投影：' + entry.id + ' / ' + axis.renderBinding.name, location);
      }
      const selectedState = selected.stateId;
      const selectedTargets = host.locator('[data-component-state="' + selectedState + '"]');
      const visibleSelected = await selectedTargets.evaluateAll((nodes) => nodes.some((node) => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
      }));
      if (!selectedState || !visibleSelected) {
        block(code, '隔离挂载未呈现选中的 Component State：' + entry.id + ' / ' + (selectedState || 'missing'), location);
      }
      for (const other of axis.values.filter((value) => value.id !== selected.id && value.stateId)) {
        const otherVisible = await host.locator('[data-component-state="' + other.stateId + '"]').evaluateAll((nodes) => nodes.some((node) => {
          const style = getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
        }));
        if (otherVisible) {
          block(code, '隔离挂载同时呈现同轴互斥 Component State：' + entry.id + ' / ' + other.stateId, location);
        }
      }
      continue;
    }
    if (axis.renderBinding.kind === 'workflow-state') {
      const marker = preview.locator(
        '[data-state-axis-id="' + axis.id + '"][data-state-id="' + selected.stateId + '"]',
      );
      if (!selected.stateId || await marker.count() !== 1 || !await marker.isVisible()) {
        block(code, '隔离挂载未呈现选中的 Workflow State：' + entry.id + ' / ' + axis.id, location);
      }
      continue;
    }
    if (axis.renderBinding.kind === 'lit-property') {
      const observed = await host.evaluate((node, name) => node[name], axis.renderBinding.name);
      if (comparable(observed) !== comparable(selected.renderValue)) {
        block(code, (axis.kind === 'variant' ? 'Variant' : 'Content Override') + ' 的 Lit Property 未实际渲染：' + entry.id + ' / ' + axis.renderBinding.name, location);
      } else if (
        axis.kind === 'content-override'
        &&
        ['string', 'number'].includes(typeof selected.renderValue)
        && !(await visibleComposedText(host)).includes(String(selected.renderValue))
      ) {
        block(code, 'Content Override 的 Lit Property 未形成可见内容：' + entry.id + ' / ' + axis.renderBinding.name, location);
      }
      continue;
    }
    if (axis.renderBinding.kind === 'lit-attribute') {
      const observed = await host.getAttribute(axis.renderBinding.name);
      const attribute = contract.attributes.find((item) => item.name === axis.renderBinding.name);
      const contractProperty = contract.properties.find((item) => item.name === attribute?.propertyName);
      const expected = contractProperty?.type === 'boolean'
        ? selected.renderValue === true ? '' : null
        : serialized(selected.renderValue);
      const observedProperty = attribute
        ? await host.evaluate((node, name) => node[name], attribute.propertyName)
        : undefined;
      const expectedProperty = propertyValue(contractProperty, selected.renderValue);
      if (
        observed !== expected
        || !attribute
        || comparable(observedProperty) !== comparable(expectedProperty)
      ) {
        block(code, (axis.kind === 'variant' ? 'Variant' : 'Content Override') + ' 的 Lit Attribute 未实际渲染：' + entry.id + ' / ' + axis.renderBinding.name, location);
      } else if (
        axis.kind === 'content-override'
        &&
        ['string', 'number'].includes(typeof selected.renderValue)
        && !(await visibleComposedText(host)).includes(String(selected.renderValue))
      ) {
        block(code, 'Content Override 的 Lit Attribute 未形成可见内容：' + entry.id + ' / ' + axis.renderBinding.name, location);
      }
      continue;
    }
    if (axis.renderBinding.kind === 'slot-text') {
      const slot = host.locator('[slot="' + axis.renderBinding.name + '"][data-content-axis-id="' + axis.id + '"]');
      const expected = serialized(selected.renderValue);
      const assignedAndVisible = await slot.count() === 1
        ? await slot.evaluate((node, slotName) => {
          const assigned = node.assignedSlot;
          if (!assigned || assigned.name !== slotName) return false;
          const nodeStyle = getComputedStyle(node);
          const slotStyle = getComputedStyle(assigned);
          return nodeStyle.display !== 'none'
            && nodeStyle.visibility !== 'hidden'
            && slotStyle.display !== 'none'
            && slotStyle.visibility !== 'hidden'
            && node.getClientRects().length > 0;
        }, axis.renderBinding.name)
        : false;
      if (await slot.count() !== 1 || (await slot.textContent()) !== expected || !assignedAndVisible) {
        block(code, 'Content Override 的 Slot 文本未实际渲染：' + entry.id + ' / ' + axis.renderBinding.name, location);
      }
    }
  }
  return host;
}
