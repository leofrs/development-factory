import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const xdgDataHome = join(rootDir, 'xdg-data');
  mkdirSync(binDir);
  mkdirSync(repoA);
  mkdirSync(repoB);
  mkdirSync(xdgDataHome);

  const claudeTarget = join(binDir, 'claude');
  copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
  chmodSync(claudeTarget, 0o755);

  const previousPath = process.env.PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.XDG_DATA_HOME = xdgDataHome;

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
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
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
      reportDirectory: env.rootDir,
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
      reportDirectory: env.rootDir,
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
      reportDirectory: env.rootDir,
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
    await waitFor(() => first.historyState === 'incomplete');

    // Antes do TTL, a sessão finalizada permanece listável em memória.
    assert.equal(manager.listSessions().length, 1);

    // Após o TTL, é removida da memória preservando os dados no SQLite.
    currentNow += 6_000;
    assert.equal(manager.cleanupExpiredSessions(), 1);
    assert.equal(manager.listSessions().length, 0);

    const reviewId = first.activeReviewSession?.reviewId;
    assert.ok(reviewId);
    const persisted = await env.reviewService.getReview(reviewId);
    assert.ok(persisted);
    assert.equal(first.sessionPath, null);
    assert.ok(first.reportPath && !existsSync(first.reportPath));
  } finally {
    await manager.shutdownAll();
    env.repository.close();
    env.restorePath();
    rmSync(env.rootDir, { recursive: true, force: true });
  }
});

test('sessão review sem nenhum cliente WebSocket conectado salva apenas o parecer e emite history_saved e finished', async () => {
  const env = setupTestEnvironment();
  const events: AppEvent[] = [];
  const manager = new SessionManager(env.reviewService);
  const unsubscribe = manager.onEvent(event => events.push(event));

  try {
    const session = await manager.startReviewSession({
      targetType: 'pr',
      identifier: '777',
      repoPath: env.repoA,
      reportDirectory: env.rootDir,
      cols: 80,
      rows: 24,
    });

    assert.equal(session.subscribers.size, 0);
    await waitFor(() => session.buffer.replay().includes('READY:'));

    manager.writeInput(session.sessionId, 'SAVE');
    await waitFor(() => events.some(e => e.type === 'session.history_saved'));

    const savedEvent = events.find(e => e.type === 'session.history_saved');
    assert.ok(savedEvent);
    assert.equal(savedEvent.session.sessionId, session.sessionId);
    assert.equal(savedEvent.session.historyState, 'saved');
    assert.equal(savedEvent.session.reportPath, session.reportPath);
    assert.ok(session.reportPath && existsSync(session.reportPath));
    assert.equal(readFileSync(session.reportPath, 'utf8'), '# Parecer final\n\nAPROVADO\n');

    manager.writeInput(session.sessionId, 'EXIT0');
    await waitFor(() => events.some(e => e.type === 'session.finished'));

    const finishedEvent = events.find(e => e.type === 'session.finished');
    assert.ok(finishedEvent);
    assert.equal(finishedEvent.session.status, 'exited');
    assert.equal(finishedEvent.session.exitCode, 0);
    assert.equal(finishedEvent.session.historyState, 'saved');
    assert.equal(finishedEvent.session.reportPath, session.reportPath);

    const reviewId = session.activeReviewSession?.reviewId;
    assert.ok(reviewId);
    const details = await env.reviewService.getReview(reviewId);
    assert.ok(details);
    assert.equal(details.review.state, 'incomplete');
    assert.deepEqual(details.executions[0]?.process, { status: 'exited', exitCode: 0, signal: null });
    assert.equal(details.artifacts.length, 1);
    assert.equal(details.artifacts.find(a => a.kind === 'report')?.status, 'ready');
    assert.ok(details.events.some(e => e.type === 'review.report_file_saved'));
    assert.equal(session.sessionPath, null);
    assert.equal(existsSync(join(env.repoA, '.code-reviews')), false);
  } finally {
    unsubscribe();
    await manager.shutdownAll();
    env.repository.close();
    env.restorePath();
    rmSync(env.rootDir, { recursive: true, force: true });
  }
});

test('sessão factory sem clientes conectados consolida falha e estado incomplete ao sair com código diferente de zero', async () => {
  const env = setupTestEnvironment();
  const events: AppEvent[] = [];
  const manager = new SessionManager(env.reviewService);
  const unsubscribe = manager.onEvent(event => events.push(event));

  try {
    const session = await manager.startFactorySession({
      inputType: 'title',
      value: 'Plano interrompido com erro',
      repoPath: env.repoB,
      cols: 80,
      rows: 24,
    });

    assert.equal(session.subscribers.size, 0);
    await waitFor(() => session.buffer.replay().includes('READY:'));

    manager.writeInput(session.sessionId, 'EXIT');
    await waitFor(() => events.some(e => e.type === 'session.finished'));

    const finishedEvent = events.find(e => e.type === 'session.finished');
    assert.ok(finishedEvent);
    assert.equal(finishedEvent.session.status, 'failed');
    assert.equal(finishedEvent.session.exitCode, 7);
    assert.equal(finishedEvent.session.historyState, 'incomplete');
    assert.equal(finishedEvent.session.reportPath, session.reportPath);
    assert.ok(session.reportPath && existsSync(session.reportPath));
    assert.match(
      readFileSync(session.reportPath, 'utf8'),
      /Documento de Entendimento do Problema incompleto/,
    );
    assert.equal(existsSync(join(env.repoB, '.code-reviews')), false);
  } finally {
    unsubscribe();
    await manager.shutdownAll();
    env.repository.close();
    env.restorePath();
    rmSync(env.rootDir, { recursive: true, force: true });
  }
});
