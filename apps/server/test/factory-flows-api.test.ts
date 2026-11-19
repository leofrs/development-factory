import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import {
  AppEventSchema,
  BackgroundSessionSummarySchema,
  CreateFactoryFlowResponseSchema,
  FactoryFlowApiErrorResponseSchema,
  FactoryFlowDetailsSchema,
  FactoryFlowListResponseSchema,
  ServerMessageSchema,
  TransitionFactoryFlowResponseSchema,
  type AppEvent,
  type BackgroundSessionSummary,
  type ServerMessage,
} from '@development-factory/shared';
import { createReviewServer } from '../src/server.js';

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

test('API REST /api/factory/flows valida origem, idempotência, filtros e ciclo completo com SSE e PTYs paralelos', { timeout: 30000 }, async context => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-flows-api-'));
  const binDir = join(rootDir, 'bin');
  const repoA = join(rootDir, 'repo-a');
  const repoB = join(rootDir, 'repo-b');
  const dbPath = join(rootDir, 'reviews.db');
  mkdirSync(binDir);
  mkdirSync(repoA);
  mkdirSync(repoB);

  const claudeTarget = join(binDir, 'claude');
  copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
  chmodSync(claudeTarget, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;

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

  // Aguarda ambos PTYs estarem prontos em paralelo.
  await waitFor(() => {
    const sA = sessionManager.getSession(sessionAId);
    const sB = sessionManager.getSession(sessionBId);
    return Boolean(sA?.buffer.replay().includes('READY:') && sB?.buffer.replay().includes('READY:'));
  });

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

  // 5. Simula salvamento do plano no Fluxo A e saída com código 0.
  assert(sessionASummary.reportPath);
  writeFileSync(sessionASummary.reportPath, '# Entendimento do Problema\n\nFluxo A salvo.\n');
  await waitFor(() =>
    events.some(
      event =>
        event.type === 'session.history_saved' && event.session.sessionId === sessionAId,
    ),
  );

  sessionManager.writeInput(sessionAId, 'EXIT0');
  await waitFor(() =>
    events.some(
      event =>
        event.type === 'factory_flow.updated' &&
        event.flow.id === flowAId &&
        event.flow.state === 'waiting_action' &&
        event.flow.currentSessionId === null,
    ),
  );

  const detailsARes = await fetch(`${baseUrl}/api/factory/flows/${flowAId}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(detailsARes.status, 200);
  const detailsA = FactoryFlowDetailsSchema.parse(await detailsARes.json());
  assert.equal(detailsA.flow.state, 'waiting_action');
  assert.equal(detailsA.flow.currentStage, 'triage');
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

  // 6. Reexecuta a etapa atual (triage) do Fluxo A via /rerun, depois finaliza e avança para planning.
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
  assert.equal(rerunBody.flow.currentStage, 'triage');
  assert.notEqual(rerunBody.session.sessionId, sessionAId);

  await waitFor(() => Boolean(sessionManager.getSession(rerunBody.session.sessionId)?.buffer.replay().includes('READY:')));
  sessionManager.writeInput(rerunBody.session.sessionId, 'EXIT0');
  await waitFor(() =>
    events.some(
      event => event.type === 'session.finished' && event.session.sessionId === rerunBody.session.sessionId,
    ),
  );

  const advanceRes = await fetch(`${baseUrl}/api/factory/flows/${flowAId}/advance`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startSession: true }),
  });
  assert.equal(advanceRes.status, 200, await advanceRes.clone().text());
  const advanceBody = (await advanceRes.json()) as {
    flow: { state: string; currentStage: string; currentSessionId: string | null };
    session: BackgroundSessionSummary;
  };
  assert.equal(advanceBody.flow.currentStage, 'planning');
  assert.equal(advanceBody.flow.state, 'running');
  assert.equal(advanceBody.session.stage, 'planning');

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
