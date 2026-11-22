import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_MAX_AUTO_ITERATIONS,
} from '@development-factory/shared';
import type {
  BackgroundSessionSummary,
  FactoryFlow,
  FactoryFlowDetails,
  FactoryPreflightResponse,
} from '@development-factory/shared';
import { BackgroundTasksPopover } from '../src/components/BackgroundTasksPopover';
import { FactoryFlowRoadmapModal } from '../src/components/FactoryFlowRoadmapModal';
import { FactoryPage } from '../src/components/FactoryPage.js';
import {
  createPlanningGateDrafts,
  getNextAcceptanceCriterionId,
} from '../src/components/FactoryPlanningGatePanel';
import { FactoryTaskModal } from '../src/components/FactoryTaskModal';
import { HistoryModal } from '../src/components/HistoryModal';
import { MarkdownViewerModal } from '../src/components/MarkdownViewerModal';
import { NotificationToastCenter } from '../src/components/NotificationToastCenter';
import { buildNotification } from '../src/hooks/useBackgroundOperations';
import type { AppNotification } from '../src/hooks/useBackgroundOperations';
import type { FactoryPreflight } from '../src/hooks/useFactoryPreflight.js';

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
    worktreePath: null,
    branchName: null,
    baseBranch: null,
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
const repoPath = '/home/dev/repos/api-core';
const checkingPreflight: FactoryPreflight = { state: { status: 'checking' }, revalidate: noop };
const approvedPreflight: FactoryPreflightResponse = {
  contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
  blocked: false,
  checks: {
    claude: { status: 'ok', message: 'O Claude Code está disponível no WSL.' },
    jiraMcp: { status: 'ok', message: 'O MCP do Jira está conectado pelo Atlassian Rovo.' },
    github: { status: 'warning', message: 'Use gh auth login antes da etapa de PR.' },
    git: { status: 'ok', message: 'A branch base main existe.' },
    profile: { status: 'ok', message: 'A Factory usará o perfil padrão deste repositório.' },
  },
};

function renderFactoryPage(props: Partial<ComponentProps<typeof FactoryPage>> = {}): string {
  return renderToStaticMarkup(
    createElement(FactoryPage, {
      repoPath,
      preflight: checkingPreflight,
      factoryFlows: [],
      loadingFactoryFlows: false,
      factoryFlowsError: null,
      onPickDirectory: noop,
      onOpenNewFlow: noop,
      onOpenFlowRoadmap: noop,
      onCancelFlow: async flowId => createFlow({ id: flowId, state: 'cancelled' }),
      onRerunFlowStage: noopAsync,
      ...props,
    }),
  );
}

function renderFactoryViews(preflight: FactoryPreflight) {
  return [
    renderFactoryPage({ preflight }),
    renderToStaticMarkup(
      createElement(FactoryTaskModal, {
        repoPath,
        inputType: 'jira_key',
        preflight,
        onInputTypeChange: noop,
        onPickDirectory: noop,
        onClose: noop,
        onCreateFlow: noopAsync,
      }),
    ),
  ];
}

function getStartButton(html: string): string {
  const button = html.match(/<button\b[^>]*aria-describedby="[^"]+"[^>]*>/)?.[0];
  assert.ok(button);
  return button;
}

test('FactoryPage exibe a seleção do repositório e aguarda o preflight', () => {
  const html = renderFactoryPage();

  assert.match(html, /Iniciar fluxo/);
  assert.match(html, /\/home\/dev\/repos\/api-core/);
  assert.match(html, /Verificando o ambiente/);
  assert.match(getStartButton(html), / disabled=""/);
  assert.match(html, /Fluxos ativos e recentes/);
  assert.match(html, />0 fluxos</);
  assert.equal([...html.matchAll(/>Nenhum fluxo</g)].length, 4);
  assert.doesNotMatch(html, /Parar/);
});

function getCockpitGroup(html: string, label: string): string {
  const start = html.indexOf(`>${label}</h3>`);
  const end = html.indexOf('</section>', start);
  assert.ok(start >= 0 && end > start, `Grupo ausente: ${label}`);
  return html.slice(start, end);
}

test('FactoryPage agrupa os fluxos, conta cada grupo e oferece ações pelo estado atual', () => {
  const examples = [
    { title: 'Fluxo em execução', state: 'running', currentStage: 'pr' },
    { title: 'Fluxo na fila', state: 'queued' },
    {
      title: 'Triagem com bloqueadores',
      state: 'waiting_action',
      currentSessionId: null,
      loopPausedReason: 'Responda aos bloqueadores da triagem.',
    },
    {
      title: 'Ciclo de correção pausado',
      state: 'waiting_action',
      currentStage: 'review',
      currentSessionId: null,
      iteration: 2,
      loopPausedReason: 'O ciclo de correção não teve progresso.',
    },
    {
      title: 'Falha na preparação do PR',
      state: 'waiting_action',
      currentStage: 'pr',
      currentSessionId: null,
      error: {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        code: 'FACTORY_ARTIFACT_INCOMPLETE',
        message: 'O artefato do PR está incompleto.',
        occurredAt: '2026-11-19T12:05:00.000Z',
        retryable: true,
      },
    },
    {
      title: 'PR com disparo manual',
      state: 'waiting_action',
      currentStage: 'pr',
      currentSessionId: null,
      iteration: 2,
      lastReviewVerdict: 'approved_with_warnings',
    },
    { title: 'Fluxo concluído', state: 'completed', currentStage: 'pr' },
    { title: 'Fluxo cancelado', state: 'cancelled' },
    { title: 'Fluxo com falha', state: 'failed' },
  ] satisfies Partial<FactoryFlow>[];
  const factoryFlows = examples.map((flow, index) =>
    createFlow({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, ...flow }),
  );
  const html = renderFactoryPage({ factoryFlows });

  const groups = [
    ['Em execução', ['Fluxo em execução', 'Fluxo na fila']],
    [
      'Aguardando decisão humana',
      ['Triagem com bloqueadores', 'Ciclo de correção pausado', 'Falha na preparação do PR'],
    ],
    ['Prontos para PR', ['PR com disparo manual']],
    ['Finalizados', ['Fluxo concluído', 'Fluxo cancelado', 'Fluxo com falha']],
  ] as const;
  assert.match(html, />9 fluxos</);
  for (const [label, titles] of groups) {
    const group = getCockpitGroup(html, label);
    assert.match(group, new RegExp(`class="sr-only">${label} · </span>${titles.length}</span>`));
    assert.deepEqual(
      Array.from(group.matchAll(/<h4[^>]*>([^<]+)<\/h4>/g), match => match[1]),
      titles,
    );
  }

  const running = getCockpitGroup(html, 'Em execução');
  assert.match(running, /Na fila/);
  assert.match(running, /Parar · Fluxo em execução/);
  assert.doesNotMatch(running, /Parar · Fluxo na fila|Executar etapa PR/);

  const waiting = getCockpitGroup(html, 'Aguardando decisão humana');
  assert.match(waiting, /border-warning\/40 bg-warning\/5/);
  assert.match(waiting, /Revisar pendência do fluxo Triagem com bloqueadores/);
  assert.match(waiting, /Responda aos bloqueadores da triagem/);
  assert.match(waiting, /Retomar etapa · Ciclo de correção pausado/);
  assert.match(waiting, /O artefato do PR está incompleto/);
  assert.doesNotMatch(waiting, /Retomar etapa · Triagem|Executar etapa PR/);

  const readyForPr = getCockpitGroup(html, 'Prontos para PR');
  assert.match(readyForPr, /Aguardando disparo do PR/);
  assert.match(readyForPr, /Executar etapa PR · PR com disparo manual/);
  assert.match(readyForPr, /5\/6 concluídos/);

  const finished = getCockpitGroup(html, 'Finalizados');
  assert.match(finished, />Concluído</);
  assert.match(finished, />Cancelado</);
  assert.match(finished, />Falhou</);
  assert.match(finished, /6\/6 concluídos/);
  assert.match(finished, /Ver roadmap do fluxo Fluxo concluído/);
  assert.doesNotMatch(finished, /Parar|Retomar etapa|Executar etapa PR/);
});

test('FactoryPage mostra o progresso dos seis blocos, worktree e decisões aprovadas no card', () => {
  const flow = createFlow({
    currentStage: 'tests',
    iteration: 2,
    maxIterations: 4,
    branchName: 'factory/auth-101',
    worktreePath: '/tmp/worktrees/auth-101',
    planningApproval: {
      approvedAt: '2026-11-19T12:04:00.000Z',
      decisions: [
        {
          id: 'D1',
          question: 'Qual armazenamento usar?',
          mode: 'recommended',
          selectedOption: 'Usar SQLite',
          recommendedOption: 'Usar SQLite',
        },
        {
          id: 'D2',
          question: 'Quando renovar a sessão?',
          mode: 'custom',
          selectedOption: 'Renovar após 10 minutos',
          recommendedOption: 'Renovar após 15 minutos',
        },
        {
          id: 'D3',
          question: 'Como implantar a mudança?',
          mode: 'recommended',
          selectedOption: 'Implantar por etapas',
          recommendedOption: 'Implantar por etapas',
        },
      ],
      acceptanceCriteria: [],
    },
  });
  const html = renderFactoryPage({ factoryFlows: [flow] });

  assert.match(html, />1 fluxo</);
  assert.match(html, /Iteração 2\/4/);
  assert.match(html, /04 · Testes/);
  assert.match(html, /3\/6 concluídos/);
  const progress = html.match(/<ol[^>]*aria-label="Progresso dos 6 blocos"[^>]*>(.*?)<\/ol>/)?.[1];
  assert.ok(progress);
  assert.match(progress, /aria-current="step" title="Testes · Em execução"/);
  assert.deepEqual(
    Array.from(progress.matchAll(/title="([^"]+)"/g), match => match[1]),
    [
      'Triagem · Concluída',
      'Planejamento · Concluída',
      'Desenvolvimento · Concluída',
      'Testes · Em execução',
      'Code Review · Pendente',
      'PR · Pendente',
    ],
  );
  assert.match(html, />factory\/auth-101</);
  assert.match(html, />\/tmp\/worktrees\/auth-101</);
  assert.match(html, /Decisões aprovadas<span[^>]*>3<\/span>/);
  assert.match(html, />Usar SQLite</);
  assert.match(html, />Renovar após 10 minutos</);
  assert.match(html, /Mais 1 no roadmap/);
  assert.doesNotMatch(html, /Renovar após 15 minutos|Implantar por etapas|Abrir terminal/);
});

test('FactoryPage distingue listagem carregando, falha e fluxos já recebidos', () => {
  const loading = renderFactoryPage({ loadingFactoryFlows: true });
  assert.match(loading, /Carregando fluxos/);
  assert.doesNotMatch(loading, /Nenhum fluxo/);

  const factoryFlowsError = 'Não foi possível carregar os fluxos.';
  const error = renderFactoryPage({ factoryFlowsError });
  assert.match(error, /role="alert"[^>]*>Não foi possível carregar os fluxos\./);
  assert.doesNotMatch(error, /Nenhum fluxo/);

  const existing = renderFactoryPage({ factoryFlowsError, factoryFlows: [createFlow()] });
  assert.match(existing, /role="alert"[^>]*>Não foi possível carregar os fluxos\./);
  assert.match(existing, /FLUXO-1 · Autenticação JWT/);
});

test('FactoryPage e FactoryTaskModal exibem os checks e permitem iniciar com preflight aprovado', () => {
  for (const html of renderFactoryViews({
    state: { status: 'checked', result: approvedPreflight },
    revalidate: noop,
  })) {
    assert.doesNotMatch(getStartButton(html), / disabled=""/);
    assert.match(html, /Verificação concluída/);
    assert.match(html, />claude</);
    assert.match(html, />Jira MCP</);
    assert.match(html, />gh auth</);
    assert.match(html, />Git</);
    assert.match(html, /Perfil do repositório/);
    assert.match(html, /perfil padrão/);
    assert.match(html, /Aviso/);
    assert.match(html, /gh auth login/);
  }
});

test('FactoryPage e FactoryTaskModal bloqueiam o início e exibem instruções de correção', () => {
  const blockedPreflight: FactoryPreflightResponse = {
    ...approvedPreflight,
    blocked: true,
    checks: {
      ...approvedPreflight.checks,
      git: { status: 'error', message: 'Corrija os problemas apontados pelo git fsck.' },
      profile: { status: 'ok', message: 'O manifesto .development-factory.json é válido.' },
    },
  };

  for (const html of renderFactoryViews({
    state: { status: 'checked', result: blockedPreflight },
    revalidate: noop,
  })) {
    assert.match(getStartButton(html), / disabled=""/);
    assert.match(html, /Corrija as falhas abaixo/);
    assert.match(html, /git fsck/);
    assert.match(html, /\.development-factory\.json/);
    assert.match(html, /Revalidar/);
  }
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
    reportPath: '/home/dev/.local/share/development-factory/artifacts/flow-2/factory-development.md',
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
    reportPath: '/home/dev/.local/share/development-factory/artifacts/flow-3/factory-tests.md',
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
    reportPath: '/home/dev/.local/share/development-factory/artifacts/flow-3/factory-review.md',
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

  const taskModalHtml = renderToStaticMarkup(
    createElement(FactoryTaskModal, {
      repoPath,
      inputType: 'jira_key',
      preflight: checkingPreflight,
      onInputTypeChange: noop,
      onPickDirectory: noop,
      onClose: noop,
      onCreateFlow: noopAsync,
    }),
  );
  assert.match(taskModalHtml, /fora do repositório/);
  assert.doesNotMatch(taskModalHtml, /\.code-reviews/);

  const externalArtifactPath =
    '/home/dev/.local/share/development-factory/artifacts/11111111-1111-4111-8111-111111111111/plano.md';
  const viewerHtml = renderToStaticMarkup(
    createElement(MarkdownViewerModal, {
      filePath: externalArtifactPath,
      title: 'Plano técnico',
      onClose: noop,
    }),
  );
  assert.match(viewerHtml, /Plano técnico/);
  assert.match(viewerHtml, /artifacts\/11111111-1111-4111-8111-111111111111\/plano\.md/);
});

test('FactoryFlowRoadmapModal e BackgroundTasksPopover exibem motivo de pausa e botão Retomar etapa em 1 clique', () => {
  const reconciledFlow = createFlow({
    id: '66666666-6666-4666-8666-666666666666',
    title: 'RES-405 · Retomada após restart',
    currentStage: 'development',
    state: 'waiting_action',
    currentSessionId: null,
    loopPausedReason:
      'Reinício do servidor interrompeu a etapa Desenvolvimento em execução. Retome a etapa para continuar.',
    error: {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      code: 'FACTORY_STAGE_TIMEOUT',
      message: 'Tempo limite (30 min) excedido na etapa Desenvolvimento.',
      occurredAt: '2026-11-19T12:30:00.000Z',
      retryable: true,
    },
  });

  const roadmapHtml = renderToStaticMarkup(
    createElement(FactoryFlowRoadmapModal, {
      flow: reconciledFlow,
      onClose: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onViewMarkdown: noop,
    }),
  );
  assert.match(roadmapHtml, /Reinício do servidor interrompeu a etapa Desenvolvimento/);
  assert.match(roadmapHtml, /Tempo limite \(30 min\) excedido na etapa Desenvolvimento/);
  assert.match(roadmapHtml, />Retomar etapa</);

  const popoverHtml = renderToStaticMarkup(
    createElement(BackgroundTasksPopover, {
      id: 'bg-reconciled',
      sessions: [],
      factoryFlows: [reconciledFlow],
      onOpenTerminal: noop,
      onOpenFlowRoadmap: noop,
      onViewReport: noop,
      onRerunFlowStage: noopAsync,
      onClose: noop,
    }),
  );
  assert.match(popoverHtml, /Reinício do servidor interrompeu a etapa Desenvolvimento/);
  assert.match(popoverHtml, /Retomar etapa do fluxo RES-405 · Retomada após restart/);
  assert.match(popoverHtml, />Retomar etapa</);
});

test('FactoryFlowRoadmapModal exibe portão humano estruturado do Bloco 01 com bloqueadores, erro do Jira e campo de respostas', () => {
  const flowId = '77777777-7777-4777-8777-777777777777';
  const blockedTriageFlow = createFlow({
    id: flowId,
    title: 'JIRA-501 · Portão de Triagem',
    currentStage: 'triage',
    state: 'waiting_action',
    currentSessionId: null,
    loopPausedReason:
      'Triagem pausada: falha ao consultar o Jira MCP (Erro 401) e 2 bloqueadores/ambiguidades aguardando resposta humana antes do Planejamento.',
  });

  const initialDetails: FactoryFlowDetails = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow: blockedTriageFlow,
    stages: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: '88888888-8888-4888-8888-888888888881',
        flowId,
        name: 'triage',
        state: 'waiting_action',
        sessionId: null,
        reportPath: '/tmp/artifacts/spec.md',
        sessionPath: null,
        approvedNotes: 'Contexto inicial do relator.',
        createdAt: '2026-11-19T12:00:00.000Z',
        updatedAt: '2026-11-19T12:05:00.000Z',
        startedAt: '2026-11-19T12:00:00.000Z',
        finishedAt: null,
        error: null,
      },
    ],
    artifacts: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: '99999999-9999-4999-8999-999999999991',
        flowId,
        stage: 'triage',
        sessionId: null,
        kind: 'specification',
        format: 'markdown',
        path: '/tmp/artifacts/spec.md',
        status: 'ready',
        iteration: 0,
        createdAt: '2026-11-19T12:05:00.000Z',
        updatedAt: '2026-11-19T12:05:00.000Z',
        error: null,
      },
    ],
    worktreePath: null,
    branchName: null,
    baseBranch: null,
    checkpoints: [],
    triageGate: {
      blockers: ['Definir provedor de e-mail', 'Confirmar limite de tentativas'],
      jiraError: 'Erro 401 ao consultar Jira MCP',
      blocked: true,
    },
  };

  const html = renderToStaticMarkup(
    createElement(FactoryFlowRoadmapModal, {
      flow: blockedTriageFlow,
      initialDetails,
      onClose: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onViewMarkdown: noop,
    }),
  );

  assert.match(html, /Portão humano · Ação necessária/);
  assert.match(html, /Falha na consulta ao Jira MCP/);
  assert.match(html, /Erro 401 ao consultar Jira MCP/);
  assert.match(html, /Bloqueadores e ambiguidades identificados/);
  assert.match(html, /Definir provedor de e-mail/);
  assert.match(html, /Confirmar limite de tentativas/);
  assert.match(html, /Complemento enviado anteriormente/);
  assert.match(html, /Contexto inicial do relator\./);
  assert.match(html, /Respostas aos bloqueadores \/ Complemento de contexto/);
  assert.match(html, />Reexecutar</);
  assert.match(html, /Avançar para Planejamento/);
});

test('FactoryFlowRoadmapModal exibe portão humano estruturado do Bloco 02 e mantém decisões persistidas visíveis após aprovação', () => {
  const flowId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const planningWaitingFlow = createFlow({
    id: flowId,
    title: 'PLAN-602 · Portão de Planejamento',
    currentStage: 'planning',
    state: 'waiting_action',
    currentSessionId: null,
  });

  const editableDetails: FactoryFlowDetails = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow: planningWaitingFlow,
    stages: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'bbbbbbbb-1111-4111-8111-111111111111',
        flowId,
        name: 'triage',
        state: 'completed',
        sessionId: null,
        reportPath: '/tmp/artifacts/spec.md',
        sessionPath: null,
        createdAt: '2026-11-19T12:00:00.000Z',
        updatedAt: '2026-11-19T12:02:00.000Z',
        startedAt: '2026-11-19T12:00:00.000Z',
        finishedAt: '2026-11-19T12:02:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'bbbbbbbb-1111-4111-8111-111111111112',
        flowId,
        name: 'planning',
        state: 'waiting_action',
        sessionId: null,
        reportPath: '/tmp/artifacts/plan.md',
        sessionPath: null,
        createdAt: '2026-11-19T12:02:00.000Z',
        updatedAt: '2026-11-19T12:05:00.000Z',
        startedAt: '2026-11-19T12:02:00.000Z',
        finishedAt: null,
        error: null,
      },
    ],
    artifacts: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-1111-4111-8111-111111111111',
        flowId,
        stage: 'triage',
        sessionId: null,
        kind: 'specification',
        format: 'markdown',
        path: '/tmp/artifacts/spec.md',
        status: 'ready',
        iteration: 0,
        createdAt: '2026-11-19T12:02:00.000Z',
        updatedAt: '2026-11-19T12:02:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-1111-4111-8111-111111111112',
        flowId,
        stage: 'planning',
        sessionId: null,
        kind: 'plan',
        format: 'markdown',
        path: '/tmp/artifacts/plan.md',
        status: 'ready',
        iteration: 0,
        createdAt: '2026-11-19T12:05:00.000Z',
        updatedAt: '2026-11-19T12:05:00.000Z',
        error: null,
      },
    ],
    worktreePath: null,
    branchName: null,
    baseBranch: null,
    checkpoints: [],
    planningGate: {
      pendingDecisions: [
        {
          question: 'Onde armazenar os tokens revogados?',
          options: ['Tabela SQLite dedicada', 'Arquivo JSON local'],
          recommendedOption: 'Tabela SQLite dedicada',
        },
        {
          question: 'Qual política de expiração adotar?',
          options: ['TTL fixo de 15 min', 'Sliding expiration'],
          recommendedOption: 'TTL fixo de 15 min',
        },
      ],
      acceptanceCriteria: [
        { id: 'CA1', description: 'Revogar token ao encerrar sessão' },
        { id: 'CA2', description: 'Rejeitar token revogado com HTTP 401' },
      ],
    },
  };

  const editableHtml = renderToStaticMarkup(
    createElement(FactoryFlowRoadmapModal, {
      flow: planningWaitingFlow,
      initialDetails: editableDetails,
      onClose: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onViewMarkdown: noop,
    }),
  );

  assert.match(editableHtml, /Portão humano · Decisões e critérios/);
  assert.match(editableHtml, />D1<.*Onde armazenar os tokens revogados\?/);
  assert.match(editableHtml, />D2<.*Qual política de expiração adotar\?/);
  assert.match(editableHtml, /Opção Recomendada/);
  assert.match(editableHtml, /Tabela SQLite dedicada/);
  assert.match(editableHtml, /Alternativa/);
  assert.match(editableHtml, /Arquivo JSON local/);
  assert.match(editableHtml, /Customizada/);
  assert.match(editableHtml, /Checklist de critérios de aceite/);
  assert.match(editableHtml, /Adicionar critério/);
  assert.match(editableHtml, /value="Revogar token ao encerrar sessão"/);
  assert.match(editableHtml, /value="Rejeitar token revogado com HTTP 401"/);
  assert.match(editableHtml, /Aprovar e Iniciar Desenvolvimento/);
  assert.doesNotMatch(editableHtml, /Notas \/ Decisões Aprovadas \(opcional\)/);

  const persistedApproval = {
    approvedAt: '2026-11-19T12:06:00.000Z',
    decisions: [
      {
        id: 'D1',
        question: 'Onde armazenar os tokens revogados?',
        mode: 'recommended' as const,
        selectedOption: 'Tabela SQLite dedicada',
        recommendedOption: 'Tabela SQLite dedicada',
      },
      {
        id: 'D2',
        question: 'Qual política de expiração adotar?',
        mode: 'custom' as const,
        selectedOption: 'TTL de 10 min com renovação explícita',
        recommendedOption: 'TTL fixo de 15 min',
      },
    ],
    acceptanceCriteria: [
      { id: 'CA1', description: 'Revogar token imediatamente no logout', approved: true },
      { id: 'CA2', description: 'Rejeitar token revogado com HTTP 401', approved: false },
    ],
    notes: 'Manter índice em expires_at.',
  };

  const drafts = createPlanningGateDrafts(editableDetails.planningGate ?? undefined, persistedApproval);
  assert.equal(drafts.decisions[0]?.mode, 'recommended');
  assert.equal(drafts.decisions[1]?.mode, 'custom');
  assert.equal(drafts.decisions[1]?.customText, 'TTL de 10 min com renovação explícita');
  assert.equal(drafts.criteria[0]?.description, 'Revogar token imediatamente no logout');
  assert.equal(drafts.criteria[1]?.approved, false);
  assert.equal(getNextAcceptanceCriterionId(drafts.criteria), 'CA3');

  const developmentFlow = createFlow({
    id: flowId,
    title: 'PLAN-602 · Portão de Planejamento',
    currentStage: 'development',
    state: 'running',
    planningApproval: persistedApproval,
  });

  const persistedHtml = renderToStaticMarkup(
    createElement(FactoryFlowRoadmapModal, {
      flow: developmentFlow,
      initialDetails: {
        ...editableDetails,
        flow: developmentFlow,
      },
      onClose: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onViewMarkdown: noop,
    }),
  );

  assert.match(persistedHtml, /Decisões e critérios aprovados/);
  assert.match(persistedHtml, /2 decisões · 1\/2 CAs/);
  assert.match(persistedHtml, /TTL de 10 min com renovação explícita/);
  assert.match(persistedHtml, /Revogar token imediatamente no logout/);
  assert.match(persistedHtml, /Manter índice em expires_at\./);

  const popoverHtml = renderToStaticMarkup(
    createElement(BackgroundTasksPopover, {
      id: 'bg-planning-approval',
      sessions: [],
      factoryFlows: [developmentFlow],
      onOpenTerminal: noop,
      onOpenFlowRoadmap: noop,
      onViewReport: noop,
      onClose: noop,
    }),
  );
  assert.match(popoverHtml, /Planejamento aprovado: 2 decisões · 1 CAs/);
});
