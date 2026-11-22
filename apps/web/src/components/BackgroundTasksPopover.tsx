import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  ChevronRight,
  Compass,
  FileText,
  GitPullRequest,
  Loader2,
  RotateCcw,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import {
  isFinalFactoryFlowState,
  type BackgroundSessionSummary,
  type FactoryFlow,
  type FactoryStageName,
} from '@development-factory/shared';
import {
  getFactoryFlowStatePresentation,
  getFactoryStageLabel,
  getFactoryStageStep,
  isFactoryFlowActivelyRunning,
} from '../utils/factory-flow-status';
import {
  getSessionStatusPresentation,
  isSessionActivelyRunning,
} from '../utils/session-status';

interface BackgroundTasksPopoverProps {
  id: string;
  sessions: BackgroundSessionSummary[];
  factoryFlows?: FactoryFlow[];
  activeSessionId?: string;
  loadingSessions?: boolean;
  sessionsError?: string | null;
  loadingFactoryFlows?: boolean;
  factoryFlowsError?: string | null;
  onOpenTerminal: (sessionId: string) => void;
  onOpenFlowRoadmap?: (flowId: string) => void;
  onViewReport: (reportPath: string) => void;
  onStopSession?: (sessionId: string) => Promise<BackgroundSessionSummary>;
  onCancelFlow?: (flowId: string) => Promise<FactoryFlow>;
  onRerunFlowStage?: (flowId: string, stage: FactoryStageName) => Promise<void>;
  onClose: () => void;
}

type BackgroundOperationItem =
  | {
      kind: 'flow';
      key: string;
      sortTime: number;
      flow: FactoryFlow;
      linkedSession?: BackgroundSessionSummary;
    }
  | {
      kind: 'session';
      key: string;
      sortTime: number;
      session: BackgroundSessionSummary;
    };

export function BackgroundTasksPopover({
  id,
  sessions,
  factoryFlows = [],
  activeSessionId,
  loadingSessions = false,
  sessionsError = null,
  loadingFactoryFlows = false,
  factoryFlowsError = null,
  onOpenTerminal,
  onOpenFlowRoadmap,
  onViewReport,
  onStopSession,
  onCancelFlow,
  onRerunFlowStage,
  onClose,
}: BackgroundTasksPopoverProps) {
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [resumingIds, setResumingIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const items = useMemo<BackgroundOperationItem[]>(() => {
    const sessionsById = new Map<string, BackgroundSessionSummary>();
    const latestSessionByFlowId = new Map<string, BackgroundSessionSummary>();
    const flowIds = new Set(factoryFlows.map(flow => flow.id));

    for (const session of sessions) {
      sessionsById.set(session.sessionId, session);
      if (session.flowId && !latestSessionByFlowId.has(session.flowId)) {
        latestSessionByFlowId.set(session.flowId, session);
      }
    }

    const result: BackgroundOperationItem[] = [];

    for (const flow of factoryFlows) {
      const linkedSession =
        (flow.currentSessionId ? sessionsById.get(flow.currentSessionId) : undefined) ??
        latestSessionByFlowId.get(flow.id);
      result.push({
        kind: 'flow',
        key: `flow:${flow.id}`,
        sortTime: Date.parse(flow.updatedAt),
        flow,
        linkedSession,
      });
    }

    for (const session of sessions) {
      if (session.flowId && flowIds.has(session.flowId)) {
        continue;
      }
      result.push({
        kind: 'session',
        key: `session:${session.sessionId}`,
        sortTime: Date.parse(session.startedAt),
        session,
      });
    }

    return result.sort((a, b) => b.sortTime - a.sortTime);
  }, [factoryFlows, sessions]);

  const runningCount = useMemo(() => {
    let count = 0;
    for (const item of items) {
      if (item.kind === 'flow') {
        if (
          !isFinalFactoryFlowState(item.flow.state) &&
          (isFactoryFlowActivelyRunning(item.flow) ||
            (item.linkedSession ? isSessionActivelyRunning(item.linkedSession) : false))
        ) {
          count += 1;
        }
      } else if (isSessionActivelyRunning(item.session)) {
        count += 1;
      }
    }
    return count;
  }, [items]);

  const isLoading = (loadingSessions || loadingFactoryFlows) && items.length === 0;
  const combinedError = actionError ?? sessionsError ?? factoryFlowsError;

  async function runItemOperation(
    targetId: string,
    busyIds: Set<string>,
    setBusyIds: Dispatch<SetStateAction<Set<string>>>,
    operation: () => Promise<void>,
    fallbackError: string,
  ): Promise<void> {
    if (busyIds.has(targetId)) {
      return;
    }

    setActionError(null);
    setBusyIds(current => {
      const next = new Set(current);
      next.add(targetId);
      return next;
    });

    try {
      await operation();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : fallbackError);
    } finally {
      setBusyIds(current => {
        const next = new Set(current);
        next.delete(targetId);
        return next;
      });
    }
  }

  return (
    <section
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby="background-tasks-title"
      className="pointer-events-auto absolute bottom-full left-1/2 mb-3 w-[min(calc(100vw-1.5rem),30rem)] -translate-x-1/2 overflow-hidden rounded-2xl border border-line-strong bg-surface/95 text-primary shadow-2xl shadow-black/40 backdrop-blur-md"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line bg-elevated/80 px-4 py-3">
        <div className="min-w-0">
          <h2 id="background-tasks-title" className="text-xs font-semibold text-primary">
            Operações em background
          </h2>
          <p className="mt-0.5 text-[11px] text-muted">
            {runningCount > 0
              ? `${runningCount} em execução`
              : `${items.length} ${items.length === 1 ? 'operação registrada' : 'operações registradas'}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar painel de operações"
          className="rounded-lg p-1.5 text-muted transition hover:bg-hover hover:text-primary"
        >
          <X size={14} />
        </button>
      </header>

      {combinedError && (
        <div
          role="alert"
          className="border-b border-danger/15 bg-danger/5 px-4 py-2.5 text-[11px] leading-5 text-danger"
        >
          {combinedError}
        </div>
      )}

      <div className="max-h-[52dvh] overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span>Carregando operações...</span>
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted">
            Nenhuma operação em execução ou recente nesta sessão.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {items.map(item => {
              if (item.kind === 'flow') {
                const { flow, linkedSession } = item;
                const stageStep = getFactoryStageStep(flow.currentStage);
                const stageLabel = getFactoryStageLabel(flow.currentStage);
                const meta =
                  !isFinalFactoryFlowState(flow.state) &&
                  linkedSession &&
                  linkedSession.status === 'running'
                    ? getSessionStatusPresentation(linkedSession)
                    : getFactoryFlowStatePresentation(flow.state);
                const isActive =
                  Boolean(activeSessionId) && linkedSession?.sessionId === activeSessionId;
                const reportPath = linkedSession?.reportPath ?? null;
                const canStop =
                  !isFinalFactoryFlowState(flow.state) &&
                  meta.label === 'Em execução' &&
                  (Boolean(onCancelFlow) ||
                    (linkedSession?.status === 'running' && Boolean(onStopSession)));
                const isPausedForResume =
                  flow.state === 'waiting_action' && Boolean(flow.loopPausedReason);
                const canResume = isPausedForResume && Boolean(onRerunFlowStage);
                const isStopping = stoppingIds.has(flow.id);
                const isResuming = resumingIds.has(flow.id);

                return (
                  <li
                    key={item.key}
                    className={`rounded-xl border p-3 transition ${
                      isActive
                        ? 'border-accent/40 bg-selected/40'
                        : 'border-line bg-page/70 hover:border-line-strong'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onOpenFlowRoadmap?.(flow.id);
                        onClose();
                      }}
                      aria-label={`Abrir roadmap do fluxo ${flow.title}`}
                      className="flex w-full items-start justify-between gap-2 rounded-lg text-left transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-selected px-1.5 py-0.5 text-[10px] font-medium text-accent">
                            <Compass size={10} />
                            Factory
                          </span>
                          <span className="inline-flex items-center rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-secondary">
                            {stageStep} · {stageLabel}
                          </span>
                          {flow.iteration > 0 && (
                            <span className="inline-flex items-center rounded-md border border-accent/25 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-accent">
                              Iteração {flow.iteration}/{flow.maxIterations}
                            </span>
                          )}
                          <span
                            className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${meta.textClass}`}
                          >
                            <span className={`size-1.5 rounded-full ${meta.dotClass}`} />
                            {meta.label}
                          </span>
                        </div>
                        <p
                          className="mt-1.5 truncate text-xs font-medium text-primary"
                          title={flow.title}
                        >
                          {flow.title}
                        </p>
                        <p
                          className="mt-0.5 truncate font-mono text-[10px] text-muted"
                          title={flow.target.repoPath}
                        >
                          {flow.target.repoPath}
                        </p>
                        {isPausedForResume && flow.loopPausedReason && (
                          <p className="mt-1.5 text-[11px] leading-4 text-warning">
                            {flow.loopPausedReason}
                          </p>
                        )}
                        {flow.planningApproval && (
                          <p className="mt-1 font-mono text-[10px] text-accent">
                            Planejamento aprovado: {flow.planningApproval.decisions.length}{' '}
                            {flow.planningApproval.decisions.length === 1 ? 'decisão' : 'decisões'} ·{' '}
                            {flow.planningApproval.acceptanceCriteria.filter(c => c.approved).length}{' '}
                            CAs
                          </p>
                        )}
                      </div>
                      <ChevronRight size={15} className="mt-1 shrink-0 text-muted" />
                    </button>

                    {(reportPath || canResume || canStop) && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                        {reportPath && (
                          <button
                            type="button"
                            className="modal-button border-accent/35 px-2.5 py-1.5 text-[11px] text-accent hover:bg-selected"
                            onClick={() => {
                              onViewReport(reportPath);
                              onClose();
                            }}
                          >
                            <FileText size={12} />
                            <span>{flow.currentStage === 'triage' ? 'Ver plano' : 'Ver artefato'}</span>
                          </button>
                        )}

                        {canResume && onRerunFlowStage && (
                          <button
                            type="button"
                            disabled={isResuming || isStopping}
                            aria-busy={isResuming}
                            aria-label={`Retomar etapa do fluxo ${flow.title}`}
                            className="modal-button border-accent/40 bg-selected/60 px-2.5 py-1.5 text-[11px] text-accent hover:bg-selected disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => {
                              void runItemOperation(
                                flow.id,
                                resumingIds,
                                setResumingIds,
                                () => onRerunFlowStage(flow.id, flow.currentStage),
                                'Não foi possível retomar a etapa do fluxo.',
                              );
                            }}
                          >
                            {isResuming ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <RotateCcw size={11} />
                            )}
                            <span>{isResuming ? 'Retomando...' : 'Retomar etapa'}</span>
                          </button>
                        )}

                        {canStop && (
                          <button
                            type="button"
                            disabled={isStopping || isResuming}
                            aria-busy={isStopping}
                            aria-label={`Parar fluxo ${flow.title}`}
                            className="modal-button ml-auto border-danger/30 px-2.5 py-1.5 text-[11px] text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => {
                              void runItemOperation(
                                flow.id,
                                stoppingIds,
                                setStoppingIds,
                                async () => {
                                  if (onCancelFlow) {
                                    await onCancelFlow(flow.id);
                                  } else if (linkedSession?.status === 'running' && onStopSession) {
                                    await onStopSession(linkedSession.sessionId);
                                  }
                                },
                                'Não foi possível parar o fluxo da Factory.',
                              );
                            }}
                          >
                            {isStopping ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <Square size={10} />
                            )}
                            <span>{isStopping ? 'Parando...' : 'Parar'}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              }

              const { session } = item;
              const meta = getSessionStatusPresentation(session);
              const isFactory = session.mode === 'factory';
              const isActive = activeSessionId === session.sessionId;
              const reportPath =
                session.mode === 'factory' || session.historyState === 'saved'
                  ? session.reportPath
                  : null;
              const canStop =
                session.status === 'running' &&
                meta.label === 'Em execução' &&
                Boolean(onStopSession);
              const isStopping = stoppingIds.has(session.sessionId);

              return (
                <li
                  key={item.key}
                  className={`rounded-xl border p-3 transition ${
                    isActive
                      ? 'border-accent/40 bg-selected/40'
                      : 'border-line bg-page/70 hover:border-line-strong'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                            isFactory
                              ? 'border-accent/30 bg-selected text-accent'
                              : 'border-line bg-surface text-secondary'
                          }`}
                        >
                          {isFactory ? <Compass size={10} /> : <GitPullRequest size={10} />}
                          {isFactory ? 'Factory' : 'Review'}
                        </span>
                        {isFactory && session.stage && (
                          <span className="inline-flex items-center rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-secondary">
                            {getFactoryStageStep(session.stage)} ·{' '}
                            {getFactoryStageLabel(session.stage)}
                          </span>
                        )}
                        <span
                          className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${meta.textClass}`}
                        >
                          <span className={`size-1.5 rounded-full ${meta.dotClass}`} />
                          {meta.label}
                        </span>
                      </div>
                      <p
                        className="mt-1.5 truncate text-xs font-medium text-primary"
                        title={session.title}
                      >
                        {session.title}
                      </p>
                      <p
                        className="mt-0.5 truncate font-mono text-[10px] text-muted"
                        title={session.repoPath}
                      >
                        {session.repoPath}
                      </p>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {!isFactory && (
                      <button
                        type="button"
                        className="modal-button px-2.5 py-1.5 text-[11px]"
                        onClick={() => {
                          onOpenTerminal(session.sessionId);
                          onClose();
                        }}
                      >
                        <Terminal size={12} />
                        <span>Abrir terminal</span>
                      </button>
                    )}

                    {reportPath && (
                      <button
                        type="button"
                        className="modal-button border-accent/35 px-2.5 py-1.5 text-[11px] text-accent hover:bg-selected"
                        onClick={() => {
                          onViewReport(reportPath);
                          onClose();
                        }}
                      >
                        <FileText size={12} />
                        <span>{isFactory ? 'Ver plano' : 'Ver parecer'}</span>
                      </button>
                    )}

                    {canStop && onStopSession && (
                      <button
                        type="button"
                        disabled={isStopping}
                        aria-busy={isStopping}
                        aria-label={`Parar execução de ${session.title}`}
                        className="modal-button ml-auto border-danger/30 px-2.5 py-1.5 text-[11px] text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => {
                          void runItemOperation(
                            session.sessionId,
                            stoppingIds,
                            setStoppingIds,
                            async () => {
                              await onStopSession(session.sessionId);
                            },
                            'Não foi possível parar a operação em background.',
                          );
                        }}
                      >
                        {isStopping ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Square size={10} />
                        )}
                        <span>{isStopping ? 'Parando...' : 'Parar'}</span>
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
