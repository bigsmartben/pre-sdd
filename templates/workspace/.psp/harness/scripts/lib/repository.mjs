import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const WINDOWS_ABSOLUTE = /^[A-Za-z]:/;
const GLOB_CHARACTERS = ['*', '!', '?', '[', ']', '{', '}'];

function hasGlobMagic(value) {
  return GLOB_CHARACTERS.some((character) => value.includes(character));
}

export function repositoryRootFrom(metaDirectory, environment = process.env) {
  return resolve(
    environment.PSP_REPOSITORY_ROOT
      || environment.AI_HARNESS_ROOT
      || resolve(metaDirectory, '../../..'),
  );
}

export function normalizeRepositoryPath(input, root, options = {}) {
  const allowGlob = options.allowGlob === true;
  if (typeof input !== 'string' || input.length === 0) {
    return { error: 'AIH_PATH_INVALID', message: '路径必须是非空字符串。' };
  }
  if (
    input.includes('\\')
    || isAbsolute(input)
    || WINDOWS_ABSOLUTE.test(input)
    || (!allowGlob && hasGlobMagic(input))
  ) {
    return { error: 'AIH_PATH_INVALID', message: '路径必须是 POSIX 仓库相对路径：' + input };
  }
  const segments = input.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { error: 'AIH_PATH_INVALID', message: '路径包含空段或目录跳转：' + input };
  }
  const concreteSegments = allowGlob
    ? segments.slice(0, segments.findIndex((segment) => hasGlobMagic(segment)) < 0
      ? segments.length
      : segments.findIndex((segment) => hasGlobMagic(segment)))
    : segments;
  const absolute = resolve(root, ...concreteSegments);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith('..\\') || fromRoot.startsWith('../') || isAbsolute(fromRoot)) {
    return { error: 'AIH_PATH_OUTSIDE_ROOT', message: '路径位于仓库根目录之外：' + input };
  }
  return { path: segments.join('/') };
}

export function repositoryFile(root, path) {
  const normalized = normalizeRepositoryPath(path, root);
  if (normalized.error) {
    const error = new Error(normalized.message);
    error.code = normalized.error;
    throw error;
  }
  return resolve(root, ...normalized.path.split('/'));
}

export function joinRepositoryPath(...parts) {
  return parts
    .filter((part) => typeof part === 'string' && part.length > 0)
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .join('/');
}

export function workspaceRootMarker(manifest) {
  return (manifest.scopes || []).find((scope) => scope.selector?.type === 'workspace')?.selector?.marker || null;
}

export async function stageHasUserFiles(root, stageRoot, ignoredRootFiles = []) {
  const ignored = new Set(ignoredRootFiles);
  async function inspect(relative = '') {
    const directory = joinRepositoryPath(stageRoot, relative);
    let entries;
    try {
      entries = await readdir(repositoryFile(root, directory), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    for (const entry of entries) {
      const next = joinRepositoryPath(relative, entry.name);
      if (entry.isDirectory()) {
        if (await inspect(next)) return true;
      } else if (!ignored.has(next)) {
        return true;
      }
    }
    return false;
  }

  return inspect();
}

export async function readJson(root, path) {
  return JSON.parse(await readFile(repositoryFile(root, path), 'utf8'));
}

export async function readYaml(root, path) {
  return parseYaml(await readFile(repositoryFile(root, path), 'utf8'));
}

export async function readStructured(root, path, format) {
  return format === 'json' ? readJson(root, path) : readYaml(root, path);
}

export function parseStructuredText(text, format) {
  return format === 'json' ? JSON.parse(text) : parseYaml(text);
}

export function stringifyStructured(data, format) {
  return format === 'json' ? JSON.stringify(data, null, 2) + '\n' : stringifyYaml(data);
}

export async function loadProjectAndManifest(root) {
  const project = await readYaml(root, 'psp.project.yaml');
  if (!project?.harness?.manifest) {
    const error = new Error('psp.project.yaml 未声明 harness.manifest。');
    error.code = 'AIH_PROJECT_BINDING_INVALID';
    throw error;
  }
  const manifest = await readJson(root, project.harness.manifest);
  return { project, manifest };
}

export function artifactPaths(project, artifactId, stageId) {
  const stage = project.stages?.[stageId];
  const binding = stage?.artifacts?.[artifactId];
  if (!stage || !binding) return null;
  const projectionBindings = binding.projections || binding.outputs || [];
  const outputs = projectionBindings.map((output) => ({
    path: joinRepositoryPath(stage.root, output.path),
    role: output.role,
  }));
  const inputRoot = binding.inputRoot
    ? joinRepositoryPath(stage.root, binding.inputRoot)
    : null;
  if (binding.authority?.kind === 'area') {
    const area = stage.areas?.[binding.authority.area];
    if (!area) return null;
    const authorityPath = joinRepositoryPath(
      stage.root,
      area.root,
      binding.authority.semanticEntry,
    );
    return {
      authorityKind: 'area',
      authorityPath,
      inputRoot,
      area: binding.authority.area,
      semanticEntry: binding.authority.semanticEntry,
      outputPaths: outputs.map((output) => output.path),
      outputs,
    };
  }
  const authorityPath = joinRepositoryPath(stage.root, binding.internalModel);
  return {
    authorityKind: 'internal-model',
    authorityPath,
    inputRoot,
    internalModel: authorityPath,
    outputPaths: outputs.map((output) => output.path),
    outputs,
  };
}
