import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  REVIEW_CONTRACT_VERSION,
  getReadyFactoryStageArtifact,
  isFactoryReviewApprovedVerdict,
  isFinalFactoryFlowState,
  type AppEvent,
  type BackgroundSessionSummary,
  type FactoryFlowArtifactKind,
  type FactoryFlowDetails,
  type FactoryFlowError,
  type FactoryRequest,
  type FactoryReviewVerdict,
  type FactoryStageName,
  type ReviewError,
  type ReviewProcess,
  type ReviewRequest,
  type ServerMessage,
} from '@development-factory/shared';
import type {
  FactoryRepositoryProfile,
  HistoryFile,
  TransitionFactoryFlowResponse,
} from '@development-factory/shared';
import { resolveReviewReportDirectory } from './artifacts.js';
import { appendFactoryDevelopmentChecks } from './factory-development-checks.js';
import { buildDevelopmentRunnerArgs, readFactoryDevelopmentInputs } from './factory-development.js';
import { FactoryFlowServiceError, type FactoryFlowService } from './factory-flow-service.js';
import { buildPrRunnerArgs, readFactoryPrInputs } from './factory-pr.js';
import {
  FactoryRepositoryProfileError,
  loadFactoryRepositoryProfile,
} from './factory-repository-profile.js';
import type { FactoryRepositoryProfileErrorCode } from './factory-repository-profile.js';
import { buildReviewRunnerArgs, parseReviewVerdict, readFactoryReviewInputs } from './factory-review.js';
import {
  FactoryStageArtifactError,
  buildTriageAndPlanningRunnerArgs,
  readFactoryStageDocument,
} from './factory-stage-runners.js';
import { buildTestsRunnerArgs, readFactoryTestsInputs } from './factory-tests.js';
import { appendFactoryTestsChecks } from './factory-tests-checks.js';
import {
  FactoryWorktreeError,
  getFactoryWorktreeHeadSha,
  provisionFactoryWorktree,
  resolveValidGitRepoRoot,
  verifyExistingFactoryWorktree,
} from './factory-worktree.js';
import { createFactoryHistory } from './history.js';
import { buildCodeReviewPrompt } from './prompts/code-review.js';
import { buildFactoryArchitecturePrompt } from './prompts/factory-architecture.js';
import { buildFactoryDevelopmentPrompt } from './prompts/factory-development.js';
import { buildFactoryPlanPrompt } from './prompts/factory-plan.js';
import { buildFactoryPrPrompt } from './prompts/factory-pr.js';
import { buildFactoryReviewPrompt } from './prompts/factory-review.js';
import { buildFactoryTestsPrompt } from './prompts/factory-tests.js';
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
  | FactoryRepositoryProfileErrorCode
  | 'INVALID_REPORT_DIRECTORY'
  | 'FACTORY_STAGE_CONFLICT'
  | 'MAX_SESSIONS_REACHED'
  | 'SESSION_NOT_RUNNING'
  | 'SESSION_CREATION_FAILED';

export class SessionManagerError extends Error {
  readonly code: SessionManagerErrorCode;
  readonly statusCode: number;

  constructor(
    code: SessionManagerErrorCode,
    message: string,
    statusCode: number,
    public readonly details?: readonly string[],
  ) {
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

interface SessionBackendChecks {
  readonly stage: 'development' | 'tests';
  readonly worktreePath: string;
  readonly commands: FactoryRepositoryProfile['commands'];
  readonly abortController: AbortController;
}

interface SessionRuntime {
  readonly session: ManagedSession;
  readonly backendChecks?: SessionBackendChecks;
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

function buildFactoryFlowError(
  code: string,
  message: string,
  retryable: boolean,
  issues?: FactoryFlowError['issues'],
): FactoryFlowError {
  return {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    code,
    message,
    occurredAt: new Date().toISOString(),
    retryable,
    ...(issues?.length ? { issues } : {}),
  };
}

const STAGE_ARTIFACT_KIND: Readonly<Record<FactoryStageName, FactoryFlowArtifactKind>> = {
  triage: 'specification',
  planning: 'plan',
  development: 'implementation_report',
  tests: 'test_report',
  review: 'review_report',
  pr: 'pr_summary',
};

type RestrictedRunnerStage = 'development' | 'tests' | 'review' | 'pr';

const RESTRICTED_RUNNER_STAGE_CONFIG: Readonly<
  Record<
    RestrictedRunnerStage,
    {
      readonly label: string;
      readonly previousLabel: string;
      readonly mutatesRepo: boolean;
      readonly missingInputsError: string;
      readonly incompleteArtifactError: string;
    }
  >
> = {
  development: {
    label: 'Desenvolvimento',
    previousLabel: 'Planejamento',
    mutatesRepo: true,
    missingInputsError:
      'Não foi possível ler os artefatos das Etapas 01 e 02 para o Desenvolvimento.',
    incompleteArtifactError:
      'O Claude encerrou sem entregar um Relatório de Implementação válido.',
  },
  tests: {
    label: 'Testes',
    previousLabel: 'Desenvolvimento',
    mutatesRepo: true,
    missingInputsError:
      'Não foi possível ler os artefatos das Etapas 01, 02 e 03 para os Testes.',
    incompleteArtifactError:
      'O Claude encerrou sem entregar um Relatório de Testes válido.',
  },
  review: {
    label: 'Code Review',
    previousLabel: 'Testes',
    mutatesRepo: false,
    missingInputsError:
      'Não foi possível ler os artefatos das Etapas 01 a 04 para o Code Review.',
    incompleteArtifactError:
      'O Claude encerrou sem entregar um Relatório de Code Review válido.',
  },
  pr: {
    label: 'PR',
    previousLabel: 'Code Review',
    mutatesRepo: false,
    missingInputsError:
      'Não foi possível ler os artefatos das Etapas 01 a 05 para preparar o PR.',
    incompleteArtifactError:
      'O Claude encerrou sem entregar um Resumo do Pull Request válido.',
  },
};

function isRestrictedRunnerStage(
  stage: FactoryStageName | undefined,
): stage is RestrictedRunnerStage {
  return stage === 'development' || stage === 'tests' || stage === 'review' || stage === 'pr';
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
  readonly #factoryFlowService: FactoryFlowService | undefined;
  readonly #eventEmitter: EventEmitter;
  readonly #maxConcurrentSessions: number;
  readonly #completedSessionTtlMs: number;
  readonly #bufferMaxBytes: number;
  readonly #now: () => number;
  readonly #runtimes = new Map<string, SessionRuntime>();
  readonly #startingFlowIds = new Set<string>();
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

    if (isRestrictedRunnerStage(input.stage) && (!input.flowId || !this.#factoryFlowService)) {
      throw new SessionManagerError(
        'FACTORY_STAGE_CONFLICT',
        `Avance o fluxo do ${RESTRICTED_RUNNER_STAGE_CONFIG[input.stage].previousLabel} para ${RESTRICTED_RUNNER_STAGE_CONFIG[input.stage].label} antes de iniciar a sessão.`,
        409,
      );
    }
    if (input.stage === 'planning' && !input.flowId && this.#factoryFlowService) {
      throw new SessionManagerError(
        'FACTORY_STAGE_CONFLICT',
        'Conclua a Triagem do fluxo antes de iniciar o Planejamento.',
        409,
      );
    }

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
          ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        });
        this.#emitEvent({
          type: 'factory_flow.created',
          flow: created.flow,
        });
        flowDetails = this.#factoryFlowService.getFlow(created.flow.id);
        activeFactorySession = {
          flowId: created.flow.id,
          stage: input.stage ?? created.flow.currentStage,
        };
      }
    }

    const stage = activeFactorySession?.stage ?? input.stage ?? 'triage';
    if (flowDetails && flowDetails.flow.currentStage !== stage) {
      throw new SessionManagerError(
        'FACTORY_STAGE_CONFLICT',
        `Use a ação de avanço ou retorno antes de iniciar uma sessão na etapa ${stage}.`,
        409,
      );
    }

    const canonicalRepoPath = realpathSync(input.repoPath);
    if (flowDetails && canonicalRepoPath !== realpathSync(flowDetails.flow.target.repoPath)) {
      const stageLabel = isRestrictedRunnerStage(stage)
        ? RESTRICTED_RUNNER_STAGE_CONFIG[stage].label
        : stage;
      throw new SessionManagerError(
        'INVALID_REPO_PATH',
        `Use o repositório de destino do fluxo para executar ${stageLabel}.`,
        400,
      );
    }

    if (flowDetails && this.#factoryFlowService) {
      const flowId = flowDetails.flow.id;
      const hasRunningSessionForFlow =
        this.#startingFlowIds.has(flowId) ||
        [...this.#runtimes.values()].some(
          ({ session }) =>
            session.status === 'running' && session.activeFactorySession?.flowId === flowId,
        );
      if (hasRunningSessionForFlow) {
        throw new SessionManagerError(
          'FACTORY_STAGE_CONFLICT',
          'Já existe uma sessão em execução para este fluxo.',
          409,
        );
      }

      this.#startingFlowIds.add(flowId);
      try {
        this.#factoryFlowService.assertStageHandoff(flowDetails, stage);
        const preparedWorktree = await this.#ensureFactoryFlowWorktree(
          flowDetails,
          canonicalRepoPath,
          stage,
          input.baseBranch,
        );
        flowDetails = preparedWorktree.flowDetails;
        if (isRestrictedRunnerStage(stage) && RESTRICTED_RUNNER_STAGE_CONFIG[stage].mutatesRepo) {
          flowDetails = await this.#ensurePreExecutionWorktreeCheckpoint(flowDetails, stage);
        }
        return await this.#startFactoryRunner(
          { ...input, value: flowDetails.flow.target.value },
          stage,
          activeFactorySession,
          flowDetails,
          preparedWorktree.repositoryProfile,
        );
      } finally {
        this.#startingFlowIds.delete(flowId);
      }
    }

    let repositoryProfile: FactoryRepositoryProfile | undefined;
    if (stage === 'planning') {
      const repoRoot = await resolveValidGitRepoRoot(canonicalRepoPath).catch((error: unknown) => {
        if (error instanceof FactoryWorktreeError && error.code === 'INVALID_GIT_REPOSITORY') {
          return canonicalRepoPath;
        }
        throw error;
      });
      try {
        const loaded = await loadFactoryRepositoryProfile(repoRoot);
        repositoryProfile = loaded.profile;
      } catch (error) {
        if (error instanceof FactoryRepositoryProfileError) {
          throw new SessionManagerError(error.code, error.message, 400);
        }
        throw error;
      }
    }
    return this.#startFactoryRunner(
      input,
      stage,
      activeFactorySession,
      flowDetails,
      repositoryProfile,
    );
  }

  async #ensureFactoryFlowWorktree(
    flowDetails: FactoryFlowDetails,
    repoPath: string,
    stage: FactoryStageName,
    requestedBaseBranch?: string,
  ): Promise<{ flowDetails: FactoryFlowDetails; repositoryProfile?: FactoryRepositoryProfile }> {
    if (!this.#factoryFlowService) {
      return { flowDetails };
    }

    const flowId = flowDetails.flow.id;
    try {
      if (flowDetails.flow.worktreePath !== null) {
        await verifyExistingFactoryWorktree({
          repoPath,
          worktreePath: flowDetails.flow.worktreePath,
        });
        if (stage === 'triage' || stage === 'review') {
          return { flowDetails };
        }
        const repoRoot = await resolveValidGitRepoRoot(repoPath);
        const { profile: repositoryProfile } = await loadFactoryRepositoryProfile(repoRoot);
        return { flowDetails, repositoryProfile };
      }

      const provisioned = await provisionFactoryWorktree({
        repoPath,
        flowId,
        target: flowDetails.flow.target,
        baseBranch: flowDetails.flow.baseBranch ?? requestedBaseBranch ?? null,
      });
      await this.#factoryFlowService.updateWorktreeMetadata(flowId, {
        worktreePath: provisioned.worktreePath,
        branchName: provisioned.branchName,
        baseBranch: provisioned.baseBranch,
      });
      return {
        flowDetails: this.#factoryFlowService.getFlow(flowId),
        repositoryProfile: provisioned.repositoryProfile,
      };
    } catch (error) {
      if (error instanceof FactoryRepositoryProfileError) {
        if (flowDetails.flow.state === 'queued') {
          await this.#failFactoryStart(flowId, stage, error.code, error.message);
        }
        throw new SessionManagerError(error.code, error.message, 400);
      }
      if (error instanceof FactoryWorktreeError) {
        if (!isRestrictedRunnerStage(stage) || flowDetails.flow.state === 'queued') {
          await this.#failFactoryStart(flowId, stage, 'FACTORY_WORKTREE_FAILED', error.message);
        }
        if (
          error.code === 'INVALID_GIT_REPOSITORY' ||
          error.code === 'BASE_BRANCH_NOT_FOUND' ||
          error.code === 'EMPTY_REPOSITORY'
        ) {
          throw new SessionManagerError('INVALID_REPO_PATH', error.message, 400);
        }
        if (error.code === 'WORKTREE_INVALID') {
          throw new SessionManagerError('FACTORY_STAGE_CONFLICT', error.message, 409);
        }
        throw new SessionManagerError('SESSION_CREATION_FAILED', error.message, 500);
      }
      throw error;
    }
  }

  async #ensurePreExecutionWorktreeCheckpoint(
    flowDetails: FactoryFlowDetails,
    stage: RestrictedRunnerStage,
  ): Promise<FactoryFlowDetails> {
    if (!this.#factoryFlowService || flowDetails.flow.worktreePath === null) {
      return flowDetails;
    }

    const flowId = flowDetails.flow.id;
    try {
      const headState = await getFactoryWorktreeHeadSha({
        repoPath: flowDetails.flow.target.repoPath,
        worktreePath: flowDetails.flow.worktreePath,
      });

      if (flowDetails.checkpoints.length === 0) {
        await this.#factoryFlowService.createWorktreeCheckpoint(flowId, {
          stage,
          iteration: 0,
          message: `Baseline inicial antes de ${RESTRICTED_RUNNER_STAGE_CONFIG[stage].label}`,
        });
        return this.#factoryFlowService.getFlow(flowId);
      }

      if (headState.dirty) {
        await this.#factoryFlowService.createWorktreeCheckpoint(flowId, {
          stage,
          iteration: flowDetails.flow.iteration,
          message: `Checkpoint de segurança antes de iniciar ${RESTRICTED_RUNNER_STAGE_CONFIG[stage].label} (iteração ${flowDetails.flow.iteration})`,
        });
        return this.#factoryFlowService.getFlow(flowId);
      }

      return flowDetails;
    } catch (error) {
      if (error instanceof FactoryWorktreeError) {
        throw new SessionManagerError('FACTORY_STAGE_CONFLICT', error.message, 409);
      }
      if (error instanceof FactoryFlowServiceError) {
        throw new SessionManagerError('FACTORY_STAGE_CONFLICT', error.message, error.statusCode);
      }
      throw error;
    }
  }

  async #createStageCheckpointOrPause(
    session: ManagedSession,
    flowId: string,
    stage: 'development' | 'tests',
    iteration: number,
  ): Promise<boolean> {
    if (!this.#factoryFlowService) {
      return true;
    }
    const normalizedIteration = iteration > 0 ? iteration : 1;
    try {
      await this.#factoryFlowService.createWorktreeCheckpoint(flowId, {
        stage,
        iteration: normalizedIteration,
        sessionId: session.sessionId,
        message: `Checkpoint automático após ${RESTRICTED_RUNNER_STAGE_CONFIG[stage].label} (iteração ${normalizedIteration})`,
      });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Falha desconhecida';
      const paused = await this.#factoryFlowService.transitionFlow(flowId, {
        to: 'waiting_action',
        stage,
        reason: `Falha ao gravar checkpoint após ${RESTRICTED_RUNNER_STAGE_CONFIG[stage].label}: ${detail}`,
        currentSessionId: null,
        loopPausedReason: `Não foi possível criar o checkpoint Git do worktree após ${RESTRICTED_RUNNER_STAGE_CONFIG[stage].label}: ${detail}`,
      });
      this.#emitEvent({
        type: 'factory_flow.updated',
        flow: paused.flow,
      });
      broadcast(session, {
        type: 'factory_flow',
        flowId,
        stage,
        state: paused.flow.state,
      });
      return false;
    }
  }

  async #prepareRestrictedRunnerFactory(
    stage: RestrictedRunnerStage,
    flowDetails: FactoryFlowDetails,
    task: string,
    repositoryProfile?: FactoryRepositoryProfile,
  ): Promise<(reportPath: string) => { prompt: string; runnerArgs: string[] }> {
    if (stage === 'development') {
      const inputs = await readFactoryDevelopmentInputs(flowDetails);
      return reportPath => ({
        prompt: buildFactoryDevelopmentPrompt({ ...inputs, task, reportPath, repositoryProfile }),
        runnerArgs: buildDevelopmentRunnerArgs(reportPath),
      });
    }
    if (stage === 'tests') {
      const inputs = await readFactoryTestsInputs(flowDetails);
      return reportPath => ({
        prompt: buildFactoryTestsPrompt({ ...inputs, task, reportPath, repositoryProfile }),
        runnerArgs: buildTestsRunnerArgs(reportPath, repositoryProfile),
      });
    }
    if (stage === 'review') {
      const inputs = await readFactoryReviewInputs(flowDetails);
      return reportPath => ({
        prompt: buildFactoryReviewPrompt({ ...inputs, task, reportPath }),
        runnerArgs: buildReviewRunnerArgs(reportPath),
      });
    }
    const inputs = await readFactoryPrInputs(flowDetails);
    return reportPath => ({
      prompt: buildFactoryPrPrompt({
        ...inputs,
        task,
        reportPath,
        repositoryProfile,
        branchName: flowDetails.flow.branchName,
        baseBranch: flowDetails.flow.baseBranch,
      }),
      runnerArgs: buildPrRunnerArgs(reportPath),
    });
  }

  async #startFactoryRunner(
    input: StartFactorySessionInput,
    stage: FactoryStageName,
    activeFactorySession?: ActiveFactorySession,
    flowDetails?: FactoryFlowDetails,
    repositoryProfile?: FactoryRepositoryProfile,
  ): Promise<ManagedSession> {
    let buildRunnerConfig: ((reportPath: string) => { prompt: string; runnerArgs: string[] }) | undefined;
    let understanding: HistoryFile | undefined;
    try {
      if (isRestrictedRunnerStage(stage) && flowDetails) {
        buildRunnerConfig = await this.#prepareRestrictedRunnerFactory(
          stage,
          flowDetails,
          input.value,
          repositoryProfile,
        );
      } else if (stage === 'planning' && flowDetails) {
        const triageArtifact = getReadyFactoryStageArtifact(flowDetails, 'triage');
        if (!triageArtifact) {
          throw new SessionManagerError(
            'FACTORY_STAGE_CONFLICT',
            'Conclua a Triagem com a especificação salva antes de iniciar o Planejamento.',
            409,
          );
        }
        understanding = await readFactoryStageDocument('triage', triageArtifact.path);
      }
    } catch (error) {
      if (error instanceof FactoryStageArtifactError) {
        throw new SessionManagerError('FACTORY_STAGE_CONFLICT', error.message, 409, error.details);
      }
      if (isRestrictedRunnerStage(stage)) {
        throw new SessionManagerError(
          'FACTORY_STAGE_CONFLICT',
          RESTRICTED_RUNNER_STAGE_CONFIG[stage].missingInputsError,
          409,
        );
      }
      throw error;
    }
    if (flowDetails) {
      const current = this.#factoryFlowService?.getFlow(flowDetails.flow.id).flow;
      if (!current || isFinalFactoryFlowState(current.state) || current.currentStage !== stage) {
        throw new SessionManagerError(
          'FACTORY_STAGE_CONFLICT',
          `O fluxo mudou enquanto os artefatos eram preparados para a etapa ${stage}.`,
          409,
        );
      }
      this.#assertCapacity();
    }

    const worktreePath = flowDetails?.flow.worktreePath;
    const backendChecks: SessionBackendChecks | undefined =
      (stage === 'development' || stage === 'tests') && worktreePath && repositoryProfile
        ? {
            stage,
            worktreePath,
            commands: repositoryProfile.commands,
            abortController: new AbortController(),
          }
        : undefined;
    if ((stage === 'development' || stage === 'tests') && !backendChecks) {
      throw new SessionManagerError(
        'FACTORY_STAGE_CONFLICT',
        `${RESTRICTED_RUNNER_STAGE_CONFIG[stage].label} requer um worktree e um perfil de repositório válidos.`,
        409,
      );
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
      backendChecks,
      operationChain: Promise.resolve(),
      finalized: false,
    };

    let factoryHistory: ReturnType<typeof createFactoryHistory>;
    try {
      factoryHistory = createFactoryHistory(
        {
          ...input,
          ...(activeFactorySession ? { flowId: activeFactorySession.flowId } : {}),
          stage,
        },
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
      if (this.#factoryFlowService && activeFactorySession && !isRestrictedRunnerStage(stage)) {
        await this.#failFactoryStart(
          activeFactorySession.flowId,
          activeFactorySession.stage,
          'FACTORY_HISTORY_INIT_FAILED',
          `Não foi possível preparar os arquivos da etapa: ${detail}`,
        );
      }
      throw new SessionManagerError(
        'SESSION_CREATION_FAILED',
        `Não foi possível preparar os arquivos da etapa: ${detail}`,
        500,
      );
    }

    session.history = factoryHistory;
    session.reportPath = factoryHistory.reportPath;
    session.sessionPath = factoryHistory.sessionPath;

    let prompt: string;
    let runnerArgs: string[];
    if (buildRunnerConfig) {
      const prepared = buildRunnerConfig(factoryHistory.reportPath);
      prompt = prepared.prompt;
      runnerArgs = prepared.runnerArgs;
    } else {
      const initialStage = stage === 'planning' ? 'planning' : 'triage';
      prompt =
        initialStage === 'planning'
          ? buildFactoryArchitecturePrompt({
              inputType: input.inputType,
              value: input.value,
              understandingDocument: understanding?.content,
              understandingReportPath: understanding?.path,
              reportPath: factoryHistory.reportPath,
              repositoryProfile,
            })
          : buildFactoryPlanPrompt(input.inputType, input.value, factoryHistory.reportPath);
      runnerArgs = buildTriageAndPlanningRunnerArgs(initialStage, factoryHistory.reportPath);
    }

    const workingDirectory = worktreePath ?? input.repoPath;

    let child: pty.IPty;
    try {
      child = pty.spawn(
        'claude',
        ['--verbose', ...runnerArgs, '-p', prompt],
        {
          name: 'xterm-256color',
          cols: input.cols,
          rows: input.rows,
          cwd: workingDirectory,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Falha desconhecida';
      session.history = undefined;
      factoryHistory.finish(`falha ao iniciar processo PTY: ${detail}`);
      if (this.#factoryFlowService && activeFactorySession && !isRestrictedRunnerStage(stage)) {
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

  async #readReviewVerdictFromReport(reportPath: string | null): Promise<FactoryReviewVerdict | null> {
    if (!reportPath) {
      return null;
    }
    try {
      const content = await readFile(reportPath, 'utf8');
      return parseReviewVerdict(content);
    } catch {
      return null;
    }
  }

  async #handleAutoTransitionFailure(
    session: ManagedSession,
    flowId: string,
    error: unknown,
  ): Promise<void> {
    if (!this.#factoryFlowService) {
      return;
    }
    try {
      const current = this.#factoryFlowService.getFlow(flowId).flow;
      if (isFinalFactoryFlowState(current.state) || current.currentSessionId !== null) {
        return;
      }
      const detail = error instanceof Error ? error.message : 'Falha desconhecida';
      if (
        error instanceof FactoryFlowServiceError && error.code === 'FACTORY_FLOW_INVALID_CONTRACT'
      ) {
        session.error = detail;
        broadcast(session, { type: 'error', message: detail });
      }
      if (current.state === 'running') {
        const fallback = await this.#factoryFlowService.transitionFlow(flowId, {
          to: 'waiting_action',
          stage: current.currentStage,
          reason: `Não foi possível iniciar automaticamente a etapa ${current.currentStage}: ${detail}`,
          currentSessionId: null,
          loopPausedReason: `Transição automática interrompida na etapa ${current.currentStage}: ${detail}`,
        });
        this.#emitEvent({
          type: 'factory_flow.updated',
          flow: fallback.flow,
        });
        broadcast(session, {
          type: 'factory_flow',
          flowId,
          stage: fallback.flow.currentStage,
          state: fallback.flow.state,
        });
        return;
      }

      this.#emitEvent({
        type: 'factory_flow.updated',
        flow: current,
      });
      broadcast(session, {
        type: 'factory_flow',
        flowId,
        stage: current.currentStage,
        state: current.state,
      });
    } catch {
      // Preserva o estado persistido caso o fluxo já tenha sido encerrado.
    }
  }

  async #autoAdvanceAndStartStage(
    session: ManagedSession,
    flowId: string,
    targetStage: Exclude<FactoryStageName, 'triage' | 'pr'>,
    expectedUpdatedAt: string,
    reason: string,
  ): Promise<void> {
    if (!this.#factoryFlowService) {
      return;
    }

    try {
      const advanced = await this.#factoryFlowService.advanceStage(flowId, {
        reason,
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
        stage: targetStage,
        title: advanced.flow.title,
        cols: 120,
        rows: 36,
      });
    } catch (error) {
      await this.#handleAutoTransitionFailure(session, flowId, error);
    }
  }

  async #autoReturnToDevelopment(
    session: ManagedSession,
    flowId: string,
    expectedUpdatedAt: string,
    iteration: number,
    maxIterations: number,
  ): Promise<void> {
    if (!this.#factoryFlowService) {
      return;
    }

    try {
      const returned = await this.#factoryFlowService.returnStage(flowId, {
        targetStage: 'development',
        reason: `Code Review reprovou na iteração ${iteration}/${maxIterations}; retornando automaticamente para Desenvolvimento`,
        expectedUpdatedAt,
      });
      this.#emitEvent({
        type: 'factory_flow.updated',
        flow: returned.flow,
      });
      await this.startFactorySession({
        inputType: returned.flow.target.inputType,
        value: returned.flow.target.value,
        repoPath: returned.flow.target.repoPath,
        flowId: returned.flow.id,
        stage: 'development',
        title: returned.flow.title,
        cols: 120,
        rows: 36,
      });
    } catch (error) {
      await this.#handleAutoTransitionFailure(session, flowId, error);
    }
  }

  async #registerFactorySessionReport(
    session: ManagedSession,
    activeFactory: ActiveFactorySession,
    status: 'ready' | 'incomplete' | 'failed',
    error: FactoryFlowError | null,
  ): Promise<void> {
    if (!this.#factoryFlowService || !session.reportPath) {
      return;
    }
    await this.#factoryFlowService.registerArtifact(
      activeFactory.flowId,
      {
        stage: activeFactory.stage,
        sessionId: session.sessionId,
        kind: STAGE_ARTIFACT_KIND[activeFactory.stage],
        format: 'markdown',
        path: session.reportPath,
        status,
        error,
      },
      { reportPath: session.reportPath },
    );
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
    disposePtyProcess(session, false);

    const checks = runtime.backendChecks;
    const reportPath = session.reportPath;
    if (exitCode === 0 && checks && reportPath) {
      this.#enqueue(runtime, async () => {
        let checksError: FactoryStageArtifactError | undefined;
        try {
          if (checks.stage === 'development') {
            checksError = await appendFactoryDevelopmentChecks(
              reportPath,
              checks.worktreePath,
              checks.commands,
              checks.abortController.signal,
            );
          } else {
            await appendFactoryTestsChecks(
              reportPath,
              checks.worktreePath,
              checks.commands,
              checks.abortController.signal,
            );
          }
        } catch (error) {
          checksError =
            error instanceof FactoryStageArtifactError
              ? error
              : new FactoryStageArtifactError(
                  'FACTORY_SIDECAR_WRITE_FAILED',
                  checks.stage,
                  reportPath,
                  `Não foi possível registrar as verificações de ${RESTRICTED_RUNNER_STAGE_CONFIG[checks.stage].label}`,
                );
        }
        if (!runtime.finalized) {
          this.#finalizePtyExit(runtime, exitCode, signal, checksError);
        }
      });
      return;
    }
    this.#finalizePtyExit(runtime, exitCode, signal);
  }

  #finalizePtyExit(
    runtime: SessionRuntime,
    exitCode: number,
    signal: number | undefined,
    checksError?: FactoryStageArtifactError,
  ): void {
    const { session } = runtime;
    runtime.finalized = true;
    const currentHistory = session.history;
    session.history = undefined;
    const historyError = currentHistory?.finish(
      `processo finalizado com código ${exitCode}`,
      checksError === undefined &&
        (!isRestrictedRunnerStage(session.activeFactorySession?.stage) || exitCode === 0),
    );
    const artifactError = historyError ?? checksError;
    if (checksError && !historyError) {
      broadcast(session, { type: 'error', message: checksError.message });
    }

    session.exitCode = exitCode;
    session.signal = signal ?? null;
    session.finishedAt = new Date(this.#now()).toISOString();
    session.status = exitCode === 0 ? 'exited' : 'failed';
    if (exitCode !== 0) {
      session.error = `Processo PTY encerrado com código ${exitCode}.`;
    } else if (artifactError) {
      session.error = artifactError.message;
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
          await this.#finishFactorySession(session, activeFactory, exitCode, artifactError);
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
    session: ManagedSession,
    activeFactory: ActiveFactorySession,
    exitCode: number,
    artifactError: FactoryStageArtifactError | undefined,
  ): Promise<void> {
    if (!this.#factoryFlowService) {
      return;
    }

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

    const failureError =
      exitCode === 0
        ? null
        : buildFactoryFlowError(
            'FACTORY_PTY_FAILED',
            `Processo PTY encerrado com código ${exitCode}.`,
            true,
          );
    let contractError: FactoryFlowError | null = null;
    if (session.historyState === 'saved') {
      await this.#registerFactorySessionReport(session, activeFactory, 'ready', null);
    } else if (failureError) {
      await this.#registerFactorySessionReport(session, activeFactory, 'failed', failureError);
    } else {
      const message =
        artifactError?.message ??
        (isRestrictedRunnerStage(stage)
          ? RESTRICTED_RUNNER_STAGE_CONFIG[stage].incompleteArtifactError
          : 'O processo PTY encerrou sem salvar o artefato final da etapa.');
      contractError = buildFactoryFlowError(
        artifactError?.code ?? 'FACTORY_ARTIFACT_INCOMPLETE',
        message,
        true,
        artifactError?.issues,
      );
      await this.#registerFactorySessionReport(session, activeFactory, 'incomplete', contractError);
    }

    if (!failureError) {
      const currentFlow = this.#factoryFlowService.getFlow(flowId).flow;
      if (isFinalFactoryFlowState(currentFlow.state)) {
        return;
      }

      if (session.historyState === 'saved') {
        if (stage === 'triage') {
          const paused = await this.#factoryFlowService.transitionFlow(flowId, {
            to: 'waiting_action',
            stage,
            reason: 'Triagem concluída com especificação salva',
            currentSessionId: null,
          });
          await this.#autoAdvanceAndStartStage(
            session,
            flowId,
            'planning',
            paused.flow.updatedAt,
            'Avanço automático da triagem para o planejamento',
          );
          return;
        }

        if (stage === 'development') {
          const checkpointOk = await this.#createStageCheckpointOrPause(
            session,
            flowId,
            'development',
            currentFlow.iteration,
          );
          if (!checkpointOk) {
            return;
          }
          const paused = await this.#factoryFlowService.transitionFlow(flowId, {
            to: 'waiting_action',
            stage,
            reason: 'Desenvolvimento concluído com relatório salvo',
            currentSessionId: null,
          });
          await this.#autoAdvanceAndStartStage(
            session,
            flowId,
            'tests',
            paused.flow.updatedAt,
            'Desenvolvimento concluído; avançando automaticamente para Testes',
          );
          return;
        }

        if (stage === 'tests') {
          const checkpointOk = await this.#createStageCheckpointOrPause(
            session,
            flowId,
            'tests',
            currentFlow.iteration,
          );
          if (!checkpointOk) {
            return;
          }
          const paused = await this.#factoryFlowService.transitionFlow(flowId, {
            to: 'waiting_action',
            stage,
            reason: 'Testes concluídos com relatório salvo',
            currentSessionId: null,
          });
          await this.#autoAdvanceAndStartStage(
            session,
            flowId,
            'review',
            paused.flow.updatedAt,
            'Testes concluídos; avançando automaticamente para Code Review (double-check)',
          );
          return;
        }

        if (stage === 'review') {
          const verdict = await this.#readReviewVerdictFromReport(session.reportPath);
          if (verdict === null) {
            const paused = await this.#factoryFlowService.transitionFlow(flowId, {
              to: 'waiting_action',
              stage,
              reason: 'Veredito do Code Review não pôde ser determinado com segurança',
              currentSessionId: null,
              lastReviewVerdict: null,
              loopPausedReason:
                'Veredito do Code Review ausente ou ambíguo. Revise o relatório antes de prosseguir.',
            });
            this.#emitEvent({
              type: 'factory_flow.updated',
              flow: paused.flow,
            });
            broadcast(session, {
              type: 'factory_flow',
              flowId,
              stage,
              state: paused.flow.state,
            });
            return;
          }

          if (isFactoryReviewApprovedVerdict(verdict)) {
            const paused = await this.#factoryFlowService.transitionFlow(flowId, {
              to: 'waiting_action',
              stage,
              reason: 'Code Review aprovado no loop autônomo',
              currentSessionId: null,
              lastReviewVerdict: verdict,
              loopPausedReason: null,
            });
            try {
              const advancedToPr = await this.#factoryFlowService.advanceStage(flowId, {
                reason: 'Code Review aprovado; aguardando disparo manual da etapa PR',
                expectedUpdatedAt: paused.flow.updatedAt,
              });
              this.#emitEvent({
                type: 'factory_flow.updated',
                flow: advancedToPr.flow,
              });
              broadcast(session, {
                type: 'factory_flow',
                flowId,
                stage: advancedToPr.flow.currentStage,
                state: advancedToPr.flow.state,
              });
            } catch (error) {
              await this.#handleAutoTransitionFailure(session, flowId, error);
            }
            return;
          }

          const iteration = currentFlow.iteration > 0 ? currentFlow.iteration : 1;
          const maxIterations = currentFlow.maxIterations;
          if (iteration >= maxIterations) {
            const circuitBreakerMessage = `Limite máximo de ${maxIterations} iterações automáticas atingido sem aprovação no Code Review. Intervenção humana necessária.`;
            const paused = await this.#factoryFlowService.transitionFlow(flowId, {
              to: 'waiting_action',
              stage,
              reason: circuitBreakerMessage,
              currentSessionId: null,
              lastReviewVerdict: verdict,
              loopPausedReason: circuitBreakerMessage,
            });
            this.#emitEvent({
              type: 'factory_flow.updated',
              flow: paused.flow,
            });
            broadcast(session, {
              type: 'factory_flow',
              flowId,
              stage,
              state: paused.flow.state,
            });
            return;
          }

          const paused = await this.#factoryFlowService.transitionFlow(flowId, {
            to: 'waiting_action',
            stage,
            reason: `Code Review solicitou ajustes na iteração ${iteration}/${maxIterations}`,
            currentSessionId: null,
            lastReviewVerdict: verdict,
            loopPausedReason: null,
          });
          await this.#autoReturnToDevelopment(
            session,
            flowId,
            paused.flow.updatedAt,
            iteration,
            maxIterations,
          );
          return;
        }
      }

      let transitioned: TransitionFactoryFlowResponse | undefined;
      if (session.historyState === 'saved' && stage === 'pr') {
        try {
          transitioned = await this.#factoryFlowService.transitionFlow(flowId, {
            to: 'completed',
            stage,
            reason: 'Etapa final de PR concluída com artefatos validados',
            currentSessionId: null,
          });
        } catch (error) {
          if (
            !(error instanceof FactoryFlowServiceError) ||
            (error.code !== 'FACTORY_FLOW_INVALID_CONTRACT' &&
              error.code !== 'FACTORY_FLOW_INVALID_STAGE_ADVANCE')
          ) {
            throw error;
          }
          const cause = error.cause;
          contractError = buildFactoryFlowError(
            cause instanceof FactoryStageArtifactError ? cause.code : error.code,
            error.message,
            true,
            cause instanceof FactoryStageArtifactError ? cause.issues : undefined,
          );
          session.error = error.message;
          broadcast(session, { type: 'error', message: error.message });
        }
      }
      transitioned ??= await this.#factoryFlowService.transitionFlow(flowId, {
        to: 'waiting_action',
        stage,
        reason: contractError?.message ?? `Sessão da etapa ${stage} finalizada com código 0`,
        currentSessionId: null,
        error: contractError,
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
      return;
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
    runtime.backendChecks?.abortController.abort();
    disposePtyProcess(session, true);

    const currentHistory = session.history;
    session.history = undefined;
    currentHistory?.finish(reason, !isRestrictedRunnerStage(session.activeFactorySession?.stage));

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
        if (session.historyState === 'saved') {
          await this.#registerFactorySessionReport(session, activeFactory, 'ready', null);
        }
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
