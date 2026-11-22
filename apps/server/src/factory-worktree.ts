import { execFile } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { GitBranchNameSchema } from '@development-factory/shared';
import type {
  FactoryFlowTarget,
  FactoryRepositoryProfile,
  FactoryStageName,
} from '@development-factory/shared';
import {
  FactoryArtifactDestinationError,
  assertExternalManagedWorktree,
  defaultFactoryWorktreesDirectory,
  resolveFactoryWorktreePath,
} from './artifacts.js';
import { loadFactoryRepositoryProfile } from './factory-repository-profile.js';

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_COMMAND_MAX_BUFFER = 1024 * 1024;
const JIRA_KEY_PATTERN = /\b([A-Z][A-Z0-9_]*-\d+)\b/i;

export type FactoryWorktreeErrorCode =
  | 'INVALID_GIT_REPOSITORY'
  | 'GIT_REPOSITORY_LOCKED'
  | 'BASE_BRANCH_NOT_FOUND'
  | 'EMPTY_REPOSITORY'
  | 'WORKTREE_PROVISION_FAILED'
  | 'WORKTREE_INVALID'
  | 'WORKTREE_CHECKPOINT_FAILED'
  | 'WORKTREE_ROLLBACK_FAILED'
  | 'WORKTREE_CLEANUP_FAILED';

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
  readonly repositoryProfile: FactoryRepositoryProfile;
}

export interface VerifyFactoryWorktreeOptions {
  readonly repoPath: string;
  readonly worktreePath: string;
}

export interface CreateFactoryWorktreeCheckpointOptions {
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly stage: FactoryStageName;
  readonly iteration: number;
  readonly message?: string;
}

export interface CreatedFactoryWorktreeCheckpoint {
  readonly commitSha: string;
  readonly branchName: string | null;
  readonly message: string;
  readonly createdCommit: boolean;
}

export interface FactoryWorktreeHeadState {
  readonly headSha: string;
  readonly dirty: boolean;
  readonly branchName: string | null;
}

export interface RollbackFactoryWorktreeOptions {
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly commitSha: string;
}

export interface RolledBackFactoryWorktree {
  readonly commitSha: string;
  readonly branchName: string | null;
}

export interface CleanupFactoryWorktreeOptions {
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly branchName?: string | null;
  readonly baseBranch?: string | null;
}

export interface CleanedUpFactoryWorktree {
  readonly removedDirectory: boolean;
  readonly prunedReferences: boolean;
  readonly deletedLocalBranch: boolean;
}

const repoWorktreeQueues = new Map<string, Promise<void>>();
const worktreeOperationQueues = new Map<string, Promise<void>>();

async function withQueuedLock<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let releaseCurrent: () => void = () => undefined;
  const current = new Promise<void>(resolve => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  queues.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    releaseCurrent();
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  }
}

function withRepoWorktreeLock<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
  return withQueuedLock(repoWorktreeQueues, repoRoot, task);
}

function withWorktreeLock<T>(worktreePath: string, task: () => Promise<T>): Promise<T> {
  return withQueuedLock(worktreeOperationQueues, worktreePath, task);
}

async function runGit(
  repoPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_COMMAND_MAX_BUFFER,
    ...(signal && { signal, killSignal: 'SIGKILL' }),
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(signal && { GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: '' }),
    },
  });
  return stdout.trim();
}

async function tryRunGit(
  repoPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    return await runGit(repoPath, args, signal);
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

async function gitRefExists(
  repoRoot: string,
  fullRef: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await runGit(repoRoot, ['show-ref', '--verify', '--quiet', fullRef], signal);
    return true;
  } catch {
    signal?.throwIfAborted();
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
  branchPattern: string,
): Promise<string> {
  const baseSlug = buildFactoryBranchSlug(target, flowId);
  const uniqueSlug = `${baseSlug}-${flowId.slice(0, 8)}`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : uniqueSlug;
    const suffix = attempt > 1 ? `-${attempt}` : '';
    const candidate = branchPattern.replaceAll('{slug}', `${slug}${suffix}`);
    if (await gitRefExists(repoRoot, `refs/heads/${candidate}`)) {
      continue;
    }
    if (
      !GitBranchNameSchema.safeParse(candidate).success ||
      (await tryRunGit(repoRoot, ['check-ref-format', '--branch', candidate])) === null
    ) {
      throw new FactoryWorktreeError(
        'WORKTREE_PROVISION_FAILED',
        'O branchPattern do perfil gerou um nome de branch Git inválido para a tarefa.',
      );
    }
    return candidate;
  }

  throw new FactoryWorktreeError(
    'WORKTREE_PROVISION_FAILED',
    'Não foi possível gerar um nome de branch único para o worktree da Factory.',
  );
}

async function verifyCommitRef(
  repoRoot: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  const commitSha = await runGit(
    repoRoot,
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    signal,
  );
  const objectType = await runGit(repoRoot, ['cat-file', '-t', commitSha], signal);
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
  signal?: AbortSignal,
): Promise<{ baseBranch: string; baseRef: string }> {
  if (explicitBaseBranch) {
    const localRef = `refs/heads/${explicitBaseBranch}`;
    if (await gitRefExists(repoRoot, localRef, signal)) {
      try {
        await verifyCommitRef(repoRoot, localRef, signal);
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
    if (await gitRefExists(repoRoot, remoteRef, signal)) {
      try {
        await verifyCommitRef(repoRoot, remoteRef, signal);
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

  const currentBranch = await tryRunGit(
    repoRoot,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    signal,
  );
  if (currentBranch) {
    const localRef = `refs/heads/${currentBranch}`;
    if (!(await gitRefExists(repoRoot, localRef, signal))) {
      throw new FactoryWorktreeError(
        'EMPTY_REPOSITORY',
        'O repositório Git precisa ter pelo menos um commit inicial para criar um worktree isolado.',
      );
    }
    try {
      await verifyCommitRef(repoRoot, localRef, signal);
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
    if (await gitRefExists(repoRoot, ref, signal)) {
      try {
        await verifyCommitRef(repoRoot, ref, signal);
        return { baseBranch: fallback, baseRef: ref };
      } catch {
        // Continua procurando ou falha abaixo se corrompido.
      }
    }
  }

  try {
    await verifyCommitRef(repoRoot, 'HEAD', signal);
    return { baseBranch: 'HEAD', baseRef: 'HEAD' };
  } catch (error) {
    throw new FactoryWorktreeError(
      'EMPTY_REPOSITORY',
      'Não foi possível resolver uma branch base válida com commits no repositório Git.',
      { cause: error },
    );
  }
}

export async function resolveValidGitRepoRoot(
  repoPath: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const repoTopLevel = await runGit(repoPath, ['rev-parse', '--show-toplevel'], signal);
    const isBare = await runGit(repoTopLevel, ['rev-parse', '--is-bare-repository'], signal);
    if (isBare === 'true') {
      throw new FactoryWorktreeError(
        'INVALID_GIT_REPOSITORY',
        'Repositórios bare não são suportados para execução isolada da Factory.',
      );
    }
    await runGit(repoTopLevel, ['rev-parse', '--git-common-dir'], signal);
    return await realpath(repoTopLevel);
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
}

export async function verifyFactoryGitRepository(
  repoRoot: string,
  requestedBaseBranch: string | null,
  signal: AbortSignal,
): Promise<string> {
  const { baseBranch, baseRef } = await resolveBaseBranchRef(repoRoot, requestedBaseBranch, signal);
  const lockTargets = new Set([
    'index',
    'HEAD',
    'packed-refs',
    'config',
    'config.worktree',
    'shallow',
    'reftable/tables.list',
    baseRef,
  ]);
  const locks = await Promise.all(
    [...lockTargets].map(async target => {
      const gitPath = await runGit(
        repoRoot,
        ['rev-parse', '--path-format=absolute', '--git-path', target],
        signal,
      );
      try {
        await lstat(`${gitPath}.lock`);
        return `${target}.lock`;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    }),
  );
  const lock = locks.find(entry => entry !== null);
  if (lock !== undefined) {
    throw new FactoryWorktreeError(
      'GIT_REPOSITORY_LOCKED',
      `O Git encontrou o lock "${lock}". Aguarde a operação Git em andamento e tente novamente.`,
    );
  }

  await runGit(
    repoRoot,
    ['-c', 'core.fsmonitor=false', 'fsck', '--no-reflogs', '--no-dangling', '--no-progress'],
    signal,
  );
  return baseBranch;
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
 * com uma branch dedicada segundo o perfil do repositório e a branch base escolhida.
 * Em caso de falha, limpa qualquer diretório ou referência órfã antes de propagar o erro.
 */
export async function provisionFactoryWorktree(
  options: ProvisionFactoryWorktreeOptions,
): Promise<ProvisionedFactoryWorktree> {
  const repoRoot = await resolveValidGitRepoRoot(options.repoPath);
  const { profile: repositoryProfile } = await loadFactoryRepositoryProfile(repoRoot);

  let targetLocation: { worktreesRoot: string; worktreePath: string };
  try {
    targetLocation = resolveFactoryWorktreePath(repoRoot, options.flowId);
  } catch (error) {
    const message =
      error instanceof FactoryArtifactDestinationError
        ? error.message
        : 'Não foi possível preparar o caminho do worktree da Factory.';
    throw new FactoryWorktreeError('WORKTREE_PROVISION_FAILED', message, { cause: error });
  }

  return withRepoWorktreeLock(repoRoot, async () => {
    const existingEntry = lstatSync(targetLocation.worktreePath, { throwIfNoEntry: false });
    if (existingEntry) {
      throw new FactoryWorktreeError(
        'WORKTREE_PROVISION_FAILED',
        'Já existe um diretório ou arquivo no destino reservado para o worktree deste fluxo.',
      );
    }

    const { baseBranch, baseRef } = await resolveBaseBranchRef(
      repoRoot,
      options.baseBranch ?? repositoryProfile.baseBranch,
    );
    const branchName = await resolveUniqueBranchName(
      repoRoot,
      options.target,
      options.flowId,
      repositoryProfile.branchPattern,
    );
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
      repositoryProfile,
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

async function resolveGitCommitAuthorArgs(worktreePath: string): Promise<string[]> {
  const configuredName = await tryRunGit(worktreePath, ['config', 'user.name']);
  const configuredEmail = await tryRunGit(worktreePath, ['config', 'user.email']);
  const args: string[] = [];
  if (!configuredName) {
    args.push('-c', 'user.name=Development Factory');
  }
  if (!configuredEmail) {
    args.push('-c', 'user.email=factory@development-factory.local');
  }
  return args;
}

function isWithinDirectory(parent: string, target: string): boolean {
  const diff = relative(parent, target);
  return diff !== '' && diff !== '..' && !diff.startsWith(`..${sep}`) && !isAbsolute(diff);
}

async function isBranchCheckedOutInAnyWorktree(
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  const porcelain = await tryRunGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!porcelain) {
    return false;
  }
  const targetRef = `refs/heads/${branchName}`;
  return porcelain
    .split(/\r?\n/)
    .some(line => line.trim() === `branch ${targetRef}`);
}

async function hasRemoteTrackingOrPublishedBranch(
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  const upstream = await tryRunGit(repoRoot, [
    'for-each-ref',
    '--format=%(upstream)',
    `refs/heads/${branchName}`,
  ]);
  if (upstream && upstream.length > 0) {
    return true;
  }

  const remoteRefs = await tryRunGit(repoRoot, [
    'for-each-ref',
    '--format=%(refname)',
    `refs/remotes/*/${branchName}`,
  ]);
  return Boolean(remoteRefs && remoteRefs.length > 0);
}

/**
 * Inspeciona o `HEAD` atual e se há alterações pendentes (staged, unstaged ou untracked) no worktree.
 */
export async function getFactoryWorktreeHeadSha(
  options: VerifyFactoryWorktreeOptions,
): Promise<FactoryWorktreeHeadState> {
  const resolvedWorktree = await verifyExistingFactoryWorktree(options);
  return withWorktreeLock(resolvedWorktree, async () => {
    try {
      const headSha = await verifyCommitRef(resolvedWorktree, 'HEAD');
      const status = await runGit(resolvedWorktree, ['status', '--porcelain']);
      const branchName = await tryRunGit(resolvedWorktree, ['branch', '--show-current']);
      return {
        headSha,
        dirty: status.length > 0,
        branchName: branchName || null,
      };
    } catch (error) {
      if (error instanceof FactoryWorktreeError) {
        throw error;
      }
      throw new FactoryWorktreeError(
        'WORKTREE_INVALID',
        'Não foi possível inspecionar o estado Git do worktree.',
        { cause: error },
      );
    }
  });
}

/** Compara o conteúdo dos checkpoints Git, incluindo quando os commits têm SHAs diferentes. */
export async function hasEmptyFactoryWorktreeCheckpointDiff(
  options: VerifyFactoryWorktreeOptions,
  previousCommit: string,
  currentCommit: string,
): Promise<boolean> {
  const worktreePath = await verifyExistingFactoryWorktree(options);
  return withWorktreeLock(worktreePath, async () => {
    const [previousTree, currentTree] = await Promise.all(
      [previousCommit, currentCommit].map(commit =>
        tryRunGit(worktreePath, ['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`]),
      ),
    );
    return Boolean(previousTree) && previousTree === currentTree;
  });
}

/**
 * Cria um commit de checkpoint no worktree caso haja alterações pendentes (ou captura o `HEAD` atual
 * quando limpo) e retorna o SHA resultante para persistência no SQLite.
 */
export async function createFactoryWorktreeCheckpoint(
  options: CreateFactoryWorktreeCheckpointOptions,
): Promise<CreatedFactoryWorktreeCheckpoint> {
  const resolvedWorktree = await verifyExistingFactoryWorktree({
    repoPath: options.repoPath,
    worktreePath: options.worktreePath,
  });

  const commitMessage =
    options.message?.trim() ||
    `factory(checkpoint): ${options.stage} (iteração ${options.iteration})`;

  return withWorktreeLock(resolvedWorktree, async () => {
    try {
      const statusBefore = await runGit(resolvedWorktree, ['status', '--porcelain']);
      let createdCommit = false;

      if (statusBefore.length > 0) {
        await runGit(resolvedWorktree, ['add', '-A']);
        const stagedStatus = await runGit(resolvedWorktree, ['status', '--porcelain']);
        if (stagedStatus.length > 0) {
          const authorArgs = await resolveGitCommitAuthorArgs(resolvedWorktree);
          await runGit(resolvedWorktree, [
            ...authorArgs,
            'commit',
            '--no-verify',
            '-m',
            commitMessage,
          ]);
          createdCommit = true;
        }
      }

      const commitSha = await verifyCommitRef(resolvedWorktree, 'HEAD');
      const branchName = await tryRunGit(resolvedWorktree, ['branch', '--show-current']);
      return {
        commitSha,
        branchName: branchName || null,
        message: commitMessage,
        createdCommit,
      };
    } catch (error) {
      if (error instanceof FactoryWorktreeError) {
        throw error;
      }
      throw new FactoryWorktreeError(
        'WORKTREE_CHECKPOINT_FAILED',
        `Não foi possível criar o checkpoint Git do worktree na etapa ${options.stage}.`,
        { cause: error },
      );
    }
  });
}

/**
 * Reverte deterministicamente o worktree para o commit SHA de um checkpoint anterior (`git reset --hard` + `git clean -fd`).
 */
export async function rollbackFactoryWorktreeToCheckpoint(
  options: RollbackFactoryWorktreeOptions,
): Promise<RolledBackFactoryWorktree> {
  const resolvedWorktree = await verifyExistingFactoryWorktree({
    repoPath: options.repoPath,
    worktreePath: options.worktreePath,
  });

  return withWorktreeLock(resolvedWorktree, async () => {
    let targetSha: string;
    try {
      targetSha = await verifyCommitRef(resolvedWorktree, options.commitSha);
    } catch (error) {
      throw new FactoryWorktreeError(
        'WORKTREE_ROLLBACK_FAILED',
        `O commit de checkpoint "${options.commitSha}" não foi encontrado ou é inválido neste worktree.`,
        { cause: error },
      );
    }

    try {
      await runGit(resolvedWorktree, ['reset', '--hard', targetSha]);
      await runGit(resolvedWorktree, ['clean', '-fd']);
      const headSha = await verifyCommitRef(resolvedWorktree, 'HEAD');
      const statusAfter = await runGit(resolvedWorktree, ['status', '--porcelain']);
      if (headSha !== targetSha || statusAfter.length > 0) {
        throw new Error('O estado resultante do worktree diverge do checkpoint solicitado.');
      }
      const branchName = await tryRunGit(resolvedWorktree, ['branch', '--show-current']);
      return {
        commitSha: headSha,
        branchName: branchName || null,
      };
    } catch (error) {
      if (error instanceof FactoryWorktreeError) {
        throw error;
      }
      throw new FactoryWorktreeError(
        'WORKTREE_ROLLBACK_FAILED',
        `Não foi possível reverter o worktree para o checkpoint ${targetSha.slice(0, 7)}.`,
        { cause: error },
      );
    }
  });
}

/**
 * Remove com segurança o diretório externo do worktree (`git worktree remove`) e faz prune das referências
 * (`git worktree prune`) sem apagar commits ou referências enviadas ao remoto.
 */
export async function cleanupFactoryWorktree(
  options: CleanupFactoryWorktreeOptions,
): Promise<CleanedUpFactoryWorktree> {
  const worktreesRootRaw = defaultFactoryWorktreesDirectory();
  const worktreesRootEntry = lstatSync(worktreesRootRaw, { throwIfNoEntry: false });
  const worktreesRoot =
    worktreesRootEntry && !worktreesRootEntry.isSymbolicLink() && worktreesRootEntry.isDirectory()
      ? realpathSync(worktreesRootRaw)
      : resolve(worktreesRootRaw);

  const entry = lstatSync(options.worktreePath, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) {
    throw new FactoryWorktreeError(
      'WORKTREE_INVALID',
      'O caminho do worktree é um link simbólico e não pode ser removido.',
    );
  }

  const candidatePath = entry ? realpathSync(options.worktreePath) : resolve(options.worktreePath);
  if (!isWithinDirectory(worktreesRoot, candidatePath)) {
    throw new FactoryWorktreeError(
      'WORKTREE_INVALID',
      'A limpeza só pode atuar em worktrees dentro do diretório gerenciado da Factory.',
    );
  }

  if (!existsSync(options.repoPath)) {
    let removedDirectory = false;
    if (entry?.isDirectory()) {
      cleanupOrphanWorktreeDirectory(candidatePath);
      removedDirectory = true;
    }
    return {
      removedDirectory,
      prunedReferences: false,
      deletedLocalBranch: false,
    };
  }

  const repoRoot = await resolveValidGitRepoRoot(options.repoPath);

  return withRepoWorktreeLock(repoRoot, async () => {
    let removedDirectory = false;
    const currentEntry = lstatSync(candidatePath, { throwIfNoEntry: false });
    if (currentEntry?.isDirectory()) {
      try {
        await runGit(repoRoot, ['worktree', 'remove', '--force', candidatePath]);
        removedDirectory = true;
      } catch {
        // Caso o diretório não esteja mais registrado em `.git/worktrees`, remove o órfão com segurança.
        cleanupOrphanWorktreeDirectory(candidatePath);
        removedDirectory = !existsSync(candidatePath);
      }
    }

    await runGit(repoRoot, ['worktree', 'prune']);
    const prunedReferences = true;

    let deletedLocalBranch = false;
    if (options.branchName) {
      const localRef = `refs/heads/${options.branchName}`;
      const existsLocally = await gitRefExists(repoRoot, localRef);
      const checkedOut = existsLocally
        ? await isBranchCheckedOutInAnyWorktree(repoRoot, options.branchName)
        : true;
      const publishedOrTracked = existsLocally
        ? await hasRemoteTrackingOrPublishedBranch(repoRoot, options.branchName)
        : true;

      if (existsLocally && !checkedOut && !publishedOrTracked) {
        let baseRef: string | null = null;
        if (options.baseBranch) {
          if (await gitRefExists(repoRoot, `refs/heads/${options.baseBranch}`)) {
            baseRef = `refs/heads/${options.baseBranch}`;
          } else if (await gitRefExists(repoRoot, `refs/remotes/origin/${options.baseBranch}`)) {
            baseRef = `refs/remotes/origin/${options.baseBranch}`;
          }
        }
        const aheadCount = baseRef
          ? await tryRunGit(repoRoot, ['rev-list', '--count', `${baseRef}..${localRef}`])
          : null;

        // Só remove a branch local quando não possui nenhum commit próprio além da branch base.
        if (aheadCount === '0') {
          try {
            await runGit(repoRoot, ['branch', '-d', options.branchName]);
            deletedLocalBranch = true;
          } catch {
            deletedLocalBranch = false;
          }
        }
      }
    }

    return {
      removedDirectory,
      prunedReferences,
      deletedLocalBranch,
    };
  });
}
