import { accessSync, chmodSync, constants, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Review, ReviewExecution } from '@development-factory/shared';
import { reviewDataDirectory } from './storage/config.js';

const applicationRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SAFE_FLOW_DIRECTORY_PATTERN = /^[a-zA-Z0-9_-]+$/;

export class ReviewDestinationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReviewDestinationError';
  }
}

/** Erro ao preparar ou validar o diretório externo gerenciado para artefatos da Factory. */
export class FactoryArtifactDestinationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FactoryArtifactDestinationError';
  }
}

export function defaultReviewReportDirectory(): string {
  return join(reviewDataDirectory(), 'reviews');
}

/** Retorna o diretório raiz padrão dos artefatos da Factory fora dos repositórios analisados. */
export function defaultFactoryArtifactsDirectory(): string {
  return join(reviewDataDirectory(), 'artifacts');
}

function canonicalPathAllowingMissing(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false })) {
    return realpathSync(path);
  }

  const parent = dirname(path);
  return join(canonicalPathAllowingMissing(parent), basename(path));
}

function isWithin(parent: string, path: string): boolean {
  const difference = relative(parent, path);
  return difference === '' ||
    (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

function repositoryRoot(repoPath: string): string {
  const selected = realpathSync(repoPath);
  let directory = selected;
  while (true) {
    const gitPath = join(directory, '.git');
    const gitEntry = lstatSync(gitPath, { throwIfNoEntry: false });
    if (gitEntry?.isFile() || (gitEntry?.isDirectory() &&
        lstatSync(join(gitPath, 'HEAD'), { throwIfNoEntry: false })?.isFile())) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return selected;
    }
    directory = parent;
  }
}

function assertExternalDestination(
  directory: string,
  repoPath: string,
  createError: () => Error = () =>
    new ReviewDestinationError(
      'Em “Salvar code review em”, escolha uma pasta fora do repositório analisado e do Development Factory.',
    ),
): void {
  if (isWithin(repositoryRoot(repoPath), directory) ||
      isWithin(realpathSync(applicationRoot), directory)) {
    throw createError();
  }
}

function ensureManagedDirectory(directory: string, enforcePermissions: boolean): void {
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new FactoryArtifactDestinationError(
        'O diretório de artefatos da Factory precisa ser um diretório real, sem links simbólicos.',
      );
    }
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (enforcePermissions) {
    chmodSync(directory, 0o700);
  }
}

/**
 * Resolve e prepara o diretório externo gerenciado para artefatos e registros de sessão da Factory,
 * garantindo isolamento fora do repositório, permissões `0o700` e proteção contra symlinks.
 */
export function resolveFactoryArtifactsDirectory(repoPath: string, flowId?: string): string {
  try {
    if (flowId !== undefined && !SAFE_FLOW_DIRECTORY_PATTERN.test(flowId)) {
      throw new FactoryArtifactDestinationError(
        'Identificador de fluxo inválido para o diretório de artefatos.',
      );
    }

    const dataRoot = reviewDataDirectory();
    const artifactsRoot = defaultFactoryArtifactsDirectory();
    const targetDirectory = flowId ? join(artifactsRoot, flowId) : artifactsRoot;

    if (!isAbsolute(targetDirectory) || targetDirectory.includes('\0')) {
      throw new FactoryArtifactDestinationError(
        'O diretório de artefatos da Factory precisa ser um caminho absoluto válido no WSL.',
      );
    }

    const canonicalTarget = canonicalPathAllowingMissing(resolve(targetDirectory));
    assertExternalDestination(
      canonicalTarget,
      repoPath,
      () =>
        new FactoryArtifactDestinationError(
          'O diretório de artefatos da Factory precisa ficar fora do repositório analisado e do Development Factory.',
        ),
    );

    ensureManagedDirectory(dataRoot, false);
    ensureManagedDirectory(artifactsRoot, true);
    if (flowId) {
      ensureManagedDirectory(targetDirectory, true);
    }

    const resolved = realpathSync(targetDirectory);
    assertExternalDestination(
      resolved,
      repoPath,
      () =>
        new FactoryArtifactDestinationError(
          'O diretório de artefatos da Factory precisa ficar fora do repositório analisado e do Development Factory.',
        ),
    );
    if (!statSync(resolved).isDirectory()) {
      throw new FactoryArtifactDestinationError(
        'O diretório de artefatos da Factory precisa ser uma pasta válida.',
      );
    }
    accessSync(resolved, constants.W_OK | constants.X_OK);
    return resolved;
  } catch (error) {
    if (error instanceof FactoryArtifactDestinationError) {
      throw error;
    }
    throw new FactoryArtifactDestinationError(
      'Não foi possível preparar o diretório externo de artefatos da Factory.',
      { cause: error },
    );
  }
}

export function resolveReviewReportDirectory(repoPath: string, selectedDirectory?: string): string {
  try {
    const requested = selectedDirectory ?? defaultReviewReportDirectory();
    if (!isAbsolute(requested) || requested.includes('\0')) {
      throw new ReviewDestinationError('Use um caminho absoluto do WSL em “Salvar code review em”.');
    }

    if (selectedDirectory === undefined) {
      const directory = canonicalPathAllowingMissing(resolve(requested));
      assertExternalDestination(directory, repoPath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    const directory = realpathSync(requested);
    assertExternalDestination(directory, repoPath);
    if (!statSync(directory).isDirectory()) {
      throw new ReviewDestinationError('Selecione uma pasta em “Salvar code review em”.');
    }
    accessSync(directory, constants.W_OK | constants.X_OK);
    return directory;
  } catch (error) {
    if (error instanceof ReviewDestinationError) {
      throw error;
    }
    throw new ReviewDestinationError(
      'Verifique se a pasta indicada em “Salvar code review em” existe e permite gravação.',
      { cause: error },
    );
  }
}

export function reviewReportPath(
  directory: string,
  review: Review,
  execution: ReviewExecution,
): string {
  const { type, identifier } = review.target;
  const slug = identifier.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'review';
  const timestamp = execution.createdAt.replace(/[:.]/g, '-');
  return join(directory, `${timestamp}-${type}-${slug}-${execution.id}.md`);
}
