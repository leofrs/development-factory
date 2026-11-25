import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FactoryFlowApiErrorResponseSchema,
  FactoryFlowDetailsSchema,
  FactoryPreflightResponseSchema,
  PublishFactoryPrResponseSchema,
  SaveFactoryPrReviewResponseSchema,
  evaluateFactoryTriageGate,
} from '@development-factory/shared';
import type { FactoryFlowDetails, FactoryTriageSidecar } from '@development-factory/shared';
import { buildPrRunnerArgs } from '../src/factory-pr.js';
import { runFactoryPreflight } from '../src/factory-preflight.js';
import {
  FactoryRepositoryProfileError,
  loadFactoryRepositoryProfile,
} from '../src/factory-repository-profile.js';
import { buildTriageAndPlanningRunnerArgs } from '../src/factory-stage-runners.js';
import { buildTestsRunnerArgs } from '../src/factory-tests.js';
import { provisionFactoryWorktree } from '../src/factory-worktree.js';
import { buildFactoryArchitecturePrompt } from '../src/prompts/factory-architecture.js';
import {
  IMPLEMENTATION_REPORT_SECTIONS,
  IMPLEMENTATION_REPORT_TITLE,
} from '../src/prompts/factory-development.js';
import { PR_SUMMARY_SECTIONS, PR_SUMMARY_TITLE } from '../src/prompts/factory-pr.js';
import {
  REVIEW_REPORT_SECTIONS,
  REVIEW_REPORT_TITLE,
  REVIEW_VERDICT_LABELS,
} from '../src/prompts/factory-review.js';
import { TEST_REPORT_SECTIONS, TEST_REPORT_TITLE } from '../src/prompts/factory-tests.js';
import { createReviewServer } from '../src/server.js';
import {
  planningMarkdown,
  sidecarFixtures,
  triageMarkdown,
  writeFactoryStageSidecar,
} from './fixtures/factory-stage-artifacts.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

function initGitRepo(repoDir: string, branch = 'main'): void {
  execFileSync('git', ['init', '-b', branch], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  writeFileSync(join(repoDir, '.gitignore'), '.env.local\nlocal-dev.sqlite\n');
  writeFileSync(join(repoDir, 'README.md'), '# Repo\n');
  execFileSync('git', ['add', '.gitignore', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
}

async function waitFor<T>(
  probe: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let current = await probe();
  while (!predicate(current)) {
    if (Date.now() > deadline) {
      throw new Error(`Tempo limite excedido aguardando: ${label}`);
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
    current = await probe();
  }
  return current;
}

interface TestHarness {
  readonly rootDir: string;
  readonly repoDir: string;
  readonly baseUrl: string;
  readonly server: ReturnType<typeof createReviewServer>;
  fetchFlowDetails(flowId: string): Promise<FactoryFlowDetails>;
}

async function createPhase1Harness(
  context: { after: (fn: () => Promise<void> | void) => void },
  options: {
    readonly prPublishDependencies?: Parameters<typeof createReviewServer>[0] extends infer O
      ? O extends { prPublishDependencies?: infer D }
        ? D
        : never
      : never;
  } = {},
): Promise<TestHarness> {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-phase1-mapping-'));
  const binDir = join(rootDir, 'bin');
  const repoDir = join(rootDir, 'repo');
  const xdgDataHome = join(rootDir, 'xdg-data');
  const dbPath = join(rootDir, 'reviews.db');
  mkdirSync(binDir);
  mkdirSync(repoDir);
  mkdirSync(xdgDataHome);
  initGitRepo(repoDir);

  const claudeTarget = join(binDir, 'claude');
  copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
  chmodSync(claudeTarget, 0o755);

  const previousPath = process.env.PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.XDG_DATA_HOME = xdgDataHome;

  const created = createReviewServer({
    dbPath,
    ...(options.prPublishDependencies
      ? { prPublishDependencies: options.prPublishDependencies }
      : {}),
  });
  created.server.listen(0, '127.0.0.1');
  await once(created.server, 'listening');

  const address = created.server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await created.shutdown();
    process.env.PATH = previousPath;
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  const fetchFlowDetails = async (flowId: string): Promise<FactoryFlowDetails> => {
    const response = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(response.status, 200);
    return FactoryFlowDetailsSchema.parse(await response.json());
  };

  return { rootDir, repoDir, baseUrl, server: created, fetchFlowDetails };
}

test(
  'Fase 1.1: caracteriza execução bem-sucedida de Triagem -> Planejamento e interrupção por ambiguidade ou falha do Jira',
  { timeout: 20000 },
  async context => {
    const harness = await createPhase1Harness(context);

    // 1) Execução bem-sucedida: Triagem sem bloqueadores/jiraError avança automaticamente para Planejamento.
    const createOkRes = await fetch(`${harness.baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'jira_key', value: 'FLOW-101', repoPath: harness.repoDir },
        startSession: true,
        cols: 120,
        rows: 36,
      }),
    });
    assert.equal(createOkRes.status, 201);
    const createdOk = (await createOkRes.json()) as {
      flow: { id: string; currentSessionId: string | null };
    };
    const okFlowId = createdOk.flow.id;
    assert.ok(createdOk.flow.currentSessionId);

    const triageSession = harness.server.sessionManager.getSession(createdOk.flow.currentSessionId);
    assert.ok(triageSession?.reportPath);
    writeFileSync(triageSession.reportPath, triageMarkdown('Quando o usuário salva, persiste corretamente.'));
    writeFactoryStageSidecar(triageSession.reportPath, 'triage', {
      blockers: [],
      jiraError: null,
      jiraContext: { key: 'FLOW-101', url: 'https://empresa.atlassian.net/browse/FLOW-101' },
    });
    harness.server.sessionManager.writeInput(triageSession.sessionId, 'EXIT0');

    // Aguarda auto-avanço para Planejamento com nova sessão ativa.
    const inPlanning = await waitFor(
      () => harness.fetchFlowDetails(okFlowId),
      details =>
        details.flow.currentStage === 'planning' &&
        details.flow.state === 'running' &&
        details.flow.currentSessionId !== null,
      'auto-avanço da Triagem para o Planejamento',
    );
    assert.equal(inPlanning.triageGate, undefined);
    assert.ok(inPlanning.flow.currentSessionId);

    const planningSession = harness.server.sessionManager.getSession(
      inPlanning.flow.currentSessionId,
    );
    assert.ok(planningSession?.reportPath);
    writeFileSync(planningSession.reportPath, planningMarkdown('Diagnóstico baseado no worktree.'));
    writeFactoryStageSidecar(planningSession.reportPath, 'planning', {
      pendingDecisions: [
        {
          question: 'Manter timeout padrão de 5s?',
          options: ['Manter 5s', 'Aumentar para 10s'],
          recommendedOption: 'Manter 5s',
        },
      ],
    });
    harness.server.sessionManager.writeInput(planningSession.sessionId, 'EXIT0');

    // Após concluir Planejamento, o fluxo estaciona em waiting_action aguardando aprovação.
    const planningWaiting = await waitFor(
      () => harness.fetchFlowDetails(okFlowId),
      details =>
        details.flow.currentStage === 'planning' &&
        details.flow.state === 'waiting_action' &&
        details.flow.currentSessionId === null,
      'conclusão do Planejamento em waiting_action',
    );
    assert.equal(planningWaiting.planningGate?.pendingDecisions.length, 1);
    assert.equal(planningWaiting.planningGate?.acceptanceCriteria.length, 1);

    // 2) Ambiguidade na Triagem: blockers não vazio pausa o fluxo no portão humano sem iniciar Planejamento.
    const createAmbiguousRes = await fetch(`${harness.baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'title', value: 'Ajustar cálculo de desconto', repoPath: harness.repoDir },
        startSession: true,
      }),
    });
    assert.equal(createAmbiguousRes.status, 201);
    const ambiguousCreated = (await createAmbiguousRes.json()) as {
      flow: { id: string; currentSessionId: string | null };
    };
    assert.ok(ambiguousCreated.flow.currentSessionId);
    const ambiguousSession = harness.server.sessionManager.getSession(
      ambiguousCreated.flow.currentSessionId,
    );
    assert.ok(ambiguousSession?.reportPath);
    writeFileSync(
      ambiguousSession.reportPath,
      `${triageMarkdown('Quando aplica cupom, o desconto precisa respeitar teto.')}#### 6. Bloqueadores e Ambiguidades (Ação Necessária)\n- Definir se o teto incide antes ou depois do frete.\n`,
    );
    writeFactoryStageSidecar(ambiguousSession.reportPath, 'triage', {
      blockers: ['Definir se o teto incide antes ou depois do frete.'],
      jiraError: null,
    });
    harness.server.sessionManager.writeInput(ambiguousSession.sessionId, 'EXIT0');

    const ambiguousPaused = await waitFor(
      () => harness.fetchFlowDetails(ambiguousCreated.flow.id),
      details =>
        details.flow.currentStage === 'triage' &&
        details.flow.state === 'waiting_action' &&
        details.flow.currentSessionId === null,
      'pausa da Triagem por ambiguidade',
    );
    assert.equal(ambiguousPaused.triageGate?.blocked, true);
    assert.deepEqual(ambiguousPaused.triageGate?.blockers, [
      'Definir se o teto incide antes ou depois do frete.',
    ]);
    assert.equal(ambiguousPaused.triageGate?.jiraError, null);
    assert.match(ambiguousPaused.flow.loopPausedReason ?? '', /bloqueador\/ambiguidade/i);

    // 3) Falha do Jira na Triagem: jiraError preenchido pausa o fluxo no portão humano sem iniciar Planejamento.
    const createJiraFailRes = await fetch(`${harness.baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'jira_key', value: 'FLOW-404', repoPath: harness.repoDir },
        startSession: true,
      }),
    });
    assert.equal(createJiraFailRes.status, 201);
    const jiraFailCreated = (await createJiraFailRes.json()) as {
      flow: { id: string; currentSessionId: string | null };
    };
    assert.ok(jiraFailCreated.flow.currentSessionId);
    const jiraFailSession = harness.server.sessionManager.getSession(
      jiraFailCreated.flow.currentSessionId,
    );
    assert.ok(jiraFailSession?.reportPath);
    writeFileSync(
      jiraFailSession.reportPath,
      `${triageMarkdown('Quando busca FLOW-404, o Jira retorna 401.')}#### 6. Bloqueadores e Ambiguidades (Ação Necessária)\n- Jira indisponível para leitura.\n`,
    );
    const jiraFailSidecar: Partial<FactoryTriageSidecar> = {
      blockers: [],
      jiraError: 'MCP Atlassian indisponível (401 Unauthorized)',
    };
    writeFactoryStageSidecar(jiraFailSession.reportPath, 'triage', jiraFailSidecar);
    assert.equal(
      evaluateFactoryTriageGate({ ...sidecarFixtures.triage, ...jiraFailSidecar }).blocked,
      true,
    );
    harness.server.sessionManager.writeInput(jiraFailSession.sessionId, 'EXIT0');

    const jiraFailPaused = await waitFor(
      () => harness.fetchFlowDetails(jiraFailCreated.flow.id),
      details =>
        details.flow.currentStage === 'triage' &&
        details.flow.state === 'waiting_action' &&
        details.flow.currentSessionId === null,
      'pausa da Triagem por falha no Jira',
    );
    assert.equal(jiraFailPaused.triageGate?.blocked, true);
    assert.equal(
      jiraFailPaused.triageGate?.jiraError,
      'MCP Atlassian indisponível (401 Unauthorized)',
    );
    assert.match(jiraFailPaused.flow.loopPausedReason ?? '', /Jira MCP/i);
  },
);

test(
  'Fase 1.2: caracteriza aprovação com pendências, contratos de avanço e caminho de preparação e publicação do PR',
  { timeout: 20000 },
  async context => {
    const harness = await createPhase1Harness(context, {
      prPublishDependencies: {
        scanSecrets: async () => [],
        commitAndPush: async () => ({
          commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
          createdCommit: false,
        }),
        createPullRequest: async () => ({
          provider: 'github',
          prUrl: 'https://github.com/org/repo/pull/42',
          prNumber: 42,
        }),
      },
    });
    const { factoryFlowService } = harness.server;

    // Cria fluxo e prepara artefatos válidos de Triagem e Planejamento com pendência D1.
    const created = await factoryFlowService.createFlow({
      task: { inputType: 'jira_key', value: 'FLOW-202', repoPath: harness.repoDir },
    });
    const flowId = created.flow.id;
    const provisioned = await provisionFactoryWorktree({
      repoPath: harness.repoDir,
      flowId,
      target: created.flow.target,
    });
    await factoryFlowService.updateWorktreeMetadata(flowId, {
      worktreePath: provisioned.worktreePath,
      branchName: provisioned.branchName,
      baseBranch: provisioned.baseBranch,
    });

    const artifactsDir = join(harness.rootDir, 'artifacts');
    mkdirSync(artifactsDir);

    const triagePath = join(artifactsDir, 'triage.md');
    writeFileSync(triagePath, triageMarkdown('Quando inicia checkout, valida estoque.'));
    writeFactoryStageSidecar(triagePath, 'triage', {
      acceptanceCriteria: [{ id: 'CA1', description: 'Validar estoque antes de reservar.' }],
      jiraContext: { key: 'FLOW-202', url: 'https://empresa.atlassian.net/browse/FLOW-202' },
    });
    await factoryFlowService.registerArtifact(
      flowId,
      {
        stage: 'triage',
        kind: 'specification',
        format: 'markdown',
        path: triagePath,
        status: 'ready',
      },
      { reportPath: triagePath },
    );
    await factoryFlowService.transitionFlow(flowId, {
      to: 'waiting_action',
      stage: 'triage',
      reason: 'Triagem concluída',
    });
    await factoryFlowService.advanceStage(flowId, { reason: 'Avanço para Planejamento' });

    const planningPath = join(artifactsDir, 'planning.md');
    writeFileSync(planningPath, planningMarkdown('Validar reserva no serviço de pedidos.'));
    writeFactoryStageSidecar(planningPath, 'planning', {
      pendingDecisions: [
        {
          question: 'Qual estratégia de lock usar?',
          options: ['Lock otimista por versão', 'Lock pessimista SELECT FOR UPDATE'],
          recommendedOption: 'Lock otimista por versão',
        },
      ],
    });
    await factoryFlowService.registerArtifact(
      flowId,
      {
        stage: 'planning',
        kind: 'plan',
        format: 'markdown',
        path: planningPath,
        status: 'ready',
      },
      { reportPath: planningPath },
    );
    await factoryFlowService.transitionFlow(flowId, {
      to: 'waiting_action',
      stage: 'planning',
      reason: 'Planejamento concluído',
    });

    // Verifica que planningGate chega em GET /api/factory/flows/:id.
    const beforeApprove = await harness.fetchFlowDetails(flowId);
    assert.equal(beforeApprove.planningGate?.pendingDecisions.length, 1);
    assert.equal(beforeApprove.planningGate?.acceptanceCriteria[0]?.id, 'CA1');

    // Tentar enviar planningApproval sem responder D1 retorna 400 FACTORY_FLOW_INVALID_INPUT.
    const missingDecisionRes = await fetch(`${harness.baseUrl}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planningApproval: {
          decisions: [],
          acceptanceCriteria: [
            { id: 'CA1', description: 'Validar estoque antes de reservar.', approved: true },
          ],
        },
      }),
    });
    assert.equal(missingDecisionRes.status, 400);
    const missingDecisionErr = FactoryFlowApiErrorResponseSchema.parse(
      await missingDecisionRes.json(),
    );
    assert.equal(missingDecisionErr.error.code, 'FACTORY_FLOW_INVALID_INPUT');
    assert.match(missingDecisionErr.error.message, /D1/);

    // Aprovar respondendo D1 persiste planningApproval no fluxo e approvedNotes na etapa development.
    const approveRes = await fetch(`${harness.baseUrl}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planningApproval: {
          decisions: [
            {
              id: 'D1',
              question: 'Qual estratégia de lock usar?',
              mode: 'alternative',
              selectedOption: 'Lock pessimista SELECT FOR UPDATE',
              recommendedOption: 'Lock otimista por versão',
            },
          ],
          acceptanceCriteria: [
            { id: 'CA1', description: 'Validar estoque antes de reservar.', approved: true },
          ],
          notes: 'Aplicar timeout curto na transação.',
        },
      }),
    });
    assert.equal(approveRes.status, 200);
    const afterApprove = await harness.fetchFlowDetails(flowId);
    assert.equal(afterApprove.flow.currentStage, 'development');
    assert.equal(afterApprove.flow.state, 'waiting_action');
    assert.equal(afterApprove.flow.iteration, 1);
    assert.equal(
      afterApprove.flow.planningApproval?.decisions[0]?.selectedOption,
      'Lock pessimista SELECT FOR UPDATE',
    );
    const devStage = afterApprove.stages.find(stage => stage.name === 'development');
    assert.equal(devStage?.approvedNotes, 'Aplicar timeout curto na transação.');

    // Caracteriza o caminho atual de preparação e publicação (Etapas 03 -> 04 -> 05 -> 06 PR).
    const devPath = join(artifactsDir, 'development.md');
    writeFileSync(
      devPath,
      [
        `# ${IMPLEMENTATION_REPORT_TITLE}`,
        `## ${IMPLEMENTATION_REPORT_SECTIONS.changedFiles}`,
        '- src/feature.ts',
        `## ${IMPLEMENTATION_REPORT_SECTIONS.summary}`,
        'Reserva implementada com lock pessimista.',
        `## ${IMPLEMENTATION_REPORT_SECTIONS.planStatus}`,
        '| Passo | Status | Detalhes |',
        '| --- | --- | --- |',
        '| Reserva | Concluído | Lock aplicado |',
      ].join('\n'),
    );
    writeFactoryStageSidecar(devPath, 'development');
    await factoryFlowService.registerArtifact(
      flowId,
      { stage: 'development', kind: 'implementation_report', format: 'markdown', path: devPath, status: 'ready' },
      { reportPath: devPath },
    );
    await factoryFlowService.advanceStage(flowId, { reason: 'Avançar para Testes' });

    const testsPath = join(artifactsDir, 'tests.md');
    writeFileSync(
      testsPath,
      [
        `# ${TEST_REPORT_TITLE}`,
        `## ${TEST_REPORT_SECTIONS.testFiles}`,
        '- test/feature.test.ts',
        `## ${TEST_REPORT_SECTIONS.executedCommands}`,
        '- npm test (exitCode 0)',
        `## ${TEST_REPORT_SECTIONS.results}`,
        'Todos os testes passaram (TC1 -> CA1).',
      ].join('\n'),
    );
    writeFactoryStageSidecar(testsPath, 'tests');
    await factoryFlowService.registerArtifact(
      flowId,
      { stage: 'tests', kind: 'test_report', format: 'markdown', path: testsPath, status: 'ready' },
      { reportPath: testsPath },
    );
    await factoryFlowService.advanceStage(flowId, { reason: 'Avançar para Code Review' });

    const reviewPath = join(artifactsDir, 'review.md');
    writeFileSync(
      reviewPath,
      [
        `# ${REVIEW_REPORT_TITLE}`,
        `## ${REVIEW_REPORT_SECTIONS.executiveSummary}`,
        'Implementação aderente aos critérios.',
        `## ${REVIEW_REPORT_SECTIONS.findings}`,
        'Nenhum apontamento encontrado.',
        `## ${REVIEW_REPORT_SECTIONS.manualVerification}`,
        'Executar npm test e validar fluxo de checkout.',
        `## ${REVIEW_REPORT_SECTIONS.verdict}`,
        REVIEW_VERDICT_LABELS.approved,
      ].join('\n'),
    );
    writeFactoryStageSidecar(reviewPath, 'review', { verdict: 'approved', returnTarget: null, findings: [] });
    await factoryFlowService.registerArtifact(
      flowId,
      { stage: 'review', kind: 'review_report', format: 'markdown', path: reviewPath, status: 'ready' },
      { reportPath: reviewPath },
    );

    // Avançar para PR com startSession: true NÃO inicia sessão automaticamente.
    const advanceToPrRes = await fetch(`${harness.baseUrl}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startSession: true }),
    });
    assert.equal(advanceToPrRes.status, 200);
    const inPr = await harness.fetchFlowDetails(flowId);
    assert.equal(inPr.flow.currentStage, 'pr');
    assert.equal(inPr.flow.state, 'waiting_action');
    assert.equal(inPr.flow.currentSessionId, null);

    // Confirma que o runner de preparação do PR bloqueia mutações Git e publicação.
    const prRunnerArgs = buildPrRunnerArgs(join(artifactsDir, 'pr.md'));
    assert.ok(prRunnerArgs.includes('--disallowedTools'));
    const disallowedPrTools = prRunnerArgs[prRunnerArgs.indexOf('--disallowedTools') + 1] ?? '';
    assert.match(disallowedPrTools, /Bash\(git push\*\)/);
    assert.match(disallowedPrTools, /Bash\(gh pr\*\)/);

    // Registra artefato pr_summary pronto (Etapa 1 do Bloco 06).
    const prPath = join(artifactsDir, 'pr.md');
    writeFileSync(
      prPath,
      [
        `# ${PR_SUMMARY_TITLE}`,
        `## ${PR_SUMMARY_SECTIONS.summary}`,
        'Implementa validação de estoque no checkout.',
        `## ${PR_SUMMARY_SECTIONS.validation}`,
        '| Critério | Evidência |',
        '| --- | --- |',
        '| CA1 | npm test aprovado |',
        `## ${PR_SUMMARY_SECTIONS.prDetails}`,
        '```markdown',
        '## Resumo',
        'Validação de estoque concluída.',
        '```',
      ].join('\n'),
    );
    writeFactoryStageSidecar(prPath, 'pr', {
      title: 'feat(checkout): validar estoque antes da reserva',
      baseBranch: provisioned.baseBranch,
      headBranch: provisioned.branchName,
    });
    await factoryFlowService.registerArtifact(
      flowId,
      { stage: 'pr', kind: 'pr_summary', format: 'markdown', path: prPath, status: 'ready' },
      { reportPath: prPath },
    );

    // Tentar publicar antes de confirmar Etapa 2 falha com 409 FACTORY_FLOW_INVALID_STAGE_ADVANCE.
    const unconfirmedPublishRes = await fetch(
      `${harness.baseUrl}/api/factory/flows/${flowId}/pr-publish`,
      {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    assert.equal(unconfirmedPublishRes.status, 409);
    const unconfirmedErr = FactoryFlowApiErrorResponseSchema.parse(
      await unconfirmedPublishRes.json(),
    );
    assert.equal(unconfirmedErr.error.code, 'FACTORY_FLOW_INVALID_STAGE_ADVANCE');

    // Etapa 2: confirmar revisão pré-publicação vinculada ao prArtifactId.
    const savePrReviewRes = await fetch(
      `${harness.baseUrl}/api/factory/flows/${flowId}/pr-review`,
      {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'feat(checkout): validar estoque antes da reserva',
          description: '## Resumo\nValidação de estoque concluída.',
          baseBranch: provisioned.baseBranch,
          draft: false,
          reviewers: ['maria.silva'],
          updateJira: false,
          confirmPublish: true,
        }),
      },
    );
    assert.equal(savePrReviewRes.status, 200);
    const savedPrReview = SaveFactoryPrReviewResponseSchema.parse(await savePrReviewRes.json());
    assert.equal(savedPrReview.prGate.confirmedForPublish, true);

    // Etapa 3: publicar PR deterministicamente até concluir o fluxo.
    const publishRes = await fetch(`${harness.baseUrl}/api/factory/flows/${flowId}/pr-publish`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github' }),
    });
    assert.equal(publishRes.status, 200);
    const published = PublishFactoryPrResponseSchema.parse(await publishRes.json());
    assert.equal(published.flow.state, 'completed');
    assert.equal(published.publication.status, 'published');
    assert.equal(published.publication.prUrl, 'https://github.com/org/repo/pull/42');
  },
);

test(
  'Fase 1.3: caracteriza worktree, perfil com banco de desenvolvimento, permissões do Planejamento e cenário de staging indisponível',
  { timeout: 15000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-phase1-resources-'));
    const repoDir = join(rootDir, 'repo');
    const binDir = join(rootDir, 'bin');
    const xdgDataHome = join(rootDir, 'xdg-data');
    mkdirSync(repoDir);
    mkdirSync(binDir);
    mkdirSync(xdgDataHome);
    initGitRepo(repoDir);

    const previousPath = process.env.PATH;
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgDataHome;

    context.after(() => {
      process.env.PATH = previousPath;
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
      rmSync(rootDir, { recursive: true, force: true });
    });

    // 1) Projeto alvo com arquivos locais ignorados (.env.local e banco SQLite de dev) + manifesto válido.
    writeFileSync(join(repoDir, '.env.local'), 'DATABASE_URL=postgres://localhost:5432/dev_db\n');
    writeFileSync(join(repoDir, 'local-dev.sqlite'), 'sqlite-dev-placeholder');
    writeFileSync(
      join(repoDir, '.development-factory.json'),
      JSON.stringify({
        baseBranch: 'main',
        stack: ['TypeScript', 'Node.js', 'PostgreSQL (dev)'],
        commands: {
          typecheck: ['npm', 'run', 'typecheck'],
          test: ['npm', 'test'],
        },
        protectedPaths: ['infra/**'],
        architectureRules: ['Usar banco de desenvolvimento local em verificações.'],
      }),
    );

    const loaded = await loadFactoryRepositoryProfile(repoDir);
    assert.equal(loaded.source, 'manifest');
    assert.deepEqual(loaded.profile.commands.test, ['npm', 'test']);
    assert.deepEqual(loaded.profile.stack, ['TypeScript', 'Node.js', 'PostgreSQL (dev)']);

    // Worktree isolado contém arquivos versionados, mas NÃO copia arquivos ignorados (.env.local / local-dev.sqlite).
    const provisioned = await provisionFactoryWorktree({
      repoPath: repoDir,
      flowId: 'phase1-dev-db-check',
      target: { inputType: 'title', value: 'Validar banco dev' },
    });
    assert.equal(existsSync(join(provisioned.worktreePath, 'README.md')), true);
    assert.equal(existsSync(join(provisioned.worktreePath, '.env.local')), false);
    assert.equal(existsSync(join(provisioned.worktreePath, 'local-dev.sqlite')), false);

    // Prompt de Planejamento recebe o contexto do perfil, mas o runner atual de planning NÃO tem Bash nem MCP.
    const reportPath = join(rootDir, 'planning.md');
    const planningPrompt = buildFactoryArchitecturePrompt({
      inputType: 'title',
      value: 'Validar banco dev',
      reportPath,
      repositoryProfile: loaded.profile,
    });
    assert.match(planningPrompt, /PostgreSQL \(dev\)/);
    assert.match(planningPrompt, /"test": \[\s*"npm",\s*"test"\s*\]/);

    const planningArgs = buildTriageAndPlanningRunnerArgs('planning', reportPath);
    const planningTools = planningArgs[planningArgs.indexOf('--tools') + 1] ?? '';
    assert.equal(planningTools, 'Read,Glob,Grep,Edit,Write');
    assert.ok(!planningTools.includes('Bash'));
    assert.ok(planningArgs.includes('--strict-mcp-config'));

    // Em contraste, o runner de tests já usa whitelist estrita para commands.test do perfil.
    const testsArgs = buildTestsRunnerArgs(join(rootDir, 'tests.md'), loaded.profile);
    const testsAllowed = testsArgs[testsArgs.indexOf('--allowedTools') + 1] ?? '';
    assert.match(testsAllowed, /Bash\(npm test\)/);

    // Manifesto com chave extra não suportada (ex.: devDatabase) é rejeitado hoje por strictObject.
    writeFileSync(
      join(repoDir, '.development-factory.json'),
      JSON.stringify({ devDatabase: { urlEnv: 'DATABASE_URL' } }),
    );
    await assert.rejects(
      () => loadFactoryRepositoryProfile(repoDir),
      (error: unknown) =>
        error instanceof FactoryRepositoryProfileError &&
        error.code === 'INVALID_FACTORY_MANIFEST',
    );

    // Restaura manifesto válido para validar o cenário de integração/credencial indisponível localmente.
    writeFileSync(join(repoDir, '.development-factory.json'), JSON.stringify({ baseBranch: 'main' }));

    // 2) Cenário com integração indisponível localmente (Jira MCP desconectado e gh não autenticado).
    const fakeClaude = join(binDir, 'claude');
    writeFileSync(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("1.0.0"); process.exit(0); }',
        'if (args[0] === "mcp" && args[1] === "get") { console.log("Status: Disconnected"); process.exit(0); }',
        'process.exit(1);',
      ].join('\n'),
    );
    chmodSync(fakeClaude, 0o755);

    const fakeGh = join(binDir, 'gh');
    writeFileSync(fakeGh, '#!/usr/bin/env node\nprocess.exit(1);\n');
    chmodSync(fakeGh, 0o755);
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;

    const jiraPreflight = FactoryPreflightResponseSchema.parse(
      await runFactoryPreflight({ repoPath: repoDir, inputType: 'jira_key' }),
    );
    assert.equal(jiraPreflight.blocked, true);
    assert.equal(jiraPreflight.checks.jiraMcp.status, 'error');
    assert.equal(jiraPreflight.checks.github.status, 'warning');

    const titlePreflight = FactoryPreflightResponseSchema.parse(
      await runFactoryPreflight({ repoPath: repoDir, inputType: 'title' }),
    );
    assert.equal(titlePreflight.blocked, false);
    assert.equal(titlePreflight.checks.jiraMcp.status, 'ok');
    assert.equal(titlePreflight.checks.github.status, 'warning');
  },
);
