import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  artifactCollectionMembers,
  artifactPaths,
  repositoryFile,
} from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

export function sha256(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

export async function repositoryFileLock(root, path) {
  return { path, contentHash: sha256(await readFile(repositoryFile(root, path))) };
}

async function filesBelow(directory, ignored = new Set(), base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path, ignored, base));
    else if (entry.isFile()) files.push(relative(base, path).split(sep).join('/'));
  }
  return files.sort();
}

export async function treeLock(root, repositoryPath, ignored = ['dist', 'node_modules', '.vite']) {
  const directory = repositoryFile(root, repositoryPath);
  const files = [];
  for (const relativePath of await filesBelow(directory, new Set(ignored))) {
    files.push(await repositoryFileLock(root, repositoryPath + '/' + relativePath));
  }
  return {
    path: repositoryPath,
    files,
    contentHash: sha256(files.map((item) => item.path + '\0' + item.contentHash).join('\n')),
  };
}

export async function inputLocks(root, project, manifest) {
  const result = {};
  for (const [artifactId, name] of [['capabilities', 'useCases'], ['visual-spec', 'visualSpec']]) {
    const registry = manifest.artifactRegistry.find((item) => item.id === artifactId);
    const paths = artifactPaths(project, artifactId, 'product-design');
    const raw = await readFile(repositoryFile(root, paths.authorityPath));
    const model = registry.format === 'json' ? JSON.parse(raw) : parseYaml(raw.toString('utf8'));
    result[name] = {
      version: model.metadata.version,
      path: paths.authorityPath,
      contentHash: sha256(raw),
    };
    if (artifactId === 'visual-spec') {
      result.visualAssets = [];
      for (const asset of model.assets || []) {
        const lock = await repositoryFileLock(root, project.stages['product-design'].root + '/' + asset.file);
        result.visualAssets.push({ id: asset.id, ...lock });
      }
    }
  }
  return result;
}

export async function canonicalLocks(root, project) {
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const actors = [];
  for (const member of await artifactCollectionMembers(root, paths)) {
    const areaPath = paths.authorityRoot + '/' + member.actor;
    const tree = await treeLock(root, areaPath);
    const reviewPluginPattern = /^src\/review-shell\.ts$/;
    const sourceFiles = tree.files.filter((item) => {
      const relativePath = item.path.slice(areaPath.length + 1);
      return /^(?:index\.html|public\/|src\/)/.test(relativePath) && !reviewPluginPattern.test(relativePath);
    });
    const buildFiles = tree.files.filter((item) => /\/(?:package\.json|tsconfig\.json|vite\.config\.ts)$/.test(item.path));
    const model = await extractCanonicalUi(root, member.authorityPath);
    actors.push({
      actor: member.actor,
      draftVersion: model.draft.version,
      inputs: model.draft.inputs,
      source: { files: sourceFiles, contentHash: sha256(sourceFiles.map((item) => item.path + '\0' + item.contentHash).join('\n')) },
      buildInputs: { files: buildFiles, contentHash: sha256(buildFiles.map((item) => item.path + '\0' + item.contentHash).join('\n')) },
      implementationHash: tree.contentHash,
    });
  }
  return actors;
}

export function reviewEvidenceDirectory(root) {
  const workspaceId = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24);
  return resolve(tmpdir(), 'psp-canonical-ui-review-' + workspaceId);
}
