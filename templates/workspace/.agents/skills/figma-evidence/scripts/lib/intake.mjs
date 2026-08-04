import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { sha256, stableJson, validateWithSchema } from '../../../visual-spec/scripts/lib/visual-spec.mjs';

export const INTAKE_SCHEMA = '.agents/skills/figma-evidence/schemas/private/figma-intake.schema.json';

export function inside(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

export async function loadPrivateIntake(root, path) {
  if (!path || !inside(tmpdir(), path)) {
    throw Object.assign(new Error('Figma 私有 Intake 必须位于操作系统临时目录。'), { code: 'FGC_INTAKE_PATH_INVALID' });
  }
  const intake = JSON.parse(await readFile(resolve(path), 'utf8'));
  const schemaErrors = await validateWithSchema(root, INTAKE_SCHEMA, intake);
  if (schemaErrors.length) {
    throw Object.assign(new Error(`Figma 私有 Intake 不符合 Schema：${schemaErrors.map((item) => item.message).join('; ')}`), { code: 'FGC_INTAKE_INVALID' });
  }
  return intake;
}

export function deriveSource(source) {
  const nodes = [...source.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const nodeDigests = new Map(nodes.map((node) => [node.nodeId, sha256(Buffer.from(stableJson(node.payload)))]));
  return {
    source: {
      provider: source.provider,
      fileId: source.fileId,
      locator: source.locator,
      scope: source.scope,
      revision: source.revision,
      digest: sha256(Buffer.from(stableJson({ payload: source.payload, nodes }))),
      capturedAt: source.capturedAt,
    },
    nodes: new Map(nodes.map((node) => [node.nodeId, node])),
    nodeDigests,
  };
}

export function nodeInScope(source, node) {
  if (!node) return false;
  if (source.scope.kind === 'file') return source.scope.refs.length === 1 && source.scope.refs[0] === source.fileId;
  if (source.scope.kind === 'page') return source.scope.refs.includes(node.pageId);
  return source.scope.refs.includes(node.nodeId);
}

export function currentFreshnessPath(args = process.argv) {
  const index = args.indexOf('--figma-freshness');
  return (index >= 0 ? args[index + 1] : null) || process.env.PSP_FIGMA_FRESHNESS_PATH || null;
}
