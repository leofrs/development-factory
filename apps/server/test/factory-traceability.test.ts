import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  buildFactoryTraceabilityMatrix,
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
  FactoryFlowApiErrorResponseSchema,
  FactoryFlowTraceabilityMatrixSchema,
  type FactoryDevelopmentSidecar,
  type FactoryDiffFile,
  type FactoryPlanningApproval,
  type FactoryPlanningSidecar,
  type FactoryReviewSidecar,
  type FactoryTestsSidecar,
  type FactoryTriageSidecar,
} from '@development-factory/shared';
import { provisionFactoryWorktree } from '../src/factory-worktree.js';
import { createReviewServer } from '../src/server.js';
import { writeFactoryStageSidecar } from './fixtures/factory-stage-artifacts.js';

const origin = 'http://localhost:5173';
const sidecarVersion = FACTORY_STAGE_SIDECAR_CONTRACT_VERSION;

function git(path: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function diffFile(
  path: string,
  change: FactoryDiffFile['change'] = 'modified',
  additions = 10,
  deletions = 2,
): FactoryDiffFile {
  return {
    path,
    change,
    untracked: change === 'added',
    additions,
    deletions,
    binary: false,
  };
}

test('buildFactoryTraceabilityMatrix conecta CA -> Plano -> Arquivo -> Teste -> Review sem lacunas', () => {
  const triage: FactoryTriageSidecar = {
    contractVersion: sidecarVersion,
    stage: 'triage',
    acceptanceCriteria: [
      { id: 'CA1', description: 'Permitir autenticação via token JWT no endpoint de login.' },
      { id: 'CA2', description: 'Registrar auditoria de acessos em caso de falha.' },
      { id: 'CA3', description: 'Critério removido na aprovação humana.' },
    ],
    negativeScope: ['Não alterar fluxo de OAuth'],
    blockers: [],
    jiraContext: null,
    technicalContext: 'Investigar auth e audit.',
  };

  const planningApproval: FactoryPlanningApproval = {
    approvedAt: '2026-11-22T10:00:00.000Z',
    decisions: [],
    acceptanceCriteria: [
      { id: 'CA1', description: 'Permitir autenticação via token JWT no endpoint de login.', approved: true },
      { id: 'CA2', description: 'Registrar auditoria de acessos em caso de falha.', approved: true },
      { id: 'CA3', description: 'Critério removido na aprovação humana.', approved: false },
    ],
  };

  const planning: FactoryPlanningSidecar = {
    contractVersion: sidecarVersion,
    stage: 'planning',
    pendingDecisions: [],
    plannedFiles: ['apps/server/src/auth/jwt.ts', 'apps/server/src/audit/login-audit.ts'],
    testPlan: [
      'CA1: Validar emissão e verificação de token JWT.',
      'CA2: Validar gravação de auditoria após erro de senha.',
    ],
  };

  const development: FactoryDevelopmentSidecar = {
    contractVersion: sidecarVersion,
    stage: 'development',
    changedFiles: ['apps/server/src/auth/jwt.ts', 'apps/server/src/audit/login-audit.ts'],
    summary: 'Implementado login JWT e auditoria.',
    deviations: [],
  };

  const tests: FactoryTestsSidecar = {
    contractVersion: sidecarVersion,
    stage: 'tests',
    status: 'passed',
    executedCommands: [{ command: ['npm', 'test'], exitCode: 0 }],
    testCases: [
      {
        id: 'T1',
        description: 'Valida token JWT gerado no login.',
        acceptanceCriteriaIds: ['CA1'],
        status: 'passed',
      },
      {
        id: 'T2',
        description: 'Valida registro de auditoria ao falhar login.',
        acceptanceCriteriaIds: ['CA2'],
        status: 'passed',
      },
    ],
    coverage: { linesPercent: 92, branchesPercent: 85 },
  };

  const review: FactoryReviewSidecar = {
    contractVersion: sidecarVersion,
    stage: 'review',
    verdict: 'approved_with_warnings',
    returnTarget: null,
    findings: [
      {
        severity: 'SUGESTÃO',
        file: 'apps/server/src/auth/jwt.ts',
        line: 24,
        explanation: 'Extrair constante de tempo de expiração do JWT.',
      },
    ],
  };

  const matrix = FactoryFlowTraceabilityMatrixSchema.parse(
    buildFactoryTraceabilityMatrix({
      triage,
      planning,
      planningApproval,
      development,
      tests,
      review,
      worktreeAvailable: true,
      worktreeFiles: [
        diffFile('apps/server/src/auth/jwt.ts', 'modified', 28, 4),
        diffFile('apps/server/src/audit/login-audit.ts', 'added', 40, 0),
        diffFile('apps/server/test/jwt.test.ts', 'added', 35, 0),
      ],
    }),
  );

  assert.equal(matrix.summary.totalCriteria, 2);
  assert.equal(matrix.summary.coveredCriteria, 2);
  assert.equal(matrix.summary.criteriaWithGaps, 0);
  assert.equal(matrix.summary.criteriaWithoutFiles, 0);
  assert.equal(matrix.summary.criteriaWithoutTests, 0);
  assert.deepEqual(matrix.excludedCriteria, [
    { id: 'CA3', description: 'Critério removido na aprovação humana.' },
  ]);

  const [ca1, ca2] = matrix.rows;
  assert(ca1 && ca2);
  assert.equal(ca1.criterion.id, 'CA1');
  assert.equal(ca1.criterion.approved, true);
  assert.deepEqual(ca1.plan.testPlanItems, ['CA1: Validar emissão e verificação de token JWT.']);
  assert.deepEqual(ca1.plan.plannedFiles, ['apps/server/src/auth/jwt.ts']);
  assert.deepEqual(
    ca1.files.map(file => file.path),
    ['apps/server/src/auth/jwt.ts', 'apps/server/test/jwt.test.ts'],
  );
  assert.equal(ca1.tests.cases[0]?.id, 'T1');
  assert.equal(ca1.tests.cases[0]?.status, 'passed');
  assert.equal(ca1.review.status, 'warnings');
  assert.equal(ca1.review.findings[0]?.file, 'apps/server/src/auth/jwt.ts');
  assert.deepEqual(ca1.gaps, []);

  assert.equal(ca2.criterion.id, 'CA2');
  assert.deepEqual(ca2.files.map(file => file.path), ['apps/server/src/audit/login-audit.ts']);
  assert.equal(ca2.tests.cases[0]?.id, 'T2');
  assert.equal(ca2.review.status, 'clean');
  assert.deepEqual(ca2.gaps, []);
  assert.deepEqual(matrix.unlinked.changedFiles, []);
  assert.deepEqual(matrix.unlinked.testCases, []);
  assert.deepEqual(matrix.unlinked.findings, []);
});

test('buildFactoryTraceabilityMatrix sinaliza lacunas de arquivo, teste, plano, falhas e itens sem vínculo', () => {
  const triage: FactoryTriageSidecar = {
    contractVersion: sidecarVersion,
    stage: 'triage',
    acceptanceCriteria: [
      { id: 'CA1', description: 'Exportar relatório em CSV.' },
      { id: 'CA2', description: 'Enviar e-mail de notificação após exportação.' },
      { id: 'CA3', description: 'Registrar métricas de tempo de resposta.' },
    ],
    negativeScope: [],
    blockers: [],
    jiraContext: null,
    technicalContext: 'Sem pistas.',
  };

  const planning: FactoryPlanningSidecar = {
    contractVersion: sidecarVersion,
    stage: 'planning',
    pendingDecisions: [],
    plannedFiles: ['src/csv-exporter.ts', 'src/email-notifier.ts'],
    testPlan: [
      'CA1: Testar exportação CSV em src/csv-exporter.ts.',
      'CA2: Testar envio de e-mail em src/email-notifier.ts.',
      'Cenário genérico sem identificação de critério.',
    ],
  };

  const development: FactoryDevelopmentSidecar = {
    contractVersion: sidecarVersion,
    stage: 'development',
    changedFiles: ['src/csv-exporter.ts', 'src/unrelated-helper.ts'],
    summary: 'Exportador implementado.',
    deviations: [],
  };

  const tests: FactoryTestsSidecar = {
    contractVersion: sidecarVersion,
    stage: 'tests',
    status: 'failed',
    executedCommands: [{ command: ['npm', 'test'], exitCode: 1 }],
    testCases: [
      {
        id: 'T1',
        description: 'Valida exportação CSV.',
        acceptanceCriteriaIds: ['CA1'],
        status: 'failed',
      },
      {
        id: 'T2',
        description: 'Valida caso órfão.',
        acceptanceCriteriaIds: ['CA99'],
        status: 'skipped',
      },
    ],
    coverage: null,
  };

  const review: FactoryReviewSidecar = {
    contractVersion: sidecarVersion,
    stage: 'review',
    verdict: 'changes_requested',
    returnTarget: 'development',
    findings: [
      {
        severity: 'BLOQUEANTE',
        file: 'src/csv-exporter.ts',
        line: 12,
        explanation: 'Escapar aspas duplas ao gerar CSV.',
        category: 'seguranca',
        signature: 'csv-escape',
      },
      {
        severity: 'NIT',
        file: 'src/other-file.ts',
        line: 5,
        explanation: 'Ajustar nomenclatura local.',
      },
    ],
  };

  const matrix = FactoryFlowTraceabilityMatrixSchema.parse(
    buildFactoryTraceabilityMatrix({
      triage,
      planning,
      development,
      tests,
      review,
      worktreeAvailable: false,
      worktreeFiles: [],
    }),
  );

  assert.equal(matrix.summary.totalCriteria, 3);
  assert.equal(matrix.summary.coveredCriteria, 0);
  assert.equal(matrix.summary.criteriaWithGaps, 3);
  assert.equal(matrix.summary.criteriaWithoutFiles, 2);
  assert.equal(matrix.summary.criteriaWithoutTests, 2);
  assert.equal(matrix.summary.blockingFindings, 1);

  const [ca1, ca2, ca3] = matrix.rows;
  assert(ca1 && ca2 && ca3);

  assert.equal(ca1.criterion.approved, null);
  assert.equal(ca1.review.status, 'blocked');
  assert.deepEqual(
    ca1.gaps.map(gap => gap.code),
    ['failing_test_case', 'blocking_review_finding'],
  );

  assert.deepEqual(
    ca2.gaps.map(gap => gap.code),
    ['missing_changed_file', 'missing_test_case'],
  );

  assert.deepEqual(
    ca3.gaps.map(gap => gap.code),
    ['missing_plan_link', 'missing_changed_file', 'missing_test_case'],
  );

  assert.deepEqual(matrix.unlinked.changedFiles.map(file => file.path), ['src/unrelated-helper.ts']);
  assert.deepEqual(matrix.unlinked.testPlanItems, ['Cenário genérico sem identificação de critério.']);
  assert.deepEqual(matrix.unlinked.testCases.map(tc => tc.id), ['T2']);
  assert.deepEqual(matrix.unlinked.findings.map(finding => finding.file), ['src/other-file.ts']);
});

async function setUpFlow(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'df-flow-traceability-'));
  const repoPath = join(root, 'repository');
  mkdirSync(repoPath);
  const xdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, 'xdg-data');
  const { server, factoryFlowService, shutdown } = createReviewServer({
    dbPath: join(root, 'flow.db'),
  });
  context.after(async () => {
    try {
      await shutdown();
    } finally {
      if (xdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = xdgDataHome;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  git(repoPath, 'init', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'Test User');
  writeFileSync(join(repoPath, 'src-billing.ts'), 'export const total = 1;\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'Base');

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');

  const task = { repoPath, inputType: 'title', value: 'Rastreabilidade de fluxo' };
  const { flow } = await factoryFlowService.createFlow({ task });
  const { worktreePath, baseBranch, branchName } = await provisionFactoryWorktree({
    repoPath,
    flowId: flow.id,
    target: flow.target,
  });
  await factoryFlowService.updateWorktreeMetadata(flow.id, { worktreePath, baseBranch, branchName });

  return {
    root,
    worktreePath,
    flow,
    factoryFlowService,
    baseUrl: `http://127.0.0.1:${address.port}/api/factory/flows`,
  };
}

test('GET /api/factory/flows/:id/traceability cruza sidecars com o worktree real e degrada sem worktree', async context => {
  const { root, worktreePath, flow, factoryFlowService, baseUrl } = await setUpFlow(context);

  const triagePath = join(root, '01-triage.md');
  const planningPath = join(root, '02-planning.md');
  const devPath = join(root, '03-dev.md');
  const testsPath = join(root, '04-tests.md');
  const reviewPath = join(root, '05-review.md');

  writeFactoryStageSidecar(triagePath, 'triage', {
    acceptanceCriteria: [
      { id: 'CA1', description: 'Atualizar cálculo de faturamento em src-billing.ts.' },
      { id: 'CA2', description: 'Gerar recibo em PDF.' },
    ],
  });
  writeFactoryStageSidecar(planningPath, 'planning', {
    plannedFiles: ['src-billing.ts'],
    testPlan: ['CA1: Testar cálculo em src-billing.ts.'],
  });
  writeFactoryStageSidecar(devPath, 'development', {
    changedFiles: ['src-billing.ts'],
  });
  writeFactoryStageSidecar(testsPath, 'tests', {
    status: 'passed',
    testCases: [
      {
        id: 'T1',
        description: 'Valida cálculo em src-billing.ts',
        acceptanceCriteriaIds: ['CA1'],
        status: 'passed',
      },
    ],
  });
  writeFactoryStageSidecar(reviewPath, 'review', {
    verdict: 'approved_with_warnings',
    returnTarget: null,
    findings: [
      {
        severity: 'NIT',
        file: 'src-billing.ts',
        line: 1,
        explanation: 'Renomear constante se necessário.',
      },
    ],
  });

  await factoryFlowService.registerArtifact(flow.id, {
    stage: 'triage', kind: 'specification', path: triagePath, status: 'ready', iteration: 0,
  });
  await factoryFlowService.registerArtifact(flow.id, {
    stage: 'planning', kind: 'plan', path: planningPath, status: 'ready', iteration: 0,
  });
  await factoryFlowService.registerArtifact(flow.id, {
    stage: 'development', kind: 'implementation_report', path: devPath, status: 'ready', iteration: 1,
  });
  await factoryFlowService.registerArtifact(flow.id, {
    stage: 'tests', kind: 'test_report', path: testsPath, status: 'ready', iteration: 1,
  });
  await factoryFlowService.registerArtifact(flow.id, {
    stage: 'review', kind: 'review_report', path: reviewPath, status: 'ready', iteration: 1,
  });

  writeFileSync(join(worktreePath, 'src-billing.ts'), 'export const total = 2;\nexport const tax = 0.1;\n');

  const noOrigin = await fetch(`${baseUrl}/${flow.id}/traceability`);
  assert.equal(noOrigin.status, 403);

  const invalidId = await fetch(`${baseUrl}/nao-uuid/traceability`, { headers: { Origin: origin } });
  assert.equal(invalidId.status, 400);
  assert.equal(
    FactoryFlowApiErrorResponseSchema.parse(await invalidId.json()).error.code,
    'FACTORY_FLOW_INVALID_INPUT',
  );

  const missingFlow = await fetch(
    `${baseUrl}/00000000-0000-4000-8000-000000000000/traceability`,
    { headers: { Origin: origin } },
  );
  assert.equal(missingFlow.status, 404);

  const response = await fetch(`${baseUrl}/${flow.id}/traceability`, {
    headers: { Origin: origin },
  });
  assert.equal(response.status, 200);
  const matrix = FactoryFlowTraceabilityMatrixSchema.parse(await response.json());
  assert.equal(matrix.contractVersion, FACTORY_FLOW_CONTRACT_VERSION);
  assert.equal(matrix.worktreeAvailable, true);
  assert.equal(matrix.summary.totalCriteria, 2);
  assert.equal(matrix.summary.coveredCriteria, 1);
  assert.equal(matrix.summary.criteriaWithGaps, 1);

  const ca1 = matrix.rows.find(row => row.criterion.id === 'CA1');
  const ca2 = matrix.rows.find(row => row.criterion.id === 'CA2');
  assert(ca1 && ca2);
  assert.equal(ca1.files[0]?.path, 'src-billing.ts');
  assert.equal(ca1.files[0]?.changedInWorktree, true);
  assert.equal(ca1.files[0]?.worktreeChange, 'modified');
  assert.equal(ca1.files[0]?.additions, 2);
  assert.equal(ca1.files[0]?.deletions, 1);
  assert.equal(ca1.review.findings[0]?.severity, 'NIT');
  assert.deepEqual(ca1.gaps, []);
  assert.deepEqual(
    ca2.gaps.map(gap => gap.code),
    ['missing_plan_link', 'missing_changed_file', 'missing_test_case'],
  );

  await factoryFlowService.updateWorktreeMetadata(flow.id, { worktreePath: null });
  const withoutWorktreeResponse = await fetch(`${baseUrl}/${flow.id}/traceability`, {
    headers: { Origin: origin },
  });
  assert.equal(withoutWorktreeResponse.status, 200);
  const withoutWorktree = FactoryFlowTraceabilityMatrixSchema.parse(
    await withoutWorktreeResponse.json(),
  );
  assert.equal(withoutWorktree.worktreeAvailable, false);
  assert.equal(withoutWorktree.rows[0]?.files[0]?.changedInDevelopment, true);
  assert.equal(withoutWorktree.rows[0]?.files[0]?.changedInWorktree, false);
});
