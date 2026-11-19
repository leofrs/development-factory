import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CreateReviewRequestSchema,
  IdempotencyKeySchema,
  ListReviewsFilterSchema,
  PrepareReviewArtifactsRequestSchema,
  REVIEW_CONTRACT_VERSION,
  RegisterReviewArtifactRequestSchema,
  ReviewArtifactSchema,
  ReviewDomainError,
  ReviewErrorSchema,
  ReviewExecutionSchema,
  ReviewSchema,
  TransitionReviewRequestSchema,
  canTransitionReview,
  isFinalReviewState,
  type CreateReviewResponse,
  type CreateReviewTargetInput,
  type PrepareReviewArtifactsResponse,
  type RegisterReviewArtifactResponse,
  type Review,
  type ReviewApiErrorCode,
  type ReviewArtifact,
  type ReviewArtifactListResponse,
  type ReviewArtifactStatus,
  type ReviewDetails,
  type ReviewError,
  type ReviewExecution,
  type ReviewListResponse,
  type ReviewProcess,
} from '@development-factory/shared';
import { ReviewDestinationError, resolveReviewReportDirectory, reviewReportPath } from './artifacts.js';
import {
  ReviewStorageError,
  type SaveTransitionOptions,
  type SqliteReviewRepository,
} from './storage/index.js';

const ReviewIdSchema = z.string().uuid('Identificador de review inválido.');

export interface ReviewServiceOptions {
  readonly now?: () => string;
  readonly generateId?: () => string;
}

export interface CreateReviewCommandOptions {
  readonly idempotencyKey?: string;
}

/** Erro de domínio/aplicação do serviço de reviews com código estável e status HTTP associado. */
export class ReviewServiceError extends Error {
  constructor(
    public readonly code: ReviewApiErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly details?: readonly string[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReviewServiceError';
  }
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });
}

function fingerprintTarget(target: CreateReviewTargetInput): string {
  const canonical = JSON.stringify({
    type: target.type,
    identifier: target.identifier,
    repoPath: target.repoPath,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function mapUnexpectedError(error: unknown): ReviewServiceError {
  if (error instanceof ReviewServiceError) {
    return error;
  }
  if (error instanceof ReviewDomainError) {
    const statusCode = error.code === 'REVIEW_INVALID_TRANSITION' ? 409 : 400;
    return new ReviewServiceError(error.code, error.message, statusCode, undefined, { cause: error });
  }
  if (error instanceof ReviewStorageError) {
    switch (error.code) {
      case 'STORAGE_NOT_FOUND':
        return new ReviewServiceError('REVIEW_NOT_FOUND', error.message, 404, undefined, { cause: error });
      case 'STORAGE_CONFLICT':
        return new ReviewServiceError('REVIEW_CONFLICT', error.message, 409, undefined, { cause: error });
      case 'STORAGE_INVALID_INPUT':
        return new ReviewServiceError('REVIEW_INVALID_INPUT', error.message, 400, undefined, { cause: error });
      default:
        return new ReviewServiceError(
          'REVIEW_INTERNAL_ERROR',
          'Não foi possível concluir a operação de persistência do review.',
          500,
          undefined,
          { cause: error },
        );
    }
  }
  return new ReviewServiceError(
    'REVIEW_INTERNAL_ERROR',
    'Erro interno inesperado ao processar o review.',
    500,
    undefined,
    { cause: error },
  );
}

/**
 * Serviço de domínio independente de transporte (HTTP/WebSocket) para criação, consulta e transição de reviews.
 */
export class ReviewService {
  private readonly now: () => string;
  private readonly generateId: () => string;

  constructor(
    private readonly repository: SqliteReviewRepository,
    options: ReviewServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? randomUUID;
  }

  async createReview(
    input: unknown,
    options: CreateReviewCommandOptions = {},
  ): Promise<CreateReviewResponse> {
    const parsed = CreateReviewRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'Os dados para criar o review são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }

    let headerKey: string | undefined;
    if (options.idempotencyKey !== undefined) {
      const parsedHeaderKey = IdempotencyKeySchema.safeParse(options.idempotencyKey);
      if (!parsedHeaderKey.success) {
        throw new ReviewServiceError(
          'REVIEW_INVALID_INPUT',
          'A chave de idempotência informada é inválida.',
          400,
          formatZodIssues(parsedHeaderKey.error),
        );
      }
      headerKey = parsedHeaderKey.data;
    }

    const bodyKey = parsed.data.idempotencyKey;
    if (headerKey !== undefined && bodyKey !== undefined && headerKey !== bodyKey) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'A chave de idempotência do cabeçalho diverge da informada no corpo da requisição.',
        400,
      );
    }

    const effectiveKey = headerKey ?? bodyKey;
    const createdAt = this.now();
    const reviewId = this.generateId();
    const executionId = this.generateId();

    const review = ReviewSchema.parse({
      contractVersion: REVIEW_CONTRACT_VERSION,
      id: reviewId,
      target: {
        contractVersion: REVIEW_CONTRACT_VERSION,
        ...parsed.data.target,
      },
      state: 'preparing',
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
      currentExecutionId: executionId,
      transitions: [],
      result: null,
      error: null,
    });

    const execution = ReviewExecutionSchema.parse({
      contractVersion: REVIEW_CONTRACT_VERSION,
      id: executionId,
      reviewId,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      process: { status: 'pending' },
    });

    const idempotency = effectiveKey !== undefined
      ? { key: effectiveKey, fingerprint: fingerprintTarget(parsed.data.target) }
      : undefined;

    try {
      const created = await this.repository.withWriteLock(() =>
        this.repository.createReviewIdempotently(review, execution, idempotency),
      );
      return {
        contractVersion: REVIEW_CONTRACT_VERSION,
        review: created.review,
        execution: created.execution,
        replayed: created.replayed,
      };
    } catch (error) {
      if (error instanceof ReviewStorageError && error.code === 'STORAGE_CONFLICT' && effectiveKey !== undefined) {
        throw new ReviewServiceError(
          'REVIEW_IDEMPOTENCY_CONFLICT',
          error.message,
          409,
          undefined,
          { cause: error },
        );
      }
      throw mapUnexpectedError(error);
    }
  }

  getReview(reviewIdInput: string): ReviewDetails {
    const parsedId = ReviewIdSchema.safeParse(reviewIdInput);
    if (!parsedId.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'O identificador do review deve ser um UUID válido.',
        400,
        formatZodIssues(parsedId.error),
      );
    }

    try {
      const review = this.repository.getReviewById(parsedId.data);
      if (!review) {
        throw new ReviewServiceError(
          'REVIEW_NOT_FOUND',
          `Review ${parsedId.data} não encontrado.`,
          404,
        );
      }

      const executions = this.repository.listExecutionsByReviewId(review.id);
      const events = this.repository.listEventsByReviewId(review.id);
      const artifacts = this.repository.listArtifactsByReviewId(review.id);

      return {
        contractVersion: REVIEW_CONTRACT_VERSION,
        review,
        executions,
        events,
        artifacts,
      };
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  listReviews(filterInput: unknown = {}): ReviewListResponse {
    const parsed = ListReviewsFilterSchema.safeParse(filterInput);
    if (!parsed.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'Os filtros de listagem de reviews são inválidos.',
        400,
        formatZodIssues(parsed.error),
      );
    }

    try {
      const reviews = this.repository.listReviews(parsed.data);
      return {
        contractVersion: REVIEW_CONTRACT_VERSION,
        reviews,
      };
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async transitionReview(
    reviewIdInput: string,
    commandInput: unknown,
    options: SaveTransitionOptions = {},
  ): Promise<Review> {
    const parsedId = ReviewIdSchema.safeParse(reviewIdInput);
    if (!parsedId.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'O identificador do review deve ser um UUID válido.',
        400,
        formatZodIssues(parsedId.error),
      );
    }

    const parsedCommand = TransitionReviewRequestSchema.safeParse(commandInput);
    if (!parsedCommand.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'Os dados da transição do review são inválidos.',
        400,
        formatZodIssues(parsedCommand.error),
      );
    }

    const { expectedUpdatedAt, at, ...rest } = parsedCommand.data;
    const command = {
      ...rest,
      at: at ?? this.now(),
    };
    const saveOptions: SaveTransitionOptions = {
      ...options,
      expectedUpdatedAt: options.expectedUpdatedAt ?? expectedUpdatedAt,
    };

    try {
      return await this.repository.withWriteLock(() =>
        this.repository.saveReviewTransition(parsedId.data, command, saveOptions),
      );
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  listArtifacts(reviewIdInput: string, executionIdInput?: string): ReviewArtifactListResponse {
    const parsedReviewId = ReviewIdSchema.safeParse(reviewIdInput);
    if (!parsedReviewId.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'O identificador do review deve ser um UUID válido.',
        400,
        formatZodIssues(parsedReviewId.error),
      );
    }

    let executionId: string | undefined;
    if (executionIdInput !== undefined) {
      const parsedExecId = ReviewIdSchema.safeParse(executionIdInput);
      if (!parsedExecId.success) {
        throw new ReviewServiceError(
          'REVIEW_INVALID_INPUT',
          'O identificador da execução deve ser um UUID válido.',
          400,
          formatZodIssues(parsedExecId.error),
        );
      }
      executionId = parsedExecId.data;
    }

    try {
      const review = this.repository.getReviewById(parsedReviewId.data);
      if (!review) {
        throw new ReviewServiceError(
          'REVIEW_NOT_FOUND',
          `Review ${parsedReviewId.data} não encontrado.`,
          404,
        );
      }
      const artifacts = this.repository.listArtifactsByReviewId(review.id, executionId);
      return {
        contractVersion: REVIEW_CONTRACT_VERSION,
        artifacts,
      };
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async registerArtifact(
    reviewIdInput: string,
    input: unknown,
  ): Promise<RegisterReviewArtifactResponse> {
    const parsedId = ReviewIdSchema.safeParse(reviewIdInput);
    if (!parsedId.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'O identificador do review deve ser um UUID válido.',
        400,
        formatZodIssues(parsedId.error),
      );
    }

    const parsedInput = RegisterReviewArtifactRequestSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'Os dados para registrar o artefato são inválidos.',
        400,
        formatZodIssues(parsedInput.error),
      );
    }

    const at = parsedInput.data.at ?? this.now();
    const format = parsedInput.data.format ??
      (parsedInput.data.kind === 'structured_result' ? 'json' : 'markdown');

    try {
      const artifact = await this.repository.withWriteLock(() => {
        const review = this.repository.getReviewById(parsedId.data);
        if (!review) {
          throw new ReviewServiceError(
            'REVIEW_NOT_FOUND',
            `Review ${parsedId.data} não encontrado.`,
            404,
          );
        }

        const version = parsedInput.data.version ??
          this.repository.getNextArtifactVersion(review.id, parsedInput.data.executionId, parsedInput.data.kind);

        const candidate = ReviewArtifactSchema.safeParse({
          contractVersion: REVIEW_CONTRACT_VERSION,
          id: this.generateId(),
          reviewId: review.id,
          executionId: parsedInput.data.executionId,
          kind: parsedInput.data.kind,
          format,
          path: parsedInput.data.path,
          version,
          status: parsedInput.data.status,
          createdAt: at,
          updatedAt: at,
          error: parsedInput.data.error ?? null,
        });

        if (!candidate.success) {
          throw new ReviewServiceError(
            'REVIEW_INVALID_CONTRACT',
            'Os dados do artefato violam o contrato do review.',
            400,
            formatZodIssues(candidate.error),
          );
        }

        return this.repository.saveArtifact(candidate.data, {
          type: 'review_artifact_registered',
          occurredAt: at,
        });
      });

      return {
        contractVersion: REVIEW_CONTRACT_VERSION,
        artifact,
      };
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async prepareExecutionArtifacts(
    reviewIdInput: string,
    input: unknown = {},
  ): Promise<PrepareReviewArtifactsResponse> {
    const parsedId = ReviewIdSchema.safeParse(reviewIdInput);
    if (!parsedId.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'O identificador do review deve ser um UUID válido.',
        400,
        formatZodIssues(parsedId.error),
      );
    }

    const parsedInput = PrepareReviewArtifactsRequestSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'Os parâmetros para preparar os artefatos são inválidos.',
        400,
        formatZodIssues(parsedInput.error),
      );
    }

    const review = this.repository.getReviewById(parsedId.data);
    if (!review) {
      throw new ReviewServiceError(
        'REVIEW_NOT_FOUND',
        `Review ${parsedId.data} não encontrado.`,
        404,
      );
    }

    if (isFinalReviewState(review.state)) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_TRANSITION',
        'Não é possível preparar artefatos para um review já finalizado.',
        409,
      );
    }

    const executionId = parsedInput.data.executionId ?? review.currentExecutionId;
    if (!executionId) {
      throw new ReviewServiceError(
        'REVIEW_CONFLICT',
        'O review não possui execução ativa para associar artefatos.',
        409,
      );
    }

    const execution = this.repository.getExecutionById(executionId);
    if (!execution || execution.reviewId !== review.id) {
      throw new ReviewServiceError(
        'REVIEW_NOT_FOUND',
        `Execução ${executionId} não encontrada para o review ${review.id}.`,
        404,
      );
    }

    const createdAt = this.now();

    try {
      const directory = resolveReviewReportDirectory(review.target.repoPath, parsedInput.data.reportDirectory);
      const path = reviewReportPath(directory, review, execution);
      const artifact = await this.repository.withWriteLock(() => {
        const prepared = this.repository.listArtifactsByReviewId(review.id, execution.id)
          .find(item => item.kind === 'report' && item.path === path);
        if (prepared) {
          return prepared;
        }

        return this.repository.saveArtifact(ReviewArtifactSchema.parse({
          contractVersion: REVIEW_CONTRACT_VERSION,
          id: this.generateId(),
          reviewId: review.id,
          executionId: execution.id,
          kind: 'report',
          format: 'markdown',
          path,
          version: this.repository.getNextArtifactVersion(review.id, execution.id, 'report'),
          status: 'pending',
          createdAt,
          updatedAt: createdAt,
          error: null,
        }), {
          type: 'review_artifacts_prepared',
          occurredAt: createdAt,
        });
      });

      return { contractVersion: REVIEW_CONTRACT_VERSION, artifacts: [artifact] };
    } catch (error) {
      if (error instanceof ReviewDestinationError) {
        throw new ReviewServiceError('REVIEW_ARTIFACT_FAILED', error.message, 400, undefined, { cause: error });
      }
      throw mapUnexpectedError(error);
    }
  }

  /**
   * Registra o início efetivo do processo de execução e move o review para `analyzing`.
   */
  async startExecution(
    reviewIdInput: string,
    executionIdInput: string,
    pid: number,
    reason = 'Sessão PTY iniciada.',
  ): Promise<{ review: Review; execution: ReviewExecution }> {
    const parsedReviewId = ReviewIdSchema.safeParse(reviewIdInput);
    const parsedExecId = ReviewIdSchema.safeParse(executionIdInput);
    if (!parsedReviewId.success || !parsedExecId.success || !Number.isInteger(pid) || pid <= 0) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'Os dados para iniciar a execução do review são inválidos.',
        400,
      );
    }

    try {
      return await this.repository.withWriteLock(() => {
        const review = this.repository.getReviewById(parsedReviewId.data);
        if (!review) {
          throw new ReviewServiceError(
            'REVIEW_NOT_FOUND',
            `Review ${parsedReviewId.data} não encontrado.`,
            404,
          );
        }
        if (isFinalReviewState(review.state)) {
          throw new ReviewServiceError(
            'REVIEW_INVALID_TRANSITION',
            'Não é possível iniciar execução para um review já finalizado.',
            409,
          );
        }

        const execution = this.repository.getExecutionById(parsedExecId.data);
        if (!execution || execution.reviewId !== review.id) {
          throw new ReviewServiceError(
            'REVIEW_NOT_FOUND',
            `Execução ${parsedExecId.data} não encontrada para o review ${review.id}.`,
            404,
          );
        }

        const startedAt = this.now();
        const updatedExecution = this.repository.updateExecution(
          {
            ...execution,
            updatedAt: startedAt,
            startedAt,
            finishedAt: null,
            process: { status: 'running', pid },
          },
          {
            type: 'execution.started',
            occurredAt: startedAt,
            payload: { pid },
          },
        );

        const updatedReview = review.state === 'preparing'
          ? this.repository.saveReviewTransition(
            review.id,
            { to: 'analyzing', at: startedAt, reason },
            { executionId: execution.id },
          )
          : review;

        return { review: updatedReview, execution: updatedExecution };
      });
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  /**
   * Registra o encerramento técnico da execução e a transição correspondente do review.
   */
  async finishExecution(
    reviewIdInput: string,
    executionIdInput: string,
    params: {
      readonly process: Extract<ReviewProcess, { status: 'exited' | 'failed' }>;
      readonly targetState: 'incomplete' | 'failed' | 'cancelled';
      readonly reason: string;
      readonly error?: ReviewError;
      readonly eventType?: string;
    },
  ): Promise<{ review: Review; execution: ReviewExecution }> {
    const parsedReviewId = ReviewIdSchema.safeParse(reviewIdInput);
    const parsedExecId = ReviewIdSchema.safeParse(executionIdInput);
    if (!parsedReviewId.success || !parsedExecId.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'Os identificadores para finalizar a execução são inválidos.',
        400,
      );
    }

    try {
      return await this.repository.withWriteLock(() => {
        let review = this.repository.getReviewById(parsedReviewId.data);
        if (!review) {
          throw new ReviewServiceError(
            'REVIEW_NOT_FOUND',
            `Review ${parsedReviewId.data} não encontrado.`,
            404,
          );
        }

        let execution = this.repository.getExecutionById(parsedExecId.data);
        if (!execution || execution.reviewId !== review.id) {
          throw new ReviewServiceError(
            'REVIEW_NOT_FOUND',
            `Execução ${parsedExecId.data} não encontrada para o review ${review.id}.`,
            404,
          );
        }

        const finishedAt = this.now();
        if (execution.process.status === 'pending' || execution.process.status === 'running') {
          const startedAt = params.process.status === 'exited'
            ? (execution.startedAt ?? finishedAt)
            : execution.startedAt;

          execution = this.repository.updateExecution(
            {
              ...execution,
              updatedAt: finishedAt,
              startedAt,
              finishedAt,
              process: params.process,
            },
            {
              type: params.process.status === 'failed' ? 'execution.failed' : 'execution.exited',
              occurredAt: finishedAt,
              payload: { process: params.process },
            },
          );
        }

        if (!isFinalReviewState(review.state) && canTransitionReview(review.state, params.targetState)) {
          review = this.repository.saveReviewTransition(
            review.id,
            {
              to: params.targetState,
              at: finishedAt,
              reason: params.reason,
              error: params.error,
            },
            {
              executionId: execution.id,
              eventType: params.eventType,
            },
          );
        }

        return { review, execution };
      });
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  /**
   * Atualiza o estado de um artefato existente sem concluir automaticamente o review.
   */
  async updateArtifactStatus(
    reviewIdInput: string,
    artifactIdInput: string,
    status: ReviewArtifactStatus,
    error: ReviewError | null = null,
    eventType?: string,
  ): Promise<ReviewArtifact> {
    const parsedReviewId = ReviewIdSchema.safeParse(reviewIdInput);
    const parsedArtifactId = ReviewIdSchema.safeParse(artifactIdInput);
    if (!parsedReviewId.success || !parsedArtifactId.success) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'Os identificadores para atualizar o artefato são inválidos.',
        400,
      );
    }

    try {
      return await this.repository.withWriteLock(() => {
        const artifacts = this.repository.listArtifactsByReviewId(parsedReviewId.data);
        const existing = artifacts.find(item => item.id === parsedArtifactId.data);
        if (!existing) {
          throw new ReviewServiceError(
            'REVIEW_NOT_FOUND',
            `Artefato ${parsedArtifactId.data} não encontrado para o review ${parsedReviewId.data}.`,
            404,
          );
        }

        if (existing.status === status && existing.error?.code === error?.code && existing.error?.message === error?.message) {
          return existing;
        }

        const updatedAt = this.now();
        const candidate = ReviewArtifactSchema.safeParse({
          ...existing,
          status,
          error,
          updatedAt,
        });

        if (!candidate.success) {
          throw new ReviewServiceError(
            'REVIEW_INVALID_CONTRACT',
            'A atualização do artefato viola o contrato do review.',
            400,
            formatZodIssues(candidate.error),
          );
        }

        return this.repository.saveArtifact(
          candidate.data,
          eventType ? { type: eventType, occurredAt: updatedAt } : undefined,
        );
      });
    } catch (err) {
      throw mapUnexpectedError(err);
    }
  }
}
