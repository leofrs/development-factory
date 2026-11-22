import type { DatabaseSync } from 'node:sqlite';
import { ReviewStorageError } from './errors.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: DatabaseSync): void;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
}

export const REVIEW_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_review_storage',
    up(db) {
      db.exec(`
        CREATE TABLE reviews (
          id TEXT PRIMARY KEY,
          contract_version INTEGER NOT NULL,
          target_type TEXT NOT NULL,
          target_identifier TEXT NOT NULL,
          target_repo_path TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          current_execution_id TEXT,
          transitions_json TEXT NOT NULL,
          result_json TEXT,
          error_json TEXT
        ) STRICT;

        CREATE INDEX idx_reviews_state_updated ON reviews (state, updated_at DESC);
        CREATE INDEX idx_reviews_repo_path ON reviews (target_repo_path, created_at DESC);

        CREATE TABLE review_executions (
          id TEXT PRIMARY KEY,
          review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE RESTRICT,
          contract_version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          process_status TEXT NOT NULL,
          process_json TEXT NOT NULL
        ) STRICT;

        CREATE INDEX idx_review_executions_review_id ON review_executions (review_id, created_at DESC);

        CREATE TABLE review_events (
          id TEXT PRIMARY KEY,
          review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE RESTRICT,
          execution_id TEXT REFERENCES review_executions(id) ON DELETE RESTRICT,
          sequence INTEGER NOT NULL,
          type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE (review_id, sequence)
        ) STRICT;

        CREATE INDEX idx_review_events_review_seq ON review_events (review_id, sequence ASC);
      `);
    },
  },
  {
    version: 2,
    name: 'add_review_idempotency_keys',
    up(db) {
      db.exec(`
        CREATE TABLE review_idempotency_keys (
          idempotency_key TEXT PRIMARY KEY,
          review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE RESTRICT,
          request_fingerprint TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE UNIQUE INDEX idx_review_idempotency_review_id ON review_idempotency_keys (review_id);
      `);
    },
  },
  {
    version: 3,
    name: 'add_review_artifacts',
    up(db) {
      db.exec(`
        CREATE TABLE review_artifacts (
          id TEXT PRIMARY KEY,
          review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE RESTRICT,
          execution_id TEXT NOT NULL REFERENCES review_executions(id) ON DELETE RESTRICT,
          contract_version INTEGER NOT NULL,
          kind TEXT NOT NULL,
          format TEXT NOT NULL,
          path TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          error_json TEXT,
          UNIQUE (review_id, execution_id, kind, version)
        ) STRICT;

        CREATE INDEX idx_review_artifacts_review_exec ON review_artifacts (review_id, execution_id, kind, version DESC);
        CREATE INDEX idx_review_artifacts_path ON review_artifacts (path);
      `);
    },
  },
  {
    version: 4,
    name: 'add_factory_flows',
    up(db) {
      db.exec(`
        CREATE TABLE factory_flows (
          id TEXT PRIMARY KEY,
          contract_version INTEGER NOT NULL,
          title TEXT NOT NULL,
          input_type TEXT NOT NULL,
          target_value TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          state TEXT NOT NULL,
          current_stage TEXT NOT NULL,
          current_session_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          transitions_json TEXT NOT NULL,
          error_json TEXT
        ) STRICT;

        CREATE INDEX idx_factory_flows_state_updated ON factory_flows (state, updated_at DESC);
        CREATE INDEX idx_factory_flows_repo_path ON factory_flows (repo_path, created_at DESC);
        CREATE INDEX idx_factory_flows_updated ON factory_flows (updated_at DESC);

        CREATE TABLE factory_flow_stages (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL REFERENCES factory_flows(id) ON DELETE RESTRICT,
          contract_version INTEGER NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL,
          session_id TEXT,
          report_path TEXT,
          session_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          error_json TEXT,
          UNIQUE (flow_id, name)
        ) STRICT;

        CREATE INDEX idx_factory_flow_stages_flow_id ON factory_flow_stages (flow_id);
        CREATE INDEX idx_factory_flow_stages_session_id ON factory_flow_stages (session_id);

        CREATE TABLE factory_flow_artifacts (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL REFERENCES factory_flows(id) ON DELETE RESTRICT,
          contract_version INTEGER NOT NULL,
          stage TEXT NOT NULL,
          session_id TEXT,
          kind TEXT NOT NULL,
          format TEXT NOT NULL,
          path TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          error_json TEXT
        ) STRICT;

        CREATE INDEX idx_factory_flow_artifacts_flow_stage ON factory_flow_artifacts (flow_id, stage, created_at DESC);
        CREATE INDEX idx_factory_flow_artifacts_path ON factory_flow_artifacts (path);

        CREATE TABLE factory_flow_idempotency_keys (
          idempotency_key TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL REFERENCES factory_flows(id) ON DELETE RESTRICT,
          request_fingerprint TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE UNIQUE INDEX idx_factory_flow_idempotency_flow_id ON factory_flow_idempotency_keys (flow_id);
      `);
    },
  },
  {
    version: 5,
    name: 'add_factory_development_approved_notes',
    up(db) {
      db.exec('ALTER TABLE factory_flow_stages ADD COLUMN approved_notes TEXT;');
    },
  },
  {
    version: 6,
    name: 'add_factory_flow_loop_iterations',
    up(db) {
      db.exec(`
        ALTER TABLE factory_flows ADD COLUMN iteration INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE factory_flows ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 3;
        ALTER TABLE factory_flows ADD COLUMN last_review_verdict TEXT;
        ALTER TABLE factory_flows ADD COLUMN loop_paused_reason TEXT;
        ALTER TABLE factory_flow_artifacts ADD COLUMN iteration INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 7,
    name: 'add_factory_worktree_and_checkpoints',
    up(db) {
      const existingFlowColumns = new Set(
        (db.prepare('PRAGMA table_info(factory_flows)').all() as Array<{ name: string }>).map(
          column => column.name,
        ),
      );
      if (!existingFlowColumns.has('worktree_path')) {
        db.exec('ALTER TABLE factory_flows ADD COLUMN worktree_path TEXT;');
      }
      if (!existingFlowColumns.has('branch_name')) {
        db.exec('ALTER TABLE factory_flows ADD COLUMN branch_name TEXT;');
      }
      if (!existingFlowColumns.has('base_branch')) {
        db.exec('ALTER TABLE factory_flows ADD COLUMN base_branch TEXT;');
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS factory_flow_checkpoints (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL REFERENCES factory_flows(id) ON DELETE RESTRICT,
          contract_version INTEGER NOT NULL,
          stage TEXT NOT NULL,
          iteration INTEGER NOT NULL DEFAULT 0,
          commit_sha TEXT NOT NULL,
          branch_name TEXT,
          session_id TEXT,
          message TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_factory_flow_checkpoints_flow_stage_iter
          ON factory_flow_checkpoints (flow_id, stage, iteration DESC, created_at DESC);
      `);
    },
  },
  {
    version: 8,
    name: 'add_factory_planning_approval',
    up(db) {
      const existingFlowColumns = new Set(
        (db.prepare('PRAGMA table_info(factory_flows)').all() as Array<{ name: string }>).map(
          column => column.name,
        ),
      );
      if (!existingFlowColumns.has('planning_approval_json')) {
        db.exec('ALTER TABLE factory_flows ADD COLUMN planning_approval_json TEXT;');
      }
    },
  },
  {
    version: 9,
    name: 'add_factory_review_triage',
    up(db) {
      const existingFlowColumns = new Set(
        (db.prepare('PRAGMA table_info(factory_flows)').all() as Array<{ name: string }>).map(
          column => column.name,
        ),
      );
      if (!existingFlowColumns.has('review_triage_json')) {
        db.exec('ALTER TABLE factory_flows ADD COLUMN review_triage_json TEXT;');
      }
    },
  },
  {
    version: 10,
    name: 'add_factory_pr_review',
    up(db) {
      const existingFlowColumns = new Set(
        (db.prepare('PRAGMA table_info(factory_flows)').all() as Array<{ name: string }>).map(
          column => column.name,
        ),
      );
      if (!existingFlowColumns.has('pr_review_json')) {
        db.exec('ALTER TABLE factory_flows ADD COLUMN pr_review_json TEXT;');
      }
    },
  },
  {
    version: 11,
    name: 'add_factory_pr_publication',
    up(db) {
      const existingFlowColumns = new Set(
        (db.prepare('PRAGMA table_info(factory_flows)').all() as Array<{ name: string }>).map(
          column => column.name,
        ),
      );
      if (!existingFlowColumns.has('pr_publication_json')) {
        db.exec('ALTER TABLE factory_flows ADD COLUMN pr_publication_json TEXT;');
      }
    },
  },
];

function validateMigrations(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new ReviewStorageError(
        'STORAGE_MIGRATION_FAILED',
        `Definição de migrations inválida na versão ${migration.version} (${migration.name}): as versões devem ser inteiros positivos estritamente crescentes.`,
      );
    }
    previous = migration.version;
  }
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Ignora caso a transação já tenha sido revertida pelo SQLite.
  }
}

/**
 * Executa migrations versionadas em transações isoladas.
 * Em caso de falha, reverte apenas a migration atual sem apagar dados existentes.
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = REVIEW_MIGRATIONS,
): AppliedMigration[] {
  validateMigrations(migrations);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
  } catch (error) {
    throw new ReviewStorageError(
      'STORAGE_MIGRATION_FAILED',
      'Não foi possível inicializar a tabela de controle de migrations.',
      { cause: error },
    );
  }

  const appliedRows = db
    .prepare('SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version ASC')
    .all() as Array<{ version: number; name: string; appliedAt: string }>;

  const knownByVersion = new Map(migrations.map(migration => [migration.version, migration]));
  for (const row of appliedRows) {
    const known = knownByVersion.get(row.version);
    if (!known) {
      throw new ReviewStorageError(
        'STORAGE_MIGRATION_FAILED',
        `O banco local possui a migration desconhecida v${row.version} (${row.name}). Atualize o servidor antes de iniciar.`,
      );
    }
    if (known.name !== row.name) {
      throw new ReviewStorageError(
        'STORAGE_MIGRATION_FAILED',
        `Divergência na migration v${row.version}: esperado "${known.name}", encontrado "${row.name}".`,
      );
    }
  }

  const appliedVersions = new Set(appliedRows.map(row => row.version));
  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const newlyApplied: AppliedMigration[] = [];
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const appliedAt = new Date().toISOString();
    try {
      db.exec('BEGIN IMMEDIATE');
      migration.up(db);
      insertMigration.run(migration.version, migration.name, appliedAt);
      db.exec('COMMIT');
      newlyApplied.push({ version: migration.version, name: migration.name, appliedAt });
    } catch (error) {
      rollbackQuietly(db);
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReviewStorageError(
        'STORAGE_MIGRATION_FAILED',
        `Falha ao aplicar migration v${migration.version} (${migration.name}): ${detail}`,
        { cause: error },
      );
    }
  }

  return [...appliedRows, ...newlyApplied];
}
