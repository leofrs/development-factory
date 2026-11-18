import { z } from 'zod';

export const REVIEW_CONTRACT_VERSION = 1;
const version = z.literal(REVIEW_CONTRACT_VERSION);
const id = z.string().uuid();
const timestamp = z.iso.datetime();
const text = z.string().trim().min(1);
const time = (value: string): number => Date.parse(value);

export const ReviewStateSchema = z.enum([
  'preparing', 'analyzing', 'waiting_action', 'completed', 'incomplete', 'failed', 'cancelled',
]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const FINAL_REVIEW_STATES: readonly ReviewState[] = Object.freeze([
  'completed', 'incomplete', 'failed', 'cancelled',
]);
export const REVIEW_TRANSITIONS: Readonly<Record<ReviewState, readonly ReviewState[]>> = Object.freeze({
  preparing: Object.freeze(['analyzing', 'waiting_action', 'incomplete', 'failed', 'cancelled'] as const),
  analyzing: Object.freeze(['waiting_action', 'completed', 'incomplete', 'failed', 'cancelled'] as const),
  waiting_action: Object.freeze(['preparing', 'analyzing', 'incomplete', 'failed', 'cancelled'] as const),
  completed: Object.freeze([]),
  incomplete: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export function isFinalReviewState(state: ReviewState): boolean {
  return FINAL_REVIEW_STATES.includes(state);
}

export function canTransitionReview(from: ReviewState, to: ReviewState): boolean {
  return REVIEW_TRANSITIONS[from].includes(to);
}

export const ReviewErrorSchema = z.strictObject({
  contractVersion: version,
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Código de erro inválido'),
  message: text,
  occurredAt: timestamp,
  retryable: z.boolean(),
});
export type ReviewError = z.infer<typeof ReviewErrorSchema>;

const targetFields = {
  contractVersion: version,
  repoPath: text.refine(value => value.startsWith('/') && !value.includes('\0'), 'Use um caminho absoluto no WSL'),
};
export const ReviewTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...targetFields, type: z.literal('pr'), identifier: z.string().regex(/^[1-9]\d*$/, 'Informe um número de PR positivo') }),
  z.strictObject({ ...targetFields, type: z.literal('branch'), identifier: text.max(500).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Identificador inválido') }),
]);
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;

// Envelope do resultado. O contrato detalhado e sua validação pertencem ao passo 6.
// Somente o validador de domínio deve emitir um resultado com status validated.
const resultFields = {
  contractVersion: version,
  id,
  reviewId: id,
  executionId: id,
  createdAt: timestamp,
  summary: text,
  limitations: z.array(text),
};
export const ReviewResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...resultFields, status: z.literal('partial') }),
  z.strictObject({
    ...resultFields,
    status: z.literal('validated'),
    validatedAt: timestamp,
    verdict: z.enum(['approved', 'changes_requested', 'further_investigation']),
  }).refine(value => time(value.validatedAt) >= time(value.createdAt), 'A validação não pode anteceder o resultado'),
]);
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const ReviewStageSchema = z.strictObject({
  contractVersion: version,
  id,
  reviewId: id,
  executionId: id,
  name: z.enum(['task_understanding', 'core_solution', 'related_flows', 'edge_cases', 'final_feedback']),
  state: z.enum(['pending', 'running', 'waiting_action', 'completed', 'incomplete', 'failed', 'cancelled']),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  error: ReviewErrorSchema.nullable(),
}).superRefine((stage, context) => {
  validateTimes(stage, context);
  if ((stage.state === 'failed' || stage.state === 'incomplete') && !stage.error) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'Informe o motivo da falha ou análise incompleta' });
  }
  const final = ['completed', 'incomplete', 'failed', 'cancelled'].includes(stage.state);
  if (final !== (stage.finishedAt !== null)) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'O horário de término deve corresponder ao estado final' });
  }
  if ((stage.state === 'pending' && stage.startedAt !== null) ||
      (['running', 'waiting_action', 'completed'].includes(stage.state) && stage.startedAt === null)) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'O horário de início deve corresponder ao estado da etapa' });
  }
});
export type ReviewStage = z.infer<typeof ReviewStageSchema>;

// Encerramento do processo é um fato técnico independente do resultado do review.
export const ReviewProcessSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('running'), pid: z.number().int().positive() }),
  z.strictObject({ status: z.literal('exited'), exitCode: z.number().int().nullable(), signal: text.nullable() })
    .refine(value => (value.exitCode === null) !== (value.signal === null), 'Informe código de saída ou sinal'),
  z.strictObject({ status: z.literal('failed'), error: ReviewErrorSchema }),
]);
export type ReviewProcess = z.infer<typeof ReviewProcessSchema>;

function validateTimes(
  value: { createdAt: string; updatedAt: string; startedAt?: string | null; finishedAt: string | null },
  context: z.RefinementCtx,
): void {
  if (time(value.updatedAt) < time(value.createdAt) || (value.startedAt && (time(value.startedAt) < time(value.createdAt) || time(value.startedAt) > time(value.updatedAt))) ||
      (value.finishedAt && (time(value.finishedAt) < time(value.startedAt ?? value.createdAt) || time(value.finishedAt) > time(value.updatedAt)))) {
    context.addIssue({ code: 'custom', message: 'Os horários devem respeitar a ordem de criação, início, término e atualização' });
  }
}

export const ReviewExecutionSchema = z.strictObject({
  contractVersion: version,
  id,
  reviewId: id,
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  process: ReviewProcessSchema,
}).superRefine((execution, context) => {
  validateTimes(execution, context);
  const status = execution.process.status;
  if ((status === 'exited' || status === 'failed') !== (execution.finishedAt !== null) ||
      ((status === 'running' || status === 'exited') && !execution.startedAt) ||
      (status === 'pending' && execution.startedAt !== null)) {
    context.addIssue({ code: 'custom', message: 'Os horários da execução devem corresponder ao status do processo' });
  }
});
export type ReviewExecution = z.infer<typeof ReviewExecutionSchema>;

export const ReviewTransitionSchema = z.strictObject({
  from: ReviewStateSchema,
  to: ReviewStateSchema,
  at: timestamp,
  reason: text,
}).refine(value => canTransitionReview(value.from, value.to), 'Transição de review inválida');
export type ReviewTransition = z.infer<typeof ReviewTransitionSchema>;

export const ReviewEventSchema = z.strictObject({
  contractVersion: version,
  id,
  reviewId: id,
  executionId: id.nullable(),
  sequence: z.number().int().positive(),
  type: text.max(120),
  occurredAt: timestamp,
  payload: z.record(z.string(), z.unknown()),
});
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;

export const ReviewSchema = z.strictObject({
  contractVersion: version,
  id,
  target: ReviewTargetSchema,
  state: ReviewStateSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  finishedAt: timestamp.nullable(),
  currentExecutionId: id.nullable(),
  transitions: z.array(ReviewTransitionSchema),
  result: ReviewResultSchema.nullable(),
  error: ReviewErrorSchema.nullable(),
}).superRefine((review, context) => {
  validateTimes(review, context);
  let state: ReviewState = 'preparing';
  let at = review.createdAt;
  for (const transition of review.transitions) {
    if (transition.from !== state || time(transition.at) < time(at) || time(transition.at) > time(review.updatedAt)) {
      context.addIssue({ code: 'custom', path: ['transitions'], message: 'Histórico de transições inconsistente' });
    }
    state = transition.to;
    at = transition.at;
  }
  if (state !== review.state || time(at) !== time(review.updatedAt)) {
    context.addIssue({ code: 'custom', path: ['state'], message: 'O estado e a atualização devem corresponder à última transição' });
  }
  if (isFinalReviewState(review.state) ? review.finishedAt === null || time(review.finishedAt) !== time(at) : review.finishedAt !== null) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'O término deve corresponder à transição para um estado final' });
  }
  if (review.result && (review.result.reviewId !== review.id || review.result.executionId !== review.currentExecutionId)) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'O resultado deve pertencer ao review e à execução atual' });
  }
  if (review.result && (time(review.result.createdAt) < time(review.createdAt) || time(review.result.createdAt) > time(review.updatedAt) ||
      (review.result.status === 'validated' && time(review.result.validatedAt) > time(review.updatedAt)))) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'Os horários do resultado devem estar dentro do período da revisão' });
  }
  if (review.state === 'completed' && review.result?.status !== 'validated') {
    context.addIssue({ code: 'custom', path: ['result'], message: 'A conclusão exige um resultado validado' });
  }
  if ((review.state === 'failed' || review.state === 'incomplete') && !review.error) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'Informe o motivo da falha ou análise incompleta' });
  }
});
export type Review = z.infer<typeof ReviewSchema>;

export class ReviewDomainError extends Error {
  constructor(public readonly code: 'REVIEW_INVALID_TRANSITION' | 'REVIEW_INVALID_CONTRACT', message: string) {
    super(message);
    this.name = 'ReviewDomainError';
  }
}

export const ReviewTransitionCommandSchema = z.strictObject({
  to: ReviewStateSchema,
  at: timestamp,
  reason: text,
  result: ReviewResultSchema.optional(),
  error: ReviewErrorSchema.optional(),
});
export type ReviewTransitionCommand = z.infer<typeof ReviewTransitionCommandSchema>;

// Função pura: persistência e serialização de escritas serão responsabilidade do serviço.
export function transitionReview(review: Review, command: ReviewTransitionCommand): Review {
  const current = ReviewSchema.safeParse(review);
  const next = ReviewTransitionCommandSchema.safeParse(command);
  if (!current.success || !next.success) {
    throw new ReviewDomainError('REVIEW_INVALID_CONTRACT', 'Os dados da revisão ou da transição são inválidos');
  }
  if (!canTransitionReview(current.data.state, next.data.to)) {
    throw new ReviewDomainError('REVIEW_INVALID_TRANSITION', `Não é possível mudar a revisão de ${current.data.state} para ${next.data.to}`);
  }
  const updated = ReviewSchema.safeParse({
    ...current.data,
    state: next.data.to,
    updatedAt: next.data.at,
    finishedAt: isFinalReviewState(next.data.to) ? next.data.at : null,
    result: next.data.result ?? current.data.result,
    error: next.data.error ?? current.data.error,
    transitions: [...current.data.transitions, {
      from: current.data.state, to: next.data.to, at: next.data.at, reason: next.data.reason,
    }],
  });
  if (!updated.success) {
    throw new ReviewDomainError('REVIEW_INVALID_CONTRACT', `A transição viola o contrato da revisão: ${updated.error.issues.map(issue => issue.message).join('; ')}`);
  }
  return updated.data;
}

export const IdempotencyKeySchema = text
  .max(256)
  .refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Chave de idempotência inválida');
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const CreateReviewTargetInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('pr'),
    identifier: z.string().trim().regex(/^[1-9]\d*$/, 'Informe um número de PR positivo'),
    repoPath: text
      .max(4096)
      .refine(value => value.startsWith('/') && !value.includes('\0'), 'Use um caminho absoluto no WSL'),
  }),
  z.strictObject({
    type: z.literal('branch'),
    identifier: text
      .max(500)
      .refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Identificador inválido'),
    repoPath: text
      .max(4096)
      .refine(value => value.startsWith('/') && !value.includes('\0'), 'Use um caminho absoluto no WSL'),
  }),
]);
export type CreateReviewTargetInput = z.infer<typeof CreateReviewTargetInputSchema>;

export const CreateReviewRequestSchema = z.strictObject({
  target: CreateReviewTargetInputSchema,
  idempotencyKey: IdempotencyKeySchema.optional(),
});
export type CreateReviewRequest = z.infer<typeof CreateReviewRequestSchema>;

export const CreateReviewResponseSchema = z.strictObject({
  contractVersion: version,
  review: ReviewSchema,
  execution: ReviewExecutionSchema,
  replayed: z.boolean(),
});
export type CreateReviewResponse = z.infer<typeof CreateReviewResponseSchema>;

export const ReviewDetailsSchema = z.strictObject({
  contractVersion: version,
  review: ReviewSchema,
  executions: z.array(ReviewExecutionSchema),
  events: z.array(ReviewEventSchema),
});
export type ReviewDetails = z.infer<typeof ReviewDetailsSchema>;

export const ListReviewsFilterSchema = z.strictObject({
  state: ReviewStateSchema.optional(),
  repoPath: text
    .max(4096)
    .refine(value => value.startsWith('/') && !value.includes('\0'), 'Use um caminho absoluto no WSL')
    .optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type ListReviewsFilterInput = z.infer<typeof ListReviewsFilterSchema>;

export const ReviewListResponseSchema = z.strictObject({
  contractVersion: version,
  reviews: z.array(ReviewSchema),
});
export type ReviewListResponse = z.infer<typeof ReviewListResponseSchema>;

export const TransitionReviewRequestSchema = z.strictObject({
  to: ReviewStateSchema,
  at: timestamp.optional(),
  reason: text,
  result: ReviewResultSchema.optional(),
  error: ReviewErrorSchema.optional(),
  expectedUpdatedAt: timestamp.optional(),
});
export type TransitionReviewRequest = z.infer<typeof TransitionReviewRequestSchema>;

export const TransitionReviewResponseSchema = z.strictObject({
  contractVersion: version,
  review: ReviewSchema,
});
export type TransitionReviewResponse = z.infer<typeof TransitionReviewResponseSchema>;

export const ReviewApiErrorCodeSchema = z.enum([
  'ORIGIN_FORBIDDEN',
  'REVIEW_INVALID_INPUT',
  'REVIEW_INVALID_TRANSITION',
  'REVIEW_INVALID_CONTRACT',
  'REVIEW_NOT_FOUND',
  'REVIEW_IDEMPOTENCY_CONFLICT',
  'REVIEW_CONFLICT',
  'REVIEW_INTERNAL_ERROR',
]);
export type ReviewApiErrorCode = z.infer<typeof ReviewApiErrorCodeSchema>;

export const ReviewApiErrorResponseSchema = z.strictObject({
  contractVersion: version,
  error: z.strictObject({
    code: ReviewApiErrorCodeSchema,
    message: text,
    details: z.array(text).optional(),
  }),
});
export type ReviewApiErrorResponse = z.infer<typeof ReviewApiErrorResponseSchema>;
