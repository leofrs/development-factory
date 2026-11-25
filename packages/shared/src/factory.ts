import { z } from 'zod';

export const FACTORY_FLOW_CONTRACT_VERSION = 1 as const;
export const FACTORY_APPROVED_NOTES_MAX_LENGTH = 4000;
export const FACTORY_CHECKPOINT_BODY_MAX_LENGTH = 555;
export const FACTORY_MAX_AUTO_ITERATIONS = 3 as const;
const version = z.literal(FACTORY_FLOW_CONTRACT_VERSION);
const id = z.string().uuid();
const timestamp = z.iso.datetime();
const text = z.string().trim().min(1);
const time = (value: string): number => Date.parse(value);
const jiraKeyPattern = /^[A-Z][A-Z0-9_]*-\d+$/i;
export const FactoryApprovedNotesSchema = text
  .max(FACTORY_APPROVED_NOTES_MAX_LENGTH)
  .refine(value => !value.includes('\0'), 'Notas inválidas');
const approvedNotesSchema = FactoryApprovedNotesSchema;

const absoluteWslPathSchema = text
  .max(4096)
  .refine(value => value.startsWith('/') && !value.includes('\0'), 'Use um caminho absoluto no WSL');

const repoPathSchema = absoluteWslPathSchema;
const artifactPathSchema = absoluteWslPathSchema;

export const GitBranchNameSchema = text
  .max(255)
  .refine(
    value =>
      !/[\x00-\x1f\x7f\s~^:?*\[\\]/.test(value) &&
      !value.startsWith('-') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.endsWith('.lock') &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !value.includes('//'),
    'Nome de branch Git inválido',
  );
const gitBranchNameSchema = GitBranchNameSchema;

const manifestStringSchema = z.string({ error: 'Informe um texto' });
const manifestSingleLineSchema = manifestStringSchema.refine(
  value => !/\p{Cc}/u.test(value),
  'O texto não pode conter caracteres de controle',
);
const manifestTextSchema = manifestStringSchema.refine(
  value => value.trim().length > 0 && !value.includes('\0'),
  'Informe um texto não vazio e sem caracteres nulos',
);

const manifestObjectError: z.core.$ZodErrorMap = issue =>
  issue.code === 'unrecognized_keys'
    ? `Campos desconhecidos (${issue.keys.map(key => JSON.stringify(key)).join(', ')})`
    : 'Informe um objeto JSON';

function isManifestBranchName(value: string): boolean {
  return (
    value !== 'HEAD' &&
    GitBranchNameSchema.safeParse(value).success &&
    value.split('/').every(segment => !segment.startsWith('.') && !segment.endsWith('.lock'))
  );
}

function isRepositoryRelativePath(value: string): boolean {
  return (
    !value.startsWith('/') &&
    !/^[a-z]:/i.test(value) &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

const manifestProtectedPathSchema = manifestSingleLineSchema
  .trim()
  .min(1, 'Informe um caminho protegido')
  .refine(isRepositoryRelativePath, 'Use um caminho relativo com / e sem segmentos ".."');

const manifestCommandArgumentSchema = manifestSingleLineSchema.refine(
  value => !/(?:^|[/\\=:\s"']|^-[a-z]+)\.\.(?:[/\\:\s"']|$)/i.test(value),
  'O argumento não pode conter segmentos ".."',
);
const manifestExecutableSchema = z
  .string({ error: 'Informe o executável em texto' })
  .pipe(manifestSingleLineSchema)
  .refine(
    value =>
      value.length > 0 &&
      value !== '.' &&
      !value.endsWith('/') &&
      !value.startsWith('-') &&
      !/\s/.test(value) &&
      isRepositoryRelativePath(value),
    'Use o nome do executável ou um caminho relativo com / e sem segmentos ".."',
  );
const manifestCommandTupleSchema = z.tuple([manifestExecutableSchema], manifestCommandArgumentSchema, {
  error: 'Informe uma lista com o executável seguido dos argumentos',
});
const manifestCommandSchema = manifestCommandTupleSchema.nullable().default(null);

const manifestCommandsSchema = z.strictObject(
  {
    typecheck: manifestCommandSchema,
    lint: manifestCommandSchema,
    test: manifestCommandSchema,
    coverage: manifestCommandSchema,
  },
  { error: manifestObjectError },
);

const manifestEnvVarNameSchema = manifestSingleLineSchema
  .trim()
  .regex(/^[A-Z_][A-Z0-9_]*$/, 'Informe um nome válido de variável de ambiente');

const manifestPlanningVerificationCommandSchema = z.strictObject(
  {
    name: manifestSingleLineSchema.trim().min(1, 'Informe o nome da verificação'),
    command: manifestCommandTupleSchema,
    description: manifestTextSchema.optional(),
    usesDevDatabase: z.boolean().optional(),
    mutatesTestData: z.boolean().optional(),
  },
  { error: manifestObjectError },
);

export const FactoryDevEnvironmentSchema = z.strictObject(
  {
    verificationCommands: z
      .array(manifestPlanningVerificationCommandSchema, {
        error: 'Informe uma lista de comandos de verificação',
      })
      .optional(),
    devDatabase: z
      .strictObject(
        {
          engine: manifestSingleLineSchema.trim().min(1, 'Informe o motor do banco').optional(),
          connectionEnvVar: manifestEnvVarNameSchema.optional(),
          notes: manifestTextSchema.optional(),
        },
        { error: manifestObjectError },
      )
      .optional(),
    envFiles: z
      .array(manifestProtectedPathSchema, {
        error: 'Informe uma lista de arquivos de configuração local',
      })
      .optional(),
    stagingOnlyDependencies: z
      .array(manifestTextSchema, {
        error: 'Informe uma lista de dependências exclusivas de staging',
      })
      .optional(),
  },
  { error: manifestObjectError },
);
export type FactoryDevEnvironment = z.infer<typeof FactoryDevEnvironmentSchema>;

export const FactoryRepositoryProfileSchema = z.strictObject(
  {
    baseBranch: manifestSingleLineSchema
      .trim()
      .refine(isManifestBranchName, 'Informe um nome de branch Git válido')
      .nullable()
      .default(null),
    branchPattern: manifestSingleLineSchema
      .trim()
      .refine(value => {
        const branchName = value.replaceAll('{slug}', 'tarefa');
        return (
          value.includes('{slug}') && !/[{}]/.test(branchName) && isManifestBranchName(branchName)
        );
      }, 'Informe um padrão de branch Git válido com o marcador {slug}')
      .default('factory/{slug}'),
    stack: z
      .array(manifestSingleLineSchema.trim().min(1, 'Informe um item da stack'), {
        error: 'Informe uma lista de tecnologias',
      })
      .default(() => []),
    commands: manifestCommandsSchema.prefault({}),
    protectedPaths: z
      .array(manifestProtectedPathSchema, { error: 'Informe uma lista de caminhos protegidos' })
      .default(() => []),
    architectureRules: z
      .array(manifestTextSchema, { error: 'Informe uma lista de regras de arquitetura' })
      .default(() => []),
    prTemplate: manifestTextSchema.nullable().default(null),
    devEnvironment: FactoryDevEnvironmentSchema.optional(),
  },
  { error: manifestObjectError },
);
export type FactoryRepositoryProfile = z.infer<typeof FactoryRepositoryProfileSchema>;

const gitCommitShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,64}$/i, 'SHA de commit Git inválido');

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

const factoryArtifactIssueSchema = z.strictObject({
  code: text,
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  message: text,
});
export type FactoryArtifactIssue = z.infer<typeof factoryArtifactIssueSchema>;

export const FactoryFlowErrorSchema = z.strictObject({
  contractVersion: version,
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Código de erro inválido'),
  message: text,
  occurredAt: timestamp,
  retryable: z.boolean(),
  issues: z.array(factoryArtifactIssueSchema).optional(),
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

  if (value.inputType === 'jira_key' && !jiraKeyPattern.test(value.value)) {
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

export const FactoryReviewVerdictSchema = z.enum([
  'approved',
  'approved_with_warnings',
  'changes_requested',
]);
export type FactoryReviewVerdict = z.infer<typeof FactoryReviewVerdictSchema>;

export function isFactoryReviewApprovedVerdict(verdict: FactoryReviewVerdict): boolean {
  return verdict === 'approved' || verdict === 'approved_with_warnings';
}

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
    iteration: z.number().int().nonnegative().default(0),
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

export const FACTORY_STAGE_SIDECAR_CONTRACT_VERSION = 1 as const;
const sidecarVersion = z.literal(FACTORY_STAGE_SIDECAR_CONTRACT_VERSION);

const sidecarFilePathSchema = manifestSingleLineSchema
  .trim()
  .min(1, 'Informe um caminho de arquivo')
  .refine(isRepositoryRelativePath, 'Use um caminho relativo com / e sem segmentos ".."');

export const FactoryJiraContextSchema = z.strictObject({
  key: text.regex(jiraKeyPattern, 'Informe uma chave JIRA válida, como PROD-1234'),
  url: z
    .url({
      protocol: /^https?$/,
      error: 'Informe uma URL HTTP ou HTTPS válida da tarefa no JIRA',
    })
    .nullable(),
});
export type FactoryJiraContext = z.infer<typeof FactoryJiraContextSchema>;

export const FactoryTriageSidecarSchema = z.strictObject({
  contractVersion: sidecarVersion,
  stage: z.literal('triage'),
  acceptanceCriteria: z
    .array(z.strictObject({ id: text, description: text }))
    .refine(
      criteria => new Set(criteria.map(criterion => criterion.id)).size === criteria.length,
      'Os IDs dos critérios de aceite devem ser únicos',
    ),
  negativeScope: z.array(text),
  blockers: z.array(text),
  jiraContext: FactoryJiraContextSchema.nullable(),
  jiraError: text.nullable().optional(),
  technicalContext: text,
});
export type FactoryTriageSidecar = z.infer<typeof FactoryTriageSidecarSchema>;

export const FactoryTriageGateSchema = z.strictObject({
  blockers: z.array(text),
  jiraError: text.nullable(),
  blocked: z.boolean(),
});
export type FactoryTriageGate = z.infer<typeof FactoryTriageGateSchema>;

export function evaluateFactoryTriageGate(sidecar: FactoryTriageSidecar): FactoryTriageGate {
  const blockers = sidecar.blockers;
  const jiraError = sidecar.jiraError ?? null;
  return {
    blockers,
    jiraError,
    // Lacunas investigáveis em `blockers` são encaminhadas ao Planejamento; apenas falhas impeditivas (ex.: Jira) bloqueiam.
    blocked: jiraError !== null,
  };
}

export const FactoryPlanningPendingDecisionSchema = z
  .strictObject({
    id: text.max(32).optional(),
    question: text,
    options: z.array(text).min(2),
    recommendedOption: text,
    checksPerformed: z.array(text).min(1).optional(),
    unresolvableReason: text.optional(),
  })
  .refine(decision => decision.options.includes(decision.recommendedOption), {
    path: ['recommendedOption'],
    message: 'A recomendação deve corresponder a uma das opções',
  });
export type FactoryPlanningPendingDecision = z.infer<
  typeof FactoryPlanningPendingDecisionSchema
>;

/** Resolve o identificador estável de uma pergunta pendente, preservando compatibilidade com artefatos legados sem `id`. */
export function resolvePlanningPendingDecisionId(
  decision: Pick<FactoryPlanningPendingDecision, 'id'>,
  index: number,
): string {
  const explicitId = decision.id?.trim();
  return explicitId && explicitId.length > 0 ? explicitId : `D${index + 1}`;
}

export const FactoryPlanningVerificationRecordSchema = z
  .strictObject({
    target: text,
    status: z.enum(['passed', 'failed', 'blocked_by_staging', 'skipped']),
    evidence: text,
    isolationOrRollback: text.nullable().optional(),
    stagingLimitation: text.nullable().optional(),
  })
  .refine(
    record =>
      record.status !== 'blocked_by_staging' ||
      (typeof record.stagingLimitation === 'string' && record.stagingLimitation.trim().length > 0),
    {
      path: ['stagingLimitation'],
      message:
        'Informe a limitação concreta de staging quando a verificação não puder ser executada localmente',
    },
  );
export type FactoryPlanningVerificationRecord = z.infer<
  typeof FactoryPlanningVerificationRecordSchema
>;

export const FactoryPlanningDecisionChoiceModeSchema = z.enum([
  'recommended',
  'alternative',
  'custom',
]);
export type FactoryPlanningDecisionChoiceMode = z.infer<
  typeof FactoryPlanningDecisionChoiceModeSchema
>;

export const FactoryPlanningDecisionApprovalSchema = z.strictObject({
  id: text.max(32),
  question: text.max(1000),
  mode: FactoryPlanningDecisionChoiceModeSchema,
  selectedOption: text.max(2000),
  recommendedOption: text.max(2000),
  customNote: text.max(2000).optional(),
});
export type FactoryPlanningDecisionApproval = z.infer<
  typeof FactoryPlanningDecisionApprovalSchema
>;

export const FactoryAcceptanceCriterionSchema = z.strictObject({
  id: text.max(64),
  description: text.max(2000),
});
export type FactoryAcceptanceCriterion = z.infer<typeof FactoryAcceptanceCriterionSchema>;

export const FactoryApprovedAcceptanceCriterionSchema = z.strictObject({
  id: text.max(64),
  description: text.max(2000),
  approved: z.boolean(),
});
export type FactoryApprovedAcceptanceCriterion = z.infer<
  typeof FactoryApprovedAcceptanceCriterionSchema
>;

const uniqueAcceptanceCriteriaRefinement = (
  criteria: readonly { id: string }[],
): boolean => new Set(criteria.map(criterion => criterion.id)).size === criteria.length;

export const FactoryPlanningApprovalInputSchema = z.strictObject({
  decisions: z.array(FactoryPlanningDecisionApprovalSchema),
  acceptanceCriteria: z
    .array(FactoryApprovedAcceptanceCriterionSchema)
    .refine(uniqueAcceptanceCriteriaRefinement, 'Os IDs dos critérios de aceite devem ser únicos'),
  notes: approvedNotesSchema.optional(),
});
export type FactoryPlanningApprovalInput = z.infer<typeof FactoryPlanningApprovalInputSchema>;

export const FactoryPlanningApprovalSchema = z.strictObject({
  decisions: z.array(FactoryPlanningDecisionApprovalSchema),
  acceptanceCriteria: z
    .array(FactoryApprovedAcceptanceCriterionSchema)
    .refine(uniqueAcceptanceCriteriaRefinement, 'Os IDs dos critérios de aceite devem ser únicos'),
  notes: approvedNotesSchema.optional(),
  approvedAt: timestamp,
});
export type FactoryPlanningApproval = z.infer<typeof FactoryPlanningApprovalSchema>;

export const FactoryPlanningGateSchema = z.strictObject({
  pendingDecisions: z.array(FactoryPlanningPendingDecisionSchema),
  acceptanceCriteria: z.array(FactoryAcceptanceCriterionSchema),
});
export type FactoryPlanningGate = z.infer<typeof FactoryPlanningGateSchema>;

export const FactoryPlanningSidecarSchema = z.strictObject({
  contractVersion: sidecarVersion,
  stage: z.literal('planning'),
  pendingDecisions: z
    .array(FactoryPlanningPendingDecisionSchema)
    .refine(
      decisions =>
        new Set(decisions.map((decision, index) => resolvePlanningPendingDecisionId(decision, index)))
          .size === decisions.length,
      'Os identificadores das perguntas pendentes devem ser únicos',
    ),
  plannedFiles: z.array(sidecarFilePathSchema),
  testPlan: z.array(text),
  localVerifications: z.array(FactoryPlanningVerificationRecordSchema).optional(),
});
export type FactoryPlanningSidecar = z.infer<typeof FactoryPlanningSidecarSchema>;

const backendCommandCheckSchema = z
  .strictObject({
    command: manifestCommandTupleSchema,
    exitCode: z.number().int().nonnegative().nullable(),
    errorSummary: text.nullable(),
  })
  .refine(result => (result.exitCode === 0) === (result.errorSummary === null), {
    path: ['errorSummary'],
    message: 'Informe um resumo de erro somente quando a verificação falhar',
  });
export type FactoryBackendCommandCheck = z.infer<typeof backendCommandCheckSchema>;

const developmentChecksSchema = z.strictObject({
  typecheck: backendCommandCheckSchema.nullable(),
  lint: backendCommandCheckSchema.nullable(),
});
export type FactoryDevelopmentChecks = z.infer<typeof developmentChecksSchema>;

const testsChecksSchema = z.strictObject({
  test: backendCommandCheckSchema.nullable(),
  coverage: backendCommandCheckSchema.nullable(),
});
export type FactoryTestsChecks = z.infer<typeof testsChecksSchema>;

export const FactoryDevelopmentSidecarSchema = z.strictObject({
  contractVersion: sidecarVersion,
  stage: z.literal('development'),
  changedFiles: z.array(sidecarFilePathSchema),
  summary: text,
  deviations: z.array(z.strictObject({ description: text, justification: text })),
  backendChecks: developmentChecksSchema.optional(),
});
export type FactoryDevelopmentSidecar = z.infer<typeof FactoryDevelopmentSidecarSchema>;

const coveragePercentSchema = z.number().min(0).max(100);

function sameCommandTuple(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const FactoryTestsSidecarSchema = z
  .strictObject({
    contractVersion: sidecarVersion,
    stage: z.literal('tests'),
    executedCommands: z.array(
      z.strictObject({
        command: z.tuple([text], z.string()),
        exitCode: z.number().int().nonnegative().nullable(),
      }),
    ),
    testCases: z.array(
      z.strictObject({
        id: text,
        description: text,
        acceptanceCriteriaIds: z.array(text).min(1),
        status: z.enum(['passed', 'failed', 'skipped']),
      }),
    ),
    status: z.enum(['passed', 'failed', 'not_run']),
    coverage: z
      .strictObject({
        linesPercent: coveragePercentSchema,
        branchesPercent: coveragePercentSchema.nullable(),
      })
      .nullable(),
    backendChecks: testsChecksSchema.optional(),
  })
  .superRefine((sidecar, context) => {
    if (!sidecar.backendChecks) {
      return;
    }
    const checks = [sidecar.backendChecks.test, sidecar.backendChecks.coverage].filter(
      (check): check is FactoryBackendCommandCheck => check !== null,
    );
    const expectedStatus =
      checks.length === 0 ? 'not_run' : checks.every(check => check.exitCode === 0) ? 'passed' : 'failed';
    if (sidecar.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'O status dos testes deve corresponder às verificações executadas pelo backend',
      });
    }
    const matchesCommands =
      sidecar.executedCommands.length === checks.length &&
      checks.every((check, index) => {
        const executed = sidecar.executedCommands[index];
        return (
          executed !== undefined &&
          executed.exitCode === check.exitCode &&
          sameCommandTuple(executed.command, check.command)
        );
      });
    if (!matchesCommands) {
      context.addIssue({
        code: 'custom',
        path: ['executedCommands'],
        message: 'Os comandos executados devem corresponder às verificações registradas pelo backend',
      });
    }
  });
export type FactoryTestsSidecar = z.infer<typeof FactoryTestsSidecarSchema>;

function validateReviewReturnTargetConsistency(
  value: { verdict: FactoryReviewVerdict; returnTarget?: ReturnFactoryTargetStage | null },
  context: z.RefinementCtx,
): void {
  if (isFactoryReviewApprovedVerdict(value.verdict)) {
    if (value.returnTarget != null) {
      context.addIssue({
        code: 'custom',
        path: ['returnTarget'],
        message: 'O alvo de retorno deve ser null quando o Code Review aprovar as alterações',
      });
    }
    return;
  }

  if (value.returnTarget == null) {
    context.addIssue({
      code: 'custom',
      path: ['returnTarget'],
      message: 'Informe returnTarget ("development" ou "tests") quando o veredito solicitar ajustes',
    });
  }
}

export const FactoryReviewFindingSeveritySchema = z.enum(['BLOQUEANTE', 'SUGESTÃO', 'NIT']);
export type FactoryReviewFindingSeverity = z.infer<typeof FactoryReviewFindingSeveritySchema>;

const reviewFindingLabelSchema = manifestSingleLineSchema.trim().min(1);

export const FactoryReviewSidecarSchema = z
  .strictObject({
    contractVersion: sidecarVersion,
    stage: z.literal('review'),
    verdict: FactoryReviewVerdictSchema,
    returnTarget: ReturnFactoryTargetStageSchema.nullable().optional(),
    findings: z.array(
      z.strictObject({
        severity: FactoryReviewFindingSeveritySchema,
        file: sidecarFilePathSchema,
        line: z.number().int().positive(),
        explanation: text,
        signature: reviewFindingLabelSchema.optional(),
        category: reviewFindingLabelSchema.optional(),
      }),
    ),
  })
  .superRefine(validateReviewReturnTargetConsistency);
export type FactoryReviewSidecar = z.infer<typeof FactoryReviewSidecarSchema>;

export const FactoryReviewDecisionSchema = z
  .strictObject({
    verdict: FactoryReviewVerdictSchema,
    returnTarget: ReturnFactoryTargetStageSchema.nullable(),
  })
  .superRefine(validateReviewReturnTargetConsistency);
export type FactoryReviewDecision = z.infer<typeof FactoryReviewDecisionSchema>;

/** Resolve e valida o veredito e o alvo de retorno explícito a partir do sidecar do Bloco 05. */
export function resolveFactoryReviewDecision(
  sidecar: Pick<FactoryReviewSidecar, 'verdict' | 'returnTarget'>,
): FactoryReviewDecision {
  return FactoryReviewDecisionSchema.parse({
    verdict: sidecar.verdict,
    returnTarget: sidecar.returnTarget ?? null,
  });
}

export const FactoryReviewFindingTriageActionSchema = z.enum([
  'pending',
  'approve_fix',
  'promote_mandatory',
  'dismiss_false_positive',
]);
export type FactoryReviewFindingTriageAction = z.infer<
  typeof FactoryReviewFindingTriageActionSchema
>;

export const FactoryReviewFindingJustificationSchema = text
  .max(1000)
  .refine(value => !value.includes('\0'), 'Justificativa inválida');

const uniqueReviewFindingDecisionsRefinement = (
  decisions: readonly { findingId: string }[],
): boolean => new Set(decisions.map(decision => decision.findingId)).size === decisions.length;

export const FactoryReviewFindingDecisionSchema = z.strictObject({
  findingId: text.max(32),
  action: FactoryReviewFindingTriageActionSchema,
  justification: FactoryReviewFindingJustificationSchema.optional(),
});
export type FactoryReviewFindingDecision = z.infer<typeof FactoryReviewFindingDecisionSchema>;

export const FactoryReviewTriageSchema = z.strictObject({
  reviewArtifactId: id,
  iteration: z.number().int().nonnegative(),
  decisions: z
    .array(FactoryReviewFindingDecisionSchema)
    .refine(
      uniqueReviewFindingDecisionsRefinement,
      'Os identificadores dos apontamentos triados devem ser únicos',
    ),
  updatedAt: timestamp,
});
export type FactoryReviewTriage = z.infer<typeof FactoryReviewTriageSchema>;

export const FactoryReviewTriagedFindingSchema = z.strictObject({
  id: text.max(32),
  index: z.number().int().nonnegative(),
  severity: FactoryReviewFindingSeveritySchema,
  file: sidecarFilePathSchema,
  line: z.number().int().positive(),
  explanation: text,
  signature: reviewFindingLabelSchema.optional(),
  category: reviewFindingLabelSchema.optional(),
  action: FactoryReviewFindingTriageActionSchema,
  justification: FactoryReviewFindingJustificationSchema.optional(),
  effectiveSeverity: z.enum(['BLOQUEANTE', 'SUGESTÃO', 'NIT', 'DISCARDED']),
  isActiveBlocker: z.boolean(),
  includedInReturnScope: z.boolean(),
});
export type FactoryReviewTriagedFinding = z.infer<typeof FactoryReviewTriagedFindingSchema>;

const nonNegativeInt = z.number().int().nonnegative();

export const FactoryReviewGateSchema = z.strictObject({
  reviewArtifactId: id,
  reviewReportPath: artifactPathSchema,
  iteration: nonNegativeInt,
  verdict: FactoryReviewVerdictSchema,
  returnTarget: ReturnFactoryTargetStageSchema.nullable(),
  findings: z.array(FactoryReviewTriagedFindingSchema),
  counts: z.strictObject({
    total: nonNegativeInt,
    blocking: nonNegativeInt,
    suggestion: nonNegativeInt,
    nit: nonNegativeInt,
    activeBlockers: nonNegativeInt,
    approvedForFix: nonNegativeInt,
    promotedMandatory: nonNegativeInt,
    dismissed: nonNegativeInt,
    pending: nonNegativeInt,
  }),
  canAdvanceToPr: z.boolean(),
});
export type FactoryReviewGate = z.infer<typeof FactoryReviewGateSchema>;

export const SaveFactoryReviewTriageRequestSchema = z.strictObject({
  decisions: z
    .array(FactoryReviewFindingDecisionSchema)
    .refine(
      uniqueReviewFindingDecisionsRefinement,
      'Os identificadores dos apontamentos triados devem ser únicos',
    ),
  expectedUpdatedAt: timestamp.optional(),
});
export type SaveFactoryReviewTriageRequest = z.infer<typeof SaveFactoryReviewTriageRequestSchema>;

export const FactoryReviewTriageInputSchema = z.strictObject({
  decisions: z
    .array(FactoryReviewFindingDecisionSchema)
    .refine(
      uniqueReviewFindingDecisionsRefinement,
      'Os identificadores dos apontamentos triados devem ser únicos',
    ),
});
export type FactoryReviewTriageInput = z.infer<typeof FactoryReviewTriageInputSchema>;

export const FactoryReviewTriageScopeSchema = z.strictObject({
  reviewArtifactId: id,
  iteration: nonNegativeInt,
  mandatoryFixes: z.array(
    z.strictObject({
      id: text.max(32),
      originalSeverity: FactoryReviewFindingSeveritySchema,
      effectiveSeverity: z.enum(['BLOQUEANTE', 'SUGESTÃO', 'NIT']),
      file: sidecarFilePathSchema,
      line: z.number().int().positive(),
      explanation: text,
      promotedFromSuggestion: z.boolean(),
    }),
  ),
  dismissedFalsePositives: z.array(
    z.strictObject({
      id: text.max(32),
      originalSeverity: FactoryReviewFindingSeveritySchema,
      file: sidecarFilePathSchema,
      line: z.number().int().positive(),
      explanation: text,
      justification: FactoryReviewFindingJustificationSchema.optional(),
    }),
  ),
  deferredSuggestions: z.array(
    z.strictObject({
      id: text.max(32),
      severity: FactoryReviewFindingSeveritySchema,
      file: sidecarFilePathSchema,
      line: z.number().int().positive(),
      explanation: text,
    }),
  ),
});
export type FactoryReviewTriageScope = z.infer<typeof FactoryReviewTriageScopeSchema>;

export const FactoryPrSidecarSchema = z.strictObject({
  contractVersion: sidecarVersion,
  stage: z.literal('pr'),
  title: text,
  summary: text,
  baseBranch: GitBranchNameSchema,
  headBranch: GitBranchNameSchema,
  satisfiedAcceptanceCriteriaIds: z.array(text),
  evidence: z.array(text),
});
export type FactoryPrSidecar = z.infer<typeof FactoryPrSidecarSchema>;

export const FactoryPrReviewerSchema = manifestSingleLineSchema
  .trim()
  .min(1, 'Informe o identificador do reviewer')
  .max(100, 'Identificador do reviewer deve ter no máximo 100 caracteres')
  .refine(
    value =>
      !/[\s,;@]/.test(value) &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.includes('..') &&
      !value.includes('//'),
    'Informe um usuário ou time válido sem espaços, vírgulas ou "@"',
  );

export const FactoryPrTitleSchema = manifestSingleLineSchema
  .trim()
  .min(1, 'Informe o título do Pull Request')
  .max(200, 'O título do Pull Request deve ter no máximo 200 caracteres');

export const FactoryPrDescriptionSchema = z
  .string({ error: 'Informe a descrição do Pull Request' })
  .trim()
  .min(1, 'Informe a descrição Markdown do Pull Request')
  .max(65_536, 'A descrição do Pull Request excede o limite de 65.536 caracteres')
  .refine(value => !value.includes('\0'), 'Descrição inválida');

export const FactoryPrTargetBranchSchema = GitBranchNameSchema.refine(
  value => value !== 'HEAD',
  'Informe uma branch destino válida (diferente de HEAD)',
);

const uniquePrReviewersRefinement = (reviewers: readonly string[]): boolean =>
  new Set(reviewers.map(item => item.toLowerCase())).size === reviewers.length;

export const FactoryPrReviewSchema = z.strictObject({
  prArtifactId: id,
  title: FactoryPrTitleSchema,
  description: FactoryPrDescriptionSchema,
  baseBranch: FactoryPrTargetBranchSchema,
  draft: z.boolean(),
  reviewers: z
    .array(FactoryPrReviewerSchema)
    .max(50, 'Informe no máximo 50 reviewers')
    .refine(uniquePrReviewersRefinement, 'A lista de reviewers não pode conter duplicatas'),
  updateJira: z.boolean(),
  confirmedForPublish: z.boolean().default(false),
  confirmedAt: timestamp.nullable().default(null),
  updatedAt: timestamp,
});
export type FactoryPrReview = z.infer<typeof FactoryPrReviewSchema>;

export const FactoryPrProviderSchema = z.enum(['github', 'gitlab']);
export type FactoryPrProvider = z.infer<typeof FactoryPrProviderSchema>;

export const FactoryPrSecretFindingSchema = z.strictObject({
  file: sidecarFilePathSchema,
  line: z.number().int().positive(),
  rule: text.max(120),
  snippet: text.max(300),
});
export type FactoryPrSecretFinding = z.infer<typeof FactoryPrSecretFindingSchema>;

export const FactoryPrJiraSyncStatusSchema = z.enum(['not_requested', 'updated', 'failed']);
export type FactoryPrJiraSyncStatus = z.infer<typeof FactoryPrJiraSyncStatusSchema>;

export const FactoryPrJiraSyncSchema = z.strictObject({
  status: FactoryPrJiraSyncStatusSchema,
  issueKey: text.regex(jiraKeyPattern, 'Informe uma chave JIRA válida, como PROD-1234').nullable(),
  updatedAt: timestamp.nullable(),
  error: text.max(2000).nullable(),
});
export type FactoryPrJiraSync = z.infer<typeof FactoryPrJiraSyncSchema>;

export const FactoryPrPublicationStatusSchema = z.enum([
  'blocked_by_secrets',
  'failed',
  'published',
]);
export type FactoryPrPublicationStatus = z.infer<typeof FactoryPrPublicationStatusSchema>;

export const FactoryPrPublicationSchema = z.strictObject({
  prArtifactId: id,
  status: FactoryPrPublicationStatusSchema,
  provider: FactoryPrProviderSchema.nullable(),
  prUrl: z
    .url({
      protocol: /^https?$/,
      error: 'Informe uma URL HTTP ou HTTPS válida do Pull Request',
    })
    .nullable(),
  prNumber: z.number().int().positive().nullable(),
  commitSha: gitCommitShaSchema.nullable(),
  headBranch: gitBranchNameSchema,
  baseBranch: FactoryPrTargetBranchSchema,
  draft: z.boolean(),
  publishedAt: timestamp.nullable(),
  secretFindings: z.array(FactoryPrSecretFindingSchema),
  jiraSync: FactoryPrJiraSyncSchema,
  error: text.max(4000).nullable(),
  updatedAt: timestamp,
});
export type FactoryPrPublication = z.infer<typeof FactoryPrPublicationSchema>;

export const FactoryPrGateSchema = z.strictObject({
  prArtifactId: id,
  prReportPath: artifactPathSchema,
  iteration: nonNegativeInt,
  title: FactoryPrTitleSchema,
  description: FactoryPrDescriptionSchema,
  summary: text,
  baseBranch: FactoryPrTargetBranchSchema,
  headBranch: gitBranchNameSchema,
  draft: z.boolean(),
  reviewers: z.array(FactoryPrReviewerSchema),
  updateJira: z.boolean(),
  confirmedForPublish: z.boolean(),
  confirmedAt: timestamp.nullable(),
  updatedAt: timestamp.nullable(),
  draftTitle: FactoryPrTitleSchema,
  draftDescription: FactoryPrDescriptionSchema,
  draftBaseBranch: FactoryPrTargetBranchSchema,
  satisfiedAcceptanceCriteriaIds: z.array(text),
  evidence: z.array(text),
  jiraContext: FactoryJiraContextSchema.nullable(),
  prPublication: FactoryPrPublicationSchema.nullable().optional(),
});
export type FactoryPrGate = z.infer<typeof FactoryPrGateSchema>;

export const SaveFactoryPrReviewRequestSchema = z.strictObject({
  title: FactoryPrTitleSchema,
  description: FactoryPrDescriptionSchema,
  baseBranch: FactoryPrTargetBranchSchema,
  draft: z.boolean(),
  reviewers: z
    .array(FactoryPrReviewerSchema)
    .max(50, 'Informe no máximo 50 reviewers')
    .refine(uniquePrReviewersRefinement, 'A lista de reviewers não pode conter duplicatas'),
  updateJira: z.boolean(),
  confirmPublish: z.boolean().default(false),
  expectedUpdatedAt: timestamp.optional(),
});
export type SaveFactoryPrReviewRequest = z.infer<typeof SaveFactoryPrReviewRequestSchema>;

export const FactoryFlowCheckpointSchema = z.strictObject({
  contractVersion: version,
  id,
  flowId: id,
  stage: FactoryStageNameSchema,
  iteration: z.number().int().nonnegative().default(0),
  commitSha: gitCommitShaSchema,
  branchName: gitBranchNameSchema.nullable().default(null),
  sessionId: id.nullable().default(null),
  // Reserva espaço para o corpo separado do título pela linha em branco do Git.
  message: text.max(500 + 2 + FACTORY_CHECKPOINT_BODY_MAX_LENGTH).nullable().default(null),
  createdAt: timestamp,
});
export type FactoryFlowCheckpoint = z.infer<typeof FactoryFlowCheckpointSchema>;

export const FactoryFlowWorktreeMetadataSchema = z.strictObject({
  worktreePath: absoluteWslPathSchema.nullable(),
  branchName: gitBranchNameSchema.nullable(),
  baseBranch: gitBranchNameSchema.nullable(),
});
export type FactoryFlowWorktreeMetadata = z.infer<typeof FactoryFlowWorktreeMetadataSchema>;

export const FactoryWorktreeRetentionPolicySchema = z.enum([
  'cleanup_on_finish',
  'cleanup_always',
  'keep_all',
]);
export type FactoryWorktreeRetentionPolicy = z.infer<typeof FactoryWorktreeRetentionPolicySchema>;

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
    iteration: z.number().int().nonnegative().default(0),
    maxIterations: z.number().int().positive().default(FACTORY_MAX_AUTO_ITERATIONS),
    lastReviewVerdict: FactoryReviewVerdictSchema.nullable().default(null),
    loopPausedReason: text.nullable().default(null),
    worktreePath: absoluteWslPathSchema.nullable().default(null),
    branchName: gitBranchNameSchema.nullable().default(null),
    baseBranch: gitBranchNameSchema.nullable().default(null),
    planningApproval: FactoryPlanningApprovalSchema.nullable().optional(),
    reviewTriage: FactoryReviewTriageSchema.nullable().optional(),
    prReview: FactoryPrReviewSchema.nullable().optional(),
    prPublication: FactoryPrPublicationSchema.nullable().optional(),
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
  iteration: z.number().int().nonnegative().optional(),
  lastReviewVerdict: FactoryReviewVerdictSchema.nullable().optional(),
  loopPausedReason: text.nullable().optional(),
  worktreePath: absoluteWslPathSchema.nullable().optional(),
  branchName: gitBranchNameSchema.nullable().optional(),
  baseBranch: gitBranchNameSchema.nullable().optional(),
  planningApproval: FactoryPlanningApprovalSchema.nullable().optional(),
  reviewTriage: FactoryReviewTriageSchema.nullable().optional(),
  prReview: FactoryPrReviewSchema.nullable().optional(),
  prPublication: FactoryPrPublicationSchema.nullable().optional(),
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
    iteration: next.data.iteration !== undefined ? next.data.iteration : current.data.iteration,
    lastReviewVerdict:
      next.data.lastReviewVerdict !== undefined
        ? next.data.lastReviewVerdict
        : current.data.lastReviewVerdict,
    loopPausedReason:
      next.data.loopPausedReason !== undefined
        ? next.data.loopPausedReason
        : current.data.loopPausedReason,
    worktreePath:
      next.data.worktreePath !== undefined ? next.data.worktreePath : current.data.worktreePath,
    branchName:
      next.data.branchName !== undefined ? next.data.branchName : current.data.branchName,
    baseBranch:
      next.data.baseBranch !== undefined ? next.data.baseBranch : current.data.baseBranch,
    planningApproval:
      next.data.planningApproval !== undefined
        ? next.data.planningApproval
        : current.data.planningApproval,
    reviewTriage:
      next.data.reviewTriage !== undefined
        ? next.data.reviewTriage
        : current.data.reviewTriage,
    prReview:
      next.data.prReview !== undefined ? next.data.prReview : current.data.prReview,
    prPublication:
      next.data.prPublication !== undefined ? next.data.prPublication : current.data.prPublication,
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
  baseBranch: GitBranchNameSchema.optional(),
  idempotencyKey: FactoryIdempotencyKeySchema.optional(),
  startSession: z.boolean().optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(300).optional(),
});
export type CreateFactoryFlowRequest = z.infer<typeof CreateFactoryFlowRequestSchema>;

export const FactoryPreflightRequestSchema = z.strictObject({
  repoPath: repoPathSchema,
  inputType: FactoryFlowInputTypeSchema,
  baseBranch: GitBranchNameSchema.optional(),
});
export type FactoryPreflightRequest = z.infer<typeof FactoryPreflightRequestSchema>;

const factoryPreflightCheckSchema = z.strictObject({
  status: z.enum(['ok', 'warning', 'error']),
  message: text,
});
export type FactoryPreflightCheck = z.infer<typeof factoryPreflightCheckSchema>;

export const FactoryPreflightResponseSchema = z.strictObject({
  contractVersion: version,
  blocked: z.boolean(),
  checks: z.strictObject({
    claude: factoryPreflightCheckSchema,
    jiraMcp: factoryPreflightCheckSchema,
    github: factoryPreflightCheckSchema,
    git: factoryPreflightCheckSchema,
    profile: factoryPreflightCheckSchema,
  }),
});
export type FactoryPreflightResponse = z.infer<typeof FactoryPreflightResponseSchema>;

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

export const FactoryFlowDetailsSchema = z
  .strictObject({
    contractVersion: version,
    flow: FactoryFlowSchema,
    stages: z.array(FactoryFlowStageSchema),
    artifacts: z.array(FactoryFlowArtifactSchema),
    worktreePath: absoluteWslPathSchema.nullable().optional(),
    branchName: gitBranchNameSchema.nullable().optional(),
    baseBranch: gitBranchNameSchema.nullable().optional(),
    checkpoints: z.array(FactoryFlowCheckpointSchema).default([]),
    triageGate: FactoryTriageGateSchema.nullable().optional(),
    planningGate: FactoryPlanningGateSchema.nullable().optional(),
    reviewGate: FactoryReviewGateSchema.nullable().optional(),
    prGate: FactoryPrGateSchema.nullable().optional(),
  })
  .transform(details => ({
    ...details,
    worktreePath:
      details.worktreePath !== undefined ? details.worktreePath : details.flow.worktreePath,
    branchName: details.branchName !== undefined ? details.branchName : details.flow.branchName,
    baseBranch: details.baseBranch !== undefined ? details.baseBranch : details.flow.baseBranch,
  }))
  .superRefine((details, context) => {
    if (details.worktreePath !== details.flow.worktreePath) {
      context.addIssue({
        code: 'custom',
        path: ['worktreePath'],
        message: 'O caminho do worktree nos detalhes deve corresponder ao do fluxo',
      });
    }
    if (details.branchName !== details.flow.branchName) {
      context.addIssue({
        code: 'custom',
        path: ['branchName'],
        message: 'O nome da branch nos detalhes deve corresponder ao do fluxo',
      });
    }
    if (details.baseBranch !== details.flow.baseBranch) {
      context.addIssue({
        code: 'custom',
        path: ['baseBranch'],
        message: 'A branch base nos detalhes deve corresponder à do fluxo',
      });
    }
  });
export type FactoryFlowDetails = z.infer<typeof FactoryFlowDetailsSchema>;

const HANDOFF_ARTIFACT_KINDS = {
  triage: 'specification',
  planning: 'plan',
  development: 'implementation_report',
  tests: 'test_report',
  review: 'review_report',
  pr: 'pr_summary',
} as const;

export function getReadyFactoryStageArtifact(
  details: {
    readonly stages: readonly FactoryFlowStage[];
    readonly artifacts: readonly FactoryFlowArtifact[];
  },
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

/** Retorna o artefato pronto mais recente de uma etapa (preservando histórico entre iterações). */
export function getLatestReadyFactoryStageArtifact(
  details: { readonly artifacts: readonly FactoryFlowArtifact[] },
  stage: keyof typeof HANDOFF_ARTIFACT_KINDS,
): FactoryFlowArtifact | undefined {
  for (let index = details.artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = details.artifacts[index];
    if (
      artifact &&
      artifact.stage === stage &&
      artifact.kind === HANDOFF_ARTIFACT_KINDS[stage] &&
      artifact.format === 'markdown' &&
      artifact.status === 'ready'
    ) {
      return artifact;
    }
  }
  return undefined;
}

export const TransitionFactoryFlowRequestSchema = z.strictObject({
  to: FactoryFlowStateSchema,
  stage: FactoryStageNameSchema.optional(),
  at: timestamp.optional(),
  reason: text,
  currentSessionId: id.nullable().optional(),
  iteration: z.number().int().nonnegative().optional(),
  lastReviewVerdict: FactoryReviewVerdictSchema.nullable().optional(),
  loopPausedReason: text.nullable().optional(),
  prReview: FactoryPrReviewSchema.nullable().optional(),
  prPublication: FactoryPrPublicationSchema.nullable().optional(),
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
  planningApproval: FactoryPlanningApprovalInputSchema.optional(),
  reviewTriage: FactoryReviewTriageInputSchema.optional(),
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
  reviewTriage: FactoryReviewTriageInputSchema.optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(300).optional(),
});
export type ReturnFactoryStageRequest = z.infer<typeof ReturnFactoryStageRequestSchema>;

export const RerunFactoryStageRequestSchema = z.strictObject({
  stage: FactoryStageNameSchema.optional(),
  approvedNotes: approvedNotesSchema.optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(300).optional(),
});
export type RerunFactoryStageRequest = z.infer<typeof RerunFactoryStageRequestSchema>;

export const CancelFactoryFlowRequestSchema = z.strictObject({
  reason: text.optional(),
  expectedUpdatedAt: timestamp.optional(),
  keepWorktree: z.boolean().optional(),
});
export type CancelFactoryFlowRequest = z.infer<typeof CancelFactoryFlowRequestSchema>;

export const RegisterFactoryFlowArtifactRequestSchema = z.strictObject({
  stage: FactoryStageNameSchema,
  sessionId: id.nullable().optional(),
  kind: FactoryFlowArtifactKindSchema,
  format: FactoryFlowArtifactFormatSchema.default('markdown'),
  path: artifactPathSchema,
  status: FactoryFlowArtifactStatusSchema.default('pending'),
  iteration: z.number().int().nonnegative().optional(),
  error: FactoryFlowErrorSchema.nullable().optional(),
  at: timestamp.optional(),
});
export type RegisterFactoryFlowArtifactRequest = z.infer<typeof RegisterFactoryFlowArtifactRequestSchema>;

export const UpdateFactoryFlowWorktreeRequestSchema = z.strictObject({
  worktreePath: absoluteWslPathSchema.nullable().optional(),
  branchName: gitBranchNameSchema.nullable().optional(),
  baseBranch: gitBranchNameSchema.nullable().optional(),
});
export type UpdateFactoryFlowWorktreeRequest = z.infer<typeof UpdateFactoryFlowWorktreeRequestSchema>;

export const RegisterFactoryFlowCheckpointRequestSchema = z.strictObject({
  stage: FactoryStageNameSchema,
  iteration: z.number().int().nonnegative().optional(),
  commitSha: gitCommitShaSchema,
  branchName: gitBranchNameSchema.nullable().optional(),
  sessionId: id.nullable().optional(),
  message: text.max(500).nullable().optional(),
  at: timestamp.optional(),
});
export type RegisterFactoryFlowCheckpointRequest = z.infer<
  typeof RegisterFactoryFlowCheckpointRequestSchema
>;

export const RollbackFactoryFlowCheckpointRequestSchema = z.strictObject({
  checkpointId: id.optional(),
  commitSha: gitCommitShaSchema.optional(),
  reason: text.optional(),
  expectedUpdatedAt: timestamp.optional(),
});
export type RollbackFactoryFlowCheckpointRequest = z.infer<
  typeof RollbackFactoryFlowCheckpointRequestSchema
>;

export const RollbackFactoryFlowCheckpointResponseSchema = z.strictObject({
  contractVersion: version,
  flow: FactoryFlowSchema,
  checkpoint: FactoryFlowCheckpointSchema,
  restoredCommitSha: gitCommitShaSchema,
});
export type RollbackFactoryFlowCheckpointResponse = z.infer<
  typeof RollbackFactoryFlowCheckpointResponseSchema
>;

export const SaveFactoryPrReviewResponseSchema = z.strictObject({
  contractVersion: version,
  flow: FactoryFlowSchema,
  prGate: FactoryPrGateSchema,
});
export type SaveFactoryPrReviewResponse = z.infer<typeof SaveFactoryPrReviewResponseSchema>;

export const PublishFactoryPrRequestSchema = z.strictObject({
  provider: FactoryPrProviderSchema.optional(),
  expectedUpdatedAt: timestamp.optional(),
});
export type PublishFactoryPrRequest = z.infer<typeof PublishFactoryPrRequestSchema>;

export const PublishFactoryPrResponseSchema = z.strictObject({
  contractVersion: version,
  flow: FactoryFlowSchema,
  prGate: FactoryPrGateSchema,
  publication: FactoryPrPublicationSchema,
});
export type PublishFactoryPrResponse = z.infer<typeof PublishFactoryPrResponseSchema>;

export const RetryFactoryPrJiraSyncRequestSchema = z.strictObject({
  expectedUpdatedAt: timestamp.optional(),
});
export type RetryFactoryPrJiraSyncRequest = z.infer<typeof RetryFactoryPrJiraSyncRequestSchema>;

export const RetryFactoryPrJiraSyncResponseSchema = z.strictObject({
  contractVersion: version,
  flow: FactoryFlowSchema,
  prGate: FactoryPrGateSchema,
  publication: FactoryPrPublicationSchema,
});
export type RetryFactoryPrJiraSyncResponse = z.infer<typeof RetryFactoryPrJiraSyncResponseSchema>;

export const FactoryFlowApiErrorCodeSchema = z.enum([
  'ORIGIN_FORBIDDEN',
  'FACTORY_FLOW_INVALID_INPUT',
  'FACTORY_FLOW_INVALID_TRANSITION',
  'FACTORY_FLOW_INVALID_STAGE_ADVANCE',
  'FACTORY_FLOW_INVALID_CONTRACT',
  'FACTORY_FLOW_NOT_FOUND',
  'FACTORY_FLOW_IDEMPOTENCY_CONFLICT',
  'FACTORY_FLOW_CONFLICT',
  'FACTORY_FLOW_SECRET_DETECTED',
  'FACTORY_FLOW_EXTERNAL_ERROR',
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
