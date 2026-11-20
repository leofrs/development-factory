import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_STAGE_ORDER,
} from '@development-factory/shared';
import { FactoryFlowService, FactoryFlowServiceError } from '../src/factory-flow-service.js';
import {
  REVIEW_MIGRATIONS,
  SqliteFactoryFlowRepository,
} from '../src/storage/index.js';

function createTempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'df-factory-storage-'));
  return { dir, dbPath: join(dir, 'factory-test.db') };
}

function createClock(startIso = '2026-11-19T12:00:00.000Z'): () => string {
  let ms = Date.parse(startIso);
  return () => {
    const iso = new Date(ms).toISOString();
    ms += 1000;
    return iso;
  };
}

test('SqliteFactoryFlowRepository aplica migrations e persiste múltiplos fluxos entre reinícios', async () => {
  const { dir, dbPath } = createTempDbPath();

  try {
    const repo1 = SqliteFactoryFlowRepository.open({ dbPath });
    const applied = repo1.getAppliedMigrations();
    assert.equal(applied.length, REVIEW_MIGRATIONS.length);
    assert.ok(applied.some(migration => migration.name === 'add_factory_flows'));
    assert.equal(applied.at(-1)?.name, 'add_factory_development_approved_notes');

    const service1 = new FactoryFlowService(repo1, { now: createClock() });

    const createdA = await service1.createFlow({
      task: { inputType: 'jira_key', value: 'PROD-101', repoPath: '/tmp/repo-alpha' },
    });
    const createdB = await service1.createFlow({
      task: { inputType: 'title', value: 'Corrigir fila de eventos', repoPath: '/tmp/repo-beta' },
      title: 'Fila de eventos',
    });

    assert.equal(createdA.replayed, false);
    assert.equal(createdA.stages.length, FACTORY_STAGE_ORDER.length);
    assert.deepEqual(
      createdA.stages.map(stage => stage.name),
      [...FACTORY_STAGE_ORDER],
    );
    assert.equal(createdA.flow.state, 'queued');
    assert.equal(createdA.flow.currentStage, 'triage');

    const sessionIdA = randomUUID();
    await service1.attachSession(createdA.flow.id, sessionIdA, {
      reason: 'Sessão de triagem iniciada',
    });
    await service1.registerArtifact(createdA.flow.id, {
      stage: 'triage',
      sessionId: sessionIdA,
      kind: 'plan',
      format: 'markdown',
      path: '/tmp/artifacts/prod-101-plan.md',
      status: 'ready',
    });

    repo1.close();

    const repo2 = SqliteFactoryFlowRepository.open({ dbPath });
    const service2 = new FactoryFlowService(repo2);

    const allFlows = service2.listFlows();
    assert.equal(allFlows.flows.length, 2);

    const runningFlows = service2.listFlows({ state: 'running' });
    assert.equal(runningFlows.flows.length, 1);
    assert.equal(runningFlows.flows[0]?.id, createdA.flow.id);

    const betaFlows = service2.listFlows({ repoPath: '/tmp/repo-beta' });
    assert.equal(betaFlows.flows.length, 1);
    assert.equal(betaFlows.flows[0]?.id, createdB.flow.id);

    const detailsA = service2.getFlow(createdA.flow.id);
    assert.equal(detailsA.flow.currentSessionId, sessionIdA);
    assert.equal(detailsA.stages[0]?.state, 'running');
    assert.equal(detailsA.stages[0]?.sessionId, sessionIdA);
    assert.equal(detailsA.stages[0]?.reportPath, '/tmp/artifacts/prod-101-plan.md');
    assert.equal(detailsA.artifacts.length, 1);
    assert.equal(detailsA.artifacts[0]?.kind, 'plan');

    repo2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FactoryFlowService garante idempotência na criação e rejeita conflitos', async () => {
  const repo = SqliteFactoryFlowRepository.open({ dbPath: ':memory:' });
  try {
    const service = new FactoryFlowService(repo, { now: createClock() });

    const first = await service.createFlow(
      {
        task: {
          inputType: 'jira_url',
          value: 'https://jira.example.com/browse/PROD-202',
          repoPath: '/tmp/repo-gamma',
        },
        idempotencyKey: 'flow-key-202',
      },
      { idempotencyKey: 'flow-key-202' },
    );
    assert.equal(first.replayed, false);

    const replay = await service.createFlow(
      {
        task: {
          inputType: 'jira_url',
          value: 'https://jira.example.com/browse/PROD-202',
          repoPath: '/tmp/repo-gamma',
        },
      },
      { idempotencyKey: 'flow-key-202' },
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.flow.id, first.flow.id);
    assert.equal(replay.stages.length, 6);

    await assert.rejects(
      () =>
        service.createFlow(
          {
            task: {
              inputType: 'jira_key',
              value: 'PROD-999',
              repoPath: '/tmp/repo-gamma',
            },
          },
          { idempotencyKey: 'flow-key-202' },
        ),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_IDEMPOTENCY_CONFLICT' &&
        error.statusCode === 409,
    );

    await assert.rejects(
      () =>
        service.createFlow(
          {
            task: { inputType: 'title', value: 'Tarefa', repoPath: '/tmp/repo-gamma' },
            idempotencyKey: 'key-a',
          },
          { idempotencyKey: 'key-b' },
        ),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_INPUT' &&
        error.statusCode === 400,
    );
  } finally {
    repo.close();
  }
});

test('FactoryFlowService valida transições de estado, avanço sequencial de etapas e concorrência otimista', async () => {
  const repo = SqliteFactoryFlowRepository.open({ dbPath: ':memory:' });
  try {
    const service = new FactoryFlowService(repo, { now: createClock() });
    const created = await service.createFlow({
      task: { inputType: 'jira_key', value: 'PROD-303', repoPath: '/tmp/repo-delta' },
    });

    const staleUpdatedAt = created.flow.updatedAt;

    const started = await service.transitionFlow(created.flow.id, {
      to: 'running',
      reason: 'Iniciando triagem',
    });
    assert.equal(started.flow.state, 'running');
    assert.equal(started.flow.currentStage, 'triage');

    await assert.rejects(
      () =>
        service.transitionFlow(created.flow.id, {
          to: 'waiting_action',
          reason: 'Tentativa com timestamp desatualizado',
          expectedUpdatedAt: staleUpdatedAt,
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_CONFLICT' &&
        error.statusCode === 409,
    );

    await assert.rejects(
      () =>
        service.transitionFlow(created.flow.id, {
          to: 'waiting_action',
          stage: 'development',
          reason: 'Tentativa de pular etapa planning',
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_STAGE_ADVANCE' &&
        error.statusCode === 409,
    );

    const advanced = await service.advanceStage(created.flow.id);
    assert.equal(advanced.flow.currentStage, 'planning');

    await assert.rejects(
      () => service.advanceStage(created.flow.id),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_STAGE_ADVANCE' &&
        error.statusCode === 409,
    );

    const cancelled = await service.cancelFlow(created.flow.id);
    assert.equal(cancelled.flow.state, 'cancelled');
    assert.ok(cancelled.flow.finishedAt !== null);

    await assert.rejects(
      () =>
        service.transitionFlow(created.flow.id, {
          to: 'running',
          reason: 'Tentativa de reabrir fluxo cancelado',
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_TRANSITION' &&
        error.statusCode === 409,
    );

    const details = service.getFlow(created.flow.id);
    assert.equal(details.stages.find(stage => stage.name === 'triage')?.state, 'completed');
    assert.equal(details.stages.find(stage => stage.name === 'planning')?.state, 'cancelled');
    assert.equal(details.stages.find(stage => stage.name === 'development')?.state, 'pending');
  } finally {
    repo.close();
  }
});

test('FactoryFlowService orquestra múltiplos fluxos paralelos com sessões e artefatos independentes', async () => {
  const repo = SqliteFactoryFlowRepository.open({ dbPath: ':memory:' });
  try {
    const service = new FactoryFlowService(repo, { now: createClock() });

    const [flow1, flow2, flow3] = await Promise.all([
      service.createFlow({
        task: { inputType: 'jira_key', value: 'PROD-401', repoPath: '/tmp/repo-1' },
      }),
      service.createFlow({
        task: { inputType: 'jira_key', value: 'PROD-402', repoPath: '/tmp/repo-2' },
      }),
      service.createFlow({
        task: { inputType: 'title', value: 'Melhorar telemetria', repoPath: '/tmp/repo-3' },
      }),
    ]);

    const session1 = randomUUID();
    const session2 = randomUUID();
    const session3 = randomUUID();

    await Promise.all([
      service.attachSession(flow1.flow.id, session1),
      service.attachSession(flow2.flow.id, session2),
      service.attachSession(flow3.flow.id, session3),
    ]);

    await Promise.all([
      service.registerArtifact(flow1.flow.id, {
        stage: 'triage',
        sessionId: session1,
        kind: 'session_log',
        format: 'text',
        path: '/tmp/sessions/s1.log',
        status: 'ready',
      }),
      service.registerArtifact(flow2.flow.id, {
        stage: 'triage',
        sessionId: session2,
        kind: 'plan',
        format: 'markdown',
        path: '/tmp/plans/p2.md',
        status: 'ready',
      }),
      service.cancelFlow(flow3.flow.id, { reason: 'Cancelado em paralelo' }),
    ]);

    const details1 = service.getFlow(flow1.flow.id);
    const details2 = service.getFlow(flow2.flow.id);
    const details3 = service.getFlow(flow3.flow.id);

    assert.equal(details1.flow.state, 'running');
    assert.equal(details1.stages[0]?.sessionPath, '/tmp/sessions/s1.log');
    assert.equal(details1.stages[0]?.reportPath, null);

    assert.equal(details2.flow.state, 'running');
    assert.equal(details2.stages[0]?.reportPath, '/tmp/plans/p2.md');
    assert.equal(details2.stages[0]?.sessionPath, null);

    assert.equal(details3.flow.state, 'cancelled');
    assert.equal(details3.stages[0]?.state, 'cancelled');

    const listed = service.listFlows({ state: 'running' });
    assert.equal(listed.flows.length, 2);
    assert.equal(
      listed.flows.every(flow => flow.contractVersion === FACTORY_FLOW_CONTRACT_VERSION),
      true,
    );
  } finally {
    repo.close();
  }
});

test('FactoryFlowService trata erros de fluxo inexistente e payloads inválidos', async () => {
  const repo = SqliteFactoryFlowRepository.open({ dbPath: ':memory:' });
  try {
    const service = new FactoryFlowService(repo, { now: createClock() });
    const missingId = randomUUID();

    assert.throws(
      () => service.getFlow('not-a-uuid'),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_INPUT' &&
        error.statusCode === 400,
    );

    assert.throws(
      () => service.getFlow(missingId),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_NOT_FOUND' &&
        error.statusCode === 404,
    );

    await assert.rejects(
      () =>
        service.registerArtifact(missingId, {
          stage: 'triage',
          kind: 'plan',
          format: 'markdown',
          path: '/tmp/missing-plan.md',
          status: 'ready',
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_NOT_FOUND' &&
        error.statusCode === 404,
    );
  } finally {
    repo.close();
  }
});

test('FactoryFlowService valida retorno de review para development/tests e reinicializa etapas posteriores', async () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'df-factory-return-'));
  const repo = SqliteFactoryFlowRepository.open({ dbPath: ':memory:' });
  try {
    const service = new FactoryFlowService(repo, { now: createClock() });
    const created = await service.createFlow({
      task: { inputType: 'jira_key', value: 'PROD-505', repoPath: '/tmp/repo-return' },
    });

    const specPath = join(artifactsDir, 'spec.md');
    const planPath = join(artifactsDir, 'plan.md');
    const devPath = join(artifactsDir, 'dev.md');
    const testsPath = join(artifactsDir, 'tests.md');
    writeFileSync(specPath, '# Spec\n');
    writeFileSync(planPath, '# Plan\n');
    writeFileSync(devPath, '# Dev\n');
    writeFileSync(testsPath, '# Tests\n');

    await service.transitionFlow(created.flow.id, { to: 'running', reason: 'Triagem iniciada' });
    await service.registerArtifact(created.flow.id, {
      stage: 'triage',
      kind: 'specification',
      path: specPath,
      status: 'ready',
    });
    await service.advanceStage(created.flow.id);
    await service.registerArtifact(created.flow.id, {
      stage: 'planning',
      kind: 'plan',
      path: planPath,
      status: 'ready',
    });

    await service.advanceStage(created.flow.id, { approvedNotes: 'Notas dev' });
    await service.registerArtifact(created.flow.id, {
      stage: 'development',
      kind: 'implementation_report',
      path: devPath,
      status: 'ready',
    });

    await service.advanceStage(created.flow.id, { approvedNotes: 'Notas testes' });
    await service.registerArtifact(created.flow.id, {
      stage: 'tests',
      kind: 'test_report',
      path: testsPath,
      status: 'ready',
    });

    await service.advanceStage(created.flow.id, { approvedNotes: 'Notas review' });
    const beforeReturn = service.getFlow(created.flow.id);
    assert.equal(beforeReturn.flow.currentStage, 'review');
    assert.equal(beforeReturn.flow.state, 'waiting_action');

    const returned = await service.returnStage(created.flow.id, {
      targetStage: 'development',
      approvedNotes: 'Corrigir falha crítica apontada no review',
    });
    assert.equal(returned.flow.currentStage, 'development');
    assert.equal(returned.flow.state, 'waiting_action');

    const afterReturn = service.getFlow(created.flow.id);
    const devStage = afterReturn.stages.find(stage => stage.name === 'development');
    const testsStage = afterReturn.stages.find(stage => stage.name === 'tests');
    const reviewStage = afterReturn.stages.find(stage => stage.name === 'review');
    assert.equal(devStage?.state, 'waiting_action');
    assert.equal(devStage?.finishedAt, null);
    assert.equal(devStage?.approvedNotes, 'Corrigir falha crítica apontada no review');
    assert.equal(testsStage?.state, 'pending');
    assert.equal(testsStage?.startedAt, null);
    assert.equal(testsStage?.finishedAt, null);
    assert.equal(testsStage?.reportPath, null);
    assert.equal(reviewStage?.state, 'pending');
    assert.equal(reviewStage?.startedAt, null);
    assert.equal(reviewStage?.finishedAt, null);

    await assert.rejects(
      () =>
        service.returnStage(created.flow.id, {
          targetStage: 'tests',
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_STAGE_ADVANCE' &&
        error.statusCode === 409,
    );
  } finally {
    repo.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});
