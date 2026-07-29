import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readFile, writeFile } from 'node:fs/promises';

export const repositoryRoot = resolve(process.env.PSP_REPOSITORY_ROOT || resolve(import.meta.dirname, '../../../../..'));
const repositoryProject = parseYaml(await readFile(resolve(repositoryRoot, 'psp.project.yaml'), 'utf8'));
export const project = structuredClone(repositoryProject);
for (const stage of Object.values(project.stages)) {
  if (stage.status !== 'unavailable') stage.status = 'uninitialized';
}
const roots = [];

export async function temporaryRepository() {
  const target = await mkdtemp(join(tmpdir(), 'psp-workspace-'));
  roots.push(target);
  await mkdir(resolve(target, '.psp'), { recursive: true });
  for (const item of [
    'AGENTS.md',
    'README.md',
    'package.json',
    'psp.project.yaml',
    '.psp/harness',
    '.agents',
  ]) {
    await cp(resolve(repositoryRoot, item), resolve(target, item), { recursive: true });
  }
  await writeFile(resolve(target, 'psp.project.yaml'), stringifyYaml(project), 'utf8');
  await symlink(
    resolve(import.meta.dirname, '../../../../../../../node_modules'),
    resolve(target, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  for (const stage of Object.values(project.stages)) {
    if (stage.status === 'unavailable') continue;
    await mkdir(resolve(target, stage.root), { recursive: true });
    await writeFile(resolve(target, stage.root, '.gitkeep'), '', 'utf8');
  }
  return target;
}

export async function cleanupTemporaryRepositories() {
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
}

export function runScript(script, fixtureRoot, args = [], options = {}) {
  const result = spawnSync(process.execPath, [resolve(repositoryRoot, script), ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      ...(options.environment || {}),
      PSP_REPOSITORY_ROOT: fixtureRoot,
      NODE_ENV: 'test',
    },
  });
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    output = {
      status: 'INVALID_OUTPUT',
      stdoutLength: result.stdout?.length || 0,
      stdoutTail: result.stdout?.slice(-256) || '',
      ...((result.stdout?.length || 0) <= 1024 * 1024 ? { stdout: result.stdout } : {}),
      stderr: result.stderr,
      spawnError: result.error ? { code: result.error.code, message: result.error.message } : null,
    };
  }
  return { exitCode: result.status, output, stderr: result.stderr };
}

export function codes(result) {
  return new Set((result.output.blockers || []).map((item) => item.code));
}
