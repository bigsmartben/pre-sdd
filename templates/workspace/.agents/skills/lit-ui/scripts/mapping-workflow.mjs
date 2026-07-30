import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { relative } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import {
  confirmationFor,
  extractMapping,
  readMapping,
  renderMapping,
  validateMapping,
} from './lib/mapping.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function report(status, blockers = [], extra = {}) {
  const payload = { status, blockers, ...extra };
  if (process.argv.includes('--json')) console.log(JSON.stringify(payload));
  else console.log(status, ...blockers.map((item) => `${item.code}: ${item.message}`));
  process.exitCode = status === 'PASS' ? 0 : 1;
}

function bump(version) {
  const parts = String(version).split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return '0.1.0';
  parts[2] += 1;
  return parts.join('.');
}

const operation = argument('operation', 'validate');
const workspace = resolve(argument('root', process.cwd()));
const mappingPath = resolve(workspace, argument('mapping', '01-product-design/Lit-UI/Mapping.html'));
const mappingTarget = relative(workspace, mappingPath).replaceAll('\\', '/');
const templatePath = resolve(
  import.meta.dirname,
  '..',
  'templates',
  'Mapping.html',
);

try {
  if (!mappingTarget || mappingTarget === '..' || mappingTarget.startsWith('../') || isAbsolute(mappingTarget)) {
    throw Object.assign(new Error('Mapping 路径必须位于当前工作区内。'), { code: 'AIH_PATH_OUTSIDE_ROOT' });
  }
  if (operation === 'initialize') {
    const template = await readFile(templatePath, 'utf8');
    const model = extractMapping(template);
    model.sources = {
      figma: { version: argument('figma-version', ''), contentHash: argument('figma-hash', '') },
      uc: { version: argument('uc-version', ''), contentHash: argument('uc-hash', '') },
    };
    const blockers = validateMapping(model).filter((item) => ![
      'MAPPING_GAPS_OPEN',
      'MAPPING_CONFIRMATION_STALE',
    ].includes(item.code));
    if (blockers.length) report('BLOCKED', blockers);
    else {
      await mkdir(dirname(mappingPath), { recursive: true });
      await writeFile(mappingPath, renderMapping(template, model), { flag: 'wx' });
      report('PASS', [], { mapping: mappingPath, next: 'clarify' });
    }
  } else if (operation === 'update') {
    const html = await readFile(mappingPath, 'utf8');
    const model = extractMapping(html);
    const packet = JSON.parse(await readFile(resolve(workspace, argument('packet')), 'utf8'));
    if (packet.sources) model.sources = packet.sources;
    if (packet.concepts) model.concepts = packet.concepts;
    if (packet.questions) model.questions = packet.questions;
    model.mappingVersion = bump(model.mappingVersion);
    model.confirmation = model.confirmation ? { ...model.confirmation, status: 'stale' } : null;
    const blockers = validateMapping(model).filter((item) => item.code !== 'MAPPING_CONFIRMATION_STALE');
    const invalid = blockers.filter((item) => item.code !== 'MAPPING_GAPS_OPEN');
    if (invalid.length) report('BLOCKED', invalid);
    else {
      await commitManagedWrites({
        root: workspace,
        ownerId: 'lit-ui-mapping-update',
        writes: [{ target: mappingTarget, content: renderMapping(html, model) }],
      });
      report('PASS', blockers, { mapping: mappingPath, next: blockers.length ? 'clarify' : 'confirm' });
    }
  } else if (operation === 'confirm') {
    const html = await readFile(mappingPath, 'utf8');
    const model = extractMapping(html);
    const blockers = validateMapping(model).filter((item) => item.code !== 'MAPPING_CONFIRMATION_STALE');
    const confirmedBy = argument('confirmed-by', '');
    if (!confirmedBy.startsWith('user:')) {
      blockers.push({ code: 'MAPPING_USER_CONFIRMATION_REQUIRED', message: 'confirmed-by 必须是 user:<identity>。' });
    }
    if (blockers.length) report('BLOCKED', blockers);
    else {
      model.confirmation = confirmationFor(model, confirmedBy);
      await commitManagedWrites({
        root: workspace,
        ownerId: 'lit-ui-mapping-confirm',
        writes: [{ target: mappingTarget, content: renderMapping(html, model) }],
      });
      report('PASS', [], { mapping: mappingPath, mappingContentHash: model.confirmation.mappingContentHash });
    }
  } else {
    const model = await readMapping(mappingPath);
    const blockers = validateMapping(model);
    const implementationAuthorized = blockers.length === 0;
    if (operation === 'authorize-implementation' && !implementationAuthorized) {
      blockers.unshift({ code: 'LIT_IMPLEMENTATION_NOT_AUTHORIZED', message: 'Mapping 尚未有效确认，禁止生成 Lit UI Spec。' });
    }
    report(blockers.length ? 'BLOCKED' : 'PASS', blockers, { implementationAuthorized });
  }
} catch (error) {
  const code = error?.code === 'EEXIST'
    ? 'MAPPING_AUTHORITY_DUPLICATED'
    : error?.code === 'AIH_PATH_OUTSIDE_ROOT'
      ? 'MAPPING_PATH_INVALID'
    : error?.code === 'ENOENT'
      ? 'MAPPING_ARTIFACT_MISSING'
      : 'MAPPING_WORKFLOW_FAILED';
  report('BLOCKED', [{ code, message: error instanceof Error ? error.message : String(error) }]);
}
