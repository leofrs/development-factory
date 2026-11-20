import { basename } from 'node:path';
import type { FactoryFlowDetails } from '@development-factory/shared';
import {
  GIT_WRITE_DENIED_BASH_TOOLS,
  INFRA_AND_CONFIG_PATHS,
  TEST_AND_FIXTURE_PATTERNS,
  buildRestrictedRunnerArgs,
  readReadyStageDocuments,
  validateStructuredMarkdownReport,
} from './factory-stage-runners.js';
import { TEST_REPORT_SECTIONS, TEST_REPORT_TITLE } from './prompts/factory-tests.js';

/** Argumentos restritos do runner da Etapa 04 (escrita apenas em testes/fixtures + terminal). */
export function buildTestsRunnerArgs(reportPath: string): string[] {
  const reportFile = basename(reportPath);
  return buildRestrictedRunnerArgs({
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    allowed: [
      'Read',
      'Glob',
      'Grep',
      'Bash',
      ...TEST_AND_FIXTURE_PATTERNS.flatMap(pattern => [`Edit(${pattern})`, `Write(${pattern})`]),
      `Edit(/.code-reviews/${reportFile})`,
      `Write(/.code-reviews/${reportFile})`,
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
  return {
    understandingReportPath: paths.triage,
    implementationPlanPath: paths.planning,
    implementationReportPath: paths.development,
    approvedNotes: details.stages.find(stage => stage.name === 'tests')?.approvedNotes,
  };
}

/** Valida a estrutura mínima do artefato `test_report` em Markdown. */
export function isTestReport(content: string): boolean {
  return validateStructuredMarkdownReport(content, TEST_REPORT_TITLE, TEST_REPORT_SECTIONS);
}
