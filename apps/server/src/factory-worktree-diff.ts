import { isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  FACTORY_DIFF_MAX_PATCH_BYTES,
  FACTORY_DIFF_MAX_PATCH_LINES,
  FACTORY_FLOW_CONTRACT_VERSION,
  FactoryDiffPathSchema,
} from '@development-factory/shared';
import type {
  FactoryDiffFile,
  FactoryFlowDiffPage,
  FactoryFlowDiffPatch,
  FactoryFlowDiffQuery,
} from '@development-factory/shared';
import { assertExternalManagedWorktree } from './artifacts.js';
import { FactoryWorktreeError } from './factory-worktree.js';

const execFileAsync = promisify(execFile);
const MAX_METADATA_BYTES = 1024 * 1024;
const DIFF_TIMEOUT_MS = 10_000;
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color'];

interface GitReader {
  path: string;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
}

interface GitOutput {
  stdout: Buffer;
  truncated: boolean;
}

type DiffEntry = Pick<FactoryDiffFile, 'path' | 'change' | 'untracked'>;
type DiffStats = Pick<FactoryDiffFile, 'additions' | 'deletions' | 'binary'>;
const unknownStats: DiffStats = { additions: null, deletions: null, binary: false };

async function readGit(
  repo: GitReader,
  args: string[],
  maxBuffer = MAX_METADATA_BYTES,
): Promise<GitOutput> {
  repo.signal.throwIfAborted();
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        repo.path,
        '--no-pager',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.bigFileThreshold=8m',
        ...args,
      ],
      { encoding: 'buffer', maxBuffer, signal: repo.signal, killSignal: 'SIGKILL', env: repo.env },
    );
    return { stdout, truncated: false };
  } catch (error) {
    repo.signal.throwIfAborted();
    if (
      error instanceof Error &&
      'code' in error &&
      'stdout' in error &&
      Buffer.isBuffer(error.stdout)
    ) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { stdout: error.stdout, truncated: true };
      }
      // O diff sem índice usa o código 1 quando há diferenças.
      if (error.code === 1 && args.includes('--no-index') && error.stdout.length > 0) {
        return { stdout: error.stdout, truncated: false };
      }
    }
    throw error;
  }
}

async function resolveCommit(repo: GitReader, ref: string): Promise<string | null> {
  try {
    const { stdout } = await readGit(repo, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    const sha = stdout.toString('ascii').trim();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) ? sha : null;
  } catch {
    repo.signal.throwIfAborted();
    return null;
  }
}

type DiffRange = { baseBranch: string; baselineSha?: string } | { from: string; to: string };

async function resolveDiffRevisions(repo: GitReader, range: DiffRange): Promise<string[]> {
  if ('from' in range) {
    const [from, to] = await Promise.all([
      resolveCommit(repo, range.from),
      resolveCommit(repo, range.to),
    ]);
    if (from && to) {
      return [from, to];
    }
    throw new FactoryWorktreeError(
      'WORKTREE_DIFF_FAILED',
      'Um dos commits de checkpoint está indisponível no worktree.',
    );
  }

  const base = range.baseBranch === 'HEAD'
    ? await resolveCommit(repo, range.baselineSha ?? 'HEAD')
    : (await resolveCommit(repo, `refs/heads/${range.baseBranch}`)) ??
      (await resolveCommit(repo, `refs/remotes/origin/${range.baseBranch}`));
  if (!base) {
    throw new FactoryWorktreeError(
      'WORKTREE_DIFF_FAILED',
      'A branch base do fluxo está indisponível no worktree.',
    );
  }
  return [base];
}

function trackedDiffArgs(
  revisions: string[],
  format: '--name-status' | '--numstat' | '--patch',
  paths: string[],
): string[] {
  return [
    'diff',
    ...DIFF_FLAGS,
    '--no-relative',
    '--ignore-submodules=dirty',
    '--submodule=short',
    format,
    ...(format === '--patch' ? ['--unified=3'] : ['-z']),
    ...revisions,
    '--',
    ...paths,
  ];
}

function literalPath(path: string): string {
  return `:(top,literal)${path}`;
}

function exactPath(path: string): string[] {
  return [literalPath(path), `:(top,literal,exclude)${path}/`];
}

/** Lê somente registros terminados em NUL, inclusive quando o Git atingir o limite de bytes. */
function* gitRecords(output: Buffer): Generator<Buffer> {
  let start = 0;
  for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
    yield output.subarray(start, end);
    start = end + 1;
  }
}

function readGitPath(record: Buffer): string | null {
  if (!isUtf8(record)) {
    return null;
  }
  const parsed = FactoryDiffPathSchema.safeParse(record.toString('utf8'));
  return parsed.success ? parsed.data : null;
}

async function listEntries(
  repo: GitReader,
  revisions: string[],
  file?: string,
  untracked?: boolean,
): Promise<{ entries: DiffEntry[]; truncated: boolean }> {
  const paths = file === undefined ? [] : exactPath(file);
  const [tracked, others] = await Promise.all([
    untracked ? null : readGit(repo, trackedDiffArgs(revisions, '--name-status', paths)),
    revisions.length === 1 && (file === undefined || untracked)
      ? readGit(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths])
      : null,
  ]);
  const entries: DiffEntry[] = [];
  let truncated = Boolean(tracked?.truncated || others?.truncated);
  if (tracked) {
    const records = gitRecords(tracked.stdout);
    for (const status of records) {
      const pathRecord = records.next();
      if (pathRecord.done) {
        break;
      }
      const path = readGitPath(pathRecord.value);
      if (path === null) {
        truncated = true;
        continue;
      }
      const kind = status.toString('ascii');
      const change = kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified';
      entries.push({ path, change, untracked: false });
    }
  }
  if (others) {
    for (const record of gitRecords(others.stdout)) {
      const path = readGitPath(record);
      if (path === null) {
        truncated = true;
        continue;
      }
      entries.push({ path, change: 'added', untracked: true });
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { entries, truncated };
}

function parseStats(record: Buffer): { path: string; stats: DiffStats } | null {
  const value = record.toString('utf8');
  const match = /^(\d+|-)\t(\d+|-)\t/.exec(value);
  if (!match) {
    return null;
  }
  const [, added, removed] = match;
  const binary = added === '-' || removed === '-';
  return {
    path: value.slice(match[0].length),
    stats: {
      additions: binary ? null : Number(added),
      deletions: binary ? null : Number(removed),
      binary,
    },
  };
}

async function readUntrackedDiff(
  repo: GitReader,
  path: string,
  format: '--numstat' | '--patch',
  maxBuffer?: number,
): Promise<GitOutput | null> {
  const absolutePath = join(repo.path, path);
  const parent = dirname(absolutePath);
  try {
    const file = await lstat(absolutePath);
    if ((!file.isFile() && !file.isSymbolicLink()) || (await realpath(parent)) !== parent) {
      return null;
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null;
    }
    throw error;
  }
  // O Git lê o destino textual do symlink como conteúdo do arquivo.
  return readGit(
    repo,
    [
      'diff',
      '--no-index',
      ...DIFF_FLAGS,
      format,
      format === '--patch' ? '--unified=3' : '-z',
      '--',
      '/dev/null',
      `./${path}`,
    ],
    maxBuffer,
  );
}

async function readPageStats(
  repo: GitReader,
  revisions: string[],
  page: DiffEntry[],
): Promise<FactoryDiffFile[]> {
  const trackedPaths = page.filter(entry => !entry.untracked).map(entry => literalPath(entry.path));
  const trackedStats = new Map<string, DiffStats>();
  if (trackedPaths.length > 0) {
    const output = await readGit(repo, trackedDiffArgs(revisions, '--numstat', trackedPaths));
    for (const record of gitRecords(output.stdout)) {
      const result = isUtf8(record) ? parseStats(record) : null;
      if (result) {
        trackedStats.set(result.path, result.stats);
      }
    }
  }
  const files: FactoryDiffFile[] = [];
  for (const entry of page) {
    if (entry.untracked) {
      const output = await readUntrackedDiff(repo, entry.path, '--numstat');
      const result = output ? gitRecords(output.stdout).next() : undefined;
      const stats = result?.done === false ? parseStats(result.value)?.stats : undefined;
      files.push({ ...entry, ...(stats ?? unknownStats) });
    } else {
      files.push({ ...entry, ...(trackedStats.get(entry.path) ?? unknownStats) });
    }
  }
  return files;
}

function buildPatch(output: GitOutput): FactoryFlowDiffPatch {
  const utf8 = Buffer.from(output.stdout.toString('utf8'));
  const clipped = utf8.length > FACTORY_DIFF_MAX_PATCH_BYTES;
  const patch = new TextDecoder().decode(utf8.subarray(0, FACTORY_DIFF_MAX_PATCH_BYTES), {
    stream: clipped,
  });
  const lines = patch.split('\n');
  const length = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  return {
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    kind: 'patch',
    patch: lines.slice(0, FACTORY_DIFF_MAX_PATCH_LINES).join('\n'),
    truncated: output.truncated || clipped || length > FACTORY_DIFF_MAX_PATCH_LINES,
  };
}

export async function readFactoryWorktreeDiff(
  options: { repoPath: string; worktreePath: string; flowId: string; range: DiffRange },
  query: FactoryFlowDiffQuery,
  signal: AbortSignal,
): Promise<FactoryFlowDiffPage | FactoryFlowDiffPatch | null> {
  const deadline = AbortSignal.timeout(DIFF_TIMEOUT_MS);
  try {
    const path = assertExternalManagedWorktree(options.repoPath, options.worktreePath);
    if (basename(path) !== options.flowId || !(await lstat(join(path, '.git'))).isFile()) {
      throw new FactoryWorktreeError('WORKTREE_INVALID', 'O worktree isolado do fluxo é inválido.');
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    const repo: GitReader = {
      path,
      signal: AbortSignal.any([signal, deadline]),
      env: {
        ...env,
        LC_ALL: 'C',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_ALLOW_PROTOCOL: '',
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    };
    const root = await readGit(repo, ['rev-parse', '--show-toplevel']);
    if (root.stdout.toString('utf8') !== `${path}\n`) {
      throw new FactoryWorktreeError('WORKTREE_INVALID', 'O worktree isolado do fluxo é inválido.');
    }

    const revisions = await resolveDiffRevisions(repo, options.range);
    const { entries, truncated } = await listEntries(repo, revisions, query.file, query.untracked);
    if (query.file !== undefined) {
      const entry = entries.find(
        item => item.path === query.file && item.untracked === query.untracked,
      );
      if (!entry) {
        return null;
      }
      const output = entry.untracked
        ? await readUntrackedDiff(repo, entry.path, '--patch', FACTORY_DIFF_MAX_PATCH_BYTES)
        : await readGit(
            repo,
            trackedDiffArgs(revisions, '--patch', exactPath(entry.path)),
            FACTORY_DIFF_MAX_PATCH_BYTES,
          );
      return output ? buildPatch(output) : null;
    }

    const end = query.offset + query.limit;
    return {
      contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
      kind: 'page',
      files: await readPageStats(repo, revisions, entries.slice(query.offset, end)),
      totalFiles: entries.length,
      nextOffset: end < entries.length ? end : null,
      truncated,
    };
  } catch (error) {
    if (error instanceof FactoryWorktreeError) {
      throw error;
    }
    throw new FactoryWorktreeError(
      'WORKTREE_DIFF_FAILED',
      deadline.aborted
        ? 'A leitura do diff excedeu o tempo limite.'
        : 'Não foi possível ler o diff do worktree isolado do fluxo.',
      { cause: error },
    );
  }
}
