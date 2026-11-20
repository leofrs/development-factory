import { z } from 'zod';

export const FACTORY_FLOW_CONTRACT_VERSION = 1 as const;
export const FACTORY_APPROVED_NOTES_MAX_LENGTH = 4000;
const version = z.literal(FACTORY_FLOW_CONTRACT_VERSION);
const id = z.string().uuid();
const timestamp = z.iso.datetime();
const text = z.string().trim().min(1);
const time = (value: string): number => Date.parse(value);
const approvedNotesSchema = text
  .max(FACTORY_APPROVED_NOTES_MAX_LENGTH)
  .refine(value => !value.includes('\0'), 'Notas inválidas');

const repoPathSchema = text
  .max(4096)
  .refine(value => value.startsWith('/') && !value.includes('\0'), 'Use um caminho absoluto no WSL');

const artifactPathSchema = text
  .max(4096)
  .refine(value => value.startsWith('/') && !value.includes('\0'), 'Use um caminho absoluto no WSL');

export const FactoryFlowInputTypeSchema = z.enum(['jira_url', 'jira_key', 'title']);
export type FactoryFlowInputType = z.infer<typeof FactoryFlowInputTypeSchema>;

export const FactoryStageNameSchema = z.enum([
  'triage',
  'planning',
  'development',
  'tests',
  'review',
  'pr',
]);
export type FactoryStageName = z.infer<typeof FactoryStageNameSchema>;

export const FACTORY_STAGE_ORDER: readonly FactoryStageName[] = Object.freeze([
  'triage',
  'planning',
  'development',
  'tests',
  'review',
  'pr',
]);

export const FactoryStageStateSchema = z.enum([
  'pending',
  'running',
  'waiting_action',
  'completed',
  'failed',
  'cancelled',
]);
export type FactoryStageState = z.infer<typeof FactoryStageStateSchema>;

export const FactoryFlowStateSchema = z.enum([
  'queued',
  'running',
  'waiting_action',
  'completed',
  'failed',
  'cancelled',
]);
export type FactoryFlowState = z.infer<typeof FactoryFlowStateSchema>;

export const FINAL_FACTORY_FLOW_STATES: readonly FactoryFlowState[] = Object.freeze([
  'completed',
  'failed',
  'cancelled',
]);

export const FACTORY_FLOW_TRANSITIONS: Readonly<Record<FactoryFlowState, readonly FactoryFlowState[]>> =
  Object.freeze({
    queued: Object.freeze(['running', 'waiting_action', 'failed', 'cancelled'] as const),
    running: Object.freeze(['waiting_action', 'completed', 'failed', 'cancelled'] as const),
    waiting_action: Object.freeze(['running', 'completed', 'failed', 'cancelled'] as const),
    completed: Object.freeze([]),
    failed: Object.freeze([]),
    cancelled: Object.freeze([]),
  });

export function isFinalFactoryFlowState(state: FactoryFlowState): boolean {
  return FINAL_FACTORY_FLOW_STATES.includes(state);
}

export function canTransitionFactoryFlow(from: FactoryFlowState, to: FactoryFlowState): boolean {
  return FACTORY_FLOW_TRANSITIONS[from].includes(to);
}

export function getNextFactoryStage(stage: FactoryStageName): FactoryStageName | null {
  const index = FACTORY_STAGE_ORDER.indexOf(stage);
  if (index < 0 || index >= FACTORY_STAGE_ORDER.length - 1) {
    return null;
  }
  return FACTORY_STAGE_ORDER[index + 1] ?? null;
}

export function canAdvanceFactoryStage(from: FactoryStageName, to: FactoryStageName): boolean {
  return getNextFactoryStage(from) === to;
}

export const ReturnFactoryTargetStageSchema = z.enum(['development', 'tests']);
export type ReturnFactoryTargetStage = z.infer<typeof ReturnFactoryTargetStageSchema>;

export function canReturnFactoryStage(from: FactoryStageName, to: FactoryStageName): boolean {
  return from === 'review' && (to === 'development' || to === 'tests');
}

export const FactoryFlowErrorSchema = z.strictObject({
  contractVersion: version,
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Código de erro inválido'),
  message: text,
  occurredAt: timestamp,
  retryable: z.boolean(),
});
export type FactoryFlowError = z.infer<typeof FactoryFlowErrorSchema>;

function validateFactoryTaskValue(
  value: { inputType: FactoryFlowInputType; value: string },
  ctx: z.RefinementCtx,
): void {
  if (value.inputType === 'jira_url') {
    try {
      const parsed = new URL(value.value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'Informe uma URL HTTP ou HTTPS válida da tarefa no JIRA',
        });
      }
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Informe uma URL válida da tarefa no JIRA',
      });
    }
    return;
  }

  if (value.inputType === 'jira_key' && !/^[A-Z][A-Z0-9_]*-\d+$/i.test(value.value)) {
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'Informe uma chave JIRA válida, como PROD-1234',
    });
  }
}

export const FactoryTaskInputSchema = z
  .strictObject({
    inputType: FactoryFlowInputTypeSchema,
    value: text
      .max(1000)
      .refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Entrada inválida'),
    repoPath: repoPathSchema,
  })
  .superRefine(validateFactoryTaskValue);
export type FactoryTaskInput = z.infer<typeof FactoryTaskInputSchema>;

export const FactoryFlowTargetSchema = z
  .strictObject({
    contractVersion: version,
    inputType: FactoryFlowInputTypeSchema,
    value: text
      .max(1000)
      .refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Entrada inválida'),
    repoPath: repoPathSchema,
  })
  .superRefine(validateFactoryTaskValue);
export type FactoryFlowTarget = z.infer<typeof FactoryFlowTargetSchema>;

function validateTimes(
  value: { createdAt: string; updatedAt: string; startedAt?: string | null; finishedAt: string | null },
  context: z.RefinementCtx,
): void {
  if (
    time(value.updatedAt) < time(value.createdAt) ||
    (value.startedAt &&
      (time(value.startedAt) < time(value.createdAt) || time(value.startedAt) > time(value.updatedAt))) ||
    (value.finishedAt &&
      (time(value.finishedAt) < time(value.startedAt ?? value.createdAt) ||
        time(value.finishedAt) > time(value.updatedAt)))
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Os horários devem respeitar a ordem de criação, início, término e atualização',
    });
  }
}

export const FactoryFlowStageSchema = z
  .strictObject({
    contractVersion: version,
    id,
    flowId: id,
    name: FactoryStageNameSchema,
    state: FactoryStageStateSchema,
    sessionId: id.nullable(),
    reportPath: artifactPathSchema.nullable(),
    sessionPath: artifactPathSchema.nullable(),
    approvedNotes: approvedNotesSchema.optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    error: FactoryFlowErrorSchema.nullable(),
  })
  .superRefine((stage, context) => {
    validateTimes(stage, context);
    if (stage.state === 'failed' && !stage.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Informe o motivo da falha da etapa',
      });
    }
    const final = ['completed', 'failed', 'cancelled'].includes(stage.state);
    if (final !== (stage.finishedAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'O horário de término deve corresponder ao estado final da etapa',
      });
    }
    if (
      (stage.state === 'pending' && stage.startedAt !== null) ||
      (['running', 'waiting_action', 'completed'].includes(stage.state) && stage.startedAt === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'O horário de início deve corresponder ao estado da etapa',
      });
    }
  });
export type FactoryFlowStage = z.infer<typeof FactoryFlowStageSchema>;

export const FactoryFlowArtifactKindSchema = z.enum([
  'plan',
  'specification',
  'patch',
  'implementation_report',
  'test_report',
  'review_report',
  'pr_summary',
  'session_log',
]);
export type FactoryFlowArtifactKind = z.infer<typeof FactoryFlowArtifactKindSchema>;

export const FactoryFlowArtifactFormatSchema = z.enum(['markdown', 'json', 'text']);
export type FactoryFlowArtifactFormat = z.infer<typeof FactoryFlowArtifactFormatSchema>;

export const FactoryFlowArtifactStatusSchema = z.enum(['pending', 'ready', 'incomplete', 'failed']);
export type FactoryFlowArtifactStatus = z.infer<typeof FactoryFlowArtifactStatusSchema>;

export const FactoryFlowArtifactSchema = z
  .strictObject({
    contractVersion: version,
    id,
    flowId: id,
    stage: FactoryStageNameSchema,
    sessionId: id.nullable(),
    kind: FactoryFlowArtifactKindSchema,
    format: FactoryFlowArtifactFormatSchema,
    path: artifactPathSchema,
    status: FactoryFlowArtifactStatusSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
    error: FactoryFlowErrorSchema.nullable(),
  })
  .superRefine((artifact, context) => {
    if (time(artifact.updatedAt) < time(artifact.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'A atualização do artefato não pode anteceder a criação',
      });
    }
    if ((artifact.status === 'failed' || artifact.status === 'incomplete') && !artifact.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Informe o motivo da falha ou artefato incompleto',
      });
    }
  });
export type FactoryFlowArtifact = z.infer<typeof FactoryFlowArtifactSchema>;

export const FactoryFlowTransitionSchema = z
  .strictObject({
    from: FactoryFlowStateSchema,
    to: FactoryFlowStateSchema,
    stage: FactoryStageNameSchema,
    at: timestamp,
    reason: text,
  })
  .refine(value => canTransitionFactoryFlow(value.from, value.to), 'Transição de fluxo inválida');
export type FactoryFlowTransition = z.infer<typeof FactoryFlowTransitionSchema>;

export const FactoryFlowSchema = z
  .strictObject({
    contractVersion: version,
    id,
    title: text.max(200),
    target: FactoryFlowTargetSchema,
    state: FactoryFlowStateSchema,
    currentStage: FactoryStageNameSchema,
    currentSessionId: id.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    finishedAt: timestamp.nullable(),
    transitions: z.array(FactoryFlowTransitionSchema),
    error: FactoryFlowErrorSchema.nullable(),
  })
  .superRefine((flow, context) => {
    validateTimes(flow, context);
    let state: FactoryFlowState = 'queued';
    let at = flow.createdAt;
    for (const transition of flow.transitions) {
      if (
        transition.from !== state ||
        time(transition.at) < time(at) ||
        time(transition.at) > time(flow.updatedAt)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['transitions'],
          message: 'Histórico de transições do fluxo inconsistente',
        });
      }
      state = transition.to;
      at = transition.at;
    }
    if (state !== flow.state || time(at) !== time(flow.updatedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'O estado e a atualização devem corresponder à última transição do fluxo',
      });
    }
    if (
      isFinalFactoryFlowState(flow.state)
        ? flow.finishedAt === null || time(flow.finishedAt) !== time(at)
        : flow.finishedAt !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'O término deve corresponder à transição para um estado final',
      });
    }
    if (flow.state === 'failed' && !flow.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Informe o motivo da falha do fluxo',
      });
    }
  });
export type FactoryFlow = z.infer<typeof FactoryFlowSchema>;

export class FactoryFlowDomainError extends Error {
  constructor(
    public readonly code:
      | 'FACTORY_FLOW_INVALID_TRANSITION'
      | 'FACTORY_FLOW_INVALID_STAGE_ADVANCE'
      | 'FACTORY_FLOW_INVALID_CONTRACT',
    message: string,
  ) {
    super(message);
    this.name = 'FactoryFlowDomainError';
  }
}

export const FactoryFlowTransitionCommandSchema = z.strictObject({
  to: FactoryFlowStateSchema,
  stage: FactoryStageNameSchema.optional(),
  at: timestamp,
  reason: text,
  currentSessionId: id.nullable().optional(),
  error: FactoryFlowErrorSchema.nullable().optional(),
});
export type FactoryFlowTransitionCommand = z.infer<typeof FactoryFlowTransitionCommandSchema>;

/**
 * Aplica uma transição de estado pura sobre um `FactoryFlow`, validando o contrato resultante.
 */
export function transitionFactoryFlow(
  flow: FactoryFlow,
  command: FactoryFlowTransitionCommand,
): FactoryFlow {
  return applyFactoryFlowTransition(flow, command, 'forward');
}

/**
 * Aplica uma transição de retorno controlada (ex.: `review` -> `development` ou `tests`).
 */
export function returnFactoryFlowStage(
  flow: FactoryFlow,
  command: FactoryFlowTransitionCommand,
): FactoryFlow {
  return applyFactoryFlowTransition(flow, command, 'return');
}

function applyFactoryFlowTransition(
  flow: FactoryFlow,
  command: FactoryFlowTransitionCommand,
  direction: 'forward' | 'return',
): FactoryFlow {
  const current = FactoryFlowSchema.safeParse(flow);
  const next = FactoryFlowTransitionCommandSchema.safeParse(command);
  if (!current.success || !next.success) {
    throw new FactoryFlowDomainError(
      'FACTORY_FLOW_INVALID_CONTRACT',
      'Os dados do fluxo ou da transição são inválidos',
    );
  }
  if (!canTransitionFactoryFlow(current.data.state, next.data.to)) {
    throw new FactoryFlowDomainError(
      'FACTORY_FLOW_INVALID_TRANSITION',
      `Não é possível mudar o fluxo de ${current.data.state} para ${next.data.to}`,
    );
  }

  const targetStage = next.data.stage ?? current.data.currentStage;
  if (targetStage !== current.data.currentStage) {
    const validStageChange =
      direction === 'return'
        ? canReturnFactoryStage(current.data.currentStage, targetStage)
        : canAdvanceFactoryStage(current.data.currentStage, targetStage);
    if (!validStageChange) {
      throw new FactoryFlowDomainError(
        'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
        direction === 'return'
          ? `Não é possível retornar a etapa de ${current.data.currentStage} para ${targetStage}`
          : `Não é possível avançar a etapa de ${current.data.currentStage} para ${targetStage}`,
      );
    }
  }

  const updated = FactoryFlowSchema.safeParse({
    ...current.data,
    state: next.data.to,
    currentStage: targetStage,
    currentSessionId:
      next.data.currentSessionId !== undefined
        ? next.data.currentSessionId
        : current.data.currentSessionId,
    updatedAt: next.data.at,
    finishedAt: isFinalFactoryFlowState(next.data.to) ? next.data.at : null,
    error: next.data.error !== undefined ? next.data.error : current.data.error,
    transitions: [
      ...current.data.transitions,
      {
        from: current.data.state,
        to: next.data.to,
        stage: targetStage,
        at: next.data.at,
        reason: next.data.reason,
      },
    ],
  });
  if (!updated.success) {
    throw new FactoryFlowDomainError(
      'FACTORY_FLOW_INVALID_CONTRACT',
      `A transição viola o contrato do fluxo: ${updated.error.issues.map(issue => issue.message).join('; ')}`,
    );
  }
  return updated.data;
}

export const FactoryIdempotencyKeySchema = text
  .max(256)
  .refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Chave de idempotência inválida');
export type FactoryIdempotencyKey = z.infer<typeof FactoryIdempotencyKeySchema>;

export const CreateFactoryFlowRequestSchema = z.strictObject({
  task: FactoryTaskInputSchema,
  title: text.max(200).optional(),
  idempotencyKey: FactoryIdempotencyKeySchema.optional(),
  startSession: z.boolean().optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(300).optional(),
});
export type CreateFactoryFlowRequest = z.infer<typeof CreateFactoryFlowRequestSchema>;

export const CreateFactoryFlowResponseSchema = z.strictObject({
  contractVersion: version,
  flow: FactoryFlowSchema,
  stages: z.array(FactoryFlowStageSchema),
  replayed: z.boolean(),
});
export type CreateFactoryFlowResponse = z.infer<typeof CreateFactoryFlowResponseSchema>;

export const ListFactoryFlowsFilterSchema = z.strictObject({
  state: FactoryFlowStateSchema.optional(),
  stage: FactoryStageNameSchema.optional(),
  repoPath: repoPathSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type ListFactoryFlowsFilterInput = z.infer<typeof ListFactoryFlowsFilterSchema>;

export const FactoryFlowListResponseSchema = z.strictObject({
  contractVersion: version,
  flows: z.array(FactoryFlowSchema),
});
export type FactoryFlowListResponse = z.infer<typeof FactoryFlowListResponseSchema>;

export const FactoryFlowDetailsSchema = z.strictObject({
  contractVersion: version,
  flow: FactoryFlowSchema,
  stages: z.array(FactoryFlowStageSchema),
  artifacts: z.array(FactoryFlowArtifactSchema),
});
export type FactoryFlowDetails = z.infer<typeof FactoryFlowDetailsSchema>;

const HANDOFF_ARTIFACT_KINDS = {
  triage: 'specification',
  planning: 'plan',
  development: 'implementation_report',
  tests: 'test_report',
  review: 'review_report',
} as const;

export function getReadyFactoryStageArtifact(
  details: Pick<FactoryFlowDetails, 'stages' | 'artifacts'>,
  stage: keyof typeof HANDOFF_ARTIFACT_KINDS,
): FactoryFlowArtifact | undefined {
  const reportPath = details.stages.find(item => item.name === stage)?.reportPath;
  return details.artifacts.find(
    artifact =>
      artifact.stage === stage &&
      artifact.kind === HANDOFF_ARTIFACT_KINDS[stage] &&
      artifact.format === 'markdown' &&
      artifact.status === 'ready' &&
      artifact.path === reportPath,
  );
}

export const TransitionFactoryFlowRequestSchema = z.strictObject({
  to: FactoryFlowStateSchema,
  stage: FactoryStageNameSchema.optional(),
  at: timestamp.optional(),
  reason: text,
  currentSessionId: id.nullable().optional(),
  error: FactoryFlowErrorSchema.nullable().optional(),
  expectedUpdatedAt: timestamp.optional(),
});
export type TransitionFactoryFlowRequest = z.infer<typeof TransitionFactoryFlowRequestSchema>;

export const TransitionFactoryFlowResponseSchema = z.strictObject({
  contractVersion: version,
  flow: FactoryFlowSchema,
});
export type TransitionFactoryFlowResponse = z.infer<typeof TransitionFactoryFlowResponseSchema>;

export const AdvanceFactoryStageRequestSchema = z.strictObject({
  at: timestamp.optional(),
  reason: text.optional(),
  expectedUpdatedAt: timestamp.optional(),
  startSession: z.boolean().optional(),
  approvedNotes: approvedNotesSchema.optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(300).optional(),
});
export type AdvanceFactoryStageRequest = z.infer<typeof AdvanceFactoryStageRequestSchema>;

export const ReturnFactoryStageRequestSchema = z.strictObject({
  targetStage: ReturnFactoryTargetStageSchema,
  at: timestamp.optional(),
  reason: text.optional(),
  expectedUpdatedAt: timestamp.optional(),
  startSession: z.boolean().optional(),
  approvedNotes: approvedNotesSchema.optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(300).optional(),
});
export type ReturnFactoryStageRequest = z.infer<typeof ReturnFactoryStageRequestSchema>;

export const RerunFactoryStageRequestSchema = z.strictObject({
  stage: FactoryStageNameSchema.optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(300).optional(),
});
export type RerunFactoryStageRequest = z.infer<typeof RerunFactoryStageRequestSchema>;

export const CancelFactoryFlowRequestSchema = z.strictObject({
  reason: text.optional(),
  expectedUpdatedAt: timestamp.optional(),
});
export type CancelFactoryFlowRequest = z.infer<typeof CancelFactoryFlowRequestSchema>;

export const RegisterFactoryFlowArtifactRequestSchema = z.strictObject({
  stage: FactoryStageNameSchema,
  sessionId: id.nullable().optional(),
  kind: FactoryFlowArtifactKindSchema,
  format: FactoryFlowArtifactFormatSchema.default('markdown'),
  path: artifactPathSchema,
  status: FactoryFlowArtifactStatusSchema.default('pending'),
  error: FactoryFlowErrorSchema.nullable().optional(),
  at: timestamp.optional(),
});
export type RegisterFactoryFlowArtifactRequest = z.infer<typeof RegisterFactoryFlowArtifactRequestSchema>;

export const FactoryFlowApiErrorCodeSchema = z.enum([
  'ORIGIN_FORBIDDEN',
  'FACTORY_FLOW_INVALID_INPUT',
  'FACTORY_FLOW_INVALID_TRANSITION',
  'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
  'FACTORY_FLOW_INVALID_CONTRACT',
  'FACTORY_FLOW_NOT_FOUND',
  'FACTORY_FLOW_IDEMPOTENCY_CONFLICT',
  'FACTORY_FLOW_CONFLICT',
  'FACTORY_FLOW_INTERNAL_ERROR',
]);
export type FactoryFlowApiErrorCode = z.infer<typeof FactoryFlowApiErrorCodeSchema>;

export const FactoryFlowApiErrorResponseSchema = z.strictObject({
  contractVersion: version,
  error: z.strictObject({
    code: FactoryFlowApiErrorCodeSchema,
    message: text,
    details: z.array(text).optional(),
  }),
});
export type FactoryFlowApiErrorResponse = z.infer<typeof FactoryFlowApiErrorResponseSchema>;
