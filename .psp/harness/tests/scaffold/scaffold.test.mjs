import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { validateScaffold } from '../../scripts/validate-harness.mjs';
import { npmInvocation } from '../../scripts/run-ci-validation.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const temporaryRoots = [];

test.after(async () => {
  await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pre-sdd-scaffold-harness-'));
  temporaryRoots.push(root);
  for (const file of ['AGENTS.md', 'README.md', 'package.json', 'psp.project.yaml']) {
    await cp(resolve(repositoryRoot, file), resolve(root, file));
  }
  for (const directory of ['.agents', '.github', '.psp', 'bin', 'runtime', 'templates']) {
    await cp(resolve(repositoryRoot, directory), resolve(root, directory), { recursive: true });
  }
  return root;
}

function resolvePaths(paths, intent = 'change') {
  const args = ['.psp/harness/scripts/resolve-validation.mjs'];
  for (const path of paths) args.push('--path', path);
  args.push('--intent', intent, '--json');
  return spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('root binding is scaffold-only and validates without domain lifecycle', async () => {
  const project = parseYaml(await readFile(resolve(repositoryRoot, 'psp.project.yaml'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, '.psp/harness/harness.manifest.json'), 'utf8'));
  assert.equal(project.kind, 'PSPScaffoldProject');
  assert.equal(Object.hasOwn(project, 'stages'), false);
  for (const forbidden of ['domainRegistry', 'artifactRegistry', 'operations']) assert.equal(Object.hasOwn(manifest, forbidden), false, forbidden);
  assert.equal(manifest.scopes.some((scope) => ['stage', 'artifact', 'domain'].includes(scope.kind)), false);
  assert.deepEqual(manifest.scaffoldPolicy.governanceModel, {
    maintainerHarness: {
      projectKind: 'PSPScaffoldProject',
      purpose: 'scaffold-maintenance',
      authority: 'scaffold-repository-local',
      completion: 'validated-scaffold-change',
    },
    userHarness: {
      projectKind: 'PSPProject',
      purpose: 'generated-workspace-governance',
      sourceRoot: 'templates/workspace',
      authority: 'generated-workspace-local',
    },
    lifecycleIsolation: {
      rootDomainLifecycle: 'forbidden',
      rootDomainHandoff: 'forbidden',
      templateExternalLifecycle: 'forbidden',
      crossLifecycleControl: 'forbidden',
    },
  });
  assert.deepEqual(manifest.scaffoldPolicy.execution, {
    runtimeAuthority: 'generated-workspace-snapshot',
    runtimeSnapshot: '.psp/runtime/pre-sdd',
    executorAuthority: 'generated-workspace-local',
    dependencyAuthority: 'generated-workspace-package-lock',
    dependencyCache: 'os-temporary-directory',
    testWorkspace: 'os-temporary-copy',
    runtimeEvidence: 'os-temporary-directory',
  });
  assert.equal((await validateScaffold(repositoryRoot)).status, 'PASS');
});

test('root and generated-workspace instructions are distinct contexts', async () => {
  const rootInstructions = await readFile(resolve(repositoryRoot, 'AGENTS.md'), 'utf8');
  const workspaceInstructions = await readFile(resolve(repositoryRoot, 'templates/workspace/AGENTS.md'), 'utf8');
  assert.notEqual(rootInstructions, workspaceInstructions);
  assert.match(rootInstructions, /PSPScaffoldProject/);
  assert.match(workspaceInstructions, /Generated Workspace/);
});

test('resolver applies package gates to workspace-template changes', () => {
  const execution = resolvePaths(['templates/workspace/.agents/skills/product-design/SKILL.md']);
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.deepEqual(result.scopes, ['workspace-template']);
  assert.deepEqual(result.commands, [
    'npm run validate:harness',
    'npm run test:harness',
    'npm run test:package',
    'npm run pack:check',
  ]);
});

test('resolver governs the continuous-integration workflow', () => {
  const execution = resolvePaths(['.github/workflows/harness-governance.yml']);
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.deepEqual(result.scopes, ['scaffold-governance']);
  assert.deepEqual(result.commands, ['npm run validate:harness', 'npm run test:harness']);
});

test('continuous-integration plan comes from Resolver commands', () => {
  const execution = spawnSync(process.execPath, ['.psp/harness/scripts/run-ci-validation.mjs', '--plan', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.commands, [
    'npm run validate:harness',
    'npm run test:harness',
    'npm run test:package',
    'npm run pack:check',
  ]);
});

test('continuous-integration runner uses a platform-safe npm invocation', () => {
  const invocation = npmInvocation('validate:harness');
  if (process.platform === 'win32') {
    assert.match(invocation.command.toLowerCase(), /cmd(?:\.exe)?$/);
    assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'npm run validate:harness']);
  } else {
    assert.deepEqual(invocation, { command: 'npm', args: ['run', 'validate:harness'] });
  }
});

test('resolver blocks unmanaged and invalid paths', () => {
  for (const path of ['docs/unmanaged.md', '../outside.md', 'runtime\\dispatch.mjs']) {
    const execution = resolvePaths([path]);
    assert.notEqual(execution.status, 0);
    assert.match(execution.stderr + execution.stdout, /AIH_(SCOPE_UNRESOLVED|PATH_INVALID|PATH_OUTSIDE_ROOT)/);
  }
});

test('Codex SessionStart hook reports the scaffold Harness as PASS', () => {
  const hook = spawnSync(process.execPath, ['.codex/hooks/validate-harness.mjs'], {
    cwd: repositoryRoot,
    input: JSON.stringify({ cwd: repositoryRoot }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(hook.status, 0, hook.stderr);
  const output = JSON.parse(hook.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /Harness 契约校验 PASS/);
});

test('validator blocks a root domain Skill', async () => {
  const root = await fixture();
  const skill = resolve(root, '.agents/skills/product-design');
  await mkdir(skill, { recursive: true });
  await writeFile(resolve(skill, 'SKILL.md'), '---\nname: product-design\ndescription: invalid root domain\n---\n', 'utf8');
  const result = await validateScaffold(root);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some((item) => item.code === 'AIH_SCAFFOLD_CONTEXT_INVALID'));
});

test('validator blocks instruction-context collapse', async () => {
  const root = await fixture();
  const workspaceInstructions = await readFile(resolve(root, 'templates/workspace/AGENTS.md'), 'utf8');
  await writeFile(resolve(root, 'AGENTS.md'), workspaceInstructions, 'utf8');
  const result = await validateScaffold(root);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some((item) => item.code === 'AIH_SCAFFOLD_CONTEXT_INVALID'));
});

test('validator blocks a dual-Harness source binding mismatch', async () => {
  const root = await fixture();
  const path = resolve(root, '.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.scaffoldPolicy.governanceModel.userHarness.sourceRoot = 'templates/other';
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const result = await validateScaffold(root);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some((item) => item.code === 'AIH_HARNESS_BOUNDARY_INVALID'));
});

test('validator blocks an external framework lifecycle binding in the workspace template', async () => {
  const root = await fixture();
  const path = resolve(root, 'templates/workspace/.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.scopes.find((item) => item.id === 'architecture-design').externalConsumers = ['downstream-tool'];
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const result = await validateScaffold(root);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some((item) => item.code === 'AIH_EXTERNAL_FRAMEWORK_BOUNDARY_INVALID'));
});

test('validator blocks template pollution', async () => {
  const root = await fixture();
  await mkdir(resolve(root, 'templates/workspace/node_modules'), { recursive: true });
  const result = await validateScaffold(root);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some((item) => item.code === 'AIH_TEMPLATE_POLLUTED'));
});

test('validator blocks an active stage in the workspace template', async () => {
  const root = await fixture();
  const path = resolve(root, 'templates/workspace/psp.project.yaml');
  const project = parseYaml(await readFile(path, 'utf8'));
  project.stages['product-design'].status = 'active';
  await writeFile(path, stringifyYaml(project), 'utf8');
  const result = await validateScaffold(root);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some((item) => item.code === 'AIH_TEMPLATE_INVALID'));
});

test('validator blocks a continuous-integration workflow that bypasses the Resolver runner', async () => {
  const root = await fixture();
  const path = resolve(root, '.github/workflows/harness-governance.yml');
  const workflow = parseYaml(await readFile(path, 'utf8'));
  workflow.jobs['harness-governance'].steps.at(-1).run = 'npm run validate:harness';
  await writeFile(path, stringifyYaml(workflow), 'utf8');
  const result = await validateScaffold(root);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some((item) => item.code === 'AIH_CI_POLICY_INVALID'));
});
