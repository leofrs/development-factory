import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import {
  REVIEW_CONTRACT_VERSION,
  type AppEvent,
  type BackgroundSessionSummary,
  type FactoryRequest,
  type ReviewError,
  type ReviewProcess,
  type ReviewRequest,
  type ServerMessage,
} from '@development-factory/shared';
import { createFactoryHistory, createReviewHistory } from './history.js';
import { buildCodeReviewPrompt } from './prompts/code-review.js';
import { buildFactoryPlanPrompt } from './prompts/factory-plan.js';
import { ReviewServiceError, type ReviewService } from './review-service.js';
import {
  DEFAULT_SESSION_BUFFER_MAX_BYTES,
  SessionOutputBuffer,
  toBackgroundSessionSummary,
  type ActiveReviewSession,
  type ManagedSession,
} from './session-buffer.js';

export const DEFAULT_MAX_CONCURRENT_SESSIONS = 8;
export const DEFAULT_COMPLETED_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const APP_EVENT_NAME = 'app_event';

export type SessionManagerErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'INVALID_REPO_PATH'
  | 'MAX_SESSIONS_REACHED'
  | 'SESSION_NOT_RUNNING'
  | 'SESSION_CREATION_FAILED';

export class SessionManagerError extends Error {
  readonly code: SessionManagerErrorCode;
  readonly statusCode: number;

  constructor(code: SessionManagerErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'SessionManagerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface SessionManagerOptions {
  readonly eventEmitter?: EventEmitter;
  readonly maxConcurrentSessions?: number;
  readonly completedSessionTtlMs?: number;
  readonly bufferMaxBytes?: number;
  readonly cleanupIntervalMs?: number;
  readonly now?: () => number;
}

export interface StartReviewSessionInput extends ReviewRequest {
  readonly cols: number;
  readonly rows: number;
}

export interface StartFactorySessionInput extends FactoryRequest {
  readonly cols: number;
  readonly rows: number;
}

interface SessionRuntime {
  readonly session: ManagedSession;
  operationChain: Promise<void>;
  finalized: boolean;
}

function buildReviewError(code: string, message: string, retryable: boolean): ReviewError {
  return {
    contractVersion: REVIEW_CONTRACT_VERSION,
    code,
    message,
    occurredAt: new Date().toISOString(),
    retryable,
  };
}

function formatReviewTitle(request: ReviewRequest): string {
  return request.targetType === 'pr' ? `PR #${request.identifier}` : `Branch ${request.identifier}`;
}

function formatFactoryTitle(request: FactoryRequest): string {
  const trimmed = request.value.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

function validateRepoPath(repoPath: string): void {
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new SessionManagerError(
      'INVALID_REPO_PATH',
      'O caminho do repositório não existe ou não é um diretório no WSL.',
      400,
    );
  }
}

function sendToSocket(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(session: ManagedSession, message: ServerMessage): void {
  for (const subscriber of session.subscribers) {
    sendToSocket(subscriber, message);
  }
}

function disposePtyProcess(session: ManagedSession, killProcess: boolean): void {
  const current = session.ptyProcess;
  session.ptyProcess = undefined;
  for (const subscription of session.subscriptions) {
    subscription.dispose();
  }
  session.subscriptions = [];
  if (killProcess && current) {
    try {
      current.kill();
    } catch {
      // O processo pode já ter sido encerrado pelo sistema operacional.
    }
  }
}

export class SessionManager {
  readonly #reviewService: ReviewService;
  readonly #eventEmitter: EventEmitter;
  readonly #maxConcurrentSessions: number;
  readonly #completedSessionTtlMs: number;
  readonly #bufferMaxBytes: number;
  readonly #now: () => number;
  readonly #runtimes = new Map<string, SessionRuntime>();
  #cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(reviewService: ReviewService, options: SessionManagerOptions = {}) {
    const maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    if (!Number.isInteger(maxConcurrentSessions) || maxConcurrentSessions <= 0) {
      throw new Error('maxConcurrentSessions deve ser um inteiro positivo.');
    }

    const completedSessionTtlMs = options.completedSessionTtlMs ?? DEFAULT_COMPLETED_SESSION_TTL_MS;
    if (!Number.isFinite(completedSessionTtlMs) || completedSessionTtlMs < 0) {
      throw new Error('completedSessionTtlMs deve ser um número finito não negativo.');
    }

    const bufferMaxBytes = options.bufferMaxBytes ?? DEFAULT_SESSION_BUFFER_MAX_BYTES;
    if (!Number.isInteger(bufferMaxBytes) || bufferMaxBytes <= 0) {
      throw new Error('bufferMaxBytes deve ser um inteiro positivo.');
    }

    const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    if (!Number.isFinite(cleanupIntervalMs) || cleanupIntervalMs <= 0) {
      throw new Error('cleanupIntervalMs deve ser um número finito positivo.');
    }

    this.#reviewService = reviewService;
    this.#eventEmitter = options.eventEmitter ?? new EventEmitter();
    this.#maxConcurrentSessions = maxConcurrentSessions;
    this.#completedSessionTtlMs = completedSessionTtlMs;
    this.#bufferMaxBytes = bufferMaxBytes;
    this.#now = options.now ?? Date.now;

    this.#cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, cleanupIntervalMs);
    this.#cleanupTimer.unref();
  }

  onEvent(listener: (event: AppEvent) => void): () => void {
    this.#eventEmitter.on(APP_EVENT_NAME, listener);
    return () => {
      this.#eventEmitter.off(APP_EVENT_NAME, listener);
    };
  }

  #emitEvent(event: AppEvent): void {
    this.#eventEmitter.emit(APP_EVENT_NAME, event);
  }

  #enqueue(runtime: SessionRuntime, task: () => Promise<void>): void {
    runtime.operationChain = runtime.operationChain.then(task).catch(error => {
      const detail = error instanceof Error ? error.message : 'Falha desconhecida';
      broadcast(runtime.session, {
        type: 'error',
        message: `Não foi possível operar a sessão em background: ${detail}`,
      });
    });
  }

  #countRunningSessions(): number {
    let running = 0;
    for (const runtime of this.#runtimes.values()) {
      if (runtime.session.status === 'running') {
        running += 1;
      }
    }
    return running;
  }

  #assertCapacity(): void {
    this.cleanupExpiredSessions();
    if (this.#countRunningSessions() >= this.#maxConcurrentSessions) {
      throw new SessionManagerError(
        'MAX_SESSIONS_REACHED',
        `Limite máximo de ${this.#maxConcurrentSessions} sessões simultâneas atingido.`,
        429,
      );
    }
  }

  #getRuntimeOrThrow(sessionId: string): SessionRuntime {
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime) {
      throw new SessionManagerError('SESSION_NOT_FOUND', `Sessão ${sessionId} não encontrada.`, 404);
    }
    return runtime;
  }

  async startReviewSession(input: StartReviewSessionInput): Promise<ManagedSession> {
    validateRepoPath(input.repoPath);
    this.#assertCapacity();

    const created = await this.#reviewService.createReview({
      target: {
        type: input.targetType,
        identifier: input.identifier,
        repoPath: input.repoPath,
      },
    });

    let preparedArtifacts;
    try {
      preparedArtifacts = await this.#reviewService.prepareExecutionArtifacts(created.review.id, {
        executionId: created.execution.id,
        includeStructuredResult: false,
      });
    } catch (error) {
      const message =
        error instanceof ReviewServiceError
          ? error.message
          : 'Não foi possível preparar os arquivos do review.';
      throw new SessionManagerError('SESSION_CREATION_FAILED', message, 500);
    }

    const reportArtifact = preparedArtifacts.artifacts.find(item => item.kind === 'report');
    const sessionArtifact = preparedArtifacts.artifacts.find(item => item.kind === 'session_log');
    if (!reportArtifact || !sessionArtifact) {
      throw new SessionManagerError(
        'SESSION_CREATION_FAILED',
        'Os artefatos obrigatórios do review não foram preparados.',
        500,
      );
    }

    const activeReviewSession: ActiveReviewSession = {
      reviewId: created.review.id,
      executionId: created.execution.id,
      reportArtifactId: reportArtifact.id,
      sessionArtifactId: sessionArtifact.id,
      reportSaved: false,
    };

    const session: ManagedSession = {
      sessionId: randomUUID(),
      mode: 'review',
      title: formatReviewTitle(input),
      repoPath: input.repoPath,
      status: 'running',
      historyState: 'pending',
      reportPath: reportArtifact.path,
      sessionPath: sessionArtifact.path,
      ptyProcess: undefined,
      subscriptions: [],
      history: undefined,
      activeReviewSession,
      subscribers: new Set<WebSocket>(),
      buffer: new SessionOutputBuffer(this.#bufferMaxBytes),
      startedAt: new Date(this.#now()).toISOString(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
    };

    const runtime: SessionRuntime = {
      session,
      operationChain: Promise.resolve(),
      finalized: false,
    };

    const reviewHistory = createReviewHistory(
      input,
      state => {
        session.historyState = state;
        if (state === 'saved') {
          activeReviewSession.reportSaved = true;
          this.#enqueue(runtime, async () => {
            await this.#reviewService.updateArtifactStatus(
              activeReviewSession.reviewId,
              activeReviewSession.reportArtifactId,
              'ready',
              null,
              'review.report_file_saved',
            );
          });
          this.#emitEvent({
            type: 'session.history_saved',
            session: toBackgroundSessionSummary(session),
          });
        } else {
          this.#emitEvent({
            type: 'session.updated',
            session: toBackgroundSessionSummary(session),
          });
        }
        broadcast(session, {
          type: 'history',
          reportPath: reportArtifact.path,
          sessionPath: sessionArtifact.path,
          state,
        });
      },
      message => {
        broadcast(session, { type: 'error', message });
      },
      {
        reviewId: created.review.id,
        executionId: created.execution.id,
        prepared: {
          reportPath: reportArtifact.path,
          sessionPath: sessionArtifact.path,
          startedAt: created.execution.createdAt,
        },
      },
    );
    session.history = reviewHistory;

    let child: pty.IPty;
    try {
      child = pty.spawn(
        'claude',
        [buildCodeReviewPrompt(input.targetType, input.identifier, reportArtifact.path)],
        {
          name: 'xterm-256color',
          cols: input.cols,
          rows: input.rows,
          cwd: input.repoPath,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Falha desconhecida';
      session.history = undefined;
      reviewHistory.finish(`falha ao iniciar processo PTY: ${detail}`);

      const spawnError = buildReviewError(
        'PTY_SPAWN_FAILED',
        `Não foi possível iniciar o processo Claude: ${detail}`,
        true,
      );
      await this.#reviewService.updateArtifactStatus(
        activeReviewSession.reviewId,
        activeReviewSession.sessionArtifactId,
        'ready',
        null,
        'review.session_log_saved',
      );
      await this.#reviewService.updateArtifactStatus(
        activeReviewSession.reviewId,
        activeReviewSession.reportArtifactId,
        'incomplete',
        spawnError,
      );
      await this.#reviewService.finishExecution(
        activeReviewSession.reviewId,
        activeReviewSession.executionId,
        {
          process: { status: 'failed', error: spawnError },
          targetState: 'failed',
          reason: `Falha ao iniciar o processo PTY: ${detail}`,
          error: spawnError,
        },
      );
      throw new SessionManagerError(
        'SESSION_CREATION_FAILED',
        `Não foi possível operar o terminal: ${detail}. Verifique o caminho e se claude está no PATH do servidor.`,
        500,
      );
    }

    session.ptyProcess = child;
    session.subscriptions = [
      child.onData(data => {
        if (session.ptyProcess !== child) {
          return;
        }
        session.buffer.append(data);
        session.history?.record(data);
        broadcast(session, { type: 'output', data });
      }),
      child.onExit(({ exitCode, signal }) => {
        this.#handlePtyExit(runtime, child, exitCode, signal);
      }),
    ];

    this.#runtimes.set(session.sessionId, runtime);
    await this.#reviewService.startExecution(created.review.id, created.execution.id, child.pid);

    this.#emitEvent({
      type: 'session.started',
      session: toBackgroundSessionSummary(session),
    });

    return session;
  }

  async startFactorySession(input: StartFactorySessionInput): Promise<ManagedSession> {
    validateRepoPath(input.repoPath);
    this.#assertCapacity();

    const session: ManagedSession = {
      sessionId: randomUUID(),
      mode: 'factory',
      title: formatFactoryTitle(input),
      repoPath: input.repoPath,
      status: 'running',
      historyState: 'pending',
      reportPath: null,
      sessionPath: null,
      ptyProcess: undefined,
      subscriptions: [],
      history: undefined,
      activeReviewSession: undefined,
      subscribers: new Set<WebSocket>(),
      buffer: new SessionOutputBuffer(this.#bufferMaxBytes),
      startedAt: new Date(this.#now()).toISOString(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
    };

    const runtime: SessionRuntime = {
      session,
      operationChain: Promise.resolve(),
      finalized: false,
    };

    let factoryHistory: ReturnType<typeof createFactoryHistory>;
    try {
      factoryHistory = createFactoryHistory(
        input,
        state => {
          session.historyState = state;
          if (state === 'saved') {
            this.#emitEvent({
              type: 'session.history_saved',
              session: toBackgroundSessionSummary(session),
            });
          } else {
            this.#emitEvent({
              type: 'session.updated',
              session: toBackgroundSessionSummary(session),
            });
          }
          broadcast(session, {
            type: 'history',
            reportPath: factoryHistory.reportPath,
            sessionPath: factoryHistory.sessionPath,
            state,
          });
        },
        message => {
          broadcast(session, { type: 'error', message });
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Falha desconhecida';
      throw new SessionManagerError(
        'SESSION_CREATION_FAILED',
        `Não foi possível preparar os arquivos do planejamento: ${detail}`,
        500,
      );
    }

    session.history = factoryHistory;
    session.reportPath = factoryHistory.reportPath;
    session.sessionPath = factoryHistory.sessionPath;

    let child: pty.IPty;
    try {
      child = pty.spawn(
        'claude',
        [buildFactoryPlanPrompt(input.inputType, input.value, factoryHistory.reportPath)],
        {
          name: 'xterm-256color',
          cols: input.cols,
          rows: input.rows,
          cwd: input.repoPath,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Falha desconhecida';
      session.history = undefined;
      factoryHistory.finish(`falha ao iniciar processo PTY: ${detail}`);
      throw new SessionManagerError(
        'SESSION_CREATION_FAILED',
        `Não foi possível operar o terminal: ${detail}. Verifique o caminho e se claude está no PATH do servidor.`,
        500,
      );
    }

    session.ptyProcess = child;
    session.subscriptions = [
      child.onData(data => {
        if (session.ptyProcess !== child) {
          return;
        }
        session.buffer.append(data);
        session.history?.record(data);
        broadcast(session, { type: 'output', data });
      }),
      child.onExit(({ exitCode, signal }) => {
        this.#handlePtyExit(runtime, child, exitCode, signal);
      }),
    ];

    this.#runtimes.set(session.sessionId, runtime);
    this.#emitEvent({
      type: 'session.started',
      session: toBackgroundSessionSummary(session),
    });

    return session;
  }

  #handlePtyExit(
    runtime: SessionRuntime,
    child: pty.IPty,
    exitCode: number,
    signal: number | undefined,
  ): void {
    const { session } = runtime;
    if (session.ptyProcess !== child || runtime.finalized) {
      return;
    }
    runtime.finalized = true;

    disposePtyProcess(session, false);
    const currentHistory = session.history;
    session.history = undefined;
    currentHistory?.finish(`processo finalizado com código ${exitCode}`);

    session.exitCode = exitCode;
    session.signal = signal ?? null;
    session.finishedAt = new Date(this.#now()).toISOString();
    session.status = exitCode === 0 ? 'exited' : 'failed';
    if (exitCode !== 0) {
      session.error = `Processo PTY encerrado com código ${exitCode}.`;
    }

    broadcast(session, {
      type: 'status',
      state: 'exited',
      exitCode,
      sessionId: session.sessionId,
    });

    const activeReview = session.activeReviewSession;
    if (!activeReview) {
      this.#emitEvent({
        type: 'session.finished',
        session: toBackgroundSessionSummary(session),
      });
      return;
    }

    this.#enqueue(runtime, async () => {
      const processExit: Extract<ReviewProcess, { status: 'exited' }> =
        typeof exitCode === 'number'
          ? { status: 'exited', exitCode, signal: null }
          : { status: 'exited', exitCode: null, signal: signal ? String(signal) : 'UNKNOWN' };

      const targetState = exitCode === 0 ? 'incomplete' : 'failed';
      const exitError =
        exitCode === 0
          ? buildReviewError(
              'RESULT_NOT_VALIDATED',
              'O processo PTY encerrou com código 0 sem resultado estruturado validado.',
              true,
            )
          : buildReviewError(
              'PTY_PROCESS_FAILED',
              `Processo PTY encerrado com código ${exitCode}.`,
              true,
            );

      try {
        await this.#reviewService.updateArtifactStatus(
          activeReview.reviewId,
          activeReview.sessionArtifactId,
          'ready',
          null,
          'review.session_log_saved',
        );
        if (!activeReview.reportSaved) {
          await this.#reviewService.updateArtifactStatus(
            activeReview.reviewId,
            activeReview.reportArtifactId,
            'incomplete',
            buildReviewError(
              'REPORT_NOT_SAVED',
              'O parecer final não foi salvo antes do encerramento do processo.',
              true,
            ),
          );
        }
        const finished = await this.#reviewService.finishExecution(
          activeReview.reviewId,
          activeReview.executionId,
          {
            process: processExit,
            targetState,
            reason: `Processo PTY finalizado com código ${exitCode}.`,
            error: exitError,
          },
        );
        broadcast(session, {
          type: 'review',
          reviewId: finished.review.id,
          executionId: finished.execution.id,
          state: finished.review.state,
        });
      } finally {
        this.#emitEvent({
          type: 'session.finished',
          session: toBackgroundSessionSummary(session),
        });
      }
    });
  }

  attachClient(sessionId: string, ws: WebSocket): BackgroundSessionSummary {
    const runtime = this.#getRuntimeOrThrow(sessionId);
    const { session } = runtime;
    session.subscribers.add(ws);

    const summary = toBackgroundSessionSummary(session);
    sendToSocket(ws, {
      type: 'session_attached',
      session: summary,
      replay: session.buffer.replay(),
    });

    if (session.reportPath && session.sessionPath) {
      sendToSocket(ws, {
        type: 'history',
        reportPath: session.reportPath,
        sessionPath: session.sessionPath,
        state: session.historyState,
      });
    }

    if (session.activeReviewSession) {
      sendToSocket(ws, {
        type: 'review',
        reviewId: session.activeReviewSession.reviewId,
        executionId: session.activeReviewSession.executionId,
        state:
          session.status === 'running'
            ? 'analyzing'
            : session.status === 'cancelled'
              ? 'cancelled'
              : session.status === 'failed'
                ? 'failed'
                : 'incomplete',
      });
    }

    sendToSocket(ws, {
      type: 'status',
      state: session.status === 'running' ? 'running' : 'exited',
      ...(session.status !== 'running' && typeof session.exitCode === 'number'
        ? { exitCode: session.exitCode }
        : {}),
      sessionId: session.sessionId,
    });

    return summary;
  }

  detachClient(sessionId: string, ws: WebSocket): void {
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime) {
      return;
    }
    runtime.session.subscribers.delete(ws);
  }

  detachClientFromAll(ws: WebSocket): void {
    for (const runtime of this.#runtimes.values()) {
      runtime.session.subscribers.delete(ws);
    }
  }

  writeInput(sessionId: string, data: string): void {
    const runtime = this.#getRuntimeOrThrow(sessionId);
    const { ptyProcess, status } = runtime.session;
    if (status !== 'running' || !ptyProcess) {
      throw new SessionManagerError(
        'SESSION_NOT_RUNNING',
        `A sessão ${sessionId} não está em execução.`,
        409,
      );
    }
    ptyProcess.write(data);
  }

  resizeSession(sessionId: string, cols: number, rows: number): void {
    const runtime = this.#getRuntimeOrThrow(sessionId);
    const { ptyProcess, status } = runtime.session;
    if (status !== 'running' || !ptyProcess) {
      throw new SessionManagerError(
        'SESSION_NOT_RUNNING',
        `A sessão ${sessionId} não está em execução.`,
        409,
      );
    }
    ptyProcess.resize(cols, rows);
  }

  async stopSession(
    sessionId: string,
    reason = 'sessão encerrada pelo usuário',
  ): Promise<BackgroundSessionSummary> {
    const runtime = this.#getRuntimeOrThrow(sessionId);
    const { session } = runtime;

    if (runtime.finalized || session.status !== 'running') {
      await runtime.operationChain;
      return toBackgroundSessionSummary(session);
    }

    runtime.finalized = true;
    disposePtyProcess(session, true);

    const currentHistory = session.history;
    session.history = undefined;
    currentHistory?.finish(reason);

    session.status = 'cancelled';
    session.finishedAt = new Date(this.#now()).toISOString();
    session.signal = 'SIGTERM';
    session.error = reason;

    broadcast(session, {
      type: 'status',
      state: 'exited',
      sessionId: session.sessionId,
    });

    const activeReview = session.activeReviewSession;
    if (activeReview) {
      this.#enqueue(runtime, async () => {
        try {
          await this.#reviewService.updateArtifactStatus(
            activeReview.reviewId,
            activeReview.sessionArtifactId,
            'ready',
            null,
            'review.session_log_saved',
          );
          if (!activeReview.reportSaved) {
            await this.#reviewService.updateArtifactStatus(
              activeReview.reviewId,
              activeReview.reportArtifactId,
              'incomplete',
              buildReviewError('REVIEW_INTERRUPTED', reason, true),
            );
          }
          const finished = await this.#reviewService.finishExecution(
            activeReview.reviewId,
            activeReview.executionId,
            {
              process: { status: 'exited', exitCode: null, signal: 'SIGTERM' },
              targetState: 'cancelled',
              reason,
              eventType: 'review.session_interrupted',
            },
          );
          broadcast(session, {
            type: 'review',
            reviewId: finished.review.id,
            executionId: finished.execution.id,
            state: finished.review.state,
          });
        } catch {
          // O repositório pode já estar encerrado durante o shutdown do servidor.
        }
      });
    }

    await runtime.operationChain;

    const summary = toBackgroundSessionSummary(session);
    this.#emitEvent({
      type: 'session.finished',
      session: summary,
    });
    return summary;
  }

  getSession(sessionId: string): ManagedSession | undefined {
    this.cleanupExpiredSessions();
    return this.#runtimes.get(sessionId)?.session;
  }

  getSessionSummary(sessionId: string): BackgroundSessionSummary | undefined {
    const session = this.getSession(sessionId);
    return session ? toBackgroundSessionSummary(session) : undefined;
  }

  listSessions(): BackgroundSessionSummary[] {
    this.cleanupExpiredSessions();
    const summaries: BackgroundSessionSummary[] = [];
    for (const runtime of this.#runtimes.values()) {
      summaries.push(toBackgroundSessionSummary(runtime.session));
    }
    return summaries.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  cleanupExpiredSessions(): number {
    const currentNow = this.#now();
    let removed = 0;

    for (const [sessionId, runtime] of this.#runtimes.entries()) {
      const { session } = runtime;
      if (session.status === 'running' || session.finishedAt === null) {
        continue;
      }
      const finishedMs = Date.parse(session.finishedAt);
      if (Number.isFinite(finishedMs) && currentNow - finishedMs >= this.#completedSessionTtlMs) {
        this.#runtimes.delete(sessionId);
        removed += 1;
      }
    }

    return removed;
  }

  async shutdownAll(reason = 'servidor encerrado'): Promise<void> {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = undefined;
    }

    const activeIds: string[] = [];
    for (const [sessionId, runtime] of this.#runtimes.entries()) {
      if (runtime.session.status === 'running') {
        activeIds.push(sessionId);
      }
    }

    await Promise.all(activeIds.map(sessionId => this.stopSession(sessionId, reason)));
    await Promise.all(Array.from(this.#runtimes.values(), runtime => runtime.operationChain));
  }
}
