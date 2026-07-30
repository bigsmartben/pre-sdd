import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

export async function hashUihtml(rootArgument = 'UIHTML') {
  const root = resolve(rootArgument);
  const hash = createHash('sha256');
  for (const path of (await files(root)).sort()) {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootIndex = process.argv.indexOf('--uihtml');
  const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : 'UIHTML');
  try {
    console.log(JSON.stringify({ status: 'PASS', productHash: await hashUihtml(root) }));
  } catch (error) {
    console.log(JSON.stringify({
      status: 'BLOCKED',
      blockers: [{ code: 'UIHTML_RUNTIME_DEP_MISSING', message: error instanceof Error ? error.message : String(error) }],
    }));
    process.exitCode = 1;
  }
}
