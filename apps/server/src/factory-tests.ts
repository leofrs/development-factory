import type { FactoryFlowDetails } from '@development-factory/shared';
import {
  GIT_WRITE_DENIED_BASH_TOOLS,
  INFRA_AND_CONFIG_PATHS,
  TEST_AND_FIXTURE_PATTERNS,
  buildReportFileToolPermissions,
  buildRestrictedRunnerArgs,
  readOptionalLatestStageDocument,
  readFactoryStageSidecar,
  readReadyStageDocuments,
  validateStructuredMarkdownReport,
} from './factory-stage-runners.js';
import { TEST_REPORT_SECTIONS, TEST_REPORT_TITLE } from './prompts/factory-tests.js';

/** Argumentos restritos do runner da Etapa 04 (escrita apenas em testes/fixtures + terminal). */
export function buildTestsRunnerArgs(reportPath: string): string[] {
  return buildRestrictedRunnerArgs({
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    allowed: [
      'Read',
      'Glob',
      'Grep',
      'Bash',
      ...TEST_AND_FIXTURE_PATTERNS.flatMap(pattern => [`Edit(${pattern})`, `Write(${pattern})`]),
      ...buildReportFileToolPermissions(reportPath),
    ],
    denied: [
      ...INFRA_AND_CONFIG_PATHS.flatMap(path => [`Edit(${path})`, `Write(${path})`]),
      ...GIT_WRITE_DENIED_BASH_TOOLS,
    ],
  });
}

/** Lê e valida os artefatos obrigatórios das Etapas 01, 02 e 03 para iniciar a Etapa 04 (Testes). */
export async function readFactoryTestsInputs(details: FactoryFlowDetails) {
  const paths = await readReadyStageDocuments(
    details,
    ['triage', 'planning', 'development'],
    'Os documentos das Etapas 01, 02 e 03 são obrigatórios para executar os Testes.',
  );
  const sidecar = readFactoryStageSidecar('development', paths.development);
  const developmentChecks = sidecar.stage === 'development' ? sidecar.backendChecks : undefined;
  const iteration = details.flow.iteration > 0 ? details.flow.iteration : 1;
  const [previousTestReportPath, previousReviewReportPath] =
    iteration >= 2
      ? await Promise.all([
          readOptionalLatestStageDocument(details, 'tests'),
          readOptionalLatestStageDocument(details, 'review'),
        ])
      : [undefined, undefined];

  return {
    understandingReportPath: paths.triage,
    implementationPlanPath: paths.planning,
    implementationReportPath: paths.development,
    ...(developmentChecks ? { developmentChecks } : {}),
    approvedNotes: details.stages.find(stage => stage.name === 'tests')?.approvedNotes,
    iteration,
    maxIterations: details.flow.maxIterations,
    ...(previousTestReportPath ? { previousTestReportPath } : {}),
    ...(previousReviewReportPath ? { previousReviewReportPath } : {}),
  };
}

/** Valida a estrutura mínima do artefato `test_report` em Markdown. */
export function isTestReport(content: string): boolean {
  return validateStructuredMarkdownReport(content, TEST_REPORT_TITLE, TEST_REPORT_SECTIONS);
}
