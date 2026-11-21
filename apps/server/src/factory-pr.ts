import { basename } from 'node:path';
import type { FactoryFlowDetails } from '@development-factory/shared';
import {
  buildRestrictedRunnerArgs,
  readReadyStageDocuments,
  validateStructuredMarkdownReport,
} from './factory-stage-runners.js';
import { PR_SUMMARY_SECTIONS, PR_SUMMARY_TITLE } from './prompts/factory-pr.js';

/** Argumentos restritos do runner da Etapa 06 (inspeção git/gh e escrita do `pr_summary`). */
export function buildPrRunnerArgs(reportPath: string): string[] {
  const reportFile = basename(reportPath);
  return buildRestrictedRunnerArgs({
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    allowed: [
      'Read',
      'Glob',
      'Grep',
      `Edit(/.code-reviews/${reportFile})`,
      `Write(/.code-reviews/${reportFile})`,
      'Bash(git status*)',
      'Bash(git diff*)',
      'Bash(git log*)',
      'Bash(git branch*)',
      'Bash(gh pr*)',
    ],
    denied: ['Edit(**/.git/**)', 'Write(**/.git/**)', 'Bash(git push --force*)', 'Bash(git reset*)'],
  });
}

/** Lê e valida os artefatos obrigatórios das Etapas 01 a 05 para iniciar a Etapa 06 (PR). */
export async function readFactoryPrInputs(details: FactoryFlowDetails) {
  const paths = await readReadyStageDocuments(
    details,
    ['triage', 'planning', 'development', 'tests', 'review'],
    'Os documentos das Etapas 01 a 05 são obrigatórios para executar a etapa de PR.',
  );
  return {
    understandingReportPath: paths.triage,
    implementationPlanPath: paths.planning,
    implementationReportPath: paths.development,
    testReportPath: paths.tests,
    reviewReportPath: paths.review,
    approvedNotes: details.stages.find(stage => stage.name === 'pr')?.approvedNotes,
  };
}

/** Valida a estrutura mínima do artefato `pr_summary` em Markdown. */
export function isPrSummary(content: string): boolean {
  return validateStructuredMarkdownReport(content, PR_SUMMARY_TITLE, PR_SUMMARY_SECTIONS);
}
