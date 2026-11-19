import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Review, ReviewExecution } from '@development-factory/shared';
import { reviewDataDirectory } from './storage/config.js';

const applicationRoot = fileURLToPath(new URL('../../../', import.meta.url));

export class ReviewDestinationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReviewDestinationError';
  }
}

export function defaultReviewReportDirectory(): string {
  return join(reviewDataDirectory(), 'reviews');
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

function assertExternalDestination(directory: string, repoPath: string): void {
  if (isWithin(repositoryRoot(repoPath), directory) ||
      isWithin(realpathSync(applicationRoot), directory)) {
    throw new ReviewDestinationError(
      'Em “Salvar code review em”, escolha uma pasta fora do repositório analisado e do Development Factory.',
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
