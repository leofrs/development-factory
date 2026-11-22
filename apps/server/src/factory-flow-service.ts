import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AdvanceFactoryStageRequestSchema,
  CreateFactoryFlowRequestSchema,
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_MAX_AUTO_ITERATIONS,
  FACTORY_STAGE_ORDER,
  FactoryApprovedNotesSchema,
  FactoryFlowArtifactSchema,
  FactoryFlowCheckpointSchema,
  FactoryFlowDiffQuerySchema,
  FactoryFlowDomainError,
  FactoryFlowIterationsQuerySchema,
  FactoryFlowSchema,
  FactoryFlowStageSchema,
  FactoryIdempotencyKeySchema,
  FactoryPlanningApprovalSchema,
  FactoryStageNameSchema,
  ListFactoryFlowsFilterSchema,
  RegisterFactoryFlowArtifactRequestSchema,
  RegisterFactoryFlowCheckpointRequestSchema,
  ReturnFactoryStageRequestSchema,
  RollbackFactoryFlowCheckpointRequestSchema,
  TransitionFactoryFlowRequestSchema,
  UpdateFactoryFlowWorktreeRequestSchema,
  FactoryWorktreeRetentionPolicySchema,
  canReturnFactoryStage,
  evaluateFactoryTriageGate,
  getFactoryComparableIterations,
  getNextFactoryStage,
  getReadyFactoryStageArtifact,
  isFinalFactoryFlowState,
  transitionFactoryFlow,
  type CreateFactoryFlowResponse,
  type FactoryFlow,
  type FactoryFlowApiErrorCode,
  type FactoryFlowArtifact,
  type FactoryFlowCheckpoint,
  type FactoryFlowDetails,
  type FactoryFlowListResponse,
  type FactoryFlowStage,
  type FactoryFlowState,
  type FactoryFlowTransitionCommand,
  type FactoryPlanningApproval,
  type FactoryPlanningApprovalInput,
  type FactoryPlanningGate,
  type FactoryStageName,
  type FactoryTaskInput,
  type FactoryTriageGate,
  type FactoryWorktreeRetentionPolicy,
  type RollbackFactoryFlowCheckpointResponse,
  type TransitionFactoryFlowResponse,
} from '@development-factory/shared';
import { getFactoryDevelopmentChecksError } from './factory-development-checks.js';
import { readFactoryIterationComparison } from './factory-flow-iterations.js';
import {
  FactoryStageArtifactError,
  formatArtifactIssue,
  readFactoryStageSidecar,
} from './factory-stage-runners.js';
import {
  FactoryWorktreeError,
  cleanupFactoryWorktree,
  createFactoryWorktreeCheckpoint,
  getFactoryWorktreeHeadSha,
  rollbackFactoryWorktreeToCheckpoint,
} from './factory-worktree.js';
import { readFactoryWorktreeDiff } from './factory-worktree-diff.js';
import { validateFactoryStageArtifacts } from './history.js';
import {
  ReviewStorageError,
  type SaveFactoryArtifactOptions,
  type SaveFactoryFlowTransitionOptions,
  type SqliteFactoryFlowRepository,
} from './storage/index.js';

const FlowIdSchema = z.string().uuid('Identificador de fluxo inválido.');
const SessionIdSchema = z.string().uuid('Identificador de sessão inválido.');

type HandoffTargetStage = Exclude<FactoryStageName, 'triage'>;

const HANDOFF_CONFIG: Readonly<
  Record<
    HandoffTargetStage,
    {
      readonly missingMessage: string;
      readonly handoffReason?: string;
      readonly acceptsApprovedNotes: boolean;
    }
  >
> = {
  planning: {
    missingMessage: 'Conclua a Triagem com a especificação salva antes de avançar.',
    acceptsApprovedNotes: true,
  },
  development: {
    missingMessage: 'Conclua a Triagem e o Planejamento com os artefatos salvos antes de avançar.',
    handoffReason: 'Planejamento aprovado para execução do Desenvolvimento',
    acceptsApprovedNotes: true,
  },
  tests: {
    missingMessage:
      'Conclua a Triagem, o Planejamento e o Desenvolvimento com os artefatos salvos antes de avançar.',
    handoffReason: 'Relatório de Implementação entregue à etapa de Testes',
    acceptsApprovedNotes: true,
  },
  review: {
    missingMessage:
      'Conclua as etapas anteriores incluindo o Relatório de Testes salvo antes de avançar.',
    handoffReason: 'Relatório de Testes entregue à etapa de Code Review',
    acceptsApprovedNotes: true,
  },
  pr: {
    missingMessage:
      'Conclua as etapas anteriores incluindo o Relatório de Code Review salvo antes de avançar.',
    handoffReason: 'Code Review aprovado e entregue à etapa de PR',
    acceptsApprovedNotes: false,
  },
};

export interface FactoryFlowServiceOptions {
  readonly now?: () => string;
  readonly generateId?: () => string;
  readonly worktreeRetentionPolicy?: FactoryWorktreeRetentionPolicy;
}

export interface CreateFactoryFlowCommandOptions {
  readonly idempotencyKey?: string;
}

export interface AttachFactorySessionOptions {
  readonly stage?: FactoryStageName;
  readonly at?: string;
  readonly reason?: string;
}

export interface CancelFactoryFlowOptions {
  readonly reason?: string;
  readonly at?: string;
  readonly expectedUpdatedAt?: string;
  readonly keepWorktree?: boolean;
}

export interface TransitionFactoryFlowOptions extends SaveFactoryFlowTransitionOptions {
  readonly keepWorktree?: boolean;
  readonly expectedSessionId?: string;
}

export interface CreateWorktreeCheckpointOptions {
  readonly stage: FactoryStageName;
  readonly iteration?: number;
  readonly sessionId?: string | null;
  readonly message?: string;
}

export interface CleanupFlowWorktreeOptions {
  readonly keepWorktree?: boolean;
}

export interface UpdateStagePathsInput {
  readonly reportPath?: string | null;
  readonly sessionPath?: string | null;
  readonly at?: string;
}

export interface ReconcileInterruptedFlowsOptions {
  readonly reason?: string;
  readonly at?: string;
}

const FACTORY_STAGE_LABELS: Readonly<Record<FactoryStageName, string>> = {
  triage: 'Triagem',
  planning: 'Planejamento',
  development: 'Desenvolvimento',
  tests: 'Testes',
  review: 'Code Review',
  pr: 'PR',
};

/** Erro de domínio/aplicação do serviço de fluxos da Factory com código estável e status HTTP associado. */
export class FactoryFlowServiceError extends Error {
  constructor(
    public readonly code: FactoryFlowApiErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly details?: readonly string[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FactoryFlowServiceError';
  }
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });
}

function fingerprintFlowRequest(
  task: FactoryTaskInput,
  title: string,
  baseBranch?: string,
): string {
  const canonical = JSON.stringify({
    inputType: task.inputType,
    value: task.value,
    repoPath: task.repoPath,
    title,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function deriveFlowTitle(task: FactoryTaskInput, explicitTitle?: string): string {
  const raw = (explicitTitle ?? task.value).trim();
  if (raw.length <= 200) {
    return raw;
  }
  return raw.slice(0, 200).trim();
}

function resolveTriageGateForFlow(
  flow: FactoryFlow,
  stages: FactoryFlowStage[],
  artifacts: FactoryFlowArtifact[],
): FactoryTriageGate | undefined {
  if (flow.currentStage !== 'triage') {
    return undefined;
  }
  const artifact = getReadyFactoryStageArtifact({ stages, artifacts }, 'triage');
  if (!artifact) {
    return undefined;
  }
  try {
    return evaluateFactoryTriageGate(readFactoryStageSidecar('triage', artifact.path));
  } catch {
    return undefined;
  }
}

function resolvePlanningGateForFlow(
  stages: FactoryFlowStage[],
  artifacts: FactoryFlowArtifact[],
): FactoryPlanningGate | undefined {
  const planningArtifact = getReadyFactoryStageArtifact({ stages, artifacts }, 'planning');
  if (!planningArtifact) {
    return undefined;
  }
  try {
    const planningSidecar = readFactoryStageSidecar('planning', planningArtifact.path);
    const triageArtifact = getReadyFactoryStageArtifact({ stages, artifacts }, 'triage');
    let acceptanceCriteria: FactoryPlanningGate['acceptanceCriteria'] = [];
    if (triageArtifact) {
      try {
        acceptanceCriteria = readFactoryStageSidecar('triage', triageArtifact.path).acceptanceCriteria;
      } catch {
        acceptanceCriteria = [];
      }
    }
    return {
      pendingDecisions: planningSidecar.pendingDecisions,
      acceptanceCriteria,
    };
  } catch {
    return undefined;
  }
}

function buildValidatedPlanningApproval(
  details: FactoryFlowDetails,
  approvalInput: FactoryPlanningApprovalInput,
  approvedAt: string,
): FactoryPlanningApproval {
  const planningArtifact = getReadyFactoryStageArtifact(details, 'planning');
  if (planningArtifact) {
    const planningSidecar = readFactoryStageSidecar('planning', planningArtifact.path);
    for (let index = 0; index < planningSidecar.pendingDecisions.length; index += 1) {
      const pending = planningSidecar.pendingDecisions[index];
      if (!pending) {
        continue;
      }
      const decisionId = `D${index + 1}`;
      const decision =
        approvalInput.decisions.find(item => item.id === decisionId) ??
        approvalInput.decisions.find(item => item.question === pending.question);
      if (!decision) {
        throw new FactoryFlowServiceError(
          'FACTORY_FLOW_INVALID_INPUT',
          `Responda a decisão pendente ${decisionId} antes de aprovar o Planejamento.`,
          400,
        );
      }
      if (decision.mode === 'recommended' && decision.selectedOption !== pending.recommendedOption) {
        throw new FactoryFlowServiceError(
          'FACTORY_FLOW_INVALID_INPUT',
          `A opção selecionada para ${decisionId} não corresponde à opção recomendada do plano.`,
          400,
        );
      }
      if (
        decision.mode === 'alternative' &&
        (!pending.options.includes(decision.selectedOption) ||
          decision.selectedOption === pending.recommendedOption)
      ) {
        throw new FactoryFlowServiceError(
          'FACTORY_FLOW_INVALID_INPUT',
          `A opção alternativa selecionada para ${decisionId} não pertence às alternativas do plano.`,
          400,
        );
      }
    }
  }

  return FactoryPlanningApprovalSchema.parse({
    ...approvalInput,
    approvedAt,
  });
}

function assertStageContracts(
  details: FactoryFlowDetails,
  stages: readonly FactoryStageName[],
  missingMessage: string,
): void {
  for (const stage of stages) {
    const artifact = getReadyFactoryStageArtifact(details, stage);
    if (!artifact) {
      const reportPath = details.stages.find(item => item.name === stage)?.reportPath;
      const reportError = details.artifacts.find(
        item => item.stage === stage && item.path === reportPath,
      )?.error;
      throw new FactoryFlowServiceError(
        reportError ? 'FACTORY_FLOW_INVALID_CONTRACT' : 'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
        reportError?.message ?? `${missingMessage} Artefato da etapa ${stage} indisponível.`,
        409,
        reportError?.issues?.map(formatArtifactIssue),
      );
    }

    try {
      const sidecar = validateFactoryStageArtifacts(stage, artifact.path);
      if (sidecar.stage === 'development') {
        const error = getFactoryDevelopmentChecksError(artifact.path, sidecar.backendChecks);
        if (error) {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof FactoryStageArtifactError) {
        throw new FactoryFlowServiceError(
          'FACTORY_FLOW_INVALID_CONTRACT',
          error.message,
          409,
          error.details,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

function mapUnexpectedError(error: unknown, conflictCode: FactoryFlowApiErrorCode = 'FACTORY_FLOW_CONFLICT'): FactoryFlowServiceError {
  if (error instanceof FactoryFlowServiceError) {
    return error;
  }
  if (error instanceof FactoryFlowDomainError) {
    const statusCode =
      error.code === 'FACTORY_FLOW_INVALID_TRANSITION' ||
      error.code === 'FACTORY_FLOW_INVALID_STAGE_ADVANCE'
        ? 409
        : 400;
    return new FactoryFlowServiceError(error.code, error.message, statusCode, undefined, { cause: error });
  }
  if (error instanceof ReviewStorageError) {
    switch (error.code) {
      case 'STORAGE_NOT_FOUND':
        return new FactoryFlowServiceError('FACTORY_FLOW_NOT_FOUND', error.message, 404, undefined, {
          cause: error,
        });
      case 'STORAGE_CONFLICT':
        return new FactoryFlowServiceError(conflictCode, error.message, 409, undefined, {
          cause: error,
        });
      case 'STORAGE_INVALID_INPUT':
        return new FactoryFlowServiceError('FACTORY_FLOW_INVALID_INPUT', error.message, 400, undefined, {
          cause: error,
        });
      default:
        return new FactoryFlowServiceError(
          'FACTORY_FLOW_INTERNAL_ERROR',
          'Não foi possível concluir a operação de persistência do fluxo.',
          500,
          undefined,
          { cause: error },
        );
    }
  }
  if (error instanceof FactoryWorktreeError) {
    const statusCode =
      error.code === 'WORKTREE_CHECKPOINT_FAILED' || error.code === 'WORKTREE_CLEANUP_FAILED'
        ? 500
        : error.code === 'WORKTREE_ROLLBACK_FAILED' ||
            error.code === 'WORKTREE_INVALID' ||
            error.code === 'WORKTREE_DIFF_FAILED'
          ? 409
          : 400;
    const code: FactoryFlowApiErrorCode =
      statusCode === 400
        ? 'FACTORY_FLOW_INVALID_INPUT'
        : statusCode === 409
          ? 'FACTORY_FLOW_CONFLICT'
          : 'FACTORY_FLOW_INTERNAL_ERROR';
    return new FactoryFlowServiceError(code, error.message, statusCode, undefined, {
      cause: error,
    });
  }
  return new FactoryFlowServiceError(
    'FACTORY_FLOW_INTERNAL_ERROR',
    'Erro interno inesperado ao processar o fluxo da Factory.',
    500,
    undefined,
    { cause: error },
  );
}

function resolveRetentionPolicy(
  explicit?: FactoryWorktreeRetentionPolicy,
): FactoryWorktreeRetentionPolicy {
  if (explicit !== undefined) {
    return explicit;
  }
  const envPolicy = process.env.FACTORY_WORKTREE_RETENTION?.trim();
  if (envPolicy) {
    const parsed = FactoryWorktreeRetentionPolicySchema.safeParse(envPolicy);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return 'cleanup_on_finish';
}

function selectRollbackTargetCheckpoint(
  checkpoints: readonly FactoryFlowCheckpoint[],
  headState: { readonly headSha: string; readonly dirty: boolean },
  criteria: { readonly checkpointId?: string; readonly commitSha?: string },
): FactoryFlowCheckpoint {
  if (criteria.checkpointId !== undefined) {
    const match = checkpoints.find(item => item.id === criteria.checkpointId);
    if (!match) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_NOT_FOUND',
        `Checkpoint ${criteria.checkpointId} não encontrado neste fluxo.`,
        404,
      );
    }
    return match;
  }

  if (criteria.commitSha !== undefined) {
    const needle = criteria.commitSha.toLowerCase();
    const exactMatches = checkpoints.filter(item => item.commitSha.toLowerCase() === needle);
    if (exactMatches.length > 0) {
      const latestExact = exactMatches[exactMatches.length - 1];
      if (latestExact) {
        return latestExact;
      }
    }

    const prefixMatches = checkpoints.filter(item =>
      item.commitSha.toLowerCase().startsWith(needle),
    );
    const distinctShas = new Set(prefixMatches.map(item => item.commitSha.toLowerCase()));
    if (distinctShas.size > 1) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        `O prefixo de commit "${criteria.commitSha}" é ambíguo entre múltiplos checkpoints deste fluxo.`,
        400,
      );
    }
    const latestPrefix = prefixMatches[prefixMatches.length - 1];
    if (!latestPrefix) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_NOT_FOUND',
        `Checkpoint com commit "${criteria.commitSha}" não encontrado neste fluxo.`,
        404,
      );
    }
    return latestPrefix;
  }

  if (checkpoints.length === 0) {
    throw new FactoryFlowServiceError(
      'FACTORY_FLOW_CONFLICT',
      'Não há checkpoints registrados neste fluxo para realizar rollback.',
      409,
    );
  }

  const latestCheckpoint = checkpoints[checkpoints.length - 1];
  if (!latestCheckpoint) {
    throw new FactoryFlowServiceError(
      'FACTORY_FLOW_CONFLICT',
      'Não há checkpoints registrados neste fluxo para realizar rollback.',
      409,
    );
  }

  if (headState.dirty) {
    return latestCheckpoint;
  }

  const currentSha = headState.headSha.toLowerCase();
  let matchingIndex = -1;
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    if (checkpoints[index]?.commitSha.toLowerCase() === currentSha) {
      matchingIndex = index;
      break;
    }
  }

  if (matchingIndex === -1) {
    return latestCheckpoint;
  }

  for (let index = matchingIndex - 1; index >= 0; index -= 1) {
    const candidate = checkpoints[index];
    if (candidate && candidate.commitSha.toLowerCase() !== currentSha) {
      return candidate;
    }
  }

  throw new FactoryFlowServiceError(
    'FACTORY_FLOW_CONFLICT',
    'O worktree já está no checkpoint inicial; não há checkpoint anterior para reverter.',
    409,
  );
}

/**
 * Serviço de domínio independente de transporte (HTTP/WebSocket) para orquestração de fluxos da Factory.
 */
export class FactoryFlowService {
  private readonly now: () => string;
  private readonly generateId: () => string;
  private readonly worktreeRetentionPolicy: FactoryWorktreeRetentionPolicy;

  constructor(
    private readonly repository: SqliteFactoryFlowRepository,
    options: FactoryFlowServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? randomUUID;
    this.worktreeRetentionPolicy = resolveRetentionPolicy(options.worktreeRetentionPolicy);
  }

  shouldCleanupWorktreeOnState(
    state: FactoryFlowState,
    keepWorktreeOverride?: boolean,
  ): boolean {
    if (keepWorktreeOverride) {
      return false;
    }
    switch (this.worktreeRetentionPolicy) {
      case 'keep_all':
        return false;
      case 'cleanup_always':
        return state === 'completed' || state === 'cancelled' || state === 'failed';
      case 'cleanup_on_finish':
        return state === 'completed' || state === 'cancelled';
    }
  }

  async createFlow(
    input: unknown,
    options: CreateFactoryFlowCommandOptions = {},
  ): Promise<CreateFactoryFlowResponse> {
    const parsed = CreateFactoryFlowRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Os dados para criar o fluxo da Factory são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }

    let headerKey: string | undefined;
    if (options.idempotencyKey !== undefined) {
      const parsedHeaderKey = FactoryIdempotencyKeySchema.safeParse(options.idempotencyKey);
      if (!parsedHeaderKey.success) {
        throw new FactoryFlowServiceError(
          'FACTORY_FLOW_INVALID_INPUT',
          'A chave de idempotência informada é inválida.',
          400,
          formatZodIssues(parsedHeaderKey.error),
        );
      }
      headerKey = parsedHeaderKey.data;
    }

    const bodyKey = parsed.data.idempotencyKey;
    if (headerKey !== undefined && bodyKey !== undefined && headerKey !== bodyKey) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'A chave de idempotência do cabeçalho diverge da informada no corpo da requisição.',
        400,
      );
    }

    const effectiveKey = headerKey ?? bodyKey;
    const createdAt = this.now();
    const flowId = this.generateId();
    const title = deriveFlowTitle(parsed.data.task, parsed.data.title);

    const flow = FactoryFlowSchema.parse({
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      id: flowId,
      title,
      target: {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        ...parsed.data.task,
      },
      state: 'queued',
      currentStage: 'triage',
      currentSessionId: null,
      iteration: 0,
      maxIterations: FACTORY_MAX_AUTO_ITERATIONS,
      lastReviewVerdict: null,
      loopPausedReason: null,
      worktreePath: null,
      branchName: null,
      baseBranch: parsed.data.baseBranch ?? null,
      planningApproval: null,
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
      transitions: [],
      error: null,
    });

    const stages = FACTORY_STAGE_ORDER.map(stageName =>
      FactoryFlowStageSchema.parse({
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        id: this.generateId(),
        flowId,
        name: stageName,
        state: 'pending',
        sessionId: null,
        reportPath: null,
        sessionPath: null,
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        finishedAt: null,
        error: null,
      }),
    );

    try {
      const result = await this.repository.withWriteLock(() =>
        this.repository.createFlowIdempotently(
          flow,
          stages,
          effectiveKey
            ? {
                key: effectiveKey,
                fingerprint: fingerprintFlowRequest(
                  parsed.data.task,
                  title,
                  parsed.data.baseBranch,
                ),
              }
            : undefined,
        ),
      );

      return {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        flow: result.flow,
        stages: result.stages,
        replayed: result.replayed,
      };
    } catch (error) {
      throw mapUnexpectedError(error, 'FACTORY_FLOW_IDEMPOTENCY_CONFLICT');
    }
  }

  getFlow(flowIdInput: string): FactoryFlowDetails {
    const flowId = this.parseFlowId(flowIdInput);

    try {
      const flow = this.repository.getFlowById(flowId);
      if (!flow) {
        throw new FactoryFlowServiceError(
          'FACTORY_FLOW_NOT_FOUND',
          `Fluxo ${flowId} não encontrado.`,
          404,
        );
      }

      const stages = this.repository.listStagesByFlowId(flow.id);
      const artifacts = this.repository.listArtifactsByFlowId(flow.id);
      const checkpoints = this.repository.listCheckpointsByFlowId(flow.id);
      const triageGate = resolveTriageGateForFlow(flow, stages, artifacts);
      const planningGate = resolvePlanningGateForFlow(stages, artifacts);

      return {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        flow,
        stages,
        artifacts,
        worktreePath: flow.worktreePath,
        branchName: flow.branchName,
        baseBranch: flow.baseBranch,
        checkpoints,
        ...(triageGate ? { triageGate } : {}),
        ...(planningGate ? { planningGate } : {}),
      };
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async getFlowDiff(flowId: string, query: unknown, signal: AbortSignal) {
    const parsed = FactoryFlowDiffQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Os parâmetros de consulta do diff são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }
    const { flow, checkpoints } = this.getFlow(flowId);
    if (!flow.worktreePath) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_CONFLICT',
        'O worktree isolado do fluxo está indisponível.',
        409,
      );
    }

    const { fromCheckpointId, toCheckpointId } = parsed.data;
    const from = checkpoints.find(checkpoint => checkpoint.id === fromCheckpointId);
    const to = checkpoints.find(checkpoint => checkpoint.id === toCheckpointId);
    if (fromCheckpointId && (!from || !to)) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_NOT_FOUND',
        'Um dos checkpoints informados não foi encontrado neste fluxo.',
        404,
      );
    }
    if (!flow.baseBranch && (!from || !to)) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_CONFLICT',
        'O fluxo não tem uma branch base registrada para comparar com o worktree.',
        409,
      );
    }
    const range = from && to
      ? { from: from.commitSha, to: to.commitSha }
      : {
          baseBranch: flow.baseBranch ?? 'HEAD',
          baselineSha: checkpoints.find(checkpoint => checkpoint.iteration === 0)?.commitSha,
        };
    try {
      const diff = await readFactoryWorktreeDiff(
        { worktreePath: flow.worktreePath, flowId: flow.id, repoPath: flow.target.repoPath, range },
        parsed.data,
        signal,
      );
      if (!diff) {
        throw new FactoryFlowServiceError(
          'FACTORY_FLOW_NOT_FOUND',
          'O arquivo não está nas mudanças desta comparação. Atualize a lista para consultar o diff.',
          404,
        );
      }
      return diff;
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  getFlowIterationComparison(flowId: string, query: unknown) {
    const parsed = FactoryFlowIterationsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Informe um ciclo válido para comparar com o seguinte.',
        400,
        formatZodIssues(parsed.error),
      );
    }
    const details = this.getFlow(flowId);
    if (!getFactoryComparableIterations(details).includes(parsed.data.fromIteration)) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_NOT_FOUND',
        'Os dois ciclos consecutivos precisam estar registrados no fluxo.',
        404,
      );
    }
    return readFactoryIterationComparison(details, parsed.data.fromIteration);
  }

  listFlows(filterInput: unknown = {}): FactoryFlowListResponse {
    const parsed = ListFactoryFlowsFilterSchema.safeParse(filterInput);
    if (!parsed.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Os filtros de listagem de fluxos são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }

    try {
      const flows = this.repository.listFlows(parsed.data);
      return {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        flows,
      };
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  assertStageHandoff(details: FactoryFlowDetails, stage: FactoryStageName): void {
    if (stage === 'triage') {
      return;
    }
    assertStageContracts(
      details,
      FACTORY_STAGE_ORDER.slice(0, FACTORY_STAGE_ORDER.indexOf(stage)),
      HANDOFF_CONFIG[stage].missingMessage,
    );
  }

  async transitionFlow(
    flowIdInput: string,
    commandInput: unknown,
    options: TransitionFactoryFlowOptions = {},
  ): Promise<TransitionFactoryFlowResponse> {
    const flowId = this.parseFlowId(flowIdInput);

    const parsedCommand = TransitionFactoryFlowRequestSchema.safeParse(commandInput);
    if (!parsedCommand.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Os dados da transição do fluxo são inválidos.',
        400,
        formatZodIssues(parsedCommand.error),
      );
    }

    const { expectedUpdatedAt, at, ...rest } = parsedCommand.data;
    const command = {
      ...rest,
      at: at ?? this.now(),
      ...(rest.to === 'completed' && rest.error === undefined ? { error: null } : {}),
    };
    const saveOptions: SaveFactoryFlowTransitionOptions = {
      expectedUpdatedAt: options.expectedUpdatedAt ?? expectedUpdatedAt,
    };

    try {
      const result = await this.repository.withWriteLock(async () => {
        const currentFlow = this.repository.getFlowById(flowId);
        if (!currentFlow) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_NOT_FOUND',
            `Fluxo ${flowId} não encontrado.`,
            404,
          );
        }

        if (
          (saveOptions.expectedUpdatedAt !== undefined &&
            currentFlow.updatedAt !== saveOptions.expectedUpdatedAt) ||
          (options.expectedSessionId !== undefined &&
            currentFlow.currentSessionId !== options.expectedSessionId)
        ) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_CONFLICT',
            `O fluxo ${flowId} foi alterado por outra operação concorrente.`,
            409,
          );
        }

        const currentStage = currentFlow.currentStage;
        if (command.stage && command.stage !== currentStage) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
            'Use a ação de avanço da etapa para validar os artefatos do fluxo.',
            409,
          );
        }

        // Valida a transição de domínio antes de remover o worktree externo.
        const preview = transitionFactoryFlow(currentFlow, command);
        if (preview.state === 'completed') {
          if (currentStage !== 'pr') {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
              'Conclua todas as etapas até o PR antes de finalizar o fluxo.',
              409,
            );
          }
          assertStageContracts(
            this.getFlow(flowId),
            FACTORY_STAGE_ORDER,
            'Conclua todas as etapas com os artefatos salvos antes de finalizar o fluxo.',
          );
        }
        let effectiveCommand: FactoryFlowTransitionCommand = command;
        if (
          currentFlow.worktreePath !== null &&
          this.shouldCleanupWorktreeOnState(preview.state, options.keepWorktree)
        ) {
          try {
            await cleanupFactoryWorktree({
              repoPath: currentFlow.target.repoPath,
              worktreePath: currentFlow.worktreePath,
              branchName: currentFlow.branchName,
              baseBranch: currentFlow.baseBranch,
            });
            effectiveCommand = { ...command, worktreePath: null };
          } catch {
            // Mantém a transição de estado mesmo que a limpeza externa do worktree falhe.
          }
        }

        return this.repository.saveFlowTransition(flowId, effectiveCommand, saveOptions);
      });

      return {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        flow: result.flow,
      };
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async advanceStage(
    flowIdInput: string,
    requestInput: unknown = {},
  ): Promise<TransitionFactoryFlowResponse> {
    const flowId = this.parseFlowId(flowIdInput);

    const parsed = AdvanceFactoryStageRequestSchema.safeParse(requestInput);
    if (!parsed.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Os dados para avançar a etapa do fluxo são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }

    try {
      const flow = await this.repository.withWriteLock(() =>
        this.repository.runInTransaction(() => {
          const flow = this.repository.getFlowById(flowId);
          if (!flow) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_NOT_FOUND',
              `Fluxo ${flowId} não encontrado.`,
              404,
            );
          }

          if (isFinalFactoryFlowState(flow.state)) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_INVALID_TRANSITION',
              `Não é possível avançar etapa de um fluxo no estado final ${flow.state}.`,
              409,
            );
          }

          const nextStage = getNextFactoryStage(flow.currentStage);
          if (!nextStage || nextStage === 'triage') {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
              `O fluxo já está na etapa final (${flow.currentStage}).`,
              409,
            );
          }

          if (flow.state !== 'waiting_action' || flow.currentSessionId !== null) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
              'Conclua a sessão da etapa atual antes de avançar.',
              409,
            );
          }
          const handoffConfig = HANDOFF_CONFIG[nextStage];
          if (parsed.data.approvedNotes !== undefined && !handoffConfig.acceptsApprovedNotes) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_INVALID_INPUT',
              'As notas aprovadas são recebidas no avanço para Planejamento, Desenvolvimento, Testes ou Code Review.',
              400,
            );
          }
          if (parsed.data.planningApproval !== undefined && nextStage !== 'development') {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_INVALID_INPUT',
              'As decisões e critérios aprovados do planejamento só podem ser enviados no avanço para Desenvolvimento.',
              400,
            );
          }
          const details = this.getFlow(flowId);
          this.assertStageHandoff(details, nextStage);

          const at = parsed.data.at ?? this.now();
          const planningApproval =
            parsed.data.planningApproval !== undefined && nextStage === 'development'
              ? buildValidatedPlanningApproval(details, parsed.data.planningApproval, at)
              : undefined;
          const nextIteration =
            nextStage === 'development' && flow.iteration === 0 ? 1 : undefined;
          const advanced = this.repository.saveFlowTransition(
            flowId,
            {
              to: 'running',
              stage: nextStage,
              at,
              reason: parsed.data.reason ?? `Avanço da etapa ${flow.currentStage} para ${nextStage}`,
              currentSessionId: null,
              ...(nextIteration !== undefined ? { iteration: nextIteration } : {}),
              ...(planningApproval !== undefined ? { planningApproval } : {}),
              loopPausedReason: null,
              error: null,
            },
            { expectedUpdatedAt: parsed.data.expectedUpdatedAt },
          );
          const effectiveApprovedNotes = parsed.data.approvedNotes ?? planningApproval?.notes;
          if (effectiveApprovedNotes !== undefined) {
            this.repository.updateStage(flowId, nextStage, {
              approvedNotes: effectiveApprovedNotes,
              updatedAt: at,
            });
          }
          if (handoffConfig.handoffReason) {
            return this.repository.saveFlowTransition(flowId, {
              to: 'waiting_action',
              stage: nextStage,
              at,
              reason: handoffConfig.handoffReason,
            }).flow;
          }
          return advanced.flow;
        }),
      );

      return {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        flow,
      };
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async returnStage(
    flowIdInput: string,
    requestInput: unknown,
  ): Promise<TransitionFactoryFlowResponse> {
    const flowId = this.parseFlowId(flowIdInput);

    const parsed = ReturnFactoryStageRequestSchema.safeParse(requestInput);
    if (!parsed.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Os dados para retornar a etapa do fluxo são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }

    try {
      const flow = await this.repository.withWriteLock(() =>
        this.repository.runInTransaction(() => {
          const flow = this.repository.getFlowById(flowId);
          if (!flow) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_NOT_FOUND',
              `Fluxo ${flowId} não encontrado.`,
              404,
            );
          }

          if (isFinalFactoryFlowState(flow.state)) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_INVALID_TRANSITION',
              `Não é possível retornar etapa de um fluxo no estado final ${flow.state}.`,
              409,
            );
          }

          const { targetStage } = parsed.data;
          if (!canReturnFactoryStage(flow.currentStage, targetStage)) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
              `Não é possível retornar a etapa de ${flow.currentStage} para ${targetStage}.`,
              409,
            );
          }

          if (flow.state !== 'waiting_action' || flow.currentSessionId) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_CONFLICT',
              'Aguarde o término da sessão atual antes de retornar o fluxo para correções.',
              409,
            );
          }

          this.assertStageHandoff(this.getFlow(flowId), targetStage);

          const at = parsed.data.at ?? this.now();
          const nextIteration = Math.max(flow.iteration, 1) + 1;
          this.repository.saveFlowTransition(
            flowId,
            {
              to: 'running',
              stage: targetStage,
              at,
              reason: parsed.data.reason ?? `Retorno da etapa ${flow.currentStage} para ${targetStage}`,
              currentSessionId: null,
              iteration: nextIteration,
              lastReviewVerdict: null,
              loopPausedReason: null,
              error: null,
            },
            { expectedUpdatedAt: parsed.data.expectedUpdatedAt, direction: 'return' },
          );
          if (parsed.data.approvedNotes !== undefined) {
            this.repository.updateStage(flowId, targetStage, {
              approvedNotes: parsed.data.approvedNotes,
              updatedAt: at,
            });
          }
          return this.repository.saveFlowTransition(flowId, {
            to: 'waiting_action',
            stage: targetStage,
            at,
            reason: `Etapa ${targetStage} reaberta após retorno do Code Review`,
          }).flow;
        }),
      );

      return {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        flow,
      };
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async attachSession(
    flowIdInput: string,
    sessionIdInput: string,
    options: AttachFactorySessionOptions = {},
  ): Promise<FactoryFlowDetails> {
    const flowId = this.parseFlowId(flowIdInput);
    const parsedSessionId = SessionIdSchema.safeParse(sessionIdInput);
    if (!parsedSessionId.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'O identificador da sessão deve ser um UUID válido.',
        400,
        formatZodIssues(parsedSessionId.error),
      );
    }

    if (options.stage !== undefined) {
      const parsedStage = FactoryStageNameSchema.safeParse(options.stage);
      if (!parsedStage.success) {
        throw new FactoryFlowServiceError(
          'FACTORY_FLOW_INVALID_INPUT',
          'A etapa informada para vincular a sessão é inválida.',
          400,
          formatZodIssues(parsedStage.error),
        );
      }
    }

    const at = options.at ?? this.now();

    try {
      await this.repository.withWriteLock(() => {
        const flow = this.repository.getFlowById(flowId);
        if (!flow) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_NOT_FOUND',
            `Fluxo ${flowId} não encontrado.`,
            404,
          );
        }

        if (isFinalFactoryFlowState(flow.state)) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_INVALID_TRANSITION',
            `Não é possível vincular sessão a um fluxo no estado final ${flow.state}.`,
            409,
          );
        }

        const targetStage = options.stage ?? flow.currentStage;
        if (targetStage !== flow.currentStage) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
            'Use a ação de avanço ou retorno antes de vincular uma sessão a outra etapa.',
            409,
          );
        }

        if (flow.state === 'running') {
          this.repository.updateFlowSession(flowId, parsedSessionId.data, flow.updatedAt);
          return;
        }

        this.repository.saveFlowTransition(flowId, {
          to: 'running',
          stage: targetStage,
          at,
          reason: options.reason ?? `Sessão ${parsedSessionId.data} vinculada à etapa ${targetStage}`,
          currentSessionId: parsedSessionId.data,
          loopPausedReason: null,
          error: null,
        });
      });

      return this.getFlow(flowId);
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async cancelFlow(
    flowIdInput: string,
    options: CancelFactoryFlowOptions = {},
  ): Promise<TransitionFactoryFlowResponse> {
    return this.transitionFlow(
      flowIdInput,
      {
        to: 'cancelled',
        at: options.at ?? this.now(),
        reason: options.reason ?? 'Fluxo cancelado pelo usuário',
        expectedUpdatedAt: options.expectedUpdatedAt,
      },
      {
        expectedUpdatedAt: options.expectedUpdatedAt,
        keepWorktree: options.keepWorktree,
      },
    );
  }

  async registerArtifact(
    flowIdInput: string,
    input: unknown,
    options: SaveFactoryArtifactOptions = {},
  ): Promise<FactoryFlowArtifact> {
    const flowId = this.parseFlowId(flowIdInput);
    const parsed = RegisterFactoryFlowArtifactRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Os dados do artefato do fluxo são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }

    const timestamp = parsed.data.at ?? this.now();

    try {
      return await this.repository.withWriteLock(() => {
        const flow = this.repository.getFlowById(flowId);
        if (!flow) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_NOT_FOUND',
            `Fluxo ${flowId} não encontrado.`,
            404,
          );
        }

        const artifact = FactoryFlowArtifactSchema.parse({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          id: this.generateId(),
          flowId,
          stage: parsed.data.stage,
          sessionId: parsed.data.sessionId ?? null,
          kind: parsed.data.kind,
          format: parsed.data.format,
          path: parsed.data.path,
          status: parsed.data.status,
          iteration: parsed.data.iteration ?? flow.iteration,
          createdAt: timestamp,
          updatedAt: timestamp,
          error: parsed.data.error ?? null,
        });

        return this.repository.saveArtifact(artifact, options);
      });
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async updateWorktreeMetadata(flowIdInput: string, input: unknown): Promise<FactoryFlow> {
    const flowId = this.parseFlowId(flowIdInput);
    const parsed = UpdateFactoryFlowWorktreeRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Os metadados de worktree do fluxo são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }

    try {
      return await this.repository.withWriteLock(() =>
        this.repository.updateFlowWorktree(flowId, {
          worktreePath: parsed.data.worktreePath,
          branchName: parsed.data.branchName,
          baseBranch: parsed.data.baseBranch,
        }),
      );
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async registerCheckpoint(flowIdInput: string, input: unknown): Promise<FactoryFlowCheckpoint> {
    const flowId = this.parseFlowId(flowIdInput);
    const parsed = RegisterFactoryFlowCheckpointRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Os dados do checkpoint do fluxo são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }

    const createdAt = parsed.data.at ?? this.now();

    try {
      return await this.repository.withWriteLock(() => {
        const flow = this.repository.getFlowById(flowId);
        if (!flow) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_NOT_FOUND',
            `Fluxo ${flowId} não encontrado.`,
            404,
          );
        }

        const checkpoint = FactoryFlowCheckpointSchema.parse({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          id: this.generateId(),
          flowId,
          stage: parsed.data.stage,
          iteration: parsed.data.iteration ?? flow.iteration,
          commitSha: parsed.data.commitSha,
          branchName:
            parsed.data.branchName !== undefined ? parsed.data.branchName : flow.branchName,
          sessionId: parsed.data.sessionId ?? null,
          message: parsed.data.message ?? null,
          createdAt,
        });

        return this.repository.saveCheckpoint(checkpoint);
      });
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  /**
   * Gera um checkpoint Git no worktree do fluxo e registra o SHA resultante no SQLite.
   * Retorna `null` caso o fluxo não possua worktree isolado associado.
   */
  async createWorktreeCheckpoint(
    flowIdInput: string,
    options: CreateWorktreeCheckpointOptions,
  ): Promise<FactoryFlowCheckpoint | null> {
    const flowId = this.parseFlowId(flowIdInput);
    const parsedStage = FactoryStageNameSchema.safeParse(options.stage);
    if (!parsedStage.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Nome de etapa inválido para checkpoint.',
        400,
        formatZodIssues(parsedStage.error),
      );
    }

    try {
      return await this.repository.withWriteLock(async () => {
        const flow = this.repository.getFlowById(flowId);
        if (!flow) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_NOT_FOUND',
            `Fluxo ${flowId} não encontrado.`,
            404,
          );
        }

        if (flow.worktreePath === null) {
          return null;
        }

        const iteration = options.iteration ?? flow.iteration;
        const gitCheckpoint = await createFactoryWorktreeCheckpoint({
          repoPath: flow.target.repoPath,
          worktreePath: flow.worktreePath,
          stage: parsedStage.data,
          iteration,
          message: options.message,
        });

        const checkpoint = FactoryFlowCheckpointSchema.parse({
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          id: this.generateId(),
          flowId,
          stage: parsedStage.data,
          iteration,
          commitSha: gitCheckpoint.commitSha,
          branchName: gitCheckpoint.branchName ?? flow.branchName,
          sessionId: options.sessionId ?? null,
          message: gitCheckpoint.message,
          createdAt: this.now(),
        });

        return this.repository.saveCheckpoint(checkpoint);
      });
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  /**
   * Reverte deterministicamente o worktree do fluxo para um checkpoint anterior registrado no SQLite.
   */
  async rollbackToCheckpoint(
    flowIdInput: string,
    requestInput: unknown = {},
  ): Promise<RollbackFactoryFlowCheckpointResponse> {
    const flowId = this.parseFlowId(flowIdInput);
    const parsed = RollbackFactoryFlowCheckpointRequestSchema.safeParse(requestInput);
    if (!parsed.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Os dados para rollback do checkpoint são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }

    try {
      return await this.repository.withWriteLock(async () => {
        const flow = this.repository.getFlowById(flowId);
        if (!flow) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_NOT_FOUND',
            `Fluxo ${flowId} não encontrado.`,
            404,
          );
        }

        if (
          parsed.data.expectedUpdatedAt !== undefined &&
          flow.updatedAt !== parsed.data.expectedUpdatedAt
        ) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_CONFLICT',
            `O fluxo ${flowId} foi alterado por outra operação concorrente.`,
            409,
          );
        }

        if (isFinalFactoryFlowState(flow.state)) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_INVALID_TRANSITION',
            `Não é possível reverter o worktree de um fluxo no estado final ${flow.state}.`,
            409,
          );
        }

        if (flow.state === 'running' || flow.currentSessionId !== null) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_CONFLICT',
            'Encerre a sessão em execução antes de reverter o worktree para um checkpoint anterior.',
            409,
          );
        }

        if (flow.worktreePath === null) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_CONFLICT',
            'Este fluxo não possui um worktree isolado ativo para rollback.',
            409,
          );
        }

        const checkpoints = this.repository.listCheckpointsByFlowId(flowId);
        const headState = await getFactoryWorktreeHeadSha({
          repoPath: flow.target.repoPath,
          worktreePath: flow.worktreePath,
        });

        const targetCheckpoint = selectRollbackTargetCheckpoint(checkpoints, headState, {
          checkpointId: parsed.data.checkpointId,
          commitSha: parsed.data.commitSha,
        });

        const rolledBack = await rollbackFactoryWorktreeToCheckpoint({
          repoPath: flow.target.repoPath,
          worktreePath: flow.worktreePath,
          commitSha: targetCheckpoint.commitSha,
        });

        const at = this.now();
        const auditReason =
          parsed.data.reason ??
          `Rollback do worktree para checkpoint ${targetCheckpoint.commitSha.slice(0, 7)} (${targetCheckpoint.stage}, iteração ${targetCheckpoint.iteration})`;

        let updatedFlow: FactoryFlow;
        if (flow.state === 'waiting_action') {
          this.repository.saveFlowTransition(flowId, {
            to: 'running',
            stage: flow.currentStage,
            at,
            reason: `Iniciando rollback para checkpoint ${targetCheckpoint.commitSha.slice(0, 7)}`,
            currentSessionId: null,
          });
          updatedFlow = this.repository.saveFlowTransition(flowId, {
            to: 'waiting_action',
            stage: flow.currentStage,
            at,
            reason: auditReason,
            currentSessionId: null,
          }).flow;
        } else {
          updatedFlow = this.repository.saveFlowTransition(flowId, {
            to: 'waiting_action',
            stage: flow.currentStage,
            at,
            reason: auditReason,
            currentSessionId: null,
          }).flow;
        }

        return {
          contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
          flow: updatedFlow,
          checkpoint: targetCheckpoint,
          restoredCommitSha: rolledBack.commitSha,
        };
      });
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  /**
   * Remove com segurança o diretório externo do worktree quando permitido pela política de retenção,
   * preservando `branchName`, `baseBranch` e checkpoints históricos no SQLite.
   */
  async cleanupFlowWorktree(
    flowIdInput: string,
    options: CleanupFlowWorktreeOptions = {},
  ): Promise<FactoryFlow> {
    const flowId = this.parseFlowId(flowIdInput);

    try {
      return await this.repository.withWriteLock(async () => {
        const flow = this.repository.getFlowById(flowId);
        if (!flow) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_NOT_FOUND',
            `Fluxo ${flowId} não encontrado.`,
            404,
          );
        }

        if (
          flow.worktreePath === null ||
          !this.shouldCleanupWorktreeOnState(flow.state, options.keepWorktree)
        ) {
          return flow;
        }

        await cleanupFactoryWorktree({
          repoPath: flow.target.repoPath,
          worktreePath: flow.worktreePath,
          branchName: flow.branchName,
          baseBranch: flow.baseBranch,
        });

        return this.repository.updateFlowWorktree(flowId, {
          worktreePath: null,
        });
      });
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async updateStagePaths(
    flowIdInput: string,
    stageNameInput: FactoryStageName,
    patch: UpdateStagePathsInput,
  ): Promise<FactoryFlowStage> {
    const flowId = this.parseFlowId(flowIdInput);
    const parsedStage = FactoryStageNameSchema.safeParse(stageNameInput);
    if (!parsedStage.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Nome de etapa inválido.',
        400,
        formatZodIssues(parsedStage.error),
      );
    }

    try {
      return await this.repository.withWriteLock(() =>
        this.repository.updateStage(flowId, parsedStage.data, {
          reportPath: patch.reportPath,
          sessionPath: patch.sessionPath,
          updatedAt: patch.at ?? this.now(),
        }),
      );
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  /**
   * Persiste complemento ou respostas aprovadas para a etapa atual quando ela está pausada para ação humana.
   */
  async saveStageApprovedNotes(
    flowIdInput: string,
    stageNameInput: FactoryStageName,
    approvedNotesInput: unknown,
  ): Promise<FactoryFlowDetails> {
    const flowId = this.parseFlowId(flowIdInput);
    const parsedStage = FactoryStageNameSchema.safeParse(stageNameInput);
    if (!parsedStage.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'Nome de etapa inválido.',
        400,
        formatZodIssues(parsedStage.error),
      );
    }

    const parsedNotes = FactoryApprovedNotesSchema.safeParse(approvedNotesInput);
    if (!parsedNotes.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'O complemento ou notas informadas são inválidas.',
        400,
        formatZodIssues(parsedNotes.error),
      );
    }

    try {
      await this.repository.withWriteLock(() =>
        this.repository.runInTransaction(() => {
          const flow = this.repository.getFlowById(flowId);
          if (!flow) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_NOT_FOUND',
              `Fluxo ${flowId} não encontrado.`,
              404,
            );
          }
          if (isFinalFactoryFlowState(flow.state)) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_INVALID_TRANSITION',
              `Não é possível atualizar notas de um fluxo no estado final ${flow.state}.`,
              409,
            );
          }
          if (
            flow.currentStage !== parsedStage.data ||
            flow.state === 'running' ||
            flow.currentSessionId !== null
          ) {
            throw new FactoryFlowServiceError(
              'FACTORY_FLOW_CONFLICT',
              'Encerre a sessão em execução antes de atualizar o complemento da etapa.',
              409,
            );
          }

          this.repository.updateStage(flowId, parsedStage.data, {
            approvedNotes: parsedNotes.data,
            updatedAt: this.now(),
          });
        }),
      );

      return this.getFlow(flowId);
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  /**
   * Reconcilia sincronamente no startup fluxos que ficaram presos em `running` no SQLite sem runtime ativo.
   */
  reconcileInterruptedFlowsSync(
    isFlowActive: (flow: FactoryFlow) => boolean,
    options: ReconcileInterruptedFlowsOptions = {},
  ): FactoryFlow[] {
    try {
      return this.repository.runInTransaction(() => {
        const runningFlows = this.repository.listFlows({ state: 'running' });
        const reconciled: FactoryFlow[] = [];
        const baseAt = options.at ?? this.now();
        const baseAtMs = Date.parse(baseAt);

        for (const flow of runningFlows) {
          if (isFlowActive(flow)) {
            continue;
          }

          const flowUpdatedMs = Date.parse(flow.updatedAt);
          const effectiveAt =
            Number.isFinite(baseAtMs) && Number.isFinite(flowUpdatedMs) && baseAtMs >= flowUpdatedMs
              ? baseAt
              : flow.updatedAt;
          const stageLabel = FACTORY_STAGE_LABELS[flow.currentStage];
          const loopPausedReason =
            options.reason ??
            `Reinício do servidor interrompeu a etapa ${stageLabel} em execução. Retome a etapa para continuar.`;
          const updated = this.repository.saveFlowTransition(flow.id, {
            to: 'waiting_action',
            stage: flow.currentStage,
            at: effectiveAt,
            reason: `Reconciliação automática: ${loopPausedReason}`,
            currentSessionId: null,
            loopPausedReason,
            error: null,
          });
          reconciled.push(updated.flow);
        }

        return reconciled;
      });
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  /**
   * Reconcilia com lock assíncrono fluxos presos em `running` no SQLite sem runtime ativo em memória.
   */
  async reconcileInterruptedFlows(
    isFlowActive: (flow: FactoryFlow) => boolean,
    options: ReconcileInterruptedFlowsOptions = {},
  ): Promise<FactoryFlow[]> {
    try {
      return await this.repository.withWriteLock(() =>
        this.reconcileInterruptedFlowsSync(isFlowActive, options),
      );
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  private parseFlowId(flowIdInput: string): string {
    const parsedId = FlowIdSchema.safeParse(flowIdInput);
    if (!parsedId.success) {
      throw new FactoryFlowServiceError(
        'FACTORY_FLOW_INVALID_INPUT',
        'O identificador do fluxo deve ser um UUID válido.',
        400,
        formatZodIssues(parsedId.error),
      );
    }
    return parsedId.data;
  }
}
