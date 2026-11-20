import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import {
  ClientMessageSchema,
  HistoryFileSchema,
  ServerMessageSchema,
  type ServerMessage,
} from '@development-factory/shared';
import {
  FACTORY_ARCHITECTURE_SYSTEM_PROMPT,
  buildFactoryArchitecturePrompt,
} from '../src/prompts/factory-architecture.js';
import { buildFactoryPlanPrompt } from '../src/prompts/factory-plan.js';
import {
  FACTORY_REVIEW_SYSTEM_PROMPT,
  REVIEW_REPORT_SECTIONS,
  REVIEW_REPORT_TITLE,
  buildFactoryReviewPrompt,
} from '../src/prompts/factory-review.js';
import {
  FACTORY_TESTS_SYSTEM_PROMPT,
  TEST_REPORT_SECTIONS,
  TEST_REPORT_TITLE,
  buildFactoryTestsPrompt,
} from '../src/prompts/factory-tests.js';
import { buildReviewRunnerArgs, isReviewReport } from '../src/factory-review.js';
import { buildTestsRunnerArgs, isTestReport } from '../src/factory-tests.js';
import { createReviewServer } from '../src/server.js';

async function until<T>(probe: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = probe();
    if (result !== undefined) return result;
    await delay(15);
  }
  throw new Error(`Timeout: ${label}`);
}

test('ClientMessageSchema valida entradas de start_factory', () => {
  const validUrl = ClientMessageSchema.safeParse({
    type: 'start_factory',
    inputType: 'jira_url',
    value: 'https://empresa.atlassian.net/browse/PROD-1234',
    repoPath: '/tmp/repo',
    cols: 80,
    rows: 24,
  });
  assert.equal(validUrl.success, true);

  const invalidUrl = ClientMessageSchema.safeParse({
    type: 'start_factory',
    inputType: 'jira_url',
    value: 'nao-e-url',
    repoPath: '/tmp/repo',
    cols: 80,
    rows: 24,
  });
  assert.equal(invalidUrl.success, false);

  const validKey = ClientMessageSchema.safeParse({
    type: 'start_factory',
    inputType: 'jira_key',
    value: 'PROD-1234',
    repoPath: '/tmp/repo',
    cols: 80,
    rows: 24,
  });
  assert.equal(validKey.success, true);

  const invalidKey = ClientMessageSchema.safeParse({
    type: 'start_factory',
    inputType: 'jira_key',
    value: 'PROD',
    repoPath: '/tmp/repo',
    cols: 80,
    rows: 24,
  });
  assert.equal(invalidKey.success, false);

  const validTitle = ClientMessageSchema.safeParse({
    type: 'start_factory',
    inputType: 'title',
    value: 'Implementar roadmap inicial da fábrica',
    repoPath: '/tmp/repo',
    cols: 80,
    rows: 24,
  });
  assert.equal(validTitle.success, true);
});

test('buildFactoryPlanPrompt inclui tipo, valor e caminho do relatório', () => {
  const prompt = buildFactoryPlanPrompt('jira_key', 'PROD-1234', '/tmp/repo/.code-reviews/plano.md');
  assert(prompt.includes('Chave da tarefa no JIRA: "PROD-1234"'));
  assert(prompt.includes('/tmp/repo/.code-reviews/plano.md'));
});

test('buildFactoryArchitecturePrompt inclui saída do Bloco 1, destino e placeholder do Bloco 2', () => {
  const prompt = buildFactoryArchitecturePrompt({
    inputType: 'jira_key',
    value: 'PROD-1234',
    understandingDocument: '#### 1. Síntese Central (Core)\nQuando X, deve Y.',
    understandingReportPath: '/tmp/repo/.code-reviews/entendimento.md',
    reportPath: '/tmp/repo/.code-reviews/arquitetura.md',
  });
  assert(prompt.includes('Chave da tarefa no JIRA: "PROD-1234"'));
  assert(prompt.includes('/tmp/repo/.code-reviews/arquitetura.md'));
  assert(prompt.includes('/tmp/repo/.code-reviews/entendimento.md'));
  assert(prompt.includes('#### 1. Síntese Central (Core)'));
  assert(prompt.includes(FACTORY_ARCHITECTURE_SYSTEM_PROMPT));
});

test('buildFactoryArchitecturePrompt trata ausência de conteúdo prévio do Bloco 1', () => {
  const withPathOnly = buildFactoryArchitecturePrompt({
    inputType: 'title',
    value: 'Ajustar fluxo',
    understandingReportPath: '/tmp/repo/.code-reviews/entendimento.md',
  });
  assert(withPathOnly.includes('"/tmp/repo/.code-reviews/entendimento.md"'));

  const withoutBlockOne = buildFactoryArchitecturePrompt({
    inputType: 'title',
    value: 'Ajustar fluxo',
  });
  assert(withoutBlockOne.includes('Nenhum documento prévio do Bloco 1 foi localizado automaticamente.'));
});

test('prompts, runners e validadores das Etapas 04 (tests) e 05 (review) seguem contratos e permissões', () => {
  const testsPrompt = buildFactoryTestsPrompt({
    task: 'PROD-1234',
    understandingReportPath: '/tmp/repo/.code-reviews/spec.md',
    implementationPlanPath: '/tmp/repo/.code-reviews/plan.md',
    implementationReportPath: '/tmp/repo/.code-reviews/dev.md',
    approvedNotes: 'Priorizar casos de borda na autenticação',
    reportPath: '/tmp/repo/.code-reviews/tests-report.md',
  });
  assert(testsPrompt.includes(FACTORY_TESTS_SYSTEM_PROMPT));
  assert(testsPrompt.includes('/tmp/repo/.code-reviews/spec.md'));
  assert(testsPrompt.includes('/tmp/repo/.code-reviews/plan.md'));
  assert(testsPrompt.includes('/tmp/repo/.code-reviews/dev.md'));
  assert(testsPrompt.includes('Priorizar casos de borda na autenticação'));
  assert(testsPrompt.includes(`# ${TEST_REPORT_TITLE}`));
  for (const heading of Object.values(TEST_REPORT_SECTIONS)) {
    assert(testsPrompt.includes(`## ${heading}`));
  }

  const testsArgs = buildTestsRunnerArgs('/tmp/repo/.code-reviews/tests-report.md');
  assert(testsArgs.includes('--restricted'));
  assert.equal(testsArgs[testsArgs.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash');
  const testsAllowed = testsArgs[testsArgs.indexOf('--allowedTools') + 1] ?? '';
  assert(testsAllowed.includes('Bash'));
  assert(testsAllowed.includes('Edit(**/*.test.*)'));
  assert(testsAllowed.includes('Write(**/fixtures/**)'));
  assert(testsAllowed.includes('Edit(/.code-reviews/tests-report.md)'));
  assert.equal(testsAllowed.includes('Edit(**/*.ts)'), false);
  const testsDenied = testsArgs[testsArgs.indexOf('--disallowedTools') + 1] ?? '';
  assert(testsDenied.includes('Bash(git push*)'));
  assert(testsDenied.includes('Edit(**/.git/**)'));

  const validTestReport = [
    `# ${TEST_REPORT_TITLE}`,
    `## ${TEST_REPORT_SECTIONS.testFiles}`,
    '- tests/auth.test.ts',
    `## ${TEST_REPORT_SECTIONS.executedCommands}`,
    '- npm test (exit 0)',
    `## ${TEST_REPORT_SECTIONS.results}`,
    '10 testes passaram.',
  ].join('\n');
  assert.equal(isTestReport(validTestReport), true);
  assert.equal(isTestReport(`# ${TEST_REPORT_TITLE}\n\nIncompleto.`), false);

  const reviewPrompt = buildFactoryReviewPrompt({
    task: 'PROD-1234',
    understandingReportPath: '/tmp/repo/.code-reviews/spec.md',
    implementationPlanPath: '/tmp/repo/.code-reviews/plan.md',
    implementationReportPath: '/tmp/repo/.code-reviews/dev.md',
    testReportPath: '/tmp/repo/.code-reviews/tests-report.md',
    approvedNotes: 'Auditar exposição de tokens nos logs',
    reportPath: '/tmp/repo/.code-reviews/review-report.md',
  });
  assert(reviewPrompt.includes(FACTORY_REVIEW_SYSTEM_PROMPT));
  assert(reviewPrompt.includes('/tmp/repo/.code-reviews/tests-report.md'));
  assert(reviewPrompt.includes('Auditar exposição de tokens nos logs'));
  assert(reviewPrompt.includes(`# ${REVIEW_REPORT_TITLE}`));
  for (const heading of Object.values(REVIEW_REPORT_SECTIONS)) {
    assert(reviewPrompt.includes(`## ${heading}`));
  }

  const reviewArgs = buildReviewRunnerArgs('/tmp/repo/.code-reviews/review-report.md');
  assert(reviewArgs.includes('--restricted'));
  assert.equal(reviewArgs[reviewArgs.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash');
  const reviewAllowed = reviewArgs[reviewArgs.indexOf('--allowedTools') + 1] ?? '';
  assert(reviewAllowed.includes('Bash(git diff*)'));
  assert(reviewAllowed.includes('Bash(git status*)'));
  assert(reviewAllowed.includes('Bash(git log*)'));
  assert(reviewAllowed.includes('Edit(/.code-reviews/review-report.md)'));
  assert.equal(reviewAllowed.includes('Edit(**/*.test.*)'), false);
  assert.equal(reviewAllowed.includes('Edit(**/*.ts)'), false);
  assert.equal(reviewAllowed.split(',').includes('Bash'), false);

  const validReviewReport = [
    `# ${REVIEW_REPORT_TITLE}`,
    `## ${REVIEW_REPORT_SECTIONS.executiveSummary}`,
    'Alterações aderentes aos requisitos.',
    `## ${REVIEW_REPORT_SECTIONS.findings}`,
    'Nenhum bloqueador crítico encontrado.',
    `## ${REVIEW_REPORT_SECTIONS.verdict}`,
    'Aprovado para PR.',
  ].join('\n');
  assert.equal(isReviewReport(validReviewReport), true);
  assert.equal(isReviewReport(`# ${REVIEW_REPORT_TITLE}\n\nIncompleto.`), false);
});

test('start_factory executa PTY, salva plano em Markdown e permite leitura formatada via API', { timeout: 30000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-pty-'));
  const previousPath = process.env.PATH;
  const { server, shutdown } = createReviewServer({ dbPath: join(directory, 'reviews.db') });
  const sockets: WebSocket[] = [];

  context.after(async () => {
    sockets.forEach(socket => socket.terminate());
    shutdown();
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });

  await copyFile(new URL('./fixtures/claude.ts', import.meta.url), join(directory, 'claude'));
  await chmod(join(directory, 'claude'), 0o755);
  process.env.PATH = `${directory}:${previousPath ?? ''}`;

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws/terminal`;

  const socket = new WebSocket(wsUrl, { origin: 'http://localhost:5173' });
  sockets.push(socket);
  const messages: ServerMessage[] = [];
  let output = '';

  socket.on('message', raw => {
    const parsed = ServerMessageSchema.parse(JSON.parse(raw.toString()) as unknown);
    messages.push(parsed);
    if (parsed.type === 'output') {
      output += parsed.data;
    }
  });

  await once(socket, 'open');
  socket.send(JSON.stringify({
    type: 'start_factory',
    inputType: 'jira_key',
    value: 'PROD-1234',
    repoPath: directory,
    cols: 90,
    rows: 25,
  }));

  const pendingHistory = await until(
    () => messages.find((m): m is Extract<ServerMessage, { type: 'history' }> => m.type === 'history' && m.state === 'pending'),
    'history pending',
  );
  assert.equal(existsSync(pendingHistory.reportPath), true);

  await until(() => (output.includes('PROD-1234') ? true : undefined), 'prompt output');

  const planMarkdown = '# Plano PROD-1234\n\n## Resumo da tarefa\n- Implementar fluxo inicial.\n';
  writeFileSync(pendingHistory.reportPath, planMarkdown);

  await until(
    () => messages.find(m => m.type === 'history' && m.state === 'saved'),
    'history saved',
  );

  const fileParams = new URLSearchParams({
    path: dirname(pendingHistory.reportPath),
    name: basename(pendingHistory.reportPath),
  });
  const fileResponse = await fetch(`${httpUrl}/api/history/file?${fileParams.toString()}`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(fileResponse.status, 200);
  const fileData = HistoryFileSchema.parse(await fileResponse.json());
  assert.equal(fileData.content, planMarkdown);
  assert.equal(readFileSync(pendingHistory.reportPath, 'utf8'), planMarkdown);

  socket.close();
});
