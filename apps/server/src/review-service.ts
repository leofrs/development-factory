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
  isFinalReviewState,
  type CreateReviewResponse,
  type CreateReviewTargetInput,
  type PrepareReviewArtifactsResponse,
  type RegisterReviewArtifactResponse,
  type Review,
  type ReviewApiErrorCode,
  type ReviewArtifact,
  type ReviewArtifactListResponse,
  type ReviewDetails,
  type ReviewListResponse,
} from '@development-factory/shared';
import {
  ArtifactPreparationError,
  defaultReviewArtifactFileWriter,
  type ReviewArtifactFileWriter,
} from './artifacts.js';
import {
  ReviewStorageError,
  type SaveTransitionOptions,
  type SqliteReviewRepository,
} from './storage/index.js';

const ReviewIdSchema = z.string().uuid('Identificador de review inválido.');

export interface ReviewServiceOptions {
  readonly now?: () => string;
  readonly generateId?: () => string;
  readonly artifactWriter?: ReviewArtifactFileWriter;
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
  private readonly artifactWriter: ReviewArtifactFileWriter;

  constructor(
    private readonly repository: SqliteReviewRepository,
    options: ReviewServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? randomUUID;
    this.artifactWriter = options.artifactWriter ?? defaultReviewArtifactFileWriter;
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
      const targets = this.artifactWriter.prepareExecutionFiles(review, execution, {
        includeStructuredResult: parsedInput.data.includeStructuredResult,
        createdAt,
      });

      const artifacts = await this.repository.withWriteLock(() => {
        const items: ReviewArtifact[] = targets.map(target => ReviewArtifactSchema.parse({
          contractVersion: REVIEW_CONTRACT_VERSION,
          id: this.generateId(),
          reviewId: review.id,
          executionId: execution.id,
          kind: target.kind,
          format: target.format,
          path: target.path,
          version: this.repository.getNextArtifactVersion(review.id, execution.id, target.kind),
          status: 'pending',
          createdAt,
          updatedAt: createdAt,
          error: null,
        }));

        return this.repository.saveArtifacts(items, {
          type: 'review_artifacts_prepared',
          occurredAt: createdAt,
        });
      });

      return {
        contractVersion: REVIEW_CONTRACT_VERSION,
        artifacts,
      };
    } catch (error) {
      if (error instanceof ArtifactPreparationError) {
        const failedAt = this.now();
        const reviewError = ReviewErrorSchema.parse({
          contractVersion: REVIEW_CONTRACT_VERSION,
          code: 'ARTIFACT_CREATION_FAILED',
          message: error.message,
          occurredAt: failedAt,
          retryable: false,
        });

        const failedArtifacts: ReviewArtifact[] = error.targets.map(target => {
          const wasCreated = error.createdKinds.has(target.kind);
          return ReviewArtifactSchema.parse({
            contractVersion: REVIEW_CONTRACT_VERSION,
            id: this.generateId(),
            reviewId: review.id,
            executionId: execution.id,
            kind: target.kind,
            format: target.format,
            path: target.path,
            version: this.repository.getNextArtifactVersion(review.id, execution.id, target.kind),
            status: wasCreated ? 'incomplete' : 'failed',
            createdAt,
            updatedAt: failedAt,
            error: reviewError,
          });
        });

        await this.repository.withWriteLock(() =>
          this.repository.saveArtifactsAndFailReview(
            review.id,
            execution.id,
            failedArtifacts,
            reviewError,
            failedAt,
            error.message,
          ),
        );

        throw new ReviewServiceError(
          'REVIEW_ARTIFACT_FAILED',
          error.message,
          500,
          undefined,
          { cause: error },
        );
      }

      throw mapUnexpectedError(error);
    }
  }
}
