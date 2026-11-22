import { z } from 'zod';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FactoryFlowCheckpointSchema,
  FactoryReviewSidecarSchema,
  FactoryTestsSidecarSchema,
} from './factory.js';
import type { FactoryFlowDetails } from './factory.js';

const version = z.literal(FACTORY_FLOW_CONTRACT_VERSION);
const iterationNumber = z.number().int().positive();
export const FactoryDiffPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    path =>
      !path.includes('\0') &&
      path.split('/').every(
        segment => segment !== '' && segment !== '.' && segment !== '..' && segment !== '.git',
      ),
    'Use um caminho de arquivo relativo ao worktree.',
  );

export const FACTORY_DIFF_PAGE_SIZE = 20;
export const FACTORY_DIFF_MAX_PATCH_BYTES = 64 * 1024;
export const FACTORY_DIFF_MAX_PATCH_LINES = 800;
export const FACTORY_ITERATION_EVIDENCE_LIMIT = 50;
export const FACTORY_ITERATION_EVIDENCE_TEXT_LIMIT = 1000;

const queryNumber = z.string().regex(/^\d{1,9}$/).transform(Number);
const checkpointId = z.string().uuid();

export const FactoryFlowDiffQuerySchema = z
  .strictObject({
    fromCheckpointId: checkpointId.optional(),
    toCheckpointId: checkpointId.optional(),
    offset: queryNumber.pipe(z.number().int().nonnegative()).default(0),
    limit: queryNumber.pipe(z.number().int().min(1).max(FACTORY_DIFF_PAGE_SIZE)).default(
      FACTORY_DIFF_PAGE_SIZE,
    ),
    file: FactoryDiffPathSchema.optional(),
    untracked: z.enum(['true', 'false']).transform(value => value === 'true').default(false),
  })
  .refine(
    query => (query.fromCheckpointId === undefined) === (query.toCheckpointId === undefined),
    'Informe os dois checkpoints para comparar.',
  )
  .refine(
    query => !query.untracked || (query.file !== undefined && query.fromCheckpointId === undefined),
    { message: 'O arquivo não rastreado precisa pertencer à comparação com o worktree atual.' },
  );
export type FactoryFlowDiffQuery = z.infer<typeof FactoryFlowDiffQuerySchema>;

const fileChangeSchema = z.enum(['added', 'modified', 'deleted']);
const lineCountSchema = z.number().int().nonnegative();
const factoryDiffFileSchema = z.strictObject({
  path: FactoryDiffPathSchema,
  change: fileChangeSchema,
  untracked: z.boolean(),
  additions: lineCountSchema.nullable(),
  deletions: lineCountSchema.nullable(),
  binary: z.boolean(),
});
export type FactoryDiffFile = z.infer<typeof factoryDiffFileSchema>;

export const FactoryFlowDiffPageSchema = z.strictObject({
  contractVersion: version,
  kind: z.literal('page'),
  files: z.array(factoryDiffFileSchema).max(FACTORY_DIFF_PAGE_SIZE),
  totalFiles: lineCountSchema,
  nextOffset: lineCountSchema.nullable(),
  truncated: z.boolean(),
});
export type FactoryFlowDiffPage = z.infer<typeof FactoryFlowDiffPageSchema>;

export const FactoryFlowDiffPatchSchema = z.strictObject({
  contractVersion: version,
  kind: z.literal('patch'),
  patch: z.string().max(FACTORY_DIFF_MAX_PATCH_BYTES),
  truncated: z.boolean(),
});
export type FactoryFlowDiffPatch = z.infer<typeof FactoryFlowDiffPatchSchema>;

export const FactoryFlowIterationsQuerySchema = z.strictObject({
  fromIteration: queryNumber.pipe(iterationNumber),
});

const iterationEvidenceText = z.string().min(1).max(FACTORY_ITERATION_EVIDENCE_TEXT_LIMIT);
const iterationTestCaseSchema = FactoryTestsSidecarSchema.shape.testCases.element
  .pick({ id: true, description: true, status: true })
  .extend({ id: iterationEvidenceText, description: iterationEvidenceText });
const iterationFindingSchema = FactoryReviewSidecarSchema.shape.findings.element
  .pick({ severity: true, file: true, line: true, explanation: true })
  .extend({ file: iterationEvidenceText, explanation: iterationEvidenceText });

const iterationEvidenceSchema = z.strictObject({
  iteration: iterationNumber,
  checkpoint: FactoryFlowCheckpointSchema.pick({ id: true, commitSha: true, stage: true }).nullable(),
  tests: z
    .strictObject({
      status: FactoryTestsSidecarSchema.shape.status,
      coverage: FactoryTestsSidecarSchema.shape.coverage,
      passed: lineCountSchema,
      failed: lineCountSchema,
      skipped: lineCountSchema,
      cases: z.array(iterationTestCaseSchema).max(FACTORY_ITERATION_EVIDENCE_LIMIT),
      commandCount: lineCountSchema,
      commands: z
        .array(z.strictObject({ command: iterationEvidenceText, exitCode: lineCountSchema.nullable() }))
        .max(FACTORY_ITERATION_EVIDENCE_LIMIT),
    })
    .nullable(),
  review: z
    .strictObject({
      verdict: FactoryReviewSidecarSchema.shape.verdict,
      findingCount: lineCountSchema,
      findings: z.array(iterationFindingSchema).max(FACTORY_ITERATION_EVIDENCE_LIMIT),
    })
    .nullable(),
});
export type FactoryIterationEvidence = z.infer<typeof iterationEvidenceSchema>;

export const FactoryFlowIterationComparisonSchema = z
  .strictObject({
    contractVersion: version,
    before: iterationEvidenceSchema,
    after: iterationEvidenceSchema,
  })
  .refine(data => data.after.iteration === data.before.iteration + 1);
export type FactoryFlowIterationComparison = z.infer<typeof FactoryFlowIterationComparisonSchema>;

/** Retorna o primeiro ciclo de cada par consecutivo com dados registrados no fluxo. */
export function getFactoryComparableIterations(
  details: Pick<FactoryFlowDetails, 'flow' | 'checkpoints' | 'artifacts'>,
): number[] {
  const iterations = new Set([details.flow.iteration]);
  for (const checkpoint of details.checkpoints) {
    iterations.add(checkpoint.iteration);
  }
  for (const artifact of details.artifacts) {
    if (
      (artifact.kind === 'test_report' || artifact.kind === 'review_report') &&
      artifact.format === 'markdown' &&
      artifact.status === 'ready'
    ) {
      iterations.add(artifact.iteration);
    }
  }
  return [...iterations].filter(value => value > 0 && iterations.has(value + 1)).sort((a, b) => a - b);
}
