import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const entrypoint = resolve(repositoryRoot, 'bin/pre-sdd.mjs');
const temporaryRoots = [];
const retiredFigmaOnlyImplementationSkill = ['implement', 'figma', 'lit', 'page'].join('-');

test.after(async () => {
  await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

async function materializeCanonicalApp(workspace, actor = 'ACTOR-001') {
  const project = parseYaml(await readFile(resolve(workspace, 'psp.project.yaml'), 'utf8'));
  const stage = project.stages['product-design'];
  const target = resolve(workspace, stage.root, stage.areas['canonical-ui-prototypes'].root, actor);
  await cp(resolve(workspace, '.agents/skills/product-design/canonical-ui-prototype/template'), target, { recursive: true });
  if (actor !== 'ACTOR-001') {
    const source = resolve(target, 'src/spec/canonical-ui.ts');
    await writeFile(source, (await readFile(source, 'utf8')).replace("actor: 'ACTOR-001'", "actor: '" + actor + "'"));
  }
  return target;
}

function runCli(args, cwd = repositoryRoot) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runNpm(args, cwd = repositoryRoot, environment = {}) {
  const npmCli = resolve(process.env.npm_execpath || resolve(
    dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  ));
  return spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runWorkspaceScript(script, cwd, environment = {}, forwarded = []) {
  const args = ['run', script, ...(forwarded.length ? ['--', ...forwarded] : [])];
  return runNpm(args, cwd, environment);
}

function runInstalledPreSdd(prefix, args, cwd) {
  if (process.platform === 'win32') {
    return spawnSync(process.execPath, [resolve(prefix, 'node_modules/pre-sdd/bin/pre-sdd.mjs'), ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  return spawnSync(resolve(prefix, 'bin/pre-sdd'), args, { cwd, encoding: 'utf8', windowsHide: true });
}

function workspaceRuntimeEnvironment(workspaceRoot) {
  const dependencyLoader = '--import=' + pathToFileURL(resolve(
    workspaceRoot,
    '.psp/runtime/pre-sdd/runtime/register-dependency-loader.mjs',
  )).href;
  const nodeOptions = process.env.NODE_OPTIONS || '';
  return {
    ...process.env,
    PSP_REPOSITORY_ROOT: workspaceRoot,
    AI_HARNESS_ROOT: workspaceRoot,
    PRE_SDD_PACKAGE_ROOT: repositoryRoot,
    PRE_SDD_RUNTIME_ENTRY: resolve(workspaceRoot, '.psp/runtime/pre-sdd/bin/pre-sdd.mjs'),
    PRE_SDD_DEPENDENCY_ROOT: repositoryRoot,
    PRE_SDD_DEPENDENCY_ENTRY: resolve(repositoryRoot, 'package.json'),
    NODE_OPTIONS: nodeOptions.includes(dependencyLoader)
      ? nodeOptions
      : [nodeOptions, dependencyLoader].filter(Boolean).join(' '),
  };
}

function waitForCanonicalUiReady(child, timeoutMilliseconds = 60_000) {
  return new Promise((resolveReady, rejectReady) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(new Error('等待 Canonical UI Prototype 正式预览地址超时。\n' + output));
    }, timeoutMilliseconds);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/\[READY\] (?:ACTOR-[0-9]{3}|Canonical UI Prototype) (?:独立应用)?正式预览地址：(https?:\/\/\S+)/);
      if (!match) return;
      cleanup();
      resolveReady({ url: match[1], output });
    };
    const onError = (error) => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectReady(new Error(`Canonical UI Prototype 服务提前退出：code=${code} signal=${signal}\n${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStopped) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveStopped();
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolveStopped();
    }, 5_000);
    child.once('exit', onExit);
    child.kill('SIGTERM');
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findDirectory(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === name) return join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findDirectory(join(root, entry.name), name);
      if (nested) return nested;
    }
  }
  return null;
}

test('pre-sdd init creates only the bound pure workspace', async () => {
  const target = await temporaryDirectory('pre-sdd-init-');
  const initialized = runCli(['init', target]);
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);

  const project = parseYaml(await readFile(resolve(target, 'psp.project.yaml'), 'utf8'));
  assert.equal(project.stages['product-design'].status, 'uninitialized');
  assert.equal(project.stages.mockcase.status, 'uninitialized');
  assert.equal(project.stages.mockcase.areas['mockcase-models'].root, '.psp/models/actors');
  assert.equal(project.stages['architecture-design'].status, 'uninitialized');
  const workspacePackage = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
  const workspaceLock = JSON.parse(await readFile(resolve(target, 'package-lock.json'), 'utf8'));
  const workspaceManifest = JSON.parse(await readFile(resolve(target, '.psp/harness/harness.manifest.json'), 'utf8'));
  assert.deepEqual(workspaceLock.packages[''].dependencies, workspacePackage.dependencies);
  assert.equal(workspaceManifest.version, '18.1.0');
  assert.equal(workspaceManifest.runtime.authority, 'generated-workspace-local');
  assert.equal(project.harness.protocol, 'pre-sdd-harness/v3');
  assert.equal(workspaceManifest.standard.protocol, 'pre-sdd-harness/v3');
  assert.equal(workspaceManifest.runtime.protocol, 'pre-sdd-harness/v3');
  assert.equal(workspaceManifest.runtime.dependencyLock, 'package-lock.json');
  assert.ok(workspaceManifest.artifactRegistry.some((item) => item.id === 'visual-spec' && item.authorityKind === 'internal-model'));
  assert.ok(workspaceManifest.operations.some((item) => item.id === 'apply-visual-spec' && item.artifacts.includes('visual-spec')));
  assert.ok(workspaceManifest.commands.some((item) => item.id === 'visual-spec-strict'));
  assert.ok(workspaceManifest.validationProfiles.some((item) => item.id === 'visual-spec-readiness'));
  assert.ok(workspaceManifest.projectDag.edges.some((edge) => edge.from === 'use-cases' && edge.to === 'visual-spec' && edge.type === 'handoff'));
  assert.equal(workspacePackage.scripts['apply:visual-spec'].includes('apply:visual-spec'), true);
  assert.equal(workspacePackage.scripts['validate:visual-spec'].includes('validate:visual-spec'), true);
  assert.equal(await exists(resolve(target, workspaceManifest.runtime.entrypoint)), true);
  assert.equal(await exists(resolve(target, '.psp/runtime/pre-sdd/runtime/dispatch.mjs')), true);
  assert.equal(await exists(resolve(target, '.gitignore')), true);
  assert.equal(await exists(resolve(target, '.codex/config.toml')), true);
  assert.equal(await exists(resolve(target, '.codex/hooks.json')), true);
  const codexHooks = JSON.parse(await readFile(resolve(target, '.codex/hooks.json'), 'utf8'));
  const sessionStart = codexHooks.hooks.SessionStart[0].hooks[0];
  assert.match(sessionStart.command, /git rev-parse --show-toplevel/);
  assert.match(sessionStart.commandWindows, /git rev-parse --show-toplevel/);
  const auxiliarySkills = [
    'figma-workflow',
    'implement-canonical-ui',
    'repair-canonical-ui',
    'mockcase',
    'ui-case-mock',
  ];
  for (const skill of auxiliarySkills) {
    const skillPath = `.agents/skills/${skill}/SKILL.md`;
    assert.equal(await exists(resolve(target, skillPath)), true, skillPath);
    assert.equal(await exists(resolve(target, `.agents/skills/${skill}/agents/openai.yaml`)), true, skill);
    assert.ok(workspaceManifest.codex.repositorySkills.includes(skillPath), skill);
  }
  assert.equal(
    await exists(resolve(target, '.agents/skills/figma-workflow/scripts/lib/figma-contract-validation.mjs')),
    true,
    'figma-workflow shared contract validator',
  );
  assert.equal(await exists(resolve(target, '.agents/skills/mockcase/SKILL.md')), true);
  assert.equal(await exists(resolve(target, 'MockCase/.gitkeep')), true);
  assert.equal(await exists(resolve(target, 'MockCase/.psp/models/actors')), false);
  assert.equal(workspaceManifest.artifactRegistry.some((item) =>
    item.id === 'mockcase-suite' && item.authorityKind === 'area-set'), true);
  assert.equal(workspacePackage.scripts['test:mockcase'].includes('test:mockcase'), true);
  assert.equal(await exists(resolve(target, '.agents/skills/export-marked-assets/SKILL.md')), false);
  assert.equal(workspaceManifest.codex.repositorySkills.includes('.agents/skills/export-marked-assets/SKILL.md'), false);
  assert.equal(await exists(resolve(target, `.agents/skills/${retiredFigmaOnlyImplementationSkill}/SKILL.md`)), false);
  const litSkill = await readFile(resolve(target, '.agents/skills/implement-canonical-ui/SKILL.md'), 'utf8');
  assert.match(litSkill, /Lit \+ Vite/);
  assert.match(litSkill, /Reuse Plan（复用计划）/);
  assert.match(litSkill, /已有 Contract 组件 → 已有 App Shell（应用外壳）/);
  assert.match(litSkill, /不得继续创建后一层的平行实现/);
  assert.doesNotMatch(litSkill, /\bReact\b/i);
  for (const forbidden of ['react-router', 'zustand', 'bun run', '.tsx', 'src/pages']) {
    assert.doesNotMatch(litSkill.toLowerCase(), new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), forbidden);
  }
  const productSkill = await readFile(resolve(target, '.agents/skills/product-design/SKILL.md'), 'utf8');
  const figmaSkill = await readFile(resolve(target, '.agents/skills/figma-workflow/SKILL.md'), 'utf8');
  const figmaWriteback = await readFile(resolve(target, '.agents/skills/figma-workflow/references/figma-writeback.md'), 'utf8');
  const figmaCapture = await readFile(resolve(target, '.agents/skills/figma-workflow/references/source-capture.md'), 'utf8');
  const repairSkill = await readFile(resolve(target, '.agents/skills/repair-canonical-ui/SKILL.md'), 'utf8');
  const workspaceReadme = await readFile(resolve(target, 'README.md'), 'utf8');
  assert.doesNotMatch(productSkill, /读取节点设计上下文|获取同一节点截图/);
  assert.match(productSkill, /\$figma-workflow/);
  assert.match(productSkill, /\$implement-canonical-ui/);
  assert.match(productSkill, /\$repair-canonical-ui/);
  assert.match(figmaSkill, /figma:figma-use/);
  assert.match(figmaSkill, /figma:figma-generate-library/);
  assert.match(figmaSkill, /figma:figma-design-to-code.*`get_design_context`/);
  assert.match(figmaSkill, /不得选择或改变视觉策略/);
  assert.match(figmaSkill, /不得写 HTML、CSS、路由或 `canonical-ui\.ts`/);
  assert.match(figmaSkill, /Product Design.*独立建立 Figma → Lit Mapping/);
  assert.match(figmaSkill, /冻结后的节点、Group、Variable、Component 或 Variant 发生变化/);
  assert.match(figmaWriteback, /Page、Section、Frame、Group、Component Set、Component、Instance、Image/);
  assert.match(figmaWriteback, /组件提案/);
  assert.match(figmaWriteback, /Page Coverage.*Group Integrity.*Image Group Coverage.*State Coverage.*Variant Coverage/s);
  assert.match(figmaCapture, /geometry、typography、paint、effects/i);
  assert.match(figmaCapture, /本次会话的操作系统临时目录/);
  assert.match(figmaCapture, /Registration Packet 只保存 Figma 来源事实/);
  assert.match(figmaCapture, /figma-workflow\/scripts\/validate-png-assets\.mjs/);
  assert.match(figmaCapture, /正式 Capture、下载、Ingest 和 Evidence 必须位于同一时间边界/);
  assert.match(figmaCapture, /AIH_FIGMA_FINAL_ACCEPTANCE_REQUIRED/);
  assert.match(figmaCapture, /Figma Component Contract/);
  assert.match(figmaCapture, /\| `asset`.*\| `layout`.*\| `dynamic`.*\| `ignored`/s);
  assert.match(litSkill, /`autonomous`：允许 `designSources`、`sourceParityAssertions`、Figma Mapping 与来源 Asset 为空/);
  assert.match(litSkill, /`screenshot`、`export`、`other`/);
  assert.match(litSkill, /非 Figma 组件不要求 `mappingId`、Figma Instance 身份或 Figma Variant/);
  assert.match(litSkill, /`unresolved` 必须以 `AIH_VISUAL_POLICY_UNRESOLVED` 停止/);
  assert.match(litSkill, /不得自行启动 Repair/);
  assert.match(litSkill, /\$figma-workflow/);
  assert.doesNotMatch(litSkill, /\$(?:capture-figma-design-source|organize-figma-assets|figma-component-from-design)/);
  assert.match(litSkill, /AIH_COMPONENT_IMPLEMENTATION_MISMATCH/);
  const documentedFigmaSequence = [
    '完整审计',
    '第一道人工门禁',
    '第二道人工门禁',
    'Registration Packet 通过 Component Handshake',
  ].map((text) => workspaceReadme.indexOf(text));
  assert.ok(documentedFigmaSequence.every((position) => position >= 0));
  assert.deepEqual([...documentedFigmaSequence].sort((left, right) => left - right), documentedFigmaSequence);
  assert.match(workspaceReadme, /Component Set 全量定义目录/);
  assert.match(workspaceReadme, /Variant Definition Coverage（定义覆盖）/);
  assert.match(workspaceReadme, /Usage Coverage（使用覆盖）/);
  assert.equal(await exists(resolve(target, '.agents/skills/figma-workflow/figma-design-context.schema.json')), true);
  assert.equal(await exists(resolve(target, '.agents/skills/figma-workflow/source-registration.schema.json')), true);
  const capturePlanSchema = JSON.parse(await readFile(
    resolve(target, '.agents/skills/figma-workflow/capture-plan.schema.json'),
    'utf8',
  ));
  const designContextSchema = JSON.parse(await readFile(
    resolve(target, '.agents/skills/figma-workflow/figma-design-context.schema.json'),
    'utf8',
  ));
  const registrationSchema = JSON.parse(await readFile(
    resolve(target, '.agents/skills/figma-workflow/source-registration.schema.json'),
    'utf8',
  ));
  const canonicalSchema = JSON.parse(await readFile(
    resolve(target, '.agents/skills/product-design/canonical-ui-prototype/schema.json'),
    'utf8',
  ));
  const evidenceSchema = JSON.parse(await readFile(
    resolve(target, '.agents/skills/product-design/canonical-ui-prototype/design-source-evidence.schema.json'),
    'utf8',
  ));
  assert.equal(capturePlanSchema.properties.version.const, '3.0.0');
  for (const field of ['pageCoverage', 'groupIntegrity', 'imageGroupCoverage', 'stateCoverage', 'variantCoverage', 'findings']) {
    assert.ok(capturePlanSchema.$defs.scopeAudit.required.includes(field), 'scopeAudit.' + field);
  }
  for (const field of ['scopeAuditSha256', 'operationIds']) {
    assert.ok(capturePlanSchema.$defs.writebackApproval.required.includes(field), 'writebackApproval.' + field);
  }
  assert.ok(capturePlanSchema.required.includes('finalFigmaAcceptance'));
  for (const field of ['structureSignatures', 'figmaComponentContract']) {
    assert.ok(capturePlanSchema.$defs.componentProposal.required.includes(field), 'componentProposal.' + field);
  }
  assert.deepEqual(capturePlanSchema.$defs.candidateVisualNode.properties.strategy.enum, ['asset', 'layout', 'dynamic', 'ignored']);
  assert.equal(designContextSchema.properties.version.const, '4.0.0');
  for (const field of ['rawCapture', 'componentSetCatalog', 'visualNodeCatalog']) {
    assert.ok(designContextSchema.required.includes(field), 'design-context.' + field);
  }
  assert.equal(registrationSchema.properties.version.const, '3.0.0');
  for (const field of ['designContext', 'componentHandshake']) {
    assert.ok(registrationSchema.required.includes(field), 'registration.' + field);
  }
  assert.equal(canonicalSchema.properties.version.const, '12.0.0');
  for (const field of ['reviewTools', 'componentVariantDefinitions', 'componentSourceParityAssertions']) {
    assert.ok(canonicalSchema.required.includes(field), 'canonical.' + field);
  }
  for (const field of ['definitionId', 'usages']) {
    assert.ok(canonicalSchema.$defs.componentVariantCoverage.required.includes(field), 'componentVariantCoverage.' + field);
  }
  assert.ok(canonicalSchema.$defs.componentContract.required.includes('stateAxisCoverage'));
  assert.ok(canonicalSchema.$defs.componentContract.required.includes('implementationRole'));
  assert.deepEqual(
    canonicalSchema.$defs.componentContract.properties.implementationRole.enum,
    ['app-shell', 'feature-shell', 'shared-component', 'layout-primitive', 'page-local'],
  );
  for (const field of ['targetIds', 'cssProperty']) {
    assert.ok(canonicalSchema.$defs.token.required.includes(field), 'token.' + field);
  }
  assert.ok(canonicalSchema.$defs.componentPageInstance.required.includes('origin'));
  assert.ok(canonicalSchema.$defs.stateAxis.required.includes('renderBinding'));
  assert.ok(
    evidenceSchema.$defs.item.properties.role.enum.includes('raw-design-context'),
    'design-source evidence must preserve the raw Figma design-context',
  );
  for (const removed of ['capture-figma-design-source', 'organize-figma-assets', 'figma-component-from-design']) {
    const removedPath = `.agents/skills/${removed}/SKILL.md`;
    assert.equal(await exists(resolve(target, removedPath)), false, removedPath);
    assert.equal(workspaceManifest.codex.repositorySkills.includes(removedPath), false, removed);
  }
  assert.match(repairSkill, /Evidence before edit/);
  assert.match(repairSkill, /Preserve interactive DOM/);
  assert.match(repairSkill, /source-resolution/);
  assert.match(repairSkill, /不是代码写入许可/);
  assert.match(repairSkill, /allowSubjectiveApproximation|不凭视觉感觉/);
  for (const stage of Object.values(project.stages)) {
    assert.equal(await exists(resolve(target, stage.root, '.gitkeep')), true);
    assert.deepEqual(await readdir(resolve(target, stage.root)), ['.gitkeep']);
  }
  for (const forbidden of [
    '01-product-design/PSP.md',
    '01-product-design/UC.md',
    '01-product-design/Visual-Spec.md',
    '01-product-design/HTML-Mock',
    '01-product-design/Canonical-UI-Prototypes',
    '01-product-design/.psp/models',
    '02-architecture-design/README.md',
    '02-architecture-design/技术验证',
    '02-architecture-design/.psp/models',
  ]) assert.equal(await exists(resolve(target, forbidden)), false, forbidden);
  assert.equal(await findDirectory(target, 'node_modules'), null);

  const productStrict = runCli(['harness', 'validate:product:strict', '--workspace', target]);
  assert.notEqual(productStrict.status, 0);
  assert.match(productStrict.stderr + productStrict.stdout, /AIH_STAGE_UNINITIALIZED/);
  const architectureStrict = runCli(['harness', 'validate:architecture:strict', '--workspace', target]);
  assert.notEqual(architectureStrict.status, 0);
  assert.match(architectureStrict.stderr + architectureStrict.stdout, /AIH_STAGE_UNINITIALIZED/);
});

test('scaffold source and generated workspace keep separate project contexts', async () => {
  const scaffoldProject = parseYaml(await readFile(resolve(repositoryRoot, 'psp.project.yaml'), 'utf8'));
  const templateProject = parseYaml(await readFile(resolve(repositoryRoot, 'templates/workspace/psp.project.yaml'), 'utf8'));
  assert.equal(scaffoldProject.kind, 'PSPScaffoldProject');
  assert.equal(Object.hasOwn(scaffoldProject, 'stages'), false);
  assert.equal(templateProject.kind, 'PSPProject');
  assert.ok(templateProject.stages['product-design']);
  assert.equal(templateProject.stages['product-design'].artifacts['visual-spec'].internalModel, '.psp/models/visual-spec.yaml');
  assert.ok(templateProject.stages['architecture-design']);

  for (const forbidden of [
    'product-design',
    'architecture-design',
    'figma-workflow',
    'implement-canonical-ui',
    'repair-canonical-ui',
  ]) {
    assert.equal(await exists(resolve(repositoryRoot, '.agents/skills', forbidden, 'SKILL.md')), false);
    assert.equal(await exists(resolve(repositoryRoot, 'templates/workspace/.agents/skills', forbidden, 'SKILL.md')), true);
  }
  for (const removed of ['capture-figma-design-source', 'organize-figma-assets', 'figma-component-from-design']) {
    assert.equal(await exists(resolve(repositoryRoot, '.agents/skills', removed, 'SKILL.md')), false);
    assert.equal(await exists(resolve(repositoryRoot, 'templates/workspace/.agents/skills', removed, 'SKILL.md')), false);
  }
  assert.equal(await exists(resolve(repositoryRoot, 'templates/workspace/.agents/skills/export-marked-assets/SKILL.md')), false);
  assert.equal(await findDirectory(resolve(repositoryRoot, 'templates/workspace'), 'node_modules'), null);
});

test('workspace-local runtime executes the generated workspace local domain validator', async () => {
  const target = await temporaryDirectory('pre-sdd-local-executor-');
  assert.equal(runCli(['init', target]).status, 0);
  const validator = resolve(target, '.agents/skills/product-design/scripts/validate.mjs');
  await writeFile(validator, "console.error('[AIH_EXECUTOR_AUTHORITY_INVALID] local-executor-probe');\nprocess.exitCode = 73;\n", 'utf8');

  const validation = runWorkspaceScript('validate:product', target);
  assert.notEqual(validation.status, 0);
  assert.match(validation.stderr + validation.stdout, /AIH_EXECUTOR_AUTHORITY_INVALID.*local-executor-probe/);
  assert.equal(await findDirectory(target, 'node_modules'), null);
});

test('generated workspace applies an artifact operation through its local runtime', async () => {
  const target = await temporaryDirectory('pre-sdd-artifact-transaction-');
  assert.equal(runCli(['init', target]).status, 0);
  const initialized = runWorkspaceScript('init:product', target);
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  const project = parseYaml(await readFile(resolve(target, 'psp.project.yaml'), 'utf8'));
  const stage = project.stages['product-design'];
  const binding = stage.artifacts.capabilities;
  const modelPath = resolve(target, stage.root, binding.internalModel);
  assert.deepEqual(binding.outputs.map((output) => output.path), ['UC.md']);
  const ucPath = resolve(target, stage.root, binding.outputs[0].path);
  const before = await readFile(modelPath, 'utf8');
  const candidate = parseYaml(before);
  candidate.intent.productName = '本地事务执行验证';
  const candidatePath = resolve(target, 'candidate-use-cases.yaml');
  await writeFile(candidatePath, stringifyYaml(candidate), 'utf8');
  const applied = runWorkspaceScript('apply:product-artifact', target, {}, [
    '--artifact', 'capabilities',
    '--input', candidatePath,
    '--json',
  ]);
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  const authority = await readFile(modelPath, 'utf8');
  const ucMarkdown = await readFile(ucPath, 'utf8');
  assert.match(authority, /本地事务执行验证/);
  assert.match(ucMarkdown, /本地事务执行验证/);
  assert.match(ucMarkdown, /Product Behavior（产品行为）/);
  assert.match(ucMarkdown, /Interaction Flow（正式交互流程）/);
  assert.match(ucMarkdown, /Low-Fi UI Blueprint/);
  assert.match(ucMarkdown, /### 范围内\s+- 暂无正式条目/);
  assert.match(ucMarkdown, /尚待定义稳定的产品行为/);
  assert.doesNotMatch(ucMarkdown, /```mermaid/);
  assert.doesNotMatch(ucMarkdown, /<!-- OFFICIAL|artifactRole|internalModel|## Gates|GAP-001|PSP\.md/);

  const legacyRender = runWorkspaceScript('render:product', target);
  assert.notEqual(legacyRender.status, 0);
  assert.match(legacyRender.stderr + legacyRender.stdout, /AIH_COMMAND_INVALID/);
  assert.equal(await findDirectory(target, 'node_modules'), null);
});

test('existing workspace ignores a later global runtime entry', async () => {
  const target = await temporaryDirectory('pre-sdd-pinned-runtime-');
  assert.equal(runCli(['init', target]).status, 0);
  const futureGlobalRuntime = resolve(target, 'future-global-runtime.mjs');
  await writeFile(futureGlobalRuntime, "console.error('[FUTURE_GLOBAL_RUNTIME_PROBE] should-not-run');\nprocess.exitCode = 72;\n", 'utf8');

  const validation = runWorkspaceScript('validate:harness', target, {
    PRE_SDD_RUNTIME_ENTRY: futureGlobalRuntime,
  });
  assert.equal(validation.status, 0, validation.stderr + validation.stdout);
  assert.doesNotMatch(validation.stderr + validation.stdout, /future-global-runtime-probe/);
  assert.equal(await findDirectory(target, 'node_modules'), null);
});

test('generated workspace rejects a non-v3 protocol without migration or fallback', async () => {
  const target = await temporaryDirectory('pre-sdd-protocol-cutover-');
  assert.equal(runCli(['init', target]).status, 0);
  const manifestPath = resolve(target, '.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.standard.protocol = 'unsupported-protocol';
  manifest.runtime.protocol = 'unsupported-protocol';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const validation = runWorkspaceScript('validate:harness', target);
  assert.notEqual(validation.status, 0);
  assert.match(validation.stderr + validation.stdout, /AIH_PROTOCOL_UNSUPPORTED/);
});

test('CLI rejects missing --workspace values before dispatching Harness commands', async () => {
  for (const args of [
    ['harness', 'validate:harness', '--workspace'],
    ['harness', 'validate:harness', '--workspace', '--'],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /PRE_SDD_USAGE_INVALID/);
    assert.match(result.stderr, /--workspace/);
  }
});

test('generated workspace runs its local Harness and domain test suites', async () => {
  const target = await temporaryDirectory('pre-sdd-local-tests-');
  assert.equal(runCli(['init', target]).status, 0);
  const suites = new Map([
    ['test:harness', /repository-relative path normalization rejects traversal and absolute paths/],
    ['test:product', /uninitialized product stage is a valid empty scaffold but cannot pass readiness/],
    ['test:architecture', /architecture empty scaffold passes structure and blocks readiness/],
  ]);
  for (const [command, executedTest] of suites) {
    const execution = runWorkspaceScript(command, target);
    assert.equal(execution.status, 0, command + '\n' + execution.stderr + execution.stdout);
    assert.match(execution.stderr + execution.stdout, executedTest, command + ' 未执行本地测试文件。');
  }
  assert.equal(await findDirectory(target, 'node_modules'), null);
});

test('initialization blocks owned paths without touching user files', async () => {
  const target = await temporaryDirectory('pre-sdd-collision-');
  await writeFile(resolve(target, 'README.md'), 'user owned\n', 'utf8');
  await writeFile(resolve(target, 'notes.txt'), 'keep\n', 'utf8');
  const initialized = runCli(['init', target]);
  assert.notEqual(initialized.status, 0);
  assert.match(initialized.stderr, /PRE_SDD_PATH_COLLISION/);
  assert.equal(await readFile(resolve(target, 'README.md'), 'utf8'), 'user owned\n');
  assert.equal(await readFile(resolve(target, 'notes.txt'), 'utf8'), 'keep\n');
  assert.equal(await exists(resolve(target, '.psp')), false);
});

test('workspace-local runtime typechecks and builds an initialized product without local node_modules', async () => {
  const target = await temporaryDirectory('pre-sdd-runtime-');
  assert.equal(runCli(['init', target]).status, 0);
  const product = runWorkspaceScript('init:product', target);
  assert.equal(product.status, 0, product.stderr + product.stdout);
  const app = await materializeCanonicalApp(target);
  const typecheck = runWorkspaceScript('typecheck', target);
  assert.equal(typecheck.status, 0, typecheck.stderr + typecheck.stdout);
  const build = runWorkspaceScript('workspace:build', target);
  assert.equal(build.status, 0, build.stderr + build.stdout);
  const browserAcceptance = runWorkspaceScript('validate:canonical-ui-runtime', target);
  assert.equal(browserAcceptance.status, 0, browserAcceptance.stderr + browserAcceptance.stdout);
  assert.equal(await exists(resolve(app, 'dist/index.html')), true);
  assert.equal(await findDirectory(target, 'node_modules'), null);
});

test('Canonical UI dev publishes a reachable review=0 product preview before visual readiness or repair', async () => {
  const target = await temporaryDirectory('pre-sdd-canonical-ui-dev-');
  assert.equal(runCli(['init', target]).status, 0);

  const manifest = JSON.parse(await readFile(resolve(target, '.psp/harness/harness.manifest.json'), 'utf8'));
  const preview = manifest.operations.find((item) => item.id === 'canonical-ui-dev');
  assert.equal(preview?.kind, 'preview');
  assert.equal(preview?.sessionMode, 'long-running');
  assert.equal(preview?.outputRole, 'temporary-preview');
  assert.equal(manifest.commands.some((item) => item.id === 'canonical-ui-dev'), false);
  const blocked = spawnSync(
    process.execPath,
    [resolve(target, ...preview.executor.path.split('/')), ...(preview.executor.args || [])],
    {
      cwd: target,
      env: workspaceRuntimeEnvironment(target),
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr + blocked.stdout, /AIH_STAGE_UNINITIALIZED|AIH_VISUAL_POLICY_UNRESOLVED/);

  const initialized = runWorkspaceScript('init:product', target);
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  await materializeCanonicalApp(target);
  const strict = runWorkspaceScript('validate:product:strict', target);
  assert.notEqual(strict.status, 0, strict.stderr + strict.stdout);
  assert.match(strict.stderr + strict.stdout, /AIH_VISUAL_POLICY_UNRESOLVED/);

  const child = spawn(
    process.execPath,
    [resolve(target, ...preview.executor.path.split('/')), ...(preview.executor.args || []), '--actor', 'ACTOR-001'],
    {
      cwd: target,
      env: workspaceRuntimeEnvironment(target),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  try {
    const ready = await waitForCanonicalUiReady(child);
    const reviewUrl = new URL(ready.url);
    assert.equal(reviewUrl.searchParams.get('review'), '0');
    assert.equal(reviewUrl.searchParams.size, 1);
    const response = await fetch(reviewUrl);
    assert.equal(response.status, 200, ready.output);
    assert.match(await response.text(), /<script[^>]+src="\/src\/main\.ts"/);
  } finally {
    await stopChild(child);
  }
});

test('Canonical UI dev blocks ambiguous multi-Actor preview without --actor', async () => {
  const target = await temporaryDirectory('pre-sdd-canonical-ui-multi-actor-');
  assert.equal(runCli(['init', target]).status, 0);
  const initialized = runWorkspaceScript('init:product', target);
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  await materializeCanonicalApp(target, 'ACTOR-001');
  await materializeCanonicalApp(target, 'ACTOR-002');
  const manifest = JSON.parse(await readFile(resolve(target, '.psp/harness/harness.manifest.json'), 'utf8'));
  const preview = manifest.operations.find((item) => item.id === 'canonical-ui-dev');
  const blocked = spawnSync(
    process.execPath,
    [resolve(target, ...preview.executor.path.split('/')), ...(preview.executor.args || [])],
    {
      cwd: target,
      env: workspaceRuntimeEnvironment(target),
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr + blocked.stdout, /AIH_COMMAND_INVALID/);
  assert.match(blocked.stderr + blocked.stdout, /--actor ACTOR-NNN/);
});

test('Vite and browser execution are registered in the Product Design domain Skill', async () => {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'templates/workspace/.psp/harness/harness.manifest.json'), 'utf8'));
  for (const id of ['canonical-ui-typecheck', 'canonical-ui-build', 'canonical-ui-runtime', 'canonical-ui-install-browser']) {
    const command = manifest.commands.find((item) => item.id === id);
    assert.equal(command.domain, 'product-design');
    assert.match(command.executor.path, /^\.agents\/skills\/product-design\/canonical-ui-prototype\//);
  }
  const preview = manifest.operations.find((item) => item.id === 'canonical-ui-dev');
  assert.equal(preview.kind, 'preview');
  assert.equal(preview.sessionMode, 'long-running');
  assert.equal(preview.outputRole, 'temporary-preview');
  assert.match(preview.executor.path, /^\.agents\/skills\/product-design\/canonical-ui-prototype\//);
  const review = manifest.operations.find((item) => item.id === 'canonical-ui-review');
  assert.equal(review.kind, 'review');
  assert.equal(review.evidenceVersion, '2.0.0');
  assert.equal(
    review.feedbackPacketSchema,
    '.agents/skills/product-design/canonical-ui-prototype/review-feedback-packet.schema.json',
  );
  const repair = manifest.operations.find((item) => item.id === 'canonical-ui-repair');
  assert.equal(repair.kind, 'repair');
  assert.equal(repair.npmScript, 'repair:canonical-ui');
  assert.equal(repair.artifact, 'canonical-ui-prototype');
  assert.deepEqual(repair.prerequisiteCommands, ['canonical-ui-input']);
  assert.deepEqual(repair.repairCommands, ['canonical-ui-runtime', 'canonical-ui-contract-tests']);
  assert.match(repair.executor.path, /^\.agents\/skills\/product-design\/canonical-ui-prototype\//);
  const visualApply = manifest.operations.find((item) => item.id === 'apply-visual-spec');
  assert.equal(visualApply.kind, 'artifact');
  assert.deepEqual(visualApply.artifacts, ['visual-spec']);
  assert.match(visualApply.executor.path, /^\.agents\/skills\/product-design\//);
  const assetIngest = manifest.operations.find((item) => item.id === 'ingest-figma-assets');
  assert.equal(assetIngest.kind, 'ingest');
  assert.equal(assetIngest.npmScript, 'ingest:figma-assets');
  assert.equal(assetIngest.artifact, 'canonical-ui-prototype');
  assert.match(assetIngest.executor.path, /^\.agents\/skills\/figma-workflow\//);
  assert.deepEqual(Object.keys(assetIngest.packetSchemas).sort(), ['acquisition', 'capturePlan', 'receipt', 'registration']);
  assert.equal(Object.hasOwn(assetIngest, 'profile'), false);
  assert.deepEqual(
    manifest.validationProfiles.find((item) => item.id === 'canonical-ui-quick').commands,
    ['harness', 'product-structure', 'canonical-ui-input'],
  );
  assert.deepEqual(
    manifest.validationProfiles.find((item) => item.id === 'canonical-ui-prototype').commands,
    [
      'harness',
      'product-structure',
      'canonical-ui-input',
      'canonical-ui-typecheck',
      'canonical-ui-build',
      'canonical-ui-contract-tests',
      'canonical-ui-runtime',
      'product-strict',
    ],
  );
  for (const code of [
    'AIH_SOURCE_CAPTURE_BLOCKED',
    'AIH_SOURCE_COVERAGE_FAILED',
    'AIH_ASSET_CLASSIFICATION_INCOMPLETE',
    'AIH_FIGMA_AUDIT_INCOMPLETE',
    'AIH_FIGMA_WRITEBACK_UNAPPROVED',
    'AIH_FIGMA_FINAL_ACCEPTANCE_REQUIRED',
    'AIH_FIGMA_VISUAL_POLICY_VIOLATION',
    'AIH_ASSET_MISSING',
    'AIH_ASSET_HASH_MISMATCH',
    'AIH_ASSET_CLOSURE_FAILED',
    'AIH_ASSET_CSS_BYPASS',
    'AIH_ASSET_INGEST_CONFLICT',
    'AIH_COMPONENT_ABSTRACTION_UNRESOLVED',
    'AIH_COMPONENT_MAPPING_INVALID',
    'AIH_COMPONENT_VARIANT_COVERAGE_FAILED',
    'AIH_COMPONENT_IMPLEMENTATION_MISMATCH',
    'AIH_COMPONENT_CONTRACT_INVALID',
    'AIH_COMPONENT_CONTRACT_COVERAGE_FAILED',
    'AIH_COMPONENT_CONTRACT_TEST_INVALID',
    'AIH_COMPONENT_CONTRACT_TEST_FAILED',
    'AIH_STATE_MATRIX_INVALID',
    'AIH_STATE_GALLERY_FAILED',
    'AIH_CANONICAL_UI_NETWORK_FAILED',
    'AIH_CANONICAL_UI_CONSOLE_FAILED',
    'AIH_CANONICAL_UI_VISUAL_FAILED',
    'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED',
    'AIH_CANONICAL_UI_ASSET_FAILED',
    'AIH_CANONICAL_UI_SERVER_FAILED',
    'AIH_UI_REPAIR_REQUIRED',
    'AIH_UI_REPAIR_PACKET_FAILED',
    'AIH_UI_REPAIR_EXHAUSTED',
    'AIH_UI_REPAIR_SESSION_INVALID',
    'AIH_CANONICAL_UI_FEEDBACK_PACKET_INVALID',
    'AIH_CANONICAL_UI_FEEDBACK_STALE',
  ]) assert.ok(manifest.blockers.some((item) => item.code === code), code);
});

test('Area Script execution uses a trusted npm CLI without a shell', async () => {
  for (const path of [
    'runtime/dispatch.mjs',
    'templates/workspace/.psp/harness/scripts/lib/execute-command.mjs',
  ]) {
    const source = await readFile(resolve(repositoryRoot, path), 'utf8');
    assert.match(source, /process\.env\.npm_execpath/);
    assert.match(source, /executable: process\.execPath/);
    assert.doesNotMatch(source, /shell:\s*process\.platform\s*===\s*['"]win32['"]/);
  }
});

test('package allowlist includes runtime and template but excludes root workspace state', async () => {
  const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'pre-sdd');
  assert.equal(packageJson.version, '0.4.2');
  assert.equal(packageJson.scripts.build, undefined);
  assert.equal(packageJson.bin['pre-sdd'], './bin/pre-sdd.mjs');
  assert.equal(packageJson.dependencies['axe-core'], '^4.12.1');

  const packed = runNpm(['pack', '--dry-run', '--json']);
  assert.equal(packed.status, 0, packed.stderr);
  const files = new Set(JSON.parse(packed.stdout)[0].files.map((item) => item.path));
  assert.ok(files.has('README.md'));
  assert.ok(files.has('QUICKSTART.md'));
  assert.ok(files.has('bin/pre-sdd.mjs'));
  assert.ok(files.has('runtime/dispatch.mjs'));
  assert.ok(files.has('runtime/init.mjs'));
  assert.ok(files.has('runtime/register-dependency-loader.mjs'));
  assert.ok(files.has('runtime/resolve-package-dependencies.mjs'));
  assert.ok(files.has('templates/workspace/package-lock.json'));
  assert.ok(files.has('templates/workspace/.psp/harness/harness.manifest.json'));
  assert.ok(files.has('templates/workspace/.psp/harness/HARNESS-BOUNDARY.md'));
  assert.ok(files.has('templates/workspace/.psp/harness/schemas/handoff-receipt.schema.json'));
  assert.ok(files.has('templates/workspace/.psp/harness/schemas/consistency-report.schema.json'));
  assert.ok(files.has('templates/workspace/.psp/harness/schemas/evidence-report.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/project-consistency/SKILL.md'));
  assert.ok(files.has('templates/workspace/.psp/harness/scripts/invoke-pre-sdd.mjs'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/SKILL.md'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/visual-spec/contract.yaml'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/visual-spec/schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/visual-spec/template.yaml'));
  assert.ok(files.has('templates/workspace/.agents/skills/architecture-design/SKILL.md'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/SKILL.md'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/agents/openai.yaml'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/references/figma-writeback.md'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/references/source-capture.md'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/figma-design-context.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/capture-plan.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/acquisition-packet.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/ingest-receipt.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/source-registration.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/scripts/ingest-assets.mjs'));
  assert.ok(files.has('templates/workspace/.agents/skills/figma-workflow/scripts/validate-png-assets.mjs'));
  assert.equal(files.has('templates/workspace/.agents/skills/capture-figma-design-source/SKILL.md'), false);
  assert.equal(files.has('templates/workspace/.agents/skills/organize-figma-assets/SKILL.md'), false);
  assert.equal(files.has('templates/workspace/.agents/skills/figma-component-from-design/SKILL.md'), false);
  assert.equal(files.has('templates/workspace/.agents/skills/export-marked-assets/SKILL.md'), false);
  assert.equal(files.has('templates/workspace/.agents/skills/export-marked-assets/scripts/validate-png-assets.mjs'), false);
  assert.ok(files.has('templates/workspace/.agents/skills/implement-canonical-ui/SKILL.md'));
  assert.ok(files.has('templates/workspace/.agents/skills/implement-canonical-ui/agents/openai.yaml'));
  assert.ok(files.has('templates/workspace/.agents/skills/implement-canonical-ui/references/implementation-reuse.md'));
  assert.ok(files.has('templates/workspace/.agents/skills/implement-canonical-ui/references/visual-qa.md'));
  assert.ok(files.has('templates/workspace/.agents/skills/implement-canonical-ui/references/figma-visual-qa.md'));
  assert.equal(files.has(`templates/workspace/.agents/skills/${retiredFigmaOnlyImplementationSkill}/SKILL.md`), false);
  assert.ok(files.has('templates/workspace/.agents/skills/repair-canonical-ui/SKILL.md'));
  assert.ok(files.has('templates/workspace/.agents/skills/repair-canonical-ui/agents/openai.yaml'));
  assert.ok(files.has('templates/workspace/.agents/skills/mockcase/SKILL.md'));
  assert.ok(files.has('templates/workspace/.agents/skills/mockcase/contract.yaml'));
  assert.ok(files.has('templates/workspace/.agents/skills/mockcase/runtime/extension.ts'));
  assert.ok(files.has('templates/workspace/.agents/skills/mockcase/scripts/validate.mjs'));
  assert.ok(files.has('templates/workspace/MockCase/.gitkeep'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/canonical-ui-prototype/schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/canonical-ui-prototype/review-feedback-packet.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/canonical-ui-prototype/review-evidence.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/canonical-ui-prototype/publication-receipt.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/canonical-ui-prototype/repair-packet.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/canonical-ui-prototype/design-source-evidence.schema.json'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs'));
  assert.ok(files.has('templates/workspace/.agents/skills/product-design/canonical-ui-prototype/template/src/spec/canonical-ui.ts'));
  assert.equal(files.has('templates/workspace/.agents/skills/product-design/references/figma-ingestion.md'), false);
  assert.equal([...files].some((path) => path.includes('HTML-Mock') || path.includes('html-mock')), false);
  assert.equal([...files].some((path) => path.includes('/.psp/domains/')), false);
  assert.equal([...files].some((path) => path.startsWith('.psp/')), false);
  assert.equal([...files].some((path) => path.startsWith('01-product-design/')), false);
});

test('packed software installs globally in an isolated npm prefix', async () => {
  const root = await temporaryDirectory('pre-sdd-global-');
  const packDirectory = resolve(root, 'pack');
  const prefix = resolve(root, 'prefix');
  const target = resolve(root, 'workspace');
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(prefix, { recursive: true }),
    mkdir(target, { recursive: true }),
  ]);
  const packed = runNpm(['pack', '--json', '--pack-destination', packDirectory]);
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = resolve(packDirectory, JSON.parse(packed.stdout)[0].filename);
  const installed = runNpm(['install', '--global', '--prefix', prefix, '--ignore-scripts', tarball], root);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const initialized = runInstalledPreSdd(prefix, ['init', target], target);
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  assert.equal(await exists(resolve(target, 'psp.project.yaml')), true);
  assert.equal(await findDirectory(target, 'node_modules'), null);
});

test('git package installs globally without a repository build lifecycle', async () => {
  const root = await temporaryDirectory('pre-sdd-git-');
  const packDirectory = resolve(root, 'pack');
  const sourceParent = resolve(root, 'source');
  const prefix = resolve(root, 'prefix');
  const target = resolve(root, 'workspace');
  await Promise.all([packDirectory, sourceParent, prefix, target].map((path) => mkdir(path, { recursive: true })));
  const packed = runNpm(['pack', '--json', '--pack-destination', packDirectory]);
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = resolve(packDirectory, JSON.parse(packed.stdout)[0].filename);
  const extracted = spawnSync('tar', ['-xf', tarball, '-C', sourceParent], { encoding: 'utf8', windowsHide: true });
  assert.equal(extracted.status, 0, extracted.stderr);
  const source = resolve(sourceParent, 'package');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'pre-sdd@example.invalid'],
    ['config', 'user.name', 'pre-sdd tests'],
    ['add', '.'],
    ['commit', '-m', 'package fixture'],
  ]) {
    const git = spawnSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr + git.stdout);
  }
  const gitSpec = pathToFileURL(source).href.replace(/^file:/, 'git+file:');
  const installed = runNpm(['install', '--global', '--prefix', prefix, gitSpec], root);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const initialized = runInstalledPreSdd(prefix, ['init', target], target);
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  assert.equal(await exists(resolve(target, 'psp.project.yaml')), true);
});

test('npm exec can initialize without creating a local dependency tree', async () => {
  const root = await temporaryDirectory('pre-sdd-exec-');
  const packDirectory = resolve(root, 'pack');
  const target = resolve(root, 'workspace');
  await Promise.all([packDirectory, target].map((path) => mkdir(path, { recursive: true })));
  const packed = runNpm(['pack', '--json', '--pack-destination', packDirectory]);
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = resolve(packDirectory, JSON.parse(packed.stdout)[0].filename);
  const executed = runNpm(['exec', '--yes', '--package=' + tarball, '--', 'pre-sdd', 'init', target], target);
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  assert.equal(await exists(resolve(target, 'psp.project.yaml')), true);
  assert.equal(await findDirectory(target, 'node_modules'), null);
});
