import { dirname } from 'node:path';
import type { FactoryFlowDetails } from '@development-factory/shared';
import { readFactoryReviewTriageScope } from './factory-review.js';
import {
  GIT_WRITE_DENIED_BASH_TOOLS,
  INFRA_AND_CONFIG_PATHS,
  buildReportFileToolPermissions,
  buildRestrictedRunnerArgs,
  readFactoryStageSidecar,
  readReadyStageDocuments,
  validateStructuredMarkdownReport,
} from './factory-stage-runners.js';
import { PR_SUMMARY_SECTIONS, PR_SUMMARY_TITLE } from './prompts/factory-pr.js';

const CONVENTIONAL_COMMIT_TITLE_PATTERN =
  /^(?:feat|fix|refactor|perf|docs|test|build|ci|chore|style|revert)(?:\([a-z0-9._/-]+\))?!?: \S.*$/;

const MARKDOWN_TABLE_ROW_PATTERN = /^\|.+\|.+\|$/;
const MARKDOWN_TABLE_SEPARATOR_PATTERN = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;

const PR_READ_ONLY_GIT_ALLOWED_TOOLS: readonly string[] = [
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git show*)',
  'Bash(git rev-parse*)',
  'Bash(git branch)',
  'Bash(git branch --show-current*)',
  'Bash(git branch -a*)',
  'Bash(git branch -v*)',
  'Bash(git branch --list*)',
];

const PR_FORBIDDEN_MUTATION_BASH_TOOLS: readonly string[] = [
  ...GIT_WRITE_DENIED_BASH_TOOLS,
  'Bash(git merge*)',
  'Bash(git rebase*)',
  'Bash(git cherry-pick*)',
  'Bash(git tag*)',
  'Bash(git branch -d*)',
  'Bash(git branch -D*)',
  'Bash(git branch -m*)',
  'Bash(git branch -M*)',
  'Bash(git branch --delete*)',
  'Bash(git branch --move*)',
  'Bash(gh *)',
  'Bash(gh pr*)',
  'Bash(glab *)',
];

function hasMarkdownTable(bodyLines: readonly string[]): boolean {
  let hasSeparator = false;
  let hasDataRow = false;
  for (const rawLine of bodyLines) {
    const line = rawLine.trim();
    if (!MARKDOWN_TABLE_ROW_PATTERN.test(line)) {
      continue;
    }
    if (MARKDOWN_TABLE_SEPARATOR_PATTERN.test(line)) {
      hasSeparator = true;
      continue;
    }
    if (hasSeparator) {
      hasDataRow = true;
    }
  }
  return hasSeparator && hasDataRow;
}

/** Valida se um título de PR segue o formato Conventional Commits (`tipo(escopo?): descrição`). */
export function isConventionalCommitTitle(title: string): boolean {
  return CONVENTIONAL_COMMIT_TITLE_PATTERN.test(title.trim());
}

/**
 * Argumentos restritos do runner da Etapa 1 do Bloco 06:
 * inspeção Git somente leitura no worktree e escrita exclusiva do `pr_summary` e sidecar JSON,
 * bloqueando mutações Git e comandos de publicação (`git commit`, `git push`, `gh pr`).
 */
export function buildPrRunnerArgs(reportPath: string): string[] {
  return buildRestrictedRunnerArgs({
    additionalDirectory: dirname(reportPath),
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    allowed: [
      'Read',
      'Glob',
      'Grep',
      ...buildReportFileToolPermissions(reportPath),
      ...PR_READ_ONLY_GIT_ALLOWED_TOOLS,
    ],
    denied: [
      ...INFRA_AND_CONFIG_PATHS.flatMap(path => [`Edit(${path})`, `Write(${path})`]),
      ...PR_FORBIDDEN_MUTATION_BASH_TOOLS,
    ],
  });
}

/**
 * Lê e valida os artefatos obrigatórios das Etapas 01 a 05, critérios de aceite, evidências reais
 * do executor determinístico do Bloco 04 e ressalvas/decisões da triagem do Review para a Etapa 1 do Bloco 06.
 */
export async function readFactoryPrInputs(details: FactoryFlowDetails) {
  const paths = await readReadyStageDocuments(
    details,
    ['triage', 'planning', 'development', 'tests', 'review'],
    'Os documentos das Etapas 01 a 05 são obrigatórios para executar a etapa de PR.',
  );
  const triageSidecar = readFactoryStageSidecar('triage', paths.triage);
  const developmentSidecar = readFactoryStageSidecar('development', paths.development);
  const testsSidecar = readFactoryStageSidecar('tests', paths.tests);
  const reviewSidecar = readFactoryStageSidecar('review', paths.review);

  const testResults = {
    status: testsSidecar.status,
    executedCommands: testsSidecar.executedCommands,
    coverage: testsSidecar.coverage,
    testCases: testsSidecar.testCases,
    ...(testsSidecar.backendChecks ? { backendChecks: testsSidecar.backendChecks } : {}),
  };
  const developmentChecks = developmentSidecar.backendChecks;
  const planningApproval = details.flow.planningApproval ?? undefined;
  const reviewOutcome = {
    verdict: reviewSidecar.verdict,
    findings: reviewSidecar.findings,
  };
  const reviewTriageScope = readFactoryReviewTriageScope(details);

  return {
    understandingReportPath: paths.triage,
    implementationPlanPath: paths.planning,
    implementationReportPath: paths.development,
    testReportPath: paths.tests,
    reviewReportPath: paths.review,
    acceptanceCriteria: triageSidecar.acceptanceCriteria,
    ...(triageSidecar.jiraContext ? { jiraContext: triageSidecar.jiraContext } : {}),
    ...(triageSidecar.negativeScope.length > 0
      ? { negativeScope: triageSidecar.negativeScope }
      : {}),
    ...(planningApproval ? { planningApproval } : {}),
    ...(developmentChecks ? { developmentChecks } : {}),
    testResults,
    reviewOutcome,
    ...(reviewTriageScope ? { reviewTriageScope } : {}),
    approvedNotes: details.stages.find(stage => stage.name === 'pr')?.approvedNotes,
  };
}

/**
 * Valida a estrutura mínima do artefato `pr_summary` em Markdown,
 * exigindo a tabela de critérios de aceite e evidências na seção de validação.
 */
export function isPrSummary(content: string): boolean {
  return validateStructuredMarkdownReport(content, PR_SUMMARY_TITLE, PR_SUMMARY_SECTIONS, {
    [PR_SUMMARY_SECTIONS.validation]: hasMarkdownTable,
  });
}
