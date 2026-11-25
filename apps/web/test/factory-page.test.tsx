import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, useState } from 'react';
import type { ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import {
  buildFactoryTraceabilityMatrix,
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_MAX_AUTO_ITERATIONS,
  FACTORY_STAGE_ORDER,
  FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
} from '@development-factory/shared';
import type {
  AppEvent,
  BackgroundSessionSummary,
  FactoryFlow,
  FactoryFlowDetails,
  FactoryMetricsResponse,
  FactoryPreflightResponse,
} from '@development-factory/shared';
import { BackgroundTasksPopover } from '../src/components/BackgroundTasksPopover';
import { FactoryFlowRoadmapModal } from '../src/components/FactoryFlowRoadmapModal';
import { FactoryFlowTraceabilityPanel } from '../src/components/FactoryFlowTraceabilityPanel.js';
import { FactoryPage } from '../src/components/FactoryPage.js';
import {
  createPlanningGateDrafts,
  getNextAcceptanceCriterionId,
} from '../src/components/FactoryPlanningGatePanel';
import { FactoryTaskModal } from '../src/components/FactoryTaskModal';
import { HistoryModal } from '../src/components/HistoryModal';
import { MarkdownViewerModal } from '../src/components/MarkdownViewerModal';
import { NotificationToastCenter } from '../src/components/NotificationToastCenter';
import { buildNotification, useBackgroundOperations } from '../src/hooks/useBackgroundOperations';
import type { AppNotification } from '../src/hooks/useBackgroundOperations';
import { useFactoryMetrics, type FactoryMetricsController } from '../src/hooks/useFactoryMetrics.js';
import type { FactoryPreflight } from '../src/hooks/useFactoryPreflight.js';
import { getRunningFactorySession } from '../src/utils/factory-flow-status.js';

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
const unavailableTerminal = () => false;
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

function factoryPageElement(props: Partial<ComponentProps<typeof FactoryPage>> = {}) {
  return createElement(FactoryPage, {
    repoPath,
    preflight: checkingPreflight,
    factoryFlows: [],
    sessionsById: new Map(),
    loadingFactoryFlows: false,
    factoryFlowsError: null,
    onPickDirectory: noop,
    onOpenNewFlow: noop,
    onOpenFlowRoadmap: noop,
    onCancelFlow: async flowId => createFlow({ id: flowId, state: 'cancelled' }),
    onRerunFlowStage: noopAsync,
    ...props,
  });
}

function renderFactoryPage(props: Partial<ComponentProps<typeof FactoryPage>> = {}): string {
  return renderToStaticMarkup(factoryPageElement(props));
}

test('Roadmap navega pelo diff paginado e compara evidências e checkpoints de ciclos consecutivos', async context => {
  const flow = createFlow({
    state: 'queued',
    currentSessionId: null,
    updatedAt: '2026-11-19T12:00:00.000Z',
    worktreePath: '/home/dev/.local/share/development-factory/worktrees/flow',
    branchName: 'factory/auth-101',
    baseBranch: 'main',
    iteration: 3,
  });
  const checkpoints: FactoryFlowDetails['checkpoints'] = [1, 2, 3].map(iteration => ({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: `00000000-0000-4000-8000-00000000000${iteration}`,
    flowId: flow.id,
    stage: 'tests',
    iteration,
    commitSha: String(iteration).repeat(40),
    branchName: flow.branchName,
    sessionId: null,
    message: null,
    createdAt: flow.createdAt,
  }));
  const details: FactoryFlowDetails = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow,
    stages: [],
    artifacts: [],
    worktreePath: flow.worktreePath,
    branchName: flow.branchName,
    baseBranch: flow.baseBranch,
    checkpoints,
  };

  const window = parseHTML('<html><body><div id="inspection-root"></div></body></html>');
  const { document } = window;
  const overrides: Array<[object, string, unknown]> = [
    [globalThis, 'window', window],
    [globalThis, 'document', document],
    [globalThis, 'IS_REACT_ACT_ENVIRONMENT', true],
    [window.HTMLElement.prototype, 'showModal', function (this: HTMLElement) {
      this.setAttribute('open', '');
    }],
    [window.HTMLElement.prototype, 'close', function (this: HTMLElement) {
      this.removeAttribute('open');
    }],
    [window.HTMLElement.prototype, 'attachEvent', () => undefined],
    [window.HTMLElement.prototype, 'detachEvent', () => undefined],
  ];
  for (const [target, name, value] of overrides) {
    const original = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, value, writable: true });
    context.after(() => {
      if (original) {
        Object.defineProperty(target, name, original);
      } else {
        Reflect.deleteProperty(target, name);
      }
    });
  }
  context.mock.method(window.HTMLElement.prototype, 'focus', () => undefined);

  const version = FACTORY_FLOW_CONTRACT_VERSION;
  const seen: URL[] = [];
  let oldPatchSignal: AbortSignal | null | undefined;
  let resolveOldPatch: ((response: Response) => void) | undefined;
  const oldPatch = new Promise<Response>(resolve => { resolveOldPatch = resolve; });
  const file = (path: string, change = 'modified') => ({
    path, change, untracked: false, additions: 1, deletions: 1, binary: false,
  });
  function evidence(iteration: number) {
    const checkpoint = checkpoints.find(item => item.iteration === iteration);
    assert(checkpoint);
    const before = iteration === 1;
    return {
      iteration,
      checkpoint: { id: checkpoint.id, commitSha: checkpoint.commitSha, stage: checkpoint.stage },
      tests: {
        status: before ? 'failed' : 'passed',
        passed: before ? 0 : 1,
        failed: before ? 1 : 0,
        skipped: 0,
        cases: [{ id: 'T1', description: 'Validar a sessão.', status: before ? 'failed' : 'passed' }],
        coverage: { linesPercent: before ? 45 : 80, branchesPercent: null },
        commandCount: 1,
        commands: [{ command: 'npm test', exitCode: before ? 1 : 0 }],
      },
      review: {
        verdict: before ? 'changes_requested' : 'approved',
        findingCount: before ? 1 : 0,
        findings: before
          ? [{ severity: 'BLOQUEANTE', file: 'src/auth.ts', line: 4, explanation: 'Falta validar a sessão.' }]
          : [],
      },
    };
  }
  context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.pathname.endsWith('/traceability')) {
      return Promise.resolve(
        Response.json(
          buildFactoryTraceabilityMatrix({
            triage: {
              contractVersion: FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
              stage: 'triage',
              acceptanceCriteria: [
                { id: 'CA1', description: 'Validar sessão JWT em src/auth.ts.' },
                { id: 'CA2', description: 'Gerar relatório sem arquivo nem teste.' },
              ],
              negativeScope: [],
              blockers: [],
              jiraContext: null,
              technicalContext: 'Investigar src/auth.ts.',
            },
            planning: {
              contractVersion: FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
              stage: 'planning',
              pendingDecisions: [],
              plannedFiles: ['src/auth.ts'],
              testPlan: ['CA1: Testar src/auth.ts.'],
            },
            planningApproval: {
              approvedAt: '2026-11-19T12:00:00.000Z',
              decisions: [],
              acceptanceCriteria: [
                { id: 'CA1', description: 'Validar sessão JWT em src/auth.ts.', approved: true },
                { id: 'CA2', description: 'Gerar relatório sem arquivo nem teste.', approved: true },
              ],
            },
            development: {
              contractVersion: FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
              stage: 'development',
              changedFiles: ['src/auth.ts'],
              summary: 'Sessão validada.',
              deviations: [],
            },
            tests: {
              contractVersion: FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
              stage: 'tests',
              status: 'passed',
              executedCommands: [{ command: ['npm', 'test'], exitCode: 0 }],
              testCases: [
                {
                  id: 'T1',
                  description: 'Valida a sessão.',
                  acceptanceCriteriaIds: ['CA1'],
                  status: 'passed',
                },
              ],
              coverage: null,
            },
            review: {
              contractVersion: FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
              stage: 'review',
              verdict: 'approved_with_warnings',
              returnTarget: null,
              findings: [
                {
                  severity: 'SUGESTÃO',
                  file: 'src/auth.ts',
                  line: 4,
                  explanation: 'Adicionar comentário sobre expiração.',
                },
              ],
            },
            worktreeAvailable: true,
            worktreeFiles: [
              {
                path: 'src/auth.ts',
                change: 'modified',
                untracked: false,
                additions: 1,
                deletions: 1,
                binary: false,
              },
            ],
          }),
        ),
      );
    }
    if (url.pathname.endsWith('/iterations')) {
      const from = Number(url.searchParams.get('fromIteration'));
      return Promise.resolve(Response.json({
        contractVersion: version, before: evidence(from), after: evidence(from + 1),
      }));
    }
    if (url.pathname.endsWith('/diff')) {
      const path = url.searchParams.get('file');
      if (path === 'src/antigo.ts') {
        oldPatchSignal = init?.signal;
        return oldPatch;
      }
      if (path) {
        return Promise.resolve(Response.json({
          contractVersion: version,
          kind: 'patch',
          patch: '@@ -1 +1 @@\n-linha antiga\n+<tag>texto</tag>',
          truncated: true,
        }));
      }
      const historical = url.searchParams.has('fromCheckpointId');
      const nextPage = url.searchParams.get('offset') === '20';
      const files = historical ? [file('src/auth.ts')]
        : nextPage ? [file('src/último.ts')]
          : [file('src/antigo.ts', 'deleted'), file('src/novo.ts', 'added')];
      return Promise.resolve(Response.json({
        contractVersion: version,
        kind: 'page',
        files,
        totalFiles: historical ? 1 : 21,
        nextOffset: historical || nextPage ? null : 20,
        truncated: false,
      }));
    }
    return Promise.resolve(Response.json(details));
  });

  const container = document.getElementById('inspection-root');
  assert(container);
  const root = createRoot(container);
  const visiblePanel = () => {
    const panel = container.querySelector('[role="tabpanel"]:not([hidden])');
    assert(panel);
    return panel;
  };
  const clickButton = async (label: string, within: ParentNode = visiblePanel()) => {
    const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      item => item.textContent?.trim().startsWith(label),
    );
    assert(button, `Botão ausente: ${label}`);
    await act(() => button.click());
  };

  try {
    await act(() => root.render(
      <FactoryFlowRoadmapModal
        flow={flow}
        initialDetails={details}
        onClose={noop}
        onAdvanceFlowStage={noopAsync}
        onRerunFlowStage={noopAsync}
        onViewMarkdown={noop}
      />,
    ));
    const tabs = container.querySelector('[role="tablist"]');
    assert(tabs);
    const activeTab = tabs.querySelector('[aria-selected="true"]');
    assert.equal(activeTab?.textContent, 'Roadmap');
    assert(!seen.some(url => url.pathname.endsWith('/diff')));
    const arrow = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(arrow, 'key', { value: 'ArrowRight' });
    await act(() => { activeTab?.dispatchEvent(arrow); });

    assert.equal(tabs.querySelector('[aria-selected="true"]')?.textContent, 'Diff Real');
    assert.match(visiblePanel().textContent ?? '', /src\/novo\.tsCriado\+1−1/);
    assert.match(visiblePanel().textContent ?? '', /src\/antigo\.tsRemovido/);
    await clickButton('src/antigo.ts');
    await clickButton('src/novo.ts');
    assert(oldPatchSignal?.aborted);
    await act(() => resolveOldPatch?.(Response.json({
      contractVersion: version, kind: 'patch', patch: 'Resposta obsoleta', truncated: false,
    })));
    assert.match(visiblePanel().querySelector('pre')?.textContent ?? '', /\+<tag>texto<\/tag>/);
    assert.equal(visiblePanel().querySelector('tag'), null);
    assert.doesNotMatch(visiblePanel().textContent ?? '', /Resposta obsoleta/);
    assert.match(visiblePanel().textContent ?? '', /limite de exibição/);

    await clickButton('Próxima página');
    assert.match(visiblePanel().textContent ?? '', /src\/último\.ts/);
    await clickButton('Página anterior');
    assert.match(visiblePanel().textContent ?? '', /src\/novo\.ts/);

    await clickButton('Histórico Comparativo de Iterações', tabs);
    assert.equal(tabs.querySelector('[aria-selected="true"]')?.textContent, 'Histórico Comparativo de Iterações');
    assert.match(visiblePanel().textContent ?? '', /Ciclo 2 → Ciclo 3/);
    const select = visiblePanel().querySelector('select');
    assert(select);
    await act(() => {
      Object.defineProperty(select, 'value', { configurable: true, value: '1' });
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const [before, after] = visiblePanel().querySelectorAll('article');
    assert.match(before?.textContent ?? '', /Com falhas.*45%.*Falta validar a sessão\./);
    assert.match(after?.textContent ?? '', /Aprovados.*80%.*Nenhum finding registrado\./);
    assert.match(before?.textContent ?? '', /T1 · Falhou/);
    assert.match(after?.textContent ?? '', /T1 · Passou/);
    assert(seen.some(url =>
      url.searchParams.get('fromCheckpointId') === checkpoints[0]?.id &&
      url.searchParams.get('toCheckpointId') === checkpoints[1]?.id,
    ));
    await clickButton('src/auth.ts');
    assert.match(visiblePanel().querySelector('pre')?.textContent ?? '', /linha antiga/);

    await clickButton('Matriz de Rastreabilidade', tabs);
    assert.equal(tabs.querySelector('[aria-selected="true"]')?.textContent, 'Matriz de Rastreabilidade');
    assert.match(visiblePanel().textContent ?? '', /1\/2 cobertos/);
    assert.match(visiblePanel().textContent ?? '', /CA1.*src\/auth\.ts.*T1.*Passou.*Adicionar comentário sobre expiração\./);
    assert.match(visiblePanel().textContent ?? '', /CA2.*Nenhum arquivo alterado vinculado a este critério/);
    await clickButton('Com lacunas (1)');
    assert.doesNotMatch(visiblePanel().textContent ?? '', /Validar sessão JWT/);
    assert.match(visiblePanel().textContent ?? '', /Gerar relatório sem arquivo nem teste/);
    await clickButton('Sem lacunas (1)');
    assert.match(visiblePanel().textContent ?? '', /Validar sessão JWT/);
    assert.doesNotMatch(visiblePanel().textContent ?? '', /Gerar relatório sem arquivo nem teste/);
  } finally {
    await act(() => root.unmount());
  }
});

test('Factory oculta o terminal das etapas e mantém a atividade em tempo real e o terminal de review', async context => {
  const runningFlow = createFlow({
    transitions: [
      {
        from: 'queued',
        to: 'running',
        stage: 'triage',
        at: '2026-11-19T12:05:00.000Z',
        reason: 'Sessão iniciada',
      },
    ],
  });
  const session = createSession({ startedAt: runningFlow.updatedAt });
  const oldSession = createSession({
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    status: 'exited',
    finishedAt: session.startedAt,
  });
  const standaloneSession = createSession({
    sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    title: 'Sessão avulsa',
    flowId: null,
  });
  const reviewSession = createSession({
    sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    mode: 'review',
    title: 'Review #99',
    flowId: null,
    stage: null,
  });
  const queuedFlow = createFlow({
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Fluxo na fila',
    state: 'queued',
    currentSessionId: null,
    updatedAt: runningFlow.createdAt,
  });
  const snapshot = { sessions: [session, oldSession, standaloneSession, reviewSession] };
  const streams: FakeEventSource[] = [];
  class FakeEventSource {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;

    constructor() {
      streams.push(this);
    }

    close() {}

    emit(event: AppEvent) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }

  const window = parseHTML('<html><body><div id="test-root"></div></body></html>');
  const { document } = window;
  function replaceProperty(target: object, name: string, value: unknown) {
    const original = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, value, writable: true });
    context.after(() => {
      if (original) {
        Object.defineProperty(target, name, original);
      } else {
        Reflect.deleteProperty(target, name);
      }
    });
  }
  replaceProperty(window.HTMLElement.prototype, 'showModal', function (this: HTMLElement) {
    this.setAttribute('open', '');
  });
  replaceProperty(window.HTMLElement.prototype, 'close', function (this: HTMLElement) {
    this.removeAttribute('open');
  });
  replaceProperty(globalThis, 'window', window);
  replaceProperty(globalThis, 'document', document);
  replaceProperty(globalThis, 'EventSource', FakeEventSource);
  replaceProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse(session.startedAt) });

  let finishSnapshot: (() => void) | undefined;
  const delayedSnapshot = new Promise<Response>(resolve => {
    finishSnapshot = () => resolve(Response.json(snapshot));
  });
  let requestedSessions = false;
  context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path === '/api/sessions') {
      if (requestedSessions) {
        return delayedSnapshot;
      }
      requestedSessions = true;
      return Promise.resolve(Response.json(snapshot));
    }
    if (path === '/api/factory/flows') {
      return Promise.resolve(
        Response.json({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          flows: [runningFlow, queuedFlow],
        }),
      );
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  function Harness() {
    const operations = useBackgroundOperations();
    const [roadmapOpen, setRoadmapOpen] = useState(true);
    const [popoverOpen, setPopoverOpen] = useState(true);
    const flow = operations.factoryFlowsById.get(runningFlow.id);

    return (
      <>
        {factoryPageElement({
          factoryFlows: operations.factoryFlows,
          sessionsById: operations.sessionsById,
        })}
        {roadmapOpen && flow && (
          <FactoryFlowRoadmapModal
            flow={flow}
            runningSession={getRunningFactorySession(flow, operations.sessionsById)}
            onClose={() => setRoadmapOpen(false)}
            onAdvanceFlowStage={noopAsync}
            onRerunFlowStage={noopAsync}
            onViewMarkdown={noop}
          />
        )}
        {popoverOpen && (
          <BackgroundTasksPopover
            id="live-operations"
            sessions={operations.sessions}
            factoryFlows={operations.factoryFlows}
            onOpenTerminal={operations.openTerminal}
            onViewReport={noop}
            onClose={() => setPopoverOpen(false)}
          />
        )}
        <button id="reset-terminal" type="button" onClick={operations.minimizeTerminal}>
          Minimizar terminal
        </button>
        <output id="terminal-session">{operations.activeTerminalSession?.sessionId}</output>
      </>
    );
  }

  const container = document.getElementById('test-root');
  assert(container);
  const root = createRoot(container);
  const terminalButton = 'button[aria-label^="Abrir terminal ao vivo"]';
  const activeSession = () => container.querySelector('#terminal-session')?.textContent;
  const click = async (selector: string) => {
    const button = container.querySelector<HTMLButtonElement>(selector);
    assert(button, `Botão ausente: ${selector}`);
    await act(() => button.click());
  };

  try {
    await act(() => root.render(<Harness />));
    assert.equal(container.querySelectorAll(`main ${terminalButton}`).length, 0);
    assert.equal(container.querySelectorAll(`dialog ${terminalButton}`).length, 0);
    assert.equal(container.querySelectorAll(`#live-operations ${terminalButton}`).length, 0);
    assert.doesNotMatch(container.querySelector('main')?.textContent ?? '', /Abrir terminal/);
    assert.doesNotMatch(container.querySelector('dialog')?.textContent ?? '', /Abrir terminal/);
    assert.match(container.querySelector('main')?.textContent ?? '', /Aguardando atividade/);

    const [events] = streams;
    assert(events);
    const active = {
      ...session,
      factoryActivity: {
        revision: 1,
        lastReadFile: 'src/entrada.ts',
        lastEditedFile: 'src/saida.ts',
        lastCommand: 'npm test',
      },
    };
    await act(() => {
      events.onopen?.();
      events.emit({ type: 'session.updated', session: active });
      context.mock.timers.tick(2000);
    });
    await act(() => finishSnapshot?.());
    const stageCard = container.querySelector('main article');
    assert.match(stageCard?.textContent ?? '', /Último arquivo lidosrc\/entrada\.ts/);
    assert.match(stageCard?.textContent ?? '', /Último arquivo editadosrc\/saida\.ts/);
    assert.match(stageCard?.textContent ?? '', /Último comandonpm test/);
    assert.equal(stageCard?.querySelector('[role="timer"]')?.textContent, '00:02');

    const reviewButtons = [...container.querySelectorAll<HTMLButtonElement>('#live-operations button')].filter(
      button => button.textContent?.trim() === 'Abrir terminal',
    );
    assert.equal(reviewButtons.length, 1);
    await act(() => reviewButtons[0]?.click());
    assert.equal(activeSession(), reviewSession.sessionId);
    assert.equal(container.querySelector('#live-operations'), null);
    await click('#reset-terminal');
    assert.equal(activeSession(), '');

    await act(() => {
      events.emit({
        type: 'session.finished',
        session: { ...active, status: 'exited', finishedAt: new Date().toISOString() },
      });
      events.emit({ type: 'session.updated', session });
    });
    assert.equal(container.querySelector('main [role="timer"]'), null);
  } finally {
    await act(() => root.unmount());
  }
});

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
      onOpenTerminal: unavailableTerminal,
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
      onOpenTerminal: unavailableTerminal,
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
      onOpenTerminal: unavailableTerminal,
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

  assert.doesNotMatch(html, /Portão humano · Ação necessária/);
  assert.doesNotMatch(html, /Respostas aos bloqueadores \/ Complemento de contexto/);
  assert.doesNotMatch(html, /Avançar para Planejamento/);
  assert.match(html, /Falha na consulta ao Jira MCP/);
  assert.match(html, /Erro 401 ao consultar Jira MCP/);
  assert.match(html, />Reexecutar</);
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
      onOpenTerminal: unavailableTerminal,
      onOpenFlowRoadmap: noop,
      onViewReport: noop,
      onClose: noop,
    }),
  );
  assert.match(popoverHtml, /Planejamento aprovado: 2 decisões · 1 CAs/);
});

test('FactoryFlowTraceabilityPanel exibe conexões completas, lacunas e itens sem vínculo', () => {
  const matrix = buildFactoryTraceabilityMatrix({
    triage: {
      contractVersion: FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
      stage: 'triage',
      acceptanceCriteria: [
        { id: 'CA1', description: 'Autenticar usuário em src/login.ts.' },
        { id: 'CA2', description: 'Enviar webhook assinado.' },
      ],
      negativeScope: [],
      blockers: [],
      jiraContext: null,
      technicalContext: 'Investigar login e webhook.',
    },
    planning: {
      contractVersion: FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
      stage: 'planning',
      pendingDecisions: [],
      plannedFiles: ['src/login.ts', 'src/webhook.ts'],
      testPlan: ['CA1: Testar src/login.ts.', 'CA2: Testar src/webhook.ts.'],
    },
    planningApproval: {
      approvedAt: '2026-11-22T10:00:00.000Z',
      decisions: [],
      acceptanceCriteria: [
        { id: 'CA1', description: 'Autenticar usuário em src/login.ts.', approved: true },
        { id: 'CA2', description: 'Enviar webhook assinado.', approved: true },
      ],
    },
    development: {
      contractVersion: FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
      stage: 'development',
      changedFiles: ['src/login.ts', 'src/extra-orphan.ts'],
      summary: 'Login implementado.',
      deviations: [],
    },
    tests: {
      contractVersion: FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
      stage: 'tests',
      status: 'passed',
      executedCommands: [{ command: ['npm', 'test'], exitCode: 0 }],
      testCases: [
        {
          id: 'T1',
          description: 'Valida autenticação em src/login.ts.',
          acceptanceCriteriaIds: ['CA1'],
          status: 'passed',
        },
      ],
      coverage: null,
    },
    review: {
      contractVersion: FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
      stage: 'review',
      verdict: 'changes_requested',
      returnTarget: 'development',
      findings: [
        {
          severity: 'BLOQUEANTE',
          file: 'src/login.ts',
          line: 18,
          explanation: 'Validar expiração do token.',
          category: 'seguranca',
          signature: 'token-exp',
        },
      ],
    },
    worktreeAvailable: false,
    worktreeFiles: [],
  });

  const html = renderToStaticMarkup(
    createElement(FactoryFlowTraceabilityPanel, {
      flowId: '11111111-1111-4111-8111-111111111111',
      initialMatrix: matrix,
    }),
  );

  assert.match(html, /Matriz de Rastreabilidade/);
  assert.match(html, /CA1/);
  assert.match(html, /src\/login\.ts/);
  assert.match(html, /T1/);
  assert.match(html, /BLOQUEANTE/);
  assert.match(html, /Validar expiração do token\./);
  assert.match(html, /CA2/);
  assert.match(html, /Planejado · sem alteração/);
  assert.match(html, /Sem teste vinculado/);
  assert.match(html, /Itens sem critério de aceite vinculado/);
  assert.match(html, /src\/extra-orphan\.ts/);
});

test('FactoryFlowRoadmapModal filtra findings por severidade, salta para linha no diff e persiste triagem condicional', async context => {
  const window = parseHTML('<!doctype html><html><body><div id="findings-root"></div></body></html>');
  const { document } = window;
  const originalFetch = globalThis.fetch;
  const overrides: Array<[object, string, unknown]> = [
    [globalThis, 'window', window],
    [globalThis, 'document', document],
    [globalThis, 'HTMLElement', window.HTMLElement],
    [globalThis, 'IS_REACT_ACT_ENVIRONMENT', true],
    [window.HTMLElement.prototype, 'showModal', function (this: HTMLElement) {
      this.setAttribute('open', '');
    }],
    [window.HTMLElement.prototype, 'close', function (this: HTMLElement) {
      this.removeAttribute('open');
    }],
    [window.HTMLElement.prototype, 'attachEvent', () => undefined],
    [window.HTMLElement.prototype, 'detachEvent', () => undefined],
  ];
  for (const [target, name, value] of overrides) {
    const original = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, value, writable: true });
    context.after(() => {
      if (original) {
        Object.defineProperty(target, name, original);
      } else {
        Reflect.deleteProperty(target, name);
      }
    });
  }
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  context.mock.method(window.HTMLElement.prototype, 'focus', () => undefined);

  const flowId = 'aaaaaaaa-2222-4222-8222-222222222222';
  const reviewArtifactId = 'bbbbbbbb-2222-4222-8222-222222222222';
  const baseFlow = createFlow({
    id: flowId,
    title: 'REV-65 · Triagem de Findings',
    currentStage: 'review',
    state: 'waiting_action',
    currentSessionId: null,
    iteration: 1,
    lastReviewVerdict: 'changes_requested',
    worktreePath: '/tmp/worktree-rev-65',
    branchName: 'factory/rev-65',
    baseBranch: 'main',
  });

  const makeGate = (
    decisions: Array<{
      findingId: string;
      action: 'pending' | 'approve_fix' | 'promote_mandatory' | 'dismiss_false_positive';
      justification?: string;
    }>,
  ) => {
    const map = new Map(decisions.map(item => [item.findingId, item]));
    const f1Action = map.get('F1')?.action ?? 'pending';
    const f2Action = map.get('F2')?.action ?? 'pending';
    const f3Action = map.get('F3')?.action ?? 'pending';
    const activeBlockers =
      (f1Action !== 'dismiss_false_positive' ? 1 : 0) +
      (f2Action === 'promote_mandatory' ? 1 : 0);

    return {
      reviewArtifactId,
      reviewReportPath: '/tmp/artifacts/review.md',
      iteration: 1,
      verdict: 'changes_requested' as const,
      returnTarget: 'development' as const,
      findings: [
        {
          id: 'F1',
          index: 0,
          severity: 'BLOQUEANTE' as const,
          file: 'src/auth.ts',
          line: 14,
          explanation: 'Token expirado retorna HTTP 500.',
          action: f1Action,
          ...(map.get('F1')?.justification ? { justification: map.get('F1')?.justification } : {}),
          effectiveSeverity: f1Action === 'dismiss_false_positive' ? ('DISCARDED' as const) : ('BLOQUEANTE' as const),
          isActiveBlocker: f1Action !== 'dismiss_false_positive',
          includedInReturnScope: f1Action !== 'dismiss_false_positive',
        },
        {
          id: 'F2',
          index: 1,
          severity: 'SUGESTÃO' as const,
          file: 'src/auth.ts',
          line: 22,
          explanation: 'Extrair validação do header.',
          action: f2Action,
          effectiveSeverity: f2Action === 'promote_mandatory' ? ('BLOQUEANTE' as const) : f2Action === 'dismiss_false_positive' ? ('DISCARDED' as const) : ('SUGESTÃO' as const),
          isActiveBlocker: f2Action === 'promote_mandatory',
          includedInReturnScope: f2Action === 'promote_mandatory' || f2Action === 'approve_fix',
        },
        {
          id: 'F3',
          index: 2,
          severity: 'NIT' as const,
          file: 'src/auth.ts',
          line: 30,
          explanation: 'Padronizar nome da variável local.',
          action: f3Action,
          effectiveSeverity: f3Action === 'dismiss_false_positive' ? ('DISCARDED' as const) : ('NIT' as const),
          isActiveBlocker: false,
          includedInReturnScope: f3Action === 'approve_fix',
        },
      ],
      counts: {
        total: 3,
        blocking: 1,
        suggestion: 1,
        nit: 1,
        activeBlockers,
        approvedForFix: [f1Action, f2Action, f3Action].filter(a => a === 'approve_fix').length,
        promotedMandatory: f2Action === 'promote_mandatory' ? 1 : 0,
        dismissed: [f1Action, f2Action, f3Action].filter(a => a === 'dismiss_false_positive').length,
        pending: [f1Action, f2Action, f3Action].filter(a => a === 'pending').length,
      },
      canAdvanceToPr: activeBlockers === 0,
    };
  };

  let currentDetails: FactoryFlowDetails = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow: baseFlow,
    stages: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-2222-4222-8222-222222222201',
        flowId,
        name: 'triage',
        state: 'completed',
        sessionId: null,
        reportPath: '/tmp/artifacts/spec.md',
        sessionPath: null,
        createdAt: '2026-11-19T12:00:00.000Z',
        updatedAt: '2026-11-19T12:01:00.000Z',
        startedAt: '2026-11-19T12:00:00.000Z',
        finishedAt: '2026-11-19T12:01:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-2222-4222-8222-222222222202',
        flowId,
        name: 'planning',
        state: 'completed',
        sessionId: null,
        reportPath: '/tmp/artifacts/plan.md',
        sessionPath: null,
        createdAt: '2026-11-19T12:01:00.000Z',
        updatedAt: '2026-11-19T12:02:00.000Z',
        startedAt: '2026-11-19T12:01:00.000Z',
        finishedAt: '2026-11-19T12:02:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-2222-4222-8222-222222222203',
        flowId,
        name: 'development',
        state: 'completed',
        sessionId: null,
        reportPath: '/tmp/artifacts/dev.md',
        sessionPath: null,
        createdAt: '2026-11-19T12:02:00.000Z',
        updatedAt: '2026-11-19T12:03:00.000Z',
        startedAt: '2026-11-19T12:02:00.000Z',
        finishedAt: '2026-11-19T12:03:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-2222-4222-8222-222222222204',
        flowId,
        name: 'tests',
        state: 'completed',
        sessionId: null,
        reportPath: '/tmp/artifacts/tests.md',
        sessionPath: null,
        createdAt: '2026-11-19T12:03:00.000Z',
        updatedAt: '2026-11-19T12:04:00.000Z',
        startedAt: '2026-11-19T12:03:00.000Z',
        finishedAt: '2026-11-19T12:04:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-2222-4222-8222-222222222205',
        flowId,
        name: 'review',
        state: 'waiting_action',
        sessionId: null,
        reportPath: '/tmp/artifacts/review.md',
        sessionPath: null,
        createdAt: '2026-11-19T12:04:00.000Z',
        updatedAt: '2026-11-19T12:05:00.000Z',
        startedAt: '2026-11-19T12:04:00.000Z',
        finishedAt: null,
        error: null,
      },
    ],
    artifacts: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'dddddddd-2222-4222-8222-222222222201',
        flowId,
        stage: 'triage',
        sessionId: null,
        kind: 'specification',
        format: 'markdown',
        path: '/tmp/artifacts/spec.md',
        status: 'ready',
        iteration: 0,
        createdAt: '2026-11-19T12:01:00.000Z',
        updatedAt: '2026-11-19T12:01:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'dddddddd-2222-4222-8222-222222222202',
        flowId,
        stage: 'planning',
        sessionId: null,
        kind: 'plan',
        format: 'markdown',
        path: '/tmp/artifacts/plan.md',
        status: 'ready',
        iteration: 0,
        createdAt: '2026-11-19T12:02:00.000Z',
        updatedAt: '2026-11-19T12:02:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'dddddddd-2222-4222-8222-222222222203',
        flowId,
        stage: 'development',
        sessionId: null,
        kind: 'implementation_report',
        format: 'markdown',
        path: '/tmp/artifacts/dev.md',
        status: 'ready',
        iteration: 1,
        createdAt: '2026-11-19T12:03:00.000Z',
        updatedAt: '2026-11-19T12:03:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'dddddddd-2222-4222-8222-222222222204',
        flowId,
        stage: 'tests',
        sessionId: null,
        kind: 'test_report',
        format: 'markdown',
        path: '/tmp/artifacts/tests.md',
        status: 'ready',
        iteration: 1,
        createdAt: '2026-11-19T12:04:00.000Z',
        updatedAt: '2026-11-19T12:04:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: reviewArtifactId,
        flowId,
        stage: 'review',
        sessionId: null,
        kind: 'review_report',
        format: 'markdown',
        path: '/tmp/artifacts/review.md',
        status: 'ready',
        iteration: 1,
        createdAt: '2026-11-19T12:05:00.000Z',
        updatedAt: '2026-11-19T12:05:00.000Z',
        error: null,
      },
    ],
    worktreePath: '/tmp/worktree-rev-65',
    branchName: 'factory/rev-65',
    baseBranch: 'main',
    checkpoints: [],
    reviewGate: makeGate([]),
  };

  const savedCalls: Array<unknown> = [];
  let advancedCount = 0;

  globalThis.fetch = (input => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname.endsWith('/diff')) {
      const file = url.searchParams.get('file');
      if (file === 'src/auth.ts') {
        return Promise.resolve(
          Response.json({
            contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
            kind: 'patch',
            patch: '@@ -12,2 +13,3 @@\n export function check() {\n+  return throwExpired();\n }',
            truncated: false,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          kind: 'page',
          files: [
            {
              path: 'src/auth.ts',
              change: 'modified',
              untracked: false,
              additions: 1,
              deletions: 0,
              binary: false,
            },
          ],
          totalFiles: 1,
          nextOffset: null,
          truncated: false,
        }),
      );
    }
    return Promise.resolve(Response.json(currentDetails));
  });

  const container = document.getElementById('findings-root');
  assert(container);
  const root = createRoot(container);
  const visiblePanel = () => {
    const panel = container.querySelector('[role="tabpanel"]:not([hidden])');
    assert(panel);
    return panel;
  };
  const clickButton = async (label: string, within: ParentNode = visiblePanel()) => {
    const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      item => item.textContent?.trim().startsWith(label),
    );
    assert(button, `Botão ausente: ${label}`);
    await act(async () => {
      button.click();
    });
  };

  try {
    await act(async () => {
      root.render(
        createElement(FactoryFlowRoadmapModal, {
          flow: baseFlow,
          initialDetails: currentDetails,
          onClose: noop,
              onAdvanceFlowStage: async () => {
            advancedCount += 1;
          },
          onRerunFlowStage: noopAsync,
          onReturnFlowStage: noopAsync,
          onSaveReviewTriage: async (_id, request) => {
            savedCalls.push(request.decisions);
            const updatedFlow: FactoryFlow = {
              ...baseFlow,
              reviewTriage: {
                reviewArtifactId,
                iteration: 1,
                decisions: request.decisions,
                updatedAt: '2026-11-22T12:10:00.000Z',
              },
            };
            const nextGate = makeGate(request.decisions);
            currentDetails = {
              ...currentDetails,
              flow: updatedFlow,
              reviewGate: nextGate,
            };
            return {
              contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
              flow: updatedFlow,
              reviewGate: nextGate,
            };
          },
          onViewMarkdown: noop,
        }),
      );
    });

    // Roadmap exibe resumo de findings e botão Avançar para PR inicialmente bloqueado.
    assert.match(visiblePanel().textContent ?? '', /Findings do Review \(3\)/);
    const roadmapAdvanceBtn = [...visiblePanel().querySelectorAll<HTMLButtonElement>('button')].find(
      button => button.textContent?.trim() === 'Avançar para PR',
    );
    assert(roadmapAdvanceBtn);
    assert.equal(roadmapAdvanceBtn.disabled, true);

    await clickButton('Triar findings (3)');
    const tabs = container.querySelector('[role="tablist"]');
    assert(tabs);
    assert.equal(tabs.querySelector('[aria-selected="true"]')?.textContent, 'Findings do Review');

    // Filtrar por severidade SUGESTÃO.
    await clickButton('SUGESTÃO (1)');
    assert.match(visiblePanel().textContent ?? '', /Extrair validação do header\./);
    assert.doesNotMatch(visiblePanel().textContent ?? '', /Token expirado retorna HTTP 500\./);

    // Promover a SUGESTÃO a correção obrigatória.
    await clickButton('Promover a obrigatória');
    assert.equal(savedCalls.length, 1);
    assert.match(visiblePanel().textContent ?? '', /Promovida a obrigatória/);

    // Voltar para Todos e filtrar BLOQUEANTE -> descartar F1 com justificativa.
    await clickButton('BLOQUEANTE (1)');
    assert.match(visiblePanel().textContent ?? '', /Token expirado retorna HTTP 500\./);
    await clickButton('Descartar falso positivo');
    const justificationInput = visiblePanel().querySelector<HTMLInputElement>('input[type="text"]');
    assert(justificationInput);
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(justificationInput),
        'value',
      )?.set;
      assert(valueSetter);
      Object.assign(justificationInput, { attachEvent: () => undefined });
      justificationInput.dispatchEvent(new window.Event('focusin', { bubbles: true }));
      valueSetter.call(justificationInput, 'Tratado no gateway');
      justificationInput.dispatchEvent(new window.Event('keyup', { bubbles: true }));
      justificationInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await clickButton('Confirmar descarte');
    assert.match(visiblePanel().textContent ?? '', /Falso positivo descartado/);
    assert.match(visiblePanel().textContent ?? '', /Tratado no gateway/);

    // Avançar para PR ainda bloqueado porque F2 (SUGESTÃO promovida) é bloqueante ativo.
    const findingsAdvanceBtn = [...visiblePanel().querySelectorAll<HTMLButtonElement>('button')].find(
      button => button.textContent?.trim() === 'Avançar para PR',
    );
    assert(findingsAdvanceBtn);
    assert.equal(findingsAdvanceBtn.disabled, true);

    // Despromover F2 (clicar em "Promovida a obrigatória") -> 0 bloqueantes ativos -> Avançar para PR liberado!
    await clickButton('Todos (3)');
    await clickButton('Promovida a obrigatória');
    const unlockedAdvanceBtn = [...visiblePanel().querySelectorAll<HTMLButtonElement>('button')].find(
      button => button.textContent?.trim() === 'Avançar para PR',
    );
    assert(unlockedAdvanceBtn);
    assert.equal(unlockedAdvanceBtn.disabled, false);

    // Link direto ao arquivo e linha no diff.
    await clickButton('src/auth.ts:14');
    assert.equal(tabs?.querySelector('[aria-selected="true"]')?.textContent, 'Diff Real');
    assert.match(visiblePanel().textContent ?? '', /Linha 14/);
    const focusedLine = visiblePanel().querySelector('[aria-current="location"]');
    assert(focusedLine);
    assert.equal(focusedLine.getAttribute('data-line'), '14');
    assert.match(focusedLine.textContent ?? '', /return throwExpired\(\);/);

    // Voltar à aba Findings e acionar Avançar para PR.
    await clickButton('Findings do Review', tabs);
    await clickButton('Avançar para PR');
    assert.equal(advancedCount, 1);
  } finally {
    await act(() => root.unmount());
  }
});

test('FactoryFlowRoadmapModal + FactoryFlowPrPanel pré-carregam Etapa 1, validam campos e exigem confirmação explícita antes do envio', async context => {
  const window = parseHTML('<!doctype html><html><body><div id="pr-root"></div></body></html>');
  const { document } = window;
  const originalFetch = globalThis.fetch;
  const overrides: Array<[object, string, unknown]> = [
    [globalThis, 'window', window],
    [globalThis, 'document', document],
    [globalThis, 'HTMLElement', window.HTMLElement],
    [globalThis, 'IS_REACT_ACT_ENVIRONMENT', true],
    [window.HTMLElement.prototype, 'showModal', function (this: HTMLElement) {
      this.setAttribute('open', '');
    }],
    [window.HTMLElement.prototype, 'close', function (this: HTMLElement) {
      this.removeAttribute('open');
    }],
    [window.HTMLElement.prototype, 'attachEvent', () => undefined],
    [window.HTMLElement.prototype, 'detachEvent', () => undefined],
  ];
  for (const [target, name, value] of overrides) {
    const original = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, value, writable: true });
    context.after(() => {
      if (original) {
        Object.defineProperty(target, name, original);
      } else {
        Reflect.deleteProperty(target, name);
      }
    });
  }
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  context.mock.method(window.HTMLElement.prototype, 'focus', () => undefined);

  const flowId = '11111111-1111-4111-8111-111111111111';
  const prArtifactId = 'dddddddd-3333-4333-8333-333333333306';
  const baseFlow = createFlow({
    id: flowId,
    title: 'AUTH-101 · Revisão de PR',
    currentStage: 'pr',
    state: 'waiting_action',
    currentSessionId: null,
    iteration: 1,
    lastReviewVerdict: 'approved',
    worktreePath: '/tmp/worktree-auth-101',
    branchName: 'factory/auth-101',
    baseBranch: 'main',
    updatedAt: '2026-11-22T12:00:00.000Z',
  });

  let currentDetails: FactoryFlowDetails = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow: baseFlow,
    stages: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-3333-4333-8333-333333333301',
        flowId,
        name: 'triage',
        state: 'completed',
        sessionId: null,
        reportPath: '/tmp/artifacts/spec.md',
        sessionPath: null,
        createdAt: '2026-11-22T11:50:00.000Z',
        updatedAt: '2026-11-22T11:51:00.000Z',
        startedAt: '2026-11-22T11:50:00.000Z',
        finishedAt: '2026-11-22T11:51:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-3333-4333-8333-333333333302',
        flowId,
        name: 'planning',
        state: 'completed',
        sessionId: null,
        reportPath: '/tmp/artifacts/plan.md',
        sessionPath: null,
        createdAt: '2026-11-22T11:51:00.000Z',
        updatedAt: '2026-11-22T11:52:00.000Z',
        startedAt: '2026-11-22T11:51:00.000Z',
        finishedAt: '2026-11-22T11:52:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-3333-4333-8333-333333333303',
        flowId,
        name: 'development',
        state: 'completed',
        sessionId: null,
        reportPath: '/tmp/artifacts/dev.md',
        sessionPath: null,
        createdAt: '2026-11-22T11:52:00.000Z',
        updatedAt: '2026-11-22T11:53:00.000Z',
        startedAt: '2026-11-22T11:52:00.000Z',
        finishedAt: '2026-11-22T11:53:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-3333-4333-8333-333333333304',
        flowId,
        name: 'tests',
        state: 'completed',
        sessionId: null,
        reportPath: '/tmp/artifacts/tests.md',
        sessionPath: null,
        createdAt: '2026-11-22T11:53:00.000Z',
        updatedAt: '2026-11-22T11:54:00.000Z',
        startedAt: '2026-11-22T11:53:00.000Z',
        finishedAt: '2026-11-22T11:54:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-3333-4333-8333-333333333305',
        flowId,
        name: 'review',
        state: 'completed',
        sessionId: null,
        reportPath: '/tmp/artifacts/review.md',
        sessionPath: null,
        createdAt: '2026-11-22T11:54:00.000Z',
        updatedAt: '2026-11-22T11:55:00.000Z',
        startedAt: '2026-11-22T11:54:00.000Z',
        finishedAt: '2026-11-22T11:55:00.000Z',
        error: null,
      },
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-3333-4333-8333-333333333306',
        flowId,
        name: 'pr',
        state: 'waiting_action',
        sessionId: null,
        reportPath: '/tmp/artifacts/pr-summary.md',
        sessionPath: null,
        createdAt: '2026-11-22T11:55:00.000Z',
        updatedAt: '2026-11-22T12:00:00.000Z',
        startedAt: '2026-11-22T11:55:00.000Z',
        finishedAt: null,
        error: null,
      },
    ],
    artifacts: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: prArtifactId,
        flowId,
        stage: 'pr',
        sessionId: null,
        kind: 'pr_summary',
        format: 'markdown',
        path: '/tmp/artifacts/pr-summary.md',
        status: 'ready',
        iteration: 1,
        createdAt: '2026-11-22T11:59:00.000Z',
        updatedAt: '2026-11-22T11:59:00.000Z',
        error: null,
      },
    ],
    worktreePath: '/tmp/worktree-auth-101',
    branchName: 'factory/auth-101',
    baseBranch: 'main',
    checkpoints: [],
    prGate: {
      prArtifactId,
      prReportPath: '/tmp/artifacts/pr-summary.md',
      iteration: 1,
      title: 'feat(auth): renovar token JWT expirado',
      description: '## Resumo\nRenovação automática de JWT.\n\n| CA | Status |\n| --- | --- |\n| CA1 | Atendido |',
      summary: 'Renovação automática de JWT.',
      baseBranch: 'main',
      headBranch: 'factory/auth-101',
      draft: false,
      reviewers: [],
      updateJira: true,
      confirmedForPublish: false,
      confirmedAt: null,
      updatedAt: null,
      draftTitle: 'feat(auth): renovar token JWT expirado',
      draftDescription:
        '## Resumo\nRenovação automática de JWT.\n\n| CA | Status |\n| --- | --- |\n| CA1 | Atendido |',
      draftBaseBranch: 'main',
      satisfiedAcceptanceCriteriaIds: ['CA1'],
      evidence: ['npm test (exitCode 0)'],
      jiraContext: {
        key: 'AUTH-101',
        url: 'https://empresa.atlassian.net/browse/AUTH-101',
      },
    },
  };

  const savedPayloads: Array<Record<string, unknown>> = [];
  globalThis.fetch = (() => Promise.resolve(Response.json(currentDetails))) as typeof fetch;

  const container = document.getElementById('pr-root');
  assert(container);
  const root = createRoot(container);

  const visiblePanel = () => {
    const panel = container.querySelector('[role="tabpanel"]:not([hidden])');
    assert(panel);
    return panel;
  };

  const clickButton = async (label: string, within: ParentNode = visiblePanel()) => {
    const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      item => item.textContent?.trim().startsWith(label),
    );
    assert(button, `Botão ausente: ${label}`);
    await act(async () => {
      button.click();
    });
  };

  const setInputValue = async (
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) => {
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(element),
        'value',
      )?.set;
      assert(valueSetter);
      Object.assign(element, { attachEvent: () => undefined, detachEvent: () => undefined });
      element.dispatchEvent(new window.Event('focusin', { bubbles: true }));
      valueSetter.call(element, value);
      element.dispatchEvent(new window.Event('keyup', { bubbles: true }));
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };

  try {
    await act(async () => {
      root.render(
        createElement(FactoryFlowRoadmapModal, {
          flow: baseFlow,
          initialDetails: currentDetails,
          onClose: noop,
              onAdvanceFlowStage: noopAsync,
          onRerunFlowStage: noopAsync,
          onSavePrReview: async (_id, request) => {
            savedPayloads.push(request);
            const now = '2026-11-22T12:05:00.000Z';
            const updatedFlow: FactoryFlow = {
              ...baseFlow,
              prReview: {
                prArtifactId,
                title: request.title,
                description: request.description,
                baseBranch: request.baseBranch,
                draft: request.draft,
                reviewers: request.reviewers,
                updateJira: request.updateJira,
                confirmedForPublish: Boolean(request.confirmPublish),
                confirmedAt: request.confirmPublish ? now : null,
                updatedAt: now,
              },
            };
            assert(currentDetails.prGate);
            const nextGate = {
              ...currentDetails.prGate,
              title: request.title,
              description: request.description,
              baseBranch: request.baseBranch,
              draft: request.draft,
              reviewers: request.reviewers,
              updateJira: request.updateJira,
              confirmedForPublish: Boolean(request.confirmPublish),
              confirmedAt: request.confirmPublish ? now : null,
              updatedAt: now,
            };
            currentDetails = {
              ...currentDetails,
              flow: updatedFlow,
              prGate: nextGate,
            };
            return {
              contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
              flow: updatedFlow,
              prGate: nextGate,
            };
          },
          onViewMarkdown: noop,
        }),
      );
    });

    // Card da Etapa 06 no Roadmap mostra resumo do rascunho preparado e botão para revisão.
    assert.match(visiblePanel().textContent ?? '', /Rascunho do PR preparado/);
    await clickButton('Revisar e publicar PR');

    const tabs = container.querySelector('[role="tablist"]');
    assert(tabs);
    assert.equal(tabs.querySelector('[aria-selected="true"]')?.textContent, 'Revisão do PR');

    const panel = visiblePanel();
    const titleInput = panel.querySelector<HTMLInputElement>('input[placeholder*="feat(escopo)"]');
    const baseBranchInput = panel.querySelector<HTMLInputElement>('input[placeholder="main"]');
    const descriptionArea = panel.querySelector<HTMLTextAreaElement>('textarea');
    const reviewerInput = panel.querySelector<HTMLInputElement>(
      'input[placeholder*="Adicione usuários"]',
    );
    const checkboxes = [...panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    assert(titleInput);
    assert(baseBranchInput);
    assert(descriptionArea);
    assert(reviewerInput);
    assert.equal(checkboxes.length, 2);
    const [draftCheckbox, jiraCheckbox] = checkboxes;
    assert(draftCheckbox);
    assert(jiraCheckbox);

    // Pré-carrega os dados gerados pela Etapa 1.
    assert.equal(titleInput.value, 'feat(auth): renovar token JWT expirado');
    assert.equal(baseBranchInput.value, 'main');
    assert.equal(draftCheckbox.checked, false);
    assert.equal(jiraCheckbox.checked, true);
    assert.match(panel.textContent ?? '', /AUTH-101/);

    // Pré-visualização Markdown comprova que a descrição pré-carregada está preenchida.
    await clickButton('Pré-visualizar');
    assert.match(
      panel.querySelector('[aria-label="Pré-visualização da descrição Markdown"]')?.textContent ??
        '',
      /Renovação automática de JWT/,
    );
    await clickButton('Editar');

    // Validação bloqueia envio com título vazio e branch destino inválida antes de chamar backend.
    await setInputValue(titleInput, '   ');
    await setInputValue(baseBranchInput, 'HEAD');
    await clickButton('Revisar e confirmar publicação');
    assert.equal(savedPayloads.length, 0);
    assert.match(panel.textContent ?? '', /Informe o título do Pull Request/);
    assert.match(panel.textContent ?? '', /Informe uma branch destino válida/);

    // Edita campos válidos, adiciona reviewers e marca Draft PR.
    await setInputValue(titleInput, 'feat(auth): renovar token JWT com janela segura');
    await setInputValue(baseBranchInput, 'release/auth');
    await setInputValue(reviewerInput, '@alice, core/security');
    await clickButton('Adicionar');
    assert.match(panel.textContent ?? '', /@alice/);
    assert.match(panel.textContent ?? '', /@core\/security/);
    await act(async () => {
      draftCheckbox.checked = true;
      draftCheckbox.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    // Salvar revisão envia confirmPublish=false e NÃO abre/dispara publicação irreversível.
    const form = panel.querySelector('form');
    assert(form);
    await act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(savedPayloads.length, 1);
    assert.equal(savedPayloads[0]?.confirmPublish, false);
    assert.equal(savedPayloads[0]?.baseBranch, 'release/auth');
    assert.equal(savedPayloads[0]?.draft, true);
    assert.deepEqual(savedPayloads[0]?.reviewers, ['alice', 'core/security']);

    // Confirmação explícita: exige clique em "Revisar e confirmar publicação" e depois "Confirmar publicação do PR".
    await clickButton('Revisar e confirmar publicação');
    assert.equal(savedPayloads.length, 1);
    assert.match(
      panel.textContent ?? '',
      /Confirmar parâmetros finais para publicação do PR/,
    );
    await clickButton('Confirmar publicação do PR');
    assert.equal(savedPayloads.length, 2);
    assert.equal(savedPayloads[1]?.confirmPublish, true);
    assert.match(panel.textContent ?? '', /Publicação confirmada/);

    // Restaurar rascunho da Etapa 1 recompõe título, descrição e branch base originais.
    await clickButton('Restaurar rascunho da Etapa 1');
    assert.equal(titleInput.value, 'feat(auth): renovar token JWT expirado');
    assert.equal(baseBranchInput.value, 'main');
    assert.equal(draftCheckbox.checked, false);
    assert.equal(jiraCheckbox.checked, true);
  } finally {
    await act(() => root.unmount());
  }
});

test('FactoryFlowRoadmapModal + FactoryFlowPrPanel exibem bloqueio de secret scanning, PR publicado e reenvio ao Jira', async context => {
  const window = parseHTML('<!doctype html><html><body><div id="pr-publish-root"></div></body></html>');
  const { document } = window;
  const originalFetch = globalThis.fetch;
  const overrides: Array<[object, string, unknown]> = [
    [globalThis, 'window', window],
    [globalThis, 'document', document],
    [globalThis, 'HTMLElement', window.HTMLElement],
    [globalThis, 'IS_REACT_ACT_ENVIRONMENT', true],
    [window.HTMLElement.prototype, 'showModal', function (this: HTMLElement) {
      this.setAttribute('open', '');
    }],
    [window.HTMLElement.prototype, 'close', function (this: HTMLElement) {
      this.removeAttribute('open');
    }],
    [window.HTMLElement.prototype, 'attachEvent', () => undefined],
    [window.HTMLElement.prototype, 'detachEvent', () => undefined],
  ];
  for (const [target, name, value] of overrides) {
    const original = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, value, writable: true });
    context.after(() => {
      if (original) {
        Object.defineProperty(target, name, original);
      } else {
        Reflect.deleteProperty(target, name);
      }
    });
  }
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  context.mock.method(window.HTMLElement.prototype, 'focus', () => undefined);

  const flowId = '22222222-2222-4222-8222-222222222222';
  const prArtifactId = 'dddddddd-3333-4333-8333-333333333307';
  const confirmedReview = {
    prArtifactId,
    title: 'feat(auth): publicar entrega segura',
    description: '## Resumo\nEntrega validada.',
    baseBranch: 'main',
    draft: false,
    reviewers: ['alice'],
    updateJira: true,
    confirmedForPublish: true,
    confirmedAt: '2026-11-22T12:05:00.000Z',
    updatedAt: '2026-11-22T12:05:00.000Z',
  };
  let currentFlow = createFlow({
    id: flowId,
    title: 'AUTH-202 · Publicação do PR',
    currentStage: 'pr',
    state: 'waiting_action',
    currentSessionId: null,
    iteration: 1,
    lastReviewVerdict: 'approved',
    worktreePath: '/tmp/worktree-auth-202',
    branchName: 'factory/auth-202',
    baseBranch: 'main',
    prReview: confirmedReview,
    createdAt: '2026-11-22T11:50:00.000Z',
    updatedAt: '2026-11-22T12:05:00.000Z',
    transitions: [
      {
        from: 'queued',
        to: 'running',
        stage: 'triage',
        at: '2026-11-22T11:50:00.000Z',
        reason: 'Fluxo iniciado',
      },
      {
        from: 'running',
        to: 'waiting_action',
        stage: 'pr',
        at: '2026-11-22T12:05:00.000Z',
        reason: 'Rascunho do PR preparado',
      },
    ],
  });

  const makeDetails = (): FactoryFlowDetails => ({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow: currentFlow,
    stages: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: 'cccccccc-4444-4444-8444-444444444406',
        flowId,
        name: 'pr',
        state: currentFlow.state === 'completed' ? 'completed' : 'waiting_action',
        sessionId: null,
        reportPath: '/tmp/artifacts/pr-summary.md',
        sessionPath: null,
        createdAt: '2026-11-22T11:55:00.000Z',
        updatedAt: currentFlow.updatedAt,
        startedAt: '2026-11-22T11:55:00.000Z',
        finishedAt: currentFlow.finishedAt,
        error: null,
      },
    ],
    artifacts: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: prArtifactId,
        flowId,
        stage: 'pr',
        sessionId: null,
        kind: 'pr_summary',
        format: 'markdown',
        path: '/tmp/artifacts/pr-summary.md',
        status: 'ready',
        iteration: 1,
        createdAt: '2026-11-22T11:59:00.000Z',
        updatedAt: '2026-11-22T11:59:00.000Z',
        error: null,
      },
    ],
    worktreePath: currentFlow.worktreePath,
    branchName: currentFlow.branchName,
    baseBranch: currentFlow.baseBranch,
    checkpoints: [],
    prGate: {
      prArtifactId,
      prReportPath: '/tmp/artifacts/pr-summary.md',
      iteration: 1,
      title: confirmedReview.title,
      description: confirmedReview.description,
      summary: 'Entrega validada.',
      baseBranch: 'main',
      headBranch: 'factory/auth-202',
      draft: false,
      reviewers: ['alice'],
      updateJira: true,
      confirmedForPublish: true,
      confirmedAt: confirmedReview.confirmedAt,
      updatedAt: confirmedReview.updatedAt,
      draftTitle: confirmedReview.title,
      draftDescription: confirmedReview.description,
      draftBaseBranch: 'main',
      satisfiedAcceptanceCriteriaIds: ['CA1'],
      evidence: ['npm test (exitCode 0)'],
      jiraContext: { key: 'AUTH-202', url: 'https://empresa.atlassian.net/browse/AUTH-202' },
      prPublication: currentFlow.prPublication ?? null,
    },
  });

  globalThis.fetch = (() => Promise.resolve(Response.json(makeDetails()))) as typeof fetch;

  const container = document.getElementById('pr-publish-root');
  assert(container);
  const root = createRoot(container);

  const visiblePanel = () => {
    const panel = container.querySelector('[role="tabpanel"]:not([hidden])');
    assert(panel);
    return panel;
  };

  const clickButton = async (label: string, within: ParentNode = visiblePanel()) => {
    const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      item => item.textContent?.trim().startsWith(label),
    );
    assert(button, `Botão ausente: ${label}`);
    await act(async () => {
      button.click();
    });
  };

  let publishCount = 0;
  let retryCount = 0;

  try {
    const renderModal = async () => {
      await act(async () => {
        root.render(
          createElement(FactoryFlowRoadmapModal, {
            flow: currentFlow,
            initialDetails: makeDetails(),
            onClose: noop,
                  onAdvanceFlowStage: noopAsync,
            onRerunFlowStage: noopAsync,
            onSavePrReview: async () => {
              throw new Error('não esperado');
            },
            onPublishPr: async () => {
              publishCount += 1;
              if (publishCount === 1) {
                currentFlow = {
                  ...currentFlow,
                  prPublication: {
                    prArtifactId,
                    status: 'blocked_by_secrets',
                    provider: null,
                    prUrl: null,
                    prNumber: null,
                    commitSha: null,
                    headBranch: 'factory/auth-202',
                    baseBranch: 'main',
                    draft: false,
                    publishedAt: null,
                    secretFindings: [
                      {
                        file: 'src/auth.ts',
                        line: 14,
                        rule: 'Token de provedor conhecido',
                        snippet: 'const token = "[REDACTED]"',
                      },
                    ],
                    jiraSync: {
                      status: 'not_requested',
                      issueKey: 'AUTH-202',
                      updatedAt: null,
                      error: null,
                    },
                    error: 'Publicação abortada pelo secret scanning: src/auth.ts:14',
                    updatedAt: '2026-11-22T12:06:00.000Z',
                  },
                };
                throw new Error('Publicação abortada pelo secret scanning: src/auth.ts:14');
              }

              const published = {
                prArtifactId,
                status: 'published' as const,
                provider: 'github' as const,
                prUrl: 'https://github.com/org/repo/pull/88',
                prNumber: 88,
                commitSha: 'a1b2c3d4e5f6789012345678901234567890abcd',
                headBranch: 'factory/auth-202',
                baseBranch: 'main',
                draft: false,
                publishedAt: '2026-11-22T12:08:00.000Z',
                secretFindings: [],
                jiraSync: {
                  status: 'failed' as const,
                  issueKey: 'AUTH-202',
                  updatedAt: '2026-11-22T12:08:00.000Z',
                  error: 'Jira retornou HTTP 503',
                },
                error: null,
                updatedAt: '2026-11-22T12:08:00.000Z',
              };
              currentFlow = {
                ...currentFlow,
                state: 'completed',
                worktreePath: null,
                finishedAt: '2026-11-22T12:08:00.000Z',
                updatedAt: '2026-11-22T12:08:00.000Z',
                transitions: [
                  ...currentFlow.transitions,
                  {
                    from: 'waiting_action',
                    to: 'completed',
                    stage: 'pr',
                    at: '2026-11-22T12:08:00.000Z',
                    reason: 'PR publicado',
                  },
                ],
                prPublication: published,
              };
              const details = makeDetails();
              assert(details.prGate);
              return {
                contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
                flow: currentFlow,
                prGate: details.prGate,
                publication: published,
              };
            },
            onRetryPrJiraSync: async () => {
              retryCount += 1;
              assert(currentFlow.prPublication);
              const synced = {
                ...currentFlow.prPublication,
                jiraSync: {
                  status: 'updated' as const,
                  issueKey: 'AUTH-202',
                  updatedAt: '2026-11-22T12:09:00.000Z',
                  error: null,
                },
                updatedAt: '2026-11-22T12:09:00.000Z',
              };
              currentFlow = {
                ...currentFlow,
                prPublication: synced,
              };
              const details = makeDetails();
              assert(details.prGate);
              return {
                contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
                flow: currentFlow,
                prGate: details.prGate,
                publication: synced,
              };
            },
            onViewMarkdown: noop,
          }),
        );
      });
    };

    const flushDetailsFetch = async () => {
      await act(async () => {
        await new Promise(resolve => {
          setTimeout(resolve, 0);
        });
      });
    };

    await renderModal();
    await flushDetailsFetch();
    await clickButton('Revisar e publicar PR');

    // 1. Tentativa bloqueada pelo secret scanning exibe arquivo e linha suspeitos.
    await clickButton('Publicar Pull Request');
    await flushDetailsFetch();
    const blockedPanel = visiblePanel();
    assert.match(blockedPanel.textContent ?? '', /Publicação bloqueada pelo secret scanning/);
    assert.match(blockedPanel.textContent ?? '', /src\/auth\.ts:14/);

    // 2. Segunda tentativa publica PR, preserva URL e permite reenviar ao Jira após falha.
    await clickButton('Publicar Pull Request');
    await renderModal();
    await flushDetailsFetch();
    const publishedPanel = visiblePanel();
    assert.match(publishedPanel.textContent ?? '', /Pull Request publicado #88/);
    assert.match(publishedPanel.textContent ?? '', /PR preservado, mas falhou ao comentar no Jira/);
    assert.equal(
      publishedPanel.querySelector('a[href="https://github.com/org/repo/pull/88"]')?.textContent,
      'Abrir Pull Request',
    );

    // 3. Reenvio ao Jira atualiza o status sem perder o PR.
    await clickButton('Reenviar comentário ao Jira');
    await renderModal();
    await flushDetailsFetch();
    const syncedPanel = visiblePanel();
    assert.equal(publishCount, 2);
    assert.equal(retryCount, 1);
    assert.match(syncedPanel.textContent ?? '', /Comentário com link do PR e resumo das evidências publicado no card AUTH-202/);
  } finally {
    await act(() => root.unmount());
  }
});

test('FactoryPage renderiza estados carregando, erro, vazio e populado na aba Métricas da Factory', () => {
  const makeMetricsController = (
    state: FactoryMetricsController['state'],
    overrides: Partial<FactoryMetricsController> = {},
  ): FactoryMetricsController => ({
    state,
    repoPathFilter: '',
    periodFilter: 'all',
    setRepoPathFilter: noop,
    setPeriodFilter: noop,
    refresh: noop,
    ...overrides,
  });

  // 1. Estado carregando.
  const loadingHtml = renderFactoryPage({
    initialSection: 'metrics',
    metrics: makeMetricsController({ status: 'loading' }),
  });
  assert.match(loadingHtml, /Carregando métricas da Factory/);
  assert.match(loadingHtml, /aria-selected="true"[^>]*>.*Métricas da Factory/);

  // 2. Estado de falha.
  const errorHtml = renderFactoryPage({
    initialSection: 'metrics',
    metrics: makeMetricsController({
      status: 'failed',
      message: 'Falha ao consultar telemetria.',
    }),
  });
  assert.match(errorHtml, /role="alert"[^>]*>.*Falha ao consultar telemetria\./);
  assert.match(errorHtml, /Tentar novamente/);

  // 3. Estado vazio (sem fluxos no período).
  const emptyData: FactoryMetricsResponse = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    generatedAt: '2026-11-22T12:00:00.000Z',
    filters: { repoPath: null, period: 'all', from: null, to: null },
    availableRepos: [],
    summary: {
      totalFlows: 0,
      completedFlows: 0,
      cancelledFlows: 0,
      failedFlows: 0,
      activeFlows: 0,
      openedPrs: 0,
      averageFlowLeadTimeMs: null,
    },
    stageLeadTimes: FACTORY_STAGE_ORDER.map(stage => ({
      stage,
      completedCount: 0,
      partialCount: 0,
      averageDurationMs: null,
      minDurationMs: null,
      maxDurationMs: null,
    })),
    firstCycleReview: {
      evaluatedFlows: 0,
      approvedFirstCycle: 0,
      rejectedFirstCycle: 0,
      approvalRatePercent: null,
    },
    rejectionReasons: [],
    byRepository: [],
  };
  const emptyHtml = renderFactoryPage({
    initialSection: 'metrics',
    metrics: makeMetricsController({ status: 'loaded', data: emptyData }),
  });
  assert.match(emptyHtml, /Nenhuma etapa concluída com timestamps completos neste recorte/);
  assert.match(emptyHtml, /Nenhum fluxo avaliado no Bloco 05 neste período/);
  assert.match(emptyHtml, /Nenhuma reprovação registrada no Bloco 05 neste período/);
  assert.match(emptyHtml, /Nenhum fluxo registrado para os filtros selecionados/);

  // 4. Estado populado.
  const populatedData: FactoryMetricsResponse = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    generatedAt: '2026-11-22T12:00:00.000Z',
    filters: { repoPath: null, period: '30d', from: '2026-10-23T12:00:00.000Z', to: null },
    availableRepos: ['/home/dev/repos/api-core', '/home/dev/repos/web-app'],
    summary: {
      totalFlows: 5,
      completedFlows: 3,
      cancelledFlows: 1,
      failedFlows: 0,
      activeFlows: 1,
      openedPrs: 2,
      averageFlowLeadTimeMs: 125_000,
    },
    stageLeadTimes: [
      { stage: 'triage', completedCount: 5, partialCount: 0, averageDurationMs: 15_000, minDurationMs: 10_000, maxDurationMs: 20_000 },
      { stage: 'planning', completedCount: 4, partialCount: 0, averageDurationMs: 30_000, minDurationMs: 20_000, maxDurationMs: 40_000 },
      { stage: 'development', completedCount: 3, partialCount: 1, averageDurationMs: 65_000, minDurationMs: 45_000, maxDurationMs: 90_000 },
      { stage: 'tests', completedCount: 3, partialCount: 0, averageDurationMs: 20_000, minDurationMs: 15_000, maxDurationMs: 25_000 },
      { stage: 'review', completedCount: 3, partialCount: 0, averageDurationMs: 18_000, minDurationMs: 12_000, maxDurationMs: 24_000 },
      { stage: 'pr', completedCount: 2, partialCount: 0, averageDurationMs: 8_000, minDurationMs: 5_000, maxDurationMs: 11_000 },
    ],
    firstCycleReview: {
      evaluatedFlows: 4,
      approvedFirstCycle: 3,
      rejectedFirstCycle: 1,
      approvalRatePercent: 75,
    },
    rejectionReasons: [
      { reason: 'cobertura', count: 3, flowCount: 2 },
      { reason: 'regressao', count: 1, flowCount: 1 },
    ],
    byRepository: [
      {
        repoPath: '/home/dev/repos/api-core',
        totalFlows: 3,
        completedFlows: 2,
        cancelledFlows: 1,
        failedFlows: 0,
        activeFlows: 0,
        openedPrs: 2,
        firstCycleApprovalRatePercent: 66.7,
      },
      {
        repoPath: '/home/dev/repos/web-app',
        totalFlows: 2,
        completedFlows: 1,
        cancelledFlows: 0,
        failedFlows: 0,
        activeFlows: 1,
        openedPrs: 0,
        firstCycleApprovalRatePercent: 100,
      },
    ],
  };
  const populatedHtml = renderFactoryPage({
    initialSection: 'metrics',
    metrics: makeMetricsController(
      { status: 'loaded', data: populatedData },
      { periodFilter: '30d' },
    ),
  });
  assert.match(populatedHtml, /01 · Triagem/);
  assert.match(populatedHtml, /03 · Desenvolvimento/);
  assert.match(populatedHtml, /1m 5s/);
  assert.match(populatedHtml, /1 parcial/);
  assert.match(populatedHtml, /75%/);
  assert.match(populatedHtml, /3 de 4 avaliados/);
  assert.match(populatedHtml, /#1<\/span>cobertura/);
  assert.match(populatedHtml, /3 ocorrências · 2 fluxos/);
  assert.match(populatedHtml, /api-core/);
  assert.match(populatedHtml, /66\.7%/);
});

test('FactoryPage alterna para a aba de métricas e aplica filtros de repositório e período via useFactoryMetrics', async context => {
  const window = parseHTML('<html><body><div id="metrics-root"></div></body></html>');
  const { document } = window;
  const overrides: Array<[object, string, unknown]> = [
    [globalThis, 'window', window],
    [globalThis, 'document', document],
    [globalThis, 'IS_REACT_ACT_ENVIRONMENT', true],
    [window.HTMLElement.prototype, 'attachEvent', () => undefined],
    [window.HTMLElement.prototype, 'detachEvent', () => undefined],
  ];
  for (const [target, name, value] of overrides) {
    const original = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, value, writable: true });
    context.after(() => {
      if (original) {
        Object.defineProperty(target, name, original);
      } else {
        Reflect.deleteProperty(target, name);
      }
    });
  }

  const seenUrls: string[] = [];
  context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seenUrls.push(rawUrl);
    const parsed = new URL(rawUrl);
    const selectedRepo = parsed.searchParams.get('repoPath');
    const selectedPeriod = (parsed.searchParams.get('period') ?? 'all') as FactoryMetricsResponse['filters']['period'];
    const isAlpha = selectedRepo === '/home/dev/repos/api-core';

    const payload: FactoryMetricsResponse = {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      generatedAt: '2026-11-22T12:00:00.000Z',
      filters: { repoPath: selectedRepo, period: selectedPeriod, from: null, to: null },
      availableRepos: ['/home/dev/repos/api-core', '/home/dev/repos/web-app'],
      summary: {
        totalFlows: isAlpha ? 2 : 3,
        completedFlows: isAlpha ? 2 : 2,
        cancelledFlows: isAlpha ? 0 : 1,
        failedFlows: 0,
        activeFlows: 0,
        openedPrs: isAlpha ? 2 : 2,
        averageFlowLeadTimeMs: 42_000,
      },
      stageLeadTimes: FACTORY_STAGE_ORDER.map(stage => ({
        stage,
        completedCount: isAlpha ? 2 : 3,
        partialCount: 0,
        averageDurationMs: 12_000,
        minDurationMs: 10_000,
        maxDurationMs: 14_000,
      })),
      firstCycleReview: {
        evaluatedFlows: isAlpha ? 2 : 3,
        approvedFirstCycle: isAlpha ? 2 : 2,
        rejectedFirstCycle: isAlpha ? 0 : 1,
        approvalRatePercent: isAlpha ? 100 : 66.7,
      },
      rejectionReasons: isAlpha ? [] : [{ reason: 'cobertura', count: 1, flowCount: 1 }],
      byRepository: [
        {
          repoPath: '/home/dev/repos/api-core',
          totalFlows: 2,
          completedFlows: 2,
          cancelledFlows: 0,
          failedFlows: 0,
          activeFlows: 0,
          openedPrs: 2,
          firstCycleApprovalRatePercent: 100,
        },
        ...(isAlpha
          ? []
          : [
              {
                repoPath: '/home/dev/repos/web-app',
                totalFlows: 1,
                completedFlows: 0,
                cancelledFlows: 1,
                failedFlows: 0,
                activeFlows: 0,
                openedPrs: 0,
                firstCycleApprovalRatePercent: 0,
              },
            ]),
      ],
    };
    return Promise.resolve(Response.json(payload));
  });

  function Harness() {
    const metrics = useFactoryMetrics();
    return factoryPageElement({ metrics });
  }

  const container = document.getElementById('metrics-root');
  assert(container);
  const root = createRoot(container);

  const flush = async () => {
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
  };

  try {
    await act(async () => {
      root.render(createElement(Harness));
    });
    await flush();

    // Clica na aba "Métricas da Factory".
    const metricsTab = Array.from(container.querySelectorAll('button[role="tab"]')).find(button =>
      button.textContent?.includes('Métricas da Factory'),
    );
    assert(metricsTab);
    await act(async () => {
      (metricsTab as HTMLButtonElement).click();
    });
    assert.match(container.textContent ?? '', /66\.7%/);
    assert.match(container.textContent ?? '', /cobertura/);

    // Filtra por repositório específico e período 7d.
    const repoSelect = container.querySelector('select[id$="-repo"]') as HTMLSelectElement | null;
    const periodSelect = container.querySelector('select[id$="-period"]') as HTMLSelectElement | null;
    assert(repoSelect);
    assert(periodSelect);

    await act(async () => {
      Object.defineProperty(repoSelect, 'value', {
        configurable: true,
        value: '/home/dev/repos/api-core',
      });
      repoSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flush();

    await act(async () => {
      Object.defineProperty(periodSelect, 'value', {
        configurable: true,
        value: '7d',
      });
      periodSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flush();

    assert.match(seenUrls.at(-1) ?? '', /repoPath=%2Fhome%2Fdev%2Frepos%2Fapi-core/);
    assert.match(seenUrls.at(-1) ?? '', /period=7d/);
    assert.match(container.textContent ?? '', /100%/);
    assert.match(container.textContent ?? '', /Nenhuma reprovação registrada no Bloco 05 neste período/);
  } finally {
    await act(() => root.unmount());
  }
});
