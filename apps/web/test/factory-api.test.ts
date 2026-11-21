import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_MAX_AUTO_ITERATIONS,
  FACTORY_STAGE_ORDER,
} from '@development-factory/shared';
import type {
  FactoryFlow,
  FactoryFlowStage,
  FactoryPreflightRequest,
  FactoryPreflightResponse,
} from '@development-factory/shared';
import {
  FactoryFlowApiError,
  cancelFactoryFlow,
  createFactoryFlow,
  fetchFactoryFlowDetails,
  fetchFactoryFlows,
  fetchFactoryPreflight,
  returnFactoryFlowStage,
  rollbackFactoryFlowCheckpoint,
} from '../src/api/factory-flows';
import { parseAppEventMessage } from '../src/api/sessions';
import {
  canOpenTerminalForFactoryStage,
  getFactoryArtifactKindLabel,
  getFactoryArtifactStatusPresentation,
  getFactoryFlowStatePresentation,
  getFactoryInputTypeLabel,
  getFactoryStageLabel,
  getFactoryStageStatePresentation,
  getFactoryStageStep,
  isFactoryFlowActivelyRunning,
} from '../src/utils/factory-flow-status';

function makeFlow(overrides: Partial<FactoryFlow> = {}): FactoryFlow {
  return {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: '11111111-1111-4111-8111-111111111111',
    title: 'FLUXO-1 · Teste',
    target: {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      inputType: 'title',
      value: 'Implementar fluxo paralelo',
      repoPath: '/home/dev/repos/app',
    },
    currentStage: 'triage',
    state: 'running',
    currentSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    iteration: 0,
    maxIterations: FACTORY_MAX_AUTO_ITERATIONS,
    lastReviewVerdict: null,
    loopPausedReason: null,
    worktreePath: null,
    branchName: null,
    baseBranch: null,
    createdAt: '2026-11-19T12:00:00.000Z',
    updatedAt: '2026-11-19T12:00:00.000Z',
    finishedAt: null,
    transitions: [
      {
        from: 'queued',
        to: 'running',
        stage: 'triage',
        at: '2026-11-19T12:00:00.000Z',
        reason: 'Sessão iniciada',
      },
    ],
    error: null,
    ...overrides,
  };
}

function makeStages(flowId: string): FactoryFlowStage[] {
  return FACTORY_STAGE_ORDER.map((name, index) => ({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    flowId,
    name,
    state: index === 0 ? 'running' : 'pending',
    sessionId: index === 0 ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null,
    reportPath: null,
    sessionPath: null,
    createdAt: '2026-11-19T12:00:00.000Z',
    updatedAt: '2026-11-19T12:00:00.000Z',
    startedAt: index === 0 ? '2026-11-19T12:00:00.000Z' : null,
    finishedAt: null,
    error: null,
  }));
}

test('utilitários de factory-flow-status retornam rótulos e estados consistentes', () => {
  assert.equal(getFactoryStageLabel('triage'), 'Triagem');
  assert.equal(getFactoryStageStep('triage'), '01');
  assert.equal(getFactoryStageLabel('pr'), 'PR');
  assert.equal(getFactoryStageStep('pr'), '06');
  assert.equal(getFactoryInputTypeLabel('jira_key'), 'Chave JIRA');
  assert.equal(getFactoryArtifactKindLabel('specification'), 'Especificação');
  assert.equal(getFactoryArtifactKindLabel('implementation_report'), 'Relatório de Implementação');
  assert.equal(getFactoryArtifactKindLabel('test_report'), 'Relatório de testes');
  assert.equal(getFactoryArtifactKindLabel('review_report'), 'Code Review');

  assert.equal(isFactoryFlowActivelyRunning({ state: 'running' }), true);
  assert.equal(isFactoryFlowActivelyRunning({ state: 'queued' }), true);
  assert.equal(isFactoryFlowActivelyRunning({ state: 'waiting_action' }), false);
  assert.equal(isFactoryFlowActivelyRunning({ state: 'completed' }), false);

  assert.equal(getFactoryFlowStatePresentation('waiting_action').label, 'Aguardando ação');
  assert.equal(getFactoryStageStatePresentation('completed').label, 'Concluída');
  assert.equal(getFactoryArtifactStatusPresentation('ready').label, 'Pronto');

  assert.equal(canOpenTerminalForFactoryStage('triage'), false);
  assert.equal(canOpenTerminalForFactoryStage('planning'), false);
  assert.equal(canOpenTerminalForFactoryStage('development'), false);
  assert.equal(canOpenTerminalForFactoryStage('tests'), false);
  assert.equal(canOpenTerminalForFactoryStage('review'), false);
  assert.equal(canOpenTerminalForFactoryStage('pr'), false);
});

test('parseAppEventMessage valida eventos de fluxo da Factory via SSE', () => {
  const flow = makeFlow();
  const validPayload = JSON.stringify({
    type: 'factory_flow.created',
    flow,
  });

  const parsed = parseAppEventMessage(validPayload);
  assert.ok(parsed);
  assert.equal(parsed.type, 'factory_flow.created');
  if (parsed.type === 'factory_flow.created') {
    assert.equal(parsed.flow.id, flow.id);
  }

  assert.equal(parseAppEventMessage('{invalid-json'), null);
  assert.equal(parseAppEventMessage(JSON.stringify({ type: 'unknown' })), null);
});

test('cliente HTTP envia o preflight e preserva os resultados aprovado e bloqueado', async context => {
  const repoPath = '/home/dev/repos/app';
  const controller = new AbortController();
  const approvedRequest: FactoryPreflightRequest = { repoPath, inputType: 'title' };
  const approved: FactoryPreflightResponse = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    blocked: false,
    checks: {
      claude: { status: 'ok', message: 'Claude Code disponível.' },
      jiraMcp: { status: 'ok', message: 'A entrada por título dispensa o MCP do Jira.' },
      github: { status: 'warning', message: 'Use gh auth login antes da etapa de PR.' },
      git: { status: 'ok', message: 'A branch base main existe.' },
      profile: { status: 'ok', message: 'A Factory usará o perfil padrão deste repositório.' },
    },
  };
  const blockedRequest: FactoryPreflightRequest = { repoPath, inputType: 'jira_url' };
  const blocked: FactoryPreflightResponse = {
    ...approved,
    blocked: true,
    checks: {
      ...approved.checks,
      jiraMcp: { status: 'error', message: 'Conecte o Atlassian Rovo em /mcp no Claude Code.' },
    },
  };
  const cases = [
    { request: approvedRequest, result: approved },
    { request: blockedRequest, result: blocked },
  ];
  const fetchMock = context.mock.method(
    globalThis,
    'fetch',
    async (url: string | URL | Request, init?: RequestInit) => {
      const expected = cases.shift();
      assert.ok(expected);
      assert.equal(url, 'http://127.0.0.1:3001/api/factory/preflight');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
      assert.equal(init?.body, JSON.stringify(expected.request));
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.signal, controller.signal);
      return Response.json(expected.result);
    },
  );

  assert.deepEqual(await fetchFactoryPreflight(approvedRequest, controller.signal), approved);
  assert.deepEqual(await fetchFactoryPreflight(blockedRequest, controller.signal), blocked);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('cliente HTTP rejeita preflight inválido e preserva o erro retornado pela API', async context => {
  const request: FactoryPreflightRequest = { repoPath: '/home/dev/repos/app', inputType: 'title' };
  const responses = [
    Response.json({ contractVersion: FACTORY_FLOW_CONTRACT_VERSION, blocked: false }),
    Response.json(
      {
        error: {
          code: 'FACTORY_FLOW_INVALID_INPUT',
          message: 'Os dados para verificar o ambiente da Factory são inválidos.',
        },
      },
      { status: 400 },
    ),
  ];
  context.mock.method(globalThis, 'fetch', async () => {
    const response = responses.shift();
    assert.ok(response);
    return response;
  });

  await assert.rejects(
    fetchFactoryPreflight(request),
    (error: unknown) =>
      error instanceof FactoryFlowApiError && error.code === 'FACTORY_FLOW_INVALID_RESPONSE',
  );
  await assert.rejects(
    fetchFactoryPreflight(request),
    (error: unknown) =>
      error instanceof FactoryFlowApiError &&
      error.code === 'FACTORY_FLOW_INVALID_INPUT' &&
      error.statusCode === 400,
  );
});

test('cliente HTTP factory-flows cria, lista, detalha e cancela fluxos com validação Zod', async context => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const flow = makeFlow();
  const stages = makeStages(flow.id);
  const requests: Array<{ url: string; method: string }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    requests.push({ url, method });

    if (url.endsWith('/api/factory/flows') && method === 'POST') {
      return new Response(
        JSON.stringify({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          flow,
          stages,
          replayed: false,
          session: {
            sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            mode: 'factory',
            title: flow.title,
            repoPath: flow.target.repoPath,
            status: 'running',
            historyState: 'pending',
            flowId: flow.id,
            stage: 'triage',
            startedAt: '2026-11-19T12:00:00.000Z',
            finishedAt: null,
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith('/api/factory/flows') && method === 'GET') {
      return new Response(
        JSON.stringify({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          flows: [flow],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith(`/api/factory/flows/${flow.id}`) && method === 'GET') {
      return new Response(
        JSON.stringify({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          flow,
          stages,
          artifacts: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith(`/api/factory/flows/${flow.id}/return`) && method === 'POST') {
      return new Response(
        JSON.stringify({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          flow: {
            ...flow,
            currentStage: 'development',
            state: 'waiting_action',
            currentSessionId: null,
            updatedAt: '2026-11-19T12:01:00.000Z',
            transitions: [
              ...flow.transitions,
              {
                from: 'running',
                to: 'waiting_action',
                stage: 'development',
                at: '2026-11-19T12:01:00.000Z',
                reason: 'Retorno para correções',
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith(`/api/factory/flows/${flow.id}/cancel`) && method === 'POST') {
      return new Response(
        JSON.stringify({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          flow: {
            ...flow,
            state: 'cancelled',
            currentSessionId: null,
            finishedAt: '2026-11-19T12:01:00.000Z',
            updatedAt: '2026-11-19T12:01:00.000Z',
            transitions: [
              ...flow.transitions,
              {
                from: 'running',
                to: 'cancelled',
                stage: 'triage',
                at: '2026-11-19T12:01:00.000Z',
                reason: 'Teste',
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith(`/api/factory/flows/${flow.id}/rollback`) && method === 'POST') {
      const checkpointId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const commitSha = 'a1b2c3d4e5f6789012345678901234567890abcd';
      return new Response(
        JSON.stringify({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          flow: {
            ...flow,
            state: 'waiting_action',
            currentStage: 'development',
            currentSessionId: null,
            updatedAt: '2026-11-19T12:01:00.000Z',
            transitions: [
              ...flow.transitions,
              {
                from: 'running',
                to: 'waiting_action',
                stage: 'development',
                at: '2026-11-19T12:01:00.000Z',
                reason: 'Rollback concluído',
              },
            ],
          },
          checkpoint: {
            contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
            id: checkpointId,
            flowId: flow.id,
            stage: 'development',
            iteration: 1,
            commitSha,
            branchName: 'factory/fluxo-1',
            sessionId: null,
            message: 'Checkpoint 1',
            createdAt: '2026-11-19T12:00:30.000Z',
          },
          restoredCommitSha: commitSha,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        error: {
          code: 'FACTORY_FLOW_NOT_FOUND',
          message: 'Fluxo não encontrado.',
        },
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  const created = await createFactoryFlow({
    task: { inputType: 'title', value: 'Implementar fluxo paralelo', repoPath: '/home/dev/repos/app' },
    startSession: true,
  });
  assert.equal(created.flow.id, flow.id);
  assert.equal(created.session?.flowId, flow.id);

  const list = await fetchFactoryFlows();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, flow.id);

  const details = await fetchFactoryFlowDetails(flow.id);
  assert.equal(details.stages.length, 6);
  assert.equal(details.artifacts.length, 0);

  const cancelled = await cancelFactoryFlow(flow.id, { reason: 'Teste' });
  assert.equal(cancelled.state, 'cancelled');

  const returned = await returnFactoryFlowStage(flow.id, {
    targetStage: 'development',
    approvedNotes: 'Corrigir erro apontado',
  });
  assert.equal(returned.flow.currentStage, 'development');

  const rolledBack = await rollbackFactoryFlowCheckpoint(flow.id, {});
  assert.equal(rolledBack.restoredCommitSha, 'a1b2c3d4e5f6789012345678901234567890abcd');
  assert.equal(rolledBack.checkpoint.stage, 'development');

  await assert.rejects(
    () => fetchFactoryFlowDetails('99999999-9999-4999-8999-999999999999'),
    (error: unknown) =>
      error instanceof FactoryFlowApiError &&
      error.code === 'FACTORY_FLOW_NOT_FOUND' &&
      error.statusCode === 404,
  );

  assert.equal(requests.length, 7);
});
