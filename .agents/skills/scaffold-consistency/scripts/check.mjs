import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';

const PROTOCOL = 'pre-sdd-harness/v3';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function diagnostic(code, message, location) {
  return { code, message, location, gateClass: 'safety-structure' };
}

async function validateReport(root, report) {
  const schema = await readJson(resolve(root, '.psp/harness/schemas/consistency-report.schema.json'));
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  if (validate(report)) return report;
  const details = (validate.errors || []).map((error) => (error.instancePath || '/') + ' ' + error.message).join('; ');
  throw Object.assign(new Error('Consistency Report 不符合登记 Schema：' + details), { code: 'AIH_SCHEMA_INVALID' });
}

export async function checkScaffoldConsistency(root) {
  const diagnostics = [];
  const [project, templateProject, manifest, templateManifest, packageJson, dispatch] = await Promise.all([
    readFile(resolve(root, 'psp.project.yaml'), 'utf8').then(parseYaml),
    readFile(resolve(root, 'templates/workspace/psp.project.yaml'), 'utf8').then(parseYaml),
    readJson(resolve(root, '.psp/harness/harness.manifest.json')),
    readJson(resolve(root, 'templates/workspace/.psp/harness/harness.manifest.json')),
    readJson(resolve(root, 'package.json')),
    readFile(resolve(root, 'runtime/dispatch.mjs'), 'utf8'),
  ]);
  const facts = [
    ['root-project', project.kind === 'PSPScaffoldProject' && project.harness?.protocol === PROTOCOL, '根项目绑定不是 v3 Maintainer Harness。', 'psp.project.yaml'],
    ['root-manifest', manifest.standard?.protocol === PROTOCOL && manifest.standard?.profile === 'maintainer', '根 Manifest 未绑定 v3 Maintainer Profile。', '.psp/harness/harness.manifest.json'],
    ['template-project', templateProject.kind === 'PSPProject' && templateProject.harness?.protocol === PROTOCOL, '模板项目绑定不是 v3 User Harness。', 'templates/workspace/psp.project.yaml'],
    ['template-manifest', templateManifest.standard?.protocol === PROTOCOL && templateManifest.standard?.profile === 'user', '模板 Manifest 未绑定 v3 User Profile。', 'templates/workspace/.psp/harness/harness.manifest.json'],
    ['runtime-dispatch', [...dispatch.matchAll(/pre-sdd-harness\/v\d+/g)].every((match) => match[0] === PROTOCOL), '运行时分发器未仅支持 v3。', 'runtime/dispatch.mjs'],
    ['package-template', packageJson.files?.includes('templates/workspace/'), 'npm 包清单未包含工作区模板。', 'package.json'],
  ];
  for (const [id, pass, message, location] of facts) {
    if (!pass) diagnostics.push(diagnostic('AIH_SCAFFOLD_CONSISTENCY_FAILED', message, location));
  }
  const dependencies = facts.map(([id, pass, , location]) => ({
    id,
    from: location,
    to: id.includes('template') ? 'generated-workspace' : 'scaffold-package',
    status: pass ? 'PASS' : 'BLOCKED',
  }));
  return validateReport(root, {
    protocol: PROTOCOL,
    status: diagnostics.length === 0 ? 'PASS' : 'BLOCKED',
    scope: { requested: ['scaffold-repository'], selected: facts.map(([id]) => id) },
    dependencies,
    diagnostics,
    acceptedRisks: [],
    suggestedOperations: diagnostics.length === 0 ? [] : ['显式修改拥有该投影的模板、运行时或 Manifest，再重新执行 scaffold-consistency。'],
    changes: [],
    validation: dependencies.map((item) => ({ id: item.id, status: item.status })),
    residuals: diagnostics,
    sideEffects: { status: 'PASS', changedPaths: [] },
    handoff: 'NOT_RUN',
    publication: 'NOT_RUN',
  });
}

async function main() {
  const root = resolve(process.env.PSP_REPOSITORY_ROOT || process.cwd());
  let result;
  try {
    result = await checkScaffoldConsistency(root);
  } catch (error) {
    result = {
      protocol: PROTOCOL,
      status: 'BLOCKED',
      scope: { requested: ['scaffold-repository'], selected: [] },
      dependencies: [],
      diagnostics: [diagnostic(error.code || 'AIH_SCAFFOLD_CONSISTENCY_FAILED', error.message, 'scaffold-consistency')],
      acceptedRisks: [],
      suggestedOperations: [],
      changes: [],
      validation: [],
      residuals: [],
      sideEffects: { status: 'NOT_RUN', changedPaths: [] },
      handoff: 'NOT_RUN',
      publication: 'NOT_RUN',
    };
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('[' + result.status + '] scaffold-consistency');
  if (result.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
