import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { repositoryFile } from './repository.mjs';

function issue(message, location) {
  return { code: 'AIH_SOURCE_INTEGRITY_FAILED', message, location };
}

function isFigmaLocation(value) {
  try {
    const url = new URL(value);
    return (url.hostname === 'figma.com' || url.hostname.endsWith('.figma.com'))
      && /^\/(design|file|proto)\//.test(url.pathname);
  } catch {
    return false;
  }
}

export async function inspectDesignSourceEvidence(root, stage, sources) {
  const issues = [];
  const areaRoot = stage.areas?.['html-mock']?.root;
  for (const source of sources || []) {
    const location = 'ui-spec.designSources.' + source.id;
    if (source.status !== 'available') continue;
    if (source.type === 'figma' && (!isFigmaLocation(source.location) || !source.nodeId)) {
      issues.push(issue('Figma 来源必须包含合法链接与 Node ID：' + source.id, location));
    }
    if (!source.evidence) {
      issues.push(issue('可用设计来源缺少本地证据：' + source.id, location + '.evidence'));
      continue;
    }
    if (!areaRoot || !source.evidence.path.startsWith(areaRoot + '/')) {
      issues.push(issue('设计来源证据必须位于绑定的 HTML Mock area：' + source.evidence.path, location + '.evidence.path'));
      continue;
    }
    try {
      const content = await readFile(repositoryFile(root, stage.root + '/' + source.evidence.path));
      const actual = createHash('sha256').update(content).digest('hex');
      if (actual !== source.evidence.sha256) {
        issues.push(issue('设计来源证据哈希不匹配：' + source.id, location + '.evidence.sha256'));
      }
    } catch (error) {
      issues.push(issue('设计来源证据不可读取：' + source.evidence.path + '；' + error.message, location + '.evidence.path'));
    }
  }
  return issues;
}
