import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { validateScaffold } from '../../scripts/validate-harness.mjs';
import { npmInvocation, validateEvidenceReport } from '../../scripts/run-ci-validation.mjs';
import { checkScaffoldConsistency } from '../../../../.agents/skills/scaffold-consistency/scripts/check.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const temporaryRoots = [];

test.after(async () => {
  await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pre-sdd-scaffold-harness-'));
  temporaryRoots.push(root);
  for (const file of ['AGENTS.md', 'README.md', 'QUICKSTART.md', 'package.json', 'psp.project.yaml']) {
    await cp(resolve(repositoryRoot, file), resolve(root, file));
  }
  for (const directory of ['.agents', '.github', '.psp', 'bin', 'runtime', 'templates']) {
    await cp(resolve(repositoryRoot, directory), resolve(root, directory), { recursive: true });
  }
  return root;
}

function resolvePaths(paths, executionContext = 'local-edit', root = repositoryRoot) {
  const args = ['.psp/harness/scripts/resolve-validation.mjs'];
  for (const path of paths) args.push('--path', path);
  args.push('--context', executionContext, '--json');
  return spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: { ...process.env, PSP_REPOSITORY_ROOT: root },
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

test('scaffold consistency traces every Standard clause to registered downstream projections', async () => {
  const result = await checkScaffoldConsistency(repositoryRoot);
  assert.equal(result.status, 'PASS');
  assert.ok(result.scope.selected.includes('AIH-STD-AUTHORITY-001'));
  assert.ok(result.scope.selected.includes('workspace-handoff-liveness'));
  assert.ok(result.scope.selected.includes('workspace-projection-liveness'));
  assert.ok(result.dependencies.some((item) => item.id === 'projection-authority-001-1'));
  assert.ok(result.dependencies.some((item) => item.id === 'handoff-liveness-use-cases-visual-spec' && item.status === 'PASS'));
  assert.ok(result.dependencies.some((item) => item.id === 'projection-liveness-canonical-ui-prototype' && item.status === 'PASS'));
  assert.deepEqual(result.changes, []);
  assert.equal(result.sideEffects.status, 'PASS');
});

test('scaffold consistency blocks an over-broad Handoff Profile that validates a consumer', async () => {
  const root = await fixture();
  const path = resolve(root, 'templates/workspace/.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.validationProfiles.find((item) => item.id === 'use-cases-handoff').commands.push('canonical-ui-build');
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const result = await checkScaffoldConsistency(root);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.diagnostics.some((item) => (
    item.code === 'AIH_SCAFFOLD_CONSISTENCY_FAILED'
    && item.message.includes('来源特定 Profile')
  )));

  const coupledRoot = await fixture();
  const coupledPath = resolve(coupledRoot, 'templates/workspace/.psp/harness/harness.manifest.json');
  const coupledManifest = JSON.parse(await readFile(coupledPath, 'utf8'));
  coupledManifest.validationProfiles.find((item) => item.id === 'use-cases-readiness').commands.push('canonical-ui-build');
  coupledManifest.validationProfiles.find((item) => item.id === 'use-cases-handoff').commands.push('canonical-ui-build');
  await writeFile(coupledPath, JSON.stringify(coupledManifest, null, 2) + '\n', 'utf8');
  const coupled = await checkScaffoldConsistency(coupledRoot);
  assert.equal(coupled.status, 'BLOCKED');
  assert.ok(coupled.diagnostics.some((item) => (
    item.code === 'AIH_SCAFFOLD_CONSISTENCY_FAILED'
    && item.message.includes('来源特定 Profile')
  )));
});

test('scaffold consistency blocks a validator that stops using the shared dependency closure', async () => {
  const root = await fixture();
  const path = resolve(root, 'templates/workspace/.agents/skills/architecture-design/scripts/validate.mjs');
  const source = await readFile(path, 'utf8');
  await writeFile(path, source.replaceAll('collectDependencyArtifactIds', 'legacyArtifactSelection'), 'utf8');
  const result = await checkScaffoldConsistency(root);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.diagnostics.some((item) => (
    item.code === 'AIH_SCAFFOLD_CONSISTENCY_FAILED'
    && item.message.includes('来源特定 Profile')
  )));
});

test('scaffold consistency blocks generated-support without an active projection refresh path', async () => {
  const root = await fixture();
  const path = resolve(root, 'templates/workspace/.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.operations = manifest.operations.filter((item) => item.id !== 'refresh-canonical-ui-projections');
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const result = await checkScaffoldConsistency(root);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.diagnostics.some((item) => (
    item.code === 'AIH_SCAFFOLD_CONSISTENCY_FAILED'
    && item.message.includes('generated-support')
  )));
});

test('scaffold consistency blocks Canonical UI projection refresh wiring drift', async () => {
  for (const mutate of [
    (item) => { item.executor.path = '.agents/skills/product-design/canonical-ui-prototype/scripts/visual-acceptance.mjs'; },
    (item) => { item.executor.args = ['--operation', item.id]; },
    (item) => {
      item.npmScript = 'repair:canonical-ui';
      item.run = 'npm run repair:canonical-ui';
    },
    (item) => { item.outputRole = 'runtime-projection'; },
  ]) {
    const root = await fixture();
    const path = resolve(root, 'templates/workspace/.psp/harness/harness.manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    mutate(manifest.operations.find((item) => item.id === 'refresh-canonical-ui-projections'));
    await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const result = await checkScaffoldConsistency(root);
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.diagnostics.some((item) => (
      item.code === 'AIH_SCAFFOLD_CONSISTENCY_FAILED'
      && item.message.includes('generated-support')
    )));
  }
});

test('scaffold consistency blocks an unregistered Standard clause marker', async () => {
  const root = await fixture();
  const path = resolve(root, '.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.standardProjectionRegistry.clauses = manifest.standardProjectionRegistry.clauses.filter(
    (clause) => clause.clauseId !== 'AIH-STD-AUTHORITY-001',
  );
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const result = await checkScaffoldConsistency(root);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.diagnostics.some((item) => item.code === 'AIH_SCAFFOLD_CONSISTENCY_FAILED'
    && item.message.includes('上位规范条款未登记下游投影')));
});

test('scaffold consistency reports a duplicate clause with the stable blocker code', async () => {
  const root = await fixture();
  const path = resolve(root, '.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.standardProjectionRegistry.clauses.push(structuredClone(manifest.standardProjectionRegistry.clauses[0]));
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const result = await checkScaffoldConsistency(root);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.diagnostics.some((item) => item.code === 'AIH_SCAFFOLD_CONSISTENCY_FAILED'
    && item.message.includes('投影注册 clauseId 重复')));
});

test('scaffold consistency blocks missing and contradictory downstream projections', async () => {
  const root = await fixture();
  const manifestPath = resolve(root, '.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const clause = manifest.standardProjectionRegistry.clauses.find(
    (item) => item.clauseId === 'AIH-STD-AUTHORITY-001',
  );
  const targetPath = resolve(root, clause.targets[0].path);
  const targetContent = await readFile(targetPath, 'utf8');
  await writeFile(targetPath, targetContent.replace(clause.targets[0].requiredText[0], 'drifted projection text'), 'utf8');
  clause.targets[0].forbiddenText.push(clause.targets[0].requiredText[0]);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const result = await checkScaffoldConsistency(root);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.diagnostics.some((item) => item.message.includes('下游投影缺少声明文本')));
  assert.ok(result.diagnostics.some((item) => item.message.includes('同时要求并禁止相同文本')));
});

test('quick validator blocks Canonical UI implementation and Repair responsibility drift', async () => {
  for (const mutation of [
    {
      path: 'templates/workspace/.agents/skills/implement-canonical-ui/SKILL.md',
      from: '不得自行启动 Repair',
      to: '可以自行启动 Repair',
    },
    {
      path: 'templates/workspace/.agents/skills/product-design/agents/openai.yaml',
      from: 'route only a validator-generated Repair Packet to $repair-canonical-ui',
      to: 'route only a validator-generated Repair Packet to $repair-canonical-ui-visual',
    },
    {
      path: 'templates/workspace/.agents/skills/repair-canonical-ui/SKILL.md',
      from: '一次有边界的 Agent 实现修复',
      to: 'Agent 自动修复',
    },
    {
      path: 'templates/workspace/.agents/skills/repair-canonical-ui/SKILL.md',
      from: 'Review Feedback Packet（评审反馈包）只表达用户反馈，不是 Repair Packet，也不授权修复',
      to: 'Review Feedback Packet 自动授权修复',
    },
    {
      path: 'templates/workspace/.agents/skills/implement-canonical-ui/agents/openai.yaml',
      from: 'stop before Feedback Packet routing, formal Review, Repair, or Publish',
      to: 'continue through Feedback Packet routing, formal Review, Repair, and Publish',
    },
    {
      path: 'templates/workspace/.agents/skills/product-design/canonical-ui-prototype/contract.yaml',
      from: '一次授权、一次修改、一次复验',
      to: '三次尝试上限',
    },
    {
      path: 'templates/workspace/README.md',
      from: 'Feedback Packet 只表达反馈',
      to: 'Feedback Packet 自动授权修复',
    },
  ]) {
    const root = await fixture();
    const path = resolve(root, mutation.path);
    const source = await readFile(path, 'utf8');
    assert.ok(source.includes(mutation.from), mutation.path);
    await writeFile(path, source.replace(mutation.from, mutation.to), 'utf8');
    const result = await validateScaffold(root);
    assert.equal(result.status, 'FAIL');
    assert.ok(result.issues.some((item) => (
      item.code === 'AIH_SCAFFOLD_CONTEXT_INVALID'
      && item.path === mutation.path
    )));
  }
});

test('quick validator blocks Figma intake documentation projection drift', async () => {
  for (const mutation of [
    {
      path: 'QUICKSTART.md',
      from: 'Scope Confirmation 必须逐项列出',
      to: 'Scope Confirmation 可以省略节点清单',
    },
    {
      path: 'QUICKSTART.md',
      from: 'Component Handshake',
      to: '非结构化组件说明',
    },
    {
      path: 'templates/workspace/README.md',
      from: 'Variant Definition Coverage（定义覆盖）',
      to: '仅覆盖页面上已有的 Variant',
    },
    {
      path: 'templates/workspace/README.md',
      from: 'Usage Coverage（使用覆盖）',
      to: '未登记使用位置',
    },
  ]) {
    const root = await fixture();
    const path = resolve(root, mutation.path);
    const source = await readFile(path, 'utf8');
    assert.ok(source.includes(mutation.from), mutation.path);
    await writeFile(path, source.replace(mutation.from, mutation.to), 'utf8');
    const result = await validateScaffold(root);
    assert.equal(result.status, 'FAIL');
    assert.ok(result.issues.some((item) => (
      item.code === 'AIH_SCAFFOLD_CONTEXT_INVALID'
      && item.path === mutation.path
    )));
  }
});

test('scaffold consistency blocks a downstream target that claims normative authority', async () => {
  const root = await fixture();
  const manifestPath = resolve(root, '.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const clause = manifest.standardProjectionRegistry.clauses.find(
    (item) => item.clauseId === 'AIH-STD-AUTHORITY-001',
  );
  clause.targets[0] = {
    path: manifest.standardProjectionRegistry.authority,
    role: 'profile',
    requiredText: ['Harness Standard v3（Harness 上位规范）'],
    forbiddenText: [],
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const result = await checkScaffoldConsistency(root);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.diagnostics.some((item) => item.message.includes('不得登记为自己的下游投影')));
});

test('root and generated-workspace instructions are distinct contexts', async () => {
  const rootInstructions = await readFile(resolve(repositoryRoot, 'AGENTS.md'), 'utf8');
  const workspaceInstructions = await readFile(resolve(repositoryRoot, 'templates/workspace/AGENTS.md'), 'utf8');
  assert.notEqual(rootInstructions, workspaceInstructions);
  assert.match(rootInstructions, /PSPScaffoldProject/);
  assert.match(workspaceInstructions, /Generated Workspace/);
});

test('resolver separates local-edit, pull-request, and release gates for Product Design changes', () => {
  const execution = resolvePaths(['templates/workspace/.agents/skills/product-design/SKILL.md']);
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.executionContext, 'local-edit');
  assert.equal(result.completionEligible, false);
  assert.deepEqual(result.scopes, ['workspace-product']);
  assert.deepEqual(result.commands, [
    'npm run validate:harness',
  ]);
  assert.ok(result.plan.every((item) => item.costClass === 'quick'));
  assert.ok(result.plan.every((item) => item.selectedBy.length > 0 && item.cache.key));
  for (const item of result.plan) {
    assert.deepEqual(Object.keys(item.cache.bindings).sort(), [
      'dependencyDigest',
      'executorDigest',
      'profileDigest',
      'runtimeDigest',
      'sourceDigest',
      'standardDigest',
    ]);
    assert.ok(Object.values(item.cache.bindings).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
  }

  const checkpoint = resolvePaths(['templates/workspace/.agents/skills/product-design/SKILL.md'], 'pull-request');
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  const checkpointResult = JSON.parse(checkpoint.stdout);
  assert.equal(checkpointResult.executionContext, 'pull-request');
  assert.equal(checkpointResult.completionEligible, false);
  assert.deepEqual(checkpointResult.commands, [
    'npm run validate:harness',
    'npm run test:template:product',
  ]);

  const readiness = resolvePaths(['templates/workspace/.agents/skills/product-design/SKILL.md'], 'release');
  assert.equal(readiness.status, 0, readiness.stderr);
  const readinessResult = JSON.parse(readiness.stdout);
  assert.equal(readinessResult.executionContext, 'release');
  assert.equal(readinessResult.completionEligible, true);
  assert.deepEqual(readinessResult.commands, [
    'npm run validate:harness',
    'npm run check:scaffold-consistency',
      'npm run test:harness',
      'npm run test:workspace:harness',
      'npm run test:workspace:product',
      'npm run test:workspace:mockcase',
      'npm run test:workspace:architecture',
    'npm run test:package',
    'npm run pack:check',
  ]);
});

test('resolver keeps Figma Workflow, User Harness, and package projections on existing profiles', () => {
  const figmaPath = 'templates/workspace/.agents/skills/figma-workflow/capture-plan.schema.json';
  const localFigma = resolvePaths([figmaPath]);
  assert.equal(localFigma.status, 0, localFigma.stderr);
  assert.deepEqual(JSON.parse(localFigma.stdout).scopes, ['workspace-product']);
  assert.deepEqual(JSON.parse(localFigma.stdout).profiles, ['scaffold-structure']);
  assert.deepEqual(JSON.parse(localFigma.stdout).commands, ['npm run validate:harness']);

  const pullRequestFigma = resolvePaths([figmaPath], 'pull-request');
  assert.equal(pullRequestFigma.status, 0, pullRequestFigma.stderr);
  assert.deepEqual(JSON.parse(pullRequestFigma.stdout).profiles, ['template-product']);
  assert.deepEqual(JSON.parse(pullRequestFigma.stdout).commands, [
    'npm run validate:harness',
    'npm run test:template:product',
  ]);

  const pullRequestHarness = resolvePaths(
    ['templates/workspace/.psp/harness/harness.manifest.json'],
    'pull-request',
  );
  assert.equal(pullRequestHarness.status, 0, pullRequestHarness.stderr);
  assert.deepEqual(JSON.parse(pullRequestHarness.stdout).profiles, ['template-harness']);
  assert.deepEqual(JSON.parse(pullRequestHarness.stdout).commands, [
    'npm run validate:harness',
    'npm run test:template:harness',
  ]);

  const pullRequestPackage = resolvePaths(['tests/package/init.test.mjs'], 'pull-request');
  assert.equal(pullRequestPackage.status, 0, pullRequestPackage.stderr);
  assert.deepEqual(JSON.parse(pullRequestPackage.stdout).profiles, ['scaffold-runtime-checkpoint']);
  assert.deepEqual(JSON.parse(pullRequestPackage.stdout).commands, [
    'npm run validate:harness',
    'npm run test:harness',
    'npm run test:package:fast',
  ]);
});

test('local edit remains quick while PR uses targeted template suites', () => {
  const change = resolvePaths(['templates/workspace/package.json']);
  assert.equal(change.status, 0, change.stderr);
  assert.deepEqual(JSON.parse(change.stdout).commands, [
    'npm run validate:harness',
  ]);

  const checkpoint = resolvePaths(['templates/workspace/package.json'], 'pull-request');
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  assert.deepEqual(JSON.parse(checkpoint.stdout).commands, [
    'npm run validate:harness',
    'npm run test:template:harness',
    'npm run test:template:product',
    'npm run test:template:mockcase',
    'npm run test:template:architecture',
  ]);
});

test('resolver blocks standard and full manifest drift from local edit plans', async () => {
  const standardProfileRoot = await fixture();
  const standardManifestPath = resolve(standardProfileRoot, '.psp/harness/harness.manifest.json');
  const standardManifest = JSON.parse(await readFile(standardManifestPath, 'utf8'));
  standardManifest.validationProfiles.find((profile) => profile.id === 'scaffold-governance').costClass = 'standard';
  await writeFile(standardManifestPath, JSON.stringify(standardManifest, null, 2) + '\n', 'utf8');

  const standardProfile = resolvePaths(['.github/workflows/harness-governance.yml'], 'local-edit', standardProfileRoot);
  assert.notEqual(standardProfile.status, 0, standardProfile.stderr);
  const standardProfileResult = JSON.parse(standardProfile.stdout);
  assert.equal(standardProfileResult.status, 'BLOCKED');
  assert.deepEqual(standardProfileResult.plan, []);
  assert.ok(standardProfileResult.blockers.some((item) => item.code === 'AIH_COST_POLICY_EXCEEDED'));

  const fullCommandRoot = await fixture();
  const fullManifestPath = resolve(fullCommandRoot, '.psp/harness/harness.manifest.json');
  const fullManifest = JSON.parse(await readFile(fullManifestPath, 'utf8'));
  fullManifest.commands.find((command) => command.id === 'test-harness').costClass = 'full';
  await writeFile(fullManifestPath, JSON.stringify(fullManifest, null, 2) + '\n', 'utf8');

  const fullCommand = resolvePaths(['.github/workflows/harness-governance.yml'], 'local-edit', fullCommandRoot);
  assert.notEqual(fullCommand.status, 0, fullCommand.stderr);
  const fullCommandResult = JSON.parse(fullCommand.stdout);
  assert.equal(fullCommandResult.status, 'BLOCKED');
  assert.ok(fullCommandResult.blockers.some((item) => item.code === 'AIH_COST_POLICY_EXCEEDED'));
  assert.equal(fullCommandResult.plan.some((item) => item.commandId === 'test-harness'), false);
  assert.ok(fullCommandResult.plan.every((item) => item.costClass === 'quick'));
});

test('resolver governs the continuous-integration workflow', () => {
  const execution = resolvePaths(['.github/workflows/harness-governance.yml']);
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.deepEqual(result.scopes, ['scaffold-governance']);
  assert.deepEqual(result.commands, ['npm run validate:harness', 'npm run test:harness']);
});

test('continuous-integration plan comes from Resolver commands', () => {
  const execution = spawnSync(process.execPath, ['.psp/harness/scripts/run-ci-validation.mjs', '--context', 'main', '--plan', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.status, 'READY');
  assert.equal(result.executionContext, 'main');
  assert.equal(result.completionEligible, false);
  assert.deepEqual(result.commands, [
    'npm run validate:harness',
    'npm run check:scaffold-consistency',
      'npm run test:harness',
      'npm run test:workspace:harness',
      'npm run test:workspace:product',
      'npm run test:workspace:mockcase',
      'npm run test:workspace:architecture',
    'npm run test:package',
  ]);
});

test('release validation requires an explicit isolated context and is the only credential-eligible plan', () => {
  const execution = spawnSync(process.execPath, ['.psp/harness/scripts/run-ci-validation.mjs', '--context', 'release', '--plan', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.status, 'READY');
  assert.equal(result.executionContext, 'release');
  assert.equal(result.completionEligible, true);
  assert.deepEqual(result.commands, [
    'npm run validate:harness',
    'npm run check:scaffold-consistency',
      'npm run test:harness',
      'npm run test:workspace:harness',
      'npm run test:workspace:product',
      'npm run test:workspace:mockcase',
      'npm run test:workspace:architecture',
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
  const invalidContext = resolvePaths(['README.md'], 'publish');
  assert.notEqual(invalidContext.status, 0);
  assert.match(invalidContext.stderr + invalidContext.stdout, /AIH_EXECUTION_CONTEXT_INVALID/);

});

test('Evidence Report schema gates command evidence and cache bindings', () => {
  const execution = resolvePaths(['README.md']);
  assert.equal(execution.status, 0, execution.stderr);
  const receipt = JSON.parse(execution.stdout);
  const validation = receipt.plan.map((item) => ({ ...item, status: 'PASS', durationMs: 1, blockers: [] }));
  const report = {
    protocol: receipt.protocol,
    executionContext: receipt.executionContext,
    status: 'PASS',
    scope: receipt.scopes,
    changes: ['README.md'],
    validation,
    residuals: [],
    metrics: {
      plannedCommandCount: validation.length,
      executedCommandCount: validation.length,
      cacheHitCount: 0,
      notRunCount: 0,
      totalDurationMs: validation.length,
    },
  };
  assert.equal(validateEvidenceReport(repositoryRoot, report), report);
  const invalid = structuredClone(report);
  delete invalid.validation[0].cache.bindings.executorDigest;
  assert.throws(() => validateEvidenceReport(repositoryRoot, invalid), (error) => error.code === 'AIH_SCHEMA_INVALID');
});

test('targeted workspace test runner rejects unknown suites before creating a workspace', () => {
  const execution = spawnSync(process.execPath, ['.psp/harness/scripts/run-workspace-suite.mjs', '--suite', 'unknown'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr + execution.stdout, /AIH_COMMAND_INVALID/);
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

test('validator blocks continuous integration without the declared Playwright browser install', async () => {
  const root = await fixture();
  const path = resolve(root, '.github/workflows/harness-governance.yml');
  const workflow = parseYaml(await readFile(path, 'utf8'));
  workflow.jobs['harness-governance'].steps = workflow.jobs['harness-governance'].steps.filter(
    (step) => step.run !== 'npx playwright install --with-deps chromium',
  );
  await writeFile(path, stringifyYaml(workflow), 'utf8');
  const result = await validateScaffold(root);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some((item) => item.code === 'AIH_CI_POLICY_INVALID'));
});

test('validator blocks release context from the ordinary CI workflow', async () => {
  const root = await fixture();
  const path = resolve(root, '.github/workflows/harness-governance.yml');
  const workflow = parseYaml(await readFile(path, 'utf8'));
  workflow.jobs['harness-governance'].steps.at(-1).run = 'node .psp/harness/scripts/run-ci-validation.mjs --context release';
  await writeFile(path, stringifyYaml(workflow), 'utf8');
  const result = await validateScaffold(root);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some((item) => item.code === 'AIH_CI_POLICY_INVALID'));
});
