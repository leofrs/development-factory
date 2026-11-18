import { z } from 'zod';

export * from './review.js';

export const TargetTypeSchema = z.enum(['pr', 'branch']);
export type TargetType = z.infer<typeof TargetTypeSchema>;
const columns = z.number().int().min(2).max(500);
const rows = z.number().int().min(1).max(300);

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start_review'),
    targetType: TargetTypeSchema,
    identifier: z.string().trim().min(1).max(500).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Identificador inválido'),
    repoPath: z.string().trim().min(1).max(4096).refine(value => value.startsWith('/') && !value.includes('\0'), 'Use um caminho absoluto no WSL'),
    cols: columns,
    rows,
  }).refine(value => value.targetType !== 'pr' || /^[1-9]\d*$/.test(value.identifier), 'Informe um número de PR positivo'),
  z.object({ type: z.literal('input'), data: z.string().max(262144) }),
  z.object({ type: z.literal('resize'), cols: columns, rows }),
]);

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('status'), state: z.enum(['running', 'exited']), exitCode: z.number().int().optional() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('history'), reportPath: z.string(), sessionPath: z.string(), state: z.enum(['pending', 'saved', 'incomplete']) }),
]);

export const DirectoryListingSchema = z.object({
  path: z.string(),
  parentPath: z.string().nullable(),
  directories: z.array(z.object({ name: z.string(), path: z.string() })),
});
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;

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
