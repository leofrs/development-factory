import { dirname, posix } from 'node:path';
import {
  FactoryReviewVerdictSchema,
  ReturnFactoryTargetStageSchema,
  buildFactoryReviewGate,
  buildFactoryReviewTriageScope,
  getLatestReadyFactoryStageArtifact,
  getReadyFactoryStageArtifact,
  resolveFactoryReviewDecision,
} from '@development-factory/shared';
import type {
  FactoryFlowDetails,
  FactoryReviewDecision,
  FactoryReviewSidecar,
  FactoryReviewTriageScope,
  FactoryReviewVerdict,
  ReturnFactoryTargetStage,
} from '@development-factory/shared';
import {
  GIT_WRITE_DENIED_BASH_TOOLS,
  buildReportFileToolPermissions,
  buildRestrictedRunnerArgs,
  describeMissingStructuredReportParts,
  normalizeStructuredMarkdownReport,
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
  /^(?:>\s*)*(?:(?:[-*]|\d+[.)])\s*)?(?:\*\*|__)?(?:veredito|parecer(?:\s+final)?|decis[aã]o)(?:\*\*|__)?\s*:\s*(.+)$/iu;
const RETURN_TARGET_PREFIX_PATTERN =
  /^(?:>\s*)*(?:(?:[-*]|\d+[.)])\s*)?(?:\*\*|__)?(?:alvo(?:\s+de\s+retorno)?|retorno|returnTarget)(?:\*\*|__)?\s*:\s*(.+)$/iu;

const REVIEW_SECTION_ALIASES: Readonly<Record<string, string>> = {
  'resumo executivo': REVIEW_REPORT_SECTIONS.executiveSummary,
  resumo: REVIEW_REPORT_SECTIONS.executiveSummary,
  'resumo da revisao': REVIEW_REPORT_SECTIONS.executiveSummary,
  'resumo do code review': REVIEW_REPORT_SECTIONS.executiveSummary,
  'pontos encontrados': REVIEW_REPORT_SECTIONS.findings,
  apontamentos: REVIEW_REPORT_SECTIONS.findings,
  'apontamentos encontrados': REVIEW_REPORT_SECTIONS.findings,
  'apontamentos / instrucoes conclusivas de correcao': REVIEW_REPORT_SECTIONS.findings,
  'apontamentos e instrucoes conclusivas de correcao': REVIEW_REPORT_SECTIONS.findings,
  'instrucoes conclusivas de correcao': REVIEW_REPORT_SECTIONS.findings,
  'como testar manualmente': REVIEW_REPORT_SECTIONS.manualVerification,
  'teste manual': REVIEW_REPORT_SECTIONS.manualVerification,
  'testes manuais': REVIEW_REPORT_SECTIONS.manualVerification,
  'como testar': REVIEW_REPORT_SECTIONS.manualVerification,
  'validacao manual': REVIEW_REPORT_SECTIONS.manualVerification,
  'roteiro de validacao manual': REVIEW_REPORT_SECTIONS.manualVerification,
  'roteiro de teste manual': REVIEW_REPORT_SECTIONS.manualVerification,
  'roteiro de testes manuais': REVIEW_REPORT_SECTIONS.manualVerification,
  'guia de teste manual': REVIEW_REPORT_SECTIONS.manualVerification,
  'guia de testes manuais': REVIEW_REPORT_SECTIONS.manualVerification,
  'passo a passo para teste manual': REVIEW_REPORT_SECTIONS.manualVerification,
  'verificacao manual': REVIEW_REPORT_SECTIONS.manualVerification,
  'parecer final': REVIEW_REPORT_SECTIONS.verdict,
  veredito: REVIEW_REPORT_SECTIONS.verdict,
  'veredito final': REVIEW_REPORT_SECTIONS.verdict,
  'veredito do code review': REVIEW_REPORT_SECTIONS.verdict,
  parecer: REVIEW_REPORT_SECTIONS.verdict,
  'decisao final': REVIEW_REPORT_SECTIONS.verdict,
};

const AMBIGUOUS_VERDICT_CHOICE_PATTERN =
  /(?:APROVADO PARA PR|APROVADO COM RESSALVAS)\s*(?:\bOU\b|\||\/)\s*(?:REPROVADO|REQUER AJUSTES)|(?:REPROVADO|REQUER AJUSTES)\s*(?:\bOU\b|\||\/)\s*(?:APROVADO PARA PR|APROVADO COM RESSALVAS)/;

/** Normaliza variações naturais de título e seções no relatório Markdown de Code Review. */
export function normalizeReviewMarkdown(content: string): string {
  return normalizeStructuredMarkdownReport(
    content,
    REVIEW_REPORT_TITLE,
    REVIEW_REPORT_SECTIONS,
    REVIEW_SECTION_ALIASES,
  );
}

function extractSectionBody(content: string, heading: string): string[] | null {
  const normalized = normalizeReviewMarkdown(content);
  let collecting = false;
  const collected: string[] = [];
  let activeFence: { readonly char: '`' | '~'; readonly length: number } | null = null;

  for (const line of normalized.split('\n')) {
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line.trimStart());
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1];
      const char = marker[0] === '~' ? '~' : '`';
      if (activeFence === null) {
        activeFence = { char, length: marker.length };
      } else if (activeFence.char === char && marker.length >= activeFence.length) {
        activeFence = null;
      }
    } else if (activeFence === null && line.startsWith('## ')) {
      if (collecting) {
        return collected;
      }
      if (line.slice(3).trim() === heading) {
        collecting = true;
        continue;
      }
    }

    if (collecting) {
      collected.push(line);
    }
  }

  return collecting ? collected : null;
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

function matchesVerdictLabel(normalized: string, label: string): boolean {
  return (
    normalized === label ||
    normalized.startsWith(`${label} `) ||
    normalized.startsWith(`${label}-`) ||
    normalized.startsWith(`${label}—`) ||
    normalized.startsWith(`${label}(`) ||
    normalized.startsWith(`${label}:`)
  );
}

function matchVerdictToken(normalized: string): FactoryReviewVerdict | null {
  if (AMBIGUOUS_VERDICT_CHOICE_PATTERN.test(normalized)) {
    return null;
  }

  if (matchesVerdictLabel(normalized, REVIEW_VERDICT_LABELS.approvedWithWarnings)) {
    return FactoryReviewVerdictSchema.parse('approved_with_warnings');
  }

  if (matchesVerdictLabel(normalized, REVIEW_VERDICT_LABELS.approved)) {
    return FactoryReviewVerdictSchema.parse('approved');
  }

  if (
    matchesVerdictLabel(normalized, REVIEW_VERDICT_LABELS.changesRequested) ||
    matchesVerdictLabel(normalized, 'REPROVADO') ||
    matchesVerdictLabel(normalized, 'REQUER AJUSTES')
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
    additionalDirectory: dirname(reportPath),
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
  const previousReviewTriageScope =
    iteration >= 2 ? readFactoryReviewTriageScope(details) : undefined;
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
    ...(previousReviewTriageScope ? { previousReviewTriageScope } : {}),
  };
}

/**
 * Lê e resolve o escopo estruturado da triagem humana do Bloco 05 para o artefato `review_report`
 * mais recente quando há decisões humanas persistidas para aquele artefato.
 */
export function readFactoryReviewTriageScope(
  details: Pick<FactoryFlowDetails, 'flow' | 'stages' | 'artifacts'>,
): FactoryReviewTriageScope | undefined {
  const reviewTriage = details.flow.reviewTriage;
  if (!reviewTriage) {
    return undefined;
  }
  const reviewArtifact =
    getReadyFactoryStageArtifact(details, 'review') ??
    getLatestReadyFactoryStageArtifact(details, 'review');
  if (!reviewArtifact || reviewArtifact.id !== reviewTriage.reviewArtifactId) {
    return undefined;
  }
  try {
    const sidecar = readFactoryStageSidecar('review', reviewArtifact.path);
    const decision = resolveFactoryReviewDecision(sidecar);
    const gate = buildFactoryReviewGate({
      reviewArtifactId: reviewArtifact.id,
      reviewReportPath: reviewArtifact.path,
      iteration: reviewArtifact.iteration,
      verdict: decision.verdict,
      returnTarget: decision.returnTarget,
      findings: sidecar.findings,
      reviewTriage,
    });
    return buildFactoryReviewTriageScope(gate);
  } catch {
    return undefined;
  }
}

/** Valida a estrutura mínima e o veredito determinístico do artefato `review_report` em Markdown. */
export function isReviewReport(content: string): boolean {
  const normalized = normalizeReviewMarkdown(content);
  return (
    validateStructuredMarkdownReport(normalized, REVIEW_REPORT_TITLE, REVIEW_REPORT_SECTIONS) &&
    parseReviewVerdict(normalized) !== null
  );
}

/** Lista o título, seções obrigatórias ou veredito ausentes/inválidos no relatório de Code Review. */
export function describeMissingReviewParts(content: string): string[] {
  const normalized = normalizeReviewMarkdown(content);
  const missing = describeMissingStructuredReportParts(
    normalized,
    REVIEW_REPORT_TITLE,
    REVIEW_REPORT_SECTIONS,
  );
  if (!missing.includes(REVIEW_REPORT_SECTIONS.verdict) && parseReviewVerdict(normalized) === null) {
    missing.push('veredito determinístico na seção Parecer Final');
  }
  return missing;
}
