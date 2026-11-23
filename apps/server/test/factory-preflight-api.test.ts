import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  FactoryFlowApiErrorResponseSchema,
  FactoryPreflightResponseSchema,
} from '@development-factory/shared';
import type { FactoryPreflightRequest } from '@development-factory/shared';
import { createReviewServer } from '../src/server.js';

const ORIGIN = 'http://localhost:5173';
const PRIVATE_CLI_OUTPUT = 'conteúdo interno da CLI';

function runGit(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();
}

function writeCli(binDir: string, name: string, script: string): void {
  writeFileSync(join(binDir, name), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
}

async function startFixture(
  context: TestContext,
  options: { github?: 'unauthenticated' | 'timeout'; jiraStatus?: string } = {},
) {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-preflight-'));
  const repoPath = join(rootDir, 'git repo');
  const binDir = join(rootDir, 'bin');
  const previousPath = process.env.PATH;
  let stopServer: (() => Promise<void>) | undefined;
  context.after(async () => {
    try {
      await stopServer?.();
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  mkdirSync(repoPath);
  mkdirSync(binDir);
  runGit(repoPath, 'init', '-q', '-b', 'main');
  writeFileSync(join(repoPath, 'source.txt'), 'Arquivo versionado\n');
  runGit(repoPath, 'add', 'source.txt');
  runGit(
    repoPath,
    '-c',
    'user.name=Preflight Test',
    '-c',
    'user.email=preflight@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'Inicializa repositório',
  );

  const jiraStatus = JSON.stringify(options.jiraStatus ?? '✓ Connected');
  writeCli(binDir, 'claude', `
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log('2.1.0 (Claude Code)');
} else if (JSON.stringify(args) === '["mcp","get","claude.ai Atlassian Rovo"]') {
  if (process.cwd() !== ${JSON.stringify(repoPath)}) {
    process.exit(2);
  }
  console.log('claude.ai Atlassian Rovo:\\n  Status: ' + ${jiraStatus});
} else {
  process.exitCode = 2;
}`);

  const githubMode = JSON.stringify(options.github ?? 'authenticated');
  writeCli(binDir, 'gh', `
const args = process.argv.slice(2);
const mode = ${githubMode};
if (args.length !== 2 || args[0] !== 'auth' || args[1] !== 'status') {
  process.exit(2);
}
if (mode === 'timeout') {
  setInterval(() => {}, 1000);
} else if (mode === 'unauthenticated') {
  console.error(${JSON.stringify(PRIVATE_CLI_OUTPUT)});
  process.exitCode = 1;
}`);

  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ''}`;
  const { server, shutdown } = createReviewServer({ dbPath: join(rootDir, 'reviews.db') });
  stopServer = shutdown;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { rootDir, repoPath, endpoint: `http://127.0.0.1:${address.port}/api/factory/preflight` };
}

function postPreflight(endpoint: string, body: unknown, origin = ORIGIN): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
}

async function preflight(endpoint: string, input: FactoryPreflightRequest) {
  const response = await postPreflight(endpoint, input);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  return FactoryPreflightResponseSchema.parse(await response.json());
}

test('Preflight valida o ambiente com Jira e usa a branch do perfil ou a base explícita', async context => {
  const { repoPath, endpoint } = await startFixture(context);
  runGit(repoPath, 'update-ref', 'refs/remotes/origin/release', 'HEAD');
  writeFileSync(join(repoPath, '.development-factory.json'), '{"baseBranch":"release"}');
  const statusBefore = runGit(repoPath, 'status', '--porcelain');

  const result = await preflight(endpoint, { repoPath, inputType: 'jira_url' });

  assert.equal(result.blocked, false);
  for (const check of Object.values(result.checks)) {
    assert.equal(check.status, 'ok');
  }
  assert.match(result.checks.git.message, /release/);
  assert.match(result.checks.profile.message, /\.development-factory\.json/);

  const override = await preflight(endpoint, { repoPath, inputType: 'jira_key', baseBranch: 'main' });
  assert.equal(override.blocked, false);
  assert.match(override.checks.git.message, /main/);
  assert.equal(runGit(repoPath, 'status', '--porcelain'), statusBefore);
});

test('Preflight avisa sobre falta de autenticação no GitHub e requer Jira apenas quando aplicável', async context => {
  const { repoPath, endpoint } = await startFixture(context, {
    github: 'unauthenticated',
    jiraStatus: '✘ Failed to connect',
  });

  const titleResult = await preflight(endpoint, { repoPath, inputType: 'title' });
  assert.equal(titleResult.blocked, false);
  assert.equal(titleResult.checks.github.status, 'warning');
  assert.match(titleResult.checks.github.message, /gh auth login/);
  assert.doesNotMatch(JSON.stringify(titleResult), new RegExp(PRIVATE_CLI_OUTPUT));
  assert.equal(titleResult.checks.jiraMcp.status, 'ok');
  assert.match(titleResult.checks.profile.message, /perfil padrão/);
  assert.match(titleResult.checks.git.message, /main/);

  const jiraResult = await preflight(endpoint, { repoPath, inputType: 'jira_key' });
  assert.equal(jiraResult.blocked, true);
  assert.equal(jiraResult.checks.jiraMcp.status, 'error');
  assert.match(jiraResult.checks.jiraMcp.message, /Atlassian Rovo/);
});

test('Preflight aceita o formato real de saída do Claude Code para Jira MCP conectado', async context => {
  const { repoPath, endpoint } = await startFixture(context, {
    jiraStatus: '\u001b[35m✔\u001b[39m Connected',
  });

  const result = await preflight(endpoint, { repoPath, inputType: 'jira_url' });
  assert.equal(result.blocked, false);
  assert.equal(result.checks.jiraMcp.status, 'ok');
});

test('Preflight bloqueia repositório inválido, manifesto corrompido e branch base ausente', async context => {
  const { rootDir, repoPath, endpoint } = await startFixture(context);
  const notGit = await preflight(endpoint, { repoPath: rootDir, inputType: 'title' });
  assert.equal(notGit.blocked, true);
  assert.equal(notGit.checks.git.status, 'error');
  assert.equal(notGit.checks.claude.status, 'ok');

  const manifestPath = join(repoPath, '.development-factory.json');
  writeFileSync(manifestPath, '{"baseBranch":');
  const invalidManifest = await preflight(endpoint, { repoPath, inputType: 'title' });
  assert.equal(invalidManifest.blocked, true);
  assert.equal(invalidManifest.checks.profile.status, 'error');
  assert.match(invalidManifest.checks.profile.message, /JSON inválido/);
  assert.equal(invalidManifest.checks.git.status, 'ok');

  writeFileSync(manifestPath, '{"baseBranch":"ausente"}');
  const missingBranch = await preflight(endpoint, { repoPath, inputType: 'title' });
  assert.equal(missingBranch.blocked, true);
  assert.equal(missingBranch.checks.git.status, 'error');
  assert.match(missingBranch.checks.git.message, /branch base "ausente"/);
  assert.equal(missingBranch.checks.profile.status, 'ok');
});

test('Preflight bloqueia um lock de worktree e objetos Git corrompidos', async context => {
  const { rootDir, repoPath, endpoint } = await startFixture(context);
  const worktree = join(rootDir, 'worktree');
  runGit(repoPath, 'worktree', 'add', '-qb', 'isolada', worktree);
  const indexPath = runGit(worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  const lock = `${indexPath}.lock`;
  writeFileSync(lock, '');

  const locked = await preflight(endpoint, { repoPath: worktree, inputType: 'title' });
  assert.equal(locked.blocked, true);
  assert.equal(locked.checks.git.status, 'error');
  assert.match(locked.checks.git.message, /index\.lock/);
  rmSync(lock);

  const blob = runGit(repoPath, 'rev-parse', 'HEAD:source.txt');
  const blobPath = join(repoPath, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  chmodSync(blobPath, 0o600);
  writeFileSync(blobPath, 'inválido');
  const corrupt = await preflight(endpoint, { repoPath, inputType: 'title' });
  assert.equal(corrupt.blocked, true);
  assert.equal(corrupt.checks.git.status, 'error');
  assert.match(corrupt.checks.git.message, /git fsck/);
});

test('Preflight retorna as demais verificações quando o GitHub CLI demora', { timeout: 12_000 }, async context => {
  const { repoPath, endpoint } = await startFixture(context, { github: 'timeout' });
  const result = await preflight(endpoint, { repoPath, inputType: 'title' });

  assert.equal(result.blocked, false);
  assert.equal(result.checks.git.status, 'ok');
  assert.equal(result.checks.github.status, 'warning');
  assert.match(result.checks.github.message, /tempo limite/);
});

test('Preflight aplica as regras de origem e valida o corpo da requisição', async context => {
  const { repoPath, endpoint } = await startFixture(context);
  const forbidden = await postPreflight(endpoint, { repoPath, inputType: 'title' }, 'https://example.com');
  assert.equal(forbidden.status, 403);
  const forbiddenBody = FactoryFlowApiErrorResponseSchema.parse(await forbidden.json());
  assert.equal(forbiddenBody.error.code, 'ORIGIN_FORBIDDEN');

  const invalid = await postPreflight(endpoint, { repoPath: 'relativo', inputType: 'title' });
  assert.equal(invalid.status, 400);
  const invalidBody = FactoryFlowApiErrorResponseSchema.parse(await invalid.json());
  assert.equal(invalidBody.error.code, 'FACTORY_FLOW_INVALID_INPUT');
  assert.match(invalidBody.error.details?.join(' ') ?? '', /repoPath/);
});
