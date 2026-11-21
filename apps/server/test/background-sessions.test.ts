import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import {
  AppEventSchema,
  BackgroundSessionSummarySchema,
  ServerMessageSchema,
  type AppEvent,
  type BackgroundSessionSummary,
  type ClientMessage,
  type ServerMessage,
} from '@development-factory/shared';
import { createReviewServer } from '../src/server.js';
import type { SessionManager } from '../src/session-manager.js';

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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Tempo limite excedido aguardando: ${label}`);
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
  }
}

interface WsClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[];
  send: (message: ClientMessage) => void;
  take: <T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    label: string,
    timeoutMs?: number,
  ) => Promise<T>;
  close: () => Promise<void>;
}

async function connectWs(wsUrl: string, sockets: WebSocket[]): Promise<WsClient> {
  const socket = new WebSocket(wsUrl, { origin: ALLOWED_ORIGIN });
  sockets.push(socket);
  const messages: ServerMessage[] = [];

  socket.on('message', raw => {
    const parsed = ServerMessageSchema.parse(JSON.parse(raw.toString()) as unknown);
    messages.push(parsed);
  });

  await once(socket, 'open');

  return {
    socket,
    messages,
    send: (message: ClientMessage): void => {
      socket.send(JSON.stringify(message));
    },
    take: async <T extends ServerMessage>(
      predicate: (message: ServerMessage) => message is T,
      label: string,
      timeoutMs = 5000,
    ): Promise<T> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) {
          const [matched] = messages.splice(index, 1);
          if (matched && predicate(matched)) {
            return matched;
          }
        }
        await new Promise(resolve => {
          setTimeout(resolve, 20);
        });
      }
      throw new Error(`Timeout aguardando mensagem WS: ${label}`);
    },
    close: async (): Promise<void> => {
      if (socket.readyState === WebSocket.CLOSED) {
        return;
      }
      const closedPromise = once(socket, 'close');
      socket.close();
      await closedPromise;
    },
  };
}

interface SseClient {
  readonly events: AppEvent[];
  readUntil: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

async function connectSse(
  baseUrl: string,
  abortControllers: AbortController[],
): Promise<SseClient> {
  const abortController = new AbortController();
  abortControllers.push(abortController);

  const response = await fetch(`${baseUrl}/api/events`, {
    headers: { Origin: ALLOWED_ORIGIN },
    signal: abortController.signal,
  });
  assert.equal(response.status, 200);
  assert(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rawBuffer = '';
  let sawHeartbeat = false;
  const events: AppEvent[] = [];

  const readUntil = async (predicate: () => boolean, timeoutMs = 6000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('Tempo limite excedido aguardando eventos SSE.');
      }
      const chunkResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('Timeout lendo chunk SSE.'));
          }, remaining);
        }),
      ]);
      if (chunkResult.done) {
        break;
      }
      rawBuffer += decoder.decode(chunkResult.value, { stream: true });
      const parsed = parseSseFrames(rawBuffer);
      rawBuffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.event === 'heartbeat') {
          sawHeartbeat = true;
          continue;
        }
        const appEvent = AppEventSchema.parse(JSON.parse(frame.data) as unknown);
        events.push(appEvent);
      }
    }
  };

  await readUntil(() => sawHeartbeat);

  return {
    events,
    readUntil,
    close: async (): Promise<void> => {
      abortController.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

interface ServerTestHarness {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly repoDir: string;
  readonly reportDirectory: string;
  readonly sessionManager: SessionManager;
  readonly sockets: WebSocket[];
  readonly abortControllers: AbortController[];
}

async function setupServer(context: TestContext, prefix: string): Promise<ServerTestHarness> {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  const binDir = join(rootDir, 'bin');
  const repoDir = join(rootDir, 'repo');
  const xdgDataHome = join(rootDir, 'xdg-data');
  const dbPath = join(rootDir, 'reviews.db');
  mkdirSync(binDir);
  mkdirSync(repoDir);
  mkdirSync(xdgDataHome);

  const claudeTarget = join(binDir, 'claude');
  copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
  chmodSync(claudeTarget, 0o755);

  const previousPath = process.env.PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.XDG_DATA_HOME = xdgDataHome;

  const { server, sessionManager, shutdown } = createReviewServer({ dbPath });
  const sockets: WebSocket[] = [];
  const abortControllers: AbortController[] = [];

  context.after(async () => {
    for (const controller of abortControllers) {
      controller.abort();
    }
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

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert(address && typeof address !== 'string');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws/terminal`,
    repoDir,
    reportDirectory: rootDir,
    sessionManager,
    sockets,
    abortControllers,
  };
}

test(
  'Code Review via WebSocket continua em background após desconexão, salva parecer e entrega replay via attach_session',
  { timeout: 15000 },
  async context => {
    const { wsUrl, repoDir, reportDirectory, sessionManager, sockets } = await setupServer(
      context,
      'df-bg-reconnect-',
    );

    const ws1 = await connectWs(wsUrl, sockets);
    ws1.send({
      type: 'start_review',
      targetType: 'pr',
      identifier: '701',
      repoPath: repoDir,
      reportDirectory,
      cols: 80,
      rows: 24,
    });

    const attached1 = await ws1.take(
      (msg): msg is Extract<ServerMessage, { type: 'session_attached' }> =>
        msg.type === 'session_attached',
      'session_attached inicial',
    );
    const sessionId = attached1.session.sessionId;
    assert.equal(attached1.session.mode, 'review');
    assert.equal(attached1.session.status, 'running');

    const session = sessionManager.getSession(sessionId);
    assert(session);

    await waitFor(() => session.buffer.replay().includes('READY:'), 'READY no buffer da sessão');

    ws1.send({ type: 'input', data: 'BEFORE_DISCONNECT' });
    await waitFor(
      () => session.buffer.replay().includes('INPUT:BEFORE_DISCONNECT'),
      'INPUT:BEFORE_DISCONNECT no buffer',
    );

    // Desconecta o cliente WebSocket; o PTY deve permanecer ativo em background.
    await ws1.close();
    await waitFor(() => session.subscribers.size === 0, 'desconexão do cliente WS');
    assert.equal(session.status, 'running');
    assert(session.ptyProcess);

    // Simula o Claude salvando o parecer e finalizando com código 0 sem clientes conectados.
    session.ptyProcess.write('SAVE');
    await waitFor(() => session.historyState === 'saved', 'parecer salvo em background');

    session.ptyProcess.write('EXIT0');
    await waitFor(() => session.status === 'exited', 'sessão finalizada com EXIT0');
    assert.equal(session.exitCode, 0);
    assert.equal(session.ptyProcess, undefined);

    // Reconecta com um novo WebSocket usando attach_session.
    const ws2 = await connectWs(wsUrl, sockets);
    ws2.send({
      type: 'attach_session',
      sessionId,
      cols: 100,
      rows: 30,
    });

    const attached2 = await ws2.take(
      (msg): msg is Extract<ServerMessage, { type: 'session_attached' }> =>
        msg.type === 'session_attached',
      'session_attached na reconexão',
    );
    assert.equal(attached2.session.sessionId, sessionId);
    assert.equal(attached2.session.status, 'exited');
    assert.equal(attached2.session.historyState, 'saved');
    assert.equal(attached2.session.exitCode, 0);
    assert(attached2.replay.includes('READY:'));
    assert(attached2.replay.includes('INPUT:BEFORE_DISCONNECT'));

    const historyMsg = await ws2.take(
      (msg): msg is Extract<ServerMessage, { type: 'history' }> => msg.type === 'history',
      'history na reconexão',
    );
    assert.equal(historyMsg.state, 'saved');
    assert.equal(historyMsg.reportPath, session.reportPath);

    const statusMsg = await ws2.take(
      (msg): msg is Extract<ServerMessage, { type: 'status' }> => msg.type === 'status',
      'status final na reconexão',
    );
    assert.equal(statusMsg.state, 'exited');
    assert.equal(statusMsg.exitCode, 0);
    assert.equal(statusMsg.sessionId, sessionId);

    assert(session.reportPath && existsSync(session.reportPath));
    assert(readFileSync(session.reportPath, 'utf8').includes('# Parecer final'));
    assert.equal(session.sessionPath, null);

    await ws2.close();
  },
);

test(
  'múltiplas sessões paralelas (review + review + factory) emitem eventos independentes em GET /api/events e GET /api/sessions',
  { timeout: 20000 },
  async context => {
    const { baseUrl, wsUrl, repoDir, reportDirectory, sessionManager, sockets, abortControllers } =
      await setupServer(context, 'df-bg-parallel-');

    const sse = await connectSse(baseUrl, abortControllers);

    const wsReview1 = await connectWs(wsUrl, sockets);
    const wsReview2 = await connectWs(wsUrl, sockets);
    const wsFactory = await connectWs(wsUrl, sockets);

    wsReview1.send({
      type: 'start_review',
      targetType: 'pr',
      identifier: '801',
      repoPath: repoDir,
      reportDirectory,
      cols: 80,
      rows: 24,
    });
    wsReview2.send({
      type: 'start_review',
      targetType: 'branch',
      identifier: 'feat/parallel-bg',
      repoPath: repoDir,
      reportDirectory,
      cols: 80,
      rows: 24,
    });
    wsFactory.send({
      type: 'start_factory',
      inputType: 'title',
      value: 'Fábrica paralela',
      repoPath: repoDir,
      cols: 80,
      rows: 24,
    });

    const [attachedReview1, attachedReview2, attachedFactory] = await Promise.all([
      wsReview1.take(
        (msg): msg is Extract<ServerMessage, { type: 'session_attached' }> =>
          msg.type === 'session_attached',
        'session_attached review1',
      ),
      wsReview2.take(
        (msg): msg is Extract<ServerMessage, { type: 'session_attached' }> =>
          msg.type === 'session_attached',
        'session_attached review2',
      ),
      wsFactory.take(
        (msg): msg is Extract<ServerMessage, { type: 'session_attached' }> =>
          msg.type === 'session_attached',
        'session_attached factory',
      ),
    ]);

    const review1Id = attachedReview1.session.sessionId;
    const review2Id = attachedReview2.session.sessionId;
    const factoryId = attachedFactory.session.sessionId;

    assert.equal(new Set([review1Id, review2Id, factoryId]).size, 3);

    const review1 = sessionManager.getSession(review1Id);
    const review2 = sessionManager.getSession(review2Id);
    const factory = sessionManager.getSession(factoryId);
    assert(review1 && review2 && factory);

    await waitFor(
      () =>
        review1.buffer.replay().includes('READY:') &&
        review2.buffer.replay().includes('READY:') &&
        factory.buffer.replay().includes('READY:'),
      'READY nas 3 sessões paralelas',
    );

    await sse.readUntil(
      () =>
        [review1Id, review2Id, factoryId].every(id =>
          sse.events.some(event => event.type === 'session.started' && event.session.sessionId === id),
        ),
      6000,
    );

    // Todas as 3 sessões aparecem como running em GET /api/sessions.
    const runningListRes = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(runningListRes.status, 200);
    const runningBody = (await runningListRes.json()) as { sessions: BackgroundSessionSummary[] };
    const runningSessions = BackgroundSessionSummarySchema.array().parse(runningBody.sessions);
    assert.equal(runningSessions.length, 3);
    for (const id of [review1Id, review2Id, factoryId]) {
      const found = runningSessions.find(item => item.sessionId === id);
      assert(found);
      assert.equal(found.status, 'running');
    }

    // Desconecta os WebSockets para que concluam em background de forma independente.
    await Promise.all([wsReview1.close(), wsReview2.close(), wsFactory.close()]);

    // review1 salva parecer e sai com 0; factory sai com 0; review2 sai com erro (EXIT = 7).
    assert(review1.ptyProcess && review2.ptyProcess && factory.ptyProcess);
    review1.ptyProcess.write('SAVE');
    await sse.readUntil(
      () =>
        sse.events.some(
          event => event.type === 'session.history_saved' && event.session.sessionId === review1Id,
        ),
      6000,
    );
    review1.ptyProcess.write('EXIT0');
    factory.ptyProcess.write('EXIT0');
    review2.ptyProcess.write('EXIT');

    await sse.readUntil(
      () =>
        [review1Id, review2Id, factoryId].every(id =>
          sse.events.some(
            event => event.type === 'session.finished' && event.session.sessionId === id,
          ),
        ),
      6000,
    );

    const finishedEvents = sse.events.filter(
      (event): event is Extract<AppEvent, { type: 'session.finished' }> =>
        event.type === 'session.finished',
    );

    const finishedReview1 = finishedEvents.find(event => event.session.sessionId === review1Id);
    const finishedReview2 = finishedEvents.find(event => event.session.sessionId === review2Id);
    const finishedFactory = finishedEvents.find(event => event.session.sessionId === factoryId);

    assert(finishedReview1 && finishedReview2 && finishedFactory);
    assert.equal(finishedReview1.session.status, 'exited');
    assert.equal(finishedReview1.session.historyState, 'saved');
    assert.equal(finishedReview1.session.exitCode, 0);

    assert.equal(finishedFactory.session.status, 'exited');
    assert.equal(finishedFactory.session.exitCode, 0);

    assert.equal(finishedReview2.session.status, 'failed');
    assert.equal(finishedReview2.session.historyState, 'incomplete');
    assert.equal(finishedReview2.session.exitCode, 7);

    // Conferência final em GET /api/sessions.
    const finalListRes = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(finalListRes.status, 200);
    const finalBody = (await finalListRes.json()) as { sessions: BackgroundSessionSummary[] };
    const finalSessions = BackgroundSessionSummarySchema.array().parse(finalBody.sessions);
    assert.equal(finalSessions.length, 3);
    assert.equal(finalSessions.find(item => item.sessionId === review1Id)?.status, 'exited');
    assert.equal(finalSessions.find(item => item.sessionId === factoryId)?.status, 'exited');
    assert.equal(finalSessions.find(item => item.sessionId === review2Id)?.status, 'failed');

    await sse.close();
  },
);

test(
  'encerramento explícito via POST /api/sessions/:id/stop e stop_session transiciona para cancelled e encerra PTY',
  { timeout: 15000 },
  async context => {
    const { baseUrl, wsUrl, repoDir, reportDirectory, sessionManager, sockets, abortControllers } =
      await setupServer(context, 'df-bg-stop-');

    const sse = await connectSse(baseUrl, abortControllers);
    const wsReview = await connectWs(wsUrl, sockets);
    const wsFactory = await connectWs(wsUrl, sockets);

    wsReview.send({
      type: 'start_review',
      targetType: 'pr',
      identifier: '901',
      repoPath: repoDir,
      reportDirectory,
      cols: 80,
      rows: 24,
    });
    wsFactory.send({
      type: 'start_factory',
      inputType: 'title',
      value: 'Fábrica para cancelar',
      repoPath: repoDir,
      cols: 80,
      rows: 24,
    });

    const [attachedReview, attachedFactory] = await Promise.all([
      wsReview.take(
        (msg): msg is Extract<ServerMessage, { type: 'session_attached' }> =>
          msg.type === 'session_attached',
        'session_attached review',
      ),
      wsFactory.take(
        (msg): msg is Extract<ServerMessage, { type: 'session_attached' }> =>
          msg.type === 'session_attached',
        'session_attached factory',
      ),
    ]);

    const reviewSessionId = attachedReview.session.sessionId;
    const factorySessionId = attachedFactory.session.sessionId;
    const reviewSession = sessionManager.getSession(reviewSessionId);
    const factorySession = sessionManager.getSession(factorySessionId);
    assert(reviewSession && factorySession);

    await waitFor(
      () =>
        reviewSession.buffer.replay().includes('READY:') &&
        factorySession.buffer.replay().includes('READY:'),
      'READY nas sessões antes do cancelamento',
    );

    // 1) Encerramento explícito via POST /api/sessions/:id/stop
    const stopRes = await fetch(`${baseUrl}/api/sessions/${reviewSessionId}/stop`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(stopRes.status, 200);
    const stopBody = (await stopRes.json()) as { session: BackgroundSessionSummary };
    const stoppedReview = BackgroundSessionSummarySchema.parse(stopBody.session);
    assert.equal(stoppedReview.sessionId, reviewSessionId);
    assert.equal(stoppedReview.status, 'cancelled');
    assert.notEqual(stoppedReview.finishedAt, null);
    assert.equal(reviewSession.ptyProcess, undefined);

    const wsReviewStatus = await wsReview.take(
      (msg): msg is Extract<ServerMessage, { type: 'status' }> =>
        msg.type === 'status' && msg.state === 'exited',
      'status exited após POST /stop',
    );
    assert.equal(wsReviewStatus.sessionId, reviewSessionId);

    const wsReviewState = await wsReview.take(
      (msg): msg is Extract<ServerMessage, { type: 'review' }> =>
        msg.type === 'review' && msg.state === 'cancelled',
      'review cancelled após POST /stop',
    );
    assert.equal(wsReviewState.state, 'cancelled');

    await sse.readUntil(
      () =>
        sse.events.some(
          event =>
            event.type === 'session.finished' &&
            event.session.sessionId === reviewSessionId &&
            event.session.status === 'cancelled',
        ),
      6000,
    );

    // 2) Encerramento explícito via stop_session no WebSocket
    wsFactory.send({
      type: 'stop_session',
      sessionId: factorySessionId,
    });

    await waitFor(() => factorySession.status === 'cancelled', 'factory status cancelled');
    assert.notEqual(factorySession.finishedAt, null);
    assert.equal(factorySession.ptyProcess, undefined);

    const wsFactoryStatus = await wsFactory.take(
      (msg): msg is Extract<ServerMessage, { type: 'status' }> =>
        msg.type === 'status' && msg.state === 'exited',
      'status exited após stop_session WS',
    );
    assert.equal(wsFactoryStatus.sessionId, factorySessionId);

    await sse.readUntil(
      () =>
        sse.events.some(
          event =>
            event.type === 'session.finished' &&
            event.session.sessionId === factorySessionId &&
            event.session.status === 'cancelled',
        ),
      6000,
    );

    // Confere estado persistido na API REST para ambas as sessões.
    for (const id of [reviewSessionId, factorySessionId]) {
      const detailRes = await fetch(`${baseUrl}/api/sessions/${id}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(detailRes.status, 200);
      const detailBody = (await detailRes.json()) as { session: BackgroundSessionSummary };
      const detail = BackgroundSessionSummarySchema.parse(detailBody.session);
      assert.equal(detail.status, 'cancelled');
      assert.notEqual(detail.finishedAt, null);
    }

    await Promise.all([wsReview.close(), wsFactory.close(), sse.close()]);
  },
);
