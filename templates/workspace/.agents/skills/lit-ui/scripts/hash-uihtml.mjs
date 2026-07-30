import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const rootIndex = process.argv.indexOf('--uihtml');
const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : 'UIHTML');

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

try {
  const hash = createHash('sha256');
  for (const path of (await files(root)).sort()) {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  console.log(JSON.stringify({ status: 'PASS', productHash: `sha256:${hash.digest('hex')}` }));
} catch (error) {
  console.log(JSON.stringify({
    status: 'BLOCKED',
    blockers: [{ code: 'UIHTML_RUNTIME_DEP_MISSING', message: error instanceof Error ? error.message : String(error) }],
  }));
  process.exitCode = 1;
}
