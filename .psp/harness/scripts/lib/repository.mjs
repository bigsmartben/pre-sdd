import { access, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export function normalizeRepositoryPath(input, root = process.cwd()) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\\')) {
    return { error: 'AIH_PATH_INVALID', message: '路径必须是非空的仓库相对 POSIX 路径。' };
  }
  if (isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    return { error: 'AIH_PATH_INVALID', message: '路径不得是绝对路径：' + input };
  }
  const normalized = input.split('/').filter(Boolean).join('/');
  if (!normalized || normalized.split('/').some((part) => part === '.' || part === '..')) {
    return { error: 'AIH_PATH_INVALID', message: '路径不得包含目录跳转：' + input };
  }
  const absolute = resolve(root, ...normalized.split('/'));
  const fromRoot = relative(resolve(root), absolute);
  if (fromRoot === '..' || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) {
    return { error: 'AIH_PATH_OUTSIDE_ROOT', message: '路径位于仓库根目录之外：' + input };
  }
  return { path: normalized };
}

export function repositoryFile(root, path) {
  const normalized = normalizeRepositoryPath(path, root);
  if (normalized.error) throw Object.assign(new Error(normalized.message), { code: normalized.error });
  return resolve(root, ...normalized.path.split('/'));
}

export function joinRepositoryPath(...parts) {
  return parts
    .filter((part) => typeof part === 'string' && part.length > 0)
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .join('/');
}

export async function pathExists(root, path) {
  try {
    await access(repositoryFile(root, path));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readJson(root, path) {
  return JSON.parse(await readFile(repositoryFile(root, path), 'utf8'));
}

export async function readYaml(root, path) {
  return parseYaml(await readFile(repositoryFile(root, path), 'utf8'));
}
