import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock,
  Code2,
  Compass,
  FileText,
  FlaskConical,
  GitPullRequest,
  Loader2,
  RotateCcw,
  ScanSearch,
  Square,
  X,
} from 'lucide-react';
import {
  FACTORY_APPROVED_NOTES_MAX_LENGTH,
  FACTORY_STAGE_ORDER,
  getLatestReadyFactoryStageArtifact,
  getNextFactoryStage,
  getReadyFactoryStageArtifact,
  type FactoryFlow,
  type FactoryFlowArtifact,
  type FactoryFlowDetails,
  type FactoryFlowStage,
  type FactoryPlanningApprovalInput,
  type FactoryPlanningDecisionChoiceMode,
  type FactoryStageName,
  type FactoryStageState,
  type ReturnFactoryTargetStage,
} from '@development-factory/shared';
import type { BackgroundSessionSummary } from '@development-factory/shared';
import { fetchFactoryFlowDetails } from '../api/factory-flows';
import {
  getFactoryFlowStatePresentation,
  getFactoryReviewVerdictPresentation,
  getFactoryStageLabel,
  getFactoryStageStatePresentation,
  getFactoryStageStep,
} from '../utils/factory-flow-status';
import { FactoryFlowDetailTabs } from './FactoryFlowDetailTabs.js';
import type { FactoryFlowDetailTab } from './FactoryFlowDetailTabs.js';
import { FactoryFlowDiffPanel } from './FactoryFlowDiffPanel.js';
import { FactoryFlowIterationsPanel } from './FactoryFlowIterationsPanel.js';
import { FactoryLiveTerminalButton } from './FactoryLiveTerminalButton.js';
import {
  FactoryPlanningGatePanel,
  createPlanningGateDrafts,
  getNextAcceptanceCriterionId,
  type PlanningCriterionDraft,
  type PlanningDecisionDraft,
} from './FactoryPlanningGatePanel';
import { FactoryStageActivity } from './FactoryStageActivity.js';

interface FactoryFlowRoadmapModalProps {
  flow: FactoryFlow;
  runningSession?: BackgroundSessionSummary;
  initialDetails?: FactoryFlowDetails;
  onClose: () => void;
  onOpenFlowTerminal: (flowId: string) => boolean;
  onAdvanceFlowStage: (
    flowId: string,
    options?: {
      approvedNotes?: string;
      planningApproval?: FactoryPlanningApprovalInput;
    },
  ) => Promise<void>;
  onRerunFlowStage: (
    flowId: string,
    stage: FactoryStageName,
    approvedNotes?: string,
  ) => Promise<void>;
  onReturnFlowStage?: (
    flowId: string,
    targetStage: ReturnFactoryTargetStage,
    approvedNotes?: string,
  ) => Promise<void>;
  onCancelFlow?: (flowId: string) => Promise<void>;
  onViewMarkdown: (filePath: string) => void;
}

const VALIDATED_REPORT_KIND_BY_STAGE: Partial<Record<FactoryStageName, FactoryFlowArtifact['kind']>> = {
  development: 'implementation_report',
  tests: 'test_report',
  review: 'review_report',
  pr: 'pr_summary',
};

const roadmapStages = [
  {
    id: 'triage',
    step: '01',
    title: 'Triagem / Contexto',
    description: 'Conecte uma tarefa do JIRA ou título e gere o plano técnico inicial com o Claude Code.',
    icon: Compass,
  },
  {
    id: 'planning',
    step: '02',
    title: 'Planejamento',
    description: 'Refinamento dos critérios de aceite, escopo e arquitetura da solução.',
    icon: ClipboardList,
  },
  {
    id: 'development',
    step: '03',
    title: 'Desenvolvimento',
    description: 'Implementação assistida seguindo contratos, padrões e escopo definidos.',
    icon: Code2,
  },
  {
    id: 'tests',
    step: '04',
    title: 'Testes',
    description: 'Validação automatizada de fluxos, edge cases e regressões.',
    icon: FlaskConical,
  },
  {
    id: 'review',
    step: '05',
    title: 'Code Review',
    description: 'Análise crítica do diff, entorno e aderência aos requisitos.',
    icon: ScanSearch,
  },
  {
    id: 'pr',
    step: '06',
    title: 'PR',
    description: 'Preparação da entrega final para revisão e merge no repositório.',
    icon: GitPullRequest,
  },
] as const satisfies ReadonlyArray<{
  id: FactoryStageName;
  step: string;
  title: string;
  description: string;
  icon: typeof Compass;
}>;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function inferStageState(flow: FactoryFlow, stageName: FactoryStageName): FactoryStageState {
  const currentIndex = FACTORY_STAGE_ORDER.indexOf(flow.currentStage);
  const stageIndex = FACTORY_STAGE_ORDER.indexOf(stageName);

  if (stageIndex < currentIndex) {
    return 'completed';
  }
  if (stageIndex > currentIndex) {
    return 'pending';
  }

  switch (flow.state) {
    case 'queued':
    case 'running':
      return 'running';
    case 'waiting_action':
      return 'waiting_action';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function getStageCardClasses(state: FactoryStageState, isCurrent: boolean): string {
  if (state === 'running') {
    return 'border-accent bg-selected/60 shadow-lg shadow-black/10';
  }
  if (state === 'waiting_action') {
    return 'border-warning/50 bg-selected/30 shadow-md shadow-black/5';
  }
  if (state === 'failed') {
    return 'border-danger/50 bg-surface';
  }
  if (state === 'completed') {
    return isCurrent ? 'border-accent/60 bg-selected/40' : 'border-accent/30 bg-surface';
  }
  if (isCurrent) {
    return 'border-accent/40 bg-surface';
  }
  return 'border-line bg-surface/70 opacity-85';
}

function renderStageIconBadge(
  state: FactoryStageState,
  StageIcon: typeof Compass,
  isCurrent: boolean,
) {
  if (state === 'running') {
    return (
      <span className="grid size-9 place-items-center rounded-xl bg-accent text-on-accent">
        <Loader2 size={17} className="animate-spin" />
      </span>
    );
  }
  if (state === 'completed') {
    return (
      <span className="grid size-9 place-items-center rounded-xl bg-accent/15 text-accent">
        <CheckCircle2 size={17} />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="grid size-9 place-items-center rounded-xl bg-danger/15 text-danger">
        <AlertCircle size={17} />
      </span>
    );
  }
  if (state === 'waiting_action') {
    return (
      <span className="grid size-9 place-items-center rounded-xl bg-warning/15 text-warning">
        <Clock size={17} />
      </span>
    );
  }
  return (
    <span
      className={`grid size-9 place-items-center rounded-xl border ${
        isCurrent ? 'border-accent/40 bg-selected text-accent' : 'border-line bg-page text-muted'
      }`}
    >
      <StageIcon size={17} />
    </span>
  );
}

export function FactoryFlowRoadmapModal({
  flow,
  runningSession,
  initialDetails,
  onClose,
  onOpenFlowTerminal,
  onAdvanceFlowStage,
  onRerunFlowStage,
  onReturnFlowStage,
  onCancelFlow,
  onViewMarkdown,
}: FactoryFlowRoadmapModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const tabId = useId();
  const [activeTab, setActiveTab] = useState<FactoryFlowDetailTab>('roadmap');
  const [details, setDetails] = useState<FactoryFlowDetails | null>(initialDetails ?? null);
  const [loadingDetails, setLoadingDetails] = useState(initialDetails === undefined);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsRefreshTick, setDetailsRefreshTick] = useState(0);
  const [busyAction, setBusyAction] = useState<'advance' | 'rerun' | 'return' | 'cancel' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [approvedNotes, setApprovedNotes] = useState('');
  const initialPlanningReport =
    initialDetails?.flow.id === flow.id
      ? getReadyFactoryStageArtifact(initialDetails, 'planning')
      : undefined;
  const initialPlanningKey =
    initialDetails?.flow.id === flow.id
      ? `${initialDetails.flow.id}:${initialPlanningReport?.id ?? 'none'}:${initialDetails.flow.planningApproval?.approvedAt ?? 'unapproved'}`
      : '';
  const initialDrafts = createPlanningGateDrafts(
    initialDetails?.flow.id === flow.id ? (initialDetails.planningGate ?? undefined) : undefined,
    initialDetails?.flow.id === flow.id ? initialDetails.flow.planningApproval : undefined,
  );
  const [syncedPlanningKey, setSyncedPlanningKey] = useState(initialPlanningKey);
  const [planningDecisions, setPlanningDecisions] = useState<PlanningDecisionDraft[]>(
    initialDrafts.decisions,
  );
  const [planningCriteria, setPlanningCriteria] = useState<PlanningCriterionDraft[]>(
    initialDrafts.criteria,
  );
  const [planningNotes, setPlanningNotes] = useState(initialDrafts.notes);
  const [planningValidationError, setPlanningValidationError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingDetails(true);
    setDetailsError(null);

    fetchFactoryFlowDetails(flow.id, controller.signal)
      .then(loaded => {
        if (!controller.signal.aborted) {
          setDetails(loaded);
          setLoadingDetails(false);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }
        setDetailsError(
          error instanceof Error
            ? error.message
            : 'Não foi possível carregar os detalhes do fluxo.',
        );
        setLoadingDetails(false);
      });

    return () => {
      controller.abort();
    };
  }, [flow.id, flow.updatedAt, detailsRefreshTick]);

  const runAction = useCallback(
    async (
      action: 'advance' | 'rerun' | 'return' | 'cancel',
      operation: () => Promise<void>,
      fallbackError: string,
      clearNotes = false,
    ) => {
      if (busyAction !== null) {
        return;
      }

      setActionError(null);
      setBusyAction(action);
      try {
        await operation();
        if (clearNotes) {
          setApprovedNotes('');
        }
        setDetailsRefreshTick(tick => tick + 1);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : fallbackError);
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction],
  );

  const currentDetails = details?.flow.id === flow.id ? details : null;

  const stagesByName = useMemo(() => {
    const map = new Map<FactoryStageName, FactoryFlowStage>();
    if (!currentDetails) {
      return map;
    }
    for (const stage of currentDetails.stages) {
      map.set(stage.name, stage);
    }
    return map;
  }, [currentDetails]);

  const artifactsByStage = useMemo(() => {
    const map = new Map<FactoryStageName, FactoryFlowArtifact[]>();
    if (!currentDetails) {
      return map;
    }
    for (const artifact of currentDetails.artifacts) {
      const existing = map.get(artifact.stage);
      if (existing) {
        existing.push(artifact);
      } else {
        map.set(artifact.stage, [artifact]);
      }
    }
    return map;
  }, [currentDetails]);

  const triageReport = currentDetails
    ? getReadyFactoryStageArtifact(currentDetails, 'triage')
    : undefined;
  const planningReport = currentDetails
    ? getReadyFactoryStageArtifact(currentDetails, 'planning')
    : undefined;
  const developmentReport = currentDetails
    ? getReadyFactoryStageArtifact(currentDetails, 'development')
    : undefined;
  const testsReport = currentDetails
    ? getReadyFactoryStageArtifact(currentDetails, 'tests')
    : undefined;
  const reviewReport = currentDetails
    ? getReadyFactoryStageArtifact(currentDetails, 'review')
    : undefined;
  const prReport = currentDetails
    ? getReadyFactoryStageArtifact(currentDetails, 'pr')
    : undefined;

  const latestDevelopmentReport = currentDetails
    ? getLatestReadyFactoryStageArtifact(currentDetails, 'development')
    : undefined;
  const latestTestsReport = currentDetails
    ? getLatestReadyFactoryStageArtifact(currentDetails, 'tests')
    : undefined;
  const latestReviewReport = currentDetails
    ? getLatestReadyFactoryStageArtifact(currentDetails, 'review')
    : undefined;

  const planningDraftSourceKey = currentDetails
    ? `${currentDetails.flow.id}:${planningReport?.id ?? 'none'}:${currentDetails.flow.planningApproval?.approvedAt ?? 'unapproved'}`
    : '';
  const persistedPlanningApproval =
    currentDetails?.flow.planningApproval ?? flow.planningApproval ?? null;

  useEffect(() => {
    if (!planningDraftSourceKey || planningDraftSourceKey === syncedPlanningKey) {
      return;
    }
    const nextDrafts = createPlanningGateDrafts(
      currentDetails?.planningGate ?? undefined,
      currentDetails?.flow.planningApproval,
    );
    setPlanningDecisions(nextDrafts.decisions);
    setPlanningCriteria(nextDrafts.criteria);
    setPlanningNotes(nextDrafts.notes);
    setPlanningValidationError(null);
    setSyncedPlanningKey(planningDraftSourceKey);
  }, [currentDetails, planningDraftSourceKey, syncedPlanningKey]);

  const handleDecisionModeChange = useCallback(
    (index: number, mode: FactoryPlanningDecisionChoiceMode, selectedOption: string) => {
      setPlanningValidationError(null);
      setPlanningDecisions(current =>
        current.map((item, itemIndex) =>
          itemIndex === index ? { ...item, mode, selectedOption } : item,
        ),
      );
    },
    [],
  );

  const handleDecisionCustomTextChange = useCallback((index: number, customText: string) => {
    setPlanningValidationError(null);
    setPlanningDecisions(current =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, customText } : item,
      ),
    );
  }, []);

  const handleCriterionToggle = useCallback((index: number, approved: boolean) => {
    setPlanningValidationError(null);
    setPlanningCriteria(current =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, approved } : item)),
    );
  }, []);

  const handleCriterionDescriptionChange = useCallback((index: number, description: string) => {
    setPlanningValidationError(null);
    setPlanningCriteria(current =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, description } : item)),
    );
  }, []);

  const handleAddCriterion = useCallback(() => {
    setPlanningValidationError(null);
    setPlanningCriteria(current => [
      ...current,
      {
        id: getNextAcceptanceCriterionId(current),
        description: '',
        approved: true,
        isCustom: true,
      },
    ]);
  }, []);

  const handleRemoveCriterion = useCallback((index: number) => {
    setPlanningValidationError(null);
    setPlanningCriteria(current => current.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const buildPlanningApprovalPayload = useCallback((): FactoryPlanningApprovalInput | null => {
    for (const decision of planningDecisions) {
      if (decision.mode === 'custom' && decision.customText.trim().length === 0) {
        setPlanningValidationError(`Informe a decisão customizada para ${decision.id}.`);
        return null;
      }
    }

    const normalizedCriteria: FactoryPlanningApprovalInput['acceptanceCriteria'] = [];
    for (const criterion of planningCriteria) {
      const description = criterion.description.trim();
      if (description.length === 0) {
        if (criterion.approved) {
          setPlanningValidationError(`Informe a descrição do critério ${criterion.id}.`);
          return null;
        }
        if (criterion.isCustom) {
          continue;
        }
        setPlanningValidationError(`Informe a descrição do critério ${criterion.id}.`);
        return null;
      }
      normalizedCriteria.push({
        id: criterion.id,
        description,
        approved: criterion.approved,
      });
    }

    const trimmedNotes = planningNotes.trim();
    return {
      decisions: planningDecisions.map(decision => ({
        id: decision.id,
        question: decision.question,
        mode: decision.mode,
        selectedOption:
          decision.mode === 'custom' ? decision.customText.trim() : decision.selectedOption,
        recommendedOption: decision.recommendedOption,
        ...(decision.mode !== 'custom' && decision.customText.trim().length > 0
          ? { customNote: decision.customText.trim() }
          : {}),
      })),
      acceptanceCriteria: normalizedCriteria,
      ...(trimmedNotes.length > 0 ? { notes: trimmedNotes } : {}),
    };
  }, [planningCriteria, planningDecisions, planningNotes]);

  const canStartDevelopment = Boolean(triageReport && planningReport);
  const canStartTests = Boolean(canStartDevelopment && developmentReport);
  const canStartReview = Boolean(canStartTests && testsReport);
  const canAdvanceToPr = Boolean(canStartReview && reviewReport);
  const validatedReports: Partial<Record<FactoryStageName, FactoryFlowArtifact | undefined>> = {
    development: latestDevelopmentReport ?? developmentReport,
    tests: latestTestsReport ?? testsReport,
    review: latestReviewReport ?? reviewReport,
    pr: prReport,
  };
  const flowPresentation = getFactoryFlowStatePresentation(flow.state);
  const reviewVerdictPresentation = flow.lastReviewVerdict
    ? getFactoryReviewVerdictPresentation(flow.lastReviewVerdict)
    : null;

  function closeRoadmap() {
    dialogRef.current?.close();
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      onCancel={event => {
        event.preventDefault();
        closeRoadmap();
      }}
      aria-labelledby="flow-roadmap-title"
      className="m-auto max-h-[90dvh] w-[calc(100%-1rem)] max-w-6xl overflow-hidden rounded-2xl border border-line-strong bg-surface p-0 text-primary shadow-2xl sm:w-[calc(100%-3rem)]"
    >
      <div className="flex max-h-[90dvh] min-h-0 flex-col">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-selected px-2 py-0.5 font-mono text-[10px] font-medium text-accent">
                <Compass size={11} />
                Roadmap do fluxo
              </span>
              <span className="font-mono text-[11px] text-muted">
                Etapa atual:{' '}
                <strong className="font-medium text-accent">
                  {getFactoryStageStep(flow.currentStage)} ·{' '}
                  {getFactoryStageLabel(flow.currentStage)}
                </strong>
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-page px-2.5 py-0.5 text-[10px] font-medium ${flowPresentation.textClass}`}
              >
                <span className={`size-1.5 rounded-full ${flowPresentation.dotClass}`} />
                {flowPresentation.label}
              </span>
              {flow.iteration > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-selected px-2.5 py-0.5 font-mono text-[10px] font-medium text-accent">
                  Iteração {flow.iteration}/{flow.maxIterations}
                </span>
              )}
              {reviewVerdictPresentation && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-page px-2.5 py-0.5 text-[10px] font-medium ${reviewVerdictPresentation.textClass}`}
                >
                  <span className={`size-1.5 rounded-full ${reviewVerdictPresentation.dotClass}`} />
                  Review: {reviewVerdictPresentation.label}
                </span>
              )}
              {loadingDetails && (
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
                  <Loader2 size={12} className="animate-spin text-accent" />
                  Atualizando...
                </span>
              )}
            </div>
            <h2 id="flow-roadmap-title" className="mt-2 truncate text-base font-semibold text-primary">
              {flow.title}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
              {flow.target.value} · {flow.target.repoPath}
            </p>
          </div>

          <button
            type="button"
            className="modal-button"
            onClick={closeRoadmap}
            aria-label="Fechar roadmap do fluxo"
          >
            <X size={17} />
          </button>
        </header>

        <FactoryFlowDetailTabs id={tabId} selected={activeTab} onSelect={setActiveTab} />

        <div
          id={`${tabId}-roadmap-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-roadmap-tab`}
          tabIndex={0}
          hidden={activeTab !== 'roadmap'}
          className="min-h-0 flex-1 overflow-y-auto bg-page p-5 sm:p-6"
        >
          {flow.loopPausedReason && (
            <div
              role="alert"
              className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-warning"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <AlertTriangle size={15} className="shrink-0" />
                <span>{flow.loopPausedReason}</span>
              </span>
              {flow.state === 'waiting_action' && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  aria-busy={busyAction === 'rerun'}
                  onClick={() => {
                    void runAction(
                      'rerun',
                      () => onRerunFlowStage(flow.id, flow.currentStage),
                      'Não foi possível retomar a etapa.',
                    );
                  }}
                  className="modal-button shrink-0 border-warning/40 bg-surface px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning/15 disabled:opacity-60"
                >
                  {busyAction === 'rerun' ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <RotateCcw size={11} />
                  )}
                  {busyAction === 'rerun' ? 'Retomando...' : 'Retomar etapa'}
                </button>
              )}
            </div>
          )}

          {flow.error && (
            <div
              role="alert"
              className="mb-5 flex items-center gap-2 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-xs text-danger"
            >
              <AlertCircle size={15} className="shrink-0" />
              <span>{flow.error.message}</span>
            </div>
          )}

          {(actionError || detailsError) && (
            <div
              role="alert"
              className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-xs text-danger"
            >
              <span className="flex items-center gap-2">
                <AlertCircle size={15} className="shrink-0" />
                {actionError ?? detailsError}
              </span>
              {detailsError && (
                <button
                  type="button"
                  onClick={() => setDetailsRefreshTick(tick => tick + 1)}
                  className="rounded-md border border-danger/40 px-2.5 py-1 text-[11px] font-medium hover:bg-danger/15"
                >
                  Tentar novamente
                </button>
              )}
            </div>
          )}

          <ol className="space-y-4">
            {[roadmapStages.slice(0, 3), roadmapStages.slice(3, 6)].map((row, rowIndex) => (
              <Fragment key={rowIndex}>
                <li className="list-none">
                  <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
                    {row.map((stage, indexInRow) => {
                      const Icon = stage.icon;
                      const isLastInRow = indexInRow === row.length - 1;
                      const stageRecord = stagesByName.get(stage.id);
                      const stageState: FactoryStageState =
                        stageRecord?.state ?? inferStageState(flow, stage.id);
                      const isCurrentStage = flow.currentStage === stage.id;
                      const stagePresentation = getFactoryStageStatePresentation(stageState);
                      const stageArtifacts = artifactsByStage.get(stage.id) ?? [];
                      const stageReportHistory = stageArtifacts.filter(
                        item =>
                          item.kind !== 'session_log' &&
                          item.format === 'markdown' &&
                          item.status !== 'failed',
                      );
                      const validatedKind = VALIDATED_REPORT_KIND_BY_STAGE[stage.id];
                      const stageMarkdownPath = validatedKind
                        ? validatedReports[stage.id]?.path
                        : (stageRecord?.reportPath ?? stageReportHistory[0]?.path);
                      const stageArtifactError = validatedKind
                        ? stageArtifacts.find(
                            artifact =>
                              artifact.kind === validatedKind &&
                              artifact.path === stageRecord?.reportPath,
                          )?.error
                        : undefined;
                      const canTriggerManualPr =
                        isCurrentStage &&
                        stage.id === 'pr' &&
                        flow.state === 'waiting_action';
                      const canRerunCurrent =
                        isCurrentStage &&
                        stage.id !== 'pr' &&
                        flow.state === 'waiting_action';
                      const nextStage = getNextFactoryStage(stage.id);
                      const canAdvanceCurrent =
                        canRerunCurrent &&
                        nextStage !== null &&
                        (nextStage !== 'development' || canStartDevelopment) &&
                        (nextStage !== 'tests' || canStartTests) &&
                        (nextStage !== 'review' || canStartReview) &&
                        (nextStage !== 'pr' || canAdvanceToPr);
                      const canReturnFromReview = Boolean(
                        isCurrentStage &&
                        stage.id === 'review' &&
                        flow.state === 'waiting_action' &&
                        onReturnFlowStage &&
                        canStartDevelopment,
                      );
                      const isTriageWaitingAction =
                        stage.id === 'triage' &&
                        isCurrentStage &&
                        flow.state === 'waiting_action';
                      const triageGate =
                        stage.id === 'triage' && isCurrentStage
                          ? currentDetails?.triageGate
                          : undefined;
                      const isTriageGateBlocked = Boolean(triageGate?.blocked);
                      const hasTriageComplement =
                        stage.id === 'triage' && approvedNotes.trim().length > 0;
                      const isPlanningGateEditable =
                        stage.id === 'planning' &&
                        canAdvanceCurrent &&
                        nextStage === 'development';
                      const acceptsApprovedNotes =
                        isTriageWaitingAction ||
                        (canAdvanceCurrent &&
                          (nextStage === 'planning' ||
                            nextStage === 'tests' ||
                            nextStage === 'review')) ||
                        canReturnFromReview;
                      const canStopCurrent =
                        isCurrentStage && flow.state === 'running' && Boolean(onCancelFlow);
                      const stageSession = isCurrentStage ? runningSession : undefined;

                      return (
                        <Fragment key={stage.id}>
                          <div
                            className={`flex h-full flex-col justify-between rounded-2xl border p-5 transition ${getStageCardClasses(
                              stageState,
                              isCurrentStage,
                            )}`}
                          >
                            <div>
                              <div className="flex items-center justify-between gap-2">
                                {renderStageIconBadge(stageState, Icon, isCurrentStage)}
                                <span
                                  className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-page px-2.5 py-0.5 font-mono text-[10px] ${stagePresentation.textClass}`}
                                >
                                  <span
                                    className={`size-1.5 rounded-full ${stagePresentation.dotClass}`}
                                  />
                                  {stagePresentation.label}
                                </span>
                              </div>

                              <p className="mt-4 font-mono text-[10px] uppercase tracking-wider text-accent">
                                Etapa {stage.step}
                                {isCurrentStage ? ' · Atual' : ''}
                              </p>
                              <h3 className="mt-1 text-sm font-semibold text-primary">
                                {stage.title}
                              </h3>
                              <p className="mt-2 text-xs leading-5 text-muted">
                                {stage.description}
                              </p>
                              {stageSession && (
                                <div className="mt-3">
                                  <FactoryStageActivity
                                    key={stageSession.sessionId}
                                    session={stageSession}
                                  />
                                </div>
                              )}

                              {isTriageGateBlocked && triageGate && (
                                <div
                                  role="region"
                                  aria-label="Bloqueadores e falhas de triagem"
                                  className="mt-3 space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-primary"
                                >
                                  <p className="flex items-center gap-1.5 font-semibold text-warning">
                                    <AlertTriangle size={13} className="shrink-0" />
                                    Portão humano · Ação necessária
                                  </p>
                                  {triageGate.jiraError && (
                                    <div className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] text-danger">
                                      <p className="font-semibold">Falha na consulta ao Jira MCP</p>
                                      <p className="mt-0.5">{triageGate.jiraError}</p>
                                    </div>
                                  )}
                                  {triageGate.blockers.length > 0 && (
                                    <div>
                                      <p className="text-[11px] font-medium text-secondary">
                                        Bloqueadores e ambiguidades identificados:
                                      </p>
                                      <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] leading-4 text-primary">
                                        {triageGate.blockers.map((blocker, index) => (
                                          <li key={`${index}-${blocker}`}>{blocker}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              )}

                              {isCurrentStage &&
                                stage.id === 'triage' &&
                                stageRecord?.approvedNotes && (
                                  <div className="mt-3 rounded-lg border border-line bg-page px-2.5 py-2 text-[11px] text-secondary">
                                    <p className="font-medium text-primary">
                                      Complemento enviado anteriormente
                                    </p>
                                    <p className="mt-0.5 whitespace-pre-wrap break-words">
                                      {stageRecord.approvedNotes}
                                    </p>
                                  </div>
                                )}

                              {stage.id === 'planning' &&
                                !isPlanningGateEditable &&
                                persistedPlanningApproval && (
                                  <FactoryPlanningGatePanel
                                    editable={false}
                                    approval={persistedPlanningApproval}
                                  />
                                )}

                              {(stageRecord?.error ?? stageArtifactError) && (
                                <p className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
                                  {(stageRecord?.error ?? stageArtifactError)?.message}
                                </p>
                              )}
                              {stage.id === 'pr' &&
                                isCurrentStage &&
                                flow.state === 'waiting_action' && (
                                  <p className="mt-2 text-xs text-muted">
                                    Code Review aprovado. Dispare manualmente a preparação/abertura
                                    do Pull Request quando desejar.
                                  </p>
                                )}
                            </div>

                            {(stageMarkdownPath ||
                              stageReportHistory.length > 0 ||
                              canTriggerManualPr ||
                              canRerunCurrent ||
                              canAdvanceCurrent ||
                              canReturnFromReview ||
                              stageSession ||
                              canStopCurrent) && (
                              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
                                {stageSession && (
                                  <FactoryLiveTerminalButton
                                    key={stageSession.sessionId}
                                    title={flow.title}
                                    onOpen={() => onOpenFlowTerminal(flow.id)}
                                    onOpened={closeRoadmap}
                                  />
                                )}
                                {stageMarkdownPath && (
                                  <button
                                    type="button"
                                    onClick={() => onViewMarkdown(stageMarkdownPath)}
                                    className="modal-button border-accent/35 px-2.5 py-1 text-[11px] text-accent hover:bg-selected"
                                  >
                                    <FileText size={11} />
                                    Ver artefato
                                  </button>
                                )}

                                {stageReportHistory.length > 1 && (
                                  <div
                                    className="flex w-full flex-wrap items-center gap-1.5"
                                    aria-label={`Histórico de ciclos da etapa ${stage.title}`}
                                  >
                                    {stageReportHistory.map((artifact, artifactIndex) => (
                                      <button
                                        key={artifact.id}
                                        type="button"
                                        onClick={() => onViewMarkdown(artifact.path)}
                                        className={`rounded-md border px-2 py-0.5 font-mono text-[10px] transition ${
                                          artifact.status === 'ready'
                                            ? 'border-accent/30 bg-page text-accent hover:bg-selected'
                                            : 'border-warning/30 bg-page text-warning hover:bg-warning/10'
                                        }`}
                                      >
                                        {artifact.iteration > 0
                                          ? `Ciclo ${artifact.iteration}`
                                          : `Execução ${artifactIndex + 1}`}
                                      </button>
                                    ))}
                                  </div>
                                )}

                                {canTriggerManualPr && (
                                  <button
                                    type="button"
                                    disabled={busyAction !== null}
                                    aria-busy={busyAction === 'rerun'}
                                    onClick={() => {
                                      void runAction(
                                        'rerun',
                                        () => onRerunFlowStage(flow.id, 'pr'),
                                        'Não foi possível executar a etapa PR.',
                                      );
                                    }}
                                    className="modal-button border-accent/40 bg-selected/60 px-2.5 py-1 text-[11px] text-accent hover:bg-selected disabled:opacity-60"
                                  >
                                    {busyAction === 'rerun' ? (
                                      <Loader2 size={11} className="animate-spin" />
                                    ) : (
                                      <GitPullRequest size={11} />
                                    )}
                                    Executar etapa PR
                                  </button>
                                )}

                                {canRerunCurrent && (
                                  <button
                                    type="button"
                                    disabled={busyAction !== null}
                                    aria-busy={busyAction === 'rerun'}
                                    onClick={() => {
                                      void runAction(
                                        'rerun',
                                        () =>
                                          onRerunFlowStage(
                                            flow.id,
                                            stage.id,
                                            hasTriageComplement ? approvedNotes.trim() : undefined,
                                          ),
                                        'Não foi possível reexecutar a etapa.',
                                        hasTriageComplement,
                                      );
                                    }}
                                    className="modal-button px-2.5 py-1 text-[11px] disabled:opacity-60"
                                  >
                                    {busyAction === 'rerun' ? (
                                      <Loader2 size={11} className="animate-spin" />
                                    ) : (
                                      <RotateCcw size={11} />
                                    )}
                                    {hasTriageComplement
                                      ? 'Reexecutar com complemento'
                                      : 'Reexecutar'}
                                  </button>
                                )}

                                {isPlanningGateEditable && (
                                  <FactoryPlanningGatePanel
                                    editable
                                    decisions={planningDecisions}
                                    criteria={planningCriteria}
                                    notes={planningNotes}
                                    validationError={planningValidationError}
                                    disabled={busyAction !== null}
                                    onDecisionModeChange={handleDecisionModeChange}
                                    onDecisionCustomTextChange={handleDecisionCustomTextChange}
                                    onCriterionToggle={handleCriterionToggle}
                                    onCriterionDescriptionChange={handleCriterionDescriptionChange}
                                    onAddCriterion={handleAddCriterion}
                                    onRemoveCriterion={handleRemoveCriterion}
                                    onNotesChange={value => {
                                      setPlanningValidationError(null);
                                      setPlanningNotes(value);
                                    }}
                                  />
                                )}

                                {acceptsApprovedNotes && (
                                  <label className="grid w-full gap-1 text-xs text-primary">
                                    {stage.id === 'triage'
                                      ? 'Respostas aos bloqueadores / Complemento de contexto'
                                      : 'Notas / Decisões Aprovadas (opcional)'}
                                    <textarea
                                      value={approvedNotes}
                                      rows={3}
                                      maxLength={FACTORY_APPROVED_NOTES_MAX_LENGTH}
                                      disabled={busyAction !== null}
                                      placeholder={
                                        stage.id === 'triage'
                                          ? 'Responda às dúvidas acima, cole o conteúdo da task do Jira ou adicione contexto complementar...'
                                          : undefined
                                      }
                                      onChange={event => setApprovedNotes(event.target.value)}
                                      className="rounded-lg border border-line bg-page p-2 text-xs focus-visible:outline-2 focus-visible:outline-accent"
                                    />
                                  </label>
                                )}

                                {canReturnFromReview && onReturnFlowStage && (
                                  <>
                                    <button
                                      type="button"
                                      disabled={busyAction !== null}
                                      aria-busy={busyAction === 'return'}
                                      onClick={() => {
                                        void runAction(
                                          'return',
                                          () =>
                                            onReturnFlowStage(
                                              flow.id,
                                              'development',
                                              approvedNotes.trim() || undefined,
                                            ),
                                          'Não foi possível retornar para Desenvolvimento.',
                                          true,
                                        );
                                      }}
                                      className="modal-button border-warning/40 px-2.5 py-1 text-[11px] text-warning hover:bg-warning/10 disabled:opacity-60"
                                    >
                                      {busyAction === 'return' ? (
                                        <Loader2 size={11} className="animate-spin" />
                                      ) : (
                                        <RotateCcw size={11} />
                                      )}
                                      Retornar para Desenvolvimento
                                    </button>
                                    {canStartTests && (
                                      <button
                                        type="button"
                                        disabled={busyAction !== null}
                                        aria-busy={busyAction === 'return'}
                                        onClick={() => {
                                          void runAction(
                                            'return',
                                            () =>
                                              onReturnFlowStage(
                                                flow.id,
                                                'tests',
                                                approvedNotes.trim() || undefined,
                                              ),
                                            'Não foi possível retornar para Testes.',
                                            true,
                                          );
                                        }}
                                        className="modal-button border-warning/40 px-2.5 py-1 text-[11px] text-warning hover:bg-warning/10 disabled:opacity-60"
                                      >
                                        {busyAction === 'return' ? (
                                          <Loader2 size={11} className="animate-spin" />
                                        ) : (
                                          <RotateCcw size={11} />
                                        )}
                                        Retornar para Testes
                                      </button>
                                    )}
                                  </>
                                )}

                                {canAdvanceCurrent && nextStage && (
                                  <button
                                    type="button"
                                    disabled={busyAction !== null}
                                    aria-busy={busyAction === 'advance'}
                                    onClick={() => {
                                      if (isPlanningGateEditable) {
                                        const planningApproval = buildPlanningApprovalPayload();
                                        if (!planningApproval) {
                                          return;
                                        }
                                        void runAction(
                                          'advance',
                                          () =>
                                            onAdvanceFlowStage(flow.id, {
                                              planningApproval,
                                              ...(planningApproval.notes
                                                ? { approvedNotes: planningApproval.notes }
                                                : {}),
                                            }),
                                          'Não foi possível aprovar o planejamento e iniciar o desenvolvimento.',
                                        );
                                        return;
                                      }
                                      const shouldPassNotes =
                                        nextStage === 'planning' ||
                                        nextStage === 'tests' ||
                                        nextStage === 'review';
                                      void runAction(
                                        'advance',
                                        () =>
                                          onAdvanceFlowStage(
                                            flow.id,
                                            shouldPassNotes
                                              ? {
                                                  approvedNotes:
                                                    approvedNotes.trim() || undefined,
                                                }
                                              : undefined,
                                          ),
                                        'Não foi possível avançar a etapa.',
                                        shouldPassNotes,
                                      );
                                    }}
                                    className="modal-button border-accent/40 bg-selected/60 px-2.5 py-1 text-[11px] text-accent hover:bg-selected disabled:opacity-60"
                                  >
                                    {busyAction === 'advance' ? (
                                      <Loader2 size={11} className="animate-spin" />
                                    ) : (
                                      <ArrowRight size={11} />
                                    )}
                                    {stage.id === 'planning' && nextStage === 'development'
                                      ? 'Aprovar e Iniciar Desenvolvimento'
                                      : isTriageGateBlocked && approvedNotes.trim().length > 0
                                        ? 'Enviar respostas e avançar'
                                        : `Avançar para ${getFactoryStageLabel(nextStage)}`}
                                  </button>
                                )}

                                {canStopCurrent && onCancelFlow && (
                                  <button
                                    type="button"
                                    disabled={busyAction !== null}
                                    aria-busy={busyAction === 'cancel'}
                                    aria-label={`Parar fluxo ${flow.title}`}
                                    onClick={() => {
                                      void runAction(
                                        'cancel',
                                        () => onCancelFlow(flow.id),
                                        'Não foi possível parar o fluxo.',
                                      );
                                    }}
                                    className="modal-button border-danger/35 px-2.5 py-1 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-60"
                                  >
                                    {busyAction === 'cancel' ? (
                                      <Loader2 size={11} className="animate-spin" />
                                    ) : (
                                      <Square size={11} />
                                    )}
                                    {busyAction === 'cancel' ? 'Parando...' : 'Parar'}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>

                          {!isLastInRow && (
                            <div
                              aria-hidden="true"
                              className="flex items-center justify-center text-muted"
                            >
                              <ArrowRight size={16} className="hidden lg:block" />
                              <ArrowDown size={16} className="block lg:hidden" />
                            </div>
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                </li>

                {rowIndex === 0 && (
                  <li
                    aria-hidden="true"
                    className="flex items-center justify-center gap-3 py-1 text-muted"
                  >
                    <span className="h-px flex-1 bg-line-subtle" />
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 font-mono text-[10px] text-muted">
                      <ArrowDown size={12} className="text-accent" />
                      {flow.iteration > 0
                        ? `Loop autônomo · Iteração ${flow.iteration}/${flow.maxIterations}`
                        : 'Próxima fase (03 → 04)'}
                    </span>
                    <span className="h-px flex-1 bg-line-subtle" />
                  </li>
                )}
              </Fragment>
            ))}
          </ol>
        </div>

        <div
          id={`${tabId}-diff-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-diff-tab`}
          tabIndex={0}
          hidden={activeTab !== 'diff'}
          className="min-h-0 flex-1 overflow-y-auto bg-page p-5 sm:p-6"
        >
          {activeTab === 'diff' && (flow.worktreePath ? (
            <FactoryFlowDiffPanel
              key={flow.id}
              flowId={flow.id}
              baseBranch={flow.baseBranch}
              updatedAt={flow.updatedAt}
            />
          ) : (
            <p className="text-sm text-muted">O worktree isolado deste fluxo está indisponível.</p>
          ))}
        </div>

        <div
          id={`${tabId}-iterations-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-iterations-tab`}
          tabIndex={0}
          hidden={activeTab !== 'iterations'}
          className="min-h-0 flex-1 overflow-y-auto bg-page p-5 sm:p-6"
        >
          {activeTab === 'iterations' && currentDetails && (
            <FactoryFlowIterationsPanel key={flow.id} flow={flow} details={currentDetails} />
          )}
          {activeTab === 'iterations' && !currentDetails && loadingDetails && (
            <p role="status" className="text-xs text-muted">Carregando histórico do fluxo…</p>
          )}
          {activeTab === 'iterations' && !currentDetails && detailsError && (
            <div className="space-y-2">
              <p role="alert" className="text-xs text-danger">{detailsError}</p>
              <button
                type="button"
                className="modal-button"
                onClick={() => setDetailsRefreshTick(tick => tick + 1)}
              >
                Tentar novamente
              </button>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
