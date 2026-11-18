import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  REVIEW_CONTRACT_VERSION,
  ReviewArtifactSchema,
  ReviewEventSchema,
  ReviewExecutionSchema,
  ReviewSchema,
  isFinalReviewState,
  transitionReview,
  type Review,
  type ReviewArtifact,
  type ReviewArtifactKind,
  type ReviewError,
  type ReviewEvent,
  type ReviewExecution,
  type ReviewState,
  type ReviewTransitionCommand,
} from '@development-factory/shared';
import { resolveReviewDbPath } from './config.js';
import { ReviewStorageError } from './errors.js';
import { REVIEW_MIGRATIONS, runMigrations, type AppliedMigration, type Migration } from './migrations.js';

export interface CreateReviewOptions {
  readonly execution?: ReviewExecution;
  readonly event?: Omit<ReviewEvent, 'sequence'>;
}

export interface IdempotencyOptions {
  readonly key: string;
  readonly fingerprint: string;
}

export interface CreateReviewIdempotentlyResult {
  readonly review: Review;
  readonly execution: ReviewExecution;
  readonly replayed: boolean;
}

export interface SaveTransitionOptions {
  readonly expectedUpdatedAt?: string;
  readonly executionId?: string | null;
  readonly eventType?: string;
  readonly eventPayload?: Record<string, unknown>;
}

export interface ExecutionEventInput {
  readonly type: string;
  readonly occurredAt?: string;
  readonly payload?: Record<string, unknown>;
}

export interface ListReviewsFilter {
  readonly state?: ReviewState;
  readonly repoPath?: string;
  readonly limit?: number;
}

export interface ReviewRepositoryOptions {
  readonly dbPath?: string;
  readonly migrations?: readonly Migration[];
}

interface ReviewRow {
  id: string;
  contract_version: number;
  target_type: string;
  target_identifier: string;
  target_repo_path: string;
  state: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  current_execution_id: string | null;
  transitions_json: string;
  result_json: string | null;
  error_json: string | null;
}

interface ExecutionRow {
  id: string;
  review_id: string;
  contract_version: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  process_json: string;
}

interface EventRow {
  id: string;
  review_id: string;
  execution_id: string | null;
  sequence: number;
  type: string;
  occurred_at: string;
  payload_json: string;
}

interface ArtifactRow {
  id: string;
  review_id: string;
  execution_id: string;
  contract_version: number;
  kind: string;
  format: string;
  path: string;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
  error_json: string | null;
}

function parseJson(raw: string, contextLabel: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ReviewStorageError(
      'STORAGE_CORRUPTED_DATA',
      `Os dados armazenados para ${contextLabel} estão corrompidos.`,
      { cause: error },
    );
  }
}

function rowToReview(row: ReviewRow): Review {
  const parsed = ReviewSchema.safeParse({
    contractVersion: row.contract_version,
    id: row.id,
    target: {
      contractVersion: row.contract_version,
      type: row.target_type,
      identifier: row.target_identifier,
      repoPath: row.target_repo_path,
    },
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    currentExecutionId: row.current_execution_id,
    transitions: parseJson(row.transitions_json, `transições do review ${row.id}`),
    result: row.result_json === null ? null : parseJson(row.result_json, `resultado do review ${row.id}`),
    error: row.error_json === null ? null : parseJson(row.error_json, `erro do review ${row.id}`),
  });

  if (!parsed.success) {
    throw new ReviewStorageError(
      'STORAGE_CORRUPTED_DATA',
      `O registro do review ${row.id} no banco local viola o contrato atual.`,
    );
  }
  return parsed.data;
}

function rowToExecution(row: ExecutionRow): ReviewExecution {
  const parsed = ReviewExecutionSchema.safeParse({
    contractVersion: row.contract_version,
    id: row.id,
    reviewId: row.review_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    process: parseJson(row.process_json, `processo da execução ${row.id}`),
  });

  if (!parsed.success) {
    throw new ReviewStorageError(
      'STORAGE_CORRUPTED_DATA',
      `O registro da execução ${row.id} no banco local viola o contrato atual.`,
    );
  }
  return parsed.data;
}

function rowToEvent(row: EventRow): ReviewEvent {
  const parsed = ReviewEventSchema.safeParse({
    contractVersion: REVIEW_CONTRACT_VERSION,
    id: row.id,
    reviewId: row.review_id,
    executionId: row.execution_id,
    sequence: row.sequence,
    type: row.type,
    occurredAt: row.occurred_at,
    payload: parseJson(row.payload_json, `payload do evento ${row.id}`),
  });

  if (!parsed.success) {
    throw new ReviewStorageError(
      'STORAGE_CORRUPTED_DATA',
      `O registro do evento ${row.id} no banco local viola o contrato atual.`,
    );
  }
  return parsed.data;
}

function rowToArtifact(row: ArtifactRow): ReviewArtifact {
  const parsed = ReviewArtifactSchema.safeParse({
    contractVersion: row.contract_version,
    id: row.id,
    reviewId: row.review_id,
    executionId: row.execution_id,
    kind: row.kind,
    format: row.format,
    path: row.path,
    version: row.version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error_json === null ? null : parseJson(row.error_json, `erro do artefato ${row.id}`),
  });

  if (!parsed.success) {
    throw new ReviewStorageError(
      'STORAGE_CORRUPTED_DATA',
      `O registro do artefato ${row.id} no banco local viola o contrato atual.`,
    );
  }
  return parsed.data;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes('UNIQUE constraint failed') ||
    error.message.includes('PRIMARY KEY constraint failed')
  );
}

/**
 * Repositório transacional local baseado em SQLite (`node:sqlite`) com WAL e migrations versionadas.
 */
export class SqliteReviewRepository {
  private inTransaction = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    public readonly dbPath: string,
    private readonly db: DatabaseSync,
  ) {}

  static open(options: ReviewRepositoryOptions = {}): SqliteReviewRepository {
    const dbPath = resolveReviewDbPath(options.dbPath);
    let db: DatabaseSync | undefined;

    try {
      db = new DatabaseSync(dbPath, { timeout: 5000 });
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
      `);
      runMigrations(db, options.migrations ?? REVIEW_MIGRATIONS);
      return new SqliteReviewRepository(dbPath, db);
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Ignora erro ao fechar conexão parcialmente aberta.
      }
      if (error instanceof ReviewStorageError) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReviewStorageError(
        'STORAGE_CONNECTION_FAILED',
        `Não foi possível abrir o banco local de reviews em "${dbPath}": ${detail}`,
        { cause: error },
      );
    }
  }

  /** Serializa operações assíncronas de escrita no mesmo processo além do lock `BEGIN IMMEDIATE` no SQLite. */
  withWriteLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.writeQueue.then(() => operation());
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  runInTransaction<T>(operation: () => T): T {
    this.ensureOpen();
    if (this.inTransaction) {
      return operation();
    }

    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignora se a transação já foi encerrada pelo SQLite.
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  createReview(reviewInput: Review, options: CreateReviewOptions = {}): Review {
    const parsedReview = ReviewSchema.safeParse(reviewInput);
    if (!parsedReview.success) {
      throw new ReviewStorageError(
        'STORAGE_INVALID_INPUT',
        `Os dados do review são inválidos para persistência: ${parsedReview.error.issues.map(issue => issue.message).join('; ')}`,
      );
    }
    const review = parsedReview.data;

    let execution: ReviewExecution | undefined;
    if (options.execution) {
      const parsedExecution = ReviewExecutionSchema.safeParse(options.execution);
      if (!parsedExecution.success || parsedExecution.data.reviewId !== review.id) {
        throw new ReviewStorageError('STORAGE_INVALID_INPUT', 'A execução inicial não corresponde ao review informado.');
      }
      execution = parsedExecution.data;
    }

    return this.runInTransaction(() => {
      try {
        this.db.prepare(`
          INSERT INTO reviews (
            id, contract_version, target_type, target_identifier, target_repo_path,
            state, created_at, updated_at, finished_at, current_execution_id,
            transitions_json, result_json, error_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          review.id,
          review.contractVersion,
          review.target.type,
          review.target.identifier,
          review.target.repoPath,
          review.state,
          review.createdAt,
          review.updatedAt,
          review.finishedAt,
          review.currentExecutionId,
          JSON.stringify(review.transitions),
          review.result ? JSON.stringify(review.result) : null,
          review.error ? JSON.stringify(review.error) : null,
        );
      } catch (error) {
        if (isConstraintError(error)) {
          throw new ReviewStorageError('STORAGE_CONFLICT', `Já existe um review cadastrado com o ID ${review.id}.`, { cause: error });
        }
        throw error;
      }

      if (execution) {
        this.insertExecutionRow(execution);
      }

      const event = options.event ?? {
        contractVersion: REVIEW_CONTRACT_VERSION,
        id: randomUUID(),
        reviewId: review.id,
        executionId: execution?.id ?? review.currentExecutionId,
        type: 'review.created',
        occurredAt: review.createdAt,
        payload: { state: review.state, target: review.target },
      };
      this.insertEventRow(event);

      return review;
    });
  }

  createReviewIdempotently(
    reviewInput: Review,
    executionInput: ReviewExecution,
    idempotency?: IdempotencyOptions,
  ): CreateReviewIdempotentlyResult {
    const parsedExecution = ReviewExecutionSchema.safeParse(executionInput);
    if (!parsedExecution.success || parsedExecution.data.reviewId !== reviewInput.id) {
      throw new ReviewStorageError('STORAGE_INVALID_INPUT', 'A execução inicial não corresponde ao review informado.');
    }
    const execution = parsedExecution.data;

    return this.runInTransaction(() => {
      if (idempotency) {
        const existing = this.db
          .prepare('SELECT review_id, request_fingerprint FROM review_idempotency_keys WHERE idempotency_key = ?')
          .get(idempotency.key) as { review_id: string; request_fingerprint: string } | undefined;

        if (existing) {
          if (existing.request_fingerprint !== idempotency.fingerprint) {
            throw new ReviewStorageError(
              'STORAGE_CONFLICT',
              'A chave de idempotência já foi utilizada para outra solicitação.',
            );
          }

          const existingReview = this.getReviewById(existing.review_id);
          if (!existingReview) {
            throw new ReviewStorageError(
              'STORAGE_CORRUPTED_DATA',
              `A chave de idempotência aponta para o review inexistente ${existing.review_id}.`,
            );
          }

          const existingExecution =
            (existingReview.currentExecutionId
              ? this.getExecutionById(existingReview.currentExecutionId)
              : null) ?? this.listExecutionsByReviewId(existingReview.id)[0];

          if (!existingExecution) {
            throw new ReviewStorageError(
              'STORAGE_CORRUPTED_DATA',
              `O review ${existingReview.id} não possui execução inicial registrada.`,
            );
          }

          return {
            review: existingReview,
            execution: existingExecution,
            replayed: true,
          };
        }
      }

      const review = this.createReview(reviewInput, { execution });
      if (idempotency) {
        this.db
          .prepare(
            'INSERT INTO review_idempotency_keys (idempotency_key, review_id, request_fingerprint, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(idempotency.key, review.id, idempotency.fingerprint, review.createdAt);
      }

      return {
        review,
        execution,
        replayed: false,
      };
    });
  }

  getReviewById(id: string): Review | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT
        id, contract_version, target_type, target_identifier, target_repo_path,
        state, created_at, updated_at, finished_at, current_execution_id,
        transitions_json, result_json, error_json
      FROM reviews
      WHERE id = ?
    `).get(id) as ReviewRow | undefined;

    return row ? rowToReview(row) : null;
  }

  listReviews(filter: ListReviewsFilter = {}): Review[] {
    this.ensureOpen();
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter.state) {
      conditions.push('state = ?');
      params.push(filter.state);
    }
    if (filter.repoPath) {
      conditions.push('target_repo_path = ?');
      params.push(filter.repoPath);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filter.limit !== undefined ? 'LIMIT ?' : '';
    if (filter.limit !== undefined) {
      if (!Number.isInteger(filter.limit) || filter.limit <= 0) {
        throw new ReviewStorageError('STORAGE_INVALID_INPUT', 'O limite de listagem deve ser um inteiro positivo.');
      }
      params.push(filter.limit);
    }

    const rows = this.db.prepare(`
      SELECT
        id, contract_version, target_type, target_identifier, target_repo_path,
        state, created_at, updated_at, finished_at, current_execution_id,
        transitions_json, result_json, error_json
      FROM reviews
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      ${limitClause}
    `).all(...params) as unknown as ReviewRow[];

    return rows.map(rowToReview);
  }

  saveReviewTransition(
    reviewId: string,
    command: ReviewTransitionCommand,
    options: SaveTransitionOptions = {},
  ): Review {
    return this.runInTransaction(() => {
      const current = this.getReviewById(reviewId);
      if (!current) {
        throw new ReviewStorageError('STORAGE_NOT_FOUND', `Review ${reviewId} não encontrado.`);
      }
      if (options.expectedUpdatedAt && current.updatedAt !== options.expectedUpdatedAt) {
        throw new ReviewStorageError(
          'STORAGE_CONFLICT',
          `O review ${reviewId} foi alterado por outra operação concorrente.`,
        );
      }

      const updated = transitionReview(current, command);
      this.db.prepare(`
        UPDATE reviews
        SET
          state = ?,
          updated_at = ?,
          finished_at = ?,
          current_execution_id = ?,
          transitions_json = ?,
          result_json = ?,
          error_json = ?
        WHERE id = ?
      `).run(
        updated.state,
        updated.updatedAt,
        updated.finishedAt,
        updated.currentExecutionId,
        JSON.stringify(updated.transitions),
        updated.result ? JSON.stringify(updated.result) : null,
        updated.error ? JSON.stringify(updated.error) : null,
        updated.id,
      );

      this.insertEventRow({
        contractVersion: REVIEW_CONTRACT_VERSION,
        id: randomUUID(),
        reviewId: updated.id,
        executionId: options.executionId !== undefined ? options.executionId : updated.currentExecutionId,
        type: options.eventType ?? 'review.transitioned',
        occurredAt: command.at,
        payload: options.eventPayload ?? {
          from: current.state,
          to: updated.state,
          reason: command.reason,
        },
      });

      return updated;
    });
  }

  createExecution(executionInput: ReviewExecution, event?: ExecutionEventInput): ReviewExecution {
    const parsed = ReviewExecutionSchema.safeParse(executionInput);
    if (!parsed.success) {
      throw new ReviewStorageError(
        'STORAGE_INVALID_INPUT',
        `Os dados da execução são inválidos: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
      );
    }
    const execution = parsed.data;

    return this.runInTransaction(() => {
      const review = this.getReviewById(execution.reviewId);
      if (!review) {
        throw new ReviewStorageError('STORAGE_NOT_FOUND', `Review ${execution.reviewId} não encontrado para criar execução.`);
      }

      this.insertExecutionRow(execution);
      this.db.prepare('UPDATE reviews SET current_execution_id = ? WHERE id = ?').run(execution.id, review.id);

      if (event) {
        this.insertEventRow({
          contractVersion: REVIEW_CONTRACT_VERSION,
          id: randomUUID(),
          reviewId: execution.reviewId,
          executionId: execution.id,
          type: event.type,
          occurredAt: event.occurredAt ?? execution.createdAt,
          payload: event.payload ?? { status: execution.process.status },
        });
      }

      return execution;
    });
  }

  updateExecution(executionInput: ReviewExecution, event?: ExecutionEventInput): ReviewExecution {
    const parsed = ReviewExecutionSchema.safeParse(executionInput);
    if (!parsed.success) {
      throw new ReviewStorageError(
        'STORAGE_INVALID_INPUT',
        `Os dados da execução são inválidos: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
      );
    }
    const execution = parsed.data;

    return this.runInTransaction(() => {
      const result = this.db.prepare(`
        UPDATE review_executions
        SET
          updated_at = ?,
          started_at = ?,
          finished_at = ?,
          process_status = ?,
          process_json = ?
        WHERE id = ? AND review_id = ?
      `).run(
        execution.updatedAt,
        execution.startedAt,
        execution.finishedAt,
        execution.process.status,
        JSON.stringify(execution.process),
        execution.id,
        execution.reviewId,
      );

      if (result.changes === 0) {
        throw new ReviewStorageError('STORAGE_NOT_FOUND', `Execução ${execution.id} não encontrada para o review ${execution.reviewId}.`);
      }

      if (event) {
        this.insertEventRow({
          contractVersion: REVIEW_CONTRACT_VERSION,
          id: randomUUID(),
          reviewId: execution.reviewId,
          executionId: execution.id,
          type: event.type,
          occurredAt: event.occurredAt ?? execution.updatedAt,
          payload: event.payload ?? { process: execution.process },
        });
      }

      return execution;
    });
  }

  getExecutionById(id: string): ReviewExecution | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id, review_id, contract_version, created_at, updated_at, started_at, finished_at, process_json
      FROM review_executions
      WHERE id = ?
    `).get(id) as ExecutionRow | undefined;

    return row ? rowToExecution(row) : null;
  }

  listExecutionsByReviewId(reviewId: string): ReviewExecution[] {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT id, review_id, contract_version, created_at, updated_at, started_at, finished_at, process_json
      FROM review_executions
      WHERE review_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(reviewId) as unknown as ExecutionRow[];

    return rows.map(rowToExecution);
  }

  appendEvent(eventInput: Omit<ReviewEvent, 'sequence'>): ReviewEvent {
    return this.runInTransaction(() => this.insertEventRow(eventInput));
  }

  listEventsByReviewId(reviewId: string): ReviewEvent[] {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT id, review_id, execution_id, sequence, type, occurred_at, payload_json
      FROM review_events
      WHERE review_id = ?
      ORDER BY sequence ASC
    `).all(reviewId) as unknown as EventRow[];

    return rows.map(rowToEvent);
  }

  getNextArtifactVersion(reviewId: string, executionId: string, kind: ReviewArtifactKind): number {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(version), 0) AS maxVersion
      FROM review_artifacts
      WHERE review_id = ? AND execution_id = ? AND kind = ?
    `).get(reviewId, executionId, kind) as { maxVersion: number };
    return row.maxVersion + 1;
  }

  saveArtifact(artifact: ReviewArtifact, event?: ExecutionEventInput): ReviewArtifact {
    return this.runInTransaction(() => {
      const saved = this.upsertArtifactRow(artifact);
      if (event) {
        this.insertEventRow({
          contractVersion: REVIEW_CONTRACT_VERSION,
          id: randomUUID(),
          reviewId: saved.reviewId,
          executionId: saved.executionId,
          type: event.type,
          occurredAt: event.occurredAt ?? saved.updatedAt,
          payload: event.payload ?? {
            artifactId: saved.id,
            kind: saved.kind,
            path: saved.path,
            version: saved.version,
            status: saved.status,
          },
        });
      }
      return saved;
    });
  }

  saveArtifacts(artifacts: readonly ReviewArtifact[], event?: ExecutionEventInput): ReviewArtifact[] {
    return this.runInTransaction(() => {
      const saved = artifacts.map(artifact => this.upsertArtifactRow(artifact));
      if (event && saved.length > 0) {
        const first = saved[0];
        if (first) {
          this.insertEventRow({
            contractVersion: REVIEW_CONTRACT_VERSION,
            id: randomUUID(),
            reviewId: first.reviewId,
            executionId: first.executionId,
            type: event.type,
            occurredAt: event.occurredAt ?? first.updatedAt,
            payload: event.payload ?? {
              artifacts: saved.map(item => ({
                id: item.id,
                kind: item.kind,
                path: item.path,
                version: item.version,
                status: item.status,
              })),
            },
          });
        }
      }
      return saved;
    });
  }

  saveArtifactsAndFailReview(
    reviewId: string,
    executionId: string,
    artifacts: readonly ReviewArtifact[],
    error: ReviewError,
    at: string,
    reason: string,
  ): { review: Review; artifacts: ReviewArtifact[] } {
    return this.runInTransaction(() => {
      const current = this.getReviewById(reviewId);
      if (!current) {
        throw new ReviewStorageError('STORAGE_NOT_FOUND', `Review ${reviewId} não encontrado.`);
      }

      const savedArtifacts = artifacts.map(artifact => this.upsertArtifactRow(artifact));

      let nextReview = current;
      if (!isFinalReviewState(current.state)) {
        nextReview = transitionReview(current, {
          to: 'failed',
          at,
          reason,
          error,
        });

        this.db.prepare(`
          UPDATE reviews
          SET state = ?, updated_at = ?, finished_at = ?, current_execution_id = ?,
              transitions_json = ?, result_json = ?, error_json = ?
          WHERE id = ?
        `).run(
          nextReview.state,
          nextReview.updatedAt,
          nextReview.finishedAt,
          nextReview.currentExecutionId,
          JSON.stringify(nextReview.transitions),
          nextReview.result === null ? null : JSON.stringify(nextReview.result),
          nextReview.error === null ? null : JSON.stringify(nextReview.error),
          nextReview.id,
        );
      }

      this.insertEventRow({
        contractVersion: REVIEW_CONTRACT_VERSION,
        id: randomUUID(),
        reviewId,
        executionId,
        type: 'review_artifact_creation_failed',
        occurredAt: at,
        payload: {
          reason,
          error,
          artifacts: savedArtifacts.map(item => ({
            id: item.id,
            kind: item.kind,
            path: item.path,
            version: item.version,
            status: item.status,
          })),
        },
      });

      return { review: nextReview, artifacts: savedArtifacts };
    });
  }

  listArtifactsByReviewId(reviewId: string, executionId?: string): ReviewArtifact[] {
    this.ensureOpen();
    const rows = (
      executionId !== undefined
        ? this.db.prepare(`
            SELECT id, review_id, execution_id, contract_version, kind, format, path, version, status, created_at, updated_at, error_json
            FROM review_artifacts
            WHERE review_id = ? AND execution_id = ?
            ORDER BY created_at ASC, version ASC, id ASC
          `).all(reviewId, executionId)
        : this.db.prepare(`
            SELECT id, review_id, execution_id, contract_version, kind, format, path, version, status, created_at, updated_at, error_json
            FROM review_artifacts
            WHERE review_id = ?
            ORDER BY created_at ASC, version ASC, id ASC
          `).all(reviewId)
    ) as unknown as ArtifactRow[];

    return rows.map(rowToArtifact);
  }

  getAppliedMigrations(): AppliedMigration[] {
    this.ensureOpen();
    return this.db
      .prepare('SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version ASC')
      .all() as unknown as AppliedMigration[];
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new ReviewStorageError('STORAGE_CONNECTION_FAILED', 'O repositório local de reviews já foi encerrado.');
    }
  }

  private insertExecutionRow(execution: ReviewExecution): void {
    try {
      this.db.prepare(`
        INSERT INTO review_executions (
          id, review_id, contract_version, created_at, updated_at,
          started_at, finished_at, process_status, process_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        execution.id,
        execution.reviewId,
        execution.contractVersion,
        execution.createdAt,
        execution.updatedAt,
        execution.startedAt,
        execution.finishedAt,
        execution.process.status,
        JSON.stringify(execution.process),
      );
    } catch (error) {
      if (isConstraintError(error)) {
        throw new ReviewStorageError('STORAGE_CONFLICT', `Já existe uma execução cadastrada com o ID ${execution.id}.`, { cause: error });
      }
      throw error;
    }
  }

  private insertEventRow(eventInput: Omit<ReviewEvent, 'sequence'>): ReviewEvent {
    const reviewExists = this.db.prepare('SELECT 1 FROM reviews WHERE id = ?').get(eventInput.reviewId);
    if (!reviewExists) {
      throw new ReviewStorageError('STORAGE_NOT_FOUND', `Review ${eventInput.reviewId} não encontrado para registrar evento.`);
    }

    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS maxSeq FROM review_events WHERE review_id = ?')
      .get(eventInput.reviewId) as { maxSeq: number };
    const sequence = row.maxSeq + 1;

    const parsed = ReviewEventSchema.safeParse({ ...eventInput, sequence });
    if (!parsed.success) {
      throw new ReviewStorageError(
        'STORAGE_INVALID_INPUT',
        `Os dados do evento são inválidos: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
      );
    }
    const event = parsed.data;

    try {
      this.db.prepare(`
        INSERT INTO review_events (id, review_id, execution_id, sequence, type, occurred_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.reviewId,
        event.executionId,
        event.sequence,
        event.type,
        event.occurredAt,
        JSON.stringify(event.payload),
      );
    } catch (error) {
      if (isConstraintError(error)) {
        throw new ReviewStorageError('STORAGE_CONFLICT', `Conflito ao registrar evento ${event.id}.`, { cause: error });
      }
      throw error;
    }

    return event;
  }

  private upsertArtifactRow(artifactInput: ReviewArtifact): ReviewArtifact {
    const parsed = ReviewArtifactSchema.safeParse(artifactInput);
    if (!parsed.success) {
      throw new ReviewStorageError(
        'STORAGE_INVALID_INPUT',
        `Os dados do artefato são inválidos: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
      );
    }
    const artifact = parsed.data;

    const executionRow = this.db
      .prepare('SELECT review_id FROM review_executions WHERE id = ?')
      .get(artifact.executionId) as { review_id: string } | undefined;

    if (!executionRow) {
      throw new ReviewStorageError(
        'STORAGE_NOT_FOUND',
        `Execução ${artifact.executionId} não encontrada para associar o artefato.`,
      );
    }
    if (executionRow.review_id !== artifact.reviewId) {
      throw new ReviewStorageError(
        'STORAGE_CONFLICT',
        `A execução ${artifact.executionId} não pertence ao review ${artifact.reviewId}.`,
      );
    }

    try {
      this.db.prepare(`
        INSERT INTO review_artifacts (
          id, review_id, execution_id, contract_version, kind, format, path, version,
          status, created_at, updated_at, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          error_json = excluded.error_json
      `).run(
        artifact.id,
        artifact.reviewId,
        artifact.executionId,
        artifact.contractVersion,
        artifact.kind,
        artifact.format,
        artifact.path,
        artifact.version,
        artifact.status,
        artifact.createdAt,
        artifact.updatedAt,
        artifact.error === null ? null : JSON.stringify(artifact.error),
      );
    } catch (error) {
      if (isConstraintError(error)) {
        throw new ReviewStorageError(
          'STORAGE_CONFLICT',
          `Já existe um artefato ${artifact.kind} v${artifact.version} registrado para a execução ${artifact.executionId}.`,
          { cause: error },
        );
      }
      throw error;
    }

    return artifact;
  }
}
