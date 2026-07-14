import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export async function loadWorkspace(workspaceRoot) {
  const root = resolve(workspaceRoot);
  const project = parseYaml(await readFile(resolve(root, 'psp.project.yaml'), 'utf8'));
  if (!project?.harness?.manifest) {
    throw Object.assign(new Error('psp.project.yaml 未声明 harness.manifest。'), {
      code: 'AIH_PROJECT_BINDING_INVALID',
    });
  }
  const manifest = JSON.parse(await readFile(resolve(root, project.harness.manifest), 'utf8'));
  return { root, project, manifest };
}

export function boundArea(project, areaId) {
  const matches = [];
  for (const [stageId, stage] of Object.entries(project.stages || {})) {
    const area = stage.areas?.[areaId];
    if (area) matches.push({ stageId, stage, area, path: stage.root + '/' + area.root });
  }
  if (matches.length !== 1) {
    throw Object.assign(new Error('area 必须唯一绑定：' + areaId), {
      code: 'AIH_PROJECT_BINDING_INVALID',
    });
  }
  return matches[0];
}
