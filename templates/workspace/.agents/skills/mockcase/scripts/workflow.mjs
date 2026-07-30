import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { validateCases } from '../../use-case-generation/scripts/validate.mjs';

const suiteSchema = JSON.parse(await readFile(new URL('../suite.schema.json', import.meta.url), 'utf8'));
const validateSuiteSchema = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
}).compile(suiteSchema);
const USER_IDENTITY = /^user:\S+$/;
const UTC_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/;
const OPERATIONS = new Set(['analyze', 'initialize', 'apply', 'review', 'verify']);

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function digest(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function validateSuite(suite, cases, inputDigest) {
  const blockers = [];
  if (JSON.stringify(suite)?.match(/(?:domSelector|querySelector|stateMatrix|runtimeOperation)/i)) {
    blockers.push({ code: 'MOCKCASE_PRODUCT_COUPLED', message: 'MockCase 不得改写产品 DOM 或成为产品状态模型。' });
  }
  if (!validateSuiteSchema(suite)) {
    for (const error of validateSuiteSchema.errors ?? []) {
      blockers.push({
        code: 'MOCKCASE_CONTRACT_INVALID',
        message: `MockCase Suite Schema 无效：${error.message ?? error.keyword}。`,
        location: error.instancePath || 'suite',
      });
    }
    return blockers;
  }
  if (suite.inputLock?.uiCasesDigest !== inputDigest) {
    blockers.push({ code: 'MOCKCASE_INPUT_STALE', message: 'Suite 未锁定当前 UI Cases。' });
  }
  const fixtures = new Set((suite.fixtures ?? []).map((item) => item.fixtureId));
  const businessCases = new Set(cases.businessCases.map((item) => item.caseId));
  for (const scenario of suite.scenarios ?? []) {
    if (!businessCases.has(scenario.businessCaseId)) {
      blockers.push({ code: 'MOCKCASE_TRACEABILITY_MISSING', message: `未知 Business Case：${scenario.businessCaseId}` });
    }
    for (const id of scenario.fixtureIds) {
      if (!fixtures.has(id)) blockers.push({ code: 'MOCKCASE_FIXTURE_MISSING', message: `未知 Fixture：${id}` });
    }
  }
  return blockers;
}

function validateReviewEvidence(evidence, suite, suiteDigest, inputDigest) {
  const blockers = [];
  if (
    evidence?.schemaVersion !== 'psp.dev/mockcase-evidence/v2'
    || evidence.suiteVersion !== suite.version
    || evidence.suiteDigest !== suiteDigest
    || evidence.uiCasesDigest !== inputDigest
    || !USER_IDENTITY.test(evidence.reviewedBy ?? '')
    || !UTC_TIMESTAMP.test(evidence.reviewedAt ?? '')
    || Number.isNaN(Date.parse(evidence.reviewedAt ?? ''))
  ) {
    blockers.push({
      code: 'MOCKCASE_REVIEW_EVIDENCE_INVALID',
      message: 'Review Evidence 未绑定当前 Suite、UI Cases、用户身份或有效时间。',
    });
  }
  if (!['reviewed', 'verified'].includes(suite.status)) {
    blockers.push({ code: 'MOCKCASE_NOT_REVIEWED', message: 'Suite 尚未完成用户 Review。' });
  }
  return blockers;
}

function output(status, blockers = [], extra = {}) {
  console.log(JSON.stringify({ status, blockers, ...extra }));
  process.exitCode = status === 'PASS' ? 0 : 1;
}

try {
  const root = resolve(argument('root', process.cwd()));
  const casesPath = resolve(root, argument('cases', 'Cases/ui-cases.json'));
  const casesSource = await readFile(casesPath);
  const cases = JSON.parse(casesSource);
  const caseBlockers = validateCases(cases);
  if (caseBlockers.length) output('BLOCKED', caseBlockers);
  else {
    const inputDigest = digest(casesSource);
    const operation = argument('operation', 'analyze');
    const suitePath = argument('suite', 'MockCase/suite.json');
    if (!OPERATIONS.has(operation)) {
      output('BLOCKED', [{ code: 'MOCKCASE_OPERATION_INVALID', message: `未知 MockCase 操作：${operation}` }]);
    } else if (operation === 'analyze') {
      output('PASS', [], {
        inputDigest,
        businessCases: cases.businessCases.map((item) => item.caseId),
        componentCases: cases.componentCases.map((item) => item.caseId),
        gaps: cases.gaps,
      });
    } else if (operation === 'initialize') {
      const suite = {
        schemaVersion: 'psp.dev/mockcase-suite/v2',
        version: '0.1.0',
        inputLock: { uiCasesDigest: inputDigest },
        status: 'draft',
        fixtures: [],
        scenarios: [],
      };
      await commitManagedWrites({
        root,
        ownerId: 'mockcase-initialize',
        writes: [{ target: suitePath, content: JSON.stringify(suite, null, 2) + '\n' }],
      });
      output('PASS', [], { suite: suitePath });
    } else {
      const candidatePath = resolve(root, argument('candidate', suitePath));
      const candidateSource = await readFile(candidatePath);
      const suite = JSON.parse(candidateSource);
      const blockers = validateSuite(suite, cases, inputDigest);
      if (blockers.length) output('BLOCKED', blockers);
      else if (operation === 'apply') {
        if (argument('confirm', '') !== 'APPLY_MOCKCASE_CANDIDATE') {
          output('BLOCKED', [{ code: 'MOCKCASE_APPLY_NOT_AUTHORIZED', message: '缺少精确用户授权。' }]);
        } else {
          await commitManagedWrites({
            root,
            ownerId: 'mockcase-apply',
            writes: [{ target: suitePath, content: JSON.stringify(suite, null, 2) + '\n' }],
          });
          output('PASS', [], { suite: suitePath });
        }
      } else if (operation === 'review') {
        const reviewedSuite = { ...suite, status: 'reviewed' };
        const suiteContent = JSON.stringify(reviewedSuite, null, 2) + '\n';
        const evidence = {
          schemaVersion: 'psp.dev/mockcase-evidence/v2',
          suiteVersion: reviewedSuite.version,
          suiteDigest: digest(Buffer.from(suiteContent)),
          uiCasesDigest: inputDigest,
          reviewedBy: argument('reviewed-by', ''),
          reviewedAt: new Date().toISOString(),
        };
        if (!USER_IDENTITY.test(evidence.reviewedBy)) {
          output('BLOCKED', [{ code: 'MOCKCASE_REVIEW_NOT_AUTHORIZED', message: 'reviewed-by 必须是 user:<identity>。' }]);
        } else {
          await commitManagedWrites({
            root,
            ownerId: 'mockcase-review',
            writes: [
              { target: suitePath, content: suiteContent },
              { target: 'MockCase/review-evidence.json', content: JSON.stringify(evidence, null, 2) + '\n' },
            ],
          });
          output('PASS', [], { evidence: 'MockCase/review-evidence.json' });
        }
      } else if (operation === 'verify') {
        let evidence;
        try {
          evidence = JSON.parse(await readFile(resolve(root, argument('evidence', 'MockCase/review-evidence.json')), 'utf8'));
        } catch (error) {
          output('BLOCKED', [{
            code: 'MOCKCASE_REVIEW_EVIDENCE_INVALID',
            message: error instanceof Error ? error.message : String(error),
          }]);
        }
        if (evidence) {
          const evidenceBlockers = validateReviewEvidence(evidence, suite, digest(candidateSource), inputDigest);
          output(
            evidenceBlockers.length ? 'BLOCKED' : 'PASS',
            evidenceBlockers,
            { suite: suitePath, inputDigest },
          );
        }
      }
    }
  }
} catch (error) {
  output('BLOCKED', [{ code: error?.code || 'MOCKCASE_WORKFLOW_FAILED', message: error instanceof Error ? error.message : String(error) }]);
}
