import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_MAX_AUTO_ITERATIONS,
  FACTORY_STAGE_ORDER,
} from '@development-factory/shared';
import type { FactoryFlow, FactoryFlowDetails } from '@development-factory/shared';
import { FactoryFlowRoadmapModal } from '../src/components/FactoryFlowRoadmapModal';
import { createPlanningGateDrafts } from '../src/components/FactoryPlanningGatePanel';

const noop = () => undefined;
const noopAsync = async () => undefined;

function createFlow(overrides: Partial<FactoryFlow> = {}): FactoryFlow {
  return {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: '22222222-2222-4222-8222-222222222222',
    title: 'FLOW-20 · Triagem e Planejamento não interativos',
    target: {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      inputType: 'jira_key',
      value: 'FLOW-20',
      repoPath: '/home/dev/repos/app-alvo',
    },
    currentStage: 'triage',
    state: 'waiting_action',
    currentSessionId: null,
    iteration: 0,
    maxIterations: FACTORY_MAX_AUTO_ITERATIONS,
    lastReviewVerdict: null,
    loopPausedReason: null,
    worktreePath: '/home/dev/.local/share/development-factory/worktrees/flow-20',
    branchName: 'factory/flow-20',
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
  return FACTORY_STAGE_ORDER.map((name, index) => ({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    id: `33333333-3333-4333-8333-33333333330${index + 1}`,
    flowId: flow.id,
    name,
    state: name === flow.currentStage ? 'waiting_action' : 'pending',
    sessionId: null,
    reportPath: name === 'triage' ? '/tmp/artifacts/triage.md' : null,
    sessionPath: null,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    startedAt: name === 'triage' ? flow.createdAt : null,
    finishedAt: null,
    error: null,
  }));
}

test('Fase 2.4 (UI): Triagem não exibe perguntas interativas nem controles de passagem manual', () => {
  const flow = createFlow({
    currentStage: 'triage',
    state: 'waiting_action',
    loopPausedReason: 'Triagem interrompida por falha na consulta ao Jira MCP: 401 Unauthorized',
  });
  const initialDetails: FactoryFlowDetails = {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    flow,
    stages: createStages(flow),
    artifacts: [
      {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: '44444444-4444-4444-8444-444444444441',
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
      blockers: ['Lacuna investigável encaminhada ao Planejamento.'],
    },
  };

  const html = renderToStaticMarkup(
    createElement(FactoryFlowRoadmapModal, {
      flow,
      initialDetails,
      onClose: noop,
      onAdvanceFlowStage: noopAsync,
      onRerunFlowStage: noopAsync,
      onViewMarkdown: noop,
    }),
  );

  assert.doesNotMatch(html, /Portão humano · Ação necessária/);
  assert.doesNotMatch(html, /Respostas aos bloqueadores/);
  assert.doesNotMatch(html, /Enviar respostas e avançar/);
  assert.doesNotMatch(html, /Avançar para Planejamento/);
  assert.doesNotMatch(html, /Lacuna investigável encaminhada ao Planejamento\./);
  assert.match(html, /Falha na consulta ao Jira MCP/);
  assert.match(html, /401 Unauthorized/);
  assert.match(html, />Reexecutar</);
  assert.match(html, />Ver artefato</);
});

test('Fase 2.3 (UI): createPlanningGateDrafts preserva IDs explícitos do sidecar e mantém fallback D1/D2 para artefatos legados', () => {
  const withExplicitIds = createPlanningGateDrafts(
    {
      pendingDecisions: [
        {
          id: 'P1',
          question: 'Política de retry do parceiro?',
          options: ['Backoff exponencial', 'DLQ'],
          recommendedOption: 'Backoff exponencial',
          checksPerformed: ['Leitura do cliente HTTP local.'],
          unresolvableReason: 'Requer ambiente de staging.',
        },
      ],
      acceptanceCriteria: [{ id: 'CA1', description: 'Tratar 429.' }],
    },
    null,
  );
  assert.equal(withExplicitIds.decisions[0]?.id, 'P1');

  const legacyWithoutIds = createPlanningGateDrafts(
    {
      pendingDecisions: [
        {
          question: 'Timeout padrão?',
          options: ['5s', '10s'],
          recommendedOption: '5s',
        },
        {
          question: 'Cache local?',
          options: ['Sim', 'Não'],
          recommendedOption: 'Sim',
        },
      ],
      acceptanceCriteria: [],
    },
    null,
  );
  assert.equal(legacyWithoutIds.decisions[0]?.id, 'D1');
  assert.equal(legacyWithoutIds.decisions[1]?.id, 'D2');
});
