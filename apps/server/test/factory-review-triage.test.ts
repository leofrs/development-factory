import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  FactoryFlowDetailsSchema,
  SaveFactoryReviewTriageResponseSchema,
  buildFactoryReviewGate,
  buildFactoryReviewTriageScope,
  validateFactoryReviewTriageDecisions,
  type FactoryReviewSidecar,
} from '@development-factory/shared';
import { z } from 'zod';
import { readFactoryDevelopmentInputs } from '../src/factory-development.js';
import { FactoryFlowService, FactoryFlowServiceError } from '../src/factory-flow-service.js';
import { buildFactoryDevelopmentPrompt } from '../src/prompts/factory-development.js';
import { buildFactoryTestsPrompt } from '../src/prompts/factory-tests.js';
import { createReviewServer } from '../src/server.js';
import {
  REVIEW_MIGRATIONS,
  SqliteFactoryFlowRepository,
  runMigrations,
} from '../src/storage/index.js';
import {
  planningMarkdown,
  triageMarkdown,
  writeFactoryStageSidecar,
} from './fixtures/factory-stage-artifacts.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

function reviewMarkdown(verdictLine = 'Veredito: REPROVADO / REQUER AJUSTES'): string {
  return [
    '# Relatório de Code Review',
    '## Resumo Executivo',
    'Auditoria concluída sobre o diff.',
    '## Pontos Encontrados',
    '- [BLOQUEANTE] src/auth.ts:14 token expirado não retorna 401.',
    '- [SUGESTÃO] src/auth.ts:28 extrair validação de header para helper.',
    '- [NIT] src/auth.ts:35 ajustar nome de variável local.',
    '## Parecer Final',
    verdictLine,
    '',
  ].join('\n');
}

function developmentMarkdown(): string {
  return [
    '# Relatório de Implementação',
    '## Arquivos alterados',
    '- src/auth.ts',
    '## Resumo das mudanças',
    'Implementação da validação JWT.',
    '## Status dos passos do plano',
    '| Passo do Plano | Status | Observações |',
    '| --- | --- | --- |',
    '| Validar JWT | Concluído | Alterações aplicadas |',
    '',
  ].join('\n');
}

function testsMarkdown(): string {
  return [
    '# Relatório de Testes',
    '## Arquivos de teste alterados',
    '- test/auth.test.ts',
    '## Comandos executados',
    '- npm test (exit 0)',
    '## Resultados e cobertura',
    'PASS · 1/1 cenário validado.',
    '',
  ].join('\n');
}

function createReviewFindingsFixture(): FactoryReviewSidecar['findings'] {
  return [
    {
      severity: 'BLOQUEANTE',
      file: 'src/auth.ts',
      line: 14,
      explanation: 'Token expirado retorna 500 em vez de 401.',
      category: 'seguranca',
      signature: 'token-exp-500',
    },
    {
      severity: 'SUGESTÃO',
      file: 'src/auth.ts',
      line: 28,
      explanation: 'Extrair validação do cabeçalho Authorization para helper.',
    },
    {
      severity: 'NIT',
      file: 'src/auth.ts',
      line: 35,
      explanation: 'Renomear variável temporária.',
    },
  ];
}

async function prepareStageArtifactsToReview(
  service: FactoryFlowService,
  flowId: string,
  artifactsDir: string,
  reviewOverrides: Partial<FactoryReviewSidecar> = {},
): Promise<{
  specPath: string;
  planPath: string;
  devPath: string;
  testsPath: string;
  reviewPath: string;
  reviewArtifactId: string;
}> {
  const specPath = join(artifactsDir, 'spec.md');
  const planPath = join(artifactsDir, 'plan.md');
  const devPath = join(artifactsDir, 'dev.md');
  const testsPath = join(artifactsDir, 'tests.md');
  const reviewPath = join(artifactsDir, 'review.md');

  writeFileSync(specPath, triageMarkdown('Triagem pronta.'));
  writeFactoryStageSidecar(specPath, 'triage');
  writeFileSync(planPath, planningMarkdown('Plano pronto.'));
  writeFactoryStageSidecar(planPath, 'planning');
  writeFileSync(devPath, developmentMarkdown());
  writeFactoryStageSidecar(devPath, 'development', { changedFiles: ['src/auth.ts'] });
  writeFileSync(testsPath, testsMarkdown());
  writeFactoryStageSidecar(testsPath, 'tests', {
    testCases: [
      {
        id: 'T1',
        description: 'Valida JWT',
        acceptanceCriteriaIds: ['CA1'],
        status: 'passed',
      },
    ],
  });
  writeFileSync(reviewPath, reviewMarkdown());
  writeFactoryStageSidecar(reviewPath, 'review', {
    verdict: 'changes_requested',
    returnTarget: 'development',
    findings: createReviewFindingsFixture(),
    ...reviewOverrides,
  });

  await service.transitionFlow(flowId, { to: 'running', reason: 'Triagem iniciada' });
  await service.registerArtifact(flowId, {
    stage: 'triage',
    kind: 'specification',
    path: specPath,
    status: 'ready',
  });
  await service.transitionFlow(flowId, { to: 'waiting_action', reason: 'Triagem concluída' });
  await service.advanceStage(flowId);

  await service.registerArtifact(flowId, {
    stage: 'planning',
    kind: 'plan',
    path: planPath,
    status: 'ready',
  });
  await service.transitionFlow(flowId, { to: 'waiting_action', reason: 'Plano concluído' });
  await service.advanceStage(flowId);

  await service.registerArtifact(flowId, {
    stage: 'development',
    kind: 'implementation_report',
    path: devPath,
    status: 'ready',
  });
  await service.advanceStage(flowId);

  await service.registerArtifact(flowId, {
    stage: 'tests',
    kind: 'test_report',
    path: testsPath,
    status: 'ready',
  });
  await service.advanceStage(flowId);

  const reviewArtifact = await service.registerArtifact(flowId, {
    stage: 'review',
    kind: 'review_report',
    path: reviewPath,
    status: 'ready',
  });

  return {
    specPath,
    planPath,
    devPath,
    testsPath,
    reviewPath,
    reviewArtifactId: reviewArtifact.id,
  };
}

function createFakeClaudePath(dir: string): string {
  const fakeClaude = join(dir, 'claude');
  const fixturePath = join(process.cwd(), 'test', 'fixtures', 'claude.ts');
  const fixtureSource = readFileSync(fixturePath, 'utf8');
  const compiledLines = fixtureSource
    .split('\n')
    .filter(line => !line.startsWith('import type '))
    .join('\n')
    .replace('const chunks: string[] = [];', 'const chunks = [];')
    .replace('let target: string | undefined;', 'let target;')
    .replace('function emitStreamText(text: string): void {', 'function emitStreamText(text) {')
    .replace(
      'function handleLine(line: string, exit: (code: number) => void): void {',
      'function handleLine(line, exit) {',
    );
  writeFileSync(fakeClaude, compiledLines);
  chmodSync(fakeClaude, 0o755);
  return dir;
}

function initGitRepo(repoPath: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Dev Tester'], { cwd: repoPath });
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'auth.ts'), 'export function verifyToken() { return false; }\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
}

test('validateFactoryReviewTriageDecisions, buildFactoryReviewGate e buildFactoryReviewTriageScope aplicam regras de severidade e escopo', () => {
  const findings = createReviewFindingsFixture();
  const artifactId = randomUUID();

  const duplicateCheck = validateFactoryReviewTriageDecisions(findings, [
    { findingId: 'F1', action: 'approve_fix' },
    { findingId: 'F1', action: 'dismiss_false_positive' },
  ]);
  assert.equal(duplicateCheck.valid, false);

  const missingCheck = validateFactoryReviewTriageDecisions(findings, [
    { findingId: 'F99', action: 'approve_fix' },
  ]);
  assert.equal(missingCheck.valid, false);

  const promoteBlockerCheck = validateFactoryReviewTriageDecisions(findings, [
    { findingId: 'F1', action: 'promote_mandatory' },
  ]);
  assert.equal(promoteBlockerCheck.valid, false);

  const promoteNitCheck = validateFactoryReviewTriageDecisions(findings, [
    { findingId: 'F3', action: 'promote_mandatory' },
  ]);
  assert.equal(promoteNitCheck.valid, false);

  const validCheck = validateFactoryReviewTriageDecisions(findings, [
    {
      findingId: 'F1',
      action: 'dismiss_false_positive',
      justification: '  Token expirado já é tratado no middleware anterior.  ',
    },
    { findingId: 'F2', action: 'promote_mandatory' },
    { findingId: 'F3', action: 'pending' },
  ]);
  assert.equal(validCheck.valid, true);
  assert.deepEqual(validCheck.normalizedDecisions, [
    {
      findingId: 'F1',
      action: 'dismiss_false_positive',
      justification: 'Token expirado já é tratado no middleware anterior.',
    },
    { findingId: 'F2', action: 'promote_mandatory' },
  ]);

  const gateWithPromoted = buildFactoryReviewGate({
    reviewArtifactId: artifactId,
    reviewReportPath: '/tmp/review.md',
    iteration: 1,
    verdict: 'changes_requested',
    returnTarget: 'development',
    findings,
    reviewTriage: {
      reviewArtifactId: artifactId,
      iteration: 1,
      decisions: validCheck.normalizedDecisions,
      updatedAt: '2026-11-22T12:00:00.000Z',
    },
  });
  assert.equal(gateWithPromoted.counts.activeBlockers, 1);
  assert.equal(gateWithPromoted.counts.dismissed, 1);
  assert.equal(gateWithPromoted.counts.promotedMandatory, 1);
  assert.equal(gateWithPromoted.canAdvanceToPr, false);
  assert.equal(gateWithPromoted.findings[0]?.effectiveSeverity, 'DISCARDED');
  assert.equal(gateWithPromoted.findings[1]?.effectiveSeverity, 'BLOQUEANTE');
  assert.equal(gateWithPromoted.findings[1]?.isActiveBlocker, true);

  const scope = buildFactoryReviewTriageScope(gateWithPromoted);
  assert.equal(scope.mandatoryFixes.length, 1);
  assert.equal(scope.mandatoryFixes[0]?.id, 'F2');
  assert.equal(scope.mandatoryFixes[0]?.promotedFromSuggestion, true);
  assert.equal(scope.dismissedFalsePositives.length, 1);
  assert.equal(scope.dismissedFalsePositives[0]?.id, 'F1');
  assert.equal(
    scope.dismissedFalsePositives[0]?.justification,
    'Token expirado já é tratado no middleware anterior.',
  );
  assert.equal(scope.deferredSuggestions.length, 1);
  assert.equal(scope.deferredSuggestions[0]?.id, 'F3');

  const gateAllDismissed = buildFactoryReviewGate({
    reviewArtifactId: artifactId,
    reviewReportPath: '/tmp/review.md',
    iteration: 1,
    verdict: 'changes_requested',
    returnTarget: 'development',
    findings,
    reviewTriage: {
      reviewArtifactId: artifactId,
      iteration: 1,
      decisions: [
        { findingId: 'F1', action: 'dismiss_false_positive', justification: 'Falso positivo' },
      ],
      updatedAt: '2026-11-22T12:05:00.000Z',
    },
  });
  assert.equal(gateAllDismissed.counts.activeBlockers, 0);
  assert.equal(gateAllDismissed.canAdvanceToPr, true);
});

test('Migration v9 e FactoryFlowService persistem triagem, bloqueiam/liberam Bloco 06 e determinam escopo de retorno', async () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'df-review-triage-svc-'));
  const dbPath = join(artifactsDir, 'factory.db');
  const preV9Db = new DatabaseSync(dbPath);
  try {
    runMigrations(preV9Db, REVIEW_MIGRATIONS.slice(0, 8));
  } finally {
    preV9Db.close();
  }

  let tick = 0;
  const nextIso = () => new Date(Date.parse('2026-11-22T12:00:00.000Z') + ++tick * 1000).toISOString();
  const repo1 = SqliteFactoryFlowRepository.open({ dbPath });
  try {
    const service1 = new FactoryFlowService(repo1, { now: nextIso });
    const created = await service1.createFlow({
      task: { inputType: 'title', value: 'Validar triagem de findings', repoPath: '/tmp/repo-triage' },
    });
    const { specPath, planPath, devPath, testsPath, reviewPath, reviewArtifactId } =
      await prepareStageArtifactsToReview(service1, created.flow.id, artifactsDir);

    // Bloqueado inicialmente porque F1 é BLOQUEANTE ativo.
    await assert.rejects(
      () => service1.advanceStage(created.flow.id),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_STAGE_ADVANCE' &&
        error.statusCode === 409,
    );

    // Descartar F1 como falso positivo e promover F2 (SUGESTÃO) ainda mantém 1 bloqueante ativo.
    const savedPromoted = await service1.saveReviewTriage(created.flow.id, {
      decisions: [
        {
          findingId: 'F1',
          action: 'dismiss_false_positive',
          justification: 'Já tratado na camada HTTP.',
        },
        { findingId: 'F2', action: 'promote_mandatory' },
        { findingId: 'F3', action: 'approve_fix' },
      ],
    });
    assert.equal(savedPromoted.reviewGate.counts.activeBlockers, 1);
    assert.equal(savedPromoted.reviewGate.canAdvanceToPr, false);

    await assert.rejects(
      () => service1.advanceStage(created.flow.id),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_STAGE_ADVANCE' &&
        error.statusCode === 409,
    );

    // Descartar F2 também libera o avanço para PR, mas antes testamos o restart do repositório.
    repo1.close();
    const repo2 = SqliteFactoryFlowRepository.open({ dbPath });
    try {
      const service2 = new FactoryFlowService(repo2, { now: nextIso });
      const reloaded = service2.getFlow(created.flow.id);
      assert.equal(reloaded.flow.reviewTriage?.reviewArtifactId, reviewArtifactId);
      assert.equal(reloaded.reviewGate?.counts.activeBlockers, 1);
      assert.equal(reloaded.reviewGate?.findings[0]?.justification, 'Já tratado na camada HTTP.');
      assert.equal(reloaded.reviewGate?.findings[1]?.action, 'promote_mandatory');
      assert.equal(reloaded.reviewGate?.findings[2]?.action, 'approve_fix');

      // Verificar que o escopo retornado para development recebe F2 (promovido), F3 (aprovado) e F1 (descartado).
      const returned = await service2.returnStage(created.flow.id, {
        targetStage: 'development',
        approvedNotes: 'Aplicar somente os itens aprovados.',
      });
      assert.equal(returned.flow.currentStage, 'development');
      assert.equal(returned.flow.iteration, 2);

      const devDetails = service2.getFlow(created.flow.id);
      const devInputs = await readFactoryDevelopmentInputs(devDetails);
      assert.ok(devInputs.reviewTriageScope);
      assert.deepEqual(
        devInputs.reviewTriageScope.mandatoryFixes.map(item => item.id),
        ['F2', 'F3'],
      );
      assert.equal(devInputs.reviewTriageScope.mandatoryFixes[0]?.promotedFromSuggestion, true);
      assert.deepEqual(
        devInputs.reviewTriageScope.dismissedFalsePositives.map(item => item.id),
        ['F1'],
      );
      const devPrompt = buildFactoryDevelopmentPrompt({
        ...devInputs,
        task: devDetails.flow.target.value,
        reportPath: join(artifactsDir, 'dev-2.md'),
      });
      assert.match(devPrompt, /Escopo de Triagem Humana do Code Review/);
      assert.match(devPrompt, /Já tratado na camada HTTP\./);
      assert.match(devPrompt, /"promotedFromSuggestion": true/);

      const testsPrompt = buildFactoryTestsPrompt({
        task: devDetails.flow.target.value,
        understandingReportPath: specPath,
        implementationPlanPath: planPath,
        implementationReportPath: devPath,
        reviewTriageScope: devInputs.reviewTriageScope,
        reportPath: testsPath,
      });
      assert.match(testsPrompt, /Escopo de Triagem Humana do Code Review/);
      assert.match(testsPrompt, /F2/);
      assert.match(testsPrompt, /F1/);

      // Novo fluxo que descarta todos os bloqueantes avança diretamente do Review para o Bloco 06 (PR).
      const second = await service2.createFlow({
        task: { inputType: 'title', value: 'Descartar bloqueantes e liberar PR', repoPath: '/tmp/repo-triage' },
      });
      await prepareStageArtifactsToReview(service2, second.flow.id, artifactsDir);
      await service2.saveReviewTriage(second.flow.id, {
        decisions: [
          { findingId: 'F1', action: 'dismiss_false_positive', justification: 'Falso positivo confirmado' },
        ],
      });
      const advancedToPr = await service2.advanceStage(second.flow.id);
      assert.equal(advancedToPr.flow.currentStage, 'pr');
      assert.equal(advancedToPr.flow.state, 'waiting_action');

      const v9Migration = REVIEW_MIGRATIONS.find(migration => migration.version === 9);
      assert.ok(v9Migration);
      const migrationDb = new DatabaseSync(dbPath);
      try {
        v9Migration.up(migrationDb);
      } finally {
        migrationDb.close();
      }
      assert.ok(reviewPath.endsWith('review.md'));
    } finally {
      repo2.close();
    }
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('API REST /api/factory/flows/:id/review-triage e sessão Review pausada com ressalvas integram com retorno e Bloco 06', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-review-triage-api-'));
  const repoPath = join(rootDir, 'repo');
  const binDir = join(rootDir, 'bin');
  const xdgDataHome = join(rootDir, 'xdg-data');
  const dbPath = join(rootDir, 'factory.db');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(xdgDataHome, { recursive: true });
  initGitRepo(repoPath);
  createFakeClaudePath(binDir);

  const originalPath = process.env.PATH;
  const originalXdg = process.env.XDG_DATA_HOME;
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  process.env.XDG_DATA_HOME = xdgDataHome;

  const { server, shutdown, factoryFlowService, sessionManager } = createReviewServer({ dbPath });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createResponse = await fetch(`${baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'title', value: 'Triar ressalvas do Review', repoPath },
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = z.object({ flow: z.object({ id: z.string() }) }).parse(
      await createResponse.json(),
    );

    const artifactsDir = join(rootDir, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true });
    await prepareStageArtifactsToReview(factoryFlowService, created.flow.id, artifactsDir, {
      verdict: 'approved_with_warnings',
      returnTarget: null,
      findings: [
        {
          severity: 'SUGESTÃO',
          file: 'src/auth.ts',
          line: 1,
          explanation: 'Extrair validação do token.',
        },
      ],
    });

    // Origem proibida rejeitada.
    const forbiddenResponse = await fetch(
      `${baseUrl}/api/factory/flows/${created.flow.id}/review-triage`,
      {
        method: 'POST',
        headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: [] }),
      },
    );
    assert.equal(forbiddenResponse.status, 403);

    // Promover F1 [SUGESTÃO] a obrigatória via HTTP API.
    const triageResponse = await fetch(
      `${baseUrl}/api/factory/flows/${created.flow.id}/review-triage`,
      {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisions: [{ findingId: 'F1', action: 'promote_mandatory' }],
        }),
      },
    );
    assert.equal(triageResponse.status, 200);
    const triagePayload = SaveFactoryReviewTriageResponseSchema.parse(await triageResponse.json());
    assert.equal(triagePayload.reviewGate.counts.activeBlockers, 1);
    assert.equal(triagePayload.reviewGate.canAdvanceToPr, false);

    // Tentativa de avançar para PR deve ser bloqueada com HTTP 409 enquanto F1 promovido estiver ativo.
    const blockedAdvanceResponse = await fetch(
      `${baseUrl}/api/factory/flows/${created.flow.id}/advance`,
      {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    assert.equal(blockedAdvanceResponse.status, 409);

    // GET detalhes reflete a triagem persistida.
    const detailsResponse = await fetch(`${baseUrl}/api/factory/flows/${created.flow.id}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(detailsResponse.status, 200);
    const details = FactoryFlowDetailsSchema.parse(await detailsResponse.json());
    assert.equal(details.reviewGate?.findings[0]?.action, 'promote_mandatory');

    // Retornar para development iniciando sessão real com o escopo triado no prompt.
    const returnResponse = await fetch(`${baseUrl}/api/factory/flows/${created.flow.id}/return`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetStage: 'development',
        startSession: true,
        cols: 120,
        rows: 36,
      }),
    });
    assert.equal(returnResponse.status, 200);
    const returned = z
      .object({
        flow: z.object({ currentStage: z.string(), currentSessionId: z.string().nullable() }),
        session: z.object({ sessionId: z.string() }),
      })
      .parse(await returnResponse.json());
    assert.equal(returned.flow.currentStage, 'development');

    const activeSession = sessionManager.getSession(returned.session.sessionId);
    assert.ok(activeSession);
    const deadline = Date.now() + 5000;
    while (!activeSession.buffer.replay().includes('READY:') && Date.now() < deadline) {
      await new Promise(resolve => {
        setTimeout(resolve, 25);
      });
    }
    const readyLine = activeSession.buffer
      .replay()
      .split(/\r?\n/)
      .find(line => line.startsWith('READY:'));
    assert.ok(readyLine);
    const devArgs = z.object({ args: z.array(z.string()) }).parse(
      JSON.parse(readyLine.slice('READY:'.length)) as unknown,
    ).args;
    const prompt = devArgs.at(-1) ?? '';
    assert.match(prompt, /Escopo de Triagem Humana do Code Review/);
    assert.match(prompt, /Extrair validação do token\./);
    assert.match(prompt, /"promotedFromSuggestion": true/);

    sessionManager.writeInput(returned.session.sessionId, 'EXIT0');
  } finally {
    process.env.PATH = originalPath;
    if (originalXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdg;
    }
    await shutdown();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
