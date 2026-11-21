import { dirname } from 'node:path';
import type { FactoryFlowDetails } from '@development-factory/shared';
import {
  INFRA_AND_CONFIG_PATHS,
  TEST_AND_FIXTURE_PATTERNS,
  buildReportFileToolPermissions,
  buildRestrictedRunnerArgs,
  readOptionalLatestStageDocument,
  readReadyStageDocuments,
  validateStructuredMarkdownReport,
} from './factory-stage-runners.js';
import {
  IMPLEMENTATION_REPORT_SECTIONS,
  IMPLEMENTATION_REPORT_TITLE,
} from './prompts/factory-development.js';

const SOURCE_EXTENSIONS = [
  'astro', 'c', 'cc', 'cpp', 'cs', 'css', 'dart', 'ex', 'go', 'h', 'hpp', 'html', 'java', 'js',
  'jsx', 'kt', 'kts', 'less', 'mjs', 'cjs', 'mts', 'cts', 'php', 'py', 'rb', 'rs', 'sass', 'scala',
  'scss', 'sql', 'svelte', 'swift', 'ts', 'tsx', 'vue',
];

const PROTECTED_PATHS = [...TEST_AND_FIXTURE_PATTERNS, ...INFRA_AND_CONFIG_PATHS];

export function buildDevelopmentRunnerArgs(reportPath: string): string[] {
  return buildRestrictedRunnerArgs({
    additionalDirectory: dirname(reportPath),
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
    allowed: [
      'Read',
      'Glob',
      'Grep',
      ...SOURCE_EXTENSIONS.flatMap(extension => [
        `Edit(**/*.${extension})`,
        `Write(**/*.${extension})`,
      ]),
      ...buildReportFileToolPermissions(reportPath),
    ],
    denied: PROTECTED_PATHS.flatMap(path => [`Edit(${path})`, `Write(${path})`]),
  });
}

export async function readFactoryDevelopmentInputs(details: FactoryFlowDetails) {
  const paths = await readReadyStageDocuments(
    details,
    ['triage', 'planning'],
    'Os documentos das Etapas 01 e 02 são obrigatórios.',
  );
  const iteration = details.flow.iteration > 0 ? details.flow.iteration : 1;
  const [previousImplementationReportPath, testReportPath, reviewReportPath] =
    iteration >= 2
      ? await Promise.all([
          readOptionalLatestStageDocument(details, 'development'),
          readOptionalLatestStageDocument(details, 'tests'),
          readOptionalLatestStageDocument(details, 'review'),
        ])
      : [undefined, undefined, undefined];

  return {
    understandingReportPath: paths.triage,
    implementationPlanPath: paths.planning,
    approvedNotes: details.stages.find(stage => stage.name === 'development')?.approvedNotes,
    iteration,
    maxIterations: details.flow.maxIterations,
    ...(previousImplementationReportPath ? { previousImplementationReportPath } : {}),
    ...(testReportPath ? { testReportPath } : {}),
    ...(reviewReportPath ? { reviewReportPath } : {}),
  };
}

export function isImplementationReport(content: string): boolean {
  const statusTableRow =
    /^\|.+?\|\s*(?:\*\*)?(?:concluído|parcial|bloqueado|adiado)(?:\*\*)?\s*\|.*\|$/iu;
  return validateStructuredMarkdownReport(
    content,
    IMPLEMENTATION_REPORT_TITLE,
    IMPLEMENTATION_REPORT_SECTIONS,
    {
      [IMPLEMENTATION_REPORT_SECTIONS.planStatus]: body =>
        body.some(line => statusTableRow.test(line.trim())),
    },
  );
}
