import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import {
  FactoryDiffPathSchema,
  type FactoryJiraContext,
  type FactoryPrJiraSync,
  type FactoryPrProvider,
  type FactoryPrSecretFinding,
} from '@development-factory/shared';
import { z } from 'zod';
import { assertExternalManagedWorktree } from './artifacts.js';
import {
  FactoryWorktreeError,
  resolveGitCommitAuthorArgs,
  verifyExistingFactoryWorktree,
} from './factory-worktree.js';
import { detectSecretsInText, redactSecrets } from './secret-redaction.js';

const execFileAsync = promisify(execFile);

const GIT_SCAN_TIMEOUT_MS = 15_000;
const GIT_SCAN_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_WRITE_TIMEOUT_MS = 30_000;
const PR_CLI_TIMEOUT_MS = 30_000;
const JIRA_HTTP_TIMEOUT_MS = 10_000;
const MAX_UNTRACKED_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SECRET_FINDINGS = 50;
const MAX_INLINE_BODY_BYTES = 32 * 1024;

const PR_URL_SCHEMA = z.url({ protocol: /^https?$/ });

export interface ScanWorktreeSecretsOptions {
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly flowId: string;
  readonly baseBranch: string;
  readonly baselineSha?: string;
}

export interface CommitAndPushWorktreeOptions {
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly headBranch: string;
  readonly commitTitle: string;
}

export interface CommitAndPushWorktreeResult {
  readonly commitSha: string;
  readonly createdCommit: boolean;
}

export interface CreateProviderPullRequestOptions {
  readonly worktreePath: string;
  readonly provider?: FactoryPrProvider;
  readonly title: string;
  readonly description: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly draft: boolean;
  readonly reviewers: readonly string[];
}

export interface CreatedProviderPullRequest {
  readonly provider: FactoryPrProvider;
  readonly prUrl: string;
  readonly prNumber: number | null;
}

export interface JiraPrCommentPayload {
  readonly jiraContext: FactoryJiraContext;
  readonly prUrl: string;
  readonly prNumber: number | null;
  readonly provider: FactoryPrProvider;
  readonly title: string;
  readonly summary: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly draft: boolean;
  readonly satisfiedAcceptanceCriteriaIds: readonly string[];
  readonly evidence: readonly string[];
}

export type JiraCommentSender = (
  payload: JiraPrCommentPayload,
  signal: AbortSignal,
) => Promise<void>;

export interface FactoryPrPublishDependencies {
  readonly scanSecrets?: (
    options: ScanWorktreeSecretsOptions,
    signal: AbortSignal,
  ) => Promise<FactoryPrSecretFinding[]>;
  readonly commitAndPush?: (
    options: CommitAndPushWorktreeOptions,
    signal: AbortSignal,
  ) => Promise<CommitAndPushWorktreeResult>;
  readonly createPullRequest?: (
    options: CreateProviderPullRequestOptions,
    signal: AbortSignal,
  ) => Promise<CreatedProviderPullRequest>;
  readonly commentJira?: JiraCommentSender;
}

function buildSanitizedGitEnv(allowNetwork: boolean): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return {
    ...env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    ...(allowNetwork
      ? {}
      : {
          GIT_OPTIONAL_LOCKS: '0',
          GIT_ALLOW_PROTOCOL: '',
          GIT_NO_LAZY_FETCH: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
        }),
  };
}

function formatExecError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const stderr =
      'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const stdout =
      'stdout' in error && typeof error.stdout === 'string' ? error.stdout.trim() : '';
    const detail = stderr || stdout || error.message;
    const redacted = redactSecrets(detail).trim();
    return redacted.length > 0 ? redacted : fallback;
  }
  return fallback;
}

async function runGitBuffer(
  worktreePath: string,
  args: readonly string[],
  signal: AbortSignal,
  maxBuffer = GIT_SCAN_MAX_BUFFER,
): Promise<{ stdout: Buffer; truncated: boolean }> {
  signal.throwIfAborted();
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, '--no-pager', '-c', 'core.fsmonitor=false', ...args],
      {
        encoding: 'buffer',
        maxBuffer,
        timeout: GIT_SCAN_TIMEOUT_MS,
        signal,
        killSignal: 'SIGKILL',
        env: buildSanitizedGitEnv(false),
      },
    );
    return { stdout, truncated: false };
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' &&
      'stdout' in error &&
      Buffer.isBuffer(error.stdout)
    ) {
      return { stdout: error.stdout, truncated: true };
    }
    throw error;
  }
}

async function tryResolveCommitSha(
  worktreePath: string,
  ref: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const { stdout } = await runGitBuffer(
      worktreePath,
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      signal,
    );
    const sha = stdout.toString('ascii').trim();
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

async function resolveScanBaseCommit(
  worktreePath: string,
  baseBranch: string,
  baselineSha: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const baseCommit =
    baseBranch === 'HEAD'
      ? baselineSha
        ? await tryResolveCommitSha(worktreePath, baselineSha, signal)
        : await tryResolveCommitSha(worktreePath, 'HEAD', signal)
      : (await tryResolveCommitSha(worktreePath, `refs/heads/${baseBranch}`, signal)) ??
        (await tryResolveCommitSha(worktreePath, `refs/remotes/origin/${baseBranch}`, signal)) ??
        (baselineSha ? await tryResolveCommitSha(worktreePath, baselineSha, signal) : null);

  if (!baseCommit) {
    throw new FactoryWorktreeError(
      'WORKTREE_DIFF_FAILED',
      `Não foi possível resolver a branch destino "${baseBranch}" para executar o secret scanning no diff.`,
    );
  }

  try {
    const { stdout } = await runGitBuffer(
      worktreePath,
      ['merge-base', baseCommit, 'HEAD'],
      signal,
    );
    const mergeBase = stdout.toString('ascii').trim();
    if (/^[0-9a-f]{7,64}$/i.test(mergeBase)) {
      return mergeBase;
    }
  } catch {
    signal.throwIfAborted();
  }

  return baseCommit;
}

function recordLineSecretFindings(
  findings: FactoryPrSecretFinding[],
  file: string,
  lineNumber: number,
  content: string,
): void {
  if (findings.length >= MAX_SECRET_FINDINGS) {
    return;
  }
  const detections = detectSecretsInText(content);
  const primary = detections[0];
  if (!primary) {
    return;
  }
  const snippet = redactSecrets(content).trim().slice(0, 200) || '[REDACTED]';
  findings.push({
    file,
    line: lineNumber,
    rule: primary.rule,
    snippet,
  });
}

/** Analisa um diff unificado (`git diff --unified=0`) mantendo contagem exata de linhas novas. */
export function scanUnifiedDiffForSecrets(diffText: string): FactoryPrSecretFinding[] {
  const findings: FactoryPrSecretFinding[] = [];
  let currentFile: string | null = null;
  let inHunk = false;
  let remainingOldLines = 0;
  let remainingNewLines = 0;
  let currentNewLine = 1;

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (findings.length >= MAX_SECRET_FINDINGS) {
      break;
    }

    if (inHunk) {
      if (rawLine.startsWith('\\')) {
        continue;
      }
      if (rawLine.startsWith('+')) {
        if (currentFile !== null) {
          recordLineSecretFindings(findings, currentFile, currentNewLine, rawLine.slice(1));
        }
        currentNewLine += 1;
        remainingNewLines = Math.max(0, remainingNewLines - 1);
      } else if (rawLine.startsWith('-')) {
        remainingOldLines = Math.max(0, remainingOldLines - 1);
      } else {
        currentNewLine += 1;
        remainingOldLines = Math.max(0, remainingOldLines - 1);
        remainingNewLines = Math.max(0, remainingNewLines - 1);
      }

      if (remainingOldLines === 0 && remainingNewLines === 0) {
        inHunk = false;
      }
      continue;
    }

    if (rawLine.startsWith('diff --git ')) {
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (rawLine === '+++ /dev/null') {
      currentFile = null;
      continue;
    }
    if (rawLine.startsWith('+++ b/')) {
      const parsedPath = FactoryDiffPathSchema.safeParse(rawLine.slice('+++ b/'.length));
      currentFile = parsedPath.success ? parsedPath.data : null;
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
    if (hunkMatch) {
      remainingOldLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      currentNewLine = Number(hunkMatch[3]);
      remainingNewLines = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      inHunk = remainingOldLines > 0 || remainingNewLines > 0;
    }
  }

  return findings;
}

function readRegularUntrackedFile(filePath: string): string | null {
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size === 0 || info.size > MAX_UNTRACKED_SCAN_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const bytesRead = readSync(descriptor, buffer, offset, info.size - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    const content = buffer.subarray(0, offset);
    if (content.includes(0)) {
      return null;
    }
    return content.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

async function scanUntrackedFilesForSecrets(
  worktreePath: string,
  findings: FactoryPrSecretFinding[],
  signal: AbortSignal,
): Promise<void> {
  if (findings.length >= MAX_SECRET_FINDINGS) {
    return;
  }
  const { stdout } = await runGitBuffer(
    worktreePath,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    signal,
  );
  const paths = stdout
    .toString('utf8')
    .split('\0')
    .filter(item => item.length > 0);

  for (const relativePath of paths) {
    if (findings.length >= MAX_SECRET_FINDINGS) {
      break;
    }
    const parsedPath = FactoryDiffPathSchema.safeParse(relativePath);
    if (!parsedPath.success) {
      continue;
    }
    const absolutePath = join(worktreePath, parsedPath.data);
    try {
      const entry = await lstat(absolutePath);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        continue;
      }
      const resolvedFile = await realpath(absolutePath);
      if (!resolvedFile.startsWith(`${worktreePath}/`)) {
        continue;
      }
      const text = readRegularUntrackedFile(resolvedFile);
      if (text === null) {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && findings.length < MAX_SECRET_FINDINGS; index += 1) {
        const line = lines[index];
        if (line !== undefined) {
          recordLineSecretFindings(findings, parsedPath.data, index + 1, line);
        }
      }
    } catch {
      signal.throwIfAborted();
    }
  }
}

/**
 * Executa secret scanning no diff completo do worktree (commits da branch + alterações pendentes
 * + arquivos untracked não ignorados), retornando arquivo e linha exatos dos suspeitos.
 */
export async function scanFactoryWorktreeSecrets(
  options: ScanWorktreeSecretsOptions,
  signal: AbortSignal,
): Promise<FactoryPrSecretFinding[]> {
  const worktreePath = assertExternalManagedWorktree(options.repoPath, options.worktreePath);
  if (basename(worktreePath) !== options.flowId || !(await lstat(join(worktreePath, '.git'))).isFile()) {
    throw new FactoryWorktreeError('WORKTREE_INVALID', 'O worktree isolado do fluxo é inválido.');
  }

  const baseCommit = await resolveScanBaseCommit(
    worktreePath,
    options.baseBranch,
    options.baselineSha,
    signal,
  );

  const findings: FactoryPrSecretFinding[] = [];
  const fullDiff = await runGitBuffer(
    worktreePath,
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--no-color',
      '--unified=0',
      baseCommit,
    ],
    signal,
  );

  if (!fullDiff.truncated) {
    findings.push(...scanUnifiedDiffForSecrets(fullDiff.stdout.toString('utf8')));
  } else {
    const changed = await runGitBuffer(
      worktreePath,
      ['diff', '--no-renames', '--name-only', '-z', baseCommit],
      signal,
    );
    const changedFiles = changed.stdout
      .toString('utf8')
      .split('\0')
      .filter(item => item.length > 0);
    for (const file of changedFiles) {
      if (findings.length >= MAX_SECRET_FINDINGS) {
        break;
      }
      const parsedPath = FactoryDiffPathSchema.safeParse(file);
      if (!parsedPath.success) {
        continue;
      }
      const fileDiff = await runGitBuffer(
        worktreePath,
        [
          '-c',
          'core.quotePath=false',
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--no-color',
          '--unified=0',
          baseCommit,
          '--',
          `:(top,literal)${parsedPath.data}`,
        ],
        signal,
      );
      findings.push(...scanUnifiedDiffForSecrets(fileDiff.stdout.toString('utf8')));
    }
  }

  await scanUntrackedFilesForSecrets(worktreePath, findings, signal);
  return findings;
}

async function runGitWriteCommand(
  worktreePath: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const { stdout } = await execFileAsync('git', ['-C', worktreePath, ...args], {
    timeout: GIT_WRITE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    signal,
    killSignal: 'SIGKILL',
    env: buildSanitizedGitEnv(true),
  });
  return stdout.trim();
}

/**
 * Cria um commit limpo caso existam alterações pendentes no worktree e faz `git push`
 * da branch dedicada para `origin`.
 */
export async function commitAndPushFactoryWorktree(
  options: CommitAndPushWorktreeOptions,
  signal: AbortSignal,
): Promise<CommitAndPushWorktreeResult> {
  const worktreePath = await verifyExistingFactoryWorktree({
    repoPath: options.repoPath,
    worktreePath: options.worktreePath,
  });

  try {
    const statusBefore = await runGitWriteCommand(worktreePath, ['status', '--porcelain'], signal);
    let createdCommit = false;

    if (statusBefore.length > 0) {
      await runGitWriteCommand(worktreePath, ['add', '-A'], signal);
      const stagedStatus = await runGitWriteCommand(worktreePath, ['status', '--porcelain'], signal);
      if (stagedStatus.length > 0) {
        const authorArgs = await resolveGitCommitAuthorArgs(worktreePath);
        await runGitWriteCommand(
          worktreePath,
          [...authorArgs, 'commit', '--no-verify', '-m', options.commitTitle],
          signal,
        );
        createdCommit = true;
      }
    }

    const commitSha = await runGitWriteCommand(
      worktreePath,
      ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
      signal,
    );
    await runGitWriteCommand(
      worktreePath,
      ['push', '-u', 'origin', `HEAD:refs/heads/${options.headBranch}`],
      signal,
    );

    return { commitSha, createdCommit };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof FactoryWorktreeError) {
      throw error;
    }
    throw new Error(`Falha ao preparar commit ou executar git push: ${formatExecError(error, 'erro desconhecido.')}`, {
      cause: error,
    });
  }
}

async function resolvePrProvider(
  worktreePath: string,
  explicitProvider: FactoryPrProvider | undefined,
  signal: AbortSignal,
): Promise<FactoryPrProvider> {
  if (explicitProvider) {
    return explicitProvider;
  }

  const envProvider = process.env.FACTORY_PR_PROVIDER?.trim().toLowerCase();
  if (envProvider === 'github' || envProvider === 'gitlab') {
    return envProvider;
  }

  try {
    const remoteUrl = await runGitWriteCommand(worktreePath, ['remote', 'get-url', 'origin'], signal);
    if (/gitlab/i.test(remoteUrl)) {
      return 'gitlab';
    }
  } catch {
    signal.throwIfAborted();
  }

  return 'github';
}

function extractCreatedPrMetadata(output: string): { prUrl: string; prNumber: number | null } | null {
  const urlMatches = output.match(/https?:\/\/[^\s<>"'`)\]]+/g);
  if (!urlMatches) {
    return null;
  }
  for (let index = urlMatches.length - 1; index >= 0; index -= 1) {
    const candidate = urlMatches[index];
    if (!candidate) {
      continue;
    }
    const parsed = PR_URL_SCHEMA.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }
    const numberMatch = /\/(?:pull|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(parsed.data);
    const parsedNumber = numberMatch?.[1] ? Number.parseInt(numberMatch[1], 10) : null;
    return {
      prUrl: parsed.data,
      prNumber:
        parsedNumber !== null && Number.isSafeInteger(parsedNumber) && parsedNumber > 0
          ? parsedNumber
          : null,
    };
  }
  return null;
}

/**
 * Abre o Pull Request / Merge Request no provedor configurado (`gh pr create` ou `glab mr create`)
 * aplicando título, corpo Markdown, `--draft` e reviewers confirmados.
 */
export async function createFactoryProviderPullRequest(
  options: CreateProviderPullRequestOptions,
  signal: AbortSignal,
): Promise<CreatedProviderPullRequest> {
  const provider = await resolvePrProvider(options.worktreePath, options.provider, signal);
  const useBodyFile =
    provider === 'github' && Buffer.byteLength(options.description, 'utf8') > MAX_INLINE_BODY_BYTES;
  let tempDir: string | null = null;

  try {
    let bodyArgs: string[];
    if (useBodyFile) {
      tempDir = mkdtempSync(join(tmpdir(), 'df-pr-body-'));
      const bodyFile = join(tempDir, 'pr-body.md');
      writeFileSync(bodyFile, options.description, { encoding: 'utf8', mode: 0o600 });
      bodyArgs = ['--body-file', bodyFile];
    } else if (provider === 'github') {
      bodyArgs = ['--body', options.description];
    } else {
      bodyArgs = ['--description', options.description];
    }

    const executable = provider === 'gitlab' ? 'glab' : 'gh';
    const args =
      provider === 'gitlab'
        ? [
            'mr',
            'create',
            '--target-branch',
            options.baseBranch,
            '--source-branch',
            options.headBranch,
            '--title',
            options.title,
            ...bodyArgs,
            '--yes',
            '--no-editor',
            ...(options.draft ? ['--draft'] : []),
            ...options.reviewers.flatMap(reviewer => ['--reviewer', reviewer]),
          ]
        : [
            'pr',
            'create',
            '--base',
            options.baseBranch,
            '--head',
            options.headBranch,
            '--title',
            options.title,
            ...bodyArgs,
            ...(options.draft ? ['--draft'] : []),
            ...options.reviewers.flatMap(reviewer => ['--reviewer', reviewer]),
          ];

    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd: options.worktreePath,
      timeout: PR_CLI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      signal,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        NO_COLOR: '1',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    const metadata = extractCreatedPrMetadata(`${stdout}\n${stderr}`);
    if (!metadata) {
      throw new Error(
        `A CLI "${executable}" encerrou sem retornar a URL do Pull Request criado.`,
      );
    }

    return {
      provider,
      prUrl: metadata.prUrl,
      prNumber: metadata.prNumber,
    };
  } catch (error) {
    signal.throwIfAborted();
    const label = provider === 'gitlab' ? 'glab mr create' : 'gh pr create';
    throw new Error(`Falha ao executar ${label}: ${formatExecError(error, 'erro desconhecido.')}`, {
      cause: error,
    });
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function resolveJiraRestCredentials(jiraContext: FactoryJiraContext): {
  baseUrl: string;
  authorization: string;
} {
  const configuredBaseUrl = process.env.JIRA_BASE_URL?.trim();
  let baseUrl = '';
  if (configuredBaseUrl) {
    baseUrl = configuredBaseUrl.replace(/\/+$/, '');
  } else if (jiraContext.url) {
    baseUrl = new URL(jiraContext.url).origin;
  }

  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new Error(
      'URL base do Jira não configurada. Defina JIRA_BASE_URL ou vincule a URL completa do card.',
    );
  }
  if (
    (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') ||
    parsedBase.username ||
    parsedBase.password
  ) {
    throw new Error('A URL base configurada para o Jira é inválida.');
  }

  const token =
    process.env.JIRA_API_TOKEN?.trim() || process.env.ATLASSIAN_API_TOKEN?.trim() || '';
  if (!token) {
    throw new Error(
      'Credenciais do Jira não configuradas no servidor (defina JIRA_API_TOKEN e JIRA_USER_EMAIL).',
    );
  }

  const email = process.env.JIRA_USER_EMAIL?.trim() || process.env.JIRA_EMAIL?.trim() || '';
  const authorization = email
    ? `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`
    : `Bearer ${token}`;

  return { baseUrl: parsedBase.toString().replace(/\/+$/, ''), authorization };
}

function buildJiraAdfComment(payload: JiraPrCommentPayload) {
  const prLabel = `${payload.provider === 'gitlab' ? 'Merge Request' : 'Pull Request'}${
    payload.prNumber ? ` #${payload.prNumber}` : ''
  }`;
  const content: Array<Record<string, unknown>> = [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: `${prLabel} publicado pela Development Factory: `, marks: [{ type: 'strong' }] },
        {
          type: 'text',
          text: payload.prUrl,
          marks: [{ type: 'link', attrs: { href: payload.prUrl } }],
        },
      ],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: `Título: ${payload.title} (${payload.headBranch} → ${payload.baseBranch}${
            payload.draft ? ' · Draft' : ''
          })`,
        },
      ],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: `Resumo: ${payload.summary}` }],
    },
  ];

  if (payload.satisfiedAcceptanceCriteriaIds.length > 0) {
    content.push({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: `Critérios de aceite atendidos: ${payload.satisfiedAcceptanceCriteriaIds.join(', ')}`,
        },
      ],
    });
  }

  if (payload.evidence.length > 0) {
    content.push({
      type: 'bulletList',
      content: payload.evidence.slice(0, 20).map(item => ({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: item }],
          },
        ],
      })),
    });
  }

  return {
    body: {
      type: 'doc',
      version: 1,
      content,
    },
  };
}

/** Publica comentário no card do Jira via API REST v3 com link do PR e resumo das evidências. */
export async function defaultSendJiraPrComment(
  payload: JiraPrCommentPayload,
  signal: AbortSignal,
): Promise<void> {
  const { baseUrl, authorization } = resolveJiraRestCredentials(payload.jiraContext);
  const endpoint = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(payload.jiraContext.key)}/comment`;
  const timeoutSignal = AbortSignal.timeout(JIRA_HTTP_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildJiraAdfComment(payload)),
    signal: combinedSignal,
  });

  if (!response.ok) {
    const bodyText = redactSecrets((await response.text().catch(() => '')).slice(0, 500)).trim();
    throw new Error(
      bodyText
        ? `Jira retornou HTTP ${response.status}: ${bodyText}`
        : `Jira retornou HTTP ${response.status} ao comentar no card ${payload.jiraContext.key}.`,
    );
  }
}

/** Executa a sincronização opcional do comentário no Jira capturando falhas sem descartar o PR criado. */
export async function syncFactoryPrWithJira(
  payload: JiraPrCommentPayload,
  updatedAt: string,
  sender: JiraCommentSender = defaultSendJiraPrComment,
  signal: AbortSignal = new AbortController().signal,
): Promise<FactoryPrJiraSync> {
  try {
    await sender(payload, signal);
    return {
      status: 'updated',
      issueKey: payload.jiraContext.key,
      updatedAt,
      error: null,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? redactSecrets(error.message).trim()
        : `Não foi possível comentar no card ${payload.jiraContext.key}.`;
    return {
      status: 'failed',
      issueKey: payload.jiraContext.key,
      updatedAt,
      error: (message || `Não foi possível comentar no card ${payload.jiraContext.key}.`).slice(
        0,
        2000,
      ),
    };
  }
}
