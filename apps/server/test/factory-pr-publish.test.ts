import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import {
  FactoryFlowApiErrorResponseSchema,
  FactoryFlowDetailsSchema,
  PublishFactoryPrResponseSchema,
  RetryFactoryPrJiraSyncResponseSchema,
} from '@development-factory/shared';
import { scanFactoryWorktreeSecrets, scanUnifiedDiffForSecrets } from '../src/factory-pr-publish.js';
import { provisionFactoryWorktree } from '../src/factory-worktree.js';
import { createReviewServer } from '../src/server.js';
import {
  planningMarkdown,
  triageMarkdown,
  writeFactoryStageSidecar,
} from './fixtures/factory-stage-artifacts.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function initRepoWithBareOrigin(rootDir: string, remoteUrlOverride?: string): {
  repoDir: string;
  bareRemoteDir: string;
} {
  const bareRemoteDir = join(rootDir, 'origin.git');
  const repoDir = join(rootDir, 'repo');
  mkdirSync(bareRemoteDir);
  mkdirSync(repoDir);

  execFileSync('git', ['init', '--bare', '-b', 'main', bareRemoteDir]);
  execFileSync('git', ['init', '-b', 'main', repoDir]);
  runGit(repoDir, 'config', 'user.email', 'factory-test@example.invalid');
  runGit(repoDir, 'config', 'user.name', 'Factory Test');
  runGit(repoDir, 'remote', 'add', 'origin', remoteUrlOverride ?? bareRemoteDir);
  writeFileSync(join(repoDir, 'README.md'), '# Repo\n');
  runGit(repoDir, 'add', 'README.md');
  runGit(repoDir, 'commit', '-m', 'chore: init repo');
  if (!remoteUrlOverride) {
    runGit(repoDir, 'push', '-u', 'origin', 'main');
  }
  return { repoDir, bareRemoteDir };
}

function writeExecutableCli(binDir: string, name: string, script: string): void {
  const target = join(binDir, name);
  writeFileSync(target, `#!${process.execPath}\n${script}\n`);
  chmodSync(target, 0o755);
}

test('scanUnifiedDiffForSecrets e scanFactoryWorktreeSecrets detectam arquivo e linha exatos no diff e untracked sem confundir conteúdo de hunk', async context => {
  const diffSample = [
    'diff --git a/src/sample.ts b/src/sample.ts',
    'index 1111111..2222222 100644',
    '--- a/src/sample.ts',
    '+++ b/src/sample.ts',
    '@@ -4,2 +4,3 @@',
    '-const oldSecret = "ghp_000000000000000000000000000000000000";',
    '+// +++ b/nao-e-cabecalho.ts',
    '+const safe = "ok";',
    '+const token = "ghp_1234567890abcdef1234567890abcdef1234";',
  ].join('\n');

  const diffFindings = scanUnifiedDiffForSecrets(diffSample);
  assert.equal(diffFindings.length, 1);
  assert.equal(diffFindings[0]?.file, 'src/sample.ts');
  assert.equal(diffFindings[0]?.line, 6);
  assert.equal(diffFindings[0]?.snippet.includes('ghp_1234567890'), false);
  assert.match(diffFindings[0]?.snippet ?? '', /\[REDACTED\]/);

  const rootDir = mkdtempSync(join(tmpdir(), 'df-secret-scan-'));
  const xdgDataHome = join(rootDir, 'xdg');
  mkdirSync(xdgDataHome);
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdgDataHome;
  context.after(() => {
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  const { repoDir } = initRepoWithBareOrigin(rootDir);
  const flowId = '00000000-0000-4000-8000-000000000731';
  const provisioned = await provisionFactoryWorktree({
    repoPath: repoDir,
    flowId,
    target: { inputType: 'jira_key', value: 'SEC-10' },
  });

  mkdirSync(join(provisioned.worktreePath, 'src'), { recursive: true });
  writeFileSync(
    join(provisioned.worktreePath, 'src', 'auth.ts'),
    ['export const ok = true;', 'const awsKey = "AKIAIOSFODNN7EXAMPLE";', ''].join('\n'),
  );
  runGit(provisioned.worktreePath, 'add', 'src/auth.ts');
  runGit(
    provisioned.worktreePath,
    '-c',
    'user.name=Dev',
    '-c',
    'user.email=dev@example.invalid',
    'commit',
    '-m',
    'feat: add auth',
  );

  writeFileSync(
    join(provisioned.worktreePath, 'src', 'untracked-key.pem'),
    ['# chave', '-----BEGIN RSA PRIVATE KEY-----', 'secret', '-----END RSA PRIVATE KEY-----'].join(
      '\n',
    ),
  );

  const findings = await scanFactoryWorktreeSecrets(
    {
      repoPath: repoDir,
      worktreePath: provisioned.worktreePath,
      flowId,
      baseBranch: 'main',
    },
    new AbortController().signal,
  );

  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map(item => ({ file: item.file, line: item.line })),
    [
      { file: 'src/auth.ts', line: 2 },
      { file: 'src/untracked-key.pem', line: 2 },
    ],
  );
  assert.equal(findings.some(item => item.snippet.includes('AKIAIOSFODNN7EXAMPLE')), false);
});

test('publicação determinística bloqueia segredos antes de push, cria commit/PR com mocks de CLI e permite reenvio ao Jira após falha', { timeout: 30_000 }, async context => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-pr-publish-e2e-'));
  const binDir = join(rootDir, 'bin');
  const artifactsDir = join(rootDir, 'artifacts');
  const xdgDataHome = join(rootDir, 'xdg');
  const dbPath = join(rootDir, 'reviews.db');
  const cliLogPath = join(rootDir, 'gh-calls.json');
  mkdirSync(binDir);
  mkdirSync(artifactsDir);
  mkdirSync(xdgDataHome);

  const { repoDir, bareRemoteDir } = initRepoWithBareOrigin(rootDir);

  const jiraRequests: Array<{ url: string; auth: string; body: unknown }> = [];
  let jiraShouldFail = true;
  const jiraServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    jiraRequests.push({
      url: req.url ?? '',
      auth: req.headers.authorization ?? '',
      body: rawBody ? JSON.parse(rawBody) : null,
    });
    if (jiraShouldFail) {
      res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Jira indisponível' }));
      return;
    }
    res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: '9001' }));
  });
  jiraServer.listen(0, '127.0.0.1');
  await once(jiraServer, 'listening');
  const jiraAddr = jiraServer.address();
  assert(jiraAddr && typeof jiraAddr !== 'string');
  const jiraBaseUrl = `http://127.0.0.1:${jiraAddr.port}`;

  writeExecutableCli(
    binDir,
    'gh',
    `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(cliLogPath)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
console.log('https://github.com/org/development-factory/pull/88');
`,
  );

  const previousPath = process.env.PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  const previousJiraBase = process.env.JIRA_BASE_URL;
  const previousJiraEmail = process.env.JIRA_USER_EMAIL;
  const previousJiraToken = process.env.JIRA_API_TOKEN;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ''}`;
  process.env.XDG_DATA_HOME = xdgDataHome;
  process.env.JIRA_BASE_URL = jiraBaseUrl;
  process.env.JIRA_USER_EMAIL = 'bot@example.invalid';
  process.env.JIRA_API_TOKEN = 'secret-jira-token-12345';

  const { server, factoryFlowService, shutdown } = createReviewServer({ dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const serverAddr = server.address();
  assert(serverAddr && typeof serverAddr !== 'string');
  const baseUrl = `http://127.0.0.1:${serverAddr.port}`;

  context.after(async () => {
    await shutdown();
    await new Promise<void>(resolve => jiraServer.close(() => resolve()));
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    if (previousJiraBase === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = previousJiraBase;
    if (previousJiraEmail === undefined) delete process.env.JIRA_USER_EMAIL;
    else process.env.JIRA_USER_EMAIL = previousJiraEmail;
    if (previousJiraToken === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = previousJiraToken;
    rmSync(rootDir, { recursive: true, force: true });
  });

  const created = await factoryFlowService.createFlow({
    task: { inputType: 'jira_key', value: 'PROD-730', repoPath: repoDir },
    baseBranch: 'main',
  });
  const flowId = created.flow.id;

  const provisioned = await provisionFactoryWorktree({
    repoPath: repoDir,
    flowId,
    target: created.flow.target,
    baseBranch: 'main',
  });
  await factoryFlowService.updateWorktreeMetadata(flowId, {
    worktreePath: provisioned.worktreePath,
    branchName: provisioned.branchName,
    baseBranch: provisioned.baseBranch,
  });

  const specPath = join(artifactsDir, 'spec.md');
  const planPath = join(artifactsDir, 'plan.md');
  const devPath = join(artifactsDir, 'dev.md');
  const testsPath = join(artifactsDir, 'tests.md');
  const reviewPath = join(artifactsDir, 'review.md');
  const prPath = join(artifactsDir, 'pr.md');

  writeFileSync(specPath, triageMarkdown('Publicação do PR.'));
  writeFactoryStageSidecar(specPath, 'triage', {
    jiraContext: { key: 'PROD-730', url: 'https://empresa.atlassian.net/browse/PROD-730' },
  });
  writeFileSync(planPath, planningMarkdown('Plano objetivo.'));
  writeFactoryStageSidecar(planPath, 'planning');
  writeFileSync(
    devPath,
    '# Relatório de Implementação\n## Arquivos alterados\n- src/feature.ts\n## Resumo das mudanças\nOk.\n## Status dos passos do plano\n| Passo | Status | Obs |\n| --- | --- | --- |\n| 1 | Concluído | Ok |\n',
  );
  writeFactoryStageSidecar(devPath, 'development');
  writeFileSync(
    testsPath,
    '# Relatório de Testes\n## Arquivos de teste alterados\n- test/feature.test.ts\n## Comandos executados\n- npm test\n## Resultados e cobertura\nPASS\n',
  );
  writeFactoryStageSidecar(testsPath, 'tests');
  writeFileSync(
    reviewPath,
    '# Relatório de Code Review\n## Resumo Executivo\nOk\n## Pontos Encontrados\nNenhum\n## Parecer Final\nVeredito: APROVADO PARA PR\n',
  );
  writeFactoryStageSidecar(reviewPath, 'review');
  writeFileSync(
    prPath,
    '# Resumo do Pull Request\n## Resumo das Alterações\nEntrega pronta.\n## Validação e Evidências\n| ID | Critério de Aceite | Status | Evidência |\n| --- | --- | --- | --- |\n| CA1 | Validar entrega | Atendido | npm test (exitCode 0) |\n## Dados do Pull Request\nTítulo: feat(pr): entrega final\n',
  );
  writeFactoryStageSidecar(prPath, 'pr', {
    title: 'feat(pr): entrega final',
    baseBranch: 'main',
    headBranch: provisioned.branchName,
    satisfiedAcceptanceCriteriaIds: ['CA1'],
    evidence: ['npm test (exitCode 0)'],
  });

  await factoryFlowService.registerArtifact(flowId, { stage: 'triage', kind: 'specification', path: specPath, status: 'ready' });
  await factoryFlowService.transitionFlow(flowId, { to: 'running', reason: 'Triagem' });
  await factoryFlowService.transitionFlow(flowId, { to: 'waiting_action', reason: 'Triagem ok' });
  await factoryFlowService.advanceStage(flowId);
  await factoryFlowService.registerArtifact(flowId, { stage: 'planning', kind: 'plan', path: planPath, status: 'ready' });
  await factoryFlowService.transitionFlow(flowId, { to: 'waiting_action', reason: 'Plano ok' });
  await factoryFlowService.advanceStage(flowId);
  await factoryFlowService.registerArtifact(flowId, { stage: 'development', kind: 'implementation_report', path: devPath, status: 'ready' });
  await factoryFlowService.advanceStage(flowId);
  await factoryFlowService.registerArtifact(flowId, { stage: 'tests', kind: 'test_report', path: testsPath, status: 'ready' });
  await factoryFlowService.advanceStage(flowId);
  await factoryFlowService.registerArtifact(flowId, { stage: 'review', kind: 'review_report', path: reviewPath, status: 'ready' });
  await factoryFlowService.advanceStage(flowId);
  await factoryFlowService.registerArtifact(flowId, { stage: 'pr', kind: 'pr_summary', path: prPath, status: 'ready' });

  // Sem confirmação explícita na Etapa 2, publicação é recusada.
  const unconfirmedRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/pr-publish`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(unconfirmedRes.status, 409);

  // Salva revisão confirmada.
  const confirmRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/pr-review`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'feat(prod-730): entrega revisada pelo humano',
      description: '## Resumo\n\nEntrega validada.',
      baseBranch: 'main',
      draft: true,
      reviewers: ['alice', 'org/core'],
      updateJira: true,
      confirmPublish: true,
    }),
  });
  assert.equal(confirmRes.status, 200);

  // Adiciona segredo no worktree: publicação deve abortar antes de git push e gh pr create.
  mkdirSync(join(provisioned.worktreePath, 'src'), { recursive: true });
  writeFileSync(
    join(provisioned.worktreePath, 'src', 'config.ts'),
    ['export const env = "prod";', 'export const ghSecret = "ghp_1234567890abcdef1234567890abcdef1234";', ''].join('\n'),
  );

  const blockedRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/pr-publish`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(blockedRes.status, 409);
  const blockedError = FactoryFlowApiErrorResponseSchema.parse(await blockedRes.json());
  assert.equal(blockedError.error.code, 'FACTORY_FLOW_SECRET_DETECTED');
  assert.match(blockedError.error.message, /src\/config\.ts:2/);
  assert.equal(existsSync(cliLogPath), false);
  assert.equal(
    execFileSync('git', ['ls-remote', '--heads', bareRemoteDir, provisioned.branchName], {
      encoding: 'utf8',
    }).trim(),
    '',
  );

  const detailsAfterBlock = FactoryFlowDetailsSchema.parse(
    await (await fetch(`${baseUrl}/api/factory/flows/${flowId}`, { headers: { Origin: ALLOWED_ORIGIN } })).json(),
  );
  assert.equal(detailsAfterBlock.prGate?.prPublication?.status, 'blocked_by_secrets');
  assert.equal(detailsAfterBlock.prGate?.prPublication?.secretFindings[0]?.file, 'src/config.ts');
  assert.equal(detailsAfterBlock.prGate?.prPublication?.secretFindings[0]?.line, 2);

  // Remove segredo deixando alteração limpa pendente para o commit automático da publicação.
  writeFileSync(
    join(provisioned.worktreePath, 'src', 'config.ts'),
    ['export const env = "prod";', 'export const featureEnabled = true;', ''].join('\n'),
  );

  // Publica PR com falha simulada no Jira (HTTP 503): PR deve ser criado e salvo, sem perda.
  const publishRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/pr-publish`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(publishRes.status, 200);
  const published = PublishFactoryPrResponseSchema.parse(await publishRes.json());
  assert.equal(published.flow.state, 'completed');
  assert.equal(published.flow.worktreePath, null);
  assert.equal(published.publication.status, 'published');
  assert.equal(published.publication.provider, 'github');
  assert.equal(published.publication.prUrl, 'https://github.com/org/development-factory/pull/88');
  assert.equal(published.publication.prNumber, 88);
  assert.equal(published.publication.draft, true);
  assert.equal(published.publication.jiraSync.status, 'failed');
  assert.match(published.publication.jiraSync.error ?? '', /503/);
  assert.equal(existsSync(provisioned.worktreePath), false);

  // Verifica commit limpo e push da branch dedicada no remoto bare.
  const remoteHeads = execFileSync(
    'git',
    ['ls-remote', '--heads', bareRemoteDir, provisioned.branchName],
    { encoding: 'utf8' },
  ).trim();
  assert.ok(remoteHeads.startsWith(published.publication.commitSha ?? 'missing'));
  const remoteCommitMsg = execFileSync(
    'git',
    ['--git-dir', bareRemoteDir, 'log', '-1', '--pretty=%s', `refs/heads/${provisioned.branchName}`],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(remoteCommitMsg, 'feat(prod-730): entrega revisada pelo humano');

  // Verifica argumentos exatos recebidos por gh pr create.
  const ghCalls = readFileSync(cliLogPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { cwd: string; args: string[] });
  assert.equal(ghCalls.length, 1);
  assert.deepEqual(ghCalls[0]?.args, [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    provisioned.branchName,
    '--title',
    'feat(prod-730): entrega revisada pelo humano',
    '--body',
    '## Resumo\n\nEntrega validada.',
    '--draft',
    '--reviewer',
    'alice',
    '--reviewer',
    'org/core',
  ]);

  // Reenvio do comentário ao Jira após recuperação do serviço mantém o PR salvo.
  jiraShouldFail = false;
  const retryRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/pr-jira-retry`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(retryRes.status, 200);
  const retried = RetryFactoryPrJiraSyncResponseSchema.parse(await retryRes.json());
  assert.equal(retried.publication.prUrl, 'https://github.com/org/development-factory/pull/88');
  assert.equal(retried.publication.jiraSync.status, 'updated');
  assert.equal(retried.publication.jiraSync.issueKey, 'PROD-730');
  assert.equal(retried.publication.jiraSync.error, null);
  assert.equal(jiraRequests.length, 2);
  assert.equal(jiraRequests[1]?.url, '/rest/api/3/issue/PROD-730/comment');
  assert.match(jiraRequests[1]?.auth ?? '', /^Basic /);
  assert.match(JSON.stringify(jiraRequests[1]?.body), /github\.com\/org\/development-factory\/pull\/88/);
  assert.match(JSON.stringify(jiraRequests[1]?.body), /npm test \(exitCode 0\)/);
});

test('publicação determinística suporta provedor GitLab via glab mr create', async context => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-pr-gitlab-'));
  const binDir = join(rootDir, 'bin');
  const artifactsDir = join(rootDir, 'artifacts');
  const xdgDataHome = join(rootDir, 'xdg');
  const dbPath = join(rootDir, 'reviews.db');
  const glabLogPath = join(rootDir, 'glab-calls.json');
  mkdirSync(binDir);
  mkdirSync(artifactsDir);
  mkdirSync(xdgDataHome);

  const { repoDir } = initRepoWithBareOrigin(rootDir);

  writeExecutableCli(
    binDir,
    'glab',
    `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(glabLogPath)}, JSON.stringify({ args }) + '\\n');
console.log('https://gitlab.com/org/factory/-/merge_requests/19');
`,
  );

  const previousPath = process.env.PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ''}`;
  process.env.XDG_DATA_HOME = xdgDataHome;

  const { server, factoryFlowService, shutdown } = createReviewServer({ dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const serverAddr = server.address();
  assert(serverAddr && typeof serverAddr !== 'string');
  const baseUrl = `http://127.0.0.1:${serverAddr.port}`;

  context.after(async () => {
    await shutdown();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    rmSync(rootDir, { recursive: true, force: true });
  });

  const created = await factoryFlowService.createFlow({
    task: { inputType: 'title', value: 'Entrega GitLab', repoPath: repoDir },
    baseBranch: 'main',
  });
  const flowId = created.flow.id;
  const provisioned = await provisionFactoryWorktree({
    repoPath: repoDir,
    flowId,
    target: created.flow.target,
    baseBranch: 'main',
  });
  await factoryFlowService.updateWorktreeMetadata(flowId, {
    worktreePath: provisioned.worktreePath,
    branchName: provisioned.branchName,
    baseBranch: provisioned.baseBranch,
  });

  const specPath = join(artifactsDir, 'spec.md');
  const planPath = join(artifactsDir, 'plan.md');
  const devPath = join(artifactsDir, 'dev.md');
  const testsPath = join(artifactsDir, 'tests.md');
  const reviewPath = join(artifactsDir, 'review.md');
  const prPath = join(artifactsDir, 'pr.md');

  writeFileSync(specPath, triageMarkdown('Entrega GitLab.'));
  writeFactoryStageSidecar(specPath, 'triage', { jiraContext: null });
  writeFileSync(planPath, planningMarkdown('Plano.'));
  writeFactoryStageSidecar(planPath, 'planning');
  writeFileSync(devPath, '# Relatório de Implementação\n## Arquivos alterados\n- a.ts\n## Resumo das mudanças\nOk.\n## Status dos passos do plano\n| Passo | Status | Obs |\n| --- | --- | --- |\n| 1 | Concluído | Ok |\n');
  writeFactoryStageSidecar(devPath, 'development');
  writeFileSync(testsPath, '# Relatório de Testes\n## Arquivos de teste alterados\n- a.test.ts\n## Comandos executados\n- npm test\n## Resultados e cobertura\nPASS\n');
  writeFactoryStageSidecar(testsPath, 'tests');
  writeFileSync(reviewPath, '# Relatório de Code Review\n## Resumo Executivo\nOk\n## Pontos Encontrados\nNenhum\n## Parecer Final\nVeredito: APROVADO PARA PR\n');
  writeFactoryStageSidecar(reviewPath, 'review');
  writeFileSync(prPath, '# Resumo do Pull Request\n## Resumo das Alterações\nOk.\n## Validação e Evidências\n| ID | Critério | Status | Evidência |\n| --- | --- | --- | --- |\n| CA1 | Ok | Atendido | PASS |\n## Dados do Pull Request\nTítulo: feat: gitlab mr\n');
  writeFactoryStageSidecar(prPath, 'pr', {
    title: 'feat: gitlab mr',
    baseBranch: 'main',
    headBranch: provisioned.branchName,
  });

  await factoryFlowService.registerArtifact(flowId, { stage: 'triage', kind: 'specification', path: specPath, status: 'ready' });
  await factoryFlowService.transitionFlow(flowId, { to: 'running', reason: 'Triagem' });
  await factoryFlowService.transitionFlow(flowId, { to: 'waiting_action', reason: 'Triagem ok' });
  await factoryFlowService.advanceStage(flowId);
  await factoryFlowService.registerArtifact(flowId, { stage: 'planning', kind: 'plan', path: planPath, status: 'ready' });
  await factoryFlowService.transitionFlow(flowId, { to: 'waiting_action', reason: 'Plano ok' });
  await factoryFlowService.advanceStage(flowId);
  await factoryFlowService.registerArtifact(flowId, { stage: 'development', kind: 'implementation_report', path: devPath, status: 'ready' });
  await factoryFlowService.advanceStage(flowId);
  await factoryFlowService.registerArtifact(flowId, { stage: 'tests', kind: 'test_report', path: testsPath, status: 'ready' });
  await factoryFlowService.advanceStage(flowId);
  await factoryFlowService.registerArtifact(flowId, { stage: 'review', kind: 'review_report', path: reviewPath, status: 'ready' });
  await factoryFlowService.advanceStage(flowId);
  await factoryFlowService.registerArtifact(flowId, { stage: 'pr', kind: 'pr_summary', path: prPath, status: 'ready' });

  await factoryFlowService.savePrReview(flowId, {
    title: 'feat(gitlab): abrir merge request',
    description: '## Resumo\n\nMR GitLab.',
    baseBranch: 'main',
    draft: false,
    reviewers: ['bob'],
    updateJira: false,
    confirmPublish: true,
  });

  writeFileSync(join(provisioned.worktreePath, 'README.md'), '# Repo alterado\n');

  const publishRes = await fetch(`${baseUrl}/api/factory/flows/${flowId}/pr-publish`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gitlab' }),
  });
  assert.equal(publishRes.status, 200);
  const published = PublishFactoryPrResponseSchema.parse(await publishRes.json());
  assert.equal(published.publication.provider, 'gitlab');
  assert.equal(published.publication.prUrl, 'https://gitlab.com/org/factory/-/merge_requests/19');
  assert.equal(published.publication.prNumber, 19);

  const glabCalls = readFileSync(glabLogPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { args: string[] });
  assert.equal(glabCalls.length, 1);
  assert.deepEqual(glabCalls[0]?.args, [
    'mr',
    'create',
    '--target-branch',
    'main',
    '--source-branch',
    provisioned.branchName,
    '--title',
    'feat(gitlab): abrir merge request',
    '--description',
    '## Resumo\n\nMR GitLab.',
    '--yes',
    '--no-editor',
    '--reviewer',
    'bob',
  ]);
});
