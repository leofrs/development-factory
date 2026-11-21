import { execFile } from 'node:child_process';
import { chmodSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import type { FactoryFlowTarget } from '@development-factory/shared';
import {
  FactoryArtifactDestinationError,
  assertExternalManagedWorktree,
  resolveFactoryWorktreePath,
} from './artifacts.js';

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_COMMAND_MAX_BUFFER = 1024 * 1024;
const JIRA_KEY_PATTERN = /\b([A-Z][A-Z0-9_]*-\d+)\b/i;

export type FactoryWorktreeErrorCode =
  | 'INVALID_GIT_REPOSITORY'
  | 'BASE_BRANCH_NOT_FOUND'
  | 'EMPTY_REPOSITORY'
  | 'WORKTREE_PROVISION_FAILED'
  | 'WORKTREE_INVALID';

/** Erro operacional no provisionamento ou validação do `git worktree` isolado de um fluxo da Factory. */
export class FactoryWorktreeError extends Error {
  readonly code: FactoryWorktreeErrorCode;

  constructor(code: FactoryWorktreeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FactoryWorktreeError';
    this.code = code;
  }
}

export interface ProvisionFactoryWorktreeOptions {
  readonly repoPath: string;
  readonly flowId: string;
  readonly target: Pick<FactoryFlowTarget, 'inputType' | 'value'>;
  readonly baseBranch?: string | null;
}

export interface ProvisionedFactoryWorktree {
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly repoRoot: string;
}

export interface VerifyFactoryWorktreeOptions {
  readonly repoPath: string;
  readonly worktreePath: string;
}

const repoWorktreeQueues = new Map<string, Promise<void>>();

async function withRepoWorktreeLock<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
  const previous = repoWorktreeQueues.get(repoRoot) ?? Promise.resolve();
  let releaseCurrent: () => void = () => undefined;
  const current = new Promise<void>(resolve => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  repoWorktreeQueues.set(repoRoot, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    releaseCurrent();
    if (repoWorktreeQueues.get(repoRoot) === tail) {
      repoWorktreeQueues.delete(repoRoot);
    }
  }
}

async function runGit(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_COMMAND_MAX_BUFFER,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return stdout.trim();
}

async function tryRunGit(repoPath: string, args: readonly string[]): Promise<string | null> {
  try {
    return await runGit(repoPath, args);
  } catch {
    return null;
  }
}

async function gitRefExists(repoRoot: string, fullRef: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ['show-ref', '--verify', '--quiet', fullRef]);
    return true;
  } catch {
    return false;
  }
}

function slugifySegment(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** Deriva um slug seguro de branch (`<jira-key-ou-slug>`) a partir da entrada da tarefa. */
export function buildFactoryBranchSlug(
  target: Pick<FactoryFlowTarget, 'inputType' | 'value'>,
  flowId: string,
): string {
  if (target.inputType === 'jira_key') {
    const slug = slugifySegment(target.value);
    if (slug.length > 0) {
      return slug;
    }
  }

  if (target.inputType === 'jira_url') {
    try {
      const parsed = new URL(target.value);
      const keyMatch = JIRA_KEY_PATTERN.exec(parsed.pathname);
      const candidate = keyMatch?.[1] ?? parsed.pathname;
      const slug = slugifySegment(candidate);
      if (slug.length > 0) {
        return slug;
      }
    } catch {
      const slug = slugifySegment(target.value);
      if (slug.length > 0) {
        return slug;
      }
    }
  }

  const slug = slugifySegment(target.value);
  return slug.length > 0 ? slug : `flow-${flowId.slice(0, 8)}`;
}

async function resolveUniqueBranchName(
  repoRoot: string,
  target: Pick<FactoryFlowTarget, 'inputType' | 'value'>,
  flowId: string,
): Promise<string> {
  const baseSlug = buildFactoryBranchSlug(target, flowId);
  const candidates = [
    `factory/${baseSlug}`,
    `factory/${baseSlug}-${flowId.slice(0, 8)}`,
  ];

  for (const candidate of candidates) {
    if (!(await gitRefExists(repoRoot, `refs/heads/${candidate}`))) {
      await runGit(repoRoot, ['check-ref-format', '--branch', candidate]);
      return candidate;
    }
  }

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `factory/${baseSlug}-${flowId.slice(0, 8)}-${suffix}`;
    if (!(await gitRefExists(repoRoot, `refs/heads/${candidate}`))) {
      await runGit(repoRoot, ['check-ref-format', '--branch', candidate]);
      return candidate;
    }
  }

  throw new FactoryWorktreeError(
    'WORKTREE_PROVISION_FAILED',
    'Não foi possível gerar um nome de branch único para o worktree da Factory.',
  );
}

async function verifyCommitRef(repoRoot: string, ref: string): Promise<string> {
  const commitSha = await runGit(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  const objectType = await runGit(repoRoot, ['cat-file', '-t', commitSha]);
  if (objectType !== 'commit') {
    throw new FactoryWorktreeError(
      'INVALID_GIT_REPOSITORY',
      'O repositório Git está inconsistente ou corrompido.',
    );
  }
  return commitSha;
}

async function resolveBaseBranchRef(
  repoRoot: string,
  explicitBaseBranch?: string | null,
): Promise<{ baseBranch: string; baseRef: string }> {
  if (explicitBaseBranch) {
    const localRef = `refs/heads/${explicitBaseBranch}`;
    if (await gitRefExists(repoRoot, localRef)) {
      try {
        await verifyCommitRef(repoRoot, localRef);
      } catch (error) {
        throw new FactoryWorktreeError(
          'INVALID_GIT_REPOSITORY',
          `A branch base "${explicitBaseBranch}" aponta para um commit inválido ou corrompido.`,
          { cause: error },
        );
      }
      return { baseBranch: explicitBaseBranch, baseRef: localRef };
    }

    const remoteRef = `refs/remotes/origin/${explicitBaseBranch}`;
    if (await gitRefExists(repoRoot, remoteRef)) {
      try {
        await verifyCommitRef(repoRoot, remoteRef);
      } catch (error) {
        throw new FactoryWorktreeError(
          'INVALID_GIT_REPOSITORY',
          `A branch base "${explicitBaseBranch}" aponta para um commit inválido ou corrompido.`,
          { cause: error },
        );
      }
      return { baseBranch: explicitBaseBranch, baseRef: remoteRef };
    }

    throw new FactoryWorktreeError(
      'BASE_BRANCH_NOT_FOUND',
      `A branch base "${explicitBaseBranch}" não foi encontrada no repositório.`,
    );
  }

  const currentBranch = await tryRunGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (currentBranch) {
    const localRef = `refs/heads/${currentBranch}`;
    if (!(await gitRefExists(repoRoot, localRef))) {
      throw new FactoryWorktreeError(
        'EMPTY_REPOSITORY',
        'O repositório Git precisa ter pelo menos um commit inicial para criar um worktree isolado.',
      );
    }
    try {
      await verifyCommitRef(repoRoot, localRef);
    } catch (error) {
      throw new FactoryWorktreeError(
        'INVALID_GIT_REPOSITORY',
        'O repositório Git está corrompido e não pôde resolver o commit inicial da branch atual.',
        { cause: error },
      );
    }
    return { baseBranch: currentBranch, baseRef: localRef };
  }

  for (const fallback of ['main', 'master']) {
    const ref = `refs/heads/${fallback}`;
    if (await gitRefExists(repoRoot, ref)) {
      try {
        await verifyCommitRef(repoRoot, ref);
        return { baseBranch: fallback, baseRef: ref };
      } catch {
        // Continua procurando ou falha abaixo se corrompido.
      }
    }
  }

  try {
    await verifyCommitRef(repoRoot, 'HEAD');
    return { baseBranch: 'HEAD', baseRef: 'HEAD' };
  } catch (error) {
    throw new FactoryWorktreeError(
      'EMPTY_REPOSITORY',
      'Não foi possível resolver uma branch base válida com commits no repositório Git.',
      { cause: error },
    );
  }
}

async function resolveValidGitRepoRoot(repoPath: string): Promise<string> {
  let repoTopLevel: string;
  try {
    repoTopLevel = await runGit(repoPath, ['rev-parse', '--show-toplevel']);
    const isBare = await runGit(repoTopLevel, ['rev-parse', '--is-bare-repository']);
    if (isBare === 'true') {
      throw new FactoryWorktreeError(
        'INVALID_GIT_REPOSITORY',
        'Repositórios bare não são suportados para execução isolada da Factory.',
      );
    }
    await runGit(repoTopLevel, ['rev-parse', '--git-common-dir']);
  } catch (error) {
    if (error instanceof FactoryWorktreeError) {
      throw error;
    }
    throw new FactoryWorktreeError(
      'INVALID_GIT_REPOSITORY',
      'O diretório selecionado não é um repositório Git válido ou está corrompido.',
      { cause: error },
    );
  }
  return realpathSync(repoTopLevel);
}

function cleanupOrphanWorktreeDirectory(worktreePath: string): void {
  const entry = lstatSync(worktreePath, { throwIfNoEntry: false });
  if (!entry || entry.isSymbolicLink()) {
    return;
  }
  rmSync(worktreePath, { recursive: true, force: true });
}

/**
 * Provisiona um `git worktree` isolado em diretório externo gerenciado (`worktrees/<flowId>`)
 * com uma branch dedicada (`factory/<jira-key-ou-slug>`) a partir da branch base escolhida.
 * Em caso de falha, limpa qualquer diretório ou referência órfã antes de propagar o erro.
 */
export async function provisionFactoryWorktree(
  options: ProvisionFactoryWorktreeOptions,
): Promise<ProvisionedFactoryWorktree> {
  let targetLocation: { worktreesRoot: string; worktreePath: string };
  try {
    targetLocation = resolveFactoryWorktreePath(options.repoPath, options.flowId);
  } catch (error) {
    const message =
      error instanceof FactoryArtifactDestinationError
        ? error.message
        : 'Não foi possível preparar o caminho do worktree da Factory.';
    throw new FactoryWorktreeError('WORKTREE_PROVISION_FAILED', message, { cause: error });
  }

  const repoRoot = await resolveValidGitRepoRoot(options.repoPath);

  return withRepoWorktreeLock(repoRoot, async () => {
    const existingEntry = lstatSync(targetLocation.worktreePath, { throwIfNoEntry: false });
    if (existingEntry) {
      throw new FactoryWorktreeError(
        'WORKTREE_PROVISION_FAILED',
        'Já existe um diretório ou arquivo no destino reservado para o worktree deste fluxo.',
      );
    }

    const { baseBranch, baseRef } = await resolveBaseBranchRef(repoRoot, options.baseBranch);
    const branchName = await resolveUniqueBranchName(repoRoot, options.target, options.flowId);
    const branchExistedBefore = await gitRefExists(repoRoot, `refs/heads/${branchName}`);

    try {
      await runGit(repoRoot, ['worktree', 'add', '-b', branchName, targetLocation.worktreePath, baseRef]);
      chmodSync(targetLocation.worktreePath, 0o700);
    } catch (error) {
      cleanupOrphanWorktreeDirectory(targetLocation.worktreePath);
      await tryRunGit(repoRoot, ['worktree', 'prune']);
      if (!branchExistedBefore && (await gitRefExists(repoRoot, `refs/heads/${branchName}`))) {
        await tryRunGit(repoRoot, ['branch', '-D', branchName]);
      }
      throw new FactoryWorktreeError(
        'WORKTREE_PROVISION_FAILED',
        `Não foi possível provisionar o worktree isolado para a branch "${branchName}" a partir de "${baseBranch}".`,
        { cause: error },
      );
    }

    return {
      worktreePath: realpathSync(targetLocation.worktreePath),
      branchName,
      baseBranch,
      repoRoot,
    };
  });
}

/** Valida que um worktree já associado ao fluxo permanece íntegro, gerenciado e pronto para execução. */
export async function verifyExistingFactoryWorktree(
  options: VerifyFactoryWorktreeOptions,
): Promise<string> {
  let resolvedWorktree: string;
  try {
    resolvedWorktree = assertExternalManagedWorktree(options.repoPath, options.worktreePath);
  } catch (error) {
    const message =
      error instanceof FactoryArtifactDestinationError
        ? error.message
        : 'O worktree do fluxo não está acessível.';
    throw new FactoryWorktreeError('WORKTREE_INVALID', message, { cause: error });
  }

  const insideWorkTree = await tryRunGit(resolvedWorktree, ['rev-parse', '--is-inside-work-tree']);
  if (insideWorkTree !== 'true') {
    throw new FactoryWorktreeError(
      'WORKTREE_INVALID',
      'O worktree associado ao fluxo está ausente ou corrompido.',
    );
  }

  return resolvedWorktree;
}
