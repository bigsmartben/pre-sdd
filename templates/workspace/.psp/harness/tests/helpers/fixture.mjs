import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readFile, writeFile } from 'node:fs/promises';

export const repositoryRoot = resolve(process.env.PSP_REPOSITORY_ROOT || resolve(import.meta.dirname, '../../../..'));
export const runtimeRoot = resolve(process.env.PRE_SDD_RUNTIME_WORKSPACE || repositoryRoot);
const repositoryProject = parseYaml(await readFile(resolve(repositoryRoot, 'psp.project.yaml'), 'utf8'));
export const project = structuredClone(repositoryProject);
for (const stage of Object.values(project.stages)) {
  if (stage.status !== 'unavailable') stage.status = 'uninitialized';
}
export const manifest = JSON.parse(await readFile(resolve(repositoryRoot, repositoryProject.harness.manifest), 'utf8'));
const workspaceMarker = manifest.scopes.find((scope) => scope.selector?.type === 'workspace')?.selector?.marker;
const roots = [];

export async function temporaryRepository() {
  const target = await mkdtemp(join(tmpdir(), 'psp-harness-'));
  roots.push(target);
  await mkdir(resolve(target, '.psp'), { recursive: true });
  for (const item of [
    'AGENTS.md',
    'README.md',
    'package.json',
    'psp.project.yaml',
    '.psp/harness',
    '.codex',
    '.agents',
  ]) {
    await cp(resolve(repositoryRoot, item), resolve(target, item), { recursive: true });
  }
  await writeFile(resolve(target, 'psp.project.yaml'), stringifyYaml(project), 'utf8');
  for (const stage of Object.values(project.stages)) {
    if (stage.status === 'unavailable') continue;
    await mkdir(resolve(target, stage.root), { recursive: true });
    await writeFile(resolve(target, stage.root, workspaceMarker), '', 'utf8');
  }
  return target;
}

export async function cleanupTemporaryRepositories() {
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
}

export function runScript(script, fixtureRoot, args = []) {
  const result = spawnSync(process.execPath, [resolve(runtimeRoot, script), ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PSP_REPOSITORY_ROOT: fixtureRoot,
      AI_HARNESS_ROOT: fixtureRoot,
      PRE_SDD_RUNTIME_WORKSPACE: runtimeRoot,
    },
  });
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    output = { status: 'INVALID_OUTPUT', stdout: result.stdout, stderr: result.stderr };
  }
  return { exitCode: result.status, output, stderr: result.stderr };
}

export function codes(result) {
  return new Set((result.output.blockers || []).map((item) => item.code));
}
