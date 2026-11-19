import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import type { AppEvent, ServerMessage } from '@development-factory/shared';
import { ReviewService } from '../src/review-service.js';
import { SessionManager, SessionManagerError } from '../src/session-manager.js';
import { SqliteReviewRepository } from '../src/storage/index.js';

interface FakeSocket {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[];
}

function createFakeSocket(): FakeSocket {
  const messages: ServerMessage[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(payload: string) {
      messages.push(JSON.parse(payload) as ServerMessage);
    },
  };
  return {
    ws: socket as unknown as WebSocket,
    messages,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Tempo limite excedido aguardando condição no teste do SessionManager.');
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
  }
}

function setupTestEnvironment(): {
  rootDir: string;
  repoA: string;
  repoB: string;
  repository: SqliteReviewRepository;
  reviewService: ReviewService;
  restorePath: () => void;
} {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-session-manager-'));
  const binDir = join(rootDir, 'bin');
  const repoA = join(rootDir, 'repo-a');
  const repoB = join(rootDir, 'repo-b');
  mkdirSync(binDir);
  mkdirSync(repoA);
  mkdirSync(repoB);

  const claudeTarget = join(binDir, 'claude');
  copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
  chmodSync(claudeTarget, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;

  const repository = SqliteReviewRepository.open({ dbPath: join(rootDir, 'reviews.db') });
  const reviewService = new ReviewService(repository);

  return {
    rootDir,
    repoA,
    repoB,
    repository,
    reviewService,
    restorePath: () => {
      process.env.PATH = previousPath;
    },
  };
}

test('SessionManager executa sessões review e factory simultaneamente sem interferência', async () => {
  const env = setupTestEnvironment();
  const events: AppEvent[] = [];
  const manager = new SessionManager(env.reviewService);
  const unsubscribe = manager.onEvent(event => events.push(event));

  try {
    const reviewSession = await manager.startReviewSession({
      targetType: 'pr',
      identifier: '142',
      repoPath: env.repoA,
      cols: 80,
      rows: 24,
    });

    const factorySession = await manager.startFactorySession({
      inputType: 'title',
      value: 'Implementar fila de sessões',
      repoPath: env.repoB,
      cols: 100,
      rows: 30,
    });

    assert.notEqual(reviewSession.sessionId, factorySession.sessionId);
    assert.equal(manager.listSessions().length, 2);

    const reviewSocket = createFakeSocket();
    const factorySocket = createFakeSocket();
    manager.attachClient(reviewSession.sessionId, reviewSocket.ws);
    manager.attachClient(factorySession.sessionId, factorySocket.ws);

    await waitFor(
      () =>
        reviewSession.buffer.replay().includes('READY:') &&
        factorySession.buffer.replay().includes('READY:'),
    );

    manager.writeInput(reviewSession.sessionId, 'ONLY_REVIEW');
    manager.writeInput(factorySession.sessionId, 'ONLY_FACTORY');

    await waitFor(
      () =>
        reviewSession.buffer.replay().includes('INPUT:ONLY_REVIEW') &&
        factorySession.buffer.replay().includes('INPUT:ONLY_FACTORY'),
    );

    assert.equal(reviewSession.buffer.replay().includes('ONLY_FACTORY'), false);
    assert.equal(factorySession.buffer.replay().includes('ONLY_REVIEW'), false);

    manager.writeInput(reviewSession.sessionId, 'EXIT0');
    manager.writeInput(factorySession.sessionId, 'EXIT0');

    await waitFor(
      () => reviewSession.status === 'exited' && factorySession.status === 'exited',
    );

    assert.ok(events.some(e => e.type === 'session.started' && e.session.sessionId === reviewSession.sessionId));
    assert.ok(events.some(e => e.type === 'session.started' && e.session.sessionId === factorySession.sessionId));
    assert.ok(events.some(e => e.type === 'session.finished' && e.session.sessionId === reviewSession.sessionId));
    assert.ok(events.some(e => e.type === 'session.finished' && e.session.sessionId === factorySession.sessionId));
  } finally {
    unsubscribe();
    await manager.shutdownAll();
    env.repository.close();
    env.restorePath();
    rmSync(env.rootDir, { recursive: true, force: true });
  }
});

test('desanexar todos os clientes mantém PTY vivo e reconectar envia replay completo', async () => {
  const env = setupTestEnvironment();
  const manager = new SessionManager(env.reviewService);

  try {
    const session = await manager.startFactorySession({
      inputType: 'jira_key',
      value: 'DF-104',
      repoPath: env.repoA,
      cols: 80,
      rows: 24,
    });

    const firstClient = createFakeSocket();
    manager.attachClient(session.sessionId, firstClient.ws);

    await waitFor(() => session.buffer.replay().includes('READY:'));

    // Desanexa todos os clientes enquanto o PTY ainda está em execução.
    manager.detachClient(session.sessionId, firstClient.ws);
    assert.equal(session.subscribers.size, 0);
    assert.equal(session.status, 'running');

    manager.writeInput(session.sessionId, 'BACKGROUND_LINE');
    await waitFor(() => session.buffer.replay().includes('INPUT:BACKGROUND_LINE'));
    assert.equal(
      firstClient.messages.some(msg => msg.type === 'output' && msg.data.includes('BACKGROUND_LINE')),
      false,
    );

    // Reconecta novo cliente e valida replay do buffer.
    const secondClient = createFakeSocket();
    manager.attachClient(session.sessionId, secondClient.ws);

    const attached = secondClient.messages.find(msg => msg.type === 'session_attached');
    assert.ok(attached && attached.type === 'session_attached');
    assert.ok(attached.replay.includes('READY:'));
    assert.ok(attached.replay.includes('INPUT:BACKGROUND_LINE'));

    manager.writeInput(session.sessionId, 'EXIT0');
    await waitFor(() => session.status === 'exited');
  } finally {
    await manager.shutdownAll();
    env.repository.close();
    env.restorePath();
    rmSync(env.rootDir, { recursive: true, force: true });
  }
});

test('stopSession encerra PTY, finaliza histórico e transiciona ReviewService para cancelled', async () => {
  const env = setupTestEnvironment();
  const manager = new SessionManager(env.reviewService);

  try {
    const session = await manager.startReviewSession({
      targetType: 'branch',
      identifier: 'feat/background',
      repoPath: env.repoA,
      cols: 80,
      rows: 24,
    });

    await waitFor(() => session.buffer.replay().includes('READY:'));

    const summary = await manager.stopSession(session.sessionId, 'Cancelado pelo usuário no teste');
    assert.equal(summary.status, 'cancelled');
    assert.ok(summary.finishedAt !== null);
    assert.equal(session.ptyProcess, undefined);

    const reviewId = session.activeReviewSession?.reviewId;
    assert.ok(reviewId);
    const details = await env.reviewService.getReview(reviewId);
    assert.equal(details?.review.state, 'cancelled');
  } finally {
    await manager.shutdownAll();
    env.repository.close();
    env.restorePath();
    rmSync(env.rootDir, { recursive: true, force: true });
  }
});

test('respeita limite de sessões concorrentes e limpa sessões finalizadas por TTL sem apagar persistência', async () => {
  const env = setupTestEnvironment();
  let currentNow = 1_700_000_000_000;
  const manager = new SessionManager(env.reviewService, {
    maxConcurrentSessions: 1,
    completedSessionTtlMs: 5_000,
    now: () => currentNow,
  });

  try {
    const first = await manager.startReviewSession({
      targetType: 'pr',
      identifier: '55',
      repoPath: env.repoA,
      cols: 80,
      rows: 24,
    });

    await assert.rejects(
      () =>
        manager.startFactorySession({
          inputType: 'title',
          value: 'Sessão excedente',
          repoPath: env.repoB,
          cols: 80,
          rows: 24,
        }),
      (error: unknown) =>
        error instanceof SessionManagerError && error.code === 'MAX_SESSIONS_REACHED',
    );

    await waitFor(() => first.buffer.replay().includes('READY:'));
    manager.writeInput(first.sessionId, 'EXIT0');
    await waitFor(() => first.status === 'exited');

    // Antes do TTL, a sessão finalizada permanece listável em memória.
    assert.equal(manager.listSessions().length, 1);

    // Após o TTL, é removida da memória sem apagar SQLite nem arquivos .code-reviews/.
    currentNow += 6_000;
    assert.equal(manager.cleanupExpiredSessions(), 1);
    assert.equal(manager.listSessions().length, 0);

    const reviewId = first.activeReviewSession?.reviewId;
    assert.ok(reviewId);
    const persisted = await env.reviewService.getReview(reviewId);
    assert.ok(persisted);
    assert.ok(first.sessionPath && existsSync(first.sessionPath));
  } finally {
    await manager.shutdownAll();
    env.repository.close();
    env.restorePath();
    rmSync(env.rootDir, { recursive: true, force: true });
  }
});
