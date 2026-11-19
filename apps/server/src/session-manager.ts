import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  REVIEW_CONTRACT_VERSION,
  getNextFactoryStage,
  isFinalFactoryFlowState,
  type AppEvent,
  type BackgroundSessionSummary,
  type FactoryFlowArtifactKind,
  type FactoryFlowDetails,
  type FactoryFlowError,
  type FactoryRequest,
  type FactoryStageName,
  type ReviewError,
  type ReviewProcess,
  type ReviewRequest,
  type ServerMessage,
} from '@development-factory/shared';
import { resolveReviewReportDirectory } from './artifacts.js';
import { FactoryFlowServiceError, type FactoryFlowService } from './factory-flow-service.js';
import { createFactoryHistory } from './history.js';
import { buildCodeReviewPrompt } from './prompts/code-review.js';
import { buildFactoryArchitecturePrompt } from './prompts/factory-architecture.js';
import { buildFactoryPlanPrompt } from './prompts/factory-plan.js';
import { createReviewReportDraft } from './review-report.js';
import { ReviewServiceError, type ReviewService } from './review-service.js';
import {
  DEFAULT_SESSION_BUFFER_MAX_BYTES,
  SessionOutputBuffer,
  toBackgroundSessionSummary,
  type ActiveFactorySession,
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
  | 'INVALID_REPORT_DIRECTORY'
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
  readonly factoryFlowService?: FactoryFlowService;
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
  factoryReportRegistered: boolean;
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

function buildFactoryFlowError(code: string, message: string, retryable: boolean): FactoryFlowError {
  return {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    code,
    message,
    occurredAt: new Date().toISOString(),
    retryable,
  };
}

const STAGE_ARTIFACT_KIND: Readonly<Record<FactoryStageName, FactoryFlowArtifactKind>> = {
  triage: 'specification',
  planning: 'plan',
  development: 'patch',
  tests: 'test_report',
  review: 'review_report',
  pr: 'pr_summary',
};

function formatReviewTitle(request: ReviewRequest): string {
  return request.targetType === 'pr' ? `PR #${request.identifier}` : `Branch ${request.identifier}`;
}

function formatFactoryTitle(request: FactoryRequest): string {
  const trimmed = request.value.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

function buildFactoryAllowedTools(stage: FactoryStageName, reportPath: string): string[] {
  const reportPermissions = [
    'Edit(.code-reviews/**)',
    `Edit(${reportPath})`,
  ];

  if (stage === 'triage') {
    return ['Read', 'mcp__claude_ai_Atlassian_Rovo__*', ...reportPermissions];
  }

  return ['Read', 'Glob', 'Grep', ...reportPermissions];
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
  readonly #factoryFlowService: FactoryFlowService | undefined;
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
    this.#factoryFlowService = options.factoryFlowService;
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

  emitAppEvent(event: AppEvent): void {
    this.#eventEmitter.emit(APP_EVENT_NAME, event);
  }

  #emitEvent(event: AppEvent): void {
    this.emitAppEvent(event);
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

    let reportDirectory: string;
    try {
      reportDirectory = resolveReviewReportDirectory(input.repoPath, input.reportDirectory);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pasta inválida em “Salvar code review em”.';
      throw new SessionManagerError('INVALID_REPORT_DIRECTORY', message, 400);
    }

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
        reportDirectory,
      });
    } catch (error) {
      const message =
        error instanceof ReviewServiceError
          ? error.message
          : 'Não foi possível preparar a pasta indicada em “Salvar code review em”.';
      throw new SessionManagerError('SESSION_CREATION_FAILED', message, 500);
    }

    const reportArtifact = preparedArtifacts.artifacts.find(item => item.kind === 'report');
    if (!reportArtifact) {
      throw new SessionManagerError(
        'SESSION_CREATION_FAILED',
        'Não foi possível preparar a pasta indicada em “Salvar code review em”.',
        500,
      );
    }

    let draft: ReturnType<typeof createReviewReportDraft>;
    try {
      draft = createReviewReportDraft(input.repoPath, reportArtifact.path);
    } catch {
      const message = 'Não foi possível preparar o arquivo temporário do parecer.';
      await this.#failReviewStart(
        created.review.id,
        created.execution.id,
        reportArtifact.id,
        'REPORT_DRAFT_FAILED',
        message,
      );
      throw new SessionManagerError('SESSION_CREATION_FAILED', message, 500);
    }

    const activeReviewSession: ActiveReviewSession = {
      reviewId: created.review.id,
      executionId: created.execution.id,
      reportArtifactId: reportArtifact.id,
      draft,
    };

    const session: ManagedSession = {
      sessionId: randomUUID(),
      mode: 'review',
      title: formatReviewTitle(input),
      repoPath: input.repoPath,
      status: 'running',
      historyState: 'pending',
      reportPath: reportArtifact.path,
      sessionPath: null,
      ptyProcess: undefined,
      subscriptions: [],
      history: undefined,
      activeReviewSession,
      activeFactorySession: undefined,
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
      factoryReportRegistered: false,
    };

    let child: pty.IPty;
    try {
      child = pty.spawn(
        'claude',
        [buildCodeReviewPrompt(input.targetType, input.identifier, draft.path)],
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
      draft.dispose();
      await this.#failReviewStart(
        activeReviewSession.reviewId,
        activeReviewSession.executionId,
        activeReviewSession.reportArtifactId,
        'PTY_SPAWN_FAILED',
        `Não foi possível iniciar o processo Claude: ${detail}`,
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
        broadcast(session, { type: 'output', data });
      }),
      child.onExit(({ exitCode, signal }) => {
        this.#handlePtyExit(runtime, child, exitCode, signal);
      }),
    ];

    this.#runtimes.set(session.sessionId, runtime);
    try {
      await this.#reviewService.startExecution(created.review.id, created.execution.id, child.pid);
    } catch (error) {
      await this.stopSession(session.sessionId, 'falha ao registrar o início da sessão');
      throw error;
    }

    if (!runtime.finalized) {
      draft.watch(() => {
        if (!runtime.finalized && session.historyState === 'pending') {
          this.#enqueue(runtime, () => this.#refreshReviewReport(session, activeReviewSession));
        }
      });
      this.#enqueue(runtime, () => this.#refreshReviewReport(session, activeReviewSession));
    }

    this.#emitEvent({
      type: 'session.started',
      session: toBackgroundSessionSummary(session),
    });

    return session;
  }

  async #failReviewStart(
    reviewId: string,
    executionId: string,
    artifactId: string,
    code: string,
    message: string,
  ): Promise<void> {
    const error = buildReviewError(code, message, true);
    await this.#reviewService.updateArtifactStatus(reviewId, artifactId, 'failed', error);
    await this.#reviewService.finishExecution(reviewId, executionId, {
      process: { status: 'failed', error },
      targetState: 'failed',
      reason: message,
      error,
    });
  }

  #setReviewReportState(session: ManagedSession, state: 'saved' | 'incomplete'): void {
    session.historyState = state;
    this.#emitEvent({
      type: state === 'saved' ? 'session.history_saved' : 'session.updated',
      session: toBackgroundSessionSummary(session),
    });
    if (session.reportPath) {
      broadcast(session, { type: 'history', reportPath: session.reportPath, state });
    }
  }

  async #refreshReviewReport(session: ManagedSession, review: ActiveReviewSession): Promise<void> {
    if (session.historyState === 'saved' || !await review.draft.publish()) {
      return;
    }

    await this.#reviewService.updateArtifactStatus(
      review.reviewId,
      review.reportArtifactId,
      'ready',
      null,
      'review.report_file_saved',
    );
    this.#setReviewReportState(session, 'saved');
  }

  async #finishReviewReport(
    session: ManagedSession,
    review: ActiveReviewSession,
    missingReport: ReviewError,
  ): Promise<void> {
    let reportError = missingReport;
    try {
      await this.#refreshReviewReport(session, review);
    } catch {
      const message = 'Não foi possível gravar o parecer na pasta indicada em “Salvar code review em”.';
      reportError = buildReviewError('REPORT_SAVE_FAILED', message, true);
      broadcast(session, { type: 'error', message });
    } finally {
      review.draft.dispose();
    }

    if (session.historyState !== 'saved') {
      this.#setReviewReportState(session, 'incomplete');
      await this.#reviewService.updateArtifactStatus(
        review.reviewId,
        review.reportArtifactId,
        reportError === missingReport ? 'incomplete' : 'failed',
        reportError,
      );
    }
  }

  async startFactorySession(input: StartFactorySessionInput): Promise<ManagedSession> {
    validateRepoPath(input.repoPath);
    this.#assertCapacity();

    let activeFactorySession: ActiveFactorySession | undefined;
    let flowDetails: FactoryFlowDetails | undefined;
    if (this.#factoryFlowService) {
      if (input.flowId) {
        let details;
        try {
          details = this.#factoryFlowService.getFlow(input.flowId);
        } catch (error) {
          if (error instanceof FactoryFlowServiceError) {
            throw new SessionManagerError('SESSION_CREATION_FAILED', error.message, error.statusCode);
          }
          throw error;
        }
        if (isFinalFactoryFlowState(details.flow.state)) {
          throw new SessionManagerError(
            'SESSION_CREATION_FAILED',
            `Não é possível iniciar sessão em um fluxo no estado final ${details.flow.state}.`,
            409,
          );
        }
        flowDetails = details;
        activeFactorySession = {
          flowId: details.flow.id,
          stage: input.stage ?? details.flow.currentStage,
        };
      } else {
        const created = await this.#factoryFlowService.createFlow({
          task: {
            inputType: input.inputType,
            value: input.value,
            repoPath: input.repoPath,
          },
          ...(input.title ? { title: input.title } : {}),
        });
        this.#emitEvent({
          type: 'factory_flow.created',
          flow: created.flow,
        });
        activeFactorySession = {
          flowId: created.flow.id,
          stage: input.stage ?? created.flow.currentStage,
        };
      }
    }

    const session: ManagedSession = {
      sessionId: randomUUID(),
      mode: 'factory',
      title: input.title?.trim() || formatFactoryTitle(input),
      repoPath: input.repoPath,
      status: 'running',
      historyState: 'pending',
      reportPath: null,
      sessionPath: null,
      ptyProcess: undefined,
      subscriptions: [],
      history: undefined,
      activeReviewSession: undefined,
      activeFactorySession,
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
      factoryReportRegistered: false,
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
            if (this.#factoryFlowService && activeFactorySession && !runtime.finalized) {
              this.#enqueue(runtime, () =>
                this.#syncFactoryReportSaved(runtime, activeFactorySession, factoryHistory),
              );
            }
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
      if (this.#factoryFlowService && activeFactorySession) {
        await this.#failFactoryStart(
          activeFactorySession.flowId,
          activeFactorySession.stage,
          'FACTORY_HISTORY_INIT_FAILED',
          `Não foi possível preparar os arquivos do planejamento: ${detail}`,
        );
      }
      throw new SessionManagerError(
        'SESSION_CREATION_FAILED',
        `Não foi possível preparar os arquivos do planejamento: ${detail}`,
        500,
      );
    }

    session.history = factoryHistory;
    session.reportPath = factoryHistory.reportPath;
    session.sessionPath = factoryHistory.sessionPath;

    const stage = activeFactorySession?.stage ?? input.stage ?? 'triage';
    const prompt = await this.#buildFactoryStagePrompt(
      input,
      stage,
      factoryHistory.reportPath,
      flowDetails,
    );

    const allowedTools = buildFactoryAllowedTools(stage, factoryHistory.reportPath);

    let child: pty.IPty;
    try {
      child = pty.spawn(
        'claude',
        ['--verbose', '--allowedTools', allowedTools.join(','), '-p', prompt],
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
      if (this.#factoryFlowService && activeFactorySession) {
        await this.#failFactoryStart(
          activeFactorySession.flowId,
          activeFactorySession.stage,
          'FACTORY_PTY_SPAWN_FAILED',
          `Não foi possível iniciar o processo Claude: ${detail}`,
        );
      }
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
    if (this.#factoryFlowService && activeFactorySession) {
      try {
        const attached = await this.#factoryFlowService.attachSession(
          activeFactorySession.flowId,
          session.sessionId,
          {
            stage: activeFactorySession.stage,
            reason: `Sessão ${session.sessionId} iniciada na etapa ${activeFactorySession.stage}`,
          },
        );
        await this.#factoryFlowService.updateStagePaths(
          activeFactorySession.flowId,
          activeFactorySession.stage,
          {
            reportPath: factoryHistory.reportPath,
            sessionPath: factoryHistory.sessionPath,
          },
        );
        this.#emitEvent({
          type: 'factory_flow.updated',
          flow: attached.flow,
        });
      } catch (error) {
        await this.stopSession(session.sessionId, 'falha ao vincular sessão ao fluxo da Factory');
        throw error;
      }
    }

    this.#emitEvent({
      type: 'session.started',
      session: toBackgroundSessionSummary(session),
    });

    return session;
  }

  async #failFactoryStart(
    flowId: string,
    stage: FactoryStageName,
    code: string,
    message: string,
  ): Promise<void> {
    if (!this.#factoryFlowService) {
      return;
    }
    try {
      const current = this.#factoryFlowService.getFlow(flowId).flow;
      if (isFinalFactoryFlowState(current.state)) {
        return;
      }
      const failed = await this.#factoryFlowService.transitionFlow(flowId, {
        to: 'failed',
        stage,
        reason: message,
        currentSessionId: null,
        error: buildFactoryFlowError(code, message, true),
      });
      this.#emitEvent({
        type: 'factory_flow.finished',
        flow: failed.flow,
      });
    } catch {
      // Preserva o erro original de criação da sessão.
    }
  }

  async #buildFactoryStagePrompt(
    input: StartFactorySessionInput,
    stage: FactoryStageName,
    reportPath: string,
    flowDetails?: FactoryFlowDetails,
  ): Promise<string> {
    if (stage !== 'planning') {
      return buildFactoryPlanPrompt(input.inputType, input.value, reportPath);
    }

    const triageArtifact = [...(flowDetails?.artifacts ?? [])]
      .reverse()
      .find(
        artifact =>
          artifact.stage === 'triage' &&
          artifact.kind === 'specification' &&
          artifact.status === 'ready',
      );
    const triageStage = flowDetails?.stages.find(item => item.name === 'triage');
    const understandingReportPath = triageArtifact?.path ?? triageStage?.reportPath ?? undefined;

    let understandingDocument: string | undefined;
    if (understandingReportPath) {
      try {
        understandingDocument = await readFile(understandingReportPath, 'utf8');
      } catch {
        understandingDocument = undefined;
      }
    }

    return buildFactoryArchitecturePrompt({
      inputType: input.inputType,
      value: input.value,
      understandingDocument,
      understandingReportPath,
      reportPath,
    });
  }

  async #autoAdvanceToPlanning(flowId: string, expectedUpdatedAt: string): Promise<void> {
    if (!this.#factoryFlowService) {
      return;
    }

    try {
      const advanced = await this.#factoryFlowService.advanceStage(flowId, {
        reason: 'Avanço automático da triagem para o planejamento',
        expectedUpdatedAt,
      });
      this.#emitEvent({
        type: 'factory_flow.updated',
        flow: advanced.flow,
      });
      await this.startFactorySession({
        inputType: advanced.flow.target.inputType,
        value: advanced.flow.target.value,
        repoPath: advanced.flow.target.repoPath,
        flowId: advanced.flow.id,
        stage: 'planning',
        title: advanced.flow.title,
        cols: 120,
        rows: 36,
      });
    } catch (error) {
      try {
        const current = this.#factoryFlowService.getFlow(flowId).flow;
        if (
          !isFinalFactoryFlowState(current.state) &&
          current.state === 'running' &&
          current.currentSessionId === null
        ) {
          const detail = error instanceof Error ? error.message : 'Falha desconhecida';
          const fallback = await this.#factoryFlowService.transitionFlow(flowId, {
            to: 'waiting_action',
            stage: current.currentStage,
            reason: `Não foi possível iniciar automaticamente a etapa ${current.currentStage}: ${detail}`,
            currentSessionId: null,
          });
          this.#emitEvent({
            type: 'factory_flow.updated',
            flow: fallback.flow,
          });
        }
      } catch {
        // Preserva o estado persistido caso o fluxo já tenha sido encerrado.
      }
    }
  }

  async #syncFactoryReportSaved(
    runtime: SessionRuntime,
    activeFactory: ActiveFactorySession,
    factoryHistory: { reportPath: string; sessionPath: string },
  ): Promise<void> {
    if (!this.#factoryFlowService) {
      return;
    }
    const { session } = runtime;
    if (!runtime.factoryReportRegistered) {
      runtime.factoryReportRegistered = true;
      await this.#factoryFlowService.registerArtifact(
        activeFactory.flowId,
        {
          stage: activeFactory.stage,
          sessionId: session.sessionId,
          kind: STAGE_ARTIFACT_KIND[activeFactory.stage],
          format: 'markdown',
          path: factoryHistory.reportPath,
          status: 'ready',
        },
        {
          reportPath: factoryHistory.reportPath,
          sessionPath: factoryHistory.sessionPath,
        },
      );
    }
    const details = this.#factoryFlowService.getFlow(activeFactory.flowId);
    this.#emitEvent({
      type: 'factory_flow.updated',
      flow: details.flow,
    });
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
    const activeFactory = session.activeFactorySession;
    if (!activeReview && (!activeFactory || !this.#factoryFlowService)) {
      this.#emitEvent({
        type: 'session.finished',
        session: toBackgroundSessionSummary(session),
      });
      return;
    }

    if (activeFactory && this.#factoryFlowService) {
      this.#enqueue(runtime, async () => {
        try {
          await this.#finishFactorySession(runtime, activeFactory, exitCode);
        } finally {
          this.#emitEvent({
            type: 'session.finished',
            session: toBackgroundSessionSummary(session),
          });
        }
      });
      return;
    }

    if (!activeReview) {
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
        await this.#finishReviewReport(
          session,
          activeReview,
          buildReviewError('REPORT_NOT_SAVED', 'O parecer final não foi entregue antes do encerramento.', true),
        );
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

  async #finishFactorySession(
    runtime: SessionRuntime,
    activeFactory: ActiveFactorySession,
    exitCode: number,
  ): Promise<void> {
    if (!this.#factoryFlowService) {
      return;
    }

    const { session } = runtime;
    const { flowId, stage } = activeFactory;

    if (session.sessionPath) {
      await this.#factoryFlowService.registerArtifact(
        flowId,
        {
          stage,
          sessionId: session.sessionId,
          kind: 'session_log',
          format: 'markdown',
          path: session.sessionPath,
          status: 'ready',
        },
        { sessionPath: session.sessionPath },
      );
    }

    if (exitCode === 0) {
      if (session.reportPath && !runtime.factoryReportRegistered) {
        runtime.factoryReportRegistered = true;
        if (session.historyState === 'saved') {
          await this.#factoryFlowService.registerArtifact(
            flowId,
            {
              stage,
              sessionId: session.sessionId,
              kind: STAGE_ARTIFACT_KIND[stage],
              format: 'markdown',
              path: session.reportPath,
              status: 'ready',
            },
            { reportPath: session.reportPath },
          );
        } else {
          await this.#factoryFlowService.registerArtifact(
            flowId,
            {
              stage,
              sessionId: session.sessionId,
              kind: STAGE_ARTIFACT_KIND[stage],
              format: 'markdown',
              path: session.reportPath,
              status: 'incomplete',
              error: buildFactoryFlowError(
                'FACTORY_ARTIFACT_INCOMPLETE',
                'O processo PTY encerrou sem salvar o artefato final da etapa.',
                true,
              ),
            },
            { reportPath: session.reportPath },
          );
        }
      }

      const currentFlow = this.#factoryFlowService.getFlow(flowId).flow;
      if (isFinalFactoryFlowState(currentFlow.state)) {
        return;
      }

      const nextState =
        session.historyState === 'saved' && getNextFactoryStage(stage) === null
          ? 'completed'
          : 'waiting_action';
      const transitioned = await this.#factoryFlowService.transitionFlow(flowId, {
        to: nextState,
        stage,
        reason:
          nextState === 'completed'
            ? `Etapa final ${stage} concluída com artefato salvo`
            : `Sessão da etapa ${stage} finalizada com código 0`,
        currentSessionId: null,
      });

      this.#emitEvent({
        type: isFinalFactoryFlowState(transitioned.flow.state)
          ? 'factory_flow.finished'
          : 'factory_flow.updated',
        flow: transitioned.flow,
      });
      broadcast(session, {
        type: 'factory_flow',
        flowId,
        stage,
        state: transitioned.flow.state,
      });

      if (stage === 'triage' && session.historyState === 'saved') {
        await this.#autoAdvanceToPlanning(flowId, transitioned.flow.updatedAt);
      }
      return;
    }

    const failureError = buildFactoryFlowError(
      'FACTORY_PTY_FAILED',
      `Processo PTY encerrado com código ${exitCode}.`,
      true,
    );
    if (session.reportPath && session.historyState !== 'saved' && !runtime.factoryReportRegistered) {
      runtime.factoryReportRegistered = true;
      await this.#factoryFlowService.registerArtifact(
        flowId,
        {
          stage,
          sessionId: session.sessionId,
          kind: STAGE_ARTIFACT_KIND[stage],
          format: 'markdown',
          path: session.reportPath,
          status: 'failed',
          error: failureError,
        },
        { reportPath: session.reportPath },
      );
    }

    const currentFlow = this.#factoryFlowService.getFlow(flowId).flow;
    if (isFinalFactoryFlowState(currentFlow.state)) {
      return;
    }

    const failed = await this.#factoryFlowService.transitionFlow(flowId, {
      to: 'failed',
      stage,
      reason: `Sessão da etapa ${stage} encerrada com código ${exitCode}`,
      currentSessionId: null,
      error: failureError,
    });
    this.#emitEvent({
      type: 'factory_flow.finished',
      flow: failed.flow,
    });
    broadcast(session, {
      type: 'factory_flow',
      flowId,
      stage,
      state: failed.flow.state,
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

    if (session.reportPath) {
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

    if (session.activeFactorySession) {
      const flowState =
        this.#factoryFlowService?.getFlow(session.activeFactorySession.flowId).flow.state ??
        (session.status === 'running'
          ? 'running'
          : session.status === 'cancelled'
            ? 'cancelled'
            : session.status === 'failed'
              ? 'failed'
              : 'waiting_action');
      sendToSocket(ws, {
        type: 'factory_flow',
        flowId: session.activeFactorySession.flowId,
        stage: session.activeFactorySession.stage,
        state: flowState,
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
    const activeFactory = session.activeFactorySession;
    if (activeReview) {
      this.#enqueue(runtime, async () => {
        await this.#finishReviewReport(
          session,
          activeReview,
          buildReviewError('REVIEW_INTERRUPTED', reason, true),
        );
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
      });
    } else if (activeFactory && this.#factoryFlowService) {
      const flowService = this.#factoryFlowService;
      this.#enqueue(runtime, async () => {
        if (session.sessionPath) {
          await flowService.registerArtifact(
            activeFactory.flowId,
            {
              stage: activeFactory.stage,
              sessionId: session.sessionId,
              kind: 'session_log',
              format: 'markdown',
              path: session.sessionPath,
              status: 'ready',
            },
            { sessionPath: session.sessionPath },
          );
        }
        const currentFlow = flowService.getFlow(activeFactory.flowId).flow;
        if (!isFinalFactoryFlowState(currentFlow.state)) {
          const cancelled = await flowService.cancelFlow(activeFactory.flowId, { reason });
          this.#emitEvent({
            type: 'factory_flow.finished',
            flow: cancelled.flow,
          });
          broadcast(session, {
            type: 'factory_flow',
            flowId: activeFactory.flowId,
            stage: activeFactory.stage,
            state: cancelled.flow.state,
          });
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
