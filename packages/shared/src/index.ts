import { z } from 'zod';
import { ReviewReportDirectoryPathSchema, ReviewStateSchema } from './review.js';

export * from './review.js';
export * from './factory.js';

export const TargetTypeSchema = z.enum(['pr', 'branch']);
export type TargetType = z.infer<typeof TargetTypeSchema>;
export const FactoryInputTypeSchema = z.enum(['jira_url', 'jira_key', 'title']);
export type FactoryInputType = z.infer<typeof FactoryInputTypeSchema>;
const columns = z.number().int().min(2).max(500);
const rows = z.number().int().min(1).max(300);

const repoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(value => value.startsWith('/') && !value.includes('\0'), 'Use um caminho absoluto no WSL');

const uuidSchema = z.string().uuid();
const isoDatetimeSchema = z.iso.datetime();
const nonEmptyTextSchema = z.string().trim().min(1);

export const BackgroundSessionModeSchema = z.enum(['review', 'factory']);
export type BackgroundSessionMode = z.infer<typeof BackgroundSessionModeSchema>;

export const BackgroundSessionStatusSchema = z.enum(['running', 'exited', 'failed', 'cancelled']);
export type BackgroundSessionStatus = z.infer<typeof BackgroundSessionStatusSchema>;

export const BackgroundSessionHistoryStateSchema = z.enum(['pending', 'saved', 'incomplete']);
export type BackgroundSessionHistoryState = z.infer<typeof BackgroundSessionHistoryStateSchema>;

export const BackgroundSessionSummarySchema = z.strictObject({
  sessionId: uuidSchema,
  mode: BackgroundSessionModeSchema,
  title: nonEmptyTextSchema,
  repoPath: repoPathSchema,
  status: BackgroundSessionStatusSchema,
  historyState: BackgroundSessionHistoryStateSchema,
  reportPath: nonEmptyTextSchema.nullable().optional(),
  sessionPath: nonEmptyTextSchema.nullable().optional(),
  reviewId: uuidSchema.nullable().optional(),
  executionId: uuidSchema.nullable().optional(),
  startedAt: isoDatetimeSchema,
  finishedAt: isoDatetimeSchema.nullable(),
  exitCode: z.number().int().nullable().optional(),
  error: nonEmptyTextSchema.nullable().optional(),
});
export type BackgroundSessionSummary = z.infer<typeof BackgroundSessionSummarySchema>;

export const AppEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session.started'),
    session: BackgroundSessionSummarySchema,
  }),
  z.strictObject({
    type: z.literal('session.updated'),
    session: BackgroundSessionSummarySchema,
  }),
  z.strictObject({
    type: z.literal('session.history_saved'),
    session: BackgroundSessionSummarySchema,
  }),
  z.strictObject({
    type: z.literal('session.finished'),
    session: BackgroundSessionSummarySchema,
  }),
]);
export type AppEvent = z.infer<typeof AppEventSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start_review'),
    targetType: TargetTypeSchema,
    identifier: z.string().trim().min(1).max(500).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Identificador inválido'),
    repoPath: repoPathSchema,
    reportDirectory: ReviewReportDirectoryPathSchema.optional(),
    cols: columns,
    rows,
  }).refine(value => value.targetType !== 'pr' || /^[1-9]\d*$/.test(value.identifier), 'Informe um número de PR positivo'),
  z.object({
    type: z.literal('start_factory'),
    inputType: FactoryInputTypeSchema,
    value: z.string().trim().min(1, 'Informe os dados da tarefa').max(1000).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Entrada inválida'),
    repoPath: repoPathSchema,
    cols: columns,
    rows,
  }).superRefine((val, ctx) => {
    if (val.inputType === 'jira_url') {
      try {
        const parsed = new URL(val.value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Informe uma URL HTTP ou HTTPS válida da tarefa no JIRA' });
        }
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Informe uma URL válida da tarefa no JIRA' });
      }
    } else if (val.inputType === 'jira_key' && !/^[A-Z][A-Z0-9_]*-\d+$/i.test(val.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Informe uma chave JIRA válida, como PROD-1234' });
    }
  }),
  z.object({ type: z.literal('input'), data: z.string().max(262144) }),
  z.object({ type: z.literal('resize'), cols: columns, rows }),
  z.strictObject({ type: z.literal('attach_session'), sessionId: uuidSchema, cols: columns, rows }),
  z.strictObject({ type: z.literal('stop_session'), sessionId: uuidSchema }),
]);

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('status'), sessionId: uuidSchema.optional(), state: z.enum(['running', 'exited']), exitCode: z.number().int().optional() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({
    type: z.literal('history'),
    reportPath: z.string(),
    sessionPath: z.string().nullable().optional(),
    state: BackgroundSessionHistoryStateSchema,
  }),
  z.object({ type: z.literal('review'), reviewId: uuidSchema, executionId: uuidSchema, state: ReviewStateSchema }),
  z.strictObject({ type: z.literal('session_attached'), session: BackgroundSessionSummarySchema, replay: z.string() }),
]);

export const DirectoryListingSchema = z.object({
  path: z.string(),
  parentPath: z.string().nullable(),
  directories: z.array(z.object({ name: z.string(), path: z.string() })),
});
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;

export const ReviewDestinationSchema = z.strictObject({ path: ReviewReportDirectoryPathSchema });

export const HistoryFileInfoSchema = z.object({
  name: z.string(), path: z.string(), size: z.number().nonnegative(), modifiedAt: z.string(),
});
export const HistoryListingSchema = DirectoryListingSchema.extend({ files: z.array(HistoryFileInfoSchema) });
export const HistoryFileSchema = HistoryFileInfoSchema.extend({ content: z.string() });
export type HistoryListing = z.infer<typeof HistoryListingSchema>;
export type HistoryFile = z.infer<typeof HistoryFileSchema>;

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ReviewRequest = Omit<Extract<ClientMessage, { type: 'start_review' }>, 'type' | 'cols' | 'rows'>;
export type FactoryRequest = Omit<Extract<ClientMessage, { type: 'start_factory' }>, 'type' | 'cols' | 'rows'>;
