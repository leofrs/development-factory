import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { ReviewStorageError } from './errors.js';

const DEFAULT_APP_DIR = 'development-factory';
const DEFAULT_DB_FILENAME = 'reviews.db';

export function reviewDataDirectory(): string {
  const configured = process.env.XDG_DATA_HOME?.trim();
  const base = configured && isAbsolute(configured) && !configured.includes('\0')
    ? configured
    : join(homedir(), '.local', 'share');
  return join(base, DEFAULT_APP_DIR);
}

/**
 * Resolve o caminho padrão do banco SQLite fora de qualquer repositório analisado.
 * Usa `overridePath`, depois `REVIEW_DB_PATH` e, por padrão, `$XDG_DATA_HOME/development-factory/reviews.db`.
 */
export function resolveReviewDbPath(overridePath?: string): string {
  const configured = overridePath ?? process.env.REVIEW_DB_PATH?.trim();
  const resolved = configured && configured.length > 0
    ? configured
    : join(reviewDataDirectory(), DEFAULT_DB_FILENAME);

  if (resolved === ':memory:') {
    return resolved;
  }

  if (resolved.includes('\0') || !isAbsolute(resolved)) {
    throw new ReviewStorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'O caminho do banco de dados de reviews deve ser absoluto e válido no WSL.',
    );
  }

  try {
    mkdirSync(dirname(resolved), { recursive: true });
  } catch (error) {
    throw new ReviewStorageError(
      'STORAGE_CONFIGURATION_ERROR',
      `Não foi possível preparar o diretório de armazenamento local em "${dirname(resolved)}".`,
      { cause: error },
    );
  }

  return resolved;
}
