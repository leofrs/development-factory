import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AdvanceFactoryStageRequestSchema,
  CreateFactoryFlowRequestSchema,
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_STAGE_ORDER,
  FactoryFlowArtifactSchema,
  FactoryFlowDomainError,
  FactoryFlowSchema,
  FactoryFlowStageSchema,
  FactoryIdempotencyKeySchema,
  FactoryStageNameSchema,
  ListFactoryFlowsFilterSchema,
  RegisterFactoryFlowArtifactRequestSchema,
  TransitionFactoryFlowRequestSchema,
  getNextFactoryStage,
  isFinalFactoryFlowState,
  type CreateFactoryFlowResponse,
  type FactoryFlowApiErrorCode,
  type FactoryFlowArtifact,
  type FactoryFlowDetails,
  type FactoryFlowListResponse,
  type FactoryFlowStage,
  type FactoryStageName,
  type FactoryTaskInput,
  type TransitionFactoryFlowResponse,
} from '@development-factory/shared';
import {
  ReviewStorageError,
  type SaveFactoryArtifactOptions,
  type SaveFactoryFlowTransitionOptions,
  type SqliteFactoryFlowRepository,
} from './storage/index.js';

const FlowIdSchema = z.string().uuid('Identificador de fluxo inválido.');
const SessionIdSchema = z.string().uuid('Identificador de sessão inválido.');

export interface FactoryFlowServiceOptions {
  readonly now?: () => string;
  readonly generateId?: () => string;
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
}

export interface UpdateStagePathsInput {
  readonly reportPath?: string | null;
  readonly sessionPath?: string | null;
  readonly at?: string;
}

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

function fingerprintFlowRequest(task: FactoryTaskInput, title: string): string {
  const canonical = JSON.stringify({
    inputType: task.inputType,
    value: task.value,
    repoPath: task.repoPath,
    title,
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
  return new FactoryFlowServiceError(
    'FACTORY_FLOW_INTERNAL_ERROR',
    'Erro interno inesperado ao processar o fluxo da Factory.',
    500,
    undefined,
    { cause: error },
  );
}

/**
 * Serviço de domínio independente de transporte (HTTP/WebSocket) para orquestração de fluxos da Factory.
 */
export class FactoryFlowService {
  private readonly now: () => string;
  private readonly generateId: () => string;

  constructor(
    private readonly repository: SqliteFactoryFlowRepository,
    options: FactoryFlowServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? randomUUID;
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
                fingerprint: fingerprintFlowRequest(parsed.data.task, title),
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

      return {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        flow,
        stages,
        artifacts,
      };
    } catch (error) {
      throw mapUnexpectedError(error);
    }
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

  async transitionFlow(
    flowIdInput: string,
    commandInput: unknown,
    options: SaveFactoryFlowTransitionOptions = {},
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
    };
    const saveOptions: SaveFactoryFlowTransitionOptions = {
      expectedUpdatedAt: options.expectedUpdatedAt ?? expectedUpdatedAt,
    };

    try {
      const result = await this.repository.withWriteLock(() =>
        this.repository.saveFlowTransition(flowId, command, saveOptions),
      );

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
      const result = await this.repository.withWriteLock(() => {
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
        if (!nextStage) {
          throw new FactoryFlowServiceError(
            'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
            `O fluxo já está na etapa final (${flow.currentStage}).`,
            409,
          );
        }

        const nextState = flow.state === 'running' ? 'waiting_action' : 'running';
        return this.repository.saveFlowTransition(
          flowId,
          {
            to: nextState,
            stage: nextStage,
            at: parsed.data.at ?? this.now(),
            reason: parsed.data.reason ?? `Avanço da etapa ${flow.currentStage} para ${nextStage}`,
            currentSessionId: null,
          },
          { expectedUpdatedAt: parsed.data.expectedUpdatedAt },
        );
      });

      return {
        contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
        flow: result.flow,
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
        if (flow.state === 'running' && targetStage === flow.currentStage) {
          this.repository.updateFlowSession(flowId, parsedSessionId.data, at);
          return;
        }

        if (flow.state === 'running') {
          this.repository.saveFlowTransition(flowId, {
            to: 'waiting_action',
            stage: targetStage,
            at,
            reason: options.reason ?? `Preparando etapa ${targetStage} para nova sessão`,
            currentSessionId: parsedSessionId.data,
          });
          this.repository.saveFlowTransition(flowId, {
            to: 'running',
            stage: targetStage,
            at,
            reason: options.reason ?? `Sessão ${parsedSessionId.data} vinculada à etapa ${targetStage}`,
            currentSessionId: parsedSessionId.data,
          });
          return;
        }

        this.repository.saveFlowTransition(flowId, {
          to: 'running',
          stage: targetStage,
          at,
          reason: options.reason ?? `Sessão ${parsedSessionId.data} vinculada à etapa ${targetStage}`,
          currentSessionId: parsedSessionId.data,
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
      { expectedUpdatedAt: options.expectedUpdatedAt },
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
      createdAt: timestamp,
      updatedAt: timestamp,
      error: parsed.data.error ?? null,
    });

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

        return this.repository.saveArtifact(artifact, options);
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
