import { basename } from 'node:path';
import type { FactoryFlowDetails } from '@development-factory/shared';
import {
  GIT_WRITE_DENIED_BASH_TOOLS,
  buildRestrictedRunnerArgs,
  readReadyStageDocuments,
  validateStructuredMarkdownReport,
} from './factory-stage-runners.js';
import { REVIEW_REPORT_SECTIONS, REVIEW_REPORT_TITLE } from './prompts/factory-review.js';

/** Argumentos restritos do runner da Etapa 05 (somente leitura no código + comandos git de inspeção). */
export function buildReviewRunnerArgs(reportPath: string): string[] {
  const reportFile = basename(reportPath);
  return buildRestrictedRunnerArgs({
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    allowed: [
      'Read',
      'Glob',
      'Grep',
      `Edit(/.code-reviews/${reportFile})`,
      `Write(/.code-reviews/${reportFile})`,
      'Bash(git diff*)',
      'Bash(git status*)',
      'Bash(git log*)',
    ],
    denied: ['Edit(**/.git/**)', 'Write(**/.git/**)', ...GIT_WRITE_DENIED_BASH_TOOLS],
  });
}

/** Lê e valida os artefatos obrigatórios das Etapas 01 a 04 para iniciar a Etapa 05 (Code Review). */
export async function readFactoryReviewInputs(details: FactoryFlowDetails) {
  const paths = await readReadyStageDocuments(
    details,
    ['triage', 'planning', 'development', 'tests'],
    'Os documentos das Etapas 01, 02, 03 e 04 são obrigatórios para executar o Code Review.',
  );
  return {
    understandingReportPath: paths.triage,
    implementationPlanPath: paths.planning,
    implementationReportPath: paths.development,
    testReportPath: paths.tests,
    approvedNotes: details.stages.find(stage => stage.name === 'review')?.approvedNotes,
  };
}

/** Valida a estrutura mínima do artefato `review_report` em Markdown. */
export function isReviewReport(content: string): boolean {
  return validateStructuredMarkdownReport(content, REVIEW_REPORT_TITLE, REVIEW_REPORT_SECTIONS);
}
