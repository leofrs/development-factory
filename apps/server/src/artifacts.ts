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

/** Retorna o diretório raiz padrão dos worktrees da Factory fora dos repositórios analisados. */
export function defaultFactoryWorktreesDirectory(): string {
  return join(reviewDataDirectory(), 'worktrees');
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

function ensureManagedDirectory(
  directory: string,
  enforcePermissions: boolean,
  label: string,
): void {
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new FactoryArtifactDestinationError(
        `O diretório de ${label} da Factory precisa ser um diretório real, sem links simbólicos.`,
      );
    }
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (enforcePermissions) {
    chmodSync(directory, 0o700);
  }
}

interface ResolveManagedDirectoryOptions {
  readonly subdirectory: 'artifacts' | 'worktrees';
  readonly label: string;
  readonly createFlowDirectory: boolean;
}

function resolveManagedFlowPath(
  repoPath: string,
  options: ResolveManagedDirectoryOptions,
  flowId?: string,
): string {
  const createDestinationError = (message: string) => new FactoryArtifactDestinationError(message);

  if (flowId !== undefined && !SAFE_FLOW_DIRECTORY_PATTERN.test(flowId)) {
    throw createDestinationError(
      `Identificador de fluxo inválido para o diretório de ${options.label}.`,
    );
  }

  const dataRoot = reviewDataDirectory();
  const managedRoot = join(dataRoot, options.subdirectory);
  const targetDirectory = flowId ? join(managedRoot, flowId) : managedRoot;

  if (!isAbsolute(targetDirectory) || targetDirectory.includes('\0')) {
    throw createDestinationError(
      `O diretório de ${options.label} da Factory precisa ser um caminho absoluto válido no WSL.`,
    );
  }

  const canonicalTarget = canonicalPathAllowingMissing(resolve(targetDirectory));
  assertExternalDestination(
    canonicalTarget,
    repoPath,
    () =>
      createDestinationError(
        `O diretório de ${options.label} da Factory precisa ficar fora do repositório analisado e do Development Factory.`,
      ),
  );

  ensureManagedDirectory(dataRoot, false, options.label);
  ensureManagedDirectory(managedRoot, true, options.label);

  if (flowId && options.createFlowDirectory) {
    ensureManagedDirectory(targetDirectory, true, options.label);
  }

  const checkTarget = options.createFlowDirectory || !flowId ? targetDirectory : managedRoot;
  const resolvedCheckTarget = realpathSync(checkTarget);
  assertExternalDestination(
    resolvedCheckTarget,
    repoPath,
    () =>
      createDestinationError(
        `O diretório de ${options.label} da Factory precisa ficar fora do repositório analisado e do Development Factory.`,
      ),
  );
  if (!statSync(resolvedCheckTarget).isDirectory()) {
    throw createDestinationError(
      `O diretório de ${options.label} da Factory precisa ser uma pasta válida.`,
    );
  }
  accessSync(resolvedCheckTarget, constants.W_OK | constants.X_OK);

  if (!flowId || options.createFlowDirectory) {
    return resolvedCheckTarget;
  }

  const candidatePath = join(resolvedCheckTarget, flowId);
  const existingEntry = lstatSync(candidatePath, { throwIfNoEntry: false });
  if (existingEntry?.isSymbolicLink()) {
    throw createDestinationError(
      `O diretório de ${options.label} da Factory precisa ser um diretório real, sem links simbólicos.`,
    );
  }
  return candidatePath;
}

/**
 * Resolve e prepara o diretório externo gerenciado para artefatos e registros de sessão da Factory,
 * garantindo isolamento fora do repositório, permissões `0o700` e proteção contra symlinks.
 */
export function resolveFactoryArtifactsDirectory(repoPath: string, flowId?: string): string {
  try {
    return resolveManagedFlowPath(
      repoPath,
      {
        subdirectory: 'artifacts',
        label: 'artefatos',
        createFlowDirectory: true,
      },
      flowId,
    );
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

/**
 * Prepara a raiz externa de worktrees (`0o700`, sem symlinks, fora do repositório alvo) e retorna
 * o caminho alvo `<worktreesRoot>/<flowId>` pronto para provisionamento via `git worktree add`.
 */
export function resolveFactoryWorktreePath(repoPath: string, flowId: string): {
  worktreesRoot: string;
  worktreePath: string;
} {
  try {
    const worktreesRoot = resolveManagedFlowPath(repoPath, {
      subdirectory: 'worktrees',
      label: 'worktrees',
      createFlowDirectory: false,
    });
    const worktreePath = resolveManagedFlowPath(
      repoPath,
      {
        subdirectory: 'worktrees',
        label: 'worktrees',
        createFlowDirectory: false,
      },
      flowId,
    );
    return { worktreesRoot, worktreePath };
  } catch (error) {
    if (error instanceof FactoryArtifactDestinationError) {
      throw error;
    }
    throw new FactoryArtifactDestinationError(
      'Não foi possível preparar o diretório externo de worktrees da Factory.',
      { cause: error },
    );
  }
}

/** Verifica se um caminho de worktree existente permanece dentro da raiz gerenciada e fora do repositório. */
export function assertExternalManagedWorktree(repoPath: string, worktreePath: string): string {
  const worktreesRoot = realpathSync(defaultFactoryWorktreesDirectory());
  const entry = lstatSync(worktreePath, { throwIfNoEntry: false });
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new FactoryArtifactDestinationError(
      'O diretório do worktree da Factory não existe ou é inválido.',
    );
  }
  const resolvedWorktree = realpathSync(worktreePath);
  if (!isWithin(worktreesRoot, resolvedWorktree) || resolvedWorktree === worktreesRoot) {
    throw new FactoryArtifactDestinationError(
      'O worktree da Factory precisa estar dentro do diretório gerenciado de worktrees.',
    );
  }
  assertExternalDestination(
    resolvedWorktree,
    repoPath,
    () =>
      new FactoryArtifactDestinationError(
        'O worktree da Factory precisa ficar fora do repositório analisado e do Development Factory.',
      ),
  );
  return resolvedWorktree;
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
