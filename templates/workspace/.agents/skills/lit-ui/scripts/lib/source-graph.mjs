import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { repositoryFile } from '../../../../runtime/project.mjs';

const IMPORTS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

async function file(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function resolveSource(raw) {
  const candidates = [
    raw,
    raw.replace(/\.js$/, '.ts'),
    raw + '.ts',
    raw + '.js',
    resolve(raw, 'index.ts'),
    resolve(raw, 'index.js'),
  ];
  for (const candidate of candidates) if (await file(candidate)) return candidate;
  return raw;
}

async function resolveImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  return resolveSource(resolve(dirname(importer), specifier));
}

export async function productionSourceGraph(root) {
  const entry = repositoryFile(root, 'src/product-main.ts');
  const pending = [entry];
  const visited = new Set();
  const external = new Set();
  const blockers = [];
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    let source;
    try { source = await readFile(current, 'utf8'); } catch {
      blockers.push({ code: 'VSD_PRODUCTION_DEPENDENCY_MISSING', message: `生产源码不可读：${relative(root, current)}` });
      continue;
    }
    for (const pattern of IMPORTS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        let target = null;
        if (specifier.startsWith('/src/')) target = await resolveSource(repositoryFile(root, specifier.slice(1)));
        else if (specifier.startsWith('.')) target = await resolveImport(current, specifier);
        else external.add(specifier);
        if (/^(?:msw|axe-core|@playwright\/test)(?:\/|$)/.test(specifier)) {
          blockers.push({
            code: 'VSD_PRODUCTION_DEPENDENCY_FORBIDDEN',
            message: `生产源码禁止导入 Review/Test/Mock 包：${specifier}`,
          });
        }
        if (target) pending.push(target);
      }
    }
  }
  const dependencies = [...visited].map((path) => relative(root, path).replaceAll('\\', '/')).sort();
  for (const path of dependencies) {
    if (!/^(src\/product-main\.ts|src\/ui(?:\/.*)?|src\/adapters\/real(?:\/.*)?)$/.test(path)) {
      blockers.push({ code: 'VSD_PRODUCTION_DEPENDENCY_FORBIDDEN', message: `生产源码越界依赖：${path}` });
    }
  }
  if (!dependencies.some((path) => path.startsWith('src/adapters/real/'))) {
    blockers.push({ code: 'VSD_REAL_ADAPTER_MISSING', message: '生产入口没有绑定真实 Adapter。' });
  }
  return { dependencies, externalDependencies: [...external].sort(), blockers };
}
