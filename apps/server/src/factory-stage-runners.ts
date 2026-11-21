import { basename, dirname } from 'node:path';
import {
  getLatestReadyFactoryStageArtifact,
  getReadyFactoryStageArtifact,
} from '@development-factory/shared';
import type { FactoryFlowDetails } from '@development-factory/shared';
import { readHistoryFile } from './history-reader.js';

export type HandoffArtifactStage = 'triage' | 'planning' | 'development' | 'tests' | 'review';

export const TEST_AND_FIXTURE_PATTERNS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/test_*.*',
  '**/*_spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/spec/**',
  '**/specs/**',
  '**/e2e/**',
  '**/cypress/**',
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/__mocks__/**',
  '**/__snapshots__/**',
];

export const INFRA_AND_CONFIG_PATHS: readonly string[] = [
  '**/*.config.*',
  '**/.git/**',
  '**/.github/**',
  '**/.claude/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
];

export const GIT_WRITE_DENIED_BASH_TOOLS: readonly string[] = [
  'Bash(git push*)',
  'Bash(git commit*)',
  'Bash(git checkout*)',
  'Bash(git reset*)',
  'Bash(git clean*)',
  'Bash(git add*)',
];

export interface RestrictedRunnerArgsConfig {
  readonly tools: readonly string[];
  readonly allowed: readonly string[];
  readonly denied: readonly string[];
}

/** Constrói a linha de argumentos `--restricted` padrão para runners da Factory. */
export function buildRestrictedRunnerArgs(config: RestrictedRunnerArgsConfig): string[] {
  return [
    '--restricted',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--no-chrome',
    '--permission-mode',
    'dontAsk',
    '--tools',
    config.tools.join(','),
    '--allowedTools',
    config.allowed.join(','),
    '--disallowedTools',
    config.denied.join(','),
  ];
}

/** Lê e valida os artefatos Markdown obrigatórios de etapas anteriores para o handoff. */
export async function readReadyStageDocuments<const Stages extends readonly HandoffArtifactStage[]>(
  details: FactoryFlowDetails,
  stages: Stages,
  missingMessage: string,
): Promise<Record<Stages[number], string>> {
  const paths = await Promise.all(
    stages.map(async stage => {
      const artifact = getReadyFactoryStageArtifact(details, stage);
      if (!artifact) {
        return undefined;
      }
      const document = await readHistoryFile(dirname(artifact.path), basename(artifact.path));
      return document.content.trim() ? document.path : undefined;
    }),
  );

  const result = {} as Record<Stages[number], string>;
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    const filePath = paths[index];
    if (!stage || !filePath) {
      throw new Error(missingMessage);
    }
    result[stage as Stages[number]] = filePath;
  }
  return result;
}

/** Lê o artefato pronto mais recente de uma etapa (se existir e estiver legível no disco). */
export async function readOptionalLatestStageDocument(
  details: FactoryFlowDetails,
  stage: HandoffArtifactStage,
): Promise<string | undefined> {
  const artifact = getLatestReadyFactoryStageArtifact(details, stage);
  if (!artifact) {
    return undefined;
  }
  try {
    const document = await readHistoryFile(dirname(artifact.path), basename(artifact.path));
    return document.content.trim() ? document.path : undefined;
  } catch {
    return undefined;
  }
}

/** Valida título e seções obrigatórias de um relatório Markdown gerado por um runner da Factory. */
export function validateStructuredMarkdownReport(
  content: string,
  title: string,
  sections: Readonly<Record<string, string>>,
  customValidators: Readonly<Partial<Record<string, (bodyLines: readonly string[]) => boolean>>> = {},
): boolean {
  const [header, ...rawSections] = content.split(/^## /m);
  if (header?.split('\n')[0]?.trim() !== `# ${title}`) {
    return false;
  }

  return Object.values(sections).every(heading =>
    rawSections.some(section => {
      const [sectionTitle, ...body] = section.split('\n');
      if (sectionTitle?.trim() !== heading) {
        return false;
      }
      const validator = customValidators[heading];
      return validator ? validator(body) : body.some(line => line.trim().length > 0);
    }),
  );
}
