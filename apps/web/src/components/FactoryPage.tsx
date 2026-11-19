import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock,
  Code2,
  Compass,
  FileText,
  FlaskConical,
  FolderGit2,
  GitPullRequest,
  Layers,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Sparkles,
  Square,
  Terminal,
} from 'lucide-react';
import {
  FACTORY_STAGE_ORDER,
  getNextFactoryStage,
  isFinalFactoryFlowState,
  type BackgroundSessionSummary,
  type FactoryFlow,
  type FactoryFlowArtifact,
  type FactoryFlowDetails,
  type FactoryFlowStage,
  type FactoryStageName,
  type FactoryStageState,
} from '@development-factory/shared';
import { fetchFactoryFlowDetails } from '../api/factory-flows';
import {
  canOpenTerminalForFactoryStage,
  getFactoryArtifactKindLabel,
  getFactoryArtifactStatusPresentation,
  getFactoryFlowStatePresentation,
  getFactoryInputTypeLabel,
  getFactoryStageLabel,
  getFactoryStageStatePresentation,
  getFactoryStageStep,
  isFactoryFlowActivelyRunning,
} from '../utils/factory-flow-status';

type FlowFilter = 'all' | 'active' | 'finished';

interface FactoryPageProps {
  repoPath: string;
  flows: FactoryFlow[];
  sessions: BackgroundSessionSummary[];
  selectedFlowId: string | null;
  loadingFlows: boolean;
  flowsError: string | null;
  onSelectFlow: (flowId: string) => void;
  onPickDirectory: () => void;
  onOpenNewFlow: () => void;
  onOpenFlowTerminal: (flowId: string) => void;
  onAdvanceFlowStage: (flowId: string) => Promise<void>;
  onRerunFlowStage: (flowId: string, stage: FactoryStageName) => Promise<void>;
  onCancelFlow: (flowId: string) => Promise<void>;
  onRefreshFlows: () => Promise<void>;
  onViewMarkdown: (filePath: string) => void;
}

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
    return isCurrent
      ? 'border-accent/60 bg-selected/40'
      : 'border-accent/30 bg-surface';
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

export function FactoryPage({
  repoPath,
  flows,
  sessions,
  selectedFlowId,
  loadingFlows,
  flowsError,
  onSelectFlow,
  onPickDirectory,
  onOpenNewFlow,
  onOpenFlowTerminal,
  onAdvanceFlowStage,
  onRerunFlowStage,
  onCancelFlow,
  onRefreshFlows,
  onViewMarkdown,
}: FactoryPageProps) {
  const [filter, setFilter] = useState<FlowFilter>('all');
  const [busyFlowIds, setBusyFlowIds] = useState<ReadonlyMap<string, 'advance' | 'rerun' | 'cancel'>>(
    () => new Map(),
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [selectedDetails, setSelectedDetails] = useState<FactoryFlowDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsRefreshTick, setDetailsRefreshTick] = useState(0);

  const effectiveSelectedFlow = useMemo(() => {
    if (flows.length === 0) {
      return null;
    }
    if (selectedFlowId) {
      const found = flows.find(item => item.id === selectedFlowId);
      if (found) {
        return found;
      }
    }
    return flows[0] ?? null;
  }, [flows, selectedFlowId]);

  const effectiveSelectedFlowId = effectiveSelectedFlow?.id ?? null;
  const effectiveSelectedFlowUpdatedAt = effectiveSelectedFlow?.updatedAt ?? null;

  useEffect(() => {
    if (!effectiveSelectedFlowId) {
      setSelectedDetails(null);
      setLoadingDetails(false);
      setDetailsError(null);
      return;
    }

    const controller = new AbortController();
    setLoadingDetails(true);
    setDetailsError(null);

    fetchFactoryFlowDetails(effectiveSelectedFlowId, controller.signal)
      .then(details => {
        if (!controller.signal.aborted) {
          setSelectedDetails(details);
          setLoadingDetails(false);
        }
      })
      .catch(error => {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }
        setDetailsError(
          error instanceof Error
            ? error.message
            : 'Não foi possível carregar os detalhes do fluxo selecionado.',
        );
        setLoadingDetails(false);
      });

    return () => {
      controller.abort();
    };
  }, [effectiveSelectedFlowId, effectiveSelectedFlowUpdatedAt, detailsRefreshTick]);

  const sessionsById = useMemo(() => {
    const map = new Map<string, BackgroundSessionSummary>();
    for (const session of sessions) {
      map.set(session.sessionId, session);
    }
    return map;
  }, [sessions]);

  const latestSessionByFlowId = useMemo(() => {
    const map = new Map<string, BackgroundSessionSummary>();
    for (const session of sessions) {
      if (session.flowId && !map.has(session.flowId)) {
        map.set(session.flowId, session);
      }
    }
    return map;
  }, [sessions]);

  const counts = useMemo(() => {
    let active = 0;
    let running = 0;
    let finished = 0;

    for (const flow of flows) {
      if (isFinalFactoryFlowState(flow.state)) {
        finished += 1;
      } else {
        active += 1;
      }
      if (isFactoryFlowActivelyRunning(flow)) {
        running += 1;
      }
    }

    return {
      all: flows.length,
      active,
      running,
      finished,
    };
  }, [flows]);

  const filteredFlows = useMemo(() => {
    if (filter === 'active') {
      return flows.filter(flow => !isFinalFactoryFlowState(flow.state));
    }
    if (filter === 'finished') {
      return flows.filter(flow => isFinalFactoryFlowState(flow.state));
    }
    return flows;
  }, [filter, flows]);

  const runFlowAction = useCallback(
    async (
      flowId: string,
      action: 'advance' | 'rerun' | 'cancel',
      operation: () => Promise<void>,
      fallbackError: string,
    ) => {
      if (busyFlowIds.has(flowId)) {
        return;
      }

      setActionError(null);
      setBusyFlowIds(current => {
        const next = new Map(current);
        next.set(flowId, action);
        return next;
      });

      try {
        await operation();
        if (flowId === effectiveSelectedFlowId) {
          setDetailsRefreshTick(tick => tick + 1);
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : fallbackError);
      } finally {
        setBusyFlowIds(current => {
          const next = new Map(current);
          next.delete(flowId);
          return next;
        });
      }
    },
    [busyFlowIds, effectiveSelectedFlowId],
  );

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) {
      return;
    }
    setActionError(null);
    setIsRefreshing(true);
    try {
      await onRefreshFlows();
      setDetailsRefreshTick(tick => tick + 1);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Não foi possível atualizar a lista de fluxos.',
      );
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, onRefreshFlows]);

  const stagesByName = useMemo(() => {
    const map = new Map<FactoryStageName, FactoryFlowStage>();
    if (!selectedDetails || selectedDetails.flow.id !== effectiveSelectedFlowId) {
      return map;
    }
    for (const stage of selectedDetails.stages) {
      map.set(stage.name, stage);
    }
    return map;
  }, [effectiveSelectedFlowId, selectedDetails]);

  const artifactsForSelectedFlow = useMemo<FactoryFlowArtifact[]>(() => {
    if (!selectedDetails || selectedDetails.flow.id !== effectiveSelectedFlowId) {
      return [];
    }
    return selectedDetails.artifacts;
  }, [effectiveSelectedFlowId, selectedDetails]);

  const artifactsByStage = useMemo(() => {
    const map = new Map<FactoryStageName, FactoryFlowArtifact[]>();
    for (const artifact of artifactsForSelectedFlow) {
      const existing = map.get(artifact.stage);
      if (existing) {
        existing.push(artifact);
      } else {
        map.set(artifact.stage, [artifact]);
      }
    }
    return map;
  }, [artifactsForSelectedFlow]);

  const combinedFlowArtifacts = useMemo(() => {
    const seenPaths = new Set(artifactsForSelectedFlow.map(item => item.path));
    const stagePlanFallbacks: Array<{
      id: string;
      stage: FactoryStageName;
      kindLabel: string;
      path: string;
      status: FactoryFlowArtifact['status'];
      viewable: boolean;
    }> = [];

    for (const stage of stagesByName.values()) {
      if (stage.reportPath && !seenPaths.has(stage.reportPath)) {
        seenPaths.add(stage.reportPath);
        stagePlanFallbacks.push({
          id: `stage-report:${stage.id}`,
          stage: stage.name,
          kindLabel: 'Plano técnico',
          path: stage.reportPath,
          status: 'ready',
          viewable: true,
        });
      }
    }

    return [
      ...artifactsForSelectedFlow.map(artifact => ({
        id: artifact.id,
        stage: artifact.stage,
        kindLabel: getFactoryArtifactKindLabel(artifact.kind),
        path: artifact.path,
        status: artifact.status,
        viewable: artifact.format === 'markdown' && artifact.status !== 'failed',
      })),
      ...stagePlanFallbacks,
    ];
  }, [artifactsForSelectedFlow, stagesByName]);

  const selectedFlowPresentation = effectiveSelectedFlow
    ? getFactoryFlowStatePresentation(effectiveSelectedFlow.state)
    : null;

  return (
    <main className="mx-auto max-w-6xl px-6 pb-32 pt-12 sm:px-10 sm:pt-16">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
          <Sparkles size={14} /> Fábrica de software · Ciclo de desenvolvimento
        </div>
        {counts.running > 0 && (
          <span className="inline-flex items-center gap-2 rounded-full border border-accent/35 bg-selected px-3 py-1 font-mono text-[11px] text-accent">
            <span className="size-2 rounded-full bg-accent animate-pulse" />
            {counts.running === 1
              ? '1 fluxo em execução em segundo plano'
              : `${counts.running} fluxos em paralelo`}
          </span>
        )}
      </div>

      <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div>
          <h1 className="max-w-2xl text-3xl font-semibold leading-[1.14] tracking-[-0.04em] sm:text-[46px]">
            Do contexto à entrega, <span className="text-accent">nó por nó.</span>
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-muted">
            Inicie múltiplos fluxos de desenvolvimento em paralelo no segundo plano e acompanhe
            etapas, terminais e artefatos de cada demanda em tempo real.
          </p>
        </div>

        <div className="flex w-full max-w-md flex-col gap-3 sm:items-stretch">
          <div className="rounded-xl border border-line bg-surface p-3.5">
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
              Repositório ativo no WSL
            </span>
            <button
              type="button"
              onClick={onPickDirectory}
              className="flex w-full items-center gap-2.5 rounded-lg border border-line-subtle bg-page px-3 py-2 text-left font-mono text-xs transition hover:border-accent/40"
              aria-haspopup="dialog"
            >
              <FolderGit2 size={15} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">
                {repoPath || 'Selecionar pasta do repositório'}
              </span>
              <span className="shrink-0 text-accent">{repoPath ? 'Alterar' : 'Selecionar'}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenNewFlow}
            className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-accent px-5 py-3.5 text-sm font-semibold text-on-accent shadow-lg shadow-black/15 transition hover:bg-accent-hover active:scale-[0.99]"
          >
            <Plus size={17} />
            Iniciar fluxo
          </button>
        </div>
      </div>

      <section aria-labelledby="flows-heading" className="mt-12">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Layers size={16} className="text-accent" />
            <h2 id="flows-heading" className="text-sm font-medium text-secondary">
              Fluxos em andamento e concluídos
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Filtrar fluxos"
              className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs"
            >
              {(
                [
                  { id: 'all', label: `Todos (${counts.all})` },
                  { id: 'active', label: `Em andamento (${counts.active})` },
                  { id: 'finished', label: `Concluídos (${counts.finished})` },
                ] as const
              ).map(option => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  aria-pressed={filter === option.id}
                  className={`rounded-md px-2.5 py-1 transition ${
                    filter === option.id
                      ? 'bg-selected font-medium text-accent'
                      : 'text-muted hover:text-primary'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => {
                void handleRefresh();
              }}
              disabled={isRefreshing}
              aria-label="Atualizar fluxos"
              className="modal-button px-2.5 py-1.5 text-xs"
            >
              <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} />
              Atualizar
            </button>
          </div>
        </div>

        {(flowsError || actionError) && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-xs text-danger"
          >
            <span className="flex items-center gap-2">
              <AlertCircle size={15} className="shrink-0" />
              {actionError ?? flowsError}
            </span>
            <div className="flex items-center gap-2">
              {flowsError && (
                <button
                  type="button"
                  onClick={() => {
                    void handleRefresh();
                  }}
                  className="rounded-md border border-danger/40 px-2.5 py-1 text-[11px] font-medium hover:bg-danger/15"
                >
                  Tentar novamente
                </button>
              )}
              {actionError && (
                <button
                  type="button"
                  onClick={() => setActionError(null)}
                  className="rounded-md border border-danger/40 px-2.5 py-1 text-[11px] font-medium hover:bg-danger/15"
                >
                  Dispensar
                </button>
              )}
            </div>
          </div>
        )}

        {loadingFlows && flows.length === 0 ? (
          <div className="flex items-center justify-center gap-3 rounded-2xl border border-line bg-surface px-6 py-12 text-xs text-muted">
            <Loader2 size={16} className="animate-spin text-accent" />
            Carregando fluxos da Factory...
          </div>
        ) : flows.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-12 text-center">
            <span className="grid size-11 place-items-center rounded-xl border border-line bg-page text-accent">
              <Sparkles size={20} />
            </span>
            <h3 className="mt-4 text-sm font-semibold text-primary">Nenhum fluxo iniciado ainda</h3>
            <p className="mt-1.5 max-w-md text-xs leading-5 text-muted">
              Inicie um ou mais fluxos a partir de uma tarefa do JIRA ou título. Cada fluxo executa
              em segundo plano de forma independente.
            </p>
            <button
              type="button"
              onClick={onOpenNewFlow}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-xs font-semibold text-on-accent transition hover:bg-accent-hover"
            >
              <Play size={14} />
              Iniciar primeiro fluxo
            </button>
          </div>
        ) : filteredFlows.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-line bg-surface/60 px-6 py-10 text-center">
            <p className="text-xs text-muted">Nenhum fluxo encontrado neste filtro.</p>
            <button
              type="button"
              onClick={() => setFilter('all')}
              className="mt-3 text-xs font-medium text-accent hover:underline"
            >
              Mostrar todos os fluxos
            </button>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {filteredFlows.map(flow => {
              const isSelected = flow.id === effectiveSelectedFlowId;
              const presentation = getFactoryFlowStatePresentation(flow.state);
              const linkedSession =
                (flow.currentSessionId ? sessionsById.get(flow.currentSessionId) : undefined) ??
                latestSessionByFlowId.get(flow.id);
              const hasTerminal =
                canOpenTerminalForFactoryStage(flow.currentStage) &&
                (flow.currentSessionId !== null || linkedSession !== undefined);
              const reportPath =
                linkedSession?.reportPath ??
                (isSelected
                  ? combinedFlowArtifacts.find(item => item.viewable)?.path ?? null
                  : null);
              const canAdvance =
                flow.state === 'waiting_action' && getNextFactoryStage(flow.currentStage) !== null;
              const canCancel = !isFinalFactoryFlowState(flow.state);
              const busyAction = busyFlowIds.get(flow.id);

              return (
                <li
                  key={flow.id}
                  className={`flex flex-col justify-between gap-4 rounded-2xl border p-4 transition ${
                    isSelected
                      ? 'border-accent bg-selected/50 shadow-lg shadow-black/10'
                      : 'border-line bg-surface hover:border-line-strong'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectFlow(flow.id)}
                    aria-current={isSelected ? 'true' : undefined}
                    className="w-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-md border border-line bg-page px-2 py-0.5 font-mono text-[10px] text-muted">
                            {getFactoryInputTypeLabel(flow.target.inputType)}
                          </span>
                          <span className="font-mono text-[11px] text-accent">
                            {getFactoryStageStep(flow.currentStage)} ·{' '}
                            {getFactoryStageLabel(flow.currentStage)}
                          </span>
                        </div>
                        <h3 className="mt-2 truncate text-sm font-semibold text-primary">
                          {flow.title}
                        </h3>
                      </div>

                      <span
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-page px-2.5 py-0.5 font-mono text-[10px] font-medium ${presentation.textClass}`}
                      >
                        <span className={`size-1.5 rounded-full ${presentation.dotClass}`} />
                        {presentation.label}
                      </span>
                    </div>

                    <p
                      className="mt-2 truncate font-mono text-[11px] text-muted"
                      title={flow.target.repoPath}
                    >
                      {flow.target.repoPath}
                    </p>
                  </button>

                  <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
                    {hasTerminal && (
                      <button
                        type="button"
                        onClick={() => onOpenFlowTerminal(flow.id)}
                        className="modal-button px-2.5 py-1.5 text-[11px]"
                      >
                        <Terminal size={12} />
                        Abrir terminal
                      </button>
                    )}

                    {reportPath && (
                      <button
                        type="button"
                        onClick={() => onViewMarkdown(reportPath)}
                        className="modal-button border-accent/35 px-2.5 py-1.5 text-[11px] text-accent hover:bg-selected"
                      >
                        <FileText size={12} />
                        Ver plano
                      </button>
                    )}

                    {canAdvance && (
                      <button
                        type="button"
                        disabled={busyAction !== undefined}
                        aria-busy={busyAction === 'advance'}
                        onClick={() => {
                          void runFlowAction(
                            flow.id,
                            'advance',
                            () => onAdvanceFlowStage(flow.id),
                            'Não foi possível avançar a etapa do fluxo.',
                          );
                        }}
                        className="modal-button border-accent/40 bg-selected/60 px-2.5 py-1.5 text-[11px] text-accent hover:bg-selected disabled:opacity-60"
                      >
                        {busyAction === 'advance' ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <ArrowRight size={12} />
                        )}
                        Avançar etapa
                      </button>
                    )}

                    {canCancel && (
                      <button
                        type="button"
                        disabled={busyAction !== undefined}
                        aria-busy={busyAction === 'cancel'}
                        onClick={() => {
                          void runFlowAction(
                            flow.id,
                            'cancel',
                            () => onCancelFlow(flow.id),
                            'Não foi possível parar o fluxo.',
                          );
                        }}
                        className="modal-button ml-auto border-danger/30 px-2.5 py-1.5 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-60"
                      >
                        {busyAction === 'cancel' ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Square size={11} />
                        )}
                        Parar
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="roadmap-heading" className="mt-12">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="roadmap-heading" className="text-sm font-medium text-secondary">
              {effectiveSelectedFlow
                ? `Roadmap do fluxo: ${effectiveSelectedFlow.title}`
                : 'Roadmap do ciclo de desenvolvimento'}
            </h2>
            {effectiveSelectedFlow && (
              <p className="mt-1 font-mono text-[11px] text-muted">
                {effectiveSelectedFlow.target.value} · {effectiveSelectedFlow.target.repoPath}
              </p>
            )}
          </div>

          {effectiveSelectedFlow && selectedFlowPresentation ? (
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span className="text-muted">
                Etapa atual:{' '}
                <strong className="font-medium text-accent">
                  {getFactoryStageStep(effectiveSelectedFlow.currentStage)} ·{' '}
                  {getFactoryStageLabel(effectiveSelectedFlow.currentStage)}
                </strong>
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[10px] font-medium ${selectedFlowPresentation.textClass}`}
              >
                <span className={`size-1.5 rounded-full ${selectedFlowPresentation.dotClass}`} />
                {selectedFlowPresentation.label}
              </span>
            </div>
          ) : (
            <span className="font-mono text-[11px] text-muted">
              Selecione ou inicie um fluxo para acompanhar as etapas
            </span>
          )}
        </div>

        {effectiveSelectedFlow?.error && (
          <div
            role="alert"
            className="mb-5 flex items-center gap-2 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-xs text-danger"
          >
            <AlertCircle size={15} className="shrink-0" />
            <span>{effectiveSelectedFlow.error.message}</span>
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
                    const stageState: FactoryStageState = effectiveSelectedFlow
                      ? (stageRecord?.state ?? inferStageState(effectiveSelectedFlow, stage.id))
                      : 'pending';
                    const isCurrentStage = effectiveSelectedFlow?.currentStage === stage.id;
                    const stagePresentation = getFactoryStageStatePresentation(stageState);
                    const stageArtifacts = artifactsByStage.get(stage.id) ?? [];
                    const stageMarkdownPath =
                      stageRecord?.reportPath ??
                      stageArtifacts.find(
                        item => item.format === 'markdown' && item.status !== 'failed',
                      )?.path ??
                      null;
                    const stageHasTerminal =
                      canOpenTerminalForFactoryStage(stage.id) &&
                      Boolean(
                        stageRecord?.sessionId ||
                          (isCurrentStage && effectiveSelectedFlow?.currentSessionId),
                      );
                    const busyAction = effectiveSelectedFlow
                      ? busyFlowIds.get(effectiveSelectedFlow.id)
                      : undefined;
                    const canRerunCurrent =
                      effectiveSelectedFlow !== null &&
                      isCurrentStage &&
                      effectiveSelectedFlow.state === 'waiting_action';
                    const nextStage = getNextFactoryStage(stage.id);
                    const canAdvanceCurrent = canRerunCurrent && nextStage !== null;

                    return (
                      <Fragment key={stage.id}>
                        <div
                          className={`flex h-full flex-col justify-between rounded-2xl border p-5 transition ${
                            effectiveSelectedFlow
                              ? getStageCardClasses(stageState, isCurrentStage)
                              : 'border-line bg-surface/70 opacity-85'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              {effectiveSelectedFlow ? (
                                renderStageIconBadge(stageState, Icon, isCurrentStage)
                              ) : (
                                <span className="grid size-9 place-items-center rounded-xl border border-line bg-page text-muted">
                                  <Icon size={17} />
                                </span>
                              )}
                              <span
                                className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-page px-2.5 py-0.5 font-mono text-[10px] ${
                                  effectiveSelectedFlow ? stagePresentation.textClass : 'text-muted'
                                }`}
                              >
                                {effectiveSelectedFlow && (
                                  <span
                                    className={`size-1.5 rounded-full ${stagePresentation.dotClass}`}
                                  />
                                )}
                                {effectiveSelectedFlow ? stagePresentation.label : 'Aguardando fluxo'}
                              </span>
                            </div>

                            <p className="mt-4 font-mono text-[10px] uppercase tracking-wider text-accent">
                              Etapa {stage.step}
                              {isCurrentStage ? ' · Atual' : ''}
                            </p>
                            <h3 className="mt-1 text-sm font-semibold text-primary">{stage.title}</h3>
                            <p className="mt-2 text-xs leading-5 text-muted">{stage.description}</p>

                            {stageRecord?.error && (
                              <p className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
                                {stageRecord.error.message}
                              </p>
                            )}
                          </div>

                          {effectiveSelectedFlow &&
                            (stageHasTerminal ||
                              stageMarkdownPath ||
                              canRerunCurrent ||
                              canAdvanceCurrent) && (
                              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
                                {stageHasTerminal && isCurrentStage && (
                                  <button
                                    type="button"
                                    onClick={() => onOpenFlowTerminal(effectiveSelectedFlow.id)}
                                    className="modal-button px-2.5 py-1 text-[11px]"
                                  >
                                    <Terminal size={11} />
                                    Terminal
                                  </button>
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

                                {canRerunCurrent && (
                                  <button
                                    type="button"
                                    disabled={busyAction !== undefined}
                                    aria-busy={busyAction === 'rerun'}
                                    onClick={() => {
                                      void runFlowAction(
                                        effectiveSelectedFlow.id,
                                        'rerun',
                                        () => onRerunFlowStage(effectiveSelectedFlow.id, stage.id),
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

                                {canAdvanceCurrent && nextStage && (
                                  <button
                                    type="button"
                                    disabled={busyAction !== undefined}
                                    aria-busy={busyAction === 'advance'}
                                    onClick={() => {
                                      void runFlowAction(
                                        effectiveSelectedFlow.id,
                                        'advance',
                                        () => onAdvanceFlowStage(effectiveSelectedFlow.id),
                                        'Não foi possível avançar a etapa.',
                                      );
                                    }}
                                    className="modal-button border-accent/40 bg-selected/60 px-2.5 py-1 text-[11px] text-accent hover:bg-selected disabled:opacity-60"
                                  >
                                    {busyAction === 'advance' ? (
                                      <Loader2 size={11} className="animate-spin" />
                                    ) : (
                                      <ArrowRight size={11} />
                                    )}
                                    Avançar para {getFactoryStageLabel(nextStage)}
                                  </button>
                                )}
                              </div>
                            )}
                        </div>

                        {!isLastInRow && (
                          <div aria-hidden="true" className="flex items-center justify-center text-muted">
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
                <li aria-hidden="true" className="flex items-center justify-center gap-3 py-1 text-muted">
                  <span className="h-px flex-1 bg-line-subtle" />
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 font-mono text-[10px] text-muted">
                    <ArrowDown size={12} className="text-accent" />
                    Próxima fase (03 → 04)
                  </span>
                  <span className="h-px flex-1 bg-line-subtle" />
                </li>
              )}
            </Fragment>
          ))}
        </ol>
      </section>

      {effectiveSelectedFlow && (
        <section
          aria-labelledby="artifacts-heading"
          className="mt-8 rounded-2xl border border-line bg-surface p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="artifacts-heading" className="text-xs font-semibold text-primary">
                Artefatos do fluxo selecionado
              </h2>
              <p className="mt-0.5 text-[11px] text-muted">
                Planos, relatórios e saídas geradas nas etapas de {effectiveSelectedFlow.title}.
              </p>
            </div>
            {loadingDetails && (
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
                <Loader2 size={13} className="animate-spin text-accent" />
                Atualizando detalhes...
              </span>
            )}
          </div>

          {detailsError ? (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-xs text-danger"
            >
              <span>{detailsError}</span>
              <button
                type="button"
                onClick={() => setDetailsRefreshTick(tick => tick + 1)}
                className="rounded-md border border-danger/40 px-2.5 py-1 text-[11px] font-medium hover:bg-danger/15"
              >
                Tentar novamente
              </button>
            </div>
          ) : combinedFlowArtifacts.length === 0 ? (
            <p className="mt-4 rounded-xl border border-line-subtle bg-page px-4 py-4 text-xs text-muted">
              {loadingDetails
                ? 'Carregando artefatos do fluxo...'
                : 'Nenhum artefato gerado para este fluxo ainda.'}
            </p>
          ) : (
            <ul className="mt-4 space-y-2.5">
              {combinedFlowArtifacts.map(artifact => {
                const statusInfo = getFactoryArtifactStatusPresentation(artifact.status);
                return (
                  <li
                    key={artifact.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-subtle bg-page px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-primary">{artifact.kindLabel}</span>
                        <span className="font-mono text-[10px] text-muted">
                          {getFactoryStageStep(artifact.stage)} · {getFactoryStageLabel(artifact.stage)}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 font-mono text-[10px] ${statusInfo.textClass}`}
                        >
                          <span className={`size-1.5 rounded-full ${statusInfo.dotClass}`} />
                          {statusInfo.label}
                        </span>
                      </div>
                      <p
                        className="mt-1 truncate font-mono text-[11px] text-muted"
                        title={artifact.path}
                      >
                        {artifact.path}
                      </p>
                    </div>

                    {artifact.viewable && (
                      <button
                        type="button"
                        onClick={() => onViewMarkdown(artifact.path)}
                        className="modal-button border-accent/40 text-accent hover:bg-selected"
                      >
                        <FileText size={13} />
                        Visualizar em Markdown
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
