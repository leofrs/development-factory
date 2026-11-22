import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type FactoryStageName,
  type FactoryStageState,
  type ReturnFactoryTargetStage,
} from '@development-factory/shared';
import { fetchFactoryFlowDetails } from '../api/factory-flows';
import {
  getFactoryFlowStatePresentation,
  getFactoryReviewVerdictPresentation,
  getFactoryStageLabel,
  getFactoryStageStatePresentation,
  getFactoryStageStep,
} from '../utils/factory-flow-status';

interface FactoryFlowRoadmapModalProps {
  flow: FactoryFlow;
  onClose: () => void;
  onAdvanceFlowStage: (flowId: string, approvedNotes?: string) => Promise<void>;
  onRerunFlowStage: (flowId: string, stage: FactoryStageName) => Promise<void>;
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
  onClose,
  onAdvanceFlowStage,
  onRerunFlowStage,
  onReturnFlowStage,
  onCancelFlow,
  onViewMarkdown,
}: FactoryFlowRoadmapModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [details, setDetails] = useState<FactoryFlowDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(true);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsRefreshTick, setDetailsRefreshTick] = useState(0);
  const [busyAction, setBusyAction] = useState<'advance' | 'rerun' | 'return' | 'cancel' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [approvedNotes, setApprovedNotes] = useState('');

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

  return (
    <dialog
      ref={dialogRef}
      onCancel={event => {
        event.preventDefault();
        onClose();
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
            onClick={onClose}
            aria-label="Fechar roadmap do fluxo"
          >
            <X size={17} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-page p-5 sm:p-6">
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
                      const acceptsApprovedNotes =
                        (canAdvanceCurrent &&
                          (nextStage === 'development' ||
                            nextStage === 'tests' ||
                            nextStage === 'review')) ||
                        canReturnFromReview;
                      const canStopCurrent =
                        isCurrentStage && flow.state === 'running' && Boolean(onCancelFlow);

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
                              canStopCurrent) && (
                              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
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
                                        () => onRerunFlowStage(flow.id, stage.id),
                                        'Não foi possível reexecutar a etapa.',
                                      );
                                    }}
                                    className="modal-button px-2.5 py-1 text-[11px] disabled:opacity-60"
                                  >
                                    {busyAction === 'rerun' ? (
                                      <Loader2 size={11} className="animate-spin" />
                                    ) : (
                                      <RotateCcw size={11} />
                                    )}
                                    Reexecutar
                                  </button>
                                )}

                                {acceptsApprovedNotes && (
                                  <label className="grid w-full gap-1 text-xs text-primary">
                                    Notas / Decisões Aprovadas (opcional)
                                    <textarea
                                      value={approvedNotes}
                                      rows={3}
                                      maxLength={FACTORY_APPROVED_NOTES_MAX_LENGTH}
                                      disabled={busyAction !== null}
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
                                      const shouldPassNotes =
                                        nextStage === 'development' ||
                                        nextStage === 'tests' ||
                                        nextStage === 'review';
                                      void runAction(
                                        'advance',
                                        () =>
                                          onAdvanceFlowStage(
                                            flow.id,
                                            shouldPassNotes
                                              ? approvedNotes.trim() || undefined
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
      </div>
    </dialog>
  );
}
