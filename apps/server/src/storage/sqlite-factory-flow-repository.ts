import { DatabaseSync } from 'node:sqlite';
import {
  FACTORY_STAGE_ORDER,
  FactoryFlowArtifactSchema,
  FactoryFlowSchema,
  FactoryFlowStageSchema,
  returnFactoryFlowStage,
  transitionFactoryFlow,
  type FactoryFlow,
  type FactoryFlowArtifact,
  type FactoryFlowError,
  type FactoryFlowStage,
  type FactoryFlowState,
  type FactoryFlowTransitionCommand,
  type FactoryStageName,
  type FactoryStageState,
} from '@development-factory/shared';
import { resolveReviewDbPath } from './config.js';
import { ReviewStorageError } from './errors.js';
import { REVIEW_MIGRATIONS, runMigrations, type AppliedMigration, type Migration } from './migrations.js';
import type { IdempotencyOptions } from './sqlite-review-repository.js';

export interface FactoryFlowRepositoryOptions {
  readonly dbPath?: string;
  readonly migrations?: readonly Migration[];
}

export interface CreateFactoryFlowResult {
  readonly flow: FactoryFlow;
  readonly stages: FactoryFlowStage[];
}

export interface CreateFactoryFlowIdempotentlyResult extends CreateFactoryFlowResult {
  readonly replayed: boolean;
}

export interface ListFactoryFlowsFilter {
  readonly state?: FactoryFlowState;
  readonly stage?: FactoryStageName;
  readonly repoPath?: string;
  readonly limit?: number;
}

export interface SaveFactoryFlowTransitionOptions {
  readonly expectedUpdatedAt?: string;
  readonly direction?: 'forward' | 'return';
}

export interface UpdateFactoryStageInput {
  readonly state?: FactoryStageState;
  readonly sessionId?: string | null;
  readonly reportPath?: string | null;
  readonly sessionPath?: string | null;
  readonly approvedNotes?: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly error?: FactoryFlowError | null;
  readonly updatedAt: string;
}

export interface SaveFactoryArtifactOptions {
  readonly reportPath?: string;
  readonly sessionPath?: string;
}

interface FactoryFlowRow {
  id: string;
  contract_version: number;
  title: string;
  input_type: string;
  target_value: string;
  repo_path: string;
  state: string;
  current_stage: string;
  current_session_id: string | null;
  iteration: number;
  max_iterations: number;
  last_review_verdict: string | null;
  loop_paused_reason: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  transitions_json: string;
  error_json: string | null;
}

interface FactoryStageRow {
  id: string;
  flow_id: string;
  contract_version: number;
  name: string;
  state: string;
  session_id: string | null;
  report_path: string | null;
  session_path: string | null;
  approved_notes: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_json: string | null;
}

interface FactoryArtifactRow {
  id: string;
  flow_id: string;
  contract_version: number;
  stage: string;
  session_id: string | null;
  kind: string;
  format: string;
  path: string;
  status: string;
  iteration: number;
  created_at: string;
  updated_at: string;
  error_json: string | null;
}

const STAGE_ORDER_INDEX = new Map<FactoryStageName, number>(
  FACTORY_STAGE_ORDER.map((stage, index) => [stage, index]),
);

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

function rowToFlow(row: FactoryFlowRow): FactoryFlow {
  const parsed = FactoryFlowSchema.safeParse({
    contractVersion: row.contract_version,
    id: row.id,
    title: row.title,
    target: {
      contractVersion: row.contract_version,
      inputType: row.input_type,
      value: row.target_value,
      repoPath: row.repo_path,
    },
    state: row.state,
    currentStage: row.current_stage,
    currentSessionId: row.current_session_id,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    lastReviewVerdict: row.last_review_verdict,
    loopPausedReason: row.loop_paused_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    transitions: parseJson(row.transitions_json, `transições do fluxo ${row.id}`),
    error: row.error_json === null ? null : parseJson(row.error_json, `erro do fluxo ${row.id}`),
  });

  if (!parsed.success) {
    throw new ReviewStorageError(
      'STORAGE_CORRUPTED_DATA',
      `O registro do fluxo ${row.id} no banco local viola o contrato atual.`,
    );
  }
  return parsed.data;
}

function rowToStage(row: FactoryStageRow): FactoryFlowStage {
  const parsed = FactoryFlowStageSchema.safeParse({
    contractVersion: row.contract_version,
    id: row.id,
    flowId: row.flow_id,
    name: row.name,
    state: row.state,
    sessionId: row.session_id,
    reportPath: row.report_path,
    sessionPath: row.session_path,
    ...(row.approved_notes === null ? {} : { approvedNotes: row.approved_notes }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error_json === null ? null : parseJson(row.error_json, `erro da etapa ${row.id}`),
  });

  if (!parsed.success) {
    throw new ReviewStorageError(
      'STORAGE_CORRUPTED_DATA',
      `O registro da etapa ${row.id} no banco local viola o contrato atual.`,
    );
  }
  return parsed.data;
}

function rowToArtifact(row: FactoryArtifactRow): FactoryFlowArtifact {
  const parsed = FactoryFlowArtifactSchema.safeParse({
    contractVersion: row.contract_version,
    id: row.id,
    flowId: row.flow_id,
    stage: row.stage,
    sessionId: row.session_id,
    kind: row.kind,
    format: row.format,
    path: row.path,
    status: row.status,
    iteration: row.iteration,
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

function isFinalStageState(state: FactoryStageState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function flowStateToStageState(state: FactoryFlowState): FactoryStageState {
  return state === 'queued' ? 'pending' : state;
}

/**
 * Repositório transacional local para múltiplos fluxos da Factory em SQLite (`node:sqlite`).
 */
export class SqliteFactoryFlowRepository {
  private inTransaction = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    public readonly dbPath: string,
    private readonly db: DatabaseSync,
  ) {}

  static open(options: FactoryFlowRepositoryOptions = {}): SqliteFactoryFlowRepository {
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
      return new SqliteFactoryFlowRepository(dbPath, db);
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
        `Não foi possível abrir o banco local de fluxos em "${dbPath}": ${detail}`,
        { cause: error },
      );
    }
  }

  /** Serializa operações assíncronas de escrita no mesmo processo além do lock `BEGIN IMMEDIATE`. */
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

  createFlow(
    flowInput: FactoryFlow,
    stagesInput: readonly FactoryFlowStage[],
  ): CreateFactoryFlowResult {
    const parsedFlow = FactoryFlowSchema.safeParse(flowInput);
    if (!parsedFlow.success) {
      throw new ReviewStorageError(
        'STORAGE_INVALID_INPUT',
        `Os dados do fluxo são inválidos para persistência: ${parsedFlow.error.issues.map(issue => issue.message).join('; ')}`,
      );
    }

    const parsedStages = stagesInput.map(stage => {
      const parsed = FactoryFlowStageSchema.safeParse(stage);
      if (!parsed.success) {
        throw new ReviewStorageError(
          'STORAGE_INVALID_INPUT',
          `Os dados da etapa do fluxo são inválidos para persistência: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
        );
      }
      if (parsed.data.flowId !== parsedFlow.data.id) {
        throw new ReviewStorageError(
          'STORAGE_INVALID_INPUT',
          'Todas as etapas devem pertencer ao fluxo informado.',
        );
      }
      return parsed.data;
    });

    return this.runInTransaction(() => {
      try {
        this.insertFlowRow(parsedFlow.data);
        for (const stage of parsedStages) {
          this.insertStageRow(stage);
        }
      } catch (error) {
        if (isConstraintError(error)) {
          throw new ReviewStorageError(
            'STORAGE_CONFLICT',
            `Já existe um fluxo com o identificador ${parsedFlow.data.id}.`,
            { cause: error },
          );
        }
        throw error;
      }

      return {
        flow: parsedFlow.data,
        stages: this.listStagesByFlowId(parsedFlow.data.id),
      };
    });
  }

  createFlowIdempotently(
    flowInput: FactoryFlow,
    stagesInput: readonly FactoryFlowStage[],
    idempotency?: IdempotencyOptions,
  ): CreateFactoryFlowIdempotentlyResult {
    if (!idempotency) {
      const created = this.createFlow(flowInput, stagesInput);
      return { ...created, replayed: false };
    }

    const key = idempotency.key.trim();
    if (key.length === 0) {
      throw new ReviewStorageError(
        'STORAGE_INVALID_INPUT',
        'A chave de idempotência não pode ser vazia.',
      );
    }

    return this.runInTransaction(() => {
      const existing = this.db
        .prepare(
          'SELECT flow_id, request_fingerprint FROM factory_flow_idempotency_keys WHERE idempotency_key = ?',
        )
        .get(key) as { flow_id: string; request_fingerprint: string } | undefined;

      if (existing) {
        if (existing.request_fingerprint !== idempotency.fingerprint) {
          throw new ReviewStorageError(
            'STORAGE_CONFLICT',
            'A chave de idempotência já foi utilizada com outro conteúdo de fluxo.',
          );
        }
        const flow = this.getFlowById(existing.flow_id);
        if (!flow) {
          throw new ReviewStorageError(
            'STORAGE_CORRUPTED_DATA',
            `A chave de idempotência aponta para o fluxo inexistente ${existing.flow_id}.`,
          );
        }
        return {
          flow,
          stages: this.listStagesByFlowId(flow.id),
          replayed: true,
        };
      }

      const created = this.createFlow(flowInput, stagesInput);
      this.db
        .prepare(
          `INSERT INTO factory_flow_idempotency_keys (
            idempotency_key,
            flow_id,
            request_fingerprint,
            created_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(key, created.flow.id, idempotency.fingerprint, created.flow.createdAt);

      return { ...created, replayed: false };
    });
  }

  getFlowById(id: string): FactoryFlow | null {
    this.ensureOpen();
    const row = this.db
      .prepare('SELECT * FROM factory_flows WHERE id = ?')
      .get(id) as FactoryFlowRow | undefined;
    return row ? rowToFlow(row) : null;
  }

  listFlows(filter: ListFactoryFlowsFilter = {}): FactoryFlow[] {
    this.ensureOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.state !== undefined) {
      clauses.push('state = ?');
      params.push(filter.state);
    }
    if (filter.stage !== undefined) {
      clauses.push('current_stage = ?');
      params.push(filter.stage);
    }
    if (filter.repoPath !== undefined) {
      clauses.push('repo_path = ?');
      params.push(filter.repoPath);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitClause = filter.limit !== undefined ? 'LIMIT ?' : '';
    if (filter.limit !== undefined) {
      params.push(filter.limit);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM factory_flows ${whereClause} ORDER BY updated_at DESC, created_at DESC ${limitClause}`,
      )
      .all(...params) as unknown as FactoryFlowRow[];

    return rows.map(rowToFlow);
  }

  listStagesByFlowId(flowId: string): FactoryFlowStage[] {
    this.ensureOpen();
    const rows = this.db
      .prepare('SELECT * FROM factory_flow_stages WHERE flow_id = ?')
      .all(flowId) as unknown as FactoryStageRow[];

    return rows
      .map(rowToStage)
      .sort((a, b) => (STAGE_ORDER_INDEX.get(a.name) ?? 0) - (STAGE_ORDER_INDEX.get(b.name) ?? 0));
  }

  getStage(flowId: string, stageName: FactoryStageName): FactoryFlowStage | null {
    this.ensureOpen();
    const row = this.db
      .prepare('SELECT * FROM factory_flow_stages WHERE flow_id = ? AND name = ?')
      .get(flowId, stageName) as FactoryStageRow | undefined;
    return row ? rowToStage(row) : null;
  }

  saveFlowTransition(
    flowId: string,
    command: FactoryFlowTransitionCommand,
    options: SaveFactoryFlowTransitionOptions = {},
  ): CreateFactoryFlowResult {
    return this.runInTransaction(() => {
      const current = this.getFlowById(flowId);
      if (!current) {
        throw new ReviewStorageError('STORAGE_NOT_FOUND', `Fluxo ${flowId} não encontrado.`);
      }

      if (options.expectedUpdatedAt !== undefined && current.updatedAt !== options.expectedUpdatedAt) {
        throw new ReviewStorageError(
          'STORAGE_CONFLICT',
          `O fluxo ${flowId} foi alterado por outra operação concorrente.`,
        );
      }

      const updated =
        options.direction === 'return'
          ? returnFactoryFlowStage(current, command)
          : transitionFactoryFlow(current, command);

      this.db
        .prepare(
          `UPDATE factory_flows
           SET state = ?,
               current_stage = ?,
               current_session_id = ?,
               iteration = ?,
               max_iterations = ?,
               last_review_verdict = ?,
               loop_paused_reason = ?,
               updated_at = ?,
               finished_at = ?,
               transitions_json = ?,
               error_json = ?
           WHERE id = ?`,
        )
        .run(
          updated.state,
          updated.currentStage,
          updated.currentSessionId,
          updated.iteration,
          updated.maxIterations,
          updated.lastReviewVerdict,
          updated.loopPausedReason,
          updated.updatedAt,
          updated.finishedAt,
          JSON.stringify(updated.transitions),
          updated.error ? JSON.stringify(updated.error) : null,
          updated.id,
        );

      this.syncStagesForTransition(current, updated, command);

      return {
        flow: updated,
        stages: this.listStagesByFlowId(updated.id),
      };
    });
  }

  updateFlowSession(flowId: string, sessionId: string | null, updatedAt: string): FactoryFlow {
    return this.runInTransaction(() => {
      const current = this.getFlowById(flowId);
      if (!current) {
        throw new ReviewStorageError('STORAGE_NOT_FOUND', `Fluxo ${flowId} não encontrado.`);
      }

      const next = FactoryFlowSchema.safeParse({
        ...current,
        currentSessionId: sessionId,
        updatedAt,
      });
      if (!next.success) {
        throw new ReviewStorageError(
          'STORAGE_INVALID_INPUT',
          `Não foi possível atualizar a sessão do fluxo: ${next.error.issues.map(issue => issue.message).join('; ')}`,
        );
      }

      this.db
        .prepare('UPDATE factory_flows SET current_session_id = ?, updated_at = ? WHERE id = ?')
        .run(sessionId, updatedAt, flowId);

      const currentStage = this.getStage(flowId, current.currentStage);
      if (currentStage) {
        this.updateStage(flowId, current.currentStage, { sessionId, updatedAt });
      }

      return next.data;
    });
  }

  updateStage(
    flowId: string,
    stageName: FactoryStageName,
    patch: UpdateFactoryStageInput,
  ): FactoryFlowStage {
    return this.runInTransaction(() => {
      const existing = this.getStage(flowId, stageName);
      if (!existing) {
        throw new ReviewStorageError(
          'STORAGE_NOT_FOUND',
          `Etapa ${stageName} do fluxo ${flowId} não encontrada.`,
        );
      }

      const nextCandidate = {
        ...existing,
        state: patch.state ?? existing.state,
        sessionId: patch.sessionId !== undefined ? patch.sessionId : existing.sessionId,
        reportPath: patch.reportPath !== undefined ? patch.reportPath : existing.reportPath,
        sessionPath: patch.sessionPath !== undefined ? patch.sessionPath : existing.sessionPath,
        approvedNotes: patch.approvedNotes ?? existing.approvedNotes,
        startedAt: patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
        finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : existing.finishedAt,
        error: patch.error !== undefined ? patch.error : existing.error,
        updatedAt: patch.updatedAt,
      };

      const parsed = FactoryFlowStageSchema.safeParse(nextCandidate);
      if (!parsed.success) {
        throw new ReviewStorageError(
          'STORAGE_INVALID_INPUT',
          `Atualização inválida para a etapa ${stageName}: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
        );
      }

      this.db
        .prepare(
          `UPDATE factory_flow_stages
           SET state = ?,
               session_id = ?,
               report_path = ?,
               session_path = ?,
               approved_notes = ?,
               updated_at = ?,
               started_at = ?,
               finished_at = ?,
               error_json = ?
           WHERE flow_id = ? AND name = ?`,
        )
        .run(
          parsed.data.state,
          parsed.data.sessionId,
          parsed.data.reportPath,
          parsed.data.sessionPath,
          parsed.data.approvedNotes ?? null,
          parsed.data.updatedAt,
          parsed.data.startedAt,
          parsed.data.finishedAt,
          parsed.data.error ? JSON.stringify(parsed.data.error) : null,
          flowId,
          stageName,
        );

      return parsed.data;
    });
  }

  saveArtifact(
    artifactInput: FactoryFlowArtifact,
    options: SaveFactoryArtifactOptions = {},
  ): FactoryFlowArtifact {
    const parsed = FactoryFlowArtifactSchema.safeParse(artifactInput);
    if (!parsed.success) {
      throw new ReviewStorageError(
        'STORAGE_INVALID_INPUT',
        `Os dados do artefato são inválidos para persistência: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
      );
    }

    return this.runInTransaction(() => {
      const flow = this.getFlowById(parsed.data.flowId);
      if (!flow) {
        throw new ReviewStorageError(
          'STORAGE_NOT_FOUND',
          `Fluxo ${parsed.data.flowId} não encontrado para registrar artefato.`,
        );
      }

      try {
        this.db
          .prepare(
            `INSERT INTO factory_flow_artifacts (
              id,
              flow_id,
              contract_version,
              stage,
              session_id,
              kind,
              format,
              path,
              status,
              iteration,
              created_at,
              updated_at,
              error_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.data.id,
            parsed.data.flowId,
            parsed.data.contractVersion,
            parsed.data.stage,
            parsed.data.sessionId,
            parsed.data.kind,
            parsed.data.format,
            parsed.data.path,
            parsed.data.status,
            parsed.data.iteration,
            parsed.data.createdAt,
            parsed.data.updatedAt,
            parsed.data.error ? JSON.stringify(parsed.data.error) : null,
          );
      } catch (error) {
        if (isConstraintError(error)) {
          throw new ReviewStorageError(
            'STORAGE_CONFLICT',
            `Já existe um artefato com o identificador ${parsed.data.id}.`,
            { cause: error },
          );
        }
        throw error;
      }

      const stage = this.getStage(parsed.data.flowId, parsed.data.stage);
      if (stage) {
        const inferredSessionPath =
          options.sessionPath ?? (parsed.data.kind === 'session_log' ? parsed.data.path : undefined);
        const inferredReportPath =
          options.reportPath ??
          (parsed.data.kind !== 'session_log' && parsed.data.kind !== 'patch'
            ? parsed.data.path
            : undefined);

        if (
          inferredSessionPath !== undefined ||
          inferredReportPath !== undefined ||
          (parsed.data.sessionId !== null && stage.sessionId === null)
        ) {
          this.updateStage(parsed.data.flowId, parsed.data.stage, {
            reportPath: inferredReportPath,
            sessionPath: inferredSessionPath,
            sessionId: stage.sessionId ?? parsed.data.sessionId,
            updatedAt: parsed.data.updatedAt,
          });
        }
      }

      return parsed.data;
    });
  }

  listArtifactsByFlowId(flowId: string, stage?: FactoryStageName): FactoryFlowArtifact[] {
    this.ensureOpen();
    const rows = stage
      ? (this.db
          .prepare(
            'SELECT * FROM factory_flow_artifacts WHERE flow_id = ? AND stage = ? ORDER BY created_at ASC, rowid ASC',
          )
          .all(flowId, stage) as unknown as FactoryArtifactRow[])
      : (this.db
          .prepare(
            'SELECT * FROM factory_flow_artifacts WHERE flow_id = ? ORDER BY created_at ASC, rowid ASC',
          )
          .all(flowId) as unknown as FactoryArtifactRow[]);

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

  private syncStagesForTransition(
    previousFlow: FactoryFlow,
    updatedFlow: FactoryFlow,
    command: FactoryFlowTransitionCommand,
  ): void {
    const prevIndex = STAGE_ORDER_INDEX.get(previousFlow.currentStage) ?? 0;
    const nextIndex = STAGE_ORDER_INDEX.get(updatedFlow.currentStage) ?? 0;
    if (nextIndex > prevIndex) {
      const prevStage = this.getStage(updatedFlow.id, previousFlow.currentStage);
      if (prevStage && !isFinalStageState(prevStage.state)) {
        this.updateStage(updatedFlow.id, previousFlow.currentStage, {
          state: 'completed',
          startedAt: prevStage.startedAt ?? command.at,
          finishedAt: command.at,
          updatedAt: command.at,
        });
      }
    } else if (nextIndex < prevIndex) {
      for (const stageName of FACTORY_STAGE_ORDER.slice(nextIndex + 1, prevIndex + 1)) {
        const stage = this.getStage(updatedFlow.id, stageName);
        if (stage) {
          this.updateStage(updatedFlow.id, stageName, {
            state: 'pending',
            sessionId: null,
            reportPath: null,
            sessionPath: null,
            startedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: command.at,
          });
        }
      }
    }

    const currentStage = this.getStage(updatedFlow.id, updatedFlow.currentStage);
    if (!currentStage) {
      return;
    }

    const nextStageState = flowStateToStageState(updatedFlow.state);
    const nextStartedAt =
      currentStage.startedAt ??
      (nextStageState === 'running' ||
      nextStageState === 'waiting_action' ||
      nextStageState === 'completed'
        ? command.at
        : null);
    const nextFinishedAt = isFinalStageState(nextStageState) ? command.at : null;
    const nextError =
      nextStageState === 'failed'
        ? (updatedFlow.error ?? currentStage.error)
        : nextIndex < prevIndex
          ? null
          : currentStage.error;

    this.updateStage(updatedFlow.id, updatedFlow.currentStage, {
      state: nextStageState,
      sessionId:
        command.currentSessionId !== undefined ? command.currentSessionId : updatedFlow.currentSessionId,
      startedAt: nextStartedAt,
      finishedAt: nextFinishedAt,
      error: nextError,
      updatedAt: command.at,
    });
  }

  private insertFlowRow(flow: FactoryFlow): void {
    this.db
      .prepare(
        `INSERT INTO factory_flows (
          id,
          contract_version,
          title,
          input_type,
          target_value,
          repo_path,
          state,
          current_stage,
          current_session_id,
          iteration,
          max_iterations,
          last_review_verdict,
          loop_paused_reason,
          created_at,
          updated_at,
          finished_at,
          transitions_json,
          error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        flow.id,
        flow.contractVersion,
        flow.title,
        flow.target.inputType,
        flow.target.value,
        flow.target.repoPath,
        flow.state,
        flow.currentStage,
        flow.currentSessionId,
        flow.iteration,
        flow.maxIterations,
        flow.lastReviewVerdict,
        flow.loopPausedReason,
        flow.createdAt,
        flow.updatedAt,
        flow.finishedAt,
        JSON.stringify(flow.transitions),
        flow.error ? JSON.stringify(flow.error) : null,
      );
  }

  private insertStageRow(stage: FactoryFlowStage): void {
    this.db
      .prepare(
        `INSERT INTO factory_flow_stages (
          id,
          flow_id,
          contract_version,
          name,
          state,
          session_id,
          report_path,
          session_path,
          created_at,
          updated_at,
          started_at,
          finished_at,
          error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stage.id,
        stage.flowId,
        stage.contractVersion,
        stage.name,
        stage.state,
        stage.sessionId,
        stage.reportPath,
        stage.sessionPath,
        stage.createdAt,
        stage.updatedAt,
        stage.startedAt,
        stage.finishedAt,
        stage.error ? JSON.stringify(stage.error) : null,
      );
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new ReviewStorageError(
        'STORAGE_CONNECTION_FAILED',
        'O repositório local de fluxos já foi encerrado.',
      );
    }
  }
}
