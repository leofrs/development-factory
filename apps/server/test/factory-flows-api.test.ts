import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { z } from 'zod';
import {
  AppEventSchema,
  BackgroundSessionSummarySchema,
  CreateFactoryFlowResponseSchema,
  FactoryDevelopmentSidecarSchema,
  FactoryFlowApiErrorResponseSchema,
  FactoryFlowDetailsSchema,
  FactoryFlowListResponseSchema,
  FactoryFlowSchema,
  FactoryMetricsResponseSchema,
  FactoryTestsSidecarSchema,
  RollbackFactoryFlowCheckpointResponseSchema,
  SaveFactoryPrReviewResponseSchema,
  ServerMessageSchema,
  TransitionFactoryFlowResponseSchema,
  type AppEvent,
  type BackgroundSessionSummary,
  type FactoryReviewSidecar,
  type ReturnFactoryTargetStage,
  type ServerMessage,
} from '@development-factory/shared';
import { createReviewServer } from '../src/server.js';
import {
  buildTriageAndPlanningRunnerArgs,
  getFactoryStageSidecarPath,
} from '../src/factory-stage-runners.js';
import {
  planningMarkdown,
  sidecarFixtures,
  triageMarkdown,
  writeFactoryStageSidecar,
} from './fixtures/factory-stage-artifacts.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

interface ParsedSseMessage {
  readonly event?: string;
  readonly data: string;
}

function parseSseFrames(buffer: string): { frames: ParsedSseMessage[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: ParsedSseMessage[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed.startsWith(':')) {
      continue;
    }
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (dataLines.length > 0) {
      frames.push({
        ...(eventName !== undefined ? { event: eventName } : {}),
        data: dataLines.join('\n'),
      });
    }
  }

  return { frames, rest };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Tempo limite excedido aguardando condição no teste de fluxos da Factory.');
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
  }
}

async function waitForFlowDetails<T>(
  loadDetails: () => Promise<T>,
  predicate: (details: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let current = await loadDetails();
  while (!predicate(current)) {
    if (Date.now() > deadline) {
      throw new Error('Tempo limite excedido aguardando estado do fluxo da Factory.');
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
    current = await loadDetails();
  }
  return current;
}

function initGitRepo(repoDir: string, branch = 'main'): void {
  execFileSync('git', ['init', '-b', branch], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# Repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
}

test('API REST /api/factory/flows valida origem, idempotência, filtros e ciclo completo com SSE e PTYs paralelos', { timeout: 30000 }, async context => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-flows-api-'));
  const binDir = join(rootDir, 'bin');
  const repoA = join(rootDir, 'repo-a');
  const repoB = join(rootDir, 'repo-b');
  const xdgDataHome = join(rootDir, 'xdg-data');
  const dbPath = join(rootDir, 'reviews.db');
  mkdirSync(binDir);
  mkdirSync(repoA);
  mkdirSync(repoB);
  mkdirSync(xdgDataHome);
  initGitRepo(repoA);
  initGitRepo(repoB);

  const claudeTarget = join(binDir, 'claude');
  copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
  chmodSync(claudeTarget, 0o755);

  const previousPath = process.env.PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.XDG_DATA_HOME = xdgDataHome;

  const { server, sessionManager, shutdown } = createReviewServer({ dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws/terminal`;

  const abortController = new AbortController();
  const sockets: WebSocket[] = [];

  context.after(async () => {
    abortController.abort();
    for (const socket of sockets) {
      socket.terminate();
    }
    await shutdown();
    process.env.PATH = previousPath;
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  // 1. Validação de origem e listagem inicial vazia.
  const noOriginRes = await fetch(`${baseUrl}/api/factory/flows`);
  assert.equal(noOriginRes.status, 403);
  const noOriginErr = FactoryFlowApiErrorResponseSchema.parse(await noOriginRes.json());
  assert.equal(noOriginErr.error.code, 'ORIGIN_FORBIDDEN');

  const badOriginRes = await fetch(`${baseUrl}/api/factory/flows`, {
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(badOriginRes.status, 403);

  const emptyListRes = await fetch(`${baseUrl}/api/factory/flows`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(emptyListRes.status, 200);
  const emptyList = FactoryFlowListResponseSchema.parse(await emptyListRes.json());
  assert.equal(emptyList.flows.length, 0);

  // 2. Conecta ao stream SSE /api/events.
  const sseRes = await fetch(`${baseUrl}/api/events`, {
    headers: { Origin: ALLOWED_ORIGIN },
    signal: abortController.signal,
  });
  assert.equal(sseRes.status, 200);
  assert(sseRes.body);

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  const events: AppEvent[] = [];

  const pumpSse = async (): Promise<void> => {
    while (!abortController.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      sseBuffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseFrames(sseBuffer);
      sseBuffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.event === 'heartbeat') {
          continue;
        }
        events.push(AppEventSchema.parse(JSON.parse(frame.data)));
      }
    }
  };
  void pumpSse().catch(() => undefined);

  // 3. Idempotência na criação de fluxo sem startSession.
  const idempotencyKey = `flow-key-${randomUUID()}`;
  const createPayload = {
    task: { inputType: 'jira_key', value: 'PROD-100', repoPath: repoA },
    title: 'PROD-100 · Fluxo idempotente',
  };

  const firstCreateRes = await fetch(`${baseUrl}/api/factory/flows`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(createPayload),
  });
  assert.equal(firstCreateRes.status, 201);
  const firstCreated = CreateFactoryFlowResponseSchema.parse(await firstCreateRes.json());
  assert.equal(firstCreated.replayed, false);
  assert.equal(firstCreated.flow.state, 'queued');
  assert.equal(firstCreated.flow.currentStage, 'triage');

  const replayRes = await fetch(`${baseUrl}/api/factory/flows`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(createPayload),
  });
  assert.equal(replayRes.status, 200);
  const replayed = CreateFactoryFlowResponseSchema.parse(await replayRes.json());
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.flow.id, firstCreated.flow.id);

  const conflictRes = await fetch(`${baseUrl}/api/factory/flows`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      task: { inputType: 'jira_key', value: 'PROD-999', repoPath: repoA },
    }),
  });
  assert.equal(conflictRes.status, 409);
  const conflictErr = FactoryFlowApiErrorResponseSchema.parse(await conflictRes.json());
  assert.equal(conflictErr.error.code, 'FACTORY_FLOW_IDEMPOTENCY_CONFLICT');

  // 4. Inicia dois fluxos paralelos em segundo plano:
  //    - Fluxo A via POST /api/factory/flows com startSession: true (em repoA)
  //    - Fluxo B via WebSocket start_factory sem flowId (em repoB)
  const createFlowARes = await fetch(`${baseUrl}/api/factory/flows`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      task: { inputType: 'title', value: 'Fluxo paralelo A', repoPath: repoA },
      startSession: true,
      cols: 100,
      rows: 30,
    }),
  });
  assert.equal(createFlowARes.status, 201);
  const createdFlowABody = (await createFlowARes.json()) as {
    flow: { id: string; state: string; currentStage: string; currentSessionId: string | null };
    session: BackgroundSessionSummary;
  };
  assert.equal(createdFlowABody.flow.state, 'running');
  assert.equal(createdFlowABody.flow.currentStage, 'triage');
  assert.equal(createdFlowABody.flow.currentSessionId, createdFlowABody.session.sessionId);
  const flowAId = createdFlowABody.flow.id;
  const sessionAId = createdFlowABody.session.sessionId;

  const wsB = new WebSocket(wsUrl, { origin: ALLOWED_ORIGIN });
  sockets.push(wsB);
  const wsBMessages: ServerMessage[] = [];
  wsB.on('message', raw => {
    wsBMessages.push(ServerMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
  });
  await once(wsB, 'open');
  wsB.send(
    JSON.stringify({
      type: 'start_factory',
      inputType: 'jira_key',
      value: 'PROD-200',
      repoPath: repoB,
      cols: 100,
      rows: 30,
    }),
  );

  await waitFor(() =>
    wsBMessages.some(msg => msg.type === 'factory_flow' && msg.state === 'running'),
  );
  const flowBMsg = wsBMessages.find(
    (msg): msg is Extract<ServerMessage, { type: 'factory_flow' }> => msg.type === 'factory_flow',
  );
  assert(flowBMsg);
  const flowBId = flowBMsg.flowId;
  assert.notEqual(flowAId, flowBId);

  const attachedBMsg = wsBMessages.find(
    (msg): msg is Extract<ServerMessage, { type: 'session_attached' }> =>
      msg.type === 'session_attached',
  );
  assert(attachedBMsg);
  const sessionBId = attachedBMsg.session.sessionId;
  assert.equal(attachedBMsg.session.flowId, flowBId);
  assert.equal(attachedBMsg.session.stage, 'triage');

  async function readRunnerLaunch(sessionId: string) {
    const readPayload = () =>
      /^READY:([^\n]*)\n/m.exec(
        sessionManager.getSession(sessionId)?.buffer.replay() ?? '',
      )?.[1];
    await waitFor(() => readPayload() !== undefined);
    const payload = readPayload();
    assert.ok(payload);
    return z.object({ cwd: z.string(), args: z.array(z.string()) }).parse(
      JSON.parse(payload) as unknown,
    );
  }

  const [triageA, triageB] = await Promise.all([
    readRunnerLaunch(sessionAId),
    readRunnerLaunch(sessionBId),
  ]);

  // Confere que GET /api/sessions retorna ambas sessões com flowId e stage distintos.
  const sessionsRes = await fetch(`${baseUrl}/api/sessions`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(sessionsRes.status, 200);
  const sessionsBody = (await sessionsRes.json()) as { sessions: BackgroundSessionSummary[] };
  const parsedSessions = BackgroundSessionSummarySchema.array().parse(sessionsBody.sessions);
  const sessionASummary = parsedSessions.find(item => item.sessionId === sessionAId);
  const sessionBSummary = parsedSessions.find(item => item.sessionId === sessionBId);
  assert(sessionASummary && sessionBSummary);
  assert.equal(sessionASummary.flowId, flowAId);
  assert.equal(sessionBSummary.flowId, flowBId);
  assert.notEqual(sessionASummary.reportPath, sessionBSummary.reportPath);
  assert.notEqual(sessionASummary.sessionPath, sessionBSummary.sessionPath);
  assert.ok(sessionASummary.reportPath && sessionBSummary.reportPath);
  assert.deepEqual(triageA.args.slice(0, -1), [
    '--verbose',
    '--output-format',
    'stream-json',
    ...buildTriageAndPlanningRunnerArgs('triage', sessionASummary.reportPath),
    '-p',
  ]);
  assert.deepEqual(triageB.args.slice(0, -1), [
    '--verbose',
    '--output-format',
    'stream-json',
    ...buildTriageAndPlanningRunnerArgs('triage', sessionBSummary.reportPath),
    '-p',
  ]);

  // A atividade da sessão chega por SSE sem conectar um terminal ao fluxo A.
  const childA = sessionManager.getSession(sessionAId)?.ptyProcess;
  assert(childA);
  childA.write('ACTIVITY');
  const expectedActivity = {
    revision: 2,
    lastReadFile: 'src/index.ts',
    lastEditedFile: 'triage.md',
  };
  const readActivityEvent = () =>
    events.find(
      event =>
        event.type === 'session.updated' &&
        event.session.sessionId === sessionAId &&
        event.session.factoryActivity?.revision === 2,
    );
  await waitFor(() => Boolean(readActivityEvent()));
  const activityEvent = readActivityEvent();
  assert(activityEvent?.type === 'session.updated');
  assert.equal(activityEvent.session.status, 'running');
  assert.deepEqual(activityEvent.session.factoryActivity, expectedActivity);
  assert.equal(sessionManager.getSessionSummary(sessionBId)?.factoryActivity, undefined);

  const sessionSnapshotRes = await fetch(`${baseUrl}/api/sessions/${sessionAId}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(sessionSnapshotRes.status, 200);
  const snapshot = z.object({ session: BackgroundSessionSummarySchema }).parse(
    await sessionSnapshotRes.json(),
  );
  assert.deepEqual(snapshot.session.factoryActivity, expectedActivity);

  // Confere que não é possível avançar ou reexecutar enquanto a sessão está running.
  const advanceRunningRes = await fetch(`${baseUrl}/api/factory/flows/${flowAId}/advance`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(advanceRunningRes.status, 409);

  const rerunRunningRes = await fetch(`${baseUrl}/api/factory/flows/${flowAId}/rerun`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(rerunRunningRes.status, 409);

  const postFlowA = (action: string, data: object) =>
    fetch(`${baseUrl}/api/factory/flows/${flowAId}/${action}`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

  // 5. A triagem sem sidecar bloqueia o avanço e pode ser reexecutada.
  writeFileSync(sessionASummary.reportPath, triageMarkdown('Fluxo A sem sidecar.'));
  rmSync(getFactoryStageSidecarPath(sessionASummary.reportPath));
  sessionManager.writeInput(sessionAId, 'EXIT0');
  await waitFor(() =>
    events.some(
      event =>
        event.type === 'factory_flow.updated' &&
        event.flow.id === flowAId &&
        event.flow.state === 'waiting_action' &&
        event.flow.currentStage === 'triage' &&
        event.flow.currentSessionId === null &&
        event.flow.error?.code === 'FACTORY_SIDECAR_MISSING',
    ),
  );
  const blockedAdvance = await postFlowA('advance', { startSession: true });
  assert.equal(blockedAdvance.status, 409);
  const advanceError = FactoryFlowApiErrorResponseSchema.parse(await blockedAdvance.json());
  assert.equal(advanceError.error.code, 'FACTORY_FLOW_INVALID_CONTRACT');
  assert.match(advanceError.error.message, /sidecar JSON está ausente.*triage/);
  const blockedStart = await postFlowA('start', { stage: 'planning' });
  assert.equal(blockedStart.status, 409);
  const blockedTransition = await postFlowA('transitions', {
    to: 'running',
    stage: 'planning',
    reason: 'Solicitar Planejamento pela rota de transições',
  });
  assert.equal(blockedTransition.status, 409);
  assert.ok(
    sessionManager.listSessions().every(
      session => session.flowId !== flowAId || session.stage === 'triage',
    ),
  );

  const retryResponse = await postFlowA('rerun', { stage: 'triage' });
  assert.equal(retryResponse.status, 200);
  const retried = z
    .object({ flow: FactoryFlowSchema, session: BackgroundSessionSummarySchema })
    .parse(await retryResponse.json());
  assert.equal(retried.flow.error, null);
  assert.ok(retried.session.reportPath);
  const retriedTriageId = retried.session.sessionId;
  await waitFor(() =>
    Boolean(sessionManager.getSession(retriedTriageId)?.buffer.replay().includes('READY:')),
  );
  writeFileSync(retried.session.reportPath, triageMarkdown('Fluxo A salvo.'));
  writeFactoryStageSidecar(retried.session.reportPath, 'triage');
  sessionManager.writeInput(retriedTriageId, 'EXIT0');
  await waitFor(() =>
    events.some(
      event =>
        event.type === 'session.history_saved' && event.session.sessionId === retriedTriageId,
    ),
  );

  await waitFor(() =>
    events.some(
      event =>
        event.type === 'factory_flow.updated' &&
        event.flow.id === flowAId &&
        event.flow.currentStage === 'planning' &&
        event.flow.state === 'running' &&
        event.flow.currentSessionId !== null &&
        event.flow.currentSessionId !== sessionAId,
    ),
  );

  const detailsARes = await fetch(`${baseUrl}/api/factory/flows/${flowAId}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(detailsARes.status, 200);
  const detailsA = FactoryFlowDetailsSchema.parse(await detailsARes.json());
  assert.equal(detailsA.flow.state, 'running');
  assert.equal(detailsA.flow.currentStage, 'planning');
  assert.ok(detailsA.flow.currentSessionId && detailsA.flow.currentSessionId !== sessionAId);
  assert.ok(
    detailsA.artifacts.some(
      artifact =>
        artifact.stage === 'triage' &&
        artifact.kind === 'specification' &&
        artifact.status === 'ready',
    ),
  );
  assert.ok(
    detailsA.artifacts.some(
      artifact =>
        artifact.stage === 'triage' &&
        artifact.kind === 'session_log' &&
        artifact.status === 'ready',
    ),
  );

  const autoPlanningSessionId = detailsA.flow.currentSessionId;
  const planning = await readRunnerLaunch(autoPlanningSessionId);
  const planningReport = sessionManager.getSession(autoPlanningSessionId)?.reportPath;
  assert.ok(planningReport);
  assert.equal(planning.cwd, detailsA.flow.worktreePath);
  assert.deepEqual(planning.args.slice(0, -1), [
    '--verbose',
    '--output-format',
    'stream-json',
    ...buildTriageAndPlanningRunnerArgs('planning', planningReport),
    '-p',
  ]);
  const planningPrompt = planning.args.at(-1) ?? '';
  assert.ok(planningPrompt.includes('# Documento de Entendimento do Problema'));
  assert.ok(planningPrompt.includes('Fluxo A salvo.'));
  assert.ok(planningPrompt.includes('Sub-etapa A'));

  sessionManager.writeInput(autoPlanningSessionId, 'EXIT0');
  await waitFor(() =>
    events.some(
      event =>
        event.type === 'factory_flow.updated' &&
        event.flow.id === flowAId &&
        event.flow.currentStage === 'planning' &&
        event.flow.state === 'waiting_action' &&
        event.flow.currentSessionId === null,
    ),
  );

  // 6. Reexecuta a etapa atual (planning) do Fluxo A via /rerun.
  const rerunRes = await fetch(`${baseUrl}/api/factory/flows/${flowAId}/rerun`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols: 90, rows: 25 }),
  });
  assert.equal(rerunRes.status, 200);
  const rerunBody = (await rerunRes.json()) as {
    flow: { state: string; currentStage: string; currentSessionId: string | null };
    session: BackgroundSessionSummary;
  };
  assert.equal(rerunBody.flow.state, 'running');
  assert.equal(rerunBody.flow.currentStage, 'planning');
  assert.notEqual(rerunBody.session.sessionId, autoPlanningSessionId);

  await waitFor(() => Boolean(sessionManager.getSession(rerunBody.session.sessionId)?.buffer.replay().includes('READY:')));

  // 7. Cancela o Fluxo A em execução via POST /api/factory/flows/:id/cancel.
  const cancelRes = await fetch(`${baseUrl}/api/factory/flows/${flowAId}/cancel`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Cancelamento via API no teste' }),
  });
  assert.equal(cancelRes.status, 200);
  const cancelled = TransitionFactoryFlowResponseSchema.parse(await cancelRes.json());
  assert.equal(cancelled.flow.state, 'cancelled');

  // 8. Fluxo B sai com código 7 (EXIT) e transiciona automaticamente para failed.
  sessionManager.writeInput(sessionBId, 'EXIT');
  await waitFor(() =>
    events.some(
      event =>
        event.type === 'factory_flow.finished' &&
        event.flow.id === flowBId &&
        event.flow.state === 'failed',
    ),
  );

  // 9. Listagem com filtro por estado e repositório.
  const filteredRes = await fetch(
    `${baseUrl}/api/factory/flows?state=failed&repoPath=${encodeURIComponent(repoB)}`,
    { headers: { Origin: ALLOWED_ORIGIN } },
  );
  assert.equal(filteredRes.status, 200);
  const filtered = FactoryFlowListResponseSchema.parse(await filteredRes.json());
  assert.equal(filtered.flows.length, 1);
  assert.equal(filtered.flows[0]?.id, flowBId);

  // 10. Fluxo inexistente e UUID inválido retornam erros padronizados.
  const notFoundRes = await fetch(`${baseUrl}/api/factory/flows/${randomUUID()}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(notFoundRes.status, 404);
  const notFoundErr = FactoryFlowApiErrorResponseSchema.parse(await notFoundRes.json());
  assert.equal(notFoundErr.error.code, 'FACTORY_FLOW_NOT_FOUND');

  const invalidIdRes = await fetch(`${baseUrl}/api/factory/flows/nao-uuid`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(invalidIdRes.status, 400);
  const invalidIdErr = FactoryFlowApiErrorResponseSchema.parse(await invalidIdRes.json());
  assert.equal(invalidIdErr.error.code, 'FACTORY_FLOW_INVALID_INPUT');
});

test(
  'fluxos paralelos mantêm artefatos isolados fora do repositório e o Desenvolvimento entrega o fluxo à etapa de Testes',
  { timeout: 30000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-parallel-same-repo-'));
    const binDir = join(rootDir, 'bin');
    const repoDir = join(rootDir, 'shared-repo');
    const xdgDataHome = join(rootDir, 'xdg-data');
    const dbPath = join(rootDir, 'reviews.db');
    mkdirSync(binDir);
    mkdirSync(repoDir);
    mkdirSync(xdgDataHome);
    initGitRepo(repoDir);
    const checkScript = 'check.mjs';
    const literalArgument = 'argumento com espaços e $(literal)';
    writeFileSync(
      join(repoDir, checkScript),
      `import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const [check, literal, empty] = process.argv.slice(2);
if (check === 'typecheck' || check === 'lint') {
  assert.equal(literal, ${JSON.stringify(literalArgument)});
  assert.equal(empty, '');
  if (existsSync('.hold-check')) {
    writeFileSync('.check-started', '');
    while (existsSync('.hold-check')) {
      await delay(10);
    }
  }
  if (!existsSync('src/jwt.ts')) {
    if (check === 'typecheck') {
      console.log('error TS2307: módulo ausente');
      process.exitCode = 17;
    } else {
      console.error('error E1000: implementação ausente');
      process.exitCode = 9;
    }
  }
} else if (check === 'test' || check === 'coverage') {
  if (existsSync('.hold-test')) {
    writeFileSync('.test-started', '');
    while (existsSync('.hold-test')) {
      await delay(10);
    }
  }
  if (!existsSync('.tests-passing')) {
    if (check === 'test') {
      console.log('ℹ fail 2');
      process.exitCode = 1;
    } else {
      console.log('Lines : 62.5%');
      console.log('Branches : 50%');
      process.exitCode = 1;
    }
  } else if (check === 'test') {
    console.log('ℹ tests 4\\nℹ pass 4\\nℹ fail 0');
  } else {
    console.log('ℹ file | line % | branch % | funcs %');
    console.log('ℹ all files | 94.50 | 82.25 | 100.00 |');
  }
}
`,
    );
    execFileSync('git', ['add', checkScript], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'add check fixture'], { cwd: repoDir });
    execFileSync('git', ['branch', 'integration'], { cwd: repoDir });
    const manifestName = '.development-factory.json';
    const typecheck = ['node', `./${checkScript}`, 'typecheck', literalArgument, ''];
    const lint = ['node', `./${checkScript}`, 'lint', literalArgument, ''];
    const testCommand = ['node', `./${checkScript}`, 'test'];
    const coverageCommand = ['node', `./${checkScript}`, 'coverage'];
    const manifest = {
      baseBranch: 'integration',
      branchPattern: 'feat/{slug}-factory',
      stack: ['Node.js'],
      commands: { typecheck, lint, test: testCommand, coverage: coverageCommand },
      protectedPaths: ['deploy/**'],
      architectureRules: ['O domínio depende de interfaces.'],
      prTemplate: '## Evidências do time\n\n## Plano de reversão',
    };
    writeFileSync(join(repoDir, manifestName), JSON.stringify(manifest));
    execFileSync('git', ['add', manifestName], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'configure factory'], { cwd: repoDir });

    const claudeTarget = join(binDir, 'claude');
    copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
    chmodSync(claudeTarget, 0o755);

    const previousPath = process.env.PATH;
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.env.XDG_DATA_HOME = xdgDataHome;

    const { server, sessionManager, shutdown } = createReviewServer({ dbPath });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    context.after(async () => {
      await shutdown();
      process.env.PATH = previousPath;
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
      rmSync(rootDir, { recursive: true, force: true });
    });

    const createFlow = async (value: string, title: string) => {
      const response = await fetch(`${baseUrl}/api/factory/flows`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: { inputType: 'title', value, repoPath: repoDir },
          title,
          startSession: true,
          cols: 100,
          rows: 30,
        }),
      });
      assert.equal(response.status, 201);
      return (await response.json()) as {
        flow: { id: string; state: string; currentStage: string; currentSessionId: string | null };
        session: BackgroundSessionSummary;
      };
    };

    const [createdOne, createdTwo] = await Promise.all([
      createFlow('Implementar autenticação JWT', 'Fluxo 1 · JWT'),
      createFlow('Corrigir paginação de auditoria', 'Fluxo 2 · Paginação'),
    ]);

    assert.notEqual(createdOne.flow.id, createdTwo.flow.id);
    assert.notEqual(createdOne.session.sessionId, createdTwo.session.sessionId);
    assert(createdOne.session.reportPath && createdTwo.session.reportPath);
    assert.notEqual(createdOne.session.reportPath, createdTwo.session.reportPath);
    assert(createdOne.session.sessionPath && createdTwo.session.sessionPath);
    assert.notEqual(createdOne.session.sessionPath, createdTwo.session.sessionPath);

    await waitFor(() => {
      const s1 = sessionManager.getSession(createdOne.session.sessionId);
      const s2 = sessionManager.getSession(createdTwo.session.sessionId);
      return Boolean(s1?.buffer.replay().includes('READY:') && s2?.buffer.replay().includes('READY:'));
    });

    // Salva especificações distintas para cada fluxo no mesmo repositório.
    writeFileSync(createdOne.session.reportPath, triageMarkdown('JWT isolado.'));
    writeFactoryStageSidecar(createdOne.session.reportPath, 'triage');
    writeFileSync(createdTwo.session.reportPath, triageMarkdown('Paginação isolada.'));
    writeFactoryStageSidecar(createdTwo.session.reportPath, 'triage');

    sessionManager.writeInput(createdOne.session.sessionId, 'EXIT0');
    sessionManager.writeInput(createdTwo.session.sessionId, 'EXIT0');

    await waitFor(() => {
      const s1 = sessionManager.getSession(createdOne.session.sessionId);
      const s2 = sessionManager.getSession(createdTwo.session.sessionId);
      return s1?.status === 'exited' && s2?.status === 'exited';
    });

    // Ambos avançam automaticamente para planning com novas sessões isoladas.
    await waitFor(() => {
      const sessions = sessionManager.listSessions();
      const p1 = sessions.find(
        session => session.flowId === createdOne.flow.id && session.stage === 'planning',
      );
      const p2 = sessions.find(
        session => session.flowId === createdTwo.flow.id && session.stage === 'planning',
      );
      return Boolean(p1 && p2);
    });

    const [detailsOneRes, detailsTwoRes] = await Promise.all([
      fetch(`${baseUrl}/api/factory/flows/${createdOne.flow.id}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      }),
      fetch(`${baseUrl}/api/factory/flows/${createdTwo.flow.id}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      }),
    ]);
    assert.equal(detailsOneRes.status, 200);
    assert.equal(detailsTwoRes.status, 200);

    const detailsOne = FactoryFlowDetailsSchema.parse(await detailsOneRes.json());
    const detailsTwo = FactoryFlowDetailsSchema.parse(await detailsTwoRes.json());
    assert.equal(detailsOne.flow.currentStage, 'planning');
    assert.equal(detailsTwo.flow.currentStage, 'planning');
    assert.ok(detailsOne.flow.currentSessionId && detailsTwo.flow.currentSessionId);
    assert.ok(detailsOne.worktreePath && detailsTwo.worktreePath);
    assert.notEqual(detailsOne.worktreePath, detailsTwo.worktreePath);
    assert.notEqual(detailsOne.worktreePath, repoDir);
    assert.equal(detailsOne.branchName, 'feat/implementar-autenticacao-jwt-factory');
    assert.equal(detailsTwo.branchName, 'feat/corrigir-paginacao-de-auditoria-factory');
    assert.equal(detailsOne.baseBranch, 'integration');
    assert.equal(detailsTwo.baseBranch, 'integration');
    assert.equal(existsSync(detailsOne.worktreePath), true);
    assert.equal(existsSync(detailsTwo.worktreePath), true);
    assert.equal(existsSync(join(detailsOne.worktreePath, manifestName)), false);

    const planningSessionOne = detailsOne.flow.currentSessionId;
    const planningSessionTwo = detailsTwo.flow.currentSessionId;
    await waitFor(() => {
      const p1 = sessionManager.getSession(planningSessionOne);
      const p2 = sessionManager.getSession(planningSessionTwo);
      return (
        /READY:[^\n]*\n/.test(p1?.buffer.replay() ?? '') &&
        /READY:[^\n]*\n/.test(p2?.buffer.replay() ?? '')
      );
    });
    const planningOutput = sessionManager.getSession(planningSessionOne)?.buffer.replay() ?? '';
    assert.match(planningOutput, /O domínio depende de interfaces\./);

    const planPath = sessionManager.getSession(planningSessionOne)?.reportPath;
    assert.ok(planPath);
    writeFileSync(planPath, planningMarkdown('Ajustar JWT.'));
    writeFactoryStageSidecar(planPath, 'planning');
    const invalidPlanPath = sessionManager.getSession(planningSessionTwo)?.reportPath;
    assert.ok(invalidPlanPath);
    writeFileSync(invalidPlanPath, planningMarkdown('Ajustar paginação.'));
    writeFactoryStageSidecar(invalidPlanPath, 'planning', {
      pendingDecisions: [
        { question: 'Motor de paginação?', options: ['A', 'B'], recommendedOption: 'C' },
      ],
    });
    sessionManager.writeInput(planningSessionOne, 'EXIT0');
    sessionManager.writeInput(planningSessionTwo, 'EXIT0');
    await waitFor(() => {
      const p1 = sessionManager.getSession(planningSessionOne);
      const p2 = sessionManager.getSession(planningSessionTwo);
      return p1?.status === 'exited' && p2?.status === 'exited';
    });

    const [afterPlanOneRes, afterPlanTwoRes] = await Promise.all([
      fetch(`${baseUrl}/api/factory/flows/${createdOne.flow.id}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      }),
      fetch(`${baseUrl}/api/factory/flows/${createdTwo.flow.id}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      }),
    ]);
    const afterPlanOne = FactoryFlowDetailsSchema.parse(await afterPlanOneRes.json());
    const afterPlanTwo = FactoryFlowDetailsSchema.parse(await afterPlanTwoRes.json());
    assert.equal(afterPlanOne.flow.state, 'waiting_action');
    assert.equal(afterPlanTwo.flow.state, 'waiting_action');
    const invalidPlan = afterPlanTwo.artifacts.find(artifact => artifact.path === invalidPlanPath);
    assert.equal(invalidPlan?.status, 'incomplete');
    assert.equal(invalidPlan.error?.code, 'FACTORY_SIDECAR_INVALID_SCHEMA');
    assert.deepEqual(afterPlanTwo.flow.error, invalidPlan.error);
    assert.deepEqual(invalidPlan.error.issues, [
      {
        code: 'custom',
        path: ['pendingDecisions', 0, 'recommendedOption'],
        message: 'A recomendação deve corresponder a uma das opções',
      },
    ]);

    const specOne = afterPlanOne.artifacts.find(
      artifact => artifact.stage === 'triage' && artifact.kind === 'specification',
    );
    const specTwo = afterPlanTwo.artifacts.find(
      artifact => artifact.stage === 'triage' && artifact.kind === 'specification',
    );
    assert(specOne && specTwo);
    assert.equal(specOne.path, createdOne.session.reportPath);
    assert.equal(specTwo.path, createdTwo.session.reportPath);

    const postAction = (action: string, data: object, flowId = createdOne.flow.id) =>
      fetch(`${baseUrl}/api/factory/flows/${flowId}/${action}`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    const getDetails = async () => {
      const response = await fetch(`${baseUrl}/api/factory/flows/${createdOne.flow.id}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(response.status, 200);
      return FactoryFlowDetailsSchema.parse(await response.json());
    };

    const noPlan = await postAction('advance', { startSession: true }, createdTwo.flow.id);
    assert.equal(noPlan.status, 409);
    const planError = FactoryFlowApiErrorResponseSchema.parse(await noPlan.json());
    assert.match(planError.error.details?.[0] ?? '', /\$\.pendingDecisions\[0\]\.recommendedOption/);

    writeFileSync(
      getFactoryStageSidecarPath(specOne.path),
      JSON.stringify({ ...sidecarFixtures.triage, technicalContext: 42 }),
    );
    const approvedNotes = 'Usar a opção 2 para renovação do JWT.';
    const invalidTriage = await postAction('advance', { startSession: false, approvedNotes });
    assert.equal(invalidTriage.status, 409);
    const triageError = FactoryFlowApiErrorResponseSchema.parse(await invalidTriage.json());
    assert.equal(triageError.error.code, 'FACTORY_FLOW_INVALID_CONTRACT');
    assert.match(triageError.error.details?.[0] ?? '', /^\$\.technicalContext /);
    writeFactoryStageSidecar(specOne.path, 'triage');
    assert.deepEqual(await getDetails(), afterPlanOne);

    const developmentResponse = await postAction('advance', { startSession: true, approvedNotes });
    assert.equal(developmentResponse.status, 200);
    const development = z.object({ session: BackgroundSessionSummarySchema }).parse(
      await developmentResponse.json(),
    ).session;
    assert.equal(development.stage, 'development');
    assert.ok(development.reportPath);
    assert.equal((await postAction('advance', { startSession: true })).status, 409);

    const implementationMarkdown = [
      '# Relatório de Implementação',
      '## Arquivos alterados',
      '- src/jwt.ts',
      '## Resumo das mudanças',
      'Renovação do JWT atualizada.',
      '## Status dos passos do plano',
      '| Passo do Plano | Status | Observações |',
      '| --- | --- | --- |',
      '| Ajustar JWT | Concluído | Código de produção atualizado |',
      '',
    ].join('\n');
    await waitFor(() =>
      Boolean(sessionManager.getSession(development.sessionId)?.buffer.replay().includes('READY:')),
    );
    writeFileSync(development.reportPath, implementationMarkdown);
    sessionManager.writeInput(development.sessionId, 'EXIT0');
    const incompleteDetails = await waitForFlowDetails(getDetails, details =>
      details.flow.error?.code === 'FACTORY_SIDECAR_MISSING',
    );
    assert.equal(incompleteDetails.flow.state, 'waiting_action');
    assert.equal(incompleteDetails.flow.currentStage, 'development');
    assert.ok(
      incompleteDetails.artifacts.some(
        artifact => artifact.kind === 'implementation_report' && artifact.status === 'incomplete',
      ),
    );
    assert.equal((await postAction('advance', { startSession: true })).status, 409);

    const rerunDevelopment = async () => {
      const response = await postAction('rerun', { stage: 'development' });
      assert.equal(response.status, 200);
      const body = z.object({ session: BackgroundSessionSummarySchema }).parse(await response.json());
      return body.session;
    };
    const failedChecksSession = await rerunDevelopment();
    assert.ok(failedChecksSession.reportPath);
    await waitFor(() => {
      const output = sessionManager.getSession(failedChecksSession.sessionId)?.buffer.replay();
      return /READY:[^\n]*\n/.test(output ?? '');
    });
    writeFileSync(failedChecksSession.reportPath, implementationMarkdown);
    writeFactoryStageSidecar(failedChecksSession.reportPath, 'development', {
      backendChecks: {
        typecheck: { command: ['claimed'], exitCode: 0, errorSummary: null },
        lint: { command: ['claimed'], exitCode: 0, errorSummary: null },
      },
    });
    const holdCheck = join(detailsOne.worktreePath, '.hold-check');
    const checkStarted = join(detailsOne.worktreePath, '.check-started');
    writeFileSync(holdCheck, '');
    assert.equal(existsSync(checkStarted), false);
    sessionManager.writeInput(failedChecksSession.sessionId, 'EXIT0');
    await waitFor(() => existsSync(checkStarted));
    assert.equal((await postAction('advance', { startSession: true })).status, 409);
    assert.equal((await postAction('rerun', { stage: 'development' })).status, 409);
    unlinkSync(holdCheck);
    unlinkSync(checkStarted);

    const pausedForChecks = await waitForFlowDetails(
      getDetails,
      details => details.flow.error?.code === 'FACTORY_DEVELOPMENT_CHECKS_FAILED',
    );
    assert.equal(pausedForChecks.flow.state, 'waiting_action');
    assert.equal(pausedForChecks.flow.currentStage, 'development');
    assert.equal(pausedForChecks.flow.currentSessionId, null);
    const failedSession = sessionManager.getSessionSummary(failedChecksSession.sessionId);
    assert.equal(failedSession?.exitCode, 0);
    assert.equal(failedSession.status, 'exited');
    assert.equal(failedSession.historyState, 'incomplete');
    const failedReport = pausedForChecks.artifacts.find(
      artifact => artifact.path === failedChecksSession.reportPath,
    );
    assert.equal(failedReport?.status, 'incomplete');
    assert.deepEqual(failedReport.error, pausedForChecks.flow.error);
    const failedSidecar = FactoryDevelopmentSidecarSchema.parse(
      JSON.parse(readFileSync(getFactoryStageSidecarPath(failedChecksSession.reportPath), 'utf8')),
    );
    assert.deepEqual(failedSidecar.backendChecks, {
      typecheck: {
        command: typecheck,
        exitCode: 17,
        errorSummary: 'O comando encerrou com código 17. Diagnósticos TS2307.',
      },
      lint: {
        command: lint,
        exitCode: 9,
        errorSummary: 'O comando encerrou com código 9. Diagnósticos E1000.',
      },
    });
    const blockedForChecks = await postAction('advance', { startSession: true });
    assert.equal(blockedForChecks.status, 409);
    const checksError = FactoryFlowApiErrorResponseSchema.parse(await blockedForChecks.json());
    assert.match(checksError.error.message, /typecheck.*código 17.*lint.*código 9/);

    mkdirSync(join(detailsOne.worktreePath, 'src'));
    writeFileSync(join(detailsOne.worktreePath, 'src', 'jwt.ts'), 'export const jwt = {};\n');
    const rerun = await rerunDevelopment();
    assert.ok(rerun.reportPath);
    const running = sessionManager.getSession(rerun.sessionId);
    assert.ok(running);
    await waitFor(() => /READY:[^\n]*\n/.test(running.buffer.replay()));
    const readyLine = running.buffer.replay().split(/\r?\n/).find(line => line.startsWith('READY:'));
    assert.ok(readyLine);
    const { args, cwd } = z.object({ args: z.array(z.string()), cwd: z.string() }).parse(
      JSON.parse(readyLine.slice('READY:'.length)) as unknown,
    );
    assert.equal(cwd, detailsOne.worktreePath);
    assert.notEqual(cwd, repoDir);
    const prompt = args.at(-1);
    assert.ok(prompt);
    assert.ok(prompt.includes(specOne.path));
    assert.ok(prompt.includes(planPath));
    assert.ok(prompt.includes(approvedNotes));
    assert.ok(prompt.includes(rerun.reportPath));
    assert.match(prompt, /deploy\/\*\*/);
    assert.doesNotMatch(prompt, /Paginação isolada/);
    assert.ok(args.includes('--restricted'));
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
    assert.match(args[args.indexOf('--allowedTools') + 1] ?? '', /Edit\(\*\*\/\*\.ts\)/);
    assert.match(args[args.indexOf('--disallowedTools') + 1] ?? '', /\.test\.\*/);
    assert.match(args[args.indexOf('--disallowedTools') + 1] ?? '', /\.spec\.\*/);

    writeFileSync(rerun.reportPath, implementationMarkdown);
    writeFactoryStageSidecar(rerun.reportPath, 'development', { changedFiles: ['src/jwt.ts'] });
    sessionManager.writeInput(rerun.sessionId, 'EXIT0');

    // 1. Development (iteração 1) conclui com relatório válido e dispara Tests automaticamente.
    await waitFor(() =>
      sessionManager
        .listSessions()
        .some(
          session =>
            session.flowId === createdOne.flow.id &&
            session.stage === 'tests' &&
            session.status === 'running',
        ),
    );
    const autoTestsOneDetails = await getDetails();
    assert.equal(autoTestsOneDetails.flow.currentStage, 'tests');
    assert.equal(autoTestsOneDetails.flow.state, 'running');
    assert.equal(autoTestsOneDetails.flow.iteration, 1);
    assert.ok(autoTestsOneDetails.flow.currentSessionId);
    const developmentSidecar = FactoryDevelopmentSidecarSchema.parse(
      JSON.parse(readFileSync(getFactoryStageSidecarPath(rerun.reportPath), 'utf8')),
    );
    const passedChecks = {
      typecheck: { command: typecheck, exitCode: 0, errorSummary: null },
      lint: { command: lint, exitCode: 0, errorSummary: null },
    };
    assert.deepEqual(developmentSidecar.backendChecks, passedChecks);
    assert.deepEqual(developmentSidecar.changedFiles, ['src/jwt.ts']);
    const testsSession = sessionManager.getSessionSummary(autoTestsOneDetails.flow.currentSessionId);
    assert.ok(testsSession);
    assert.equal(testsSession.stage, 'tests');
    assert.ok(testsSession.reportPath);
    assert.equal((await postAction('advance', { startSession: true })).status, 409);

    const runningTests = sessionManager.getSession(testsSession.sessionId);
    assert.ok(runningTests);
    await waitFor(() => /READY:[^\n]*\n/.test(runningTests.buffer.replay()));
    const testsReadyLine = runningTests.buffer.replay().split(/\r?\n/).find(line => line.startsWith('READY:'));
    assert.ok(testsReadyLine);
    const testsSpawn = z.object({ args: z.array(z.string()), cwd: z.string() }).parse(
      JSON.parse(testsReadyLine.slice('READY:'.length)) as unknown,
    );
    assert.equal(testsSpawn.cwd, detailsOne.worktreePath);
    const testsPrompt = testsSpawn.args.at(-1) ?? '';
    assert.ok(testsPrompt.includes(specOne.path));
    assert.ok(testsPrompt.includes(planPath));
    assert.ok(testsPrompt.includes(rerun.reportPath));
    assert.ok(testsPrompt.includes(JSON.stringify(passedChecks, null, 2)));
    assert.match(testsPrompt, /check\.mjs/);
    assert.ok(testsSpawn.args.includes('--restricted'));
    assert.equal(testsSpawn.args[testsSpawn.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash');
    const testsAllowedTools = (testsSpawn.args[testsSpawn.args.indexOf('--allowedTools') + 1] ?? '').split(',');
    assert.ok(testsAllowedTools.includes('Edit(**/*.test.*)'));
    assert.equal(testsAllowedTools.includes('Bash'), false);
    assert.ok(testsAllowedTools.includes(`Bash(node ./${checkScript} test)`));
    assert.ok(testsAllowedTools.includes(`Bash(node ./${checkScript} test *)`));
    assert.ok(testsAllowedTools.includes(`Bash(node ./${checkScript} coverage)`));
    assert.ok(testsAllowedTools.includes(`Bash(node ./${checkScript} coverage *)`));
    assert.equal(
      testsAllowedTools.some(entry => entry.includes('typecheck') || entry.includes('lint')),
      false,
    );
    const testsDisallowedTools = (
      testsSpawn.args[testsSpawn.args.indexOf('--disallowedTools') + 1] ?? ''
    ).split(',');
    assert.ok(testsDisallowedTools.includes('Bash(git push*)'));
    assert.ok(testsDisallowedTools.includes('Bash(curl*)'));
    assert.ok(testsDisallowedTools.includes('Edit(deploy/**)'));

    // O relatório de testes exige um sidecar válido antes do Code Review.
    const testsMarkdown = [
      '# Relatório de Testes',
      '## Arquivos de teste alterados',
      '- test/jwt.test.ts',
      '## Comandos executados',
      '- npm test (exit 1)',
      '## Resultados e cobertura',
      'FAIL: renovação de token expirado retornou 500 em src/jwt.ts:42.',
      '',
    ].join('\n');
    writeFileSync(testsSession.reportPath, testsMarkdown);
    writeFileSync(getFactoryStageSidecarPath(testsSession.reportPath), '{');
    sessionManager.writeInput(testsSession.sessionId, 'EXIT0');
    const incompleteTestsDetails = await waitForFlowDetails(getDetails, details =>
      details.flow.error?.code === 'FACTORY_SIDECAR_INVALID_JSON',
    );
    assert.equal(incompleteTestsDetails.flow.state, 'waiting_action');
    assert.equal(incompleteTestsDetails.flow.currentStage, 'tests');
    assert.ok(
      incompleteTestsDetails.artifacts.some(
        artifact => artifact.kind === 'test_report' && artifact.status === 'incomplete',
      ),
    );
    assert.equal((await postAction('advance', { startSession: true })).status, 409);

    // 2. Reexecução de Tests: mesmo se a IA alegar PASS, o backend sobrescreve com exitCode/cobertura reais e avança para Review (double-check).
    const rerunTestsResponse = await postAction('rerun', { stage: 'tests' });
    assert.equal(rerunTestsResponse.status, 200);
    const rerunTests = z.object({ session: BackgroundSessionSummarySchema }).parse(
      await rerunTestsResponse.json(),
    ).session;
    assert.ok(rerunTests.reportPath);
    await waitFor(() => Boolean(sessionManager.getSession(rerunTests.sessionId)?.buffer.replay().includes('READY:')));
    writeFileSync(rerunTests.reportPath, testsMarkdown);
    writeFactoryStageSidecar(rerunTests.reportPath, 'tests', {
      status: 'passed',
      executedCommands: [{ command: ['claimed'], exitCode: 0 }],
      coverage: { linesPercent: 100, branchesPercent: 100 },
    });
    const holdTest = join(detailsOne.worktreePath, '.hold-test');
    const testStarted = join(detailsOne.worktreePath, '.test-started');
    writeFileSync(holdTest, '');
    assert.equal(existsSync(testStarted), false);
    sessionManager.writeInput(rerunTests.sessionId, 'EXIT0');
    await waitFor(() => existsSync(testStarted));
    assert.equal((await postAction('advance', { startSession: true })).status, 409);
    assert.equal((await postAction('rerun', { stage: 'tests' })).status, 409);
    unlinkSync(holdTest);
    unlinkSync(testStarted);

    await waitFor(() =>
      sessionManager
        .listSessions()
        .some(
          session =>
            session.flowId === createdOne.flow.id &&
            session.stage === 'review' &&
            session.status === 'running',
        ),
    );
    const failedTestsSidecar = FactoryTestsSidecarSchema.parse(
      JSON.parse(readFileSync(getFactoryStageSidecarPath(rerunTests.reportPath), 'utf8')),
    );
    const expectedFailedTestResults = {
      status: 'failed',
      executedCommands: [
        { command: testCommand, exitCode: 1 },
        { command: coverageCommand, exitCode: 1 },
      ],
      coverage: { linesPercent: 62.5, branchesPercent: 50 },
      backendChecks: {
        test: {
          command: testCommand,
          exitCode: 1,
          errorSummary: 'O comando encerrou com código 1. Falharam 2 teste(s).',
        },
        coverage: {
          command: coverageCommand,
          exitCode: 1,
          errorSummary: 'O comando encerrou com código 1.',
        },
      },
    };
    assert.equal(failedTestsSidecar.status, expectedFailedTestResults.status);
    assert.deepEqual(failedTestsSidecar.executedCommands, expectedFailedTestResults.executedCommands);
    assert.deepEqual(failedTestsSidecar.coverage, expectedFailedTestResults.coverage);
    assert.deepEqual(failedTestsSidecar.backendChecks, expectedFailedTestResults.backendChecks);
    const autoReviewOneDetails = await getDetails();
    assert.equal(autoReviewOneDetails.flow.currentStage, 'review');
    assert.equal(autoReviewOneDetails.flow.state, 'running');
    assert.equal(autoReviewOneDetails.flow.iteration, 1);
    assert.ok(autoReviewOneDetails.flow.currentSessionId);
    const reviewSession = sessionManager.getSessionSummary(autoReviewOneDetails.flow.currentSessionId);
    assert.ok(reviewSession);
    assert.equal(reviewSession.stage, 'review');
    assert.ok(reviewSession.reportPath);

    const runningReview = sessionManager.getSession(reviewSession.sessionId);
    assert.ok(runningReview);
    await waitFor(() => /READY:[^\n]*\n/.test(runningReview.buffer.replay()));
    const reviewReadyLine = runningReview.buffer.replay().split(/\r?\n/).find(line => line.startsWith('READY:'));
    assert.ok(reviewReadyLine);
    const reviewSpawn = z.object({ args: z.array(z.string()), cwd: z.string() }).parse(
      JSON.parse(reviewReadyLine.slice('READY:'.length)) as unknown,
    );
    assert.equal(reviewSpawn.cwd, detailsOne.worktreePath);
    const reviewPrompt = reviewSpawn.args.at(-1) ?? '';
    assert.ok(reviewPrompt.includes(specOne.path));
    assert.ok(reviewPrompt.includes(planPath));
    assert.ok(reviewPrompt.includes(rerun.reportPath));
    assert.ok(reviewPrompt.includes(rerunTests.reportPath));
    assert.ok(reviewPrompt.includes(JSON.stringify(expectedFailedTestResults, null, 2)));
    assert.ok(reviewSpawn.args.includes('--restricted'));
    const reviewAllowedTools = reviewSpawn.args[reviewSpawn.args.indexOf('--allowedTools') + 1] ?? '';
    assert.ok(reviewAllowedTools.includes('Bash(git diff*)'));
    assert.ok(reviewAllowedTools.includes('Bash(git status*)'));
    assert.ok(reviewAllowedTools.includes('Bash(git log*)'));
    assert.equal(reviewAllowedTools.includes('Edit(**/*.ts)'), false);

    // O Markdown com veredito de aprovação exige o sidecar antes da etapa de PR.
    const approvedReviewMarkdown = [
      '# Relatório de Code Review',
      '## Resumo Executivo',
      'Correção confirmada e aderente ao plano.',
      '## Pontos Encontrados',
      'Nenhum bloqueador crítico.',
      '## Como Testar Manualmente',
      '1. Enviar token válido e expirado e confirmar respostas 200 e 401.',
      '## Parecer Final',
      'Veredito: APROVADO PARA PR',
      'Pronto para preparar o Pull Request.',
      '',
    ].join('\n');
    writeFileSync(reviewSession.reportPath, approvedReviewMarkdown);
    sessionManager.writeInput(reviewSession.sessionId, 'EXIT0');
    const incompleteReview = await waitForFlowDetails(getDetails, details =>
      details.flow.error?.code === 'FACTORY_SIDECAR_MISSING',
    );
    assert.equal(incompleteReview.flow.state, 'waiting_action');
    assert.equal(incompleteReview.flow.currentStage, 'review');
    assert.equal((await postAction('advance', { startSession: true })).status, 409);

    // 3. Review confirma falha (REPROVADO / REQUER AJUSTES) e retorna AUTOMATICAMENTE para Development (Iteração 2/3).
    const rerunReviewResponse = await postAction('rerun', { stage: 'review' });
    assert.equal(rerunReviewResponse.status, 200);
    const rerunReview = z.object({ session: BackgroundSessionSummarySchema }).parse(
      await rerunReviewResponse.json(),
    ).session;
    assert.ok(rerunReview.reportPath);
    await waitFor(() => Boolean(sessionManager.getSession(rerunReview.sessionId)?.buffer.replay().includes('READY:')));
    const rejectedReviewMarkdown = [
      '# Relatório de Code Review',
      '## Resumo Executivo',
      'Double-check confirmou o erro 500 reportado pelos testes em src/jwt.ts:42.',
      '## Pontos Encontrados',
      '- [BLOQUEANTE] src/jwt.ts:42 lança erro não tratado ao validar token expirado; retornar 401.',
      '## Como Testar Manualmente',
      '1. Reproduzir enviando token expirado e conferir retorno HTTP 500.',
      '## Parecer Final',
      'Veredito: REPROVADO / REQUER AJUSTES',
      'Corrigir tratamento de token expirado em src/jwt.ts.',
      '',
    ].join('\n');
    writeFileSync(rerunReview.reportPath, rejectedReviewMarkdown);
    writeFactoryStageSidecar(rerunReview.reportPath, 'review', {
      verdict: 'changes_requested',
      returnTarget: 'development',
    });
    sessionManager.writeInput(rerunReview.sessionId, 'EXIT0');

    await waitFor(() => {
      const sessions = sessionManager.listSessions().filter(
        session => session.flowId === createdOne.flow.id && session.stage === 'development',
      );
      return sessions.some(
        session =>
          session.sessionId !== development.sessionId &&
          session.sessionId !== rerun.sessionId &&
          session.status === 'running',
      );
    });
    const iter2DevDetails = await getDetails();
    assert.equal(iter2DevDetails.flow.currentStage, 'development');
    assert.equal(iter2DevDetails.flow.state, 'running');
    assert.equal(iter2DevDetails.flow.iteration, 2);
    assert.ok(iter2DevDetails.flow.currentSessionId);
    const iter2DevSession = sessionManager.getSession(iter2DevDetails.flow.currentSessionId);
    assert.ok(iter2DevSession && iter2DevSession.reportPath);
    await waitFor(() => /READY:[^\n]*\n/.test(iter2DevSession.buffer.replay()));
    const iter2DevReadyLine = iter2DevSession.buffer.replay().split(/\r?\n/).find(line => line.startsWith('READY:'));
    assert.ok(iter2DevReadyLine);
    const iter2DevArgs = z.object({ args: z.array(z.string()) }).parse(
      JSON.parse(iter2DevReadyLine.slice('READY:'.length)) as unknown,
    ).args;
    const iter2DevPrompt = iter2DevArgs.at(-1) ?? '';
    // Na iteração 2+, o prompt de Development recebe os últimos relatórios + notas aprovadas originais.
    assert.ok(iter2DevPrompt.includes('Iteração 2/3'));
    assert.ok(iter2DevPrompt.includes(specOne.path));
    assert.ok(iter2DevPrompt.includes(planPath));
    assert.ok(iter2DevPrompt.includes(rerun.reportPath));
    assert.ok(iter2DevPrompt.includes(rerunTests.reportPath));
    assert.ok(iter2DevPrompt.includes(rerunReview.reportPath));
    assert.ok(iter2DevPrompt.includes(approvedNotes));

    // Development (Iteração 2) conclui -> dispara Tests (Iteração 2) automaticamente.
    writeFileSync(iter2DevSession.reportPath, [
      '# Relatório de Implementação',
      '## Arquivos alterados',
      '- src/jwt.ts',
      '## Resumo das mudanças',
      'Tratamento de token expirado corrigido para 401.',
      '## Status dos passos do plano',
      '| Passo do Plano | Status | Observações |',
      '| --- | --- | --- |',
      '| Ajustar JWT | Concluído | Correção aplicada na iteração 2 |',
      '',
    ].join('\n'));
    writeFactoryStageSidecar(iter2DevSession.reportPath, 'development', { changedFiles: ['src/jwt.ts'] });
    sessionManager.writeInput(iter2DevSession.sessionId, 'EXIT0');

    await waitFor(() => {
      const sessions = sessionManager.listSessions().filter(
        session => session.flowId === createdOne.flow.id && session.stage === 'tests',
      );
      return sessions.some(
        session =>
          session.sessionId !== testsSession.sessionId &&
          session.sessionId !== rerunTests.sessionId &&
          session.status === 'running',
      );
    });
    const iter2TestsDetails = await getDetails();
    assert.equal(iter2TestsDetails.flow.currentStage, 'tests');
    assert.equal(iter2TestsDetails.flow.iteration, 2);
    assert.ok(iter2TestsDetails.flow.currentSessionId);
    const iter2TestsSession = sessionManager.getSession(iter2TestsDetails.flow.currentSessionId);
    assert.ok(iter2TestsSession && iter2TestsSession.reportPath);
    await waitFor(() => iter2TestsSession.buffer.replay().includes('READY:'));
    writeFileSync(join(detailsOne.worktreePath, '.tests-passing'), '');
    writeFileSync(
      iter2TestsSession.reportPath,
      [
        '# Relatório de Testes',
        '## Arquivos de teste alterados',
        '- test/jwt.test.ts',
        '## Comandos executados',
        '- npm test (exit 0)',
        '## Resultados e cobertura',
        'PASS: todos os testes passaram na iteração 2.',
        '',
      ].join('\n'),
    );
    writeFactoryStageSidecar(iter2TestsSession.reportPath, 'tests');
    sessionManager.writeInput(iter2TestsSession.sessionId, 'EXIT0');

    // Tests (Iteração 2) conclui -> dispara Review (Iteração 2) automaticamente.
    await waitFor(() => {
      const sessions = sessionManager.listSessions().filter(
        session => session.flowId === createdOne.flow.id && session.stage === 'review',
      );
      return sessions.some(
        session =>
          session.sessionId !== reviewSession.sessionId &&
          session.sessionId !== rerunReview.sessionId &&
          session.status === 'running',
      );
    });
    const passedTestsSidecar = FactoryTestsSidecarSchema.parse(
      JSON.parse(readFileSync(getFactoryStageSidecarPath(iter2TestsSession.reportPath), 'utf8')),
    );
    assert.equal(passedTestsSidecar.status, 'passed');
    assert.deepEqual(passedTestsSidecar.executedCommands, [
      { command: testCommand, exitCode: 0 },
      { command: coverageCommand, exitCode: 0 },
    ]);
    assert.deepEqual(passedTestsSidecar.coverage, { linesPercent: 94.5, branchesPercent: 82.25 });
    assert.deepEqual(passedTestsSidecar.backendChecks, {
      test: { command: testCommand, exitCode: 0, errorSummary: null },
      coverage: { command: coverageCommand, exitCode: 0, errorSummary: null },
    });
    const iter2ReviewDetails = await getDetails();
    assert.equal(iter2ReviewDetails.flow.currentStage, 'review');
    assert.equal(iter2ReviewDetails.flow.iteration, 2);
    assert.ok(iter2ReviewDetails.flow.currentSessionId);
    const iter2ReviewSession = sessionManager.getSession(iter2ReviewDetails.flow.currentSessionId);
    assert.ok(iter2ReviewSession && iter2ReviewSession.reportPath);
    await waitFor(() => /READY:[^\n]*\n/.test(iter2ReviewSession.buffer.replay()));
    const iter2ReviewReadyLine = iter2ReviewSession.buffer
      .replay()
      .split(/\r?\n/)
      .find(line => line.startsWith('READY:'));
    assert.ok(iter2ReviewReadyLine);
    const iter2ReviewPrompt =
      z
        .object({ args: z.array(z.string()) })
        .parse(JSON.parse(iter2ReviewReadyLine.slice('READY:'.length)) as unknown)
        .args.at(-1) ?? '';
    assert.ok(iter2ReviewPrompt.includes('"linesPercent": 94.5'));
    assert.ok(iter2ReviewPrompt.includes('"branchesPercent": 82.25'));
    writeFileSync(iter2ReviewSession.reportPath, approvedReviewMarkdown);
    writeFactoryStageSidecar(iter2ReviewSession.reportPath, 'review');
    sessionManager.writeInput(iter2ReviewSession.sessionId, 'EXIT0');

    // 4. Review aprovado -> avança para PR e PAUSA em waiting_action (100% manual!).
    const prPausedDetails = await waitForFlowDetails(
      getDetails,
      details => details.flow.currentStage === 'pr' && details.flow.state === 'waiting_action',
    );
    assert.equal(prPausedDetails.flow.currentStage, 'pr');
    assert.equal(prPausedDetails.flow.state, 'waiting_action');
    assert.equal(prPausedDetails.flow.currentSessionId, null);
    assert.equal(prPausedDetails.flow.lastReviewVerdict, 'approved');
    assert.ok(prPausedDetails.baseBranch && prPausedDetails.branchName);
    assert.equal(prPausedDetails.flow.iteration, 2);
    assert.ok(!sessionManager.listSessions().some(session => session.stage === 'pr'));

    // Verifica histórico de artefatos por iteração persistido no banco.
    assert.equal(
      prPausedDetails.artifacts.filter(
        artifact => artifact.kind === 'review_report' && artifact.status === 'ready',
      ).length,
      2,
    );

    // 5. O runner de PR revalida o sidecar do Code Review antes de usar o relatório pronto.
    writeFileSync(getFactoryStageSidecarPath(iter2ReviewSession.reportPath), '{');
    const invalidHandoff = await postAction('start', { stage: 'pr' });
    assert.equal(invalidHandoff.status, 409);
    const handoffError = FactoryFlowApiErrorResponseSchema.parse(await invalidHandoff.json());
    assert.match(handoffError.error.message, /sidecar contém JSON inválido/);
    assert.match(handoffError.error.details?.[0] ?? '', /^\$ \(/);
    writeFactoryStageSidecar(iter2ReviewSession.reportPath, 'review');

    const startPrRes = await postAction('start', { stage: 'pr' });
    assert.equal(startPrRes.status, 200);
    const prSession = z.object({ session: BackgroundSessionSummarySchema }).parse(
      await startPrRes.json(),
    ).session;
    assert.equal(prSession.stage, 'pr');
    assert.ok(prSession.reportPath);
    const runningPr = sessionManager.getSession(prSession.sessionId);
    assert.ok(runningPr);
    await waitFor(() => /READY:[^\n]*\n/.test(runningPr.buffer.replay()));
    assert.match(runningPr.buffer.replay(), /## Evidências do time/);
    writeFileSync(
      prSession.reportPath,
      [
        '# Resumo do Pull Request',
        '## Resumo das Alterações',
        'Renovação de JWT ajustada.',
        '## Validação e Evidências',
        '| ID | Critério de Aceite | Status | Evidência |',
        '| --- | --- | --- | --- |',
        '| CA1 | Validar renovação de token | Atendido | npm test (exitCode 0) |',
        'Testes e Code Review aprovados.',
        '## Dados do Pull Request',
        `Título: fix(auth): ajustar renovação de JWT\nBranch ${prPausedDetails.branchName} -> ${prPausedDetails.baseBranch}.`,
        '',
      ].join('\n'),
    );
    writeFactoryStageSidecar(prSession.reportPath, 'pr', {
      baseBranch: prPausedDetails.baseBranch,
      headBranch: prPausedDetails.branchName,
    });
    rmSync(getFactoryStageSidecarPath(iter2ReviewSession.reportPath));
    sessionManager.writeInput(prSession.sessionId, 'EXIT0');
    const blockedPr = await waitForFlowDetails(getDetails, details =>
      details.flow.error?.code === 'FACTORY_SIDECAR_MISSING',
    );
    assert.equal(blockedPr.flow.currentStage, 'pr');
    assert.equal(blockedPr.flow.state, 'waiting_action');
    assert.equal(blockedPr.flow.currentSessionId, null);
    assert.match(blockedPr.flow.error?.message ?? '', /sidecar JSON está ausente.*review/);
    assert.ok(existsSync(detailsOne.worktreePath));

    const completion = { to: 'completed', reason: 'Concluir o fluxo após validar os artefatos' };
    const invalidCompletion = await postAction('transitions', completion);
    assert.equal(invalidCompletion.status, 409);
    writeFactoryStageSidecar(iter2ReviewSession.reportPath, 'review');
    const completedResponse = await postAction('transitions', completion);
    assert.equal(completedResponse.status, 200);
    const completedPrDetails = await getDetails();
    assert.equal(completedPrDetails.flow.currentStage, 'pr');
    assert.equal(completedPrDetails.flow.state, 'completed');
    assert.equal(completedPrDetails.flow.error, null);
    assert.equal(completedPrDetails.worktreePath, null);
    assert.ok(completedPrDetails.branchName);
    assert.ok(completedPrDetails.checkpoints.length >= 4);
    assert.equal(existsSync(detailsOne.worktreePath), false);

    const extraAdvanceRes = await postAction('advance', { startSession: false });
    assert.equal(extraAdvanceRes.status, 409);
    const extraAdvanceErr = FactoryFlowApiErrorResponseSchema.parse(await extraAdvanceRes.json());
    assert.equal(extraAdvanceErr.error.code, 'FACTORY_FLOW_INVALID_TRANSITION');

    // Confirma que o Fluxo 2 não foi afetado pelas transições do Fluxo 1.
    const checkTwoRes = await fetch(`${baseUrl}/api/factory/flows/${createdTwo.flow.id}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(checkTwoRes.status, 200);
    const checkTwo = FactoryFlowDetailsSchema.parse(await checkTwoRes.json());
    assert.equal(checkTwo.flow.currentStage, 'planning');
    assert.equal(checkTwo.flow.state, 'waiting_action');

    // Nenhum artefato ou pasta .code-reviews foi criado dentro do repositório alvo.
    assert.equal(existsSync(join(repoDir, '.code-reviews')), false);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }), '');
    const artifactsFlowOneDir = join(xdgDataHome, 'development-factory', 'artifacts', createdOne.flow.id);
    assert.equal(dirname(specOne.path), artifactsFlowOneDir);
    assert.equal(dirname(prSession.reportPath), artifactsFlowOneDir);
  },
);

const signedBlocker = {
  severity: 'BLOQUEANTE',
  file: 'src/feature.ts',
  line: 10,
  explanation: 'O fluxo aceita um estado inválido.',
  signature: 'estado-invalido',
  category: 'regressao',
} satisfies FactoryReviewSidecar['findings'][number];

const legacyBlocker = {
  severity: 'BLOQUEANTE',
  file: 'test/feature.test.ts',
  line: 12,
  explanation: 'Cobrir a entrada vazia.',
} satisfies FactoryReviewSidecar['findings'][number];

const loopScenarios = [
  {
    name: 'loop mantém o limite de três iterações quando há mudanças e resolução parcial',
    returnTarget: 'development',
    emptyDiff: false,
    findings: [
      [signedBlocker, legacyBlocker],
      [{ ...signedBlocker, category: 'requisito' }, { ...legacyBlocker, line: 19 }],
      [{ ...signedBlocker, file: 'src/other.ts', category: 'requisito' }],
    ],
    pausedReason: /Limite máximo de 3 iterações automáticas/,
  },
  {
    name: 'loop pausa no segundo ciclo quando os mesmos bloqueadores persistem apesar de mudanças',
    returnTarget: 'development',
    emptyDiff: false,
    findings: [
      [signedBlocker, legacyBlocker, { ...legacyBlocker, severity: 'SUGESTÃO' }],
      [
        {
          ...legacyBlocker,
          line: 29,
          explanation: 'COBRIR A  ENTRADA VAZIA.',
          signature: 'entrada-vazia',
          category: 'cobertura',
        },
        {
          ...signedBlocker,
          file: './src/feature.ts',
          line: 47,
          explanation: 'A validação ainda permite a transição inválida.',
          category: 'REGRESSAO',
        },
      ],
    ],
    pausedReason: /estagnação na iteração 2.*bloqueantes da iteração 1 continuam sem resolução/i,
  },
  {
    name: 'loop de testes pausa no segundo ciclo quando commits distintos têm diff vazio',
    returnTarget: 'tests',
    emptyDiff: true,
    findings: [[legacyBlocker], [{ ...legacyBlocker, explanation: 'Corrigir o mock de relógio.' }]],
    pausedReason: /estagnação na iteração 2.*diff entre os checkpoints das iterações 1 e 2 está vazio/i,
  },
] satisfies ReadonlyArray<{
  name: string;
  returnTarget: ReturnFactoryTargetStage;
  emptyDiff: boolean;
  findings: FactoryReviewSidecar['findings'][];
  pausedReason: RegExp;
}>;

for (const scenario of loopScenarios) {
  test(scenario.name, { timeout: 30000 }, async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-circuit-breaker-'));
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

    const { server, sessionManager, shutdown } = createReviewServer({ dbPath });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    context.after(async () => {
      await shutdown();
      process.env.PATH = previousPath;
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
      rmSync(rootDir, { recursive: true, force: true });
    });

    const createRes = await fetch(`${baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'title', value: 'Testar circuit breaker', repoPath: repoDir },
        startSession: true,
        cols: 100,
        rows: 30,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = z
      .object({ flow: FactoryFlowSchema, session: BackgroundSessionSummarySchema })
      .parse(await createRes.json());
    const flowId = created.flow.id;

    const getDetails = async () => {
      const response = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(response.status, 200);
      return FactoryFlowDetailsSchema.parse(await response.json());
    };

    const waitForStageSession = async (stage: string, seenSessionIds: Set<string>) => {
      let match: BackgroundSessionSummary | undefined;
      await waitFor(() => {
        match = sessionManager
          .listSessions()
          .find(
            session =>
              session.flowId === flowId &&
              session.stage === stage &&
              session.status === 'running' &&
              !seenSessionIds.has(session.sessionId),
          );
        return Boolean(match);
      });
      assert.ok(match);
      const { sessionId } = match;
      seenSessionIds.add(sessionId);
      await waitFor(() =>
        /READY:[^\n]*\n/.test(sessionManager.getSession(sessionId)?.buffer.replay() ?? ''),
      );
      return match;
    };

    const seen = new Set<string>([created.session.sessionId]);
    await waitFor(() =>
      /READY:[^\n]*\n/.test(sessionManager.getSession(created.session.sessionId)?.buffer.replay() ?? ''),
    );
    assert.ok(created.session.reportPath);
    writeFileSync(created.session.reportPath, triageMarkdown('Escopo definido.'));
    writeFactoryStageSidecar(created.session.reportPath, 'triage');
    sessionManager.writeInput(created.session.sessionId, 'EXIT0');

    const planningSession = await waitForStageSession('planning', seen);
    assert.ok(planningSession.reportPath);
    writeFileSync(planningSession.reportPath, planningMarkdown('Implementar a alteração.'));
    writeFactoryStageSidecar(planningSession.reportPath, 'planning');
    sessionManager.writeInput(planningSession.sessionId, 'EXIT0');
    await waitForFlowDetails(
      getDetails,
      details => details.flow.currentStage === 'planning' && details.flow.state === 'waiting_action',
    );

    const approveRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startSession: true }),
    });
    assert.equal(approveRes.status, 200);

    for (const [index, findings] of scenario.findings.entries()) {
      const iteration = index + 1;
      if (iteration === 1 || scenario.returnTarget === 'development') {
        const devSession = await waitForStageSession('development', seen);
        assert.ok(devSession.reportPath);
        writeFileSync(
          devSession.reportPath,
          [
            '# Relatório de Implementação',
            '## Arquivos alterados',
            '- src/feature.ts',
            '## Resumo das mudanças',
            `Tentativa ${iteration}`,
            '## Status dos passos do plano',
            '| Passo do Plano | Status | Observações |',
            '| --- | --- | --- |',
            `| Passo 1 | Concluído | Iteração ${iteration} |`,
          ].join('\n'),
        );
        writeFactoryStageSidecar(devSession.reportPath, 'development');
        sessionManager.writeInput(devSession.sessionId, 'EXIT0');
      }

      const testsSession = await waitForStageSession('tests', seen);
      assert.ok(testsSession.reportPath);
      const { worktreePath } = await getDetails();
      assert.ok(worktreePath);
      if (scenario.emptyDiff && iteration === 2) {
        execFileSync('git', ['commit', '--allow-empty', '-m', 'Tentativa sem mudanças'], {
          cwd: worktreePath,
        });
      } else {
        mkdirSync(join(worktreePath, 'test'), { recursive: true });
        writeFileSync(
          join(worktreePath, 'test/feature.test.ts'),
          `export const attempt = ${iteration};\n`,
        );
      }

      writeFileSync(
        testsSession.reportPath,
        [
          '# Relatório de Testes',
          '## Arquivos de teste alterados',
          '- test/feature.test.ts',
          '## Comandos executados',
          '- npm test (exit 1)',
          '## Resultados e cobertura',
          `FAIL na iteração ${iteration}.`,
        ].join('\n'),
      );
      writeFactoryStageSidecar(testsSession.reportPath, 'tests', {
        status: 'failed',
        executedCommands: [{ command: ['npm', 'test'], exitCode: 1 }],
      });
      sessionManager.writeInput(testsSession.sessionId, 'EXIT0');

      const reviewSession = await waitForStageSession('review', seen);
      assert.ok(reviewSession.reportPath);
      writeFileSync(
        reviewSession.reportPath,
        [
          '# Relatório de Code Review',
          '## Resumo Executivo',
          `Revisão da iteração ${iteration} requer ajustes.`,
          '## Pontos Encontrados',
          ...findings.map(
            finding =>
              `- [${finding.severity}] ${finding.file}:${finding.line} ${finding.explanation}`,
          ),
          '## Como Testar Manualmente',
          '1. Conferir o comportamento apontado nesta iteração.',
          '## Parecer Final',
          'Veredito: REPROVADO / REQUER AJUSTES',
          `Alvo de retorno: ${scenario.returnTarget}`,
        ].join('\n'),
      );
      writeFactoryStageSidecar(reviewSession.reportPath, 'review', {
        verdict: 'changes_requested',
        returnTarget: scenario.returnTarget,
        findings,
      });
      sessionManager.writeInput(reviewSession.sessionId, 'EXIT0');
      await waitFor(() => sessionManager.getSession(reviewSession.sessionId)?.status === 'exited');
    }

    const pausedDetails = await waitForFlowDetails(
      getDetails,
      details =>
        details.flow.state === 'waiting_action' && details.flow.loopPausedReason !== null,
    );
    assert.equal(pausedDetails.flow.currentStage, 'review');
    assert.equal(pausedDetails.flow.currentSessionId, null);
    assert.equal(pausedDetails.flow.iteration, scenario.findings.length);
    assert.equal(pausedDetails.flow.maxIterations, 3);
    assert.equal(pausedDetails.flow.lastReviewVerdict, 'changes_requested');
    assert.match(pausedDetails.flow.loopPausedReason ?? '', scenario.pausedReason);
    const flowSessions = sessionManager.listSessions().filter(session => session.flowId === flowId);
    assert.equal(
      flowSessions.filter(session => session.stage === 'development').length,
      scenario.returnTarget === 'development' ? scenario.findings.length : 1,
    );
    assert.equal(
      flowSessions.filter(session => session.stage === 'tests').length,
      scenario.findings.length,
    );
    assert.equal(
      flowSessions.filter(session => session.stage === 'review').length,
      scenario.findings.length,
    );
    if (scenario.emptyDiff) {
      const [first, second] = pausedDetails.checkpoints.filter(item => item.stage === 'tests');
      assert.ok(first && second);
      assert.notEqual(first.commitSha, second.commitSha);
    }
  });
}

test(
  'dois fluxos simultâneos no mesmo repoPath executam Desenvolvimento em paralelo em worktrees isolados sem tocar o working tree original',
  { timeout: 30000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-concurrent-worktrees-'));
    const binDir = join(rootDir, 'bin');
    const repoDir = join(rootDir, 'shared-repo');
    const xdgDataHome = join(rootDir, 'xdg-data');
    const dbPath = join(rootDir, 'reviews.db');
    mkdirSync(binDir);
    mkdirSync(repoDir);
    mkdirSync(xdgDataHome);
    initGitRepo(repoDir, 'main');

    // Desenvolvedor trabalha localmente em outra branch com alterações não commitadas.
    execFileSync('git', ['checkout', '-b', 'feature/dev-local'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'README.md'), '# Repo com WIP local\n');
    writeFileSync(join(repoDir, 'local-untracked.txt'), 'wip local não commitado\n');

    const claudeTarget = join(binDir, 'claude');
    copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
    chmodSync(claudeTarget, 0o755);

    const previousPath = process.env.PATH;
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.env.XDG_DATA_HOME = xdgDataHome;

    const { server, sessionManager, shutdown } = createReviewServer({ dbPath });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    context.after(async () => {
      await shutdown();
      process.env.PATH = previousPath;
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
      rmSync(rootDir, { recursive: true, force: true });
    });

    const createWithBaseMain = async (value: string) => {
      const response = await fetch(`${baseUrl}/api/factory/flows`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: { inputType: 'jira_key', value, repoPath: repoDir },
          baseBranch: 'main',
          startSession: true,
          cols: 100,
          rows: 30,
        }),
      });
      assert.equal(response.status, 201);
      return (await response.json()) as {
        flow: { id: string; worktreePath: string | null; branchName: string | null; baseBranch: string | null };
        session: BackgroundSessionSummary;
      };
    };

    const [flowOne, flowTwo] = await Promise.all([
      createWithBaseMain('PROD-101'),
      createWithBaseMain('PROD-102'),
    ]);

    assert.ok(flowOne.flow.worktreePath && flowTwo.flow.worktreePath);
    assert.notEqual(flowOne.flow.worktreePath, flowTwo.flow.worktreePath);
    assert.equal(flowOne.flow.branchName, 'factory/prod-101');
    assert.equal(flowTwo.flow.branchName, 'factory/prod-102');
    assert.equal(flowOne.flow.baseBranch, 'main');
    assert.equal(flowTwo.flow.baseBranch, 'main');

    // Conclui triagem e planejamento para os dois fluxos chegarem em waiting_action no planejamento.
    for (const item of [flowOne, flowTwo]) {
      assert.ok(item.session.reportPath);
      await waitFor(() => Boolean(sessionManager.getSession(item.session.sessionId)?.buffer.replay().includes('READY:')));
      writeFileSync(item.session.reportPath, triageMarkdown(`Escopo do fluxo ${item.flow.id}.`));
      writeFactoryStageSidecar(item.session.reportPath, 'triage');
      sessionManager.writeInput(item.session.sessionId, 'EXIT0');

      await waitFor(() =>
        sessionManager
          .listSessions()
          .some(s => s.flowId === item.flow.id && s.stage === 'planning' && s.status === 'running'),
      );
      const planningSession = sessionManager
        .listSessions()
        .find(s => s.flowId === item.flow.id && s.stage === 'planning');
      assert.ok(planningSession && planningSession.reportPath);
      await waitFor(() => Boolean(sessionManager.getSession(planningSession.sessionId)?.buffer.replay().includes('READY:')));
      writeFileSync(planningSession.reportPath, planningMarkdown(`Implementar ${item.flow.id}.`));
      writeFactoryStageSidecar(planningSession.reportPath, 'planning');
      sessionManager.writeInput(planningSession.sessionId, 'EXIT0');
      await waitFor(() => sessionManager.getSession(planningSession.sessionId)?.status === 'exited');
    }

    // Avança ambos os fluxos para Desenvolvimento (etapa mutante) simultaneamente!
    const [devResOne, devResTwo] = await Promise.all([
      fetch(`${baseUrl}/api/factory/flows/${flowOne.flow.id}/advance`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startSession: true }),
      }),
      fetch(`${baseUrl}/api/factory/flows/${flowTwo.flow.id}/advance`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startSession: true }),
      }),
    ]);
    assert.equal(devResOne.status, 200);
    assert.equal(devResTwo.status, 200);

    const devOne = z.object({ session: BackgroundSessionSummarySchema }).parse(await devResOne.json()).session;
    const devTwo = z.object({ session: BackgroundSessionSummarySchema }).parse(await devResTwo.json()).session;
    assert.equal(devOne.stage, 'development');
    assert.equal(devTwo.stage, 'development');
    assert.equal(devOne.status, 'running');
    assert.equal(devTwo.status, 'running');

    // Mesmo fluxo em execução continua bloqueado contra sessão duplicada.
    const duplicateSameFlowRes = await fetch(`${baseUrl}/api/factory/flows/${flowOne.flow.id}/rerun`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(duplicateSameFlowRes.status, 409);

    const runningOne = sessionManager.getSession(devOne.sessionId);
    const runningTwo = sessionManager.getSession(devTwo.sessionId);
    assert.ok(runningOne && runningTwo);
    await waitFor(
      () =>
        /READY:[^\n]*\n/.test(runningOne.buffer.replay()) &&
        /READY:[^\n]*\n/.test(runningTwo.buffer.replay()),
    );

    const parseReadyCwd = (replay: string): string => {
      const line = replay.split(/\r?\n/).find(item => item.startsWith('READY:'));
      assert.ok(line);
      return z.object({ cwd: z.string() }).parse(JSON.parse(line.slice('READY:'.length)) as unknown).cwd;
    };

    assert.equal(parseReadyCwd(runningOne.buffer.replay()), flowOne.flow.worktreePath);
    assert.equal(parseReadyCwd(runningTwo.buffer.replay()), flowTwo.flow.worktreePath);

    // Simula alterações independentes em cada worktree sem afetar o outro worktree nem o repositório original.
    writeFileSync(join(flowOne.flow.worktreePath, 'feature-101.ts'), 'export const id = 101;\n');
    writeFileSync(join(flowTwo.flow.worktreePath, 'feature-102.ts'), 'export const id = 102;\n');

    assert.equal(existsSync(join(flowOne.flow.worktreePath, 'feature-102.ts')), false);
    assert.equal(existsSync(join(flowTwo.flow.worktreePath, 'feature-101.ts')), false);
    assert.equal(existsSync(join(repoDir, 'feature-101.ts')), false);
    assert.equal(existsSync(join(repoDir, 'feature-102.ts')), false);
    assert.equal(
      execFileSync('git', ['branch', '--show-current'], { cwd: repoDir, encoding: 'utf8' }).trim(),
      'feature/dev-local',
    );
    assert.equal(readFileSync(join(repoDir, 'README.md'), 'utf8'), '# Repo com WIP local\n');
    assert.equal(readFileSync(join(repoDir, 'local-untracked.txt'), 'utf8'), 'wip local não commitado\n');
  },
);

test('API diagnostica branch base inexistente e manifesto inválido', async context => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-invalid-base-'));
  const binDir = join(rootDir, 'bin');
  const repoDir = join(rootDir, 'repo');
  const xdgDataHome = join(rootDir, 'xdg-data');
  const dbPath = join(rootDir, 'reviews.db');
  mkdirSync(binDir);
  mkdirSync(repoDir);
  mkdirSync(xdgDataHome);
  initGitRepo(repoDir, 'main');

  const claudeTarget = join(binDir, 'claude');
  copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
  chmodSync(claudeTarget, 0o755);

  const previousPath = process.env.PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.XDG_DATA_HOME = xdgDataHome;

  const { server, shutdown } = createReviewServer({ dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await shutdown();
    process.env.PATH = previousPath;
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  const response = await fetch(`${baseUrl}/api/factory/flows`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task: { inputType: 'jira_key', value: 'PROD-404', repoPath: repoDir },
      baseBranch: 'branch-inexistente',
      startSession: true,
      cols: 80,
      rows: 24,
    }),
  });
  assert.equal(response.status, 400);
  const errorBody = FactoryFlowApiErrorResponseSchema.parse(await response.json());
  assert.equal(errorBody.error.code, 'FACTORY_FLOW_INVALID_INPUT');
  assert.match(errorBody.error.message, /branch-inexistente/);

  const worktreesRoot = join(xdgDataHome, 'development-factory', 'worktrees');
  assert.deepEqual(existsSync(worktreesRoot) ? readdirSync(worktreesRoot) : [], []);

  const listedRes = await fetch(`${baseUrl}/api/factory/flows`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(listedRes.status, 200);
  const listed = FactoryFlowListResponseSchema.parse(await listedRes.json());
  assert.equal(listed.flows.length, 1);
  assert.equal(listed.flows[0]?.state, 'failed');
  assert.equal(listed.flows[0]?.worktreePath, null);

  writeFileSync(join(repoDir, '.development-factory.json'), '{"commands":{"test":"npm test"}}');
  const invalidManifestResponse = await fetch(`${baseUrl}/api/factory/flows`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task: { inputType: 'jira_key', value: 'PROD-405', repoPath: repoDir },
      startSession: true,
    }),
  });
  assert.equal(invalidManifestResponse.status, 400);
  const invalidManifest = FactoryFlowApiErrorResponseSchema.parse(
    await invalidManifestResponse.json(),
  );
  assert.equal(invalidManifest.error.code, 'FACTORY_FLOW_INVALID_INPUT');
  assert.match(invalidManifest.error.message, /\.development-factory\.json.*\ncommands\.test/);
  assert.deepEqual(existsSync(worktreesRoot) ? readdirSync(worktreesRoot) : [], []);
});

test(
  'checkpoints automáticos entre blocos/iterações, rollback determinístico via API e limpeza segura ao concluir preservando remoto',
  { timeout: 30000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-checkpoints-rollback-'));
    const binDir = join(rootDir, 'bin');
    const repoDir = join(rootDir, 'repo');
    const bareRemoteDir = join(rootDir, 'remote.git');
    const xdgDataHome = join(rootDir, 'xdg-data');
    const dbPath = join(rootDir, 'reviews.db');
    mkdirSync(binDir);
    mkdirSync(repoDir);
    mkdirSync(bareRemoteDir);
    mkdirSync(xdgDataHome);

    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bareRemoteDir });
    initGitRepo(repoDir, 'main');
    execFileSync('git', ['remote', 'add', 'origin', bareRemoteDir], { cwd: repoDir });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });

    const claudeTarget = join(binDir, 'claude');
    copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
    chmodSync(claudeTarget, 0o755);

    const previousPath = process.env.PATH;
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.env.XDG_DATA_HOME = xdgDataHome;

    const { server, sessionManager, shutdown } = createReviewServer({ dbPath });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    context.after(async () => {
      await shutdown();
      process.env.PATH = previousPath;
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
      rmSync(rootDir, { recursive: true, force: true });
    });

    const createRes = await fetch(`${baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'jira_key', value: 'PROD-900', repoPath: repoDir },
        baseBranch: 'main',
        startSession: true,
        cols: 100,
        rows: 30,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      flow: { id: string; worktreePath: string; branchName: string };
      session: BackgroundSessionSummary;
    };
    const flowId = created.flow.id;
    const worktreePath = created.flow.worktreePath;
    const branchName = created.flow.branchName;
    assert.ok(worktreePath && branchName);

    const getDetails = async () => {
      const response = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(response.status, 200);
      return FactoryFlowDetailsSchema.parse(await response.json());
    };

    const waitForStageSession = async (stage: string, seen: Set<string>) => {
      let match: BackgroundSessionSummary | undefined;
      await waitFor(() => {
        match = sessionManager
          .listSessions()
          .find(
            s =>
              s.flowId === flowId &&
              s.stage === stage &&
              s.status === 'running' &&
              !seen.has(s.sessionId),
          );
        return Boolean(match);
      });
      assert.ok(match);
      seen.add(match.sessionId);
      await waitFor(() =>
        /READY:[^\n]*\n/.test(sessionManager.getSession(match!.sessionId)?.buffer.replay() ?? ''),
      );
      return match;
    };

    const seen = new Set<string>([created.session.sessionId]);
    await waitFor(() =>
      /READY:[^\n]*\n/.test(sessionManager.getSession(created.session.sessionId)?.buffer.replay() ?? ''),
    );
    assert.ok(created.session.reportPath);
    writeFileSync(created.session.reportPath, triageMarkdown('Escopo definido.'));
    writeFactoryStageSidecar(created.session.reportPath, 'triage');
    sessionManager.writeInput(created.session.sessionId, 'EXIT0');

    const planSession = await waitForStageSession('planning', seen);
    assert.ok(planSession.reportPath);
    writeFileSync(planSession.reportPath, planningMarkdown('Implementar a funcionalidade.'));
    writeFactoryStageSidecar(planSession.reportPath, 'planning');
    sessionManager.writeInput(planSession.sessionId, 'EXIT0');
    await waitFor(() => sessionManager.getSession(planSession.sessionId)?.status === 'exited');

    const approveRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startSession: true }),
    });
    assert.equal(approveRes.status, 200);

    // Development Iteração 1: cria arquivo de produção no worktree.
    const dev1 = await waitForStageSession('development', seen);
    assert.ok(dev1.reportPath);
    // Rollback enquanto sessão está em execução deve ser bloqueado com 409.
    const rollbackWhileRunning = await fetch(`${baseUrl}/api/factory/flows/${flowId}/rollback`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(rollbackWhileRunning.status, 409);

    mkdirSync(join(worktreePath, 'src'), { recursive: true });
    writeFileSync(join(worktreePath, 'src', 'feature.ts'), 'export const step = "iter1";\n');
    writeFileSync(
      dev1.reportPath,
      [
        '# Relatório de Implementação',
        '## Arquivos alterados',
        '- src/feature.ts',
        '## Resumo das mudanças',
        'Implementação iter 1.',
        '## Status dos passos do plano',
        '| Passo | Status | Obs |',
        '| --- | --- | --- |',
        '| 1 | Concluído | Iter 1 |',
      ].join('\n'),
    );
    writeFactoryStageSidecar(dev1.reportPath, 'development');
    sessionManager.writeInput(dev1.sessionId, 'EXIT0');

    // Tests Iteração 1: adiciona arquivo de teste no worktree.
    const tests1 = await waitForStageSession('tests', seen);
    assert.ok(tests1.reportPath);
    mkdirSync(join(worktreePath, 'test'), { recursive: true });
    writeFileSync(join(worktreePath, 'test', 'feature.test.ts'), 'export const testOk = true;\n');
    writeFileSync(
      tests1.reportPath,
      [
        '# Relatório de Testes',
        '## Arquivos de teste alterados',
        '- test/feature.test.ts',
        '## Comandos executados',
        '- npm test',
        '## Resultados e cobertura',
        'FAIL na validação iter 1.',
      ].join('\n'),
    );
    writeFactoryStageSidecar(tests1.reportPath, 'tests', {
      status: 'failed',
      executedCommands: [{ command: ['npm', 'test'], exitCode: 1 }],
    });
    sessionManager.writeInput(tests1.sessionId, 'EXIT0');

    // Review Iteração 1: verifica checkpoints gravados até aqui e reprova para abrir Iteração 2.
    const review1 = await waitForStageSession('review', seen);
    assert.ok(review1.reportPath);
    const detailsBeforeIter2 = await getDetails();
    assert.equal(detailsBeforeIter2.checkpoints.length, 3);
    assert.equal(detailsBeforeIter2.checkpoints[0]?.iteration, 0);
    assert.equal(detailsBeforeIter2.checkpoints[1]?.stage, 'development');
    assert.equal(detailsBeforeIter2.checkpoints[1]?.iteration, 1);
    assert.equal(detailsBeforeIter2.checkpoints[2]?.stage, 'tests');
    assert.equal(detailsBeforeIter2.checkpoints[2]?.iteration, 1);
    const cpDev1 = detailsBeforeIter2.checkpoints[1]!;
    const cpTests1 = detailsBeforeIter2.checkpoints[2]!;
    assert.notEqual(cpDev1.commitSha, cpTests1.commitSha);

    // Simula push da branch dedicada para o remoto antes de prosseguir.
    execFileSync('git', ['push', '-u', 'origin', branchName], { cwd: worktreePath });

    writeFileSync(
      review1.reportPath,
      [
        '# Relatório de Code Review',
        '## Resumo Executivo',
        'Necessita ajuste.',
        '## Pontos Encontrados',
        '- [BLOQUEANTE] src/feature.ts:1 ajustar retorno.',
        '## Como Testar Manualmente',
        '1. Executar a rotina principal e verificar o retorno.',
        '## Parecer Final',
        'Veredito: REPROVADO / REQUER AJUSTES',
      ].join('\n'),
    );
    writeFactoryStageSidecar(review1.reportPath, 'review', {
      verdict: 'changes_requested',
      returnTarget: 'development',
    });
    sessionManager.writeInput(review1.sessionId, 'EXIT0');

    // Development Iteração 2: introduz regressão + arquivo extra e sai com relatório incompleto para pausar em waiting_action.
    const dev2 = await waitForStageSession('development', seen);
    assert.ok(dev2.reportPath);
    writeFileSync(join(worktreePath, 'src', 'feature.ts'), 'export const step = "regression-iter2";\n');
    writeFileSync(join(worktreePath, 'src', 'broken-extra.ts'), 'throw new Error("broken");\n');
    writeFileSync(dev2.reportPath, '# Relatório de Implementação\n\nIncompleto.\n');
    sessionManager.writeInput(dev2.sessionId, 'EXIT0');
    await waitFor(() => sessionManager.getSession(dev2.sessionId)?.status === 'exited');

    const pausedWithRegression = await waitForFlowDetails(
      getDetails,
      d => d.flow.state === 'waiting_action' && d.flow.currentSessionId === null,
    );
    assert.equal(pausedWithRegression.flow.iteration, 2);

    // Rollback automático (sem informar checkpointId) restaura o último checkpoint válido (cpTests1).
    const rollbackLatestRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/rollback`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Descartar regressão da iteração 2' }),
    });
    assert.equal(rollbackLatestRes.status, 200);
    const rolledBackToTests1 = RollbackFactoryFlowCheckpointResponseSchema.parse(
      await rollbackLatestRes.json(),
    );
    assert.equal(rolledBackToTests1.checkpoint.id, cpTests1.id);
    assert.equal(rolledBackToTests1.restoredCommitSha, cpTests1.commitSha);
    assert.equal(
      readFileSync(join(worktreePath, 'src', 'feature.ts'), 'utf8'),
      'export const step = "iter1";\n',
    );
    assert.equal(existsSync(join(worktreePath, 'src', 'broken-extra.ts')), false);
    assert.equal(existsSync(join(worktreePath, 'test', 'feature.test.ts')), true);

    // Rollback explícito para o checkpoint anterior (cpDev1) remove inclusive test/feature.test.ts.
    const rollbackExplicitRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/rollback`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkpointId: cpDev1.id }),
    });
    assert.equal(rollbackExplicitRes.status, 200);
    const rolledBackToDev1 = RollbackFactoryFlowCheckpointResponseSchema.parse(
      await rollbackExplicitRes.json(),
    );
    assert.equal(rolledBackToDev1.restoredCommitSha, cpDev1.commitSha);
    assert.equal(existsSync(join(worktreePath, 'test', 'feature.test.ts')), false);

    // Conclui o fluxo via desenvolvimento -> testes -> review -> PR e valida limpeza do worktree preservando o remoto.
    const rerunDevRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/rerun`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'development' }),
    });
    assert.equal(rerunDevRes.status, 200);
    const dev2Rerun = await waitForStageSession('development', seen);
    assert.ok(dev2Rerun.reportPath);
    writeFileSync(join(worktreePath, 'src', 'feature.ts'), 'export const step = "final-clean";\n');
    writeFileSync(
      dev2Rerun.reportPath,
      [
        '# Relatório de Implementação',
        '## Arquivos alterados',
        '- src/feature.ts',
        '## Resumo das mudanças',
        'Implementação final.',
        '## Status dos passos do plano',
        '| Passo | Status | Obs |',
        '| --- | --- | --- |',
        '| 1 | Concluído | Final |',
      ].join('\n'),
    );
    writeFactoryStageSidecar(dev2Rerun.reportPath, 'development');
    sessionManager.writeInput(dev2Rerun.sessionId, 'EXIT0');

    const tests2 = await waitForStageSession('tests', seen);
    assert.ok(tests2.reportPath);
    writeFileSync(
      tests2.reportPath,
      [
        '# Relatório de Testes',
        '## Arquivos de teste alterados',
        '- test/feature.test.ts',
        '## Comandos executados',
        '- npm test',
        '## Resultados e cobertura',
        'PASS 100%.',
      ].join('\n'),
    );
    writeFactoryStageSidecar(tests2.reportPath, 'tests');
    sessionManager.writeInput(tests2.sessionId, 'EXIT0');

    const review2 = await waitForStageSession('review', seen);
    assert.ok(review2.reportPath);
    writeFileSync(
      review2.reportPath,
      [
        '# Relatório de Code Review',
        '## Resumo Executivo',
        'Tudo certo.',
        '## Pontos Encontrados',
        'Nenhum.',
        '## Como Testar Manualmente',
        '1. Executar a rotina final e confirmar sucesso.',
        '## Parecer Final',
        'Veredito: APROVADO PARA PR',
      ].join('\n'),
    );
    writeFactoryStageSidecar(review2.reportPath, 'review');
    sessionManager.writeInput(review2.sessionId, 'EXIT0');

    await waitForFlowDetails(
      getDetails,
      d => d.flow.currentStage === 'pr' && d.flow.state === 'waiting_action',
    );

    const startPrRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/start`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'pr' }),
    });
    assert.equal(startPrRes.status, 200);
    const prSession = await waitForStageSession('pr', seen);
    assert.ok(prSession.reportPath);
    writeFileSync(
      prSession.reportPath,
      [
        '# Resumo do Pull Request',
        '## Resumo das Alterações',
        'Feature concluída.',
        '## Validação e Evidências',
        '| ID | Critério de Aceite | Status | Evidência |',
        '| --- | --- | --- | --- |',
        '| CA1 | Validar comportamento esperado | Atendido | npm test (exitCode 0) |',
        'Testes e Review aprovados.',
        '## Dados do Pull Request',
        `Título: feat(factory): concluir entrega\nBranch ${branchName} -> main.`,
      ].join('\n'),
    );
    writeFactoryStageSidecar(prSession.reportPath, 'pr', { headBranch: branchName });
    sessionManager.writeInput(prSession.sessionId, 'EXIT0');

    // Etapa 1 concluída: pausa em waiting_action com prGate pré-carregado para revisão humana (Etapa 2).
    const prReviewReady = await waitForFlowDetails(
      getDetails,
      d =>
        d.flow.currentStage === 'pr' &&
        d.flow.state === 'waiting_action' &&
        d.prGate !== undefined &&
        d.prGate !== null,
    );
    assert.equal(prReviewReady.prGate?.headBranch, branchName);
    assert.equal(prReviewReady.prGate?.baseBranch, 'main');
    assert.equal(prReviewReady.prGate?.confirmedForPublish, false);
    assert.equal(existsSync(worktreePath), true);

    const invalidPrReviewRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/pr-review`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'feat(factory): entrega revisada',
        description: 'Corpo validado.',
        baseBranch: 'HEAD',
        draft: false,
        reviewers: [],
        updateJira: false,
      }),
    });
    assert.equal(invalidPrReviewRes.status, 400);

    const savedPrReviewRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/pr-review`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'feat(factory): entrega revisada pelo humano',
        description: '## Resumo\n\nDescrição revisada antes do envio.',
        baseBranch: 'main',
        draft: true,
        reviewers: ['alice', 'team/core'],
        updateJira: false,
        confirmPublish: true,
      }),
    });
    assert.equal(savedPrReviewRes.status, 200);
    const savedPrReview = SaveFactoryPrReviewResponseSchema.parse(await savedPrReviewRes.json());
    assert.equal(savedPrReview.prGate.title, 'feat(factory): entrega revisada pelo humano');
    assert.equal(savedPrReview.prGate.draft, true);
    assert.deepEqual(savedPrReview.prGate.reviewers, ['alice', 'team/core']);
    assert.equal(savedPrReview.prGate.confirmedForPublish, true);
    assert.ok(savedPrReview.prGate.confirmedAt);
    assert.equal(existsSync(worktreePath), true);

    const completePrRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/transitions`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'completed', reason: 'Concluir o fluxo após revisão do PR' }),
    });
    assert.equal(completePrRes.status, 200);

    const completed = await waitForFlowDetails(getDetails, d => d.flow.state === 'completed');
    assert.equal(completed.worktreePath, null);
    assert.equal(completed.branchName, branchName);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(
      execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir, encoding: 'utf8' })
        .includes(worktreePath),
      false,
    );

    // Commits já enviados ao remoto permanecem intactos após a remoção do worktree.
    const remoteBranch = execFileSync(
      'git',
      ['ls-remote', '--heads', 'origin', branchName],
      { cwd: repoDir, encoding: 'utf8' },
    ).trim();
    assert.ok(remoteBranch.startsWith(cpTests1.commitSha));
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }), '');
  },
);

test(
  'política de retenção controla remoção de worktree ao cancelar fluxo (cleanup_on_finish vs keep_all)',
  { timeout: 30000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-retention-policy-'));
    const binDir = join(rootDir, 'bin');
    const repoDir = join(rootDir, 'repo');
    const xdgDataHome = join(rootDir, 'xdg-data');
    const dbCleanup = join(rootDir, 'cleanup.db');
    const dbKeep = join(rootDir, 'keep.db');
    mkdirSync(binDir);
    mkdirSync(repoDir);
    mkdirSync(xdgDataHome);
    initGitRepo(repoDir, 'main');

    const claudeTarget = join(binDir, 'claude');
    copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
    chmodSync(claudeTarget, 0o755);

    const previousPath = process.env.PATH;
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.env.XDG_DATA_HOME = xdgDataHome;

    const cleanupServer = createReviewServer({
      dbPath: dbCleanup,
      worktreeRetentionPolicy: 'cleanup_on_finish',
    });
    const keepServer = createReviewServer({
      dbPath: dbKeep,
      worktreeRetentionPolicy: 'keep_all',
    });
    cleanupServer.server.listen(0, '127.0.0.1');
    keepServer.server.listen(0, '127.0.0.1');
    await Promise.all([once(cleanupServer.server, 'listening'), once(keepServer.server, 'listening')]);

    const cleanupAddr = cleanupServer.server.address();
    const keepAddr = keepServer.server.address();
    assert(cleanupAddr && typeof cleanupAddr !== 'string');
    assert(keepAddr && typeof keepAddr !== 'string');

    context.after(async () => {
      await Promise.all([cleanupServer.shutdown(), keepServer.shutdown()]);
      process.env.PATH = previousPath;
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
      rmSync(rootDir, { recursive: true, force: true });
    });

    const startAndCancel = async (port: number, key: string) => {
      const baseUrl = `http://127.0.0.1:${port}`;
      const res = await fetch(`${baseUrl}/api/factory/flows`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: { inputType: 'jira_key', value: key, repoPath: repoDir },
          startSession: true,
          cols: 80,
          rows: 24,
        }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { flow: { id: string; worktreePath: string } };
      assert.ok(existsSync(body.flow.worktreePath));

      const cancelRes = await fetch(`${baseUrl}/api/factory/flows/${body.flow.id}/cancel`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Cancelamento para validar retenção' }),
      });
      assert.equal(cancelRes.status, 200);
      const cancelled = TransitionFactoryFlowResponseSchema.parse(await cancelRes.json());
      return { originalWorktreePath: body.flow.worktreePath, flow: cancelled.flow };
    };

    const cleaned = await startAndCancel(cleanupAddr.port, 'PROD-601');
    assert.equal(cleaned.flow.state, 'cancelled');
    assert.equal(cleaned.flow.worktreePath, null);
    assert.equal(existsSync(cleaned.originalWorktreePath), false);

    const kept = await startAndCancel(keepAddr.port, 'PROD-602');
    assert.equal(kept.flow.state, 'cancelled');
    assert.equal(kept.flow.worktreePath, kept.originalWorktreePath);
    assert.equal(existsSync(kept.originalWorktreePath), true);
  },
);

test(
  'portão humano do Bloco 01 pausa em waiting_action para bloqueadores ou falha de Jira e permite reexecutar com complemento ou avançar com respostas',
  { timeout: 30000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-triage-gate-'));
    const binDir = join(rootDir, 'bin');
    const repoDir = join(rootDir, 'repo');
    const xdgDataHome = join(rootDir, 'xdg-data');
    const dbPath = join(rootDir, 'reviews.db');
    mkdirSync(binDir);
    mkdirSync(repoDir);
    mkdirSync(xdgDataHome);
    initGitRepo(repoDir, 'main');

    const claudeTarget = join(binDir, 'claude');
    copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
    chmodSync(claudeTarget, 0o755);

    const previousPath = process.env.PATH;
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.env.XDG_DATA_HOME = xdgDataHome;

    const { server, sessionManager, shutdown } = createReviewServer({ dbPath });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    context.after(async () => {
      await shutdown();
      process.env.PATH = previousPath;
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
      rmSync(rootDir, { recursive: true, force: true });
    });

    const getDetails = async (flowId: string) => {
      const response = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(response.status, 200);
      return FactoryFlowDetailsSchema.parse(await response.json());
    };

    const waitReady = async (sessionId: string) => {
      await waitFor(() =>
        /READY:[^\n]*\n/.test(sessionManager.getSession(sessionId)?.buffer.replay() ?? ''),
      );
      const readyLine = (sessionManager.getSession(sessionId)?.buffer.replay() ?? '')
        .split(/\r?\n/)
        .find(line => line.startsWith('READY:'));
      assert.ok(readyLine);
      return z
        .object({ args: z.array(z.string()) })
        .parse(JSON.parse(readyLine.slice('READY:'.length)) as unknown)
        .args.at(-1) ?? '';
    };

    // Caso 1: Falha de leitura no Jira + bloqueadores pausam em waiting_action e permitem reexecutar Bloco 01 com complemento.
    const createFlowARes = await fetch(`${baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'jira_key', value: 'PROD-501', repoPath: repoDir },
        startSession: true,
        cols: 100,
        rows: 30,
      }),
    });
    assert.equal(createFlowARes.status, 201);
    const flowABody = (await createFlowARes.json()) as {
      flow: { id: string };
      session: BackgroundSessionSummary;
    };
    const flowAId = flowABody.flow.id;
    assert.ok(flowABody.session.reportPath);
    await waitReady(flowABody.session.sessionId);

    writeFileSync(flowABody.session.reportPath, triageMarkdown('Triagem com falha de Jira e dúvidas.'));
    writeFactoryStageSidecar(flowABody.session.reportPath, 'triage', {
      blockers: ['Qual o gateway de pagamento?', 'Qual o timeout máximo?'],
      jiraError: 'Falha ao consultar Jira MCP: 401 Unauthorized',
    });
    sessionManager.writeInput(flowABody.session.sessionId, 'EXIT0');

    const pausedFlowA = await waitForFlowDetails(
      () => getDetails(flowAId),
      details => details.flow.state === 'waiting_action' && details.flow.currentSessionId === null,
    );
    assert.equal(pausedFlowA.flow.currentStage, 'triage');
    assert.equal(pausedFlowA.flow.state, 'waiting_action');
    assert.match(pausedFlowA.flow.loopPausedReason ?? '', /falha ao consultar o Jira MCP/i);
    assert.match(pausedFlowA.flow.loopPausedReason ?? '', /2 bloqueadores\/ambiguidades/);
    assert.deepEqual(pausedFlowA.triageGate, {
      blockers: ['Qual o gateway de pagamento?', 'Qual o timeout máximo?'],
      jiraError: 'Falha ao consultar Jira MCP: 401 Unauthorized',
      blocked: true,
    });
    assert.ok(!sessionManager.listSessions().some(s => s.flowId === flowAId && s.stage === 'planning'));

    // Reexecuta o Bloco 01 com complemento anexado.
    const complementText = 'Usar Stripe como gateway com timeout de 5 segundos.';
    const rerunTriageRes = await fetch(`${baseUrl}/api/factory/flows/${flowAId}/rerun`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'triage', approvedNotes: complementText }),
    });
    assert.equal(rerunTriageRes.status, 200);
    const rerunBody = (await rerunTriageRes.json()) as { session: BackgroundSessionSummary };
    assert.ok(rerunBody.session.reportPath);
    const rerunPrompt = await waitReady(rerunBody.session.sessionId);
    assert.match(rerunPrompt, /Complemento e respostas fornecidas pelo usuário/);
    assert.ok(rerunPrompt.includes(complementText));

    writeFileSync(rerunBody.session.reportPath, triageMarkdown('Triagem desbloqueada após complemento.'));
    writeFactoryStageSidecar(rerunBody.session.reportPath, 'triage', {
      blockers: [],
      jiraError: null,
    });
    sessionManager.writeInput(rerunBody.session.sessionId, 'EXIT0');

    const autoAdvancedFlowA = await waitForFlowDetails(
      () => getDetails(flowAId),
      details => details.flow.currentStage === 'planning' && details.flow.currentSessionId !== null,
    );
    assert.equal(autoAdvancedFlowA.flow.loopPausedReason, null);
    assert.equal(autoAdvancedFlowA.triageGate, undefined);
    assert.equal(
      autoAdvancedFlowA.stages.find(s => s.name === 'triage')?.approvedNotes,
      complementText,
    );
    if (autoAdvancedFlowA.flow.currentSessionId) {
      await waitReady(autoAdvancedFlowA.flow.currentSessionId);
    }

    // Caso 2: Bloqueador na triagem pausa em waiting_action e usuário envia respostas diretamente ao avançar para o Bloco 02.
    const createFlowBRes = await fetch(`${baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'title', value: 'Exportação de relatório', repoPath: repoDir },
        startSession: true,
        cols: 100,
        rows: 30,
      }),
    });
    assert.equal(createFlowBRes.status, 201);
    const flowBBody = (await createFlowBRes.json()) as {
      flow: { id: string };
      session: BackgroundSessionSummary;
    };
    const flowBId = flowBBody.flow.id;
    assert.ok(flowBBody.session.reportPath);
    await waitReady(flowBBody.session.sessionId);

    writeFileSync(flowBBody.session.reportPath, triageMarkdown('Triagem com ambiguidade de formato.'));
    writeFactoryStageSidecar(flowBBody.session.reportPath, 'triage', {
      blockers: ['Confirmar se a exportação deve ser CSV ou XLSX'],
    });
    sessionManager.writeInput(flowBBody.session.sessionId, 'EXIT0');

    const pausedFlowB = await waitForFlowDetails(
      () => getDetails(flowBId),
      details => details.flow.state === 'waiting_action' && details.flow.currentSessionId === null,
    );
    assert.equal(pausedFlowB.flow.currentStage, 'triage');
    assert.deepEqual(pausedFlowB.triageGate, {
      blockers: ['Confirmar se a exportação deve ser CSV ou XLSX'],
      jiraError: null,
      blocked: true,
    });

    const userAnswer = 'Exportar exclusivamente em CSV UTF-8 com separador vírgula.';
    const advanceWithAnswerRes = await fetch(`${baseUrl}/api/factory/flows/${flowBId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startSession: true, approvedNotes: userAnswer }),
    });
    assert.equal(advanceWithAnswerRes.status, 200);
    const advancedFlowB = (await advanceWithAnswerRes.json()) as {
      flow: { currentStage: string; currentSessionId: string | null };
      session: BackgroundSessionSummary;
    };
    assert.equal(advancedFlowB.flow.currentStage, 'planning');
    const planningPrompt = await waitReady(advancedFlowB.session.sessionId);
    assert.match(planningPrompt, /RESPOSTAS E COMPLEMENTOS APROVADOS PELO USUÁRIO/);
    assert.ok(planningPrompt.includes(userAnswer));

    const flowBDetails = await getDetails(flowBId);
    assert.equal(flowBDetails.stages.find(s => s.name === 'planning')?.approvedNotes, userAnswer);
  },
);

test(
  'API de fluxos expõe planningGate do Bloco 02, persiste planningApproval e injeta decisões estruturadas no Bloco 03',
  { timeout: 45_000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-planning-gate-'));
    const binDir = join(rootDir, 'bin');
    const repoDir = join(rootDir, 'repo');
    const xdgDataHome = join(rootDir, 'xdg-data');
    const dbPath = join(rootDir, 'reviews.db');
    mkdirSync(binDir);
    mkdirSync(repoDir);
    mkdirSync(xdgDataHome);
    initGitRepo(repoDir, 'main');

    const claudeTarget = join(binDir, 'claude');
    copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
    chmodSync(claudeTarget, 0o755);

    const previousPath = process.env.PATH;
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.env.XDG_DATA_HOME = xdgDataHome;

    const { server, sessionManager, shutdown } = createReviewServer({ dbPath });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    context.after(async () => {
      await shutdown();
      process.env.PATH = previousPath;
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
      rmSync(rootDir, { recursive: true, force: true });
    });

    const getDetails = async (flowId: string) => {
      const response = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(response.status, 200);
      return FactoryFlowDetailsSchema.parse(await response.json());
    };

    const waitReady = async (sessionId: string) => {
      await waitFor(() =>
        /READY:[^\n]*\n/.test(sessionManager.getSession(sessionId)?.buffer.replay() ?? ''),
      );
      const readyLine = (sessionManager.getSession(sessionId)?.buffer.replay() ?? '')
        .split(/\r?\n/)
        .find(line => line.startsWith('READY:'));
      assert.ok(readyLine);
      return z
        .object({ args: z.array(z.string()) })
        .parse(JSON.parse(readyLine.slice('READY:'.length)) as unknown)
        .args.at(-1) ?? '';
    };

    const createRes = await fetch(`${baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'jira_key', value: 'PROD-602', repoPath: repoDir },
        startSession: true,
        cols: 100,
        rows: 30,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      flow: { id: string };
      session: BackgroundSessionSummary;
    };
    const flowId = created.flow.id;
    assert.ok(created.session.reportPath);
    await waitReady(created.session.sessionId);

    writeFileSync(created.session.reportPath, triageMarkdown('Triagem concluída.'));
    writeFactoryStageSidecar(created.session.reportPath, 'triage', {
      acceptanceCriteria: [
        { id: 'CA1', description: 'Validar assinatura do webhook' },
        { id: 'CA2', description: 'Registrar auditoria em log' },
      ],
      blockers: [],
      jiraError: null,
    });
    sessionManager.writeInput(created.session.sessionId, 'EXIT0');

    const planningRunning = await waitForFlowDetails(
      () => getDetails(flowId),
      details => details.flow.currentStage === 'planning' && details.flow.currentSessionId !== null,
    );
    const planningSessionId = planningRunning.flow.currentSessionId;
    assert.ok(planningSessionId);
    const planningSession = sessionManager.getSession(planningSessionId);
    assert.ok(planningSession?.reportPath);
    await waitReady(planningSessionId);

    const pendingDecisions = [
      {
        question: 'Qual biblioteca usar para HMAC?',
        options: ['node:crypto nativo', 'Dependência externa'],
        recommendedOption: 'node:crypto nativo',
      },
      {
        question: 'Como tratar payload inválido?',
        options: ['Retornar HTTP 400', 'Enfileirar em DLQ'],
        recommendedOption: 'Retornar HTTP 400',
      },
    ];
    writeFileSync(planningSession.reportPath, planningMarkdown('Plano técnico com decisões D1 e D2.'));
    writeFactoryStageSidecar(planningSession.reportPath, 'planning', {
      pendingDecisions,
    });
    sessionManager.writeInput(planningSessionId, 'EXIT0');

    const planningPaused = await waitForFlowDetails(
      () => getDetails(flowId),
      details => details.flow.state === 'waiting_action' && details.flow.currentSessionId === null,
    );
    assert.deepEqual(planningPaused.planningGate, {
      pendingDecisions,
      acceptanceCriteria: [
        { id: 'CA1', description: 'Validar assinatura do webhook' },
        { id: 'CA2', description: 'Registrar auditoria em log' },
      ],
    });

    // Tentativa sem responder todas as decisões pendentes falha com 400.
    const incompleteApprovalRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startSession: true,
        planningApproval: {
          decisions: [
            {
              id: 'D1',
              question: 'Qual biblioteca usar para HMAC?',
              mode: 'recommended',
              selectedOption: 'node:crypto nativo',
              recommendedOption: 'node:crypto nativo',
            },
          ],
          acceptanceCriteria: [
            { id: 'CA1', description: 'Validar assinatura do webhook', approved: true },
          ],
        },
      }),
    });
    assert.equal(incompleteApprovalRes.status, 400);

    const planningApproval = {
      decisions: [
        {
          id: 'D1',
          question: 'Qual biblioteca usar para HMAC?',
          mode: 'recommended' as const,
          selectedOption: 'node:crypto nativo',
          recommendedOption: 'node:crypto nativo',
          customNote: 'Usar timingSafeEqual na comparação.',
        },
        {
          id: 'D2',
          question: 'Como tratar payload inválido?',
          mode: 'alternative' as const,
          selectedOption: 'Enfileirar em DLQ',
          recommendedOption: 'Retornar HTTP 400',
        },
      ],
      acceptanceCriteria: [
        { id: 'CA1', description: 'Validar assinatura HMAC-SHA256 do webhook', approved: true },
        { id: 'CA2', description: 'Registrar auditoria em log', approved: false },
        { id: 'CA3', description: 'Adicionar métrica de rejeição', approved: true },
      ],
      notes: 'Priorizar cobertura de timing attack.',
    };

    const advanceRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startSession: true,
        cols: 100,
        rows: 30,
        planningApproval,
      }),
    });
    assert.equal(advanceRes.status, 200);
    const advancedBody = (await advanceRes.json()) as {
      flow: { currentStage: string; planningApproval?: { approvedAt: string; notes?: string } | null };
      session: BackgroundSessionSummary;
    };
    assert.equal(advancedBody.flow.currentStage, 'development');
    assert.ok(advancedBody.flow.planningApproval?.approvedAt);
    assert.equal(advancedBody.flow.planningApproval?.notes, 'Priorizar cobertura de timing attack.');

    const devPrompt = await waitReady(advancedBody.session.sessionId);
    assert.match(devPrompt, /Portão Humano do Bloco 02 — Decisões Aprovadas e Critérios de Aceite/);
    assert.ok(devPrompt.includes('Usar timingSafeEqual na comparação.'));
    assert.ok(devPrompt.includes('Enfileirar em DLQ'));
    assert.ok(devPrompt.includes('Validar assinatura HMAC-SHA256 do webhook'));
    assert.ok(devPrompt.includes('Adicionar métrica de rejeição'));

    const persistedDetails = await getDetails(flowId);
    assert.deepEqual(persistedDetails.flow.planningApproval?.decisions, planningApproval.decisions);
    assert.deepEqual(
      persistedDetails.flow.planningApproval?.acceptanceCriteria,
      planningApproval.acceptanceCriteria,
    );
  },
);

test(
  'Bloco 05 realiza roteamento seletivo para tests quando reprova apenas por lacuna de testes e pausa se houver divergência',
  { timeout: 30000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-selective-return-'));
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

    const { server, sessionManager, shutdown } = createReviewServer({ dbPath });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    context.after(async () => {
      await shutdown();
      process.env.PATH = previousPath;
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
      rmSync(rootDir, { recursive: true, force: true });
    });

    const getDetails = async (flowId: string) => {
      const response = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(response.status, 200);
      return FactoryFlowDetailsSchema.parse(await response.json());
    };

    const waitForStageSession = async (
      flowId: string,
      stage: string,
      seen: Set<string>,
    ): Promise<BackgroundSessionSummary> => {
      let match: BackgroundSessionSummary | undefined;
      await waitFor(() => {
        match = sessionManager
          .listSessions()
          .find(
            session =>
              session.flowId === flowId &&
              session.stage === stage &&
              session.status === 'running' &&
              !seen.has(session.sessionId),
          );
        return Boolean(match);
      });
      assert.ok(match);
      seen.add(match.sessionId);
      await waitFor(() =>
        /READY:[^\n]*\n/.test(sessionManager.getSession(match!.sessionId)?.buffer.replay() ?? ''),
      );
      return match;
    };

    const createRes = await fetch(`${baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'jira_key', value: 'PROD-530', repoPath: repoDir },
        startSession: true,
        cols: 100,
        rows: 30,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      flow: { id: string };
      session: BackgroundSessionSummary;
    };
    const flowId = created.flow.id;
    const seen = new Set<string>([created.session.sessionId]);

    await waitFor(() =>
      /READY:[^\n]*\n/.test(sessionManager.getSession(created.session.sessionId)?.buffer.replay() ?? ''),
    );
    assert.ok(created.session.reportPath);
    writeFileSync(created.session.reportPath, triageMarkdown('Validar expiração de sessão.'));
    writeFactoryStageSidecar(created.session.reportPath, 'triage');
    sessionManager.writeInput(created.session.sessionId, 'EXIT0');

    const planningSession = await waitForStageSession(flowId, 'planning', seen);
    assert.ok(planningSession.reportPath);
    writeFileSync(planningSession.reportPath, planningMarkdown('Cobrir cenários de expiração.'));
    writeFactoryStageSidecar(planningSession.reportPath, 'planning');
    sessionManager.writeInput(planningSession.sessionId, 'EXIT0');
    await waitFor(() => sessionManager.getSession(planningSession.sessionId)?.status === 'exited');

    const approveRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startSession: true }),
    });
    assert.equal(approveRes.status, 200);

    // Iteração 1: Development -> Tests -> Review.
    const dev1 = await waitForStageSession(flowId, 'development', seen);
    assert.ok(dev1.reportPath);
    writeFileSync(
      dev1.reportPath,
      [
        '# Relatório de Implementação',
        '## Arquivos alterados',
        '- src/session.ts',
        '## Resumo das mudanças',
        'Implementação concluída.',
        '## Status dos passos do plano',
        '| Passo do Plano | Status | Observações |',
        '| --- | --- | --- |',
        '| Validar expiração | Concluído | Código de produção íntegro |',
      ].join('\n'),
    );
    writeFactoryStageSidecar(dev1.reportPath, 'development', { changedFiles: ['src/session.ts'] });
    sessionManager.writeInput(dev1.sessionId, 'EXIT0');

    const tests1 = await waitForStageSession(flowId, 'tests', seen);
    assert.ok(tests1.reportPath);
    writeFileSync(
      tests1.reportPath,
      [
        '# Relatório de Testes',
        '## Arquivos de teste alterados',
        '- test/session.test.ts',
        '## Comandos executados',
        '- npm test (exit 1)',
        '## Resultados e cobertura',
        'FAIL por mock incorreto de relógio no teste.',
      ].join('\n'),
    );
    writeFactoryStageSidecar(tests1.reportPath, 'tests', {
      status: 'failed',
      executedCommands: [{ command: ['npm', 'test'], exitCode: 1 }],
    });
    sessionManager.writeInput(tests1.sessionId, 'EXIT0');

    const review1 = await waitForStageSession(flowId, 'review', seen);
    assert.ok(review1.reportPath);

    // Divergência entre Alvo de retorno no Markdown e returnTarget no sidecar pausa em waiting_action.
    writeFileSync(
      review1.reportPath,
      [
        '# Relatório de Code Review',
        '## Resumo Executivo',
        'Divergência simulada.',
        '## Pontos Encontrados',
        '- [BLOQUEANTE] test/session.test.ts:12 ajustar mock.',
        '## Como Testar Manualmente',
        '1. Validar comportamento da sessão manualmente.',
        '## Parecer Final',
        'Veredito: REPROVADO / REQUER AJUSTES',
        'Alvo de retorno: development',
      ].join('\n'),
    );
    writeFactoryStageSidecar(review1.reportPath, 'review', {
      verdict: 'changes_requested',
      returnTarget: 'tests',
    });
    sessionManager.writeInput(review1.sessionId, 'EXIT0');

    const divergentPaused = await waitForFlowDetails(
      () => getDetails(flowId),
      details => details.flow.state === 'waiting_action' && details.flow.loopPausedReason !== null,
    );
    assert.equal(divergentPaused.flow.currentStage, 'review');
    assert.match(divergentPaused.flow.loopPausedReason ?? '', /ausente ou ambíguo/);

    // Reexecução do Review reprova apenas por lacuna de testes -> retorna automaticamente para Tests (sem reexecutar Development).
    const rerunReviewRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/rerun`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'review' }),
    });
    assert.equal(rerunReviewRes.status, 200);
    const review1Rerun = await waitForStageSession(flowId, 'review', seen);
    assert.ok(review1Rerun.reportPath);
    writeFileSync(
      review1Rerun.reportPath,
      [
        '# Relatório de Code Review',
        '## Resumo Executivo',
        'Código de produção íntegro; falha exclusiva de mock e cobertura insuficiente nos testes.',
        '## Pontos Encontrados',
        '- [BLOQUEANTE] test/session.test.ts:12 ajustar mock de relógio e cobrir expiração.',
        '## Como Testar Manualmente',
        '1. Validar expiração manualmente e executar `npm test` após corrigir o mock.',
        '## Parecer Final',
        'Veredito: REPROVADO / REQUER AJUSTES',
        'Alvo de retorno: tests',
        'Corrigir apenas os testes na etapa tests.',
      ].join('\n'),
    );
    writeFactoryStageSidecar(review1Rerun.reportPath, 'review', {
      verdict: 'changes_requested',
      returnTarget: 'tests',
      findings: [
        {
          severity: 'BLOQUEANTE',
          file: 'test/session.test.ts',
          line: 12,
          explanation: 'Ajustar mock de relógio e cobrir caso de expiração.',
        },
      ],
    });
    sessionManager.writeInput(review1Rerun.sessionId, 'EXIT0');

    // Deve retornar diretamente para Tests na Iteração 2, mantendo apenas 1 sessão de Development!
    const tests2 = await waitForStageSession(flowId, 'tests', seen);
    assert.ok(tests2.reportPath);
    const iter2TestsDetails = await getDetails(flowId);
    assert.equal(iter2TestsDetails.flow.currentStage, 'tests');
    assert.equal(iter2TestsDetails.flow.state, 'running');
    assert.equal(iter2TestsDetails.flow.iteration, 2);
    assert.equal(
      iter2TestsDetails.stages.find(stage => stage.name === 'development')?.state,
      'completed',
    );
    assert.equal(
      sessionManager.listSessions().filter(s => s.flowId === flowId && s.stage === 'development')
        .length,
      1,
    );

    const tests2ReadyLine = sessionManager
      .getSession(tests2.sessionId)
      ?.buffer.replay()
      .split(/\r?\n/)
      .find(line => line.startsWith('READY:'));
    assert.ok(tests2ReadyLine);
    const tests2Prompt =
      z
        .object({ args: z.array(z.string()) })
        .parse(JSON.parse(tests2ReadyLine.slice('READY:'.length)) as unknown)
        .args.at(-1) ?? '';
    assert.ok(tests2Prompt.includes('Iteração 2/3'));
    assert.ok(tests2Prompt.includes(tests1.reportPath));
    assert.ok(tests2Prompt.includes(review1Rerun.reportPath));

    writeFileSync(
      tests2.reportPath,
      [
        '# Relatório de Testes',
        '## Arquivos de teste alterados',
        '- test/session.test.ts',
        '## Comandos executados',
        '- npm test (exit 0)',
        '## Resultados e cobertura',
        'PASS: mock ajustado e cobertura completa.',
      ].join('\n'),
    );
    writeFactoryStageSidecar(tests2.reportPath, 'tests');
    sessionManager.writeInput(tests2.sessionId, 'EXIT0');

    // Tests (Iteração 2) conclui -> avança automaticamente para Review (Iteração 2) -> aprova -> PR!
    const review2 = await waitForStageSession(flowId, 'review', seen);
    assert.ok(review2.reportPath);
    writeFileSync(
      review2.reportPath,
      [
        '# Relatório de Code Review',
        '## Resumo Executivo',
        'Testes corrigidos e aprovados.',
        '## Pontos Encontrados',
        'Nenhum bloqueador.',
        '## Como Testar Manualmente',
        '1. Conferir o fluxo completo manualmente antes do PR.',
        '## Parecer Final',
        'Veredito: APROVADO PARA PR',
      ].join('\n'),
    );
    writeFactoryStageSidecar(review2.reportPath, 'review');
    sessionManager.writeInput(review2.sessionId, 'EXIT0');

    const prReadyDetails = await waitForFlowDetails(
      () => getDetails(flowId),
      details => details.flow.currentStage === 'pr' && details.flow.state === 'waiting_action',
    );
    assert.equal(prReadyDetails.flow.iteration, 2);
    assert.equal(prReadyDetails.flow.lastReviewVerdict, 'approved');
    assert.equal(
      sessionManager.listSessions().filter(s => s.flowId === flowId && s.stage === 'development')
        .length,
      1,
    );
    assert.equal(
      sessionManager.listSessions().filter(s => s.flowId === flowId && s.stage === 'tests').length,
      2,
    );
  },
);

test('GET /api/factory/metrics valida origem, filtros e agrega métricas reais do SQLite', async context => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-metrics-api-'));
  const dbPath = join(rootDir, 'reviews.db');
  const artifactsDir = join(rootDir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });

  const { server, factoryFlowService, shutdown } = createReviewServer({ dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await shutdown();
    rmSync(rootDir, { recursive: true, force: true });
  });

  // Sem origem -> 403.
  const noOriginRes = await fetch(`${baseUrl}/api/factory/metrics`);
  assert.equal(noOriginRes.status, 403);

  // Filtro inválido -> 400.
  const badPeriodRes = await fetch(`${baseUrl}/api/factory/metrics?period=invalid`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(badPeriodRes.status, 400);
  const badPeriodBody = FactoryFlowApiErrorResponseSchema.parse(await badPeriodRes.json());
  assert.equal(badPeriodBody.error.code, 'FACTORY_FLOW_INVALID_INPUT');

  // Popula um fluxo com review reprovado no 1º ciclo e outro concluído.
  const triagePath = join(artifactsDir, 'triage.md');
  const reviewPath = join(artifactsDir, 'review.md');
  writeFileSync(triagePath, triageMarkdown('Escopo API.'));
  writeFactoryStageSidecar(triagePath, 'triage');
  writeFileSync(
    reviewPath,
    '# Relatório de Code Review\n## Resumo Executivo\nAjuste.\n## Pontos Encontrados\n- [BLOQUEANTE] src/a.ts:1 falta validação.\n## Como Testar Manualmente\n1. Enviar payload inválido e conferir validação.\n## Parecer Final\nVeredito: REPROVADO / REQUER AJUSTES\nAlvo de retorno: development\n',
  );
  writeFactoryStageSidecar(reviewPath, 'review', {
    verdict: 'changes_requested',
    returnTarget: 'development',
    findings: [
      {
        severity: 'BLOQUEANTE',
        file: 'src/a.ts',
        line: 1,
        explanation: 'Validar payload na entrada.',
        category: 'seguranca',
      },
    ],
  });

  const created = await factoryFlowService.createFlow({
    task: { inputType: 'jira_key', value: 'API-10', repoPath: '/tmp/repo-api-metrics' },
  });
  await factoryFlowService.registerArtifact(created.flow.id, {
    stage: 'triage',
    kind: 'specification',
    path: triagePath,
    status: 'ready',
  });
  await factoryFlowService.transitionFlow(created.flow.id, {
    to: 'running',
    reason: 'Iniciado',
  });
  await factoryFlowService.registerArtifact(created.flow.id, {
    stage: 'review',
    kind: 'review_report',
    path: reviewPath,
    status: 'ready',
  });
  await factoryFlowService.cancelFlow(created.flow.id, {
    reason: 'Cancelado pelo usuário após review',
  });

  const metricsRes = await fetch(
    `${baseUrl}/api/factory/metrics?repoPath=${encodeURIComponent('/tmp/repo-api-metrics')}&period=7d`,
    { headers: { Origin: ALLOWED_ORIGIN } },
  );
  assert.equal(metricsRes.status, 200);
  const metrics = FactoryMetricsResponseSchema.parse(await metricsRes.json());
  assert.equal(metrics.filters.repoPath, '/tmp/repo-api-metrics');
  assert.equal(metrics.filters.period, '7d');
  assert.equal(metrics.summary.totalFlows, 1);
  assert.equal(metrics.summary.cancelledFlows, 1);
  assert.deepEqual(metrics.rejectionReasons, [
    { reason: 'seguranca', count: 1, flowCount: 1 },
  ]);
  assert.equal(metrics.byRepository[0]?.repoPath, '/tmp/repo-api-metrics');
});
