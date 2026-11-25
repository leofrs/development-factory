import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_MAX_AUTO_ITERATIONS,
  FACTORY_STAGE_ORDER,
} from '@development-factory/shared';
import type {
  AppEvent,
  BackgroundSessionSummary,
  FactoryFlow,
  FactoryFlowDetails,
  FactoryPlanningApprovalInput,
} from '@development-factory/shared';
import { FactoryFlowRoadmapModal } from '../src/components/FactoryFlowRoadmapModal';
import { createPlanningGateDrafts } from '../src/components/FactoryPlanningGatePanel';
import {
  useBackgroundOperations,
  type BackgroundOperationsState,
} from '../src/hooks/useBackgroundOperations';

function createFlow(overrides: Partial<FactoryFlow> = {}): FactoryFlow {
  return {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: '11111111-1111-4111-8111-111111111111',
    title: 'FLOW-1 · Fluxo mapeado na Fase 1',
    target: {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      inputType: 'jira_key',
      value: 'FLOW-1',
      repoPath: '/home/dev/repos/app-alvo',
    },
    currentStage: 'triage',
    state: 'waiting_action',
    currentSessionId: null,
    iteration: 0,
    maxIterations: FACTORY_MAX_AUTO_ITERATIONS,
    lastReviewVerdict: null,
    loopPausedReason: null,
    worktreePath: '/home/dev/.local/share/development-factory/worktrees/flow-1',
    branchName: 'factory/flow-1',
    baseBranch: 'main',
    createdAt: '2026-11-25T10:00:00.000Z',
    updatedAt: '2026-11-25T10:05:00.000Z',
    finishedAt: null,
    transitions: [],
    error: null,
    ...overrides,
  };
}

function createStages(flow: FactoryFlow): FactoryFlowDetails['stages'] {
  return FACTORY_STAGE_ORDER.map(name => ({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: `22222222-2222-4222-8222-22222222220${FACTORY_STAGE_ORDER.indexOf(name) + 1}`,
    flowId: flow.id,
    name,
    state: name === flow.currentStage ? 'waiting_action' : 'pending',
    sessionId: null,
    reportPath:
      name === 'triage'
        ? '/tmp/artifacts/triage.md'
        : name === 'planning'
          ? '/tmp/artifacts/planning.md'
          : null,
    sessionPath: null,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    startedAt: name === 'triage' || name === 'planning' ? flow.createdAt : null,
    finishedAt: null,
    error: null,
  }));
}

function setupDom(context: { after: (fn: () => void) => void }) {
  const window = parseHTML('<html><body><div id="phase1-root"></div></body></html>');
  const { document } = window;
  const replaceProperty = (target: object, name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, value, writable: true });
    context.after(() => {
      if (original) {
        Object.defineProperty(target, name, original);
      } else {
        Reflect.deleteProperty(target, name);
      }
    });
  };
  replaceProperty(window.HTMLElement.prototype, 'showModal', function (this: HTMLElement) {
    this.setAttribute('open', '');
  });
  replaceProperty(window.HTMLElement.prototype, 'close', function (this: HTMLElement) {
    this.removeAttribute('open');
  });
  replaceProperty(globalThis, 'window', window);
  replaceProperty(globalThis, 'document', document);
  replaceProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

  const container = document.getElementById('phase1-root');
  assert(container);
  return { window, document, container, replaceProperty };
}

test('Fase 1.1 (UI): modal exibe portão humano da Triagem para falha do Jira e ambiguidades', async context => {
  const { container } = setupDom(context);
  const flow = createFlow({
    currentStage: 'triage',
    state: 'waiting_action',
    loopPausedReason:
      'Triagem pausada: falha ao consultar o Jira MCP (401 Unauthorized) e 1 bloqueador/ambiguidade aguardando resposta humana antes do Planejamento.',
  });
  const initialDetails: FactoryFlowDetails = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow,
    stages: createStages(flow),
    artifacts: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: '33333333-3333-4333-8333-333333333331',
        flowId: flow.id,
        stage: 'triage',
        sessionId: null,
        kind: 'specification',
        format: 'markdown',
        path: '/tmp/artifacts/triage.md',
        status: 'ready',
        iteration: 0,
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt,
        error: null,
      },
    ],
    worktreePath: flow.worktreePath,
    branchName: flow.branchName,
    baseBranch: flow.baseBranch,
    checkpoints: [],
    triageGate: {
      blocked: true,
      jiraError: '401 Unauthorized',
      blockers: ['Definir regra de arredondamento do desconto.'],
    },
  };

  context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json(initialDetails)));

  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(FactoryFlowRoadmapModal, {
          flow,
          initialDetails,
          onClose: () => undefined,
          onAdvanceFlowStage: async () => undefined,
          onRerunFlowStage: async () => undefined,
          onViewMarkdown: () => undefined,
        }),
      );
    });

    const text = container.textContent ?? '';
    assert.match(text, /Portão humano · Ação necessária/);
    assert.match(text, /Falha na consulta ao Jira MCP/);
    assert.match(text, /401 Unauthorized/);
    assert.match(text, /Definir regra de arredondamento do desconto\./);
    assert.match(text, /Respostas aos bloqueadores \/ Complemento de contexto/);
    assert.match(text, /Avançar para Planejamento/);
  } finally {
    act(() => {
      root.unmount();
    });
  }
});

test('Fase 1.2 (UI): sidecar de Planejamento alimenta o formulário de aprovação e envia planningApproval', async context => {
  const { container } = setupDom(context);
  const flow = createFlow({
    currentStage: 'planning',
    state: 'waiting_action',
  });
  const planningGate: NonNullable<FactoryFlowDetails['planningGate']> = {
    pendingDecisions: [
      {
        question: 'Qual estratégia de retry adotar?',
        options: ['Backoff exponencial', 'Intervalo fixo'],
        recommendedOption: 'Backoff exponencial',
      },
    ],
    acceptanceCriteria: [{ id: 'CA1', description: 'Repetir chamadas idempotentes em 503.' }],
  };

  const drafts = createPlanningGateDrafts(planningGate, null);
  assert.equal(drafts.decisions[0]?.id, 'D1');
  assert.equal(drafts.decisions[0]?.mode, 'recommended');
  assert.equal(drafts.criteria[0]?.id, 'CA1');

  const initialDetails: FactoryFlowDetails = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow,
    stages: createStages(flow),
    artifacts: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: '33333333-3333-4333-8333-333333333331',
        flowId: flow.id,
        stage: 'triage',
        sessionId: null,
        kind: 'specification',
        format: 'markdown',
        path: '/tmp/artifacts/triage.md',
        status: 'ready',
        iteration: 0,
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt,
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: '33333333-3333-4333-8333-333333333332',
        flowId: flow.id,
        stage: 'planning',
        sessionId: null,
        kind: 'plan',
        format: 'markdown',
        path: '/tmp/artifacts/planning.md',
        status: 'ready',
        iteration: 0,
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt,
        error: null,
      },
    ],
    worktreePath: flow.worktreePath,
    branchName: flow.branchName,
    baseBranch: flow.baseBranch,
    checkpoints: [],
    planningGate,
  };

  context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json(initialDetails)));

  const submittedPayloads: Array<{
    flowId: string;
    planningApproval?: FactoryPlanningApprovalInput;
  }> = [];

  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(FactoryFlowRoadmapModal, {
          flow,
          initialDetails,
          onClose: () => undefined,
          onAdvanceFlowStage: async (flowId, options) => {
            submittedPayloads.push({
              flowId,
              planningApproval: options?.planningApproval,
            });
          },
          onRerunFlowStage: async () => undefined,
          onViewMarkdown: () => undefined,
        }),
      );
    });

    const approveButton = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('Aprovar e Iniciar Desenvolvimento'),
    );
    assert.ok(approveButton);

    await act(async () => {
      approveButton.click();
    });

    assert.equal(submittedPayloads.length, 1);
    assert.equal(submittedPayloads[0]?.flowId, flow.id);
    assert.equal(submittedPayloads[0]?.planningApproval?.decisions[0]?.id, 'D1');
    assert.equal(
      submittedPayloads[0]?.planningApproval?.decisions[0]?.selectedOption,
      'Backoff exponencial',
    );
    assert.equal(submittedPayloads[0]?.planningApproval?.acceptanceCriteria[0]?.approved, true);
  } finally {
    act(() => {
      root.unmount();
    });
  }
});

test('Fase 1.2 (UI): useBackgroundOperations recebe atualizações via SSE e gera notificações com o modal fechado', async context => {
  const { container, replaceProperty } = setupDom(context);

  const initialFlow = createFlow({
    currentStage: 'planning',
    state: 'running',
    currentSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    transitions: [
      {
        from: 'queued',
        to: 'running',
        stage: 'planning',
        at: '2026-11-25T10:05:00.000Z',
        reason: 'Planejamento em execução',
      },
    ],
  });
  const planningSession: BackgroundSessionSummary = {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    mode: 'factory',
    title: initialFlow.title,
    repoPath: initialFlow.target.repoPath,
    status: 'exited',
    historyState: 'saved',
    flowId: initialFlow.id,
    stage: 'planning',
    startedAt: initialFlow.createdAt,
    finishedAt: '2026-11-25T10:06:00.000Z',
    reportPath: '/tmp/artifacts/planning.md',
  };

  const streams: FakeEventSource[] = [];
  class FakeEventSource {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;

    constructor() {
      streams.push(this);
    }

    close() {}

    emit(event: AppEvent) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }
  replaceProperty(globalThis, 'EventSource', FakeEventSource);

  context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => {
    const pathname = new URL(input instanceof Request ? input.url : input).pathname;
    if (pathname === '/api/sessions') {
      return Promise.resolve(Response.json({ sessions: [] }));
    }
    if (pathname === '/api/factory/flows') {
      return Promise.resolve(
        Response.json({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          flows: [initialFlow],
        }),
      );
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  let latestOperations: BackgroundOperationsState | undefined;
  function BackgroundObserver() {
    latestOperations = useBackgroundOperations();
    return null;
  }

  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(BackgroundObserver));
      await new Promise(resolve => {
        setTimeout(resolve, 10);
      });
    });

    assert.equal(streams.length, 1);
    assert.equal(latestOperations?.factoryFlowsById.get(initialFlow.id)?.state, 'running');

    const updatedFlow = createFlow({
      currentStage: 'planning',
      state: 'waiting_action',
      currentSessionId: null,
      updatedAt: '2026-11-25T10:06:00.000Z',
      transitions: [
        ...initialFlow.transitions,
        {
          from: 'running',
          to: 'waiting_action',
          stage: 'planning',
          at: '2026-11-25T10:06:00.000Z',
          reason: 'Planejamento concluído',
        },
      ],
    });

    await act(async () => {
      streams[0]?.emit({ type: 'factory_flow.updated', flow: updatedFlow });
      streams[0]?.emit({ type: 'session.history_saved', session: planningSession });
      streams[0]?.emit({ type: 'session.finished', session: planningSession });
    });

    // Com o modal fechado, o estado global do fluxo é atualizado pelo SSE e as notificações de sessão chegam à fila.
    assert.equal(latestOperations?.factoryFlowsById.get(initialFlow.id)?.state, 'waiting_action');
    assert.equal(latestOperations?.factoryFlowsById.get(initialFlow.id)?.currentSessionId, null);
    assert.equal(latestOperations?.notifications.length, 2);
    assert.equal(latestOperations?.notifications[0]?.reportPath, '/tmp/artifacts/planning.md');
  } finally {
    act(() => {
      root.unmount();
    });
  }
});
