import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FactoryDevelopmentSidecarSchema,
  FactoryTestsSidecarSchema,
  FactoryTriageSidecarSchema,
} from '@development-factory/shared';
import { runBackendCommandCheck } from '../src/factory-backend-checks.js';
import { appendFactoryDevelopmentChecks } from '../src/factory-development-checks.js';
import { getFactoryStageSidecarPath } from '../src/factory-stage-runners.js';
import { appendFactoryTestsChecks } from '../src/factory-tests-checks.js';
import { IMPLEMENTATION_REPORT_SECTIONS, IMPLEMENTATION_REPORT_TITLE } from '../src/prompts/factory-development.js';
import { TEST_REPORT_SECTIONS, TEST_REPORT_TITLE } from '../src/prompts/factory-tests.js';
import { redactSecrets, redactSecretsInValue } from '../src/secret-redaction.js';
import { writeFactoryStageSidecar } from './fixtures/factory-stage-artifacts.js';

test('redactSecrets substitui tokens Bearer/JWT, chaves de API, AWS, GitHub, Jira, PEM e URLs com credenciais', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const input = [
    `Authorization: Bearer ${jwt}`,
    'Bearer tok_live_9876543210abcdef',
    'Proxy-Authorization: Basic dXNlcjpzZWNyZXQ=',
    `JWT=${jwt}`,
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'GH_TOKEN=ghp_1234567890abcdef1234567890abcdef1234',
    'FINE_GRAINED=github_pat_11ABCDEF0123456789_abcdefghijklmnopqrstuvwxyz',
    'JIRA_API_TOKEN=ATATT3xFfGF0123456789abcdefABCDEF_-12345678',
    'jira_password="my-jira-password"',
    'ANTHROPIC_API_KEY=sk-ant-api03-1234567890abcdef123456',
    'OPENAI_API_KEY=sk-proj-1234567890abcdef1234567890',
    'GOOGLE_KEY=AIzaSyDummyKey1234567890abcdef1234567890',
    'SLACK_TOKEN=xoxb-1234567890-1234567890-abcdefghij',
    'GITLAB_TOKEN=glpat-1234567890abcdefghij1234',
    'NPM_TOKEN=npm_1234567890abcdefghijklmnopqr',
    'x-api-key: custom-key-123456',
    'cli --token super-secret-cli-token --password "p@ssword123"',
    'Repo https://bot:supersecret99@git.internal.corp/org/repo.git',
    'DB postgres://admin:db_pass_123@db.internal:5432/app?access_token=qtoken123&key=DEV-42',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtest\n-----END RSA PRIVATE KEY-----',
  ].join('\n');

  const redacted = redactSecrets(input);

  for (const secret of [
    jwt,
    'tok_live_9876543210abcdef',
    'dXNlcjpzZWNyZXQ=',
    'AKIAIOSFODNN7EXAMPLE',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'ghp_1234567890abcdef1234567890abcdef1234',
    'github_pat_11ABCDEF0123456789_abcdefghijklmnopqrstuvwxyz',
    'ATATT3xFfGF0123456789abcdefABCDEF_-12345678',
    'my-jira-password',
    'sk-ant-api03-1234567890abcdef123456',
    'sk-proj-1234567890abcdef1234567890',
    'AIzaSyDummyKey1234567890abcdef1234567890',
    'xoxb-1234567890-1234567890-abcdefghij',
    'glpat-1234567890abcdefghij1234',
    'npm_1234567890abcdefghijklmnopqr',
    'custom-key-123456',
    'super-secret-cli-token',
    'p@ssword123',
    'bot:supersecret99',
    'admin:db_pass_123',
    'qtoken123',
    'MIIEowIBAAKCAQEAtest',
  ]) {
    assert.equal(redacted.includes(secret), false, `Segredo não foi redigido: ${secret}`);
  }

  assert.match(redacted, /Authorization: Bearer \[REDACTED\]/);
  assert.match(redacted, /Proxy-Authorization: Basic \[REDACTED\]/);
  assert.match(redacted, /https:\/\/\[REDACTED\]@git\.internal\.corp\/org\/repo\.git/);
  assert.match(redacted, /postgres:\/\/\[REDACTED\]@db\.internal:5432\/app\?access_token=\[REDACTED\]&key=DEV-42/);
  assert.match(redacted, /x-api-key: \[REDACTED\]/);
  assert.equal(redactSecrets(redacted), redacted);
});

test('redactSecrets preserva legibilidade de código, URLs sem credenciais, placeholders e tipos TypeScript', () => {
  const safeText = [
    'https://empresa.atlassian.net/browse/DEV-42',
    'git@github.com:org/development-factory.git',
    'interface Config { apiKey: string; password: null; secret: boolean; }',
    'error TS2322: Type \'string\' is not assignable to type \'number\'.',
    'Bearer authentication exige cabeçalho Authorization: Bearer <token>',
    'export JIRA_API_TOKEN=${JIRA_API_TOKEN}',
    'Commit 0257c87a2e71acf14f12b0454e2221a913353152 para PROD-1234',
  ].join('\n');

  assert.equal(redactSecrets(safeText), safeText);
});

test('redactSecretsInValue redige strings aninhadas sem corromper o contrato JSON do sidecar', () => {
  const rawSidecar = {
    contractVersion: 1,
    stage: 'triage',
    acceptanceCriteria: [
      {
        id: 'CA1',
        description: 'Autenticar com Bearer tok_secret_123456 na API.',
      },
    ],
    negativeScope: ['Não expor AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    blockers: [],
    jiraContext: {
      key: 'DEV-42',
      url: 'https://user:secret_jira_pass@empresa.atlassian.net/browse/DEV-42',
    },
    technicalContext: 'Usa header x-api-key: "segredo-com-aspas"',
  };

  const sanitized = redactSecretsInValue(rawSidecar);
  const serialized = JSON.stringify(sanitized);
  const parsed = FactoryTriageSidecarSchema.parse(JSON.parse(serialized));

  assert.equal(
    parsed.acceptanceCriteria[0]?.description,
    'Autenticar com Bearer [REDACTED] na API.',
  );
  assert.equal(parsed.negativeScope[0], 'Não expor AWS_SECRET_ACCESS_KEY=[REDACTED]');
  assert.equal(parsed.jiraContext?.url, 'https://[REDACTED]@empresa.atlassian.net/browse/DEV-42');
  assert.equal(parsed.technicalContext, 'Usa header x-api-key: "[REDACTED]"');
});

test('executores determinísticos de Desenvolvimento e Testes redigem segredos em stdout/stderr, comandos e sidecars JSON', async context => {
  const rootDir = await mkdtemp(join(tmpdir(), 'df-redact-checks-'));
  context.after(() => rm(rootDir, { recursive: true, force: true }));

  const worktreePath = join(rootDir, 'worktree');
  const artifactsPath = join(rootDir, 'artifacts');
  mkdirSync(worktreePath);
  mkdirSync(artifactsPath);

  writeFileSync(
    join(worktreePath, 'check.mjs'),
    [
      'const mode = process.argv[2];',
      "console.log('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig_abcdef123');",
      "console.error('URL https://ci:token_987654@registry.internal/pkg ghp_1234567890abcdef1234567890');",
      "if (mode === 'typecheck-fail') { console.log('error TS2322: bad type'); process.exit(1); }",
      "if (mode === 'test-fail') { console.log('Lines : 75.5%\\nℹ fail 1'); process.exit(1); }",
      'process.exit(0);',
    ].join('\n'),
  );

  const checkResult = await runBackendCommandCheck(
    ['node', './check.mjs', 'typecheck-fail', 'https://user:pass123@example.internal/hook'],
    worktreePath,
    new AbortController().signal,
  );
  assert.equal(checkResult.output.includes('eyJhbGciOiJIUzI1NiJ9'), false);
  assert.equal(checkResult.output.includes('ci:token_987654'), false);
  assert.equal(checkResult.output.includes('ghp_1234567890abcdef1234567890'), false);
  assert.match(checkResult.output, /Authorization: Bearer \[REDACTED\]/);
  assert.match(checkResult.output, /https:\/\/\[REDACTED\]@registry\.internal\/pkg \[REDACTED\]/);
  assert.deepEqual(checkResult.check?.command, [
    'node',
    './check.mjs',
    'typecheck-fail',
    'https://[REDACTED]@example.internal/hook',
  ]);

  const devReportPath = join(artifactsPath, 'dev-report.md');
  writeFileSync(
    devReportPath,
    [
      `# ${IMPLEMENTATION_REPORT_TITLE}`,
      `## ${IMPLEMENTATION_REPORT_SECTIONS.changedFiles}`,
      '- src/feature.ts',
      `## ${IMPLEMENTATION_REPORT_SECTIONS.summary}`,
      'Implementado.',
      `## ${IMPLEMENTATION_REPORT_SECTIONS.planStatus}`,
      '| Passo | Status | Observações |',
      '| --- | --- | --- |',
      '| 1 | Concluído | OK |',
    ].join('\n'),
  );
  writeFactoryStageSidecar(devReportPath, 'development', {
    summary: 'Integração com JIRA_API_TOKEN=ATATT3xFfGF0123456789abcdefABCDEF_-1234',
  });
  await appendFactoryDevelopmentChecks(
    devReportPath,
    worktreePath,
    {
      typecheck: ['node', './check.mjs', 'typecheck-fail', '--token=secret_dev_12345'],
      lint: null,
    },
    new AbortController().signal,
  );
  const devSidecarRaw = readFileSync(getFactoryStageSidecarPath(devReportPath), 'utf8');
  assert.equal(devSidecarRaw.includes('ATATT3xFfGF0123456789'), false);
  assert.equal(devSidecarRaw.includes('secret_dev_12345'), false);
  const devSidecar = FactoryDevelopmentSidecarSchema.parse(JSON.parse(devSidecarRaw));
  assert.equal(devSidecar.summary, 'Integração com JIRA_API_TOKEN=[REDACTED]');
  assert.deepEqual(devSidecar.backendChecks?.typecheck?.command, [
    'node',
    './check.mjs',
    'typecheck-fail',
    '--token=[REDACTED]',
  ]);

  const testsReportPath = join(artifactsPath, 'tests-report.md');
  writeFileSync(
    testsReportPath,
    [
      `# ${TEST_REPORT_TITLE}`,
      `## ${TEST_REPORT_SECTIONS.testFiles}`,
      '- test/feature.test.ts',
      `## ${TEST_REPORT_SECTIONS.executedCommands}`,
      '- node ./check.mjs',
      `## ${TEST_REPORT_SECTIONS.results}`,
      'Executado.',
    ].join('\n'),
  );
  writeFactoryStageSidecar(testsReportPath, 'tests', {
    testCases: [
      {
        id: 'T1',
        description: 'Valida AWS AKIAIOSFODNN7EXAMPLE mascarada',
        acceptanceCriteriaIds: ['CA1'],
        status: 'passed',
      },
    ],
  });
  await appendFactoryTestsChecks(
    testsReportPath,
    worktreePath,
    {
      test: ['node', './check.mjs', 'test-fail', 'https://qa:secret@internal.local/api'],
      coverage: null,
    },
    new AbortController().signal,
  );
  const testsSidecarRaw = readFileSync(getFactoryStageSidecarPath(testsReportPath), 'utf8');
  assert.equal(testsSidecarRaw.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(testsSidecarRaw.includes('qa:secret'), false);
  const testsSidecar = FactoryTestsSidecarSchema.parse(JSON.parse(testsSidecarRaw));
  assert.equal(testsSidecar.status, 'failed');
  assert.deepEqual(testsSidecar.coverage, { linesPercent: 75.5, branchesPercent: null });
  assert.deepEqual(testsSidecar.executedCommands, [
    { command: ['node', './check.mjs', 'test-fail', 'https://[REDACTED]@internal.local/api'], exitCode: 1 },
  ]);
  assert.equal(testsSidecar.testCases[0]?.description, 'Valida AWS [REDACTED] mascarada');
});
