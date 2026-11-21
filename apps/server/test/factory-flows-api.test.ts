import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { z } from 'zod';
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
    /READY:[^\n]*\n/.test(sessionManager.getSession(autoPlanningSessionId)?.buffer.replay() ?? ''),
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
    assert.ok(detailsOne.worktreePath && detailsTwo.worktreePath);
    assert.notEqual(detailsOne.worktreePath, detailsTwo.worktreePath);
    assert.notEqual(detailsOne.worktreePath, repoDir);
    assert.equal(detailsOne.branchName, 'factory/implementar-autenticacao-jwt');
    assert.equal(detailsTwo.branchName, 'factory/corrigir-paginacao-de-auditoria');
    assert.equal(detailsOne.baseBranch, 'main');
    assert.equal(detailsTwo.baseBranch, 'main');
    assert.equal(existsSync(detailsOne.worktreePath), true);
    assert.equal(existsSync(detailsTwo.worktreePath), true);

    const planningSessionOne = detailsOne.flow.currentSessionId;
    const planningSessionTwo = detailsTwo.flow.currentSessionId;
    await waitFor(() => {
      const p1 = sessionManager.getSession(planningSessionOne);
      const p2 = sessionManager.getSession(planningSessionTwo);
      return Boolean(p1?.buffer.replay().includes('READY:') && p2?.buffer.replay().includes('READY:'));
    });

    const planPath = sessionManager.getSession(planningSessionOne)?.reportPath;
    assert.ok(planPath);
    writeFileSync(planPath, '# Diagnóstico Técnico + Plano de Implementação\n\n1. Ajustar JWT.\n');
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
    const approvedNotes = 'Usar a opção 2 para renovação do JWT.';
    const developmentResponse = await postAction('advance', { startSession: true, approvedNotes });
    assert.equal(developmentResponse.status, 200);
    const development = z.object({ session: BackgroundSessionSummarySchema }).parse(
      await developmentResponse.json(),
    ).session;
    assert.equal(development.stage, 'development');
    assert.ok(development.reportPath);
    assert.equal((await postAction('advance', { startSession: true })).status, 409);

    await waitFor(() => Boolean(sessionManager.getSession(development.sessionId)?.buffer.replay().includes('READY:')));
    writeFileSync(development.reportPath, '# Relatório de Implementação\n\nIncompleto.\n');
    sessionManager.writeInput(development.sessionId, 'EXIT0');
    await waitFor(() => sessionManager.getSession(development.sessionId)?.status === 'exited');
    const incompleteDetails = await getDetails();
    assert.equal(incompleteDetails.flow.state, 'waiting_action');
    assert.ok(incompleteDetails.artifacts.some(artifact =>
      artifact.kind === 'implementation_report' && artifact.status === 'incomplete',
    ));
    assert.equal((await postAction('advance', { startSession: true })).status, 409);

    const rerunResponse = await postAction('rerun', { stage: 'development' });
    assert.equal(rerunResponse.status, 200);
    const rerun = z.object({ session: BackgroundSessionSummarySchema }).parse(
      await rerunResponse.json(),
    ).session;
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
    assert.doesNotMatch(prompt, /Paginação isolada/);
    assert.ok(args.includes('--restricted'));
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
    assert.match(args[args.indexOf('--allowedTools') + 1] ?? '', /Edit\(\*\*\/\*\.ts\)/);
    assert.match(args[args.indexOf('--disallowedTools') + 1] ?? '', /\.test\.\*/);
    assert.match(args[args.indexOf('--disallowedTools') + 1] ?? '', /\.spec\.\*/);

    writeFileSync(rerun.reportPath, [
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
    ].join('\n'));
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
    assert.ok(testsSpawn.args.includes('--restricted'));
    assert.equal(testsSpawn.args[testsSpawn.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash');
    assert.match(testsSpawn.args[testsSpawn.args.indexOf('--allowedTools') + 1] ?? '', /Edit\(\*\*\/\*\.test\.\*\)/);
    assert.match(testsSpawn.args[testsSpawn.args.indexOf('--allowedTools') + 1] ?? '', /Bash/);

    // Relatório de testes incompleto pausa em waiting_action para reexecução manual.
    writeFileSync(testsSession.reportPath, '# Relatório de Testes\n\nIncompleto.\n');
    sessionManager.writeInput(testsSession.sessionId, 'EXIT0');
    await waitFor(() => sessionManager.getSession(testsSession.sessionId)?.status === 'exited');
    const incompleteTestsDetails = await getDetails();
    assert.equal(incompleteTestsDetails.flow.state, 'waiting_action');
    assert.ok(
      incompleteTestsDetails.artifacts.some(
        artifact => artifact.kind === 'test_report' && artifact.status === 'incomplete',
      ),
    );
    assert.equal((await postAction('advance', { startSession: true })).status, 409);

    // 2. Reexecução de Tests reportando FAIL no código de produção: deve avançar automaticamente para Review (double-check).
    const rerunTestsResponse = await postAction('rerun', { stage: 'tests' });
    assert.equal(rerunTestsResponse.status, 200);
    const rerunTests = z.object({ session: BackgroundSessionSummarySchema }).parse(
      await rerunTestsResponse.json(),
    ).session;
    assert.ok(rerunTests.reportPath);
    await waitFor(() => Boolean(sessionManager.getSession(rerunTests.sessionId)?.buffer.replay().includes('READY:')));
    writeFileSync(
      rerunTests.reportPath,
      [
        '# Relatório de Testes',
        '## Arquivos de teste alterados',
        '- test/jwt.test.ts',
        '## Comandos executados',
        '- npm test (exit 1)',
        '## Resultados e cobertura',
        'FAIL: renovação de token expirado retornou 500 em src/jwt.ts:42.',
        '',
      ].join('\n'),
    );
    sessionManager.writeInput(rerunTests.sessionId, 'EXIT0');

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
    assert.ok(reviewSpawn.args.includes('--restricted'));
    const reviewAllowedTools = reviewSpawn.args[reviewSpawn.args.indexOf('--allowedTools') + 1] ?? '';
    assert.ok(reviewAllowedTools.includes('Bash(git diff*)'));
    assert.ok(reviewAllowedTools.includes('Bash(git status*)'));
    assert.ok(reviewAllowedTools.includes('Bash(git log*)'));
    assert.equal(reviewAllowedTools.includes('Edit(**/*.ts)'), false);

    // Relatório de review sem veredito determinístico falha validação e pausa em waiting_action.
    writeFileSync(reviewSession.reportPath, '# Relatório de Code Review\n\nIncompleto.\n');
    sessionManager.writeInput(reviewSession.sessionId, 'EXIT0');
    await waitFor(() => sessionManager.getSession(reviewSession.sessionId)?.status === 'exited');
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
      '## Parecer Final',
      'Veredito: REPROVADO / REQUER AJUSTES',
      'Corrigir tratamento de token expirado em src/jwt.ts.',
      '',
    ].join('\n');
    writeFileSync(rerunReview.reportPath, rejectedReviewMarkdown);
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
    const iter2ReviewDetails = await getDetails();
    assert.equal(iter2ReviewDetails.flow.currentStage, 'review');
    assert.equal(iter2ReviewDetails.flow.iteration, 2);
    assert.ok(iter2ReviewDetails.flow.currentSessionId);
    const iter2ReviewSession = sessionManager.getSession(iter2ReviewDetails.flow.currentSessionId);
    assert.ok(iter2ReviewSession && iter2ReviewSession.reportPath);
    await waitFor(() => iter2ReviewSession.buffer.replay().includes('READY:'));
    const approvedReviewMarkdown = [
      '# Relatório de Code Review',
      '## Resumo Executivo',
      'Correção confirmada e aderente ao plano.',
      '## Pontos Encontrados',
      'Nenhum bloqueador crítico.',
      '## Parecer Final',
      'Veredito: APROVADO PARA PR',
      'Pronto para preparar o Pull Request.',
      '',
    ].join('\n');
    writeFileSync(iter2ReviewSession.reportPath, approvedReviewMarkdown);
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
    assert.equal(prPausedDetails.flow.iteration, 2);
    assert.ok(!sessionManager.listSessions().some(session => session.stage === 'pr'));

    // Verifica histórico de artefatos por iteração persistido no banco.
    assert.equal(
      prPausedDetails.artifacts.filter(
        artifact => artifact.kind === 'review_report' && artifact.status === 'ready',
      ).length,
      2,
    );

    // 5. Disparo manual da etapa PR via POST /start -> conclui o fluxo ao salvar pr_summary.
    const startPrRes = await postAction('start', { stage: 'pr' });
    assert.equal(startPrRes.status, 200);
    const prSession = z.object({ session: BackgroundSessionSummarySchema }).parse(
      await startPrRes.json(),
    ).session;
    assert.equal(prSession.stage, 'pr');
    assert.ok(prSession.reportPath);
    await waitFor(() => Boolean(sessionManager.getSession(prSession.sessionId)?.buffer.replay().includes('READY:')));
    writeFileSync(
      prSession.reportPath,
      [
        '# Resumo do Pull Request',
        '## Resumo das Alterações',
        'Renovação de JWT ajustada.',
        '## Validação e Evidências',
        'Testes e Code Review aprovados.',
        '## Dados do Pull Request',
        'Branch feat/jwt -> main.',
        '',
      ].join('\n'),
    );
    sessionManager.writeInput(prSession.sessionId, 'EXIT0');
    const completedPrDetails = await waitForFlowDetails(
      getDetails,
      details => details.flow.state === 'completed',
    );
    assert.equal(completedPrDetails.flow.currentStage, 'pr');
    assert.equal(completedPrDetails.flow.state, 'completed');

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

test(
  'circuit breaker pausa o loop autônomo em waiting_action ao atingir MAX_AUTO_ITERATIONS (3/3) sem aprovação',
  { timeout: 30000 },
  async context => {
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
    const created = (await createRes.json()) as {
      flow: { id: string };
      session: BackgroundSessionSummary;
    };
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
      seenSessionIds.add(match.sessionId);
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
    writeFileSync(created.session.reportPath, '# Especificação\n\nEscopo definido.\n');
    sessionManager.writeInput(created.session.sessionId, 'EXIT0');

    const planningSession = await waitForStageSession('planning', seen);
    assert.ok(planningSession.reportPath);
    writeFileSync(planningSession.reportPath, '# Plano\n\n1. Implementar.\n');
    sessionManager.writeInput(planningSession.sessionId, 'EXIT0');
    await waitFor(() => sessionManager.getSession(planningSession.sessionId)?.status === 'exited');

    const approveRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/advance`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startSession: true }),
    });
    assert.equal(approveRes.status, 200);

    for (let iteration = 1; iteration <= 3; iteration += 1) {
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
      sessionManager.writeInput(devSession.sessionId, 'EXIT0');

      const testsSession = await waitForStageSession('tests', seen);
      assert.ok(testsSession.reportPath);
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
      sessionManager.writeInput(testsSession.sessionId, 'EXIT0');

      const reviewSession = await waitForStageSession('review', seen);
      assert.ok(reviewSession.reportPath);
      writeFileSync(
        reviewSession.reportPath,
        [
          '# Relatório de Code Review',
          '## Resumo Executivo',
          `Bloqueador persistente na iteração ${iteration}.`,
          '## Pontos Encontrados',
          '- [BLOQUEANTE] src/feature.ts:10 ainda falha.',
          '## Parecer Final',
          'Veredito: REPROVADO / REQUER AJUSTES',
          'Ajuste necessário.',
        ].join('\n'),
      );
      sessionManager.writeInput(reviewSession.sessionId, 'EXIT0');
      await waitFor(() => sessionManager.getSession(reviewSession.sessionId)?.status === 'exited');
    }

    const pausedDetails = await waitForFlowDetails(
      getDetails,
      details =>
        details.flow.state === 'waiting_action' && details.flow.loopPausedReason !== null,
    );
    assert.equal(pausedDetails.flow.currentStage, 'review');
    assert.equal(pausedDetails.flow.state, 'waiting_action');
    assert.equal(pausedDetails.flow.iteration, 3);
    assert.equal(pausedDetails.flow.maxIterations, 3);
    assert.equal(pausedDetails.flow.lastReviewVerdict, 'changes_requested');
    assert.match(pausedDetails.flow.loopPausedReason ?? '', /Limite máximo de 3 iterações automáticas/);
    assert.equal(
      sessionManager.listSessions().filter(s => s.flowId === flowId && s.stage === 'development').length,
      3,
    );
  },
);

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
      writeFileSync(item.session.reportPath, `# Especificação ${item.flow.id}\n\nEscopo ok.\n`);
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
      writeFileSync(planningSession.reportPath, `# Plano ${item.flow.id}\n\n1. Implementar.\n`);
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

test('POST /api/factory/flows falha de forma limpa quando baseBranch não existe sem deixar diretórios órfãos', async context => {
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
});
