import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFromRuntime = createRequire(import.meta.url);

function isBareSpecifier(specifier) {
  return !specifier.startsWith('.')
    && !specifier.startsWith('/')
    && !specifier.startsWith('node:')
    && !/^[A-Za-z]:/.test(specifier);
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!isBareSpecifier(specifier) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    try {
      return { url: pathToFileURL(requireFromRuntime.resolve(specifier)).href, shortCircuit: true };
    } catch {
      throw error;
    }
  }
}
