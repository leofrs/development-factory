import { basename } from 'node:path';
import {
  FactoryReviewVerdictSchema,
  type FactoryFlowDetails,
  type FactoryReviewVerdict,
} from '@development-factory/shared';
import {
  GIT_WRITE_DENIED_BASH_TOOLS,
  buildRestrictedRunnerArgs,
  readOptionalLatestStageDocument,
  readReadyStageDocuments,
  validateStructuredMarkdownReport,
} from './factory-stage-runners.js';
import {
  REVIEW_REPORT_SECTIONS,
  REVIEW_REPORT_TITLE,
  REVIEW_VERDICT_LABELS,
} from './prompts/factory-review.js';

const VERDICT_PREFIX_PATTERN =
  /^(?:[-*]\s*)?(?:\*\*|__)?(?:veredito|parecer(?:\s+final)?|decis[aã]o)(?:\*\*|__)?\s*:\s*(.+)$/iu;

function extractSectionBody(content: string, heading: string): string[] | null {
  const [, ...rawSections] = content.split(/^## /m);
  for (const section of rawSections) {
    const [sectionTitle, ...body] = section.split('\n');
    if (sectionTitle?.trim() === heading) {
      return body;
    }
  }
  return null;
}

function normalizeVerdictToken(raw: string): string {
  return raw
    .replace(/[*_`]/g, '')
    .replace(/^\s*[-*]\s*/, '')
    .trim()
    .replace(/[.!]+$/, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function matchVerdictToken(normalized: string): FactoryReviewVerdict | null {
  const hasApproval =
    normalized.includes(REVIEW_VERDICT_LABELS.approved) ||
    normalized.includes(REVIEW_VERDICT_LABELS.approvedWithWarnings);
  const hasRejection =
    normalized.includes(REVIEW_VERDICT_LABELS.changesRequested) ||
    normalized.includes('REPROVADO') ||
    normalized.includes('REQUER AJUSTES');

  if (hasApproval && hasRejection) {
    return null;
  }

  if (
    normalized === REVIEW_VERDICT_LABELS.approvedWithWarnings ||
    normalized.startsWith(`${REVIEW_VERDICT_LABELS.approvedWithWarnings} `)
  ) {
    return FactoryReviewVerdictSchema.parse('approved_with_warnings');
  }

  if (
    normalized === REVIEW_VERDICT_LABELS.approved ||
    normalized.startsWith(`${REVIEW_VERDICT_LABELS.approved} `)
  ) {
    return FactoryReviewVerdictSchema.parse('approved');
  }

  if (
    normalized === REVIEW_VERDICT_LABELS.changesRequested ||
    normalized.startsWith(`${REVIEW_VERDICT_LABELS.changesRequested} `) ||
    normalized === 'REPROVADO' ||
    normalized === 'REQUER AJUSTES'
  ) {
    return FactoryReviewVerdictSchema.parse('changes_requested');
  }

  return null;
}

/**
 * Analisa deterministicamente o veredito da seção `## Parecer Final` do `review_report`.
 * Retorna `null` quando o veredito estiver ausente ou ambíguo.
 */
export function parseReviewVerdict(content: string): FactoryReviewVerdict | null {
  const verdictBody = extractSectionBody(content, REVIEW_REPORT_SECTIONS.verdict);
  if (!verdictBody) {
    return null;
  }

  const nonEmptyLines = verdictBody.map(line => line.trim()).filter(line => line.length > 0);
  if (nonEmptyLines.length === 0) {
    return null;
  }

  for (const line of nonEmptyLines) {
    const prefixMatch = VERDICT_PREFIX_PATTERN.exec(line);
    if (prefixMatch?.[1] !== undefined) {
      return matchVerdictToken(normalizeVerdictToken(prefixMatch[1]));
    }
  }

  const firstLine = nonEmptyLines[0];
  return firstLine ? matchVerdictToken(normalizeVerdictToken(firstLine)) : null;
}

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
  const iteration = details.flow.iteration > 0 ? details.flow.iteration : 1;
  const previousReviewReportPath =
    iteration >= 2 ? await readOptionalLatestStageDocument(details, 'review') : undefined;
  return {
    understandingReportPath: paths.triage,
    implementationPlanPath: paths.planning,
    implementationReportPath: paths.development,
    testReportPath: paths.tests,
    approvedNotes: details.stages.find(stage => stage.name === 'review')?.approvedNotes,
    iteration,
    maxIterations: details.flow.maxIterations,
    ...(previousReviewReportPath ? { previousReviewReportPath } : {}),
  };
}

/** Valida a estrutura mínima e o veredito determinístico do artefato `review_report` em Markdown. */
export function isReviewReport(content: string): boolean {
  return (
    validateStructuredMarkdownReport(content, REVIEW_REPORT_TITLE, REVIEW_REPORT_SECTIONS) &&
    parseReviewVerdict(content) !== null
  );
}
