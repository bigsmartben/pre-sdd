import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { executeRegisteredCommand } from '../../../../.psp/harness/scripts/lib/execute-command.mjs';
import {
  loadProjectAndManifest,
  repositoryFile,
} from '../../../../.psp/harness/scripts/lib/repository.mjs';
import { stageIsReadable } from '../../../../.psp/harness/scripts/lib/stage-state.mjs';

const VALIDATION_STATES = new Set(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);

function evidence(code, message, location, source = 'project-consistency') {
  return { code, message, ...(location ? { location } : {}), source };
}

async function validateReport(root, manifest, report) {
  const schema = JSON.parse(await readFile(repositoryFile(root, manifest.schemas.consistencyReport), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  if (validate(report)) return report;
  const details = (validate.errors || []).map((error) => (error.instancePath || '/') + ' ' + error.message).join('; ');
  throw Object.assign(new Error('Consistency Report 不符合登记 Schema：' + details), { code: 'AIH_SCHEMA_INVALID' });
}

function parseArguments(argv) {
  const scopes = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--scope') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--scope 缺少 DAG Scope id。');
      scopes.push(...value.split(',').filter(Boolean));
      index += 1;
      continue;
    }
    if (argument.startsWith('--scope=')) {
      scopes.push(...argument.slice('--scope='.length).split(',').filter(Boolean));
      continue;
    }
    throw new Error('未知参数：' + argument);
  }
  return { json, scopes: [...new Set(scopes)] };
}

function analyzeDag(manifest) {
  const blockers = [];
  const nodes = new Map();
  const nodeOrder = [];
  for (const node of manifest.projectDag?.nodes || []) {
    if (nodes.has(node.id)) {
      blockers.push(evidence('AIH_DAG_NODE_UNKNOWN', '项目 DAG 节点 id 重复：' + node.id, node.id));
      continue;
    }
    nodes.set(node.id, node);
    nodeOrder.push(node.id);
  }

  const outgoing = new Map(nodeOrder.map((id) => [id, []]));
  const incoming = new Map(nodeOrder.map((id) => [id, []]));
  const indegree = new Map(nodeOrder.map((id) => [id, 0]));
  const identities = new Set();
  const dependencyEdges = [];
  for (const edge of manifest.projectDag?.edges || []) {
    const location = edge.from + '->' + edge.to + ':' + edge.type;
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      blockers.push(evidence('AIH_DAG_NODE_UNKNOWN', '项目 DAG 边引用未知节点：' + location, location));
      continue;
    }
    if (identities.has(location)) {
      blockers.push(evidence('AIH_DAG_EDGE_CONFLICT', '项目 DAG 边身份重复：' + location, location));
      continue;
    }
    identities.add(location);
    if (edge.type === 'dependency') {
      dependencyEdges.push(edge);
      outgoing.get(edge.from).push(edge);
      incoming.get(edge.to).push(edge);
      indegree.set(edge.to, indegree.get(edge.to) + 1);
    }
  }

  const ready = nodeOrder.filter((id) => indegree.get(id) === 0);
  const topologicalOrder = [];
  while (ready.length > 0) {
    const nodeId = ready.shift();
    topologicalOrder.push(nodeId);
    for (const edge of outgoing.get(nodeId)) {
      indegree.set(edge.to, indegree.get(edge.to) - 1);
      if (indegree.get(edge.to) === 0) ready.push(edge.to);
    }
  }
  if (topologicalOrder.length !== nodes.size) {
    blockers.push(evidence('AIH_DAG_CYCLE', '项目 DAG 存在依赖环，无法形成拓扑检查顺序。', 'projectDag'));
    for (const nodeId of nodeOrder) {
      if (!topologicalOrder.includes(nodeId)) topologicalOrder.push(nodeId);
    }
  }
  return { blockers, nodes, edges: dependencyEdges, outgoing, incoming, topologicalOrder };
}

function downstreamClosure(dag, requested) {
  if (requested.length === 0) return new Set(dag.topologicalOrder);
  const selected = new Set();
  const queue = [...requested];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (selected.has(nodeId) || !dag.nodes.has(nodeId)) continue;
    selected.add(nodeId);
    for (const edge of dag.outgoing.get(nodeId) || []) queue.push(edge.to);
  }
  return selected;
}

function hasDagPath(dag, from, to) {
  const visited = new Set();
  const queue = [from];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === to) return true;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const edge of dag.outgoing.get(nodeId) || []) queue.push(edge.to);
  }
  return false;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function snapshotDirectory(root, relative, output) {
  let entries;
  try {
    entries = await readdir(repositoryFile(root, relative), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) await snapshotDirectory(root, path, output);
    else if (entry.isFile()) output.set(path, sha256(await readFile(repositoryFile(root, path))));
  }
}

async function snapshotWorkspaceArtifacts(root, project) {
  const output = new Map();
  for (const path of ['psp.project.yaml', ...Object.values(project.stages || {}).map((stage) => stage.root)]) {
    try {
      const content = await readFile(repositoryFile(root, path));
      output.set(path, sha256(content));
    } catch (error) {
      if (error.code === 'EISDIR' || error.code === 'EPERM') await snapshotDirectory(root, path, output);
      else if (error.code !== 'ENOENT') throw error;
    }
  }
  return output;
}

function changedSnapshotPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

function validatorEvidence(execution) {
  let parsed;
  try {
    parsed = execution.stdout ? JSON.parse(execution.stdout) : null;
  } catch {
    parsed = null;
  }
  const status = VALIDATION_STATES.has(parsed?.status)
    ? parsed.status
    : execution.status;
  const blockers = Array.isArray(parsed?.blockers) && parsed.blockers.length > 0
    ? parsed.blockers.map((item) => ({ ...item, source: execution.id }))
    : (execution.blockers || []).map((code) => evidence(code, '领域 Validator 返回失败。', execution.id, execution.id));
  return {
    validator: execution.id,
    command: execution.command,
    status,
    blockers,
    warnings: parsed?.warnings || [],
  };
}

function combinedState(items) {
  if (items.some((item) => item.status === 'FAIL')) return 'FAIL';
  if (items.some((item) => item.status === 'BLOCKED')) return 'BLOCKED';
  if (items.some((item) => item.status === 'NOT_RUN')) return 'NOT_RUN';
  return 'PASS';
}

async function contractFacts(root, manifest, scopes, node) {
  if (node.kind !== 'artifact') return [];
  const artifactIds = scopes.get(node.id)?.selector?.artifacts || [];
  const registry = new Map((manifest.artifactRegistry || []).map((item) => [item.id, item]));
  const facts = [];
  for (const artifactId of artifactIds) {
    const registered = registry.get(artifactId);
    if (!registered) continue;
    try {
      const contract = parseYaml(await readFile(repositoryFile(root, registered.contract), 'utf8'));
      facts.push({
        artifact: artifactId,
        contract: registered.contract,
        inputArtifacts: contract?.spec?.inputs?.artifacts || [],
      });
    } catch (error) {
      facts.push({
        artifact: artifactId,
        contract: registered.contract,
        inputArtifacts: [],
        blocker: evidence('AIH_CONTRACT_INVALID', error.message, registered.contract, 'artifact-contract'),
      });
    }
  }
  return facts;
}

function optionalActionsFor(blockers, nodeId) {
  if (blockers.length === 0) return [];
  return [
    '检查 ' + nodeId + ' 的证据位置，并由用户另行决定应修改上游事实还是当前节点。',
    '如需修复，显式调用拥有该产物的领域 Skill；本检查不会执行修复。',
    '只有用户另行明确请求且 readiness 通过时，才可执行对应 handoff。',
  ];
}

export async function checkProjectConsistency(root, options = {}) {
  const { project, manifest } = await loadProjectAndManifest(root);
  const requested = [...new Set(options.scopes || [])];
  const dag = analyzeDag(manifest);
  const topLevelBlockers = [...dag.blockers];
  for (const nodeId of requested) {
    if (!dag.nodes.has(nodeId)) {
      topLevelBlockers.push(evidence('AIH_DAG_NODE_UNKNOWN', '请求的 Scope 不是项目 DAG 节点：' + nodeId, nodeId));
    }
  }

  const selected = downstreamClosure(dag, requested);
  const selectedOrder = dag.topologicalOrder.filter((nodeId) => selected.has(nodeId));
  const relevantEdges = dag.edges.filter((edge) => selected.has(edge.from) || selected.has(edge.to));
  const scopes = new Map((manifest.scopes || []).map((scope) => [scope.id, scope]));
  const commands = new Map((manifest.commands || []).map((command) => [command.id, command]));
  const contractsByNode = new Map();
  for (const nodeId of selectedOrder) {
    contractsByNode.set(nodeId, await contractFacts(root, manifest, scopes, dag.nodes.get(nodeId)));
  }

  const before = await snapshotWorkspaceArtifacts(root, project);
  const executionCache = new Map();
  const nodeResults = [];
  for (const nodeId of selectedOrder) {
    const node = dag.nodes.get(nodeId);
    const stage = project.stages?.[node.stage];
    const scope = scopes.get(nodeId);
    const nodeBlockers = [];
    const validations = [];
    for (const contract of contractsByNode.get(nodeId)) {
      if (contract.blocker) nodeBlockers.push(contract.blocker);
    }
    if (!scope || !stage) {
      nodeBlockers.push(evidence('AIH_DAG_NODE_UNKNOWN', 'DAG 节点未绑定有效 Scope 或 Stage。', nodeId));
    } else if (!stageIsReadable(stage)) {
      const code = stage.status === 'uninitialized' ? 'AIH_STAGE_UNINITIALIZED' : (stage.blockerCode || 'AIH_STAGE_UNINITIALIZED');
      validations.push({
        validator: null,
        command: null,
        status: stage.status === 'uninitialized' ? 'NOT_RUN' : 'BLOCKED',
        blockers: [evidence(code, '阶段状态为 ' + stage.status + '，领域 Validator 未运行。', node.stage)],
        warnings: [],
      });
    } else {
      for (const validatorId of node.validators || []) {
        const command = commands.get(validatorId);
        if (!command || command.domain !== scope.domain || command.executor?.kind !== 'module') {
          validations.push({
            validator: validatorId,
            command: null,
            status: 'BLOCKED',
            blockers: [evidence('AIH_COMMAND_INVALID', 'DAG 节点引用无效领域 Validator：' + validatorId, nodeId)],
            warnings: [],
          });
          continue;
        }
        if (!executionCache.has(validatorId)) {
          executionCache.set(validatorId, validatorEvidence(executeRegisteredCommand(root, command, {
            arguments: ['--json'],
          })));
        }
        validations.push(executionCache.get(validatorId));
      }
    }
    const allBlockers = [...nodeBlockers, ...validations.flatMap((item) => item.blockers)];
    const status = nodeBlockers.length > 0 ? 'BLOCKED' : combinedState(validations);
    nodeResults.push({
      id: nodeId,
      kind: node.kind,
      stage: node.stage,
      status,
      validators: validations,
      contracts: contractsByNode.get(nodeId),
      evidence: allBlockers,
      impact: (dag.outgoing.get(nodeId) || []).map((edge) => edge.to),
      optionalActions: optionalActionsFor(allBlockers, nodeId),
    });
  }

  const nodeResultMap = new Map(nodeResults.map((item) => [item.id, item]));
  const edgeResults = [];
  for (const edge of relevantEdges) {
    const target = nodeResultMap.get(edge.to);
    const source = nodeResultMap.get(edge.from);
    const edgeEvidence = [];
    const targetContracts = contractsByNode.get(edge.to) || [];
    const sourceArtifacts = scopes.get(edge.from)?.selector?.artifacts || [];
    const contractMatches = targetContracts.flatMap((contract) => contract.inputArtifacts)
      .filter((artifactId) => sourceArtifacts.includes(artifactId));
    if (target) edgeEvidence.push(...target.evidence);
    let status = target?.status || source?.status || 'NOT_RUN';
    if (status === 'FAIL') status = 'BLOCKED';
    edgeResults.push({
      from: edge.from,
      to: edge.to,
      type: edge.type,
      status,
      evidence: edgeEvidence,
      contractInputs: [...new Set(contractMatches)],
      impact: [edge.to, ...(dag.outgoing.get(edge.to) || []).map((item) => item.to)],
      optionalActions: optionalActionsFor(edgeEvidence, edge.from + '->' + edge.to),
    });
  }

  for (const nodeId of selectedOrder) {
    for (const contract of contractsByNode.get(nodeId) || []) {
      for (const inputArtifact of contract.inputArtifacts) {
        const sourceNode = [...dag.nodes.values()].find((candidate) =>
          (scopes.get(candidate.id)?.selector?.artifacts || []).includes(inputArtifact),
        );
        if (sourceNode && !hasDagPath(dag, sourceNode.id, nodeId)) {
          const missing = evidence(
            'AIH_DAG_EDGE_CONFLICT',
            'Artifact Contract 输入缺少对应 DAG 路径：' + sourceNode.id + '->' + nodeId,
            contract.contract,
            'artifact-contract',
          );
          topLevelBlockers.push(missing);
          nodeResultMap.get(nodeId)?.evidence.push(missing);
        }
      }
    }
  }

  const after = await snapshotWorkspaceArtifacts(root, project);
  const changedPaths = changedSnapshotPaths(before, after);
  if (changedPaths.length > 0) {
    topLevelBlockers.push(evidence(
      'AIH_VALIDATION_FAILED',
      '只读检查前后检测到工作区产物变化：' + changedPaths.join(', '),
      'sideEffects',
    ));
  }

  const residuals = [
    ...topLevelBlockers,
    ...nodeResults.flatMap((node) => node.evidence.map((item) => ({ ...item, node: node.id }))),
  ];
  const deduplicatedResiduals = residuals.filter((item, index, items) =>
    items.findIndex((candidate) =>
      candidate.code === item.code
      && candidate.location === item.location
      && candidate.message === item.message
      && candidate.node === item.node,
    ) === index,
  );
  const validation = [...executionCache.values()].map((item) => ({
    id: item.validator,
    command: item.command,
    status: item.status,
    blockers: item.blockers,
  }));
  const blocked = topLevelBlockers.length > 0
    || nodeResults.some((node) => ['FAIL', 'BLOCKED'].includes(node.status))
    || edgeResults.some((edge) => edge.status === 'BLOCKED');

  return validateReport(root, manifest, {
    protocol: manifest.standard?.protocol,
    status: blocked ? 'BLOCKED' : 'PASS',
    mode: requested.length > 0 ? 'scoped' : 'full-project',
    scope: {
      requested,
      selected: selectedOrder,
      topologicalOrder: selectedOrder,
    },
    changes: [],
    nodes: nodeResults,
    edges: edgeResults,
    impact: {
      requested: requested.length > 0 ? requested : ['full-project'],
      affectedNodes: selectedOrder,
      affectedEdges: relevantEdges.map((edge) => edge.from + '->' + edge.to),
    },
    validation,
    residuals: deduplicatedResiduals,
    optionalActions: blocked
      ? [
          '根据证据选择需要处理的上游或下游节点，并另行明确授权修改。',
          '修改后由用户再次显式调用 $project-consistency 复查。',
        ]
      : [],
    sideEffects: {
      status: changedPaths.length === 0 ? 'PASS' : 'FAIL',
      changedPaths,
    },
    handoff: 'NOT_RUN',
    initialization: 'NOT_RUN',
    dependencies: edgeResults,
    diagnostics: deduplicatedResiduals,
    acceptedRisks: [],
    suggestedOperations: blocked
      ? ['显式调用拥有对应 Artifact 的领域 Operation 修复，再重新运行 project-consistency。']
      : [],
  });
}

async function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error('[AIH_PATH_INVALID] ' + error.message);
    process.exitCode = 1;
    return;
  }
  const root = resolve(process.env.PSP_REPOSITORY_ROOT || process.env.AI_HARNESS_ROOT || process.cwd());
  let result;
  try {
    result = await checkProjectConsistency(root, { scopes: args.scopes });
  } catch (error) {
    result = {
      protocol: 'pre-sdd-harness/v3',
      status: 'BLOCKED',
      scope: { requested: args.scopes, selected: [], topologicalOrder: [] },
      changes: [],
      validation: [],
      residuals: [evidence(error.code || 'AIH_VALIDATION_FAILED', error.message, 'project-consistency')],
      sideEffects: { status: 'NOT_RUN', changedPaths: [] },
      handoff: 'NOT_RUN',
      initialization: 'NOT_RUN',
      dependencies: [],
      diagnostics: [evidence(error.code || 'AIH_VALIDATION_FAILED', error.message, 'project-consistency')],
      acceptedRisks: [],
      suggestedOperations: [],
    };
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'PASS') console.log('[PASS] 项目一致性只读检查通过。');
  else {
    console.error('[BLOCKED] 项目一致性检查发现 ' + result.residuals.length + ' 项证据。');
    for (const item of result.residuals) {
      console.error('[' + item.code + '] (' + (item.location || 'unknown') + ') ' + item.message);
    }
  }
  if (result.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
