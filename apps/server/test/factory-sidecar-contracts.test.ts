import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FACTORY_STAGE_SIDECAR_CONTRACT_VERSION,
  FactoryDevelopmentSidecarSchema,
  FactoryPlanningSidecarSchema,
  FactoryPrSidecarSchema,
  FactoryReviewSidecarSchema,
  FactoryTestsSidecarSchema,
  FactoryTriageSidecarSchema,
  RerunFactoryStageRequestSchema,
  evaluateFactoryTriageGate,
} from '@development-factory/shared';
import type {
  FactoryBackendCommandCheck,
  FactoryDevelopmentSidecar,
  FactoryPlanningSidecar,
  FactoryPrSidecar,
  FactoryReviewSidecar,
  FactoryTestsSidecar,
  FactoryTriageSidecar,
} from '@development-factory/shared';

const contractVersion = FACTORY_STAGE_SIDECAR_CONTRACT_VERSION;
const file = 'src/factory.ts';
const criterion = { id: 'CA-1', description: 'Rejeitar artefatos com campos desconhecidos' };
const jiraContext = { key: 'DEV-42', url: 'https://empresa.atlassian.net/browse/DEV-42' };
const decision = {
  question: 'Qual formato usar para o artefato estruturado?',
  options: ['JSON', 'YAML'],
  recommendedOption: 'JSON',
};
const deviation = {
  description: 'Mover o contrato para o pacote compartilhado',
  justification: 'O servidor e a interface precisam ler o mesmo formato',
};
const command: FactoryTestsSidecar['executedCommands'][number] = {
  command: ['npm', 'test'],
  exitCode: 0,
};
const testCase: FactoryTestsSidecar['testCases'][number] = {
  id: 'T-1',
  description: 'Enviar um artefato com propriedade extra',
  acceptanceCriteriaIds: [criterion.id],
  status: 'passed',
};
const coverage = { linesPercent: 98.5, branchesPercent: 95 };
const finding: FactoryReviewSidecar['findings'][number] = {
  severity: 'SUGESTÃO',
  file,
  line: 42,
  explanation: 'Usar a mesma descrição do critério no relatório Markdown',
};

const triage: FactoryTriageSidecar = {
  contractVersion,
  stage: 'triage',
  acceptanceCriteria: [criterion],
  negativeScope: ['Alterações na persistência'],
  blockers: [],
  jiraContext,
  technicalContext: 'A Factory utiliza schemas Zod para validar dados compartilhados',
};
const planning: FactoryPlanningSidecar = {
  contractVersion,
  stage: 'planning',
  pendingDecisions: [decision],
  plannedFiles: [file],
  testPlan: ['Validar a rejeição de campos desconhecidos no CA-1'],
};
const development: FactoryDevelopmentSidecar = {
  contractVersion,
  stage: 'development',
  changedFiles: [file],
  summary: 'Adicionados contratos estritos para os sidecars',
  deviations: [deviation],
};
const tests: FactoryTestsSidecar = {
  contractVersion,
  stage: 'tests',
  executedCommands: [command],
  testCases: [testCase],
  status: 'passed',
  coverage,
};
const review: FactoryReviewSidecar = {
  contractVersion,
  stage: 'review',
  verdict: 'approved_with_warnings',
  findings: [finding],
};
const pr: FactoryPrSidecar = {
  contractVersion,
  stage: 'pr',
  title: 'Validação de artefatos da Factory',
  summary: 'Adiciona contratos JSON para os seis blocos',
  baseBranch: 'main',
  headBranch: 'factory/dev-42',
  satisfiedAcceptanceCriteriaIds: [criterion.id],
  evidence: ['O teste T-1 passou na execução de npm test'],
};

const contracts = [
  { schema: FactoryTriageSidecarSchema, payload: triage },
  { schema: FactoryPlanningSidecarSchema, payload: planning },
  { schema: FactoryDevelopmentSidecarSchema, payload: development },
  { schema: FactoryTestsSidecarSchema, payload: tests },
  { schema: FactoryReviewSidecarSchema, payload: review },
  { schema: FactoryPrSidecarSchema, payload: pr },
];

for (const { schema, payload } of contracts) {
  test(`valida o contrato versionado do sidecar de ${payload.stage}`, () => {
    assert.deepEqual(schema.parse(payload), payload);

    for (const field of Object.keys(payload)) {
      const incomplete: Record<string, unknown> = { ...payload };
      delete incomplete[field];
      assert.equal(schema.safeParse(incomplete).success, false, `Campo obrigatório: ${field}`);
    }

    const wrongStage = payload.stage === 'triage' ? 'planning' : 'triage';
    const wrongVersion = contractVersion + 1;
    assert.equal(schema.safeParse({ ...payload, stage: wrongStage }).success, false);
    assert.equal(schema.safeParse({ ...payload, contractVersion: wrongVersion }).success, false);
    assert.equal(schema.safeParse({ ...payload, extra: true }).success, false);
  });
}

test('rejeita propriedades desconhecidas nos objetos internos dos sidecars', () => {
  const inputs = [
    [
      FactoryTriageSidecarSchema,
      { ...triage, acceptanceCriteria: [{ ...criterion, extra: true }] },
    ],
    [FactoryTriageSidecarSchema, { ...triage, jiraContext: { ...jiraContext, extra: true } }],
    [
      FactoryPlanningSidecarSchema,
      { ...planning, pendingDecisions: [{ ...decision, extra: true }] },
    ],
    [
      FactoryDevelopmentSidecarSchema,
      { ...development, deviations: [{ ...deviation, extra: true }] },
    ],
    [FactoryTestsSidecarSchema, { ...tests, executedCommands: [{ ...command, extra: true }] }],
    [FactoryTestsSidecarSchema, { ...tests, testCases: [{ ...testCase, extra: true }] }],
    [FactoryTestsSidecarSchema, { ...tests, coverage: { ...coverage, extra: true } }],
    [FactoryReviewSidecarSchema, { ...review, findings: [{ ...finding, extra: true }] }],
  ] as const;

  for (const [schema, payload] of inputs) {
    const result = schema.safeParse(payload);
    assert.ok(!result.success);
    assert.equal(result.error.issues[0]?.code, 'unrecognized_keys');
  }
});

test('valida o contexto Jira e a unicidade dos identificadores dos critérios de aceite', () => {
  const withoutJira = { ...triage, jiraContext: null };
  assert.deepEqual(FactoryTriageSidecarSchema.parse(withoutJira), withoutJira);
  assert.equal(
    FactoryTriageSidecarSchema.safeParse({
      ...triage,
      jiraContext: { ...jiraContext, url: 'ftp://empresa.atlassian.net/browse/DEV-42' },
    }).success,
    false,
  );
  assert.equal(
    FactoryTriageSidecarSchema.safeParse({ ...triage, acceptanceCriteria: [criterion, criterion] })
      .success,
    false,
  );
});

test('exige uma opção recomendada válida, caminhos relativos e justificativas para desvios', () => {
  const invalidRecommendation = FactoryPlanningSidecarSchema.safeParse({
    ...planning,
    pendingDecisions: [{ ...decision, recommendedOption: 'XML' }],
  });
  assert.ok(!invalidRecommendation.success);
  assert.deepEqual(invalidRecommendation.error.issues[0]?.path, [
    'pendingDecisions',
    0,
    'recommendedOption',
  ]);
  assert.equal(
    FactoryPlanningSidecarSchema.safeParse({ ...planning, plannedFiles: ['/tmp/file.ts'] }).success,
    false,
  );
  assert.equal(
    FactoryDevelopmentSidecarSchema.safeParse({ ...development, changedFiles: ['../file.ts'] })
      .success,
    false,
  );
  assert.equal(
    FactoryDevelopmentSidecarSchema.safeParse({
      ...development,
      deviations: [{ description: deviation.description }],
    }).success,
    false,
  );
});

test('valida verificações de Desenvolvimento omitidas, aprovadas e com falha', () => {
  const typecheck = { command: ['npm', 'run', 'typecheck'], exitCode: 0, errorSummary: null };
  const approval = { ...development, backendChecks: { typecheck, lint: null } };
  assert.deepEqual(FactoryDevelopmentSidecarSchema.parse(approval), approval);

  const lint = { command: ['lint'], exitCode: null, errorSummary: 'Executável ausente.' };
  const failure = { ...development, backendChecks: { typecheck, lint } };
  assert.deepEqual(FactoryDevelopmentSidecarSchema.parse(failure), failure);

  for (const invalidLint of [
    { ...lint, exitCode: -1 },
    { ...lint, exitCode: 0 },
    { ...lint, errorSummary: null },
    { ...lint, stdout: 'campo desconhecido' },
  ]) {
    assert.equal(
      FactoryDevelopmentSidecarSchema.safeParse({
        ...development,
        backendChecks: { typecheck, lint: invalidLint },
      }).success,
      false,
    );
  }
});

test('valida comandos, status, critérios de aceite e cobertura dos testes', () => {
  const invalidPayloads = [
    { ...tests, executedCommands: [{ ...command, command: [] }] },
    { ...tests, executedCommands: [{ ...command, exitCode: -1 }] },
    { ...tests, testCases: [{ ...testCase, acceptanceCriteriaIds: [] }] },
    { ...tests, testCases: [{ ...testCase, status: 'unknown' }] },
    { ...tests, status: 'unknown' },
    { ...tests, coverage: { ...coverage, linesPercent: 101 } },
  ];
  for (const payload of invalidPayloads) {
    assert.equal(FactoryTestsSidecarSchema.safeParse(payload).success, false);
  }

  const withoutCoverage: FactoryTestsSidecar = { ...tests, coverage: null };
  assert.deepEqual(FactoryTestsSidecarSchema.parse(withoutCoverage), withoutCoverage);
});

test('valida verificações de Testes pelo backend e consistência com status e comandos executados', () => {
  const passedTest: FactoryBackendCommandCheck = {
    command: ['npm', 'test'],
    exitCode: 0,
    errorSummary: null,
  };
  const passedCoverage: FactoryBackendCommandCheck = {
    command: ['npm', 'run', 'coverage'],
    exitCode: 0,
    errorSummary: null,
  };
  const failedTest: FactoryBackendCommandCheck = {
    command: ['npm', 'test'],
    exitCode: 1,
    errorSummary: 'O comando encerrou com código 1.',
  };

  const validPassed: FactoryTestsSidecar = {
    ...tests,
    executedCommands: [
      { command: passedTest.command, exitCode: 0 },
      { command: passedCoverage.command, exitCode: 0 },
    ],
    status: 'passed',
    backendChecks: { test: passedTest, coverage: passedCoverage },
  };
  assert.deepEqual(FactoryTestsSidecarSchema.parse(validPassed), validPassed);

  const validFailed: FactoryTestsSidecar = {
    ...tests,
    executedCommands: [{ command: failedTest.command, exitCode: 1 }],
    status: 'failed',
    backendChecks: { test: failedTest, coverage: null },
  };
  assert.deepEqual(FactoryTestsSidecarSchema.parse(validFailed), validFailed);

  const validNotRun: FactoryTestsSidecar = {
    ...tests,
    executedCommands: [],
    status: 'not_run',
    coverage: null,
    backendChecks: { test: null, coverage: null },
  };
  assert.deepEqual(FactoryTestsSidecarSchema.parse(validNotRun), validNotRun);

  for (const inconsistent of [
    { ...validFailed, status: 'passed' },
    { ...validPassed, status: 'failed' },
    { ...validNotRun, status: 'passed' },
    { ...validFailed, executedCommands: [{ command: ['npm', 'test'], exitCode: 0 }] },
    { ...validPassed, backendChecks: { test: passedTest, coverage: passedCoverage, extra: true } },
    { ...validPassed, backendChecks: { test: { ...passedTest, stdout: 'extra' }, coverage: null } },
  ]) {
    assert.equal(FactoryTestsSidecarSchema.safeParse(inconsistent).success, false);
  }
});

test('valida vereditos, severidades e linhas em findings de revisão', () => {
  const invalidPayloads = [
    { ...review, verdict: 'unknown' },
    { ...review, findings: [{ ...finding, severity: 'CRÍTICO' }] },
    { ...review, findings: [{ ...finding, line: 0 }] },
  ];
  for (const payload of invalidPayloads) {
    assert.equal(FactoryReviewSidecarSchema.safeParse(payload).success, false);
  }
});

test('rejeita referências de branches inválidas nos metadados de PR', () => {
  const invalidBase = { ...pr, baseBranch: 'release..main' };
  const invalidHead = { ...pr, headBranch: 'bad branch' };
  assert.equal(FactoryPrSidecarSchema.safeParse(invalidBase).success, false);
  assert.equal(FactoryPrSidecarSchema.safeParse(invalidHead).success, false);
});

test('valida jiraError no sidecar de triagem, avalia portão humano e aceita approvedNotes no rerun', () => {
  const withJiraNull = FactoryTriageSidecarSchema.parse({ ...triage, jiraError: null });
  assert.deepEqual(evaluateFactoryTriageGate(withJiraNull), {
    blockers: [],
    jiraError: null,
    blocked: false,
  });

  const withBlocker = FactoryTriageSidecarSchema.parse({
    ...triage,
    blockers: ['Definir provedor de e-mail'],
  });
  assert.deepEqual(evaluateFactoryTriageGate(withBlocker), {
    blockers: ['Definir provedor de e-mail'],
    jiraError: null,
    blocked: true,
  });

  const withJiraFailure = FactoryTriageSidecarSchema.parse({
    ...triage,
    jiraError: 'Jira MCP retornou 401 Unauthorized',
  });
  assert.deepEqual(evaluateFactoryTriageGate(withJiraFailure), {
    blockers: [],
    jiraError: 'Jira MCP retornou 401 Unauthorized',
    blocked: true,
  });

  assert.equal(
    FactoryTriageSidecarSchema.safeParse({ ...triage, jiraError: '   ' }).success,
    false,
  );
  assert.equal(
    RerunFactoryStageRequestSchema.safeParse({
      stage: 'triage',
      approvedNotes: 'Usar SendGrid no ambiente de produção.',
    }).success,
    true,
  );
  assert.equal(
    RerunFactoryStageRequestSchema.safeParse({
      stage: 'triage',
      approvedNotes: '   ',
    }).success,
    false,
  );
});
