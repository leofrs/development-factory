import { dirname } from 'node:path';
import type { FactoryFlowDetails, FactoryRepositoryProfile } from '@development-factory/shared';
import {
  GIT_WRITE_DENIED_BASH_TOOLS,
  INFRA_AND_CONFIG_PATHS,
  TEST_AND_FIXTURE_PATTERNS,
  buildReportFileToolPermissions,
  buildRestrictedRunnerArgs,
  readFactoryStageSidecar,
  readOptionalLatestStageDocument,
  readReadyStageDocuments,
  validateStructuredMarkdownReport,
} from './factory-stage-runners.js';
import { TEST_REPORT_SECTIONS, TEST_REPORT_TITLE } from './prompts/factory-tests.js';

const SAFE_UNQUOTED_TOKEN_PATTERN = /^[A-Za-z0-9_./:=+-]+$/;
const UNSAFE_ALLOWED_TOOL_CHARS_PATTERN = /[,()*?[\]\n\r\0]/;

const TESTS_NETWORK_AND_SHELL_DENIED_BASH_TOOLS: readonly string[] = [
  'Bash(curl*)',
  'Bash(wget*)',
  'Bash(ssh*)',
  'Bash(scp*)',
  'Bash(nc*)',
  'Bash(ncat*)',
  'Bash(sh *)',
  'Bash(bash *)',
  'Bash(zsh *)',
];

function formatBashArgument(token: string): string {
  if (SAFE_UNQUOTED_TOKEN_PATTERN.test(token)) {
    return token;
  }
  return `'${token.replaceAll("'", "'\\''")}'`;
}

/**
 * Converte apenas os comandos `test` e `coverage` do perfil em uma whitelist estrita para `Bash(...)`,
 * sem liberar shell genérico nem caracteres que possam quebrar regras `--allowedTools`.
 */
export function buildTestsBashAllowedTools(
  commands?: Pick<FactoryRepositoryProfile['commands'], 'test' | 'coverage'>,
): string[] {
  if (!commands) {
    return [];
  }
  const patterns = new Set<string>();
  for (const command of [commands.test, commands.coverage]) {
    if (!command || command.some(token => UNSAFE_ALLOWED_TOOL_CHARS_PATTERN.test(token))) {
      continue;
    }
    const formatted = command.map(formatBashArgument).join(' ');
    if (formatted.length === 0) {
      continue;
    }
    patterns.add(`Bash(${formatted})`);
    patterns.add(`Bash(${formatted} *)`);
  }
  return [...patterns];
}

/** Argumentos restritos do runner da Etapa 04 (escrita apenas em testes/fixtures + whitelist de testes do perfil). */
export function buildTestsRunnerArgs(
  reportPath: string,
  repositoryProfile?: FactoryRepositoryProfile,
): string[] {
  const bashAllowed = buildTestsBashAllowedTools(repositoryProfile?.commands);
  const hasBash = bashAllowed.length > 0;
  const deniedWritePaths = [
    ...INFRA_AND_CONFIG_PATHS,
    ...(repositoryProfile?.protectedPaths ?? []),
  ];

  return buildRestrictedRunnerArgs({
    additionalDirectory: dirname(reportPath),
    tools: hasBash
      ? ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']
      : ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
    allowed: [
      'Read',
      'Glob',
      'Grep',
      ...bashAllowed,
      ...TEST_AND_FIXTURE_PATTERNS.flatMap(pattern => [`Edit(${pattern})`, `Write(${pattern})`]),
      ...buildReportFileToolPermissions(reportPath),
    ],
    denied: [
      ...deniedWritePaths.flatMap(path => [`Edit(${path})`, `Write(${path})`]),
      ...(hasBash ? [] : ['Bash']),
      ...GIT_WRITE_DENIED_BASH_TOOLS,
      ...TESTS_NETWORK_AND_SHELL_DENIED_BASH_TOOLS,
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
