import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import {
  ClientMessageSchema,
  FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
  HistoryFileSchema,
  ServerMessageSchema,
  type ServerMessage,
} from '@development-factory/shared';
import type { FactoryRepositoryProfile, FactoryStageName } from '@development-factory/shared';
import {
  FACTORY_ARCHITECTURE_SYSTEM_PROMPT,
  buildFactoryArchitecturePrompt,
} from '../src/prompts/factory-architecture.js';
import {
  IMPLEMENTATION_REPORT_SECTIONS,
  IMPLEMENTATION_REPORT_TITLE,
  buildFactoryDevelopmentPrompt,
} from '../src/prompts/factory-development.js';
import { buildFactoryPlanPrompt } from '../src/prompts/factory-plan.js';
import {
  FACTORY_PR_SYSTEM_PROMPT,
  PR_SUMMARY_SECTIONS,
  PR_SUMMARY_TITLE,
  buildFactoryPrPrompt,
} from '../src/prompts/factory-pr.js';
import {
  FACTORY_REVIEW_SYSTEM_PROMPT,
  REVIEW_REPORT_SECTIONS,
  REVIEW_REPORT_TITLE,
  REVIEW_VERDICT_LABELS,
  buildFactoryReviewPrompt,
} from '../src/prompts/factory-review.js';
import {
  FACTORY_TESTS_SYSTEM_PROMPT,
  TEST_REPORT_SECTIONS,
  TEST_REPORT_TITLE,
  buildFactoryTestsPrompt,
} from '../src/prompts/factory-tests.js';
import { buildDevelopmentRunnerArgs } from '../src/factory-development.js';
import { buildPrRunnerArgs, isPrSummary } from '../src/factory-pr.js';
import { loadFactoryRepositoryProfile } from '../src/factory-repository-profile.js';
import { buildReviewRunnerArgs, isReviewReport, parseReviewVerdict } from '../src/factory-review.js';
import { getFactoryStageSidecarPath } from '../src/factory-stage-runners.js';
import { buildTestsRunnerArgs, isTestReport } from '../src/factory-tests.js';
import { createReviewServer } from '../src/server.js';
import { triageMarkdown, writeFactoryStageSidecar } from './fixtures/factory-stage-artifacts.js';

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

function assertFactoryStageOutput(
  prompt: string,
  stage: FactoryStageName,
  reportPath: string,
  sidecarFields: readonly string[],
): void {
  const sidecarPath = getFactoryStageSidecarPath(reportPath);
  const versionRule =
    `Grave o número \`${FACTORY_STAGE_SIDECAR_CONTRACT_VERSION}\` em \`contractVersion\`.`;
  assert.ok(prompt.includes(`Grave o relatório Markdown em ${JSON.stringify(reportPath)}.`), stage);
  assert.ok(prompt.includes(`Grave o sidecar JSON em ${JSON.stringify(sidecarPath)}.`), stage);
  assert.ok(prompt.includes(versionRule), stage);
  assert.ok(prompt.includes(`Grave o texto \`"${stage}"\` em \`stage\`.`), stage);
  assert.match(prompt, /JSON puro em UTF-8/, stage);
  assert.match(prompt, /todos os campos listados e use somente as chaves\s+especificadas/, stage);
  assert.match(prompt, /Compare o sidecar com o relatório Markdown/, stage);
  for (const field of sidecarFields) {
    assert.ok(prompt.includes(`\`${field}\``), `${stage}.${field}`);
  }
}

test('buildFactoryPlanPrompt inclui a tarefa e o contrato dos artefatos de triagem', () => {
  const reportPath = '/tmp/factory-artifacts/flow-1/triagem fase.3.md';
  const prompt = buildFactoryPlanPrompt('jira_key', 'PROD-1234', reportPath);
  assert(prompt.includes('Chave da tarefa no JIRA: "PROD-1234"'));
  assertFactoryStageOutput(prompt, 'triage', reportPath, [
    'acceptanceCriteria',
    'id',
    'description',
    'negativeScope',
    'blockers',
    'jiraContext',
    'key',
    'url',
    'technicalContext',
  ]);
  assert.match(prompt, /Use IDs únicos.*mesmos IDs e descrições em Critérios de Aceite/);
  assert.match(prompt, /Use `null` em `jiraContext` quando não houver uma\s+chave confirmada/);
});

test('buildFactoryArchitecturePrompt descreve a entrada e a entrega do planejamento', () => {
  const reportPath = '/tmp/factory-artifacts/flow-1/arquitetura.md';
  const prompt = buildFactoryArchitecturePrompt({
    inputType: 'jira_key',
    value: 'PROD-1234',
    understandingDocument: '#### 1. Síntese Central (Core)\nQuando X, deve Y.',
    understandingReportPath: '/tmp/factory-artifacts/flow-1/entendimento.md',
    reportPath,
  });
  assert(prompt.includes('Chave da tarefa no JIRA: "PROD-1234"'));
  assert(prompt.includes('/tmp/factory-artifacts/flow-1/entendimento.md'));
  assert(prompt.includes('#### 1. Síntese Central (Core)'));
  assert(prompt.includes(FACTORY_ARCHITECTURE_SYSTEM_PROMPT));
  assertFactoryStageOutput(prompt, 'planning', reportPath, [
    'pendingDecisions',
    'question',
    'options',
    'recommendedOption',
    'plannedFiles',
    'testPlan',
  ]);
  assert.match(prompt, /pelo menos dois textos.*`recommendedOption` com o texto exato/);
  assert.match(prompt, /`plannedFiles`.*caminhos relativos ao repositório/);
});

test('buildFactoryArchitecturePrompt trata ausência de conteúdo prévio do Bloco 1', () => {
  const withPathOnly = buildFactoryArchitecturePrompt({
    inputType: 'title',
    value: 'Ajustar fluxo',
    understandingReportPath: '/tmp/factory-artifacts/flow-1/entendimento.md',
  });
  assert(withPathOnly.includes('"/tmp/factory-artifacts/flow-1/entendimento.md"'));

  const withoutBlockOne = buildFactoryArchitecturePrompt({
    inputType: 'title',
    value: 'Ajustar fluxo',
  });
  assert(withoutBlockOne.includes('Nenhum documento prévio do Bloco 1 foi localizado automaticamente.'));
});

function buildProfilePrompts(repositoryProfile?: FactoryRepositoryProfile) {
  const common = {
    task: 'Ajustar integração',
    understandingReportPath: '/tmp/triagem.md',
    implementationPlanPath: '/tmp/plano.md',
    implementationReportPath: '/tmp/desenvolvimento.md',
    repositoryProfile,
  };
  return {
    planning: buildFactoryArchitecturePrompt({
      inputType: 'title',
      value: common.task,
      understandingReportPath: common.understandingReportPath,
      reportPath: common.implementationPlanPath,
      repositoryProfile,
    }),
    development: buildFactoryDevelopmentPrompt({ ...common, reportPath: '/tmp/dev.md' }),
    tests: buildFactoryTestsPrompt({ ...common, reportPath: '/tmp/testes.md' }),
    pr: buildFactoryPrPrompt({
      ...common,
      testReportPath: '/tmp/testes.md',
      reviewReportPath: '/tmp/revisao.md',
      reportPath: '/tmp/pr.md',
    }),
  };
}

test('prompts dos Blocos 02, 03, 04 e 06 renderizam o perfil do manifesto', async context => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'df-prompt-profile-'));
  context.after(() => rm(repoRoot, { recursive: true, force: true }));
  const expectedContext = {
    stack: ['Rust', 'Clippy'],
    commands: {
      typecheck: ['cargo', 'check', '--workspace'],
      lint: ['cargo', 'clippy'],
      test: ['./scripts/test', '--filter', 'integração com espaços'],
      coverage: ['cargo', 'llvm-cov'],
    },
    protectedPaths: ['infra/**', 'Cargo.lock'],
    architectureRules: [
      'O domínio depende de interfaces.\nA infraestrutura implementa as interfaces.',
    ],
  };
  const template = '## Contexto do time\n\n## Evidências registradas';
  writeFileSync(
    join(repoRoot, '.development-factory.json'),
    JSON.stringify({ ...expectedContext, baseBranch: 'integration', prTemplate: template }),
  );

  const { profile } = await loadFactoryRepositoryProfile(repoRoot);
  const prompts = buildProfilePrompts(profile);
  for (const [stage, prompt] of Object.entries(prompts)) {
    assert.ok(prompt.includes(JSON.stringify(expectedContext, null, 2)), stage);
    assert.equal(prompt.includes(JSON.stringify(template)), stage === 'pr', stage);
  }
  assert.match(prompts.pr, /Branch de destino — "integration"/);
});

test('prompts sem manifesto orientam a consulta ao projeto e ao plano', async context => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'df-prompt-defaults-'));
  context.after(() => rm(repoRoot, { recursive: true, force: true }));
  const { profile } = await loadFactoryRepositoryProfile(repoRoot);

  const prompts = buildProfilePrompts(profile);
  assert.deepEqual(prompts, buildProfilePrompts());
  for (const [stage, prompt] of Object.entries(prompts)) {
    assert.match(prompt, /consulte os arquivos de configuração do repositório/, stage);
    assert.match(prompt, /"stack": \[\]/, stage);
    assert.match(prompt, /"test": null/, stage);
    assert.match(prompt, /"protectedPaths": \[\]/, stage);
    assert.match(prompt, /"architectureRules": \[\]/, stage);
    assert.doesNotMatch(prompt, /ApiError|dumpErrors|node --run unit-test-ci|Jest/, stage);
  }
  assert.match(prompts.pr, /seções padrão do resumo/);
});

test('prompts, runners e validadores das Etapas 03 a 06 seguem contratos e permissões externas', () => {
  const devArgs = buildDevelopmentRunnerArgs('/tmp/factory-artifacts/flow-1/dev-report.md');
  assert(devArgs.includes('--restricted'));
  const devAllowed = devArgs[devArgs.indexOf('--allowedTools') + 1] ?? '';
  assert(devAllowed.includes('Edit(//tmp/factory-artifacts/flow-1/dev-report.md)'));
  assert(devAllowed.includes('Write(//tmp/factory-artifacts/flow-1/dev-report.md)'));
  assert(devAllowed.includes('Edit(//tmp/factory-artifacts/flow-1/dev-report.json)'));
  assert(devAllowed.includes('Write(//tmp/factory-artifacts/flow-1/dev-report.json)'));
  assert.equal(devAllowed.includes('.code-reviews'), false);

  const testsReportPath = '/tmp/factory-artifacts/flow-1/tests-report.md';
  const testsPrompt = buildFactoryTestsPrompt({
    task: 'PROD-1234',
    understandingReportPath: '/tmp/factory-artifacts/flow-1/spec.md',
    implementationPlanPath: '/tmp/factory-artifacts/flow-1/plan.md',
    implementationReportPath: '/tmp/factory-artifacts/flow-1/dev.md',
    approvedNotes: 'Priorizar casos de borda na autenticação',
    reportPath: testsReportPath,
  });
  assert(testsPrompt.includes(FACTORY_TESTS_SYSTEM_PROMPT));
  assert(testsPrompt.includes('/tmp/factory-artifacts/flow-1/spec.md'));
  assert(testsPrompt.includes('/tmp/factory-artifacts/flow-1/plan.md'));
  assert(testsPrompt.includes('/tmp/factory-artifacts/flow-1/dev.md'));
  assert(testsPrompt.includes('Priorizar casos de borda na autenticação'));
  assert(testsPrompt.includes(`# ${TEST_REPORT_TITLE}`));
  for (const heading of Object.values(TEST_REPORT_SECTIONS)) {
    assert(testsPrompt.includes(`## ${heading}`));
  }
  assertFactoryStageOutput(testsPrompt, 'tests', testsReportPath, [
    'executedCommands',
    'command',
    'exitCode',
    'testCases',
    'id',
    'description',
    'acceptanceCriteriaIds',
    'status',
    'coverage',
    'linesPercent',
    'branchesPercent',
  ]);
  assert.match(
    testsPrompt,
    /`command` uma lista de strings com o executável seguido pelos argumentos/,
  );
  assert.match(testsPrompt, /`acceptanceCriteriaIds`\s+como lista com pelo menos um ID/);
  assert.match(testsPrompt, /`passed`,\s+`failed` ou `skipped`/);
  assert.match(testsPrompt, /`passed`, `failed` ou `not_run`/);

  const testsArgs = buildTestsRunnerArgs(testsReportPath);
  assert(testsArgs.includes('--restricted'));
  assert.equal(testsArgs[testsArgs.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash');
  const testsAllowed = testsArgs[testsArgs.indexOf('--allowedTools') + 1] ?? '';
  assert(testsAllowed.includes('Bash'));
  assert(testsAllowed.includes('Edit(**/*.test.*)'));
  assert(testsAllowed.includes('Write(**/fixtures/**)'));
  assert(testsAllowed.includes('Edit(//tmp/factory-artifacts/flow-1/tests-report.md)'));
  assert(testsAllowed.includes('Write(//tmp/factory-artifacts/flow-1/tests-report.md)'));
  assert.equal(testsAllowed.includes('.code-reviews'), false);
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

  const reviewReportPath = '/tmp/factory-artifacts/flow-1/review-report.md';
  const reviewPrompt = buildFactoryReviewPrompt({
    task: 'PROD-1234',
    understandingReportPath: '/tmp/factory-artifacts/flow-1/spec.md',
    implementationPlanPath: '/tmp/factory-artifacts/flow-1/plan.md',
    implementationReportPath: '/tmp/factory-artifacts/flow-1/dev.md',
    testReportPath: '/tmp/factory-artifacts/flow-1/tests-report.md',
    approvedNotes: 'Auditar exposição de tokens nos logs',
    reportPath: reviewReportPath,
  });
  assert(reviewPrompt.includes(FACTORY_REVIEW_SYSTEM_PROMPT));
  assert(reviewPrompt.includes('/tmp/factory-artifacts/flow-1/tests-report.md'));
  assert(reviewPrompt.includes('Auditar exposição de tokens nos logs'));
  assert(reviewPrompt.includes(`# ${REVIEW_REPORT_TITLE}`));
  for (const heading of Object.values(REVIEW_REPORT_SECTIONS)) {
    assert(reviewPrompt.includes(`## ${heading}`));
  }
  assertFactoryStageOutput(reviewPrompt, 'review', reviewReportPath, [
    'verdict',
    'findings',
    'severity',
    'file',
    'line',
    'explanation',
  ]);
  const verdictMappings = {
    approved: REVIEW_VERDICT_LABELS.approved,
    approved_with_warnings: REVIEW_VERDICT_LABELS.approvedWithWarnings,
    changes_requested: REVIEW_VERDICT_LABELS.changesRequested,
  };
  for (const [verdict, label] of Object.entries(verdictMappings)) {
    assert.ok(reviewPrompt.includes(`\`${verdict}\` para ${label}`));
  }
  assert.match(reviewPrompt, /`BLOQUEANTE`, `SUGESTÃO` ou `NIT`/);

  const reviewArgs = buildReviewRunnerArgs(reviewReportPath);
  assert(reviewArgs.includes('--restricted'));
  assert.equal(reviewArgs[reviewArgs.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash');
  const reviewAllowed = reviewArgs[reviewArgs.indexOf('--allowedTools') + 1] ?? '';
  assert(reviewAllowed.includes('Bash(git diff*)'));
  assert(reviewAllowed.includes('Bash(git status*)'));
  assert(reviewAllowed.includes('Bash(git log*)'));
  assert(reviewAllowed.includes('Edit(//tmp/factory-artifacts/flow-1/review-report.md)'));
  assert(reviewAllowed.includes('Write(//tmp/factory-artifacts/flow-1/review-report.md)'));
  assert.equal(reviewAllowed.includes('.code-reviews'), false);
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
  assert.equal(parseReviewVerdict(validReviewReport), 'approved');
  assert.equal(isReviewReport(`# ${REVIEW_REPORT_TITLE}\n\nIncompleto.`), false);

  const approvedWithWarningsReport = [
    `# ${REVIEW_REPORT_TITLE}`,
    `## ${REVIEW_REPORT_SECTIONS.executiveSummary}`,
    'Aprovado com pequenas sugestões.',
    `## ${REVIEW_REPORT_SECTIONS.findings}`,
    '- [SUGESTÃO] Extrair helper.',
    `## ${REVIEW_REPORT_SECTIONS.verdict}`,
    `Veredito: ${REVIEW_VERDICT_LABELS.approvedWithWarnings}`,
    'Sem bloqueadores críticos.',
  ].join('\n');
  assert.equal(isReviewReport(approvedWithWarningsReport), true);
  assert.equal(parseReviewVerdict(approvedWithWarningsReport), 'approved_with_warnings');

  const rejectedReviewReport = [
    `# ${REVIEW_REPORT_TITLE}`,
    `## ${REVIEW_REPORT_SECTIONS.executiveSummary}`,
    'Falha confirmada no double-check dos testes.',
    `## ${REVIEW_REPORT_SECTIONS.findings}`,
    '- [BLOQUEANTE] src/jwt.ts:14 retorna token expirado.',
    `## ${REVIEW_REPORT_SECTIONS.verdict}`,
    `Veredito: ${REVIEW_VERDICT_LABELS.changesRequested}`,
    'Corrigir validação de expiração antes do PR.',
  ].join('\n');
  assert.equal(isReviewReport(rejectedReviewReport), true);
  assert.equal(parseReviewVerdict(rejectedReviewReport), 'changes_requested');

  const ambiguousReviewReport = [
    `# ${REVIEW_REPORT_TITLE}`,
    `## ${REVIEW_REPORT_SECTIONS.executiveSummary}`,
    'Resumo.',
    `## ${REVIEW_REPORT_SECTIONS.findings}`,
    'Pontos.',
    `## ${REVIEW_REPORT_SECTIONS.verdict}`,
    'Veredito: APROVADO PARA PR ou REPROVADO / REQUER AJUSTES',
  ].join('\n');
  assert.equal(parseReviewVerdict(ambiguousReviewReport), null);
  assert.equal(isReviewReport(ambiguousReviewReport), false);

  const developmentReportPath = '/tmp/factory-artifacts/flow-1/dev-2.md';
  const reentryDevPrompt = buildFactoryDevelopmentPrompt({
    task: 'PROD-1234',
    understandingReportPath: '/tmp/factory-artifacts/flow-1/spec.md',
    implementationPlanPath: '/tmp/factory-artifacts/flow-1/plan.md',
    previousImplementationReportPath: '/tmp/factory-artifacts/flow-1/dev-1.md',
    testReportPath: '/tmp/factory-artifacts/flow-1/tests-1.md',
    reviewReportPath: '/tmp/factory-artifacts/flow-1/review-1.md',
    approvedNotes: 'Preservar assinatura pública',
    reportPath: developmentReportPath,
    iteration: 2,
    maxIterations: 3,
  });
  assert(reentryDevPrompt.includes('Iteração 2/3'));
  assert(reentryDevPrompt.includes('/tmp/factory-artifacts/flow-1/dev-1.md'));
  assert(reentryDevPrompt.includes('/tmp/factory-artifacts/flow-1/tests-1.md'));
  assert(reentryDevPrompt.includes('/tmp/factory-artifacts/flow-1/review-1.md'));
  assert(reentryDevPrompt.includes(`# ${IMPLEMENTATION_REPORT_TITLE}`));
  for (const heading of Object.values(IMPLEMENTATION_REPORT_SECTIONS)) {
    assert(reentryDevPrompt.includes(`## ${heading}`));
  }
  assertFactoryStageOutput(reentryDevPrompt, 'development', developmentReportPath, [
    'changedFiles',
    'summary',
    'deviations',
    'description',
    'justification',
  ]);
  assert.match(reentryDevPrompt, /`changedFiles`.*\s+Use caminhos relativos ao repositório/);
  assert.match(reentryDevPrompt, /mesmos desvios do plano e justificativas/);

  const prReportPath = '/tmp/factory-artifacts/flow-1/pr-summary.md';
  const prPrompt = buildFactoryPrPrompt({
    task: 'PROD-1234',
    understandingReportPath: '/tmp/factory-artifacts/flow-1/spec.md',
    implementationPlanPath: '/tmp/factory-artifacts/flow-1/plan.md',
    implementationReportPath: '/tmp/factory-artifacts/flow-1/dev-2.md',
    testReportPath: '/tmp/factory-artifacts/flow-1/tests-2.md',
    reviewReportPath: '/tmp/factory-artifacts/flow-1/review-2.md',
    reportPath: prReportPath,
  });
  assert(prPrompt.includes(FACTORY_PR_SYSTEM_PROMPT));
  assert(prPrompt.includes('/tmp/factory-artifacts/flow-1/review-2.md'));
  assert(prPrompt.includes(`# ${PR_SUMMARY_TITLE}`));
  for (const heading of Object.values(PR_SUMMARY_SECTIONS)) {
    assert(prPrompt.includes(`## ${heading}`));
  }
  assertFactoryStageOutput(prPrompt, 'pr', prReportPath, [
    'title',
    'summary',
    'baseBranch',
    'headBranch',
    'satisfiedAcceptanceCriteriaIds',
    'evidence',
  ]);
  assert.match(prPrompt, /`baseBranch` e `headBranch`.*destino e de origem,\s+respectivamente/);
  assert.match(prPrompt, /`evidence`.*evidências verificadas e registradas/);

  const prArgs = buildPrRunnerArgs(prReportPath);
  assert(prArgs.includes('--restricted'));
  const prAllowed = prArgs[prArgs.indexOf('--allowedTools') + 1] ?? '';
  assert(prAllowed.includes('Edit(//tmp/factory-artifacts/flow-1/pr-summary.md)'));
  assert(prAllowed.includes('Write(//tmp/factory-artifacts/flow-1/pr-summary.md)'));
  assert.equal(prAllowed.includes('.code-reviews'), false);
  assert.equal(
    isPrSummary(
      [
        `# ${PR_SUMMARY_TITLE}`,
        `## ${PR_SUMMARY_SECTIONS.summary}`,
        'PR preparado.',
        `## ${PR_SUMMARY_SECTIONS.validation}`,
        'Testes e Review aprovados.',
        `## ${PR_SUMMARY_SECTIONS.prDetails}`,
        'Branch feat/prod-1234 -> main',
      ].join('\n'),
    ),
    true,
  );
  assert.equal(isPrSummary(`# ${PR_SUMMARY_TITLE}\n\nIncompleto.`), false);
});

test('start_factory executa PTY, salva par em diretório externo sem sujar git status e permite ler o Markdown via API', { timeout: 30000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-pty-'));
  const repoDir = join(directory, 'repo');
  const xdgDataHome = join(directory, 'xdg-data');
  mkdirSync(repoDir);
  mkdirSync(xdgDataHome);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoDir });

  const previousPath = process.env.PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdgDataHome;

  const { server, shutdown } = createReviewServer({ dbPath: join(directory, 'reviews.db') });
  const sockets: WebSocket[] = [];

  context.after(async () => {
    sockets.forEach(socket => socket.terminate());
    await shutdown();
    process.env.PATH = previousPath;
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
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
    repoPath: repoDir,
    cols: 90,
    rows: 25,
  }));

  const pendingHistory = await until(
    () => messages.find((m): m is Extract<ServerMessage, { type: 'history' }> => m.type === 'history' && m.state === 'pending'),
    'history pending',
  );
  assert.equal(existsSync(pendingHistory.reportPath), true);
  assert(pendingHistory.sessionPath && existsSync(pendingHistory.sessionPath));
  const artifactsRoot = join(xdgDataHome, 'development-factory', 'artifacts');
  assert.equal(dirname(dirname(pendingHistory.reportPath)), artifactsRoot);
  assert.equal(dirname(pendingHistory.sessionPath), dirname(pendingHistory.reportPath));
  assert.equal(existsSync(join(repoDir, '.code-reviews')), false);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }), '');
  assert.equal(statSync(dirname(pendingHistory.reportPath)).mode & 0o777, 0o700);
  assert.equal(statSync(pendingHistory.reportPath).mode & 0o777, 0o600);
  assert.equal(statSync(getFactoryStageSidecarPath(pendingHistory.reportPath)).mode & 0o777, 0o600);
  assert.equal(statSync(pendingHistory.sessionPath).mode & 0o777, 0o600);

  await until(() => (output.includes('PROD-1234') ? true : undefined), 'prompt output');

  const planMarkdown = triageMarkdown('PROD-1234 precisa de um fluxo inicial.');
  writeFileSync(pendingHistory.reportPath, planMarkdown);
  writeFactoryStageSidecar(pendingHistory.reportPath, 'triage');
  socket.send(JSON.stringify({ type: 'input', data: 'EXIT0' }));

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

  const sessionParams = new URLSearchParams({
    path: dirname(pendingHistory.sessionPath),
    name: basename(pendingHistory.sessionPath),
  });
  const sessionResponse = await fetch(`${httpUrl}/api/history/file?${sessionParams.toString()}`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(sessionResponse.status, 200);
  const sessionData = HistoryFileSchema.parse(await sessionResponse.json());
  assert(sessionData.content.includes('PROD-1234'));

  socket.close();
});
