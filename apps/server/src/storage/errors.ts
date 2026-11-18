export type ReviewStorageErrorCode =
  | 'STORAGE_CONFIGURATION_ERROR'
  | 'STORAGE_CONNECTION_FAILED'
  | 'STORAGE_MIGRATION_FAILED'
  | 'STORAGE_CONFLICT'
  | 'STORAGE_NOT_FOUND'
  | 'STORAGE_CORRUPTED_DATA'
  | 'STORAGE_INVALID_INPUT';

/** Erro tipado da camada de persistência local com código estável e mensagem em português. */
export class ReviewStorageError extends Error {
  constructor(
    public readonly code: ReviewStorageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReviewStorageError';
  }
}
