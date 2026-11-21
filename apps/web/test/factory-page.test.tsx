import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_MAX_AUTO_ITERATIONS,
  type BackgroundSessionSummary,
  type FactoryFlow,
} from '@development-factory/shared';
import { BackgroundTasksPopover } from '../src/components/BackgroundTasksPopover';
import { FactoryFlowRoadmapModal } from '../src/components/FactoryFlowRoadmapModal';
import { FactoryPage } from '../src/components/FactoryPage';
import { HistoryModal } from '../src/components/HistoryModal';
import { NotificationToastCenter } from '../src/components/NotificationToastCenter';
import {
  buildNotification,
  type AppNotification,
} from '../src/hooks/useBackgroundOperations';

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
    iteration: 0,
    maxIterations: FACTORY_MAX_AUTO_ITERATIONS,
    lastReviewVerdict: null,
    loopPausedReason: null,
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

test('FactoryPage exibe apenas seleção de repositório e botão Iniciar fluxo', () => {
  const html = renderToStaticMarkup(
    createElement(FactoryPage, {
      repoPath: '/home/dev/repos/api-core',
      onPickDirectory: noop,
      onOpenNewFlow: noop,
    }),
  );

  assert.match(html, /Iniciar fluxo/);
  assert.match(html, /\/home\/dev\/repos\/api-core/);
  assert.doesNotMatch(html, /Fluxos em andamento e concluídos/);
  assert.doesNotMatch(html, /Artefatos do fluxo selecionado/);
  assert.doesNotMatch(html, /Parar/);
});

test('FactoryFlowRoadmapModal exibe botão Parar apenas quando o fluxo está Em execução', () => {
  const waitingFlow = createFlow({
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

  const waitingHtml = renderToStaticMarkup(
    createElement(FactoryFlowRoadmapModal, {
      flow: waitingFlow,
      onClose: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onCancelFlow: noopAsync,
      onViewMarkdown: noop,
    }),
  );

  assert.match(waitingHtml, /PAY-202 · Webhook Pix/);
  assert.match(waitingHtml, /\/home\/dev\/repos\/payments-api/);
  assert.match(waitingHtml, /Triagem \/ Contexto/);
  assert.match(waitingHtml, /Planejamento/);
  assert.match(waitingHtml, /Desenvolvimento/);
  assert.match(waitingHtml, /Testes/);
  assert.match(waitingHtml, /Code Review/);
  assert.match(waitingHtml, /PR/);
  assert.match(waitingHtml, /Reexecutar/);
  assert.doesNotMatch(waitingHtml, /Abrir terminal/);
  assert.doesNotMatch(waitingHtml, />Terminal</);
  assert.doesNotMatch(waitingHtml, /Parar/);

  const runningFlow = createFlow({
    id: '22222222-2222-4222-8222-222222222222',
    title: 'PAY-202 · Webhook Pix',
    currentStage: 'development',
    state: 'running',
  });

  const runningHtml = renderToStaticMarkup(
    createElement(FactoryFlowRoadmapModal, {
      flow: runningFlow,
      onClose: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onCancelFlow: noopAsync,
      onViewMarkdown: noop,
    }),
  );

  assert.match(runningHtml, /Em execução/);
  assert.match(runningHtml, /Parar fluxo PAY-202 · Webhook Pix/);
  assert.match(runningHtml, />Parar</);
});

test('BackgroundTasksPopover exibe múltiplos fluxos da Factory em paralelo com botão Parar para itens Em execução', () => {
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
  const flowC = createFlow({
    id: '33333333-3333-4333-8333-333333333333',
    title: 'BILL-303 · Fatura PDF',
    currentStage: 'planning',
    state: 'running',
    currentSessionId: null,
  });
  const cancelledFlow = createFlow({
    id: '44444444-4444-4444-8444-444444444444',
    title: 'OLD-404 · Fluxo parado',
    currentStage: 'tests',
    state: 'cancelled',
    currentSessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    finishedAt: '2026-11-19T12:06:00.000Z',
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
  const staleCancelledSession = createSession({
    sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    flowId: cancelledFlow.id,
    stage: 'tests',
    status: 'running',
    historyState: 'pending',
  });
  const reviewSessionSaved = createSession({
    sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    mode: 'review',
    title: 'Review #42 · Checkout',
    flowId: undefined,
    stage: undefined,
    historyState: 'saved',
    reportPath: '/tmp/reviews/pr-42.md',
  });
  const reviewSessionRunning = createSession({
    sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    mode: 'review',
    title: 'Review #99 · Pagamentos',
    flowId: undefined,
    stage: undefined,
    status: 'running',
    historyState: 'pending',
  });

  const html = renderToStaticMarkup(
    createElement(BackgroundTasksPopover, {
      id: 'bg-popover',
      sessions: [
        factorySessionA,
        factorySessionB,
        staleCancelledSession,
        reviewSessionSaved,
        reviewSessionRunning,
      ],
      factoryFlows: [flowA, flowB, flowC, cancelledFlow],
      onOpenTerminal: noop,
      onOpenFlowRoadmap: noop,
      onViewReport: noop,
      onStopSession: async () => reviewSessionRunning,
      onCancelFlow: async () => flowB,
      onClose: noop,
    }),
  );

  assert.match(html, /AUTH-101 · Login SSO/);
  assert.match(html, /PAY-202 · Webhook Pix/);
  assert.match(html, /BILL-303 · Fatura PDF/);
  assert.match(html, /Review #42 · Checkout/);
  assert.match(html, /Review #99 · Pagamentos/);
  assert.match(html, /01 · Triagem/);
  assert.match(html, /03 · Desenvolvimento/);
  assert.match(html, /Abrir roadmap do fluxo AUTH-101 · Login SSO/);
  assert.match(html, /Ver plano/);
  assert.match(html, /Ver parecer/);
  assert.match(html, /Parar fluxo PAY-202 · Webhook Pix/);
  assert.match(html, /Parar fluxo BILL-303 · Fatura PDF/);
  assert.match(html, /Parar execução de Review #99 · Pagamentos/);
  assert.doesNotMatch(html, /Parar fluxo AUTH-101 · Login SSO/);
  assert.doesNotMatch(html, /Parar fluxo OLD-404 · Fluxo parado/);
  assert.doesNotMatch(html, /Parar execução de Review #42 · Checkout/);
  assert.match(html, /4 em execução/);
});

test('HistoryModal inclui a aba Artefatos de fluxos', () => {
  const html = renderToStaticMarkup(
    createElement(HistoryModal, {
      initialPath: '/home/dev/repos/api-core',
      factoryFlows: [createFlow()],
      onClose: noop,
    }),
  );

  assert.match(html, /Pareceres salvos/);
  assert.match(html, /Artefatos de fluxos/);
  assert.match(html, /Arquivos locais/);
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

test('Etapa 03 (development) gera notificação de conclusão e oculta atalho de terminal', () => {
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const flowId = '22222222-2222-4222-8222-222222222222';
  const devSession = createSession({
    sessionId,
    flowId,
    stage: 'development',
    status: 'exited',
    historyState: 'saved',
    reportPath: '/tmp/repo/.code-reviews/factory-development.md',
  });

  const notification = buildNotification(devSession, 'finished');
  assert.equal(notification.message, 'Desenvolvimento concluído');

  const html = renderToStaticMarkup(
    createElement(NotificationToastCenter, {
      notifications: [notification],
      onOpenTerminal: noop,
      onOpenFlowTerminal: noop,
      onViewReport: noop,
      onDismiss: noop,
    }),
  );

  assert.match(html, /03 · Desenvolvimento/);
  assert.match(html, /Desenvolvimento concluído/);
  assert.match(html, /Ver artefato/);
  assert.doesNotMatch(html, /Abrir terminal/);
});

test('Etapas 04 (tests) e 05 (review) geram notificações e botões de reexecução/handoff no roadmap', () => {
  const testsSession = createSession({
    sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    flowId: '33333333-3333-4333-8333-333333333333',
    stage: 'tests',
    status: 'exited',
    historyState: 'saved',
    reportPath: '/tmp/repo/.code-reviews/factory-tests.md',
  });
  const testsSavedNotification = buildNotification(testsSession, 'history_saved');
  const testsFinishedNotification = buildNotification(testsSession, 'finished');
  assert.equal(testsSavedNotification.message, 'Relatório de testes salvo');
  assert.equal(testsFinishedNotification.message, 'Testes concluídos');

  const reviewSession = createSession({
    sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    flowId: '33333333-3333-4333-8333-333333333333',
    stage: 'review',
    status: 'exited',
    historyState: 'saved',
    reportPath: '/tmp/repo/.code-reviews/factory-review.md',
  });
  const reviewSavedNotification = buildNotification(reviewSession, 'history_saved');
  const reviewFinishedNotification = buildNotification(reviewSession, 'finished');
  assert.equal(reviewSavedNotification.message, 'Relatório de code review salvo');
  assert.equal(reviewFinishedNotification.message, 'Code review concluído');

  const testsFlow = createFlow({
    id: '33333333-3333-4333-8333-333333333333',
    currentStage: 'tests',
    state: 'waiting_action',
    currentSessionId: null,
  });
  const testsRoadmapHtml = renderToStaticMarkup(
    createElement(FactoryFlowRoadmapModal, {
      flow: testsFlow,
      onClose: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onReturnFlowStage: noopAsync,
      onViewMarkdown: noop,
    }),
  );
  assert.match(testsRoadmapHtml, /Reexecutar/);
  assert.doesNotMatch(testsRoadmapHtml, /A execução de testes será disponibilizada futuramente/);

  const prFlow = createFlow({
    id: '44444444-4444-4444-8444-444444444444',
    currentStage: 'pr',
    state: 'waiting_action',
    currentSessionId: null,
    iteration: 2,
    lastReviewVerdict: 'approved',
  });
  const prRoadmapHtml = renderToStaticMarkup(
    createElement(FactoryFlowRoadmapModal, {
      flow: prFlow,
      onClose: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onReturnFlowStage: noopAsync,
      onViewMarkdown: noop,
    }),
  );
  assert.match(prRoadmapHtml, /Executar etapa PR/);
  assert.match(prRoadmapHtml, /Iteração 2\/3/);
  assert.match(prRoadmapHtml, /Review: Aprovado para PR/);

  const circuitBreakerFlow = createFlow({
    id: '55555555-5555-4555-8555-555555555555',
    currentStage: 'review',
    state: 'waiting_action',
    currentSessionId: null,
    iteration: 3,
    lastReviewVerdict: 'changes_requested',
    loopPausedReason:
      'Limite máximo de 3 iterações automáticas atingido sem aprovação no Code Review. Intervenção humana necessária.',
  });
  const circuitBreakerHtml = renderToStaticMarkup(
    createElement(FactoryFlowRoadmapModal, {
      flow: circuitBreakerFlow,
      onClose: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onReturnFlowStage: noopAsync,
      onViewMarkdown: noop,
    }),
  );
  assert.match(circuitBreakerHtml, /Iteração 3\/3/);
  assert.match(circuitBreakerHtml, /Review: Requer ajustes/);
  assert.match(circuitBreakerHtml, /Limite máximo de 3 iterações automáticas/);

  const popoverHtml = renderToStaticMarkup(
    createElement(BackgroundTasksPopover, {
      id: 'bg-loop',
      sessions: [],
      factoryFlows: [prFlow],
      onOpenTerminal: noop,
      onOpenFlowRoadmap: noop,
      onViewReport: noop,
      onClose: noop,
    }),
  );
  assert.match(popoverHtml, /Iteração 2\/3/);
});
