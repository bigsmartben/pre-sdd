import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  joinRepositoryPath,
  pathExists,
  readJson,
  readYaml,
  repositoryFile,
} from './lib/repository.mjs';

function issue(list, code, message, path) {
  list.push({ code, message, ...(path ? { path } : {}) });
}

function schemaMessages(errors) {
  return (errors || []).map((error) => (error.instancePath || '/') + ' ' + error.message).join('; ');
}

function sameMembers(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function own(object, key) {
  return object !== null && typeof object === 'object' && Object.hasOwn(object, key);
}

function validateContinuousIntegration(workflow, policy, issues) {
  const triggers = workflow.on;
  if (!triggers || !sameMembers(Object.keys(triggers), policy.triggers)) {
    issue(issues, 'AIH_CI_POLICY_INVALID', '持续集成触发器必须与 Manifest 完全一致。', policy.workflow);
  }
  if (!own(triggers, 'pull_request')) {
    issue(issues, 'AIH_CI_POLICY_INVALID', '持续集成必须在 pull_request 上运行。', policy.workflow);
  }
  const pushBranches = triggers?.push?.branches || [];
  if (!sameMembers(pushBranches, policy.protectedBranches)) {
    issue(issues, 'AIH_CI_POLICY_INVALID', '持续集成 push 分支必须与 Manifest 完全一致。', policy.workflow);
  }
  if (workflow.permissions?.contents !== 'read') {
    issue(issues, 'AIH_CI_POLICY_INVALID', '持续集成默认权限必须收敛为 contents: read。', policy.workflow);
  }

  const job = workflow.jobs?.[policy.job];
  if (!job) {
    issue(issues, 'AIH_CI_POLICY_INVALID', '持续集成缺少 Manifest 登记的治理 job：' + policy.job, policy.workflow);
    return;
  }
  if (job['runs-on'] !== policy.runsOn) {
    issue(issues, 'AIH_CI_POLICY_INVALID', '持续集成运行环境与 Manifest 不一致。', policy.workflow);
  }
  const steps = job.steps || [];
  const checkout = steps.find((step) => step.uses === policy.checkoutAction);
  if (!checkout || checkout.with?.['fetch-depth'] !== 0) {
    issue(issues, 'AIH_CI_POLICY_INVALID', '持续集成必须完整检出 Git 历史。', policy.workflow);
  }
  const setupNode = steps.find((step) => step.uses === policy.setupNodeAction);
  if (!setupNode || String(setupNode.with?.['node-version']) !== policy.nodeVersion || setupNode.with?.cache !== 'npm') {
    issue(issues, 'AIH_CI_POLICY_INVALID', '持续集成 Node.js 环境与 Manifest 不一致。', policy.workflow);
  }
  const runSteps = steps.filter((step) => typeof step.run === 'string').map((step) => step.run.trim());
  const expectedRuns = [policy.installCommand, 'node ' + policy.runner];
  if (JSON.stringify(runSteps) !== JSON.stringify(expectedRuns)) {
    issue(issues, 'AIH_CI_POLICY_INVALID', '持续集成只能安装依赖并调用 Manifest 登记的 Resolver 驱动执行器。', policy.workflow);
  }
}

async function skillNames(root, skillsRoot) {
  const directory = repositoryFile(root, skillsRoot);
  if (!await pathExists(root, skillsRoot)) return [];
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && await pathExists(root, joinRepositoryPath(skillsRoot, entry.name, 'SKILL.md'))) names.push(entry.name);
  }
  return names.sort();
}

async function pollutedDirectories(root, templateRoot, forbiddenNames) {
  const found = [];
  async function walk(relative) {
    for (const entry of await readdir(repositoryFile(root, joinRepositoryPath(templateRoot, relative)), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const next = joinRepositoryPath(relative, entry.name);
      if (forbiddenNames.includes(entry.name)) found.push(joinRepositoryPath(templateRoot, next));
      else await walk(next);
    }
  }
  await walk('');
  return found;
}

async function executorPathsExist(root, templateRoot, manifest, issues) {
  for (const item of [...(manifest.commands || []), ...(manifest.operations || [])]) {
    const executor = item.executor;
    if (!executor || executor.kind === 'area-script') continue;
    if (executor.kind === 'module') {
      const path = joinRepositoryPath(templateRoot, executor.path);
      if (!await pathExists(root, path)) issue(issues, 'AIH_ENTRYPOINT_MISSING', '模板本地 module executor 不存在：' + executor.path, path);
      continue;
    }
    if (executor.kind === 'node-test') {
      for (const pattern of executor.paths || []) {
        const slash = pattern.lastIndexOf('/');
        const directory = pattern.slice(0, slash);
        const namePattern = pattern.slice(slash + 1);
        const suffix = namePattern.startsWith('*') ? namePattern.slice(1) : namePattern;
        const boundDirectory = joinRepositoryPath(templateRoot, directory);
        if (!await pathExists(root, boundDirectory)) {
          issue(issues, 'AIH_ENTRYPOINT_MISSING', '模板本地 test executor 目录不存在：' + directory, boundDirectory);
          continue;
        }
        const matches = (await readdir(repositoryFile(root, boundDirectory))).filter((name) => name.endsWith(suffix));
        if (matches.length === 0) issue(issues, 'AIH_ENTRYPOINT_MISSING', '模板本地 test executor 没有匹配文件：' + pattern, boundDirectory);
      }
    }
  }
}

export async function validateScaffold(rootInput = process.cwd()) {
  const root = resolve(rootInput);
  const issues = [];
  let project;
  let manifest;
  let projectSchema;
  let manifestSchema;
  try {
    [project, manifest, projectSchema, manifestSchema] = await Promise.all([
      readYaml(root, 'psp.project.yaml'),
      readJson(root, '.psp/harness/harness.manifest.json'),
      readJson(root, '.psp/harness/schemas/project.schema.json'),
      readJson(root, '.psp/harness/schemas/harness-manifest.schema.json'),
    ]);
  } catch (error) {
    return { status: 'FAIL', issues: [{ code: 'AIH_MANIFEST_UNREADABLE', message: error.message }] };
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validateProject = ajv.compile(projectSchema);
  if (!validateProject(project)) issue(issues, 'AIH_SCHEMA_INVALID', '根项目绑定不符合脚手架 Schema：' + schemaMessages(validateProject.errors));
  const validateManifest = ajv.compile(manifestSchema);
  if (!validateManifest(manifest)) issue(issues, 'AIH_SCHEMA_INVALID', '根 Manifest 不符合脚手架 Schema：' + schemaMessages(validateManifest.errors));
  if (issues.length > 0) return { status: 'FAIL', issues };

  if (project.kind !== 'PSPScaffoldProject' || manifest.repositoryKind !== 'scaffold') {
    issue(issues, 'AIH_SCAFFOLD_CONTEXT_INVALID', '根项目与根 Manifest 必须明确绑定为脚手架上下文。');
  }
  if (project.harness.manifest !== manifest.entrypoints.manifest) {
    issue(issues, 'AIH_PROJECT_BINDING_INVALID', '根项目绑定的 Manifest 与 Manifest 自身入口不一致。');
  }
  const governanceModel = manifest.scaffoldPolicy.governanceModel;
  if (governanceModel.maintainerHarness.projectKind !== project.kind
    || governanceModel.userHarness.sourceRoot !== project.template.root) {
    issue(issues, 'AIH_HARNESS_BOUNDARY_INVALID', '双 Harness 项目绑定或模板来源与根项目声明不一致。');
  }

  const declaredPaths = new Set([
    ...Object.values(manifest.entrypoints),
    ...Object.values(manifest.schemas),
    manifest.adapters.codexProject,
    manifest.adapters.hookConfig,
    ...manifest.adapters.hookScripts,
    ...manifest.adapters.repositorySkills,
    ...manifest.readOrder,
    manifest.scaffoldPolicy.continuousIntegration.workflow,
    manifest.scaffoldPolicy.continuousIntegration.runner,
    project.runtime.entrypoint,
    project.runtime.dispatcher,
    project.template.root,
    joinRepositoryPath(project.template.root, project.template.project),
    joinRepositoryPath(project.template.root, project.template.manifest),
  ]);
  for (const path of declaredPaths) if (!await pathExists(root, path)) issue(issues, 'AIH_ENTRYPOINT_MISSING', '声明入口不存在：' + path, path);

  const packageJson = await readJson(root, 'package.json');
  const actualScripts = Object.keys(packageJson.scripts || {});
  if (!sameMembers(actualScripts, manifest.scaffoldPolicy.packageScripts)) {
    issue(issues, 'AIH_COMMAND_INVALID', '根 package.json scripts 必须与脚手架允许列表完全一致。');
  }
  const commandIds = manifest.commands.map((command) => command.id);
  const commandScripts = manifest.commands.map((command) => command.npmScript);
  if (new Set(commandIds).size !== commandIds.length || new Set(commandScripts).size !== commandScripts.length) {
    issue(issues, 'AIH_COMMAND_INVALID', '根工程命令 id 或 npmScript 重复。');
  }
  for (const command of manifest.commands) {
    if (!packageJson.scripts?.[command.npmScript] || command.run !== 'npm run ' + command.npmScript) {
      issue(issues, 'AIH_COMMAND_INVALID', '根工程命令未准确绑定 package.json：' + command.id);
    }
  }
  const knownCommands = new Set(commandIds);
  const profileIds = manifest.validationProfiles.map((profile) => profile.id);
  if (new Set(profileIds).size !== profileIds.length) issue(issues, 'AIH_PROFILE_INVALID', '验证 Profile id 重复。');
  for (const profile of manifest.validationProfiles) {
    if (profile.commands[0] !== 'harness' || profile.commands.some((id) => !knownCommands.has(id))) {
      issue(issues, 'AIH_PROFILE_INVALID', 'Profile 必须先运行 harness 且只能引用已登记命令：' + profile.id);
    }
  }
  const knownProfiles = new Set(profileIds);
  const scopeIds = manifest.scopes.map((scope) => scope.id);
  if (new Set(scopeIds).size !== scopeIds.length) issue(issues, 'AIH_SCOPE_INVALID', 'Scope id 重复。');
  for (const scope of manifest.scopes) {
    if (!knownProfiles.has(scope.defaultProfile) || !knownProfiles.has(scope.readinessProfile)) {
      issue(issues, 'AIH_SCOPE_INVALID', 'Scope 引用未知 Profile：' + scope.id);
    }
  }

  try {
    const workflow = await readYaml(root, manifest.scaffoldPolicy.continuousIntegration.workflow);
    validateContinuousIntegration(workflow, manifest.scaffoldPolicy.continuousIntegration, issues);
  } catch (error) {
    issue(issues, 'AIH_CI_POLICY_INVALID', '无法读取持续集成工作流：' + error.message, manifest.scaffoldPolicy.continuousIntegration.workflow);
  }

  const rootSkillPolicy = manifest.scaffoldPolicy.rootSkills;
  const actualRootSkills = await skillNames(root, rootSkillPolicy.root);
  if (!sameMembers(actualRootSkills, rootSkillPolicy.allowed)) {
    issue(issues, 'AIH_SCAFFOLD_CONTEXT_INVALID', '根仓库可发现 Skill 与允许列表不一致：' + actualRootSkills.join(', '), rootSkillPolicy.root);
  }
  const templateSkillPolicy = manifest.scaffoldPolicy.templateSkills;
  const actualTemplateSkills = await skillNames(root, templateSkillPolicy.root);
  for (const required of templateSkillPolicy.required) {
    if (!actualTemplateSkills.includes(required)) issue(issues, 'AIH_TEMPLATE_INVALID', '工作区模板缺少本地 Skill：' + required, templateSkillPolicy.root);
  }

  const instructionContents = [];
  for (const surface of manifest.scaffoldPolicy.textContracts) {
    if (!await pathExists(root, surface.path)) {
      issue(issues, 'AIH_ENTRYPOINT_MISSING', '文本契约入口不存在：' + surface.path, surface.path);
      continue;
    }
    const content = await readFile(repositoryFile(root, surface.path), 'utf8');
    instructionContents.push({ id: surface.id, content });
    for (const required of surface.requiredText) if (!content.includes(required)) issue(issues, 'AIH_SCAFFOLD_CONTEXT_INVALID', surface.id + ' 缺少声明文本：' + required, surface.path);
    for (const forbidden of surface.forbiddenText) if (content.includes(forbidden)) issue(issues, 'AIH_SCAFFOLD_CONTEXT_INVALID', surface.id + ' 含禁止文本：' + forbidden, surface.path);
  }
  for (let left = 0; left < instructionContents.length; left += 1) {
    for (let right = left + 1; right < instructionContents.length; right += 1) {
      if (instructionContents[left].content === instructionContents[right].content) issue(issues, 'AIH_SCAFFOLD_CONTEXT_INVALID', '根与模板 Agent 说明不得相同。');
    }
  }

  const templateRoot = project.template.root;
  for (const path of await pollutedDirectories(root, templateRoot, manifest.scaffoldPolicy.templatePurity.forbiddenDirectoryNames)) {
    issue(issues, 'AIH_TEMPLATE_POLLUTED', '工作区模板含禁止目录：' + path, path);
  }

  let templateProject;
  let templateManifest;
  try {
    templateProject = await readYaml(root, joinRepositoryPath(templateRoot, project.template.project));
    templateManifest = await readJson(root, joinRepositoryPath(templateRoot, project.template.manifest));
    const templateProjectSchema = await readJson(root, joinRepositoryPath(templateRoot, templateManifest.schemas.project));
    const templateManifestSchema = await readJson(root, joinRepositoryPath(templateRoot, templateManifest.schemas.manifest));
    const templateAjv = new Ajv2020({ allErrors: true, strict: false });
    const checkTemplateProject = templateAjv.compile(templateProjectSchema);
    if (!checkTemplateProject(templateProject)) issue(issues, 'AIH_TEMPLATE_INVALID', '模板项目绑定 Schema 失败：' + schemaMessages(checkTemplateProject.errors));
    const checkTemplateManifest = templateAjv.compile(templateManifestSchema);
    if (!checkTemplateManifest(templateManifest)) issue(issues, 'AIH_TEMPLATE_INVALID', '模板 Manifest Schema 失败：' + schemaMessages(checkTemplateManifest.errors));
  } catch (error) {
    issue(issues, 'AIH_TEMPLATE_INVALID', '无法读取或编译工作区模板治理：' + error.message);
  }

  if (templateProject && templateManifest) {
    if (templateProject.kind !== governanceModel.userHarness.projectKind) {
      issue(issues, 'AIH_HARNESS_BOUNDARY_INVALID', '工作区模板项目类型与 User Harness 声明不一致。');
    }
    if (templateProject.kind !== 'PSPProject' || templateProject.harness?.manifest !== project.template.manifest) {
      issue(issues, 'AIH_TEMPLATE_INVALID', '模板必须是拥有本地 Manifest 的 PSPProject。');
    }
    for (const scope of templateManifest.scopes || []) {
      for (const consumer of scope.externalConsumers || []) {
        issue(issues, 'AIH_EXTERNAL_FRAMEWORK_BOUNDARY_INVALID', '工作区模板不得绑定外部消费者：' + consumer, joinRepositoryPath(templateRoot, project.template.manifest));
      }
    }
    const marker = manifest.scaffoldPolicy.templatePurity.stageMarker;
    for (const [stageId, stage] of Object.entries(templateProject.stages || {})) {
      if (stage.status !== 'uninitialized') issue(issues, 'AIH_TEMPLATE_INVALID', '模板阶段必须是 uninitialized：' + stageId);
      const stagePath = joinRepositoryPath(templateRoot, stage.root);
      if (!await pathExists(root, stagePath)) {
        issue(issues, 'AIH_TEMPLATE_INVALID', '模板阶段根目录不存在：' + stageId, stagePath);
        continue;
      }
      const entries = (await readdir(repositoryFile(root, stagePath))).sort();
      if (!sameMembers(entries, [marker])) issue(issues, 'AIH_TEMPLATE_POLLUTED', '模板阶段根目录只能包含 ' + marker + '：' + stageId, stagePath);
    }
    for (const domain of templateManifest.domainRegistry || []) {
      if (!domain.root.startsWith('.agents/skills/') || Object.hasOwn(domain, 'mirrors')) {
        issue(issues, 'AIH_TEMPLATE_INVALID', '生成工作区领域 Skill 必须是本地绑定且不得声明镜像：' + domain.id);
      }
      if (!await pathExists(root, joinRepositoryPath(templateRoot, domain.root, 'SKILL.md'))) {
        issue(issues, 'AIH_ENTRYPOINT_MISSING', '模板领域 Skill 入口不存在：' + domain.root, joinRepositoryPath(templateRoot, domain.root));
      }
    }
    const templatePackage = await readJson(root, joinRepositoryPath(templateRoot, 'package.json'));
    for (const item of [...(templateManifest.commands || []), ...(templateManifest.operations || [])]) {
      if (!templatePackage.scripts?.[item.npmScript]) issue(issues, 'AIH_COMMAND_INVALID', '模板 Manifest 命令未绑定本地 package.json：' + item.npmScript);
    }
    await executorPathsExist(root, templateRoot, templateManifest, issues);
  }

  return { status: issues.length === 0 ? 'PASS' : 'FAIL', issues };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rootIndex = process.argv.indexOf('--root');
  const result = await validateScaffold(rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd());
  if (process.argv.includes('--json')) console.log(JSON.stringify({ status: result.status, blockers: result.issues }, null, 2));
  else if (result.status === 'PASS') console.log('[PASS] pre-sdd 脚手架 Harness 校验通过。');
  else for (const item of result.issues) console.error('[' + item.code + '] ' + item.message + (item.path ? ' (' + item.path + ')' : ''));
  if (result.status !== 'PASS') process.exitCode = 1;
}
