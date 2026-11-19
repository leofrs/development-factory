import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  type BackgroundSessionSummary,
  type FactoryFlow,
} from '@development-factory/shared';
import { BackgroundTasksPopover } from '../src/components/BackgroundTasksPopover';
import { FactoryPage } from '../src/components/FactoryPage';
import { NotificationToastCenter } from '../src/components/NotificationToastCenter';
import type { AppNotification } from '../src/hooks/useBackgroundOperations';

function createFlow(overrides: Partial<FactoryFlow> = {}): FactoryFlow {
  return {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: '11111111-1111-4111-8111-111111111111',
    title: 'FLUXO-1 · Autenticação JWT',
    target: {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      inputType: 'jira_key',
      value: 'AUTH-101',
      repoPath: '/home/dev/repos/api-core',
    },
    currentStage: 'triage',
    state: 'running',
    currentSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-11-19T12:00:00.000Z',
    updatedAt: '2026-11-19T12:05:00.000Z',
    finishedAt: null,
    transitions: [],
    error: null,
    ...overrides,
  };
}

function createSession(
  overrides: Partial<BackgroundSessionSummary> = {},
): BackgroundSessionSummary {
  return {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    mode: 'factory',
    title: 'FLUXO-1 · Autenticação JWT',
    repoPath: '/home/dev/repos/api-core',
    status: 'running',
    historyState: 'pending',
    flowId: '11111111-1111-4111-8111-111111111111',
    stage: 'triage',
    startedAt: '2026-11-19T12:00:00.000Z',
    finishedAt: null,
    reportPath: '/home/dev/.local/share/development-factory/factory-1.md',
    ...overrides,
  };
}

const noop = () => undefined;
const noopAsync = async () => undefined;

test('FactoryPage exibe estado vazio com botão Iniciar fluxo e roadmap de 6 etapas', () => {
  const html = renderToStaticMarkup(
    createElement(FactoryPage, {
      repoPath: '/home/dev/repos/api-core',
      flows: [],
      sessions: [],
      selectedFlowId: null,
      loadingFlows: false,
      flowsError: null,
      onSelectFlow: noop,
      onPickDirectory: noop,
      onOpenNewFlow: noop,
      onOpenFlowTerminal: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onCancelFlow: noopAsync,
      onRefreshFlows: noopAsync,
      onViewMarkdown: noop,
    }),
  );

  assert.match(html, /Iniciar fluxo/);
  assert.match(html, /Nenhum fluxo iniciado ainda/);
  assert.match(html, /Triagem \/ Contexto/);
  assert.match(html, /Planejamento/);
  assert.match(html, /PR/);
  assert.match(html, /\/home\/dev\/repos\/api-core/);
});

test('FactoryPage lista múltiplos fluxos paralelos e alterna contexto e planos ao trocar selectedFlowId', () => {
  const flowA = createFlow({
    id: '11111111-1111-4111-8111-111111111111',
    title: 'AUTH-101 · Login SSO',
    target: {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      inputType: 'jira_key',
      value: 'AUTH-101',
      repoPath: '/home/dev/repos/auth-service',
    },
    currentStage: 'triage',
    state: 'running',
    currentSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  const flowB = createFlow({
    id: '22222222-2222-4222-8222-222222222222',
    title: 'PAY-202 · Webhook Pix',
    target: {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      inputType: 'jira_key',
      value: 'PAY-202',
      repoPath: '/home/dev/repos/payments-api',
    },
    currentStage: 'planning',
    state: 'waiting_action',
    currentSessionId: null,
    updatedAt: '2026-11-19T12:10:00.000Z',
  });
  const flowC = createFlow({
    id: '33333333-3333-4333-8333-333333333333',
    title: 'OBS-303 · Métricas',
    target: {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      inputType: 'jira_key',
      value: 'OBS-303',
      repoPath: '/home/dev/repos/telemetry',
    },
    currentStage: 'pr',
    state: 'completed',
    currentSessionId: null,
    finishedAt: '2026-11-19T12:15:00.000Z',
  });

  const sessionA = createSession({
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    flowId: flowA.id,
    stage: 'triage',
    status: 'running',
    historyState: 'saved',
    reportPath: '/tmp/plans/auth-101.md',
  });
  const sessionB = createSession({
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    flowId: flowB.id,
    stage: 'planning',
    status: 'exited',
    finishedAt: '2026-11-19T12:10:00.000Z',
    historyState: 'saved',
    reportPath: '/tmp/plans/pay-202.md',
  });

  const htmlWithFlowA = renderToStaticMarkup(
    createElement(FactoryPage, {
      repoPath: '/home/dev/repos/auth-service',
      flows: [flowA, flowB, flowC],
      sessions: [sessionA, sessionB],
      selectedFlowId: flowA.id,
      loadingFlows: false,
      flowsError: null,
      onSelectFlow: noop,
      onPickDirectory: noop,
      onOpenNewFlow: noop,
      onOpenFlowTerminal: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onCancelFlow: noopAsync,
      onRefreshFlows: noopAsync,
      onViewMarkdown: noop,
    }),
  );

  // Todos os fluxos paralelos e concluídos aparecem na lista; triage e planning ocultam o botão de terminal.
  assert.match(htmlWithFlowA, /AUTH-101 · Login SSO/);
  assert.match(htmlWithFlowA, /PAY-202 · Webhook Pix/);
  assert.match(htmlWithFlowA, /OBS-303 · Métricas/);
  assert.match(htmlWithFlowA, /Ver plano/);
  assert.doesNotMatch(htmlWithFlowA, /Abrir terminal/);
  assert.match(htmlWithFlowA, /Parar/);

  // Alternando para o Fluxo B, o contexto selecionado muda para Planejamento e ações de etapa.
  const htmlWithFlowB = renderToStaticMarkup(
    createElement(FactoryPage, {
      repoPath: '/home/dev/repos/auth-service',
      flows: [flowA, flowB, flowC],
      sessions: [sessionA, sessionB],
      selectedFlowId: flowB.id,
      loadingFlows: false,
      flowsError: null,
      onSelectFlow: noop,
      onPickDirectory: noop,
      onOpenNewFlow: noop,
      onOpenFlowTerminal: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onCancelFlow: noopAsync,
      onRefreshFlows: noopAsync,
      onViewMarkdown: noop,
    }),
  );

  assert.match(htmlWithFlowB, /Avançar etapa/);
  assert.match(htmlWithFlowB, /Reexecutar/);
  assert.match(htmlWithFlowB, /Ver plano/);
  assert.doesNotMatch(htmlWithFlowB, /Abrir terminal/);
  assert.match(htmlWithFlowB, /\/home\/dev\/repos\/payments-api/);

  // A partir de development, o botão Abrir terminal volta a ser exibido.
  const flowDev = createFlow({
    id: '44444444-4444-4444-8444-444444444444',
    title: 'DEV-404 · Implementação',
    currentStage: 'development',
    state: 'running',
    currentSessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  });
  const htmlWithFlowDev = renderToStaticMarkup(
    createElement(FactoryPage, {
      repoPath: '/home/dev/repos/auth-service',
      flows: [flowDev],
      sessions: [
        createSession({
          sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          flowId: flowDev.id,
          stage: 'development',
          status: 'running',
        }),
      ],
      selectedFlowId: flowDev.id,
      loadingFlows: false,
      flowsError: null,
      onSelectFlow: noop,
      onPickDirectory: noop,
      onOpenNewFlow: noop,
      onOpenFlowTerminal: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onCancelFlow: noopAsync,
      onRefreshFlows: noopAsync,
      onViewMarkdown: noop,
    }),
  );
  assert.match(htmlWithFlowDev, /Abrir terminal/);
});

test('BackgroundTasksPopover exibe múltiplos fluxos da Factory em paralelo com reviews ativos', () => {
  const flowA = createFlow({
    id: '11111111-1111-4111-8111-111111111111',
    title: 'AUTH-101 · Login SSO',
    currentStage: 'triage',
    state: 'running',
    currentSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  const flowB = createFlow({
    id: '22222222-2222-4222-8222-222222222222',
    title: 'PAY-202 · Webhook Pix',
    currentStage: 'development',
    state: 'running',
    currentSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });

  const factorySessionA = createSession({
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    flowId: flowA.id,
    stage: 'triage',
    historyState: 'saved',
    reportPath: '/tmp/plans/auth-101.md',
  });
  const factorySessionB = createSession({
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    flowId: flowB.id,
    stage: 'development',
  });
  const reviewSession = createSession({
    sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    mode: 'review',
    title: 'Review #42 · Checkout',
    flowId: undefined,
    stage: undefined,
    historyState: 'saved',
    reportPath: '/tmp/reviews/pr-42.md',
  });

  const html = renderToStaticMarkup(
    createElement(BackgroundTasksPopover, {
      id: 'bg-popover',
      sessions: [factorySessionA, factorySessionB, reviewSession],
      factoryFlows: [flowA, flowB],
      onOpenTerminal: noop,
      onOpenFlowTerminal: noop,
      onViewReport: noop,
      onStopSession: async () => reviewSession,
      onCancelFlow: async () => flowA,
      onClose: noop,
    }),
  );

  assert.match(html, /AUTH-101 · Login SSO/);
  assert.match(html, /PAY-202 · Webhook Pix/);
  assert.match(html, /Review #42 · Checkout/);
  assert.match(html, /01 · Triagem/);
  assert.match(html, /03 · Desenvolvimento/);
  assert.match(html, /Ver plano/);
  assert.match(html, /Ver parecer/);
});

test('NotificationToastCenter exibe notificações de fluxos da Factory com etapa e atalho de plano', () => {
  const notifications: AppNotification[] = [
    {
      id: 'notif-1',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      flowId: '11111111-1111-4111-8111-111111111111',
      stage: 'triage',
      mode: 'factory',
      title: 'AUTH-101 · Login SSO',
      kind: 'history_saved',
      status: 'running',
      historyState: 'saved',
      reportPath: '/tmp/plans/auth-101.md',
      message: 'Plano técnico da etapa Triagem salvo.',
      severity: 'info',
      createdAt: new Date().toISOString(),
    },
  ];

  const html = renderToStaticMarkup(
    createElement(NotificationToastCenter, {
      notifications,
      onOpenTerminal: noop,
      onOpenFlowTerminal: noop,
      onViewReport: noop,
      onDismiss: noop,
    }),
  );

  assert.match(html, /AUTH-101 · Login SSO/);
  assert.match(html, /01 · Triagem/);
  assert.match(html, /Ver plano/);
  assert.doesNotMatch(html, /Abrir terminal/);
});
