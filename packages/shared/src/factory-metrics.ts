import { z } from 'zod';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_STAGE_ORDER,
  FactoryReviewVerdictSchema,
  FactoryStageNameSchema,
} from './factory.js';

const version = z.literal(FACTORY_FLOW_CONTRACT_VERSION);
const uuidSchema = z.string().uuid();
const timestamp = z.iso.datetime();
const nonEmptyText = z.string().trim().min(1);
const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();

const repoPathSchema = nonEmptyText
  .max(4096)
  .refine(value => value.startsWith('/') && !value.includes('\0'), 'Use um caminho absoluto no WSL');

export const FactoryMetricsPeriodSchema = z.enum(['7d', '30d', '90d', 'all']);
export type FactoryMetricsPeriod = z.infer<typeof FactoryMetricsPeriodSchema>;

export const FACTORY_METRICS_PERIOD_DAYS: Readonly<
  Record<Exclude<FactoryMetricsPeriod, 'all'>, number>
> = Object.freeze({
  '7d': 7,
  '30d': 30,
  '90d': 90,
});

export const FactoryMetricsQuerySchema = z
  .strictObject({
    repoPath: repoPathSchema.optional(),
    period: FactoryMetricsPeriodSchema.default('all'),
    from: timestamp.optional(),
    to: timestamp.optional(),
  })
  .refine(
    value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to),
    'A data inicial não pode ser posterior à data final.',
  );
export type FactoryMetricsQuery = z.infer<typeof FactoryMetricsQuerySchema>;

export const FactoryReviewOutcomeRecordSchema = z.strictObject({
  contractVersion: version,
  id: uuidSchema,
  flowId: uuidSchema,
  artifactId: uuidSchema.nullable(),
  iteration: positiveInt,
  verdict: FactoryReviewVerdictSchema,
  rejectionReasons: z.array(nonEmptyText.max(500)),
  createdAt: timestamp,
});
export type FactoryReviewOutcomeRecord = z.infer<typeof FactoryReviewOutcomeRecordSchema>;

export const FactoryStageLeadTimeMetricSchema = z.strictObject({
  stage: FactoryStageNameSchema,
  completedCount: nonNegativeInt,
  partialCount: nonNegativeInt,
  averageDurationMs: z.number().nonnegative().nullable(),
  minDurationMs: z.number().nonnegative().nullable(),
  maxDurationMs: z.number().nonnegative().nullable(),
});
export type FactoryStageLeadTimeMetric = z.infer<typeof FactoryStageLeadTimeMetricSchema>;

export const FactoryFirstCycleReviewMetricSchema = z.strictObject({
  evaluatedFlows: nonNegativeInt,
  approvedFirstCycle: nonNegativeInt,
  rejectedFirstCycle: nonNegativeInt,
  approvalRatePercent: z.number().min(0).max(100).nullable(),
});
export type FactoryFirstCycleReviewMetric = z.infer<typeof FactoryFirstCycleReviewMetricSchema>;

export const FactoryReviewRejectionReasonMetricSchema = z.strictObject({
  reason: nonEmptyText.max(500),
  count: positiveInt,
  flowCount: positiveInt,
});
export type FactoryReviewRejectionReasonMetric = z.infer<
  typeof FactoryReviewRejectionReasonMetricSchema
>;

export const FactoryRepositoryThroughputMetricSchema = z.strictObject({
  repoPath: repoPathSchema,
  totalFlows: nonNegativeInt,
  completedFlows: nonNegativeInt,
  cancelledFlows: nonNegativeInt,
  failedFlows: nonNegativeInt,
  activeFlows: nonNegativeInt,
  openedPrs: nonNegativeInt,
  firstCycleApprovalRatePercent: z.number().min(0).max(100).nullable(),
});
export type FactoryRepositoryThroughputMetric = z.infer<
  typeof FactoryRepositoryThroughputMetricSchema
>;

export const FactoryMetricsSummarySchema = z.strictObject({
  totalFlows: nonNegativeInt,
  completedFlows: nonNegativeInt,
  cancelledFlows: nonNegativeInt,
  failedFlows: nonNegativeInt,
  activeFlows: nonNegativeInt,
  openedPrs: nonNegativeInt,
  averageFlowLeadTimeMs: z.number().nonnegative().nullable(),
});
export type FactoryMetricsSummary = z.infer<typeof FactoryMetricsSummarySchema>;

export const FactoryMetricsResponseSchema = z.strictObject({
  contractVersion: version,
  generatedAt: timestamp,
  filters: z.strictObject({
    repoPath: repoPathSchema.nullable(),
    period: FactoryMetricsPeriodSchema,
    from: timestamp.nullable(),
    to: timestamp.nullable(),
  }),
  availableRepos: z.array(repoPathSchema),
  summary: FactoryMetricsSummarySchema,
  stageLeadTimes: z.array(FactoryStageLeadTimeMetricSchema).length(FACTORY_STAGE_ORDER.length),
  firstCycleReview: FactoryFirstCycleReviewMetricSchema,
  rejectionReasons: z.array(FactoryReviewRejectionReasonMetricSchema),
  byRepository: z.array(FactoryRepositoryThroughputMetricSchema),
});
export type FactoryMetricsResponse = z.infer<typeof FactoryMetricsResponseSchema>;
