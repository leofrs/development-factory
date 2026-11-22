import { z } from 'zod';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FactoryReviewSidecarSchema,
  FactoryReviewVerdictSchema,
  FactoryTestsSidecarSchema,
  type FactoryDevelopmentSidecar,
  type FactoryPlanningApproval,
  type FactoryPlanningSidecar,
  type FactoryReviewSidecar,
  type FactoryReviewVerdict,
  type FactoryTestsSidecar,
  type FactoryTriageSidecar,
} from './factory.js';
import type { FactoryDiffFile } from './factory-flow-inspection.js';

const version = z.literal(FACTORY_FLOW_CONTRACT_VERSION);
const nonEmptyText = z.string().min(1);
const nonNegativeInt = z.number().int().nonnegative();
const filePathSchema = z.string().trim().min(1).max(4096);

export const FactoryTraceabilityGapCodeSchema = z.enum([
  'missing_plan_link',
  'missing_changed_file',
  'planned_file_not_changed',
  'missing_test_case',
  'failing_test_case',
  'skipped_test_case',
  'blocking_review_finding',
]);
export type FactoryTraceabilityGapCode = z.infer<typeof FactoryTraceabilityGapCodeSchema>;

export const FactoryTraceabilityGapSchema = z.strictObject({
  code: FactoryTraceabilityGapCodeSchema,
  severity: z.enum(['error', 'warning']),
  message: nonEmptyText,
});
export type FactoryTraceabilityGap = z.infer<typeof FactoryTraceabilityGapSchema>;

export const FactoryTraceabilityFileSchema = z.strictObject({
  path: filePathSchema,
  planned: z.boolean(),
  changedInDevelopment: z.boolean(),
  changedInWorktree: z.boolean(),
  worktreeChange: z.enum(['added', 'modified', 'deleted']).nullable(),
  additions: nonNegativeInt.nullable(),
  deletions: nonNegativeInt.nullable(),
  binary: z.boolean(),
});
export type FactoryTraceabilityFile = z.infer<typeof FactoryTraceabilityFileSchema>;

const traceabilityTestCaseSchema = z.strictObject({
  id: nonEmptyText,
  description: nonEmptyText,
  status: FactoryTestsSidecarSchema.shape.testCases.element.shape.status,
});

const traceabilityUnlinkedTestCaseSchema = traceabilityTestCaseSchema.extend({
  acceptanceCriteriaIds: z.array(nonEmptyText),
});

const traceabilityReviewFindingSchema = FactoryReviewSidecarSchema.shape.findings.element;

export const FactoryTraceabilityRowSchema = z.strictObject({
  criterion: z.strictObject({
    id: nonEmptyText,
    description: nonEmptyText,
    approved: z.boolean().nullable(),
  }),
  plan: z.strictObject({
    testPlanItems: z.array(nonEmptyText),
    plannedFiles: z.array(filePathSchema),
  }),
  files: z.array(FactoryTraceabilityFileSchema),
  tests: z.strictObject({
    overallStatus: FactoryTestsSidecarSchema.shape.status.nullable(),
    cases: z.array(traceabilityTestCaseSchema),
  }),
  review: z.strictObject({
    status: z.enum(['pending', 'clean', 'warnings', 'blocked']),
    findings: z.array(traceabilityReviewFindingSchema),
  }),
  gaps: z.array(FactoryTraceabilityGapSchema),
});
export type FactoryTraceabilityRow = z.infer<typeof FactoryTraceabilityRowSchema>;

export const FactoryFlowTraceabilityMatrixSchema = z.strictObject({
  contractVersion: version,
  stagesAvailable: z.strictObject({
    triage: z.boolean(),
    planning: z.boolean(),
    development: z.boolean(),
    tests: z.boolean(),
    review: z.boolean(),
  }),
  worktreeAvailable: z.boolean(),
  worktreeFilesTruncated: z.boolean(),
  testsStatus: FactoryTestsSidecarSchema.shape.status.nullable(),
  reviewVerdict: FactoryReviewVerdictSchema.nullable(),
  summary: z.strictObject({
    totalCriteria: nonNegativeInt,
    coveredCriteria: nonNegativeInt,
    criteriaWithGaps: nonNegativeInt,
    criteriaWithoutFiles: nonNegativeInt,
    criteriaWithoutTests: nonNegativeInt,
    totalChangedFiles: nonNegativeInt,
    totalTestCases: nonNegativeInt,
    totalFindings: nonNegativeInt,
    blockingFindings: nonNegativeInt,
  }),
  rows: z.array(FactoryTraceabilityRowSchema),
  excludedCriteria: z.array(
    z.strictObject({
      id: nonEmptyText,
      description: nonEmptyText,
    }),
  ),
  unlinked: z.strictObject({
    testPlanItems: z.array(nonEmptyText),
    plannedFiles: z.array(filePathSchema),
    changedFiles: z.array(FactoryTraceabilityFileSchema),
    testCases: z.array(traceabilityUnlinkedTestCaseSchema),
    findings: z.array(traceabilityReviewFindingSchema),
  }),
});
export type FactoryFlowTraceabilityMatrix = z.infer<typeof FactoryFlowTraceabilityMatrixSchema>;

export interface FactoryTraceabilityMatrixInput {
  readonly triage: FactoryTriageSidecar | null;
  readonly planning: FactoryPlanningSidecar | null;
  readonly planningApproval?: FactoryPlanningApproval | null;
  readonly development: FactoryDevelopmentSidecar | null;
  readonly tests: FactoryTestsSidecar | null;
  readonly review: FactoryReviewSidecar | null;
  readonly worktreeFiles: readonly FactoryDiffFile[];
  readonly worktreeAvailable: boolean;
  readonly worktreeFilesTruncated?: boolean;
}

const GENERIC_PATH_SEGMENTS = new Set([
  'src',
  'app',
  'apps',
  'packages',
  'package',
  'lib',
  'dist',
  'build',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'fixtures',
  '__fixtures__',
  '__mocks__',
  'components',
  'hooks',
  'utils',
  'api',
  'server',
  'web',
  'shared',
]);

const GENERIC_STEM_TOKENS = new Set([
  ...GENERIC_PATH_SEGMENTS,
  'index',
  'main',
  'type',
  'types',
  'util',
  'helper',
  'helpers',
  'common',
  'base',
  'core',
  'client',
  'service',
  'services',
  'model',
  'models',
  'route',
  'routes',
  'controller',
  'controllers',
  'style',
  'styles',
  'config',
  'mock',
  'fixture',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'css',
  'html',
  'json',
  'md',
]);

const TEXT_STOPWORDS = new Set([
  'para',
  'como',
  'com',
  'sem',
  'por',
  'que',
  'quando',
  'onde',
  'qual',
  'quais',
  'dos',
  'das',
  'nos',
  'nas',
  'pelo',
  'pela',
  'pelos',
  'pelas',
  'uma',
  'uns',
  'umas',
  'deve',
  'devem',
  'ser',
  'ter',
  'estar',
  'validar',
  'validacao',
  'testar',
  'teste',
  'testes',
  'verificar',
  'garantir',
  'implementar',
  'permitir',
  'exibir',
  'criar',
  'alterar',
  'atualizar',
  'remover',
  'usar',
  'caso',
  'casos',
  'fluxo',
  'etapa',
  'sistema',
  'arquivo',
  'arquivos',
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'when',
  'should',
  'must',
]);

function normalizeRelativePath(value: string): string {
  const trimmed = value.trim().replaceAll('\\', '/');
  return trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
}

function normalizeAscii(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsTokenBoundary(haystack: string, needle: string): boolean {
  if (needle.length === 0) {
    return false;
  }
  const pattern = new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(needle)}(?:$|[^a-z0-9_])`, 'i');
  return pattern.test(haystack);
}

function containsPathMention(haystack: string, path: string): boolean {
  const normalizedHaystack = haystack.replaceAll('\\', '/');
  const pattern = new RegExp(
    `(?:^|[^a-z0-9_./-])${escapeRegExp(path)}(?:$|[^a-z0-9_./-])`,
    'i',
  );
  return pattern.test(normalizedHaystack);
}

function splitIdentifierWords(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map(part => normalizeAscii(part))
    .filter(part => part.length > 0);
}

function extractTextTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const rawParts = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9\u00C0-\u024F]+/);
  for (const part of rawParts) {
    const normalized = normalizeAscii(part);
    if (normalized.length >= 2 && !TEXT_STOPWORDS.has(normalized)) {
      tokens.add(normalized);
    }
  }
  return tokens;
}

function getFileBasename(filePath: string): string {
  const segments = filePath.split('/');
  return segments[segments.length - 1] ?? filePath;
}

function stripFileExtensions(basename: string): string {
  return basename.replace(/\.(?:test|spec)?\.[a-z0-9]+$/i, '').replace(/\.[a-z0-9]+$/i, '');
}

function isTestFilePath(filePath: string): boolean {
  const basename = getFileBasename(filePath).toLowerCase();
  return (
    /\.(?:test|spec)\.[a-z0-9]+$/i.test(basename) ||
    /(?:^|\/)(?:test|tests|__tests__|spec|specs)\//i.test(filePath)
  );
}

function extractFileTokens(filePath: string): {
  basename: string;
  stem: string;
  stemTokens: string[];
  dirTokens: string[];
} {
  const segments = filePath.split('/').filter(Boolean);
  const basename = segments[segments.length - 1] ?? filePath;
  const stem = stripFileExtensions(basename);
  const stemTokens = splitIdentifierWords(stem).filter(
    token => token.length >= 3 && !GENERIC_STEM_TOKENS.has(token),
  );
  const dirTokens = segments
    .slice(0, -1)
    .flatMap(segment => splitIdentifierWords(segment))
    .filter(token => token.length >= 3 && !GENERIC_STEM_TOKENS.has(token));
  return {
    basename,
    stem,
    stemTokens: [...new Set(stemTokens)],
    dirTokens: [...new Set(dirTokens)],
  };
}

function tokenMatchesSet(fileToken: string, textTokens: ReadonlySet<string>): boolean {
  if (textTokens.has(fileToken)) {
    return true;
  }
  if (fileToken.length < 5) {
    return false;
  }
  for (const candidate of textTokens) {
    if (candidate.length >= 5 && (candidate.startsWith(fileToken) || fileToken.startsWith(candidate))) {
      return true;
    }
  }
  return false;
}

function isChangedFile(file: FactoryTraceabilityFile): boolean {
  return file.changedInWorktree || file.changedInDevelopment;
}

function buildFileInventory(input: FactoryTraceabilityMatrixInput): Map<string, FactoryTraceabilityFile> {
  const inventory = new Map<string, FactoryTraceabilityFile>();

  const ensureEntry = (rawPath: string): FactoryTraceabilityFile => {
    const path = normalizeRelativePath(rawPath);
    const existing = inventory.get(path);
    if (existing) {
      return existing;
    }
    const created: FactoryTraceabilityFile = {
      path,
      planned: false,
      changedInDevelopment: false,
      changedInWorktree: false,
      worktreeChange: null,
      additions: null,
      deletions: null,
      binary: false,
    };
    inventory.set(path, created);
    return created;
  };

  for (const plannedPath of input.planning?.plannedFiles ?? []) {
    ensureEntry(plannedPath).planned = true;
  }

  for (const devPath of input.development?.changedFiles ?? []) {
    ensureEntry(devPath).changedInDevelopment = true;
  }

  for (const wtFile of input.worktreeFiles) {
    const entry = ensureEntry(wtFile.path);
    entry.changedInWorktree = true;
    entry.worktreeChange = wtFile.change;
    entry.additions = wtFile.additions;
    entry.deletions = wtFile.deletions;
    entry.binary = wtFile.binary;
  }

  return inventory;
}

function resolveCriteria(input: FactoryTraceabilityMatrixInput): {
  criteria: Array<{ id: string; description: string; approved: boolean | null }>;
  excludedCriteria: Array<{ id: string; description: string }>;
} {
  if (input.planningApproval) {
    const criteria: Array<{ id: string; description: string; approved: boolean | null }> = [];
    const excludedCriteria: Array<{ id: string; description: string }> = [];
    for (const item of input.planningApproval.acceptanceCriteria) {
      if (item.approved) {
        criteria.push({ id: item.id, description: item.description, approved: true });
      } else {
        excludedCriteria.push({ id: item.id, description: item.description });
      }
    }
    return { criteria, excludedCriteria };
  }

  return {
    criteria: (input.triage?.acceptanceCriteria ?? []).map(item => ({
      id: item.id,
      description: item.description,
      approved: null,
    })),
    excludedCriteria: [],
  };
}

/**
 * Cruza os sidecars JSON dos Blocos 01–05 com os arquivos alterados do worktree
 * para produzir a Matriz de Rastreabilidade (`CA -> Plano -> Arquivo -> Teste -> Review`).
 */
export function buildFactoryTraceabilityMatrix(
  input: FactoryTraceabilityMatrixInput,
): FactoryFlowTraceabilityMatrix {
  const inventory = buildFileInventory(input);
  const { criteria, excludedCriteria } = resolveCriteria(input);
  const testCases = input.tests?.testCases ?? [];
  const testPlanItems = input.planning?.testPlan ?? [];
  const findings = input.review?.findings ?? [];

  const criteriaByNormalizedId = new Map<string, string>();
  for (const criterion of criteria) {
    criteriaByNormalizedId.set(criterion.id.trim().toLowerCase(), criterion.id);
  }

  // 1. CA -> Test Cases (vínculo explícito via acceptanceCriteriaIds)
  const testCasesByCriterion = new Map<string, typeof testCases>();
  for (const criterion of criteria) {
    testCasesByCriterion.set(criterion.id, []);
  }
  const unlinkedTestCases: Array<{
    id: string;
    description: string;
    status: FactoryTestsSidecar['testCases'][number]['status'];
    acceptanceCriteriaIds: string[];
  }> = [];

  for (const testCase of testCases) {
    const matchedIds = new Set<string>();
    for (const ref of testCase.acceptanceCriteriaIds) {
      const canonicalId = criteriaByNormalizedId.get(ref.trim().toLowerCase());
      if (canonicalId) {
        matchedIds.add(canonicalId);
      }
    }
    if (matchedIds.size === 0) {
      unlinkedTestCases.push({
        id: testCase.id,
        description: testCase.description,
        status: testCase.status,
        acceptanceCriteriaIds: [...testCase.acceptanceCriteriaIds],
      });
    } else {
      for (const criterionId of matchedIds) {
        testCasesByCriterion.get(criterionId)?.push(testCase);
      }
    }
  }

  // 2. CA -> Test Plan Items (menção explícita ao CA, ID do teste vinculado ou sobreposição forte)
  const testPlanByCriterion = new Map<string, string[]>();
  for (const criterion of criteria) {
    testPlanByCriterion.set(criterion.id, []);
  }
  const unlinkedTestPlanItems: string[] = [];

  for (const item of testPlanItems) {
    const explicitMatches = criteria.filter(criterion => containsTokenBoundary(item, criterion.id));
    if (explicitMatches.length > 0) {
      for (const match of explicitMatches) {
        testPlanByCriterion.get(match.id)?.push(item);
      }
      continue;
    }

    const itemTokens = extractTextTokens(item);
    const scored: Array<{ id: string; score: number }> = [];
    for (const criterion of criteria) {
      const linkedTests = testCasesByCriterion.get(criterion.id) ?? [];
      if (linkedTests.some(testCase => containsTokenBoundary(item, testCase.id))) {
        scored.push({ id: criterion.id, score: 100 });
        continue;
      }
      const criterionTokens = extractTextTokens(
        `${criterion.description} ${linkedTests.map(testCase => testCase.description).join(' ')}`,
      );
      let overlap = 0;
      for (const token of itemTokens) {
        if (token.length >= 4 && criterionTokens.has(token)) {
          overlap += 1;
        }
      }
      if (overlap >= 2) {
        scored.push({ id: criterion.id, score: overlap });
      }
    }

    if (scored.length === 0) {
      unlinkedTestPlanItems.push(item);
      continue;
    }
    const maxScore = Math.max(...scored.map(entry => entry.score));
    for (const entry of scored) {
      if (entry.score === maxScore) {
        testPlanByCriterion.get(entry.id)?.push(item);
      }
    }
  }

  // 3. Evidência textual consolidada por CA (descrição + plano + testes + findings que citam o CA)
  const textsByCriterion = new Map<string, string[]>();
  const tokensByCriterion = new Map<string, Set<string>>();
  for (const criterion of criteria) {
    const texts: string[] = [criterion.description];
    for (const planItem of testPlanByCriterion.get(criterion.id) ?? []) {
      texts.push(planItem);
    }
    for (const testCase of testCasesByCriterion.get(criterion.id) ?? []) {
      texts.push(testCase.description);
    }
    for (const finding of findings) {
      if (containsTokenBoundary(finding.explanation, criterion.id)) {
        texts.push(finding.explanation);
      }
    }
    textsByCriterion.set(criterion.id, texts);
    tokensByCriterion.set(criterion.id, extractTextTokens(texts.join(' ')));
  }

  // 4. CA -> Files (menção explícita ao caminho/arquivo primeiro; fallback por score de tokens)
  const filesByCriterion = new Map<string, Set<string>>();
  for (const criterion of criteria) {
    filesByCriterion.set(criterion.id, new Set());
  }
  const linkedFilePaths = new Set<string>();

  for (const [filePath] of inventory) {
    const info = extractFileTokens(filePath);
    const stemDistinctive =
      info.stem.length >= 4 && !GENERIC_STEM_TOKENS.has(normalizeAscii(info.stem));

    const explicitCriteria: string[] = [];
    for (const criterion of criteria) {
      const texts = textsByCriterion.get(criterion.id) ?? [];
      const joined = texts.join('\n');
      const findingMentionsCriterionAndFile = findings.some(
        finding =>
          normalizeRelativePath(finding.file) === filePath &&
          containsTokenBoundary(finding.explanation, criterion.id),
      );
      const matchesPath =
        findingMentionsCriterionAndFile ||
        containsPathMention(joined, filePath) ||
        containsPathMention(joined, info.basename) ||
        (stemDistinctive && containsTokenBoundary(joined, info.stem));

      if (matchesPath) {
        explicitCriteria.push(criterion.id);
      }
    }

    if (explicitCriteria.length > 0) {
      for (const criterionId of explicitCriteria) {
        filesByCriterion.get(criterionId)?.add(filePath);
      }
      linkedFilePaths.add(filePath);
      continue;
    }

    if (info.stemTokens.length === 0 && info.dirTokens.length === 0) {
      continue;
    }

    const scoredCriteria: Array<{ id: string; score: number; stemMatches: number }> = [];
    for (const criterion of criteria) {
      const criterionTokens = tokensByCriterion.get(criterion.id) ?? new Set<string>();
      let stemMatches = 0;
      let dirMatches = 0;
      for (const token of info.stemTokens) {
        if (tokenMatchesSet(token, criterionTokens)) {
          stemMatches += 1;
        }
      }
      for (const token of info.dirTokens) {
        if (tokenMatchesSet(token, criterionTokens)) {
          dirMatches += 1;
        }
      }
      if (stemMatches >= 1 || dirMatches >= 2) {
        scoredCriteria.push({
          id: criterion.id,
          score: stemMatches * 2 + dirMatches,
          stemMatches,
        });
      }
    }

    if (scoredCriteria.length > 0) {
      const maxScore = Math.max(...scoredCriteria.map(item => item.score));
      for (const item of scoredCriteria) {
        if (item.score === maxScore) {
          filesByCriterion.get(item.id)?.add(filePath);
        }
      }
      linkedFilePaths.add(filePath);
    }
  }

  // Vincula arquivos de teste cujo stem corresponde exatamente a um arquivo de produção já vinculado ao CA
  for (const [filePath] of inventory) {
    if (linkedFilePaths.has(filePath) || !isTestFilePath(filePath)) {
      continue;
    }
    const testStem = normalizeAscii(stripFileExtensions(getFileBasename(filePath)));
    if (testStem.length < 4 || GENERIC_STEM_TOKENS.has(testStem)) {
      continue;
    }
    let linked = false;
    for (const criterion of criteria) {
      const criterionFiles = filesByCriterion.get(criterion.id);
      if (!criterionFiles) {
        continue;
      }
      const hasMatchingProdFile = [...criterionFiles].some(existingPath => {
        if (isTestFilePath(existingPath)) {
          return false;
        }
        const prodStem = normalizeAscii(stripFileExtensions(getFileBasename(existingPath)));
        return prodStem === testStem;
      });
      if (hasMatchingProdFile) {
        criterionFiles.add(filePath);
        linked = true;
      }
    }
    if (linked) {
      linkedFilePaths.add(filePath);
    }
  }

  // 5. CA -> Review Findings + montagem das linhas e lacunas
  const linkedFindingIndices = new Set<number>();
  const rows: FactoryTraceabilityRow[] = [];

  for (const criterion of criteria) {
    const linkedPaths = [...(filesByCriterion.get(criterion.id) ?? [])].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const rowFiles: FactoryTraceabilityFile[] = [];
    for (const path of linkedPaths) {
      const file = inventory.get(path);
      if (file) {
        rowFiles.push(file);
      }
    }
    const rowFileSet = new Set(linkedPaths);

    const rowTestPlanItems = testPlanByCriterion.get(criterion.id) ?? [];
    const rowPlannedFiles = rowFiles.filter(file => file.planned).map(file => file.path);

    const rawTests = testCasesByCriterion.get(criterion.id) ?? [];
    const rowTests = rawTests.map(testCase => ({
      id: testCase.id,
      description: testCase.description,
      status: testCase.status,
    }));
    const rowTestIds = new Set(rowTests.map(testCase => testCase.id));

    const rowFindings: FactoryReviewSidecar['findings'][number][] = [];
    findings.forEach((finding, index) => {
      const normalizedFindingFile = normalizeRelativePath(finding.file);
      const matchesFile = rowFileSet.has(normalizedFindingFile);
      const matchesCriterionId = containsTokenBoundary(finding.explanation, criterion.id);
      const matchesTestId = [...rowTestIds].some(testId =>
        containsTokenBoundary(finding.explanation, testId),
      );
      if (matchesFile || matchesCriterionId || matchesTestId) {
        rowFindings.push(finding);
        linkedFindingIndices.add(index);
      }
    });

    const hasBlockingFinding = rowFindings.some(finding => finding.severity === 'BLOQUEANTE');
    const hasNonBlockingFinding = rowFindings.some(finding => finding.severity !== 'BLOQUEANTE');
    const reviewStatus: FactoryTraceabilityRow['review']['status'] =
      input.review === null
        ? 'pending'
        : hasBlockingFinding
          ? 'blocked'
          : hasNonBlockingFinding
            ? 'warnings'
            : 'clean';

    const gaps: FactoryTraceabilityGap[] = [];
    if (input.planning !== null && rowTestPlanItems.length === 0 && rowPlannedFiles.length === 0) {
      gaps.push({
        code: 'missing_plan_link',
        severity: 'warning',
        message: 'Nenhum item do plano de testes ou arquivo planejado vinculado a este critério.',
      });
    }

    const changedLinkedFiles = rowFiles.filter(isChangedFile);
    const plannedOnlyFiles = rowFiles.filter(file => file.planned && !isChangedFile(file));
    if (changedLinkedFiles.length === 0) {
      gaps.push({
        code: 'missing_changed_file',
        severity: 'error',
        message:
          plannedOnlyFiles.length > 0
            ? 'Arquivos planejados ainda não possuem alteração registrada no desenvolvimento ou worktree.'
            : 'Nenhum arquivo alterado vinculado a este critério.',
      });
    } else if (plannedOnlyFiles.length > 0) {
      gaps.push({
        code: 'planned_file_not_changed',
        severity: 'warning',
        message: `Arquivo(s) planejado(s) sem alteração registrada: ${plannedOnlyFiles.map(file => file.path).join(', ')}.`,
      });
    }

    if (rowTests.length === 0) {
      gaps.push({
        code: 'missing_test_case',
        severity: 'error',
        message: 'Nenhum caso de teste vinculado a este critério.',
      });
    } else {
      const failedTests = rowTests.filter(testCase => testCase.status === 'failed');
      const skippedTests = rowTests.filter(testCase => testCase.status === 'skipped');
      if (failedTests.length > 0) {
        gaps.push({
          code: 'failing_test_case',
          severity: 'error',
          message: `${failedTests.length} caso(s) de teste vinculado(s) falharam (${failedTests.map(item => item.id).join(', ')}).`,
        });
      }
      if (skippedTests.length > 0) {
        gaps.push({
          code: 'skipped_test_case',
          severity: 'warning',
          message: `${skippedTests.length} caso(s) de teste vinculado(s) foram ignorados (${skippedTests.map(item => item.id).join(', ')}).`,
        });
      }
    }

    const blockingCount = rowFindings.filter(finding => finding.severity === 'BLOQUEANTE').length;
    if (blockingCount > 0) {
      gaps.push({
        code: 'blocking_review_finding',
        severity: 'error',
        message: `${blockingCount} apontamento(s) bloqueante(s) no Code Review.`,
      });
    }

    rows.push({
      criterion,
      plan: {
        testPlanItems: rowTestPlanItems,
        plannedFiles: rowPlannedFiles,
      },
      files: rowFiles,
      tests: {
        overallStatus: input.tests?.status ?? null,
        cases: rowTests,
      },
      review: {
        status: reviewStatus,
        findings: rowFindings,
      },
      gaps,
    });
  }

  const unlinkedPlannedFiles: string[] = [];
  const unlinkedChangedFiles: FactoryTraceabilityFile[] = [];
  for (const file of inventory.values()) {
    if (linkedFilePaths.has(file.path)) {
      continue;
    }
    if (isChangedFile(file)) {
      unlinkedChangedFiles.push(file);
    } else if (file.planned) {
      unlinkedPlannedFiles.push(file.path);
    }
  }
  unlinkedPlannedFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  unlinkedChangedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const unlinkedFindings = findings.filter((_, index) => !linkedFindingIndices.has(index));
  const totalChangedFiles = [...inventory.values()].filter(isChangedFile).length;
  const coveredCriteria = rows.filter(row => row.gaps.length === 0).length;
  const criteriaWithGaps = rows.length - coveredCriteria;
  const criteriaWithoutFiles = rows.filter(
    row => row.files.filter(isChangedFile).length === 0,
  ).length;
  const criteriaWithoutTests = rows.filter(row => row.tests.cases.length === 0).length;
  const reviewVerdict: FactoryReviewVerdict | null = input.review?.verdict ?? null;

  return FactoryFlowTraceabilityMatrixSchema.parse({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    stagesAvailable: {
      triage: input.triage !== null,
      planning: input.planning !== null,
      development: input.development !== null,
      tests: input.tests !== null,
      review: input.review !== null,
    },
    worktreeAvailable: input.worktreeAvailable,
    worktreeFilesTruncated: input.worktreeFilesTruncated ?? false,
    testsStatus: input.tests?.status ?? null,
    reviewVerdict,
    summary: {
      totalCriteria: rows.length,
      coveredCriteria,
      criteriaWithGaps,
      criteriaWithoutFiles,
      criteriaWithoutTests,
      totalChangedFiles,
      totalTestCases: testCases.length,
      totalFindings: findings.length,
      blockingFindings: findings.filter(finding => finding.severity === 'BLOQUEANTE').length,
    },
    rows,
    excludedCriteria,
    unlinked: {
      testPlanItems: unlinkedTestPlanItems,
      plannedFiles: unlinkedPlannedFiles,
      changedFiles: unlinkedChangedFiles,
      testCases: unlinkedTestCases,
      findings: unlinkedFindings,
    },
  });
}
