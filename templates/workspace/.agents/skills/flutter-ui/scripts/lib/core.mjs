import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';
import { repositoryFile } from '../../../../runtime/project.mjs';

export const ARTIFACTS = Object.freeze({
  l1: { id: 'flutter-visual-coverage', schema: '.agents/skills/flutter-ui/schemas/flutter-visual-coverage.schema.json' },
  l2: { id: 'flutter-user-path-coverage', schema: '.agents/skills/flutter-ui/schemas/flutter-user-path-coverage.schema.json' },
  preview: { id: 'preview-manifest', schema: '.agents/skills/flutter-ui/schemas/preview-manifest.schema.json' },
  findings: { id: 'review-findings', schema: '.agents/skills/flutter-ui/schemas/review-findings.schema.json' },
  manifest: { id: 'ui-spec-manifest', schema: '.agents/skills/flutter-ui/schemas/ui-spec-manifest.schema.json' },
});

export function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function stableJson(value) {
  return JSON.stringify(sortValue(value), null, 2) + '\n';
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function filesBelow(path) {
  if (!await exists(path)) return [];
  const info = await stat(path);
  if (info.isFile()) return [path];
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(child));
    else if (entry.isFile()) output.push(child);
  }
  return output;
}

function normalized(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

function roleFor(path) {
  if (path.startsWith('lib/ui/tokens/')) return 'token';
  if (path.startsWith('lib/ui/motion/')) return 'motion';
  if (path.startsWith('lib/ui/')) return 'ui-source';
  if (path.startsWith('lib/adapters/contracts/')) return 'adapter-contract';
  if (path.startsWith('lib/adapters/real/')) return 'production-adapter';
  if (path === 'lib/main.dart') return 'entrypoint';
  if (path === 'pubspec.yaml') return 'package-manifest';
  if (path === 'pubspec.lock') return 'package-lock';
  if (/^(android|ios|web)\//.test(path)) return 'platform-config';
  return /font/i.test(path) ? 'font' : 'asset';
}

function trackedFiles(root, roots) {
  const result = spawnSync('git', ['ls-files', '-z', '--', ...roots], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.split('\0').filter(Boolean);
}

function generatedPlatformFile(path) {
  return /(?:^|\/)(?:\.gradle|build|Pods|\.symlinks|ephemeral)(?:\/|$)/.test(path)
    || /^(?:android\/local\.properties|ios\/Flutter\/(?:Generated\.xcconfig|flutter_export_environment\.sh))$/.test(path)
    || path.endsWith('/.DS_Store');
}

function rejectRelativePath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw Object.assign(new Error(`不安全的闭包路径：${path}`), { code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE' });
  }
}

function rejectUnsafeSourcePath(path) {
  rejectRelativePath(path);
  if (/^(lib\/(review|testing)\/|MockCase\/|\.psp\/|build\/|test\/)/.test(path)) {
    throw Object.assign(new Error(`Review/Test/Mock 路径不得进入正式源码闭包：${path}`), { code: 'FLUTTER_SOURCE_LEAK' });
  }
}

export async function collectSourceClosure(root) {
  const manifestPath = repositoryFile(root, 'pubspec.yaml');
  if (!await exists(manifestPath)) throw Object.assign(new Error('缺少 pubspec.yaml。'), { code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE' });
  let pubspec;
  try { pubspec = YAML.parse(await readFile(manifestPath, 'utf8')); } catch (error) {
    throw Object.assign(new Error(`pubspec.yaml 无法解析：${error.message}`), { code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE' });
  }
  const declared = [
    'lib/ui', 'lib/adapters/contracts', 'lib/adapters/real', 'lib/main.dart', 'pubspec.yaml', 'pubspec.lock',
    'android', 'ios', 'web',
    ...(pubspec?.flutter?.assets ?? []),
    ...(pubspec?.flutter?.fonts ?? []).flatMap((font) => (font.fonts ?? []).map((entry) => entry.asset)),
  ];
  const absoluteFiles = [];
  const uniqueDeclarations = [...new Set(declared)];
  const tracked = trackedFiles(root, uniqueDeclarations);
  for (const declaredPath of uniqueDeclarations) {
    rejectUnsafeSourcePath(declaredPath);
    const absolute = repositoryFile(root, declaredPath);
    if (!await exists(absolute)) {
      if (['lib/ui', 'lib/main.dart', 'pubspec.lock'].includes(declaredPath) || (pubspec?.flutter?.assets ?? []).includes(declaredPath)) {
        throw Object.assign(new Error(`源码闭包声明但不存在：${declaredPath}`), { code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE' });
      }
      continue;
    }
    if (tracked === null) absoluteFiles.push(...await filesBelow(absolute));
  }
  if (tracked !== null) absoluteFiles.push(...tracked.map((path) => repositoryFile(root, path)));
  const unique = [...new Set(absoluteFiles.map((path) => resolve(path)))].sort((a, b) => normalized(root, a).localeCompare(normalized(root, b)));
  const closure = [];
  const aggregate = createHash('sha256');
  for (const absolute of unique) {
    const path = normalized(root, absolute);
    rejectUnsafeSourcePath(path);
    if (generatedPlatformFile(path)) continue;
    const bytes = await readFile(absolute);
    aggregate.update(path); aggregate.update('\0'); aggregate.update(bytes); aggregate.update('\0');
    closure.push({ path, role: roleFor(path), digest: sha256(bytes) });
  }
  if (!closure.some((entry) => entry.path.startsWith('lib/ui/') && entry.path.endsWith('.dart'))) {
    throw Object.assign(new Error('lib/ui/** 中没有 Dart 权威源码。'), { code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE' });
  }
  return {
    digest: `sha256:${aggregate.digest('hex')}`,
    files: closure,
    flutterConstraint: String(pubspec?.environment?.flutter ?? ''),
  };
}

export async function hashPath(root, path) {
  rejectRelativePath(path);
  const absolute = repositoryFile(root, path);
  const files = (await filesBelow(absolute)).sort((a, b) => normalized(root, a).localeCompare(normalized(root, b)));
  if (!files.length) throw Object.assign(new Error(`摘要目标不存在或为空：${path}`), { code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE' });
  const aggregate = createHash('sha256');
  for (const file of files) {
    aggregate.update(normalized(root, file)); aggregate.update('\0'); aggregate.update(await readFile(file)); aggregate.update('\0');
  }
  return `sha256:${aggregate.digest('hex')}`;
}

export async function readArtifact(root, path) {
  const bytes = await readFile(repositoryFile(root, path));
  let data;
  try { data = JSON.parse(bytes); } catch (error) {
    throw Object.assign(new Error(`${path} 不是有效 JSON：${error.message}`), { code: 'FLUTTER_ARTIFACT_INVALID' });
  }
  rejectLegacy(data, path);
  return { path, bytes, digest: sha256(bytes), data };
}

export function rejectLegacy(data, path = '') {
  const text = JSON.stringify(data);
  if (/uihtml|litSource|lit-visual|src\/ui|review\.html|vite/i.test(`${path}\n${text}`)) {
    throw Object.assign(new Error(`旧 Lit/UIHTML 输入禁止进入 Flutter 链：${path}`), { code: 'FLUTTER_LEGACY_INPUT_FORBIDDEN' });
  }
}

export async function validateSchema(root, schemaPath, data) {
  const schema = JSON.parse(await readFile(repositoryFile(root, schemaPath), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true, formats: { 'date-time': isIsoDateTime } });
  const validate = ajv.compile(schema);
  if (validate(data)) return [];
  return (validate.errors ?? []).map((error) => ({
    code: 'FLUTTER_ARTIFACT_SCHEMA_INVALID',
    message: `${error.instancePath || '/'} ${error.message}`,
  }));
}

export function isIsoDateTime(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

export function artifactRevision(data) {
  return data?.metadata?.revision ?? data?.revision;
}

export function lockFor(artifactId, artifact) {
  return { artifactId, path: artifact.path, revision: artifactRevision(artifact.data), digest: artifact.digest };
}

export function sameLock(lock, artifact) {
  return lock?.path === artifact.path && lock?.revision === artifactRevision(artifact.data) && lock?.digest === artifact.digest;
}

export function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function report(blockers, extra = {}) {
  const output = { status: blockers.length ? 'BLOCKED' : 'PASS', ...extra, blockers };
  console.log(JSON.stringify(output));
  if (blockers.length) process.exitCode = 1;
}
