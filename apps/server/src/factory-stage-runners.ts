import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { z } from 'zod';
import {
  FactoryDevelopmentSidecarSchema,
  FactoryPlanningSidecarSchema,
  FactoryPrSidecarSchema,
  FactoryReviewSidecarSchema,
  FactoryTestsSidecarSchema,
  FactoryTriageSidecarSchema,
  getLatestReadyFactoryStageArtifact,
  getReadyFactoryStageArtifact,
} from '@development-factory/shared';
import type {
  FactoryArtifactIssue,
  FactoryDevelopmentSidecar,
  FactoryFlowDetails,
  FactoryPlanningSidecar,
  FactoryPrSidecar,
  FactoryReviewSidecar,
  FactoryStageName,
  FactoryTestsSidecar,
  FactoryTriageSidecar,
  HistoryFile,
} from '@development-factory/shared';
import { maxHistoryBytes, readHistoryFile } from './history-reader.js';

export type HandoffArtifactStage = Exclude<FactoryStageName, 'pr'>;

export interface FactoryStageSidecarMap {
  readonly triage: FactoryTriageSidecar;
  readonly planning: FactoryPlanningSidecar;
  readonly development: FactoryDevelopmentSidecar;
  readonly tests: FactoryTestsSidecar;
  readonly review: FactoryReviewSidecar;
  readonly pr: FactoryPrSidecar;
}

const SIDECAR_SCHEMAS: { [K in FactoryStageName]: z.ZodType<FactoryStageSidecarMap[K]> } = {
  triage: FactoryTriageSidecarSchema,
  planning: FactoryPlanningSidecarSchema,
  development: FactoryDevelopmentSidecarSchema,
  tests: FactoryTestsSidecarSchema,
  review: FactoryReviewSidecarSchema,
  pr: FactoryPrSidecarSchema,
};

const sidecarErrorLocale = z.locales.pt().localeError;

type FactoryStageArtifactErrorCode =
  | 'FACTORY_MARKDOWN_READ_FAILED'
  | 'FACTORY_MARKDOWN_INVALID'
  | 'FACTORY_SIDECAR_READ_FAILED'
  | 'FACTORY_SIDECAR_MISSING'
  | 'FACTORY_SIDECAR_INVALID_JSON'
  | 'FACTORY_SIDECAR_INVALID_SCHEMA'
  | 'FACTORY_SIDECAR_WRITE_FAILED'
  | 'FACTORY_DEVELOPMENT_CHECKS_FAILED';

export function formatArtifactIssue(issue: FactoryArtifactIssue): string {
  const field = issue.path.reduce<string>((path, segment) => {
    if (typeof segment === 'number') {
      return `${path}[${segment}]`;
    }
    return /^[a-z_][a-z_\d]*$/i.test(segment)
      ? `${path}.${segment}`
      : `${path}[${JSON.stringify(segment)}]`;
  }, '$');
  return `${field} (${issue.message})`;
}

export class FactoryStageArtifactError extends Error {
  readonly details: readonly string[];

  constructor(
    public readonly code: FactoryStageArtifactErrorCode,
    stage: FactoryStageName,
    path: string,
    message: string,
    public readonly issues: FactoryArtifactIssue[] = [],
  ) {
    const details = issues.map(formatArtifactIssue);
    const summary = `${message} (${stage}, ${basename(path)}).`;
    super(details.length > 0 ? `${summary} ${details.join(' | ')}` : summary);
    this.name = 'FactoryStageArtifactError';
    this.details = details;
  }
}

export function getFactoryStageSidecarPath(reportPath: string): string {
  const extension = extname(reportPath);
  if (extension.toLowerCase() !== '.md') {
    throw new Error('O relatório da Factory precisa ter a extensão .md.');
  }
  return `${reportPath.slice(0, -extension.length)}.json`;
}

export function readFactoryArtifactFile(path: string): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maxHistoryBytes) {
      throw new Error('O artefato precisa ser um arquivo regular de até 5 MB.');
    }
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset !== info.size) {
      throw new Error('O tamanho do artefato mudou durante a leitura.');
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

export function readFactoryStageSidecar<Stage extends FactoryStageName>(
  stage: Stage,
  reportPath: string,
): FactoryStageSidecarMap[Stage] {
  const path = getFactoryStageSidecarPath(reportPath);
  let content: Buffer;
  try {
    content = readFactoryArtifactFile(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new FactoryStageArtifactError(
        'FACTORY_SIDECAR_READ_FAILED',
        stage,
        path,
        'Não foi possível ler o sidecar como arquivo regular de até 5 MB, sem link simbólico',
      );
    }
    content = Buffer.alloc(0);
  }
  if (content.length === 0) {
    throw new FactoryStageArtifactError(
      'FACTORY_SIDECAR_MISSING',
      stage,
      path,
      'O sidecar JSON está ausente ou vazio',
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
  } catch (error) {
    const location =
      error instanceof SyntaxError ? /\(line (\d+) column (\d+)\)$/.exec(error.message) : null;
    const message = location
      ? `Confira a sintaxe na linha ${location[1]}, coluna ${location[2]}.`
      : 'Confira a sintaxe e a codificação UTF-8.';
    throw new FactoryStageArtifactError(
      'FACTORY_SIDECAR_INVALID_JSON',
      stage,
      path,
      'O sidecar contém JSON inválido',
      [{ code: 'invalid_json', path: [], message }],
    );
  }

  const schema: z.ZodType<FactoryStageSidecarMap[Stage]> = SIDECAR_SCHEMAS[stage];
  const parsed = schema.safeParse(input, { error: sidecarErrorLocale });
  if (!parsed.success) {
    const issues = parsed.error.issues.flatMap<FactoryArtifactIssue>(issue => {
      const field = issue.path.map(segment =>
        typeof segment === 'symbol' ? String(segment) : segment,
      );
      if (issue.code === 'unrecognized_keys') {
        return issue.keys.map(key => ({
          code: issue.code,
          path: [...field, key],
          message: 'Campo desconhecido.',
        }));
      }
      return [{ code: issue.code, path: field, message: issue.message }];
    });
    throw new FactoryStageArtifactError(
      'FACTORY_SIDECAR_INVALID_SCHEMA',
      stage,
      path,
      'O sidecar JSON não atende ao contrato da etapa',
      issues,
    );
  }
  return parsed.data;
}

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
  readonly additionalDirectory?: string;
  readonly allowedMcpServerUrl?: string;
}

/** Constrói permissões explícitas de escrita para o par de arquivos externos da etapa. */
export function buildReportFileToolPermissions(reportPath: string): string[] {
  return [reportPath, getFactoryStageSidecarPath(reportPath)].flatMap(path => {
    const normalizedPath = path.startsWith('/') ? `/${path}` : path;
    return [`Edit(${normalizedPath})`, `Write(${normalizedPath})`];
  });
}

/** Constrói a linha de argumentos `--restricted` padrão para runners da Factory. */
export function buildRestrictedRunnerArgs(config: RestrictedRunnerArgsConfig): string[] {
  const mcpArgs = config.allowedMcpServerUrl
    ? [
        '--settings',
        JSON.stringify({ allowedMcpServers: [{ serverUrl: config.allowedMcpServerUrl }] }),
      ]
    : ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];

  return [
    '--restricted',
    ...mcpArgs,
    '--no-chrome',
    '--permission-mode',
    'dontAsk',
    ...(config.additionalDirectory ? ['--add-dir', config.additionalDirectory] : []),
    '--tools',
    config.tools.join(','),
    '--allowedTools',
    config.allowed.join(','),
    ...(config.denied.length > 0 ? ['--disallowedTools', config.denied.join(',')] : []),
  ];
}

const JIRA_READ_TOOLS = [
  'getAccessibleAtlassianResources',
  'getJiraIssue',
  'listJiraIssueComments',
  'searchJiraIssuesUsingJql',
  'discover',
  'executeRead',
].map(tool => `mcp__claude_ai_Atlassian_Rovo__${tool}`);

export function buildTriageAndPlanningRunnerArgs(
  stage: 'triage' | 'planning',
  reportPath: string,
): string[] {
  const isTriage = stage === 'triage';
  const readTools = isTriage ? ['Read'] : ['Read', 'Glob', 'Grep'];

  return buildRestrictedRunnerArgs({
    additionalDirectory: dirname(reportPath),
    ...(isTriage ? { allowedMcpServerUrl: 'https://mcp.atlassian.com/*' } : {}),
    tools: [...readTools, 'Edit', 'Write'],
    allowed: [
      ...readTools,
      ...(isTriage ? JIRA_READ_TOOLS : []),
      ...buildReportFileToolPermissions(reportPath),
    ],
    denied: [],
  });
}

export async function readFactoryStageDocument(
  stage: HandoffArtifactStage,
  reportPath: string,
): Promise<HistoryFile> {
  const document = await readHistoryFile(dirname(reportPath), basename(reportPath)).catch(() => {
    throw new FactoryStageArtifactError(
      'FACTORY_MARKDOWN_READ_FAILED',
      stage,
      reportPath,
      'Não foi possível ler o relatório Markdown do handoff',
    );
  });
  if (document.content.trim().length === 0) {
    throw new FactoryStageArtifactError(
      'FACTORY_MARKDOWN_INVALID',
      stage,
      reportPath,
      'O relatório Markdown do handoff está vazio',
    );
  }
  readFactoryStageSidecar(stage, document.path);
  return document;
}

/** Lê os relatórios obrigatórios de etapas anteriores e valida seus sidecars para o handoff. */
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
      return (await readFactoryStageDocument(stage, artifact.path)).path;
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

/** Lê o par mais recente de uma etapa, se disponível, e diagnostica sidecars malformados. */
export async function readOptionalLatestStageDocument(
  details: FactoryFlowDetails,
  stage: HandoffArtifactStage,
): Promise<string | undefined> {
  const artifact = getLatestReadyFactoryStageArtifact(details, stage);
  if (!artifact) {
    return undefined;
  }
  try {
    return (await readFactoryStageDocument(stage, artifact.path)).path;
  } catch (error) {
    if (
      error instanceof FactoryStageArtifactError &&
      (error.code === 'FACTORY_MARKDOWN_READ_FAILED' ||
        error.code === 'FACTORY_MARKDOWN_INVALID' ||
        error.code === 'FACTORY_SIDECAR_MISSING')
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Normaliza títulos de seção Markdown para comparação tolerante a formatação, numeração e acentos. */
export function normalizeMarkdownHeadingKey(value: string): string {
  return value
    .replaceAll('**', '')
    .replaceAll('__', '')
    .replace(/`/g, '')
    .trim()
    .replace(/^(?:\d+[.)][ \t]+)+/, '')
    .replace(/[.:]+$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function resolveCanonicalMarkdownSection(
  rawHeading: string,
  sections: Readonly<Record<string, string>>,
  aliases?: Readonly<Record<string, string>>,
): string | null {
  const key = normalizeMarkdownHeadingKey(rawHeading);
  const canonical = aliases?.[key];
  if (canonical && Object.values(sections).includes(canonical)) {
    return canonical;
  }
  const exact = Object.values(sections).find(title => normalizeMarkdownHeadingKey(title) === key);
  return exact ?? null;
}

/**
 * Normaliza variações naturais de Markdown (BOM, frontmatter YAML, quebras CRLF, sufixos no título,
 * níveis de cabeçalho, aliases e itens numerados em negrito) para os cabeçalhos canônicos da etapa.
 */
export function normalizeStructuredMarkdownReport(
  content: string,
  title: string,
  sections: Readonly<Record<string, string>>,
  aliases?: Readonly<Record<string, string>>,
): string {
  const stripped = content
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .replace(/^---\n[\s\S]*?\n---\n+/, '')
    .trimStart();
  const normalizedTitleKey = normalizeMarkdownHeadingKey(title);

  return stripped
    .replace(/^# +([^\n]+)$/m, (line: string, heading: string) => {
      const key = normalizeMarkdownHeadingKey(heading);
      if (
        key === normalizedTitleKey ||
        key.startsWith(`${normalizedTitleKey} `) ||
        key.startsWith(`${normalizedTitleKey}:`) ||
        key.startsWith(`${normalizedTitleKey}-`) ||
        key.startsWith(`${normalizedTitleKey}—`) ||
        key.startsWith(`${normalizedTitleKey}(`)
      ) {
        return `# ${title}`;
      }
      return line;
    })
    .replace(/^#{2,6}[ \t]+([^\n]+)$/gm, (line: string, heading: string) => {
      const canonical = resolveCanonicalMarkdownSection(heading, sections, aliases);
      return canonical ? `## ${canonical}` : line;
    })
    .replace(
      /^\d+[.)][ \t]+\*\*([^*\r\n]+)\*\*[.:]?[ \t]*([^\r\n]*)/gm,
      (line: string, heading: string, body: string) => {
        const canonical = resolveCanonicalMarkdownSection(heading, sections, aliases);
        return canonical ? `## ${canonical}\n${body}` : line;
      },
    );
}

/** Lista o título ou as seções obrigatórias ausentes/vazias de um relatório Markdown estruturado. */
export function describeMissingStructuredReportParts(
  normalizedContent: string,
  title: string,
  sections: Readonly<Record<string, string>>,
  customValidators: Readonly<Partial<Record<string, (bodyLines: readonly string[]) => boolean>>> = {},
): string[] {
  const normalized = normalizedContent.replace(/\r\n?/g, '\n');
  const [header, ...rawSections] = normalized.split(/^## /m);
  const missing: string[] = [];
  if (header?.split('\n')[0]?.trim() !== `# ${title}`) {
    missing.push(`título "# ${title}"`);
  }
  for (const heading of Object.values(sections)) {
    const validator = customValidators[heading];
    const found = rawSections.some(section => {
      const [sectionTitle, ...body] = section.split('\n');
      if (sectionTitle?.trim() !== heading) {
        return false;
      }
      return validator ? validator(body) : body.some(line => line.trim().length > 0);
    });
    if (!found) {
      missing.push(heading);
    }
  }
  return missing;
}

/** Valida título e seções obrigatórias de um relatório Markdown gerado por um runner da Factory. */
export function validateStructuredMarkdownReport(
  content: string,
  title: string,
  sections: Readonly<Record<string, string>>,
  customValidators: Readonly<Partial<Record<string, (bodyLines: readonly string[]) => boolean>>> = {},
): boolean {
  return describeMissingStructuredReportParts(content, title, sections, customValidators).length === 0;
}
