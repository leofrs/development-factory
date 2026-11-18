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
