import { posix } from 'node:path';
import {
  FactoryReviewVerdictSchema,
  ReturnFactoryTargetStageSchema,
  getLatestReadyFactoryStageArtifact,
  resolveFactoryReviewDecision,
} from '@development-factory/shared';
import type {
  FactoryFlowDetails,
  FactoryReviewDecision,
  FactoryReviewSidecar,
  FactoryReviewVerdict,
  ReturnFactoryTargetStage,
} from '@development-factory/shared';
import {
  GIT_WRITE_DENIED_BASH_TOOLS,
  buildReportFileToolPermissions,
  buildRestrictedRunnerArgs,
  readFactoryArtifactFile,
  readFactoryStageSidecar,
  readOptionalLatestStageDocument,
  readReadyStageDocuments,
  validateStructuredMarkdownReport,
} from './factory-stage-runners.js';
import { FactoryWorktreeError, hasEmptyFactoryWorktreeCheckpointDiff } from './factory-worktree.js';
import {
  REVIEW_REPORT_SECTIONS,
  REVIEW_REPORT_TITLE,
  REVIEW_VERDICT_LABELS,
} from './prompts/factory-review.js';

const VERDICT_PREFIX_PATTERN =
  /^(?:[-*]\s*)?(?:\*\*|__)?(?:veredito|parecer(?:\s+final)?|decis[aã]o)(?:\*\*|__)?\s*:\s*(.+)$/iu;
const RETURN_TARGET_PREFIX_PATTERN =
  /^(?:[-*]\s*)?(?:\*\*|__)?(?:alvo(?:\s+de\s+retorno)?|retorno|returnTarget)(?:\*\*|__)?\s*:\s*(.+)$/iu;

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

/**
 * Analisa opcionalmente o alvo de retorno explícito na seção `## Parecer Final` do `review_report`.
 * Retorna `null` quando ausente ou ambíguo.
 */
export function parseReviewReturnTarget(content: string): ReturnFactoryTargetStage | null {
  const verdictBody = extractSectionBody(content, REVIEW_REPORT_SECTIONS.verdict);
  if (!verdictBody) {
    return null;
  }

  for (const rawLine of verdictBody) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const prefixMatch = RETURN_TARGET_PREFIX_PATTERN.exec(line);
    if (prefixMatch?.[1] === undefined) {
      continue;
    }
    const normalized = normalizeVerdictToken(prefixMatch[1]).toLowerCase();
    const isAmbiguous =
      /(?:\bdevelopment\b|\bdesenvolvimento\b).*(?:\||\/|\bou\b).*(?:\btests\b|\btestes\b)|(?:\btests\b|\btestes\b).*(?:\||\/|\bou\b).*(?:\bdevelopment\b|\bdesenvolvimento\b)/.test(
        normalized,
      );
    if (isAmbiguous) {
      return null;
    }
    if (/^(?:development|desenvolvimento)(?:\b|$)/.test(normalized)) {
      return ReturnFactoryTargetStageSchema.parse('development');
    }
    if (/^(?:tests|testes)(?:\b|$)/.test(normalized)) {
      return ReturnFactoryTargetStageSchema.parse('tests');
    }
    return null;
  }

  return null;
}

type ReviewResult = FactoryReviewDecision & Pick<FactoryReviewSidecar, 'findings'>;

export function readFactoryReviewResult(reportPath: string | null): ReviewResult | null {
  if (!reportPath) {
    return null;
  }

  try {
    const content = readFactoryArtifactFile(reportPath).toString('utf8');
    const sidecar = readFactoryStageSidecar('review', reportPath);
    const decision = resolveFactoryReviewDecision(sidecar);
    const markdownReturnTarget = parseReviewReturnTarget(content);
    if (
      parseReviewVerdict(content) !== decision.verdict ||
      (markdownReturnTarget !== null && markdownReturnTarget !== decision.returnTarget)
    ) {
      return null;
    }
    return { ...decision, findings: sidecar.findings };
  } catch {
    return null;
  }
}

function normalizeFindingText(value: string): string {
  return value.normalize().trim().replace(/\s+/g, ' ').toLowerCase();
}

function getBlockingFindingIdentities(findings: FactoryReviewSidecar['findings']) {
  return findings
    .filter(finding => finding.severity === 'BLOQUEANTE')
    .map(finding => ({
      file: posix.normalize(finding.file),
      category: finding.category && normalizeFindingText(finding.category),
      signature: finding.signature && normalizeFindingText(finding.signature),
      explanation: normalizeFindingText(finding.explanation),
    }));
}

function allPreviousBlockersPersist(
  previousFindings: FactoryReviewSidecar['findings'],
  currentFindings: FactoryReviewSidecar['findings'],
): boolean {
  const previousBlockers = getBlockingFindingIdentities(previousFindings);
  const currentBlockers = getBlockingFindingIdentities(currentFindings);

  return (
    previousBlockers.length > 0 &&
    previousBlockers.every(previous =>
      currentBlockers.some(
        current =>
          previous.file === current.file &&
          (!previous.category || !current.category || previous.category === current.category) &&
          (previous.signature && current.signature
            ? previous.signature === current.signature
            : previous.explanation === current.explanation),
      ),
    )
  );
}

export async function getFactoryReviewStagnationReason(
  { flow, artifacts, checkpoints }: FactoryFlowDetails,
  currentFindings: FactoryReviewSidecar['findings'],
): Promise<string | null> {
  const { iteration, worktreePath } = flow;
  if (iteration < 2) {
    return null;
  }

  const previousIteration = iteration - 1;
  const previousArtifact = getLatestReadyFactoryStageArtifact(
    { artifacts: artifacts.filter(artifact => artifact.iteration === previousIteration) },
    'review',
  );
  const previousReview = previousArtifact && readFactoryReviewResult(previousArtifact.path);
  const reason = `Loop pausado por estagnação na iteração ${iteration}.`;

  if (
    previousReview?.verdict === 'changes_requested' &&
    allPreviousBlockersPersist(previousReview.findings, currentFindings)
  ) {
    return `${reason} Os apontamentos bloqueantes da iteração ${previousIteration} continuam sem resolução. Revise o relatório antes de retomar.`;
  }

  const testsCheckpoints = checkpoints.filter(
    checkpoint => checkpoint.stage === 'tests' && checkpoint.sessionId !== null,
  );
  const previousCheckpoint = testsCheckpoints
    .filter(checkpoint => checkpoint.iteration === previousIteration)
    .at(-1);
  const currentCheckpoint = testsCheckpoints
    .filter(checkpoint => checkpoint.iteration === iteration)
    .at(-1);
  if (!worktreePath || !previousCheckpoint || !currentCheckpoint) {
    return null;
  }

  const emptyDiff = await hasEmptyFactoryWorktreeCheckpointDiff(
    { repoPath: flow.target.repoPath, worktreePath },
    previousCheckpoint.commitSha,
    currentCheckpoint.commitSha,
  ).catch((error: unknown) => {
    if (error instanceof FactoryWorktreeError) {
      return false;
    }
    throw error;
  });
  return emptyDiff
    ? `${reason} O diff entre os checkpoints das iterações ${previousIteration} e ${iteration} está vazio. Revise o worktree antes de retomar.`
    : null;
}

/** Argumentos restritos do runner da Etapa 05 (somente leitura no código + comandos git de inspeção). */
export function buildReviewRunnerArgs(reportPath: string): string[] {
  return buildRestrictedRunnerArgs({
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    allowed: [
      'Read',
      'Glob',
      'Grep',
      ...buildReportFileToolPermissions(reportPath),
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
  const testsSidecar = readFactoryStageSidecar('tests', paths.tests);
  const testResults =
    testsSidecar.stage === 'tests'
      ? {
          status: testsSidecar.status,
          executedCommands: testsSidecar.executedCommands,
          coverage: testsSidecar.coverage,
          ...(testsSidecar.backendChecks ? { backendChecks: testsSidecar.backendChecks } : {}),
        }
      : undefined;
  const iteration = details.flow.iteration > 0 ? details.flow.iteration : 1;
  const previousReviewReportPath =
    iteration >= 2 ? await readOptionalLatestStageDocument(details, 'review') : undefined;
  return {
    understandingReportPath: paths.triage,
    implementationPlanPath: paths.planning,
    implementationReportPath: paths.development,
    testReportPath: paths.tests,
    ...(testResults ? { testResults } : {}),
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
