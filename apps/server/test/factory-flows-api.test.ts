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
  await waitFor(() =>
    Boolean(sessionManager.getSession(autoPlanningSessionId)?.buffer.replay().includes('READY:')),
  );
  const planningBuffer = sessionManager.getSession(autoPlanningSessionId)?.buffer.replay() ?? '';
  const readyLine = planningBuffer.split(/\r?\n/).find(line => line.includes('READY:'));
  assert.ok(readyLine, 'Sessão automática da etapa planning deve emitir READY com os argumentos do prompt');
  const readyJson = readyLine.slice(readyLine.indexOf('READY:') + 'READY:'.length);
  const readyPayload = JSON.parse(readyJson) as { args?: string[] };
  const args = readyPayload.args ?? [];
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('--allowedTools'));
  const allowedToolsArg = args[args.indexOf('--allowedTools') + 1] ?? '';
  assert.ok(allowedToolsArg.includes('Read,Glob,Grep'));
  assert.equal(allowedToolsArg.includes('mcp__claude_ai_Atlassian_Rovo'), false);
  const promptArgIndex = args.indexOf('-p') + 1;
  assert.ok(promptArgIndex > 0);
  const planningPrompt = args[promptArgIndex] ?? '';
  assert.ok(planningPrompt.includes('# Entendimento do Problema'));
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
  'múltiplos fluxos via POST /api/factory/flows no mesmo repositório executam em paralelo com planos isolados e concluem até PR',
  { timeout: 30000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-factory-parallel-same-repo-'));
    const binDir = join(rootDir, 'bin');
    const repoDir = join(rootDir, 'shared-repo');
    const dbPath = join(rootDir, 'reviews.db');
    mkdirSync(binDir);
    mkdirSync(repoDir);

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

    context.after(async () => {
      await shutdown();
      process.env.PATH = previousPath;
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

    // Salva planos distintos para cada fluxo no mesmo repositório.
    writeFileSync(createdOne.session.reportPath, '# Plano Fluxo 1\n\nJWT isolado.\n');
    writeFileSync(createdTwo.session.reportPath, '# Plano Fluxo 2\n\nPaginação isolada.\n');

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

    const planningSessionOne = detailsOne.flow.currentSessionId;
    const planningSessionTwo = detailsTwo.flow.currentSessionId;
    await waitFor(() => {
      const p1 = sessionManager.getSession(planningSessionOne);
      const p2 = sessionManager.getSession(planningSessionTwo);
      return Boolean(p1?.buffer.replay().includes('READY:') && p2?.buffer.replay().includes('READY:'));
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

    const specOne = afterPlanOne.artifacts.find(
      artifact => artifact.stage === 'triage' && artifact.kind === 'specification',
    );
    const specTwo = afterPlanTwo.artifacts.find(
      artifact => artifact.stage === 'triage' && artifact.kind === 'specification',
    );
    assert(specOne && specTwo);
    assert.equal(specOne.path, createdOne.session.reportPath);
    assert.equal(specTwo.path, createdTwo.session.reportPath);

    // Avança o Fluxo 1 por todas as etapas restantes até concluir o PR enquanto o Fluxo 2 permanece em planning.
    const nextStages = ['development', 'tests', 'review', 'pr'] as const;
    for (const expectedStage of nextStages) {
      const advRes = await fetch(`${baseUrl}/api/factory/flows/${createdOne.flow.id}/advance`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startSession: false }),
      });
      assert.equal(advRes.status, 200);
      const advBody = TransitionFactoryFlowResponseSchema.parse(await advRes.json());
      assert.equal(advBody.flow.currentStage, expectedStage);
    }

    const extraAdvanceRes = await fetch(`${baseUrl}/api/factory/flows/${createdOne.flow.id}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startSession: false }),
    });
    assert.equal(extraAdvanceRes.status, 409);
    const extraAdvanceErr = FactoryFlowApiErrorResponseSchema.parse(await extraAdvanceRes.json());
    assert.equal(extraAdvanceErr.error.code, 'FACTORY_FLOW_INVALID_STAGE_ADVANCE');

    // Confirma que o Fluxo 2 não foi afetado pelas transições do Fluxo 1.
    const checkTwoRes = await fetch(`${baseUrl}/api/factory/flows/${createdTwo.flow.id}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(checkTwoRes.status, 200);
    const checkTwo = FactoryFlowDetailsSchema.parse(await checkTwoRes.json());
    assert.equal(checkTwo.flow.currentStage, 'planning');
    assert.equal(checkTwo.flow.state, 'waiting_action');
  },
);
