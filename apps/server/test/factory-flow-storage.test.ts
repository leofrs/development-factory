import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_STAGE_ORDER,
  FactoryFlowDetailsSchema,
} from '@development-factory/shared';
import { FactoryFlowService, FactoryFlowServiceError } from '../src/factory-flow-service.js';
import { getFactoryStageSidecarPath } from '../src/factory-stage-runners.js';
import {
  REVIEW_MIGRATIONS,
  ReviewStorageError,
  SqliteFactoryFlowRepository,
  runMigrations,
} from '../src/storage/index.js';
import {
  planningMarkdown,
  triageMarkdown,
  writeFactoryStageSidecar,
} from './fixtures/factory-stage-artifacts.js';

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
    assert.equal(applied.at(-1)?.name, 'add_factory_review_outcomes');

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
  const artifactsDir = mkdtempSync(join(tmpdir(), 'df-factory-advance-'));
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

    const specPath = join(artifactsDir, 'spec.md');
    writeFileSync(specPath, triageMarkdown('Triagem concluída.'));
    await service.registerArtifact(created.flow.id, {
      stage: 'triage',
      kind: 'specification',
      path: specPath,
      status: 'ready',
    });
    const paused = await service.transitionFlow(created.flow.id, {
      to: 'waiting_action',
      reason: 'Triagem encerrada',
    });
    await assert.rejects(
      () => service.advanceStage(created.flow.id),
      (error: unknown) =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_CONTRACT' &&
        /sidecar JSON está ausente/.test(error.message),
    );
    assert.deepEqual(service.getFlow(created.flow.id).flow, paused.flow);

    writeFactoryStageSidecar(specPath, 'triage');
    writeFileSync(specPath, '# Triagem sem seções obrigatórias\n');
    await assert.rejects(
      () => service.advanceStage(created.flow.id),
      (error: unknown) =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_CONTRACT' &&
        /título e as seções obrigatórias/.test(error.message),
    );
    writeFileSync(specPath, triageMarkdown('Triagem concluída.'));
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
    rmSync(artifactsDir, { recursive: true, force: true });
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
    writeFileSync(specPath, triageMarkdown('Escopo definido.'));
    writeFactoryStageSidecar(specPath, 'triage');
    writeFileSync(planPath, planningMarkdown('Ajustar o fluxo.'));
    writeFactoryStageSidecar(planPath, 'planning');
    writeFileSync(devPath, [
      '# Relatório de Implementação',
      '## Arquivos alterados',
      '- src/feature.ts',
      '## Resumo das mudanças',
      'Fluxo ajustado.',
      '## Status dos passos do plano',
      '| Ajustar o fluxo | Concluído | Implementado |',
    ].join('\n'));
    writeFactoryStageSidecar(devPath, 'development');
    writeFileSync(testsPath, [
      '# Relatório de Testes',
      '## Arquivos de teste alterados',
      '- test/feature.test.ts',
      '## Comandos executados',
      '- npm test',
      '## Resultados e cobertura',
      'Testes aprovados.',
    ].join('\n'));
    writeFactoryStageSidecar(testsPath, 'tests');

    await service.transitionFlow(created.flow.id, { to: 'running', reason: 'Triagem iniciada' });
    await service.registerArtifact(created.flow.id, {
      stage: 'triage',
      kind: 'specification',
      path: specPath,
      status: 'ready',
    });
    await service.transitionFlow(created.flow.id, { to: 'waiting_action', reason: 'Triagem encerrada' });
    await service.advanceStage(created.flow.id);
    await service.registerArtifact(created.flow.id, {
      stage: 'planning',
      kind: 'plan',
      path: planPath,
      status: 'ready',
    });
    await service.transitionFlow(created.flow.id, { to: 'waiting_action', reason: 'Plano encerrado' });

    await service.advanceStage(created.flow.id, { approvedNotes: 'Notas dev' });
    assert.equal(service.getFlow(created.flow.id).flow.iteration, 1);
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
    assert.equal(beforeReturn.flow.iteration, 1);

    writeFileSync(getFactoryStageSidecarPath(planPath), '{');
    await assert.rejects(
      () => service.returnStage(created.flow.id, { targetStage: 'development' }),
      (error: unknown) =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_CONTRACT' &&
        /sidecar contém JSON inválido/.test(error.message),
    );
    assert.deepEqual(service.getFlow(created.flow.id).flow, beforeReturn.flow);
    writeFactoryStageSidecar(planPath, 'planning');

    const returned = await service.returnStage(created.flow.id, {
      targetStage: 'development',
      approvedNotes: 'Corrigir falha crítica apontada no review',
    });
    assert.equal(returned.flow.currentStage, 'development');
    assert.equal(returned.flow.state, 'waiting_action');
    assert.equal(returned.flow.iteration, 2);

    const afterReturn = service.getFlow(created.flow.id);
    assert.equal(
      afterReturn.artifacts.find(artifact => artifact.kind === 'implementation_report')?.iteration,
      1,
    );
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

test('SqliteFactoryFlowRepository e FactoryFlowService persistem e leem worktreePath, branchName, baseBranch e checkpoints', async () => {
  const { dir, dbPath } = createTempDbPath();

  try {
    const repo1 = SqliteFactoryFlowRepository.open({ dbPath });
    const service1 = new FactoryFlowService(repo1, { now: createClock() });

    const created = await service1.createFlow({
      task: { inputType: 'jira_key', value: 'PROD-707', repoPath: '/tmp/repo-worktree' },
    });
    assert.equal(created.flow.worktreePath, null);
    assert.equal(created.flow.branchName, null);
    assert.equal(created.flow.baseBranch, null);

    const worktreePath = '/tmp/df-worktrees/prod-707';
    const branchName = 'factory/PROD-707';
    const baseBranch = 'main';

    const withWorktree = await service1.updateWorktreeMetadata(created.flow.id, {
      worktreePath,
      branchName,
      baseBranch,
    });
    assert.equal(withWorktree.worktreePath, worktreePath);
    assert.equal(withWorktree.branchName, branchName);
    assert.equal(withWorktree.baseBranch, baseBranch);

    const transitioned = await service1.transitionFlow(created.flow.id, {
      to: 'running',
      reason: 'Iniciando triagem isolada',
    });
    assert.equal(transitioned.flow.worktreePath, worktreePath);
    assert.equal(transitioned.flow.branchName, branchName);
    assert.equal(transitioned.flow.baseBranch, baseBranch);

    const sessionId = randomUUID();
    const cp1 = await service1.registerCheckpoint(created.flow.id, {
      stage: 'development',
      iteration: 1,
      commitSha: '1111111222222233333334444444555555566666',
      sessionId,
      message: 'Checkpoint Bloco 03 ciclo 1',
    });
    const cp2 = await service1.registerCheckpoint(created.flow.id, {
      stage: 'tests',
      iteration: 1,
      commitSha: 'aaaaaaa1111111bbbbbbb2222222ccccccc33333',
      message: 'Checkpoint Bloco 04 ciclo 1',
    });
    const cp3 = await service1.registerCheckpoint(created.flow.id, {
      stage: 'development',
      iteration: 2,
      commitSha: 'ddddddd4444444eeeeeee5555555fffffff66666',
      branchName: 'factory/PROD-707-iter2',
      message: 'Checkpoint Bloco 03 ciclo 2',
    });

    assert.equal(cp1.branchName, branchName);
    assert.equal(cp2.branchName, branchName);
    assert.equal(cp3.branchName, 'factory/PROD-707-iter2');

    await assert.rejects(
      () =>
        service1.updateWorktreeMetadata(created.flow.id, {
          branchName: 'invalid branch name',
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_INPUT' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      () =>
        service1.registerCheckpoint(created.flow.id, {
          stage: 'development',
          commitSha: 'xyz-not-sha',
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_INPUT' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      () =>
        service1.registerCheckpoint(randomUUID(), {
          stage: 'development',
          commitSha: '1234567',
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_NOT_FOUND' &&
        error.statusCode === 404,
    );

    assert.throws(
      () => repo1.saveCheckpoint(cp1),
      error => error instanceof ReviewStorageError && error.code === 'STORAGE_CONFLICT',
    );

    repo1.close();

    const repo2 = SqliteFactoryFlowRepository.open({ dbPath });
    const service2 = new FactoryFlowService(repo2);

    const details = FactoryFlowDetailsSchema.parse(service2.getFlow(created.flow.id));
    assert.equal(details.worktreePath, worktreePath);
    assert.equal(details.branchName, branchName);
    assert.equal(details.baseBranch, baseBranch);
    assert.equal(details.flow.worktreePath, worktreePath);
    assert.equal(details.flow.branchName, branchName);
    assert.equal(details.flow.baseBranch, baseBranch);
    assert.deepEqual(
      details.checkpoints.map(cp => cp.id),
      [cp1.id, cp2.id, cp3.id],
    );

    const devCheckpoints = repo2.listCheckpointsByFlowId(created.flow.id, { stage: 'development' });
    assert.deepEqual(
      devCheckpoints.map(cp => cp.id),
      [cp1.id, cp3.id],
    );
    const iter1DevCheckpoints = repo2.listCheckpointsByFlowId(created.flow.id, {
      stage: 'development',
      iteration: 1,
    });
    assert.deepEqual(
      iter1DevCheckpoints.map(cp => cp.id),
      [cp1.id],
    );

    repo2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Migration v7 é idempotente e preserva fluxos históricos existentes antes de worktree e checkpoints', async () => {
  const { dir, dbPath } = createTempDbPath();

  try {
    const legacyFlowId = randomUUID();
    const legacyStageId = randomUUID();
    const createdAt = '2026-11-18T10:00:00.000Z';

    const preV7Db = new DatabaseSync(dbPath);
    try {
      runMigrations(preV7Db, REVIEW_MIGRATIONS.slice(0, 6));
      preV7Db
        .prepare(
          `INSERT INTO factory_flows (
            id,
            contract_version,
            title,
            input_type,
            target_value,
            repo_path,
            state,
            current_stage,
            current_session_id,
            iteration,
            max_iterations,
            last_review_verdict,
            loop_paused_reason,
            created_at,
            updated_at,
            finished_at,
            transitions_json,
            error_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          legacyFlowId,
          FACTORY_FLOW_CONTRACT_VERSION,
          'PROD-001 · Fluxo histórico',
          'jira_key',
          'PROD-001',
          '/tmp/legacy-repo',
          'queued',
          'triage',
          null,
          0,
          3,
          null,
          null,
          createdAt,
          createdAt,
          null,
          '[]',
          null,
        );
      preV7Db
        .prepare(
          `INSERT INTO factory_flow_stages (
            id,
            flow_id,
            contract_version,
            name,
            state,
            session_id,
            report_path,
            session_path,
            approved_notes,
            created_at,
            updated_at,
            started_at,
            finished_at,
            error_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          legacyStageId,
          legacyFlowId,
          FACTORY_FLOW_CONTRACT_VERSION,
          'triage',
          'pending',
          null,
          null,
          null,
          null,
          createdAt,
          createdAt,
          null,
          null,
          null,
        );
    } finally {
      preV7Db.close();
    }

    const repo = SqliteFactoryFlowRepository.open({ dbPath });
    const service = new FactoryFlowService(repo, { now: createClock() });
    const legacyDetails = service.getFlow(legacyFlowId);
    assert.equal(legacyDetails.flow.title, 'PROD-001 · Fluxo histórico');
    assert.equal(legacyDetails.worktreePath, null);
    assert.equal(legacyDetails.branchName, null);
    assert.equal(legacyDetails.baseBranch, null);
    assert.deepEqual(legacyDetails.checkpoints, []);

    await service.updateWorktreeMetadata(legacyFlowId, {
      worktreePath: '/tmp/df-worktrees/prod-001',
      branchName: 'factory/PROD-001',
      baseBranch: 'main',
    });
    const checkpoint = await service.registerCheckpoint(legacyFlowId, {
      stage: 'development',
      iteration: 1,
      commitSha: 'abcdef1234567',
      message: 'Checkpoint em fluxo migrado',
    });
    repo.close();

    // Executa a função up da migration v7 novamente para comprovar idempotência direta do DDL.
    const rawDb = new DatabaseSync(dbPath);
    try {
      const v7Migration = REVIEW_MIGRATIONS.find(migration => migration.version === 7);
      assert.ok(v7Migration);
      v7Migration.up(rawDb);
    } finally {
      rawDb.close();
    }

    const repoAfterIdempotentReapply = SqliteFactoryFlowRepository.open({ dbPath });
    const serviceAfter = new FactoryFlowService(repoAfterIdempotentReapply);
    const verified = serviceAfter.getFlow(legacyFlowId);
    assert.equal(verified.worktreePath, '/tmp/df-worktrees/prod-001');
    assert.equal(verified.branchName, 'factory/PROD-001');
    assert.equal(verified.baseBranch, 'main');
    assert.equal(verified.checkpoints.length, 1);
    assert.equal(verified.checkpoints[0]?.id, checkpoint.id);
    repoAfterIdempotentReapply.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Migration v8 e FactoryFlowService persistem planningApproval e expõem planningGate após reinício', async () => {
  const { dir, dbPath } = createTempDbPath();
  const artifactsDir = mkdtempSync(join(tmpdir(), 'df-factory-planning-approval-'));

  try {
    const preV8Db = new DatabaseSync(dbPath);
    const legacyFlowId = randomUUID();
    const createdAt = '2026-11-18T10:00:00.000Z';
    try {
      runMigrations(preV8Db, REVIEW_MIGRATIONS.slice(0, 7));
      preV8Db
        .prepare(
          `INSERT INTO factory_flows (
            id, contract_version, title, input_type, target_value, repo_path, state, current_stage,
            current_session_id, iteration, max_iterations, last_review_verdict, loop_paused_reason,
            worktree_path, branch_name, base_branch, created_at, updated_at, finished_at, transitions_json, error_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          legacyFlowId,
          FACTORY_FLOW_CONTRACT_VERSION,
          'PROD-808 · Fluxo pré-v8',
          'jira_key',
          'PROD-808',
          '/tmp/legacy-v8',
          'queued',
          'triage',
          null,
          0,
          3,
          null,
          null,
          null,
          null,
          null,
          createdAt,
          createdAt,
          null,
          '[]',
          null,
        );
    } finally {
      preV8Db.close();
    }

    const repo1 = SqliteFactoryFlowRepository.open({ dbPath });
    const service1 = new FactoryFlowService(repo1, { now: createClock() });

    const migratedLegacy = service1.getFlow(legacyFlowId);
    assert.equal(migratedLegacy.flow.planningApproval, null);

    const created = await service1.createFlow({
      task: { inputType: 'jira_key', value: 'PROD-809', repoPath: '/tmp/repo-v8' },
    });
    const specPath = join(artifactsDir, 'spec.md');
    const planPath = join(artifactsDir, 'plan.md');
    writeFileSync(specPath, triageMarkdown('Triagem com CAs.'));
    writeFactoryStageSidecar(specPath, 'triage', {
      acceptanceCriteria: [
        { id: 'CA1', description: 'Validar token JWT' },
        { id: 'CA2', description: 'Invalidar sessão expirada' },
      ],
    });
    writeFileSync(planPath, planningMarkdown('Plano com decisões pendentes.'));
    writeFactoryStageSidecar(planPath, 'planning', {
      pendingDecisions: [
        {
          question: 'Onde armazenar o refresh token?',
          options: ['Tabela dedicada em SQLite', 'Cache em memória'],
          recommendedOption: 'Tabela dedicada em SQLite',
        },
        {
          question: 'Qual algoritmo de hash usar?',
          options: ['SHA-256', 'SHA-512'],
          recommendedOption: 'SHA-256',
        },
      ],
    });

    await service1.transitionFlow(created.flow.id, { to: 'running', reason: 'Triagem iniciada' });
    await service1.registerArtifact(created.flow.id, {
      stage: 'triage',
      kind: 'specification',
      path: specPath,
      status: 'ready',
    });
    await service1.transitionFlow(created.flow.id, { to: 'waiting_action', reason: 'Triagem concluída' });

    await assert.rejects(
      () =>
        service1.advanceStage(created.flow.id, {
          planningApproval: { decisions: [], acceptanceCriteria: [] },
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_INPUT' &&
        error.statusCode === 400,
    );

    await service1.advanceStage(created.flow.id);
    await service1.registerArtifact(created.flow.id, {
      stage: 'planning',
      kind: 'plan',
      path: planPath,
      status: 'ready',
    });
    await service1.transitionFlow(created.flow.id, {
      to: 'waiting_action',
      reason: 'Planejamento concluído',
    });

    const beforeApproval = service1.getFlow(created.flow.id);
    assert.deepEqual(beforeApproval.planningGate, {
      pendingDecisions: [
        {
          question: 'Onde armazenar o refresh token?',
          options: ['Tabela dedicada em SQLite', 'Cache em memória'],
          recommendedOption: 'Tabela dedicada em SQLite',
        },
        {
          question: 'Qual algoritmo de hash usar?',
          options: ['SHA-256', 'SHA-512'],
          recommendedOption: 'SHA-256',
        },
      ],
      acceptanceCriteria: [
        { id: 'CA1', description: 'Validar token JWT' },
        { id: 'CA2', description: 'Invalidar sessão expirada' },
      ],
    });

    // Falta D2 -> rejeita com 400.
    await assert.rejects(
      () =>
        service1.advanceStage(created.flow.id, {
          planningApproval: {
            decisions: [
              {
                id: 'D1',
                question: 'Onde armazenar o refresh token?',
                mode: 'recommended',
                selectedOption: 'Tabela dedicada em SQLite',
                recommendedOption: 'Tabela dedicada em SQLite',
              },
            ],
            acceptanceCriteria: [{ id: 'CA1', description: 'Validar token JWT', approved: true }],
          },
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_INPUT' &&
        error.statusCode === 400 &&
        /D2/.test(error.message),
    );

    const approvalInput = {
      decisions: [
        {
          id: 'D1',
          question: 'Onde armazenar o refresh token?',
          mode: 'recommended' as const,
          selectedOption: 'Tabela dedicada em SQLite',
          recommendedOption: 'Tabela dedicada em SQLite',
        },
        {
          id: 'D2',
          question: 'Qual algoritmo de hash usar?',
          mode: 'custom' as const,
          selectedOption: 'BLAKE2b com salt por usuário',
          recommendedOption: 'SHA-256',
        },
      ],
      acceptanceCriteria: [
        { id: 'CA1', description: 'Validar token JWT com expiração curta', approved: true },
        { id: 'CA2', description: 'Invalidar sessão expirada', approved: false },
      ],
      notes: 'Aplicar índice na coluna de expiração.',
    };

    const advanced = await service1.advanceStage(created.flow.id, {
      planningApproval: approvalInput,
    });
    assert.equal(advanced.flow.currentStage, 'development');
    assert.ok(advanced.flow.planningApproval);
    assert.deepEqual(advanced.flow.planningApproval.decisions, approvalInput.decisions);
    assert.deepEqual(
      advanced.flow.planningApproval.acceptanceCriteria,
      approvalInput.acceptanceCriteria,
    );
    assert.equal(advanced.flow.planningApproval.notes, approvalInput.notes);
    repo1.close();

    // Executa migration v8 novamente para comprovar idempotência.
    const rawDb = new DatabaseSync(dbPath);
    try {
      const v8Migration = REVIEW_MIGRATIONS.find(migration => migration.version === 8);
      assert.ok(v8Migration);
      v8Migration.up(rawDb);
    } finally {
      rawDb.close();
    }

    const repo2 = SqliteFactoryFlowRepository.open({ dbPath });
    const service2 = new FactoryFlowService(repo2);
    const reloaded = FactoryFlowDetailsSchema.parse(service2.getFlow(created.flow.id));
    assert.deepEqual(reloaded.flow.planningApproval, advanced.flow.planningApproval);
    assert.equal(
      reloaded.stages.find(stage => stage.name === 'development')?.approvedNotes,
      approvalInput.notes,
    );
    repo2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('migration v10 persiste revisão humana do PR (Etapa 2 do Bloco 06) com validação e idempotência', async () => {
  const { dir, dbPath } = createTempDbPath();
  const artifactsDir = mkdtempSync(join(tmpdir(), 'df-pr-review-artifacts-'));

  try {
    const repo1 = SqliteFactoryFlowRepository.open({ dbPath });
    const service1 = new FactoryFlowService(repo1, { now: createClock() });

    const specPath = join(artifactsDir, 'spec.md');
    const planPath = join(artifactsDir, 'plan.md');
    const devPath = join(artifactsDir, 'dev.md');
    const testsPath = join(artifactsDir, 'tests.md');
    const reviewPath = join(artifactsDir, 'review.md');
    const prPath = join(artifactsDir, 'pr.md');

    writeFileSync(specPath, triageMarkdown('Preparar revisão do PR.'));
    writeFactoryStageSidecar(specPath, 'triage', {
      jiraContext: { key: 'PAY-100', url: 'https://empresa.atlassian.net/browse/PAY-100' },
    });
    writeFileSync(planPath, planningMarkdown('Plano objetivo.'));
    writeFactoryStageSidecar(planPath, 'planning');
    writeFileSync(
      devPath,
      '# Relatório de Implementação\n## Arquivos alterados\n- src/a.ts\n## Resumo das mudanças\nOk.\n## Status dos passos do plano\n| Passo | Status | Obs |\n| --- | --- | --- |\n| 1 | Concluído | Ok |\n',
    );
    writeFactoryStageSidecar(devPath, 'development');
    writeFileSync(
      testsPath,
      '# Relatório de Testes\n## Arquivos de teste alterados\n- test/a.test.ts\n## Comandos executados\n- npm test\n## Resultados e cobertura\nPASS\n',
    );
    writeFactoryStageSidecar(testsPath, 'tests');
    writeFileSync(
      reviewPath,
      '# Relatório de Code Review\n## Resumo Executivo\nOk\n## Pontos Encontrados\nNenhum\n## Parecer Final\nVeredito: APROVADO PARA PR\n',
    );
    writeFactoryStageSidecar(reviewPath, 'review');
    writeFileSync(
      prPath,
      '# Resumo do Pull Request\n## Resumo das Alterações\nAjuste entregue.\n## Validação e Evidências\n| ID | Critério de Aceite | Status | Evidência |\n| --- | --- | --- | --- |\n| CA1 | Validar fluxo | Atendido | npm test (exitCode 0) |\n## Dados do Pull Request\nTítulo: feat(pay): entrega inicial\n',
    );
    writeFactoryStageSidecar(prPath, 'pr', {
      title: 'feat(pay): entrega inicial',
      baseBranch: 'main',
      headBranch: 'factory/pay-100',
    });

    const created = await service1.createFlow({
      task: { inputType: 'jira_key', value: 'PAY-100', repoPath: '/tmp/repo' },
    });

    await service1.registerArtifact(created.flow.id, {
      stage: 'triage',
      kind: 'specification',
      path: specPath,
      status: 'ready',
    });
    await service1.transitionFlow(created.flow.id, { to: 'running', reason: 'Executando triagem' });
    await service1.transitionFlow(created.flow.id, { to: 'waiting_action', reason: 'Triagem ok' });
    await service1.advanceStage(created.flow.id);
    await service1.registerArtifact(created.flow.id, {
      stage: 'planning',
      kind: 'plan',
      path: planPath,
      status: 'ready',
    });
    await service1.transitionFlow(created.flow.id, { to: 'waiting_action', reason: 'Plano ok' });
    await service1.advanceStage(created.flow.id);
    await service1.registerArtifact(created.flow.id, {
      stage: 'development',
      kind: 'implementation_report',
      path: devPath,
      status: 'ready',
    });
    await service1.advanceStage(created.flow.id);
    await service1.registerArtifact(created.flow.id, {
      stage: 'tests',
      kind: 'test_report',
      path: testsPath,
      status: 'ready',
    });
    await service1.advanceStage(created.flow.id);
    await service1.registerArtifact(created.flow.id, {
      stage: 'review',
      kind: 'review_report',
      path: reviewPath,
      status: 'ready',
    });
    await service1.advanceStage(created.flow.id);

    // Sem artefato pr_summary pronto -> 409.
    await assert.rejects(
      () =>
        service1.savePrReview(created.flow.id, {
          title: 'feat(pay): título',
          description: 'Descrição',
          baseBranch: 'main',
          draft: false,
          reviewers: [],
          updateJira: false,
        }),
      error =>
        error instanceof FactoryFlowServiceError &&
        error.code === 'FACTORY_FLOW_INVALID_STAGE_ADVANCE' &&
        error.statusCode === 409,
    );

    await service1.registerArtifact(created.flow.id, {
      stage: 'pr',
      kind: 'pr_summary',
      path: prPath,
      status: 'ready',
    });

    const beforeEdit = service1.getFlow(created.flow.id);
    assert.equal(beforeEdit.prGate?.title, 'feat(pay): entrega inicial');
    assert.equal(beforeEdit.prGate?.baseBranch, 'main');
    assert.equal(beforeEdit.prGate?.updateJira, true);
    assert.equal(beforeEdit.prGate?.confirmedForPublish, false);

    // Salva rascunho sem confirmar publicação.
    const draftSaved = await service1.savePrReview(created.flow.id, {
      title: 'feat(pay): título ajustado',
      description: '## Alterações\n\nRevisado.',
      baseBranch: 'release/2026',
      draft: true,
      reviewers: ['maria', 'time/pagamentos'],
      updateJira: true,
      confirmPublish: false,
    });
    assert.equal(draftSaved.prGate.confirmedForPublish, false);
    assert.equal(draftSaved.prGate.confirmedAt, null);

    // Confirma publicação explicitamente.
    const confirmed = await service1.savePrReview(created.flow.id, {
      title: 'feat(pay): título final',
      description: '## Alterações\n\nConfirmado.',
      baseBranch: 'main',
      draft: false,
      reviewers: ['maria'],
      updateJira: false,
      confirmPublish: true,
    });
    assert.equal(confirmed.prGate.confirmedForPublish, true);
    assert.ok(confirmed.prGate.confirmedAt);
    repo1.close();

    // Executa migration v10 novamente para comprovar idempotência.
    const rawDb = new DatabaseSync(dbPath);
    try {
      const v10Migration = REVIEW_MIGRATIONS.find(migration => migration.version === 10);
      assert.ok(v10Migration);
      v10Migration.up(rawDb);
    } finally {
      rawDb.close();
    }

    const repo2 = SqliteFactoryFlowRepository.open({ dbPath });
    const service2 = new FactoryFlowService(repo2);
    const reloaded = FactoryFlowDetailsSchema.parse(service2.getFlow(created.flow.id));
    assert.deepEqual(reloaded.flow.prReview, confirmed.flow.prReview);
    assert.equal(reloaded.prGate?.title, 'feat(pay): título final');
    assert.equal(reloaded.prGate?.confirmedForPublish, true);
    repo2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('migration v11 persiste prPublication no SQLite de forma idempotente', async () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const repo1 = SqliteFactoryFlowRepository.open({ dbPath });
    const service1 = new FactoryFlowService(repo1, { now: createClock() });
    const created = await service1.createFlow({
      task: { inputType: 'jira_key', value: 'PAY-200', repoPath: '/tmp/repo' },
    });

    const publication = {
      prArtifactId: '00000000-0000-4000-8000-000000000999',
      status: 'published' as const,
      provider: 'github' as const,
      prUrl: 'https://github.com/org/repo/pull/123',
      prNumber: 123,
      commitSha: 'a1b2c3d4e5f6789012345678901234567890abcd',
      headBranch: 'factory/pay-200',
      baseBranch: 'main',
      draft: false,
      publishedAt: '2026-11-22T12:10:00.000Z',
      secretFindings: [],
      jiraSync: {
        status: 'failed' as const,
        issueKey: 'PAY-200',
        updatedAt: '2026-11-22T12:10:00.000Z',
        error: 'Jira HTTP 503',
      },
      error: null,
      updatedAt: '2026-11-22T12:10:00.000Z',
    };

    const updated = repo1.updateFlowPrPublication(created.flow.id, publication);
    assert.deepEqual(updated.prPublication, publication);
    repo1.close();

    const rawDb = new DatabaseSync(dbPath);
    try {
      const v11Migration = REVIEW_MIGRATIONS.find(migration => migration.version === 11);
      assert.ok(v11Migration);
      v11Migration.up(rawDb);
    } finally {
      rawDb.close();
    }

    const repo2 = SqliteFactoryFlowRepository.open({ dbPath });
    const reloaded = repo2.getFlowById(created.flow.id);
    assert.deepEqual(reloaded?.prPublication, publication);
    repo2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration v12 e getMetrics agregam lead time, 1º ciclo, motivos de reprovação, cancelados e timestamps parciais', async () => {
  const { dir, dbPath } = createTempDbPath();
  const artifactsDir = mkdtempSync(join(tmpdir(), 'df-factory-metrics-artifacts-'));

  function writeStageArtifactPair(
    name: string,
    stage: 'triage' | 'planning' | 'development' | 'tests' | 'review' | 'pr',
    reviewOverride?: {
      verdict: 'approved' | 'approved_with_warnings' | 'changes_requested';
      returnTarget?: 'development' | 'tests' | null;
      findings: Array<{
        severity: 'BLOQUEANTE' | 'SUGESTÃO' | 'NIT';
        file: string;
        line: number;
        explanation: string;
        category?: string;
        signature?: string;
      }>;
    },
  ): string {
    const mdPath = join(artifactsDir, `${name}.md`);
    if (stage === 'triage') {
      writeFileSync(mdPath, triageMarkdown('Escopo de métricas.'));
      writeFactoryStageSidecar(mdPath, 'triage');
    } else if (stage === 'planning') {
      writeFileSync(mdPath, planningMarkdown('Plano de métricas.'));
      writeFactoryStageSidecar(mdPath, 'planning');
    } else if (stage === 'development') {
      writeFileSync(
        mdPath,
        '# Relatório de Implementação\n## Arquivos alterados\n- src/a.ts\n## Resumo das mudanças\nOk.\n## Status dos passos do plano\n| Passo | Status | Obs |\n| --- | --- | --- |\n| 1 | Concluído | Ok |\n',
      );
      writeFactoryStageSidecar(mdPath, 'development');
    } else if (stage === 'tests') {
      writeFileSync(
        mdPath,
        '# Relatório de Testes\n## Arquivos de teste alterados\n- test/a.test.ts\n## Comandos executados\n- npm test\n## Resultados e cobertura\nPASS\n',
      );
      writeFactoryStageSidecar(mdPath, 'tests');
    } else if (stage === 'review') {
      const verdictText =
        reviewOverride?.verdict === 'changes_requested'
          ? 'REPROVADO / REQUER AJUSTES'
          : reviewOverride?.verdict === 'approved_with_warnings'
            ? 'APROVADO COM RESSALVAS'
            : 'APROVADO PARA PR';
      writeFileSync(
        mdPath,
        `# Relatório de Code Review\n## Resumo Executivo\nRevisão.\n## Pontos Encontrados\nDetalhes.\n## Parecer Final\nVeredito: ${verdictText}\n`,
      );
      writeFactoryStageSidecar(mdPath, 'review', reviewOverride);
    } else {
      writeFileSync(
        mdPath,
        '# Resumo do Pull Request\n## Resumo das Alterações\nEntrega.\n## Validação e Evidências\n| ID | Critério de Aceite | Status | Evidência |\n| --- | --- | --- | --- |\n| CA1 | Validar | Atendido | npm test |\n## Dados do Pull Request\nTítulo: feat(metrics): painel\n',
      );
      writeFactoryStageSidecar(mdPath, 'pr', {
        title: 'feat(metrics): painel',
        baseBranch: 'main',
        headBranch: 'factory/metrics',
      });
    }
    return mdPath;
  }

  try {
    const repo = SqliteFactoryFlowRepository.open({ dbPath });
    let currentMs = Date.parse('2026-11-20T12:00:00.000Z');
    const advanceClock = (seconds: number): string => {
      currentMs += seconds * 1000;
      return new Date(currentMs).toISOString();
    };
    const service = new FactoryFlowService(repo, {
      now: () => new Date(currentMs).toISOString(),
    });

    // Estado inicial vazio.
    const emptyMetrics = service.getMetrics();
    assert.equal(emptyMetrics.summary.totalFlows, 0);
    assert.equal(emptyMetrics.summary.averageFlowLeadTimeMs, null);
    assert.equal(emptyMetrics.firstCycleReview.approvalRatePercent, null);
    assert.deepEqual(emptyMetrics.rejectionReasons, []);
    assert.deepEqual(emptyMetrics.byRepository, []);
    assert.equal(emptyMetrics.stageLeadTimes.length, 6);
    assert.ok(emptyMetrics.stageLeadTimes.every(item => item.averageDurationMs === null));

    // Fluxo 1 (/tmp/repo-alpha): concluído no 1º ciclo com PR publicado.
    const flow1 = await service.createFlow({
      task: { inputType: 'jira_key', value: 'MET-1', repoPath: '/tmp/repo-alpha' },
    });
    await service.registerArtifact(flow1.flow.id, {
      stage: 'triage',
      kind: 'specification',
      path: writeStageArtifactPair('f1-triage', 'triage'),
      status: 'ready',
    });
    await service.transitionFlow(flow1.flow.id, { to: 'running', at: advanceClock(10), reason: 'Triagem' });
    await service.transitionFlow(flow1.flow.id, { to: 'waiting_action', at: advanceClock(10), reason: 'Triagem ok' });
    await service.advanceStage(flow1.flow.id, { at: advanceClock(10) }); // planning start
    await service.registerArtifact(flow1.flow.id, {
      stage: 'planning',
      kind: 'plan',
      path: writeStageArtifactPair('f1-plan', 'planning'),
      status: 'ready',
    });
    await service.transitionFlow(flow1.flow.id, { to: 'waiting_action', at: advanceClock(20), reason: 'Plano ok' });
    await service.advanceStage(flow1.flow.id, { at: advanceClock(10) }); // dev start
    await service.registerArtifact(flow1.flow.id, {
      stage: 'development',
      kind: 'implementation_report',
      path: writeStageArtifactPair('f1-dev', 'development'),
      status: 'ready',
    });
    await service.advanceStage(flow1.flow.id, { at: advanceClock(30) }); // tests start
    await service.registerArtifact(flow1.flow.id, {
      stage: 'tests',
      kind: 'test_report',
      path: writeStageArtifactPair('f1-tests', 'tests'),
      status: 'ready',
    });
    await service.advanceStage(flow1.flow.id, { at: advanceClock(15) }); // review start
    await service.transitionFlow(flow1.flow.id, {
      to: 'running',
      at: advanceClock(5),
      reason: 'Executando review',
    });
    await service.registerArtifact(flow1.flow.id, {
      stage: 'review',
      kind: 'review_report',
      path: writeStageArtifactPair('f1-review', 'review', {
        verdict: 'approved',
        returnTarget: null,
        findings: [],
      }),
      status: 'ready',
    });
    await service.transitionFlow(flow1.flow.id, {
      to: 'waiting_action',
      at: advanceClock(20),
      reason: 'Review ok',
      lastReviewVerdict: 'approved',
    });
    await service.advanceStage(flow1.flow.id, { at: advanceClock(5) }); // pr start
    const f1PrPath = writeStageArtifactPair('f1-pr', 'pr');
    const f1PrArtifact = await service.registerArtifact(flow1.flow.id, {
      stage: 'pr',
      kind: 'pr_summary',
      path: f1PrPath,
      status: 'ready',
    });
    const completedAt1 = advanceClock(15);
    await service.transitionFlow(flow1.flow.id, {
      to: 'completed',
      at: completedAt1,
      reason: 'PR publicado',
      prPublication: {
        prArtifactId: f1PrArtifact.id,
        status: 'published',
        provider: 'github',
        prUrl: 'https://github.com/org/alpha/pull/1',
        prNumber: 1,
        commitSha: 'a'.repeat(40),
        headBranch: 'factory/met-1',
        baseBranch: 'main',
        draft: false,
        publishedAt: completedAt1,
        secretFindings: [],
        jiraSync: { status: 'not_requested', issueKey: 'MET-1', updatedAt: null, error: null },
        error: null,
        updatedAt: completedAt1,
      },
    });

    // Fluxo 2 (/tmp/repo-alpha): 2 ciclos de review (reprovado no 1º com motivos 'cobertura' e 'regressao', aprovado no 2º), concluído sem PR publicado.
    currentMs = Date.parse('2026-11-21T10:00:00.000Z');
    const flow2 = await service.createFlow({
      task: { inputType: 'jira_key', value: 'MET-2', repoPath: '/tmp/repo-alpha' },
    });
    await service.registerArtifact(flow2.flow.id, {
      stage: 'triage',
      kind: 'specification',
      path: writeStageArtifactPair('f2-triage', 'triage'),
      status: 'ready',
    });
    await service.transitionFlow(flow2.flow.id, { to: 'running', at: advanceClock(5), reason: 'Triagem' });
    await service.transitionFlow(flow2.flow.id, { to: 'waiting_action', at: advanceClock(10), reason: 'Triagem ok' });
    await service.advanceStage(flow2.flow.id, { at: advanceClock(5) }); // planning
    await service.registerArtifact(flow2.flow.id, {
      stage: 'planning',
      kind: 'plan',
      path: writeStageArtifactPair('f2-plan', 'planning'),
      status: 'ready',
    });
    await service.transitionFlow(flow2.flow.id, { to: 'waiting_action', at: advanceClock(10), reason: 'Plano ok' });
    await service.advanceStage(flow2.flow.id, { at: advanceClock(10) }); // dev iter 1
    await service.registerArtifact(flow2.flow.id, {
      stage: 'development',
      kind: 'implementation_report',
      path: writeStageArtifactPair('f2-dev1', 'development'),
      status: 'ready',
    });
    await service.advanceStage(flow2.flow.id, { at: advanceClock(20) }); // tests iter 1
    await service.registerArtifact(flow2.flow.id, {
      stage: 'tests',
      kind: 'test_report',
      path: writeStageArtifactPair('f2-tests1', 'tests'),
      status: 'ready',
    });
    await service.advanceStage(flow2.flow.id, { at: advanceClock(10) }); // review iter 1
    await service.transitionFlow(flow2.flow.id, {
      to: 'running',
      at: advanceClock(5),
      reason: 'Executando review ciclo 1',
    });
    await service.registerArtifact(flow2.flow.id, {
      stage: 'review',
      kind: 'review_report',
      path: writeStageArtifactPair('f2-review1', 'review', {
        verdict: 'changes_requested',
        returnTarget: 'development',
        findings: [
          {
            severity: 'BLOQUEANTE',
            file: 'src/a.ts',
            line: 10,
            explanation: 'Falta teste de erro.',
            category: 'cobertura',
          },
          {
            severity: 'BLOQUEANTE',
            file: 'src/b.ts',
            line: 22,
            explanation: 'Quebrou contrato existente.',
            category: 'regressao',
          },
        ],
      }),
      status: 'ready',
    });
    await service.transitionFlow(flow2.flow.id, {
      to: 'waiting_action',
      at: advanceClock(15),
      reason: 'Ajustes solicitados',
      lastReviewVerdict: 'changes_requested',
    });
    await service.returnStage(flow2.flow.id, {
      targetStage: 'development',
      at: advanceClock(5),
    });
    await service.registerArtifact(flow2.flow.id, {
      stage: 'development',
      kind: 'implementation_report',
      path: writeStageArtifactPair('f2-dev2', 'development'),
      status: 'ready',
    });
    await service.advanceStage(flow2.flow.id, { at: advanceClock(25) }); // tests iter 2
    await service.registerArtifact(flow2.flow.id, {
      stage: 'tests',
      kind: 'test_report',
      path: writeStageArtifactPair('f2-tests2', 'tests'),
      status: 'ready',
    });
    await service.advanceStage(flow2.flow.id, { at: advanceClock(15) }); // review iter 2
    await service.transitionFlow(flow2.flow.id, {
      to: 'running',
      at: advanceClock(5),
      reason: 'Executando review ciclo 2',
    });
    await service.registerArtifact(flow2.flow.id, {
      stage: 'review',
      kind: 'review_report',
      path: writeStageArtifactPair('f2-review2', 'review', {
        verdict: 'approved',
        returnTarget: null,
        findings: [],
      }),
      status: 'ready',
    });
    await service.transitionFlow(flow2.flow.id, {
      to: 'waiting_action',
      at: advanceClock(15),
      reason: 'Aprovado no 2º ciclo',
      lastReviewVerdict: 'approved',
    });
    await service.advanceStage(flow2.flow.id, { at: advanceClock(5) }); // pr
    await service.registerArtifact(flow2.flow.id, {
      stage: 'pr',
      kind: 'pr_summary',
      path: writeStageArtifactPair('f2-pr', 'pr'),
      status: 'ready',
    });
    await service.transitionFlow(flow2.flow.id, {
      to: 'completed',
      at: advanceClock(10),
      reason: 'Concluído manualmente',
    });

    // Fluxo 3 (/tmp/repo-beta): antigo (fora de 7d), cancelado após concluir triagem, com desenvolvimento em andamento (timestamp parcial).
    currentMs = Date.parse('2026-10-01T10:00:00.000Z');
    const flow3 = await service.createFlow({
      task: { inputType: 'title', value: 'Fluxo cancelado antigo', repoPath: '/tmp/repo-beta' },
    });
    await service.registerArtifact(flow3.flow.id, {
      stage: 'triage',
      kind: 'specification',
      path: writeStageArtifactPair('f3-triage', 'triage'),
      status: 'ready',
    });
    await service.transitionFlow(flow3.flow.id, { to: 'running', at: advanceClock(10), reason: 'Triagem' });
    await service.transitionFlow(flow3.flow.id, { to: 'waiting_action', at: advanceClock(40), reason: 'Triagem ok' });
    await service.advanceStage(flow3.flow.id, { at: advanceClock(10) }); // planning running (sem finishedAt)
    await service.cancelFlow(flow3.flow.id, {
      at: advanceClock(20),
      reason: 'Cancelado pelo usuário antes do review',
    });

    // Fluxo 4 (/tmp/repo-beta): recente (dentro de 7d), reprovado no 1º ciclo por 'cobertura' e cancelado em seguida.
    currentMs = Date.parse('2026-11-22T09:00:00.000Z');
    const flow4 = await service.createFlow({
      task: { inputType: 'jira_key', value: 'MET-4', repoPath: '/tmp/repo-beta' },
    });
    await service.transitionFlow(flow4.flow.id, { to: 'running', at: advanceClock(5), reason: 'Triagem' });
    // Registra motivo diretamente para validar persistência mesmo sem sidecar no disco.
    repo.recordReviewOutcome({
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      id: randomUUID(),
      flowId: flow4.flow.id,
      artifactId: null,
      iteration: 1,
      verdict: 'changes_requested',
      rejectionReasons: ['Cobertura', 'cobertura'],
      createdAt: advanceClock(10),
    });
    await service.cancelFlow(flow4.flow.id, {
      at: advanceClock(5),
      reason: 'Cancelado após reprovação',
    });

    // Fluxo 5 (/tmp/repo-beta): em andamento na triagem (timestamp parcial: startedAt sem finishedAt).
    currentMs = Date.parse('2026-11-22T10:00:00.000Z');
    const flow5 = await service.createFlow({
      task: { inputType: 'title', value: 'Fluxo em andamento parcial', repoPath: '/tmp/repo-beta' },
    });
    await service.transitionFlow(flow5.flow.id, {
      to: 'running',
      at: advanceClock(5),
      reason: 'Triagem em andamento',
    });

    // Consulta global (todo o período).
    currentMs = Date.parse('2026-11-22T12:00:00.000Z');
    const allMetrics = service.getMetrics();
    assert.deepEqual(allMetrics.availableRepos, ['/tmp/repo-alpha', '/tmp/repo-beta']);
    assert.equal(allMetrics.summary.totalFlows, 5);
    assert.equal(allMetrics.summary.completedFlows, 2);
    assert.equal(allMetrics.summary.cancelledFlows, 2);
    assert.equal(allMetrics.summary.failedFlows, 0);
    assert.equal(allMetrics.summary.activeFlows, 1);
    assert.equal(allMetrics.summary.openedPrs, 1);
    assert.ok(allMetrics.summary.averageFlowLeadTimeMs !== null);

    // Triagem: concluída em flow1 (20s), flow2 (15s), flow3 (50s); cancelada em flow4 e em aberto (parcial) em flow5.
    const triageLead = allMetrics.stageLeadTimes.find(item => item.stage === 'triage');
    assert.deepEqual(triageLead, {
      stage: 'triage',
      completedCount: 3,
      partialCount: 1,
      averageDurationMs: Math.round((20_000 + 15_000 + 50_000) / 3),
      minDurationMs: 15_000,
      maxDurationMs: 50_000,
    });

    // Planejamento: concluído em flow1 (30s) e flow2 (20s); cancelado em flow3 (não entra na média).
    const planningLead = allMetrics.stageLeadTimes.find(item => item.stage === 'planning');
    assert.equal(planningLead?.completedCount, 2);
    assert.equal(planningLead?.averageDurationMs, 25_000);

    // 1º ciclo: flow1 aprovado; flow2 reprovado; flow3 e flow5 nunca chegaram ao review; flow4 reprovado -> 1 de 3 (33.3%).
    assert.deepEqual(allMetrics.firstCycleReview, {
      evaluatedFlows: 3,
      approvedFirstCycle: 1,
      rejectedFirstCycle: 2,
      approvalRatePercent: 33.3,
    });

    // Ranking de motivos: cobertura (1 em flow2 + 2 em flow4 = 3 ocorrências, 2 fluxos), regressao (1 ocorrência, 1 fluxo).
    assert.deepEqual(allMetrics.rejectionReasons, [
      { reason: 'cobertura', count: 3, flowCount: 2 },
      { reason: 'regressao', count: 1, flowCount: 1 },
    ]);

    // Throughput por repositório.
    assert.deepEqual(allMetrics.byRepository, [
      {
        repoPath: '/tmp/repo-alpha',
        totalFlows: 2,
        completedFlows: 2,
        cancelledFlows: 0,
        failedFlows: 0,
        activeFlows: 0,
        openedPrs: 1,
        firstCycleApprovalRatePercent: 50,
      },
      {
        repoPath: '/tmp/repo-beta',
        totalFlows: 3,
        completedFlows: 0,
        cancelledFlows: 2,
        failedFlows: 0,
        activeFlows: 1,
        openedPrs: 0,
        firstCycleApprovalRatePercent: 0,
      },
    ]);

    // Filtro por janela de 7 dias exclui flow3 (2026-10-01).
    const recentMetrics = service.getMetrics({ period: '7d' });
    assert.equal(recentMetrics.summary.totalFlows, 4);
    assert.equal(recentMetrics.summary.cancelledFlows, 1);
    assert.equal(recentMetrics.summary.activeFlows, 1);
    assert.deepEqual(recentMetrics.availableRepos, ['/tmp/repo-alpha', '/tmp/repo-beta']);

    // Filtro por repositório específico.
    const alphaMetrics = service.getMetrics({ repoPath: '/tmp/repo-alpha', period: '7d' });
    assert.equal(alphaMetrics.summary.totalFlows, 2);
    assert.equal(alphaMetrics.summary.completedFlows, 2);
    assert.equal(alphaMetrics.summary.openedPrs, 1);
    assert.equal(alphaMetrics.firstCycleReview.approvalRatePercent, 50);
    assert.deepEqual(alphaMetrics.rejectionReasons, [
      { reason: 'cobertura', count: 1, flowCount: 1 },
      { reason: 'regressao', count: 1, flowCount: 1 },
    ]);
    assert.equal(alphaMetrics.byRepository.length, 1);
    repo.close();

    // Executa migration v12 novamente para comprovar idempotência.
    const rawDb = new DatabaseSync(dbPath);
    try {
      const v12Migration = REVIEW_MIGRATIONS.find(migration => migration.version === 12);
      assert.ok(v12Migration);
      v12Migration.up(rawDb);
    } finally {
      rawDb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});
