import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BackgroundSessionSummarySchema,
  FACTORY_FLOW_CONTRACT_VERSION,
  FactoryFlowDetailsSchema,
  type AppEvent,
  type FactoryFlow,
} from '@development-factory/shared';
import { createReviewServer } from '../src/server.js';
import { ReviewService } from '../src/review-service.js';
import {
  DEFAULT_FACTORY_STAGE_TIMEOUTS_MS,
  SessionManager,
} from '../src/session-manager.js';
import { SqliteReviewRepository } from '../src/storage/index.js';
import {
  planningMarkdown,
  triageMarkdown,
  writeFactoryStageSidecar,
} from './fixtures/factory-stage-artifacts.js';

function developmentMarkdown(summary: string): string {
  return [
    '# Relatório de Implementação',
    '## Arquivos alterados',
    '- src/feature.ts',
    '## Resumo das mudanças',
    summary,
    '## Status dos passos do plano',
    '| Passo | Status | Obs |',
    '| --- | --- | --- |',
    '| 1 | Concluído | Validado |',
  ].join('\n');
}

const ALLOWED_ORIGIN = 'http://localhost:5173';

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Tempo limite excedido aguardando condição no teste de resiliência.');
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
  }
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('Tempo limite excedido aguardando condição assíncrona no teste de resiliência.');
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
  }
}

function initGitRepo(repoDir: string): void {
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const version = 1;\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
}

function setupClaudeAndXdg(rootDir: string): {
  binDir: string;
  xdgDataHome: string;
  restore: () => void;
} {
  const binDir = join(rootDir, 'bin');
  const xdgDataHome = join(rootDir, 'xdg-data');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(xdgDataHome, { recursive: true });

  const claudeTarget = join(binDir, 'claude');
  copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
  chmodSync(claudeTarget, 0o755);

  const previousPath = process.env.PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.XDG_DATA_HOME = xdgDataHome;

  return {
    binDir,
    xdgDataHome,
    restore: () => {
      process.env.PATH = previousPath;
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
    },
  };
}

test('resolve timeouts configuráveis por bloco via opções e variáveis de ambiente', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-stage-timeouts-config-'));
  const dbPath = join(rootDir, 'reviews.db');
  const repo = SqliteReviewRepository.open({ dbPath });
  const reviewService = new ReviewService(repo);
  const envKeys = [
    'FACTORY_STAGE_TIMEOUT_MS',
    'FACTORY_STAGE_TIMEOUT_TRIAGE_MS',
    'FACTORY_STAGE_TIMEOUT_DEVELOPMENT_MS',
  ] as const;
  const savedEnv = new Map<string, string | undefined>(
    envKeys.map(key => [key, process.env[key]]),
  );

  try {
    const defaultManager = new SessionManager(reviewService);
    try {
      assert.equal(defaultManager.getStageTimeoutMs('triage'), DEFAULT_FACTORY_STAGE_TIMEOUTS_MS.triage);
      assert.equal(
        defaultManager.getStageTimeoutMs('development'),
        DEFAULT_FACTORY_STAGE_TIMEOUTS_MS.development,
      );
    } finally {
      void defaultManager.shutdownAll();
    }

    process.env.FACTORY_STAGE_TIMEOUT_MS = '45000';
    process.env.FACTORY_STAGE_TIMEOUT_DEVELOPMENT_MS = '90000';

    const envAndOverrideManager = new SessionManager(reviewService, {
      stageTimeoutsMs: { triage: 1200 },
    });
    try {
      assert.equal(envAndOverrideManager.getStageTimeoutMs('triage'), 1200);
      assert.equal(envAndOverrideManager.getStageTimeoutMs('planning'), 45_000);
      assert.equal(envAndOverrideManager.getStageTimeoutMs('development'), 90_000);
      assert.equal(envAndOverrideManager.getStageTimeoutMs('tests'), 45_000);
    } finally {
      void envAndOverrideManager.shutdownAll();
    }

    assert.throws(
      () => new SessionManager(reviewService, { stageTimeoutsMs: { review: 0 } }),
      /Timeout inválido para a etapa review/,
    );
    assert.throws(
      () => new SessionManager(reviewService, { stageTimeoutsMs: { pr: -500 } }),
      /Timeout inválido para a etapa pr/,
    );
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    repo.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('timeout configurável por bloco encerra sessão travada graciosamente, marca pausa retryable e permite retomar', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-stage-timeout-exec-'));
  const repoDir = join(rootDir, 'repo');
  const dbPath = join(rootDir, 'reviews.db');
  initGitRepo(repoDir);
  const env = setupClaudeAndXdg(rootDir);

  const serverBundle = createReviewServer({
    dbPath,
    stageTimeoutsMs: {
      triage: 1000,
      development: 1000,
    },
  });
  const { server, shutdown, sessionManager } = serverBundle;
  const emittedEvents: AppEvent[] = [];
  const unsubscribe = sessionManager.onEvent(event => emittedEvents.push(event));

  try {
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Inicia fluxo na etapa triage e deixa o PTY travado sem sair.
    const createRes = await fetch(`${baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'title', value: 'Timeout resiliente', repoPath: repoDir },
        startSession: true,
      }),
    });
    assert.equal(createRes.status, 201);
    const createdBody = (await createRes.json()) as {
      flow: FactoryFlow;
      session: { sessionId: string };
    };
    const flowId = createdBody.flow.id;
    const timedOutTriageSessionId = createdBody.session.sessionId;
    const timedOutTriageSession = sessionManager.getSession(timedOutTriageSessionId);
    assert.ok(timedOutTriageSession);

    await waitFor(() => timedOutTriageSession.buffer.replay().includes('READY:'));
    // Escreve um segredo simulado antes do timeout para garantir redação no encerramento forçado.
    sessionManager.writeInput(timedOutTriageSessionId, 'Bearer sk-timeout-secret-token-12345');
    await waitFor(() => timedOutTriageSession.buffer.replay().includes('sk-timeout-secret-token-12345'));

    // 2. Aguarda o timeout automático da etapa triage.
    await waitForAsync(async () => {
      const res = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      const details = FactoryFlowDetailsSchema.parse(await res.json());
      return details.flow.state === 'waiting_action' && details.flow.error !== null;
    });

    const afterTimeoutRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const afterTimeout = FactoryFlowDetailsSchema.parse(await afterTimeoutRes.json());
    assert.equal(afterTimeout.flow.state, 'waiting_action');
    assert.equal(afterTimeout.flow.currentStage, 'triage');
    assert.equal(afterTimeout.flow.currentSessionId, null);
    assert.equal(afterTimeout.flow.error?.code, 'FACTORY_STAGE_TIMEOUT');
    assert.equal(afterTimeout.flow.error?.retryable, true);
    assert.match(afterTimeout.flow.error?.message ?? '', /Tempo limite.*excedido.*Triagem/);
    assert.match(afterTimeout.flow.loopPausedReason ?? '', /Execução pausada após exceder o tempo limite/);

    const triageStage = afterTimeout.stages.find(item => item.name === 'triage');
    assert.equal(triageStage?.state, 'waiting_action');
    assert.equal(triageStage?.error?.code, 'FACTORY_STAGE_TIMEOUT');
    const failedArtifact = afterTimeout.artifacts.find(
      item => item.stage === 'triage' && item.kind === 'specification',
    );
    assert.equal(failedArtifact?.status, 'failed');
    assert.equal(failedArtifact?.error?.code, 'FACTORY_STAGE_TIMEOUT');

    assert.equal(timedOutTriageSession.status, 'failed');
    assert.equal(timedOutTriageSession.historyState, 'incomplete');
    assert.equal(timedOutTriageSession.signal, 'SIGTERM');
    assert.equal(timedOutTriageSession.ptyProcess, undefined);
    assert.ok(timedOutTriageSession.sessionPath);
    const sessionLogContent = readFileSync(timedOutTriageSession.sessionPath, 'utf8');
    assert.equal(sessionLogContent.includes('sk-timeout-secret-token-12345'), false);
    assert.match(sessionLogContent, /\[REDACTED\]/);
    assert.ok(
      emittedEvents.some(
        event =>
          event.type === 'session.finished' &&
          event.session.sessionId === timedOutTriageSessionId &&
          event.session.status === 'failed',
      ),
    );

    // 3. Retoma a etapa após o timeout em 1 clique via /rerun e valida limpeza do erro/pausa.
    const rerunRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/rerun`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(rerunRes.status, 200);
    const rerunBody = (await rerunRes.json()) as {
      flow: FactoryFlow;
      session: unknown;
    };
    const resumedTriage = BackgroundSessionSummarySchema.parse(rerunBody.session);
    assert.equal(rerunBody.flow.state, 'running');
    assert.equal(rerunBody.flow.error, null);
    assert.equal(rerunBody.flow.loopPausedReason, null);
    assert.ok(resumedTriage.reportPath);

    // Conclui triagem rapidamente antes do timeout de 250ms.
    await waitFor(() => Boolean(sessionManager.getSession(resumedTriage.sessionId)?.buffer.replay().includes('READY:')));
    writeFileSync(resumedTriage.reportPath, triageMarkdown('Entendimento concluído após retomada.'));
    writeFactoryStageSidecar(resumedTriage.reportPath, 'triage');
    sessionManager.writeInput(resumedTriage.sessionId, 'EXIT0');

    // Aguarda planejamento iniciar automaticamente e conclui planejamento.
    let planningSessionId: string | undefined;
    await waitFor(() => {
      const running = sessionManager
        .listSessions()
        .find(item => item.flowId === flowId && item.stage === 'planning' && item.status === 'running');
      planningSessionId = running?.sessionId;
      return Boolean(
        planningSessionId &&
          sessionManager.getSession(planningSessionId)?.buffer.replay().includes('READY:'),
      );
    });
    assert.ok(planningSessionId);
    const planningSession = sessionManager.getSession(planningSessionId);
    assert.ok(planningSession?.reportPath);
    writeFileSync(planningSession.reportPath, planningMarkdown('Plano concluído.'));
    writeFactoryStageSidecar(planningSession.reportPath, 'planning');
    sessionManager.writeInput(planningSessionId, 'EXIT0');

    await waitForAsync(async () => {
      const res = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      const details = FactoryFlowDetailsSchema.parse(await res.json());
      return (
        details.flow.currentStage === 'planning' &&
        details.flow.state === 'waiting_action' &&
        details.flow.currentSessionId === null
      );
    });

    // 4. Avança para Desenvolvimento e valida timeout em etapa mutante preservando worktree/checkpoint.
    const startDevRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startSession: true }),
    });
    assert.equal(startDevRes.status, 200);
    const startDevBody = (await startDevRes.json()) as { session: unknown };
    const devSession = BackgroundSessionSummarySchema.parse(startDevBody.session);
    await waitFor(() => Boolean(sessionManager.getSession(devSession.sessionId)?.buffer.replay().includes('READY:')));

    await waitForAsync(async () => {
      const res = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      const details = FactoryFlowDetailsSchema.parse(await res.json());
      return (
        details.flow.currentStage === 'development' &&
        details.flow.state === 'waiting_action' &&
        details.flow.error?.code === 'FACTORY_STAGE_TIMEOUT'
      );
    });

    const devTimedOutRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const devTimedOut = FactoryFlowDetailsSchema.parse(await devTimedOutRes.json());
    assert.ok(devTimedOut.worktreePath && existsSync(devTimedOut.worktreePath));
    assert.equal(devTimedOut.checkpoints.length, 1);
    assert.match(devTimedOut.flow.error?.message ?? '', /Tempo limite.*excedido.*Desenvolvimento/);

    // Retoma e conclui Desenvolvimento com sucesso.
    const resumeDevRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/rerun`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resumeDevRes.status, 200);
    const resumedDevBody = (await resumeDevRes.json()) as { session: unknown };
    const resumedDev = BackgroundSessionSummarySchema.parse(resumedDevBody.session);
    assert.ok(resumedDev.reportPath);
    await waitFor(() => Boolean(sessionManager.getSession(resumedDev.sessionId)?.buffer.replay().includes('READY:')));
    writeFileSync(resumedDev.reportPath, developmentMarkdown('Implementação retomada após timeout.'));
    writeFactoryStageSidecar(resumedDev.reportPath, 'development');
    sessionManager.writeInput(resumedDev.sessionId, 'EXIT0');

    await waitForAsync(async () => {
      const res = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      const details = FactoryFlowDetailsSchema.parse(await res.json());
      return details.flow.currentStage === 'tests';
    });
  } finally {
    unsubscribe();
    await shutdown();
    env.restore();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reinício do servidor reconcilia fluxos presos em running para waiting_action e permite retomada em 1 clique preservando worktree e checkpoints', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-server-reconcile-'));
  const repoDir = join(rootDir, 'repo');
  const dbPath = join(rootDir, 'reviews.db');
  initGitRepo(repoDir);
  const env = setupClaudeAndXdg(rootDir);

  let serverOneClosed = false;
  const serverOne = createReviewServer({ dbPath });
  let serverTwo: ReturnType<typeof createReviewServer> | undefined;
  let orphanPid: number | undefined;

  try {
    await new Promise<void>(resolve => {
      serverOne.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr1 = serverOne.server.address() as AddressInfo;
    const baseUrl1 = `http://127.0.0.1:${addr1.port}`;

    // Cria fluxo, conclui triagem e planejamento, e inicia desenvolvimento com PTY ativo.
    const createRes = await fetch(`${baseUrl1}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'jira_key', value: 'RES-405', repoPath: repoDir },
        startSession: true,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      flow: FactoryFlow;
      session: { sessionId: string; reportPath?: string | null };
    };
    const flowId = created.flow.id;
    const triageSession = BackgroundSessionSummarySchema.parse(created.session);
    assert.ok(triageSession.reportPath);

    await waitFor(() => Boolean(serverOne.sessionManager.getSession(triageSession.sessionId)?.buffer.replay().includes('READY:')));
    writeFileSync(triageSession.reportPath, triageMarkdown('Triagem RES-405.'));
    writeFactoryStageSidecar(triageSession.reportPath, 'triage');
    serverOne.sessionManager.writeInput(triageSession.sessionId, 'EXIT0');

    let planningSessionId: string | undefined;
    await waitFor(() => {
      const running = serverOne.sessionManager
        .listSessions()
        .find(item => item.flowId === flowId && item.stage === 'planning' && item.status === 'running');
      planningSessionId = running?.sessionId;
      return Boolean(
        planningSessionId &&
          serverOne.sessionManager.getSession(planningSessionId)?.buffer.replay().includes('READY:'),
      );
    });
    assert.ok(planningSessionId);
    const planningSession = serverOne.sessionManager.getSession(planningSessionId);
    assert.ok(planningSession?.reportPath);
    writeFileSync(planningSession.reportPath, planningMarkdown('Plano RES-405.'));
    writeFactoryStageSidecar(planningSession.reportPath, 'planning');
    serverOne.sessionManager.writeInput(planningSessionId, 'EXIT0');

    await waitForAsync(async () => {
      const res = await fetch(`${baseUrl1}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      const details = FactoryFlowDetailsSchema.parse(await res.json());
      return (
        details.flow.currentStage === 'planning' &&
        details.flow.state === 'waiting_action' &&
        details.flow.currentSessionId === null
      );
    });

    const startDevRes = await fetch(`${baseUrl1}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startSession: true }),
    });
    assert.equal(startDevRes.status, 200);
    const devStartBody = (await startDevRes.json()) as { session: unknown };
    const devSessionSummary = BackgroundSessionSummarySchema.parse(devStartBody.session);
    const devManagedSession = serverOne.sessionManager.getSession(devSessionSummary.sessionId);
    assert.ok(devManagedSession);
    await waitFor(() => devManagedSession.buffer.replay().includes('READY:'));
    orphanPid = devManagedSession.ptyProcess?.pid;

    const beforeCrashRes = await fetch(`${baseUrl1}/api/factory/flows/${flowId}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const beforeCrash = FactoryFlowDetailsSchema.parse(await beforeCrashRes.json());
    assert.equal(beforeCrash.flow.state, 'running');
    assert.equal(beforeCrash.flow.currentStage, 'development');
    assert.equal(beforeCrash.flow.currentSessionId, devSessionSummary.sessionId);
    assert.ok(beforeCrash.worktreePath);
    assert.ok(beforeCrash.branchName);
    assert.equal(beforeCrash.checkpoints.length, 1);
    const baselineCheckpointId = beforeCrash.checkpoints[0]?.id;
    const baselineSha = beforeCrash.checkpoints[0]?.commitSha;
    assert.ok(baselineCheckpointId && baselineSha);

    // Simula alteração parcial em andamento no worktree antes da queda abrupta do servidor.
    writeFileSync(join(beforeCrash.worktreePath, 'src', 'app.ts'), 'export const version = 2;\n');

    // Simula queda abrupta do processo sem chamar shutdownAll(), preservando state='running' no SQLite.
    await new Promise<void>(resolve => {
      serverOne.server.close(() => resolve());
    });
    serverOne.reviewRepository.close();
    serverOne.factoryFlowRepository.close();
    serverOneClosed = true;
    if (orphanPid !== undefined) {
      try {
        process.kill(orphanPid, 'SIGKILL');
      } catch {
        // Processo pode já ter encerrado.
      }
    }

    // Reinicia um novo servidor apontando para o mesmo SQLite.
    serverTwo = createReviewServer({ dbPath });
    await new Promise<void>(resolve => {
      serverTwo?.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr2 = serverTwo.server.address() as AddressInfo;
    const baseUrl2 = `http://127.0.0.1:${addr2.port}`;

    // Imediatamente após o boot, o fluxo preso em running já está reconciliado para waiting_action.
    const reconciledRes = await fetch(`${baseUrl2}/api/factory/flows/${flowId}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(reconciledRes.status, 200);
    const reconciled = FactoryFlowDetailsSchema.parse(await reconciledRes.json());
    assert.equal(reconciled.flow.state, 'waiting_action');
    assert.equal(reconciled.flow.currentStage, 'development');
    assert.equal(reconciled.flow.currentSessionId, null);
    assert.equal(reconciled.flow.error, null);
    assert.match(reconciled.flow.loopPausedReason ?? '', /Reinício do servidor interrompeu a etapa Desenvolvimento/);
    assert.equal(reconciled.worktreePath, beforeCrash.worktreePath);
    assert.equal(reconciled.branchName, beforeCrash.branchName);
    assert.equal(reconciled.baseBranch, beforeCrash.baseBranch);
    assert.equal(reconciled.checkpoints.length, 1);
    assert.equal(reconciled.checkpoints[0]?.id, baselineCheckpointId);
    const reconciledDevStage = reconciled.stages.find(stage => stage.name === 'development');
    assert.equal(reconciledDevStage?.state, 'waiting_action');
    assert.equal(reconciledDevStage?.sessionId, null);

    // Inicia um segundo fluxo ativo em paralelo e valida que reconcileInterruptedFlows não o interrompe.
    const parallelCreateRes = await fetch(`${baseUrl2}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'title', value: 'Fluxo ativo durante reconciliação', repoPath: repoDir },
        startSession: true,
      }),
    });
    assert.equal(parallelCreateRes.status, 201);
    const parallelBody = (await parallelCreateRes.json()) as {
      flow: FactoryFlow;
      session: { sessionId: string };
    };
    const reconciledRuntime = await serverTwo.sessionManager.reconcileInterruptedFlows();
    assert.equal(reconciledRuntime.length, 0);
    const parallelCheck = serverTwo.factoryFlowService.getFlow(parallelBody.flow.id);
    assert.equal(parallelCheck.flow.state, 'running');
    await serverTwo.sessionManager.stopSession(parallelBody.session.sessionId, 'encerrar fluxo auxiliar');

    // Retoma o fluxo reconciliado em 1 clique via /rerun preservando worktree e checkpoints.
    const resumeRes = await fetch(`${baseUrl2}/api/factory/flows/${flowId}/rerun`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resumeRes.status, 200);
    const resumeBody = (await resumeRes.json()) as {
      flow: FactoryFlow;
      session: unknown;
    };
    const resumedSession = BackgroundSessionSummarySchema.parse(resumeBody.session);
    assert.equal(resumeBody.flow.state, 'running');
    assert.equal(resumeBody.flow.currentStage, 'development');
    assert.equal(resumeBody.flow.loopPausedReason, null);
    assert.equal(resumeBody.flow.worktreePath, beforeCrash.worktreePath);

    const afterResumeDetails = serverTwo.factoryFlowService.getFlow(flowId);
    // O baseline checkpoint foi preservado e a edição parcial pré-queda gerou checkpoint de segurança.
    assert.equal(afterResumeDetails.checkpoints[0]?.id, baselineCheckpointId);
    assert.equal(afterResumeDetails.checkpoints[0]?.commitSha, baselineSha);
    assert.ok(afterResumeDetails.checkpoints.length >= 2);

    const activeManaged = serverTwo.sessionManager.getSession(resumedSession.sessionId);
    assert.ok(activeManaged && resumedSession.reportPath);
    await waitFor(() => activeManaged.buffer.replay().includes('READY:'));
    assert.ok(activeManaged.buffer.replay().includes(beforeCrash.worktreePath));

    writeFileSync(resumedSession.reportPath, developmentMarkdown('Implementação concluída após restart.'));
    writeFactoryStageSidecar(resumedSession.reportPath, 'development');
    serverTwo.sessionManager.writeInput(resumedSession.sessionId, 'EXIT0');

    await waitForAsync(async () => {
      const res = await fetch(`${baseUrl2}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      const details = FactoryFlowDetailsSchema.parse(await res.json());
      return details.flow.currentStage === 'tests';
    });
  } finally {
    if (orphanPid !== undefined) {
      try {
        process.kill(orphanPid, 'SIGKILL');
      } catch {
        // Processo pode já ter encerrado.
      }
    }
    if (serverTwo) {
      await serverTwo.shutdown();
    }
    if (!serverOneClosed) {
      await serverOne.shutdown();
    }
    env.restore();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
