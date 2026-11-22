import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CancelFactoryFlowRequestSchema,
  CreateFactoryFlowRequestSchema,
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_FLOW_TRANSITIONS,
  FACTORY_STAGE_ORDER,
  FINAL_FACTORY_FLOW_STATES,
  FactoryFlowApiErrorResponseSchema,
  FactoryFlowArtifactSchema,
  FactoryFlowCheckpointSchema,
  FactoryFlowDetailsSchema,
  FactoryFlowDomainError,
  FactoryFlowSchema,
  FactoryFlowStageSchema,
  FactoryReviewDecisionSchema,
  FactoryTaskInputSchema,
  FactoryWorktreeRetentionPolicySchema,
  ListFactoryFlowsFilterSchema,
  RegisterFactoryFlowArtifactRequestSchema,
  RollbackFactoryFlowCheckpointRequestSchema,
  RollbackFactoryFlowCheckpointResponseSchema,
  canAdvanceFactoryStage,
  canReturnFactoryStage,
  canTransitionFactoryFlow,
  getNextFactoryStage,
  getReadyFactoryStageArtifact,
  isFinalFactoryFlowState,
  resolveFactoryReviewDecision,
  returnFactoryFlowStage,
  transitionFactoryFlow,
  type FactoryFlow,
  type FactoryFlowState,
  type FactoryStageName,
} from '@development-factory/shared';

const flowId = '00000000-0000-4000-8000-000000000101';
const stageId = '00000000-0000-4000-8000-000000000102';
const artifactId = '00000000-0000-4000-8000-000000000103';
const sessionId = '00000000-0000-4000-8000-000000000104';

const createdAt = '2026-11-19T12:00:00.000Z';
const runningAt = '2026-11-19T12:00:01.000Z';
const waitingAt = '2026-11-19T12:00:02.000Z';
const finishedAt = '2026-11-19T12:00:03.000Z';

const flowError = {
  contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
  code: 'STAGE_EXECUTION_FAILED',
  message: 'Falha ao executar a etapa do fluxo',
  occurredAt: finishedAt,
  retryable: true,
};

function queuedFlow(): FactoryFlow {
  return FactoryFlowSchema.parse({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: flowId,
    title: 'PROD-1234 · Fluxo de desenvolvimento',
    target: {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      inputType: 'jira_key',
      value: 'PROD-1234',
      repoPath: '/home/user/repo',
    },
    state: 'queued',
    currentStage: 'triage',
    currentSessionId: null,
    createdAt,
    updatedAt: createdAt,
    finishedAt: null,
    transitions: [],
    error: null,
  });
}

function inState(state: FactoryFlowState): FactoryFlow {
  const initial = queuedFlow();
  if (state === 'queued') {
    return initial;
  }
  const running = transitionFactoryFlow(initial, {
    to: 'running',
    at: runningAt,
    reason: 'Sessão iniciada',
    currentSessionId: sessionId,
  });
  if (state === 'running') {
    return running;
  }
  if (state === 'waiting_action') {
    return transitionFactoryFlow(running, {
      to: 'waiting_action',
      at: waitingAt,
      reason: 'Aguardando aprovação para próxima etapa',
    });
  }
  return transitionFactoryFlow(running, {
    to: state,
    at: finishedAt,
    reason: 'Estado final de teste',
    error: state === 'failed' ? flowError : null,
  });
}

const expectedTransitions: Record<FactoryFlowState, readonly FactoryFlowState[]> = {
  queued: ['running', 'waiting_action', 'failed', 'cancelled'],
  running: ['waiting_action', 'completed', 'failed', 'cancelled'],
  waiting_action: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

test('respeita a ordem sequencial das etapas do fluxo da Factory', () => {
  assert.deepEqual(FACTORY_STAGE_ORDER, [
    'triage',
    'planning',
    'development',
    'tests',
    'review',
    'pr',
  ]);
  assert.equal(getNextFactoryStage('triage'), 'planning');
  assert.equal(getNextFactoryStage('planning'), 'development');
  assert.equal(getNextFactoryStage('development'), 'tests');
  assert.equal(getNextFactoryStage('tests'), 'review');
  assert.equal(getNextFactoryStage('review'), 'pr');
  assert.equal(getNextFactoryStage('pr'), null);

  assert.equal(canAdvanceFactoryStage('triage', 'planning'), true);
  assert.equal(canAdvanceFactoryStage('triage', 'development'), false);
  assert.equal(canAdvanceFactoryStage('planning', 'triage'), false);
  assert.equal(canAdvanceFactoryStage('pr', 'triage'), false);
});

test('permite apenas transições válidas na máquina de estados do FactoryFlow', () => {
  const states = Object.keys(FACTORY_FLOW_TRANSITIONS) as FactoryFlowState[];
  for (const from of states) {
    assert.deepEqual(FACTORY_FLOW_TRANSITIONS[from], expectedTransitions[from]);
    assert.equal(isFinalFactoryFlowState(from), FINAL_FACTORY_FLOW_STATES.includes(from));

    for (const to of states) {
      const allowed = expectedTransitions[from].includes(to);
      assert.equal(canTransitionFactoryFlow(from, to), allowed);

      const flow = inState(from);
      if (allowed) {
        const updated = transitionFactoryFlow(flow, {
          to,
          at: finishedAt,
          reason: `Transição ${from} -> ${to}`,
          error: to === 'failed' ? flowError : null,
        });
        assert.equal(updated.state, to);
        assert.equal(updated.finishedAt !== null, isFinalFactoryFlowState(to));
      } else {
        assert.throws(
          () => transitionFactoryFlow(flow, { to, at: finishedAt, reason: 'Transição inválida' }),
          error =>
            error instanceof FactoryFlowDomainError &&
            error.code === 'FACTORY_FLOW_INVALID_TRANSITION',
        );
      }
    }
  }
});

test('permite avançar etapa apenas na ordem sequencial ao transicionar o fluxo', () => {
  const running = inState('running');
  const waitingNext = transitionFactoryFlow(running, {
    to: 'waiting_action',
    stage: 'planning',
    at: waitingAt,
    reason: 'Triagem concluída; avançando para planejamento',
  });
  assert.equal(waitingNext.currentStage, 'planning');

  assert.throws(
    () =>
      transitionFactoryFlow(running, {
        to: 'waiting_action',
        stage: 'development' as FactoryStageName,
        at: waitingAt,
        reason: 'Tentativa de pular etapa',
      }),
    error =>
      error instanceof FactoryFlowDomainError &&
      error.code === 'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
  );
});

test('rejeita transição com contrato inconsistente', () => {
  const running = inState('running');
  assert.throws(
    () =>
      transitionFactoryFlow(running, {
        to: 'failed',
        at: finishedAt,
        reason: 'Erro sem payload',
      }),
    error =>
      error instanceof FactoryFlowDomainError &&
      error.code === 'FACTORY_FLOW_INVALID_CONTRACT',
  );
});

test('valida entradas de tarefa da Factory e requisições de criação', () => {
  const validKey = CreateFactoryFlowRequestSchema.safeParse({
    task: {
      inputType: 'jira_key',
      value: 'DEV-42',
      repoPath: '/home/user/repo',
    },
    idempotencyKey: 'req-dev-42',
  });
  assert.equal(validKey.success, true);

  const validUrl = FactoryTaskInputSchema.safeParse({
    inputType: 'jira_url',
    value: 'https://empresa.atlassian.net/browse/DEV-42',
    repoPath: '/home/user/repo',
  });
  assert.equal(validUrl.success, true);

  const validTitle = FactoryTaskInputSchema.safeParse({
    inputType: 'title',
    value: 'Implementar fluxos paralelos na Factory',
    repoPath: '/home/user/repo',
  });
  assert.equal(validTitle.success, true);

  assert.equal(
    FactoryTaskInputSchema.safeParse({
      inputType: 'jira_key',
      value: 'invalid-key',
      repoPath: '/home/user/repo',
    }).success,
    false,
  );
  assert.equal(
    FactoryTaskInputSchema.safeParse({
      inputType: 'jira_url',
      value: 'ftp://empresa.atlassian.net/browse/DEV-42',
      repoPath: '/home/user/repo',
    }).success,
    false,
  );
  assert.equal(
    FactoryTaskInputSchema.safeParse({
      inputType: 'title',
      value: 'Tarefa válida',
      repoPath: 'relative/path',
    }).success,
    false,
  );
});

test('valida etapas, artefatos, filtros e envelope de erro da API', () => {
  const stage = FactoryFlowStageSchema.parse({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: stageId,
    flowId,
    name: 'triage',
    state: 'running',
    sessionId,
    reportPath: null,
    sessionPath: null,
    createdAt,
    updatedAt: runningAt,
    startedAt: runningAt,
    finishedAt: null,
    error: null,
  });
  assert.equal(stage.state, 'running');

  const artifact = FactoryFlowArtifactSchema.parse({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: artifactId,
    flowId,
    stage: 'triage',
    sessionId,
    kind: 'plan',
    format: 'markdown',
    path: '/home/user/repo/.factory/plan.md',
    status: 'ready',
    createdAt,
    updatedAt: runningAt,
    error: null,
  });
  assert.equal(artifact.kind, 'plan');

  assert.equal(
    RegisterFactoryFlowArtifactRequestSchema.parse({
      stage: 'triage',
      kind: 'plan',
      path: '/home/user/repo/.factory/plan.md',
    }).format,
    'markdown',
  );

  assert.equal(
    ListFactoryFlowsFilterSchema.safeParse({
      state: 'running',
      stage: 'triage',
      repoPath: '/home/user/repo',
      limit: 20,
    }).success,
    true,
  );

  assert.equal(
    FactoryFlowApiErrorResponseSchema.safeParse({
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      error: {
        code: 'FACTORY_FLOW_NOT_FOUND',
        message: 'Fluxo não encontrado.',
      },
    }).success,
    true,
  );
});

test('permite retorno controlado de review para development ou tests e resolve artefatos prontos', () => {
  assert.equal(canReturnFactoryStage('review', 'development'), true);
  assert.equal(canReturnFactoryStage('review', 'tests'), true);
  assert.equal(canReturnFactoryStage('review', 'planning'), false);
  assert.equal(canReturnFactoryStage('tests', 'development'), false);

  let flow = inState('waiting_action');
  for (const stage of ['planning', 'development', 'tests', 'review'] as const) {
    flow = transitionFactoryFlow(flow, {
      to: 'running',
      stage,
      at: waitingAt,
      reason: `Avança para ${stage}`,
      currentSessionId: null,
    });
    flow = transitionFactoryFlow(flow, {
      to: 'waiting_action',
      stage,
      at: waitingAt,
      reason: `Aguarda ação em ${stage}`,
    });
  }
  assert.equal(flow.currentStage, 'review');

  const testReturnDecision = resolveFactoryReviewDecision({
    verdict: 'changes_requested',
    returnTarget: 'tests',
  });
  assert.equal(testReturnDecision.returnTarget, 'tests');
  assert.equal(canReturnFactoryStage(flow.currentStage, testReturnDecision.returnTarget!), true);

  const returnedToTests = returnFactoryFlowStage(flow, {
    to: 'running',
    stage: testReturnDecision.returnTarget!,
    at: waitingAt,
    reason: 'Bloqueadores encontrados apenas nos testes',
  });
  assert.equal(returnedToTests.currentStage, 'tests');

  const devReturnDecision = FactoryReviewDecisionSchema.parse({
    verdict: 'changes_requested',
    returnTarget: 'development',
  });
  assert.equal(canReturnFactoryStage(flow.currentStage, devReturnDecision.returnTarget!), true);

  const returnedToDev = returnFactoryFlowStage(flow, {
    to: 'running',
    stage: devReturnDecision.returnTarget!,
    at: waitingAt,
    reason: 'Defeito de implementação encontrado no código de produção',
  });
  assert.equal(returnedToDev.currentStage, 'development');

  assert.throws(
    () =>
      returnFactoryFlowStage(flow, {
        to: 'running',
        stage: 'planning',
        at: waitingAt,
        reason: 'Retorno inválido',
      }),
    error =>
      error instanceof FactoryFlowDomainError &&
      error.code === 'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
  );

  const testArtifact = getReadyFactoryStageArtifact(
    {
      stages: [
        FactoryFlowStageSchema.parse({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          id: stageId,
          flowId,
          name: 'tests',
          state: 'waiting_action',
          sessionId: null,
          reportPath: '/home/user/repo/.code-reviews/test-report.md',
          sessionPath: null,
          createdAt,
          updatedAt: waitingAt,
          startedAt: runningAt,
          finishedAt: null,
          error: null,
        }),
      ],
      artifacts: [
        FactoryFlowArtifactSchema.parse({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          id: artifactId,
          flowId,
          stage: 'tests',
          sessionId,
          kind: 'test_report',
          format: 'markdown',
          path: '/home/user/repo/.code-reviews/test-report.md',
          status: 'ready',
          createdAt,
          updatedAt: waitingAt,
          error: null,
        }),
      ],
    },
    'tests',
  );
  assert.equal(testArtifact?.kind, 'test_report');
});

test('FactoryFlowDetailsSchema e FactoryFlowCheckpointSchema validam metadados de worktree e checkpoints', () => {
  const checkpointId = '00000000-0000-4000-8000-000000000105';
  const checkpoint = FactoryFlowCheckpointSchema.parse({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: checkpointId,
    flowId,
    stage: 'development',
    iteration: 1,
    commitSha: 'a1b2c3d4e5f6789012345678901234567890abcd',
    branchName: 'factory/PROD-1234',
    sessionId,
    message: 'Checkpoint após desenvolvimento',
    createdAt: waitingAt,
  });
  assert.equal(checkpoint.stage, 'development');
  assert.equal(checkpoint.iteration, 1);

  const flowWithWorktree = FactoryFlowSchema.parse({
    ...queuedFlow(),
    worktreePath: '/home/user/.local/share/development-factory/worktrees/flow-1',
    branchName: 'factory/PROD-1234',
    baseBranch: 'main',
  });

  const explicitDetails = FactoryFlowDetailsSchema.parse({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow: flowWithWorktree,
    stages: [],
    artifacts: [],
    worktreePath: flowWithWorktree.worktreePath,
    branchName: flowWithWorktree.branchName,
    baseBranch: flowWithWorktree.baseBranch,
    checkpoints: [checkpoint],
  });
  assert.equal(explicitDetails.worktreePath, flowWithWorktree.worktreePath);
  assert.equal(explicitDetails.branchName, 'factory/PROD-1234');
  assert.equal(explicitDetails.baseBranch, 'main');
  assert.equal(explicitDetails.checkpoints.length, 1);

  const derivedDetails = FactoryFlowDetailsSchema.parse({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow: flowWithWorktree,
    stages: [],
    artifacts: [],
  });
  assert.equal(derivedDetails.worktreePath, flowWithWorktree.worktreePath);
  assert.equal(derivedDetails.branchName, 'factory/PROD-1234');
  assert.equal(derivedDetails.baseBranch, 'main');
  assert.deepEqual(derivedDetails.checkpoints, []);

  assert.equal(
    FactoryFlowDetailsSchema.safeParse({
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      flow: flowWithWorktree,
      stages: [],
      artifacts: [],
      worktreePath: '/tmp/outro-worktree',
      checkpoints: [],
    }).success,
    false,
  );

  assert.equal(
    FactoryFlowCheckpointSchema.safeParse({
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      id: checkpointId,
      flowId,
      stage: 'development',
      iteration: 0,
      commitSha: 'not-a-sha',
      branchName: 'factory/PROD-1234',
      createdAt: waitingAt,
    }).success,
    false,
  );

  assert.equal(
    FactoryFlowSchema.safeParse({
      ...queuedFlow(),
      branchName: 'feat..invalid',
    }).success,
    false,
  );

  assert.equal(FactoryWorktreeRetentionPolicySchema.safeParse('cleanup_on_finish').success, true);
  assert.equal(FactoryWorktreeRetentionPolicySchema.safeParse('keep_all').success, true);
  assert.equal(FactoryWorktreeRetentionPolicySchema.safeParse('cleanup_always').success, true);
  assert.equal(FactoryWorktreeRetentionPolicySchema.safeParse('invalid_policy').success, false);

  assert.equal(
    CancelFactoryFlowRequestSchema.safeParse({ reason: 'Abortar', keepWorktree: true }).success,
    true,
  );
  assert.equal(RollbackFactoryFlowCheckpointRequestSchema.safeParse({}).success, true);
  assert.equal(
    RollbackFactoryFlowCheckpointRequestSchema.safeParse({
      checkpointId,
      reason: 'Reverter regressão',
    }).success,
    true,
  );
  assert.equal(
    RollbackFactoryFlowCheckpointRequestSchema.safeParse({ commitSha: 'not-a-sha' }).success,
    false,
  );

  const rollbackResponse = RollbackFactoryFlowCheckpointResponseSchema.safeParse({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow: flowWithWorktree,
    checkpoint,
    restoredCommitSha: checkpoint.commitSha,
  });
  assert.equal(rollbackResponse.success, true);
});
